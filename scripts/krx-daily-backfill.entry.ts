// KRX 일별 시세 정본화 — 수집·가공 본체. 실행은 `scripts/krx-daily-backfill.mjs`(런처)로 한다.
// 실행법·재개·한계는 그 런처 상단 주석이 단일 원본이다.
//
// 이 파일이 하는 일 (하루 단위 스트리밍 — 전 기간을 RAM에 들지 않는다):
//   1) 수집: 달력일을 돌며 `stk_bydd_trd`/`ksq_bydd_trd` 하루치 단면을 받아 **원시 응답 그대로**
//      캐시에 저장한다. 캐시에 있으면 건너뛴다(재개 가능).
//   2) 가공 1패스: 캐시를 시간순으로 읽어 **거래일 달력**과 **월별 유니버스**(매월 첫 거래일
//      시총 상위 40+40)를 만든다. 여기서 종목 합집합이 확정된다.
//   3) 가공 2패스: 다시 시간순으로 읽으며 합집합 종목의 일별 행을 **종목별 임시 파일에
//      append**한다. 메모리에 쌓지 않는다(2026-08-02 EC2 OOM 사고 재발 금지).
//   4) 가공 3패스: 종목 하나씩 임시 파일을 읽어 수정 이벤트를 산출하고 `prices/{code}.json`을
//      쓴다. 한 번에 한 종목만 메모리에 있다.
//   5) 자기검증 배터리: 공지된 분할 3건 검출 / 연초 top10 대 `krx-pit/universe.json` 대조 /
//      결측일 통계.
//
// 스키마·수정계수 산출은 `src/features/backtest/krxDailyPrices.ts`가 단일 원본이다 —
// 쓰는 쪽(여기)과 읽는 쪽(로더)이 같은 함수·같은 검증을 통과한다. 여기서 객체를 손으로
// 조립하지 않고, 쓰기 직전에 파서로 자기검증한다(krxPitUniverse.ts와 같은 철학).

import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  KRX_DAILY_BASIS,
  KRX_DAILY_DIR,
  KRX_DAILY_LIMITS,
  KRX_DAILY_SCHEMA_EVENTS,
  KRX_DAILY_SCHEMA_INDEX,
  KRX_DAILY_SCHEMA_MONTHLY,
  KRX_DAILY_SCHEMA_PRICES,
  KRX_DAILY_SOURCE,
  buildKrxAdjEvents,
  isKrxCommonStock,
  krxDailyPriceFile,
  parseKrxByddResponse,
  parseKrxDailyIndex,
  parseKrxDailyStock,
  parseKrxMonthlyUniverse,
} from '../src/features/backtest/krxDailyPrices'
import type {
  KrxAdjEvent,
  KrxByddRow,
  KrxDailyIndex,
  KrxDailyMarket,
  KrxDailyRow,
  KrxDailyStockEntry,
  KrxMonthlyEntry,
  KrxMonthlyMonth,
  KrxSharesPoint,
} from '../src/features/backtest/krxDailyPrices'
import { krxPitMarketCodes, krxPitYears, parseKrxPitUniverse } from '../src/features/backtest/krxPitUniverse'

// ------------------------------------------------------------------ 인자·상수

const args = new Map(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/)
    return m ? [m[1], m[2] ?? 'true'] : [a, 'true']
  }),
)
const flag = (k: string): boolean => args.get(k) === 'true'
const opt = (k: string, dflt: string): string => args.get(k) ?? dflt

const ROOT = process.env.REPO_ROOT ?? process.cwd()
const KST_TODAY = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10)

const FROM = opt('from', '2010-01-01')
const TO = opt('to', KST_TODAY)
const TOP_N = Number(opt('top', '40'))
const WITH_VOLUME = flag('with-volume')
const COLLECT_ONLY = flag('collect-only')
const PROCESS_ONLY = flag('process-only')
/** KRX Open API 한도는 1만건/일. 여유를 두고 멈춰 다음날 캐시부터 이어가게 한다. */
const MAX_CALLS = Number(opt('max-calls', '9500'))
const MIN_INTERVAL_MS = Number(opt('interval-ms', '320'))
const MAX_MB = Number(opt('max-mb', '50'))
/** 용량 초과 시 잘라내는 창 — 유니버스 첫 등장 이전 워밍업 봉 수 / 마지막 등장 이후 봉 수. */
const WARMUP_BARS = Number(opt('warmup-bars', '300'))
const TAIL_BARS = Number(opt('tail-bars', '60'))

