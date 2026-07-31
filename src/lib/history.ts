// Daily OHLCV history layer for the backtest simulator.
//
// Source: Yahoo Finance chart API v8 (no key, unofficial), interval=1d, fetched
// through the same prioritized CORS proxy chain as quotes.ts. Last good response
// per (symbol, range) is cached in localStorage with a TTL.
//
// ADJUSTMENT (검증 2026-07-26): Yahoo's `indicators.quote` OHLC is SPLIT-adjusted
// but NOT dividend-adjusted; only `indicators.adjclose` carries the dividend
// adjustment. Using raw quote OHLC therefore silently drops dividend return —
// for a 10y KOSPI/US-equity backtest that is a material understatement. We
// derive a per-bar factor f = adjclose/close and scale O/H/L/C by it, producing
// a total-return (dividend-reinvested) series that is internally consistent.
// `adjustment` records which mode actually applied so the UI can label it.

import { HAS_CUSTOM_PROXY, customProxyWrap } from './proxyConfig'

export interface DailyBar {
  date: string // YYYY-MM-DD (exchange local date)
  t: number // epoch seconds
  o: number
  h: number
  l: number
  c: number
  v: number
  rawClose?: number // unadjusted close (표시·대조용)
}

export type AdjustmentMode =
  | 'split+dividend' // adjclose 사용 — 총수익(배당 재투자) 기준
  | 'split-only' // adjclose 미제공 — 분할만 반영, 배당 누락

export interface HistoryResult {
  symbol: string
  currency: string
  exchange: string
  instrumentType: string
  bars: DailyBar[]
  stale: boolean // served from cache after a failed refresh
  fetchedAt: number // epoch ms
  // --- provenance (출처 검증용) ---
  source: string // 'Yahoo Finance chart v8 (비공식·무료)'
  proxyUsed: string
  adjustment: AdjustmentMode
  droppedBars: number // 결측(null OHLC)으로 버린 봉 수
}

export type HistoryRange = '5y' | '10y' | 'max'

const PROXIES: { name: string; wrap: (url: string) => string }[] = [
  ...(HAS_CUSTOM_PROXY ? [{ name: 'custom-worker', wrap: customProxyWrap }] : []),
  { name: 'cors.sh', wrap: (u: string) => `https://proxy.cors.sh/${u}` },
  { name: 'allorigins', wrap: (u: string) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}` },
  { name: 'codetabs', wrap: (u: string) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(u)}` },
  { name: 'direct', wrap: (u: string) => u },
]

export const DATA_SOURCE_LABEL = 'Yahoo Finance chart API v8 (비공식·무료·15~20분 지연)'

export const CACHE_PREFIX = 'history-cache:'
// v1 = 배당 미조정, v2 = 객체 배열(용량 초과 유발), v3 = 컬럼형 압축.
// v4 = range=max 월봉 오염 수정 — v3의 max 캐시에 월봉이 저장됐을 수 있어 무효화.
// 모델·종목이 늘면 봉당 객체 직렬화가 localStorage 5MB 한도를 넘겨
// QuotaExceededError로 캐시가 통째로 깨졌다. 열 단위로 저장해 크기를 줄이고,
// 그래도 넘치면 오래된 항목부터 자동으로 비운다.
const CACHE_VERSION = 'v4'
const CACHE_TTL_MS = 12 * 60 * 60 * 1000 // 12h — daily bars don't change intraday for sim purposes

function cacheKeyOf(symbol: string, range: HistoryRange): string {
  return `${CACHE_PREFIX}${CACHE_VERSION}:${symbol}:${range}`
}

// 컬럼형 저장 포맷 — 봉마다 키 이름을 반복하지 않아 크기가 크게 준다.
// 시뮬레이션에 쓰이지 않는 필드(t, rawClose)는 저장하지 않는다.
export interface PackedHistory {
  s: string
  cur: string
  ex: string
  it: string
  src: string
  px: string
  adj: AdjustmentMode
  drop: number
  at: number
  d: string // 날짜를 쉼표로 이어붙임
  o: number[]
  h: number[]
  l: number[]
  c: number[]
  v: number[]
}

