// HTTP 서빙 — 기획서 §3-A (Phase A: 기존 정적 JSON과 동일 스키마 서빙) + §4-B (ingest)
//
// 서빙 도메인: https://<deployment>.convex.site  (HTTP action 전용 — .convex.cloud 아님에 주의)
//   GET  /data/supply-demand.json  → datasets["supply-demand"] (크론이 조립한 캐시)
//   GET  /data/hynix-outlook.json  → datasets["hynix-outlook"] (로컬 LLM 잡이 ingest)
//   POST /ingest/hynix-outlook     → 헤더 x-ingest-token 필수(INGEST_TOKEN env 검증) → datasets 업서트
//
// Phase A(읽기 호환 백엔드) 추가분 — 기존 정적 파일과 **같은 키 구조**로 서빙한다:
//   GET  /data/intraday/index.json  → 심볼 요약 전체 (현재 80종목, 상한 500)
//   GET  /data/intraday/<심볼>.json → 5분봉. **커서 페이지네이션**(기본 최근 500봉, ?from=/?limit=)
//   GET  /data/paper/<트랙>.json    → 페이퍼 트랙 JSON 원문
//   POST /ingest/intraday           → { symbol, bars?, meta? }  (봉은 1회 500개 상한)
//   POST /ingest/intraday-index     → { header }  index.json의 파일 헤더부
//   POST /ingest/paper              → { track, payload }
//
// 읽기 엔드포인트는 공개(어차피 public 대시보드 데이터), 쓰기만 토큰 보호(§4-B).
// 프론트는 아직 정적 URL 사용 중 — 1주 병행 검증 후 URL 전환(§6 단계 5, 이 커밋 범위 아님).

import { httpRouter } from 'convex/server'
import { httpAction } from './_generated/server'
import { internal } from './_generated/api'
import {
  INTRADAY_INDEX_HEADER_KEY,
  buildIndexResponse,
  buildSymbolResponse,
  normalizeIngestBars,
  parseDataPath,
  parsePageParams,
  sliceBarPage,
} from './lib/intradayServe'

// CORS: 기획서 §3-A — GitHub Pages 오리진 + 로컬 dev 오리진 명시
const ALLOWED_ORIGINS = [
  'https://greykodiak-goods.github.io',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
]
function corsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get('Origin')
  return {
    'Access-Control-Allow-Origin': origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    Vary: 'Origin',
  }
}

function jsonResponse(request: Request, status: number, body: unknown, cacheable = false): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // 브라우저 캐시로 에그레스 절감(§5-C) — 캐시 가능 응답만
      'cache-control': cacheable ? 'public, max-age=600' : 'no-store',
      ...corsHeaders(request),
    },
  })
}

const serveDataset = (key: string) =>
  httpAction(async (ctx, request) => {
    const doc = await ctx.runQuery(internal.datasets.get, { key })
    if (!doc) {
      // 프론트 폴백 체인(Convex → 정적 public/data → SEED)이 받아주는 정직한 404 (§3-A)
      return jsonResponse(request, 404, { error: `dataset "${key}" not ready` })
    }
    return jsonResponse(request, 200, doc.json, true)
  })

