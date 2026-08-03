// 과최적화 측정 도구 — 탐색 결과를 "시도 횟수까지 반영해" 정직하게 채점한다.
//
// ── 왜 있나 ─────────────────────────────────────────────────────────────────
//   이 리포는 KRX 실측 유니버스에서 누적 79변형(33~36차)을 돌렸고, 그중 "판정 통과"를
//   센 것이 전부였다. **시도 횟수를 성적에 반영하지 않은 것**이 문제다. 23차에서 조건식
//   400조합 격자 1위를 뽑았는데 33차에서 그 승자가 알파 −9.6%p로 무너진 전례가 있다.
//   변형을 N개 돌리면 알파가 0인 세계에서도 "가장 좋아 보이는 하나"는 반드시 나온다.
//   그래서 필요한 답은 "찾았다"가 아니라 **"찾은 것이 우연일 확률"**이다.
//
//   여기 있는 것:
//     ① Deflated Sharpe Ratio (DSR) — 시도 N회를 감안해도 샤프가 유의한가
//     ② PBO (CSCV)                  — 인샘플 1위가 아웃샘플에서 평균 이하로 떨어질 확률
//     ③ 워크포워드 채점              — 롤링 IS 최적화 → 직후 OOS 구간만 성적으로 인정
//     ④ 다중검정 보정 유의성          — 이번 회차 N과 **누적 N**을 나란히
//
// ── 🚫 규칙 1(미래참조 금지)과의 관계 ────────────────────────────────────────
//   ①②④는 **이미 확정된 수익률 계열의 사후 채점**이다. 산출값이 신호·진입·청산·사이징으로
//   되먹임되지 않으므로 "전 구간 통계 금지"(규칙 1-5)에 걸리지 않는다. 반대로 이 값들을
//   전략 로직에 넣는 순간 그것은 미래참조가 된다 — **채점표이지 신호가 아니다.**
//   ③ 워크포워드만은 구조 자체가 인과적이어야 한다: 변형 선택은 IS 구간
//   `[isFrom, isTo)`만 보고, 성적은 그 **직후** OOS 구간 `[isTo, oosTo)`에서만 인정한다.
//   두 구간이 겹치거나 OOS가 IS보다 앞서지 않는다는 것을 `tests/overfit.test.ts`가
//   인덱스 경계 단언으로 못 박는다(선택이 OOS 값에 반응하면 실패한다).
//
// ── 규칙 3(데이터 정직성) ───────────────────────────────────────────────────
//   표본이 부족해 계산이 불가능하면 **null과 사유(reason)를 함께** 돌려준다. 0이나 1로
//   채우지 않는다 — 화면·출력에서 '—'가 되게 하는 것이 정직하다.
//   근사를 쓴 자리는 주석에 `[미검증]`으로 한계를 남겼다.
//
// ── 결정론 ──────────────────────────────────────────────────────────────────
//   난수 없음. 조합이 상한을 넘으면 무작위 표본이 아니라 **등간격 결정적 샘플링**을 쓴다.
//   같은 입력이면 언제 돌려도 같은 출력이다(테스트가 강제).
//
// 이 파일은 순수 함수만 둔다 — node:fs·네트워크·전역 상태 없음.

// ============================================================================
// 0. 수치 유틸 — 정규분포 CDF / 분위수
// ============================================================================

/** 오일러–마스케로니 상수 γ. E[max SR] 근사식에 쓰인다. */
export const EULER_MASCHERONI = 0.5772156649015329

/**
 * 표준정규 누적분포 Φ(z).
 * Hart(1968)의 유리함수 근사 — 배정도에서 |오차| < 1e-15 수준이라 임계값
 * 0.95·0.99 판정에 충분하다.
 */
export function normalCdf(z: number): number {
  if (!Number.isFinite(z)) return z > 0 ? 1 : 0
  const a = Math.abs(z)
  let p: number
  if (a > 37) {
    p = 0
  } else {
    const e = Math.exp((-a * a) / 2)
    if (a < 7.07106781186547) {
      let b = 3.52624965998911e-2 * a + 0.700383064443688
      b = b * a + 6.37396220353165
      b = b * a + 33.912866078383
      b = b * a + 112.079291497871
      b = b * a + 221.213596169931
      b = b * a + 220.206867912376
      let c = 8.83883476483184e-2 * a + 1.75566716318264
      c = c * a + 16.064177579207
      c = c * a + 86.7807322029461
      c = c * a + 296.564248779674
      c = c * a + 637.333633378831
      c = c * a + 793.826512519948
      c = c * a + 440.413735824752
      p = (e * b) / c
    } else {
      let b = a + 0.65
      b = a + 4 / b
      b = a + 3 / b
      b = a + 2 / b
      b = a + 1 / b
      p = e / (b * 2.506628274631)
    }
  }
  return z > 0 ? 1 - p : p
}

/**
 * 표준정규 분위수 Z⁻¹(p) — Acklam(2000) 유리함수 근사 + Halley 1회 보정.
 * 보정 후 상대오차는 배정도 한계 근처다. p가 0·1이면 ∓Infinity를 돌려주므로
 * 호출부가 유한성을 확인해야 한다(N=1일 때 Z⁻¹(1−1/N)=Z⁻¹(0)=−∞).
 */
export function normalQuantile(p: number): number {
  if (!(p > 0)) return p === 0 ? -Infinity : NaN
  if (!(p < 1)) return p === 1 ? Infinity : NaN

  const a = [
    -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2,
    -3.066479806614716e1, 2.506628277459239,
  ]
  const b = [
    -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1,
    -1.328068155288572e1,
  ]
  const c = [
    -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734,
    4.374664141464968, 2.938163982698783,
  ]
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416]

  const pLow = 0.02425
  const pHigh = 1 - pLow
  let x: number
  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p))
    x =
      (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
  } else if (p <= pHigh) {
    const q = p - 0.5
    const r = q * q
    x =
      ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) /
      (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
  } else {
    const q = Math.sqrt(-2 * Math.log(1 - p))
    x =
      -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
  }

  // Halley 보정 1회 — 근사 잔차를 배정도 한계까지 줄인다.
  const e = normalCdf(x) - p
  const u = e * Math.sqrt(2 * Math.PI) * Math.exp((x * x) / 2)
  return x - u / (1 + (x * u) / 2)
}

// ============================================================================
// 0-1. 표본 통계 (전부 표본 정의 n−1 · perfStats.ts와 같은 규약)
// ============================================================================