const CACHE_DIR = process.env.KRX_CACHE_DIR ?? join(homedir(), '.krx-cache')
const WORK_DIR = join(CACHE_DIR, 'work')
const OUT_DIR = join(ROOT, KRX_DAILY_DIR)
const PRICES_DIR = join(OUT_DIR, 'prices')

const MARKETS: { market: KrxDailyMarket; svc: string; tag: string }[] = [
  { market: 'kospi', svc: 'stk_bydd_trd', tag: 'stk' },
  { market: 'kosdaq', svc: 'ksq_bydd_trd', tag: 'ksq' },
]

const log = (s = ''): void => console.log(s)
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// ------------------------------------------------------------------ 날짜 유틸

const basDd = (date: string): string => date.replace(/-/g, '')
function nextDay(date: string): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}
/** 토·일이면 true — KRX는 주말 휴장이라 콜을 아낀다. */
function isWeekend(date: string): boolean {
  const w = new Date(`${date}T00:00:00Z`).getUTCDay()
  return w === 0 || w === 6
}
function eachWeekday(from: string, to: string): string[] {
  const out: string[] = []
  for (let d = from; d <= to; d = nextDay(d)) if (!isWeekend(d)) out.push(d)
  return out
}

// ------------------------------------------------------------------ 캐시 입출력

const cacheFile = (date: string, tag: string): string => join(CACHE_DIR, `${basDd(date)}-${tag}.json`)

function readCache(date: string, tag: string): unknown | null {
  const p = cacheFile(date, tag)
  if (!existsSync(p)) return null
  try {
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    return null
  }
}

// ------------------------------------------------------------------ 수집(1단계)

class AuthError extends Error {}

let lastCallAt = 0
async function throttled<T>(fn: () => Promise<T>): Promise<T> {
  const wait = MIN_INTERVAL_MS - (Date.now() - lastCallAt)
  if (wait > 0) await sleep(wait)
  lastCallAt = Date.now()
  return fn()
}

async function fetchDay(authKey: string, date: string, svc: string): Promise<string> {
  const url = `https://data-dbg.krx.co.kr/svc/apis/sto/${svc}?basDd=${basDd(date)}`
  const res = await throttled(() => fetch(url, { headers: { AUTH_KEY: authKey, Accept: 'application/json' } }))
  if (res.status === 401 || res.status === 403) {
    const txt = await res.text().catch(() => '')
    throw new AuthError(`HTTP ${res.status} — ${txt.slice(0, 160).replace(/\s+/g, ' ')}`)
  }
  if (!res.ok) {
    const txt = await res.text().catch(() => '')
    throw new Error(`HTTP ${res.status} — ${txt.slice(0, 160).replace(/\s+/g, ' ')}`)
  }
  return res.text()
}

async function fetchDayRetry(authKey: string, date: string, svc: string): Promise<string> {
  let lastErr: unknown = null
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await fetchDay(authKey, date, svc)
    } catch (e) {
      if (e instanceof AuthError) throw e // 인증 문제는 재시도해도 같다 — 즉시 중단
      lastErr = e
      await sleep(1000 * 3 ** attempt)
    }
  }
  throw new Error(`3회 재시도 실패 — ${(lastErr as Error)?.message ?? lastErr}`)
}

interface CollectResult {
  complete: boolean
  calls: number
  failedDays: string[]
}

