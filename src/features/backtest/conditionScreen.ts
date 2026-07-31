// HTS 조건검색식(급등주 단타) 검증 엔진.
//
// 대상: 영웅문4 조건식 "I and A and B and J and K"
//   I  등락률 상위 N종목
//   A  종가 하한 ~ 상한 (예: 2,000 ~ 50,000원)
//   B  양봉 (종가 > 시가)
//   J  종가가 N일 이평 상향 돌파 (예: 5일)
//   K  거래량 하한 (예: 300,000주)
//
// ⚠️ 이 엔진의 존재 이유는 "자동매매를 만들기 위해"가 아니라
//    **"이 조건식이 실제로 먹히는지 판정하기 위해"** 다.
//    검색기는 매수 신호만 준다. 수익률을 가르는 건 **매도 조건**인데 그게 없다.
//    그래서 여기서는 매도 규칙을 여러 개 만들어 같은 매수 신호 위에서 비교한다.
//
// 실계좌 경계(규칙 2): 이 파일은 시뮬레이션만 한다. 주문 API·브로커 연동·계좌
// 자격증명은 어디에도 없고, 앞으로도 이 리포에 두지 않는다.
//
// 미래참조 금지(규칙 1):
//   - 조건 판정은 종가 확정 후 → **다음 거래일 시가 체결**
//   - 이평 돌파는 당일 종가 vs 당일까지의 이평. 이평에 미래 봉이 섞이지 않는다
//   - 손절·익절은 장중 저가/고가가 닿으면 청산하되, **갭으로 관통하면 시가(불리한 쪽)** 체결
//   - 마지막 봉에서는 체결할 다음 봉이 없으므로 신규 진입을 만들지 않는다

import type { DailyBar, EquityPoint, SimEvent, Trade } from './types'
import type { CrossSection, ExitKind, ExitRule, StrategySpec } from './strategySpec'
import { SPEC_VERSION, changePctAt, evaluateEntry, evaluatePersistence } from './strategySpec'

// ---- 매도 규칙 ------------------------------------------------------------
//
// ExitKind/ExitRule 타입 정의는 strategySpec.ts 에 있다 — 스펙과 엔진이 같은
// 타입을 쓰기 위해서다. 여기서는 라벨만 둔다.

export type { ExitKind, ExitRule } from './strategySpec'

export const EXIT_LABELS: Record<ExitKind, string> = {
  stopLoss: '손절',
  takeProfit: '익절',
  maBreak: '이평 이탈',
  sameDayClose: '당일 종가 청산',
  timeExit: '기간 만료',
  trailing: '트레일링 스탑',
  conditionExit: '조건 이탈',
}

export function exitRuleLabel(r: ExitRule): string {
  switch (r.kind) {
    case 'stopLoss':
      return `손절 −${r.pct}%`
    case 'takeProfit':
      return `익절 +${r.pct}%`
    case 'maBreak':
      return r.pct ? `${r.maPeriod}일선 −${r.pct}% 이탈` : `${r.maPeriod}일선 이탈`
    case 'sameDayClose':
      return '당일 종가 청산'
    case 'timeExit':
      return `${r.days}일 보유 후 청산`
    case 'trailing':
      return `트레일링 −${r.pct}%`
    case 'conditionExit':
      return '조건 이탈 시 청산'
  }
}

// ---- 파라미터 -------------------------------------------------------------

export interface ConditionParams {
  /** I — 등락률 상위 몇 종목까지 후보로 볼 것인가 */
  topRank: number
  /** A — 종가 하한/상한 (원) */
  minClose: number
  maxClose: number
  /** B — 양봉(종가 > 시가) 요구 */
  requireBullCandle: boolean
  /** J — 이평 상향 돌파 기간 */
  maPeriod: number
  /** K — 거래량 하한 (주) */
  minVolume: number
  /** 동시 보유 종목 수 */
  maxPositions: number
  /** 매도 규칙 — 먼저 걸리는 것이 청산. 비어 있으면 청산 없음(경고 대상) */
  exits: ExitRule[]
}

export const DEFAULT_CONDITION: ConditionParams = {
  topRank: 100,
  minClose: 2000,
  maxClose: 50000,
  requireBullCandle: true,
  maPeriod: 5,
  minVolume: 300_000,
  maxPositions: 5,
  exits: [{ kind: 'stopLoss', pct: 3 }, { kind: 'maBreak', maPeriod: 5 }],
}

