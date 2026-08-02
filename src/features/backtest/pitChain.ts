// 시점 고정 유니버스 연쇄 실행기 — 매년 1/1에 유니버스를 그 해 목록으로 교체하고,
// 한 해씩 독립 실행한 뒤 **연말 평가액을 다음 해 자본으로 이월**한다(연말 청산 근사).
// 연도별 자산곡선을 이어붙여 전체 MDD·수익÷MDD를 낸다.
//
// 왜 연쇄인가: 유니버스가 해마다 바뀌므로 한 번의 runStrategySpec으로는 표현할 수 없다.
// 대신 "그 해에는 그 해 목록만 봤다"는 인과성(규칙 1)이 구조적으로 보장된다 —
// 어떤 해의 실행도 그 해 12/31 이후 봉을 입력으로 받지 않는다.
//
// 규칙 1(미래참조 금지) 관련 설계:
//   - 각 해의 입력 봉을 `date <= {해}-12-31`로 **자르고** 넘긴다. 뒤 연도를 통째로
//     잘라내도 앞 연도의 매매·자산곡선이 완전히 같아야 한다(tests/pitchain.test.ts).
//   - 유니버스 편입 판정은 "그 종목의 첫 봉이 그 해 상반기 안에 있는가"만 본다 —
//     그 해 이후의 가격·시총을 보지 않는다.
//   - 전 구간 통계(평균·표준편차)를 쓰지 않는다.
//
// 이 모듈은 **순수 함수**다 — 네트워크·localStorage·DOM에 접근하지 않는다.
// 화면(SpecSimulator)과 헤드리스 러너(scripts/spec-backtest)가 같은 함수를 부른다.

import { runStrategySpec, type ConditionResult, type ConditionScreenRow, type CostSettings, type ExitBreakdown } from './conditionScreen'
import type { StrategySpec } from './strategySpec'
import type { DailyBar, EquityPoint, Trade } from './types'
import { PIT_YEARS, pitCodes } from './pitUniverse'

/** 연도별 유니버스 심볼로 그 해 실행할 스펙을 만든다. */
export type MakeSpec = (symbols: string[], year: number) => StrategySpec

export interface PitChainOptions {
  /** 유니버스 코드 → `histories` 키 매핑(예: '005930' → '005930.KS'). 없으면 코드를 그대로 키로 본다. */
  resolve?: (code: string) => string | undefined
  /** 이 날짜 이전 구간은 실행하지 않는다(비우면 목록 첫 해부터). */
  startDate?: string
  /** 이 날짜 이후 봉을 잘라낸다(비우면 데이터 끝까지). */
  endDate?: string
  /** 그 해 매핑된 종목이 이 수 미만이면 표본이 너무 작아 왜곡되므로 **현금 보유**로 처리한다. */
  minSymbols?: number
  /** 벤치마크 일봉 — 연도별·전체 벤치 수익과 자산곡선 겹침에 쓴다(매매 대상 아님). */
  bench?: DailyBar[]
  /** 실행할 연도 목록(기본 PIT_YEARS). */
  years?: number[]
  /** 연도 → 유니버스 코드(기본 pitCodes). */
  codesFor?: (year: number) => string[]
  /**
   * 매매 대상이 아니지만 엔진에 넘겨야 하는 심볼(예: 레짐 판정용 지수).
   * 해당 해 12/31까지로 잘라 매년 함께 넘긴다.
   */
  extraSymbols?: string[]
}

export interface PitYearRow {
  year: number
  /** 그 해 목록 중 가격이 실제로 있는 종목 수 */
  mapped: number
  /** 그 해 목록의 종목 수(보통 20) */
  total: number
  /** 매핑 부족으로 매매하지 않고 현금 보유한 해 */
  cash: boolean
  /** 그 해 전략 수익률(%) — 현금 보유 해는 0 */
  strategyPct: number
  /** 그 해 벤치마크 수익률(%) — 벤치 데이터가 없으면 null */
  benchPct: number | null
  /** 그 해 발생한 매매(진입) 수 */
  trades: number
  /** 실제로 매매 대상이 된 심볼 */
  symbols: string[]
}

