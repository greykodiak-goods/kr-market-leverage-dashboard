// 동적 레버리지 사다리 실측 러너 — 43차 "QQQ→QLD→TQQQ 단계 스위칭이 통하는가"
//
// ════════════════════════════════════════════════════════════════════════════
// ── 이 회차가 묻는 것 ────────────────────────────────────────────────────────
// ════════════════════════════════════════════════════════════════════════════
//
//   대표가 가져온 외부(Gemini) 대화 요약의 주장은 이랬다:
//     · QQQ 100% 보유 → 고점 대비 낙폭이 깊어질수록 QLD·TQQQ로 갈아탐
//     · **-20% 밴드**가 최적(−10%는 휩소·수수료로 손해)
//     · 닷컴 제외 2004~2026에서 **CAGR 26.5% · MDD −23.5%**
//     · QLD 100% 장기보유와 수익은 비슷한데 MDD는 절반 이하
//
//   이 러너는 그 주장을 **재현하지 않는다. 다시 잰다.** 외부 수치는 근거가 아니라
//   검증 대상이다(규칙 3). 옮겨 적는 경로는 코드에 없다.
//
// ── 🔴 재현이 애초에 불가능한 부분 — 이것부터 알고 읽어야 한다 ────────────────
//
//   TQQQ 상장일은 **2010-02-11**, QLD는 **2006-06-21**이다.
//   따라서 "2004~2026 QQQ→QLD→TQQQ 백테스트"는 **실물로는 존재할 수 없다.**
//   2004~2010 구간의 QLD·TQQQ 수익률은 세상에 없는 데이터이므로, 그 구간을 포함한
//   어떤 성적표도 **합성(synthetic)**이다. 합성은 다음을 근사할 뿐이다:
//     · 일간 배수 추종(경로 의존성) — 재현됨
//     · 운용보수(QLD 0.95% · TQQQ 0.84%) — 반영
//     · **차입비용** — [미검증] 고정 근사. 실제로는 금리를 따라가며 2000년대 초 5%대에서
//       2010년대 0%대까지 움직인다. 고정값으로 근사하면 **고금리 구간 성적이 후해진다.**
//
//   그래서 이 러너는 구간을 둘로 **분리해서** 보고한다:
//     ① **실측 구간(2010-02-11~)** — 세 ETF가 전부 실재. **판정(관문)은 여기서만 한다.**
//     ② **합성 구간(1999~)** — 닷컴·금융위기 스트레스 테스트. **참고이며 판정에 넣지 않는다.**
//
//   ⚠️ 그리고 ①은 이 전략에 **구조적으로 유리한 구간**이다. 2010~2026은 QQQ의 역사적
//      강세장이고, 이 전략은 "떨어지면 레버리지를 키운다"이므로 **모든 하락이 결국
//      회복된 구간**에서 특히 잘 나온다. 회복되지 않는 하락(일본 1990·나스닥 2000)에서
//      어떻게 되는지는 ①이 대답하지 못한다. 그것이 ②를 굳이 만든 이유다.
//
// ── 🚫 규칙 1(미래참조 금지) — 이 회차에서 지킨 것 ────────────────────────────
//   1. 고점은 **확장 러닝 맥스**(`max(close[0..i])`)다 — 전 구간 최대값이 아니다(규칙 1-5).
//   2. 신호는 봉 i 종가, 체결은 봉 i+1 **시가**(규칙 1-2).
//   3. 마지막 봉 신규 전환 금지(규칙 1-6).
//   4. 밴드·버퍼는 고정 상수다. 격자 성적으로 임계값을 되먹이지 않는다(규칙 1-5).
//   집행자: `tests/leverageladder.test.ts` 절단 불변성 + 미래 조작 불변성.
//
// ── 규칙 4(외부 API) — tiingo ────────────────────────────────────────────────
//   무료 티어는 **500 unique symbols/월 · 50 req/시간 · 1000 req/일**이다(tiingo 공표).
//   이 러너가 부르는 종목은 **4개**(QQQ·QLD·TQQQ·SPY)라 한도와 무관하다 —
//   41차 us-lab이 783종목으로 429에 막힌 것과는 다른 상황이다.
//   그래도 **성공 카운터**를 두고 하나라도 실패하면 비정상 종료한다(조용한 폴백 없음).
//
// ── 규칙 4(투자자문 아님) ────────────────────────────────────────────────────
//   레버리지 ETF는 일간 배수를 추종하므로 횡보장에서 변동성 잠식이 누적되고,
//   3배는 하루 -33.4%에서 이론상 전액 소멸한다. 이 전략은 그 위험을 **가장 깊은 낙폭
//   구간에서** 떠안는다. 아래 어떤 수치도 매수 권유가 아니다.
//
//   실행: MODE=real  node scripts/us-leverage-lab.mjs   (실측 구간 격자 — 기본)
//        MODE=synth node scripts/us-leverage-lab.mjs   (합성 스트레스 — 참고)
//        MODE=prop  node scripts/us-leverage-lab.mjs   (비중 분할 사다리 — 대표 지시 정본)
//        MODE=all   node scripts/us-leverage-lab.mjs   (전부)
//        MODE=selftest                                  (네트워크 불필요 자기검증)

import {
  runLeverageLadder,
  alignBars,
  synthLeveraged,
  synthTrackingGap,
  US_LADDER_COST,
  LADDER_BASE,
  runProportionalLadder,
  runProportionalLadderDca,
  SPEC_PROPORTIONAL,
  type DcaAllocation,
  type ProportionalParams,
  type Curve,
  type LadderParams,
  type LadderCost,
} from '../src/features/backtest/leverageLadder'
import {
  fetchTiingoDaily,
  tiingoBarsToDaily,
  checkTickerReuseGap,
  auditTiingoAdjustment,
  loadTiingoKey,
  type TiingoAdjAudit,
} from './lib/tiingo'
import type { DailyBar } from '../src/lib/history'
import { runValueRebalancing, DEFAULT_VR_PARAMS, type VRParams } from '../src/features/backtest/algoEngine'

// ============================================================================
// 0. 상수 · 전제
// ============================================================================

/** 사다리 종목 — 0칸이 평시(무레버리지)다. */
const LADDER = ['QQQ', 'QLD', 'TQQQ'] as const
/** 알파 판정 기준(규칙 5). 이 전략의 정직한 벤치는 **QQQ 단순보유**다. */
const BENCH = 'QQQ'
/** Gemini 요약이 "비슷한 수익, 절반 MDD"라고 주장한 비교 대상 */
const RIVAL = 'QLD'
/** 데이터 요청 시작일 — QQQ 상장(1999-03-10)보다 앞. */
const START_DATE = '1999-01-01'

/** 합성 레버리지 전제 — 차입비용은 [미검증] 고정 근사다. */
const SYNTH_EXPENSE: Record<string, number> = { QLD: 0.95, TQQQ: 0.84 }
const SYNTH_LEVERAGE: Record<string, number> = { QLD: 2, TQQQ: 3 }
const SYNTH_FINANCING_PCT = 2.0

/** 격자 — 밴드 폭 × 복귀 버퍼. Gemini 주장(20%)이 정말 최적인지 보려고 10~25를 판다. */
const STEP_GRID = [10, 15, 20, 25]
const BUF_GRID = [0, 3, 5]

const out: string[] = []
const log = (s = ''): void => {
  out.push(s)
  console.log(s)
}
const f1 = (n: number): string => (Number.isFinite(n) ? n.toFixed(1) : '—')
const f2 = (n: number | null): string => (n !== null && Number.isFinite(n) ? n.toFixed(2) : '—')
const pp = (n: number | null): string => (n !== null && Number.isFinite(n) ? `${n >= 0 ? '+' : ''}${n.toFixed(1)}%p` : '—')

// ============================================================================
// 1. 성과 지표 — idea-lab/us-lab `perfOf`와 **같은 정의**(자립 구현)
// ============================================================================

interface Perf {
  total: number
  cagr: number
  mdd: number
  years: number
}

function perfOf(equity: Curve, from = '', to = '9999-12-31'): Perf {
  const win = equity.filter((e) => e.date >= from && e.date <= to)
  if (win.length < 2) return { total: 0, cagr: 0, mdd: 0, years: 0 }
  const start = win[0].equity
  const end = win[win.length - 1].equity
  let peak = start
  let mdd = 0
  for (const e of win) {
    if (e.equity > peak) peak = e.equity
    else mdd = Math.min(mdd, (e.equity / peak - 1) * 100)
  }
  const years = Math.max(1 / 365, (Date.parse(win[win.length - 1].date) - Date.parse(win[0].date)) / (365.25 * 86400e3))
  const ratio = Math.max(end / start, 1e-9)
  return { total: (ratio - 1) * 100, cagr: (Math.pow(ratio, 1 / years) - 1) * 100, mdd, years }
}

const calmarOf = (p: Perf): number | null => (Math.abs(p.mdd) > 0.01 ? p.cagr / Math.abs(p.mdd) : null)

/** 단순보유 곡선 — 전략과 **같은 비용 전제**로 만든다(비교 가능성). */
function buyHoldCurve(bars: readonly DailyBar[], cost: LadderCost): Curve {
  const side = (cost.feePct + cost.slippagePct) / 100
  const shares = (cost.initialCapital * (1 - side)) / bars[0].o
  return bars.map((b) => ({ date: b.date, equity: shares * b.c }))
}

// ============================================================================
// 2. 시세 로드 — 규칙 4 게이트
// ============================================================================

