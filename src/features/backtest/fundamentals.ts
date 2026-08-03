// DART 재무 정본 — 스키마·파서·**PIT(시점 고정) 필터**·밸류/퀄리티 팩터 산출.
//
// ─────────────────────────────────────────────────────────────────────────────
// 이 파일의 핵심은 PIT 필터 하나다
// ─────────────────────────────────────────────────────────────────────────────
// 재무제표는 **사업연도가 끝난 뒤 몇 달 지나서 공시된다.** FY2023 사업보고서는
// 2024년 3월에 접수된다. 그런데 데이터에는 `bsns_year=2023`이라고 적혀 있으므로,
// "2023년 시점의 PBR"을 `bsnsYear === 2023`으로 고르면 **2024년 3월에야 알 수 있던
// 숫자를 2023년 내내 쓴 것**이 된다. 이게 규칙 1(미래참조 금지)의 재무판이고,
// 백테스트를 통째로 거짓으로 만드는 가장 흔한 경로다.
//
//   ✅ 옳은 기준: `rceptDt <= D` 인 레코드 중 가장 최신 (접수일 = 공시가 세상에 나온 날)
//   ⛔ 틀린 기준: `bsnsYear <= D의 연도` (그 시점엔 아직 공시되지 않았다)
//
// 그래서 선택 함수 이름에 전부 `KnownAt`(그 시점에 **알려져 있던**)을 박았고,
// `tests/fundamentals.test.ts`의 **PIT 불변성** 테스트가 이를 집행한다 —
// D 이후에 접수된 레코드를 입력에 아무리 더 넣어도 D 시점 팩터가 변하면 실패다.
// (시세 쪽 절단 불변성 테스트 `tests/lookahead.test.ts`와 같은 성질의 재무판이다.)
//
// ─────────────────────────────────────────────────────────────────────────────
// 확정된 사실 (2026-08-03 EC2 실호출 · `scripts/fundamental-probe.mjs`)
// ─────────────────────────────────────────────────────────────────────────────
//   · 금액 단위 = **원(KRW)**. 항등식 자산=부채+자본 통과, 삼성전자 매출 배율 1.000000.
//   · 값은 **콤마 포함 문자열**, 없으면 `"-"` → `dartNum()`이 null로 만든다(0 금지).
//   · `rcept_no` 14자리 = `YYYYMMDD` + 일련번호 6. 접수일이 전부 사업연도 종료 이후임을
//     9건으로 확인 → **PIT 기준일로 사용 가능**.
//   · 실패는 HTTP가 아니라 **본문 `status`**로 온다(HTTP는 항상 200).
//   · ⚠️ **잘못된 `reprt_code`(99999)를 API가 `000`으로 통과시킨다.** 그러므로 파라미터
//     화이트리스트 검증은 **우리가** 해야 한다 → `assertDartReprtCode`.
//   · 재무데이터 시작 = **2015년**(그 이전은 `013`).
//
// 이 파일은 브라우저 번들에도 들어갈 수 있으므로 **node:fs를 import하지 않는다.**
// 파일 입출력·네트워크는 부르는 쪽(`scripts/dart-fundamental-backfill.entry.ts`)이 하고,
// 여기서는 순수 데이터 변환·검증만 한다(krxDailyPrices.ts·krxPitUniverse.ts와 같은 철학).

import type { KrxDailyIndex, KrxDailyStock } from './krxDailyPrices'

// ---------------------------------------------------------------- 상수·경로

/** 리포 기준 상대 경로 — 쓰는 쪽·읽는 쪽이 같은 상수를 쓴다(경로가 갈리는 사고 방지). */
export const DART_FUNDAMENTALS_DIR = 'public/data/dart-fundamentals'
export const DART_FUNDAMENTALS_INDEX_PATH = `${DART_FUNDAMENTALS_DIR}/index.json`

/** 종목 파일 경로(index 안의 file 필드와 같은 규약). */
export function dartFundamentalFile(code: string): string {
  return `stocks/${code}.json`
}

export const DART_FUNDAMENTALS_SCHEMA_INDEX = 'dart-fundamentals/index@1'
export const DART_FUNDAMENTALS_SCHEMA_STOCK = 'dart-fundamentals/stock@1'

export const DART_FUNDAMENTALS_SOURCE = 'DART OpenAPI (fnlttSinglAcntAll.json)'
export const DART_FUNDAMENTALS_BASIS =
  '단일회사 전체 재무제표 · 금액 원(KRW) · PIT 기준일 = rcept_no 접수일'

/** 화면·로그·PR에 그대로 붙이는 한계 목록(규칙 3 — 출처·한계를 확인 가능하게). */
export const DART_FUNDAMENTALS_LIMITS: readonly string[] = [
  '**2015년 이전 없음** — DART OpenAPI 재무데이터 시작이 2015년이다(2014 이하는 status 013). 단축구간(2015~) 전용.',
  '연결(CFS)이 없는 종목은 별도(OFS)로 폴백한다 — 섞였다는 사실을 레코드마다 fsDiv로 남긴다. 연결/별도를 가로질러 비교하면 규모가 달라진다.',
  '자본·순이익은 **지배주주 귀속분 우선**, 없으면 총계로 폴백한다(레코드의 equitySource·netIncomeSource에 기록).',
  '분기보고서의 thstrm_amount가 3개월치인지 누적인지는 **[미검증]** — 기본 경로는 사업보고서 연간값만 쓴다(TTM은 명시적 opt-in).',
  '보고서 기간 종료일은 **12월 결산 가정**으로 유도한다([미검증]) — 정렬에만 쓰이고 PIT 판정은 접수일로만 한다.',
  '정정공시는 접수일이 늦은 별개 레코드로 들어온다 — 시점 D에서는 D까지 접수된 것만 보이므로 정정 이전 시점은 정정 이전 값을 쓴다(의도된 동작).',
  '시가총액은 KRX 일별 정본(원주가 종가 × 상장주식수)에서 유도한다 — 우선주·자기주식 조정 없음.',
]

/** 배지 한 줄 — 팩터 표·그래프 옆에 붙인다. */
export const DART_FUNDAMENTALS_BADGE = 'DART 실측 재무(원 단위) · PIT 접수일 기준 · 2015~'

// ------------------------------------------------------- DART status 코드

export const DART_STATUS_OK = '000'
/** 조회된 데이터 없음 — **정상 0건**이다. 실패(키오류·한도)와 절대 섞지 마라. */
export const DART_STATUS_EMPTY = '013'

export const DART_STATUS_MEANING: Readonly<Record<string, string>> = {
  '000': '정상',
  '010': '등록되지 않은 키',
  '011': '사용할 수 없는 키',
  '013': '조회된 데이터 없음(정상 0건)',
  '020': '요청 제한 초과(일 20,000건)',
  '021': '조회 가능한 회사 개수 초과',
  '100': '필드의 부적절한 값',
  '101': '부적절한 접근',
  '800': '시스템 점검',
  '900': '정의되지 않은 오류',
  '901': '사용자 계정의 개인정보보유기간 만료',
}

export function dartStatusMeaning(status: string): string {
  return DART_STATUS_MEANING[status] ?? '[미검증] 표에 없는 코드'
}

/** 실패 성격 — 수집기가 "정상 0건"과 "실패 0건"을 구분하는 근거(규칙 4). */
export type DartStatusKind = 'ok' | 'empty' | 'auth' | 'quota' | 'maintenance' | 'bad-request' | 'unknown'