export function mean(xs: number[]): number {
  if (xs.length === 0) return 0
  let s = 0
  for (const v of xs) s += v
  return s / xs.length
}

/** 표본 표준편차(n−1). 길이 2 미만이면 0. */
export function stdev(xs: number[]): number {
  if (xs.length < 2) return 0
  const m = mean(xs)
  let s = 0
  for (const v of xs) s += (v - m) ** 2
  return Math.sqrt(s / (xs.length - 1))
}

/** 표본 분산(n−1). */
export function variance(xs: number[]): number {
  const sd = stdev(xs)
  return sd * sd
}

/**
 * 왜도 γ3 (모집단 정의 m3/m2^1.5).
 * DSR 원식이 요구하는 것은 모집단 적률의 추정치이므로 불편보정(G1)을 쓰지 않는다.
 */
export function skewness(xs: number[]): number | null {
  const n = xs.length
  if (n < 3) return null
  const m = mean(xs)
  let m2 = 0
  let m3 = 0
  for (const v of xs) {
    const d = v - m
    m2 += d * d
    m3 += d * d * d
  }
  m2 /= n
  m3 /= n
  if (!(m2 > 0)) return null
  return m3 / Math.pow(m2, 1.5)
}

/**
 * 첨도 γ4 — **비초과(non-excess)** 정의. 정규분포면 3.
 * DSR 분모식이 (γ4 − 1)/4 형태로 비초과 첨도를 쓰기 때문에 여기서 3을 빼지 않는다.
 */
export function kurtosis(xs: number[]): number | null {
  const n = xs.length
  if (n < 4) return null
  const m = mean(xs)
  let m2 = 0
  let m4 = 0
  for (const v of xs) {
    const d = v - m
    m2 += d * d
    m4 += d * d * d * d
  }
  m2 /= n
  m4 /= n
  if (!(m2 > 0)) return null
  return m4 / (m2 * m2)
}

