// 프리셋 사전계산 — 시뮬레이터 프리셋 전부를 실데이터로 미리 돌려 산출물을 파일로 굽는다.
//
// 대표 지시(2026-08-02): "프리셋들 결과는 미리 돌려서 저장해놓으면 시간 단축 할 수 있게",
//                        "프리셋 이름들에 MDD랑 최근 10년 평균 수익률 추가".
//
// 화면에서 프리셋 하나를 돌리려면 67종목 시세를 전부 받아 20여 년을 연쇄 실행해야 해서
// 수십 초가 걸린다. 프리셋은 **정의가 고정**이라 매번 같은 답이 나오므로, GHA에서 하루치
// 데이터로 한 번 굽고 화면은 그 파일을 읽어 즉시 보여준다.
//
// ── 같은 함수로 돈다 (수치가 갈라질 수 없게) ────────────────────────────────
//   조건식 → runPitChained · 모멘텀 → runXsmomChained · 결합 → blendChainResults.
//   화면(SpecSimulator.tsx)이 부르는 것과 **같은 함수·같은 비용 상수(presets.ts DEFAULT_COST)**다.
//   프리셋 정의도 같은 배열(src/features/backtest/presets.ts)에서 읽는다.
//
// ── 규칙 1(미래참조 금지) ───────────────────────────────────────────────────
//   실행 경로가 화면과 동일하므로 인과성은 엔진이 이미 보장한다(절단 불변성 테스트가 집행).
//   이 스크립트가 새로 하는 계산은 **이미 확정된 자산곡선의 사후 요약**뿐이다 —
//   10년 CAGR·다운샘플은 백테스트 결과를 표시용으로 줄이는 조작이지, 판정에 되먹임되지 않는다.
//   (전 구간 통계를 만들어 신호·임계값으로 쓰는 행위는 여기서도 하지 않는다.)
//
// ── 정직성(규칙 3) ──────────────────────────────────────────────────────────
//   산출물에 asOf(데이터 마지막 거래일)·computedAt·다운샘플 간격을 박아 화면이 배지로
//   드러내게 한다. 요약 수치(mddPct 등)는 **다운샘플 전 원곡선**에서 계산한다 —
//   주 1점으로 줄인 곡선에서 MDD를 재면 장중·주중 최저점이 빠져 낙폭이 얕아 보인다.
//
// ── 시세 소스 (2026-08-03 · 야후 배제 2단계) ────────────────────────────────
//   국내 유니버스 시세는 `PRICE_SOURCE=krx|yahoo`로 고른다(**기본 yahoo** — KRX 정본 파일이
//   아직 리포에 없다). 화면과 **같은 어댑터**(src/features/backtest/priceSource.ts)를 쓰므로
//   두 쪽이 다른 소스로 갈릴 수 없다. `krx`인데 데이터가 없으면 **굽기를 중단한다**(폴백 없음).
//   ⚠️ 벤치(KODEX 200)·참고선(QQQ·QLD·금·환율)은 소스와 무관하게 **항상 야후**다.
//   ⚠️ 2026-08-03 — 야후에서 받되 **비교 대상**(벤치·QQQ 벽)은 `COMPARE_BASIS`를 따른다.
//      국내 시세가 KRX 정본(가격수익)이면 `adjclose ÷ close` 계수를 곱하지 않아 배당 기준을 맞춘다.
//      **신호 입력**(레짐 지수·게이트 벤치)과 **보유 자산 슬리브**(금)는 총수익 그대로다 —
//      비교 기준을 바꾸면서 전략 행동까지 바꾸지 않기 위해서다(그 편향은 산출물 note에 남긴다).
//
// 실행: node scripts/preset-precompute.mjs   (GHA backtest.yml MODE=presets)
//       PRICE_SOURCE=krx node scripts/preset-precompute.mjs

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { CostSettings } from '../src/features/backtest/conditionScreen'
import { annualize, runPitChained, yearsBetween, type PitChainResult } from '../src/features/backtest/pitChain'
import { runXsmomChained } from '../src/features/backtest/xsmomChain'
import {
  composeCombo,
  makeMarketGateExposure,
  spliceRegimeCurve,
  toKrwCurve,
  type Curve,
} from '../src/features/backtest/marketGate'
import { perfStatFields, type PerfStatFields } from '../src/features/backtest/perfStats'
// 유니버스는 **KRX 실측 파일**에서 온다 — [추정] 목록(pitUniverse)이 아니다(34차).
// 화면(SpecSimulator)과 **같은 파생 함수**(deriveKrxUniverse)를 쓰므로 두 쪽 유니버스가 갈릴 수 없다.
import { KRX_PIT_PATH, parseKrxPitUniverse } from '../src/features/backtest/krxPitUniverse'
import {
  DEFAULT_KRX_TOP_N,
  deriveKrxUniverse,
  type DerivedKrxUniverse,
} from '../src/features/backtest/krxUniverseSource'
import {
  BENCH_SYMBOL,
  DEFAULT_COST,
  FX_SYMBOL,
  GOLD_SYMBOL,
  PRESETS,
  REGIME_FALLBACK_SYMBOL,
  normalizeGoldW,
  type Preset,
  type StrategyKind,
} from '../src/features/backtest/presets'
import type { StrategySpec } from '../src/features/backtest/strategySpec'
import type { DailyBar } from '../src/features/backtest/types'
import { KR_LOAD_NOTE, KR_MIN_BARS } from '../src/lib/history'
// 시세 소스는 **어댑터 하나**로 고른다 — 화면(SpecSimulator)과 같은 함수라 두 쪽이 갈릴 수 없다.
import {
  MIXED_SOURCE_NOTE,
  loadKrPrices,
  normalizePriceSource,
  type KrxPriceDeps,
  type PriceSource,
  type PriceSourceMeta,
} from '../src/features/backtest/priceSource'
import { KRX_DAILY_DIR } from '../src/features/backtest/krxDailyPrices'

// CJS 번들에서 import.meta.url이 없으므로 런처가 REPO_ROOT를 넘긴다.
const root = process.env.REPO_ROOT ?? process.cwd()
const OUT_PATH = join(root, 'public', 'data', 'presets-precomputed.json')