export interface PitChainResult {
  /** 연도별 곡선을 이어붙인 전체 자산곡선(벤치 겹침 포함) */
  equity: EquityPoint[]
  /** 전 연도 매매 이력(시간순) */
  trades: Trade[]
  perYear: PitYearRow[]
  startDate: string
  endDate: string
  /** 자산곡선 양끝으로 잰 연수 */
  years: number
  totalPct: number
  cagrPct: number
  /** 최대 낙폭(%) — 0 이하 */
  mddPct: number
  /** 총수익% ÷ |MDD%| — MDD가 0에 가까우면 null */
  objective: number | null
  benchTotalPct: number | null
  benchCagrPct: number | null
  alphaCagrPct: number | null
  alphaTotalPct: number | null
  /** 청산 완료된 매매 수 */
  tradeCount: number
  winRate: number | null
  avgPnlPct: number | null
  /** 각 해 연말에 미청산으로 남아 평가액으로 이월된 포지션 수의 합 */
  openAtEnd: number
  exitBreakdown: ExitBreakdown[]
  /** 마지막으로 실행된 해의 스크리닝 — "왜 걸렸나/왜 떨어졌나" 확인용 */
  lastScreen: ConditionScreenRow[]
  lastScreenDate: string
  /** 연도별 매핑률 평균(%) — 생존편향 잔존 정도를 그대로 드러낸다 */
  mappedAvgPct: number | null
}

/** 두 날짜 사이 연수 (headless 러너·시뮬레이터와 같은 정의) */
export function yearsBetween(a: string, b: string): number {
  return Math.max(1 / 365, (Date.parse(b) - Date.parse(a)) / (365.25 * 86400e3))
}

/** 누적배수 → 연환산 수익률(%) */
export function annualize(totalRatio: number, years: number): number {
  return (Math.pow(Math.max(totalRatio, 1e-9), 1 / years) - 1) * 100
}

const yearStart = (y: number) => `${y}-01-01`
const yearEnd = (y: number) => `${y}-12-31`

/**
 * 연도별 시점 고정 유니버스로 연쇄 백테스트를 돌린다.
 *
 * @param histories 심볼 → 일봉. 여러 해가 나눠 쓰므로 **전 구간을 한 번만** 받아 넘긴다.
 * @param makeSpec  (그 해 심볼, 연도) → 실행 스펙. 유니버스 외 설정은 호출부가 정한다.
 * @param cost      비용 설정. `initialCapital`은 배수 계산의 기준값으로만 쓰인다.
 */
