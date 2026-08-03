// 화면·사전계산이 함께 쓰는 **KRX 실측 유니버스 소스** — 로드·파생·라벨.
//
// 왜 이 파일이 생겼나 (2026-08-03 · 34차 프리셋 재세팅):
//   화면(SpecSimulator)은 지금까지 `pitUniverse.ts`의 PIT1010([추정] 목록)을 썼다.
//   33차에서 그 목록이 틀렸다는 것이 드러났고(알파 +21.9%p → 실측 +2.6%p), 목록이
//   틀리면 그 위에서 고른 파라미터도 같이 무효다. 그래서 화면 실행 경로의 유니버스를
//   **KRX 실측**(`public/data/krx-pit/universe.json`)으로 바꾼다.
//
// ⚠️ **[추정] 폴백을 두지 않는다.** 실측 파일을 못 읽으면 조용히 PIT1010으로 내려가는
//    대신 **에러를 던진다.** 33차가 무너진 경로가 바로 "틀린 목록 위에서 조용히 계속
//    도는 것"이었고, 폴백은 그 사고를 눈에 안 띄게 재발시키는 장치다. 유니버스가 바뀌면
//    수치의 의미가 통째로 바뀌므로, 화면은 **못 돌리는 것이 틀리게 도는 것보다 낫다.**
//
// pitUniverse.ts(PIT1010)는 **삭제하지 않았다** — 연구 러너·과거 회차 재현·골든 테스트가
// 그대로 쓴다. 화면 경로에서만 분리한 것이다.
//
// 이 파일은 브라우저 번들에 들어가므로 **node:fs를 import하지 않는다.** 파일 입출력은
// 부르는 쪽이 하고(스크립트는 readFileSync, 화면은 fetch), 여기서는 순수 변환만 한다.

import {
  KRX_PIT_PATH,
  krxPitMarketCodes,
  krxPitSourceNote,
  krxPitSpan,
  krxPitYears,
  parseKrxPitUniverse,
  type KrxPitUniverse,
} from './krxPitUniverse'

/**
 * 실측 랭킹의 시작 연도. KRX Open API 데이터가 2010년부터라 **2006~2009는 수집 자체가
 * 불가능**하다 — 그래서 화면 구간도 2010부터다. 2000~ 구간으로 돌던 옛 수치와 직접
 * 비교하면 거짓이 된다(겪은 위기의 수가 다르다).
 */
export const KRX_UNIVERSE_FROM = 2010

/** 화면 기본 시작일 — 실측 유니버스가 덮는 첫 해와 맞춘다. */
export const KRX_UNIVERSE_START_DATE = '2010-01-01'

/**
 * 유니버스 폭 선택지 — 각 시장에서 상위 N을 잘라 쓴다. **시장별로 따로 고른다**
 * (2026-08-03 대표 지시 "코스피 상위 몇 종목, 코스닥 상위 몇 종목 이렇게 선택").
 *
 * 수집 원본이 시장당 40종목이라 40이 상한이다. 0은 **그 시장을 빼는 것**이고,
 * 코스피만·코스닥만 돌리는 비교가 가능해진다(둘 다 0이면 실행 불가 — deriveKrxUniverse가 던진다).
 *
 * ⚠️ 34차 판정 통과분(프리셋 2종)이 나온 곳은 **코스피 10 + 코스닥 10**이다. 폭을 바꾸면
 * 그 수치와 비교가 성립하지 않으므로, 사전계산 블록은 폭이 기본값과 다르면 숨는다.
 */
export const KRX_TOP_N_CHOICES = [0, 5, 10, 20, 30, 40] as const
export type KrxTopN = (typeof KRX_TOP_N_CHOICES)[number]
export const DEFAULT_KRX_TOP_N: KrxTopN = 10

/** 시장별 폭. `kospi`·`kosdaq`을 따로 고른다. */
export interface KrxWidth {
  kospi: KrxTopN
  kosdaq: KrxTopN
}

/** 34차 프리셋의 전제 폭 — 이 값과 다르면 프리셋 수치와 비교가 성립하지 않는다. */
export const DEFAULT_KRX_WIDTH: KrxWidth = { kospi: DEFAULT_KRX_TOP_N, kosdaq: DEFAULT_KRX_TOP_N }

/** 화면이 fetch할 정적 자산 경로(BASE_URL 뒤에 붙인다). 스크립트는 KRX_PIT_PATH를 직접 읽는다. */
export const KRX_UNIVERSE_ASSET_PATH = 'data/krx-pit/universe.json'

/** 임의 값이 새어 들어오면 기본값으로 좁힌다 — 저장본·URL 파라미터 방어. */
export function normalizeTopN(v: number | undefined): KrxTopN {
  return (KRX_TOP_N_CHOICES as readonly number[]).includes(v as number) ? (v as KrxTopN) : DEFAULT_KRX_TOP_N
}

/**
 * 저장본·입력을 시장별 폭으로 정규화한다.
 * 숫자 하나만 오면 **두 시장 같은 폭**으로 읽는다 — v3 저장본(`topN: 10`)과 옛 호출부 호환.
 */
export function normalizeWidth(v: unknown): KrxWidth {
  if (typeof v === 'number') return { kospi: normalizeTopN(v), kosdaq: normalizeTopN(v) }
  if (v && typeof v === 'object') {
    const o = v as Partial<Record<keyof KrxWidth, number>>
    return { kospi: normalizeTopN(o.kospi), kosdaq: normalizeTopN(o.kosdaq) }
  }
  return { ...DEFAULT_KRX_WIDTH }
}

