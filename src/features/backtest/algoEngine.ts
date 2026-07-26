// 자금관리형(알고리즘) 전략 엔진 — 라오어 무한매수법 · VR(밸류 리밸런싱).
//
// 규칙 기반 엔진과 동일한 워크포워드 규율을 따른다:
//  · 시점 i의 모든 판단은 bars[0..i]만 사용 (미래 미참조).
//  · 매수는 LOC(종가 지정가) 성격이므로 당일 종가 체결(+슬리피지·수수료).
//  · 목표가 매도는 지정가 — 당일 고가가 목표가에 닿으면 목표가(갭상승 시
//    시가) 체결. 수수료·거래세 반영.
//  · 설정의 진입비중·손절%·익절%는 미적용 — 각 전략이 자체 자금관리 규칙을
//    가진다(무한매수법의 분할·목표매도, VR의 밴드 리밸런싱).
//
// 두 전략 모두 라오어 원저 공개 버전의 "근사 구현"이다. 실제 운용 버전
// (v2.x 전반전/후반전, VR 세부 세팅)과 다를 수 있으며, 시뮬레이션 결과는
// 참고용일 뿐 실주문·투자자문이 아니다.

import type { DailyBar, EquityPoint, SimEvent, SimResult, SimSettings, Trade } from './types'
import { computeMetrics, initBenchmark } from './metrics'

// ---- 무한매수법 (Infinite Buying) -----------------------------------------
// v1 근사: 원금을 T분할(기본 40). 사이클 첫날 1회분 매수, 이후 매일
//  · 정액매수 0.5회분 — 항상 종가 체결 (원저의 "큰수 LOC")
//  · 평단매수 0.5회분 — 종가 < 평단일 때만 체결 (원저의 "평단 LOC")
// 매도: 평단×(1+목표%) 지정가 전량. 체결 시 사이클 종료, 다음 날 현금 전액을
// 새 원금으로 재시작(복리). 원금 소진 시 신규매수 중단·목표 대기(v1 기본).
// 선택: 사이클 손절%(평단 대비) — 설정 시 도달하면 전량 손절 후 재시작.
export interface InfiniteBuyingParams {
  splits: number // T분할 수
  targetPct: number // 평단 대비 목표 수익률 %
  cycleStopPct: number | null // 평단 대비 사이클 손절 % (null = 손절 없음, v1 기본)
}

export const DEFAULT_IB_PARAMS: InfiniteBuyingParams = { splits: 40, targetPct: 10, cycleStopPct: null }

