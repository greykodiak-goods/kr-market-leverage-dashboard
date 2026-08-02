// ⚠️ 이 파일은 MODE=asset(자산군 분산 — 채권·금 슬리브)에 대한 CLAUDE.md 규칙 1
// (미래참조 금지) + 규칙 3(데이터 정직성)의 집행자다.
//
// 이 모드에서 미래참조가 숨을 수 있는 자리는 두 곳이다:
//
//   1) **원화 환산** — 환율 결측일에 "다음 환율"을 당겨오면 그 자체가 미래참조다.
//      `toKrwCurve`는 반드시 **직전 이월**이어야 하고, 뒤쪽 환율을 아무리 조작해도
//      앞쪽 원화 값이 흔들리면 안 된다.
//   2) **3자 합성(2단 blend)** — 월별 리밸런스가 달 경계 이후 정보를 보면 안 된다.
//      2단 합성이 진짜 3자 동시 결합과 **의미론적으로 같은지**를 독립 구현으로 대조한다
//      (같지 않으면 주석의 "의미론 동일" 주장이 거짓이 된다).
//
// 그리고 구간 정직성:
//   3) `commonSpan`/`clipCurve` — 구간이 다른 칼마를 나란히 놓지 않도록 교집합을 정확히 잡는다.
//   4) `calmarOf` — 판정 지표 산술. `Perf.obj`(총수익÷MDD)와 **다른 값**임을 못 박는다.
//   5) `stratTable` 칼마 열은 **기본 꺼짐** — 기존 모드 출력 바이트 불변(골든 유지).
//
// 실데이터(Yahoo)는 컨테이너에서 403이라 전부 합성 시계열로 검증한다.

import { check, close as closeTo, eq, section, finish, rng } from './harness'
import {
  assetVerdictTable,
  blend3Curves,
  blendCurves,
  calmarOf,
  clipCurve,
  commonSpan,
  perfOf,
  spanOf,
  stratTable,
  toKrwCurve,
  type Perf,
  type StratRow,
} from '../scripts/idea-lab.entry'
import type { DailyBar } from '../src/features/backtest/types'

// ---- 합성 유틸 ----------------------------------------------------------------

const dayOf = (i: number) => new Date(Date.UTC(2004, 0, 1) + i * 86400000).toISOString().slice(0, 10)

/** 결정적 난수 곡선 — 날짜 그리드는 호출부가 지정한다(정렬 필수). */
function makeCurve(seed: number, dates: string[], base = 1000): { date: string; equity: number }[] {
  const rnd = rng(seed)
  let p = base
  return dates.map((date) => {
    p = Math.max(1, p * (1 + 0.0003 + 0.02 * (rnd() * 2 - 1)))
    return { date, equity: p }
  })
}

function flatBar(date: string, c: number): DailyBar {
  return { date, t: 0, o: c, h: c, l: c, c, v: 1 }
}

/** console.log를 가로채 표 출력 문자열을 모은다(바이트 불변 검사용). */
function capture(fn: () => void): string {
  const orig = console.log
  const lines: string[] = []
  console.log = (msg?: unknown) => {
    lines.push(String(msg))
  }
  try {
    fn()
  } finally {
    console.log = orig
  }
  return lines.join('\n')
}

