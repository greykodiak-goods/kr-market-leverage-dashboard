// DART 재무 정본화 — 수집·가공 본체. 실행은 `scripts/dart-fundamental-backfill.mjs`(런처)로 한다.
// 실행법·재개·한계·예상 호출량은 그 런처 상단 주석이 단일 원본이다.
//
// 이 파일이 하는 일:
//   1) 유니버스 확정: `public/data/krx-pit/universe.json`의 40+40 합집합(실측 275종목).
//   2) corp_code 매핑: `corpCode.xml`(zip) 1콜 → 6자리 종목코드 → 8자리 DART 고유번호.
//   3) 수집: (종목 × 연도 × 보고서 × fs_div) 로 `fnlttSinglAcntAll.json`을 받아 **원시 응답
//      그대로** 캐시에 저장한다. 캐시가 있으면 건너뛴다(재개 가능 · 한도 20,000건/일).
//   4) 가공: 캐시를 종목 하나씩 읽어 계정 6종을 추출하고 `stocks/{code}.json` + `index.json`을
//      쓴다. 한 번에 한 종목만 메모리에 있다(2026-08-02 EC2 OOM 사고 재발 금지).
//   5) 자기검증 배터리: 회계 항등식 / 접수일 > 사업연도 종료 / 연결·별도 혼합 / 계정 결측률.
//
// 스키마·계정 매칭·PIT 필터는 `src/features/backtest/fundamentals.ts`가 단일 원본이다 —
// 쓰는 쪽(여기)과 읽는 쪽(백테스트)이 같은 함수·같은 검증을 통과한다. 여기서 객체를 손으로
// 조립하지 않고, 쓰기 직전에 파서로 자기검증한다(krx-daily-backfill.entry.ts와 같은 철학).
//
// 규칙 4 게이트(외부 API는 그럴듯한 값으로 틀린다 — 조용히 썩게 두지 않는다):
//   ① `status === '000'`이 아니면 성공으로 치지 않는다(HTTP는 항상 200이다)
//   ② `reprt_code`·`fs_div`는 **우리가** 화이트리스트로 막는다 — DART는 reprt_code=99999도
//      status=000으로 통과시킨다(2026-08-03 실측)
//   ③ 성공 카운터 — 받은 게 0인데 오류가 있으면 **exit 1**(정상 0건 013과 구분)
//   ④ 조용한 폴백·직전값 승계 금지 — 계정을 하나도 못 찾으면 던진다
//   ⑤ 스로틀 ≥200ms  ⑥ 최신 수집 데이터 날짜(최신 접수일)를 출력

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import {
  DART_FUNDAMENTALS_BASIS,
  DART_FUNDAMENTALS_DIR,
  DART_FUNDAMENTALS_LIMITS,
  DART_FUNDAMENTALS_SCHEMA_INDEX,
  DART_FUNDAMENTALS_SCHEMA_STOCK,
  DART_FUNDAMENTALS_SOURCE,
  DART_FS_DIVS,
  DART_REPRT_CODES,
  DART_STATUS_EMPTY,
  DART_STATUS_OK,
  DART_STORED_ACCOUNTS,
  assertDartFsDiv,
  assertDartReprtCode,
  checkAccountingIdentity,
  dartFundamentalFile,
  dartReprtLabel,
  dartStatusKind,
  dartStatusMeaning,
  extractFundamentalRecord,
  parseFundamentalIndex,
  parseFundamentalStock,
  readDartEnvelope,
} from '../src/features/backtest/fundamentals'
import type {
  DartFsDiv,
  DartReprtCode,
  FundamentalIndexEntry,
  FundamentalRecord,
} from '../src/features/backtest/fundamentals'
import { krxPitNames, krxPitUnion, parseKrxPitUniverse } from '../src/features/backtest/krxPitUniverse'

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
const KST_YEAR = Number(KST_TODAY.slice(0, 4))

/** 재무데이터 시작 = 2015년(실측 확정). 그 이전은 status 013이라 콜만 버린다. */
const DART_FIRST_YEAR = 2015
const FROM_YEAR = Math.max(DART_FIRST_YEAR, Number(opt('from-year', String(DART_FIRST_YEAR))))
const TO_YEAR = Number(opt('to-year', String(KST_YEAR)))
const TOP_N = Number(opt('top', '40'))

