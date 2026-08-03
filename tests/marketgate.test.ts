// ⚠️ 이 파일은 `src/features/backtest/marketGate.ts`(+ `comboBlend.blend3Curves`)에 대한
// **의미론 정본과의 동형(isomorphism) 집행자**이자, CLAUDE.md 규칙 1(미래참조 금지)의 집행자다.
//
// 32차 칼마 1위(결합 50:50 + B슬리브 시장게이트(12-1) + 금 20%)를 화면 프리셋으로 옮기면서
// `scripts/idea-lab.entry.ts`(MODE=asset/overlay)의 함수들을 src로 이식했다. **옮겨 적기는
// 조용히 갈라진다** — 게이트 판정 창을 한 달만 밀어도, 환율 이월 방향을 뒤집어도, 3자 결합의
// 묶는 순서를 바꿔도 컴파일은 되고 화면도 뜬다. 그래서 여기서 두 구현을 같은 합성 데이터로
// 나란히 돌려 대조한다.
//
// 검증 항목
//   1) 동형 — `spliceRegimeCurve` · `regimeMom12_1` · `makeMonthGateMask`(≡ idea-lab
//      `makeRegimeExposure(_, 'mom12_1')`) · `toKrwCurve` · `blend3Curves`가 정본과 완전 일치
//   2) 게이트 마스크 산술 — 닫는 달을 정확히 고르고, 판정 불가 구간은 **열어 둔다**
//   3) 절단 불변성 — 레짐·슬리브·금 곡선 뒷부분을 잘라내도 잘린 시점 이전이 **완전히 동일**
//      (게이트 판정 창이 미래를 안 본다는 뜻. 한 점이라도 달라지면 어딘가에서 뒤를 봤다)
//   4) 환율 이월 — 결측일은 **직전** 환율이며, 뒤쪽 환율을 아무리 흔들어도 앞쪽 원화 값이
//      흔들리지 않는다(다음 환율을 당겨오면 그 자체가 미래참조다)
//   5) 2단 blend ≡ 3자 동시 결합 — `(A|B)|G` 가 `wA(1−g) : wB(1−g) : g` 와 같은 곡선인가
//   6) 금 꺼짐 ≡ 기존 결합 — 금이 없으면 `blendChainResults` 한 번과 **비트까지 동일**
//      (기존 프리셋 combo-50 · combo-25-75의 수치가 한 자리도 바뀌지 않는다는 보장)
//
// ⚠️ **게이트가 성적에 반영되는 산술 자체**는 여기가 아니라 `tests/xsmomchain.test.ts` §1-b가
//    집행한다 — 게이트는 곡선 후처리가 아니라 모멘텀 시뮬 안의 노출 훅이기 때문이다.
//    이 파일은 "어느 달을 닫을지"(마스크)와 "결합·환산·구간"만 본다.
//
// 네트워크를 타지 않는다. 합성 시계열만 쓴다.

import { check, close, eq, finish, rng, section } from './harness'
import { blend3Curves, blendChainResults, blendCurves } from '../src/features/backtest/comboBlend'
import {
  composeCombo,
  curveAsChain,
  makeMarketGateExposure,
  makeMonthGateMask,
  regimeMom12_1,
  spliceRegimeCurve,
  summarizeGate,
  toKrwCurve,
  valueBefore,
  type Curve,
} from '../src/features/backtest/marketGate'
import {
  blend3Curves as refBlend3,
  makeRegimeExposure as refGateMask,
  regimeMom12_1 as refMom,
  spliceRegimeCurve as refSplice,
  toKrwCurve as refToKrw,
} from '../scripts/idea-lab.entry'
import type { PitChainResult } from '../src/features/backtest/pitChain'
import type { DailyBar, EquityPoint } from '../src/features/backtest/types'

// ---- 합성 유틸 ----------------------------------------------------------------

/** 주말을 건너뛴 거래일 근사 날짜 목록 */
function tradingDates(from: string, to: string): string[] {
  const out: string[] = []
  const end = Date.parse(`${to}T00:00:00Z`)
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= end; t += 86400000) {
    const dow = new Date(t).getUTCDay()
    if (dow === 0 || dow === 6) continue
    out.push(new Date(t).toISOString().slice(0, 10))
  }
  return out
}

