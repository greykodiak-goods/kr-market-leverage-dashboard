// ⚠️ 이 파일은 MODE=overlay(승자 위 리스크 오버레이 4종)에 대한 CLAUDE.md 규칙 1
// (미래참조 금지)의 집행자다.
//
// 오버레이는 "언제 얼마나 담느냐"를 정하는 코드라 미래참조가 들어가기 가장 쉬운 자리다.
// 레짐·변동성·가중 창의 오른쪽 경계가 하루라도 밀리면 표는 멀쩡해 보이는데 성적만 좋아진다.
// 그래서 여기서 검증하는 것:
//
//   1) 중립 오버레이 항등 — `exposure: () => 1`은 오버레이가 없는 경로와 **완전히 동일**하다.
//      (기존 모드 산출물 바이트 불변의 1차 방어선. 2차는 screen.test.ts의 골든 지문이다.)
//   2) 창 경계 — 레짐(12-1 · 10개월 이평)·실현변동성·역변동성 가중이 판정 시점 **이후**
//      구간을 3배로 조작해도 값이 불변이고, **창 안쪽**을 건드리면 값이 바뀐다.
//      (뒤 절반이 없으면 "아무것도 안 보는 함수"가 통과해 버린다.)
//   3) 절단 불변성 — 오버레이 4종 전부, 뒷부분을 잘라도 잘린 시점 이전의 체결·자산곡선이
//      완전히 동일하다. 변동성 타게팅은 **2패스**(베이스 곡선 → 노출)라 두 패스 모두 절단본에서
//      다시 돌려 비교한다.
//   4) 노출 규약 — w=0이면 전량 현금, w=0.5면 분모는 그대로 두고 금액만 절반(레버리지 없음).
//   5) 크래시 스톱 체결 — 갭 관통은 **시가**, 스침은 기준가, 청산된 슬롯은 월말까지 현금.
//   6) 산술 — 실현변동성·역변동성 가중·지수 접합·위기 연도 스칼라·판정 3항.
//
// 실데이터(Yahoo)는 컨테이너에서 403이라 전부 합성 시계열로 검증한다.

import { check, close as closeTo, eq, section, finish, rng } from './harness'
import {
  CRISIS_YEARS,
  OVL_MA_MONTHS,
  OVL_RP_WIN,
  OVL_VOL_WIN,
  PIT1010,
  blendCurves,
  blendRiskParity,
  buildYearly,
  crisisStats,
  curveIdxBefore,
  invVolWeight,
  makeRegimeExposure,
  makeVolTargetExposure,
  monthEndCloses,
  overlayVerdictTable,
  realizedVolPct,
  regimeMaRiskOn,
  regimeMom12_1,
  runCustomChain,
  simulateRankYear,
  simulateXsMomYear,
  spliceRegimeCurve,
  stdevReturns,
  valueBefore,
  xsmomRank,
  type Perf,
  type RankFn,
  type StratRow,
} from '../scripts/idea-lab.entry'
import type { CostSettings } from '../src/features/backtest/conditionScreen'
import type { DailyBar } from '../src/features/backtest/types'

const COST: CostSettings = { initialCapital: 10_000_000, feePct: 0.015, taxPct: 0.15, slippagePct: 0.1 }

// ---- 합성 데이터 (screen.test.ts와 같은 생성기) --------------------------------

const dayOf = (i: number) => new Date(Date.UTC(1999, 0, 1) + i * 86400000).toISOString().slice(0, 10)