/** 보고서 순서 — 사업보고서를 먼저 받아 fs_div 선호를 확정하고 분기로 넘어간다. */
const REPRT_ORDER: DartReprtCode[] = ['11011', '11013', '11012', '11014']
const REPRT_SET: DartReprtCode[] = (() => {
  const v = opt('reprt', 'all')
  if (v === 'annual') return ['11011']
  if (v === 'all') return REPRT_ORDER
  return v.split(',').map((s) => assertDartReprtCode(s.trim()))
})()

/** DART 한도는 일 20,000건. 여유를 두고 멈춰 다음날 캐시부터 이어간다. */
const DART_DAILY_QUOTA = 20000
const MAX_CALLS = Number(opt('max-calls', '19000'))
const MIN_INTERVAL_MS = Math.max(200, Number(opt('interval-ms', '220')))
const MAX_MB = Number(opt('max-mb', '50'))
const COLLECT_ONLY = flag('collect-only')
const PROCESS_ONLY = flag('process-only')
const ONLY_CODES = opt('codes', '')
  .split(',')
  .map((s) => s.trim())
  .filter((s) => /^\d{6}$/.test(s))

const CACHE_DIR = process.env.DART_CACHE_DIR ?? join(homedir(), '.dart-cache')
const FS_CACHE_DIR = join(CACHE_DIR, 'fs')
const OUT_DIR = join(ROOT, DART_FUNDAMENTALS_DIR)
const STOCKS_DIR = join(OUT_DIR, 'stocks')
const DART_BASE = 'https://opendart.fss.or.kr/api'

const log = (s = ''): void => console.log(s)
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// ------------------------------------------------------------------ 카운터

const stat = {
  calls: 0,
  ok: 0,
  /** status 013 — **정상 0건**. 실패와 절대 합치지 않는다. */
  empty: 0,
  fail: 0,
  parsed: 0,
  parseFail: 0,
}

/** 한도·인증처럼 "더 해봐야 소용없는" 상황 — 즉시 멈추고 재개를 안내한다. */
class HaltError extends Error {}

// ------------------------------------------------------------------ 캐시

const fsCacheFile = (corp: string, year: number, reprt: DartReprtCode, div: DartFsDiv): string =>
  join(FS_CACHE_DIR, `${corp}-${year}-${reprt}-${div}.json`)

function readJsonFile(p: string): unknown | null {
  if (!existsSync(p)) return null
  try {
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    return null
  }
}

// ------------------------------------------------------------------ 호출부

let lastCallAt = 0
async function throttled<T>(fn: () => Promise<T>): Promise<T> {
  const wait = MIN_INTERVAL_MS - (Date.now() - lastCallAt)
  if (wait > 0) await sleep(wait)
  lastCallAt = Date.now()
  return fn()
}

function maskUrl(u: string): string {
  return u.replace(/crtfc_key=[^&]*/i, 'crtfc_key=****')
}

async function dartGet(path: string, params: Record<string, string>, key: string) {
  const qs = new URLSearchParams({ crtfc_key: key, ...params })
  const url = `${DART_BASE}/${path}?${qs}`
  stat.calls++
  const res = await throttled(() => fetch(url))
  if (!res.ok) throw new Error(`${path} HTTP ${res.status} — ${maskUrl(url).slice(0, 200)}`)
  return res
}

/** 재시도는 네트워크 오류에만. status 코드는 의미가 있으므로 재시도하지 않는다. */
async function dartJson(path: string, params: Record<string, string>, key: string): Promise<unknown> {
  let lastErr: unknown = null
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await dartGet(path, params, key)
      const text = await res.text()
      try {
        return JSON.parse(text)
      } catch {
        throw new Error(`${path} JSON 파싱 실패 — 앞부분: ${text.slice(0, 160)}`)
      }
    } catch (e) {
      lastErr = e
      await sleep(1000 * 3 ** attempt)
    }
  }
  throw new Error(`${path} 3회 재시도 실패 — ${(lastErr as Error)?.message ?? String(lastErr)}`)
}

// ------------------------------------------------------- corp_code 매핑(zip)

