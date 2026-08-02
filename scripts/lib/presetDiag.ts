// 프리셋 사전계산 ↔ 연구 러너 수치 괴리 진단 — **순수 로직 정본**.
//
// 배경 (2026-08-02 실측, 같은 날·같은 Yahoo):
//   | 프리셋 | 연구 러너 | 사전계산(MODE=presets) | 배율 |
//   | pit-maxratio | 총 +5,442% | 총 +558% | ~10× |
//   | xsmom-5-gate | 총 +118,704% | 총 +28,784% | ~4× |
//   | combo-50     | 총 +32,525% | 총 +5,234% | ~6× |
//   전 프리셋이 일제히 낮다 = 체계적 차이지 우연이 아니다. 사전계산은 "화면과 같은 엔진·같은
//   fetch"를 표방하므로, 화면이 원래부터 연구와 다른 수치를 보여주고 있었을 가능성이 크다.
//
// 이 파일은 **진단만** 한다 — 아무것도 고치지 않는다(원인 확정 후 별도 지시).
//
// 왜 별도 모듈인가: `scripts/spec-backtest.entry.ts`는 import 시점에 모드를 즉시 실행하므로
//   테스트가 import할 수 없다. 네트워크·출력은 엔트리에 두고, **판정 로직 전부**를 여기
//   순수 함수로 내려 `tests/presetdiag.test.ts`가 합성 데이터로 검증한다.
//   (컨테이너는 Yahoo 403이라 실행은 GHA 몫이고, 로직 자체는 여기서 못 박는다.)
//
// 규칙 1(미래참조 금지)과의 관계: 이 모듈은 백테스트 **결과를 비교**할 뿐 판정에 되먹이지
//   않는다. 2×2 재실행은 정본 엔진(runPitChained·runXsmomChained)을 그대로 부르므로
//   인과성은 그 엔진의 절단 불변성 테스트가 이미 집행한다.

import { runPitChained, type PitChainResult } from '../../src/features/backtest/pitChain'
import { runXsmomChained } from '../../src/features/backtest/xsmomChain'
import type { CostSettings } from '../../src/features/backtest/conditionScreen'
import type { StrategySpec } from '../../src/features/backtest/strategySpec'
import type { DailyBar } from '../../src/features/backtest/types'

// ============================================================================
// ① 시세 로드 규약 대조 — 두 경로가 **같은 코드에서 다른 계열을 채택**하는가
// ============================================================================
//
// 연구 러너 `fetchKrDual`  (scripts/spec-backtest.entry.ts:1383 · scripts/idea-lab.entry.ts:136)
//   접미사 순서 .KQ → .KS · 둘을 비교해 **긴 이력을 채택** · 200봉 미만이면 **채택 자체를 포기**
//   (단 .KQ가 이미 200봉 이상이면 거기서 끊고 .KS는 아예 조회하지 않는다)
// 사전계산 로더 (scripts/preset-precompute.entry.ts main())
//   접미사 순서 .KS → .KQ · **첫 성공(1봉 이상)에서 중단** · 길이 하한 없음
//
// 두 규약은 코스닥→코스피 이전 종목(예: 이전 상장 코드)에서 갈릴 수 있다.
// 그 경우 시작일이 밀리고, 시작일이 밀리면 `bars[0].date <= {해}-06-30` 편입 판정에서
// **그 해 유니버스에서 통째로 빠진다** — 종목이 빠지는 해가 곧 성적 차이다.

/** 연구 러너가 접미사를 시도하는 순서 */
export const RESEARCH_SUFFIX_ORDER: readonly string[] = ['.KQ', '.KS']
/** 사전계산이 접미사를 시도하는 순서 */
export const PRECOMPUTE_SUFFIX_ORDER: readonly string[] = ['.KS', '.KQ']
/** 연구 러너 `fetchKrDual`의 최소 봉 수 게이트 */
export const RESEARCH_MIN_BARS = 200

