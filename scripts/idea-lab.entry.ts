// 아이디어 랩 — 조건 확장 실험 러너 (2026-08-02 대표 지시)
//
//   "조건들을 더 넣어서 검토해보자. 예: 특정 계절마다 특정값 조정 /
//    특정 종목의 특정 월 상승 패턴 / 삼성전자·삼성전자우 주가 차이 기반 매매."
//
// MODE=seasonal  — 월별 계절성 기술통계 + 승자 조건식 위 월 필터 오버레이 A/B
// MODE=monthpat  — 종목×월 상승패턴 셀 선정(확장 윈도우) 후 해당 월만 보유
// MODE=pairprem  — 삼성전자/삼성전자우 괴리율 z-score 스위칭 (롱온리)
//
// ── 규칙 1(미래참조 금지) 준수 방법 ────────────────────────────────────────
//   · 모든 통계는 **확장 윈도우**다. 전체 구간 평균·표준편차·최대최소를 임계값
//     산출에 쓰지 않는다(그 자체가 미래 정보). 월 필터·셀 선정은 "그 해 1월 초까지의
//     데이터"만, 괴리율 z는 "그 시점까지의" 평균·표준편차만 쓴다.
//   · pairprem 신호는 당일 종가로 판정하고 **다음 거래일 시가**에 체결한다.
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
  type Condition,
  type ConditionNode,
  type StrategySpec,
} from '../src/features/backtest/strategySpec'
import type { DailyBar } from '../src/features/backtest/types'

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

const MODES: Record<string, () => Promise<void>> = { seasonal, monthpat, pairprem }

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
