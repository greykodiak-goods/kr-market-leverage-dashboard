// 리스크 레이어 — "얼마나 살까"를 신호와 분리해 계산한다.
//
// ── 왜 필요한가 ────────────────────────────────────────────────────────
// 지금까지 모든 모델은 슬롯 균등(1/N)으로 담았다. 문제는 종목마다 변동성이
// 천차만별이라는 점이다. SOXL과 미 국채를 1/2씩 담으면 이름만 분산이고,
// 포트폴리오 위험의 90% 이상을 SOXL이 만든다. 실제로 계좌를 흔드는 건 금액
// 비중이 아니라 **위험 기여도**다.
//
// ── 두 가지 장치 ───────────────────────────────────────────────────────
// ① 리스크 패리티(역변동성 가중)
//    비중 ∝ 1/변동성. 많이 흔들리는 종목은 적게, 얌전한 종목은 많이 담아
//    각 종목이 포트폴리오 위험에 비슷하게 기여하도록 맞춘다.
//    (엄밀한 리스크 패리티는 상관행렬까지 쓰지만, 역변동성 가중이 그 근사이며
//     추정오차가 훨씬 적어 실무에서 널리 쓰인다. 여기서는 근사를 쓴다.)
//
// ② 변동성 타게팅
//    포트폴리오 예상 변동성이 목표(예: 연 15%)를 넘으면 그만큼 투자 비중을
//    줄이고 나머지는 현금으로 둔다. 변동성이 낮으면 목표까지 늘리되 상한을
//    둔다. 이 프로젝트는 레버리지를 쓰지 않으므로 상한은 100%(현금 소진)다.
//
//    "위험을 일정하게 유지한다"는 발상이며, 변동성이 치솟는 폭락 국면에서
//    자동으로 노출을 줄이는 효과가 있다. 대신 급반등 초입에서는 회복이 느리다.
//
// ── 미래참조 금지 ──────────────────────────────────────────────────────
// 변동성은 판정 시점 i까지의 과거 수익률로만 추정한다(bars[0..i]).
// 미래 변동성을 알고 비중을 정하는 계산은 하지 않는다.

import type { DailyBar } from '../../lib/history'

export type SizingMode = 'equal' | 'inverseVol'

export interface RiskParams {
  sizing: SizingMode // 슬롯 배분 방식
  volLookback: number // 변동성 추정 기간(거래일)
  volTarget: boolean // 변동성 타게팅 사용 여부
  targetVolPct: number // 목표 연환산 변동성 %
  maxExposurePct: number // 총 투자 비중 상한 % (레버리지 금지 → 100 이하)
}

export const DEFAULT_RISK: RiskParams = {
  sizing: 'equal',
  volLookback: 60,
  volTarget: false,
  targetVolPct: 15,
  maxExposurePct: 100,
}

const ANNUALIZE = Math.sqrt(252)

// 시점 i까지의 일간 수익률 표준편차를 연환산해 반환한다(%).
// 표본이 부족하면 null — 호출부가 균등 배분으로 안전하게 되돌아간다.
export function annualizedVol(bars: DailyBar[], i: number, lookback: number): number | null {
  const start = i - lookback
  if (start < 1) return null
  const rets: number[] = []
  for (let j = start; j <= i; j++) {
    const prev = bars[j - 1].c
    if (prev > 0 && bars[j].c > 0) rets.push(bars[j].c / prev - 1)
  }
  if (rets.length < 10) return null
  const m = rets.reduce((s, v) => s + v, 0) / rets.length
  const varc = rets.reduce((s, v) => s + (v - m) ** 2, 0) / (rets.length - 1)
  const sd = Math.sqrt(varc)
  if (!(sd > 0)) return null
  return sd * ANNUALIZE * 100
}

export interface WeightInput {
  symbol: string
  volPct: number | null // 연환산 변동성 % (null = 추정 불가)
}

export interface WeightResult {
  weights: Record<string, number> // 종목별 목표 비중(합계 ≤ maxExposure/100)
  grossExposure: number // 총 투자 비중 (0~1). 나머지는 현금
  portfolioVolPct: number | null // 배분 후 예상 변동성 % (상관 0 가정 근사)
  scale: number // 변동성 타게팅으로 곱한 배율 (1 = 조정 없음)
  note: string
}

// 목표 비중을 계산한다. 슬롯 수(slots)는 "이 종목들이 차지할 자리 수"이며,
// 후보가 슬롯보다 적으면 나머지는 현금으로 남는다(억지로 채우지 않는다).
export function computeWeights(inputs: WeightInput[], slots: number, p: RiskParams): WeightResult {
  const weights: Record<string, number> = {}
  const n = Math.max(1, slots)
  if (inputs.length === 0) {
    return { weights, grossExposure: 0, portfolioVolPct: null, scale: 1, note: '후보 없음 — 전액 현금' }
  }

  // ① 기본 배분
  let base: Record<string, number> = {}
  const usable = inputs.filter((x) => x.volPct != null && x.volPct > 0)
  const canInvVol = p.sizing === 'inverseVol' && usable.length === inputs.length

  if (canInvVol) {
    // 역변동성 가중 — 변동성이 큰 종목일수록 적게 담는다
    const inv = inputs.map((x) => ({ s: x.symbol, w: 1 / (x.volPct as number) }))
    const sum = inv.reduce((a, b) => a + b.w, 0)
    // 슬롯 대비 실제 후보 수만큼만 투자(후보가 적으면 현금 유지)
    const fill = Math.min(1, inputs.length / n)
    for (const it of inv) base[it.s] = (it.w / sum) * fill
  } else {
    // 균등 — 후보 하나당 1/슬롯
    for (const x of inputs) base[x.symbol] = 1 / n
  }

  // ② 배분 후 예상 변동성 (상관 0 가정 — 실제보다 낮게 추정될 수 있음)
  let portVol: number | null = null
  if (inputs.every((x) => x.volPct != null)) {
    let varSum = 0
    for (const x of inputs) {
      const w = base[x.symbol] ?? 0
      varSum += (w * (x.volPct as number)) ** 2
    }
    portVol = Math.sqrt(varSum)
  }

  // ③ 변동성 타게팅 — 목표를 넘으면 줄이고, 낮으면 상한까지만 키운다
  let scale = 1
  let note = canInvVol ? '역변동성 가중' : '균등 배분'
  if (p.volTarget && portVol != null && portVol > 0) {
    scale = p.targetVolPct / portVol
    note += ` · 변동성 타게팅(예상 ${portVol.toFixed(1)}% → 목표 ${p.targetVolPct}%, 배율 ${scale.toFixed(2)})`
  }

  // 조정 전 총 비중 — 최종 변동성을 비례식으로 되짚기 위해 보관
  const baseGross = Object.values(base).reduce((a, b) => a + b, 0)

  const cap = p.maxExposurePct / 100
  let gross = 0
  for (const k of Object.keys(base)) {
    base[k] = base[k] * scale
    gross += base[k]
  }
  // 총 비중 상한 적용 (레버리지 금지)
  if (gross > cap && gross > 0) {
    const shrink = cap / gross
    for (const k of Object.keys(base)) base[k] *= shrink
    gross = cap
    note += ` · 상한 ${p.maxExposurePct}% 적용`
  }

  for (const k of Object.keys(base)) weights[k] = base[k]

  // 최종 예상 변동성 — 비중이 baseGross → gross로 바뀐 만큼 선형 비례한다.
  const finalVol = portVol != null && baseGross > 0 ? portVol * (gross / baseGross) : portVol

  return { weights, grossExposure: gross, portfolioVolPct: finalVol, scale, note }
}