export interface CostSettings {
  initialCapital: number
  feePct: number // 편도 수수료 %
  taxPct: number // 매도 거래세 %
  slippagePct: number // 편도 슬리피지 %
}

// ---- 조건 판정 ------------------------------------------------------------

/** i 시점까지만 사용하는 단순이동평균. i < period-1 이면 null. */
export function smaAt(bars: DailyBar[], i: number, period: number): number | null {
  if (i < period - 1) return null
  let s = 0
  for (let k = i - period + 1; k <= i; k++) s += bars[k].c
  return s / period
}

export interface CondCheck {
  /** 조건 라벨 → 통과 여부 */
  I?: boolean
  A: boolean
  B: boolean
  J: boolean
  K: boolean
  changePct: number | null
  /** 탈락 사유(사람이 읽는) */
  reasons: string[]
}

/**
 * 한 종목이 i 시점(종가 확정)에 조건 A·B·J·K 를 만족하는가.
 * I(등락률 상위)는 종목 간 비교라 여기서 판정하지 않고 호출부에서 랭킹으로 처리한다.
 */
export function checkConditions(bars: DailyBar[], i: number, p: ConditionParams): CondCheck {
  const reasons: string[] = []
  const b = bars[i]
  const prev = i > 0 ? bars[i - 1] : null

  const A = b.c >= p.minClose && b.c <= p.maxClose
  if (!A) reasons.push(`가격대 밖(${Math.round(b.c).toLocaleString('ko-KR')}원)`)

  const B = p.requireBullCandle ? b.c > b.o : true
  if (!B) reasons.push('음봉')

  // J — 당일 종가가 이평 위, 전일 종가는 이평 아래(= 상향 돌파)
  const maNow = smaAt(bars, i, p.maPeriod)
  const maPrev = i > 0 ? smaAt(bars, i - 1, p.maPeriod) : null
  let J = false
  if (maNow == null || maPrev == null || !prev) {
    reasons.push('이평 데이터 부족')
  } else {
    J = b.c > maNow && prev.c <= maPrev
    if (!J) reasons.push(b.c > maNow ? `이미 ${p.maPeriod}일선 위(신규 돌파 아님)` : `${p.maPeriod}일선 미달`)
  }

  const K = Number.isFinite(b.v) && b.v >= p.minVolume
  if (!K) reasons.push(`거래량 미달(${Math.round(b.v).toLocaleString('ko-KR')}주)`)

  const changePct = prev && prev.c > 0 ? (b.c / prev.c - 1) * 100 : null

  return { A, B, J, K, changePct, reasons }
}

// ---- 시뮬레이션 -----------------------------------------------------------

export interface ConditionScreenRow {
  symbol: string
  changePct: number | null
  rank: number | null
  passed: boolean
  reasons: string[]
}

export interface ExitBreakdown {
  kind: ExitKind
  label: string
  count: number
  avgPnlPct: number | null
}

export interface ConditionResult {
  equity: EquityPoint[]
  trades: Trade[]
  events: SimEvent[]
  startDate: string
  endDate: string
  universe: string[]
  lastScreen: ConditionScreenRow[]
  lastScreenDate: string
  /** 어떤 매도 규칙이 몇 번 발동했고 그때 평균 손익은 얼마였나 */
  exitBreakdown: ExitBreakdown[]
  /** 미청산 상태로 끝난 포지션 수 */
  openAtEnd: number
}

interface Position {
  symbol: string
  entryDate: string
  entryPrice: number
  qty: number
  entryIdx: number // 진입 시점의 캘린더 인덱스
  peak: number // 트레일링용 최고가
  lastClose: number // 마지막으로 관측된 종가 — 봉이 없는 날(정지·캘린더 불일치) 평가에 이월
  entryWeightPct: number // 진입 직후 총자산 대비 매수금액 비중(%) — 청산 시 트레이드에 실어 표시
}

function buildCalendar(histories: Record<string, DailyBar[]>): string[] {
  const set = new Set<string>()
  for (const bars of Object.values(histories)) for (const b of bars) set.add(b.date)
  return [...set].sort()
}

/**
 * 고정 파라미터(I·A·B·J·K) → 전략 스펙 변환.
 * 기존 UI·테스트와의 호환 통로다. 새 조건식은 스펙을 직접 만든다.
 */
