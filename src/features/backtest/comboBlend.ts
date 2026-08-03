// 두 전략 슬리브(곡선)의 **월 리밸런스 결합** — 26차 실측(MODE=combo)의 의미론을 화면으로 옮긴 것.
//
// ⚠️ **정본: `scripts/idea-lab.entry.ts`** (`valueAsOf` / `alignCurves` /
//    `blendMonthlyRebalanced` / `blendCurves`). 여기 있는 같은 이름의 함수들은 그 정본을
//    **그대로 이식**한 사본이며, 의미가 조용히 갈라지는 것을 막기 위해
//    `tests/comboblend.test.ts`의 **동형(isomorphism) 테스트**가 두 구현을 같은 입력으로
//    나란히 돌려 완전 일치를 강제한다. 이 파일을 고칠 일이 생기면 정본을 먼저 고치고
//    동형 테스트를 통과시켜라 — 한쪽만 고치면 테스트가 깨진다.
//
// 결합의 의미: 두 슬리브를 **각각 전액 투자 기준**으로 돌린 곡선을 받아, 월 첫 거래일
// **시작 시점**에 총자산을 `wA : 1−wA`로 되돌리고 달 안에서는 각자 표류시킨다.
//
// ── 규칙 1(미래참조 금지) ────────────────────────────────────────────────────
//   · 가중을 되돌릴지 판단하는 데 쓰는 정보는 **날짜뿐**이다. 수익률을 보고 가중을 고르지
//     않으므로 미래참조가 들어갈 자리가 구조적으로 없다.
//   · 정렬 시 결측일 이월은 `valueAsOf`가 **과거 방향으로만** 탐색한다. 다음 값을 당겨오면
//     그 자체가 미래참조다.
//   · 집행자는 `tests/comboblend.test.ts`의 절단 불변성 케이스다 — 입력 곡선 뒷부분을
//     잘라내도 잘린 시점 이전의 결합 곡선이 완전히 동일해야 한다.
//
// ── 한계(정직하게 남긴다 · 규칙 3·4) ─────────────────────────────────────────
//   · **리밸런스 비용 미반영** — 슬리브 간 이체를 0원으로 본 낙관적 상한이다. 실제로는
//     매월 두 슬리브의 편차만큼 사고팔아야 하고 그만큼 성적이 깎인다.
//   · 결합 곡선에는 **매매 원장이 없다**. 합성된 곡선이라 체결이 어느 슬리브에 귀속되지
//     않는다 — 매매수·승률은 A·B를 각각 단독 실행해 읽어야 한다.
//
// 이 모듈은 **순수 함수**다 — 네트워크·localStorage·DOM에 접근하지 않는다.

import type { EquityPoint, Trade } from './types'
import { annualize, yearsBetween, type PitChainResult, type PitYearRow } from './pitChain'

/** `YYYY-MM-DD` → `YYYY-MM`. 정본과 같은 정의. */
export const ymOf = (date: string) => date.slice(0, 7)

/** 곡선에서 `date` **이하** 마지막 값. 없으면 null. 이월은 과거 방향으로만 한다(규칙 1). */
export function valueAsOf(curve: { date: string; equity: number }[], date: string): number | null {
  let lo = 0
  let hi = curve.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (curve[mid].date <= date) lo = mid + 1
    else hi = mid
  }
  return lo > 0 ? curve[lo - 1].equity : null
}

/**
 * 두 곡선을 **겹치는 구간**의 날짜 합집합으로 정렬한다. 한쪽에 봉이 없는 날은 그 곡선의
 * 직전 값을 이월한다(= 그날 수익률 0). 겹치지 않는 구간은 애초에 비교가 성립하지 않으므로
 * 버린다 — 한쪽만 있는 구간을 넣으면 그 구간이 통째로 그 곡선의 성적이 된다.
 */
