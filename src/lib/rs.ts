import type { IntradayPoint } from './quotes'

export interface RsPoint {
  t: number
  rs: number
}

function lastPricePerDay(points: IntradayPoint[]): Map<string, number> {
  const m = new Map<string, number>()
  for (const p of points) {
    const day = new Date(p.t * 1000).toISOString().slice(0, 10)
    m.set(day, p.price) // points ascending → keeps last of the day
  }
  return m
}

// Relative strength of A vs B, normalized to 1.0 at the first common day.
// RS > 1 → A has outperformed B since the window start; rising RS → A gaining.
export function computeRelativeStrength(
  a: IntradayPoint[],
  b: IntradayPoint[],
): { series: RsPoint[]; latest: number; trend: 'up' | 'down' | 'flat' } {
  if (!a?.length || !b?.length) return { series: [], latest: 1, trend: 'flat' }
  const da = lastPricePerDay(a)
  const db = lastPricePerDay(b)
  const days = [...da.keys()].filter((d) => db.has(d)).sort()
  if (days.length < 2) return { series: [], latest: 1, trend: 'flat' }
  const a0 = da.get(days[0])!
  const b0 = db.get(days[0])!
  const series: RsPoint[] = days.map((d) => {
    const na = da.get(d)! / a0
    const nb = db.get(d)! / b0
    return { t: Date.parse(d) / 1000, rs: nb ? na / nb : 1 }
  })
  const latest = series[series.length - 1].rs
  const prev = series[Math.max(0, series.length - 10)].rs
  const trend = latest > prev * 1.005 ? 'up' : latest < prev * 0.995 ? 'down' : 'flat'
  return { series, latest, trend }
}
