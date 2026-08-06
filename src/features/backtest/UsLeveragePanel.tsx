// QQQ 배수 전략 프리셋 화면 — **읽기 전용 패널**.
//
// 2026-08-06 대표 지시로 등재. 43차 실측에서 관문 통과 0(990변형)이었고 나는 등재에
// 반대했으나 대표가 결과를 보고 확정했다. 그래서 **탈락 사실을 먼저 보여주는 형태**로 올린다.
//
// ── 왜 "직접 다시 돌리기"가 없나 ────────────────────────────────────────────
//   시세가 tiingo라 브라우저에서 부르면 API 키가 프런트엔드에 노출된다(규칙 2-1 위반).
//   그래서 GHA에서 굽고(`scripts/us-leverage-precompute.entry.ts`) 여기서는 읽기만 한다.
//   기능 누락이 아니라 **키를 안 내보내려는 설계**이며, 그 사실을 화면에 적는다.
//
// ── 우아한 강등 ─────────────────────────────────────────────────────────────
//   산출물이 없거나 모르는 스키마면 **없는 셈 치고** 안내만 띄운다. 수치를 지어내지 않는다.
//   라벨의 숫자는 전부 산출물에서 온다 — 이 파일에 하드코딩된 성적은 하나도 없다(규칙 3).

import { useEffect, useState } from 'react'
import { EquityChart, type EquityRow } from './EquityChart'
import { InfoTip } from '../../components/InfoTip'
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
  const rows: EquityRow[] = open
    ? open.curve.map(([date, equity, benchmark]) => ({ date, equity, benchmark, drawdownPct: 0 }))
    : []

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>
          📊 QQQ 배수 전략 프리셋
          <InfoTip text="평시 QQQ를 들고 있다가 고점 대비 낙폭이 깊어지면 비중을 QLD·TQQQ로 옮기고 회복하면 되돌리는 전략입니다. 43차 실측에서 관문을 통과하지 못했으며 기록·비교용으로만 등재했습니다. 모의 시뮬레이션이며 실주문과 연결되지 않습니다." />
        </h2>
        <span className="badge sample">사전계산 · 실주문 없음</span>
      </div>

      <div className="panel-sub" style={{ color: '#b45309', fontWeight: 600 }}>
        {US_LEV_BANNER}
      </div>
      <div className="panel-sub">{US_LEV_READ_HINT}</div>

      <div className="panel-sub" style={{ fontSize: '0.85em', opacity: 0.85 }}>
        구간 <strong>{data.window.from} ~ {data.window.to}</strong> ({data.window.bars.toLocaleString()}봉) · 시세{' '}
        <strong>{data.source}</strong> · {data.basisNote} · 비용 편도 {data.cost.feePct}% + 슬리피지{' '}
        {data.cost.slippagePct}% · 기준일 {data.asOf.slice(0, 10)} · 곡선 {data.downsample}
        <br />
        <strong>판정 벤치: {data.bench.label}</strong> — CAGR {f1(data.bench.cagrPct)}% · MDD{' '}
        {f1(data.bench.mddPct)}% · 칼마 <strong>{f2(data.bench.calmar)}</strong> (칼마 관문은 이 값을 넘어야 합니다)
      </div>

      {/* ── 프리셋 ─────────────────────────────────────────────────────── */}
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
              <th>평균비중<br />QQQ/QLD/TQQQ</th>
              <th>판정</th>
            </tr>
          </thead>
          <tbody>
            {data.presets.map((p) => (
              <tr
                key={p.id}
                onClick={() => setOpenId(openId === p.id ? null : p.id)}
                style={{ cursor: 'pointer', background: openId === p.id ? 'rgba(59,130,246,0.08)' : undefined }}
              >
                <td style={{ maxWidth: 320 }}>{p.label}</td>
                <td>{f1(p.totalPct)}%</td>
                <td>{f1(p.cagrPct)}%</td>
                <td style={{ color: '#b91c1c' }}>{f1(p.mddPct)}%</td>
                <td>
                  <strong>{f2(p.calmar)}</strong>
                </td>
                <td>{pp(p.alphaCagrPct)}</td>
                <td>{pp(p.alphaFirstHalfPct)}</td>
                <td>{pp(p.alphaSecondHalfPct)}</td>
                <td>{p.trades}</td>
                <td>{p.avgWeights.map((w) => Math.round(w)).join(' / ')}</td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  {p.gatePass ? '✅ 통과' : `❌ ${p.gateWhy.join('·')}`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p style={{ fontSize: '0.85em', opacity: 0.8 }}>
        행을 누르면 규칙·경고 전문과 자산곡선이 열립니다. 전·후반 경계는 <strong>{data.splitDate}</strong>입니다.
      </p>

      {open && (
        <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: 12, marginTop: 8 }}>
          <h3 style={{ marginTop: 0 }}>{open.label}</h3>
          <p style={{ fontSize: '0.9em' }}>
            <strong>규칙 —</strong> {open.rule}
          </p>
          <p style={{ fontSize: '0.85em', lineHeight: 1.6, background: '#fef2f2', padding: 10, borderRadius: 6 }}>
            {open.note}
          </p>
          {rows.length > 1 && (
            <>
              <EquityChart equity={rows} benchmarkLabel={`${data.bench.symbol} 단순보유`} />
              <p style={{ fontSize: '0.8em', opacity: 0.7 }}>
                곡선은 {data.downsample}로 줄인 것이라 중간 고저점이 실제보다 완만해 보일 수 있습니다. 위 표의
                MDD는 <strong>다운샘플 전 원곡선</strong> 기준입니다.
              </p>
            </>
          )}
        </div>
      )}

      {/* ── 참고 벽 ────────────────────────────────────────────────────── */}
      <h3>같은 구간 단순보유 — 옮겨 적은 값이 아니라 다시 잰 값</h3>
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
                <td>
                  <strong>{f1(w.cagrPct)}%</strong>
                </td>
                <td style={{ color: '#b91c1c' }}>{f1(w.mddPct)}%</td>
                <td>{f2(w.calmar)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* ── 적립식 ─────────────────────────────────────────────────────── */}
      <h3>매일 {data.dca.dailyAmount.toLocaleString()}원 적립했다면</h3>
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
                <td>
                  <strong>{won(r.finalValue)}</strong>
                </td>
                <td>{r.multiple.toFixed(2)}배</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

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
