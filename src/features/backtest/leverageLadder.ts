// 동적 레버리지 사다리(Leverage Ladder) — QQQ → QLD → TQQQ 단계 스위칭 엔진.
//
// ── 무엇을 하는 전략인가 ─────────────────────────────────────────────────────
//   평시에는 QQQ 100%를 들고 있다가, **기초지수(QQQ)가 고점 대비 얼마나 빠졌는지**로
//   레버리지 배수를 올린다. 더 빠질수록 더 공격적으로 바꿔 타고(QQQ→QLD→TQQQ),
//   회복하면 같은 사다리를 거꾸로 내려와 QQQ로 돌아온다.
//   "분할 익절"은 별도 로직이 아니라 **사다리를 한 칸씩 내려오는 것 그 자체**다.
//
//   이 파일은 UI 무의존 순수 모듈이다(presets.ts와 같은 규약) — 화면과 헤드리스
//   러너가 **같은 구현**을 읽어야 두 수치가 비교 가능하기 때문이다. React를 import하지 않는다.
//
// ── 🚫 규칙 1(미래참조 금지) — 이 파일에서 지킨 것 ────────────────────────────
//   1. 고점은 **확장 윈도우 러닝 맥스**다 — `peak_i = max(close[0..i])`. 전 구간
//      최대값(규칙 1-5 위반)이 아니라 그 시점까지만 본다.
//   2. 신호는 봉 i의 **종가**로 판정하고 체결은 봉 i+1의 **시가**다(규칙 1-2).
//      "오늘 종가를 보고 오늘 시가에 갈아탔다"가 되지 않는다.
//   3. 마지막 봉에서는 **갈아타지 않는다**(규칙 1-6) — 체결할 다음 봉이 없다.
//   4. 밴드 경계·버퍼는 **고정 상수**다. 구간 전체 통계로 임계값을 정하지 않는다(규칙 1-5).
//   집행자는 `tests/leverageladder.test.ts`의 절단 불변성 테스트다.
//
// ── ⚠️ 이 전략이 안고 있는 구조적 위험 (규칙 4) ───────────────────────────────
//   레버리지 ETF는 **일간 배수**를 추종한다. 횡보장에서 변동성 잠식(volatility decay)이
//   누적되고, 3배는 하루 -33.4%에서 이론상 전액 소멸한다. 사다리 아래칸(TQQQ)은
//   **가장 깊은 낙폭 구간에서 켜지므로** 그 위험을 정확히 최악의 순간에 떠안는다.
//   이 구현은 그 위험을 없애지 않는다 — 측정 가능하게 만들 뿐이다.

import type { DailyBar } from '../../lib/history'

export type Curve = { date: string; equity: number }[]

/** 사다리 한 칸 = "이 단계에서 들고 있을 종목". 0번이 평시(무레버리지)다. */
export const DEFAULT_LADDER = ['QQQ', 'QLD', 'TQQQ'] as const

/** 기초지수 — 낙폭 판정 기준. 매매 대상이자 사다리 0칸이기도 하다. */
export const LADDER_BASE = 'QQQ'

export interface LadderParams {
  /** 밴드 폭(%). 20이면 고점 대비 -20%마다 한 칸씩 내려간다. */
  stepPct: number
  /**
   * 복귀 버퍼(%p). 경계선에서 신호가 떨리며 왕복 매매하는 것(휩소)을 막는다.
   * 0이면 버퍼 없음 — 경계를 스치기만 해도 갈아탄다.
   */
  bufPct: number
  /** 단계별 보유 종목. 길이가 곧 단계 수다. */
  ladder: readonly string[]
}

export const DEFAULT_LADDER_PARAMS: LadderParams = {
  stepPct: 20,
  bufPct: 3,
  ladder: DEFAULT_LADDER,
}

/** 미장 비용 전제 — 국내 거래세(taxPct)가 없다는 점이 국장 기본값과 다르다. */
export interface LadderCost {
  initialCapital: number
  /** 편도 수수료 % */
  feePct: number
  /** 편도 슬리피지 % */
  slippagePct: number
}

