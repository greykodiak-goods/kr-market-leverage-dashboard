// public/data 의 정적 JSON을 Convex로 밀어 넣는 업로더 (Phase A 크론용).
//
// 왜: Phase A의 목표는 "프론트가 URL만 바꿔 끼울 수 있는 백엔드"다. 그러려면 현재 정적
//     파일로 만들어지는 데이터가 DB에도 같은 내용으로 들어가 있어야 한다. 수집 파이프라인
//     (fetch-intraday / paper-trade)은 건드리지 않고, **그 산출물을 그대로 복사**한다.
//     이 단계에서는 정적 파일이 여전히 정본이고 DB는 사본이다 — 병행 검증 후 뒤집는다.
//
// 실행 (시크릿 단일 원본 = Doppler · ops governance/SECRETS-POLICY.md):
//   doppler run --project investing-ops --config prd -- node scripts/convex-sync.mjs
//
// 필요한 시크릿(이름만 — 값은 대표가 Doppler에 입력, T0):
//   CONVEX_URL            HTTP action 도메인. https://<deployment>.convex.site
//                         (.convex.cloud 를 넣어도 자동 교정하고 경고한다)
//   CONVEX_INGEST_SECRET  ingest 헤더 x-ingest-token 값. Convex env 쪽 이름은 INGEST_SECRET
//                         (또는 기존 INGEST_TOKEN) — 양쪽 값이 같아야 한다.
//
// 옵션:
//   --dry-run             전송 없이 계획(요청 수·봉 수)만 출력
//   --recent=N            종목당 최근 N봉만 전송(일일 증분용. 미지정=전량 백필)
//   --only=005930.KS,...  특정 심볼만
//   --skip-intraday / --skip-paper
//
// 첫 실행은 전량 백필(종목당 ~9요청 × 80종목)이고, 이후 일일 갱신은 --recent=500 정도면
// 충분하다(5분봉 하루 78개). 업서트가 멱등이라 겹쳐 보내도 안전하다.
//
// 값은 어떤 경로로도 출력하지 않는다(길이만) — loadSecret 이 출처 한 줄만 stderr로 남긴다.

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadSecret, maskerFor } from './lib/loadSecret.mjs'
import {
  INGEST_BAR_BATCH_MAX,
  RETRY_ATTEMPTS,
  backoffDelayMs,
  httpActionBase,
  indexHeader,
  isRetryableStatus,
  planSymbolIngest,
} from './lib/convexSync.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const INTRADAY_DIR = join(ROOT, 'public', 'data', 'intraday')
const PAPER_DIR = join(ROOT, 'public', 'data', 'paper')

const argv = process.argv.slice(2)
const has = (flag) => argv.includes(flag)
const valueOf = (name) => {
  const hit = argv.find((a) => a.startsWith(`${name}=`))
  return hit ? hit.slice(name.length + 1) : null
}

const DRY_RUN = has('--dry-run')
const RECENT = (() => {
  const raw = valueOf('--recent')
  if (raw == null) return null
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 1) throw new Error('--recent 는 1 이상의 정수여야 합니다')
  return Math.floor(n)
})()
const ONLY = (valueOf('--only') ?? '').split(',').map((s) => s.trim()).filter(Boolean)
const SKIP_INTRADAY = has('--skip-intraday')
const SKIP_PAPER = has('--skip-paper')

const log = (...a) => console.log(...a)

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * ingest POST — 실패 시 지수 백오프로 RETRY_ATTEMPTS회 재시도.
 * 4xx(요청 잘못)는 재시도해도 같으므로 즉시 실패시킨다.
 */
async function post(base, path, body, { token, mask }) {
  let lastErr = null
  for (let attempt = 1; attempt <= RETRY_ATTEMPTS + 1; attempt++) {
    let status = null
    try {
      const res = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-ingest-token': token },
        body: JSON.stringify(body),
      })
      status = res.status
      if (res.ok) return await res.json()
      const text = await res.text().catch(() => '')
      lastErr = new Error(`${path} → HTTP ${status} ${mask(text).slice(0, 300)}`)
    } catch (e) {
      lastErr = new Error(`${path} → ${mask(e?.message ?? String(e))}`)
    }
    if (!isRetryableStatus(status) || attempt > RETRY_ATTEMPTS) break
    const wait = backoffDelayMs(attempt, { jitter: 0.75 + Math.random() * 0.5 })
    log(`  ↻ 재시도 ${attempt}/${RETRY_ATTEMPTS} (${wait}ms) — ${lastErr.message}`)
    await sleep(wait)
  }
  throw lastErr ?? new Error(`${path} 실패`)
}

