// 종목별 투자자 순매수(수급) 이력 백필러 — ka10059 조회 전용 (규칙 2 1단계 범위).
// (2026-08-02 대표 지시 "수급·거래량 기반 투자 검토 → 해봐")
//
// 하는 일:
//   PIT 유니버스(src/features/backtest/pitUniverse.ts의 PIT_UNION) 전 종목에 대해
//   ka10059를 연속조회(cont-yn/next-key)로 **2010-01-01까지** 소급해
//   public/data/flows/<code>.json 에 저장한다.
//
// 저장 형식 (날짜 오름차순 · 부호 유지 정수):
//   { code, updatedAt, target, meta: {...},
//     rows: [{ dt:'YYYYMMDD', indNet, frgnNet, orgnNet, accTrdePrica, curPrc }] }
//
//   · indNet/frgnNet/orgnNet = 개인·외국인·기관합 **순매수 수량(단주, 부호 포함)**.
//     amt_qty_tp='2'(수량)·trde_tp='0'(순매수)·unit_tp='1'(단주)로 받은 값이다.
//   · accTrdePrica = 그 날 누적 거래대금(원), curPrc = 그 날 종가(원, 무보정).
//     ⚠️ curPrc는 지시서 스키마에 없던 필드를 **의도적으로 추가**한 것이다 — 수급강도
//        F2가 "순매수량 × 가격 ÷ 거래대금"이라 가격이 필요한데, 시세 캐시의 가격은
//        배당·분할 총수익 보정(규칙 3)이 들어가 있어 무보정 거래대금과 섞으면 종목마다
//        다른 계수가 곱해져 **횡단면 랭킹이 뒤틀린다.** 분자·분모를 같은 원천(무보정)
//        으로 맞추기 위해 ka10059 행의 cur_prc를 그대로 싣는다.
//
// 재개 가능 (EC2 워크플로 40분 제한 대응 — 여러 번 나눠 실행해도 이어진다):
//   · 파일이 있고 최신 dt가 오늘−7일 이내 **이며 meta.complete=true**면 건너뛴다.
//   · 미완(complete=false)이면 **저장된 가장 오래된 dt의 전날부터** 다시 소급해
//     이어 받는다(ka10059의 dt 파라미터가 조회 기준일이라 가능). 기존 행과 병합한다.
//   · 종목당 페이지 상한 80(≈8,000행 ≈ 32년). 상한에 걸리면 complete=false로 남겨
//     다음 실행이 이어받는다.
//
// git 커밋은 하지 않는다 — 러너/워크플로가 한다.
//
// 실행:
//   doppler run --project investing-ops --config prd -- node scripts/kiwoom-flow-backfill.mjs
//   옵션: --since=20100101  --max-pages=80  --codes=005930,000660  --dry-run  --limit=20

import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { buildSync } from 'esbuild'
import { loadSecret } from './lib/loadSecret.mjs'
import { createKiwoomClient } from './lib/kiwoom.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

// ---- 인자 -------------------------------------------------------------------
const args = new Map(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/)
    return m ? [m[1], m[2] ?? 'true'] : [a, 'true']
  }),
)
const SINCE = String(args.get('since') ?? '20100101')
const MAX_PAGES = Number(args.get('max-pages') ?? 80)
const DRY_RUN = args.get('dry-run') === 'true'
const LIMIT = args.get('limit') ? Number(args.get('limit')) : null
const ONLY = args.get('codes')?.split(',').map((s) => s.trim()).filter(Boolean) ?? null
const FRESH_DAYS = 7

const OUT_DIR = join(root, 'public', 'data', 'flows')

