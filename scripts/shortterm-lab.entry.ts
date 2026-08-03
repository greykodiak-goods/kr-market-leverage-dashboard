// 단기매매 랩 — 국내에서 유명한 단기 거래 기법 14변형을 KRX 실측 유니버스로 검증 (36차)
//
//   대표 지시(2026-08-03): "종가매수, 상한가 따라잡기 등 유명한 단기 거래 기술들도 다 체크해봐."
//
// ── 무엇을 재는가 ────────────────────────────────────────────────────────────
//   국내 개인투자자 사이에서 이름이 붙어 돌아다니는 단기 기법들을 **같은 깔때기**에
//   태운다. 유니버스(KRX 실측 40+40)·비용·벤치(KODEX 200)·판정(전·후반 알파 + 매매수)이
//   전부 34차(MODE=krxcal)와 같고, 바뀌는 것은 **진입 신호와 청산 규칙뿐**이다.
//   그래야 "단기 기법이 특별히 좋은가"라는 질문이 34차 표와 나란히 읽힌다.
//
//   총 **14변형 고정**이다. 격자를 늘리지 않는다 — 회전율이 극단적인 계열에서 변형을
//   늘리는 것은 다중검정 위양성을 사는 것과 같다(24~27·34차에서 반복 확인).
//
//     ① 종가 매수 → 익일 시가 매도(오버나이트)   3변형
//     ② 상한가 따라잡기                          4변형
//     ③ 갭 매매                                  3변형
//     ④ 장대양봉 다음날                          2변형
//     ⑤ 연속 하락 반등                           2변형
//
// ── 🚫 규칙 1(미래참조 금지) 처리 ────────────────────────────────────────────
//   이 실험의 **가장 큰 위험**이 여기다. 단기 기법은 "오늘 종가를 보고 오늘 종가에 산다",
//   "오늘 상한가를 보고 오늘 샀다" 같은 말로 유통되는데, 그대로 코딩하면 전부 미래참조다.
//
//   · **종가 매수(①)** — "당일 종가에 산다"는 체결 시점이지 판단 시점이 아니다.
//     후보 선정은 **전일까지 확정된 봉**(`bars[0..i−1]`)으로만 하고, 체결만 당일 종가에
//     한다. 당일 등락률·당일 거래대금으로 당일 종가 매수 대상을 고르는 것은 그 자체가
//     미래참조라 **구현하지 않았다**(②③의 상승·거래대금 필터도 전부 **전일** 기준이다).
//   · **신호 → 체결 분리(②④⑤)** — 상한가·장대양봉·연속하락은 **그날 종가가 확정된 뒤**
//     판정되므로 체결은 **익일 시가**다. 같은 날 시가에 샀다고 계산하지 않는다.
//   · **갭 매매(③)만 예외적으로** 진입봉의 **시가 하나**를 판단에 쓴다(갭은 시가로만
//     정의된다). 시가는 09:00에 확정되고 체결은 그 뒤이므로 시간 순서를 거스르지는
//     않지만, **일봉으로는 판단가와 체결가가 같은 점**이 되어 버린다 — 이것은 미래참조가
//     아니라 **체결 현실성 문제**이며, 절단 불변성 테스트로는 잡히지 않는다.
//     그래서 아래 경고 블록에 못 박아 두고, 시그니처(`entryOpen`)로 "시가 외의 당일
//     정보는 못 본다"는 것을 구조로 막았다(`tests/shortterm.test.ts`가 집행).
//   · **롤링 통계는 당일 제외** — 20일 평균거래량은 `bars[j−20..j−1]`이다(규칙 1-3).
//   · **손절·익절 체결 보수성** — 갭 관통 시 손절은 **시가**(더 불리한 쪽), 익절은
//     **기준가**(유리한 쪽으로 앞당기지 않는다). 같은 봉에서 둘 다 닿으면 **손절 먼저**.
//   · **마지막 봉 신규 진입 금지** — 데이터 마지막 봉에서는 어떤 계열도 신규 진입을
//     만들지 않는다(규칙 1-6). 당일 왕복 계열도 같은 규약으로 묶는다.
//   · 집행자는 `tests/shortterm.test.ts`의 **계열별 절단 불변성 + 신호 미래맹목성**
//     테스트다. 신호 함수는 `bars[entryIdx..]`를 극단값으로 바꿔도 결과가 같아야 한다.
//
// ── ⚠️ 체결 현실성 (이 실험의 핵심 정직성) ───────────────────────────────────
//   이 계열은 **백테스트가 가장 크게 거짓말하는 자리**다. 아래 경고는 결과 표를 찍는
//   함수(`shortRankTable`)가 **강제로 함께 출력**한다 — 표만 떼어 읽을 수 없게 했다.
//
// ── 실행 ─────────────────────────────────────────────────────────────────────
//   MODE=all node scripts/shortterm-lab.mjs      (GHA: short:all)
//   MODE=close|limitup|gap|bigcandle|rebound     (같은 14변형의 부분집합 — 새 변형 아님)
//
// ⚠️ 컨테이너에서 Yahoo는 403이라 실데이터 실행은 여기서 하지 않았다.
//    로직은 합성 시세 테스트로만 검증된 상태다 — 수치 산출은 [미검증-실데이터].

import type { CostSettings } from '../src/features/backtest/conditionScreen'
import type { DailyBar } from '../src/features/backtest/types'
import {
  KRXPIT_FROM,
  KRXPIT_HALF,
  KRXPIT_TO,
  MAX_POSITIONS,
  SCREEN_MIN_TRADES,
  benchCurve,
  binomTail,
  bookBuy,
  bookMark,
  bookSell,
  buildYearly,
  calmarOf,
  f1,
  loadKrxPitFile,
  log,
  makeSimCtx,
  newBook,
  perYearTable,
  runCustomChain,
  spanOf,
  summarizeStrat,
  toKrwCurve,
  wallOf,
  wallTable,
  type CalWall,
  type ChainStats,
  type CustomYearRun,
  type FillEvent,
  type StratRow,
  type YearSlice,
} from './idea-lab.entry'
import {
  krxPitCodes,
  krxPitNames,
  krxPitSourceNote,
  krxPitSpan,
  krxPitUnion,
  krxPitYears,
} from '../src/features/backtest/krxPitUniverse'

// ============================================================================
// 상수 — 34차(krxcal)와 **같은 값**이어야 표가 나란히 읽힌다
// ============================================================================

/** 비용 전제. MODE=krxcal과 동일(수수료·거래세·슬리피지). `tests/shortterm.test.ts`가 대조한다. */
export const COST: CostSettings = { initialCapital: 10_000_000, feePct: 0.015, taxPct: 0.15, slippagePct: 0.1 }
/** 비용 민감도용 — 이 계열은 회전율이 극단적이라 비용이 성패를 지배한다. */
export const COST_FREE: CostSettings = { initialCapital: COST.initialCapital, feePct: 0, taxPct: 0, slippagePct: 0 }
/** 알파 판정 벤치(규칙 5). KODEX 200. */
export const BENCH = '069500.KS'
/** 시세 로드 구간 — 2010년 시작 유니버스에 워밍업(이평·연속하락 등)을 붙인다. */
export const SHORT_RANGE = 'since:2008-01-01'
/** 보유 종목수 상한 = 슬롯 수. 34차와 같은 10. */
export const SHORT_SLOTS = MAX_POSITIONS
/** 표본 소실 판정선 — 계열 간 기준이 다르면 비교가 깨지므로 MODE=screen/krxcal과 같은 값. */
export const SHORT_MIN_TRADES = SCREEN_MIN_TRADES

/** 장대양봉 판정 — 몸통(종가÷시가−1) 임계와 거래량 배수·평균 윈도우. */
export const SHORT_BODY_PCT = 8
export const SHORT_VOL_WINDOW = 20
export const SHORT_VOL_MULT = 3
/** 갭 임계(±%). */
export const SHORT_GAP_PCT = 3
/** 상한가 따라잡기 ②-2의 익절·손절(진입일 시가 대비 %). */
export const SHORT_TP_PCT = 5
export const SHORT_SL_PCT = 3
/**
 * 익절·손절 미도달 시 강제 청산까지의 보유일(진입일 포함).
 * 지시서의 청산 규칙 ②에는 기한이 없지만, 기한 없는 규칙은 백테스트에서 "언젠가는 닿는다"로
 * 흘러 손절 규칙의 의미가 사라진다. 같은 계열의 최장 변형(②-4 = 5일)에 맞춰 상한을 둔다 —
 * 그래야 ②-2와 ②-4가 **같은 기간, 다른 청산 규칙**의 A/B가 된다.
 */
export const SHORT_TS_MAX_DAYS = 5
/** 연속 하락 반등의 연속일수. */
export const SHORT_REBOUND_DAYS = [3, 5] as const

// ---- 상한가 제도 경계 --------------------------------------------------------
//
// 한국거래소 가격제한폭은 **2015-06-15부터 ±30%**로 확대됐다(그 전 ±15%).
// 이 경계를 무시하고 한 임계로 전 구간을 판정하면 2010~2015 구간의 상한가가 통째로
// 사라지거나(29.5% 기준), 2015 이후에 상한가가 아닌 급등이 상한가로 잡힌다(14.5% 기준).
// 두 경우 모두 "상한가 따라잡기"라는 실험 자체가 무의미해진다.
/** 가격제한폭 ±30% 시행일. 이 날짜 **이상**이면 신제도. */
export const LIMITUP_REGIME_DATE = '2015-06-15'
/** 구제도(±15%) 판정 임계 — 호가단위 절사 때문에 정확히 15.00%가 안 나온다. */
export const LIMITUP_TH_OLD = 14.5
/** 신제도(±30%) 판정 임계. */
export const LIMITUP_TH_NEW = 29.5
/** 그 날짜에 적용되는 상한가 판정 임계(전일 종가 대비 상승률 %). */
export function limitUpThresholdPct(date: string): number {
  return date < LIMITUP_REGIME_DATE ? LIMITUP_TH_OLD : LIMITUP_TH_NEW
}
/** 고가=종가(상한가 굳힘) 판정의 부동소수 허용치. OHLC에 같은 보정계수가 곱해지므로 사실상 0. */
export const LIMITUP_HIGH_EPS = 1e-7

