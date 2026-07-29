// 국장 5분봉 누적 수집기 — 백테스트용.
//
// 왜 누적인가:
//   Yahoo v8 chart는 interval=5m 을 지원하지만 **최근 60일치만** 준다(1m은 7일).
//   과거를 소급해 늘릴 무료 경로는 없다. 그래서 매일 받아 쌓는다 —
//   60일 롤링 윈도우이므로 오늘 시작하면 6개월 뒤에 6개월치가 된다.
//   시간이 해결하는 종류의 제약이고, 안 모으면 영원히 60일이다.
//
// 검증된 경로다: 이 리포는 이미 프로덕션에서 같은 엔드포인트로 5분봉을 받는다
//   (src/lib/quotes.ts — '5D': { range: '5d', interval: '5m' }).
//   여기서는 range 를 60d 로 늘려 백테스트용으로 저장만 한다.
//
// 실계좌 경계(규칙 2): 브로커 API·주문·계좌 자격증명 없음. 공개 시세 조회만 한다.
//
// 용량 판단:
//   국장 정규장 6.5시간 = 5분봉 78개/일. 60일(≈40거래일) → 종목당 약 3,100봉.
//   전 종목(약 2,700)을 쌓으면 800만 봉이라 리포 파일로는 무리다.
//   → **감시 종목만** 5분봉으로 쌓고, 전 종목 스크리닝은 일봉으로 한다.
//     이건 실전 운용 구조와도 같다(스크리닝은 일봉, 체결은 분봉).
//
// 사용법:
//   node scripts/fetch-intraday.mjs                 # 기본 감시목록
//   INTRADAY_SYMBOLS=000660.KS,005930.KS node scripts/fetch-intraday.mjs
//   INTRADAY_RANGE=30d node scripts/fetch-intraday.mjs

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { coverage, mergeBars, packBars, parseYahooIntraday, unpackBars } from './lib/intraday.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = join(root, 'public', 'data')
const OUT_FILE = join(OUT_DIR, 'intraday-5m.json')

// 기본 감시목록 — 조건식 검증 대상. 전 종목이 아니라 표본이다.
const DEFAULT_SYMBOLS = ['000660.KS', '005930.KS', '035420.KS', '051910.KS', '005380.KS', '069500.KS']

const SYMBOLS = (process.env.INTRADAY_SYMBOLS ?? DEFAULT_SYMBOLS.join(','))
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
const RANGE = process.env.INTRADAY_RANGE ?? '60d'
const INTERVAL = '5m'

function log(msg) {
  console.error(`[fetch-intraday] ${msg}`)
}

// 프로덕션 프론트엔드와 같은 프록시 순서. 이 스크립트는 서버에서 도니
// direct 를 먼저 시도한다(CORS 무관).
const PROXIES = [
  { name: 'direct', wrap: (u) => u },
  { name: 'codetabs', wrap: (u) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(u)}` },
  { name: 'allorigins', wrap: (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}` },
]

async function fetchOne(symbol) {
  const target = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    symbol,
  )}?range=${RANGE}&interval=${INTERVAL}`
  let lastErr = null
  for (const p of PROXIES) {
    try {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 20000)
      const res = await fetch(p.wrap(target), {
        headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
        signal: ctrl.signal,
      })
      clearTimeout(timer)
      if (!res.ok) throw new Error(`${p.name} HTTP ${res.status}`)
      const json = await res.json()
      const parsed = parseYahooIntraday(json)
      return { ...parsed, proxyUsed: p.name }
    } catch (e) {
      lastErr = e
    }
  }
  throw lastErr ?? new Error('모든 프록시 실패')
}

function loadStore() {
  if (!existsSync(OUT_FILE)) return { meta: {}, symbols: {} }
  try {
    return JSON.parse(readFileSync(OUT_FILE, 'utf8'))
  } catch (e) {
    // 깨진 저장본을 덮어 기존 누적을 날리는 게 최악이다. 멈춘다.
    log(`⛔ 기존 파일을 읽지 못했습니다 — 덮어쓰지 않고 종료합니다: ${e.message}`)
    process.exit(1)
  }
}

async function main() {
  log(`대상 ${SYMBOLS.length}종목 · range=${RANGE} interval=${INTERVAL}`)
  const store = loadStore()
  store.symbols ??= {}

  let ok = 0
  let failed = 0
  const report = []

  for (const sym of SYMBOLS) {
    try {
      const r = await fetchOne(sym)
      if (r.granularity && r.granularity !== INTERVAL) {
        // Yahoo가 요청한 granularity를 못 주면 조용히 다른 간격을 준다.
        // 그걸 5분봉으로 알고 쌓으면 데이터가 오염되므로 거부한다.
        log(`⚠️ ${sym}: granularity가 ${r.granularity} (요청 ${INTERVAL}) — 건너뜀`)
        failed++
        continue
      }
      const before = unpackBars(store.symbols[sym]?.bars)
      const merged = mergeBars(before, r.bars)
      const added = merged.length - before.length
      const cov = coverage(merged)
      store.symbols[sym] = {
        bars: packBars(merged),
        coverage: cov,
        tz: r.tz,
        proxyUsed: r.proxyUsed,
        updatedAt: new Date().toISOString(),
      }
      report.push({ sym, added, total: merged.length, days: cov.days, thin: cov.thinDays.length })
      log(
        `✅ ${sym}: +${added}봉 (누적 ${merged.length}봉 / ${cov.days}거래일 ` +
          `${cov.firstDate}~${cov.lastDate}${cov.thinDays.length ? ` · 구멍 ${cov.thinDays.length}일` : ''})`,
      )
      ok++
    } catch (e) {
      log(`⛔ ${sym}: ${e.message}`)
      failed++
    }
  }

  if (ok === 0) {
    // 한 종목도 못 받았으면 기존 파일을 건드리지 않는다.
    log('⛔ 수집 성공 0건 — 기존 파일을 유지하고 종료합니다.')
    return 1
  }

  store.meta = {
    source: 'Yahoo Finance chart API v8 (비공식·무료)',
    interval: INTERVAL,
    range: RANGE,
    note:
      'Yahoo는 5분봉을 최근 60일치만 제공한다(1분봉 7일). 과거 소급 확장은 불가하며 ' +
      '매일 누적해야 구간이 길어진다. 분할·배당 보정 없음 — 일봉과 달리 adjclose가 제공되지 않으므로 ' +
      '보정 계수를 적용하지 않았다. 장기 구간 비교 시 이 점을 감안할 것.',
    barsPerDay: 78,
    updatedAt: new Date().toISOString(),
    symbolCount: Object.keys(store.symbols).length,
  }

  mkdirSync(OUT_DIR, { recursive: true })
  writeFileSync(OUT_FILE, JSON.stringify(store), 'utf8')
  const bytes = readFileSync(OUT_FILE).length
  log(`기록 ${OUT_FILE} (${(bytes / 1024 / 1024).toFixed(2)} MB)`)
  log(`성공 ${ok} / 실패 ${failed}`)

  // 백테스트 적합성 판단 근거를 남긴다
  const minDays = Math.min(...report.map((r) => r.days))
  if (minDays < 60) {
    log('')
    log(`⚠️ 최소 커버리지 ${minDays}거래일 — 백테스트 판정에는 얇다.`)
    log('   OOS 홀드아웃·워크포워드를 하려면 최소 6개월(약 120거래일) 이상 누적이 필요하다.')
    log('   매일 이 스크립트를 돌려 쌓으면 늘어난다. 안 돌리면 영원히 60일이다.')
  }
  return 0
}

main().then((code) => process.exit(code))