async function collect(): Promise<CollectResult> {
  const { loadSecret } = (await import('./lib/loadSecret.mjs')) as {
    loadSecret: (n: string) => { value: string | null; source: string; help: string | null }
  }
  const key = loadSecret('KRX_API_KEY')
  if (!key.value) {
    log('')
    log(key.help ?? 'KRX_API_KEY 없음')
    process.exit(1)
  }

  mkdirSync(CACHE_DIR, { recursive: true })
  const days = eachWeekday(FROM, TO)
  const todo: { date: string; tag: string; svc: string }[] = []
  for (const d of days) for (const m of MARKETS) if (!existsSync(cacheFile(d, m.tag))) todo.push({ date: d, tag: m.tag, svc: m.svc })

  log('')
  log(`▶ 1단계 수집 — ${FROM} ~ ${TO} (평일 ${days.length}일 × 2시장)`)
  log(`   캐시: ${CACHE_DIR} · 이미 받은 콜 ${days.length * 2 - todo.length}건은 건너뛴다`)
  log(`   남은 콜 ${todo.length}건 · KRX 한도 1만건/일 · 이번 실행 상한 ${MAX_CALLS}건 (초과분은 다음 실행에서 이어받음)`)
  if (todo.length === 0) {
    log('   → 캐시가 이미 완전하다. 수집 건너뜀.')
    return { complete: true, calls: 0, failedDays: [] }
  }

  let calls = 0
  let empties = 0
  const failedDays: string[] = []
  let printedKeys = false
  const t0 = Date.now()
  for (const job of todo) {
    if (calls >= MAX_CALLS) {
      log('')
      log(`⏸ 이번 실행 콜 상한 ${MAX_CALLS}건 도달 — 남은 ${todo.length - calls}건은 **같은 명령을 다시 실행**하면 캐시 다음부터 이어간다.`)
      return { complete: false, calls, failedDays }
    }
    try {
      const text = await fetchDayRetry(key.value, job.date, job.svc)
      calls++
      writeFileSync(cacheFile(job.date, job.tag), text, 'utf8')
      // 첫 성공 응답에서 **필드명을 확정**한다([미검증] 해소 — 문서와 실제가 다를 수 있다).
      if (!printedKeys) {
        try {
          const p = parseKrxByddResponse(JSON.parse(text))
          if (p.rawKeys.length > 0) {
            printedKeys = true
            log(`   ✔ 응답 필드명 확정: ${p.rawKeys.join(', ')}`)
            log(`     (파싱 결과 ${p.rows.length}줄 · 버린 줄 ${p.dropped} · 원본 ${p.total}줄)`)
          }
        } catch {
          /* 첫 날이 휴장이면 다음 날 확정한다 */
        }
      }
      if (/"OutBlock_1"\s*:\s*\[\s*\]/.test(text)) empties++
    } catch (e) {
      if (e instanceof AuthError) {
        log('')
        log(`⛔ KRX API 미승인/키 만료 — ${(e as Error).message}`)
        log('   Doppler investing-ops/prd 의 KRX_API_KEY 를 확인하라(키 유효기간 1년 · 서비스별 신청 승인 필요).')
        log('   값 입력·재발급은 대표만(T0). 지금까지 받은 캐시는 그대로 남아 있으니 키 교체 후 같은 명령으로 이어가면 된다.')
        process.exit(1)
      }
      failedDays.push(`${job.date}/${job.tag}`)
      log(`   ⚠️ ${job.date} ${job.tag} 실패 — ${(e as Error).message.slice(0, 120)}`)
    }
    if (calls % 200 === 0) {
      const per = (Date.now() - t0) / calls
      const left = Math.min(todo.length, MAX_CALLS) - calls
      log(`   … ${calls}/${Math.min(todo.length, MAX_CALLS)}콜 · 휴장 응답 ${empties} · 남은 콜 ${left} · 예상 ${(left * per / 60000).toFixed(0)}분`)
    }
  }
  log(`   완료: ${calls}콜 · 휴장(빈 응답) ${empties} · 실패 ${failedDays.length}`)
  return { complete: failedDays.length === 0, calls, failedDays }
}

// ------------------------------------------------------------------ 가공 공통

interface DayCross {
  date: string
  rows: { market: KrxDailyMarket; row: KrxByddRow }[]
  /** 두 시장 모두 빈 응답 = 휴장. */
  empty: boolean
  /** 캐시가 없거나 파싱 실패 = 결측(휴장과 구분해서 index.missingDays로 드러낸다). */
  missing: boolean
}

let capMatch = 0
let capMismatch = 0

function readDay(date: string): DayCross {
  const out: DayCross = { date, rows: [], empty: true, missing: false }
  let sawAny = false
  for (const m of MARKETS) {
    const raw = readCache(date, m.tag)
    if (raw == null) {
      out.missing = true
      continue
    }
    sawAny = true
    let parsed
    try {
      parsed = parseKrxByddResponse(raw)
    } catch {
      out.missing = true
      continue
    }
    for (const row of parsed.rows) {
      out.rows.push({ market: m.market, row })
      // MKTCAP은 파일에 저장하지 않고 종가×주식수로 유도한다 — 그 유도가 맞는지 실측 대조.
      if (row.mktcap > 0) {
        const derived = row.close * row.shares
        if (Math.abs(derived / row.mktcap - 1) <= 0.005) capMatch++
        else capMismatch++
      }
    }
  }
  out.empty = sawAny && out.rows.length === 0
  return out
}

