// 모의투자 운용 **공용 코어** — 일일 러너(mock-trade-daily)와 상주 데몬(investing-daemon)이
// 같은 로직을 쓰도록 추출한 모듈. 두 실행 형태가 다른 판단을 내리면 장부가 갈라지므로
// 시세 로딩·신호 산출·주문 계획·계좌 제약을 **여기 한 곳에만** 둔다(로직 복제 금지).
//
// 이 파일에 없는 것: 주문 전송·시크릿·스케줄. 주문은 scripts/lib/kiwoomOrder.mjs 의
// submit() 단일 통로로만 나가고, 이 파일은 그것을 우회하지 않는다.
//
// ⚠️ 규칙 1(미래참조 금지)와의 관계
//   - `truncateHistories(h, date)` 는 **date 이전 봉만** 남긴다. 데몬의 아침 청산 판정은
//     반드시 이걸 통과한 시계열로만 한다 — 당일 봉을 보고 아침에 판다면 미래참조다.
//   - 반대로 **체결가**로 당일 시가·현재가를 쓰는 것은 미래참조가 아니다(그 시점에 관측 가능).
//     판단 데이터와 체결 데이터를 구분한다.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { runStrategySpec, screenOnDate, type CostSettings } from '../../src/features/backtest/conditionScreen'
import { SPEC_VERSION, type ConditionNode, type StrategySpec } from '../../src/features/backtest/strategySpec'
import type { DailyBar, Trade } from '../../src/features/backtest/types'
import {
  applyLedgerFill,
  initLedger,
  slotQty,
  type MockLedger,
  type MockLiveConfig,
  type MockStrategyConfig,
  type StrategyLedger,
} from '../../src/features/backtest/mockLedger'
// JS 라이브러리(타입 선언 없음)
import { toKiwoomCode } from './kiwoomOrder.mjs'

// ---- 설정 타입 --------------------------------------------------------------

export interface PaperConfig {
  inception: string
  cost: CostSettings
  tracks: Record<string, { label: string; symbols: string[]; entryMa?: number; inception?: string }>
  benchmark: string
}

/** 주문 계획 1건 — 어느 전략의 것인지 태그를 달고 다닌다. */
export interface PlannedOrder {
  strategyId: string
  side: 'buy' | 'sell'
  /** 야후 심볼 (장부 키) */
  symbol: string
  /** 키움 6자리 코드 (주문 키) */
  code: string
  qty: number
  /** 지정가면 주문단가, 시장가면 **게이트 산정용 기준가**(금액 한도를 계산해야 하므로 필수) */
  price: number
  /** 기본 'limit'. 데몬의 아침 매도만 'market'(개장 동시호가 접수) */
  orderType?: 'limit' | 'market'
  reason: string
  note?: string | null
}

export interface SignalLog {
  entries: string[]
  exits: string[]
  engineOpen: number
  ledgerOpen: number
}

// ---- Yahoo 일봉 (총수익 보정 — paper-trade.entry.ts 와 동일 로직) ------------

