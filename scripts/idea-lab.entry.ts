// 아이디어 랩 — 조건 확장 실험 러너 (2026-08-02 대표 지시)
//
//   "조건들을 더 넣어서 검토해보자. 예: 특정 계절마다 특정값 조정 /
//    특정 종목의 특정 월 상승 패턴 / 삼성전자·삼성전자우 주가 차이 기반 매매."
//
// MODE=seasonal  — 월별 계절성 기술통계 + 승자 조건식 위 월 필터 오버레이 A/B
// MODE=monthpat  — 종목×월 상승패턴 셀 선정(확장 윈도우) 후 해당 월만 보유
// MODE=pairprem  — 삼성전자/삼성전자우 괴리율 z-score 스위칭 (롱온리)
// MODE=flow      — 투자자 순매수(수급) 조건 A/B  (2026-08-02 대표 지시 "수급·거래량 기반 검토")
//
// ── 비(非)이평 계열 (2026-08-02 대표 지시 "MA 이평선 말고 다른 접근은 없냐") ──────
// MODE=xsmom    — 횡단면 모멘텀 랭킹(12-1). 이동평균을 아예 쓰지 않는다.
// MODE=volbrk   — 변동성 돌파(래리 윌리엄스 k). 전일 레인지만 쓴다.
// MODE=rsirev   — 단기 평균회귀(RSI2 · Wilder) + 200일선 추세 필터.
//   판정 기준선은 셋 다 **MA25×신고10→80선**(23차 격자 수익÷MDD 1위)을 같은 유니버스·
//   같은 비용으로 **재실행한** 수치다. 다른 표의 숫자를 옮겨 적지 않는다.
//
// ── 규칙 1(미래참조 금지) 준수 방법 ────────────────────────────────────────
//   · 모든 통계는 **확장 윈도우**다. 전체 구간 평균·표준편차·최대최소를 임계값
//     산출에 쓰지 않는다(그 자체가 미래 정보). 월 필터·셀 선정은 "그 해 1월 초까지의
//     데이터"만, 괴리율 z는 "그 시점까지의" 평균·표준편차만 쓴다.
//   · pairprem 신호는 당일 종가로 판정하고 **다음 거래일 시가**에 체결한다.
//   · flow는 **T−1 원칙**을 지킨다 — D일 진입 판단(종가 매수)에 쓰는 수급은
//     `dt < D`로 확정된 것만이다. D일 투자자별 순매수는 장 마감 후에야 확정되므로
//     그날 판단에 넣으면 그 자체가 미래참조다(makeFlowLens.before가 유일한 접근 경로).
//   · 마지막 봉에서는 신규 진입·신규 스위칭을 만들지 않는다(체결할 다음 봉이 없다).
//   · 집행자는 `tests/idealab.test.ts`의 절단 불변성 테스트다.
//
// ── 유니버스 ──────────────────────────────────────────────────────────────
//   고정 80종목 유니버스는 승자편향이 확인됐다(총 +42,103% → 연도별 상위 10+10
//   교체 시 +841%). 따라서 유니버스가 필요한 실험은 **연도별 상위 10+10 [추정]**
//   교체 유니버스로 돌린다. PIT1010 상수와 연쇄 로직은 spec-backtest.entry.ts에서
//   복사해 왔다 — 정본은 추후 `src/features/backtest/pitUniverse.ts`로 합류 예정
//   (지금 그 파일을 만들면 다른 워커의 작업 파일과 충돌한다).
//
// ⚠️ 컨테이너에서 Yahoo는 403이라 실데이터 실행은 여기서 하지 않았다.
//    로직은 합성 데이터 테스트로만 검증된 상태다 — 수치 산출은 [미검증-실데이터].

import {
  runStrategySpec,
  type ConditionResult,
  type CostSettings,
} from '../src/features/backtest/conditionScreen'
import {
  SPEC_VERSION,
  priorHigh,
  sma,
  type Condition,
  type ConditionNode,
  type StrategySpec,
} from '../src/features/backtest/strategySpec'
import type { DailyBar } from '../src/features/backtest/types'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const COST: CostSettings = { initialCapital: 10_000_000, feePct: 0.015, taxPct: 0.15, slippagePct: 0.1 }
const BENCH = '069500.KS' // KODEX 200
const HALF_SPLIT = '2013-06-30' // 기술통계 전·후반 분할 기준(대표 지시)
const HALF_YEAR = 2014 // 전략 연쇄는 연 단위라 연도 경계로 나눈다(2000~2013 / 2014~)

export function log(msg: string) {
  console.log(msg)
}
export const f1 = (v: number | null) => (v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(1)}`)
export const f2 = (v: number | null) => (v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}`)

// ============================================================================
// 데이터 로더 — spec-backtest.entry.ts에서 복사 (정본 합류 예정)
// ============================================================================

