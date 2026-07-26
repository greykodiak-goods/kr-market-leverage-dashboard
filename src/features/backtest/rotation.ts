// 종목선정(로테이션) 엔진 — 후보 풀에서 모델이 스스로 종목을 고른다.
//
// 기존 규칙형/알고리즘형 엔진은 "정해진 종목을 언제 사고 팔까"를 풀었다면,
// 이 엔진은 "어떤 종목을 들고 있을까"를 푼다(횡단면 cross-sectional 선택).
// 리밸런싱일마다 후보를 점수로 줄 세워 상위 N개만 보유하고 나머지는 판다.
//
// ── 미래참조 금지 (CLAUDE.md 규칙 1) ────────────────────────────────────
//  · 리밸런싱일 d의 점수·필터는 d 종가까지의 데이터만 사용한다.
//  · 결정은 d 종가, 체결은 d+1 시가(+슬리피지). 당일 종가를 보고 당일 시가에
//    샀다는 계산은 하지 않는다.
//  · 롤링 극값(52주 고/저)은 당일을 제외한 직전 N일로 계산한다(series.ts).
//  · 마지막 봉에서는 체결할 다음 봉이 없으므로 신규 편입을 만들지 않는다.
//
// ── 생존편향 경고 ──────────────────────────────────────────────────────
// 후보 풀을 "지금 살아있는 종목"으로 구성하면 상장폐지·부실화된 종목이 빠져
// 성적이 실제보다 좋게 나온다. 종목선정 전략에서 특히 심각하며, 화면에 항상
// 병기한다.

import type { HistoryResult, DailyBar } from '../../lib/history'
import type { EquityPoint, SimEvent, SimSettings, Trade } from './types'
import { operandSeries } from './series'

export type ScoreMethod = 'momentum' | 'sharpe'
export type AbsoluteFilter = 'none' | 'positive' | 'aboveSMA'

export interface RotationParams {
  lookbackDays: number // 점수 측정 기간 (252 ≈ 12개월)
  skipDays: number // 최근 N일 제외 (21 ≈ 1개월 — 단기 반전 회피, 학술 표준)
  topN: number // 보유 종목 수
  rebalanceDays: number // 리밸런싱 주기(거래일, 21 ≈ 1개월)
  scoreMethod: ScoreMethod
  absoluteFilter: AbsoluteFilter // 절대 모멘텀 게이트 (하락장 현금 회피)
  absSmaPeriod: number // aboveSMA 필터용 기간
  trendTemplate: boolean // 미너비니 추세 템플릿 필터 적용
}

export const DEFAULT_ROTATION: RotationParams = {
  lookbackDays: 252,
  skipDays: 21,
  topN: 1,
  rebalanceDays: 21,
  scoreMethod: 'momentum',
  absoluteFilter: 'positive',
  absSmaPeriod: 200,
  trendTemplate: false,
}

export interface Candidate {
  symbol: string
  score: number | null // null = 계산 불가(데이터 부족)
  passed: boolean // 절대 필터 + 추세 템플릿 통과 여부
  reasons: string[] // 탈락 사유 (통과 시 빈 배열)
  rank: number | null
}

export interface RotationResult {
  equity: EquityPoint[]
  trades: Trade[]
  events: SimEvent[]
  daysHolding: number
  universe: string[]
  startDate: string
  endDate: string
  lastSelection: Candidate[] // 최신 리밸런싱 시점의 후보 평가 (설명용)
  lastSelectionDate: string
}

// 심볼별 지표 접근을 캘린더 인덱스로 정렬해 두는 헬퍼.
interface Aligned {
  symbol: string
  bars: DailyBar[]
  idxAt: number[] // 캘린더 k → 그 날짜 이하의 마지막 봉 인덱스 (-1 = 없음)
  hasBarAt: boolean[] // 캘린더 k에 정확히 그 날짜 봉이 있는가 (체결 가능 여부)
  sma: Record<number, (number | null)[]>
  high252: (number | null)[]
  low252: (number | null)[]
}

function alignToCalendar(symbol: string, bars: DailyBar[], calendar: string[], smaPeriods: number[]): Aligned {
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
  const sma: Record<number, (number | null)[]> = {}
  for (const period of smaPeriods) sma[period] = operandSeries(bars, { kind: 'SMA', period })
  return {
    symbol,
    bars,
    idxAt,
    hasBarAt,
    sma,
    high252: operandSeries(bars, { kind: 'HIGHEST', period: 252 }),
    low252: operandSeries(bars, { kind: 'LOWEST', period: 252 }),
  }
}

