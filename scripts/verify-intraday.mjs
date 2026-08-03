// 5분봉 백데이터 정확성 검증 러너 — 대표 PC에서 실행 (조회 전용 · 규칙 2 준수).
//
// "백데이터가 정확하지 않으면 백테스트는 무의미하다"에 대한 답이다. 세 층으로 검증한다:
//   층① 구조 무결성 (오프라인)   — OHLC 순서·5분 격자·장중 시간대·중복·주말·수정주가 스플라이스.
//   층② 키움 일봉 교차 (앱키 필요) — 5분봉을 일봉으로 집계해 같은 소스의 일봉(ka10081)과 대조.
//                                    같은 소스·같은 보정이므로 어긋나면 "우리 파싱·병합 버그"다.
//   층③ Yahoo 일봉 교차 (네트워크) — 독립 소스와 대조. 어긋나면 "소스 자체의 차이/오류"다.
//                                    보정 정책이 달라 계통 편차는 WARN(사유 표시)으로 다룬다.
//
// 한계(정직성): 두 독립 소스가 같은 방식으로 틀린 오류는 어떤 대조로도 못 잡는다.
// 공식 정본(KRX 정보데이터시스템)은 일봉까지만 제공하므로, 이 검증의 보장 범위는
// "일봉 수준에서 두 소스와 일치 + 봉 구조가 물리적으로 유효"까지다. 5분봉 개별 값의
// 절대 보증은 존재하지 않는다 — 그래서 전략 판정은 슬리피지 완충을 두고 해석한다.
//
// 실행 (docs/mock-trading.md §4-④):
//   doppler run --project investing-ops --config prd -- node scripts/verify-intraday.mjs
//   옵션: --symbols=005930.KS,...  --skip-kiwoom  --skip-yahoo  --json=경로(리포트 저장)
// 종료 코드: FAIL 있으면 1 (CI·스케줄러에서 그대로 게이트로 쓸 수 있다)

import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadSecret } from './lib/loadSecret.mjs'
import { createKiwoomClient, parseDailyChart } from './lib/kiwoom.mjs'
import { kstDate, toDailyBars, unpackBars } from './lib/intraday.mjs'
import {
  checkStructure,
  compareDailySeries,
  compareVolume,
  dayGapSuspects,
  lastBarMinSummary,
  verdictOf,
} from './lib/verifyIntraday.mjs'

const args = new Map(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/)
    return m ? [m[1], m[2] ?? 'true'] : [a, 'true']
  }),
)
const ONLY = args.get('symbols')?.split(',').map((s) => s.trim()).filter(Boolean) ?? null
const SKIP_KIWOOM = args.get('skip-kiwoom') === 'true'
const SKIP_YAHOO = args.get('skip-yahoo') === 'true'
const JSON_OUT = args.get('json') ?? null
/**
 * `--since=YYYY-MM-DD` — 이 날짜 이후 봉만 검증한다. **매일 수집 전용 옵션**이다.
 *
 * 왜 필요한가: 파일에는 야후 시절 누적분이 남아 있고, 그 구간은 매일 14:55에 끊겨 있다
 * (2026-08-03 실측 80종목 4,800일 중 96.7%). 그 결함은 증분 수집으로 고쳐지지 않으므로,
 * 범위를 안 좁히면 **오늘 새로 받은 정상 데이터도 어제의 결함 때문에 영원히 커밋되지 않는다.**
 * 매일 수집이 얼어붙는 동안 키움 소급 한도를 넘어간 날은 영구히 못 받는다 — 그게 더 큰 손실이다.
 *
 * ⚠️ **결함을 숨기는 옵션이 아니다.** 주간 전수 검증(`weekly-backfill`)은 `--since` 없이 돌아
 * 절단 구간을 계속 FAIL로 들고 있다. 이 옵션은 "덮기"가 아니라 "분리"다.
 */