interface Loaded {
  bars: DailyBar[]
  audit: TiingoAdjAudit
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function loadTicker(symbol: string, token: string): Promise<Loaded> {
  const res = await fetchTiingoDaily(symbol, token, { startDate: START_DATE })
  if (res.kind === 'absent') throw new Error(`${symbol}: tiingo absent — ${res.note}`)
  const gap = checkTickerReuseGap(res.rows)
  if (!gap.ok) throw new Error(`${symbol}: ${gap.reason}`)
  const { bars, dropped } = tiingoBarsToDaily(res.rows, 'total')
  if (bars.length === 0) throw new Error(`${symbol}: OHLC 완전한 봉이 0개 (버린 행 ${dropped})`)
  return { bars, audit: res.audit ?? auditTiingoAdjustment(res.rows) }
}

/**
 * 배당·분할 기준 게이트. 전략과 벤치가 **같은 기준**이 아니면 알파가 한쪽으로 기운다
 * (2026-08-03 국장 40차에서 실제로 제거한 결함). 판정 불가면 명시 플래그 없이는 중단.
 */
function basisGate(audit: TiingoAdjAudit, symbol: string): string {
  if (audit.verdict === 'total') return `✅ ${symbol} 보정 기준: **분할+배당(총수익)** — ${audit.note}`
  if (audit.verdict === 'price')
    throw new Error(
      `⛔ ${symbol} adj*가 배당을 반영하지 않는다(${audit.note}). 사다리 종목과 벤치의 기준이 어긋나 ` +
        '알파가 거짓이 된다. 중단한다.',
    )
  const msg = `${symbol} 보정 기준 **판정 불가** [미검증] — ${audit.note}`
  if (process.env.US_TIINGO_ALLOW_UNVERIFIED !== '1')
    throw new Error(`⛔ ${msg}. 그래도 돌리려면 US_TIINGO_ALLOW_UNVERIFIED=1을 명시하라.`)
  return `⚠️ [미검증] ${msg} — 명시 플래그로 진행. **이 회차 수치에 [미검증]을 유지하라.**`
}

// ============================================================================
// 3. 격자 실행 · 채점
// ============================================================================

interface Row {
  key: string
  stepPct: number
  bufPct: number
  perf: Perf
  calmar: number | null
  alphaVsBench: number | null
  alphaFirstHalf: number | null
  alphaSecondHalf: number | null
  switches: number
  daysInStep: number[]
  pass: boolean
  why: string
}

function splitDate(equity: Curve): string {
  const t0 = Date.parse(equity[0].date)
  const t1 = Date.parse(equity[equity.length - 1].date)
  return new Date((t0 + t1) / 2).toISOString().slice(0, 10)
}

function alphaOf(strat: Curve, bench: Curve, from: string, to: string): number | null {
  const s = perfOf(strat, from, to)
  const b = perfOf(bench, from, to)
  if (s.years < 0.5 || b.years < 0.5) return null
  return s.cagr - b.cagr
}

function runGrid(
  base: readonly DailyBar[],
  assets: ReadonlyMap<string, readonly DailyBar[]>,
  benchCurve: Curve,
  cost: LadderCost,
): Row[] {
  const rows: Row[] = []
  const mid = splitDate(benchCurve)
  const benchPerf = perfOf(benchCurve)
  const benchCalmar = calmarOf(benchPerf)

  for (const stepPct of STEP_GRID) {
    for (const bufPct of BUF_GRID) {
      const p: LadderParams = { stepPct, bufPct, ladder: LADDER }
      const run = runLeverageLadder(base, assets, p, cost)
      const perf = perfOf(run.equity)
      const calmar = calmarOf(perf)
      const a = alphaOf(run.equity, benchCurve, '', '9999-12-31')
      const a1 = alphaOf(run.equity, benchCurve, '', mid)
      const a2 = alphaOf(run.equity, benchCurve, mid, '9999-12-31')

      // ── 관문 (규칙 5) ────────────────────────────────────────────────────
      //   ① 전 구간 알파 > 0            — 벤치(QQQ 단순보유)를 이겼는가
      //   ② 칼마가 벤치보다 높다        — 낙폭 대비로도 나은가(수익만 크면 안 된다)
      //   ③ 전·후반 **둘 다** 알파 > 0  — 한 구간 운이 아닌가(구간 분할 검증)
      const g1 = a !== null && a > 0
      const g2 = calmar !== null && benchCalmar !== null && calmar > benchCalmar
      const g3 = a1 !== null && a2 !== null && a1 > 0 && a2 > 0
      const why = [g1 ? '' : '알파≤0', g2 ? '' : '칼마≤벤치', g3 ? '' : '반쪽구간'].filter(Boolean).join('·')

      rows.push({
        key: `step${stepPct}/buf${bufPct}`,
        stepPct,
        bufPct,
        perf,
        calmar,
        alphaVsBench: a,
        alphaFirstHalf: a1,
        alphaSecondHalf: a2,
        switches: run.switches.length,
        daysInStep: run.daysInStep,
        pass: g1 && g2 && g3,
        why: why || '통과',
      })
    }
  }
  return rows
}

function table(rows: Row[], totalDays: number): void {
  log('')
  log('| 변형 | 총수익 | CAGR | MDD | 칼마 | 알파(전구간) | 전반 | 후반 | 전환 | QQQ/QLD/TQQQ 보유일 | 관문 |')
  log('|---|---|---|---|---|---|---|---|---|---|---|')
  for (const r of rows) {
    const share = r.daysInStep.map((d) => `${Math.round((d / totalDays) * 100)}%`).join('/')
    log(
      `| \`${r.key}\` | ${f1(r.perf.total)}% | ${f1(r.perf.cagr)}% | ${f1(r.perf.mdd)}% | ${f2(r.calmar)} | ` +
        `${pp(r.alphaVsBench)} | ${pp(r.alphaFirstHalf)} | ${pp(r.alphaSecondHalf)} | ${r.switches} | ${share} | ` +
        `${r.pass ? '✅ 통과' : `❌ ${r.why}`} |`,
    )
  }
}

function benchLine(label: string, curve: Curve): void {
  const p = perfOf(curve)
  log(`| ${label} | ${f1(p.total)}% | ${f1(p.cagr)}% | ${f1(p.mdd)}% | ${f2(calmarOf(p))} |`)
}

// ============================================================================
// 4. MODE=real — 실측 구간 (판정)
// ============================================================================

async function real(token: string): Promise<void> {
  log('# MODE=real — 실측 구간 격자 (세 ETF가 전부 실재하는 구간에서만 판정)')
  log('')

  const loaded = new Map<string, Loaded>()
  let ok = 0
  for (const sym of [...LADDER]) {
    loaded.set(sym, await loadTicker(sym, token))
    ok++
    await sleep(200)
  }
  if (ok !== LADDER.length) throw new Error(`시세 로드 ${ok}/${LADDER.length} — 전량 성공이 아니면 돌지 않는다`)

  // 배당 기준 게이트는 **사다리 전 종목**에 건다 — 하나라도 기준이 다르면 비교가 거짓이다.
  for (const sym of LADDER) log(basisGate(loaded.get(sym)!.audit, sym))
  log('')

  for (const sym of LADDER) {
    const b = loaded.get(sym)!.bars
    log(`· ${sym}: ${b.length}봉 (${b[0].date} ~ ${b[b.length - 1].date})`)
  }

  const aligned = alignBars(new Map([...loaded].map(([s, v]) => [s, v.bars])))
  const base = aligned.get(LADDER_BASE)!
  if (base.length < 500) throw new Error(`교집합 구간이 ${base.length}봉뿐이다 — 판정할 표본이 아니다`)
  log('')
  log(
    `**실측 판정 구간: ${base[0].date} ~ ${base[base.length - 1].date}** (${base.length}봉) — ` +
      `TQQQ 상장(2010-02-11)이 이 구간의 시작을 정한다.`,
  )
  log('')
  log(
    '⚠️ 이 구간은 전략에 **구조적으로 유리하다** — QQQ의 역사적 강세장이고, 모든 하락이 결국 ' +
      '회복됐다. "떨어지면 배수를 키운다"는 전략은 그런 구간에서 잘 나올 수밖에 없다. ' +
      '회복되지 않는 하락에서의 거동은 이 표가 **대답하지 못한다**(MODE=synth 참조).',
  )

  const benchCurve = buyHoldCurve(aligned.get(BENCH)!, US_LADDER_COST)
  const rows = runGrid(base, aligned, benchCurve, US_LADDER_COST)

  log('')
  log('## 기준선 (같은 구간 · 같은 비용 전제로 다시 잰 값 — 옮겨 적지 않는다)')
  log('')
  log('| 기준선 | 총수익 | CAGR | MDD | 칼마 |')
  log('|---|---|---|---|---|')
  benchLine(`${BENCH} 단순보유 (벤치)`, benchCurve)
  benchLine(`${RIVAL} 단순보유 (Gemini 비교 대상)`, buyHoldCurve(aligned.get(RIVAL)!, US_LADDER_COST))
  benchLine('TQQQ 단순보유', buyHoldCurve(aligned.get('TQQQ')!, US_LADDER_COST))

  log('')
  log('## 격자 — 밴드 폭 × 복귀 버퍼')
  table(rows, base.length)

  verdict(rows, aligned, base.length)
}

function verdict(rows: Row[], aligned: Map<string, DailyBar[]>, totalDays: number): void {
  const passed = rows.filter((r) => r.pass)
  log('')
  log('## 판정')
  log('')
  log(`관문 통과: **${passed.length} / ${rows.length}**`)
  if (passed.length === 0) {
    log('')
    log('❌ **통과 0.** 이 계열은 여기서 끝낸다 — "가장 덜 나쁜 변형"을 승격시키는 경로는 없다.')
    return
  }
  const best = [...passed].sort((a, b) => (b.calmar ?? -9) - (a.calmar ?? -9))[0]
  log('')
  log(`칼마 1위 통과 변형: \`${best.key}\` — CAGR ${f1(best.perf.cagr)}% · MDD ${f1(best.perf.mdd)}% · 칼마 ${f2(best.calmar)}`)

  // Gemini 주장 대조 — 옮겨 적지 않고 **우리 수치와 나란히** 둔다.
  const rival = perfOf(buyHoldCurve(aligned.get(RIVAL)!, US_LADDER_COST))
  log('')
  log('### 외부(Gemini) 주장 대조')
  log('')
  log('| 항목 | 외부 주장 | 우리 실측 | 판정 |')
  log('|---|---|---|---|')
  log(`| 구간 | 2004~2026 | ${aligned.get(BENCH)![0].date}~ | ❌ 2004~2010은 QLD·TQQQ가 존재하지 않아 재현 불가 |`)
  log(`| CAGR | 26.5% | ${f1(best.perf.cagr)}% | ${best.perf.cagr >= 25 ? '≈ 근접' : '미달'} |`)
  log(`| MDD | -23.5% | ${f1(best.perf.mdd)}% | ${best.perf.mdd <= -30 ? '주장보다 훨씬 깊다' : '≈ 근접'} |`)
  log(
    `| "${RIVAL} 대비 MDD 절반" | 절반 이하 | ${RIVAL} MDD ${f1(rival.mdd)}% vs 전략 ${f1(best.perf.mdd)}% | ` +
      `${Math.abs(best.perf.mdd) <= Math.abs(rival.mdd) / 2 ? '✅ 성립' : '❌ 절반 아님'} |`,
  )
  const stepWinners = [...new Set(passed.map((r) => r.stepPct))].sort((a, b) => a - b)
  log(
    `| "-20% 밴드가 최적" | 20% | 통과 밴드 ${stepWinners.join('·')}% · 칼마 1위 ${best.stepPct}% | ` +
      `${best.stepPct === 20 ? '✅ 일치' : '❌ 다른 밴드가 낫다'} |`,
  )
  log('')
  log(
    `보유일 분포(칼마 1위): QQQ ${Math.round((best.daysInStep[0] / totalDays) * 100)}% · ` +
      `QLD ${Math.round((best.daysInStep[1] / totalDays) * 100)}% · TQQQ ${Math.round((best.daysInStep[2] / totalDays) * 100)}%`,
  )
}

// ============================================================================
// 5. MODE=synth — 합성 스트레스 (참고 · 판정 아님)
// ============================================================================

async function synth(token: string): Promise<void> {
  log('')
  log('# MODE=synth — 닷컴·금융위기 스트레스 [합성 · 판정 근거 아님]')
  log('')
  log(
    '⚠️ 이 절의 모든 수치는 **합성**이다. 2010-02 이전 QLD·TQQQ는 존재하지 않으므로 ' +
      'QQQ 일간 수익률에 배수를 먹이고 운용보수·차입비용을 뺀 근사다. ' +
      `차입비용은 **연 ${SYNTH_FINANCING_PCT}% 고정 [미검증]** — 실제로는 금리를 따라 움직이며, ` +
      '2000년대 초 고금리 구간의 성적이 이 근사에서 **후하게** 나온다.',
  )

  const qqq = await loadTicker(BENCH, token)
  await sleep(200)
  const realQld = await loadTicker(RIVAL, token)
  await sleep(200)
  const realTqqq = await loadTicker('TQQQ', token)

  const mk = (sym: string): DailyBar[] =>
    synthLeveraged(qqq.bars, {
      leverage: SYNTH_LEVERAGE[sym],
      expenseAnnualPct: SYNTH_EXPENSE[sym],
      financingAnnualPct: SYNTH_FINANCING_PCT,
    })

  // ── 자기검증: 겹치는 구간에서 합성이 실물을 얼마나 따라가나 (규칙 4) ──────
  const gapQld = synthTrackingGap(realQld.bars, mk(RIVAL))
  const gapTqqq = synthTrackingGap(realTqqq.bars, mk('TQQQ'))
  log('')
  log('## 합성 자기검증 — 실물이 존재하는 구간에서 대조')
  log('')
  log('| 종목 | 합성 − 실물 CAGR 괴리 | 읽는 법 |')
  log('|---|---|---|')
  log(`| ${RIVAL} | ${pp(gapQld)} | 양수면 합성이 실물보다 **후하다** |`)
  log(`| TQQQ | ${pp(gapTqqq)} | 양수면 합성이 실물보다 **후하다** |`)

  const worst = Math.max(Math.abs(gapQld ?? 0), Math.abs(gapTqqq ?? 0))
  if (gapQld === null || gapTqqq === null) {
    log('')
    log('⚠️ 괴리를 잴 표본이 부족하다 — 아래 합성 수치의 신뢰도를 판단할 근거가 없다.')
  } else if (worst > 3) {
    log('')
    log(
      `⚠️ 괴리가 **${f1(worst)}%p**로 크다. 아래 합성 구간 수치는 방향성 참고로만 읽고 ` +
        '숫자 자체를 인용하지 마라.',
    )
  } else {
    log('')
    log(`합성이 실물을 ${f1(worst)}%p 이내로 따라간다 — 방향성 참고로 쓸 만하다(숫자는 여전히 근사다).`)
  }

  // ── 합성 전 구간 ─────────────────────────────────────────────────────────
  const assets = alignBars(
    new Map<string, DailyBar[]>([
      ['QQQ', qqq.bars],
      ['QLD', mk(RIVAL)],
      ['TQQQ', mk('TQQQ')],
    ]),
  )
  const base = assets.get(LADDER_BASE)!
  const bench = buyHoldCurve(assets.get(BENCH)!, US_LADDER_COST)
  log('')
  log(`**합성 구간: ${base[0].date} ~ ${base[base.length - 1].date}** (${base.length}봉)`)

  const rows = runGrid(base, assets, bench, US_LADDER_COST)
  log('')
  log('## 합성 전 구간 격자 [참고]')
  table(rows, base.length)

  // ── 위기 구간 절편 ───────────────────────────────────────────────────────
  log('')
  log('## 위기 구간별 낙폭 [합성 · 이 전략이 실제로 시험받는 곳]')
  log('')
  const crises: [string, string, string][] = [
    ['닷컴 붕괴', '2000-03-01', '2002-10-31'],
    ['금융위기', '2007-10-01', '2009-03-31'],
    ['코로나 급락', '2020-02-01', '2020-04-30'],
    ['2022 긴축', '2022-01-01', '2022-12-31'],
  ]
  log('| 구간 | 기간 | QQQ 단순보유 MDD | 사다리(step20/buf3) MDD | 사다리 총수익 |')
  log('|---|---|---|---|---|')
  const p20: LadderParams = { stepPct: 20, bufPct: 3, ladder: LADDER }
  const run20 = runLeverageLadder(base, assets, p20, US_LADDER_COST)
  for (const [name, from, to] of crises) {
    const bq = perfOf(bench, from, to)
    const bl = perfOf(run20.equity, from, to)
    if (bq.years < 0.05) {
      log(`| ${name} | ${from}~${to} | — | — | 구간 데이터 없음 |`)
      continue
    }
    log(`| ${name} | ${from}~${to} | ${f1(bq.mdd)}% | ${f1(bl.mdd)}% | ${f1(bl.total)}% |`)
  }
  log('')
  log(
    '⚠️ 닷컴 행이 이 전략의 급소다 — 나스닥이 고점 대비 -78% 빠졌고 **회복까지 15년**이 걸렸다. ' +
      '"떨어지면 배수를 키운다"는 규칙은 그 구간에서 가장 깊은 칸(TQQQ)을 **가장 오래** 들고 있게 만든다.',
  )
}


// ============================================================================
// 5.5 MODE=prop — 비중 분할 사다리 (2026-08-05 대표 지시 정본)
// ============================================================================
//
//   평시 QQQ 100% → -10%에서 절반을 QLD로 → -20%에서 남은 QQQ 전부를 TQQQ로
//   → +10% 오를 때마다 레버리지의 10%를 QQQ로 되돌림 → 신고가 회복 시 QQQ 100% 초기화
//
// 앞의 `runLeverageLadder`(한 칸=한 종목 100%)와 **다른 전략**이다. 섞어 읽지 마라 —
// 100% TQQQ는 3배를 통째로 맞지만 QLD 50 / TQQQ 50은 실효 2.5배라 낙폭 성격이 다르다.

/** 격자 — 지시값 `(10,20)/step10/frac10`이 1행에 오도록 배열 순서를 잡는다. */
const PROP_BANDS: [number, number][] = [
  [10, 20],
  [10, 25],
  [15, 30],
]
const PROP_TP_STEP = [10, 5, 15]
const PROP_TP_FRAC = [10, 25]

interface PropRow {
  key: string
  spec: boolean
  perf: Perf
  calmar: number | null
  alpha: number | null
  a1: number | null
  a2: number | null
  trades: number
  avgWeights: [number, number, number]
  leveredPct: number
  pass: boolean
  why: string
}

function runPropGrid(
  base: readonly DailyBar[],
  assets: ReadonlyMap<string, readonly DailyBar[]>,
  bench: Curve,
  cost: typeof US_LADDER_COST,
): PropRow[] {
  const rows: PropRow[] = []
  const mid = splitDate(bench)
  const benchCalmar = calmarOf(perfOf(bench))
  for (const [b1, b2] of PROP_BANDS) {
    for (const step of PROP_TP_STEP) {
      for (const frac of PROP_TP_FRAC) {
        const p: ProportionalParams = {
          band1Pct: b1,
          band2Pct: b2,
          stage1SwapPct: 50,
          tpStepPct: step,
          tpFracPct: frac,
        }
        const run = runProportionalLadder(base, assets, p, cost)
        const perf = perfOf(run.equity)
        const calmar = calmarOf(perf)
        const alpha = alphaOf(run.equity, bench, '', '9999-12-31')
        const a1 = alphaOf(run.equity, bench, '', mid)
        const a2 = alphaOf(run.equity, bench, mid, '9999-12-31')
        const g1 = alpha !== null && alpha > 0
        const g2 = calmar !== null && benchCalmar !== null && calmar > benchCalmar
        const g3 = a1 !== null && a2 !== null && a1 > 0 && a2 > 0
        const why = [g1 ? '' : '알파≤0', g2 ? '' : '칼마≤벤치', g3 ? '' : '반쪽구간'].filter(Boolean).join('·')
        const isSpec =
          b1 === SPEC_PROPORTIONAL.band1Pct &&
          b2 === SPEC_PROPORTIONAL.band2Pct &&
          step === SPEC_PROPORTIONAL.tpStepPct &&
          frac === SPEC_PROPORTIONAL.tpFracPct
        rows.push({
          key: `밴드${b1}/${b2} · 익절 +${step}%마다 ${frac}%`,
          spec: isSpec,
          perf,
          calmar,
          alpha,
          a1,
          a2,
          trades: run.trades,
          avgWeights: run.avgWeights,
          leveredPct: (run.daysLevered / base.length) * 100,
          pass: g1 && g2 && g3,
          why: why || '통과',
        })
      }
    }
  }
  return rows
}

function propTable(rows: PropRow[]): void {
  log('')
  log('| 변형 | 총수익 | CAGR | MDD | 칼마 | 알파 | 전반 | 후반 | 매매 | 평균비중 QQQ/QLD/TQQQ | 레버일% | 관문 |')
  log('|---|---|---|---|---|---|---|---|---|---|---|---|')
  for (const r of rows) {
    const w = r.avgWeights.map((x) => x.toFixed(0)).join('/')
    log(
      `| ${r.spec ? '**⭐ ' : '`'}${r.key}${r.spec ? ' (지시값)**' : '`'} | ${f1(r.perf.total)}% | ${f1(r.perf.cagr)}% | ` +
        `${f1(r.perf.mdd)}% | ${f2(r.calmar)} | ${pp(r.alpha)} | ${pp(r.a1)} | ${pp(r.a2)} | ${r.trades} | ${w} | ` +
        `${f1(r.leveredPct)}% | ${r.pass ? '✅ 통과' : `❌ ${r.why}`} |`,
    )
  }
}

async function prop(token: string): Promise<void> {
  log('')
  log('# MODE=prop — 비중 분할 사다리 (대표 지시 정본)')
  log('')
  log('평시 QQQ 100% → **-10%**에서 절반을 QLD로 → **-20%**에서 남은 QQQ 전부를 TQQQ로')
  log('→ **+10% 오를 때마다** 레버리지의 10%를 QQQ로 되돌림 → **신고가 회복 시** QQQ 100%로 초기화')
  log('')
  log(
    '⚠️ 앞 절(`MODE=real`)의 사다리와는 **다른 전략**이다. 저쪽은 한 칸에 한 종목 100%였고 ' +
      '이쪽은 비중을 섞는다 — QLD 50 / TQQQ 50은 실효 2.5배라 100% TQQQ와 낙폭 성격이 다르다.',
  )

  const loaded = new Map<string, Loaded>()
  for (const sym of [...LADDER]) {
    loaded.set(sym, await loadTicker(sym, token))
    await sleep(200)
  }
  for (const sym of LADDER) log(basisGate(loaded.get(sym)!.audit, sym))

  // ── 실측 구간 (판정) ──────────────────────────────────────────────────────
  const aligned = alignBars(new Map([...loaded].map(([s, v]) => [s, v.bars])))
  const base = aligned.get(LADDER_BASE)!
  const bench = buyHoldCurve(aligned.get(BENCH)!, US_LADDER_COST)
  log('')
  log(`**실측 판정 구간: ${base[0].date} ~ ${base[base.length - 1].date}** (${base.length}봉)`)
  log('')
  log('## 기준선')
  log('')
  log('| 기준선 | 총수익 | CAGR | MDD | 칼마 |')
  log('|---|---|---|---|---|')
  benchLine(`${BENCH} 단순보유 (벤치)`, bench)
  benchLine(`${RIVAL} 단순보유`, buyHoldCurve(aligned.get(RIVAL)!, US_LADDER_COST))
  benchLine('TQQQ 단순보유', buyHoldCurve(aligned.get('TQQQ')!, US_LADDER_COST))

  const rows = runPropGrid(base, aligned, bench, US_LADDER_COST)
  log('')
  log('## 실측 격자 — 밴드 × 익절 방아쇠 × 익절 규모')
  propTable(rows)

  const passed = rows.filter((r) => r.pass)
  const specRow = rows.find((r) => r.spec)!
  log('')
  log(`관문 통과: **${passed.length} / ${rows.length}**`)
  log('')
  log(
    `**지시값 그대로(밴드 10/20 · 익절 +10%마다 10%)**: CAGR ${f1(specRow.perf.cagr)}% · ` +
      `MDD ${f1(specRow.perf.mdd)}% · 칼마 ${f2(specRow.calmar)} · 알파 ${pp(specRow.alpha)} → ` +
      `${specRow.pass ? '✅ 통과' : `❌ ${specRow.why}`}`,
  )
  if (passed.length === 0) {
    log('')
    log('❌ **통과 0.** "가장 덜 나쁜 변형"을 승격시키는 경로는 없다.')
  }

  // ── 합성 스트레스 (참고) ──────────────────────────────────────────────────
  const mk = (sym: string): DailyBar[] =>
    synthLeveraged(loaded.get(BENCH)!.bars, {
      leverage: SYNTH_LEVERAGE[sym],
      expenseAnnualPct: SYNTH_EXPENSE[sym],
      financingAnnualPct: SYNTH_FINANCING_PCT,
    })
  const sAssets = alignBars(
    new Map<string, DailyBar[]>([
      ['QQQ', loaded.get(BENCH)!.bars],
      ['QLD', mk(RIVAL)],
      ['TQQQ', mk('TQQQ')],
    ]),
  )
  const sBase = sAssets.get(LADDER_BASE)!
  const sBench = buyHoldCurve(sAssets.get(BENCH)!, US_LADDER_COST)
  log('')
  log(`## 합성 스트레스 [판정 근거 아님] — ${sBase[0].date} ~ ${sBase[sBase.length - 1].date}`)
  log('')
  log(`차입비용 연 ${SYNTH_FINANCING_PCT}% 고정 [미검증] — 고금리 구간 성적이 후하게 나온다.`)
  propTable(runPropGrid(sBase, sAssets, sBench, US_LADDER_COST))

  log('')
  log('### 위기 구간별 — 지시값 변형')
  log('')
  const specRun = runProportionalLadder(sBase, sAssets, SPEC_PROPORTIONAL, US_LADDER_COST)
  log('| 구간 | 기간 | QQQ 단순보유 MDD | 지시값 사다리 MDD | 사다리 총수익 |')
  log('|---|---|---|---|---|')
  for (const [name, from, to] of [
    ['닷컴 붕괴', '2000-03-01', '2002-10-31'],
    ['금융위기', '2007-10-01', '2009-03-31'],
    ['코로나 급락', '2020-02-01', '2020-04-30'],
    ['2022 긴축', '2022-01-01', '2022-12-31'],
  ] as [string, string, string][]) {
    const bq = perfOf(sBench, from, to)
    const bl = perfOf(specRun.equity, from, to)
    if (bq.years < 0.05) {
      log(`| ${name} | ${from}~${to} | — | — | 구간 데이터 없음 |`)
      continue
    }
    log(`| ${name} | ${from}~${to} | ${f1(bq.mdd)}% | ${f1(bl.mdd)}% | ${f1(bl.total)}% |`)
  }
}


// ============================================================================
// 5.6 MODE=sweep — "10%"를 10~30까지 훑는다 (2026-08-05 대표 지시)
// ============================================================================
//
//   지시 정본에는 10%가 **세 군데** 나온다. 어느 것을 물으신 건지 지시문에서
//   하나로 좁혀지지 않으므로 **셋 다 각각** 훑고, 마지막에 전면 격자로 조합을 본다.
//     A) 1단 진입 밴드(-10%)   — 2단은 비율을 유지해 2배(-20%)로 따라간다
//     B) 익절 방아쇠(+10%마다)
//     C) 익절 규모(레버리지의 10%)
//     D) 전면 격자 — 위 셋 + 2단 밴드까지 동시에
//
// ⚠️ **다중검정 경고(규칙 5)**: 수백 변형을 돌려 1등을 고르는 것은 그 자체로 과최적화다.
//    1등의 성적은 "이 구간에서 가장 운이 좋았던 조합"이고 미래 성적의 기댓값이 아니다.
//    그래서 이 절은 **1등 숫자보다 축을 따라가는 추세**를 보는 데 쓴다 —
//    이웃한 파라미터에서 성적이 급변하면 그 봉우리는 노이즈이고, 완만하면 실체가 있다.
//    통과 판정은 여전히 관문 3개(알파·칼마·전후반)로만 한다.

interface SweepRow {
  label: string
  p: ProportionalParams
  perf: Perf
  calmar: number | null
  alpha: number | null
  a1: number | null
  a2: number | null
  trades: number
  pass: boolean
}

function scoreOne(
  label: string,
  p: ProportionalParams,
  base: readonly DailyBar[],
  assets: ReadonlyMap<string, readonly DailyBar[]>,
  bench: Curve,
  mid: string,
  benchCalmar: number | null,
): SweepRow {
  const run = runProportionalLadder(base, assets, p, US_LADDER_COST)
  const perf = perfOf(run.equity)
  const calmar = calmarOf(perf)
  const alpha = alphaOf(run.equity, bench, '', '9999-12-31')
  const a1 = alphaOf(run.equity, bench, '', mid)
  const a2 = alphaOf(run.equity, bench, mid, '9999-12-31')
  const pass =
    alpha !== null && alpha > 0 &&
    calmar !== null && benchCalmar !== null && calmar > benchCalmar &&
    a1 !== null && a2 !== null && a1 > 0 && a2 > 0
  return { label, p, perf, calmar, alpha, a1, a2, trades: run.trades, pass }
}

function sweepTable(title: string, rows: SweepRow[], note: string): void {
  log('')
  log(`### ${title}`)
  log('')
  log(note)
  log('')
  log('| 값 | 총수익 | CAGR | MDD | 칼마 | 알파 | 전반 | 후반 | 매매 | 관문 |')
  log('|---|---|---|---|---|---|---|---|---|---|')
  const bestCalmar = Math.max(...rows.map((r) => r.calmar ?? -9))
  const bestCagr = Math.max(...rows.map((r) => r.perf.cagr))
  for (const r of rows) {
    const mk = (r.calmar ?? -9) === bestCalmar ? ' 🥇칼마' : r.perf.cagr === bestCagr ? ' 🥇수익' : ''
    log(
      `| ${r.label}${mk} | ${f1(r.perf.total)}% | ${f1(r.perf.cagr)}% | ${f1(r.perf.mdd)}% | ${f2(r.calmar)} | ` +
        `${pp(r.alpha)} | ${pp(r.a1)} | ${pp(r.a2)} | ${r.trades} | ${r.pass ? '✅' : '❌'} |`,
    )
  }
}

function topTable(title: string, rows: SweepRow[], by: (r: SweepRow) => number, n: number): void {
  const sorted = [...rows].sort((a, b) => by(b) - by(a)).slice(0, n)
  log('')
  log(`### ${title}`)
  log('')
  log('| 순위 | 밴드1 | 밴드2 | 익절방아쇠 | 익절규모 | CAGR | MDD | 칼마 | 알파 | 전반 | 후반 | 관문 |')
  log('|---|---|---|---|---|---|---|---|---|---|---|---|')
  sorted.forEach((r, i) => {
    log(
      `| ${i + 1} | -${r.p.band1Pct}% | -${r.p.band2Pct}% | +${r.p.tpStepPct}% | ${r.p.tpFracPct}% | ` +
        `${f1(r.perf.cagr)}% | ${f1(r.perf.mdd)}% | ${f2(r.calmar)} | ${pp(r.alpha)} | ${pp(r.a1)} | ${pp(r.a2)} | ` +
        `${r.pass ? '✅ 통과' : '❌'} |`,
    )
  })
}

async function sweepMode(token: string): Promise<void> {
  log('')
  log('# MODE=sweep — "10%"를 10~30까지 훑기 (대표 지시)')
  log('')
  log(
    '지시 정본의 10%는 **세 군데**(진입 밴드 · 익절 방아쇠 · 익절 규모)에 나온다. ' +
      '어느 것인지 지시문에서 좁혀지지 않아 **셋 다 각각** 훑고 전면 격자로 조합까지 본다.',
  )
  log('')
  log(
    '⚠️ **다중검정 경고(규칙 5)** — 수백 변형 중 1등을 고르는 것은 그 자체로 과최적화다. ' +
      '1등 숫자는 "이 구간에서 가장 운이 좋았던 조합"이지 미래 기댓값이 아니다. ' +
      '**축을 따라가는 추세**로 읽어라 — 이웃 값에서 성적이 급변하면 노이즈, 완만하면 실체가 있다.',
  )

  const loaded = new Map<string, Loaded>()
  for (const sym of [...LADDER]) {
    loaded.set(sym, await loadTicker(sym, token))
    await sleep(200)
  }
  for (const sym of LADDER) log(basisGate(loaded.get(sym)!.audit, sym))

  const aligned = alignBars(new Map([...loaded].map(([s, v]) => [s, v.bars])))
  const base = aligned.get(LADDER_BASE)!
  const bench = buyHoldCurve(aligned.get(BENCH)!, US_LADDER_COST)
  const benchPerf = perfOf(bench)
  const benchCalmar = calmarOf(benchPerf)
  const mid = splitDate(bench)

  log('')
  log(`**실측 구간: ${base[0].date} ~ ${base[base.length - 1].date}** (${base.length}봉)`)
  log('')
  log(
    `**벤치(QQQ 단순보유): CAGR ${f1(benchPerf.cagr)}% · MDD ${f1(benchPerf.mdd)}% · 칼마 ${f2(benchCalmar)}** ` +
      '— 칼마 관문은 이 값을 넘어야 한다.',
  )

  const S = (l: string, p: ProportionalParams): SweepRow => scoreOne(l, p, base, aligned, bench, mid, benchCalmar)
  const base10 = SPEC_PROPORTIONAL

  // ── A) 1단 진입 밴드 ──────────────────────────────────────────────────────
  const A: SweepRow[] = []
  for (let d = 10; d <= 30; d++)
    A.push(S(`-${d}% (2단 -${d * 2}%)`, { ...base10, band1Pct: d, band2Pct: d * 2 }))
  sweepTable(
    'A) 1단 진입 밴드 -10% → -30%',
    A,
    '2단은 비율을 유지해 1단의 2배로 따라간다. 익절은 지시값 고정(+10%마다 10%).',
  )

  // ── B) 익절 방아쇠 ────────────────────────────────────────────────────────
  const B: SweepRow[] = []
  for (let t = 10; t <= 30; t++) B.push(S(`+${t}%마다`, { ...base10, tpStepPct: t }))
  sweepTable('B) 익절 방아쇠 +10% → +30%', B, '밴드는 지시값 고정(-10% / -20%), 익절 규모 10% 고정.')

  // ── C) 익절 규모 ──────────────────────────────────────────────────────────
  const C: SweepRow[] = []
  for (let f = 10; f <= 30; f++) C.push(S(`${f}%씩`, { ...base10, tpFracPct: f }))
  sweepTable('C) 익절 규모 10% → 30%', C, '밴드는 지시값 고정(-10% / -20%), 방아쇠 +10% 고정.')

  // ── D) 전면 격자 ──────────────────────────────────────────────────────────
  const D: SweepRow[] = []
  for (let b1 = 10; b1 <= 30; b1 += 2) {
    for (const gap of [b1, 10, 15]) {
      const b2 = b1 + gap
      if (b2 <= b1) continue
      for (let t = 10; t <= 30; t += 4) {
        for (let f = 10; f <= 30; f += 5) {
          D.push(
            S(`${b1}/${b2}/${t}/${f}`, { band1Pct: b1, band2Pct: b2, stage1SwapPct: 50, tpStepPct: t, tpFracPct: f }),
          )
        }
      }
    }
  }
  log('')
  log(`## D) 전면 격자 — **${D.length}변형** (밴드1 10~30 × 2단 간격 3종 × 방아쇠 10~30 × 규모 10~30)`)
  topTable('D-1) 칼마 상위 15 — 관문 기준', D, (r) => r.calmar ?? -9, 15)
  topTable('D-2) CAGR 상위 15 — 수익 기준', D, (r) => r.perf.cagr, 15)
  topTable('D-3) 알파 상위 15', D, (r) => r.alpha ?? -99, 15)

  const passed = D.filter((r) => r.pass)
  log('')
  log(`### 전면 격자 관문 통과: **${passed.length} / ${D.length}**`)
  if (passed.length > 0) {
    log('')
    log('⚠️ 통과 변형이 나왔더라도 **다중검정을 통과한 것은 아니다**. ' + `${D.length}개를 돌렸으므로 우연히 관문을 넘는 변형이 나오는 것이 정상이다. ` +
      '고원(plateau) 검사 — 이웃 파라미터도 같이 통과하는가 — 를 거쳐야 실체를 말할 수 있다.')
    topTable('통과 변형 (칼마순)', passed, (r) => r.calmar ?? -9, Math.min(20, passed.length))
  } else {
    log('')
    log('❌ 전면 격자에서도 관문 통과 0.')
  }

  // ── 요약 ──────────────────────────────────────────────────────────────────
  const bestOf = (rows: SweepRow[], by: (r: SweepRow) => number): SweepRow =>
    [...rows].sort((a, b) => by(b) - by(a))[0]
  const spec = S('지시값', base10)
  log('')
  log('## 요약 — 축별 최고')
  log('')
  log('| 축 | 칼마 최고 | 값 | CAGR 최고 | 값 |')
  log('|---|---|---|---|---|')
  const rowOf = (name: string, rows: SweepRow[]): void => {
    const bc = bestOf(rows, (r) => r.calmar ?? -9)
    const bg = bestOf(rows, (r) => r.perf.cagr)
    log(`| ${name} | ${bc.label} | ${f2(bc.calmar)} | ${bg.label} | ${f1(bg.perf.cagr)}% |`)
  }
  rowOf('A 진입 밴드', A)
  rowOf('B 익절 방아쇠', B)
  rowOf('C 익절 규모', C)
  const dc = bestOf(D, (r) => r.calmar ?? -9)
  const dg = bestOf(D, (r) => r.perf.cagr)
  log(`| D 전면 격자 | ${dc.label} | ${f2(dc.calmar)} | ${dg.label} | ${f1(dg.perf.cagr)}% |`)
  log('')
  log(
    `참고 — 지시값(10/20/+10/10): CAGR ${f1(spec.perf.cagr)}% · MDD ${f1(spec.perf.mdd)}% · ` +
      `칼마 ${f2(spec.calmar)} · 알파 ${pp(spec.alpha)}`,
  )
}


// ============================================================================
// 5.7 MODE=dca — 매일 1만원 적립식 (2026-08-05 대표 지시)
// ============================================================================
//
// 거치식(한 번에 넣고 두기)과 **계산이 다르다**. 원금이 매일 늘어나므로 곡선의 CAGR은
// 의미가 없다 — 돈이 들어온 시점마다 굴러간 기간이 달라서다. 그래서 **IRR(내부수익률)**로
// 잰다. 모든 납입을 현금흐름으로 놓고 최종 평가액과 맞추는 연환산 수익률이다.
//
// 적립식에서만 의미가 있는 지표를 같이 낸다:
//   · **원금 대비 배수** — 넣은 돈이 몇 배가 됐나
//   · **수중(underwater) 일수** — 평가액이 누적 원금 **아래**에 있던 날. 적립식은 계속
//     사들이므로 낙폭이 가려진다. "몇 년 동안 마이너스였나"가 체감 위험에 더 가깝다.
//   · **최장 연속 수중 기간** — 원금 회복까지 가장 오래 걸린 구간
//
// ⚠️ 환율 미반영(규칙 3 한계 그대로) — "매일 1만원어치를 그날 환율로 샀다"고 보되
//    원화·달러 환율 변동 손익은 계산에 없다. 세금도 미반영이다.
// ⚠️ 거래일 기준이다. 주말·휴장일에는 사지 않는다.

const DCA_DAILY = 10_000

interface DcaResult {
  curve: Curve
  days: number
  contributed: number
  finalValue: number
  multiple: number
  irrPct: number | null
  mddPct: number
  underwaterDays: number
  longestUnderwater: { days: number; from: string; to: string }
  firstDate: string
  lastDate: string
}

/** 순현재가치 — 일별 납입 + 최종 평가액. 연이율 r에서 0이 되는 지점이 IRR이다. */
function dcaNpv(bars: readonly DailyBar[], amount: number, finalValue: number, r: number): number {
  const t0 = Date.parse(bars[0].date)
  const yearOf = (d: string): number => (Date.parse(d) - t0) / (365.25 * 86400e3)
  const base = 1 + r
  let npv = 0
  for (const b of bars) npv -= amount / Math.pow(base, yearOf(b.date))
  npv += finalValue / Math.pow(base, yearOf(bars[bars.length - 1].date))
  return npv
}

/** IRR을 이분법으로 푼다. 부호가 안 갈리면 null(추정치를 지어내지 않는다). */
function dcaIrr(bars: readonly DailyBar[], amount: number, finalValue: number): number | null {
  let lo = -0.95
  let hi = 5
  let fLo = dcaNpv(bars, amount, finalValue, lo)
  let fHi = dcaNpv(bars, amount, finalValue, hi)
  if (!Number.isFinite(fLo) || !Number.isFinite(fHi) || fLo * fHi > 0) return null
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2
    const fMid = dcaNpv(bars, amount, finalValue, mid)
    if (!Number.isFinite(fMid)) return null
    if (fLo * fMid <= 0) {
      hi = mid
      fHi = fMid
    } else {
      lo = mid
      fLo = fMid
    }
  }
  return ((lo + hi) / 2) * 100
}