export function paramsToSpec(p: ConditionParams): StrategySpec {
  return {
    version: SPEC_VERSION,
    id: 'iabjk',
    name: '급등주 조건식 (I·A·B·J·K)',
    universe: {
      markets: ['KOSPI', 'KOSDAQ'],
      excludeAdministrative: true,
      excludeSuspended: true,
      excludeLiquidation: true,
      excludePreferred: true,
      excludeEtf: true,
    },
    entry: {
      op: 'and',
      nodes: [
        { op: 'cond', id: 'I', cond: { kind: 'changeRank', top: p.topRank } },
        { op: 'cond', id: 'A', cond: { kind: 'priceRange', min: p.minClose, max: p.maxClose } },
        ...(p.requireBullCandle
          ? [{ op: 'cond' as const, id: 'B', cond: { kind: 'candle' as const, bull: true } }]
          : []),
        { op: 'cond', id: 'J', cond: { kind: 'maCross' as const, period: p.maPeriod, dir: 'above' as const } },
        { op: 'cond', id: 'K', cond: { kind: 'volume' as const, min: p.minVolume } },
      ],
    },
    ranking: { by: 'changePct', dir: 'desc' },
    // maBreak에 기간이 비어 있으면 엔진 기본값이 아니라 **이 조건식의 이평 기간**을 쓴다
    exits: p.exits.map((e) => (e.kind === 'maBreak' ? { ...e, maPeriod: e.maPeriod ?? p.maPeriod } : e)),
    sizing: { maxPositions: p.maxPositions, mode: 'equalSlot' },
    execution: { timing: 'nextOpen', orderType: 'market' },
  }
}

/**
 * 조건식 백테스트 (I·A·B·J·K 고정형) — 스펙으로 변환해 runStrategySpec에 위임한다.
 * 판정 로직이 두 벌 생기지 않도록 이 함수 자체는 아무것도 계산하지 않는다.
 */
export function runConditionScreen(
  histories: Record<string, DailyBar[]>,
  startDate: string,
  p: ConditionParams,
  cost: CostSettings,
): ConditionResult {
  return runStrategySpec(histories, startDate, paramsToSpec(p), cost)
}

/**
 * 전략 스펙 백테스트 — **정본 엔진.**
 *
 * 하루의 처리 순서 (미래참조 금지):
 *   1) 전일 종가 기준으로 잡힌 진입 대기 종목을 **오늘 시가**에 체결 (timing=nextOpen)
 *   2) 보유 종목의 청산 조건을 오늘 봉으로 판정 (갭 관통 시 시가 체결)
 *   3) 오늘 종가로 내일 진입 후보를 선정 (오늘 이후 데이터는 보지 않음)
 *      timing=sameClose(LOC)면 선정 즉시 **오늘 종가**에 체결한다 — 종가로 판단해
 *      종가에 체결하는 알고리즘형이며, 종가 확정 뒤의 정보는 쓰지 않는다(규칙 1-2).
 *
 * 조건 판정은 strategySpec.evaluateEntry / evaluatePersistence **만** 쓴다.
 * 실시간 평가기가 붙어도 같은 함수를 부르므로 시뮬과 실전 판정이 갈라질 수 없다.
 * timing='intraday'는 일봉으로 검증할 수 없어 nextOpen으로 근사한다(validateSpec이 경고).
 */
