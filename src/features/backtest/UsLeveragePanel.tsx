// QQQ 배수 전략 — **4변수 인터랙티브 시뮬레이터** (읽기 전용 데이터 · 브라우저 재계산).
//
// 2026-08-07 대표 지시로 전면 개편: "15줄이 너무 많아, 값 조정하면서 볼 수 있게 일반화."
// 고정 프리셋 카드·15줄 칼마 비교를 걷어내고, 변수 4개(분할매도 하락비중·횟수,
// 분할매수 상승비중·등분)를 화면에서 조정하면 **그 자리에서 다시 계산**한다.
//
// ── 어떻게 브라우저에서 재계산이 가능한가 (규칙 2-1) ─────────────────────────
//   금지된 것은 tiingo **키**가 프런트엔드에 노출되는 것이다. 그래서 GHA 베이크가
//   일봉(시가·종가)을 산출물에 실어 주고(스키마 4), 브라우저는 그 **데이터**로
//   엔진(runGeneralLadder — 절단 불변성 테스트가 덮는 동일 코드)을 돌린다.
//   키는 여전히 GHA에만 있다. 데이터 신선도는 산출물 기준일에 묶인다.
//
// ── 우아한 강등 ─────────────────────────────────────────────────────────────
//   산출물이 없거나 모르는 스키마면 없는 셈 치고 안내만 띄운다. bars가 없는 구
//   스키마면 시뮬레이터 대신 재베이크 안내를 띄운다. 수치를 지어내지 않는다(규칙 3).

