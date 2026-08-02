// 횡단면 모멘텀(12-1) 랭킹 전략 — 연도별 시점 고정 유니버스 연쇄 실행기.
//
// 25차 실측(2026-08-02, scripts/idea-lab.entry.ts MODE=xsmom)에서 기준선(MA25×신고10→80선)을
// 압도한 전략을 **화면·페이퍼 트랙에서 실행 가능한 형태**로 옮긴 것이다.
//
// ── 의미론 정본 ───────────────────────────────────────────────────────────────
// 이 파일의 전략 의미론(모멘텀 창·랭킹·게이트·슬롯 분모·체결 시점)은
// `scripts/idea-lab.entry.ts`의 `simulateXsMomYear`/`xsmomRank`/`momentum12_1`이 정본이며,
// 여기서는 **한 줄도 재해석하지 않고 그대로 옮겼다**. 옮겨 적기가 조용히 갈라지는 것을 막으려고
// `tests/xsmomchain.test.ts`가 두 구현을 같은 합성 데이터로 돌려 **자산곡선·체결이 전부
// 일치하는지(동형)** 검증한다. 갈라지면 테스트가 깨진다.
//
// ── 전략 요약 ────────────────────────────────────────────────────────────────
// 매월 첫 거래일에 "12개월 전 ~ 1개월 전" 수익률로 유니버스를 줄 세워 상위 N만 동일가중
// 보유하고, 다음 달 첫 거래일 **시가**에 리밸런스한다. 최근 1개월은 단기 반전 효과를 피하려고
// 창에서 통째로 뺀다(Jegadeesh–Titman 계열의 표준 12-1).
//
// ── 규칙 1(미래참조 금지) 설계 ────────────────────────────────────────────────
//   1. 랭킹은 `date < 전월 1일` 종가까지만 본다. 리밸런스일 D의 시가는 **체결에만** 쓰고
//      판정에는 쓰지 않는다 — D 근처 데이터가 판정에 아예 들어가지 않는다.
//   2. 12개월치 데이터가 없는 종목(시작 종가 부재)은 그 시점 후보에서 뺀다.
//   3. 연도별 입력 봉을 `date <= effEnd`로 **자르고** 넘긴다(pitChain과 같은 조작) —
//      뒤 연도를 통째로 잘라내도 앞 연도의 체결·자산곡선이 완전히 같아야 한다.
//   4. 전 구간 통계(평균·표준편차·최대최소)를 쓰지 않는다. 랭킹은 그 시점 단면뿐이다.
//   5. 유니버스 편입 판정은 "그 종목의 첫 봉이 기준일 이전인가"만 본다 — 그 해 이후의
//      가격·시총을 보지 않는다.
//   집행자는 `tests/xsmomchain.test.ts`의 절단 불변성 케이스다.
//
// ── 시장 중립 ────────────────────────────────────────────────────────────────
// 유니버스(`years`·`codesFor`)·벤치마크·비용을 전부 옵션으로 받는다. KR PIT 유니버스와
// US 유니버스에 같은 코드로 재사용할 수 있도록 이 모듈은 어떤 시장 목록도 import하지 않는다.
//
// 이 모듈은 **순수 함수**다 — 네트워크·localStorage·DOM에 접근하지 않는다.
// 화면(SpecSimulator)과 헤드리스 러너(scripts/paper-trade)가 같은 함수를 부른다.

import type { ConditionScreenRow, CostSettings, ExitBreakdown } from './conditionScreen'
import { annualize, yearsBetween, type PitChainResult, type PitYearRow } from './pitChain'
import type { DailyBar, EquityPoint, Trade } from './types'

// ============================================================================
// 모멘텀 산술 — idea-lab.entry.ts의 동명 함수와 **동일 구현**
// ============================================================================

/** 'YYYY-MM-DD'에서 k개월 이동한 달의 1일 — 'YYYY-MM-01' */
export function shiftMonthStart(date: string, k: number): string {
  const y = Number(date.slice(0, 4))
  const m = Number(date.slice(5, 7))
  const t = y * 12 + (m - 1) + k
  const yy = Math.floor(t / 12)
  const mm = t - yy * 12 + 1
  return `${String(yy).padStart(4, '0')}-${String(mm).padStart(2, '0')}-01`
}