/**
 * 산출물 스키마 버전 — 화면이 모르는 버전이면 무시하고 우아하게 강등한다.
 * 2 (2026-08-02): 표준 성과 지표 세트(변동성·샤프·소르티노·최장 낙폭 기간·손익비·PF) **추가**.
 * 3 (2026-08-03): 참고 벽(walls — 같은 구간 QQQ 원화·KODEX 200 단순보유) **추가**.
 * 4 (2026-08-03): **시세 소스**(priceSource·priceSourceNote·priceSourceLimits) **추가** — 야후 배제 2단계.
 *   어느 시세로 구운 수치인지 산출물이 스스로 말하게 한다. 야후(총수익)와 KRX 정본(가격수익)은
 *   같은 표에서 비교하면 안 되는 값이라, 소스 표기가 없으면 그 표가 곧 거짓이 된다(규칙 3).
 * 전부 필드 추가만이라 화면(precomputed.ts)은 schema 1·2·3 산출물도 계속 읽는다(없는 값은 '—'·상수 강등).
 *
 * ── 5 (2026-08-03): **비교 기준(compareBasis)** 추가 — 배당 비대칭 제거(40차) ────────────
 *   전략은 KRX 가격수익인데 벤치·벽만 야후 총수익이라 알파가 전략에 **불리하게** 찍혀 있었다.
 *   그 편향을 제거하면서, 이 산출물이 어느 기준으로 구워졌는지를 필드로 남긴다.
 *   **schema 1~4 산출물에는 이 필드가 없고, 그것들은 전부 총수익 벤치로 구운 것이 사실이다** —
 *   리더(`src/features/backtest/precomputed.ts`)가 없으면 `'total'`로 고정해 읽는다
 *   (`priceSource`가 없으면 `'yahoo'`로 읽는 것과 같은 규약).
 */
export const PRECOMPUTE_SCHEMA = 5

/**
 * 시세 소스 선택 — `PRICE_SOURCE=krx|yahoo`(기본 yahoo).
 * **기본이 야후인 이유**: KRX 일별 정본 파일이 아직 리포에 없다(EC2 수집 진행 중).
 * 전환은 데이터가 도착한 뒤 총괄이 한다 — 크론이 조용히 소스를 바꿔 수치가 갈리지 않게
 * 명시적 환경변수로만 넘어간다. 모르는 값이 들어오면 야후로 좁힌다(조용한 오작동 방지).
 */
export function priceSourceFromEnv(env: Record<string, string | undefined>): PriceSource {
  return normalizePriceSource((env.PRICE_SOURCE ?? '').trim().toLowerCase())
}

/**
 * 화면의 `getDailyHistory(sym, BACKTEST_HISTORY_RANGE)`와 **같은 구간**을 받는다.
 * (src/lib/history.ts: `max1999` 는 period1=1999-01-01 로 치환된다. 여기서 구간이 어긋나면
 *  사전계산 수치와 화면에서 "직접 다시 돌리기" 한 수치가 달라진다.)
 *
 * ⚠️ 2026-08-02 수정 — 예전 값은 `since:2000-01-01`이었다. 연쇄 첫 해(2000년)에 이평·모멘텀
 * 워밍업 봉이 없어 `maBreak` 청산이 발동하지 않고 모멘텀 후보가 통째로 빠졌다(MODE=presetdiag 실측).
 * 연구 러너는 처음부터 1999년부터 받는다. **백테스트 시작(곡선 시작)은 그대로 2000년**이다 —
 * `runPitChained`/`runXsmomChained`가 PIT_YEARS(2000~) 단위로 돌기 때문에 1999년 봉은
 * 지표 창을 채우는 데만 쓰인다.
 */
/**
 * 화면(`getDailyHistory(sym, BACKTEST_HISTORY_RANGE)` = `max1999`)과 **같은 구간**을 유지한다.
 * 여기서 구간이 어긋나면 사전계산 수치와 화면의 "직접 다시 돌리기" 수치가 달라진다.
 *
 * 34차로 유니버스가 **KRX 실측 2010~**이 되면서 앞 구간은 대부분 워밍업으로만 쓰이지만,
 * 범위를 좁히지 않았다 — 12-1 모멘텀은 첫 리밸런스(2010년 1월) 시점에 **12개월 앞선 봉**을
 * 요구하므로 여유 없이 자르면 첫 해만 조용히 다르게 돈다. 넉넉한 워밍업이 그 위험보다 싸다.
 * **백테스트 시작(곡선 시작)은 2010년**이다(실행 연도가 실측 유니버스로 고정되기 때문).
 */
const RANGE = 'since:1999-01-01'

/** 참고 벽 — 34차가 "어떤 조합도 넘지 못했다"고 판정한 기준선. 판정 벤치가 아니다(규칙 5). */
const QQQ_SYMBOL = 'QQQ'

function log(msg: string) {
  console.log(msg)
}

// ============================================================================
// 데이터 로더 — spec-backtest.entry.ts / idea-lab.entry.ts와 같은 방식
// ============================================================================

// ---------------------------------------------------------------- 비교 기준
//
// 정본 규약은 `scripts/idea-lab.entry.ts`가 갖는다(2026-08-03 `2dbfbac`). 여기서는 **같은 이름·같은
// 의미**로 자립적으로 구현한다 — 러너끼리 import하면 의존이 얽히므로 `fetchDaily`가 복제돼 있는
// 것과 같은 구조를 따른다.

/**
 * 수익 기준 — 배당을 넣느냐 빼느냐.
 *   `total` = 총수익(배당 재투자). 야후 `adjclose ÷ close` 계수를 OHLC에 곱한다.
 *   `price` = 가격수익(배당 제외). 계수를 곱하지 않는다.
 *
 * 왜 골라야 하나: 국내 유니버스를 KRX 정본으로 바꾸면 **전략은 가격수익**이 되는데(KRX 원주가에는
 * 현금배당이 반영되지 않는다), 벤치(KODEX 200)와 QQQ 벽은 야후 adjclose 기반이라 **총수익**이었다.
 * 즉 "배당 없는 전략 vs 배당 있는 지수"를 붙여 놓고 알파를 잰 셈이고, KODEX 200 배당수익률만큼
 * **모든 알파가 전략에 불리하게** 찍혔다. 그래서 시세 소스가 krx면 벤치·벽도 가격수익으로 맞춘다.
 *
 * ⚠️ 이건 "전략을 유리하게 만드는 보정"이 아니다. 어느 쪽으로도 기울지 않은 비교를 만드는 것이고,
 *    그래서 결과가 나빠질 수도 좋아질 수도 있다. 바꾼 뒤의 수치만 쓴다.
 */
export type ReturnBasis = 'total' | 'price'

/** 시세 소스에 맞는 비교 기준 — 전략과 벤치의 배당 반영 여부를 일치시킨다. */
export function compareBasisFor(source: PriceSource): ReturnBasis {
  return source === 'krx' ? 'price' : 'total'
}

/**
 * 벤치·벽처럼 **전략과 비교되는** 자산의 수익 기준. `main()` 시작에서 한 번 정해진다.
 * 국내 유니버스 시세는 `loadKrPrices` 어댑터를 지나므로 이 값을 보지 않는다.
 */
