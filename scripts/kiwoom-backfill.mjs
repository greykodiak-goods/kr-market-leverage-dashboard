// 키움 5분봉 수집기 — EC2(등록 IP·국내 IP)에서 실행 · 조회 전용 · 규칙 2 준수.
//
// 두 가지 모드가 하나의 스크립트에 있다 (병합·시간축 정렬·대조·스로틀이 공통이라
// 스크립트를 쪼개면 그 로직이 갈라진다):
//
//   ① 기본(소급 백필) — 주 1회. 각 종목을 연속조회(cont-yn/next-key)로 서버 소급
//      한도까지 당겨 과거 구간을 채운다. 대상 = 이미 저장소에 있는 종목.
//   ② --daily(증분)   — 평일 장 마감 후. **그날 + 최근 결측분만** 받는다.
//      소급 하한은 "저장소 최신 봉 − 하루(겹침)"이고, 오래 멈췄던 경우를 대비해
//      --max-days(기본 7일)로 바닥을 깐다. 종목당 보통 1~2요청이면 끝난다 [추정].
//      감시목록도 이 모드가 갱신한다 — 네이버 시총 랭킹 상위 40+40 ∪ 기존 누적 종목
//      (랭킹 신규 편입은 오늘부터 누적 시작, 랭킹 이탈은 계속 수집 = 고아 방지).
//      index.json(요약·종목명·랭킹 순서)도 여기서 쓴다.
//
// 왜 키움인가 (2026-08-03 대표 지시 "5분봉도 키움으로 전환"):
//   구 매일 수집은 Yahoo v8 5분봉(60일 롤링·GitHub Actions)이었다. 소스가 둘이면
//   같은 파일 안에서 보정 기준·시간축 규약이 갈라지고, 주간 백필이 매번 그 차이를
//   대조해야 했다. 정본을 키움 하나로 모은다. **2026-08-03 이전 구간에는 Yahoo로
//   받은 봉이 남아 있으므로**(같은 파일에 병합됨) 겹침 대조 로직은 그대로 둔다.
//   키움은 등록 IP를 요구해 GitHub Actions에서 돌지 않는다 → EC2 크론이 정본 실행처.
//
// 하는 일:
//   1) 대상 종목의 키움 ka10080 분봉을 연속조회로 당긴다(수정주가 upd_stkpc_tp=1).
//   2) 병합 전에 **기존 저장분과 겹치는 구간을 대조**한다(종가 불일치율·시간축 오프셋).
//      키움 cntr_tm이 봉의 시작/끝 어느 쪽인지 문서가 불명확해 [미검증], 오프셋
//      0/±300초 중 가장 잘 맞는 정렬을 자동 탐지해 저장 규약(봉 시작 시각)에 맞춘다.
//   3) 저장소에 병합(신규 = 키움이 겹침 구간 우선). --dry-run 이면 보고까지만.
//
// 실행 (docs/mock-trading.md §4-④ 참조):
//   doppler run --project investing-ops --config prd -- node scripts/kiwoom-backfill.mjs [옵션]
//   옵션: --daily(증분 모드) --dry-run(병합 없이 보고만) --max-days=730
//         --max-req=200(종목당 요청 상한) --symbols=005930.KS,...
//   EC2 크론: scripts/server/investing-cron.sh {daily-intraday|weekly-backfill}
//
// 주의: 소급 백필은 종목당 수십 회 요청 × 80종목이라 20분 이상 걸릴 수 있다. 중간에
// 끊겨도 다시 실행하면 이어진다(이미 충분히 소급된 종목은 건너뜀).

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { loadSecret } from './lib/loadSecret.mjs'
import { createKiwoomClient, parseMinuteChart } from './lib/kiwoom.mjs'
import {
  SEED_SYMBOLS,
  buildWatchlist,
  coverage,
  dailyCutoffTs,
  kstDate,
  mergeBars,
  orderIndexSymbols,
  packBars,
  rankingToSymbols,
  unpackBars,
} from './lib/intraday.mjs'