/** `date` **미만**(strictly before) 마지막 봉의 종가. 없으면 null. 이분 탐색. */
export function lastCloseBefore(bars: DailyBar[], date: string): number | null {
  let lo = 0
  let hi = bars.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (bars[mid].date < date) lo = mid + 1
    else hi = mid
  }
  return lo > 0 ? bars[lo - 1].c : null
}

/**
 * 12-1 모멘텀. 리밸런스일 `date`(월 첫 거래일) 기준으로
 *   시작 = 12개월 전 달 1일 직전 종가 · 끝 = 1개월 전 달 1일 직전 종가.
 * 두 기준일 모두 `date`보다 과거라 미래참조가 원천적으로 불가능하고, 직전 한 달의
 * 수익은 창에서 빠진다. 12개월치 데이터가 없으면(시작 종가 부재) null = 후보 제외.
 */
export function momentum12_1(bars: DailyBar[], date: string): number | null {
  const pe = lastCloseBefore(bars, shiftMonthStart(date, -1))
  const ps = lastCloseBefore(bars, shiftMonthStart(date, -12))
  if (pe == null || ps == null || !(ps > 0)) return null
  return pe / ps - 1
}

export interface MomRow {
  sym: string
  mom: number
}

/** 모멘텀 내림차순, 동점은 심볼 오름차순(결정적). */
export function xsmomRank(histories: Record<string, DailyBar[]>, universe: string[], date: string): MomRow[] {
  const rows: MomRow[] = []
  for (const s of universe) {
    const bars = histories[s]
    if (!bars?.length) continue
    const m = momentum12_1(bars, date)
    if (m == null) continue
    rows.push({ sym: s, mom: m })
  }
  rows.sort((x, y) => (y.mom !== x.mom ? y.mom - x.mom : x.sym < y.sym ? -1 : x.sym > y.sym ? 1 : 0))
  return rows
}

// ============================================================================
// 장부(Book) — 체결·손익 원장. idea-lab의 bookBuy/bookSell/bookMark와 동일 산술.
// ============================================================================

interface BookPos {
  qty: number
  /** 취득 총원가(체결가×수량 + 매수수수료). 부분매도 시 비례 차감. */
  basis: number
  /** 부분매도까지 포함한 실현손익 누계 */
  realized: number
  entryIdx: number
  /** 봉이 없는 날 평가에 쓰는 마지막 관측 종가 */
  lastClose: number
}

interface Book {
  cash: number
  positions: Map<string, BookPos>
  closed: number
  wins: number
}

const newBook = (cash: number): Book => ({ cash, positions: new Map(), closed: 0, wins: 0 })

/** 매수. `rawPx`는 슬리피지 **적용 전** 기준가이며 여기서 불리한 쪽으로 슬리피지를 얹는다. */
function bookBuy(book: Book, cost: CostSettings, sym: string, rawPx: number, budget: number, idx: number): number {
  if (!(rawPx > 0) || !(budget > 0)) return 0
  const fill = rawPx * (1 + cost.slippagePct / 100)
  const qty = Math.floor(Math.min(budget, book.cash) / (fill * (1 + cost.feePct / 100)))
  if (qty <= 0) return 0
  const gross = qty * fill
  const fee = gross * (cost.feePct / 100)
  book.cash -= gross + fee
  const p = book.positions.get(sym)
  if (p) {
    p.qty += qty
    p.basis += gross + fee
  } else {
    book.positions.set(sym, { qty, basis: gross + fee, realized: 0, entryIdx: idx, lastClose: rawPx })
  }
  return qty
}

/** 매도(부분 가능). 전량이 나가면 라운드트립 1건으로 세고 실현손익 부호로 승패를 가른다. */
function bookSell(book: Book, cost: CostSettings, sym: string, rawPx: number, qty: number): number {
  const p = book.positions.get(sym)
  if (!p || !(qty > 0) || !(rawPx > 0)) return 0
  const q = Math.min(qty, p.qty)
  const fill = rawPx * (1 - cost.slippagePct / 100)
  const gross = q * fill
  const net = gross - gross * ((cost.feePct + cost.taxPct) / 100)
  book.cash += net
  const portion = q / p.qty
  const basisOut = p.basis * portion
  p.realized += net - basisOut
  p.basis -= basisOut
  p.qty -= q
  if (p.qty <= 0) {
    book.closed++
    if (p.realized > 0) book.wins++
    book.positions.delete(sym)
  }
  return q
}