/** 한 (코드, 접미사, 구간) 조회 결과 요약. `ok=false`면 요청이 실패(HTTP·파싱)한 것이다. */
export interface SuffixProbe {
  /** 조회한 심볼 — '005930.KS' */
  sym: string
  /** '.KS' | '.KQ' */
  suffix: string
  /** 요청 구간 — 'since:1999-01-01' 등 */
  range: string
  ok: boolean
  bars: number
  /** 첫 봉 날짜. 봉이 없으면 '' */
  start: string
  /**
   * **공통 창의 첫 봉 날짜** — 두 경로의 요청 구간이 다르므로(1999 vs 2000) 시작일을 그냥
   * 비교하면 "구간이 달라서 다른 것"과 "계열이 달라서 다른 것"이 섞인다. 그래서 사전계산
   * 구간 시작일 이후의 첫 봉을 따로 담아 **같은 잣대로** 비교한다.
   * (사전계산 쪽은 요청 구간이 이미 그 하한이라 보통 `start`와 같다.)
   */
  startAtOrAfter: string
  /** 마지막 봉 날짜. 봉이 없으면 '' */
  end: string
  /** adjclose가 실려 온 봉 수 — 0이면 배당 보정이 통째로 계수 1로 폴백했다는 뜻 */
  adjBars: number
  /** adj/close 계수가 1이 아닌 봉 수 — **실제로 보정이 걸린** 봉 */
  adjNonUnitBars: number
  /** 실패 사유(성공이면 '') */
  error: string
}

export const emptyProbe = (sym: string, suffix: string, range: string, error: string): SuffixProbe => ({
  sym,
  suffix,
  range,
  ok: false,
  bars: 0,
  start: '',
  startAtOrAfter: '',
  end: '',
  adjBars: 0,
  adjNonUnitBars: 0,
  error,
})

type ProbeMap = Record<string, SuffixProbe | undefined>

/**
 * 연구 러너 `fetchKrDual`의 채택 규칙을 그대로 옮긴 것.
 * .KQ → .KS 순으로 보며 **더 긴 쪽**을 남기고, 200봉 이상을 만나면 그 자리에서 끊는다.
 * 최종 후보가 200봉 미만이면 **null**(= 그 코드는 유니버스에 없는 것으로 취급).
 */
export function pickResearch(bySuffix: ProbeMap): SuffixProbe | null {
  let best: SuffixProbe | null = null
  for (const suffix of RESEARCH_SUFFIX_ORDER) {
    const p = bySuffix[suffix]
    if (!p || !p.ok) continue // 조회 실패 → 다음 접미사
    if (!best || p.bars > best.bars) best = p
    if (p.bars >= RESEARCH_MIN_BARS) break // 여기서 끊는다 — 뒤 접미사는 **조회조차 하지 않는다**
  }
  return best && best.bars >= RESEARCH_MIN_BARS ? best : null
}

/**
 * 사전계산 로더의 채택 규칙을 그대로 옮긴 것.
 * .KS → .KQ 순으로 보며 **1봉이라도 받으면 즉시 확정**한다. 길이 비교도, 하한도 없다.
 */
export function pickPrecompute(bySuffix: ProbeMap): SuffixProbe | null {
  for (const suffix of PRECOMPUTE_SUFFIX_ORDER) {
    const p = bySuffix[suffix]
    if (!p || !p.ok) continue
    if (p.bars > 0) return p
  }
  return null
}

/** 채택된 계열이 그 해 유니버스 편입 판정을 통과하는 해 목록 (`bars[0].date <= {해}-06-30`). */
export function universeYears(
  picked: SuffixProbe | null,
  years: number[],
  inYearList: (year: number) => boolean,
): number[] {
  if (!picked || !picked.start) return []
  return years.filter((y) => inYearList(y) && picked.start <= `${y}-06-30`)
}

export interface LoadDiffRow {
  code: string
  research: SuffixProbe | null
  precompute: SuffixProbe | null
  /** 무엇이 달랐나 — '채택심볼' · '봉수' · '시작일' · '배당보정' · '한쪽만 채택' */
  reasons: string[]
  /** 연구에서만 유니버스에 드는 해 */
  yearsOnlyResearch: number[]
  /** 사전계산에서만 유니버스에 드는 해 */
  yearsOnlyPrecompute: number[]
}