// ------------------------------------------------------------ 가공 1패스(달력·유니버스)

interface PassA {
  calendar: string[]
  missingDays: string[]
  months: Record<string, KrxMonthlyMonth>
  missingMonths: string[]
  union: Set<string>
  /** 코드 → 유니버스에 처음/마지막 등장한 달력 인덱스(용량 초과 시 잘라내기용). */
  firstSeen: Map<string, number>
  lastSeen: Map<string, number>
  names: Map<string, string>
  markets: Map<string, Set<KrxDailyMarket>>
}

function topOf(day: DayCross, market: KrxDailyMarket, topN: number): KrxMonthlyEntry[] {
  return day.rows
    .filter((r) => r.market === market && isKrxCommonStock(r.row.code, r.row.name) && r.row.close * r.row.shares > 0)
    .map((r) => ({ code: r.row.code, name: r.row.name, cap: r.row.close * r.row.shares }))
    .sort((a, b) => b.cap - a.cap || a.code.localeCompare(b.code))
    .slice(0, topN)
    .map((e, i) => ({ code: e.code, name: e.name, rank: i + 1, capEok: Math.round(e.cap / 1e8) }))
}

function passA(days: string[]): PassA {
  const st: PassA = {
    calendar: [],
    missingDays: [],
    months: {},
    missingMonths: [],
    union: new Set(),
    firstSeen: new Map(),
    lastSeen: new Map(),
    names: new Map(),
    markets: new Map(),
  }
  const monthSeen = new Set<string>()
  const monthsAttempted = new Set<string>()
  for (const date of days) {
    monthsAttempted.add(date.slice(0, 7))
    const day = readDay(date)
    if (day.missing && day.rows.length === 0) {
      st.missingDays.push(date)
      continue
    }
    if (day.rows.length === 0) continue // 휴장 — 달력에 넣지 않는다
    const idx = st.calendar.length
    st.calendar.push(date)
    for (const { market, row } of day.rows) {
      st.names.set(row.code, row.name)
      let ms = st.markets.get(row.code)
      if (!ms) {
        ms = new Set()
        st.markets.set(row.code, ms)
      }
      ms.add(market)
    }
    const mkey = date.slice(0, 7)
    if (monthSeen.has(mkey)) continue
    monthSeen.add(mkey)
    const kospi = topOf(day, 'kospi', TOP_N)
    const kosdaq = topOf(day, 'kosdaq', TOP_N)
    if (kospi.length === 0 || kosdaq.length === 0) {
      // 한쪽 시장 데이터가 통째로 없는 날은 그 달을 결측으로 남긴다(반쪽 유니버스 금지).
      monthSeen.delete(mkey)
      st.missingMonths.push(mkey)
      continue
    }
    st.months[mkey] = { date, kospi, kosdaq }
    for (const e of [...kospi, ...kosdaq]) {
      st.union.add(e.code)
      if (!st.firstSeen.has(e.code)) st.firstSeen.set(e.code, idx)
      st.lastSeen.set(e.code, idx)
    }
  }
  for (const m of monthsAttempted) if (!st.months[m] && !st.missingMonths.includes(m)) st.missingMonths.push(m)
  st.missingMonths = [...new Set(st.missingMonths)].sort()
  return st
}

// ------------------------------------------------------- 가공 2패스(종목별 append)

const workFile = (code: string): string => join(WORK_DIR, `${code}.tsv`)

function passB(days: string[], a: PassA): void {
  rmSync(WORK_DIR, { recursive: true, force: true })
  mkdirSync(WORK_DIR, { recursive: true })
  const buf = new Map<string, string[]>()
  let pending = 0
  const flush = (): void => {
    for (const [code, lines] of buf) appendFileSync(workFile(code), lines.join('\n') + '\n', 'utf8')
    buf.clear()
    pending = 0
  }
  let idx = -1
  for (const date of days) {
    const day = readDay(date)
    if (day.rows.length === 0) continue
    idx++
    if (a.calendar[idx] !== date) throw new Error(`2패스 달력 어긋남 — idx ${idx}에 ${a.calendar[idx]} 기대, ${date} 관측`)
    for (const { row } of day.rows) {
      if (!a.union.has(row.code)) continue
      const line = `${idx}\t${row.open}\t${row.high}\t${row.low}\t${row.close}\t${row.volume}\t${row.shares}`
      const arr = buf.get(row.code)
      if (arr) arr.push(line)
      else buf.set(row.code, [line])
      pending++
    }
    if (pending >= 200_000) flush()
  }
  flush()
}