/** ZIP 최소 파서 — 중앙 디렉터리를 읽고 첫 항목을 푼다(외부 의존 없음). */
function unzipFirstEntry(buf: Buffer): { names: string[]; xml: string } {
  const EOCD_SIG = 0x06054b50
  let eocd = -1
  const floor = Math.max(0, buf.length - 22 - 65536)
  for (let i = buf.length - 22; i >= floor; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('ZIP 아님 — EOCD 서명을 찾지 못했다(키 오류 응답일 수 있다)')
  const count = buf.readUInt16LE(eocd + 10)
  let p = buf.readUInt32LE(eocd + 16)
  const entries: { name: string; method: number; compSize: number; localOff: number }[] = []
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error(`중앙 디렉터리 서명 불일치 @${p}`)
    const method = buf.readUInt16LE(p + 10)
    const compSize = buf.readUInt32LE(p + 20)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const localOff = buf.readUInt32LE(p + 42)
    entries.push({ name: buf.toString('utf8', p + 46, p + 46 + nameLen), method, compSize, localOff })
    p += 46 + nameLen + extraLen + commentLen
  }
  if (entries.length === 0) throw new Error('ZIP 안에 항목이 없다')
  const e = entries[0]
  if (buf.readUInt32LE(e.localOff) !== 0x04034b50) throw new Error('로컬 헤더 서명 불일치')
  const nLen = buf.readUInt16LE(e.localOff + 26)
  const xLen = buf.readUInt16LE(e.localOff + 28)
  const start = e.localOff + 30 + nLen + xLen
  const data = buf.subarray(start, start + e.compSize)
  const plain = e.method === 0 ? data : inflateRawSync(data)
  return { names: entries.map((x) => x.name), xml: plain.toString('utf8') }
}

const CORP_MAP_CACHE = join(CACHE_DIR, 'corp-map.json')

async function loadCorpMap(key: string): Promise<Map<string, { corp: string; name: string }>> {
  const cached = readJsonFile(CORP_MAP_CACHE) as Record<string, { corp: string; name: string }> | null
  if (cached && Object.keys(cached).length > 0) {
    log(`   corp_code 매핑: 캐시 사용 (${Object.keys(cached).length.toLocaleString()}종목) — ${CORP_MAP_CACHE}`)
    return new Map(Object.entries(cached))
  }
  const res = await dartGet('corpCode.xml', {}, key)
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.toString('latin1', 0, 2) !== 'PK') {
    // 키 오류면 zip 이 아니라 JSON 이 온다 — 조용히 빈 맵으로 넘어가지 않는다.
    throw new HaltError(`corpCode.xml이 zip이 아니다 — 본문 앞부분: ${buf.toString('utf8', 0, 200)}`)
  }
  const { xml } = unzipFirstEntry(buf)
  const map = new Map<string, { corp: string; name: string }>()
  const re = /<list>([\s\S]*?)<\/list>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(xml))) {
    const body = m[1]
    const corp = /<corp_code>([^<]*)<\/corp_code>/.exec(body)?.[1]?.trim()
    const stock = /<stock_code>([^<]*)<\/stock_code>/.exec(body)?.[1]?.trim()
    const nm = /<corp_name>([^<]*)<\/corp_name>/.exec(body)?.[1]?.trim()
    if (corp && stock && /^\d{6}$/.test(stock) && /^\d{8}$/.test(corp)) map.set(stock, { corp, name: nm ?? '' })
  }
  // 관용 파싱하되 **하나도 못 찾으면 던진다**(규칙 4).
  if (map.size === 0) throw new Error('corpCode XML 파싱 결과 0건 — 스키마가 바뀌었다')
  mkdirSync(CACHE_DIR, { recursive: true })
  writeFileSync(CORP_MAP_CACHE, JSON.stringify(Object.fromEntries(map)), 'utf8')
  log(`   corp_code 매핑: 신규 수집 ${map.size.toLocaleString()}종목 → 캐시 ${CORP_MAP_CACHE}`)
  return map
}

// ------------------------------------------------------------------ 유니버스

interface Target {
  code: string
  name: string
  corp: string
}

function loadUniverse(): { targets: Target[]; unmapped: string[]; total: number } {
  const raw = readJsonFile(join(ROOT, 'public/data/krx-pit/universe.json'))
  if (raw == null) throw new Error('public/data/krx-pit/universe.json 이 없다 — 유니버스 없이 수집하지 않는다')
  const u = parseKrxPitUniverse(raw)
  const names = krxPitNames(u)
  let codes = krxPitUnion(u, TOP_N)
  if (ONLY_CODES.length > 0) codes = codes.filter((c) => ONLY_CODES.includes(c))
  return {
    targets: codes.map((c) => ({ code: c, name: names[c] ?? c, corp: '' })),
    unmapped: [],
    total: codes.length,
  }
}

// ------------------------------------------------------------------ 수집

interface CollectResult {
  complete: boolean
  halted: string | null
}

