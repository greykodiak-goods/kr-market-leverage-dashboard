import { format, parseISO } from 'date-fns'

export function tickDate(dateStr: string): string {
  try {
    return format(parseISO(dateStr), 'MM/dd')
  } catch {
    return dateStr
  }
}

export function tickDateLong(dateStr: string): string {
  try {
    return format(parseISO(dateStr), 'yyyy.MM.dd')
  } catch {
    return dateStr
  }
}

// Show roughly monthly ticks across a ~262-point business-day series.
export function monthlyTicks(dates: string[]): string[] {
  const ticks: string[] = []
  let lastMonth = ''
  for (const d of dates) {
    const m = d.slice(0, 7)
    if (m !== lastMonth) {
      ticks.push(d)
      lastMonth = m
    }
  }
  return ticks
}

function spanDays(dates: string[]): number {
  if (dates.length < 2) return 0
  try {
    return (parseISO(dates[dates.length - 1]).getTime() - parseISO(dates[0]).getTime()) / 86400000
  } catch {
    return 0
  }
}

// Pick tick dates adaptively based on the visible span:
//  - > ~3y: first data point of each year (limited to ~12 for readability)
//  - > ~6mo: first point of each month
//  - else: first point of each month (dense) — same as monthly
export function adaptiveTicks(dates: string[]): string[] {
  const span = spanDays(dates)
  if (span > 1100) {
    const ticks: string[] = []
    let lastYear = ''
    for (const d of dates) {
      const y = d.slice(0, 4)
      if (y !== lastYear) {
        ticks.push(d)
        lastYear = y
      }
    }
    // thin to <= ~14 labels
    if (ticks.length > 14) {
      const step = Math.ceil(ticks.length / 14)
      return ticks.filter((_, i) => i % step === 0)
    }
    return ticks
  }
  return monthlyTicks(dates)
}

// Formatter matching adaptiveTicks span.
export function adaptiveTickFormatter(dates: string[]): (d: string) => string {
  const span = spanDays(dates)
  if (span > 1100) return (d) => format(parseISO(d), 'yyyy')
  if (span > 200) return (d) => format(parseISO(d), 'yy.MM')
  return (d) => format(parseISO(d), 'MM/dd')
}

// Read a CSS variable at runtime so recharts colors follow light/dark theme.
export function cssVar(name: string): string {
  if (typeof window === 'undefined') return '#888'
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888'
}
