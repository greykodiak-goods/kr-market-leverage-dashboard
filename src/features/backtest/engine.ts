// Walk-forward backtest engine.
//
// Time discipline (미래 정보 차단):
//  · Conditions are evaluated at the CLOSE of bar i using series values ≤ i.
//  · A signal from bar i becomes a market order filled at the OPEN of bar i+1
//    (slippage applied against the trader).
//  · Stop-loss / take-profit fire intraday off bar high/low; a gap through the
//    level fills at the open (i.e. worse), never at the level itself.
//  · The final bar never generates a new entry; an open position is kept and
//    marked to market ("보유중(미청산)").
//
// This is a single-position, long-only simulator. 공매도·레버리지 미지원.

import type {
  Condition,
  DailyBar,
  EquityPoint,
  SimMetrics,
  SimResult,
  SimSettings,
  StrategyConfig,
  Trade,
} from './types'
import { operandSeries, type Series } from './series'

interface CompiledCondition {
  left: Series
  right: Series
  op: Condition['op']
}

function compile(bars: DailyBar[], conds: Condition[]): CompiledCondition[] {
  return conds.map((c) => ({
    left: operandSeries(bars, c.left),
    right: operandSeries(bars, c.right),
    op: c.op,
  }))
}

function holds(c: CompiledCondition, i: number): boolean {
  const l = c.left[i]
  const r = c.right[i]
  if (l == null || r == null) return false
  switch (c.op) {
    case 'gt':
      return l > r
    case 'lt':
      return l < r
    case 'crossAbove': {
      const lp = i > 0 ? c.left[i - 1] : null
      const rp = i > 0 ? c.right[i - 1] : null
      return lp != null && rp != null && lp <= rp && l > r
    }
    case 'crossBelow': {
      const lp = i > 0 ? c.left[i - 1] : null
      const rp = i > 0 ? c.right[i - 1] : null
      return lp != null && rp != null && lp >= rp && l < r
    }
  }
}

function stdev(xs: number[]): number {
  if (xs.length < 2) return 0
  const m = xs.reduce((s, v) => s + v, 0) / xs.length
  return Math.sqrt(xs.reduce((s, v) => s + (v - m) ** 2, 0) / (xs.length - 1))
}

