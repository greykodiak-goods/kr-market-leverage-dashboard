// QQQ 배수 전략 프리셋 화면 — **읽기 전용 패널**.
//
// 2026-08-06 대표 지시로 등재. 43차 실측에서 관문 통과 0(990변형)이었고 나는 등재에
// 반대했으나 대표가 결과를 보고 확정했다. 그래서 **탈락 사실을 먼저 보여주는 형태**로 올린다.
//
// 2026-08-06 모바일 개편(대표 지시): 열 11개짜리 표가 좁은 화면에서 셀마다 줄바꿈돼
// 깨졌다. 기본 화면에서 표를 전부 걷어내고 ①칼마 관문 막대 ②프리셋 카드(스탯+평균
// 비중 스택바) ③비중 변화 누적영역 차트 ④단순보유 CAGR/MDD 다이버징 막대 ⑤적립식
// 배수 막대로 바꿨다. 원자료 표는 <details>(표로 보기)에 그대로 남긴다 — 차트는
// 보조 수단이고 수치의 정본은 표·산출물이다(접근성 표 뷰 겸용).
//
// 색: QQQ→QLD→TQQQ는 **한 색상(파랑)의 밝기 순서 램프**다 — 레버리지 배수가 높을수록
// 어둡다. 색약·흑백에서도 순서가 읽히도록 검증기(dataviz validate_palette --ordinal)를
// 라이트·다크 표면 각각에 대해 통과시킨 값이며 index.css의 --uslev-x1·x2·x3에 있다.
// 범례에 ×1/×2/×3을 병기해 정체가 색에만 실리지 않게 한다.
//
// ── 왜 "직접 다시 돌리기"가 없나 ────────────────────────────────────────────
//   시세가 tiingo라 브라우저에서 부르면 API 키가 프런트엔드에 노출된다(규칙 2-1 위반).
//   그래서 GHA에서 굽고(`scripts/us-leverage-precompute.entry.ts`) 여기서는 읽기만 한다.
//   기능 누락이 아니라 **키를 안 내보내려는 설계**이며, 그 사실을 화면에 적는다.
//
// ── 우아한 강등 ─────────────────────────────────────────────────────────────
//   산출물이 없거나 모르는 스키마면 **없는 셈 치고** 안내만 띄운다. 수치를 지어내지 않는다.
//   비중 차트는 스키마 2부터 오는 데이터라, 구(舊) 산출물이면 그 차트만 조용히 뺀다.
//   라벨의 숫자는 전부 산출물에서 온다 — 이 파일에 하드코딩된 성적은 하나도 없다(규칙 3).

import { useEffect, useState } from 'react'
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { EquityChart, type EquityRow } from './EquityChart'
import { InfoTip } from '../../components/InfoTip'
import { timeAxisTicks, timeTickFormatter, toTs, tsLong } from '../../components/chartUtils'
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
  rule: string
  note: string
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
  curve: [string, number, number][]
  /** 스키마 2부터 — 곡선과 같은 인덱스의 일별 비중(% · QQQ/QLD/TQQQ). 없으면 차트를 안 그린다. */
  weights?: [number, number, number][]
  /** 스키마 2부터 — 매매 사건 목록(참고). */
  events?: { date: string; kind: string; ddPct: number }[]
}

/** 스키마 3부터 — 단순 적립 상세. 반원금 근사(대표 지정 방식)와 정확 IRR을 나란히 든다. */
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
  /** 스키마 3부터 — 없으면 관련 표시를 뺀다(지어내지 않는다). */
  dcaHold?: DcaHoldRow[]
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

/** '❌ [탈락] QQQ 배수 사다리 — 밴드 10% (…)' → '밴드 10% (…)' — 카드 배지가 판정을 따로 들므로 짧게. */
function shortLabel(label: string): string {
  const m = label.match(/—\s*(.+)$/)
  return m ? m[1] : label
}

/** 차트 축용 초단축 이름 — 괄호 상세를 떼어낸다('밴드 10% (…)' → '밴드 10%'). 겹침 방지. */
function tinyLabel(label: string): string {
  return shortLabel(label).split(' (')[0]
}

