// Shared result-metrics computation for both engines (rule-based / algorithmic)
// so every model is scored on identical definitions.

import type { EquityPoint, SimMetrics, Trade } from './types'

function stdev(xs: number[]): number {
  if (xs.length < 2) return 0
  const m = xs.reduce((s, v) => s + v, 0) / xs.length
  return Math.sqrt(xs.reduce((s, v) => s + (v - m) ** 2, 0) / (xs.length - 1))
}

// Buy & hold with the same entry costs, from the first simulated open.
export function initBenchmark(openPrice: number, initialCapital: number, commPct: number, slipPct: number) {
  const fill = openPrice * (1 + slipPct / 100)
  const bhQty = Math.floor(initialCapital / (fill * (1 + commPct / 100)))
  const bhCash = initialCapital - bhQty * fill * (1 + commPct / 100)
  return { bhQty, bhCash }
}

export function computeMetrics(
  equity: EquityPoint[],
  trades: Trade[],
  initialCapital: number,
  daysHolding: number,
): SimMetrics {
  const days = equity.length
  const finalEquity = equity[days - 1].equity
  const totalReturnPct = (finalEquity / initialCapital - 1) * 100
  const years = days / 252
  const cagrPct = years > 0 ? (Math.pow(finalEquity / initialCapital, 1 / years) - 1) * 100 : 0
  let mddPct = 0
  for (const e of equity) mddPct = Math.min(mddPct, e.drawdownPct)

  const dailyRets: number[] = []
  for (let i = 1; i < days; i++) dailyRets.push(equity[i].equity / equity[i - 1].equity - 1)
  const meanRet = dailyRets.length ? dailyRets.reduce((s, v) => s + v, 0) / dailyRets.length : 0
  const sd = stdev(dailyRets)
  const sharpe = sd > 0 ? (meanRet / sd) * Math.sqrt(252) : 0

  const closed = trades.filter((t) => t.exitDate != null)
  const wins = closed.filter((t) => (t.pnl ?? 0) > 0)
  const grossWin = wins.reduce((s, t) => s + (t.pnl ?? 0), 0)
  const grossLoss = closed.filter((t) => (t.pnl ?? 0) <= 0).reduce((s, t) => s + Math.abs(t.pnl ?? 0), 0)

  let bhPeak = 0
  let bhMdd = 0
  for (const e of equity) {
    bhPeak = Math.max(bhPeak, e.benchmark)
    if (bhPeak > 0) bhMdd = Math.min(bhMdd, ((e.benchmark - bhPeak) / bhPeak) * 100)
  }

  return {
    finalEquity,
    totalReturnPct,
    cagrPct,
    mddPct,
    sharpe,
    winRatePct: closed.length ? (wins.length / closed.length) * 100 : 0,
    tradeCount: closed.length,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
    exposurePct: (daysHolding / days) * 100,
    benchmarkReturnPct: (equity[days - 1].benchmark / initialCapital - 1) * 100,
    benchmarkMddPct: bhMdd,
    days,
  }
}