// -------------------------------------------------------- 가공 3패스(종목 파일)

interface StockBuild {
  entry: KrxDailyStockEntry
  events: KrxAdjEvent[]
  bytes: number
}

function writeStock(
  code: string,
  a: PassA,
  window: { from: number; to: number } | null,
): StockBuild | null {
  const p = workFile(code)
  if (!existsSync(p)) return null
  const lines = readFileSync(p, 'utf8').split('\n').filter(Boolean)
  if (lines.length === 0) return null
  const rowsAll: KrxDailyRow[] = []
  const sharesAll: number[] = []
  let prevIdx = -1
  for (const ln of lines) {
    const [i, o, h, l, c, v, s] = ln.split('\t').map(Number)
    if (i <= prevIdx) continue // 같은 날 중복 줄(우선주 코드 충돌 등) — 첫 줄만 쓴다
    prevIdx = i
    if (window && (i < window.from || i > window.to)) continue
    rowsAll.push(WITH_VOLUME ? [i, o, h, l, c, v] : [i, o, h, l, c])
    sharesAll.push(s)
  }
  if (rowsAll.length < 2) return null

  const events = buildKrxAdjEvents(rowsAll, sharesAll, a.calendar)
  const sharePts: KrxSharesPoint[] = [[rowsAll[0][0], sharesAll[0]]]
  for (let i = 1; i < rowsAll.length; i++) if (sharesAll[i] !== sharesAll[i - 1]) sharePts.push([rowsAll[i][0], sharesAll[i]])

  const marketSet = [...(a.markets.get(code) ?? new Set<KrxDailyMarket>(['kospi']))]
  const stock = {
    schema: KRX_DAILY_SCHEMA_PRICES,
    code,
    name: a.names.get(code) ?? code,
    adjustment: 'raw' as const,
    dividendAdjusted: false as const,
    market: marketSet[marketSet.length - 1],
    markets: marketSet,
    rows: rowsAll,
    shares: sharePts,
    events,
  }
  // 쓰기 전에 파서로 자기검증 — 스키마 위반은 파일이 되기 전에 던진다.
  parseKrxDailyStock(stock, a.calendar.length)

  const body = `${JSON.stringify(stock)}\n`
  const outPath = join(PRICES_DIR, `${code}.json`)
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, body, 'utf8')

  const from = a.calendar[rowsAll[0][0]]
  const to = a.calendar[rowsAll[rowsAll.length - 1][0]]
  const span = rowsAll[rowsAll.length - 1][0] - rowsAll[0][0] + 1
  return {
    entry: {
      code,
      name: stock.name,
      market: stock.market,
      from,
      to,
      bars: rowsAll.length,
      gaps: span - rowsAll.length,
      trimmed: window != null,
      adjEvents: events.length,
      file: krxDailyPriceFile(code),
    },
    events,
    bytes: Buffer.byteLength(body),
  }
}

// ------------------------------------------------------------------ 자기검증

interface ExpectedSplit {
  code: string
  name: string
  month: string
  factor: number
}
/** 공지된 분할 — 야후를 쓰지 않으므로 이 하드코딩 목록이 검증 기준이다. */
const EXPECTED_SPLITS: ExpectedSplit[] = [
  { code: '005930', name: '삼성전자', month: '2018-05', factor: 50 },
  { code: '035420', name: 'NAVER', month: '2018-10', factor: 5 },
  { code: '035720', name: '카카오', month: '2021-04', factor: 5 },
]