/** 결정적 난수 곡선. `skipEvery`면 그 주기의 날을 통째로 빼 결측일을 만든다. */
function makeCurve(dates: string[], seed: number, drift: number, noise: number, base = 100, skipEvery = 0): Curve {
  const rnd = rng(seed)
  const out: Curve = []
  let v = base
  let i = 0
  for (const date of dates) {
    i++
    v = Math.max(1e-6, v * (1 + drift + (rnd() - 0.5) * noise))
    if (skipEvery && i % skipEvery === 0) continue
    out.push({ date, equity: v })
  }
  return out
}

const asBars = (c: Curve): DailyBar[] => c.map((p) => ({ date: p.date, t: 0, o: p.equity, h: p.equity, l: p.equity, c: p.equity, v: 1 }))

const DATES = tradingDates('2001-01-01', '2010-12-31')

// ============================================================================
section('1) 동형 — 이식한 함수들이 정본(idea-lab)과 완전히 같은 값을 낸다')
// ============================================================================

{
  // 레짐 이음 — 벤치가 늦게 시작하는 상황(실제로 KODEX 200이 2002-10 시작이라 생긴 경로)
  const fullDates = tradingDates('1999-01-01', '2010-12-31')
  const fallback = asBars(makeCurve(fullDates, 3, 0.0004, 0.02, 700))
  const primary = asBars(makeCurve(tradingDates('2002-10-14', '2010-12-31'), 5, 0.0003, 0.02, 10_000))

  for (const [name, p, f] of [
    ['정상 이음', primary, fallback],
    ['폴백 없음', primary, [] as DailyBar[]],
    ['벤치가 1봉뿐', primary.slice(0, 1), fallback],
    ['폴백이 벤치보다 늦게 시작(머리가 없다)', primary, asBars(makeCurve(tradingDates('2005-01-01', '2010-12-31'), 7, 0.0002, 0.02))],
  ] as const) {
    const mine = spliceRegimeCurve(p, f)
    const ref = refSplice(p, f)
    let diff = -1
    for (let i = 0; i < Math.max(mine.length, ref.length); i++) {
      if (mine[i]?.date !== ref[i]?.date || !Object.is(mine[i]?.equity, ref[i]?.equity)) {
        diff = i
        break
      }
    }
    check(`spliceRegimeCurve [${name}] 정본과 완전 일치 (${mine.length}점)`, diff < 0 && mine.length === ref.length, `${diff}번째 · ${mine.length} vs ${ref.length}`)
  }

  const regime = spliceRegimeCurve(primary, fallback)

  // 12-1 모멘텀 — 달마다 대조. 데이터가 모자란 앞 구간(null)까지 같은 자리에서 같아야 한다.
  let momDiff = 0
  let momNull = 0
  // 레짐 곡선이 덮는 **전 구간**의 달을 본다 — 앞 12개월은 창을 못 채워 null이 나와야 하고,
  // 그 null 경로까지 정본과 같은 자리에서 같아야 한다.
  for (const ym of [...new Set(fullDates.map((d) => d.slice(0, 7)))]) {
    const a = regimeMom12_1(regime, `${ym}-01`)
    const b = refMom(regime, `${ym}-01`)
    if (a == null) momNull++
    if (!Object.is(a, b)) momDiff++
  }
  eq('regimeMom12_1이 정본과 다른 달의 수', momDiff, 0)
  check('판정 불가(null)인 달이 실제로 존재한다 — 앞 구간 경로가 태워졌다', momNull > 0, `${momNull}달`)

  // 게이트 마스크 ≡ idea-lab makeRegimeExposure(_, 'mom12_1')
  const mine = makeMonthGateMask(regime)
  const ref = refGateMask(regime, 'mom12_1')
  let maskDiff = 0
  let closed = 0
  for (const d of DATES) {
    const a = mine(d)
    if (a === 0) closed++
    if (!Object.is(a, ref(d))) maskDiff++
  }
  eq('게이트 마스크가 정본과 다른 날의 수', maskDiff, 0)
  check('게이트가 실제로 닫히는 날이 있다(마스크가 늘 1이면 검증이 공허하다)', closed > 0, `${closed}일`)

  // 원화 환산 — 결측일이 많은 환율로도 정본과 같은가
  const usd = asBars(makeCurve(DATES, 11, 0.0004, 0.02, 40))
  const fx = asBars(makeCurve(DATES, 13, 0.0001, 0.01, 1200, 3))
  const krwMine = toKrwCurve(usd, fx)
  const krwRef = refToKrw(usd, fx)
  let fxDiff = -1
  for (let i = 0; i < Math.max(krwMine.length, krwRef.length); i++) {
    if (krwMine[i]?.date !== krwRef[i]?.date || !Object.is(krwMine[i]?.equity, krwRef[i]?.equity)) {
      fxDiff = i
      break
    }
  }
  check(`toKrwCurve 정본과 완전 일치 (${krwMine.length}점)`, fxDiff < 0 && krwMine.length === krwRef.length, `${fxDiff}번째`)

  // 3자 결합 helper
  const a = makeCurve(DATES, 21, 0.0006, 0.03)
  const b = makeCurve(DATES, 23, 0.0002, 0.05)
  const g = makeCurve(tradingDates('2004-11-18', '2010-12-31'), 27, 0.0003, 0.02)
  for (const [wa, wb, wc] of [
    [0.4, 0.4, 0.2],
    [0.5, 0.3, 0.2],
    [1, 0, 0],
  ]) {
    const m = blend3Curves(a, b, g, wa, wb, wc)
    const r = refBlend3(a, b, g, wa, wb, wc)
    let d3 = -1
    for (let i = 0; i < Math.max(m.length, r.length); i++) {
      if (m[i]?.date !== r[i]?.date || !Object.is(m[i]?.equity, r[i]?.equity)) {
        d3 = i
        break
      }
    }
    check(`blend3Curves(${wa}:${wb}:${wc}) 정본과 완전 일치 (${m.length}점)`, d3 < 0 && m.length === r.length, `${d3}번째`)
  }

  // valueBefore는 **미만**이다 — 같은 날짜 값을 집어오면 그날 정보를 판정에 쓰는 셈이다
  const tiny: Curve = [
    { date: '2020-01-02', equity: 10 },
    { date: '2020-01-03', equity: 20 },
  ]
  eq('valueBefore는 그 날짜를 포함하지 않는다', valueBefore(tiny, '2020-01-03'), 10)
  eq('valueBefore 앞이 비면 null', valueBefore(tiny, '2020-01-02'), null)
}

