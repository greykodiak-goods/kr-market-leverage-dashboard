// 고원(plateau) 채점 격자 랩 — 39차 "역추적 최적화"
//
// ════════════════════════════════════════════════════════════════════════════
// ── 이 회차는 "더 좋은 1등 칸"을 찾는 것이 **아니다** ────────────────────────
// ════════════════════════════════════════════════════════════════════════════
//
//   33~38차에서 실측 누적 **97변형**을 돌렸고 QQQ 원화 보유 벽(칼마 0.670)을 넘은 변형은
//   **0개**였다. 38차에서 처음으로 과최적화를 수치로 쟀는데 결과가 이랬다:
//
//       PBO 0.622 (임계 0.5 초과) · 워크포워드 OOS 알파 −13.81%p · IS→OOS 저하율 146.9%
//
//   즉 **"격자를 돌려 1등 칸을 고르는" 절차 자체가 아웃샘플에서 무너진다**는 것이 이미
//   관측됐다. 그래서 39차의 질문은 "어느 칸이 제일 좋나"가 아니라 이것이다:
//
//       **파라미터를 흔들어도 성적이 유지되는 영역(고원)이 존재하는가?**
//
//   고원이 없으면 "없다"가 정답이다. 이 파일은 좋은 숫자를 만들어내려고 만든 것이 아니다 —
//   **부풀린 수치는 이 프로젝트에서 최악의 결함이다.** 관문을 통과한 칸이 0개면 0개로
//   보고하고 끝낸다. "가장 덜 나쁜 칸"을 승격시키는 경로는 코드에 아예 없다.
//
// ── 고원 채점이 무엇인가 ─────────────────────────────────────────────────────
//   격자를 다차원 배열로 놓고 각 셀의 **이웃 셀**(각 축에서 ±1 스텝, 대각선 제외)을 본다.
//     · `plateauScore(cell)` = 셀과 이웃들의 성적 중 **최솟값(min)** — 평균이 아니다.
//        이웃 하나만 무너져도 고원이 아니기 때문이다.
//     · `plateauDrop(cell)` = (셀 − 이웃최솟값) ÷ |셀| — 봉우리의 가파름. 크면 단일 봉우리다.
//   성적 지표는 **칼마(CAGR ÷ |MDD|)** 다(31차 대표 채택 기준).
//
// ── 🚫 규칙 1(미래참조 금지) — 이 파일에서 지킨 것 ────────────────────────────
//   1. 랭킹(모멘텀)은 리밸런스일 **이전에 확정된 종가**만 본다. skip=0이어도 기준일이
//      "그 달 1일 **직전** 종가"라 리밸런스일 당일 값이 들어가지 않는다.
//   2. 체결은 리밸런스일 **시가**다. 그날 종가·고가·저가는 판정에 쓰지 않는다.
//   3. 시장게이트 MA는 판정일 **직전** N개 종가로만 계산한다(당일 제외 — 규칙 1-3).
//      데이터 부족으로 판정 불가면 **게이트 열림(1)** — 사후지식 없이 기본값을 쓴다
//      (`marketGate.ts`와 같은 규약).
//   4. 연도별 입력 봉을 `date <= 구간끝`으로 **잘라서** 넘긴다 — 뒤 연도를 통째로 잘라내도
//      앞 연도의 체결·자산곡선이 완전히 같아야 한다.
//   5. **마지막 봉 신규 진입 금지**(규칙 1-6) — 시뮬 구간의 마지막 봉에서는 신규 매수를
//      만들지 않는다(매도는 허용). 실무상 구간 끝은 12월 말이라 리밸런스일이 아니지만,
//      절단 실행·조기 종료에서 규칙이 조용히 새는 것을 막으려고 코드로 박았다.
//   6. **전 구간 통계 금지**(규칙 1-5) — 격자 전체 성적으로 임계값을 정하지 않는다.
//      고원 점수·PBO·DSR·워크포워드는 전부 **이미 확정된 수익률 계열의 사후 채점**이며
//      신호·진입·청산·사이징으로 **되먹임되지 않는다**. 채점표이지 신호가 아니다.
//   집행자는 `tests/plateaulab.test.ts`의 **절단 불변성 + 미래 조작 불변성** 테스트다.
//
// ── 규칙 4(외부 API) — 야후 호출 규약 ────────────────────────────────────────
//   벤치(KODEX 200 `069500.KS`)와 참고 벽(QQQ·KRW=X)만 야후를 쓴다. 국내 유니버스 시세는
//   리포에 커밋된 **KRX 일별 정본**이다(`PRICE_SOURCE`, 기본 krx — 야후로 조용히 폴백하지
//   않는다. 어댑터가 던진다).
//     · 인증: 없음(공개 엔드포인트, 비공식). 승인 절차 없음.
//     · 한도: 공식 문서 없음 → **[미검증]**. 호출은 3건뿐이라 유량 문제가 나기 어렵다.
//     · 필드/단위: `indicators.quote[0].{open,high,low,close,volume}` + `adjclose`.
//       OHLC는 분할만 반영 → `adjclose ÷ close` 계수를 곱해 **총수익**으로 변환한다(규칙 3).
//     · 범위: `period1`로 지정. `range=max`가 월봉을 주는 조합이 있어 쓰지 않는다(기존 사고).
//     · 실패 표현: HTTP 오류 + **200 본문 안의 `chart.error`** + 빈 `result` — 셋 다 던진다.
//   **성공 카운터**를 두고 필수 호출(벤치)이 하나도 성공하지 못하면 **비정상 종료(exit 1)** 한다.
//   조용한 폴백·직전값 승계는 없다. 정상 0봉(휴장)과 실패 0봉(차단)을 구분해 사유를 찍는다.
//
// ── 규칙 3(데이터 정직성) ────────────────────────────────────────────────────
//   · KRX 정본은 **가격수익**(배당 미반영), 벤치·벽은 야후 **총수익**이다 →
//     **알파가 전략에 불리한 쪽으로 편향**된다. 모든 표와 한계 섹션에 병기한다.
//   · 확정하지 못한 것은 `[미검증]`으로 출력에 남긴다.
//   · 경계 셀(이웃이 격자 밖)은 이웃 수를 명시하고 `[표본부족]`으로 라벨한다 — 조용히
//     넘어가지 않는다.
//
// ── 파일 경계 (2026-08-03 총괄 배정) ─────────────────────────────────────────
//   랭킹·체결·비용 규약은 `scripts/idea-lab.entry.ts`(xsmom 계열)·`src/features/backtest/
//   xsmomChain.ts`의 정본을 **읽어서 같은 규약**으로 여기에 자립 구현했다. 병렬 워커가
//   그 파일들을 만지고 있어 import 결합을 만들지 않는다(중복이지만 파일 경계가 우선).
//   과최적화 채점(`overfit.ts`)·시세 어댑터(`priceSource.ts`)·유니버스
//   (`krxUniverseSource.ts`)는 지시대로 **기존 정본을 그대로 쓴다**(다시 구현하지 않는다).
//
// ── 실행 ─────────────────────────────────────────────────────────────────────
//   GHA `Backtest (GHA runner)` 워크플로 · mode 입력값:
//     plateau:plateau   전체 격자 (벤치 KODEX 200 · 야후 필요)
//     plateau:quick     축소 격자 스모크런 (벤치 KODEX 200 · 야후 필요)
//     plateau:offline   전체 격자 · **벤치 = 유니버스 동일가중**(네트워크 불필요)
//     plateau:selftest  합성 데이터 자기검증 (파일·네트워크 불필요)
//   환경변수: `PRICE_SOURCE`(기본 krx) · `KRX_WIDTH`(기본 10x10, 예 `40x40`) ·
//             `PLATEAU_PBO_MAX_COMBOS`(기본 자동)
//
//   ⚠️ `offline`의 알파는 **KODEX 200 알파가 아니다.** 벤치가 다르면 규칙 5의 판정 기준
//      자체가 달라진다 — 그 모드의 모든 표에 `[벤치=유니버스 동일가중]`을 박는다.

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
// 0. 상수 — 33~38차와 **같은 값**이어야 표가 나란히 읽힌다
// ============================================================================

export function log(msg: string): void {
  console.log(msg)
}

/** 비용 전제. 34차(krxcal)·36차(short:all)·38차(value:all)와 동일. 테스트가 대조한다. */
export const PLATEAU_COST: CostSettings = {
  initialCapital: 10_000_000,
  feePct: 0.015,
  taxPct: 0.15,
  slippagePct: 0.1,
}

/** 알파 판정 벤치(규칙 5). KODEX 200 — KRX 정본에 없어 **야후로만** 받는다. */
export const BENCH = '069500.KS'
/** 참고 벽 — 34차가 "어떤 조합도 넘지 못했다"고 판정한 기준선. 판정 벤치가 **아니다**. */
export const QQQ_SYMBOL = 'QQQ'
export const FX_SYMBOL = 'KRW=X'

/**
 * 벤치·벽 로드 시작일. 시장게이트 MA200이 유니버스 첫 해(2010-01)에 이미 판정되려면
 * 최소 1년 앞선 봉이 필요하다. 여유를 두고 2년 앞에서 받는다.
 */
export const BENCH_RANGE = 'since:2008-01-01'

/** 표본 소실 판정선 — idea-lab `SCREEN_MIN_TRADES`와 같은 값(자립 구현이라 값만 맞춘다). */
export const PLATEAU_MIN_TRADES = 20

/** 고원 판정 임계 — 이 값 이하의 낙폭이면 "이웃도 같이 좋다"로 본다(지시로 고정). */
export const PLATEAU_DROP_THRESHOLD = 0.3

/**
 * 누적 시도 수 = **DSR의 진짜 분모**. 38차까지 누적 97에 이번 셀 수를 더한다.
 * 같은 데이터·같은 유니버스를 여러 회차에 걸쳐 반복해 본 것이므로 선택편의가 누적된다.
 */