export function dartStatusKind(status: string): DartStatusKind {
  if (status === DART_STATUS_OK) return 'ok'
  if (status === DART_STATUS_EMPTY) return 'empty'
  if (status === '010' || status === '011' || status === '101' || status === '901') return 'auth'
  if (status === '020' || status === '021') return 'quota'
  if (status === '800') return 'maintenance'
  if (status === '100') return 'bad-request'
  return 'unknown'
}

// ---------------------------------------------- 파라미터 화이트리스트(자체 검증)

/**
 * 보고서 코드. **API가 걸러주지 않는다** — 실측에서 `reprt_code=99999`가 `status=000`으로
 * 통과했다. 그래서 호출 전에 우리가 막는다(규칙 4: 모르는 부분은 실패로 가정).
 */
export const DART_REPRT_CODES = ['11011', '11012', '11013', '11014'] as const
export type DartReprtCode = (typeof DART_REPRT_CODES)[number]

export const DART_FS_DIVS = ['CFS', 'OFS'] as const
export type DartFsDiv = (typeof DART_FS_DIVS)[number]

const REPRT_META: Readonly<Record<DartReprtCode, { quarter: 1 | 2 | 3 | 4; label: string; monthDay: string }>> = {
  '11013': { quarter: 1, label: '1분기보고서', monthDay: '03-31' },
  '11012': { quarter: 2, label: '반기보고서', monthDay: '06-30' },
  '11014': { quarter: 3, label: '3분기보고서', monthDay: '09-30' },
  '11011': { quarter: 4, label: '사업보고서', monthDay: '12-31' },
}

export function dartReprtLabel(code: DartReprtCode): string {
  return REPRT_META[code].label
}

/** 그 보고서가 덮는 분기(1~4). 정렬용 — PIT 판정에는 쓰지 않는다. */
export function dartReprtQuarter(code: DartReprtCode): 1 | 2 | 3 | 4 {
  return REPRT_META[code].quarter
}

export function isDartReprtCode(v: unknown): v is DartReprtCode {
  return typeof v === 'string' && (DART_REPRT_CODES as readonly string[]).includes(v)
}

export function isDartFsDiv(v: unknown): v is DartFsDiv {
  return typeof v === 'string' && (DART_FS_DIVS as readonly string[]).includes(v)
}

/** @throws 화이트리스트에 없는 보고서 코드 — 던져서 호출 자체를 막는다. */
export function assertDartReprtCode(v: unknown): DartReprtCode {
  if (!isDartReprtCode(v))
    throw new Error(
      `reprt_code가 화이트리스트에 없다 (${String(v)}) — 허용: ${DART_REPRT_CODES.join('/')}. ` +
        'DART는 잘못된 reprt_code도 status=000으로 통과시키므로 여기서 막아야 한다.',
    )
  return v
}

/** @throws 화이트리스트에 없는 fs_div. */
export function assertDartFsDiv(v: unknown): DartFsDiv {
  if (!isDartFsDiv(v)) throw new Error(`fs_div가 화이트리스트에 없다 (${String(v)}) — 허용: ${DART_FS_DIVS.join('/')}`)
  return v
}

/**
 * 보고서 기간 종료일(YYYY-MM-DD). **12월 결산 가정** — [미검증].
 * 정렬(어느 보고서가 더 최근 기간인가)에만 쓰고, **PIT 판정에는 절대 쓰지 않는다**
 * (PIT는 접수일 `rceptDt`로만 한다).
 */
export function dartPeriodEnd(bsnsYear: number, reprtCode: DartReprtCode): string {
  return `${String(bsnsYear).padStart(4, '0')}-${REPRT_META[reprtCode].monthDay}`
}

// ---------------------------------------------------------------- 값 변환

/**
 * DART 금액 문자열 → 숫자. 콤마를 걷어내고, 없는 값(`"-"`·빈값)은 **null**이다.
 * 0으로 뭉개면 자본잠식·적자와 "데이터 없음"이 구분되지 않는다(랭킹이 뒤집힌다).
 */