/** 종가 마킹 — 봉 없는 날은 마지막 관측 종가를 이월한다. 총자산(현금+평가)을 돌려준다. */
function bookMark(book: Book, priceOf: (sym: string) => number | null): number {
  let mv = 0
  for (const [sym, p] of book.positions) {
    const px = priceOf(sym)
    if (px != null && px > 0) p.lastClose = px
    mv += p.qty * p.lastClose
  }
  return book.cash + mv
}

// ============================================================================
// 한 해치 시뮬
// ============================================================================

/**
 * 체결 1건. **테스트가 규칙 1을 집행하는 지점**이다 — "언제 판단해 언제 무슨 값으로 샀나"를
 * 검증하려면 체결일·신호일·기준가가 다 남아 있어야 한다.
 */
export interface XsmomFill {
  date: string
  sym: string
  side: 'buy' | 'sell'
  /** 슬리피지 적용 **전** 기준가 — 리밸런스는 항상 그 날의 **시가**다 */
  px: number
  qty: number
  /** 이 체결을 만든 판단이 이뤄진 날. 랭킹은 전월 1일 이전만 보므로 늦어도 직전 거래일이다. */
  signalDate: string
}

/** 리밸런스 1회 기록 — "그날 무엇을 왜 담았나"를 화면에서 되짚기 위한 것. */
export interface XsmomRebalance {
  date: string
  /** 슬롯 분모 — 게이트와 무관하게 min(N, 후보수)로 고정된다 */
  denom: number
  /** 랭킹 상위 denom개(게이트 적용 전) */
  picked: string[]
  /** 실제 보유 목표(게이트 통과분) */
  targets: string[]
  /** 게이트에 걸려 **현금**으로 남긴 슬롯의 종목 */
  gatedOut: string[]
  /** 상위 랭킹(최대 10) — 메모리 상한을 두고 잘라 남긴다 */
  top: MomRow[]
}

export interface XsmomOpts {
  /** 보유 종목 수 N */
  slots: number
  /** 절대 모멘텀 게이트 — 12-1 수익 < 0인 종목은 그 슬롯을 **현금**으로 둔다 */
  gate: boolean
}

export interface XsmomYearRun {
  equity: { date: string; equity: number }[]
  fills: XsmomFill[]
  trades: Trade[]
  rebalances: XsmomRebalance[]
  closed: number
  wins: number
  openAtEnd: number
}

/** 매매 이력 재구성용 — 장부와 나란히 굴러가되 장부 산술에는 관여하지 않는다. */
interface OpenTrade {
  t: Trade
  /** 매수 총원가 누계(수수료 포함) */
  basisIn: number
  /** 매도 순수취 누계(수수료·세금 차감 후) */
  proceeds: number
  /** 가중평균 진입가 산출용 — 체결가×수량 누계 */
  pxQty: number
  qtyIn: number
}

/**
 * 한 해치 횡단면 모멘텀 시뮬. 월 첫 거래일 **시가**에 리밸런스한다.
 *
 * 슬롯 분모는 게이트와 무관하게 `min(N, 후보수)`로 고정한다 — 그래야 게이트 A/B가
 * "같은 슬롯 중 몇 개를 현금으로 돌렸나"의 비교가 된다(분모를 같이 줄이면 게이트가
 * 남은 종목에 레버리지를 거는 셈이라 비교가 오염된다).
 *
 * ⚠️ idea-lab.entry.ts `simulateXsMomYear`와 **동형**이어야 한다(tests/xsmomchain.test.ts).
 */
