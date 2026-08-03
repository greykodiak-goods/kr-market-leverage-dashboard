// 밸류·퀄리티 팩터 랩 — 저PBR·저PER·고ROE 18변형을 KRX 실측 유니버스로 검증 (38차)
//
// ── 무엇을 재는가 ────────────────────────────────────────────────────────────
//   33~36차는 전부 **가격에서 나온 신호**(이평·돌파·모멘텀·단기기법)였다. 이번 회차는
//   처음으로 **재무제표에서 나온 신호**를 같은 깔때기에 태운다. 유니버스(KRX 실측)·
//   비용·벤치(KODEX 200)·판정(전·후반 알파 + 매매수 + 칼마)·QQQ 원화 벽이 전부 34차
//   (MODE=krxcal)·36차(MODE=short:all)와 같고, 바뀌는 것은 **랭킹 지표뿐**이다.
//
//   총 **18변형 고정**이다(지시로 못 박힌 상한). 격자를 늘리지 않는다 — 이 리포는 이미
//   33~36차에서 79변형을 같은 데이터에 돌렸고, 이번 18을 더하면 **누적 97**이다. 그
//   97이 DSR의 진짜 분모이며, 변형을 하나 더 늘릴 때마다 "찾은 것이 우연일 확률"이
//   올라간다. 그래서 이 파일에는 격자 확장 스위치를 두지 않았다.
//
// ── 🚫 규칙 1(미래참조 금지) 처리 — 재무 데이터의 두 가지 함정 ────────────────
//   ① **공시 시점 함정.** FY2023 사업보고서는 2024년 3월에 접수된다. `bsnsYear`로 고르면
//      2023년 내내 "아직 세상에 없던 숫자"로 PBR을 계산하게 된다. 이 파일은 재무 선택을
//      전부 `selectFundamentalKnownAt`(= `rceptDt <= D`)에 위임한다 — 접수일이 PIT 기준이다.
//   ② **당일 종가 함정.** 시가총액을 리밸런스일 **당일 종가**로 잡고 그날 **시가**에
//      체결하면 "오늘 종가를 보고 오늘 시가에 샀다"가 된다(규칙 1-2 명시 금지). 그래서
//      팩터 산출 기준일을 리밸런스일이 아니라 **그 전날**(`prevDayIso`)로 민다 — 재무
//      접수일 판정도 같은 날짜를 쓴다(리밸런스일 아침에 올라온 공시를 보지 않는다).
//   집행자는 `tests/valuelab.test.ts`의 **PIT 불변성** 테스트다 — 시점 D 이후에 접수된
//   레코드를 입력에 아무리 더 넣어도 D 시점 랭킹이 바뀌면 실패다.
//
// ── ⚠️ 이 실험이 조용히 망가지는 자리 = 더러운 재무 레코드 ────────────────────
//   PBR = 시가총액 ÷ 자본총계다. 자본총계가 **자산총계로 잘못 들어온** 레코드가 있으면
//   분모가 몇 배로 부풀고 그 종목은 **저PBR 상위로 곧장 올라온다.** 즉 데이터 오류가
//   정확히 이 전략의 매수 신호로 위장한다. 실측으로 그런 레코드가 있다(예: 젬백스
//   082270 — `equity`와 `assets`가 같은 값). 그래서 **팩터 계산 전에 위생 게이트**를
//   두고, 배제 건수·종목·사유를 표로 찍는다(규칙 3 — 조용히 버리지 않는다).
//
// ── 실행 ─────────────────────────────────────────────────────────────────────
//   MODE=all     node scripts/value-lab.mjs      (GHA: value:all — 벤치 KODEX 200 · QQQ 벽)
//   MODE=offline node scripts/value-lab.mjs      (네트워크 없이 · 벤치는 유니버스 동일가중)
//   MODE=hygiene node scripts/value-lab.mjs      (위생 게이트 리포트만 — 네트워크 불필요)
//
//   시세·재무는 **리포에 커밋된 정본**(public/data/krx-daily · public/data/dart-fundamentals)을
//   읽으므로 네트워크가 필요 없다. 야후가 필요한 것은 **벤치(069500.KS)와 참고 벽(QQQ·환율)**
//   뿐이다. 그래서 `MODE=all`은 GHA에서, `MODE=offline`은 어디서든 돈다.
//
//   ⚠️ `MODE=offline`의 알파는 **KODEX 200 알파가 아니다.** 벤치가 다르면 규칙 5의 판정
//      기준 자체가 달라지므로, 그 모드의 모든 표에 `[벤치=유니버스 동일가중]`을 박는다.
//      offline 수치를 34·36차 표 옆에 놓고 읽으면 안 된다.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { CostSettings } from '../src/features/backtest/conditionScreen'
import type { DailyBar } from '../src/features/backtest/types'

import {
  DART_FUNDAMENTALS_DIR,
  checkAccountingIdentity,
  computeValueQualityFactors,
  krxMarketCapSeries,
  marketCapKnownAt,
  netIncomeKnownAt,
  parseFundamentalIndex,
  parseFundamentalStock,
  rankFactor,
  selectFundamentalKnownAt,
  type FundamentalRecord,
  type MarketCapPoint,
} from '../src/features/backtest/fundamentals'
import {
  KRX_DAILY_DIR,
  KRX_DAILY_LIMITS,
  krxDailyBars,
  krxDailySourceNote,
  parseKrxDailyIndex,
  parseKrxDailyStock,
} from '../src/features/backtest/krxDailyPrices'
import { KRX_PIT_PATH, krxPitMarketCodes, krxPitSourceNote, krxPitYears, parseKrxPitUniverse } from '../src/features/backtest/krxPitUniverse'
import {
  DSR_PASS_THRESHOLD,
  PBO_WARN_THRESHOLD,
  computePbo,
  multipleTestingReport,
  sharpeMetric,
  sharpeMoments,
  variance,
  walkForwardScore,
} from '../src/features/backtest/overfit'
import {
  SCREEN_MIN_TRADES,
  benchCurve,
  buildYearly,
  calmarOf,
  f1,
  log,
  makeRegimeExposure,
  monthlyReturnsOf,
  runCustomChain,
  simulateRankYear,
  summarizeStrat,
  toKrwCurve,
  wallOf,
  wallTable,
  type CalWall,
  type ChainStats,
  type RankRow,
  type StratRow,
  type YearSlice,
} from './idea-lab.entry'

// ============================================================================
// 0. 상수 — 34·36차와 **같은 값**이어야 표가 나란히 읽힌다
// ============================================================================

/** 비용 전제. MODE=krxcal(34차)·short:all(36차)과 동일. `tests/valuelab.test.ts`가 대조한다. */
export const COST: CostSettings = { initialCapital: 10_000_000, feePct: 0.015, taxPct: 0.15, slippagePct: 0.1 }

/** 알파 판정 벤치(규칙 5). KODEX 200 — 야후에서만 받는다. */
export const BENCH = '069500.KS'

/** 실행 구간 — 지시로 고정. DART 재무 데이터가 2015년부터라 그 앞은 애초에 불가능하다. */
export const VALUE_FROM_YEAR = 2015
export const VALUE_TO_YEAR = 2026
export const VALUE_FROM = '2015-01-01'
export const VALUE_TO = '2026-07-31'

/** 벤치·참고 벽 로드 구간. 시장게이트(12-1)가 2015-01에 이미 판정되려면 2년 앞이 필요하다. */
export const VALUE_BENCH_RANGE = 'since:2013-01-01'

/** 표본 소실 판정선 — 34·36차와 같은 값이어야 판정이 나란히 읽힌다. */
export const VALUE_MIN_TRADES = SCREEN_MIN_TRADES

/** 이번 회차 변형 수 — **지시로 못 박힌 상한**. 늘리지 마라(다중검정 분모가 커진다). */
export const VALUE_TRIALS = 18

/**
 * 누적 시도 수 = **DSR의 진짜 분모**. 33차 10 + 34차 35 + 35차 20 + 36차 14 + 이번 18 = 97.
 * 같은 데이터·같은 유니버스를 여러 회차에 걸쳐 반복해 본 것이므로 선택편의가 누적된다.
 */
export const VALUE_TRIALS_PRIOR: readonly { round: string; n: number }[] = [
  { round: '33차 (krxpit 실측 재검증)', n: 10 },
  { round: '34차 (krxcal 격자)', n: 35 },
  { round: '35차 (krxscreen 랭킹 4계열)', n: 20 },
  { round: '36차 (short 단기기법)', n: 14 },
]
export const VALUE_TRIALS_CUMULATIVE =
  VALUE_TRIALS_PRIOR.reduce((s, r) => s + r.n, 0) + VALUE_TRIALS

/**
 * PBO 블록 수 S. 월별 수익률 ~138개라 S=16이면 블록당 8개월이고 조합 C(16,8)=12,870개를
 * **전수** 평가한다(상한 20,000 안). 블록을 줄이면(S=8 → 70조합) PBO 추정 자체가 조합
 * 표본에 흔들린다 — overfit.ts의 기본값과 같은 16을 쓴다.
 */
export const VALUE_PBO_BLOCKS = 16
/** 워크포워드 창(개월). IS 60 / OOS 12 — 11.5년 표본에서 만들 수 있는 최대치에 가깝다. */
export const VALUE_WF_IS_MONTHS = 60
export const VALUE_WF_OOS_MONTHS = 12
/** 월별 수익률의 연환산 계수. */
export const VALUE_PERIODS_PER_YEAR = 12

