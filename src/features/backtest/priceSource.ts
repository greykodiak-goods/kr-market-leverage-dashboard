// 백테스트 **시세 소스 어댑터** — 야후 ↔ KRX 일별 정본을 진입점 하나로 갈아끼운다.
//
// 왜 이 파일이 생겼나 (2026-08-03 · 야후 배제 2단계):
//   1단계에서 KRX 일별 정본의 **생산 쪽**(수집기 `scripts/krx-daily-backfill.*`)과
//   **변환 쪽**(`krxDailyPrices.ts` — 파서·수정주가 산출)이 들어왔다. 남은 것은 **소비 쪽**이다.
//   지금은 화면(SpecSimulator)과 사전계산(preset-precompute)이 각자 야후를 직접 부르고 있어,
//   전환하려면 두 곳을 따로 고쳐야 하고 그러면 두 수치가 조용히 갈라진다(34차에 실제로 그랬다).
//   그래서 **부르는 쪽은 이 함수 하나만** 알고, 소스 교체는 인자 하나로 끝나게 만든다.
//
// ⚠️ **조용한 폴백을 두지 않는다.** `'krx'`를 골랐는데 데이터가 없으면 야후로 내려가지 않고
//    **던진다**(`krxUniverseSource.ts`와 같은 철학). 소스가 바뀌면 수치의 의미가 통째로
//    바뀌기 때문이다 — 총수익(야후 adjclose) vs 가격수익(KRX 원주가 보정). 폴백은 그
//    차이를 표에서 지워 버린다. **못 돌리는 것이 틀리게 도는 것보다 낫다.**
//
// ⚠️ **소스마다 성적의 의미가 다르다**(규칙 3·규칙 5). 야후 곡선과 KRX 곡선을 같은 표에
//    나란히 놓고 알파를 비교하면 거짓이다. 그래서 이 어댑터는 항상 **메타(배지·출처·한계)**를
//    함께 돌려준다 — 화면·산출물이 그것을 그대로 표시해야 한다.
//
// 규칙 1(미래참조)과의 관계: 이 파일은 **로더**다. 봉을 만들어 넘길 뿐 신호를 만들지 않는다.
//   KRX 수정주가는 "미래 이벤트로 과거 가격을 다시 쓰는" 조작이지만(업계 표준 수정주가와 동일),
//   **이벤트일을 뺀 모든 날의 일별 수익률을 바꾸지 않는다** — 그 성질을 `tests/pricesource.test.ts`와
//   `tests/krxdaily.test.ts`가 직접 검증한다. 수익률이 그대로면 어제까지의 신호도 그대로다.
//
// 이 파일은 브라우저 번들에 들어가므로 **node:fs를 import하지 않는다.** 파일 입출력·네트워크는
// 부르는 쪽이 주입한다(화면은 fetch, 스크립트는 readFileSync).

import {
  KRX_DAILY_BADGE,
  KRX_DAILY_LIMITS,
  krxDailyBars,
  krxDailySourceNote,
  parseKrxDailyIndex,
  parseKrxDailyStock,
  type KrxDailyIndex,
} from './krxDailyPrices'
import { KR_LOAD_NOTE, YAHOO_DAILY_BADGE, YAHOO_DAILY_LIMITS, loadKrDual } from '../../lib/history'
import type { DailyBar } from './types'

// ------------------------------------------------------------------ 소스 종류

export type PriceSource = 'yahoo' | 'krx'

export const PRICE_SOURCES = ['yahoo', 'krx'] as const

/**
 * **기본값은 KRX 정본이다** (2026-08-03 전환 — 대표 지시 "야후 아예 보지 말고 시세 편향 없애줘").
 *
 * 전환 근거(직접 확인):
 *   · 상폐 포함 375종목 · 4,081 거래일(2010-01-04~2026-07-31) · 거래량 포함 · 실패 0콜
 *   · 40+40 유니버스 275종목 중 시세 보유가 야후 252 → **KRX 274** (가격 생존편향 사실상 해소)
 *   · 분할 자기검증 통과: 삼성전자 50:1 · 네이버 5:1 · 카카오 5:1
 *   · 야후는 5분봉 4,800일 전수 조사에서 **단 하루도 78봉이 온전하지 않았다**(평균 71.6봉)
 *
 * ⚠️ 대신 **배당이 빠진다**(KRX 원주가 기반 = 가격수익). 전략·국장 벤치가 똑같이 빠져
 * 알파 비교는 공정하지만 절대 CAGR은 야후 총수익 기준보다 낮게 나온다 — 옛 회차 수치와
 * 직접 비교하면 안 된다. 벤치·참고선(QQQ·QLD·금·환율)은 KRX에 없어 야후를 계속 쓴다.
 */
