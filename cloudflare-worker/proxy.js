// Cloudflare Worker — scoped CORS proxy for the KR market dashboard.
//
// Usage from the client:  https://<your-worker>.workers.dev/?url=<ENCODED_TARGET_URL>
// It fetches the (allow-listed) target and returns the body with permissive CORS
// headers so the static GitHub Pages site can call APIs that block browser CORS
// (Yahoo Finance, Google News RSS, GDELT, Stooq).
//
// Security:
//  - Only the hosts in ALLOWED_HOSTS may be proxied (prevents open-proxy abuse).
//  - Browser requests are restricted to the dashboard origin + localhost.
//  - Short edge cache to reduce upstream load / rate-limit pressure.

const ALLOWED_HOSTS = [
  'query1.finance.yahoo.com',
  'query2.finance.yahoo.com',
  'news.google.com',
  'api.gdeltproject.org',
  'stooq.com',
]

const ALLOWED_ORIGINS = [
  'https://greykodiak-goods.github.io',
  // local dev
  'http://localhost:5173',
  'http://127.0.0.1:5173',
]

const CACHE_TTL_SECONDS = 60

function isLocalhost(origin) {
  return /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)
}

function corsHeaders(origin) {
  // Reflect an allowed origin; otherwise allow non-browser (no Origin) via '*'.
  const allow = origin && (ALLOWED_ORIGINS.includes(origin) || isLocalhost(origin)) ? origin : '*'
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Requested-With',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  }
}

export default {
  async fetch(request) {
    const origin = request.headers.get('Origin') || ''

    // Preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) })
    }
    if (request.method !== 'GET') {
      return new Response('Method Not Allowed', { status: 405, headers: corsHeaders(origin) })
    }

    // Restrict browser callers to the dashboard origin + localhost.
    if (origin && !ALLOWED_ORIGINS.includes(origin) && !isLocalhost(origin)) {
      return new Response('Forbidden origin', { status: 403, headers: corsHeaders(origin) })
    }

    const reqUrl = new URL(request.url)
    const target = reqUrl.searchParams.get('url')
    if (!target) {
      return new Response('Missing ?url= parameter', { status: 400, headers: corsHeaders(origin) })
    }

    let targetUrl
    try {
      targetUrl = new URL(target)
    } catch {
      return new Response('Invalid target URL', { status: 400, headers: corsHeaders(origin) })
    }

    if (!ALLOWED_HOSTS.includes(targetUrl.hostname)) {
      return new Response(`Host not allowed: ${targetUrl.hostname}`, { status: 403, headers: corsHeaders(origin) })
    }

    // Fetch upstream with a short edge cache.
    let upstream
    try {
      upstream = await fetch(targetUrl.toString(), {
        method: 'GET',
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
          Accept: '*/*',
        },
        cf: { cacheTtl: CACHE_TTL_SECONDS, cacheEverything: true },
      })
    } catch (err) {
      return new Response(`Upstream fetch failed: ${err}`, { status: 502, headers: corsHeaders(origin) })
    }

    const headers = new Headers(corsHeaders(origin))
    const ct = upstream.headers.get('Content-Type')
    if (ct) headers.set('Content-Type', ct) // pass through content-type
    headers.set('Cache-Control', `public, max-age=${CACHE_TTL_SECONDS}`)

    return new Response(upstream.body, { status: upstream.status, headers })
  },
}