// ============================================================================
section('1) 칼마 산술 — CAGR÷|MDD| (Perf.obj와 다른 지표다)')
// ============================================================================
{
  const p = (total: number, cagr: number, mdd: number): Perf => ({
    total,
    cagr,
    mdd,
    obj: Math.abs(mdd) > 0.01 ? total / Math.abs(mdd) : null,
    years: 20,
  })

  closeTo('칼마 = CAGR ÷ |MDD|', calmarOf(p(1000, 12, -30))!, 0.4, 1e-12)
  closeTo('MDD 부호는 절대값으로', calmarOf(p(1000, 12, -30))!, calmarOf(p(1000, 12, -30))!, 0)
  eq('MDD가 사실상 0이면 null (발산 방지)', calmarOf(p(5, 5, -0.001)), null)
  eq('MDD 정확히 0도 null', calmarOf(p(0, 0, 0)), null)
  check('CAGR 음수면 칼마도 음수', calmarOf(p(-50, -8, -60))! < 0)

  // 핵심: obj와 칼마는 **다른 값**이다. 같은 값을 쓰면 구간 편향이 그대로 남는다.
  const long = p(1000, 12, -30) // 총수익 1000% · CAGR 12%
  check('총수익÷MDD와 칼마는 서로 다른 값 (구간 길이 편향 제거가 목적)', long.obj !== calmarOf(long))
  closeTo('총수익÷MDD는 33.3인데 칼마는 0.4 — 자릿수부터 다르다', long.obj!, 1000 / 30, 1e-12)

  // 구간 길이 편향 시연: 같은 CAGR·MDD인데 구간만 길면 obj는 커지고 칼마는 그대로다.
  const short = perfOf([
    { date: '2010-01-01', equity: 100 },
    { date: '2011-01-01', equity: 110 },
  ])
  const longer = perfOf([
    { date: '2010-01-01', equity: 100 },
    { date: '2020-01-01', equity: 100 * Math.pow(1.1, 10) },
  ])
  closeTo('구간이 달라도 CAGR은 같다 (연 10%)', short.cagr, longer.cagr, 0.05)
  check('낙폭 없는 곡선은 칼마 null (분모 0)', calmarOf(short) === null && calmarOf(longer) === null)
}

// ============================================================================
section('2) 구간 통일 — commonSpan · clipCurve')
// ============================================================================
{
  const a = [
    { date: '2000-01-01', equity: 1 },
    { date: '2020-12-31', equity: 2 },
  ]
  const b = [
    { date: '2002-07-30', equity: 1 },
    { date: '2021-06-30', equity: 2 },
  ]
  const c = [
    { date: '2004-11-18', equity: 1 },
    { date: '2019-12-31', equity: 2 },
  ]

  const sp = commonSpan([a, b, c])!
  eq('교집합 시작 = 가장 늦은 시작 (GLD 상장일 역할)', sp[0], '2004-11-18')
  eq('교집합 끝 = 가장 이른 끝', sp[1], '2019-12-31')

  eq('빈 곡선이 하나라도 있으면 null', commonSpan([a, []]), null)
  eq('곡선이 없으면 null', commonSpan([]), null)
  eq(
    '겹치지 않으면 null',
    commonSpan([
      [
        { date: '2000-01-01', equity: 1 },
        { date: '2001-01-01', equity: 1 },
      ],
      [
        { date: '2010-01-01', equity: 1 },
        { date: '2011-01-01', equity: 1 },
      ],
    ]),
    null,
  )

  const dates = Array.from({ length: 400 }, (_, i) => dayOf(i))
  const curve = makeCurve(11, dates)
  const clipped = clipCurve(curve, dates[100], dates[200])
  eq('clipCurve 시작 포함', clipped[0].date, dates[100])
  eq('clipCurve 끝 포함', clipped[clipped.length - 1].date, dates[200])
  eq('clipCurve 길이', clipped.length, 101)
  check(
    'clipCurve는 값을 바꾸지 않는다(정규화 없음)',
    clipped.every((p, i) => p.equity === curve[100 + i].equity),
  )
  eq('구간 밖이면 빈 곡선', clipCurve(curve, '2099-01-01', '2099-12-31').length, 0)
  eq('spanOf가 clip 결과와 일치', spanOf(clipped).join('~'), `${dates[100]}~${dates[200]}`)
}

