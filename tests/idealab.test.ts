// ⚠️ 이 파일은 scripts/idea-lab.entry.ts에 대한 CLAUDE.md 규칙 1(미래참조 금지)의 집행자다.
//
// 아이디어 랩 3계열(seasonal 오버레이 · monthpat 셀 선정 · pairprem 스위칭)은 전부
// "그 시점까지의 통계"로만 판단해야 한다. 전체 구간 평균·표준편차를 쓰면 백테스트가
// 조용히 미래를 본다(규칙 1-5). 여기서 검증하는 것:
//
//   1) 절단 불변성 — 데이터 뒷부분을 잘라도 잘린 시점 이전의 판정·체결·자산곡선이 동일
//   2) 확장 윈도우 — 월 필터·셀 선정·z-score가 미래 데이터를 포함하지 않음
//   3) 체결 시점 — pairprem 스위칭이 신호 **다음날 시가**에 체결됨 (규칙 1-2)
//   4) 월 게이트가 실제로 신규 진입만 막고 청산은 막지 않음
//   6) 워크포워드 선택이 **선택 시점 이후를 보지 않음** (xswf) — 뒤쪽 데이터를 조작해도
//      그 이전 선택·자산곡선이 불변. 워크포워드는 실수로 전 구간을 보게 되기 가장 쉬운 구조다.
//   7) combo 결합 산술 손계산 대조 + 이월(carry-forward)이 과거 방향으로만 감(환율 포함)
//   8) 미장 유니버스 매핑이 **재사용 티커를 거부**함 (usxsmom)
//   5) flow **T−1 원칙** — D일 진입 판단에 D일 수급을 쓰지 않는다. D일 이후 수급 행을
//      극단값으로 바꿔도 D일까지의 매매·자산곡선이 완전히 같아야 한다(수급판 절단 불변성).
//      더불어 bespoke 시뮬이 필터를 껐을 때 엔진 base와 **전 점 일치**하는지도 여기서 막는다 —
//      갈라지면 A/B가 서로 다른 전략을 비교하는 셈이 된다.
//
// 실데이터(Yahoo)는 컨테이너에서 403이라 전부 합성 시계열로 검증한다.

import { check, close as closeTo, eq, section, finish, rng } from './harness'
import {
  PIT1010,
  MONTH_GATE,
  BASE25,
  RSIREV_DEFAULT,
  alphaOf,
  baselineSpec,
  benchCurve,
  perYearTable,
  stratTable,
  summarizeStrat,
  verdictTable,
  bookBuy,
  bookSell,
  breakoutFill,
  lastCloseBefore,
  momentum12_1,
  newBook,
  runCustomChain,
  runSpecChain,
  shiftMonthStart,
  simulateRsiRevYear,
  simulateVolBrkYear,
  simulateXsMomYear,
  wilderRsi,
  xsmomRank,
  COMBO_XSMOM,
  COST_US,
  WF_CANDS,
  WF_DEFAULT,
  alignCurves,
  blendCurves,
  blendMonthlyRebalanced,
  buildYearlyUs,
  curveStrat,
  holdTable,
  monthlyCorrelation,
  monthlyReturnsOf,
  pearson,
  perYearOfCurve,
  plateauness,
  runWalkForward,
  spanOf,
  stitchYears,
  toKrwCurve,
  valueAsOf,
  wfLabel,
  wfPick,
  yearCurvesOf,
  yearMaxDrawdown,
  type WfCand,
  type WfTable,
  type YearCurve,
  FLOW_BASE,
  FLOW_F2,
  FLOW_F3,
  alignPair,
  binomTail,
  blockedMonthsExpanding,
  buildYearly,
  calendarOf,
  discountOf,
  expandingZ,
  flowEntryPassed,
  flowF1,
  makeFlowLens,
  makeOvS3,
  monthGateBars,
  monthlyRatios,
  monthOf,
  perfOf,
  runFlowChain,
  runOverlayChain,
  selectMonthCells,
  simulateFlowYear,
  simulateMonthPat,
  simulatePairSwitch,
  toDt,
  winnerSpec,
  type CellPick,
  type FlowRow,
  type FlowStore,
  type Overlay,
  type PairBar,
} from '../scripts/idea-lab.entry'
import { runStrategySpec, type CostSettings } from '../src/features/backtest/conditionScreen'
import { sma } from '../src/features/backtest/strategySpec'
import type { DailyBar } from '../src/features/backtest/types'
import { resolveUsTicker } from '../src/features/backtest/usPitUniverse'

const COST: CostSettings = { initialCapital: 10_000_000, feePct: 0.015, taxPct: 0.15, slippagePct: 0.1 }

// ---- 합성 데이터 -----------------------------------------------------------

/** 1999-01-01부터 n일치 일봉(주말 포함 — 달력 경계 판정만 보므로 무해) */
function makeBars(seed: number, n: number, base = 10_000): DailyBar[] {
  const rnd = rng(seed)
  const bars: DailyBar[] = []
  let p = base
  for (let i = 0; i < n; i++) {
    const ret = 0.0004 + 0.025 * (rnd() * 2 - 1)
    const o = p
    const c = Math.max(1, p * (1 + ret))
    bars.push({
      date: new Date(Date.UTC(1999, 0, 1) + i * 86400000).toISOString().slice(0, 10),
      t: 0,
      o,
      h: Math.max(o, c) * (1 + rnd() * 0.012),
      l: Math.min(o, c) * (1 - rnd() * 0.012),
      c,
      v: 1_000_000 + Math.floor(rnd() * 1_000_000),
    })
    p = c
  }
  return bars
}

const YEARS = [2000, 2001, 2002, 2003, 2004, 2005]
const N_DAYS = 2600 // 1999-01-01 ~ 2006-02
const CODES = [...new Set(YEARS.flatMap((y) => [...PIT1010[y].ks, ...PIT1010[y].kq]))]

function makeHistories(): Record<string, DailyBar[]> {
  const h: Record<string, DailyBar[]> = {}
  CODES.forEach((cd, i) => {
    h[cd] = makeBars(20260802 + i * 977, N_DAYS, 5_000 + i * 137)
  })
  return h
}
const HISTORIES = makeHistories()
const BENCH_BARS = makeBars(11111, N_DAYS, 20_000)

function truncate(h: Record<string, DailyBar[]>, cutDate: string): Record<string, DailyBar[]> {
  const out: Record<string, DailyBar[]> = {}
  for (const [s, bars] of Object.entries(h)) out[s] = bars.filter((b) => b.date <= cutDate)
  return out
}

// ============================================================================
section('1) 월 게이트 — 신규 진입만 막고 청산은 막지 않는다')
// ============================================================================
{
  const syms = PIT1010[2002].ks
  const hist: Record<string, DailyBar[]> = {}
  for (const s of syms) hist[s] = HISTORIES[s].filter((b) => b.date >= '2000-01-01' && b.date <= '2004-12-31')
  const dates = calendarOf(hist)

  const open = runStrategySpec(hist, '2000-01-01', winnerSpec(syms, null), COST)
  check('게이트 없으면 매매가 발생한다', open.trades.length > 0, `trades=${open.trades.length}`)

  // (a) 5~10월 금지 — 진입일이 그 달에 하나도 없어야 한다
  const blocked = new Set([5, 6, 7, 8, 9, 10])
  const gated: Record<string, DailyBar[]> = { ...hist }
  gated[MONTH_GATE] = monthGateBars(dates, (d) => !blocked.has(monthOf(d)))
  const r1 = runStrategySpec(gated, '2000-01-01', winnerSpec(syms, MONTH_GATE), COST)
  const badEntry = r1.trades.filter((t) => blocked.has(monthOf(t.entryDate)))
  eq('금지월(5~10월) 신규 진입 = 0', badEntry.length, 0)
  check('허용월 매매는 남아 있다', r1.trades.length > 0, `trades=${r1.trades.length}`)

  // 청산은 금지월에도 일어나야 한다(게이트가 청산까지 막으면 하락장에서 못 파는 모순)
  const exitInBlocked = r1.trades.filter((t) => t.exitDate != null && blocked.has(monthOf(t.exitDate!)))
  check('금지월에도 청산은 발생한다', exitInBlocked.length > 0, `exits in blocked = ${exitInBlocked.length}`)

  // (b) 전월 금지 — 매매 0
  const allBlocked: Record<string, DailyBar[]> = { ...hist }
  allBlocked[MONTH_GATE] = monthGateBars(dates, () => false)
  const r2 = runStrategySpec(allBlocked, '2000-01-01', winnerSpec(syms, MONTH_GATE), COST)
  eq('전월 금지 → 매매 0', r2.trades.length, 0)

  // (c) 전월 허용 → 게이트 없는 결과와 완전히 동일
  const allOpen: Record<string, DailyBar[]> = { ...hist }
  allOpen[MONTH_GATE] = monthGateBars(dates, () => true)
  const r3 = runStrategySpec(allOpen, '2000-01-01', winnerSpec(syms, MONTH_GATE), COST)
  eq('전월 허용 → 매매 수 동일', r3.trades.length, open.trades.length)
  check(
    '전월 허용 → 자산곡선 동일',
    r3.equity.length === open.equity.length && r3.equity.every((e, i) => Object.is(e.equity, open.equity[i].equity)),
  )
  // 게이트 심볼은 매매 대상이 아니다
  check('게이트 심볼이 유니버스에 없다', !r3.universe.includes(MONTH_GATE))
}

// ============================================================================
section('2) 오버레이 연쇄 — 절단 불변성')
// ============================================================================
{
  const benchMonthlyFull = monthlyRatios(BENCH_BARS)
  const ovs: Overlay[] = [
    { key: 'base', label: 'base', blockedMonths: () => new Set(), segments: (y) => [{ start: `${y}-01-01`, end: `${y}-12-31` }] },
    {
      key: 'S1',
      label: 'S1',
      blockedMonths: () => new Set([5, 6, 7, 8, 9, 10]),
      segments: (y) => [{ start: `${y}-01-01`, end: `${y}-12-31` }],
    },
    {
      key: 'S2',
      label: 'S2',
      blockedMonths: () => new Set([5, 6, 7, 8, 9, 10]),
      segments: (y) => [
        { start: `${y}-01-01`, end: `${y}-04-30` },
        { start: `${y}-11-01`, end: `${y}-12-31` },
      ],
    },
    makeOvS3(benchMonthlyFull, 2),
  ]

  const CUT = '2003-07-15' // 2003년 한가운데를 자른다
  const KEEP = [2000, 2001, 2002] // 절단 이전에 완결된 해
  const truncHist = truncate(HISTORIES, CUT)
  // S3의 벤치 통계도 함께 잘라야 "그 시점의 세계"가 된다
  const benchMonthlyCut = monthlyRatios(BENCH_BARS.filter((b) => b.date <= CUT))

  for (const ov of ovs) {
    const full = runOverlayChain(buildYearly(HISTORIES, YEARS), ov, COST)
    const ovCut = ov.key === 'S3' ? makeOvS3(benchMonthlyCut, 2) : ov
    const cut = runOverlayChain(buildYearly(truncHist, [2000, 2001, 2002, 2003]), ovCut, COST)

    const fy = new Map(full.perYear.map((p) => [p.y, p.ret]))
    const cy = new Map(cut.perYear.map((p) => [p.y, p.ret]))
    const sameYears = KEEP.every((y) => Object.is(fy.get(y), cy.get(y)))
    check(`[${ov.key}] 절단 전 연도 수익 동일`, sameYears, KEEP.map((y) => `${y}:${fy.get(y)} vs ${cy.get(y)}`).join(' '))

    const lim = `${KEEP[KEEP.length - 1]}-12-31`
    const fe = full.equity.filter((e) => e.date <= lim)
    const ce = cut.equity.filter((e) => e.date <= lim)
    check(
      `[${ov.key}] 절단 전 자산곡선 동일 (${fe.length}점)`,
      fe.length > 100 && fe.length === ce.length && fe.every((e, i) => e.date === ce[i].date && Object.is(e.equity, ce[i].equity)),
      `full=${fe.length} cut=${ce.length}`,
    )
  }

  // 오버레이가 실제로 결과를 바꾸는지 (테스트가 무의미한 동일값 비교가 되지 않도록)
  const base = runOverlayChain(buildYearly(HISTORIES, YEARS), ovs[0], COST)
  const s1 = runOverlayChain(buildYearly(HISTORIES, YEARS), ovs[1], COST)
  check('S1이 base와 다른 결과를 낸다', !Object.is(base.equity[base.equity.length - 1].equity, s1.equity[s1.equity.length - 1].equity))
  check('base 매매가 충분히 발생한다', base.trades > 20, `trades=${base.trades}`)
  check('S2는 5~10월 자산곡선 점이 없다', !runOverlayChain(buildYearly(HISTORIES, YEARS), ovs[2], COST).equity.some((e) => {
    const m = monthOf(e.date)
    return m >= 5 && m <= 10
  }))
}