import { useMemo, useState } from 'react'
import { useEffect } from 'react'
import {
  Line,
  LineChart,
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { InfoTip } from '../../components/InfoTip'
import { timeAxisTicks, timeTickFormatter, toTs, tsLong } from '../../components/chartUtils'
import {
  runGeneralLadder,
  US_LADDER_COST,
  type GeneralLadderParams,
} from './leverageLadder'
import type { DailyBar } from '../../lib/history'
import {
  US_LEV_BANNER,
  US_LEV_DATA_URL,
  US_LEV_READ_HINT,
  US_LEV_SUPPORTED_SCHEMAS,
} from './usLeveragePresets'

interface Wall {
  symbol: string
  label: string
  totalPct: number
  cagrPct: number
  mddPct: number
  calmar: number | null
}

interface PresetRow {
  id: string
  label: string
  totalPct: number
  cagrPct: number
  mddPct: number
  calmar: number | null
  alphaCagrPct: number | null
  alphaFirstHalfPct: number | null
  alphaSecondHalfPct: number | null
  trades: number
  avgWeights: number[]
  gatePass: boolean
  gateWhy: string[]
}

interface DcaHoldRow {
  symbol: string
  label: string
  contributed: number
  finalValue: number
  multiple: number
  halfBaseTotalPct: number
  halfBaseCagrPct: number
  irrPct: number
  mddPct: number
  calmar: number | null
}

interface Artifact {
  schema: number
  asOf: string
  source: string
  basisNote: string
  window: { from: string; to: string; bars: number }
  downsample: string
  cost: { feePct: number; slippagePct: number; taxPct: number }
  bench: { symbol: string; label: string; cagrPct: number; mddPct: number; calmar: number | null }
  splitDate: string
  walls: Wall[]
  presets: PresetRow[]
  dca: { dailyAmount: number; rows: { label: string; contributed: number; finalValue: number; multiple: number }[] }
  dcaHold?: DcaHoldRow[]
  /** 스키마 4부터 — 브라우저 재계산용 일봉(시가·종가). */
  bars?: { dates: string[]; series: Record<string, { o: number[]; c: number[] }> }
  /** 스키마 4부터 — 4변수 격자 전수 탐색 칼마 1위(과최적화 경고와 함께 표시). */
  best?: {
    params: GeneralLadderParams
    cagrPct: number
    mddPct: number
    calmar: number
    alphaCagrPct: number
    trades: number
    gridSize: number
  }
  limits: string[]
}

const f1 = (n: number | null | undefined): string => (typeof n === 'number' && Number.isFinite(n) ? n.toFixed(1) : '—')
const f2 = (n: number | null | undefined): string => (typeof n === 'number' && Number.isFinite(n) ? n.toFixed(2) : '—')
const pp = (n: number | null | undefined): string =>
  typeof n === 'number' && Number.isFinite(n) ? `${n >= 0 ? '+' : ''}${n.toFixed(1)}%p` : '—'

function won(n: number): string {
  const eok = Math.floor(n / 100_000_000)
  const man = Math.round((n - eok * 100_000_000) / 10_000)
  return eok > 0 ? `${eok}억 ${man.toLocaleString()}만원` : `${man.toLocaleString()}만원`
}

/** 달러 표기 — 원값 그대로 콤마. 만 단위로 뭉개면 2만까지 변화가 안 보인다(대표 지적). */
function fmtUsd(v: number): string {
  return `$${Math.round(v).toLocaleString()}`
}

/** 배너·note의 md 강조(**)를 화면에서 걷어낸다(문구는 그대로). */
function stripMd(s: string): string {
  return s.replaceAll('**', '')
}

/** '❌ [탈락] … — 진입 10% · 익절 +15% (…)' → '진입 10% · 익절 +15%' */
function tinyLabel(label: string): string {
  const m = label.match(/—\s*(.+)$/)
  return (m ? m[1] : label).split(' (')[0]
}

/** 배수 램프 — index.css에서 라이트·다크 각각 검증된 값. ×1 밝음 → ×3 어두움. */
const MIX_COLORS = ['var(--uslev-x1)', 'var(--uslev-x2)', 'var(--uslev-x3)'] as const
const MIX_LABELS = ['QQQ ×1', 'QLD ×2', 'TQQQ ×3'] as const

function useArtifact(): { data: Artifact | null; state: 'loading' | 'ready' | 'absent' } {
  const [data, setData] = useState<Artifact | null>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'absent'>('loading')
  useEffect(() => {
    let alive = true
    fetch(`${import.meta.env.BASE_URL}${US_LEV_DATA_URL}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((j: Artifact) => {
        if (!alive) return
        if (!US_LEV_SUPPORTED_SCHEMAS.includes(j?.schema)) {
          setState('absent')
          return
        }
        setData(j)
        setState('ready')
      })
      .catch(() => {
        if (alive) setState('absent')
      })
    return () => {
      alive = false
    }
  }, [])
  return { data, state }
}

// ── 성과 계산 (베이크 perfOf와 같은 정의) ────────────────────────────────────
function perfOf(equity: readonly { date: string; equity: number }[]): {
  totalPct: number
  cagrPct: number
  mddPct: number
} {
  const start = equity[0].equity
  const end = equity[equity.length - 1].equity
  let peak = start
  let mdd = 0
  for (const e of equity) {
    if (e.equity > peak) peak = e.equity
    else mdd = Math.min(mdd, (e.equity / peak - 1) * 100)
  }
  const years = Math.max(
    1 / 365,
    (Date.parse(equity[equity.length - 1].date) - Date.parse(equity[0].date)) / (365.25 * 86400e3),
  )
  const ratio = Math.max(end / start, 1e-9)
  return { totalPct: (ratio - 1) * 100, cagrPct: (Math.pow(ratio, 1 / years) - 1) * 100, mddPct: mdd }
}

// ── 파라미터 컨트롤 ──────────────────────────────────────────────────────────
function Ctrl({
  label,
  value,
  min,
  max,
  step,
  unit,
  onChange,
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  unit: string
  onChange: (v: number) => void
}) {
  return (
    <label className="uslev-ctrl">
      <span className="uslev-ctrl-label">{label}</span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
      <span className="uslev-ctrl-value">
        {value}
        {unit}
      </span>
    </label>
  )
}

/** 비중 변화 누적영역 — 현재 조합의 일별 비중(엔진 출력 그대로, 다운샘플만). */
function WeightsChartG({ dates, weights }: { dates: string[]; weights: [number, number, number][] }) {
  const rows = useMemo(() => {
    const out: { date: string; ts: number; q: number; l: number; t: number }[] = []
    for (let i = 0; i < dates.length; i++) {
      if (i % 5 !== 0 && i !== dates.length - 1) continue
      out.push({ date: dates[i], ts: toTs(dates[i]), q: weights[i][0], l: weights[i][1], t: weights[i][2] })
    }
    return out
  }, [dates, weights])
  if (rows.length < 2) return null
  const ds = rows.map((r) => r.date)
  const ticks = timeAxisTicks(ds)
  const fmt = timeTickFormatter(ds)

  const WTooltip = ({ active, payload }: any) => {
    if (!active || !payload?.length) return null
    const p = payload[0]?.payload as (typeof rows)[number]
    return (
      <div className="recharts-default-tooltip">
        <div className="tooltip-label">{tsLong(p.ts)}</div>
        <div style={{ fontSize: 13 }}>
          {MIX_LABELS.map((l, i) => (
            <div key={l}>
              <i className="uslev-swatch" style={{ background: MIX_COLORS[i] }} />
              {l}: <strong>{[p.q, p.l, p.t][i].toFixed(0)}%</strong>
            </div>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="bt-chart-block">
      <div className="uslev-chart-title">
        비중 변화 (QQQ ↔ QLD ↔ TQQQ)
        <InfoTip text="그날 종가 평가 기준 보유 비중입니다. 계단처럼 꺾이는 곳이 매매이고, 완만한 변화는 가격 변동에 따른 자연 이동입니다. 어두운 파랑일수록 레버리지 배수가 높습니다." />
      </div>
      <ResponsiveContainer width="100%" height={140}>
        <AreaChart data={rows} margin={{ top: 4, right: 12, left: 4, bottom: 0 }}>
          <CartesianGrid stroke="var(--border)" vertical={false} />
          <XAxis dataKey="ts" type="number" scale="time" domain={['dataMin', 'dataMax']} ticks={ticks} tickFormatter={fmt} tickLine={false} axisLine={{ stroke: 'var(--border)' }} />
          <YAxis domain={[0, 100]} ticks={[0, 50, 100]} tickFormatter={(v) => `${v}%`} tickLine={false} axisLine={false} width={40} />
          <Tooltip content={<WTooltip />} cursor={{ stroke: 'var(--text-faint)', strokeDasharray: '3 3' }} />
          <Area type="stepAfter" dataKey="q" stackId="w" name={MIX_LABELS[0]} fill="var(--uslev-x1)" fillOpacity={1} stroke="var(--panel)" strokeWidth={1.5} isAnimationActive={false} />
          <Area type="stepAfter" dataKey="l" stackId="w" name={MIX_LABELS[1]} fill="var(--uslev-x2)" fillOpacity={1} stroke="var(--panel)" strokeWidth={1.5} isAnimationActive={false} />
          <Area type="stepAfter" dataKey="t" stackId="w" name={MIX_LABELS[2]} fill="var(--uslev-x3)" fillOpacity={1} stroke="var(--panel)" strokeWidth={1.5} isAnimationActive={false} />
        </AreaChart>
      </ResponsiveContainer>
      <div className="uslev-mixbar-caption">
        {MIX_LABELS.map((l, i) => (
          <span key={l}>
            <i className="uslev-swatch" style={{ background: MIX_COLORS[i] }} />
            {l}
          </span>
        ))}
      </div>
    </div>
  )
}

// ── 4변수 시뮬레이터 ─────────────────────────────────────────────────────────
function GeneralSimulator({ data }: { data: Artifact }) {
  // 기본값 = 대표 지시 원 전략 (−10%마다 2회 · +10%마다 1/10)
  const [dropStep, setDropStep] = useState(10)
  const [sellN, setSellN] = useState(2)
  const [riseStep, setRiseStep] = useState(10)
  const [buyM, setBuyM] = useState(10)

  const bars = data.bars
  // 일봉 복원 + 단순보유 3종 곡선(한 번만). 엔진은 시가·종가만 쓴다.
  const built = useMemo(() => {
    if (!bars) return null
    const mk = (sym: string): DailyBar[] =>
      bars.dates.map((date, i) => {
        const o = bars.series[sym].o[i]
        const c = bars.series[sym].c[i]
        return { date, t: 0, o, h: Math.max(o, c), l: Math.min(o, c), c, v: 0 }
      })
    const q = mk('QQQ')
    const map = new Map<string, DailyBar[]>([
      ['QQQ', q],
      ['QLD', mk('QLD')],
      ['TQQQ', mk('TQQQ')],
    ])
    const side = (US_LADDER_COST.feePct + US_LADDER_COST.slippagePct) / 100
    const hold = (sym: string) => {
      const bs = map.get(sym)!
      const shares = (US_LADDER_COST.initialCapital * (1 - side)) / bs[0].o
      return bs.map((b) => ({ date: b.date, equity: shares * b.c }))
    }
    const holds = { QQQ: hold('QQQ'), QLD: hold('QLD'), TQQQ: hold('TQQQ') }
    return { map, base: q, holds, holdPerf: { QQQ: perfOf(holds.QQQ), QLD: perfOf(holds.QLD), TQQQ: perfOf(holds.TQQQ) } }
  }, [bars])

  const run = useMemo(() => {
    if (!built) return null
    return runGeneralLadder(
      built.base,
      built.map,
      { dropStepPct: dropStep, sellTranches: sellN, riseStepPct: riseStep, buyTranches: buyM },
      US_LADDER_COST,
    )
  }, [built, dropStep, sellN, riseStep, buyM])

  if (!bars || !built || !run)
    return (
      <p className="uslev-caption">
        이 산출물(스키마 {data.schema})에는 일봉 데이터가 없어 시뮬레이터를 켤 수 없습니다. GHA에서{' '}
        <code>MODE=lev:bake</code>를 다시 돌리면 생깁니다. 수치를 추정해 채우지 않습니다.
      </p>
    )

  const perf = perfOf(run.equity)
  const calmar = Math.abs(perf.mddPct) > 0.01 ? perf.cagrPct / Math.abs(perf.mddPct) : null
  const alphaPct = perf.cagrPct - built.holdPerf.QQQ.cagrPct
  const benchCalmar =
    Math.abs(built.holdPerf.QQQ.mddPct) > 0.01 ? built.holdPerf.QQQ.cagrPct / Math.abs(built.holdPerf.QQQ.mddPct) : null
  const pass = calmar != null && benchCalmar != null && calmar > benchCalmar

  // 차트 행 — 5거래일당 1점 + 마지막 점
  const rows: { date: string; ts: number; combo: number; qqq: number; qld: number; tqqq: number }[] = []
  for (let i = 0; i < run.equity.length; i++) {
    if (i % 5 !== 0 && i !== run.equity.length - 1) continue
    rows.push({
      date: run.equity[i].date,
      ts: toTs(run.equity[i].date),
      combo: Math.round(run.equity[i].equity),
      qqq: Math.round(built.holds.QQQ[i].equity),
      qld: Math.round(built.holds.QLD[i].equity),
      tqqq: Math.round(built.holds.TQQQ[i].equity),
    })
  }
  const ds = rows.map((r) => r.date)
  const ticks = timeAxisTicks(ds)
  const fmt = timeTickFormatter(ds)

  const applyBest = () => {
    if (!data.best) return
    setDropStep(data.best.params.dropStepPct)
    setSellN(data.best.params.sellTranches)
    setRiseStep(data.best.params.riseStepPct)
    setBuyM(data.best.params.buyTranches)
  }
  const isBestApplied =
    data.best != null &&
    dropStep === data.best.params.dropStepPct &&
    sellN === data.best.params.sellTranches &&
    riseStep === data.best.params.riseStepPct &&
    buyM === data.best.params.buyTranches

  const STooltip = ({ active, payload }: any) => {
    if (!active || !payload?.length) return null
    const p = payload[0]?.payload as (typeof rows)[number]
    return (
      <div className="recharts-default-tooltip">
        <div className="tooltip-label">{tsLong(p.ts)}</div>
        <div style={{ fontSize: 13 }}>
          <div>내 조합: <strong>{fmtUsd(p.combo)}</strong></div>
          <div>QQQ: {fmtUsd(p.qqq)} · QLD: {fmtUsd(p.qld)} · TQQQ: {fmtUsd(p.tqqq)}</div>
        </div>
      </div>
    )
  }

  return (
    <div className="uslev-sim">
      {/* ── 컨트롤 4개 ─────────────────────────────────────────────────── */}
      <div className="uslev-ctrls">
        <Ctrl label="QQQ 분할매도 하락비중 (고점 대비 −X%마다 1회)" value={dropStep} min={2} max={30} step={1} unit="%" onChange={setDropStep} />
        <Ctrl label="분할매도 횟수 (앞 절반 QLD → 뒤 절반 TQQQ)" value={sellN} min={1} max={6} step={1} unit="회" onChange={setSellN} />
        <Ctrl label="QQQ 분할매수 상승비중 (직전 매매가 대비 +Y%마다 1회)" value={riseStep} min={2} max={30} step={1} unit="%" onChange={setRiseStep} />
        <Ctrl label="분할매수 등분 (1회에 레버리지의 1/M)" value={buyM} min={1} max={20} step={1} unit="등분" onChange={setBuyM} />
      </div>
      <div className="uslev-sim-actions">
        <button type="button" className="bt-btn-mini" onClick={() => { setDropStep(10); setSellN(2); setRiseStep(10); setBuyM(10) }}>
          원 전략(10%·2회·10%·10등분)
        </button>
        {data.best && (
          <button type="button" className={`bt-btn-mini${isBestApplied ? ' uslev-best-on' : ''}`} onClick={applyBest}>
            칼마 1위 조합 적용 — 격자 {data.best.gridSize.toLocaleString()}개 중 칼마 {f2(data.best.calmar)}
          </button>
        )}
      </div>
      {isBestApplied && (
        <p className="uslev-caption" style={{ color: 'var(--uslev-warn)' }}>
          ⚠️ 격자 {data.best!.gridSize.toLocaleString()}조합 중 1등을 고르는 것 자체가 <strong>과최적화</strong>입니다 —
          이 조합은 "이 구간에서 가장 운이 좋았던 값"이지 미래 기댓값이 아닙니다.
        </p>
      )}

      {/* ── 결과 스탯 ─────────────────────────────────────────────────── */}
      <div className="uslev-stats uslev-sim-stats">
        <div className="uslev-stat"><span className="lbl">CAGR</span><span className="val">{f1(perf.cagrPct)}%</span></div>
        <div className="uslev-stat"><span className="lbl">MDD</span><span className="val neg">{f1(perf.mddPct)}%</span></div>
        <div className="uslev-stat"><span className="lbl">칼마</span><span className="val">{f2(calmar)}</span></div>
        <div className="uslev-stat"><span className="lbl">알파(vs QQQ)</span><span className="val">{pp(alphaPct)}</span></div>
        <div className="uslev-stat"><span className="lbl">매매</span><span className="val">{run.trades}회</span></div>
        <div className="uslev-stat">
          <span className="lbl">칼마 관문(벤치 {f2(benchCalmar)})</span>
          <span className={`val ${pass ? '' : 'neg'}`}>{pass ? '✅ 통과' : '❌ 미달'}</span>
        </div>
      </div>

      {/* ── 자산곡선 — 기본 3종 위에 내 조합 ───────────────────────────── */}
      <div className="uslev-chart-title">
        자산곡선 (초기 $10,000 · 로그축)
        <InfoTip text="세로축은 로그 눈금입니다 — TQQQ와 QQQ의 규모 차이가 수십 배라 선형축에서는 비교가 안 됩니다. 로그축에서는 기울기가 수익률이고 같은 간격이 같은 배율입니다." />
      </div>
      <div className="bt-chart-block">
        <ResponsiveContainer width="100%" height={260}>
          <LineChart data={rows} margin={{ top: 8, right: 12, left: 4, bottom: 0 }}>
            <CartesianGrid stroke="var(--border)" vertical={false} />
            <XAxis dataKey="ts" type="number" scale="time" domain={['dataMin', 'dataMax']} ticks={ticks} tickFormatter={fmt} tickLine={false} axisLine={{ stroke: 'var(--border)' }} />
            <YAxis scale="log" domain={['auto', 'auto']} tickFormatter={fmtUsd} tickLine={false} axisLine={false} width={78} />
            <Tooltip content={<STooltip />} cursor={{ stroke: 'var(--text-faint)', strokeDasharray: '3 3' }} />
            <Line type="monotone" dataKey="qqq" name="QQQ" stroke="var(--uslev-x1)" strokeWidth={1.3} dot={false} isAnimationActive={false} />
            <Line type="monotone" dataKey="qld" name="QLD" stroke="var(--uslev-x2)" strokeWidth={1.3} dot={false} isAnimationActive={false} />
            <Line type="monotone" dataKey="tqqq" name="TQQQ" stroke="var(--uslev-x3)" strokeWidth={1.3} dot={false} isAnimationActive={false} />
            <Line type="monotone" dataKey="combo" name="내 조합" stroke="var(--uslev-combo)" strokeWidth={2.4} dot={false} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <p className="uslev-caption">
        <i className="uslev-swatch" style={{ background: 'var(--uslev-combo)' }} /> <strong>내 조합</strong> ·{' '}
        {MIX_LABELS.map((l, i) => (
          <span key={l}>
            <i className="uslev-swatch" style={{ background: MIX_COLORS[i] }} />
            {l}{' '}
          </span>
        ))}
        — 단순보유 CAGR: QQQ {f1(built.holdPerf.QQQ.cagrPct)}% · QLD {f1(built.holdPerf.QLD.cagrPct)}% · TQQQ{' '}
        {f1(built.holdPerf.TQQQ.cagrPct)}% (MDD {f1(built.holdPerf.QQQ.mddPct)} / {f1(built.holdPerf.QLD.mddPct)} /{' '}
        {f1(built.holdPerf.TQQQ.mddPct)}%)
      </p>

      <WeightsChartG dates={run.equity.map((e) => e.date)} weights={run.weightsDaily} />
    </div>
  )
}

export function UsLeveragePanel() {
  const { data, state } = useArtifact()

  if (state === 'loading') return <div className="panel">불러오는 중…</div>

  if (state === 'absent' || !data)
    return (
      <div className="panel">
        <div className="panel-head">
          <h2>📊 QQQ 배수 전략 시뮬레이터</h2>
          <span className="badge sample">산출물 없음</span>
        </div>
        <p>
          사전계산 산출물(<code>{US_LEV_DATA_URL}</code>)이 아직 없습니다. GHA에서{' '}
          <code>backtest.yml · MODE=lev:bake</code>를 한 번 돌리면 생성됩니다. <strong>수치를 추정해 채우지
          않습니다</strong> — 없으면 없다고만 표시합니다.
        </p>
      </div>
    )

  const dcaRows = data.dca.rows.map((r) => ({
    name: r.label.replace(/ 적립$/, ''),
    multiple: r.multiple,
    ladder: r.label.includes('사다리'),
    finalValue: r.finalValue,
  }))
  const bestSimple = Math.max(0, ...dcaRows.filter((r) => !r.ladder).map((r) => r.multiple))
  const bestLadder = Math.max(0, ...dcaRows.filter((r) => r.ladder).map((r) => r.multiple))
  const dcaVerdict =
    bestLadder > 0 && bestSimple > 0
      ? bestLadder < bestSimple
        ? `사다리 최고 ${bestLadder.toFixed(1)}배 < 단순 적립 최고 ${bestSimple.toFixed(1)}배 — 이 실측에서 사다리는 최상위 단순 적립을 넘지 못했습니다.`
        : `사다리 최고 ${bestLadder.toFixed(1)}배 ≥ 단순 적립 최고 ${bestSimple.toFixed(1)}배.`
      : null

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>
          📊 QQQ 배수 전략 시뮬레이터
          <InfoTip text="평시 QQQ를 들고 있다가 낙폭이 깊어지면 나눠서 레버리지로 갈아타고, 오르면 나눠서 되돌아오는 전략을 변수 4개로 조정하며 실측 데이터 위에서 바로 재계산합니다. 모의 시뮬레이션이며 실주문과 연결되지 않습니다." />
        </h2>
        <span className="badge sample">실측 일봉 · 브라우저 재계산 · 실주문 없음</span>
      </div>

      <div className="panel-sub" style={{ color: 'var(--uslev-warn)', fontWeight: 600 }}>{stripMd(US_LEV_BANNER)}</div>
      <div className="panel-sub">{stripMd(US_LEV_READ_HINT)}</div>

      <div className="panel-sub uslev-meta">
        구간 <strong>{data.window.from} ~ {data.window.to}</strong> ({data.window.bars.toLocaleString()}봉) · 시세{' '}
        <strong>{data.source}</strong> · {data.basisNote} · 비용 편도 {data.cost.feePct}% + 슬리피지{' '}
        {data.cost.slippagePct}% · 기준일 {data.asOf.slice(0, 10)}
      </div>

      <GeneralSimulator data={data} />

      {/* ── 적립식 ─────────────────────────────────────────────────────── */}
      <div className="uslev-chart-title">
        매일 {data.dca.dailyAmount.toLocaleString()}원 적립했다면 — 원금 대비 배수
        <InfoTip text="구간 내내 매일 같은 금액을 사기만 했을 때의 최종 평가액 ÷ 누적 원금입니다. 파란 막대가 단순 적립, 회색 막대가 사다리 전략 적립(고정 격자 9종)입니다." />
      </div>
      <div className="bt-chart-block">
        <ResponsiveContainer width="100%" height={40 + dcaRows.length * 34}>
          <BarChart data={dcaRows} layout="vertical" margin={{ top: 4, right: 52, left: 4, bottom: 4 }}>
            <CartesianGrid stroke="var(--border)" horizontal={false} />
            <XAxis type="number" tickLine={false} axisLine={{ stroke: 'var(--border)' }} tickFormatter={(v) => `${v}배`} />
            <YAxis type="category" dataKey="name" width={148} tickLine={false} axisLine={false} tick={{ fontSize: 11 }} />
            <Tooltip
              cursor={{ fill: 'var(--panel-2)' }}
              formatter={(v: number, _n, item) => [`${v.toFixed(2)}배 · 최종 ${won((item?.payload as { finalValue: number }).finalValue)}`, '원금 대비']}
            />
            <Bar dataKey="multiple" barSize={16} radius={[0, 4, 4, 0]} isAnimationActive={false}>
              {dcaRows.map((r, i) => (
                <Cell key={`${i}-${r.name}`} fill={r.ladder ? 'var(--text-faint)' : 'var(--uslev-x2)'} />
              ))}
              <LabelList dataKey="multiple" position="right" formatter={(v: number) => `${v.toFixed(1)}배`} className="uslev-bar-label" />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
      <p className="uslev-caption">
        <i className="uslev-swatch" style={{ background: 'var(--uslev-x2)' }} /> 단순 적립 ·{' '}
        <i className="uslev-swatch" style={{ background: 'var(--text-faint)' }} /> 사다리 전략 적립 · 누적 원금{' '}
        {won(data.dca.rows[0]?.contributed ?? 0)} 동일{dcaVerdict && <> · {dcaVerdict}</>}
      </p>

      {/* ── 단순 적립 상세 — 반원금 근사(대표 지정) + 정확 IRR ─────────── */}
      {data.dcaHold && data.dcaHold.length > 0 && (
        <>
          <div className="uslev-chart-title">
            매일 적립 상세 — 반원금 근사 수익률
            <InfoTip text="매일 같은 금액을 넣으면 투자원금이 0에서 총 납입액까지 선형으로 늘어나므로, 시간으로 적분한 평균 투자원금은 총 납입액의 절반입니다. 대표 지정 방식대로 그 절반을 원금으로 보고 수익률과 CAGR을 계산했습니다. 근사값이며, 현금흐름을 정확히 반영한 IRR을 오른쪽에 병기합니다." />
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table className="tbl">
              <thead>
                <tr>
                  <th>종목</th>
                  <th>납입액</th>
                  <th>최종 평가액</th>
                  <th>수익률<br />(반원금)</th>
                  <th>CAGR<br />(반원금)</th>
                  <th>IRR<br />(정확)</th>
                  <th>MDD</th>
                  <th>칼마<br />[근사]</th>
                </tr>
              </thead>
              <tbody>
                {data.dcaHold.map((h) => (
                  <tr key={h.symbol}>
                    <td><strong>{h.symbol}</strong> 적립</td>
                    <td>{won(h.contributed)}</td>
                    <td><strong>{won(h.finalValue)}</strong></td>
                    <td>{h.halfBaseTotalPct >= 0 ? '+' : ''}{h.halfBaseTotalPct.toLocaleString()}%</td>
                    <td><strong>{f1(h.halfBaseCagrPct)}%</strong></td>
                    <td>{f1(h.irrPct)}%</td>
                    <td style={{ color: 'var(--danger)' }}>{f1(h.mddPct)}%</td>
                    <td>{f2(h.calmar)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="uslev-caption">
            반원금 근사(유효원금 = 납입액 ÷ 2)는 대표 지정 방식입니다. 정확한 연수익률은 IRR 열입니다 — 두 값의
            차이가 근사 오차입니다. MDD는 일별 평가액 곡선의 고점 대비 최대낙폭입니다.
          </p>
        </>
      )}

      {/* ── 원자료 표 (접근성 표 뷰) ────────────────────────────────────── */}
      <details className="uslev-tables">
        <summary>표로 보기 (고정 격자 9종·단순보유 원자료)</summary>
        <div style={{ overflowX: 'auto' }}>
          <table className="tbl">
            <thead>
              <tr>
                <th>조합</th>
                <th>총수익</th>
                <th>CAGR</th>
                <th>MDD</th>
                <th>칼마</th>
                <th>알파</th>
                <th>전반</th>
                <th>후반</th>
                <th>매매</th>
                <th>판정</th>
              </tr>
            </thead>
            <tbody>
              {data.presets.map((p) => (
                <tr key={p.id}>
                  <td>{tinyLabel(p.label)}</td>
                  <td>{f1(p.totalPct)}%</td>
                  <td>{f1(p.cagrPct)}%</td>
                  <td style={{ color: 'var(--danger)' }}>{f1(p.mddPct)}%</td>
                  <td><strong>{f2(p.calmar)}</strong></td>
                  <td>{pp(p.alphaCagrPct)}</td>
                  <td>{pp(p.alphaFirstHalfPct)}</td>
                  <td>{pp(p.alphaSecondHalfPct)}</td>
                  <td>{p.trades}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>{p.gatePass ? '✅ 통과' : `❌ ${p.gateWhy.join('·')}`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table className="tbl">
            <thead>
              <tr>
                <th>기준선</th>
                <th>총수익</th>
                <th>CAGR</th>
                <th>MDD</th>
                <th>칼마</th>
              </tr>
            </thead>
            <tbody>
              {data.walls.map((w) => (
                <tr key={w.symbol}>
                  <td>{w.label}</td>
                  <td>{f1(w.totalPct)}%</td>
                  <td><strong>{f1(w.cagrPct)}%</strong></td>
                  <td style={{ color: 'var(--danger)' }}>{f1(w.mddPct)}%</td>
                  <td>{f2(w.calmar)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>

      {/* ── 한계 ───────────────────────────────────────────────────────── */}
      <h3>이 수치의 한계</h3>
      <ul style={{ fontSize: '0.85em', lineHeight: 1.7 }}>
        {data.limits.map((l) => (
          <li key={l}>{l}</li>
        ))}
        <li>
          시뮬레이터의 시세는 <strong>산출물에 실린 일봉</strong>(기준일 {data.asOf.slice(0, 10)})입니다 — 실시간이
          아니며, tiingo <strong>키는 브라우저에 없습니다</strong>(데이터만 GHA가 굽습니다).
        </li>
        <li>
          변수를 움직여 좋은 값을 찾는 행위 자체가 <strong>과최적화</strong>입니다 — 여기서 찾은 조합은 "이 구간에서
          운이 좋았던 값"이지 미래 기댓값이 아닙니다(규칙 4). 매매를 붙이지 마십시오.
        </li>
      </ul>
      <p style={{ fontSize: '0.8em', opacity: 0.75 }}>
        위 수치는 과거 데이터 기반 시뮬레이션이며 미래 수익을 보장하지 않습니다. 투자자문이 아닙니다. 레버리지
        ETF는 일간 배수를 추종하므로 횡보장에서 변동성 잠식이 누적되고, 3배 상품은 하루 −33.4%에서 이론상 전액
        소멸합니다.
      </p>
    </div>
  )
}
