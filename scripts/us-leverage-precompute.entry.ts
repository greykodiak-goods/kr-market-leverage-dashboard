// QQQ 배수 전략 프리셋 사전계산 — 화면이 읽을 산출물을 굽는다.
//
// 왜 굽는가: 이 전략의 시세는 tiingo이고, 브라우저에서 부르면 **API 키가 프런트엔드에
// 노출**된다(규칙 2-1 위반). 그래서 GHA에서 키를 써서 굽고 결과 JSON만 커밋한다.
// 화면(`UsLeveragePanel.tsx`)은 그 파일을 **읽기만** 한다.
//
// 산출물: public/data/us-leverage-precomputed.json
// 실행:   MODE=lev:bake (GHA backtest.yml) — 시크릿 TIINGO_API_KEY 필요
//
// ── 정직성(규칙 3) ──────────────────────────────────────────────────────────
//   · 라벨에 붙는 수치는 하드코딩이 아니라 **이 실행이 계산한 값**이다.
//   · 벤치·벽은 옮겨 적지 않고 **같은 구간·같은 비용으로 다시 잰다**(34차 규약).
//   · 곡선은 주 1점 다운샘플이며 그 사실을 산출물에 적는다(`downsample`).
//   · 관문 판정도 같이 구워서 화면이 "통과/탈락"을 임의로 못 바꾸게 한다.
//
// ── 규칙 1 ──────────────────────────────────────────────────────────────────
//   엔진은 `runProportionalLadder`이며 절단 불변성은 `tests/leverageladder.test.ts`가 강제한다.
//   이 스크립트는 엔진을 부르기만 하고 신호·체결에 손대지 않는다.

import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  runProportionalLadder,
  runProportionalLadderDca,
  alignBars,
  US_LADDER_COST,
  LADDER_BASE,
  type Curve,
} from '../src/features/backtest/leverageLadder'
import { US_LEVERAGE_PRESETS, US_LEV_SCHEMA } from '../src/features/backtest/usLeveragePresets'
import {
  fetchTiingoDaily,
  tiingoBarsToDaily,
  checkTickerReuseGap,
  loadTiingoKey,
  type TiingoAdjAudit,
} from './lib/tiingo'
import type { DailyBar } from '../src/lib/history'

const LADDER = ['QQQ', 'QLD', 'TQQQ'] as const
const BENCH = 'QQQ'
const START_DATE = '1999-01-01'
const DCA_DAILY = 10_000
/** 주 1점으로 줄인다 — 4천 봉을 그대로 실으면 파일이 커지고 화면이 느려진다. */
const DOWNSAMPLE = 5

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

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

function buyHoldCurve(bars: readonly DailyBar[]): Curve {
  const side = (US_LADDER_COST.feePct + US_LADDER_COST.slippagePct) / 100
  const shares = (US_LADDER_COST.initialCapital * (1 - side)) / bars[0].o
  return bars.map((b) => ({ date: b.date, equity: shares * b.c }))
}

function alphaOf(strat: Curve, bench: Curve, from: string, to: string): number | null {
  const s = perfOf(strat, from, to)
  const b = perfOf(bench, from, to)
  if (s.years < 0.5 || b.years < 0.5) return null
  return s.cagr - b.cagr
}

function midDate(c: Curve): string {
  return new Date((Date.parse(c[0].date) + Date.parse(c[c.length - 1].date)) / 2).toISOString().slice(0, 10)
}

async function loadTicker(symbol: string, token: string): Promise<{ bars: DailyBar[]; audit: TiingoAdjAudit }> {
  const res = await fetchTiingoDaily(symbol, token, { startDate: START_DATE })
  if (res.kind === 'absent') throw new Error(`${symbol}: tiingo absent — ${res.note}`)
  const gap = checkTickerReuseGap(res.rows)
  if (!gap.ok) throw new Error(`${symbol}: ${gap.reason}`)
  const { bars, dropped } = tiingoBarsToDaily(res.rows, 'total')
  if (bars.length === 0) throw new Error(`${symbol}: OHLC 완전한 봉이 0개 (버린 행 ${dropped})`)
  return { bars, audit: res.audit }
}

/** 다운샘플이 남기는 인덱스 — **마지막 점은 반드시 포함**(최신 값이 잘리면 라벨이 거짓이 된다). */
function sampleIdx(n: number): number[] {
  const out: number[] = []
  for (let i = 0; i < n; i++) if (i % DOWNSAMPLE === 0 || i === n - 1) out.push(i)
  return out
}

