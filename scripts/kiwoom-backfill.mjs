// 키움 5분봉 백필 수집기 — 대표 PC에서 실행 (등록 IP 필요 · 조회 전용 · 규칙 2 준수).
//
// 하는 일:
//   1) 유니버스(기존 종목별 저장소 = public/data/intraday/*.json)의 각 종목에 대해
//      키움 ka10080 분봉을 연속조회(cont-yn/next-key)로 과거까지 당긴다.
//      **소급 한도는 미공개 [미검증] — 이 스크립트가 실측해서 보고한다.**
//   2) 병합 전에 기존 Yahoo 봉과 겹치는 구간을 **대조**한다(종가 불일치율·시간축 오프셋).
//      키움 cntr_tm이 봉의 시작/끝 어느 쪽인지 문서가 불명확해 [미검증], 오프셋
//      0/±300초 중 가장 잘 맞는 정렬을 자동 탐지해 Yahoo 규약(시작 시각)으로 맞춘다.
//   3) 검증 통과 시 저장소에 병합(키움 = 원천 데이터로 겹침 구간 우선). --dry-run 이면
//      대조 보고까지만 하고 쓰지 않는다.
//
// 실행 (docs/mock-trading.md 참조):
//   doppler run --project investing-ops --config prd -- node scripts/kiwoom-backfill.mjs [옵션]
//   옵션: --dry-run(기본 아님·병합 없이 보고만) --max-days=730 --symbols=005930.KS,...
//
// 주의: 실행 시간 — 종목당 수 회~수십 회 요청 × 80종목, 유량 스로틀 포함 20분 이상 걸릴
// 수 있다. 중간에 끊겨도 다시 실행하면 이어진다(이미 충분히 소급된 종목은 건너뜀).
// 수정주가: upd_stkpc_tp=1(수정주가) 요청 — Yahoo 60일 구간과 혼합 시 분할 이벤트가
// 있으면 겹침 구간 불일치로 드러난다(대조 보고에서 확인).

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { loadSecret } from './lib/loadSecret.mjs'
import { createKiwoomClient, parseMinuteChart } from './lib/kiwoom.mjs'
import { mergeBars, packBars, unpackBars, coverage, kstDate } from './lib/intraday.mjs'

const args = new Map(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/)
    return m ? [m[1], m[2] ?? 'true'] : [a, 'true']
  }),
)
const DRY_RUN = args.get('dry-run') === 'true'
const MAX_DAYS = Number(args.get('max-days') ?? 730)
const ONLY = args.get('symbols')?.split(',').map((s) => s.trim()).filter(Boolean) ?? null

const OUT_DIR = join(process.cwd(), 'public', 'data', 'intraday')

// ---- 시크릿 (모의투자용 키 우선 — kiwoom-probe와 동일 체계) ------------------
const mockKey = loadSecret('KIWOOM_MOCK_APP_KEY')
const mockSecret = loadSecret('KIWOOM_MOCK_APP_SECRET')
const key = mockKey.value ? mockKey : loadSecret('KIWOOM_APP_KEY')
const secret = mockSecret.value ? mockSecret : loadSecret('KIWOOM_APP_SECRET')
if (!key.value || !secret.value) {
  console.error(key.help ?? secret.help)
  process.exit(1)
}
const client = createKiwoomClient({ appKey: key.value, appSecret: secret.value })
console.log(`서버: ${client.base} (모의서버 — 시세가 실서버와 동일한지는 대조 보고로 확인 [미검증])`)
console.log(`모드: ${DRY_RUN ? 'dry-run(보고만)' : '병합 저장'} · 소급 목표 ${MAX_DAYS}일`)

// ---- 저장소 헬퍼 -------------------------------------------------------------
const symbolFile = (sym) => join(OUT_DIR, `${sym.replace(/[^0-9A-Za-z.^-]/g, '_')}.json`)
function loadStore(sym) {
  try {
    return JSON.parse(readFileSync(symbolFile(sym), 'utf8'))
  } catch {
    return null
  }
}

// ---- 키움 → 표준 봉 (시간축 정렬 포함) ---------------------------------------
/** 오프셋 후보 중 기존 Yahoo 봉과 가장 많이 겹치는 정렬을 고른다. 겹침이 없으면 0. */
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