async function main() {
  // ---- 시크릿 (값 미출력 — loadSecret 이 출처·길이만 남긴다) -----------------
  const urlSec = loadSecret('CONVEX_URL')
  const tokenSec = loadSecret('CONVEX_INGEST_SECRET')
  if (!urlSec.value) {
    console.error(urlSec.help)
    return 1
  }
  if (!tokenSec.value && !DRY_RUN) {
    console.error(tokenSec.help)
    return 1
  }
  const mask = maskerFor(tokenSec.value, urlSec.value)

  const { base, converted } = httpActionBase(urlSec.value)
  if (converted) {
    log('⚠️ CONVEX_URL 이 .convex.cloud 였습니다 — HTTP action 도메인 .convex.site 로 교정해 사용합니다.')
  }
  log(`대상 배포: ${new URL(base).hostname}`) // 호스트명은 시크릿이 아니다(공개 서빙 주소)
  if (DRY_RUN) log('🔎 --dry-run — 전송하지 않고 계획만 출력합니다.')

  const send = async (path, body) => {
    if (DRY_RUN) return { dryRun: true }
    return await post(base, path, body, { token: tokenSec.value, mask })
  }

  let requests = 0
  let barsSent = 0
  let failures = 0

  // ---- 5분봉 -------------------------------------------------------------
  if (!SKIP_INTRADAY && existsSync(INTRADAY_DIR)) {
    const indexPath = join(INTRADAY_DIR, 'index.json')
    const index = existsSync(indexPath) ? readJson(indexPath) : null

    if (index) {
      await send('/ingest/intraday-index', { header: indexHeader(index) })
      requests++
      log('✅ index 헤더 전송')
    } else {
      log('⚠️ index.json 없음 — 헤더 전송 생략')
    }

    const files = readdirSync(INTRADAY_DIR)
      .filter((f) => f.endsWith('.json') && f !== 'index.json')
      .sort()

    for (const f of files) {
      const symbol = f.replace(/\.json$/, '')
      if (ONLY.length > 0 && !ONLY.includes(symbol)) continue

      let plan
      try {
        plan = planSymbolIngest({
          symbol,
          file: readJson(join(INTRADAY_DIR, f)),
          summary: index?.symbols?.[symbol],
          batchSize: INGEST_BAR_BATCH_MAX,
          recent: RECENT,
        })
      } catch (e) {
        log(`⛔ ${symbol}: 파일 파싱 실패 — ${mask(e?.message ?? String(e))}`)
        failures++
        continue
      }

      try {
        // 첫 배치에 meta를 함께 실어 왕복을 하나 아낀다. 봉이 없으면 meta만 보낸다.
        if (plan.batches.length === 0) {
          if (plan.meta) {
            await send('/ingest/intraday', { symbol, meta: plan.meta })
            requests++
          }
          log(`· ${symbol}: 봉 0개 (meta만)`)
          continue
        }
        for (let i = 0; i < plan.batches.length; i++) {
          const body = { symbol, bars: plan.batches[i] }
          if (i === 0 && plan.meta) body.meta = plan.meta
          await send('/ingest/intraday', body)
          requests++
          barsSent += plan.batches[i].length
        }
        const sent = plan.batches.reduce((a, b) => a + b.length, 0)
        log(`✅ ${symbol}: ${plan.batches.length}배치 / ${sent}봉${RECENT ? ` (전체 ${plan.totalBars}봉 중 최근분)` : ''}`)
      } catch (e) {
        log(`⛔ ${symbol}: ${mask(e?.message ?? String(e))}`)
        failures++
      }
    }
  }

  // ---- 페이퍼 트랙 -------------------------------------------------------
  if (!SKIP_PAPER && existsSync(PAPER_DIR)) {
    for (const f of readdirSync(PAPER_DIR).filter((x) => x.endsWith('.json')).sort()) {
      const track = f.replace(/\.json$/, '')
      try {
        // 원문 문자열 그대로 보낸다 — 파싱·재직렬화로 표현이 바뀌지 않게.
        const payload = readFileSync(join(PAPER_DIR, f), 'utf8')
        JSON.parse(payload) // 깨진 파일을 밀어 넣지 않기 위한 사전 검증
        await send('/ingest/paper', { track, payload })
        requests++
        log(`✅ paper/${track}: ${payload.length}바이트`)
      } catch (e) {
        log(`⛔ paper/${track}: ${mask(e?.message ?? String(e))}`)
        failures++
      }
    }
  }

  log(`\n요청 ${requests}건 · 봉 ${barsSent}개 · 실패 ${failures}건${DRY_RUN ? ' (dry-run)' : ''}`)
  return failures === 0 ? 0 : 1
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(`⛔ 예기치 못한 오류: ${e?.message ?? e}`)
    process.exit(1)
  })