/** 중앙값. 빈 배열이면 null. */
export function median(xs: number[]): number | null {
  if (xs.length === 0) return null
  const s = [...xs].sort((p, q) => p - q)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

// ============================================================================
// 1. 성과 지표 플러그 — PBO·워크포워드가 공유한다
// ============================================================================

/**
 * 수익률 계열 → 성과 점수. 계산 불가면 **null**(0으로 채우지 않는다).
 * PBO·워크포워드는 이 함수로만 변형을 서열화하므로, 지표를 바꾸면 두 도구가 같이 바뀐다.
 */
export type PerfMetric = (returns: number[]) => number | null

/**
 * 변동성이 "수치적으로 0"인지 판정하는 상대 임계값.
 *
 * 상수 수익률 계열은 이론상 표준편차가 0이지만, 합을 누적하는 과정의 부동소수 오차가
 * 1e-19 수준의 잔차를 남긴다. `sd > 0`만 확인하고 나누면 샤프가 **1e15로 튀어**
 * 가짜 초대박 전략이 만들어진다(이 프로젝트의 테스트에서 실제로 잡혔다).
 * 데이터의 척도(평균 절대값) 대비 이 비율 이하면 변동성 0으로 본다.
 */
export const DEGENERATE_SD_RATIO = 1e-9

/** 표준편차가 데이터 척도에 비해 무의미하게 작은가(= 상수 계열인가). */
function degenerateVolatility(xs: number[], sd: number): boolean {
  if (!(sd > 0)) return true
  let scale = 0
  for (const v of xs) scale += Math.abs(v)
  scale /= xs.length
  return sd <= DEGENERATE_SD_RATIO * scale
}

/**
 * 기본 지표 = 기간당 샤프(무위험 0). 연환산하지 않는다 —
 * 서열만 쓰는 곳이라 √252를 곱해도 순위가 바뀌지 않고, 곱하면 "연환산 샤프"로
 * 오해될 여지만 생긴다.
 */
export const sharpeMetric: PerfMetric = (rs) => {
  if (rs.length < 2) return null
  const sd = stdev(rs)
  if (degenerateVolatility(rs, sd)) return null
  return mean(rs) / sd
}

/** 평균 수익률 지표 — 변동성이 0인 합성 데이터 등에서 대안으로 쓴다. */
export const meanReturnMetric: PerfMetric = (rs) => (rs.length === 0 ? null : mean(rs))

/** 누적수익률(복리) — 1 + r 를 곱해 나간 뒤 −1. */
export function compound(rs: number[]): number {
  let eq = 1
  for (const r of rs) eq *= 1 + r
  return eq - 1
}

/** 연환산 수익률(%). periodsPerYear 기간이 1년이라고 본다. */
export function annualizedPct(rs: number[], periodsPerYear: number): number | null {
  if (rs.length === 0 || !(periodsPerYear > 0)) return null
  let eq = 1
  for (const r of rs) eq *= 1 + r
  if (!(eq > 0)) return null // 전액 소실 — 연환산이 정의되지 않는다
  return (Math.pow(eq, periodsPerYear / rs.length) - 1) * 100
}

// ============================================================================
// 2. Deflated Sharpe Ratio (Bailey & López de Prado, 2014)
// ============================================================================
//
// 논문: D. Bailey, M. López de Prado, "The Deflated Sharpe Ratio: Correcting for
// Selection Bias, Backtest Overfitting and Non-Normality", Journal of Portfolio
// Management, 2014.
//
// (a) 시도 N회에서 기대되는 **최대 샤프**(알파가 전혀 없는 세계에서도 나오는 값):
//
//       E[max SR] ≈ √V · [ (1 − γ)·Z⁻¹(1 − 1/N) + γ·Z⁻¹(1 − 1/(N·e)) ]
//
//     V = 시도들의 샤프 **분산**, γ = 오일러–마스케로니 상수(0.5772…),
//     e = 자연상수. 이는 독립 정규 표본 N개의 최대값 기대치에 대한
//     **극단값 이론(Gumbel) 근사**다. [미검증] 근사의 한계:
//       · 시도들이 서로 독립이라고 본다. 실제 격자 탐색은 파라미터가 이웃하면
//         수익률이 강하게 상관돼 있어 **유효 시도 수는 N보다 작다** → E[max SR]을
//         과대평가 → DSR을 보수적(낮게)으로 만든다. 즉 오차는 안전한 방향이다.
//       · 시도들의 샤프가 정규분포라고 본다.
//       · N=1이면 Z⁻¹(0) = −∞이므로 정의되지 않는다 → 선택편의가 없다고 보고
//         E[max SR] = 0으로 둔다(주의 메모를 남긴다).
//
// (b) 관측 샤프가 그 기준을 넘을 확률(= PSR을 SR* = E[max SR]에 대해 평가):
//
//       DSR = Φ( (SR̂ − SR*)·√(T−1) / √(1 − γ3·SR̂ + ((γ4 − 1)/4)·SR̂²) )
//
//     γ3 = 수익률 왜도, γ4 = **비초과** 첨도(정규=3), T = 관측 수.
//     [미검증] 이 식 자체가 SR̂의 표본분포에 대한 **정규 근사**다(중심극한정리 기반).
//     T가 작거나 꼬리가 극단적이면 근사가 흔들린다 — 그래서 최소 표본을 강제한다.
//
// ⚠️ SR̂·SR*·V는 **같은 주기**로 맞춰야 한다. 이 모듈은 전부 "기간당(일별) 샤프"를
//    기준으로 한다. 연환산 샤프를 넣으면 T와 단위가 어긋나 값이 무의미해진다.

/** DSR이 "시도 횟수를 감안해도 유의하다"고 말할 수 있는 임계값. */
export const DSR_PASS_THRESHOLD = 0.95

/** DSR 계산에 요구하는 최소 관측 수 — 정규 근사가 성립할 최소한. */
export const DSR_MIN_OBSERVATIONS = 30

export interface DeflatedSharpeInput {
  /** 관측 샤프 — **기간당**(연환산 아님). */
  observedSharpe: number
  /** 표본 길이(관측 수) T. */
  sampleLength: number
  /** 시도 횟수 N. */
  trials: number
  /** 시도들의 샤프 **분산** V(기간당 샤프 기준). */
  trialSharpeVariance: number
  /** 수익률 왜도 γ3. 생략하면 0(정규 가정). */
  skew?: number
  /** 수익률 **비초과** 첨도 γ4. 생략하면 3(정규 가정). */
  kurtosis?: number
}

export interface DeflatedSharpeResult {
  /** 관측 샤프가 기대 최대치를 넘을 확률. 계산 불가면 null. */
  dsr: number | null
  /** E[max SR] — 알파 0인 세계에서 N회 시도로 기대되는 최대 샤프. */
  expectedMaxSharpe: number | null
  /** 관측 샤프 − E[max SR]. 음수면 "시도 횟수만으로 설명되는 성적". */
  excessOverExpectedMax: number | null
  /** DSR ≥ 0.95 여부. dsr이 null이면 null. */
  passes: boolean | null
  /** null인 이유(규칙 3). 계산됐으면 null. */
  reason: string | null
  /** 근사의 한계·특수 처리 메모. 값이 나와도 함께 읽어야 한다. */
  notes: string[]
  /** 되짚어 볼 수 있게 입력을 그대로 담는다. */
  input: DeflatedSharpeInput
}

/**
 * 알파가 0인 세계에서 N회 시도로 기대되는 최대 샤프.
 * @returns 계산 불가면 null
 */
export function expectedMaxSharpe(trials: number, trialSharpeVariance: number): number | null {
  if (!Number.isFinite(trials) || trials < 1) return null
  if (!Number.isFinite(trialSharpeVariance) || trialSharpeVariance < 0) return null
  if (trials <= 1) return 0 // 시도가 1회면 선택편의가 없다
  const v = Math.sqrt(trialSharpeVariance)
  if (v === 0) return 0
  const z1 = normalQuantile(1 - 1 / trials)
  const z2 = normalQuantile(1 - 1 / (trials * Math.E))
  if (!Number.isFinite(z1) || !Number.isFinite(z2)) return null
  return v * ((1 - EULER_MASCHERONI) * z1 + EULER_MASCHERONI * z2)
}

/**
 * 확률적 샤프비율 PSR(SR*) — 관측 샤프가 기준 SR*를 넘을 확률.
 * DSR은 SR* = E[max SR]로 둔 PSR이다.
 */
export function probabilisticSharpe(
  observedSharpe: number,
  benchmarkSharpe: number,
  sampleLength: number,
  skew = 0,
  kurt = 3,
): number | null {
  if (!Number.isFinite(observedSharpe) || !Number.isFinite(benchmarkSharpe)) return null
  if (!Number.isFinite(sampleLength) || sampleLength < 2) return null
  const denomSq = 1 - skew * observedSharpe + ((kurt - 1) / 4) * observedSharpe * observedSharpe
  if (!(denomSq > 0)) return null // 분모 제곱이 음수 — 적률 추정이 깨진 경우
  const z = ((observedSharpe - benchmarkSharpe) * Math.sqrt(sampleLength - 1)) / Math.sqrt(denomSq)
  return normalCdf(z)
}

/** Deflated Sharpe Ratio. 표본 부족·입력 이상이면 dsr=null + reason. */
export function deflatedSharpe(input: DeflatedSharpeInput): DeflatedSharpeResult {
  const notes: string[] = []
  const fail = (reason: string): DeflatedSharpeResult => ({
    dsr: null,
    expectedMaxSharpe: null,
    excessOverExpectedMax: null,
    passes: null,
    reason,
    notes,
    input,
  })

  const { observedSharpe, sampleLength, trials, trialSharpeVariance } = input
  const skew = input.skew ?? 0
  const kurt = input.kurtosis ?? 3

  if (!Number.isFinite(observedSharpe)) return fail('관측 샤프가 유한한 수가 아님')
  if (!Number.isFinite(sampleLength) || sampleLength < DSR_MIN_OBSERVATIONS) {
    return fail(`표본 부족 — 관측 ${sampleLength}개 < 최소 ${DSR_MIN_OBSERVATIONS}개(정규 근사 불가)`)
  }
  if (!Number.isFinite(trials) || trials < 1) return fail('시도 횟수 N이 1 이상의 유한한 수가 아님')
  if (!Number.isFinite(trialSharpeVariance) || trialSharpeVariance < 0) {
    return fail('시도 샤프 분산 V가 0 이상의 유한한 수가 아님')
  }
  if (input.skew === undefined) notes.push('왜도 미지정 — 0(정규) 가정')
  if (input.kurtosis === undefined) notes.push('첨도 미지정 — 3(정규) 가정')

  const emax = expectedMaxSharpe(trials, trialSharpeVariance)
  if (emax === null) return fail('E[max SR] 계산 불가 (시도 횟수·분산 입력 확인)')
  if (trials <= 1) notes.push('시도 N=1 — 선택편의 없음으로 보고 E[max SR]=0 (DSR = PSR(0))')
  if (trialSharpeVariance === 0) {
    notes.push('시도 샤프 분산 V=0 — E[max SR]=0. 변형이 1개거나 분산 입력이 빠진 것은 아닌지 확인')
  }

  const dsr = probabilisticSharpe(observedSharpe, emax, sampleLength, skew, kurt)
  if (dsr === null) return fail('PSR 분모가 0 이하 — 왜도·첨도 조합이 유효하지 않음')

  notes.push('[미검증] Gumbel 극단값 근사 + 정규 근사. 시도 간 상관이 크면 유효 N이 줄어 DSR은 보수적으로 나온다')

  return {
    dsr,
    expectedMaxSharpe: emax,
    excessOverExpectedMax: observedSharpe - emax,
    passes: dsr >= DSR_PASS_THRESHOLD,
    reason: null,
    notes,
    input,
  }
}

/** 수익률 계열에서 DSR 입력에 필요한 적률을 뽑는다. */
export interface SharpeMoments {
  sharpe: number | null
  sampleLength: number
  skew: number | null
  kurtosis: number | null
  reason: string | null
}

export function sharpeMoments(returns: number[]): SharpeMoments {
  const n = returns.length
  if (n < 2) {
    return { sharpe: null, sampleLength: n, skew: null, kurtosis: null, reason: '관측 2개 미만' }
  }
  const sd = stdev(returns)
  if (degenerateVolatility(returns, sd)) {
    return {
      sharpe: null,
      sampleLength: n,
      skew: null,
      kurtosis: null,
      reason: '수익률 표준편차가 0(또는 수치적으로 0) — 샤프가 정의되지 않음',
    }
  }
  return {
    sharpe: mean(returns) / sd,
    sampleLength: n,
    skew: skewness(returns),
    kurtosis: kurtosis(returns),
    reason: null,
  }
}

/**
 * 승자 수익률 계열 + 시도들의 샤프 목록으로 DSR을 낸다(가장 흔한 호출 형태).
 * `trials`를 생략하면 `trialSharpes.length`를 쓴다 — 다만 **누적 시도**는 이 배열보다
 * 클 수 있으므로 진짜 분모를 원하면 명시적으로 넘겨야 한다(④ 참고).
 */
export function deflatedSharpeFromReturns(
  winnerReturns: number[],
  trialSharpes: number[],
  trials?: number,
): DeflatedSharpeResult {
  const m = sharpeMoments(winnerReturns)
  const n = trials ?? trialSharpes.length
  const base: DeflatedSharpeInput = {
    observedSharpe: m.sharpe ?? NaN,
    sampleLength: m.sampleLength,
    trials: n,
    trialSharpeVariance: variance(trialSharpes),
    skew: m.skew ?? undefined,
    kurtosis: m.kurtosis ?? undefined,
  }
  if (m.sharpe === null) {
    return {
      dsr: null,
      expectedMaxSharpe: null,
      excessOverExpectedMax: null,
      passes: null,
      reason: m.reason ?? '승자 샤프 계산 불가',
      notes: [],
      input: base,
    }
  }
  return deflatedSharpe(base)
}

// ============================================================================
// 3. PBO — Probability of Backtest Overfitting (CSCV)
// ============================================================================
//
// 논문: D. Bailey, J. Borwein, M. López de Prado, Q. J. Zhu,
// "The Probability of Backtest Overfitting", Journal of Computational Finance, 2016.
//
// 절차(조합 대칭 교차검증, Combinatorially Symmetric Cross-Validation):
//   1. 시점 축 T를 **연속된 S개 블록**으로 자른다(S는 짝수). 나머지는 버린다.
//   2. S개 중 S/2개를 고르는 **모든 조합** C(S, S/2)에 대해:
//        · 고른 블록 = IS, 나머지 = OOS (블록 단위라 시계열 구조가 일부 보존된다)
//        · 변형별로 IS 성과·OOS 성과를 계산
//        · IS 1위 변형 n*을 뽑고, 그 변형의 **OOS 순위** r(1=최하위 … N=최상위)을 본다
//        · ω = r/(N+1) ∈ (0,1), 로짓 λ = ln(ω/(1−ω))
//   3. PBO = P(λ ≤ 0) = "IS 1위가 OOS에서 중앙값 이하로 떨어진 조합의 비율"
//
// 해석: **PBO > 0.5이면 인샘플 1위가 아웃샘플에서 평균 이하일 확률이 반 이상** —
//       그 1위는 전략이 아니라 탐색의 산물이다.
//
// [미검증] 한계:
//   · IS·OOS가 시간상 뒤섞인다(뒤 블록이 IS가 되기도 한다). CSCV는 **변형 선택의
//     과최적화**를 재는 도구이지 시간 인과성 검증이 아니다 — 인과성은 워크포워드(③)와
//     엔진의 절단 불변성 테스트가 담당한다. 두 도구는 서로를 대체하지 않는다.
//   · 변형들의 수익률이 강하게 상관돼 있으면 순위가 잡음에 지배돼 PBO가 0.5로 끌린다.
//   · 블록 경계에서 포지션이 끊긴 것처럼 계산되므로 **수익률 계열 기준**으로만 의미가 있다
//     (자산곡선 레벨을 잘라 붙이면 안 된다).
//   · ⚠️ **단일 실행의 PBO는 크게 흔들린다.** "알파 0이면 PBO≈0.5"는 **여러 독립 실현의
//     기대값**에서 성립하는 성질이지, 한 번의 회차에서 보장되는 값이 아니다. 실제로
//     `tests/overfit.test.ts`의 무신호 합성 40회에서 평균은 0.485였지만 개별 값은
//     **0.09~0.89**까지 퍼졌다(같은 데이터 한 벌에서 실현된 서열이 IS·OOS 양쪽에 함께
//     반영되기 때문이다). 그래서 한 회차의 PBO 숫자 하나로 결론짓지 말고 임계 0.5,
//     λ 분포, 그리고 DSR·워크포워드를 **함께** 읽어야 한다.

/** PBO가 "탐색의 산물"이라고 경고하는 임계값. */
export const PBO_WARN_THRESHOLD = 0.5

/** 기본 블록 수 S=16 → C(16,8) = 12,870 조합. 논문 권장 범위. */
export const PBO_DEFAULT_BLOCKS = 16

/** 조합 상한 기본값 — 넘으면 등간격 결정적 샘플링. */
export const PBO_DEFAULT_MAX_COMBINATIONS = 20000

export interface PboOptions {
  /** 블록 수 S(짝수, 4 이상). 기본 16. */
  blocks?: number
  /** 실제로 평가할 조합 수 상한. 기본 20,000. */
  maxCombinations?: number
  /** 서열화 지표. 기본 기간당 샤프. */
  metric?: PerfMetric
}

export interface PboResult {
  /** IS 1위가 OOS 중앙값 이하로 떨어진 비율. 계산 불가면 null. */
  pbo: number | null
  /** PBO > 0.5 여부. pbo가 null이면 null. */
  overfitLikely: boolean | null
  /** null인 이유(규칙 3). */
  reason: string | null
  /** 블록 수 S. */
  blocks: number
  /** 블록 하나의 관측 수. */
  blockSize: number
  /** S로 나누어떨어지지 않아 **뒤에서** 버린 관측 수. */
  droppedObservations: number
  /** C(S, S/2). */
  combinationsTotal: number
  /** 실제로 평가한 조합 수. */
  combinationsEvaluated: number
  /** 지표 계산 불가로 건너뛴 조합 수. */
  combinationsSkipped: number
  /** 전수 평가였는지(false면 등간격 결정적 샘플링). */
  exhaustive: boolean
  /** 조합별 로짓 λ. λ ≤ 0이 "OOS 중앙값 이하". */
  lambdas: number[]
  /** λ의 중앙값 — 음수면 전형적인 조합에서도 순위가 무너졌다는 뜻. */
  medianLambda: number | null
  /** IS 1위 변형이 OOS에서 받은 상대순위 ω의 평균. */
  meanOosRank: number | null
  variants: number
  observations: number
  notes: string[]
}

/** 이항계수 C(n, k). n이 커도 배정도 정수 한계(2^53) 안에서만 쓴다. */
export function binomial(n: number, k: number): number {
  if (k < 0 || k > n) return 0
  const kk = Math.min(k, n - k)
  let r = 1
  for (let i = 1; i <= kk; i++) r = (r * (n - kk + i)) / i
  return Math.round(r)
}

/**
 * 사전식(lexicographic) 순서에서 rank번째 조합을 복원한다(조합수 체계).
 * 전수 열거 없이 임의의 조합을 꺼낼 수 있어 **결정적 등간격 샘플링**의 기반이 된다.
 */
export function unrankCombination(n: number, k: number, rank: number): number[] {
  const out: number[] = []
  let r = rank
  let x = 0
  for (let i = 0; i < k; i++) {
    for (;;) {
      const c = binomial(n - x - 1, k - i - 1)
      if (r < c) break
      r -= c
      x++
    }
    out.push(x)
    x++
  }
  return out
}

/**
 * PBO(CSCV).
 * @param matrix `matrix[변형][시점]` 수익률 행렬. 모든 행의 길이가 같아야 한다.
 */
export function computePbo(matrix: number[][], options: PboOptions = {}): PboResult {
  const notes: string[] = []
  const blocks = Math.floor(options.blocks ?? PBO_DEFAULT_BLOCKS)
  const maxCombos = Math.max(1, Math.floor(options.maxCombinations ?? PBO_DEFAULT_MAX_COMBINATIONS))
  const metric = options.metric ?? sharpeMetric

  const nVariants = matrix.length
  const nObs = nVariants > 0 ? matrix[0].length : 0

  const fail = (reason: string): PboResult => ({
    pbo: null,
    overfitLikely: null,
    reason,
    blocks,
    blockSize: 0,
    droppedObservations: 0,
    combinationsTotal: 0,
    combinationsEvaluated: 0,
    combinationsSkipped: 0,
    exhaustive: false,
    lambdas: [],
    medianLambda: null,
    meanOosRank: null,
    variants: nVariants,
    observations: nObs,
    notes,
  })

  if (nVariants < 2) return fail(`변형이 ${nVariants}개 — PBO는 2개 이상의 변형을 비교해야 한다`)
  if (!matrix.every((row) => row.length === nObs)) return fail('변형별 시점 길이가 다르다')
  if (blocks < 4 || blocks % 2 !== 0) return fail(`블록 수 S=${blocks} — 4 이상의 짝수여야 한다`)

  const blockSize = Math.floor(nObs / blocks)
  if (blockSize < 2) {
    return fail(`표본 부족 — 관측 ${nObs}개를 S=${blocks} 블록으로 나누면 블록당 ${blockSize}개(최소 2)`)
  }
  const used = blockSize * blocks
  const dropped = nObs - used
  if (dropped > 0) notes.push(`S로 나누어떨어지지 않아 마지막 관측 ${dropped}개를 버렸다`)

  // 블록 인덱스 경계
  const blockRanges: [number, number][] = []
  for (let b = 0; b < blocks; b++) blockRanges.push([b * blockSize, (b + 1) * blockSize])

  const half = blocks / 2
  const total = binomial(blocks, half)
  const exhaustive = total <= maxCombos
  const evaluateCount = exhaustive ? total : maxCombos
  // 결정적 등간격 샘플링 — 난수 금지(규칙: 재현성).
  const stride = exhaustive ? 1 : total / maxCombos
  if (!exhaustive) {
    notes.push(
      `조합 ${total}개 > 상한 ${maxCombos}개 — 사전식 순서에서 등간격으로 ${maxCombos}개만 평가(무작위 아님·재현 가능)`,
    )
  }

  const lambdas: number[] = []
  const omegas: number[] = []
  let skipped = 0

  const sliceOf = (row: number[], chosen: boolean[], want: boolean): number[] => {
    const out: number[] = []
    for (let b = 0; b < blocks; b++) {
      if (chosen[b] !== want) continue
      const [from, to] = blockRanges[b]
      for (let t = from; t < to; t++) out.push(row[t])
    }
    return out
  }

  for (let i = 0; i < evaluateCount; i++) {
    const rank = exhaustive ? i : Math.min(total - 1, Math.floor(i * stride))
    const combo = unrankCombination(blocks, half, rank)
    const chosen = new Array<boolean>(blocks).fill(false)
    for (const b of combo) chosen[b] = true

    const isScores: (number | null)[] = []
    const oosScores: (number | null)[] = []
    let broken = false
    for (let v = 0; v < nVariants; v++) {
      const si = metric(sliceOf(matrix[v], chosen, true))
      const so = metric(sliceOf(matrix[v], chosen, false))
      if (si === null || so === null || !Number.isFinite(si) || !Number.isFinite(so)) {
        broken = true
        break
      }
      isScores.push(si)
      oosScores.push(so)
    }
    if (broken) {
      skipped++
      continue
    }

    // IS 1위 — 동점이면 인덱스가 작은 쪽(결정적)
    let best = 0
    for (let v = 1; v < nVariants; v++) {
      if ((isScores[v] as number) > (isScores[best] as number)) best = v
    }

    // OOS 순위: 오름차순 정렬 후 1-based 위치. 동점은 인덱스 오름차순으로 안정 정렬.
    const order = oosScores
      .map((s, v) => ({ s: s as number, v }))
      .sort((p, q) => (p.s === q.s ? p.v - q.v : p.s - q.s))
    const r = order.findIndex((o) => o.v === best) + 1

    const omega = r / (nVariants + 1) // ∈ (0,1) — 0·1이 안 나오므로 로짓이 유한하다
    omegas.push(omega)
    lambdas.push(Math.log(omega / (1 - omega)))
  }

  const evaluated = lambdas.length
  if (evaluated === 0) {
    return fail(`평가 가능한 조합이 0개 — 지표 계산 불가(건너뛴 조합 ${skipped}개)`)
  }
  if (skipped > 0) {
    notes.push(`지표 계산 불가로 건너뛴 조합 ${skipped}개(전체 ${evaluateCount}개 중)`)
  }
  if (skipped > evaluateCount / 2) {
    return fail(`조합의 절반 이상(${skipped}/${evaluateCount})에서 지표를 계산할 수 없어 PBO를 신뢰할 수 없다`)
  }

  let below = 0
  for (const l of lambdas) if (l <= 0) below++
  const pbo = below / evaluated

  return {
    pbo,
    overfitLikely: pbo > PBO_WARN_THRESHOLD,
    reason: null,
    blocks,
    blockSize,
    droppedObservations: dropped,
    combinationsTotal: total,
    combinationsEvaluated: evaluated,
    combinationsSkipped: skipped,
    exhaustive,
    lambdas,
    medianLambda: median(lambdas),
    meanOosRank: mean(omegas),
    variants: nVariants,
    observations: nObs,
    notes,
  }
}

// ============================================================================
// 4. 워크포워드 채점
// ============================================================================
//
// 롤링으로 IS 구간에서 변형을 **고르고**, 그 **직후** OOS 구간의 성적만 인정한다.
// 고른 뒤 창을 한 스텝(=OOS 길이) 밀어 다시 고른다. OOS 조각을 이어 붙인 것이
// "실전에서 이 절차를 따랐다면 받았을 성적"이다.
//
// 🚫 규칙 1: 변형 선택은 `[isFrom, isTo)`만 본다. OOS는 항상 `isTo`에서 시작하므로
//    선택 정보가 OOS로 새지 않는다. 이 경계는 결과 객체에 인덱스로 그대로 노출되고
//    `tests/overfit.test.ts`가 (a) 구간 불겹침 (b) OOS 데이터를 바꿔도 선택이
//    불변임을 단언한다.

export interface WalkForwardOptions {
  /** IS 창 길이(관측 수). */
  isWindow: number
  /** OOS 창 길이 = 스텝(관측 수). */
  oosWindow: number
  /** 변형 선택 지표. 기본 기간당 샤프. */
  metric?: PerfMetric
  /** 연환산 계수. 기본 252(한국 주식 거래일 근사). */
  periodsPerYear?: number
  /** 벤치마크 수익률 계열(시점 길이 동일). 있으면 OOS 알파를 낸다. */
  benchmark?: number[]
}

export interface WalkForwardSegment {
  index: number
  /** IS 구간 `[isFrom, isTo)` — 여기까지만 보고 변형을 고른다. */
  isFrom: number
  isTo: number
  /** OOS 구간 `[oosFrom, oosTo)` — 항상 oosFrom === isTo. */
  oosFrom: number
  oosTo: number
  /** IS 1위로 선택된 변형 인덱스. */
  selectedVariant: number
  /** 선택 변형의 IS 성과. */
  isMetric: number
  /** 선택 변형의 OOS 성과. 계산 불가면 null. */
  oosMetric: number | null
}

export interface WalkForwardResult {
  segments: WalkForwardSegment[]
  /** 이어 붙인 OOS 수익률(시간 순). */
  oosReturns: number[]
  /** OOS 자산곡선(1에서 시작, 길이 = oosReturns.length + 1). */
  oosEquity: number[]
  oosTotalReturnPct: number | null
  oosAnnualizedPct: number | null
  /** 같은 OOS 인덱스에서의 벤치마크 연환산(%). 벤치마크 미제공이면 null. */
  benchAnnualizedPct: number | null
  /** 규칙 5 — 알파 = OOS 연환산 − 벤치 연환산. */
  oosAlphaPct: number | null
  /** 선택 변형들의 IS 성과 중앙값. */
  medianIsMetric: number | null
  /** 같은 변형들의 OOS 성과 중앙값. */
  medianOosMetric: number | null
  /** 성능 저하율(%) = (1 − OOS중앙값/IS중앙값)×100. IS중앙값이 0 이하면 null. */
  degradationPct: number | null
  reason: string | null
  notes: string[]
}

/** 워크포워드 구간 경계만 미리 계산한다(테스트·화면이 경계를 검사할 수 있게 분리). */
export function walkForwardWindows(
  observations: number,
  isWindow: number,
  oosWindow: number,
): { isFrom: number; isTo: number; oosFrom: number; oosTo: number }[] {
  const out: { isFrom: number; isTo: number; oosFrom: number; oosTo: number }[] = []
  if (!(isWindow > 0) || !(oosWindow > 0)) return out
  for (let start = 0; start + isWindow + oosWindow <= observations; start += oosWindow) {
    const isTo = start + isWindow
    out.push({ isFrom: start, isTo, oosFrom: isTo, oosTo: isTo + oosWindow })
  }
  return out
}

/**
 * 워크포워드 채점.
 * @param matrix `matrix[변형][시점]` 수익률 행렬.
 */
export function walkForwardScore(matrix: number[][], options: WalkForwardOptions): WalkForwardResult {
  const notes: string[] = []
  const metric = options.metric ?? sharpeMetric
  const ppy = options.periodsPerYear ?? 252
  const isWindow = Math.floor(options.isWindow)
  const oosWindow = Math.floor(options.oosWindow)

  const nVariants = matrix.length
  const nObs = nVariants > 0 ? matrix[0].length : 0

  const fail = (reason: string): WalkForwardResult => ({
    segments: [],
    oosReturns: [],
    oosEquity: [],
    oosTotalReturnPct: null,
    oosAnnualizedPct: null,
    benchAnnualizedPct: null,
    oosAlphaPct: null,
    medianIsMetric: null,
    medianOosMetric: null,
    degradationPct: null,
    reason,
    notes,
  })

  if (nVariants < 1) return fail('변형이 없다')
  if (!matrix.every((row) => row.length === nObs)) return fail('변형별 시점 길이가 다르다')
  if (!(isWindow > 0) || !(oosWindow > 0)) return fail('IS·OOS 창 길이는 1 이상이어야 한다')
  if (options.benchmark && options.benchmark.length !== nObs) {
    return fail(`벤치마크 길이(${options.benchmark.length})가 수익률 길이(${nObs})와 다르다`)
  }

  const windows = walkForwardWindows(nObs, isWindow, oosWindow)
  if (windows.length === 0) {
    return fail(`표본 부족 — 관측 ${nObs}개로는 IS ${isWindow} + OOS ${oosWindow} 창을 하나도 만들 수 없다`)
  }

  const segments: WalkForwardSegment[] = []
  const oosReturns: number[] = []
  const oosIndices: number[] = []

  for (const w of windows) {
    // ── 선택: IS 구간만 본다. slice(w.isFrom, w.isTo) — 끝 인덱스는 배타적이라
    //    w.isTo(= OOS 첫 인덱스)는 포함되지 않는다.
    let best = -1
    let bestScore = -Infinity
    for (let v = 0; v < nVariants; v++) {
      const s = metric(matrix[v].slice(w.isFrom, w.isTo))
      if (s === null || !Number.isFinite(s)) continue
      if (s > bestScore) {
        bestScore = s
        best = v
      }
    }
    if (best < 0) {
      notes.push(`구간 ${segments.length}: IS에서 모든 변형의 지표 계산 불가 — 건너뜀`)
      continue
    }

    const oosSlice = matrix[best].slice(w.oosFrom, w.oosTo)
    segments.push({
      index: segments.length,
      isFrom: w.isFrom,
      isTo: w.isTo,
      oosFrom: w.oosFrom,
      oosTo: w.oosTo,
      selectedVariant: best,
      isMetric: bestScore,
      oosMetric: metric(oosSlice),
    })
    for (let t = w.oosFrom; t < w.oosTo; t++) {
      oosReturns.push(matrix[best][t])
      oosIndices.push(t)
    }
  }

  if (segments.length === 0) return fail('평가 가능한 워크포워드 구간이 없다(모든 구간에서 지표 계산 불가)')

  const oosEquity: number[] = [1]
  for (const r of oosReturns) oosEquity.push(oosEquity[oosEquity.length - 1] * (1 + r))

  const oosTotalReturnPct = compound(oosReturns) * 100
  const oosAnnualized = annualizedPct(oosReturns, ppy)

  let benchAnnualized: number | null = null
  if (options.benchmark) {
    // 전략이 실제로 서 있던 **같은 인덱스**의 벤치마크만 쓴다(구간이 안 겹치므로 중복 없음).
    const benchSlice = oosIndices.map((t) => (options.benchmark as number[])[t])
    benchAnnualized = annualizedPct(benchSlice, ppy)
  } else {
    notes.push('벤치마크 미제공 — 알파(규칙 5)를 낼 수 없어 절대 수익률만 표시')
  }

  const isMetrics = segments.map((s) => s.isMetric)
  const oosMetrics = segments.map((s) => s.oosMetric).filter((x): x is number => x !== null)
  if (oosMetrics.length < segments.length) {
    notes.push(`OOS 지표를 계산하지 못한 구간 ${segments.length - oosMetrics.length}개는 저하율 계산에서 제외`)
  }
  const medIs = median(isMetrics)
  const medOos = oosMetrics.length > 0 ? median(oosMetrics) : null
  let degradationPct: number | null = null
  if (medIs !== null && medOos !== null && medIs > 0) {
    degradationPct = (1 - medOos / medIs) * 100
  } else if (medIs !== null && medIs <= 0) {
    notes.push('IS 성과 중앙값이 0 이하 — 저하율(비율)이 정의되지 않아 null')
  }

  return {
    segments,
    oosReturns,
    oosEquity,
    oosTotalReturnPct,
    oosAnnualizedPct: oosAnnualized,
    benchAnnualizedPct: benchAnnualized,
    oosAlphaPct: oosAnnualized !== null && benchAnnualized !== null ? oosAnnualized - benchAnnualized : null,
    medianIsMetric: medIs,
    medianOosMetric: medOos,
    degradationPct,
    reason: null,
    notes,
  }
}

// ============================================================================
// 5. 다중검정 보정 유의성 — 이번 회차 N vs 누적 N
// ============================================================================
//
// 대표가 볼 숫자는 "이번에 몇 개 돌려서 하나 건졌다"가 아니라 **"지금까지 몇 개를 보고
// 이걸 골랐나"**다. 누적 N이 진짜 분모다 — 23차의 400조합 격자도, 33~36차의 79변형도
// 전부 같은 데이터·같은 유니버스를 여러 번 본 것이므로 선택편의가 누적된다.

export interface MultipleTestingReport {
  /** 이번 회차 시도 수만 반영한 DSR. */
  thisRound: DeflatedSharpeResult
  /** 누적 시도 수를 반영한 DSR — **이쪽이 진짜 분모**다. */
  cumulative: DeflatedSharpeResult
  trialsThisRound: number
  trialsCumulative: number
  /** 단측 p값(= 1 − PSR(0)) — 보정 전. */
  rawPValue: number | null
  /** Bonferroni 보정 p값 = min(1, p×N_누적). */
  bonferroniPValue: number | null
  /** Šidák 보정 p값 = 1 − (1−p)^N_누적. 시도 독립 가정. */
  sidakPValue: number | null
  /** 누적 DSR 기준 판정. */
  verdict: 'pass' | 'fail' | 'unknown'
  headline: string
}

export interface MultipleTestingInput {
  observedSharpe: number
  sampleLength: number
  trialSharpeVariance: number
  skew?: number
  kurtosis?: number
  trialsThisRound: number
  trialsCumulative: number
}

export function multipleTestingReport(input: MultipleTestingInput): MultipleTestingReport {
  const base = {
    observedSharpe: input.observedSharpe,
    sampleLength: input.sampleLength,
    trialSharpeVariance: input.trialSharpeVariance,
    skew: input.skew,
    kurtosis: input.kurtosis,
  }
  const thisRound = deflatedSharpe({ ...base, trials: input.trialsThisRound })
  const cumulative = deflatedSharpe({ ...base, trials: input.trialsCumulative })

  // 보정 전 p값 — "샤프가 0을 넘을 확률"의 여집합.
  const psr0 = probabilisticSharpe(
    input.observedSharpe,
    0,
    input.sampleLength,
    input.skew ?? 0,
    input.kurtosis ?? 3,
  )
  const rawP = psr0 === null ? null : 1 - psr0
  const n = input.trialsCumulative
  const bonf = rawP === null || !(n >= 1) ? null : Math.min(1, rawP * n)
  const sidak = rawP === null || !(n >= 1) ? null : 1 - Math.pow(1 - rawP, n)

  let verdict: 'pass' | 'fail' | 'unknown'
  let headline: string
  if (cumulative.dsr === null) {
    verdict = 'unknown'
    headline = `누적 DSR 계산 불가 — ${cumulative.reason ?? '사유 없음'}`
  } else if (cumulative.dsr >= DSR_PASS_THRESHOLD) {
    verdict = 'pass'
    headline = `누적 ${n}회 시도를 감안해도 유의 (DSR ${cumulative.dsr.toFixed(3)} ≥ ${DSR_PASS_THRESHOLD})`
  } else {
    verdict = 'fail'
    headline = `누적 ${n}회 시도를 감안하면 유의하다고 말할 수 없다 (DSR ${cumulative.dsr.toFixed(3)} < ${DSR_PASS_THRESHOLD})`
  }

  return {
    thisRound,
    cumulative,
    trialsThisRound: input.trialsThisRound,
    trialsCumulative: input.trialsCumulative,
    rawPValue: rawP,
    bonferroniPValue: bonf,
    sidakPValue: sidak,
    verdict,
    headline,
  }
}

// ============================================================================
// 6. 통합 채점 — 세 지표를 한 번에
// ============================================================================

export interface OverfitScorecardInput {
  /** `matrix[변형][시점]` 수익률 행렬(이번 회차 전 변형). */
  matrix: number[][]
  /** 승자 변형 인덱스. 생략하면 전체 구간 샤프 1위를 쓴다. */
  winner?: number
  /** 누적 시도 수(회차 누적). 생략하면 이번 회차 변형 수. */
  trialsCumulative?: number
  /** 벤치마크 수익률 계열(시점 길이 동일). */
  benchmark?: number[]
  pbo?: PboOptions
  walkForward?: Partial<WalkForwardOptions>
  periodsPerYear?: number
}

export interface OverfitScorecard {
  winner: number | null
  multipleTesting: MultipleTestingReport | null
  pbo: PboResult
  walkForward: WalkForwardResult
  /** 세 지표를 종합한 한 줄 — 하나라도 경고면 경고가 이긴다. */
  headline: string
  reason: string | null
}

export function overfitScorecard(input: OverfitScorecardInput): OverfitScorecard {
  const matrix = input.matrix
  const nVariants = matrix.length
  const nObs = nVariants > 0 ? matrix[0].length : 0
  const ppy = input.periodsPerYear ?? 252

  const trialSharpes: number[] = []
  for (const row of matrix) {
    const s = sharpeMetric(row)
    if (s !== null) trialSharpes.push(s)
  }

  let winner = input.winner ?? null
  if (winner === null && trialSharpes.length > 0) {
    let best = -1
    let bestScore = -Infinity
    for (let v = 0; v < nVariants; v++) {
      const s = sharpeMetric(matrix[v])
      if (s === null) continue
      if (s > bestScore) {
        bestScore = s
        best = v
      }
    }
    winner = best >= 0 ? best : null
  }

  let mt: MultipleTestingReport | null = null
  if (winner !== null) {
    const m = sharpeMoments(matrix[winner])
    if (m.sharpe !== null) {
      mt = multipleTestingReport({
        observedSharpe: m.sharpe,
        sampleLength: m.sampleLength,
        trialSharpeVariance: variance(trialSharpes),
        skew: m.skew ?? undefined,
        kurtosis: m.kurtosis ?? undefined,
        trialsThisRound: nVariants,
        trialsCumulative: input.trialsCumulative ?? nVariants,
      })
    }
  }

  const pbo = computePbo(matrix, input.pbo)

  const wfIs = input.walkForward?.isWindow ?? Math.max(2, Math.floor(nObs * 0.5))
  const wfOos = input.walkForward?.oosWindow ?? Math.max(1, Math.floor(nObs * 0.1))
  const walkForward = walkForwardScore(matrix, {
    isWindow: wfIs,
    oosWindow: wfOos,
    metric: input.walkForward?.metric,
    periodsPerYear: ppy,
    benchmark: input.benchmark,
  })

  const flags: string[] = []
  if (mt?.verdict === 'fail') flags.push('DSR 미달')
  if (pbo.overfitLikely) flags.push(`PBO ${(pbo.pbo as number).toFixed(2)} > ${PBO_WARN_THRESHOLD}`)
  if (walkForward.oosAlphaPct !== null && walkForward.oosAlphaPct < 0) flags.push('워크포워드 OOS 알파 음수')

  const headline =
    flags.length > 0
      ? `⚠️ 과최적화 경고 — ${flags.join(' · ')}`
      : mt?.verdict === 'unknown' || pbo.pbo === null || walkForward.reason !== null
        ? '판정 불가 — 표본 부족(각 항목의 reason 확인)'
        : '세 지표 모두 경고 없음(그래도 라이브 검증 전에는 확정이 아니다)'

  return {
    winner,
    multipleTesting: mt,
    pbo,
    walkForward,
    headline,
    reason: winner === null ? '승자를 정할 수 없다 — 모든 변형의 샤프가 계산 불가' : null,
  }
}