export const US_LADDER_COST: LadderCost = {
  initialCapital: 10_000,
  feePct: 0.01,
  slippagePct: 0.05,
}

/**
 * 낙폭 → 사다리 칸. **직전 칸에서 출발하는 상태 전이**이며 순수 함수다.
 *
 * 방향에 따라 규칙이 다르다 — 이것이 "분할 익절"의 실제 구현이다:
 *   · 하락(칸 ↑): 경계를 넘으면 **즉시** 내려간다. 급락에 대응이 늦으면 전략의 의미가 없다.
 *   · 회복(칸 ↓): 경계 + `bufPct`만큼 **더** 회복해야 한 칸 올라온다. 한 번에 여러 칸을
 *     건너뛰어 올라올 수도 있다(V자 반등).
 *
 * @param ddPct 고점 대비 낙폭(%). 음수이거나 0.
 * @param prevStep 직전 봉의 칸(0 = 평시)
 */
export function ladderStep(ddPct: number, prevStep: number, p: LadderParams): number {
  const maxStep = p.ladder.length - 1
  let step = Math.min(Math.max(prevStep, 0), maxStep)
  // 하락 방향 — 버퍼 없이 즉시
  while (step < maxStep && ddPct <= -((step + 1) * p.stepPct)) step++
  // 회복 방향 — 버퍼를 넘겨야 올라온다
  while (step > 0 && ddPct > -(step * p.stepPct) + p.bufPct) step--
  return step
}

export interface LadderSwitch {
  date: string
  from: string
  to: string
  /** 갈아탄 시점의 기초지수 낙폭(%) */
  ddPct: number
}

export interface LadderRun {
  equity: Curve
  switches: LadderSwitch[]
  /** 단계별 보유 일수 — "실제로 TQQQ를 며칠이나 들고 있었나" */
  daysInStep: number[]
  /** 마지막 봉에서 들고 있던 종목 */
  finalSymbol: string
}

/**
 * 사다리 시뮬레이션.
 *
 * @param base 기초지수(QQQ) 봉 — 낙폭 판정에만 쓴다.
 * @param assets 사다리 종목별 봉. **모든 종목이 base와 같은 날짜 축**이어야 한다
 *   (호출부에서 `alignBars`로 맞춰 넘긴다). 어긋난 축을 그대로 받으면 체결가가
 *   다른 날 가격이 되므로 **던진다** — 조용히 맞추지 않는다.
 */
export function runLeverageLadder(
  base: readonly DailyBar[],
  assets: ReadonlyMap<string, readonly DailyBar[]>,
  p: LadderParams,
  cost: LadderCost,
): LadderRun {
  for (const sym of p.ladder) {
    const bars = assets.get(sym)
    if (!bars) throw new Error(`사다리 종목 ${sym}의 봉이 없다 — 없는 채로 돌면 그 칸이 조용히 사라진다`)
    if (bars.length !== base.length)
      throw new Error(`${sym} 봉 수(${bars.length})가 기초지수(${base.length})와 다르다 — 날짜 축을 먼저 맞춰라`)
  }

  const equity: Curve = []
  const switches: LadderSwitch[] = []
  const daysInStep = new Array<number>(p.ladder.length).fill(0)

  const sideCost = (cost.feePct + cost.slippagePct) / 100

  let step = 0
  let symbol = p.ladder[0]
  // 첫 봉 시가에 진입한다(진입 비용 1회 반영).
  const firstOpen = assets.get(symbol)![0].o
  if (!(firstOpen > 0)) throw new Error(`${symbol} 첫 봉 시가가 유효하지 않다 (${firstOpen})`)
  let shares = (cost.initialCapital * (1 - sideCost)) / firstOpen

  let peak = base[0].c
  // 신호는 종가로 만들고 체결은 다음 봉 시가 — 그래서 "예약된 목표 칸"을 하루 들고 간다.
  let pendingStep = 0

  for (let i = 0; i < base.length; i++) {
    // ── 1) 체결: 전 봉 종가에서 만든 신호를 오늘 시가에 집행한다 ──────────────
    if (i > 0 && pendingStep !== step) {
      const nextSymbol = p.ladder[pendingStep]
      const sellOpen = assets.get(symbol)![i].o
      const buyOpen = assets.get(nextSymbol)![i].o
      if (!(sellOpen > 0) || !(buyOpen > 0))
        throw new Error(`${base[i].date} 시가가 유효하지 않다 (${symbol} ${sellOpen} → ${nextSymbol} ${buyOpen})`)
      const proceeds = shares * sellOpen * (1 - sideCost)
      shares = (proceeds * (1 - sideCost)) / buyOpen
      switches.push({
        date: base[i].date,
        from: symbol,
        to: nextSymbol,
        ddPct: (base[i - 1].c / peak - 1) * 100,
      })
      symbol = nextSymbol
      step = pendingStep
    }

    // ── 2) 평가: 오늘 종가 기준 자산 ─────────────────────────────────────────
    const close = assets.get(symbol)![i].c
    equity.push({ date: base[i].date, equity: shares * close })
    daysInStep[step]++

    // ── 3) 신호: 오늘 종가까지만 보고 내일 칸을 정한다 ───────────────────────
    //     고점은 오늘 종가를 포함한 **확장 러닝 맥스**다(규칙 1-1).
    if (base[i].c > peak) peak = base[i].c
    const ddPct = (base[i].c / peak - 1) * 100
    // 마지막 봉에서는 체결할 다음 봉이 없다 — 신규 전환을 만들지 않는다(규칙 1-6).
    pendingStep = i === base.length - 1 ? step : ladderStep(ddPct, step, p)
  }

  return { equity, switches, daysInStep, finalSymbol: symbol }
}

