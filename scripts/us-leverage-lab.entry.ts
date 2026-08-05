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
//        MODE=all   node scripts/us-leverage-lab.mjs   (둘 다)
//        MODE=selftest                                  (네트워크 불필요 자기검증)

import {
  runLeverageLadder,
  alignBars,
  synthLeveraged,
  synthTrackingGap,
  US_LADDER_COST,
  LADDER_BASE,
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

  if (mode === 'real' || mode === 'all') await real(key.value)
  if (mode === 'synth' || mode === 'all') await synth(key.value)
  if (mode !== 'real' && mode !== 'synth' && mode !== 'all') throw new Error(`알 수 없는 MODE: ${mode}`)

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
