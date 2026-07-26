// 포트폴리오(멀티종목) 실행 — "모델 1개 = 가상 투자자 1명"의 트랙레코드.
//
// 슬리브 방식: 초기자본을 유니버스 종목 수만큼 균등 분할해 각 종목을 독립
// 계좌(슬리브)로 운용하고, 포트폴리오 NAV = 슬리브 자산의 합. 각 슬리브는
// 현지통화 수익률 기준이므로 국장·미장을 섞어도 계산이 성립하지만, 환율
// 변동 손익은 반영되지 않는다(한계 — 화면에 고지).
//
// 워크포워드 규율은 슬리브 엔진(engine.ts / algoEngine.ts)이 그대로 보장한다.

import type { HistoryResult } from '../../lib/history'
import type { EquityPoint, SimEvent, SimMetrics, SimResult, Trade } from './types'
import { computeMetrics } from './metrics'
import { runBacktest } from './engine'
import { runInfiniteBuying, runValueRebalancing, DEFAULT_IB_PARAMS, DEFAULT_VR_PARAMS } from './algoEngine'
import { clonePreset } from './strategies'
import { runRotation, DEFAULT_ROTATION, type Candidate } from './rotation'
import { runSignalRotation, DEFAULT_SIGNAL_ROTATION, type ScreenRow } from './signalRotation'
import { modelMeta, type ModelConfig } from './models'

export const MIN_WARMUP = 120 // 지표 warm-up용 최소 과거 봉 수

export function computeStartIdx(bars: { date: string }[], startDate: string): number {
  if (!startDate) return Math.max(MIN_WARMUP, Math.floor(bars.length / 2))
  const i = bars.findIndex((b) => b.date >= startDate)
  if (i < 0) return Math.max(MIN_WARMUP, bars.length - 2)
  return Math.max(MIN_WARMUP, i)
}

export interface SleeveOutcome {
  symbol: string
  res: SimResult
}

export interface AdvancedMetrics {
  // 최근 1년(달력 기준) 성과 — 전체 구간 누적치에 가려지는 '지금 잘하고 있나'를
  // 보기 위한 지표. 구간이 1년보다 짧으면 있는 만큼만 쓰고 partial로 표시한다.
  return1yPct: number | null
  bench1yPct: number | null
  excess1yPct: number | null
  oneYearFrom: string | null
  oneYearPartial: boolean
  volPct: number // 연환산 변동성 %
  sortino: number // 하방편차 기준 위험조정수익
  calmar: number | null // CAGR / |MDD| (MDD=0이면 null)
  maxUnderwaterDays: number // 최장 낙폭(수면 아래) 지속 거래일
  monthlyWinRatePct: number // 월간 수익 양(+)인 달의 비율
  bestMonthPct: number
  worstMonthPct: number
  yearly: { year: string; retPct: number; benchRetPct: number }[]
  yearsBeatBench: string // '4/6'
}

export interface PortfolioResult {
  modelId: string
  modelName: string
  isRotation?: boolean
  isScreening?: boolean
  lastSelection?: Candidate[]
  lastSelectionDate?: string
  lastScreen?: ScreenRow[]
  lastScreenDate?: string
  equity: EquityPoint[]
  metrics: SimMetrics
  advanced: AdvancedMetrics
  trades: Trade[]
  events: SimEvent[]
  sleeves: SleeveOutcome[]
  startDate: string
  endDate: string
  universe: string[]
}

function runSleeve(modelId: string, cfg: ModelConfig, hist: HistoryResult, sleeveCapital: number): SimResult {
  const bars = hist.bars
  const startIdx = computeStartIdx(bars, cfg.startDate)
  const settings = { ...cfg.settings, initialCapital: sleeveCapital }
  if (modelId === 'infinite-buying') return runInfiniteBuying(bars, startIdx, cfg.ib ?? DEFAULT_IB_PARAMS, settings)
  if (modelId === 'value-rebalancing') return runValueRebalancing(bars, startIdx, cfg.vr ?? DEFAULT_VR_PARAMS, settings)
  return runBacktest(bars, startIdx, cfg.strategy ?? clonePreset(modelId), settings)
}

