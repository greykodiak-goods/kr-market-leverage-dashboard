// Google News RSS aggregation for the Hynix-impact feed.
// Requests go through public CORS proxies (Google blocks browser CORS). Enabled
// keywords are batched into a few OR-queries to keep request count low.
//
// De-duplication is event-based: near-duplicate headlines (same story from many
// outlets, or the same article surfaced by multiple keywords) are merged into a
// SINGLE cluster card that lists how many outlets covered it.

import type { Keyword } from './keywords'
import { HAS_CUSTOM_PROXY, customProxyWrap } from './proxyConfig'

export interface NewsSource {
  source: string
  link: string
}

export interface NewsItem {
  id: string // cluster key (normalized representative title)
  title: string // representative (most recent) headline
  link: string
  source: string
  published: number // epoch ms (most recent in cluster)
  matchedKeywordIds: string[] // union across the cluster
  clusterSize: number // number of distinct outlets covering the story
  sources: NewsSource[] // distinct outlets + links (for expand)
  hot: boolean
  score: number // cross-coverage + relevance + recency
}

export interface NewsResult {
  items: NewsItem[]
  fetchedAt: number
  stale: boolean
  proxyUsed: string
  partial: boolean
}

const PROXIES: { name: string; wrap: (url: string) => string; headers?: Record<string, string> }[] = [
  ...(HAS_CUSTOM_PROXY ? [{ name: 'custom-worker', wrap: customProxyWrap }] : []),
  { name: 'cors.sh', wrap: (u) => `https://proxy.cors.sh/${u}`, headers: { 'x-requested-with': 'XMLHttpRequest' } },
  { name: 'allorigins', wrap: (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}` },
  { name: 'codetabs', wrap: (u) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(u)}` },
]

const CACHE_KEY = 'news-cache-v3' // default (Hynix feed); other feeds pass their own
const REQ_TIMEOUT_MS = 8000
const SIM_THRESHOLD = 0.55 // token-Jaccard threshold to merge near-duplicates

function rssUrl(query: string): string {
  return `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=ko&gl=KR&ceid=KR:ko`
}

async function fetchWithTimeout(url: string, headers: Record<string, string>): Promise<Response> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), REQ_TIMEOUT_MS)
  try {
    return await fetch(url, { headers, signal: ctrl.signal })
  } finally {
    clearTimeout(timer)
  }
}

async function tryProxy(p: (typeof PROXIES)[number], target: string): Promise<{ text: string; proxy: string }> {
  const res = await fetchWithTimeout(p.wrap(target), p.headers ?? {})
  if (!res.ok) throw new Error(`${p.name} HTTP ${res.status}`)
  const text = await res.text()
  if (!text.includes('<item>')) throw new Error(`${p.name} no items (rate-limited?)`)
  return { text, proxy: p.name }
}

async function fetchText(target: string): Promise<{ text: string; proxy: string }> {
  return Promise.any(PROXIES.map((p) => tryProxy(p, target)))
}

// Common Korean particles/stopwords + generic filler weakened during tokenizing.
const STOPWORDS = new Set([
  '속보', '단독', '종합', '기자', '뉴스', '오늘', '어제', '관련', '이날', '지난', '대한', '위해', '통해',
  '있다', '했다', '한다', '된다', '이다', '에서', '으로', '까지', '보다', '그리고', '하지만',
  'the', 'and', 'for', 'with', 'inc', 'co', 'ltd',
])