export function runStrategySpec(
  histories: Record<string, DailyBar[]>,
  startDate: string,
  spec: StrategySpec,
  cost: CostSettings,
): ConditionResult {
  const maxPositions = Math.max(1, spec.sizing.maxPositions)
  // universe.symbols가 있으면 그 표본만 — 없으면 데이터에 있는 전 종목.
  // 레짐 심볼(지수)은 판정에만 쓰고 절대 매매 대상에 넣지 않는다.
  const wanted = spec.universe.symbols?.length ? new Set(spec.universe.symbols) : null
  const universe = Object.keys(histories)
    .filter((s) => (!wanted || wanted.has(s)) && s !== spec.regime?.symbol)
    .sort()
  const regimeBars = spec.regime ? histories[spec.regime.symbol] : undefined
  const regimeIdx = new Map<string, number>()
  regimeBars?.forEach((b, i) => regimeIdx.set(b.date, i))
  const scoped: Record<string, DailyBar[]> = {}
  for (const s of universe) scoped[s] = histories[s]
  const calendar = buildCalendar(scoped).filter((d) => d >= startDate)
  const trades: Trade[] = []
  const events: SimEvent[] = []
  const equity: EquityPoint[] = []
  const exitCounts = new Map<ExitKind, { n: number; sum: number }>()

  let cash = cost.initialCapital
  const positions = new Map<string, Position>()
  let pending: string[] = [] // 전일 선정 → 오늘 시가 진입
  let peakEquity = cost.initialCapital
  let lastScreen: ConditionScreenRow[] = []
  let lastScreenDate = ''

  // 종목별 날짜 인덱스 (그날 봉이 있는지, 있으면 몇 번째인지)
  const idxOf: Record<string, Map<string, number>> = {}
  for (const s of universe) {
    const m = new Map<string, number>()
    histories[s].forEach((b, i) => m.set(b.date, i))
    idxOf[s] = m
  }

  const buyCost = (px: number) => px * (1 + cost.slippagePct / 100) // 매수는 불리하게 위로
  const sellCost = (px: number) => px * (1 - cost.slippagePct / 100) // 매도는 불리하게 아래로

  for (let d = 0; d < calendar.length; d++) {
    const date = calendar[d]
    const isLast = d === calendar.length - 1

    // ---- 1) 대기 종목 시가 진입 (timing=nextOpen) --------------------------
    for (const sym of pending) {
      if (positions.size >= maxPositions) break
      const bi = idxOf[sym].get(date)
      if (bi == null) continue // 그날 거래 없음(정지 등) → 진입 취소
      const bar = histories[sym][bi]
      enterPosition(sym, bar.o, date, d, bar.h, '조건 충족 → 익일 시가')
    }
    pending = []

    // ---- 2) 보유 종목 청산 판정 -------------------------------------------
    for (const [sym, pos] of [...positions]) {
      const bi = idxOf[sym].get(date)
      if (bi == null) continue
      const bar = histories[sym][bi]
      if (bar.h > pos.peak) pos.peak = bar.h
      if (d === pos.entryIdx) {
        // 진입 당일 — sameDayClose 만 평가 (손절/익절도 당일 장중 발동 가능하나,
        // 시가 진입 직후의 장중 경로를 일봉으로는 알 수 없어 보수적으로 다음날부터 본다)
        const sameDay = spec.exits.find((e) => e.kind === 'sameDayClose')
        if (sameDay) closePosition(sym, pos, bar.c, date, 'sameDayClose', bar)
        continue
      }

      let fired: { kind: ExitKind; price: number } | null = null
      for (const rule of spec.exits) {
        if (fired) break
        switch (rule.kind) {
          case 'stopLoss': {
            const line = pos.entryPrice * (1 - (rule.pct ?? 0) / 100)
            if (bar.l <= line) {
              // 갭으로 관통했으면 기준가가 아니라 시가(더 불리한 쪽)
              fired = { kind: 'stopLoss', price: bar.o < line ? bar.o : line }
            }
            break
          }
          case 'takeProfit': {
            const line = pos.entryPrice * (1 + (rule.pct ?? 0) / 100)
            if (bar.h >= line) {
              // 위로 갭이면 시가가 기준선보다 높다 — 매도엔 유리하지만 보수적으로 기준선 체결
              fired = { kind: 'takeProfit', price: bar.o > line ? line : line }
            }
            break
          }
          case 'trailing': {
            const line = pos.peak * (1 - (rule.pct ?? 0) / 100)
            if (bar.l <= line) fired = { kind: 'trailing', price: bar.o < line ? bar.o : line }
            break
          }
          case 'maBreak': {
            // 전일 종가가 이평 아래로 떨어졌으면 오늘 시가 청산 (종가 판단 → 익일 체결).
            // rule.pct = 이탈 버퍼(%) — 이평을 살짝 스치는 whipsaw에 잘리지 않도록
            // 이평 × (1 − pct/100) 아래로 **확실히** 깨졌을 때만 발동.
            const pi = idxOf[sym].get(calendar[d - 1])
            if (pi != null) {
              const ma = smaAt(histories[sym], pi, rule.maPeriod ?? 5)
              const line = ma != null ? ma * (1 - (rule.pct ?? 0) / 100) : null
              if (line != null && histories[sym][pi].c < line) fired = { kind: 'maBreak', price: bar.o }
            }
            break
          }
          case 'timeExit': {
            if (d - pos.entryIdx >= (rule.days ?? 1)) fired = { kind: 'timeExit', price: bar.o }
            break
          }
          case 'conditionExit': {
            // HTS 조건검색은 편입(신호 발생)뿐 아니라 **이탈**도 실시간으로 준다.
            // 이탈 = 전일 종가 기준으로 매수 조건을 더는 만족하지 않음 → 익일 시가 청산.
            // 존속 판정은 진입 조건 그대로가 아니라 evaluatePersistence의 변환표를
            // 따른다(돌파→유지, 트리거 조건 제외 — 그대로 재평가하면 진입 다음날
            // 무조건 청산되는 1일 보유 전략이 되어 버린다).
            const pi = idxOf[sym].get(calendar[d - 1])
            if (pi != null && !evaluatePersistence(spec.entry, histories[sym], pi, sym)) {
              fired = { kind: 'conditionExit', price: bar.o }
            }
            break
          }
          case 'sameDayClose':
            break // 진입 당일에만 평가
        }
      }
      if (fired) closePosition(sym, pos, fired.price, date, fired.kind, bar)
      else if (isLast) {
        // 마지막 날 미청산 — 평가만 하고 열린 채로 둔다
      }
    }

    // ---- 3) 오늘 종가로 내일 후보 선정 ------------------------------------
    // 마지막 봉에서는 체결할 다음 봉이 없으므로 신규 진입을 만들지 않는다(규칙 1-6).
    // 레짐 게이트: 지수 조건이 꺼진 날(또는 지수 봉이 없는 날 — 보수적)은
    // 신규 진입 후보를 뽑지 않는다. 청산(단계 2)은 이미 위에서 돌았다.
    const regimeOn = !spec.regime
      ? true
      : (() => {
          const ri = regimeIdx.get(date)
          if (regimeBars == null || ri == null) return false
          return evaluateEntry(spec.regime.entry, regimeBars, ri, spec.regime.symbol, null).passed
        })()
    if (!isLast && regimeOn && positions.size < maxPositions) {
      // 횡단면 — 그날 봉이 있는 종목의 등락률·거래대금 (changeRank 조건이 쓴다)
      const cs: CrossSection = { changePct: new Map(), tradingValue: new Map() }
      const todayIdx = new Map<string, number>()
      for (const sym of universe) {
        const bi = idxOf[sym].get(date)
        if (bi == null) continue
        todayIdx.set(sym, bi)
        const ch = changePctAt(histories[sym], bi)
        if (ch != null) cs.changePct.set(sym, ch)
        const b = histories[sym][bi]
        cs.tradingValue!.set(sym, b.c * b.v)
      }
      const rows: ConditionScreenRow[] = []
      for (const [sym, bi] of todayIdx) {
        const r = evaluateEntry(spec.entry, histories[sym], bi, sym, cs)
        rows.push({
          symbol: sym,
          changePct: cs.changePct.get(sym) ?? null,
          rank: null,
          passed: r.passed,
          reasons: r.detail.filter((x) => !x.passed).map((x) => `${x.label} 미충족${x.value ? ` (${x.value})` : ''}`),
        })
      }
      // 랭킹 — 후보가 슬롯보다 많을 때의 우선순위 (rank는 표시용)
      const rankKey = (row: ConditionScreenRow): number => {
        if (!spec.ranking || spec.ranking.by === 'none') return 0
        if (spec.ranking.by === 'changePct') return row.changePct ?? -Infinity
        const b = histories[row.symbol][todayIdx.get(row.symbol)!]
        return spec.ranking.by === 'tradingValue' ? b.c * b.v : b.v
      }
      const dir = spec.ranking?.dir === 'asc' ? 1 : -1
      const ranked =
        spec.ranking && spec.ranking.by !== 'none'
          ? [...rows].sort((a, b) => {
              const ka = rankKey(a)
              const kb = rankKey(b)
              return ka === kb ? 0 : (ka - kb) * dir
            })
          : rows
      ranked.forEach((r, i) => (r.rank = i + 1))
      const picks = ranked
        .filter((r) => r.passed && !positions.has(r.symbol))
        .slice(0, maxPositions - positions.size)
      if (spec.execution.timing === 'sameClose') {
        // LOC — 오늘 종가 체결. 트레일링 고점은 진입가(종가)에서 시작한다:
        // 진입 전의 장중 고가를 물려받으면 보유하지 않은 구간의 고점으로 스탑을 재는 셈이다.
        for (const r of picks) {
          if (positions.size >= maxPositions) break
          const bar = histories[r.symbol][todayIdx.get(r.symbol)!]
          enterPosition(r.symbol, bar.c, date, d, bar.c, '조건 충족 → 당일 종가(LOC)')
        }
      } else {
        pending = picks.map((r) => r.symbol)
      }
      lastScreen = ranked
      lastScreenDate = date
    }

    // ---- 자산 평가 --------------------------------------------------------
    // 봉이 없는 날(거래정지·데이터 캘린더 불일치)은 **마지막 관측 종가를 이월**한다.
    // 진입가로 되돌리면 평가액이 "시가평가 ↔ 원가" 사이를 오가며 톱니가 생긴다(2026-07-31 수정).
    let holdings = 0
    for (const [sym, pos] of positions) {
      const bi = idxOf[sym].get(date)
      if (bi != null) pos.lastClose = histories[sym][bi].c
      holdings += pos.qty * pos.lastClose
    }
    const eq = cash + holdings
    if (eq > peakEquity) peakEquity = eq
    equity.push({
      date,
      equity: eq,
      benchmark: cost.initialCapital, // 이 전략은 종목 유니버스가 매일 바뀌어 단순보유 벤치가 성립하지 않는다
      drawdownPct: peakEquity > 0 ? (eq / peakEquity - 1) * 100 : 0,
    })
  }

  function enterPosition(sym: string, rawPx: number, date: string, dayIdx: number, peakInit: number, note: string) {
    const slot = cash / Math.max(1, maxPositions - positions.size)
    const fill = buyCost(rawPx)
    const qty = Math.floor(slot / (fill * (1 + cost.feePct / 100)))
    if (qty <= 0) return
    const gross = qty * fill
    const fee = gross * (cost.feePct / 100)
    cash -= gross + fee
    const pos: Position = { symbol: sym, entryDate: date, entryPrice: fill, qty, entryIdx: dayIdx, peak: peakInit, lastClose: rawPx, entryWeightPct: 0 }
    positions.set(sym, pos)
    // 진입 직후 총자산(현금 + 전 포지션 평가 — 타 종목은 마지막 관측 종가, 신규는 체결가) 대비 비중.
    // 그 시점까지의 정보만 쓰므로 인과성(규칙 1) 유지. 표시용이며 매매 판단에 쓰지 않는다.
    let holdingsNow = 0
    for (const p of positions.values()) holdingsNow += p.qty * p.lastClose
    const eqNow = cash + holdingsNow
    pos.entryWeightPct = eqNow > 0 ? (gross / eqNow) * 100 : 0
    events.push({
      date,
      action: '매수',
      price: fill,
      qty,
      note,
      symbol: sym,
      amount: gross,
      cashAfter: cash,
      positionsAfter: positions.size,
    })
  }

  function closePosition(sym: string, pos: Position, rawPrice: number, date: string, kind: ExitKind, bar: DailyBar) {
    const fill = sellCost(rawPrice)
    const gross = pos.qty * fill
    const fee = gross * (cost.feePct / 100)
    const tax = gross * (cost.taxPct / 100)
    cash += gross - fee - tax
    positions.delete(sym)

    const entryGross = pos.qty * pos.entryPrice
    const entryFee = entryGross * (cost.feePct / 100)
    const pnl = gross - fee - tax - (entryGross + entryFee)
    const pnlPct = entryGross > 0 ? (pnl / (entryGross + entryFee)) * 100 : 0

    const agg = exitCounts.get(kind) ?? { n: 0, sum: 0 }
    agg.n++
    agg.sum += pnlPct
    exitCounts.set(kind, agg)

    trades.push({
      entryDate: pos.entryDate,
      entryPrice: pos.entryPrice,
      qty: pos.qty,
      exitDate: date,
      exitPrice: fill,
      pnl,
      pnlPct,
      reason: kind === 'stopLoss' ? '손절' : kind === 'takeProfit' ? '익절' : '조건 매도',
      symbol: sym,
      entryWeightPct: pos.entryWeightPct,
    })
    events.push({
      date,
      action: '매도',
      price: fill,
      qty: pos.qty,
      note: EXIT_LABELS[kind],
      symbol: sym,
      amount: gross,
      cashAfter: cash,
      positionsAfter: positions.size,
      full: true,
      // bar는 진단용으로만 받는다(향후 체결 품질 분석)
      ...(bar ? {} : {}),
    })
  }

  const exitBreakdown: ExitBreakdown[] = [...exitCounts.entries()].map(([kind, v]) => ({
    kind,
    label: EXIT_LABELS[kind],
    count: v.n,
    avgPnlPct: v.n > 0 ? v.sum / v.n : null,
  }))

  return {
    equity,
    trades,
    events,
    startDate: calendar[0] ?? startDate,
    endDate: calendar[calendar.length - 1] ?? startDate,
    universe,
    lastScreen,
    lastScreenDate,
    exitBreakdown,
    openAtEnd: positions.size,
  }
}

