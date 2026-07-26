// 무한매수법 · VR 엔진 스모크 테스트 — 알려진 결과의 합성 시나리오로 검증.
import { check, finish } from './harness'
import { runInfiniteBuying, runValueRebalancing, DEFAULT_IB_PARAMS, DEFAULT_VR_PARAMS } from '../src/features/backtest/algoEngine'
import { DEFAULT_SETTINGS } from '../src/features/backtest/types'
import type { DailyBar } from '../src/lib/history'

function bar(i: number, o: number, h: number, l: number, c: number): DailyBar {
  const d = new Date(Date.UTC(2020, 0, 1) + i * 86400000)
  return { date: d.toISOString().slice(0, 10), t: 0, o, h, l, c, v: 1000 }
}
const NO_COST = { ...DEFAULT_SETTINGS, commissionPct: 0, sellTaxPct: 0, slippagePct: 0, initialCapital: 1_000_000 }

// ===== 무한매수법 =====
// 시나리오: 평평한 100 → 8일 후 고가 115 스파이크 (목표 110 도달)
const ibBars: DailyBar[] = []
for (let i = 0; i < 10; i++) ibBars.push(bar(i, 100, 100, 100, 100))
ibBars.push(bar(10, 100, 115, 100, 112)) // 스파이크: 목표 110 체결돼야 함
for (let i = 11; i < 14; i++) ibBars.push(bar(i, 100, 100, 100, 100))

const ib1 = runInfiniteBuying(ibBars, 2, { splits: 40, targetPct: 10, cycleStopPct: null }, NO_COST)
check('IB 사이클 매도 발생', ib1.trades.some((t) => t.reason === '사이클 목표매도'))
const ibTrade = ib1.trades.find((t) => t.reason === '사이클 목표매도')
if (ibTrade) {
  check('IB 청산가 = 목표가 110 (평단100×1.10)', Math.abs((ibTrade.exitPrice ?? 0) - 110) < 1e-9, `exit ${ibTrade.exitPrice}`)
  check('IB 수익률 ≈ +10%', Math.abs((ibTrade.pnlPct ?? 0) - 10) < 0.01, `${ibTrade.pnlPct}`)
  check('IB 평단 = 100', Math.abs(ibTrade.entryPrice - 100) < 1e-9)
}
// 매수 패턴: 첫날 1회분(25,000), 이후 flat(close==avg, 평단매수 미체결)엔 0.5회분만
const buysByDay = new Map<string, number>()
for (const ev of ib1.events ?? []) {
  if (ev.action === '매수') buysByDay.set(ev.date, (buysByDay.get(ev.date) ?? 0) + ev.qty * ev.price)
}
const day0Spend = buysByDay.get(ibBars[2].date) ?? 0
const day1Spend = buysByDay.get(ibBars[3].date) ?? 0
check('IB 첫날 1회분(≈25,000) 매수', Math.abs(day0Spend - 25000) < 200, `${day0Spend}`)
check('IB 이후 평평구간 0.5회분(≈12,500)만', Math.abs(day1Spend - 12500) < 200, `${day1Spend}`)

// 자금 보존(무비용): 최종 자산 = 초기 + 실현손익 합 (전량 청산 상태)
const lastEq = ib1.equity[ib1.equity.length - 1]
const realized = ib1.trades.reduce((s, t) => s + (t.pnl ?? 0), 0)
check('IB 자금 보존', Math.abs(lastEq.equity - (NO_COST.initialCapital + realized)) < 1, `${lastEq.equity} vs ${NO_COST.initialCapital + realized}`)