// ============================================================================
// 1. 데이터 위생 게이트 — 팩터 계산 **전에** 더러운 레코드를 잘라낸다
// ============================================================================
//
// PBR = 시총 ÷ 자본이다. **자본이 틀린 레코드는 저PBR 상위로 올라온다** — 데이터 오류가
// 정확히 매수 신호로 위장하는 구조다. 그래서 세 가지를 거른다.
//
//   R1 회계 항등식 실패 — 자산 ≠ 부채 + 자본 (총계 기준 레코드에서만 판정 가능)
//   R2 자본 > 자산      — 부채가 음수여야 성립하므로 **구조적으로 불가능**
//   R3 귀속 기준 혼재   — 연결(CFS)인데 지배주주 라인을 못 찾아 **총계로 폴백**한 레코드
//
// R3가 왜 배제인가: 이 프로젝트의 `equity`는 "지배주주 우선, 없으면 총계"다. 연결에서
// 총계를 쓰면 **비지배지분이 분모에 섞여** 같은 표 안에서 PBR의 분모 정의가 갈린다.
// 반면 **별도(OFS)는 비지배지분이라는 개념 자체가 없어** total == parent이므로 그대로 쓴다.
// → 통일 기준은 **지배주주 귀속(parent)**이고, 통일 불가한 것(CFS/total)만 배제한다.

/** PBR·ROE 분모의 통일 기준 — 이 회차의 선택을 상수로 박아 출력에 그대로 싣는다. */
export const EQUITY_BASIS_POLICY =
  '지배주주 귀속(parent) 기준으로 통일 — 별도재무제표(OFS)의 총계는 비지배지분이 없어 동등으로 채택하고, ' +
  '연결(CFS)인데 총계로 폴백한 레코드는 분모 정의가 갈리므로 배제한다.'

/** 회계 항등식 허용 오차(상대). `checkAccountingIdentity` 기본값과 같다. */
export const IDENTITY_TOL = 0.005

export type HygieneRule = 'identity' | 'equityGtAssets' | 'mixedBasis'

export const HYGIENE_RULE_LABEL: Readonly<Record<HygieneRule, string>> = {
  identity: 'R1 회계 항등식 실패(자산 ≠ 부채+자본)',
  equityGtAssets: 'R2 자본 > 자산(구조적으로 불가능)',
  mixedBasis: 'R3 귀속 기준 혼재(연결인데 자본이 총계 — 지배주주 기준으로 통일 불가)',
}

/**
 * 레코드 한 건의 배제 사유 목록. 빈 배열이면 통과.
 * **판정 불가(값 결측)는 배제가 아니다** — 그건 팩터 단계에서 null로 빠지며 그 수는
 * 랭킹 제외 카운트로 따로 보고된다(두 가지를 섞으면 어느 쪽이 문제인지 못 읽는다).
 */
export function hygieneViolations(rec: FundamentalRecord, tol = IDENTITY_TOL): HygieneRule[] {
  const bad: HygieneRule[] = []
  const id = checkAccountingIdentity(rec, tol)
  if (id.checked && !id.ok) bad.push('identity')
  if (rec.assets != null && rec.equity != null && rec.assets > 0 && rec.equity > rec.assets * (1 + tol))
    bad.push('equityGtAssets')
  if (rec.fsDiv === 'CFS' && rec.equitySource === 'total') bad.push('mixedBasis')
  return bad
}

export interface HygieneStockRow {
  code: string
  name: string
  total: number
  excluded: number
  rules: HygieneRule[]
  /** 배제 후 레코드가 하나도 남지 않은 종목 — 유니버스에서 통째로 사라진다. */
  wiped: boolean
}

export interface HygieneReport {
  totalRecords: number
  keptRecords: number
  excludedRecords: number
  /** 규칙별 적중 수(한 레코드가 두 규칙에 걸리면 양쪽에 다 센다 — 합이 배제 수보다 클 수 있다). */
  byRule: Record<HygieneRule, number>
  /** 배제가 하나라도 있는 종목(배제 수 내림차순). */
  stocks: HygieneStockRow[]
  wipedCodes: string[]
  /**
   * 사업연도별 (배제, 전체). **어느 시기의 데이터가 얇아지는지**를 숨기지 않기 위해 남긴다 —
   * 배제가 특정 연도에 몰려 있으면 그 구간의 랭킹은 다른 구간과 같은 품질이 아니다.
   */
  byYear: Map<number, { excluded: number; total: number }>
  tol: number
}

export interface FundamentalStore {
  /** 위생 게이트를 통과한 레코드만 담는다(접수일 오름차순 유지). */
  clean: Map<string, FundamentalRecord[]>
  names: Map<string, string>
  report: HygieneReport
}

/**
 * 위생 게이트. **배제한 것을 전부 세어서 돌려준다** — 조용히 버리면 "왜 이 종목이
 * 랭킹에 없나"를 다음 세션이 영원히 못 찾는다(규칙 3).
 */
export function screenFundamentals(
  stocks: readonly { code: string; name: string; records: readonly FundamentalRecord[] }[],
  tol = IDENTITY_TOL,
): FundamentalStore {
  const clean = new Map<string, FundamentalRecord[]>()
  const names = new Map<string, string>()
  const byRule: Record<HygieneRule, number> = { identity: 0, equityGtAssets: 0, mixedBasis: 0 }
  const rows: HygieneStockRow[] = []
  const byYear = new Map<number, { excluded: number; total: number }>()
  let totalRecords = 0
  let excludedRecords = 0

  const bumpYear = (y: number, excluded: boolean) => {
    const cur = byYear.get(y) ?? { excluded: 0, total: 0 }
    cur.total++
    if (excluded) cur.excluded++
    byYear.set(y, cur)
  }

  for (const s of stocks) {
    names.set(s.code, s.name)
    const kept: FundamentalRecord[] = []
    let ex = 0
    const rules = new Set<HygieneRule>()
    for (const r of s.records) {
      totalRecords++
      const bad = hygieneViolations(r, tol)
      bumpYear(r.bsnsYear, bad.length > 0)
      if (bad.length === 0) {
        kept.push(r)
        continue
      }
      ex++
      excludedRecords++
      for (const b of bad) {
        byRule[b]++
        rules.add(b)
      }
    }
    clean.set(s.code, kept)
    if (ex > 0)
      rows.push({
        code: s.code,
        name: s.name,
        total: s.records.length,
        excluded: ex,
        rules: [...rules].sort(),
        wiped: kept.length === 0,
      })
  }

  rows.sort((a, b) => (b.excluded !== a.excluded ? b.excluded - a.excluded : a.code < b.code ? -1 : 1))
  return {
    clean,
    names,
    report: {
      totalRecords,
      keptRecords: totalRecords - excludedRecords,
      excludedRecords,
      byRule,
      stocks: rows,
      wipedCodes: rows.filter((r) => r.wiped).map((r) => r.code),
      byYear,
      tol,
    },
  }
}

export function hygieneTable(rep: HygieneReport, topN = 12): void {
  log('')
  log('## 데이터 위생 게이트 — 팩터 계산에서 **배제한** 재무 레코드')
  log('PBR = 시총 ÷ 자본이라, 자본이 틀린 레코드는 **저PBR 상위로 올라와** 밸류 전략을 정확히 망가뜨린다.')
  log(`귀속 기준 통일: ${EQUITY_BASIS_POLICY}`)
  log('')
  log(`전체 ${rep.totalRecords}건 → 사용 ${rep.keptRecords}건 · **배제 ${rep.excludedRecords}건** (허용오차 ${(rep.tol * 100).toFixed(1)}%)`)
  log('')
  log('| 규칙 | 적중 레코드 |')
  log('|---|---|')
  for (const k of Object.keys(HYGIENE_RULE_LABEL) as HygieneRule[]) log(`| ${HYGIENE_RULE_LABEL[k]} | ${rep.byRule[k]} |`)
  log('※ 한 레코드가 두 규칙에 걸리면 양쪽에 다 세므로 규칙별 합계가 배제 수보다 클 수 있다.')
  log('')
  log('사업연도별 배제 — **특정 시기에 몰려 있으면 그 구간의 랭킹은 다른 구간과 같은 품질이 아니다.**')
  const ys = [...rep.byYear.keys()].sort((a, b) => a - b)
  log(`| 사업연도 | ${ys.join(' | ')} |`)
  log(`|---|${ys.map(() => '---').join('|')}|`)
  log(`| 배제/전체 | ${ys.map((y) => `${rep.byYear.get(y)!.excluded}/${rep.byYear.get(y)!.total}`).join(' | ')} |`)
  log('')
  log(`영향받은 종목 ${rep.stocks.length}개${rep.stocks.length > topN ? ` (상위 ${topN}개만 표시)` : ''}`)
  log('| 종목 | 코드 | 배제/전체 | 사유 |')
  log('|---|---|---|---|')
  for (const s of rep.stocks.slice(0, topN))
    log(`| ${s.name}${s.wiped ? ' **[전멸]**' : ''} | ${s.code} | ${s.excluded}/${s.total} | ${s.rules.join(', ')} |`)
  if (rep.wipedCodes.length > 0)
    log(`⚠️ 배제 후 재무가 하나도 안 남은 종목 ${rep.wipedCodes.length}개: ${rep.wipedCodes.join(', ')} — 이 종목은 어떤 팩터 랭킹에도 못 들어간다.`)
  else log('배제 후 재무가 전멸한 종목은 없다.')
}