/**
 * 매 거래일 시가에 고정 금액을 매수한다. 미래참조 없음 — 그날 시가만 쓴다.
 */
function runDca(bars: readonly DailyBar[], amount: number, cost: LadderCost): DcaResult {
  if (bars.length < 2) throw new Error(`적립식을 잴 봉이 부족하다 (${bars.length}봉)`)
  const side = (cost.feePct + cost.slippagePct) / 100
  const curve: Curve = []
  let shares = 0
  let contributed = 0
  let peak = 0
  let mdd = 0
  let underwaterDays = 0
  let runStart = ''
  let best = { days: 0, from: '', to: '' }
  let runLen = 0

  for (const b of bars) {
    if (!(b.o > 0)) throw new Error(`${b.date} 시가가 유효하지 않다 (${b.o})`)
    shares += (amount * (1 - side)) / b.o
    contributed += amount
    const value = shares * b.c
    curve.push({ date: b.date, equity: value })
    if (value > peak) peak = value
    else if (peak > 0) mdd = Math.min(mdd, (value / peak - 1) * 100)
    if (value < contributed) {
      underwaterDays++
      if (runLen === 0) runStart = b.date
      runLen++
      if (runLen > best.days) best = { days: runLen, from: runStart, to: b.date }
    } else {
      runLen = 0
    }
  }

  const finalValue = curve[curve.length - 1].equity
  return {
    curve,
    days: bars.length,
    contributed,
    finalValue,
    multiple: finalValue / contributed,
    irrPct: dcaIrr(bars, amount, finalValue),
    mddPct: mdd,
    underwaterDays,
    longestUnderwater: best,
    firstDate: bars[0].date,
    lastDate: bars[bars.length - 1].date,
  }
}

