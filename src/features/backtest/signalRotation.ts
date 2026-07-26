// 신호형 종목발굴 엔진 — "스크리닝 → 순위 → 상위 N 보유".
//
// 기존 규칙형 엔진(engine.ts)은 정해진 한 종목을 언제 사고 팔지만 풀었다.
// 이 엔진은 후보 풀 전체를 매일 훑어 매수 조건을 만족하는 종목을 찾아내고
// (기술적 스크리닝), 그중 추세가 강한 순으로 줄 세워(통계적 순위) 슬롯 수만큼
// 담는다. 종목을 사람이 지정하지 않고 규칙이 발굴한다.
//
// 구조:
//   ① 후보 필터 — 매수 조건(AND) 충족 + 장기추세 필터(선택)
//   ② 순위     — 상대강도(모멘텀) 또는 저변동성 등으로 정렬
//   ③ 슬롯     — 비어 있는 자리에만 상위부터 편입, 균등 배분
//   ④ 청산     — 매도 조건 / 손절 / 익절
//
// ── 미래참조 금지 (CLAUDE.md 규칙 1) ────────────────────────────────────
//  · 판정은 그날 종가까지의 데이터만 사용, 체결은 다음 거래일 시가(+슬리피지).
//  · 손절·익절은 장중 저가/고가로 판정하되 갭 관통 시 시가(불리한 쪽) 체결.
//  · 마지막 봉에서는 신규 편입을 만들지 않는다.
//  · 순위 점수의 롤링 극값은 series.ts가 당일을 제외해 계산한다.

import type { HistoryResult, DailyBar } from '../../lib/history'
import type { Condition, EquityPoint, SimEvent, SimSettings, StrategyConfig, Trade } from './types'
import { operandSeries } from './series'
import { evalConditionAt, type ConditionEval } from './explain'

export type RankMethod = 'momentum' | 'lowVol' | 'none'

export interface SignalRotationParams {
  topN: number // 동시 보유 종목 수 (슬롯)
  rankBy: RankMethod // 후보가 슬롯보다 많을 때 우선순위
  rankLookback: number // 순위 점수 측정 기간(거래일)
  trendFilter: boolean // 장기 추세 위 종목만 후보로
  trendSma: number
}

export const DEFAULT_SIGNAL_ROTATION: SignalRotationParams = {
  topN: 3,
  rankBy: 'momentum',
  rankLookback: 126,
  trendFilter: true,
  trendSma: 200,
}

export interface ScreenRow {
  symbol: string
  signal: boolean // 매수 조건 충족 여부
  trendOk: boolean
  score: number | null
  rank: number | null
  held: boolean
  reasons: string[] // 후보 탈락 사유
  // 조건별 실측 지표값 — 최신 스크리닝에만 채운다(설명가능성).
  conds?: ConditionEval[]
  trendDetail?: string
}

