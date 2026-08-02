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
// 실행: node scripts/preset-precompute.mjs   (GHA backtest.yml MODE=presets)

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { CostSettings } from '../src/features/backtest/conditionScreen'
import { annualize, runPitChained, yearsBetween, type PitChainResult } from '../src/features/backtest/pitChain'
import { runXsmomChained } from '../src/features/backtest/xsmomChain'
import { blendChainResults } from '../src/features/backtest/comboBlend'
import { PIT_UNION, PIT_YEARS, pitCodes } from '../src/features/backtest/pitUniverse'
import { BENCH_SYMBOL, DEFAULT_COST, PRESETS, type Preset, type StrategyKind } from '../src/features/backtest/presets'
import type { StrategySpec } from '../src/features/backtest/strategySpec'
import type { DailyBar } from '../src/features/backtest/types'
import { KR_LOAD_NOTE, KR_MIN_BARS, loadKrDual } from '../src/lib/history'

// CJS 번들에서 import.meta.url이 없으므로 런처가 REPO_ROOT를 넘긴다.
const root = process.env.REPO_ROOT ?? process.cwd()
const OUT_PATH = join(root, 'public', 'data', 'presets-precomputed.json')

/** 산출물 스키마 버전 — 화면이 모르는 버전이면 무시하고 우아하게 강등한다. */
export const PRECOMPUTE_SCHEMA = 1

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
const RANGE = 'since:1999-01-01'

function log(msg: string) {
  console.log(msg)
}

// ============================================================================
// 데이터 로더 — spec-backtest.entry.ts / idea-lab.entry.ts와 같은 방식
// ============================================================================

async function fetchDaily(symbol: string, range = RANGE): Promise<DailyBar[]> {
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

export interface PrecomputedPreset {
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
  return {
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
): PrecomputedFile {
  return {
    schema: PRECOMPUTE_SCHEMA,
    asOf,
    computedAt,
    curveInterval: 'weekly',
    cost,
    note:
      '시뮬레이터 프리셋을 화면과 같은 엔진·같은 비용으로 미리 돌린 [추정] 산출물이다. ' +
      '곡선은 주 1점으로 줄였고(최저점·최종일 보존), 요약 수치는 줄이기 전 원곡선에서 쟀다. ' +
      '유니버스는 연도별 시총 상위 10+10 [추정]이며 상장폐지 종목의 가격 부재로 생존편향이 남아 있다. ' +
      `${KR_LOAD_NOTE} ` +
      '매수 권유가 아니다.',
    presets,
  }
}

// ============================================================================
// 실행
// ============================================================================

/** 프리셋 하나를 화면과 **같은 실행 경로**로 돌린다. */
export function runPreset(
  preset: Preset,
  histories: Record<string, DailyBar[]>,
  symOf: Record<string, string>,
  bench: DailyBar[] | undefined,
  cost: CostSettings,
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
  const runMomentum = (slots: number, gate: boolean) =>
    runXsmomChained(histories, {
      cost,
      slots,
      gate,
      years: PIT_YEARS,
      codesFor: pitCodes,
      resolve,
      bench,
      applyLiquidationHaircut: true,
    })

  if (preset.kind === 'condition') return runCondition(preset.spec)
  if (preset.kind === 'momentum') return runMomentum(preset.mom.slots, preset.mom.gate)
  const chainA = runCondition(preset.spec)
  const chainB = runMomentum(preset.mom.slots, preset.mom.gate)
  if (chainA.equity.length === 0 || chainB.equity.length === 0)
    throw new Error(`결합할 슬리브 곡선이 비었습니다 (${preset.id})`)
  return blendChainResults(chainA, chainB, preset.wA, cost.initialCapital)
}

async function main(): Promise<void> {
  log('# 프리셋 사전계산 — 화면과 같은 엔진으로 전 프리셋 실행')
  log(`유니버스 ${PIT_UNION.length}종목 · 연도 ${PIT_YEARS[0]}~${PIT_YEARS[PIT_YEARS.length - 1]} · 구간 ${RANGE}`)

  // ---- 시세 로딩 — 화면·연구 러너와 **같은 듀얼 소스 규약**(.KQ/.KS 둘 다 · 긴 이력 채택 · 200봉 게이트) ----
  const histories: Record<string, DailyBar[]> = {}
  const symOf: Record<string, string> = {}
  const failed: string[] = []
  for (const code of PIT_UNION) {
    const picked = await loadKrDual(code, (sym) => fetchDaily(sym), (bars) => bars.length, {
      betweenAttempts: () => sleep(120),
    })
    if (picked) {
      histories[picked.symbol] = picked.value
      symOf[code] = picked.symbol
    } else failed.push(code)
  }
  const okCount = Object.keys(symOf).length
  log(
    `시세 로드 ${okCount}/${PIT_UNION.length} · .KQ/.KS 긴 이력 채택 · ${KR_MIN_BARS}봉 미만 제외` +
      `${failed.length ? ` · 가격 없음(상장폐지·짧은 응답): ${failed.join(', ')}` : ''}`,
  )
  if (okCount === 0) throw new Error('시세를 하나도 받지 못했습니다 — Yahoo 응답을 확인하세요')

  // ---- 벤치마크(KODEX 200) — 알파 판정 기준(규칙 5) ----
  let bench: DailyBar[] | undefined
  try {
    const b = await fetchDaily(BENCH_SYMBOL)
    if (b.length >= 2) bench = b
  } catch {
    /* 아래에서 경고 */
  }
  if (!bench) log('⚠️ 벤치마크(KODEX 200) 로드 실패 — 알파는 null로 굽습니다')

  // ---- 레짐 지수 — 프리셋 중 regime을 쓰는 것이 있으면 함께 받는다 ----
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
    const result = runPreset(preset, histories, symOf, bench, cost)
    const row = summarizePreset(preset, result, cost.initialCapital)
    out.push(row)
    log(
      `· ${preset.id.padEnd(14)} 총 ${row.totalPct.toFixed(0)}% · CAGR ${row.cagrPct.toFixed(1)}% · ` +
        `10y ${row.cagr10yPct != null ? `${row.cagr10yPct.toFixed(1)}%` : '—'} · MDD ${row.mddPct.toFixed(1)}% · ` +
        `알파 ${row.alphaCagrPct != null ? `${row.alphaCagrPct.toFixed(1)}%p` : '—'} · ` +
        `곡선 ${result.equity.length}→${row.curve.length}점 · ${((Date.now() - t0) / 1000).toFixed(1)}s`,
    )
  }

  const payload = buildPayload(out, asOf, new Date().toISOString(), cost)
  mkdirSync(dirname(OUT_PATH), { recursive: true })
  writeFileSync(OUT_PATH, `${JSON.stringify(payload)}\n`, 'utf8')
  log(`\n✅ ${OUT_PATH} · 프리셋 ${out.length}개 · asOf ${asOf}`)
  log('⚠️ [추정] 산출물 — 생존편향(상폐 종목 가격 부재)·결합의 리밸런스 비용 미반영이 그대로 남아 있다. 매수 권유가 아니다.')
}

// 런처(scripts/preset-precompute.mjs)만 이 값을 넘긴다.
// 테스트가 이 모듈을 import할 때는 자동 실행되지 않는다.
if (process.env.PRESET_PRECOMPUTE_RUN === '1') {
  main().catch((e) => {
    console.error('실행 실패:', e)
    process.exit(1)
  })
}
