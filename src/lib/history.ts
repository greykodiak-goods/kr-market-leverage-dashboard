// Daily OHLCV history layer for the backtest simulator.
//
// Source: Yahoo Finance chart API (no key), range up to `max`, interval=1d,
// fetched through the same prioritized CORS proxy chain as quotes.ts. The last
// good response per (symbol, range) is cached in localStorage with a TTL so a
// re-run within the same day never re-hits the network.

import { HAS_CUSTOM_PROXY, customProxyWrap } from './proxyConfig'

export interface DailyBar {
  date: string // YYYY-MM-DD (exchange local date)
  t: number // epoch seconds
  o: number
  h: number
  l: number
  c: number
  v: number
}

export interface HistoryResult {
  symbol: string
  currency: string
  exchange: string
  bars: DailyBar[]
  stale: boolean // served from cache after a failed refresh
  fetchedAt: number // epoch ms
}

export type HistoryRange = '5y' | '10y' | 'max'

const PROXIES: { name: string; wrap: (url: string) => string }[] = [
  ...(HAS_CUSTOM_PROXY ? [{ name: 'custom-worker', wrap: customProxyWrap }] : []),
  { name: 'cors.sh', wrap: (u: string) => `https://proxy.cors.sh/${u}` },
  { name: 'allorigins', wrap: (u: string) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}` },
  { name: 'codetabs', wrap: (u: string) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(u)}` },
  { name: 'direct', wrap: (u: string) => u },
]

const CACHE_PREFIX = 'history-cache:'
const CACHE_TTL_MS = 12 * 60 * 60 * 1000 // 12h — daily bars don't change intraday for sim purposes

function readCache(key: string): HistoryResult | null {
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + key)
    if (!raw) return null
    return JSON.parse(raw) as HistoryResult
  } catch {
    return null
  }
}

function writeCache(key: string, h: HistoryResult) {
  try {
    localStorage.setItem(CACHE_PREFIX + key, JSON.stringify(h))
  } catch {
    /* quota / disabled storage */
  }
}

function toLocalDate(epochSec: number, gmtoffset: number): string {
  const d = new Date((epochSec + gmtoffset) * 1000)
  return d.toISOString().slice(0, 10)
}

function parseYahooDaily(symbol: string, json: any): HistoryResult {
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

  const bars: DailyBar[] = []
  for (let i = 0; i < timestamps.length; i++) {
    const o = opens[i]
    const h = highs[i]
    const l = lows[i]
    const c = closes[i]
    if (o == null || h == null || l == null || c == null) continue
    if (!(o > 0 && h > 0 && l > 0 && c > 0)) continue
    bars.push({
      date: toLocalDate(timestamps[i], gmtoffset),
      t: timestamps[i],
      o,
      h,
      l,
      c,
      v: volumes[i] ?? 0,
    })
  }
  if (bars.length < 60) throw new Error(`insufficient history for ${symbol} (${bars.length} bars)`)

  return {
    symbol,
    currency: meta.currency ?? '',
    exchange: meta.fullExchangeName ?? meta.exchangeName ?? '',
    bars,
    stale: false,
    fetchedAt: Date.now(),
  }
}

export async function getDailyHistory(symbol: string, range: HistoryRange = '10y'): Promise<HistoryResult> {
  const cacheKey = `${symbol}:${range}`
  const cached = readCache(cacheKey)
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached

  const target = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    symbol,
  )}?range=${range}&interval=1d`

  let lastErr: unknown = null
  for (const proxy of PROXIES) {
    try {
      const res = await fetch(proxy.wrap(target), {
        headers: proxy.name === 'cors.sh' ? { 'x-requested-with': 'XMLHttpRequest' } : {},
      })
      if (!res.ok) throw new Error(`${proxy.name} HTTP ${res.status}`)
      const json = await res.json()
      const hist = parseYahooDaily(symbol, json)
      writeCache(cacheKey, hist)
      return hist
    } catch (err) {
      lastErr = err
    }
  }
  if (cached) return { ...cached, stale: true }
  throw new Error(`히스토리 로드 실패 (${symbol}): ${String(lastErr)}`)
}