let COMPARE_BASIS: ReturnBasis = 'total'
export function setCompareBasis(b: ReturnBasis): void {
  COMPARE_BASIS = b
}
/** 지금 걸려 있는 비교 기준(테스트·진단용). */
export function compareBasis(): ReturnBasis {
  return COMPARE_BASIS
}
export function compareBasisNote(b: ReturnBasis): string {
  return b === 'price'
    ? '비교 기준: **가격수익**(배당 제외) — 전략(KRX 원주가)과 벤치·벽을 **같은 기준**으로 맞췄다. ' +
        '벤치의 배당수익률만큼 알파를 깎던 편향이 제거된 수치다.'
    : '비교 기준: **총수익**(배당 재투자) — 전략도 야후 adjclose 기반이라 벤치와 기준이 같다.'
}

/**
 * **비교 대상**(벤치·참고 벽) 전용 로더 — 기준을 한 자리에서 건다.
 * 벤치와 벽이 각자 다른 기준으로 로드되면 같은 표 안에서 배당이 섞이고,
 * 그 차이는 알파 몇 %p로 조용히 흡수된다.
 */
export function fetchCompare(symbol: string, range = RANGE): Promise<DailyBar[]> {
  return fetchDaily(symbol, range, COMPARE_BASIS)
}

export async function fetchDaily(symbol: string, range = RANGE, basis: ReturnBasis = 'total'): Promise<DailyBar[]> {
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
    // 총수익 보정(규칙 3): adjclose ÷ close 계수를 OHLC에 적용 (배당 재투자 기준).
    // basis='price'면 곱하지 않는다 — 배당을 뺀 가격수익으로 남긴다(전략과 기준 맞추기).
    const f =
      basis === 'price' ? 1 : adj[i] != null && Number.isFinite(adj[i]!) && cl > 0 ? adj[i]! / cl : 1
    // 한국거래소는 서머타임이 없으므로 KST(+9h) 고정 — 화면(exchangeLocalDate)과 수식이 같다.
    const date = new Date(ts[i] * 1000 + 9 * 3600 * 1000).toISOString().slice(0, 10)
    out.push({ date, t: ts[i], o: o * f, h: h * f, l: l * f, c: cl * f, v: Number.isFinite(v) ? v : 0 })
  }
  return out
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ============================================================================
// 사후 요약 — 여기가 이 스크립트가 새로 만드는 유일한 계산이다 (순수 함수 · 테스트 대상)
// ============================================================================

export interface CurvePoint {
  date: string
  equity: number
  benchmark: number
}

/** 파일 크기를 줄이려고 곡선은 배열 튜플로 굽는다: [날짜, 자산, 벤치마크] */
export type CurveTuple = [string, number, number]

export interface PrecomputedPreset extends PerfStatFields {
  id: string
  label: string
  kind: StrategyKind
  /** 최대 낙폭(%) — 0 이하. **다운샘플 전 원곡선** 기준 */
  mddPct: number
  /** 전 구간 연환산 수익률(%) */
  cagrPct: number
  /** 최근 10년 연환산 수익률(%) — 곡선이 10년에 못 미치면 null */
  cagr10yPct: number | null
  /** 전 구간 총 수익률(%) */
  totalPct: number
  alphaCagrPct: number | null
  benchCagrPct: number | null
  /** 청산 완료 매매 수. 결합은 곡선 합성이라 **귀속 불가**이므로 null */
  tradeCount: number | null
  startDate: string
  endDate: string
  /** 곡선 값의 기준 초기자본(원) */
  initialCapital: number
  /** 주 1점 다운샘플 곡선(최저점·최종일 보존) */
  curve: CurveTuple[]
}

export interface PrecomputedFile {
  schema: number
  /** 데이터 마지막 거래일 */
  asOf: string
  /** 사전계산을 돌린 시각(ISO) */
  computedAt: string
  /** 곡선 다운샘플 간격 — 화면 배지에 그대로 노출한다 */
  curveInterval: 'weekly'
  /** 비용 전제 — 화면과 같은 상수를 썼음을 산출물에 남긴다 */
  cost: CostSettings
  note: string
  presets: PrecomputedPreset[]
  /** 참고 벽(schema 3~) — 같은 구간 단순보유를 다시 잰 값. 판정 벤치가 아니다. */
  walls: WallStats[]
  /**
   * 국내 유니버스 시세를 어디서 받았는지(schema 4~). 옛 산출물에는 없다 → 화면은 'yahoo'로 읽는다.
   * ⚠️ 벤치·참고선은 소스와 무관하게 **항상 야후**다(KRX Open API가 주지 않는 종목·해외 자산).
   */
  priceSource: PriceSource
  /** 그 소스의 출처 한 줄(수집일·종목수 등) */
  priceSourceNote: string
  /** 그 소스의 한계 목록 — 화면이 그대로 나열한다(규칙 3) */
  priceSourceLimits: string[]
  /**
   * 벤치(KODEX 200)·참고 벽(QQQ)을 **어느 수익 기준으로** 받았는지(2026-08-03~).
   * `total` = 총수익(배당 재투자) · `price` = 가격수익(배당 제외).
   *
   * ⚠️ **2026-08-03 이전 산출물에는 이 필드가 없다 → `'total'`로 읽어야 한다.** 그때는 전략이 KRX
   * 가격수익이어도 벤치·벽만 야후 총수익으로 구웠다는 것이 **사실**이기 때문이다. 없는 값을
   * 새 기본값('price')으로 읽으면 옛 수치의 의미가 조용히 바뀐다(`priceSource`와 같은 패턴).
   * schema 번호를 못 올린 사정은 `PRECOMPUTE_SCHEMA` 주석 참조 — 신·구 판별은 **필드의 유무**가 한다.
   */
  compareBasis: ReturnBasis
}

/** `YYYY-MM-DD`에서 n년 뺀 문자열. 문자열 비교로만 쓰므로 2/29 같은 날도 사전순으로 안전하다. */
export function shiftYearsBack(date: string, n: number): string {
  const y = Number(date.slice(0, 4))
  return `${String(y - n).padStart(4, '0')}${date.slice(4)}`
}

/**
 * 최근 10년 연환산 수익률(%) — "최근 10년 평균 수익률"의 구현 정의.
 * 데이터 마지막 날에서 10년 전을 자르고, **그 이후 첫 점 대비** 마지막 점의 배수를 연환산한다.
 * 곡선이 10년을 못 채우면(첫 점이 기준일보다 늦으면) 계산하지 않고 null을 준다 —
 * 짧은 구간을 10년인 척 연환산하면 거짓이 된다.
 */
export function recentCagrPct(curve: { date: string; equity: number }[], years = 10): number | null {
  if (curve.length < 2) return null
  const last = curve[curve.length - 1]
  const cutoff = shiftYearsBack(last.date, years)
  if (curve[0].date > cutoff) return null // 곡선이 그만큼 길지 않다
  const i = curve.findIndex((p) => p.date >= cutoff)
  if (i < 0 || i >= curve.length - 1) return null
  const base = curve[i]
  if (!(base.equity > 0)) return null
  return annualize(last.equity / base.equity, yearsBetween(base.date, last.date))
}