// ---- 실시간(오늘) 스크리닝 -------------------------------------------------

export interface DateScreen {
  date: string
  /** 랭킹 순 전 종목 (통과·탈락 모두 — 왜 걸렸나/떨어졌나 근거 포함) */
  rows: ConditionScreenRow[]
  /** 통과 종목만 랭킹 순으로 */
  passed: string[]
  /** 레짐 게이트가 꺼져 있어 후보를 뽑지 않은 날인가 */
  regimeOff: boolean
}

/**
 * **지정한 날짜 하루치 진입 스크리닝** — 백테스트가 아니라 "오늘 무엇을 살까"에 답한다.
 *
 * 왜 별도 함수가 필요한가:
 *   runStrategySpec 은 규칙 1-6에 따라 **데이터 마지막 봉에서 신규 진입을 만들지 않는다**
 *   (백테스트에서는 체결할 다음 봉이 없으므로 옳다). 그래서 오늘까지의 데이터를 넣고
 *   돌리면 오늘의 진입 신호는 **구조적으로 항상 비어 있다.** 실전 러너가 그 결과에서
 *   오늘 진입을 뽑으려 하면 영원히 아무것도 사지 않는다.
 *   실제 운용에서는 오늘 종가(LOC) 체결이 가능하므로, 오늘 신호는 여기서 따로 판정한다.
 *
 * 미래참조 금지(규칙 1): 판정은 strategySpec.evaluateEntry **하나만** 쓰고 bars[0..i]만
 *   본다(i = 그 날짜의 인덱스). 그래서 date 이후의 봉이 있든 없든 결과가 같다 —
 *   tests/mock-ledger.test.ts 의 절단 불변성 케이스가 이를 강제한다.
 *   횡단면(등락률·거래대금)도 그날 값만 쓴다.
 *
 * 이 함수는 **후보만** 돌려준다. 슬롯·현금·보유 중복 판정은 호출자(장부)의 몫이다.
 */
