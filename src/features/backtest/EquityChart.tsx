// Strategy vs buy&hold equity curve + drawdown chart for a sim result.

import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import type { EquityPoint } from './types'
import { timeAxisTicks, timeTickFormatter, toTs, tsLong } from '../../components/chartUtils'

/**
 * 두 번째(참고용) 벤치마크를 얹을 수 있는 자산곡선 행.
 * `benchmark2`가 하나라도 들어오면 구분되는 점선으로 함께 그린다 — 없으면 예전과 완전히 같다.
 */
export type EquityRow = EquityPoint & { benchmark2?: number | null }

function fmtMoney(v: number): string {
  if (Math.abs(v) >= 1e8) return `${(v / 1e8).toFixed(1)}억`
  if (Math.abs(v) >= 1e4) return `${Math.round(v / 1e4).toLocaleString()}만`
  return v.toLocaleString()
}

export function EquityChart({
  equity,
  benchmarkLabel = '벤치마크',
  benchmark2Label,
}: {
  equity: EquityRow[]
  benchmarkLabel?: string
  /** 참고용 2번째 벤치 이름. 값(benchmark2)이 하나도 없으면 그리지 않는다. */
  benchmark2Label?: string
}) {
  const dates = equity.map((e) => e.date)
  const rows = equity.map((e) => ({ ...e, ts: toTs(e.date) }))
  const ticks = timeAxisTicks(dates)
  const fmt = timeTickFormatter(dates)
  const hasBench2 = benchmark2Label != null && equity.some((e) => e.benchmark2 != null)

  const EqTooltip = ({ active, payload, label }: any) => {
    if (!active || !payload?.length) return null
    const p = payload[0]?.payload as EquityRow & { ts: number }
    return (
      <div className="recharts-default-tooltip">
        <div className="tooltip-label">{tsLong(label)}</div>
        <div style={{ fontSize: 13 }}>
          <div>
            모델: <strong>{Math.round(p.equity).toLocaleString()}</strong>
          </div>
          <div>
            {benchmarkLabel}: <strong>{Math.round(p.benchmark).toLocaleString()}</strong>
          </div>
          {hasBench2 && p.benchmark2 != null && (
            <div>
              {benchmark2Label}: <strong>{Math.round(p.benchmark2).toLocaleString()}</strong>
            </div>
          )}
          <div>
            낙폭: <strong>{p.drawdownPct.toFixed(1)}%</strong>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div>
      <ResponsiveContainer width="100%" height={240}>
        <ComposedChart data={rows} margin={{ top: 8, right: 12, left: 4, bottom: 0 }} syncId="bt-sync">
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
          <XAxis dataKey="date" ticks={ticks} tickFormatter={fmt} tickLine={false} axisLine={{ stroke: 'var(--border)' }} />
          <YAxis tickFormatter={fmtMoney} tickLine={false} axisLine={false} width={56} domain={['auto', 'auto']} />
          <Tooltip content={<EqTooltip />} cursor={{ stroke: 'var(--text-faint)', strokeDasharray: '3 3' }} />
          <Line type="monotone" dataKey="benchmark" name={benchmarkLabel} stroke="var(--text-faint)" strokeWidth={1.4} strokeDasharray="5 4" dot={false} />
          {hasBench2 && (
            <Line
              type="monotone"
              dataKey="benchmark2"
              name={benchmark2Label}
              stroke="var(--kosdaq)"
              strokeWidth={1.3}
              strokeDasharray="2 4"
              dot={false}
              connectNulls
            />
          )}
          <Line type="monotone" dataKey="equity" name="전략" stroke="var(--accent)" strokeWidth={1.8} dot={false} />
        </ComposedChart>
      </ResponsiveContainer>
      <div className="bt-legend">
        <span><i className="bt-swatch" style={{ background: 'var(--accent)' }} /> 모델 자산곡선</span>
        <span><i className="bt-swatch dashed" style={{ borderColor: 'var(--text-faint)' }} /> 벤치마크 — {benchmarkLabel}</span>
        {hasBench2 && (
          <span>
            <i className="bt-swatch dashed" style={{ borderColor: 'var(--kosdaq)' }} /> 참고 — {benchmark2Label}
          </span>
        )}
      </div>
      <ResponsiveContainer width="100%" height={90}>
        <ComposedChart data={rows} margin={{ top: 4, right: 12, left: 4, bottom: 0 }} syncId="bt-sync">
          <defs>
            <linearGradient id="bt-dd" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--danger)" stopOpacity={0.05} />
              <stop offset="100%" stopColor="var(--danger)" stopOpacity={0.4} />
            </linearGradient>
          </defs>
          <XAxis dataKey="date" ticks={ticks} tickFormatter={fmt} tickLine={false} axisLine={{ stroke: 'var(--border)' }} hide />
          <YAxis tickFormatter={(v: number) => `${v.toFixed(0)}%`} tickLine={false} axisLine={false} width={56} domain={['auto', 0]} />
          <Tooltip
            content={({ active, payload }: any) =>
              active && payload?.length ? (
                <div className="recharts-default-tooltip">
                  <div style={{ fontSize: 12 }}>낙폭 {Number(payload[0].value).toFixed(1)}%</div>
                </div>
              ) : null
            }
          />
          <Area type="monotone" dataKey="drawdownPct" stroke="var(--danger)" strokeWidth={1} fill="url(#bt-dd)" />
        </ComposedChart>
      </ResponsiveContainer>
      <div className="bt-chart-caption">아래 영역: 전략 낙폭(고점 대비 하락률)</div>
    </div>
  )
}