const won = (n: number): string => {
  const eok = Math.floor(n / 100_000_000)
  const man = Math.round((n - eok * 100_000_000) / 10_000)
  return eok > 0 ? `${eok}억 ${man.toLocaleString()}만원` : `${man.toLocaleString()}만원`
}

function dcaRow(label: string, r: DcaResult): void {
  const uwPct = (r.underwaterDays / r.days) * 100
  log(
    `| ${label} | ${r.days.toLocaleString()}일 | ${won(r.contributed)} | **${won(r.finalValue)}** | ` +
      `${r.multiple.toFixed(2)}배 | ${r.irrPct === null ? '—' : `${f1(r.irrPct)}%`} | ${f1(r.mddPct)}% | ` +
      `${f1(uwPct)}% | ${r.longestUnderwater.days.toLocaleString()}일 (${r.longestUnderwater.from}~${r.longestUnderwater.to}) |`,
  )
}

const DCA_HEAD = '| 종목 | 거래일 | 누적 원금 | 최종 평가액 | 배수 | IRR(연) | 평가액 MDD | 수중일 비율 | 최장 연속 수중 |'
const DCA_SEP = '|---|---|---|---|---|---|---|---|---|'

async function dcaMode(token: string): Promise<void> {
  log('')
  log(`# MODE=dca — 매일 ${DCA_DAILY.toLocaleString()}원 적립식 (대표 지시)`)
  log('')
  log(
    '거치식과 **계산이 다르다.** 원금이 매일 늘어나 곡선의 CAGR은 의미가 없으므로 ' +
      '**IRR(내부수익률)**로 잰다. 적립식 고유 지표로 **수중일**(평가액이 누적 원금 아래였던 날)을 ' +
      '같이 낸다 — 적립식은 계속 사들여 낙폭이 가려지기 때문에 "몇 년을 마이너스로 버텼나"가 ' +
      '체감 위험에 더 가깝다.',
  )
  log('')
  log('⚠️ **환율·세금 미반영**(규칙 3 한계). 거래일에만 매수한다(주말·휴장 제외).')

  const loaded = new Map<string, Loaded>()
  for (const sym of [...LADDER]) {
    loaded.set(sym, await loadTicker(sym, token))
    await sleep(200)
  }
  for (const sym of LADDER) log(basisGate(loaded.get(sym)!.audit, sym))

  // ── 1) 공통 구간 — 사과 대 사과 ───────────────────────────────────────────
  const aligned = alignBars(new Map([...loaded].map(([s, v]) => [s, v.bars])))
  const common = aligned.get(LADDER_BASE)!
  log('')
  log(`## 1) 공통 구간 ${common[0].date} ~ ${common[common.length - 1].date} — 세 종목 같은 조건`)
  log('')
  log(DCA_HEAD)
  log(DCA_SEP)
  for (const sym of LADDER) dcaRow(sym, runDca(aligned.get(sym)!, DCA_DAILY, US_LADDER_COST))

  // ── 2) 각 종목 전체 구간 ──────────────────────────────────────────────────
  log('')
  log('## 2) 각 종목이 존재한 전 구간 — **구간이 달라 직접 비교하면 거짓이다**')
  log('')
  log('상장일이 달라 시작점이 다르다. 같은 표에 있다고 나란히 비교하지 마라.')
  log('')
  log(DCA_HEAD)
  log(DCA_SEP)
  for (const sym of LADDER) {
    const b = loaded.get(sym)!.bars
    dcaRow(`${sym} (${b[0].date}~)`, runDca(b, DCA_DAILY, US_LADDER_COST))
  }

  // ── 3) 닷컴 직전 시작 — 적립식의 진짜 시험 ────────────────────────────────
  log('')
  log('## 3) 최악의 시작점 — QQQ를 상장 직후(닷컴 직전)부터 적립했다면')
  log('')
  const qqqAll = loaded.get(BENCH)!.bars
  const q = runDca(qqqAll, DCA_DAILY, US_LADDER_COST)
  log(
    `1999-03-10부터 매일 ${DCA_DAILY.toLocaleString()}원씩 넣었다면 — ` +
      `원금 ${won(q.contributed)} → 평가액 ${won(q.finalValue)} (${q.multiple.toFixed(2)}배 · IRR ${q.irrPct === null ? '—' : `${f1(q.irrPct)}%`}).`,
  )
  log('')
  log(
    `그러나 **원금 아래에 있던 날이 ${q.underwaterDays.toLocaleString()}일**(전체의 ${f1((q.underwaterDays / q.days) * 100)}%)이고, ` +
      `가장 긴 연속 마이너스 구간은 **${q.longestUnderwater.days.toLocaleString()}거래일** ` +
      `(${q.longestUnderwater.from} ~ ${q.longestUnderwater.to})이었다. ` +
      '적립식이 거치식보다 안전해 보이는 이유는 낙폭이 신규 매수에 가려지기 때문이지 ' +
      '위험이 사라져서가 아니다.',
  )


  // ── 5) 사다리 전략의 적립식 판 ────────────────────────────────────────────
  log('')
  log('## 5) 사다리 전략 적립식 — 단순 적립과 정면 비교')
  log('')
  log(
    '지시문이 정하지 않은 축이 하나 있다: **새로 들어온 돈을 어디에 넣는가.** ' +
      '하나를 골라 숨기면 그 선택이 성적을 만든 건지 전략이 만든 건지 구분할 수 없으므로 둘 다 잰다.',
  )
  log('')
  log('· `현재비중` — 지금 보유 비중 그대로 산다. 2단(QLD 50/TQQQ 50)이면 새 돈도 레버리지로 들어간다.')
  log('· `QQQ고정` — 새 돈은 항상 QQQ로만. 사다리 전환은 기존 보유분에만 적용된다.')
  log('')
  log(DCA_HEAD)
  log(DCA_SEP)

  const ladderRows: { label: string; r: ReturnType<typeof runProportionalLadderDca> }[] = []
  const variants: { name: string; p: ProportionalParams }[] = [
    { name: '지시값 10/20·+10%마다10%', p: SPEC_PROPORTIONAL },
    { name: '익절30% 10/20·+10%마다30%', p: { ...SPEC_PROPORTIONAL, tpFracPct: 30 } },
  ]
  for (const v of variants) {
    for (const alloc of ['weights', 'qqq'] as DcaAllocation[]) {
      const r = runProportionalLadderDca(common, aligned, v.p, US_LADDER_COST, DCA_DAILY, alloc)
      const label = `사다리 ${v.name} · ${alloc === 'weights' ? '현재비중' : 'QQQ고정'}`
      ladderRows.push({ label, r })
      const irr = dcaIrr(common, DCA_DAILY, r.finalValue)
      const uwPct = (r.underwaterDays / r.days) * 100
      log(
        `| ${label} | ${r.days.toLocaleString()}일 | ${won(r.contributed)} | **${won(r.finalValue)}** | ` +
          `${r.multiple.toFixed(2)}배 | ${irr === null ? '—' : `${f1(irr)}%`} | ${f1(r.mddPct)}% | ` +
          `${f1(uwPct)}% | ${r.longestUnderwater.days.toLocaleString()}일 (${r.longestUnderwater.from}~${r.longestUnderwater.to}) |`,
      )
    }
  }

  // ── 6) 최종 순위 ──────────────────────────────────────────────────────────
  log('')
  log('## 6) 최종 순위 — 같은 구간·같은 납입액')
  log('')
  const all: { label: string; value: number; irr: number | null; mdd: number }[] = []
  for (const sym of LADDER) {
    const d = runDca(aligned.get(sym)!, DCA_DAILY, US_LADDER_COST)
    all.push({ label: `${sym} 단순 적립`, value: d.finalValue, irr: d.irrPct, mdd: d.mddPct })
  }
  for (const { label, r } of ladderRows)
    all.push({ label, value: r.finalValue, irr: dcaIrr(common, DCA_DAILY, r.finalValue), mdd: r.mddPct })
  all.sort((a, b) => b.value - a.value)
  log('| 순위 | 전략 | 최종 평가액 | IRR | MDD |')
  log('|---|---|---|---|---|')
  all.forEach((x, i) => log(`| ${i + 1} | ${x.label} | ${won(x.value)} | ${x.irr === null ? '—' : `${f1(x.irr)}%`} | ${f1(x.mdd)}% |`))
  log('')
  const ladderBest = all.find((x) => x.label.startsWith('사다리'))!
  const qldRow = all.find((x) => x.label.startsWith('QLD'))!
  log(
    `사다리 최고(${ladderBest.label}) ${won(ladderBest.value)} vs QLD 단순 적립 ${won(qldRow.value)} → ` +
      `**${ladderBest.value > qldRow.value ? '사다리가 앞선다' : `QLD가 ${(qldRow.value / ladderBest.value).toFixed(2)}배 앞선다`}**`,
  )

  // ── 4) 거치식과의 대조 ────────────────────────────────────────────────────
  log('')
  log('## 4) 같은 구간 거치식과 대조 — 적립식이 유리한가')
  log('')
  log('| 종목 | 적립식 IRR | 거치식 CAGR | 차이 | 읽는 법 |')
  log('|---|---|---|---|---|')
  for (const sym of LADDER) {
    const d = runDca(aligned.get(sym)!, DCA_DAILY, US_LADDER_COST)
    const lump = perfOf(buyHoldCurve(aligned.get(sym)!, US_LADDER_COST))
    const gap = d.irrPct === null ? null : d.irrPct - lump.cagr
    log(
      `| ${sym} | ${d.irrPct === null ? '—' : `${f1(d.irrPct)}%`} | ${f1(lump.cagr)}% | ${pp(gap)} | ` +
        `${gap !== null && gap > 0 ? '적립식이 높다' : '거치식이 높다 — 상승장에서는 일찍 넣을수록 유리하다'} |`,
    )
  }
  log('')
  log(
    '⚠️ 이 대조는 **투입 금액이 다르다** — 거치식 CAGR은 첫날 목돈을 넣은 가정이고 적립식 IRR은 ' +
      '돈이 나눠 들어간 가정이다. "어느 쪽이 더 벌었나"가 아니라 **"같은 돈이 시장에 머문 시간당 ' +
      '수익률이 어땠나"**를 비교하는 표다.',
  )
}

// ============================================================================
// 5.8 MODE=vr — SOXL VR vs TQQQ VR (2026-08-07 대표 지시 · 45차)
// ============================================================================
//
// 라오어 VR 근사(algoEngine.runValueRebalancing · 추가입금 없음)를 두 3배 ETF에
// 같은 조건으로 건다. SOXL은 반도체 3배(SOX 기초)라 기초지수가 다르다 — 같은
// "3배 VR"이어도 기초의 성질(변동성·낙폭 깊이)이 결과를 지배한다는 것을 보인다.