// ============================================================================
section('2) 게이트 마스크 산술 — 어느 달을 닫는가 · 판정 불가는 열어 둔다')
// ============================================================================
//
// ⚠️ 게이트가 성적에 반영되는 산술(청산 비용·재매수)은 `tests/xsmomchain.test.ts` §1-b가
//    본다. 여기서는 마스크가 **고르는 달**만 검사한다.

{
  // 손계산이 되는 레짐 곡선을 만든다: 2019년 내내 상승 → 2020-01 판정은 열림.
  // 그 뒤 급락시켜 12-1이 음수가 되는 달을 만든다.
  const curve: Curve = []
  {
    let v = 100
    for (const [from, to, step] of [
      ['2018-01-01', '2019-12-31', 1.002],
      ['2020-01-01', '2020-12-31', 0.97],
    ] as const) {
      for (const d of tradingDates(from, to)) {
        v *= step
        curve.push({ date: d, equity: v })
      }
    }
  }
  const gateOf = makeMonthGateMask(curve)

  // 12개월 창을 못 채우는 앞 구간은 **열림**이어야 한다(임의 현금화 금지)
  eq('창을 못 채우는 첫 달은 열림', gateOf('2018-01-15'), 1)
  eq('창을 못 채우는 달은 계속 열림', gateOf('2018-06-15'), 1)
  // 2019년은 직전 12개월이 상승 구간이라 열림
  eq('상승 구간 뒤는 열림', gateOf('2019-06-15'), 1)
  // 2020년 하반기는 12-1 창이 급락 구간에 들어가 닫힘
  eq('급락이 창에 들어오면 닫힘', gateOf('2020-12-15'), 0)

  // 달 안 어느 날짜로 물어도 같은 값 — 판정 창이 ym만으로 결정된다는 뜻
  for (const ym of ['2019-06', '2020-12']) {
    const days = tradingDates(`${ym}-01`, `${ym}-28`)
    const vals = new Set(days.map((d) => gateOf(d)))
    eq(`[${ym}] 달 안 모든 날짜가 같은 판정`, vals.size, 1)
  }

  // 노출 함수는 마스크와 같은 값을 준다(넘기는 자리만 다르다)
  const exposure = makeMarketGateExposure(curve)
  let expDiff = 0
  for (const d of tradingDates('2018-01-01', '2020-12-31')) if (exposure(d) !== gateOf(d)) expDiff++
  eq('makeMarketGateExposure ≡ makeMonthGateMask', expDiff, 0)

  // 배지 집계 — 실제로 닫힌 달만 센다
  const dates = tradingDates('2020-01-01', '2020-12-31')
  const sum = summarizeGate(dates, gateOf)
  eq('덮은 달 수', sum.totalMonths, 12)
  check('닫힌 달이 존재한다', sum.gatedMonths.length > 0, `${sum.gatedMonths.length}달`)
  check('닫힌 달은 전부 2020년', sum.gatedMonths.every((m) => m.startsWith('2020-')))
  const allOpen = summarizeGate(dates, () => 1)
  eq('전부 열리면 닫힌 달 0', allOpen.gatedMonths.length, 0)
  const allShut = summarizeGate(dates, () => 0)
  eq('전부 닫히면 닫힌 달 = 전체 달', allShut.gatedMonths.length, allShut.totalMonths)
}