export interface SignalRotationResult {
  equity: EquityPoint[]
  trades: Trade[]
  events: SimEvent[]
  daysHolding: number
  universe: string[]
  startDate: string
  endDate: string
  lastScreen: ScreenRow[]
  lastScreenDate: string
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

// 조건 하나를 bars[i]에서 평가 — engine.ts와 동일한 의미론.
function condHolds(bars: DailyBar[], c: Condition, i: number): boolean {
  const L = operandSeries(bars, c.left)
  const R = operandSeries(bars, c.right)
  const l = L[i]
  const r = R[i]
  if (l == null || r == null) return false
  if (c.op === 'gt') return l > r
  if (c.op === 'lt') return l < r
  const lp = i > 0 ? L[i - 1] : null
  const rp = i > 0 ? R[i - 1] : null
  if (lp == null || rp == null) return false
  if (c.op === 'crossAbove') return lp <= rp && l > r
  return lp >= rp && l < r
}

function stdev(xs: number[]): number {
  if (xs.length < 2) return 0
  const m = xs.reduce((s, v) => s + v, 0) / xs.length
  return Math.sqrt(xs.reduce((s, v) => s + (v - m) ** 2, 0) / (xs.length - 1))
}

function rankScore(a: Aligned, i: number, p: SignalRotationParams): number | null {
  if (p.rankBy === 'none') return 0
  const start = i - p.rankLookback
  if (start < 0) return null
  if (p.rankBy === 'momentum') {
    const ps = a.bars[start].c
    const pe = a.bars[i].c
    return ps > 0 && pe > 0 ? pe / ps - 1 : null
  }
  // lowVol: 변동성이 낮을수록 높은 점수(음수 부호)
  const rets: number[] = []
  for (let j = start + 1; j <= i; j++) {
    const prev = a.bars[j - 1].c
    if (prev > 0) rets.push(a.bars[j].c / prev - 1)
  }
  const sd = stdev(rets)
  return sd > 0 ? -sd : null
}

export function runSignalRotation(
  histories: Record<string, HistoryResult>,
  startDate: string,
  strategy: StrategyConfig,
  params: SignalRotationParams,
  settings: SimSettings,
): SignalRotationResult {
  const symbols = Object.keys(histories).filter((s) => histories[s]?.bars?.length > 0)
  if (symbols.length === 0) throw new Error('후보 풀의 시세 데이터를 하나도 불러오지 못했습니다')

  const dateSet = new Set<string>()
  for (const s of symbols) for (const b of histories[s].bars) dateSet.add(b.date)
  const calendar = [...dateSet].sort()

  const aligned: Record<string, Aligned> = {}
  for (const s of symbols) aligned[s] = align(s, histories[s].bars, calendar, params.trendSma)

  const warmup = Math.max(params.trendFilter ? params.trendSma : 0, params.rankBy === 'none' ? 0 : params.rankLookback, 60)
  let startK = calendar.findIndex((d) => d >= startDate)
  if (startK < 0) startK = Math.floor(calendar.length / 2)
  startK = Math.max(startK, warmup)
  if (startK >= calendar.length - 2) throw new Error('워밍업 기간을 뺀 시뮬레이션 구간이 너무 짧습니다')

  const comm = settings.commissionPct / 100
  const tax = settings.sellTaxPct / 100
  const slip = settings.slippagePct / 100
  const topN = Math.max(1, Math.round(params.topN))

  let cash = settings.initialCapital
  const holdings: Record<
    string,
    { qty: number; entryFill: number; entryCost: number; entryDate: string; stop: number | null; take: number | null }
  > = {}
  const trades: Trade[] = []
  const events: SimEvent[] = []
  const equity: EquityPoint[] = []
  let daysHolding = 0
  let peak = settings.initialCapital

  let pendingBuys: string[] = []
  let pendingSells: string[] = []
  let lastScreen: ScreenRow[] = []
  let lastScreenDate = ''

  // 벤치마크 = 후보 풀 전체 균등보유 (종목 발굴이 가치를 만들었는지 판정용)
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

  function closePosition(s: string, k: number, rawPrice: number, reason: Trade['reason'], applySlip: boolean, note: string) {
    const h = holdings[s]
    const fill = applySlip ? rawPrice * (1 - slip) : rawPrice
    const proceeds = h.qty * fill * (1 - comm - tax)
    cash += proceeds
    trades.push({
      entryDate: h.entryDate,
      entryPrice: h.entryFill,
      qty: h.qty,
      exitDate: calendar[k],
      exitPrice: fill,
      pnl: proceeds - h.entryCost,
      pnlPct: h.entryCost > 0 ? ((proceeds - h.entryCost) / h.entryCost) * 100 : 0,
      reason,
      symbol: s,
    })
    events.push({ date: calendar[k], action: '매도', price: fill, qty: h.qty, note, symbol: s })
    delete holdings[s]
  }

  for (let k = startK; k < calendar.length; k++) {
    const date = calendar[k]

    // 1) 어제 결정된 매도 → 오늘 시가
    for (const s of pendingSells) {
      if (!holdings[s] || !aligned[s].hasBarAt[k]) continue
      closePosition(s, k, aligned[s].bars[aligned[s].idxAt[k]].o, '조건 매도', true, '매도 조건 충족')
    }
    pendingSells = []

    // 2) 어제 결정된 매수 → 오늘 시가 (빈 슬롯만큼)
    if (pendingBuys.length > 0) {
      const open = topN - Object.keys(holdings).length
      const buyList = pendingBuys.filter((s) => !holdings[s] && aligned[s].hasBarAt[k]).slice(0, Math.max(0, open))
      if (buyList.length > 0) {
        // 슬롯 단위 균등 — 현재 현금을 남은 슬롯 수로 나눈다
        const slotCash = cash / buyList.length
        for (const s of buyList) {
          const bar = aligned[s].bars[aligned[s].idxAt[k]]
          const fill = bar.o * (1 + slip)
          const q = Math.floor(slotCash / (fill * (1 + comm)))
          if (q < 1) continue
          const cost = q * fill * (1 + comm)
          cash -= cost
          holdings[s] = {
            qty: q,
            entryFill: fill,
            entryCost: cost,
            entryDate: date,
            stop: settings.stopLossPct != null ? fill * (1 - settings.stopLossPct / 100) : null,
            take: settings.takeProfitPct != null ? fill * (1 + settings.takeProfitPct / 100) : null,
          }
          events.push({ date, action: '매수', price: fill, qty: q, note: '신호 편입', symbol: s })
        }
      }
      pendingBuys = []
    }

    // 3) 장중 손절·익절 (손절 우선 — 둘 다 닿으면 보수적으로)
    for (const s of Object.keys(holdings)) {
      const a = aligned[s]
      if (!a.hasBarAt[k]) continue
      const bar = a.bars[a.idxAt[k]]
      const h = holdings[s]
      if (h.stop != null && bar.l <= h.stop) {
        closePosition(s, k, bar.o <= h.stop ? bar.o : h.stop, '손절', true, '손절선 도달')
      } else if (h.take != null && bar.h >= h.take) {
        closePosition(s, k, bar.o >= h.take ? bar.o : h.take, '익절', false, '익절선 도달')
      }
    }

    // 4) 오늘 종가로 판정 → 내일 체결할 주문 결정
    if (k < calendar.length - 1) {
      // 4-a) 보유 종목 매도 조건
      for (const s of Object.keys(holdings)) {
        const a = aligned[s]
        const i = a.idxAt[k]
        if (i < 0) continue
        if (strategy.sell.some((c) => condHolds(a.bars, c, i))) pendingSells.push(s)
      }

      // 4-b) 빈 슬롯이 생길 예정이면 후보를 스크리닝
      const willHold = Object.keys(holdings).filter((s) => !pendingSells.includes(s)).length
      const slots = topN - willHold
      const screen: ScreenRow[] = symbols.map((s) => {
        const a = aligned[s]
        const i = a.idxAt[k]
        const held = !!holdings[s]
        if (i < 0) return { symbol: s, signal: false, trendOk: false, score: null, rank: null, held, reasons: ['데이터 없음'] }
        const reasons: string[] = []
        const signal = strategy.buy.length > 0 && strategy.buy.every((c) => condHolds(a.bars, c, i))
        if (!signal) reasons.push('매수 조건 미충족')
        let trendOk = true
        if (params.trendFilter) {
          const sma = a.trendSma[i]
          if (sma == null) {
            trendOk = false
            reasons.push(`${params.trendSma}일선 미형성`)
          } else if (!(a.bars[i].c > sma)) {
            trendOk = false
            reasons.push(`종가가 ${params.trendSma}일선 아래(하락 추세)`)
          }
        }
        const score = rankScore(a, i, params)
        if (score == null) reasons.push('순위 점수 계산 불가(기간 부족)')
        return { symbol: s, signal, trendOk, score, rank: null, held, reasons }
      })

      const eligible = screen
        .filter((r) => !r.held && r.signal && r.trendOk && r.score != null)
        .sort((x, y) => (y.score ?? 0) - (x.score ?? 0))
      eligible.forEach((r, idx) => (r.rank = idx + 1))
      if (slots > 0) pendingBuys = eligible.slice(0, slots).map((r) => r.symbol)

      lastScreen = screen.sort((x, y) => {
        if (x.held !== y.held) return x.held ? -1 : 1
        const xa = x.signal && x.trendOk
        const ya = y.signal && y.trendOk
        if (xa !== ya) return xa ? -1 : 1
        return (y.score ?? -Infinity) - (x.score ?? -Infinity)
      })
      lastScreenDate = date
    }

    // 5) 시가평가
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

  // 최신 스크리닝에 조건별 실측 지표값을 채운다 — 화면에서 "왜 통과/탈락했나"를
  // 숫자로 보여주기 위함. 매 거래일 계산하면 비싸므로 마지막 시점만 계산한다.
  if (lastScreenDate) {
    const k = calendar.indexOf(lastScreenDate)
    if (k >= 0) {
      for (const row of lastScreen) {
        const a = aligned[row.symbol]
        const i = a?.idxAt[k] ?? -1
        if (i < 0) continue
        const conds = (row.held ? strategy.sell : strategy.buy).map((c) => evalConditionAt(a.bars, c, i))
        row.conds = conds
        if (params.trendFilter) {
          const sma = a.trendSma[i]
          row.trendDetail =
            sma == null
              ? `${params.trendSma}일선 미형성`
              : `종가 ${a.bars[i].c.toLocaleString(undefined, { maximumFractionDigits: 2 })} / ${params.trendSma}일선 ${sma.toLocaleString(undefined, { maximumFractionDigits: 2 })}`
        }
      }
    }
  }

  return {
    equity,
    trades,
    events,
    daysHolding,
    universe: symbols,
    startDate: calendar[startK],
    endDate: calendar[lastK],
    lastScreen,
    lastScreenDate,
  }
}