function verify(a: PassA, allEvents: (KrxAdjEvent & { code: string; name: string })[], entries: KrxDailyStockEntry[]): boolean {
  let ok = true
  log('')
  log('════════ 자기검증 배터리 ════════')

  log('')
  log('① 공지된 액면분할 검출')
  for (const exp of EXPECTED_SPLITS) {
    const hits = allEvents.filter((e) => e.code === exp.code && e.date.slice(0, 7) === exp.month)
    const split = hits.find((e) => e.kind === 'split' && Math.abs(e.ratio / exp.factor - 1) <= 0.05)
    if (split) {
      log(`   ✅ ${exp.code} ${exp.name} ${exp.month} ${exp.factor}:1 — 검출 (ratio ×${split.ratio.toFixed(3)} · 가격비 ×${split.impliedRatio.toFixed(3)} · ${split.confidence})`)
    } else if (hits.length > 0) {
      ok = false
      log(`   ❌ ${exp.code} ${exp.name} ${exp.month} ${exp.factor}:1 — 이벤트는 있으나 분할로 분류 못 함: ${hits.map((h) => `${h.date} ${h.kind} ×${h.ratio.toFixed(3)}`).join(' / ')}`)
    } else {
      ok = false
      const has = entries.some((e) => e.code === exp.code)
      log(`   ❌ ${exp.code} ${exp.name} ${exp.month} — 이벤트 없음 (그 종목 파일 ${has ? '있음' : '없음'})`)
    }
  }

  log('')
  log('② 연초 첫 거래일 top10 대 krx-pit/universe.json (연 단위 정본) 대조')
  try {
    const pit = parseKrxPitUniverse(JSON.parse(readFileSync(join(ROOT, 'public/data/krx-pit/universe.json'), 'utf8')))
    let cmp = 0
    let same = 0
    for (const y of krxPitYears(pit)) {
      const mkey = `${y}-01`
      const m = a.months[mkey]
      if (!m) continue
      for (const market of ['kospi', 'kosdaq'] as const) {
        const mine = m[market].slice(0, 10).map((e) => e.code)
        const theirs = krxPitMarketCodes(pit, y, market, 10)
        if (theirs.length === 0) continue
        cmp++
        const eq = mine.length === theirs.length && mine.every((c, i) => c === theirs[i])
        if (eq) same++
        else {
          const onlyMine = mine.filter((c) => !theirs.includes(c))
          const onlyTheirs = theirs.filter((c) => !mine.includes(c))
          log(
            `   ⚠️ ${y} ${market}: 순서·구성 불일치 (내쪽만 ${onlyMine.join(',') || '없음'} / 정본만 ${onlyTheirs.join(',') || '없음'})`,
          )
        }
      }
    }
    log(`   대조 ${cmp}건 중 완전일치 ${same}건 (${cmp ? ((same / cmp) * 100).toFixed(0) : '0'}%)`)
    log('   * 불일치는 기준일 차이(정본은 1/4~1/10 중 첫 성공일, 이쪽은 그 달 첫 거래일)로도 난다 — 구성 차이만 보라.')
    if (cmp === 0) {
      ok = false
      log('   ❌ 대조 가능한 연도가 하나도 없다 — 월별 유니버스가 비었거나 연도가 어긋났다.')
    }
  } catch (e) {
    ok = false
    log(`   ❌ 정본 대조 실패 — ${(e as Error).message.slice(0, 200)}`)
  }

  log('')
  log('③ 시계열 결측일 통계 (상장 기간 중 빠진 거래일)')
  const gapped = entries.filter((e) => e.gaps > 0).sort((x, y) => y.gaps - x.gaps)
  const totalGaps = entries.reduce((s, e) => s + e.gaps, 0)
  const totalBars = entries.reduce((s, e) => s + e.bars, 0)
  log(`   종목 ${entries.length} · 총 봉 ${totalBars.toLocaleString()} · 총 결측 ${totalGaps.toLocaleString()} (${totalBars ? ((totalGaps / (totalBars + totalGaps)) * 100).toFixed(2) : '0'}%)`)
  log(`   결측 보유 종목 ${gapped.length} · 상위: ${gapped.slice(0, 10).map((e) => `${e.code}(${e.gaps})`).join(', ') || '없음'}`)
  log(`   달력에 없는 평일(응답 결측) ${a.missingDays.length}일: ${a.missingDays.slice(0, 10).join(', ')}${a.missingDays.length > 10 ? ' …' : ''}`)

  log('')
  log('④ MKTCAP 유도 검증 (종가 × 상장주식수 = 응답 MKTCAP?)')
  const capTotal = capMatch + capMismatch
  log(`   일치 ${capMatch.toLocaleString()} / 불일치 ${capMismatch.toLocaleString()} (${capTotal ? ((capMatch / capTotal) * 100).toFixed(2) : '0'}%)`)
  if (capTotal > 0 && capMatch / capTotal < 0.98) {
    ok = false
    log('   ❌ 유도 실패율이 높다 — MKTCAP을 파일에서 뺀 결정을 재검토해야 한다(용량 대신 저장 필요).')
  }

  log('')
  log('⑤ 수정 이벤트 분포')
  const by = (k: string, c: string): number => allEvents.filter((e) => e.kind === k && e.confidence === c).length
  log(`   split : high ${by('split', 'high')} · medium ${by('split', 'medium')} · low ${by('split', 'low')} ([미검증] — 기본 미보정)`)
  log(`   share : high ${by('shareChange', 'high')} · medium ${by('shareChange', 'medium')} · low ${by('shareChange', 'low')}`)
  return ok
}