/** 배너·note는 md 강조(**)를 담고 있다 — 화면에서는 별표를 걷어낸다(문구는 그대로). */
function stripMd(s: string): string {
  return s.replaceAll('**', '')
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
        // 모르는 스키마면 없는 셈 친다 — 잘못 읽어 거짓 수치를 띄우느니 안 띄운다.
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

/** 평균 비중 스택바 — 카드 안에서 "평시 무엇을 들고 있었나"를 한 줄로 보여준다. */
function MixBar({ weights }: { weights: number[] }) {
  return (
    <div>
      <div className="uslev-mixbar" role="img" aria-label={`평균 비중 ${MIX_LABELS.map((l, i) => `${l} ${Math.round(weights[i] ?? 0)}%`).join(', ')}`}>
        {weights.slice(0, 3).map((w, i) => (
          <span key={i} style={{ width: `${Math.max(0, w)}%`, background: MIX_COLORS[i] }} />
        ))}
      </div>
      <div className="uslev-mixbar-caption">
        {MIX_LABELS.map((l, i) => (
          <span key={l}>
            <i className="uslev-swatch" style={{ background: MIX_COLORS[i] }} />
            {l} {Math.round(weights[i] ?? 0)}%
          </span>
        ))}
      </div>
    </div>
  )
}

/** 비중 변화 누적영역 차트 — "언제 얼마나 옮겼는지"를 시간축으로 보여준다(스키마 2+). */
function WeightsChart({ preset }: { preset: PresetRow }) {
  const w = preset.weights
  if (!w || w.length !== preset.curve.length || w.length < 2) return null
  const dates = preset.curve.map(([d]) => d)
  // x축은 **숫자 시간축**(ts) — 문자열 카테고리 축에 ms 눈금을 꽂으면 눈금이 하나도 안 그려진다(검수 실측).
  const rows = preset.curve.map(([date], i) => ({
    date,
    ts: toTs(date),
    q: w[i][0],
    l: w[i][1],
    t: w[i][2],
  }))
  const ticks = timeAxisTicks(dates)
  const fmt = timeTickFormatter(dates)

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
        <InfoTip text="그날 종가 평가 기준 보유 비중입니다. 계단처럼 꺾이는 곳이 매매(진입·익절·신고가 정리)이고, 완만한 변화는 가격 변동에 따른 자연 이동입니다. 어두운 파랑일수록 레버리지 배수가 높습니다." />
      </div>
      <ResponsiveContainer width="100%" height={150}>
        <AreaChart data={rows} margin={{ top: 4, right: 12, left: 4, bottom: 0 }} syncId="bt-sync">
          <CartesianGrid stroke="var(--border)" vertical={false} />
          <XAxis
            dataKey="ts"
            type="number"
            scale="time"
            domain={['dataMin', 'dataMax']}
            ticks={ticks}
            tickFormatter={fmt}
            tickLine={false}
            axisLine={{ stroke: 'var(--border)' }}
          />
          <YAxis domain={[0, 100]} ticks={[0, 50, 100]} tickFormatter={(v) => `${v}%`} tickLine={false} axisLine={false} width={40} />
          <Tooltip content={<WTooltip />} cursor={{ stroke: 'var(--text-faint)', strokeDasharray: '3 3' }} />
          {/* 스택 순서: 아래부터 ×1 → ×3. 경계선은 패널색 1.5px — 띠 사이를 흰 여백이 가른다. */}
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

export function UsLeveragePanel() {
  const { data, state } = useArtifact()
  const [openId, setOpenId] = useState<string | null>(null)

  if (state === 'loading') return <div className="panel">불러오는 중…</div>

  if (state === 'absent' || !data)
    return (
      <div className="panel">
        <div className="panel-head">
          <h2>📊 QQQ 배수 전략 프리셋</h2>
          <span className="badge sample">산출물 없음</span>
        </div>
        <p>
          사전계산 산출물(<code>{US_LEV_DATA_URL}</code>)이 아직 없습니다. GHA에서{' '}
          <code>backtest.yml · MODE=lev:bake</code>를 한 번 돌리면 생성됩니다. <strong>수치를 추정해 채우지
          않습니다</strong> — 없으면 없다고만 표시합니다.
        </p>
      </div>
    )

  const open = data.presets.find((p) => p.id === openId) ?? null
  // 곡선 아래 낙폭 밴드는 **다운샘플 곡선**에서 계산한다(표시용) — 카드의 MDD는 원곡선 기준이며 그 사실을 문구로 밝힌다.
  let ddPeak = -Infinity
  const rows: EquityRow[] = open
    ? open.curve.map(([date, equity, benchmark]) => {
        ddPeak = Math.max(ddPeak, equity)
        return { date, equity, benchmark, drawdownPct: (equity / ddPeak - 1) * 100 }
      })
    : []

  // ── 칼마 관문 차트 데이터 — 이 화면의 결론을 첫 그림으로 ──────────────────
  // 사다리 9종 + 단순보유 3종 + 적립식 3종(대표 지시)을 **한 축**에 세운다.
  // 칼마 null(MDD≈0이라 정의 불가)을 0으로 그리면 없는 수치를 지어내는 것이다(규칙 3) — 차트에서 뺀다.
  // 적립식 칼마는 반원금 근사 CAGR ÷ |MDD| — 근사임을 이름에 박는다.
  const calmarRows = [
    ...data.presets
      .filter((p) => p.calmar != null)
      .map((p) => ({ name: tinyLabel(p.label), calmar: p.calmar as number, cls: 'ladder' as const })),
    ...data.walls
      .filter((w) => w.calmar != null)
      .map((w) => ({ name: `${w.symbol} 단순보유`, calmar: w.calmar as number, cls: 'hold' as const })),
    ...(data.dcaHold ?? [])
      .filter((h) => h.calmar != null)
      .map((h) => ({ name: `${h.symbol} 적립 [근사]`, calmar: h.calmar as number, cls: 'dca' as const })),
  ].sort((a, b) => b.calmar - a.calmar)
  const calmarSkipped = data.presets.filter((p) => p.calmar == null).length
  const benchCalmar = data.bench.calmar
  const CLS_COLOR = { ladder: 'var(--uslev-x2)', hold: 'var(--kosdaq)', dca: 'var(--text-faint)' } as const
  // 캡션 결론은 하드코딩하지 않는다 — 재베이크에서 통과가 나오면 화면이 자기모순이 된다(검수 지적).
  const passCount = data.presets.filter((p) => p.gatePass).length
  const allAlphaPositive = data.presets.length > 0 && data.presets.every((p) => (p.alphaCagrPct ?? 0) > 0)

  // ── 단순보유 벽 — CAGR(오른쪽)·MDD(왼쪽) 다이버징 ─────────────────────────
  const wallRows = data.walls.map((w) => ({ name: w.label.replace(' 단순보유', ''), cagr: w.cagrPct, mdd: w.mddPct }))

  // ── 적립식 — 배수 막대. 단순 적립=파랑, 사다리=회색 ──────────────────────
  const dcaRows = data.dca.rows.map((r) => ({
    name: r.label.replace(/ 적립$/, ''),
    multiple: r.multiple,
    ladder: r.label.includes('사다리'),
    finalValue: r.finalValue,
  }))
  // 결론 문구도 데이터에서 파생한다 — 하드코딩하면 재베이크에서 그림과 말이 어긋난다(검수 지적).
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
          📊 QQQ 배수 전략 프리셋
          <InfoTip text="평시 QQQ를 들고 있다가 고점 대비 낙폭이 깊어지면 비중을 QLD·TQQQ로 옮기고 회복하면 되돌리는 전략입니다. 43차 실측에서 관문을 통과하지 못했으며 기록·비교용으로만 등재했습니다. 모의 시뮬레이션이며 실주문과 연결되지 않습니다." />
        </h2>
        <span className="badge sample">사전계산 · 실주문 없음</span>
      </div>

      <div className="panel-sub" style={{ color: 'var(--uslev-warn)', fontWeight: 600 }}>{stripMd(US_LEV_BANNER)}</div>
      <div className="panel-sub">{stripMd(US_LEV_READ_HINT)}</div>

      <div className="panel-sub uslev-meta">
        구간 <strong>{data.window.from} ~ {data.window.to}</strong> ({data.window.bars.toLocaleString()}봉) · 시세{' '}
        <strong>{data.source}</strong> · {data.basisNote} · 비용 편도 {data.cost.feePct}% + 슬리피지{' '}
        {data.cost.slippagePct}% · 기준일 {data.asOf.slice(0, 10)} · 곡선 {data.downsample}
      </div>

      {/* ── ① 결론 먼저 — 칼마 관문 ─────────────────────────────────────── */}
      <div className="uslev-chart-title">
        칼마 관문 — 선(벤치 {data.bench.symbol} {f2(benchCalmar)})을 넘어야 통과
        <InfoTip text="칼마 = 연수익률(CAGR) ÷ 최대낙폭(MDD). 같은 수익이라도 낙폭이 깊으면 낮아집니다. 규칙 5에 따라 절대 수익률이 아니라 벤치마크 대비 위험조정 성과로 판정합니다." />
      </div>
      <div className="bt-chart-block">
        <ResponsiveContainer width="100%" height={40 + calmarRows.length * 36}>
          <BarChart data={calmarRows} layout="vertical" margin={{ top: 4, right: 44, left: 4, bottom: 4 }}>
            <CartesianGrid stroke="var(--border)" horizontal={false} />
            {/* 상한은 벤치·프리셋 최대값 모두 덮는다 — 막대가 잘리면 그게 곧 거짓 그림이다 */}
            <XAxis type="number" domain={[0, Math.max(0.7, (benchCalmar ?? 0) * 1.25, ...calmarRows.map((r) => r.calmar * 1.15))]} tickLine={false} axisLine={{ stroke: 'var(--border)' }} tickFormatter={(v) => v.toFixed(1)} />
            <YAxis type="category" dataKey="name" width={132} tickLine={false} axisLine={false} tick={{ fontSize: 11 }} />
            <Tooltip
              cursor={{ fill: 'var(--panel-2)' }}
              formatter={(v: number) => [v.toFixed(2), '칼마']}
              labelFormatter={(l) => String(l)}
            />
            <Bar dataKey="calmar" barSize={14} radius={[0, 4, 4, 0]} isAnimationActive={false}>
              {calmarRows.map((r, i) => (
                <Cell key={`${i}-${r.name}`} fill={CLS_COLOR[r.cls]} />
              ))}
              <LabelList dataKey="calmar" position="right" formatter={(v: number) => v.toFixed(2)} className="uslev-bar-label" />
            </Bar>
            {/* 라벨은 제목·캡션이 이미 든다 — 여기 붙이면 상단에서 잘린다(모바일 실측) */}
            {benchCalmar != null && <ReferenceLine x={benchCalmar} stroke="var(--danger)" strokeWidth={1.5} />}
          </BarChart>
        </ResponsiveContainer>
      </div>
      <p className="uslev-caption">
        <i className="uslev-swatch" style={{ background: CLS_COLOR.ladder }} /> 사다리 전략 ·{' '}
        <i className="uslev-swatch" style={{ background: CLS_COLOR.hold }} /> 단순보유 ·{' '}
        <i className="uslev-swatch" style={{ background: CLS_COLOR.dca }} /> 매일 적립 [근사]
        <br />
        {passCount === 0 ? (
          <>
            사다리 {data.presets.length}종 전부 벤치 왼쪽 = <strong>관문 미통과</strong>.
            {allAlphaPositive && ' 알파(초과수익)는 양수지만 낙폭을 대가로 산 것이라 위험조정으로는 집니다.'}
          </>
        ) : (
          <>
            사다리 {data.presets.length}종 중 <strong>{passCount}개가 칼마 관문 통과</strong> — 카드의 판정 배지를
            확인하세요.
          </>
        )}
        {' '}적립식 칼마는 <strong>반원금 근사</strong>(유효원금 = 총 납입액 ÷ 2 · 대표 지정 방식) CAGR 기준이라
        거치식과 눈금이 정확히 같지는 않습니다 — 정확값(IRR)은 아래 적립식 표에 있습니다.
        {calmarSkipped > 0 && ` (칼마 정의 불가 ${calmarSkipped}종은 차트에서 제외 — 표에는 —로 표시)`}
      </p>

      {/* ── ② 프리셋 카드 ───────────────────────────────────────────────── */}
      <div className="uslev-cards">
        {data.presets.map((p) => (
          <button
            key={p.id}
            type="button"
            className={`uslev-card${openId === p.id ? ' open' : ''}`}
            onClick={() => setOpenId(openId === p.id ? null : p.id)}
          >
            <div className="uslev-card-head">
              <strong>{shortLabel(p.label)}</strong>
              <span className={`uslev-verdict ${p.gatePass ? 'pass' : 'fail'}`}>
                {p.gatePass ? '✅ 통과' : `❌ 탈락 · ${p.gateWhy.join('·')}`}
              </span>
            </div>
            <div className="uslev-stats">
              <div className="uslev-stat">
                <span className="lbl">CAGR</span>
                <span className="val">{f1(p.cagrPct)}%</span>
              </div>
              <div className="uslev-stat">
                <span className="lbl">MDD</span>
                <span className="val neg">{f1(p.mddPct)}%</span>
              </div>
              <div className="uslev-stat">
                <span className="lbl">칼마</span>
                <span className="val">{f2(p.calmar)}</span>
              </div>
              <div className="uslev-stat">
                <span className="lbl">알파</span>
                <span className="val">{pp(p.alphaCagrPct)}</span>
              </div>
            </div>
            <MixBar weights={p.avgWeights} />
            <div className="uslev-card-foot">
              매매 {p.trades}회 · 전반 {pp(p.alphaFirstHalfPct)} · 후반 {pp(p.alphaSecondHalfPct)} ·{' '}
              {openId === p.id ? '닫기 ▲' : '곡선·비중 보기 ▼'}
            </div>
          </button>
        ))}
      </div>

      {/* ── ③ 상세 — 자산곡선 + 비중 변화 ───────────────────────────────── */}
      {open && (
        <div className="uslev-detail">
          <h3 style={{ marginTop: 0 }}>{shortLabel(open.label)}</h3>
          <p style={{ fontSize: '0.9em' }}>
            <strong>규칙 —</strong> {open.rule}
          </p>
          {rows.length > 1 && (
            <>
              <div className="uslev-chart-title">자산곡선 (초기 1만 달러 기준 · 점선 = {data.bench.symbol} 단순보유)</div>
              <EquityChart equity={rows} benchmarkLabel={`${data.bench.symbol} 단순보유`} />
              <WeightsChart preset={open} />
              <p style={{ fontSize: '0.8em', opacity: 0.7 }}>
                곡선·비중은 {data.downsample}로 줄인 것이라 중간 고저점이 실제보다 완만해 보일 수 있습니다. 카드의
                MDD는 <strong>다운샘플 전 원곡선</strong> 기준입니다. 전·후반 경계는 {data.splitDate}.
              </p>
            </>
          )}
          <p className="uslev-note">{stripMd(open.note)}</p>
        </div>
      )}

      {/* ── ④ 단순보유 벽 ───────────────────────────────────────────────── */}
      <div className="uslev-chart-title">
        같은 구간 단순보유 — 옮겨 적은 값이 아니라 다시 잰 값
        <InfoTip text="같은 구간·같은 비용으로 QQQ·QLD·TQQQ를 사서 들고만 있었을 때의 성적입니다. 오른쪽 막대가 연수익률(CAGR), 왼쪽 빨간 막대가 최대낙폭(MDD)입니다. 전략이 이 벽을 위험조정 기준으로 넘지 못하면 굴릴 이유가 없습니다." />
      </div>
      <div className="bt-chart-block">
        <ResponsiveContainer width="100%" height={40 + wallRows.length * 44}>
          <BarChart data={wallRows} layout="vertical" margin={{ top: 4, right: 44, left: 4, bottom: 4 }}>
            <CartesianGrid stroke="var(--border)" horizontal={false} />
            <XAxis type="number" tickLine={false} axisLine={{ stroke: 'var(--border)' }} tickFormatter={(v) => `${v}%`} />
            <YAxis type="category" dataKey="name" width={52} tickLine={false} axisLine={false} tick={{ fontSize: 12 }} />
            <Tooltip
              cursor={{ fill: 'var(--panel-2)' }}
              formatter={(v: number, name: string) => [`${v.toFixed(1)}%`, name === 'cagr' ? '연수익률 CAGR' : '최대낙폭 MDD']}
            />
            <ReferenceLine x={0} stroke="var(--text-faint)" />
            <Bar dataKey="cagr" barSize={13} radius={[0, 4, 4, 0]} fill="var(--uslev-x2)" isAnimationActive={false}>
              {/* 부호는 데이터에서 — '+' 하드코딩은 음수 재베이크에서 '+-12.3%'가 된다(검수 지적) */}
              <LabelList dataKey="cagr" position="right" formatter={(v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`} className="uslev-bar-label" />
            </Bar>
            <Bar dataKey="mdd" barSize={13} radius={[4, 0, 0, 4]} fill="var(--danger)" isAnimationActive={false}>
              <LabelList dataKey="mdd" position="left" formatter={(v: number) => `${v.toFixed(1)}%`} className="uslev-bar-label" />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
      <p className="uslev-caption">
        <i className="uslev-swatch" style={{ background: 'var(--uslev-x2)' }} /> 연수익률(CAGR) ·{' '}
        <i className="uslev-swatch" style={{ background: 'var(--danger)' }} /> 최대낙폭(MDD) · 칼마 —{' '}
        {data.walls.map((w) => `${w.symbol} ${f2(w.calmar)}`).join(' · ')}
      </p>

      {/* ── ⑤ 적립식 ────────────────────────────────────────────────────── */}
      <div className="uslev-chart-title">
        매일 {data.dca.dailyAmount.toLocaleString()}원 적립했다면 — 원금 대비 배수
        <InfoTip text="구간 내내 매일 같은 금액을 사기만 했을 때의 최종 평가액 ÷ 누적 원금입니다. 파란 막대가 단순 적립, 회색 막대가 사다리 전략 적립입니다. 판정 문구는 아래 캡션에 데이터로부터 계산해 표시합니다." />
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
              {/* 스키마 1 산출물은 사다리 라벨 4개가 동일하다 — key는 인덱스로 */}
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

      {/* ── 단순 적립 상세 — 반원금 근사(대표 지정) + 정확 IRR (스키마 3+) ── */}
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
            차이가 근사 오차입니다. MDD는 일별 평가액 곡선의 고점 대비 최대낙폭이며, 적립 초기에 원금이 작아
            거치식 MDD보다 체감이 다를 수 있습니다.
          </p>
        </>
      )}

      {/* ── 원자료 표 (접근성 표 뷰 · 예전 표 그대로) ────────────────────── */}
      <details className="uslev-tables">
        <summary>표로 보기 (원자료 전체)</summary>
        <div style={{ overflowX: 'auto' }}>
          <table className="tbl">
            <thead>
              <tr>
                <th>프리셋</th>
                <th>총수익</th>
                <th>CAGR</th>
                <th>MDD</th>
                <th>칼마</th>
                <th>알파</th>
                <th>전반</th>
                <th>후반</th>
                <th>매매</th>
                <th>평균비중 QQQ/QLD/TQQQ</th>
                <th>판정</th>
              </tr>
            </thead>
            <tbody>
              {data.presets.map((p) => (
                <tr key={p.id}>
                  <td style={{ maxWidth: 320 }}>{p.label}</td>
                  <td>{f1(p.totalPct)}%</td>
                  <td>{f1(p.cagrPct)}%</td>
                  <td style={{ color: 'var(--danger)' }}>{f1(p.mddPct)}%</td>
                  <td><strong>{f2(p.calmar)}</strong></td>
                  <td>{pp(p.alphaCagrPct)}</td>
                  <td>{pp(p.alphaFirstHalfPct)}</td>
                  <td>{pp(p.alphaSecondHalfPct)}</td>
                  <td>{p.trades}</td>
                  <td>{p.avgWeights.map((w) => Math.round(w)).join(' / ')}</td>
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
        <div style={{ overflowX: 'auto' }}>
          <table className="tbl">
            <thead>
              <tr>
                <th>순위</th>
                <th>전략</th>
                <th>누적 원금</th>
                <th>최종 평가액</th>
                <th>배수</th>
              </tr>
            </thead>
            <tbody>
              {data.dca.rows.map((r, i) => (
                <tr key={r.label}>
                  <td>{i + 1}</td>
                  <td>{r.label}</td>
                  <td>{won(r.contributed)}</td>
                  <td><strong>{won(r.finalValue)}</strong></td>
                  <td>{r.multiple.toFixed(2)}배</td>
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
          화면에 <strong>"직접 다시 돌리기"가 없는 것은 의도</strong>입니다 — 시세가 tiingo라 브라우저에서
          부르면 API 키가 노출됩니다. GHA에서 구운 산출물만 읽습니다.
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