// ============================================================================
// 2. 팩터 산출 — PIT(접수일) + 전일 시총
// ============================================================================

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/**
 * 하루 전 날짜(YYYY-MM-DD). **팩터 기준일을 리밸런스일에서 하루 미는 데 쓴다.**
 *
 * 왜 미는가: `marketCapKnownAt(caps, D)`는 D **이하** 마지막 거래일 종가를 준다. 즉 D가
 * 거래일이면 **D 당일 종가**가 잡힌다. 그런데 체결은 D의 **시가**다 — 오늘 종가를 보고
 * 오늘 시가에 사는 계산이 되어 규칙 1-2가 명시적으로 금지한 형태가 된다. 하루를 밀면
 * 판단에 쓰이는 마지막 가격이 **직전 거래일 종가**가 되어 인과성이 회복된다.
 * 재무 접수일 판정에도 같은 날짜를 써서 "리밸런스일 아침에 올라온 공시"를 보지 않는다.
 */
export function prevDayIso(date: string): string {
  if (!DATE_RE.test(date)) throw new Error(`날짜가 YYYY-MM-DD가 아니다 (${date})`)
  const t = Date.parse(`${date}T00:00:00Z`)
  if (!Number.isFinite(t)) throw new Error(`날짜를 해석할 수 없다 (${date})`)
  return new Date(t - 86400000).toISOString().slice(0, 10)
}

/** 팩터 계산에 필요한 종목별 재료 — 재무(위생 통과분)와 시가총액 시계열. */
export interface ValueDeps {
  records: Map<string, readonly FundamentalRecord[]>
  caps: Map<string, readonly MarketCapPoint[]>
}

export type FactorKey = 'pbr' | 'per' | 'roe'

/** 팩터의 방향 — `asc`는 작을수록 좋다(PBR·PER), `desc`는 클수록 좋다(ROE). */
export const FACTOR_DIRECTION: Readonly<Record<FactorKey, 'asc' | 'desc'>> = {
  pbr: 'asc',
  per: 'asc',
  roe: 'desc',
}

export const FACTOR_LABEL: Readonly<Record<FactorKey, string>> = { pbr: '저PBR', per: '저PER', roe: '고ROE' }

export interface FactorRow {
  code: string
  /** 팩터 기준일 = 리밸런스일 **전날**. 이 값이 리밸런스일 이상이면 버그다. */
  asOf: string
  marketCap: number | null
  /** 쓰인 재무의 접수일 — `asOf`보다 크면 미래참조다(테스트가 잡는다). */
  rceptDt: string | null
  equity: number | null
  netIncome: number | null
  pbr: number | null
  per: number | null
  roe: number | null
  /** null이 된 사유(적자·자본잠식·재무없음·시총없음) — 조용히 사라지지 않게 남긴다. */
  reasons: string[]
}

/**
 * 시점 D(= 리밸런스일 전날)의 팩터 단면.
 *
 * **재무는 사업보고서(11011) 연간값만** 쓴다 — 분기 `thstrm_amount`가 3개월치인지
 * 누적인지가 `[미검증]`이라, 그걸 연간인 양 쓰면 PER이 최대 4분의 1로 찍힌다.
 * `netIncomeKnownAt`의 기본 경로(annual)가 그 보수적 선택이며 여기서 바꾸지 않는다.
 */
export function valueFactorRows(deps: ValueDeps, codes: readonly string[], asOf: string): FactorRow[] {
  if (!DATE_RE.test(asOf)) throw new Error(`asOf가 YYYY-MM-DD가 아니다 (${asOf})`)
  const out: FactorRow[] = []
  for (const code of codes) {
    const recs = deps.records.get(code) ?? []
    const caps = deps.caps.get(code) ?? []
    const rec = selectFundamentalKnownAt(recs, asOf, { reprtCodes: ['11011'] })
    const ni = netIncomeKnownAt(recs, asOf)
    const cap = marketCapKnownAt(caps, asOf)
    const f = computeValueQualityFactors({
      marketCap: cap?.marketCap ?? null,
      equity: rec?.equity ?? null,
      netIncome: ni.value,
    })
    out.push({
      code,
      asOf,
      marketCap: cap?.marketCap ?? null,
      rceptDt: rec?.rceptDt ?? null,
      equity: rec?.equity ?? null,
      netIncome: ni.value,
      pbr: f.pbr,
      per: f.per,
      roe: f.roe,
      reasons: [...(rec ? [] : ['D 시점에 접수된 사업보고서가 없다']), ...ni.notes, ...f.reasons],
    })
  }
  out.sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0))
  return out
}

export interface FactorRankOut {
  /** score가 클수록 상위. 값은 **평균 순위의 음수**라 동점이 나오지 않는다. */
  ranked: { code: string; score: number; avgRank: number }[]
  /** 랭킹에서 빠진 종목과 사유 — 수를 반드시 출력에 남긴다(규칙 3). */
  excluded: { code: string; reason: string }[]
}

/**
 * 팩터 하나 또는 여럿으로 줄 세운다.
 *
 * · 단일 팩터 — `rankFactor`(fundamentals.ts 정본)로 방향에 맞춰 세운다.
 * · 복합       — 요구 팩터를 **전부 가진 종목만** 후보로 두고, 각 팩터의 순위를 매겨
 *                **동일가중 평균 순위**로 다시 세운다. 하나라도 없는 종목은 배제한다
 *                (없는 값을 중앙값 같은 것으로 메우면 그 자체가 전 구간 통계 — 규칙 1-5).
 *
 * 적자(PER null)·자본잠식(PBR·ROE null)은 여기서 **제외**된다 — 0이나 음수로 두면
 * 최악의 회사가 최고 점수를 받는다(`computeValueQualityFactors` 주석 참조).
 */
export function rankByFactors(rows: readonly FactorRow[], factors: readonly FactorKey[]): FactorRankOut {
  if (factors.length === 0) throw new Error('랭킹 팩터가 비어 있다')
  const excluded: { code: string; reason: string }[] = []
  const usable: FactorRow[] = []
  for (const r of rows) {
    const missing = factors.filter((k) => r[k] == null || !Number.isFinite(r[k] as number))
    if (missing.length > 0) {
      const why = r.reasons.length > 0 ? r.reasons.join(' / ') : `${missing.join('·')} 값 없음`
      excluded.push({ code: r.code, reason: why })
      continue
    }
    usable.push(r)
  }

  const rankOf = new Map<string, number[]>()
  for (const k of factors) {
    const res = rankFactor(
      usable.map((r) => ({ code: r.code, value: r[k] as number })),
      FACTOR_DIRECTION[k],
    )
    for (const e of res.ranked) {
      const arr = rankOf.get(e.code) ?? []
      arr.push(e.rank)
      rankOf.set(e.code, arr)
    }
  }

  const scored = usable.map((r) => {
    const arr = rankOf.get(r.code) ?? []
    const avg = arr.length > 0 ? arr.reduce((s, v) => s + v, 0) / arr.length : Number.POSITIVE_INFINITY
    return { code: r.code, avgRank: avg }
  })
  // 평균 순위 오름차순(작을수록 상위), 동점은 코드 오름차순 — 결정적.
  scored.sort((a, b) => (a.avgRank !== b.avgRank ? a.avgRank - b.avgRank : a.code < b.code ? -1 : 1))
  excluded.sort((a, b) => (a.code < b.code ? -1 : 1))
  return {
    // 최종 score는 **순위 자체의 음수**다 — 동점이 원천적으로 없어 시뮬 결과가 결정적이다.
    ranked: scored.map((s, i) => ({ code: s.code, score: -(i + 1), avgRank: s.avgRank })),
    excluded,
  }
}

/** 랭킹 진단 누계 — "적자·자본잠식으로 몇 종목이 빠졌나"를 회차 전체로 합산한다. */
export interface RankDiag {
  rebalances: number
  candidates: number
  excluded: number
  /** 사유별 누계 — 문자열 앞머리로 묶는다(전체 문장을 키로 쓰면 표가 터진다). */
  byReason: Map<string, number>
  /** 후보가 하나도 없어 전액 현금이 된 리밸런스 수. */
  emptyRebalances: number
  /**
   * 후보가 처음 생긴 리밸런스일. **하드코딩하지 않고 실행에서 관측한다** —
   * "2016-03경"이라고 적어 두면 데이터가 앞으로 늘었을 때 문구만 낡는다.
   */
  firstCandidateDate: string | null
}

export const newRankDiag = (): RankDiag => ({
  rebalances: 0,
  candidates: 0,
  excluded: 0,
  byReason: new Map(),
  emptyRebalances: 0,
  firstCandidateDate: null,
})

/** 사유 문자열을 표에 담을 수 있는 짧은 키로 접는다. */
export function reasonKey(reason: string): string {
  if (reason.includes('자본잠식')) return '자본잠식(자본 ≤ 0)'
  if (reason.includes('적자')) return '적자(순이익 ≤ 0)'
  if (reason.includes('접수된 사업보고서가 없다')) return '재무 없음(공시 전·상장 전)'
  if (reason.includes('당기순이익 계정이 없다')) return '순이익 계정 결측'
  if (reason.includes('시가총액')) return '시가총액 없음'
  if (reason.includes('순이익 없음')) return '순이익 없음'
  if (reason.includes('자본총계 없음')) return '자본총계 없음'
  return '기타'
}

