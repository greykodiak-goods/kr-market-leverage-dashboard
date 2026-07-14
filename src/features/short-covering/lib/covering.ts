// Derived short-covering metrics from lending / short-balance series.
// Observation math only — NOT trading signals. A declining lending balance
// suggests repayment (covering) but also includes hedge/arbitrage/LP borrowing,
// so a drop is never proof of covering on its own.

export interface DatedValue {
  date: string
  value: number
}

// Consecutive-decrease streak at the tail (# of days the value fell in a row).
export function streakDown(values: number[]): number {
  let s = 0
  for (let i = values.length - 1; i > 0; i--) {
    if (values[i] < values[i - 1]) s++
    else break
  }
  return s
}

// Net change over the last n steps: values[last] - values[last-n].
// Negative = balance decreased (repaid). Returns the raw signed delta.
export function netChange(values: number[], n: number): number {
  if (values.length < 2) return 0
  const last = values.length - 1
  const from = Math.max(0, last - n)
  return values[last] - values[from]
}

// Estimated cumulative repayment over last n steps = sum of daily decreases
// (positive number = amount repaid). Ledger-free estimate.
export function cumulativeCovered(values: number[], n: number): number {
  if (values.length < 2) return 0
  let sum = 0
  const start = Math.max(1, values.length - n)
  for (let i = start; i < values.length; i++) {
    const d = values[i] - values[i - 1]
    if (d < 0) sum += -d
  }
  return sum
}

export type Direction = 'cover' | 'newShort' | 'neutral'

// Direction from the signed sum of the last n daily deltas.
export function directionBadge(values: number[], n: number): Direction {
  if (values.length < 2) return 'neutral'
  const from = Math.max(0, values.length - 1 - n)
  const delta = values[values.length - 1] - values[from]
  const base = Math.abs(values[from]) || 1
  const pct = delta / base
  if (pct < -0.01) return 'cover'
  if (pct > 0.01) return 'newShort'
  return 'neutral'
}

// Sustained-decline segments as [from, to] date pairs, for shading "covering"
// runs with a ReferenceArea. Uses a `lookback` comparison (value[i] < value[i-lookback])
// rather than strict day-over-day, so day-to-day noise doesn't fragment the
// underlying downtrend. Only runs of at least `minRun` points are returned.
export function decreasingSegments(series: DatedValue[], lookback = 3, minRun = 5): { from: string; to: string }[] {
  const out: { from: string; to: string }[] = []
  if (series.length <= lookback) return out
  let runStart = -1
  for (let i = lookback; i < series.length; i++) {
    const down = series[i].value < series[i - lookback].value
    if (down) {
      if (runStart === -1) runStart = i
    } else {
      if (runStart !== -1 && i - runStart >= minRun) out.push({ from: series[runStart].date, to: series[i - 1].date })
      runStart = -1
    }
  }
  if (runStart !== -1 && series.length - runStart >= minRun) {
    out.push({ from: series[runStart].date, to: series[series.length - 1].date })
  }
  return out
}

// Per-point membership in a sustained-decline (covering) run — aligned to the
// input series. Used to paint covering segments green on the chart robustly
// (independent of recharts ReferenceArea quirks with time-scale axes).
export function coveringFlags(series: DatedValue[], lookback = 3, minRun = 5): boolean[] {
  const flags = new Array(series.length).fill(false)
  let runStart = -1
  const mark = (a: number, b: number) => {
    for (let k = a; k <= b; k++) flags[k] = true
  }
  for (let i = lookback; i < series.length; i++) {
    const down = series[i].value < series[i - lookback].value
    if (down) {
      if (runStart === -1) runStart = i
    } else {
      if (runStart !== -1 && i - runStart >= minRun) mark(runStart - 1 >= 0 ? runStart - 1 : runStart, i - 1)
      runStart = -1
    }
  }
  if (runStart !== -1 && series.length - runStart >= minRun) mark(runStart - 1 >= 0 ? runStart - 1 : runStart, series.length - 1)
  return flags
}

// Days-to-Cover = short-balance shares / average daily volume.
export function daysToCover(shortShares: number, avgVol: number): number | null {
  if (!avgVol || avgVol <= 0) return null
  return shortShares / avgVol
}

// % change of a series over the last n steps (for squeeze checks).
export function pctChangeOver(values: number[], n: number): number {
  if (values.length < 2) return 0
  const from = Math.max(0, values.length - 1 - n)
  const base = values[from]
  if (!base) return 0
  return ((values[values.length - 1] - base) / base) * 100
}

export interface SqueezeInput {
  lendingDrop5Pct: number // last-5d % change of lending (negative = drop)
  priceGain5Pct: number // last-5d % price change
  volRatio: number // latest volume / 20d avg volume
}
export interface SqueezeResult {
  met: boolean
  conditions: { lendingDrop: boolean; priceUp: boolean; volUp: boolean }
}

// Squeeze WATCH: only flagged when all three co-occur. Reference only.
export function squeezeWatch(inp: SqueezeInput): SqueezeResult {
  const lendingDrop = inp.lendingDrop5Pct <= -5
  const priceUp = inp.priceGain5Pct >= 5
  const volUp = inp.volRatio >= 1.5
  return { met: lendingDrop && priceUp && volUp, conditions: { lendingDrop, priceUp, volUp } }
}
