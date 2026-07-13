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

// Read a CSS variable at runtime so recharts colors follow light/dark theme.
export function cssVar(name: string): string {
  if (typeof window === 'undefined') return '#888'
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888'
}
