// 주도주 랩(leader-lab) — 국장 "당일 주도주" 추종을 일봉으로 정직하게 측정 (12변형 고정)
//
//   총괄 확정 설계(2026-08-16): "주도주(거래대금·등락률 상위 급등 종목)를 포착해
//   따라붙으면 먹을 게 있는가"를 잰다. 유니버스·비용·벤치·판정은 기존 랩 규약을 따른다.
//
// ── 무엇을 재는가 ────────────────────────────────────────────────────────────
//   "주도주 따라붙기"라는 흔한 서술을 **일봉으로 인과적으로 잴 수 있는 형태**로만 옮긴다.
//   유니버스는 `public/data/krx-daily/monthly-universe.json`(매월 첫 거래일 시총 상위
//   40+40, 2010-01~2026-07) ∩ KRX 일별 정본 375종목이고, 시세는 KRX 커밋 정본만 쓴다
//   (야후는 벤치 KODEX 200 한 종목뿐 — 실패 시 알파를 [벤치 미로딩]으로 표기하고 계속 돈다).
//
//   총 **12변형 고정**(`LEADER_VARIANT_COUNT` — 다중검정 분모. 테스트가 정합을 강제한다):
//     · 트랙 A(익일 추종 4): D−1 종가까지의 정보로 주도주 선정 → **D 시가 매수**
//         A1 전일 거래대금 서지(÷직전 20일 평균, 당일 제외) ≥ 3배 & 전일 등락률 ≥ +5% → 당일 종가 청산
//         A2 A1 선정 · 3거래일 보유(−3% 손절 선행) · 종가 청산
//         A3 A1 + 전일 종가가 직전 20일 최고 **종가**(당일 제외) 돌파 → 당일 종가 청산
//         A4 A3의 5거래일 보유(−5% 손절)
//     · 트랙 B(당일 시가 인과 선정 4): D 시가에 알 수 있는 정보(갭 = D시가/D−1종가,
//       그리고 D−1까지의 모든 것)만으로 D 시가 선정·매수 → **D 종가 청산**
//         B1 시가 갭 ≥ +3% & 전일 거래대금 상위(슬롯 정렬로 구현)
//         B2 B1 + 장중 손절(저가 ≤ 시가×0.97 → 손절가 체결 · 갭 관통 보수성 규칙)
//         B3 변동성 돌파 k=0.5 — 트리거 = 시가 + k×전일(고가−저가) · 당일 고가 ≥ 트리거일
//            때만 체결가 = max(시가, 트리거)(불리한 쪽) · 종가 청산
//         B4 B3의 k=0.3
//     · 트랙 C(주도주 관성 4):
//         C1 5일 누적 거래대금 서지 ≥ 2배 + 20일 신고가 근접(90%↑, 당일 제외 극값) → 익일 시가 · 5일 보유
//         C2 C1의 10일 보유
//         C3 C1 + 트레일링 스톱 5%(고점은 보유 중 **종가** 기준 · 터치 판정은 저가 · 갭 관통 시 시가)
//         C4 전일 상한가 마감(isLimitUpClose) → 익일 시가 · 당일 종가 청산
//            ↔ shortterm-lab ②-1 `limitup-close`와 **정의가 같다**(상호 참조). 차이는
//            유니버스(월별 시총 80 vs 연별 실측 40+40)와 **시가 상한가 스킵**(여기만 있다)뿐.
//
// ── 🚫 규칙 1(미래참조 금지) 처리 ────────────────────────────────────────────
//   · **"당일 종가·당일 거래대금 기준 당일 선정 → 당일 매수"는 재지 않는다.** 그 계산 자체가
//     미래참조다 — scripts/shortterm-lab.entry.ts 헤더 24~27줄과 같은 결론이다("당일 등락률·
//     당일 거래대금으로 당일 종가 매수 대상을 고르는 것은 그 자체가 미래참조라 구현하지 않았다").
//   · 트랙 A·C 신호는 `bars[0..i−1]`만 읽는다(진입봉의 어떤 값도 못 본다). 트랙 B만 진입봉의
//     **시가 하나**를 추가로 본다(갭은 시가로만 정의된다 — 09:00 확정 후 체결이라 시간 순서는
//     지키지만 일봉에서는 판단가=체결가가 되는 체결 현실성 낙관이 있다. 경고 블록 참조).
//     B3·B4의 트리거 터치 판정(당일 고가 ≥ 트리거)은 신호가 아니라 **진입 시점에 이미 걸어 둔
//     조건부 주문(스탑 매수)의 체결 여부**다 — 당일 종가·저가·거래량은 어디에도 쓰지 않는다.
//   · 롤링 극값·평균은 전부 **당일 제외**다(20일 평균 거래대금, 20일 최고 종가/고가).
//   · **유니버스 측정일 당일 미사용**: monthly-universe의 시총은 그 달 첫 거래일 **종가**로 잰
//     값이다. 그 날 시가 진입에 그 달 목록을 쓰면 미래참조라, 유니버스는 측정일 **다음 날부터**
//     적용한다(`universeAt`이 measureDate < date 엄격 부등호로 강제 — 월초 첫 거래일은 전월 목록).
//   · 손절·트레일 체결 보수성: 갭으로 관통하면 기준가가 아니라 **시가**(불리한 쪽) 체결.
//     손절과 예약 종가 청산이 같은 날이면 **손절 먼저**. 트레일 고점은 **전일까지의 종가**로만
//     판정한다(진입 당일은 고점이 아직 없어 판정하지 않는다 — 당일 종가로 당일 저가를 판정하면
//     봉 내부 미래참조다).
//   · **마지막 봉 신규 진입 금지**(규칙 1-6). 신호→체결 분리(트랙 A·C는 익일 시가).
//   · 집행자: `tests/leaderlab.test.ts` — 절단 불변성(트랙 A·B·C 각각) + 신호 미래맹목성 +
//     체결 보수성 + 시가 상한가 스킵 + 슬롯 결정성.
//
// ── 잴 수 없는 것과 이유 ─────────────────────────────────────────────────────
//   · **진짜 장중(분봉) 진입 — 미측정.** 분봉 데이터가 절단 상태다(public/data/intraday의
//     coverage.usableFrom = null, 60일 롤링 수집 누적 중). **분봉 확보 후 별도 트랙**으로 잰다.
//     "9시 반까지 거래대금 상위를 보고 산다" 류의 실제 주도주 매매는 이 랩의 범위 밖이다.
//   · **당일 종가 기준 당일 선정 — 정의상 미래참조라 측정 불가**(위 규칙 1 절).
//   · **수급(외인·기관) 쌍끌이 조건 — 데이터 부재로 미측정.**
//
// ── 한계 (결과 해석 시 반드시 병기) ──────────────────────────────────────────
//   · **유니버스가 시총 상위 80이라 진짜 소형 급등 주도주는 원천 배제된다.** 이 결과를
//     "주도주 전략 일반"으로 확대해석하지 마라 — 여기서 재는 것은 "대형·중형주 안에서의
//     주도주 추종"뿐이다.
//   · 거래대금은 수정종가 × **원거래량** 근사다(분할 경계 왜곡 — volumeHandlingNote 참조).
//   · 일봉 시가·종가 단일가 체결 가정, 슬리피지 0.1%는 급등주 현실 대비 작다(경고 블록).
//
// ── 실행 ─────────────────────────────────────────────────────────────────────
//   MODE=all node scripts/leader-lab.mjs            # 12변형 전부 (GHA: leader:all)
//   MODE=next|gap|vbrk|persist                      # 같은 12변형의 부분집합(새 변형 아님)
//   컨테이너·로컬에서 KRX 정본은 커밋돼 있어 돌지만, 벤치(야후 KODEX 200)가 막히면
//   알파 없이 돌고 [벤치 미로딩]을 찍는다 — 알파가 필요한 실행은 GHA(backtest.yml)에서.