export const PLATEAU_TRIALS_PRIOR: readonly { round: string; n: number }[] = [
  { round: '33차 (krxpit 실측 재검증)', n: 10 },
  { round: '34차 (krxcal 격자)', n: 35 },
  { round: '35차 (krxscreen 랭킹 4계열)', n: 20 },
  { round: '36차 (short 단기기법)', n: 14 },
  { round: '38차 (value 밸류·퀄리티)', n: 18 },
]
export const PLATEAU_TRIALS_PRIOR_TOTAL = PLATEAU_TRIALS_PRIOR.reduce((s, r) => s + r.n, 0)

/** PBO 블록 수 S. overfit.ts 기본값과 같은 16(짝수·논문 권장 범위). */
export const PLATEAU_PBO_BLOCKS = 16
/** 워크포워드 창(거래일). IS 3년 · OOS 1년 — 17년 표본에서 12구간 남짓 나온다. */
export const PLATEAU_WF_IS_DAYS = 756
export const PLATEAU_WF_OOS_DAYS = 252
/** 일별 수익률의 연환산 계수(한국 주식 거래일 근사). */
export const PLATEAU_PERIODS_PER_YEAR = 252

/**
 * PBO 조합 상한 — **셀 수에 반비례**해 자동으로 좁힌다.
 *
 * PBO(CSCV) 비용은 `변형수 × 조합수 × 관측수`다. 38차는 변형 18개라 C(16,8)=12,870을
 * 전수 평가해도 쌌지만, 이번 회차는 변형이 수백 개라 전수로 두면 GHA 45분을 통째로 먹는다.
 * overfit.ts는 상한을 넘으면 **난수가 아니라 사전식 등간격 결정적 샘플링**으로 내려가므로
 * 재현성이 유지된다(그 사실을 결과 notes에 스스로 남긴다).
 */
export function pboMaxCombinations(variants: number, budget = 1_000_000): number {
  if (!(variants > 0)) return 1
  return Math.max(200, Math.min(20_000, Math.floor(budget / variants)))
}

// ============================================================================
// 1. 격자 정의 — 직교 5축
// ============================================================================

export const AXIS_KEYS = ['lookback', 'skip', 'slots', 'gateMa', 'rebalMonths'] as const
export type AxisKey = (typeof AXIS_KEYS)[number]

export interface AxisDef {
  key: AxisKey
  label: string
  /** 오름차순 고정 — 이웃(±1 스텝) 정의가 순서에 의존한다. */
  values: number[]
  unit: string
}

export type GridSpec = AxisDef[]

/**
 * 전체 격자 — **405셀**. 셀 수는 지시대로 1셀 실측에서 역산했다.
 *
 * ── 실측 (2026-08-03 · KRX 정본 79종목 · 2010~2026 17년 · 곡선 4,081점) ──────
 *   · 1셀 실행 **36~65ms** (게이트 없음 65ms / MA200 41ms · 20셀 표본 평균 36ms)
 *   · 격자 실행 405 × 36ms ≈ **15초**
 *   · PBO(CSCV)가 지배적 비용이다: 변형 20 × 조합 2,000 × 관측 4,080 = 4.9초 실측 →
 *     변형당·조합당 약 122µs → 405변형 × 조합 2,469(자동 상한) ≈ **120초**
 *   · 워크포워드·DSR·정렬은 합쳐 1초 미만
 *   → 총 **약 2~3분**. GHA 타임아웃 45분 대비 15배 이상 여유다.
 *
 * ── 왜 720이 아니라 405인가 ─────────────────────────────────────────────────
 *   시간만 보면 지시 축 원안(5×3×4×4×3 = 720셀)도 4분 안에 든다. 그럼에도 줄인 이유는
 *   **다중검정 분모**다 — 셀 하나가 곧 시도 하나이고, 누적 분모(97 + N)가 DSR을 직접
 *   깎는다. 지시가 준 상한("대략 200~400셀, 넘으면 축 해상도를 줄여라")을 지켜
 *   `slots`에서 10을, `gateMa`에서 100을 뺐다(각각 이웃 값과 가장 가까워 정보 손실이 작다).
 *   나머지 세 축(lookback·skip·rebalMonths)은 지시 값을 그대로 쓴다.
 *
 * ⚠️ 축을 늘리거나 해상도를 올리면 분모가 그만큼 커진다. 이 회차의 결론이 다른 회차와
 *    나란히 읽히려면 **분모를 출력에 그대로 싣는 것**이 전제다(`multipleTestingReport`).
 */
export const FULL_GRID: GridSpec = [
  { key: 'lookback', label: '모멘텀 관측', values: [3, 6, 9, 12, 15], unit: '개월' },
  { key: 'skip', label: '최근 제외', values: [0, 1, 2], unit: '개월' },
  { key: 'slots', label: '보유 종목수', values: [3, 5, 8], unit: '종목' },
  { key: 'gateMa', label: '시장게이트 MA', values: [0, 150, 200], unit: '일' },
  { key: 'rebalMonths', label: '리밸런스 주기', values: [1, 3, 6], unit: '개월' },
]

/** 전체 격자 셀 수 — 테스트가 이 값이 예산 안에 있는지 대조한다. */
export const FULL_GRID_CELLS = 405

/** 축소 격자(스모크런) — 배선·출력 형식만 확인한다. 이 결과로 판정하지 않는다. */
export const QUICK_GRID: GridSpec = [
  { key: 'lookback', label: '모멘텀 관측', values: [6, 12], unit: '개월' },
  { key: 'skip', label: '최근 제외', values: [1], unit: '개월' },
  { key: 'slots', label: '보유 종목수', values: [3, 5, 8], unit: '종목' },
  { key: 'gateMa', label: '시장게이트 MA', values: [0, 200], unit: '일' },
  { key: 'rebalMonths', label: '리밸런스 주기', values: [1], unit: '개월' },
]

export interface PlateauParams {
  /** 모멘텀 관측 개월 — 반드시 `skip`보다 커야 한다. */
  lookback: number
  /** 최근 제외 개월(단기 반전 회피). 0이면 직전 달까지 전부 본다. */
  skip: number
  /** 보유 종목수 N */
  slots: number
  /** 시장게이트 이동평균일. **0이면 게이트 없음**. */
  gateMa: number
  /** 리밸런스 주기(개월). 1이면 매월, 3이면 1·4·7·10월. */
  rebalMonths: number
}

export interface GridCell {
  index: number
  /** 축별 값 인덱스(격자 좌표) */
  coords: number[]
  params: PlateauParams
  key: string
}

export const cellKey = (p: PlateauParams): string =>
  `L${p.lookback}-S${p.skip}-N${p.slots}-G${p.gateMa}-R${p.rebalMonths}`

/** 격자 검증 — 축이 오름차순인지, 값이 중복되지 않는지, 조합이 유효한지. */
export function validateGrid(grid: GridSpec): void {
  const seen = new Set<AxisKey>()
  for (const ax of grid) {
    if (seen.has(ax.key)) throw new Error(`축 ${ax.key}가 중복이다`)
    seen.add(ax.key)
    if (ax.values.length === 0) throw new Error(`축 ${ax.key}에 값이 없다`)
    for (let i = 1; i < ax.values.length; i++)
      if (!(ax.values[i] > ax.values[i - 1]))
        throw new Error(`축 ${ax.key}가 오름차순이 아니다 (${ax.values.join(',')}) — 이웃 정의가 깨진다`)
  }
  for (const k of AXIS_KEYS) if (!seen.has(k)) throw new Error(`축 ${k}가 빠졌다`)
}

/**
 * 격자를 전개한다. **사전식(마지막 축이 가장 빨리 도는) 순서 고정** — 순서가 바뀌면
 * 이웃 인덱스 산술과 출력 표가 통째로 어긋난다.
 *
 * `lookback <= skip`인 조합은 창 길이가 0 이하라 **격자에서 제외**한다(현재 축 값으로는
 * 발생하지 않지만, 축을 바꿨을 때 조용히 이상한 셀이 생기는 것을 막는다). 제외가 생기면
 * 이웃 관계가 끊기므로 그 사실을 던져서 알린다 — 조용히 건너뛰지 않는다.
 */