function makeBars(seed: number, n: number, base = 10_000): DailyBar[] {
  const rnd = rng(seed)
  const bars: DailyBar[] = []
  let p = base
  for (let i = 0; i < n; i++) {
    const ret = 0.0004 + 0.025 * (rnd() * 2 - 1)
    const o = p
    const c = Math.max(1, p * (1 + ret))
    bars.push({
      date: dayOf(i),
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
const N_DAYS = 2600
const CODES = [...new Set(YEARS.flatMap((y) => [...PIT1010[y].ks, ...PIT1010[y].kq]))]
const HISTORIES: Record<string, DailyBar[]> = {}
CODES.forEach((cd, i) => (HISTORIES[cd] = makeBars(20260802 + i * 977, N_DAYS, 5_000 + i * 137)))

/** 레짐 판정용 합성 벤치 — 종목과 다른 시드라 게이트가 실제로 켜졌다 꺼졌다 한다. */
const BENCH_BARS = makeBars(31337, N_DAYS, 100)
const BENCH_CURVE = BENCH_BARS.map((b) => ({ date: b.date, equity: b.c }))

function truncate(h: Record<string, DailyBar[]>, cutDate: string): Record<string, DailyBar[]> {
  const out: Record<string, DailyBar[]> = {}
  for (const [s, bars] of Object.entries(h)) out[s] = bars.filter((b) => b.date <= cutDate)
  return out
}

const XSM = { slots: 5, gate: true } as const
const baseOpts = { slots: XSM.slots, rank: xsmomRank, keep: (r: { aux: number }) => r.aux >= 0 }

/** 베이스 B(오버레이 없음) 연쇄 — 변동성 타게팅의 1패스이자 절단 비교의 기준. */
function chainB(h: Record<string, DailyBar[]>) {
  return runCustomChain(
    buildYearly(h, YEARS),
    (v) => simulateXsMomYear(v.hist, `${v.y}-01-01`, v.syms, COST, XSM),
    COST,
    XSM.slots,
  )
}

/** 오버레이를 얹은 B 연쇄. */
function chainOv(h: Record<string, DailyBar[]>, extra: { exposure?: (d: string) => number; stopPct?: number }) {
  return runCustomChain(
    buildYearly(h, YEARS),
    (v) => simulateRankYear(v.hist, `${v.y}-01-01`, v.syms, COST, { ...baseOpts, ...extra }),
    COST,
    XSM.slots,
  )
}

/** 잘린 시점 이전 구간에서 자산곡선이 완전히 동일한가. */
function sameCurveBefore(
  full: { date: string; equity: number }[],
  cut: { date: string; equity: number }[],
  cutDate: string,
): { ok: boolean; n: number; detail: string } {
  const a = full.filter((e) => e.date <= cutDate)
  const b = cut.filter((e) => e.date <= cutDate)
  if (a.length !== b.length) return { ok: false, n: a.length, detail: `길이 ${a.length} vs ${b.length}` }
  for (let i = 0; i < a.length; i++) {
    if (a[i].date !== b[i].date || !Object.is(a[i].equity, b[i].equity))
      return { ok: false, n: a.length, detail: `${a[i].date}: ${a[i].equity} vs ${b[i].equity}` }
  }
  return { ok: true, n: a.length, detail: '' }
}

// ============================================================================
section('1) 중립 오버레이 항등 — exposure:()=>1 은 오버레이 없는 경로와 완전히 같다')
// ============================================================================
{
  const syms = [...PIT1010[2003].ks, ...PIT1010[2003].kq]
  const plain = simulateRankYear(HISTORIES, '2001-01-01', syms, COST, baseOpts)
  const neutral = simulateRankYear(HISTORIES, '2001-01-01', syms, COST, { ...baseOpts, exposure: () => 1 })
  const legacy = simulateXsMomYear(HISTORIES, '2001-01-01', syms, COST, XSM)

  eq('중립 오버레이 — 자산곡선 길이 동일', neutral.equity.length, plain.equity.length)
  check(
    '중립 오버레이 — 자산곡선 부동소수점까지 동일',
    neutral.equity.every((e, i) => e.date === plain.equity[i].date && Object.is(e.equity, plain.equity[i].equity)),
  )
  check(
    '중립 오버레이 — 체결 원장 동일',
    neutral.fills.length === plain.fills.length &&
      neutral.fills.every(
        (f, i) =>
          f.date === plain.fills[i].date &&
          f.sym === plain.fills[i].sym &&
          f.side === plain.fills[i].side &&
          Object.is(f.px, plain.fills[i].px) &&
          f.qty === plain.fills[i].qty,
      ),
  )
  check(
    '기존 래퍼(simulateXsMomYear) 경로도 그대로 — 25차 검증 경로 불변',
    legacy.equity.length === plain.equity.length &&
      legacy.equity.every((e, i) => Object.is(e.equity, plain.equity[i].equity)) &&
      legacy.fills.length === plain.fills.length,
  )
  // 스톱을 0/미지정으로 두면 코드 경로가 아예 안 켜진다
  const stopOff = simulateRankYear(HISTORIES, '2001-01-01', syms, COST, { ...baseOpts, stopPct: 0 })
  check(
    'stopPct=0 은 스톱 미지정과 동일(경로 미작동)',
    stopOff.fills.length === plain.fills.length &&
      stopOff.equity.every((e, i) => Object.is(e.equity, plain.equity[i].equity)),
  )
}

// ============================================================================
section('2) 창 경계 — 판정 시점 이후를 조작해도 불변 / 창 안쪽을 건드리면 변한다')
// ============================================================================
{
  const D = '2004-03-01' // 리밸런스 달 1일
  const scaleFrom = (curve: { date: string; equity: number }[], from: string, k: number) =>
    curve.map((p) => (p.date >= from ? { ...p, equity: p.equity * k } : p))

  // ---- 12-1 모멘텀: 창의 오른쪽 경계는 "한 달 전 달 1일 직전" ----
  const m0 = regimeMom12_1(BENCH_CURVE, D)
  check('12-1 레짐 — 기준값 산출됨', m0 != null)
  const mAfter = regimeMom12_1(scaleFrom(BENCH_CURVE, '2004-02-01', 3), D)
  check('12-1 레짐 — 직전 1개월(2004-02~) 3배로 조작해도 불변', Object.is(m0, mAfter))
  const mInside = regimeMom12_1(scaleFrom(BENCH_CURVE, '2003-06-01', 3), D)
  check('12-1 레짐 — 창 안쪽(2003-06~)을 건드리면 값이 바뀐다(무시하는 함수가 아님)', !Object.is(m0, mInside))

  // ---- 10개월 이평: 리밸런스 달 이전에 끝난 달만 ----
  const ends = monthEndCloses(BENCH_CURVE)
  const a0 = regimeMaRiskOn(ends, '2004-03', OVL_MA_MONTHS)
  check('10개월 이평 레짐 — 기준값 산출됨', a0 != null)
  const aAfter = regimeMaRiskOn(monthEndCloses(scaleFrom(BENCH_CURVE, '2004-03-01', 3)), '2004-03', OVL_MA_MONTHS)
  eq('10개월 이평 레짐 — 당월(2004-03) 3배로 조작해도 불변', aAfter, a0)
  const aInside = regimeMaRiskOn(monthEndCloses(scaleFrom(BENCH_CURVE, '2003-11-01', 3)), '2004-03', OVL_MA_MONTHS)
  check('10개월 이평 레짐 — 창 안쪽(2003-11~)을 건드리면 판정이 바뀐다', aInside !== a0)

  // 노출 함수 수준에서도 같은 경계인가
  const expo = makeRegimeExposure(BENCH_CURVE, 'mom12_1')
  const expoTail = makeRegimeExposure(scaleFrom(BENCH_CURVE, '2004-02-01', 3), 'mom12_1')
  eq('레짐 노출 함수 — 판정 이후 구간 조작에 불변', expoTail('2004-03-04'), expo('2004-03-04'))
  check('레짐 노출 — 값은 0 또는 1', [0, 1].includes(expo('2004-03-04')))
  const expoEarly = makeRegimeExposure(BENCH_CURVE, 'mom12_1')('1999-02-01')
  eq('레짐 노출 — 판정 불가 구간은 게이트 미작동(=1)', expoEarly, 1)

  // ---- 실현 변동성: end 미만만 ----
  const vals = BENCH_CURVE.map((p) => p.equity)
  const END = 900
  const v0 = realizedVolPct(vals, END, OVL_VOL_WIN)
  check('실현변동성 — 기준값 산출됨', v0 != null)
  const tail = vals.map((v, i) => (i >= END ? v * 3 : v))
  check('실현변동성 — end 이후(당일 포함) 3배 조작에 불변', Object.is(v0, realizedVolPct(tail, END, OVL_VOL_WIN)))
  const inside = vals.map((v, i) => (i >= END - 10 && i < END ? v * 3 : v))
  check('실현변동성 — 창 안쪽을 건드리면 값이 바뀐다', !Object.is(v0, realizedVolPct(inside, END, OVL_VOL_WIN)))
  eq('실현변동성 — 표본 부족이면 null', realizedVolPct(vals, 5, OVL_VOL_WIN), null)

  // ---- 변동성 타게팅 노출 함수 ----
  const vt = makeVolTargetExposure(BENCH_CURVE, 15)
  const wv = vt('2004-03-01')
  check('변동성 타게팅 — 노출은 (0,1] 상한 1 (레버리지 금지)', wv > 0 && wv <= 1)
  const vtTail = makeVolTargetExposure(
    BENCH_CURVE.map((p) => (p.date >= '2004-03-01' ? { ...p, equity: p.equity * 3 } : p)),
    15,
  )
  check('변동성 타게팅 — 판정일 이후 구간 조작에 불변', Object.is(wv, vtTail('2004-03-01')))
  eq('변동성 타게팅 — 초기 표본 부족 구간은 노출 1', makeVolTargetExposure(BENCH_CURVE, 15)('1999-01-20'), 1)

  // ---- 역변동성 가중: i 미만만 ----
  const ea = BENCH_CURVE.map((p) => p.equity)
  const eb = makeBars(777, N_DAYS, 100).map((b) => b.c)
  const I = 900
  const w0 = invVolWeight(ea, eb, I, OVL_RP_WIN)
  const wTail = invVolWeight(
    ea.map((v, i) => (i >= I ? v * 3 : v)),
    eb.map((v, i) => (i >= I ? v * 3 : v)),
    I,
    OVL_RP_WIN,
  )
  check('역변동성 가중 — 리밸런스일(i) 이후 조작에 불변', Object.is(w0, wTail))
  const wInside = invVolWeight(
    ea.map((v, i) => (i >= I - 20 && i < I ? v * 3 : v)),
    eb,
    I,
    OVL_RP_WIN,
  )
  check('역변동성 가중 — 창 안쪽을 건드리면 값이 바뀐다', !Object.is(w0, wInside))
}

// ============================================================================
section('3) 절단 불변성 — 오버레이 4종 전부, 자른 시점 이전이 완전히 동일')
// ============================================================================
{
  const CUT = '2004-06-30'
  const HT = truncate(HISTORIES, CUT)
  const benchCut = BENCH_CURVE.filter((p) => p.date <= CUT)

  // 1) 시장 레짐 게이트 (12-1 · 10개월 이평)
  for (const kind of ['mom12_1', 'ma10m'] as const) {
    const full = chainOv(HISTORIES, { exposure: makeRegimeExposure(BENCH_CURVE, kind) })
    const cut = chainOv(HT, { exposure: makeRegimeExposure(benchCut, kind) })
    const r = sameCurveBefore(full.equity, cut.equity, CUT)
    check(`절단 불변 — 레짐 게이트 ${kind} (표본 ${r.n})`, r.ok && r.n > 500, r.detail)
  }

  // 2) 변동성 타게팅 — 2패스(베이스 곡선 → 노출)를 절단본에서 통째로 다시 돌린다.
  //    ⚠️ 합성 데이터의 베이스 실현 변동성은 8~12%라 운영 목표(15/20%)로는 노출이 한 번도
  //    깎이지 않는다 — 그 값으로만 테스트하면 "노출 1 = 베이스"를 비교하는 헛돌기가 된다.
  //    그래서 **묶이는 목표(9%)** 를 같이 돌리고, 아래에서 실제로 깎였는지 확인한다.
  const baseCurve = chainB(HISTORIES).equity
  for (const t of [9, 15]) {
    const full = chainOv(HISTORIES, { exposure: makeVolTargetExposure(baseCurve, t) })
    const cut = chainOv(HT, { exposure: makeVolTargetExposure(chainB(HT).equity, t) })
    const r = sameCurveBefore(full.equity, cut.equity, CUT)
    check(`절단 불변 — 변동성 타게팅 목표 ${t}% (2패스, 표본 ${r.n})`, r.ok && r.n > 500, r.detail)
  }
  {
    // 목표 9%는 실제로 노출을 깎아야 하고, 목표 100%는 한 번도 안 깎여 베이스와 같아야 한다
    const bound = chainOv(HISTORIES, { exposure: makeVolTargetExposure(baseCurve, 9) })
    const loose = chainOv(HISTORIES, { exposure: makeVolTargetExposure(baseCurve, 100) })
    const base = chainOv(HISTORIES, {})
    check(
      '변동성 타게팅 — 묶이는 목표(9%)에서 실제로 노출이 깎였다(테스트가 헛돌지 않음)',
      bound.equity.some((e, i) => !Object.is(e.equity, base.equity[i].equity)),
    )
    check(
      '변동성 타게팅 — 안 묶이는 목표(100%)는 베이스와 완전히 동일',
      loose.equity.every((e, i) => Object.is(e.equity, base.equity[i].equity)),
    )
    // ※ "노출을 줄였으니 낙폭도 얕아진다"는 **불변식이 아니다** — 하락 직전에 노출을 되돌리고
    //    반등 직전에 줄이면 더 깊어질 수도 있다. 그건 실측으로 볼 일이라 여기서 단정하지 않는다.
  }

  // 3) 월중 크래시 스톱 — 체결 원장까지 비교한다(스톱은 새 체결을 만든다)
  for (const x of [15, 20]) {
    const full = chainOv(HISTORIES, { stopPct: x })
    const cut = chainOv(HT, { stopPct: x })
    const r = sameCurveBefore(full.equity, cut.equity, CUT)
    check(`절단 불변 — 크래시 스톱 −${x}% (표본 ${r.n})`, r.ok && r.n > 500, r.detail)
  }
  {
    // 스톱이 실제로 발동했는지 확인 — 발동이 0건이면 위 절단 테스트는 아무것도 검증하지 않는다
    const syms = [...PIT1010[2003].ks, ...PIT1010[2003].kq]
    const off = simulateRankYear(HISTORIES, '2002-01-01', syms, COST, baseOpts)
    const on = simulateRankYear(HISTORIES, '2002-01-01', syms, COST, { ...baseOpts, stopPct: 15 })
    check('크래시 스톱이 실제로 발동해 원장이 달라졌다(테스트가 헛돌지 않음)', on.fills.length !== off.fills.length)
  }

  // 4) 결합 역변동성 가중
  {
    const full = blendRiskParity(chainB(HISTORIES).equity, BENCH_CURVE)
    const cut = blendRiskParity(chainB(HT).equity, benchCut)
    const r = sameCurveBefore(full, cut, CUT)
    check(`절단 불변 — 결합 역변동성 가중 (표본 ${r.n})`, r.ok && r.n > 500, r.detail)
  }
}

// ============================================================================
section('4) 노출 규약 — w=0 전량 현금 · w=0.5 금액만 절반(분모 불변 · 레버리지 없음)')
// ============================================================================
{
  const syms = [...PIT1010[2003].ks, ...PIT1010[2003].kq]
  const zero = simulateRankYear(HISTORIES, '2002-01-01', syms, COST, { ...baseOpts, exposure: () => 0 })
  eq('노출 0 — 체결이 하나도 없다', zero.fills.length, 0)
  check(
    '노출 0 — 자산곡선이 초기자본에 고정(현금)',
    zero.equity.every((e) => Object.is(e.equity, COST.initialCapital)),
  )
  eq('노출 0 — 기말 보유 종목 0', zero.openAtEnd, 0)

  const half = simulateRankYear(HISTORIES, '2002-01-01', syms, COST, { ...baseOpts, exposure: () => 0.5 })
  const first = half.fills.filter((f) => f.date === half.fills[0]?.date && f.side === 'buy')
  const spent = first.reduce((s, f) => s + f.px * f.qty, 0)
  check(
    `노출 0.5 — 첫 리밸런스 투입금이 자본의 절반 근처 (${(spent / COST.initialCapital).toFixed(3)})`,
    spent / COST.initialCapital > 0.45 && spent / COST.initialCapital <= 0.5,
  )
  check('노출 0.5 — 분모는 그대로라 담는 종목 수가 줄지 않는다', first.length === XSM.slots)
  check(
    '노출 상한 — 1을 넘겨 넣어도 1로 잘린다(레버리지 금지)',
    (() => {
      const over = simulateRankYear(HISTORIES, '2002-01-01', syms, COST, { ...baseOpts, exposure: () => 5 })
      const one = simulateRankYear(HISTORIES, '2002-01-01', syms, COST, { ...baseOpts, exposure: () => 1 })
      return over.equity.every((e, i) => Object.is(e.equity, one.equity[i].equity))
    })(),
  )
}

// ============================================================================
section('5) 크래시 스톱 체결 — 갭 관통은 시가 · 스침은 기준가 · 청산 슬롯은 월말까지 현금')
// ============================================================================
{
  // 손으로 만든 최소 시나리오: 월초 시가 100에 사고, 5일째에 −15% 선(85)을 건드린다.
  const days = (from: number, n: number) => Array.from({ length: n }, (_, i) => dayOf(from + i))
  const JAN = days(367, 20) // 2000-01-03 ~
  const FEB = days(398, 10)
  const flat = (date: string, o: number, h: number, l: number, c: number): DailyBar => ({ date, t: 0, o, h, l, c, v: 1e6 })

  function scenario(day5: { o: number; l: number }) {
    const bars: DailyBar[] = []
    for (const [i, d] of JAN.entries()) {
      if (i === 4) bars.push(flat(d, day5.o, Math.max(day5.o, 100), day5.l, day5.o))
      else bars.push(flat(d, 100, 101, 99, 100))
    }
    for (const d of FEB) bars.push(flat(d, 100, 101, 99, 100))
    return bars
  }
  const other = [...JAN, ...FEB].map((d) => flat(d, 50, 50.5, 49.5, 50))
  const rankBoth: RankFn = (_h, uni) => uni.map((s, i) => ({ sym: s, score: -i, aux: 1 }))
  const run = (aBars: DailyBar[], stopPct?: number) =>
    simulateRankYear({ AAA: aBars, BBB: other }, JAN[0], ['AAA', 'BBB'], COST, {
      slots: 2,
      rank: rankBoth,
      stopPct,
    })

  // (a) 갭 관통 — 시가 80이 이미 기준선 85 아래 → **시가**로 체결(불리한 쪽)
  const gap = run(scenario({ o: 80, l: 70 }), 15)
  const gapSell = gap.fills.find((f) => f.sym === 'AAA' && f.side === 'sell')
  check('갭 관통 — 스톱 체결이 발생', gapSell != null)
  closeTo('갭 관통 — 기준가(85)가 아니라 시가(80)로 체결', gapSell?.px ?? 0, 80, 1e-9)

  // (b) 스침 — 시가 90은 기준선 위, 저가 84가 85를 관통 → 기준가로 체결
  const touch = run(scenario({ o: 90, l: 84 }), 15)
  const touchSell = touch.fills.find((f) => f.sym === 'AAA' && f.side === 'sell')
  check('스침 — 스톱 체결이 발생', touchSell != null)
  closeTo('스침 — 기준가(85)로 체결', touchSell?.px ?? 0, 85, 1e-9)

  // (c) 기준선에 안 닿으면 스톱은 안 걸린다
  const safe = run(scenario({ o: 95, l: 90 }), 15)
  check('−15% 선에 안 닿으면 스톱 없음', !safe.fills.some((f) => f.sym === 'AAA' && f.side === 'sell'))

  // (d) 청산된 슬롯은 그 달 안에 되사지 않는다 — 다음 달 첫 거래일에만 복귀
  const reentry = touch.fills.filter((f) => f.sym === 'AAA' && f.side === 'buy').map((f) => f.date)
  eq('스톱 후 재진입은 다음 리밸런스에만 (매수일 2회: 1월초·2월초)', reentry.length, 2)
  check('스톱 후 재진입일이 다음 달 첫 거래일', reentry[1] === FEB[0], `got ${reentry[1]}`)
  check(
    '청산 시점~월말 사이 AAA 재매수 없음',
    !touch.fills.some((f) => f.sym === 'AAA' && f.side === 'buy' && f.date > (touchSell?.date ?? '') && f.date < FEB[0]),
  )

  // (e) 스톱 폭이 넓으면 같은 시나리오에서 안 걸린다(파라미터가 실제로 먹는가)
  const wide = run(scenario({ o: 90, l: 84 }), 20)
  check('스톱 −20%에서는 저가 84가 기준선(80) 위라 미발동', !wide.fills.some((f) => f.sym === 'AAA' && f.side === 'sell'))
}

// ============================================================================
section('6) 산술 — 실현변동성 · 역변동성 가중 · 지수 접합 · 위기 스칼라 · 판정 3항')
// ============================================================================
{
  // 일수익률이 정확히 ±1% 교대인 곡선의 표본표준편차 = 0.01×√(n/(n−1))
  const alt = (amp: number, n: number) => {
    const v = [1]
    for (let i = 1; i < n; i++) v.push(v[i - 1] * (1 + (i % 2 === 1 ? amp : -amp)))
    return v
  }
  const N = 61
  const sdA = stdevReturns(alt(0.01, N), N, 60)!
  closeTo('표본표준편차 — ±1% 교대 60개', sdA, 0.01 * Math.sqrt(60 / 59), 1e-9)
  closeTo('연환산 실현변동성 = 표준편차 × √252 × 100', realizedVolPct(alt(0.01, N), N, 60)!, sdA * Math.sqrt(252) * 100, 1e-9)

  // 변동성 비가 1:2면 역수 가중은 2/3 : 1/3
  closeTo('역변동성 가중 — 변동성 1:2 → 가중 2/3', invVolWeight(alt(0.01, N), alt(0.02, N), N, 60), 2 / 3, 1e-6)
  closeTo('역변동성 가중 — 같은 변동성이면 0.5', invVolWeight(alt(0.01, N), alt(0.01, N), N, 60), 0.5, 1e-9)
  eq('역변동성 가중 — 표본 부족이면 사후지식 없는 기본값 0.5', invVolWeight(alt(0.01, N), alt(0.02, N), 5, 60), 0.5)

  // 두 슬리브가 같은 곡선이면 역변동성 결합 = 50:50 결합 = 그 곡선
  {
    const c = chainB(HISTORIES).equity
    const rp = blendRiskParity(c, c)
    const fixed = blendCurves(c, c, 0.5)
    check(
      '동일 슬리브 — 역변동성 결합과 50:50 결합이 일치',
      rp.length === fixed.length && rp.every((p, i) => Math.abs(p.equity - fixed[i].equity) < 1e-12),
    )
    check(
      '동일 슬리브 — 결합 곡선이 원곡선 배수와 일치(레버리지 없음)',
      rp.every((p, i) => Math.abs(p.equity - c[i].equity / c[0].equity) < 1e-9),
    )
  }

  // 지수 접합 — 앞 구간은 수익률만, 이음매에서 레벨이 붙는다
  {
    const prim = [3, 4, 5].map((i) => flatBar(`2002-01-0${i}`, 200 + i))
    const fall = [1, 2].map((i) => flatBar(`2002-01-0${i}`, 10 + i))
    const sp = spliceRegimeCurve(prim, fall)
    eq('접합 — 길이 = 앞 구간 + 벤치 구간', sp.length, 5)
    closeTo('접합 — 이음매 직전 값이 벤치 첫 값과 같다(가짜 급등락 없음)', sp[1].equity, 203, 1e-9)
    closeTo('접합 — 앞 구간 수익률이 보존된다(12/11)', sp[1].equity / sp[0].equity, 12 / 11, 1e-9)
    closeTo('접합 — 벤치 구간은 원값 그대로', sp[4].equity, 205, 1e-9)
    eq('접합 — 폴백이 없으면 벤치만', spliceRegimeCurve(prim, []).length, 3)
  }

  // 곡선 인덱스/값 조회는 "미만"이다(이하가 아니다)
  {
    const c = [
      { date: '2020-01-01', equity: 1 },
      { date: '2020-01-02', equity: 2 },
      { date: '2020-01-03', equity: 3 },
    ]
    eq('curveIdxBefore — 경계일 자신은 포함하지 않는다', curveIdxBefore(c, '2020-01-02'), 1)
    eq('valueBefore — 경계일 직전 값', valueBefore(c, '2020-01-02'), 1)
    eq('valueBefore — 구간 앞이면 null', valueBefore(c, '2019-12-31'), null)
  }

  // 위기 연도 스칼라
  {
    const curve = [
      { date: '2007-12-31', equity: 100 },
      { date: '2008-03-01', equity: 120 },
      { date: '2008-09-01', equity: 60 },
      { date: '2008-12-31', equity: 80 },
    ]
    const cs = crisisStats(curve, [2008])
    closeTo('위기 스칼라 — 2008 연수익 = 80/100−1', cs[0].ret!, -20, 1e-9)
    closeTo('위기 스칼라 — 2008 연중 최대낙폭 = 60/120−1', cs[0].mdd!, -50, 1e-9)
    eq('위기 스칼라 — 그 해 점이 없으면 null', crisisStats(curve, [1999])[0].ret, null)
    eq('위기 연도 상수는 2008·2020·2022', CRISIS_YEARS.join(','), '2008,2020,2022')
  }

  // 판정 3항 — 비율 개선 + 전·후반 알파 양수
  {
    const perf = (total: number, cagr: number, mdd: number): Perf => ({
      total,
      cagr,
      mdd,
      obj: Math.abs(mdd) > 0.01 ? total / Math.abs(mdd) : null,
      years: 20,
    })
    const row = (label: string, total: number, cagr: number, mdd: number, aA: number | null, aB: number | null): StratRow => ({
      label,
      full: perf(total, cagr, mdd),
      a: perf(total, cagr, mdd),
      b: perf(total, cagr, mdd),
      closed: 100,
      wins: 50,
      alphaFull: aA,
      alphaA: aA,
      alphaB: aB,
      perYear: [],
    })
    const base = row('base', 1000, 20, -50, 5, 5) // obj 20
    const good = row('비율↑ 알파 양수', 600, 15, -20, 3, 2) // obj 30 ✅
    const ratioOnly = row('비율↑ 후반 알파 음수', 600, 15, -20, 3, -1) // △
    const worse = row('비율↓', 400, 12, -40, 3, 2) // obj 10 ❌
    const adopted = overlayVerdictTable(base, [good, ratioOnly, worse])
    eq('판정 — 3항 모두 만족한 변형만 채택된다', adopted, 1)
  }
}

function flatBar(date: string, c: number): DailyBar {
  return { date, t: 0, o: c, h: c, l: c, c, v: 1 }
}

finish()