import type { CostSettings } from '../src/features/backtest/conditionScreen'
import type { DailyBar } from '../src/features/backtest/types'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  BENCH,
  COST,
  COST_FREE,
  KRX_DAILY_START_HINT,
  chgPct,
  compareBasisFor,
  compareBasisNote,
  fetchCompare,
  isLimitUpClose,
  limitUpThresholdPct,
  loadShortHistories,
  prevTradingValue,
  priceSourceHeadline,
  setCompareBasis,
  splitCountFromLimits,
  volumeHandlingNote,
} from './shortterm-lab.entry'
import {
  KRXPIT_HALF,
  MAX_POSITIONS,
  SCREEN_MIN_TRADES,
  benchCurve,
  bookBuy,
  bookMark,
  bookSell,
  calmarOf,
  f1,
  log,
  makeSimCtx,
  newBook,
  type ChainStats,
  type FillEvent,
  type StratRow,
  summarizeStrat,
} from './idea-lab.entry'
import { MIXED_SOURCE_NOTE } from '../src/features/backtest/priceSource'
import { parseKrxMonthlyUniverse, type KrxMonthlyUniverse } from '../src/features/backtest/krxDailyPrices'

// ============================================================================
// 상수 — 12변형 고정. 임의 확장 금지(다중검정 분모가 곧 이 숫자다).
// ============================================================================

/** 변형 개수 고정 — `tests/leaderlab.test.ts`가 `leaderPlans().length`와 대조한다. */
export const LEADER_VARIANT_COUNT = 12
/** 슬롯(동시 보유 상한). 기존 랩과 같은 10 — 표가 나란히 읽혀야 한다. */
export const LEADER_SLOTS = MAX_POSITIONS
/** 표본 소실 판정선 — 기존 랩과 같은 값(20). 미만이면 [표본부족]으로 찍는다. */
export const LEADER_MIN_TRADES = SCREEN_MIN_TRADES
/** 트랙 A: 전일 거래대금 서지 배수(전일 거래대금 ÷ 직전 20일 평균, 당일 제외). */
export const LEADER_SURGE_MULT = 3
/** 트랙 A: 전일 등락률 하한(%). */
export const LEADER_CHG_PCT = 5
/** 거래대금 롤링 평균 윈도우(일 · 당일 제외). */
export const LEADER_TV_WINDOW = 20
/** 트랙 B: 시가 갭 하한(%). */
export const LEADER_GAP_PCT = 3
/** B2 장중 손절(진입가=시가 대비 %). */
export const LEADER_B2_STOP_PCT = 3
/** A2/A4 손절(진입가 대비 %) · 보유일(진입일 포함). */
export const LEADER_A2_HOLD = 3
export const LEADER_A2_STOP_PCT = 3
export const LEADER_A4_HOLD = 5
export const LEADER_A4_STOP_PCT = 5
/** B3/B4 변동성 돌파 k. */
export const LEADER_VBRK_K1 = 0.5
export const LEADER_VBRK_K2 = 0.3
/** 트랙 C: 5일 누적 거래대금 서지 배수(직전 5일 합 ÷ 그 앞 20일 평균×5). */
export const LEADER_PERSIST_DAYS = 5
export const LEADER_PERSIST_MULT = 2
/** 트랙 C: 20일 신고가 근접 판정(%, 당일 제외 극값 대비). */
export const LEADER_NEARHIGH_PCT = 90
/** C1/C2 보유일 · C3 트레일링(%). */
export const LEADER_C1_HOLD = 5
export const LEADER_C2_HOLD = 10
export const LEADER_TRAIL_PCT = 5

/** 비용 민감도 2배 — 수수료·거래세·슬리피지 전부 2배(자본은 그대로). */
export const COST_2X: CostSettings = {
  initialCapital: COST.initialCapital,
  feePct: COST.feePct * 2,
  taxPct: COST.taxPct * 2,
  slippagePct: COST.slippagePct * 2,
}

/** 시뮬 시작일 — KRX 정본이 2010-01-04부터라 그 해 초로 고정. */
export const LEADER_START = '2010-01-01'

/** CJS 번들에는 import.meta.url이 없다 — 런처(leader-lab.mjs)가 REPO_ROOT를 넘긴다. */
const root = process.env.REPO_ROOT ?? process.cwd()

// ============================================================================
// 월별 유니버스 — monthly-universe.json (매월 첫 거래일 시총 상위 40+40)
// ============================================================================

/** 시뮬이 쓰는 준비된 유니버스 — 측정일 오름차순. 테스트는 이 구조를 직접 만들어 끼운다. */
export interface PreparedUniverse {
  /** 각 달의 시총 측정일(그 달 첫 거래일 · 오름차순). */
  dates: string[]
  /** 같은 인덱스 달의 80종목(코스피 40 + 코스닥 40) 코드 집합. */
  sets: Set<string>[]
}

export function prepareUniverse(u: KrxMonthlyUniverse): PreparedUniverse {
  const keys = Object.keys(u.months).sort()
  const dates: string[] = []
  const sets: Set<string>[] = []
  for (const k of keys) {
    const m = u.months[k]
    dates.push(m.date)
    sets.push(new Set([...m.kospi, ...m.kosdaq].map((e) => e.code)))
  }
  return { dates, sets }
}

/**
 * `date`에 쓸 수 있는 유니버스 — **measureDate < date(엄격)** 인 마지막 달.
 *
 * 🚫 규칙 1: 시총은 측정일 **종가**로 잰 값이라, 측정일 당일 시가 진입에 그 달 목록을 쓰면
 * 미래참조다. 그래서 월초 첫 거래일에는 **전월** 유니버스가 적용되고, 새 목록은 다음 날부터다.
 * 첫 측정일 이전(2010-01-04 당일 포함)은 null — 진입하지 않는다.
 */
export function universeAt(pu: PreparedUniverse, date: string): Set<string> | null {
  let lo = 0
  let hi = pu.dates.length - 1
  let ans = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (pu.dates[mid] < date) {
      ans = mid
      lo = mid + 1
    } else hi = mid - 1
  }
  return ans >= 0 ? pu.sets[ans] : null
}

/** 정본 파일을 검증하며 읽는다(스키마·순위 빈틈 검증은 parseKrxMonthlyUniverse가 한다). */
export function loadMonthlyUniverse(repoRoot: string = root): KrxMonthlyUniverse {
  const p = join(repoRoot, 'public', 'data', 'krx-daily', 'monthly-universe.json')
  return parseKrxMonthlyUniverse(JSON.parse(readFileSync(p, 'utf8')))
}

// ============================================================================
// 지표 사전계산 — 전부 **당일 제외** 롤링(규칙 1-3)
// ============================================================================

