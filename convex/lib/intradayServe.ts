// Convex 이관 Phase A — 서빙 응답 조립 · 페이지네이션 커서의 **순수 로직**.
//
// 왜 분리했나:
//   HTTP action 안에 조립·커서 계산이 섞여 있으면 네트워크 없이는 검증할 수 없다.
//   여기에는 convex 런타임 import를 **일절 두지 않는다** — 그래야 tests/convex-sync.test.ts가
//   esbuild로 그대로 번들해 검증할 수 있다. 이 파일에 convex import를 추가하지 말 것.
//
// 응답 계약(§Phase A의 핵심):
//   프론트가 URL만 바꿔 끼울 수 있어야 하므로 기존 정적 JSON과 **키 구조가 같아야 한다**.
//   실측 기준(2026-07-30 public/data 실파일):
//     public/data/intraday/index.json
//       { source, interval, range, note, barsPerDay, updatedAt, symbolCount,
//         symbols: { "<심볼>": { bars, days, first, last, thin } } }
//     public/data/intraday/<심볼>.json
//       { symbol, bars: { ts[], o[], h[], l[], c[], v[] }, coverage, tz }
//     public/data/paper/<트랙>.json  — 트랙별로 키가 다른 통짜 JSON(그대로 보존)
//
//   개별 심볼 응답에는 페이지네이션 때문에 `page` 키가 **추가**된다(기존 키는 불변).
//   기존 소비자는 이 키를 무시하면 되고, 전량 로드가 필요한 소비자는 page.nextFrom으로 이어 받는다.

/** 봉 1개 — Convex 행(row) 표현. `t`는 epoch **초**(정적 JSON의 ts와 동일 단위). */
export type BarRow = { t: number; o: number; h: number; l: number; c: number; v: number }

/** 정적 JSON과 동일한 컬럼형 묶음. */
export type PackedBars = { ts: number[]; o: number[]; h: number[]; l: number[]; c: number[]; v: number[] }

/** index.json의 심볼별 요약 1건 (실파일 기준). */
export type SymbolSummary = { bars: number; days: number; first: string; last: string; thin: number }

/** intradayMeta 테이블 문서에서 서빙에 필요한 부분만. */
export type MetaLike = {
  symbol: string
  bars: number
  days: number
  first: string
  last: string
  thin: number
  coverage?: unknown
  tz?: string
  updatedAt?: string
}

/** 한 번에 돌려주는 기본 봉 수. 상한 없는 전체 조회 금지(ops 최우선 가이드 규칙 2). */
export const DEFAULT_BAR_PAGE = 500
/** 클라이언트가 limit을 키워도 여기서 잘린다. */
export const MAX_BAR_PAGE = 2000
/** index 응답의 심볼 상한 — 현재 80종목이지만 유니버스가 늘어도 무한 스캔이 되지 않게 못을 박는다. */
export const MAX_INDEX_SYMBOLS = 500

const SYMBOL_RE = /^[0-9A-Za-z]{1,12}\.(KS|KQ)$/
const TRACK_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/

export type RoutedPath =
  | { kind: 'intraday-index' }
  | { kind: 'intraday-symbol'; symbol: string }
  | { kind: 'paper'; track: string }

/**
 * 요청 경로 → 리소스 판별. 정적 파일 경로와 **같은 모양**만 받아들인다.
 * 심볼·트랙은 화이트리스트 정규식으로 제한한다(임의 문자열로 인덱스를 긁게 두지 않는다).
 * 매칭되지 않으면 null → 호출부가 404.
 */
export function parseDataPath(pathname: string): RoutedPath | null {
  if (pathname === '/data/intraday/index.json') return { kind: 'intraday-index' }

  const intraday = /^\/data\/intraday\/([^/]+)\.json$/.exec(pathname)
  if (intraday) {
    const symbol = decodeURIComponent(intraday[1])
    return SYMBOL_RE.test(symbol) ? { kind: 'intraday-symbol', symbol } : null
  }

  const paper = /^\/data\/paper\/([^/]+)\.json$/.exec(pathname)
  if (paper) {
    const track = decodeURIComponent(paper[1])
    return TRACK_RE.test(track) ? { kind: 'paper', track } : null
  }

  return null
}

