// HTTP 서빙 — 기획서 §3-A (Phase A: 기존 정적 JSON과 동일 스키마 서빙) + §4-B (ingest)
//
// 서빙 도메인: https://<deployment>.convex.site  (HTTP action 전용 — .convex.cloud 아님에 주의)
//   GET  /data/supply-demand.json  → datasets["supply-demand"] (크론이 조립한 캐시)
//   GET  /data/hynix-outlook.json  → datasets["hynix-outlook"] (로컬 LLM 잡이 ingest)
//   POST /ingest/hynix-outlook     → 헤더 x-ingest-token 필수(INGEST_TOKEN env 검증) → datasets 업서트
//
// 읽기 엔드포인트는 공개(어차피 public 대시보드 데이터), 쓰기만 토큰 보호(§4-B).
// 프론트는 아직 정적 URL 사용 중 — 1주 병행 검증 후 dataBase.ts로 전환(§6 단계 5, 이 커밋 범위 아님).

import { httpRouter } from 'convex/server'
import { httpAction } from './_generated/server'
import { internal } from './_generated/api'

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

export default http
