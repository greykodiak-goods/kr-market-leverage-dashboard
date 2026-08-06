// 테마 콜 기록 트랙 — 콜 등재 + 전진 채점.
//
//   MODE=add    node scripts/theme-calls.mjs   대장에 콜 하나 추가(봉인 자동 계산)
//   MODE=score  node scripts/theme-calls.mjs   대장을 채점해 산출물을 굽는다 (tiingo 필요)
//
// 대장: public/data/theme-calls.json          — 사람이 읽는 원본(콜 목록)
// 산출: public/data/theme-calls-scored.json   — 화면이 읽는 채점 결과
//
// ── 왜 두 파일인가 ──────────────────────────────────────────────────────────
//   대장은 **손으로 쓰는 곳**(대표가 말하면 세션이 등재)이고 산출물은 **기계가 굽는 곳**이다.
//   섞으면 채점 결과를 손으로 고칠 수 있게 되고, 그 순간 이 트랙의 의미가 사라진다.
//
// ── 규칙 4(외부 API) ────────────────────────────────────────────────────────
//   미장은 tiingo. 국장(`market: 'KR'`)은 **아직 미지원이며 조용히 건너뛰지 않고 던진다** —
//   빠진 채로 "채점 완료"가 되는 것이 가장 나쁘다. 국장 콜이 처음 들어오는 커밋에서
//   KRX 정본 경로를 붙인다.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  aggregate,
  executionStats,
  scoreCall,
  sealOf,
  verifySeal,
  HORIZONS,
  THEME_CALLS_SCHEMA,
  type PriceLookup,
  type ThemeCall,
  type ThemeCallLedger,
} from '../src/features/themecalls/themeCalls'
import { fetchTiingoDaily, tiingoBarsToDaily, loadTiingoKey } from './lib/tiingo'
import type { DailyBar } from '../src/lib/history'

const root = process.env.REPO_ROOT ?? process.cwd()
const LEDGER = join(root, 'public', 'data', 'theme-calls.json')
const SCORED = join(root, 'public', 'data', 'theme-calls-scored.json')
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function readLedger(): ThemeCallLedger {
  const raw = JSON.parse(readFileSync(LEDGER, 'utf8')) as ThemeCallLedger
  if (raw.schema !== THEME_CALLS_SCHEMA)
    throw new Error(`대장 스키마 ${raw.schema}는 이 코드(${THEME_CALLS_SCHEMA})가 모른다 — 추측으로 읽지 않는다`)
  return raw
}

function writeLedger(l: ThemeCallLedger): void {
  mkdirSync(dirname(LEDGER), { recursive: true })
  writeFileSync(LEDGER, JSON.stringify(l, null, 2) + '\n', 'utf8')
}

// ============================================================================
// MODE=add — 콜 등재
// ============================================================================
//
// 환경변수로 받는다(따옴표 escaping 사고를 줄이려고 인자 대신 env):
//   CALL_ID, CALL_THESIS, CALL_SOURCE, CALL_TARGETS(="AMZN:US:primary,MSFT:US:proxy"),
//   CALL_BENCH, CALL_CONVICTION(1~5), CALL_NOTICED(YYYY-MM-DD 또는 빈값),
//   CALL_RETRO(=1이면 소급), CALL_RETRO_NOTE, CALL_ACTED(=1이면 실행함), CALL_NOT_ACTED_REASON

function envReq(name: string): string {
  const v = (process.env[name] ?? '').trim()
  if (!v) throw new Error(`${name}이 비었다 — 추측으로 채우지 않는다`)
  return v
}