export function runPitChained(
  histories: Record<string, DailyBar[]>,
  makeSpec: MakeSpec,
  cost: CostSettings,
  opts: PitChainOptions = {},
): PitChainResult {
  const years = (opts.years ?? PIT_YEARS).slice().sort((a, b) => a - b)
  const codesFor = opts.codesFor ?? pitCodes
  const resolve = opts.resolve ?? ((code: string) => (histories[code] ? code : undefined))
  const minSymbols = opts.minSymbols ?? 5
  const capital = cost.initialCapital
  const from = opts.startDate || ''
  const to = opts.endDate || ''
  const extras = (opts.extraSymbols ?? []).filter((s) => histories[s]?.length)

  // 벤치마크는 날짜 → 종가 조회로 한 번만 준비한다(연도별 반복 필터링 방지)
  const bench = opts.bench ?? null

  const equity: EquityPoint[] = []
  const trades: Trade[] = []
  const perYear: PitYearRow[] = []
  const exitAgg = new Map<string, { kind: ExitBreakdown['kind']; label: string; n: number; sum: number }>()

  let factor = 1 // 전략 누적배수
  let benchFactor = 1 // 벤치 누적배수(같은 연말 경계로 연쇄)
  let peak = 1
  let mdd = 0
  let openAtEnd = 0
  let lastScreen: ConditionScreenRow[] = []
  let lastScreenDate = ''

  for (const y of years) {
    const ys = yearStart(y)
    const ye = yearEnd(y)
    // 실행 구간과 겹치지 않는 해는 통째로 건너뛴다
    if (to && ys > to) continue
    if (from && ye < from) continue
    const effStart = from && from > ys ? from : ys
    const effEnd = to && to < ye ? to : ye

    const codes = codesFor(y)
    // 편입 판정: 그 해 상반기 안에 이미 상장되어 봉이 있는 종목만. 그 해 이후 정보는 보지 않는다.
    const picked: { code: string; sym: string }[] = []
    for (const code of codes) {
      const sym = resolve(code)
      if (!sym) continue
      const bars = histories[sym]
      if (!bars?.length) continue
      if (bars[0].date > `${y}-06-30`) continue // 그 해 상반기까지 상장되지 않았다
      picked.push({ code, sym })
    }
    // 같은 코드가 두 시장 목록에 겹쳐 들어오는 경우 방지
    const symbols = [...new Set(picked.map((p) => p.sym))]

    // 그 해 실행 입력 — **effEnd 이후 봉을 잘라낸다**(규칙 1의 절단과 같은 조작)
    const hist: Record<string, DailyBar[]> = {}
    for (const s of [...symbols, ...extras]) {
      const cut = histories[s].filter((b) => b.date <= effEnd)
      if (cut.length) hist[s] = cut
    }
    // 매핑률은 "그 해에 실제로 가격이 있었나"로 센다 — 이미 상폐돼 봉이 끊긴 종목을
    // 매핑됐다고 세면 생존편향 경고가 무뎌진다. (effEnd 이후 정보는 보지 않는다)
    const tradable = symbols.filter((s) => hist[s]?.some((b) => b.date >= effStart && b.date <= effEnd))
    // 그 해 안에 거래일이 하나도 없으면(데이터가 여기서 끝남) 그 해는 존재하지 않는다
    if (tradable.length === 0) continue

    const benchInYear = bench ? bench.filter((b) => b.date >= effStart && b.date <= effEnd) : []
    const benchRatioAt = (date: string): number => {
      if (benchInYear.length < 2) return 1
      const first = benchInYear[0].c
      let last = first
      for (const b of benchInYear) {
        if (b.date > date) break
        last = b.c
      }
      return first > 0 ? last / first : 1
    }
    const benchYearRatio = benchInYear.length >= 2 ? benchInYear[benchInYear.length - 1].c / benchInYear[0].c : null

    const tradableCount = tradable.length
    if (tradableCount < minSymbols) {
      // 표본이 너무 작으면 성적이 몇 종목 운에 좌우된다 — 그 해는 현금 보유로 처리하고
      // 자산곡선은 평평하게 이어붙인다(구간을 건너뛰면 연수가 줄어 CAGR이 부풀려진다).
      const dates = [...new Set(Object.values(hist).flatMap((bars) => bars.map((b) => b.date)))]
        .filter((d) => d >= effStart && d <= effEnd)
        .sort()
      const flatDates = dates.length ? dates : benchInYear.map((b) => b.date)
      for (const d of flatDates) {
        const eq = factor
        peak = Math.max(peak, eq)
        mdd = Math.min(mdd, (eq / peak - 1) * 100)
        equity.push({
          date: d,
          equity: eq * capital,
          benchmark: benchFactor * benchRatioAt(d) * capital,
          drawdownPct: (eq / peak - 1) * 100,
        })
      }
      if (benchYearRatio != null) benchFactor *= benchYearRatio
      perYear.push({
        year: y,
        mapped: tradableCount,
        total: codes.length,
        cash: true,
        strategyPct: 0,
        benchPct: benchYearRatio != null ? (benchYearRatio - 1) * 100 : null,
        trades: 0,
        symbols: [],
      })
      continue
    }

    const spec = makeSpec(tradable, y)
    const res: ConditionResult = runStrategySpec(hist, effStart, spec, cost)

    const base = factor
    for (const p of res.equity) {
      const eq = base * (p.equity / capital)
      peak = Math.max(peak, eq)
      const dd = (eq / peak - 1) * 100
      mdd = Math.min(mdd, dd)
      equity.push({
        date: p.date,
        equity: eq * capital,
        benchmark: benchFactor * benchRatioAt(p.date) * capital,
        drawdownPct: dd,
      })
    }
    const finalEq = res.equity.length ? res.equity[res.equity.length - 1].equity : capital
    const yearRatio = finalEq / capital
    factor = base * yearRatio
    if (benchYearRatio != null) benchFactor *= benchYearRatio

    for (const t of res.trades) trades.push(t)
    for (const b of res.exitBreakdown) {
      const cur = exitAgg.get(b.kind) ?? { kind: b.kind, label: b.label, n: 0, sum: 0 }
      cur.n += b.count
      cur.sum += (b.avgPnlPct ?? 0) * b.count
      exitAgg.set(b.kind, cur)
    }
    openAtEnd += res.openAtEnd
    if (res.lastScreen.length) {
      lastScreen = res.lastScreen
      lastScreenDate = res.lastScreenDate
    }

    perYear.push({
      year: y,
      mapped: tradableCount,
      total: codes.length,
      cash: false,
      strategyPct: (yearRatio - 1) * 100,
      benchPct: benchYearRatio != null ? (benchYearRatio - 1) * 100 : null,
      trades: res.trades.length,
      symbols: tradable,
    })
  }

  const spanStart = equity.length ? equity[0].date : from || (years.length ? yearStart(years[0]) : '')
  const spanEnd = equity.length ? equity[equity.length - 1].date : spanStart
  const span = spanStart && spanEnd ? yearsBetween(spanStart, spanEnd) : 1

  const totalPct = (factor - 1) * 100
  const cagrPct = annualize(factor, span)
  const mddAbs = Math.abs(mdd)
  const executedBench = perYear.some((r) => r.benchPct != null)
  const benchTotalPct = executedBench ? (benchFactor - 1) * 100 : null
  const benchCagrPct = benchTotalPct != null ? annualize(benchFactor, span) : null

  const closed = trades.filter((t) => t.exitDate != null)
  const wins = closed.filter((t) => (t.pnlPct ?? 0) > 0).length
  const mappedRows = perYear.filter((r) => r.total > 0)

  return {
    equity,
    trades,
    perYear,
    startDate: spanStart,
    endDate: spanEnd,
    years: span,
    totalPct,
    cagrPct,
    mddPct: mdd,
    objective: mddAbs > 0.01 ? totalPct / mddAbs : null,
    benchTotalPct,
    benchCagrPct,
    alphaCagrPct: benchCagrPct != null ? cagrPct - benchCagrPct : null,
    alphaTotalPct: benchTotalPct != null ? totalPct - benchTotalPct : null,
    tradeCount: closed.length,
    winRate: closed.length ? (wins / closed.length) * 100 : null,
    avgPnlPct: closed.length ? closed.reduce((s, t) => s + (t.pnlPct ?? 0), 0) / closed.length : null,
    openAtEnd,
    exitBreakdown: [...exitAgg.values()].map((v) => ({
      kind: v.kind,
      label: v.label,
      count: v.n,
      avgPnlPct: v.n > 0 ? v.sum / v.n : null,
    })),
    lastScreen,
    lastScreenDate,
    mappedAvgPct: mappedRows.length
      ? (mappedRows.reduce((s, r) => s + r.mapped / r.total, 0) / mappedRows.length) * 100
      : null,
  }
}