/**
 * `simulateRankYear`에 끼울 랭킹 함수. 시세(`histories`)는 보지 않는다 — 이 계열의
 * 신호는 전부 재무·시총에서 나오므로, 가격 정보가 신호에 새어 들어갈 경로 자체를 없앤다.
 */
export function makeValueRankFn(deps: ValueDeps, factors: readonly FactorKey[], diag: RankDiag) {
  return (_histories: Record<string, DailyBar[]>, universe: string[], date: string): RankRow[] => {
    const asOf = prevDayIso(date)
    const rows = valueFactorRows(deps, universe, asOf)
    const res = rankByFactors(rows, factors)
    diag.rebalances++
    diag.candidates += res.ranked.length
    diag.excluded += res.excluded.length
    if (res.ranked.length === 0) diag.emptyRebalances++
    else if (diag.firstCandidateDate === null || date < diag.firstCandidateDate) diag.firstCandidateDate = date
    for (const e of res.excluded) {
      const k = reasonKey(e.reason)
      diag.byReason.set(k, (diag.byReason.get(k) ?? 0) + 1)
    }
    // aux는 이 계열에서 종목별 게이트로 쓰지 않는다(게이트는 시장 단위 exposure다).
    return res.ranked.map((r) => ({ sym: r.code, score: r.score, aux: r.avgRank }))
  }
}

// ============================================================================
// 3. 변형 매트릭스 — **총 18 고정**
// ============================================================================

export type UniverseWidth = '10+10' | '40+40'

export interface ValueVariant {
  key: string
  label: string
  group: string
  factors: FactorKey[]
  slots: number
  /** 시장게이트(벤치 12-1 모멘텀 < 0이면 그 달 전액 현금) 적용 여부. */
  gate: boolean
  width: UniverseWidth
}

/**
 * 지시받은 18변형. **이 함수 밖에서 격자를 늘리지 마라** — 늘리는 순간 DSR의 분모가
 * 커지고, 이 회차의 결론(통과 n개)이 다른 회차와 나란히 읽히지 않는다.
 *
 *   저PBR 10+10 : N∈{3,5} × 게이트{off,on} = 4
 *   저PER 10+10 : 같은 4
 *   고ROE 10+10 : 같은 4
 *   40+40 분위  : 각 팩터 상위 16 + 게이트 = 3   (80종목의 상위 20% 분위 — 27차 교훈)
 *   복합 10+10  : (PBR∩ROE)5+게이트 · (PER∩ROE)5+게이트 · 3팩터 동일가중 5+게이트 = 3
 */
export function valueVariants(): ValueVariant[] {
  const out: ValueVariant[] = []
  const singles: FactorKey[] = ['pbr', 'per', 'roe']
  for (const k of singles) {
    for (const slots of [3, 5]) {
      for (const gate of [false, true]) {
        out.push({
          key: `${k}-${slots}${gate ? '-g' : ''}`,
          label: `${FACTOR_LABEL[k]} 상위${slots}${gate ? '+게이트' : ''}`,
          group: FACTOR_LABEL[k],
          factors: [k],
          slots,
          gate,
          width: '10+10',
        })
      }
    }
  }
  for (const k of singles) {
    out.push({
      key: `${k}-16-g-wide`,
      label: `${FACTOR_LABEL[k]} 상위16+게이트 [40+40 분위]`,
      group: `${FACTOR_LABEL[k]} (40+40)`,
      factors: [k],
      slots: 16,
      gate: true,
      width: '40+40',
    })
  }
  const combos: { key: string; label: string; factors: FactorKey[] }[] = [
    { key: 'pbr-roe', label: '복합 저PBR∩고ROE 상위5+게이트', factors: ['pbr', 'roe'] },
    { key: 'per-roe', label: '복합 저PER∩고ROE 상위5+게이트', factors: ['per', 'roe'] },
    { key: 'pbr-per-roe', label: '복합 3팩터 동일가중 상위5+게이트', factors: ['pbr', 'per', 'roe'] },
  ]
  for (const c of combos)
    out.push({ key: c.key, label: c.label, group: '복합', factors: c.factors, slots: 5, gate: true, width: '10+10' })

  if (out.length !== VALUE_TRIALS)
    throw new Error(`변형이 ${out.length}개다 — 지시로 못 박힌 ${VALUE_TRIALS}개와 다르다(격자를 늘리지 마라)`)
  const keys = new Set(out.map((v) => v.key))
  if (keys.size !== out.length) throw new Error('변형 키가 중복이다 — 표에서 서로 다른 변형이 뭉친다')
  return out
}

// ============================================================================
// 4. 판정 프레임 — 전·후반 분할은 **구간에서 자동 계산**한다
// ============================================================================

/**
 * 전·후반 경계 연도. 하드코딩하지 않는다 — 앞 구간이 붙거나 뒤가 늘면 자동으로 이동해야
 * "전반/후반"이라는 말의 뜻이 유지된다.
 *
 *   경계 = ceil((첫해 + 끝해) / 2) → 후반은 그 해부터.
 *   · 2015~2026 → 2021 (전반 2015~2020 6년 / 후반 2021~2026 6년)
 *   · 2010~2026 → 2018 (기존 KRXPIT_HALF와 같은 값 — 34·36차 표와 나란히 읽힌다)
 */
export function halfYearOf(years: readonly number[]): number {
  if (years.length < 2) throw new Error(`전·후반을 나누려면 2년 이상이 필요하다 (${years.length}년)`)
  const first = years[0]
  const last = years[years.length - 1]
  if (!(last > first)) throw new Error(`구간이 오름차순이 아니다 (${first}~${last})`)
  return Math.ceil((first + last) / 2)
}

/**
 * 짧은 표본 경고 — **결과마다** 찍는다. 11.5년(전·후반 각 6년)은 "전·후반 모두 알파 양수"
 * 라는 판정을 통과시키기에 충분한 표본이 아니다. 한 번의 강세장·약세장이 한 구간을
 * 통째로 지배한다.
 */
export function shortSampleNote(years: readonly number[], half: number): string {
  const a = years.filter((y) => y < half).length
  const b = years.filter((y) => y >= half).length
  return (
    `⚠️ 짧은 표본 — 전 구간 ${years.length}년(전반 ${years[0]}~${half - 1} ${a}년 / 후반 ${half}~${years[years.length - 1]} ${b}년). ` +
    '전·후반 각 6년 남짓이면 국면 하나가 한 구간을 통째로 지배한다 — "전·후반 모두 양수"가 재현성의 증거가 되기엔 부족하다.'
  )
}

export interface VariantResult {
  variant: ValueVariant
  row: StratRow
  chain: ChainStats
  trades: number
  diag: RankDiag
  /** 후보가 하나도 없어 전액 현금이던 리밸런스 수(2015년 재무 공백 구간이 여기 잡힌다). */
  emptyRebalances: number
}

/** 판정 탈락 사유(빈 배열 = 통과). 34차 `calFailReasons`와 **같은 기준**이다. */
export function valueFailReasons(r: VariantResult, minTrades = VALUE_MIN_TRADES): string[] {
  const bad: string[] = []
  if (!((r.row.alphaA ?? -1) > 0 && (r.row.alphaB ?? -1) > 0)) bad.push('알파')
  if (!(r.trades >= minTrades)) bad.push('매매')
  return bad
}
export const valuePass = (r: VariantResult, minTrades = VALUE_MIN_TRADES) => valueFailReasons(r, minTrades).length === 0

// ============================================================================
// 5. 과최적화 지표 — 월별 수익률 행렬
// ============================================================================

/**
 * 변형별 **월별 수익률 행렬**. PBO·DSR·워크포워드가 전부 이 행렬 하나를 먹는다.
 *
 * ⚠️ 자산곡선 레벨이 아니라 **수익률**이어야 한다 — 레벨을 블록으로 잘라 붙이면 경계에서
 *    가짜 수익이 생긴다(overfit.ts 주석). 그리고 모든 변형이 **같은 달 축**에 정렬돼
 *    있어야 한다: 한 변형에만 있는 달을 그대로 두면 시점이 통째로 밀린다.
 */
export function monthlyMatrix(
  curves: readonly { date: string; equity: number }[][],
  benchmark?: readonly { date: string; equity: number }[],
): { months: string[]; matrix: number[][]; bench: number[] | null; dropped: number } {
  const maps = curves.map((c) => monthlyReturnsOf(c))
  if (maps.length === 0) return { months: [], matrix: [], bench: null, dropped: 0 }
  const benchMap = benchmark ? monthlyReturnsOf(benchmark) : null
  const all = new Set<string>()
  for (const m of maps) for (const k of m.keys()) all.add(k)
  const sorted = [...all].sort()
  const months = sorted.filter((k) => maps.every((m) => m.has(k)) && (benchMap === null || benchMap.has(k)))
  return {
    months,
    matrix: maps.map((m) => months.map((k) => m.get(k) as number)),
    bench: benchMap ? months.map((k) => benchMap.get(k) as number) : null,
    dropped: sorted.length - months.length,
  }
}

// ============================================================================
// 6. 정본 로딩 — 리포에 커밋된 KRX 일별·DART 재무를 직접 읽는다(네트워크 없음)
// ============================================================================

const ROOT = process.env.REPO_ROOT ?? process.cwd()

