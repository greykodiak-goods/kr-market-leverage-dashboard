import { parseISO, subMonths, subYears } from 'date-fns'

// Leverage-chart period options (sample data spans ~20 years, daily for the
// recent 6 years). Short options first so day-level detail is the default.
export type LeveragePeriod = '1M' | '3M' | '6M' | '1Y' | '5Y' | '10Y' | '20Y' | 'MAX'
export const LEVERAGE_PERIODS: LeveragePeriod[] = ['1M', '3M', '6M', '1Y', '5Y', '10Y', '20Y', 'MAX']

const MONTHS: Record<LeveragePeriod, number | null> = {
  '1M': 1,
  '3M': 3,
  '6M': 6,
  '1Y': 12,
  '5Y': 60,
  '10Y': 120,
  '20Y': 240,
  MAX: null,
}

// Slice a date-keyed series to the selected trailing period, measured from the
// last available data point (not "now") so sample/live both behave.
export function filterByPeriod<T extends { date: string }>(series: T[], period: LeveragePeriod): T[] {
  if (!series.length) return series
  const months = MONTHS[period]
  if (months == null) return series
  const last = parseISO(series[series.length - 1].date)
  const cutoff = months >= 12 ? subYears(last, months / 12) : subMonths(last, months)
  return series.filter((d) => parseISO(d.date) >= cutoff)
}

// Filter + downsample for display: keeps day-level detail for <=~400 points
// (1M~1Y) and thins longer spans (5Y/10Y/20Y/MAX) for render performance,
// always preserving the final point.
export function sliceForPeriod<T extends { date: string }>(series: T[], period: LeveragePeriod, target = 420): T[] {
  const sliced = filterByPeriod(series, period)
  if (sliced.length <= target) return sliced
  const step = Math.ceil(sliced.length / target)
  const out = sliced.filter((_, i) => i % step === 0)
  const last = sliced[sliced.length - 1]
  if (out[out.length - 1] !== last) out.push(last)
  return out
}
