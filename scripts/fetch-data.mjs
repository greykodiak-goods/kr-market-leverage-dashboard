// Attempts to fetch LIVE data from KRX 정보데이터시스템 and 금융투자협회 FreeSIS,
// normalize it, and overwrite public/data/*.json. On ANY failure (CORS, bot
// protection, structure change, network) it leaves the existing seed files in
// place so the dashboard always renders. Run in CI before `npm run build`.
//
// NOTE: KRX endpoints are protected and frequently return "LOGOUT" for
// unauthenticated server calls. This script is intentionally defensive: it never
// throws fatally, it just reports what it could and could not fetch.

import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { execSync } from 'node:child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUT = join(__dirname, '..', 'public', 'data')

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'

async function krxPost(bld, extra = {}) {
  const body = new URLSearchParams({
    bld,
    locale: 'ko_KR',
    csvxls_isNo: 'false',
    ...extra,
  })
  const res = await fetch('http://data.krx.co.kr/comm/bldAttendant/getJsonData.cmd', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'User-Agent': UA,
      Referer: 'http://data.krx.co.kr/contents/MDC/MDI/mdiLoader/index.cmd',
      'X-Requested-With': 'XMLHttpRequest',
    },
    body,
  })
  const text = await res.text()
  if (text.trim() === 'LOGOUT' || text.trim().startsWith('<')) {
    throw new Error('KRX returned LOGOUT / non-JSON (bot protection)')
  }
  return JSON.parse(text)
}

async function tryLive() {
  const results = { attempted: [], succeeded: [], failed: [] }

  // Example: 신용거래융자 종목별 (MDCSTAT02501). Real normalization would map fields
  // to the { date, kospi, kosdaq, total } shape. Kept as a probe here.
  const probes = [
    { name: 'credit-balance', bld: 'dbms/MDC/STAT/standard/MDCSTAT02501', extra: { mktId: 'STK' } },
  ]

  for (const p of probes) {
    results.attempted.push(p.name)
    try {
      const json = await krxPost(p.bld, p.extra)
      const rows = json.OutBlock_1 || json.output || json.block1 || []
      if (!Array.isArray(rows) || rows.length === 0) throw new Error('empty rows')
      // Normalization to the dashboard schema would go here once the live
      // schema is confirmed. Until then we count this as a soft failure and
      // keep the seed data.
      throw new Error('live schema mapping not yet wired — keeping seed data')
    } catch (err) {
      results.failed.push(`${p.name}: ${err.message}`)
    }
  }
  return results
}

async function main() {
  console.log('[fetch-data] Attempting live KRX/FreeSIS fetch...')
  let live
  try {
    live = await tryLive()
  } catch (err) {
    live = { attempted: [], succeeded: [], failed: [`fatal: ${err.message}`] }
  }

  console.log('[fetch-data] attempted:', live.attempted.join(', ') || '(none)')
  console.log('[fetch-data] succeeded:', live.succeeded.join(', ') || '(none)')
  console.log('[fetch-data] failed:', live.failed.join(' | ') || '(none)')

  if (live.succeeded.length === 0) {
    console.log('[fetch-data] No live data captured. Ensuring seed data exists.')
    if (!existsSync(join(OUT, 'credit-balance.json'))) {
      console.log('[fetch-data] Seed missing — generating.')
      execSync('node scripts/generate-seed.mjs', { cwd: join(__dirname, '..'), stdio: 'inherit' })
    } else {
      console.log('[fetch-data] Seed data present — dashboard will render with SAMPLE data.')
    }
  }
  // Never exit non-zero: a failed live fetch must not break the build.
  process.exit(0)
}

main()