function readJson(path: string, what: string): unknown {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (e) {
    throw new Error(`${what}를 읽지 못했다 (${path}) — ${String(e)}. 정본이 리포에 커밋돼 있어야 한다.`)
  }
  return JSON.parse(text)
}

export interface PriceStore {
  histories: Record<string, DailyBar[]>
  caps: Map<string, MarketCapPoint[]>
  names: Map<string, string>
  sourceNote: string
  limits: string[]
  missing: string[]
  appliedEvents: number
  skippedEvents: number
}

/**
 * KRX 일별 정본에서 **수정주가 봉**과 **원주가 시가총액**을 동시에 만든다.
 *
 * ⚠️ 두 계열의 가격 기준이 다르다는 점이 이 함수의 존재 이유다. 봉은 분할 보정된
 * 수정주가(수익률 계산용)이고, 시총은 `krxMarketCapSeries`가 만드는 **원주가 × 상장주식수**다.
 * 수정주가로 시총을 만들면 분할일에 시총이 조용히 몇 분의 일로 줄어 PBR이 붕괴한다.
 */
export function loadKrxPrices(codes: readonly string[], root = ROOT): PriceStore {
  const index = parseKrxDailyIndex(readJson(join(root, KRX_DAILY_DIR, 'index.json'), 'KRX 일별 index.json'))
  const entryOf = new Map(index.stocks.map((s) => [s.code, s]))
  const histories: Record<string, DailyBar[]> = {}
  const caps = new Map<string, MarketCapPoint[]>()
  const names = new Map<string, string>()
  const missing: string[] = []
  let appliedEvents = 0
  let skippedEvents = 0

  for (const code of [...new Set(codes)]) {
    const entry = entryOf.get(code)
    if (!entry) {
      missing.push(code)
      continue
    }
    const stock = parseKrxDailyStock(
      readJson(join(root, KRX_DAILY_DIR, entry.file), `KRX 시세 ${code}`),
      index.calendar.length,
    )
    const res = krxDailyBars(index, stock)
    appliedEvents += res.applied.length
    skippedEvents += res.skipped.length
    if (res.bars.length === 0) {
      missing.push(code)
      continue
    }
    histories[code] = res.bars
    caps.set(code, krxMarketCapSeries(index, stock))
    names.set(code, stock.name)
  }
  if (Object.keys(histories).length === 0)
    throw new Error('KRX 일별 정본에서 시세를 하나도 만들지 못했다 — public/data/krx-daily 수집 상태를 확인하라')

  const limits = [...KRX_DAILY_LIMITS]
  limits.push(
    `수정주가 반영 ${appliedEvents}건 · 미보정(유상증자형·[미검증] 저신뢰) ${skippedEvents}건 — 미보정 종목은 그날 가격이 계단처럼 끊긴 채 계산된다.`,
  )
  limits.push('시가총액은 **원주가 × 상장주식수**다(수정주가로 만들면 분할일에 시총이 조용히 줄어 PBR이 붕괴한다).')
  return { histories, caps, names, sourceNote: krxDailySourceNote(index), limits, missing, appliedEvents, skippedEvents }
}

export interface FundamentalLoad extends FundamentalStore {
  sourceNote: string
  limits: string[]
  /** index에는 있으나 요청 코드에 없던 것이 아니라, **요청했는데 재무 파일이 없는** 코드. */
  missing: string[]
  asOf: string
  latestRceptDt: string
}

/** DART 재무 정본 로드 + 위생 게이트. 요청한 코드만 읽는다(파일 수 = 유니버스 크기). */
export function loadFundamentals(codes: readonly string[], root = ROOT): FundamentalLoad {
  const index = parseFundamentalIndex(readJson(join(root, DART_FUNDAMENTALS_DIR, 'index.json'), 'DART 재무 index.json'))
  const entryOf = new Map(index.stocks.map((s) => [s.code, s]))
  const stocks: { code: string; name: string; records: FundamentalRecord[] }[] = []
  const missing: string[] = []
  for (const code of [...new Set(codes)].sort()) {
    const entry = entryOf.get(code)
    if (!entry) {
      missing.push(code)
      continue
    }
    const st = parseFundamentalStock(readJson(join(root, DART_FUNDAMENTALS_DIR, entry.file), `DART 재무 ${code}`))
    stocks.push({ code: st.code, name: st.name, records: st.records })
  }
  if (stocks.length === 0) throw new Error('요청한 유니버스 종목의 재무 파일을 하나도 찾지 못했다')
  const store = screenFundamentals(stocks)
  return {
    ...store,
    sourceNote:
      `재무: ${index.source} FY${index.fromYear}~${index.toYear} (${index.basis}) · 수집일 ${index.asOf} · ` +
      `유니버스 ${stocks.length}종목 로드 · 최신 접수일 ${index.latestRceptDt}`,
    limits: index.limits,
    missing,
    asOf: index.asOf,
    latestRceptDt: index.latestRceptDt,
  }
}

// ---------------------------------------------------------------- 유니버스

export interface ValueUniverse {
  width: UniverseWidth
  years: number[]
  codesFor: (y: number) => string[]
  union: string[]
  sourceNote: string
}

/** KRX 실측 랭킹 파일 → 이 회차의 유니버스(2015~2026으로 잘라 쓴다). */
export function loadValueUniverse(root = ROOT): { narrow: ValueUniverse; wide: ValueUniverse } {
  const u = parseKrxPitUniverse(readJson(join(root, KRX_PIT_PATH), 'KRX 실측 유니버스'))
  const years = krxPitYears(u).filter((y) => y >= VALUE_FROM_YEAR && y <= VALUE_TO_YEAR)
  if (years.length === 0)
    throw new Error(`실측 유니버스에 ${VALUE_FROM_YEAR}~${VALUE_TO_YEAR} 연도가 없다 — EC2 MODE=pityear로 다시 수집하라`)
  for (let i = 1; i < years.length; i++)
    if (years[i] !== years[i - 1] + 1) throw new Error(`실측 유니버스 ${years[i - 1]}~${years[i]} 사이에 결측 연도가 있다`)

  const make = (width: UniverseWidth, n: number): ValueUniverse => {
    const codesFor = (y: number) => [...krxPitMarketCodes(u, y, 'kospi', n), ...krxPitMarketCodes(u, y, 'kosdaq', n)]
    const set = new Set<string>()
    for (const y of years) for (const c of codesFor(y)) set.add(c)
    return { width, years: [...years], codesFor, union: [...set].sort(), sourceNote: krxPitSourceNote(u) }
  }
  return { narrow: make('10+10', 10), wide: make('40+40', 40) }
}

// ============================================================================
// 7. 벤치마크 — 야후(KODEX 200) 또는 오프라인(유니버스 동일가중)
// ============================================================================

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * 야후 일봉. `scripts/shortterm-lab.entry.ts`와 **같은 규약**(총수익 보정 · KST 날짜)이다.
 * idea-lab의 로더가 export돼 있지 않아 복제한다 — 정본 합류는 별도 작업이다.
 */
export async function fetchDaily(symbol: string, range = VALUE_BENCH_RANGE): Promise<DailyBar[]> {
  const qs = range.startsWith('since:')
    ? `period1=${Math.floor(Date.parse(range.slice(6)) / 1000)}&period2=${Math.floor(Date.now() / 1000)}`
    : `range=${range}`
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?${qs}&interval=1d&events=div%2Csplit`
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
    // 총수익 보정(규칙 3): adjclose ÷ close 계수를 OHLC에 적용
    const fac = adj[i] != null && Number.isFinite(adj[i] as number) && cl > 0 ? (adj[i] as number) / cl : 1
    const date = new Date(ts[i] * 1000 + 9 * 3600 * 1000).toISOString().slice(0, 10) // KST
    out.push({ date, t: ts[i], o: o * fac, h: h * fac, l: l * fac, c: cl * fac, v: Number.isFinite(v) ? v : 0 })
  }
  return out
}

/**
 * 유니버스 **동일가중 지수**(오프라인 벤치·참고 벽). 매일 그날 봉이 있는 종목의 일별
 * 수익률을 단순평균해 잇는다.
 *
 * ⚠️ 이것은 KODEX 200이 **아니다.** 34·36차 알파와 나란히 읽으면 안 된다. 그리고 KRX
 *    정본은 **배당 미반영**(가격수익)이라 야후 총수익 계열보다 구조적으로 낮게 나온다.
 */
export function equalWeightIndex(
  histories: Record<string, DailyBar[]>,
  codes: readonly string[],
  from: string,
): { date: string; equity: number }[] {
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
  const out: { date: string; equity: number }[] = []
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

/** QQQ 원화 환산 보유 곡선(참고 벽). 실패하면 null — 벽 행만 빠지고 모드는 계속 돈다. */
async function loadQqqKrwCurve(): Promise<{ curve: { date: string; equity: number }[]; note: string } | null> {
  try {
    const qqq = await fetchDaily('QQQ')
    await sleep(120)
    const fx = await fetchDaily('KRW=X')
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
// 8. 출력 표
// ============================================================================

const pctOrDash = (v: number | null) => (v == null ? '—' : `${f1(v)}%p`)
const num = (v: number | null | undefined, d = 3) => (v == null || !Number.isFinite(v) ? '—' : v.toFixed(d))

export function variantTable(results: readonly VariantResult[], half: number, benchLabel: string): void {
  log('')
  log(`## 18변형 성적 (벤치 = ${benchLabel} · 규칙 5 — 판정은 알파로)`)
  log(
    `| 변형 | 계열 | 유니버스 | **칼마** | CAGR | MDD | 알파(전 구간) | 전반(~${half - 1}) 알파 | 후반(${half}~) 알파 | 매매 | 무후보 리밸런스 | 판정 |`,
  )
  log('|---|---|---|---|---|---|---|---|---|---|---|---|')
  for (const r of results) {
    const bad = valueFailReasons(r)
    log(
      `| ${r.variant.label} | ${r.variant.group} | ${r.variant.width} | ${num(calmarOf(r.row.full))} | ` +
        `${f1(r.row.full.cagr)}% | ${f1(r.row.full.mdd)}% | ${pctOrDash(r.row.alphaFull)} | ` +
        `${pctOrDash(r.row.alphaA)} | ${pctOrDash(r.row.alphaB)} | ${r.trades} | ` +
        `${r.emptyRebalances}/${r.diag.rebalances} | ${bad.length === 0 ? '✅' : `❌(${bad.join('·')})`} |`,
    )
  }
  const firsts = results.map((r) => r.diag.firstCandidateDate).filter((d): d is string => d !== null)
  const first = firsts.length > 0 ? firsts.slice().sort()[0] : null
  log('※ "무후보 리밸런스"는 그 달 후보가 하나도 없어 **전액 현금**이던 달이다. 실행에서 관측된 첫 후보 발생일은')
  log(
    `  **${first ?? '없음(전 구간 무후보 — 재무 로딩을 확인하라)'}** — 그 전까지는 DART 사업보고서가 아직 접수되기 전이라 ` +
      '어떤 변형도 후보를 만들 수 없다. 18변형이 공통으로 지는 핸디캡이라 상대 비교는 성립하지만 절대 CAGR은 낮아진다.',
  )
}