// ============================================================================
section('3) S3 동적 월 필터 — 확장 윈도우 (미래 미포함)')
// ============================================================================
{
  const full = monthlyRatios(BENCH_BARS)
  for (const y of [2003, 2004, 2005]) {
    // 그 해 1월 초 시점에 존재하지 않던 데이터를 잘라도 판정이 같아야 한다
    const cut = monthlyRatios(BENCH_BARS.filter((b) => b.date < `${y}-01-01`))
    const a = [...blockedMonthsExpanding(full, y, 2)].sort((p, q) => p - q).join(',')
    const b = [...blockedMonthsExpanding(cut, y, 2)].sort((p, q) => p - q).join(',')
    eq(`${y}년 금지월이 미래 데이터와 무관`, a, b)
  }
  // 표본 부족이면 필터 없음
  eq('표본 8년 미만 → 필터 없음', blockedMonthsExpanding(full, 2001, 8).size, 0)
  // 필터가 실제로 뭔가 막긴 하는지 (항상 빈 집합이면 위 테스트가 무의미해진다)
  const anyBlocked = [2004, 2005, 2006].some((y) => blockedMonthsExpanding(full, y, 2).size > 0)
  check('어떤 해에는 금지월이 실제로 생긴다', anyBlocked)
}

// ============================================================================
section('4) monthpat 셀 선정 — 확장 윈도우 (미래 미포함)')
// ============================================================================
{
  const monthlyFull: Record<string, Map<string, number>> = {}
  for (const [s, bars] of Object.entries(HISTORIES)) monthlyFull[s] = monthlyRatios(bars)

  for (const y of [2003, 2005]) {
    const monthlyCut: Record<string, Map<string, number>> = {}
    for (const [s, bars] of Object.entries(HISTORIES))
      monthlyCut[s] = monthlyRatios(bars.filter((b) => b.date < `${y}-01-01`))
    const key = (p: CellPick[]) => p.map((x) => `${x.symbol}/${x.month}/${x.n}/${x.hits}/${x.meanPct.toFixed(9)}`).join('|')
    const a = selectMonthCells(monthlyFull, y, { minSample: 2, minHitRatio: 0.65 })
    const b = selectMonthCells(monthlyCut, y, { minSample: 2, minHitRatio: 0.65 })
    eq(`${y}년 셀 선정이 미래 데이터와 무관`, key(a), key(b))
    check(`${y}년 셀이 실제로 선정된다`, a.length > 0, `cells=${a.length}`)
  }

  // 선정 기준이 지켜지는지
  const picks = selectMonthCells(monthlyFull, 2005, { minSample: 4, minHitRatio: 0.65 })
  check(
    '선정 셀은 전부 n≥4 · 적중률≥65% · 평균>0',
    picks.every((p) => p.n >= 4 && p.hits / p.n >= 0.65 && p.meanPct > 0),
  )
}

// ============================================================================
section('5) monthpat 시뮬 — 절단 불변성')
// ============================================================================
{
  const monthly: Record<string, Map<string, number>> = {}
  for (const [s, bars] of Object.entries(HISTORIES)) monthly[s] = monthlyRatios(bars)
  const cells = new Map<number, CellPick[]>()
  for (const y of YEARS) cells.set(y, selectMonthCells(monthly, y, { minSample: 2, minHitRatio: 0.6 }))

  const CUT = '2004-05-20'
  const full = simulateMonthPat(HISTORIES, cells, COST, '2001-01-01')
  const cut = simulateMonthPat(truncate(HISTORIES, CUT), cells, COST, '2001-01-01')
  const fe = full.equity.filter((e) => e.date <= CUT)
  const ce = cut.equity.filter((e) => e.date <= CUT)
  check(
    `절단 전 자산곡선 동일 (${fe.length}점)`,
    fe.length > 500 && fe.length === ce.length && fe.every((e, i) => e.date === ce[i].date && Object.is(e.equity, ce[i].equity)),
    `full=${fe.length} cut=${ce.length}`,
  )
  check('리밸런스가 실제로 발생한다', full.rebalances > 10, `rebalances=${full.rebalances}`)
  check('비용이 누적된다', full.costPaid > 0)

  // 셀이 없으면 현금 — 자산이 변하지 않아야 한다
  const noCells = simulateMonthPat(HISTORIES, new Map(), COST, '2001-01-01')
  check(
    '셀 없음 → 전 구간 현금(자산 불변)',
    noCells.equity.every((e) => Object.is(e.equity, COST.initialCapital)),
  )
}

// ============================================================================
section('6) pairprem — 확장 윈도우 z + 절단 불변성 + 익일 시가 체결')
// ============================================================================
{
  const common = makeBars(777001, 1600, 30_000)
  // 우선주는 보통주에 연동되되 자체 노이즈로 괴리가 벌어졌다 좁혀지게 만든다
  const rnd = rng(424242)
  const pref: DailyBar[] = common.map((b, i) => {
    const wobble = 0.72 + 0.10 * Math.sin(i / 90) + 0.02 * (rnd() * 2 - 1)
    return { ...b, o: b.o * wobble, h: b.h * wobble, l: b.l * wobble, c: b.c * wobble }
  })
  const bars: PairBar[] = alignPair(common, pref)
  eq('정렬 봉 수', bars.length, common.length)

  const WARM = 300
  const d = bars.map(discountOf)
  const z = expandingZ(d, WARM)
  eq('워밍업 이전은 신호 없음', z.slice(0, WARM - 1).every((v) => v === null), true)
  check('워밍업 이후 z가 산출된다', z[WARM] != null)

  // (a) 확장 윈도우 — 뒤를 잘라도 앞의 z가 그대로
  const CUT_I = 1200
  const zCut = expandingZ(d.slice(0, CUT_I), WARM)
  check(
    'z 절단 불변 (앞 구간 완전 동일)',
    zCut.every((v, i) => Object.is(v, z[i])),
  )

  // (b) 시뮬 절단 불변성 — 경계 한 칸 앞까지 비교(마지막 봉은 신호를 만들지 않는다)
  const full = simulatePairSwitch(bars, z, 1.5, 0, COST)
  const cutR = simulatePairSwitch(bars.slice(0, CUT_I), zCut, 1.5, 0, COST)
  const boundary = bars[CUT_I - 2].date
  const fe = full.equity.filter((e) => e.date <= boundary)
  const ce = cutR.equity.filter((e) => e.date <= boundary)
  check(
    `자산곡선 절단 불변 (${fe.length}점)`,
    fe.length === ce.length && fe.every((e, i) => e.date === ce[i].date && Object.is(e.equity, ce[i].equity)),
    `full=${fe.length} cut=${ce.length}`,
  )
  const fs = full.switches.filter((s) => s.date <= boundary)
  const cs = cutR.switches.filter((s) => s.date <= boundary)
  check(
    `스위칭 이력 절단 불변 (${fs.length}회)`,
    fs.length > 0 && fs.length === cs.length &&
      fs.every((s, i) => s.date === cs[i].date && s.to === cs[i].to && Object.is(s.price, cs[i].price)),
    `full=${fs.length} cut=${cs.length}`,
  )

  // (c) 체결 시점 — 신호 다음 거래일 시가
  const idxOf = new Map(bars.map((b, i) => [b.date, i]))
  let okTiming = true
  let okPrice = true
  let okSignal = true
  for (const s of full.switches) {
    const si = idxOf.get(s.signalDate)!
    const ei = idxOf.get(s.date)!
    if (ei !== si + 1) okTiming = false
    const expected = s.to === 'pref' ? bars[ei].oP : bars[ei].oC
    if (!Object.is(s.price, expected)) okPrice = false
    // 그 신호일의 z가 실제로 임계를 넘겼는지 (되돌아보기 검증)
    const zi = z[si]
    if (zi == null) okSignal = false
    else if (s.to === 'pref' ? !(zi > 1.5) : !(zi < 0)) okSignal = false
  }
  check(`체결일 = 신호일 다음 봉 (${full.switches.length}회 전수)`, full.switches.length > 0 && okTiming)
  check('체결 기준가 = 그 봉의 시가', okPrice)
  check('모든 스위칭이 임계 조건을 실제로 만족한 신호에서 나왔다', okSignal)
  check('마지막 봉에서 신규 스위칭을 만들지 않는다', full.switches.every((s) => s.signalDate !== bars[bars.length - 1].date))

  // (d) 임계값을 올리면 스위칭이 늘지 않는다(단조성 — 로직 sanity)
  const hi = simulatePairSwitch(bars, z, 2.0, 0, COST)
  check('임계 z 2.0 스위칭 ≤ z 1.5 스위칭', hi.switches.length <= full.switches.length, `${hi.switches.length} vs ${full.switches.length}`)
}

// ============================================================================
section('7) 보조 함수')
// ============================================================================
{
  // perfOf
  const eqCurve = [
    { date: '2020-01-01', equity: 100 },
    { date: '2020-06-30', equity: 50 },
    { date: '2021-01-01', equity: 200 },
  ]
  const p = perfOf(eqCurve)
  check('총수익 +100%', Math.abs(p.total - 100) < 1e-9, `${p.total}`)
  check('MDD -50%', Math.abs(p.mdd + 50) < 1e-9, `${p.mdd}`)
  check('수익÷MDD = 2', Math.abs((p.obj ?? 0) - 2) < 1e-9, `${p.obj}`)
  // 창 밖 구간은 제외
  const half = perfOf(eqCurve, '2020-06-01')
  check('구간 지정이 동작한다', Math.abs(half.total - 300) < 1e-9, `${half.total}`)

  // binomTail — P(X≥k), Bin(n,0.5)
  check('P(X≥0 | n=8) = 1', Math.abs(binomTail(8, 0, 0.5) - 1) < 1e-12)
  check('P(X≥8 | n=8) = 1/256', Math.abs(binomTail(8, 8, 0.5) - 1 / 256) < 1e-12)
  check('P(X≥6 | n=8) = 37/256', Math.abs(binomTail(8, 6, 0.5) - 37 / 256) < 1e-12)
  check('P(X≥9 | n=8) = 0', binomTail(8, 9, 0.5) === 0)

  // monthlyRatios
  const mr = monthlyRatios([
    { date: '2020-01-02', t: 0, o: 1, h: 1, l: 1, c: 100, v: 1 },
    { date: '2020-01-31', t: 0, o: 1, h: 1, l: 1, c: 110, v: 1 },
    { date: '2020-02-03', t: 0, o: 1, h: 1, l: 1, c: 200, v: 1 },
    { date: '2020-02-28', t: 0, o: 1, h: 1, l: 1, c: 180, v: 1 },
  ])
  check('1월 비율 1.1', Math.abs((mr.get('2020-01') ?? 0) - 1.1) < 1e-12)
  check('2월 비율 0.9', Math.abs((mr.get('2020-02') ?? 0) - 0.9) < 1e-12)

  // monthGateBars — 각 봉이 그 날짜만으로 결정된다
  const gb = monthGateBars(['2020-05-01', '2020-11-01'], (dt) => monthOf(dt) === 11)
  check('금지월 봉은 음봉', gb[0].c < gb[0].o)
  check('허용월 봉은 양봉', gb[1].c > gb[1].o)

  // buildYearly — 그 해 6-30 이후 상장 종목은 편입하지 않는다
  const late = { ...HISTORIES, [PIT1010[2001].ks[0]]: HISTORIES[PIT1010[2001].ks[0]].filter((b) => b.date >= '2001-07-01') }
  const ys = buildYearly(late, [2001])
  check('연중 늦게 상장한 종목은 그 해 유니버스에서 제외', !ys[0].syms.includes(PIT1010[2001].ks[0]))
}

