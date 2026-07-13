import { parseISO, subYears } from 'date-fns'

// Leverage-chart period options (sample data spans ~20 years).
export type LeveragePeriod = '1Y' | '5Y' | '10Y' | '20Y' | 'MAX'
export const LEVERAGE_PERIODS: LeveragePeriod[] = ['1Y', '5Y', '10Y', '20Y', 'MAX']

const YEARS: Record<LeveragePeriod, number | null> = {
  '1Y': 1,
  '5Y': 5,
  '10Y': 10,
  '20Y': 20,
  MAX: null,
}

// Slice a date-keyed series to the selected trailing period, measured from the
// last available data point (not "now") so sample/live both behave.
export function filterByPeriod<T extends { date: string }>(series: T[], period: LeveragePeriod): T[] {
  if (!series.length) return series
  const years = YEARS[period]
  if (years == null) return series
  const last = parseISO(series[series.length - 1].date)
  const cutoff = subYears(last, years)
  return series.filter((d) => parseISO(d.date) >= cutoff)
}