// ============================================================================
section('3) 3자 합성 — 2단 blend가 진짜 3자 동시 결합과 같은가 (독립 구현 대조)')
// ============================================================================
{
  /**
   * **독립 3자 참조 구현** — `blendMonthlyRebalanced`를 3자로 직접 확장한 것.
   * 이 함수가 정답이고, `blend3Curves`(2단 합성)가 여기에 맞아야 한다.
   * 달 경계에서 목표 가중으로 되돌리고, 달 안에서는 각자 표류한다.
   */
  function blend3Reference(
    dates: string[],
    ea: number[],
    eb: number[],
    ec: number[],
    wA: number,
    wB: number,
    wC: number,
  ): number[] {
    if (dates.length < 1) return []
    let vA = wA
    let vB = wB
    let vC = wC
    let curYm = dates[0].slice(0, 7)
    const out: number[] = [vA + vB + vC]
    for (let i = 1; i < dates.length; i++) {
      const ym = dates[i].slice(0, 7)
      if (ym !== curYm) {
        curYm = ym
        const v = vA + vB + vC
        vA = v * wA
        vB = v * wB
        vC = v * wC
      }
      vA *= ea[i - 1] > 0 ? ea[i] / ea[i - 1] : 1
      vB *= eb[i - 1] > 0 ? eb[i] / eb[i - 1] : 1
      vC *= ec[i - 1] > 0 ? ec[i] / ec[i - 1] : 1
      out.push(vA + vB + vC)
    }
    return out
  }

  // 같은 날짜 그리드 위의 세 곡선 (주식 · 채권 · 금 역할)
  const dates = Array.from({ length: 900 }, (_, i) => dayOf(i))
  const A = makeCurve(101, dates, 1000)
  const B = makeCurve(202, dates, 90)
  const C = makeCurve(303, dates, 130)

  for (const [wA, wB, wC] of [
    [0.6, 0.2, 0.2],
    [0.8, 0.1, 0.1],
    [0.5, 0.25, 0.25],
    [0.34, 0.33, 0.33],
  ] as const) {
    const got = blend3Curves(A, B, C, wA, wB, wC)
    const want = blend3Reference(
      dates,
      A.map((p) => p.equity),
      B.map((p) => p.equity),
      C.map((p) => p.equity),
      wA / (wA + wB + wC),
      wB / (wA + wB + wC),
      wC / (wA + wB + wC),
    )
    eq(`2단 합성 길이 동일 (${wA}/${wB}/${wC})`, got.length, want.length)
    let maxRel = 0
    for (let i = 0; i < want.length; i++) maxRel = Math.max(maxRel, Math.abs(got[i].equity - want[i]) / want[i])
    check(`2단 합성 ≡ 3자 동시 결합 (${wA}/${wB}/${wC}) — 상대오차 ${maxRel.toExponential(2)}`, maxRel < 1e-10)
  }

  // 가중 정규화 — 합이 1이 아니어도 비율만 맞으면 같은 곡선
  {
    const norm = blend3Curves(A, B, C, 0.6, 0.2, 0.2)
    const raw = blend3Curves(A, B, C, 6, 2, 2)
    let maxRel = 0
    for (let i = 0; i < norm.length; i++)
      maxRel = Math.max(maxRel, Math.abs(norm[i].equity - raw[i].equity) / norm[i].equity)
    check('가중치는 내부에서 합 1로 정규화된다 (6:2:2 ≡ 0.6:0.2:0.2)', maxRel < 1e-12)
  }

  // 비중 0 경계 — 자산 슬리브가 0이면 주식 곡선 그대로(배수)
  {
    const only = blend3Curves(A, B, C, 1, 0, 0)
    let maxRel = 0
    for (let i = 0; i < only.length; i++)
      maxRel = Math.max(maxRel, Math.abs(only[i].equity - A[i].equity / A[0].equity) / (A[i].equity / A[0].equity))
    check('wB=wC=0이면 A 곡선 그대로(시작 1.0 배수)', maxRel < 1e-12)
    eq('가중 합이 0이면 빈 곡선', blend3Curves(A, B, C, 0, 0, 0).length, 0)
  }

  // 한쪽 자산만 쓰는 변형은 2자 blendCurves와 같아야 한다 (E1+T20 경로)
  {
    const three = blend3Curves(A, B, B, 0.8, 0.1, 0.1) // B를 둘로 쪼갠 것 = B 20%
    const two = blendCurves(A, B, 0.8)
    let maxRel = 0
    for (let i = 0; i < two.length; i++) maxRel = Math.max(maxRel, Math.abs(three[i].equity - two[i].equity) / two[i].equity)
    check('같은 자산을 둘로 쪼개면 2자 결합과 동일 (E1+T20 경로 정합)', maxRel < 1e-10)
  }

  // 날짜 그리드가 다른 경우 — 교집합 구간만 남는다(한쪽만 있는 구간이 통째로 그 곡선 성적이 되면 안 됨)
  {
    const late = makeCurve(404, dates.slice(300), 50) // 300일 늦게 시작
    const got = blend3Curves(A, B, late, 0.6, 0.2, 0.2)
    eq('늦게 시작한 자산이 있으면 합성 시작도 그만큼 늦다', got[0].date, dates[300])
    eq('합성 끝은 공통 끝', got[got.length - 1].date, dates[dates.length - 1])
  }
}

