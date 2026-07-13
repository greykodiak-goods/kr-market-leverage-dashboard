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

// ---- time-scale axis helpers --------------------------------------------
// Leverage charts use a numeric time axis (scale="time") so uneven point
// density never distorts horizontal spacing.

export function toTs(dateStr: string): number {
  return parseISO(dateStr).getTime()
}

export function tsLong(ms: number): string {
  try {
    return format(new Date(ms), 'yyyy.MM.dd')
  } catch {
    return String(ms)
  }
}

// Explicit tick timestamps (ms) spread evenly by real time.
export function timeAxisTicks(dates: string[]): number[] {
  if (dates.length < 2) return dates.map(toTs)
  const firstTs = toTs(dates[0])
  const lastTs = toTs(dates[dates.length - 1])
  const span = (lastTs - firstTs) / 86400000
  const ticks: number[] = []
  if (span > 1100) {
    const firstYear = new Date(firstTs).getUTCFullYear()
    const lastYear = new Date(lastTs).getUTCFullYear()
    for (let y = firstYear; y <= lastYear; y++) {
      const t = Date.UTC(y, 0, 1)
      if (t >= firstTs && t <= lastTs) ticks.push(t)
    }
    if (ticks.length > 14) {
      const step = Math.ceil(ticks.length / 14)
      return ticks.filter((_, i) => i % step === 0)
    }
    return ticks
  }
  if (span > 200) {
    const d = new Date(firstTs)
    let cursor = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)
    while (cursor <= lastTs) {
      if (cursor >= firstTs) ticks.push(cursor)
      const nd = new Date(cursor)
      cursor = Date.UTC(nd.getUTCFullYear(), nd.getUTCMonth() + 1, 1)
    }
    return ticks
  }
  // short span: monthly-ish from the actual points
  let lastMonth = ''
  for (const ds of dates) {
    const m = ds.slice(0, 7)
    if (m !== lastMonth) {
      ticks.push(toTs(ds))
      lastMonth = m
    }
  }
  return ticks
}

export function timeTickFormatter(dates: string[]): (ms: number) => string {
  if (dates.length < 2) return (ms) => format(new Date(ms), 'yyyy')
  const span = (toTs(dates[dates.length - 1]) - toTs(dates[0])) / 86400000
  if (span > 1100) return (ms) => format(new Date(ms), 'yyyy')
  if (span > 200) return (ms) => format(new Date(ms), 'yy.MM')
  return (ms) => format(new Date(ms), 'MM/dd')
}

// Read a CSS variable at runtime so recharts colors follow light/dark theme.
export function cssVar(name: string): string {
  if (typeof window === 'undefined') return '#888'
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888'
}
