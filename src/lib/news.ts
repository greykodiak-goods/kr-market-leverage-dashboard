// Google News RSS aggregation for the Hynix-impact feed.
// Requests go through public CORS proxies (Google blocks browser CORS). To keep
// request count low (and dodge rate limits), enabled keywords are batched into a
// few OR-queries rather than one request per keyword.

import type { Keyword } from './keywords'

export interface NewsItem {
  id: string // dedupe key (normalized title)
  title: string
  link: string
  source: string
  published: number // epoch ms
  matchedKeywordIds: string[]
  clusterSize: number // number of distinct outlets covering a similar headline
  hot: boolean
  score: number // engagement proxy (cross-coverage + relevance + recency)
}

export interface NewsResult {
  items: NewsItem[]
  fetchedAt: number
  stale: boolean
  proxyUsed: string
  partial: boolean // some batches failed
}

const PROXIES: { name: string; wrap: (url: string) => string; headers?: Record<string, string> }[] = [
  { name: 'cors.sh', wrap: (u) => `https://proxy.cors.sh/${u}`, headers: { 'x-requested-with': 'XMLHttpRequest' } },
  { name: 'allorigins', wrap: (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}` },
  { name: 'codetabs', wrap: (u) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(u)}` },
]

const CACHE_KEY = 'news-cache-v2'

function rssUrl(query: string): string {
  return `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=ko&gl=KR&ceid=KR:ko`
}

const REQ_TIMEOUT_MS = 8000

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
  // Google rate-limit / "Sorry" pages are short and lack <item>.
  if (!text.includes('<item>')) throw new Error(`${p.name} no items (rate-limited?)`)
  return { text, proxy: p.name }
}

// Race all proxies; first valid feed wins. Fails (~timeout) only if all reject.
async function fetchText(target: string): Promise<{ text: string; proxy: string }> {
  return Promise.any(PROXIES.map((p) => tryProxy(p, target)))
}

function normalizeTitle(t: string): string {
  return t
    .toLowerCase()
    .replace(/\s*-\s*[^-]+$/, '') // drop trailing " - 매체명"
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function parseRss(xml: string): { title: string; link: string; source: string; published: number }[] {
  const doc = new DOMParser().parseFromString(xml, 'text/xml')
  const items = Array.from(doc.querySelectorAll('item'))
  return items.map((it) => {
    const rawTitle = it.querySelector('title')?.textContent ?? ''
    const link = it.querySelector('link')?.textContent ?? ''
    const pub = it.querySelector('pubDate')?.textContent ?? ''
    // Google appends " - Source" to the title; <source> may also exist.
    const source =
      it.querySelector('source')?.textContent ?? (rawTitle.includes(' - ') ? rawTitle.split(' - ').pop()!.trim() : '')
    const title = rawTitle.replace(/\s*-\s*[^-]+$/, '').trim() || rawTitle
    const published = pub ? new Date(pub).getTime() : Date.now()
    return { title, link, source, published }
  })
}

function tokens(s: string): Set<string> {
  return new Set(s.split(' ').filter((w) => w.length >= 2))
}
function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0
  let inter = 0
  for (const x of a) if (b.has(x)) inter++
  return inter / (a.size + b.size - inter)
}

function batch<T>(arr: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

function readCache(): NewsResult | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    return raw ? (JSON.parse(raw) as NewsResult) : null
  } catch {
    return null
  }
}
function writeCache(r: NewsResult) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(r))
  } catch {
    /* ignore */
  }
}

export async function fetchNews(enabled: Keyword[]): Promise<NewsResult> {
  if (!enabled.length) return { items: [], fetchedAt: Date.now(), stale: false, proxyUsed: '', partial: false }

  const groups = batch(enabled, 6) // ~6 keywords per OR-query
  const raw: { title: string; link: string; source: string; published: number }[] = []
  let proxyUsed = ''
  let failed = 0

  // Fetch batches in parallel so total latency ~= one request, not the sum.
  const settled = await Promise.allSettled(
    groups.map((g) => fetchText(rssUrl(g.map((k) => k.label).join(' OR ')))),
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
    const cached = readCache()
    if (cached) return { ...cached, stale: true }
    throw new Error('no news fetched (all batches failed)')
  }

  // Dedupe by normalized title (keep earliest link/source).
  const byKey = new Map<string, { title: string; link: string; source: string; published: number; norm: string }>()
  for (const r of raw) {
    const norm = normalizeTitle(r.title)
    if (!norm) continue
    if (!byKey.has(norm)) byKey.set(norm, { ...r, norm })
  }
  const uniq = Array.from(byKey.values())

  // Tag matched keywords by scanning title.
  const withTags = uniq.map((u) => {
    const lc = u.title.toLowerCase()
    const matched = enabled.filter((k) => k.matchTerms.some((t) => lc.includes(t))).map((k) => k.id)
    return { ...u, matched, tokenSet: tokens(u.norm) }
  })

  // Cluster similar headlines (across outlets) via token Jaccard.
  const clusterId = new Array(withTags.length).fill(-1)
  let nextCluster = 0
  const outletsPerCluster: Map<number, Set<string>> = new Map()
  for (let i = 0; i < withTags.length; i++) {
    if (clusterId[i] === -1) {
      clusterId[i] = nextCluster++
      outletsPerCluster.set(clusterId[i], new Set([withTags[i].source]))
    }
    for (let j = i + 1; j < withTags.length; j++) {
      if (clusterId[j] === -1 && jaccard(withTags[i].tokenSet, withTags[j].tokenSet) >= 0.5) {
        clusterId[j] = clusterId[i]
        outletsPerCluster.get(clusterId[i])!.add(withTags[j].source)
      }
    }
  }

  const now = Date.now()
  const items: NewsItem[] = withTags.map((u, i) => {
    const clusterSize = outletsPerCluster.get(clusterId[i])!.size
    const hoursAgo = Math.max(0, (now - u.published) / 3_600_000)
    const recency = Math.max(0, 48 - hoursAgo) / 48 // 0..1 over last 48h
    const score = clusterSize * 3 + u.matched.length * 2 + recency * 4
    return {
      id: u.norm,
      title: u.title,
      link: u.link,
      source: u.source,
      published: u.published,
      matchedKeywordIds: u.matched,
      clusterSize,
      hot: clusterSize >= 3,
      score,
    }
  })

  const result: NewsResult = {
    items,
    fetchedAt: now,
    stale: false,
    proxyUsed,
    partial: failed > 0,
  }
  writeCache(result)
  return result
}