// ============================================================================
section('3) 절단 불변성 — 뒤를 잘라도 앞이 안 변한다 (규칙 1 집행)')
// ============================================================================

const CAP = 10_000_000

/** 배수 곡선 → `PitChainResult` 껍데기 (어댑터가 읽는 필드만 채운다) */
function fakeChain(curve: Curve, benchOf: (i: number) => number): PitChainResult {
  const equity: EquityPoint[] = curve.map((p, i) => ({
    date: p.date,
    equity: (p.equity / curve[0].equity) * CAP,
    benchmark: benchOf(i) * CAP,
    drawdownPct: 0,
  }))
  const years = [...new Set(curve.map((p) => p.date.slice(0, 4)))].map(Number).sort()
  return {
    equity,
    trades: [],
    perYear: years.map((year) => ({
      year,
      mapped: 18,
      total: 20,
      cash: false,
      strategyPct: 0,
      benchPct: 0,
      trades: 11,
      symbols: ['005930.KS'],
    })),
    startDate: curve[0].date,
    endDate: curve[curve.length - 1].date,
    years: 1,
    totalPct: 0,
    cagrPct: 0,
    mddPct: 0,
    objective: null,
    benchTotalPct: 12,
    benchCagrPct: 3,
    alphaCagrPct: 0,
    alphaTotalPct: 0,
    tradeCount: 7,
    winRate: 55,
    avgPnlPct: 1.2,
    openAtEnd: 2,
    exitBreakdown: [],
    lastScreen: [],
    lastScreenDate: '',
    mappedAvgPct: 90,
  }
}