export function alignCurves(
  a: { date: string; equity: number }[],
  b: { date: string; equity: number }[],
): { dates: string[]; ea: number[]; eb: number[] } {
  if (a.length < 1 || b.length < 1) return { dates: [], ea: [], eb: [] }
  const start = a[0].date > b[0].date ? a[0].date : b[0].date
  const end = a[a.length - 1].date < b[b.length - 1].date ? a[a.length - 1].date : b[b.length - 1].date
  if (start > end) return { dates: [], ea: [], eb: [] }
  const set = new Set<string>()
  for (const p of a) if (p.date >= start && p.date <= end) set.add(p.date)
  for (const p of b) if (p.date >= start && p.date <= end) set.add(p.date)
  const dates = [...set].sort()
  const ea: number[] = []
  const eb: number[] = []
  for (const d of dates) {
    ea.push(valueAsOf(a, d)!)
    eb.push(valueAsOf(b, d)!)
  }
  return { dates, ea, eb }
}

/**
 * 두 슬리브를 가중 `wA : 1−wA`로 섞되 **월 첫 거래일에 가중을 되돌린다**.
 * 달 안에서는 각 슬리브가 제 수익률대로 표류하고, 달이 바뀌는 첫 거래일 **시작 시점에**
 * 총자산을 다시 wA:1−wA로 나눈다. 리밸런스 판단에 쓰는 정보는 **날짜뿐**이라
 * 미래참조가 원천적으로 불가능하다.
 * 반환 곡선은 시작 1.0 배수다.
 */
export function blendMonthlyRebalanced(dates: string[], ea: number[], eb: number[], wA: number): number[] {
  if (dates.length < 1) return []
  let vA = wA
  let vB = 1 - wA
  let curYm = ymOf(dates[0])
  const out: number[] = [vA + vB]
  for (let i = 1; i < dates.length; i++) {
    const ym = ymOf(dates[i])
    if (ym !== curYm) {
      curYm = ym
      const v = vA + vB
      vA = v * wA
      vB = v * (1 - wA)
    }
    const ra = ea[i - 1] > 0 ? ea[i] / ea[i - 1] : 1
    const rb = eb[i - 1] > 0 ? eb[i] / eb[i - 1] : 1
    vA *= ra
    vB *= rb
    out.push(vA + vB)
  }
  return out
}

/** 두 곡선의 월 가중 결합 — `alignCurves` + `blendMonthlyRebalanced` 묶음. */
export function blendCurves(
  a: { date: string; equity: number }[],
  b: { date: string; equity: number }[],
  wA: number,
): { date: string; equity: number }[] {
  const { dates, ea, eb } = alignCurves(a, b)
  const v = blendMonthlyRebalanced(dates, ea, eb, wA)
  return dates.map((date, i) => ({ date, equity: v[i] }))
}

/**
 * 3자 월별 리밸런스 결합 — **2단 `blendCurves`로 합성한다.**
 *
 * ⚠️ 정본: `scripts/idea-lab.entry.ts`의 `blend3Curves`. 그대로 이식한 사본이며
 *    `tests/marketgate.test.ts`의 동형 테스트가 두 구현을 대조한다.
 *
 * 의미론이 진짜 3자 결합과 **동일한 이유**: `blendMonthlyRebalanced`는 달이 바뀌는 첫
 * 거래일에 총자산을 목표 가중으로 되돌리고 달 안에서는 각 슬리브가 제 수익률대로 표류한다.
 * 안쪽 결합(b:c = wB:wC)을 하나의 슬리브로 보면 그 슬리브의 월초 구성은 항상
 * wB/(wB+wC) : wC/(wB+wC)이고, 바깥 결합이 그 슬리브에 (wB+wC)를 배정하므로 월초 전체
 * 구성은 정확히 wA : wB : wC가 된다. 두 결합이 **같은 월 경계**에서 리밸런스하므로
 * 달 안 표류도 3자 동시 결합과 같다.
 *
 * 묶는 순서(`(a|(b|c))` vs `((a|b)|c)`)는 실수 산술에서는 같은 값이지만 부동소수점
 * 반올림이 달라 마지막 자리가 갈릴 수 있다 — 테스트가 상대오차로 대조하는 이유다.
 *
 * 가중치는 내부에서 합 1로 정규화한다. wB+wC가 0이면 a 그대로(정규화한 배수 곡선).
 */