/** 폭 표기 — "10+10" / "코스피 30 + 코스닥 0" 처럼 사람이 읽는 한 줄. */
export function krxWidthLabel(w: KrxWidth): string {
  if (w.kospi === w.kosdaq) return `${w.kospi}+${w.kosdaq}`
  return `코스피 ${w.kospi} + 코스닥 ${w.kosdaq}`
}

/** 34차 프리셋 전제(10+10)와 같은 폭인가 — 사전계산 수치를 띄워도 되는지 판정한다. */
export function isDefaultKrxWidth(w: KrxWidth): boolean {
  return w.kospi === DEFAULT_KRX_WIDTH.kospi && w.kosdaq === DEFAULT_KRX_WIDTH.kosdaq
}

/** 로드 실패 시 화면에 그대로 보여줄 안내의 머리말 — "폴백은 없다"를 문장으로 못 박는다. */
export const KRX_UNIVERSE_LOAD_FAIL =
  `KRX 실측 유니버스(${KRX_PIT_PATH})를 읽지 못했습니다 — 백테스트를 실행할 수 없습니다. ` +
  `[추정] 목록으로 대신 돌리지 않습니다(33차에서 [추정] 목록발 알파가 무너졌고, ` +
  `조용한 폴백은 그 사고를 눈에 안 띄게 되풀이합니다).`

/** 실측 유니버스에서 파생된 실행 재료 — 화면·사전계산이 **같은 함수**로 만든다. */
export interface DerivedKrxUniverse {
  /** 시장별 폭(코스피·코스닥 각각 상위 N) */
  width: KrxWidth
  /** 실행할 연도(오름차순 · 빈틈 없음) */
  years: number[]
  /** 전 연도 합집합 — 시세를 한 번만 받기 위한 로딩 목록 */
  union: string[]
  /** 그 해 유니버스 코드(코스피 상위 width.kospi + 코스닥 상위 width.kosdaq) */
  codesFor: (year: number) => string[]
  /** 화면 표기용 한 줄 — "KRX 실측 연도별 상위 10+10 · 2010~2026 · 고유 N종목" */
  label: string
  /** 출처·수집일·수집 불가 연도(규칙 3 — 실데이터 라벨) */
  sourceNote: string
}

/**
 * 파싱된 실측 유니버스 → 실행 재료. **구멍이 있으면 던진다**(krxPitSpan) —
 * 조용히 짧은 구간으로 돌면 다른 표와 비교가 성립하지 않는다.
 *
 * 폭은 시장별로 받는다. 숫자 하나를 주면 두 시장 같은 폭으로 읽는다(옛 호출부 호환).
 */
export function deriveKrxUniverse(
  u: KrxPitUniverse,
  widthIn: KrxTopN | KrxWidth = DEFAULT_KRX_WIDTH,
): DerivedKrxUniverse {
  const width = normalizeWidth(widthIn)
  const covered = krxPitYears(u).filter((y) => y >= KRX_UNIVERSE_FROM)
  if (covered.length === 0)
    throw new Error(
      `실측 유니버스에 ${KRX_UNIVERSE_FROM}년 이후 데이터가 없습니다 — ${KRX_PIT_PATH}를 EC2 MODE=pityear로 다시 수집하세요.`,
    )
  // 덮는 구간 안에 결측 연도가 있으면 여기서 던진다(결측을 숨기지 않는다).
  const years = krxPitSpan(u, covered[0], covered[covered.length - 1])
  const codesFor = (year: number) => [
    ...krxPitMarketCodes(u, year, 'kospi', width.kospi),
    ...krxPitMarketCodes(u, year, 'kosdaq', width.kosdaq),
  ]
  const set = new Set<string>()
  for (const y of years) for (const c of codesFor(y)) set.add(c)
  const union = [...set].sort()
  if (union.length === 0)
    throw new Error(
      `실측 유니버스 ${krxWidthLabel(width)}에서 종목을 하나도 뽑지 못했습니다 — 두 시장 폭이 모두 0이면 실행할 수 없습니다.`,
    )
  return {
    width,
    years,
    union,
    codesFor,
    label: `KRX 실측 연도별 상위 ${krxWidthLabel(width)} · ${years[0]}~${years[years.length - 1]} · 고유 ${union.length}종목`,
    sourceNote: krxPitSourceNote(u),
  }
}

/** fetch 응답 최소 계약 — 테스트가 가짜 fetch를 끼울 수 있게 좁혀 둔다. */
export interface KrxUniverseResponse {
  ok: boolean
  status: number
  json: () => Promise<unknown>
}

/**
 * 실측 유니버스 파일을 읽어 파싱한다. **어떤 실패도 삼키지 않는다** —
 * 네트워크·HTTP·JSON·스키마 위반 전부 던진다. 부르는 쪽이 그 메시지를 화면에 띄운다.
 */
export async function loadKrxUniverse(
  baseUrl: string,
  fetchImpl: (url: string) => Promise<KrxUniverseResponse>,
): Promise<KrxPitUniverse> {
  const url = `${baseUrl}${KRX_UNIVERSE_ASSET_PATH}`
  let res: KrxUniverseResponse
  try {
    res = await fetchImpl(url)
  } catch (e) {
    throw new Error(`${KRX_UNIVERSE_LOAD_FAIL} (네트워크 오류: ${String(e)})`)
  }
  if (!res.ok) throw new Error(`${KRX_UNIVERSE_LOAD_FAIL} (HTTP ${res.status} · ${url})`)
  let raw: unknown
  try {
    raw = await res.json()
  } catch (e) {
    throw new Error(`${KRX_UNIVERSE_LOAD_FAIL} (JSON 파싱 실패: ${String(e)})`)
  }
  // 스키마 위반은 parseKrxPitUniverse가 사유를 붙여 던진다(중복 코드·순위 빈틈·결측 연도 등).
  return parseKrxPitUniverse(raw)
}