/** 주 1점 다운샘플. */
function downsample(strat: Curve, bench: Curve): [string, number, number][] {
  return sampleIdx(strat.length).map((i) => [strat[i].date, Math.round(strat[i].equity), Math.round(bench[i].equity)])
}

// ── 적립식 반원금 근사 (2026-08-07 대표 지정 방식) ──────────────────────────
// 매일 같은 금액을 넣으면 투자원금이 0→C로 선형 증가하므로, 시간 적분한 평균
// 투자원금은 **총 납입액의 절반(C/2)**이다. 대표 지시: 그 절반을 원금으로 보고
// 수익률·CAGR을 계산한다. **근사다** — 정확한 값은 현금흐름 IRR이며 둘 다 싣는다.
export interface DcaHalfBase {
  /** (평가액 − 납입액) ÷ (납입액/2) — 반원금 기준 총수익률 % */
  totalPct: number
  /** (평가액 ÷ 반원금)^(1/년수) − 1 — 반원금을 기초에 넣은 셈 치는 연환산 % */
  cagrPct: number
}

export function dcaHalfBase(contributed: number, finalValue: number, years: number): DcaHalfBase {
  const half = contributed / 2
  if (!(half > 0) || !(years > 0)) throw new Error('반원금 근사: 납입액·기간이 양수여야 한다')
  return {
    totalPct: ((finalValue - contributed) / half) * 100,
    cagrPct: (Math.pow(Math.max(finalValue / half, 1e-9), 1 / years) - 1) * 100,
  }
}

/**
 * 적립식 IRR(연환산 %) — 이분법. 매 봉 시가에 -amount, 마지막에 +finalValue.
 * NPV(r)=0인 r을 찾는다. 근사(반원금)와 나란히 실어 차이를 보이게 한다.
 */
export function dcaIrrPct(dates: readonly string[], amount: number, finalValue: number): number {
  const t0 = Date.parse(dates[0])
  const yr = (d: string): number => (Date.parse(d) - t0) / (365.25 * 86400e3)
  const end = yr(dates[dates.length - 1])
  const npv = (r: number): number => {
    let v = 0
    for (const d of dates) v -= amount / Math.pow(1 + r, yr(d))
    return v + finalValue / Math.pow(1 + r, end)
  }
  let lo = -0.99
  let hi = 10
  if (npv(lo) * npv(hi) > 0) throw new Error('IRR 구간에 근이 없다 — 데이터를 의심하라')
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2
    if (npv(lo) * npv(mid) <= 0) hi = mid
    else lo = mid
  }
  return ((lo + hi) / 2) * 100
}

/** 곡선 최대낙폭(%) — 평가액 기준 러닝 피크 대비. */
export function curveMddPct(values: readonly number[]): number {
  let peak = -Infinity
  let mdd = 0
  for (const v of values) {
    peak = Math.max(peak, v)
    if (peak > 0) mdd = Math.min(mdd, (v / peak - 1) * 100)
  }
  return mdd
}

/**
 * 비중 시계열 다운샘플 — **곡선과 같은 인덱스**를 남긴다.
 * 화면이 곡선과 비중을 같은 x축에 겹쳐 그리므로, 둘이 다른 점을 남기면 축이 어긋난다.
 */
function downsampleWeights(weights: readonly [number, number, number][]): [number, number, number][] {
  return sampleIdx(weights.length).map((i) => [
    +weights[i][0].toFixed(1),
    +weights[i][1].toFixed(1),
    +weights[i][2].toFixed(1),
  ])
}