// ------------------------------------------------------------------ 가공 본체

function writeJson(path: string, obj: unknown, pretty: boolean): number {
  mkdirSync(dirname(path), { recursive: true })
  const body = `${pretty ? JSON.stringify(obj, null, 2) : JSON.stringify(obj)}\n`
  writeFileSync(path, body, 'utf8')
  return Buffer.byteLength(body)
}

function process_(): boolean {
  const days = eachWeekday(FROM, TO)
  log('')
  log(`▶ 2단계 가공 — 캐시 ${CACHE_DIR} → ${KRX_DAILY_DIR}`)

  log('   1패스: 거래일 달력 · 월별 유니버스 …')
  const a = passA(days)
  if (a.calendar.length === 0) {
    log('   ⛔ 거래일이 하나도 없다 — 캐시가 비었거나 응답이 전부 결측이다. 1단계 수집을 먼저 하라.')
    return false
  }
  log(
    `      거래일 ${a.calendar.length} (${a.calendar[0]} ~ ${a.calendar[a.calendar.length - 1]}) · ` +
      `월 ${Object.keys(a.months).length} · 결측 월 ${a.missingMonths.length} · 결측 평일 ${a.missingDays.length}`,
  )
  log(`      유니버스 합집합 ${a.union.size}종목 (매월 첫 거래일 시총 상위 ${TOP_N}+${TOP_N})`)

  const monthly = {
    schema: KRX_DAILY_SCHEMA_MONTHLY,
    version: 1,
    source: KRX_DAILY_SOURCE,
    basis: `매월 첫 거래일 시가총액 상위 ${TOP_N}(코스피)+${TOP_N}(코스닥) · 보통주만(6자리·끝 0)·스팩 제외·시총>0`,
    asOf: KST_TODAY,
    topN: TOP_N,
    missingMonths: a.missingMonths,
    months: a.months,
  }
  parseKrxMonthlyUniverse(monthly) // 쓰기 전 자기검증
  const monthlyBytes = writeJson(join(OUT_DIR, 'monthly-universe.json'), monthly, false)
  log(`      💾 monthly-universe.json (${(monthlyBytes / 1024).toFixed(0)} KB)`)

  log('   2패스: 종목별 일별 행 append …')
  passB(days, a)

  log('   3패스: 종목 파일 쓰기 …')
  rmSync(PRICES_DIR, { recursive: true, force: true })
  const codes = [...a.union].sort()
  let builds = writeAll(codes, a, null)
  let bytes = builds.reduce((s, b) => s + b.bytes, 0)
  log(`      ${builds.length}종목 · ${(bytes / 1048576).toFixed(1)} MB (예산 ${MAX_MB} MB)`)

  if (bytes / 1048576 > MAX_MB) {
    log(`   ⚠️ 용량 예산 초과 — 종목별로 [유니버스 첫 등장 −${WARMUP_BARS}봉, 마지막 등장 +${TAIL_BARS}봉] 창으로 잘라 다시 쓴다.`)
    log('      (잘린 종목은 index의 trimmed=true로 드러난다 — 숨기지 않는다)')
    rmSync(PRICES_DIR, { recursive: true, force: true })
    builds = codes
      .map((c) => {
        const f = a.firstSeen.get(c) ?? 0
        const l = a.lastSeen.get(c) ?? a.calendar.length - 1
        return writeStock(c, a, { from: Math.max(0, f - WARMUP_BARS), to: Math.min(a.calendar.length - 1, l + TAIL_BARS) })
      })
      .filter((b): b is StockBuild => b != null)
    bytes = builds.reduce((s, b) => s + b.bytes, 0)
    log(`      재작성 후 ${builds.length}종목 · ${(bytes / 1048576).toFixed(1)} MB`)
  }

  const index: KrxDailyIndex = {
    schema: KRX_DAILY_SCHEMA_INDEX,
    version: 1,
    source: KRX_DAILY_SOURCE,
    basis: KRX_DAILY_BASIS,
    asOf: KST_TODAY,
    from: a.calendar[0],
    to: a.calendar[a.calendar.length - 1],
    calendar: a.calendar,
    missingDays: a.missingDays,
    volume: WITH_VOLUME,
    limits: [...KRX_DAILY_LIMITS],
    stocks: builds.map((b) => b.entry),
  }
  parseKrxDailyIndex(index) // 쓰기 전 자기검증
  const indexBytes = writeJson(join(OUT_DIR, 'index.json'), index, false)
  log(`      💾 index.json (${(indexBytes / 1024).toFixed(0)} KB)`)

  const allEvents = builds.flatMap((b) => b.events.map((e) => ({ ...e, code: b.entry.code, name: b.entry.name })))
  const eventsFile = {
    schema: KRX_DAILY_SCHEMA_EVENTS,
    version: 1,
    asOf: KST_TODAY,
    rule:
      '상장주식수 전일 대비 1% 이상 변화를 후보로 본다. ratio=주식수비, impliedRatio=직전종가/당일종가, ' +
      'dev=|implied/ratio−1|, realized=(implied−1)/(ratio−1). dev≤15% **그리고** |realized−1|≤25%면 ' +
      '분할/병합/무상증자형(보정 대상, factor=ratio) — dev≤5%·|realized−1|≤10%면 high, 아니면 medium. ' +
      '그 외는 유상증자·CB전환·감자형(보정 없음, factor=1). 주식수 변화가 5% 미만이면 두 조건을 만족해도 ' +
      'confidence:low로 낮추고 기본 미보정([미검증] — 우연 일치일 수 있다).',
    events: allEvents,
  }
  const evBytes = writeJson(join(OUT_DIR, 'adj-events.json'), eventsFile, true)
  log(`      💾 adj-events.json (${(evBytes / 1024).toFixed(0)} KB · ${allEvents.length}건)`)

  const total = monthlyBytes + indexBytes + evBytes + bytes
  log('')
  log(`   총 커밋 크기 ${(total / 1048576).toFixed(1)} MB (목표 <${MAX_MB} MB)`)

  return verify(a, allEvents, index.stocks)
}