function addCall(): void {
  const ledger = readLedger()
  const targets = envReq('CALL_TARGETS')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const [symbol, market, role] = s.split(':')
      if (!symbol || (market !== 'US' && market !== 'KR') || (role !== 'primary' && role !== 'proxy'))
        throw new Error(`대상 형식이 틀렸다: "${s}" — SYMBOL:US|KR:primary|proxy`)
      return { symbol, market, role } as const
    })
  if (targets.length === 0) throw new Error('대상 종목이 없다')

  const conviction = Number(envReq('CALL_CONVICTION'))
  if (!(conviction >= 1 && conviction <= 5)) throw new Error(`확신도는 1~5 (${conviction})`)

  const id = envReq('CALL_ID')
  if (ledger.calls.some((c) => c.id === id)) throw new Error(`id 중복: ${id}`)

  const base: Omit<ThemeCall, 'seal'> = {
    id,
    recordedAt: new Date().toISOString(),
    noticedAt: (process.env.CALL_NOTICED ?? '').trim() || null,
    thesis: envReq('CALL_THESIS'),
    source: envReq('CALL_SOURCE'),
    targets: [...targets],
    benchmark: envReq('CALL_BENCH'),
    conviction: conviction as 1 | 2 | 3 | 4 | 5,
    acted: process.env.CALL_ACTED === '1',
    actedAt: process.env.CALL_ACTED === '1' ? new Date().toISOString().slice(0, 10) : null,
    notActedReason: (process.env.CALL_NOT_ACTED_REASON ?? '').trim() || null,
    retroactive: process.env.CALL_RETRO === '1',
    retroactiveNote: (process.env.CALL_RETRO_NOTE ?? '').trim() || null,
  }
  if (base.retroactive && !base.retroactiveNote)
    throw new Error('소급 등재는 사유(CALL_RETRO_NOTE)를 반드시 남긴다 — 왜 점수를 안 주는지가 기록돼야 한다')

  const call: ThemeCall = { ...base, seal: sealOf(base) }
  ledger.calls.push(call)
  ledger.updatedAt = new Date().toISOString()
  writeLedger(ledger)

  console.log(`✅ 등재: ${call.id}`)
  console.log(`   기록 ${call.recordedAt} · 대상 ${call.targets.map((t) => t.symbol).join(',')} · 벤치 ${call.benchmark}`)
  console.log(`   실행 ${call.acted ? '함' : '안 함'}${call.notActedReason ? ` (${call.notActedReason})` : ''}`)
  if (call.retroactive) console.log('   ⚠️ 소급 등재 — **채점 집계에서 제외된다**')
  console.log(`   봉인 ${call.seal}`)
}

// ============================================================================
// MODE=score — 전진 채점
// ============================================================================

async function loadBars(symbol: string, token: string, from: string): Promise<DailyBar[]> {
  const res = await fetchTiingoDaily(symbol, token, { startDate: from })
  if (res.kind === 'absent') throw new Error(`${symbol}: tiingo absent — ${res.note}`)
  const { bars } = tiingoBarsToDaily(res.rows, 'total')
  if (bars.length === 0) throw new Error(`${symbol}: 봉이 0개`)
  return bars
}

