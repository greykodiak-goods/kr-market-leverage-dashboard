// 국장 5분봉 누적 수집기 — 백테스트용.
//
// 왜 누적인가:
//   Yahoo v8 chart는 interval=5m 을 지원하지만 **최근 60일치만** 준다(1m은 7일).
//   과거를 소급해 늘릴 무료 경로는 없다. 그래서 매일 받아 쌓는다 —
//   60일 롤링 윈도우이므로 오늘 시작하면 6개월 뒤에 6개월치가 된다.
//
// 감시 대상 (2026-07-30 대표 지시: 코스피 시총 상위 40 + 코스닥 시총 상위 40):
//   시총 순위는 매일 바뀌므로 하드코딩하지 않는다. 실행 시점에 네이버 시총
//   랭킹을 받아 상위 40+40을 뽑고(우선주·스팩 제외 — 유니버스 정책과 동일),
//   랭킹 조회가 실패하면 정적 시드로 폴백한다. **이미 누적 중인 종목은 랭킹에서
//   빠져도 계속 수집한다** — 끊으면 누적 구간이 고아가 된다.
//
// 저장 (종목별 파일 분리):
//   public/data/intraday/<심볼>.json + index.json(요약).
//   80종목 누적을 단일 파일로 쌓으면 1년 내 수십 MB → GitHub 100MB 한도에
//   닿는다("데이터는 반드시 늘어난다" — 나중에 최적화 없음). 종목별로 나누면
//   파일당 연 ~1MB 수준이고, 봉이 추가된 파일만 다시 쓰므로 git 차분도 작다.
//   구 단일 파일(intraday-5m.json)은 첫 실행에서 종목별로 이관 후 제거한다.
//
// 실계좌 경계(규칙 2): 공개 시세 조회만. 브로커 API·주문·계좌 자격증명 없음.
//
// 사용법:
//   node scripts/fetch-intraday.mjs                          # 랭킹 40+40 + 기존 누적
//   INTRADAY_SYMBOLS=000660.KS,005930.KS node scripts/...    # 명시 목록만 (랭킹 무시)
//   INTRADAY_TOP_N=20 node scripts/fetch-intraday.mjs        # 상위 N 조정

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildWatchlist,
  coverage,
  mergeBars,
  packBars,
  parseYahooIntraday,
  rankingToSymbols,
  unpackBars,
} from './lib/intraday.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = join(root, 'public', 'data', 'intraday')
const INDEX_FILE = join(OUT_DIR, 'index.json')
const LEGACY_FILE = join(root, 'public', 'data', 'intraday-5m.json')

const RANGE = process.env.INTRADAY_RANGE ?? '60d'
const INTERVAL = '5m'
const TOP_N = Number(process.env.INTRADAY_TOP_N ?? 40)

// 폴백 시드 — 랭킹 조회가 죽었을 때만 쓴다. [추정 스냅샷 2026-07 기준, 정본은
// 실행 시점 랭킹] 순위 정확성보다 "유동성 있는 대형주 표본"이면 충분하다.
const SEED_KOSPI = [
  '005930', '000660', '373220', '207940', '005380', '000270', '068270', '105560', '035420', '329180',
  '055550', '012450', '028260', '012330', '005490', '032830', '009540', '086790', '051910', '042660',
  '138040', '000810', '035720', '006400', '033780', '096770', '066570', '034020', '017670', '316140',
  '030200', '259960', '011200', '402340', '010130', '015760', '024110', '003550', '010140', '086280',
].map((c) => `${c}.KS`)
const SEED_KOSDAQ = [
  '196170', '247540', '086520', '028300', '214450', '000250', '214150', '141080', '145020', '277810',
  '087010', '950160', '348370', '035900', '041510', '257720', '058470', '068760', '310210', '078600',
  '240810', '039030', '036930', '357780', '403870', '089030', '005290', '095340', '399720', '237690',
  '225570', '293490', '112040', '263750', '328130', '376300',
].map((c) => `${c}.KQ`)

function log(msg) {
  console.error(`[fetch-intraday] ${msg}`)
}

// 서버 실행이라 direct 우선 (CORS 무관). 프록시는 폴백.
const PROXIES = [
  { name: 'direct', wrap: (u) => u },
  { name: 'codetabs', wrap: (u) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(u)}` },
  { name: 'allorigins', wrap: (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}` },
]