/**
 * 한 코드의 두 로드 결과를 대조한다. **완전히 같으면 null**(표에 안 찍는다).
 *
 * 시작일 비교는 `startAtOrAfter`(공통 창의 첫 봉)로 한다 — 요청 구간이 서로 다른 데서
 * 오는 당연한 차이를 원인으로 잘못 세지 않기 위함이다.
 */
export function diffLoad(
  code: string,
  research: SuffixProbe | null,
  precompute: SuffixProbe | null,
  years: number[],
  inYearList: (year: number) => boolean,
): LoadDiffRow | null {
  const reasons: string[] = []
  if (!research !== !precompute) reasons.push('한쪽만 채택')
  if (research && precompute) {
    if (research.sym !== precompute.sym) reasons.push('채택심볼')
    if (research.startAtOrAfter !== precompute.startAtOrAfter) reasons.push('시작일')
    if (research.end !== precompute.end) reasons.push('종료일')
    const rAdj = research.adjBars > 0
    const pAdj = precompute.adjBars > 0
    if (rAdj !== pAdj) reasons.push('배당보정')
  }
  const yr = universeYears(research, years, inYearList)
  const yp = universeYears(precompute, years, inYearList)
  const setP = new Set(yp)
  const setR = new Set(yr)
  const yearsOnlyResearch = yr.filter((y) => !setP.has(y))
  const yearsOnlyPrecompute = yp.filter((y) => !setR.has(y))
  if (yearsOnlyResearch.length || yearsOnlyPrecompute.length) reasons.push('편입연도')
  if (reasons.length === 0) return null
  return { code, research, precompute, reasons, yearsOnlyResearch, yearsOnlyPrecompute }
}

// ============================================================================
// ② 스펙 diff — 두 스펙 객체가 정말 같은 전략인가
// ============================================================================
//
// presets.ts `pitPreset`은 `HEROMOON_MOMENTUM.universe`를 복사해 쓴다. 거기에 거래대금
// 하한·시총 제한 같은 추가 제약이 숨어 있으면 연구(pit1010 `specOf`)와 **다른 전략**이 된다.
// 눈으로 보지 말고 필드 단위로 찍는다.

export type JsonVal = null | boolean | number | string | JsonVal[] | { [k: string]: JsonVal }

/**
 * 비교 가능한 형태로 정규화한다 — `undefined` 필드는 **없는 것과 같게** 버리고,
 * 객체 키는 정렬한다. `null`은 버리지 않는다(`regime: null`과 `regime` 부재는 다른 표기이므로
 * 표에 드러나야 한다 — 엔진 동작은 같더라도 diff가 그것을 숨기면 안 된다).
 */
export function normalizeSpec(v: unknown): JsonVal {
  if (v === null) return null
  if (Array.isArray(v)) return v.map((x) => normalizeSpec(x))
  if (typeof v === 'object') {
    const src = v as Record<string, unknown>
    const out: { [k: string]: JsonVal } = {}
    for (const k of Object.keys(src).sort()) {
      if (src[k] === undefined) continue
      out[k] = normalizeSpec(src[k])
    }
    return out
  }
  if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') return v
  // 함수·심볼 등 비교 불가 타입은 자리표시자로 남긴다(조용히 사라지면 diff가 거짓말을 한다)
  return `[${typeof v}]`
}

export interface SpecDiffRow {
  path: string
  left: string
  right: string
}

const MISSING = '(없음)'
const show = (v: JsonVal | undefined): string => (v === undefined ? MISSING : JSON.stringify(v))