export function runXsmomYear(
  histories: Record<string, DailyBar[]>,
  startDate: string,
  symbols: string[],
  cost: CostSettings,
  opts: XsmomOpts,
): XsmomYearRun {
  // ---- 공용 컨텍스트(idea-lab makeSimCtx와 동일) ----------------------------
  const universe = [...new Set(symbols)].filter((s) => histories[s]?.length).sort()
  const dateSet = new Set<string>()
  for (const s of universe) for (const b of histories[s]) dateSet.add(b.date)
  const calendar = [...dateSet].sort().filter((d) => d >= startDate)
  const idxOf: Record<string, Map<string, number>> = {}
  for (const s of universe) {
    const m = new Map<string, number>()
    histories[s].forEach((b, i) => m.set(b.date, i))
    idxOf[s] = m
  }

  const book = newBook(cost.initialCapital)
  const equity: { date: string; equity: number }[] = []
  const fills: XsmomFill[] = []
  const rebalances: XsmomRebalance[] = []
  const trades: Trade[] = []
  const open = new Map<string, OpenTrade>()

  const closeAt = (date: string) => (s: string) => {
    const bi = idxOf[s]?.get(date)
    return bi != null ? histories[s][bi].c : null
  }
  let curYm = ''

  for (let d = 0; d < calendar.length; d++) {
    const date = calendar[d]
    // 랭킹은 전월 1일 이전 종가까지만 보므로 판단 시점은 늦어도 직전 거래일이다
    const signalDate = d > 0 ? calendar[d - 1] : date

    const sell = (sym: string, px: number, qty: number) => {
      const before = book.positions.get(sym)
      if (!before) return
      const cashBefore = book.cash
      const q = bookSell(book, cost, sym, px, qty)
      if (q <= 0) return
      fills.push({ date, sym, side: 'sell', px, qty: q, signalDate })
      const ot = open.get(sym)
      if (ot) {
        ot.proceeds += book.cash - cashBefore
        ot.t.qty = Math.max(0, ot.t.qty - q)
        if (!book.positions.has(sym)) {
          ot.t.exitDate = date
          ot.t.exitPrice = px * (1 - cost.slippagePct / 100)
          ot.t.pnl = ot.proceeds - ot.basisIn
          ot.t.pnlPct = ot.basisIn > 0 ? ((ot.proceeds - ot.basisIn) / ot.basisIn) * 100 : null
          ot.t.reason = '조건 매도'
          ot.t.qty = ot.qtyIn
          open.delete(sym)
        }
      }
    }
    const buy = (sym: string, px: number, budget: number) => {
      const cashBefore = book.cash
      const q = bookBuy(book, cost, sym, px, budget, d)
      if (q <= 0) return
      fills.push({ date, sym, side: 'buy', px, qty: q, signalDate })
      const spent = cashBefore - book.cash
      let ot = open.get(sym)
      if (!ot) {
        const t: Trade = {
          entryDate: date,
          entryPrice: px * (1 + cost.slippagePct / 100),
          qty: q,
          exitDate: null,
          exitPrice: null,
          pnl: null,
          pnlPct: null,
          reason: '보유중(미청산)',
          symbol: sym,
        }
        ot = { t, basisIn: 0, proceeds: 0, pxQty: 0, qtyIn: 0 }
        open.set(sym, ot)
        trades.push(t)
      }
      ot.basisIn += spent
      ot.pxQty += px * (1 + cost.slippagePct / 100) * q
      ot.qtyIn += q
      ot.t.qty = book.positions.get(sym)?.qty ?? q
      ot.t.entryPrice = ot.qtyIn > 0 ? ot.pxQty / ot.qtyIn : ot.t.entryPrice
    }

    const ym = date.slice(0, 7)
    if (ym !== curYm) {
      curYm = ym
      // ---- 월 첫 거래일: 시가 리밸런스 ----------------------------------
      const openPx = new Map<string, number | null>()
      for (const s of universe) {
        const bi = idxOf[s].get(date)
        openPx.set(s, bi != null ? histories[s][bi].o : null)
      }
      let eq = book.cash
      for (const [s, p] of book.positions) {
        const px = openPx.get(s)
        eq += p.qty * (px != null && px > 0 ? px : p.lastClose)
      }
      // 후보: 랭킹 산출 가능 + 오늘 실제로 거래되는 종목만(체결 불가 종목을 담지 않는다)
      const ranked = xsmomRank(histories, universe, date).filter((r) => (openPx.get(r.sym) ?? 0) > 0)
      const denom = Math.max(1, Math.min(opts.slots, ranked.length))
      const picked = ranked.slice(0, denom)
      const targets = opts.gate ? picked.filter((r) => r.mom >= 0) : picked
      const targetSet = new Set(targets.map((r) => r.sym))
      const slot = eq / denom

      // 1) 목표 밖 전량 매도 (봉이 없으면 못 판다 — 다음 기회로 이월)
      for (const s of [...book.positions.keys()]) {
        if (targetSet.has(s)) continue
        const px = openPx.get(s)
        if (px == null || !(px > 0)) continue
        sell(s, px, book.positions.get(s)!.qty)
      }
      // 2) 목표 초과분 트림
      for (const r of targets) {
        const p = book.positions.get(r.sym)
        if (!p) continue
        const px = openPx.get(r.sym)!
        const want = Math.floor(slot / px)
        if (p.qty > want) sell(r.sym, px, p.qty - want)
      }
      // 3) 부족분 매수
      for (const r of targets) {
        const px = openPx.get(r.sym)!
        const held = book.positions.get(r.sym)?.qty ?? 0
        const budget = Math.min(slot - held * px, book.cash)
        if (budget <= 0) continue
        buy(r.sym, px, budget)
      }

      rebalances.push({
        date,
        denom,
        picked: picked.map((r) => r.sym),
        targets: targets.map((r) => r.sym),
        gatedOut: picked.filter((r) => !targetSet.has(r.sym)).map((r) => r.sym),
        top: ranked.slice(0, 10),
      })
    }
    equity.push({ date, equity: bookMark(book, closeAt(date)) })
  }

  // 구간 끝에 남은 포지션 — 엔진 관례대로 **시가평가**로 남긴다(청산하지 않는다)
  for (const [sym, ot] of open) {
    const p = book.positions.get(sym)
    const mark = p ? p.qty * p.lastClose : 0
    ot.t.pnl = ot.proceeds + mark - ot.basisIn
    ot.t.pnlPct = ot.basisIn > 0 ? (ot.t.pnl / ot.basisIn) * 100 : null
    ot.t.qty = ot.qtyIn
  }

  return {
    equity,
    fills,
    trades,
    rebalances,
    closed: book.closed,
    wins: book.wins,
    openAtEnd: book.positions.size,
  }
}