// ============================================================================
// 데이터 로더
// ============================================================================
//
// ⚠️ `scripts/idea-lab.entry.ts`의 로더는 **export되어 있지 않고**, 그 파일은 이번
//    회차에 다른 워커가 잡고 있어 수정할 수 없다. 그래서 같은 규약(총수익 보정 ·
//    .KQ→.KS 폴백 · 직전 환율 이월)을 여기에 복제한다. 정본 합류는 별도 작업이다.

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function fetchDaily(symbol: string, range = SHORT_RANGE): Promise<DailyBar[]> {
  const qs = range.startsWith('since:')
    ? `period1=${Math.floor(Date.parse(range.slice(6)) / 1000)}&period2=${Math.floor(Date.now() / 1000)}`
    : `range=${range}`
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    symbol,
  )}?${qs}&interval=1d&events=div%2Csplit`
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
    // 총수익 보정(규칙 3): adjclose ÷ close 계수를 OHLC에 적용 (배당 재투자 기준)
    const f = adj[i] != null && Number.isFinite(adj[i]!) && cl > 0 ? adj[i]! / cl : 1
    const date = new Date(ts[i] * 1000 + 9 * 3600 * 1000).toISOString().slice(0, 10) // KST
    out.push({ date, t: ts[i], o: o * f, h: h * f, l: l * f, c: cl * f, v: Number.isFinite(v) ? v : 0 })
  }
  return out
}

/** 코스닥 출신 종목 폴백 로드 — .KQ 우선, 실패/짧으면 .KS */
async function fetchKrDual(code: string, range: string): Promise<DailyBar[] | null> {
  let best: DailyBar[] | null = null
  for (const suffix of ['.KQ', '.KS']) {
    try {
      const bars = await fetchDaily(`${code}${suffix}`, range)
      if (!best || bars.length > best.length) best = bars
      if (bars.length >= 200) break
    } catch {
      /* 다음 접미사 시도 */
    }
    await sleep(120)
  }
  return best && best.length >= 200 ? best : null
}

async function loadCodeHistories(codes: string[], range = SHORT_RANGE) {
  const histories: Record<string, DailyBar[]> = {}
  const failed: string[] = []
  for (const code of codes) {
    const bars = await fetchKrDual(code, range)
    if (bars) histories[code] = bars
    else failed.push(code)
    await sleep(100)
  }
  const bench = await fetchDaily(BENCH, range)
  return { histories, failed, bench }
}

/** QQQ 원화 환산 보유 곡선(참고 벽). 실패하면 null — 벽 행만 빠지고 모드는 계속 돈다. */
async function loadQqqKrwCurve(range = SHORT_RANGE): Promise<{ curve: { date: string; equity: number }[]; note: string } | null> {
  try {
    const qqq = await fetchDaily('QQQ', range)
    await sleep(120)
    const fx = await fetchDaily('KRW=X', range)
    const curve = toKrwCurve(qqq, fx)
    if (curve.length < 2) {
      log('⚠️ QQQ 원화 환산 실패 — 환율(KRW=X) 구간이 겹치지 않는다. 벽 행 생략.')
      return null
    }
    return { curve, note: `환산: Yahoo KRW=X 종가 · 결측일 직전 환율 이월 · QQQ ${qqq.length}봉 / 환율 ${fx.length}봉` }
  } catch (e) {
    log(`⚠️ QQQ·환율 로드 실패 — 벽 행 생략 (${String(e)})`)
    return null
  }
}

// ============================================================================
// 신호 — 계약: `bars[0..entryIdx−1]` + (허용된 계열만) `entryOpen`
// ============================================================================

/** 사전계산 시리즈. `avgVol[j]`는 `bars[j−N..j−1]` 평균 = **당일 제외**(규칙 1-3). */
export interface SymAux {
  avgVol: (number | null)[]
}

/**
 * 20일(기본) 평균거래량 — **당일을 제외한** 직전 N일. 당일을 넣으면 급증일 자신이
 * 분모를 밀어올려 "3배" 판정이 조용히 느슨해진다.
 */
export function avgVolSeries(bars: DailyBar[], win = SHORT_VOL_WINDOW): (number | null)[] {
  const out: (number | null)[] = new Array(bars.length).fill(null)
  // 반복 진입 시점의 `sum` 불변식: v[i−win .. i−1]의 합. i < win이면 창이 안 차 null.
  let sum = 0
  for (let i = 0; i < bars.length; i++) {
    if (i >= win) {
      out[i] = sum / win
      sum -= bars[i - win].v // 창 밖으로 나간 봉을 뺀 뒤
    }
    sum += bars[i].v // 오늘 봉을 넣으면 다음 반복의 불변식이 성립한다
  }
  return out
}

/**
 * 신호 함수 계약.
 *
 *   · `bars[j]`는 **j ≤ entryIdx−1**만 읽는다. `bars[entryIdx]` 이후를 읽으면 미래참조다.
 *   · `entryOpen`은 갭 계열에만 값이 들어온다(진입봉 **시가 하나**). 그 외엔 null이며,
 *     null인 계열이 시가를 보려면 방법이 없다 — 구조로 막았다.
 *   · `aux.avgVol[j]` 역시 j ≤ entryIdx−1에서만 읽는다.
 */
export type ShortSignal = (bars: DailyBar[], entryIdx: number, entryOpen: number | null, aux: SymAux) => boolean

/** 전일 종가 대비 상승률(%) — `bars[s]`가 전일 종가 대비 얼마 올랐나. */
export function chgPct(bars: DailyBar[], s: number): number | null {
  if (s < 1) return null
  const prev = bars[s - 1].c
  if (!(prev > 0)) return null
  return (bars[s].c / prev - 1) * 100
}

/** 상한가 마감 판정 — 전일 종가 대비 제도별 임계 이상 + **고가 = 종가**(상한가 굳힘). */
export function isLimitUpClose(bars: DailyBar[], s: number): boolean {
  const chg = chgPct(bars, s)
  if (chg == null) return false
  const b = bars[s]
  if (!(b.c > 0)) return false
  if (chg < limitUpThresholdPct(b.date)) return false
  return b.h <= b.c * (1 + LIMITUP_HIGH_EPS)
}

/** 장대양봉 — 몸통(종가÷시가−1) 임계 이상 + 거래량이 직전 N일 평균의 M배 이상. */
export function isBigCandle(bars: DailyBar[], s: number, aux: SymAux): boolean {
  const b = bars[s]
  if (!(b.o > 0) || !(b.c > 0)) return false
  if ((b.c / b.o - 1) * 100 < SHORT_BODY_PCT) return false
  const avg = aux.avgVol[s]
  return avg != null && avg > 0 && b.v >= avg * SHORT_VOL_MULT
}

/** k일 연속 종가 하락으로 마감했나(`bars[s]`가 마지막 하락일). */
export function isDownStreak(bars: DailyBar[], s: number, k: number): boolean {
  if (s < k) return false
  for (let j = 0; j < k; j++) if (!(bars[s - j].c < bars[s - j - 1].c)) return false
  return true
}

/** 전일 거래대금 근사 = 전일 종가 × 전일 거래량. 후보가 슬롯보다 많을 때의 정렬키. */
export function prevTradingValue(bars: DailyBar[], entryIdx: number): number {
  const s = entryIdx - 1
  if (s < 0) return 0
  const b = bars[s]
  return b.c > 0 && b.v > 0 ? b.c * b.v : 0
}

// ============================================================================
// 변형 정의 — 총 14. 임의 확장 금지(다중검정 분모가 곧 이 숫자다).
// ============================================================================

export type ShortFamily = 'close' | 'limitup' | 'gap' | 'bigcandle' | 'rebound'

export const FAMILY_LABEL: Record<ShortFamily, string> = {
  close: '① 종가 매수 → 익일 시가 매도(오버나이트)',
  limitup: '② 상한가 따라잡기',
  gap: '③ 갭 매매',
  bigcandle: '④ 장대양봉 다음날',
  rebound: '⑤ 연속 하락 반등',
}

/** 진입 체결 기준가 — 진입봉의 시가인가 종가인가. */
export type EntryPrice = 'open' | 'close'

/**
 * 신호가 볼 수 있는 정보의 범위.
 *   · `prevBars`          — `bars[0..entryIdx−1]`만. (①②④⑤)
 *   · `prevBarsPlusOpen`  — 위 + 진입봉 **시가 하나**. (③ 갭 계열 전용)
 */
export type SignalScope = 'prevBars' | 'prevBarsPlusOpen'

export type ExitRule =
  /** 진입 다음 거래일 **시가**에 청산(오버나이트). */
  | { kind: 'nextOpen' }
  /** 진입일 포함 N거래일째 **종가**에 청산. N=1이면 진입 당일 종가. */
  | { kind: 'holdDays'; days: number }
  /** 장중 익절·손절, 둘 다 미도달이면 진입일 포함 `maxDays`거래일째 종가에 강제 청산. */
  | { kind: 'targetStop'; targetPct: number; stopPct: number; maxDays: number }

/** 후보가 슬롯보다 많을 때의 선정 규칙. */
export type PickRule =
  /** 전일 거래대금 내림차순(동점은 코드 오름차순). */
  | 'value'
  /**
   * 유니버스 순환 — "전 종목 균등"을 슬롯 10 제약 아래 구현하는 방법.
   * 코드 오름차순으로 세운 뒤 시작점을 거래일 인덱스로 밀어 유니버스 전체를 고르게
   * 돈다. 고정 부분집합(코드순 상위 10)을 쓰면 유니버스의 1/8만 영구히 대표하게 된다.
   * 순환 위치는 **거래일 인덱스만으로** 정해지므로 미래참조가 아니다.
   */
  | 'rotate'

export interface ShortPlan {
  key: string
  label: string
  family: ShortFamily
  scope: SignalScope
  entryPrice: EntryPrice
  exit: ExitRule
  pick: PickRule
  /** 20일 평균거래량이 필요한 계열만 true — 불필요한 사전계산을 안 돈다. */
  needsVolAvg: boolean
  signal: ShortSignal
  /** 표에 붙는 한 줄 설명(규칙 1 처리·체결 가정). */
  note: string
}

const holdDays = (days: number): ExitRule => ({ kind: 'holdDays', days })

/**
 * 14변형. 순서를 고정해 출력이 실행마다 흔들리지 않게 한다.
 *
 * ⚠️ 종가 매수 3변형의 필터는 **전부 전일 기준**이다. "당일 상승 종목을 당일 종가에
 *    산다"는 흔한 서술을 그대로 옮기면 미래참조가 된다 — 그 형태는 구현하지 않았다.
 */
export function shortPlans(): ShortPlan[] {
  const plans: ShortPlan[] = [
    // ---- ① 종가 매수 → 익일 시가 매도 -------------------------------------
    {
      key: 'close-all',
      label: '①-1 종가매수 · 전 종목 균등',
      family: 'close',
      scope: 'prevBars',
      entryPrice: 'close',
      exit: { kind: 'nextOpen' },
      pick: 'rotate',
      needsVolAvg: false,
      signal: (bars, i) => i >= 1 && bars[i - 1].c > 0,
      note: '필터 없음(유니버스 전체). 슬롯 10은 유니버스 순환으로 채운다.',
    },
    {
      key: 'close-up',
      label: '①-2 종가매수 · 전일 상승 종목만',
      family: 'close',
      scope: 'prevBars',
      entryPrice: 'close',
      exit: { kind: 'nextOpen' },
      pick: 'rotate',
      needsVolAvg: false,
      signal: (bars, i) => i >= 2 && bars[i - 1].c > bars[i - 2].c,
      note: '**전일** 종가가 전전일 종가보다 높은 종목만(당일 등락률을 쓰면 미래참조).',
    },
    {
      key: 'close-value',
      label: '①-3 종가매수 · 전일 거래대금 상위',
      family: 'close',
      scope: 'prevBars',
      entryPrice: 'close',
      exit: { kind: 'nextOpen' },
      pick: 'value',
      needsVolAvg: false,
      signal: (bars, i) => i >= 1 && prevTradingValue(bars, i) > 0,
      note: '**전일** 거래대금 상위 10종목(당일 거래대금은 장이 끝나야 확정된다).',
    },
    // ---- ② 상한가 따라잡기 --------------------------------------------------
    {
      key: 'limitup-close',
      label: '②-1 상한가 → 익일 종가 청산',
      family: 'limitup',
      scope: 'prevBars',
      entryPrice: 'open',
      exit: holdDays(1),
      pick: 'value',
      needsVolAvg: false,
      signal: (bars, i) => isLimitUpClose(bars, i - 1),
      note: '전일 상한가 마감 → 익일 시가 매수 → 익일 종가 청산.',
    },
    {
      key: 'limitup-ts',
      label: `②-2 상한가 → +${SHORT_TP_PCT}%/−${SHORT_SL_PCT}% (미도달 시 ${SHORT_TS_MAX_DAYS}일째 종가)`,
      family: 'limitup',
      scope: 'prevBars',
      entryPrice: 'open',
      exit: { kind: 'targetStop', targetPct: SHORT_TP_PCT, stopPct: SHORT_SL_PCT, maxDays: SHORT_TS_MAX_DAYS },
      pick: 'value',
      needsVolAvg: false,
      signal: (bars, i) => isLimitUpClose(bars, i - 1),
      note: '진입일 **시가 대비** 익절·손절. 갭 관통 손절은 시가, 익절은 기준가(보수). 둘 다 닿으면 손절.',
    },
    {
      key: 'limitup-h3',
      label: '②-3 상한가 → 3일 보유',
      family: 'limitup',
      scope: 'prevBars',
      entryPrice: 'open',
      exit: holdDays(3),
      pick: 'value',
      needsVolAvg: false,
      signal: (bars, i) => isLimitUpClose(bars, i - 1),
      note: '진입일 포함 3거래일째 종가 청산.',
    },
    {
      key: 'limitup-h5',
      label: '②-4 상한가 → 5일 보유',
      family: 'limitup',
      scope: 'prevBars',
      entryPrice: 'open',
      exit: holdDays(5),
      pick: 'value',
      needsVolAvg: false,
      signal: (bars, i) => isLimitUpClose(bars, i - 1),
      note: '진입일 포함 5거래일째 종가 청산.',
    },
    // ---- ③ 갭 매매 ----------------------------------------------------------
    {
      key: 'gap-up',
      label: `③-1 갭상승(+${SHORT_GAP_PCT}%↑) 추격 → 당일 종가 청산`,
      family: 'gap',
      scope: 'prevBarsPlusOpen',
      entryPrice: 'open',
      exit: holdDays(1),
      pick: 'value',
      needsVolAvg: false,
      signal: (bars, i, open) =>
        i >= 1 && open != null && bars[i - 1].c > 0 && open / bars[i - 1].c - 1 >= SHORT_GAP_PCT / 100,
      note: '판단에 진입봉 **시가 하나**만 쓴다(갭의 정의). 체결 현실성 경고 참조.',
    },
    {
      key: 'gap-down',
      label: `③-2 갭하락(−${SHORT_GAP_PCT}%↓) 매수 → 당일 종가 청산`,
      family: 'gap',
      scope: 'prevBarsPlusOpen',
      entryPrice: 'open',
      exit: holdDays(1),
      pick: 'value',
      needsVolAvg: false,
      signal: (bars, i, open) =>
        i >= 1 && open != null && bars[i - 1].c > 0 && open / bars[i - 1].c - 1 <= -SHORT_GAP_PCT / 100,
      note: '판단에 진입봉 **시가 하나**만 쓴다. 체결 현실성 경고 참조.',
    },
    {
      key: 'gap-down-2d',
      label: `③-3 갭하락(−${SHORT_GAP_PCT}%↓) 매수 → 익일 종가 청산`,
      family: 'gap',
      scope: 'prevBarsPlusOpen',
      entryPrice: 'open',
      exit: holdDays(2),
      pick: 'value',
      needsVolAvg: false,
      signal: (bars, i, open) =>
        i >= 1 && open != null && bars[i - 1].c > 0 && open / bars[i - 1].c - 1 <= -SHORT_GAP_PCT / 100,
      note: '③-2와 같은 진입, 청산만 하루 뒤로.',
    },
    // ---- ④ 장대양봉 다음날 --------------------------------------------------
    {
      key: 'big-close',
      label: `④-1 장대양봉(몸통+${SHORT_BODY_PCT}%·거래량${SHORT_VOL_MULT}배) → 익일 종가 청산`,
      family: 'bigcandle',
      scope: 'prevBars',
      entryPrice: 'open',
      exit: holdDays(1),
      pick: 'value',
      needsVolAvg: true,
      signal: (bars, i, _open, aux) => i >= 1 && isBigCandle(bars, i - 1, aux),
      note: `거래량 기준은 **당일 제외** 직전 ${SHORT_VOL_WINDOW}일 평균의 ${SHORT_VOL_MULT}배.`,
    },
    {
      key: 'big-h3',
      label: '④-2 장대양봉 → 3일 보유',
      family: 'bigcandle',
      scope: 'prevBars',
      entryPrice: 'open',
      exit: holdDays(3),
      pick: 'value',
      needsVolAvg: true,
      signal: (bars, i, _open, aux) => i >= 1 && isBigCandle(bars, i - 1, aux),
      note: '④-1과 같은 진입, 진입일 포함 3거래일째 종가 청산.',
    },
  ]
  // ---- ⑤ 연속 하락 반등 ----------------------------------------------------
  for (const k of SHORT_REBOUND_DAYS) {
    plans.push({
      key: `rebound-${k}`,
      label: `⑤-${k === 3 ? 1 : 2} ${k}일 연속 하락 → 익일 시가 매수 · 2일 보유`,
      family: 'rebound',
      scope: 'prevBars',
      entryPrice: 'open',
      exit: holdDays(2),
      pick: 'value',
      needsVolAvg: false,
      signal: (bars, i) => i >= 1 && isDownStreak(bars, i - 1, k),
      note: `직전 ${k}거래일 연속 종가 하락 마감 → 익일 시가 매수, 진입일 포함 2거래일째 종가 청산.`,
    })
  }
  return plans
}

/** 총 변형 수. 다중검정 경고의 분모이자 `tests/shortterm.test.ts`가 고정하는 값. */
export const SHORT_VARIANT_COUNT = 14

// ============================================================================
// 시뮬레이터 — 14변형이 **같은 한 경로**를 탄다
// ============================================================================
//
// 계열마다 시뮬을 따로 쓰면 어느 하나에서만 미래참조가 새는 사고가 난다(24차 교훈).
// 그래서 진입가·신호범위·청산규칙·선정규칙 네 축만 파라미터로 열고 본체는 하나다.
//
// 하루 처리 순서(이 순서가 곧 규칙 1의 집행이다):
//   1) 시가 청산  — 오버나이트 포지션을 **오늘 시가**에 판다.
//   2) 시가 진입  — 진입가가 시가인 계열이 산다(후보 판정은 위 계약대로).
//   3) 장중 익절·손절 — 진입일 봉의 저가·고가만 본다. 갭 관통은 불리한 쪽.
//   4) 종가 청산  — 보유일수가 찬 포지션을 **오늘 종가**에 판다.
//   5) 종가 진입  — 진입가가 종가인 계열이 산다(후보 판정은 전일까지의 봉만).
//   6) 종가 평가.

interface PosMeta {
  /** 청산 예정 캘린더 인덱스. `nextOpen`은 진입 다음 거래일, `holdDays N`은 진입+N−1. */
  dueIdx: number
  /** 청산 기준 시점 — 'open'이면 예정일 시가, 'close'면 예정일 종가. */
  at: 'open' | 'close'
  /** 진입 기준가(슬리피지 전). 익절·손절의 기준이자 거래손익 계산의 참조. */
  entryPx: number
}

export interface ShortYearRun extends CustomYearRun {
  /** 청산 완료 거래의 수익률(비용 후) 합·건수 — 평균 거래손익률용(배열은 안 남긴다: 메모리). */
  retSum: number
  retCount: number
  /** 종가 평가 시점의 (평가액 ÷ 총자산) 합과 평가 일수 — **오버나이트** 노출률용. */
  investedSum: number
  markDays: number
  /**
   * 하루 중 **한 번이라도** 포지션을 들고 있던 날 수 — 가동률용.
   * 종가 노출만 보면 당일 왕복 계열(③-1·④-1 등)이 항상 0%로 찍혀 "안 돌았다"로 오독된다.
   */
  activeDays: number
}

/**
 * 한 해치 단기매매 시뮬.
 *
 * 규칙 1 집행 지점:
 *   · 신호는 `plan.signal(bars, entryIdx, entryOpen, aux)`로만 부른다. `entryOpen`은
 *     `scope === 'prevBarsPlusOpen'`일 때만 값을 넘긴다 — 다른 계열은 진입봉의 어떤
 *     값도 손에 넣을 수 없다.
 *   · **마지막 캘린더 봉에서는 신규 진입을 만들지 않는다**(규칙 1-6). 당일 왕복
 *     계열도 같은 규약으로 묶는다 — 계열마다 규약이 다르면 비교가 깨진다.
 *   · 익절·손절은 진입일 봉의 저가·고가만 보며, 갭 관통 손절은 **시가**(불리한 쪽),
 *     익절은 **기준가**로 체결한다(유리한 쪽으로 앞당기지 않는다). 같은 봉에서 둘 다
 *     닿으면 **손절 먼저**로 본다.
 */
export function simulateShortTermYear(
  histories: Record<string, DailyBar[]>,
  startDate: string,
  symbols: string[],
  cost: CostSettings,
  plan: ShortPlan,
  slots = SHORT_SLOTS,
): ShortYearRun {
  const { universe, calendar, idxOf } = makeSimCtx(histories, symbols, startDate)
  const book = newBook(cost.initialCapital)
  const equity: { date: string; equity: number }[] = []
  const fills: FillEvent[] = []
  const meta = new Map<string, PosMeta>()
  const aux: Record<string, SymAux> = {}
  if (plan.needsVolAvg) for (const s of universe) aux[s] = { avgVol: avgVolSeries(histories[s]) }
  const EMPTY_AUX: SymAux = { avgVol: [] }
  let retSum = 0
  let retCount = 0
  let investedSum = 0
  let markDays = 0
  let activeDays = 0

  const barAt = (s: string, date: string): DailyBar | null => {
    const bi = idxOf[s]?.get(date)
    return bi == null ? null : histories[s][bi]
  }
  const closeAt = (date: string) => (s: string) => barAt(s, date)?.c ?? null

  /**
   * 전량 청산. 부분매도가 없으므로 취득원가 대비 순수령액으로 거래손익률이 정확히 나온다.
   * 매도는 진입 시 정해진 **예약 청산**(보유일수·손절선)이므로 `signalDate = date`로 둔다 —
   * 새로 판단해서 파는 것이 아니라 이미 걸어 둔 조건이 그날 발동한 것이다.
   */
  const sellFull = (date: string, sym: string, rawPx: number): void => {
    const p = book.positions.get(sym)
    if (!p || !(rawPx > 0)) return
    const basis = p.basis
    const q = bookSell(book, cost, sym, rawPx, p.qty)
    if (q <= 0) return
    fills.push({ date, sym, side: 'sell', px: rawPx, qty: q, signalDate: date })
    meta.delete(sym)
    const fill = rawPx * (1 - cost.slippagePct / 100)
    const gross = q * fill
    const net = gross - gross * ((cost.feePct + cost.taxPct) / 100)
    if (basis > 0) {
      retSum += (net - basis) / basis
      retCount++
    }
  }

  /** 현재 시점 총자산 — 보유 종목은 주어진 기준가(없으면 마지막 관측 종가)로 평가. */
  const equityAt = (priceOf: (s: string) => number | null): number => {
    let eq = book.cash
    for (const [s, p] of book.positions) {
      const px = priceOf(s)
      eq += p.qty * (px != null && px > 0 ? px : p.lastClose)
    }
    return eq
  }

  /** 후보 산출 + 슬롯 배분 매수. `at`은 진입 기준가 시점. */
  const enter = (d: number, at: 'open' | 'close'): void => {
    // 규칙 1-6: 마지막 봉에서는 신규 진입 없음(체결할 다음 봉이 없다).
    if (d >= calendar.length - 1) return
    const free = slots - book.positions.size
    if (free <= 0) return
    const date = calendar[d]
    // 신호일 = 판단에 쓴 마지막 정보의 날. 갭 계열만 진입봉 시가를 보므로 당일이고,
    // 나머지는 전 거래일이다 — 이 한 줄이 "신호 → 체결 분리"의 증거로 체결부에 남는다.
    const signalDate = plan.scope === 'prevBarsPlusOpen' ? date : d > 0 ? calendar[d - 1] : date
    const cands: { sym: string; px: number; tv: number }[] = []
    for (const s of universe) {
      if (book.positions.has(s)) continue // 중복 진입 없음(피라미딩 금지)
      const bi = idxOf[s].get(date)
      if (bi == null) continue
      const bars = histories[s]
      const px = at === 'open' ? bars[bi].o : bars[bi].c
      if (!(px > 0)) continue
      const entryOpen = plan.scope === 'prevBarsPlusOpen' ? bars[bi].o : null
      if (!plan.signal(bars, bi, entryOpen, aux[s] ?? EMPTY_AUX)) continue
      cands.push({ sym: s, px, tv: prevTradingValue(bars, bi) })
    }
    if (cands.length === 0) return
    let ordered: { sym: string; px: number }[]
    if (plan.pick === 'value') {
      ordered = [...cands].sort((a, b) => (b.tv !== a.tv ? b.tv - a.tv : a.sym < b.sym ? -1 : 1))
    } else {
      const byCode = [...cands].sort((a, b) => (a.sym < b.sym ? -1 : 1))
      const start = (d * slots) % byCode.length
      ordered = [...byCode.slice(start), ...byCode.slice(0, start)]
    }
    const take = ordered.slice(0, free)
    // 슬롯 금액은 **총자산 ÷ 슬롯 수**로 고정한다. 후보가 3개뿐인 날 자산을 3등분해
    // 몰아넣으면 회전율 극단 계열에서 사실상 레버리지가 되어 계열 간 비교가 깨진다.
    const slot = equityAt(at === 'open' ? (s) => barAt(s, date)?.o ?? null : closeAt(date)) / slots
    if (!(slot > 0)) return
    for (const t of take) {
      const budget = Math.min(slot, book.cash)
      if (!(budget > 0)) break
      const q = bookBuy(book, cost, t.sym, t.px, budget, d)
      if (q <= 0) continue
      fills.push({ date, sym: t.sym, side: 'buy', px: t.px, qty: q, signalDate })
      meta.set(t.sym, {
        dueIdx: plan.exit.kind === 'nextOpen' ? d + 1 : d + Math.max(1, planHoldDays(plan.exit)) - 1,
        at: plan.exit.kind === 'nextOpen' ? 'open' : 'close',
        entryPx: t.px,
      })
    }
  }

  for (let d = 0; d < calendar.length; d++) {
    const date = calendar[d]
    // 하루 중 한 번이라도 포지션이 있었나 — 전일 이월분부터 센다(당일 왕복도 가동으로 본다).
    let active = book.positions.size > 0

    // 1) 시가 청산 — 봉이 없으면 체결 불가라 다음 기회로 이월(기준일을 앞당기지 않는다).
    for (const [sym, m] of [...meta]) {
      if (m.at !== 'open' || d < m.dueIdx) continue
      const bar = barAt(sym, date)
      if (!bar) continue
      sellFull(date, sym, bar.o)
    }

    // 2) 시가 진입
    if (plan.entryPrice === 'open') enter(d, 'open')
    if (book.positions.size > 0) active = true

    // 3) 장중 익절·손절 (targetStop 계열)
    //    진입 시점에 이미 걸어 둔 조건부 주문이다 — 판단에 쓰는 값은 기준가(진입일 시가)와
    //    오늘 봉의 저가·시가·고가뿐이며, 오늘 종가나 이후 봉은 보지 않는다. 청산이 봉 결측으로
    //    미뤄진 포지션은 주문이 살아 있는 것으로 보고 다음 거래일에도 같은 기준선으로 검사한다.
    if (plan.exit.kind === 'targetStop') {
      const tp = 1 + plan.exit.targetPct / 100
      const sl = 1 - plan.exit.stopPct / 100
      for (const [sym, m] of [...meta]) {
        if (m.entryPx <= 0) continue
        const bar = barAt(sym, date)
        if (!bar) continue
        const stopPx = m.entryPx * sl
        const targetPx = m.entryPx * tp
        // 같은 봉에서 손절선과 익절선을 둘 다 건드렸으면 **손절 먼저**로 본다(보수).
        if (bar.l <= stopPx) {
          // 갭으로 관통했으면 기준가가 아니라 **시가**(더 불리한 쪽)로 체결한다.
          sellFull(date, sym, bar.o < stopPx ? bar.o : stopPx)
        } else if (bar.h >= targetPx) {
          // 익절은 시가가 더 높아도 **기준가**로만 체결한다(유리한 쪽으로 가정하지 않는다).
          sellFull(date, sym, targetPx)
        }
      }
    }

    // 4) 종가 청산
    for (const [sym, m] of [...meta]) {
      if (m.at !== 'close' || d < m.dueIdx) continue
      const bar = barAt(sym, date)
      if (!bar) continue
      sellFull(date, sym, bar.c)
    }

    // 5) 종가 진입
    if (plan.entryPrice === 'close') enter(d, 'close')
    if (book.positions.size > 0) active = true

    // 6) 종가 평가
    const eq = bookMark(book, closeAt(date))
    equity.push({ date, equity: eq })
    if (eq > 0) {
      investedSum += Math.max(0, eq - book.cash) / eq
      markDays++
      if (active) activeDays++
    }
  }

  return {
    equity,
    closed: book.closed,
    wins: book.wins,
    openAtEnd: book.positions.size,
    fills,
    retSum,
    retCount,
    investedSum,
    markDays,
    activeDays,
  }
}

/**
 * 예약 청산까지의 보유일(진입일 포함). `nextOpen`은 종가 예약이 없으므로 1로 본다
 * (실제 청산 시점은 `dueIdx`를 만드는 쪽에서 다음 거래일 시가로 따로 정한다).
 */
export function planHoldDays(exit: ExitRule): number {
  if (exit.kind === 'holdDays') return exit.days
  if (exit.kind === 'targetStop') return exit.maxDays
  return 1
}

// ============================================================================
// 연쇄 · 요약
// ============================================================================

export interface ShortStats {
  retSum: number
  retCount: number
  investedSum: number
  markDays: number
  activeDays: number
}

/** 평균 거래손익률(%) — 청산 완료 거래 기준. 거래가 없으면 null. */
export const avgTradeRetPct = (s: ShortStats): number | null => (s.retCount > 0 ? (s.retSum / s.retCount) * 100 : null)
/**
 * **오버나이트 노출률(%)** — 종가 평가 시점의 (주식 평가액 ÷ 총자산) 평균.
 * 당일 왕복 계열은 종가에 이미 판 뒤라 구조적으로 0%다. "안 돌았다"는 뜻이 아니다.
 */
export const avgExposurePct = (s: ShortStats): number | null =>
  s.markDays > 0 ? (s.investedSum / s.markDays) * 100 : null
/** **가동률(%)** — 하루 중 한 번이라도 포지션을 들고 있던 날의 비율. 기법이 얼마나 자주 발동하나. */
export const activeRatePct = (s: ShortStats): number | null =>
  s.markDays > 0 ? (s.activeDays / s.markDays) * 100 : null

/**
 * 연도별 유니버스 교체 연쇄. `runCustomChain`을 그대로 쓴다 — 이월·연말 청산 haircut
 * 규약이 34차와 같아야 표가 나란히 읽힌다.
 */
export function runShortChain(
  yearly: YearSlice[],
  plan: ShortPlan,
  cost: CostSettings,
  slots = SHORT_SLOTS,
): { chain: ChainStats; stats: ShortStats } {
  const stats: ShortStats = { retSum: 0, retCount: 0, investedSum: 0, markDays: 0, activeDays: 0 }
  const chain = runCustomChain(
    yearly,
    (v) => {
      const r = simulateShortTermYear(v.hist, `${v.y}-01-01`, v.syms, cost, plan, slots)
      stats.retSum += r.retSum
      stats.retCount += r.retCount
      stats.investedSum += r.investedSum
      stats.markDays += r.markDays
      stats.activeDays += r.activeDays
      return r
    },
    cost,
    slots,
  )
  return { chain, stats }
}

/** 한 변형의 결과 — 곡선은 여기서 이미 스칼라로 접혔다(OOM 교훈). */
export interface ShortVariant {
  plan: ShortPlan
  /** 실제 비용 성적 */
  row: StratRow
  stats: ShortStats
  /** 비용 0 가정 성적 — 이 계열은 비용이 성패를 지배하므로 반드시 나란히 놓는다. */
  freeRow: StratRow
  freeStats: ShortStats
}

/** 판정 탈락 사유(빈 배열 = 통과). 34차 `calFailReasons`와 같은 규약. */
export function shortFailReasons(row: StratRow, trades: number, minTrades = SHORT_MIN_TRADES): string[] {
  const bad: string[] = []
  if (!((row.alphaA ?? -1) > 0 && (row.alphaB ?? -1) > 0)) bad.push('알파')
  if (!(trades >= minTrades)) bad.push('매매')
  return bad
}
export const shortPass = (row: StratRow, trades: number, minTrades = SHORT_MIN_TRADES) =>
  shortFailReasons(row, trades, minTrades).length === 0

/** 칼마 내림차순. 산출 불가(null)는 뒤로, 동점은 키 오름차순 — 결정적 정렬. */
export function shortCalmarSort(vs: ShortVariant[]): ShortVariant[] {
  return [...vs].sort((a, b) => {
    const ca = calmarOf(a.row.full)
    const cb = calmarOf(b.row.full)
    if (ca == null && cb != null) return 1
    if (cb == null && ca != null) return -1
    if (ca != null && cb != null && ca !== cb) return cb - ca
    return a.plan.key < b.plan.key ? -1 : a.plan.key > b.plan.key ? 1 : 0
  })
}

const pctOrDash = (v: number | null) => (v == null ? '—' : `${f1(v)}%p`)
const numOrDash = (v: number | null, digits = 2) => (v == null ? '—' : v.toFixed(digits))

// ============================================================================
// ⚠️ 체결 현실성 경고 — 표를 찍는 함수가 **강제로 함께** 출력한다
// ============================================================================
//
// 이 블록을 표와 분리하지 마라. 이 계열의 백테스트 숫자는 경고 없이는 거짓이다.

/** 전 계열 공통 경고. 결과가 나오는 모든 표 앞뒤에 붙는다. */
export function fillRealismWarning(): void {
  log('')
  log('## ⚠️ 체결 현실성 경고 — 아래 숫자를 그대로 믿지 마라')
  log('')
  log('· **일봉의 시가·종가 체결 가정은 분봉 실체결과 다르다.** 이 러너는 "그 시각의 단일')
  log('  가격에 원하는 수량이 다 체결된다"고 가정한다. 단기매매는 바로 그 가정이 깨지는')
  log('  자리에서 돈을 잃는다. **진짜 검증은 분봉이 쌓여야 가능하다**(현재 60일 롤링 누적 중).')
  log('· **회전율이 높아 거래 비용·세금이 알파를 통째로 먹는 구조다.** 그래서 아래 표는')
  log('  비용 0 가정 성적을 나란히 찍는다 — 비용 0에서만 통과한 변형은 **통과가 아니라**')
  log('  "비용에 죽었다"는 증거다.')
  log('· **상한가 따라잡기**: 상한가에는 매수 잔량이 수십만 주 쌓인다. 익일 시가에 원하는')
  log('  수량을 사는 것은 **현실에서 성립하지 않는 낙관 가정**이다. 반대로 팔 때는 하한가에서')
  log('  못 파는 위험이 겹친다 — 못 사는 쪽과 못 파는 쪽이 **같이** 빠져 있다.')
  log('· **종가 매수**: 종가 단일가(15:20~15:30)는 수급이 몰려 슬리피지가 크고, 소형주는')
  log('  호가 공백이 커서 단일가 체결가 자체가 크게 튄다. 여기 슬리피지 0.1%는 그 현실을')
  log('  담기에 **작다**.')
  log('· **갭 매매**: 판단(시가)과 체결(시가)이 일봉에서 **같은 점**이 된다. 실제로는 시가를')
  log('  보고 주문을 내는 사이 가격이 이미 움직여 있다. 이 한 칸은 절단 불변성 테스트로')
  log('  **잡히지 않는** 낙관이며, 갭 계열 숫자는 그만큼 후하다.')
  log('· 가격은 **총수익 보정(adjclose 계수)** 값이라 배당락일의 등락률·갭이 실제 호가')
  log('  움직임과 다르다. 상한가·갭 판정에 그만큼의 오분류가 섞인다.')
}

/** 계열별 경고 — 계열 표마다 강제로 붙는다. */
export function familyWarning(fam: ShortFamily): void {
  log('')
  if (fam === 'close') {
    log('⚠️ **종가 매수 계열**: 종가 단일가 체결은 수급이 몰려 슬리피지가 크고, 소형주는 호가')
    log('   공백이 크다. 오버나이트 수익은 갭에 통째로 실려 있어 **한 번의 악재 갭이 수십 번의')
    log('   작은 이익을 지운다** — 평균이 아니라 꼬리를 봐야 하는 분포다.')
  } else if (fam === 'limitup') {
    log('⚠️ **상한가 따라잡기 계열**: 익일 시가 매수는 백테스트에서만 성립한다. 상한가 다음날')
    log('   시초가에는 매수 잔량이 쌓여 원하는 수량이 안 채워지고, 반대로 하한가로 굳으면')
    log('   **팔 수가 없다**. 여기 숫자는 "살 수 있었고 팔 수 있었다"를 둘 다 가정한 상한선이다.')
  } else if (fam === 'gap') {
    log('⚠️ **갭 매매 계열**: 판단과 체결이 같은 시가라는 낙관이 들어 있다(절단 불변성으로')
    log('   못 잡는 종류의 낙관이다). 실제로는 시가 확인 후 주문까지의 지연·슬리피지가 붙고,')
    log('   갭하락 매수는 악재 지속 시 하루 종일 흘러내리는 경로가 그대로 손실이 된다.')
  } else if (fam === 'bigcandle') {
    log('⚠️ **장대양봉 다음날 계열**: 거래량 급증일 다음날 시가는 이미 갭으로 벌어져 있는 경우가')
    log('   많아, 일봉 시가 체결 가정이 특히 후하다. 재료 소멸 시 시초가가 고점인 경로가 흔하다.')
  } else {
    log('⚠️ **연속 하락 반등 계열**: 하락이 이어지는 종목은 유동성이 같이 마르는 경우가 많아')
    log('   호가 스프레드가 벌어진다. "떨어졌으니 오른다"는 전제 자체가 추세 지속 구간에서는')
    log('   그대로 손실이며, 상장폐지 경로 종목은 이 유니버스에 애초에 없다(생존편향).')
  }
}

// ============================================================================
// 표
// ============================================================================

/** 참고 벽 대비 초과 여부. */
const overWall = (row: StratRow, wall: CalWall | null) => {
  const cal = calmarOf(row.full)
  return wall?.calmar != null && cal != null && cal > wall.calmar
}

/**
 * 전체 순위표(칼마 내림차순). **경고를 강제로 함께 출력한다** — 이 함수를 거치지 않고
 * 결과를 찍는 경로를 만들지 마라.
 */
export function shortRankTable(title: string, vs: ShortVariant[], wall: CalWall | null): ShortVariant[] {
  const sorted = shortCalmarSort(vs)
  fillRealismWarning()
  log('')
  log(`### ${title}`)
  log(
    `| 순위 | 변형 | 계열 | **칼마** | CAGR | MDD | 알파(전 구간) | 전반(~${KRXPIT_HALF - 1}) 알파 | ` +
      `후반(${KRXPIT_HALF}~) 알파 | 매매 | 승률 | 거래당 평균 | 가동률 | 오버나이트 노출 | 판정 |` +
      (wall ? ` ${wall.label} 벽 |` : ''),
  )
  log(`|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|${wall ? '---|' : ''}`)
  for (const [i, v] of sorted.entries()) {
    const cal = calmarOf(v.row.full)
    const bad = shortFailReasons(v.row, v.row.closed)
    const wr = v.row.closed > 0 ? `${((v.row.wins / v.row.closed) * 100).toFixed(0)}%` : '—'
    log(
      `| ${i + 1} | ${v.plan.label} | ${FAMILY_LABEL[v.plan.family].slice(0, 2)} | ${numOrDash(cal, 3)} | ` +
        `${f1(v.row.full.cagr)}% | ${f1(v.row.full.mdd)}% | ${pctOrDash(v.row.alphaFull)} | ` +
        `${pctOrDash(v.row.alphaA)} | ${pctOrDash(v.row.alphaB)} | ${v.row.closed} | ${wr} | ` +
        `${numOrDash(avgTradeRetPct(v.stats))}% | ${numOrDash(activeRatePct(v.stats), 0)}% | ` +
        `${numOrDash(avgExposurePct(v.stats), 0)}% | ` +
        `${bad.length === 0 ? '✅' : `❌(${bad.join('·')})`} |` +
        (wall ? ` ${overWall(v.row, wall) ? '✅ 넘음' : '❌'} |` : ''),
    )
  }
  log('')
  log('※ "거래당 평균"은 청산 완료 라운드트립의 **비용 후** 수익률 평균이다. 회전율 계열은')
  log('  CAGR이 낮아도 거래당 엣지가 있을 수 있고, 반대로 거래당 +0.1%가 비용에 지워지기도 한다.')
  log('※ "가동률"은 하루 중 한 번이라도 포지션을 들고 있던 날의 비율이다. 이벤트가 드문 계열은')
  log('  대부분 현금이라 CAGR이 구조적으로 낮게 나온다 — 기법의 실패가 아니라 **가동률**의 문제다.')
  log('※ "오버나이트 노출"은 **종가 시점**의 주식 비중 평균이다. 당일 왕복 계열(③-1·④-1 등)은')
  log('  종가에 이미 판 뒤라 구조적으로 0%다 — "안 돌았다"는 뜻이 아니다(가동률 열을 함께 보라).')
  return sorted
}