// ---- 유니버스 (pitUniverse.ts가 단일 원본 — 목록을 여기 복사하지 않는다) -------
// .mjs에서 .ts를 읽어야 하므로 esbuild JS API로 번들해 import한다
// (run-tests.mjs·idea-lab.mjs와 같은 방식 — CLI 경로는 플랫폼마다 깨진다).
function loadUniverse() {
  const outDir = join(root, 'node_modules', '.flow-backfill')
  rmSync(outDir, { recursive: true, force: true })
  mkdirSync(outDir, { recursive: true })
  const out = join(outDir, 'pit.mjs')
  buildSync({
    entryPoints: [join(root, 'src', 'features', 'backtest', 'pitUniverse.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile: out,
    logLevel: 'error',
  })
  return import(pathToFileURL(out).href)
}

// ---- 파싱 -------------------------------------------------------------------

/**
 * 부호 **유지** 정수 파싱. kiwoom.mjs의 numAbs는 절대값이라 순매수에 쓰면
 * 매도(음수)가 매수로 뒤집힌다 — 이 파일에서는 절대 numAbs를 쓰지 않는다.
 * "-1234" → -1234 · "+1234" → 1234 · "" → null
 */
export function numSigned(raw) {
  if (raw == null) return null
  const s = String(raw).trim().replace(/,/g, '')
  if (s === '' || s === '-' || s === '+') return null // Number('')===0 오염 방지
  const n = Number(s.replace(/^\+/, ''))
  return Number.isFinite(n) ? n : null
}

/** 'YYYYMMDD' 형식이면 그대로, 아니면 null */
export function dtOf(raw) {
  const s = String(raw ?? '').trim()
  return /^\d{8}$/.test(s) ? s : null
}

/** ka10059 응답 → 정규화 행 배열(오름차순). 날짜·핵심 수급이 없는 행은 dropped. */
export function parseFlowRows(json) {
  const arr = Array.isArray(json?.stk_invsr_orgn) ? json.stk_invsr_orgn : []
  const rows = []
  let dropped = 0
  for (const r of arr) {
    const dt = dtOf(r?.dt)
    const frgnNet = numSigned(r?.frgnr_invsr)
    const orgnNet = numSigned(r?.orgn)
    const indNet = numSigned(r?.ind_invsr)
    if (dt == null || frgnNet == null || orgnNet == null) {
      dropped++
      continue
    }
    rows.push({
      dt,
      indNet: indNet ?? 0,
      frgnNet,
      orgnNet,
      accTrdePrica: numSigned(r?.acc_trde_prica) ?? 0,
      curPrc: Math.abs(numSigned(r?.cur_prc) ?? 0), // 가격은 대비부호가 붙어 나온다 — 크기만 쓴다
    })
  }
  rows.sort((a, b) => (a.dt < b.dt ? -1 : a.dt > b.dt ? 1 : 0))
  return { rows, dropped, totalRows: arr.length }
}

/** dt 기준 병합(중복 제거 · 신규 우선) → 오름차순 */
export function mergeFlowRows(oldRows, newRows) {
  const m = new Map()
  for (const r of oldRows ?? []) if (r?.dt) m.set(r.dt, r)
  for (const r of newRows ?? []) if (r?.dt) m.set(r.dt, r)
  return [...m.values()].sort((a, b) => (a.dt < b.dt ? -1 : a.dt > b.dt ? 1 : 0))
}

/** 'YYYYMMDD' − n일 → 'YYYYMMDD' (달력일 기준 — 조회 기준일이라 휴장일이어도 무해) */
export function shiftDt(dt, days) {
  const y = Number(dt.slice(0, 4))
  const mo = Number(dt.slice(4, 6))
  const d = Number(dt.slice(6, 8))
  const t = Date.UTC(y, mo - 1, d) + days * 86400000
  return new Date(t).toISOString().slice(0, 10).replace(/-/g, '')
}

const kstToday = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10).replace(/-/g, '')

// ---- 저장소 -----------------------------------------------------------------
const fileOf = (code) => join(OUT_DIR, `${String(code).replace(/[^0-9A-Za-z]/g, '_')}.json`)

function loadStore(code) {
  try {
    const j = JSON.parse(readFileSync(fileOf(code), 'utf8'))
    return Array.isArray(j?.rows) ? j : null
  } catch {
    return null
  }
}

/** 이 종목을 이번 실행에서 건너뛸지 — 최신이 신선하고 소급도 끝났을 때만 */
export function shouldSkip(store, todayDt, sinceDt, freshDays = FRESH_DAYS) {
  if (!store?.rows?.length) return false
  const latest = store.rows[store.rows.length - 1].dt
  const oldest = store.rows[0].dt
  const freshFrom = shiftDt(todayDt, -freshDays)
  const fresh = latest >= freshFrom
  // 소급 완료 = 목표일까지 닿았거나, 서버가 더 못 준다고 확인된 경우
  const deep = oldest <= sinceDt || store.meta?.complete === true
  return fresh && deep
}

// ---- 메인 -------------------------------------------------------------------
async function main() {
  const { PIT_UNION, PIT_SOURCE_NOTE } = await loadUniverse()
  const today = kstToday()

  const key = loadSecret('KIWOOM_MOCK_APP_KEY')
  const secret = loadSecret('KIWOOM_MOCK_APP_SECRET')
  if (!key.value || !secret.value) {
    console.error(key.help ?? secret.help ?? '앱키 없음 — Doppler investing-ops 확인')
    process.exit(1)
  }
  // 대량 연속조회 — 429 실측 대응으로 호출 간격을 넉넉히 (kiwoom-backfill과 동일)
  const client = createKiwoomClient({ appKey: key.value, appSecret: secret.value, minIntervalMs: 1200 })

  let targets = ONLY ?? PIT_UNION
  if (LIMIT != null) targets = targets.slice(0, LIMIT)

  console.log(`서버: ${client.base} (모의서버 · 조회 전용 — 주문 계열 api-id 없음)`)
  console.log(PIT_SOURCE_NOTE)
  console.log(`대상 ${targets.length}종목 · 소급 목표 ${SINCE} · 페이지 상한 ${MAX_PAGES}/종목 · ${DRY_RUN ? 'dry-run(저장 안 함)' : '저장'}`)
  console.log('')

  if (!DRY_RUN) mkdirSync(OUT_DIR, { recursive: true })

  const report = []
  let requestsTotal = 0
  let skipped = 0

  for (const code of targets) {
    const store = loadStore(code)
    if (shouldSkip(store, today, SINCE)) {
      skipped++
      report.push({ code, skip: true, rows: store.rows.length, oldest: store.rows[0].dt, latest: store.rows[store.rows.length - 1].dt })
      continue
    }

    // 이어받기: 미완 파일이면 저장된 가장 오래된 dt의 전날부터 더 소급한다.
    // (완전히 새로 받는 경우엔 오늘부터. 최신 구간은 병합으로 갱신된다.)
    const existing = store?.rows ?? []
    const resumeDeep = existing.length > 0 && store?.meta?.complete !== true && existing[0].dt > SINCE
    let baseDt = resumeDeep ? shiftDt(existing[0].dt, -1) : today

    const collected = []
    let contYn = 'N'
    let nextKey = ''
    let pages = 0
    let dropped = 0
    let stop = ''
    let oldestSeen = null

    try {
      for (;;) {
        const { json, cont } = await client.request(
          '/api/dostk/stkinfo',
          'ka10059',
          { dt: baseDt, stk_cd: String(code), amt_qty_tp: '2', trde_tp: '0', unit_tp: '1' },
          { contYn, nextKey },
        )
        pages++
        requestsTotal++
        const parsed = parseFlowRows(json)
        dropped += parsed.dropped
        if (!parsed.rows.length) {
          stop = pages === 1 ? '빈 응답(첫 페이지)' : '빈 응답'
          break
        }
        collected.push(...parsed.rows)
        oldestSeen = oldestSeen == null || parsed.rows[0].dt < oldestSeen ? parsed.rows[0].dt : oldestSeen
        if (oldestSeen <= SINCE) {
          stop = '목표 소급 도달'
          break
        }
        if (cont.contYn !== 'Y' || !cont.nextKey) {
          stop = '서버 소급 한도(연속조회 끝)'
          break
        }
        contYn = 'Y'
        nextKey = cont.nextKey
        if (pages >= MAX_PAGES) {
          stop = `페이지 상한(${MAX_PAGES}) — 재실행으로 이어받기`
          break
        }
      }
    } catch (e) {
      stop = `오류: ${String(e.message).slice(0, 140)}`
    }

    const merged = mergeFlowRows(existing, collected)
    if (!merged.length) {
      report.push({ code, rows: 0, pages, stop: stop || '수집 0행' })
      console.log(`${code}: 0행 (${stop})`)
      continue
    }

    const oldest = merged[0].dt
    const latest = merged[merged.length - 1].dt
    // complete = 목표까지 닿았거나 서버가 더 못 준다고 확인됨. 상한·오류로 끊긴 건 미완.
    const complete = oldest <= SINCE || stop === '서버 소급 한도(연속조회 끝)' || stop === '빈 응답'

    if (!DRY_RUN) {
      writeFileSync(
        fileOf(code),
        JSON.stringify({
          code: String(code),
          updatedAt: new Date().toISOString(),
          target: SINCE,
          meta: {
            source: 'kiwoom-ka10059',
            server: client.base,
            unit: '순매수 수량(단주, 부호 유지) · amt_qty_tp=2 trde_tp=0 unit_tp=1',
            priceAdjusted: false,
            complete,
            stop,
            dropped,
          },
          rows: merged,
        }),
      )
    }

    report.push({ code, rows: merged.length, pages, oldest, latest, complete, stop, dropped })
    console.log(
      `${code}: ${merged.length}행 (신규 ${collected.length}·${pages}p) · ${oldest}~${latest} · ${complete ? '완료' : '미완'} · ${stop}${dropped ? ` · 파싱실패 ${dropped}행` : ''}`,
    )
  }

  // ---- 수집 현황 요약 --------------------------------------------------------
  console.log('')
  console.log(`총 요청 ${requestsTotal}회 · 처리 ${report.length}종목 (건너뜀 ${skipped})`)
  const done = report.filter((r) => !r.skip && r.rows > 0)
  const all = report.filter((r) => (r.rows ?? 0) > 0)
  const totalRows = all.reduce((s, r) => s + r.rows, 0)
  console.log(`파일 보유 ${all.length}종목 · 총 ${totalRows.toLocaleString('ko-KR')}행`)

  if (all.length) {
    const olds = all.map((r) => r.oldest).filter(Boolean).sort()
    const byYear = new Map()
    for (const o of olds) {
      const y = o.slice(0, 4)
      byYear.set(y, (byYear.get(y) ?? 0) + 1)
    }
    console.log(`최고(最古) 날짜: 최소 ${olds[0]} · 중앙값 ${olds[Math.floor(olds.length / 2)]} · 최대 ${olds[olds.length - 1]}`)
    console.log(`최고 날짜 연도 분포: ${[...byYear.entries()].sort().map(([y, n]) => `${y}:${n}종목`).join(' · ')}`)
    const incomplete = all.filter((r) => r.complete === false)
    if (incomplete.length)
      console.log(`⚠️ 미완 ${incomplete.length}종목 — 다시 실행하면 그 지점부터 이어받는다: ${incomplete.slice(0, 10).map((r) => r.code).join(', ')}${incomplete.length > 10 ? ' …' : ''}`)
    const missing = targets.filter((c) => !all.some((r) => r.code === c))
    if (missing.length) console.log(`⚠️ 수집 0행 ${missing.length}종목(상폐·미상장 등): ${missing.slice(0, 15).join(', ')}${missing.length > 15 ? ' …' : ''}`)
  }
  console.log('')
  console.log(`이번 실행에서 새로 받은 종목: ${done.length}`)
  console.log('※ 조회 전용(ka10059) — 주문·자격증명 변경 없음. git 커밋은 하지 않는다(러너 담당).')
  console.log('※ 수급 수치는 모의서버 응답 기준 [미검증-실서버 대조 전].')
}

// 테스트가 이 모듈을 import할 때는 실행되지 않는다.
if (process.env.FLOW_BACKFILL_RUN === '1' || process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error('실행 실패:', e)
    process.exit(1)
  })
}
