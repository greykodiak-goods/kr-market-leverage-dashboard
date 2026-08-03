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

// `max` = 2000-01-01부터, `max1999` = 1999-01-01부터(백테스트 **워밍업 전용** 1년).
// 왜 워밍업이 필요한가: 연쇄 백테스트의 첫 해(2000년)에 이평·모멘텀 창을 채울 과거 봉이
// 없으면 `smaAt`이 null → `maBreak` 청산이 발동하지 않고, `momentum12_1`도 null이라
// 후보에서 빠진다. 즉 첫 해만 규칙이 다르게 작동한다(2026-08-02 MODE=presetdiag 실측).
// 연구 러너(scripts/*.entry.ts)는 처음부터 `since:1999-01-01`을 썼고, 화면·사전계산만
// 2000-01-01이라 수치가 갈라졌다. **백테스트 시작일은 그대로 2000년**이며 1999년 봉은
// 지표 창을 채우는 데만 쓰인다(과거 방향 데이터 추가이므로 규칙 1과 무관 —
// 절단 불변성은 tests/krdual.test.ts가 확인한다).
export type HistoryRange = '5y' | '10y' | 'max' | 'max1999'

/** period1을 명시해야 하는 범위 — Yahoo는 range=max에서 interval=1d를 무시하고 월봉을 준다. */
const RANGE_SINCE: Partial<Record<HistoryRange, string>> = {
  max: '2000-01-01',
  max1999: '1999-01-01',
}

/** 백테스트(연쇄 실행) 경로가 쓰는 범위 — 화면·사전계산·연구 러너가 이 하나로 통일된다. */
export const BACKTEST_HISTORY_RANGE: HistoryRange = 'max1999'

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

// ---- IndexedDB 캐시 계층 ----------------------------------------------------
// localStorage 5MB 한도에는 80종목 × 16년 컬럼형(~12MB)이 다 들어가지 못해
// LRU가 서로를 밀어내며 **매 실행 상당수를 다시 받았다**(시뮬 체감 지연의 주범).
// IndexedDB는 수백 MB까지 허용되므로 시세 캐시를 여기로 옮긴다. 키·값(PackedHistory)·
// TTL 의미는 동일하고, 기존 localStorage 항목은 읽힐 때 IDB로 이관된다.
// indexedDB가 없는 환경(node 테스트·구형 브라우저)은 기존 localStorage 경로로 폴백.
let idbPromise: Promise<IDBDatabase | null> | null = null
function openIdb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null)
  if (!idbPromise) {
    idbPromise = new Promise((resolve) => {
      try {
        const req = indexedDB.open('history-cache-db', 1)
        req.onupgradeneeded = () => req.result.createObjectStore('history')
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => resolve(null)
        req.onblocked = () => resolve(null)
      } catch {
        resolve(null)
      }
    })
  }
  return idbPromise
}

function idbGet(key: string): Promise<PackedHistory | null> {
  return openIdb().then(
    (db) =>
      new Promise<PackedHistory | null>((resolve) => {
        if (!db) return resolve(null)
        try {
          const req = db.transaction('history').objectStore('history').get(key)
          req.onsuccess = () => resolve((req.result as PackedHistory | undefined) ?? null)
          req.onerror = () => resolve(null)
        } catch {
          resolve(null)
        }
      }),
  )
}

function idbSet(key: string, value: PackedHistory): Promise<boolean> {
  return openIdb().then(
    (db) =>
      new Promise<boolean>((resolve) => {
        if (!db) return resolve(false)
        try {
          const tx = db.transaction('history', 'readwrite')
          tx.objectStore('history').put(value, key)
          tx.oncomplete = () => resolve(true)
          tx.onerror = () => resolve(false)
          tx.onabort = () => resolve(false)
        } catch {
          resolve(false)
        }
      }),
  )
}

async function readHistoryCacheAsync(key: string): Promise<HistoryResult | null> {
  const packed = await idbGet(key)
  if (packed) {
    try {
      return unpackHistory(packed)
    } catch {
      /* 손상 항목 — 새로 받는다 */
    }
  }
  // 레거시 localStorage 항목 — 읽히면 IDB로 이관해 다음부터 그쪽에서 나온다
  const legacy = readHistoryCache(key)
  if (legacy) void idbSet(key, packHistory(legacy))
  return legacy
}