export function dartNum(v: unknown): number | null {
  if (v == null) return null
  const s = String(v).replace(/,/g, '').trim()
  if (!s || s === '-' || s === 'N/A') return null
  // 괄호 음수 표기 (1,234) → -1234 (DART는 보통 부호를 쓰지만 방어)
  const neg = /^\((.*)\)$/.exec(s)
  const n = Number(neg ? `-${neg[1]}` : s)
  return Number.isFinite(n) ? n : null
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/**
 * `rcept_no`(14자리 = YYYYMMDD + 일련번호 6) → 접수일 `YYYY-MM-DD`.
 * **이 날짜가 PIT 기준일이다.**
 * @throws 형식이 다르거나 날짜가 실재하지 않으면 던진다(조용한 폴백 금지).
 */
export function rceptNoToDate(rceptNo: unknown): string {
  const s = String(rceptNo ?? '').trim()
  if (!/^\d{14}$/.test(s)) throw new Error(`rcept_no가 14자리 숫자가 아니다 (${s || '없음'}) — PIT 기준일을 만들 수 없다`)
  const y = Number(s.slice(0, 4))
  const m = Number(s.slice(4, 6))
  const d = Number(s.slice(6, 8))
  const date = `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`
  const dt = new Date(`${date}T00:00:00Z`)
  if (
    y < 1990 ||
    y > 2100 ||
    m < 1 ||
    m > 12 ||
    d < 1 ||
    d > 31 ||
    Number.isNaN(dt.getTime()) ||
    dt.toISOString().slice(0, 10) !== date
  )
    throw new Error(`rcept_no의 접수일이 실재하는 날짜가 아니다 (${s} → ${date})`)
  return date
}

// ------------------------------------------------------------------ 스키마

/** 지배주주 귀속분을 썼는가, 총계를 썼는가 — 숨기지 않고 레코드에 박는다. */
export type AttributionBasis = 'parent' | 'total'

/**
 * 재무 레코드 한 건 = **보고서 한 개**.
 *
 * PIT의 전부는 `rceptDt`다. `bsnsYear`는 "언제의 실적인가"일 뿐 "언제 알 수 있었나"가
 * 아니다 — 둘을 헷갈리면 미래참조가 된다.
 */
export interface FundamentalRecord {
  /** 사업연도(실적의 시점). **선택 기준으로 쓰지 마라.** */
  bsnsYear: number
  reprtCode: DartReprtCode
  /** 연결(CFS)인지 별도(OFS)인지 — 폴백이 일어났는지 행마다 드러낸다. */
  fsDiv: DartFsDiv
  /** 접수번호 14자리. */
  rceptNo: string
  /** **접수일(YYYY-MM-DD) = PIT 기준일.** 이 날짜 이후 시점에서만 이 레코드를 쓸 수 있다. */
  rceptDt: string
  /** 자본총계(원). 지배주주 귀속 우선. */
  equity: number | null
  equitySource: AttributionBasis | null
  /** 자산총계(원). */
  assets: number | null
  /** 부채총계(원). */
  liabilities: number | null
  /** 당기순이익(원) — 보고서의 `thstrm_amount`. 분기보고서에서는 3개월/누적 여부 [미검증]. */
  netIncome: number | null
  netIncomeSource: AttributionBasis | null
  /** 당기 **누적** 순이익(원) — 분기보고서의 `thstrm_add_amount`. 없으면 null. */
  netIncomeAdd: number | null
  /** 매출액(원). */
  revenue: number | null
  revenueAdd: number | null
  /** 영업이익(원). */
  operatingIncome: number | null
  operatingIncomeAdd: number | null
}

export interface FundamentalStock {
  schema: string
  /** 6자리 종목코드(KRX). */
  code: string
  /** 8자리 DART 고유번호. */
  corpCode: string
  name: string
  /** 'KRW' 고정 — 실측 확정(2026-08-03). */
  unit: 'KRW'
  /** 접수일 오름차순(동일 접수일은 rceptNo 오름차순). */
  records: FundamentalRecord[]
}

export interface FundamentalIndexEntry {
  code: string
  corpCode: string
  name: string
  records: number
  firstYear: number
  lastYear: number
  /** 이 종목에서 가장 늦게 접수된 보고서 날짜 — "언제까지 받았나"가 눈에 보이게. */
  latestRceptDt: string
  /** 실제로 쓰인 fs_div들(연결/별도 혼합 여부를 index에서 바로 본다). */
  fsDivs: DartFsDiv[]
  file: string
}

export interface FundamentalIndex {
  schema: string
  version: number
  source: string
  basis: string
  /** 수집 실행일(YYYY-MM-DD, KST). */
  asOf: string
  fromYear: number
  toYear: number
  /** 수집한 보고서 종류. */
  reprtCodes: DartReprtCode[]
  /** 파일에 저장한 계정 목록 — 용량 예산으로 추렸으면 그 사실이 여기 남는다. */
  accounts: string[]
  /** 용량 예산 때문에 계정을 추렸는가. */
  accountsTrimmed: boolean
  /** 요청했지만 데이터가 하나도 없던 종목(코드) — 결측을 숨기지 않는다. */
  missingCodes: string[]
  /** corp_code 매핑에 실패한 종목(코드) — 생존편향 크기를 드러낸다. */
  unmappedCodes: string[]
  /** 전 종목 통틀어 가장 늦은 접수일 — "언제 멈췄는지" 한 줄로 보인다(규칙 4). */
  latestRceptDt: string
  limits: string[]
  stocks: FundamentalIndexEntry[]
}

// -------------------------------------------------------------------- 파서

function fail(what: string, msg: string): never {
  throw new Error(`${what} 스키마 위반 — ${msg}`)
}

function asArray(v: unknown, what: string, where: string): unknown[] {
  if (!Array.isArray(v)) fail(what, `${where}가 배열이 아니다`)
  return v
}

function optNum(v: unknown, what: string, where: string): number | null {
  if (v == null) return null
  const n = Number(v)
  if (!Number.isFinite(n)) fail(what, `${where}가 수치도 null도 아니다 (${String(v)})`)
  return n
}

function parseAttribution(v: unknown, what: string, where: string): AttributionBasis | null {
  if (v == null) return null
  const s = String(v)
  if (s !== 'parent' && s !== 'total') fail(what, `${where}가 parent/total/null이 아니다 (${s})`)
  return s
}

/** 레코드 하나를 검증하며 읽는다. 계정이 **전부 null**이면 거부한다(빈 껍데기 금지). */
export function parseFundamentalRecord(raw: unknown, what: string, where: string): FundamentalRecord {
  if (typeof raw !== 'object' || raw == null) fail(what, `${where}가 객체가 아니다`)
  const o = raw as Record<string, unknown>
  const bsnsYear = Number(o.bsnsYear)
  if (!Number.isInteger(bsnsYear) || bsnsYear < 1990 || bsnsYear > 2100) fail(what, `${where}.bsnsYear가 연도가 아니다 (${String(o.bsnsYear)})`)
  const reprtCode = o.reprtCode
  if (!isDartReprtCode(reprtCode)) fail(what, `${where}.reprtCode가 화이트리스트에 없다 (${String(reprtCode)})`)
  const fsDiv = o.fsDiv
  if (!isDartFsDiv(fsDiv)) fail(what, `${where}.fsDiv가 CFS/OFS가 아니다 (${String(fsDiv)})`)
  const rceptNo = String(o.rceptNo ?? '')
  if (!/^\d{14}$/.test(rceptNo)) fail(what, `${where}.rceptNo가 14자리가 아니다 (${rceptNo || '없음'})`)
  const rceptDt = String(o.rceptDt ?? '')
  if (!DATE_RE.test(rceptDt)) fail(what, `${where}.rceptDt가 YYYY-MM-DD가 아니다 (${rceptDt || '없음'})`)
  if (rceptNoToDate(rceptNo) !== rceptDt) fail(what, `${where}.rceptDt(${rceptDt})가 rceptNo 앞 8자리와 다르다 (${rceptNo})`)
  // 접수일은 반드시 사업연도 종료 이후다(실측 9/9). 아니면 PIT 근거가 깨진 것이다.
  if (rceptDt <= `${bsnsYear}-01-01`)
    fail(what, `${where}: 접수일(${rceptDt})이 사업연도(${bsnsYear}) 시작보다 이르다 — PIT 근거 위반`)

  const rec: FundamentalRecord = {
    bsnsYear,
    reprtCode,
    fsDiv,
    rceptNo,
    rceptDt,
    equity: optNum(o.equity, what, `${where}.equity`),
    equitySource: parseAttribution(o.equitySource, what, `${where}.equitySource`),
    assets: optNum(o.assets, what, `${where}.assets`),
    liabilities: optNum(o.liabilities, what, `${where}.liabilities`),
    netIncome: optNum(o.netIncome, what, `${where}.netIncome`),
    netIncomeSource: parseAttribution(o.netIncomeSource, what, `${where}.netIncomeSource`),
    netIncomeAdd: optNum(o.netIncomeAdd, what, `${where}.netIncomeAdd`),
    revenue: optNum(o.revenue, what, `${where}.revenue`),
    revenueAdd: optNum(o.revenueAdd, what, `${where}.revenueAdd`),
    operatingIncome: optNum(o.operatingIncome, what, `${where}.operatingIncome`),
    operatingIncomeAdd: optNum(o.operatingIncomeAdd, what, `${where}.operatingIncomeAdd`),
  }
  const anyValue = [rec.equity, rec.assets, rec.liabilities, rec.netIncome, rec.revenue, rec.operatingIncome].some(
    (v) => v != null,
  )
  if (!anyValue) fail(what, `${where}: 6개 계정이 전부 null이다 — 빈 레코드를 저장하지 마라(못 찾았으면 실패로 셀 것)`)
  if (rec.equity != null && rec.equitySource == null) fail(what, `${where}.equitySource가 없다 — 지배주주/총계 구분을 숨기지 마라`)
  if (rec.netIncome != null && rec.netIncomeSource == null) fail(what, `${where}.netIncomeSource가 없다`)
  return rec
}

/**
 * `stocks/{code}.json`을 검증하며 읽는다. **거부하는 것**:
 *   · 스키마·코드 형식 위반, 단위가 KRW가 아님
 *   · 레코드가 접수일 오름차순이 아님(정렬을 믿고 이진탐색하므로)
 *   · (rceptNo) 중복 — 같은 공시를 두 번 담으면 랭킹이 흔들린다
 */
export function parseFundamentalStock(raw: unknown): FundamentalStock {
  const W = 'dart-fundamentals/stock'
  if (typeof raw !== 'object' || raw == null) fail(W, '최상위가 객체가 아니다')
  const o = raw as Record<string, unknown>
  const schema = String(o.schema ?? '')
  if (schema !== DART_FUNDAMENTALS_SCHEMA_STOCK) fail(W, `schema가 ${DART_FUNDAMENTALS_SCHEMA_STOCK}가 아니다 (${schema || '없음'})`)
  const code = String(o.code ?? '')
  if (!/^\d{6}$/.test(code)) fail(W, `code가 6자리가 아니다 (${code || '없음'})`)
  const corpCode = String(o.corpCode ?? '')
  if (!/^\d{8}$/.test(corpCode)) fail(W, `${code}: corpCode가 8자리가 아니다 (${corpCode || '없음'})`)
  const name = String(o.name ?? '')
  if (!name.trim()) fail(W, `${code}: name이 비어 있다`)
  if (o.unit !== 'KRW') fail(W, `${code}: unit이 'KRW'가 아니다 — 금액 단위는 원으로 확정됐다(2026-08-03 실측)`)

  const rowsRaw = asArray(o.records, W, `${code}.records`)
  if (rowsRaw.length === 0) fail(W, `${code}: records가 비어 있다 — 데이터 없는 종목은 index.missingCodes로 남긴다`)
  const seen = new Set<string>()
  const records: FundamentalRecord[] = []
  rowsRaw.forEach((r, i) => {
    const rec = parseFundamentalRecord(r, W, `${code}.records[${i}]`)
    const key = `${rec.rceptNo}|${rec.fsDiv}`
    if (seen.has(key)) fail(W, `${code}: records에 중복(${key})이 있다`)
    seen.add(key)
    if (i > 0) {
      const prev = records[i - 1]
      if (rec.rceptDt < prev.rceptDt || (rec.rceptDt === prev.rceptDt && rec.rceptNo < prev.rceptNo))
        fail(W, `${code}: records[${i}](${rec.rceptDt}/${rec.rceptNo})가 접수일 오름차순이 아니다`)
    }
    records.push(rec)
  })

  return { schema, code, corpCode, name, unit: 'KRW', records }
}

/** `index.json`을 검증하며 읽는다. 한계 표기 삭제·결측 은닉을 거부한다. */
export function parseFundamentalIndex(raw: unknown): FundamentalIndex {
  const W = 'dart-fundamentals/index.json'
  if (typeof raw !== 'object' || raw == null) fail(W, '최상위가 객체가 아니다')
  const o = raw as Record<string, unknown>
  if (String(o.schema ?? '') !== DART_FUNDAMENTALS_SCHEMA_INDEX)
    fail(W, `schema가 ${DART_FUNDAMENTALS_SCHEMA_INDEX}가 아니다 (${String(o.schema ?? '없음')})`)
  const version = Number(o.version)
  if (!Number.isInteger(version) || version < 1) fail(W, `version이 1 이상의 정수가 아니다 (${String(o.version)})`)
  const source = String(o.source ?? '')
  const basis = String(o.basis ?? '')
  const asOf = String(o.asOf ?? '')
  if (!source.trim()) fail(W, 'source가 비어 있다')
  if (!basis.trim()) fail(W, 'basis가 비어 있다')
  if (!DATE_RE.test(asOf)) fail(W, `asOf가 YYYY-MM-DD가 아니다 (${asOf || '없음'})`)
  const fromYear = Number(o.fromYear)
  const toYear = Number(o.toYear)
  if (!Number.isInteger(fromYear) || !Number.isInteger(toYear) || fromYear > toYear)
    fail(W, `fromYear/toYear가 올바른 연도 구간이 아니다 (${String(o.fromYear)}~${String(o.toYear)})`)
  const reprtCodes = asArray(o.reprtCodes, W, 'reprtCodes').map((c, i) => {
    if (!isDartReprtCode(c)) fail(W, `reprtCodes[${i}]가 화이트리스트에 없다 (${String(c)})`)
    return c
  })
  if (reprtCodes.length === 0) fail(W, 'reprtCodes가 비어 있다')
  const accounts = asArray(o.accounts, W, 'accounts').map(String)
  if (accounts.length === 0) fail(W, 'accounts가 비어 있다 — 무엇을 저장했는지 밝혀라')
  const accountsTrimmed = o.accountsTrimmed
  if (typeof accountsTrimmed !== 'boolean') fail(W, 'accountsTrimmed가 boolean이 아니다')
  const limits = asArray(o.limits, W, 'limits').map(String)
  if (limits.length === 0) fail(W, 'limits가 비어 있다 — 한계 표기를 지우지 마라(규칙 3)')
  const codeList = (v: unknown, where: string): string[] =>
    asArray(v, W, where).map((c, i) => {
      const s = String(c)
      if (!/^\d{6}$/.test(s)) fail(W, `${where}[${i}]가 6자리 종목코드가 아니다 (${s})`)
      return s
    })
  const missingCodes = codeList(o.missingCodes, 'missingCodes')
  const unmappedCodes = codeList(o.unmappedCodes, 'unmappedCodes')
  const latestRceptDt = String(o.latestRceptDt ?? '')
  if (!DATE_RE.test(latestRceptDt)) fail(W, `latestRceptDt가 YYYY-MM-DD가 아니다 (${latestRceptDt || '없음'})`)

  const stocksRaw = asArray(o.stocks, W, 'stocks')
  if (stocksRaw.length === 0) fail(W, 'stocks가 비어 있다')
  const seen = new Set<string>()
  const stocks: FundamentalIndexEntry[] = stocksRaw.map((r, i) => {
    if (typeof r !== 'object' || r == null) fail(W, `stocks[${i}]가 객체가 아니다`)
    const e = r as Record<string, unknown>
    const code = String(e.code ?? '')
    if (!/^\d{6}$/.test(code)) fail(W, `stocks[${i}].code가 6자리가 아니다 (${code || '없음'})`)
    if (seen.has(code)) fail(W, `stocks에 중복 종목코드 ${code}가 있다`)
    seen.add(code)
    const corpCode = String(e.corpCode ?? '')
    if (!/^\d{8}$/.test(corpCode)) fail(W, `stocks[${i}].corpCode가 8자리가 아니다 (${code})`)
    const name = String(e.name ?? '')
    if (!name.trim()) fail(W, `stocks[${i}].name이 비어 있다 (${code})`)
    const records = Number(e.records)
    if (!Number.isInteger(records) || records < 1) fail(W, `stocks[${i}].records가 1 이상의 정수가 아니다 (${code})`)
    const firstYear = Number(e.firstYear)
    const lastYear = Number(e.lastYear)
    if (!Number.isInteger(firstYear) || !Number.isInteger(lastYear) || firstYear > lastYear)
      fail(W, `stocks[${i}]의 firstYear/lastYear가 올바르지 않다 (${code})`)
    const latest = String(e.latestRceptDt ?? '')
    if (!DATE_RE.test(latest)) fail(W, `stocks[${i}].latestRceptDt가 YYYY-MM-DD가 아니다 (${code})`)
    const fsDivs = asArray(e.fsDivs, W, `stocks[${i}].fsDivs`).map((d, j) => {
      if (!isDartFsDiv(d)) fail(W, `stocks[${i}].fsDivs[${j}]가 CFS/OFS가 아니다 (${String(d)})`)
      return d
    })
    if (fsDivs.length === 0) fail(W, `stocks[${i}].fsDivs가 비어 있다 (${code}) — 연결/별도 혼합 사실을 숨기지 마라`)
    const file = String(e.file ?? '')
    if (file !== dartFundamentalFile(code)) fail(W, `stocks[${i}].file이 규약(${dartFundamentalFile(code)})과 다르다 (${file || '없음'})`)
    return { code, corpCode, name, records, firstYear, lastYear, latestRceptDt: latest, fsDivs, file }
  })

  return {
    schema: DART_FUNDAMENTALS_SCHEMA_INDEX,
    version,
    source,
    basis,
    asOf,
    fromYear,
    toYear,
    reprtCodes,
    accounts,
    accountsTrimmed,
    missingCodes,
    unmappedCodes,
    latestRceptDt,
    limits,
    stocks,
  }
}

/** 출처 한 줄(규칙 3 — 실데이터 라벨). */
export function dartFundamentalsSourceNote(idx: FundamentalIndex): string {
  return (
    `재무: ${idx.source} FY${idx.fromYear}~${idx.toYear} (${idx.basis}) · 수집일 ${idx.asOf} · ` +
    `${idx.stocks.length}종목 · 최신 접수일 ${idx.latestRceptDt} · ` +
    `보고서 ${idx.reprtCodes.map(dartReprtLabel).join('/')} · 데이터없음 ${idx.missingCodes.length}종목`
  )
}

// ------------------------------------------------- DART 응답 → 레코드 추출

/** 계정 매칭 규격 — `account_id`(IFRS 태그) 우선, 없으면 `account_nm` 관용 매칭. */
interface AccountSpec {
  /** account_id 접두 후보(우선순위 순). */
  ids: string[]
  /** account_nm 후보(공백 제거 후 완전일치, 우선순위 순). */
  names: string[]
  /** 재무제표 구분 — 우선 이 안에서 찾고, 없으면 전체에서 찾는다. */
  sj: string[]
}

const SPEC_BS = ['BS'] as const
const SPEC_IS = ['IS', 'CIS'] as const

/** 지배주주 귀속 자본 → 없으면 자본총계. 어느 쪽을 썼는지 `equitySource`에 남긴다. */
const EQUITY_PARENT: AccountSpec = {
  ids: ['ifrs-full_EquityAttributableToOwnersOfParent', 'ifrs_EquityAttributableToOwnersOfParent'],
  names: ['지배기업의소유주에게귀속되는자본', '지배기업소유주지분', '지배기업의소유주지분', '지배주주지분'],
  sj: [...SPEC_BS],
}
const EQUITY_TOTAL: AccountSpec = {
  ids: ['ifrs-full_Equity', 'ifrs_Equity'],
  names: ['자본총계'],
  sj: [...SPEC_BS],
}
const ASSETS: AccountSpec = { ids: ['ifrs-full_Assets', 'ifrs_Assets'], names: ['자산총계'], sj: [...SPEC_BS] }
const LIABILITIES: AccountSpec = {
  ids: ['ifrs-full_Liabilities', 'ifrs_Liabilities'],
  names: ['부채총계'],
  sj: [...SPEC_BS],
}
const NI_PARENT: AccountSpec = {
  ids: ['ifrs-full_ProfitLossAttributableToOwnersOfParent', 'ifrs_ProfitLossAttributableToOwnersOfParent'],
  names: ['지배기업의소유주에게귀속되는당기순이익(손실)', '지배기업소유주지분', '지배기업의소유주에게귀속되는당기순이익'],
  sj: [...SPEC_IS],
}
const NI_TOTAL: AccountSpec = {
  ids: ['ifrs-full_ProfitLoss', 'ifrs_ProfitLoss'],
  names: ['당기순이익', '당기순이익(손실)', '당기순손익', '분기순이익', '반기순이익', '연결당기순이익'],
  sj: [...SPEC_IS],
}
const REVENUE: AccountSpec = {
  ids: ['ifrs-full_Revenue', 'ifrs_Revenue', 'ifrs-full_RevenueFromContractsWithCustomers'],
  names: ['매출액', '수익(매출액)', '영업수익', '매출'],
  sj: [...SPEC_IS],
}
const OPERATING: AccountSpec = {
  ids: ['dart_OperatingIncomeLoss', 'ifrs-full_ProfitLossFromOperatingActivities'],
  names: ['영업이익', '영업이익(손실)', '영업손익'],
  sj: [...SPEC_IS],
}

/** 파일에 저장하는 계정 목록 — index.accounts에 그대로 박는다. */
export const DART_STORED_ACCOUNTS: readonly string[] = [
  '자본총계(지배주주 우선)',
  '자산총계',
  '부채총계',
  '당기순이익(지배주주 우선)',
  '매출액',
  '영업이익',
]

type DartRow = Record<string, unknown>

function normName(v: unknown): string {
  return String(v ?? '').replace(/\s/g, '')
}

function findAccount(list: DartRow[], spec: AccountSpec): DartRow | null {
  const inSj = list.filter((r) => spec.sj.includes(String(r.sj_div ?? '')))
  const pool = inSj.length > 0 ? inSj : list
  for (const id of spec.ids) {
    const hit = pool.find((r) => String(r.account_id ?? '').startsWith(id))
    if (hit) return hit
  }
  for (const nm of spec.names) {
    const hit = pool.find((r) => normName(r.account_nm) === nm)
    if (hit) return hit
  }
  return null
}

/** 응답 최상위에서 status·message·list를 꺼낸다. @throws 객체가 아니거나 status가 없으면. */
export function readDartEnvelope(json: unknown): { status: string; message: string; list: DartRow[] } {
  if (typeof json !== 'object' || json == null) throw new Error('DART 응답이 객체가 아니다')
  const o = json as Record<string, unknown>
  const status = String(o.status ?? '')
  if (!status) throw new Error('DART 응답에 status가 없다 — 스키마 변경 의심(HTTP 200이어도 본문 status가 진실이다)')
  const list = Array.isArray(o.list) ? (o.list as DartRow[]) : []
  return { status, message: String(o.message ?? ''), list }
}

export interface RecordMeta {
  bsnsYear: number
  reprtCode: DartReprtCode
  fsDiv: DartFsDiv
}

/**
 * `fnlttSinglAcntAll.json`의 `list` → 레코드 1건.
 *
 * **하나도 못 찾으면 던진다**(규칙 4) — 0으로 채우면 자본잠식·적자와 구분되지 않고,
 * 계정 스키마가 바뀐 사고가 "정상적으로 수집된 0"으로 위장된다.
 *
 * @throws list가 비었거나 / 응답 메타가 요청과 다르거나 / 6개 계정을 하나도 못 찾으면
 */
export function extractFundamentalRecord(list: DartRow[], meta: RecordMeta): FundamentalRecord {
  assertDartReprtCode(meta.reprtCode)
  assertDartFsDiv(meta.fsDiv)
  if (!Array.isArray(list) || list.length === 0)
    throw new Error(`FY${meta.bsnsYear} ${meta.reprtCode} ${meta.fsDiv}: status=000인데 list가 비었다 — 스키마 변경 의심`)

  const rceptNo = String(list[0].rcept_no ?? '')
  const rceptDt = rceptNoToDate(rceptNo)
  // 응답이 요청과 같은 보고서인지 확인 — API가 파라미터를 무시해도 조용히 넘어가지 않는다.
  const respReprt = String(list[0].reprt_code ?? '')
  if (respReprt && respReprt !== meta.reprtCode)
    throw new Error(`요청 reprt_code=${meta.reprtCode}인데 응답은 ${respReprt}다 — 파라미터가 무시됐다`)
  const respYear = String(list[0].bsns_year ?? '')
  if (respYear && Number(respYear) !== meta.bsnsYear)
    throw new Error(`요청 bsns_year=${meta.bsnsYear}인데 응답은 ${respYear}다 — 파라미터가 무시됐다`)

  const pick = (spec: AccountSpec): { cur: number | null; add: number | null; row: DartRow | null } => {
    const row = findAccount(list, spec)
    if (!row) return { cur: null, add: null, row: null }
    return { cur: dartNum(row.thstrm_amount), add: dartNum(row.thstrm_add_amount), row }
  }

  const eqParent = pick(EQUITY_PARENT)
  const eqTotal = pick(EQUITY_TOTAL)
  const equity = eqParent.cur ?? eqTotal.cur
  const equitySource: AttributionBasis | null = eqParent.cur != null ? 'parent' : eqTotal.cur != null ? 'total' : null

  const niParent = pick(NI_PARENT)
  const niTotal = pick(NI_TOTAL)
  const useParentNi = niParent.cur != null
  const netIncome = useParentNi ? niParent.cur : niTotal.cur
  const netIncomeAdd = useParentNi ? niParent.add : niTotal.add
  const netIncomeSource: AttributionBasis | null = useParentNi ? 'parent' : niTotal.cur != null ? 'total' : null

  const assets = pick(ASSETS)
  const liabilities = pick(LIABILITIES)
  const revenue = pick(REVENUE)
  const operating = pick(OPERATING)

  const rec: FundamentalRecord = {
    bsnsYear: meta.bsnsYear,
    reprtCode: meta.reprtCode,
    fsDiv: meta.fsDiv,
    rceptNo,
    rceptDt,
    equity,
    equitySource,
    assets: assets.cur,
    liabilities: liabilities.cur,
    netIncome,
    netIncomeSource,
    netIncomeAdd,
    revenue: revenue.cur,
    revenueAdd: revenue.add,
    operatingIncome: operating.cur,
    operatingIncomeAdd: operating.add,
  }

  const found = [rec.equity, rec.assets, rec.liabilities, rec.netIncome, rec.revenue, rec.operatingIncome].filter(
    (v) => v != null,
  ).length
  if (found === 0)
    throw new Error(
      `FY${meta.bsnsYear} ${meta.reprtCode} ${meta.fsDiv} (${list.length}행): 6개 계정을 하나도 찾지 못했다 — ` +
        `account_id/account_nm 스키마 변경. 0으로 채우지 않고 실패로 센다. ` +
        `표본 account_nm: ${list.slice(0, 5).map((r) => String(r.account_nm ?? '?')).join('/')}`,
    )
  return rec
}

/** 회계 항등식 자기검증 — 자산 = 부채 + 자본. 셋 다 있을 때만 판정한다. */
export function checkAccountingIdentity(rec: FundamentalRecord, tol = 0.005): { checked: boolean; ok: boolean; err: number } {
  // 항등식은 **총계** 기준이다. 지배주주 자본을 썼으면(비지배지분이 빠져) 성립하지 않으므로 건너뛴다.
  if (rec.assets == null || rec.liabilities == null || rec.equity == null || rec.equitySource !== 'total' || rec.assets === 0)
    return { checked: false, ok: true, err: 0 }
  const err = Math.abs(rec.assets - (rec.liabilities + rec.equity)) / Math.abs(rec.assets)
  return { checked: true, ok: err <= tol, err }
}

// ---------------------------------------------------------------- PIT 필터

/**
 * 정렬 키 — (사업연도, 분기, 접수일, 접수번호) 오름차순.
 * **D에 의존하지 않는다**(의존하면 절단 불변성이 깨진다).
 */
function periodKey(r: FundamentalRecord): string {
  return `${String(r.bsnsYear).padStart(4, '0')}-${dartReprtQuarter(r.reprtCode)}-${r.rceptDt}-${r.rceptNo}`
}

export interface PitSelectOptions {
  /**
   * 후보로 볼 보고서 종류. 기본은 **사업보고서(11011)만** — 분기의 누적/개별 여부가
   * [미검증]이라 보수적 경로를 기본값으로 둔다.
   */
  reprtCodes?: readonly DartReprtCode[]
  /** 후보로 볼 fs_div. 기본은 둘 다(연결 우선 수집 결과를 그대로 쓴다). */
  fsDivs?: readonly DartFsDiv[]
}

/**
 * **시점 D에서 알려져 있던 재무 레코드**를 고른다 — 이 프로젝트의 PIT 규약.
 *
 *   후보 = `rceptDt <= asOf` 인 것 **뿐이다**. (`bsnsYear`로 고르면 미래참조 — 규칙 1)
 *   그중 (사업연도, 분기)가 가장 최근인 것, 같으면 **접수일이 가장 늦은 것**(= 정정본).
 *
 * 그래서 D보다 나중에 접수된 정정공시는 D 시점 계산에 절대 끼지 않는다.
 * `tests/fundamentals.test.ts`의 PIT 불변성·정정공시 폴백 테스트가 이를 강제한다.
 */
export function selectFundamentalKnownAt(
  records: readonly FundamentalRecord[],
  asOf: string,
  opts: PitSelectOptions = {},
): FundamentalRecord | null {
  if (!DATE_RE.test(asOf)) throw new Error(`asOf가 YYYY-MM-DD가 아니다 (${asOf})`)
  const reprtOk = opts.reprtCodes ?? (['11011'] as const)
  const fsOk = opts.fsDivs ?? DART_FS_DIVS
  let best: FundamentalRecord | null = null
  let bestKey = ''
  for (const r of records) {
    if (r.rceptDt > asOf) continue // ← PIT 경계. 이 한 줄이 미래참조를 막는다.
    if (!reprtOk.includes(r.reprtCode)) continue
    if (!fsOk.includes(r.fsDiv)) continue
    const k = periodKey(r)
    if (best === null || k > bestKey) {
      best = r
      bestKey = k
    }
  }
  return best
}

/** D 시점에 알려져 있던 레코드 전부(접수일 오름차순) — 진단·TTM 계산용. */
export function recordsKnownAt(records: readonly FundamentalRecord[], asOf: string): FundamentalRecord[] {
  if (!DATE_RE.test(asOf)) throw new Error(`asOf가 YYYY-MM-DD가 아니다 (${asOf})`)
  return records
    .filter((r) => r.rceptDt <= asOf)
    .slice()
    .sort((a, b) => (periodKey(a) < periodKey(b) ? -1 : periodKey(a) > periodKey(b) ? 1 : 0))
}

// ------------------------------------------------------------- 순이익 기준

/**
 * 순이익 산출 기준.
 *   `annual`          — 사업보고서 연간 순이익만 사용(**기본값 · 보수적**)
 *   `ttm-unverified`  — 분기 누적으로 4분기 합산. 분기 `thstrm_amount`의 3개월/누적 여부가
 *                       [미검증]이라 **명시적 opt-in에서만** 나온다.
 */
export type NetIncomeBasis = 'annual' | 'ttm-unverified' | 'none'

export interface NetIncomeResult {
  value: number | null
  basis: NetIncomeBasis
  record: FundamentalRecord | null
  notes: string[]
}

export interface NetIncomeOptions {
  /**
   * `annual`(기본) — 사업보고서 연간값만. `ttm`은 분기 누적 합산을 시도하되
   * 근거가 모자라면 **조용히 넘어가지 않고** annual로 내려오며 note를 남긴다.
   */
  mode?: 'annual' | 'ttm'
}

function annualNetIncome(records: readonly FundamentalRecord[], asOf: string): NetIncomeResult {
  const rec = selectFundamentalKnownAt(records, asOf, { reprtCodes: ['11011'] })
  if (!rec) return { value: null, basis: 'none', record: null, notes: ['D 시점에 접수된 사업보고서가 없다'] }
  if (rec.netIncome == null)
    return { value: null, basis: 'none', record: rec, notes: [`FY${rec.bsnsYear} 사업보고서에 당기순이익 계정이 없다`] }
  return { value: rec.netIncome, basis: 'annual', record: rec, notes: [] }
}

/**
 * 시점 D의 순이익. **기본은 연간(사업보고서)**이다.
 *
 * TTM 경로([미검증], opt-in): 최신 분기(Y, Q)의 누적 + 전년 연간 − 전년 같은 분기 누적.
 * 누적 금액(`thstrm_add_amount`)이 없으면 계산하지 않고 annual로 내려온다 —
 * 3개월치를 누적인 척 더하면 순이익이 최대 4배로 부풀고 PER이 4분의 1이 된다.
 */
export function netIncomeKnownAt(
  records: readonly FundamentalRecord[],
  asOf: string,
  opts: NetIncomeOptions = {},
): NetIncomeResult {
  const mode = opts.mode ?? 'annual'
  if (mode === 'annual') return annualNetIncome(records, asOf)

  const known = recordsKnownAt(records, asOf)
  const latest = known.length > 0 ? known[known.length - 1] : null
  if (!latest) return { value: null, basis: 'none', record: null, notes: ['D 시점에 접수된 보고서가 없다'] }
  if (latest.reprtCode === '11011') return annualNetIncome(records, asOf)

  const notes = ['[미검증] 분기 thstrm_add_amount(누적)를 누적으로 가정했다 — 실응답으로 확정 전까지 참고값']
  const pickOne = (year: number, code: DartReprtCode): FundamentalRecord | null => {
    let best: FundamentalRecord | null = null
    for (const r of known) {
      if (r.bsnsYear !== year || r.reprtCode !== code) continue
      if (best === null || r.rceptDt > best.rceptDt || (r.rceptDt === best.rceptDt && r.rceptNo > best.rceptNo)) best = r
    }
    return best
  }
  const cum = (r: FundamentalRecord | null): number | null => {
    if (!r) return null
    if (r.reprtCode === '11011') return r.netIncome
    // 1분기는 누적 = 당기이므로 add가 없어도 성립한다. 그 외는 add가 없으면 포기.
    if (r.netIncomeAdd != null) return r.netIncomeAdd
    return dartReprtQuarter(r.reprtCode) === 1 ? r.netIncome : null
  }

  const curCum = cum(latest)
  const prevAnnual = pickOne(latest.bsnsYear - 1, '11011')
  const prevSame = pickOne(latest.bsnsYear - 1, latest.reprtCode)
  const prevCum = cum(prevSame)
  if (curCum == null || prevAnnual?.netIncome == null || prevCum == null) {
    const fb = annualNetIncome(records, asOf)
    return {
      ...fb,
      notes: [
        ...fb.notes,
        'TTM 근거 부족(당기 누적·전년 연간·전년 동기 누적 중 결측) → 사업보고서 연간값으로 폴백',
      ],
    }
  }
  return {
    value: curCum + prevAnnual.netIncome - prevCum,
    basis: 'ttm-unverified',
    record: latest,
    notes,
  }
}

// ---------------------------------------------------- 시가총액(KRX 일별 정본)

export interface MarketCapPoint {
  date: string
  /** 시가총액(원) = 그날 **원주가 종가** × 그날 상장주식수. */
  marketCap: number
}

/**
 * KRX 일별 정본 → 일별 시가총액 시계열.
 *
 * **수정주가로 계산하면 안 된다** — 분할이 나면 가격만 나누고 주식수는 그대로여서
 * 시총이 조용히 몇 분의 일로 줄어든다. 파일에 담긴 값이 원주가(`adjustment:'raw'`)이고
 * `shares`가 같은 축의 상장주식수이므로 그 둘을 곱한다.
 */
export function krxMarketCapSeries(index: KrxDailyIndex, stock: KrxDailyStock): MarketCapPoint[] {
  const { calendar } = index
  const out: MarketCapPoint[] = []
  let si = 0
  let shares = stock.shares.length > 0 ? stock.shares[0][1] : 0
  for (const row of stock.rows) {
    const idx = row[0]
    while (si < stock.shares.length && stock.shares[si][0] <= idx) {
      shares = stock.shares[si][1]
      si++
    }
    const date = calendar[idx]
    if (!date) throw new Error(`${stock.code}: 달력 인덱스 ${idx}에 해당하는 날짜가 없다`)
    if (!(shares > 0)) throw new Error(`${stock.code} ${date}: 상장주식수가 양수가 아니다 (${shares})`)
    out.push({ date, marketCap: row[4] * shares })
  }
  return out
}

/**
 * 시점 D에서 알 수 있는 시가총액 = **D 이하의 마지막 거래일** 종가 기준.
 * D 이후 가격은 보지 않는다(규칙 1). 시계열은 날짜 오름차순이어야 한다.
 */
export function marketCapKnownAt(series: readonly MarketCapPoint[], asOf: string): MarketCapPoint | null {
  if (!DATE_RE.test(asOf)) throw new Error(`asOf가 YYYY-MM-DD가 아니다 (${asOf})`)
  let lo = 0
  let hi = series.length - 1
  let ans = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (series[mid].date <= asOf) {
      ans = mid
      lo = mid + 1
    } else hi = mid - 1
  }
  return ans >= 0 ? series[ans] : null
}

