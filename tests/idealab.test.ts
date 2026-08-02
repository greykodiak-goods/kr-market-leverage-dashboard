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
//   5) flow **T−1 원칙** — D일 진입 판단에 D일 수급을 쓰지 않는다. D일 이후 수급 행을
//      극단값으로 바꿔도 D일까지의 매매·자산곡선이 완전히 같아야 한다(수급판 절단 불변성).
//      더불어 bespoke 시뮬이 필터를 껐을 때 엔진 base와 **전 점 일치**하는지도 여기서 막는다 —
//      갈라지면 A/B가 서로 다른 전략을 비교하는 셈이 된다.
//
// 실데이터(Yahoo)는 컨테이너에서 403이라 전부 합성 시계열로 검증한다.

import { check, eq, section, finish, rng } from './harness'
import {
  PIT1010,
  MONTH_GATE,
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
import type { DailyBar } from '../src/features/backtest/types'

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

finish()