{
  const fullDates = tradingDates('1999-01-01', '2010-12-31')
  const regime = spliceRegimeCurve(
    asBars(makeCurve(tradingDates('2002-10-14', '2010-12-31'), 5, 0.0003, 0.03, 10_000)),
    asBars(makeCurve(fullDates, 3, 0.0004, 0.03, 700)),
  )
  const ca = makeCurve(DATES, 31, 0.0006, 0.03)
  const cb = makeCurve(DATES, 37, 0.0002, 0.06)
  const goldDates = tradingDates('2004-11-18', '2010-12-31')
  const gold = makeCurve(goldDates, 41, 0.0004, 0.02, 45_000)
  const benchMul: number[] = []
  {
    let v = 1
    for (let i = 0; i < DATES.length; i++) {
      v *= 1.0002
      benchMul.push(v)
    }
  }
  const A = fakeChain(ca, (i) => benchMul[i])
  const B = fakeChain(cb, (i) => benchMul[i])

  const gateOf = makeMonthGateMask(regime)
  const full = composeCombo({ chainA: A, chainB: B, wA: 0.5, capital: CAP, gold, goldW: 0.2 })
  const fullGate = summarizeGate(DATES, gateOf)
  check('전 구간 결합 곡선이 만들어졌다', full.result.equity.length > 500, `${full.result.equity.length}점`)
  check('게이트가 실제로 달을 잠갔다', fullGate.gatedMonths.length > 0, `${fullGate.gatedMonths.length}달`)
  eq('금 슬리브가 붙은 구간 시작 = GLD 시작', full.goldFrom, goldDates[0])

  for (const frac of [0.45, 0.8]) {
    const cutDate = full.result.equity[Math.floor(full.result.equity.length * frac)].date
    const clip = <T extends { date: string }>(xs: T[]) => xs.filter((p) => p.date <= cutDate)
    const cut = composeCombo({
      chainA: { ...A, equity: clip(A.equity) },
      chainB: { ...B, equity: clip(B.equity) },
      wA: 0.5,
      capital: CAP,
      gold: clip(gold),
      goldW: 0.2,
    })
    let diff = -1
    for (let i = 0; i < cut.result.equity.length; i++) {
      const f = full.result.equity[i]
      const c = cut.result.equity[i]
      if (f.date !== c.date || !Object.is(f.equity, c.equity) || !Object.is(f.drawdownPct, c.drawdownPct)) {
        diff = i
        break
      }
    }
    check(
      `${cutDate} 절단본이 앞 구간과 완전 동일 (${cut.result.equity.length}점)`,
      diff < 0 && cut.result.equity.length > 0,
      diff >= 0 ? `${diff}번째 ${full.result.equity[diff]?.date}: ${full.result.equity[diff]?.equity} vs ${cut.result.equity[diff]?.equity}` : '',
    )
    // 게이트 판정도 잘린 구간 안에서 같아야 한다 — 뒤쪽 레짐 봉을 보고 앞 달을 잠갔다면 여기서 깨진다
    const cutGate = summarizeGate(
      DATES.filter((d) => d <= cutDate),
      makeMonthGateMask(clip(regime)),
    )
    const before = fullGate.gatedMonths.filter((ym) => ym <= cutDate.slice(0, 7))
    const cutBefore = cutGate.gatedMonths.filter((ym) => ym <= cutDate.slice(0, 7))
    eq(`${cutDate}까지의 게이트 달 목록 불변`, cutBefore.join(','), before.join(','))
  }

  // 뒤쪽 레짐 값을 **크게 조작**해도 앞 구간 게이트가 흔들리면 안 된다(절단보다 강한 검사)
  {
    const pivot = DATES[Math.floor(DATES.length * 0.6)]
    const tampered = regime.map((p) => (p.date > pivot ? { ...p, equity: p.equity * 1000 } : p))
    const a = makeMonthGateMask(regime)
    const b = makeMonthGateMask(tampered)
    let bad = 0
    // 조작 지점보다 **12개월 이상 앞선** 달은 창이 조작 구간에 닿지 않는다
    for (const d of DATES) if (d.slice(0, 7) < pivot.slice(0, 7) && a(d) !== b(d)) bad++
    eq('뒤쪽 레짐을 1000배로 조작해도 앞 구간 게이트 판정 불변', bad, 0)
  }
}

// ============================================================================
section('4) 환율 이월 — 결측일은 직전 값이고, 미래 환율은 앞을 못 건드린다')
// ============================================================================

