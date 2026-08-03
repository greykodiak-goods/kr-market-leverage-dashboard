// KRX **실측** 시점 고정(point-in-time) 유니버스 — 스키마·파서·접근자.
//
// 왜 이 파일이 있는가 (2026-08-03):
//   `src/features/backtest/pitUniverse.ts`의 PIT1010은 **[추정] 목록**이다(모델 지식 기반).
//   목록이 틀리면 백테스트 결과도 틀린다 — 실제로 옛 추세 조합 2종은 KRX 실측 40+40에서
//   알파 −8.6/−7.5%p로 대패했다. KRX Open API 승인(2026-08-03)으로 실측 랭킹을 받게 됐고,
//   `MODE=pityear`(EC2)가 그것을 `public/data/krx-pit/universe.json`에 저장한다.
//   이 파일은 그 파일의 **스키마 단일 원본**이다 — 쓰는 쪽(pityear)과 읽는 쪽(MODE=krxpit)이
//   같은 타입·같은 검증을 통과한다.
//
// 정직성(규칙 3):
//   · 랭킹 자체는 실측이라 **목록 선택편향이 없다.** [추정] 목록과 달리 순위 오류가 없다.
//   · 남는 한계는 **가격 생존편향**이다 — 그 시절 상위였다가 상장폐지된 종목은 Yahoo에
//     시세가 없어 그 해 유니버스에서 빠진다. 매핑률로 크기를 드러낼 뿐 제거되지 않는다.
//   · KRX Open API의 데이터 시작이 2010년이라 **2006~2009는 수집 자체가 불가능**하다.
//     그 사실을 파일에 `missingYears`로 박아 두고, 읽는 쪽이 조용히 건너뛰지 못하게 한다.
//
// 이 파일은 브라우저 번들에도 들어갈 수 있으므로 **node:fs를 import하지 않는다** —
// 파일 입출력은 부르는 쪽(스크립트)이 하고 여기서는 순수 데이터 변환·검증만 한다.

/** 한 종목 한 줄 — 코드·이름·그 해 그 시장 안에서의 시총 순위(1부터). */
export interface KrxPitEntry {
  code: string
  name: string
  rank: number
}

/** 한 해의 실측 랭킹 — 시장별로 나눠 담는다(코스피 40 · 코스닥 40). */
export interface KrxPitYear {
  kospi: KrxPitEntry[]
  kosdaq: KrxPitEntry[]
}

/**
 * `public/data/krx-pit/universe.json`의 전체 스키마.
 * `years`의 키는 JSON이라 문자열이다(연도 4자리).
 */
export interface KrxPitUniverse {
  /** 랭킹 출처. 실측 경로는 'KRX Open API' 하나뿐이다. */
  source: string
  /** 수집 실행일(YYYY-MM-DD). 랭킹 기준일이 아니라 **뽑은 날**이다. */
  asOf: string
  /** 랭킹 기준 한 줄 설명 — 화면·로그에 그대로 붙인다. */
  basis: string
  /** 수집 시도했으나 소스가 데이터를 주지 않은 해(예: Open API 이전인 2006~2009). */
  missingYears: number[]
  years: Record<string, KrxPitYear>
}

export const KRX_PIT_SOURCE = 'KRX Open API'
export const KRX_PIT_BASIS = '연초 첫 거래일 시총, 보통주만·스팩 제외'
/** 리포 기준 상대 경로 — 쓰는 쪽·읽는 쪽이 같은 상수를 쓴다(경로가 갈리는 사고 방지). */
export const KRX_PIT_PATH = 'public/data/krx-pit/universe.json'

/** 화면·로그용 한 줄 출처 표기(규칙 3 — 실데이터 라벨). */
export function krxPitSourceNote(u: KrxPitUniverse): string {
  const ys = krxPitYears(u)
  const span = ys.length ? `${ys[0]}~${ys[ys.length - 1]}` : '(없음)'
  const miss = u.missingYears.length ? ` · 수집 불가 연도 ${u.missingYears.join(', ')}` : ''
  return `유니버스: ${u.source} 실측 랭킹 ${span} (${u.basis}) · 수집일 ${u.asOf}${miss}`
}

const MARKETS = ['kospi', 'kosdaq'] as const
export type KrxMarket = (typeof MARKETS)[number]