function stdev(xs: number[]): number {
  if (xs.length < 2) return 0
  const m = xs.reduce((s, v) => s + v, 0) / xs.length
  return Math.sqrt(xs.reduce((s, v) => s + (v - m) ** 2, 0) / (xs.length - 1))
}

// bars[0..i]만 사용해 점수를 낸다.
function scoreAt(a: Aligned, i: number, p: RotationParams): number | null {
  const end = i - p.skipDays
  const start = end - p.lookbackDays
  if (start < 0 || end < 0) return null
  const pe = a.bars[end].c
  const ps = a.bars[start].c
  if (!(pe > 0 && ps > 0)) return null
  const ret = pe / ps - 1
  if (p.scoreMethod === 'momentum') return ret
  // sharpe: 같은 구간의 일간 수익률 변동성으로 나눈다(위험조정 모멘텀)
  const rets: number[] = []
  for (let j = start + 1; j <= end; j++) {
    const prev = a.bars[j - 1].c
    if (prev > 0) rets.push(a.bars[j].c / prev - 1)
  }
  const sd = stdev(rets)
  return sd > 0 ? ret / (sd * Math.sqrt(252)) : null
}

// 미너비니 추세 템플릿 (Think & Trade Like a Champion) — 절대 기준 7항목.
// RS 등급(8번째 항목)은 후보 풀 내 상대순위로 대체한다.
function trendTemplateFail(a: Aligned, i: number): string[] {
  const fails: string[] = []
  const c = a.bars[i].c
  const s50 = a.sma[50][i]
  const s150 = a.sma[150][i]
  const s200 = a.sma[200][i]
  const s200Prev = i >= 21 ? a.sma[200][i - 21] : null
  const hi = a.high252[i]
  const lo = a.low252[i]
  if (s50 == null || s150 == null || s200 == null || hi == null || lo == null) return ['데이터 부족(200일 이평 미형성)']
  if (!(c > s150 && c > s200)) fails.push('종가가 150·200일선 위가 아님')
  if (!(s150 > s200)) fails.push('150일선 < 200일선')
  if (!(s200Prev != null && s200 > s200Prev)) fails.push('200일선 상승 추세 아님(1개월)')
  if (!(s50 > s150 && s50 > s200)) fails.push('50일선이 150·200일선 위가 아님')
  if (!(c > s50)) fails.push('종가가 50일선 아래')
  if (!(c >= lo * 1.3)) fails.push('52주 최저 대비 30% 미만 상승')
  if (!(c >= hi * 0.75)) fails.push('52주 최고 대비 25% 넘게 하락')
  return fails
}

function evaluate(a: Aligned, k: number, p: RotationParams): Candidate {
  const i = a.idxAt[k]
  if (i < 0) return { symbol: a.symbol, score: null, passed: false, reasons: ['데이터 없음'], rank: null }

  const score = scoreAt(a, i, p)
  const reasons: string[] = []
  if (score == null) reasons.push('데이터 부족(측정 기간 미달)')

  if (p.trendTemplate) reasons.push(...trendTemplateFail(a, i))

  if (p.absoluteFilter === 'positive' && score != null && score <= 0) {
    reasons.push('절대 모멘텀 음수(하락 추세)')
  } else if (p.absoluteFilter === 'aboveSMA') {
    const s = a.sma[p.absSmaPeriod]?.[i]
    if (s == null) reasons.push(`${p.absSmaPeriod}일선 미형성`)
    else if (!(a.bars[i].c > s)) reasons.push(`종가가 ${p.absSmaPeriod}일선 아래`)
  }

  return { symbol: a.symbol, score, passed: reasons.length === 0, reasons, rank: null }
}