// ------------------------------------------------------------------- 팩터

export interface FactorInput {
  /** 시가총액(원). */
  marketCap: number | null
  /** 자본총계(원) — 지배주주 우선. */
  equity: number | null
  /** 순이익(원) — 연간 또는 TTM. */
  netIncome: number | null
}

export interface FactorValues {
  /** PBR = 시가총액 ÷ 자본총계. **자본잠식(자본≤0)이면 null.** */
  pbr: number | null
  /** PER = 시가총액 ÷ 순이익. **적자(순이익≤0)이면 null.** */
  per: number | null
  /** ROE = 순이익 ÷ 자본총계. **자본잠식이면 null.** */
  roe: number | null
  /** null이 된 이유 — 조용히 사라지지 않게 남긴다. */
  reasons: string[]
}

/**
 * 밸류·퀄리티 팩터.
 *
 * **경계 처리가 이 함수의 존재 이유다**(랭킹을 뒤집는 지점):
 *   · 적자(순이익 ≤ 0) → PER **null**. 0이나 무한대로 두면 "가장 싼 주식"으로 올라온다.
 *   · 자본잠식(자본총계 ≤ 0) → PBR·ROE **null**. 음수 자본으로 나누면 부호가 뒤집혀
 *     최악의 회사가 최고 점수를 받는다.
 *   · null은 **랭킹에서 제외**한다(최하위로 밀어넣지 않는다) — `rankFactor` 참조.
 */
