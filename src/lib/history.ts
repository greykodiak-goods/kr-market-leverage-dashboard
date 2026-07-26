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

const CACHE_PREFIX = 'history-cache:'
const CACHE_VERSION = 'v2' // v1 = 배당 미조정. 버전을 올려 옛 캐시를 무효화한다.
const CACHE_TTL_MS = 12 * 60 * 60 * 1000 // 12h — daily bars don't change intraday for sim purposes

function cacheKeyOf(symbol: string, range: HistoryRange): string {
  return `${CACHE_PREFIX}${CACHE_VERSION}:${symbol}:${range}`
}

function readCache(key: string): HistoryResult | null {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return null
    return JSON.parse(raw) as HistoryResult
  } catch {
    return null
  }
}

function writeCache(key: string, h: HistoryResult) {
  try {
    localStorage.setItem(key, JSON.stringify(h))
  } catch {
    /* quota / disabled storage */
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
  const cached = readCache(cacheKey)
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached

  // events=div,split → adjclose 동반 제공(배당 조정 계수 산출용)
  const target = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    symbol,
  )}?range=${range}&interval=1d&events=div%2Csplit`

  let lastErr: unknown = null
  for (const proxy of PROXIES) {
    try {
      const res = await fetch(proxy.wrap(target), {
        headers: proxy.name === 'cors.sh' ? { 'x-requested-with': 'XMLHttpRequest' } : {},
      })
      if (!res.ok) throw new Error(`${proxy.name} HTTP ${res.status}`)
      const json = await res.json()
      const hist = parseYahooDaily(symbol, json, proxy.name)
      writeCache(cacheKey, hist)
      return hist
    } catch (err) {
      lastErr = err
    }
  }
  if (cached) return { ...cached, stale: true }
  throw new Error(`히스토리 로드 실패 (${symbol}): ${String(lastErr)}`)
}