async function score(): Promise<void> {
  const ledger = readLedger()
  const asOf = new Date().toISOString().slice(0, 10)

  // 국장은 아직 경로가 없다 — 조용히 건너뛰지 않고 멈춘다(규칙 4).
  const krTargets = ledger.calls.flatMap((c) => c.targets).filter((t) => t.market === 'KR')
  if (krTargets.length > 0)
    throw new Error(
      `국장 종목(${[...new Set(krTargets.map((t) => t.symbol))].join(',')})은 아직 채점 경로가 없다. ` +
        '조용히 빼고 "채점 완료"로 끝내지 않는다 — KRX 정본 경로를 붙인 뒤 다시 돌려라.',
    )

  const symbols = [...new Set([...ledger.calls.flatMap((c) => c.targets.map((t) => t.symbol)), ...ledger.calls.map((c) => c.benchmark)])]
  if (symbols.length === 0) {
    console.log('대장이 비어 있다 — 채점할 콜이 없다.')
  }

  const key = loadTiingoKey()
  if (symbols.length > 0 && !key.value) throw new Error('TIINGO_API_KEY 없음 — 빈 채점표를 굽지 않는다')

  // 가장 이른 기록일보다 넉넉히 앞에서 받는다(진입일 탐색 여유).
  const earliest = ledger.calls.reduce((m, c) => (c.recordedAt < m ? c.recordedAt : m), '9999').slice(0, 10)
  const from = earliest === '9999' ? asOf : new Date(Date.parse(earliest) - 30 * 86400e3).toISOString().slice(0, 10)

  const barsBy = new Map<string, DailyBar[]>()
  for (const s of symbols) {
    barsBy.set(s, await loadBars(s, key.value!, from))
    console.log(`· ${s}: ${barsBy.get(s)!.length}봉`)
    await sleep(200)
  }

  const px: PriceLookup = {
    openOnOrAfter: (s, date) => {
      const b = barsBy.get(s)?.find((x) => x.date >= date)
      return b ? { date: b.date, price: b.o } : null
    },
    closeOnOrBefore: (s, date) => {
      const arr = barsBy.get(s)?.filter((x) => x.date <= date)
      const b = arr?.[arr.length - 1]
      return b ? { date: b.date, price: b.c } : null
    },
  }

  const scores = ledger.calls.map((c) => scoreCall(c, px, asOf))
  const tampered = ledger.calls.filter((c) => !verifySeal(c))
  if (tampered.length > 0)
    console.log(`⚠️ 봉인 불일치 ${tampered.length}건 — ${tampered.map((c) => c.id).join(', ')} (채점에서 제외됨)`)

  const artifact = {
    schema: THEME_CALLS_SCHEMA,
    asOf: new Date().toISOString(),
    source: 'tiingo',
    basis: 'total',
    totalCalls: ledger.calls.length,
    scorableCalls: scores.filter((s) => s.scored).length,
    excluded: scores
      .filter((s) => !s.scored)
      .map((s) => ({ id: s.id, why: s.excludedWhy })),
    calls: ledger.calls.map((c) => ({
      ...c,
      score: scores.find((s) => s.id === c.id),
    })),
    aggregates: HORIZONS.map((h) => aggregate(ledger.calls, scores, h)),
    execution: HORIZONS.map((h) => ({ horizonDays: h, ...executionStats(ledger.calls, scores, h) })),
  }

  mkdirSync(dirname(SCORED), { recursive: true })
  writeFileSync(SCORED, JSON.stringify(artifact, null, 2) + '\n', 'utf8')

  console.log('')
  console.log(`✅ 채점 산출: ${SCORED}`)
  console.log(`콜 ${artifact.totalCalls}건 중 채점 대상 ${artifact.scorableCalls}건`)
  for (const e of artifact.excluded) console.log(`  · 제외 ${e.id}: ${e.why}`)
  console.log('')
  for (const a of artifact.aggregates) {
    if (a.n === 0) {
      console.log(`${a.horizonDays}일: 표본 0 — 아직 채점할 것이 없다`)
      continue
    }
    console.log(
      `${a.horizonDays}일: 표본 ${a.n}${a.lowSample ? ' [표본부족]' : ''} · 적중률 ${a.hitRatePct}% · ` +
        `평균 알파 ${a.avgAlphaPct}%p · 중앙 ${a.medianAlphaPct}%p`,
    )
  }
  console.log('')
  for (const e of artifact.execution) {
    if (e.total === 0) continue
    console.log(
      `${e.horizonDays}일 실행: ${e.acted}/${e.total} (${e.actRatePct}%) · ` +
        `맞힌 콜 중 실행 ${e.actedAmongWinnersPct ?? '—'}% · 알고도 못 산 ${e.missedWinners}건`,
    )
  }
}

async function main(): Promise<void> {
  const mode = (process.env.MODE ?? 'score').trim()
  if (mode === 'add') return addCall()
  if (mode === 'score') return score()
  throw new Error(`알 수 없는 MODE: ${mode} (add | score)`)
}

if (process.env.THEME_CALLS_RUN === '1') {
  main().catch((e) => {
    console.error(`실패: ${String(e)}`)
    process.exit(1)
  })
}