// ============================================================================
// 연도별 유니버스 교체 연쇄
// ============================================================================

export interface XsmomChainOptions {
  /** 비용 설정. `initialCapital`은 배수 계산의 기준값으로만 쓰인다. */
  cost: CostSettings
  /** 보유 종목 수 N */
  slots: number
  /** 절대 모멘텀 게이트 */
  gate: boolean
  /** 실행할 연도 목록 — 시장 중립을 위해 **호출부가 반드시 준다**. */
  years: number[]
  /** 연도 → 유니버스 코드 — 시장 중립을 위해 **호출부가 반드시 준다**. */
  codesFor: (year: number) => string[]
  /** 유니버스 코드 → `histories` 키 매핑. 없으면 코드를 그대로 키로 본다. */
  resolve?: (code: string) => string | undefined
  /** 이 날짜 이전 구간은 실행하지 않는다. */
  startDate?: string
  /** 이 날짜 이후 봉을 잘라낸다. */
  endDate?: string
  /** 그 해 매핑 종목이 이 수 미만이면 표본이 작아 왜곡되므로 **현금 보유**로 처리한다. */
  minSymbols?: number
  /** 벤치마크 일봉(매매 대상 아님). */
  bench?: DailyBar[]
  /**
   * 편입 판정 기준일 — 그 종목의 첫 봉이 이 날짜 이전이어야 그 해 유니버스에 든다.
   * 기본은 pitChain과 같은 `{y}-06-30`. 페이퍼 트랙처럼 유니버스가 이미 동결된 경우는
   * 개시일을 넘겨 쓴다. **미래 정보를 쓰지 않는다** — "그때 이미 상장돼 있었나"만 본다.
   */
  listedBy?: (year: number) => string
  /**
   * 구간 끝 청산비용 근사(idea-lab runCustomChain의 haircut). 기본 **false** —
   * 같은 화면의 조건식 모드(runPitChained)가 haircut을 쓰지 않으므로, 켜면 두 모드가
   * 서로 다른 비용 전제로 비교된다. 25차 러너 수치와 정확히 맞추려면 true로 둔다.
   */
  applyLiquidationHaircut?: boolean
}

/** 리밸런스 기록까지 포함한 결과 — 나머지는 `PitChainResult`와 완전히 호환된다. */
export interface XsmomChainResult extends PitChainResult {
  rebalances: XsmomRebalance[]
}

const yearStartOf = (y: number) => `${y}-01-01`
const yearEndOf = (y: number) => `${y}-12-31`

/**
 * 연도별 시점 고정 유니버스로 횡단면 모멘텀 연쇄 백테스트를 돌린다.
 * 연쇄·이월·현금해 처리·벤치 겹침은 `runPitChained`와 **같은 규약**이다
 * (그래야 같은 화면에서 조건식 모드와 나란히 비교된다).
 */