/**
 * 여러 종목의 봉을 **교집합 날짜**로 맞춘다. 한 종목이라도 없는 날은 통째로 버린다 —
 * 빠진 날을 직전값으로 메우면 그 종목의 수익률이 0으로 조작되기 때문이다.
 */
export function alignBars(series: ReadonlyMap<string, readonly DailyBar[]>): Map<string, DailyBar[]> {
  const symbols = [...series.keys()]
  if (symbols.length === 0) return new Map()
  const maps = symbols.map((s) => new Map((series.get(s) ?? []).map((b) => [b.date, b])))
  const dates = [...maps[0].keys()].filter((d) => maps.every((m) => m.has(d))).sort()
  const out = new Map<string, DailyBar[]>()
  symbols.forEach((s, i) => out.set(s, dates.map((d) => maps[i].get(d)!)))
  return out
}

// ============================================================================
// 합성 레버리지 — **검증용이며 판정 근거가 아니다**
// ============================================================================
//
// TQQQ는 2010-02-11, QLD는 2006-06-21 상장이다. 그 이전 구간의 "QLD/TQQQ 수익률"은
// 세상에 존재하지 않는다. 닷컴(2000~2002)·금융위기(2008)를 포함한 백테스트는
// 반드시 **합성**이며, 합성은 다음을 근사할 뿐이다:
//   · 일간 배수 추종 (경로 의존성은 재현됨)
//   · 운용보수 (연 단위 → 일할)
//   · 차입비용 (배수-1에 비례) ← **이 값이 [미검증]이다.** 실제로는 금리를 따라 움직이며
//     2000년대 초 5%대에서 2010년대 0%대까지 크게 변한다. 고정값으로 근사하면
//     고금리 구간의 성적이 후해진다.
// 그래서 합성 곡선은 **표에 별도 표기하고 판정(관문)에는 넣지 않는다.**

export interface SynthParams {
  /** 배수 (QLD=2, TQQQ=3) */
  leverage: number
  /** 연 운용보수 % (QLD 0.95 · TQQQ 0.84) */
  expenseAnnualPct: number
  /** 연 차입비용 % — [미검증] 고정 근사 */
  financingAnnualPct: number
}

export const TRADING_DAYS = 252

/**
 * 기초지수 봉 → 합성 레버리지 봉. 시가·종가 모두 같은 일간 배수 규칙으로 굴린다.
 * 첫 봉은 기준점(100)이며 수익률이 정의되지 않으므로 배수를 적용하지 않는다.
 */