export function runInfiniteBuying(
  bars: DailyBar[],
  startIdx: number,
  params: InfiniteBuyingParams,
  settings: SimSettings,
): SimResult {
  const n = bars.length
  if (startIdx < 1 || startIdx >= n - 1) throw new Error('시뮬레이션 시작 시점이 데이터 범위를 벗어났습니다')
  const comm = settings.commissionPct / 100
  const tax = settings.sellTaxPct / 100
  const slip = settings.slippagePct / 100
  const splits = Math.max(2, Math.round(params.splits))

  let cash = settings.initialCapital
  let qty = 0
  let fillSum = 0 // Σ qty×체결가 (평단 계산용, 수수료 제외)
  let cycleCost = 0 // 현금 지출 합 (수수료 포함, 손익 계산용)
  let cycleActive = false
  let cycleStart = ''
  let unit = 0
  let usedUnits = 0

  const trades: Trade[] = []
  const events: SimEvent[] = []
  const equity: EquityPoint[] = []
  let daysHolding = 0
  let peak = settings.initialCapital

  const avg = () => (qty > 0 ? fillSum / qty : 0)

  function buy(bar: DailyBar, unitFrac: number, note: string) {
    const fill = bar.c * (1 + slip)
    const budget = Math.min(unit * unitFrac, cash)
    const q = Math.floor(budget / (fill * (1 + comm)))
    if (q < 1) return
    qty += q
    fillSum += q * fill
    cycleCost += q * fill * (1 + comm)
    cash -= q * fill * (1 + comm)
    usedUnits += unitFrac
    const eqNow = cash + qty * bar.c
    events.push({
      date: bar.date, action: '매수', price: fill, qty: q, note,
      amount: q * fill,
      weightPct: eqNow > 0 ? ((qty * bar.c) / eqNow) * 100 : 0,
      cashAfter: cash, equityAfter: eqNow, positionsAfter: qty > 0 ? 1 : 0,
    })
  }

  function sellAll(bar: DailyBar, rawPrice: number, reason: Trade['reason'], note: string) {
    const fill = rawPrice
    const proceeds = qty * fill * (1 - comm - tax)
    cash += proceeds
    const pnl = proceeds - cycleCost
    trades.push({
      entryDate: cycleStart,
      entryPrice: avg(),
      qty,
      exitDate: bar.date,
      exitPrice: fill,
      pnl,
      pnlPct: cycleCost > 0 ? (pnl / cycleCost) * 100 : 0,
      reason,
    })
    const soldQty = qty
    const eqNow = cash
    events.push({
      date: bar.date, action: '매도', price: fill, qty: soldQty, note,
      amount: soldQty * fill, weightPct: 0, cashAfter: cash, equityAfter: eqNow,
      positionsAfter: 0, full: true,
    })
    qty = 0
    fillSum = 0
    cycleCost = 0
    cycleActive = false
    usedUnits = 0
  }

  for (let i = startIdx; i < n; i++) {
    const bar = bars[i]
    let soldToday = false

    if (cycleActive && qty > 0) {
      const target = avg() * (1 + params.targetPct / 100)
      if (bar.h >= target) {
        // 지정가 매도 — 갭상승 개장 시 시가(더 유리), 아니면 목표가 체결
        sellAll(bar, bar.o >= target ? bar.o : target, '사이클 목표매도', `목표가 도달 (평단 +${params.targetPct}%)`)
        soldToday = true
      } else if (params.cycleStopPct != null && bar.c <= avg() * (1 - params.cycleStopPct / 100)) {
        sellAll(bar, bar.c * (1 - slip), '사이클 손절', `평단 −${params.cycleStopPct}% 이탈 손절`)
        soldToday = true
      }
    }

    // 마지막 봉에서는 신규 사이클을 시작하지 않는다.
    if (!soldToday && i < n - 1) {
      if (!cycleActive) {
        cycleActive = true
        cycleStart = bar.date
        unit = cash / splits
        usedUnits = 0
        buy(bar, 1, '사이클 시작 매수')
      } else if (usedUnits < splits - 1e-9) {
        buy(bar, 0.5, '정액매수(0.5회분)')
        if (bar.c < avg()) buy(bar, 0.5, '평단매수(0.5회분)')
      }
    }

    if (qty > 0) daysHolding++
    const eq = cash + qty * bar.c
    peak = Math.max(peak, eq)
    equity.push({
      date: bar.date,
      equity: eq,
      benchmark: 0, // 아래에서 일괄 채움
      drawdownPct: peak > 0 ? ((eq - peak) / peak) * 100 : 0,
    })
  }

  const { bhQty, bhCash } = initBenchmark(bars[startIdx].o, settings.initialCapital, settings.commissionPct, settings.slippagePct)
  for (let i = 0; i < equity.length; i++) equity[i].benchmark = bhCash + bhQty * bars[startIdx + i].c

  if (qty > 0) {
    const last = bars[n - 1]
    const mtm = qty * last.c * (1 - comm - tax) - cycleCost
    trades.push({
      entryDate: cycleStart,
      entryPrice: avg(),
      qty,
      exitDate: null,
      exitPrice: null,
      pnl: mtm,
      pnlPct: cycleCost > 0 ? (mtm / cycleCost) * 100 : 0,
      reason: '보유중(미청산)',
    })
  }

  return {
    strategyId: 'infinite-buying',
    strategyName: '라오어 무한매수법 (근사)',
    trades,
    equity,
    metrics: computeMetrics(equity, trades, settings.initialCapital, daysHolding),
    startDate: bars[startIdx].date,
    endDate: bars[n - 1].date,
    events,
  }
}

// ---- VR (밸류 리밸런싱) ----------------------------------------------------
// 근사: 초기에 자본의 s%를 매수(나머지 = 현금 풀). V값 = 매수 직후 주식평가금.
// 매 주기(거래일 k일)마다 V값을 g% 성장시키고, 주식평가금이
//  · V×(1+밴드%) 초과 → V값까지 매도해 풀에 적립
//  · V×(1−밴드%) 미만 → 풀 한도 내에서 V값까지 매수
// 풀이 마르면 가능한 만큼만 매수한다(추가 입금 없음).
export interface VRParams {
  periodDays: number // 리밸런싱 주기 (거래일)
  growthPct: number // 주기당 V값 성장률 %
  bandPct: number // 밴드 폭 %
  initialStockPct: number // 초기 주식 비중 %
}

export const DEFAULT_VR_PARAMS: VRParams = { periodDays: 10, growthPct: 1, bandPct: 15, initialStockPct: 75 }