export function blend3Curves(
  a: { date: string; equity: number }[],
  b: { date: string; equity: number }[],
  c: { date: string; equity: number }[],
  wA: number,
  wB: number,
  wC: number,
): { date: string; equity: number }[] {
  const sum = wA + wB + wC
  if (!(sum > 0)) return []
  const [nA, nB, nC] = [wA / sum, wB / sum, wC / sum]
  if (!(nB + nC > 0)) {
    const base = a.length && a[0].equity > 0 ? a[0].equity : 1
    return a.map((p) => ({ date: p.date, equity: p.equity / base }))
  }
  const inner = blendCurves(b, c, nB / (nB + nC))
  return blendCurves(a, inner, nA)
}

// ---------------------------------------------------------------------------
// 화면 어댑터 — 결합 곡선을 `PitChainResult` 호환 형태로 감싼다
// ---------------------------------------------------------------------------

const yearOf = (date: string) => date.slice(0, 4)

/**
 * 두 슬리브의 연쇄 실행 결과를 결합해 **기존 결과 화면이 그대로 읽는 형태**로 만든다.
 * 위 `blendCurves`가 유일한 합성 경로이며, 여기서는 그 곡선으로 지표를 다시 잴 뿐
 * 결합 의미론을 건드리지 않는다.
 *
 * ⚠️ **매매 원장은 비운다**(`trades: []` · `tradeCount: 0` · `winRate: null`).
 *    결합 곡선에 귀속되는 체결이 존재하지 않기 때문이며, "매매가 0건"이라는 뜻이 아니다.
 *    화면은 이 자리에 "A·B 단독 실행에서 확인" 안내를 띄워야 한다.
 *
 * 벤치마크는 슬리브 A의 곡선에 실린 값을 **결합 구간으로 다시 잘라** 쓴다(두 슬리브가
 * 같은 벤치·같은 연쇄 규약을 쓰므로 동일하다). 결합은 두 곡선의 **겹치는 구간**만
 * 남기므로, 벤치 성적도 그 구간으로 다시 재야 알파가 같은 구간 비교가 된다.
 *
 * @param capital 곡선 배수를 원화로 되돌릴 기준 자본(두 슬리브의 초기자본과 같아야 한다)
 */