{
  const usd = asBars([
    { date: '2020-01-02', equity: 10 },
    { date: '2020-01-03', equity: 12 },
    { date: '2020-01-06', equity: 15 },
  ])
  // 1/3 환율이 없다 → 1/2 환율(1000)이 이월돼야 한다. 1/6은 자기 환율(1300).
  const fx = asBars([
    { date: '2020-01-02', equity: 1000 },
    { date: '2020-01-06', equity: 1300 },
  ])
  const out = toKrwCurve(usd, fx)
  eq('환산 점 수', out.length, 3)
  close('1/2 = 10 × 1000', out[0].equity, 10_000, 1e-9)
  close('1/3 결측 → 직전 환율 1000 이월', out[1].equity, 12_000, 1e-9)
  close('1/6 = 15 × 1300', out[2].equity, 19_500, 1e-9)

  // 환율이 아직 시작되지 않은 앞 구간은 **버린다**(임의로 채우면 그 구간 비교가 거짓이 된다)
  const late = toKrwCurve(usd, asBars([{ date: '2020-01-06', equity: 1300 }]))
  eq('환율 시작 전 구간은 버린다', late.length, 1)
  eq('남은 점은 환율이 있는 날', late[0].date, '2020-01-06')

  // 뒤쪽 환율을 아무리 흔들어도 앞쪽 원화 값이 안 흔들린다 = 다음 값을 당겨오지 않았다
  const tampered = toKrwCurve(usd, asBars([
    { date: '2020-01-02', equity: 1000 },
    { date: '2020-01-06', equity: 99_999 },
  ]))
  close('앞 구간은 미래 환율에 영향받지 않는다 (1/2)', tampered[0].equity, 10_000, 1e-9)
  close('앞 구간은 미래 환율에 영향받지 않는다 (1/3)', tampered[1].equity, 12_000, 1e-9)
}

// ============================================================================
section('5) 2단 blend — 정본 경로와 동일 · 3자 동시 결합과는 첫 부분월만 다르다')
// ============================================================================
//
// 32차 1위 행의 **정본은 2단 결합**이다: idea-lab MODE=asset은
//   E1 = blendCurves(chainA, gateChain, 0.5)  →  `E1 + GLD 20%` = blendCurves(E1, G, 0.8)
// 로 만든다. `composeCombo`가 그 두 줄과 **같은 곡선**을 내는지가 1차 검증이다.
//
// 그 위에 "2단이 3자 동시 결합과 의미론적으로 같다"는 주석의 주장도 검사한다. 다만 그 등식은
// **월 경계에서 성립**하는 것이고, 결합 구간이 시작되는 **첫 부분월**에서는 갈린다:
//   · 3자 동시 결합은 구간 시작일(예: 2004-11-18)에 세 슬리브를 목표 가중으로 세운다.
//   · 2단 결합에서 안쪽 곡선(A:B)은 그 달 **1일**에 이미 리밸런스를 마치고 18일까지 표류한
//     상태다 — 즉 18일 시점의 A:B 내부 비율이 목표값이 아니다.
// 첫 달 경계(다음 달 1일)를 지나면 두 방식은 다시 같아진다. 그래서 **첫 부분월을 뺀 뒤**
// 대조한다. 이 차이를 "부동소수점 오차"로 뭉개면 진짜 갈라짐도 같이 숨는다.