export function enumerateGrid(grid: GridSpec): GridCell[] {
  validateGrid(grid)
  const sizes = grid.map((a) => a.values.length)
  const total = sizes.reduce((s, n) => s * n, 1)
  const cells: GridCell[] = []
  for (let i = 0; i < total; i++) {
    const coords: number[] = new Array(sizes.length)
    let rest = i
    for (let a = sizes.length - 1; a >= 0; a--) {
      coords[a] = rest % sizes[a]
      rest = Math.floor(rest / sizes[a])
    }
    const pick = (k: AxisKey) => {
      const a = grid.findIndex((x) => x.key === k)
      return grid[a].values[coords[a]]
    }
    const params: PlateauParams = {
      lookback: pick('lookback'),
      skip: pick('skip'),
      slots: pick('slots'),
      gateMa: pick('gateMa'),
      rebalMonths: pick('rebalMonths'),
    }
    if (!(params.lookback > params.skip))
      throw new Error(
        `격자에 lookback(${params.lookback}) <= skip(${params.skip}) 조합이 있다 — 관측 창이 비어 랭킹이 성립하지 않는다. 축 값을 고쳐라.`,
      )
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
  /** 이웃 셀의 평탄 인덱스 */
  index: number
  axis: AxisKey
  dir: -1 | 1
}

/**
 * 이웃 = **각 축에서 ±1 스텝, 대각선 제외**.
 *
 * 격자 밖 방향은 두 가지로 나눠 돌려준다 — 뭉치면 원인을 못 읽기 때문이다:
 *   · `missing` — 값이 2개 이상인 축인데 **셀이 그 축의 끝**이라 한쪽을 못 본다.
 *     이것이 진짜 "경계 셀"이고 `[표본부족]` 라벨의 근거다.
 *   · `frozen`  — 축 자체가 **값 1개로 고정**돼 있어 흔들 것이 없다(축소 격자에서만 나온다).
 *     경계 때문이 아니라 실험 설계상 그 축을 안 흔든 것이므로 라벨을 따로 붙인다.
 */
export function neighborsOf(
  cell: GridCell,
  grid: GridSpec,
): { found: NeighborRef[]; missing: string[]; frozen: AxisKey[] } {
  const sizes = grid.map((a) => a.values.length)
  const found: NeighborRef[] = []
  const missing: string[] = []
  const frozen: AxisKey[] = []
  for (let a = 0; a < grid.length; a++) {
    if (sizes[a] < 2) {
      frozen.push(grid[a].key)
      continue
    }
    for (const dir of [-1, 1] as const) {
      const c = cell.coords.slice()
      c[a] += dir
      const idx = flatIndex(c, sizes)
      if (idx < 0) {
        missing.push(`${grid[a].key}${dir > 0 ? '+' : '−'}`)
        continue
      }
      found.push({ index: idx, axis: grid[a].key, dir })
    }
  }
  return { found, missing, frozen }
}

// ============================================================================
// 2. 성과 지표 — idea-lab `perfOf`/`calmarOf`/`alphaOf`와 **같은 정의**(자립 구현)
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

export type Curve = { date: string; equity: number }[]

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

/**
 * 칼마 = **CAGR ÷ |MDD|**. 31차 대표 채택 기준이며 이 회차의 고원 성적 지표다.
 * MDD가 사실상 0이면 비율이 발산하므로 null(고원 판정에서 빠진다 — 0으로 채우지 않는다).
 */
export function calmarOf(p: Perf): number | null {
  const mddAbs = Math.abs(p.mdd)
  return mddAbs > 0.01 ? p.cagr / mddAbs : null
}

/**
 * 알파는 **두 곡선이 겹치는 구간**에서만 계산한다. 벤치가 없는 구간을 전략에만 유리하게
 * 넣으면 알파가 부풀려진다(규칙 5).
 */
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

/**
 * 전·후반 경계 연도. 하드코딩하지 않는다 — 구간이 늘거나 앞이 붙으면 자동으로 이동해야
 * "전반/후반"이라는 말의 뜻이 유지된다. 2010~2026 → 2018(34·36·38차 표와 같은 값).
 */
export function halfYearOf(years: readonly number[]): number {
  if (years.length < 2) throw new Error(`전·후반을 나누려면 2년 이상이 필요하다 (${years.length}년)`)
  const first = years[0]
  const last = years[years.length - 1]
  if (!(last > first)) throw new Error(`구간이 오름차순이 아니다 (${first}~${last})`)
  return Math.ceil((first + last) / 2)
}

// ============================================================================
// 3. 모멘텀 산술 — xsmomChain.ts 정본과 **같은 규약**(창 길이만 파라미터화)
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
 * 일반화 모멘텀 `(lookback − skip)`.
 *   시작 = `lookback`개월 전 달 1일 **직전** 종가 · 끝 = `skip`개월 전 달 1일 **직전** 종가.
 * 두 기준일이 모두 `date`보다 과거라 미래참조가 원천적으로 불가능하다.
 * `skip=0`이면 끝 기준이 "이번 달 1일 직전 종가" = **전월 마지막 종가**다 —
 * 리밸런스일 당일 값이 아니므로 규칙 1-2를 지킨다.
 * 관측 구간 시작 종가가 없으면(이력 부족) null = 후보 제외.
 */
export function momentumOf(bars: DailyBar[], date: string, lookback: number, skip: number): number | null {
  if (!(lookback > skip)) throw new Error(`lookback(${lookback})은 skip(${skip})보다 커야 한다`)
  const pe = lastCloseBefore(bars, shiftMonthStart(date, -skip))
  const ps = lastCloseBefore(bars, shiftMonthStart(date, -lookback))
  if (pe == null || ps == null || !(ps > 0)) return null
  return pe / ps - 1
}

export interface MomRow {
  sym: string
  mom: number
}

/** 모멘텀 내림차순, 동점은 심볼 오름차순(결정적 — 난수 없음). */
export function rankUniverse(
  histories: Record<string, DailyBar[]>,
  universe: string[],
  date: string,
  lookback: number,
  skip: number,
): MomRow[] {
  const rows: MomRow[] = []
  for (const s of universe) {
    const bars = histories[s]
    if (!bars?.length) continue
    const m = momentumOf(bars, date, lookback, skip)
    if (m == null) continue
    rows.push({ sym: s, mom: m })
  }
  rows.sort((x, y) => (y.mom !== x.mom ? y.mom - x.mom : x.sym < y.sym ? -1 : x.sym > y.sym ? 1 : 0))
  return rows
}

/**
 * 리밸런스 달인가 — `(월−1) % rebalMonths === 0`.
 * 달력만으로 결정되므로 **데이터 길이·시작일에 의존하지 않는다**(절단 불변성의 전제).
 * rebalMonths=3이면 1·4·7·10월, 6이면 1·7월. 연쇄가 연 단위로 끊기므로 1월은 항상 포함된다.
 */
export const isRebalanceMonth = (month: number, rebalMonths: number): boolean =>
  (month - 1) % rebalMonths === 0

// ============================================================================
// 4. 시장게이트 — 벤치 이동평균 (0 = 게이트 없음)
// ============================================================================

/**
 * 벤치 곡선의 `maDays` 이동평균 게이트. 판정일 **직전** N개 종가만 쓴다(당일 제외 — 규칙 1-3).
 *   · 직전 종가 ≥ MA → 노출 1
 *   · 직전 종가 <  MA → 노출 0 (그 리밸런스일 시가에 전량 청산 → 비용을 그대로 문다)
 *   · 봉이 N개 미만이라 **판정 불가면 1**(열림) — 사후지식 없이 기본값을 쓰는 원칙이며,
 *     초기 구간을 임의로 현금화해 성적을 만들지 않기 위해서다(`marketGate.ts`와 같은 규약).
 *
 * `maDays <= 0`이면 게이트를 걸지 않고 항상 1을 준다(축 값 0의 의미).
 */
export function makeMaGateExposure(bench: Curve, maDays: number): (date: string) => number {
  if (!(maDays > 0)) return () => 1
  const dates = bench.map((p) => p.date)
  const vals = bench.map((p) => p.equity)
  // 누적합 — 이동평균을 O(1)로 낸다(격자 수백 셀 × 수백 리밸런스라 상수 시간이 필요하다).
  const cum: number[] = new Array(vals.length + 1).fill(0)
  for (let i = 0; i < vals.length; i++) cum[i + 1] = cum[i] + vals[i]
  const memo = new Map<string, number>()
  return (date: string) => {
    const hit = memo.get(date)
    if (hit != null) return hit
    // date **미만** 마지막 인덱스 + 1 = 확정 구간의 오른쪽 경계
    let lo = 0
    let hi = dates.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (dates[mid] < date) lo = mid + 1
      else hi = mid
    }
    let w = 1
    if (lo >= maDays) {
      const ma = (cum[lo] - cum[lo - maDays]) / maDays
      const last = vals[lo - 1]
      w = last >= ma ? 1 : 0
    }
    memo.set(date, w)
    return w
  }
}

// ============================================================================
// 5. 장부 — xsmomChain.ts `bookBuy/bookSell/bookMark`와 동일 산술(자립 구현)
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
// 6. 한 해치 시뮬 — 리밸런스일 **시가** 체결
// ============================================================================

/**
 * 연도 컨텍스트. **파라미터에 의존하지 않으므로 셀 루프 밖에서 한 번만 만든다**
 * (격자 수백 셀 × 17년마다 봉 배열을 다시 자르면 그것만으로 분 단위가 나간다).
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
  /** 유니버스 코드 수(매핑률 표기용) */
  totalCodes: number
}

/**
 * 연도별 유니버스·시계열 준비. 그 해 **6월 30일 이전에 상장돼 있던 종목만** 편입한다
 * (pitChain·xsmomChain과 같은 규약 — "그때 이미 상장돼 있었나"만 보고 이후 가격은 보지 않는다).
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
  /** 리밸런스 횟수(게이트로 전액 현금이 된 달 포함) */
  rebalances: number
  /** 게이트가 닫혀 전액 현금이던 리밸런스 수 */
  gatedRebalances: number
}

/**
 * 한 해치 시뮬. 리밸런스 달의 **첫 거래일 시가**에 교체한다.
 *
 * 슬롯 분모는 절대모멘텀 게이트와 무관하게 `min(N, 후보수)`로 고정한다 — 분모를 같이
 * 줄이면 게이트가 남은 종목에 레버리지를 거는 셈이라 A/B 비교가 오염된다(정본 규약).
 *
 * ⚠️ 고정 전제(격자 축이 **아니다**): 절대모멘텀 게이트는 **항상 켠다**(모멘텀 < 0인
 *    종목의 슬롯은 현금). 25차·34차 승자의 정의가 그것이라 이 격자는 그 주변을 흔드는
 *    셈이 된다. 축으로 올리면 셀 수가 2배가 되고 다중검정 분모도 2배가 된다.
 */