const args = new Map(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/)
    return m ? [m[1], m[2] ?? 'true'] : [a, 'true']
  }),
)
const DAILY = args.get('daily') === 'true'
const DRY_RUN = args.get('dry-run') === 'true'
const MAX_DAYS = Number(args.get('max-days') ?? (DAILY ? 7 : 730))
const REQ_CAP = Number(args.get('max-req') ?? (DAILY ? 10 : 200))
const ONLY = args.get('symbols')?.split(',').map((s) => s.trim()).filter(Boolean) ?? null
const TOP_N = Number(process.env.INTRADAY_TOP_N ?? 40)

const OUT_DIR = join(process.cwd(), 'public', 'data', 'intraday')
const INDEX_FILE = join(OUT_DIR, 'index.json')
mkdirSync(OUT_DIR, { recursive: true })

// ---- 시크릿 (모의투자용 키 우선 — kiwoom-probe와 동일 체계) ------------------
const mockKey = loadSecret('KIWOOM_MOCK_APP_KEY')
const mockSecret = loadSecret('KIWOOM_MOCK_APP_SECRET')
const key = mockKey.value ? mockKey : loadSecret('KIWOOM_APP_KEY')
const secret = mockSecret.value ? mockSecret : loadSecret('KIWOOM_APP_SECRET')
if (!key.value || !secret.value) {
  console.error(key.help ?? secret.help)
  process.exit(1)
}
// 대량 연속조회라 유량 제한에 민감 — 호출 간격을 1.2초로 넉넉히 (429 실측 대응)
const client = createKiwoomClient({ appKey: key.value, appSecret: secret.value, minIntervalMs: 1200 })
console.log(`서버: ${client.base} (모의서버 — 시세가 실서버와 동일한지는 대조 보고로 확인 [미검증])`)
console.log(
  `모드: ${DAILY ? `--daily 증분(최근 ${MAX_DAYS}일 한도)` : `소급 백필(목표 ${MAX_DAYS}일)`} · ${
    DRY_RUN ? 'dry-run(보고만)' : '병합 저장'
  } · 종목당 요청 상한 ${REQ_CAP}`,
)

// ---- 저장소 헬퍼 -------------------------------------------------------------
const symbolFile = (sym) => join(OUT_DIR, `${sym.replace(/[^0-9A-Za-z.^-]/g, '_')}.json`)
/**
 * 저장소 읽기. **"파일 없음"과 "파일 깨짐"을 구분한다** — 둘을 뭉뚱그려 null로 돌리면
 * 깨진 파일을 이번 회차 몇 봉으로 덮어써 누적 전체가 날아간다(수집기에서 가장 비싼 사고).
 * @returns {{corrupt?: string}|object|null}  null = 파일 없음(신규 종목)
 */
function loadStore(sym) {
  const f = symbolFile(sym)
  if (!existsSync(f)) return null
  try {
    return JSON.parse(readFileSync(f, 'utf8'))
  } catch (e) {
    return { corrupt: String(e.message).slice(0, 100) }
  }
}
function listStored() {
  return readdirSync(OUT_DIR)
    .filter((f) => f.endsWith('.json') && f !== 'index.json')
    .map((f) => f.replace(/\.json$/, ''))
}

// ---- 네이버 시총 랭킹 (감시목록 갱신 — --daily 전용) --------------------------
// 시세가 아니라 "오늘의 시총 상위 목록"이다. 키움에는 대체 TR이 없어 그대로 둔다.
// 서버 실행이라 direct 우선(CORS 무관), 프록시는 폴백.
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
      return await res.json()
    } catch (e) {
      lastErr = e
    }
  }
  throw lastErr ?? new Error('모든 프록시 실패')
}

async function fetchRanking(market, topN) {
  const url = `https://m.stock.naver.com/api/stocks/marketValue/${market}?page=1&pageSize=${topN + 20}`
  const ranked = rankingToSymbols(await fetchJson(url), market, topN)
  if (ranked.length === 0) throw new Error(`${market} 랭킹 응답에 종목 0개 — 응답 형식 변경 의심`)
  return ranked
}

