// 시장 레짐 게이트(12-1) · 달러자산 원화 환산 · 곡선→연쇄결과 어댑터.
//
// 32차 실측(2026-08-03, `scripts/idea-lab.entry.ts` MODE=asset)에서 칼마 1위였던
// **결합 50:50 + B슬리브 시장게이트(12-1) + 금 20%**를 화면에서 실행 가능한 형태로 옮긴 것이다.
//
// ── 의미론 정본 ───────────────────────────────────────────────────────────────
// `scripts/idea-lab.entry.ts`의 아래 함수들이 정본이고, 여기 있는 같은 이름의 함수들은
// 그것을 **그대로 이식한 사본**이다:
//   · `spliceRegimeCurve`  — 벤치 시작 이전 구간을 코스피 종합(^KS11) 수익률로 잇기
//   · `regimeMom12_1`      — 레짐 곡선의 12-1 모멘텀
//   · `makeRegimeExposure(curve, 'mom12_1')` → 여기서는 `makeMonthGateMask` / `makeMarketGateExposure`
//   · `toKrwCurve`         — 달러 곡선 × 원/달러(결측일 직전 환율 이월)
//   · `valueBefore` / `curveIdxBefore`
// 옮겨 적기는 조용히 갈라지므로 `tests/marketgate.test.ts`의 **동형 테스트**가 두 구현을
// 같은 합성 데이터로 나란히 돌려 완전 일치를 강제한다. 고칠 일이 생기면 정본을 먼저 고쳐라.
//
// ── 게이트를 **어디에** 거는가 (2026-08-03 총괄 판정) ─────────────────────────
// 게이트는 **모멘텀 시뮬 안**에서 건다. `makeMarketGateExposure`가 만든 노출 함수를
// `runXsmomChained`의 `exposure` 훅(= idea-lab `simulateRankYear`의 동명 옵션을 이식한 것)에
// 넘기면, 게이트가 닫힌 달은 **첫 거래일 시가에 보유 종목을 전량 매도**하고(수수료·거래세·
// 슬리피지를 물고) 풀리는 달에 다시 산다(매수 비용도 문다). 정본과 **같은 산술**이다.
//
// ⚠️ 한때 여기 있던 "B 곡선의 그 달 수익률을 0으로 만드는" 커브 마스크는 **폐기했다.**
//    의미는 비슷해 보여도 청산·재매수 비용과 게이트 달 첫날 갭이 빠져 성적이 **낙관 쪽으로**
//    치우쳤고, 사전계산 라벨이 화면 엔진 수치를 그대로 싣는 구조라 그 낙관이 그대로 대표에게
//    노출된다(규칙 3 위반). 다시 만들지 마라 — 노출 훅이 정본이다.
//
// ── 규칙 1(미래참조 금지) 설계 ────────────────────────────────────────────────
//   · 게이트 판정 창은 **달(ym)만으로** 결정된다: 그 달 1일 기준 12-1 모멘텀이므로
//     기준 종가 두 개(12개월 전 달 1일 **직전** · 1개월 전 달 1일 **직전**)가 모두
//     판정 달보다 과거다. 달 안 어느 거래일에 물어도 같은 값이 나온다.
//   · 판정 불가(레짐 데이터 부족)면 **게이트 열림(1)**이다 — 사후지식 없이 기본값을 쓰는
//     원칙이며, 초기 구간을 임의로 현금화해 성적을 만들지 않기 위해서다.
//   · 환율 결측일은 **직전 환율 이월**이다. 다음 환율을 당겨오면 그 자체가 미래참조다.
//   · 집행자는 `tests/marketgate.test.ts`의 절단 불변성 케이스다.
//
// 이 모듈은 **순수 함수**다 — 네트워크·localStorage·DOM에 접근하지 않는다.

import { blendChainResults, valueAsOf, ymOf } from './comboBlend'
import { annualize, yearsBetween, type PitChainResult } from './pitChain'
import { shiftMonthStart } from './xsmomChain'
import type { DailyBar, EquityPoint } from './types'

/** 곡선 점 — 이 모듈이 다루는 최소 단위(자산곡선·지수·환율 모두 같은 모양) */
export type Curve = { date: string; equity: number }[]

// ---------------------------------------------------------------------------
// 곡선 유틸 (정본 이식)
// ---------------------------------------------------------------------------