async function fetchJson(target, timeoutMs = 15000) {
  let lastErr = null
  for (const p of PROXIES) {
    try {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), timeoutMs)
      const res = await fetch(p.wrap(target), {
        headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
        signal: ctrl.signal,
      })
      clearTimeout(timer)
      if (!res.ok) throw new Error(`${p.name} HTTP ${res.status}`)
      return { json: await res.json(), proxyUsed: p.name }
    } catch (e) {
      lastErr = e
    }
  }
  throw lastErr ?? new Error('모든 프록시 실패')
}

/** 네이버 시총 랭킹 → 상위 topN 심볼. 실패는 호출부에서 처리(폴백). */
async function fetchRanking(market, topN) {
  const url = `https://m.stock.naver.com/api/stocks/marketValue/${market}?page=1&pageSize=${topN + 20}`
  const { json } = await fetchJson(url)
  const ranked = rankingToSymbols(json, market, topN)
  if (ranked.length === 0) throw new Error(`${market} 랭킹 응답에 종목 0개 — 응답 형식 변경 의심`)
  return ranked
}

async function fetchBars(symbol) {
  const target = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    symbol,
  )}?range=${RANGE}&interval=${INTERVAL}`
  const { json, proxyUsed } = await fetchJson(target, 20000)
  return { ...parseYahooIntraday(json), proxyUsed }
}

function symbolFile(symbol) {
  return join(OUT_DIR, `${symbol}.json`)
}

function loadSymbolStore(symbol) {
  const f = symbolFile(symbol)
  if (!existsSync(f)) return null
  try {
    return JSON.parse(readFileSync(f, 'utf8'))
  } catch (e) {
    // 깨진 파일을 덮어 누적을 날리는 게 최악이다 — 이 종목만 건너뛴다.
    log(`⛔ ${symbol}: 기존 파일 파손 — 이번 회차 건너뜀 (${e.message})`)
    return { corrupt: true }
  }
}

function listStoredSymbols() {
  if (!existsSync(OUT_DIR)) return []
  return readdirSync(OUT_DIR)
    .filter((f) => f.endsWith('.json') && f !== 'index.json')
    .map((f) => f.replace(/\.json$/, ''))
}

/** 구 단일 파일 → 종목별 파일 1회 이관. 이관분은 mergeBars로 합쳐져 데이터 손실 없음. */
function migrateLegacy() {
  if (!existsSync(LEGACY_FILE)) return
  try {
    const legacy = JSON.parse(readFileSync(LEGACY_FILE, 'utf8'))
    const syms = Object.keys(legacy.symbols ?? {})
    mkdirSync(OUT_DIR, { recursive: true })
    for (const sym of syms) {
      const bars = unpackBars(legacy.symbols[sym]?.bars)
      const cur = loadSymbolStore(sym)
      const merged = mergeBars(cur && !cur.corrupt ? unpackBars(cur.bars) : [], bars)
      writeFileSync(
        symbolFile(sym),
        JSON.stringify({ symbol: sym, bars: packBars(merged), coverage: coverage(merged) }),
        'utf8',
      )
    }
    unlinkSync(LEGACY_FILE)
    log(`구 단일 파일 → 종목별 이관 완료 (${syms.length}종목), intraday-5m.json 제거`)
  } catch (e) {
    log(`⚠️ 레거시 이관 실패 — 구 파일 유지: ${e.message}`)
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  migrateLegacy()

  // ---- 감시목록 결정 -------------------------------------------------------
  const stored = listStoredSymbols()
  const nameBySym = new Map() // 심볼 → 종목명 (랭킹 실측 + 직전 index 유지)
  let symbols
  let watchSource
  if (process.env.INTRADAY_SYMBOLS) {
    symbols = process.env.INTRADAY_SYMBOLS.split(',').map((s) => s.trim()).filter(Boolean)
    watchSource = 'INTRADAY_SYMBOLS(수동)'
  } else {
    let ranked = []
    try {
      const kospi = await fetchRanking('KOSPI', TOP_N)
      const kosdaq = await fetchRanking('KOSDAQ', TOP_N)
      ranked = [...kospi, ...kosdaq]
      watchSource = `네이버 시총 랭킹 (KOSPI ${kospi.length} + KOSDAQ ${kosdaq.length})`
    } catch (e) {
      watchSource = `정적 시드 폴백 — 랭킹 조회 실패: ${e.message}`
    }
    symbols = buildWatchlist(ranked, stored, [...SEED_KOSPI, ...SEED_KOSDAQ])
    for (const r of ranked) if (r.name) nameBySym.set(r.symbol, r.name)
  }
  log(`감시목록 ${symbols.length}종목 · 출처: ${watchSource} · 기존 누적 ${stored.length}종목 유지`)
  log(`range=${RANGE} interval=${INTERVAL}`)

  // ---- 수집 ---------------------------------------------------------------
  mkdirSync(OUT_DIR, { recursive: true })
  let ok = 0
  let failed = 0
  let unchanged = 0
  const summary = {}
  // 랭킹 이탈(orphan) 종목은 직전 index.json의 이름을 유지한다 — UI 종목명 표시용
  try {
    const prev = JSON.parse(readFileSync(join(OUT_DIR, 'index.json'), 'utf8'))
    for (const [s, v] of Object.entries(prev.symbols ?? {})) if (v?.name && !nameBySym.has(s)) nameBySym.set(s, v.name)
  } catch {
    /* 첫 실행이면 없음 */
  }

  for (const sym of symbols) {
    try {
      const cur = loadSymbolStore(sym)
      if (cur?.corrupt) {
        failed++
        continue
      }
      const r = await fetchBars(sym)
      if (r.granularity && r.granularity !== INTERVAL) {
        // Yahoo가 요청한 granularity를 못 주면 조용히 다른 간격을 준다 — 오염 방지 거부.
        log(`⚠️ ${sym}: granularity ${r.granularity} (요청 ${INTERVAL}) — 건너뜀`)
        failed++
        continue
      }
      const before = cur ? unpackBars(cur.bars) : []
      const merged = mergeBars(before, r.bars)
      const added = merged.length - before.length
      const cov = coverage(merged)
      summary[sym] = {
        ...(nameBySym.get(sym) ? { name: nameBySym.get(sym) } : {}),
        bars: merged.length,
        days: cov.days,
        first: cov.firstDate,
        last: cov.lastDate,
        thin: cov.thinDays.length,
      }
      const next = JSON.stringify({ symbol: sym, bars: packBars(merged), coverage: cov, tz: r.tz })
      // 내용이 그대로면 다시 쓰지 않는다 — 휴장일에 전 파일이 갈리는 것을 방지
      const prevRaw = existsSync(symbolFile(sym)) ? readFileSync(symbolFile(sym), 'utf8') : null
      if (prevRaw === next) unchanged++
      else writeFileSync(symbolFile(sym), next, 'utf8')
      if (added > 0) log(`✅ ${sym}: +${added}봉 (누적 ${merged.length}봉 / ${cov.days}거래일)`)
      ok++
    } catch (e) {
      log(`⛔ ${sym}: ${e.message}`)
      failed++
    }
    await sleep(200) // Yahoo 유량 예의
  }

  if (ok === 0) {
    log('⛔ 수집 성공 0건 — 기존 파일을 유지하고 종료합니다.')
    return 1
  }

  // ---- 인덱스 -------------------------------------------------------------
  const allDays = Object.values(summary).map((s) => s.days)
  writeFileSync(
    INDEX_FILE,
    JSON.stringify(
      {
        source: 'Yahoo Finance chart API v8 (비공식·무료) · 감시목록: ' + watchSource,
        interval: INTERVAL,
        range: RANGE,
        note:
          'Yahoo는 5분봉을 최근 60일치만 제공(1분봉 7일) — 매일 누적해야 구간이 길어진다. ' +
          '분할·배당 보정 없음(adjclose 미제공). 우선주·스팩 제외. 랭킹 이탈 종목도 누적은 계속된다.',
        barsPerDay: 78,
        updatedAt: new Date().toISOString(),
        symbolCount: Object.keys(summary).length,
        symbols: summary,
      },
      null,
      1,
    ),
    'utf8',
  )

  const totalBytes = listStoredSymbols().reduce((s, sym) => s + readFileSync(symbolFile(sym)).length, 0)
  log(`기록 ${OUT_DIR} (${(totalBytes / 1024 / 1024).toFixed(2)} MB · ${Object.keys(summary).length}종목 · 무변경 ${unchanged})`)
  log(`성공 ${ok} / 실패 ${failed}`)

  const minDays = allDays.length ? Math.min(...allDays) : 0
  if (minDays < 120) {
    log(`⚠️ 최소 커버리지 ${minDays}거래일 — OOS·워크포워드 판정에는 최소 6개월(약 120거래일) 필요. 매일 돌리면 늘어난다.`)
  }
  return 0
}

main().then((code) => process.exit(code))