// ============================================================================
section('8) flow — 수급 조건 (T−1 원칙 · 연속판정 · 랭킹 · 결측 보수처리)')
// ============================================================================
{
  const syms = PIT1010[2002].ks
  const RANGE_A = '2000-01-01'
  const RANGE_B = '2004-12-31'
  const hist: Record<string, DailyBar[]> = {}
  for (const s of syms) hist[s] = HISTORIES[s].filter((b) => b.date >= RANGE_A && b.date <= RANGE_B)

  /** 합성 수급 — 가격 봉과 같은 날짜에 부호 있는 순매수를 만든다 */
  function makeFlows(codes: string[], bars: Record<string, DailyBar[]>, seed: number): FlowStore {
    const store: FlowStore = {}
    codes.forEach((cd, i) => {
      const rnd = rng(seed + i * 7919)
      const rows: FlowRow[] = []
      for (const b of bars[cd] ?? []) {
        const frgn = Math.round((rnd() - 0.45) * 200_000)
        const orgn = Math.round((rnd() - 0.5) * 150_000)
        rows.push({
          dt: toDt(b.date),
          indNet: -(frgn + orgn),
          frgnNet: frgn,
          orgnNet: orgn,
          accTrdePrica: Math.round(b.c * b.v),
          curPrc: Math.round(b.c),
        })
      }
      store[cd] = rows
    })
    return store
  }

  // ---- (0) 자기검증: bespoke 루프 ≡ 엔진 (필터를 끄면 완전히 같아야 한다) -----
  // 이게 깨지면 아래 A/B 수치는 전부 무의미하다 — base가 다른 전략이 되어 버린다.
  {
    const emptyLens = makeFlowLens({})
    const eng = runStrategySpec(hist, RANGE_A, winnerSpec(syms, null), COST)
    const bes = simulateFlowYear(hist, RANGE_A, syms, COST, FLOW_BASE, emptyLens)
    check('엔진 base에서 매매가 발생한다(표본 유효)', eng.trades.length > 0, `trades=${eng.trades.length}`)
    eq('bespoke base 자산곡선 길이 = 엔진', bes.equity.length, eng.equity.length)
    const same =
      bes.equity.length === eng.equity.length &&
      bes.equity.every((e, i) => e.date === eng.equity[i].date && Object.is(e.equity, eng.equity[i].equity))
    check('bespoke base 자산곡선이 엔진과 전 점 동일', same)
    eq('bespoke base 매매수 = 엔진', bes.trades, eng.trades.length)
    eq('bespoke base 미청산수 = 엔진', bes.openAtEnd, eng.openAtEnd)
    eq('필터 없는 base는 수급을 조회하지 않는다', bes.evaluated, 0)
  }

  // ---- (1) T−1 원칙 — 렌즈는 결정일 당일 수급을 절대 반환하지 않는다 ---------
  {
    const store: FlowStore = {
      A: [
        { dt: '20200102', indNet: 0, frgnNet: 10, orgnNet: 10, accTrdePrica: 100, curPrc: 10 },
        { dt: '20200103', indNet: 0, frgnNet: 20, orgnNet: 20, accTrdePrica: 100, curPrc: 10 },
        { dt: '20200106', indNet: 0, frgnNet: 30, orgnNet: 30, accTrdePrica: 100, curPrc: 10 },
        { dt: '20200107', indNet: 0, frgnNet: 40, orgnNet: 40, accTrdePrica: 100, curPrc: 10 },
      ],
    }
    const lens = makeFlowLens(store)
    const w = lens.before('A', '2020-01-06', 5)
    check('결정일 당일(dt = D) 행은 창에 들어오지 않는다', w.every((r) => r.dt < '20200106'), JSON.stringify(w.map((r) => r.dt)))
    eq('D=2020-01-06 창 크기(0102·0103)', w.length, 2)
    eq('창은 과거→최근 순', w[w.length - 1].dt, '20200103')
    eq('창 상한 k를 넘지 않는다', lens.before('A', '2020-01-08', 2).length, 2)
    eq('가장 이른 날은 빈 창', lens.before('A', '2020-01-02', 5).length, 0)
    eq('없는 종목은 빈 창', lens.before('ZZZ', '2020-01-08', 5).length, 0)
    check('has()는 데이터 유무를 그대로 보고한다', lens.has('A') && !lens.has('ZZZ'))
  }

  // ---- (2) 절단 불변성 — D일 이후 수급을 바꿔도 D일까지의 매매·자산곡선 불변 --
  // "D일 수급을 D일 판단에 쓰면 실패하는" 케이스다. D일 이후 행을 극단값으로 뒤집어도
  // D일까지의 곡선이 1원이라도 달라지면 어딘가에서 미래 수급을 봤다는 뜻이다.
  {
    const CUT = '2002-06-14'
    const cutDt = toDt(CUT)
    const base = makeFlows(syms, hist, 424242)
    const mutated: FlowStore = {}
    for (const [sym, rows] of Object.entries(base))
      mutated[sym] = rows.map((r) =>
        r.dt >= cutDt
          ? { ...r, frgnNet: -99_000_000, orgnNet: -99_000_000, indNet: 198_000_000, accTrdePrica: 1, curPrc: r.curPrc * 3 }
          : r,
      )
    const yearly = buildYearly(hist, [2000, 2001, 2002, 2003, 2004])
    const lensA = makeFlowLens(base)
    const lensB = makeFlowLens(mutated)

    for (const v of [flowF1(3), flowF1(5), FLOW_F2, FLOW_F3]) {
      const a = runFlowChain(yearly, v, lensA, COST)
      const b = runFlowChain(yearly, v, lensB, COST)
      const ea = a.equity.filter((e) => e.date <= CUT)
      const eb = b.equity.filter((e) => e.date <= CUT)
      check(`${v.key}: 절단 전 곡선 길이 동일`, ea.length === eb.length && ea.length > 100, `${ea.length} vs ${eb.length}`)
      const same = ea.every((e, i) => e.date === eb[i].date && Object.is(e.equity, eb[i].equity))
      check(`${v.key}: D일 이후 수급을 바꿔도 D일까지 자산곡선 불변 (T−1)`, same)
    }

    // 위 불변성이 "아무 일도 안 일어나서" 성립한 게 아님을 확인한다.
    // F1·F3(필터형)은 후보를 탈락시키므로 수급이 바뀌면 뒤 구간이 바로 달라진다.
    for (const v of [flowF1(3), flowF1(5), FLOW_F3]) {
      const a = runFlowChain(yearly, v, lensA, COST)
      const b = runFlowChain(yearly, v, lensB, COST)
      const tailDiff = a.equity.length !== b.equity.length || a.equity.some((e, i) => !Object.is(e.equity, b.equity[i]?.equity))
      check(`${v.key}: 절단 후 구간은 달라진다(테스트가 실제로 무언가를 재고 있다)`, tailDiff)
    }

    // F2(랭킹형)는 **슬롯이 구속될 때만** 결과를 바꾼다 — 후보가 빈 슬롯보다 적으면
    // 순서를 어떻게 매겨도 전원 진입이라 base와 같아진다(유니버스 10 · 슬롯 10이 그렇다).
    // 그래서 랭킹이 실제로 구속되는 슬롯 1개 상황에서 다시 잰다.
    {
      const base1 = simulateFlowYear(hist, RANGE_A, syms, COST, FLOW_BASE, lensA, 1)
      const f2a = simulateFlowYear(hist, RANGE_A, syms, COST, FLOW_F2, lensA, 1)
      const f2b = simulateFlowYear(hist, RANGE_A, syms, COST, FLOW_F2, lensB, 1)
      const diff = (x: { equity: { equity: number }[] }, y: { equity: { equity: number }[] }) =>
        x.equity.length !== y.equity.length || x.equity.some((e, i) => !Object.is(e.equity, y.equity[i]?.equity))
      check('F2: 슬롯이 구속되면 거래대금 랭킹(base)과 다른 종목을 고른다', diff(f2a, base1))
      const pa = f2a.equity.filter((e) => e.date <= CUT)
      const pb = f2b.equity.filter((e) => e.date <= CUT)
      check(
        'F2: 슬롯 구속 상황에서도 D일 이후 수급 변경이 D일까지에 영향 없다 (T−1)',
        pa.length === pb.length && pa.length > 100 && pa.every((e, i) => e.date === pb[i].date && Object.is(e.equity, pb[i].equity)),
      )
    }
  }

  // ---- (2b) 랭킹 구속 시나리오 — 후보 2 · 슬롯 1을 손으로 만들어 결정적으로 검증 --
  // 무작위 표본은 "후보가 슬롯보다 많은 날"이 우연히 안 생길 수 있어, F2가 실제로
  // 선택을 바꾸는지·그때도 T−1이 지켜지는지를 확정적인 데이터로 못 박는다.
  {
    const N = 60
    const dateAt = (i: number) => new Date(Date.UTC(1999, 0, 1) + i * 86400000).toISOString().slice(0, 10)
    /** 30일 평탄(1000) → 30일차에 1100으로 점프(= MA10 상향돌파 + 20일 신고가) → 이후 추세 */
    const ramp = (drift: number, vol: number): DailyBar[] =>
      Array.from({ length: N }, (_, i) => {
        const c = i < 30 ? 1000 : 1100 * Math.pow(drift, i - 30)
        return { date: dateAt(i), t: 0, o: c, h: c, l: c, c, v: vol }
      })
    // DOWN은 거래대금이 2배라 base(거래대금 랭킹)가 먼저 고른다. 진입 후 하락한다.
    const twoHist: Record<string, DailyBar[]> = { DOWN: ramp(0.98, 2_000_000), UP: ramp(1.02, 1_000_000) }
    const twoSyms = ['DOWN', 'UP']
    const DECIDE = dateAt(30)

    eq('시나리오: 결정일에 DOWN이 진입 조건을 만족', flowEntryPassed(twoHist.DOWN, 30), true)
    eq('시나리오: 결정일에 UP도 진입 조건을 만족', flowEntryPassed(twoHist.UP, 30), true)

    const mkFlow = (net: number, px = 1000): FlowRow[] =>
      Array.from({ length: N }, (_, i) => ({ dt: toDt(dateAt(i)), indNet: -net, frgnNet: net, orgnNet: 0, accTrdePrica: 1_000_000_000, curPrc: px }))
    // UP 쪽 수급이 강한 캐시 / DOWN 쪽 수급이 강한 캐시
    const lensUpHot = makeFlowLens({ DOWN: mkFlow(-500_000), UP: mkFlow(500_000) })
    const lensDownHot = makeFlowLens({ DOWN: mkFlow(500_000), UP: mkFlow(-500_000) })

    const fin = (r: { equity: { equity: number }[] }) => r.equity[r.equity.length - 1].equity
    const baseOne = simulateFlowYear(twoHist, dateAt(0), twoSyms, COST, FLOW_BASE, lensUpHot, 1)
    const f2Up = simulateFlowYear(twoHist, dateAt(0), twoSyms, COST, FLOW_F2, lensUpHot, 1)
    const f2Down = simulateFlowYear(twoHist, dateAt(0), twoSyms, COST, FLOW_F2, lensDownHot, 1)

    check('base(거래대금 랭킹)는 거래대금 큰 DOWN을 골라 손실', fin(baseOne) < COST.initialCapital, String(fin(baseOne)))
    check('F2는 수급강도 큰 UP을 골라 수익 — 랭킹이 실제로 선택을 바꾼다', fin(f2Up) > COST.initialCapital, String(fin(f2Up)))
    check(
      'F2 수급을 뒤집으면 base와 같은 DOWN을 고른다(자산곡선 전 점 동일)',
      f2Down.equity.length === baseOne.equity.length && f2Down.equity.every((e, i) => Object.is(e.equity, baseOne.equity[i].equity)),
    )

    // T−1의 핵심 — **결정일 당일** 수급만 뒤집는다. 그날 판단이 바뀌면 미래참조다.
    const flipDecideDay = (rows: FlowRow[], net: number) => rows.map((r) => (r.dt === toDt(DECIDE) ? { ...r, frgnNet: net, indNet: -net } : r))
    const lensFlipped = makeFlowLens({
      DOWN: flipDecideDay(mkFlow(-500_000), 9_000_000_000),
      UP: flipDecideDay(mkFlow(500_000), -9_000_000_000),
    })
    const f2Flip = simulateFlowYear(twoHist, dateAt(0), twoSyms, COST, FLOW_F2, lensFlipped, 1)
    check(
      'D일 수급을 극단으로 뒤집어도 D일 진입 판정 불변 (T−1 — 이게 깨지면 미래참조)',
      f2Flip.equity.length === f2Up.equity.length && f2Flip.equity.every((e, i) => Object.is(e.equity, f2Up.equity[i].equity)),
    )
    // 대조군: **직전일** 수급을 같은 크기로 뒤집으면 판정이 실제로 바뀌어야 한다
    const flipPrevDay = (rows: FlowRow[], net: number) => rows.map((r) => (r.dt === toDt(dateAt(29)) ? { ...r, frgnNet: net, indNet: -net } : r))
    const lensPrevFlipped = makeFlowLens({
      DOWN: flipPrevDay(mkFlow(-500_000), 9_000_000_000),
      UP: flipPrevDay(mkFlow(500_000), -9_000_000_000),
    })
    const f2Prev = simulateFlowYear(twoHist, dateAt(0), twoSyms, COST, FLOW_F2, lensPrevFlipped, 1)
    check(
      '대조군: 직전일(D−1) 수급을 뒤집으면 선택이 바뀐다(렌즈가 과거는 제대로 본다)',
      f2Prev.equity.some((e, i) => !Object.is(e.equity, f2Up.equity[i]?.equity)),
    )
  }

  // ---- (3) 연속 순매수 판정 산술 (F1) ----------------------------------------
  {
    const mk = (dt: string, f: number, o = 1): FlowRow => ({ dt, indNet: 0, frgnNet: f, orgnNet: o, accTrdePrica: 100, curPrc: 10 })
    const lensPos = makeFlowLens({
      A: [mk('20200102', 5), mk('20200103', 7), mk('20200106', 9), mk('20200107', 11), mk('20200108', -999)],
    })
    // D=2020-01-08 → 창은 0102·0103·0106·0107 (당일 -999는 보이지 않는다)
    eq('F1(3): 직전 3일 모두 +면 통과', flowF1(3).admits!(lensPos, 'A', '2020-01-08'), true)
    eq('F1(3): 당일 대량 매도(-999)는 판정에 영향 없다', flowF1(3).admits!(lensPos, 'A', '2020-01-08'), true)

    const lensMid = makeFlowLens({
      A: [mk('20200102', 5), mk('20200103', 7), mk('20200106', -1), mk('20200107', 11)],
    })
    // D=2020-01-08 창(과거→최근) = 0102(+5) · 0103(+7) · 0106(−1) · 0107(+11)
    eq('F1(3): 창 안에 음수 하나면 불통과', flowF1(3).admits!(lensMid, 'A', '2020-01-08'), false)
    eq('F1(2): 창이 0106(−1)까지 닿으면 불통과', flowF1(2).admits!(lensMid, 'A', '2020-01-08'), false)
    eq('F1(1): 직전 1일(0107 +11)만 보면 통과', flowF1(1).admits!(lensMid, 'A', '2020-01-08'), true)
    eq('F1(4): 창이 길어져도 음수가 남아 불통과', flowF1(4).admits!(lensMid, 'A', '2020-01-08'), false)

    const lensZero = makeFlowLens({ A: [mk('20200102', 5), mk('20200103', 0), mk('20200106', 9)] })
    eq('F1(3): 0은 순매수(+)가 아니다 → 불통과', flowF1(3).admits!(lensZero, 'A', '2020-01-07'), false)

    // F3 — 직전 1영업일 외국인·기관 동반 +
    const lensBoth = makeFlowLens({ A: [mk('20200106', 5, 5), mk('20200107', 3, -1)] })
    eq('F3: 직전일 외국인+·기관+ → 통과', FLOW_F3.admits!(lensBoth, 'A', '2020-01-07'), true)
    eq('F3: 직전일 기관이 음수면 불통과', FLOW_F3.admits!(lensBoth, 'A', '2020-01-08'), false)
  }

  // ---- (4) 수급강도 랭킹 정렬 (F2) -------------------------------------------
  {
    const row = (dt: string, f: number, o: number, px: number, val: number): FlowRow => ({
      dt,
      indNet: 0,
      frgnNet: f,
      orgnNet: o,
      accTrdePrica: val,
      curPrc: px,
    })
    const dts = ['20200102', '20200103', '20200106', '20200107', '20200108']
    // HOT: 매일 (100+100)주 × 1,000원 = 200,000원 순매수 / 거래대금 1,000,000원 → 0.2
    // MID: 매일 (50+0)주 × 1,000원 = 50,000원 / 1,000,000원 → 0.05
    // COLD: 매일 순매도 → 음수
    const store: FlowStore = {
      HOT: dts.map((d) => row(d, 100, 100, 1000, 1_000_000)),
      MID: dts.map((d) => row(d, 50, 0, 1000, 1_000_000)),
      COLD: dts.map((d) => row(d, -100, -100, 1000, 1_000_000)),
    }
    const lens = makeFlowLens(store)
    const D = '2020-01-09'
    const kHot = FLOW_F2.rankKey!(lens, 'HOT', D)
    const kMid = FLOW_F2.rankKey!(lens, 'MID', D)
    const kCold = FLOW_F2.rankKey!(lens, 'COLD', D)
    check('F2 강도 HOT = 0.2 (Σ순매수대금 ÷ Σ거래대금)', Math.abs((kHot ?? 0) - 0.2) < 1e-12, String(kHot))
    check('F2 강도 MID = 0.05', Math.abs((kMid ?? 0) - 0.05) < 1e-12, String(kMid))
    check('F2 강도 COLD = −0.2 (순매도는 음수)', Math.abs((kCold ?? 0) + 0.2) < 1e-12, String(kCold))

    // 정렬 — 시뮬과 같은 비교자(내림차순, 동점은 원래 순서 유지)
    const keys = [
      { sym: 'COLD', key: kCold ?? -Infinity },
      { sym: 'MID', key: kMid ?? -Infinity },
      { sym: 'HOT', key: kHot ?? -Infinity },
      { sym: 'NONE', key: -Infinity },
    ]
    const sorted = [...keys].sort((a, b) => (a.key === b.key ? 0 : (a.key - b.key) * -1))
    eq('F2 정렬 1위 = 강도 최고(HOT)', sorted[0].sym, 'HOT')
    eq('F2 정렬 2위 = MID', sorted[1].sym, 'MID')
    eq('F2 정렬 3위 = COLD', sorted[2].sym, 'COLD')
    eq('F2 정렬 최하위 = 데이터 없음(−Infinity)', sorted[3].sym, 'NONE')

    // 거래대금이 커지면 같은 순매수라도 강도가 낮아진다(정규화가 실제로 걸린다)
    const dilute = makeFlowLens({ HOT: dts.map((d) => row(d, 100, 100, 1000, 4_000_000)) })
    check('F2: 거래대금이 4배면 강도는 1/4', Math.abs((FLOW_F2.rankKey!(dilute, 'HOT', D) ?? 0) - 0.05) < 1e-12)
  }

  // ---- (5) 결측 시 보수적 처리 ------------------------------------------------
  {
    const mk = (dt: string, f: number): FlowRow => ({ dt, indNet: 0, frgnNet: f, orgnNet: f, accTrdePrica: 100, curPrc: 10 })
    const short = makeFlowLens({ A: [mk('20200102', 5), mk('20200103', 5)] })
    eq('F1(3): 창이 안 차면 null(=판정 불가)', flowF1(3).admits!(short, 'A', '2020-01-06'), null)
    eq('F1(5): 창이 안 차면 null', flowF1(5).admits!(short, 'A', '2020-01-06'), null)
    eq('F2: 5일 미만이면 null', FLOW_F2.rankKey!(short, 'A', '2020-01-06'), null)
    eq('F3: 직전 행이 없으면 null', FLOW_F3.admits!(makeFlowLens({ A: [] }), 'A', '2020-01-06'), null)
    eq('F2: 거래대금 합이 0이면 null(0 나눗셈 방지)', FLOW_F2.rankKey!(
      makeFlowLens({ A: ['20200102', '20200103', '20200106', '20200107', '20200108'].map((d) => ({ dt: d, indNet: 0, frgnNet: 1, orgnNet: 1, accTrdePrica: 0, curPrc: 10 })) }),
      'A',
      '2020-01-09',
    ), null)

    // 시뮬 수준 — 수급 캐시가 통째로 비면 필터형 가설은 **한 건도 진입하지 않는다**
    const noLens = makeFlowLens({})
    for (const v of [flowF1(3), flowF1(5), FLOW_F3]) {
      const r = simulateFlowYear(hist, RANGE_A, syms, COST, v, noLens)
      eq(`${v.key}: 수급 결측이면 진입 0(보수적 탈락)`, r.trades, 0)
      check(`${v.key}: 결측 판정이 전부 집계된다`, r.evaluated > 0 && r.missingAdmit === r.evaluated, `${r.missingAdmit}/${r.evaluated}`)
    }
    // 랭킹형(F2)은 필터가 아니라 순서 — 결측이어도 매매는 일어나고 전부 최하위 동점 처리된다
    const rF2 = simulateFlowYear(hist, RANGE_A, syms, COST, FLOW_F2, noLens)
    check('F2: 결측이어도 진입은 발생한다(랭킹은 필터가 아니다)', rF2.trades > 0, `trades=${rF2.trades}`)
    check('F2: 결측 랭킹이 전부 집계된다', rF2.evaluated > 0 && rF2.missingRank === rF2.evaluated, `${rF2.missingRank}/${rF2.evaluated}`)

    // 결측이 유리하게 작동하지 않는다 — 전량 결측 필터의 성적은 "매매 없음"(수익 0)
    const flat = simulateFlowYear(hist, RANGE_A, syms, COST, flowF1(3), noLens)
    check('결측 전량 → 자산곡선이 평평(초기자본 유지)', flat.equity.every((e) => Math.abs(e.equity - COST.initialCapital) < 1e-6))
  }

  // ---- (6) 필터는 base의 부분집합이다 (진입을 늘리지 않는다) -------------------
  {
    const store = makeFlows(syms, hist, 987654)
    const lens = makeFlowLens(store)
    const b = simulateFlowYear(hist, RANGE_A, syms, COST, FLOW_BASE, lens)
    for (const v of [flowF1(3), flowF1(5), FLOW_F3]) {
      const r = simulateFlowYear(hist, RANGE_A, syms, COST, v, lens)
      check(`${v.key}: 필터는 매매를 늘리지 않는다`, r.trades <= b.trades, `${r.trades} vs base ${b.trades}`)
    }
  }
}