// 슬리브 자산곡선들을 날짜 유니언 위에서 합산(장 휴일 어긋남은 직전값 유지).
function aggregateEquity(sleeves: SleeveOutcome[], sleeveCapital: number): EquityPoint[] {
  const allDates = new Set<string>()
  for (const s of sleeves) for (const e of s.res.equity) allDates.add(e.date)
  const dates = [...allDates].sort()

  const maps = sleeves.map((s) => {
    const m = new Map<string, { eq: number; bh: number }>()
    for (const e of s.res.equity) m.set(e.date, { eq: e.equity, bh: e.benchmark })
    return { m, firstDate: s.res.equity[0]?.date ?? '' }
  })

  const lastVals = maps.map(() => ({ eq: sleeveCapital, bh: sleeveCapital }))
  const out: EquityPoint[] = []
  let peak = 0
  for (const d of dates) {
    let eq = 0
    let bh = 0
    for (let i = 0; i < maps.length; i++) {
      const v = maps[i].m.get(d)
      if (v) lastVals[i] = v
      eq += lastVals[i].eq
      bh += lastVals[i].bh
    }
    peak = Math.max(peak, eq)
    out.push({ date: d, equity: eq, benchmark: bh, drawdownPct: peak > 0 ? ((eq - peak) / peak) * 100 : 0 })
  }
  return out
}

function downsideDev(rets: number[]): number {
  const downs = rets.filter((r) => r < 0)
  if (downs.length < 2) return 0
  const m2 = downs.reduce((s, r) => s + r * r, 0) / rets.length
  return Math.sqrt(m2)
}

// 마지막 날짜로부터 달력 1년 전 이후의 첫 관측치를 기준으로 최근 1년 수익률을 낸다.
// 거래일 252개로 자르지 않는 이유: 국장·미장 혼합 캘린더에서는 종목마다 거래일
// 수가 달라 252가 실제 1년과 어긋나기 때문이다.
function trailingOneYear(equity: EquityPoint[]) {
  if (equity.length < 2) {
    return { return1yPct: null, bench1yPct: null, excess1yPct: null, oneYearFrom: null, oneYearPartial: true }
  }
  const last = equity[equity.length - 1]
  const cutoff = new Date(Date.parse(last.date + 'T00:00:00Z'))
  cutoff.setUTCFullYear(cutoff.getUTCFullYear() - 1)
  const cutoffStr = cutoff.toISOString().slice(0, 10)
  let idx = equity.findIndex((e) => e.date >= cutoffStr)
  const partial = idx <= 0
  if (idx < 0) idx = 0
  const base = equity[idx]
  if (base.equity <= 0 || base.benchmark <= 0 || idx === equity.length - 1) {
    return { return1yPct: null, bench1yPct: null, excess1yPct: null, oneYearFrom: null, oneYearPartial: true }
  }
  const r = (last.equity / base.equity - 1) * 100
  const b = (last.benchmark / base.benchmark - 1) * 100
  return { return1yPct: r, bench1yPct: b, excess1yPct: r - b, oneYearFrom: base.date, oneYearPartial: partial }
}

export function computeAdvanced(equity: EquityPoint[], cagrPct: number, mddPct: number): AdvancedMetrics {
  const rets: number[] = []
  for (let i = 1; i < equity.length; i++) rets.push(equity[i].equity / equity[i - 1].equity - 1)
  const mean = rets.length ? rets.reduce((s, v) => s + v, 0) / rets.length : 0
  const variance = rets.length > 1 ? rets.reduce((s, v) => s + (v - mean) ** 2, 0) / (rets.length - 1) : 0
  const volPct = Math.sqrt(variance) * Math.sqrt(252) * 100
  const dd = downsideDev(rets)
  const sortino = dd > 0 ? (mean / dd) * Math.sqrt(252) : 0
  const calmar = mddPct < 0 ? cagrPct / Math.abs(mddPct) : null

  // 최장 낙폭 지속(거래일): 자산이 이전 고점 아래에 머문 최장 연속 구간
  let maxUw = 0
  let cur = 0
  for (const e of equity) {
    if (e.drawdownPct < 0) {
      cur++
      maxUw = Math.max(maxUw, cur)
    } else cur = 0
  }

  // 월간·연간 수익률 (월/연 마지막 거래일 NAV 기준)
  const monthEnd = new Map<string, EquityPoint>()
  const yearEnd = new Map<string, EquityPoint>()
  for (const e of equity) {
    monthEnd.set(e.date.slice(0, 7), e)
    yearEnd.set(e.date.slice(0, 4), e)
  }
  const months = [...monthEnd.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))
  const monthly: number[] = []
  for (let i = 1; i < months.length; i++) monthly.push((months[i][1].equity / months[i - 1][1].equity - 1) * 100)
  const winMonths = monthly.filter((r) => r > 0).length

  const years = [...yearEnd.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))
  const yearly: AdvancedMetrics['yearly'] = []
  let prevEq = equity[0]
  for (const [y, e] of years) {
    yearly.push({
      year: y,
      retPct: (e.equity / prevEq.equity - 1) * 100,
      benchRetPct: (e.benchmark / prevEq.benchmark - 1) * 100,
    })
    prevEq = e
  }
  const beat = yearly.filter((r) => r.retPct > r.benchRetPct).length

  return {
    ...trailingOneYear(equity),
    volPct,
    sortino,
    calmar,
    maxUnderwaterDays: maxUw,
    monthlyWinRatePct: monthly.length ? (winMonths / monthly.length) * 100 : 0,
    bestMonthPct: monthly.length ? Math.max(...monthly) : 0,
    worstMonthPct: monthly.length ? Math.min(...monthly) : 0,
    yearly,
    yearsBeatBench: `${beat}/${yearly.length}`,
  }
}

