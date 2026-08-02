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
//
// 실데이터(Yahoo)는 컨테이너에서 403이라 전부 합성 시계열로 검증한다.

import { check, eq, section, finish, rng } from './harness'
import {
  PIT1010,
  MONTH_GATE,
  alignPair,
  binomTail,
  blockedMonthsExpanding,
  buildYearly,
  calendarOf,
  discountOf,
  expandingZ,
  makeOvS3,
  monthGateBars,
  monthlyRatios,
  monthOf,
  perfOf,
  runOverlayChain,
  selectMonthCells,
  simulateMonthPat,
  simulatePairSwitch,
  winnerSpec,
  type CellPick,
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

finish()