export async function fetchDaily(symbol: string, since: string): Promise<DailyBar[]> {
  const p1 = Math.floor(Date.parse(since) / 1000)
  const p2 = Math.floor(Date.now() / 1000)
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    symbol,
  )}?period1=${p1}&period2=${p2}&interval=1d&events=div%2Csplit`
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' } })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const json = (await res.json()) as any
  const r = json?.chart?.result?.[0]
  if (!r) throw new Error(json?.chart?.error?.description ?? 'chart.result 없음')
  const ts: number[] = r.timestamp ?? []
  const q = r.indicators?.quote?.[0] ?? {}
  const adj: (number | null)[] = r.indicators?.adjclose?.[0]?.adjclose ?? []
  const out: DailyBar[] = []
  for (let i = 0; i < ts.length; i++) {
    const o = q.open?.[i]
    const h = q.high?.[i]
    const l = q.low?.[i]
    const cl = q.close?.[i]
    const v = q.volume?.[i]
    if ([o, h, l, cl].some((x: unknown) => x == null || !Number.isFinite(x as number))) continue
    const f = adj[i] != null && Number.isFinite(adj[i]!) && cl > 0 ? adj[i]! / cl : 1
    const date = new Date(ts[i] * 1000 + 9 * 3600 * 1000).toISOString().slice(0, 10)
    out.push({ date, t: ts[i], o: o * f, h: h * f, l: l * f, c: cl * f, v: Number.isFinite(v) ? v : 0 })
  }
  return out
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** 여러 종목을 순차 로딩한다(요청 간 간격 — 비공식 엔드포인트 예의). */
export async function loadHistories(opts: {
  symbols: string[]
  since: string
  minBars?: number
  delayMs?: number
  fetcher?: (symbol: string, since: string) => Promise<DailyBar[]>
}): Promise<{ histories: Record<string, DailyBar[]>; failed: string[] }> {
  const { symbols, since, minBars = 60, delayMs = 150, fetcher = fetchDaily } = opts
  const histories: Record<string, DailyBar[]> = {}
  const failed: string[] = []
  for (const sym of symbols) {
    try {
      const bars = await fetcher(sym, since)
      if (bars.length >= minBars) histories[sym] = bars
      else failed.push(`${sym}(짧음 ${bars.length})`)
    } catch (e) {
      failed.push(`${sym}(${(e as Error).message})`)
    }
    if (delayMs > 0) await sleep(delayMs)
  }
  return { histories, failed }
}

/** config 가 참조하는 트랙·벤치 심볼을 모아 로딩 대상을 만든다(유니버스 단일 원본 = paper/config.json). */
export function neededSymbols(paper: PaperConfig, config: MockLiveConfig): { trackIds: string[]; needed: string[] } {
  const trackIds = [...new Set(config.strategies.map((s) => s.universe).filter((u): u is string => Boolean(u)))]
  for (const t of trackIds) if (!paper.tracks[t]) throw new Error(`paper/config.json 에 트랙 ${t} 없음`)
  const benchSymbols = config.strategies.map((s) => s.symbol).filter((s): s is string => Boolean(s))
  const needed = [...new Set([...trackIds.flatMap((t) => paper.tracks[t].symbols), ...benchSymbols])]
  return { trackIds, needed }
}

/** 지표 워밍업을 위해 개시일보다 183일 앞에서부터 받는다. */
export function warmupStart(ledger: MockLedger, config: MockLiveConfig): string {
  const inceptions = Object.values(ledger.strategies).map((s) => s.inception)
  const earliest = inceptions.length ? inceptions.reduce((a, b) => (a < b ? a : b)) : config.inception
  return new Date(Date.parse(earliest) - 183 * 86400e3).toISOString().slice(0, 10)
}

/** 해당 날짜의 종가 맵. 그날 봉이 없는 종목은 제외한다. */
export function pricesOn(histories: Record<string, DailyBar[]>, date: string): Record<string, number> {
  const prices: Record<string, number> = {}
  for (const [sym, bars] of Object.entries(histories)) {
    // 뒤에서부터 찾는다 — 찾는 날짜는 거의 항상 마지막 봉이다.
    for (let i = bars.length - 1; i >= 0; i--) {
      if (bars[i].date > date) continue
      if (bars[i].date === date && bars[i].c > 0) prices[sym] = bars[i].c
      break
    }
  }
  return prices
}

/**
 * 해당 날짜의 **시가** 맵. 데몬의 09:00 매도가 백테스트 가정("매도 = 익일 시가")과
 * 체결 시점을 맞추기 위해 쓴다. 판단은 이미 전일 종가로 끝났으므로 미래참조가 아니다.
 */
export function opensOn(histories: Record<string, DailyBar[]>, date: string): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [sym, bars] of Object.entries(histories)) {
    for (let i = bars.length - 1; i >= 0; i--) {
      if (bars[i].date > date) continue
      if (bars[i].date === date && bars[i].o > 0) out[sym] = bars[i].o
      break
    }
  }
  return out
}

/** 마지막 봉이 `date` 인 종목 수 — 휴장·데이터 지연 판정용. */
export function countWithBar(histories: Record<string, DailyBar[]>, date: string): number {
  return Object.values(histories).filter((bars) => bars[bars.length - 1]?.date === date).length
}

/**
 * **규칙 1 집행 도구** — `beforeDate` **미만**의 봉만 남긴다(당일 봉 제거).
 * 아침 청산 판정은 반드시 이걸 통과한 시계열로 한다. 당일 봉을 넣으면
 * "오늘을 보고 오늘 아침에 판다"는 미래참조가 된다.
 */
export function truncateHistories(
  histories: Record<string, DailyBar[]>,
  beforeDate: string,
): Record<string, DailyBar[]> {
  const out: Record<string, DailyBar[]> = {}
  for (const [sym, bars] of Object.entries(histories)) out[sym] = bars.filter((b) => b.date < beforeDate)
  return out
}

/** 시계열 전체에서 가장 마지막 봉 날짜(= 확정된 최근 거래일). 비면 null. */
export function lastBarDate(histories: Record<string, DailyBar[]>): string | null {
  let last: string | null = null
  for (const bars of Object.values(histories)) {
    const d = bars[bars.length - 1]?.date
    if (d && (last == null || d > last)) last = d
  }
  return last
}

// ---- 전략 스펙 · 신호 -------------------------------------------------------

const cond = (id: string, c: unknown): ConditionNode => ({ op: 'cond', id, cond: c as never })

/**
 * 전략 스펙 — paper-trade.entry.ts 의 winnerSpec 과 같은 골격.
 * MA{entryMa} 돌파 × 20일 신고가 진입 / 40일선 −2% 청산 / 슬롯 10.
 * volumeSurge 면 진입 AND 에 "거래량 20일 평균 1.5배" 를 더한다(방어형).
 */
export function buildSpec(cfg: MockStrategyConfig, symbols: string[], slots: number): StrategySpec {
  const entryMa = cfg.entryMa ?? 20
  const nodes: ConditionNode[] = [
    cond(`${entryMa}일선돌파`, { kind: 'maCross', period: entryMa, dir: 'above' }),
    cond('20일신고가', { kind: 'highBreak', days: 20 }),
  ]
  if (cfg.volumeSurge) nodes.push(cond('거래량급증', { kind: 'volumeSurge', days: 20, ratio: 1.5 }))
  return {
    version: SPEC_VERSION,
    id: `mocklive-${cfg.id}`,
    name: cfg.label,
    source: '백테스트 5·6차 승자 계열 — 2단계 모의투자 5기법 분리 운용',
    universe: {
      markets: ['KOSPI', 'KOSDAQ'],
      excludeAdministrative: true,
      excludeSuspended: true,
      excludeLiquidation: true,
      excludePreferred: true,
      excludeEtf: true,
      symbols,
    },
    entry: { op: 'and', nodes },
    ranking: { by: 'tradingValue', dir: 'desc' },
    exits: [{ kind: 'maBreak', maPeriod: 40, pct: 2 }],
    sizing: { maxPositions: slots, mode: 'equalSlot' },
    execution: { timing: 'sameClose', orderType: 'market' },
  }
}

/**
 * 특정 날짜에 새로 잡힌 신호만 추출한다. 그 이전 매매는 이미 처리된 것으로 본다.
 *
 * ⚠️ `entries` 는 **비어 있는 게 정상**이다 — 엔진은 규칙 1-6에 따라 데이터 마지막 봉에서
 * 신규 진입을 만들지 않기 때문이다(백테스트에선 체결할 다음 봉이 없으므로 옳다).
 * 그래서 진입 후보는 `screenOnDate` 로 따로 뽑는다. 여기서는 **청산**만 쓴다.
 */
export function todaySignals(trades: Trade[], today: string): { entries: Trade[]; exits: Trade[] } {
  return {
    entries: trades.filter((t) => t.entryDate === today),
    exits: trades.filter((t) => t.exitDate === today),
  }
}

/** 전략이 볼 유니버스로 시계열을 좁히고 스펙을 만든다. */
export function scopeFor(
  cfg: MockStrategyConfig,
  paper: PaperConfig,
  histories: Record<string, DailyBar[]>,
  slots: number,
): { symbols: string[]; scoped: Record<string, DailyBar[]>; spec: StrategySpec } | null {
  const track = cfg.universe ? paper.tracks[cfg.universe] : null
  if (!track) return null
  const symbols = track.symbols.filter((x) => histories[x])
  const scoped: Record<string, DailyBar[]> = {}
  for (const x of symbols) scoped[x] = histories[x]
  return { symbols, scoped, spec: buildSpec(cfg, symbols, slots) }
}

export interface ExitSignals {
  exits: Trade[]
  engineOpen: number
  /** 엔진이 지금 들고 있는 종목(표류 판정용) */
  engineOpenSymbols: Set<string>
}

/**
 * `signalDate` 종가로 확정된 **청산 신호**. 엔진을 개시일부터 재계산해 상태 전이 버그를 막는다.
 * 데몬은 `histories` 에 **전일까지만** 담아 부르고, 일일 러너는 당일 포함으로 부른다.
 */
export function exitSignals(opts: {
  cfg: MockStrategyConfig
  ledger: StrategyLedger
  scoped: Record<string, DailyBar[]>
  spec: StrategySpec
  cost: CostSettings
  signalDate: string
}): ExitSignals {
  const { ledger, scoped, spec, cost, signalDate } = opts
  const result = runStrategySpec(scoped, ledger.inception, spec, { ...cost, initialCapital: ledger.initialCapital })
  const { exits } = todaySignals(result.trades, signalDate)
  return {
    exits,
    engineOpen: result.openAtEnd,
    engineOpenSymbols: new Set(result.trades.filter((t) => t.exitDate == null).map((t) => t.symbol ?? '')),
  }
}

/** `date` 종가 기준 진입 후보(장부 보유분 제외). */
export function entryCandidates(opts: {
  ledger: StrategyLedger
  scoped: Record<string, DailyBar[]>
  spec: StrategySpec
  date: string
}): { candidates: string[]; regimeOff: boolean } {
  const { ledger, scoped, spec, date } = opts
  const screen = screenOnDate(scoped, spec, date)
  const held = new Set(ledger.positions.map((p) => p.symbol))
  return { candidates: screen.passed.filter((sym) => !held.has(sym)), regimeOff: Boolean(screen.regimeOff) }
}

// ---- 주문 계획 --------------------------------------------------------------

/**
 * 청산 주문 계획. **장부 보유분만** 판다 — 엔진이 청산을 내도 장부에 없으면(게이트 차단·
 * 미체결로 애초에 못 샀던 경우) 팔 것이 없다. 없는 물량을 파는 주문을 만들지 않는다.
 */
export function planSells(opts: {
  cfg: MockStrategyConfig
  ledger: StrategyLedger
  exits: Trade[]
  prices: Record<string, number>
  date: string
  skipped: string[]
}): PlannedOrder[] {
  const { cfg, ledger, exits, prices, skipped } = opts
  const out: PlannedOrder[] = []
  for (const t of exits) {
    const sym = t.symbol ?? ''
    const pos = ledger.positions.find((p) => p.symbol === sym)
    if (!pos) {
      skipped.push(`[${cfg.id}] 매도 ${sym}(장부 미보유)`)
      continue
    }
    const px = prices[sym]
    if (!(px > 0)) {
      skipped.push(`[${cfg.id}] 매도 ${sym}(시세 없음)`)
      continue
    }
    out.push({
      strategyId: cfg.id,
      side: 'sell',
      symbol: sym,
      code: toKiwoomCode(sym),
      qty: Math.floor(pos.qty),
      price: Math.round(px),
      reason: `청산(${t.reason})`,
    })
  }
  return out
}

/**
 * 진입 주문 계획. 장부 현금·슬롯 한도 안에서만 만든다. 같은 날 여러 건이면 앞 건이 쓴 현금도
 * 반영해야 하므로 **가상 장부**를 굴리며 수량을 잡는다(실제 반영은 전송 결과를 보고 한 번만).
 * `appliedSells` 를 주면 그 매도를 먼저 가상 반영해 슬롯·현금을 푼다(같은 tick 에서 매도·매수를
 * 함께 계획하는 일일 러너용. 데몬은 매도가 이미 장부에 반영돼 있으므로 비워 부른다).
 */
export function planBuys(opts: {
  cfg: MockStrategyConfig
  ledger: StrategyLedger
  candidates: string[]
  prices: Record<string, number>
  slots: number
  cost: CostSettings
  date: string
  appliedSells?: PlannedOrder[]
  skipped: string[]
}): PlannedOrder[] {
  const { cfg, ledger, candidates, prices, slots, cost, date, appliedSells = [], skipped } = opts
  const paperCost = { feePct: cost.feePct, taxPct: cost.taxPct }
  let sim: StrategyLedger = { ...ledger, positions: [...ledger.positions] }
  for (const sell of appliedSells) {
    const r = applyLedgerFill(
      sim,
      { date, symbol: sell.symbol, side: 'sell', qty: sell.qty, price: sell.price, reason: sell.reason },
      paperCost,
    )
    if (!r.rejected) sim = r.ledger
  }
  const out: PlannedOrder[] = []
  for (const sym of candidates) {
    if (sim.positions.some((p) => p.symbol === sym)) {
      skipped.push(`[${cfg.id}] 매수 ${sym}(장부에 이미 보유)`)
      continue
    }
    if (sim.positions.length >= slots) {
      skipped.push(`[${cfg.id}] 매수 ${sym}(슬롯 ${slots} 소진)`)
      continue
    }
    const px = prices[sym]
    if (!(px > 0)) {
      skipped.push(`[${cfg.id}] 매수 ${sym}(시세 없음)`)
      continue
    }
    const qty = slotQty(sim, slots, px, cost.feePct)
    if (qty <= 0) {
      skipped.push(`[${cfg.id}] 매수 ${sym}(장부 현금으로 1주도 못 삼)`)
      continue
    }
    const amount = qty * px * (1 + cost.feePct / 100)
    sim = {
      ...sim,
      cash: sim.cash - amount,
      positions: [...sim.positions, { symbol: sym, qty, avgPrice: px, costBasis: amount, entryDate: date }],
    }
    out.push({
      strategyId: cfg.id,
      side: 'buy',
      symbol: sym,
      code: toKiwoomCode(sym),
      qty,
      price: Math.round(px),
      reason: `MA${cfg.entryMa ?? 20}돌파×20일신고가${cfg.volumeSurge ? '×거래량급증' : ''}`,
    })
  }
  return out
}

/** 대조군(benchHold): 첫 실행일에 전략자본어치 매수 후 보유. 이후 매매하지 않는다. */
export function planBenchHold(opts: {
  cfg: MockStrategyConfig
  ledger: StrategyLedger
  prices: Record<string, number>
  cost: CostSettings
  skipped: string[]
}): PlannedOrder[] {
  const { cfg, ledger, prices, cost, skipped } = opts
  const sym = cfg.symbol
  if (!sym) {
    skipped.push(`[${cfg.id}] benchHold 인데 symbol 없음`)
    return []
  }
  if (ledger.positions.length > 0) return []
  const px = prices[sym]
  if (!(px > 0)) {
    skipped.push(`[${cfg.id}] 매수 ${sym}(시세 없음)`)
    return []
  }
  const qty = Math.floor(ledger.cash / (px * (1 + cost.feePct / 100)))
  if (qty <= 0) {
    skipped.push(`[${cfg.id}] 매수 ${sym}(자본으로 1주도 못 삼)`)
    return []
  }
  return [
    {
      strategyId: cfg.id,
      side: 'buy',
      symbol: sym,
      code: toKiwoomCode(sym),
      qty,
      price: Math.round(px),
      reason: '대조군 최초 매수 후 보유',
    },
  ]
}

/**
 * 장부에는 있는데 엔진은 안 들고 있는 종목 = **표류**(주문 차단·미체결로 갈라진 흔적).
 * 청산 신호도 안 나므로 그대로 두면 조용히 묵는다 — 보이게 만든다.
 * 단, 오늘 산 것은 제외한다(엔진은 마지막 봉에서 진입하지 않으므로 정상 — 규칙 1-6).
 */
export function driftWarnings(opts: {
  cfg: MockStrategyConfig
  ledger: StrategyLedger
  engineOpenSymbols: Set<string>
  sellingNow: Set<string>
  today: string
}): string[] {
  const { cfg, ledger, engineOpenSymbols, sellingNow, today } = opts
  const out: string[] = []
  for (const p of ledger.positions) {
    if (p.entryDate === today || sellingNow.has(p.symbol) || engineOpenSymbols.has(p.symbol)) continue
    out.push(`[${cfg.id}] 표류 ${p.symbol}(장부 보유·엔진 미보유 — 청산 신호 없음)`)
  }
  return out
}

// ---- 아침 청산 계획 (데몬 프리로드 전용 · 순수 함수) ------------------------

export interface PreloadPlan {
  /** 판단 근거가 된 **확정 거래일**(전일). 시계열이 비면 null */
  asOf: string | null
  sells: PlannedOrder[]
  /** 판단 근거일 종가 — 시가를 못 구했을 때의 대체 지정가 */
  refClose: Record<string, number>
  skipped: string[]
  signals: Record<string, SignalLog>
}

/**
 * **당일 봉을 제외한** 시계열로 청산 대상을 확정한다 — 데몬이 08:30 에 부른다.
 *
 * 규칙 1의 핵심 경로다. `today` 봉이 histories 에 들어 있어도 여기서 잘라내므로,
 * 당일 값이 무엇이든 결과가 바뀌지 않는다(tests/investing-daemon.test.ts 절단 불변성).
 * 네트워크·파일 IO 없음 → 테스트가 전 경로를 덮는다.
 */
export function planPreloadSells(opts: {
  config: MockLiveConfig
  ledger: MockLedger
  paper: PaperConfig
  histories: Record<string, DailyBar[]>
  today: string
  slots: number
  cost: CostSettings
}): PreloadPlan {
  const { config, ledger, paper, histories, today, slots, cost } = opts
  const past = truncateHistories(histories, today) // ← 미래참조 차단
  const asOf = lastBarDate(past)
  const refClose = asOf ? pricesOn(past, asOf) : {}
  const skipped: string[] = []
  const signals: Record<string, SignalLog> = {}
  const sells: PlannedOrder[] = []
  if (!asOf) return { asOf: null, sells, refClose, skipped: ['확정 봉이 없어 청산 판정 불가'], signals }

  for (const cfg of config.strategies) {
    const s = ledger.strategies[cfg.id]
    if (!s) continue
    if (cfg.type === 'benchHold') {
      // 대조군은 매도하지 않는다.
      signals[cfg.id] = { entries: [], exits: [], engineOpen: s.positions.length, ledgerOpen: s.positions.length }
      continue
    }
    const scope = scopeFor(cfg, paper, past, slots)
    if (!scope) {
      skipped.push(`[${cfg.id}] universe 미지정`)
      continue
    }
    const { exits, engineOpen, engineOpenSymbols } = exitSignals({
      cfg,
      ledger: s,
      scoped: scope.scoped,
      spec: scope.spec,
      cost,
      signalDate: asOf,
    })
    const planned = planSells({ cfg, ledger: s, exits, prices: refClose, date: asOf, skipped })
    sells.push(...planned)
    signals[cfg.id] = {
      entries: [],
      exits: exits.map((t) => t.symbol ?? ''),
      engineOpen,
      ledgerOpen: s.positions.length,
    }
    skipped.push(
      ...driftWarnings({
        cfg,
        ledger: s,
        engineOpenSymbols,
        sellingNow: new Set(planned.map((p) => p.symbol)),
        today,
      }),
    )
  }
  return { asOf, sells, refClose, skipped, signals }
}

/**
 * **체결가 반영(confirm 단계)** — 접수한 매도의 장부 가격을 관측된 체결가로 바꾼다.
 *
 * 아침 매도는 08:59:30에 **시장가**로 접수하므로 접수 시점엔 체결가를 모른다. 09:01에
 * ① 브로커 체결내역의 실제 체결가 ② 없으면 당일 시가(Yahoo) 순으로 잡아 장부에 넣는다.
 * 둘 다 없으면 참조 종가(전일 종가)를 그대로 두고 `[추정]` 표시를 남긴다.
 *
 * 판단은 이미 전일 종가로 끝났고 여기서 쓰는 값은 그 시점에 관측 가능한 현재가이므로
 * 미래참조가 아니다(판단 데이터 ≠ 체결 데이터).
 */
export function repriceSells(
  sells: PlannedOrder[],
  filledPrices: Record<string, number>,
): { orders: PlannedOrder[]; priced: number; fallback: string[] } {
  const fallback: string[] = []
  let priced = 0
  const orders = sells.map((s) => {
    const px = filledPrices[s.symbol]
    if (px > 0) {
      priced++
      return { ...s, price: Math.round(px) }
    }
    fallback.push(s.symbol)
    return { ...s, note: `${s.note ? `${s.note} · ` : ''}[추정] 체결가·당일 시가 미확인 — 참조 종가로 기록` }
  })
  return { orders, priced, fallback }
}

// ---- 파일 IO ----------------------------------------------------------------

/** 저널 append — 배열 파일이 없으면 만든다. */
export function appendJournal(journalPath: string, entry: unknown): number {
  mkdirSync(dirOf(journalPath), { recursive: true })
  let list: unknown[] = []
  if (existsSync(journalPath)) {
    try {
      const parsed = JSON.parse(readFileSync(journalPath, 'utf8'))
      if (Array.isArray(parsed)) list = parsed
    } catch {
      /* 깨진 파일은 덮지 않고 새 배열로 시작 — 원본은 git 이력에 남는다 */
    }
  }
  list.push(entry)
  writeFileSync(journalPath, JSON.stringify(list, null, 1))
  return list.length
}

function dirOf(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return i < 0 ? '.' : p.slice(0, i)
}

/**
 * 장부 로드. **깨졌으면 새로 만들지 않고 중단한다** — 조용히 새 장부로 시작하면
 * 그동안의 성과 기록이 사라지고, 그 사실을 아무도 모른 채 계속 굴러간다.
 */
export function loadLedgerFile(ledgerPath: string, config: MockLiveConfig): MockLedger {
  if (!existsSync(ledgerPath)) return initLedger(config)
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(ledgerPath, 'utf8'))
  } catch (e) {
    throw new Error(`ledger.json 을 읽을 수 없다(수동 확인 필요): ${(e as Error).message}`)
  }
  const j = parsed as MockLedger
  if (!j || typeof j !== 'object' || typeof j.strategies !== 'object' || j.strategies == null)
    throw new Error('ledger.json 형태가 이상하다 — 새 장부로 덮지 않고 중단한다(수동 확인 필요)')
  return j
}

export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirOf(path), { recursive: true })
  writeFileSync(path, JSON.stringify(value, null, 1))
}