export const DEFAULT_PRICE_SOURCE: PriceSource = 'krx'

export const PRICE_SOURCE_LABEL: Record<PriceSource, string> = {
  yahoo: 'Yahoo 일봉 (총수익 · 생존편향 있음)',
  krx: 'KRX 일별 정본 (가격수익 · 상폐 종목 포함)',
}

/** 저장본·URL 파라미터·환경변수로 임의 값이 새어 들어오면 기본값으로 좁힌다. */
export function normalizePriceSource(v: unknown): PriceSource {
  return (PRICE_SOURCES as readonly string[]).includes(v as string) ? (v as PriceSource) : DEFAULT_PRICE_SOURCE
}

// ------------------------------------------------------------- 경로·실패 문구

/** 화면이 fetch할 정적 자산 디렉터리(BASE_URL 뒤에 붙인다). 스크립트는 리포 경로를 직접 읽는다. */
export const KRX_DAILY_ASSET_DIR = 'data/krx-daily'
export const KRX_DAILY_INDEX_ASSET = `${KRX_DAILY_ASSET_DIR}/index.json`

/**
 * KRX 정본이 아직 없을 때 그대로 보여줄 문구. "왜 안 되는지"와 "무엇을 하면 되는지"를
 * 한 줄에 담는다 — 화면에서 이 문장을 보면 다음 행동이 정해진다.
 */
export const KRX_DAILY_NOT_READY =
  `KRX 일별 정본(${KRX_DAILY_INDEX_ASSET})을 읽지 못했습니다 — **EC2 krxdaily 수집이 아직 안 끝났습니다.** ` +
  '야후로 조용히 대신 돌리지 않습니다(소스가 바뀌면 총수익/가격수익이 섞여 표가 거짓이 됩니다).'

/** 의존성 주입을 빠뜨린 경우 — 개발 실수를 조용히 넘기지 않는다. */
export const PRICE_DEPS_MISSING: Record<PriceSource, string> = {
  yahoo: '야후 시세 의존성(deps.yahoo.fetchDaily)이 주입되지 않았습니다.',
  krx: 'KRX 시세 의존성(deps.krx.readIndex/readStock)이 주입되지 않았습니다.',
}

// --------------------------------------------------------------------- 메타

/** 소스·배지·한계 — 규칙 3(출처·한계를 화면에서 확인 가능하게)을 나르는 그릇. */
export interface PriceSourceMeta {
  source: PriceSource
  /** 그래프·표 옆 배지 한 줄 */
  badge: string
  /** 드롭다운·설명용 라벨 */
  label: string
  /** 출처 한 줄(KRX는 수집일·종목수·거래일수까지) */
  note: string
  /** 한계 목록 — 화면이 그대로 나열한다 */
  limits: string[]
  /** 실제로 로드된 시계열의 마지막 거래일. 하나도 못 받았으면 '' */
  asOf: string
  /** 요청한 코드 수 / 시세를 실제로 얻은 코드 수 */
  requested: number
  loaded: number
  /** 시세를 못 얻은 코드 — 숨기지 않고 돌려준다(생존편향 판단 재료) */
  failed: string[]
}

export interface KrPriceLoad {
  /** 심볼 → 봉 배열. 야후는 '005930.KS', KRX는 6자리 코드가 심볼이다. */
  histories: Record<string, DailyBar[]>
  /** 유니버스 코드 → 실제로 시세를 받은 심볼 */
  symOf: Record<string, string>
  /** 시세를 못 얻은 코드(야후: 상폐·가짜응답 / KRX: 수집 범위 밖) */
  failed: string[]
  meta: PriceSourceMeta
  /** KRX 경로에서만 채워진다 — 달력·수집일이 필요한 호출부용 */
  krxIndex?: KrxDailyIndex
}

