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

import type { Condition, DailyBar, EquityPoint, SimResult, SimSettings, StrategyConfig, Trade } from './types'
import { operandSeries, type Series } from './series'
import { computeMetrics, initBenchmark } from './metrics'

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
  const { bhQty, bhCash } = initBenchmark(bars[startIdx].o, settings.initialCapital, settings.commissionPct, settings.slippagePct)

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

  const metrics = computeMetrics(equity, trades, settings.initialCapital, daysHolding)

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
