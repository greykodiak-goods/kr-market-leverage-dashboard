// ⚠️ 이 파일은 `src/features/backtest/comboBlend.ts`에 대한 **의미론 정본과의 동형(isomorphism)
// 집행자**이자, CLAUDE.md 규칙 1(미래참조 금지)의 집행자다.
//
// 결합(기준선 + 횡단면 모멘텀 월 리밸런스)은 원래 `scripts/idea-lab.entry.ts`(MODE=combo)에만
// 있던 실험 코드였다. 그것을 화면에서 쓰려고 src로 옮겨 적었는데, **옮겨 적기는 조용히 갈라진다** —
// 리밸런스를 달 첫 봉 "끝"에 걸거나 이월 방향을 미래 쪽으로 한 줄만 바꿔도 성적이 달라지는데
// 컴파일도 되고 화면도 뜬다. 그래서 여기서 두 구현을 **같은 합성 곡선으로 나란히 돌려**
// 결합 곡선이 전부 일치하는지 본다. 갈라지면 이 파일이 깨진다.
//
// 검증 항목
//   1) 동형 — src `blendCurves` ≡ idea-lab `blendCurves` (wA ∈ {0.25, 0.5, 0.75} · 정렬/결측/구간
//      어긋남 케이스 전부, 부동소수점 비트까지 완전 일치)
//   2) 절단 불변성 — 입력 곡선 뒷부분을 잘라내도 잘린 시점 이전의 결합 곡선이 완전히 동일
//      (미래를 보지 않는다는 뜻. 한 점이라도 달라지면 어딘가에서 뒤를 봤다)
//   3) 경계 가중 — wA=1이면 A 곡선을, wA=0이면 B 곡선을 그대로 재현한다(시작 1.0 정규화)
//   4) 월 경계 리밸런스 산술 — 알려진 두 곡선으로 손계산 대조. 달 안에서는 표류하고
//      달이 바뀌는 첫 거래일에만 가중이 되돌려진다(= 단순 보유와 값이 달라야 한다)
//   5) 화면 어댑터(`blendChainResults`) — 연도별 분해의 곱이 전체 배수와 일치하고,
//      매매 원장은 **비어 있다**(귀속 불가라는 뜻이며 "0건"이 아니다 — 화면이 안내를 띄운다)
//
// 네트워크를 타지 않는다. 합성 곡선만 쓴다.

import { check, close, eq, finish, rng, section } from './harness'
import {
  alignCurves,
  blendChainResults,
  blendCurves,
  blendMonthlyRebalanced,
  ymOf,
} from '../src/features/backtest/comboBlend'
import { blendCurves as refBlendCurves, blendMonthlyRebalanced as refBlendMonthly } from '../scripts/idea-lab.entry'
import type { PitChainResult } from '../src/features/backtest/pitChain'
import type { EquityPoint } from '../src/features/backtest/types'

type Curve = { date: string; equity: number }[]

/** 주말을 건너뛴 거래일 근사 날짜 목록 */
function tradingDates(from: string, to: string): string[] {
  const out: string[] = []
  const start = Date.parse(`${from}T00:00:00Z`)
  const end = Date.parse(`${to}T00:00:00Z`)
  for (let t = start; t <= end; t += 86400000) {
    const d = new Date(t)
    const dow = d.getUTCDay()
    if (dow === 0 || dow === 6) continue
    out.push(d.toISOString().slice(0, 10))
  }
  return out
}

/** 합성 자산곡선 — 드리프트 + 결정적 잡음. `skipEvery`면 그 주기의 날을 통째로 빼 결측일을 만든다. */
function makeCurve(opts: {
  from: string
  to: string
  drift: number
  seed: number
  noise?: number
  base?: number
  skipEvery?: number
}): Curve {
  const rnd = rng(opts.seed)
  const noise = opts.noise ?? 0
  const out: Curve = []
  let v = opts.base ?? 1
  let i = 0
  for (const date of tradingDates(opts.from, opts.to)) {
    i++
    v *= 1 + opts.drift + (rnd() - 0.5) * noise
    if (opts.skipEvery && i % opts.skipEvery === 0) continue // 결측일 — 직전 값 이월 경로를 태운다
    out.push({ date, equity: v })
  }
  return out
}