// ============================================================================
// 비(非)이평 전략군 (MODE=xsmom · volbrk · rsirev)
// ============================================================================
//
// 여기서 막는 것:
//   · 공용 원장(Book)의 체결·비용·승패 산술 — 세 전략이 전부 이 위에 서 있다
//   · xsmom  : 12-1 모멘텀이 **전월 1일 이전** 종가만 본다 / 절대모멘텀 게이트가 현금으로
//              돌린다 / 절단 불변 / 체결은 월 첫 거래일 시가
//   · volbrk : 체결 보수성 — 시가가 이미 돌파가 위면 **시가**(불리한 쪽)로 체결 / 돌파가는
//              **전일** 레인지로 만든다 / 절단 불변
//   · rsirev : Wilder RSI 산술(손 계산 대조) / 재귀가 앞으로만 흘러 절단 불변 /
//              신호 D 종가 → 체결 D+1 시가 / 보유일수 상한
//   · 기준선(MA25×신고10→80선)이 같은 연쇄 위에서 재실행된다

/** 단조 추세 봉 — 게이트가 실제로 무언가를 막는지 보려면 부호가 확실한 데이터가 필요하다 */
function makeDriftBars(n: number, base: number, drift: number, seed: number): DailyBar[] {
  const rnd = rng(seed)
  const out: DailyBar[] = []
  let p = base
  for (let i = 0; i < n; i++) {
    const o = p
    const c = Math.max(1, p * (1 + drift))
    out.push({
      date: new Date(Date.UTC(1999, 0, 1) + i * 86400000).toISOString().slice(0, 10),
      t: 0,
      o,
      h: Math.max(o, c) * 1.001,
      l: Math.min(o, c) * 0.999,
      c,
      v: 1_000_000 + Math.floor(rnd() * 10),
    })
    p = c
  }
  return out
}

// ============================================================================
section('9) 공용 원장(Book) — 체결 산술 · 승패 집계')
// ============================================================================
{
  const b = newBook(10_000_000)
  const fill = 10_000 * (1 + COST.slippagePct / 100)
  const expQty = Math.floor(10_000_000 / (fill * (1 + COST.feePct / 100)))
  eq('매수 수량 = 예산 ÷ (슬리피지·수수료 반영 체결가)', bookBuy(b, COST, 'A', 10_000, 10_000_000, 0), expQty)
  const gross = expQty * fill
  closeTo('매수 후 현금', b.cash, 10_000_000 - gross - gross * (COST.feePct / 100), 1e-6)
  eq('보유 종목 1개', b.positions.size, 1)

  bookSell(b, COST, 'A', 10_000, expQty)
  eq('전량 청산 → 라운드트립 1건', b.closed, 1)
  eq('같은 값에 되팔면 비용 때문에 패', b.wins, 0)
  eq('청산 후 보유 없음', b.positions.size, 0)
  check('비용만큼만 자본이 줄었다', b.cash < 10_000_000 && b.cash > 9_900_000, `${b.cash}`)

  // 부분매도는 라운드트립으로 세지 않는다 — 승률 분모가 부풀지 않게
  const b2 = newBook(10_000_000)
  const q2 = bookBuy(b2, COST, 'B', 1_000, 10_000_000, 0)
  bookSell(b2, COST, 'B', 3_000, Math.floor(q2 / 2))
  eq('부분매도는 라운드트립이 아니다', b2.closed, 0)
  bookSell(b2, COST, 'B', 3_000, q2)
  eq('전량이 나가면 1건', b2.closed, 1)
  eq('3배에 팔았으면 승', b2.wins, 1)
  check('현금이 늘었다', b2.cash > 10_000_000, `${b2.cash}`)

  const b3 = newBook(1_000)
  eq('현금보다 비싼 종목은 못 산다', bookBuy(b3, COST, 'C', 10_000, 10_000_000, 0), 0)
  eq('실패한 매수는 포지션을 만들지 않는다', b3.positions.size, 0)
}

// ============================================================================
section('10) xsmom — 12-1 모멘텀 산술 · 절대모멘텀 게이트 · 절단 불변성')
// ============================================================================
{
  // ---- (a) 달 이동 산술 ------------------------------------------------------
  eq('1개월 전 달의 1일', shiftMonthStart('2001-03-05', -1), '2001-02-01')
  eq('12개월 전 달의 1일', shiftMonthStart('2001-03-05', -12), '2000-03-01')
  eq('연 경계(-1)', shiftMonthStart('2001-01-10', -1), '2000-12-01')
  eq('연 경계(-12)', shiftMonthStart('2001-01-10', -12), '2000-01-01')
  eq('연 경계(-13)', shiftMonthStart('2000-01-05', -13), '1998-12-01')

  // ---- (b) lastCloseBefore — 경계 **미포함**(strictly before) ----------------
  const bars = HISTORIES[CODES[0]]
  const at = (d: string) => bars.filter((x) => x.date < d).slice(-1)[0]
  eq('경계 직전 봉의 종가', lastCloseBefore(bars, '2001-02-01'), at('2001-02-01').c)
  eq('데이터 이전 시점은 null', lastCloseBefore(bars, '1998-01-01'), null)

  // ---- (c) 12-1 모멘텀 = (전월 1일 직전) ÷ (12개월 전 1일 직전) − 1 -----------
  const D = '2001-03-05'
  const pe = at(shiftMonthStart(D, -1)).c
  const ps = at(shiftMonthStart(D, -12)).c
  closeTo('12-1 모멘텀 산술', momentum12_1(bars, D)!, pe / ps - 1, 1e-12)

  // 최근 1개월(그리고 리밸런스일 당일)을 실제로 안 본다 — 그 구간을 3배로 조작해도 불변
  const tampered = bars.map((x) => (x.date >= shiftMonthStart(D, -1) ? { ...x, c: x.c * 3, o: x.o * 3 } : x))
  closeTo('전월 1일 이후 값을 조작해도 모멘텀 불변(미래 미포함)', momentum12_1(tampered, D)!, momentum12_1(bars, D)!, 1e-12)

  // ---- (d) 12개월치가 없으면 후보 제외 --------------------------------------
  eq('12개월 미만 종목은 null', momentum12_1(bars.filter((x) => x.date >= '2000-06-01'), D), null)

  // ---- (e) 랭킹 -------------------------------------------------------------
  const ranked = xsmomRank(HISTORIES, PIT1010[2002].ks, D)
  check('랭킹이 비어 있지 않다', ranked.length > 5, `${ranked.length}`)
  check('모멘텀 내림차순', ranked.every((r, i) => i === 0 || ranked[i - 1].mom >= r.mom))
  check('랭킹 값이 momentum12_1과 일치', ranked.every((r) => Object.is(r.mom, momentum12_1(HISTORIES[r.sym], D))))
}