export type PageParams = { from: number | null; limit: number }

/**
 * 쿼리스트링 → 페이지 파라미터.
 *  - `from` 없음 → "최근 limit봉" 모드(화면 초기 로드).
 *  - `from=<epoch초>` → 그 시점부터 오름차순 limit봉(이어받기 커서).
 * 잘못된 값은 예외 대신 기본값으로 떨어뜨린다(서빙 중단보다 낫다).
 */
export function parsePageParams(search: {
  get(name: string): string | null
}): PageParams {
  const rawFrom = search.get('from')
  const rawLimit = search.get('limit')

  let from: number | null = null
  if (rawFrom != null && rawFrom !== '') {
    const n = Number(rawFrom)
    if (Number.isFinite(n)) from = Math.max(0, Math.floor(n))
  }

  let limit = DEFAULT_BAR_PAGE
  if (rawLimit != null && rawLimit !== '') {
    const n = Number(rawLimit)
    if (Number.isFinite(n) && n >= 1) limit = Math.min(MAX_BAR_PAGE, Math.floor(n))
  }

  return { from, limit }
}

export type PageInfo = {
  mode: 'latest' | 'from'
  limit: number
  from: number | null
  /** 다음 요청에 넣을 `?from=` 값. null이면 더 없음. */
  nextFrom: number | null
  hasMore: boolean
  /** 이 페이지에서 가장 오래된 봉의 t — 과거로 거슬러 갈 때의 힌트. */
  oldestT: number | null
  returned: number
}

/**
 * limit+1개를 읽어온 결과를 페이지로 자른다 — "더 있는지"를 count 쿼리 없이 판정하는 표준 수법.
 * rows는 **오름차순**이어야 한다.
 */
export function sliceBarPage(
  rowsPlusOne: BarRow[],
  limit: number,
  mode: 'latest' | 'from',
  from: number | null,
): { rows: BarRow[]; page: PageInfo } {
  const hasMore = mode === 'from' && rowsPlusOne.length > limit
  const rows = rowsPlusOne.slice(0, limit)
  return {
    rows,
    page: {
      mode,
      limit,
      from,
      // 다음 페이지는 마지막 봉 **다음** 시각부터 — 경계 봉이 두 번 오지 않게 +1초.
      nextFrom: hasMore && rows.length > 0 ? rows[rows.length - 1].t + 1 : null,
      hasMore,
      oldestT: rows.length > 0 ? rows[0].t : null,
      returned: rows.length,
    },
  }
}

/** 행 배열 → 정적 JSON과 동일한 컬럼형. 입력 순서를 그대로 보존한다(정렬은 호출부 책임). */
export function packRows(rows: BarRow[]): PackedBars {
  const ts: number[] = []
  const o: number[] = []
  const h: number[] = []
  const l: number[] = []
  const c: number[] = []
  const v: number[] = []
  for (const r of rows) {
    ts.push(r.t)
    o.push(r.o)
    h.push(r.h)
    l.push(r.l)
    c.push(r.c)
    v.push(r.v)
  }
  return { ts, o, h, l, c, v }
}

/** 컬럼형 → 행 배열. 길이가 어긋나면 가장 짧은 축까지만(부분 손상 데이터로 NaN을 만들지 않는다). */
export function unpackBars(p: Partial<PackedBars> | null | undefined): BarRow[] {
  if (!p || !Array.isArray(p.ts)) return []
  const n = Math.min(
    p.ts.length,
    p.o?.length ?? 0,
    p.h?.length ?? 0,
    p.l?.length ?? 0,
    p.c?.length ?? 0,
    p.v?.length ?? 0,
  )
  const out: BarRow[] = []
  for (let i = 0; i < n; i++) {
    out.push({
      t: (p.ts as number[])[i],
      o: (p.o as number[])[i],
      h: (p.h as number[])[i],
      l: (p.l as number[])[i],
      c: (p.c as number[])[i],
      v: (p.v as number[])[i],
    })
  }
  return out
}

/**
 * 개별 심볼 응답 조립 — 기존 파일 키(symbol/bars/coverage/tz)를 그대로 두고 `page`만 추가한다.
 * `coverage`는 **저장된 전체 시계열** 기준이며 이 페이지의 요약이 아니다(문서·응답 주석으로 명시).
 */