const r4 = (x: number) => Math.round(x * 10000) / 10000

export function packHistory(hist: HistoryResult): PackedHistory {
  return {
    s: hist.symbol,
    cur: hist.currency,
    ex: hist.exchange,
    it: hist.instrumentType,
    src: hist.source,
    px: hist.proxyUsed,
    adj: hist.adjustment,
    drop: hist.droppedBars,
    at: hist.fetchedAt,
    d: hist.bars.map((b) => b.date).join(','),
    o: hist.bars.map((b) => r4(b.o)),
    h: hist.bars.map((b) => r4(b.h)),
    l: hist.bars.map((b) => r4(b.l)),
    c: hist.bars.map((b) => r4(b.c)),
    v: hist.bars.map((b) => b.v),
  }
}

export function unpackHistory(p: PackedHistory): HistoryResult {
  const dates = p.d.length > 0 ? p.d.split(',') : []
  const bars: DailyBar[] = dates.map((date, i) => ({
    date,
    t: Math.floor(Date.parse(date + 'T00:00:00Z') / 1000),
    o: p.o[i],
    h: p.h[i],
    l: p.l[i],
    c: p.c[i],
    v: p.v[i],
  }))
  return {
    symbol: p.s,
    currency: p.cur,
    exchange: p.ex,
    instrumentType: p.it,
    bars,
    stale: false,
    fetchedAt: p.at,
    source: p.src,
    proxyUsed: p.px,
    adjustment: p.adj,
    droppedBars: p.drop,
  }
}

export function readHistoryCache(key: string): HistoryResult | null {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return null
    return unpackHistory(JSON.parse(raw) as PackedHistory)
  } catch {
    return null
  }
}

// 오래된 히스토리 캐시부터 비운다(LRU). 다른 앱 데이터(설정·등록·보드)는
// 건드리지 않는다 — 재조회로 복구 가능한 시세만 버린다.
function evictOldest(exceptKey: string): boolean {
  const entries: { key: string; at: number }[] = []
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i)
    if (!k || !k.startsWith(CACHE_PREFIX) || k === exceptKey) continue
    let at = 0
    try {
      at = (JSON.parse(localStorage.getItem(k) ?? '{}') as PackedHistory).at ?? 0
    } catch {
      /* 깨진 항목은 우선 제거 대상 */
    }
    entries.push({ key: k, at })
  }
  if (entries.length === 0) return false
  entries.sort((a, b) => a.at - b.at)
  localStorage.removeItem(entries[0].key)
  return true
}

export function writeHistoryCache(key: string, h: HistoryResult) {
  const payload = JSON.stringify(packHistory(h))
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      localStorage.setItem(key, payload)
      return
    } catch {
      // 용량 초과 — 가장 오래된 시세 캐시를 비우고 재시도
      if (!evictOldest(key)) return // 비울 게 없으면 캐시 없이 진행(동작에는 지장 없음)
    }
  }
}

function toLocalDate(epochSec: number, gmtoffset: number): string {
  const d = new Date((epochSec + gmtoffset) * 1000)
  return d.toISOString().slice(0, 10)
}