{
  // ---- (f) 절대 모멘텀 게이트 — 전 종목 하락이면 전량 현금 -------------------
  const syms = ['AAA', 'BBB', 'CCC', 'DDD', 'EEE', 'FFF']
  const down: Record<string, DailyBar[]> = {}
  syms.forEach((s, i) => (down[s] = makeDriftBars(1200, 10_000 + i * 100, -0.001, 5000 + i)))
  const gated = simulateXsMomYear(down, '2001-01-01', syms, COST, { slots: 5, gate: true })
  const open = simulateXsMomYear(down, '2001-01-01', syms, COST, { slots: 5, gate: false })
  check(
    '게이트 ON: 12-1 수익 전부 음(-) → 매수 0 · 자본 불변(현금)',
    gated.fills.length === 0 && gated.equity.every((e) => Object.is(e.equity, COST.initialCapital)),
    `fills=${gated.fills.length}`,
  )
  check('게이트 OFF: 같은 데이터에서 매수가 일어난다', open.fills.some((f) => f.side === 'buy'), `fills=${open.fills.length}`)
  check(
    '게이트 OFF는 하락장에서 손실 — 게이트가 실제로 무언가를 막고 있다',
    open.equity[open.equity.length - 1].equity < COST.initialCapital,
    `${open.equity[open.equity.length - 1].equity}`,
  )
}

{
  // ---- (g) 절단 불변성 + 체결 시점·기준가 ------------------------------------
  const syms = PIT1010[2003].ks
  const CUT = '2004-07-20'
  const opts = { slots: 5, gate: false }
  const full = simulateXsMomYear(HISTORIES, '2001-01-01', syms, COST, opts)
  const cut = simulateXsMomYear(truncate(HISTORIES, CUT), '2001-01-01', syms, COST, opts)
  const fe = full.equity.filter((e) => e.date <= CUT)
  const ce = cut.equity.filter((e) => e.date <= CUT)
  check(
    `절단 전 자산곡선 동일 (${fe.length}점)`,
    fe.length > 900 && fe.length === ce.length && fe.every((e, i) => e.date === ce[i].date && Object.is(e.equity, ce[i].equity)),
    `full=${fe.length} cut=${ce.length}`,
  )
  const ff = full.fills.filter((f) => f.date <= CUT)
  const cf = cut.fills.filter((f) => f.date <= CUT)
  check(
    `절단 전 체결 이력 동일 (${ff.length}건)`,
    ff.length > 10 &&
      ff.length === cf.length &&
      ff.every((f, i) => f.date === cf[i].date && f.sym === cf[i].sym && f.side === cf[i].side && Object.is(f.px, cf[i].px) && f.qty === cf[i].qty),
    `full=${ff.length} cut=${cf.length}`,
  )
  check('절단 후 구간은 달라진다(테스트가 실제로 무언가를 재고 있다)', full.equity.length > cut.equity.length)

  const monthFirst = new Set<string>()
  let curYm = ''
  for (const e of full.equity) {
    const ym = e.date.slice(0, 7)
    if (ym !== curYm) {
      curYm = ym
      monthFirst.add(e.date)
    }
  }
  check('모든 체결이 월 첫 거래일에 일어난다', full.fills.every((f) => monthFirst.has(f.date)), `fills=${full.fills.length}`)
  const barAt = (sym: string, date: string) => HISTORIES[sym].find((x) => x.date === date)
  check('체결 기준가 = 그 날 시가', full.fills.every((f) => Object.is(f.px, barAt(f.sym, f.date)?.o)))
}

// ============================================================================
section('11) volbrk — 돌파 체결 보수성 · 전일 레인지 · 절단 불변성')
// ============================================================================
{
  // ---- (a) breakoutFill 순수 함수 (규칙 1-4 집행 지점) -----------------------
  eq('고가가 돌파가에 못 닿으면 체결 없음', breakoutFill(100, 102, 103), null)
  eq('고가가 돌파가에 닿으면 돌파가 체결', breakoutFill(100, 105, 103), 103)
  eq('고가 = 돌파가 경계도 체결', breakoutFill(100, 103, 103), 103)
  eq('시가가 이미 돌파가 위면 **시가** 체결(더 불리한 쪽)', breakoutFill(110, 115, 103), 110)
  check('유리한 쪽(돌파가)으로 가정하지 않는다', (breakoutFill(110, 115, 103) ?? 0) > 103)

  // ---- (b) 돌파가는 **전일** 레인지로 만든다 — 손으로 만든 봉 ----------------
  const mk = (i: number, o: number, h: number, l: number, cl: number): DailyBar => ({
    date: new Date(Date.UTC(2001, 0, 1) + i * 86400000).toISOString().slice(0, 10),
    t: 0,
    o,
    h,
    l,
    c: cl,
    v: 1_000_000,
  })
  // 0일차 레인지 = 110−90 = 20 → 1일차 돌파가 = 시가100 + k×20 (k=0.5→110, k=0.7→114)
  // 2~4일차는 레인지 0이라 후보에서 빠지고, 마지막 봉은 신규 진입 금지다.
  const hand: Record<string, DailyBar[]> = {
    A: [mk(0, 100, 110, 90, 100), mk(1, 100, 110, 95, 105), mk(2, 100, 100, 100, 100), mk(3, 100, 100, 100, 100), mk(4, 100, 100, 100, 100)],
  }
  const hit = simulateVolBrkYear(hand, '2001-01-01', ['A'], COST, { k: 0.5, exit: 'close', slots: 1 })
  const miss = simulateVolBrkYear(hand, '2001-01-01', ['A'], COST, { k: 0.7, exit: 'close', slots: 1 })
  eq('k=0.5 → 돌파가 110 = 고가 110 → 체결 1회', hit.closed, 1)
  eq('k=0.7 → 돌파가 114 > 고가 110 → 체결 없음', miss.closed, 0)
  eq('매수 기준가 = 돌파가 110 (시가도 고가도 아니다)', hit.fills.find((f) => f.side === 'buy')?.px, 110)
  eq('청산 기준가 = 당일 종가 105', hit.fills.find((f) => f.side === 'sell')?.px, 105)
  check('당일 종가 청산이면 진입·청산이 같은 날', hit.fills.length === 2 && hit.fills[0].date === hit.fills[1].date)
  eq('레인지 0인 날은 후보에서 빠진다 — 전 구간 매수 1회뿐', hit.fills.filter((f) => f.side === 'buy').length, 1)

  // 손익을 독립 산술로 재계산 — 체결가·비용 모델이 맞는지
  const fb = 110 * (1 + COST.slippagePct / 100)
  const q = Math.floor(COST.initialCapital / (fb * (1 + COST.feePct / 100)))
  const gB = q * fb
  const afterBuy = COST.initialCapital - gB - gB * (COST.feePct / 100)
  const fsPx = 105 * (1 - COST.slippagePct / 100)
  const gS = q * fsPx
  const afterSell = afterBuy + gS - gS * ((COST.feePct + COST.taxPct) / 100)
  closeTo('라운드트립 후 자본이 독립 산술과 일치', hit.equity.find((e) => e.date === hand.A[1].date)!.equity, afterSell, 1e-6)
  eq('당일 종가 청산이면 미청산 없음', hit.openAtEnd, 0)
}

{
  // ---- (c) 절단 불변성 + 체결가 정의 일치 ------------------------------------
  const syms = PIT1010[2004].ks
  const CUT = '2004-07-20'
  const K = 0.5
  const idxMap: Record<string, Map<string, number>> = {}
  for (const s of syms) idxMap[s] = new Map(HISTORIES[s].map((b, i) => [b.date, i]))

  for (const exit of ['close', 'nextOpen'] as const) {
    const opts = { k: K, exit, slots: 5 }
    const full = simulateVolBrkYear(HISTORIES, '2001-01-01', syms, COST, opts)
    const cut = simulateVolBrkYear(truncate(HISTORIES, CUT), '2001-01-01', syms, COST, opts)
    // 절단본의 마지막 봉(CUT)에는 "마지막 봉 신규 진입 금지"가 걸리므로 한 칸 앞까지 본다
    const fe = full.equity.filter((e) => e.date < CUT)
    const ce = cut.equity.filter((e) => e.date < CUT)
    check(
      `[${exit}] 절단 전 자산곡선 동일 (${fe.length}점)`,
      fe.length > 900 && fe.length === ce.length && fe.every((e, i) => e.date === ce[i].date && Object.is(e.equity, ce[i].equity)),
      `full=${fe.length} cut=${ce.length}`,
    )
    const ff = full.fills.filter((f) => f.date < CUT)
    const cf = cut.fills.filter((f) => f.date < CUT)
    check(
      `[${exit}] 절단 전 체결 이력 동일 (${ff.length}건)`,
      ff.length > 10 &&
        ff.length === cf.length &&
        ff.every((f, i) => f.date === cf[i].date && f.sym === cf[i].sym && f.side === cf[i].side && Object.is(f.px, cf[i].px)),
      `full=${ff.length} cut=${cf.length}`,
    )
    const buys = full.fills.filter((f) => f.side === 'buy')
    check(`[${exit}] 매수 체결이 발생한다`, buys.length > 10, `${buys.length}`)
    check(
      `[${exit}] 모든 매수 체결가 = max(당일 시가, 당일 시가 + k×전일 레인지)`,
      buys.every((f) => {
        const bars = HISTORIES[f.sym]
        const i = idxMap[f.sym].get(f.date)
        if (i == null || i < 1) return false
        const target = bars[i].o + K * (bars[i - 1].h - bars[i - 1].l)
        return Object.is(f.px, Math.max(bars[i].o, target)) && bars[i].h >= target
      }),
    )
  }

  // 익일 시가 청산 변형: 매도는 매수 **다음** 거래일 시가여야 한다
  const nxt = simulateVolBrkYear(HISTORIES, '2001-01-01', syms, COST, { k: K, exit: 'nextOpen', slots: 5 })
  const posOf = new Map(nxt.equity.map((e, i) => [e.date, i]))
  const lastBuyIdx = new Map<string, number>()
  let okNext = true
  let sells = 0
  for (const f of nxt.fills) {
    if (f.side === 'buy') lastBuyIdx.set(f.sym, posOf.get(f.date)!)
    else {
      sells++
      const bi = lastBuyIdx.get(f.sym)
      const si = posOf.get(f.date)!
      if (bi == null || si !== bi + 1) okNext = false
      if (!Object.is(f.px, HISTORIES[f.sym][idxMap[f.sym].get(f.date)!].o)) okNext = false
      lastBuyIdx.delete(f.sym)
    }
  }
  check(`[nextOpen] 청산 = 매수 다음 거래일 시가 (${sells}건 전수)`, sells > 10 && okNext, `sells=${sells}`)
}

// ============================================================================
section('12) rsirev — Wilder RSI 산술 · 재귀 절단 불변 · 신호 D종가 → 체결 D+1 시가')
// ============================================================================
{
  // ---- (a) 손 계산 대조 ------------------------------------------------------
  const mkc = (cs: number[]): DailyBar[] =>
    cs.map((cl, i) => ({
      date: new Date(Date.UTC(2001, 0, 1) + i * 86400000).toISOString().slice(0, 10),
      t: 0,
      o: cl,
      h: cl,
      l: cl,
      c: cl,
      v: 1_000,
    }))
  const r = wilderRsi(mkc([10, 11, 10.5, 11.5]), 2)
  eq('워밍업 이전은 null (i=0)', r[0], null)
  eq('워밍업 이전은 null (i=1)', r[1], null)
  // 시드: avgGain=(1+0)/2=0.5, avgLoss=(0+0.5)/2=0.25 → RS=2 → 100−100/3
  closeTo('시드 RSI(첫 period개 단순평균)', r[2]!, 100 - 100 / 3, 1e-9)
  // Wilder 평활: ag=(0.5×1+1)/2=0.75, al=(0.25×1+0)/2=0.125 → RS=6 → 100−100/7
  closeTo('Wilder 평활 1스텝', r[3]!, 100 - 100 / 7, 1e-9)
  eq('전 구간 상승 → RSI 100', wilderRsi(mkc([10, 11, 12, 13, 14]), 2)[4], 100)
  eq('무변동 → RSI 50', wilderRsi(mkc([10, 10, 10, 10]), 2)[3], 50)

  // ---- (b) 재귀는 앞으로만 흐른다 — 뒤를 잘라도 앞의 값이 그대로 --------------
  const bars = HISTORIES[CODES[1]]
  const K = 1500
  const fullR = wilderRsi(bars, 2)
  const cutR = wilderRsi(bars.slice(0, K), 2)
  check('RSI 절단 불변 (앞 구간 완전 동일)', cutR.length === K && cutR.every((v, i) => Object.is(v, fullR[i])))
  check('RSI가 실제로 값을 만든다', fullR.filter((v) => v != null).length > K, `${fullR.filter((v) => v != null).length}`)
}