const preflight = httpAction(async (_ctx, request) => {
  return new Response(null, {
    status: 204,
    headers: {
      ...corsHeaders(request),
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'content-type, x-ingest-token',
      'Access-Control-Max-Age': '86400',
    },
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// ingest 인증
// 시크릿 **이름만** 코드에 둔다. 값은 대표가 Convex 대시보드 env로 넣는다(T0).
// 이 리포에는 이미 INGEST_TOKEN이 쓰이고 있으므로 그것을 정본으로 두되,
// INGEST_SECRET 이름으로 등록된 경우도 받아준다(시크릿을 두 개 만들지 않기 위함).
function ingestSecret(): string | undefined {
  return process.env.INGEST_SECRET ?? process.env.INGEST_TOKEN
}

/** 인증 실패면 Response를 돌려주고, 통과면 null. */
function authFail(request: Request): Response | null {
  const expected = ingestSecret()
  if (!expected) return jsonResponse(request, 503, { error: 'ingest secret not configured' })
  const got = request.headers.get('x-ingest-token')
  if (!got || got !== expected) return jsonResponse(request, 401, { error: 'invalid ingest token' })
  return null
}

async function readJsonObject(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const j = await request.json()
    if (j == null || typeof j !== 'object' || Array.isArray(j)) return null
    return j as Record<string, unknown>
  } catch {
    return null
  }
}

const http = httpRouter()

http.route({ path: '/data/supply-demand.json', method: 'GET', handler: serveDataset('supply-demand') })
http.route({ path: '/data/supply-demand.json', method: 'OPTIONS', handler: preflight })
http.route({ path: '/data/hynix-outlook.json', method: 'GET', handler: serveDataset('hynix-outlook') })
http.route({ path: '/data/hynix-outlook.json', method: 'OPTIONS', handler: preflight })

// 전망 JSON 수신 (기획서 §4-B) — 로컬 LLM 잡의 마지막 단계가 호출.
// 토큰: INGEST_TOKEN(Convex env) ↔ 로컬 stock-system-docs\secrets\CONVEX_INGEST_TOKEN.txt
http.route({
  path: '/ingest/hynix-outlook',
  method: 'POST',
  handler: httpAction(async (ctx, request) => {
    const expected = process.env.INGEST_TOKEN
    if (!expected) return jsonResponse(request, 503, { error: 'INGEST_TOKEN not configured' })
    const got = request.headers.get('x-ingest-token')
    if (!got || got !== expected) return jsonResponse(request, 401, { error: 'invalid ingest token' })

    let json: unknown
    try {
      json = await request.json()
    } catch {
      return jsonResponse(request, 400, { error: 'body must be valid JSON' })
    }
    if (json == null || typeof json !== 'object' || Array.isArray(json)) {
      return jsonResponse(request, 400, { error: 'body must be a JSON object' })
    }
    const { updatedAt } = await ctx.runMutation(internal.datasets.upsert, {
      key: 'hynix-outlook',
      json,
      producer: 'local-llm-job',
    })
    return jsonResponse(request, 200, { ok: true, key: 'hynix-outlook', updatedAt })
  }),
})
http.route({ path: '/ingest/hynix-outlook', method: 'OPTIONS', handler: preflight })

// ─────────────────────────────────────────────────────────────────────────────
// Phase A — 읽기 호환 서빙 (/data/intraday/*, /data/paper/*)
//
// 경로 해석은 순수 함수 parseDataPath가 담당한다(허용 패턴 밖은 404).
// pathPrefix 하나로 index.json과 개별 심볼을 함께 받는다 — 라우팅 규칙이 두 곳에 흩어지지 않게.

const serveIntraday = httpAction(async (ctx, request) => {
  const url = new URL(request.url)
  const routed = parseDataPath(url.pathname)
  if (!routed) return jsonResponse(request, 404, { error: 'not found' })

  if (routed.kind === 'intraday-index') {
    const [{ metas, truncated }, headerDoc] = await Promise.all([
      ctx.runQuery(internal.intraday.listMeta, {}),
      ctx.runQuery(internal.datasets.get, { key: INTRADAY_INDEX_HEADER_KEY }),
    ])
    if (metas.length === 0) {
      // 프론트 폴백 체인(Convex → 정적 public/data → SEED)이 받아주는 정직한 404.
      return jsonResponse(request, 404, { error: 'intraday index not ready' })
    }
    const header = (headerDoc?.json ?? null) as Record<string, unknown> | null
    return jsonResponse(request, 200, buildIndexResponse({ header, metas, truncated }), true)
  }

  if (routed.kind === 'intraday-symbol') {
    const { symbol } = routed
    const { from, limit } = parsePageParams(url.searchParams)
    const [rowsPlusOne, meta] = await Promise.all([
      ctx.runQuery(internal.intraday.listBars, { symbol, from: from ?? undefined, limit }),
      ctx.runQuery(internal.intraday.getMeta, { symbol }),
    ])
    if (rowsPlusOne.length === 0 && !meta) {
      return jsonResponse(request, 404, { error: `symbol "${symbol}" not ready` })
    }
    const { rows, page } = sliceBarPage(rowsPlusOne, limit, from == null ? 'latest' : 'from', from)
    return jsonResponse(request, 200, buildSymbolResponse({ symbol, rows, meta, page }), true)
  }

  return jsonResponse(request, 404, { error: 'not found' })
})

const servePaper = httpAction(async (ctx, request) => {
  const routed = parseDataPath(new URL(request.url).pathname)
  if (!routed || routed.kind !== 'paper') return jsonResponse(request, 404, { error: 'not found' })

  const doc = await ctx.runQuery(internal.paper.getTrack, { track: routed.track })
  if (!doc) return jsonResponse(request, 404, { error: `track "${routed.track}" not ready` })

  // payload는 원문 문자열 — 다시 파싱·직렬화하지 않고 그대로 흘려보낸다(왕복 무손실).
  return new Response(doc.payload, {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'public, max-age=600',
      ...corsHeaders(request),
    },
  })
})

http.route({ pathPrefix: '/data/intraday/', method: 'GET', handler: serveIntraday })
http.route({ pathPrefix: '/data/intraday/', method: 'OPTIONS', handler: preflight })
http.route({ pathPrefix: '/data/paper/', method: 'GET', handler: servePaper })
http.route({ pathPrefix: '/data/paper/', method: 'OPTIONS', handler: preflight })

// ─────────────────────────────────────────────────────────────────────────────
// Phase A — ingest (scripts/convex-sync.mjs 가 호출)

http.route({
  path: '/ingest/intraday',
  method: 'POST',
  handler: httpAction(async (ctx, request) => {
    const denied = authFail(request)
    if (denied) return denied

    const body = await readJsonObject(request)
    if (!body) return jsonResponse(request, 400, { error: 'body must be a JSON object' })

    const symbol = body.symbol
    if (typeof symbol !== 'string' || !symbol) {
      return jsonResponse(request, 400, { error: 'symbol is required' })
    }

    const result: Record<string, unknown> = { ok: true, symbol }

    if (body.bars !== undefined) {
      const norm = normalizeIngestBars(body.bars)
      if (!norm.ok) return jsonResponse(request, 400, { error: norm.error })
      result.bars = await ctx.runMutation(internal.intraday.ingestBatch, { symbol, bars: norm.bars })
    }

    if (body.meta !== undefined) {
      const m = body.meta as Record<string, unknown> | null
      if (m == null || typeof m !== 'object' || Array.isArray(m)) {
        return jsonResponse(request, 400, { error: 'meta must be an object' })
      }
      if (
        typeof m.bars !== 'number' ||
        typeof m.days !== 'number' ||
        typeof m.first !== 'string' ||
        typeof m.last !== 'string' ||
        typeof m.thin !== 'number'
      ) {
        return jsonResponse(request, 400, { error: 'meta requires bars/days/first/last/thin' })
      }
      result.meta = await ctx.runMutation(internal.intraday.upsertMeta, {
        symbol,
        bars: m.bars,
        days: m.days,
        first: m.first,
        last: m.last,
        thin: m.thin,
        coverage: m.coverage,
        tz: typeof m.tz === 'string' ? m.tz : undefined,
        name: typeof m.name === 'string' ? m.name : undefined,
        market: typeof m.market === 'string' ? m.market : undefined,
        rank: typeof m.rank === 'number' ? m.rank : undefined,
      })
    }

    return jsonResponse(request, 200, result)
  }),
})
http.route({ path: '/ingest/intraday', method: 'OPTIONS', handler: preflight })

// index.json의 파일 헤더부(source/interval/range/note/barsPerDay/updatedAt) — datasets에 보관.
http.route({
  path: '/ingest/intraday-index',
  method: 'POST',
  handler: httpAction(async (ctx, request) => {
    const denied = authFail(request)
    if (denied) return denied

    const body = await readJsonObject(request)
    if (!body) return jsonResponse(request, 400, { error: 'body must be a JSON object' })
    const header = body.header
    if (header == null || typeof header !== 'object' || Array.isArray(header)) {
      return jsonResponse(request, 400, { error: 'header must be an object' })
    }

    const { updatedAt } = await ctx.runMutation(internal.datasets.upsert, {
      key: INTRADAY_INDEX_HEADER_KEY,
      json: header,
      producer: 'convex-sync',
    })
    return jsonResponse(request, 200, { ok: true, key: INTRADAY_INDEX_HEADER_KEY, updatedAt })
  }),
})
http.route({ path: '/ingest/intraday-index', method: 'OPTIONS', handler: preflight })

http.route({
  path: '/ingest/paper',
  method: 'POST',
  handler: httpAction(async (ctx, request) => {
    const denied = authFail(request)
    if (denied) return denied

    const body = await readJsonObject(request)
    if (!body) return jsonResponse(request, 400, { error: 'body must be a JSON object' })

    const track = body.track
    if (typeof track !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(track)) {
      return jsonResponse(request, 400, { error: 'track must match ^[a-z0-9][a-z0-9_-]{0,31}$' })
    }
    // 문자열이면 원문 그대로, 객체면 직렬화해서 보관한다.
    const payload =
      typeof body.payload === 'string'
        ? body.payload
        : body.payload !== undefined
          ? JSON.stringify(body.payload)
          : null
    if (payload == null) return jsonResponse(request, 400, { error: 'payload is required' })

    const r = await ctx.runMutation(internal.paper.upsertTrack, { track, payload })
    return jsonResponse(request, 200, { ok: true, track, ...r })
  }),
})
http.route({ path: '/ingest/paper', method: 'OPTIONS', handler: preflight })

export default http