export function runPortfolio(modelId: string, cfg: ModelConfig, histories: Record<string, HistoryResult>): PortfolioResult {
  const meta = modelMeta(modelId)

  // 규칙형 — 후보 풀을 스크리닝해 상위 N개를 보유(종목 발굴).
  if (meta.type === 'rule') {
    const avail: Record<string, HistoryResult> = {}
    for (const s of cfg.symbols) if (histories[s]) avail[s] = histories[s]
    const r = runSignalRotation(
      avail,
      cfg.startDate,
      cfg.strategy ?? clonePreset(modelId),
      cfg.sig ?? DEFAULT_SIGNAL_ROTATION,
      cfg.settings,
    )
    const metrics = computeMetrics(r.equity, r.trades, cfg.settings.initialCapital, r.daysHolding)
    return {
      modelId,
      modelName: meta.name,
      isScreening: true,
      lastScreen: r.lastScreen,
      lastScreenDate: r.lastScreenDate,
      equity: r.equity,
      metrics,
      advanced: computeAdvanced(r.equity, metrics.cagrPct, metrics.mddPct),
      trades: r.trades,
      events: r.events,
      sleeves: [],
      startDate: r.startDate,
      endDate: r.endDate,
      universe: r.universe,
    }
  }

  // 로테이션형은 후보 풀 전체가 하나의 포트폴리오다(슬리브 분할 아님).
  if (meta.type === 'rotation') {
    const avail: Record<string, HistoryResult> = {}
    for (const s of cfg.symbols) if (histories[s]) avail[s] = histories[s]
    const r = runRotation(avail, cfg.startDate, cfg.rot ?? DEFAULT_ROTATION, cfg.settings)
    const metrics = computeMetrics(r.equity, r.trades, cfg.settings.initialCapital, r.daysHolding)
    return {
      modelId,
      modelName: meta.name,
      isRotation: true,
      lastSelection: r.lastSelection,
      lastSelectionDate: r.lastSelectionDate,
      equity: r.equity,
      metrics,
      advanced: computeAdvanced(r.equity, metrics.cagrPct, metrics.mddPct),
      trades: r.trades,
      events: r.events,
      sleeves: [],
      startDate: r.startDate,
      endDate: r.endDate,
      universe: r.universe,
    }
  }

  const universe = cfg.symbols.filter((s) => histories[s])
  if (universe.length === 0) throw new Error('유니버스 종목의 시세 데이터를 하나도 불러오지 못했습니다')
  const sleeveCapital = cfg.settings.initialCapital / universe.length

  const sleeves: SleeveOutcome[] = universe.map((symbol) => ({
    symbol,
    res: runSleeve(modelId, cfg, histories[symbol], sleeveCapital),
  }))

  const equity = aggregateEquity(sleeves, sleeveCapital)

  const trades: Trade[] = sleeves
    .flatMap((s) => s.res.trades.map((t) => ({ ...t, symbol: s.symbol })))
    .sort((a, b) => (a.entryDate < b.entryDate ? -1 : 1))
  const events: SimEvent[] = sleeves
    .flatMap((s) => (s.res.events ?? []).map((e) => ({ ...e, symbol: s.symbol })))
    .sort((a, b) => (a.date < b.date ? -1 : 1))

  const meanExposure = sleeves.reduce((s, x) => s + x.res.metrics.exposurePct, 0) / sleeves.length
  const daysHolding = Math.round((meanExposure / 100) * equity.length)
  const metrics = computeMetrics(equity, trades, cfg.settings.initialCapital, daysHolding)
  const advanced = computeAdvanced(equity, metrics.cagrPct, metrics.mddPct)

  return {
    modelId,
    modelName: meta.name,
    equity,
    metrics,
    advanced,
    trades,
    events,
    sleeves,
    startDate: equity[0].date,
    endDate: equity[equity.length - 1].date,
    universe,
  }
}