export function screenOnDate(
  histories: Record<string, DailyBar[]>,
  spec: StrategySpec,
  date: string,
): DateScreen {
  const wanted = spec.universe.symbols?.length ? new Set(spec.universe.symbols) : null
  const universe = Object.keys(histories)
    .filter((s) => (!wanted || wanted.has(s)) && s !== spec.regime?.symbol)
    .sort()

  // 레짐 게이트 — 지수 조건이 꺼진 날(또는 지수 봉이 없는 날)은 신규 후보를 뽑지 않는다.
  let regimeOff = false
  if (spec.regime) {
    const rb = histories[spec.regime.symbol]
    const ri = rb?.findIndex((b) => b.date === date) ?? -1
    regimeOff = ri < 0 || !evaluateEntry(spec.regime.entry, rb, ri, spec.regime.symbol, null).passed
  }
  if (regimeOff) return { date, rows: [], passed: [], regimeOff: true }

  const todayIdx = new Map<string, number>()
  const cs: CrossSection = { changePct: new Map(), tradingValue: new Map() }
  for (const sym of universe) {
    const bars = histories[sym]
    const bi = bars.findIndex((b) => b.date === date)
    if (bi < 0) continue // 그날 봉이 없는 종목(휴장·정지)은 판정하지 않는다
    todayIdx.set(sym, bi)
    const ch = changePctAt(bars, bi)
    if (ch != null) cs.changePct.set(sym, ch)
    cs.tradingValue!.set(sym, bars[bi].c * bars[bi].v)
  }

  const rows: ConditionScreenRow[] = []
  for (const [sym, bi] of todayIdx) {
    const r = evaluateEntry(spec.entry, histories[sym], bi, sym, cs)
    rows.push({
      symbol: sym,
      changePct: cs.changePct.get(sym) ?? null,
      rank: null,
      passed: r.passed,
      reasons: r.detail.filter((x) => !x.passed).map((x) => `${x.label} 미충족${x.value ? ` (${x.value})` : ''}`),
    })
  }

  // 랭킹 — runStrategySpec 의 후보 정렬과 **같은 규칙**(그래야 시뮬과 실전이 갈라지지 않는다)
  const rankKey = (row: ConditionScreenRow): number => {
    if (!spec.ranking || spec.ranking.by === 'none') return 0
    if (spec.ranking.by === 'changePct') return row.changePct ?? -Infinity
    const b = histories[row.symbol][todayIdx.get(row.symbol)!]
    return spec.ranking.by === 'tradingValue' ? b.c * b.v : b.v
  }
  const dir = spec.ranking?.dir === 'asc' ? 1 : -1
  const ranked =
    spec.ranking && spec.ranking.by !== 'none'
      ? [...rows].sort((a, b) => {
          const ka = rankKey(a)
          const kb = rankKey(b)
          return ka === kb ? 0 : (ka - kb) * dir
        })
      : rows
  ranked.forEach((r, i) => (r.rank = i + 1))

  return { date, rows: ranked, passed: ranked.filter((r) => r.passed).map((r) => r.symbol), regimeOff: false }
}