async function writeHistoryCacheAsync(key: string, h: HistoryResult): Promise<void> {
  const ok = await idbSet(key, packHistory(h))
  if (!ok) writeHistoryCache(key, h) // IDB 불가 환경 — 기존 localStorage(LRU 정리 포함)로
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
  const cached = await readHistoryCacheAsync(cacheKey)
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached

  // events=div,split → adjclose 동반 제공(배당 조정 계수 산출용)
  // ⚠️ range=max 는 Yahoo가 interval=1d 를 무시하고 **월봉**을 돌려준다(2026-07-30 실측 —
  // 월봉 위에서 백테스트가 돌면 결과 전체가 무효다). max·max1999 는 period1/period2 명시로 우회한다.
  const since = RANGE_SINCE[range]
  const qs = since
    ? `period1=${Math.floor(Date.parse(since) / 1000)}&period2=${Math.floor(Date.now() / 1000)}`
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
      void writeHistoryCacheAsync(cacheKey, hist) // 캐시 기록은 응답을 막지 않는다
      return hist
    } catch (err) {
      lastErr = err
    }
  }
  if (cached) return { ...cached, stale: true }
  throw new Error(`히스토리 로드 실패 (${symbol}): ${String(lastErr)}`)
}

// ---- 국내 종목 듀얼 소스 로드 (.KQ / .KS) -----------------------------------
//
// 유니버스 목록은 6자리 코드고 Yahoo는 시장 접미사를 요구한다. 코스닥→코스피로 옮겨간
// 종목(카카오·셀트리온 등)은 **현재 접미사 쪽에 전 기간 이력**이 붙어 있어 한쪽만 봐서는
// 시작일이 밀린다. 그런데 Yahoo는 존재하지 않는 조합에도 **가짜 짧은 시계열**을 준다 —
// 2026-08-02 GHA 실측에서 다수 코스닥 종목의 `.KS` 쿼리가 11봉(2026-07-16 시작)짜리
// 시리즈를 돌려줬다. "첫 성공에서 중단"하면 그 11봉이 채택되고, 시작일이 밀린 탓에
// `bars[0].date <= {해}-06-30` 편입 판정에서 **142 종목-해가 유니버스에서 통째로 빠졌다**
// (평균 매핑률 98% → 71%).
//
// 그래서 연구 러너 `fetchKrDual`(scripts/spec-backtest.entry.ts — **정본**)의 규약을 그대로 쓴다:
//   ① `.KQ` → `.KS` **둘 다 시도**  ② **긴 이력을 채택**  ③ **200봉 미만이면 채택 자체를 포기**
//   ④ 200봉 이상을 만나면 거기서 끊는다(뒤 접미사는 조회하지 않는다 — 왕복 절약).
//
// 네트워크·캐시·환경 의존이 없는 **순수 정책 함수**다. 조회 자체는 호출부가 주입하므로
// 브라우저(getDailyHistory·CORS 프록시)와 노드(스크립트의 직접 fetch) 양쪽에서 그대로 쓴다.

/** 접미사 시도 순서 — 연구 러너와 동일 */
export const KR_SUFFIXES: readonly string[] = ['.KQ', '.KS']
/** 이보다 짧은 시계열은 Yahoo의 가짜 응답으로 보고 채택하지 않는다 */
export const KR_MIN_BARS = 200

/** 화면·산출물에 그대로 붙일 수 있는 한 줄 표기(규칙 3 — 데이터 출처 정직성) */
export const KR_LOAD_NOTE =
  '국내 종목은 .KQ/.KS 양쪽을 조회해 긴 이력을 채택하고(200봉 미만은 가짜 응답으로 보고 제외), ' +
  '지표 워밍업용으로 1999년부터 받되 백테스트 시작은 2000년입니다.'

/**
 * 야후 경로의 **배지 한 줄** — 그래프·표 옆에 붙인다.
 * (KRX 정본 쪽 배지는 `krxDailyPrices.ts`의 `KRX_DAILY_BADGE`가 정본이다. 두 소스가
 *  같은 자리에 표시되므로 문구 모양을 맞춰 둔다 — 어느 쪽으로 돌았는지 한눈에 갈리게.)
 */