/**
 * 낙폭 극점 — 최대 낙폭(%)과 그 낙폭을 만든 **고점·최저점의 인덱스**.
 * 다운샘플에서 이 두 점을 반드시 남겨야 줄인 곡선에서도 같은 MDD가 읽힌다.
 */
export function drawdownExtremes(curve: { equity: number }[]): {
  mddPct: number
  peakIdx: number
  troughIdx: number
} {
  let peak = -Infinity
  let peakIdx = 0
  let mdd = 0
  let troughIdx = 0
  let mddPeakIdx = 0
  for (let i = 0; i < curve.length; i++) {
    const e = curve[i].equity
    if (e > peak) {
      peak = e
      peakIdx = i
    }
    const dd = peak > 0 ? (e / peak - 1) * 100 : 0
    if (dd < mdd) {
      mdd = dd
      troughIdx = i
      mddPeakIdx = peakIdx
    }
  }
  return { mddPct: mdd, peakIdx: mddPeakIdx, troughIdx }
}

/** 부분집합 곡선에서 다시 잰 MDD(%) — 다운샘플이 낙폭을 얕게 만들지 않았는지 검증용 */
export function mddPctOf(curve: { equity: number }[]): number {
  return drawdownExtremes(curve).mddPct
}

// ---- 참고 벽 (34차) ---------------------------------------------------------

/**
 * 같은 구간 단순보유의 칼마·CAGR·MDD. **옮겨 적지 않고 다시 잰다** —
 * 구간이 다른 칼마를 나란히 놓으면 그 비교는 거짓이기 때문이다(34차 규약).
 *
 * 규칙 1과의 관계: 이미 확정된 가격 곡선의 사후 요약이며, 판정·신호로 되먹임되지 않는다.
 */
export interface WallStats {
  kind: 'qqqKrw' | 'benchKr'
  label: string
  calmar: number
  cagrPct: number
  mddPct: number
  startDate: string
  endDate: string
}

export function wallStats(
  kind: WallStats['kind'],
  label: string,
  curve: { date: string; equity: number }[],
  from: string,
  to: string,
): WallStats | null {
  const seg = curve.filter((p) => p.date >= from && p.date <= to && p.equity > 0)
  if (seg.length < 2) return null
  const first = seg[0]
  const last = seg[seg.length - 1]
  const cagrPct = annualize(last.equity / first.equity, yearsBetween(first.date, last.date))
  const mddPct = mddPctOf(seg)
  // 낙폭이 0이면 칼마가 무한대가 된다 — 그 경우는 0으로 두고 화면이 오해하지 않게 한다.
  const calmar = Math.abs(mddPct) > 1e-9 ? cagrPct / Math.abs(mddPct) : 0
  return { kind, label, calmar, cagrPct, mddPct, startDate: first.date, endDate: last.date }
}

/** 에포크 기준 주 번호 — 요일 정의는 무엇이든 상관없고 **일관성**만 있으면 된다. */
export function weekBucket(date: string): number {
  const days = Math.floor(Date.parse(`${date}T00:00:00Z`) / 86400e3)
  return Math.floor(days / 7)
}

/**
 * 주 1점(각 주 마지막 거래일)으로 줄이되 **첫 점 · 최종일 · MDD의 고점과 최저점**은 반드시 남긴다.
 *
 * 부분집합의 낙폭은 원래보다 **얕아질 수만** 있다(빠진 고점만큼 기준선이 낮아지므로).
 * 그래서 낙폭을 만든 고점·최저점 쌍을 강제로 남기면 줄인 곡선의 MDD가 원곡선과 **정확히 같아진다** —
 * `tests/presetprecompute.test.ts`가 이걸 검증한다.
 */
export function downsampleWeekly<T extends { date: string; equity: number }>(curve: T[]): T[] {
  if (curve.length <= 3) return curve.slice()
  const { peakIdx, troughIdx } = drawdownExtremes(curve)
  const keep = new Set<number>([0, curve.length - 1, peakIdx, troughIdx])
  for (let i = 0; i < curve.length - 1; i++) {
    if (weekBucket(curve[i + 1].date) !== weekBucket(curve[i].date)) keep.add(i)
  }
  return [...keep].sort((a, b) => a - b).map((i) => curve[i])
}

/** 자릿수를 줄여 파일 크기를 아낀다(표시용 곡선이라 원 단위 미만은 의미가 없다). */
const roundWon = (v: number) => Math.round(v)

/**
 * 실행 결과 → 산출물 한 줄.
 * 요약 수치는 **원곡선**에서, 곡선만 다운샘플해 넣는다.
 */
export function summarizePreset(
  preset: { id: string; label: string; kind: StrategyKind },
  result: PitChainResult,
  initialCapital: number,
): PrecomputedPreset {
  const raw: CurvePoint[] = result.equity.map((p) => ({
    date: p.date,
    equity: p.equity,
    benchmark: p.benchmark,
  }))
  const sampled = downsampleWeekly(raw)
  // 표준 성과 지표(schema 2)는 **다운샘플 전 원곡선·원장**에서 잰다 — 주 1점으로 줄인 곡선에서
  // 재면 일수익률이 주수익률이 되어 변동성 연환산(×√252)이 통째로 어긋난다.
  // 결합(combo)은 곡선 합성이라 원장이 귀속되지 않으므로 원장 지표는 null로 둔다(0건이 아니다).
  const perf = perfStatFields(raw, result.trades, result.cagrPct, preset.kind !== 'combo')
  return {
    ...perf,
    id: preset.id,
    label: preset.label,
    kind: preset.kind,
    mddPct: result.mddPct,
    cagrPct: result.cagrPct,
    cagr10yPct: recentCagrPct(raw, 10),
    totalPct: result.totalPct,
    alphaCagrPct: result.alphaCagrPct,
    benchCagrPct: result.benchCagrPct,
    // 결합은 두 곡선의 합성이라 체결이 어느 슬리브에도 귀속되지 않는다 —
    // 0을 넣으면 "매매가 없었다"로 읽히므로 null(귀속 불가)로 둔다.
    tradeCount: preset.kind === 'combo' ? null : result.tradeCount,
    startDate: result.startDate,
    endDate: result.endDate,
    initialCapital,
    curve: sampled.map((p) => [p.date, roundWon(p.equity), roundWon(p.benchmark)] as CurveTuple),
  }
}