export function computeValueQualityFactors(inp: FactorInput): FactorValues {
  const reasons: string[] = []
  const cap = inp.marketCap != null && Number.isFinite(inp.marketCap) && inp.marketCap > 0 ? inp.marketCap : null
  if (cap === null) reasons.push('시가총액 없음/0 이하')
  const eqRaw = inp.equity != null && Number.isFinite(inp.equity) ? inp.equity : null
  if (eqRaw === null) reasons.push('자본총계 없음')
  else if (!(eqRaw > 0)) reasons.push('자본잠식(자본총계 ≤ 0) → PBR·ROE 제외')
  const eq = eqRaw !== null && eqRaw > 0 ? eqRaw : null
  const niRaw = inp.netIncome != null && Number.isFinite(inp.netIncome) ? inp.netIncome : null
  if (niRaw === null) reasons.push('순이익 없음')
  else if (!(niRaw > 0)) reasons.push('적자(순이익 ≤ 0) → PER 제외')
  const niPos = niRaw !== null && niRaw > 0 ? niRaw : null

  return {
    pbr: cap !== null && eq !== null ? cap / eq : null,
    per: cap !== null && niPos !== null ? cap / niPos : null,
    roe: eq !== null && niRaw !== null ? niRaw / eq : null,
    reasons,
  }
}