/** 정규화된 두 값의 **다른 잎(leaf)만** 경로와 함께 뽑는다. */
export function diffJson(a: JsonVal | undefined, b: JsonVal | undefined, path = ''): SpecDiffRow[] {
  if (a === undefined && b === undefined) return []
  const bothObj =
    a !== null && b !== null && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)
  if (bothObj) {
    const ao = a as { [k: string]: JsonVal }
    const bo = b as { [k: string]: JsonVal }
    const keys = [...new Set([...Object.keys(ao), ...Object.keys(bo)])].sort()
    const rows: SpecDiffRow[] = []
    for (const k of keys) rows.push(...diffJson(ao[k], bo[k], path ? `${path}.${k}` : k))
    return rows
  }
  const bothArr = Array.isArray(a) && Array.isArray(b)
  if (bothArr) {
    const aa = a as JsonVal[]
    const ba = b as JsonVal[]
    const n = Math.max(aa.length, ba.length)
    const rows: SpecDiffRow[] = []
    for (let i = 0; i < n; i++) rows.push(...diffJson(aa[i], ba[i], `${path}[${i}]`))
    return rows
  }
  if (show(a) === show(b)) return []
  return [{ path: path || '(root)', left: show(a), right: show(b) }]
}

/** 이름표일 뿐 실행에 안 들어가는 필드 — 남은 차이를 셀 때 제외한다. */
export const COSMETIC_SPEC_PATHS: readonly string[] = ['id', 'name', 'source']

export function isCosmetic(path: string): boolean {
  return COSMETIC_SPEC_PATHS.includes(path)
}

export function diffSpecs(a: StrategySpec, b: StrategySpec): SpecDiffRow[] {
  return diffJson(normalizeSpec(a), normalizeSpec(b))
}

// ============================================================================
// ③ 2×2 재실행 — {데이터축} × {스펙축} 중 어느 축이 갭을 만드는가
// ============================================================================

/** 한 축의 "데이터" — 로더 규약 하나가 만들어낸 시세 묶음 */
export interface DataBundle {
  label: string
  histories: Record<string, DailyBar[]>
  /** 유니버스 코드 → histories 키. 코드를 그대로 키로 쓰면 생략. */
  resolve?: (code: string) => string | undefined
  bench?: DailyBar[]
}

/** 표에 찍는 스칼라만 — 곡선·매매이력은 즉시 버린다(400조합 OOM 재발 방지 관행). */
export interface CellStat {
  dataLabel: string
  armLabel: string
  totalPct: number
  cagrPct: number
  mddPct: number
  alphaCagrPct: number | null
  tradeCount: number
  startDate: string
  endDate: string
  /** 유니버스에 실제로 든 종목 수의 연도 평균 — 데이터축 차이가 여기로 드러난다 */
  mappedAvgPct: number | null
  /** 현금 보유로 처리된 해 */
  cashYears: number[]
}

export function statOf(dataLabel: string, armLabel: string, r: PitChainResult): CellStat {
  return {
    dataLabel,
    armLabel,
    totalPct: r.totalPct,
    cagrPct: r.cagrPct,
    mddPct: r.mddPct,
    alphaCagrPct: r.alphaCagrPct,
    tradeCount: r.tradeCount,
    startDate: r.startDate,
    endDate: r.endDate,
    mappedAvgPct: r.mappedAvgPct,
    cashYears: r.perYear.filter((p) => p.cash).map((p) => p.year),
  }
}

/** 조건식 축 — 스펙 하나가 한 팔(arm)이다. */
export interface ConditionArm {
  label: string
  make: (symbols: string[]) => StrategySpec
}

export interface ChainEnv {
  cost: CostSettings
  years: number[]
  codesFor: (year: number) => string[]
}

export function run2x2Condition(data: DataBundle[], arms: ConditionArm[], env: ChainEnv): CellStat[] {
  const out: CellStat[] = []
  for (const d of data)
    for (const a of arms) {
      const r = runPitChained(d.histories, (symbols) => a.make(symbols), env.cost, {
        resolve: d.resolve,
        bench: d.bench,
        years: env.years,
        codesFor: env.codesFor,
      })
      out.push(statOf(d.label, a.label, r))
    }
  return out
}

/**
 * 모멘텀 축 — xsmom은 스펙 객체가 아니라 **러너 옵션**이 전략을 정한다.
 * 연구(idea-lab `runCustomChain`)는 해마다 청산비용 근사(haircut)를 물리고,
 * 사전계산(`runXsmomChained` 기본값)은 물리지 않는다 — 그 축을 여기서 갈라 본다.
 */