function normalizeTitle(t: string): string {
  return t
    .toLowerCase()
    .replace(/\s*[-–—|]\s*[^-–—|]+$/, '') // drop trailing " - 매체명"
    .replace(/^\s*\[[^\]]*\]\s*/g, '') // drop leading [속보][단독] tags
    .replace(/株/g, '주') // unify 반도체株 / 반도체주
    .replace(/[\[\](){}<>“”"'‘’.,!?·…:;~]/g, ' ') // punctuation/symbols
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// Trailing Korean particles (josa) stripped so "호조에"/"호조로" → "호조" etc.
const JOSA = ['으로', '에서', '에게', '까지', '부터', '은', '는', '이', '가', '을', '를', '에', '로', '의', '와', '과', '도', '만']

function stem(w: string): string {
  for (const j of JOSA) {
    if (w.length > j.length + 1 && w.endsWith(j)) return w.slice(0, -j.length)
  }
  return w
}

function tokens(norm: string): Set<string> {
  const out = new Set<string>()
  for (const raw of norm.split(' ')) {
    const w = stem(raw)
    if (w.length >= 2 && !STOPWORDS.has(w)) out.add(w)
  }
  return out
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0
  let inter = 0
  for (const x of a) if (b.has(x)) inter++
  return inter / (a.size + b.size - inter)
}

function parseRss(xml: string): { title: string; link: string; source: string; published: number }[] {
  const doc = new DOMParser().parseFromString(xml, 'text/xml')
  return Array.from(doc.querySelectorAll('item')).map((it) => {
    const rawTitle = it.querySelector('title')?.textContent ?? ''
    const link = it.querySelector('link')?.textContent ?? ''
    const pub = it.querySelector('pubDate')?.textContent ?? ''
    const source =
      it.querySelector('source')?.textContent ??
      (rawTitle.includes(' - ') ? rawTitle.split(' - ').pop()!.trim() : '')
    const title = rawTitle.replace(/\s*[-–—]\s*[^-–—]+$/, '').trim() || rawTitle
    const published = pub ? new Date(pub).getTime() : Date.now()
    return { title, link, source, published }
  })
}

function batch<T>(arr: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

function readCache(cacheKey: string): NewsResult | null {
  try {
    const raw = localStorage.getItem(cacheKey)
    return raw ? (JSON.parse(raw) as NewsResult) : null
  } catch {
    return null
  }
}
function writeCache(r: NewsResult, cacheKey: string) {
  try {
    localStorage.setItem(cacheKey, JSON.stringify(r))
  } catch {
    /* ignore */
  }
}

interface Tagged {
  title: string
  link: string
  source: string
  published: number
  norm: string
  matched: string[]
  tokenSet: Set<string>
}

interface Cluster {
  items: Tagged[]
  tokenSet: Set<string> // representative token set
}

// Exported for unit testing the clustering without network.
export function clusterItems(raw: { title: string; link: string; source: string; published: number }[], enabled: Keyword[]): NewsItem[] {
  // 1) Exact de-dup by normalized title (keeps distinct outlets/links per title).
  const byNorm = new Map<string, Tagged>()
  for (const r of raw) {
    const norm = normalizeTitle(r.title)
    if (!norm) continue
    const lc = r.title.toLowerCase()
    const matched = enabled.filter((k) => k.matchTerms.some((t) => lc.includes(t))).map((k) => k.id)
    const existing = byNorm.get(norm)
    if (existing) {
      // same normalized headline from another source → fold in
      existing.matched = [...new Set([...existing.matched, ...matched])]
      existing.published = Math.max(existing.published, r.published)
      // remember additional source via a side channel on the object
      ;(existing as any)._extraSources = (existing as any)._extraSources ?? []
      ;(existing as any)._extraSources.push({ source: r.source, link: r.link })
      continue
    }
    byNorm.set(norm, { ...r, norm, matched, tokenSet: tokens(norm) })
  }
  const uniq = Array.from(byNorm.values())

  // 2) Greedy near-duplicate clustering by token Jaccard.
  const clusters: Cluster[] = []
  for (const it of uniq) {
    let best: Cluster | null = null
    let bestSim = 0
    for (const c of clusters) {
      const sim = jaccard(it.tokenSet, c.tokenSet)
      if (sim > bestSim) {
        bestSim = sim
        best = c
      }
    }
    if (best && bestSim >= SIM_THRESHOLD) best.items.push(it)
    else clusters.push({ items: [it], tokenSet: it.tokenSet })
  }

  // 3) One NewsItem per cluster.
  const now = Date.now()
  const items: NewsItem[] = clusters.map((c) => {
    const sorted = [...c.items].sort((a, b) => b.published - a.published)
    const rep = sorted[0]
    // distinct sources across all items (+ folded exact-dup sources)
    const srcMap = new Map<string, string>()
    for (const it of c.items) {
      if (it.source && !srcMap.has(it.source)) srcMap.set(it.source, it.link)
      for (const es of ((it as any)._extraSources ?? []) as NewsSource[]) {
        if (es.source && !srcMap.has(es.source)) srcMap.set(es.source, es.link)
      }
    }
    const sources: NewsSource[] = Array.from(srcMap, ([source, link]) => ({ source, link }))
    const matched = [...new Set(c.items.flatMap((it) => it.matched))]
    const clusterSize = Math.max(1, sources.length)
    const hoursAgo = Math.max(0, (now - rep.published) / 3_600_000)
    const recency = Math.max(0, 48 - hoursAgo) / 48
    const score = clusterSize * 3 + matched.length * 2 + recency * 4
    return {
      id: rep.norm,
      title: rep.title,
      link: rep.link,
      source: rep.source,
      published: rep.published,
      matchedKeywordIds: matched,
      clusterSize,
      sources,
      hot: clusterSize >= 3,
      score,
    }
  })

  return items
}

// cacheKey separates the last-good localStorage fallback per feed (Hynix vs
// mega-investors) so a total fetch failure never shows another feed's items.
// querySuffix (optional) is a Google News operator appended to each batch query
// (e.g. 'when:30d') — used by low-volume catalogs where relevance-ordered RSS
// otherwise returns mostly old articles.
export async function fetchNews(
  enabled: Keyword[],
  cacheKey: string = CACHE_KEY,
  querySuffix?: string,
): Promise<NewsResult> {
  if (!enabled.length) return { items: [], fetchedAt: Date.now(), stale: false, proxyUsed: '', partial: false }

  const groups = batch(enabled, 6)
  const raw: { title: string; link: string; source: string; published: number }[] = []
  let proxyUsed = ''
  let failed = 0

  const settled = await Promise.allSettled(
    groups.map((g) =>
      fetchText(rssUrl(g.map((k) => k.queryTerm ?? k.label).join(' OR ') + (querySuffix ? ` ${querySuffix}` : ''))),
    ),
  )
  for (const s of settled) {
    if (s.status === 'fulfilled') {
      proxyUsed = s.value.proxy
      raw.push(...parseRss(s.value.text))
    } else {
      failed++
    }
  }

  if (raw.length === 0) {
    const cached = readCache(cacheKey)
    if (cached) return { ...cached, stale: true }
    throw new Error('no news fetched (all batches failed)')
  }

  const items = clusterItems(raw, enabled)
  const result: NewsResult = { items, fetchedAt: Date.now(), stale: false, proxyUsed, partial: failed > 0 }
  writeCache(result, cacheKey)
  return result
}