export function buildPayload(
  presets: PrecomputedPreset[],
  asOf: string,
  computedAt: string,
  cost: CostSettings,
  walls: WallStats[] = [],
  /** 국내 시세 소스 메타(schema 4~). 안 넘기면 야후 전제 — 옛 호출부와 수치가 갈리지 않는다. */
  priceMeta?: Pick<PriceSourceMeta, 'source' | 'note' | 'limits'>,
  /**
   * 벤치·벽의 비교 기준(2026-08-03~). **안 넘기면 `'total'`** — 그 이전 산출물이 전부
   * 총수익 벤치로 구워졌다는 것이 사실이므로, 옛 호출부의 의미를 그대로 보존한다
   * (바로 위 `priceSource ?? 'yahoo'`와 정확히 같은 패턴).
   */
  basis?: ReturnBasis,
): PrecomputedFile {
  const source: PriceSource = priceMeta?.source ?? 'yahoo'
  const compareBasis: ReturnBasis = basis ?? 'total'
  return {
    schema: PRECOMPUTE_SCHEMA,
    asOf,
    computedAt,
    curveInterval: 'weekly',
    cost,
    priceSource: source,
    priceSourceNote: priceMeta?.note ?? `시세: Yahoo Finance chart v8 · ${KR_LOAD_NOTE}`,
    priceSourceLimits: priceMeta?.limits ? [...priceMeta.limits] : [],
    compareBasis,
    note:
      '시뮬레이터 프리셋을 화면과 같은 엔진·같은 비용으로 미리 돌린 산출물이다. ' +
      '곡선은 주 1점으로 줄였고(최저점·최종일 보존), 요약 수치는 줄이기 전 원곡선에서 쟀다. ' +
      '유니버스는 **KRX Open API 실측** 연도별 시총 상위 10+10(2010~)이다 — 랭킹이 실측이라 ' +
      '목록 선택편향은 없지만, 상장폐지 종목의 **가격**이 없어 유니버스에서 빠지므로 ' +
      '**가격 생존편향은 남아 있고** 그만큼 성적이 실제보다 후하다. ' +
      '⚠️ **2010년 이전은 수집 자체가 불가능**하다(KRX Open API 시작) — 2008 금융위기 전반부가 빠져 있어 ' +
      '2000년부터 돌던 옛 회차([추정] 목록) 수치와 직접 비교하면 거짓이다. ' +
      '⚠️ walls는 **같은 구간으로 다시 잰** 단순보유 참고선이며 알파 판정 벤치가 아니다(판정 벤치는 KODEX 200). ' +
      '34차 실측에서 35변형 중 QQQ 원화 보유의 칼마를 넘은 조합은 하나도 없었다. ' +
      '샤프·소르티노는 무위험수익률 0% 가정이라 실제 국고채 수익률만큼 낮아진다. ' +
      // 시세 소스는 **수치의 의미 자체**를 바꾼다(총수익 vs 가격수익) — 산출물이 스스로 밝힌다.
      `시세 소스: ${
        source === 'krx'
          ? 'KRX 일별 정본(원주가·분할보정 · **배당 미반영 = 가격수익**)'
          : 'Yahoo 일봉(**총수익 = 배당 재투자** · 상폐 종목 부재)'
      }. ${MIXED_SOURCE_NOTE} ` +
      // 비교 기준 — 벤치·벽이 전략과 같은 배당 기준인지 산출물이 스스로 말한다(규칙 3).
      (compareBasis === 'price'
        ? '⚖️ 비교 기준: **가격수익**(배당 제외) — 벤치(KODEX 200)와 참고 벽(QQQ)도 전략과 **같은 기준**으로 ' +
          '받았다(야후 adjclose 계수를 곱하지 않았다). 벤치의 배당수익률만큼 알파를 깎던 편향이 제거된 수치이며, ' +
          '이건 전략을 유리하게 만드는 보정이 아니라 **기울지 않은 비교**다(결과가 나빠질 수도 있다). ' +
          '⚠️ 2026-08-03 이전 산출물(compareBasis 필드가 없는 파일)의 알파는 벤치만 총수익이라 전략에 불리하게 찍혀 있었으므로 ' +
          '**직접 비교하지 마라.** 남는 한계 두 가지: ① **절대 수익률**은 양쪽에서 배당을 똑같이 뺀 값이라 ' +
          '총수익 기준 표와 나란히 놓을 수 없다. ② **결합 프리셋의 금(GLD) 슬리브는 여전히 총수익**이다 — ' +
          '슬리브는 비교 대상이 아니라 전략이 **보유하는 자산**이라 기준을 걸지 않았고, 그만큼 ' +
          '가격수익 전략 안에 총수익 자산이 섞여 있다. 레짐(시장게이트) 시계열도 **신호 입력**이라 총수익 그대로다. '
        : '⚖️ 비교 기준: **총수익**(배당 재투자) — 전략도 야후 adjclose 기반이라 벤치와 기준이 같다. ') +
      `${source === 'yahoo' ? `${KR_LOAD_NOTE} ` : ''}` +
      '매수 권유가 아니다.',
    presets,
    walls,
  }
}

// ============================================================================
// 실행
// ============================================================================

/**
 * 결합 프리셋의 옵션 슬리브(레짐·금)에 쓰는 보조 시계열.
 * 로드에 실패하면 **그 옵션만 꺼진 채** 나머지가 그대로 돈다 — 프리셋 전체를 죽이지 않는다.
 * 대신 `main()`이 경고를 남기고, 화면·산출물은 그 사실을 숨기지 않는다(규칙 3).
 */
export interface ExtraSeries {
  /** 레짐 곡선(벤치 + ^KS11 폴백 이음) — 없으면 시장게이트 미적용 */
  regime?: Curve | null
  /** 금(GLD) 원화 곡선 — 없으면 금 슬리브 미적용 */
  gold?: Curve | null
}