export function diagTable(results: readonly VariantResult[]): void {
  log('')
  log('## 랭킹 제외 진단 — 적자·자본잠식·재무없음으로 빠진 종목 (누계, 리밸런스 전체 합)')
  log('| 변형 | 후보(누계) | 제외(누계) | 주요 사유 |')
  log('|---|---|---|---|')
  for (const r of results) {
    const top = [...r.diag.byReason.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([k, v]) => `${k} ${v}`)
      .join(' · ')
    log(`| ${r.variant.label} | ${r.diag.candidates} | ${r.diag.excluded} | ${top || '—'} |`)
  }
  log('※ 제외는 **랭킹에서 뺀 것**이지 배제한 데이터가 아니다(위생 게이트와 다른 층이다).')
  log('  적자 종목의 PER, 자본잠식 종목의 PBR·ROE를 0·음수로 두면 **최악의 회사가 최고 점수**를 받는다.')
}

export function perYearValueTable(results: readonly VariantResult[]): void {
  log('')
  log('## 연도별 수익 분해 (거짓 매끈함 방지)')
  const head = results.map((r) => r.variant.label)
  log(`| 연도 | ${head.join(' | ')} |`)
  log(`|---|${results.map(() => '---').join('|')}|`)
  const years = results[0].row.perYear.map((p) => p.y)
  for (const [i, y] of years.entries())
    log(`| ${y} | ${results.map((r) => `${f1(((r.row.perYear[i]?.ret ?? 1) - 1) * 100)}%`).join(' | ')} |`)
}

// ---- 과최적화 3표 -----------------------------------------------------------

export interface OverfitOut {
  pbo: number | null
  dsrRound: number | null
  dsrCumulative: number | null
  winnerLabel: string | null
  wfAlpha: number | null
}

export function overfitTables(
  results: readonly VariantResult[],
  benchCurveIn: readonly { date: string; equity: number }[] | null,
): OverfitOut {
  const out: OverfitOut = { pbo: null, dsrRound: null, dsrCumulative: null, winnerLabel: null, wfAlpha: null }
  const mm = monthlyMatrix(
    results.map((r) => r.chain.equity),
    benchCurveIn ?? undefined,
  )
  log('')
  log('# 과최적화 채점 — "찾았다"가 아니라 "찾은 것이 우연일 확률"')
  log('')
  log(
    `월별 수익률 행렬: 변형 ${mm.matrix.length}개 × 시점 ${mm.months.length}개월` +
      `${mm.months.length > 0 ? ` (${mm.months[0]}~${mm.months[mm.months.length - 1]})` : ''}` +
      `${mm.dropped > 0 ? ` · 정렬 불가로 버린 달 ${mm.dropped}개` : ''}`,
  )
  if (mm.months.length < 30) {
    log(`⛔ 월별 관측이 ${mm.months.length}개뿐이라 DSR·PBO를 신뢰할 수 없다 — 채점을 건너뛴다(0으로 채우지 않는다).`)
    return out
  }

  // ① DSR
  const sharpes: number[] = []
  for (const row of mm.matrix) {
    const s = sharpeMetric(row)
    if (s !== null) sharpes.push(s)
  }
  let winner = -1
  let best = -Infinity
  for (let i = 0; i < mm.matrix.length; i++) {
    const s = sharpeMetric(mm.matrix[i])
    if (s === null) continue
    if (s > best) {
      best = s
      winner = i
    }
  }
  log('')
  log('## ① Deflated Sharpe Ratio — 시도 횟수를 감안해도 유의한가')
  if (winner < 0) {
    log('⛔ 모든 변형의 월별 샤프를 계산할 수 없다 — 승자를 정할 수 없어 DSR을 건너뛴다.')
  } else {
    const w = results[winner]
    out.winnerLabel = w.variant.label
    const m = sharpeMoments(mm.matrix[winner])
    log(`승자(월별 샤프 1위): **${w.variant.label}** · 관측 샤프 ${num(m.sharpe, 4)} · 표본 ${m.sampleLength}개월 · 왜도 ${num(m.skew)} · 첨도 ${num(m.kurtosis)}`)
    if (m.sharpe === null) {
      log(`⛔ DSR 계산 불가 — ${m.reason}`)
    } else {
      const rep = multipleTestingReport({
        observedSharpe: m.sharpe,
        sampleLength: m.sampleLength,
        trialSharpeVariance: variance(sharpes),
        skew: m.skew ?? undefined,
        kurtosis: m.kurtosis ?? undefined,
        trialsThisRound: VALUE_TRIALS,
        trialsCumulative: VALUE_TRIALS_CUMULATIVE,
      })
      out.dsrRound = rep.thisRound.dsr
      out.dsrCumulative = rep.cumulative.dsr
      log('')
      log('| 분모 | 시도 N | E[max SR] | DSR | 판정 |')
      log('|---|---|---|---|---|')
      for (const [label, r, n] of [
        ['이번 회차(38차)', rep.thisRound, rep.trialsThisRound],
        ['**누적(진짜 분모)**', rep.cumulative, rep.trialsCumulative],
      ] as const)
        log(
          `| ${label} | ${n} | ${num(r.expectedMaxSharpe, 4)} | ${num(r.dsr, 4)} | ` +
            `${r.dsr === null ? `— (${r.reason})` : r.dsr >= DSR_PASS_THRESHOLD ? '유의' : '유의하다고 말할 수 없음'} |`,
        )
      log('')
      log(`보정 전 p=${num(rep.rawPValue, 6)} · Šidák p=${num(rep.sidakPValue, 6)} · Bonferroni p=${num(rep.bonferroniPValue, 6)}`)
      log(`누적 분모 내역: ${VALUE_TRIALS_PRIOR.map((p) => `${p.round} ${p.n}`).join(' + ')} + 이번 ${VALUE_TRIALS} = **${VALUE_TRIALS_CUMULATIVE}**`)
      log(`▶ ${rep.headline}`)
      for (const note of rep.cumulative.notes) log(`· ${note}`)
    }
  }

  // ② PBO
  log('')
  log('## ② PBO (CSCV) — 인샘플 1위가 아웃샘플에서 중앙값 이하로 떨어질 확률')
  const pbo = computePbo(mm.matrix, { blocks: VALUE_PBO_BLOCKS })
  if (pbo.pbo === null) {
    log(`⛔ 계산 불가 — ${pbo.reason}`)
  } else {
    out.pbo = pbo.pbo
    log(
      `블록 S=${pbo.blocks}(블록당 ${pbo.blockSize}개월, 버림 ${pbo.droppedObservations}) · ` +
        `조합 ${pbo.combinationsEvaluated}/${pbo.combinationsTotal}${pbo.exhaustive ? ' (전수)' : ' (등간격 결정적 샘플링)'}`,
    )
    log(`**PBO = ${num(pbo.pbo, 4)}** · λ중앙값 ${num(pbo.medianLambda)} · IS 1위의 평균 OOS 상대순위 ω=${num(pbo.meanOosRank)}`)
    log(`▶ ${pbo.overfitLikely ? '⚠️ 탐색의 산물일 가능성이 높다' : '순위가 아웃샘플에서 유지되는 편'} (임계 ${PBO_WARN_THRESHOLD})`)
    for (const note of pbo.notes) log(`· ${note}`)
  }
  log('')
  log('⚠️ **PBO 단일 수치를 단정적으로 읽지 마라.** 알파가 0인 합성 데이터에서도 시드에 따라 0.14~0.87로')
  log('   흔들린다(도구 자기검증 실측 · `tests/overfit.test.ts`). "PBO≈0.5"는 여러 독립 실현의 **기대값**에서')
  log('   성립하는 성질이지 한 회차에서 보장되는 값이 아니다 — 이 숫자 하나로 결론짓지 말고 DSR·워크포워드와')
  log('   **함께** 읽어라. 특히 18변형의 수익률은 서로 강하게 상관돼 있어(같은 유니버스·같은 리밸런스일)')
  log('   순위가 잡음에 지배되고 PBO는 0.5로 끌린다.')

  // ③ 워크포워드
  log('')
  log('## ③ 워크포워드 — 롤링 IS에서 변형을 고르고 **직후 OOS 구간만** 성적으로 인정')
  const wf = walkForwardScore(mm.matrix, {
    isWindow: VALUE_WF_IS_MONTHS,
    oosWindow: VALUE_WF_OOS_MONTHS,
    periodsPerYear: VALUE_PERIODS_PER_YEAR,
    benchmark: mm.bench ?? undefined,
  })
  if (wf.reason !== null) {
    log(`⛔ 계산 불가 — ${wf.reason}`)
  } else {
    out.wfAlpha = wf.oosAlphaPct
    log(`창: IS ${VALUE_WF_IS_MONTHS}개월 / OOS ${VALUE_WF_OOS_MONTHS}개월(스텝) · 구간 ${wf.segments.length}개`)
    log('')
    log('| # | IS 구간 | OOS 구간 | 선택된 변형 | IS 샤프 | OOS 샤프 |')
    log('|---|---|---|---|---|---|')
    const dt = (i: number) => mm.months[i] ?? String(i)
    for (const s of wf.segments)
      log(
        `| ${s.index} | ${dt(s.isFrom)}~${dt(s.isTo - 1)} | ${dt(s.oosFrom)}~${dt(s.oosTo - 1)} | ` +
          `${results[s.selectedVariant]?.variant.label ?? `변형${s.selectedVariant}`} | ${num(s.isMetric, 4)} | ${num(s.oosMetric, 4)} |`,
      )
    log('')
    log(`OOS 누적 ${num(wf.oosTotalReturnPct, 2)}% · OOS 연환산 ${num(wf.oosAnnualizedPct, 2)}% · 벤치 연환산 ${num(wf.benchAnnualizedPct, 2)}%`)
    log(`**OOS 알파 ${num(wf.oosAlphaPct, 2)}%p** · IS→OOS 저하율 ${num(wf.degradationPct, 1)}% (IS중앙값 ${num(wf.medianIsMetric, 4)} → OOS중앙값 ${num(wf.medianOosMetric, 4)})`)
    log('해석: OOS 알파 ≤ 0이면 "매년 성적 좋은 변형으로 갈아타는" 절차가 실전에서 벤치를 못 이긴다는 뜻이다.')
    for (const note of wf.notes) log(`· ${note}`)
  }
  return out
}