// ---------------------------------------------------------------- 의존성 주입

export interface YahooPriceDeps {
  /** 심볼 하나의 일봉을 받아온다(화면: getDailyHistory(...).bars · 노드: 직접 fetch) */
  fetchDaily: (symbol: string) => Promise<DailyBar[]>
  /** 동시 요청 수. 화면은 6(프록시 유량 제한 안쪽), 스크립트는 1(순차)을 쓴다. */
  concurrency?: number
  /** 접미사 시도 사이 대기(유량 제한 완화) */
  betweenAttempts?: () => Promise<void>
  /** 가짜 응답 게이트. 기본은 history.ts의 KR_MIN_BARS(200) */
  minBars?: number
}

export interface KrxPriceDeps {
  /** `index.json` 원시 JSON. 파일이 없으면 `null`(어댑터가 사유를 붙여 던진다). */
  readIndex: () => Promise<unknown | null>
  /** `prices/{code}.json` 원시 JSON. 없으면 `null`. `file`은 index의 규약 경로다. */
  readStock: (code: string, file: string) => Promise<unknown | null>
  /**
   * confidence:'low' 분할 후보까지 보정할지. 기본 false —
   * 애매한 건을 조용히 보정해 없는 수익을 만들지 않는다(krxDailyPrices.ts의 기본과 같다).
   */
  applyLowConfidence?: boolean
}

export interface PriceSourceDeps {
  yahoo?: YahooPriceDeps
  krx?: KrxPriceDeps
  /** 진행 표시(화면 전용) — 로딩 개수를 그대로 넘긴다 */
  onProgress?: (done: number, total: number) => void
}

/** fetch 응답 최소 계약 — 테스트가 가짜 fetch를 끼울 수 있게 좁혀 둔다. */
export interface JsonResponseLike {
  ok: boolean
  status: number
  json: () => Promise<unknown>
}

/**
 * 화면용 KRX 의존성 — 정적 자산을 fetch로 읽는다.
 * 404는 **아직 수집 전**이므로 `null`(어댑터가 "수집이 안 끝났다"로 번역), 그 외 HTTP 오류는
 * 진짜 오류이므로 그대로 던진다 — 둘을 같은 메시지로 뭉개면 원인을 못 찾는다.
 */
export function krxFetchDeps(
  baseUrl: string,
  fetchImpl: (url: string) => Promise<JsonResponseLike>,
  opts: { applyLowConfidence?: boolean } = {},
): KrxPriceDeps {
  const get = async (rel: string): Promise<unknown | null> => {
    const url = `${baseUrl}${KRX_DAILY_ASSET_DIR}/${rel}`
    const res = await fetchImpl(url)
    if (res.status === 404) return null
    if (!res.ok) throw new Error(`HTTP ${res.status} · ${url}`)
    return res.json()
  }
  return {
    readIndex: () => get('index.json'),
    readStock: (_code, file) => get(file),
    applyLowConfidence: opts.applyLowConfidence,
  }
}

// ------------------------------------------------------------ KRX 준비 상태

export type KrxDailyStatus =
  | { ready: true; index: KrxDailyIndex; note: string }
  /** 아직 수집 전(파일 없음) — 안내 문구만 다르다 */
  | { ready: false; reason: string; missing: boolean }

/**
 * KRX 정본을 **쓸 수 있는지만** 확인한다(화면의 소스 선택 게이트용).
 * 실패해도 던지지 않고 상태로 돌려준다 — 이 함수의 목적이 "실행 버튼을 막을지" 판단이라서다.
 * 실제 로드(`loadKrPrices`)는 여전히 실패를 **던진다**.
 */
export async function probeKrxDaily(deps: KrxPriceDeps): Promise<KrxDailyStatus> {
  try {
    const index = await loadKrxDailyIndex(deps)
    return { ready: true, index, note: krxDailySourceNote(index) }
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e)
    return { ready: false, reason, missing: reason.includes(KRX_DAILY_NOT_READY) }
  }
}