/** 프리셋 하나를 화면과 **같은 실행 경로**로 돌린다. */
export function runPreset(
  preset: Preset,
  histories: Record<string, DailyBar[]>,
  symOf: Record<string, string>,
  bench: DailyBar[] | undefined,
  cost: CostSettings,
  /** 실행 유니버스 — 화면과 **같은 파생 함수**가 만든 것이다(수치가 갈릴 수 없다). */
  universe: DerivedKrxUniverse,
  extra: ExtraSeries = {},
): PitChainResult {
  const resolve = (code: string) => symOf[code]
  const runCondition = (spec: StrategySpec) => {
    const extraSymbols = spec.regime && histories[spec.regime.symbol]?.length ? [spec.regime.symbol] : []
    return runPitChained(
      histories,
      (symbols) => ({ ...spec, universe: { ...spec.universe, symbols } }),
      cost,
      { resolve, bench, extraSymbols },
    )
  }
  // 구간끝 청산비용 근사(haircut)는 **켠다** — 연구 러너(idea-lab runCustomChain)가 해마다
  // 물리는 비용이고, 끄면 사전계산만 그 비용을 면제받아 성적이 낙관적으로 나온다.
  // 방향이 보수적(성적을 낮춤)이고 25차 실측 수치와 정합한다. 옵션 기본값(false)은
  // 건드리지 않는다 — 기존 테스트·다른 호출부의 동작을 바꾸지 않기 위해 호출부에서만 켠다.
  const runMomentum = (slots: number, gate: boolean, exposure?: (date: string) => number) =>
    runXsmomChained(histories, {
      cost,
      slots,
      gate,
      exposure,
      years: universe.years,
      codesFor: universe.codesFor,
      resolve,
      bench,
      applyLiquidationHaircut: true,
    })

  if (preset.kind === 'condition') return runCondition(preset.spec)
  if (preset.kind === 'momentum') return runMomentum(preset.mom.slots, preset.mom.gate)
  // 시장게이트는 **슬리브 B를 돌릴 때** 노출 훅으로 들어간다 — 곡선을 나중에 손보지 않는다.
  // 그래야 게이트 달의 청산 비용·다음 달 재매수 비용이 성적에 실린다(정본과 같은 산술).
  const regime = preset.marketGate === true ? (extra.regime ?? null) : null
  const gateOf = regime && regime.length >= 2 ? makeMarketGateExposure(regime) : undefined
  const chainA = runCondition(preset.spec)
  const chainB = runMomentum(preset.mom.slots, preset.mom.gate, gateOf)
  if (chainA.equity.length === 0 || chainB.equity.length === 0)
    throw new Error(`결합할 슬리브 곡선이 비었습니다 (${preset.id})`)
  // 금이 꺼져 있으면 `composeCombo`는 `blendChainResults` 한 번과 **완전히 같다** —
  // 그래서 기존 결합 프리셋(combo-50 · combo-25-75)의 수치는 한 자리도 바뀌지 않는다.
  const goldW = normalizeGoldW(preset.goldW)
  return composeCombo({
    chainA,
    chainB,
    wA: preset.wA,
    capital: cost.initialCapital,
    gold: goldW > 0 ? (extra.gold ?? null) : null,
    goldW,
  }).result
}

/**
 * KRX 실측 유니버스 파일을 읽어 파생한다(파일 직접 읽기 — 스크립트 경로).
 * **[추정] 목록으로 폴백하지 않는다** — 못 읽으면 굽기를 중단한다(33차 재발 방지).
 */
export function loadKrxUniverseFile(rootDir: string): DerivedKrxUniverse {
  const path = join(rootDir, KRX_PIT_PATH)
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch (e) {
    throw new Error(
      `KRX 실측 유니버스(${path})를 읽지 못했습니다 — 사전계산을 중단합니다. ` +
        `[추정] 목록으로 대신 굽지 않습니다(33차에서 [추정] 목록발 알파가 무너졌습니다). (${String(e)})`,
    )
  }
  return deriveKrxUniverse(parseKrxPitUniverse(raw), DEFAULT_KRX_TOP_N)
}

/**
 * 노드용 KRX 정본 의존성 — 리포에 커밋된 `public/data/krx-daily/*`를 직접 읽는다.
 * 파일이 없으면 **null**을 돌려주고(어댑터가 "EC2 수집이 아직 안 끝났습니다"로 번역),
 * 그 외 읽기 오류는 그대로 던진다. 야후로 조용히 내려가지 않는다.
 */
export function nodeKrxDeps(rootDir: string): KrxPriceDeps {
  const read = (rel: string): unknown | null => {
    const path = join(rootDir, KRX_DAILY_DIR, rel)
    try {
      return JSON.parse(readFileSync(path, 'utf8'))
    } catch (e) {
      // 파일 없음(ENOENT)만 "아직 없다"로 본다 — JSON 깨짐은 진짜 오류다.
      if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return null
      throw new Error(`${path} 읽기 실패: ${String(e)}`)
    }
  }
  return {
    readIndex: async () => read('index.json'),
    readStock: async (_code, file) => read(file),
  }
}