/** 비용 민감도 — 이 계열의 진짜 결론이 여기서 나온다. */
export function costSensitivityTable(vs: ShortVariant[]): ShortVariant[] {
  const sorted = shortCalmarSort(vs)
  log('')
  log('### 비용 민감도 — 비용 0 가정 vs 실제 비용')
  log(`실제 비용: 수수료 ${COST.feePct}% · 거래세 ${COST.taxPct}% · 슬리피지 ${COST.slippagePct}% (편도 기준)`)
  log('| 변형 | 칼마(비용0) | 칼마(실제) | CAGR(비용0) | CAGR(실제) | CAGR 차이 | 거래당 평균(비용0) | 거래당 평균(실제) | 비용에 죽었나 |')
  log('|---|---|---|---|---|---|---|---|---|')
  const killed: ShortVariant[] = []
  for (const v of sorted) {
    const freePass = shortPass(v.freeRow, v.freeRow.closed)
    const realPass = shortPass(v.row, v.row.closed)
    const dead = freePass && !realPass
    if (dead) killed.push(v)
    log(
      `| ${v.plan.label} | ${numOrDash(calmarOf(v.freeRow.full), 3)} | ${numOrDash(calmarOf(v.row.full), 3)} | ` +
        `${f1(v.freeRow.full.cagr)}% | ${f1(v.row.full.cagr)}% | ${f1(v.row.full.cagr - v.freeRow.full.cagr)}%p | ` +
        `${numOrDash(avgTradeRetPct(v.freeStats))}% | ${numOrDash(avgTradeRetPct(v.stats))}% | ` +
        `${dead ? '☠️ **비용 0에서만 통과**' : realPass ? '— (실제 비용에서도 통과)' : '— (양쪽 다 탈락)'} |`,
    )
  }
  log('')
  if (killed.length === 0) {
    log('**비용 0에서만 통과한 변형은 없다.** 즉 이번 표의 판정 결과는 비용 가정을 바꿔도')
    log('뒤집히지 않는다(통과가 0건이면 "비용을 지워도 통과가 없다"는 더 강한 결론이다).')
  } else {
    log(`☠️ **비용 0에서만 통과한 변형 ${killed.length}개**: ${killed.map((v) => v.plan.label).join(', ')}`)
    log('   이것은 통과가 아니다. 거래 비용·세금이 그 변형의 엣지를 통째로 먹는다는 **증거**이며,')
    log('   실전에서는 여기 가정한 0.1% 슬리피지보다 더 나쁘게 체결된다(위 체결 현실성 경고).')
  }
  return killed
}

