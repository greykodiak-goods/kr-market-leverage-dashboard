// Engine smoke test — synthetic bars with known outcomes.
import { check, finish } from './harness'
import { runBacktest } from '../src/features/backtest/engine'
import { DEFAULT_SETTINGS, type StrategyConfig } from '../src/features/backtest/types'
import type { DailyBar } from '../src/lib/history'

function bar(i: number, o: number, h: number, l: number, c: number): DailyBar {
  const d = new Date(Date.UTC(2020, 0, 1) + i * 86400000)
  return { date: d.toISOString().slice(0, 10), t: 0, o, h, l, c, v: 1000 }
}

// --- Test 1: SMA(2)xSMA(4) cross on a V-shaped series; verify next-open fill ---
const prices1 = [100, 98, 96, 94, 92, 90, 88, 86, 84, 82, 80, 82, 85, 89, 94, 100, 106, 112, 118, 124, 130, 128, 124, 118, 110, 102, 94, 86, 80, 76]
const bars1 = prices1.map((p, i) => bar(i, p, p * 1.01, p * 0.99, p))
const strat1: StrategyConfig = {
  id: 't1', name: 't1', desc: '',
  buy: [{ left: { kind: 'SMA', period: 2 }, op: 'crossAbove', right: { kind: 'SMA', period: 4 } }],
  sell: [{ left: { kind: 'SMA', period: 2 }, op: 'crossBelow', right: { kind: 'SMA', period: 4 } }],
}
const s1 = { ...DEFAULT_SETTINGS, positionPct: 100, commissionPct: 0, sellTaxPct: 0, slippagePct: 0, stopLossPct: null, takeProfitPct: null }
const r1 = runBacktest(bars1, 5, strat1, s1)
check('t1 at least 1 trade', r1.trades.length >= 1, JSON.stringify(r1.trades))
// Manually find cross: SMA2[i] > SMA4[i] first at the upturn. Entry must be the NEXT bar's date/open.
if (r1.trades.length) {
  const t = r1.trades[0]
  const entryIdx = bars1.findIndex((b) => b.date === t.entryDate)
  check('t1 entry uses next-bar open', t.entryPrice === bars1[entryIdx].o, `entry ${t.entryPrice} vs open ${bars1[entryIdx]?.o}`)
  // signal bar = entryIdx-1: verify cross condition held there and NOT at entryIdx-2
  const sma = (i: number, p: number) => prices1.slice(i - p + 1, i + 1).reduce((a, b) => a + b, 0) / p
  const sig = entryIdx - 1
  check('t1 cross held at signal bar', sma(sig, 2) > sma(sig, 4) && sma(sig - 1, 2) <= sma(sig - 1, 4))
}
check('t1 equity length', r1.equity.length === bars1.length - 5)

// --- Test 2: stop-loss fires at stop price ---
const prices2: number[] = []
for (let i = 0; i < 12; i++) prices2.push(100 + i) // rising → buy
const bars2 = prices2.map((p, i) => bar(i, p, p + 1, p - 1, p))
// crash bar: open 111, low 80
bars2.push(bar(12, 111, 111, 80, 85))
bars2.push(bar(13, 85, 86, 84, 85))
const strat2: StrategyConfig = {
  id: 't2', name: 't2', desc: '',
  buy: [{ left: { kind: 'CLOSE' }, op: 'gt', right: { kind: 'SMA', period: 3 } }],
  sell: [],
}
const s2 = { ...s1, stopLossPct: 10 }
const r2 = runBacktest(bars2, 4, strat2, s2)
const stopTrade = r2.trades.find((t) => t.reason === '손절')
check('t2 stop-loss triggered', !!stopTrade)
if (stopTrade) {
  const expectedStop = stopTrade.entryPrice * 0.9
  check('t2 stop fill = stop price', Math.abs((stopTrade.exitPrice ?? 0) - expectedStop) < 1e-9, `exit ${stopTrade.exitPrice} vs ${expectedStop}`)
}

// --- Test 3: costs reduce PnL; buy&hold benchmark math ---
const s3 = { ...s1, commissionPct: 0.1, sellTaxPct: 0.2, slippagePct: 0.1 }
const r3 = runBacktest(bars1, 5, strat1, s3)
check('t3 with costs final < without costs', r3.metrics.finalEquity < r1.metrics.finalEquity, `${r3.metrics.finalEquity} vs ${r1.metrics.finalEquity}`)
const bh0 = bars1[5].o * 1.001
const bhQty = Math.floor(10_000_000 / (bh0 * 1.001))
const bhExpected = 10_000_000 - bhQty * bh0 * 1.001 + bhQty * bars1[bars1.length - 1].c
check('t3 benchmark math', Math.abs(r3.equity[r3.equity.length - 1].benchmark - bhExpected) < 1e-6)

// --- Test 4: no trades when buy conditions empty ---
const r4 = runBacktest(bars1, 5, { id: 't4', name: 't4', desc: '', buy: [], sell: [] }, s1)
check('t4 no-condition = no trades, equity flat', r4.trades.length === 0 && r4.metrics.finalEquity === s1.initialCapital)

// --- Test 5: look-ahead probe — truncating future data must not change past signals ---
const full = runBacktest(bars1, 5, strat1, s1)
const truncBars = bars1.slice(0, 20)
const trunc = runBacktest(truncBars, 5, strat1, s1)
const fullTradesInWindow = full.trades.filter((t) => t.entryDate <= truncBars[17].date).map((t) => t.entryDate)
const truncTrades = trunc.trades.filter((t) => t.entryDate <= truncBars[17].date).map((t) => t.entryDate)
check('t5 truncation invariance (no look-ahead)', JSON.stringify(fullTradesInWindow) === JSON.stringify(truncTrades), `${fullTradesInWindow} vs ${truncTrades}`)

finish()