async function collect(targets: Target[]): Promise<CollectResult> {
  const { loadSecret } = (await import('./lib/loadSecret.mjs')) as {
    loadSecret: (n: string, o?: { project?: string }) => { value: string | null; source: string; help: string | null }
  }
  const secret = loadSecret('DART_API_KEY', { project: 'investing-ops' })
  if (!secret.value) {
    log('')
    log(secret.help ?? 'DART_API_KEY 없음')
    process.exit(1)
  }
  const key = secret.value

  mkdirSync(FS_CACHE_DIR, { recursive: true })
  const corpMap = await loadCorpMap(key)

  const unmapped: string[] = []
  for (const t of targets) {
    const hit = corpMap.get(t.code)
    if (hit) t.corp = hit.corp
    else unmapped.push(t.code)
  }
  const mapped = targets.filter((t) => t.corp)
  log('')
  log(`▶ corp_code 매핑: ${mapped.length}/${targets.length}종목 성공 · 실패 ${unmapped.length}종목`)
  if (unmapped.length > 0) log(`   매핑 실패(재무 없음으로 남긴다): ${unmapped.join(', ')}`)
  if (mapped.length === 0) throw new Error('매핑된 종목이 0개 — 수집할 대상이 없다')

  const years: number[] = []
  for (let y = FROM_YEAR; y <= TO_YEAR; y++) years.push(y)

  // ---- 호출량 추정 (실행 초반에 반드시 출력)
  const base = mapped.length * years.length * REPRT_SET.length
  const todo: { t: Target; year: number; reprt: DartReprtCode }[] = []
  for (const t of mapped) for (const y of years) for (const r of REPRT_SET) todo.push({ t, year: y, reprt: r })
  const cachedCount = todo.filter(({ t, year, reprt }) =>
    DART_FS_DIVS.some((d) => existsSync(fsCacheFile(t.corp, year, reprt, d))),
  ).length
  log('')
  log(`▶ 수집 계획 — FY${FROM_YEAR}~${TO_YEAR} · 보고서 ${REPRT_SET.map(dartReprtLabel).join('/')}`)
  log(`   대상 ${mapped.length}종목 × ${years.length}연도 × ${REPRT_SET.length}보고서 = **최소 ${base.toLocaleString()}콜**`)
  log(`   연결(CFS)이 없으면 별도(OFS)로 한 번 더 부르므로 상한은 ${(base * 2).toLocaleString()}콜이다`)
  log(`   이미 캐시된 (종목·연도·보고서) ${cachedCount.toLocaleString()}건은 건너뛴다`)
  log(`   DART 한도 ${DART_DAILY_QUOTA.toLocaleString()}건/일 · 이번 실행 상한 ${MAX_CALLS.toLocaleString()}콜 · 간격 ${MIN_INTERVAL_MS}ms`)
  log(`   예상 소요(캐시 없는 부분): 약 ${Math.round(((base - cachedCount) * MIN_INTERVAL_MS) / 60000)}분`)
  log(`   캐시: ${FS_CACHE_DIR} (재실행하면 끊긴 지점부터 이어간다)`)

  let done = 0
  let halted: string | null = null

  for (const t of mapped) {
    // 종목별로 "잘 되는 fs_div"를 앞에 둔다 — 별도만 있는 회사에서 CFS 013을 매번 먼저 맞지 않게.
    let order: DartFsDiv[] = ['CFS', 'OFS']
    for (const year of years) {
      for (const reprt of REPRT_SET) {
        assertDartReprtCode(reprt)
        done++
        // 이미 이 (종목·연도·보고서)로 어떤 div든 캐시가 있으면 통째로 건너뛴다.
        if (DART_FS_DIVS.some((d) => existsSync(fsCacheFile(t.corp, year, reprt, d)))) continue
        for (const div of order) {
          assertDartFsDiv(div)
          if (stat.calls >= MAX_CALLS) {
            halted = `이번 실행 콜 상한(${MAX_CALLS.toLocaleString()}) 도달`
            break
          }
          const json = await dartJson(
            'fnlttSinglAcntAll.json',
            { corp_code: t.corp, bsns_year: String(year), reprt_code: reprt, fs_div: div },
            key,
          )
          const env = readDartEnvelope(json)
          const kind = dartStatusKind(env.status)
          if (kind === 'quota') throw new HaltError(`요청 한도 초과 (status=${env.status}) — 내일 같은 명령으로 재개`)
          if (kind === 'auth') throw new HaltError(`키 오류 (status=${env.status} ${dartStatusMeaning(env.status)})`)
          if (kind === 'maintenance') throw new HaltError(`DART 점검 중 (status=${env.status}) — 나중에 재개`)
          if (env.status === DART_STATUS_OK) {
            stat.ok++
            writeFileSync(fsCacheFile(t.corp, year, reprt, div), JSON.stringify(json), 'utf8')
            order = div === 'CFS' ? ['CFS', 'OFS'] : ['OFS', 'CFS']
            break
          }
          if (env.status === DART_STATUS_EMPTY) {
            stat.empty++
            // 정상 0건도 캐시한다(재실행 때 같은 013을 다시 사러 가지 않게).
            writeFileSync(fsCacheFile(t.corp, year, reprt, div), JSON.stringify(json), 'utf8')
            continue
          }
          stat.fail++
          log(`   ⛔ ${t.code} FY${year} ${reprt} ${div}: status=${env.status} (${dartStatusMeaning(env.status)}) ${env.message}`)
        }
        if (halted) break
      }
      if (halted) break
    }
    if (halted) break
    if (done % 200 === 0 || t === mapped[mapped.length - 1]) {
      const remain = DART_DAILY_QUOTA - stat.calls
      log(
        `   … ${done.toLocaleString()}/${todo.length.toLocaleString()} (${t.code} ${t.name}) · ` +
          `콜 ${stat.calls.toLocaleString()} (성공 ${stat.ok} / 정상0건 ${stat.empty} / 실패 ${stat.fail}) · ` +
          `일 한도 잔량 ≈ ${remain.toLocaleString()}`,
      )
    }
  }

  if (halted) {
    log('')
    log(`⏸ 수집 중단: ${halted}`)
    log('   같은 명령을 다시 실행하면 캐시 덕분에 끊긴 지점부터 이어간다.')
  }
  return { complete: !halted, halted }
}