export function synthLeveraged(base: readonly DailyBar[], p: SynthParams): DailyBar[] {
  const drag = (p.expenseAnnualPct + (p.leverage - 1) * p.financingAnnualPct) / 100 / TRADING_DAYS
  const out: DailyBar[] = []
  let level = 100
  for (let i = 0; i < base.length; i++) {
    const b = base[i]
    const prevLevel = level
    if (i > 0) {
      const r = base[i].c / base[i - 1].c - 1
      level = prevLevel * (1 + p.leverage * r - drag)
      if (level < 1e-9) level = 1e-9 // 전액 소멸 근처에서 음수로 넘어가지 않게 바닥을 둔다
    }
    // 시가는 "전일 종가 → 당일 시가" 수익률에 같은 배수를 먹인 값이다.
    // 드래그(보수·차입비용)는 종가 사슬에만 한 번 반영한다 — 시가에도 또 먹이면 하루치를
    // 두 번 빼는 셈이라 체결가가 실제보다 유리해진다.
    const openLevel = i > 0 ? prevLevel * (1 + p.leverage * (b.o / base[i - 1].c - 1)) : prevLevel
    out.push({ date: b.date, t: b.t, o: openLevel, h: openLevel, l: openLevel, c: level, v: 0 })
  }
  return out
}

/**
 * 합성이 실물을 얼마나 따라가나 — **겹치는 구간에서 자기검증**(규칙 4: "정답을 아는
 * 표본으로 자기검증"). 연환산 수익률 차이(%p)를 돌려준다. 이 값이 크면 합성 구간의
 * 수치를 신뢰하면 안 된다.
 */
export function synthTrackingGap(real: readonly DailyBar[], synth: readonly DailyBar[]): number | null {
  const sMap = new Map(synth.map((b) => [b.date, b]))
  const pairs = real.filter((b) => sMap.has(b.date))
  if (pairs.length < 250) return null
  const first = pairs[0]
  const last = pairs[pairs.length - 1]
  const years = (Date.parse(last.date) - Date.parse(first.date)) / (365.25 * 86400e3)
  if (years < 0.5) return null
  const realCagr = (Math.pow(last.c / first.c, 1 / years) - 1) * 100
  const synthCagr = (Math.pow(sMap.get(last.date)!.c / sMap.get(first.date)!.c, 1 / years) - 1) * 100
  return synthCagr - realCagr
}

// ============================================================================
// 비중 분할 사다리 (Proportional Ladder) — 2026-08-05 대표 지시 정본
// ============================================================================
//
// 위 `runLeverageLadder`는 "한 칸 = 한 종목 100%"였다. 대표가 지시한 것은 **비중을
// 쪼개서 섞는** 방식이고, 이쪽이 정본이다. 둘은 낙폭 성격이 근본적으로 다르다 —
// 100% TQQQ는 3배를 통째로 맞지만 QLD 50 / TQQQ 50은 실효 2.5배다.
//
//   평시            QQQ 100%
//   고점 대비 -10%  QQQ 절반을 팔아 QLD 매수      → QQQ 50 / QLD 50
//   고점 대비 -20%  남은 QQQ 전부를 팔아 TQQQ 매수 → QLD 50 / TQQQ 50
//   +10% 오를 때마다 레버리지 평가액의 10%를 팔아 QQQ 매수 (래칫 · 반복)
//   신고가 회복      남은 레버리지를 전부 QQQ로 정리하고 사다리 초기화
//
// ── 🚫 규칙 1 준수 ──────────────────────────────────────────────────────────
//   · 고점은 확장 러닝 맥스 `max(close[0..i])` (규칙 1-5)
//   · 모든 판정은 봉 i 종가, 체결은 봉 i+1 **시가** (규칙 1-2)
//   · 마지막 봉에서는 신규 행동을 만들지 않는다 (규칙 1-6)
//
// ── 트리거 재무장(re-arm) 설계 ───────────────────────────────────────────────
//   고점이 확장 러닝 맥스라 낙폭이 오래 -10% 아래에 머문다. 진입 트리거를 "밴드 안에
//   있으면 발동"으로 두면 되돌림마다 무한 재진입한다. 그래서 **한 하락 국면에서 각
//   트리거는 1회만** 쓰고, **신고가를 새로 쓸 때 국면이 끝나며** 재무장한다.
//   이것이 "평시에 QQQ 들고 있다가"라는 지시와도 맞는다(평시 = 신고가 근처).