// ============================================================================
section('4) 절단 불변성 — 3자 합성 (규칙 1 집행)')
// ============================================================================
{
  const dates = Array.from({ length: 700 }, (_, i) => dayOf(i))
  const A = makeCurve(11, dates, 1000)
  const B = makeCurve(22, dates, 80)
  const C = makeCurve(33, dates, 140)
  const cut = 480

  const full = blend3Curves(A, B, C, 0.6, 0.2, 0.2)
  const trunc = blend3Curves(A.slice(0, cut), B.slice(0, cut), C.slice(0, cut), 0.6, 0.2, 0.2)

  eq('절단본 길이 = 절단 지점', trunc.length, cut)
  let diffs = 0
  for (let i = 0; i < trunc.length; i++) {
    if (trunc[i].date !== full[i].date || !Object.is(trunc[i].equity, full[i].equity)) diffs++
  }
  eq('절단 전 구간의 합성 값이 **완전히 동일** (미래참조 0건)', diffs, 0)

  // 뒷부분을 3배로 조작해도 앞이 흔들리면 안 된다 — "절단"보다 강한 조작 테스트
  {
    const tamper = (cv: { date: string; equity: number }[]) =>
      cv.map((p, i) => (i >= cut ? { date: p.date, equity: p.equity * 3 } : p))
    const after = blend3Curves(tamper(A), tamper(B), tamper(C), 0.6, 0.2, 0.2)
    let bad = 0
    for (let i = 0; i < cut; i++) if (!Object.is(after[i].equity, full[i].equity)) bad++
    eq('절단 지점 이후를 3배로 조작해도 이전 값 불변', bad, 0)
    check('조작 구간 안쪽은 실제로 바뀐다(아무것도 안 보는 함수가 아님)', after[cut + 10].equity !== full[cut + 10].equity)
  }

  // 2자 결합도 같은 성질 (E1+T20 경로)
  {
    const f2 = blendCurves(A, B, 0.8)
    const t2 = blendCurves(A.slice(0, cut), B.slice(0, cut), 0.8)
    let bad = 0
    for (let i = 0; i < t2.length; i++) if (!Object.is(t2[i].equity, f2[i].equity)) bad++
    eq('2자 결합도 절단 불변', bad, 0)
  }
}