export interface LeaderAux {
  /** 일별 거래대금 근사 = 종가 × 원거래량 (분할 경계 왜곡 있음 — volumeHandlingNote). */
  tv: number[]
  /** 직전 20일 평균 거래대금(당일 제외). 표본 부족이면 null. */
  avgTv20: (number | null)[]
  /** 직전 5일 거래대금 합(당일 제외). */
  sum5Tv: (number | null)[]
  /** 5일 창 **앞** 20일의 평균 거래대금(bars[i−25..i−6]). */
  avgTvPrior20: (number | null)[]
  /** 직전 20일 최고 종가(당일 제외). */
  maxC20: (number | null)[]
  /** 직전 20일 최고 고가(당일 제외). */
  maxH20: (number | null)[]
}

export function buildLeaderAux(bars: DailyBar[]): LeaderAux {
  const n = bars.length
  const W = LEADER_TV_WINDOW
  const P = LEADER_PERSIST_DAYS
  const tv = new Array<number>(n)
  for (let i = 0; i < n; i++) {
    const b = bars[i]
    tv[i] = b.c > 0 && b.v > 0 ? b.c * b.v : 0
  }
  // 누적합으로 창 평균·합 — 값은 인덱스 i에서 bars[i]를 **절대 포함하지 않는다**.
  const pre = new Array<number>(n + 1)
  pre[0] = 0
  for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + tv[i]
  const avgTv20 = new Array<number | null>(n)
  const sum5Tv = new Array<number | null>(n)
  const avgTvPrior20 = new Array<number | null>(n)
  const maxC20 = new Array<number | null>(n)
  const maxH20 = new Array<number | null>(n)
  for (let i = 0; i < n; i++) {
    avgTv20[i] = i >= W ? (pre[i] - pre[i - W]) / W : null
    sum5Tv[i] = i >= P ? pre[i] - pre[i - P] : null
    avgTvPrior20[i] = i >= P + W ? (pre[i - P] - pre[i - P - W]) / W : null
    if (i >= W) {
      let mc = 0
      let mh = 0
      for (let j = i - W; j < i; j++) {
        if (bars[j].c > mc) mc = bars[j].c
        if (bars[j].h > mh) mh = bars[j].h
      }
      maxC20[i] = mc
      maxH20[i] = mh
    } else {
      maxC20[i] = null
      maxH20[i] = null
    }
  }
  return { tv, avgTv20, sum5Tv, avgTvPrior20, maxC20, maxH20 }
}

export function buildAuxMap(histories: Record<string, DailyBar[]>): Record<string, LeaderAux> {
  const out: Record<string, LeaderAux> = {}
  for (const [s, bars] of Object.entries(histories)) out[s] = buildLeaderAux(bars)
  return out
}

// ============================================================================
// 신호 원자 — 트랙 A·C는 bars[0..i−1]만, 트랙 B는 + 진입봉 시가 하나
// ============================================================================

/** 시가 갭(%) = 진입봉 시가 ÷ 전일 종가 − 1. 진입봉에서 읽는 값은 **시가 하나**뿐이다. */
export function gapPct(bars: DailyBar[], i: number): number | null {
  if (i < 1) return null
  const pc = bars[i - 1].c
  if (!(pc > 0) || !(bars[i].o > 0)) return null
  return (bars[i].o / pc - 1) * 100
}

/**
 * **시가가 상한가인가** — 시가 갭이 제도별 가격제한폭 임계(±15%기 14.5 / ±30%기 29.5) 이상.
 * 상한가 시가는 매수 잔량이 쌓여 체결이 안 잡히는 게 현실이라, 이 랩은 **매수 불가로 스킵**한다.
 */
export function isLimitUpOpen(bars: DailyBar[], i: number): boolean {
  const g = gapPct(bars, i)
  return g != null && g >= limitUpThresholdPct(bars[i].date)
}

/** A1 원자: 전일(D−1) 거래대금 서지 ≥ 배수 & 전일 등락률 ≥ 하한. */
export function isPrevDaySurge(bars: DailyBar[], i: number, aux: LeaderAux): boolean {
  const s = i - 1
  if (s < 1) return false
  const avg = aux.avgTv20[s]
  if (avg == null || !(avg > 0)) return false
  if (!(aux.tv[s] >= avg * LEADER_SURGE_MULT)) return false
  const chg = chgPct(bars, s)
  return chg != null && chg >= LEADER_CHG_PCT
}

/** A3 원자: 전일 종가가 직전 20일 최고 **종가**(당일 제외)를 돌파했다. */
export function brokePrevMaxClose(bars: DailyBar[], i: number, aux: LeaderAux): boolean {
  const s = i - 1
  if (s < 0) return false
  const m = aux.maxC20[s]
  return m != null && m > 0 && bars[s].c > m
}

/** C1 원자: 직전 5일 누적 거래대금 서지 + 전일 종가가 20일 신고가(당일 제외)의 90% 이상. */
export function isPersistentLeader(bars: DailyBar[], i: number, aux: LeaderAux): boolean {
  const s = i - 1
  if (s < 0) return false
  const sum5 = aux.sum5Tv[i] // bars[i−5..i−1] — 진입봉 미포함
  const prior = aux.avgTvPrior20[i] // bars[i−25..i−6]
  if (sum5 == null || prior == null || !(prior > 0)) return false
  if (!(sum5 >= prior * LEADER_PERSIST_DAYS * LEADER_PERSIST_MULT)) return false
  const mh = aux.maxH20[s]
  if (mh == null || !(mh > 0)) return false
  return bars[s].c >= mh * (LEADER_NEARHIGH_PCT / 100)
}

/** B3/B4 트리거 = 진입봉 시가 + k × 전일(고가−저가). 시가 이상이므로 max(시가,트리거)=트리거지만
 *  방어적으로 max를 유지한다(전일 범위 0 등 경계). */
export function vbrkTrigger(bars: DailyBar[], i: number, k: number): number | null {
  if (i < 1) return null
  const p = bars[i - 1]
  const range = p.h - p.l
  if (!(range >= 0) || !(bars[i].o > 0)) return null
  return bars[i].o + k * range
}

// ============================================================================
// 변형 정의
// ============================================================================

export type LeaderTrack = 'A' | 'B' | 'C'
export type LeaderGroup = 'next' | 'gap' | 'vbrk' | 'persist'

export const GROUP_LABEL: Record<LeaderGroup, string> = {
  next: '트랙 A — 전일 주도주 → 익일 시가',
  gap: '트랙 B — 당일 시가 인과 선정(갭)',
  vbrk: '트랙 B — 당일 시가 인과 선정(변동성 돌파)',
  persist: '트랙 C — 주도주 관성(여러 날)',
}

/**
 * 신호가 볼 수 있는 정보의 범위.
 *   · `prevBars`         — bars[0..i−1]만. (트랙 A·C)
 *   · `prevBarsPlusOpen` — 위 + 진입봉 **시가 하나**. (트랙 B — B3/B4의 고가 터치 판정은
 *     신호가 아니라 조건부 주문 체결 여부라 신호 함수는 고가를 읽지 않는다.)
 */
export type LeaderScope = 'prevBars' | 'prevBarsPlusOpen'