export function headline(
  results: readonly VariantResult[],
  of: OverfitOut,
  wall: CalWall | null,
  years: readonly number[],
  half: number,
): number {
  const passed = results.filter((r) => valuePass(r))
  const overWall = wall?.calmar == null ? [] : passed.filter((r) => (calmarOf(r.row.full) ?? -Infinity) > (wall.calmar as number))
  log('')
  log('# 헤드라인')
  log('')
  log(
    `## 통과 ${passed.length}개 · PBO ${num(of.pbo, 3)} · DSR(이번 ${VALUE_TRIALS}) ${num(of.dsrRound, 3)} · ` +
      `DSR(누적 ${VALUE_TRIALS_CUMULATIVE}) ${num(of.dsrCumulative, 3)}`,
  )
  log('')
  log(`판정 3요소: ① 전·후반 **모두** 알파 양수 ② 청산완료 매매 ≥ ${VALUE_MIN_TRADES}건 ③ 칼마(CAGR÷MDD)로 서열.`)
  if (passed.length === 0) {
    log('')
    log('## ❌ **통과 0개.** 18변형 중 전·후반 알파가 모두 양수이면서 표본이 충분한 변형은 **하나도 없다.**')
    log('')
    log('이것은 실패한 실험이 아니라 **결과**다. 이 탐색 공간(저PBR·저PER·고ROE 단일/복합 랭킹, 상위 3·5·16,')
    log('시장게이트 on/off)에서는 KRX 실측 10+10·40+40 유니버스 위에서 벤치를 이기는 조합을 찾지 못했다.')
    log('"가장 덜 나쁜 칸"을 골라 프리셋으로 올리는 것은 33차가 무너진 것과 **같은 종류의 사후선택**이다.')
  } else {
    log('')
    log(`통과 ${passed.length}개: ${passed.map((r) => r.variant.label).join(' · ')}`)
    if (wall?.calmar != null) {
      if (overWall.length === 0) {
        log('')
        log(`## ❌ 통과분 중 **${wall.label} 벽(칼마 ${num(wall.calmar)})을 넘은 것은 없다.**`)
        log('판정만 통과하고 벽을 못 넘었다면, 그 변형을 채택할 이유는 "원화로 나스닥100을 그냥 들고 있는 것"보다')
        log('나은 게 없다는 뜻이다 — 34차와 같은 결론이다.')
      } else {
        log('')
        log(`## ⚠️ ${wall.label} 벽을 넘은 변형 ${overWall.length}개: ${overWall.map((r) => r.variant.label).join(' · ')}`)
        log('넘었다고 채택이 아니다. 아래 과최적화 3지표(DSR·PBO·워크포워드)를 **같은 무게로** 읽어야 한다 —')
        log(`누적 ${VALUE_TRIALS_CUMULATIVE}회 시도의 분모에서 DSR이 ${DSR_PASS_THRESHOLD} 미만이면 "찾았다"고 말할 수 없다.`)
      }
    } else {
      log('⚠️ 참고 벽 곡선을 만들지 못해 벽 판정은 **성립하지 않는다.** "벽을 넘었다/못 넘었다"로 읽지 마라.')
    }
  }
  log('')
  log(shortSampleNote(years, half))
  return passed.length
}

export function disclaimer(offline: boolean): void {
  log('')
  log('---')
  log('⚠️ **투자자문이 아니다.** 위 수치는 과거 시뮬레이션의 사후 통계이며 미래 수익을 보장하지 않는다.')
  log('   손실 경로: 밸류 계열은 저평가 상태가 몇 년씩 지속될 수 있고(가치 함정), 상위 3~5종목 집중은')
  log('   개별 종목 사고에 그대로 노출된다. 최대낙폭(MDD) 열을 수익률과 같은 무게로 읽어라.')
  log('   무효화 지점: 전·후반 중 한 구간이라도 알파가 음수로 뒤집히면 그 변형의 근거는 사라진다.')
  log('')
  log('⚠️ **데이터 한계(규칙 3)**')
  if (offline) {
    log('   · 전략과 벤치가 **같은 KRX 정본**(배당 미반영·가격수익)이라 배당 편향은 서로 상쇄된다 —')
    log('     대신 벤치가 KODEX 200이 아니므로 이 알파는 이전 회차 알파와 **다른 물건**이다.')
  } else {
    log('   · KRX 일별 정본은 **배당 미반영**(가격수익)인데 벤치(야후 KODEX 200)는 **총수익**이다 —')
    log('     알파는 그만큼 **전략에 불리한 쪽으로** 편향돼 있다(배당수익률만큼).')
  }
  log('   · 재무는 사업보고서 **연간값만** 쓴다(분기 누적/개별 여부 [미검증]). 그래서 신규 정보 반영이')
  log('     연 1회로 늦다 — 분기 반영 버전은 이 회차에 없다.')
  log('   · DART 재무는 **2015년부터**다. 실행 시작일부터 첫 사업보고서가 접수되기 전까지는 후보가 없어')
  log('     전액 현금이다(첫 후보 발생일은 위 변형 표 각주에 실측으로 찍는다).')
  log('   · 유니버스는 KRX 실측(연도별 시총 상위)이라 **생존편향은 랭킹 쪽에는 없지만**, 상장폐지 종목의')
  log('     시세가 상폐 전날까지만 있어 마지막 정리매매 구간은 반영되지 않는다.')
  if (offline) {
    log('   · ⚠️ **[벤치=유니버스 동일가중]** — 이 실행의 알파는 KODEX 200 알파가 **아니다.**')
    log('     34·36차 표 옆에 놓고 읽으면 안 된다. 정식 판정은 `MODE=all`(GHA)로 다시 돌려야 한다.')
  }
}

// ============================================================================
// 9. 실행
// ============================================================================

/** 산출된 표의 수 — 0이면 비정상 종료한다(규칙 4: 전량 실패가 종료코드 0이 되는 것을 막는다). */
let produced = 0