/** 계열별 표 — 계열 경고를 강제로 붙인다. */
export function familyTables(vs: ShortVariant[], wall: CalWall | null): void {
  const fams: ShortFamily[] = ['close', 'limitup', 'gap', 'bigcandle', 'rebound']
  for (const fam of fams) {
    const rows = vs.filter((v) => v.plan.family === fam)
    if (rows.length === 0) continue
    log('')
    log(`## ${FAMILY_LABEL[fam]} — ${rows.length}변형`)
    log('| 변형 | 규칙 1 처리 · 체결 가정 | 칼마 | CAGR | MDD | 매매 | 승률 | 거래당 평균 | 판정 | 벽 |')
    log('|---|---|---|---|---|---|---|---|---|---|')
    for (const v of shortCalmarSort(rows)) {
      const bad = shortFailReasons(v.row, v.row.closed)
      const wr = v.row.closed > 0 ? `${((v.row.wins / v.row.closed) * 100).toFixed(0)}%` : '—'
      log(
        `| ${v.plan.label} | ${v.plan.note} | ${numOrDash(calmarOf(v.row.full), 3)} | ${f1(v.row.full.cagr)}% | ` +
          `${f1(v.row.full.mdd)}% | ${v.row.closed} | ${wr} | ${numOrDash(avgTradeRetPct(v.stats))}% | ` +
          `${bad.length === 0 ? '✅' : `❌(${bad.join('·')})`} | ${overWall(v.row, wall) ? '✅' : '❌'} |`,
      )
    }
    familyWarning(fam)
    if (fam === 'limitup') limitUpRegimeNote()
  }
}