// ============================================================================
section('5) 원화 환산 산술 — toKrwCurve (직전 이월 · 미래 환율 금지)')
// ============================================================================
{
  const fx: DailyBar[] = [
    flatBar('2004-01-05', 1000),
    flatBar('2004-01-07', 1100),
    flatBar('2004-01-12', 1200),
  ]
  const usd: DailyBar[] = [
    flatBar('2004-01-02', 10), // 환율보다 앞 → 버린다
    flatBar('2004-01-05', 10), // 1000 → 10,000
    flatBar('2004-01-06', 20), // 환율 결측 → 직전(1000) 이월 → 20,000
    flatBar('2004-01-07', 20), // 1100 → 22,000
    flatBar('2004-01-09', 30), // 결측 → 1100 이월 → 33,000
    flatBar('2004-01-12', 30), // 1200 → 36,000
  ]
  const out = toKrwCurve(usd, fx)

  eq('환율보다 앞선 봉은 버린다 (환산 불가 구간을 지어내지 않음)', out.length, 5)
  eq('첫 점은 환율 시작일', out[0].date, '2004-01-05')
  closeTo('당일 환율 적용', out[0].equity, 10 * 1000, 1e-9)
  closeTo('환율 결측일은 **직전 이월** (다음 환율 당겨오기 금지)', out[1].equity, 20 * 1000, 1e-9)
  closeTo('환율 갱신일', out[2].equity, 20 * 1100, 1e-9)
  closeTo('갱신 후 결측일도 직전 이월', out[3].equity, 30 * 1100, 1e-9)
  closeTo('마지막 환율 적용', out[4].equity, 30 * 1200, 1e-9)

  // 미래 환율을 당겨왔다면 1/6 값이 1100·1200이 됐을 것이다 — 그 오답을 명시적으로 배제
  check('1/6 값이 미래 환율(1100)로 계산되지 않았다', Math.abs(out[1].equity - 20 * 1100) > 1)

  // 결측·비정상 값 방어
  {
    const bad = toKrwCurve([flatBar('2004-01-05', 0), flatBar('2004-01-06', 10)], fx)
    eq('종가 0인 봉은 버린다', bad.length, 1)
    const zeroFx = toKrwCurve([flatBar('2004-01-05', 10)], [flatBar('2004-01-05', 0)])
    eq('환율 0은 유효 환율이 아니다 → 그 봉도 버린다', zeroFx.length, 0)
  }

  // 절단 불변성 — 뒤쪽 환율을 아무리 조작해도 앞쪽 원화 값은 그대로
  {
    const tamperedFx = [flatBar('2004-01-05', 1000), flatBar('2004-01-07', 1100), flatBar('2004-01-12', 99999)]
    const after = toKrwCurve(usd, tamperedFx)
    let bad = 0
    for (let i = 0; i < 4; i++) if (!Object.is(after[i].equity, out[i].equity)) bad++
    eq('마지막 환율을 조작해도 그 이전 원화 값 불변', bad, 0)
    check('조작한 날짜는 실제로 바뀐다', after[4].equity !== out[4].equity)

    const truncated = toKrwCurve(usd.slice(0, 4), fx.slice(0, 2))
    let bad2 = 0
    for (let i = 0; i < truncated.length; i++) if (!Object.is(truncated[i].equity, out[i].equity)) bad2++
    eq('환율·시세를 함께 절단해도 이전 값 불변', bad2, 0)
  }

  // 합성 케이스: 환산 곡선을 다시 결합해도 산술이 유지된다(모드가 실제로 쓰는 경로)
  {
    const dates = Array.from({ length: 300 }, (_, i) => dayOf(i))
    const stock = makeCurve(77, dates, 1000)
    const usdBars = dates.map((d, i) => flatBar(d, 50 + i * 0.1))
    const fxBars = dates.filter((_, i) => i % 3 === 0).map((d, i) => flatBar(d, 1100 + i))
    const krw = toKrwCurve(usdBars, fxBars)
    check('환산 곡선이 결합에 쓸 만큼 길다', krw.length > 250)
    const mixed = blendCurves(stock, krw, 0.8)
    check('환산 곡선과의 결합이 유한값', mixed.every((p) => Number.isFinite(p.equity) && p.equity > 0))
    eq('결합 구간은 환산 곡선 시작 이후', mixed[0].date >= krw[0].date, true)
  }
}