async function vrMode(token: string): Promise<void> {
  log('# MODE=vr — SOXL VR vs TQQQ VR (45차 · 대표 지시)')
  log('')
  const tqqq = await loadTicker('TQQQ', token)
  await sleep(400)
  const soxl = await loadTicker('SOXL', token)
  await sleep(400)
  const qld = await loadTicker(RIVAL, token)

  // 공통 구간: 둘 다 실재하는 날짜만 (SOXL 2010-03-11 상장 — 며칠 차이)
  const common = new Set(tqqq.bars.map((b) => b.date))
  const soxlB = soxl.bars.filter((b) => common.has(b.date))
  const soxlSet = new Set(soxlB.map((b) => b.date))
  const tqqqB = tqqq.bars.filter((b) => soxlSet.has(b.date))
  const qldB = qld.bars.filter((b) => soxlSet.has(b.date))
  if (tqqqB.length !== soxlB.length) throw new Error(`교집합 정렬 실패 ${tqqqB.length} vs ${soxlB.length}`)
  log(`구간 ${tqqqB[0].date} ~ ${tqqqB[tqqqB.length - 1].date} (${tqqqB.length}봉 · 두 ETF 교집합) · tiingo 총수익`)
  log('')

  const settings = {
    initialCapital: 100_000,
    positionPct: 100,
    commissionPct: 0.01,
    sellTaxPct: 0,
    slippagePct: 0.05,
    stopLossPct: null,
    takeProfitPct: null,
  }
  const mid = new Date((Date.parse(tqqqB[0].date) + Date.parse(tqqqB[tqqqB.length - 1].date)) / 2)
    .toISOString()
    .slice(0, 10)

  const stat = (eq: { date: string; equity: number }[], from = '', to = '9999-12-31') => {
    const c: Curve = eq.filter((e) => e.date >= from && e.date <= to).map((e) => ({ date: e.date, equity: e.equity }))
    return perfOf(c)
  }
  const holdCurve = (bars: DailyBar[]): Curve => buyHoldCurve(bars, US_LADDER_COST)

  const hT = holdCurve(tqqqB)
  const hS = holdCurve(soxlB)
  const hQ = holdCurve(qldB)
  const row = (name: string, p: ReturnType<typeof perfOf>, extra = '') =>
    log(
      `| ${name} | ${(p.total / 100 + 1).toFixed(1)}배 | ${p.cagr.toFixed(1)}% | ${p.mdd.toFixed(1)}% | ` +
        `${(calmarOf(p) ?? NaN).toFixed(2)} |${extra}`,
    )

  log('| 대상 | 총배수 | CAGR | MDD | 칼마 |')
  log('|---|---|---|---|---|')
  row('TQQQ 단순보유', perfOf(hT))
  row('SOXL 단순보유', perfOf(hS))
  row('QLD 단순보유(참고)', perfOf(hQ))
  log('')

  const variants: [string, VRParams][] = [
    ['기본 (10d·1%·15%·75%)', DEFAULT_VR_PARAMS],
    ['성장 0.5%', { ...DEFAULT_VR_PARAMS, growthPct: 0.5 }],
    ['성장 1.5%', { ...DEFAULT_VR_PARAMS, growthPct: 1.5 }],
    ['밴드 10%', { ...DEFAULT_VR_PARAMS, bandPct: 10 }],
    ['밴드 20%', { ...DEFAULT_VR_PARAMS, bandPct: 20 }],
    ['초기 90%', { ...DEFAULT_VR_PARAMS, initialStockPct: 90 }],
  ]
  log('| VR 변형 | TQQQ: 배수/CAGR/MDD/칼마 | SOXL: 배수/CAGR/MDD/칼마 |')
  log('|---|---|---|')
  for (const [name, P] of variants) {
    const rT = runValueRebalancing(tqqqB, 1, P, settings)
    const rS = runValueRebalancing(soxlB, 1, P, settings)
    const pT = stat(rT.equity)
    const pS = stat(rS.equity)
    log(
      `| ${name} | ${(pT.total / 100 + 1).toFixed(1)}배 / ${pT.cagr.toFixed(1)}% / ${pT.mdd.toFixed(1)}% / ${(calmarOf(pT) ?? NaN).toFixed(2)} ` +
        `| ${(pS.total / 100 + 1).toFixed(1)}배 / ${pS.cagr.toFixed(1)}% / ${pS.mdd.toFixed(1)}% / ${(calmarOf(pS) ?? NaN).toFixed(2)} |`,
    )
  }
  log('')
  // 전·후반 일관성 (기본 변형)
  const rT = runValueRebalancing(tqqqB, 1, DEFAULT_VR_PARAMS, settings)
  const rS = runValueRebalancing(soxlB, 1, DEFAULT_VR_PARAMS, settings)
  log(`전·후반 경계 ${mid} — CAGR(기본 변형):`)
  log(
    `  TQQQ VR 전반 ${stat(rT.equity, '', mid).cagr.toFixed(1)}% / 후반 ${stat(rT.equity, mid).cagr.toFixed(1)}% · ` +
      `SOXL VR 전반 ${stat(rS.equity, '', mid).cagr.toFixed(1)}% / 후반 ${stat(rS.equity, mid).cagr.toFixed(1)}%`,
  )
  log(
    `  리밸런스 횟수 — TQQQ ${rT.events.length}건 · SOXL ${rS.events.length}건 · ` +
      `현금 최저 — TQQQ $${Math.round(Math.min(...rT.events.map((e) => e.cashAfter))).toLocaleString()} · ` +
      `SOXL $${Math.round(Math.min(...rS.events.map((e) => e.cashAfter))).toLocaleString()}`,
  )
  log('')
  log(
    '읽는 법: VR 파라미터가 같아도 성패는 **기초지수의 성질**이 가른다. SOX(반도체)는 나스닥100보다 ' +
      '변동성·낙폭이 크고 횡보 잠식이 깊다 — 같은 "3배 VR"이라는 이름에 속지 말 것(규칙 4).',
  )
}

// ============================================================================
// 5.9 MODE=vrgrid — VR 4변수 전수 격자 + 고원 채점 (2026-08-07 대표 지시 · 47차)
// ============================================================================
//
// 대표 질문: "SOXL VR 기본(10d·1%·15%·75%)이 특이케이스인가 고원인가, 세부 옵션 다
// 검토하면 최적값인가?" — 43차 사다리 고원 채점과 같은 방법으로 판정한다:
// 각 조합의 **이웃최소 칼마**(4개 축에서 ±1스텝 이웃 8개+자기 중 최솟값)를 점수로 쓴다.
// 스파이크(운)는 이웃최소가 무너지고, 고원(실체)은 이웃최소가 버틴다.

const VR_GRID = {
  periodDays: [5, 10, 15, 20, 30],
  growthPct: [0, 0.5, 1, 1.5, 2],
  bandPct: [5, 10, 15, 20, 25],
  initialStockPct: [50, 65, 75, 90],
} as const

async function vrGridMode(token: string): Promise<void> {
  log('# MODE=vrgrid — VR 4변수 전수 격자 + 고원 채점 (47차 · 대표 지시)')
  log('')
  const tqqq = await loadTicker('TQQQ', token)
  await sleep(400)
  const soxl = await loadTicker('SOXL', token)

  const common = new Set(tqqq.bars.map((b) => b.date))
  const soxlB = soxl.bars.filter((b) => common.has(b.date))
  const soxlSet = new Set(soxlB.map((b) => b.date))
  const tqqqB = tqqq.bars.filter((b) => soxlSet.has(b.date))
  if (tqqqB.length !== soxlB.length) throw new Error(`교집합 정렬 실패 ${tqqqB.length} vs ${soxlB.length}`)
  log(`구간 ${tqqqB[0].date} ~ ${tqqqB[tqqqB.length - 1].date} (${tqqqB.length}봉 · 교집합) · tiingo 총수익`)
  const axes = Object.entries(VR_GRID)
    .map(([k, v]) => `${k}=[${v.join(',')}]`)
    .join(' × ')
  log(`격자: ${axes} → ${VR_GRID.periodDays.length * VR_GRID.growthPct.length * VR_GRID.bandPct.length * VR_GRID.initialStockPct.length}조합/종목`)
  log('')

  const settings = {
    initialCapital: 100_000,
    positionPct: 100,
    commissionPct: 0.01,
    sellTaxPct: 0,
    slippagePct: 0.05,
    stopLossPct: null,
    takeProfitPct: null,
  }

  interface Cell {
    pi: number
    gi: number
    bi: number
    si: number
    p: VRParams
    cagr: number
    mdd: number
    calmar: number
    nbMin: number
  }

  for (const [sym, bars] of [
    ['TQQQ', tqqqB],
    ['SOXL', soxlB],
  ] as const) {
    const hold = perfOf(buyHoldCurve(bars, US_LADDER_COST))
    const holdCalmar = calmarOf(hold) ?? 0
    log(`## ${sym} — 보유 벤치: CAGR ${f1(hold.cagr)}% · MDD ${f1(hold.mdd)}% · 칼마 ${f2(holdCalmar)}`)
    log('')

    // 4차원 격자 전수 실행
    const grid: Cell[][][][] = []
    const flat: Cell[] = []
    let ran = 0
    VR_GRID.periodDays.forEach((periodDays, pi) => {
      grid[pi] = []
      VR_GRID.growthPct.forEach((growthPct, gi) => {
        grid[pi][gi] = []
        VR_GRID.bandPct.forEach((bandPct, bi) => {
          grid[pi][gi][bi] = []
          VR_GRID.initialStockPct.forEach((initialStockPct, si) => {
            const p: VRParams = { periodDays, growthPct, bandPct, initialStockPct }
            const r = runValueRebalancing(bars, 1, p, settings)
            const perf = perfOf(r.equity)
            const cell: Cell = { pi, gi, bi, si, p, cagr: perf.cagr, mdd: perf.mdd, calmar: calmarOf(perf) ?? 0, nbMin: 0 }
            grid[pi][gi][bi][si] = cell
            flat.push(cell)
            ran++
          })
        })
      })
    })
    if (ran !== flat.length || ran === 0) throw new Error(`격자 실행 수 불일치 ${ran}`)

    // 이웃최소 — 축별 ±1 (모서리는 있는 이웃만)
    for (const c of flat) {
      let min = c.calmar
      const probe = (pi: number, gi: number, bi: number, si: number): void => {
        const n = grid[pi]?.[gi]?.[bi]?.[si]
        if (n) min = Math.min(min, n.calmar)
      }
      probe(c.pi - 1, c.gi, c.bi, c.si)
      probe(c.pi + 1, c.gi, c.bi, c.si)
      probe(c.pi, c.gi - 1, c.bi, c.si)
      probe(c.pi, c.gi + 1, c.bi, c.si)
      probe(c.pi, c.gi, c.bi - 1, c.si)
      probe(c.pi, c.gi, c.bi + 1, c.si)
      probe(c.pi, c.gi, c.bi, c.si - 1)
      probe(c.pi, c.gi, c.bi, c.si + 1)
      c.nbMin = min
    }

    const label = (c: Cell): string => `${c.p.periodDays}d·${c.p.growthPct}%·밴드${c.p.bandPct}%·초기${c.p.initialStockPct}%`
    const line = (c: Cell): string =>
      `| ${label(c)} | ${f1(c.cagr)}% | ${f1(c.mdd)}% | ${f2(c.calmar)} | ${f2(c.nbMin)} |`

    const byCalmar = [...flat].sort((a, b) => b.calmar - a.calmar)
    const byNbMin = [...flat].sort((a, b) => b.nbMin - a.nbMin)
    const def = flat.find(
      (c) =>
        c.p.periodDays === DEFAULT_VR_PARAMS.periodDays &&
        c.p.growthPct === DEFAULT_VR_PARAMS.growthPct &&
        c.p.bandPct === DEFAULT_VR_PARAMS.bandPct &&
        c.p.initialStockPct === DEFAULT_VR_PARAMS.initialStockPct,
    )
    if (!def) throw new Error('기본 파라미터가 격자에 없다 — 격자 축을 확인하라')

    log('| 조합 | CAGR | MDD | 칼마 | 이웃최소 |')
    log('|---|---|---|---|---|')
    log(`상위 5 (칼마):`)
    for (const c of byCalmar.slice(0, 5)) log(line(c))
    log(`상위 5 (이웃최소 = 고원 점수):`)
    for (const c of byNbMin.slice(0, 5)) log(line(c))
    log(`기본값 위치:`)
    log(line(def))
    log('')
    const defRankCalmar = byCalmar.indexOf(def) + 1
    const defRankNb = byNbMin.indexOf(def) + 1
    const overHold = flat.filter((c) => c.calmar > holdCalmar).length
    const overTarget = flat.filter((c) => c.calmar > 0.61 && c.cagr >= 30).length
    const nbOverHold = flat.filter((c) => c.nbMin > holdCalmar).length
    log(
      `기본값 순위: 칼마 ${defRankCalmar}/${flat.length} · 이웃최소 ${defRankNb}/${flat.length} — ` +
        `벤치 초과 조합 ${overHold}/${flat.length} · 이웃최소까지 벤치 초과 ${nbOverHold}/${flat.length} · ` +
        `목표(칼마>0.61 & CAGR≥30) 충족 ${overTarget}/${flat.length}`,
    )
    log('')
  }
  log(
    '읽는 법: **이웃최소가 벤치를 넘는 조합이 넓게 깔려 있으면 고원(실체), 최고점만 높고 이웃최소가 ' +
      '주저앉으면 스파이크(운)**다. 43차 사다리 채점과 같은 방법. 이 구간 성적은 2010~26 강세장 ' +
      '한 개 창이며 매수 권유가 아니다(규칙 4).',
  )
}

// ============================================================================
// 5.10 MODE=mix — 두 전략(추세 스위칭 · VR) 최적 조합 + 혼합 배분 프런티어 (48차)
// ============================================================================
//
// 대표 질문: "두 전략 중 칼마 최적 조합을 찾아라." 두 해석을 다 잰다:
//  ① 각 전략의 견고 정점끼리 단독 비교 (47차 고원 채점의 승자들)
//  ② 두 전략을 w:1-w로 섞은 포트폴리오 — 상관이 낮으면 혼합이 단독을 이길 수 있다.
// 슬리브 간 리밸런스(월 1회=21거래일)는 수익률 결합으로 근사하고 그 비용은 [근사·미반영]
// (회전율 월 수% × 편도 0.06% ≈ 월 0.01%p 미만이라 순위를 바꾸지 못한다).

function trendSwitchCurve(qqq: readonly DailyBar[], up: readonly DailyBar[], L: number, cost: LadderCost): Curve {
  if (qqq.length !== up.length) throw new Error(`스위칭 정렬 실패 ${qqq.length} vs ${up.length}`)
  const side = (cost.feePct + cost.slippagePct) / 100
  const n = qqq.length
  const sma: (number | null)[] = new Array(n).fill(null)
  let sum = 0
  for (let i = 0; i < n; i++) {
    sum += qqq[i].c
    if (i >= L) sum -= qqq[i - L].c
    if (i >= L - 1) sma[i] = sum / L
  }
  // 신호 = i-1 종가 vs SMA(i-1) → 체결 = i 시가 (규칙 1-2)
  const start = L
  let inUp = qqq[start - 1].c > (sma[start - 1] as number)
  let units = (cost.initialCapital * (1 - side)) / (inUp ? up[start].o : qqq[start].o)
  const eq: Curve = []
  for (let i = start; i < n; i++) {
    if (i > start) {
      const wantUp = qqq[i - 1].c > (sma[i - 1] as number)
      if (wantUp !== inUp) {
        const cash = units * (inUp ? up[i].o : qqq[i].o) * (1 - side)
        inUp = wantUp
        units = cash / ((inUp ? up[i].o : qqq[i].o) * (1 + side))
      }
    }
    eq.push({ date: qqq[i].date, equity: units * (inUp ? up[i].c : qqq[i].c) })
  }
  return eq
}