export type LeaderEntry =
  /** 진입봉 시가 체결. */
  | { kind: 'open' }
  /** 스탑 매수 — 당일 고가 ≥ 트리거일 때만 max(시가, 트리거) 체결(불리한 쪽). 미터치면 미체결. */
  | { kind: 'vbrk'; k: number }

export interface LeaderExit {
  /** 진입일 포함 N거래일째 **종가** 청산. 1이면 진입 당일 종가. */
  holdDays: number
  /** 진입가(체결 기준가) 대비 고정 손절(%). 저가 터치 → 손절가, 갭 관통 → 시가(불리한 쪽). */
  stopPct?: number
  /** 보유 중 **종가 고점** 대비 트레일링 스톱(%). 고점은 전일까지의 종가로만 판정(당일 제외). */
  trailPct?: number
}

export interface LeaderPlan {
  key: string
  label: string
  track: LeaderTrack
  group: LeaderGroup
  scope: LeaderScope
  entry: LeaderEntry
  exit: LeaderExit
  signal: (bars: DailyBar[], i: number, aux: LeaderAux) => boolean
  /** 표에 붙는 한 줄 설명(규칙 1 처리·체결 가정). */
  note: string
}

/** 12변형. 순서를 고정해 출력이 실행마다 흔들리지 않게 한다. */
export function leaderPlans(): LeaderPlan[] {
  const A1 = (bars: DailyBar[], i: number, aux: LeaderAux) => isPrevDaySurge(bars, i, aux)
  const A3 = (bars: DailyBar[], i: number, aux: LeaderAux) => isPrevDaySurge(bars, i, aux) && brokePrevMaxClose(bars, i, aux)
  const B1 = (bars: DailyBar[], i: number) => {
    const g = gapPct(bars, i)
    return g != null && g >= LEADER_GAP_PCT
  }
  const VB = (bars: DailyBar[], i: number) => vbrkTrigger(bars, i, 1) != null // 유효성만 — k와 무관
  const C1 = (bars: DailyBar[], i: number, aux: LeaderAux) => isPersistentLeader(bars, i, aux)
  return [
    // ---- 트랙 A — 전일 주도주 → 익일 시가 ----------------------------------
    {
      key: 'next-1d',
      label: `A1 전일 서지×${LEADER_SURGE_MULT}·+${LEADER_CHG_PCT}%↑ → 익일 시가, 당일 종가`,
      track: 'A',
      group: 'next',
      scope: 'prevBars',
      entry: { kind: 'open' },
      exit: { holdDays: 1 },
      signal: A1,
      note: '선정은 D−1 종가까지의 정보뿐(서지·등락률 모두 전일 기준·당일 제외 롤링).',
    },
    {
      key: 'next-3d',
      label: `A2 A1 선정 → ${LEADER_A2_HOLD}일 보유(−${LEADER_A2_STOP_PCT}% 손절 선행)`,
      track: 'A',
      group: 'next',
      scope: 'prevBars',
      entry: { kind: 'open' },
      exit: { holdDays: LEADER_A2_HOLD, stopPct: LEADER_A2_STOP_PCT },
      signal: A1,
      note: '손절은 진입가(시가) 대비. 갭 관통 시 시가(불리한 쪽) 체결.',
    },
    {
      key: 'next-brk-1d',
      label: 'A3 A1 + 전일 20일 최고종가 돌파 → 익일 시가, 당일 종가',
      track: 'A',
      group: 'next',
      scope: 'prevBars',
      entry: { kind: 'open' },
      exit: { holdDays: 1 },
      signal: A3,
      note: '돌파 판정 극값은 **당일 제외** 직전 20일(규칙 1-3).',
    },
    {
      key: 'next-brk-5d',
      label: `A4 A3 선정 → ${LEADER_A4_HOLD}일 보유(−${LEADER_A4_STOP_PCT}% 손절)`,
      track: 'A',
      group: 'next',
      scope: 'prevBars',
      entry: { kind: 'open' },
      exit: { holdDays: LEADER_A4_HOLD, stopPct: LEADER_A4_STOP_PCT },
      signal: A3,
      note: 'A3와 같은 선정, 보유·손절만 다르다(같은 기간 A/B).',
    },
    // ---- 트랙 B — 당일 시가 인과 선정 --------------------------------------
    {
      key: 'gap-1d',
      label: `B1 시가 갭 +${LEADER_GAP_PCT}%↑ & 전일 거래대금 상위 → 시가 매수, 종가 청산`,
      track: 'B',
      group: 'gap',
      scope: 'prevBarsPlusOpen',
      entry: { kind: 'open' },
      exit: { holdDays: 1 },
      signal: B1,
      note: '"전일 거래대금 상위"는 슬롯 정렬(전일 거래대금 내림차순)로 구현. 판단은 시가 하나+전일까지.',
    },
    {
      key: 'gap-stop',
      label: `B2 B1 + 장중 손절(시가×${(1 - LEADER_B2_STOP_PCT / 100).toFixed(2)})`,
      track: 'B',
      group: 'gap',
      scope: 'prevBarsPlusOpen',
      entry: { kind: 'open' },
      exit: { holdDays: 1, stopPct: LEADER_B2_STOP_PCT },
      signal: B1,
      note: '진입 당일 시가=진입가라 갭 관통은 구조상 없음(이월 보유가 없다). 저가 터치 시 손절가, 손절 우선.',
    },
    {
      key: 'vbrk-05',
      label: `B3 변동성 돌파 k=${LEADER_VBRK_K1} → max(시가,트리거) 체결, 종가 청산`,
      track: 'B',
      group: 'vbrk',
      scope: 'prevBarsPlusOpen',
      entry: { kind: 'vbrk', k: LEADER_VBRK_K1 },
      exit: { holdDays: 1 },
      signal: VB,
      note: '트리거 = 시가 + k×전일(고−저). 당일 고가 ≥ 트리거일 때만 체결(스탑 매수) — 불리한 쪽 가격.',
    },
    {
      key: 'vbrk-03',
      label: `B4 변동성 돌파 k=${LEADER_VBRK_K2}`,
      track: 'B',
      group: 'vbrk',
      scope: 'prevBarsPlusOpen',
      entry: { kind: 'vbrk', k: LEADER_VBRK_K2 },
      exit: { holdDays: 1 },
      signal: VB,
      note: 'B3와 같고 k만 낮다(더 자주 발동·더 이른 진입).',
    },
    // ---- 트랙 C — 주도주 관성 ----------------------------------------------
    {
      key: 'persist-5d',
      label: `C1 5일 누적 서지×${LEADER_PERSIST_MULT} + 20일 신고가 ${LEADER_NEARHIGH_PCT}%↑ → 익일 시가, ${LEADER_C1_HOLD}일 보유`,
      track: 'C',
      group: 'persist',
      scope: 'prevBars',
      entry: { kind: 'open' },
      exit: { holdDays: LEADER_C1_HOLD },
      signal: C1,
      note: '5일 합·비교 20일 창·신고가 극값 전부 진입봉 제외(규칙 1-3).',
    },
    {
      key: 'persist-10d',
      label: `C2 C1 선정 → ${LEADER_C2_HOLD}일 보유`,
      track: 'C',
      group: 'persist',
      scope: 'prevBars',
      entry: { kind: 'open' },
      exit: { holdDays: LEADER_C2_HOLD },
      signal: C1,
      note: 'C1과 같은 선정, 보유 기간만 2배.',
    },
    {
      key: 'persist-trail',
      label: `C3 C1 + 트레일링 스톱 ${LEADER_TRAIL_PCT}%`,
      track: 'C',
      group: 'persist',
      scope: 'prevBars',
      entry: { kind: 'open' },
      exit: { holdDays: LEADER_C1_HOLD, trailPct: LEADER_TRAIL_PCT },
      signal: C1,
      note: '고점은 보유 중 **종가** 기준(전일까지), 터치 판정은 저가, 갭 관통 시 시가 체결.',
    },
    {
      key: 'limitup-next',
      label: 'C4 전일 상한가 마감 → 익일 시가, 당일 종가',
      track: 'C',
      group: 'persist',
      scope: 'prevBars',
      entry: { kind: 'open' },
      exit: { holdDays: 1 },
      // ↔ shortterm-lab ②-1 `limitup-close`와 정의 동일(상호 참조 — 헤더 주석).
      //   차이: 유니버스(월별 시총 80)와 시가 상한가 스킵(이 랩의 체결 규칙)뿐.
      signal: (bars, i) => isLimitUpClose(bars, i - 1),
      note: 'shortterm-lab ②-1과 같은 정의(상호 참조). 여기서는 시가가 상한가면 스킵된다.',
    },
  ]
}