export interface FactorRankRow {
  code: string
  value: number | null
  /** 값이 없을 때의 사유(진단용). */
  reason?: string
}

export interface FactorRankResult {
  /** 순위 1부터. 값이 있는 종목만. */
  ranked: { code: string; value: number; rank: number }[]
  /** 랭킹에서 뺀 종목 — **개수를 반드시 출력에 남긴다**(조용히 최하위로 넣으면 결과가 뒤집힌다). */
  excluded: { code: string; reason: string }[]
  excludedCount: number
}

/**
 * 팩터 랭킹. `direction:'asc'`면 작은 값이 1위(PBR·PER — 쌀수록 좋다),
 * `'desc'`면 큰 값이 1위(ROE).
 *
 * null·비수치는 **제외**한다. 동점은 종목코드 오름차순으로 깨서 결정론을 보장한다.
 */
export function rankFactor(rows: readonly FactorRankRow[], direction: 'asc' | 'desc'): FactorRankResult {
  const usable: { code: string; value: number }[] = []
  const excluded: { code: string; reason: string }[] = []
  for (const r of rows) {
    if (r.value == null || !Number.isFinite(r.value)) excluded.push({ code: r.code, reason: r.reason ?? '값 없음(null)' })
    else usable.push({ code: r.code, value: r.value })
  }
  const sign = direction === 'asc' ? 1 : -1
  usable.sort((a, b) => (a.value !== b.value ? sign * (a.value - b.value) : a.code < b.code ? -1 : 1))
  excluded.sort((a, b) => (a.code < b.code ? -1 : 1))
  return {
    ranked: usable.map((r, i) => ({ code: r.code, value: r.value, rank: i + 1 })),
    excluded,
    excludedCount: excluded.length,
  }
}