function fail(msg: string): never {
  throw new Error(`universe.json 스키마 위반 — ${msg}`)
}

function parseEntries(raw: unknown, where: string): KrxPitEntry[] {
  if (!Array.isArray(raw)) fail(`${where}가 배열이 아니다`)
  if (raw.length === 0) fail(`${where}가 비어 있다`)
  const out: KrxPitEntry[] = []
  raw.forEach((r, i) => {
    if (typeof r !== 'object' || r == null) fail(`${where}[${i}]가 객체가 아니다`)
    const e = r as Record<string, unknown>
    const code = String(e.code ?? '')
    const name = String(e.name ?? '')
    const rank = Number(e.rank)
    if (!/^\d{6}$/.test(code)) fail(`${where}[${i}].code가 6자리 종목코드가 아니다 (${code || '없음'})`)
    if (!name.trim()) fail(`${where}[${i}].name이 비어 있다 (${code})`)
    if (!Number.isInteger(rank) || rank < 1) fail(`${where}[${i}].rank가 1 이상의 정수가 아니다 (${code})`)
    // 순위는 1부터 빈틈없이 오름차순이어야 한다 — 수집 중 한 줄이 빠지면 여기서 걸린다.
    if (rank !== i + 1) fail(`${where}[${i}].rank가 ${i + 1}이 아니다 (${rank}) — 순위에 빈틈이 있다`)
    out.push({ code, name, rank })
  })
  return out
}

/**
 * JSON을 검증하며 읽는다. **거부하는 것**(조용히 넘어가면 백테스트가 거짓말을 한다):
 *   · 필수 필드 누락·타입 오류
 *   · 한 해 안의 **중복 종목코드**(시장 안이든 코스피↔코스닥 사이든)
 *   · 순위의 빈틈(rank가 1..n 연속이 아님)
 *   · 덮는 구간 안의 **결측 연도** — `missingYears`에 명시되지 않은 구멍은 거부한다.
 *   · `missingYears`에 넣어 놓고 `years`에도 있는 모순
 */
export function parseKrxPitUniverse(raw: unknown): KrxPitUniverse {
  if (typeof raw !== 'object' || raw == null) fail('최상위가 객체가 아니다')
  const o = raw as Record<string, unknown>
  const source = String(o.source ?? '')
  const asOf = String(o.asOf ?? '')
  const basis = String(o.basis ?? '')
  if (!source.trim()) fail('source가 비어 있다')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) fail(`asOf가 YYYY-MM-DD가 아니다 (${asOf || '없음'})`)
  if (!basis.trim()) fail('basis가 비어 있다')

  if (!Array.isArray(o.missingYears)) fail('missingYears가 배열이 아니다')
  const missingYears = o.missingYears.map((v, i) => {
    const y = Number(v)
    if (!Number.isInteger(y) || y < 1900 || y > 2999) fail(`missingYears[${i}]가 연도가 아니다 (${String(v)})`)
    return y
  })

  if (typeof o.years !== 'object' || o.years == null || Array.isArray(o.years)) fail('years가 객체가 아니다')
  const yearsRaw = o.years as Record<string, unknown>
  const keys = Object.keys(yearsRaw)
  if (keys.length === 0) fail('years가 비어 있다')

  const years: Record<string, KrxPitYear> = {}
  for (const k of keys) {
    if (!/^\d{4}$/.test(k)) fail(`years 키가 4자리 연도가 아니다 (${k})`)
    const yv = yearsRaw[k]
    if (typeof yv !== 'object' || yv == null) fail(`years.${k}가 객체가 아니다`)
    const rec = yv as Record<string, unknown>
    const kospi = parseEntries(rec.kospi, `years.${k}.kospi`)
    const kosdaq = parseEntries(rec.kosdaq, `years.${k}.kosdaq`)
    const seen = new Set<string>()
    for (const e of [...kospi, ...kosdaq]) {
      if (seen.has(e.code)) fail(`years.${k}에 중복 종목코드 ${e.code}(${e.name})가 있다`)
      seen.add(e.code)
    }
    years[k] = { kospi, kosdaq }
  }

  const present = keys.map(Number).sort((a, b) => a - b)
  const missSet = new Set(missingYears)
  for (const y of present) if (missSet.has(y)) fail(`${y}년이 missingYears에 있으면서 years에도 있다`)
  for (let y = present[0]; y <= present[present.length - 1]; y++) {
    if (years[String(y)]) continue
    if (missSet.has(y)) continue
    fail(`${y}년이 빠졌는데 missingYears에도 없다 — 결측을 숨기지 마라`)
  }

  return { source, asOf, basis, missingYears, years }
}

