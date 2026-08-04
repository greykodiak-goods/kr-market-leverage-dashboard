// 미장 전략 탐색 러너 — 41차 "미국 시장에서 통하는 기법이 있는가"
//
// ════════════════════════════════════════════════════════════════════════════
// ── 이 회차가 묻는 것 ────────────────────────────────────────────────────────
// ════════════════════════════════════════════════════════════════════════════
//
//   국장은 오늘까지 **판정 통과 0**이 확정됐다(34·38·39·40차 · 누적 500변형 이상).
//   그래서 무게를 미장으로 옮긴다. 미장에서 지금까지 나온 것은 이렇다:
//
//     | 계열              | 유니버스   | 결과                     | 차수 |
//     |-------------------|-----------|--------------------------|-----|
//     | 추세돌파(MA×신고가) | US PIT 20 | ❌ 36조합 전패            | 24  |
//     | 추세돌파           | US PIT 80 | ❌ 알파 −2.5%p            | 27  |
//     | 횡단면 모멘텀 12-1  | US PIT 20 | ❌ 0/6                    | 26  |
//     | **횡단면 모멘텀 12-1** | **US PIT 80** | ✅ **8/8 · 상위8+게이트 알파 +4.7%p** | **27** |
//
//   **상위 80에서만 통했다**는 것이 유일한 단서다. 그리고 그 차이는 계열이 아니라
//   **분위**일 수 있다 — 상위 20에서 "상위 5"는 이미 상위 25%라 학계 표준(상위 10%)
//   모멘텀보다 신호가 훨씬 묽고, 80종목이면 상위 8 = 상위 10%로 분위가 정합해진다.
//
//   → 그렇다면 **다른 계열도 분위를 맞추면 살아나는가?** 이것이 이 회차의 질문이다.
//     `MODE=quantile`은 다섯 계열(모멘텀·저변동성·52주 신고가 근접도·거래량 급증·
//     단기 반전)을 **전부 같은 분위(상위 X%)로 맞춰** 돌린다. "상위 N"이 아니라
//     "상위 X%"로 슬롯을 정하는 것이 이 모드의 요점이다.
//
//   ⚠️ **성적을 만들어내려고 만든 파일이 아니다.** 관문을 통과한 변형이 0개면 0개로
//      보고하고 끝낸다. "가장 덜 나쁜 변형"을 승격시키는 경로는 코드에 아예 없다.
//      국장에서 오늘 하루에 세 회차가 0으로 끝났고 그것이 정직한 결과였다.
//
// ── ⚠️⚠️ [추정] 유니버스 — 이 회차 수치 전체에 붙는 경고 ──────────────────────
//   `src/features/backtest/usPitUniverse.ts`는 스스로 밝힌다 — **공식 PIT 랭킹
//   소스가 아니다.** 각 해 시총 상위 목록을 모델 지식으로 재구성한 것이고
//   CRSP·Compustat 같은 시점 고정 랭킹 DB로 대조하지 않았다. 21~80위 구간은 상위 20
//   보다 신뢰도가 한 단계 더 낮다.
//
//   국장에서 **같은 결함이 실제로 성적을 무너뜨렸다** — 33차에서 [추정] 목록을 KRX
//   실측으로 바꾸자 알파가 +21.9%p → +2.6%p로 내려앉았다. 즉 이 회차의 수치는
//   "목록이 맞다면"이라는 가정 위에 있다.
//   2026-08-04: 실측 목록 경로가 붙었다 — **`US_UNIVERSE=real`** 이면 커밋된
//   `public/data/us-pit/universe.json`(Wikipedia 되감기 + 신뢰구간 게이트)으로 돈다.
//   연도·전후반 경계도 그 파일의 `reliableFrom`이 정한다. 기본값은 여전히 `80`이다 —
//   실측 목록은 **지수 구성종목**이라 시총 상위 N [추정]과 **의미가 달라** 옛 수치와
//   직접 비교하면 거짓이기 때문이다(새 기준선으로 읽어야 한다).
//
// ── 🚫 규칙 1(미래참조 금지) — 이 파일에서 지킨 것 ────────────────────────────
//   1. 모든 랭킹 점수는 **리밸런스 달 1일 미만**(strictly before) 확정 봉으로만 만든다.
//      리밸런스일 D는 그 달의 첫 거래일이므로 `date < shiftMonthStart(D, 0)`으로 자르면
//      직전 달 마지막 확정 종가까지만 남는다 — 당일 봉은 물론 그 달 어떤 봉도 못 들어온다.
//      52주 최고가·변동성·거래대금 창이 **전부 이 경계를 공유**한다(idea-lab MODE=screen 규약).
//   2. 롤링 극값(52주 최고가)은 위 경계 때문에 **당일을 구조적으로 제외**한다(규칙 1-3).
//   3. 체결은 리밸런스일 **시가**다. 그날 종가·고가·저가는 판정에 쓰지 않는다.
//   4. 연도별 입력 봉을 `date <= 구간끝`으로 **잘라서** 넘긴다 — 뒤 연도를 통째로 잘라내도
//      앞 연도의 체결·자산곡선이 완전히 같아야 한다.
//   5. **마지막 봉 신규 진입 금지**(규칙 1-6) — 시뮬 구간의 마지막 봉에서는 신규 매수를
//      만들지 않는다(매도는 허용).
//   6. **전 구간 통계 금지**(규칙 1-5) — 격자 전체 성적으로 임계값을 정하지 않는다.
//      고원 점수·PBO·DSR·워크포워드는 **이미 확정된 수익률 계열의 사후 채점**이며
//      신호·진입·청산·사이징으로 **되먹임되지 않는다**. 채점표이지 신호가 아니다.
//      (분위 슬롯 `round(후보수 × pct)`의 후보수도 그 시점 단면에서만 나온다.)
//   집행자는 `tests/uslab.test.ts`의 **절단 불변성 + 미래 조작 불변성** 테스트다.
//
// ── 시세 소스 2종 (2026-08-04 추가) ──────────────────────────────────────────
//   `US_PRICE_SOURCE=yahoo|tiingo` — 기본 **yahoo**(41차 수치와의 연속성).
//   야후의 문제는 값이 틀린 게 아니라 **죽은 종목을 안 주는 것**이다(41차 2000년 매핑률
//   56/80 · 실패 6건 중 5건이 상폐사). 2026-08-04 소스 실사에서 **tiingo만 상폐를 줬다**
//   (상폐 8종 중 회사일치 3 · 대조군 4/4). 호출·파싱·보정 감사는 `scripts/lib/tiingo.ts`가
//   정본이고 소스 실사 프로브와 **같은 코드**를 지난다(복붙 금지).
//
//   🚫 **조용한 폴백 없음.** 한 실행은 유니버스·벤치·벽을 전부 같은 소스로 받는다.
//      tiingo가 실패한 종목을 야후로 메우지 않는다 — 실패는 실패로 세고 매핑률에 드러난다.
//      종목별 출처는 `PriceTally.sourceOf`에 기록되어 결과에 한 줄로 찍힌다.
//   ⚠️ **가장 큰 함정은 배당 기준이다.** tiingo `adj*`가 분할만 반영한다면 전략은 가격수익,
//      벤치·벽은 총수익이 되어 40차에서 제거한 배당 비대칭이 되살아난다. 문서를 믿지 않고
//      벤치(SPY)의 **실제 응답**으로 판정하며(`auditTiingoAdjustment`), 미반영·판정불가면
//      실행을 **중단**한다(판정불가는 `US_TIINGO_ALLOW_UNVERIFIED=1`로만 명시 통과).
//
// ── 규칙 4(외부 API) — 야후 호출 규약 ────────────────────────────────────────
//   야후 경로(기본)는 KRX Open API 밖이라 **비공식 v8 chart**를 쓴다.
//     · 인증: 없음(공개 엔드포인트). 별도 이용신청·승인 절차 없음.
//     · 한도: 공식 문서 없음 → **[미검증]**. 호출 사이 120ms를 둔다.
//     · 필드/단위: `indicators.quote[0].{open,high,low,close,volume}` + `adjclose`.
//       OHLC는 분할만 반영 → `adjclose ÷ close` 계수를 곱해 **총수익**으로 변환(규칙 3).
//     · 범위: `period1`로 지정. `range=max`가 월봉을 주는 조합이 있어 쓰지 않는다(기존 사고).
//     · 실패 표현: HTTP 오류 + **200 본문 안의 `chart.error`** + 빈 `result` — 셋 다 던진다.
//   **성공 카운터**를 두고 (a) 벤치(SPY)가 실패하면 즉시 비정상 종료 (b) 야후 호출이
//   전량 실패하면 비정상 종료한다. 조용한 폴백·직전값 승계는 없다.
//   상폐 티커의 404는 **정상적인 결과**이며 매핑 실패로 계수돼 연도별 매핑률에 드러난다.
//   티커 재사용 차단(`US_BLOCKED_TICKERS`)은 정본 규약을 그대로 쓴다 — 상폐 대형주 자리에
//   엉뚱한 소형주 시계열이 들어오면 백테스트가 조용히 오염되기 때문이다.
//
// ── 배당 기준 (2026-08-03 국장에서 고친 항목이 미장에는 어떻게 적용되나) ──────
//   국장은 전략이 KRX 정본(**가격수익**)인데 벤치만 야후(**총수익**)라 알파가 전략에
//   불리하게 편향돼 있었고, 40차에서 그 비대칭을 제거했다.
//   **미장은 전략도 벤치도 벽도 전부 야후 `adjclose` 총수익이라 이 비대칭이 애초에 없다.**
//   그래서 `compareBasisFor('yahoo') === 'total'` 한 곳에서 기준이 정해지고, 전략·벤치·벽이
//   같은 로더를 지난다. 이 사실은 모든 실행에서 한 줄로 출력된다.
//   (참고 구현: `scripts/idea-lab.entry.ts`의 `ReturnBasis`·`compareBasisFor` — 러너끼리
//    import하지 않는 규약이라 같은 이름·같은 의미로 여기에 자립 구현했다.)
//
// ── 파일 경계 (2026-08-03 총괄 배정) ─────────────────────────────────────────
//   신규 생성만: `scripts/us-lab.entry.ts` · `scripts/us-lab.mjs` · `tests/uslab.test.ts`.
//   수정 허용: `.github/workflows/backtest.yml`(us: 접두 라우팅 한 줄).
//   읽기 전용: `src/features/backtest/**`(특히 `usPitUniverse.ts` — 다른 워커가 수정 중이라
//   **한 글자도 건드리지 않는다**) · `scripts/idea-lab.entry.ts` · `scripts/plateau-lab.entry.ts`.
//   **다른 러너에서 import하지 않는다** — 랭킹·체결·비용·판정 프레임은 그 파일들의 정본을
//   읽고 **같은 규약으로 여기에 자립 구현**했다(러너들이 이미 그 구조다).
//   과최적화 채점(`overfit.ts`)·유니버스(`usPitUniverse.ts`)는 지시대로 **기존 정본을
//   그대로 쓴다**(다시 구현하지 않는다).
//
// ── 실행 ─────────────────────────────────────────────────────────────────────
//   GHA `Backtest (GHA runner)` 워크플로 · mode 입력값:
//     us:xsmom     27차 승자 재현 + 모멘텀 분위 민감도 (야후 필요)
//     us:quantile  다섯 계열 분위 정합 검증 (야후 필요)
//     us:all       위 전부 + 종합 판정 (야후 필요)
//     us:quick     축소 격자 스모크런 (야후 필요)
//     us:selftest  합성 데이터 자기검증 (네트워크 불필요)
//   환경변수: `US_UNIVERSE`(80 기본 · 20) · `US_PBO_MAX_COMBOS` · `US_FETCH_DELAY_MS`
//             `US_PRICE_SOURCE`(yahoo 기본 · tiingo — tiingo는 `TIINGO_API_KEY` 필요)
//             `US_TIINGO_ALLOW_UNVERIFIED=1`(보정 기준 판정불가일 때만 명시 통과)

import type { CostSettings } from '../src/features/backtest/conditionScreen'
import type { DailyBar } from '../src/features/backtest/types'
// 시세 소스 2번째 경로 — 호출·파싱·보정 감사는 공용 모듈이 정본이다(소스 실사 프로브와 공유).
import {
  TIINGO_UNVERIFIED,
  checkTickerReuseGap,
  fetchTiingoDaily,
  loadTiingoKey,
  tiingoBarsToDaily,
  type TiingoAdjAudit,
} from './lib/tiingo'
import {
  DSR_PASS_THRESHOLD,
  PBO_WARN_THRESHOLD,
  computePbo,
  deflatedSharpeFromReturns,
  multipleTestingReport,
  sharpeMetric,
  sharpeMoments,
  variance,
  walkForwardScore,
  type PboResult,
  type WalkForwardResult,
} from '../src/features/backtest/overfit'
import {
  US_COMPANY_NAMES,
  US_PIT80_SOURCE_NOTE,
  US_PIT80_UNION,
  US_PIT_REAL_LOAD_FAIL,
  US_PIT_REAL_PATH,
  US_PIT_SOURCE_NOTE,
  US_PIT_UNION,
  US_PIT_YEARS,
  deriveUsRealUniverse,
  parseUsPitRealUniverse,
  resolveUsTicker,
  usPit80Codes,
  usPitCodes,
  type UsPitRealUniverse,
} from '../src/features/backtest/usPitUniverse'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export function log(msg: string): void {
  console.log(msg)
}

// ============================================================================
// 0. 상수 — 24·26·27차와 **같은 값**이어야 표가 나란히 읽힌다
// ============================================================================

/**
 * 비용 전제. idea-lab `COST_US`(= spec-backtest `COST_US`)와 같은 값이다 —
 * 미국은 매도 거래세가 없다(KR 0.15% → 0). 수수료 0.1%는 국내 증권사 해외주식 [추정].
 * 값이 갈리면 26·27차 표와 나란히 못 읽으므로 `tests/uslab.test.ts`가 대조한다.
 */
export const COST_US: CostSettings = { initialCapital: 10_000_000, feePct: 0.1, taxPct: 0, slippagePct: 0.1 }

/** 알파 판정 벤치(규칙 5). idea-lab `BENCH_US`와 같은 값. */
export const BENCH_US = 'SPY'
/** 참고 벽 — 판정 벤치가 **아니다**. 미장 전략이 넘어야 할 "그냥 나스닥100 들고 있기". */
export const WALL_QQQ = 'QQQ'

/**
 * 시세 수집 시작일. 2000년 1월 리밸런스에 12-1 모멘텀·52주 창이 이미 채워지려면
 * 최소 1년 앞선 봉이 필요하다. idea-lab `loadUsPitHistories`와 같은 값.
 */
export const US_RANGE = 'since:1999-01-01'

/**
 * 전·후반 경계 연도 — **2014 고정**이다(idea-lab `HALF_YEAR`).
 * 동적으로 계산하면(2000~2026의 중간점 = 2013) 24·26·27차 표와 분할선이 달라져
 * "전반 알파"라는 말이 같은 것을 가리키지 않게 된다. 재현이 목적이라 값을 박는다.
 * (합성 자기검증은 연도 구간이 달라 `halfYearOf`로 계산한다.)
 */
export const US_HALF_YEAR = 2014

/** 표본 소실 판정선 — idea-lab `SCREEN_MIN_TRADES`와 같은 값. */
export const US_MIN_TRADES = 20

/** 고원 판정 임계 — 39차와 같은 값(지시로 고정). 이 값 이하면 "이웃도 같이 좋다". */
export const US_DROP_THRESHOLD = 0.3

/** 그 해 매핑 종목이 이 수 미만이면 표본이 작아 몇 종목 운에 좌우된다 → 현금 보유. */
export const MIN_SYMBOLS = 5

/**
 * 구간 끝 청산비용 근사 [추정]. **켠다** — idea-lab `runCustomChain`이 해마다 물리는
 * 비용이고(26·27차 수치가 그 기준), 끄면 이 러너만 비용을 면제받아 성적이 낙관적으로
 * 나온다. 방향이 보수적(성적을 낮춤)이다.
 */
export const APPLY_LIQUIDATION_HAIRCUT = true

/**
 * 누적 시도 수 = **DSR의 진짜 분모**.
 *
 * ⚠️ **국장 누적(97 + …)과 섞지 않는다.** 다른 데이터셋·다른 유니버스라 선택편의가
 *    같은 표본 위에 쌓이지 않는다. 미장은 미장끼리만 센다 — 그 사실을 출력에 명시한다.
 */
export const US_TRIALS_PRIOR: readonly { round: string; n: number }[] = [
  { round: '24차 (uspit 추세돌파 격자 · US PIT 20)', n: 36 },
  { round: '26차 (usxsmom 횡단면 모멘텀 · US PIT 20)', n: 6 },
  { round: '27차 (usxsmom80 횡단면 모멘텀 · US PIT 80)', n: 8 },
]
export const US_TRIALS_PRIOR_TOTAL = US_TRIALS_PRIOR.reduce((s, r) => s + r.n, 0)

/** PBO 블록 수 S. overfit.ts 기본값과 같은 16(짝수·논문 권장 범위). */
export const US_PBO_BLOCKS = 16
/** 워크포워드 창(거래일). IS 3년 · OOS 1년 — 27년 표본에서 20구간 남짓 나온다. */
export const US_WF_IS_DAYS = 756
export const US_WF_OOS_DAYS = 252
/** 일별 수익률의 연환산 계수(미국 주식 거래일 근사). */
export const US_PERIODS_PER_YEAR = 252

/**
 * PBO 조합 상한 — **변형 수에 반비례**해 자동으로 좁힌다(39차와 같은 식).
 * PBO(CSCV) 비용은 `변형수 × 조합수 × 관측수`다. overfit.ts는 상한을 넘으면 난수가
 * 아니라 **사전식 등간격 결정적 샘플링**으로 내려가므로 재현성이 유지된다.
 */
export function pboMaxCombinations(variants: number, budget = 1_000_000): number {
  if (!(variants > 0)) return 1
  return Math.max(200, Math.min(20_000, Math.floor(budget / variants)))
}

/**
 * 27차(usxsmom80) 실측 요약 — **재현 대조의 기준값**이다.
 * 재현이 안 되면 그 사실 자체가 중요한 발견이므로 크게 보고한다(성적을 맞추려고
 * 파라미터를 흔들지 않는다).
 */