export function simulateYear(
  ctx: YearCtx,
  cost: CostSettings,
  params: PlateauParams,
  exposure?: (date: string) => number,
): YearRun {
  const book = newBook(cost.initialCapital)
  const equity: Curve = []
  const { calendar, symbols, hist, idxOf } = ctx
  let curYm = ''
  let rebalances = 0
  let gatedRebalances = 0
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
        // 후보: 랭킹 산출 가능 + 오늘 실제로 거래되는 종목만(체결 불가 종목을 담지 않는다)
        const ranked = rankUniverse(hist, symbols, date, params.lookback, params.skip).filter(
          (r) => (openPx.get(r.sym) ?? 0) > 0,
        )
        const denom = Math.max(1, Math.min(params.slots, ranked.length))
        const picked = ranked.slice(0, denom)
        // 절대모멘텀 게이트(고정 전제) — 모멘텀 < 0이면 그 슬롯은 현금
        const targets = picked.filter((r) => r.mom >= 0)
        const w = exposure ? Math.min(1, Math.max(0, exposure(date))) : 1
        if (w <= 0) gatedRebalances++
        const targetSet = new Set(w > 0 ? targets.map((r) => r.sym) : [])
        const slot = (eq * w) / denom

        // 1) 목표 밖 전량 매도 (봉이 없으면 못 판다 — 다음 기회로 이월)
        for (const s of [...book.positions.keys()]) {
          if (targetSet.has(s)) continue
          const px = openPx.get(s)
          if (px == null || !(px > 0)) continue
          bookSell(book, cost, s, px, book.positions.get(s)!.qty)
        }
        if (w > 0) {
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
    }
    const closeAt = (s: string) => {
      const bi = idxOf[s]?.get(date)
      return bi != null ? hist[s][bi].c : null
    }
    equity.push({ date, equity: bookMark(book, closeAt) })
  }

  return {
    equity,
    closed: book.closed,
    wins: book.wins,
    openAtEnd: book.positions.size,
    rebalances,
    gatedRebalances,
  }
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
  gatedRebalances: number
}

/**
 * 그 해 매핑 종목이 이 수 미만이면 표본이 작아 성적이 몇 종목 운에 좌우된다 →
 * **현금 보유**로 처리하고 자산곡선을 평평하게 이어붙인다(구간을 건너뛰면 연수가 줄어
 * CAGR이 부풀려진다). xsmomChain의 기본값과 같은 5.
 */
export const MIN_SYMBOLS = 5

/**
 * 구간 끝 청산비용 근사 [추정] — 정확한 청산가가 아니다. **켠다**: 연구 러너(idea-lab
 * `runCustomChain`)가 해마다 물리는 비용이고, 끄면 이 러너만 비용을 면제받아 성적이
 * 낙관적으로 나온다. 방향이 보수적(성적을 낮춤)이다.
 */
export const APPLY_LIQUIDATION_HAIRCUT = true

export function runPlateauChain(
  ctxs: readonly YearCtx[],
  cost: CostSettings,
  params: PlateauParams,
  exposure?: (date: string) => number,
): ChainStats {
  const equity: Curve = []
  const perYear: ChainStats['perYear'] = []
  let factor = 1
  let closed = 0
  let wins = 0
  let rebalances = 0
  let gatedRebalances = 0

  for (const ctx of ctxs) {
    if (ctx.symbols.length === 0) continue
    if (ctx.symbols.length < MIN_SYMBOLS) {
      for (const d of ctx.calendar) equity.push({ date: d, equity: factor * cost.initialCapital })
      perYear.push({ y: ctx.y, ret: 0, mapped: ctx.symbols.length, total: ctx.totalCodes, cash: true })
      continue
    }
    const run = simulateYear(ctx, cost, params, exposure)
    const base = factor
    for (const p of run.equity)
      equity.push({ date: p.date, equity: base * (p.equity / cost.initialCapital) * cost.initialCapital })
    const finalEq = run.equity.length ? run.equity[run.equity.length - 1].equity : cost.initialCapital
    const segRet = finalEq / cost.initialCapital
    const frac = APPLY_LIQUIDATION_HAIRCUT
      ? Math.min(1, Math.max(0, run.openAtEnd / Math.max(1, params.slots)))
      : 0
    const yearRatio = segRet * (1 - frac * ((cost.feePct + cost.taxPct + cost.slippagePct) / 100))
    factor = base * yearRatio
    closed += run.closed
    wins += run.wins
    rebalances += run.rebalances
    gatedRebalances += run.gatedRebalances
    perYear.push({
      y: ctx.y,
      ret: (yearRatio - 1) * 100,
      mapped: ctx.symbols.length,
      total: ctx.totalCodes,
      cash: false,
    })
  }
  return { equity, closed, wins, perYear, rebalances, gatedRebalances }
}

// ============================================================================
// 8. 셀 결과 · 승격 관문
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
  rebalances: number
  gatedRebalances: number
  /** 일간 수익률 계열(PBO·워크포워드·DSR 입력). 날짜는 `dates`와 정렬돼 있다. */
  dailyReturns: number[]
}

/** 관문 ①②(셀 단독으로 판정 가능한 것) — 빈 배열이면 통과. */
export function localFailReasons(r: CellResult, minTrades = PLATEAU_MIN_TRADES): string[] {
  const bad: string[] = []
  if (!((r.alphaA ?? -1) > 0 && (r.alphaB ?? -1) > 0)) bad.push('알파(전·후반)')
  if (!(r.trades >= minTrades)) bad.push(`매매<${minTrades}`)
  return bad
}
export const localPass = (r: CellResult, minTrades = PLATEAU_MIN_TRADES): boolean =>
  localFailReasons(r, minTrades).length === 0

// ---------------------------------------------------------------- 고원 채점

export interface PlateauScore {
  index: number
  /** 셀 자신의 성적(칼마). 계산 불가면 null. */
  self: number | null
  /** 격자 안에 있는 이웃 수 */
  neighbors: number
  /** 격자 **끝**이라 볼 수 없는 이웃 방향(예: `skip−`) — `[표본부족]`의 근거 */
  missing: string[]
  /** 값이 1개뿐이라 애초에 흔들지 않은 축(축소 격자에서만 나온다) */
  frozen: AxisKey[]
  /** 이웃 성적 중 최솟값. 이웃 중 하나라도 null이면 null(사유를 남긴다). */
  minNeighbor: number | null
  /** **셀과 이웃 성적의 최솟값** — 평균이 아니다. */
  plateauScore: number | null
  /** (셀 − 이웃최솟값) ÷ |셀|. 셀 성적이 0 이하면 정의하지 않는다(null). */
  plateauDrop: number | null
  /** 이웃 전부가 관문 ①을 통과했는가. 이웃이 없으면 null. */
  neighborsPassLocal: boolean | null
  /** 이웃이 부족한 셀 — 출력에 `[표본부족]`으로 라벨한다. */
  sampleShort: boolean
  /** null이 된 사유(규칙 3 — 조용히 빈칸으로 두지 않는다) */
  reason: string | null
}

/**
 * 고원 채점. `scoreOf[i]`는 셀 i의 성적(칼마), `passOf[i]`는 셀 i의 관문 ① 통과 여부다.
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
    else if (nb.length === 0) reason = '이웃이 하나도 없다(모든 축이 1단계) — 고원 판정 불가'
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
  /** 통과한 관문 번호 */
  passed: number[]
  /** 실패한 관문의 사유 */
  failed: string[]
  promoted: boolean
}

/**
 * 승격 관문 (전부 통과해야 승격 — **가장 덜 나쁜 칸 승격 금지**):
 *   ① 전·후반 양쪽 알파 양수  ② 매매수 ≥ 20  ③ PBO < 0.5
 *   ④ 워크포워드 OOS 알파 양수  ⑤ 고원: plateauDrop ≤ 0.30 이면서 이웃 전부가 관문 ① 통과
 *
 * ③④는 **격자 전체에 하나씩 나오는 값**이라 셀마다 같다 — 셀 단위 판정에 그대로 얹는다
 * (그 회차의 탐색 절차 자체가 아웃샘플에서 성립하는지를 묻는 관문이기 때문이다).
 */
export function promotionVerdict(
  r: CellResult,
  ps: PlateauScore,
  round: { pbo: number | null; wfOosAlpha: number | null },
  minTrades = PLATEAU_MIN_TRADES,
  dropThreshold = PLATEAU_DROP_THRESHOLD,
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
  if (ps.plateauDrop != null && ps.plateauDrop <= dropThreshold && ps.neighborsPassLocal === true)
    passed.push(5)
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
// 9. 수익률 행렬 — PBO·워크포워드·DSR 입력
// ============================================================================

/** 자산곡선 → 일간 수익률(첫 점은 기준이라 빠진다). 날짜는 두 번째 점부터다. */
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
 * 한 변형에만 있는 날을 그대로 두면 시점이 통째로 밀린다. 공통 날짜만 남기고 버린 수를
 * 돌려준다(조용히 버리지 않는다).
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
// 10. 출력 — 격자 단면(2D 히트맵) · 표
// ============================================================================

export const f1 = (v: number | null | undefined): string =>
  v == null || !Number.isFinite(v) ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(1)}`
export const num = (v: number | null | undefined, d = 3): string =>
  v == null || !Number.isFinite(v) ? '—' : v.toFixed(d)
const pp = (v: number | null | undefined): string => (v == null ? '—' : `${f1(v)}%p`)

/**
 * 격자 단면 히트맵 — `xKey`×`yKey` 2D 표를 나머지 축을 `fixed`에 고정해 찍는다.
 * **대표가 "고원이 눈에 보이는지"를 표로 확인할 수 있어야 한다**는 것이 이 함수의 존재 이유다.
 */
export function heatmapTable(
  title: string,
  cells: readonly GridCell[],
  grid: GridSpec,
  valueOf: (index: number) => number | null,
  xKey: AxisKey,
  yKey: AxisKey,
  fixed: Partial<Record<AxisKey, number>>,
  digits = 3,
): void {
  const xAx = grid.find((a) => a.key === xKey)
  const yAx = grid.find((a) => a.key === yKey)
  if (!xAx || !yAx) throw new Error(`히트맵 축(${xKey}·${yKey})이 격자에 없다`)
  const fixedLabel = grid
    .filter((a) => a.key !== xKey && a.key !== yKey)
    .map((a) => `${a.label} ${fixed[a.key] ?? a.values[0]}${a.unit}`)
    .join(' · ')
  const at = (xv: number, yv: number): number | null => {
    const hit = cells.find((c) => {
      const p = c.params as unknown as Record<AxisKey, number>
      if (p[xKey] !== xv || p[yKey] !== yv) return false
      return grid.every((a) => a.key === xKey || a.key === yKey || p[a.key] === (fixed[a.key] ?? a.values[0]))
    })
    return hit ? valueOf(hit.index) : null
  }
  log('')
  log(`### ${title}`)
  log(`고정: ${fixedLabel}`)
  log('')
  log(`| ${yAx.label}\\${xAx.label} | ${xAx.values.map((v) => `${v}${xAx.unit}`).join(' | ')} |`)
  log(`|---|${xAx.values.map(() => '---').join('|')}|`)
  for (const yv of yAx.values) {
    const row = xAx.values.map((xv) => num(at(xv, yv), digits))
    log(`| **${yv}${yAx.unit}** | ${row.join(' | ')} |`)
  }
}