// ---- 키움 → 표준 봉 (시간축 정렬 포함) ---------------------------------------
/** 오프셋 후보 중 기존 저장분과 가장 많이 겹치는 정렬을 고른다. 겹침이 없으면 0. */
function detectOffset(kBars, yBars) {
  if (!yBars.length || !kBars.length) return { offset: 0, basis: '겹침 없음 — 오프셋 0 가정 [미검증]' }
  const yTs = new Set(yBars.map((b) => b.ts))
  let best = { offset: 0, hits: -1 }
  for (const off of [0, -300, 300]) {
    const hits = kBars.reduce((n, b) => n + (yTs.has(b.t + off) ? 1 : 0), 0)
    if (hits > best.hits) best = { offset: off, hits }
  }
  return { offset: best.offset, basis: `겹침 ${best.hits}봉 기준 오프셋 ${best.offset}s` }
}

/** 겹침 구간 종가 대조 — 불일치율(>0.1%)과 평균 편차를 보고 */
function compareOverlap(kBars, yBars, offset) {
  const yBy = new Map(yBars.map((b) => [b.ts, b]))
  let n = 0
  let bad = 0
  let sumAbs = 0
  for (const b of kBars) {
    const y = yBy.get(b.t + offset)
    if (!y || !Number.isFinite(y.c) || y.c <= 0) continue
    n++
    const dev = Math.abs(b.c - y.c) / y.c
    sumAbs += dev
    if (dev > 0.001) bad++
  }
  return { n, badPct: n ? (bad / n) * 100 : null, avgDevPct: n ? (sumAbs / n) * 100 : null }
}

// ---- 대상 종목 결정 -----------------------------------------------------------
const stored = listStored()
const nameBySym = new Map() // 심볼 → 종목명 (랭킹 실측). 나머지는 직전 index.json 유지.
let watchlist
let watchSource
let rankingOk = false
if (ONLY) {
  watchlist = ONLY
  watchSource = '--symbols(수동)'
} else if (DAILY) {
  let ranked = []
  try {
    const kospi = await fetchRanking('KOSPI', TOP_N)
    const kosdaq = await fetchRanking('KOSDAQ', TOP_N)
    ranked = [...kospi, ...kosdaq]
    rankingOk = ranked.length > 0
    watchSource = `네이버 시총 랭킹 (KOSPI ${kospi.length} + KOSDAQ ${kosdaq.length})`
  } catch (e) {
    watchSource = `정적 시드 폴백 — 랭킹 조회 실패: ${e.message}`
  }
  // 랭킹 순서가 앞, 랭킹 이탈 누적 종목이 뒤 (index.json 순서 = 랭킹 순서 규약)
  watchlist = buildWatchlist(ranked, stored, SEED_SYMBOLS)
  for (const r of ranked) if (r.name) nameBySym.set(r.symbol, r.name)
} else {
  watchlist = stored
  watchSource = '기존 저장소(소급 백필은 감시목록을 넓히지 않는다)'
}
// RANKING_RUN = 오늘 시총 랭킹을 **실제로 받아서** 전 종목을 도는 회차.
// 이 회차만 index.json의 심볼 순서(=랭킹 순서)를 새로 정할 자격이 있다.
// 랭킹 조회가 실패했거나(시드 폴백) 대상이 일부(--symbols·백필)면 직전 순서를 보존한다 —
// 안 그러면 파일 나열 순(코드순)이 index에 박혀 랭킹 순서가 조용히 사라진다.
const RANKING_RUN = DAILY && !ONLY && rankingOk
const targets = watchlist.filter((s) => /^\d{6}\.(KS|KQ)$/.test(s))
console.log(`감시목록 ${targets.length}종목 · 출처: ${watchSource} · 기존 누적 ${stored.length}종목`)