/** 곡선에서 `date` **미만**(strictly before)인 점의 개수 = 그 시점 확정 구간의 오른쪽 경계. */
export function curveIdxBefore(curve: Curve, date: string): number {
  let lo = 0
  let hi = curve.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (curve[mid].date < date) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** 곡선에서 `date` **미만** 마지막 값. 없으면 null. (`valueAsOf`는 이하 — 여기선 미만이 필요하다) */
export function valueBefore(curve: Curve, date: string): number | null {
  const n = curveIdxBefore(curve, date)
  return n > 0 ? curve[n - 1].equity : null
}

// ---------------------------------------------------------------------------
// 레짐 시계열 — 벤치 + 폴백 지수 잇기
// ---------------------------------------------------------------------------

/**
 * 벤치 시작 이전 구간을 폴백 지수로 메운 **연속** 레짐 시계열.
 * 두 지수의 레벨을 그냥 이어 붙이면 이음매에서 가짜 급등락이 생기므로, 앞 구간은
 * 폴백의 **수익률만** 쓰고 이음매 값을 벤치 첫 값에 맞춘다(이음매 하루 수익 = 0).
 * 폴백이 없거나 짧으면 벤치만 그대로 돌려준다.
 *
 * ⚠️ 폴백(^KS11)은 가격지수라 배당이 빠져 있다 — 레짐 **방향** 판정에만 쓰고
 *    수익 계산에는 쓰지 않는다(알파 판정 벤치는 규칙 5대로 KODEX 200 그대로다).
 */
export function spliceRegimeCurve(primary: DailyBar[], fallback: DailyBar[]): Curve {
  const p = primary.filter((b) => b.c > 0)
  const f = fallback.filter((b) => b.c > 0)
  if (p.length < 2) return f.map((b) => ({ date: b.date, equity: b.c }))
  if (f.length < 1) return p.map((b) => ({ date: b.date, equity: b.c }))
  const cut = p[0].date
  const head = f.filter((b) => b.date < cut)
  if (head.length < 2) return p.map((b) => ({ date: b.date, equity: b.c }))
  const scale = p[0].c / head[head.length - 1].c
  const out: Curve = head.map((b) => ({ date: b.date, equity: b.c * scale }))
  for (const b of p) out.push({ date: b.date, equity: b.c })
  return out
}

/**
 * 레짐 곡선의 12-1 모멘텀. `momentum12_1`과 **같은 창**이다(시작 = 12개월 전 달 1일 직전,
 * 끝 = 1개월 전 달 1일 직전). 두 기준일이 모두 `date`보다 과거라 미래참조가 불가능하다.
 */
export function regimeMom12_1(curve: Curve, date: string): number | null {
  const pe = valueBefore(curve, shiftMonthStart(date, -1))
  const ps = valueBefore(curve, shiftMonthStart(date, -12))
  if (pe == null || ps == null || !(ps > 0)) return null
  return pe / ps - 1
}

/**
 * 월별 게이트 마스크 — 위험선호 1 / 위험회피 0.
 * idea-lab `makeRegimeExposure(curve, 'mom12_1')`의 이식본이다.
 *
 * **판정 불가(데이터 부족)면 1**이다(위 규칙 1 주석 참조).
 * 값이 `ym`만으로 결정되므로 달 안 어느 날짜로 물어도 같다 — 메모이제이션도 그래서 안전하다.
 */
export function makeMonthGateMask(curve: Curve): (date: string) => 0 | 1 {
  const memo = new Map<string, 0 | 1>()
  return (date: string) => {
    const ym = ymOf(date)
    const hit = memo.get(ym)
    if (hit != null) return hit
    const m = regimeMom12_1(curve, `${ym}-01`)
    const w: 0 | 1 = m != null && m < 0 ? 0 : 1
    memo.set(ym, w)
    return w
  }
}

/**
 * `runXsmomChained`의 `exposure` 훅에 그대로 넘길 수 있는 노출 함수.
 * 시장게이트는 0/1 두 값뿐이라 마스크와 같은 함수지만, **넘기는 자리가 노출 훅**이라는
 * 사실을 호출부에서 읽히게 하려고 이름을 따로 둔다.
 */
export function makeMarketGateExposure(curve: Curve): (date: string) => number {
  return makeMonthGateMask(curve)
}

export interface GateSummary {
  /** 게이트가 현금으로 돌린 달 목록(`YYYY-MM` 오름차순) */
  gatedMonths: string[]
  /** 대상 구간이 덮은 전체 달 수 — 배지에서 "몇 달 중 몇 달"을 보이려는 것 */
  totalMonths: number
}

/**
 * 화면 배지용 집계 — 실행 구간의 날짜들에 마스크를 물어 **실제로 닫힌 달**을 센다.
 * 성적 계산에는 관여하지 않는다(성적은 노출 훅을 받은 시뮬이 만든다).
 */
export function summarizeGate(dates: string[], gateOf: (date: string) => number): GateSummary {
  const months = new Set<string>()
  const gated = new Set<string>()
  for (const d of dates) {
    const ym = ymOf(d)
    months.add(ym)
    if (gateOf(d) <= 0) gated.add(ym)
  }
  return { gatedMonths: [...gated].sort(), totalMonths: months.size }
}

// ---------------------------------------------------------------------------
// 달러 자산 → 원화 곡선
// ---------------------------------------------------------------------------

/**
 * 달러 곡선(총수익 보정 봉) × 환율 = 원화 곡선. 환율이 아직 없는 앞 구간은 **버린다**
 * (임의로 채우면 그 구간 비교가 거짓이 된다). 결측일은 `date` **이하** 마지막 환율을
 * 이월한다 — 다음 환율을 당겨오면 미래참조다(규칙 1).
 *
 * ⚠️ 환헤지 없음 가정이다. 원화 곡선에는 자산 수익과 원/달러 변동이 **섞여 있다**.
 */
export function toKrwCurve(usd: DailyBar[], fx: DailyBar[]): Curve {
  const fxCurve: Curve = fx.filter((b) => b.c > 0).map((b) => ({ date: b.date, equity: b.c }))
  const out: Curve = []
  for (const b of usd) {
    if (!(b.c > 0)) continue
    const rate = valueAsOf(fxCurve, b.date) // 그 날짜 이하 마지막 환율 = 직전 이월
    if (rate == null || !(rate > 0)) continue
    out.push({ date: b.date, equity: b.c * rate })
  }
  return out
}

// ---------------------------------------------------------------------------
// 곡선 → `PitChainResult` 어댑터
// ---------------------------------------------------------------------------

/** 곡선에서 최대 낙폭(%)과 점별 낙폭을 잰다. */
function drawdowns(curve: Curve): { mddPct: number; ddOf: number[] } {
  let peak = 0
  let mdd = 0
  const ddOf: number[] = []
  for (const p of curve) {
    peak = Math.max(peak, p.equity)
    const dd = peak > 0 ? (p.equity / peak - 1) * 100 : 0
    mdd = Math.min(mdd, dd)
    ddOf.push(dd)
  }
  return { mddPct: mdd, ddOf }
}

/**
 * 배수 곡선을 **결과 화면이 그대로 읽는** `PitChainResult`로 감싼다.
 *
 * ⚠️ **매매 원장은 비운다**(`trades: []` · `tradeCount: 0` · `winRate: null`) —
 *    합성된 보유 곡선에 귀속되는 체결이 없기 때문이며 "매매가 0건"이라는 뜻이 아니다.
 *    `blendChainResults`와 같은 규약이다.
 *
 * `benchTotalPct`는 **`blendChainResults`의 `hasBench` 검사를 통과시키기 위한 통로**다 —
 * 결합 시 실제 벤치 시계열은 슬리브 A의 곡선에 실린 값에서 온다(이 껍데기의 값이 아니다).
 * 넘기지 않으면 벤치·알파는 null이 된다(없는 비교를 만들어내지 않는다).
 */
export function curveAsChain(
  curve: Curve,
  opts: { capital: number; benchTotalPct?: number | null; benchCagrPct?: number | null },
): PitChainResult {
  const capital = opts.capital
  const base = curve.length && curve[0].equity > 0 ? curve[0].equity : 1
  const mult = curve.map((p) => ({ date: p.date, equity: p.equity / base }))
  const { mddPct, ddOf } = drawdowns(mult)
  const equity: EquityPoint[] = mult.map((p, i) => ({
    date: p.date,
    equity: p.equity * capital,
    // 벤치 자리는 자기 자신으로 채운다 — 결합에서는 슬리브 A의 벤치만 쓰이고,
    // 단독 표시에서는 "비교 대상 없음"이 곡선이 겹쳐 보이는 것보다 낫다.
    benchmark: p.equity * capital,
    drawdownPct: ddOf[i],
  }))
  const startDate = mult.length ? mult[0].date : ''
  const endDate = mult.length ? mult[mult.length - 1].date : ''
  const span = mult.length ? yearsBetween(startDate, endDate) : 1
  const factor = mult.length ? mult[mult.length - 1].equity : 1
  const totalPct = (factor - 1) * 100
  const cagrPct = annualize(factor, span)
  const mddAbs = Math.abs(mddPct)
  const benchTotalPct = opts.benchTotalPct ?? null
  const benchCagrPct = benchTotalPct != null ? (opts.benchCagrPct ?? null) : null
  return {
    equity,
    trades: [],
    perYear: [],
    startDate,
    endDate,
    years: span,
    totalPct,
    cagrPct,
    mddPct,
    objective: mddAbs > 0.01 ? totalPct / mddAbs : null,
    benchTotalPct,
    benchCagrPct,
    alphaCagrPct: benchCagrPct != null ? cagrPct - benchCagrPct : null,
    alphaTotalPct: benchTotalPct != null ? totalPct - benchTotalPct : null,
    // 0건이 아니라 **귀속 불가**라는 뜻이다(화면이 안내를 띄운다)
    tradeCount: 0,
    winRate: null,
    avgPnlPct: null,
    openAtEnd: 0,
    exitBreakdown: [],
    lastScreen: [],
    lastScreenDate: '',
    mappedAvgPct: null,
  }
}

// ---------------------------------------------------------------------------
// 결합 합성 — 화면과 사전계산이 **같은 함수**를 부른다
// ---------------------------------------------------------------------------

export interface ComboInput {
  /** 슬리브 A(조건식) 연쇄 결과 */
  chainA: PitChainResult
  /**
   * 슬리브 B(모멘텀) 연쇄 결과.
   * ⚠️ 시장게이트는 **이 곡선을 만들 때 이미** 반영돼 있어야 한다(`runXsmomChained`의
   *    `exposure` 훅). 여기서 곡선을 다시 손대지 않는다 — 그렇게 하면 청산 비용이 빠진다.
   */
  chainB: PitChainResult
  /** A:B 가중 */
  wA: number
  capital: number
  /** 금(원화) 곡선. null이거나 `goldW`가 0이면 금 슬리브 없음 = 기존 결합 그대로 */
  gold?: Curve | null
  goldW?: number
}

export interface ComboOutput {
  /** 화면·사전계산이 그대로 읽는 최종 결과 */
  result: PitChainResult
  /** 금 슬리브가 실제로 섞인 구간의 시작일 — 없으면 null */
  goldFrom: string | null
  /** 실제로 적용된 금 비중(데이터가 없으면 0으로 내려간다 — 숨기지 않는다) */
  goldWApplied: number
}

/**
 * 결합(A:B) + 금 슬리브를 **2단 blend**로 합성한다.
 *
 * 왜 2단인가 — 그게 **정본이 하는 것**이기 때문이다. idea-lab MODE=asset의 32차 1위 행은
 *   `E1 = blendCurves(chainA, gateChain, 0.5)` → `blendCurves(E1, GLD, 0.8)`
 * 두 줄이고(여기서 `gateChain`은 **노출 훅을 받은 모멘텀 연쇄**다), 이 함수는 그 두 줄과
 * **같은 곡선**을 낸다(`tests/marketgate.test.ts` §5).
 *
 * 3자 동시 결합(`comboBlend.blend3Curves`)과의 관계: `blendMonthlyRebalanced`가 같은 월
 * 경계에서 리밸런스하므로 두 방식은 **첫 달 경계 이후로는 같은 곡선**이다. 다만 결합 구간이
 * 시작되는 **첫 부분월**에서는 갈린다 — 3자 동시 결합은 구간 시작일에 세 슬리브를 목표
 * 가중으로 세우지만, 2단에서는 안쪽 곡선(A:B)이 그 달 1일에 이미 리밸런스를 마치고 표류한
 * 상태이기 때문이다. 테스트가 이 차이를 뭉개지 않고 **양쪽 다** 확인한다.
 *
 * 구간: 금 슬리브가 붙는 순간 결합 구간은 **금 곡선이 시작한 뒤**로 잘린다(GLD면 2004-11~).
 * 겹치지 않는 구간을 남기면 그 구간이 통째로 한쪽 곡선의 성적이 되기 때문이다.
 * 호출부는 `goldFrom`을 화면에 그대로 드러내야 한다(규칙 3).
 */
export function composeCombo(input: ComboInput): ComboOutput {
  const { chainA, chainB, wA, capital } = input
  const combo = blendChainResults(chainA, chainB, wA, capital)

  const goldW = input.goldW ?? 0
  const gold = input.gold ?? null
  if (!(goldW > 0) || !gold || gold.length < 2) {
    return { result: combo, goldFrom: null, goldWApplied: 0 }
  }

  // 금 껍데기의 `benchTotalPct`는 `blendChainResults`의 벤치 유무 검사를 통과시키는 통로일 뿐이다 —
  // 실제 벤치 시계열은 `combo`(= 슬리브 A 계보) 곡선에 실린 값에서 온다.
  const goldChain = curveAsChain(gold, {
    capital,
    benchTotalPct: combo.benchTotalPct,
    benchCagrPct: combo.benchCagrPct,
  })
  const result = blendChainResults(combo, goldChain, 1 - goldW, capital)
  return {
    result,
    goldFrom: result.equity.length ? result.equity[0].date : null,
    goldWApplied: goldW,
  }
}