export function parseYahooDaily(symbol: string, json: any, proxyUsed: string): HistoryResult {
  const result = json?.chart?.result?.[0]
  if (!result?.meta) throw new Error('malformed chart response')
  const meta = result.meta
  // 오염 방지 게이트 — Yahoo는 요청 interval을 못 주면 조용히 다른 간격(월봉 등)을 준다.
  // 월봉 위에서 백테스트가 돌면 결과 전체가 무효이므로 일봉이 아니면 거부한다.
  if (meta.dataGranularity && meta.dataGranularity !== '1d')
    throw new Error(`Yahoo가 일봉 대신 ${meta.dataGranularity} 반환 — 기간을 줄이거나 다시 시도하세요`)
  const gmtoffset: number = meta.gmtoffset ?? 0
  const timestamps: number[] = result.timestamp ?? []
  const quote = result.indicators?.quote?.[0] ?? {}
  const opens: (number | null)[] = quote.open ?? []
  const highs: (number | null)[] = quote.high ?? []
  const lows: (number | null)[] = quote.low ?? []
  const closes: (number | null)[] = quote.close ?? []
  const volumes: (number | null)[] = quote.volume ?? []
  const adjcloses: (number | null)[] | undefined = result.indicators?.adjclose?.[0]?.adjclose

  const hasAdj = Array.isArray(adjcloses) && adjcloses.length === closes.length
  const adjustment: AdjustmentMode = hasAdj ? 'split+dividend' : 'split-only'

  const bars: DailyBar[] = []
  let dropped = 0
  for (let i = 0; i < timestamps.length; i++) {
    const o = opens[i]
    const h = highs[i]
    const l = lows[i]
    const c = closes[i]
    if (o == null || h == null || l == null || c == null || !(o > 0 && h > 0 && l > 0 && c > 0)) {
      dropped++
      continue
    }
    // 배당 조정 계수 — adjclose/close. 분할은 Yahoo가 이미 OHLC에 반영했으므로
    // 이 비율에는 배당분만 남는다(분할일에도 양쪽이 같이 조정되어 상쇄).
    let f = 1
    if (hasAdj) {
      const a = adjcloses![i]
      if (a != null && a > 0) f = a / c
    }
    bars.push({
      date: toLocalDate(timestamps[i], gmtoffset),
      t: timestamps[i],
      o: o * f,
      h: h * f,
      l: l * f,
      c: c * f,
      v: volumes[i] ?? 0,
      rawClose: c,
    })
  }
  if (bars.length < 60) throw new Error(`insufficient history for ${symbol} (${bars.length} bars)`)

  return {
    symbol,
    currency: meta.currency ?? '',
    exchange: meta.fullExchangeName ?? meta.exchangeName ?? '',
    instrumentType: meta.instrumentType ?? '',
    bars,
    stale: false,
    fetchedAt: Date.now(),
    source: DATA_SOURCE_LABEL,
    proxyUsed,
    adjustment,
    droppedBars: dropped,
  }
}

export async function getDailyHistory(symbol: string, range: HistoryRange = '10y'): Promise<HistoryResult> {
  const cacheKey = cacheKeyOf(symbol, range)
  const cached = readHistoryCache(cacheKey)
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached

  // events=div,split → adjclose 동반 제공(배당 조정 계수 산출용)
  // ⚠️ range=max 는 Yahoo가 interval=1d 를 무시하고 **월봉**을 돌려준다(2026-07-30 실측 —
  // 월봉 위에서 백테스트가 돌면 결과 전체가 무효다). max 는 period1/period2 명시로 우회한다.
  const qs =
    range === 'max'
      ? `period1=${Math.floor(Date.parse('2000-01-01') / 1000)}&period2=${Math.floor(Date.now() / 1000)}`
      : `range=${range}`
  const target = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    symbol,
  )}?${qs}&interval=1d&events=div%2Csplit`

  let lastErr: unknown = null
  for (const proxy of PROXIES) {
    try {
      const res = await fetch(proxy.wrap(target), {
        headers: proxy.name === 'cors.sh' ? { 'x-requested-with': 'XMLHttpRequest' } : {},
      })
      if (!res.ok) throw new Error(`${proxy.name} HTTP ${res.status}`)
      const json = await res.json()
      const hist = parseYahooDaily(symbol, json, proxy.name)
      writeHistoryCache(cacheKey, hist)
      return hist
    } catch (err) {
      lastErr = err
    }
  }
  if (cached) return { ...cached, stale: true }
  throw new Error(`히스토리 로드 실패 (${symbol}): ${String(lastErr)}`)
}
