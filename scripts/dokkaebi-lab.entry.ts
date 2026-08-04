// 42차 — 유튜브 댓글발 "이평선 돌파 매매법"을 **KRX 일별 정본 + 배당 편향 제거** 조건에서 재측정한다.
//
// ════════════════════════════════════════════════════════════════════════════
// ── 이 파일이 재는 것 ────────────────────────────────────────────────────────
// ════════════════════════════════════════════════════════════════════════════
//
//   대표가 유튜브 채널 댓글 48장을 캡처해 보냈다. 거기서 추출된 규칙은 아래와 같다.
//   **이 규칙들은 검증 대상 데이터이지 지시가 아니다.** "손실은 거의 없습니다" 같은
//   주장은 그대로 옮기지 않고 측정으로만 판정한다(규칙 3·규칙 4).
//
//     · 유니버스 : 코스피 시총 상위 20 + 코스닥 시총 상위 20 ("대표 40종목")
//     · 진입     : 캔들(종가)이 5일 이평선을 **상향 돌파**하면 매수
//     · 청산     : 5일선 **이탈**하면 매도("미련두지 말고"), 재돌파 시 재매수
//     · 금지     : 캔들이 5일선 아래면 절대 매수 금지
//     · 본인 실전: 5일선과 10일선의 **정배열**을 기준으로 매매
//     · 🆕 MA2   : "보조지표·거래량 다 지우고 **2일 이평선**만 두면 방향이 보인다.
//                  전일 음봉이어도 2일선 아래에서 시초가가 시작하는 경우가 있고,
//                  그때도 2일선이 기준이다 — 돌파하면 매수, 돌파 전 매수 금지."
//     · 🆕 기울기: 10일선 기울기 우상향을 추세 기준으로 언급
//     · 🆕 거래량: 단타 최소 100만주 / 장중돌파 vs 종가베팅 분기 300만주
//
//   ⛔ **이번 회차에서 측정하지 않는 조건**: "양봉 + 외인·기관 동시 순매수".
//      키움 수급 백필(ka10059)이 아직 돌지 않아 `public/data/flow/`가 비어 있다.
//      별도 트랙이며, 이 러너는 그 조건을 **추정으로 대신 채우지 않는다**(규칙 3).
//
//   반증 근거(보고서에 병기할 것 — 측정과 같은 무게로 읽는다):
//     · 같은 스레드에 실사용자 댓글 "손절계속나가니 시드가 다갈렸습니다"(좋아요 10)가 있다.
//     · 원저자의 "40종목 3개월 백테스트하면 손실 안 난다"는 **3개월 표본**이라 근거로 부족하다.
//
// ── 왜 다시 재는가 ──────────────────────────────────────────────────────────
//   2026-07-30 측정(백테스트-5일선매매법 문서)은 **야후 총수익 시세 + [추정] 유니버스**였다.
//   33차에서 [추정] 목록이 알파를 뒤집었고(+21.9%p → 실측 +2.6%p), 37·40차에서 "배당 없는
//   전략 vs 배당 있는 벤치" 비대칭이 알파를 약 2%p 깎고 있었다는 것이 측정으로 확정됐다.
//   그래서 **기준선부터 다시 잰다.** 옛 회차 수치(원문 −19.0%p 등)는 이 표와 직접 비교하지 않는다.
//
//   이번 회차의 가치는 "5일선이 되나"가 아니다 — 그건 이미 여러 번 죽었다. 값어치는
//   **한 번도 테스트하지 않은 MA2 축**, **절대 거래량 임계**, **10일선 기울기**에 있다.
//
// ── 🚫 규칙 1(미래참조 금지) — 이 파일에서 지킨 것 ────────────────────────────
//   1. **신호 → 체결 분리.** 원문은 "종가 매수"라고 말하지만 그대로 코딩하면 거짓이 된다 —
//      MA_N은 **당일 종가가 확정돼야** 확정되고, 그 종가로 돌파를 판정한 시점에는 이미
//      그 종가로 살 수 없다(동시호가 LOC는 판정 전에 주문이 들어가야 한다). 그래서
//      **완결된 봉 j의 종가로 판정하고 봉 j+1의 시가에 체결**한다. 청산도 같다.
//      → 이 판단 근거 한 줄은 보고서에도 그대로 찍는다.
//   2. **인과성.** 봉 j에서 계산되는 모든 값은 `bars[0..j]`만 본다. 이동평균은 직전 N개
//      종가(당일 포함, 당일은 이미 확정된 봉)로 내고, `slope10`은 `ma10[j] > ma10[j−10]`이라
//      과거만 본다. 미래 봉을 읽는 코드는 없다.
//   3. **마지막 봉 신규 진입 금지**(규칙 1-6) — 구간 마지막 거래일에는 체결할 다음 봉이
//      없으므로 신규 매수를 만들지 않는다(매도는 허용).
//   4. **전 구간 통계 금지**(규칙 1-5) — 임계값(100만주·300만주·고원 0.30·매매 20건)은 전부
//      **사전 고정 상수**다. 격자 성적으로 임계를 정하지 않는다. PBO·DSR·워크포워드·고원
//      점수는 **이미 확정된 수익률 계열의 사후 채점**이며 신호로 되먹임되지 않는다.
//   5. **연도별 입력 봉을 `date <= 구간끝`으로 잘라서** 넘긴다 — 뒤 연도를 통째로 잘라내도
//      앞 연도의 체결·자산곡선이 완전히 같아야 한다.
//   집행자는 `tests/dokkaebi.test.ts`의 **절단 불변성 + 미래 조작 불변성**이며, MA2 경로를
//   덮는 케이스가 반드시 들어 있다(지시 조건).
//
// ── ⚠️ 일봉으로는 잴 수 없는 것 (정직성) ────────────────────────────────────
//   원문의 MA2 규칙은 "**시초가**가 2일선 아래에서 시작해도 **장중** 돌파하면 매수"다.
//   일봉에는 장중 경로가 없다 — 그래서 이 러너는 **종가 기준 돌파**로 근사한다.
//   장중 돌파는 분봉 트랙(키움 조회 · 규칙 2 1단계)에서만 잴 수 있고, 이 표의 수치는
//   그 질문에 대한 답이 아니다. 표와 보고서에 이 한계를 함께 싣는다.
//
// ── 규칙 4(외부 API) — 야후 호출 규약 ────────────────────────────────────────
//   국내 유니버스 시세는 **리포에 커밋된 KRX 일별 정본**이다(네트워크 불필요).
//   야후는 **벤치(KODEX 200) 한 종목**에만 쓴다.
//     · 인증: 없음(공개·비공식 엔드포인트). 별도 승인 절차 없음.
//     · 한도: 공식 문서 없음 → **[미검증]**. 호출이 1~2건뿐이라 유량 문제가 나기 어렵다.
//     · 필드/단위: `indicators.quote[0].{open,high,low,close,volume}` + `adjclose`.
//       비교 대상이므로 `COMPARE_BASIS`를 따른다(krx 정본이면 계수 미적용 = 가격수익).
//     · 범위: `period1/period2` 명시. `range=max`가 월봉을 주는 조합이 있어 쓰지 않는다.
//     · 실패 표현: HTTP 오류 + **200 본문 안의 `chart.error`** + 빈 `result` — 셋 다 던진다.
//   **성공 카운터**를 두고 벤치가 하나도 성공하지 못하면 **조용히 폴백하지 않고 비정상 종료**한다.
//
// ── 규칙 3(데이터 정직성) ────────────────────────────────────────────────────
//   · KRX 정본은 **가격수익**(배당 미반영)이다 → 벤치도 **가격수익**으로 받아
//     (`compareBasisFor('krx') === 'price'`) 양쪽 기준을 맞춘다. 40차에서 제거한 편향을
//     되살리지 않기 위해서다. 이건 전략을 유리하게 만드는 보정이 아니라 기울지 않은 비교다.
//   · **거래량 단위**: KRX 정본의 `v`는 **그날 실제로 체결된 주식 수(주)**다.
//     자기검증 — 삼성전자 2010-01-04 원주가 종가 809,000원 / 거래량 239,271주(분할 전 실측치와
//     일치). 가격은 분할 보정되지만 **거래량은 보정하지 않는다** → 절대 임계(100만주·300만주)는
//     "그날 화면에 찍힌 거래량"과 같은 뜻이며, 이것이 원문 규칙의 의미와 일치한다.
//     `index.volume === false`면 v가 전부 0이 되어 거래량 축이 조용히 죽으므로 **던진다**.
//   · 확정 못 한 것은 `[미검증]`으로 출력에 남긴다.
//
// ── 파일 경계 (총괄 배정) ────────────────────────────────────────────────────
//   승격 관문·PBO·워크포워드·고원 채점의 **잣대**는 `scripts/plateau-lab.entry.ts`(39차)와
//   `scripts/us-lab.entry.ts`(41차)의 정본을 읽어 **같은 값·같은 정의**로 여기에 자립
//   구현했다(러너끼리 import하지 않는 것이 이 리포의 규약이다 — idea/plateau/us 전부 그렇다).
//   `presets.ts`·`engine.ts`·`algoEngine.ts`·`series.ts`·`overfit.ts`는 **읽기만** 했다.
//   과최적화 채점(`overfit.ts`)·시세 어댑터(`priceSource.ts`)·유니버스(`krxPitUniverse.ts`·
//   `krxUniverseSource.ts`)는 **기존 정본을 그대로 쓴다**(다시 구현하지 않는다).
//
// ── 실행 ─────────────────────────────────────────────────────────────────────
//   GHA `Backtest (GHA runner)` · mode 입력값:
//     dokkaebi:all       전체 격자 36변형 (벤치 KODEX 200 · 야후 필요)
//     dokkaebi:ma2       MA2 축만 18변형 (벤치 필요)
//     dokkaebi:quick     스모크런 4변형 (벤치 필요)
//     dokkaebi:selftest  합성 데이터 자기검증 (파일·네트워크 불필요)
//   환경변수: `PRICE_SOURCE`(기본 krx) · `DOKKAEBI_PBO_MAX_COMBOS`

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { CostSettings } from '../src/features/backtest/conditionScreen'
import type { DailyBar } from '../src/features/backtest/types'

import { KRX_PIT_PATH, parseKrxPitUniverse } from '../src/features/backtest/krxPitUniverse'
import {
  deriveKrxUniverse,
  krxWidthLabel,
  normalizeWidth,
  type DerivedKrxUniverse,
  type KrxTopN,
  type KrxWidth,
} from '../src/features/backtest/krxUniverseSource'
import {
  MIXED_SOURCE_NOTE,
  loadKrPrices,
  normalizePriceSource,
  type PriceSource,
  type PriceSourceMeta,
} from '../src/features/backtest/priceSource'
// nodeKrxDeps는 env 게이트(PRESET_PRECOMPUTE_RUN) 뒤에 main()이 있어 import해도 실행되지 않는다.
import { nodeKrxDeps } from './preset-precompute.entry'
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

// ============================================================================
// 0. 상수 — 34·36·39차와 **같은 값**이어야 표가 나란히 읽힌다
// ============================================================================

export function log(msg: string): void {
  console.log(msg)
}

/**
 * 비용 전제. `scripts/shortterm-lab.entry.ts`의 `COST`를 **그대로** 옮긴 값이다
 * (34차 krxcal · 36차 short · 39차 plateau와 동일). 새로 만들지 않는다 — 값이 갈리면
 * 회차 간 표가 나란히 읽히지 않는다. `tests/dokkaebi.test.ts`가 이 값을 대조한다.
 */
export const DOKKAEBI_COST: CostSettings = {
  initialCapital: 10_000_000,
  feePct: 0.015,
  taxPct: 0.15,
  slippagePct: 0.1,
}

/** 알파 판정 벤치(규칙 5). KODEX 200 — KRX Open API에 없어 **야후로만** 받는다. */
export const BENCH = '069500.KS'

/** 벤치 로드 시작일. 유니버스 첫 해(2010-01)보다 앞서 받아 구간 겹침을 보장한다. */
export const BENCH_RANGE = 'since:2009-01-01'