export interface ProportionalParams {
  /** 1단 진입 낙폭(%, 양수로 적는다). 지시값 10 */
  band1Pct: number
  /** 2단 진입 낙폭(%, 양수). 지시값 20 */
  band2Pct: number
  /** 1단에서 QQQ 중 QLD로 바꿀 비율(%). 지시값 50 */
  stage1SwapPct: number
  /** 익절 방아쇠 — 직전 매매 시점 대비 기초지수가 이만큼(%) 오르면 1회 익절. 지시값 10 */
  tpStepPct: number
  /** 1회 익절 규모 — 레버리지 평가액 중 파는 비율(%). 지시값 10 */
  tpFracPct: number
}

export const SPEC_PROPORTIONAL: ProportionalParams = {
  band1Pct: 10,
  band2Pct: 20,
  stage1SwapPct: 50,
  tpStepPct: 10,
  tpFracPct: 10,
}

export interface ProportionalEvent {
  date: string
  kind: '1단 진입' | '2단 진입' | '익절' | '신고가 정리'
  ddPct: number
  /** 체결 직후 비중(%) — QQQ / QLD / TQQQ */
  weights: [number, number, number]
}

export interface ProportionalRun {
  equity: Curve
  events: ProportionalEvent[]
  /** 평균 비중(%) — 전 구간 일별 평균 */
  avgWeights: [number, number, number]
  /** 레버리지(QLD+TQQQ)를 조금이라도 들고 있던 일수 */
  daysLevered: number
  trades: number
}

type Holdings = { QQQ: number; QLD: number; TQQQ: number }
const SYMS = ['QQQ', 'QLD', 'TQQQ'] as const
type Sym = (typeof SYMS)[number]

/**
 * 비중 분할 사다리 시뮬레이션.
 *
 * @param base 기초지수(QQQ) 봉 — 낙폭·익절 판정 기준
 * @param assets 세 종목 봉. **base와 날짜 축이 같아야 한다**(`alignBars`로 맞춰 넘긴다).
 */