/** 두 곡선을 공통 날짜에서 w:1-w로 결합, 21거래일마다 재배분. 비용 [근사·미반영]. */
function blendCurves(a: Curve, b: Curve, wA: number): Curve {
  const bMap = new Map(b.map((e) => [e.date, e.equity]))
  const common = a.filter((e) => bMap.has(e.date))
  if (common.length < 100) throw new Error(`혼합 공통 구간이 너무 짧다: ${common.length}`)
  let va = wA
  let vb = 1 - wA
  const eq: Curve = [{ date: common[0].date, equity: 1 }]
  for (let i = 1; i < common.length; i++) {
    va *= common[i].equity / common[i - 1].equity
    vb *= (bMap.get(common[i].date) as number) / (bMap.get(common[i - 1].date) as number)
    if (i % 21 === 0) {
      const tot = va + vb
      va = tot * wA
      vb = tot * (1 - wA)
    }
    eq.push({ date: common[i].date, equity: va + vb })
  }
  return eq
}

/** 일간 수익률 상관계수 (공통 날짜) */
function dailyCorr(a: Curve, b: Curve): number {
  const bMap = new Map(b.map((e) => [e.date, e.equity]))
  const ra: number[] = []
  const rb: number[] = []
  let prevA: { date: string; equity: number } | null = null
  for (const e of a) {
    if (!bMap.has(e.date)) continue
    if (prevA && bMap.has(prevA.date)) {
      ra.push(e.equity / prevA.equity - 1)
      rb.push((bMap.get(e.date) as number) / (bMap.get(prevA.date) as number) - 1)
    }
    prevA = e
  }
  const n = ra.length
  const ma = ra.reduce((s, x) => s + x, 0) / n
  const mb = rb.reduce((s, x) => s + x, 0) / n
  let cov = 0
  let va = 0
  let vb = 0
  for (let i = 0; i < n; i++) {
    cov += (ra[i] - ma) * (rb[i] - mb)
    va += (ra[i] - ma) ** 2
    vb += (rb[i] - mb) ** 2
  }
  return cov / Math.sqrt(va * vb)
}

async function mixMode(token: string): Promise<void> {
  log('# MODE=mix — 두 전략 최적 조합 + 혼합 프런티어 (48차 · 대표 지시)')
  log('')
  const qqq = await loadTicker('QQQ', token)
  await sleep(400)
  const tqqq = await loadTicker('TQQQ', token)
  await sleep(400)
  const soxl = await loadTicker('SOXL', token)

  // 3종목 교집합 정렬
  const dSet = new Set(qqq.bars.map((b) => b.date))
  const dSet2 = new Set(tqqq.bars.filter((b) => dSet.has(b.date)).map((b) => b.date))
  const soxlB = soxl.bars.filter((b) => dSet2.has(b.date))
  const dSet3 = new Set(soxlB.map((b) => b.date))
  const qqqB = qqq.bars.filter((b) => dSet3.has(b.date))
  const tqqqB = tqqq.bars.filter((b) => dSet3.has(b.date))
  if (qqqB.length !== tqqqB.length || qqqB.length !== soxlB.length) {
    throw new Error(`3종목 교집합 정렬 실패 ${qqqB.length}/${tqqqB.length}/${soxlB.length}`)
  }
  log(`구간 ${qqqB[0].date} ~ ${qqqB[qqqB.length - 1].date} (${qqqB.length}봉 · QQQ∩TQQQ∩SOXL) · tiingo 총수익`)
  log('')

  const settings = {
    initialCapital: 100_000,
    positionPct: 100,
    commissionPct: 0.01,
    sellTaxPct: 0,
    slippagePct: 0.05,
    stopLossPct: null,
    takeProfitPct: null,
  }
  const row = (name: string, c: Curve, extra = ''): Perf => {
    const p = perfOf(c)
    log(`| ${name} | ${f1(p.cagr)}% | ${f1(p.mdd)}% | ${f2(calmarOf(p))} |${extra}`)
    return p
  }

  // ① 단독 정점들 (47차 승자) — 같은 창에서 재확인
  const SW_LS = [150, 160, 170, 180]
  log('## ① 단독 — 같은 창 재확인')
  log('| 전략 | CAGR | MDD | 칼마 |')
  log('|---|---|---|---|')
  const swCurves = new Map<number, Curve>()
  for (const L of SW_LS) {
    const c = trendSwitchCurve(qqqB, tqqqB, L, US_LADDER_COST)
    swCurves.set(L, c)
    row(`스위칭 TQQQ↔QQQ L${L}`, c)
  }
  const vrPlateauSoxl: VRParams = { periodDays: 20, growthPct: 2, bandPct: 20, initialStockPct: 50 }
  const vrDefaultSoxl = DEFAULT_VR_PARAMS
  const vrPlateauTqqq: VRParams = { periodDays: 30, growthPct: 2, bandPct: 15, initialStockPct: 90 }
  const soxlVrPlateau: Curve = runValueRebalancing(soxlB, 1, vrPlateauSoxl, settings).equity
  const soxlVrDefault: Curve = runValueRebalancing(soxlB, 1, vrDefaultSoxl, settings).equity
  const tqqqVrPlateau: Curve = runValueRebalancing(tqqqB, 1, vrPlateauTqqq, settings).equity
  row('SOXL VR 고원정점 (20d·2%·밴드20·초기50)', soxlVrPlateau)
  row('SOXL VR 기본 (10d·1%·밴드15·초기75)', soxlVrDefault)
  row('TQQQ VR 고원정점 (30d·2%·밴드15·초기90)', tqqqVrPlateau)
  log('')

  // ② 혼합 프런티어 — 스위칭 정점 × VR 3종, w = 스위칭 비중
  const swBest = swCurves.get(170) as Curve
  const pairs: [string, Curve][] = [
    ['SOXL VR 고원정점', soxlVrPlateau],
    ['SOXL VR 기본', soxlVrDefault],
    ['TQQQ VR 고원정점', tqqqVrPlateau],
  ]
  log('## ② 혼합 — 스위칭 L170 w% + VR (1-w)% · 월 재배분 [비용 근사·미반영]')
  for (const [name, vrC] of pairs) {
    log(`상대: ${name} — 일간수익률 상관 ${dailyCorr(swBest, vrC).toFixed(2)}`)
    log('| w(스위칭) | CAGR | MDD | 칼마 |')
    log('|---|---|---|---|')
    let best = { w: -1, calmar: -1 }
    for (let w = 0; w <= 100; w += 10) {
      const c = blendCurves(swBest, vrC, w / 100)
      const p = perfOf(c)
      const cal = calmarOf(p) ?? 0
      if (cal > best.calmar) best = { w, calmar: cal }
      row(`${w}%`, c)
    }
    log(`→ 최적 w=${best.w}% (칼마 ${best.calmar.toFixed(2)})`)
    log('')
  }
  log(
    '읽는 법: 혼합이 단독 최고 칼마를 넘으면 분산 효과가 실재하는 것. 상관이 1에 가까우면 ' +
      '혼합은 중간값만 준다. 전부 2010~26 한 개 창 · 환율·세금 미반영 · 투자자문 아님(규칙 4).',
  )
}

// ============================================================================
// 5.11 MODE=krwtax — 원화 환산 + 해외주식 양도세 연단위 과세 실측 (49차)
// ============================================================================
//
// 대표 지시(2026-08-08): "환율 변수랑 미국 직투 세금까지, 년단위 과세 납부금에 따른 분석."
// 혼합(스위칭 L170 + SOXL VR 정점)을 **원화 기준**으로 다시 굴린다:
//  · 매도할 때마다 원화 실현손익 기록(취득가·매도가 모두 그 시점 환율로 환산 — 환차익도 과세 대상)
//  · 매년 첫 거래일에 전년 실현이익에 과세: (실현이익 − 기본공제 250만) × 22%, 손실 이월 없음
//  · 세금은 포트폴리오에서 실제로 빼서(현금 우선, 부족하면 매도) 복리 손실을 실측
// [근사] 목록: 원가는 이동평균법(선입선출 대신 — 국세청 인정 방식 중 하나) / 납부 시점을
// 이듬해 5월이 아니라 연초로 앞당김(보수적) / 환전 스프레드 진입 시 0.5% 1회 / 배당은 총수익
// 가격에 내재(배당소득세 미반영 — 3배 ETF 배당 미미) / A 슬리브 소수점 주식 허용 /
// 공제 250만·세율 22%를 전 기간 고정(현행 기준 소급).
// 환율: 야후 KRW=X 일봉(러너에서 수급 — 규칙 4 게이트: 부족하면 비정상 종료).

