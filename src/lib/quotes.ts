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

// 미국 거래소 세션 구분. 국내(.KS) 심볼에는 적용하지 않는다.
export type UsMarketSession = 'pre' | 'regular' | 'post' | 'closed'

// 현재 프리/애프터 세션에서 실제 체결이 있을 때만 채워지는 확장 세션 시세.
// change/changePct 는 항상 **정규 종가(meta.regularMarketPrice) 대비**다.
export interface ExtendedQuote {
  session: 'pre' | 'post'
  price: number // 확장 세션 최신 체결가
  time: number // epoch seconds (해당 체결 시각)
  change: number // 정규 종가 대비
  changePct: number // 정규 종가 대비 %
}

// 차트 음영 등에 쓰는 당일 세션 경계 (epoch seconds).
export interface SessionBounds {
  preStart: number
  regStart: number
  regEnd: number
  postEnd: number
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
  avg20Volume: number // 20-bar average volume (0 if unavailable)
  lastVolume: number // latest bar volume (0 if unavailable)
  marketTime: number // epoch seconds
  intraday: IntradayPoint[]
  stale: boolean // true when served from cache after a failed refresh
  proxyUsed: string
  fetchedAt: number // epoch ms
  // 아래 3개는 미국 거래소 심볼 + 인트라데이(1D/5D) 요청에서만 채워진다.
  session?: UsMarketSession // 요청 시점의 미국 세션 판정
  extended?: ExtendedQuote | null // 현재 프리/애프터 체결이 있으면
  sessionBounds?: SessionBounds
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

// 미국 거래소 상장 종목/ETF(프리·애프터 세션 존재) 판별.
// 휴리스틱: 거래소 접미사(.KS/.KQ/.NYB…) 없음 + 지수(^) 아님 + FX(=X) 아님.
// 해당: SKHY·NVDA·MU·TSM·EWY. 국내 원주·지수·환율은 제외.
export function isUsExchangeSymbol(symbol: string): boolean {
  return !symbol.includes('.') && !symbol.startsWith('^') && !symbol.includes('=')
}

// UI 공용 세션 라벨 (이모지 포함) — 카드·배지·KPI가 같은 표기를 쓴다.
export const US_SESSION_LABEL: Record<UsMarketSession, string> = {
  pre: '🌅 프리장',
  regular: '정규장',
  post: '🌙 애프터',
  closed: '휴장',
}

function yahooUrl(symbol: string, range = '1d', interval = '1m', prePost = false): string {
  return `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    symbol,
  )}?range=${range}&interval=${interval}${prePost ? '&includePrePost=true' : ''}`
}

function parseYahoo(symbol: string, json: any, proxyUsed: string, prePost: boolean): Quote {
  const result = json?.chart?.result?.[0]
  if (!result?.meta) throw new Error('malformed chart response')
  const meta = result.meta
  const price = meta.regularMarketPrice ?? meta.previousClose ?? 0
  const prev = meta.chartPreviousClose ?? meta.previousClose ?? price
  const timestamps: number[] = result.timestamp ?? []
  const closes: (number | null)[] = result.indicators?.quote?.[0]?.close ?? []
  const volumes: (number | null)[] = result.indicators?.quote?.[0]?.volume ?? []

  const intraday: IntradayPoint[] = []
  const vols: number[] = []
  for (let i = 0; i < timestamps.length; i++) {
    const c = closes[i]
    if (c != null && !Number.isNaN(c)) {
      intraday.push({ t: timestamps[i], price: c })
      const v = volumes[i]
      if (v != null && !Number.isNaN(v) && v > 0) vols.push(v)
    }
  }
  const lastVols = vols.slice(-20)
  const avg20Volume = lastVols.length ? Math.round(lastVols.reduce((s, v) => s + v, 0) / lastVols.length) : 0
  const lastVolume = vols.length ? vols[vols.length - 1] : 0

  // ── 미국 프리장/애프터장 (includePrePost 요청일 때만) ──────────────────
  // meta.currentTradingPeriod 로 현재 세션을 판정하고, 현재 확장 세션 창
  // 안의 최신 체결을 찾아 정규 종가 대비 등락으로 계산한다.
  let session: UsMarketSession | undefined
  let extended: ExtendedQuote | null | undefined
  let sessionBounds: SessionBounds | undefined
  const ctp = meta.currentTradingPeriod
  if (prePost && ctp?.pre?.start != null && ctp?.regular?.start != null && ctp?.post?.end != null) {
    sessionBounds = {
      preStart: ctp.pre.start,
      regStart: ctp.regular.start,
      regEnd: ctp.regular.end,
      postEnd: ctp.post.end,
    }
    const nowSec = Math.floor(Date.now() / 1000)
    session =
      nowSec >= ctp.pre.start && nowSec < ctp.regular.start
        ? 'pre'
        : nowSec >= ctp.regular.start && nowSec < ctp.regular.end
          ? 'regular'
          : nowSec >= ctp.regular.end && nowSec < ctp.post.end
            ? 'post'
            : 'closed'
    extended = null
    if ((session === 'pre' || session === 'post') && price > 0) {
      // 현재 확장 세션 창: 프리=[preStart, regStart), 애프터=[regEnd, postEnd)
      const winStart = session === 'pre' ? ctp.pre.start : ctp.regular.end
      const winEnd = session === 'pre' ? ctp.regular.start : ctp.post.end
      for (let i = intraday.length - 1; i >= 0; i--) {
        const p = intraday[i]
        if (p.t >= winStart && p.t < winEnd) {
          extended = {
            session,
            price: p.price,
            time: p.t,
            change: p.price - price, // price = 정규 종가(regularMarketPrice)
            changePct: (p.price / price - 1) * 100,
          }
          break
        }
        if (p.t < winStart) break // 창 이전 구간 진입 — 더 볼 필요 없음
      }
    }
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
    avg20Volume,
    lastVolume,
    marketTime: meta.regularMarketTime ?? Math.floor(Date.now() / 1000),
    intraday,
    stale: false,
    proxyUsed,
    fetchedAt: Date.now(),
    session,
    extended,
    sessionBounds,
  }
}

async function fetchViaProxies(
  symbol: string,
  range: string,
  interval: string,
  cacheKey: string,
  prePost = false,
): Promise<Quote> {
  const target = yahooUrl(symbol, range, interval, prePost)
  let lastErr: unknown = null
  for (const proxy of PROXIES) {
    try {
      const url = proxy.wrap(target)
      const res = await fetch(url, {
        headers: proxy.name === 'cors.sh' ? { 'x-requested-with': 'XMLHttpRequest' } : {},
      })
      if (!res.ok) throw new Error(`${proxy.name} HTTP ${res.status}`)
      const json = await res.json()
      const quote = parseYahoo(symbol, json, proxy.name, prePost)
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
  const { range, interval, live } = PERIOD_MAP[period]
  // 미국 종목 + 인트라데이(1D/5D)만 프리/애프터 체결 포함 요청.
  const prePost = live && isUsExchangeSymbol(symbol)
  return fetchViaProxies(symbol, range, interval, `${symbol}:${period}`, prePost)
}

// FX quote (KRW per 1 USD) via Yahoo 'KRW=X', with selectable history period.
export async function getFxQuote(period: QuotePeriod = '1D'): Promise<Quote> {
  const { range, interval } = PERIOD_MAP[period]
  return fetchViaProxies('KRW=X', range, interval, `KRW=X:${period}`)
}