/** 표본 소실 판정선 — 39·41차와 같은 값(관문 ②). */
export const DOKKAEBI_MIN_TRADES = 20

/** 고원 판정 임계(관문 ⑤) — 39·41차와 같은 0.30. */
export const DOKKAEBI_DROP_THRESHOLD = 0.3

/**
 * 동시 보유 슬롯 수 — **격자 축이 아니다**(고정 전제).
 * 원문은 사이징을 말하지 않는다. 34·36·39차와 같은 10으로 고정해야 이 표가 그 표들과
 * 나란히 읽힌다. 축으로 올리면 셀 수가 배로 늘고 다중검정 분모도 배가 된다.
 */
export const DOKKAEBI_SLOTS = 10

/**
 * 절대 거래량 임계 — **원문이 말한 숫자 그대로**다(100만주 / 300만주).
 * 격자에서 흔들지 않는다: 흔드는 순간 "원문 규칙 검증"이 아니라 임계 최적화가 된다.
 * 단위는 **주(shares)**이며 그 근거는 파일 머리말의 자기검증(삼성전자 2010-01-04)에 있다.
 */
export const VOL_THRESHOLD_100 = 1_000_000
export const VOL_THRESHOLD_300 = 3_000_000

/**
 * 누적 시도 수 = **DSR의 진짜 분모**. 같은 국장 데이터·같은 유니버스를 여러 회차에 걸쳐
 * 반복해 본 것이므로 선택편의가 누적된다.
 *
 * 41차(us-lab 48변형)는 **미장**이라 넣지 않는다 — 다른 데이터셋이라 선택편의가 같은
 * 표본 위에 쌓이지 않는다(41차가 국장 분모를 안 쓴 것과 같은 규약).
 * 40차는 34차와 같은 35변형을 **다시 잰 것**이지만, 같은 표본을 한 번 더 본 것이므로
 * 보수적으로(분모를 크게) 넣는다.
 */
export const DOKKAEBI_TRIALS_PRIOR: readonly { round: string; n: number }[] = [
  { round: '33차 (krxpit 실측 재검증)', n: 10 },
  { round: '34차 (krxcal 격자)', n: 35 },
  { round: '35차 (krxscreen 랭킹 4계열)', n: 20 },
  { round: '36차 (short 단기기법)', n: 14 },
  { round: '38차 (value 밸류·퀄리티)', n: 18 },
  { round: '39차 (plateau 고원 격자)', n: 405 },
  { round: '40차 (배당편향 제거 재측정 · 같은 35변형)', n: 35 },
]
export const DOKKAEBI_TRIALS_PRIOR_TOTAL = DOKKAEBI_TRIALS_PRIOR.reduce((s, r) => s + r.n, 0)

/** PBO 블록 수 S. overfit.ts 기본값과 같은 16(짝수·논문 권장 범위). */
export const DOKKAEBI_PBO_BLOCKS = 16
/** 워크포워드 창(거래일). IS 3년 · OOS 1년 — 17년 표본에서 12구간 남짓 나온다(39차와 동일). */
export const DOKKAEBI_WF_IS_DAYS = 756
export const DOKKAEBI_WF_OOS_DAYS = 252
/** 일별 수익률의 연환산 계수(한국 주식 거래일 근사). */
export const DOKKAEBI_PERIODS_PER_YEAR = 252

/**
 * PBO 조합 상한 — 변형 수에 반비례해 자동으로 좁힌다(39·41차와 같은 식).
 * overfit.ts는 상한을 넘으면 난수가 아니라 **사전식 등간격 결정적 샘플링**으로 내려가므로
 * 재현성이 유지된다(그 사실을 결과 notes에 스스로 남긴다).
 */
export function pboMaxCombinations(variants: number, budget = 1_000_000): number {
  if (!(variants > 0)) return 1
  return Math.max(200, Math.min(20_000, Math.floor(budget / variants)))
}

// ============================================================================
// 1. 비교 기준 — 배당 비대칭 제거(40차 규약)
// ============================================================================

/**
 * 수익 기준.
 *   `total` = 총수익(배당 재투자). 야후 `adjclose ÷ close` 계수를 OHLC에 곱한다.
 *   `price` = 가격수익(배당 제외). 계수를 곱하지 않는다.
 *
 * KRX 정본에는 현금배당이 없다(가격수익). 벤치만 총수익으로 받으면 KODEX 200의
 * 배당수익률만큼 **모든 알파가 전략에 불리하게** 찍힌다 — 37~39차가 그 편향 위에 있었고
 * 40차에서 제거했다. 그 규약을 여기서도 그대로 지킨다.
 */
export type ReturnBasis = 'total' | 'price'

/** 시세 소스에 맞는 비교 기준 — 전략과 벤치의 배당 반영 여부를 일치시킨다. */
export function compareBasisFor(source: PriceSource): ReturnBasis {
  return source === 'krx' ? 'price' : 'total'
}

let COMPARE_BASIS: ReturnBasis = 'total'
export function setCompareBasis(b: ReturnBasis): void {
  COMPARE_BASIS = b
}
export function compareBasis(): ReturnBasis {
  return COMPARE_BASIS
}
export function compareBasisNote(b: ReturnBasis): string {
  return b === 'price'
    ? '비교 기준: **가격수익**(배당 제외) — 전략(KRX 원주가)과 벤치를 **같은 기준**으로 맞췄다. ' +
        '벤치의 배당수익률만큼 알파를 깎던 편향이 제거된 수치다.'
    : '비교 기준: **총수익**(배당 재투자) — 전략도 야후 adjclose 기반이라 벤치와 기준이 같다.'
}

// ============================================================================
// 2. 격자 — 3축(기준 이평 · 유니버스 폭 · 진입 필터)
// ============================================================================

export type MaN = 2 | 5
export const MA_VALUES: MaN[] = [2, 5]

/**
 * 유니버스 폭. **값은 시장별 상위 N**이며 라벨의 숫자는 합계다.
 *   20 → 코스피 20 + 코스닥 20 = 40종목 (원문이 말한 "대표 40종목")
 *   40 → 코스피 40 + 코스닥 40 = 80종목
 *
 * ⚠️ **지시서의 "시총 상위 200"은 이 데이터로 잴 수 없다.** `public/data/krx-pit/universe.json`은
 *    KRX Open API 수집기(`MODE=pityear`)가 **시장당 상위 40**까지만 받아 저장한 파일이고
 *    (`KRX_TOP_N_CHOICES` 상한도 40), 200위까지의 시점 고정 랭킹은 리포에 존재하지 않는다.
 *    없는 데이터를 [추정] 목록으로 메우는 것은 33차가 무너진 바로 그 경로라서 하지 않는다 —
 *    **가용 최대인 80으로 대체**하고 그 사실을 표·보고서에 그대로 싣는다.
 */
export const WIDTH_VALUES: KrxTopN[] = [20, 40]
export const widthLabelOf = (n: KrxTopN): string => `상위${n * 2}(${n}+${n})`

/** 진입 필터 식별자 — 원문에서 추출한 조건 그대로다(임계도 원문 숫자). */
export type FilterId =
  | 'none'
  | 'above5'
  | 'align'
  | 'ma2up'
  | 'slope10'
  | 'vol100'
  | 'vol300'
  | 'align+slope10'
  | 'above5+ma2up'

export interface FilterDef {
  id: FilterId
  label: string
  /** 원문 근거 한 줄 — 코드와 보고서가 같은 문장을 쓰게 강제한다. */
  origin: string
}

export const FILTERS: readonly FilterDef[] = [
  { id: 'none', label: '없음(원문 그대로)', origin: '이평선 상향 돌파 매수 · 이탈 매도' },
  { id: 'above5', label: '종가>MA5', origin: '"캔들이 5일선 아래에 있을 때는 절대 매수 금지"' },
  { id: 'align', label: '정배열 MA5>MA10', origin: '"본인 실전은 5일선·10일선 정배열 기준"' },
  { id: 'ma2up', label: 'MA2 상향(ma2[j]>ma2[j−1])', origin: '"2일 이평선만 두면 방향이 보인다"' },
  { id: 'slope10', label: 'MA10 기울기(ma10[j]>ma10[j−10])', origin: '"10일선 기울기 우상향"' },
  { id: 'vol100', label: '거래량≥100만주', origin: '"단타 시 최소 거래량 100만주"' },
  { id: 'vol300', label: '거래량≥300만주', origin: '"장중 돌파 vs 종가베팅 분기 300만주"' },
  { id: 'align+slope10', label: '정배열 + MA10 기울기', origin: '추세 조건 2개 결합(지시 조합)' },
  { id: 'above5+ma2up', label: '종가>MA5 + MA2 상향', origin: '금지 조건 + MA2 축 결합(지시 조합)' },
]
export const FILTER_IDS: FilterId[] = FILTERS.map((f) => f.id)

/**
 * 필터 축의 **이웃 관계**(고원 채점용).
 *
 * ⚠️ 39·41차의 축은 전부 숫자라 "±1 스텝"이 이웃의 자연스러운 정의였다. 필터 축은
 *    **순서가 없다** — 배열에 적은 순서로 ±1을 하면 그건 이웃이 아니라 우연이다.
 *    그래서 이웃을 **조건 집합의 격자(lattice)**로 정의한다:
 *      · 조건 하나를 **더하거나 빼면** 이웃 (none ↔ 단일 필터, 단일 필터 ↔ 그 필터를 품은 조합)
 *      · 같은 조건의 **임계 한 칸**이면 이웃 (vol100 ↔ vol300)
 *    "파라미터를 한 칸 흔들어도 성적이 유지되는가"라는 고원의 질문을 그대로 옮긴 것이다.
 *    이 표가 없으면 고원 점수는 배열 순서에 따라 달라진다 — `tests/dokkaebi.test.ts`가 대칭성과
 *    자기참조 없음을 검사한다.
 */
export const FILTER_ADJACENCY: readonly [FilterId, FilterId][] = [
  ['none', 'above5'],
  ['none', 'align'],
  ['none', 'ma2up'],
  ['none', 'slope10'],
  ['none', 'vol100'],
  ['none', 'vol300'],
  ['vol100', 'vol300'],
  ['align', 'align+slope10'],
  ['slope10', 'align+slope10'],
  ['above5', 'above5+ma2up'],
  ['ma2up', 'above5+ma2up'],
]

/** 필터 id → 이웃 필터 id 집합(대칭). */
export function filterNeighbors(id: FilterId): FilterId[] {
  const out: FilterId[] = []
  for (const [a, b] of FILTER_ADJACENCY) {
    if (a === id) out.push(b)
    else if (b === id) out.push(a)
  }
  return out
}

export type AxisKey = 'ma' | 'width' | 'filter'
export const AXIS_KEYS: AxisKey[] = ['ma', 'width', 'filter']

export interface AxisDef {
  key: AxisKey
  label: string
  /** 값 목록. 숫자 축은 **오름차순 고정**(이웃 정의가 순서에 의존한다). */
  values: (number | string)[]
  unit: string
  /** 순서 있는 축인가 — true면 이웃 = ±1 스텝, false면 `adjacency`를 쓴다. */
  ordered: boolean
}

export interface GridSpec {
  id: string
  label: string
  axes: AxisDef[]
}

export interface DokkaebiParams {
  maN: MaN
  /** 시장별 상위 N(20이면 20+20=40종목) */
  topN: KrxTopN
  filter: FilterId
}

export interface GridCell {
  index: number
  coords: number[]
  params: DokkaebiParams
  key: string
}

export const cellKey = (p: DokkaebiParams): string => `MA${p.maN}·U${p.topN * 2}·F:${p.filter}`

/** 전체 격자 — MA 2종 × 폭 2종 × 필터 9종 = **36변형**. */
export const FULL_GRID: GridSpec = {
  id: 'all',
  label: '전체 격자',
  axes: [
    { key: 'ma', label: '기준 이평', values: [...MA_VALUES], unit: '일', ordered: true },
    { key: 'width', label: '유니버스 폭', values: [...WIDTH_VALUES], unit: '종목/시장', ordered: true },
    { key: 'filter', label: '진입 필터', values: [...FILTER_IDS], unit: '', ordered: false },
  ],
}