// ============================================================================
section('6) 판정 표 — 칼마 기준 3항 (assetVerdictTable)')
// ============================================================================
{
  const perf = (cagr: number, mdd: number): Perf => ({
    total: cagr * 20,
    cagr,
    mdd,
    obj: Math.abs(mdd) > 0.01 ? (cagr * 20) / Math.abs(mdd) : null,
    years: 20,
  })
  const row = (label: string, cagr: number, mdd: number, aA: number | null, aB: number | null): StratRow => ({
    label,
    full: perf(cagr, mdd),
    a: perf(cagr, mdd),
    b: perf(cagr, mdd),
    closed: 0,
    wins: 0,
    alphaFull: aA,
    alphaA: aA,
    alphaB: aB,
    perYear: [],
  })

  const base = row('E1 베이스', 15, -25, 5, 5) // 칼마 0.600
  const good = row('칼마↑ 알파 양수', 12, -18, 3, 2) // 칼마 0.667 ✅
  const calmarOnly = row('칼마↑ 후반 알파 음수', 12, -18, 3, -1) // △
  const worse = row('칼마↓', 10, -25, 3, 2) // 칼마 0.400 ❌

  let adopted = -1
  const out = capture(() => {
    adopted = assetVerdictTable(base, [good, calmarOnly, worse])
  })
  eq('판정 — 칼마 개선 + 전·후반 알파 양수를 **모두** 만족한 변형만 채택', adopted, 1)
  check('판정표에 칼마 열이 있다', out.includes('| 변형 | 칼마 | Δ칼마 |'))
  check('ΔCAGR 열이 있다 (수익을 얼마나 깎았는지 숨기지 않는다)', out.includes('**ΔCAGR**'))
  check('△(칼마만) 표기가 나온다', out.includes('△ 칼마만'))
  check('❌ 표기가 나온다', out.includes('❌'))
  closeTo('베이스 칼마 산술 확인', calmarOf(base.full)!, 15 / 25, 1e-12)
  closeTo('채택행 칼마 산술 확인', calmarOf(good.full)!, 12 / 18, 1e-12)

  // 칼마가 같으면(개선 아님) 채택하지 않는다 — 부동소수 경계
  {
    const tie = row('칼마 동일', 15, -25, 3, 3)
    const n = capture(() => assetVerdictTable(base, [tie]))
    check('칼마가 같기만 하면 채택 아님(엄격 초과여야 함)', n.includes('❌'))
  }
}

// ============================================================================
section('7) 칼마 열은 기본 꺼짐 — 기존 모드 출력 바이트 불변 (골든 유지)')
// ============================================================================
{
  const perf = (cagr: number, mdd: number): Perf => ({
    total: cagr * 20,
    cagr,
    mdd,
    obj: Math.abs(mdd) > 0.01 ? (cagr * 20) / Math.abs(mdd) : null,
    years: 20,
  })
  const rows: StratRow[] = [
    {
      label: 'X',
      full: perf(15, -25),
      a: perf(14, -20),
      b: perf(16, -30),
      closed: 10,
      wins: 6,
      alphaFull: 3,
      alphaA: 2,
      alphaB: 4,
      perYear: [],
    },
  ]

  const legacy = capture(() => stratTable(rows))
  const explicitOff = capture(() => stratTable(rows, 2014, {}))
  const offFlag = capture(() => stratTable(rows, 2014, { calmar: false }))
  const on = capture(() => stratTable(rows, 2014, { calmar: true }))

  eq('인자 없이 부른 출력 = opts 생략 출력 (바이트 동일)', legacy, explicitOff)
  eq('calmar:false도 동일 (기존 모드 골든 불변)', legacy, offFlag)
  check('calmar 기본 출력에는 칼마 열이 없다', !legacy.includes('칼마'))
  check('calmar:true면 칼마 열이 붙는다', on.includes('**칼마(CAGR÷MDD)**'))

  // 열 개수가 정확히 하나 늘었는가 — 헤더/구분선/본문 셋 다
  const cols = (s: string, i: number) => s.split('\n')[i].split('|').length
  eq('헤더 열 +1', cols(on, 0), cols(legacy, 0) + 1)
  eq('구분선 열 +1', cols(on, 1), cols(legacy, 1) + 1)
  eq('본문 열 +1', cols(on, 2), cols(legacy, 2) + 1)
  check('본문에 칼마 값(0.600)이 찍힌다', on.split('\n')[2].includes('0.600'))
}

finish()
