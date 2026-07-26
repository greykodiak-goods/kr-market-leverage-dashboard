// Operand → full-length aligned series. Uses the validated `technicalindicators`
// library (no wheel reinvention) for SMA/EMA/RSI/MACD/Bollinger; rolling
// HIGHEST/LOWEST are simple enough to compute inline.
//
// Look-ahead safety: every indicator here is causal — the value at index i is a
// function of bars[0..i] only. HIGHEST/LOWEST are additionally shifted one bar
// back (value at i = extreme of bars[i-N .. i-1]) so a breakout rule compares
// today against the *prior* N-day range, never including today's own bar.

import { SMA, EMA, RSI, MACD, BollingerBands } from 'technicalindicators'
import type { DailyBar, Operand } from './types'

export type Series = (number | null)[]

function alignRight(len: number, calc: number[]): Series {
  const out: Series = new Array(len).fill(null)
  const offset = len - calc.length
  for (let i = 0; i < calc.length; i++) out[offset + i] = calc[i]
  return out
}

function rollingExtreme(values: number[], period: number, kind: 'max' | 'min'): Series {
  const len = values.length
  const out: Series = new Array(len).fill(null)
  for (let i = 0; i < len; i++) {
    const from = i - period
    if (from < 0) continue // needs `period` bars strictly before i
    let ext = values[from]
    for (let j = from + 1; j < i; j++) {
      const v = values[j]
      ext = kind === 'max' ? Math.max(ext, v) : Math.min(ext, v)
    }
    out[i] = ext
  }
  return out
}

const cache = new WeakMap<DailyBar[], Map<string, Series>>()

function operandKey(op: Operand): string {
  return `${op.kind}:${op.period ?? ''}:${op.value ?? ''}`
}

export function operandSeries(bars: DailyBar[], op: Operand): Series {
  let byKey = cache.get(bars)
  if (!byKey) {
    byKey = new Map()
    cache.set(bars, byKey)
  }
  const key = operandKey(op)
  const hit = byKey.get(key)
  if (hit) return hit

  const len = bars.length
  const closes = bars.map((b) => b.c)
  const period = Math.max(1, Math.round(op.period ?? 14))
  let out: Series

  switch (op.kind) {
    case 'CLOSE':
      out = closes
      break
    case 'CONST':
      out = new Array(len).fill(op.value ?? 0)
      break
    case 'SMA':
      out = len >= period ? alignRight(len, SMA.calculate({ period, values: closes })) : new Array(len).fill(null)
      break
    case 'EMA':
      out = len >= period ? alignRight(len, EMA.calculate({ period, values: closes })) : new Array(len).fill(null)
      break
    case 'RSI':
      out = len > period ? alignRight(len, RSI.calculate({ period, values: closes })) : new Array(len).fill(null)
      break
    case 'MACD_HIST': {
      const calc = MACD.calculate({
        values: closes,
        fastPeriod: 12,
        slowPeriod: 26,
        signalPeriod: 9,
        SimpleMAOscillator: false,
        SimpleMASignal: false,
      })
      const hist = calc.map((m) => m.histogram ?? null)
      const out2: Series = new Array(len).fill(null)
      const offset = len - hist.length
      for (let i = 0; i < hist.length; i++) out2[offset + i] = hist[i]
      out = out2
      break
    }
    case 'BB_UPPER':
    case 'BB_MID':
    case 'BB_LOWER': {
      if (len < period) {
        out = new Array(len).fill(null)
        break
      }
      const calc = BollingerBands.calculate({ period, stdDev: 2, values: closes })
      const field = op.kind === 'BB_UPPER' ? 'upper' : op.kind === 'BB_MID' ? 'middle' : 'lower'
      out = alignRight(
        len,
        calc.map((b) => b[field]),
      )
      break
    }
    case 'HIGHEST':
      out = rollingExtreme(
        bars.map((b) => b.h),
        period,
        'max',
      )
      break
    case 'LOWEST':
      out = rollingExtreme(
        bars.map((b) => b.l),
        period,
        'min',
      )
      break
  }

  byKey.set(key, out)
  return out
}