/** MA2 축만 — 이번 회차의 핵심 축을 단독으로 본다. 18변형. */
export const MA2_GRID: GridSpec = {
  id: 'ma2',
  label: 'MA2 축 단독',
  axes: [
    { key: 'ma', label: '기준 이평', values: [2], unit: '일', ordered: true },
    { key: 'width', label: '유니버스 폭', values: [...WIDTH_VALUES], unit: '종목/시장', ordered: true },
    { key: 'filter', label: '진입 필터', values: [...FILTER_IDS], unit: '', ordered: false },
  ],
}

/** 스모크런 — 배선·출력 형식만 확인한다. **이 결과로 판정하지 않는다.** 4변형. */
export const QUICK_GRID: GridSpec = {
  id: 'quick',
  label: '스모크런(배선 확인)',
  axes: [
    { key: 'ma', label: '기준 이평', values: [...MA_VALUES], unit: '일', ordered: true },
    { key: 'width', label: '유니버스 폭', values: [...WIDTH_VALUES], unit: '종목/시장', ordered: true },
    { key: 'filter', label: '진입 필터', values: ['none'], unit: '', ordered: false },
  ],
}

/** 축 검증 — 키 중복·빈 축·숫자 축 오름차순·알 수 없는 필터 id. */
export function validateGrid(grid: GridSpec): void {
  const seen = new Set<AxisKey>()
  for (const ax of grid.axes) {
    if (seen.has(ax.key)) throw new Error(`격자 ${grid.id}: 축 ${ax.key}가 중복이다`)
    seen.add(ax.key)
    if (ax.values.length === 0) throw new Error(`격자 ${grid.id}: 축 ${ax.key}에 값이 없다`)
    if (new Set(ax.values).size !== ax.values.length)
      throw new Error(`격자 ${grid.id}: 축 ${ax.key}에 중복 값이 있다 (${ax.values.join(',')})`)
    if (ax.ordered)
      for (let i = 1; i < ax.values.length; i++)
        if (!((ax.values[i] as number) > (ax.values[i - 1] as number)))
          throw new Error(
            `격자 ${grid.id}: 축 ${ax.key}가 오름차순이 아니다 (${ax.values.join(',')}) — 이웃 정의가 깨진다`,
          )
    if (ax.key === 'filter')
      for (const v of ax.values)
        if (!FILTER_IDS.includes(v as FilterId)) throw new Error(`격자 ${grid.id}: 알 수 없는 필터 ${String(v)}`)
  }
  for (const k of AXIS_KEYS) if (!seen.has(k)) throw new Error(`격자 ${grid.id}: 축 ${k}가 빠졌다`)
}

/**
 * 격자를 전개한다. **사전식(마지막 축이 가장 빨리 도는) 순서 고정** — 순서가 바뀌면
 * 이웃 인덱스 산술과 출력 표가 통째로 어긋난다(39·41차와 같은 규약).
 */
export function enumerateGrid(grid: GridSpec): GridCell[] {
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
    const pick = (k: AxisKey): number | string => {
      const a = grid.axes.findIndex((x) => x.key === k)
      return grid.axes[a].values[coords[a]]
    }
    const params: DokkaebiParams = {
      maN: pick('ma') as MaN,
      topN: pick('width') as KrxTopN,
      filter: pick('filter') as FilterId,
    }
    cells.push({ index: i, coords, params, key: cellKey(params) })
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
  /** 어느 값으로 흔들었는가(로그용) */
  to: string
}

/**
 * 이웃 = **한 축에서 한 칸, 대각선 제외**.
 *   · 순서 있는 축(ma·width): ±1 스텝 — 39·41차와 같은 정의.
 *   · 필터 축: `FILTER_ADJACENCY`(조건 하나 추가·제거 또는 임계 한 칸).
 *
 * 격자 밖 방향은 두 가지로 나눠 돌려준다 — 뭉치면 원인을 못 읽는다:
 *   · `missing` — 값이 2개 이상인데 셀이 그 축의 **끝**이라 한쪽을 못 본다(= 경계 셀).
 *   · `frozen`  — 축 자체가 값 1개로 고정돼 있어 흔들 것이 없다(설계상 고정).
 */
export function neighborsOf(
  cell: GridCell,
  grid: GridSpec,
): { found: NeighborRef[]; missing: string[]; frozen: AxisKey[] } {
  const sizes = grid.axes.map((a) => a.values.length)
  const found: NeighborRef[] = []
  const missing: string[] = []
  const frozen: AxisKey[] = []
  for (let a = 0; a < grid.axes.length; a++) {
    const ax = grid.axes[a]
    if (sizes[a] < 2) {
      frozen.push(ax.key)
      continue
    }
    if (ax.ordered) {
      for (const dir of [-1, 1] as const) {
        const c = cell.coords.slice()
        c[a] += dir
        const idx = flatIndex(c, sizes)
        if (idx < 0) {
          missing.push(`${ax.key}${dir > 0 ? '+' : '−'}`)
          continue
        }
        found.push({ index: idx, axis: ax.key, to: String(ax.values[c[a]]) })
      }
      continue
    }
    // 필터 축 — 격자 안에 실제로 존재하는 이웃만 센다(축소 격자에서 빠진 필터는 missing).
    const self = ax.values[cell.coords[a]] as FilterId
    for (const nb of filterNeighbors(self)) {
      const pos = ax.values.indexOf(nb)
      if (pos < 0) {
        missing.push(`${ax.key}:${nb}`)
        continue
      }
      const c = cell.coords.slice()
      c[a] = pos
      const idx = flatIndex(c, sizes)
      if (idx < 0) {
        missing.push(`${ax.key}:${nb}`)
        continue
      }
      found.push({ index: idx, axis: ax.key, to: nb })
    }
  }
  return { found, missing, frozen }
}

// ============================================================================
// 3. 지표 — 전부 인과적(bars[0..j])
// ============================================================================

/**
 * 단순이동평균 계열. `out[j]`는 `closes[j−n+1..j]`의 평균이며 **미래를 보지 않는다**.
 * 채워지지 않는 앞 구간은 `NaN`(0으로 메우지 않는다 — 0은 "MA가 0"이라는 거짓말이다).
 */
export function smaSeries(bars: readonly DailyBar[], n: number): Float64Array {
  if (!(n >= 1)) throw new Error(`이동평균 기간은 1 이상이어야 한다 (${n})`)
  const out = new Float64Array(bars.length).fill(Number.NaN)
  let sum = 0
  for (let i = 0; i < bars.length; i++) {
    sum += bars[i].c
    if (i >= n) sum -= bars[i - n].c
    if (i >= n - 1) out[i] = sum / n
  }
  return out
}

/** 한 종목의 사전계산 지표(파라미터에 의존하지 않는다 — 셀 루프 밖에서 한 번만 만든다). */
export interface SymIndicators {
  ma2: Float64Array
  ma5: Float64Array
  ma10: Float64Array
}

export function buildIndicators(bars: readonly DailyBar[]): SymIndicators {
  return { ma2: smaSeries(bars, 2), ma5: smaSeries(bars, 5), ma10: smaSeries(bars, 10) }
}

export const maOf = (ind: SymIndicators, n: MaN): Float64Array => (n === 2 ? ind.ma2 : ind.ma5)

/**
 * **상향 돌파** — 봉 `j`(완결된 봉)에서 종가가 MA_N을 아래에서 위로 넘었는가.
 *   `c[j] > ma[j]` **그리고** `c[j−1] <= ma[j−1]`
 * 두 값 모두 확정된 과거 봉에서 나온다. 체결은 봉 `j+1`의 **시가**다(규칙 1-2).
 */
export function crossUpAt(bars: readonly DailyBar[], ma: Float64Array, j: number): boolean {
  if (j < 1) return false
  const cur = ma[j]
  const prev = ma[j - 1]
  if (!Number.isFinite(cur) || !Number.isFinite(prev)) return false
  return bars[j].c > cur && bars[j - 1].c <= prev
}

/** **이탈** — 봉 `j`의 종가가 MA_N 아래. 체결은 봉 `j+1`의 시가다. */
export function breakdownAt(bars: readonly DailyBar[], ma: Float64Array, j: number): boolean {
  const cur = ma[j]
  if (!Number.isFinite(cur)) return false
  return bars[j].c < cur
}

/**
 * 진입 필터. 전부 봉 `j`까지의 값만 본다.
 * **필요한 계열이 아직 채워지지 않았으면 `false`**(진입하지 않는다) — 없는 값을 낙관적으로
 * 통과시키면 이력이 짧은 종목에서만 신호가 몰려 성적이 부풀려진다.
 */
export function filterPasses(
  id: FilterId,
  bars: readonly DailyBar[],
  ind: SymIndicators,
  j: number,
): boolean {
  const fin = (v: number): boolean => Number.isFinite(v)
  const above5 = (): boolean => fin(ind.ma5[j]) && bars[j].c > ind.ma5[j]
  const align = (): boolean => fin(ind.ma5[j]) && fin(ind.ma10[j]) && ind.ma5[j] > ind.ma10[j]
  const ma2up = (): boolean => j >= 1 && fin(ind.ma2[j]) && fin(ind.ma2[j - 1]) && ind.ma2[j] > ind.ma2[j - 1]
  const slope10 = (): boolean =>
    j >= 10 && fin(ind.ma10[j]) && fin(ind.ma10[j - 10]) && ind.ma10[j] > ind.ma10[j - 10]
  switch (id) {
    case 'none':
      return true
    case 'above5':
      return above5()
    case 'align':
      return align()
    case 'ma2up':
      return ma2up()
    case 'slope10':
      return slope10()
    case 'vol100':
      return bars[j].v >= VOL_THRESHOLD_100
    case 'vol300':
      return bars[j].v >= VOL_THRESHOLD_300
    case 'align+slope10':
      return align() && slope10()
    case 'above5+ma2up':
      return above5() && ma2up()
  }
}

/**
 * 후보 정렬 키 = **신호 봉의 거래대금 근사**(원주가 × 거래량).
 * 신호가 슬롯보다 많은 날 무엇을 담을지 정하는 규칙이며 **격자 축이 아니다**(고정 전제).
 * 분할 보정 전 가격을 쓰는 이유: 보정 종가 × 미보정 거래량을 곱하면 분할 전후로 스케일이
 * 튀어 랭킹이 인위적으로 뒤집힌다. 원주가가 없으면 보정 종가로 내려간다.
 */
export const tradeValueAt = (bars: readonly DailyBar[], j: number): number =>
  (bars[j].rawClose ?? bars[j].c) * bars[j].v

// ============================================================================
// 4. 장부 — 39차 `bookBuy/bookSell/bookMark`와 동일 산술(자립 구현)
// ============================================================================

interface BookPos {
  qty: number
  /** 취득 총원가(체결가×수량 + 매수수수료) */
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
// 5. 연도 컨텍스트 — 파라미터에 의존하지 않으므로 셀 루프 밖에서 한 번만 만든다
// ============================================================================

export interface YearCtx {
  y: number
  start: string
  end: string
  /** 그 해 실제로 거래 가능한 심볼(연말 절단 후) */
  symbols: string[]
  /** `date <= end`로 잘린 봉 — 규칙 1의 절단과 같은 조작 */
  hist: Record<string, DailyBar[]>
  ind: Record<string, SymIndicators>
  calendar: string[]
  idxOf: Record<string, Map<string, number>>
  /** 유니버스 코드 수(매핑률 표기용) */
  totalCodes: number
}

/**
 * 연도별 유니버스·시계열 준비. 그 해 **6월 30일 이전에 상장돼 있던 종목만** 편입한다
 * (39차·pitChain과 같은 규약 — "그때 이미 상장돼 있었나"만 보고 이후 가격은 보지 않는다).
 */
export function buildYearCtxs(
  histories: Record<string, DailyBar[]>,
  years: number[],
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
    const ind: Record<string, SymIndicators> = {}
    for (const s of symbols) {
      const m = new Map<string, number>()
      hist[s].forEach((b, i) => m.set(b.date, i))
      idxOf[s] = m
      ind[s] = buildIndicators(hist[s])
    }
    out.push({ y, start, end, symbols, hist, ind, calendar, idxOf, totalCodes: codes.length })
  }
  return out
}