{
  // ---- (c) 시뮬 — 체결 시점·조건 되돌아보기·보유일수·절단 불변 ---------------
  const syms = PIT1010[2005].ks
  const opts = { ...RSIREV_DEFAULT, slots: 5 }
  const CUT = '2004-07-20'
  const full = simulateRsiRevYear(HISTORIES, '2001-01-01', syms, COST, opts)
  const cut = simulateRsiRevYear(truncate(HISTORIES, CUT), '2001-01-01', syms, COST, opts)

  const posOf = new Map(full.equity.map((e, i) => [e.date, i]))
  const idxMap: Record<string, Map<string, number>> = {}
  const rsiMap: Record<string, (number | null)[]> = {}
  for (const s of syms) {
    idxMap[s] = new Map(HISTORIES[s].map((b, i) => [b.date, i]))
    rsiMap[s] = wilderRsi(HISTORIES[s], opts.period)
  }
  const buys = full.fills.filter((f) => f.side === 'buy')
  check('매수 체결이 발생한다', buys.length > 5, `${buys.length}`)
  check('체결일 = 신호일 다음 거래일', buys.every((f) => posOf.get(f.date)! === posOf.get(f.signalDate)! + 1))
  check('체결 기준가 = 그 날 시가', buys.every((f) => Object.is(f.px, HISTORIES[f.sym][idxMap[f.sym].get(f.date)!].o)))
  check(
    `모든 진입이 RSI2<${opts.lowThr} · 종가>MA${opts.trendMa} 신호에서 나왔다 (${buys.length}건 전수)`,
    buys.every((f) => {
      const bars = HISTORIES[f.sym]
      const i = idxMap[f.sym].get(f.signalDate)
      if (i == null) return false
      const rv = rsiMap[f.sym][i]
      const ma = sma(bars, i, opts.trendMa)
      return rv != null && rv < opts.lowThr && ma != null && bars[i].c > ma
    }),
  )

  const sellFills = full.fills.filter((f) => f.side === 'sell')
  check('청산도 신호 다음 거래일 시가', sellFills.every((f) => posOf.get(f.date)! === posOf.get(f.signalDate)! + 1))
  const lastBuy = new Map<string, number>()
  let maxHold = 0
  let okHold = true
  for (const f of full.fills) {
    if (f.side === 'buy') lastBuy.set(f.sym, posOf.get(f.date)!)
    else {
      const bi = lastBuy.get(f.sym)
      if (bi == null) {
        okHold = false
        continue
      }
      const h = posOf.get(f.date)! - bi
      maxHold = Math.max(maxHold, h)
      if (h > opts.maxHold + 1) okHold = false
      lastBuy.delete(f.sym)
    }
  }
  check(`보유일수 ≤ ${opts.maxHold + 1}거래일 (최장 ${maxHold})`, sellFills.length > 5 && okHold, `max=${maxHold}`)

  const fe = full.equity.filter((e) => e.date <= CUT)
  const ce = cut.equity.filter((e) => e.date <= CUT)
  check(
    `절단 전 자산곡선 동일 (${fe.length}점)`,
    fe.length > 900 && fe.length === ce.length && fe.every((e, i) => e.date === ce[i].date && Object.is(e.equity, ce[i].equity)),
    `full=${fe.length} cut=${ce.length}`,
  )
  const ff = full.fills.filter((f) => f.date <= CUT)
  const cf = cut.fills.filter((f) => f.date <= CUT)
  check(
    `절단 전 체결 이력 동일 (${ff.length}건)`,
    ff.length > 5 &&
      ff.length === cf.length &&
      ff.every((f, i) => f.date === cf[i].date && f.sym === cf[i].sym && f.side === cf[i].side && Object.is(f.px, cf[i].px)),
    `full=${ff.length} cut=${cf.length}`,
  )
  check('절단 후 구간은 달라진다(테스트가 실제로 무언가를 재고 있다)', full.equity.length > cut.equity.length)

  // 추세 필터를 끄면 진입 후보가 줄지 않는다(필터는 부분집합을 만든다)
  const noTrend = simulateRsiRevYear(HISTORIES, '2001-01-01', syms, COST, { ...opts, trendMa: 0 })
  check(
    '200일선 필터는 진입을 늘리지 않는다',
    full.fills.filter((f) => f.side === 'buy').length <= noTrend.fills.filter((f) => f.side === 'buy').length,
    `${full.fills.filter((f) => f.side === 'buy').length} vs ${noTrend.fills.filter((f) => f.side === 'buy').length}`,
  )
}

// ============================================================================
section('13) 기준선 재실행 · 연쇄 공용 기반')
// ============================================================================
{
  const spec = baselineSpec(['005930'])
  eq('기준선 이평 25', BASE25.ma, 25)
  eq('기준선 신고가 10', BASE25.hb, 10)
  eq('기준선 청산 이평 80', BASE25.xm, 80)
  eq('청산 규칙 = maBreak', spec.exits[0].kind, 'maBreak')
  eq('청산 이평 기간 80', spec.exits[0].maPeriod, 80)
  eq('진입은 종가 체결(LOC)', spec.execution.timing, 'sameClose')
  eq('슬롯 10', spec.sizing.maxPositions, 10)

  const yearly = buildYearly(HISTORIES, YEARS)
  const baseChain = runSpecChain(yearly, baselineSpec, COST)
  check('기준선 연쇄가 자산곡선을 만든다', baseChain.equity.length > 1000, `${baseChain.equity.length}`)
  check('기준선 매매가 발생한다', baseChain.closed > 0, `closed=${baseChain.closed}`)
  check('승리 수 ≤ 청산 수', baseChain.wins >= 0 && baseChain.wins <= baseChain.closed, `${baseChain.wins}/${baseChain.closed}`)
  eq('연쇄 길이 = 연도 수', baseChain.perYear.length, YEARS.length)
  check('연쇄 자산곡선은 시작 1.0 배수 스케일', baseChain.equity[0].equity > 0.5 && baseChain.equity[0].equity < 2, `${baseChain.equity[0].equity}`)

  // 매핑 5종목 미만인 해는 현금(배수 1) — 왜곡 방지 규약
  const sparse = yearly.map((v, i) => (i === 0 ? { ...v, syms: v.syms.slice(0, 3) } : v))
  const sparseChain = runCustomChain(
    sparse,
    (v) => simulateXsMomYear(v.hist, `${v.y}-01-01`, v.syms, COST, { slots: 5, gate: false }),
    COST,
    5,
  )
  eq('종목 5개 미만인 해는 현금 보유(배수 1)', sparseChain.perYear[0].ret, 1)
  check('나머지 해는 실제로 돌아간다', sparseChain.equity.length > 500, `${sparseChain.equity.length}`)
}

// ============================================================================
section('14) 보고 경로 — 알파는 겹치는 구간에서만 · 표 렌더링이 죽지 않는다')
// ============================================================================
{
  // 벤치(KODEX 200)는 2002년 상장이라 그 이전 구간이 없다. 그 구간까지 전략에만
  // 얹으면 알파가 부풀려지므로 alphaOf는 **겹치는 구간**으로 잘라야 한다.
  const strat = [
    { date: '2000-01-01', equity: 1 },
    { date: '2002-01-01', equity: 1 },
    { date: '2004-01-01', equity: 2 },
  ]
  const bench = [
    { date: '2002-01-01', equity: 100 },
    { date: '2004-01-01', equity: 100 },
  ]
  const a = alphaOf(strat, bench, '', '9999-12-31')
  eq('알파 구간 시작 = 벤치 시작(전략 시작 아님)', a.from, '2002-01-01')
  eq('알파 구간 끝', a.to, '2004-01-01')
  closeTo('알파 = 전략 CAGR − 벤치 CAGR', a.alpha!, a.s.cagr - (a.b?.cagr ?? 0), 1e-12)
  check('벤치 없는 구간을 얹지 않는다(전 구간 CAGR과 다르다)', Math.abs(a.alpha! - perfOf(strat).cagr) > 1, `${a.alpha} vs ${perfOf(strat).cagr}`)
  eq('겹치는 구간이 없으면 알파 없음', alphaOf(strat, [{ date: '2030-01-01', equity: 1 }, { date: '2031-01-01', equity: 1 }], '', '9999-12-31').alpha, null)

  // benchCurve — 총수익 보정 종가를 그대로 쓴다
  const bc = benchCurve(BENCH_BARS)
  eq('벤치 곡선 길이', bc.length, BENCH_BARS.length)
  check('벤치 곡선 = 종가', bc.every((e, i) => e.date === BENCH_BARS[i].date && Object.is(e.equity, BENCH_BARS[i].c)))

  // 요약은 스칼라만 남긴다 — 곡선 배열을 들고 있지 않아야 한다(메모리)
  const yearly = buildYearly(HISTORIES, YEARS)
  const row = summarizeStrat('테스트 기준선', runSpecChain(yearly, baselineSpec, COST), bc)
  check('요약 결과에 자산곡선 배열이 없다', !('equity' in (row as unknown as Record<string, unknown>)))
  eq('요약 연도 수', row.perYear.length, YEARS.length)
  check('요약 스칼라가 채워진다', Number.isFinite(row.full.total) && Number.isFinite(row.full.cagr) && Number.isFinite(row.full.mdd))

  // 표 렌더링 경로가 예외 없이 돈다 — 출력은 삼킨다(테스트 로그 오염 방지)
  const rows = [row, { ...row, label: '변형 A' }, { ...row, label: '변형 B' }]
  const orig = console.log
  let lines = 0
  let threw = ''
  console.log = () => {
    lines++
  }
  try {
    stratTable(rows)
    verdictTable(rows)
    perYearTable(rows)
  } catch (e) {
    threw = String(e)
  } finally {
    console.log = orig
  }
  check('표 3종이 예외 없이 렌더링된다', threw === '' && lines > 15, threw || `lines=${lines}`)
  eq('판정: 자기 자신과 비교하면 개선 0건', verdictTableSilent(rows), 0)
}

// ============================================================================
// 검증 3종 (MODE=xswf · usxsmom · combo)
// ============================================================================
//
// 여기서 막는 것:
//   · 워크포워드 선택이 **미래를 안 본다** — `y < year`인 해만 점수에 들어간다.
//     선택 시점 이후 데이터를 마음대로 바꿔도 그 이전 선택·자산곡선이 완전히 같아야 한다.
//     (이 테스트가 없으면 "매년 그때 골랐다"는 말이 사실인지 확인할 방법이 없다 — 워크포워드는
//      실수로 전 구간 성적을 보게 만들기가 아주 쉬운 구조다.)
//   · 연도별 분해(`yearCurvesOf` + `stitchYears`)가 `runCustomChain`과 **점 단위로 일치** —
//     갈라지면 워크포워드가 다른 연쇄 산술로 계산된 성적을 기준선과 비교하는 셈이 된다.
//   · 결합(combo) 합성 산술을 **알려진 두 곡선으로 손계산 대조** — 월 리밸런스가 실제로
//     달이 바뀔 때 일어나는지, 가중 1.0이면 원곡선과 같은지.
//   · 이월(carry-forward)이 **과거 방향으로만** 간다 — 환율 결측일에 다음 환율을 당겨오면
//     그것이 미래참조다.
//   · 미장 유니버스 매핑이 **재사용 티커를 거부**한다(조용한 오염 방지).

/** 한 해치 상대곡선을 [중간값, 연말값]으로 손쉽게 만든다(테스트 전용). */
function yc(y: number, mid: number, end: number): YearCurve {
  return {
    y,
    rel: [
      { date: `${y}-06-30`, rel: mid },
      { date: `${y}-12-30`, rel: end },
    ],
    endFactor: end,
  }
}

// ============================================================================
section('15) 이월(valueAsOf)·정렬(alignCurves) — 과거 방향으로만 본다')
// ============================================================================
{
  const curve = [
    { date: '2001-01-10', equity: 10 },
    { date: '2001-01-20', equity: 20 },
    { date: '2001-02-01', equity: 30 },
  ]
  eq('데이터 시작 전은 null', valueAsOf(curve, '2000-12-31'), null)
  eq('경계 당일은 그 값(이하 포함)', valueAsOf(curve, '2001-01-10'), 10)
  eq('결측일은 직전 값 이월', valueAsOf(curve, '2001-01-15'), 10)
  eq('결측일에 **다음** 값을 당겨오지 않는다', valueAsOf(curve, '2001-01-19'), 10)
  eq('마지막 이후는 마지막 값', valueAsOf(curve, '2099-01-01'), 30)

  const a = [
    { date: '2001-01-10', equity: 100 },
    { date: '2001-01-11', equity: 110 },
    { date: '2001-01-12', equity: 120 },
  ]
  const b = [
    { date: '2001-01-11', equity: 50 },
    { date: '2001-01-13', equity: 60 },
  ]
  const al = alignCurves(a, b)
  eq('겹치는 구간만 남는다 (2001-01-11 ~ 2001-01-12)', al.dates.join(','), '2001-01-11,2001-01-12')
  eq('a는 제 값', al.ea.join(','), '110,120')
  eq('b는 봉 없는 날 직전 값 이월(다음 값 60을 당겨오지 않는다)', al.eb.join(','), '50,50')
  eq('겹치지 않으면 빈 결과', alignCurves(a, [{ date: '2010-01-01', equity: 1 }]).dates.length, 0)
  eq('빈 곡선도 안전', alignCurves([], b).dates.length, 0)
}