export interface XsmomArm {
  label: string
  slots: number
  gate: boolean
  /** idea-lab runCustomChain의 구간끝 청산비용 근사 적용 여부 */
  haircut: boolean
}

export function run2x2Xsmom(data: DataBundle[], arms: XsmomArm[], env: ChainEnv): CellStat[] {
  const out: CellStat[] = []
  for (const d of data)
    for (const a of arms) {
      const r = runXsmomChained(d.histories, {
        cost: env.cost,
        slots: a.slots,
        gate: a.gate,
        years: env.years,
        codesFor: env.codesFor,
        resolve: d.resolve,
        bench: d.bench,
        applyLiquidationHaircut: a.haircut,
      })
      out.push(statOf(d.label, a.label, r))
    }
  return out
}

// ============================================================================
// ④ 기여도 분해 — 갭의 몇 %가 데이터축이고 몇 %가 스펙축인가
// ============================================================================
//
// 총수익은 곱셈으로 쌓이므로 **로그 배수**에서 나눈다(퍼센트포인트 차를 그대로 더하면
// 1,000%와 100%의 차를 선형으로 읽는 오류가 난다).
//
// 두 축의 순서에 따라 답이 달라지는 것을 피하려고 **양쪽 경로의 평균**(Shapley 2요인)을
// 쓴다 — 두 몫의 합이 전체 갭과 **정확히** 일치하므로 잔차·교호항이 남지 않는다.

export interface GapAttribution {
  /** ln(연구,연구 배수) − ln(사전계산,사전계산 배수) */
  totalLogGap: number
  dataLog: number
  armLog: number
  /** 전체 갭에서 데이터축이 차지하는 비율(%) — 갭이 0에 가까우면 null */
  dataSharePct: number | null
  armSharePct: number | null
}

const logMult = (totalPct: number): number => Math.log(Math.max(1 + totalPct / 100, 1e-9))

/**
 * @param rr 연구 데이터 × 연구 팔
 * @param rp 연구 데이터 × 프리셋 팔
 * @param pr 사전계산 데이터 × 연구 팔
 * @param pp 사전계산 데이터 × 프리셋 팔
 */
export function attributeGap(rr: number, rp: number, pr: number, pp: number): GapAttribution {
  const LRR = logMult(rr)
  const LRP = logMult(rp)
  const LPR = logMult(pr)
  const LPP = logMult(pp)
  // 데이터축: 팔을 고정한 채 사전계산 데이터 → 연구 데이터로 바꿨을 때의 변화(두 팔 평균)
  const dataLog = ((LRR - LPR) + (LRP - LPP)) / 2
  // 팔축: 데이터를 고정한 채 프리셋 팔 → 연구 팔로 바꿨을 때의 변화(두 데이터 평균)
  const armLog = ((LRR - LRP) + (LPR - LPP)) / 2
  const totalLogGap = LRR - LPP
  const denom = Math.abs(totalLogGap)
  return {
    totalLogGap,
    dataLog,
    armLog,
    dataSharePct: denom > 1e-9 ? (dataLog / totalLogGap) * 100 : null,
    armSharePct: denom > 1e-9 ? (armLog / totalLogGap) * 100 : null,
  }
}

/** 기여도 분해를 한 줄 결론 문장으로 — 표만 보고 사람이 다시 해석하지 않게 한다. */
export function conclude(name: string, g: GapAttribution): string {
  if (g.dataSharePct == null || g.armSharePct == null)
    return `${name}: 두 극단 셀의 총수익이 사실상 같다 — 이 2×2로는 갭이 재현되지 않았다(다른 축을 봐야 한다).`
  const dominant = Math.abs(g.dataLog) >= Math.abs(g.armLog) ? '데이터축(시세 로드 규약·구간)' : '전략축(스펙·러너 옵션)'
  return (
    `${name}: 갭의 주원인 = **${dominant}** — 데이터축 ${g.dataSharePct.toFixed(0)}% · ` +
    `전략축 ${g.armSharePct.toFixed(0)}% (로그배수 분해, 두 몫의 합 = 전체 갭).`
  )
}