// ============================================================================
// 6. 한 해치 시뮬 — 신호는 전일 종가, 체결은 당일 시가
// ============================================================================

export type Curve = { date: string; equity: number }[]

export interface YearRun {
  equity: Curve
  closed: number
  wins: number
  openAtEnd: number
  /** 신호가 났지만 슬롯이 없어 담지 못한 건수(원문 규칙의 기회 손실 크기) */
  skippedSignals: number
  entries: number
}

/**
 * 한 해치 시뮬.
 *
 * 하루의 처리 순서 — **이 순서가 곧 규칙 1의 구현이다**:
 *   1) 보유 종목: 직전 봉 `j`에서 이탈이면 오늘 봉의 **시가**에 매도.
 *   2) 미보유 종목: 직전 봉 `j`에서 상향 돌파 + 필터 통과면 오늘 봉의 **시가**에 매수.
 *      후보가 빈 슬롯보다 많으면 신호 봉 거래대금 내림차순(동점은 심볼 오름차순 — 난수 없음).
 *   3) 오늘 종가로 마킹해 자산곡선 한 점을 찍는다.
 *
 * 오늘 봉의 시가·고가·저가·종가는 **판정에 쓰지 않는다**(체결가로만 쓴다). 원문의
 * "종가 매수"를 그대로 옮기지 않는 이유는 파일 머리말 규칙 1-1에 적어 두었다.
 *
 * **마지막 봉 신규 진입 금지**(규칙 1-6) — 구간 마지막 거래일에는 2)를 하지 않는다.
 */
export function simulateYear(ctx: YearCtx, cost: CostSettings, params: DokkaebiParams, slots = DOKKAEBI_SLOTS): YearRun {
  const book = newBook(cost.initialCapital)
  const equity: Curve = []
  const { calendar, symbols, hist, ind, idxOf } = ctx
  const lastIdx = calendar.length - 1
  let skippedSignals = 0
  let entries = 0

  for (let d = 0; d < calendar.length; d++) {
    const date = calendar[d]

    // ---- 오늘 시가 조회기(체결가 전용) ----
    const openAt = (s: string): number | null => {
      const i = idxOf[s]?.get(date)
      if (i == null) return null
      const px = hist[s][i].o
      return px > 0 ? px : null
    }

    // ---- 1) 청산: 직전 봉이 MA 아래로 이탈했으면 오늘 시가에 매도 ----
    for (const s of [...book.positions.keys()]) {
      const i = idxOf[s]?.get(date)
      if (i == null || i < 1) continue // 오늘 봉이 없으면 못 판다 — 다음 기회로 이월
      const bars = hist[s]
      if (!breakdownAt(bars, maOf(ind[s], params.maN), i - 1)) continue
      const px = openAt(s)
      if (px == null) continue
      bookSell(book, cost, s, px, book.positions.get(s)!.qty)
    }

    // ---- 2) 진입 ----
    if (d < lastIdx) {
      const free = slots - book.positions.size
      const cands: { sym: string; px: number; value: number }[] = []
      for (const s of symbols) {
        if (book.positions.has(s)) continue
        const i = idxOf[s]?.get(date)
        if (i == null || i < 1) continue
        const bars = hist[s]
        const j = i - 1
        if (!crossUpAt(bars, maOf(ind[s], params.maN), j)) continue
        if (!filterPasses(params.filter, bars, ind[s], j)) continue
        const px = openAt(s)
        if (px == null) continue
        cands.push({ sym: s, px, value: tradeValueAt(bars, j) })
      }
      if (cands.length > 0) {
        cands.sort((x, y) => (y.value !== x.value ? y.value - x.value : x.sym < y.sym ? -1 : x.sym > y.sym ? 1 : 0))
        if (cands.length > free) skippedSignals += cands.length - Math.max(0, free)
        if (free > 0) {
          // 슬롯 예산은 **오늘 시가 기준 총자산**으로 낸다(오늘 종가를 쓰면 미래참조다).
          let eq = book.cash
          for (const [s, p] of book.positions) {
            const px = openAt(s)
            eq += p.qty * (px != null ? px : p.lastClose)
          }
          const slot = eq / slots
          for (const c of cands.slice(0, free)) {
            if (bookBuy(book, cost, c.sym, c.px, Math.min(slot, book.cash)) > 0) entries++
          }
        }
      }
    }

    // ---- 3) 종가 마킹 ----
    const closeAt = (s: string): number | null => {
      const i = idxOf[s]?.get(date)
      return i != null ? hist[s][i].c : null
    }
    equity.push({ date, equity: bookMark(book, closeAt) })
  }

  return { equity, closed: book.closed, wins: book.wins, openAtEnd: book.positions.size, skippedSignals, entries }
}

// ============================================================================
// 7. 연쇄 실행 — 연도별 유니버스 교체
// ============================================================================

export interface ChainStats {
  equity: Curve
  closed: number
  wins: number
  entries: number
  skippedSignals: number
  perYear: { y: number; ret: number; mapped: number; total: number; cash: boolean }[]
}

/**
 * 그 해 매핑 종목이 이 수 미만이면 표본이 작아 성적이 몇 종목 운에 좌우된다 →
 * **현금 보유**로 처리하고 자산곡선을 평평하게 이어붙인다(구간을 건너뛰면 연수가 줄어
 * CAGR이 부풀려진다). 39차와 같은 5.
 */
export const MIN_SYMBOLS = 5

/**
 * 구간 끝 청산비용 근사 [추정] — 정확한 청산가가 아니다. **켠다**: 방향이 보수적이고
 * (성적을 낮춘다) 39차 러너가 물리는 비용과 같아야 표가 나란히 읽힌다.
 */
export const APPLY_LIQUIDATION_HAIRCUT = true

export function runDokkaebiChain(
  ctxs: readonly YearCtx[],
  cost: CostSettings,
  params: DokkaebiParams,
  slots = DOKKAEBI_SLOTS,
): ChainStats {
  const equity: Curve = []
  const perYear: ChainStats['perYear'] = []
  let factor = 1
  let closed = 0
  let wins = 0
  let entries = 0
  let skippedSignals = 0

  for (const ctx of ctxs) {
    if (ctx.symbols.length === 0) continue
    if (ctx.symbols.length < MIN_SYMBOLS) {
      for (const d of ctx.calendar) equity.push({ date: d, equity: factor * cost.initialCapital })
      perYear.push({ y: ctx.y, ret: 0, mapped: ctx.symbols.length, total: ctx.totalCodes, cash: true })
      continue
    }
    const run = simulateYear(ctx, cost, params, slots)
    const base = factor
    for (const p of run.equity)
      equity.push({ date: p.date, equity: base * (p.equity / cost.initialCapital) * cost.initialCapital })
    const finalEq = run.equity.length ? run.equity[run.equity.length - 1].equity : cost.initialCapital
    const segRet = finalEq / cost.initialCapital
    const frac = APPLY_LIQUIDATION_HAIRCUT ? Math.min(1, Math.max(0, run.openAtEnd / Math.max(1, slots))) : 0
    const yearRatio = segRet * (1 - frac * ((cost.feePct + cost.taxPct + cost.slippagePct) / 100))
    factor = base * yearRatio
    closed += run.closed
    wins += run.wins
    entries += run.entries
    skippedSignals += run.skippedSignals
    perYear.push({ y: ctx.y, ret: (yearRatio - 1) * 100, mapped: ctx.symbols.length, total: ctx.totalCodes, cash: false })
  }
  return { equity, closed, wins, entries, skippedSignals, perYear }
}

// ============================================================================
// 8. 성과 지표 — 39차 `perfOf`/`calmarOf`/`alphaOf`와 **같은 정의**(자립 구현)
// ============================================================================

export interface Perf {
  total: number
  cagr: number
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
  const years = Math.max(
    1 / 365,
    (Date.parse(win[win.length - 1].date) - Date.parse(win[0].date)) / (365.25 * 86400e3),
  )
  const ratio = Math.max(end / start, 1e-9)
  return { total: (ratio - 1) * 100, cagr: (Math.pow(ratio, 1 / years) - 1) * 100, mdd, years }
}

/** 칼마 = CAGR ÷ |MDD| (31차 대표 채택 기준 · 고원 성적 지표). MDD≈0이면 null. */
export function calmarOf(p: Perf): number | null {
  const mddAbs = Math.abs(p.mdd)
  return mddAbs > 0.01 ? p.cagr / mddAbs : null
}

/** 알파는 **두 곡선이 겹치는 구간**에서만 계산한다(규칙 5). */
export function alphaOf(strat: Curve, bench: Curve, from: string, to: string): number | null {
  const bWin = bench.filter((e) => e.date >= from && e.date <= to)
  const sWin = strat.filter((e) => e.date >= from && e.date <= to)
  if (bWin.length < 2 || sWin.length < 2) return null
  const lo = bWin[0].date > sWin[0].date ? bWin[0].date : sWin[0].date
  const hi =
    bWin[bWin.length - 1].date < sWin[sWin.length - 1].date
      ? bWin[bWin.length - 1].date
      : sWin[sWin.length - 1].date
  const s = perfOf(strat, lo, hi)
  const b = perfOf(bench, lo, hi)
  if (s.years < 0.5 || b.years < 0.5) return null
  return s.cagr - b.cagr
}

/** 전·후반 경계 연도. 하드코딩하지 않는다(2010~2026 → 2018 — 34·36·38·39차와 같은 값). */
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
 * 한 변형에만 있는 날을 그대로 두면 시점이 통째로 밀린다.
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
// 9. 셀 결과 · 고원 채점 · 승격 관문 (39·41차와 **같은 잣대** — 느슨하게 하지 않는다)
// ============================================================================

export interface CellResult {
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
  entries: number
  skippedSignals: number
  dailyReturns: number[]
}

/** 관문 ①②(셀 단독으로 판정 가능한 것) — 빈 배열이면 통과. */
export function localFailReasons(r: CellResult, minTrades = DOKKAEBI_MIN_TRADES): string[] {
  const bad: string[] = []
  if (!((r.alphaA ?? -1) > 0 && (r.alphaB ?? -1) > 0)) bad.push('알파(전·후반)')
  if (!(r.trades >= minTrades)) bad.push(`매매<${minTrades}`)
  return bad
}
export const localPass = (r: CellResult, minTrades = DOKKAEBI_MIN_TRADES): boolean =>
  localFailReasons(r, minTrades).length === 0

export interface PlateauScore {
  index: number
  self: number | null
  neighbors: number
  missing: string[]
  frozen: AxisKey[]
  minNeighbor: number | null
  /** **셀과 이웃 성적의 최솟값** — 평균이 아니다(이웃 하나만 무너져도 고원이 아니다). */
  plateauScore: number | null
  /** (셀 − 이웃최솟값) ÷ |셀|. 셀 성적이 0 이하면 정의하지 않는다. */
  plateauDrop: number | null
  neighborsPassLocal: boolean | null
  sampleShort: boolean
  reason: string | null
}

/**
 * 고원 채점. `scoreOf[i]`는 셀 i의 성적(칼마), `passOf[i]`는 관문 ① 통과 여부다.
 *
 * ⚠️ 규칙 1과의 관계: 이 함수는 **이미 확정된 격자 성적의 사후 채점**이다. 산출값이
 *    신호·진입·청산·사이징으로 되먹임되지 않으므로 "전 구간 통계 금지"(규칙 1-5)에
 *    걸리지 않는다. 반대로 이 값을 전략 로직에 넣는 순간 그것은 미래참조가 된다.
 */