async function fetchUsdKrw(): Promise<Map<string, number>> {
  // range=max가 FX 심볼에서 269봉만 반환하는 것을 실측(run 31302490427) — 명시적 기간으로 요청한다.
  const p1 = Math.floor(Date.UTC(2005, 0, 1) / 1000)
  const p2 = Math.floor(Date.now() / 1000)
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/KRW=X?period1=${p1}&period2=${p2}&interval=1d`
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } })
  if (!res.ok) throw new Error(`환율 조회 실패 HTTP ${res.status}`)
  const j = (await res.json()) as {
    chart?: { result?: { timestamp?: number[]; indicators?: { quote?: { close?: (number | null)[] }[] } }[] }
  }
  const r = j.chart?.result?.[0]
  const ts = r?.timestamp ?? []
  const close = r?.indicators?.quote?.[0]?.close ?? []
  const m = new Map<string, number>()
  for (let i = 0; i < ts.length; i++) {
    const c = close[i]
    if (typeof c === 'number' && Number.isFinite(c) && c > 500 && c < 3000) {
      m.set(new Date(ts[i] * 1000).toISOString().slice(0, 10), c)
    }
  }
  if (m.size < 2000) throw new Error(`환율 데이터 부족: ${m.size}봉 — 조용히 진행하지 않는다`)
  return m
}

interface KrwTaxResult {
  curveKrw: Curve
  curveUsd: Curve
  taxes: { year: number; realizedKrw: number; taxKrw: number }[]
  fxFrom: number
  fxTo: number
}

function simulateKrwTax(
  qqqB: readonly DailyBar[],
  tqqqB: readonly DailyBar[],
  soxlB: readonly DailyBar[],
  fxByDate: Map<string, number>,
  wA: number,
  initialKrw: number,
  taxOn: boolean,
  optimize = false,
): KrwTaxResult {
  const L = 170
  const VRP = { periodDays: 20, growthPct: 2, bandPct: 20, initialStockPct: 50 }
  const REBAL_EVERY = 21
  const SIDE = 0.0006
  const FX_SPREAD = 0.005
  const DEDUCT_KRW = 2_500_000
  const TAX_RATE = 0.22
  const n = qqqB.length

  // 환율 정렬 — 미국 거래일에 환율이 없으면 직전값 승계(전일 이하만 — 미래참조 금지)
  const fx: number[] = new Array(n)
  {
    const sorted = [...fxByDate.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))
    let k = 0
    let last = NaN
    for (let i = 0; i < n; i++) {
      while (k < sorted.length && sorted[k][0] <= qqqB[i].date) {
        last = sorted[k][1]
        k++
      }
      if (!Number.isFinite(last)) throw new Error(`시작일 ${qqqB[i].date} 이전 환율 없음`)
      fx[i] = last
    }
  }

  // SMA(QQQ 종가, 당일 포함)
  const sma: (number | null)[] = new Array(n).fill(null)
  {
    let sum = 0
    for (let i = 0; i < n; i++) {
      sum += qqqB[i].c
      if (i >= L) sum -= qqqB[i - L].c
      if (i >= L - 1) sma[i] = sum / L
    }
  }

  const start = L
  const initialUsd = (initialKrw * (1 - FX_SPREAD)) / fx[start]

  // A 슬리브(스위칭): 소수점 단위 허용. B 슬리브(VR): 정수 주식 + 현금.
  let aAsset: 'TQQQ' | 'QQQ' = qqqB[start - 1].c > (sma[start - 1] as number) ? 'TQQQ' : 'QQQ'
  const px = (sym: 'TQQQ' | 'QQQ' | 'SOXL', i: number, kind: 'o' | 'c'): number =>
    sym === 'TQQQ' ? tqqqB[i][kind] : sym === 'QQQ' ? qqqB[i][kind] : soxlB[i][kind]

  const aBudget = initialUsd * wA
  let aUnits = aBudget > 0 ? aBudget / (px(aAsset, start, 'c') * (1 + SIDE)) : 0
  let aBasisKrw = aBudget * fx[start]

  const bBudget = initialUsd * (1 - wA)
  let bQty = 0
  let bCashUsd = bBudget
  let bBasisKrw = 0
  {
    const spend0 = bBudget * (VRP.initialStockPct / 100)
    const q = Math.floor(spend0 / (px('SOXL', start, 'c') * (1 + SIDE)))
    if (q >= 1 && bBudget > 0) {
      const spent = q * px('SOXL', start, 'c') * (1 + SIDE)
      bQty = q
      bCashUsd -= spent
      bBasisKrw = spent * fx[start]
    }
  }
  let V = bQty * px('SOXL', start, 'c')

  let realizedYear = 0
  const taxes: KrwTaxResult['taxes'] = []
  const curveKrw: Curve = []
  const curveUsd: Curve = []

  const aVal = (i: number): number => aUnits * px(aAsset, i, 'c')
  const bVal = (i: number): number => bQty * px('SOXL', i, 'c') + bCashUsd

  // A 슬리브 일부/전부 매도 — 원화 실현손익 기록 후 USD 현금 반환
  const sellA = (i: number, frac: number, kind: 'o' | 'c'): number => {
    const f = Math.min(1, Math.max(0, frac))
    if (f <= 0 || aUnits <= 0) return 0
    const units = aUnits * f
    const proceeds = units * px(aAsset, i, kind) * (1 - SIDE)
    realizedYear += proceeds * fx[i] - aBasisKrw * f
    aBasisKrw *= 1 - f
    aUnits -= units
    return proceeds
  }
  const buyA = (i: number, usd: number, kind: 'o' | 'c'): void => {
    if (usd <= 0) return
    aUnits += usd / (px(aAsset, i, kind) * (1 + SIDE))
    aBasisKrw += usd * fx[i]
  }
  const sellSoxl = (i: number, qty: number): number => {
    const q = Math.min(qty, bQty)
    if (q < 1) return 0
    const proceeds = q * px('SOXL', i, 'c') * (1 - SIDE)
    realizedYear += proceeds * fx[i] - bBasisKrw * (q / bQty)
    bBasisKrw *= 1 - q / bQty
    bQty -= q
    bCashUsd += proceeds
    return proceeds
  }

  for (let i = start; i < n; i++) {
    // ① 연초 과세 — 전년 실현손익 정산 (첫 해 제외)
    if (taxOn && i > start && qqqB[i].date.slice(0, 4) !== qqqB[i - 1].date.slice(0, 4)) {
      const year = Number(qqqB[i - 1].date.slice(0, 4))
      const taxable = Math.max(0, realizedYear - DEDUCT_KRW)
      const taxKrw = taxable * TAX_RATE
      taxes.push({ year, realizedKrw: realizedYear, taxKrw })
      realizedYear = 0
      if (taxKrw > 0) {
        let needUsd = taxKrw / fx[i]
        const fromCash = Math.min(bCashUsd, needUsd)
        bCashUsd -= fromCash
        needUsd -= fromCash
        if (needUsd > 0 && aVal(i) > 0) {
          const frac = Math.min(1, needUsd / (aVal(i) * (1 - SIDE)))
          const proceeds = sellA(i, frac, 'c')
          needUsd -= Math.min(needUsd, proceeds)
        }
        if (needUsd > 0) sellSoxl(i, Math.ceil(needUsd / (px('SOXL', i, 'c') * (1 - SIDE))))
      }
    }

    // ② 시가: 스위칭 (신호 = 전일 종가 vs 전일 SMA)
    if (i > start && wA > 0) {
      const want: 'TQQQ' | 'QQQ' = qqqB[i - 1].c > (sma[i - 1] as number) ? 'TQQQ' : 'QQQ'
      if (want !== aAsset) {
        const proceeds = sellA(i, 1, 'o')
        aAsset = want
        buyA(i, proceeds, 'o')
      }
    }

    // ③ 종가: VR 점검 (20거래일마다)
    if (wA < 1 && i > start && (i - start) % VRP.periodDays === 0) {
      V *= 1 + VRP.growthPct / 100
      const stockVal = bQty * px('SOXL', i, 'c')
      if (stockVal > V * (1 + VRP.bandPct / 100)) {
        sellSoxl(i, Math.floor((stockVal - V) / px('SOXL', i, 'c')))
      } else if (stockVal < V * (1 - VRP.bandPct / 100)) {
        const budget = Math.min(bCashUsd, V - stockVal)
        const q = Math.floor(budget / (px('SOXL', i, 'c') * (1 + SIDE)))
        if (q >= 1) {
          const spend = q * px('SOXL', i, 'c') * (1 + SIDE)
          bCashUsd -= spend
          bQty += q
          bBasisKrw += spend * fx[i]
        }
      }
    }

    // ④ 종가: 월 재배분 (21거래일마다 · 목표 비중에서 1%p 이상 벗어날 때만)
    if (wA > 0 && wA < 1 && i > start && (i - start) % REBAL_EVERY === 0) {
      const total = aVal(i) + bVal(i)
      const diff = aVal(i) - total * wA
      if (Math.abs(diff) > total * 0.01) {
        if (diff > 0) {
          bCashUsd += sellA(i, diff / aVal(i), 'c')
        } else {
          let need = -diff
          const fromCash = Math.min(bCashUsd, need)
          bCashUsd -= fromCash
          let raised = fromCash
          need -= fromCash
          if (need > 0) raised += sellSoxl(i, Math.ceil(need / (px('SOXL', i, 'c') * (1 - SIDE))))
          // sellSoxl은 bCash로 넣으므로 그만큼 다시 꺼낸다
          if (raised > fromCash) bCashUsd -= raised - fromCash
          buyA(i, raised, 'c')
        }
      }
    }

    // ⑤ 절세 오버레이 — 연말 마지막 거래일 종가에 실행 (거래소 달력은 사전 공지 정보라
    //    "마지막 거래일" 판정은 미래 가격 참조가 아니다. 규칙 1 위반 아님)
    if (taxOn && optimize && (i + 1 >= n || qqqB[i + 1].date.slice(0, 4) !== qqqB[i].date.slice(0, 4)) && i > start) {
      // (a) 손실 수확: 평가손실 포지션을 팔고 즉시 재매수 — 실현손실로 이익 상계 (한국은 워시세일 규정 없음)
      if (aUnits > 0 && aVal(i) * fx[i] < aBasisKrw) {
        const proceeds = sellA(i, 1, 'c')
        buyA(i, proceeds, 'c')
      }
      if (bQty > 0 && bQty * px('SOXL', i, 'c') * fx[i] < bBasisKrw) {
        const cashBefore = bCashUsd
        sellSoxl(i, bQty)
        const proceeds = bCashUsd - cashBefore
        const q = Math.floor(proceeds / (px('SOXL', i, 'c') * (1 + SIDE)))
        if (q >= 1) {
          const spend = q * px('SOXL', i, 'c') * (1 + SIDE)
          bCashUsd -= spend
          bQty += q
          bBasisKrw += spend * fx[i]
        }
      }
      // (b) 공제 소진 스텝업: 실현이익이 250만 미달이면 평가이익을 그만큼 실현하고 재매수 (취득가 상향)
      let needGain = DEDUCT_KRW - realizedYear
      if (needGain > 0 && aUnits > 0) {
        const gA = aVal(i) * fx[i] - aBasisKrw
        if (gA > 0) {
          const frac = Math.min(1, needGain / gA)
          const proceeds = sellA(i, frac, 'c')
          buyA(i, proceeds, 'c')
          needGain = DEDUCT_KRW - realizedYear
        }
      }
      if (needGain > 0 && bQty > 0) {
        const gB = bQty * px('SOXL', i, 'c') * fx[i] - bBasisKrw
        if (gB > 0) {
          const cashBefore = bCashUsd
          sellSoxl(i, Math.min(bQty, Math.ceil((needGain / gB) * bQty)))
          const proceeds = bCashUsd - cashBefore
          const q = Math.floor(proceeds / (px('SOXL', i, 'c') * (1 + SIDE)))
          if (q >= 1) {
            const spend = q * px('SOXL', i, 'c') * (1 + SIDE)
            bCashUsd -= spend
            bQty += q
            bBasisKrw += spend * fx[i]
          }
        }
      }
    }

    const usd = aVal(i) + bVal(i)
    curveUsd.push({ date: qqqB[i].date, equity: usd })
    curveKrw.push({ date: qqqB[i].date, equity: usd * fx[i] })
  }
  // 마지막 해 실현분 기록(과세는 이듬해 몫이라 차감 없이 표기만)
  if (taxOn) taxes.push({ year: Number(qqqB[n - 1].date.slice(0, 4)), realizedKrw: realizedYear, taxKrw: -1 })

  return { curveKrw, curveUsd, taxes, fxFrom: fx[start], fxTo: fx[n - 1] }
}

async function krwTaxMode(token: string): Promise<void> {
  log('# MODE=krwtax — 원화 환산 + 양도세 연단위 과세 실측 (49차 · 대표 지시)')
  log('')
  const qqq = await loadTicker('QQQ', token)
  await sleep(400)
  const tqqq = await loadTicker('TQQQ', token)
  await sleep(400)
  const soxl = await loadTicker('SOXL', token)
  const fxMap = await fetchUsdKrw()

  const dSet = new Set(qqq.bars.map((b) => b.date))
  const dSet2 = new Set(tqqq.bars.filter((b) => dSet.has(b.date)).map((b) => b.date))
  const soxlB = soxl.bars.filter((b) => dSet2.has(b.date))
  const dSet3 = new Set(soxlB.map((b) => b.date))
  const qqqB = qqq.bars.filter((b) => dSet3.has(b.date))
  const tqqqB = tqqq.bars.filter((b) => dSet3.has(b.date))
  if (qqqB.length !== tqqqB.length || qqqB.length !== soxlB.length) throw new Error('3종목 교집합 정렬 실패')
  log(`구간 ${qqqB[0].date} ~ ${qqqB[qqqB.length - 1].date} (${qqqB.length}봉) · tiingo 총수익 · 환율 야후 KRW=X ${fxMap.size}봉`)
  log('')

  const perfRow = (name: string, c: Curve): void => {
    const p = perfOf(c)
    log(`| ${name} | ${(p.total / 100 + 1).toFixed(1)}배 | ${f1(p.cagr)}% | ${f1(p.mdd)}% | ${f2(calmarOf(p))} |`)
  }

  // ① 환율·세금 없음(달러) vs 원화 무세 vs 원화 과세 — 혼합 50:50, 초기 1,000만원
  const base = simulateKrwTax(qqqB, tqqqB, soxlB, fxMap, 0.5, 10_000_000, false)
  const taxed = simulateKrwTax(qqqB, tqqqB, soxlB, fxMap, 0.5, 10_000_000, true)
  log(`환율: 시작 ${base.fxFrom.toFixed(0)}원 → 끝 ${base.fxTo.toFixed(0)}원 (달러 ${((base.fxTo / base.fxFrom - 1) * 100).toFixed(0)}% 절상)`)
  log('')
  log('## ① 혼합 50:50 · 초기 1,000만원')
  log('| 기준 | 최종배수 | CAGR | MDD | 칼마 |')
  log('|---|---|---|---|---|')
  perfRow('달러 · 무세', base.curveUsd)
  perfRow('원화 · 무세 (환율만)', base.curveKrw)
  perfRow('원화 · 연단위 과세', taxed.curveKrw)
  log('')
  log('연도별 실현이익·세금 (원화 과세 시나리오 · 만원):')
  log('| 연도 | 실현이익 | 납부세금 |')
  log('|---|---|---|')
  let taxSum = 0
  for (const t of taxed.taxes) {
    const paid = t.taxKrw >= 0 ? `${Math.round(t.taxKrw / 10_000).toLocaleString()}` : '(이듬해 납부분)'
    if (t.taxKrw > 0) taxSum += t.taxKrw
    log(`| ${t.year} | ${Math.round(t.realizedKrw / 10_000).toLocaleString()} | ${paid} |`)
  }
  log(`납부 합계 ${Math.round(taxSum / 10_000).toLocaleString()}만원`)
  log('')

  // ② 규모·전략 비교 — 세후 CAGR + 절세 오버레이(연말 손실수확+공제 소진 스텝업) + 보유 벤치
  log('## ② 규모·전략별 세후 성적 (원화 기준)')
  log('| 시나리오 | 최종배수 | CAGR | MDD | 칼마 | 납부합계(만) |')
  log('|---|---|---|---|---|---|')
  const row2 = (name: string, r: KrwTaxResult): void => {
    const p = perfOf(r.curveKrw)
    const taxSum = r.taxes.reduce((s, t) => s + Math.max(0, t.taxKrw), 0)
    log(
      `| ${name} | ${(p.total / 100 + 1).toFixed(1)}배 | ${f1(p.cagr)}% | ${f1(p.mdd)}% | ` +
        `${f2(calmarOf(p))} | ${Math.round(taxSum / 10_000).toLocaleString()} |`,
    )
  }
  const scen: [string, number, number, boolean][] = [
    ['혼합 50:50 · 200만', 0.5, 2_000_000, false],
    ['혼합 50:50 · 1,000만', 0.5, 10_000_000, false],
    ['혼합 50:50 · 1,000만 · 절세오버레이', 0.5, 10_000_000, true],
    ['혼합 50:50 · 1억', 0.5, 100_000_000, false],
    ['혼합 50:50 · 1억 · 절세오버레이', 0.5, 100_000_000, true],
    ['스위칭 단독 · 1,000만', 1, 10_000_000, false],
    ['스위칭 단독 · 1,000만 · 절세오버레이', 1, 10_000_000, true],
    ['SOXL VR 단독 · 1,000만', 0, 10_000_000, false],
  ]
  for (const [name, w, cap, opt] of scen) {
    row2(name, simulateKrwTax(qqqB, tqqqB, soxlB, fxMap, w, cap, true, opt))
  }

  // 보유 벤치 — 매매가 없으니 과세이연을 통째로 받는다: 청산 시 1회만 과세 (공제 1회 적용)
  const fxArr: number[] = (() => {
    const sorted = [...fxMap.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))
    const arr: number[] = new Array(qqqB.length)
    let k = 0
    let last = NaN
    for (let i = 0; i < qqqB.length; i++) {
      while (k < sorted.length && sorted[k][0] <= qqqB[i].date) {
        last = sorted[k][1]
        k++
      }
      arr[i] = last
    }
    return arr
  })()
  const holdEndTax = (name: string, bars: readonly DailyBar[], initialKrw: number): void => {
    const start = 170 // 전략과 같은 시작점 (비교 가능성)
    const side = 0.0006
    const usd0 = (initialKrw * (1 - 0.005)) / fxArr[start]
    const units = (usd0 * (1 - side)) / bars[start].c
    const curve: Curve = []
    for (let i = start; i < bars.length; i++) curve.push({ date: bars[i].date, equity: units * bars[i].c * fxArr[i] })
    const basisKrw = usd0 * fxArr[start]
    const finalKrw = curve[curve.length - 1].equity
    const tax = Math.max(0, finalKrw * (1 - side) - basisKrw - 2_500_000) * 0.22
    const afterTax = finalKrw - tax
    const p = perfOf(curve)
    const cagr = (Math.pow(afterTax / curve[0].equity, 1 / p.years) - 1) * 100
    const calmar = Math.abs(p.mdd) > 0.01 ? cagr / Math.abs(p.mdd) : null
    log(
      `| ${name} 보유 · 1,000만 (청산 1회 과세) | ${(afterTax / curve[0].equity).toFixed(1)}배 | ${f1(cagr)}% | ` +
        `${f1(p.mdd)}% | ${f2(calmar)} | ${Math.round(tax / 10_000).toLocaleString()} |`,
    )
  }
  holdEndTax('QQQ', qqqB, 10_000_000)
  holdEndTax('TQQQ', tqqqB, 10_000_000)
  holdEndTax('SOXL', soxlB, 10_000_000)
  log('')
  log(
    '읽는 법: 원화 무세와 달러 무세의 차이 = 환율 효과, 원화 과세와 원화 무세의 차이 = 세금의 ' +
      '복리 손실. 공제 250만은 고정액이라 **원금이 작을수록 세부담이 급감**한다(200만 vs 1억 비교). ' +
      '납부를 연초로 앞당긴 보수적 근사라 실제(5월 납부)는 이보다 아주 약간 낫다. 투자자문 아님(규칙 4).',
  )
}

// ============================================================================
// 5.12 MODE=beat — 챔피언(스위칭+SOXL VR 반반)을 이기는 배분이 있는가 (50차)
// ============================================================================
//
// 대표 지시(2026-08-10): "반반 혼합보다 성과 좋은 거 찾아줘."
// 부품 5개로 배분 공간을 전수 탐색한다: ①TQQQ↔QQQ 스위칭(L170) ②SOXL↔QQQ 스위칭
// (SOXL 자기 150일선 — 반도체 쪽도 VR 대신 추세 게이트를 시험) ③SOXL VR 고원정점
// ④TQQQ VR 고원정점 ⑤금 GLD 보유(32차 국장에서 금 슬리브가 칼마를 올린 이력).
// 배분은 10%p 단위 심플렉스 전수(1,001조합), 월 재배분. **48차와 같은 자**(달러·무세·
// 재배분 비용 [근사·미반영])로 재서 챔피언 0.81과 직접 비교 가능하게 한다.
// 상위 후보는 이웃최소(인접 배분으로 10%p 옮긴 모든 변형의 최소 칼마)로 고원 여부까지 판정.

function trendSwitchCurveBy(
  signalB: readonly DailyBar[],
  upB: readonly DailyBar[],
  downB: readonly DailyBar[],
  L: number,
  cost: LadderCost,
): Curve {
  if (signalB.length !== upB.length || signalB.length !== downB.length) throw new Error('스위칭 정렬 실패')
  const side = (cost.feePct + cost.slippagePct) / 100
  const n = signalB.length
  const sma: (number | null)[] = new Array(n).fill(null)
  let sum = 0
  for (let i = 0; i < n; i++) {
    sum += signalB[i].c
    if (i >= L) sum -= signalB[i - L].c
    if (i >= L - 1) sma[i] = sum / L
  }
  const start = L
  let inUp = signalB[start - 1].c > (sma[start - 1] as number)
  let units = (cost.initialCapital * (1 - side)) / (inUp ? upB[start].o : downB[start].o)
  const eq: Curve = []
  for (let i = start; i < n; i++) {
    if (i > start) {
      const wantUp = signalB[i - 1].c > (sma[i - 1] as number)
      if (wantUp !== inUp) {
        const cash = units * (inUp ? upB[i].o : downB[i].o) * (1 - side)
        inUp = wantUp
        units = cash / ((inUp ? upB[i].o : downB[i].o) * (1 + side))
      }
    }
    eq.push({ date: signalB[i].date, equity: units * (inUp ? upB[i].c : downB[i].c) })
  }
  return eq
}

/** N개 곡선을 고정 비중으로 결합, 21거래일마다 재배분. 비용 [근사·미반영] — 48차와 같은 자. */
function blendN(curves: Curve[], weights: number[]): Curve {
  const maps = curves.map((c) => new Map(c.map((e) => [e.date, e.equity])))
  const dates = curves[0].filter((e) => maps.every((m) => m.has(e.date))).map((e) => e.date)
  if (dates.length < 500) throw new Error(`혼합 공통 구간 부족: ${dates.length}`)
  let vals = [...weights]
  const eq: Curve = [{ date: dates[0], equity: 1 }]
  for (let i = 1; i < dates.length; i++) {
    for (let k = 0; k < vals.length; k++) {
      if (vals[k] > 0) vals[k] *= (maps[k].get(dates[i]) as number) / (maps[k].get(dates[i - 1]) as number)
    }
    if (i % 21 === 0) {
      const tot = vals.reduce((s, x) => s + x, 0)
      vals = weights.map((w) => tot * w)
    }
    eq.push({ date: dates[i], equity: vals.reduce((s, x) => s + x, 0) })
  }
  return eq
}

async function beatMode(token: string): Promise<void> {
  log('# MODE=beat — 챔피언(반반 혼합)을 이기는 배분 전수 탐색 (50차 · 대표 지시)')
  log('')
  const qqq = await loadTicker('QQQ', token)
  await sleep(400)
  const tqqq = await loadTicker('TQQQ', token)
  await sleep(400)
  const soxl = await loadTicker('SOXL', token)
  await sleep(400)
  const gld = await loadTicker('GLD', token)

  // 4종목 교집합 정렬
  let dates = new Set(qqq.bars.map((b) => b.date))
  for (const t of [tqqq, soxl, gld]) {
    const s = new Set(t.bars.map((b) => b.date))
    dates = new Set([...dates].filter((d) => s.has(d)))
  }
  const cut = (bars: DailyBar[]): DailyBar[] => bars.filter((b) => dates.has(b.date))
  const qqqB = cut(qqq.bars)
  const tqqqB = cut(tqqq.bars)
  const soxlB = cut(soxl.bars)
  const gldB = cut(gld.bars)
  if (new Set([qqqB.length, tqqqB.length, soxlB.length, gldB.length]).size !== 1) throw new Error('4종목 정렬 실패')
  log(`구간 ${qqqB[0].date} ~ ${qqqB[qqqB.length - 1].date} (${qqqB.length}봉 · 4종목 교집합) · tiingo 총수익`)
  log('')

  const settings = {
    initialCapital: 100_000,
    positionPct: 100,
    commissionPct: 0.01,
    sellTaxPct: 0,
    slippagePct: 0.05,
    stopLossPct: null,
    takeProfitPct: null,
  }
  const NAMES = ['스위칭TQQQ', '스위칭SOXL', 'VR·SOXL', 'VR·TQQQ', '금GLD']
  const sleeves: Curve[] = [
    trendSwitchCurveBy(qqqB, tqqqB, qqqB, 170, US_LADDER_COST),
    trendSwitchCurveBy(soxlB, soxlB, qqqB, 150, US_LADDER_COST),
    runValueRebalancing(soxlB, 1, { periodDays: 20, growthPct: 2, bandPct: 20, initialStockPct: 50 }, settings).equity,
    runValueRebalancing(tqqqB, 1, { periodDays: 30, growthPct: 2, bandPct: 15, initialStockPct: 90 }, settings).equity,
    buyHoldCurve(gldB, US_LADDER_COST),
  ]
  log('## 부품 단독 성적')
  log('| 부품 | CAGR | MDD | 칼마 |')
  log('|---|---|---|---|')
  for (let k = 0; k < sleeves.length; k++) {
    const p = perfOf(blendN([sleeves[k]], [1]))
    log(`| ${NAMES[k]} | ${f1(p.cagr)}% | ${f1(p.mdd)}% | ${f2(calmarOf(p))} |`)
  }
  log('')
  log('부품 간 일간수익률 상관 (스위칭TQQQ 기준): ' + sleeves.slice(1).map((c, k) => `${NAMES[k + 1]} ${dailyCorr(sleeves[0], c).toFixed(2)}`).join(' · '))
  log('')

  // 10%p 심플렉스 전수 — 5부품 합 100%
  interface Combo {
    w: number[]
    cagr: number
    mdd: number
    calmar: number
  }
  const combos: Combo[] = []
  for (let a = 0; a <= 10; a++)
    for (let b = 0; b <= 10 - a; b++)
      for (let c = 0; c <= 10 - a - b; c++)
        for (let d = 0; d <= 10 - a - b - c; d++) {
          const e = 10 - a - b - c - d
          const w = [a / 10, b / 10, c / 10, d / 10, e / 10]
          const p = perfOf(blendN(sleeves, w))
          combos.push({ w, cagr: p.cagr, mdd: p.mdd, calmar: calmarOf(p) ?? 0 })
        }
  const key = (w: number[]): string => w.map((x) => Math.round(x * 10)).join(',')
  const byKey = new Map(combos.map((c) => [key(c.w), c]))
  const label = (w: number[]): string =>
    w.map((x, k) => (x > 0 ? `${NAMES[k]}${Math.round(x * 100)}` : '')).filter(Boolean).join('+')
  // 이웃최소: 한 부품에서 다른 부품으로 10%p 옮긴 모든 변형의 최소 칼마
  const nbMin = (c: Combo): number => {
    let min = c.calmar
    for (let i = 0; i < 5; i++)
      for (let j = 0; j < 5; j++) {
        if (i === j || c.w[i] < 0.1) continue
        const w2 = [...c.w]
        w2[i] -= 0.1
        w2[j] += 0.1
        const n = byKey.get(key(w2))
        if (n) min = Math.min(min, n.calmar)
      }
    return min
  }

  const champ = byKey.get('5,0,5,0,0') as Combo
  const sorted = [...combos].sort((x, y) => y.calmar - x.calmar)
  const champRank = sorted.indexOf(champ) + 1
  log(`## 챔피언: ${label(champ.w)} — CAGR ${f1(champ.cagr)}% · MDD ${f1(champ.mdd)}% · 칼마 ${f2(champ.calmar)} · 이웃최소 ${f2(nbMin(champ))} · 전체 순위 ${champRank}/${combos.length}`)
  log('')
  log('## 칼마 상위 12 (1,001조합 전수)')
  log('| 배분 | CAGR | MDD | 칼마 | 이웃최소 |')
  log('|---|---|---|---|---|')
  for (const c of sorted.slice(0, 12)) log(`| ${label(c.w)} | ${f1(c.cagr)}% | ${f1(c.mdd)}% | ${f2(c.calmar)} | ${f2(nbMin(c))} |`)
  log('')
  const hi = sorted.filter((c) => c.cagr >= 35)
  log('## CAGR ≥ 35% 조건부 칼마 상위 5')
  log('| 배분 | CAGR | MDD | 칼마 | 이웃최소 |')
  log('|---|---|---|---|---|')
  for (const c of hi.slice(0, 5)) log(`| ${label(c.w)} | ${f1(c.cagr)}% | ${f1(c.mdd)}% | ${f2(c.calmar)} | ${f2(nbMin(c))} |`)
  log('')

  // 심층 지표 (2026-08-10 대표 지시 "다 추가해서 표 업데이트") — 칼마가 못 보는 것들:
  //  · 소르티노 = CAGR ÷ 연환산 하락편차(하락일 수익률만의 제곱평균 √×√252) — 하방 흔들림 대비 수익
  //  · 최장 물밑 = 전고점을 깬 뒤 회복까지 최대 기간(개월=거래일/21) — 낙폭의 "길이"
  //  · 최악 시작 3년 = 모든 시작 시점의 3년(756거래일) 연환산 수익률의 최솟값 — 입장 운 제거
  //  · 최악 하루/1개월 = 일간·21거래일 최대 손실 — 꼬리 충격
  interface DeepStats {
    cagr: number
    mdd: number
    calmar: number | null
    sortino: number | null
    uwMonths: number
    worst3y: number
    worstDay: number
    worstMonth: number
  }
  const deep = (c: Curve): DeepStats => {
    const p = perfOf(c)
    let downSq = 0
    let worstDay = 0
    let nRet = 0
    for (let i = 1; i < c.length; i++) {
      const r = c[i].equity / c[i - 1].equity - 1
      nRet++
      if (r < 0) downSq += r * r
      if (r < worstDay) worstDay = r
    }
    const downDev = Math.sqrt(downSq / nRet) * Math.sqrt(252)
    let worstMonth = 0
    for (let i = 21; i < c.length; i++) {
      const r = c[i].equity / c[i - 21].equity - 1
      if (r < worstMonth) worstMonth = r
    }
    let peak = -Infinity
    let peakIdx = 0
    let maxUw = 0
    for (let i = 0; i < c.length; i++) {
      if (c[i].equity >= peak) {
        peak = c[i].equity
        peakIdx = i
      } else if (i - peakIdx > maxUw) maxUw = i - peakIdx
    }
    let worst3y = Infinity
    for (let i = 0; i + 756 < c.length; i++) {
      const r = Math.pow(c[i + 756].equity / c[i].equity, 252 / 756) - 1
      if (r < worst3y) worst3y = r
    }
    return {
      cagr: p.cagr,
      mdd: p.mdd,
      calmar: calmarOf(p),
      sortino: downDev > 0 ? p.cagr / 100 / downDev : null,
      uwMonths: maxUw / 21,
      worst3y: worst3y * 100,
      worstDay: worstDay * 100,
      worstMonth: worstMonth * 100,
    }
  }
  log('## 심층 지표 — 주요 배분 비교')
  log('| 배분 | CAGR | MDD | 칼마 | 소르티노 | 최장물밑 | 최악시작3년 | 최악하루 | 최악1개월 |')
  log('|---|---|---|---|---|---|---|---|---|')
  const deepRows: [string, Curve][] = [
    ['반반(기존): 스위칭T50+VR·S50', blendN(sleeves, [0.5, 0, 0.5, 0, 0])],
    ['금20 우승: T30+S20+VR·S30+금20', blendN(sleeves, [0.3, 0.2, 0.3, 0, 0.2])],
    ['수익유지: T40+S10+VR·S40+금10', blendN(sleeves, [0.4, 0.1, 0.4, 0, 0.1])],
    ['방어형: T10+S20+VR·S10+금60', blendN(sleeves, [0.1, 0.2, 0.1, 0, 0.6])],
    ['벤치: QQQ 보유', buyHoldCurve(qqqB.slice(170), US_LADDER_COST)],
  ]
  for (const [name, curve] of deepRows) {
    const d = deep(curve)
    log(
      `| ${name} | ${f1(d.cagr)}% | ${f1(d.mdd)}% | ${f2(d.calmar)} | ${f2(d.sortino)} | ` +
        `${d.uwMonths.toFixed(0)}개월 | ${d.worst3y >= 0 ? '+' : ''}${f1(d.worst3y)}%/년 | ${f1(d.worstDay)}% | ${f1(d.worstMonth)}% |`,
    )
  }
  log('')
  log(
    '읽는 법: 챔피언보다 칼마가 높고 **이웃최소도 챔피언 이상**인 배분만 "이겼다"고 본다 — ' +
      '한 점만 높은 건 배분 과최적화다. 48차와 같은 자(달러·무세·재배분 비용 근사 미반영)라 ' +
      '수치는 실전형(49차)보다 후하다. 2010~26 한 개 창 · 투자자문 아님(규칙 4).',
  )
}

