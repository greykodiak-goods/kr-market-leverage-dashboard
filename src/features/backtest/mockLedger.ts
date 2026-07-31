// 모의계좌 1개를 "전략별 가상 서브포트폴리오"로 쪼개 굴리는 **장부(ledger)** — 순수 로직.
//
// 왜 장부인가:
//   키움 모의계좌는 1개(현금 1억)뿐이고 계좌 분할이 안 된다. 그런데 우리가 알고 싶은 것은
//   "어느 기법이 더 나은가"이지 "합쳐서 얼마 벌었나"가 아니다(규칙 5 — 성과 판정은 알파로).
//   그래서 **계좌는 하나로 두되 장부를 다섯 개로 나눈다.** 주문은 전략 태그를 달아 한 계좌로
//   나가고, 성과는 장부에서 전략별로 분리 집계한다.
//
// 이 파일에 없는 것: 네트워크·주문·시크릿·파일 IO. 전부 순수 함수라 tests/mock-ledger.test.ts가
//   네트워크 없이 전 경로를 검증한다. 주문 게이트는 scripts/lib/kiwoomOrder.mjs 한 곳이며
//   이 파일은 그것을 우회하지 않는다(장부는 "게이트를 통과한 주문"만 반영한다 — 러너 책임).
//
// 회계는 새로 짜지 않고 검증된 paperTrading.applyFill 을 그대로 쓴다(수수료·거래세·현금부족·
//   보유초과 거부가 이미 papertrading.test.ts 로 고정돼 있다). 이 파일은 그 위에
//   ① 전략별 분리 ② 진입일 ③ 매매기록 ④ 자산곡선 ⑤ 계좌 제약(현금·실보유) 반영만 얹는다.
//
// 한계(규칙 3 — 데이터 정직성):
//   장부는 **전송가 = 체결가**로 가정한다. 지정가 미체결·부분체결·실제 체결가 차이는 반영되지
//   않는다. 그 괴리를 재는 것이 2단계 게이트(슬리피지·미체결률 실측)의 목적이므로, 장부 수치는
//   "가정 체결 기준"이라고 못 박아 표기한다.

import { applyFill, type PaperCost, type PaperJournal, type PaperSide } from './paperTrading'

export const MOCK_LEDGER_VERSION = 1 as const

// ---- 설정 (public/data/mock-live/config.json) -------------------------------

export interface MockStrategyConfig {
  id: string
  label: string
  /** 'spec'(엔진 재계산, 기본) | 'benchHold'(첫 실행일 매수 후 보유 — 알파 대조군) */
  type?: 'spec' | 'benchHold'
  /** spec: 진입 이평 기간 */
  entryMa?: number
  /** spec: public/data/paper/config.json 의 트랙 id (유니버스 단일 원본 — 중복 저장 금지) */
  universe?: string
  /** spec: 진입 조건에 거래량 급증(20일 평균 1.5배)을 AND 로 추가 */
  volumeSurge?: boolean
  /** benchHold: 매수할 심볼 */
  symbol?: string
}

export interface MockLiveConfig {
  inception: string
  perStrategyCapitalKrw: number
  /** 전략별 슬롯 수 (기본 10 — 슬롯당 자본 = 전략자본 ÷ 슬롯) */
  slotsPerStrategy?: number
  strategies: MockStrategyConfig[]
}

export const DEFAULT_SLOTS = 10

// ---- 장부 -------------------------------------------------------------------

export interface LedgerPosition {
  symbol: string
  qty: number
  /** 평균 단가 — 수수료 포함 */
  avgPrice: number
  /** 누적 투입 원금(수수료 포함) */
  costBasis: number
  /** 이 포지션을 처음 잡은 날 (전량 청산 시 사라진다) */
  entryDate: string
}

export interface LedgerTrade {
  date: string
  strategyId: string
  symbol: string
  side: 'buy' | 'sell'
  qty: number
  /** 가정 체결가 = 주문 전송가 */
  price: number
  amountKrw: number
  /** 매도만 — 실현손익(수수료·세금 차감 후). 매수는 null */
  realizedPnl: number | null
  reason: string
}

export interface LedgerEquityPoint {
  date: string
  equity: number
}