const WEIGHTS = [0.25, 0.5, 0.75]

// ---------------------------------------------------------------------------
section('1) 동형 — src blendCurves ≡ idea-lab blendCurves (정본과 갈라지지 않는다)')
// ---------------------------------------------------------------------------

const CASES: { name: string; a: Curve; b: Curve }[] = [
  {
    name: '같은 구간·잡음 있는 두 곡선',
    a: makeCurve({ from: '2018-01-01', to: '2020-06-30', drift: 0.0006, seed: 11, noise: 0.03 }),
    b: makeCurve({ from: '2018-01-01', to: '2020-06-30', drift: -0.0002, seed: 29, noise: 0.05 }),
  },
  {
    name: '구간이 어긋난 두 곡선(겹치는 구간만 남아야 한다)',
    a: makeCurve({ from: '2017-03-15', to: '2020-02-10', drift: 0.0008, seed: 41, noise: 0.02 }),
    b: makeCurve({ from: '2018-06-01', to: '2021-01-20', drift: 0.0003, seed: 53, noise: 0.04 }),
  },
  {
    name: '한쪽에 결측일이 많은 곡선(과거 방향 이월 경로)',
    a: makeCurve({ from: '2019-01-01', to: '2021-12-31', drift: 0.0004, seed: 67, noise: 0.03, skipEvery: 3 }),
    b: makeCurve({ from: '2019-01-01', to: '2021-12-31', drift: 0.0005, seed: 71, noise: 0.03, skipEvery: 7 }),
  },
  {
    name: '한 달치 짧은 곡선(리밸런스가 한 번도 안 일어나는 구간)',
    a: makeCurve({ from: '2020-03-02', to: '2020-03-27', drift: -0.002, seed: 83, noise: 0.06 }),
    b: makeCurve({ from: '2020-03-02', to: '2020-03-27', drift: 0.003, seed: 97, noise: 0.06 }),
  },
]

for (const c of CASES) {
  for (const wA of WEIGHTS) {
    const mine = blendCurves(c.a, c.b, wA)
    const ref = refBlendCurves(c.a, c.b, wA)
    eq(`[${c.name}] wA=${wA} 길이 일치`, mine.length, ref.length)
    let diff = -1
    for (let i = 0; i < Math.min(mine.length, ref.length); i++) {
      if (mine[i].date !== ref[i].date || !Object.is(mine[i].equity, ref[i].equity)) {
        diff = i
        break
      }
    }
    check(
      `[${c.name}] wA=${wA} 전 구간 완전 일치 (${mine.length}점)`,
      diff < 0,
      diff >= 0 ? `${diff}번째: ${mine[diff]?.date} ${mine[diff]?.equity} vs ${ref[diff]?.date} ${ref[diff]?.equity}` : '',
    )
  }
}

// 하위 함수도 직접 대조한다 — blendCurves만 맞고 내부가 갈라지는 경우를 막는다
{
  const { dates, ea, eb } = alignCurves(CASES[0].a, CASES[0].b)
  const mine = blendMonthlyRebalanced(dates, ea, eb, 0.5)
  const ref = refBlendMonthly(dates, ea, eb, 0.5)
  check(
    'blendMonthlyRebalanced 자체가 정본과 완전 일치',
    mine.length === ref.length && mine.every((v, i) => Object.is(v, ref[i])),
    `${mine.length} vs ${ref.length}`,
  )
  eq('ymOf 정의 일치', ymOf('2021-07-15'), '2021-07')
}

// ---------------------------------------------------------------------------
section('2) 절단 불변성 — 뒤를 잘라도 앞이 안 변한다 (규칙 1 집행)')
// ---------------------------------------------------------------------------