export function buildSymbolResponse(args: {
  symbol: string
  rows: BarRow[]
  meta: MetaLike | null
  page: PageInfo
}): Record<string, unknown> {
  const { symbol, rows, meta, page } = args
  return {
    symbol,
    bars: packRows(rows),
    coverage: meta?.coverage ?? null,
    tz: meta?.tz ?? 'Asia/Seoul',
    // 추가 키 — 기존 소비자는 무시해도 되고, 전량이 필요하면 nextFrom으로 이어 받는다.
    page,
  }
}

/**
 * index.json 조립 — 헤더(수집기가 남긴 메타)와 심볼 요약을 합친다.
 * symbolCount는 헤더 값을 믿지 않고 **실제 서빙한 심볼 수**로 다시 센다(정직성 규칙 3).
 */
export function buildIndexResponse(args: {
  header: Record<string, unknown> | null
  metas: MetaLike[]
  truncated: boolean
}): Record<string, unknown> {
  const { header, metas, truncated } = args
  const symbols: Record<string, SymbolSummary> = {}
  for (const m of metas) {
    symbols[m.symbol] = { bars: m.bars, days: m.days, first: m.first, last: m.last, thin: m.thin }
  }

  const latestMetaUpdate = metas.reduce<string | null>(
    (acc, m) => (m.updatedAt && (acc === null || m.updatedAt > acc) ? m.updatedAt : acc),
    null,
  )

  const base = header ?? {}
  const out: Record<string, unknown> = {
    source: base.source ?? null,
    interval: base.interval ?? null,
    range: base.range ?? null,
    note: base.note ?? null,
    barsPerDay: base.barsPerDay ?? null,
    updatedAt: base.updatedAt ?? latestMetaUpdate,
    symbolCount: metas.length,
    symbols,
  }
  // 상한에 걸려 잘렸으면 조용히 넘어가지 않고 응답에 남긴다(정직성 규칙 3).
  if (truncated) out.truncated = { limit: MAX_INDEX_SYMBOLS, note: 'symbol cap reached' }
  return out
}

/** index 헤더가 저장되는 datasets 키 — 수집기·서빙이 같은 상수를 쓰게 한 곳에 둔다. */
export const INTRADAY_INDEX_HEADER_KEY = 'intraday-index-header'

/** ingest 1회 호출당 봉 상한. 스크립트·mutation 양쪽이 이 값을 공유한다. */
export const INGEST_BAR_BATCH_MAX = 500

/**
 * ingest 본문의 봉 배열 검증·정규화.
 * mutation 검증기에 맡기면 잘못된 요청이 500으로 나간다 — 여기서 걸러 400으로 돌려준다.
 * 통과 결과는 t 오름차순·중복 제거 상태다.
 */
export function normalizeIngestBars(
  input: unknown,
): { ok: true; bars: BarRow[] } | { ok: false; error: string } {
  if (!Array.isArray(input)) return { ok: false, error: 'bars must be an array' }
  if (input.length > INGEST_BAR_BATCH_MAX) {
    return { ok: false, error: `bars length ${input.length} exceeds batch max ${INGEST_BAR_BATCH_MAX}` }
  }

  const byT = new Map<number, BarRow>()
  for (let i = 0; i < input.length; i++) {
    const b = input[i] as Record<string, unknown> | null
    if (b == null || typeof b !== 'object') return { ok: false, error: `bars[${i}] must be an object` }
    const nums: Record<string, number> = {}
    for (const k of ['t', 'o', 'h', 'l', 'c', 'v'] as const) {
      const n = b[k]
      if (typeof n !== 'number' || !Number.isFinite(n)) {
        return { ok: false, error: `bars[${i}].${k} must be a finite number` }
      }
      nums[k] = n
    }
    if (!Number.isInteger(nums.t) || nums.t < 0) {
      return { ok: false, error: `bars[${i}].t must be a non-negative integer (epoch seconds)` }
    }
    byT.set(nums.t, { t: nums.t, o: nums.o, h: nums.h, l: nums.l, c: nums.c, v: nums.v })
  }

  const bars = [...byT.values()].sort((a, b) => a.t - b.t)
  return { ok: true, bars }
}