async function main(): Promise<void> {
  log('# 프리셋 사전계산 — 화면과 같은 엔진으로 전 프리셋 실행')

  // ---- 유니버스(KRX 실측) — 화면과 같은 파생 함수로 만든다 ----
  const universe = loadKrxUniverseFile(root)
  log(`⚠️ ${universe.sourceNote}`)
  log(
    `유니버스 ${universe.label} · 실행 연도 ${universe.years[0]}~${universe.years[universe.years.length - 1]}` +
      ` (${universe.years.length}년) · 시세 구간 ${RANGE}`,
  )
  log(`프리셋 ${PRESETS.length}종 — ${PRESETS.map((p) => p.id).join(', ')}`)

  // ---- 시세 로딩 — **어댑터 하나**로 소스를 고른다(화면과 같은 함수) ----
  //
  // 야후: 화면·연구 러너와 같은 듀얼 소스 규약(.KQ/.KS 둘 다 · 긴 이력 채택 · 200봉 게이트).
  // KRX : 리포에 커밋된 일별 정본(원주가 → 수정주가 보정). **데이터가 없으면 던진다** —
  //        야후로 조용히 내려가면 총수익/가격수익이 섞인 표가 나온다.
  const priceSource = priceSourceFromEnv(process.env)
  log(`시세 소스: ${priceSource}${priceSource === 'yahoo' ? ' (기본 · PRICE_SOURCE=krx로 전환)' : ' (PRICE_SOURCE=krx)'}`)
  // 비교 기준을 **여기 한 곳에서** 정한다. 벤치와 벽이 각자 다른 기준으로 로드되면 같은 표 안에서
  // 배당이 섞이고, 그 차이는 알파 몇 %p로 조용히 흡수된다.
  const basis = compareBasisFor(priceSource)
  setCompareBasis(basis)
  log(`⚖️ ${compareBasisNote(basis)}`)
  if (basis === 'price')
    log(
      '   ↑ 2026-08-03 이전 산출물(compareBasis 필드가 없는 파일)의 알파는 **벤치만 총수익**이라 전략에 불리하게 찍혀 있었다 — ' +
        '그 수치와 직접 비교하지 마라. 이건 전략을 유리하게 만드는 보정이 아니라 기울지 않은 비교이며, ' +
        '결과가 나빠질 수도 있다.',
    )
  const load = await loadKrPrices(universe.union, priceSource, {
    // 동시성 1 = 기존 순차 로딩 그대로(유량 제한 안쪽). 수치는 한 자리도 바뀌지 않는다.
    yahoo: { fetchDaily: (sym) => fetchDaily(sym), betweenAttempts: () => sleep(120), concurrency: 1 },
    krx: nodeKrxDeps(root),
  })
  const histories: Record<string, DailyBar[]> = load.histories
  const symOf: Record<string, string> = load.symOf
  const failed = load.failed
  const okCount = load.meta.loaded
  log(
    priceSource === 'yahoo'
      ? `시세 로드 ${okCount}/${universe.union.length} · .KQ/.KS 긴 이력 채택 · ${KR_MIN_BARS}봉 미만 제외` +
          `${failed.length ? ` · 가격 없음(상장폐지·짧은 응답): ${failed.join(', ')}` : ''}`
      : `시세 로드 ${okCount}/${universe.union.length} · KRX 일별 정본(수정주가 적용)` +
          `${failed.length ? ` · 수집 범위 밖: ${failed.join(', ')}` : ''}`,
  )
  log(`  ${load.meta.note}`)
  for (const l of load.meta.limits) log(`  ⚠️ ${l}`)
  log(`  ⚠️ ${MIXED_SOURCE_NOTE}`)
  if (failed.length)
    log('  ↑ 랭킹은 실측이라 선택편향이 없지만, 빠진 종목만큼 표본이 줄어든다 — 그 방향은 성적을 후하게 만든다.')
  if (okCount === 0) throw new Error(`시세를 하나도 받지 못했습니다 — ${priceSource} 응답을 확인하세요`)

  // ---- 벤치마크(KODEX 200) — 알파 판정 기준(규칙 5) ----
  //
  // 벤치는 **비교 대상**이므로 COMPARE_BASIS를 따른다(KRX 소스면 가격수익).
  let bench: DailyBar[] | undefined
  try {
    const b = await fetchCompare(BENCH_SYMBOL)
    if (b.length >= 2) bench = b
  } catch {
    /* 아래에서 경고 */
  }
  if (!bench) log('⚠️ 벤치마크(KODEX 200) 로드 실패 — 알파는 null로 굽습니다')
  else
    log(
      `벤치마크 ${BENCH_SYMBOL} ${bench.length}봉 · ` +
        `${basis === 'price' ? '가격수익(배당 제외 — 전략과 같은 기준)' : '총수익(배당 재투자)'}`,
    )

  /**
   * 시장게이트가 보는 레짐 벤치. **비교 기준과 무관하게 항상 총수익**이다 —
   * 레짐은 비교 대상이 아니라 **신호 입력**이라서, 여기에 기준을 걸면 배당 비대칭 제거가
   * 전략 행동까지 바꿔 버린다. 이번 변경은 "무엇과 비교하는가"만 건드린다.
   * 총수익 모드(야후 경로)에서는 위 벤치와 같은 값이라 **추가 호출이 아예 없다.**
   */
  let benchRegime: DailyBar[] | undefined = bench
  const needGate = PRESETS.some((p) => p.kind === 'combo' && p.marketGate === true)
  const needGold = PRESETS.some((p) => p.kind === 'combo' && normalizeGoldW(p.goldW) > 0)
  if (basis === 'price' && needGate && bench) {
    await sleep(120)
    try {
      const rb = await fetchDaily(BENCH_SYMBOL) // 기본값 total — 신호 입력이라 기준을 따르지 않는다
      benchRegime = rb.length >= 2 ? rb : undefined
    } catch {
      benchRegime = undefined
    }
    log(
      benchRegime
        ? `레짐용 벤치: ${BENCH_SYMBOL} **총수익** ${benchRegime.length}봉 — 신호 입력이라 비교 기준을 따르지 않는다.`
        : `⚠️ 레짐용 벤치(${BENCH_SYMBOL} · 총수익) 로드 실패 — 시장게이트 없이 굽습니다(가격수익 벤치로 대신하지 않습니다).`,
    )
  }

  // ---- 레짐 지수 — 프리셋 중 regime을 쓰는 것이 있으면 함께 받는다 ----
  // ⚠️ 이 계열은 **신호 입력**이라 비교 기준을 따르지 않는다(기본 total 그대로).
  const regimeSymbols = new Set<string>()
  for (const p of PRESETS) if (p.kind !== 'momentum' && p.spec.regime) regimeSymbols.add(p.spec.regime.symbol)
  for (const sym of regimeSymbols) {
    try {
      const rb = await fetchDaily(sym)
      if (rb.length > 0) histories[sym] = rb
      else log(`⚠️ 레짐 지수(${sym}) 데이터가 비었습니다`)
    } catch {
      log(`⚠️ 레짐 지수(${sym}) 로드 실패 — 그 프리셋은 진입이 발생하지 않습니다`)
    }
  }

  // ---- 결합 옵션 슬리브 — 시장게이트용 레짐 곡선 · 금(GLD) 원화 곡선 ----
  //
  // 32차 프리셋(calmar-max)만 쓰는 계열이다. 필요한 프리셋이 없으면 아예 받지 않는다.
  // 하나라도 실패하면 **그 옵션만** 꺼지고 나머지는 그대로 돈다(경고를 남긴다).
  // needGate·needGold는 위 벤치 절에서 이미 정했다(레짐용 총수익 벤치를 받을지 판단해야 했다).
  const extra: ExtraSeries = {}
  if (needGate) {
    if (!benchRegime) log('⚠️ 벤치가 없어 시장게이트 레짐을 만들 수 없습니다 — 게이트 없이 실행합니다')
    else {
      let fb: DailyBar[] = []
      try {
        // 폴백 지수도 **신호 입력**이라 총수익 그대로다(비교 기준을 따르지 않는다).
        fb = await fetchDaily(REGIME_FALLBACK_SYMBOL)
      } catch {
        log(`⚠️ 레짐 폴백(${REGIME_FALLBACK_SYMBOL}) 로드 실패 — 벤치 구간만으로 게이트를 판정합니다`)
      }
      const spliced = spliceRegimeCurve(benchRegime, fb)
      extra.regime = spliced.length >= 2 ? spliced : null
      log(
        `레짐 판정 시계열: ${BENCH_SYMBOL}${fb.length ? ` + ${REGIME_FALLBACK_SYMBOL} 폴백(수익률만 이어 붙임 · 이음매 레벨 정합)` : ''}` +
          ` · ${spliced.length}점 (${spliced[0]?.date ?? '—'}~)`,
      )
    }
  }
  if (needGold) {
    try {
      // ⚠️ 금(GLD)은 **비교 대상이 아니라 전략이 보유하는 자산**이다 — 기준을 걸지 않는다
      //    (총수익 그대로). 그래서 가격수익 모드에서는 "가격수익 전략에 총수익 슬리브가 섞여
      //    있다"는 편향이 남는다. 숨기지 않고 산출물 note와 아래 로그에 한 줄로 남긴다(규칙 3).
      const gld = await fetchDaily(GOLD_SYMBOL)
      await sleep(120)
      // 환율(KRW=X)은 배당 개념이 없어 adjclose가 close와 같다 → 계수가 항상 1이라 기준과 무관하다.
      const fx = await fetchDaily(FX_SYMBOL)
      const curve = toKrwCurve(gld, fx)
      if (curve.length >= 2) {
        extra.gold = curve
        log(
          `금 슬리브: ${GOLD_SYMBOL} ${gld.length}봉 · 환율 ${fx.length}봉 → 원화 곡선 ${curve.length}점 ` +
            `(${curve[0].date}~${curve[curve.length - 1].date}) · 결측일 직전 환율 이월 · 환헤지 없음`,
        )
        if (basis === 'price')
          log(
            `⚠️ 한계: 금 슬리브(${GOLD_SYMBOL})는 **총수익**(배당·분배금 재투자) 그대로다 — 슬리브는 비교 대상이 ` +
              '아니라 전략이 보유하는 자산이라 기준을 걸지 않았다. 그만큼 **가격수익 전략 안에 총수익 자산이 ' +
              '섞여 있다**(결합 프리셋의 금 비중만큼 성적이 후해진다).',
          )
      } else log(`⚠️ ${GOLD_SYMBOL} 원화 환산 실패(환율 구간 불일치) — 금 슬리브 없이 실행합니다`)
    } catch (e) {
      log(`⚠️ ${GOLD_SYMBOL}·${FX_SYMBOL} 로드 실패 — 금 슬리브 없이 실행합니다 (${String(e)})`)
    }
  }

  // ---- asOf = 실제로 받은 데이터의 마지막 거래일 ----
  let asOf = ''
  for (const bars of [...Object.values(histories), ...(bench ? [bench] : [])]) {
    const last = bars.length ? bars[bars.length - 1].date : ''
    if (last > asOf) asOf = last
  }

  // ---- 프리셋 실행 ----
  const cost = DEFAULT_COST
  const out: PrecomputedPreset[] = []
  for (const preset of PRESETS) {
    const t0 = Date.now()
    const result = runPreset(preset, histories, symOf, bench, cost, universe, extra)
    const row = summarizePreset(preset, result, cost.initialCapital)
    out.push(row)
    log(
      `· ${preset.id.padEnd(14)} 총 ${row.totalPct.toFixed(0)}% · CAGR ${row.cagrPct.toFixed(1)}% · ` +
        `10y ${row.cagr10yPct != null ? `${row.cagr10yPct.toFixed(1)}%` : '—'} · MDD ${row.mddPct.toFixed(1)}% · ` +
        `알파 ${row.alphaCagrPct != null ? `${row.alphaCagrPct.toFixed(1)}%p` : '—'} · ` +
        `변동성 ${row.volAnnPct != null ? `${row.volAnnPct.toFixed(1)}%` : '—'} · ` +
        `샤프 ${row.sharpe != null ? row.sharpe.toFixed(2) : '—'} · ` +
        `최장낙폭 ${row.maxDdDays != null ? `${row.maxDdDays}일${row.maxDdRecovered === false ? '(미회복)' : ''}` : '—'} · ` +
        `곡선 ${result.equity.length}→${row.curve.length}점 · ${((Date.now() - t0) / 1000).toFixed(1)}s`,
    )
  }

  // ---- 참고 벽 — 전략과 **같은 구간으로 다시 잰다** (34차 규약) ----------------
  //
  // 옮겨 적은 수치를 두면 구간이 다른 칼마를 나란히 놓게 되고 그 비교는 거짓이 된다.
  // 실패해도 굽기를 막지 않는다 — 벽 없이 구우면 화면이 34차 상수로 강등한다(규칙 3).
  const walls: WallStats[] = []
  if (out.length > 0) {
    const from = out.reduce((a, p) => (p.startDate < a ? p.startDate : a), out[0].startDate)
    const to = out.reduce((a, p) => (p.endDate > a ? p.endDate : a), out[0].endDate)
    log(`\n참고 벽 구간 ${from} ~ ${to} — 전략 실행 구간으로 잘라 다시 잰다(옮겨 적은 값이 아니다).`)
    try {
      // QQQ 벽도 비교 대상이다 — 전략이 가격수익인데 벽만 배당 재투자면 벽이 부당하게 높아진다.
      const q = await fetchCompare(QQQ_SYMBOL)
      await sleep(120)
      // 환율(KRW=X)은 **배당 개념이 없어** adjclose가 close와 같다 → 계수가 항상 1이다.
      // 기준을 걸든 안 걸든 같은 값이라 여기는 기본(total)로 둔다(무관함을 코드로 남긴다).
      const fx = await fetchDaily(FX_SYMBOL)
      const krw = toKrwCurve(q, fx)
      const w = wallStats('qqqKrw', 'QQQ 원화 보유', krw, from, to)
      if (w) walls.push(w)
      else log('⚠️ QQQ 원화 곡선이 구간과 겹치지 않습니다 — 벽 없이 굽습니다')
    } catch (e) {
      log(`⚠️ QQQ·환율 로드 실패 — QQQ 벽 없이 굽습니다 (${String(e)})`)
    }
    if (bench) {
      const bc = bench.filter((b) => b.c > 0).map((b) => ({ date: b.date, equity: b.c }))
      const w = wallStats('benchKr', `${BENCH_SYMBOL} KODEX 200 보유`, bc, from, to)
      if (w) walls.push(w)
    }
    for (const w of walls)
      log(
        `· 벽 ${w.label.padEnd(24)} 칼마 ${w.calmar.toFixed(3)} · CAGR ${w.cagrPct.toFixed(1)}% · ` +
          `MDD ${w.mddPct.toFixed(1)}% · ${w.startDate}~${w.endDate}`,
      )
    const qqq = walls.find((w) => w.kind === 'qqqKrw')
    if (qqq) {
      const over = out.filter((p) => Math.abs(p.mddPct) > 1e-9 && p.cagrPct / Math.abs(p.mddPct) > qqq.calmar)
      log(
        over.length === 0
          ? `→ QQQ 원화 보유 벽(칼마 ${qqq.calmar.toFixed(3)})을 넘은 프리셋: **없음** (34차 결론과 같다)`
          : `→ QQQ 벽을 넘은 프리셋: ${over.map((p) => p.id).join(', ')}`,
      )
    }
  }

  const payload = buildPayload(out, asOf, new Date().toISOString(), cost, walls, load.meta, basis)
  mkdirSync(dirname(OUT_PATH), { recursive: true })
  writeFileSync(OUT_PATH, `${JSON.stringify(payload)}\n`, 'utf8')
  log(
    `\n✅ ${OUT_PATH} · 프리셋 ${out.length}개 · 참고 벽 ${walls.length}개 · asOf ${asOf} · ` +
      `시세 소스 ${payload.priceSource} · 비교 기준 ${payload.compareBasis} · schema ${payload.schema}`,
  )
  log(
    '⚠️ 랭킹은 KRX 실측이라 목록 선택편향이 없지만 **가격 생존편향(상폐 종목 시세 부재)은 남아 있고**, ' +
      '2010년 이전은 수집 자체가 불가능하다(2008 위기 전반부 부재). 매수 권유가 아니다.',
  )
}

// 런처(scripts/preset-precompute.mjs)만 이 값을 넘긴다.
// 테스트가 이 모듈을 import할 때는 자동 실행되지 않는다.
if (process.env.PRESET_PRECOMPUTE_RUN === '1') {
  main().catch((e) => {
    console.error('실행 실패:', e)
    process.exit(1)
  })
}