export function runXsmomChained(
  histories: Record<string, DailyBar[]>,
  opts: XsmomChainOptions,
): XsmomChainResult {
  const years = opts.years.slice().sort((a, b) => a - b)
  const { codesFor, cost } = opts
  const resolve = opts.resolve ?? ((code: string) => (histories[code] ? code : undefined))
  const minSymbols = opts.minSymbols ?? 5
  const listedBy = opts.listedBy ?? ((y: number) => `${y}-06-30`)
  const haircut = opts.applyLiquidationHaircut ?? false
  const capital = cost.initialCapital
  const from = opts.startDate || ''
  const to = opts.endDate || ''
  const bench = opts.bench ?? null

  const equity: EquityPoint[] = []
  const trades: Trade[] = []
  const perYear: PitYearRow[] = []
  const rebalances: XsmomRebalance[] = []

  let factor = 1
  let benchFactor = 1
  let peak = 1
  let mdd = 0
  let openAtEnd = 0
  let lastScreen: ConditionScreenRow[] = []
  let lastScreenDate = ''

  for (const y of years) {
    const ys = yearStartOf(y)
    const ye = yearEndOf(y)
    if (to && ys > to) continue
    if (from && ye < from) continue
    const effStart = from && from > ys ? from : ys
    const effEnd = to && to < ye ? to : ye

    const codes = codesFor(y)
    const cutoff = listedBy(y)
    const picked: string[] = []
    for (const code of codes) {
      const sym = resolve(code)
      if (!sym) continue
      const bars = histories[sym]
      if (!bars?.length) continue
      if (bars[0].date > cutoff) continue // 그 시점까지 상장되지 않았다
      picked.push(sym)
    }
    const symbols = [...new Set(picked)]

    // 그 해 실행 입력 — **effEnd 이후 봉을 잘라낸다**(규칙 1의 절단과 같은 조작)
    const hist: Record<string, DailyBar[]> = {}
    for (const s of symbols) {
      const cut = histories[s].filter((b) => b.date <= effEnd)
      if (cut.length) hist[s] = cut
    }
    const tradable = symbols.filter((s) => hist[s]?.some((b) => b.date >= effStart && b.date <= effEnd))
    if (tradable.length === 0) continue

    const benchInYear = bench ? bench.filter((b) => b.date >= effStart && b.date <= effEnd) : []
    const benchRatioAt = (date: string): number => {
      if (benchInYear.length < 2) return 1
      const first = benchInYear[0].c
      let last = first
      for (const b of benchInYear) {
        if (b.date > date) break
        last = b.c
      }
      return first > 0 ? last / first : 1
    }
    const benchYearRatio =
      benchInYear.length >= 2 ? benchInYear[benchInYear.length - 1].c / benchInYear[0].c : null

    if (tradable.length < minSymbols) {
      // 표본이 너무 작으면 성적이 몇 종목 운에 좌우된다 — 현금 보유로 처리하고
      // 자산곡선은 평평하게 이어붙인다(구간을 건너뛰면 연수가 줄어 CAGR이 부풀려진다).
      const dates = [...new Set(Object.values(hist).flatMap((bars) => bars.map((b) => b.date)))]
        .filter((d) => d >= effStart && d <= effEnd)
        .sort()
      const flatDates = dates.length ? dates : benchInYear.map((b) => b.date)
      for (const d of flatDates) {
        const eq = factor
        peak = Math.max(peak, eq)
        mdd = Math.min(mdd, (eq / peak - 1) * 100)
        equity.push({
          date: d,
          equity: eq * capital,
          benchmark: benchFactor * benchRatioAt(d) * capital,
          drawdownPct: (eq / peak - 1) * 100,
        })
      }
      if (benchYearRatio != null) benchFactor *= benchYearRatio
      perYear.push({
        year: y,
        mapped: tradable.length,
        total: codes.length,
        cash: true,
        strategyPct: 0,
        benchPct: benchYearRatio != null ? (benchYearRatio - 1) * 100 : null,
        trades: 0,
        symbols: [],
      })
      continue
    }

    const run = runXsmomYear(hist, effStart, tradable, cost, { slots: opts.slots, gate: opts.gate })

    const base = factor
    for (const p of run.equity) {
      const eq = base * (p.equity / capital)
      peak = Math.max(peak, eq)
      const dd = (eq / peak - 1) * 100
      mdd = Math.min(mdd, dd)
      equity.push({
        date: p.date,
        equity: eq * capital,
        benchmark: benchFactor * benchRatioAt(p.date) * capital,
        drawdownPct: dd,
      })
    }
    const finalEq = run.equity.length ? run.equity[run.equity.length - 1].equity : capital
    const segRet = finalEq / capital
    // 구간 끝 청산비용 근사 [추정] — 정확한 청산가가 아니다. 기본은 끈다(위 주석 참조).
    const frac = haircut ? Math.min(1, Math.max(0, run.openAtEnd / Math.max(1, opts.slots))) : 0
    const yearRatio = segRet * (1 - frac * ((cost.feePct + cost.taxPct + cost.slippagePct) / 100))
    factor = base * yearRatio
    if (benchYearRatio != null) benchFactor *= benchYearRatio

    for (const t of run.trades) trades.push(t)
    for (const r of run.rebalances) rebalances.push(r)
    openAtEnd += run.openAtEnd

    const last = run.rebalances.length ? run.rebalances[run.rebalances.length - 1] : null
    if (last) {
      const tset = new Set(last.targets)
      lastScreen = last.top.map((r, i) => ({
        symbol: r.sym,
        changePct: r.mom * 100,
        rank: i + 1,
        passed: tset.has(r.sym),
        reasons: tset.has(r.sym)
          ? [`12-1 모멘텀 ${(r.mom * 100).toFixed(1)}% · 상위 ${last.denom}`]
          : [
              r.mom < 0
                ? `절대모멘텀 게이트 — 12-1 ${(r.mom * 100).toFixed(1)}% < 0 이라 이 슬롯은 현금`
                : `상위 ${last.denom} 밖 (12-1 ${(r.mom * 100).toFixed(1)}%)`,
            ],
      }))
      lastScreenDate = last.date
    }

    perYear.push({
      year: y,
      mapped: tradable.length,
      total: codes.length,
      cash: false,
      strategyPct: (yearRatio - 1) * 100,
      benchPct: benchYearRatio != null ? (benchYearRatio - 1) * 100 : null,
      trades: run.trades.length,
      symbols: tradable,
    })
  }

  const spanStart = equity.length ? equity[0].date : from || (years.length ? yearStartOf(years[0]) : '')
  const spanEnd = equity.length ? equity[equity.length - 1].date : spanStart
  const span = spanStart && spanEnd ? yearsBetween(spanStart, spanEnd) : 1

  const totalPct = (factor - 1) * 100
  const cagrPct = annualize(factor, span)
  const mddAbs = Math.abs(mdd)
  const executedBench = perYear.some((r) => r.benchPct != null)
  const benchTotalPct = executedBench ? (benchFactor - 1) * 100 : null
  const benchCagrPct = benchTotalPct != null ? annualize(benchFactor, span) : null

  const closed = trades.filter((t) => t.exitDate != null)
  const wins = closed.filter((t) => (t.pnlPct ?? 0) > 0).length
  const mappedRows = perYear.filter((r) => r.total > 0)

  const exitBreakdown: ExitBreakdown[] =
    closed.length > 0
      ? [
          {
            kind: 'conditionExit',
            label: '리밸런스 교체(월초 시가)',
            count: closed.length,
            avgPnlPct: closed.reduce((s, t) => s + (t.pnlPct ?? 0), 0) / closed.length,
          },
        ]
      : []

  return {
    equity,
    trades,
    perYear,
    rebalances,
    startDate: spanStart,
    endDate: spanEnd,
    years: span,
    totalPct,
    cagrPct,
    mddPct: mdd,
    objective: mddAbs > 0.01 ? totalPct / mddAbs : null,
    benchTotalPct,
    benchCagrPct,
    alphaCagrPct: benchCagrPct != null ? cagrPct - benchCagrPct : null,
    alphaTotalPct: benchTotalPct != null ? totalPct - benchTotalPct : null,
    tradeCount: closed.length,
    winRate: closed.length ? (wins / closed.length) * 100 : null,
    avgPnlPct: closed.length ? closed.reduce((s, t) => s + (t.pnlPct ?? 0), 0) / closed.length : null,
    openAtEnd,
    exitBreakdown,
    lastScreen,
    lastScreenDate,
    mappedAvgPct: mappedRows.length
      ? (mappedRows.reduce((s, r) => s + r.mapped / r.total, 0) / mappedRows.length) * 100
      : null,
  }
}