export interface StrategyLedger {
  id: string
  label: string
  inception: string
  initialCapital: number
  cash: number
  positions: LedgerPosition[]
  trades: LedgerTrade[]
  /** 실현손익 누계 */
  realizedPnl: number
  equityHistory: LedgerEquityPoint[]
}

export interface MockLedger {
  version: typeof MOCK_LEDGER_VERSION
  inception: string
  updatedAt: string | null
  /** 같은 날 두 번 돌려 장부가 이중 반영되는 사고를 막는 표식 */
  lastRunDate: string | null
  strategies: Record<string, StrategyLedger>
}

function newStrategyLedger(c: MockStrategyConfig, capital: number, inception: string): StrategyLedger {
  return {
    id: c.id,
    label: c.label,
    inception,
    initialCapital: capital,
    cash: capital,
    positions: [],
    trades: [],
    realizedPnl: 0,
    equityHistory: [],
  }
}

/** config 로 빈 장부를 만든다. */
export function initLedger(config: MockLiveConfig): MockLedger {
  const strategies: Record<string, StrategyLedger> = {}
  for (const s of config.strategies) {
    strategies[s.id] = newStrategyLedger(s, config.perStrategyCapitalKrw, config.inception)
  }
  return {
    version: MOCK_LEDGER_VERSION,
    inception: config.inception,
    updatedAt: null,
    lastRunDate: null,
    strategies,
  }
}

/**
 * 기존 장부에 config 를 맞춘다 — **전략 교체 가능**이 요구사항이므로
 *   - config 에 새로 생긴 전략: 초기자본으로 신설(개시일은 오늘 — 나중에 붙은 전략을
 *     처음부터 굴린 것처럼 보이게 하지 않는다)
 *   - config 에서 빠진 전략: **지우지 않는다.** 과거 성과 기록을 말없이 없애는 것은
 *     데이터 정직성 위반이라, retired 로 남기고 요약에서 구분해 표시한다.
 *   - 라벨은 config 를 따라간다(표기 변경은 성과에 영향 없음).
 */
export function syncLedger(ledger: MockLedger, config: MockLiveConfig, today: string): { ledger: MockLedger; added: string[]; retired: string[] } {
  const strategies: Record<string, StrategyLedger> = {}
  const added: string[] = []
  const configured = new Set(config.strategies.map((s) => s.id))
  for (const s of config.strategies) {
    const cur = ledger.strategies[s.id]
    if (cur) strategies[s.id] = { ...cur, label: s.label }
    else {
      strategies[s.id] = newStrategyLedger(s, config.perStrategyCapitalKrw, today)
      added.push(s.id)
    }
  }
  const retired = Object.keys(ledger.strategies).filter((id) => !configured.has(id))
  for (const id of retired) strategies[id] = ledger.strategies[id]
  return { ledger: { ...ledger, inception: ledger.inception ?? config.inception, strategies }, added, retired }
}

// ---- 체결 반영 --------------------------------------------------------------

export interface LedgerFill {
  date: string
  symbol: string
  side: 'buy' | 'sell'
  qty: number
  /** 가정 체결가 = 주문 전송가 */
  price: number
  reason: string
}

const SIDE_KO: Record<'buy' | 'sell', PaperSide> = { buy: '매수', sell: '매도' }

/** StrategyLedger → paperTrading 저널 뷰 (회계 로직을 한 곳에 두기 위한 어댑터) */
function toJournal(s: StrategyLedger): PaperJournal {
  return {
    strategyId: s.id,
    startedAt: s.inception,
    initialCapital: s.initialCapital,
    cash: s.cash,
    positions: s.positions.map((p) => ({ symbol: p.symbol, qty: p.qty, avgPrice: p.avgPrice, costBasis: p.costBasis })),
    fills: [],
    realizedPnl: s.realizedPnl,
  }
}

/**
 * 체결 1건을 전략 장부에 반영한다. **순수 함수** — 새 장부를 돌려주고 원본은 건드리지 않는다.
 * 현금 부족·보유 없음·보유 초과·수량/가격 오류는 paperTrading.applyFill 이 거부하며,
 * 거부된 건은 매매기록에도 남지 않는다(장부가 실전보다 관대하면 의미가 없다).
 */