export function scorePlateau(
  cells: readonly GridCell[],
  grid: GridSpec,
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
    const sampleShort = missing.length > 0
    let reason: string | null = null
    if (self == null) reason = '셀 성적 계산 불가(MDD≈0 등) — 고원 판정 불가'
    else if (nb.length === 0) reason = '이웃이 하나도 없다 — 고원 판정 불가'
    else if (nullNb > 0) reason = `이웃 ${nullNb}개의 성적을 계산할 수 없다 — 고원 판정 불가`
    const plateauScore = self != null && minNeighbor != null ? Math.min(self, minNeighbor) : null
    const plateauDrop =
      self != null && minNeighbor != null && self > 0 ? (self - minNeighbor) / Math.abs(self) : null
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
      sampleShort,
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
 * 승격 관문 (전부 통과해야 승격 — **가장 덜 나쁜 칸 승격 금지**):
 *   ① 전·후반 양쪽 알파 양수  ② 매매수 ≥ 20  ③ PBO < 0.5
 *   ④ 워크포워드 OOS 알파 양수  ⑤ 고원: plateauDrop ≤ 0.30 이면서 이웃 전부가 관문 ① 통과
 *
 * ③④는 **격자 전체에 하나씩 나오는 값**이라 셀마다 같다 — 그 회차의 탐색 절차 자체가
 * 아웃샘플에서 성립하는지를 묻는 관문이기 때문이다(39·41차와 같다).
 */
export function promotionVerdict(
  r: CellResult,
  ps: PlateauScore,
  round: { pbo: number | null; wfOosAlpha: number | null },
  minTrades = DOKKAEBI_MIN_TRADES,
  dropThreshold = DOKKAEBI_DROP_THRESHOLD,
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
    failed.push(
      round.wfOosAlpha == null ? '④워크포워드 계산불가' : `④WF OOS 알파 ${round.wfOosAlpha.toFixed(2)}%p≤0`,
    )
  if (ps.plateauDrop != null && ps.plateauDrop <= dropThreshold && ps.neighborsPassLocal === true) passed.push(5)
  else
    failed.push(
      ps.plateauDrop == null
        ? `⑤고원 판정불가(${ps.reason ?? '사유 없음'})`
        : ps.plateauDrop > dropThreshold
          ? `⑤plateauDrop ${ps.plateauDrop.toFixed(3)}>${dropThreshold}`
          : '⑤이웃 중 관문① 탈락 존재',
    )
  return { passed, failed, promoted: failed.length === 0 }
}

// ============================================================================
// 10. 항등 점검 — 이 격자에는 **구조적으로 같은 셀**이 있다
// ============================================================================

/**
 * MA5 계열에서 `above5`(종가>MA5)는 **상향 돌파 조건에 이미 포함**돼 있다
 * (`c[j] > ma5[j]`가 돌파의 절반이다). 따라서 다음 두 쌍은 **완전히 같은 결과**여야 한다:
 *   `MA5·F:above5` ≡ `MA5·F:none` · `MA5·F:above5+ma2up` ≡ `MA5·F:ma2up`
 *
 * 이 항등은 버리지 않고 **자기검증**으로 쓴다 — 두 셀의 매매수·칼마가 다르면 필터 배선이나
 * 돌파 정의 어딘가가 어긋난 것이다. 대신 **중복 셀이라는 사실을 표에 라벨로 박아**
 * "36변형을 독립적으로 탐색했다"는 오해를 막는다(다중검정 분모는 그대로 36을 쓴다 —
 * 분모를 줄이는 쪽으로 반올림하지 않는다).
 */
export const IDENTITY_PAIRS: readonly { a: FilterId; b: FilterId; when: string }[] = [
  { a: 'above5', b: 'none', when: 'MA5' },
  { a: 'above5+ma2up', b: 'ma2up', when: 'MA5' },
]

export interface IdentityCheck {
  label: string
  ok: boolean
  detail: string
}

export function identityChecks(results: readonly CellResult[]): IdentityCheck[] {
  const byKey = new Map<string, CellResult>()
  for (const r of results) byKey.set(r.cell.key, r)
  const out: IdentityCheck[] = []
  for (const r of results) {
    const p = r.cell.params
    if (p.maN !== 5) continue
    for (const pair of IDENTITY_PAIRS) {
      if (p.filter !== pair.a) continue
      const twin = byKey.get(cellKey({ ...p, filter: pair.b }))
      if (!twin) continue
      const sameTrades = r.trades === twin.trades
      const sameCagr = Math.abs(r.full.cagr - twin.full.cagr) < 1e-9
      out.push({
        label: `${r.cell.key} ≡ ${twin.cell.key}`,
        ok: sameTrades && sameCagr,
        detail: `매매 ${r.trades} vs ${twin.trades} · CAGR ${r.full.cagr.toFixed(6)} vs ${twin.full.cagr.toFixed(6)}`,
      })
    }
  }
  return out
}

/** 그 셀이 다른 셀과 구조적으로 같은가(표 라벨용). */
export function isDuplicateCell(p: DokkaebiParams): boolean {
  return p.maN === 5 && IDENTITY_PAIRS.some((x) => x.a === p.filter)
}

// ============================================================================
// 11. 출력 헬퍼
// ============================================================================

export const f1 = (v: number | null | undefined): string =>
  v == null || !Number.isFinite(v) ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(1)}`
export const num = (v: number | null | undefined, d = 3): string =>
  v == null || !Number.isFinite(v) ? '—' : v.toFixed(d)
const pp = (v: number | null | undefined): string => (v == null ? '—' : `${f1(v)}%p`)
const pct = (v: number | null | undefined): string => (v == null ? '—' : `${f1(v)}%`)

// ============================================================================
// 12. 데이터 로딩 (규칙 4)
// ============================================================================

const ROOT = process.env.REPO_ROOT ?? process.cwd()

/** 야후 호출 성공/실패 카운터 — 전량 실패는 **비정상 종료**의 근거다. */
export interface YahooTally {
  attempted: number
  ok: number
  failed: { symbol: string; reason: string }[]
}
export const newYahooTally = (): YahooTally => ({ attempted: 0, ok: 0, failed: [] })

/**
 * 야후 일봉. **어떤 실패도 삼키지 않는다** — HTTP 오류·`chart.error`(200 본문)·빈 result 전부 던진다.
 * `basis='price'`면 총수익 계수를 곱하지 않는다(전략과 기준 맞추기 · 40차 규약).
 */
export async function fetchDaily(
  symbol: string,
  range = BENCH_RANGE,
  basis: ReturnBasis = 'total',
): Promise<DailyBar[]> {
  const qs = range.startsWith('since:')
    ? `period1=${Math.floor(Date.parse(range.slice(6)) / 1000)}&period2=${Math.floor(Date.now() / 1000)}`
    : `range=${range}`
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?${qs}&interval=1d&events=div%2Csplit`
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' } })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const json = (await res.json()) as {
    chart?: {
      result?: {
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
    // 한국거래소는 서머타임이 없으므로 KST(+9h) 고정
    const date = new Date(ts[i] * 1000 + 9 * 3600 * 1000).toISOString().slice(0, 10)
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

/** 카운터를 물린 야후 호출. 실패해도 던지지 않고 null — **판단은 호출부가** 한다. */
export async function tallyFetch(
  tally: YahooTally,
  symbol: string,
  range = BENCH_RANGE,
  basis: ReturnBasis = COMPARE_BASIS,
): Promise<DailyBar[] | null> {
  tally.attempted++
  try {
    const bars = await fetchDaily(symbol, range, basis)
    // 정상 0봉(휴장·구간 밖)과 실패 0봉(차단·잘못된 심볼)을 구분한다.
    if (bars.length < 2) {
      tally.failed.push({ symbol, reason: `봉 ${bars.length}개 — 구간 요청에 비해 비정상적으로 적다` })
      return null
    }
    tally.ok++
    return bars
  } catch (e) {
    tally.failed.push({ symbol, reason: String(e) })
    return null
  }
}

const sleep = (ms: number): Promise<void> => new Promise<void>((r) => setTimeout(() => r(), ms))

/** KRX 실측 유니버스 파일 → 실행 재료. **[추정] 목록으로 폴백하지 않는다**(33차 재발 방지). */
export function loadUniverse(root: string, width: KrxWidth): DerivedKrxUniverse {
  const path = join(root, KRX_PIT_PATH)
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch (e) {
    throw new Error(
      `KRX 실측 유니버스(${path})를 읽지 못했다 — 실행을 중단한다. ` +
        `[추정] 목록으로 대신 돌리지 않는다(33차에서 [추정] 목록발 알파가 무너졌다). (${String(e)})`,
    )
  }
  return deriveKrxUniverse(parseKrxPitUniverse(raw), width)
}

// ============================================================================
// 13. 격자 실행
// ============================================================================

export interface RunInputs {
  grid: GridSpec
  /** 폭(시장별 상위 N) → 그 폭의 연도 컨텍스트 */
  ctxsByWidth: Map<number, YearCtx[]>
  years: number[]
  cost: CostSettings
  benchCurve: Curve
  benchLabel: string
  slots?: number
}

export interface RunOutputs {
  cells: GridCell[]
  results: CellResult[]
  dates: string[]
  matrix: number[][]
  benchReturns: number[] | null
  dropped: number
  pbo: PboResult
  wf: WalkForwardResult
  plateau: PlateauScore[]
  gridMs: number
  scoringMs: number
}

/** 격자 전체 실행 + 사후 채점. **여기서 임계값을 데이터로 정하지 않는다**(전부 사전 고정 상수). */
export function runGrid(inp: RunInputs, onCell?: (done: number, total: number, ms: number) => void): RunOutputs {
  const cells = enumerateGrid(inp.grid)
  const half = halfYearOf(inp.years)
  const slots = inp.slots ?? DOKKAEBI_SLOTS
  const t0 = Date.now()

  const results: CellResult[] = []
  const series: { dates: string[]; returns: number[] }[] = []
  for (const cell of cells) {
    const cellT0 = Date.now()
    const ctxs = inp.ctxsByWidth.get(cell.params.topN)
    if (!ctxs) throw new Error(`폭 ${cell.params.topN}의 연도 컨텍스트가 없다 — 격자와 입력이 어긋났다`)
    const chain = runDokkaebiChain(ctxs, inp.cost, cell.params, slots)
    const full = perfOf(chain.equity)
    const a = perfOf(chain.equity, '', `${half - 1}-12-31`)
    const b = perfOf(chain.equity, `${half}-01-01`)
    const dr = dailyReturnsOf(chain.equity)
    series.push(dr)
    results.push({
      cell,
      full,
      a,
      b,
      calmar: calmarOf(full),
      sharpeDaily: sharpeMetric(dr.returns),
      alphaFull: alphaOf(chain.equity, inp.benchCurve, '', '9999-12-31'),
      alphaA: alphaOf(chain.equity, inp.benchCurve, '', `${half - 1}-12-31`),
      alphaB: alphaOf(chain.equity, inp.benchCurve, `${half}-01-01`, '9999-12-31'),
      trades: chain.closed,
      wins: chain.wins,
      entries: chain.entries,
      skippedSignals: chain.skippedSignals,
      dailyReturns: dr.returns,
    })
    onCell?.(results.length, cells.length, Date.now() - cellT0)
  }

  const gridMs = Date.now() - t0
  const t1 = Date.now()
  const benchDaily = dailyReturnsOf(inp.benchCurve)
  const aligned = alignDailyMatrix(series, benchDaily)

  const maxCombos = Number(process.env.DOKKAEBI_PBO_MAX_COMBOS ?? '') || pboMaxCombinations(cells.length)
  const pbo = computePbo(aligned.matrix, {
    blocks: DOKKAEBI_PBO_BLOCKS,
    maxCombinations: maxCombos,
    metric: sharpeMetric,
  })
  const wf = walkForwardScore(aligned.matrix, {
    isWindow: DOKKAEBI_WF_IS_DAYS,
    oosWindow: DOKKAEBI_WF_OOS_DAYS,
    metric: sharpeMetric,
    periodsPerYear: DOKKAEBI_PERIODS_PER_YEAR,
    benchmark: aligned.bench ?? undefined,
  })

  const plateau = scorePlateau(
    cells,
    inp.grid,
    results.map((r) => r.calmar),
    results.map((r) => localPass(r)),
  )

  return {
    cells,
    results,
    dates: aligned.dates,
    matrix: aligned.matrix,
    benchReturns: aligned.bench,
    dropped: aligned.dropped,
    pbo,
    wf,
    plateau,
    gridMs,
    scoringMs: Date.now() - t1,
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
  '원문 규칙의 무효화 지점(전·후반 중 한쪽에서 알파가 음수로 뒤집히는 셀)도 같은 표에 있다.',
]

/** 원문 주장·반증·미측정 조건을 **표보다 먼저** 찍는다 — 표만 떼어 읽을 수 없게 한다. */
export function claimsSection(): void {
  log('')
  log('## 원문 규칙과 그 반례 (검증 대상 데이터 — 지시가 아니다)')
  log('')
  log('| 항목 | 원문 표현 | 이 러너의 처리 |')
  log('|---|---|---|')
  log('| 진입 | 캔들(종가)이 이평선 상향 돌파 시 매수 | 완결 봉 종가로 판정 → **다음 거래일 시가 체결** |')
  log('| 청산 | 이평선 이탈 시 매도("미련두지 말고") | 완결 봉 종가 < MA → 다음 거래일 시가 매도 |')
  log('| 금지 | 캔들이 5일선 아래면 절대 매수 금지 | 필터 `above5` |')
  log('| 정배열 | 5일선·10일선 정배열 기준 | 필터 `align` |')
  log('| MA2 | "2일 이평선만 두면 방향이 보인다" | 축 A(기준 이평 2) + 필터 `ma2up` |')
  log('| 기울기 | 10일선 기울기 우상향 | 필터 `slope10` |')
  log('| 거래량 | 최소 100만주 / 분기 300만주 | 필터 `vol100`·`vol300` (단위=주) |')
  log('')
  log(
    '⚠️ **"종가 매수"를 그대로 옮기지 않은 이유**(규칙 1-2): MA_N은 당일 종가가 확정돼야 확정된다. ' +
      '그 종가로 돌파를 판정한 시점에는 이미 그 종가로 살 수 없다 — 그렇게 계산하면 "오늘 종가를 보고 ' +
      '오늘 종가에 샀다"가 되어 백테스트가 거짓말을 한다. 그래서 **판정은 봉 j, 체결은 봉 j+1 시가**다.',
  )
  log('')
  log(
    '⛔ **미측정 조건**: "양봉 + 외인·기관 동시 순매수". 키움 수급 백필(ka10059)이 아직 돌지 않아 ' +
      '`public/data/flow/`가 비어 있다. **추정으로 대신 채우지 않았다** — 별도 트랙이다.',
  )
  log(
    '⛔ **일봉으로 잴 수 없는 것**: 원문 MA2 규칙의 "시초가가 2일선 아래여도 **장중** 돌파하면 매수"는 ' +
      '일봉에 장중 경로가 없어 **종가 기준 돌파로 근사**했다. 이 표는 그 질문의 답이 아니다(분봉 트랙 필요).',
  )
  log(
    '↔️ **반증 근거(같은 무게로 병기)**: 같은 스레드에 실사용자 댓글 "손절계속나가니 시드가 다갈렸습니다"' +
      '(좋아요 10)가 있다. 원저자의 "3개월 백테스트하면 손실 안 난다"는 **3개월 표본**이라 근거로 부족하다.',
  )
}

export function limitsSection(opts: {
  benchLabel: string
  priceMeta?: Pick<PriceSourceMeta, 'note' | 'limits'>
  universeNote: string
  cellCount: number
  pboMaxCombos: number
  pboExhaustive: boolean
  synthetic?: boolean
  basis?: ReturnBasis
  widthCapped: boolean
}): void {
  log('')
  log('## 한계 · 편향 (규칙 3 — 숨기지 않는다)')
  log('')
  if (opts.synthetic)
    log(
      '⚠️ **이 실행은 합성 데이터다.** 아래 생존편향·수집 연도 항목은 **실데이터 경로**의 한계 설명이며 ' +
        '이 실행에는 해당하지 않는다. 형식이 깨지지 않는지 확인하려고 같은 섹션을 그대로 태운다.',
    )
  const basis: ReturnBasis = opts.basis ?? 'total'
  const items: string[] = []
  items.push(
    basis === 'price'
      ? '**배당 비대칭 — 제거했다(40차 규약).** 국내 유니버스 시세는 KRX 일별 정본으로 **가격수익**' +
          '(배당 미반영)이고, 벤치(KODEX 200)도 **같은 가격수익**으로 받는다(야후 `adjclose ÷ close` 계수를 ' +
          '곱하지 않는다). 알파는 어느 쪽으로도 기울지 않는다 — 전략을 유리하게 만드는 보정이 아니라 ' +
          '기울지 않은 비교이며 **결과가 나빠질 수도 있다.** ⚠️ 2026-07-30 야후 측정치(원문 −19.0%p 등)는 ' +
          '**다른 시세·다른 유니버스·다른 벤치 기준**이라 이 표와 직접 비교하지 마라.'
      : '**배당 비대칭 — 이 실행에서는 없다.** 전략도 벤치도 야후 총수익 기준이라 배당 반영 여부가 갈리지 않는다.',
  )
  if (opts.widthCapped)
    items.push(
      '**유니버스 폭 상한 = 80종목.** 지시서의 "시총 상위 200"은 이 리포에 데이터가 없다 — ' +
        `\`${KRX_PIT_PATH}\`는 KRX Open API 수집기가 **시장당 상위 40**까지만 받아 저장한 파일이다. ` +
        '없는 랭킹을 [추정] 목록으로 메우면 33차가 무너진 경로를 되풀이하게 되므로, **가용 최대인 ' +
        '40+40=80으로 대체**했다. "폭을 넓히면 어떻게 되나"라는 질문은 이 표로 200까지 외삽되지 않는다.',
    )
  items.push(
    '**가격 생존편향.** 랭킹은 KRX 실측이라 목록 선택편향은 없지만, 상장폐지 종목의 **가격**이 없으면 ' +
      '유니버스에서 빠진다 — 그 방향은 성적을 후하게 만든다(규칙 1-7).',
  )
  items.push(
    '**2010년 이전은 수집 자체가 불가능**하다(KRX Open API 시작). 2008 금융위기가 빠져 있어 MDD가 과소평가된다.',
  )
  items.push(
    `**다중검정.** 이번 회차 ${opts.cellCount}변형은 같은 국장 데이터·같은 유니버스를 또 한 번 본 것이다. ` +
      `누적 분모는 ${DOKKAEBI_TRIALS_PRIOR_TOTAL} + ${opts.cellCount} = ${DOKKAEBI_TRIALS_PRIOR_TOTAL + opts.cellCount}이며 ` +
      'DSR은 그 분모로 찍는다. **41차(미장 48변형)는 다른 데이터셋이라 넣지 않았다.** ' +
      '구조적으로 같은 셀(항등 쌍)도 분모에서 빼지 않는다 — 분모를 줄이는 쪽으로 반올림하지 않는다.',
  )
  items.push(
    (opts.pboExhaustive
      ? `**PBO 조합.** C(${DOKKAEBI_PBO_BLOCKS},${DOKKAEBI_PBO_BLOCKS / 2}) 조합을 **전수 평가**했다(${opts.pboMaxCombos}개). `
      : `**PBO 조합 샘플링.** ${opts.pboMaxCombos}개만 **사전식 등간격 결정적 샘플링**으로 평가했다(난수 아님·재현 가능). `) +
      '단일 실행의 PBO는 크게 흔들린다(overfit.ts 주석 — 무신호 합성에서 0.09~0.89까지 퍼졌다) — ' +
      '숫자 하나로 결론짓지 말고 λ 분포·DSR·워크포워드를 함께 읽어라.',
  )
  items.push(
    `**고정 전제(격자 축이 아닌 것).** 슬롯 ${DOKKAEBI_SLOTS} · 동일가중 · 후보 정렬 = 신호 봉 거래대금 내림차순 · ` +
      `연도별 유니버스 교체(6/30 편입 판정) · 구간 끝 청산비용 근사 ON · 그 해 매핑 ${MIN_SYMBOLS}종목 미만이면 현금 · ` +
      `거래량 임계는 원문 숫자(${VOL_THRESHOLD_100.toLocaleString()}·${VOL_THRESHOLD_300.toLocaleString()}주) 고정. ` +
      '이 전제를 바꾸면 격자 전체가 다른 실험이 된다.',
  )
  items.push(
    '**모든 셀이 경계 셀이다.** ma 축·width 축이 값 2개씩이라 **완전 내부 셀은 0개**이며 전 셀에 ' +
      '`[표본부족]`이 붙는다. 고원 판정은 실질적으로 **필터 격자(조건 하나 추가·제거)** 위에서만 이뤄진다 — ' +
      '없는 이웃을 0이나 평균으로 메우지 않았고, 그 방향의 고원성은 **검증되지 않았다**.',
  )
  items.push(
    '**거래량 단위 확인 완료.** KRX 정본의 `v`는 그날 체결된 **주식 수(주)**다(자기검증: 삼성전자 2010-01-04 ' +
      '원주가 종가 809,000원 · 거래량 239,271주). 가격은 분할 보정되지만 **거래량은 보정하지 않는다** — ' +
      '따라서 절대 임계는 "그날 화면에 찍힌 거래량"과 같은 뜻이고, 이는 원문 규칙의 의미와 일치한다.',
  )
  items.push(opts.universeNote)
  items.forEach((t, i) => log(`${i + 1}. ${t}`))
  if (opts.priceMeta) {
    log(`${items.length + 1}. ${opts.priceMeta.note}`)
    for (const l of opts.priceMeta.limits) log(`   · ${l}`)
    log(`   · ${MIXED_SOURCE_NOTE}`)
  }
}

export function report(out: RunOutputs, inp: RunInputs, opts: { benchLabel: string }): number {
  const half = halfYearOf(inp.years)
  const n = out.cells.length
  const trialsCumulative = DOKKAEBI_TRIALS_PRIOR_TOTAL + n

  // ---- 변형 전체 표 -----------------------------------------------------
  log('')
  log(`## 변형 전체 ${n}종 — 알파 판정(규칙 5) · 벤치 ${opts.benchLabel}`)
  log('')
  log(
    '| 변형 | 총수익 | CAGR | MDD | 칼마 | 매매 | 승률 | 신호미체결 | 알파(전구간) | 전반 알파 | 후반 알파 | 관문①② |',
  )
  log('|---|---|---|---|---|---|---|---|---|---|---|---|')
  const ordered = [...out.results].sort((x, y) => (y.alphaFull ?? -1e9) - (x.alphaFull ?? -1e9))
  for (const r of ordered) {
    const bad = localFailReasons(r)
    const win = r.trades > 0 ? (r.wins / r.trades) * 100 : null
    log(
      `| \`${r.cell.key}\`${isDuplicateCell(r.cell.params) ? ' [중복셀]' : ''} | ${pct(r.full.total)} | ${pct(r.full.cagr)} | ` +
        `${pct(r.full.mdd)} | ${num(r.calmar)} | ${r.trades} | ${win == null ? '—' : `${win.toFixed(0)}%`} | ` +
        `${r.skippedSignals} | ${pp(r.alphaFull)} | ${pp(r.alphaA)} | ${pp(r.alphaB)} | ` +
        `${bad.length === 0 ? '✅' : `❌ ${bad.join('·')}`} |`,
    )
  }
  log('')
  log(
    '`[중복셀]` = MA5에서 `above5`는 상향 돌파 조건에 이미 포함돼 있어 구조적으로 같은 셀이다 ' +
      '(아래 항등 점검이 그것을 자기검증한다). **독립 탐색 36건으로 읽지 마라.**',
  )

  // ---- 항등 점검 --------------------------------------------------------
  const idc = identityChecks(out.results)
  if (idc.length > 0) {
    log('')
    log('### 항등 점검 — 구조적으로 같아야 하는 셀 쌍')
    log('')
    for (const c of idc) log(`· ${c.ok ? '✅' : '❌'} ${c.label} — ${c.detail}`)
    if (idc.some((c) => !c.ok))
      log('❌ **항등이 깨졌다 — 필터 배선이나 돌파 정의가 어긋난 것이다. 이 실행의 표를 판정에 쓰지 마라.**')
  }

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
    `  구간 ${out.wf.segments.length}개 (IS ${DOKKAEBI_WF_IS_DAYS}일 → OOS ${DOKKAEBI_WF_OOS_DAYS}일) · ` +
      `OOS 연환산 ${pp(out.wf.oosAnnualizedPct)} · 벤치 연환산 ${pp(out.wf.benchAnnualizedPct)} · ` +
      `IS→OOS 저하율 ${out.wf.degradationPct == null ? '—' : `${out.wf.degradationPct.toFixed(1)}%`}`,
  )
  for (const note of out.wf.notes.slice(0, 5)) log(`  ⚠️ ${note}`)

  // ---- DSR (누적 분모) ---------------------------------------------------
  const trialSharpes = out.results.map((r) => r.sharpeDaily).filter((v): v is number => v != null)
  let winner = -1
  let bestPlateau = -Infinity
  for (const p of out.plateau) {
    if (p.plateauScore == null) continue
    if (p.plateauScore > bestPlateau) {
      bestPlateau = p.plateauScore
      winner = p.index
    }
  }
  let winnerBasis = '고원 점수 1위'
  if (winner < 0) {
    winnerBasis = '칼마 1위 (고원 점수를 낼 수 있는 셀이 없다)'
    let best = -Infinity
    out.results.forEach((r, i) => {
      if (r.calmar != null && r.calmar > best) {
        best = r.calmar
        winner = i
      }
    })
  }
  log('')
  log(`### 다중검정 보정 — 누적 분모 ${DOKKAEBI_TRIALS_PRIOR_TOTAL} + ${n} = ${trialsCumulative}`)
  log('')
  for (const r of DOKKAEBI_TRIALS_PRIOR) log(`· ${r.round}: ${r.n}변형`)
  log(`· 42차 (이번 도깨비 격자): ${n}변형`)
  if (winner >= 0) {
    const w = out.results[winner]
    const m = sharpeMoments(w.dailyReturns)
    log('')
    log(`승자 판정 근거: **${winnerBasis}** — \`${w.cell.key}\``)
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
        `· 이번 회차 N=${n} DSR ${num(mt.thisRound.dsr)} / **누적 N=${trialsCumulative} DSR ${num(mt.cumulative.dsr)}** ` +
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

  // ---- 고원 채점 --------------------------------------------------------
  const roundGate = { pbo: out.pbo.pbo, wfOosAlpha: out.wf.oosAlphaPct }
  const verdicts = out.results.map((r, i) => promotionVerdict(r, out.plateau[i], roundGate))
  const promoted = verdicts.map((v, i) => ({ v, i })).filter((x) => x.v.promoted)

  const scored = out.plateau.filter((p) => p.plateauScore != null)
  const interior = out.plateau.filter((p) => !p.sampleShort)
  log('')
  log('## 고원 채점 — 조건을 한 칸 흔들어도 성적이 유지되는 영역이 있는가')
  log('')
  const shakeAxes = inp.grid.axes.filter((a) => a.values.length > 1)
  const frozenAxes = inp.grid.axes.filter((a) => a.values.length < 2)
  log(
    `· 고원 점수를 낼 수 있는 셀 ${scored.length}/${n}개 · 완전 내부 셀 ${interior.length}개 · ` +
      `경계 셀 **[표본부족] ${n - interior.length}개**`,
  )
  log(
    '· 이웃 정의: 순서 있는 축(ma·width)은 ±1 스텝 · **필터 축은 조건 격자**(조건 하나 추가·제거, ' +
      'vol100↔vol300은 임계 한 칸). 배열 순서로 ±1을 하지 않는다 — 필터는 순서가 없다.',
  )
  if (frozenAxes.length > 0)
    log(
      `· ⚠️ 값이 1개뿐이라 **아예 흔들지 않은 축**: ${frozenAxes.map((a) => a.key).join(', ')} — ` +
        '그 방향의 고원성은 이 실행으로 검증되지 않았다(경계 문제가 아니라 설계상 고정이다).',
    )
  log(
    `· plateauScore = **셀과 이웃 성적의 최솟값**(평균 아님) · plateauDrop = (셀 − 이웃최솟값) ÷ |셀| · ` +
      `고원 임계 ${DOKKAEBI_DROP_THRESHOLD} · 흔든 축 ${shakeAxes.length}개`,
  )
  const flat = scored.filter((p) => p.plateauDrop != null && (p.plateauDrop as number) <= DOKKAEBI_DROP_THRESHOLD)
  log(
    `· plateauDrop ≤ ${DOKKAEBI_DROP_THRESHOLD}인 셀 ${flat.length}개 · 그중 이웃 전부가 관문①을 통과한 셀 ` +
      `${flat.filter((p) => p.neighborsPassLocal === true).length}개`,
  )

  const top = [...scored].sort((x, y) => (y.plateauScore as number) - (x.plateauScore as number)).slice(0, 15)
  log('')
  log('### 고원 점수 상위 15셀')
  log('')
  log(
    '| 셀 | 칼마(셀) | 이웃최솟값 | **plateauScore** | plateauDrop | 이웃 | CAGR | MDD | 전반 알파 | 후반 알파 | 매매 | 관문 |',
  )
  log('|---|---|---|---|---|---|---|---|---|---|---|---|')
  for (const p of top) {
    const r = out.results[p.index]
    const v = verdicts[p.index]
    log(
      `| \`${r.cell.key}\`${p.sampleShort ? ' [표본부족]' : ''} | ${num(p.self)} | ${num(p.minNeighbor)} | ` +
        `**${num(p.plateauScore)}** | ${num(p.plateauDrop)} | ${p.neighbors}${p.sampleShort ? `(-${p.missing.length})` : ''} | ` +
        `${pct(r.full.cagr)} | ${pct(r.full.mdd)} | ${pp(r.alphaA)} | ${pp(r.alphaB)} | ${r.trades} | ` +
        `${v.promoted ? '✅ 승격' : `❌ ${v.failed.join('·')}`} |`,
    )
  }

  // ---- 승격 판정 --------------------------------------------------------
  log('')
  log(`## 승격 관문 — ①전·후반 알파 ②매매≥${DOKKAEBI_MIN_TRADES} ③PBO<${PBO_WARN_THRESHOLD} ④WF OOS 알파>0 ⑤고원`)
  log('')
  const cnt = (k: number) => verdicts.filter((v) => v.passed.includes(k)).length
  log(`| 관문 | 통과 변형 |`)
  log(`|---|---|`)
  log(`| ① 전·후반 알파 양수 | ${cnt(1)} / ${n} |`)
  log(`| ② 매매수 ≥ ${DOKKAEBI_MIN_TRADES} | ${cnt(2)} / ${n} |`)
  log(`| ③ PBO < ${PBO_WARN_THRESHOLD} | ${cnt(3)} / ${n} (회차 단위 값이라 전부 같다) |`)
  log(`| ④ 워크포워드 OOS 알파 > 0 | ${cnt(4)} / ${n} (회차 단위 값이라 전부 같다) |`)
  log(`| ⑤ 고원(drop ≤ ${DOKKAEBI_DROP_THRESHOLD} + 이웃 전부 ① 통과) | ${cnt(5)} / ${n} |`)
  log('')
  if (promoted.length === 0) {
    log('### 결론: **승격 0건**')
    log('')
    log(
      '다섯 관문을 전부 통과한 변형이 없다. **가장 덜 나쁜 칸을 승격시키지 않는다** — 그렇게 고른 칸이 ' +
        '아웃샘플에서 무너지는 것이 38차에서 이미 측정됐다(PBO 0.622 · WF OOS 알파 −13.81%p).',
    )
  } else {
    log(`### 승격 후보 ${promoted.length}건`)
    log('')
    log('| 셀 | plateauScore | plateauDrop | 칼마 | 알파(전구간) | 전반 알파 | 후반 알파 | 매매 | 이웃 |')
    log('|---|---|---|---|---|---|---|---|---|')
    for (const { i } of promoted) {
      const r = out.results[i]
      const p = out.plateau[i]
      log(
        `| \`${r.cell.key}\`${p.sampleShort ? ' **[표본부족]**' : ''} | ${num(p.plateauScore)} | ${num(p.plateauDrop)} | ` +
          `${num(r.calmar)} | ${pp(r.alphaFull)} | ${pp(r.alphaA)} | ${pp(r.alphaB)} | ${r.trades} | ` +
          `${p.neighbors}/${p.neighbors + p.missing.length} |`,
      )
    }
    log('')
    log(
      '⚠️ 승격은 "채택"이 아니다. 라이브(페이퍼) 검증 전에는 확정이 아니며, `[표본부족]` 라벨이 붙은 셀은 ' +
        '그 방향의 고원성이 **검증되지 않았다**.',
    )
  }

  // ---- 축별 요약 --------------------------------------------------------
  log('')
  log('### 축별 평균 알파(전구간) — "어느 축이 움직였나"를 한눈에')
  log('')
  const avg = (rows: CellResult[]): string => {
    const vs = rows.map((r) => r.alphaFull).filter((v): v is number => v != null)
    return vs.length === 0 ? '—' : `${f1(vs.reduce((s, v) => s + v, 0) / vs.length)}%p (n=${vs.length})`
  }
  log('| 축 | 값 | 평균 알파 |')
  log('|---|---|---|')
  for (const v of inp.grid.axes.find((a) => a.key === 'ma')?.values ?? [])
    log(`| 기준 이평 | MA${v} | ${avg(out.results.filter((r) => r.cell.params.maN === v))} |`)
  for (const v of inp.grid.axes.find((a) => a.key === 'width')?.values ?? [])
    log(`| 유니버스 폭 | ${widthLabelOf(v as KrxTopN)} | ${avg(out.results.filter((r) => r.cell.params.topN === v))} |`)
  for (const v of inp.grid.axes.find((a) => a.key === 'filter')?.values ?? [])
    log(`| 진입 필터 | ${v} | ${avg(out.results.filter((r) => r.cell.params.filter === v))} |`)
  log('')
  log('⚠️ 축별 평균은 **탐색 결과의 요약**이지 판정이 아니다 — 판정은 위의 승격 관문 5개다.')

  log('')
  log(`전·후반 분할: 전반 ${inp.years[0]}~${half - 1} / 후반 ${half}~${inp.years[inp.years.length - 1]}`)
  log(
    `⚠️ 짧은 표본 — 전 구간 ${inp.years.length}년. 국면 하나가 한 구간을 통째로 지배할 수 있어 ` +
      '"전·후반 모두 양수"가 재현성의 증거가 되기엔 부족하다.',
  )
  return promoted.length
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

/** 합성 일봉 — 주말 포함(달력 경계 판정만 보므로 무해). 거래량도 흔들어 vol 필터 경로를 태운다. */
export function syntheticBars(seed: number, from: string, days: number, base = 10_000, drift = 0): DailyBar[] {
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
      v: Math.floor(200_000 + rnd() * 5_000_000),
      rawClose: c,
    })
  }
  return bars
}

/** 합성 유니버스 — 셀 시간 측정·배선 확인용. */
export function syntheticWorld(nSyms = 16, years = 8, seed = 7) {
  const from = '2009-01-01'
  const days = (years + 2) * 365
  const histories: Record<string, DailyBar[]> = {}
  const codes: string[] = []
  for (let i = 0; i < nSyms; i++) {
    const code = `S${String(i).padStart(3, '0')}`
    codes.push(code)
    histories[code] = syntheticBars(seed + i, from, days, 10_000 + i * 100, (i - nSyms / 2) * 0.00005)
  }
  const yearList: number[] = []
  for (let y = 2010; y < 2010 + years; y++) yearList.push(y)
  return { histories, codes, years: yearList, codesFor: () => codes }
}

/** 유니버스 동일가중 지수 — 합성 실행의 벤치(KODEX 200이 **아니다**). */
export function equalWeightIndex(
  histories: Record<string, DailyBar[]>,
  codes: readonly string[],
  from: string,
): Curve {
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

export type Mode = 'all' | 'ma2' | 'quick' | 'selftest'

export function modeFromEnv(env: NodeJS.ProcessEnv = process.env): Mode {
  const m = (env.MODE ?? 'all').trim().toLowerCase()
  if (m === 'all' || m === 'ma2' || m === 'quick' || m === 'selftest') return m
  throw new Error(`알 수 없는 MODE=${m} — all | ma2 | quick | selftest 중 하나여야 한다`)
}

export const gridFor = (mode: Mode): GridSpec =>
  mode === 'ma2' ? MA2_GRID : mode === 'quick' ? QUICK_GRID : FULL_GRID

async function main(): Promise<void> {
  const mode = modeFromEnv()
  log('# 42차 — 유튜브 댓글발 이평선 돌파 매매법 재측정 (KRX 정본 · 배당 편향 제거)')
  log('')
  log(
    '2026-07-30 측정은 **야후 총수익 + [추정] 유니버스**였고, 33·37·40차에서 그 조합이 알파를 크게 ' +
      '왜곡한다는 것이 드러났다. 그래서 **기준선부터 다시 잰다.** 이번 회차의 가치는 "5일선이 되나"가 ' +
      '아니라 **한 번도 테스트하지 않은 MA2 축 · 절대 거래량 임계 · 10일선 기울기**에 있다.',
  )
  log('')
  log(`MODE=${mode}`)

  if (mode === 'selftest') {
    await runSelftest()
    return
  }

  const grid = gridFor(mode)
  const cells = enumerateGrid(grid)
  log(
    `격자(${grid.label}): ${grid.axes.map((a) => `${a.key}[${a.values.join(',')}]`).join(' × ')} = **${cells.length}변형**`,
  )
  if (mode === 'quick') log('⚠️ **스모크런이다 — 이 결과로 어떤 판정도 하지 않는다.**')

  claimsSection()

  // ---- 유니버스 (폭 2종) ------------------------------------------------
  const widths = [...new Set(cells.map((c) => c.params.topN))].sort((a, b) => a - b)
  const universes = new Map<number, DerivedKrxUniverse>()
  for (const w of widths) universes.set(w, loadUniverse(ROOT, normalizeWidth({ kospi: w, kosdaq: w } as KrxWidth)))
  const widest = universes.get(widths[widths.length - 1])!
  log('')
  for (const w of widths) {
    const u = universes.get(w)!
    log(`유니버스 ${widthLabelOf(w as KrxTopN)}: ${u.label} (폭 ${krxWidthLabel(u.width)})`)
  }
  log(`⚠️ ${widest.sourceNote}`)
  log(
    '⚠️ **지시서의 "시총 상위 200"은 이 데이터로 잴 수 없다** — 수집 원본이 시장당 상위 40이라 상한이 ' +
      '80종목이다. 없는 랭킹을 [추정]으로 메우지 않고 **가용 최대(40+40)로 대체**했다.',
  )

  // ---- 시세 (KRX 정본 — 야후로 조용히 폴백하지 않는다) --------------------
  const priceSource: PriceSource = normalizePriceSource((process.env.PRICE_SOURCE ?? 'krx').trim().toLowerCase())
  log(`시세 소스: ${priceSource}${priceSource === 'krx' ? ' (기본)' : ' (PRICE_SOURCE로 지정)'}`)
  const basis = compareBasisFor(priceSource)
  setCompareBasis(basis)
  log(`⚖️ ${compareBasisNote(basis)}`)

  const load = await loadKrPrices(widest.union, priceSource, {
    yahoo: {
      fetchDaily: (sym) => fetchDaily(sym, 'since:2009-01-01'),
      betweenAttempts: () => sleep(120),
      concurrency: 1,
    },
    krx: nodeKrxDeps(ROOT),
  })
  log(`시세 로드 ${load.meta.loaded}/${widest.union.length}${load.failed.length ? ` · 실패: ${load.failed.join(', ')}` : ''}`)
  log(`  ${load.meta.note}`)
  if (load.meta.loaded === 0) throw new Error('시세를 하나도 받지 못했다 — 실행 중단')
  // 규칙 4 — 거래량이 없으면 vol 필터가 **조용히 전부 거짓**이 된다. 그런 표를 만들지 않는다.
  if (load.krxIndex && !load.krxIndex.volume)
    throw new Error(
      'KRX 정본에 거래량이 없다(index.volume=false) — vol100·vol300 필터가 조용히 전부 탈락으로 돌아 ' +
        '"거래량 필터는 효과 없음"이라는 거짓 결론이 나온다. 거래량 포함 재수집이 필요하다.',
    )

  // ---- 벤치 ------------------------------------------------------------
  const tally = newYahooTally()
  const bars = await tallyFetch(tally, BENCH, BENCH_RANGE, basis)
  if (!bars)
    throw new Error(
      `벤치(${BENCH}) 로드 실패 — 알파 판정(규칙 5)이 불가능하므로 실행을 중단한다. ` +
        `사유: ${tally.failed.map((f) => `${f.symbol}: ${f.reason}`).join(' / ')}. ` +
        '다른 벤치로 조용히 대체하지 않는다.',
    )
  const benchEq: Curve = bars.filter((b) => b.c > 0).map((b) => ({ date: b.date, equity: b.c }))
  const benchLabel = `${BENCH} KODEX 200`
  log(
    `벤치: ${benchLabel} ${bars.length}봉 (${bars[0].date} ~ ${bars[bars.length - 1].date}) · ` +
      `${basis === 'price' ? '가격수익(배당 제외 — 전략과 같은 기준)' : '총수익(배당 재투자)'}`,
  )

  // ---- 연도 컨텍스트(폭별 · 파라미터 무관 — 한 번만 만든다) ---------------
  const resolve = (code: string) => load.symOf[code]
  const ctxsByWidth = new Map<number, YearCtx[]>()
  log('')
  for (const w of widths) {
    const u = universes.get(w)!
    const ctxs = buildYearCtxs(load.histories, u.years, u.codesFor, resolve)
    ctxsByWidth.set(w, ctxs)
    const usable = ctxs.filter((c) => c.symbols.length >= MIN_SYMBOLS)
    log(
      `연도 컨텍스트 ${widthLabelOf(w as KrxTopN)}: ${ctxs.length}년 · 실행 가능 ${usable.length}년 · ` +
        `매핑률 ${ctxs.map((c) => `${c.y}:${c.symbols.length}/${c.totalCodes}`).join(' ')}`,
    )
    if (usable.length < 2) throw new Error(`폭 ${w}에서 실행 가능한 연도가 2년 미만이다 — 실행 중단`)
  }

  // ---- 격자 실행 --------------------------------------------------------
  log('')
  const t0 = Date.now()
  let firstCellMs = 0
  const inputs: RunInputs = {
    grid,
    ctxsByWidth,
    years: widest.years,
    cost: DOKKAEBI_COST,
    benchCurve: benchEq,
    benchLabel,
  }
  const out = runGrid(inputs, (done, total, ms) => {
    if (done === 1) {
      firstCellMs = ms
      log(`1변형 실측 ${ms}ms → ${total}변형 예상 ${((ms * total) / 1000).toFixed(0)}초 (격자 실행분만)`)
    }
    if (done % 10 === 0 || done === total)
      log(`  격자 진행 ${done}/${total} · 경과 ${((Date.now() - t0) / 1000).toFixed(0)}초`)
  })
  log(
    `격자 실행 ${(out.gridMs / 1000).toFixed(1)}초 (${out.cells.length}변형 · 1변형 ${firstCellMs}ms · ` +
      `평균 ${(out.gridMs / out.cells.length).toFixed(0)}ms) + 사후 채점 ${(out.scoringMs / 1000).toFixed(1)}초 ` +
      `= 합계 ${((out.gridMs + out.scoringMs) / 1000).toFixed(1)}초`,
  )

  const promotedCount = report(out, inputs, { benchLabel })

  // ---- 야후 집계 (규칙 4 — 성공 카운터를 반드시 찍는다) ------------------
  log('')
  log(`야후 호출 집계: 시도 ${tally.attempted} · 성공 ${tally.ok} · 실패 ${tally.failed.length}`)
  for (const f of tally.failed) log(`  ❌ ${f.symbol} — ${f.reason}`)
  if (tally.ok === 0)
    throw new Error('야후 호출이 전량 실패했다 — 조용히 통과시키지 않고 비정상 종료한다(규칙 4).')

  limitsSection({
    benchLabel,
    priceMeta: load.meta,
    universeNote: widest.sourceNote,
    cellCount: out.cells.length,
    pboMaxCombos: out.pbo.combinationsEvaluated,
    pboExhaustive: out.pbo.exhaustive,
    basis,
    widthCapped: true,
  })
  for (const l of DISCLAIMER) log(l)
  log('')
  log(`## 한 줄 결론 — 승격 ${promotedCount}건 / ${out.cells.length}변형`)
}

/** 합성 자기검증 — 파일·네트워크 없이 배선과 산술이 도는지 확인한다. */
async function runSelftest(): Promise<void> {
  log('')
  log('## 자기검증 (합성 데이터 — 실데이터가 아니다. 이 표의 수치로 어떤 판정도 하지 않는다)')
  const world = syntheticWorld(16, 8, 7)
  const bench = equalWeightIndex(world.histories, world.codes, `${world.years[0]}-01-01`)
  const benchLabel = '합성 동일가중'
  const ctxs = buildYearCtxs(world.histories, world.years, world.codesFor, (c) => c)
  // 합성 세계에는 시총 랭킹이 없다 — 두 폭 모두 **같은 컨텍스트**를 가리킨다(배선만 확인).
  // 그래서 이 실행에서 width 축은 **성적이 동일하게 나오는 것이 정상**이며, 그것으로
  // "폭은 영향이 없다"는 결론을 내면 안 된다.
  const ctxsByWidth = new Map<number, YearCtx[]>()
  for (const w of WIDTH_VALUES) ctxsByWidth.set(w, ctxs)
  log('')
  log(
    '⚠️ 합성 세계에는 시총 랭킹이 없어 **두 폭이 같은 유니버스**를 본다 — width 축의 두 값이 ' +
      '같은 수치로 나오는 것이 정상이고, 그것으로 "폭은 영향 없음"이라고 읽으면 안 된다.',
  )
  const inputs: RunInputs = {
    grid: FULL_GRID,
    ctxsByWidth,
    years: world.years,
    cost: DOKKAEBI_COST,
    benchCurve: bench,
    benchLabel,
  }
  claimsSection()
  const out = runGrid(inputs)
  log('')
  log(
    `변형 ${out.cells.length}개 · 격자 ${(out.gridMs / 1000).toFixed(2)}초 + 채점 ${(out.scoringMs / 1000).toFixed(2)}초 · ` +
      `공통 거래일 ${out.dates.length}일`,
  )
  // 보고서 경로까지 그대로 태운다 — 출력 형식이 깨지는 것을 실데이터 실행 전에 잡기 위해서다.
  const promoted = report(out, inputs, { benchLabel })
  limitsSection({
    benchLabel,
    universeNote: '합성 유니버스(실데이터가 아니다)',
    cellCount: out.cells.length,
    pboMaxCombos: out.pbo.combinationsEvaluated,
    pboExhaustive: out.pbo.exhaustive,
    synthetic: true,
    widthCapped: false,
  })
  log('')
  log(
    `⚠️ **합성 데이터다. 이 표의 수치로 어떤 판정도 하지 않는다**(승격 ${promoted}건이라는 표기도 배선 확인용이다). ` +
      '실데이터 실행은 GHA `Backtest (GHA runner)` · mode `dokkaebi:all`.',
  )
  for (const l of DISCLAIMER) log(l)
}

// 런처(scripts/dokkaebi-lab.mjs)만 이 값을 넘긴다.
// 테스트가 이 모듈을 import할 때는 자동 실행되지 않는다.
if (process.env.DOKKAEBI_LAB_RUN === '1') {
  main().catch((e) => {
    console.error('실행 실패:', e)
    process.exit(1)
  })
}