/** 상한가 제도 경계 — 코드와 출력 양쪽에 남긴다(지시서 요구). */
export function limitUpRegimeNote(): void {
  log('')
  log('#### 상한가 제도 경계 처리')
  log(`· 가격제한폭은 **${LIMITUP_REGIME_DATE}부터 ±30%**로 확대됐다(그 전 ±15%).`)
  log(`· 판정 임계: 그 날짜 **이전 ${LIMITUP_TH_OLD}% 이상**, **이후 ${LIMITUP_TH_NEW}% 이상**`)
  log('  (호가단위 절사 때문에 정확히 15.00%·30.00%가 안 나온다) **+ 당일 고가 = 종가**(상한가 굳힘).')
  log('· 한 임계로 전 구간을 판정하면 2010~2015 상한가가 통째로 사라지거나(29.5%), 2015 이후의')
  log('  단순 급등이 상한가로 잡힌다(14.5%). 그러면 이 실험 자체가 무의미해진다.')
  log('· ⚠️ 가격이 **총수익 보정** 값이라 배당락일에는 전일 대비 상승률이 실제 호가 등락률과')
  log('  달라진다 — 그만큼의 오분류가 상한가 판정에 섞인다(임계가 높아 빈도는 낮다).')
}

// ============================================================================
// 헤드라인 · 다중검정
// ============================================================================