export const USXSMOM80_PRIOR = {
  round: 27,
  variants: 8,
  /** 전 구간 알파가 양수였던 변형 수 */
  positiveAlphaFull: 8,
  /** 학계 분위(상위 10% = 80×10%)와 정합한 승자 */
  bestLabel: '상위8 + 절대모멘텀 게이트',
  bestSlots: 8,
  bestGate: true,
  bestAlphaFullPp: 4.7,
} as const

/** 재현 판정 허용 오차(%p). 이 밖이면 **재현 실패**로 크게 찍는다. */
export const REPRO_TOLERANCE_PP = 0.5

// ============================================================================
// 1. 유니버스 어댑터 — 실측 목록 교체는 **여기 한 줄**
// ============================================================================
//
// 지금 붙어 있는 두 목록은 **둘 다 [추정]**이다. 다른 워커가 만들고 있는 실측 목록이
// 들어오면 아래 표에 한 줄 추가하고 `US_UNIVERSE_KEY` 기본값만 바꾸면 러너 전체가
// 그 목록으로 돈다(`estimated: false`로 두면 [추정] 경고 문구도 자동으로 바뀐다).
// 러너 어디에도 유니버스 목록을 하드코딩하지 않는다.

export interface UsUniverse {
  key: string
  /** 그 해 목록의 종목 수(로그·소요시간 추정용 명목값). 랭킹 슬롯은 그 시점 후보 수로 계산한다. */
  size: number
  label: string
  codesFor: (y: number) => string[]
  /** 시세를 한 번만 받기 위한 조회용 합집합. */
  union: string[]
  sourceNote: string
  /** **[추정] 목록인가.** 실측 목록이 들어오면 false로 둔다 — 경고 문구가 바뀐다. */
  estimated: boolean
  /** 실행 연도. [추정] 목록은 `US_PIT_YEARS` 고정, 실측 목록은 신뢰구간이 정한다. */
  years: readonly number[]
  /** 전·후반 경계 연도. [추정] 목록은 24·26·27차와 맞추려고 2014 고정이다. */
  halfYear: number
}

export const US_UNI20: UsUniverse = {
  key: '20',
  size: 20,
  label: 'US PIT 20',
  codesFor: usPitCodes,
  union: US_PIT_UNION,
  sourceNote: US_PIT_SOURCE_NOTE,
  estimated: true,
  years: US_PIT_YEARS,
  halfYear: US_HALF_YEAR,
}
export const US_UNI80: UsUniverse = {
  key: '80',
  size: 80,
  label: 'US PIT 80',
  codesFor: usPit80Codes,
  union: US_PIT80_UNION,
  sourceNote: US_PIT80_SOURCE_NOTE,
  estimated: true,
  years: US_PIT_YEARS,
  halfYear: US_HALF_YEAR,
}

/**
 * **실측 유니버스 키.** `US_UNIVERSE=real` 로만 켜진다 — 기본값으로 두지 않는 이유는
 * 41차 수치와의 연속성 때문이고, 그보다 중요하게는 **의미가 다르기 때문**이다:
 * 실측 목록은 **지수 구성종목**(위원회 선정)이고 US_PIT20/80은 **시총 상위 N [추정]**이다.
 * 두 수치를 "좋아졌다/나빠졌다"로 나란히 읽으면 거짓이다 — **새 기준선**으로 읽어야 한다.
 */
export const US_UNIVERSE_REAL_KEY = 'real'

/** 파싱된 실측 유니버스 → 러너 어댑터. 연도·경계도 **데이터가 정한다**(사람이 적지 않는다). */
export function realUniverseFrom(u: UsPitRealUniverse): UsUniverse {
  const d = deriveUsRealUniverse(u)
  const sizes = d.years.map((y) => d.codesFor(y).length)
  const median = [...sizes].sort((a, b) => a - b)[Math.floor(sizes.length / 2)] ?? 0
  return {
    key: US_UNIVERSE_REAL_KEY,
    size: median,
    label: d.label,
    codesFor: d.codesFor,
    union: d.union,
    sourceNote: d.sourceNote,
    estimated: false,
    years: d.years,
    halfYear: halfYearOf(d.years),
  }
}

/**
 * 커밋된 실측 파일을 읽는다. **없으면 [추정] 목록으로 조용히 내려가지 않고 던진다** —
 * 국장 33차가 무너진 경로가 "틀린 목록 위에서 조용히 계속 도는 것"이었다.
 */
export function loadRealUniverseFromDisk(root = process.env.REPO_ROOT ?? process.cwd()): UsUniverse {
  const path = join(root, US_PIT_REAL_PATH)
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (e) {
    throw new Error(`${US_PIT_REAL_LOAD_FAIL} (파일을 읽지 못했다: ${path} · ${String(e)})`)
  }
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch (e) {
    throw new Error(`${US_PIT_REAL_LOAD_FAIL} (JSON 파싱 실패: ${path} · ${String(e)})`)
  }
  return realUniverseFrom(parseUsPitRealUniverse(json))
}

export const US_UNIVERSES: readonly UsUniverse[] = [US_UNI80, US_UNI20]

/** 기본 유니버스 — 27차가 알파를 낸 유일한 표본이 상위 80이라 그것을 기본으로 둔다. */
export const US_UNIVERSE_KEY_DEFAULT = '80'

export function pickUniverse(key: string | undefined, loadReal: () => UsUniverse = loadRealUniverseFromDisk): UsUniverse {
  const k = (key ?? US_UNIVERSE_KEY_DEFAULT).trim()
  if (k === US_UNIVERSE_REAL_KEY) return loadReal()
  const hit = US_UNIVERSES.find((u) => u.key === k)
  if (!hit)
    throw new Error(
      `알 수 없는 US_UNIVERSE=${k} — 가능한 값: ${[...US_UNIVERSES.map((u) => u.key), US_UNIVERSE_REAL_KEY].join(' | ')}. ` +
        '조용히 기본값으로 넘어가지 않는다(어느 목록으로 돌았는지가 결과 해석의 전제라서).',
    )
  return hit
}

/** 모든 표 **위에** 박는 경고 한 줄(규칙 3). 표를 찍는 함수가 반드시 먼저 부른다. */
export function estimateBanner(uni: UsUniverse): string {
  return uni.estimated
    ? `⚠️ **[추정] 유니버스(${uni.label})** — 공식 PIT 랭킹 소스가 아니다. 목록이 틀리면 아래 수치도 틀린다. ` +
        '국장에서 같은 결함이 33차에 알파를 +21.9%p → +2.6%p로 무너뜨렸다.'
    : `✅ **실측 유니버스(${uni.label})** — 시점 고정 랭킹 실측 목록으로 돌았다.`
}

// ============================================================================
// 2. 비교 기준(배당) — 미장은 전략·벤치가 이미 같은 기준이다
// ============================================================================

/**
 * 수익 기준 — 배당을 넣느냐 빼느냐.
 *   `total` = 총수익(배당 재투자). 야후 `adjclose ÷ close` 계수를 OHLC에 곱한다.
 *   `price` = 가격수익(배당 제외). 계수를 곱하지 않는다.
 *
 * 정본 규약은 `scripts/idea-lab.entry.ts`(2026-08-03)가 갖는다. 여기서는 **같은 이름·
 * 같은 의미**로 자립 구현한다(러너끼리 import하지 않는 규약).
 */
export type ReturnBasis = 'total' | 'price'

/**
 * 시세 소스.
 *   · `yahoo`  — 41차까지 쓴 기본값. **죽은 종목을 주지 않는다**(생존편향의 원천).
 *   · `tiingo` — 2026-08-04 실사에서 **상폐를 주는 유일한 무료 소스**로 확인됐다
 *     (상폐 8종 중 회사일치 3 · 대조군 4/4 · MER은 야후가 껍데기 1봉, tiingo가 진짜 506봉).
 *
 * ⚠️ **소스를 섞지 않는다.** 한 실행은 유니버스·벤치·벽을 **전부 같은 소스**로 받는다.
 *   tiingo가 실패한 종목을 야후로 슬쩍 메우면 (a) 그 종목만 보정 기준이 달라지고
 *   (b) "상폐 커버리지가 얼마나 메워졌나"를 잴 수 없게 된다. 실패는 실패로 센다.
 */
export type UsPriceSource = 'yahoo' | 'tiingo'
export const US_PRICE_SOURCES: readonly UsPriceSource[] = ['yahoo', 'tiingo'] as const

/**
 * 기본값은 **yahoo**다 — 41차 수치와의 연속성을 기본으로 두고, 소스 교체는 **명시적으로만**
 * 하게 한다(어느 소스로 돌았는지가 결과 해석의 전제라서 조용히 바뀌면 안 된다).
 */
export function pickPriceSource(raw = process.env.US_PRICE_SOURCE): UsPriceSource {
  const s = (raw ?? 'yahoo').trim().toLowerCase()
  const hit = US_PRICE_SOURCES.find((x) => x === s)
  if (!hit)
    throw new Error(
      `알 수 없는 US_PRICE_SOURCE=${s} — 가능한 값: ${US_PRICE_SOURCES.join(' | ')}. ` +
        '조용히 기본값으로 넘어가지 않는다(어느 소스로 돌았는지가 결과 해석의 전제라서).',
    )
  return hit
}

/**
 * 시세 소스에 맞는 비교 기준. **전략·벤치·벽이 한 소스·한 기준을 지난다** —
 * 국장 40차 사고의 원인이 벤치와 벽이 각자 다른 기준으로 로드된 것이었다.
 *
 * 둘 다 `total`인데, 그 근거가 소스마다 다르다:
 *   · yahoo  — `adjclose ÷ close` 계수를 OHLC에 곱한다(규칙 3의 정본 규약).
 *   · tiingo — `adjClose ÷ close` 계수를 **같은 식으로** 곱한다. 다만 tiingo의 `adj*`가
 *     배당까지 반영하는지는 **문서로 확정하지 못했으므로**(규칙 4) 실행 중
 *     `auditTiingoAdjustment`가 **실제 응답의 배당락 계수 변화로** 판정하고,
 *     'price'(배당 미반영)로 나오면 **실행을 중단한다**. 여기가 이 소스 교체의 가장 큰
 *     함정이다 — 기준이 어긋나면 40차에서 제거한 배당 비대칭이 그대로 되살아난다.
 */
export function compareBasisFor(source: UsPriceSource): ReturnBasis {
  return source === 'yahoo' ? 'total' : 'total'
}

export function compareBasisNote(b: ReturnBasis, source: UsPriceSource = 'yahoo'): string {
  if (b !== 'total') return '⚖️ 비교 기준: **가격수익**(배당 제외) — 전략과 벤치를 같은 기준으로 맞췄다.'
  const src =
    source === 'yahoo'
      ? '**전부 야후 `adjclose` 기준**'
      : '**전부 tiingo `adjClose` 기준**(계수 변환식은 야후와 동일 · 배당 반영 여부는 실행 중 실측 감사로 확정)'
  return (
    `⚖️ 비교 기준: **총수익**(배당 재투자) — 전략·벤치(SPY)·벽(QQQ)이 ${src}이라 ` +
    '**한 실행 안에서 기준이 일치한다.** 2026-08-03 국장(40차)에서 제거한 배당 비대칭(전략=가격수익 vs ' +
    '벤치=총수익)이 여기에는 없다 — 알파가 어느 쪽으로도 기울지 않는다. ' +
    '남는 것은 **미국 배당세(원천징수 15%) 미반영**이며 그 방향은 성적을 후하게 만든다.'
  )
}

// ============================================================================
// 3. 격자 — 축은 오름차순 숫자만(이웃 ±1 스텝 정의가 순서에 의존한다)
// ============================================================================

/**
 * 축 키. 값은 **전부 오름차순 숫자**여야 한다 — 이웃(±1 스텝) 정의가 순서에 의존한다.
 *   · `slots` 절대 슬롯 수(27차 재현용)   · `pct` 분위(%) — 슬롯 = round(후보수 × pct/100)
 *   · `gate` 계열 게이트 0/1              · `rebalMonths` 리밸런스 주기(개월)
 */
export const AXIS_KEYS = ['slots', 'pct', 'gate', 'rebalMonths'] as const
export type AxisKey = (typeof AXIS_KEYS)[number]

export interface AxisDef {
  key: AxisKey
  label: string
  /** 오름차순 고정 */
  values: number[]
  unit: string
}

export type FactorKind = 'mom' | 'lowvol' | 'hi52' | 'volrank' | 'strev'

/** 슬롯 결정 방식 — **이 회차의 핵심 축**이다. */
export type Sizing =
  | { kind: 'fixed'; n: number }
  /** 상위 `pct`% — 슬롯 수 = clamp(round(후보수 × pct/100), 1, 후보수) */
  | { kind: 'quantile'; pct: number }

export interface UsParams {
  factor: FactorKind
  /** mom 전용 — 모멘텀 관측 개월(12-1의 12) */
  lookback: number
  /** mom 전용 — 최근 제외 개월(12-1의 1) */
  skip: number
  sizing: Sizing
  /** 계열 게이트 ON/OFF. 게이트 정의는 계열마다 다르다(§4 `FACTORS`). */
  gate: boolean
  /** 리밸런스 주기(개월). 1이면 매월, 3이면 1·4·7·10월. */
  rebalMonths: number
}

export const sizingLabel = (s: Sizing): string =>
  s.kind === 'fixed' ? `상위${s.n}` : `상위${s.pct}%`

export const cellKey = (p: UsParams): string =>
  `${p.factor}-${p.sizing.kind === 'fixed' ? `N${p.sizing.n}` : `Q${p.sizing.pct}`}` +
  `-${p.gate ? 'G1' : 'G0'}-R${p.rebalMonths}${p.factor === 'mom' ? `-L${p.lookback}S${p.skip}` : ''}`

export interface GridCell {
  /** 이 격자 안에서의 평탄 인덱스(사전식) */
  index: number
  /** 축별 값 인덱스(격자 좌표) */
  coords: number[]
  params: UsParams
  key: string
  /** 전체 실행에서의 통합 인덱스 — 여러 격자를 한 판에 돌리므로 필요하다 */
  globalIndex: number
}

export interface LabGrid {
  id: string
  label: string
  /** 왜 이 격자를 돌리는가 — 보고서와 코드가 같은 문장을 쓰게 강제한다. */
  question: string
  base: UsParams
  axes: AxisDef[]
}

/** 축 검증 — 오름차순인지, 값이 중복되지 않는지, 축 키가 중복되지 않는지. */
export function validateGrid(grid: LabGrid): void {
  if (grid.axes.length === 0) throw new Error(`격자 ${grid.id}에 축이 없다`)
  const seen = new Set<AxisKey>()
  for (const ax of grid.axes) {
    if (seen.has(ax.key)) throw new Error(`격자 ${grid.id}: 축 ${ax.key}가 중복이다`)
    seen.add(ax.key)
    if (ax.values.length === 0) throw new Error(`격자 ${grid.id}: 축 ${ax.key}에 값이 없다`)
    for (let i = 1; i < ax.values.length; i++)
      if (!(ax.values[i] > ax.values[i - 1]))
        throw new Error(
          `격자 ${grid.id}: 축 ${ax.key}가 오름차순이 아니다 (${ax.values.join(',')}) — 이웃 정의가 깨진다`,
        )
  }
  if (seen.has('slots') && seen.has('pct'))
    throw new Error(`격자 ${grid.id}: slots와 pct를 동시에 축으로 두면 슬롯 정의가 두 개가 된다`)
}

/** 축 값 하나를 파라미터에 얹는다. 여기 없는 축 키는 컴파일 시점에 막힌다. */
export function applyAxis(p: UsParams, key: AxisKey, v: number): UsParams {
  switch (key) {
    case 'slots':
      return { ...p, sizing: { kind: 'fixed', n: v } }
    case 'pct':
      return { ...p, sizing: { kind: 'quantile', pct: v } }
    case 'gate':
      return { ...p, gate: v > 0 }
    case 'rebalMonths':
      return { ...p, rebalMonths: v }
  }
}

/**
 * 격자를 전개한다. **사전식(마지막 축이 가장 빨리 도는) 순서 고정** — 순서가 바뀌면
 * 이웃 인덱스 산술과 출력 표가 통째로 어긋난다.
 */
export function enumerateGrid(grid: LabGrid, globalOffset = 0): GridCell[] {
  validateGrid(grid)
  const sizes = grid.axes.map((a) => a.values.length)
  const total = sizes.reduce((s, n) => s * n, 1)
  const cells: GridCell[] = []
  for (let i = 0; i < total; i++) {
    const coords: number[] = new Array(sizes.length)
    let rest = i
    for (let a = sizes.length - 1; a >= 0; a--) {
      coords[a] = rest % sizes[a]
      rest = Math.floor(rest / sizes[a])
    }
    let params = grid.base
    for (let a = 0; a < grid.axes.length; a++) params = applyAxis(params, grid.axes[a].key, grid.axes[a].values[coords[a]])
    if (params.factor === 'mom' && !(params.lookback > params.skip))
      throw new Error(
        `격자 ${grid.id}: lookback(${params.lookback}) <= skip(${params.skip}) — 관측 창이 비어 랭킹이 성립하지 않는다`,
      )
    if (params.sizing.kind === 'quantile' && !(params.sizing.pct > 0 && params.sizing.pct <= 100))
      throw new Error(`격자 ${grid.id}: 분위 ${params.sizing.pct}%는 (0, 100] 밖이다`)
    cells.push({ index: i, coords, params, key: cellKey(params), globalIndex: globalOffset + i })
  }
  return cells
}

/** 좌표 → 평탄 인덱스(사전식). 격자 밖이면 -1. */
export function flatIndex(coords: number[], sizes: number[]): number {
  let idx = 0
  for (let a = 0; a < sizes.length; a++) {
    if (coords[a] < 0 || coords[a] >= sizes[a]) return -1
    idx = idx * sizes[a] + coords[a]
  }
  return idx
}

export interface NeighborRef {
  index: number
  axis: AxisKey
  dir: -1 | 1
}

/**
 * 이웃 = **각 축에서 ±1 스텝, 대각선 제외**(39차와 같은 정의).
 * 격자 밖 방향은 두 가지로 나눠 돌려준다 — 뭉치면 원인을 못 읽는다:
 *   · `missing` — 값이 2개 이상인 축인데 셀이 그 축의 **끝**이라 한쪽을 못 본다(= 경계 셀).
 *   · `frozen`  — 축 자체가 값 1개로 고정돼 있어 흔들 것이 없다(설계상 고정).
 */