export function applyLedgerFill(
  s: StrategyLedger,
  f: LedgerFill,
  cost: PaperCost,
): { ledger: StrategyLedger; rejected?: string } {
  const before = toJournal(s)
  const { journal, rejected } = applyFill(
    before,
    {
      signalAt: f.date,
      filledAt: f.date,
      symbol: f.symbol,
      side: SIDE_KO[f.side],
      qty: f.qty,
      assumedPrice: f.price,
      actualPrice: null,
      reason: f.reason,
    },
    cost,
  )
  if (rejected) return { ledger: s, rejected }

  // 진입일 보존: 기존 포지션은 그대로, 새로 생긴 포지션만 오늘로.
  const entryDates = new Map(s.positions.map((p) => [p.symbol, p.entryDate]))
  const positions: LedgerPosition[] = journal.positions.map((p) => ({
    ...p,
    entryDate: entryDates.get(p.symbol) ?? f.date,
  }))
  const realizedDelta = journal.realizedPnl - s.realizedPnl
  const trade: LedgerTrade = {
    date: f.date,
    strategyId: s.id,
    symbol: f.symbol,
    side: f.side,
    qty: f.qty,
    price: f.price,
    amountKrw: Math.round(f.qty * f.price),
    realizedPnl: f.side === 'sell' ? realizedDelta : null,
    reason: f.reason,
  }
  return {
    ledger: {
      ...s,
      cash: journal.cash,
      positions,
      realizedPnl: journal.realizedPnl,
      trades: [...s.trades, trade],
    },
  }
}

// ---- 평가 -------------------------------------------------------------------

/** 현재가 맵으로 평가. 가격이 없는 종목은 평단으로 본다(과대평가 방지 — paperTrading 과 같은 규칙). */
export function ledgerEquity(s: StrategyLedger, prices: Record<string, number>): number {
  let holdings = 0
  for (const p of s.positions) {
    const px = Number.isFinite(prices[p.symbol]) ? prices[p.symbol] : p.avgPrice
    holdings += px * p.qty
  }
  return s.cash + holdings
}

/** 자산곡선에 오늘 값을 기록한다(같은 날짜는 덮어쓴다 — 재실행해도 점이 늘지 않는다). */
export function markEquity(s: StrategyLedger, date: string, prices: Record<string, number>): StrategyLedger {
  const equity = ledgerEquity(s, prices)
  const rest = s.equityHistory.filter((e) => e.date !== date)
  const equityHistory = [...rest, { date, equity: Math.round(equity) }].sort((a, b) => (a.date < b.date ? -1 : 1))
  return { ...s, equityHistory }
}

/**
 * 슬롯 자본으로 살 수 있는 수량. 엔진(conditionScreen.enterPosition)과 **같은 규칙**을 쓴다 —
 * 남은 현금을 남은 슬롯 수로 나눈다. 그래야 시뮬과 장부가 갈라지지 않는다.
 */
export function slotQty(s: StrategyLedger, slots: number, price: number, feePct: number): number {
  if (!(price > 0) || !Number.isFinite(price)) return 0
  const openSlots = Math.max(1, slots - s.positions.length)
  const slotCash = s.cash / openSlots
  const qty = Math.floor(slotCash / (price * (1 + feePct / 100)))
  return Number.isFinite(qty) && qty > 0 ? qty : 0
}

// ---- 계좌 제약 (장부 5개 → 계좌 1개) ----------------------------------------

export interface SellRequest {
  strategyId: string
  qty: number
}

export interface AllocatedSell extends SellRequest {
  /** 계좌 실보유량 부족으로 줄었나 */
  reduced: boolean
  requested: number
}

/**
 * 같은 종목을 여러 전략이 동시에 팔 때, **계좌 실보유량을 넘지 않게** 나눈다.
 *
 * 왜 필요한가: 장부는 5개인데 계좌는 1개다. 지정가 미체결·수동 개입으로 계좌 실보유량이
 * 장부 합보다 적을 수 있고, 그대로 내면 없는 물량을 파는 주문이 된다. 부족하면 **줄인다**
 * (늘리지 않는다 — 보수적으로). accountQty 가 null 이면 잔고를 모르는 것이므로 요청대로 둔다.
 */
