// Backtest simulator core types.
//
// Design constraint (look-ahead 차단): every value a strategy reads at bar i
// must be computable from bars[0..i] only. Signals decided at the close of bar
// i execute at the OPEN of bar i+1 — the simulator never peeks forward.

import type { DailyBar } from '../../lib/history'

export type { DailyBar }

// ---- Condition DSL --------------------------------------------------------
// An operand is a full-length series aligned to the bar index; value at i uses
// only data ≤ i (HIGHEST/LOWEST are shifted one bar back so "N일 신고가 돌파"
// compares today's close against the high of the *previous* N days).
export type OperandKind =
  | 'CLOSE'
  | 'SMA'
  | 'EMA'
  | 'RSI'
  | 'MACD_HIST'
  | 'BB_UPPER'
  | 'BB_MID'
  | 'BB_LOWER'
  | 'HIGHEST'
  | 'LOWEST'
  | 'CONST'

export interface Operand {
  kind: OperandKind
  period?: number // SMA/EMA/RSI/BB/HIGHEST/LOWEST
  value?: number // CONST only
}

export type CondOp = 'crossAbove' | 'crossBelow' | 'gt' | 'lt'

export interface Condition {
  left: Operand
  op: CondOp
  right: Operand
}

// Buy conditions are AND-combined (전부 충족 시 매수 신호).
// Sell conditions are OR-combined (하나라도 충족 시 매도 신호).
export interface StrategyConfig {
  id: string
  name: string
  desc: string
  buy: Condition[]
  sell: Condition[]
}

// ---- Simulation settings --------------------------------------------------
export interface SimSettings {
  initialCapital: number // KRW (or listing currency)
  positionPct: number // % of current equity committed per entry (포지션 사이징)
  commissionPct: number // per side, e.g. 0.015
  sellTaxPct: number // sell side only (KR 증권거래세), e.g. 0.15
  slippagePct: number // adverse fill assumption per side, e.g. 0.1
  stopLossPct: number | null // % below entry — null = no stop (비권장)
  takeProfitPct: number | null // % above entry — null = no take-profit
}

export const DEFAULT_SETTINGS: SimSettings = {
  initialCapital: 10_000_000,
  positionPct: 50,
  commissionPct: 0.015,
  sellTaxPct: 0.15,
  slippagePct: 0.1,
  stopLossPct: 8,
  takeProfitPct: null,
}

// ---- Results --------------------------------------------------------------
export type ExitReason = '조건 매도' | '손절' | '익절' | '보유중(미청산)'

export interface Trade {
  entryDate: string
  entryPrice: number // actual fill incl. slippage
  qty: number
  exitDate: string | null // null = still open at simulation end
  exitPrice: number | null
  pnl: number | null // net of all costs; for open trades = mark-to-market
  pnlPct: number | null
  reason: ExitReason
}

export interface EquityPoint {
  date: string
  equity: number
  benchmark: number // buy & hold with the same costs
  drawdownPct: number // strategy drawdown from running peak (≤ 0)
}

export interface SimMetrics {
  finalEquity: number
  totalReturnPct: number
  cagrPct: number
  mddPct: number // max drawdown, negative
  sharpe: number
  winRatePct: number // closed trades only
  tradeCount: number // closed trades
  profitFactor: number | null // null when no losing trade
  exposurePct: number // % of simulated days holding a position
  benchmarkReturnPct: number
  benchmarkMddPct: number
  days: number // simulated trading days
}

export interface SimResult {
  strategyId: string
  strategyName: string
  trades: Trade[]
  equity: EquityPoint[]
  metrics: SimMetrics
  startDate: string
  endDate: string
}