export function runRotation(
  histories: Record<string, HistoryResult>,
  startDate: string,
  params: RotationParams,
  settings: SimSettings,
): RotationResult {
  const symbols = Object.keys(histories).filter((s) => histories[s]?.bars?.length > 0)
  if (symbols.length === 0) throw new Error('후보 풀의 시세 데이터를 하나도 불러오지 못했습니다')

  // 공통 거래 캘린더 = 전 종목 날짜의 합집합
  const dateSet = new Set<string>()
  for (const s of symbols) for (const b of histories[s].bars) dateSet.add(b.date)
  const calendar = [...dateSet].sort()

  const smaPeriods = [50, 150, 200, params.absSmaPeriod]
  const aligned: Record<string, Aligned> = {}
  for (const s of symbols) aligned[s] = alignToCalendar(s, histories[s].bars, calendar, smaPeriods)

  // 시작 지점 — 지표 워밍업(최장 lookback+skip, 추세템플릿이면 200일)을 확보
  const warmup = Math.max(params.lookbackDays + params.skipDays, params.trendTemplate ? 221 : 0, 60)
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

  let pendingTargets: string[] | null = null
  let lastSelection: Candidate[] = []
  let lastSelectionDate = ''

  // 벤치마크 = 후보 풀 전체 균등 보유. "종목을 고른 것이 그냥 다 들고 있는
  // 것보다 나았는가"를 직접 답한다.
  const benchQty: Record<string, number> = {}
  let benchCash = settings.initialCapital
  {
    const per = settings.initialCapital / symbols.length
    for (const s of symbols) {
      const a = aligned[s]
      const i = a.idxAt[startK]
      if (i < 0) continue
      const fill = a.bars[i].c * (1 + slip)
      const q = Math.floor(per / (fill * (1 + comm)))
      if (q >= 1) {
        benchQty[s] = q
        benchCash -= q * fill * (1 + comm)
      }
    }
  }

  function lastClose(s: string, k: number): number {
    const a = aligned[s]
    const i = a.idxAt[k]
    return i >= 0 ? a.bars[i].c : 0
  }

  for (let k = startK; k < calendar.length; k++) {
    const date = calendar[k]

    // 1) 전일 결정된 목표 포트폴리오를 오늘 시가에 체결
    if (pendingTargets) {
      const targets = new Set(pendingTargets)
      // 매도 먼저 (현금 확보)
      for (const s of Object.keys(holdings)) {
        if (targets.has(s)) continue
        const a = aligned[s]
        if (!a.hasBarAt[k]) continue // 오늘 거래 없는 종목은 다음 기회에
        const h = holdings[s]
        const fill = a.bars[a.idxAt[k]].o * (1 - slip)
        const proceeds = h.qty * fill * (1 - comm - tax)
        cash += proceeds
        trades.push({
          entryDate: h.entryDate,
          entryPrice: h.entryFill,
          qty: h.qty,
          exitDate: date,
          exitPrice: fill,
          pnl: proceeds - h.entryCost,
          pnlPct: h.entryCost > 0 ? ((proceeds - h.entryCost) / h.entryCost) * 100 : 0,
          reason: '조건 매도',
          symbol: s,
        })
        events.push({ date, action: '매도', price: fill, qty: h.qty, note: '리밸런싱 제외', symbol: s })
        delete holdings[s]
      }
      // 매수 — 목표 종목 수로 균등 배분
      const toBuy = pendingTargets.filter((s) => !holdings[s] && aligned[s].hasBarAt[k])
      if (toBuy.length > 0) {
        const slotValue = cash / toBuy.length
        for (const s of toBuy) {
          const a = aligned[s]
          const fill = a.bars[a.idxAt[k]].o * (1 + slip)
          const q = Math.floor(slotValue / (fill * (1 + comm)))
          if (q < 1) continue
          const cost = q * fill * (1 + comm)
          cash -= cost
          holdings[s] = { qty: q, entryFill: fill, entryCost: cost, entryDate: date }
          events.push({ date, action: '매수', price: fill, qty: q, note: '리밸런싱 편입', symbol: s })
        }
      }
      pendingTargets = null
    }

    // 2) 리밸런싱일이면 오늘 종가 기준으로 다음 목표를 정한다(체결은 내일 시가)
    const isRebalance = (k - startK) % params.rebalanceDays === 0
    if (isRebalance && k < calendar.length - 1) {
      const cands = symbols.map((s) => evaluate(aligned[s], k, params))
      const eligible = cands.filter((c) => c.passed && c.score != null).sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      eligible.forEach((c, idx) => (c.rank = idx + 1))
      pendingTargets = eligible.slice(0, params.topN).map((c) => c.symbol)
      lastSelection = cands.sort((a, b) => {
        if (a.passed !== b.passed) return a.passed ? -1 : 1
        return (b.score ?? -Infinity) - (a.score ?? -Infinity)
      })
      lastSelectionDate = date
    }

    // 3) 시가평가
    let holdVal = 0
    for (const s of Object.keys(holdings)) holdVal += holdings[s].qty * lastClose(s, k)
    if (holdVal > 0) daysHolding++
    const eq = cash + holdVal
    peak = Math.max(peak, eq)

    let benchVal = benchCash
    for (const s of Object.keys(benchQty)) benchVal += benchQty[s] * lastClose(s, k)

    equity.push({
      date,
      equity: eq,
      benchmark: benchVal,
      drawdownPct: peak > 0 ? ((eq - peak) / peak) * 100 : 0,
    })
  }

  // 미청산 보유 기록
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
    lastSelection,
    lastSelectionDate,
  }
}