// ---- 매도 규칙 비교 -------------------------------------------------------

export interface ExitComparisonRow {
  label: string
  exits: ExitRule[]
  totalReturnPct: number
  mddPct: number
  tradeCount: number
  winRatePct: number
  avgHoldDays: number | null
}

/**
 * 같은 매수 신호 위에서 매도 규칙만 바꿔 돌린다.
 * 검색기는 매수만 주므로 **여기가 수익률을 가르는 지점**이라는 것이 이 함수의 요지.
 */
export const EXIT_PRESETS: { label: string; exits: ExitRule[] }[] = [
  { label: '당일 종가 청산', exits: [{ kind: 'sameDayClose' }] },
  { label: '손절 −3%', exits: [{ kind: 'stopLoss', pct: 3 }] },
  { label: '손절 −5%', exits: [{ kind: 'stopLoss', pct: 5 }] },
  { label: '5일선 이탈', exits: [{ kind: 'maBreak', maPeriod: 5 }] },
  { label: '손절 −3% + 익절 +5%', exits: [{ kind: 'stopLoss', pct: 3 }, { kind: 'takeProfit', pct: 5 }] },
  { label: '손절 −3% + 5일선 이탈', exits: [{ kind: 'stopLoss', pct: 3 }, { kind: 'maBreak', maPeriod: 5 }] },
  { label: '트레일링 −5%', exits: [{ kind: 'trailing', pct: 5 }] },
  { label: '3일 보유', exits: [{ kind: 'timeExit', days: 3 }] },
  { label: '조건 이탈', exits: [{ kind: 'conditionExit' }] },
  { label: '손절 −3% + 조건 이탈', exits: [{ kind: 'stopLoss', pct: 3 }, { kind: 'conditionExit' }] },
  { label: '청산 없음(대조군)', exits: [] },
]

