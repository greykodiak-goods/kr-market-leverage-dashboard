import type { DashboardData } from '../types'

// Composite "과열도" (overheating / greed) index 0-100.
// Higher = more leverage-driven greed/overheating; lower = fear/deleveraging.
// Each component is normalized against its own trailing 12-month range.

function last<T>(arr: T[]): T {
  return arr[arr.length - 1]
}

// Position of `v` within [min,max] of a series, clamped to 0..1.
function rangePos(values: number[], v: number): number {
  const min = Math.min(...values)
  const max = Math.max(...values)
  if (max === min) return 0.5
  return Math.max(0, Math.min(1, (v - min) / (max - min)))
}

export interface SentimentBreakdown {
  score: number // 0..100
  label: string
  components: { name: string; value: number; weight: number }[]
}

export function computeSentiment(data: DashboardData): SentimentBreakdown {
  const credit = data.credit.series.map((d) => d.total)
  const ratio = data.creditRatio.series.map((d) => d.value)
  const deposit = data.deposit.series.map((d) => d.value)
  const lending = data.lending.series.map((d) => d.value)
  const turnover = data.turnover.series.map((d) => d.value)

  // Each component in 0..100 where higher = more greed/overheating.
  const cCredit = rangePos(credit, last(credit)) * 100 // more credit = greedier
  const cRatio = rangePos(ratio, last(ratio)) * 100 // higher credit ratio = greedier
  const cTurnover = rangePos(turnover, last(turnover)) * 100 // more churn = greedier
  const cDeposit = rangePos(deposit, last(deposit)) * 100 // more waiting cash = greedier (buying power)
  const cLending = (1 - rangePos(lending, last(lending))) * 100 // more short lending = fear -> invert

  const components = [
    { name: '신용융자 잔고', value: cCredit, weight: 0.3 },
    { name: '신용잔고율', value: cRatio, weight: 0.25 },
    { name: '예탁금 회전율', value: cTurnover, weight: 0.2 },
    { name: '투자자예탁금', value: cDeposit, weight: 0.15 },
    { name: '대차잔고(역)', value: cLending, weight: 0.1 },
  ]

  const score = Math.round(components.reduce((s, c) => s + c.value * c.weight, 0))

  let label = '중립'
  if (score >= 80) label = '극단적 탐욕'
  else if (score >= 62) label = '탐욕'
  else if (score >= 45) label = '중립'
  else if (score >= 25) label = '공포'
  else label = '극단적 공포'

  return { score, label, components }
}