// ---- 수집 루프 ---------------------------------------------------------------
const all = readdirSync(OUT_DIR)
  .filter((f) => f.endsWith('.json') && f !== 'index.json')
  .map((f) => f.replace(/\.json$/, ''))
const targets = (ONLY ?? all).filter((s) => /^\d{6}\.(KS|KQ)$/.test(s))
console.log(`대상 ${targets.length}종목 (6자리 코드만 — 지수·ETF 제외)`)

const cutoffTs = Math.floor(Date.now() / 1000) - MAX_DAYS * 86400
const report = []
let requestsTotal = 0

for (const sym of targets) {
  const code = sym.slice(0, 6)
  const store = loadStore(sym)
  const existing = store ? unpackBars(store.bars) : []
  const oldestExisting = existing.length ? existing[0].ts : null
  // 이미 목표 깊이까지 있으면 건너뜀 (재실행 이어받기)
  if (oldestExisting != null && oldestExisting <= cutoffTs) {
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
        stop = '목표 깊이 도달'
        break
      }
      if (cont.contYn !== 'Y' || !cont.nextKey) {
        stop = '서버 소급 한도(연속조회 끝)'
        break
      }
      contYn = 'Y'
      nextKey = cont.nextKey
      if (requests >= 200) {
        stop = '요청 상한(200회/종목) — 재실행으로 이어받기'
        break
      }
    }
  } catch (e) {
    stop = `오류: ${String(e.message).slice(0, 120)}`
  }

  if (!collected.length) {
    report.push({ sym, skipped: stop || '수집 0봉', bars: existing.length })
    continue
  }

  // 정렬·대조
  const { offset, basis } = detectOffset(collected, existing)
  const cmp = compareOverlap(collected, existing, offset)
  const incoming = collected.map((b) => ({ ts: b.t + offset, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v }))
  const merged = mergeBars(existing, incoming) // 키움(신규) 우선
  const oldestNew = merged[0]?.ts
  const days = oldestNew ? Math.round((Date.now() / 1000 - oldestNew) / 86400) : 0

  if (!DRY_RUN) {
    const cov = coverage(merged)
    writeFileSync(symbolFile(sym), JSON.stringify({ symbol: sym, bars: packBars(merged), coverage: cov, tz: 'Asia/Seoul', backfill: { source: 'kiwoom-ka10080', at: new Date().toISOString(), offsetSec: offset } }))
  }
  report.push({
    sym,
    요청: requests,
    수집봉: collected.length,
    병합후: merged.length,
    소급일: days,
    중단사유: stop,
    오프셋: `${offset}s (${basis})`,
    대조: cmp.n ? `겹침 ${cmp.n}봉 · 불일치(>0.1%) ${cmp.badPct.toFixed(1)}% · 평균편차 ${cmp.avgDevPct.toFixed(3)}%` : '겹침 없음',
  })
  console.log(`${sym}: ${collected.length}봉(+${requests}req) → 소급 ${days}일 · ${report[report.length - 1].대조} · ${stop}`)
}

// ---- 최종 보고 ---------------------------------------------------------------
console.log('')
console.log(`총 요청 ${requestsTotal}회 · 처리 ${report.length}종목`)
const withDays = report.filter((r) => r.소급일)
if (withDays.length) {
  const ds = withDays.map((r) => r.소급일).sort((a, b) => a - b)
  console.log(`실측 소급 한도: 최소 ${ds[0]}일 · 중앙값 ${ds[Math.floor(ds.length / 2)]}일 · 최대 ${ds[ds.length - 1]}일`)
  const limited = withDays.filter((r) => String(r.중단사유).includes('소급 한도')).length
  console.log(`서버 한도로 중단: ${limited}종목 — 이 값이 키움의 실제 5분봉 보관 깊이다`)
  const cmps = report.filter((r) => r.대조 && !String(r.대조).startsWith('겹침 없음'))
  if (cmps.length) console.log(`Yahoo 대조 가능 ${cmps.length}종목 — 위 종목별 라인의 불일치율을 확인하세요 (0%대 = 두 소스 일치)`)
}
console.log('')
console.log(DRY_RUN ? 'dry-run — 저장 안 함. 결과가 좋으면 --dry-run 없이 재실행하세요.' : '병합 저장 완료 — git status 로 변경 확인 후 커밋·푸시하면 백테스트에서 사용됩니다.')
console.log('이 출력 전체를 총괄 세션에 붙여넣어 주세요 (소급 한도·정확성 실측 기록용).')