export function runBacktest(
  bars: DailyBar[],
  startIdx: number,
  strategy: StrategyConfig,
  settings: SimSettings,
): SimResult {
  const n = bars.length
  if (startIdx < 1 || startIdx >= n - 1) throw new Error('시뮬레이션 시작 시점이 데이터 범위를 벗어났습니다')

  const buyConds = compile(bars, strategy.buy)
  const sellConds = compile(bars, strategy.sell)

  const comm = settings.commissionPct / 100
  const tax = settings.sellTaxPct / 100
  const slip = settings.slippagePct / 100
  const posFrac = Math.min(100, Math.max(1, settings.positionPct)) / 100

  let cash = settings.initialCapital
  let qty = 0
  let entryFill = 0 // fill price incl. slippage
  let entryCost = 0 // total cash spent incl. commission
  let entryDate = ''
  let stopPrice: number | null = null
  let tpPrice: number | null = null

  let pendingBuy = false
  let pendingSell = false

  const trades: Trade[] = []
  const equity: EquityPoint[] = []
  let daysHolding = 0

  // Benchmark: buy & hold from the first simulated open, same costs.
  const bhFill = bars[startIdx].o * (1 + slip)
  const bhQty = Math.floor(settings.initialCapital / (bhFill * (1 + comm)))
  const bhCash = settings.initialCapital - bhQty * bhFill * (1 + comm)

  function closeTrade(exitDate: string, rawExit: number, reason: Trade['reason'], applySlip: boolean) {
    const fill = applySlip ? rawExit * (1 - slip) : rawExit
    const proceeds = qty * fill * (1 - comm - tax)
    cash += proceeds
    const pnl = proceeds - entryCost
    trades.push({
      entryDate,
      entryPrice: entryFill,
      qty,
      exitDate,
      exitPrice: fill,
      pnl,
      pnlPct: (pnl / entryCost) * 100,
      reason,
    })
    qty = 0
    stopPrice = null
    tpPrice = null
  }

  let peak = settings.initialCapital

  for (let i = startIdx; i < n; i++) {
    const bar = bars[i]

    // 1) Fill pending orders from yesterday's close at today's open.
    if (pendingSell && qty > 0) {
      closeTrade(bar.date, bar.o, '조건 매도', true)
    }
    if (pendingBuy && qty === 0 && i < n - 1) {
      const equityNow = cash // flat here, so equity == cash
      const budget = Math.min(cash, equityNow * posFrac)
      const fill = bar.o * (1 + slip)
      const q = Math.floor(budget / (fill * (1 + comm)))
      if (q >= 1) {
        qty = q
        entryFill = fill
        entryCost = q * fill * (1 + comm)
        cash -= entryCost
        entryDate = bar.date
        stopPrice = settings.stopLossPct != null ? fill * (1 - settings.stopLossPct / 100) : null
        tpPrice = settings.takeProfitPct != null ? fill * (1 + settings.takeProfitPct / 100) : null
      }
    }
    pendingBuy = false
    pendingSell = false

    // 2) Intraday stop / take-profit (stop first — conservative when both hit).
    if (qty > 0 && stopPrice != null && bar.l <= stopPrice) {
      const raw = bar.o <= stopPrice ? bar.o : stopPrice // gap through → open (worse)
      closeTrade(bar.date, raw, '손절', true)
    } else if (qty > 0 && tpPrice != null && bar.h >= tpPrice) {
      const raw = bar.o >= tpPrice ? bar.o : tpPrice
      closeTrade(bar.date, raw, '익절', false)
    }

    // 3) Evaluate signals at today's close → orders for tomorrow's open.
    if (i < n - 1) {
      if (qty === 0) {
        pendingBuy = strategy.buy.length > 0 && buyConds.every((c) => holds(c, i))
      } else {
        pendingSell = sellConds.some((c) => holds(c, i))
      }
    }

    // 4) Mark to market.
    if (qty > 0) daysHolding++
    const eq = cash + qty * bar.c
    peak = Math.max(peak, eq)
    equity.push({
      date: bar.date,
      equity: eq,
      benchmark: bhCash + bhQty * bar.c,
      drawdownPct: peak > 0 ? ((eq - peak) / peak) * 100 : 0,
    })
  }

  // Open position at the end → record as unresolved, marked to market.
  if (qty > 0) {
    const last = bars[n - 1]
    const mtm = qty * last.c * (1 - comm - tax) - entryCost
    trades.push({
      entryDate,
      entryPrice: entryFill,
      qty,
      exitDate: null,
      exitPrice: null,
      pnl: mtm,
      pnlPct: (mtm / entryCost) * 100,
      reason: '보유중(미청산)',
    })
  }

  // ---- Metrics ----
  const days = equity.length
  const finalEquity = equity[days - 1].equity
  const totalReturnPct = (finalEquity / settings.initialCapital - 1) * 100
  const years = days / 252
  const cagrPct = years > 0 ? (Math.pow(finalEquity / settings.initialCapital, 1 / years) - 1) * 100 : 0
  const mddPct = Math.min(0, ...equity.map((e) => e.drawdownPct))

  const dailyRets: number[] = []
  for (let i = 1; i < days; i++) dailyRets.push(equity[i].equity / equity[i - 1].equity - 1)
  const meanRet = dailyRets.length ? dailyRets.reduce((s, v) => s + v, 0) / dailyRets.length : 0
  const sd = stdev(dailyRets)
  const sharpe = sd > 0 ? (meanRet / sd) * Math.sqrt(252) : 0

  const closed = trades.filter((t) => t.exitDate != null)
  const wins = closed.filter((t) => (t.pnl ?? 0) > 0)
  const grossWin = wins.reduce((s, t) => s + (t.pnl ?? 0), 0)
  const grossLoss = closed.filter((t) => (t.pnl ?? 0) <= 0).reduce((s, t) => s + Math.abs(t.pnl ?? 0), 0)

  const bhFinal = equity[days - 1].benchmark
  let bhPeak = 0
  let bhMdd = 0
  for (const e of equity) {
    bhPeak = Math.max(bhPeak, e.benchmark)
    if (bhPeak > 0) bhMdd = Math.min(bhMdd, ((e.benchmark - bhPeak) / bhPeak) * 100)
  }

  const metrics: SimMetrics = {
    finalEquity,
    totalReturnPct,
    cagrPct,
    mddPct,
    sharpe,
    winRatePct: closed.length ? (wins.length / closed.length) * 100 : 0,
    tradeCount: closed.length,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
    exposurePct: (daysHolding / days) * 100,
    benchmarkReturnPct: (bhFinal / settings.initialCapital - 1) * 100,
    benchmarkMddPct: bhMdd,
    days,
  }

  return {
    strategyId: strategy.id,
    strategyName: strategy.name,
    trades,
    equity,
    metrics,
    startDate: bars[startIdx].date,
    endDate: bars[n - 1].date,
  }
}