for (const c of CASES.slice(0, 3)) {
  for (const wA of WEIGHTS) {
    const full = blendCurves(c.a, c.b, wA)
    if (full.length < 40) continue
    // 자를 지점 — 달 중간(월 경계 직전/직후 모두 태우려고 두 지점을 쓴다)
    for (const frac of [0.4, 0.75]) {
      const cutDate = full[Math.floor(full.length * frac)].date
      const cut = blendCurves(
        c.a.filter((p) => p.date <= cutDate),
        c.b.filter((p) => p.date <= cutDate),
        wA,
      )
      const n = cut.length
      check(`[${c.name}] wA=${wA} ${cutDate} 절단본이 비지 않는다`, n > 0, `${n}점`)
      let diff = -1
      for (let i = 0; i < n; i++) {
        if (full[i].date !== cut[i].date || !Object.is(full[i].equity, cut[i].equity)) {
          diff = i
          break
        }
      }
      check(
        `[${c.name}] wA=${wA} ${cutDate}까지 결합 곡선 불변 (${n}점)`,
        diff < 0,
        diff >= 0 ? `${diff}번째 ${full[diff]?.date}: ${full[diff]?.equity} vs ${cut[diff]?.equity}` : '',
      )
    }
  }
}

// ---------------------------------------------------------------------------
section('3) 경계 가중 — wA=1은 A, wA=0은 B를 그대로 재현한다')
// ---------------------------------------------------------------------------

{
  const a = CASES[0].a
  const b = CASES[0].b
  const onlyA = blendCurves(a, b, 1)
  const onlyB = blendCurves(a, b, 0)
  const { dates, ea, eb } = alignCurves(a, b)
  eq('정렬 길이 = 결합 길이', onlyA.length, dates.length)

  let worstA = 0
  let worstB = 0
  for (let i = 0; i < dates.length; i++) {
    worstA = Math.max(worstA, Math.abs(onlyA[i].equity - ea[i] / ea[0]))
    worstB = Math.max(worstB, Math.abs(onlyB[i].equity - eb[i] / eb[0]))
  }
  close('wA=1이면 A 곡선(시작 1.0 정규화)과 일치', worstA, 0, 1e-12)
  close('wA=0이면 B 곡선(시작 1.0 정규화)과 일치', worstB, 0, 1e-12)

  // 중간 가중은 두 경계 사이에 있어야 한다(같은 구간 총배수 기준)
  const last = (c: { equity: number }[]) => c[c.length - 1].equity
  const half = last(blendCurves(a, b, 0.5))
  const lo = Math.min(last(onlyA), last(onlyB))
  const hi = Math.max(last(onlyA), last(onlyB))
  check('50:50 총배수가 두 단독 사이에 놓인다', half > lo && half < hi, `${lo} < ${half} < ${hi}`)
}

// ---------------------------------------------------------------------------
section('4) 월 경계 리밸런스 산술 — 손계산 대조')
// ---------------------------------------------------------------------------

{
  // A는 1월 둘째 날에 2배, B는 2월 둘째 날에 2배. 달 경계는 1월→2월 한 번뿐이다.
  const dates = ['2020-01-02', '2020-01-03', '2020-02-03', '2020-02-04']
  const ea = [1, 2, 2, 2]
  const eb = [1, 1, 1, 2]

  //  i=0  vA=0.5 vB=0.5                          → 1.0
  //  i=1  같은 달 · A 2배                        → vA=1.0 vB=0.5 → 1.5
  //  i=2  달 바뀜 → v=1.5를 0.75/0.75로 되돌림   → 1.5
  //  i=3  같은 달 · B 2배                        → vA=0.75 vB=1.5 → 2.25
  const v = blendMonthlyRebalanced(dates, ea, eb, 0.5)
  eq('길이', v.length, 4)
  close('t0 = 1.0', v[0], 1, 1e-12)
  close('t1 = 1.5 (달 안에서는 표류만)', v[1], 1.5, 1e-12)
  close('t2 = 1.5 (월 첫 거래일 리밸런스는 총자산을 바꾸지 않는다)', v[2], 1.5, 1e-12)
  close('t3 = 2.25 (되돌린 가중으로 B가 2배)', v[3], 2.25, 1e-12)

  // 리밸런스가 실제로 일어났다는 증거 — 단순 보유(리밸런스 없음)면 0.5·2 + 0.5·2 = 2.0이다
  check('월 리밸런스 결과(2.25)가 단순 보유(2.0)와 다르다', Math.abs(v[3] - 2) > 1e-9, `${v[3]}`)

  // 경계 가중은 각 곡선 그대로
  const only = blendMonthlyRebalanced(dates, ea, eb, 1)
  const none = blendMonthlyRebalanced(dates, ea, eb, 0)
  close('wA=1 마지막 = A 총배수 2.0', only[3], 2, 1e-12)
  close('wA=0 마지막 = B 총배수 2.0', none[3], 2, 1e-12)

  // 25:75 손계산 — vA=0.25 vB=0.75 → t1: 0.5+0.75=1.25 → t2 리밸런스 0.3125/0.9375
  //                                  → t3: 0.3125 + 1.875 = 2.1875
  const q = blendMonthlyRebalanced(dates, ea, eb, 0.25)
  close('wA=0.25 마지막 = 2.1875', q[3], 2.1875, 1e-12)

  // blendCurves = alignCurves + blendMonthlyRebalanced
  const cA: Curve = dates.map((date, i) => ({ date, equity: ea[i] }))
  const cB: Curve = dates.map((date, i) => ({ date, equity: eb[i] }))
  const blended = blendCurves(cA, cB, 0.5)
  eq('blendCurves 길이', blended.length, 4)
  close('blendCurves 마지막 값이 손계산과 일치', blended[3].equity, 2.25, 1e-12)
  eq('blendCurves 날짜가 정렬 날짜와 같다', blended[3].date, '2020-02-04')
}