// ------------------------------------------------------------------ 가공

interface StockOut {
  entry: FundamentalIndexEntry
  bytes: number
}

/** 캐시에서 한 종목의 레코드를 모은다. 계정 추출 실패는 **삼키지 않고** 센다. */
function buildRecords(t: Target): { records: FundamentalRecord[]; errors: string[] } {
  const records: FundamentalRecord[] = []
  const errors: string[] = []
  const seen = new Set<string>()
  for (let year = FROM_YEAR; year <= TO_YEAR; year++) {
    for (const reprt of REPRT_SET) {
      for (const div of DART_FS_DIVS) {
        const raw = readJsonFile(fsCacheFile(t.corp, year, reprt, div))
        if (raw == null) continue
        let env
        try {
          env = readDartEnvelope(raw)
        } catch (e) {
          errors.push(`${t.code} FY${year} ${reprt} ${div}: ${(e as Error).message}`)
          stat.parseFail++
          continue
        }
        if (env.status !== DART_STATUS_OK) continue // 013 등은 레코드가 아니다(정상 0건)
        try {
          const rec = extractFundamentalRecord(env.list, { bsnsYear: year, reprtCode: reprt, fsDiv: div })
          const key = `${rec.rceptNo}|${rec.fsDiv}`
          if (seen.has(key)) continue
          seen.add(key)
          records.push(rec)
          stat.parsed++
        } catch (e) {
          errors.push(`${t.code} FY${year} ${reprt} ${div}: ${(e as Error).message}`)
          stat.parseFail++
        }
      }
    }
  }
  // 같은 (연도·보고서)에서 CFS·OFS가 둘 다 잡혔으면 **연결 우선**으로 하나만 남긴다.
  const byPeriod = new Map<string, FundamentalRecord>()
  for (const r of records) {
    const k = `${r.bsnsYear}|${r.reprtCode}|${r.rceptNo}`
    const cur = byPeriod.get(k)
    if (!cur || (cur.fsDiv === 'OFS' && r.fsDiv === 'CFS')) byPeriod.set(k, r)
  }
  const out = [...byPeriod.values()].sort((a, b) =>
    a.rceptDt !== b.rceptDt ? (a.rceptDt < b.rceptDt ? -1 : 1) : a.rceptNo < b.rceptNo ? -1 : a.rceptNo > b.rceptNo ? 1 : 0,
  )
  return { records: out, errors }
}