export function blendChainResults(
  a: PitChainResult,
  b: PitChainResult,
  wA: number,
  capital: number,
): PitChainResult {
  const blended = blendCurves(a.equity, b.equity, wA)
  const hasBench = a.benchTotalPct != null && b.benchTotalPct != null
  // 벤치는 A 곡선에 실린 값을 과거 방향 이월로 읽는다(규칙 1 — 다음 값을 당겨오지 않는다)
  const benchCurve = a.equity.map((p) => ({ date: p.date, equity: p.benchmark }))

  const equity: EquityPoint[] = []
  let peak = 0
  let mdd = 0
  for (const p of blended) {
    peak = Math.max(peak, p.equity)
    const dd = peak > 0 ? (p.equity / peak - 1) * 100 : 0
    mdd = Math.min(mdd, dd)
    equity.push({
      date: p.date,
      equity: p.equity * capital,
      benchmark: (valueAsOf(benchCurve, p.date) ?? capital),
      drawdownPct: dd,
    })
  }

  const startDate = equity.length ? equity[0].date : a.startDate
  const endDate = equity.length ? equity[equity.length - 1].date : a.endDate
  const span = equity.length ? yearsBetween(startDate, endDate) : 1
  const factor = blended.length ? blended[blended.length - 1].equity : 1
  const totalPct = (factor - 1) * 100
  const cagrPct = annualize(factor, span)
  const mddAbs = Math.abs(mdd)

  // 벤치 배수도 **결합 구간 양끝**으로 다시 잰다 — 구간이 다르면 알파가 거짓이 된다
  const benchFirst = equity.length ? equity[0].benchmark : null
  const benchLast = equity.length ? equity[equity.length - 1].benchmark : null
  const benchFactor = hasBench && benchFirst && benchFirst > 0 && benchLast != null ? benchLast / benchFirst : null
  const benchTotalPct = benchFactor != null ? (benchFactor - 1) * 100 : null
  const benchCagrPct = benchFactor != null ? annualize(benchFactor, span) : null

  // ---- 연도별 분해 -----------------------------------------------------------
  // 결합 곡선을 해 경계로 잘라 **직전 해 마지막 값 대비**로 잰다. 이렇게 해야 연도별
  // 수익률의 곱이 전체 배수와 일치한다(연쇄 규약과 같은 분해).
  const lastOfYear = new Map<string, number>()
  const lastBenchOfYear = new Map<string, number>()
  for (const p of equity) {
    lastOfYear.set(yearOf(p.date), p.equity)
    lastBenchOfYear.set(yearOf(p.date), p.benchmark)
  }
  const rowsA = new Map(a.perYear.map((r) => [r.year, r]))
  const rowsB = new Map(b.perYear.map((r) => [r.year, r]))
  const yearKeys = [...lastOfYear.keys()].sort()
  const perYear: PitYearRow[] = []
  let prevEq = equity.length ? equity[0].equity : capital
  let prevBench = benchFirst ?? capital
  for (const yk of yearKeys) {
    const y = Number(yk)
    const cur = lastOfYear.get(yk)!
    const curBench = lastBenchOfYear.get(yk)!
    const ra = rowsA.get(y)
    const rb = rowsB.get(y)
    perYear.push({
      year: y,
      mapped: ra?.mapped ?? rb?.mapped ?? 0,
      total: ra?.total ?? rb?.total ?? 0,
      // 두 슬리브가 **모두** 현금이었던 해만 현금해다(한쪽만 현금이면 다른 쪽이 굴렀다)
      cash: (ra?.cash ?? false) && (rb?.cash ?? false),
      strategyPct: prevEq > 0 ? (cur / prevEq - 1) * 100 : 0,
      benchPct: hasBench && prevBench > 0 ? (curBench / prevBench - 1) * 100 : null,
      // 결합 곡선 자체엔 원장이 없다 — 두 슬리브 매매수의 합으로 둔다(0이 아니다)
      trades: (ra?.trades ?? 0) + (rb?.trades ?? 0),
      symbols: [...new Set([...(ra?.symbols ?? []), ...(rb?.symbols ?? [])])],
    })
    prevEq = cur
    prevBench = curBench
  }

  const noTrades: Trade[] = []
  return {
    equity,
    trades: noTrades,
    perYear,
    startDate,
    endDate,
    years: span,
    totalPct,
    cagrPct,
    mddPct: mdd,
    objective: mddAbs > 0.01 ? totalPct / mddAbs : null,
    benchTotalPct,
    benchCagrPct,
    alphaCagrPct: benchCagrPct != null ? cagrPct - benchCagrPct : null,
    alphaTotalPct: benchTotalPct != null ? totalPct - benchTotalPct : null,
    // 아래 3개는 "0건/승률 없음"이 아니라 **귀속 불가**라는 뜻이다(화면이 안내를 띄운다)
    tradeCount: 0,
    winRate: null,
    avgPnlPct: null,
    openAtEnd: a.openAtEnd + b.openAtEnd,
    exitBreakdown: [],
    // 마지막 스크리닝은 슬리브 A(조건식) 기준으로 남긴다 — 화면 라벨이 그 사실을 밝힌다
    lastScreen: a.lastScreen,
    lastScreenDate: a.lastScreenDate,
    mappedAvgPct: a.mappedAvgPct ?? b.mappedAvgPct,
  }
}
