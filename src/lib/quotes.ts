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
  marketTime: number // epoch seconds
  intraday: IntradayPoint[]
  stale: boolean // true when served from cache after a failed refresh
  proxyUsed: string
  fetchedAt: number // epoch ms
}

// Prioritized CORS proxies. Each entry wraps a target URL. The array order is
// the fallback order; the first that returns valid JSON wins.
const PROXIES: { name: string; wrap: (url: string) => string }[] = [
  { name: 'cors.sh', wrap: (u) => `https://proxy.cors.sh/${u}` },
  { name: 'allorigins', wrap: (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}` },
  { name: 'codetabs', wrap: (u) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(u)}` },
  { name: 'direct', wrap: (u) => u }, // works in non-browser / permissive contexts
]

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
    marketTime: meta.regularMarketTime ?? Math.floor(Date.now() / 1000),
    intraday,
    stale: false,
    proxyUsed,
    fetchedAt: Date.now(),
  }
}

async function fetchViaProxies(symbol: string, range: string, interval: string): Promise<Quote> {
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
      writeCache(symbol, quote)
      return quote
    } catch (err) {
      lastErr = err
      // try next proxy
    }
  }
  // All proxies failed — fall back to cached last-good, flagged stale.
  const cached = readCache(symbol)
  if (cached) return { ...cached, stale: true }
  throw new Error(`all providers failed for ${symbol}: ${String(lastErr)}`)
}

export async function getQuote(symbol: string): Promise<Quote> {
  return fetchViaProxies(symbol, '1d', '1m')
}

// FX helper: KRW per 1 USD via Yahoo 'KRW=X'.
export async function getUsdKrw(): Promise<number> {
  const q = await fetchViaProxies('KRW=X', '1d', '5m')
  return q.price
}