/**
 * `index.json`을 읽어 검증한다. **어떤 실패도 삼키지 않는다.**
 *   · 파일 없음 → "수집이 아직 안 끝났습니다"(다음 행동이 정해지는 문구)
 *   · 스키마 위반 → parseKrxDailyIndex의 사유를 그대로 올린다(파일이 깨진 것과 없는 것은 다르다)
 */
export async function loadKrxDailyIndex(deps: KrxPriceDeps): Promise<KrxDailyIndex> {
  let raw: unknown | null
  try {
    raw = await deps.readIndex()
  } catch (e) {
    throw new Error(`${KRX_DAILY_NOT_READY} (읽기 실패: ${String(e)})`)
  }
  if (raw == null) throw new Error(KRX_DAILY_NOT_READY)
  return parseKrxDailyIndex(raw)
}

// --------------------------------------------------------------- 단일 진입점

/**
 * 국내 종목 시세를 **소스에 상관없이 같은 모양**으로 돌려준다.
 *
 * @param codes  유니버스 6자리 코드 목록(중복은 알아서 접는다)
 * @param source 'yahoo' | 'krx' — 'krx'인데 데이터가 없으면 **던진다**(폴백 없음)
 *
 * ⚠️ 이 함수는 **국내 종목 전용**이다. 벤치(KODEX 200)·참고선(QQQ·QLD·GLD·환율)은 KRX Open API가
 *    주지 않는 종목이거나 해외 자산이라 **계속 야후로 받는다** — 부르는 쪽이 그 사실을 화면에
 *    남겨야 한다(`MIXED_SOURCE_NOTE`).
 */
export async function loadKrPrices(
  codes: readonly string[],
  source: PriceSource,
  deps: PriceSourceDeps,
): Promise<KrPriceLoad> {
  const uniq = [...new Set(codes)]
  return source === 'krx' ? loadFromKrx(uniq, deps) : loadFromYahoo(uniq, deps)
}

/** 소스가 섞이는 구간을 화면·산출물에 한 줄로 남긴다(규칙 3). */
export const MIXED_SOURCE_NOTE =
  '국내 유니버스 종목만 선택한 소스로 받습니다. 벤치마크(KODEX 200)와 참고선(QQQ·QLD·금·환율)은 ' +
  'KRX Open API가 주지 않는 종목·해외 자산이라 **계속 Yahoo**로 받습니다 — 두 계열의 배당 반영 여부가 ' +
  '다르므로(야후=총수익, KRX=가격수익) 알파 수치는 그만큼의 편향을 안고 읽어야 합니다.'

// --------------------------------------------------------------- 야후 경로

async function loadFromYahoo(codes: string[], deps: PriceSourceDeps): Promise<KrPriceLoad> {
  const d = deps.yahoo
  if (!d) throw new Error(PRICE_DEPS_MISSING.yahoo)

  const histories: Record<string, DailyBar[]> = {}
  const symOf: Record<string, string> = {}
  const failed: string[] = []
  const total = codes.length
  let done = 0

  // 병렬 로딩 — 순차 왕복이 화면 체감 지연의 주범이었다. 동시 수는 호출부가 정한다
  // (화면 6 · 스크립트 1). 채택 규약(`loadKrDual`)은 연구 러너와 **같은 정본**을 쓴다:
  // .KQ/.KS 둘 다 조회 → 긴 이력 채택 → 200봉 미만은 가짜 응답으로 보고 제외.
  const queue = [...codes]
  const worker = async () => {
    for (;;) {
      const code = queue.shift()
      if (!code) return
      const picked = await loadKrDual(code, d.fetchDaily, (bars) => bars.length, {
        minBars: d.minBars,
        betweenAttempts: d.betweenAttempts,
      })
      if (picked) {
        histories[picked.symbol] = picked.value
        symOf[code] = picked.symbol
      } else failed.push(code)
      done++
      deps.onProgress?.(done, total)
    }
  }
  const workers = Math.max(1, Math.min(d.concurrency ?? 1, queue.length))
  await Promise.all(Array.from({ length: workers }, worker))

  return {
    histories,
    symOf,
    failed,
    meta: {
      source: 'yahoo',
      badge: YAHOO_DAILY_BADGE,
      label: PRICE_SOURCE_LABEL.yahoo,
      note: `시세: Yahoo Finance chart v8 · ${KR_LOAD_NOTE}`,
      limits: [...YAHOO_DAILY_LIMITS],
      asOf: lastDateOf(histories),
      requested: total,
      loaded: Object.keys(symOf).length,
      failed,
    },
  }
}