// ---- 수집 루프 ---------------------------------------------------------------
const nowSec = Math.floor(Date.now() / 1000)
const backfillCutoff = nowSec - MAX_DAYS * 86400
const report = []
const covBySym = new Map() // 이번 회차에 갱신된 종목의 커버리지 (index 조립용)
const gapRisk = [] // 증분 소급 한도 밖으로 뒤처져 구멍이 남는 종목
let requestsTotal = 0
let addedTotal = 0
/** 이번 회차에 봉을 실제로 받은 종목 — 검증 범위·"전량 실패" 판정의 근거다. */
const collectedSyms = []
/** 호출이 예외로 끝난 종목(토큰 만료·IP 미등록·서버 점검) — 휴장일의 "빈 응답"과 구분한다. */
const erroredSyms = []
/**
 * 이번 회차에 받은 봉 중 **가장 이른 시각**. 검증 범위를 이번에 새로 들어온 구간으로
 * 좁히는 데 쓴다 — 파일에 남아 있는 야후 시절 누적분(매일 14:55에 끝나는 절단 구간)이
 * 매일의 수집을 무기한 막지 않게 하기 위함이다(2026-08-03 실측: 96.7%가 절단).
 * 그 구간의 결함은 주간 전수 검증이 계속 FAIL로 들고 있다 — 숨기는 것이 아니라 분리한다.
 */
let updatedFromTs = Infinity

for (const sym of targets) {
  const code = sym.slice(0, 6)
  const store = loadStore(sym)
  if (store?.corrupt) {
    // 덮어쓰면 누적이 날아간다 — 이 종목만 건너뛰고 사람이 보게 남긴다.
    console.log(`⛔ ${sym}: 기존 파일 파손 — 이번 회차 건너뜀 (${store.corrupt})`)
    report.push({ sym, skipped: `기존 파일 파손 — 수동 확인 필요 (${store.corrupt})` })
    continue
  }
  const existing = store ? unpackBars(store.bars) : []
  const oldestExisting = existing.length ? existing[0].ts : null
  const newestExisting = existing.length ? existing[existing.length - 1].ts : null

  // 어디까지 거슬러 받을 것인가 — 증분은 "저장소 최신 봉 − 하루", 백필은 목표 소급일.
  const cutoffTs = DAILY ? dailyCutoffTs(newestExisting, nowSec, MAX_DAYS) : backfillCutoff
  // 증분이 소급 바닥(--max-days)에 걸리면 저장소와 새 봉 사이에 **구멍이 남는다**.
  // 조용히 넘기면 백테스트가 빈 구간을 정상으로 착각한다 — 종목별로 세워 마지막에 보고한다.
  if (DAILY && newestExisting != null && newestExisting < nowSec - MAX_DAYS * 86400) {
    gapRisk.push(`${sym}(최신 ${Math.round((nowSec - newestExisting) / 86400)}일 전)`)
  }
  // 백필만 "이미 목표 깊이 도달"을 건너뛴다. 증분은 매번 최신 봉을 받아야 하므로 건너뛰지 않는다.
  if (!DAILY && oldestExisting != null && oldestExisting <= cutoffTs) {
    report.push({ sym, skipped: '이미 목표 소급 도달', bars: existing.length })
    continue
  }

  const collected = []
  let contYn = 'N'
  let nextKey = ''
  let requests = 0
  let stop = ''
  try {
    for (;;) {
      const { json, cont } = await client.minuteChart(code, { minutes: 5, adjusted: true, contYn, nextKey })
      requests++
      requestsTotal++
      const parsed = parseMinuteChart(json)
      if (!parsed.bars.length) {
        stop = '빈 응답'
        break
      }
      collected.push(...parsed.bars)
      const oldest = parsed.bars[0].t
      if (oldest <= cutoffTs) {
        stop = DAILY ? '저장소 커버리지 도달' : '목표 깊이 도달'
        break
      }
      if (cont.contYn !== 'Y' || !cont.nextKey) {
        stop = '서버 소급 한도(연속조회 끝)'
        break
      }
      contYn = 'Y'
      nextKey = cont.nextKey
      if (requests >= REQ_CAP) {
        stop = `요청 상한(${REQ_CAP}회/종목) — 재실행으로 이어받기`
        break
      }
    }
  } catch (e) {
    stop = `오류: ${String(e.message).slice(0, 120)}`
  }

  if (!collected.length) {
    report.push({ sym, skipped: stop || '수집 0봉', bars: existing.length })
    if (String(stop).startsWith('오류:')) erroredSyms.push(sym)
    if (existing.length && store?.coverage) covBySym.set(sym, store.coverage)
    continue
  }
  collectedSyms.push(sym)

  // 정렬·대조 (기존 저장분 기준 — 2026-08-03 이전 구간은 Yahoo로 받은 봉일 수 있다)
  const { offset, basis } = detectOffset(collected, existing)
  const cmp = compareOverlap(collected, existing, offset)
  const incoming = collected.map((b) => ({ ts: b.t + offset, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v }))
  for (const b of incoming) if (b.ts < updatedFromTs) updatedFromTs = b.ts
  const merged = mergeBars(existing, incoming) // 키움(신규) 우선
  const added = merged.length - existing.length
  addedTotal += added
  const oldestNew = merged[0]?.ts
  const days = oldestNew ? Math.round((nowSec - oldestNew) / 86400) : 0
  // 키움이 실제로 준 가장 오래된 봉 — 병합 깊이와 분리해 보고해야 소급 한도가 보인다
  const kOldest = collected.reduce((m, b) => Math.min(m, b.t), Infinity)
  const kDays = Number.isFinite(kOldest) ? Math.round((nowSec - kOldest) / 86400) : 0

  const cov = coverage(merged)
  covBySym.set(sym, cov)
  // 내용(봉)이 그대로면 다시 쓰지 않는다 — 휴장일에 80개 파일이 통째로 갈려 git 차분이
  // 부푸는 것을 막는다. 봉 수가 같아도 **값이 바뀌면**(수정주가 소급 재계산) 쓴다.
  const packed = packBars(merged)
  const changed = JSON.stringify(store?.bars ?? null) !== JSON.stringify(packed)
  if (!DRY_RUN && (changed || !existsSync(symbolFile(sym)))) {
    writeFileSync(
      symbolFile(sym),
      JSON.stringify({
        symbol: sym,
        bars: packed,
        coverage: cov,
        tz: 'Asia/Seoul',
        backfill: {
          source: 'kiwoom-ka10080',
          mode: DAILY ? 'daily' : 'backfill',
          at: new Date().toISOString(),
          offsetSec: offset,
        },
      }),
    )
  }
  report.push({
    sym,
    요청: requests,
    수집봉: collected.length,
    추가: added,
    병합후: merged.length,
    소급일: days,
    키움소급일: kDays,
    중단사유: stop,
    오프셋: `${offset}s (${basis})`,
    대조: cmp.n ? `겹침 ${cmp.n}봉 · 불일치(>0.1%) ${cmp.badPct.toFixed(1)}% · 평균편차 ${cmp.avgDevPct.toFixed(3)}%` : '겹침 없음',
  })
  console.log(
    DAILY
      ? `${sym}: +${added}봉 (수집 ${collected.length} / ${requests}req · 누적 ${merged.length}봉 ${cov.days}일) · ${report[report.length - 1].대조} · ${stop}`
      : `${sym}: ${collected.length}봉(+${requests}req) → 키움 소급 ${kDays}일 · 병합 후 ${days}일 · ${report[report.length - 1].대조} · ${stop}`,
  )
}