// ---------------------------------------------------------------------------
section('5) 화면 어댑터 blendChainResults — 지표 재계산과 원장 공백')
// ---------------------------------------------------------------------------

{
  const CAP = 10_000_000
  /** 배수 곡선 → PitChainResult 껍데기 (어댑터가 읽는 필드만 채운다) */
  function fakeChain(curve: Curve, benchMul: number[], trades: number[]): PitChainResult {
    const equity: EquityPoint[] = curve.map((p, i) => ({
      date: p.date,
      equity: p.equity * CAP,
      benchmark: benchMul[i] * CAP,
      drawdownPct: 0,
    }))
    const years = [...new Set(curve.map((p) => p.date.slice(0, 4)))].map(Number).sort()
    return {
      equity,
      trades: [],
      perYear: years.map((year, i) => ({
        year,
        mapped: 18,
        total: 20,
        cash: false,
        strategyPct: 0,
        benchPct: 0,
        trades: trades[i] ?? 0,
        symbols: ['005930.KS'],
      })),
      startDate: curve[0].date,
      endDate: curve[curve.length - 1].date,
      years: 1,
      totalPct: 0,
      cagrPct: 0,
      mddPct: 0,
      objective: null,
      benchTotalPct: (benchMul[benchMul.length - 1] - 1) * 100,
      benchCagrPct: 0,
      alphaCagrPct: 0,
      alphaTotalPct: 0,
      tradeCount: 7,
      winRate: 55,
      avgPnlPct: 1.2,
      openAtEnd: 2,
      exitBreakdown: [],
      lastScreen: [],
      lastScreenDate: curve[curve.length - 1].date,
      mappedAvgPct: 90,
    }
  }

  const dates = tradingDates('2019-11-01', '2021-02-26')
  const rndA = rng(1234)
  const rndB = rng(5678)
  let va = 1
  let vb = 1
  const ca: Curve = []
  const cb: Curve = []
  const benchMul: number[] = []
  let vbench = 1
  for (const date of dates) {
    va *= 1 + 0.0006 + (rndA() - 0.5) * 0.04
    vb *= 1 + 0.0002 + (rndB() - 0.5) * 0.06
    vbench *= 1 + 0.0003
    ca.push({ date, equity: va })
    cb.push({ date, equity: vb })
    benchMul.push(vbench)
  }
  const A = fakeChain(ca, benchMul, [10, 40, 6])
  const B = fakeChain(cb, benchMul, [3, 12, 2])
  const out = blendChainResults(A, B, 0.5, CAP)

  const raw = blendCurves(A.equity, B.equity, 0.5)
  eq('결합 곡선 길이가 blendCurves와 같다', out.equity.length, raw.length)
  close('마지막 자산 = 배수 × 초기자본', out.equity[out.equity.length - 1].equity, raw[raw.length - 1].equity * CAP, 1e-6)
  close('총수익%가 배수와 일치', out.totalPct, (raw[raw.length - 1].equity - 1) * 100, 1e-9)

  // 연도별 분해의 곱 = 전체 배수 (연쇄 규약과 같은 분해여야 한다)
  const prod = out.perYear.reduce((s, r) => s * (1 + r.strategyPct / 100), 1)
  close('연도별 수익률의 곱 = 전체 배수', prod, 1 + out.totalPct / 100, 1e-9)
  eq('연도 수', out.perYear.length, 3)
  eq('연도별 매매수 = 두 슬리브 합', out.perYear[1].trades, 52)

  // MDD는 결합 곡선에서 다시 잰다 — 0 이하이고, 두 단독보다 얕거나 같아야 정상 범위다
  check('MDD ≤ 0', out.mddPct <= 0, `${out.mddPct}`)
  const mddOf = (c: Curve) => {
    let peak = 0
    let m = 0
    for (const p of c) {
      peak = Math.max(peak, p.equity)
      m = Math.min(m, (p.equity / peak - 1) * 100)
    }
    return m
  }
  const worstSolo = Math.min(mddOf(blendCurves(A.equity, B.equity, 1)), mddOf(blendCurves(A.equity, B.equity, 0)))
  check('결합 MDD가 더 깊었던 단독보다 얕다', out.mddPct >= worstSolo - 1e-9, `${out.mddPct} vs ${worstSolo}`)

  // 매매 원장은 비어 있다 — "0건"이 아니라 **귀속 불가**라는 뜻이다(화면이 안내를 띄운다)
  eq('결합에는 매매 원장이 없다', out.trades.length, 0)
  eq('tradeCount = 0 (귀속 불가)', out.tradeCount, 0)
  eq('winRate = null (귀속 불가)', out.winRate, null)
  eq('avgPnlPct = null (귀속 불가)', out.avgPnlPct, null)

  // 벤치는 결합 구간 양끝으로 다시 잰다 → 알파가 같은 구간 비교가 된다
  check('벤치 총수익이 계산된다', out.benchTotalPct != null, `${out.benchTotalPct}`)
  close(
    '알파(총) = 전략 총수익 − 벤치 총수익',
    out.alphaTotalPct!,
    out.totalPct - out.benchTotalPct!,
    1e-9,
  )
  close('알파(연) = CAGR − 벤치 CAGR', out.alphaCagrPct!, out.cagrPct - out.benchCagrPct!, 1e-9)

  // 벤치 부재(양쪽 다 null)면 알파도 null이어야 한다 — 없는 비교를 만들어내지 않는다
  const noBench = blendChainResults(
    { ...A, benchTotalPct: null },
    { ...B, benchTotalPct: null },
    0.5,
    CAP,
  )
  eq('벤치 없으면 benchTotalPct = null', noBench.benchTotalPct, null)
  eq('벤치 없으면 alphaCagrPct = null', noBench.alphaCagrPct, null)

  // 어댑터도 절단 불변이어야 한다(곡선이 아니라 결과 객체 경로로도 확인)
  const cutDate = dates[Math.floor(dates.length * 0.6)]
  const cutOut = blendChainResults(
    { ...A, equity: A.equity.filter((p) => p.date <= cutDate) },
    { ...B, equity: B.equity.filter((p) => p.date <= cutDate) },
    0.5,
    CAP,
  )
  let diff = -1
  for (let i = 0; i < cutOut.equity.length; i++) {
    if (
      cutOut.equity[i].date !== out.equity[i].date ||
      !Object.is(cutOut.equity[i].equity, out.equity[i].equity) ||
      !Object.is(cutOut.equity[i].drawdownPct, out.equity[i].drawdownPct)
    ) {
      diff = i
      break
    }
  }
  check(
    `어댑터 절단 불변성 (${cutDate}까지 ${cutOut.equity.length}점)`,
    diff < 0,
    diff >= 0 ? `${diff}번째 ${out.equity[diff]?.date}` : '',
  )
}

finish()