{
  const ca = makeCurve(DATES, 51, 0.0006, 0.03)
  const cb = makeCurve(DATES, 53, 0.0002, 0.06)
  const gold = makeCurve(tradingDates('2004-11-18', '2010-12-31'), 57, 0.0004, 0.02, 45_000)
  const benchMul = DATES.map((_, i) => Math.pow(1.0002, i + 1))
  const A = fakeChain(ca, (i) => benchMul[i])
  const B = fakeChain(cb, (i) => benchMul[i])

  for (const [wA, g] of [
    [0.5, 0.2],
    [0.25, 0.3],
    [0.75, 0.1],
  ]) {
    const two = composeCombo({ chainA: A, chainB: B, wA, capital: CAP, gold, goldW: g }).result

    // (1) 정본 경로 — idea-lab MODE=asset의 두 줄을 그대로 재현한다
    const ref = blendCurves(blendCurves(A.equity, B.equity, wA), gold, 1 - g)
    eq(`[wA=${wA} 금=${g}] 정본 경로와 길이 일치`, two.equity.length, ref.length)
    let refWorst = 0
    const base2 = two.equity[0].equity
    for (let i = 0; i < ref.length; i++) {
      if (two.equity[i].date !== ref[i].date) {
        refWorst = Infinity
        break
      }
      refWorst = Math.max(refWorst, Math.abs(two.equity[i].equity / base2 - ref[i].equity))
    }
    check(`[wA=${wA} 금=${g}] 정본 2단 경로(blendCurves∘blendCurves)와 일치`, refWorst < 1e-12, `${refWorst}`)

    // (2) 3자 동시 결합과의 대조 — 첫 부분월을 뺀 뒤
    const three = blend3Curves(ca, cb, gold, wA * (1 - g), (1 - wA) * (1 - g), g)
    eq(`[wA=${wA} 금=${g}] 3자 결합과 길이 일치`, two.equity.length, three.length)
    const firstYm = three[0].date.slice(0, 7)
    const i0 = three.findIndex((p) => p.date.slice(0, 7) !== firstYm)
    check(`[wA=${wA} 금=${g}] 첫 달 경계를 찾았다`, i0 > 0, `${i0}`)
    let worst = 0
    const b2 = two.equity[i0].equity
    const b3 = three[i0].equity
    for (let i = i0; i < three.length; i++) {
      const x = two.equity[i].equity / b2
      const y = three[i].equity / b3
      worst = Math.max(worst, Math.abs(x - y) / Math.max(1e-12, Math.abs(y)))
    }
    check(
      `[wA=${wA} 금=${g}] 첫 달 경계 이후로는 3자 동시 결합과 같다 (최대 상대오차 ${worst.toExponential(2)})`,
      worst < 1e-10,
      `${worst}`,
    )
    // 첫 부분월에서는 **실제로 갈린다** — 이 차이가 0이면 위 설명이 거짓이거나 표본이 공허하다
    const gap = Math.abs(two.equity[0].equity / b2 - three[0].equity / b3)
    check(`[wA=${wA} 금=${g}] 첫 부분월에서는 갈린다(설명이 실재한다)`, gap > 1e-9, `${gap}`)
  }
}

// ============================================================================
section('6) 금 꺼짐 ≡ 기존 결합 — 기존 프리셋 수치가 한 자리도 안 바뀐다')
// ============================================================================

{
  const ca = makeCurve(DATES, 61, 0.0006, 0.03)
  const cb = makeCurve(DATES, 67, 0.0002, 0.06)
  const benchMul = DATES.map((_, i) => Math.pow(1.0002, i + 1))
  const A = fakeChain(ca, (i) => benchMul[i])
  const B = fakeChain(cb, (i) => benchMul[i])

  for (const wA of [0.25, 0.5, 0.75]) {
    const viaCompose = composeCombo({ chainA: A, chainB: B, wA, capital: CAP }).result
    const direct = blendChainResults(A, B, wA, CAP)
    eq(`wA=${wA} 길이 일치`, viaCompose.equity.length, direct.equity.length)
    let diff = -1
    for (let i = 0; i < direct.equity.length; i++) {
      if (
        viaCompose.equity[i].date !== direct.equity[i].date ||
        !Object.is(viaCompose.equity[i].equity, direct.equity[i].equity) ||
        !Object.is(viaCompose.equity[i].benchmark, direct.equity[i].benchmark)
      ) {
        diff = i
        break
      }
    }
    check(`wA=${wA} 금 없는 결합이 blendChainResults와 비트까지 같다`, diff < 0, `${diff}번째`)
    eq(`wA=${wA} 총수익도 동일`, viaCompose.totalPct, direct.totalPct)
    eq(`wA=${wA} MDD도 동일`, viaCompose.mddPct, direct.mddPct)
  }

  const plain = blendChainResults(A, B, 0.5, CAP)

  // 금 데이터가 없으면 금 비중이 0으로 내려앉고, 결과는 기존 결합 그대로다(숨기지 않는다)
  const noGold = composeCombo({ chainA: A, chainB: B, wA: 0.5, capital: CAP, gold: null, goldW: 0.2 })
  eq('금 데이터가 없으면 적용 비중 0', noGold.goldWApplied, 0)
  eq('금 데이터가 없으면 구간도 안 잘린다', noGold.result.equity.length, plain.equity.length)
}