async function fetchDaily(symbol: string, range = '10y'): Promise<DailyBar[]> {
  const qs = range.startsWith('since:')
    ? `period1=${Math.floor(Date.parse(range.slice(6)) / 1000)}&period2=${Math.floor(Date.now() / 1000)}`
    : `range=${range}`
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    symbol,
  )}?${qs}&interval=1d&events=div%2Csplit`
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' } })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const json = (await res.json()) as any
  const r = json?.chart?.result?.[0]
  if (!r) throw new Error(json?.chart?.error?.description ?? 'chart.result 없음')
  const ts: number[] = r.timestamp ?? []
  const q = r.indicators?.quote?.[0] ?? {}
  const adj: (number | null)[] = r.indicators?.adjclose?.[0]?.adjclose ?? []
  const out: DailyBar[] = []
  for (let i = 0; i < ts.length; i++) {
    const o = q.open?.[i]
    const h = q.high?.[i]
    const l = q.low?.[i]
    const cl = q.close?.[i]
    const v = q.volume?.[i]
    if ([o, h, l, cl].some((x: unknown) => x == null || !Number.isFinite(x as number))) continue
    // 총수익 보정(규칙 3): adjclose ÷ close 계수를 OHLC에 적용 (배당 재투자 기준)
    const f = adj[i] != null && Number.isFinite(adj[i]!) && cl > 0 ? adj[i]! / cl : 1
    const date = new Date(ts[i] * 1000 + 9 * 3600 * 1000).toISOString().slice(0, 10) // KST
    out.push({ date, t: ts[i], o: o * f, h: h * f, l: l * f, c: cl * f, v: Number.isFinite(v) ? v : 0 })
  }
  return out
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** 코스닥 출신 종목 폴백 로드 — .KQ 우선, 실패/짧으면 .KS */
async function fetchKrDual(code: string, range: string): Promise<DailyBar[] | null> {
  let best: DailyBar[] | null = null
  for (const suffix of ['.KQ', '.KS']) {
    try {
      const bars = await fetchDaily(`${code}${suffix}`, range)
      if (!best || bars.length > best.length) best = bars
      if (bars.length >= 200) break
    } catch {
      /* 다음 접미사 시도 */
    }
    await sleep(120)
  }
  return best && best.length >= 200 ? best : null
}

// ============================================================================
// 연도별 [추정] 상위 10+10 유니버스 — spec-backtest.entry.ts PIT1010 사본
// 정본은 추후 src/features/backtest/pitUniverse.ts로 합류 예정.
// ============================================================================

export const PIT1010: Record<number, { ks: string[]; kq: string[] }> = {
  2000: { ks: ['005930', '017670', '030200', '015760', '005490', '000660', '005380', '009150', '006400', '033780'], kq: ['035720', '035610', '030520', '036930', '053800'] },
  2001: { ks: ['005930', '017670', '030200', '015760', '005490', '000660', '005380', '033780', '006400', '009150'], kq: ['035720', '036570', '035610', '030520', '036930', '053800'] },
  2002: { ks: ['005930', '017670', '030200', '015760', '005490', '055550', '005380', '033780', '006400', '000660'], kq: ['036570', '035720', '030520', '035610', '036930', '053800', '046890'] },
  2003: { ks: ['005930', '017670', '030200', '015760', '005490', '055550', '005380', '066570', '033780', '012330'], kq: ['035250', '036570', '035760', '035720', '053800', '046890', '030520', '036930'] },
  2004: { ks: ['005930', '017670', '030200', '015760', '005490', '055550', '005380', '066570', '012330', '033780'], kq: ['035420', '032640', '035760', '035720', '034230', '046890', '053800', '036930', '030520', '041510'] },
  2005: { ks: ['005930', '005490', '015760', '017670', '030200', '055550', '005380', '033780', '012330', '009540'], kq: ['035420', '032640', '035760', '035720', '034230', '046890', '053800', '036930', '056190', '041510'] },
  2006: { ks: ['005930', '005490', '015760', '017670', '055550', '030200', '005380', '033780', '012330', '009540'], kq: ['035420', '032640', '035760', '035720', '046890', '034230', '053800', '056190', '041510', '036930'] },
  2007: { ks: ['005930', '005490', '009540', '015760', '055550', '017670', '005380', '034020', '010140', '030200'], kq: ['035420', '032640', '035760', '072870', '041510', '046890', '053800', '056190', '035720', '036930'] },
  2008: { ks: ['005930', '005490', '009540', '015760', '055550', '017670', '005380', '096770', '034020', '030200'], kq: ['035420', '032640', '035760', '072870', '041510', '046890', '056190', '053800', '035720', '036930'] },
  2009: { ks: ['005930', '005490', '015760', '055550', '105560', '017670', '005380', '009540', '051910', '030200'], kq: ['068270', '046890', '072870', '035720', '044490', '056190', '022100', '026960', '053800', '036930'] },
  2010: { ks: ['005930', '005490', '005380', '015760', '055550', '105560', '051910', '017670', '000270', '012330'], kq: ['068270', '046890', '035720', '072870', '022100', '026960', '044490', '056190', '041510', '053800'] },
  2011: { ks: ['005930', '005490', '005380', '012330', '051910', '055550', '105560', '032830', '000270', '015760'], kq: ['068270', '035720', '046890', '026960', '022100', '072870', '096530', '041510', '056190', '035600'] },
  2012: { ks: ['005930', '005380', '005490', '012330', '051910', '032830', '055550', '105560', '000270', '017670'], kq: ['068270', '035720', '046890', '026960', '096530', '041510', '022100', '072870', '056190', '053800'] },
  2013: { ks: ['005930', '005380', '005490', '012330', '051910', '032830', '055550', '105560', '000270', '035420'], kq: ['068270', '035720', '130960', '096530', '046890', '026960', '041510', '022100', '072870', '056190'] },
  2014: { ks: ['005930', '005380', '005490', '012330', '051910', '055550', '105560', '032830', '015760', '035420'], kq: ['068270', '035720', '130960', '046890', '026960', '096530', '041510', '078340', '022100', '072870'] },
  2015: { ks: ['005930', '005380', '015760', '012330', '055550', '032830', '051910', '105560', '005490', '035420'], kq: ['035720', '068270', '130960', '096530', '046890', '041510', '078340', '026960', '072870', '056190'] },
  2016: { ks: ['005930', '005380', '015760', '012330', '032830', '055550', '051910', '105560', '035420', '005490'], kq: ['035720', '068270', '130960', '084990', '041960', '096530', '046890', '041510', '078340', '026960'] },
  2017: { ks: ['005930', '000660', '005380', '015760', '035420', '012330', '051910', '055550', '105560', '032830'], kq: ['035720', '068270', '130960', '084990', '041960', '096530', '078340', '046890', '215600', '041510'] },
  2018: { ks: ['005930', '000660', '005380', '207940', '051910', '055550', '035420', '105560', '012330', '032830'], kq: ['068270', '091990', '215600', '130960', '084990', '263750', '253450', '086900', '096530', '035760'] },
  2019: { ks: ['005930', '000660', '207940', '051910', '068270', '005380', '012330', '055550', '105560', '035420'], kq: ['091990', '215600', '084990', '028300', '086900', '263750', '253450', '068760', '096530', '078340'] },
  2020: { ks: ['005930', '000660', '207940', '035420', '051910', '068270', '005380', '012330', '055550', '105560'], kq: ['091990', '028300', '084990', '263750', '253450', '086900', '068760', '096530', '196170', '278280'] },
  2021: { ks: ['005930', '000660', '051910', '207940', '035420', '005380', '035720', '068270', '006400', '012330'], kq: ['091990', '247540', '196170', '293490', '263750', '068760', '028300', '253450', '112040', '035900'] },
  2022: { ks: ['005930', '000660', '207940', '035420', '051910', '035720', '005380', '006400', '068270', '105560'], kq: ['091990', '247540', '086520', '196170', '293490', '263750', '035900', '112040', '253450', '068760'] },
  2023: { ks: ['005930', '373220', '000660', '207940', '005490', '005380', '051910', '035420', '000270', '012330'], kq: ['247540', '086520', '091990', '066970', '196170', '293490', '022100', '035900', '112040', '263750'] },
  2024: { ks: ['005930', '000660', '373220', '207940', '005380', '000270', '051910', '005490', '105560', '035420'], kq: ['086520', '247540', '066970', '022100', '196170', '028300', '293490', '058470', '348370', '263750'] },
  2025: { ks: ['005930', '000660', '373220', '207940', '005380', '068270', '000270', '105560', '035420', '051910'], kq: ['196170', '086520', '247540', '028300', '066970', '058470', '293490', '348370', '263750', '277810'] },
  2026: { ks: ['005930', '000660', '373220', '207940', '012450', '005380', '105560', '068270', '000270', '035420'], kq: ['196170', '086520', '247540', '277810', '028300', '058470', '066970', '293490', '263750', '348370'] },
}

// ============================================================================
// 스펙 조립 — spec-backtest.entry.ts baseSpec 사본 (승자 조건식 전용으로 축약)
// ============================================================================

const c = (id: string, cond: Condition): ConditionNode => ({ op: 'cond', id, cond })

/** 21차 1위 조건식 — MA10 × 신고20 → 60선 청산 · 이탈버퍼 2% */
export const WINNER = { ma: 10, hb: 20, xm: 60, buf: 2 } as const
export const WINNER_LABEL = `MA${WINNER.ma}×신고${WINNER.hb}→${WINNER.xm}선·버퍼${WINNER.buf}%`
export const MAX_POSITIONS = 10

/** 월 게이트용 합성 레짐 심볼 — 매매 대상이 아니다(엔진이 레짐 심볼을 유니버스에서 제외). */
export const MONTH_GATE = '__MONTHGATE__'

export function winnerSpec(symbols: string[], regimeSymbol: string | null): StrategySpec {
  return {
    version: SPEC_VERSION,
    id: 'idea-lab-winner',
    name: WINNER_LABEL,
    source: '21차 pit1010 1위 조건식',
    universe: {
      markets: ['KOSPI', 'KOSDAQ'],
      excludeAdministrative: true,
      excludeSuspended: true,
      excludeLiquidation: true,
      excludePreferred: true,
      excludeEtf: true,
      symbols,
    },
    entry: {
      op: 'and',
      nodes: [
        c(`${WINNER.ma}일선돌파`, { kind: 'maCross', period: WINNER.ma, dir: 'above' }),
        c(`${WINNER.hb}일신고가`, { kind: 'highBreak', days: WINNER.hb }),
      ],
    },
    ranking: { by: 'tradingValue', dir: 'desc' },
    exits: [{ kind: 'maBreak', maPeriod: WINNER.xm, pct: WINNER.buf }],
    sizing: { maxPositions: MAX_POSITIONS, mode: 'equalSlot' },
    execution: { timing: 'sameClose', orderType: 'market' },
    regime: regimeSymbol
      ? { symbol: regimeSymbol, entry: { op: 'and', nodes: [c('월필터', { kind: 'candle', bull: true })] } }
      : null,
  }
}

// ============================================================================
// 공용 유틸 — 달력·월별 수익·성과지표
// ============================================================================

export const monthOf = (date: string) => Number(date.slice(5, 7))
export const yearOf = (date: string) => Number(date.slice(0, 4))
export const ymOf = (date: string) => date.slice(0, 7)

export function calendarOf(histories: Record<string, DailyBar[]>): string[] {
  const set = new Set<string>()
  for (const bars of Object.values(histories)) for (const b of bars) set.add(b.date)
  return [...set].sort()
}

/**
 * 월 게이트용 합성 봉. 허용 월은 양봉(c>o), 금지 월은 음봉(c<o)으로 만들어
 * 엔진의 레짐 게이트(`{kind:'candle',bull:true}`)가 신규 진입만 막게 한다.
 * 보유 종목의 청산 규칙은 레짐과 무관하게 계속 동작한다(엔진 설계).
 * 각 봉의 값이 **그 날짜만으로** 결정되므로 미래참조가 원천적으로 불가능하다.
 */
export function monthGateBars(dates: string[], allowed: (date: string) => boolean): DailyBar[] {
  return dates.map((date) => {
    const ok = allowed(date)
    return { date, t: 0, o: 100, h: 101, l: 99, c: ok ? 101 : 99, v: 1 }
  })
}

/** 월별 수익비(종가 기준) — key `YYYY-MM`, value = 그 달 마지막종가/첫종가 */
export function monthlyRatios(bars: DailyBar[]): Map<string, number> {
  const first = new Map<string, number>()
  const last = new Map<string, number>()
  for (const b of bars) {
    const k = ymOf(b.date)
    if (!first.has(k)) first.set(k, b.c)
    last.set(k, b.c)
  }
  const out = new Map<string, number>()
  for (const [k, f] of first) {
    const l = last.get(k)!
    if (f > 0) out.set(k, l / f)
  }
  return out
}

export interface Perf {
  total: number // %
  cagr: number // %
  mdd: number // % (음수)
  obj: number | null // 총수익% ÷ |MDD%|
  years: number
}

export function perfOf(equity: { date: string; equity: number }[], from = '', to = '9999-12-31'): Perf {
  const win = equity.filter((e) => e.date >= from && e.date <= to)
  if (win.length < 2) return { total: 0, cagr: 0, mdd: 0, obj: null, years: 0 }
  const start = win[0].equity
  const end = win[win.length - 1].equity
  let peak = start
  let mdd = 0
  for (const e of win) {
    if (e.equity > peak) peak = e.equity
    else mdd = Math.min(mdd, (e.equity / peak - 1) * 100)
  }
  const years = Math.max(1 / 365, (Date.parse(win[win.length - 1].date) - Date.parse(win[0].date)) / (365.25 * 86400e3))
  const ratio = Math.max(end / start, 1e-9)
  const total = (ratio - 1) * 100
  const mddAbs = Math.abs(mdd)
  return { total, cagr: (Math.pow(ratio, 1 / years) - 1) * 100, mdd, obj: mddAbs > 0.01 ? total / mddAbs : null, years }
}

/** 이항 상측 꼬리 P(X ≥ k), X~Bin(n,p) — 다중검정 기대 위양성 계산용 */
export function binomTail(n: number, k: number, p = 0.5): number {
  if (k <= 0) return 1
  if (k > n) return 0
  let s = 0
  for (let i = k; i <= n; i++) {
    let ch = 1
    for (let j = 0; j < i; j++) ch = (ch * (n - j)) / (j + 1)
    s += ch * Math.pow(p, i) * Math.pow(1 - p, n - i)
  }
  return s
}

// ============================================================================
// PIT 연쇄 — spec-backtest.entry.ts pit1010() 사본 + 오버레이 훅
// ============================================================================

export interface YearSlice {
  y: number
  syms: string[]
  hist: Record<string, DailyBar[]>
  mapped: string
}

/** 연도별 유니버스·시계열 준비. 그 해 6월 30일 이전에 상장돼 있던 종목만 편입한다. */
export function buildYearly(histories: Record<string, DailyBar[]>, years: number[]): YearSlice[] {
  return years.map((y) => {
    const codes = [...(PIT1010[y]?.ks ?? []), ...(PIT1010[y]?.kq ?? [])]
    const syms = codes.filter((cd) => histories[cd] && (histories[cd][0]?.date ?? '9999') <= `${y}-06-30`)
    const end = `${y}-12-31`
    const hist: Record<string, DailyBar[]> = {}
    for (const s of syms) hist[s] = histories[s].filter((b) => b.date <= end)
    return { y, syms, hist, mapped: `${syms.length}/${codes.length}` }
  })
}

export interface Overlay {
  key: string
  label: string
  /** 그 해 신규 진입을 금지할 월 집합(1~12). **확장 윈도우로만** 산출할 것. */
  blockedMonths: (y: number) => Set<number>
  /** 그 해의 운용 구간. 구간 끝에서 전량 청산(근사)한다. */
  segments: (y: number) => { start: string; end: string }[]
}

const fullYearSegments = (y: number) => [{ start: `${y}-01-01`, end: `${y}-12-31` }]

/**
 * 구간 끝 청산 비용 근사. 엔진은 마지막 봉에서 미청산 포지션을 시가평가로 남기므로
 * 그대로 두면 "구간을 더 잘게 쪼갠 전략"이 매도비용을 면제받는 이득을 본다
 * (S2는 연 2회 청산, base는 연 1회). 투입비중 ≈ openAtEnd/maxPositions로 보고
 * 매도측 비용(수수료+거래세+슬리피지)을 차감한다. [추정] — 정확한 청산가가 아니다.
 */
export function liquidationHaircut(r: ConditionResult, cost: CostSettings, maxPositions: number): number {
  const frac = Math.min(1, Math.max(0, r.openAtEnd / Math.max(1, maxPositions)))
  return frac * ((cost.feePct + cost.taxPct + cost.slippagePct) / 100)
}

export interface ChainRes {
  equity: { date: string; equity: number }[] // 자본 배수(시작 1.0)
  perYear: { y: number; ret: number; mapped: string }[]
  trades: number
  totalNoHaircut: number // % — 청산 근사 비용 미적용(21차 대조용)
}

/**
 * 연도별 유니버스 교체 연쇄 실행. 각 해(그리고 오버레이가 나눈 각 구간)를 독립
 * 시뮬로 돌리고 자본을 이월해 자산곡선을 스티칭한다. 매핑 종목 5개 미만인 해는
 * 현금 보유로 간주한다(왜곡 방지).
 */
export function runOverlayChain(
  yearly: YearSlice[],
  overlay: Overlay,
  cost: CostSettings,
  applyHaircut = true,
): ChainRes {
  let factor = 1
  let factorNoHc = 1
  const equity: { date: string; equity: number }[] = []
  const perYear: { y: number; ret: number; mapped: string }[] = []
  let trades = 0

  for (const v of yearly) {
    const yearStart = factor
    if (v.syms.length < 5) {
      perYear.push({ y: v.y, ret: 1, mapped: v.mapped })
      continue
    }
    const blocked = overlay.blockedMonths(v.y)
    for (const seg of overlay.segments(v.y)) {
      const hist: Record<string, DailyBar[]> = {}
      for (const s of v.syms) hist[s] = v.hist[s].filter((b) => b.date <= seg.end)
      let spec = winnerSpec(v.syms, null)
      if (blocked.size > 0) {
        const dates = calendarOf(hist).filter((d) => d >= seg.start && d <= seg.end)
        if (dates.length === 0) continue
        hist[MONTH_GATE] = monthGateBars(dates, (d) => !blocked.has(monthOf(d)))
        spec = winnerSpec(v.syms, MONTH_GATE)
      }
      const r = runStrategySpec(hist, seg.start, spec, cost)
      trades += r.trades.length
      const base = factor
      for (const e of r.equity) equity.push({ date: e.date, equity: base * (e.equity / cost.initialCapital) })
      const finalEq = r.equity.length ? r.equity[r.equity.length - 1].equity : cost.initialCapital
      const segRet = finalEq / cost.initialCapital
      const hc = applyHaircut ? liquidationHaircut(r, cost, MAX_POSITIONS) : 0
      factor *= segRet * (1 - hc)
      factorNoHc *= segRet
    }
    perYear.push({ y: v.y, ret: factor / yearStart, mapped: v.mapped })
  }
  return { equity, perYear, trades, totalNoHaircut: (factorNoHc - 1) * 100 }
}

// ---- 오버레이 정의 ---------------------------------------------------------

export const OV_BASE: Overlay = {
  key: 'base',
  label: 'base (오버레이 없음)',
  blockedMonths: () => new Set(),
  segments: fullYearSegments,
}

const MAY_OCT = new Set([5, 6, 7, 8, 9, 10])

export const OV_S1: Overlay = {
  key: 'S1',
  label: 'S1 Sell in May (5~10월 신규 진입 금지)',
  blockedMonths: () => MAY_OCT,
  segments: fullYearSegments,
}

export const OV_S2: Overlay = {
  key: 'S2',
  label: 'S2 11~4월만 운용 (5~10월 진입 금지 + 4월 말 전량 청산)',
  blockedMonths: () => MAY_OCT,
  // 연 단위 유니버스 교체를 유지하면서 5~10월을 통째로 비운다.
  segments: (y) => [
    { start: `${y}-01-01`, end: `${y}-04-30` },
    { start: `${y}-11-01`, end: `${y}-12-31` },
  ],
}

/**
 * S3 동적 월 필터 — 매년 초, **직전 해까지의** 벤치 월별 평균 수익으로
 * 음(-)인 달을 그 해 진입 금지월로 지정한다. 표본 8년 미만이면 필터 없음.
 * 전체 구간 통계를 쓰지 않는다는 것이 이 실험의 핵심이다(규칙 1-5).
 */
export function blockedMonthsExpanding(
  benchMonthly: Map<string, number>,
  year: number,
  minYears = 8,
): Set<number> {
  const out = new Set<number>()
  for (let m = 1; m <= 12; m++) {
    const mm = String(m).padStart(2, '0')
    const rets: number[] = []
    for (const [k, ratio] of benchMonthly) {
      if (k.slice(5, 7) !== mm) continue
      if (Number(k.slice(0, 4)) >= year) continue // 그 해 1월 초 시점에는 알 수 없다
      rets.push(ratio - 1)
    }
    if (rets.length < minYears) continue
    const mean = rets.reduce((s, x) => s + x, 0) / rets.length
    if (mean < 0) out.add(m)
  }
  return out
}

export function makeOvS3(benchMonthly: Map<string, number>, minYears = 8): Overlay {
  const cache = new Map<number, Set<number>>()
  return {
    key: 'S3',
    label: `S3 동적 월 필터 (확장 윈도우 · 최소 표본 ${minYears}년)`,
    blockedMonths: (y) => {
      if (!cache.has(y)) cache.set(y, blockedMonthsExpanding(benchMonthly, y, minYears))
      return cache.get(y)!
    },
    segments: fullYearSegments,
  }
}

// ============================================================================
// MODE=seasonal
// ============================================================================

async function loadPitHistories(range = 'since:1999-01-01') {
  const years = Object.keys(PIT1010).map(Number).sort((a, b) => a - b)
  const union = new Set<string>()
  for (const y of years) for (const cd of [...PIT1010[y].ks, ...PIT1010[y].kq]) union.add(cd)
  const histories: Record<string, DailyBar[]> = {}
  let loadFail = 0
  for (const code of union) {
    const bars = await fetchKrDual(code, range)
    if (bars) histories[code] = bars
    else loadFail++
    await sleep(100)
  }
  const bench = await fetchDaily(BENCH, range)
  log(`시세 로드 ${Object.keys(histories).length}/${union.size} · 실패(상폐 등) ${loadFail}`)
  return { years, histories, bench }
}

function disclaimer(opts: { universe?: boolean; segmentExit?: boolean } = {}) {
  const { universe = true, segmentExit = true } = opts
  log('')
  log('---')
  if (universe) {
    log('⚠️ 유니버스 목록은 연초 시총 **[추정]**(KRX 실측 아님). 상폐·합병 종목은 가격 부재로 빠져')
    log('   특히 2000년대 초 구간이 실제보다 후하게 나온다(생존편향 · 상폐 가격편향).')
  }
  if (segmentExit) log('   구간 끝 청산은 시가평가 근사 + 매도비용 [추정] 차감이며 실제 청산가가 아니다.')
  log('⚠️ 이 수치는 시뮬레이션이며 **투자자문이 아니다.** 손실 경로는 MDD 열이 그 전략이 견뎌야 했던')
  log('   최대 하락이고, 무효화 지점은 "전·후반 중 한쪽이라도 벤치 대비 알파가 음수"다.')
  log('   과거 성적이 미래를 보장하지 않으며, 실제 체결·유동성·세제는 여기 가정과 다를 수 있다.')
}

/** 계절성 기술통계 표 — 월별 평균 수익·양(+)월 비율, 전·후반 분할 */
function seasonalTable(title: string, ratios: Map<string, number>[]) {
  const split = ymOf(HALF_SPLIT)
  const bucket = (m: number, half: 'all' | 'A' | 'B') => {
    const mm = String(m).padStart(2, '0')
    const out: number[] = []
    for (const r of ratios)
      for (const [k, v] of r) {
        if (k.slice(5, 7) !== mm) continue
        if (half === 'A' && k > split) continue
        if (half === 'B' && k <= split) continue
        out.push(v - 1)
      }
    return out
  }
  const cell = (xs: number[]) => {
    if (xs.length === 0) return '— | —'
    const mean = (xs.reduce((s, x) => s + x, 0) / xs.length) * 100
    const pos = (xs.filter((x) => x > 0).length / xs.length) * 100
    return `${f2(mean)}% | ${pos.toFixed(0)}%`
  }
  log('')
  log(`**${title}** (평균 월수익 | 양(+)월 비율, 표본 n)`)
  log('| 월 | 전체 평균 | 전체 +비율 | 전반(~2013-06) 평균 | 전반 +비율 | 후반(2013-07~) 평균 | 후반 +비율 | n(전체) |')
  log('|---|---|---|---|---|---|---|---|')
  for (let m = 1; m <= 12; m++) {
    const all = bucket(m, 'all')
    log(`| ${m}월 | ${cell(all)} | ${cell(bucket(m, 'A'))} | ${cell(bucket(m, 'B'))} | ${all.length} |`)
  }
}

function chainRow(label: string, r: ChainRes) {
  const full = perfOf(r.equity)
  const a = perfOf(r.equity, '', `${HALF_YEAR - 1}-12-31`)
  const b = perfOf(r.equity, `${HALF_YEAR}-01-01`)
  log(
    `| ${label} | ${f1(full.total)}% | ${f1(full.cagr)}% | ${f1(full.mdd)}% | ${full.obj?.toFixed(1) ?? '—'} | ${r.trades} | ` +
      `${f1(a.total)}% / ${f1(a.mdd)}% / ${a.obj?.toFixed(1) ?? '—'} | ${f1(b.total)}% / ${f1(b.mdd)}% / ${b.obj?.toFixed(1) ?? '—'} |`,
  )
}

async function seasonal() {
  log('# MODE=seasonal — 계절성 오버레이')
  log('')
  const { years, histories, bench } = await loadPitHistories()
  const benchMonthly = monthlyRatios(bench.filter((b) => b.date >= '2000-01-01'))
  const uniMonthly = Object.values(histories).map((bars) => monthlyRatios(bars.filter((b) => b.date >= '2000-01-01')))

  log('## 1) 기술통계 (보고용 — 전략 아님)')
  seasonalTable(`벤치 ${BENCH} 월별 수익`, [benchMonthly])
  seasonalTable('PIT 유니버스 종목 월별 수익 (종목×연 풀링)', uniMonthly)
  log('')
  log('※ 전·후반 값이 크게 다르면 그 계절성은 시대 안정성이 없다는 뜻이다 — 부호가 뒤집히는 달을')
  log('   전략으로 채택하면 안 된다.')

  log('')
  log('## 2) 전략 A/B — 승자 조건식 위 월 필터 오버레이')
  log(`조건식: **${WINNER_LABEL}** · 슬롯 ${MAX_POSITIONS} · 연도별 상위 10+10 [추정] 교체 유니버스`)
  const yearly = buildYearly(histories, years)
  log('')
  log(`연도별 매핑률: ${yearly.map((v) => `${v.y} ${v.mapped}`).join(' · ')}`)

  const overlays: Overlay[] = [OV_BASE, OV_S1, OV_S2, makeOvS3(benchMonthly)]
  const results = overlays.map((ov) => ({ ov, r: runOverlayChain(yearly, ov, COST) }))

  log('')
  log('| 전략 | 총수익 | CAGR | MDD | **수익÷MDD** | 매매 | 전반(2000~2013) 총/MDD/비 | 후반(2014~) 총/MDD/비 |')
  log('|---|---|---|---|---|---|---|---|')
  for (const { ov, r } of results) chainRow(ov.label, r)

  const base = results[0]
  log('')
  log(`base 총수익(청산비용 근사 미적용) = ${f1(base.r.totalNoHaircut)}% — 21차 pit1010 1위 수치와 대조용.`)
  log('(표의 base 총수익은 구간 끝 매도비용 [추정]을 뺀 값이라 21차보다 낮게 나오는 것이 정상이다.)')

  // S3가 실제로 어떤 달을 막았는지 — 필터가 해마다 흔들리면 그 자체가 불안정 신호다
  const s3 = overlays[3]
  log('')
  log('S3가 그 해 금지한 달 (확장 윈도우 판정):')
  log('| 연도 | 금지월 |')
  log('|---|---|')
  for (const y of years) {
    const b = [...s3.blockedMonths(y)].sort((a, z) => a - z)
    log(`| ${y} | ${b.length ? b.map((m) => `${m}월`).join(' ') : '(없음 — 표본 부족 또는 전월 양(+))'} |`)
  }

  log('')
  log('## 3) 연도별 수익 분해 (거짓 매끈함 방지)')
  log(`| 연도 | 매핑 | ${results.map((x) => x.ov.key).join(' | ')} | 벤치 |`)
  log(`|---|---|${results.map(() => '---').join('|')}|---|`)
  const benchRet = (y: number) => {
    const inYear = bench.filter((b) => b.date >= `${y}-01-01` && b.date <= `${y}-12-31`)
    return inYear.length >= 2 ? inYear[inYear.length - 1].c / inYear[0].c : 1
  }
  for (const [i, py] of base.r.perYear.entries()) {
    log(
      `| ${py.y} | ${py.mapped} | ${results.map((x) => f1((x.r.perYear[i].ret - 1) * 100) + '%').join(' | ')} | ${f1(
        (benchRet(py.y) - 1) * 100,
      )}% |`,
    )
  }

  log('')
  log('## 다중검정 경고')
  log('이 MODE는 월 필터 3종(S1·S2·S3)을 같은 데이터에 얹어 비교한다. 12개 달 중 "좋아 보이는" 달을')
  log('고르는 자유도까지 세면 실질 검정 횟수는 훨씬 크다. 귀무가설(계절성 없음)에서도 3종 중 하나가')
  log('base를 이길 확률은 상당히 높으므로, **전반·후반 두 구간 모두에서 base를 이긴 오버레이만**')
  log('패턴 후보로 읽는다. 한쪽만 이기면 우연으로 판정한다(21차 fullmar와 같은 판정 규칙).')
  disclaimer()
}

// ============================================================================
// MODE=monthpat — 종목×월 상승 패턴
// ============================================================================

export interface CellCriteria {
  minSample: number // 최소 표본 연수
  minHitRatio: number // 양(+)이었던 해 비율 하한
}
export const DEFAULT_CELLS: CellCriteria = { minSample: 8, minHitRatio: 0.65 }

export interface CellPick {
  symbol: string
  month: number
  n: number
  hits: number
  meanPct: number
}

/**
 * 그 해 1월 초 시점에 알 수 있는 정보만으로 (종목, 월) 셀을 고른다.
 * `year` 이후(같은 해 포함) 데이터는 절대 보지 않는다 — 확장 윈도우.
 */
export function selectMonthCells(
  monthlyBySymbol: Record<string, Map<string, number>>,
  year: number,
  crit: CellCriteria = DEFAULT_CELLS,
): CellPick[] {
  const out: CellPick[] = []
  for (const sym of Object.keys(monthlyBySymbol).sort()) {
    const mm = monthlyBySymbol[sym]
    for (let m = 1; m <= 12; m++) {
      const key = String(m).padStart(2, '0')
      const rets: number[] = []
      for (const [k, ratio] of mm) {
        if (k.slice(5, 7) !== key) continue
        if (Number(k.slice(0, 4)) >= year) continue
        rets.push(ratio - 1)
      }
      const n = rets.length
      if (n < crit.minSample) continue
      const hits = rets.filter((x) => x > 0).length
      const mean = rets.reduce((s, x) => s + x, 0) / n
      if (hits / n >= crit.minHitRatio && mean > 0) out.push({ symbol: sym, month: m, n, hits, meanPct: mean * 100 })
    }
  }
  return out
}

export interface MonthPatResult {
  equity: { date: string; equity: number }[]
  rebalances: number
  costPaid: number
}

/**
 * 셀에 걸린 (종목, 월)만 동일가중 보유하고 나머지는 현금.
 * 리밸런스는 각 월의 첫 거래일 **시가**에 한다. 그 달의 목표 집합은 그 해 1월 초에
 * 이미 확정돼 있으므로(확장 윈도우) 미래참조가 없다.
 */
export function simulateMonthPat(
  histories: Record<string, DailyBar[]>,
  cellsByYear: Map<number, CellPick[]>,
  cost: CostSettings,
  startDate: string,
): MonthPatResult {
  const calendar = calendarOf(histories).filter((d) => d >= startDate)
  const idx: Record<string, Map<string, number>> = {}
  for (const [s, bars] of Object.entries(histories)) {
    const m = new Map<string, number>()
    bars.forEach((b, i) => m.set(b.date, i))
    idx[s] = m
  }
  const buyPx = (p: number) => p * (1 + cost.slippagePct / 100)
  const sellPx = (p: number) => p * (1 - cost.slippagePct / 100)

  let cash = cost.initialCapital
  const holdings = new Map<string, number>() // symbol → qty
  const lastClose = new Map<string, number>()
  const equity: { date: string; equity: number }[] = []
  let rebalances = 0
  let costPaid = 0
  let curYm = ''

  for (const date of calendar) {
    const ym = ymOf(date)
    if (ym !== curYm) {
      curYm = ym
      // ---- 월 첫 거래일: 시가로 전량 청산 후 목표 집합 재편입 ----
      for (const [sym, qty] of holdings) {
        const bi = idx[sym].get(date)
        const px = bi != null ? histories[sym][bi].o : lastClose.get(sym)
        if (px == null) continue
        const gross = qty * sellPx(px)
        const fees = gross * ((cost.feePct + cost.taxPct) / 100)
        cash += gross - fees
        costPaid += fees + qty * px * (cost.slippagePct / 100)
        holdings.delete(sym)
      }
      const picks = (cellsByYear.get(yearOf(date)) ?? [])
        .filter((p) => p.month === monthOf(date))
        .map((p) => p.symbol)
        .filter((s) => idx[s]?.get(date) != null)
      if (picks.length > 0) {
        rebalances++
        const slot = cash / picks.length
        for (const sym of picks) {
          const bi = idx[sym].get(date)!
          const raw = histories[sym][bi].o
          const fill = buyPx(raw)
          const qty = Math.floor(slot / (fill * (1 + cost.feePct / 100)))
          if (qty <= 0) continue
          const gross = qty * fill
          const fee = gross * (cost.feePct / 100)
          cash -= gross + fee
          costPaid += fee + qty * raw * (cost.slippagePct / 100)
          holdings.set(sym, qty)
        }
      }
    }
    for (const sym of holdings.keys()) {
      const bi = idx[sym].get(date)
      if (bi != null) lastClose.set(sym, histories[sym][bi].c)
    }
    let mv = 0
    for (const [sym, qty] of holdings) mv += qty * (lastClose.get(sym) ?? 0)
    equity.push({ date, equity: cash + mv })
  }
  return { equity, rebalances, costPaid }
}

async function monthpat() {
  log('# MODE=monthpat — 종목별 월간 상승 패턴')
  log('')
  const { years, histories, bench } = await loadPitHistories()
  // 데이터 15년 이상 종목만
  const eligible: Record<string, DailyBar[]> = {}
  for (const [s, bars] of Object.entries(histories)) {
    if (bars.length < 2) continue
    const span = (Date.parse(bars[bars.length - 1].date) - Date.parse(bars[0].date)) / (365.25 * 86400e3)
    if (span >= 15) eligible[s] = bars
  }
  log(`대상: PIT 등장 종목 중 데이터 15년 이상 = ${Object.keys(eligible).length}개 / 로드 ${Object.keys(histories).length}개`)
  const monthlyBySymbol: Record<string, Map<string, number>> = {}
  for (const [s, bars] of Object.entries(eligible)) monthlyBySymbol[s] = monthlyRatios(bars)

  const cellsByYear = new Map<number, CellPick[]>()
  const meta: { y: number; cells: number; candidates: number; efp: number }[] = []
  for (const y of years) {
    const picks = selectMonthCells(monthlyBySymbol, y)
    cellsByYear.set(y, picks)
    // 기대 위양성: 그 해 판정 대상이 된 모든 (종목,월) 셀에 대해
    // 귀무(월수익 부호가 동전던지기)에서 "적중률 ≥65%"가 나올 확률의 합.
    let candidates = 0
    let efp = 0
    for (const s of Object.keys(monthlyBySymbol)) {
      for (let m = 1; m <= 12; m++) {
        const key = String(m).padStart(2, '0')
        let n = 0
        for (const k of monthlyBySymbol[s].keys())
          if (k.slice(5, 7) === key && Number(k.slice(0, 4)) < y) n++
        if (n < DEFAULT_CELLS.minSample) continue
        candidates++
        efp += binomTail(n, Math.ceil(DEFAULT_CELLS.minHitRatio * n), 0.5)
      }
    }
    meta.push({ y, cells: picks.length, candidates, efp })
  }

  const firstY = meta.find((m) => m.cells > 0)?.y ?? years[0]
  const sim = simulateMonthPat(eligible, cellsByYear, COST, `${firstY}-01-01`)
  const perf = perfOf(sim.equity)
  const perfA = perfOf(sim.equity, '', `${HALF_YEAR - 1}-12-31`)
  const perfB = perfOf(sim.equity, `${HALF_YEAR}-01-01`)

  // 벤치는 같은 구간 단순보유
  const benchEq = bench
    .filter((b) => b.date >= sim.equity[0]?.date)
    .map((b) => ({ date: b.date, equity: b.c }))
  const bPerf = perfOf(benchEq)
  const bA = perfOf(benchEq, '', `${HALF_YEAR - 1}-12-31`)
  const bB = perfOf(benchEq, `${HALF_YEAR}-01-01`)

  log('')
  log('## 성적 (셀 보유 전략 vs 벤치 단순보유)')
  log('| 전략 | 총수익 | CAGR | MDD | **수익÷MDD** | 리밸런스 | 누적비용 |')
  log('|---|---|---|---|---|---|---|')
  log(
    `| 월패턴 셀 보유 | ${f1(perf.total)}% | ${f1(perf.cagr)}% | ${f1(perf.mdd)}% | ${perf.obj?.toFixed(1) ?? '—'} | ${
      sim.rebalances
    } | ${Math.round(sim.costPaid).toLocaleString('ko-KR')}원 |`,
  )
  log(
    `| 벤치 ${BENCH} 단순보유 | ${f1(bPerf.total)}% | ${f1(bPerf.cagr)}% | ${f1(bPerf.mdd)}% | ${
      bPerf.obj?.toFixed(1) ?? '—'
    } | — | — |`,
  )
  log('')
  log('| 구간 | 전략 총수익 | 전략 MDD | 벤치 총수익 | 알파(CAGR) |')
  log('|---|---|---|---|---|')
  log(`| 전반 ~${HALF_YEAR - 1} | ${f1(perfA.total)}% | ${f1(perfA.mdd)}% | ${f1(bA.total)}% | ${f1(perfA.cagr - bA.cagr)}%p |`)
  log(`| 후반 ${HALF_YEAR}~ | ${f1(perfB.total)}% | ${f1(perfB.mdd)}% | ${f1(bB.total)}% | ${f1(perfB.cagr - bB.cagr)}%p |`)

  log('')
  log('## 선정 셀 수 추이 · 다중검정 규모')
  log('| 연도 | 판정 대상 셀 | 선정 셀 | **기대 위양성** | 선정÷기대 |')
  log('|---|---|---|---|---|')
  for (const m of meta)
    log(`| ${m.y} | ${m.candidates} | ${m.cells} | ${m.efp.toFixed(1)} | ${m.efp > 0 ? (m.cells / m.efp).toFixed(2) : '—'} |`)
  log('')
  log('**해석 규칙**: "기대 위양성"은 월수익 부호가 동전던지기(귀무가설)일 때도 "적중률 ≥65% & 표본 ≥8년"')
  log('조건을 통과했을 셀 수의 기댓값이다(이항 상측 꼬리 합). **선정÷기대 비율이 1에 가까우면 선정된 셀은**')
  log('**전부 우연으로 설명된다** — 그 해의 패턴은 없다고 읽어야 한다. 이 실험은 종목×12월이라 검정 횟수가')
  log('구조적으로 크고, 그래서 위양성이 크다. 비율이 2~3배 이상이고 전·후반 모두 알파가 양(+)일 때만')
  log('후보로 남긴다.')
  disclaimer({ segmentExit: false })
}

// ============================================================================
// MODE=pairprem — 삼성전자 / 삼성전자우 괴리 스위칭
// ============================================================================

export const SEC_COMMON = '005930.KS'
export const SEC_PREF = '005935.KS'

export interface PairBar {
  date: string
  oC: number
  cC: number
  oP: number
  cP: number
}

export function alignPair(common: DailyBar[], pref: DailyBar[]): PairBar[] {
  const p = new Map(pref.map((b) => [b.date, b]))
  const out: PairBar[] = []
  for (const b of common) {
    const q = p.get(b.date)
    if (!q) continue
    if (!(b.c > 0) || !(q.c > 0) || !(b.o > 0) || !(q.o > 0)) continue
    out.push({ date: b.date, oC: b.o, cC: b.c, oP: q.o, cP: q.c })
  }
  return out
}

/** 괴리율 d_t = 1 − 우선주가/보통주가 (총수익 보정 종가 기준) */
export const discountOf = (b: PairBar) => 1 - b.cP / b.cC

/**
 * 확장 윈도우 z-score. i 시점 값은 d[0..i]의 평균·표본표준편차만 쓴다.
 * 워밍업 미달이면 null(신호 없음). 전체 구간 통계 금지(규칙 1-5) 준수.
 */
export function expandingZ(d: number[], warmup: number): (number | null)[] {
  const out: (number | null)[] = []
  let sum = 0
  let sumSq = 0
  for (let i = 0; i < d.length; i++) {
    sum += d[i]
    sumSq += d[i] * d[i]
    const n = i + 1
    if (n < warmup) {
      out.push(null)
      continue
    }
    const mean = sum / n
    const varr = Math.max(0, (sumSq - n * mean * mean) / (n - 1))
    const sd = Math.sqrt(varr)
    out.push(sd > 1e-12 ? (d[i] - mean) / sd : null)
  }
  return out
}

export interface SwitchEvent {
  date: string
  from: 'common' | 'pref'
  to: 'common' | 'pref'
  price: number // 체결에 쓴 원 시가(비용 적용 전) — 신호 다음날 시가
  signalDate: string
}

export interface PairResult {
  equity: { date: string; equity: number }[]
  switches: SwitchEvent[]
  costPaid: number
}

/**
 * 롱온리 스위칭. 기본 보통주 100% 보유 → z > enterZ면 우선주로 전량 스위칭 →
 * z < exitZ면 보통주 복귀. 신호는 당일 **종가**로 판정하고 체결은 **다음 거래일 시가**
 * (규칙 1-2). 마지막 봉에서는 신호를 만들지 않는다(규칙 1-6).
 */
export function simulatePairSwitch(
  bars: PairBar[],
  z: (number | null)[],
  enterZ: number,
  exitZ: number,
  cost: CostSettings,
): PairResult {
  const buyPx = (p: number) => p * (1 + cost.slippagePct / 100)
  const sellPx = (p: number) => p * (1 - cost.slippagePct / 100)
  const equity: { date: string; equity: number }[] = []
  const switches: SwitchEvent[] = []
  let costPaid = 0
  if (bars.length === 0) return { equity, switches, costPaid }

  // 0일차 시가에 보통주 매수(비교군과 동일 조건)
  let side: 'common' | 'pref' = 'common'
  const fill0 = buyPx(bars[0].oC)
  let qty = cost.initialCapital / (fill0 * (1 + cost.feePct / 100))
  let cash = 0
  costPaid += qty * fill0 * (cost.feePct / 100) + qty * bars[0].oC * (cost.slippagePct / 100)
  let pending: 'common' | 'pref' | null = null
  let pendingSignalDate = ''

  for (let i = 0; i < bars.length; i++) {
    const b = bars[i]
    // 1) 전일 종가 신호 → 오늘 시가 체결
    if (pending && pending !== side) {
      const outRaw = side === 'common' ? b.oC : b.oP
      const inRaw = pending === 'common' ? b.oC : b.oP
      const gross = qty * sellPx(outRaw)
      const fees = gross * ((cost.feePct + cost.taxPct) / 100)
      cash = gross - fees
      costPaid += fees + qty * outRaw * (cost.slippagePct / 100)
      const fill = buyPx(inRaw)
      const newQty = cash / (fill * (1 + cost.feePct / 100))
      costPaid += newQty * fill * (cost.feePct / 100) + newQty * inRaw * (cost.slippagePct / 100)
      switches.push({ date: b.date, from: side, to: pending, price: inRaw, signalDate: pendingSignalDate })
      side = pending
      qty = newQty
      cash = 0
    }
    pending = null

    // 2) 오늘 종가로 마킹
    equity.push({ date: b.date, equity: cash + qty * (side === 'common' ? b.cC : b.cP) })

    // 3) 오늘 종가로 내일 신호 (마지막 봉이면 만들지 않는다)
    if (i === bars.length - 1) continue
    const zi = z[i]
    if (zi == null) continue
    if (side === 'common' && zi > enterZ) {
      pending = 'pref'
      pendingSignalDate = b.date
    } else if (side === 'pref' && zi < exitZ) {
      pending = 'common'
      pendingSignalDate = b.date
    }
  }
  return { equity, switches, costPaid }
}

/** 단순보유 비교군 — 0일차 시가 매수 후 종가 마킹 */
export function buyHold(bars: PairBar[], which: 'common' | 'pref', cost: CostSettings) {
  const raw = which === 'common' ? bars[0]?.oC : bars[0]?.oP
  if (raw == null) return [] as { date: string; equity: number }[]
  const fill = raw * (1 + cost.slippagePct / 100)
  const qty = cost.initialCapital / (fill * (1 + cost.feePct / 100))
  return bars.map((b) => ({ date: b.date, equity: qty * (which === 'common' ? b.cC : b.cP) }))
}

/** 50:50 연 1회 리밸런스 — 매년 첫 거래일 시가에 반반으로 맞춘다 */
export function halfHalfAnnual(bars: PairBar[], cost: CostSettings) {
  const buyPx = (p: number) => p * (1 + cost.slippagePct / 100)
  const sellPx = (p: number) => p * (1 - cost.slippagePct / 100)
  let qc = 0
  let qp = 0
  let curYear = -1
  const out: { date: string; equity: number }[] = []
  for (const b of bars) {
    const y = yearOf(b.date)
    if (y !== curYear) {
      curYear = y
      const gross = qc * sellPx(b.oC) + qp * sellPx(b.oP)
      const proceeds = qc + qp > 0 ? gross * (1 - (cost.feePct + cost.taxPct) / 100) : cost.initialCapital
      const half = proceeds / 2
      qc = half / (buyPx(b.oC) * (1 + cost.feePct / 100))
      qp = half / (buyPx(b.oP) * (1 + cost.feePct / 100))
    }
    out.push({ date: b.date, equity: qc * b.cC + qp * b.cP })
  }
  return out
}

/** ≈2년 워밍업 (국내 연 246거래일 기준) */
export const PAIR_WARMUP = 480

async function pairprem() {
  log('# MODE=pairprem — 삼성전자 / 삼성전자우 괴리 스위칭 (롱온리 · 공매도 없음)')
  log('')
  const common = await fetchDaily(SEC_COMMON, 'since:1999-01-01')
  await sleep(150)
  const pref = await fetchDaily(SEC_PREF, 'since:1999-01-01')
  const bars = alignPair(common, pref).filter((b) => b.date >= '2000-01-01')
  if (bars.length < PAIR_WARMUP + 50) {
    log(`❌ 정렬 봉 ${bars.length}개 — 워밍업(${PAIR_WARMUP})에 못 미쳐 중단`)
    return
  }
  log(`정렬 봉 ${bars.length}개 · ${bars[0].date} ~ ${bars[bars.length - 1].date}`)
  const d = bars.map(discountOf)
  const z = expandingZ(d, PAIR_WARMUP)
  const firstSignal = bars[z.findIndex((v) => v != null)]?.date ?? '—'
  log(`괴리율 d = 1 − 우선주/보통주 · 확장 윈도우 z(워밍업 ${PAIR_WARMUP}봉 ≈ 2년) · 첫 신호 가능일 ${firstSignal}`)
  log(`현재 괴리율 ${(d[d.length - 1] * 100).toFixed(1)}% · z ${z[z.length - 1]?.toFixed(2) ?? '—'} [관찰치이며 매수·매도 권유가 아니다]`)

  const rowOf = (label: string, eq: { date: string; equity: number }[], sw: number | null, cp: number | null) => {
    const p = perfOf(eq)
    const a = perfOf(eq, '', `${HALF_YEAR - 1}-12-31`)
    const b = perfOf(eq, `${HALF_YEAR}-01-01`)
    log(
      `| ${label} | ${f1(p.total)}% | ${f1(p.cagr)}% | ${f1(p.mdd)}% | ${p.obj?.toFixed(1) ?? '—'} | ${sw ?? '—'} | ${
        cp == null ? '—' : Math.round(cp).toLocaleString('ko-KR') + '원'
      } | ${f1(a.total)}% / ${f1(a.mdd)}% | ${f1(b.total)}% / ${f1(b.mdd)}% |`,
    )
  }

  log('')
  log('## 본 전략 (z > +1.5 → 우선주 / z < 0 → 보통주 복귀)')
  log('| 전략 | 총수익 | CAGR | MDD | **수익÷MDD** | 스위칭 | 누적비용 | 전반 총/MDD | 후반 총/MDD |')
  log('|---|---|---|---|---|---|---|---|---|')
  const main15 = simulatePairSwitch(bars, z, 1.5, 0, COST)
  rowOf('괴리 스위칭 z>1.5', main15.equity, main15.switches.length, main15.costPaid)
  rowOf('보통주 단순보유', buyHold(bars, 'common', COST), null, null)
  rowOf('우선주 단순보유', buyHold(bars, 'pref', COST), null, null)
  rowOf('50:50 연1회 리밸런스', halfHalfAnnual(bars, COST), null, null)

  log('')
  log('## 임계값 민감도 (복귀 임계 z<0 고정)')
  log('| 진입 z | 총수익 | CAGR | MDD | **수익÷MDD** | 스위칭 | 누적비용 | 전반 총/MDD | 후반 총/MDD |')
  log('|---|---|---|---|---|---|---|---|---|')
  for (const thr of [1.0, 1.5, 2.0]) {
    const r = simulatePairSwitch(bars, z, thr, 0, COST)
    rowOf(`z > +${thr.toFixed(1)}`, r.equity, r.switches.length, r.costPaid)
  }

  log('')
  log('## 스위칭 이력 (최근 20회)')
  log('| 신호일(종가 판정) | 체결일(익일 시가) | 방향 | 체결 기준가 |')
  log('|---|---|---|---|')
  for (const s of main15.switches.slice(-20))
    log(`| ${s.signalDate} | ${s.date} | ${s.from} → ${s.to} | ${Math.round(s.price).toLocaleString('ko-KR')} |`)

  log('')
  log('## 다중검정 경고')
  log('진입 임계값을 3개(1.0/1.5/2.0) 돌려 비교했다. 셋 중 최고를 골라 읽으면 그 자체가 곡선맞춤이다.')
  log('세 임계값 모두에서, 그리고 전·후반 모두에서 비교군(보통주 단순보유)을 이길 때만 패턴으로 읽는다.')
  log('한 임계값에서만 이기면 우연으로 판정한다.')
  log('')
  log('※ 구조적 한계: 우선주는 유동성이 낮아 실제 체결이 시가로 되지 않을 수 있고(슬리피지 과소평가),')
  log('   괴리율은 배당락·지배구조 이슈 등 회귀하지 않는 이유로도 벌어진다 — z 회귀 가정은 보장되지 않는다.')
  disclaimer({ universe: false, segmentExit: false })
}

// ============================================================================
// MODE=flow — 투자자 순매수(수급) 조건 A/B
// ============================================================================
//
// 데이터: public/data/flows/<code>.json (scripts/kiwoom-flow-backfill.mjs가 ka10059로
//         적재한 캐시). 이 모드는 **네트워크로 수급을 받지 않는다** — 캐시만 읽는다.
//
// ⚠️ T−1 원칙(규칙 1) — 이 모드의 존폐가 걸린 지점:
//   D일 종가에 매수를 판단한다. 그런데 D일의 투자자별 순매수는 **장 마감 후**에
//   확정된다. 따라서 D일 판단에 D일 수급을 쓰면 "오늘 결과를 보고 오늘 샀다"가 된다.
//   수급에 접근하는 경로를 `makeFlowLens(...).before(sym, date, k)` **하나로 좁히고**,
//   그 함수가 `dt < D`만 반환하도록 강제한다. 시뮬 루프는 이 렌즈 밖으로 수급을
//   읽지 않는다. 집행자는 tests/idealab.test.ts의 "D일 수급을 바꿔도 D일 판정 불변" 케이스.
//
// 결측 처리(보수적): 필요한 창(N일)이 캐시에 없으면 **필터를 통과하지 못한 것**으로
//   본다(유리한 쪽으로 가정하지 않는다 — 규칙 1-4의 정신). 랭킹 키를 못 구하면 최하위로
//   민다. 결측이 성적을 만든 게 아닌지 볼 수 있도록 결측 비율을 표에 함께 찍는다.

export const FLOW_START_YEAR = 2010 // 수급 이력 소급 한계(ka10059 실측)
export const FLOW_HALF_YEAR = 2018 // 전·후반 분할 — 2010 시작이라 중간점

export interface FlowRow {
  /** 'YYYYMMDD' */
  dt: string
  /** 개인 순매수 수량(단주, 부호 유지) */
  indNet: number
  /** 외국인 순매수 수량(단주, 부호 유지) */
  frgnNet: number
  /** 기관합 순매수 수량(단주, 부호 유지) */
  orgnNet: number
  /** 그 날 누적 거래대금(원, 무보정) */
  accTrdePrica: number
  /** 그 날 종가(원, 무보정) — 순매수 수량을 금액으로 바꿀 때만 쓴다 */
  curPrc: number
}

/** 종목 코드 → 날짜 오름차순 수급 행 */
export type FlowStore = Record<string, FlowRow[]>

/** 'YYYY-MM-DD' → 'YYYYMMDD' (이미 8자리면 그대로) */
export function toDt(date: string): string {
  return /^\d{8}$/.test(date) ? date : date.slice(0, 4) + date.slice(5, 7) + date.slice(8, 10)
}

export interface FlowLens {
  /**
   * 결정일 `date` **직전**까지 확정된 수급 행을 최대 k개, 과거→최근 순으로 반환한다.
   * `dt < date`만 본다 — 이것이 T−1 원칙의 유일한 집행 지점이다.
   */
  before(sym: string, date: string, k: number): FlowRow[]
  has(sym: string): boolean
}

export function makeFlowLens(store: FlowStore): FlowLens {
  const dtsOf: Record<string, string[]> = {}
  for (const [sym, rows] of Object.entries(store)) dtsOf[sym] = rows.map((r) => r.dt)
  return {
    has: (sym) => (store[sym]?.length ?? 0) > 0,
    before(sym, date, k) {
      const rows = store[sym]
      if (!rows?.length || k <= 0) return []
      const cut = toDt(date)
      // 이분 탐색: dt >= cut 인 첫 인덱스 → 쓸 수 있는 행은 [0, lo)
      const dts = dtsOf[sym]
      let lo = 0
      let hi = dts.length
      while (lo < hi) {
        const mid = (lo + hi) >> 1
        if (dts[mid] < cut) lo = mid + 1
        else hi = mid
      }
      return rows.slice(Math.max(0, lo - k), lo)
    },
  }
}

/** 수급 가설 한 개. admits=진입 자격 필터, rankKey=슬롯 초과 시 우선순위(내림차순). */
export interface FlowVariant {
  key: string
  label: string
  /** 진입 후보 자격. `null` = 수급 데이터 부족 → 보수적으로 불통과 처리된다. */
  admits?: (lens: FlowLens, sym: string, date: string) => boolean | null
  /** 랭킹 키(클수록 우선). `null` = 데이터 부족 → 최하위. 없으면 기본 거래대금 랭킹. */
  rankKey?: (lens: FlowLens, sym: string, date: string) => number | null
}

export const FLOW_BASE: FlowVariant = { key: 'base', label: `base ${WINNER_LABEL} · 거래대금 랭킹 (수급 조건 없음)` }

/** F1 — 직전 N영업일 외국인 순매수가 **연속 양(+)**인 종목만 진입 후보로 인정 */
export function flowF1(n: number): FlowVariant {
  return {
    key: `F1-${n}`,
    label: `F1 외국인 ${n}영업일 연속 순매수(+) 필터`,
    admits: (lens, sym, date) => {
      const w = lens.before(sym, date, n)
      if (w.length < n) return null // 창이 안 차면 판정 불가 → 보수적 탈락
      return w.every((r) => r.frgnNet > 0)
    },
  }
}

/**
 * F2 — 슬롯 초과 시 거래대금 대신 **수급강도** 순으로 고른다.
 * 강도 = Σ직전5영업일 (외국인+기관) 순매수량×그날 종가  ÷  Σ직전5영업일 거래대금.
 * 합계÷합계로 잡는다(일별 비율의 평균이 아니라) — 거래대금이 유난히 작은 하루가
 * 비율을 폭발시키는 것을 막기 위해서다. 분자·분모 모두 **무보정 원본**이라 배당·분할
 * 보정 계수가 종목마다 다르게 섞이지 않는다(그래서 백필러가 curPrc를 함께 저장한다).
 */
export const FLOW_F2: FlowVariant = {
  key: 'F2',
  label: 'F2 수급강도 랭킹 (직전 5영업일 외국인+기관 순매수대금 ÷ 거래대금)',
  rankKey: (lens, sym, date) => {
    const w = lens.before(sym, date, 5)
    if (w.length < 5) return null
    let net = 0
    let val = 0
    for (const r of w) {
      net += (r.frgnNet + r.orgnNet) * r.curPrc
      val += r.accTrdePrica
    }
    return val > 0 ? net / val : null
  },
}

/** F3 — 진입일 기준 **직전 영업일**에 외국인·기관이 모두 순매수(+)였던 종목만 */
export const FLOW_F3: FlowVariant = {
  key: 'F3',
  label: 'F3 직전 영업일 외국인·기관 동반 순매수(+) 필터',
  admits: (lens, sym, date) => {
    const w = lens.before(sym, date, 1)
    if (w.length < 1) return null
    return w[0].frgnNet > 0 && w[0].orgnNet > 0
  },
}

/**
 * 승자 조건식(MA10 상향돌파 × 20일 신고가) 진입 판정.
 * 엔진(evaluateEntry)이 쓰는 `sma`·`priorHigh` **같은 함수**를 부른다 — 지표를 다시
 * 구현하면 base 재현이 조용히 갈라진다. priorHigh는 당일을 제외한 직전 N일이다(규칙 1-3).
 */
export function flowEntryPassed(bars: DailyBar[], i: number): boolean {
  if (i < 1) return false
  const now = sma(bars, i, WINNER.ma)
  const prev = sma(bars, i - 1, WINNER.ma)
  if (now == null || prev == null) return false
  if (!(bars[i].c > now && bars[i - 1].c <= prev)) return false
  const h = priorHigh(bars, i, WINNER.hb)
  return h != null && bars[i].c > h
}

export interface FlowSimResult {
  equity: { date: string; equity: number }[]
  trades: number
  openAtEnd: number
  /** 수급 판정을 시도한 횟수(결측 비율의 분모) */
  evaluated: number
  /** 데이터 부족으로 진입 후보에서 보수적으로 탈락시킨 횟수 */
  missingAdmit: number
  /** 랭킹 키를 못 구해 최하위로 민 횟수 */
  missingRank: number
}

/**
 * 한 해치 bespoke 시뮬 — `runStrategySpec`의 승자 스펙 경로(진입 sameClose·청산
 * maBreak60 버퍼2%·거래대금 랭킹·equalSlot)를 그대로 옮긴 것이다. 엔진 코어를 고치지
 * 않고 수급 필터를 끼우기 위해 복제했으므로, **필터를 끄면 엔진과 완전히 같아야 한다**
 * (tests/idealab.test.ts가 자산곡선 전 점 일치를 강제한다 — 갈라지면 구현 버그).
 */
export function simulateFlowYear(
  histories: Record<string, DailyBar[]>,
  startDate: string,
  symbols: string[],
  cost: CostSettings,
  variant: FlowVariant,
  lens: FlowLens,
  maxPositions = MAX_POSITIONS,
): FlowSimResult {
  const universe = [...new Set(symbols)].filter((s) => histories[s]?.length).sort()
  const scoped: Record<string, DailyBar[]> = {}
  for (const s of universe) scoped[s] = histories[s]
  const calendar = calendarOf(scoped).filter((d) => d >= startDate)

  const idxOf: Record<string, Map<string, number>> = {}
  for (const s of universe) {
    const m = new Map<string, number>()
    histories[s].forEach((b, i) => m.set(b.date, i))
    idxOf[s] = m
  }

  const buyCost = (px: number) => px * (1 + cost.slippagePct / 100)
  const sellCost = (px: number) => px * (1 - cost.slippagePct / 100)

  interface Pos {
    entryPrice: number
    qty: number
    entryIdx: number
    peak: number
    lastClose: number
  }
  const positions = new Map<string, Pos>()
  let cash = cost.initialCapital
  const equity: { date: string; equity: number }[] = []
  let trades = 0
  let evaluated = 0
  let missingAdmit = 0
  let missingRank = 0

  for (let d = 0; d < calendar.length; d++) {
    const date = calendar[d]
    const isLast = d === calendar.length - 1

    // ---- 1) 청산 판정 — 전일 종가가 MA60×(1−2%) 아래면 오늘 시가 청산 -------
    for (const [sym, pos] of [...positions]) {
      const bi = idxOf[sym].get(date)
      if (bi == null) continue
      const bars = histories[sym]
      const bar = bars[bi]
      if (bar.h > pos.peak) pos.peak = bar.h
      if (d === pos.entryIdx) continue // 진입 당일은 평가하지 않는다(엔진과 동일)
      const pi = idxOf[sym].get(calendar[d - 1])
      if (pi == null) continue
      const ma = sma(bars, pi, WINNER.xm)
      if (ma == null) continue
      if (bars[pi].c < ma * (1 - WINNER.buf / 100)) {
        const fill = sellCost(bar.o)
        const gross = pos.qty * fill
        cash += gross - gross * (cost.feePct / 100) - gross * (cost.taxPct / 100)
        positions.delete(sym)
        trades++
      }
    }

    // ---- 2) 오늘 종가로 진입 (LOC · sameClose) -----------------------------
    // 마지막 봉에서도 sameClose는 체결 가능하지만, 엔진이 규칙 1-6으로 막고 있으므로
    // 동일하게 막는다(그래야 base가 재현된다).
    if (!isLast && positions.size < maxPositions) {
      const rows: { sym: string; bi: number; passed: boolean; key: number }[] = []
      for (const sym of universe) {
        const bi = idxOf[sym].get(date)
        if (bi == null) continue
        const bars = histories[sym]
        const b = bars[bi]
        let passed = flowEntryPassed(bars, bi)
        if (passed && variant.admits) {
          evaluated++
          const a = variant.admits(lens, sym, date)
          if (a == null) {
            missingAdmit++
            passed = false
          } else passed = a
        }
        let key = b.c * b.v
        if (variant.rankKey) {
          evaluated++
          const k = variant.rankKey(lens, sym, date)
          if (k == null) {
            missingRank++
            key = -Infinity
          } else key = k
        }
        rows.push({ sym, bi, passed, key })
      }
      // 엔진과 같은 비교자·같은 초기 순서(정렬된 심볼) — 동점은 심볼 오름차순으로 남는다
      const ranked = [...rows].sort((a, b) => (a.key === b.key ? 0 : (a.key - b.key) * -1))
      const picks = ranked.filter((r) => r.passed && !positions.has(r.sym)).slice(0, maxPositions - positions.size)
      for (const r of picks) {
        if (positions.size >= maxPositions) break
        const px = histories[r.sym][r.bi].c
        const slot = cash / Math.max(1, maxPositions - positions.size)
        const fill = buyCost(px)
        const qty = Math.floor(slot / (fill * (1 + cost.feePct / 100)))
        if (qty <= 0) continue
        const gross = qty * fill
        cash -= gross + gross * (cost.feePct / 100)
        positions.set(r.sym, { entryPrice: fill, qty, entryIdx: d, peak: px, lastClose: px })
      }
    }

    // ---- 3) 자산 평가 — 봉 없는 날은 마지막 관측 종가 이월 -------------------
    let holdings = 0
    for (const [sym, pos] of positions) {
      const bi = idxOf[sym].get(date)
      if (bi != null) pos.lastClose = histories[sym][bi].c
      holdings += pos.qty * pos.lastClose
    }
    equity.push({ date, equity: cash + holdings })
  }

  return { equity, trades, openAtEnd: positions.size, evaluated, missingAdmit, missingRank }
}

export interface FlowChainRes {
  equity: { date: string; equity: number }[]
  perYear: { y: number; ret: number; mapped: string }[]
  trades: number
  evaluated: number
  missingAdmit: number
  missingRank: number
}

/**
 * 연도별 유니버스 교체 연쇄 — `runOverlayChain(…, OV_BASE, …)`과 같은 이월·청산비용
 * 근사를 쓴다(그래야 base 대조가 성립한다). 매핑 5종목 미만인 해는 현금 보유.
 */
export function runFlowChain(
  yearly: YearSlice[],
  variant: FlowVariant,
  lens: FlowLens,
  cost: CostSettings,
  applyHaircut = true,
): FlowChainRes {
  let factor = 1
  const equity: { date: string; equity: number }[] = []
  const perYear: { y: number; ret: number; mapped: string }[] = []
  let trades = 0
  let evaluated = 0
  let missingAdmit = 0
  let missingRank = 0

  for (const v of yearly) {
    const yearStart = factor
    if (v.syms.length < 5) {
      perYear.push({ y: v.y, ret: 1, mapped: v.mapped })
      continue
    }
    const r = simulateFlowYear(v.hist, `${v.y}-01-01`, v.syms, cost, variant, lens)
    trades += r.trades
    evaluated += r.evaluated
    missingAdmit += r.missingAdmit
    missingRank += r.missingRank
    const base = factor
    for (const e of r.equity) equity.push({ date: e.date, equity: base * (e.equity / cost.initialCapital) })
    const finalEq = r.equity.length ? r.equity[r.equity.length - 1].equity : cost.initialCapital
    const segRet = finalEq / cost.initialCapital
    const frac = applyHaircut ? Math.min(1, Math.max(0, r.openAtEnd / Math.max(1, MAX_POSITIONS))) : 0
    const hc = frac * ((cost.feePct + cost.taxPct + cost.slippagePct) / 100)
    factor *= segRet * (1 - hc)
    perYear.push({ y: v.y, ret: factor / yearStart, mapped: v.mapped })
  }
  return { equity, perYear, trades, evaluated, missingAdmit, missingRank }
}

// ---- 캐시 로더 (네트워크 없음) ----------------------------------------------

export interface FlowCacheInfo {
  store: FlowStore
  files: number
  rows: number
  oldest: string
  newest: string
  incomplete: string[]
}

/** public/data/flows/*.json 을 읽어 FlowStore로. 파일이 없으면 빈 스토어. */
export function loadFlowCache(dir: string): FlowCacheInfo {
  const store: FlowStore = {}
  const incomplete: string[] = []
  let rows = 0
  let oldest = ''
  let newest = ''
  let names: string[] = []
  try {
    names = readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'index.json')
  } catch {
    return { store, files: 0, rows: 0, oldest: '', newest: '', incomplete }
  }
  for (const n of names.sort()) {
    let j: { code?: string; rows?: FlowRow[]; meta?: { complete?: boolean } }
    try {
      j = JSON.parse(readFileSync(join(dir, n), 'utf8'))
    } catch {
      continue
    }
    const code = String(j.code ?? n.replace(/\.json$/, ''))
    const rs = (j.rows ?? []).filter((r) => r && typeof r.dt === 'string')
    if (!rs.length) continue
    // 저장 시 오름차순이지만 방어적으로 다시 정렬한다(정렬 가정이 렌즈의 이분 탐색 전제)
    rs.sort((a, b) => (a.dt < b.dt ? -1 : a.dt > b.dt ? 1 : 0))
    store[code] = rs
    rows += rs.length
    if (!oldest || rs[0].dt < oldest) oldest = rs[0].dt
    if (!newest || rs[rs.length - 1].dt > newest) newest = rs[rs.length - 1].dt
    if (j.meta?.complete === false) incomplete.push(code)
  }
  return { store, files: Object.keys(store).length, rows, oldest, newest, incomplete }
}

async function flow() {
  log('# MODE=flow — 투자자 순매수(수급) 조건 A/B')
  log('')
  const dir = join(process.env.REPO_ROOT ?? process.cwd(), 'public', 'data', 'flows')
  const cache = loadFlowCache(dir)
  if (cache.files === 0) {
    log(`❌ 수급 캐시가 비어 있다 (${dir})`)
    log('   먼저 EC2/러너에서 `node scripts/kiwoom-flow-backfill.mjs`를 돌려 ka10059 이력을 적재한다.')
    log('   (컨테이너는 키움 접속이 막혀 있어 여기서 받을 수 없다.)')
    return
  }
  log(
    `수급 캐시: ${cache.files}종목 · ${cache.rows.toLocaleString('ko-KR')}행 · ${cache.oldest} ~ ${cache.newest}` +
      (cache.incomplete.length ? ` · ⚠️ 소급 미완 ${cache.incomplete.length}종목(재실행 필요)` : ''),
  )
  const lens = makeFlowLens(cache.store)

  // 지표 워밍업(MA60)을 위해 시작 2년 전부터 시세를 받는다
  const { years, histories } = await loadPitHistories(`since:${FLOW_START_YEAR - 2}-01-01`)
  const flowYears = years.filter((y) => y >= FLOW_START_YEAR)
  const yearly = buildYearly(histories, flowYears).filter((v) => v.syms.length > 0)
  if (yearly.length === 0) {
    log('❌ 시세 로드 실패로 실행할 해가 없다 — 중단')
    return
  }
  log(`실행 구간: ${flowYears[0]}~${flowYears[flowYears.length - 1]} · 전·후반 경계 ${FLOW_HALF_YEAR}`)
  const covered = yearly.reduce((n, v) => n + v.syms.filter((s) => lens.has(s)).length, 0)
  const totalSyms = yearly.reduce((n, v) => n + v.syms.length, 0)
  log(`수급 캐시 매칭: 연도별 유니버스 ${totalSyms}칸 중 ${covered}칸(${((covered / Math.max(1, totalSyms)) * 100).toFixed(0)}%)에 수급 파일이 있다`)

  // ---- 자기검증: bespoke base ≡ 엔진 base -----------------------------------
  const engineBase = runOverlayChain(yearly, OV_BASE, COST)
  const flowBase = runFlowChain(yearly, FLOW_BASE, lens, COST)
  let maxDiff = 0
  const sameLen = engineBase.equity.length === flowBase.equity.length
  if (sameLen)
    for (let i = 0; i < engineBase.equity.length; i++) {
      const a = engineBase.equity[i].equity
      const b = flowBase.equity[i].equity
      maxDiff = Math.max(maxDiff, Math.abs(a - b) / Math.max(1e-12, Math.abs(a)))
    }
  const baseOk = sameLen && maxDiff < 1e-9 && engineBase.trades === flowBase.trades
  log('')
  log('## 자기검증 — bespoke 루프가 엔진 base를 재현하는가')
  log(
    baseOk
      ? `✅ 일치 — 자산곡선 ${engineBase.equity.length}점 전부 동일(상대오차 ${maxDiff.toExponential(1)}), 매매수 ${engineBase.trades}건 동일.`
      : `❌ 불일치 — 구현 버그다. 곡선 길이 ${engineBase.equity.length} vs ${flowBase.equity.length} · 최대 상대오차 ${maxDiff.toExponential(1)} · 매매수 ${engineBase.trades} vs ${flowBase.trades}`,
  )
  if (!baseOk) {
    log('아래 A/B 수치는 base가 갈라진 상태이므로 **읽지 않는다.** 먼저 simulateFlowYear를 고친다.')
    return
  }
  log('※ 22차 수치와의 대조는 같은 구간(2000~)에서만 성립한다 — 이 표는 수급 캐시가 있는')
  log(`   ${FLOW_START_YEAR}년 이후만 돌리므로 22차 총수익과 직접 같지 않다. 아래 참고 행으로 전 구간 base를 함께 찍는다.`)
  const fullBase = runOverlayChain(buildYearly(histories, years), OV_BASE, COST)
  const fp = perfOf(fullBase.equity)
  log(`참고(22차 대조용) 엔진 base 전 구간 ${years[0]}~${years[years.length - 1]}: 총 ${f1(fp.total)}% · CAGR ${f1(fp.cagr)}% · MDD ${f1(fp.mdd)}% · 매매 ${fullBase.trades}건`)

  // ---- A/B -----------------------------------------------------------------
  const variants: FlowVariant[] = [FLOW_BASE, flowF1(3), flowF1(5), FLOW_F2, FLOW_F3]
  log('')
  log('## 수급 가설 A/B')
  log('| 전략 | 총수익 | CAGR | MDD | **수익÷MDD** | 매매 | 결측률 | 전반(~2017) 총/MDD/수익÷MDD | 후반(2018~) 총/MDD/수익÷MDD |')
  log('|---|---|---|---|---|---|---|---|---|')
  const results: { v: FlowVariant; r: FlowChainRes; full: Perf; a: Perf; b: Perf }[] = []
  for (const v of variants) {
    const r = v.key === FLOW_BASE.key ? flowBase : runFlowChain(yearly, v, lens, COST)
    const full = perfOf(r.equity)
    const a = perfOf(r.equity, '', `${FLOW_HALF_YEAR - 1}-12-31`)
    const b = perfOf(r.equity, `${FLOW_HALF_YEAR}-01-01`)
    results.push({ v, r, full, a, b })
    const miss = r.missingAdmit + r.missingRank
    const missPct = r.evaluated > 0 ? `${((miss / r.evaluated) * 100).toFixed(1)}% (${miss}/${r.evaluated})` : '—'
    log(
      `| ${v.label} | ${f1(full.total)}% | ${f1(full.cagr)}% | ${f1(full.mdd)}% | ${full.obj?.toFixed(1) ?? '—'} | ${r.trades} | ${missPct} | ` +
        `${f1(a.total)}% / ${f1(a.mdd)}% / ${a.obj?.toFixed(1) ?? '—'} | ${f1(b.total)}% / ${f1(b.mdd)}% / ${b.obj?.toFixed(1) ?? '—'} |`,
    )
  }

  // ---- 판정 ----------------------------------------------------------------
  const baseRow = results[0]
  log('')
  log('## 판정 (base 대비 · 규칙 5 — 절대 수익이 아니라 base 초과분으로 본다)')
  log('| 가설 | 전 구간 초과 | 전반 초과 | 후반 초과 | 두 구간 모두 개선? |')
  log('|---|---|---|---|---|')
  let winners = 0
  for (const x of results.slice(1)) {
    const dFull = x.full.total - baseRow.full.total
    const dA = x.a.total - baseRow.a.total
    const dB = x.b.total - baseRow.b.total
    const both = dA > 0 && dB > 0
    if (both) winners++
    log(`| ${x.v.key} | ${f1(dFull)}%p | ${f1(dA)}%p | ${f1(dB)}%p | ${both ? '✅' : '❌'} |`)
  }

  log('')
  log('## 다중검정 경고')
  const n = results.length - 1
  log(`수급 가설을 ${n}개(F1 N=3·N=5, F2, F3) 돌려 base와 비교했다. 이 중 ${winners}개가 전·후반 모두에서 base를 이겼다.`)
  log(
    `순수 우연이라면 한 가설이 두 구간 모두 이길 확률은 ≈25%이고, ${n}개 중 ${winners}개 이상이 그럴 확률은 ` +
      `약 ${(binomTail(n, winners, 0.25) * 100).toFixed(0)}%다 — 이 값이 크면 "찾아낸 패턴"이 아니라 표본 잡음이다.`,
  )
  log('가설 하나만 이겼다면 그것을 골라 읽는 순간 곡선맞춤이다. 채택 기준은 ① 전·후반 모두 개선 ②')
  log('결측률이 낮을 것(결측이 만든 성적이 아닐 것) ③ 매매수가 base 대비 극단적으로 줄지 않을 것(표본 소실)이다.')

  log('')
  log('## T−1 처리 · 결측 처리')
  log('· D일 종가 진입 판단에 쓴 수급은 **dt < D**로 확정된 것뿐이다(makeFlowLens.before). D일 수급은 장 마감')
  log('  후 확정이라 그날 판단에 넣으면 미래참조가 된다 — 렌즈 밖에서 수급을 읽는 경로는 시뮬에 없다.')
  log('· 필요한 창(N영업일)이 캐시에 없으면 **불통과**로 처리했다(유리한 쪽 가정 금지). 위 표의 결측률이')
  log('  높은 가설은 "필터가 좋아서"가 아니라 "데이터가 없어서" 매매가 줄었을 수 있으니 그렇게 읽는다.')
  log(`· 수급 캐시 소급 시작 ${cache.oldest} — 그 이전 구간은 이 실험에 포함하지 않았다.`)

  log('')
  log('⚠️ [미검증-실데이터] 이 러너는 컨테이너에서 Yahoo(403)·키움(키 없음) 접속이 막혀 있어')
  log('   합성 데이터 테스트로만 검증됐다. 위 수치는 EC2/러너 실행 결과로 채워야 한다.')
  disclaimer({ universe: true, segmentExit: true })
}

// ============================================================================
// 비(非)이평 전략군 — 공용 기반 (MODE=xsmom · volbrk · rsirev)
// ============================================================================
//
// 2026-08-02 대표 지시: "백테스트 MA 이평선 기반 말고 다른 접근은 없냐? 수익률이 좀 낮은데."
//
// 판정 기준선 = 현행 최고 조합 **MA25×신고10→80선**(23차 400조합 격자 수익÷MDD 1위).
// 기준선 수치를 다른 보고서에서 옮겨 적지 않고 **같은 PIT 유니버스·같은 비용·같은
// 연도 연쇄로 여기서 다시 돌린다** — 유니버스·구간·비용이 다르면 비교가 성립하지 않는다.
//
// ── 규칙 1(미래참조 금지) 준수 ─────────────────────────────────────────────
//   · xsmom : 리밸런스일 D의 랭킹은 `date < 전월 1일` 종가까지만 본다(12-1 모멘텀은
//             최근 1개월을 통째로 버리므로 D 근처 데이터가 아예 안 들어간다).
//             체결은 **월 첫 거래일 시가**.
//   · volbrk: 돌파가 = 당일 시가 + k×(**전일** 고가−저가). 전일 봉과 당일 시가는 주문
//             시점에 이미 확정된 값이다. 당일 고가는 "체결 여부 판정"에만 쓰고,
//             체결가는 `breakoutFill`이 **max(시가, 돌파가)** 로 불리한 쪽을 잡는다(규칙 1-4).
//             랭킹 키는 **전일** 거래대금이다 — 당일 거래대금은 장중에 확정되지 않는다.
//   · rsirev: RSI(2)·MA200 모두 당일 종가까지만 쓰는 재귀·롤링 계산. 신호는 D 종가,
//             체결은 **D+1 시가**. 마지막 봉에서는 신규 신호를 만들지 않는다(규칙 1-6).
//   · 집행자는 `tests/idealab.test.ts`의 절단 불변성 케이스다.
//
// ⚠️ 메모리: 변형별 자산곡선은 요약 즉시 버리고 **스칼라만** 남긴다(2026-08-02 pit1010
//    400조합 OOM 재발 방지). 표에 남는 것은 Perf 스칼라·연도별 배수뿐이다.

/** 23차 격자 수익÷MDD 1위 — 현행 최고 조합(총 +5,442% · CAGR 16.3% · 알파 +7.9%p/연). */
export const BASE25 = { ma: 25, hb: 10, xm: 80, buf: 0 } as const
export const BASELINE_LABEL = `기준선 MA${BASE25.ma}×신고${BASE25.hb}→${BASE25.xm}선`

/** 기준선 스펙 — src/features/backtest/SpecSimulator.tsx의 PRESET_PIT_MAXRATIO와 같은 파라미터. */
export function baselineSpec(symbols: string[]): StrategySpec {
  return {
    version: SPEC_VERSION,
    id: 'idea-lab-baseline-ma25',
    name: BASELINE_LABEL,
    source: '23차 400조합 격자 수익÷MDD 1위',
    universe: {
      markets: ['KOSPI', 'KOSDAQ'],
      excludeAdministrative: true,
      excludeSuspended: true,
      excludeLiquidation: true,
      excludePreferred: true,
      excludeEtf: true,
      symbols,
    },
    entry: {
      op: 'and',
      nodes: [
        c(`${BASE25.ma}일선돌파`, { kind: 'maCross', period: BASE25.ma, dir: 'above' }),
        c(`${BASE25.hb}일신고가`, { kind: 'highBreak', days: BASE25.hb }),
      ],
    },
    ranking: { by: 'tradingValue', dir: 'desc' },
    exits: [{ kind: 'maBreak', maPeriod: BASE25.xm, pct: BASE25.buf }],
    sizing: { maxPositions: MAX_POSITIONS, mode: 'equalSlot' },
    execution: { timing: 'sameClose', orderType: 'market' },
    regime: null,
  }
}

// ---- 장부(Book) — 세 전략이 공유하는 체결·손익 원장 ---------------------------

export interface BookPos {
  qty: number
  /** 취득 총원가(체결가×수량 + 매수수수료). 부분매도 시 비례 차감. */
  basis: number
  /** 부분매도까지 포함한 실현손익 누계 — 전량 청산 시 이 부호로 승패를 가른다. */
  realized: number
  /** 진입 체결일의 캘린더 인덱스(보유일수 계산용) */
  entryIdx: number
  /** 봉이 없는 날 평가에 쓰는 마지막 관측 종가 */
  lastClose: number
}

export interface Book {
  cash: number
  positions: Map<string, BookPos>
  /** 전량 청산으로 완결된 라운드트립 수 */
  closed: number
  /** 그중 실현손익 > 0 */
  wins: number
}

export const newBook = (cash: number): Book => ({ cash, positions: new Map(), closed: 0, wins: 0 })

/**
 * 매수. `rawPx`는 슬리피지 **적용 전** 기준가(시가·종가·돌파가)이며 여기서 불리한 쪽으로
 * 슬리피지를 얹는다. 예산·현금 한도 안에서 정수 주만 산다. 실제 매수 수량을 돌려준다.
 */
export function bookBuy(
  book: Book,
  cost: CostSettings,
  sym: string,
  rawPx: number,
  budget: number,
  idx: number,
): number {
  if (!(rawPx > 0) || !(budget > 0)) return 0
  const fill = rawPx * (1 + cost.slippagePct / 100)
  const qty = Math.floor(Math.min(budget, book.cash) / (fill * (1 + cost.feePct / 100)))
  if (qty <= 0) return 0
  const gross = qty * fill
  const fee = gross * (cost.feePct / 100)
  book.cash -= gross + fee
  const p = book.positions.get(sym)
  if (p) {
    p.qty += qty
    p.basis += gross + fee
  } else {
    book.positions.set(sym, { qty, basis: gross + fee, realized: 0, entryIdx: idx, lastClose: rawPx })
  }
  return qty
}

/** 매도(부분 가능). 전량이 나가면 라운드트립 1건으로 세고 실현손익 부호로 승패를 가른다. */
export function bookSell(book: Book, cost: CostSettings, sym: string, rawPx: number, qty: number): number {
  const p = book.positions.get(sym)
  if (!p || !(qty > 0) || !(rawPx > 0)) return 0
  const q = Math.min(qty, p.qty)
  const fill = rawPx * (1 - cost.slippagePct / 100)
  const gross = q * fill
  const net = gross - gross * ((cost.feePct + cost.taxPct) / 100)
  book.cash += net
  const portion = q / p.qty
  const basisOut = p.basis * portion
  p.realized += net - basisOut
  p.basis -= basisOut
  p.qty -= q
  if (p.qty <= 0) {
    book.closed++
    if (p.realized > 0) book.wins++
    book.positions.delete(sym)
  }
  return q
}

/** 종가 마킹 — 봉 없는 날은 마지막 관측 종가를 이월한다. 총자산(현금+평가)을 돌려준다. */
export function bookMark(book: Book, priceOf: (sym: string) => number | null): number {
  let mv = 0
  for (const [sym, p] of book.positions) {
    const px = priceOf(sym)
    if (px != null && px > 0) p.lastClose = px
    mv += p.qty * p.lastClose
  }
  return book.cash + mv
}

// ---- 한 해치 시뮬 공용 컨텍스트 ----------------------------------------------

export interface SimCtx {
  universe: string[]
  calendar: string[]
  idxOf: Record<string, Map<string, number>>
}

export function makeSimCtx(
  histories: Record<string, DailyBar[]>,
  symbols: string[],
  startDate: string,
): SimCtx {
  const universe = [...new Set(symbols)].filter((s) => histories[s]?.length).sort()
  const scoped: Record<string, DailyBar[]> = {}
  for (const s of universe) scoped[s] = histories[s]
  const calendar = calendarOf(scoped).filter((d) => d >= startDate)
  const idxOf: Record<string, Map<string, number>> = {}
  for (const s of universe) {
    const m = new Map<string, number>()
    histories[s].forEach((b, i) => m.set(b.date, i))
    idxOf[s] = m
  }
  return { universe, calendar, idxOf }
}

/**
 * 체결 1건. **테스트가 규칙 1을 집행하는 지점**이다 — "신호일 종가로 판단해 체결일 시가에
 * 샀다"를 검증하려면 체결일·신호일·체결 기준가가 다 남아 있어야 한다.
 * 연쇄(runCustomChain)는 이 배열을 누적하지 않는다(해마다 버린다 — 메모리).
 */
export interface FillEvent {
  date: string
  sym: string
  side: 'buy' | 'sell'
  /** 슬리피지 적용 **전** 기준가 — 시가·종가·돌파가 중 무엇을 썼는지 그대로 남긴다 */
  px: number
  qty: number
  /** 이 체결을 만든 판단이 이뤄진 날(종가 기준). 당일 판단·당일 체결이면 date와 같다. */
  signalDate: string
}

export interface CustomYearRun {
  equity: { date: string; equity: number }[]
  closed: number
  wins: number
  openAtEnd: number
  fills: FillEvent[]
}

export interface ChainStats {
  equity: { date: string; equity: number }[]
  perYear: { y: number; ret: number; mapped: string }[]
  closed: number
  wins: number
}

/**
 * 연도별 유니버스 교체 연쇄 — `runOverlayChain`/`runFlowChain`과 **같은** 이월·구간끝
 * 청산비용 근사를 쓴다(그래야 기준선 대조가 성립한다). 매핑 5종목 미만인 해는 현금.
 * 각 해는 독립 시뮬이라 12/31에 사실상 전량 정산되는 셈이며, 그 비용이 haircut이다.
 */
export function runCustomChain(
  yearly: YearSlice[],
  runYear: (v: YearSlice) => CustomYearRun,
  cost: CostSettings,
  slots: number,
  applyHaircut = true,
): ChainStats {
  let factor = 1
  const equity: { date: string; equity: number }[] = []
  const perYear: { y: number; ret: number; mapped: string }[] = []
  let closed = 0
  let wins = 0

  for (const v of yearly) {
    const yearStart = factor
    if (v.syms.length < 5) {
      perYear.push({ y: v.y, ret: 1, mapped: v.mapped })
      continue
    }
    const r = runYear(v)
    closed += r.closed
    wins += r.wins
    const base = factor
    for (const e of r.equity) equity.push({ date: e.date, equity: base * (e.equity / cost.initialCapital) })
    const finalEq = r.equity.length ? r.equity[r.equity.length - 1].equity : cost.initialCapital
    const segRet = finalEq / cost.initialCapital
    const frac = applyHaircut ? Math.min(1, Math.max(0, r.openAtEnd / Math.max(1, slots))) : 0
    factor *= segRet * (1 - frac * ((cost.feePct + cost.taxPct + cost.slippagePct) / 100))
    perYear.push({ y: v.y, ret: factor / yearStart, mapped: v.mapped })
  }
  return { equity, perYear, closed, wins }
}

/** 정본 엔진(runStrategySpec) 경로를 같은 연쇄에 태운다 — 기준선 재실행용. */
export function runSpecChain(
  yearly: YearSlice[],
  makeSpec: (syms: string[]) => StrategySpec,
  cost: CostSettings,
  applyHaircut = true,
): ChainStats {
  return runCustomChain(
    yearly,
    (v) => {
      const r = runStrategySpec(v.hist, `${v.y}-01-01`, makeSpec(v.syms), cost)
      const done = r.trades.filter((t) => t.exitDate != null)
      return {
        equity: r.equity.map((e) => ({ date: e.date, equity: e.equity })),
        closed: done.length,
        wins: done.filter((t) => (t.pnl ?? 0) > 0).length,
        openAtEnd: r.openAtEnd,
        fills: [],
      }
    },
    cost,
    MAX_POSITIONS,
    applyHaircut,
  )
}

// ---- 요약(스칼라만) · 알파 · 표 ----------------------------------------------

export interface StratRow {
  label: string
  full: Perf
  a: Perf
  b: Perf
  closed: number
  wins: number
  /** 벤치 대비 연환산 초과수익(%p). 벤치 구간이 없으면 null. */
  alphaFull: number | null
  alphaA: number | null
  alphaB: number | null
  perYear: { y: number; ret: number }[]
}

/**
 * 알파는 **두 곡선이 겹치는 구간**에서만 계산한다. 벤치(KODEX 200)는 2002년 상장이라
 * 2000~2001 구간에는 존재하지 않는데, 그 구간을 전략에만 유리하게 넣으면 알파가 부풀려진다.
 */
export function alphaOf(
  strat: { date: string; equity: number }[],
  bench: { date: string; equity: number }[],
  from: string,
  to: string,
): { s: Perf; b: Perf | null; alpha: number | null; from: string; to: string } {
  const bWin = bench.filter((e) => e.date >= from && e.date <= to)
  const sWin = strat.filter((e) => e.date >= from && e.date <= to)
  if (bWin.length < 2 || sWin.length < 2) return { s: perfOf(strat, from, to), b: null, alpha: null, from, to }
  const lo = bWin[0].date > sWin[0].date ? bWin[0].date : sWin[0].date
  const hi = bWin[bWin.length - 1].date < sWin[sWin.length - 1].date ? bWin[bWin.length - 1].date : sWin[sWin.length - 1].date
  const s = perfOf(strat, lo, hi)
  const b = perfOf(bench, lo, hi)
  if (s.years < 0.5 || b.years < 0.5) return { s, b, alpha: null, from: lo, to: hi }
  return { s, b, alpha: s.cagr - b.cagr, from: lo, to: hi }
}

/** 자산곡선을 스칼라로 접는다. 호출 뒤 곡선 배열은 버려도 된다(메모리). */
export function summarizeStrat(
  label: string,
  chain: ChainStats,
  benchEq: { date: string; equity: number }[],
  halfYear = HALF_YEAR,
): StratRow {
  return {
    label,
    full: perfOf(chain.equity),
    a: perfOf(chain.equity, '', `${halfYear - 1}-12-31`),
    b: perfOf(chain.equity, `${halfYear}-01-01`),
    closed: chain.closed,
    wins: chain.wins,
    alphaFull: alphaOf(chain.equity, benchEq, '', '9999-12-31').alpha,
    alphaA: alphaOf(chain.equity, benchEq, '', `${halfYear - 1}-12-31`).alpha,
    alphaB: alphaOf(chain.equity, benchEq, `${halfYear}-01-01`, '9999-12-31').alpha,
    perYear: chain.perYear.map((p) => ({ y: p.y, ret: p.ret })),
  }
}

const pctOrDash = (v: number | null) => (v == null ? '—' : `${f1(v)}%p`)

export function stratTable(rows: StratRow[], halfYear = HALF_YEAR) {
  log(
    `| 전략 | 총수익 | CAGR | MDD | **수익÷MDD** | 매매(청산완료) | 승률 | 알파(CAGR) | ` +
      `전반(~${halfYear - 1}) 총/MDD/알파 | 후반(${halfYear}~) 총/MDD/알파 |`,
  )
  log('|---|---|---|---|---|---|---|---|---|---|')
  for (const r of rows) {
    const wr = r.closed > 0 ? `${((r.wins / r.closed) * 100).toFixed(0)}%` : '—'
    log(
      `| ${r.label} | ${f1(r.full.total)}% | ${f1(r.full.cagr)}% | ${f1(r.full.mdd)}% | ` +
        `${r.full.obj?.toFixed(1) ?? '—'} | ${r.closed} | ${wr} | ${pctOrDash(r.alphaFull)} | ` +
        `${f1(r.a.total)}% / ${f1(r.a.mdd)}% / ${pctOrDash(r.alphaA)} | ` +
        `${f1(r.b.total)}% / ${f1(r.b.mdd)}% / ${pctOrDash(r.alphaB)} |`,
    )
  }
  // 전멸한 줄이 서로 똑같아 보이는 것을 "같은 전략"으로 오독하지 않게 못 박는다
  if (rows.some((r) => r.full.total <= -99.9))
    log(
      '※ 총수익 −100%인 줄은 **자본을 다 잃었다**는 뜻이다. 그런 줄끼리는 수치가 같아 보여도 같은 전략이 아니다 ' +
        '(자산곡선이 0에 붙으면 지표가 하한에서 뭉친다). 비교는 살아남은 줄끼리만 의미가 있다.',
    )
}

/**
 * 기준선 대조행 — 23차 격자 보고(+5,442% · CAGR 16.3%)는 구간끝 청산비용 근사가 없는
 * 수치다. 표의 기준선이 그보다 낮게 나오는 것이 정상이라는 걸 매번 보여준다
 * (안 보여주면 다음 세션이 "기준선이 깨졌다"고 오진한다).
 */
function baselineCrossCheck(yearly: YearSlice[]) {
  const p = perfOf(runSpecChain(yearly, baselineSpec, COST, false).equity)
  log('')
  log(
    `기준선 대조: 구간끝 청산비용 근사를 빼면 총 ${f1(p.total)}% · CAGR ${f1(p.cagr)}% · MDD ${f1(p.mdd)}% — ` +
      '23차 격자 보고(+5,442% · CAGR 16.3% · MDD −31.9%)와 맞춰 볼 값이다.',
  )
  log('(표의 기준선은 매년 말 정산비용 [추정]을 뺀 값이라 23차 수치보다 낮게 나오는 것이 정상이다.)')
}

/** rows[0]이 기준선이라는 전제. 전·후반 모두 기준선을 이긴 변형 수를 돌려준다. */
export function verdictTable(rows: StratRow[]): number {
  const base = rows[0]
  log('')
  log('## 판정 (기준선 대비 · 규칙 5 — 절대 수익이 아니라 초과분으로 본다)')
  log('| 전략 | 전 구간 초과 | 전반 초과 | 후반 초과 | 전·후반 모두 개선? |')
  log('|---|---|---|---|---|')
  let winners = 0
  for (const r of rows.slice(1)) {
    const dA = r.a.total - base.a.total
    const dB = r.b.total - base.b.total
    const both = dA > 0 && dB > 0
    if (both) winners++
    log(`| ${r.label} | ${f1(r.full.total - base.full.total)}%p | ${f1(dA)}%p | ${f1(dB)}%p | ${both ? '✅' : '❌'} |`)
  }
  return winners
}

export function perYearTable(rows: StratRow[]) {
  log('')
  log('## 연도별 수익 분해 (거짓 매끈함 방지)')
  log(`| 연도 | ${rows.map((r) => r.label).join(' | ')} |`)
  log(`|---|${rows.map(() => '---').join('|')}|`)
  const years = rows[0].perYear.map((p) => p.y)
  for (const [i, y] of years.entries())
    log(`| ${y} | ${rows.map((r) => `${f1(((r.perYear[i]?.ret ?? 1) - 1) * 100)}%`).join(' | ')} |`)
}

function multipleTestingNote(n: number, winners: number) {
  log('')
  log('## 다중검정 경고')
  log(`같은 데이터에 변형 ${n}개를 돌려 기준선과 비교했다. 그중 ${winners}개가 전·후반 **모두**에서 기준선을 이겼다.`)
  log(
    `순수 우연이라도 한 변형이 두 구간 모두 이길 확률은 ≈25%이고, ${n}개 중 ${winners}개 이상이 그럴 확률은 ` +
      `약 ${(binomTail(n, winners, 0.25) * 100).toFixed(0)}%다 — 이 값이 크면 "찾아낸 패턴"이 아니라 표본 잡음이다.`,
  )
  log('채택 기준은 ① 전·후반 모두 기준선 초과 ② 두 구간 모두 알파 양(+) ③ 매매수가 극단적으로 적지 않을 것')
  log('(표본 소실)이다. 하나만 만족하는 변형을 골라 읽는 순간 곡선맞춤이다.')
}

/** 벤치 단순보유 곡선(총수익 보정 종가) — 알파 계산 기준. */
export const benchCurve = (bench: DailyBar[]) => bench.map((b) => ({ date: b.date, equity: b.c }))

function unverifiedNote() {
  log('')
  log('⚠️ [미검증-실데이터] 이 러너는 컨테이너에서 Yahoo가 403이라 합성 데이터 테스트로만 검증됐다.')
  log('   위 수치는 GitHub Actions(backtest.yml)·EC2 실행 결과로 채워야 한다.')
}

// ============================================================================
// MODE=xsmom — 횡단면 모멘텀 랭킹 (12-1) · 이동평균 없음
// ============================================================================
//
// 학계 표준(Jegadeesh–Titman 계열): 매월 첫 거래일에 "12개월 전 ~ 1개월 전" 수익률로
// 전 종목을 줄 세우고 상위 N만 동일가중 보유, 다음 달 첫 거래일에 리밸런스.
// **최근 1개월을 통째로 버리는 것**이 핵심이다(단기 반전 효과 회피).
//
// 미래참조 차단: 랭킹은 `date < 전월 1일` 종가만 본다. 리밸런스일 D의 시가는 체결에만
// 쓰고 판정에는 쓰지 않는다. 12개월치 데이터가 없는 종목은 후보에서 뺀다.

/** 'YYYY-MM-DD'에서 k개월 이동한 달의 1일 — 'YYYY-MM-01' */
export function shiftMonthStart(date: string, k: number): string {
  const y = Number(date.slice(0, 4))
  const m = Number(date.slice(5, 7))
  const t = y * 12 + (m - 1) + k
  const yy = Math.floor(t / 12)
  const mm = t - yy * 12 + 1
  return `${String(yy).padStart(4, '0')}-${String(mm).padStart(2, '0')}-01`
}

/** `date` **미만**(strictly before) 마지막 봉의 종가. 없으면 null. 이분 탐색. */
export function lastCloseBefore(bars: DailyBar[], date: string): number | null {
  let lo = 0
  let hi = bars.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (bars[mid].date < date) lo = mid + 1
    else hi = mid
  }
  return lo > 0 ? bars[lo - 1].c : null
}

/**
 * 12-1 모멘텀. 리밸런스일 `date`(월 첫 거래일) 기준으로
 *   시작 = 12개월 전 달 1일 직전 종가 · 끝 = 1개월 전 달 1일 직전 종가.
 * 두 기준일 모두 `date`보다 과거라 미래참조가 원천적으로 불가능하고, 직전 한 달의
 * 수익은 창에서 빠진다. 12개월치 데이터가 없으면(시작 종가 부재) null = 후보 제외.
 */
export function momentum12_1(bars: DailyBar[], date: string): number | null {
  const pe = lastCloseBefore(bars, shiftMonthStart(date, -1))
  const ps = lastCloseBefore(bars, shiftMonthStart(date, -12))
  if (pe == null || ps == null || !(ps > 0)) return null
  return pe / ps - 1
}

export interface MomRow {
  sym: string
  mom: number
}

/** 모멘텀 내림차순, 동점은 심볼 오름차순(결정적). */
export function xsmomRank(histories: Record<string, DailyBar[]>, universe: string[], date: string): MomRow[] {
  const rows: MomRow[] = []
  for (const s of universe) {
    const bars = histories[s]
    if (!bars?.length) continue
    const m = momentum12_1(bars, date)
    if (m == null) continue
    rows.push({ sym: s, mom: m })
  }
  rows.sort((x, y) => (y.mom !== x.mom ? y.mom - x.mom : x.sym < y.sym ? -1 : x.sym > y.sym ? 1 : 0))
  return rows
}

export interface XsMomOpts {
  /** 보유 종목 수 N */
  slots: number
  /** 절대 모멘텀 게이트 — 12-1 수익 < 0인 종목은 그 슬롯을 **현금**으로 둔다 */
  gate: boolean
}

/**
 * 한 해치 횡단면 모멘텀 시뮬. 월 첫 거래일 **시가**에 리밸런스한다.
 * 슬롯 분모는 게이트와 무관하게 `min(N, 후보수)`로 고정한다 — 그래야 게이트 A/B가
 * "같은 슬롯 중 몇 개를 현금으로 돌렸나"의 비교가 된다(분모를 같이 줄이면 게이트가
 * 남은 종목에 레버리지를 거는 셈이라 비교가 오염된다).
 */
export function simulateXsMomYear(
  histories: Record<string, DailyBar[]>,
  startDate: string,
  symbols: string[],
  cost: CostSettings,
  opts: XsMomOpts,
): CustomYearRun {
  const { universe, calendar, idxOf } = makeSimCtx(histories, symbols, startDate)
  const book = newBook(cost.initialCapital)
  const equity: { date: string; equity: number }[] = []
  const fills: FillEvent[] = []
  const closeAt = (date: string) => (s: string) => {
    const bi = idxOf[s]?.get(date)
    return bi != null ? histories[s][bi].c : null
  }
  let curYm = ''

  for (let d = 0; d < calendar.length; d++) {
    const date = calendar[d]
    // 랭킹은 전월 1일 이전 종가까지만 보므로 판단 시점은 늦어도 직전 거래일이다
    const signalDate = d > 0 ? calendar[d - 1] : date
    const sell = (sym: string, px: number, qty: number) => {
      const q = bookSell(book, cost, sym, px, qty)
      if (q > 0) fills.push({ date, sym, side: 'sell', px, qty: q, signalDate })
    }
    const buy = (sym: string, px: number, budget: number) => {
      const q = bookBuy(book, cost, sym, px, budget, d)
      if (q > 0) fills.push({ date, sym, side: 'buy', px, qty: q, signalDate })
    }
    const ym = ymOf(date)
    if (ym !== curYm) {
      curYm = ym
      // ---- 월 첫 거래일: 시가 리밸런스 ----------------------------------
      const openPx = new Map<string, number | null>()
      for (const s of universe) {
        const bi = idxOf[s].get(date)
        openPx.set(s, bi != null ? histories[s][bi].o : null)
      }
      let eq = book.cash
      for (const [s, p] of book.positions) {
        const px = openPx.get(s)
        eq += p.qty * (px != null && px > 0 ? px : p.lastClose)
      }
      // 후보: 랭킹 산출 가능 + 오늘 실제로 거래되는 종목만(체결 불가 종목을 담지 않는다)
      const ranked = xsmomRank(histories, universe, date).filter((r) => (openPx.get(r.sym) ?? 0) > 0)
      const denom = Math.max(1, Math.min(opts.slots, ranked.length))
      const picked = ranked.slice(0, denom)
      const targets = opts.gate ? picked.filter((r) => r.mom >= 0) : picked
      const targetSet = new Set(targets.map((r) => r.sym))
      const slot = eq / denom

      // 1) 목표 밖 전량 매도 (봉이 없으면 못 판다 — 다음 기회로 이월)
      for (const s of [...book.positions.keys()]) {
        if (targetSet.has(s)) continue
        const px = openPx.get(s)
        if (px == null || !(px > 0)) continue
        sell(s, px, book.positions.get(s)!.qty)
      }
      // 2) 목표 초과분 트림
      for (const r of targets) {
        const p = book.positions.get(r.sym)
        if (!p) continue
        const px = openPx.get(r.sym)!
        const want = Math.floor(slot / px)
        if (p.qty > want) sell(r.sym, px, p.qty - want)
      }
      // 3) 부족분 매수
      for (const r of targets) {
        const px = openPx.get(r.sym)!
        const held = book.positions.get(r.sym)?.qty ?? 0
        const budget = Math.min(slot - held * px, book.cash)
        if (budget <= 0) continue
        buy(r.sym, px, budget)
      }
    }
    equity.push({ date, equity: bookMark(book, closeAt(date)) })
  }
  return { equity, closed: book.closed, wins: book.wins, openAtEnd: book.positions.size, fills }
}

async function xsmom() {
  log('# MODE=xsmom — 횡단면 모멘텀 랭킹 (12-1) · 이동평균 없음')
  log('')
  log('매월 첫 거래일에 "12개월 전~1개월 전" 수익률로 줄 세워 상위 N만 동일가중 보유하고,')
  log('다음 달 첫 거래일 **시가**에 리밸런스한다. 최근 1개월은 단기 반전을 피하려고 통째로 뺀다.')
  log('이동평균·신고가 같은 추세 지표를 전혀 쓰지 않는 접근이다.')
  log('')
  const { years, histories, bench } = await loadPitHistories()
  const yearly = buildYearly(histories, years)
  if (yearly.every((v) => v.syms.length < 5)) {
    log('❌ 시세 로드 실패로 실행할 해가 없다 — 중단')
    return
  }
  const benchEq = benchCurve(bench)
  log(`연도별 매핑률: ${yearly.map((v) => `${v.y} ${v.mapped}`).join(' · ')}`)
  log(`벤치 ${BENCH} 데이터 시작 ${bench[0]?.date ?? '—'} — 알파는 이 날짜 이후 겹치는 구간에서만 계산한다.`)

  const rows: StratRow[] = []
  rows.push(summarizeStrat(BASELINE_LABEL, runSpecChain(yearly, baselineSpec, COST), benchEq))
  for (const slots of [5, 10]) {
    for (const gate of [false, true]) {
      const label = `XSM 상위 ${slots}${gate ? ' + 절대모멘텀 게이트' : ''}`
      // 변형별 자산곡선은 이 블록 안에서만 살아 있다 — 요약 후 즉시 회수된다(메모리)
      const chain = runCustomChain(
        yearly,
        (v) => simulateXsMomYear(v.hist, `${v.y}-01-01`, v.syms, COST, { slots, gate }),
        COST,
        slots,
      )
      rows.push(summarizeStrat(label, chain, benchEq))
    }
  }

  log('')
  log('## 성적 (기준선을 같은 유니버스·같은 비용으로 재실행한 값과 나란히)')
  stratTable(rows)
  baselineCrossCheck(yearly)
  const winners = verdictTable(rows)
  perYearTable(rows)
  multipleTestingNote(rows.length - 1, winners)

  log('')
  log('## 이 실험의 구조적 한계')
  log('· 유니버스가 연 20종목뿐이라 "상위 5/10"은 사실상 상위 25~50% 분위다 — 학계의 상위 10% 분위')
  log('  모멘텀보다 신호가 훨씬 묽다. 알파가 안 나와도 "모멘텀이 죽었다"가 아니라 "이 유니버스에서는')
  log('  분위가 안 갈린다"일 수 있다.')
  log('· 연도별 유니버스 교체 구조라 매년 1월 초 전량 재편입 + 12월 말 정산 근사가 들어간다.')
  log('· 12개월치 시세가 없는 종목은 그 시점 후보에서 빠진다(신규 편입 종목은 1년 뒤부터 랭킹 대상).')
  unverifiedNote()
  disclaimer()
}

// ============================================================================
// MODE=volbrk — 변동성 돌파 (래리 윌리엄스 k)
// ============================================================================
//
// 돌파가 = 당일 시가 + k×(전일 고가 − 전일 저가). 당일 고가가 돌파가에 닿으면 매수한다.
//
// ⚠️ 일봉 근사의 한계(출력에도 명시한다):
//   · 일봉에는 **장중 경로**가 없다. 고가가 돌파가를 넘었다는 사실만 알 뿐, 그것이 언제
//     찍혔는지·그 가격에 실제로 체결됐는지(호가 잔량)는 알 수 없다.
//   · 청산 변형이 "당일 종가"인 경우, 돌파 체결 → 종가 청산의 순서만 가정할 뿐 그 사이
//     저가를 관통했는지는 반영하지 못한다(손절 없음).
//   · 랭킹은 **전일** 거래대금으로 한다 — 당일 거래대금은 장이 끝나야 확정되므로
//     진입 시점에 쓰면 미래참조다.

/**
 * 돌파 체결가. 고가가 돌파가에 못 닿으면 체결 없음(null).
 * **시가가 이미 돌파가 위면 시가**로 체결한다 — 갭으로 관통한 경우 유리한 쪽(돌파가)이
 * 아니라 불리한 쪽을 잡는 것이 규칙 1-4다.
 */
export function breakoutFill(open: number, high: number, target: number): number | null {
  if (!(high >= target)) return null
  return Math.max(open, target)
}

export interface VolBrkOpts {
  k: number
  /** 'close' = 당일 종가 청산(데이트레이드형) · 'nextOpen' = 익일 시가 청산 */
  exit: 'close' | 'nextOpen'
  slots: number
}

export function simulateVolBrkYear(
  histories: Record<string, DailyBar[]>,
  startDate: string,
  symbols: string[],
  cost: CostSettings,
  opts: VolBrkOpts,
): CustomYearRun {
  const { universe, calendar, idxOf } = makeSimCtx(histories, symbols, startDate)
  const book = newBook(cost.initialCapital)
  const equity: { date: string; equity: number }[] = []
  const fills: FillEvent[] = []
  const closeAt = (date: string) => (s: string) => {
    const bi = idxOf[s]?.get(date)
    return bi != null ? histories[s][bi].c : null
  }

  for (let d = 0; d < calendar.length; d++) {
    const date = calendar[d]
    const isLast = d === calendar.length - 1
    const sell = (sym: string, px: number, qty: number, signalDate: string) => {
      const q = bookSell(book, cost, sym, px, qty)
      if (q > 0) fills.push({ date, sym, side: 'sell', px, qty: q, signalDate })
    }

    // ---- 1) 익일 시가 청산 변형 — 전일 진입분을 오늘 시가에 전량 청산 ----------
    if (opts.exit === 'nextOpen') {
      for (const [s, p] of [...book.positions]) {
        if (p.entryIdx >= d) continue
        const bi = idxOf[s].get(date)
        if (bi == null) continue
        sell(s, histories[s][bi].o, p.qty, calendar[Math.max(0, d - 1)])
      }
    }

    // ---- 2) 돌파 진입 -------------------------------------------------------
    // 마지막 봉에서는 신규 진입을 만들지 않는다(규칙 1-6 — 익일 청산이 불가능하고
    // 엔진 기준선도 같은 날 신규 진입을 막으므로 비교 조건을 맞춘다).
    if (!isLast && book.positions.size < opts.slots) {
      const cands: { sym: string; fill: number; key: number }[] = []
      for (const s of universe) {
        if (book.positions.has(s)) continue
        const bi = idxOf[s].get(date)
        if (bi == null || bi < 1) continue
        const bars = histories[s]
        const b = bars[bi]
        const prev = bars[bi - 1]
        const range = prev.h - prev.l
        if (!(range > 0)) continue // 레인지 0(상·하한가 잠김 등)은 돌파 정의가 성립하지 않는다
        const fill = breakoutFill(b.o, b.h, b.o + opts.k * range)
        if (fill == null) continue
        cands.push({ sym: s, fill, key: prev.c * prev.v }) // 전일 거래대금 — 당일 값은 미래참조
      }
      cands.sort((x, y) => (y.key !== x.key ? y.key - x.key : x.sym < y.sym ? -1 : x.sym > y.sym ? 1 : 0))
      for (const cd of cands) {
        if (book.positions.size >= opts.slots) break
        const slot = book.cash / Math.max(1, opts.slots - book.positions.size)
        const q = bookBuy(book, cost, cd.sym, cd.fill, slot, d)
        // 판단도 체결도 당일 장중이라 signalDate = date다(장중 스톱 주문 근사)
        if (q > 0) fills.push({ date, sym: cd.sym, side: 'buy', px: cd.fill, qty: q, signalDate: date })
      }
    }

    // ---- 3) 당일 종가 청산 변형 ---------------------------------------------
    if (opts.exit === 'close') {
      for (const [s, p] of [...book.positions]) {
        const bi = idxOf[s].get(date)
        if (bi == null) continue
        sell(s, histories[s][bi].c, p.qty, date)
      }
    }

    equity.push({ date, equity: bookMark(book, closeAt(date)) })
  }
  return { equity, closed: book.closed, wins: book.wins, openAtEnd: book.positions.size, fills }
}

async function volbrk() {
  log('# MODE=volbrk — 변동성 돌파 (래리 윌리엄스 k)')
  log('')
  log('돌파가 = **당일 시가 + k×(전일 고가−전일 저가)**. 당일 고가가 돌파가에 닿으면 매수하고,')
  log('당일 종가(데이트레이드형) 또는 익일 시가에 청산한다. 이동평균을 쓰지 않는다.')
  log('')
  const { years, histories, bench } = await loadPitHistories()
  const yearly = buildYearly(histories, years)
  if (yearly.every((v) => v.syms.length < 5)) {
    log('❌ 시세 로드 실패로 실행할 해가 없다 — 중단')
    return
  }
  const benchEq = benchCurve(bench)
  log(`연도별 매핑률: ${yearly.map((v) => `${v.y} ${v.mapped}`).join(' · ')}`)
  log(`슬롯 ${MAX_POSITIONS} · 후보 초과 시 **전일** 거래대금 순 · 벤치 ${BENCH} 시작 ${bench[0]?.date ?? '—'}`)

  const rows: StratRow[] = []
  rows.push(summarizeStrat(BASELINE_LABEL, runSpecChain(yearly, baselineSpec, COST), benchEq))
  for (const k of [0.5, 0.7]) {
    for (const exit of ['close', 'nextOpen'] as const) {
      const label = `VB k=${k.toFixed(1)} · ${exit === 'close' ? '당일 종가 청산' : '익일 시가 청산'}`
      const chain = runCustomChain(
        yearly,
        (v) => simulateVolBrkYear(v.hist, `${v.y}-01-01`, v.syms, COST, { k, exit, slots: MAX_POSITIONS }),
        COST,
        MAX_POSITIONS,
      )
      rows.push(summarizeStrat(label, chain, benchEq))
    }
  }

  log('')
  log('## 성적 (기준선을 같은 유니버스·같은 비용으로 재실행한 값과 나란히)')
  stratTable(rows)
  baselineCrossCheck(yearly)
  const winners = verdictTable(rows)
  perYearTable(rows)
  multipleTestingNote(rows.length - 1, winners)

  log('')
  log('## ⚠️ 일봉 근사의 한계 — 이 수치를 실전 기대치로 읽지 말 것')
  log('· **실제 체결 순서를 알 수 없다.** 일봉에는 장중 경로가 없어서 "고가가 돌파가에 닿았다"만 알고')
  log('  언제 닿았는지·그 가격에 체결됐는지(호가 잔량·상한가 잠김)는 알 수 없다. 체결 가정이 낙관적이면')
  log('  성적은 통째로 허수가 된다. 이 계열은 분봉으로 재검증하기 전에는 채택 후보로도 올리지 않는다.')
  log('· 갭 관통 보수 처리: 시가가 이미 돌파가 위면 **시가(더 불리한 쪽)** 로 체결했다(규칙 1-4).')
  log('  다만 돌파가를 당일 시가 기준으로 잡는 정의에서는 이 경우가 전일 레인지 0일 때뿐이라,')
  log('  실제로는 전일 레인지 0을 후보에서 제외해 그 구간을 아예 만들지 않았다.')
  log('· 당일 종가 청산 변형에는 **손절이 없다** — 진입가 아래로 흘러도 종가까지 들고 간다.')
  log('  일봉으로는 장중 손절 체결가를 알 수 없어 넣지 않았다(넣으면 유리한 쪽 가정이 된다).')
  log('· 회전율이 극단적으로 높아 비용이 성적을 지배한다 — 왕복 1회에 매수 슬리피지 0.1% + 매수 수수료 0.015%')
  log('  + 매도 슬리피지 0.1% + 매도 수수료 0.015% + 거래세 0.15% = **약 0.38%**가 나간다. 매매수와 승률을')
  log('  같이 보고, 승률이 높아도 총수익이 안 나오면 비용이 먹은 것이다.')
  unverifiedNote()
  disclaimer()
}

// ============================================================================
// MODE=rsirev — 단기 평균회귀 (RSI2 · Wilder) + 200일선 추세 필터
// ============================================================================
//
// RSI(2) < 10 이면서 종가가 200일선 위(장기 추세 안에 있는 눌림)일 때 D+1 시가 매수,
// RSI(2) > 60 또는 5거래일 경과 시 D+1 시가 청산. 추세 지표를 필터로만 쓰고 진입 신호는
// 평균회귀라 이평 돌파 계열과 성격이 반대다.

const rsiFrom = (avgGain: number, avgLoss: number) =>
  avgLoss === 0 ? (avgGain === 0 ? 50 : 100) : 100 - 100 / (1 + avgGain / avgLoss)

/**
 * Wilder RSI. 첫 `period`개 변화량의 단순평균으로 시드하고 이후 Wilder 평활
 * (avg = (avg×(period−1) + 오늘값) / period)로 이어간다.
 *
 * 인덱스 i의 값은 `bars[0..i]`만으로 결정된다 — 재귀가 앞에서 뒤로만 흐르므로
 * **뒤를 잘라내도 앞의 값이 바뀌지 않는다**(절단 불변). 엔진의 `rsi()`는 단순평균
 * 방식이라 값이 다르다. 여기서는 지시대로 Wilder를 쓰므로 별도 함수로 둔다.
 */
export function wilderRsi(bars: DailyBar[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(bars.length).fill(null)
  if (period <= 0 || bars.length <= period) return out
  let g = 0
  let l = 0
  for (let i = 1; i <= period; i++) {
    const dv = bars[i].c - bars[i - 1].c
    if (dv > 0) g += dv
    else l -= dv
  }
  let ag = g / period
  let al = l / period
  out[period] = rsiFrom(ag, al)
  for (let i = period + 1; i < bars.length; i++) {
    const dv = bars[i].c - bars[i - 1].c
    ag = (ag * (period - 1) + Math.max(0, dv)) / period
    al = (al * (period - 1) + Math.max(0, -dv)) / period
    out[i] = rsiFrom(ag, al)
  }
  return out
}

export interface RsiRevOpts {
  slots: number
  period: number
  /** 진입 임계 — RSI(2)가 이 값 **미만** */
  lowThr: number
  /** 청산 임계 — RSI(2)가 이 값 **초과** */
  highThr: number
  /** 최대 보유 거래일 — 진입 체결일로부터 이만큼 지나면 강제 청산 신호 */
  maxHold: number
  /** 추세 필터 이동평균 기간. 0이면 필터 없음(A/B용). */
  trendMa: number
}

export const RSIREV_DEFAULT: RsiRevOpts = {
  slots: MAX_POSITIONS,
  period: 2,
  lowThr: 10,
  highThr: 60,
  maxHold: 5,
  trendMa: 200,
}

/**
 * 신호는 **당일 종가**, 체결은 **다음 거래일 시가**(규칙 1-2 규칙형). 마지막 봉에서는
 * 신규 신호를 만들지 않는다(규칙 1-6). 슬롯 초과 시 RSI가 낮은(더 과매도) 순으로 채운다.
 */
export function simulateRsiRevYear(
  histories: Record<string, DailyBar[]>,
  startDate: string,
  symbols: string[],
  cost: CostSettings,
  opts: RsiRevOpts,
): CustomYearRun {
  const { universe, calendar, idxOf } = makeSimCtx(histories, symbols, startDate)
  const rsiOf: Record<string, (number | null)[]> = {}
  for (const s of universe) rsiOf[s] = wilderRsi(histories[s], opts.period)
  const book = newBook(cost.initialCapital)
  const equity: { date: string; equity: number }[] = []
  const fills: FillEvent[] = []
  const closeAt = (date: string) => (s: string) => {
    const bi = idxOf[s]?.get(date)
    return bi != null ? histories[s][bi].c : null
  }
  let pendingBuys: { sym: string; key: number }[] = []
  let pendingSells: string[] = []
  /** 대기 주문을 만든 신호일(그날 **종가**로 판정했다) */
  let signalDate = ''

  for (let d = 0; d < calendar.length; d++) {
    const date = calendar[d]
    const isLast = d === calendar.length - 1

    // ---- 1) 어제 종가 신호 → 오늘 시가 청산 (먼저 슬롯을 비운다) --------------
    for (const s of pendingSells) {
      const p = book.positions.get(s)
      if (!p) continue
      const bi = idxOf[s].get(date)
      if (bi == null) continue // 봉이 없으면 못 판다 — 다음 봉에서 다시 신호가 잡힌다
      const px = histories[s][bi].o
      const q = bookSell(book, cost, s, px, p.qty)
      if (q > 0) fills.push({ date, sym: s, side: 'sell', px, qty: q, signalDate })
    }
    pendingSells = []

    // ---- 2) 어제 종가 신호 → 오늘 시가 매수 ---------------------------------
    for (const cand of pendingBuys) {
      if (book.positions.size >= opts.slots) break
      if (book.positions.has(cand.sym)) continue
      const bi = idxOf[cand.sym].get(date)
      if (bi == null) continue
      const slot = book.cash / Math.max(1, opts.slots - book.positions.size)
      const px = histories[cand.sym][bi].o
      const q = bookBuy(book, cost, cand.sym, px, slot, d)
      if (q > 0) fills.push({ date, sym: cand.sym, side: 'buy', px, qty: q, signalDate })
    }
    pendingBuys = []

    // ---- 3) 종가 마킹 --------------------------------------------------------
    equity.push({ date, equity: bookMark(book, closeAt(date)) })

    // ---- 4) 오늘 종가로 내일 신호 (마지막 봉이면 만들지 않는다) ---------------
    if (isLast) continue
    for (const [s, p] of book.positions) {
      const bi = idxOf[s].get(date)
      if (bi == null) continue
      const r = rsiOf[s][bi]
      if ((r != null && r > opts.highThr) || d - p.entryIdx >= opts.maxHold) pendingSells.push(s)
    }
    const cands: { sym: string; key: number }[] = []
    for (const s of universe) {
      if (book.positions.has(s)) continue
      const bi = idxOf[s].get(date)
      if (bi == null) continue
      const r = rsiOf[s][bi]
      if (r == null || !(r < opts.lowThr)) continue
      if (opts.trendMa > 0) {
        const ma = sma(histories[s], bi, opts.trendMa)
        if (ma == null || !(histories[s][bi].c > ma)) continue
      }
      cands.push({ sym: s, key: r })
    }
    cands.sort((x, y) => (x.key !== y.key ? x.key - y.key : x.sym < y.sym ? -1 : x.sym > y.sym ? 1 : 0))
    pendingBuys = cands
    signalDate = date
  }
  return { equity, closed: book.closed, wins: book.wins, openAtEnd: book.positions.size, fills }
}

async function rsirev() {
  log('# MODE=rsirev — 단기 평균회귀 (RSI2 · Wilder)')
  log('')
  log('RSI(2) < 10 **그리고** 종가가 200일선 위일 때 다음 거래일 **시가** 매수 →')
  log('RSI(2) > 60 또는 5거래일 경과 시 다음 거래일 **시가** 청산. 추세 돌파와 부호가 반대인 접근이다.')
  log('')
  const { years, histories, bench } = await loadPitHistories()
  const yearly = buildYearly(histories, years)
  if (yearly.every((v) => v.syms.length < 5)) {
    log('❌ 시세 로드 실패로 실행할 해가 없다 — 중단')
    return
  }
  const benchEq = benchCurve(bench)
  log(`연도별 매핑률: ${yearly.map((v) => `${v.y} ${v.mapped}`).join(' · ')}`)
  log(`슬롯 ${MAX_POSITIONS} · 후보 초과 시 RSI 낮은 순 · 벤치 ${BENCH} 시작 ${bench[0]?.date ?? '—'}`)

  const variants: { label: string; opts: RsiRevOpts }[] = [
    { label: 'RSI2<10 · 200일선 위 (본안)', opts: RSIREV_DEFAULT },
    { label: 'RSI2<5 · 200일선 위 (민감도)', opts: { ...RSIREV_DEFAULT, lowThr: 5 } },
    { label: 'RSI2<15 · 200일선 위 (민감도)', opts: { ...RSIREV_DEFAULT, lowThr: 15 } },
    { label: 'RSI2<10 · 추세필터 없음 (A/B)', opts: { ...RSIREV_DEFAULT, trendMa: 0 } },
  ]

  const rows: StratRow[] = []
  rows.push(summarizeStrat(BASELINE_LABEL, runSpecChain(yearly, baselineSpec, COST), benchEq))
  for (const v of variants) {
    const chain = runCustomChain(
      yearly,
      (ys) => simulateRsiRevYear(ys.hist, `${ys.y}-01-01`, ys.syms, COST, v.opts),
      COST,
      v.opts.slots,
    )
    rows.push(summarizeStrat(v.label, chain, benchEq))
  }

  log('')
  log('## 성적 (기준선을 같은 유니버스·같은 비용으로 재실행한 값과 나란히)')
  stratTable(rows)
  baselineCrossCheck(yearly)
  const winners = verdictTable(rows)
  perYearTable(rows)
  multipleTestingNote(rows.length - 1, winners)

  log('')
  log('## 이 실험의 구조적 한계')
  log('· RSI(2)는 Wilder 평활이며 **당일 종가까지만** 쓴다. 신호(D 종가)와 체결(D+1 시가)이 분리돼 있어')
  log('  갭 오픈이 성적을 크게 흔든다 — 과매도 다음날 갭하락으로 시작하면 그 손실을 그대로 먹는다.')
  log('· 평균회귀는 승률이 높고 손실이 꼬리에 몰리는 구조다. **승률이 높다고 좋은 전략이 아니다** —')
  log('  MDD·수익÷MDD를 같은 무게로 본다. 2008·2020 같은 급락 구간에서 "싸 보이는" 종목을 계속')
  log('  받아내다 크게 다치는 경로가 이 계열의 전형적 실패 방식이다.')
  log('· 임계값 3종(5/10/15)과 추세필터 A/B를 함께 돌렸다 — 그중 최고를 골라 읽으면 곡선맞춤이다.')
  log('· 5거래일 강제 청산은 진입 **체결일**로부터 센다(신호일이 아니다).')
  unverifiedNote()
  disclaimer()
}

// ============================================================================

const MODES: Record<string, () => Promise<void>> = {
  seasonal,
  monthpat,
  pairprem,
  flow,
  xsmom,
  volbrk,
  rsirev,
}

// 런처(scripts/idea-lab.mjs)만 IDEA_LAB_RUN=1을 넘긴다. 테스트가 이 모듈을
// import할 때는 자동 실행되지 않는다.
if (process.env.IDEA_LAB_RUN === '1') {
  const mode = process.env.MODE ?? 'seasonal'
  const entry = MODES[mode]
  if (!entry) {
    console.error(`알 수 없는 MODE=${mode} — 가능: ${Object.keys(MODES).join(', ')}`)
    process.exit(1)
  }
  entry().catch((e) => {
    console.error('실행 실패:', e)
    process.exit(1)
  })
}