export interface ShortHeadline {
  total: number
  passed: number
  over: number
  costKilled: number
}

export function shortHeadlineTable(h: ShortHeadline, wall: CalWall | null): void {
  log('')
  log('# 헤드라인')
  log('')
  log('| 항목 | 값 |')
  log('|---|---|')
  log(`| 검증한 변형 | ${h.total} |`)
  log(`| **판정 통과** (전·후반 알파 양수 + 매매수 ≥ ${SHORT_MIN_TRADES}) | **${h.passed} / ${h.total}** |`)
  log(`| **${wall?.label ?? 'QQQ 원화 보유'} 벽 초과** (칼마 기준 · 판정 통과분만) | **${h.over}** |`)
  log(`| ☠️ 비용 0에서만 통과 (통과 아님) | ${h.costKilled} |`)
  log('')
  if (h.passed === 0) {
    log('## ❌ **판정을 통과한 단기 기법이 하나도 없다.**')
    log('')
    log('이것은 실패한 실험이 아니라 **결과**다. 국내에서 이름이 붙어 도는 단기 기법 14변형을')
    log('KRX 실측 유니버스·실제 비용 위에 올렸을 때, 전·후반 두 구간 모두에서 KODEX 200을')
    log('앞선 것은 없었다. 위 체결 현실성 경고를 감안하면 실전 성적은 이 표보다 **더 나쁘다.**')
  } else if (h.over === 0) {
    log(`## 판정은 ${h.passed}개가 통과했지만, **${wall?.label ?? 'QQQ 원화 보유'} 벽을 넘은 것은 없다.**`)
    log('')
    log('"벤치보다 낫다"와 "그냥 나스닥100을 원화로 들고 있는 것보다 낫다"는 다른 질문이며,')
    log('두 번째 질문에서는 진 것이다. 게다가 이 계열은 위 경고대로 실전 체결이 백테스트보다')
    log('나쁘므로, 벽과의 격차는 표에 적힌 것보다 크다.')
  } else {
    log(`## ${wall?.label ?? 'QQQ 원화 보유'} 벽을 넘으면서 판정도 통과한 변형: **${h.over}개**`)
    log('')
    log('⚠️ 넘었다고 채택이 아니다. 이 계열은 **체결 현실성 가정이 성적을 만든다** — 상한가')
    log('   익일 시가 매수, 종가 단일가 체결, 갭 판단·체결 동일점 가정이 전부 낙관 쪽이다.')
    log('   분봉 실체결 대조 전에는 후보로도 올리지 않는다.')
  }
}