// -------------------------------------------------------------- 단면 스냅샷

export interface FactorSnapshotInput {
  code: string
  /** 그 종목의 전체 재무 레코드(정렬 무관 — 선택은 접수일로만 한다). */
  records: readonly FundamentalRecord[]
  /** 시가총액 시계열(날짜 오름차순). 없으면 팩터가 전부 null이 된다. */
  marketCaps: readonly MarketCapPoint[]
}

export interface FactorSnapshotRow {
  code: string
  asOf: string
  marketCap: number | null
  /** 시총을 읽은 실제 거래일(= D 이하 마지막 거래일). */
  priceDate: string | null
  /** 쓰인 재무의 접수일 — 이 값이 asOf보다 크면 버그다(테스트가 잡는다). */
  rceptDt: string | null
  bsnsYear: number | null
  reprtCode: DartReprtCode | null
  fsDiv: DartFsDiv | null
  equity: number | null
  netIncome: number | null
  netIncomeBasis: NetIncomeBasis
  pbr: number | null
  per: number | null
  roe: number | null
  notes: string[]
}

export interface FactorSnapshotOptions extends PitSelectOptions, NetIncomeOptions {}

export interface FactorSnapshot {
  asOf: string
  rows: FactorSnapshotRow[]
  /** 팩터별 제외 종목 수 — 출력에 남겨야 하는 숫자다(규칙 3). */
  excluded: { pbr: number; per: number; roe: number }
  /** D 시점에 쓸 재무가 아예 없던 종목 수(상장 전·공시 전). */
  noFundamental: number
}