// ============================================================================
// 6. MODE=selftest — 네트워크 없이 도는 자기검증
// ============================================================================

function selftest(): void {
  log('# MODE=selftest — 합성 데이터 자기검증 (네트워크 불필요)')
  const bars: DailyBar[] = []
  let c = 100
  for (let i = 0; i < 1500; i++) {
    // 결정적 계열: 앞 절반 상승, 뒤 절반 급락 후 회복 — 사다리가 전 칸을 다 밟게 만든다.
    const r = i < 700 ? 0.0008 : i < 1000 ? -0.004 : 0.003
    c = Math.max(1, c * (1 + r))
    const d = new Date(Date.UTC(2010, 0, 4) + i * 86400e3)
    bars.push({ date: d.toISOString().slice(0, 10), t: 0, o: c * 0.999, h: c, l: c, c, v: 0 })
  }
  const assets = alignBars(
    new Map<string, DailyBar[]>([
      ['QQQ', bars],
      ['QLD', synthLeveraged(bars, { leverage: 2, expenseAnnualPct: 0.95, financingAnnualPct: 2 })],
      ['TQQQ', synthLeveraged(bars, { leverage: 3, expenseAnnualPct: 0.84, financingAnnualPct: 2 })],
    ]),
  )
  const run = runLeverageLadder(bars, assets, { stepPct: 20, bufPct: 3, ladder: LADDER }, US_LADDER_COST)
  const p = perfOf(run.equity)
  log('')
  log(`전환 ${run.switches.length}건 · 보유일 QQQ/QLD/TQQQ = ${run.daysInStep.join('/')}`)
  log(`CAGR ${f1(p.cagr)}% · MDD ${f1(p.mdd)}% · 칼마 ${f2(calmarOf(p))}`)
  if (run.switches.length === 0) throw new Error('자기검증 실패 — 전 칸을 밟도록 만든 계열인데 전환이 0건이다')
  if (run.daysInStep[2] === 0) throw new Error('자기검증 실패 — TQQQ 칸을 한 번도 밟지 않았다')
  log('')
  log('✅ 자기검증 통과 — 사다리가 전 칸을 밟고 신호→체결 분리가 동작한다.')
}

// ============================================================================
// 7. 진입점
// ============================================================================

async function main(): Promise<void> {
  const mode = (process.env.MODE ?? 'real').trim()
  log(`# 43차 — 동적 레버리지 사다리 (QQQ → QLD → TQQQ) · MODE=${mode}`)
  log('')
  log(`생성 시각(UTC): ${new Date().toISOString()}`)
  log('')

  if (mode === 'selftest') {
    selftest()
    return
  }

  const key = loadTiingoKey()
  if (!key.value)
    throw new Error(
      `TIINGO_API_KEY 없음 — 조용히 다른 소스로 내려가지 않고 실패로 끝낸다${key.help ? ` (${key.help})` : ''}`,
    )
  // 값은 어떤 경로로도 출력하지 않는다(규칙 2-1) — 길이만 남긴다.
  log(`시세 소스: tiingo (키 길이 ${key.value.length})`)
  log('호출 종목 4개 — 무료 티어 한도(500 unique/월 · 50 req/시간)와 무관하다.')
  log('')

  if (mode === 'vr') await vrMode(key.value)
  if (mode === 'vrgrid') await vrGridMode(key.value)
  if (mode === 'mix') await mixMode(key.value)
  if (mode === 'krwtax') await krwTaxMode(key.value)
  if (mode === 'beat') await beatMode(key.value)
  if (mode === 'real' || mode === 'all') await real(key.value)
  if (mode === 'synth' || mode === 'all') await synth(key.value)
  if (mode === 'prop' || mode === 'all') await prop(key.value)
  if (mode === 'sweep' || mode === 'all') await sweepMode(key.value)
  if (mode === 'dca' || mode === 'all') await dcaMode(key.value)
  if (!['real', 'synth', 'prop', 'sweep', 'dca', 'vr', 'vrgrid', 'mix', 'krwtax', 'beat', 'all'].includes(mode)) throw new Error(`알 수 없는 MODE: ${mode}`)

  log('')
  log('---')
  log(
    '**고지** — 위 수치는 과거 데이터 기반 시뮬레이션이며 미래 수익을 보장하지 않는다. ' +
      '투자자문이 아니다(규칙 4). 레버리지 ETF는 일간 배수를 추종하므로 횡보장에서 변동성 잠식이 ' +
      '누적되고, 3배 상품은 하루 -33.4%에서 이론상 전액 소멸한다. 이 전략은 그 위험을 **낙폭이 ' +
      '가장 깊은 구간에서** 떠안는 구조다. 생존편향·환율 미반영·세금 미반영 한계가 남아 있다.',
  )
}

if (process.env.US_LEV_RUN === '1') {
  main().catch((e) => {
    console.error(`실행 실패: ${String(e)}`)
    process.exit(1)
  })
}

export { perfOf, calmarOf, buyHoldCurve, runGrid, basisGate, splitDate, STEP_GRID, BUF_GRID, LADDER }
export { runDca, dcaIrr, dcaNpv, DCA_DAILY, type DcaResult }