// ---------------------------------------------------------------- KRX 경로

async function loadFromKrx(codes: string[], deps: PriceSourceDeps): Promise<KrPriceLoad> {
  const d = deps.krx
  if (!d) throw new Error(PRICE_DEPS_MISSING.krx)

  const index = await loadKrxDailyIndex(d)
  const entryOf = new Map(index.stocks.map((s) => [s.code, s]))

  const histories: Record<string, DailyBar[]> = {}
  const symOf: Record<string, string> = {}
  const failed: string[] = []
  let appliedEvents = 0
  let skippedEvents = 0
  const total = codes.length
  let done = 0

  for (const code of codes) {
    const entry = entryOf.get(code)
    // 수집 범위 밖 코드는 **실패로 센다**(야후 경로와 같은 취급) — 조용히 빼면 매핑률이
    // 부풀려져 "몇 종목으로 돌았는지"가 표에서 사라진다.
    if (!entry) {
      failed.push(code)
      done++
      deps.onProgress?.(done, total)
      continue
    }
    let raw: unknown | null
    try {
      raw = await d.readStock(code, entry.file)
    } catch (e) {
      throw new Error(`${code} 시세 파일(${entry.file})을 읽지 못했습니다 — ${String(e)}`)
    }
    // index에는 있는데 파일이 없다 = 수집이 중간에 끊겼다. 그 상태로 계속 돌면 유니버스가
    // 조용히 줄어든 채 성적만 나온다 — 그래서 **던진다**.
    if (raw == null)
      throw new Error(
        `index.json에는 ${code}가 있는데 시세 파일(${entry.file})이 없습니다 — 수집이 중간에 끊긴 상태입니다. ` +
          '빠진 채로 돌리지 않습니다(유니버스가 줄어든 표는 성적을 부풀립니다).',
      )
    // 스키마 위반(달력 인덱스 이탈·가격 정합 위반 등)은 parseKrxDailyStock이 사유를 붙여 던진다.
    const stock = parseKrxDailyStock(raw, index.calendar.length)
    const res = krxDailyBars(index, stock, { applyLowConfidence: d.applyLowConfidence })
    appliedEvents += res.applied.length
    skippedEvents += res.skipped.length
    if (res.bars.length === 0) failed.push(code)
    else {
      histories[code] = res.bars
      symOf[code] = code
    }
    done++
    deps.onProgress?.(done, total)
  }

  const limits = [...KRX_DAILY_LIMITS]
  limits.push(
    `수정주가 반영 ${appliedEvents}건 · 미보정(유상증자형·[미검증] 저신뢰) ${skippedEvents}건 — ` +
      '미보정 건이 있는 종목은 그날 가격이 계단처럼 끊긴 채로 계산됩니다.',
  )
  limits.push(
    `데이터가 ${index.from}부터라 그 이전 봉이 없습니다 — 12-1 모멘텀처럼 12개월 워밍업을 요구하는 규칙은 ` +
      '첫 해에 후보가 비어 다르게 돕니다. 시작 연도를 그만큼 뒤로 미루거나 첫 해 수치를 따로 읽으세요.',
  )

  return {
    histories,
    symOf,
    failed,
    krxIndex: index,
    meta: {
      source: 'krx',
      badge: KRX_DAILY_BADGE,
      label: PRICE_SOURCE_LABEL.krx,
      note: krxDailySourceNote(index),
      limits,
      asOf: lastDateOf(histories),
      requested: total,
      loaded: Object.keys(symOf).length,
      failed,
    },
  }
}

// ------------------------------------------------------------------- 유틸

/** 실제로 받은 시계열의 마지막 거래일(전 종목 최대). 하나도 없으면 ''. */
export function lastDateOf(histories: Record<string, DailyBar[]>): string {
  let asOf = ''
  for (const bars of Object.values(histories)) {
    const last = bars.length ? bars[bars.length - 1].date : ''
    if (last > asOf) asOf = last
  }
  return asOf
}