/**
 * 시점 D의 팩터 단면. **모든 입력은 D 이하로만 걸러진다**(재무는 접수일, 시총은 거래일).
 * 그래서 D 이후 데이터를 아무리 붙여도 이 함수의 출력은 변하지 않는다 — PIT 불변성.
 */
export function buildFactorSnapshot(
  asOf: string,
  inputs: readonly FactorSnapshotInput[],
  opts: FactorSnapshotOptions = {},
): FactorSnapshot {
  if (!DATE_RE.test(asOf)) throw new Error(`asOf가 YYYY-MM-DD가 아니다 (${asOf})`)
  const rows: FactorSnapshotRow[] = []
  let noFundamental = 0
  for (const inp of inputs) {
    const rec = selectFundamentalKnownAt(inp.records, asOf, opts)
    const ni = netIncomeKnownAt(inp.records, asOf, opts)
    const cap = marketCapKnownAt(inp.marketCaps, asOf)
    if (!rec) noFundamental++
    const f = computeValueQualityFactors({
      marketCap: cap?.marketCap ?? null,
      equity: rec?.equity ?? null,
      netIncome: ni.value,
    })
    rows.push({
      code: inp.code,
      asOf,
      marketCap: cap?.marketCap ?? null,
      priceDate: cap?.date ?? null,
      rceptDt: rec?.rceptDt ?? null,
      bsnsYear: rec?.bsnsYear ?? null,
      reprtCode: rec?.reprtCode ?? null,
      fsDiv: rec?.fsDiv ?? null,
      equity: rec?.equity ?? null,
      netIncome: ni.value,
      netIncomeBasis: ni.basis,
      pbr: f.pbr,
      per: f.per,
      roe: f.roe,
      notes: [...(rec ? [] : ['D 시점에 접수된 재무가 없다']), ...ni.notes, ...f.reasons],
    })
  }
  rows.sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0))
  return {
    asOf,
    rows,
    excluded: {
      pbr: rows.filter((r) => r.pbr == null).length,
      per: rows.filter((r) => r.per == null).length,
      roe: rows.filter((r) => r.roe == null).length,
    },
    noFundamental,
  }
}

/** 단면 요약 한 줄 — 제외 수를 반드시 드러낸다(규칙 3). */
export function factorSnapshotNote(s: FactorSnapshot): string {
  return (
    `${s.asOf} 팩터 단면 ${s.rows.length}종목 · 재무없음 ${s.noFundamental} · ` +
    `제외 PBR ${s.excluded.pbr}(자본잠식·결측) / PER ${s.excluded.per}(적자·결측) / ROE ${s.excluded.roe} · ` +
    'PIT 기준 = 공시 접수일'
  )
}