// ============================================================================
section('7) curveAsChain — 곡선 껍데기의 원장은 비어 있다(0건이 아니라 귀속 불가)')
// ============================================================================

{
  const c = makeCurve(DATES, 71, 0.0004, 0.02, 1000)
  const shell = curveAsChain(c, { capital: CAP })
  close('시작값 = 초기자본', shell.equity[0].equity, CAP, 1e-6)
  close(
    '총수익%가 곡선 배수와 일치',
    shell.totalPct,
    (c[c.length - 1].equity / c[0].equity - 1) * 100,
    1e-9,
  )
  check('MDD ≤ 0', shell.mddPct <= 0, `${shell.mddPct}`)
  eq('원장 없음', shell.trades.length, 0)
  eq('tradeCount = 0 (귀속 불가)', shell.tradeCount, 0)
  eq('winRate = null (귀속 불가)', shell.winRate, null)
  eq('벤치를 안 주면 알파는 null (없는 비교를 만들지 않는다)', shell.alphaCagrPct, null)
  const withBench = curveAsChain(c, { capital: CAP, benchTotalPct: 50, benchCagrPct: 4 })
  close('벤치를 주면 알파 = CAGR − 벤치 CAGR', withBench.alphaCagrPct!, withBench.cagrPct - 4, 1e-9)
}

// ============================================================================
section('8) 결합 곡선 위생 — 금이 붙으면 구간이 잘리고 벤치는 A 계보에서 온다')
// ============================================================================

{
  const ca = makeCurve(DATES, 81, 0.0006, 0.03)
  const cb = makeCurve(DATES, 83, 0.0002, 0.06)
  const goldDates = tradingDates('2004-11-18', '2010-12-31')
  const gold = makeCurve(goldDates, 87, 0.0004, 0.02, 45_000)
  const benchMul = DATES.map((_, i) => Math.pow(1.0002, i + 1))
  const A = fakeChain(ca, (i) => benchMul[i])
  const B = fakeChain(cb, (i) => benchMul[i])

  const out = composeCombo({ chainA: A, chainB: B, wA: 0.5, capital: CAP, gold, goldW: 0.2 }).result
  eq('결합 시작 = 금 곡선 시작(겹치는 구간만 남는다)', out.startDate, goldDates[0])
  check('구간이 실제로 잘렸다', out.startDate > A.startDate, `${A.startDate} → ${out.startDate}`)
  check('벤치가 살아 있다(금 껍데기 때문에 null이 되지 않는다)', out.benchTotalPct != null, `${out.benchTotalPct}`)
  close('알파(연) = CAGR − 벤치 CAGR', out.alphaCagrPct!, out.cagrPct - out.benchCagrPct!, 1e-9)
  // 벤치는 **잘린 구간 양끝**으로 다시 재야 알파가 같은 구간 비교가 된다
  const i0 = DATES.indexOf(goldDates.find((d) => DATES.includes(d))!)
  check('벤치 첫 값이 결합 구간 시작의 벤치다', i0 >= 0 && Math.abs(out.equity[0].benchmark - benchMul[i0] * CAP) < 1, `${out.equity[0].benchmark}`)
  eq('연도별 분해가 결합 구간만 덮는다', out.perYear[0].year, Number(goldDates[0].slice(0, 4)))
  // 연도별 수익률의 곱 = 전체 배수 (연쇄 규약과 같은 분해)
  const prod = out.perYear.reduce((s, r) => s * (1 + r.strategyPct / 100), 1)
  close('연도별 수익률의 곱 = 전체 배수', prod, 1 + out.totalPct / 100, 1e-9)
}

finish()