const SINCE = args.get('since') ?? null
if (SINCE && !/^\d{4}-\d{2}-\d{2}$/.test(SINCE)) {
  console.error(`⛔ --since 형식이 YYYY-MM-DD가 아니다: ${SINCE}`)
  process.exit(2)
}
const KIWOOM_REQ_CAP = Number(args.get('max-kiwoom-req') ?? 10)

const DATA_DIR = join(process.cwd(), 'public', 'data', 'intraday')

// ---- 층② 준비: 키움 클라이언트 (키 없으면 층② 자동 스킵 — 층①③은 그대로 진행) --
let client = null
if (!SKIP_KIWOOM) {
  const mockKey = loadSecret('KIWOOM_MOCK_APP_KEY')
  const mockSecret = loadSecret('KIWOOM_MOCK_APP_SECRET')
  const key = mockKey.value ? mockKey : loadSecret('KIWOOM_APP_KEY')
  const secret = mockSecret.value ? mockSecret : loadSecret('KIWOOM_APP_SECRET')
  if (key.value && secret.value) {
    client = createKiwoomClient({ appKey: key.value, appSecret: secret.value, minIntervalMs: 1200 })
    console.log(`층② 키움 일봉 교차: 켜짐 (${client.base})`)
  } else console.log('층② 키움 일봉 교차: 키 없음 — 스킵 (doppler run 으로 실행하면 켜진다)')
} else console.log('층② 키움 일봉 교차: --skip-kiwoom')
console.log(SKIP_YAHOO ? '층③ Yahoo 일봉 교차: --skip-yahoo' : '층③ Yahoo 일봉 교차: 켜짐')

// ---- 층② 조회: 커버 기간을 덮을 때까지 연속조회 ------------------------------
async function fetchKiwoomDaily(code, firstDate) {
  const daily = []
  let contYn = 'N'
  let nextKey = ''
  let dropped = 0
  let diag = null // 첫 응답 진단 — 겹침 0일의 원인 추적용 (키 이름·상태 코드만, 값 미출력 원칙)
  for (let req = 0; req < KIWOOM_REQ_CAP; req++) {
    const { json, cont } = await client.dailyChart(code, { adjusted: true, contYn, nextKey })
    const parsed = parseDailyChart(json)
    if (!diag)
      diag = `return_code=${json?.return_code ?? '?'} msg="${json?.return_msg ?? ''}" 키=[${Object.keys(json ?? {}).join(',')}] 행=${parsed.totalRows} 탈락=${parsed.dropped}${
        parsed.daily.length ? ` 날짜=${parsed.daily[0].date}~${parsed.daily[parsed.daily.length - 1].date}` : ''
      }`
    dropped += parsed.dropped
    if (!parsed.daily.length) break
    daily.push(...parsed.daily)
    const oldest = parsed.daily[0].date
    if (oldest <= firstDate) break
    if (cont.contYn !== 'Y' || !cont.nextKey) break
    contYn = 'Y'
    nextKey = cont.nextKey
  }
  daily.sort((a, b) => (a.date < b.date ? -1 : 1))
  return { daily, dropped, diag }
}