function writeAll(codes: string[], a: PassA, window: { from: number; to: number } | null): StockBuild[] {
  const out: StockBuild[] = []
  let done = 0
  for (const c of codes) {
    const b = writeStock(c, a, window)
    if (b) out.push(b)
    if (++done % 100 === 0) log(`      … ${done}/${codes.length}종목`)
  }
  return out
}

// ------------------------------------------------------------------ main

async function main(): Promise<void> {
  log('KRX 일별 시세 정본화 파이프라인 (조회 전용 · 규칙 2 1단계)')
  log(`실행일(KST) ${KST_TODAY} · 범위 ${FROM} ~ ${TO} · top${TOP_N}${WITH_VOLUME ? ' · 거래량 포함' : ' · 거래량 미수집'}`)
  log(`캐시 ${CACHE_DIR} (KRX_CACHE_DIR 로 변경 가능)`)

  if (!PROCESS_ONLY) {
    const r = await collect()
    if (!r.complete) {
      log('')
      log('⏸ 수집이 완결되지 않아 **가공은 건너뛴다** — 반쪽 데이터셋을 리포에 쓰지 않기 위함이다.')
      log('   같은 명령을 다시 실행하면 캐시 다음부터 이어간다. 캐시만으로 강제 가공하려면 --process-only.')
      if (r.failedDays.length > 0) log(`   실패 목록(앞 20): ${r.failedDays.slice(0, 20).join(', ')}`)
      process.exit(2)
    }
  }
  if (COLLECT_ONLY) {
    log('')
    log('--collect-only — 가공은 하지 않는다.')
    return
  }
  const ok = process_()
  log('')
  if (ok) {
    log('✅ 자기검증 배터리 전부 통과 — 산출물을 커밋해도 된다.')
    log(`   git add ${KRX_DAILY_DIR} && git commit`)
  } else {
    log('❌ 자기검증 실패 항목이 있다 — **커밋하지 마라.** 위 ❌ 줄을 먼저 해소하라.')
    process.exit(3)
  }
}

main().catch((e) => {
  console.error(`\n⛔ 중단 — ${(e as Error).stack ?? e}`)
  process.exit(1)
})