function writeStock(t: Target, records: FundamentalRecord[]): StockOut {
  const obj = {
    schema: DART_FUNDAMENTALS_SCHEMA_STOCK,
    code: t.code,
    corpCode: t.corp,
    name: t.name,
    unit: 'KRW' as const,
    records,
  }
  // 쓰기 직전 자기검증 — 손으로 조립한 객체를 읽는 쪽과 같은 파서로 통과시킨다.
  parseFundamentalStock(obj)
  const text = JSON.stringify(obj)
  writeFileSync(join(STOCKS_DIR, `${t.code}.json`), text, 'utf8')
  const years = records.map((r) => r.bsnsYear)
  const divs = [...new Set(records.map((r) => r.fsDiv))].sort() as DartFsDiv[]
  return {
    entry: {
      code: t.code,
      corpCode: t.corp,
      name: t.name,
      records: records.length,
      firstYear: Math.min(...years),
      lastYear: Math.max(...years),
      latestRceptDt: records[records.length - 1].rceptDt,
      fsDivs: divs,
      file: dartFundamentalFile(t.code),
    },
    bytes: Buffer.byteLength(text, 'utf8'),
  }
}

function dirBytes(dir: string): number {
  let total = 0
  for (const f of readdirSync(dir)) {
    const p = join(dir, f)
    const st = statSync(p)
    total += st.isDirectory() ? dirBytes(p) : st.size
  }
  return total
}

interface ProcessResult {
  entries: FundamentalIndexEntry[]
  missing: string[]
  unmapped: string[]
  errors: string[]
  latestRceptDt: string
  allRecords: number
}

function process_(targets: Target[]): ProcessResult {
  rmSync(STOCKS_DIR, { recursive: true, force: true })
  mkdirSync(STOCKS_DIR, { recursive: true })
  const entries: FundamentalIndexEntry[] = []
  const missing: string[] = []
  const unmapped: string[] = []
  const errors: string[] = []
  let latest = ''
  let allRecords = 0

  for (const t of targets) {
    if (!t.corp) {
      unmapped.push(t.code)
      continue
    }
    const { records, errors: errs } = buildRecords(t)
    errors.push(...errs)
    if (records.length === 0) {
      missing.push(t.code)
      continue
    }
    const out = writeStock(t, records)
    entries.push(out.entry)
    allRecords += records.length
    if (out.entry.latestRceptDt > latest) latest = out.entry.latestRceptDt
  }

  if (entries.length === 0) throw new Error('가공 결과 0종목 — 캐시가 비었거나 전량 실패다. index를 쓰지 않는다')
  return { entries, missing, unmapped, errors, latestRceptDt: latest, allRecords }
}

function writeIndex(r: ProcessResult): void {
  const obj = {
    schema: DART_FUNDAMENTALS_SCHEMA_INDEX,
    version: 1,
    source: DART_FUNDAMENTALS_SOURCE,
    basis: DART_FUNDAMENTALS_BASIS,
    asOf: KST_TODAY,
    fromYear: FROM_YEAR,
    toYear: TO_YEAR,
    reprtCodes: REPRT_SET,
    accounts: [...DART_STORED_ACCOUNTS],
    // 계정은 처음부터 팩터 계산에 필요한 6종만 저장한다(원시 전체 계정 저장 안 함).
    accountsTrimmed: true,
    missingCodes: r.missing.slice().sort(),
    unmappedCodes: r.unmapped.slice().sort(),
    latestRceptDt: r.latestRceptDt,
    limits: [
      ...DART_FUNDAMENTALS_LIMITS,
      `계정은 팩터 계산에 필요한 ${DART_STORED_ACCOUNTS.length}종만 저장한다(원시 전체 계정 미보관) — 용량 예산 ${MAX_MB}MB.`,
      `유니버스 = krx-pit 40+40 합집합 ${r.entries.length + r.missing.length + r.unmapped.length}종목 중 재무 확보 ${r.entries.length}종목.`,
    ],
    stocks: r.entries.slice().sort((a, b) => (a.code < b.code ? -1 : 1)),
  }
  parseFundamentalIndex(obj) // 쓰기 직전 자기검증
  writeFileSync(join(OUT_DIR, 'index.json'), JSON.stringify(obj), 'utf8')
}

// -------------------------------------------------------- 자기검증 배터리