// ---- index.json (요약·종목명·랭킹 순서) --------------------------------------
// 프론트(종목명)·spec-backtest(유니버스와 랭킹 순서)가 이 파일을 읽는다. 구 Yahoo
// 수집기가 쓰던 자리를 그대로 이어받는다 — 여기서 안 쓰면 인덱스가 그대로 굳는다.
function writeIndex() {
  let prev = null
  try {
    prev = JSON.parse(readFileSync(INDEX_FILE, 'utf8'))
  } catch {
    /* 첫 실행이면 없음 */
  }
  const prevSymbols = prev?.symbols ?? {}
  const storedNow = listStored().filter((s) => /^\d{6}\.(KS|KQ)$/.test(s))
  // 순서 기준: **오늘 랭킹을 실제로 조회한 회차만** 순서를 새로 정한다(RANKING_RUN).
  // 백필·--symbols 회차는 대상이 일부라 그 순서를 index에 반영하면 랭킹 순서가 깨진다
  // (spec-backtest가 상위 20을 자르는 근거가 사라진다) — 직전 순서를 그대로 보존한다.
  const preferred = RANKING_RUN ? targets : Object.keys(prevSymbols)
  if (!RANKING_RUN && preferred.length === 0) {
    console.log('index.json: 직전 인덱스가 없어 랭킹 순서를 알 수 없음 — 쓰지 않고 건너뜀(--daily 실행이 채운다)')
    return
  }
  const ordered = orderIndexSymbols(preferred, storedNow)

  const symbols = {}
  for (const sym of ordered) {
    let cov = covBySym.get(sym)
    if (!cov) {
      const p = prevSymbols[sym]
      if (p && Number.isFinite(p.bars)) {
        // 이번 회차에 안 건드린 종목은 직전 요약을 그대로 승계 (대용량 파일 재파싱 회피)
        symbols[sym] = { ...(nameBySym.get(sym) ? { name: nameBySym.get(sym) } : p.name ? { name: p.name } : {}), bars: p.bars, days: p.days, first: p.first, last: p.last, thin: p.thin }
        continue
      }
      cov = loadStore(sym)?.coverage ?? null
    }
    if (!cov) continue
    const name = nameBySym.get(sym) ?? prevSymbols[sym]?.name
    symbols[sym] = {
      ...(name ? { name } : {}),
      bars: cov.bars,
      days: cov.days,
      first: cov.firstDate,
      last: cov.lastDate,
      thin: (cov.thinDays ?? []).length,
    }
  }

  const watchlistNote = RANKING_RUN ? watchSource : (prev?.watchlist ?? watchSource)
  writeFileSync(
    INDEX_FILE,
    JSON.stringify(
      {
        source: `키움증권 REST ka10080 5분봉(수정주가 upd_stkpc_tp=1) · 감시목록: ${watchlistNote}`,
        interval: '5m',
        collector: `scripts/kiwoom-backfill.mjs ${DAILY ? '--daily (EC2 크론 daily-intraday)' : '(EC2 크론 weekly-backfill)'}`,
        watchlist: watchlistNote,
        note:
          '2026-08-03부터 매일 수집도 키움이다. **그 이전 구간에는 Yahoo v8 5분봉으로 받은 봉이 남아 있다**(같은 파일에 병합 — 겹침 구간 종가 대조는 백필 로그 참조). ' +
          '분할 등 수정주가 반영·배당 미반영 [미검증]. 우선주·스팩·ETF 제외. 랭킹 이탈 종목도 누적은 계속된다.',
        barsPerDay: 78,
        updatedAt: new Date().toISOString(),
        symbolCount: Object.keys(symbols).length,
        symbols,
      },
      null,
      1,
    ),
    'utf8',
  )
  console.log(`index.json 갱신: ${Object.keys(symbols).length}종목 (순서 = ${RANKING_RUN ? '오늘 랭킹' : '직전 인덱스 순서 보존'})`)
}