export function allocateSellQty(requests: SellRequest[], accountQty: number | null): AllocatedSell[] {
  const base = requests.map((r) => ({ ...r, requested: r.qty, reduced: false }))
  if (accountQty == null || !Number.isFinite(accountQty)) return base
  const total = base.reduce((s, r) => s + r.qty, 0)
  if (total <= accountQty) return base
  const avail = Math.max(0, Math.floor(accountQty))
  // 비례 축소 후 내림 → 남는 수량은 소수부가 큰 순서로 1주씩 (합계는 절대 avail 을 넘지 않는다)
  const scaled = base.map((r) => {
    const exact = total > 0 ? (r.qty * avail) / total : 0
    return { ...r, floorQty: Math.floor(exact), frac: exact - Math.floor(exact) }
  })
  let left = avail - scaled.reduce((s, r) => s + r.floorQty, 0)
  const order = [...scaled].sort((a, b) => b.frac - a.frac || (a.strategyId < b.strategyId ? -1 : 1))
  for (const r of order) {
    if (left <= 0) break
    if (r.floorQty < r.qty) {
      r.floorQty += 1
      left -= 1
    }
  }
  return scaled.map((r) => ({
    strategyId: r.strategyId,
    qty: r.floorQty,
    requested: r.requested,
    reduced: r.floorQty < r.requested,
  }))
}

export interface BuyRequest {
  strategyId: string
  symbol: string
  qty: number
  price: number
}

export interface CappedBuy extends BuyRequest {
  requested: number
  /** 계좌 현금 한도로 줄었거나(부분) 통째로 빠졌으면(0) 그 사유 */
  note: string | null
}

/**
 * 전략 합산 매수액이 **계좌 현금**을 넘지 않게 자른다. 장부별 현금은 각 장부가 이미 지켰지만,
 * 계좌는 하나라서 합이 넘칠 수 있다(특히 매도 대금이 아직 안 들어온 날).
 * 앞에서부터 채우고, 모자라면 수량을 줄이고, 1주도 못 사면 뺀다. cash 가 null 이면 자르지 않는다.
 */
export function capBuysToCash(buys: BuyRequest[], accountCashKrw: number | null): CappedBuy[] {
  if (accountCashKrw == null || !Number.isFinite(accountCashKrw)) {
    return buys.map((b) => ({ ...b, requested: b.qty, note: null }))
  }
  let left = Math.max(0, accountCashKrw)
  const out: CappedBuy[] = []
  for (const b of buys) {
    const amount = b.qty * b.price
    if (amount <= left) {
      left -= amount
      out.push({ ...b, requested: b.qty, note: null })
      continue
    }
    const fit = b.price > 0 ? Math.floor(left / b.price) : 0
    if (fit >= 1) {
      left -= fit * b.price
      out.push({ ...b, qty: fit, requested: b.qty, note: `계좌 현금 한도로 ${b.qty}→${fit}주 축소` })
    } else {
      out.push({ ...b, qty: 0, requested: b.qty, note: '계좌 현금 부족으로 제외' })
    }
  }
  return out
}

// ---- 요약 (분리된 성과 리포트 — 이 과업의 목적) ------------------------------

export interface StrategySummary {
  id: string
  label: string
  retired: boolean
  initialCapital: number
  cash: number
  equity: number
  totalPct: number
  realizedPnl: number
  positions: number
  /** 청산 완료(매도) 건수 */
  closedTrades: number
  winRatePct: number | null
  mddPct: number
  /** 벤치(benchHold 전략) 대비 누적 수익률 차이 %p. 벤치 자신은 null */
  alphaPct: number | null
  /** 연환산 알파(규칙 5) — 구간이 짧으면 과장되므로 60일 미만은 null */
  alphaAnnualizedPct: number | null
  todayOrders: LedgerTrade[]
}

export interface MockSummary {
  updatedAt: string
  date: string
  inception: string
  benchStrategyId: string | null
  dryRun: boolean
  strategies: StrategySummary[]
  totals: { equity: number; initialCapital: number; totalPct: number }
  dataNote: string
  disclaimer: string
}

function maxDrawdownPct(history: LedgerEquityPoint[]): number {
  let peak = -Infinity
  let mdd = 0
  for (const p of history) {
    peak = Math.max(peak, p.equity)
    if (peak > 0) mdd = Math.min(mdd, (p.equity / peak - 1) * 100)
  }
  return mdd
}

function elapsedDays(from: string, to: string): number {
  const a = Date.parse(from)
  const b = Date.parse(to)
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0
  return Math.max(0, Math.round((b - a) / 86400e3))
}