// ============================================================================
// 시뮬레이터 — 12변형이 같은 한 경로를 탄다 (계열별 시뮬 분리 금지 — 24차 교훈)
// ============================================================================
//
// 하루 처리 순서(이 순서가 곧 규칙 1의 집행이다):
//   1) 시가 진입 — 후보 판정은 신호 계약대로(트랙 B만 진입봉 시가 추가). 시가가 상한가면 스킵.
//   2) 장중 손절·트레일 — 진입일 포함. 갭 관통은 시가(불리한 쪽). 손절이 종가 청산보다 먼저다.
//   3) 종가 청산 — 보유일수가 찬 포지션. 봉이 없으면(거래정지) 다음 거래일로 이월.
//   4) 트레일 고점 갱신(오늘 **종가**) — 내일 판정부터 쓰인다(당일 저가를 당일 종가로 판정하지 않는다).
//   5) 종가 평가.

interface LeaderPosMeta {
  /** 예약 종가 청산 캘린더 인덱스(진입일 + holdDays − 1). */
  dueIdx: number
  /** 체결 기준가(슬리피지 전) — 고정 손절의 기준. */
  entryPx: number
  /** 보유 중 종가 고점(전일까지). 진입 당일은 null — 트레일 판정 없음. */
  trailPeak: number | null
}

export interface LeaderRun {
  /** 원화 자산곡선(시작 = initialCapital). */
  equity: { date: string; equity: number }[]
  fills: FillEvent[]
  closed: number
  wins: number
  /** 청산 완료 거래의 (비용 후) 수익률 합·건수 — 평균 거래손익률용. */
  retSum: number
  retCount: number
  /** 신호는 참이었지만 **시가가 상한가**라 매수 불가로 스킵한 후보 수(진단). */
  skippedLimitUpOpen: number
}

export function simulateLeader(
  histories: Record<string, DailyBar[]>,
  symbols: string[],
  cost: CostSettings,
  plan: LeaderPlan,
  pu: PreparedUniverse,
  auxMap?: Record<string, LeaderAux>,
  startDate: string = LEADER_START,
  slots: number = LEADER_SLOTS,
): LeaderRun {
  const { universe, calendar, idxOf } = makeSimCtx(histories, symbols, startDate)
  const aux = auxMap ?? buildAuxMap(histories)
  const book = newBook(cost.initialCapital)
  const equity: { date: string; equity: number }[] = []
  const fills: FillEvent[] = []
  const meta = new Map<string, LeaderPosMeta>()
  let retSum = 0
  let retCount = 0
  let skippedLimitUpOpen = 0

  const barAt = (s: string, date: string): DailyBar | null => {
    const bi = idxOf[s]?.get(date)
    return bi == null ? null : histories[s][bi]
  }
  const closeAt = (date: string) => (s: string) => barAt(s, date)?.c ?? null

  /** 전량 청산 — 예약 청산(보유일수·손절선)이 발동한 것이므로 signalDate = date. */
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

  const equityAt = (priceOf: (s: string) => number | null): number => {
    let eq = book.cash
    for (const [s, p] of book.positions) {
      const px = priceOf(s)
      eq += p.qty * (px != null && px > 0 ? px : p.lastClose)
    }
    return eq
  }

  /** 시가 후보 산출 + 슬롯 배분 매수. */
  const enter = (d: number): void => {
    // 규칙 1-6: 마지막 봉에서는 신규 진입 없음(체결·청산할 다음 봉이 없다).
    if (d >= calendar.length - 1) return
    const free = slots - book.positions.size
    if (free <= 0) return
    const date = calendar[d]
    // 유니버스는 시총 측정일 **다음 날부터** — universeAt이 엄격 부등호로 강제한다(규칙 1).
    const uni = universeAt(pu, date)
    if (!uni) return
    // 신호일 = 판단에 쓴 마지막 정보의 날. 트랙 B만 진입봉 시가를 보므로 당일, A·C는 전 거래일.
    const signalDate = plan.scope === 'prevBarsPlusOpen' ? date : d > 0 ? calendar[d - 1] : date
    const cands: { sym: string; bi: number; tv: number }[] = []
    for (const s of universe) {
      if (!uni.has(s)) continue
      if (book.positions.has(s)) continue // 중복 진입 없음(피라미딩 금지)
      const bi = idxOf[s].get(date)
      if (bi == null || bi < 1) continue
      const bars = histories[s]
      if (!(bars[bi].o > 0)) continue
      const a = aux[s]
      if (!a) continue
      if (!plan.signal(bars, bi, a)) continue
      // 시가가 상한가면 매수 불가(체결이 안 잡히는 현실) — 신호는 참이었으므로 따로 센다.
      if (isLimitUpOpen(bars, bi)) {
        skippedLimitUpOpen++
        continue
      }
      cands.push({ sym: s, bi, tv: prevTradingValue(bars, bi) })
    }
    if (cands.length === 0) return
    // 전일 거래대금 내림차순 · 동점은 코드 오름차순 — 결정적 타이브레이크.
    const ordered = [...cands].sort((a, b) => (b.tv !== a.tv ? b.tv - a.tv : a.sym < b.sym ? -1 : 1))
    const take = ordered.slice(0, free)
    // 슬롯 금액 = 총자산 ÷ 슬롯 수 고정(후보가 적은 날 몰아넣으면 사실상 레버리지 — 비교가 깨진다).
    const slotAmt = equityAt((s) => barAt(s, date)?.o ?? null) / slots
    if (!(slotAmt > 0)) return
    for (const t of take) {
      const bars = histories[t.sym]
      const bar = bars[t.bi]
      let fillPx: number
      if (plan.entry.kind === 'vbrk') {
        const trig = vbrkTrigger(bars, t.bi, plan.entry.k)
        // 스탑 매수 미체결 — 주문(슬롯)은 걸었지만 당일 고가가 트리거에 못 닿았다.
        if (trig == null || !(bar.h >= trig)) continue
        fillPx = Math.max(bar.o, trig) // 불리한 쪽(갭으로 트리거를 넘겨 열리면 시가)
      } else {
        fillPx = bar.o
      }
      const budget = Math.min(slotAmt, book.cash)
      if (!(budget > 0)) break
      const q = bookBuy(book, cost, t.sym, fillPx, budget, d)
      if (q <= 0) continue
      fills.push({ date, sym: t.sym, side: 'buy', px: fillPx, qty: q, signalDate })
      meta.set(t.sym, { dueIdx: d + Math.max(1, plan.exit.holdDays) - 1, entryPx: fillPx, trailPeak: null })
    }
  }

  for (let d = 0; d < calendar.length; d++) {
    const date = calendar[d]

    // 1) 시가 진입
    enter(d)

    // 2) 장중 손절·트레일 — 진입 시점에 걸어 둔 조건부 주문이다. 판단에 쓰는 값은
    //    기준선(진입가·전일까지의 종가 고점)과 오늘 봉의 시가·저가뿐이며 오늘 종가는 보지 않는다.
    if (plan.exit.stopPct != null || plan.exit.trailPct != null) {
      for (const [sym, m] of [...meta]) {
        const bar = barAt(sym, date)
        if (!bar) continue // 봉 결측(거래정지) — 주문은 살아 있고 다음 거래일에 같은 기준선으로 검사
        if (plan.exit.stopPct != null && m.entryPx > 0) {
          const stopPx = m.entryPx * (1 - plan.exit.stopPct / 100)
          if (bar.l <= stopPx) {
            // 갭으로 관통했으면 기준가가 아니라 **시가**(더 불리한 쪽)로 체결(규칙 1-4).
            sellFull(date, sym, bar.o < stopPx ? bar.o : stopPx)
            continue
          }
        }
        if (plan.exit.trailPct != null && m.trailPeak != null) {
          const trailPx = m.trailPeak * (1 - plan.exit.trailPct / 100)
          if (bar.l <= trailPx) sellFull(date, sym, bar.o < trailPx ? bar.o : trailPx)
        }
      }
    }

    // 3) 종가 청산 — 손절이 먼저 검사됐다(같은 날 둘 다면 손절 체결이 남는다 — 보수).
    for (const [sym, m] of [...meta]) {
      if (d < m.dueIdx) continue
      const bar = barAt(sym, date)
      if (!bar) continue // 체결 불가 — 다음 거래일로 이월(기준일을 앞당기지 않는다)
      sellFull(date, sym, bar.c)
    }

    // 4) 트레일 고점 갱신(오늘 종가) — **내일 판정부터** 쓰인다. 진입 당일 종가가 첫 고점이다.
    if (plan.exit.trailPct != null) {
      for (const [sym, m] of meta) {
        const bar = barAt(sym, date)
        if (!bar || !(bar.c > 0)) continue
        m.trailPeak = m.trailPeak == null ? bar.c : Math.max(m.trailPeak, bar.c)
      }
    }

    // 5) 종가 평가
    equity.push({ date, equity: bookMark(book, closeAt(date)) })
  }

  return { equity, fills, closed: book.closed, wins: book.wins, retSum, retCount, skippedLimitUpOpen }
}