export function neighborsOf(
  cell: GridCell,
  grid: LabGrid,
): { found: NeighborRef[]; missing: string[]; frozen: AxisKey[] } {
  const sizes = grid.axes.map((a) => a.values.length)
  const found: NeighborRef[] = []
  const missing: string[] = []
  const frozen: AxisKey[] = []
  for (let a = 0; a < grid.axes.length; a++) {
    if (sizes[a] < 2) {
      frozen.push(grid.axes[a].key)
      continue
    }
    for (const dir of [-1, 1] as const) {
      const c = cell.coords.slice()
      c[a] += dir
      const idx = flatIndex(c, sizes)
      if (idx < 0) {
        missing.push(`${grid.axes[a].key}${dir > 0 ? '+' : '−'}`)
        continue
      }
      found.push({ index: idx, axis: grid.axes[a].key, dir })
    }
  }
  return { found, missing, frozen }
}

// ============================================================================
// 4. 랭킹 계열 — 창의 오른쪽 경계는 **리밸런스 달 1일**(규칙 1)
// ============================================================================
//
// 계열 정의는 idea-lab MODE=screen(`SCREEN_FAMILIES`)의 정본을 읽어 **같은 규약**으로
// 자립 구현했다. 게이트도 그 파일과 같다 — 계열마다 **그 계열의 보조값에 거는 자연스러운
// 임계 하나**뿐이다. 게이트를 계열마다 여러 개 달면 그 자체가 격자 탐색이 되고,
// 잡음으로 계열을 고르게 된다.

/** 랭킹 창 기본 길이(개월) — lowvol·hi52가 공유한다. 52주 ≈ 12개월. */
export const SCREEN_WINDOW_MONTHS = 12
/** 12개월 창이 실제로 채워졌다고 볼 최소 봉 수. 거래정지·희소 종목을 후보에서 뺀다. */
export const SCREEN_MIN_BARS = 120
/** volrank 단기·장기 창(거래일). */
export const VOLRANK_FAST = 5
export const VOLRANK_SLOW = 60
/** hi52 게이트 임계 — 52주 최고가 대비 10% 이내. */
export const HI52_GATE = 0.9
/** volrank 게이트 임계 — 5일 평균 거래대금이 60일 평균의 1.5배 이상. */
export const VOLRANK_GATE = 1.5

/** 'YYYY-MM-DD'에서 k개월 이동한 달의 1일 — 'YYYY-MM-01' */
export function shiftMonthStart(date: string, k: number): string {
  const y = Number(date.slice(0, 4))
  const m = Number(date.slice(5, 7))
  const t = y * 12 + (m - 1) + k
  const yy = Math.floor(t / 12)
  const mm = t - yy * 12 + 1
  return `${String(yy).padStart(4, '0')}-${String(mm).padStart(2, '0')}-01`
}

/** `date` **미만**(strictly before)인 봉의 개수 = 확정 구간의 오른쪽 경계 인덱스. 이분 탐색. */
export function idxBefore(bars: DailyBar[], date: string): number {
  let lo = 0
  let hi = bars.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (bars[mid].date < date) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** `date` **미만** 마지막 봉의 종가. 없으면 null. */
export function lastCloseBefore(bars: DailyBar[], date: string): number | null {
  const i = idxBefore(bars, date)
  return i > 0 ? bars[i - 1].c : null
}

/**
 * 랭킹 창 [months개월 전 달 1일, 리밸런스 달 1일)의 봉 구간 [lo, hi).
 * `lo === 0`(창 시작 이전 봉이 아예 없음)이면 이력이 부족한 종목이므로 null —
 * `momentumOf`가 관측 구간 시작 종가 없는 종목을 빼는 것과 같은 규약이다.
 */
export function monthWindow(
  bars: DailyBar[],
  date: string,
  months = SCREEN_WINDOW_MONTHS,
  minBars = SCREEN_MIN_BARS,
): { lo: number; hi: number } | null {
  const hi = idxBefore(bars, shiftMonthStart(date, 0))
  const lo = idxBefore(bars, shiftMonthStart(date, -months))
  if (lo === 0 || hi - lo < minBars) return null
  return { lo, hi }
}

/**
 * 일반화 모멘텀 `(lookback − skip)`. 12-1이면 lookback=12·skip=1.
 *   시작 = `lookback`개월 전 달 1일 **직전** 종가 · 끝 = `skip`개월 전 달 1일 **직전** 종가.
 * 두 기준일이 모두 `date`보다 과거라 미래참조가 원천적으로 불가능하다.
 */
export function momentumOf(bars: DailyBar[], date: string, lookback: number, skip: number): number | null {
  if (!(lookback > skip)) throw new Error(`lookback(${lookback})은 skip(${skip})보다 커야 한다`)
  const pe = lastCloseBefore(bars, shiftMonthStart(date, -skip))
  const ps = lastCloseBefore(bars, shiftMonthStart(date, -lookback))
  if (pe == null || ps == null || !(ps > 0)) return null
  return pe / ps - 1
}

/** 직전 12개월 **일수익률 표준편차**(모표준편차). 창 안의 연속 종가 쌍만 쓴다. */
export function lowVolStdev(bars: DailyBar[], date: string): number | null {
  const w = monthWindow(bars, date)
  if (!w) return null
  const rets: number[] = []
  for (let i = w.lo + 1; i < w.hi; i++) {
    const p0 = bars[i - 1].c
    const p1 = bars[i].c
    if (!(p0 > 0) || !(p1 > 0)) return null
    rets.push(p1 / p0 - 1)
  }
  if (rets.length < SCREEN_MIN_BARS - 1) return null
  let sum = 0
  for (const r of rets) sum += r
  const mean = sum / rets.length
  let ss = 0
  for (const r of rets) ss += (r - mean) * (r - mean)
  return Math.sqrt(ss / rets.length)
}

/**
 * 52주 신고가 근접도 = (창 오른쪽 끝 확정 종가) ÷ (창 안 최고 고가).
 * 최고가 창은 **당일은 물론 리밸런스 달 전체를 제외**한다(규칙 1-3).
 */
export function hi52Ratio(bars: DailyBar[], date: string): number | null {
  const w = monthWindow(bars, date)
  if (!w) return null
  const px = bars[w.hi - 1].c
  if (!(px > 0)) return null
  let peak = 0
  for (let i = w.lo; i < w.hi; i++) if (bars[i].h > peak) peak = bars[i].h
  if (!(peak > 0)) return null
  return px / peak
}

/**
 * 직전 1개월 수익률 = (직전 달 마지막 확정 종가) ÷ (그 전 달 마지막 확정 종가) − 1.
 * 단기 반전은 이 값이 **낮을수록** 상위이므로 랭킹 점수는 부호를 뒤집어 쓴다.
 */
export function shortRevReturn(bars: DailyBar[], date: string): number | null {
  const pe = lastCloseBefore(bars, shiftMonthStart(date, 0))
  const ps = lastCloseBefore(bars, shiftMonthStart(date, -1))
  if (pe == null || ps == null || !(ps > 0)) return null
  return pe / ps - 1
}

/**
 * 거래량 급증비 = 직전 `fast`일 평균 거래대금 ÷ 직전 `slow`일 평균 거래대금.
 * 두 창 모두 리밸런스 달 시작 이전 봉으로만 만든다 — 당일 거래대금은 장이 끝나야
 * 확정되므로 진입 판단에 넣으면 그 자체가 미래참조다.
 * 거래대금은 종가×거래량 근사다(체결가별 대금이 아니라 일봉 근사).
 */
export function volSurgeRatio(bars: DailyBar[], date: string, fast = VOLRANK_FAST, slow = VOLRANK_SLOW): number | null {
  const hi = idxBefore(bars, shiftMonthStart(date, 0))
  if (hi < slow || fast > slow || fast <= 0) return null
  let slowSum = 0
  for (let i = hi - slow; i < hi; i++) slowSum += bars[i].c * bars[i].v
  let fastSum = 0
  for (let i = hi - fast; i < hi; i++) fastSum += bars[i].c * bars[i].v
  const slowAvg = slowSum / slow
  if (!(slowAvg > 0)) return null
  return fastSum / fast / slowAvg
}

export interface RankRow {
  sym: string
  /** 랭킹 점수 — **클수록 상위**. 계열이 부호를 맞춰 넣는다. */
  score: number
  /** 게이트 판정용 보조 스칼라 — 랭킹 자체에는 관여하지 않는다. */
  aux: number
}

export interface FactorFamily {
  key: FactorKind
  name: string
  /** 계열 정의 한 줄 — 보고서와 코드가 **같은 문장**을 쓰게 강제한다. */
  def: string
  /** 왜 이 계열을 보는가(학계 근거) */
  basis: string
  /** 점수·보조값. 리밸런스 달 1일 **미만** 봉만 본다. */
  score: (bars: DailyBar[], date: string, p: UsParams) => { score: number; aux: number } | null
  gateLabel: string
  /** 상위 N을 뽑은 **뒤** 거르는 게이트. 걸러진 슬롯은 현금(다른 종목으로 메우지 않는다). */
  keep: (aux: number) => boolean
}

export const FACTORS: Record<FactorKind, FactorFamily> = {
  mom: {
    key: 'mom',
    name: '횡단면 모멘텀',
    def: '직전 `lookback`개월 ~ `skip`개월 수익률이 **높은** 상위 분위 동일가중 (기본 12-1)',
    basis: 'Jegadeesh–Titman 계열 12-1 모멘텀 — 27차에서 미장 상위 80에서만 알파를 냈다',
    score: (bars, date, p) => {
      const m = momentumOf(bars, date, p.lookback, p.skip)
      return m == null ? null : { score: m, aux: m }
    },
    gateLabel: '절대모멘텀 게이트(12-1 ≥ 0)',
    keep: (aux) => aux >= 0,
  },
  lowvol: {
    key: 'lowvol',
    name: '저변동성',
    def: '직전 12개월 일수익률 표준편차가 **낮은** 상위 분위 동일가중',
    basis: '저변동성 이상현상 — 위험이 낮은 쪽이 위험조정 후 더 벌었다는 학계 관측',
    score: (bars, date) => {
      const sd = lowVolStdev(bars, date)
      if (sd == null) return null
      const m = momentumOf(bars, date, 12, 1)
      return { score: -sd, aux: m ?? Number.NEGATIVE_INFINITY }
    },
    gateLabel: '절대모멘텀 게이트(12-1 ≥ 0)',
    keep: (aux) => aux >= 0,
  },
  hi52: {
    key: 'hi52',
    name: '52주 신고가 근접도',
    def: '직전 확정 종가 ÷ 직전 52주 최고가가 **높은** 상위 분위 동일가중',
    basis: 'George & Hwang(2004) — 52주 신고가 근접도가 모멘텀 수익의 상당 부분을 설명한다',
    score: (bars, date) => {
      const r = hi52Ratio(bars, date)
      return r == null ? null : { score: r, aux: r }
    },
    gateLabel: `근접도 ${HI52_GATE} 이상`,
    keep: (aux) => aux >= HI52_GATE,
  },
  volrank: {
    key: 'volrank',
    name: '거래량 급증',
    def: `직전 ${VOLRANK_FAST}일 평균 거래대금 ÷ 직전 ${VOLRANK_SLOW}일 평균 거래대금이 **높은** 상위 분위 동일가중`,
    basis: '거래량 급증이 정보 유입·관심 집중의 대리변수라는 관측(거래대금은 종가×거래량 근사)',
    score: (bars, date) => {
      const r = volSurgeRatio(bars, date)
      return r == null ? null : { score: r, aux: r }
    },
    gateLabel: `급증비 ${VOLRANK_GATE}배 이상`,
    keep: (aux) => aux >= VOLRANK_GATE,
  },
  strev: {
    key: 'strev',
    name: '단기(1개월) 반전',
    def: '직전 1개월 수익률이 **낮은**(가장 많이 빠진) 상위 분위 동일가중',
    basis: '단기 반전 — 12-1 모멘텀이 최근 1개월을 창에서 빼는 이유가 이 효과다',
    score: (bars, date) => {
      const r = shortRevReturn(bars, date)
      return r == null ? null : { score: -r, aux: r }
    },
    gateLabel: '실제 하락분만(직전 1개월 수익 ≤ 0)',
    keep: (aux) => aux <= 0,
  },
}

export const FACTOR_ORDER: readonly FactorKind[] = ['mom', 'lowvol', 'hi52', 'volrank', 'strev']

/**
 * 종목별 점수를 매겨 **score 내림차순 · 동점은 심볼 오름차순**(결정적 — 난수 없음)으로 세운다.
 * 점수를 못 내는 종목(창을 채울 데이터 없음)은 후보에서 뺀다.
 */
export function rankUniverse(
  histories: Record<string, DailyBar[]>,
  universe: readonly string[],
  date: string,
  p: UsParams,
): RankRow[] {
  const fam = FACTORS[p.factor]
  const rows: RankRow[] = []
  for (const s of universe) {
    const bars = histories[s]
    if (!bars?.length) continue
    const v = fam.score(bars, date, p)
    if (v == null) continue
    rows.push({ sym: s, score: v.score, aux: v.aux })
  }
  rows.sort((x, y) => (y.score !== x.score ? y.score - x.score : x.sym < y.sym ? -1 : x.sym > y.sym ? 1 : 0))
  return rows
}

/**
 * 슬롯 분모. 게이트와 무관하게 `min(N, 후보수)`로 고정한다 — 분모를 게이트와 같이 줄이면
 * 게이트가 남은 종목에 레버리지를 거는 셈이라 A/B 비교가 오염된다(정본 규약).
 *
 * **분위(quantile)일 때가 이 회차의 요점이다**: 슬롯 수를 "상위 N"이 아니라
 * `round(후보수 × pct/100)`으로 정해 계열이 달라도 **같은 분위**를 담게 만든다.
 * 후보수는 그 시점 단면에서만 나오므로 미래참조가 아니다(규칙 1-5).
 */
export function slotsFor(sizing: Sizing, candidates: number): number {
  if (candidates <= 0) return 1
  const want = sizing.kind === 'fixed' ? sizing.n : Math.round((candidates * sizing.pct) / 100)
  return Math.max(1, Math.min(want, candidates))
}

/**
 * 리밸런스 달인가 — `(월−1) % rebalMonths === 0`.
 * 달력만으로 결정되므로 **데이터 길이·시작일에 의존하지 않는다**(절단 불변성의 전제).
 */
export const isRebalanceMonth = (month: number, rebalMonths: number): boolean => (month - 1) % rebalMonths === 0

// ============================================================================
// 5. 장부 — idea-lab `bookBuy/bookSell/bookMark`와 동일 산술(자립 구현)
// ============================================================================

interface BookPos {
  qty: number
  /** 취득 총원가(체결가×수량 + 매수수수료). 부분매도 시 비례 차감. */
  basis: number
  realized: number
  /** 봉이 없는 날 평가에 쓰는 마지막 관측 종가 */
  lastClose: number
}

export interface Book {
  cash: number
  positions: Map<string, BookPos>
  closed: number
  wins: number
}

export const newBook = (cash: number): Book => ({ cash, positions: new Map(), closed: 0, wins: 0 })

/** 매수. `rawPx`는 슬리피지 **적용 전** 기준가이며 여기서 불리한 쪽으로 슬리피지를 얹는다. */
export function bookBuy(book: Book, cost: CostSettings, sym: string, rawPx: number, budget: number): number {
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
    book.positions.set(sym, { qty, basis: gross + fee, realized: 0, lastClose: rawPx })
  }
  return qty
}