export function runValueRebalancing(
  bars: DailyBar[],
  startIdx: number,
  params: VRParams,
  settings: SimSettings,
): SimResult {
  const n = bars.length
  if (startIdx < 1 || startIdx >= n - 1) throw new Error('시뮬레이션 시작 시점이 데이터 범위를 벗어났습니다')
  const comm = settings.commissionPct / 100
  const tax = settings.sellTaxPct / 100
  const slip = settings.slippagePct / 100
  const period = Math.max(1, Math.round(params.periodDays))

  let cash = settings.initialCapital
  let qty = 0
  const events: SimEvent[] = []
  const equity: EquityPoint[] = []
  let daysHolding = 0
  let peak = settings.initialCapital

  // 초기 매수 (첫 시뮬레이션 일 종가)
  {
    const bar = bars[startIdx]
    const fill = bar.c * (1 + slip)
    const budget = settings.initialCapital * (Math.min(100, Math.max(0, params.initialStockPct)) / 100)
    const q = Math.floor(budget / (fill * (1 + comm)))
    if (q >= 1) {
      qty = q
      cash -= q * fill * (1 + comm)
      const eqNow = cash + qty * bar.c
      events.push({
        date: bar.date, action: '매수', price: fill, qty: q, note: '초기 편입',
        amount: q * fill,
        weightPct: eqNow > 0 ? ((qty * bar.c) / eqNow) * 100 : 0,
        cashAfter: cash, equityAfter: eqNow, positionsAfter: 1,
      })
    }
  }
  let V = qty * bars[startIdx].c // V값 = 초기 주식평가금

  for (let i = startIdx; i < n; i++) {
    const bar = bars[i]

    if (i > startIdx && (i - startIdx) % period === 0 && qty >= 0) {
      V *= 1 + params.growthPct / 100
      const stockVal = qty * bar.c
      if (stockVal > V * (1 + params.bandPct / 100)) {
        const sellQty = Math.floor((stockVal - V) / bar.c)
        if (sellQty >= 1) {
          const fill = bar.c * (1 - slip)
          cash += sellQty * fill * (1 - comm - tax)
          qty -= sellQty
          const eqNow = cash + qty * bar.c
          events.push({
            date: bar.date, action: '매도', price: fill, qty: sellQty, note: '밴드 상단 초과 → V값까지 부분 매도',
            amount: sellQty * fill,
            weightPct: eqNow > 0 ? ((qty * bar.c) / eqNow) * 100 : 0,
            cashAfter: cash, equityAfter: eqNow, positionsAfter: qty > 0 ? 1 : 0, full: qty === 0,
          })
        }
      } else if (stockVal < V * (1 - params.bandPct / 100)) {
        const fill = bar.c * (1 + slip)
        const budget = Math.min(cash, V - stockVal)
        const q = Math.floor(budget / (fill * (1 + comm)))
        if (q >= 1) {
          cash -= q * fill * (1 + comm)
          qty += q
          const eqNow = cash + qty * bar.c
          events.push({
            date: bar.date, action: '매수', price: fill, qty: q, note: '밴드 하단 이탈 → V값까지 부분 매수',
            amount: q * fill,
            weightPct: eqNow > 0 ? ((qty * bar.c) / eqNow) * 100 : 0,
            cashAfter: cash, equityAfter: eqNow, positionsAfter: qty > 0 ? 1 : 0, full: false,
          })
        }
      }
    }

    if (qty > 0) daysHolding++
    const eq = cash + qty * bar.c
    peak = Math.max(peak, eq)
    equity.push({
      date: bar.date,
      equity: eq,
      benchmark: 0,
      drawdownPct: peak > 0 ? ((eq - peak) / peak) * 100 : 0,
    })
  }

  const { bhQty, bhCash } = initBenchmark(bars[startIdx].o, settings.initialCapital, settings.commissionPct, settings.slippagePct)
  for (let i = 0; i < equity.length; i++) equity[i].benchmark = bhCash + bhQty * bars[startIdx + i].c

  // VR은 라운드트립 개념이 없어 trades는 비운다(지표의 승률·매매횟수는 '—').
  return {
    strategyId: 'value-rebalancing',
    strategyName: '라오어 VR 밸류 리밸런싱 (근사)',
    trades: [],
    equity,
    metrics: computeMetrics(equity, [], settings.initialCapital, daysHolding),
    startDate: bars[startIdx].date,
    endDate: bars[n - 1].date,
    events,
  }
}