/** 수집 결과를 스키마 객체로 조립한다(쓰는 쪽 단일 경로). 조립 즉시 파서로 자기검증한다. */
export function buildKrxPitUniverse(
  lists: Record<number, { ks: { code: string; name: string }[]; kq: { code: string; name: string }[] }>,
  opts: { asOf: string; missingYears: number[]; source?: string; basis?: string },
): KrxPitUniverse {
  const years: Record<string, KrxPitYear> = {}
  const rank = (rows: { code: string; name: string }[]): KrxPitEntry[] =>
    rows.map((r, i) => ({ code: r.code, name: r.name, rank: i + 1 }))
  for (const y of Object.keys(lists)
    .map(Number)
    .sort((a, b) => a - b)) {
    years[String(y)] = { kospi: rank(lists[y].ks), kosdaq: rank(lists[y].kq) }
  }
  return parseKrxPitUniverse({
    source: opts.source ?? KRX_PIT_SOURCE,
    asOf: opts.asOf,
    basis: opts.basis ?? KRX_PIT_BASIS,
    missingYears: [...opts.missingYears].sort((a, b) => a - b),
    years,
  })
}

/** 목록이 덮는 연도(오름차순). */
export function krxPitYears(u: KrxPitUniverse): number[] {
  return Object.keys(u.years)
    .map(Number)
    .sort((a, b) => a - b)
}

/** 그 해 그 시장의 상위 `topN` 코드. 목록에 없는 해는 빈 배열. */
export function krxPitMarketCodes(u: KrxPitUniverse, year: number, market: KrxMarket, topN: number): string[] {
  const y = u.years[String(year)]
  if (!y) return []
  return y[market].slice(0, Math.max(0, topN)).map((e) => e.code)
}

/**
 * 그 해 유니버스 = **각 시장 상위 `topN`**의 합집합(코스피 먼저, 코스닥 다음).
 * `topN=10`이면 10+10, `topN=40`이면 40+40이다 — 비교 A/B가 이 인자 하나로 갈린다.
 */
export function krxPitCodes(u: KrxPitUniverse, year: number, topN: number): string[] {
  return [...krxPitMarketCodes(u, year, 'kospi', topN), ...krxPitMarketCodes(u, year, 'kosdaq', topN)]
}

/** 시세를 한 번만 받기 위한 조회용 합집합(중복 제거·정렬). */
export function krxPitUnion(u: KrxPitUniverse, topN: number, years = krxPitYears(u)): string[] {
  const set = new Set<string>()
  for (const y of years) for (const code of krxPitCodes(u, y, topN)) set.add(code)
  return [...set].sort()
}

/** 코드 → 종목명(가장 최근 연도의 표기). 로그에서 "이 코드가 뭐였는지" 잃지 않으려고 둔다. */
export function krxPitNames(u: KrxPitUniverse): Record<string, string> {
  const out: Record<string, string> = {}
  for (const y of krxPitYears(u)) {
    const rec = u.years[String(y)]
    for (const e of [...rec.kospi, ...rec.kosdaq]) out[e.code] = e.name
  }
  return out
}

/**
 * `[from, to]` 구간을 전부 덮는지 확인하고 덮는 연도만 돌려준다.
 * 구멍이 있으면 **던진다** — 조용히 짧은 구간으로 돌면 다른 표와 비교가 성립하지 않는다.
 */
export function krxPitSpan(u: KrxPitUniverse, from: number, to: number): number[] {
  const have = new Set(krxPitYears(u))
  const missing: number[] = []
  const out: number[] = []
  for (let y = from; y <= to; y++) {
    if (have.has(y)) out.push(y)
    else missing.push(y)
  }
  if (missing.length > 0)
    throw new Error(
      `실측 유니버스에 ${from}~${to} 중 ${missing.join(', ')}년이 없다 — ` +
        `${KRX_PIT_PATH}를 EC2 MODE=pityear로 다시 수집하라(수집 불가 연도: ${u.missingYears.join(', ') || '없음'}).`,
    )
  return out
}