async function main(): Promise<void> {
  const key = loadTiingoKey()
  if (!key.value) throw new Error(`TIINGO_API_KEY 없음 — 조용히 빈 산출물을 굽지 않는다${key.help ? ` (${key.help})` : ''}`)
  console.log(`시세 소스: tiingo (키 길이 ${key.value.length}) · 종목 3개`)

  const loaded = new Map<string, { bars: DailyBar[]; audit: TiingoAdjAudit }>()
  for (const sym of LADDER) {
    loaded.set(sym, await loadTicker(sym, key.value))
    await sleep(200)
  }
  // 배당·분할 기준이 종목마다 다르면 알파가 거짓이 된다 — 하나라도 아니면 중단(규칙 4).
  for (const sym of LADDER) {
    const a = loaded.get(sym)!.audit
    if (a.verdict !== 'total')
      throw new Error(`⛔ ${sym} 보정 기준이 총수익이 아니다(${a.verdict}) — ${a.note}. 굽지 않고 중단한다.`)
    console.log(`✅ ${sym} 총수익 기준 확인 — ${a.note}`)
  }

  const aligned = alignBars(new Map([...loaded].map(([s, v]) => [s, v.bars])))
  const base = aligned.get(LADDER_BASE)!
  if (base.length < 500) throw new Error(`교집합이 ${base.length}봉뿐이다 — 산출물을 만들 표본이 아니다`)
  const bench = buyHoldCurve(aligned.get(BENCH)!)
  const benchPerf = perfOf(bench)
  const benchCalmar = calmarOf(benchPerf)
  const mid = midDate(bench)

  // ── 참고 벽 — 옮겨 적지 않고 같은 구간에서 다시 잰다 ─────────────────────
  const walls = LADDER.map((sym) => {
    const p = perfOf(buyHoldCurve(aligned.get(sym)!))
    return {
      symbol: sym,
      label: `${sym} 단순보유`,
      totalPct: +p.total.toFixed(1),
      cagrPct: +p.cagr.toFixed(1),
      mddPct: +p.mdd.toFixed(1),
      calmar: calmarOf(p),
    }
  })

  // ── 프리셋 ────────────────────────────────────────────────────────────────
  const presets = US_LEVERAGE_PRESETS.map((preset) => {
    const run = runProportionalLadder(base, aligned, preset.params, US_LADDER_COST)
    const p = perfOf(run.equity)
    const calmar = calmarOf(p)
    const alpha = alphaOf(run.equity, bench, '', '9999-12-31')
    const a1 = alphaOf(run.equity, bench, '', mid)
    const a2 = alphaOf(run.equity, bench, mid, '9999-12-31')
    const g1 = alpha !== null && alpha > 0
    const g2 = calmar !== null && benchCalmar !== null && calmar > benchCalmar
    const g3 = a1 !== null && a2 !== null && a1 > 0 && a2 > 0
    const why = [g1 ? '' : '알파≤0', g2 ? '' : '칼마≤벤치', g3 ? '' : '반쪽구간'].filter(Boolean)
    return {
      id: preset.id,
      label: preset.label,
      rule: preset.rule,
      note: preset.note,
      params: preset.params,
      totalPct: +p.total.toFixed(1),
      cagrPct: +p.cagr.toFixed(1),
      mddPct: +p.mdd.toFixed(1),
      calmar,
      alphaCagrPct: alpha === null ? null : +alpha.toFixed(1),
      alphaFirstHalfPct: a1 === null ? null : +a1.toFixed(1),
      alphaSecondHalfPct: a2 === null ? null : +a2.toFixed(1),
      trades: run.trades,
      avgWeights: run.avgWeights.map((w) => +w.toFixed(1)),
      gatePass: g1 && g2 && g3,
      gateWhy: why,
      curve: downsample(run.equity, bench),
      // 비중 변화 차트용(스키마 2) — 곡선과 같은 인덱스만 남겨 x축을 공유한다.
      weights: downsampleWeights(run.weightsDaily),
      // 매매 사건 목록 — **현재 화면은 아직 그리지 않는다**(산출물에만 싣는 참고 데이터).
      // 점 찍기를 붙이려면 UsLeveragePanel의 WeightsChart에서 이 필드를 읽으면 된다. 수십 건이라 전량 싣는다.
      events: run.events.map((e) => ({ date: e.date, kind: e.kind, ddPct: +e.ddPct.toFixed(1) })),
    }
  })

  // ── 적립식 요약 — 매일 1만원 ──────────────────────────────────────────────
  const windowYears = Math.max(
    1 / 365,
    (Date.parse(base[base.length - 1].date) - Date.parse(base[0].date)) / (365.25 * 86400e3),
  )

  // 단순 적립 3종은 일별 평가액 곡선까지 만들어 MDD·반원금 근사·IRR을 계산한다(대표 지정 방식).
  const dcaHold = LADDER.map((sym) => {
    const bars = aligned.get(sym)!
    const side = (US_LADDER_COST.feePct + US_LADDER_COST.slippagePct) / 100
    let shares = 0
    let contributed = 0
    const values: number[] = []
    for (const b of bars) {
      shares += (DCA_DAILY * (1 - side)) / b.o
      contributed += DCA_DAILY
      values.push(shares * b.c)
    }
    const finalValue = values[values.length - 1]
    const half = dcaHalfBase(contributed, finalValue, windowYears)
    const mddPct = curveMddPct(values)
    return {
      symbol: sym,
      label: `${sym} 단순 적립`,
      contributed,
      finalValue,
      multiple: +(finalValue / contributed).toFixed(2),
      // 반원금 근사(대표 지정): 유효원금 = 납입액/2. 정확값은 irrPct.
      halfBaseTotalPct: +half.totalPct.toFixed(1),
      halfBaseCagrPct: +half.cagrPct.toFixed(1),
      irrPct: +dcaIrrPct(bars.map((b) => b.date), DCA_DAILY, finalValue).toFixed(1),
      mddPct: +mddPct.toFixed(1),
      calmar: Math.abs(mddPct) > 0.01 ? +(half.cagrPct / Math.abs(mddPct)).toFixed(2) : null,
    }
  })

  const dcaRows = [
    ...dcaHold.map((h) => ({ label: h.label, contributed: h.contributed, finalValue: h.finalValue, multiple: h.multiple })),
    ...US_LEVERAGE_PRESETS.map((preset) => {
      const r = runProportionalLadderDca(base, aligned, preset.params, US_LADDER_COST, DCA_DAILY, 'weights')
      // 같은 이름이 나란히 있으면 무엇이 무엇인지 알 수 없다 — 파라미터로 전부 구분한다.
      const q = preset.params
      const frac = q.tpFracPct !== 10 ? ` · 규모 ${q.tpFracPct}%` : ''
      return {
        label: `사다리 ${q.band1Pct}/${q.band2Pct} · 익절+${q.tpStepPct}%${frac} 적립`,
        contributed: r.contributed,
        finalValue: r.finalValue,
        multiple: +r.multiple.toFixed(2),
      }
    }),
  ].sort((a, b) => b.finalValue - a.finalValue)

  const artifact = {
    schema: US_LEV_SCHEMA,
    asOf: new Date().toISOString(),
    source: 'tiingo',
    basis: 'total',
    basisNote: '분할+배당(총수익) — 전 종목 응답으로 확정',
    window: { from: base[0].date, to: base[base.length - 1].date, bars: base.length },
    downsample: `${DOWNSAMPLE}거래일당 1점 (마지막 점 포함)`,
    cost: { feePct: US_LADDER_COST.feePct, slippagePct: US_LADDER_COST.slippagePct, taxPct: 0 },
    initialCapital: US_LADDER_COST.initialCapital,
    bench: {
      symbol: BENCH,
      label: 'QQQ 단순보유 (알파·칼마 판정 기준)',
      cagrPct: +benchPerf.cagr.toFixed(1),
      mddPct: +benchPerf.mdd.toFixed(1),
      calmar: benchCalmar,
    },
    splitDate: mid,
    walls,
    presets,
    dca: { dailyAmount: DCA_DAILY, rows: dcaRows },
    // 스키마 3: 단순 적립 3종의 상세 지표 — 반원금 근사(대표 지정) + 정확 IRR + MDD.
    dcaHold,
    limits: [
      '환율 미반영 — 원화 투자자 기준 손익이 아니다',
      '세금 미반영 — 미국 배당 원천징수 15% 포함',
      'TQQQ 상장(2010-02-11)이 구간 시작을 정한다 — 닷컴·금융위기가 이 수치에 없다',
      '실측 구간은 QQQ 강세장이며 모든 하락이 회복됐다 — 전략에 구조적으로 유리하다',
    ],
  }

  const root = process.env.REPO_ROOT ?? process.cwd()
  const out = join(root, 'public', 'data', 'us-leverage-precomputed.json')
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, JSON.stringify(artifact, null, 2) + '\n', 'utf8')

  console.log('')
  console.log(`✅ 산출물 기록: ${out}`)
  console.log(`구간 ${artifact.window.from} ~ ${artifact.window.to} (${artifact.window.bars}봉)`)
  console.log(`벤치 QQQ 칼마 ${benchCalmar === null ? '—' : benchCalmar.toFixed(2)}`)
  for (const p of presets)
    console.log(
      `· ${p.id}: CAGR ${p.cagrPct}% · MDD ${p.mddPct}% · 칼마 ${p.calmar === null ? '—' : p.calmar.toFixed(2)} · ` +
        `${p.gatePass ? '✅ 통과' : `❌ ${p.gateWhy.join('·')}`}`,
    )
  const passed = presets.filter((p) => p.gatePass).length
  console.log('')
  console.log(
    passed === 0
      ? '판정: 통과 0 — 산출물에 탈락 사실이 그대로 실렸다. 화면이 이 값을 바꿀 수 없다.'
      : `판정: ${passed}종 통과.`,
  )
}

if (process.env.US_LEV_BAKE === '1') {
  main().catch((e) => {
    console.error(`사전계산 실패: ${String(e)}`)
    process.exit(1)
  })
}

export { perfOf, calmarOf, buyHoldCurve, downsample, DOWNSAMPLE }