// ============================================================================
// 요약 — 곡선은 스칼라로 접는다(OOM 교훈)
// ============================================================================

/** 원화 곡선 → 배수 곡선 + 연도별 수익. summarizeStrat(알파·전후반)과 워크포워드 표가 이걸 쓴다. */
export function toChain(run: LeaderRun, initialCapital: number): ChainStats {
  const equity = run.equity.map((e) => ({ date: e.date, equity: e.equity / initialCapital }))
  return { equity, perYear: perYearFromCurve(equity), closed: run.closed, wins: run.wins }
}

export function perYearFromCurve(curve: { date: string; equity: number }[]): {
  y: number
  ret: number
  mapped: string
}[] {
  const out: { y: number; ret: number; mapped: string }[] = []
  let prevEnd = curve.length ? curve[0].equity : 1
  let y: number | null = null
  let last = prevEnd
  for (const p of curve) {
    const py = Number(p.date.slice(0, 4))
    if (y == null) y = py
    if (py !== y) {
      out.push({ y, ret: prevEnd > 0 ? last / prevEnd : 1, mapped: '' })
      prevEnd = last
      y = py
    }
    last = p.equity
  }
  if (y != null) out.push({ y, ret: prevEnd > 0 ? last / prevEnd : 1, mapped: '' })
  return out
}

export interface LeaderVariant {
  plan: LeaderPlan
  row: StratRow // 실제 비용
  freeRow: StratRow // 비용 0
  dblRow: StratRow // 비용 2배
  run: LeaderRun
}

/** 평균 거래손익률(%) — 청산 완료 기준. */
export const leaderAvgTradeRetPct = (r: LeaderRun): number | null =>
  r.retCount > 0 ? (r.retSum / r.retCount) * 100 : null

const pctOrDash = (v: number | null) => (v == null ? '—' : `${f1(v)}%p`)
const numOrDash = (v: number | null, digits = 2) => (v == null ? '—' : v.toFixed(digits))

// ============================================================================
// ⚠️ 체결 현실성 경고 — 표를 찍는 쪽이 강제로 함께 출력한다(표만 떼어 읽을 수 없게)
// ============================================================================

export function leaderRealismWarning(): void {
  log('')
  log('## ⚠️ 체결 현실성 경고 — 아래 숫자를 그대로 믿지 마라')
  log('')
  log('· **일봉의 시가·종가 단일가 체결 가정은 급등 주도주에서 가장 크게 깨진다.** 갭 시가는')
  log('  동시호가 수급이 몰리는 자리라 슬리피지 0.1% 가정이 특히 작다.')
  log('· **트랙 B의 판단(시가)과 체결(시가)은 일봉에서 같은 점이다.** 실제로는 시가를 보고 주문을')
  log('  내는 사이 가격이 움직인다 — 절단 불변성 테스트로 잡히지 않는 낙관이며 갭 계열 숫자는 후하다.')
  log('· **변동성 돌파(B3/B4)의 트리거 체결도 낙관이다** — 돌파 순간 체결 가정이며, 실제 돌파')
  log('  체결은 추격 호가라 더 불리하다.')
  log('· **시가 상한가 스킵은 넣었지만**(체결이 안 잡히는 현실), 장중 상한가 도달·하한가 매도')
  log('  불능 같은 유동성 제약은 일봉으로 구분하지 못한다.')
  log('· **회전율이 극단적이라 비용이 성패를 지배한다** — 비용 0/1배/2배 민감도 표를 같이 읽어라.')
}

// ============================================================================
// 실행
// ============================================================================

