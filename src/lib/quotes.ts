// Quote data layer. Provider-agnostic so the underlying source can later be
// swapped for a keyed API without touching UI code.
//
// Primary source: Yahoo Finance chart API (no key / no signup).
//   https://query1.finance.yahoo.com/v8/finance/chart/{symbol}?range=1d&interval=1m
// Yahoo blocks browser CORS, so calls go through a prioritized list of public
// CORS proxies with fallback. Last good response per symbol is cached in
// localStorage so the UI never goes blank.

export interface IntradayPoint {
  t: number // epoch seconds
  price: number
}

export interface Quote {
  symbol: string
  currency: string
  exchange: string
  price: number
  previousClose: number
  change: number
  changePct: number
  dayHigh: number
  dayLow: number
  fiftyTwoWeekLow: number
  fiftyTwoWeekHigh: number
  marketTime: number // epoch seconds
  intraday: IntradayPoint[]
  stale: boolean // true when served from cache after a failed refresh
  proxyUsed: string
  fetchedAt: number // epoch ms
}

import { HAS_CUSTOM_PROXY, customProxyWrap } from './proxyConfig'

// Prioritized CORS proxies. Each entry wraps a target URL. The array order is
// the fallback order; the first that returns valid JSON wins. The dedicated
// Cloudflare Worker (proxyConfig.CUSTOM_PROXY), when set, takes priority.
const PROXIES: { name: string; wrap: (url: string) => string }[] = [
  ...(HAS_CUSTOM_PROXY ? [{ name: 'custom-worker', wrap: customProxyWrap }] : []),
  { name: 'cors.sh', wrap: (u) => `https://proxy.cors.sh/${u}` },
  { name: 'allorigins', wrap: (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}` },
  { name: 'codetabs', wrap: (u) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(u)}` },
  { name: 'direct', wrap: (u) => u }, // works in non-browser / permissive contexts
]

// Selectable history periods mapped to Yahoo range/interval + polling policy.
export type QuotePeriod = '1D' | '5D' | '1M' | '6M' | '1Y' | '5Y' | '10Y' | 'MAX'

export const QUOTE_PERIODS: QuotePeriod[] = ['1D', '5D', '1M', '6M', '1Y', '5Y', '10Y', 'MAX']

export const PERIOD_MAP: Record<QuotePeriod, { range: string; interval: string; live: boolean }> = {
  '1D': { range: '1d', interval: '1m', live: true },
  '5D': { range: '5d', interval: '5m', live: true },
  '1M': { range: '1mo', interval: '1d', live: false },
  '6M': { range: '6mo', interval: '1d', live: false },
  '1Y': { range: '1y', interval: '1d', live: false },
  '5Y': { range: '5y', interval: '1wk', live: false },
  '10Y': { range: '10y', interval: '1mo', live: false },
  MAX: { range: 'max', interval: '1mo', live: false },
}

const CACHE_PREFIX = 'quote-cache:'

function readCache(symbol: string): Quote | null {
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + symbol)
    if (!raw) return null
    return JSON.parse(raw) as Quote
  } catch {
    return null
  }
}

function writeCache(symbol: string, q: Quote) {
  try {
    localStorage.setItem(CACHE_PREFIX + symbol, JSON.stringify(q))
  } catch {
    /* ignore quota / disabled storage */
  }
}

function yahooUrl(symbol: string, range = '1d', interval = '1m'): string {
  return `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    symbol,
  )}?range=${range}&interval=${interval}`
}

function parseYahoo(symbol: string, json: any, proxyUsed: string): Quote {
  const result = json?.chart?.result?.[0]
  if (!result?.meta) throw new Error('malformed chart response')
  const meta = result.meta
  const price = meta.regularMarketPrice ?? meta.previousClose ?? 0
  const prev = meta.chartPreviousClose ?? meta.previousClose ?? price
  const timestamps: number[] = result.timestamp ?? []
  const closes: (number | null)[] = result.indicators?.quote?.[0]?.close ?? []

  const intraday: IntradayPoint[] = []
  for (let i = 0; i < timestamps.length; i++) {
    const c = closes[i]
    if (c != null && !Number.isNaN(c)) intraday.push({ t: timestamps[i], price: c })
  }

  return {
    symbol,
    currency: meta.currency ?? '',
    exchange: meta.fullExchangeName ?? meta.exchangeName ?? '',
    price,
    previousClose: prev,
    change: price - prev,
    changePct: prev ? ((price - prev) / prev) * 100 : 0,
    dayHigh: meta.regularMarketDayHigh ?? (intraday.length ? Math.max(...intraday.map((p) => p.price)) : price),
    dayLow: meta.regularMarketDayLow ?? (intraday.length ? Math.min(...intraday.map((p) => p.price)) : price),
    fiftyTwoWeekLow: meta.fiftyTwoWeekLow ?? (intraday.length ? Math.min(...intraday.map((p) => p.price)) : price),
    fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh ?? (intraday.length ? Math.max(...intraday.map((p) => p.price)) : price),
    marketTime: meta.regularMarketTime ?? Math.floor(Date.now() / 1000),
    intraday,
    stale: false,
    proxyUsed,
    fetchedAt: Date.now(),
  }
}

async function fetchViaProxies(symbol: string, range: string, interval: string, cacheKey: string): Promise<Quote> {
  const target = yahooUrl(symbol, range, interval)
  let lastErr: unknown = null
  for (const proxy of PROXIES) {
    try {
      const url = proxy.wrap(target)
      const res = await fetch(url, {
        headers: proxy.name === 'cors.sh' ? { 'x-requested-with': 'XMLHttpRequest' } : {},
      })
      if (!res.ok) throw new Error(`${proxy.name} HTTP ${res.status}`)
      const json = await res.json()
      const quote = parseYahoo(symbol, json, proxy.name)
      writeCache(cacheKey, quote)
      return quote
    } catch (err) {
      lastErr = err
      // try next proxy
    }
  }
  // All proxies failed — fall back to cached last-good, flagged stale.
  const cached = readCache(cacheKey)
  if (cached) return { ...cached, stale: true }
  throw new Error(`all providers failed for ${symbol}: ${String(lastErr)}`)
}

export async function getQuote(symbol: string, period: QuotePeriod = '1D'): Promise<Quote> {
  const { range, interval } = PERIOD_MAP[period]
  return fetchViaProxies(symbol, range, interval, `${symbol}:${period}`)
}

// FX quote (KRW per 1 USD) via Yahoo 'KRW=X', with selectable history period.
export async function getFxQuote(period: QuotePeriod = '1D'): Promise<Quote> {
  const { range, interval } = PERIOD_MAP[period]
  return fetchViaProxies('KRW=X', range, interval, `KRW=X:${period}`)
}