const DATA_NOTE =
  '장부는 **주문 전송가를 체결가로 가정**한다(지정가 미체결·부분체결·실제 체결가 차이 미반영). ' +
  '시세는 Yahoo 일봉(비공식·총수익 보정)이고 15:20 종가는 미확정값이다. ' +
  '동결 유니버스라 생존편향이 있고 환율·거래세 외 세금은 반영하지 않는다. 실체결 대조는 2단계 게이트에서 한다.'

const DISCLAIMER =
  '본 산출물은 시스템 검증용 모의(가상) 운용 기록이며 **투자자문이 아니다.** 과거·모의 성과는 미래 수익을 보장하지 않고, ' +
  '각 전략은 최대낙폭(MDD) 구간에서 원금 손실이 발생할 수 있다. 무효화 지점(알파 소멸)에서 중단하는 것을 전제로 본다.'

/**
 * 전략별 분리 성과 + 벤치 대비 알파. **이 함수의 출력이 과업의 결과물**이다.
 * 규칙 5에 따라 절대 수익률이 아니라 벤치(대조군) 대비로 판정한다.
 */
export function summarize(
  ledger: MockLedger,
  config: MockLiveConfig,
  prices: Record<string, number>,
  date: string,
  opts: { dryRun: boolean; now?: string } = { dryRun: true },
): MockSummary {
  const configured = new Map(config.strategies.map((s) => [s.id, s]))
  const bench = config.strategies.find((s) => s.type === 'benchHold') ?? null
  const benchLedger = bench ? ledger.strategies[bench.id] : undefined
  const benchPct = benchLedger
    ? (ledgerEquity(benchLedger, prices) / benchLedger.initialCapital - 1) * 100
    : null

  const rows: StrategySummary[] = Object.values(ledger.strategies).map((s) => {
    const equity = ledgerEquity(s, prices)
    const totalPct = s.initialCapital > 0 ? (equity / s.initialCapital - 1) * 100 : 0
    const sells = s.trades.filter((t) => t.side === 'sell' && t.realizedPnl != null)
    const wins = sells.filter((t) => (t.realizedPnl ?? 0) > 0).length
    const isBench = bench != null && s.id === bench.id
    const alphaPct = benchPct == null || isBench ? null : totalPct - benchPct
    const days = elapsedDays(s.inception, date)
    // 규칙 5는 연환산 알파를 요구하지만, 며칠짜리 구간을 연환산하면 수백 %가 찍혀 판단을 망친다.
    // 그래서 60일 미만은 산출하지 않고 누적 차이만 보여준다.
    let alphaAnnualizedPct: number | null = null
    if (alphaPct != null && days >= 60 && benchPct != null) {
      const ann = (p: number) => (Math.pow(1 + p / 100, 365 / days) - 1) * 100
      alphaAnnualizedPct = +(ann(totalPct) - ann(benchPct)).toFixed(2)
    }
    return {
      id: s.id,
      label: s.label,
      retired: !configured.has(s.id),
      initialCapital: s.initialCapital,
      cash: Math.round(s.cash),
      equity: Math.round(equity),
      totalPct: +totalPct.toFixed(2),
      realizedPnl: Math.round(s.realizedPnl),
      positions: s.positions.length,
      closedTrades: sells.length,
      winRatePct: sells.length ? +((wins / sells.length) * 100).toFixed(1) : null,
      mddPct: +maxDrawdownPct(s.equityHistory).toFixed(2),
      alphaPct: alphaPct == null ? null : +alphaPct.toFixed(2),
      alphaAnnualizedPct,
      todayOrders: s.trades.filter((t) => t.date === date),
    }
  })

  const totalEquity = rows.reduce((sum, r) => sum + r.equity, 0)
  const totalInit = rows.reduce((sum, r) => sum + r.initialCapital, 0)
  return {
    updatedAt: opts.now ?? new Date().toISOString(),
    date,
    inception: ledger.inception,
    benchStrategyId: bench?.id ?? null,
    dryRun: opts.dryRun,
    strategies: rows,
    totals: {
      equity: Math.round(totalEquity),
      initialCapital: totalInit,
      totalPct: totalInit > 0 ? +((totalEquity / totalInit - 1) * 100).toFixed(2) : 0,
    },
    dataNote: DATA_NOTE,
    disclaimer: DISCLAIMER,
  }
}