/** 매도(부분 가능). 전량이 나가면 라운드트립 1건으로 세고 실현손익 부호로 승패를 가른다. */
export function bookSell(book: Book, cost: CostSettings, sym: string, rawPx: number, qty: number): number {
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
export function bookMark(book: Book, priceOf: (sym: string) => number | null): number {
  let mv = 0
  for (const [sym, p] of book.positions) {
    const px = priceOf(sym)
    if (px != null && px > 0) p.lastClose = px
    mv += p.qty * p.lastClose
  }
  return book.cash + mv
}

// ============================================================================
// 6. 연도 컨텍스트 · 한 해치 시뮬 — 리밸런스일 **시가** 체결
// ============================================================================

export type Curve = { date: string; equity: number }[]

/**
 * 연도 컨텍스트. **파라미터에 의존하지 않으므로 변형 루프 밖에서 한 번만 만든다**
 * (변형 수십 개 × 27년마다 봉 배열을 다시 자르면 그것만으로 분 단위가 나간다).
 */
export interface YearCtx {
  y: number
  start: string
  end: string
  /** 그 해 실제로 거래 가능한 심볼(연말 절단 후) */
  symbols: string[]
  /** `date <= end`로 잘린 봉 — 규칙 1의 절단과 같은 조작 */
  hist: Record<string, DailyBar[]>
  calendar: string[]
  idxOf: Record<string, Map<string, number>>
  /** 그 해 유니버스 코드 수(매핑률 분모) */
  totalCodes: number
}

/**
 * 연도별 유니버스·시계열 준비. 그 해 **6월 30일 이전에 상장돼 있던 종목만** 편입한다
 * (idea-lab `buildYearlyUs`·pitChain과 같은 규약 — "그때 이미 상장돼 있었나"만 보고
 * 이후 가격은 보지 않는다).
 */
export function buildYearCtxs(
  histories: Record<string, DailyBar[]>,
  years: readonly number[],
  codesFor: (y: number) => string[],
  resolve: (code: string) => string | undefined,
): YearCtx[] {
  const out: YearCtx[] = []
  for (const y of years) {
    const start = `${y}-01-01`
    const end = `${y}-12-31`
    const cutoff = `${y}-06-30`
    const codes = codesFor(y)
    const picked: string[] = []
    for (const code of codes) {
      const sym = resolve(code)
      if (!sym) continue
      const bars = histories[sym]
      if (!bars?.length) continue
      if (bars[0].date > cutoff) continue
      picked.push(sym)
    }
    const symbols0 = [...new Set(picked)].sort()
    const hist: Record<string, DailyBar[]> = {}
    for (const s of symbols0) {
      const cut = histories[s].filter((b) => b.date <= end)
      if (cut.length) hist[s] = cut
    }
    const symbols = symbols0.filter((s) => hist[s]?.some((b) => b.date >= start && b.date <= end))
    const dateSet = new Set<string>()
    for (const s of symbols) for (const b of hist[s]) dateSet.add(b.date)
    const calendar = [...dateSet].sort().filter((d) => d >= start)
    const idxOf: Record<string, Map<string, number>> = {}
    for (const s of symbols) {
      const m = new Map<string, number>()
      hist[s].forEach((b, i) => m.set(b.date, i))
      idxOf[s] = m
    }
    out.push({ y, start, end, symbols, hist, calendar, idxOf, totalCodes: codes.length })
  }
  return out
}

export interface YearRun {
  equity: Curve
  closed: number
  wins: number
  openAtEnd: number
  rebalances: number
  /** 그 해 리밸런스마다 실제로 쓴 슬롯 분모의 합(분위 슬롯이 몇 개였나를 드러낸다) */
  slotSum: number
}

/**
 * 한 해치 시뮬. 리밸런스 달의 **첫 거래일 시가**에 교체한다.
 *
 * 슬롯 분모는 게이트와 무관하게 고정한다(§4 `slotsFor` 주석). 게이트에 걸린 슬롯은
 * 다른 종목으로 메우지 않고 **현금**으로 둔다.
 */
export function simulateYear(ctx: YearCtx, cost: CostSettings, params: UsParams): YearRun {
  const book = newBook(cost.initialCapital)
  const equity: Curve = []
  const { calendar, symbols, hist, idxOf } = ctx
  const fam = FACTORS[params.factor]
  let curYm = ''
  let rebalances = 0
  let slotSum = 0
  const lastIdx = calendar.length - 1

  for (let d = 0; d < calendar.length; d++) {
    const date = calendar[d]
    const ym = date.slice(0, 7)
    if (ym !== curYm) {
      curYm = ym
      const month = Number(date.slice(5, 7))
      if (isRebalanceMonth(month, params.rebalMonths)) {
        rebalances++
        const openPx = new Map<string, number | null>()
        for (const s of symbols) {
          const bi = idxOf[s].get(date)
          openPx.set(s, bi != null ? hist[s][bi].o : null)
        }
        let eq = book.cash
        for (const [s, p] of book.positions) {
          const px = openPx.get(s)
          eq += p.qty * (px != null && px > 0 ? px : p.lastClose)
        }
        // 후보: 점수 산출 가능 + 오늘 실제로 거래되는 종목만(체결 불가 종목을 담지 않는다)
        const ranked = rankUniverse(hist, symbols, date, params).filter((r) => (openPx.get(r.sym) ?? 0) > 0)
        const denom = slotsFor(params.sizing, ranked.length)
        slotSum += denom
        const picked = ranked.slice(0, denom)
        const targets = params.gate ? picked.filter((r) => fam.keep(r.aux)) : picked
        const targetSet = new Set(targets.map((r) => r.sym))
        const slot = eq / denom

        // 1) 목표 밖 전량 매도 (봉이 없으면 못 판다 — 다음 기회로 이월)
        for (const s of [...book.positions.keys()]) {
          if (targetSet.has(s)) continue
          const px = openPx.get(s)
          if (px == null || !(px > 0)) continue
          bookSell(book, cost, s, px, book.positions.get(s)!.qty)
        }
        // 2) 목표 초과분 트림
        for (const r of targets) {
          const p = book.positions.get(r.sym)
          if (!p) continue
          const px = openPx.get(r.sym)!
          const want = Math.floor(slot / px)
          if (p.qty > want) bookSell(book, cost, r.sym, px, p.qty - want)
        }
        // 3) 부족분 매수 — **마지막 봉에서는 신규 진입을 만들지 않는다**(규칙 1-6)
        if (d < lastIdx) {
          for (const r of targets) {
            const px = openPx.get(r.sym)!
            const held = book.positions.get(r.sym)?.qty ?? 0
            const budget = Math.min(slot - held * px, book.cash)
            if (budget <= 0) continue
            bookBuy(book, cost, r.sym, px, budget)
          }
        }
      }
    }
    const closeAt = (s: string) => {
      const bi = idxOf[s]?.get(date)
      return bi != null ? hist[s][bi].c : null
    }
    equity.push({ date, equity: bookMark(book, closeAt) })
  }

  return { equity, closed: book.closed, wins: book.wins, openAtEnd: book.positions.size, rebalances, slotSum }
}

// ============================================================================
// 7. 연쇄 실행 — 연도별 유니버스 교체
// ============================================================================

export interface ChainStats {
  equity: Curve
  closed: number
  wins: number
  perYear: { y: number; ret: number; mapped: number; total: number; cash: boolean }[]
  rebalances: number
  /** 리밸런스당 평균 슬롯 수(분위 슬롯이 실제로 몇 개였나) */
  avgSlots: number | null
}

export function runUsChain(ctxs: readonly YearCtx[], cost: CostSettings, params: UsParams): ChainStats {
  const equity: Curve = []
  const perYear: ChainStats['perYear'] = []
  let factor = 1
  let closed = 0
  let wins = 0
  let rebalances = 0
  let slotSum = 0

  for (const ctx of ctxs) {
    if (ctx.symbols.length === 0) continue
    if (ctx.symbols.length < MIN_SYMBOLS) {
      // 표본이 너무 작으면 성적이 몇 종목 운에 좌우된다 — 현금 보유로 처리하고 곡선을
      // 평평하게 이어붙인다(구간을 건너뛰면 연수가 줄어 CAGR이 부풀려진다).
      for (const d of ctx.calendar) equity.push({ date: d, equity: factor * cost.initialCapital })
      perYear.push({ y: ctx.y, ret: 0, mapped: ctx.symbols.length, total: ctx.totalCodes, cash: true })
      continue
    }
    const run = simulateYear(ctx, cost, params)
    const base = factor
    for (const p of run.equity) equity.push({ date: p.date, equity: base * p.equity })
    const finalEq = run.equity.length ? run.equity[run.equity.length - 1].equity : cost.initialCapital
    const segRet = finalEq / cost.initialCapital
    // 구간 끝 청산비용 근사 [추정] — 정확한 청산가가 아니다(§0 주석 참조).
    const nominalSlots = Math.max(1, run.rebalances > 0 ? Math.round(run.slotSum / run.rebalances) : 1)
    const frac = APPLY_LIQUIDATION_HAIRCUT ? Math.min(1, Math.max(0, run.openAtEnd / nominalSlots)) : 0
    const yearRatio = segRet * (1 - frac * ((cost.feePct + cost.taxPct + cost.slippagePct) / 100))
    factor = base * yearRatio
    closed += run.closed
    wins += run.wins
    rebalances += run.rebalances
    slotSum += run.slotSum
    perYear.push({ y: ctx.y, ret: (yearRatio - 1) * 100, mapped: ctx.symbols.length, total: ctx.totalCodes, cash: false })
  }
  return { equity, closed, wins, perYear, rebalances, avgSlots: rebalances > 0 ? slotSum / rebalances : null }
}

// ============================================================================
// 8. 성과 지표 — idea-lab `perfOf`/`calmarOf`/`alphaOf`와 **같은 정의**(자립 구현)
// ============================================================================

export interface Perf {
  /** 총수익(%) */
  total: number
  /** 연환산 수익률(%) */
  cagr: number
  /** 최대 낙폭(%) — 음수 */
  mdd: number
  years: number
}

export function perfOf(equity: Curve, from = '', to = '9999-12-31'): Perf {
  const win = equity.filter((e) => e.date >= from && e.date <= to)
  if (win.length < 2) return { total: 0, cagr: 0, mdd: 0, years: 0 }
  const start = win[0].equity
  const end = win[win.length - 1].equity
  let peak = start
  let mdd = 0
  for (const e of win) {
    if (e.equity > peak) peak = e.equity
    else mdd = Math.min(mdd, (e.equity / peak - 1) * 100)
  }
  const years = Math.max(1 / 365, (Date.parse(win[win.length - 1].date) - Date.parse(win[0].date)) / (365.25 * 86400e3))
  const ratio = Math.max(end / start, 1e-9)
  return { total: (ratio - 1) * 100, cagr: (Math.pow(ratio, 1 / years) - 1) * 100, mdd, years }
}

/** 칼마 = **CAGR ÷ |MDD|**. MDD가 사실상 0이면 발산하므로 null(0으로 채우지 않는다). */
export function calmarOf(p: Perf): number | null {
  const mddAbs = Math.abs(p.mdd)
  return mddAbs > 0.01 ? p.cagr / mddAbs : null
}

/**
 * 알파는 **두 곡선이 겹치는 구간**에서만 계산한다(규칙 5). 벤치가 없는 구간을 전략에만
 * 유리하게 넣으면 알파가 부풀려진다.
 */
export function alphaOf(strat: Curve, bench: Curve, from: string, to: string): number | null {
  const bWin = bench.filter((e) => e.date >= from && e.date <= to)
  const sWin = strat.filter((e) => e.date >= from && e.date <= to)
  if (bWin.length < 2 || sWin.length < 2) return null
  const lo = bWin[0].date > sWin[0].date ? bWin[0].date : sWin[0].date
  const hi =
    bWin[bWin.length - 1].date < sWin[sWin.length - 1].date ? bWin[bWin.length - 1].date : sWin[sWin.length - 1].date
  const s = perfOf(strat, lo, hi)
  const b = perfOf(bench, lo, hi)
  if (s.years < 0.5 || b.years < 0.5) return null
  return s.cagr - b.cagr
}

/**
 * 전·후반 경계 연도(합성 자기검증용). 실데이터 실행은 `US_HALF_YEAR`(2014) 고정이다 —
 * 24·26·27차와 분할선을 맞추기 위해서다.
 */
export function halfYearOf(years: readonly number[]): number {
  if (years.length < 2) throw new Error(`전·후반을 나누려면 2년 이상이 필요하다 (${years.length}년)`)
  const first = years[0]
  const last = years[years.length - 1]
  if (!(last > first)) throw new Error(`구간이 오름차순이 아니다 (${first}~${last})`)
  return Math.ceil((first + last) / 2)
}

/** 자산곡선 → 일간 수익률(첫 점은 기준이라 빠진다). */
export function dailyReturnsOf(curve: Curve): { dates: string[]; returns: number[] } {
  const dates: string[] = []
  const returns: number[] = []
  for (let i = 1; i < curve.length; i++) {
    const prev = curve[i - 1].equity
    if (!(prev > 0)) continue
    dates.push(curve[i].date)
    returns.push(curve[i].equity / prev - 1)
  }
  return { dates, returns }
}

/**
 * 변형별 **일간 수익률 행렬**. 모든 변형이 **같은 날짜 축**에 정렬돼 있어야 한다 —
 * 한 변형에만 있는 날을 그대로 두면 시점이 통째로 밀린다. 공통 날짜만 남기고
 * 버린 수를 돌려준다(조용히 버리지 않는다).
 */
export function alignDailyMatrix(
  series: readonly { dates: string[]; returns: number[] }[],
  benchmark?: { dates: string[]; returns: number[] },
): { dates: string[]; matrix: number[][]; bench: number[] | null; dropped: number } {
  if (series.length === 0) return { dates: [], matrix: [], bench: null, dropped: 0 }
  const maps = series.map((s) => {
    const m = new Map<string, number>()
    s.dates.forEach((d, i) => m.set(d, s.returns[i]))
    return m
  })
  const benchMap = benchmark
    ? (() => {
        const m = new Map<string, number>()
        benchmark.dates.forEach((d, i) => m.set(d, benchmark.returns[i]))
        return m
      })()
    : null
  const all = new Set<string>()
  for (const m of maps) for (const k of m.keys()) all.add(k)
  const sorted = [...all].sort()
  const dates = sorted.filter((k) => maps.every((m) => m.has(k)) && (benchMap === null || benchMap.has(k)))
  return {
    dates,
    matrix: maps.map((m) => dates.map((k) => m.get(k) as number)),
    bench: benchMap ? dates.map((k) => benchMap.get(k) as number) : null,
    dropped: sorted.length - dates.length,
  }
}

// ============================================================================
// 9. 변형 결과 · 고원 채점 · 승격 관문 (39차와 **같은 잣대** — 느슨하게 하지 않는다)
// ============================================================================

export interface VariantResult {
  gridId: string
  cell: GridCell
  full: Perf
  a: Perf
  b: Perf
  calmar: number | null
  sharpeDaily: number | null
  alphaFull: number | null
  alphaA: number | null
  alphaB: number | null
  trades: number
  wins: number
  rebalances: number
  avgSlots: number | null
  perYear: ChainStats['perYear']
  dailyReturns: number[]
}

/** 관문 ①②(변형 단독으로 판정 가능한 것) — 빈 배열이면 통과. */
export function localFailReasons(r: VariantResult, minTrades = US_MIN_TRADES): string[] {
  const bad: string[] = []
  if (!((r.alphaA ?? -1) > 0 && (r.alphaB ?? -1) > 0)) bad.push('알파(전·후반)')
  if (!(r.trades >= minTrades)) bad.push(`매매<${minTrades}`)
  return bad
}
export const localPass = (r: VariantResult, minTrades = US_MIN_TRADES): boolean =>
  localFailReasons(r, minTrades).length === 0

export interface PlateauScore {
  index: number
  /** 셀 자신의 성적(칼마). 계산 불가면 null. */
  self: number | null
  neighbors: number
  /** 격자 **끝**이라 볼 수 없는 이웃 방향 — `[표본부족]`의 근거 */
  missing: string[]
  frozen: AxisKey[]
  /** 이웃 성적 중 최솟값. 이웃 중 하나라도 null이면 null. */
  minNeighbor: number | null
  /** **셀과 이웃 성적의 최솟값** — 평균이 아니다. */
  plateauScore: number | null
  /** (셀 − 이웃최솟값) ÷ |셀|. 셀 성적이 0 이하면 정의하지 않는다. */
  plateauDrop: number | null
  /** 이웃 전부가 관문 ①②를 통과했는가. 이웃이 없으면 null. */
  neighborsPassLocal: boolean | null
  sampleShort: boolean
  reason: string | null
}

/**
 * 고원 채점(39차 정의 그대로). `scoreOf[i]`는 격자 안 i번 셀의 성적(칼마),
 * `passOf[i]`는 그 셀의 관문 ①② 통과 여부다.
 *
 * ⚠️ 규칙 1과의 관계: 이 함수는 **이미 확정된 격자 성적의 사후 채점**이다. 산출값이
 *    신호·진입·청산·사이징으로 되먹임되지 않으므로 "전 구간 통계 금지"(규칙 1-5)에
 *    걸리지 않는다. 반대로 이 값을 전략 로직에 넣는 순간 그것은 미래참조가 된다.
 */
export function scorePlateau(
  cells: readonly GridCell[],
  grid: LabGrid,
  scoreOf: readonly (number | null)[],
  passOf: readonly boolean[],
): PlateauScore[] {
  if (scoreOf.length !== cells.length || passOf.length !== cells.length)
    throw new Error(`성적·판정 배열 길이가 셀 수(${cells.length})와 다르다`)
  return cells.map((cell, i) => {
    const { found, missing, frozen } = neighborsOf(cell, grid)
    const self = scoreOf[i]
    const nb = found.map((n) => scoreOf[n.index])
    const nullNb = nb.filter((v) => v == null).length
    const minNeighbor = nullNb > 0 || nb.length === 0 ? null : Math.min(...(nb as number[]))
    let reason: string | null = null
    if (self == null) reason = '셀 성적 계산 불가(MDD≈0 등) — 고원 판정 불가'
    else if (nb.length === 0) reason = '이웃이 하나도 없다(모든 축이 1단계) — 고원 판정 불가'
    else if (nullNb > 0) reason = `이웃 ${nullNb}개의 성적을 계산할 수 없다 — 고원 판정 불가`
    const plateauScore = self != null && minNeighbor != null ? Math.min(self, minNeighbor) : null
    const plateauDrop = self != null && minNeighbor != null && self > 0 ? (self - minNeighbor) / Math.abs(self) : null
    if (plateauDrop == null && reason == null && self != null && self <= 0)
      reason = '셀 성적이 0 이하 — 낙폭 비율(plateauDrop)이 정의되지 않는다'
    return {
      index: i,
      self,
      neighbors: found.length,
      missing,
      frozen,
      minNeighbor,
      plateauScore,
      plateauDrop,
      neighborsPassLocal: found.length === 0 ? null : found.every((n) => passOf[n.index]),
      sampleShort: missing.length > 0,
      reason,
    }
  })
}

export interface PromotionVerdict {
  passed: number[]
  failed: string[]
  promoted: boolean
}

/**
 * 승격 관문 (전부 통과해야 승격 — **가장 덜 나쁜 변형 승격 금지**):
 *   ① 전·후반 양쪽 알파 양수  ② 매매수 ≥ 20  ③ PBO < 0.5
 *   ④ 워크포워드 OOS 알파 양수  ⑤ 고원: plateauDrop ≤ 0.30 이면서 이웃 전부가 관문①② 통과
 *
 * ③④는 **회차 전체에 하나씩 나오는 값**이라 변형마다 같다 — 변형 단위 판정에 그대로 얹는다
 * (그 회차의 탐색 절차 자체가 아웃샘플에서 성립하는지를 묻는 관문이기 때문이다).
 * 국장(39차)과 **같은 잣대**다. 미장이라고 느슨하게 하지 않는다.
 */
export function promotionVerdict(
  r: VariantResult,
  ps: PlateauScore,
  round: { pbo: number | null; wfOosAlpha: number | null },
  minTrades = US_MIN_TRADES,
  dropThreshold = US_DROP_THRESHOLD,
): PromotionVerdict {
  const passed: number[] = []
  const failed: string[] = []
  if ((r.alphaA ?? -1) > 0 && (r.alphaB ?? -1) > 0) passed.push(1)
  else failed.push('①전·후반 알파')
  if (r.trades >= minTrades) passed.push(2)
  else failed.push(`②매매수(${r.trades}<${minTrades})`)
  if (round.pbo != null && round.pbo < PBO_WARN_THRESHOLD) passed.push(3)
  else failed.push(round.pbo == null ? '③PBO 계산불가' : `③PBO ${round.pbo.toFixed(3)}≥${PBO_WARN_THRESHOLD}`)
  if (round.wfOosAlpha != null && round.wfOosAlpha > 0) passed.push(4)
  else
    failed.push(round.wfOosAlpha == null ? '④워크포워드 계산불가' : `④WF OOS 알파 ${round.wfOosAlpha.toFixed(2)}%p≤0`)
  if (ps.plateauDrop != null && ps.plateauDrop <= dropThreshold && ps.neighborsPassLocal === true) passed.push(5)
  else
    failed.push(
      ps.plateauDrop == null
        ? `⑤고원 판정불가(${ps.reason ?? '사유 없음'})`
        : ps.plateauDrop > dropThreshold
          ? `⑤plateauDrop ${ps.plateauDrop.toFixed(3)}>${dropThreshold}`
          : '⑤이웃 중 관문①② 탈락 존재',
    )
  return { passed, failed, promoted: failed.length === 0 }
}

// ============================================================================
// 10. 격자 정의 — MODE별 실행 단위
// ============================================================================

/** 27차 재현 격자의 base — 12-1 모멘텀, 절대모멘텀 게이트 축, 매월 리밸런스. */
export const MOM_BASE: UsParams = {
  factor: 'mom',
  lookback: 12,
  skip: 1,
  sizing: { kind: 'fixed', n: 8 },
  gate: false,
  rebalMonths: 1,
}

/**
 * 학계 표준 분위(상위 10%). 27차가 유일하게 알파를 낸 자리이고, 이 회차의 **가설 축**이다.
 * 상위 80 × 10% = 8종목이라 27차의 `상위8`과 정확히 겹친다.
 */
export const DECILE_PCT = 10

/** 분위 축 값(%) — 10%를 가운데 두고 양쪽으로 흔든다. 고원 판정의 유일한 내부 축이다. */
export const PCT_VALUES = [5, DECILE_PCT, 15, 20]

/**
 * ① 27차 재현 격자 — **슬롯을 절대값으로** 두고 게이트만 흔든다.
 *    27차 usxsmom80의 8변형(슬롯 5/8/12/16 × 게이트 on/off)과 **정확히 같은 조합**이다.
 */
export const REPRO_GRID: LabGrid = {
  id: 'xsmom-repro',
  label: '27차 재현 — 12-1 모멘텀 · 절대 슬롯',
  question: '27차 실측(상위8+게이트 알파 +4.7%p)이 이 러너에서 재현되는가',
  base: MOM_BASE,
  axes: [
    { key: 'slots', label: '보유 종목수', values: [5, 8, 12, 16], unit: '종목' },
    { key: 'gate', label: '절대모멘텀 게이트', values: [0, 1], unit: '' },
  ],
}

/** ② 계열별 분위 격자 — **모든 계열을 같은 분위로 맞춘다**. 이 회차의 핵심. */
export function quantileGridOf(factor: FactorKind): LabGrid {
  const fam = FACTORS[factor]
  return {
    id: `quantile-${factor}`,
    label: `${fam.name} · 분위 정합`,
    question: `분위를 상위 ${DECILE_PCT}%로 맞추면 ${fam.name} 계열도 미장에서 알파를 내는가`,
    base: { ...MOM_BASE, factor, sizing: { kind: 'quantile', pct: DECILE_PCT }, gate: false },
    axes: [
      { key: 'pct', label: '분위', values: PCT_VALUES, unit: '%' },
      { key: 'gate', label: fam.gateLabel, values: [0, 1], unit: '' },
    ],
  }
}

export const QUANTILE_GRIDS: LabGrid[] = FACTOR_ORDER.map(quantileGridOf)

/** 축소 격자(스모크런) — 배선·출력 형식만 확인한다. **이 결과로 판정하지 않는다.** */
export const QUICK_GRID: LabGrid = {
  id: 'quick-mom',
  label: '스모크런 — 12-1 모멘텀 · 분위 2단계',
  question: '배선과 출력 형식이 깨지지 않는가(판정용이 아니다)',
  base: { ...MOM_BASE, sizing: { kind: 'quantile', pct: DECILE_PCT } },
  axes: [
    { key: 'pct', label: '분위', values: [DECILE_PCT, 20], unit: '%' },
    { key: 'gate', label: '절대모멘텀 게이트', values: [0, 1], unit: '' },
  ],
}

export type Mode = 'xsmom' | 'quantile' | 'all' | 'quick' | 'selftest'

/** MODE → 돌릴 격자 목록. **여기서만** 모드가 정의된다. */
export function gridsForMode(mode: Mode): LabGrid[] {
  switch (mode) {
    case 'xsmom':
      // 재현 격자 + 모멘텀 분위 격자(= quantile 모드의 mom 격자와 **같은 격자**라
      // MODE=all에서 중복 계수되지 않는다).
      return [REPRO_GRID, quantileGridOf('mom')]
    case 'quantile':
      return QUANTILE_GRIDS
    case 'all':
      return [REPRO_GRID, ...QUANTILE_GRIDS]
    case 'quick':
      return [QUICK_GRID]
    case 'selftest':
      // 재현 격자를 **일부러** 넣는다 — 27차 대조 경로(특히 "재현 실패" 분기)가 실데이터
      // 실행에서 처음 도는 일이 없게 하려는 것이다. 합성 데이터라 당연히 재현 실패로 찍히고,
      // 그 출력이 깨지지 않는지가 여기서 확인하려는 것 자체다.
      return [REPRO_GRID, QUICK_GRID, quantileGridOf('lowvol')]
  }
}

export const countVariants = (grids: readonly LabGrid[]): number =>
  grids.reduce((s, g) => s + g.axes.reduce((n, a) => n * a.values.length, 1), 0)

// ============================================================================
// 11. 실행 — 격자 한 판
// ============================================================================

export interface RunInputs {
  grids: LabGrid[]
  ctxs: YearCtx[]
  years: readonly number[]
  cost: CostSettings
  /** 알파 판정 벤치(규칙 5) */
  benchCurve: Curve
  benchLabel: string
  halfYear: number
}

export interface GridOutput {
  grid: LabGrid
  cells: GridCell[]
  /** `results` 배열에서의 시작 위치 */
  offset: number
  plateau: PlateauScore[]
}

export interface RunOutputs {
  grids: GridOutput[]
  results: VariantResult[]
  dates: string[]
  matrix: number[][]
  benchReturns: number[] | null
  dropped: number
  pbo: PboResult
  wf: WalkForwardResult
  /** 격자 실행(변형 백테스트)에만 든 시간 */
  gridMs: number
  /** 사후 채점(PBO·워크포워드·정렬)에 든 시간 — PBO가 지배적이다 */
  scoringMs: number
  /** 1변형 실측 ms(예산 역산용) */
  firstVariantMs: number
}

/** 격자 전체 실행 + 사후 채점. **여기서 임계값을 데이터로 정하지 않는다**(전부 사전 고정 상수). */
export function runGrids(inp: RunInputs, onVariant?: (done: number, total: number, ms: number) => void): RunOutputs {
  const t0 = Date.now()
  const half = inp.halfYear
  const results: VariantResult[] = []
  const series: { dates: string[]; returns: number[] }[] = []
  const gridOutputs: { grid: LabGrid; cells: GridCell[]; offset: number }[] = []
  let firstVariantMs = 0

  const total = countVariants(inp.grids)
  for (const grid of inp.grids) {
    const offset = results.length
    const cells = enumerateGrid(grid, offset)
    gridOutputs.push({ grid, cells, offset })
    for (const cell of cells) {
      const t = Date.now()
      const chain = runUsChain(inp.ctxs, inp.cost, cell.params)
      const full = perfOf(chain.equity)
      const dr = dailyReturnsOf(chain.equity)
      series.push(dr)
      results.push({
        gridId: grid.id,
        cell,
        full,
        a: perfOf(chain.equity, '', `${half - 1}-12-31`),
        b: perfOf(chain.equity, `${half}-01-01`),
        calmar: calmarOf(full),
        sharpeDaily: sharpeMetric(dr.returns),
        alphaFull: alphaOf(chain.equity, inp.benchCurve, '', '9999-12-31'),
        alphaA: alphaOf(chain.equity, inp.benchCurve, '', `${half - 1}-12-31`),
        alphaB: alphaOf(chain.equity, inp.benchCurve, `${half}-01-01`, '9999-12-31'),
        trades: chain.closed,
        wins: chain.wins,
        rebalances: chain.rebalances,
        avgSlots: chain.avgSlots,
        perYear: chain.perYear,
        dailyReturns: dr.returns,
      })
      const ms = Date.now() - t
      if (results.length === 1) firstVariantMs = ms
      onVariant?.(results.length, total, ms)
    }
  }

  const gridMs = Date.now() - t0
  const t1 = Date.now()
  const benchDaily = dailyReturnsOf(inp.benchCurve)
  const aligned = alignDailyMatrix(series, benchDaily)

  const maxCombos = Number(process.env.US_PBO_MAX_COMBOS ?? '') || pboMaxCombinations(results.length)
  const pbo = computePbo(aligned.matrix, { blocks: US_PBO_BLOCKS, maxCombinations: maxCombos, metric: sharpeMetric })
  const wf = walkForwardScore(aligned.matrix, {
    isWindow: US_WF_IS_DAYS,
    oosWindow: US_WF_OOS_DAYS,
    metric: sharpeMetric,
    periodsPerYear: US_PERIODS_PER_YEAR,
    benchmark: aligned.bench ?? undefined,
  })

  const grids: GridOutput[] = gridOutputs.map((g) => ({
    ...g,
    plateau: scorePlateau(
      g.cells,
      g.grid,
      g.cells.map((c) => results[c.globalIndex].calmar),
      g.cells.map((c) => localPass(results[c.globalIndex])),
    ),
  }))

  return {
    grids,
    results,
    dates: aligned.dates,
    matrix: aligned.matrix,
    benchReturns: aligned.bench,
    dropped: aligned.dropped,
    pbo,
    wf,
    gridMs,
    scoringMs: Date.now() - t1,
    firstVariantMs,
  }
}

// ============================================================================
// 12. 야후 로딩 (규칙 4 — 실패를 삼키지 않는다)
// ============================================================================

/**
 * 시세 호출 성공/실패 카운터. 전량 실패는 **비정상 종료**의 근거가 된다.
 * `sourceOf`는 "어느 봉이 어느 소스에서 왔나"를 종목 단위로 남긴다 — 소스를 섞지 않지만
 * 기록은 남긴다(규칙 3 · 조용한 폴백 금지의 증거).
 */
export interface PriceTally {
  attempted: number
  ok: number
  failed: { symbol: string; reason: string }[]
  sourceOf: Record<string, UsPriceSource>
  /** tiingo 보정 기준 감사 결과(심볼별). 야후 경로에서는 비어 있다. */
  audits: { symbol: string; audit: TiingoAdjAudit }[]
}
export const newPriceTally = (): PriceTally => ({ attempted: 0, ok: 0, failed: [], sourceOf: {}, audits: [] })

/** 기존 이름 — 호출부·테스트가 쓰던 형태를 깨지 않으려고 남긴다. */
export type YahooTally = PriceTally
export const newYahooTally = newPriceTally

/**
 * 야후 일봉. **어떤 실패도 삼키지 않는다** — HTTP 오류·`chart.error`(200 본문)·빈 result
 * 전부 던진다. 총수익 보정(`adjclose ÷ close`)은 `basis='total'`일 때만 곱한다(규칙 3).
 *
 * ⚠️ 날짜는 **미국 동부 현지일**로 환산한다. 한국 러너들이 쓰는 KST(+9h) 공식을 그대로
 *    가져오면 미국 종목의 날짜가 하루씩 밀려 리밸런스 달 경계가 어긋난다.
 *    `meta.gmtoffset`이 오면 그것을 쓰고, 없으면 −5h(EST)로 떨어뜨린다 —
 *    서머타임 구간에서 −4h가 맞지만 두 값 모두 미 동부 장중(09:30~16:00)을 같은 날짜로
 *    떨어뜨리므로 일봉에서는 결과가 같다.
 */
export async function fetchDaily(symbol: string, range = US_RANGE, basis: ReturnBasis = 'total'): Promise<DailyBar[]> {
  const qs = range.startsWith('since:')
    ? `period1=${Math.floor(Date.parse(range.slice(6)) / 1000)}&period2=${Math.floor(Date.now() / 1000)}`
    : `range=${range}`
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?${qs}&interval=1d&events=div%2Csplit`
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' } })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const json = (await res.json()) as {
    chart?: {
      result?: {
        meta?: { gmtoffset?: number }
        timestamp?: number[]
        indicators?: {
          quote?: { open?: number[]; high?: number[]; low?: number[]; close?: number[]; volume?: number[] }[]
          adjclose?: { adjclose?: (number | null)[] }[]
        }
      }[]
      error?: { description?: string }
    }
  }
  const r = json?.chart?.result?.[0]
  // 200인데 본문에 오류가 담겨 오는 경우가 있다(규칙 4 — 실패 표현이 상태코드만이 아니다).
  if (!r) throw new Error(json?.chart?.error?.description ?? 'chart.result 없음')
  const gmt = Number.isFinite(r.meta?.gmtoffset) ? (r.meta?.gmtoffset as number) : -5 * 3600
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
    const fac =
      basis === 'price'
        ? 1
        : adj[i] != null && Number.isFinite(adj[i] as number) && (cl as number) > 0
          ? (adj[i] as number) / (cl as number)
          : 1
    const date = new Date((ts[i] + gmt) * 1000).toISOString().slice(0, 10)
    out.push({
      date,
      t: ts[i],
      o: (o as number) * fac,
      h: (h as number) * fac,
      l: (l as number) * fac,
      c: (cl as number) * fac,
      v: Number.isFinite(v) ? (v as number) : 0,
    })
  }
  return out
}

/**
 * 카운터를 물린 야후 호출. 실패해도 던지지 않고 null — **판단은 호출부가** 한다.
 * 정상 0봉(휴장·구간 밖)과 실패 0봉(차단·잘못된 심볼)을 구분한다: 일봉 27년 요청에
 * `minBars`개 미만이면 실패로 본다.
 */
export async function tallyFetch(
  tally: PriceTally,
  symbol: string,
  range = US_RANGE,
  minBars = 200,
  source: UsPriceSource = 'yahoo',
  token: string | null = null,
): Promise<DailyBar[] | null> {
  tally.attempted++
  try {
    const got = source === 'tiingo' ? await loadTiingoBars(symbol, token, range) : { bars: await fetchDaily(symbol, range, 'total'), audit: null }
    const bars = got.bars
    if (got.audit) tally.audits.push({ symbol, audit: got.audit })
    if (bars.length < minBars) {
      tally.failed.push({ symbol, reason: `봉 ${bars.length}개 — 구간 요청(${range})에 비해 비정상적으로 적다` })
      return null
    }
    tally.ok++
    tally.sourceOf[symbol] = source
    return bars
  } catch (e) {
    tally.failed.push({ symbol, reason: String(e) })
    return null
  }
}

// ── tiingo 경로 ─────────────────────────────────────────────────────────────
//
// 호출·파싱·감사는 전부 `scripts/lib/tiingo.ts`가 정본이다(소스 실사 프로브와 **같은 코드**).
// 여기서는 러너 규약으로 옮기기만 한다: 구간 변환 · 재사용 가드 · 봉 변환.

/** `since:YYYY-MM-DD` 규약을 tiingo `startDate`로 옮긴다. 다른 형태면 던진다(추측 금지). */
export function rangeToStartDate(range: string): string {
  if (!range.startsWith('since:'))
    throw new Error(`tiingo 경로는 'since:YYYY-MM-DD' 구간만 받는다 — 받은 값: ${range}(야후 전용 range 표기)`)
  const d = range.slice(6)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new Error(`구간 시작일이 YYYY-MM-DD가 아니다 — ${d}`)
  return d
}

/**
 * tiingo 일봉 → `DailyBar[]`. 실패는 **던진다**(호출부 `tallyFetch`가 센다).
 *   · absent(404·빈 배열) → 던진다. 러너에게는 "그 종목을 못 받았다"와 같은 뜻이고,
 *     매핑 실패로 계수돼 연도별 매핑률에 드러난다(= 잔존 생존편향의 크기).
 *   · **티커 재사용 의심(긴 공백)** → 던진다. 뒤 구간만 쓰면 조용한 오염이다(MER 사건).
 */
export async function loadTiingoBars(
  symbol: string,
  token: string | null,
  range = US_RANGE,
): Promise<{ bars: DailyBar[]; audit: TiingoAdjAudit }> {
  if (!token) throw new Error('TIINGO_API_KEY 없음 — tiingo 소스를 고르고 키가 없으면 야후로 조용히 내려가지 않고 실패로 센다')
  const res = await fetchTiingoDaily(symbol, token, { startDate: rangeToStartDate(range) })
  if (res.kind === 'absent') throw new Error(`tiingo absent — ${res.note}`)
  const gap = checkTickerReuseGap(res.rows)
  if (!gap.ok) throw new Error(gap.reason)
  const { bars, dropped } = tiingoBarsToDaily(res.rows, 'total')
  if (bars.length === 0) throw new Error(`tiingo ${res.rows.length}행에서 OHLC 완전한 봉이 0개다(버린 행 ${dropped})`)
  return { bars, audit: res.audit }
}

/**
 * 🔴 **배당·분할 기준 게이트** — 이 작업의 가장 큰 함정을 여기서 막는다.
 *
 * tiingo `adj*`가 분할만 반영한다면 전략은 가격수익, 벤치·벽은 총수익이 되어 40차에서
 * 제거한 **배당 비대칭**이 되살아난다. 문서를 믿지 않고 **벤치(SPY)의 실제 응답**으로
 * 판정한다 — 27년 구간이면 배당락 사건이 100건 남짓이라 표본이 충분하다.
 *
 *   · `total`   → 통과(야후 `adjclose`와 같은 기준)
 *   · `price`   → **중단.** 조용히 돌면 알파가 전략에 불리하게 기운다.
 *   · `unknown` → **중단.** `US_TIINGO_ALLOW_UNVERIFIED=1`로만 명시적으로 넘긴다
 *     (그 경우 결과에 `[미검증]`이 붙는다 — 추측으로 메우지 않는다).
 */
export function tiingoBasisGate(audit: TiingoAdjAudit, allowUnverified = process.env.US_TIINGO_ALLOW_UNVERIFIED === '1'): string {
  if (audit.verdict === 'total')
    return `✅ tiingo 보정 기준 확정: **분할+배당(총수익)** — ${audit.note}${audit.singleFactorOk ? ' · adjOpen/open = adjClose/close 확인(단일 계수 모델 성립)' : ''}`
  if (audit.verdict === 'price')
    throw new Error(
      `⛔ tiingo adj*가 **배당을 반영하지 않는다**(${audit.note}). 이대로 돌면 전략은 가격수익, ` +
        '벤치·벽은 총수익이 되어 2026-08-03 국장 40차에서 제거한 **배당 비대칭**이 그대로 되살아난다. ' +
        '실행을 중단한다 — 기준을 맞추려면 배당 계열을 따로 받아 계수를 만들어야 한다.',
    )
  const msg =
    `tiingo 보정 기준을 **판정하지 못했다** [미검증] — ${audit.note}. ` +
    `총수익이라 가정하고 돌면 배당 비대칭 위험이 그대로 남는다.`
  if (!allowUnverified)
    throw new Error(`⛔ ${msg} 그래도 돌리려면 US_TIINGO_ALLOW_UNVERIFIED=1을 명시하라(결과에 [미검증]이 붙는다).`)
  return `⚠️ [미검증] ${msg} US_TIINGO_ALLOW_UNVERIFIED=1로 명시 진행 — **이 회차 수치에 [미검증] 딱지를 유지하라.**`
}

/** 소스별 로드 결과 한 줄 — "어느 봉이 어느 소스에서 왔나"를 결과에 남긴다(규칙 3). */
export function sourceMixLine(tally: PriceTally): string {
  const counts = new Map<UsPriceSource, number>()
  for (const s of Object.values(tally.sourceOf)) counts.set(s, (counts.get(s) ?? 0) + 1)
  const parts = [...counts.entries()].map(([s, n]) => `${s} ${n}종목`)
  return parts.length <= 1
    ? `시세 출처: ${parts[0] ?? '없음'} (한 실행은 한 소스만 쓴다 — 조용한 폴백 없음)`
    : `⚠️ 시세 출처가 섞였다: ${parts.join(' · ')} — 보정 기준이 종목마다 다를 수 있으니 결과를 그대로 비교하지 마라`
}

const sleep = (ms: number): Promise<void> => new Promise<void>((r) => setTimeout(() => r(), ms))

/**
 * 야후 호출 간격(ms). 기본 120 — 한도 문서가 없어 `[미검증]`이라 보수적으로 둔다.
 * 빈 문자열·미설정을 `Number('')===0`으로 읽어 **간격 0으로 조용히 떨어지지 않도록**
 * 값이 실제로 있을 때만 파싱한다(그 실수가 실제로 한 번 났다).
 */
export const fetchDelayMs = (raw = process.env.US_FETCH_DELAY_MS): number => {
  const s = (raw ?? '').trim()
  if (s === '') return 120
  const v = Number(s)
  return Number.isFinite(v) && v >= 0 ? v : 120
}

// ============================================================================
// 13. 출력 유틸
// ============================================================================

export const f1 = (v: number | null | undefined): string =>
  v == null || !Number.isFinite(v) ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(1)}`
export const num = (v: number | null | undefined, d = 3): string =>
  v == null || !Number.isFinite(v) ? '—' : v.toFixed(d)
export const pp = (v: number | null | undefined): string => (v == null ? '—' : `${f1(v)}%p`)

export interface WallStats {
  label: string
  calmar: number | null
  cagrPct: number
  mddPct: number
  totalPct: number
  from: string
  to: string
}

/** 같은 구간 단순보유의 칼마·CAGR·MDD. **옮겨 적지 않고 다시 잰다**(34차 규약). */
export function wallOf(label: string, curve: Curve, from: string, to: string): WallStats | null {
  const seg = curve.filter((p) => p.date >= from && p.date <= to && p.equity > 0)
  if (seg.length < 2) return null
  const p = perfOf(seg)
  return {
    label,
    calmar: calmarOf(p),
    cagrPct: p.cagr,
    mddPct: p.mdd,
    totalPct: p.total,
    from: seg[0].date,
    to: seg[seg.length - 1].date,
  }
}

// ============================================================================
// 14. 보고서
// ============================================================================

const DISCLAIMER = [
  '',
  '---',
  '',
  '⚠️ **이 산출물은 과거 데이터 시뮬레이션이며 투자자문이 아니다.** 확정적 매수·매도 권유가 아니라',
  '조건과 확률의 관찰 기록이다. 여기 적힌 어떤 수치도 미래 수익을 보장하지 않는다.',
  '손실 경로를 같은 무게로 읽어라 — 표의 MDD는 **그 구간에서 실제로 겪었을 최대 낙폭**이고,',
  '전략이 무효화되는 지점(고원이 무너지는 이웃 셀·전·후반 중 한쪽이 음수인 변형)도 같은 표에 있다.',
]

/**
 * 27차 재현 대조. 재현 실패는 **그 자체가 중요한 발견**이라 크게 찍는다.
 * `synthetic`이면 합성 데이터라 재현될 리가 없으므로 그 사실을 먼저 밝힌다 —
 * 배선 확인용 실행의 "재현 실패"를 실데이터 발견으로 오독하지 않게 하려는 것이다.
 */
export function reproSection(out: RunOutputs, synthetic = false): { found: boolean; delta: number | null } {
  const target = out.results.find(
    (r) =>
      r.gridId === REPRO_GRID.id &&
      r.cell.params.sizing.kind === 'fixed' &&
      r.cell.params.sizing.n === USXSMOM80_PRIOR.bestSlots &&
      r.cell.params.gate === USXSMOM80_PRIOR.bestGate,
  )
  const repro = out.results.filter((r) => r.gridId === REPRO_GRID.id)
  log('')
  log(`## 27차 재현 대조 — ${USXSMOM80_PRIOR.bestLabel}의 알파가 다시 나오는가`)
  log('')
  if (repro.length === 0) {
    log('이 MODE에는 재현 격자가 없다(MODE=xsmom / all에서만 돈다).')
    return { found: false, delta: null }
  }
  if (synthetic)
    log(
      '⚠️ **합성 데이터 실행이라 재현될 리가 없다.** 아래 "재현 실패"는 **출력 경로가 도는지** 확인하는 것이지 ' +
        '실데이터 발견이 아니다 — 그 분기가 실데이터 실행에서 처음 도는 일이 없도록 일부러 여기서 태운다.',
    )
  const posFull = repro.filter((r) => (r.alphaFull ?? -1) > 0)
  log('| 항목 | 27차 실측 | 이번 재현 | 차이 |')
  log('|---|---|---|---|')
  log(`| 변형 수 | ${USXSMOM80_PRIOR.variants} | ${repro.length} | — |`)
  log(`| 전 구간 알파 > 0 | ${USXSMOM80_PRIOR.positiveAlphaFull}개 | ${posFull.length}개 | — |`)
  const delta = target?.alphaFull != null ? target.alphaFull - USXSMOM80_PRIOR.bestAlphaFullPp : null
  log(
    `| ${USXSMOM80_PRIOR.bestLabel} 전 구간 알파 | ${f1(USXSMOM80_PRIOR.bestAlphaFullPp)}%p | ` +
      `${pp(target?.alphaFull ?? null)} | ${delta == null ? '—' : `${f1(delta)}%p`} |`,
  )
  log('')
  if (target == null) {
    log('❌ **재현 대상 변형을 격자에서 찾지 못했다** — 격자 정의가 27차와 어긋났다는 뜻이다. 격자 축을 확인하라.')
  } else if (delta == null) {
    log('❌ **재현 실패 — 알파를 계산할 수 없었다.** 벤치(SPY) 구간과 전략 구간이 겹치지 않는다는 뜻이다.')
  } else if (Math.abs(delta) <= REPRO_TOLERANCE_PP) {
    log(
      `✅ **재현됨** (차이 ${f1(delta)}%p ≤ 허용 ${REPRO_TOLERANCE_PP}%p). 27차 수치가 이 러너에서 다시 나온다 — ` +
        '아래 다른 계열 수치를 27차 표와 나란히 읽어도 된다.',
    )
  } else {
    log(
      `🔴 **재현 실패 — 차이 ${f1(delta)}%p (허용 ${REPRO_TOLERANCE_PP}%p 초과).** ` +
        '**이것 자체가 이 회차의 중요한 발견이다.** 27차 수치가 재현되지 않으면 그 위에 쌓은 "상위 80에서만 통했다"는 ' +
        '단서 자체가 흔들린다. 아래 다른 계열 수치를 27차 표와 나란히 읽지 마라. ' +
        '가능한 원인(전부 추정): 유니버스 목록이 그사이 바뀜 · 야후 시계열 재보정(분할·배당) · ' +
        '구간 끝(2026년 부분 연도)이 늘어남 · 청산비용 근사 슬롯 분모 차이. 어느 쪽이든 **수치를 맞추려고 ' +
        '파라미터를 흔들지 않는다** — 차이를 그대로 보고한다.',
    )
  }
  return { found: target != null, delta }
}

export function variantTable(title: string, rows: readonly VariantResult[], uni: UsUniverse): void {
  log('')
  log(`### ${title}`)
  log('')
  log(estimateBanner(uni))
  log('')
  log(
    '| 변형 | 총수익 | CAGR | MDD | 칼마 | 매매 | 승률 | 평균슬롯 | 알파(전구간) | 전반 알파 | 후반 알파 | 관문①② |',
  )
  log('|---|---|---|---|---|---|---|---|---|---|---|---|')
  for (const r of rows) {
    const wr = r.trades > 0 ? `${((r.wins / r.trades) * 100).toFixed(0)}%` : '—'
    const bad = localFailReasons(r)
    log(
      `| \`${r.cell.key}\` | ${f1(r.full.total)}% | ${f1(r.full.cagr)}% | ${f1(r.full.mdd)}% | ${num(r.calmar)} | ` +
        `${r.trades} | ${wr} | ${r.avgSlots == null ? '—' : r.avgSlots.toFixed(1)} | ${pp(r.alphaFull)} | ` +
        `${pp(r.alphaA)} | ${pp(r.alphaB)} | ${bad.length === 0 ? '✅' : `❌ ${bad.join('·')}`} |`,
    )
  }
}

/** 계열 × 분위 단면 — "분위를 맞추면 사는가"를 한 표에서 본다. */
export function quantileCrossTable(out: RunOutputs, uni: UsUniverse, valueOf: (r: VariantResult) => number | null, title: string, digits = 3): void {
  const fams = FACTOR_ORDER.filter((f) => out.grids.some((g) => g.grid.id === `quantile-${f}`))
  if (fams.length === 0) return
  log('')
  log(`### ${title}`)
  log('')
  log(estimateBanner(uni))
  log('')
  for (const gate of [0, 1]) {
    log(`**게이트 ${gate === 1 ? 'ON(계열별 임계)' : 'OFF'}**`)
    log('')
    log(`| 계열\\분위 | ${PCT_VALUES.map((p) => `상위 ${p}%`).join(' | ')} |`)
    log(`|---|${PCT_VALUES.map(() => '---').join('|')}|`)
    for (const f of fams) {
      const row = PCT_VALUES.map((pct) => {
        const hit = out.results.find(
          (r) =>
            r.gridId === `quantile-${f}` &&
            r.cell.params.sizing.kind === 'quantile' &&
            r.cell.params.sizing.pct === pct &&
            r.cell.params.gate === (gate === 1),
        )
        return hit ? num(valueOf(hit), digits) : '—'
      })
      log(`| **${FACTORS[f].name}** | ${row.join(' | ')} |`)
    }
    log('')
  }
  log(`⚠️ 굵은 칸(상위 ${DECILE_PCT}%)이 학계 표준 분위다. **한 칸이 좋다고 계열이 산 것이 아니다** — 승격 관문 5개를 전부 통과해야 한다.`)
}

export function limitsSection(opts: {
  uni: UsUniverse
  benchLabel: string
  variantCount: number
  pboMaxCombos: number
  pboExhaustive: boolean
  basis: ReturnBasis
  /** 이 실행이 어느 시세 소스로 돌았나 — 한계 문단이 소스별로 달라진다. */
  priceSource?: UsPriceSource
  /** 시세 출처 한 줄(어느 봉이 어느 소스에서 왔나). */
  sourceMix?: string
  synthetic?: boolean
  mappingByYear: string
}): void {
  log('')
  log('## 한계 · 편향 (규칙 3 — 숨기지 않는다)')
  log('')
  if (opts.synthetic)
    log(
      '⚠️ **이 실행은 합성 데이터다.** 아래 유니버스·생존편향·배당 항목은 **실데이터 경로**의 한계 설명이며 ' +
        '이 실행에는 해당하지 않는다. 형식이 깨지지 않는지 확인하려고 같은 섹션을 그대로 태운다.',
    )
  const items: string[] = []
  items.push(
    opts.uni.estimated
      ? `**🔴 [추정] 유니버스가 가장 큰 한계다.** ${opts.uni.sourceNote}. ` +
          '국장에서 같은 결함이 33차에 알파를 **+21.9%p → +2.6%p**로 무너뜨렸다 — 목록이 틀리면 이 회차의 수치도 틀린다. ' +
          '실측 목록으로 다시 돌리려면 `US_UNIVERSE=real`(커밋된 `public/data/us-pit/universe.json`)이다. ' +
          '다만 실측 목록은 **지수 구성종목**이라 시총 상위 N [추정]과 **의미가 다르므로** 두 수치를 나란히 놓고 ' +
          '"좋아졌다/나빠졌다"로 읽으면 거짓이다 — 새 기준선으로 읽어라.'
      : `✅ **실측 유니버스로 돌았다** — ${opts.uni.sourceNote}.`,
  )
  items.push(
    `**연도별 매핑률.** ${opts.mappingByYear}. 100%가 아닌 만큼이 상폐·티커 재사용 차단으로 빠진 표본이며, ` +
      '그 구간 성적은 **살아남은 종목 위주라 실제보다 후하다**(규칙 1-7). 티커 재사용은 차단(`US_BLOCKED_TICKERS`)해 ' +
      '"정직한 매핑 실패"로 계수했다 — 엉뚱한 소형주 시계열이 상폐 대형주 자리에 들어오는 조용한 오염보다 낫다.',
  )
  items.push(compareBasisNote(opts.basis, opts.priceSource ?? 'yahoo').replace(/^⚖️ /, '**배당 기준.** '))
  items.push(
    '**환율 미반영.** 전 구간 USD 기준 수익률이다. 원화 환산 시 원/달러 변동이 그대로 더해진다 — ' +
      '국장 표(원화)와 절대 수익률을 나란히 놓으면 안 된다.',
  )
  items.push(
    `**다중검정 — 미장 누적으로만 센다.** 이번 회차 ${opts.variantCount}변형은 같은 데이터·같은 유니버스를 또 한 번 본 것이다. ` +
      `누적 분모는 ${US_TRIALS_PRIOR_TOTAL} + ${opts.variantCount} = ${US_TRIALS_PRIOR_TOTAL + opts.variantCount}이며 DSR은 그 분모로 찍는다. ` +
      '**국장 누적(97+…)과 섞지 않았다** — 다른 데이터셋이라 선택편의가 같은 표본 위에 쌓이지 않는다.',
  )
  items.push(
    (opts.pboExhaustive
      ? `**PBO 조합.** C(${US_PBO_BLOCKS},${US_PBO_BLOCKS / 2}) 조합을 **전수 평가**했다(${opts.pboMaxCombos}개). `
      : `**PBO 조합 샘플링.** 변형이 ${opts.variantCount}개라 전수 평가는 예산을 넘는다 — ` +
        `${opts.pboMaxCombos}개만 **사전식 등간격 결정적 샘플링**으로 평가했다(난수 아님·재현 가능). `) +
      '단일 실행의 PBO는 크게 흔들린다(overfit.ts 주석 — 무신호 합성에서 0.09~0.89까지 퍼졌다) — ' +
      '숫자 하나로 결론짓지 말고 λ 분포·DSR·워크포워드를 함께 읽어라.',
  )
  items.push(
    '**고원 축이 사실상 분위 하나다.** 격자가 `분위 × 게이트` 2축인데 게이트는 값이 2개뿐이라 **모든 셀이 그 축의 끝**이다 ' +
      `(= 완전 내부 셀 0개, 전 셀 \`[표본부족]\`). 고원 판정은 실질적으로 **분위 축(${PCT_VALUES.join('·')}%)** 위에서만 이뤄진다 — ` +
      '없는 이웃을 0이나 평균으로 메우지 않았고, 그 방향의 고원성은 **검증되지 않았다**.',
  )
  items.push(
    '**고정 전제(격자 축이 아닌 것).** 동일가중 · 리밸런스 = 월 첫 거래일 시가 · 구간 끝 청산비용 근사 ON · ' +
      `연도별 유니버스 교체(6/30 편입 판정) · 그 해 매핑 ${MIN_SYMBOLS}종목 미만이면 현금 · ` +
      '게이트에 걸린 슬롯은 다른 종목으로 메우지 않고 현금. 이 전제를 바꾸면 격자 전체가 다른 실험이 된다.',
  )
  items.push(
    `**비용 [추정].** 수수료 ${COST_US.feePct}%(국내 증권사 해외주식 추정) · 거래세 ${COST_US.taxPct}%(미국은 매도 거래세 없음) · ` +
      `슬리피지 ${COST_US.slippagePct}%. 환전 스프레드·최소수수료·**미국 배당세(원천징수 15%)가 빠져 있다** — 실제 세후 수익은 이보다 낮다.`,
  )
  items.push(
    '**미국 대형주는 서로 상관이 매우 높다**(같은 지수·같은 매크로). 분위를 갈랐다고 분산까지 좋아지는 것은 아니다.',
  )
  items.push(
    (opts.priceSource ?? 'yahoo') === 'tiingo'
      ? '**시세 소스 = tiingo.** 2026-08-04 실사에서 **상폐를 주는 유일한 무료 소스**로 확인됐다(상폐 8종 중 회사일치 3 · ' +
          '대조군 4/4). 그래도 **전량은 아니다** — WorldCom·Enron은 404, LEH·BSC·TYC는 빈 배열이라 ' +
          '**생존편향은 줄어들 뿐 사라지지 않는다.** 무료 티어 호출 한도 수치와 빈 배열의 의미(티어 제한 vs 데이터 부재)는 ' +
          '`[미검증]`이다. 보정 기준(배당 반영 여부)은 **실행 중 실측 감사**로 확정했고, 미반영으로 판정되면 실행을 중단한다.'
      : '**시세 소스 = 야후(비공식 엔드포인트).** 정확성 미보증 · 호출 한도 문서 없음 `[미검증]` · 예고 없이 스키마가 바뀔 수 있다. ' +
          '무엇보다 **죽은 종목을 주지 않는다** — 상폐사가 통째로 빠져 성적이 후해진다(41차 2000년 매핑률 56/80). ' +
          '`US_PRICE_SOURCE=tiingo`로 그 구멍을 얼마나 메우는지 잴 수 있다.',
  )
  if (opts.sourceMix) items.push(`**시세 출처 기록.** ${opts.sourceMix}`)
  items.push('실패는 삼키지 않고 성공 카운터로 드러낸다 — 전량 실패는 비정상 종료다(규칙 4).')
  items.forEach((t, i) => log(`${i + 1}. ${t}`))
}

/** 보고서 본문. 승격 건수를 돌려준다. */
export function report(out: RunOutputs, inp: RunInputs, uni: UsUniverse, synthetic = false): number {
  const n = out.results.length
  const trialsCumulative = US_TRIALS_PRIOR_TOTAL + n

  // ---- 회차 단위 과최적화 채점 ------------------------------------------
  log('')
  log('## 과최적화 채점 (회차 단위 — 이 격자를 돌려 1등을 고르는 절차가 성립하는가)')
  log('')
  log(`· 변형 수 ${n} · 공통 거래일 ${out.dates.length}일 (정렬에서 버린 날 ${out.dropped}일)`)
  log(
    `· **PBO ${num(out.pbo.pbo)}** (임계 ${PBO_WARN_THRESHOLD}) — ${
      out.pbo.pbo == null
        ? `계산 불가: ${out.pbo.reason ?? '사유 없음'}`
        : out.pbo.pbo > PBO_WARN_THRESHOLD
          ? '❌ 인샘플 1위가 아웃샘플에서 중앙값 이하로 떨어질 확률이 반을 넘는다'
          : '✅ 임계 미만'
    }`,
  )
  log(
    `  블록 S=${out.pbo.blocks} · 블록당 ${out.pbo.blockSize}일 · 조합 ${out.pbo.combinationsEvaluated}/${out.pbo.combinationsTotal}` +
      `${out.pbo.exhaustive ? ' (전수)' : ' (등간격 결정적 샘플링)'} · λ 중앙값 ${num(out.pbo.medianLambda)}`,
  )
  for (const note of out.pbo.notes) log(`  ⚠️ ${note}`)
  log(
    `· **워크포워드 OOS 알파 ${pp(out.wf.oosAlphaPct)}** — ${
      out.wf.reason
        ? `계산 불가: ${out.wf.reason}`
        : (out.wf.oosAlphaPct ?? -1) > 0
          ? '✅ 양수'
          : '❌ 음수 — 그때그때 1등을 골랐어도 벤치를 못 이겼다'
    }`,
  )
  log(
    `  구간 ${out.wf.segments.length}개 (IS ${US_WF_IS_DAYS}일 → OOS ${US_WF_OOS_DAYS}일) · ` +
      `OOS 연환산 ${pp(out.wf.oosAnnualizedPct)} · 벤치(${inp.benchLabel}) 연환산 ${pp(out.wf.benchAnnualizedPct)} · ` +
      `IS→OOS 저하율 ${out.wf.degradationPct == null ? '—' : `${out.wf.degradationPct.toFixed(1)}%`}`,
  )
  for (const note of out.wf.notes.slice(0, 5)) log(`  ⚠️ ${note}`)

  // ---- DSR (미장 누적 분모) ---------------------------------------------
  const trialSharpes = out.results.map((r) => r.sharpeDaily).filter((v): v is number => v != null)
  // 승자 = 전 구간 칼마 1위(이 회차에 "그때그때 고르는 절차"를 시뮬레이션하는 것은 워크포워드다).
  let winner = -1
  let best = -Infinity
  out.results.forEach((r, i) => {
    if (r.calmar != null && r.calmar > best) {
      best = r.calmar
      winner = i
    }
  })
  log('')
  log(`### 다중검정 보정 — **미장 누적** 분모 ${US_TRIALS_PRIOR_TOTAL} + ${n} = ${trialsCumulative}`)
  log('')
  log('⚠️ **국장 누적(97 + …)과 섞지 않는다** — 다른 데이터셋·다른 유니버스라 선택편의가 같은 표본 위에 쌓이지 않는다.')
  for (const r of US_TRIALS_PRIOR) log(`· ${r.round}: ${r.n}변형`)
  log(`· 41차 (이번 us-lab): ${n}변형`)
  if (winner >= 0) {
    const w = out.results[winner]
    const m = sharpeMoments(w.dailyReturns)
    log('')
    log(`승자 판정 근거: **전 구간 칼마 1위** — \`${w.cell.key}\` (칼마 ${num(w.calmar)})`)
    if (m.sharpe == null) {
      log(`⚠️ 승자 샤프 계산 불가 — ${m.reason ?? '사유 없음'}. DSR을 낼 수 없다.`)
    } else {
      const mt = multipleTestingReport({
        observedSharpe: m.sharpe,
        sampleLength: m.sampleLength,
        trialSharpeVariance: variance(trialSharpes),
        skew: m.skew ?? undefined,
        kurtosis: m.kurtosis ?? undefined,
        trialsThisRound: n,
        trialsCumulative,
      })
      log(
        `· 이번 회차 N=${n} DSR ${num(mt.thisRound.dsr)} / **미장 누적 N=${trialsCumulative} DSR ${num(mt.cumulative.dsr)}** ` +
          `(임계 ${DSR_PASS_THRESHOLD})`,
      )
      log(
        `· 보정 전 p ${num(mt.rawPValue, 4)} · Bonferroni ${num(mt.bonferroniPValue, 4)} · Šidák ${num(mt.sidakPValue, 4)}`,
      )
      log(`· 판정: ${mt.verdict === 'pass' ? '✅' : mt.verdict === 'fail' ? '❌' : '❔'} ${mt.headline}`)
      const dsr = deflatedSharpeFromReturns(w.dailyReturns, trialSharpes, trialsCumulative)
      for (const note of dsr.notes) log(`  ⚠️ ${note}`)
    }
  }

  // ---- 27차 재현 --------------------------------------------------------
  reproSection(out, synthetic)

  // ---- 격자별 성적표 ----------------------------------------------------
  const roundGate = { pbo: out.pbo.pbo, wfOosAlpha: out.wf.oosAlphaPct }
  const verdicts: PromotionVerdict[] = new Array(n)
  for (const g of out.grids)
    for (const c of g.cells) verdicts[c.globalIndex] = promotionVerdict(out.results[c.globalIndex], g.plateau[c.index], roundGate)

  log('')
  log('## 격자별 성적')
  for (const g of out.grids) {
    const rows = g.cells.map((c) => out.results[c.globalIndex])
    variantTable(`${g.grid.label} — ${g.grid.question}`, rows, uni)
  }

  // ---- 분위 정합 단면 ---------------------------------------------------
  quantileCrossTable(out, uni, (r) => r.alphaFull, '분위 정합 가설 — 계열 × 분위 **전 구간 알파(%p)**', 1)
  quantileCrossTable(out, uni, (r) => r.calmar, '분위 정합 가설 — 계열 × 분위 **칼마(CAGR÷MDD)**', 3)

  // ---- 고원 채점 --------------------------------------------------------
  log('')
  log('## 고원 채점 — 분위를 흔들어도 성적이 유지되는 영역이 있는가')
  log('')
  log(estimateBanner(uni))
  log('')
  log(
    `· plateauScore = **셀과 이웃 성적의 최솟값**(평균 아님) · plateauDrop = (셀 − 이웃최솟값) ÷ |셀| · 고원 임계 ${US_DROP_THRESHOLD}`,
  )
  const allPlateau = out.grids.flatMap((g) => g.plateau)
  const scored = allPlateau.filter((p) => p.plateauScore != null)
  const interior = allPlateau.filter((p) => !p.sampleShort)
  log(`· 고원 점수를 낼 수 있는 셀 ${scored.length}/${n}개 · 완전 내부 셀 ${interior.length}개 · 경계 셀 **[표본부족] ${n - interior.length}개**`)
  log(
    '· ⚠️ 게이트 축은 값이 2개뿐이라 **모든 셀이 그 축의 끝**이다 — 완전 내부 셀이 0개인 것은 구조적 결과이며, ' +
      '고원 판정은 실질적으로 **분위 축** 위에서만 이뤄진다. 없는 이웃을 0·평균으로 메우지 않았다.',
  )
  const flat = scored.filter((p) => p.plateauDrop != null && (p.plateauDrop as number) <= US_DROP_THRESHOLD)
  log(
    `· plateauDrop ≤ ${US_DROP_THRESHOLD}인 셀 ${flat.length}개 · 그중 이웃 전부가 관문①②를 통과한 셀 ` +
      `${flat.filter((p) => p.neighborsPassLocal === true).length}개`,
  )

  const topRows: { g: GridOutput; p: PlateauScore }[] = []
  for (const g of out.grids) for (const p of g.plateau) if (p.plateauScore != null) topRows.push({ g, p })
  topRows.sort((x, y) => (y.p.plateauScore as number) - (x.p.plateauScore as number))
  log('')
  log('### 고원 점수 상위 15셀')
  log('')
  log('| 셀 | 칼마(셀) | 이웃최솟값 | **plateauScore** | plateauDrop | 이웃 | CAGR | MDD | 전반 알파 | 후반 알파 | 매매 | 관문 |')
  log('|---|---|---|---|---|---|---|---|---|---|---|---|')
  for (const { g, p } of topRows.slice(0, 15)) {
    const gi = g.cells[p.index].globalIndex
    const r = out.results[gi]
    const v = verdicts[gi]
    log(
      `| \`${r.cell.key}\`${p.sampleShort ? ' [표본부족]' : ''} | ${num(p.self)} | ${num(p.minNeighbor)} | ` +
        `**${num(p.plateauScore)}** | ${num(p.plateauDrop)} | ${p.neighbors}${p.sampleShort ? `(-${p.missing.length})` : ''} | ` +
        `${f1(r.full.cagr)}% | ${f1(r.full.mdd)}% | ${pp(r.alphaA)} | ${pp(r.alphaB)} | ${r.trades} | ` +
        `${v.promoted ? '✅ 승격' : `❌ ${v.failed.join('·')}`} |`,
    )
  }
  if (topRows.length === 0) log('| — | — | — | — | — | — | — | — | — | — | — | 고원 점수를 낼 수 있는 셀이 없다 |')

  // ---- 승격 판정 --------------------------------------------------------
  log('')
  log('## 승격 관문 — ①전·후반 알파 ②매매≥20 ③PBO<0.5 ④WF OOS 알파>0 ⑤고원 (국장 39차와 **같은 잣대**)')
  log('')
  const cnt = (k: number) => verdicts.filter((v) => v.passed.includes(k)).length
  log('| 관문 | 통과 변형 |')
  log('|---|---|')
  log(`| ① 전·후반 알파 양수 | ${cnt(1)} / ${n} |`)
  log(`| ② 매매수 ≥ ${US_MIN_TRADES} | ${cnt(2)} / ${n} |`)
  log(`| ③ PBO < ${PBO_WARN_THRESHOLD} | ${cnt(3)} / ${n} (회차 단위 값이라 전부 같다) |`)
  log(`| ④ 워크포워드 OOS 알파 > 0 | ${cnt(4)} / ${n} (회차 단위 값이라 전부 같다) |`)
  log(`| ⑤ 고원(drop ≤ ${US_DROP_THRESHOLD} + 이웃 전부 ①② 통과) | ${cnt(5)} / ${n} |`)
  log('')
  const promoted = verdicts.map((v, i) => ({ v, i })).filter((x) => x.v.promoted)
  if (promoted.length === 0) {
    log('### ✅ 결론: **승격 0건**')
    log('')
    log(
      '다섯 관문을 전부 통과한 변형이 없다. **가장 덜 나쁜 변형을 승격시키지 않는다** — 그렇게 고른 것이 ' +
        '아웃샘플에서 무너지는 것이 38·39차에서 이미 측정됐다. 이 회차의 답은 "이 격자에는 승격시킬 것이 없다"이다.',
    )
  } else {
    log(`### 승격 후보 ${promoted.length}건`)
    log('')
    log(estimateBanner(uni))
    log('')
    log('| 셀 | plateauScore | plateauDrop | 칼마 | 알파(전구간) | 전반 알파 | 후반 알파 | 매매 |')
    log('|---|---|---|---|---|---|---|---|')
    for (const { i } of promoted) {
      const r = out.results[i]
      const g = out.grids.find((x) => x.grid.id === r.gridId)!
      const p = g.plateau[r.cell.index]
      log(
        `| \`${r.cell.key}\`${p.sampleShort ? ' **[표본부족]**' : ''} | ${num(p.plateauScore)} | ${num(p.plateauDrop)} | ` +
          `${num(r.calmar)} | ${pp(r.alphaFull)} | ${pp(r.alphaA)} | ${pp(r.alphaB)} | ${r.trades} |`,
      )
    }
    log('')
    log(
      '⚠️ 승격은 "채택"이 아니다. **[추정] 유니버스 위의 결과**이므로 실측 목록 재실행 전에는 확정이 아니며, ' +
        '`[표본부족]` 라벨이 붙은 셀은 격자 경계라 한쪽 방향의 고원성이 **검증되지 않았다**.',
    )
  }
  log('')
  log(`전·후반 분할: 전반 ${inp.years[0]}~${inp.halfYear - 1} / 후반 ${inp.halfYear}~${inp.years[inp.years.length - 1]}`)
  return promoted.length
}

/** 연도별 매핑률 한 줄 — 잔존 생존편향의 크기를 그대로 드러낸다(규칙 3). */
export function mappingLine(ctxs: readonly YearCtx[]): string {
  return ctxs.map((c) => `${c.y}:${c.symbols.length}/${c.totalCodes}`).join(' ')
}

// ============================================================================
// 15. 자기검증 (합성 데이터 — 파일·네트워크 불필요)
// ============================================================================

/** 결정적 난수 — Math.random 금지(재현성). */
export function rng(seed: number): () => number {
  let s = seed
  return () => {
    s |= 0
    s = (s + 0x6d2b79f5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * 합성 일봉 — 주말 포함(달력 경계 판정만 보므로 무해). **거래량도 흔든다** —
 * 거래량이 상수면 volrank 계열이 전부 동점이 돼 그 경로가 검증되지 않는다.
 */
export function syntheticBars(seed: number, from: string, days: number, base = 100, drift = 0): DailyBar[] {
  const rnd = rng(seed)
  const t0 = Date.parse(`${from}T00:00:00Z`)
  const bars: DailyBar[] = []
  let px = base
  for (let i = 0; i < days; i++) {
    const t = t0 + i * 86400e3
    const date = new Date(t).toISOString().slice(0, 10)
    px *= 1 + drift + (rnd() - 0.5) * 0.04
    if (!(px > 1)) px = 1
    const o = px * (1 + (rnd() - 0.5) * 0.005)
    const c = px
    bars.push({
      date,
      t: Math.floor(t / 1000),
      o,
      h: Math.max(o, c) * 1.005,
      l: Math.min(o, c) * 0.995,
      c,
      v: 1e6 * (0.5 + rnd()),
    })
  }
  return bars
}

/** 합성 유니버스 — 변형 시간 측정·배선 확인용. */
export function syntheticWorld(nSyms = 30, years = 10, seed = 41) {
  const from = '2009-01-01'
  const days = (years + 2) * 365
  const histories: Record<string, DailyBar[]> = {}
  const codes: string[] = []
  for (let i = 0; i < nSyms; i++) {
    const code = `S${String(i).padStart(3, '0')}`
    codes.push(code)
    histories[code] = syntheticBars(seed + i * 17, from, days, 100 + i, (i - nSyms / 2) * 0.00005)
  }
  const yearList: number[] = []
  for (let y = 2010; y < 2010 + years; y++) yearList.push(y)
  return { histories, codes, years: yearList, codesFor: () => codes }
}

/**
 * 유니버스 **동일가중 지수**(합성 벤치). 매일 그날 봉이 있는 종목의 일별 수익률을
 * 단순평균해 잇는다. ⚠️ 이것은 SPY가 **아니다** — 합성 실행 전용이다.
 */
export function equalWeightIndex(histories: Record<string, DailyBar[]>, codes: readonly string[], from: string): Curve {
  const series = codes.map((c) => histories[c]).filter((b): b is DailyBar[] => Array.isArray(b) && b.length > 1)
  if (series.length === 0) return []
  const closeOf = series.map((bars) => {
    const m = new Map<string, number>()
    for (const b of bars) if (b.c > 0) m.set(b.date, b.c)
    return m
  })
  const dates = new Set<string>()
  for (const m of closeOf) for (const d of m.keys()) if (d >= from) dates.add(d)
  const cal = [...dates].sort()
  const out: Curve = []
  let eq = 100
  let prev = ''
  for (const d of cal) {
    if (prev === '') {
      out.push({ date: d, equity: eq })
      prev = d
      continue
    }
    let sum = 0
    let cnt = 0
    for (const m of closeOf) {
      const a = m.get(prev)
      const b = m.get(d)
      if (a != null && b != null && a > 0) {
        sum += b / a - 1
        cnt++
      }
    }
    if (cnt > 0) eq *= 1 + sum / cnt
    out.push({ date: d, equity: eq })
    prev = d
  }
  return out
}

// ============================================================================
// 16. main
// ============================================================================

export function modeFromEnv(raw = process.env.MODE): Mode {
  const m = (raw ?? 'all').trim().toLowerCase()
  if (m === 'xsmom' || m === 'quantile' || m === 'all' || m === 'quick' || m === 'selftest') return m
  throw new Error(`알 수 없는 MODE=${m} — xsmom | quantile | all | quick | selftest 중 하나여야 한다`)
}

const HEADLINE = [
  '# 41차 — 미장 전략 탐색 (us-lab)',
  '',
  '국장은 오늘까지 **판정 통과 0**이 확정됐다(34·38·39·40차 · 누적 500변형 이상). 그래서 미장으로 무게를 옮긴다.',
  '미장에서 지금까지 통한 것은 **US PIT 80 위의 12-1 횡단면 모멘텀 하나뿐**이고(27차 · 상위8+게이트 알파 +4.7%p),',
  '상위 20에서는 같은 계열이 전패했다(26차 0/6). 그 차이가 **계열이 아니라 분위**일 수 있다는 것이 이 회차의 가설이다',
  '— 상위 20의 "상위 5"는 이미 상위 25%라 학계 표준(상위 10%)보다 신호가 훨씬 묽다.',
  '',
  '**그래서 다섯 계열을 전부 같은 분위(상위 X%)로 맞춰 돌린다.** "상위 N"이 아니라 "상위 X%"로 슬롯을 정하는 것이',
  '이 회차의 요점이다. 판정 관문은 국장 39차와 **같은 다섯 개**이며 느슨하게 하지 않는다.',
  '통과가 0이면 0으로 보고한다 — 가장 덜 나쁜 변형을 승격시키는 경로는 코드에 없다.',
]

async function main(): Promise<void> {
  const mode = modeFromEnv()
  for (const l of HEADLINE) log(l)
  log('')
  log(`MODE=${mode}`)

  if (mode === 'selftest') {
    await runSelftest()
    return
  }

  // ---- 유니버스 ---------------------------------------------------------
  const uni = pickUniverse(process.env.US_UNIVERSE)
  log('')
  log(estimateBanner(uni))
  log(
    `유니버스: ${uni.label} (연 ${uni.size}종목 · 조회 합집합 ${uni.union.length}티커 · ` +
      `${uni.years.length}개 연도 ${uni.years[0]}~${uni.years[uni.years.length - 1]} · 전·후반 경계 ${uni.halfYear})`,
  )
  log(`⚠️ ${uni.sourceNote}`)

  // ---- 시세 소스 · 비교 기준(배당) — **한 곳에서** 정한다 ---------------
  const priceSource = pickPriceSource()
  const basis = compareBasisFor(priceSource)
  // 키는 loadSecret 하나로만 읽는다(규칙 2-1). 값은 출력하지 않고 loadSecret가 출처·길이만 찍는다.
  const tiingoKey = priceSource === 'tiingo' ? loadTiingoKey() : null
  if (priceSource === 'tiingo' && !tiingoKey?.value)
    throw new Error(
      `US_PRICE_SOURCE=tiingo인데 TIINGO_API_KEY가 없다 — 야후로 조용히 내려가지 않는다.\n${tiingoKey?.help ?? ''}`,
    )
  log('')
  log(`시세 소스: **${priceSource}** (US_PRICE_SOURCE · 기본 yahoo — 41차 수치와의 연속성)`)
  if (priceSource === 'tiingo') {
    log('   왜: 야후는 죽은 종목을 주지 않는다(41차 2000년 매핑률 56/80). 2026-08-04 실사에서')
    log('   tiingo만 상폐를 줬다(상폐 8종 중 회사일치 3 · 대조군 4/4). 남는 생존편향은 매핑률로 잰다.')
    for (const u of TIINGO_UNVERIFIED) log(`   · [미검증] ${u}`)
  }
  log(compareBasisNote(basis, priceSource))

  // ---- 격자 -------------------------------------------------------------
  const grids = gridsForMode(mode)
  const variantCount = countVariants(grids)
  log('')
  log(`격자 ${grids.length}개 · 변형 **${variantCount}개**`)
  for (const g of grids)
    log(`· \`${g.id}\` ${g.label} — ${g.axes.map((a) => `${a.key}[${a.values.join(',')}]`).join(' × ')} = ${g.axes.reduce((s, a) => s * a.values.length, 1)}변형`)

  // ---- 시세 (한 소스로만 · 규칙 4) --------------------------------------
  const tally = newPriceTally()
  const delay = fetchDelayMs()
  const token = tiingoKey?.value ?? null
  const fetchOne = (sym: string): Promise<DailyBar[] | null> => tallyFetch(tally, sym, US_RANGE, 200, priceSource, token)
  log('')
  log(
    `시세 수집 시작 — ${priceSource} ${uni.union.length + 2}건(유니버스 ${uni.union.length} + 벤치 ${BENCH_US} + 벽 ${WALL_QQQ}) · 호출 간격 ${delay}ms`,
  )
  const histories: Record<string, DailyBar[]> = {}
  const fetchT0 = Date.now()
  for (const ticker of uni.union) {
    const bars = await fetchOne(ticker)
    if (bars) histories[ticker] = bars
    await sleep(delay)
  }
  log(
    `시세 로드 ${Object.keys(histories).length}/${uni.union.length} · 실패(상폐·데이터 부족·차단) ${uni.union.length - Object.keys(histories).length}건 · ` +
      `${((Date.now() - fetchT0) / 1000).toFixed(0)}초`,
  )
  {
    const failedSyms = tally.failed.map((f) => f.symbol)
    if (failedSyms.length) {
      const shown = failedSyms.slice(0, 25).map((t) => `${t}(${US_COMPANY_NAMES[t]?.split(' —')[0] ?? '?'})`)
      log(`실패 티커: ${shown.join(', ')}${failedSyms.length > 25 ? ` … 외 ${failedSyms.length - 25}개` : ''}`)
      log('  ↑ 이들이 빠지는 것이 곧 잔존 생존편향이다 — 연도별 매핑률로 크기를 잰다(상폐 티커의 404는 정상적인 결과다).')
    }
  }
  log(sourceMixLine(tally))
  // 성공 카운터 — 유니버스가 **전량 실패**면 여기서 죽는다(항목별 try/catch가 오류를 삼켜
  // "다 실패했는데 종료코드 0"이 되는 것을 막는다 · 규칙 4-2).
  if (uni.union.length > 0 && Object.keys(histories).length === 0)
    throw new Error(
      `${priceSource} 시세를 한 종목도 받지 못했다(시도 ${tally.attempted}건 전량 실패) — 결과를 근거로 쓰지 마라. ` +
        `첫 사유: ${tally.failed[0]?.reason ?? '없음'}`,
    )

  // ---- 벤치 (실패하면 즉시 비정상 종료 — 규칙 4·5) ----------------------
  const benchBars = await fetchOne(BENCH_US)
  if (!benchBars)
    throw new Error(
      `벤치(${BENCH_US}) 로드 실패 — 알파 판정(규칙 5)이 불가능하므로 실행을 중단한다. ` +
        `사유: ${tally.failed.map((f) => `${f.symbol}: ${f.reason}`).join(' / ')}. 다른 벤치로 조용히 대체하지 않는다.`,
    )
  const benchEq: Curve = benchBars.filter((b) => b.c > 0).map((b) => ({ date: b.date, equity: b.c }))
  const benchLabel = `${BENCH_US} (S&P 500 ETF)`

  // ---- 🔴 배당·분할 기준 게이트 (tiingo 경로 전용) ----------------------
  // 벤치(SPY)의 실제 응답으로 판정한다 — 27년이면 배당락 사건이 100건 남짓이라 표본이 넉넉하다.
  // 여기서 막지 않으면 40차에서 제거한 배당 비대칭이 조용히 되살아난다.
  if (priceSource === 'tiingo') {
    const benchAudit = tally.audits.find((a) => a.symbol === BENCH_US)?.audit
    if (!benchAudit) throw new Error(`벤치(${BENCH_US})의 tiingo 보정 감사 결과가 없다 — 기준을 확인하지 않은 채 돌지 않는다.`)
    log('')
    log(tiingoBasisGate(benchAudit))
    const uniAudits = tally.audits.filter((a) => a.symbol !== BENCH_US)
    const byVerdict = { total: 0, price: 0, unknown: 0 }
    for (const a of uniAudits) byVerdict[a.audit.verdict]++
    log(
      `   유니버스 종목 감사 분포: 총수익 ${byVerdict.total} · 가격수익 ${byVerdict.price} · 판정불가 ${byVerdict.unknown}` +
        `(배당 이력이 짧은 종목은 판정불가가 정상이다)`,
    )
    if (byVerdict.price > 0)
      throw new Error(
        `⛔ 유니버스 ${byVerdict.price}종목에서 tiingo adj*가 **배당 미반영**으로 판정됐다 — 종목마다 기준이 다르면 ` +
          '횡단면 랭킹 자체가 거짓이 된다. 실행을 중단한다.',
      )
  }

  log('')
  log(
    `벤치: ${benchLabel} ${benchBars.length}봉 (${benchBars[0].date} ~ ${benchBars[benchBars.length - 1].date}) · ` +
      `총수익(${priceSource} adjClose 계수) — 알파는 이 구간과 겹치는 부분에서만 계산한다.`,
  )
  log(`데이터 신선도: 벤치 최신 봉 **${benchBars[benchBars.length - 1].date}**. 여기서 멈췄다는 뜻이다.`)

  // ---- 연도 컨텍스트(파라미터 무관 — 한 번만 만든다) --------------------
  const resolve = (code: string) => resolveUsTicker(code, (s) => !!histories[s]?.length)
  // 연도·경계는 **유니버스가 정한다** — [추정] 목록은 US_PIT_YEARS 고정(41차 연속성),
  // 실측 목록은 되감기 신뢰구간(reliableFrom~)이 정한다.
  const ctxs = buildYearCtxs(histories, uni.years, uni.codesFor, resolve)
  const usable = ctxs.filter((c) => c.symbols.length >= MIN_SYMBOLS)
  const mapping = mappingLine(ctxs)
  log('')
  log(`연도 컨텍스트 ${ctxs.length}년 · 실행 가능(매핑 ${MIN_SYMBOLS}종목 이상) ${usable.length}년`)
  log(`연도별 매핑률: ${mapping}`)
  log('매핑률이 100%가 아닌 만큼이 상폐·재사용 티커로 빠진 표본이다 — 그 구간 성적은 실제보다 후하다(규칙 1-7).')
  if (usable.length < 2)
    throw new Error(
      '실행 가능한 연도가 2년 미만이다 — 시세 매핑이 사실상 전멸했다. 조용히 통과시키지 않고 비정상 종료한다(규칙 4).',
    )

  // ---- 격자 실행 --------------------------------------------------------
  log('')
  const t0 = Date.now()
  const inputs: RunInputs = {
    grids,
    ctxs,
    years: uni.years,
    cost: COST_US,
    benchCurve: benchEq,
    benchLabel,
    halfYear: uni.halfYear,
  }
  const out = runGrids(inputs, (done, total, ms) => {
    if (done === 1) log(`1변형 실측 ${ms}ms → ${total}변형 예상 ${((ms * total) / 1000).toFixed(0)}초 (격자 실행분만)`)
    if (done % 10 === 0 || done === total) log(`  격자 진행 ${done}/${total} · 경과 ${((Date.now() - t0) / 1000).toFixed(0)}초`)
  })
  log(
    `격자 실행 ${(out.gridMs / 1000).toFixed(1)}초 (${out.results.length}변형 · 1변형 ${out.firstVariantMs}ms · ` +
      `평균 ${(out.gridMs / Math.max(1, out.results.length)).toFixed(0)}ms) + 사후 채점 ${(out.scoringMs / 1000).toFixed(1)}초` +
      `(PBO가 지배적) = 합계 ${((out.gridMs + out.scoringMs) / 1000).toFixed(1)}초`,
  )

  const promotedCount = report(out, inputs, uni)

  // ---- 참고 벽 (선택 — 실패해도 격자 결과는 그대로 선다) -----------------
  const span = out.dates.length ? [out.dates[0], out.dates[out.dates.length - 1]] : null
  if (span) {
    log('')
    log(`## 참고 벽 — 전략 구간(${span[0]} ~ ${span[1]})으로 **다시 잰** 단순보유. 판정 벤치가 아니다.`)
    log('')
    log(estimateBanner(uni))
    log('')
    await sleep(delay)
    // 벽도 **같은 소스**로 받는다 — 벤치와 벽이 각자 다른 기준으로 로드된 것이 국장 40차 사고였다.
    const qqq = await fetchOne(WALL_QQQ)
    const walls: WallStats[] = []
    const bw = wallOf(`${BENCH_US} 보유 (알파 판정 벤치)`, benchEq, span[0], span[1])
    if (bw) walls.push(bw)
    if (qqq) {
      const qCurve: Curve = qqq.filter((b) => b.c > 0).map((b) => ({ date: b.date, equity: b.c }))
      const w = wallOf(`${WALL_QQQ} 단순보유 (참고 벽)`, qCurve, span[0], span[1])
      if (w) walls.push(w)
      else log(`⚠️ ${WALL_QQQ} 곡선이 구간과 겹치지 않는다 — 벽 행 생략`)
    } else {
      log(`⚠️ ${WALL_QQQ} 로드 실패 — 벽 행 생략(격자 결과는 그대로다). 사유는 아래 야후 집계 참조.`)
    }
    if (walls.length > 0) {
      log('| 벽 | 총수익 | CAGR | MDD | 칼마 | 구간 |')
      log('|---|---|---|---|---|---|')
      for (const w of walls)
        log(`| ${w.label} | ${f1(w.totalPct)}% | ${f1(w.cagrPct)}% | ${f1(w.mddPct)}% | ${num(w.calmar)} | ${w.from}~${w.to} |`)
      const q = walls.find((w) => w.label.startsWith(WALL_QQQ))
      if (q?.calmar != null) {
        const over = out.results.filter((r) => r.calmar != null && (r.calmar as number) > (q.calmar as number))
        log('')
        log(
          over.length === 0
            ? `→ ${WALL_QQQ} 단순보유 벽(칼마 ${num(q.calmar)})을 넘은 변형: **없음**`
            : `→ ${WALL_QQQ} 벽을 넘은 변형 ${over.length}개: ${over.slice(0, 10).map((r) => `\`${r.cell.key}\``).join(', ')}` +
                `${over.length > 10 ? ' …' : ''} — ⚠️ 벽을 넘었다는 것과 승격은 다른 판정이다.`,
        )
      }
    }
  }

  // ---- 야후 집계 (규칙 4 — 성공 카운터를 반드시 찍는다) ------------------
  log('')
  log(`야후 호출 집계: 시도 ${tally.attempted} · 성공 ${tally.ok} · 실패 ${tally.failed.length}`)
  for (const f of tally.failed.slice(0, 40)) log(`  ❌ ${f.symbol} — ${f.reason}`)
  if (tally.failed.length > 40) log(`  … 외 ${tally.failed.length - 40}건`)
  if (tally.ok === 0) throw new Error('야후 호출이 전량 실패했다 — 조용히 통과시키지 않고 비정상 종료한다(규칙 4).')

  limitsSection({
    uni,
    benchLabel,
    variantCount: out.results.length,
    pboMaxCombos: out.pbo.combinationsEvaluated,
    pboExhaustive: out.pbo.exhaustive,
    basis,
    priceSource,
    sourceMix: sourceMixLine(tally),
    mappingByYear: mapping,
  })
  for (const l of DISCLAIMER) log(l)
  log('')
  log(`## 한 줄 결론 — 승격 ${promotedCount}건 / ${out.results.length}변형 (${uni.label}${uni.estimated ? ' · **[추정] 유니버스**' : ''})`)
}

/** 합성 자기검증 — 파일·네트워크 없이 배선과 판정 산술이 도는지 확인한다. */
async function runSelftest(): Promise<void> {
  log('')
  log('## 자기검증 (합성 데이터 — 실데이터가 아니다. **이 표의 수치로 어떤 판정도 하지 않는다**)')
  const world = syntheticWorld(30, 10, 41)
  const ctxs = buildYearCtxs(world.histories, world.years, world.codesFor, (c) => c)
  const bench = equalWeightIndex(world.histories, world.codes, `${world.years[0]}-01-01`)
  const grids = gridsForMode('selftest')
  const uni: UsUniverse = {
    key: 'synthetic',
    size: world.codes.length,
    label: '합성 유니버스',
    codesFor: world.codesFor,
    union: world.codes,
    sourceNote: '유니버스: 합성 시계열(실데이터가 아니다)',
    estimated: true,
  }
  const inputs: RunInputs = {
    grids,
    ctxs,
    years: world.years,
    cost: COST_US,
    benchCurve: bench,
    benchLabel: '합성 동일가중',
    halfYear: halfYearOf(world.years),
  }
  const out = runGrids(inputs)
  log('')
  log(
    `변형 ${out.results.length}개 · 격자 ${(out.gridMs / 1000).toFixed(2)}초(1변형 ${out.firstVariantMs}ms) + ` +
      `채점 ${(out.scoringMs / 1000).toFixed(2)}초 · 공통 거래일 ${out.dates.length}일`,
  )
  log('')
  log('### 예산 역산 (GHA 타임아웃 45분 = 2,700초)')
  const per = out.gridMs / Math.max(1, out.results.length)
  log(
    `· 합성 1변형 평균 ${per.toFixed(0)}ms (종목 ${world.codes.length} · ${world.years.length}년). ` +
      `실데이터는 종목 ${US_UNI80.size}·${US_PIT_YEARS.length}년이라 대략 ` +
      `${((per * (US_UNI80.size / world.codes.length) * (US_PIT_YEARS.length / world.years.length)) / 1000).toFixed(2)}초/변형 [추정].`,
  )
  log(
    `· MODE=all 변형 수 ${countVariants(gridsForMode('all'))}개 → 격자 실행 [추정] ` +
      `${((per * (US_UNI80.size / world.codes.length) * (US_PIT_YEARS.length / world.years.length) * countVariants(gridsForMode('all'))) / 1000).toFixed(0)}초. ` +
      `시세 수집 ${US_UNI80.union.length + 2}건 × (호출 + ${fetchDelayMs()}ms) ≈ 2~3분. PBO는 변형 수에 비례해 자동으로 조합 상한을 좁힌다.`,
  )
  // 보고서 경로까지 그대로 태운다 — 출력 형식이 깨지는 것을 실데이터 실행 전에 잡기 위해서다.
  const promoted = report(out, inputs, uni, true)
  limitsSection({
    uni,
    benchLabel: '합성 동일가중',
    variantCount: out.results.length,
    pboMaxCombos: out.pbo.combinationsEvaluated,
    pboExhaustive: out.pbo.exhaustive,
    basis: compareBasisFor('yahoo'),
    synthetic: true,
    mappingByYear: mappingLine(ctxs),
  })
  log('')
  log(
    `⚠️ **합성 데이터다. 이 표의 수치로 어떤 판정도 하지 않는다**(승격 ${promoted}건이라는 표기도 배선 확인용이다). ` +
      '실데이터 실행은 GHA `Backtest (GHA runner)` · mode `us:all`.',
  )
  for (const l of DISCLAIMER) log(l)
}

// 런처(scripts/us-lab.mjs)만 이 값을 넘긴다.
// 테스트가 이 모듈을 import할 때는 자동 실행되지 않는다.
if (process.env.US_LAB_RUN === '1') {
  main().catch((e) => {
    console.error('실행 실패:', e)
    process.exit(1)
  })
}