function runOneVariant(
  v: ValueVariant,
  yearly: YearSlice[],
  deps: ValueDeps,
  benchEq: { date: string; equity: number }[],
  half: number,
): VariantResult {
  const diag = newRankDiag()
  const rank = makeValueRankFn(deps, v.factors, diag)
  // 시장게이트 = 34차와 **같은 정본 함수**(idea-lab `makeRegimeExposure`). 벤치 곡선의 12-1
  // 모멘텀이 음수인 달은 노출 0 → 월 첫 거래일 시가에 전량 매도하고 그 달을 현금으로 넘긴다
  // (청산·재매수 비용을 그대로 문다). 판정 불가(데이터 부족)면 **열림(1)**이다.
  // ⚠️ 게이트가 보는 곡선은 알파 계산에 쓰는 벤치와 **같은 곡선**이다 — offline 모드에서는
  //    그것이 KODEX 200이 아니라 유니버스 동일가중 지수라 게이트의 의미도 함께 달라진다.
  const exposure = v.gate ? makeRegimeExposure(benchEq, 'mom12_1') : undefined
  const chain = runCustomChain(
    yearly,
    (slice) => simulateRankYear(slice.hist, `${slice.y}-01-01`, slice.syms, COST, { slots: v.slots, rank, exposure }),
    COST,
    v.slots,
  )
  return {
    variant: v,
    row: summarizeStrat(v.label, chain, benchEq, half),
    chain,
    trades: chain.closed,
    diag,
    emptyRebalances: diag.emptyRebalances,
  }
}

async function run(mode: 'all' | 'offline'): Promise<void> {
  const offline = mode === 'offline'
  log('# MODE=value — 밸류·퀄리티 팩터 18변형 (38차)')
  log('')
  log('저PBR·저PER·고ROE를 KRX 실측 유니버스 위에서 월 리밸런스로 돌린다. 유니버스·비용·판정 프레임은')
  log('34차(krxcal)·36차(short)와 같고 **랭킹 지표만** 바뀐다 — 그래야 "재무 신호가 가격 신호보다 나은가"가')
  log('나란히 읽힌다. 변형은 **18개 고정**이며 늘리지 않는다(누적 시도가 DSR의 분모다).')
  if (offline) {
    log('')
    log('## ⚠️ [벤치=유니버스 동일가중 · KODEX 200 아님] — 오프라인 모드')
    log('네트워크 없이 도는 검증용 실행이다. 이 표의 알파는 34·36차 알파와 **다른 기준**이므로 나란히 읽지 마라.')
  }

  // ---- 유니버스 ----
  const { narrow, wide } = loadValueUniverse()
  const years = narrow.years
  const half = halfYearOf(years)
  log('')
  log(`⚠️ ${narrow.sourceNote}`)
  log(
    `실행 구간 ${VALUE_FROM}~${VALUE_TO} (${years[0]}~${years[years.length - 1]} · ${years.length}년) · ` +
      `전·후반 경계 **${half}**(구간 중앙에서 자동 계산 — 하드코딩 아님)`,
  )
  log(`유니버스 10+10 고유 ${narrow.union.length}종목 · 40+40 고유 ${wide.union.length}종목 · 월 리밸런스(월 첫 거래일 시가)`)
  log(`비용: 수수료 ${COST.feePct}% · 거래세 ${COST.taxPct}% · 슬리피지 ${COST.slippagePct}% (34·36차와 동일)`)

  // ---- 시세·재무 정본 ----
  const allCodes = [...new Set([...narrow.union, ...wide.union])].sort()
  const prices = loadKrxPrices(allCodes)
  log('')
  log(`⚠️ ${prices.sourceNote}`)
  log(`시세 로드 ${Object.keys(prices.histories).length}/${allCodes.length}${prices.missing.length ? ` · 수집 범위 밖: ${prices.missing.join(', ')}` : ''}`)
  for (const l of prices.limits) log(`  ⚠️ ${l}`)

  const fund = loadFundamentals(allCodes)
  log('')
  log(`⚠️ ${fund.sourceNote}`)
  if (fund.missing.length > 0)
    log(`⚠️ 재무 파일이 없는 유니버스 종목 ${fund.missing.length}개: ${fund.missing.join(', ')} — 이 종목은 어떤 팩터 랭킹에도 못 들어간다.`)
  for (const l of fund.limits) log(`  ⚠️ ${l}`)

  hygieneTable(fund.report)
  produced++

  const deps: ValueDeps = { records: fund.clean, caps: prices.caps }

  // ---- 벤치마크 ----
  let benchEq: { date: string; equity: number }[]
  let benchLabel: string
  if (offline) {
    benchEq = equalWeightIndex(prices.histories, narrow.union, '2013-01-01')
    benchLabel = '유니버스 10+10 동일가중 지수 [KODEX 200 아님]'
    if (benchEq.length < 2) throw new Error('오프라인 벤치(동일가중 지수)를 만들지 못했다 — 시세 로드를 확인하라')
  } else {
    let bench: DailyBar[]
    try {
      bench = await fetchDaily(BENCH)
    } catch (e) {
      // 조용한 폴백 금지 — 벤치가 없으면 규칙 5의 판정 자체가 성립하지 않는다.
      throw new Error(
        `벤치(${BENCH}) 로드 실패 — ${String(e)}. 알파(규칙 5)를 낼 수 없으므로 실행을 중단한다. ` +
          '네트워크가 막힌 환경이면 MODE=offline으로 돌려라(그 경우 벤치가 달라지므로 34·36차 표와 비교 불가).',
      )
    }
    if (bench.length < 2) throw new Error(`벤치(${BENCH}) 봉이 ${bench.length}개다 — 알파를 낼 수 없다`)
    benchEq = benchCurve(bench)
    benchLabel = `${BENCH} KODEX 200`
    log('')
    log(`벤치 ${BENCH} ${bench.length}봉 (${bench[0].date}~${bench[bench.length - 1].date}) — 알파는 겹치는 구간에서만 계산한다.`)
  }

  // ---- 18변형 실행 ----
  const variants = valueVariants()
  const yearlyNarrow = buildYearly(prices.histories, years, narrow.codesFor)
  const yearlyWide = buildYearly(prices.histories, years, wide.codesFor)
  log('')
  log(`연도별 매핑(10+10): ${yearlyNarrow.map((v) => `${v.y} ${v.mapped}`).join(' · ')}`)
  log(`연도별 매핑(40+40): ${yearlyWide.map((v) => `${v.y} ${v.mapped}`).join(' · ')}`)

  const results: VariantResult[] = []
  for (const v of variants) {
    const yearly = v.width === '40+40' ? yearlyWide : yearlyNarrow
    results.push(runOneVariant(v, yearly, deps, benchEq, half))
  }

  variantTable(results, half, benchLabel)
  log(shortSampleNote(years, half))
  produced++

  diagTable(results)
  perYearValueTable(results)
  produced++

  // ---- 참고 벽 ----
  const walls: CalWall[] = []
  const ewIndex = equalWeightIndex(prices.histories, narrow.union, VALUE_FROM)
  const ew = wallOf('유니버스 10+10 동일가중 보유 [배당 미반영]', ewIndex, VALUE_FROM, VALUE_TO)
  if (ew) walls.push(ew)
  if (!offline) {
    const kw = wallOf(`${BENCH} KODEX 200 보유`, benchEq, VALUE_FROM, VALUE_TO)
    if (kw) walls.push(kw)
  }
  let qqqWall: CalWall | null = null
  if (!offline) {
    const qqq = await loadQqqKrwCurve()
    if (qqq) {
      qqqWall = wallOf('QQQ 원화 환산 보유', qqq.curve, VALUE_FROM, VALUE_TO)
      if (qqqWall) {
        walls.push(qqqWall)
        log('')
        log(`QQQ 벽 근거 — ${qqq.note}`)
      }
    }
  }
  if (walls.length > 0) {
    wallTable(walls)
    log('※ 벽은 **같은 구간으로 다시 잰** 값이다(옮겨 적은 수치가 아니다). 구간이 다르면 비교가 성립하지 않는다.')
    produced++
  } else {
    log('')
    log('⚠️ 참고 벽을 하나도 만들지 못했다 — 벽 판정은 생략한다(없다고 읽지 마라).')
  }

  // ---- 과최적화 채점 ----
  const of = overfitTables(results, benchEq)
  produced++

  headline(results, of, qqqWall, years, half)
  disclaimer(offline)
}

/** 위생 게이트만 — 네트워크·시세 로딩 없이 배제 규칙의 실측 결과를 본다. */
function runHygiene(): void {
  log('# MODE=hygiene — 재무 위생 게이트 리포트 (네트워크 불필요)')
  const { narrow, wide } = loadValueUniverse()
  const codes = [...new Set([...narrow.union, ...wide.union])].sort()
  const fund = loadFundamentals(codes)
  log('')
  log(`⚠️ ${fund.sourceNote}`)
  hygieneTable(fund.report, 30)
  produced++
}

const MODES: Record<string, () => Promise<void>> = {
  all: () => run('all'),
  offline: () => run('offline'),
  hygiene: async () => runHygiene(),
}

// 런처(scripts/value-lab.mjs)만 VALUE_LAB_RUN=1을 넘긴다. 테스트가 이 모듈을
// import할 때는 자동 실행되지 않는다.
if (process.env.VALUE_LAB_RUN === '1') {
  const mode = process.env.MODE ?? 'all'
  const entry = MODES[mode]
  if (!entry) {
    console.error(`알 수 없는 MODE=${mode} — 가능: ${Object.keys(MODES).join(', ')}`)
    process.exit(1)
  }
  entry()
    .then(() => {
      // 규칙 4 — 항목별 오류를 삼켜 "다 실패했는데 종료코드 0"이 되는 것을 막는다.
      if (produced === 0) {
        console.error('⛔ 산출된 표가 하나도 없다 — 정본 데이터·입력을 확인할 것')
        process.exit(1)
      }
    })
    .catch((e) => {
      console.error('실행 실패:', e)
      process.exit(1)
    })
}
