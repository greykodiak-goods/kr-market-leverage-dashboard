// convex-sync 의 **순수 로직** — 파일·네트워크를 건드리지 않아 테스트 가능하다.
//
// 왜 분리했나: 업로더 스크립트는 네트워크가 있어야 돌아가는데, 정작 틀리기 쉬운 곳은
// 배치 분할·URL 정규화·백오프 계산 같은 순수 계산부다. 그 부분만 떼어 여기 두고
// tests/convex-sync.test.ts 가 네트워크 없이 검증한다.
//
// ⚠️ 이 파일에 시크릿 관련 코드를 두지 말 것 — 시크릿은 scripts/lib/loadSecret.mjs 하나만 쓴다.

/** ingest 1회 호출당 봉 상한. convex/lib/intradayServe.ts 의 INGEST_BAR_BATCH_MAX 와 같은 값. */
export const INGEST_BAR_BATCH_MAX = 500

/** 재시도 횟수(최초 시도 포함하지 않은 추가 시도 수). */
export const RETRY_ATTEMPTS = 3

/**
 * Convex HTTP action 도메인 정규화.
 *
 * 함정: Convex는 함수 API가 `<deployment>.convex.cloud`, **HTTP action은
 * `<deployment>.convex.site`** 로 서로 다른 도메인이다. CONVEX_URL에 .cloud 주소가
 * 들어오는 실수가 잦아 여기서 조용히 바로잡고 호출부가 경고를 남기게 한다.
 *
 * @returns {{ base: string, converted: boolean }}
 */
export function httpActionBase(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) throw new Error('CONVEX_URL 이 비어 있습니다')
  let u
  try {
    u = new URL(rawUrl.trim())
  } catch {
    throw new Error('CONVEX_URL 형식이 올바르지 않습니다 (예: https://<deployment>.convex.site)')
  }
  if (u.protocol !== 'https:' && u.hostname !== 'localhost' && u.hostname !== '127.0.0.1') {
    throw new Error('CONVEX_URL 은 https 여야 합니다')
  }
  let converted = false
  if (u.hostname.endsWith('.convex.cloud')) {
    u.hostname = u.hostname.slice(0, -'.convex.cloud'.length) + '.convex.site'
    converted = true
  }
  const base = `${u.protocol}//${u.host}`.replace(/\/+$/, '')
  return { base, converted }
}

/** 배열을 size개씩 자른다. size 이하면 1덩어리, 빈 배열이면 빈 결과. */
export function chunk(arr, size = INGEST_BAR_BATCH_MAX) {
  if (!Array.isArray(arr)) throw new TypeError('chunk: 배열이 아닙니다')
  const n = Math.max(1, Math.floor(size))
  const out = []
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n))
  return out
}

/**
 * 지수 백오프 대기(ms). attempt는 1부터.
 * 지터를 곱해 여러 종목이 동시에 재시도로 몰리는 것을 막는다(jitter 인자는 테스트에서 고정).
 */
export function backoffDelayMs(attempt, { baseMs = 500, maxMs = 8000, jitter = 1 } = {}) {
  const raw = baseMs * 2 ** (Math.max(1, attempt) - 1)
  return Math.min(maxMs, Math.round(raw * jitter))
}

/**
 * 컬럼형 bars({ts,o,h,l,c,v}) → 행 배열. 길이가 어긋나면 가장 짧은 축까지만 쓴다
 * (부분 손상 파일에서 undefined를 밀어 넣지 않기 위함).
 */
export function unpackBars(p) {
  if (!p || !Array.isArray(p.ts)) return []
  const lens = [p.ts, p.o, p.h, p.l, p.c, p.v].map((a) => (Array.isArray(a) ? a.length : 0))
  const n = Math.min(...lens)
  const out = []
  for (let i = 0; i < n; i++) {
    out.push({ t: p.ts[i], o: p.o[i], h: p.h[i], l: p.l[i], c: p.c[i], v: p.v[i] })
  }
  return out
}

/**
 * index.json 에서 심볼 목록을 뺀 **헤더부**만 뽑는다.
 * (심볼 요약은 종목별 ingest로 들어가므로 헤더에 중복 저장하지 않는다.)
 */
export function indexHeader(indexJson) {
  if (!indexJson || typeof indexJson !== 'object') return {}
  const { symbols: _symbols, symbolCount: _symbolCount, ...header } = indexJson
  return header
}

/**
 * 종목 1개의 ingest 계획을 만든다 — 네트워크 없이 "무엇을 몇 번 보낼지"가 결정된다.
 *
 * @param {object} args
 * @param {string} args.symbol
 * @param {object} args.file      public/data/intraday/<심볼>.json 파싱 결과
 * @param {object} [args.summary] index.json 의 symbols[심볼] 항목
 * @param {number} [args.batchSize]
 * @param {number|null} [args.recent] 지정하면 **최근 N봉만** 보낸다(일일 크론용).
 *                                    최초 백필은 생략(전량). meta는 항상 전체 기준으로 보낸다.
 * @returns {{ symbol: string, meta: object|null, batches: Array<Array<object>>, totalBars: number }}
 */
export function planSymbolIngest({ symbol, file, summary, batchSize = INGEST_BAR_BATCH_MAX, recent = null }) {
  const all = unpackBars(file?.bars)
  // 시간 오름차순으로 고정 — 파일이 뒤섞여 있어도 배치 경계가 결정적이 된다.
  all.sort((a, b) => a.t - b.t)

  // 매일 전량(종목당 9요청 × 80종목)을 다시 밀 이유가 없다. 증분 갱신은 꼬리만 보낸다.
  // 업서트가 멱등이므로 겹쳐 보내는 것은 안전하다(중복은 값이 같으면 쓰기 없이 skip).
  const n = typeof recent === 'number' && recent > 0 ? Math.floor(recent) : null
  const rows = n != null && all.length > n ? all.slice(-n) : all

  const cov = file?.coverage ?? null
  const meta =
    summary || cov
      ? {
          bars: summary?.bars ?? cov?.bars ?? all.length,
          days: summary?.days ?? cov?.days ?? 0,
          first: summary?.first ?? cov?.firstDate ?? '',
          last: summary?.last ?? cov?.lastDate ?? '',
          thin: summary?.thin ?? (Array.isArray(cov?.thinDays) ? cov.thinDays.length : 0),
          // 마감 절단(2026-08-03 발견) — coverage 안에도 들어 있지만 **1급 필드로 올린다.**
          // 소비자가 coverage를 안 펼쳐 보면 결함을 모른 채 종가를 쓰게 되고, 그게 이 사고의
          // 재발 경로다. usableFrom === null 이면 "쓸 수 있는 구간이 없다"는 뜻이다.
          truncated: summary?.truncated ?? cov?.truncatedDays ?? 0,
          usableFrom: summary?.usableFrom ?? cov?.usableFrom ?? null,
          coverage: cov ?? undefined,
          tz: file?.tz ?? undefined,
        }
      : null

  return { symbol, meta, batches: chunk(rows, batchSize), totalBars: all.length }
}

/** 재시도 대상 판정 — 4xx(요청 잘못)는 재시도해도 같으니 즉시 실패, 5xx·네트워크만 재시도. */
export function isRetryableStatus(status) {
  if (status == null) return true // 네트워크 예외
  return status >= 500 || status === 408 || status === 429
}