// ---- 전량 실패 게이트 (2026-08-03) -------------------------------------------
//
// 구 Yahoo 수집기(fetch-intraday.mjs)에는 `if (ok === 0) return 1` 가드가 있었는데 이관되지
// 않았다. 그 상태로는 앱키 만료·IP 등록 해제·서버 점검으로 **전 종목이 실패해도** 종목별
// catch가 오류를 삼키고, index.json만 오늘 날짜로 다시 쓰인 뒤 크론이 "3층 검증 통과"로
// 커밋한다 — 초록 커밋이 매일 쌓이는데 실제 데이터는 사고 당일에 멈춰 있고 아무도 모른다.
// 그래서 **하나도 못 받았고 오류가 하나라도 있으면** 인덱스를 건드리지 않고 실패로 끝낸다.
// (전 종목이 '빈 응답'이면 휴장일이므로 정상 종료다 — 오류 유무로 구분한다.)
if (!collectedSyms.length && erroredSyms.length) {
  console.error('')
  console.error(`⛔ 전량 실패 — ${erroredSyms.length}종목이 오류로 끝났고 받은 봉이 0개다.`)
  console.error(`   예: ${erroredSyms.slice(0, 5).join(', ')}${erroredSyms.length > 5 ? ' …' : ''}`)
  console.error('   원인 후보: 앱키 만료 · EC2 IP 등록 해제 · 키움 서버 점검 · Doppler 시크릿 변경.')
  console.error('   index.json을 갱신하지 않고 종료한다(가짜 최신 표기 방지). 커밋도 일어나지 않는다.')
  process.exit(1)
}