export const YAHOO_DAILY_BADGE = 'Yahoo 일봉(분할+배당 보정) · 비공식 엔드포인트'

/**
 * 야후 경로의 **한계 목록**(규칙 3 — 출처·한계를 확인 가능하게).
 * 문구를 여기서만 바꾼다 — 화면·사전계산 산출물이 이 배열을 그대로 나른다.
 *
 * 이 목록이 곧 "야후를 배제하려는 이유"다(2026-08-03 대표 지시 · KRX 일별 정본 전환).
 */
export const YAHOO_DAILY_LIMITS: readonly string[] = [
  '비공식·무료 엔드포인트(15~20분 지연) — 정확성 미보증이고 응답 형식이 예고 없이 바뀐다.',
  '생존편향 — 상장폐지·합병 종목은 시계열 자체가 없어 유니버스에서 통째로 빠진다. 빠진 쪽이 나빴을 확률이 높아 성적이 부풀려진다.',
  '가짜 시계열 위험 — 6자리 코드에 엉뚱한 티커의 짧은 응답이 온 사고가 있었다(2026-08-02). 200봉 미만은 채택하지 않는다.',
  '총수익 기준(adjclose÷close 계수를 OHLC에 적용 · 배당 재투자) — 가격수익 기준인 KRX 정본과 같은 표에서 직접 비교하면 안 된다.',
  '환율·수수료·세금은 시세에 반영돼 있지 않다.',
]

export interface KrDualAttempt {
  symbol: string
  barCount: number
  /** 조회 실패 사유. 성공이면 '' */
  error: string
}

export interface KrDualPick<T> {
  code: string
  /** 실제로 채택된 심볼 — '035720.KS' */
  symbol: string
  suffix: string
  barCount: number
  value: T
  /** 시도 기록(조회하지 않은 접미사는 들어가지 않는다) — 진단·로그용 */
  attempts: KrDualAttempt[]
}

/**
 * 한 국내 종목 코드의 시세를 `.KQ`/`.KS` 양쪽에서 받아 **긴 쪽**을 채택한다.
 * 채택 후보가 `minBars` 미만이면 **null**(= 그 코드는 유니버스에 없는 것으로 취급).
 *
 * @param fetchOne     심볼 하나를 받아오는 함수(브라우저/노드 각자의 경로를 주입)
 * @param barCountOf   받아온 값의 봉 수
 * @param opts.betweenAttempts 접미사 사이에 끼울 대기(유량 제한 완화). 마지막 시도 뒤에는 부르지 않는다.
 */
export async function loadKrDual<T>(
  code: string,
  fetchOne: (symbol: string) => Promise<T>,
  barCountOf: (value: T) => number,
  opts: {
    suffixes?: readonly string[]
    minBars?: number
    betweenAttempts?: () => Promise<void>
  } = {},
): Promise<KrDualPick<T> | null> {
  const suffixes = opts.suffixes ?? KR_SUFFIXES
  const minBars = opts.minBars ?? KR_MIN_BARS
  const attempts: KrDualAttempt[] = []
  let best: { symbol: string; suffix: string; barCount: number; value: T } | null = null

  for (let i = 0; i < suffixes.length; i++) {
    const suffix = suffixes[i]
    const symbol = `${code}${suffix}`
    let enough = false
    try {
      const value = await fetchOne(symbol)
      const barCount = barCountOf(value)
      attempts.push({ symbol, barCount, error: '' })
      // 더 긴 이력만 채택한다 — 짧은 가짜 시계열이 먼저 와도 뒤의 긴 쪽이 이긴다.
      if (!best || barCount > best.barCount) best = { symbol, suffix, barCount, value }
      if (barCount >= minBars) enough = true // 충분히 길다 — 남은 접미사는 조회하지 않는다
    } catch (err) {
      attempts.push({ symbol, barCount: 0, error: String(err) })
    }
    if (enough) break
    if (i < suffixes.length - 1) await opts.betweenAttempts?.()
  }

  if (!best || best.barCount < minBars) return null
  return { code, symbol: best.symbol, suffix: best.suffix, barCount: best.barCount, value: best.value, attempts }
}