// ============================================================================
// 11. 데이터 로딩
// ============================================================================

const ROOT = process.env.REPO_ROOT ?? process.cwd()

/** 야후 호출 성공/실패 카운터 — 규칙 4. 전량 실패는 **비정상 종료**의 근거가 된다. */
export interface YahooTally {
  attempted: number
  ok: number
  failed: { symbol: string; reason: string }[]
}
export const newYahooTally = (): YahooTally => ({ attempted: 0, ok: 0, failed: [] })

/**
 * 야후 일봉. `preset-precompute`·`value-lab`과 **같은 규약**(총수익 보정 · KST 날짜).
 * **어떤 실패도 삼키지 않는다** — HTTP 오류·`chart.error`(200 본문)·빈 result 전부 던진다.
 */
export async function fetchDaily(symbol: string, range = BENCH_RANGE): Promise<DailyBar[]> {
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
    // 총수익 보정(규칙 3): adjclose ÷ close 계수를 OHLC에 적용
    const fac =
      adj[i] != null && Number.isFinite(adj[i] as number) && (cl as number) > 0
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
): Promise<DailyBar[] | null> {
  tally.attempted++
  try {
    const bars = await fetchDaily(symbol, range)
    // 정상 0봉(휴장·구간 밖)과 실패 0봉(차단·잘못된 심볼)을 구분한다 — 둘 다 "0건"이지만
    // 취급이 반대다. 여기서는 2봉 미만을 실패로 본다(일봉 17년 요청에 0~1봉은 정상이 아니다).
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

/** `KRX_WIDTH=40x40` / `10+10` / `30` 형태를 파싱한다. 모르는 값이면 기본(10+10)으로 좁힌다. */
export function parseWidthEnv(v: string | undefined): KrxWidth {
  const s = (v ?? '').trim().toLowerCase()
  if (s === '') return normalizeWidth(undefined)
  const m = /^(\d+)\s*[x+]\s*(\d+)$/.exec(s)
  if (m) return normalizeWidth({ kospi: Number(m[1]) as KrxTopN, kosdaq: Number(m[2]) as KrxTopN })
  if (/^\d+$/.test(s)) return normalizeWidth(Number(s))
  return normalizeWidth(undefined)
}

/**
 * 유니버스 **동일가중 지수**(오프라인 벤치). 매일 그날 봉이 있는 종목의 일별 수익률을
 * 단순평균해 잇는다.
 *
 * ⚠️ 이것은 KODEX 200이 **아니다.** 34·36·38차 알파와 나란히 읽으면 안 된다.
 */
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
    let n = 0
    for (const m of closeOf) {
      const a = m.get(prev)
      const b = m.get(d)
      if (a != null && b != null && a > 0) {
        sum += b / a - 1
        n++
      }
    }
    if (n > 0) eq *= 1 + sum / n
    out.push({ date: d, equity: eq })
    prev = d
  }
  return out
}

/** 달러 곡선 × 원/달러(결측일 직전 환율 이월 — 다음 환율을 당겨오면 미래참조다). */
export function toKrwCurve(usd: DailyBar[], fx: DailyBar[]): Curve {
  const fxMap = new Map<string, number>()
  for (const b of fx) if (b.c > 0) fxMap.set(b.date, b.c)
  const out: Curve = []
  let last: number | null = null
  for (const b of usd) {
    // 명시 annotation — `last`가 아래에서 `r`로 갱신돼 추론이 순환한다(TS7022).
    const r: number | null = fxMap.get(b.date) ?? last
    if (r == null || !(r > 0)) continue
    last = r
    if (b.c > 0) out.push({ date: b.date, equity: b.c * r })
  }
  return out
}

export interface WallStats {
  label: string
  calmar: number | null
  cagrPct: number
  mddPct: number
  from: string
  to: string
}

/** 같은 구간 단순보유의 칼마·CAGR·MDD. **옮겨 적지 않고 다시 잰다**(34차 규약). */
export function wallOf(label: string, curve: Curve, from: string, to: string): WallStats | null {
  const seg = curve.filter((p) => p.date >= from && p.date <= to && p.equity > 0)
  if (seg.length < 2) return null
  const p = perfOf(seg)
  return { label, calmar: calmarOf(p), cagrPct: p.cagr, mddPct: p.mdd, from: seg[0].date, to: seg[seg.length - 1].date }
}

// ============================================================================
// 12. 실행 — 격자 한 판
// ============================================================================

export interface RunInputs {
  grid: GridSpec
  ctxs: YearCtx[]
  years: number[]
  cost: CostSettings
  /** 게이트 판정에 쓰는 레짐 곡선(= 벤치 곡선). 없으면 gateMa 축이 전부 게이트 없음이 된다. */
  regime: Curve | null
  /** 알파 판정 벤치(규칙 5) */
  benchCurve: Curve
  benchLabel: string
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
  /** 격자 실행(셀 백테스트)에만 든 시간 */
  gridMs: number
  /** 사후 채점(PBO·워크포워드·정렬)에 든 시간 — PBO가 지배적이다 */
  scoringMs: number
}

