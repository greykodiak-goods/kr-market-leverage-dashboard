// Technical indicators + statistical trend projection for reference only.
// NOT investment advice. Uses the validated `technicalindicators` library
// (no wheel reinvention) for SMA / RSI / Bollinger / MACD.

import { SMA, RSI, BollingerBands, MACD } from 'technicalindicators'

export interface Candle {
  t: number // epoch seconds
  price: number
}

// Align a right-anchored indicator output back to the full-length series (leading nulls).
function alignRight(len: number, calc: number[]): (number | null)[] {
  const out: (number | null)[] = new Array(len).fill(null)
  const offset = len - calc.length
  for (let i = 0; i < calc.length; i++) out[offset + i] = calc[i]
  return out
}

function std(values: number[]): number {
  if (values.length < 2) return 0
  const m = values.reduce((s, v) => s + v, 0) / values.length
  const v = values.reduce((s, x) => s + (x - m) ** 2, 0) / (values.length - 1)
  return Math.sqrt(v)
}

// Least-squares linear regression y = a + b*x over x = 0..n-1
function linreg(y: number[]): { a: number; b: number } {
  const n = y.length
  let sx = 0, sy = 0, sxx = 0, sxy = 0
  for (let i = 0; i < n; i++) {
    sx += i
    sy += y[i]
    sxx += i * i
    sxy += i * y[i]
  }
  const denom = n * sxx - sx * sx
  const b = denom === 0 ? 0 : (n * sxy - sx * sy) / denom
  const a = (sy - b * sx) / n
  return { a, b }
}

export interface ProjectionPoint {
  t: number
  mid: number
  upper: number
  lower: number
}

export interface IndicatorResult {
  closes: Candle[]
  sma: { period: number; value: number | null }[]
  smaSeries: Record<number, (number | null)[]> // for chart overlay
  rsi: number | null
  rsiState: '과매수 구간' | '과매도 구간' | '중립'
  bollinger: { upper: number; middle: number; lower: number; pctB: number | null } | null
  macd: { macd: number | null; signal: number | null; histogram: number | null; state: string }
  projection: ProjectionPoint[]
  projWindow: number
  projHorizon: number
  lastPrice: number
}

const SMA_PERIODS = [5, 20, 60, 120]

export function computeIndicators(candles: Candle[], horizon = 10): IndicatorResult | null {
  const closes = candles.filter((c) => Number.isFinite(c.price))
  const values = closes.map((c) => c.price)
  if (values.length < 30) return null
  const len = values.length
  const lastPrice = values[len - 1]

  const smaSeries: Record<number, (number | null)[]> = {}
  const sma = SMA_PERIODS.map((period) => {
    if (values.length < period) {
      smaSeries[period] = new Array(len).fill(null)
      return { period, value: null }
    }
    const calc = SMA.calculate({ period, values })
    const aligned = alignRight(len, calc)
    smaSeries[period] = aligned
    return { period, value: aligned[len - 1] }
  })

  const rsiCalc = RSI.calculate({ period: 14, values })
  const rsi = rsiCalc.length ? rsiCalc[rsiCalc.length - 1] : null
  const rsiState = rsi == null ? '중립' : rsi >= 70 ? '과매수 구간' : rsi <= 30 ? '과매도 구간' : '중립'

  const bbCalc = BollingerBands.calculate({ period: 20, stdDev: 2, values })
  const bbLast = bbCalc.length ? bbCalc[bbCalc.length - 1] : null
  const bollinger = bbLast
    ? {
        upper: bbLast.upper,
        middle: bbLast.middle,
        lower: bbLast.lower,
        pctB: bbLast.upper === bbLast.lower ? null : ((lastPrice - bbLast.lower) / (bbLast.upper - bbLast.lower)) * 100,
      }
    : null

  const macdCalc = MACD.calculate({
    values,
    fastPeriod: 12,
    slowPeriod: 26,
    signalPeriod: 9,
    SimpleMAOscillator: false,
    SimpleMASignal: false,
  })
  const macdLast = macdCalc.length ? macdCalc[macdCalc.length - 1] : null
  const macd = {
    macd: macdLast?.MACD ?? null,
    signal: macdLast?.signal ?? null,
    histogram: macdLast?.histogram ?? null,
    state:
      macdLast?.histogram == null
        ? '—'
        : macdLast.histogram > 0
          ? 'MACD > 시그널 (양(+) 히스토그램)'
          : 'MACD < 시그널 (음(−) 히스토그램)',
  }

  // Statistical trend projection: linear regression over last `projWindow`
  // closes extended `horizon` trading days, with a ±1σ volatility band derived
  // from the window's daily price-change standard deviation.
  const projWindow = Math.min(60, len)
  const windowVals = values.slice(len - projWindow)
  const { a, b } = linreg(windowVals)
  const dailyChanges: number[] = []
  for (let i = 1; i < windowVals.length; i++) dailyChanges.push(windowVals[i] - windowVals[i - 1])
  const sigma = std(dailyChanges)
  const lastT = closes[len - 1].t
  const projection: ProjectionPoint[] = []
  for (let k = 1; k <= horizon; k++) {
    const x = projWindow - 1 + k
    const mid = a + b * x
    const band = sigma * Math.sqrt(k)
    projection.push({ t: lastT + k * 86400, mid, upper: mid + band, lower: mid - band })
  }

  return {
    closes,
    sma,
    smaSeries,
    rsi,
    rsiState,
    bollinger,
    macd,
    projection,
    projWindow,
    projHorizon: horizon,
    lastPrice,
  }
}
