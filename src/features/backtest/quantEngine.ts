// 퀀트 합성 엔진 — 다중 팩터 + 레짐 필터 + 리스크 레이어를 한 모델로 묶는다.
//
// ── 레이어 구조 (각 층이 독립적으로 켜고 끌 수 있다) ────────────────────
//   1층 후보 풀   : 대표가 지정한 종목 목록
//   2층 알파 신호 : 다중 팩터 z-score 가중합 (factors.ts)
//   3층 레짐 필터 : 시장 상태에 따라 투자 비중을 줄이거나 전부 현금
//   4층 리스크    : 역변동성 가중 + 변동성 타게팅 (risk.ts)
//   5층 리밸런싱  : 주기 + 밴드(목표에서 크게 벗어날 때만 조정)
//   6층 실행      : 익일 시가 체결, 수수료·거래세·슬리피지
//
// ── 3층 레짐 필터가 하는 일 ────────────────────────────────────────────
// 시장 전체가 무너질 때는 어떤 종목을 골라도 같이 빠진다. 그래서 "시장이
// 어떤 상태인가"를 따로 묻고, 위험 국면이면 투자 비중 자체를 낮춘다.
// 기준 자산(기본: 후보 풀의 동일가중 평균, 또는 지정한 지수)이
//   · 장기 이평선 위  → 정상 (비중 100%)
//   · 장기 이평선 아래 → 위험 (비중 riskOffExposurePct%, 기본 0 = 전액 현금)
// 이 판정도 그날 종가까지의 데이터만 쓴다.
//
// ── 5층 밴드 리밸런싱 ──────────────────────────────────────────────────
// 목표 비중과 현재 비중의 차이가 밴드(기본 5%p)를 넘을 때만 주문을 낸다.
// 매일 목표에 정확히 맞추면 회전율과 비용이 폭증하기 때문이다.
//
// ── 미래참조 금지 (CLAUDE.md 규칙 1) ───────────────────────────────────
//  · 판정은 리밸런싱일 종가까지의 데이터만, 체결은 다음 거래일 시가.
//  · 팩터 표준화는 그 시점 후보군 안에서만(횡단면). 전체 기간 통계 금지.
//  · 변동성·레짐 판정도 시점까지의 데이터만.
//  · 마지막 봉에서는 신규 편입을 만들지 않는다.

import type { HistoryResult, DailyBar } from '../../lib/history'
import type { EquityPoint, SimEvent, SimSettings, Trade } from './types'
import { operandSeries } from './series'
import { compositeScores, rawFactor, type CompositeRow, type MultiFactorParams } from './factors'
import { annualizedVol, computeWeights, type RiskParams } from './risk'

export type RegimeMode = 'off' | 'poolAverage' | 'symbol'

export interface RegimeParams {
  mode: RegimeMode
  symbol: string // mode==='symbol'일 때 기준 지수/ETF
  sma: number // 장기 이평 기간
  riskOffExposurePct: number // 위험 국면에서 유지할 투자 비중 % (0 = 전액 현금)
}

export const DEFAULT_REGIME: RegimeParams = {
  mode: 'poolAverage',
  symbol: 'SPY',
  sma: 200,
  riskOffExposurePct: 0,
}

export interface QuantParams {
  factor: MultiFactorParams
  regime: RegimeParams
  risk: RiskParams
  rebalanceBandPct: number // 목표 대비 이만큼 벗어나야 주문 (회전율 억제)
}

export interface QuantSnapshot {
  date: string
  regimeOk: boolean
  regimeDetail: string
  exposurePct: number // 실제 총 투자 비중 %
  portfolioVolPct: number | null
  riskNote: string
  rows: CompositeRow[]
}

export interface QuantResult {
  equity: EquityPoint[]
  trades: Trade[]
  events: SimEvent[]
  daysHolding: number
  universe: string[]
  startDate: string
  endDate: string
  lastSnapshot: QuantSnapshot | null
}

interface Aligned {
  symbol: string
  bars: DailyBar[]
  idxAt: number[]
  hasBarAt: boolean[]
  trendSma: (number | null)[]
}

function align(symbol: string, bars: DailyBar[], calendar: string[], smaPeriod: number): Aligned {
  const idxAt: number[] = new Array(calendar.length).fill(-1)
  const hasBarAt: boolean[] = new Array(calendar.length).fill(false)
  let p = -1
  let b = 0
  for (let k = 0; k < calendar.length; k++) {
    while (b < bars.length && bars[b].date <= calendar[k]) {
      p = b
      b++
    }
    idxAt[k] = p
    hasBarAt[k] = p >= 0 && bars[p].date === calendar[k]
  }
  return { symbol, bars, idxAt, hasBarAt, trendSma: operandSeries(bars, { kind: 'SMA', period: smaPeriod }) }
}