/**
 * 누적 다중검정 — **같은 KRX 실측 데이터**에 돌린 변형 수의 하한.
 * 회차별 정확한 수는 각 회차 보고서에 흩어져 있어 여기 숫자는 **하한**으로 읽는다.
 */
export const PRIOR_KRX_REAL_ROUNDS: { round: string; n: number; what: string }[] = [
  { round: '33차 krxpit', n: 10, what: '승자 3종 × 유니버스 3팔 + 분위 보정 행 [표 행 기준 추정]' },
  { round: '34차 krxcal', n: 35, what: '조건식 격자 24 + xsmom 5 + 구조 오버레이 6' },
  { round: '35차 krxscreen', n: 20, what: '비모멘텀 6계열 (10+10 12 · 40+40 8)' },
]
export const PRIOR_KRX_REAL_TOTAL = PRIOR_KRX_REAL_ROUNDS.reduce((s, r) => s + r.n, 0)

export function shortMultipleTestingNote(n: number, passed: number, over: number): void {
  const cumulative = PRIOR_KRX_REAL_TOTAL + n
  log('')
  log('## 다중검정 경고 (이 표를 유의성 근거로 쓰지 마라)')
  log(`이번 회차는 같은 데이터에 변형 **${n}개**를 돌렸고, 그중 ${passed}개가 판정을, ${over}개가 벽까지 넘었다.`)
  log(
    `순수 우연이라도 한 변형이 두 구간 모두 알파 양수일 확률을 ≈25%로 보면, ${n}개 중 ${passed}개 이상이 ` +
      `그럴 확률은 약 ${(binomTail(n, passed, 0.25) * 100).toFixed(0)}%다.`,
  )
  log('')
  log('**누적 탐색 횟수** — 이 값이 진짜 분모다(회차마다 새 데이터를 쓰는 게 아니다):')
  log('| 회차 | 변형 수 | 내용 |')
  log('|---|---|---|')
  for (const r of PRIOR_KRX_REAL_ROUNDS) log(`| ${r.round} | ${r.n} | ${r.what} |`)
  log(`| **36차 shortterm (이번)** | **${n}** | 단기매매 기법 5계열 |`)
  log(`| **누적(하한)** | **${cumulative}** | 같은 KRX 실측 ${KRXPIT_FROM}~${KRXPIT_TO} 데이터 |`)
  log('')
  log(`⚠️ 누적 ${cumulative}개 중 우연히 두 구간 모두 알파 양수인 변형이 ${Math.max(1, passed)}개 이상 나올 확률은`)
  log(`   약 ${(binomTail(cumulative, Math.max(1, passed), 0.25) * 100).toFixed(0)}%다 — 사실상 확실하다는 뜻이다.`)
  log('   그러므로 "통과 몇 개"는 발견이 아니라 **탐색량의 부산물**로 먼저 의심해야 한다.')
  log('⚠️ 위 누적치는 **하한**이다. 33차 이전 회차는 [추정] 유니버스에서 돌아 데이터가 달라')
  log('   여기 더하지 않았지만, 전략 형태를 고르는 사전지식은 그 회차들에서 넘어왔다.')
}

// ============================================================================
// 실행
// ============================================================================

function preamble(planCount: number, modeKey: string): void {
  log(`# MODE=short:${modeKey} — 국내 단기매매 기법 KRX 실측 검증 (36차)`)
  log('')
  log('대표 지시(2026-08-03): "종가매수, 상한가 따라잡기 등 유명한 단기 거래 기술들도 다 체크해봐."')
  log('')
  log(`이번 실행 변형 ${planCount}개 (전체 정의는 **${SHORT_VARIANT_COUNT}변형 고정** — 임의 확장 금지).`)
  log('유니버스·비용·벤치·판정 프레임은 34차(MODE=krxcal)와 같고, **바뀌는 것은 진입 신호와**')
  log('**청산 규칙뿐**이다. 그래야 "단기 기법이 특별히 좋은가"가 34차 표와 나란히 읽힌다.')
  log('')
  log('## 🚫 규칙 1(미래참조 금지) 처리 — 이 실험의 최대 위험')
  log('')
  log('· **종가 매수**: "당일 종가에 산다"는 **체결 시점**이지 판단 시점이 아니다. 후보는')
  log('  **전일까지 확정된 봉만으로** 고르고 체결만 당일 종가에 한다. 당일 등락률·당일')
  log('  거래대금으로 당일 종가 매수 대상을 고르는 형태는 **구현하지 않았다**(그 자체가 미래참조).')
  log('  → ①-2 "전일 대비 상승", ①-3 "거래대금 상위" 모두 **전일** 기준이다.')
  log('· **상한가·장대양봉·연속하락**: 그날 종가가 확정된 뒤 판정되므로 체결은 **익일 시가**다.')
  log('· **갭 매매만** 진입봉의 **시가 하나**를 판단에 쓴다(갭의 정의상 불가피). 시간 순서를')
  log('  거스르진 않지만 일봉에서는 판단가와 체결가가 같은 점이 된다 — **미래참조가 아니라**')
  log('  **체결 현실성 문제**이며 절단 불변성 테스트로 잡히지 않는다. 아래 경고에 명시했다.')
  log('· 20일 평균거래량은 **당일을 제외한** 직전 20일이다(규칙 1-3).')
  log('· 손절은 갭 관통 시 **시가**(불리한 쪽), 익절은 **기준가**로만 체결한다. 같은 봉에서')
  log('  둘 다 닿으면 **손절 먼저**로 본다(규칙 1-4).')
  log('· 데이터 **마지막 봉에서는 신규 진입을 만들지 않는다**(규칙 1-6). 당일 왕복 계열도 동일.')
  log('· 집행자는 `tests/shortterm.test.ts` — 계열마다 **절단 불변성**과 **신호 미래맹목성**')
  log('  (진입봉 이후를 극단값으로 바꿔도 신호 불변) 케이스를 걸어 두었다.')
  log('')
  log('## 포지션 규약')
  log(`· 보유 종목수 상한 **${SHORT_SLOTS}슬롯**, 슬롯 금액 = 총자산 ÷ ${SHORT_SLOTS}. 후보가 없으면 현금.`)
  log('· "균등분할"은 **슬롯 균등**으로 구현했다. 후보가 3개뿐인 날 자산을 3등분해 몰아넣으면')
  log('  회전율 극단 계열에서 사실상 레버리지가 되어 계열 간 비교가 깨진다.')
  log('· 후보가 슬롯보다 많으면 **전일 거래대금 내림차순**으로 자른다. 단 "전 종목 균등"(①-1·①-2)은')
  log('  유니버스를 고르게 도는 **순환 배분**을 쓴다 — 고정 부분집합을 쓰면 유니버스의 1/8만')
  log('  영구히 대표하게 된다. 순환 위치는 거래일 인덱스만으로 정해져 미래참조가 아니다.')
  log('· 같은 종목 중복 진입(피라미딩) 없음. 봉이 없는 날은 체결 불가로 보고 **다음 기회로 이월**한다.')
}