// ============================================================================
section('16) combo 결합 산술 — 알려진 두 곡선으로 손계산 대조')
// ============================================================================
{
  // A는 매 스텝 2배, B는 완전 평탄. 달 경계는 2001-01-02 → 2001-02-01 사이 한 번뿐이다.
  const dates = ['2001-01-01', '2001-01-02', '2001-02-01', '2001-02-02']
  const ea = [100, 200, 400, 800]
  const eb = [100, 100, 100, 100]

  // 손계산(월 첫 거래일 **시작 시점**에 50:50 복원):
  //   i0: A .5 / B .5                              → 1.00
  //   i1: 같은 달 → A .5×2=1.0 / B .5              → 1.50
  //   i2: 달 바뀜 → 1.5를 .75/.75로 복원 → A 1.5 / B .75 → 2.25
  //   i3: 같은 달 → A 3.0 / B .75                  → 3.75
  const v = blendMonthlyRebalanced(dates, ea, eb, 0.5)
  closeTo('i0 = 1.00', v[0], 1, 1e-12)
  closeTo('i1 = 1.50 (달 안에서는 표류)', v[1], 1.5, 1e-12)
  closeTo('i2 = 2.25 (달 첫날 50:50 복원 후 수익 적용)', v[2], 2.25, 1e-12)
  closeTo('i3 = 3.75', v[3], 3.75, 1e-12)
  check('월 리밸런스가 실제로 무언가를 한다 (버티기 결합 4.5와 다르다)', Math.abs(v[3] - 4.5) > 0.5, `${v[3]}`)

  const only = blendMonthlyRebalanced(dates, ea, eb, 1)
  eq('가중 1.0이면 A 곡선 그대로', only.map((x) => x.toFixed(4)).join(','), '1.0000,2.0000,4.0000,8.0000')
  const none = blendMonthlyRebalanced(dates, ea, eb, 0)
  eq('가중 0이면 B 곡선 그대로', none.map((x) => x.toFixed(4)).join(','), '1.0000,1.0000,1.0000,1.0000')

  // 리밸런스가 **날짜만** 보고 일어난다 — 같은 달 안에 몰아넣으면 복원이 없다
  const oneMonth = ['2001-01-01', '2001-01-02', '2001-01-03', '2001-01-04']
  const w = blendMonthlyRebalanced(oneMonth, ea, eb, 0.5)
  closeTo('한 달 안이면 복원 없이 그냥 표류 (0.5×8 + 0.5×1)', w[3], 4.5, 1e-12)

  // blendCurves = alignCurves + blendMonthlyRebalanced
  const cA = dates.map((date, i) => ({ date, equity: ea[i] }))
  const cB = dates.map((date, i) => ({ date, equity: eb[i] }))
  const blended = blendCurves(cA, cB, 0.5)
  eq('blendCurves 길이', blended.length, 4)
  closeTo('blendCurves 마지막 값이 손계산과 일치', blended[3].equity, 3.75, 1e-12)
}

// ============================================================================
section('17) 월수익률 상관 · 연도 분해 · 연중 낙폭')
// ============================================================================
{
  eq('완전 양의 상관', pearson([1, 2, 3, 4], [2, 4, 6, 8])?.toFixed(6), (1).toFixed(6))
  eq('완전 음의 상관', pearson([1, 2, 3, 4], [-2, -4, -6, -8])?.toFixed(6), (-1).toFixed(6))
  eq('상수 계열은 null', pearson([1, 1, 1, 1], [1, 2, 3, 4]), null)
  eq('표본 3 미만은 null', pearson([1, 2], [1, 2]), null)

  // 월수익률 = 달 마지막 값 기준. 첫 달은 직전 달이 없어 빠진다.
  const c1 = [
    { date: '2001-01-31', equity: 100 },
    { date: '2001-02-28', equity: 110 },
    { date: '2001-03-31', equity: 99 },
  ]
  const m = monthlyReturnsOf(c1)
  eq('첫 달은 수익률 없음', m.has('2001-01'), false)
  closeTo('2월 +10%', m.get('2001-02')!, 0.1, 1e-12)
  closeTo('3월 −10%', m.get('2001-03')!, -0.1, 1e-12)

  const c2 = [
    { date: '2001-01-31', equity: 50 },
    { date: '2001-02-28', equity: 45 },
    { date: '2001-03-31', equity: 49.5 },
  ]
  const mc = monthlyCorrelation(c1, c2)
  eq('공통 월 2개', mc.n, 2)
  eq('표본 부족이면 상관 null (억지로 숫자를 만들지 않는다)', mc.r, null)

  // 연도 분해 — 그 해 마지막 값 ÷ 직전 해 마지막 값
  const c3 = [
    { date: '2000-06-01', equity: 1 },
    { date: '2000-12-31', equity: 2 },
    { date: '2001-12-31', equity: 6 },
  ]
  const py = perYearOfCurve(c3, [2000, 2001, 2002])
  eq('2000년 = 첫 값 대비 2배', py[0].ret, 2)
  eq('2001년 = 직전 연말 대비 3배', py[1].ret, 3)
  eq('점이 없는 해는 1(현금)', py[2].ret, 1)

  // 연중 최대 낙폭 — 그 해 안의 고점 기준
  const c4 = [
    { date: '2001-01-02', equity: 100 },
    { date: '2001-06-01', equity: 120 },
    { date: '2001-09-01', equity: 60 },
    { date: '2001-12-28', equity: 90 },
    { date: '2002-12-28', equity: 50 },
  ]
  closeTo('2001년 낙폭 = 120 → 60 = −50%', yearMaxDrawdown(c4, 2001)!, -50, 1e-9)
  eq('점 1개뿐인 해는 null', yearMaxDrawdown(c4, 2002), null)
  eq('점 없는 해는 null', yearMaxDrawdown(c4, 1999), null)
}

// ============================================================================
section('18) 환율 환산 — 결측일은 직전 환율 이월(다음 환율 금지)')
// ============================================================================
{
  const bar = (date: string, c: number): DailyBar => ({ date, t: 0, o: c, h: c, l: c, c, v: 1 })
  const usd = [bar('2001-01-01', 10), bar('2001-01-02', 20), bar('2001-01-03', 30), bar('2001-01-04', 40)]
  // 환율은 1/2·1/4에만 있다 — 1/1은 환율 이전, 1/3은 결측이다.
  const fx = [bar('2001-01-02', 1000), bar('2001-01-04', 2000)]
  const krw = toKrwCurve(usd, fx)
  eq('환율 시작 전 구간(1/1)은 버린다', krw.map((p) => p.date).join(','), '2001-01-02,2001-01-03,2001-01-04')
  eq('1/2 = 20 × 1000', krw[0].equity, 20_000)
  eq('1/3 결측 → **직전** 환율 1000 (다음 환율 2000을 당겨오지 않는다)', krw[1].equity, 30_000)
  eq('1/4 = 40 × 2000', krw[2].equity, 80_000)
  eq('환율이 전혀 없으면 빈 곡선', toKrwCurve(usd, []).length, 0)

  // 환율 뒷부분을 통째로 바꿔도 앞 구간 환산값은 불변(절단 불변성의 환율판)
  const fxTampered = [bar('2001-01-02', 1000), bar('2001-01-04', 9_999_999)]
  const krw2 = toKrwCurve(usd, fxTampered)
  check(
    '1/4 환율을 바꿔도 1/2·1/3 환산값 불변',
    krw2[0].equity === krw[0].equity && krw2[1].equity === krw[1].equity,
    `${krw2[0].equity}/${krw2[1].equity}`,
  )
}

// ============================================================================
section('19) 연도별 분해(yearCurvesOf + stitchYears) = runCustomChain 연쇄')
// ============================================================================
{
  const yearly = buildYearly(HISTORIES, YEARS)
  const opts = { slots: 5, gate: true }
  const runYear = (v: (typeof yearly)[number]) => simulateXsMomYear(v.hist, `${v.y}-01-01`, v.syms, COST, opts)
  const chain = runCustomChain(yearly, runYear, COST, opts.slots)
  const stitched = stitchYears(yearCurvesOf(yearly, runYear, COST, opts.slots))
  check(
    `분해 후 재조립이 연쇄와 점 단위로 일치 (${chain.equity.length}점)`,
    chain.equity.length > 500 &&
      chain.equity.length === stitched.length &&
      chain.equity.every((e, i) => e.date === stitched[i].date && Math.abs(e.equity - stitched[i].equity) < 1e-12),
    `chain=${chain.equity.length} stitched=${stitched.length}`,
  )
  // 연말 정산 근사(haircut)도 같이 반영된다 — 끄면 두 경로가 같이 달라져야 한다
  const noHc = stitchYears(yearCurvesOf(yearly, runYear, COST, opts.slots, false))
  const noHcChain = runCustomChain(yearly, runYear, COST, opts.slots, false)
  check(
    'haircut을 끈 경로도 서로 일치',
    noHc.length === noHcChain.equity.length &&
      noHc.every((e, i) => Math.abs(e.equity - noHcChain.equity[i].equity) < 1e-12),
  )
  check('haircut on/off는 실제로 다른 곡선', Math.abs(noHc[noHc.length - 1].equity - stitched[stitched.length - 1].equity) > 1e-9)
}

// ============================================================================
section('20) 워크포워드 선택 — 선택 시점 이후를 보지 않는다 (손으로 만든 표)')
// ============================================================================
{
  // C1 = 고수익·깊은 낙폭 / C2 = 저수익·얕은 낙폭. 2002년까지는 C2가, 그 뒤로는 C1이 앞선다.
  // C2를 기본값(WF_DEFAULT)과 같은 후보로 두어 "학습 부족 구간의 기본값" 경로도 함께 탄다.
  const C1: WfCand = { slots: 4, gate: false }
  const C2: WfCand = { ...WF_DEFAULT }
  const mk = (spec: Record<number, [number, number]>) =>
    Object.keys(spec)
      .map(Number)
      .sort((a, b) => a - b)
      .map((y) => yc(y, spec[y][0], spec[y][1]))
  const table: WfTable = [
    { cand: C1, years: mk({ 2000: [0.5, 2.0], 2001: [0.5, 2.0], 2002: [0.9, 3.0], 2003: [0.9, 3.0], 2004: [1, 1] }) },
    { cand: C2, years: mk({ 2000: [0.99, 1.1], 2001: [0.99, 1.1], 2002: [0.5, 0.6], 2003: [0.5, 0.6], 2004: [1, 1] }) },
  ]
  const YS = [2000, 2001, 2002, 2003, 2004]

  // (a) 학습 표본 부족 구간은 기본값 — 사후지식 없는 선택
  eq('학습 0년 → 기본값', wfLabel(wfPick(table, 2000, 2).pick), wfLabel(WF_DEFAULT))
  eq('학습 1년 → 기본값', wfLabel(wfPick(table, 2001, 2).pick), wfLabel(WF_DEFAULT))
  eq('학습 표본 카운트', wfPick(table, 2002, 2).trained, 2)

  // (b) 점수는 직전까지의 누적 수익÷MDD — 독립 계산과 대조
  const objOf = (row: WfTable[number], year: number) => perfOf(stitchYears(row.years.filter((cc) => cc.y < year))).obj
  const p2002 = wfPick(table, 2002, 2)
  eq('2002년: 낙폭이 얕은 C2를 고른다', wfLabel(p2002.pick), wfLabel(C2))
  closeTo('선택 점수 = 그 후보의 직전까지 누적 수익÷MDD', p2002.score!, objOf(table[1], 2002)!, 1e-9)
  check('그 시점에는 C1이 실제로 열세', objOf(table[0], 2002)! < objOf(table[1], 2002)!)

  // (c) 뒤로 갈수록 순위가 뒤집힌다 — 선택도 따라 바뀌어야 한다
  eq('2003년: 역전되어 C1', wfLabel(wfPick(table, 2003, 2).pick), wfLabel(C1))
  eq('2004년: 계속 C1', wfLabel(wfPick(table, 2004, 2).pick), wfLabel(C1))

  // (d) ★ 미래참조 금지 — 선택 시점 **이후** 연도를 극단값으로 바꿔도 선택이 그대로여야 한다
  const tamper = (from: number): WfTable =>
    table.map((row) => ({
      cand: row.cand,
      years: row.years.map((cc) =>
        cc.y < from
          ? cc
          : {
              y: cc.y,
              rel: cc.rel.map((p) => ({ date: p.date, rel: p.rel * (row.cand.slots === 4 ? 1e6 : 1e-6) })),
              endFactor: cc.endFactor * (row.cand.slots === 4 ? 1e6 : 1e-6),
            },
      ),
    }))
  for (const year of [2002, 2003, 2004]) {
    const t = tamper(year)
    eq(
      `${year}년 선택은 ${year}년 이후 데이터를 조작해도 불변`,
      wfLabel(wfPick(t, year, 2).pick),
      wfLabel(wfPick(table, year, 2).pick),
    )
    closeTo(`${year}년 선택 점수도 불변`, wfPick(t, year, 2).score!, wfPick(table, year, 2).score!, 1e-9)
  }

  // (e) 연쇄 자산곡선 손계산
  //   2000·2001 기본값(C2) → 1.1 → 1.21 / 2002 C2 → ×0.6 = 0.726 / 2003 C1 → ×3 = 2.178 / 2004 C1 → ×1
  const wf = runWalkForward(table, YS, 2, WF_DEFAULT)
  eq('선택 이력 길이', wf.picks.length, 5)
  eq('연쇄 점 수 = 5년 × 2점', wf.equity.length, 10)
  closeTo('2000년 말 = 1.1', wf.equity[1].equity, 1.1, 1e-12)
  closeTo('2001년 말 = 1.21', wf.equity[3].equity, 1.21, 1e-12)
  closeTo('2002년 말 = 0.726', wf.equity[5].equity, 0.726, 1e-12)
  closeTo('2003년 말 = 2.178 (C1로 갈아탄 해)', wf.equity[7].equity, 2.178, 1e-12)
  closeTo('2004년 말 = 2.178', wf.equity[9].equity, 2.178, 1e-12)
  closeTo('연도별 수익 2003 = ×3', wf.perYear[3].ret, 3, 1e-12)
  eq('교체가 실제로 일어났다', new Set(wf.picks.map((p) => wfLabel(p.pick))).size, 2)

  // (f) 연쇄 전체도 뒤쪽 조작에 대해 앞 구간 불변
  const wfT = runWalkForward(tamper(2003), YS, 2, WF_DEFAULT)
  check(
    '2003년 이후를 조작해도 2002년까지의 곡선 동일',
    wf.equity
      .filter((e) => e.date < '2003-01-01')
      .every((e, i) => e.date === wfT.equity[i].date && Math.abs(e.equity - wfT.equity[i].equity) < 1e-12),
  )
  eq('조작 후에도 2002년 선택은 같다', wfLabel(wfT.picks[2].pick), wfLabel(wf.picks[2].pick))
}