// 후보 풀의 동일가중 평균 지수를 만든다 — 레짐 판정의 기준선.
// 각 종목의 일간 수익률 평균을 누적한 가상 지수이며, 시점까지의 데이터만 쓴다.
function buildPoolIndex(aligned: Record<string, Aligned>, calendar: string[]): DailyBar[] {
  const symbols = Object.keys(aligned)
  const out: DailyBar[] = []
  let level = 100
  for (let k = 0; k < calendar.length; k++) {
    let sum = 0
    let n = 0
    for (const s of symbols) {
      const a = aligned[s]
      const i = a.idxAt[k]
      if (i >= 1) {
        const prev = a.bars[i - 1].c
        if (prev > 0 && a.bars[i].c > 0 && a.hasBarAt[k]) {
          sum += a.bars[i].c / prev - 1
          n++
        }
      }
    }
    if (n > 0) level *= 1 + sum / n
    out.push({ date: calendar[k], t: 0, o: level, h: level, l: level, c: level, v: 0 })
  }
  return out
}

export function runQuant(
  histories: Record<string, HistoryResult>,
  startDate: string,
  params: QuantParams,
  settings: SimSettings,
): QuantResult {
  const symbols = Object.keys(histories).filter((s) => histories[s]?.bars?.length > 0)
  if (symbols.length === 0) throw new Error('후보 풀의 시세 데이터를 하나도 불러오지 못했습니다')

  const dateSet = new Set<string>()
  for (const s of symbols) for (const b of histories[s].bars) dateSet.add(b.date)
  const calendar = [...dateSet].sort()

  const aligned: Record<string, Aligned> = {}
  for (const s of symbols) aligned[s] = align(s, histories[s].bars, calendar, params.factor.trendSma)

  // 레짐 기준선
  let regimeBars: DailyBar[] | null = null
  let regimeSma: (number | null)[] | null = null
  let regimeLabel = ''
  if (params.regime.mode === 'poolAverage') {
    regimeBars = buildPoolIndex(aligned, calendar)
    regimeSma = operandSeries(regimeBars, { kind: 'SMA', period: params.regime.sma })
    regimeLabel = '후보 풀 평균지수'
  } else if (params.regime.mode === 'symbol' && aligned[params.regime.symbol]) {
    const a = aligned[params.regime.symbol]
    regimeBars = a.bars
    regimeSma = operandSeries(a.bars, { kind: 'SMA', period: params.regime.sma })
    regimeLabel = params.regime.symbol
  }

  const maxLookback = Math.max(...params.factor.factors.map((f) => f.lookback), 60)
  const warmup = Math.max(
    maxLookback + 5,
    params.factor.trendFilter ? params.factor.trendSma : 0,
    params.regime.mode !== 'off' ? params.regime.sma : 0,
    params.risk.volLookback + 5,
  )
  let startK = calendar.findIndex((d) => d >= startDate)
  if (startK < 0) startK = Math.floor(calendar.length / 2)
  startK = Math.max(startK, warmup)
  if (startK >= calendar.length - 2) throw new Error('워밍업 기간을 뺀 시뮬레이션 구간이 너무 짧습니다')

  const comm = settings.commissionPct / 100
  const tax = settings.sellTaxPct / 100
  const slip = settings.slippagePct / 100

  let cash = settings.initialCapital
  const holdings: Record<string, { qty: number; entryFill: number; entryCost: number; entryDate: string }> = {}
  const trades: Trade[] = []
  const events: SimEvent[] = []
  const equity: EquityPoint[] = []
  let daysHolding = 0
  let peak = settings.initialCapital
  let pendingTargets: Record<string, number> | null = null
  let lastSnapshot: QuantSnapshot | null = null

  // 벤치마크 = 후보 풀 균등보유
  const benchQty: Record<string, number> = {}
  let benchCash = settings.initialCapital
  {
    const per = settings.initialCapital / symbols.length
    for (const s of symbols) {
      const i = aligned[s].idxAt[startK]
      if (i < 0) continue
      const fill = aligned[s].bars[i].c * (1 + slip)
      const q = Math.floor(per / (fill * (1 + comm)))
      if (q >= 1) {
        benchQty[s] = q
        benchCash -= q * fill * (1 + comm)
      }
    }
  }

  const lastClose = (s: string, k: number) => {
    const i = aligned[s].idxAt[k]
    return i >= 0 ? aligned[s].bars[i].c : 0
  }
  const equityAt = (k: number) => {
    let held = 0
    for (const s of Object.keys(holdings)) held += holdings[s].qty * lastClose(s, k)
    return cash + held
  }
  const snapshot = (k: number) => ({
    equity: equityAt(k),
    cash,
    positions: Object.keys(holdings).length,
  })

  for (let k = startK; k < calendar.length; k++) {
    const date = calendar[k]

    // 1) 어제 결정된 목표 비중으로 오늘 시가에 리밸런싱 (매도 먼저)
    if (pendingTargets) {
      const targets = pendingTargets
      const eqNow = equityAt(k)

      for (const s of Object.keys(holdings)) {
        const a = aligned[s]
        if (!a.hasBarAt[k]) continue
        const px = a.bars[a.idxAt[k]].o
        const targetVal = (targets[s] ?? 0) * eqNow
        const curVal = holdings[s].qty * px
        const diff = curVal - targetVal
        // 밴드 밖일 때만 조정
        if (diff <= (params.rebalanceBandPct / 100) * eqNow) continue
        const sellQty = targets[s] ? Math.min(holdings[s].qty, Math.floor(diff / px)) : holdings[s].qty
        if (sellQty < 1) continue
        const fill = px * (1 - slip)
        const proceeds = sellQty * fill * (1 - comm - tax)
        cash += proceeds
        const h = holdings[s]
        const costPart = h.entryCost * (sellQty / h.qty)
        const full = sellQty >= h.qty
        trades.push({
          entryDate: h.entryDate,
          entryPrice: h.entryFill,
          qty: sellQty,
          exitDate: date,
          exitPrice: fill,
          pnl: proceeds - costPart,
          pnlPct: costPart > 0 ? ((proceeds - costPart) / costPart) * 100 : 0,
          reason: '조건 매도',
          symbol: s,
        })
        if (full) delete holdings[s]
        else {
          h.qty -= sellQty
          h.entryCost -= costPart
        }
        const snap = snapshot(k)
        events.push({
          date,
          action: '매도',
          price: fill,
          qty: sellQty,
          note: targets[s] ? '비중 축소(리밸런싱)' : '목표에서 제외',
          symbol: s,
          amount: sellQty * fill,
          weightPct: 0,
          cashAfter: snap.cash,
          equityAfter: snap.equity,
          positionsAfter: snap.positions,
          full,
        })
      }

      // 매수 — 목표 비중까지 채운다
      for (const s of Object.keys(targets)) {
        const a = aligned[s]
        if (!a.hasBarAt[k]) continue
        const px = a.bars[a.idxAt[k]].o
        const targetVal = targets[s] * eqNow
        const curVal = (holdings[s]?.qty ?? 0) * px
        const diff = targetVal - curVal
        if (diff <= (params.rebalanceBandPct / 100) * eqNow) continue
        const fill = px * (1 + slip)
        const q = Math.floor(Math.min(cash, diff) / (fill * (1 + comm)))
        if (q < 1) continue
        const cost = q * fill * (1 + comm)
        cash -= cost
        if (holdings[s]) {
          holdings[s].qty += q
          holdings[s].entryCost += cost
        } else {
          holdings[s] = { qty: q, entryFill: fill, entryCost: cost, entryDate: date }
        }
        const snap = snapshot(k)
        events.push({
          date,
          action: '매수',
          price: fill,
          qty: q,
          note: '목표 비중 편입',
          symbol: s,
          amount: q * fill,
          weightPct: snap.equity > 0 ? ((holdings[s].qty * lastClose(s, k)) / snap.equity) * 100 : 0,
          cashAfter: snap.cash,
          equityAfter: snap.equity,
          positionsAfter: snap.positions,
        })
      }
      pendingTargets = null
    }

    // 2) 리밸런싱일이면 오늘 종가로 다음 목표를 계산
    const isRebalance = (k - startK) % Math.max(1, params.factor.rebalanceDays) === 0
    if (isRebalance && k < calendar.length - 1) {
      // 2-a) 레짐 판정
      let regimeOk = true
      let regimeDetail = '레짐 필터 미사용'
      if (regimeBars && regimeSma) {
        const sma = regimeSma[k]
        const px = regimeBars[k]?.c
        if (sma == null || px == null) {
          regimeOk = false
          regimeDetail = `${regimeLabel} ${params.regime.sma}일선 미형성 — 보수적으로 위험 국면 처리`
        } else {
          regimeOk = px > sma
          regimeDetail = `${regimeLabel} ${px.toFixed(1)} vs ${params.regime.sma}일선 ${sma.toFixed(1)} → ${regimeOk ? '정상' : '위험'}`
        }
      }

      // 2-b) 팩터 원시값 → 횡단면 z-score 합성
      const raws: Record<string, (number | null)[]> = {}
      for (const s of symbols) {
        const a = aligned[s]
        const i = a.idxAt[k]
        raws[s] = params.factor.factors.map((f) => (i >= 0 ? rawFactor(a.bars, i, f) : null))
      }
      const comp = compositeScores(raws, params.factor.factors)

      const rows: CompositeRow[] = symbols.map((s) => {
        const a = aligned[s]
        const i = a.idxAt[k]
        const reasons: string[] = []
        const c = comp[s]
        if (i < 0) reasons.push('데이터 없음')
        if (c.score == null) reasons.push('팩터 계산 불가(기간 부족)')
        if (params.factor.trendFilter && i >= 0) {
          const sma = a.trendSma[i]
          if (sma == null) reasons.push(`${params.factor.trendSma}일선 미형성`)
          else if (!(a.bars[i].c > sma)) reasons.push(`종가가 ${params.factor.trendSma}일선 아래`)
        }
        if (c.score != null && params.factor.minScore !== 0 && c.score < params.factor.minScore) {
          reasons.push(`합성점수 ${c.score.toFixed(2)} < 하한 ${params.factor.minScore}`)
        }
        return { symbol: s, score: c.score, rank: null, breakdown: c.breakdown, passed: reasons.length === 0, reasons }
      })

      const eligible = rows.filter((r) => r.passed).sort((x, y) => (y.score ?? 0) - (x.score ?? 0))
      eligible.forEach((r, idx) => (r.rank = idx + 1))
      const picked = eligible.slice(0, Math.max(1, params.factor.topN))

      // 2-c) 리스크 레이어 — 비중 계산
      const inputs = picked.map((r) => ({
        symbol: r.symbol,
        volPct: annualizedVol(aligned[r.symbol].bars, aligned[r.symbol].idxAt[k], params.risk.volLookback),
      }))
      const w = computeWeights(inputs, Math.max(1, params.factor.topN), params.risk)

      // 2-d) 레짐이 위험이면 노출을 강제로 낮춘다
      let targets: Record<string, number> = { ...w.weights }
      let exposure = w.grossExposure
      let riskNote = w.note
      if (!regimeOk) {
        const capped = params.regime.riskOffExposurePct / 100
        const shrink = exposure > 0 ? Math.min(1, capped / exposure) : 0
        for (const kk of Object.keys(targets)) targets[kk] *= shrink
        exposure = exposure * shrink
        riskNote += ` · 레짐 위험 → 노출 ${params.regime.riskOffExposurePct}%로 축소`
      }

      pendingTargets = targets
      lastSnapshot = {
        date,
        regimeOk,
        regimeDetail,
        exposurePct: exposure * 100,
        portfolioVolPct: w.portfolioVolPct,
        riskNote,
        rows: rows.sort((x, y) => {
          if (x.passed !== y.passed) return x.passed ? -1 : 1
          return (y.score ?? -Infinity) - (x.score ?? -Infinity)
        }),
      }
    }

    // 3) 시가평가
    let holdVal = 0
    for (const s of Object.keys(holdings)) holdVal += holdings[s].qty * lastClose(s, k)
    if (holdVal > 0) daysHolding++
    const eq = cash + holdVal
    peak = Math.max(peak, eq)
    let benchVal = benchCash
    for (const s of Object.keys(benchQty)) benchVal += benchQty[s] * lastClose(s, k)
    equity.push({ date, equity: eq, benchmark: benchVal, drawdownPct: peak > 0 ? ((eq - peak) / peak) * 100 : 0 })
  }

  const lastK = calendar.length - 1
  for (const s of Object.keys(holdings)) {
    const h = holdings[s]
    const mtm = h.qty * lastClose(s, lastK) * (1 - comm - tax) - h.entryCost
    trades.push({
      entryDate: h.entryDate,
      entryPrice: h.entryFill,
      qty: h.qty,
      exitDate: null,
      exitPrice: null,
      pnl: mtm,
      pnlPct: h.entryCost > 0 ? (mtm / h.entryCost) * 100 : 0,
      reason: '보유중(미청산)',
      symbol: s,
    })
  }

  trades.sort((a, b) => (a.entryDate < b.entryDate ? -1 : 1))
  events.sort((a, b) => (a.date < b.date ? -1 : 1))

  return {
    equity,
    trades,
    events,
    daysHolding,
    universe: symbols,
    startDate: calendar[startK],
    endDate: calendar[lastK],
    lastSnapshot,
  }
}