if (!DRY_RUN) writeIndex()

// 크론이 검증 범위를 이번에 건드린 종목으로 좁히는 데 쓴다 — 관련 없는 종목 파일 하나가
// FAIL이라고 80종목 전체의 커밋·푸시가 무기한 막히는 것을 방지한다(파싱용 고정 형식).
console.log(`UPDATED_SYMBOLS=${collectedSyms.join(',')}`)
// 이번에 새로 들어온 구간의 첫 날짜 — 크론이 `verify-intraday --since=` 로 넘긴다.
if (Number.isFinite(updatedFromTs)) console.log(`UPDATED_FROM=${kstDate(updatedFromTs)}`)

// ---- 최종 보고 ---------------------------------------------------------------
console.log('')
console.log(`총 요청 ${requestsTotal}회 · 처리 ${report.length}종목 · 신규 봉 ${addedTotal}개`)
if (DAILY) {
  const perSym = report.filter((r) => r.요청).map((r) => r.요청)
  if (perSym.length) {
    const avg = perSym.reduce((a, b) => a + b, 0) / perSym.length
    console.log(`종목당 요청 평균 ${avg.toFixed(2)}회 · 최대 ${Math.max(...perSym)}회 (증분이면 1~2회가 정상)`)
  }
  const noGain = report.filter((r) => r.추가 === 0).length
  console.log(`봉이 안 늘어난 종목 ${noGain} (휴장일이면 전 종목이 여기에 들어오는 게 정상)`)
  if (gapRisk.length) {
    console.log(
      `⚠️ 저장소가 소급 한도(${MAX_DAYS}일)보다 뒤처진 종목 ${gapRisk.length}종목 — 이번 증분으로는 **중간 구멍이 남는다**: ${gapRisk.slice(0, 5).join(', ')}${gapRisk.length > 5 ? ' …' : ''}`,
    )
    console.log('   처방: --max-days 를 늘려 재실행하거나(요청 수 증가), 해당 종목 파일을 지우고 백필로 전체 재수집한다.')
  }
  const failed = report.filter((r) => r.skipped)
  if (failed.length) console.log(`수집 실패·건너뜀 ${failed.length}종목: ${failed.slice(0, 5).map((r) => `${r.sym}(${r.skipped})`).join(', ')}${failed.length > 5 ? ' …' : ''}`)
} else {
  const withDays = report.filter((r) => r.키움소급일)
  if (withDays.length) {
    const ds = withDays.map((r) => r.키움소급일).sort((a, b) => a - b)
    console.log(`키움 실측 소급: 최소 ${ds[0]}일 · 중앙값 ${ds[Math.floor(ds.length / 2)]}일 · 최대 ${ds[ds.length - 1]}일 (기존 병합분 제외한 순수 키움 깊이)`)
    const limited = withDays.filter((r) => String(r.중단사유).includes('소급 한도')).length
    console.log(`서버 한도로 중단: ${limited}종목 — 이 값이 키움의 실제 5분봉 보관 깊이다`)
  }
}
const cmps = report.filter((r) => r.대조 && !String(r.대조).startsWith('겹침 없음'))
if (cmps.length) console.log(`기존 저장분과 대조 가능 ${cmps.length}종목 — 위 종목별 라인의 불일치율을 확인하세요 (0%대 = 정합)`)
console.log('')
console.log(DRY_RUN ? 'dry-run — 저장 안 함. 결과가 좋으면 --dry-run 없이 재실행하세요.' : '병합 저장 완료 — 커밋 전에 verify-intraday.mjs 로 정확성 검증(구조·키움 일봉·Yahoo 교차)을 돌리세요.')
console.log('이 출력 전체를 총괄 세션에 붙여넣어 주세요 (소급 한도·정확성 실측 기록용).')