// ============================================================================
section('21) 워크포워드 절단 불변성 (합성 시세 · 실제 xsmom 경로)')
// ============================================================================
{
  const CUT = '2003-12-31'
  const MIN = 2
  const buildTable = (h: Record<string, DailyBar[]>): WfTable => {
    const yearly = buildYearly(h, YEARS)
    return WF_CANDS.map((cand) => ({
      cand,
      years: yearCurvesOf(yearly, (v) => simulateXsMomYear(v.hist, `${v.y}-01-01`, v.syms, COST, cand), COST, cand.slots),
    }))
  }
  const full = runWalkForward(buildTable(HISTORIES), YEARS, MIN, WF_DEFAULT)
  // 절단이 아니라 **조작**으로 본다 — 잘라내면 그 해가 통째로 사라져 비교가 헐거워진다.
  // 배율을 종목마다 다르게 줘야 모멘텀 **순위**까지 흔들린다(전 종목 동일 배율이면
  // 비율이 상쇄돼 랭킹이 그대로라 조작이 사실상 아무 일도 안 한 셈이 된다).
  const tampered: Record<string, DailyBar[]> = {}
  Object.entries(HISTORIES).forEach(([s, bars], i) => {
    const k = 1 + ((i * 7) % 11) * 0.9 // 1.0 ~ 10.0
    tampered[s] = bars.map((b) => (b.date <= CUT ? b : { ...b, o: b.o * k, h: b.h * k, l: b.l * k, c: b.c * k }))
  })
  const after = runWalkForward(buildTable(tampered), YEARS, MIN, WF_DEFAULT)

  const fe = full.equity.filter((e) => e.date <= CUT)
  const ae = after.equity.filter((e) => e.date <= CUT)
  check(
    `절단 시점 이전 자산곡선 동일 (${fe.length}점)`,
    fe.length > 500 && fe.length === ae.length && fe.every((e, i) => e.date === ae[i].date && Math.abs(e.equity - ae[i].equity) < 1e-9),
    `full=${fe.length} after=${ae.length}`,
  )
  const yBefore = YEARS.filter((y) => y <= 2004) // 2004년 선택은 2003년까지만 보고 한다
  check(
    '2004년까지의 선택이 전부 동일 (선택이 미래를 보지 않는다)',
    yBefore.every((y) => {
      const a = full.picks.find((p) => p.y === y)!
      const b = after.picks.find((p) => p.y === y)!
      return wfLabel(a.pick) === wfLabel(b.pick) && a.trained === b.trained
    }),
    full.picks.map((p) => `${p.y}:${wfLabel(p.pick)}`).join(' '),
  )
  check('조작 구간 이후는 실제로 달라진다(테스트가 무언가를 재고 있다)', full.equity.some((e, i) => e.date > CUT && after.equity[i] && Math.abs(e.equity - after.equity[i].equity) > 1e-9))
  check('재실행 결정성', runWalkForward(buildTable(HISTORIES), YEARS, MIN, WF_DEFAULT).equity.every((e, i) => Object.is(e.equity, full.equity[i].equity)))
}

// ============================================================================
section('22) plateauness — 고원 vs 뾰족한 봉우리')
// ============================================================================
{
  const flat = plateauness([10, 20, 22, 21, 12, 8], 2)
  closeTo('이웃 평균 ÷ 중심', flat.ratio!, 20.5 / 22, 1e-12)
  check('고원 판정', flat.verdict.startsWith('고원'), flat.verdict)
  const spike = plateauness([1, 2, 30, 2, 1, 1], 2)
  check('봉우리 판정', spike.verdict.startsWith('뾰족'), spike.verdict)
  eq('중심이 null이면 판정 불가', plateauness([1, null, 3], 1).ratio, null)
  eq('이웃이 전부 null이면 판정 불가', plateauness([null, 5, null], 1).ratio, null)
  check('중심이 0 이하면 판정 불가', plateauness([1, 0, 1], 1).ratio == null)
}

// ============================================================================
section('23) 미장 유니버스 매핑 — 재사용 티커 거부 · 사명변경 폴백')
// ============================================================================
{
  const usBars = (start: string, n: number, seed: number): DailyBar[] =>
    makeBars(seed, n).map((b, i) => ({
      ...b,
      date: new Date(Date.parse(`${start}T00:00:00Z`) + i * 86400000).toISOString().slice(0, 10),
    }))
  // 'LU'(재사용 티커)에 **일부러** 시세를 넣어 둔다 — 매핑이 거부돼야 정상이다.
  const h: Record<string, DailyBar[]> = {
    MSFT: usBars('1999-01-01', 1200, 7001),
    GE: usBars('1999-01-01', 1200, 7002),
    CSCO: usBars('1999-01-01', 1200, 7003),
    WMT: usBars('1999-01-01', 1200, 7004),
    XOM: usBars('1999-01-01', 1200, 7005),
    LU: usBars('1999-01-01', 1200, 7006),
    IBM: usBars('2000-09-01', 400, 7007), // 그 해 6/30 이후 시작 → 2000년 편입 불가
  }
  const [slice] = buildYearlyUs(h, [2000])
  check('재사용 티커 LU는 시세가 있어도 편입되지 않는다', !slice.syms.includes('LU'), slice.syms.join(','))
  check('정상 티커는 편입된다', ['MSFT', 'GE', 'CSCO', 'WMT', 'XOM'].every((s) => slice.syms.includes(s)), slice.syms.join(','))
  check('그 해 6/30 이후 상장분은 빠진다', !slice.syms.includes('IBM'), slice.syms.join(','))
  eq('매핑률 분모는 그 해 목록 20종목', slice.mapped.split('/')[1], '20')
  eq('슬라이스 히스토리는 그 해 말까지만', slice.hist.MSFT.every((b) => b.date <= '2000-12-31'), true)

  // 사명 변경 폴백 — FB는 META로 조회된다
  const h2: Record<string, DailyBar[]> = { META: usBars('2010-01-01', 1200, 7008) }
  eq('FB → META 폴백', resolveUsTicker('FB', (s) => !!h2[s]?.length), 'META')
  eq('재사용 티커는 폴백도 없다', resolveUsTicker('LU', () => true), undefined)
}

// ============================================================================
section('24) 미장 xsmom 경로 — 절단 불변성 (KR과 같은 시뮬을 미장 비용으로)')
// ============================================================================
{
  const usBars = (seed: number): DailyBar[] => makeBars(seed, N_DAYS)
  const tickers = ['MSFT', 'GE', 'CSCO', 'WMT', 'XOM', 'IBM', 'INTC', 'ORCL']
  const h: Record<string, DailyBar[]> = {}
  tickers.forEach((t, i) => (h[t] = usBars(880_000 + i * 613)))
  const CUT = '2004-07-20'
  const opts = { slots: 4, gate: true }
  const full = simulateXsMomYear(h, '2001-01-01', tickers, COST_US, opts)
  const cut = simulateXsMomYear(truncate(h, CUT), '2001-01-01', tickers, COST_US, opts)
  const fe = full.equity.filter((e) => e.date <= CUT)
  const ce = cut.equity.filter((e) => e.date <= CUT)
  check(
    `미장 비용 경로도 절단 불변 (${fe.length}점)`,
    fe.length > 900 && fe.length === ce.length && fe.every((e, i) => e.date === ce[i].date && Object.is(e.equity, ce[i].equity)),
    `full=${fe.length} cut=${ce.length}`,
  )
  eq('미장 비용: 매도 거래세 0', COST_US.taxPct, 0)
  check('KR 비용과 다른 상수를 쓴다', COST_US.taxPct !== COST.taxPct)
}

// ============================================================================
section('25) 검증 3종 표 렌더링 — 예외 없이 돌고 판정이 자기모순이 아니다')
// ============================================================================
{
  const yearly = buildYearly(HISTORIES, YEARS)
  const benchEq = benchCurve(BENCH_BARS)
  const chainA = runSpecChain(yearly, baselineSpec, COST)
  const chainB = runCustomChain(
    yearly,
    (v) => simulateXsMomYear(v.hist, `${v.y}-01-01`, v.syms, COST, COMBO_XSMOM),
    COST,
    COMBO_XSMOM.slots,
  )
  const blended = blendCurves(chainA.equity, chainB.equity, 0.5)
  check('결합 곡선이 만들어진다', blended.length > 500, `${blended.length}`)
  const row = curveStrat('결합 50:50', blended, benchEq, YEARS)
  eq('curveStrat 라벨', row.label, '결합 50:50')
  eq('결합 행은 매매 집계가 없다(승률 분모 오염 방지)', row.closed, 0)
  eq('연도별 분해 길이 = 연도 수', row.perYear.length, YEARS.length)

  // 가중을 끝으로 밀면 결합은 그 슬리브 **그 자체**여야 한다 — 산술적으로 강제되는 성질이라
  // 여기서 어긋나면 가중이 뒤바뀌었거나 정렬이 틀어진 것이다.
  const onlyA = blendCurves(chainA.equity, chainB.equity, 1)
  const alA = alignCurves(chainA.equity, chainB.equity)
  check(
    '가중 1.0 → A 슬리브 곡선과 배수까지 일치',
    onlyA.length === alA.dates.length &&
      onlyA.every((p, i) => p.date === alA.dates[i] && Math.abs(p.equity - alA.ea[i] / alA.ea[0]) < 1e-9),
    `${onlyA.length}/${alA.dates.length}`,
  )
  const onlyB = blendCurves(chainA.equity, chainB.equity, 0)
  check(
    '가중 0 → B 슬리브 곡선과 배수까지 일치',
    onlyB.every((p, i) => Math.abs(p.equity - alA.eb[i] / alA.eb[0]) < 1e-9),
  )
  const mixTotal = perfOf(blended).total
  check(
    '50:50 결합은 두 단독과 다른 곡선이다 (합성이 실제로 일어났다)',
    Math.abs(mixTotal - perfOf(onlyA).total) > 1e-6 && Math.abs(mixTotal - perfOf(onlyB).total) > 1e-6,
    `A=${perfOf(onlyA).total.toFixed(1)} B=${perfOf(onlyB).total.toFixed(1)} mix=${mixTotal.toFixed(1)}`,
  )

  const [from, to] = spanOf(chainA.equity)
  check('spanOf가 곡선 양끝을 준다', from === chainA.equity[0].date && to === chainA.equity[chainA.equity.length - 1].date)
  eq('빈 곡선 span', spanOf([]).join(','), ',')

  let lines = 0
  let threw = ''
  const orig = console.log
  console.log = () => {
    lines++
  }
  try {
    holdTable('테스트', [{ label: '벤치', curve: benchEq, note: '메모' }, { label: '빈 곡선', curve: [] }], from, to)
  } catch (e) {
    threw = String(e)
  } finally {
    console.log = orig
  }
  check('holdTable이 빈 곡선에도 예외 없이 렌더링된다', threw === '' && lines > 5, threw || `lines=${lines}`)
}

/** verdictTable을 출력 없이 호출해 승자 수만 받는다 */
function verdictTableSilent(rows: Parameters<typeof verdictTable>[0]): number {
  const orig = console.log
  console.log = () => {}
  try {
    return verdictTable(rows)
  } finally {
    console.log = orig
  }
}

finish()