async function run(modeKey: string, groups: LeaderGroup[] | null): Promise<void> {
  const startedAt = Date.now()
  log(`# 주도주 랩(leader-lab) — 국장 "당일 주도주" 추종 12변형 (MODE=${modeKey})`)
  log('')
  log('"주도주(거래대금·등락률 상위 급등 종목)를 따라붙으면 먹을 게 있는가"를 **일봉으로 인과적으로**')
  log('잰다. 당일 종가·당일 거래대금 기준 "당일 선정→당일 매수"는 그 자체가 미래참조라 재지 않는다')
  log('(shortterm-lab 헤더의 같은 결론 참조). 진짜 장중(분봉) 진입은 **미측정** — 분봉 데이터가')
  log('절단 상태(public/data/intraday coverage.usableFrom=null)라 분봉 확보 후 별도 트랙으로 잰다.')

  // ---- 시세·유니버스 (KRX 커밋 정본만 — 야후는 벤치 1종목뿐) -------------------
  const source = 'krx' as const
  setCompareBasis(compareBasisFor(source))
  log('')
  log(compareBasisNote(compareBasisFor(source)))

  const uniRaw = loadMonthlyUniverse()
  const pu = prepareUniverse(uniRaw)
  const codes = [
    ...new Set(
      Object.values(uniRaw.months).flatMap((m) => [...m.kospi, ...m.kosdaq].map((e) => e.code)),
    ),
  ].sort()
  if (codes.length === 0) throw new Error('월별 유니버스 코드가 0개다 — monthly-universe.json을 확인하라.')
  log('')
  log(
    `유니버스: monthly-universe **월별 시총 상위 40+40**(측정 ${pu.dates[0]} ~ ${pu.dates[pu.dates.length - 1]}, ` +
      `${pu.dates.length}개월 · 합집합 ${codes.length}종목) ∩ KRX 일별 정본. ` +
      `측정일 당일에는 **전월 목록**을 쓴다(시총이 그날 종가라 — 규칙 1).`,
  )
  if (uniRaw.missingMonths.length) log(`⚠️ 유니버스 결측 달: ${uniRaw.missingMonths.join(', ')} (그 기간은 직전 달 목록으로 계속 돈다)`)

  const load = await loadShortHistories(codes, source)
  const histories = load.histories
  const okCount = Object.keys(histories).length
  log(`시세 로드 ${okCount}/${codes.length} · KRX 일별 정본(수정주가 적용) · 수집 범위 밖 ${load.failed.length}`)
  log(`  ${load.meta.note}`)
  for (const l of load.meta.limits) log(`  ⚠️ ${l}`)
  log(`  ⚠️ ${MIXED_SOURCE_NOTE}`)
  if (okCount === 0)
    throw new Error(`시세를 하나도 받지 못했다(${codes.length}종목 전량 실패) — public/data/krx-daily/ 정본을 확인하라.`)
  if (okCount < codes.length / 2)
    log(`⚠️ 로드 성공률이 절반 미만이다(${okCount}/${codes.length}) — 유니버스가 크게 줄어든 실행이다.`)
  const idx = load.krxIndex
  if (idx && idx.from !== KRX_DAILY_START_HINT)
    log(`⚠️ 시작일 힌트(${KRX_DAILY_START_HINT})와 실제 정본 시작일(${idx.from})이 다르다 — 실제 값을 따르라.`)
  if (idx) log(`실제 시세 구간 ${idx.from} ~ ${idx.to} — 첫 ${LEADER_TV_WINDOW + LEADER_PERSIST_DAYS}봉은 롤링 워밍업이 덜 차 신호가 성기다.`)

  // ---- 거래량 취급 — ④와 같은 근사 왜곡이 이 랩의 서지·정렬에 직결된다 ---------
  const appliedSplits = splitCountFromLimits(load.meta.limits)
  volumeHandlingNote(source, idx, appliedSplits)
  if (idx && !idx.volume)
    throw new Error(
      'KRX 정본에 거래량이 없다(index.volume=false) — 이 랩의 거래대금 서지·후보 정렬이 전부 0이 되어 ' +
        '조용히 다른 실험이 된다. `--with-volume`으로 다시 수집하라.',
    )

  // ---- 벤치(KODEX 200) — 야후. 실패해도 죽지 않되 [벤치 미로딩]을 명시한다 ------
  let bench: DailyBar[] = []
  try {
    bench = await fetchCompare(BENCH)
  } catch (e) {
    bench = []
    log('')
    log(`❌ 벤치(${BENCH} KODEX 200) 로드 실패 — ${String(e)}`)
  }
  const benchEq = benchCurve(bench)
  const benchMissing = benchEq.length < 2
  if (benchMissing) {
    log('❌ **[벤치 미로딩] 알파를 산출할 수 없다.** 알파 열의 —는 "전략이 졌다"가 아니라 **재지 못했다**다.')
    log('   (컨테이너에서 야후는 403이다 — 알파가 필요한 실행은 GHA backtest.yml `leader:all`로.)')
  } else {
    log(`벤치 ${BENCH}(KODEX 200) 시작 ${bench[0]?.date ?? '—'} — 가격수익 기준(전략과 동일 · 배당 비대칭 없음).`)
  }

  // ---- 실행 --------------------------------------------------------------------
  const plans = leaderPlans().filter((p) => groups == null || groups.includes(p.group))
  const auxMap = buildAuxMap(histories)
  const symbols = Object.keys(histories).sort()
  log('')
  log(
    `슬롯 ${LEADER_SLOTS} · 후보 초과 시 전일 거래대금 내림차순(동점 코드 오름차순) · **시가 상한가는 매수 스킵** · ` +
      `비용 수수료 ${COST.feePct}% + 거래세 ${COST.taxPct}% + 슬리피지 ${COST.slippagePct}%(편도)`,
  )

  const variants: LeaderVariant[] = []
  for (const plan of plans) {
    const real = simulateLeader(histories, symbols, COST, plan, pu, auxMap)
    const free = simulateLeader(histories, symbols, COST_FREE, plan, pu, auxMap)
    const dbl = simulateLeader(histories, symbols, COST_2X, plan, pu, auxMap)
    variants.push({
      plan,
      row: summarizeStrat(plan.label, toChain(real, COST.initialCapital), benchEq, KRXPIT_HALF),
      freeRow: summarizeStrat(`${plan.label} [비용0]`, toChain(free, COST_FREE.initialCapital), benchEq, KRXPIT_HALF),
      dblRow: summarizeStrat(`${plan.label} [비용2×]`, toChain(dbl, COST_2X.initialCapital), benchEq, KRXPIT_HALF),
      run: real,
    })
  }

  // ---- 본표 --------------------------------------------------------------------
  log('')
  log(`## 결과 — 실제 비용 (판정: 규칙 5 — 알파 = 전략 연환산 − ${BENCH} 연환산 · 전·후반 분할 ${KRXPIT_HALF})`)
  log('')
  log('| 변형 | 총수익 | CAGR | MDD | 칼마 | 매매 | 승률 | 평균거래 | 알파(전) | 전반 알파(~2017) | 후반 알파(2018~) | 상한가시가 스킵 | 표본 |')
  log('|---|---|---|---|---|---|---|---|---|---|---|---|---|')
  for (const v of variants) {
    const r = v.row
    const wr = r.closed > 0 ? `${((r.wins / r.closed) * 100).toFixed(0)}%` : '—'
    log(
      `| ${v.plan.label} | ${f1(r.full.total)}% | ${f1(r.full.cagr)}% | ${f1(r.full.mdd)}% | ` +
        `${numOrDash(calmarOf(r.full), 3)} | ${r.closed} | ${wr} | ${pctOrDash(leaderAvgTradeRetPct(v.run))} | ` +
        `${pctOrDash(r.alphaFull)} | ${pctOrDash(r.alphaA)} | ${pctOrDash(r.alphaB)} | ${v.run.skippedLimitUpOpen} | ` +
        `${r.closed >= LEADER_MIN_TRADES ? '✅' : `⚠️ [표본부족 <${LEADER_MIN_TRADES}]`} |`,
    )
  }
  if (benchMissing) log('⚠️ [벤치 미로딩] 이 표의 알파 —는 미측정이다(판정 근거가 되지 못한다).')
  log('')
  log('변형별 판단·체결 규약:')
  for (const v of variants) log(`- **${v.plan.label}** — ${v.plan.note}`)

  // ---- 연도별 워크포워드 --------------------------------------------------------
  const years = variants.length ? variants[0].row.perYear.map((p) => p.y) : []
  if (years.length) {
    log('')
    log('## 연도별 워크포워드 (변형 × 연도 수익률 % · 거짓 매끈함 방지)')
    log('')
    log(`| 변형 | ${years.join(' | ')} |`)
    log(`|---|${years.map(() => '---').join('|')}|`)
    for (const v of variants) {
      const byYear = new Map(v.row.perYear.map((p) => [p.y, p.ret]))
      log(
        `| ${v.plan.label} | ${years
          .map((y) => {
            const r = byYear.get(y)
            return r == null ? '—' : `${f1((r - 1) * 100)}%`
          })
          .join(' | ')} |`,
      )
    }
    log('※ 한 해가 나머지를 전부 만들었다면 그 성적은 구조가 아니라 그 해의 사건이다.')
  }

  // ---- 비용 민감도 --------------------------------------------------------------
  log('')
  log('## 비용 민감도 — 이 계열은 회전율이 극단적이라 비용이 성패를 지배한다')
  log('')
  log('| 변형 | CAGR 비용0 | CAGR 실비용 | CAGR 비용2× | 알파(전) 비용0 | 알파(전) 실비용 | 알파(전) 비용2× |')
  log('|---|---|---|---|---|---|---|')
  let costKilled = 0
  for (const v of variants) {
    const died = (v.freeRow.alphaFull ?? 0) > 0 && !((v.row.alphaFull ?? 0) > 0)
    if (died) costKilled++
    log(
      `| ${v.plan.label} | ${f1(v.freeRow.full.cagr)}% | ${f1(v.row.full.cagr)}% | ${f1(v.dblRow.full.cagr)}% | ` +
        `${pctOrDash(v.freeRow.alphaFull)} | ${pctOrDash(v.row.alphaFull)} | ${pctOrDash(v.dblRow.alphaFull)} |`,
    )
  }
  if (!benchMissing)
    log(`※ 비용 0에서만 알파 양수인 변형 ${costKilled}개 — 그것은 통과가 아니라 "비용에 죽었다"는 증거다.`)

  // ---- 판정 ---------------------------------------------------------------------
  const passed = variants.filter(
    (v) => (v.row.alphaA ?? -1) > 0 && (v.row.alphaB ?? -1) > 0 && v.row.closed >= LEADER_MIN_TRADES,
  )
  log('')
  log(`## 판정 (전·후반 알파 모두 양수 + 매매 ≥ ${LEADER_MIN_TRADES}건)`)
  if (benchMissing) {
    log('❌ **[벤치 미로딩] 이번 실행은 판정 불가** — 알파가 전부 null이다. GHA에서 다시 돌려라.')
  } else if (passed.length === 0) {
    log('**통과 없음.** 어떤 변형도 전·후반 알파를 모두 양수로 만들지 못했거나 표본이 소실됐다.')
  } else {
    for (const v of passed)
      log(
        `- ✅ ${v.plan.label} — 알파(전) ${pctOrDash(v.row.alphaFull)} · 전반 ${pctOrDash(v.row.alphaA)} · ` +
          `후반 ${pctOrDash(v.row.alphaB)} · MDD ${f1(v.row.full.mdd)}%`,
      )
    log(`※ ${variants.length}변형 다중검정이다 — 한둘 통과는 우연과 구분되지 않는다. 분봉 재검이 다음 게이트다.`)
  }

  // ---- 한계 ---------------------------------------------------------------------
  log('')
  log('## 이 실험의 구조적 한계 (결과 해석에 반드시 병기)')
  log('· **유니버스가 시총 상위 80이라 진짜 소형 급등 주도주는 원천 배제된다.** 이 표를 "주도주 전략')
  log('  일반"으로 확대해석하지 마라 — 대형·중형주 안에서의 추종만 잰 것이다.')
  log('· **수급(외인·기관) 데이터 부재** — "쌍끌이 매수" 같은 수급 조건은 미측정이다.')
  log('· **분봉 부재** — 장중 진입·장중 손절의 실제 체결은 미측정이다(현재 60일 롤링 수집 누적 중).')
  log('· 가격은 KRX 원주가 기반 수정주가(배당 미반영·가격수익)다. 벤치도 가격수익으로 맞춰 알파는')
  log('  편향되지 않지만, 절대 수익률을 총수익 표와 나란히 놓으면 안 된다.')
  log('· 거래대금은 수정종가 × **원거래량** 근사라 분할 경계에서 서지·정렬이 왜곡될 수 있다(위 절 참조).')
  log('· 유니버스는 실측 랭킹이라 선택편향이 없고 KRX 정본은 상폐 종목을 포함한다(가격 생존편향 해소).')
  log(`· 2010년 이전이 없다 — 2008 금융위기 구간이 표에 없어 MDD는 "겪지 않은 위기"만큼 작다.`)

  leaderRealismWarning()

  log('')
  log(priceSourceHeadline(source, idx?.from))
  if (benchMissing) log('⚠️ [벤치 미로딩] 알파 미산출 실행 — 판정 수치는 근거가 되지 못한다.')
  log('')
  log('---')
  log('⚠️ 이 수치는 시뮬레이션이며 **투자자문이 아니다.** 확정적 매수·매도 권유가 아니라 관찰·조건·확률')
  log('   프레임의 측정이다. 손실 경로는 MDD 열이 그 변형이 견뎌야 했던 최대 하락이고, 무효화 지점은')
  log('   "전·후반 중 한쪽이라도 벤치 대비 알파가 음수"다. 급등 주도주 추종은 체결·유동성 가정이')
  log('   성적을 만든다 — 위 경고 없이 읽은 숫자는 근거가 되지 못한다. 과거 성적이 미래를 보장하지 않는다.')
  log('')
  log(`(실행 ${((Date.now() - startedAt) / 1000).toFixed(0)}초)`)
}

const MODES: Record<string, () => Promise<void>> = {
  all: () => run('all', null),
  next: () => run('next', ['next']),
  gap: () => run('gap', ['gap']),
  vbrk: () => run('vbrk', ['vbrk']),
  persist: () => run('persist', ['persist']),
}

// 런처(scripts/leader-lab.mjs)만 LEADER_LAB_RUN=1을 넘긴다. 테스트가 이 모듈을
// import할 때는 자동 실행되지 않는다(shortterm·idea-lab 가드와 같은 규약).
if (process.env.LEADER_LAB_RUN === '1') {
  const mode = process.env.MODE ?? 'all'
  const entry = MODES[mode]
  if (!entry) {
    console.error(`알 수 없는 MODE=${mode} — 가능: ${Object.keys(MODES).join(', ')}`)
    process.exit(1)
  }
  entry().catch((e) => {
    console.error(e)
    process.exit(1)
  })
}