// 하락장: 평단매수로 하루 1회분씩 소진 → 40회분 소진 후 매수 중단, 현금 ≥ 0
const dnBars: DailyBar[] = []
let p = 100
for (let i = 0; i < 80; i++) { dnBars.push(bar(i, p, p, p * 0.99, p * 0.995)); p *= 0.995 }
const ib2 = runInfiniteBuying(dnBars, 2, { splits: 40, targetPct: 10, cycleStopPct: null }, NO_COST)
check('IB 하락장 현금 ≥ 0', ib2.equity.every((e) => Number.isFinite(e.equity)) && ib2.metrics.finalEquity > 0)
const totalBuySpend = (ib2.events ?? []).filter((e) => e.action === '매수').reduce((s, e) => s + e.qty * e.price, 0)
check('IB 총 매수 ≤ 원금', totalBuySpend <= NO_COST.initialCapital + 1, `${totalBuySpend}`)
const openTrade = ib2.trades.find((t) => t.reason === '보유중(미청산)')
check('IB 하락장 미청산 보유 기록', !!openTrade && (openTrade.pnlPct ?? 0) < 0)

// 사이클 손절 옵션
const ib3 = runInfiniteBuying(dnBars, 2, { splits: 40, targetPct: 10, cycleStopPct: 10 }, NO_COST)
check('IB 사이클 손절 동작', ib3.trades.some((t) => t.reason === '사이클 손절'))

// 절단 불변성 (미래 미참조)
const ibFull = runInfiniteBuying(dnBars, 2, DEFAULT_IB_PARAMS, NO_COST)
const ibTrunc = runInfiniteBuying(dnBars.slice(0, 50), 2, DEFAULT_IB_PARAMS, NO_COST)
const evF = (ibFull.events ?? []).filter((e) => e.date <= dnBars[47].date)
const evT = (ibTrunc.events ?? []).filter((e) => e.date <= dnBars[47].date)
check('IB 절단 불변성', JSON.stringify(evF) === JSON.stringify(evT))

// ===== VR =====
// 평평한 100, 무비용: 돈 보존 — 매일 equity == 초기자본. V 성장으로 하단 이탈 매수 발생, 현금 ≥ 0
const flat: DailyBar[] = []
for (let i = 0; i < 400; i++) flat.push(bar(i, 100, 100, 100, 100))
const vr1 = runValueRebalancing(flat, 2, { periodDays: 10, growthPct: 1, bandPct: 15, initialStockPct: 75 }, NO_COST)
check('VR 무비용 평평 = 자금 보존', vr1.equity.every((e) => Math.abs(e.equity - NO_COST.initialCapital) < 1))
check('VR 하단 매수 발생', (vr1.events ?? []).some((e) => e.action === '매수' && e.note.includes('하단')))
// 현금 음수 불가 검증: 이벤트 재생
{
  let cash = NO_COST.initialCapital, q = 0, ok = true
  for (const ev of vr1.events ?? []) {
    if (ev.action === '매수') { cash -= ev.qty * ev.price; q += ev.qty } else { cash += ev.qty * ev.price; q -= ev.qty }
    if (cash < -1e-6 || q < 0) ok = false
  }
  check('VR 현금·수량 음수 없음', ok, `cash ${cash}`)
}

// 급등장: 상단 초과 매도 발생
const upBars: DailyBar[] = []
p = 100
for (let i = 0; i < 100; i++) { upBars.push(bar(i, p, p * 1.01, p, p * 1.01)); p *= 1.01 }
const vr2 = runValueRebalancing(upBars, 2, DEFAULT_VR_PARAMS, NO_COST)
check('VR 상단 매도 발생', (vr2.events ?? []).some((e) => e.action === '매도'))
check('VR 지표 정상', Number.isFinite(vr2.metrics.totalReturnPct) && vr2.metrics.tradeCount === 0)

// 절단 불변성
const vrFull = runValueRebalancing(flat, 2, DEFAULT_VR_PARAMS, NO_COST)
const vrTrunc = runValueRebalancing(flat.slice(0, 300), 2, DEFAULT_VR_PARAMS, NO_COST)
const vf = (vrFull.events ?? []).filter((e) => e.date <= flat[297].date)
const vt = (vrTrunc.events ?? []).filter((e) => e.date <= flat[297].date)
check('VR 절단 불변성', JSON.stringify(vf) === JSON.stringify(vt))

finish()
