// 수급 레이더 지표 계산 — 순수 함수만 (렌더·fetch와 분리, 기획서 Phase 0-1).
// 모든 판정은 "관찰 포인트"이며 매매 신호가 아니다.

// 말미 연속 부호 일수: +n = n일 연속 순매수, −n = n일 연속 순매도, 0 = 마지막이 0.
export function trailingStreak(values: number[]): number {
  if (!values.length) return 0
  const last = values[values.length - 1]
  if (last === 0) return 0
  const sign = last > 0 ? 1 : -1
  let n = 0
  for (let i = values.length - 1; i >= 0; i--) {
    if (values[i] * sign > 0) n++
    else break
  }
  return sign * n
}

// 최근 n개 합.
export function cumulative(values: number[], n: number): number {
  return values.slice(-n).reduce((s, v) => s + v, 0)
}

// 마지막 값의 z-score (직전 window개 기준). 표본 부족·표준편차 0이면 null.
export function lastZScore(values: number[], window: number): number | null {
  if (values.length < Math.min(window, 20)) return null
  const win = values.slice(-window)
  const mean = win.reduce((s, v) => s + v, 0) / win.length
  const sd = Math.sqrt(win.reduce((s, v) => s + (v - mean) ** 2, 0) / win.length)
  if (!sd) return null
  return (win[win.length - 1] - mean) / sd
}

// 쌍끌이 판정: 외인·기관 연속일수가 같은 방향으로 임계 이상일 때만 동반으로 본다.
export type TwinStatus = 'both-buy' | 'both-sell' | 'mixed'
export function twinStatus(foreignStreak: number, instStreak: number, threshold: number): { status: TwinStatus; days: number } {
  const days = Math.min(Math.abs(foreignStreak), Math.abs(instStreak))
  if (foreignStreak >= threshold && instStreak >= threshold) return { status: 'both-buy', days }
  if (foreignStreak <= -threshold && instStreak <= -threshold) return { status: 'both-sell', days }
  return { status: 'mixed', days: 0 }
}

// 단순이동평균 시리즈 (앞쪽 미충족 구간은 null) — 보유율 20·60일선용.
export function maSeries(values: number[], n: number): (number | null)[] {
  const out: (number | null)[] = []
  let sum = 0
  for (let i = 0; i < values.length; i++) {
    sum += values[i]
    if (i >= n) sum -= values[i - n]
    out.push(i >= n - 1 ? sum / n : null)
  }
  return out
}

// 20일 이동평균의 최근 기울기 → 추세 화살표 (신호 6 요약).
export function trendArrow(values: number[], n = 20, lookback = 5): '↗' | '→' | '↘' {
  const ma = maSeries(values, n)
  const last = ma[ma.length - 1]
  const prev = ma[ma.length - 1 - lookback]
  if (last == null || prev == null) return '→'
  const slope = last - prev
  // 보유율(%) 기준: 0.05%p/5일 미만 변화는 횡보로 취급
  if (slope > 0.05) return '↗'
  if (slope < -0.05) return '↘'
  return '→'
}

// 복합 경보(참고 표시용, 기획서 §1): 보유율 20일선 기울기 음(−) AND 외인 연속 순매도
// ≥ N일 AND 최근 순매도 강도가 표본 하위 분위(z ≤ −1). 임계값은 관행적 기준.
export function outflowAlert(opts: {
  holdRatios: number[]
  foreignStreak: number
  foreignZ: number | null
  threshold: number
}): boolean {
  const arrow = trendArrow(opts.holdRatios)
  return arrow === '↘' && opts.foreignStreak <= -opts.threshold && opts.foreignZ != null && opts.foreignZ <= -1
}