/** 격자 전체 실행 + 사후 채점. **여기서 임계값을 데이터로 정하지 않는다**(전부 사전 고정 상수). */
export function runGrid(inp: RunInputs, onCell?: (done: number, total: number, ms: number) => void): RunOutputs {
  const cells = enumerateGrid(inp.grid)
  const half = halfYearOf(inp.years)
  const t0 = Date.now()

  // 게이트 노출 함수는 MA일수마다 하나씩만 만든다(셀마다 만들면 누적합을 수백 번 다시 만든다).
  const gateCache = new Map<number, ((date: string) => number) | undefined>()
  const gateFor = (maDays: number): ((date: string) => number) | undefined => {
    if (gateCache.has(maDays)) return gateCache.get(maDays)
    const fn =
      maDays > 0 && inp.regime && inp.regime.length >= 2 ? makeMaGateExposure(inp.regime, maDays) : undefined
    gateCache.set(maDays, fn)
    return fn
  }

  const results: CellResult[] = []
  const series: { dates: string[]; returns: number[] }[] = []
  for (const cell of cells) {
    const cellT0 = Date.now()
    const chain = runPlateauChain(inp.ctxs, inp.cost, cell.params, gateFor(cell.params.gateMa))
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
      rebalances: chain.rebalances,
      gatedRebalances: chain.gatedRebalances,
      dailyReturns: dr.returns,
    })
    onCell?.(results.length, cells.length, Date.now() - cellT0)
  }

  const gridMs = Date.now() - t0
  const t1 = Date.now()
  const benchDaily = dailyReturnsOf(inp.benchCurve)
  const aligned = alignDailyMatrix(series, benchDaily)

  const maxCombos = Number(process.env.PLATEAU_PBO_MAX_COMBOS ?? '') || pboMaxCombinations(cells.length)
  const pbo = computePbo(aligned.matrix, {
    blocks: PLATEAU_PBO_BLOCKS,
    maxCombinations: maxCombos,
    metric: sharpeMetric,
  })
  const wf = walkForwardScore(aligned.matrix, {
    isWindow: PLATEAU_WF_IS_DAYS,
    oosWindow: PLATEAU_WF_OOS_DAYS,
    metric: sharpeMetric,
    periodsPerYear: PLATEAU_PERIODS_PER_YEAR,
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
// 13. 보고서
// ============================================================================

const DISCLAIMER = [
  '',
  '---',
  '',
  '⚠️ **이 산출물은 과거 데이터 시뮬레이션이며 투자자문이 아니다.** 확정적 매수·매도 권유가 아니라',
  '조건과 확률의 관찰 기록이다. 여기 적힌 어떤 수치도 미래 수익을 보장하지 않는다.',
  '손실 경로를 같은 무게로 읽어라 — 표의 MDD는 **그 구간에서 실제로 겪었을 최대 낙폭**이고,',
  '전략이 무효화되는 지점(고원이 무너지는 이웃 셀)도 같은 표에 있다.',
]

export function limitsSection(opts: {
  benchLabel: string
  offlineBench: boolean
  priceMeta?: Pick<PriceSourceMeta, 'note' | 'limits'>
  universeNote: string
  cellCount: number
  pboMaxCombos: number
  /** PBO가 조합을 전수 평가했는가 — 샘플링 문구가 달라진다. */
  pboExhaustive: boolean
  /** 합성 데이터 실행(자기검증) — 아래 데이터 출처 항목은 실데이터 경로 설명이다. */
  synthetic?: boolean
}): void {
  log('')
  log('## 한계 · 편향 (규칙 3 — 숨기지 않는다)')
  log('')
  if (opts.synthetic)
    log(
      '⚠️ **이 실행은 합성 데이터다.** 아래 2·3번(생존편향·수집 시작 연도)은 **실데이터 경로**의 한계 설명이며 ' +
        '이 실행에는 해당하지 않는다. 형식이 깨지지 않는지 확인하려고 같은 섹션을 그대로 태운다.',
    )
  const items: string[] = []
  items.push(
    opts.offlineBench
      ? '**배당 비대칭 — 이 모드에서는 양쪽이 같은 기준이다.** 전략도 벤치도 같은 시계열에서 나오므로 ' +
          `배당 반영 여부가 갈리지 않는다${opts.synthetic ? '(합성 데이터라 배당 개념 자체가 없다)' : '(둘 다 KRX 정본 가격수익)'}. ` +
          '대신 벤치 자체가 KODEX 200이 아니라는 더 큰 한계가 붙는다(아래 항목 참조).'
      : '**배당 비대칭 — 알파가 전략에 불리한 쪽으로 편향된다.** 국내 유니버스 시세는 KRX 일별 정본으로 ' +
          '**가격수익**(배당 미반영)이고, 벤치(KODEX 200)와 참고 벽(QQQ)은 야후 **총수익**(배당 재투자)이다. ' +
          '전략 쪽에만 배당이 빠져 있으므로 **여기서 나온 알파는 실제보다 낮게** 잡힌다. 즉 알파가 음수라고 ' +
          '해서 곧바로 "전략이 나쁘다"로 읽으면 안 되고, 반대로 알파가 양수면 그 편향을 이겨낸 것이라 ' +
          '조금 더 강한 근거가 된다.',
  )
  items.push(
    '**가격 생존편향.** 랭킹은 KRX 실측이라 목록 선택편향은 없지만, 상장폐지 종목의 **가격**이 없으면 ' +
      '유니버스에서 빠진다 — 그 방향은 성적을 후하게 만든다(규칙 1-7).',
  )
  items.push(
    '**2010년 이전은 수집 자체가 불가능**하다(KRX Open API 시작). 2008 금융위기 전반부가 빠져 있어 ' +
      '2000년부터 돌던 옛 회차 수치와 직접 비교하면 거짓이다.',
  )
  items.push(
    `**다중검정.** 이번 회차 ${opts.cellCount}셀은 같은 데이터·같은 유니버스를 또 한 번 본 것이다. ` +
      `누적 분모는 ${PLATEAU_TRIALS_PRIOR_TOTAL} + ${opts.cellCount} = ${PLATEAU_TRIALS_PRIOR_TOTAL + opts.cellCount}이며 ` +
      'DSR은 그 분모로 찍는다. 변형을 늘릴수록 "찾은 것이 우연일 확률"이 올라간다.',
  )
  items.push(
    (opts.pboExhaustive
      ? `**PBO 조합.** C(16,8)=12,870 조합을 **전수 평가**했다(${opts.pboMaxCombos}개). `
      : `**PBO 조합 샘플링.** 변형이 ${opts.cellCount}개라 C(16,8)=12,870 전수 평가는 예산을 넘는다 — ` +
        `${opts.pboMaxCombos}개만 **사전식 등간격 결정적 샘플링**으로 평가했다(난수 아님·재현 가능). `) +
      '단일 실행의 PBO는 크게 흔들린다(overfit.ts 주석 — 무신호 합성에서 0.09~0.89까지 퍼졌다) — ' +
      '숫자 하나로 결론짓지 말고 λ 분포·DSR·워크포워드를 함께 읽어라.',
  )
  items.push(
    '**고정 전제(격자 축이 아닌 것).** 절대모멘텀 게이트 항상 ON · 동일가중 · 구간 끝 청산비용 근사 ON · ' +
      `연도별 유니버스 교체(6/30 편입 판정) · 그 해 매핑 ${MIN_SYMBOLS}종목 미만이면 현금. ` +
      '이 전제를 바꾸면 격자 전체가 다른 실험이 된다.',
  )
  items.push(
    '**경계 셀이 많다 — 다축 격자의 구조적 한계다.** 모든 축에서 안쪽인 "완전 내부 셀"은 Π(축 값 수 − 2)개뿐이라 ' +
      '대부분의 셀은 최소 한 방향의 이웃이 격자 밖이다. 그 셀들은 **있는 이웃만으로** 고원 점수를 내고 ' +
      '`[표본부족]`으로 라벨한다 — 없는 이웃을 0이나 평균으로 메우지 않는다. 라벨이 붙은 셀의 고원 주장은 ' +
      '**그 방향으로는 검증되지 않았다**는 뜻이다.',
  )
  if (opts.offlineBench)
    items.push(
      `⚠️ **[벤치=${opts.benchLabel}]** — 이 실행의 알파는 **KODEX 200 알파가 아니다.** ` +
        '벤치가 다르면 규칙 5의 판정 기준 자체가 달라진다. 34·36·38차 표 옆에 놓고 읽으면 안 된다.',
    )
  // sourceNote·priceMeta.note는 이미 "유니버스: …" / "시세: …" 접두를 달고 온다 — 다시 붙이지 않는다.
  items.push(opts.universeNote)
  items.forEach((t, i) => log(`${i + 1}. ${t}`))
  if (opts.priceMeta) {
    log(`${items.length + 1}. ${opts.priceMeta.note}`)
    for (const l of opts.priceMeta.limits) log(`   · ${l}`)
    log(`   · ${MIXED_SOURCE_NOTE}`)
  }
}

export function report(out: RunOutputs, inp: RunInputs, opts: { benchLabel: string; offlineBench: boolean }): number {
  const half = halfYearOf(inp.years)
  const n = out.cells.length
  const trialsCumulative = PLATEAU_TRIALS_PRIOR_TOTAL + n

  // ---- 회차 단위 과최적화 채점 ------------------------------------------
  log('')
  log('## 과최적화 채점 (회차 단위 — 이 격자를 돌려 1등을 고르는 절차가 성립하는가)')
  log('')
  log(`· 셀 수 ${n} · 공통 거래일 ${out.dates.length}일 (정렬에서 버린 날 ${out.dropped}일)`)
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
    `  구간 ${out.wf.segments.length}개 (IS ${PLATEAU_WF_IS_DAYS}일 → OOS ${PLATEAU_WF_OOS_DAYS}일) · ` +
      `OOS 연환산 ${pp(out.wf.oosAnnualizedPct)} · 벤치 연환산 ${pp(out.wf.benchAnnualizedPct)} · ` +
      `IS→OOS 저하율 ${out.wf.degradationPct == null ? '—' : `${out.wf.degradationPct.toFixed(1)}%`}`,
  )
  for (const note of out.wf.notes.slice(0, 5)) log(`  ⚠️ ${note}`)

  // ---- DSR (누적 분모) ---------------------------------------------------
  const trialSharpes = out.results.map((r) => r.sharpeDaily).filter((v): v is number => v != null)
  // 승자 = **고원 점수 1위**(이 회차의 질문이 그것이다). 고원 점수가 하나도 없으면 칼마 1위.
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
  log(`### 다중검정 보정 — 누적 분모 ${PLATEAU_TRIALS_PRIOR_TOTAL} + ${n} = ${trialsCumulative}`)
  log('')
  for (const r of PLATEAU_TRIALS_PRIOR) log(`· ${r.round}: ${r.n}변형`)
  log(`· 39차 (이번 고원 격자): ${n}셀`)
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

  // ---- 고원 요약 --------------------------------------------------------
  const roundGate = { pbo: out.pbo.pbo, wfOosAlpha: out.wf.oosAlphaPct }
  const verdicts = out.results.map((r, i) => promotionVerdict(r, out.plateau[i], roundGate))
  const promoted = verdicts.map((v, i) => ({ v, i })).filter((x) => x.v.promoted)

  const scored = out.plateau.filter((p) => p.plateauScore != null)
  const interior = out.plateau.filter((p) => !p.sampleShort)
  log('')
  log('## 고원 채점 — 파라미터를 흔들어도 성적이 유지되는 영역이 있는가')
  log('')
  const shakeAxes = inp.grid.filter((a) => a.values.length > 1)
  const frozenAxes = inp.grid.filter((a) => a.values.length < 2)
  log(
    `· 고원 점수를 낼 수 있는 셀 ${scored.length}/${n}개 · 완전 내부 셀(이웃 ${2 * shakeAxes.length}개 전부 존재) ${interior.length}개 · ` +
      `경계 셀 **[표본부족] ${n - interior.length}개**`,
  )
  if (frozenAxes.length > 0)
    log(
      `· ⚠️ 값이 1개뿐이라 **아예 흔들지 않은 축**: ${frozenAxes.map((a) => a.key).join(', ')} — ` +
        '그 방향의 고원성은 이 실행으로 검증되지 않았다(경계 문제가 아니라 설계상 고정이다).',
    )
  log(
    `· plateauScore = **셀과 이웃 성적의 최솟값**(평균 아님) · plateauDrop = (셀 − 이웃최솟값) ÷ |셀| · ` +
      `고원 임계 ${PLATEAU_DROP_THRESHOLD}`,
  )
  log(
    `· ⚠️ ${shakeAxes.length}축을 흔드는 격자에서 완전 내부 셀은 Π(축 값 수 − 2) = ` +
      `${shakeAxes.map((a) => Math.max(0, a.values.length - 2)).join('×')} = ${interior.length}개뿐이다 ` +
      '— 구조적 한계다. 나머지 셀은 **있는 이웃만으로** 채점하고 `[표본부족]`으로 라벨한다(없는 이웃을 0·평균으로 메우지 않는다).',
  )
  const flat = scored.filter((p) => p.plateauDrop != null && p.plateauDrop <= PLATEAU_DROP_THRESHOLD)
  log(
    `· plateauDrop ≤ ${PLATEAU_DROP_THRESHOLD}인 셀 ${flat.length}개 · 그중 이웃 전부가 관문①을 통과한 셀 ` +
      `${flat.filter((p) => p.neighborsPassLocal === true).length}개`,
  )

  // 고원 점수 상위 표
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
        `${f1(r.full.cagr)}% | ${f1(r.full.mdd)}% | ${pp(r.alphaA)} | ${pp(r.alphaB)} | ${r.trades} | ` +
        `${v.promoted ? '✅ 승격' : `❌ ${v.failed.join('·')}`} |`,
    )
  }

  // 칼마 1위(참고) — "1등 칸" 자체는 이 회차의 답이 아니다.
  const byCalmar = out.results
    .map((r, i) => ({ r, i }))
    .filter((x) => x.r.calmar != null)
    .sort((x, y) => (y.r.calmar as number) - (x.r.calmar as number))
    .slice(0, 5)
  log('')
  log('### 참고: 칼마 1위 5셀 — **이 회차의 답이 아니다**(38차에서 이 방식이 아웃샘플에서 무너졌다)')
  log('')
  log('| 셀 | 칼마 | plateauScore | plateauDrop | 전반 알파 | 후반 알파 | 매매 |')
  log('|---|---|---|---|---|---|---|')
  for (const { r, i } of byCalmar) {
    const p = out.plateau[i]
    log(
      `| \`${r.cell.key}\`${p.sampleShort ? ' [표본부족]' : ''} | ${num(r.calmar)} | ${num(p.plateauScore)} | ` +
        `${num(p.plateauDrop)} | ${pp(r.alphaA)} | ${pp(r.alphaB)} | ${r.trades} |`,
    )
  }

  // ---- 히트맵 단면 ------------------------------------------------------
  // "고원이 눈에 보이는가"를 대표가 표로 확인할 수 있어야 한다. 고정값은 **고원 점수 1위 셀**의
  // 값으로 잡는다(1등 칼마 칸이 아니라 이 회차의 질문에 맞춘 단면이다).
  const anchor = winner >= 0 ? out.results[winner].cell.params : null
  const fixedOf = (exclude: AxisKey[]): Partial<Record<AxisKey, number>> => {
    const f: Partial<Record<AxisKey, number>> = {}
    for (const ax of inp.grid) {
      if (exclude.includes(ax.key)) continue
      const v = anchor ? (anchor as unknown as Record<AxisKey, number>)[ax.key] : ax.values[0]
      f[ax.key] = ax.values.includes(v) ? v : ax.values[0]
    }
    return f
  }
  log('')
  log('## 격자 단면 (2D 히트맵) — 고원이 눈에 보이는가')
  log('')
  log(
    `단면 고정값은 **고원 점수 1위 셀**(${anchor ? cellKey(anchor) : '—'})의 좌표다. ` +
      '값이 넓게 비슷하면 고원, 한 칸만 튀면 봉우리다.',
  )
  heatmapTable(
    '칼마 — lookback × slots',
    out.cells,
    inp.grid,
    (i) => out.results[i].calmar,
    'lookback',
    'slots',
    fixedOf(['lookback', 'slots']),
  )
  heatmapTable(
    'plateauScore(이웃 포함 최솟값) — lookback × slots',
    out.cells,
    inp.grid,
    (i) => out.plateau[i].plateauScore,
    'lookback',
    'slots',
    fixedOf(['lookback', 'slots']),
  )
  heatmapTable(
    '칼마 — gateMa × rebalMonths',
    out.cells,
    inp.grid,
    (i) => out.results[i].calmar,
    'gateMa',
    'rebalMonths',
    fixedOf(['gateMa', 'rebalMonths']),
  )
  heatmapTable(
    '칼마 — lookback × skip',
    out.cells,
    inp.grid,
    (i) => out.results[i].calmar,
    'lookback',
    'skip',
    fixedOf(['lookback', 'skip']),
  )

  // ---- 승격 판정 --------------------------------------------------------
  log('')
  log('## 승격 관문 — ①전·후반 알파 ②매매≥20 ③PBO<0.5 ④WF OOS 알파>0 ⑤고원')
  log('')
  const cnt = (k: number) => verdicts.filter((v) => v.passed.includes(k)).length
  log(`| 관문 | 통과 셀 |`)
  log(`|---|---|`)
  log(`| ① 전·후반 알파 양수 | ${cnt(1)} / ${n} |`)
  log(`| ② 매매수 ≥ ${PLATEAU_MIN_TRADES} | ${cnt(2)} / ${n} |`)
  log(`| ③ PBO < ${PBO_WARN_THRESHOLD} | ${cnt(3)} / ${n} (회차 단위 값이라 전부 같다) |`)
  log(`| ④ 워크포워드 OOS 알파 > 0 | ${cnt(4)} / ${n} (회차 단위 값이라 전부 같다) |`)
  log(`| ⑤ 고원(drop ≤ ${PLATEAU_DROP_THRESHOLD} + 이웃 전부 ① 통과) | ${cnt(5)} / ${n} |`)
  log('')
  if (promoted.length === 0) {
    log('### ✅ 결론: **승격 0건**')
    log('')
    log(
      '다섯 관문을 전부 통과한 셀이 없다. **가장 덜 나쁜 칸을 승격시키지 않는다** — 그렇게 고른 칸이 ' +
        '아웃샘플에서 무너지는 것이 38차에서 이미 측정됐다(PBO 0.622 · WF OOS 알파 −13.81%p). ' +
        '이 회차의 답은 "이 격자에는 승격시킬 고원이 없다"이다.',
    )
  } else {
    log(`### 승격 후보 ${promoted.length}건`)
    log('')
    log('| 셀 | plateauScore | plateauDrop | 칼마 | 전반 알파 | 후반 알파 | 매매 | 이웃 |')
    log('|---|---|---|---|---|---|---|---|')
    for (const { i } of promoted) {
      const r = out.results[i]
      const p = out.plateau[i]
      log(
        `| \`${r.cell.key}\`${p.sampleShort ? ' **[표본부족]**' : ''} | ${num(p.plateauScore)} | ${num(p.plateauDrop)} | ` +
          `${num(r.calmar)} | ${pp(r.alphaA)} | ${pp(r.alphaB)} | ${r.trades} | ${p.neighbors}/${p.neighbors + p.missing.length} |`,
      )
    }
    log('')
    log(
      '⚠️ 승격은 "채택"이 아니다. 라이브 검증 전에는 확정이 아니며, `[표본부족]` 라벨이 붙은 셀은 ' +
        '격자 경계라 한쪽 방향의 고원성이 **검증되지 않았다**.',
    )
  }
  log('')
  log(`전·후반 분할: 전반 ${inp.years[0]}~${half - 1} / 후반 ${half}~${inp.years[inp.years.length - 1]}`)
  log(
    `⚠️ 짧은 표본 — 전 구간 ${inp.years.length}년. 국면 하나가 한 구간을 통째로 지배할 수 있어 ` +
      '"전·후반 모두 양수"가 재현성의 증거가 되기엔 부족하다.',
  )
  return promoted.length
}