export function runProportionalLadder(
  base: readonly DailyBar[],
  assets: ReadonlyMap<string, readonly DailyBar[]>,
  p: ProportionalParams,
  cost: LadderCost,
): ProportionalRun {
  for (const s of SYMS) {
    const bars = assets.get(s)
    if (!bars) throw new Error(`${s} 봉이 없다 — 없는 채로 돌면 그 칸이 조용히 사라진다`)
    if (bars.length !== base.length)
      throw new Error(`${s} 봉 수(${bars.length})가 기초지수(${base.length})와 다르다 — 날짜 축을 먼저 맞춰라`)
  }
  if (!(p.band2Pct > p.band1Pct)) throw new Error(`2단 밴드(${p.band2Pct})는 1단(${p.band1Pct})보다 깊어야 한다`)

  const side = (cost.feePct + cost.slippagePct) / 100
  const px = (s: Sym, i: number, field: 'o' | 'c'): number => assets.get(s)![i][field]

  const h: Holdings = { QQQ: 0, QLD: 0, TQQQ: 0 }
  const equity: Curve = []
  const events: ProportionalEvent[] = []
  const wSum: [number, number, number] = [0, 0, 0]
  let daysLevered = 0
  let trades = 0

  // 첫 봉 시가에 QQQ 전량 진입
  const first = px('QQQ', 0, 'o')
  if (!(first > 0)) throw new Error(`QQQ 첫 봉 시가가 유효하지 않다 (${first})`)
  h.QQQ = (cost.initialCapital * (1 - side)) / first

  let peak = base[0].c
  let stage = 0
  let armed1 = true
  let armed2 = true
  /** 익절 기준가 — 마지막으로 매매한 시점의 기초지수 종가 */
  let refPrice = base[0].c

  type Action = '1단 진입' | '2단 진입' | '익절' | '신고가 정리'
  let pending: Action[] = []

  /** 한 종목의 보유분 중 frac(0~1)을 팔아 다른 종목을 산다. 시가 체결. */
  const swap = (from: Sym, to: Sym, frac: number, i: number): void => {
    const qty = h[from] * frac
    if (qty <= 0) return
    const sellPx = px(from, i, 'o')
    const buyPx = px(to, i, 'o')
    if (!(sellPx > 0) || !(buyPx > 0))
      throw new Error(`${base[i].date} 시가가 유효하지 않다 (${from} ${sellPx} → ${to} ${buyPx})`)
    const proceeds = qty * sellPx * (1 - side)
    h[from] -= qty
    h[to] += (proceeds * (1 - side)) / buyPx
    trades++
  }

  for (let i = 0; i < base.length; i++) {
    // ── 1) 체결 — 전 봉 종가에서 만든 행동을 오늘 시가에 집행 ────────────────
    if (i > 0 && pending.length > 0) {
      for (const act of pending) {
        if (act === '1단 진입') {
          swap('QQQ', 'QLD', p.stage1SwapPct / 100, i)
        } else if (act === '2단 진입') {
          swap('QQQ', 'TQQQ', 1, i)
        } else if (act === '익절') {
          swap('QLD', 'QQQ', p.tpFracPct / 100, i)
          swap('TQQQ', 'QQQ', p.tpFracPct / 100, i)
        } else {
          swap('QLD', 'QQQ', 1, i)
          swap('TQQQ', 'QQQ', 1, i)
        }
        const v = SYMS.map((s) => h[s] * px(s, i, 'o'))
        const tot = v[0] + v[1] + v[2]
        events.push({
          date: base[i].date,
          kind: act,
          ddPct: (base[i - 1].c / peak - 1) * 100,
          weights: tot > 0 ? [(v[0] / tot) * 100, (v[1] / tot) * 100, (v[2] / tot) * 100] : [0, 0, 0],
        })
      }
      refPrice = base[i - 1].c
      pending = []
    }

    // ── 2) 평가 ─────────────────────────────────────────────────────────────
    const vals = SYMS.map((s) => h[s] * px(s, i, 'c'))
    const total = vals[0] + vals[1] + vals[2]
    equity.push({ date: base[i].date, equity: total })
    if (total > 0) SYMS.forEach((_, k) => (wSum[k] += (vals[k] / total) * 100))
    if (vals[1] + vals[2] > total * 1e-9) daysLevered++

    // ── 3) 신호 — 오늘 종가까지만 보고 내일 행동을 정한다 ────────────────────
    const c = base[i].c
    const newPeak = c > peak
    if (newPeak) peak = c
    const dd = (c / peak - 1) * 100
    const levered = h.QLD > 0 || h.TQQQ > 0

    if (i === base.length - 1) {
      pending = [] // 마지막 봉 — 체결할 다음 봉이 없다(규칙 1-6)
      continue
    }

    const next: Action[] = []
    if (newPeak) {
      // 국면 종료 — 남은 레버리지를 정리하고 트리거 재무장
      if (levered) next.push('신고가 정리')
      stage = 0
      armed1 = true
      armed2 = true
    } else {
      if (armed1 && stage < 1 && dd <= -p.band1Pct) {
        next.push('1단 진입')
        stage = 1
        armed1 = false
      }
      if (armed2 && stage < 2 && dd <= -p.band2Pct) {
        next.push('2단 진입')
        stage = 2
        armed2 = false
      }
      // 익절 래칫 — 레버리지를 들고 있고 기준가 대비 tpStep만큼 올랐을 때
      if (next.length === 0 && levered && c >= refPrice * (1 + p.tpStepPct / 100)) next.push('익절')
    }
    pending = next
  }

  const n = Math.max(1, equity.length)
  return {
    equity,
    events,
    avgWeights: [wSum[0] / n, wSum[1] / n, wSum[2] / n],
    daysLevered,
    trades,
  }
}