// ---- 층③ 조회: Yahoo 일봉 (quote OHLC = 분할만 보정 — 키움 수정주가와 기준 근접) --
async function fetchYahooDaily(symbol, firstDate) {
  const p1 = Math.floor(Date.parse(`${firstDate}T00:00:00Z`) / 1000) - 7 * 86400
  const p2 = Math.floor(Date.now() / 1000) + 86400
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${p1}&period2=${p2}&interval=1d`
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json()
      const r = json?.chart?.result?.[0]
      if (!r) throw new Error(json?.chart?.error?.description ?? 'chart.result 없음')
      if (r.meta?.dataGranularity && r.meta.dataGranularity !== '1d')
        throw new Error(`granularity=${r.meta.dataGranularity} (1d 아님)`)
      const ts = r.timestamp ?? []
      const q = r.indicators?.quote?.[0] ?? {}
      const daily = []
      for (let i = 0; i < ts.length; i++) {
        const c = q.close?.[i]
        if (c == null || !Number.isFinite(c)) continue
        const d = new Date((ts[i] + 9 * 3600) * 1000).toISOString().slice(0, 10)
        daily.push({ date: d, o: q.open?.[i], h: q.high?.[i], l: q.low?.[i], c, v: q.volume?.[i] ?? 0 })
      }
      return { daily }
    } catch (e) {
      if (attempt === 2) return { daily: [], error: String(e.message).slice(0, 80) }
      await new Promise((r2) => setTimeout(r2, 1500 * (attempt + 1)))
    }
  }
  return { daily: [] }
}

// ---- 메인 루프 ---------------------------------------------------------------
const all = readdirSync(DATA_DIR)
  .filter((f) => f.endsWith('.json') && f !== 'index.json')
  .map((f) => f.replace(/\.json$/, ''))
const targets = (ONLY ?? all).filter((s) => /^\d{6}\.(KS|KQ)$/.test(s))
console.log(
  `대상 ${targets.length}종목` +
    (SINCE
      ? ` · 검증 범위 ${SINCE} 이후만 (매일 수집 모드 — 그 이전 구간의 결함은 주간 전수 검증이 계속 들고 있다)\n`
      : ' · 검증 범위 전 구간\n'),
)

const results = []
for (const sym of targets) {
  let store
  try {
    store = JSON.parse(readFileSync(join(DATA_DIR, `${sym}.json`), 'utf8'))
  } catch {
    results.push({ sym, verdict: { level: 'FAIL', fails: ['파일 읽기/파싱 실패'], warns: [] } })
    continue
  }
  const all = unpackBars(store.bars)
  const bars = SINCE ? all.filter((b) => kstDate(b.ts) >= SINCE) : all
  if (SINCE && !bars.length) {
    // 범위 안에 봉이 하나도 없으면 "검증할 게 없다"이지 "통과"가 아니다 — 구분해서 말한다.
    results.push({ sym, verdict: { level: 'WARN', fails: [], warns: [`--since=${SINCE} 이후 봉 0개 — 검증 대상 없음`] } })
    console.log(`⚠️  ${sym} · --since=${SINCE} 이후 봉 0개 (전체 ${all.length}봉) — 검증 대상 없음`)
    continue
  }
  const structure = checkStructure(bars)
  const aggDaily = toDailyBars(bars.map((b) => ({ ts: b.ts, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v })))
  const splices = dayGapSuspects(aggDaily)
  const onlyDates = structure.fullDays

  let kiwoomCmp = null
  let kiwoomVol = null
  if (client && structure.firstDate) {
    try {
      const { daily, dropped, diag } = await fetchKiwoomDaily(sym.slice(0, 6), structure.firstDate)
      kiwoomCmp = compareDailySeries(aggDaily, daily, { onlyDates })
      kiwoomCmp.dropped = dropped
      if (!kiwoomCmp.n && diag) kiwoomCmp.error = diag // 겹침 0일이면 첫 응답 진단을 그대로 노출
      kiwoomVol = compareVolume(aggDaily, daily, { onlyDates })
    } catch (e) {
      kiwoomCmp = { n: 0, error: String(e.message).slice(0, 160) }
    }
  }

  let yahooCmp = null
  let yahooVol = null
  if (!SKIP_YAHOO && structure.firstDate) {
    const { daily, error } = await fetchYahooDaily(sym, structure.firstDate)
    if (daily.length) {
      yahooCmp = compareDailySeries(aggDaily, daily, { onlyDates })
      yahooVol = compareVolume(aggDaily, daily, { onlyDates })
    } else yahooCmp = { n: 0, error }
    await new Promise((r) => setTimeout(r, 400)) // Yahoo 유량 예의
  }

  const verdict = verdictOf({ structure, splices, kiwoomCmp, kiwoomVol, yahooCmp, yahooVol })
  results.push({ sym, structure, splices, kiwoomCmp, kiwoomVol, yahooCmp, yahooVol, verdict })

  const kTxt = kiwoomCmp
    ? kiwoomCmp.n
      ? `키움 ${kiwoomCmp.n}일 편차 ${kiwoomCmp.avgAbsDevPct.toFixed(3)}%`
      : `키움 교차 불가${kiwoomCmp.error ? `(${kiwoomCmp.error})` : ''}`
    : '키움 스킵'
  const yTxt = yahooCmp
    ? yahooCmp.n
      ? `Yahoo ${yahooCmp.n}일 편차 ${yahooCmp.avgAbsDevPct.toFixed(3)}%`
      : `Yahoo 교차 불가${yahooCmp.error ? `(${yahooCmp.error})` : ''}`
    : 'Yahoo 스킵'
  console.log(
    `${verdict.level === 'PASS' ? '✅' : verdict.level === 'WARN' ? '⚠️ ' : '❌'} ${sym} · ${structure.days}일/${structure.bars}봉${structure.afterHours ? `(시간외 ${structure.afterHours})` : ''}` +
      ` · 막봉 ${lastBarMinSummary(structure.lastBarMinHist, 2)}` +
      ` · 대조가능 ${structure.fullDays.length}일` +
      ` · ${kTxt} · ${yTxt}${
      verdict.fails.length || verdict.warns.length ? ` · ${[...verdict.fails, ...verdict.warns].join(' | ')}` : ''
    }`,
  )
}

// ---- 최종 보고 ---------------------------------------------------------------
const counts = { PASS: 0, WARN: 0, FAIL: 0 }
for (const r of results) counts[r.verdict.level]++
console.log(`\n판정: PASS ${counts.PASS} · WARN ${counts.WARN} · FAIL ${counts.FAIL} / ${results.length}종목`)
if (counts.FAIL) {
  console.log('\nFAIL 종목 — 백테스트 사용 금지. 처방:')
  for (const r of results.filter((x) => x.verdict.level === 'FAIL'))
    console.log(`  ${r.sym}: ${r.verdict.fails.join(' | ')}`)
  console.log('  → 스플라이스·구조 위반은 해당 파일 삭제 후 kiwoom-backfill.mjs 재실행(전체 재수집)으로 해소된다.')
  console.log(
    '  → **마감 구간 결측은 증분 수집으로 못 고친다.** 절단된 과거 구간(야후 누적분)이 파일에 남아 있는 한',
  )
  console.log(
    '     매번 같은 FAIL이 난다. 해당 파일을 비우고 키움에서 전체 재수집해야 하며, 키움 소급 한도 밖 구간은',
  )
  console.log('     복구되지 않는다(그 구간은 없는 것으로 취급 — 있는 척하는 것보다 낫다).')
}
if (counts.WARN) {
  console.log('\nWARN 종목 — 사용 가능하되 한계 명시(규칙 3):')
  for (const r of results.filter((x) => x.verdict.level === 'WARN'))
    console.log(`  ${r.sym}: ${r.verdict.warns.join(' | ')}`)
}
console.log('\n보장 범위: 일봉 수준 2중 교차 + 봉 구조 검증까지. 5분봉 개별 값의 절대 보증은 없다 —')
console.log('전략 판정 시 슬리피지 완충을 두고, 재수집(주기 실행) 때마다 이 검증을 함께 돌린다.')
console.log('이 출력 전체를 총괄 세션에 붙여넣어 주세요 (검증 실측 기록용).')

if (JSON_OUT) {
  writeFileSync(JSON_OUT, JSON.stringify({ at: new Date().toISOString(), counts, results }, null, 1))
  console.log(`리포트 저장: ${JSON_OUT}`)
}
process.exit(counts.FAIL ? 1 : 0)