// ============================================================================
// 14. 자기검증 (합성 데이터 — 파일·네트워크 불필요)
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

/** 합성 일봉 — 주말 포함(달력 경계 판정만 보므로 무해). */
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
    bars.push({ date, t: Math.floor(t / 1000), o, h: Math.max(o, c) * 1.005, l: Math.min(o, c) * 0.995, c, v: 1e6 })
  }
  return bars
}

/** 합성 유니버스 — 셀 시간 측정·배선 확인용. */
export function syntheticWorld(nSyms = 20, years = 8, seed = 7) {
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

// ============================================================================
// 15. main
// ============================================================================

type Mode = 'plateau' | 'quick' | 'offline' | 'selftest'

function modeFromEnv(): Mode {
  const m = (process.env.MODE ?? 'plateau').trim().toLowerCase()
  if (m === 'plateau' || m === 'quick' || m === 'offline' || m === 'selftest') return m
  throw new Error(`알 수 없는 MODE=${m} — plateau | quick | offline | selftest 중 하나여야 한다`)
}

async function main(): Promise<void> {
  const mode = modeFromEnv()
  log('# 39차 — 고원(plateau) 채점 격자')
  log('')
  log(
    '**이 회차는 "더 좋은 1등 칸 찾기"가 아니다.** 33~38차 누적 97변형에서 QQQ 원화 보유 벽(칼마 0.670)을 ' +
      '넘은 변형은 0개였고, 38차에서 그 탐색 절차 자체가 아웃샘플에서 무너지는 것이 수치로 잡혔다 ' +
      '(PBO 0.622 · WF OOS 알파 −13.81%p · IS→OOS 저하율 146.9%). 그래서 여기서 묻는 것은 하나다 — ' +
      '**파라미터를 흔들어도 성적이 유지되는 영역(고원)이 존재하는가.** 없으면 "없다"가 정답이다.',
  )
  log('')
  log(`MODE=${mode}`)

  if (mode === 'selftest') {
    await runSelftest()
    return
  }

  const grid = mode === 'quick' ? QUICK_GRID : FULL_GRID
  const cellCount = enumerateGrid(grid).length
  log(`격자: ${grid.map((a) => `${a.key}[${a.values.join(',')}]`).join(' × ')} = **${cellCount}셀**`)

  // ---- 유니버스 ---------------------------------------------------------
  const width = parseWidthEnv(process.env.KRX_WIDTH)
  const universe = loadUniverse(ROOT, width)
  log('')
  log(`유니버스: ${universe.label} (폭 ${krxWidthLabel(width)})`)
  log(`⚠️ ${universe.sourceNote}`)

  // ---- 시세 (기본 KRX 정본 — 야후로 조용히 폴백하지 않는다) --------------
  const priceSource: PriceSource = normalizePriceSource(
    (process.env.PRICE_SOURCE ?? 'krx').trim().toLowerCase(),
  )
  log(`시세 소스: ${priceSource}${priceSource === 'krx' ? ' (기본)' : ' (PRICE_SOURCE로 지정)'}`)
  const load = await loadKrPrices(universe.union, priceSource, {
    yahoo: { fetchDaily: (sym) => fetchDaily(sym, 'since:2008-01-01'), betweenAttempts: () => sleep(120), concurrency: 1 },
    krx: nodeKrxDeps(ROOT),
  })
  log(`시세 로드 ${load.meta.loaded}/${universe.union.length}${load.failed.length ? ` · 실패: ${load.failed.join(', ')}` : ''}`)
  log(`  ${load.meta.note}`)
  if (load.meta.loaded === 0) throw new Error('시세를 하나도 받지 못했다 — 실행 중단')

  // ---- 벤치 ------------------------------------------------------------
  const tally = newYahooTally()
  let benchEq: Curve
  let benchLabel: string
  let offlineBench = false
  if (mode === 'offline') {
    benchEq = equalWeightIndex(load.histories, Object.keys(load.histories), `${universe.years[0]}-01-01`)
    benchLabel = '유니버스 동일가중'
    offlineBench = true
    if (benchEq.length < 2) throw new Error('오프라인 벤치(유니버스 동일가중)를 만들지 못했다 — 실행 중단')
    log(`벤치: **[벤치=${benchLabel}]** ${benchEq.length}점 — ⚠️ KODEX 200 알파가 아니다(34·36·38차 표와 비교 금지)`)
  } else {
    const bars = await tallyFetch(tally, BENCH)
    // 규칙 4 — 필수 호출이 실패하면 **조용히 넘어가지 않고 비정상 종료**한다.
    if (!bars)
      throw new Error(
        `벤치(${BENCH}) 로드 실패 — 알파 판정(규칙 5)이 불가능하므로 실행을 중단한다. ` +
          `사유: ${tally.failed.map((f) => `${f.symbol}: ${f.reason}`).join(' / ')}. ` +
          '다른 벤치로 조용히 대체하지 않는다(MODE=offline은 벤치가 다르다는 것을 라벨로 밝히는 별도 모드다).',
      )
    benchEq = bars.filter((b) => b.c > 0).map((b) => ({ date: b.date, equity: b.c }))
    benchLabel = `${BENCH} KODEX 200`
    log(`벤치: ${benchLabel} ${bars.length}봉 (${bars[0].date} ~ ${bars[bars.length - 1].date}) · 총수익(배당 재투자)`)
  }

  // ---- 연도 컨텍스트(파라미터 무관 — 한 번만 만든다) --------------------
  const resolve = (code: string) => load.symOf[code]
  const ctxs = buildYearCtxs(load.histories, universe.years, universe.codesFor, resolve)
  const usable = ctxs.filter((c) => c.symbols.length >= MIN_SYMBOLS)
  log('')
  log(
    `연도 컨텍스트 ${ctxs.length}년 · 실행 가능(매핑 ${MIN_SYMBOLS}종목 이상) ${usable.length}년 · ` +
      `매핑률 ${ctxs.map((c) => `${c.y}:${c.symbols.length}/${c.totalCodes}`).join(' ')}`,
  )
  if (usable.length < 2) throw new Error('실행 가능한 연도가 2년 미만이다 — 실행 중단')

  // ---- 격자 실행 --------------------------------------------------------
  log('')
  const t0 = Date.now()
  let firstCellMs = 0
  const inputs: RunInputs = {
    grid,
    ctxs,
    years: universe.years,
    cost: PLATEAU_COST,
    // 게이트 판정 시계열 = 벤치 곡선. offline 모드에서는 동일가중 지수가 그 역할을 한다
    // (그 사실이 벤치 라벨로 이미 드러나 있다 — 조용히 다른 계열을 쓰지 않는다).
    regime: benchEq,
    benchCurve: benchEq,
    benchLabel,
  }
  const out = runGrid(inputs, (done, total, ms) => {
    if (done === 1) {
      firstCellMs = ms
      log(`1셀 실측 ${ms}ms → ${total}셀 예상 ${((ms * total) / 1000).toFixed(0)}초 (격자 실행분만)`)
    }
    if (done % 50 === 0 || done === total)
      log(`  격자 진행 ${done}/${total} · 경과 ${((Date.now() - t0) / 1000).toFixed(0)}초`)
  })
  log(
    `격자 실행 ${(out.gridMs / 1000).toFixed(1)}초 (${out.cells.length}셀 · 1셀 ${firstCellMs}ms · ` +
      `평균 ${(out.gridMs / out.cells.length).toFixed(0)}ms) + 사후 채점 ${(out.scoringMs / 1000).toFixed(1)}초` +
      `(PBO가 지배적) = 합계 ${((out.gridMs + out.scoringMs) / 1000).toFixed(1)}초`,
  )

  const promotedCount = report(out, inputs, { benchLabel, offlineBench })

  // ---- 참고 벽 (선택 — 실패해도 격자 결과는 그대로 선다) -----------------
  if (mode !== 'offline' && out.results.length > 0) {
    const span = out.dates.length ? [out.dates[0], out.dates[out.dates.length - 1]] : null
    if (span) {
      log('')
      log(`## 참고 벽 — 전략 구간(${span[0]} ~ ${span[1]})으로 **다시 잰** 단순보유. 판정 벤치가 아니다.`)
      log('')
      const walls: WallStats[] = []
      const qqq = await tallyFetch(tally, QQQ_SYMBOL)
      await sleep(120)
      const fx = await tallyFetch(tally, FX_SYMBOL)
      if (qqq && fx) {
        const w = wallOf('QQQ 원화 보유', toKrwCurve(qqq, fx), span[0], span[1])
        if (w) walls.push(w)
        else log('⚠️ QQQ 원화 곡선이 구간과 겹치지 않는다 — 벽 행 생략')
      } else {
        log('⚠️ QQQ·환율 로드 실패 — 벽 행 생략(격자 결과는 그대로다). 사유는 아래 야후 집계 참조.')
      }
      const bw = wallOf('KODEX 200 보유', benchEq, span[0], span[1])
      if (bw) walls.push(bw)
      if (walls.length > 0) {
        log('| 벽 | 칼마 | CAGR | MDD | 구간 |')
        log('|---|---|---|---|---|')
        for (const w of walls)
          log(`| ${w.label} | ${num(w.calmar)} | ${f1(w.cagrPct)}% | ${f1(w.mddPct)}% | ${w.from}~${w.to} |`)
        const q = walls.find((w) => w.label.startsWith('QQQ'))
        if (q?.calmar != null) {
          const over = out.results.filter((r) => r.calmar != null && (r.calmar as number) > (q.calmar as number))
          log('')
          log(
            over.length === 0
              ? `→ QQQ 원화 보유 벽(칼마 ${num(q.calmar)})을 넘은 셀: **없음** (33~38차 결론과 같다)`
              : `→ QQQ 벽을 넘은 셀 ${over.length}개: ${over.slice(0, 10).map((r) => `\`${r.cell.key}\``).join(', ')}` +
                  `${over.length > 10 ? ' …' : ''} — ⚠️ 벽을 넘었다는 것과 고원이라는 것은 다른 판정이다.`,
          )
        }
      }
    }
  }

  // ---- 야후 집계 (규칙 4 — 성공 카운터를 반드시 찍는다) ------------------
  if (tally.attempted > 0) {
    log('')
    log(`야후 호출 집계: 시도 ${tally.attempted} · 성공 ${tally.ok} · 실패 ${tally.failed.length}`)
    for (const f of tally.failed) log(`  ❌ ${f.symbol} — ${f.reason}`)
    if (tally.ok === 0)
      throw new Error('야후 호출이 전량 실패했다 — 조용히 통과시키지 않고 비정상 종료한다(규칙 4).')
  }

  limitsSection({
    benchLabel,
    offlineBench,
    priceMeta: load.meta,
    universeNote: universe.sourceNote,
    cellCount: out.cells.length,
    pboMaxCombos: out.pbo.combinationsEvaluated,
    pboExhaustive: out.pbo.exhaustive,
  })
  for (const l of DISCLAIMER) log(l)
  log('')
  log(`## 한 줄 결론 — 승격 ${promotedCount}건 / ${out.cells.length}셀`)
}

/** 합성 자기검증 — 파일·네트워크 없이 배선과 고원 산술이 도는지 확인한다. */
async function runSelftest(): Promise<void> {
  log('')
  log('## 자기검증 (합성 데이터 — 실데이터가 아니다. 이 표의 수치로 어떤 판정도 하지 않는다)')
  const world = syntheticWorld(20, 8, 7)
  const ctxs = buildYearCtxs(world.histories, world.years, world.codesFor, (c) => c)
  const bench = equalWeightIndex(world.histories, world.codes, `${world.years[0]}-01-01`)
  const benchLabel = '합성 동일가중'
  const inputs: RunInputs = {
    grid: QUICK_GRID,
    ctxs,
    years: world.years,
    cost: PLATEAU_COST,
    regime: bench,
    benchCurve: bench,
    benchLabel,
  }
  const out = runGrid(inputs)
  log('')
  log(
    `셀 ${out.cells.length}개 · 격자 ${(out.gridMs / 1000).toFixed(2)}초 + 채점 ${(out.scoringMs / 1000).toFixed(2)}초 · ` +
      `공통 거래일 ${out.dates.length}일`,
  )
  // 보고서 경로까지 그대로 태운다 — 출력 형식이 깨지는 것을 실데이터 실행 전에 잡기 위해서다.
  const promoted = report(out, inputs, { benchLabel, offlineBench: true })
  limitsSection({
    benchLabel,
    offlineBench: true,
    universeNote: '합성 유니버스(실데이터가 아니다)',
    cellCount: out.cells.length,
    pboMaxCombos: out.pbo.combinationsEvaluated,
    pboExhaustive: out.pbo.exhaustive,
    synthetic: true,
  })
  log('')
  log(
    `⚠️ **합성 데이터다. 이 표의 수치로 어떤 판정도 하지 않는다**(승격 ${promoted}건이라는 표기도 배선 확인용이다). ` +
      '실데이터 실행은 GHA `Backtest (GHA runner)` · mode `plateau:plateau`.',
  )
  for (const l of DISCLAIMER) log(l)
}

// 런처(scripts/plateau-lab.mjs)만 이 값을 넘긴다.
// 테스트가 이 모듈을 import할 때는 자동 실행되지 않는다.
if (process.env.PLATEAU_LAB_RUN === '1') {
  main().catch((e) => {
    console.error('실행 실패:', e)
    process.exit(1)
  })
}