async function run(modeKey: string, families: ShortFamily[] | null): Promise<void> {
  const all = shortPlans()
  if (all.length !== SHORT_VARIANT_COUNT) {
    throw new Error(`변형 수가 ${all.length}개다 — ${SHORT_VARIANT_COUNT} 고정이어야 한다(다중검정 분모).`)
  }
  const plans = families ? all.filter((p) => families.includes(p.family)) : all
  if (plans.length === 0) throw new Error(`MODE=${modeKey}에 해당하는 변형이 없다.`)

  preamble(plans.length, modeKey)

  // ---- 유니버스 ---------------------------------------------------------------
  const uni = loadKrxPitFile()
  log('')
  log(`⚠️ ${krxPitSourceNote(uni)}`)
  const covered = krxPitYears(uni).filter((y) => y >= KRXPIT_FROM && y <= KRXPIT_TO)
  if (covered.length < 5) {
    throw new Error(
      `실측 랭킹이 ${KRXPIT_FROM}~${KRXPIT_TO} 중 ${covered.length}년뿐이다 — EC2 MODE=pityear를 다시 실행하라.`,
    )
  }
  const years = krxPitSpan(uni, covered[0], covered[covered.length - 1])
  log(
    `구간 ${years[0]}~${years[years.length - 1]} (${years.length}년) · 전·후반 분할 ${KRXPIT_HALF} · ` +
      `벤치 ${BENCH}(KODEX 200) · 비용 수수료 ${COST.feePct}% · 거래세 ${COST.taxPct}% · 슬리피지 ${COST.slippagePct}%`,
  )
  log('유니버스는 **KRX 실측 40+40**(연도별 교체) 하나만 쓴다 — 단기 기법은 후보가 넓어야 하고,')
  log('유니버스를 둘로 늘리면 변형 수가 28이 되어 다중검정이 그만큼 나빠진다.')

  const codes = [...new Set<string>(krxPitUnion(uni, 40, years))].sort()
  log('')
  log(`시세 로드 대상 ${codes.length}종목 (실측 40+40 합집합)`)
  const { histories, failed, bench } = await loadCodeHistories(codes)
  const names = krxPitNames(uni)
  log(`시세 로드 ${Object.keys(histories).length}/${codes.length} · 실패(상폐·데이터 부족) ${failed.length}`)
  if (failed.length) {
    const shown = failed.slice(0, 30).map((cd) => `${cd}(${names[cd] ?? '?'})`)
    log(`매핑 실패: ${shown.join(', ')}${failed.length > 30 ? ` … 외 ${failed.length - 30}개` : ''}`)
    log('  ↑ 랭킹은 실측이라 선택편향이 없지만, 상폐 종목의 **가격**이 없어 유니버스에서 빠진다.')
    log('    이것이 잔존 **가격 생존편향**이며 아래 성적을 그만큼 후하게 만든다.')
  }
  const benchEq = benchCurve(bench)
  log(`벤치 ${BENCH} 데이터 시작 ${bench[0]?.date ?? '—'} — 알파는 이 날짜 이후 겹치는 구간에서만 계산한다.`)

  const yearly = buildYearly(histories, years, (y) => krxPitCodes(uni, y, 40))
  log(`연도별 매핑률: ${yearly.map((v) => `${v.y} ${v.mapped}`).join(' · ')}`)
  if (yearly.every((v) => v.syms.length < 5)) throw new Error('시세 로드 실패로 실행할 해가 없다.')

  const qqq = await loadQqqKrwCurve()

  // ---- 실행 -------------------------------------------------------------------
  const variants: ShortVariant[] = []
  let span: [string, string] | null = null
  for (const plan of plans) {
    const real = runShortChain(yearly, plan, COST)
    const free = runShortChain(yearly, plan, COST_FREE)
    if (!span && real.chain.equity.length >= 2) span = spanOf(real.chain.equity)
    variants.push({
      plan,
      row: summarizeStrat(plan.label, real.chain, benchEq, KRXPIT_HALF),
      stats: real.stats,
      freeRow: summarizeStrat(`${plan.label} [비용0]`, free.chain, benchEq, KRXPIT_HALF),
      freeStats: free.stats,
    })
    // 곡선은 여기서 수명이 끝난다 — 밖으로 나가는 것은 스칼라뿐이다(OOM 교훈).
  }

  // ---- 벽 (같은 구간으로 다시 잰다) --------------------------------------------
  const [FROM, TO] = span ?? [`${years[0]}-01-01`, `${years[years.length - 1]}-12-31`]
  const walls: CalWall[] = []
  const qw = qqq ? wallOf('QQQ 원화 보유', qqq.curve, FROM, TO) : null
  if (qw) walls.push(qw)
  const kw = wallOf(`${BENCH} KODEX 200 보유`, benchEq, FROM, TO)
  if (kw) walls.push(kw)
  log('')
  log(`전략 실행 구간 **${FROM} ~ ${TO}** — 벽도 이 구간으로 잘라 다시 쟀다(옮겨 적은 값이 아니다).`)
  if (qqq) log(`QQQ 환산 규약: ${qqq.note}`)
  wallTable(walls)

  // ---- 표 ---------------------------------------------------------------------
  const sorted = shortRankTable(`전체 순위 (칼마 내림차순 · ${variants.length}변형 · 실제 비용)`, variants, qw)
  const killed = costSensitivityTable(variants)
  familyTables(variants, qw)

  const passed = sorted.filter((v) => shortPass(v.row, v.row.closed))
  const over = passed.filter((v) => overWall(v.row, qw))
  log('')
  log(`### 판정 통과 변형 (전·후반 알파 양수 + 매매수 ≥ ${SHORT_MIN_TRADES})`)
  if (passed.length === 0) {
    log('**없음.** 어떤 변형도 전·후반 알파를 모두 양수로 만들지 못했거나 표본이 소실됐다.')
  } else {
    log('| 변형 | 칼마 | CAGR | MDD | 전반 알파 | 후반 알파 | 벽 |')
    log('|---|---|---|---|---|---|---|')
    for (const v of passed)
      log(
        `| ${v.plan.label} | ${numOrDash(calmarOf(v.row.full), 3)} | ${f1(v.row.full.cagr)}% | ` +
          `${f1(v.row.full.mdd)}% | ${pctOrDash(v.row.alphaA)} | ${pctOrDash(v.row.alphaB)} | ` +
          `${overWall(v.row, qw) ? '✅ 넘음' : '❌'} |`,
      )
  }

  const top3 = sorted.slice(0, 3)
  if (top3.length) perYearTable(top3.map((v) => v.row), `연도별 수익 분해 — 칼마 상위 ${top3.length} (거짓 매끈함 방지)`)
  log('※ 한 해가 나머지를 전부 만들었다면 그 칼마는 구조가 아니라 그 해의 사건이다.')

  shortHeadlineTable(
    { total: variants.length, passed: passed.length, over: over.length, costKilled: killed.length },
    qw,
  )
  shortMultipleTestingNote(variants.length, passed.length, over.length)

  // ---- 한계 -------------------------------------------------------------------
  log('')
  log('## 이 실험의 구조적 한계')
  log(`· **일봉으로 단기매매를 재는 것 자체가 근사다.** 진입·청산이 하루 안에서 끝나는 계열은`)
  log('  분봉 실체결과 차이가 가장 크다. 이 표는 "분봉으로 다시 재기 전의 1차 스크리닝"이다.')
  log(`· **랭킹은 실측이지만 가격은 생존 종목만이다.** 이번 실행 매핑 실패 ${failed.length}종목 —`)
  log('  그 시절 상위였다가 상장폐지된 종목은 시세가 없어 빠진다. 단기 기법은 특히 **급등락**')
  log('  종목에 붙는데, 그 종목들이 나중에 사라진 쪽에 몰려 있어 편향이 더 크다.')
  log(`· **${KRXPIT_FROM}년 이전이 없다.** KRX Open API 데이터가 2010년부터라 2008 금융위기 전반부가`)
  log('  표에 없다. 여기 MDD는 "겪지 않은 위기"만큼 작다.')
  log('· **상한가 판정은 근사다.** 총수익 보정 가격이라 배당락일 등락률이 실제와 다르고,')
  log('  거래정지·단일가 매매 구간은 일봉만으로 구분되지 않는다.')
  log('· **거래대금은 근사다** — 총수익 보정 종가 × 거래량이라 실제 거래대금과 수준이 다르다')
  log('  (정렬 용도라 순위는 대체로 보존되지만, 같은 값이 아니다).')
  log('· 연 단위 유니버스 교체라 매년 1월 초 재편입 + 12월 말 정산 근사가 들어간다.')
  log('· **QQQ 벽은 참고이지 벤치가 아니다.** 알파 판정 벤치는 규칙 5대로 KODEX 200이며,')
  log('  QQQ 원화 곡선에는 환헤지 없음·해외 세제 미반영 가정이 들어 있다.')

  fillRealismWarning()

  log('')
  log('⚠️ [미검증-실데이터] 이 러너는 컨테이너에서 Yahoo가 403이라 합성 데이터 테스트로만 검증됐다.')
  log('   위 수치는 GitHub Actions(backtest.yml `short:all`) 실행 결과로 채워야 한다.')
  log('')
  log('---')
  log('⚠️ 이 수치는 시뮬레이션이며 **투자자문이 아니다.** 손실 경로는 MDD 열이 그 전략이 견뎌야 했던')
  log('   최대 하락이고, 무효화 지점은 "전·후반 중 한쪽이라도 벤치 대비 알파가 음수"다.')
  log('   단기매매는 여기에 더해 **체결·유동성·세제 가정이 성적을 만든다** — 위 경고를 같이 읽지')
  log('   않은 숫자는 근거가 되지 못한다. 과거 성적이 미래를 보장하지 않는다.')
}

const MODES: Record<string, () => Promise<void>> = {
  all: () => run('all', null),
  close: () => run('close', ['close']),
  limitup: () => run('limitup', ['limitup']),
  gap: () => run('gap', ['gap']),
  bigcandle: () => run('bigcandle', ['bigcandle']),
  rebound: () => run('rebound', ['rebound']),
}

// 런처(scripts/shortterm-lab.mjs)만 SHORT_LAB_RUN=1을 넘긴다. 테스트가 이 모듈을
// import할 때는 자동 실행되지 않는다.
if (process.env.SHORT_LAB_RUN === '1') {
  const mode = process.env.MODE ?? 'all'
  const entry = MODES[mode]
  if (!entry) {
    console.error(`알 수 없는 MODE=${mode} — 가능: ${Object.keys(MODES).join(', ')}`)
    process.exit(1)
  }
  entry().catch((e) => {
    console.error('실행 실패:', e)
    process.exit(1)
  })
}