function verify(r: ProcessResult): boolean {
  log('')
  log('='.repeat(78))
  log('자기검증 배터리')
  log('='.repeat(78))
  let ok = true

  const all: FundamentalRecord[] = []
  for (const e of r.entries) {
    const stock = parseFundamentalStock(readJsonFile(join(STOCKS_DIR, `${e.code}.json`)))
    all.push(...stock.records)
  }

  // ① 회계 항등식 자산 = 부채 + 자본 (총계 기준 레코드만)
  let checked = 0
  let passed = 0
  for (const rec of all) {
    const v = checkAccountingIdentity(rec)
    if (!v.checked) continue
    checked++
    if (v.ok) passed++
  }
  const idRate = checked > 0 ? passed / checked : 1
  log(`① 항등식 자산=부채+자본: ${passed}/${checked} 통과 (${(idRate * 100).toFixed(2)}%)`)
  if (checked > 0 && idRate < 0.95) {
    ok = false
    log('   ⛔ 항등식 통과율이 95% 미만 — 계정 매칭이 잘못됐을 수 있다')
  }

  // ② 접수일 > 사업연도 종료일 (PIT 근거) — 전수
  const pitBad = all.filter((rec) => rec.rceptDt <= `${rec.bsnsYear}-12-31` && rec.reprtCode === '11011')
  log(`② 사업보고서 접수일 > 사업연도 종료일: 위반 ${pitBad.length}건 / ${all.filter((x) => x.reprtCode === '11011').length}건`)
  if (pitBad.length > 0) {
    ok = false
    log(`   ⛔ PIT 근거 위반 표본: ${pitBad.slice(0, 5).map((x) => `FY${x.bsnsYear} ${x.rceptDt}`).join(', ')}`)
  }

  // ③ 연결/별도 혼합 — 숨기지 않고 드러낸다
  const cfs = all.filter((x) => x.fsDiv === 'CFS').length
  const ofs = all.length - cfs
  const mixedStocks = r.entries.filter((e) => e.fsDivs.length > 1).length
  log(`③ fs_div: CFS ${cfs}건 / OFS ${ofs}건 · 한 종목 안에서 섞인 종목 ${mixedStocks}개`)

  // ④ 계정 결측률
  const miss = (f: (x: FundamentalRecord) => number | null): string => {
    const n = all.filter((x) => f(x) == null).length
    return `${n}(${((n / all.length) * 100).toFixed(1)}%)`
  }
  log(
    `④ 계정 결측: 자본 ${miss((x) => x.equity)} · 자산 ${miss((x) => x.assets)} · 부채 ${miss((x) => x.liabilities)} · ` +
      `순이익 ${miss((x) => x.netIncome)} · 매출 ${miss((x) => x.revenue)} · 영업이익 ${miss((x) => x.operatingIncome)}`,
  )
  const equityMiss = all.filter((x) => x.equity == null).length / all.length
  if (equityMiss > 0.1) {
    ok = false
    log('   ⛔ 자본총계 결측률 10% 초과 — PBR·ROE가 대량으로 null이 된다. 계정 매칭 점검 필요')
  }

  // ⑤ 연도별 분포 · 최신 접수일 (언제 멈췄는지 보이게 — 규칙 4)
  const byYear = new Map<number, number>()
  for (const rec of all) byYear.set(rec.bsnsYear, (byYear.get(rec.bsnsYear) ?? 0) + 1)
  log(
    `⑤ 연도별 레코드: ${[...byYear.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([y, n]) => `${y}:${n}`)
      .join(' ')}`,
  )
  log(`   **최신 수집 데이터(최신 접수일) = ${r.latestRceptDt}**`)

  // ⑥ 지배주주/총계 폴백 비율
  const parentEq = all.filter((x) => x.equitySource === 'parent').length
  log(`⑥ 자본 지배주주분 사용 ${parentEq}건 / 총계 폴백 ${all.filter((x) => x.equitySource === 'total').length}건`)

  return ok
}

// ------------------------------------------------------------------ 실행