export function compareExits(
  histories: Record<string, DailyBar[]>,
  startDate: string,
  base: ConditionParams,
  cost: CostSettings,
  presets = EXIT_PRESETS,
): ExitComparisonRow[] {
  return presets.map((preset) => {
    const r = runConditionScreen(histories, startDate, { ...base, exits: preset.exits }, cost)
    const closed = r.trades.filter((t) => t.exitDate != null)
    const wins = closed.filter((t) => (t.pnlPct ?? 0) > 0).length
    const finalEq = r.equity.length ? r.equity[r.equity.length - 1].equity : cost.initialCapital
    const mdd = r.equity.reduce((m, e) => Math.min(m, e.drawdownPct), 0)
    const holdDays = closed.length
      ? closed.reduce((s, t) => {
          const a = r.equity.findIndex((e) => e.date === t.entryDate)
          const b = r.equity.findIndex((e) => e.date === t.exitDate)
          return s + (a >= 0 && b >= 0 ? b - a : 0)
        }, 0) / closed.length
      : null
    return {
      label: preset.label,
      exits: preset.exits,
      totalReturnPct: (finalEq / cost.initialCapital - 1) * 100,
      mddPct: mdd,
      tradeCount: closed.length,
      winRatePct: closed.length ? (wins / closed.length) * 100 : 0,
      avgHoldDays: holdDays,
    }
  })
}
