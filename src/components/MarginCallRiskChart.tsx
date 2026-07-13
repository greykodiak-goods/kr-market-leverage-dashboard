import {
  Area,
  ComposedChart,
  CartesianGrid,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import type { ValuePoint } from '../types'
import { formatEok, formatEokShort } from '../lib/format'
import { toTs, tsLong, timeAxisTicks, timeTickFormatter } from './chartUtils'

interface Props {
  data: ValuePoint[]
}

function RiskTooltip({ active, payload, label }: any) {
  if (!active || !payload || !payload.length) return null
  const v = payload[0].value
  return (
    <div className="recharts-default-tooltip" style={{ padding: '8px 12px' }}>
      <div style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 4 }}>{tsLong(label)}</div>
      <div style={{ fontSize: 13 }}>미수금: <strong>{formatEok(v)}</strong></div>
    </div>
  )
}

export function MarginCallRiskChart({ data }: Props) {
  const dates = data.map((d) => d.date)
  const rows = data.map((d) => ({ ...d, ts: toTs(d.date) }))
  const ticks = timeAxisTicks(dates)
  const fmt = timeTickFormatter(dates)
  const values = data.map((d) => d.value)
  const avg = values.reduce((s, v) => s + v, 0) / values.length
  // Highlight zone: 반대매매 위험은 미수금이 평균을 크게 웃돌 때 커진다.
  const riskLine = avg * 1.4

  return (
    <ResponsiveContainer width="100%" height={230}>
      <ComposedChart data={rows} margin={{ top: 8, right: 12, left: 4, bottom: 0 }}>
        <defs>
          <linearGradient id="gUnsettled" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--danger)" stopOpacity={0.4} />
            <stop offset="100%" stopColor="var(--danger)" stopOpacity={0.03} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
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
        <YAxis tickFormatter={(v) => formatEokShort(v)} tickLine={false} axisLine={false} width={48} />
        <Tooltip content={<RiskTooltip />} />
        <ReferenceLine
          y={riskLine}
          stroke="var(--danger)"
          strokeDasharray="4 4"
          strokeOpacity={0.7}
          label={{ value: '반대매매 경계', position: 'insideTopRight', fill: 'var(--danger)', fontSize: 11 }}
        />
        <Area type="monotone" dataKey="value" stroke="none" fill="url(#gUnsettled)" />
        <Line type="monotone" dataKey="value" stroke="var(--danger)" strokeWidth={1.6} dot={false} name="미수금" />
      </ComposedChart>
    </ResponsiveContainer>
  )
}