async function main(): Promise<number> {
  log('='.repeat(78))
  log('DART 재무 수집기 — 밸류·퀄리티 팩터용 정본 (조회 전용 · 규칙 2 1단계)')
  log('='.repeat(78))
  log(`리포 루트: ${ROOT}`)
  log(`출력: ${OUT_DIR}`)
  log(`구간: FY${FROM_YEAR}~${TO_YEAR} (DART 재무 시작 ${DART_FIRST_YEAR}년 — 그 이전은 존재하지 않는다)`)

  const { targets } = loadUniverse()
  log(`유니버스: krx-pit 40+40 합집합 ${targets.length}종목 (top=${TOP_N})`)
  if (targets.length === 0) throw new Error('유니버스가 0종목 — 수집할 대상이 없다')

  let collected: CollectResult = { complete: true, halted: null }
  if (!PROCESS_ONLY) {
    collected = await collect(targets)
  } else {
    // 가공만 할 때도 corp_code는 있어야 캐시 경로를 만든다(캐시된 매핑만 사용, 콜 0).
    const cached = readJsonFile(CORP_MAP_CACHE) as Record<string, { corp: string }> | null
    if (!cached) throw new Error('--process-only인데 corp-map 캐시가 없다 — 먼저 수집을 한 번 돌려라')
    for (const t of targets) t.corp = cached[t.code]?.corp ?? ''
  }

  log('')
  log(
    `▶ 수집 집계: 콜 ${stat.calls.toLocaleString()} · 성공 ${stat.ok.toLocaleString()} · ` +
      `정상 0건(013) ${stat.empty.toLocaleString()} · 실패 ${stat.fail.toLocaleString()} · ` +
      `일 한도 잔량 ≈ ${(DART_DAILY_QUOTA - stat.calls).toLocaleString()}`,
  )

  // 규칙 4 게이트 ③ — 받은 게 0인데 오류가 있으면 전량 실패다(정상 0건과 구분).
  if (!PROCESS_ONLY && stat.ok === 0 && stat.fail > 0) {
    log('⛔ 성공 0건인데 실패가 있다 — 전량 실패로 종료(exit 1). 키 유효성·한도(020)·차단을 먼저 의심할 것.')
    return 1
  }

  if (COLLECT_ONLY) {
    log('--collect-only — 가공을 건너뛴다.')
    return collected.complete ? 0 : 2
  }
  if (!collected.complete) {
    log('⏸ 수집이 완결되지 않았다 — 반쪽 데이터셋을 리포에 커밋하지 않기 위해 가공을 건너뛴다.')
    log('   같은 명령을 다시 실행해 남은 콜을 채운 뒤 가공된다.')
    return 2
  }

  mkdirSync(OUT_DIR, { recursive: true })
  const result = process_(targets)
  writeIndex(result)

  const mb = dirBytes(OUT_DIR) / 1024 / 1024
  log('')
  log(
    `▶ 가공 완료: ${result.entries.length}종목 · 레코드 ${result.allRecords.toLocaleString()}건 · ` +
      `데이터없음 ${result.missing.length}종목 · 매핑실패 ${result.unmapped.length}종목 · ` +
      `용량 ${mb.toFixed(2)}MB / 예산 ${MAX_MB}MB`,
  )
  if (result.errors.length > 0) {
    log(`   ⚠️ 계정 추출 실패 ${result.errors.length}건(조용히 넘기지 않는다):`)
    for (const e of result.errors.slice(0, 20)) log(`      ${e}`)
    if (result.errors.length > 20) log(`      … 외 ${result.errors.length - 20}건`)
  }
  if (mb > MAX_MB) {
    log(`   ⛔ 용량 예산 초과 (${mb.toFixed(2)}MB > ${MAX_MB}MB) — 계정을 더 줄이거나 분기 보고서를 빼야 한다`)
    return 3
  }

  const verified = verify(result)
  log('')
  if (!verified) {
    log('⛔ 자기검증 실패 — 이 산출물을 커밋하지 마라 (exit 3)')
    return 3
  }
  log('✅ 자기검증 통과 — 산출물을 커밋해도 된다')
  return 0
}

/**
 * 종료코드를 확정한다.
 * **전량 실패를 종료코드로 드러낸다** — 항목별 try가 오류를 삼켜 "다 실패했는데 0"이 되는
 * 것을 막는 마지막 게이트다(규칙 4).
 */
function finalExit(code: number): never {
  let out = code
  if (!PROCESS_ONLY && stat.calls > 0 && stat.ok === 0) {
    console.error('⛔ 성공 호출 0건 — 전량 실패로 종료(exit 1). 키 유효성·한도(020)·차단을 먼저 의심할 것.')
    out = out === 0 ? 1 : out
  }
  process.exit(out)
}

main().then(
  (code) => finalExit(code),
  (e: unknown) => {
    if (e instanceof HaltError) {
      console.error(`\n⏸ 중단: ${e.message}`)
      console.error('   캐시가 남아 있으므로 같은 명령으로 이어서 받을 수 있다.')
      finalExit(2)
    }
    console.error(`\n⛔ 실패: ${(e as Error)?.stack ?? String(e)}`)
    finalExit(1)
  },
)
