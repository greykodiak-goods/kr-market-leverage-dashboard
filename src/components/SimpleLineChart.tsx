import {
  Area,
  ComposedChart,
  CartesianGrid,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import type { ValuePoint } from '../types'
import { toTs, tsLong, timeAxisTicks, timeTickFormatter } from './chartUtils'

interface Props {
  data: ValuePoint[]
  color: string // css var expression, e.g. 'var(--accent)'
  gradientId: string
  height?: number
  valueFormatter: (v: number) => string
  tooltipLabel: string
}

export function SimpleLineChart({
  data,
  color,
  gradientId,
  height = 200,
  valueFormatter,
  tooltipLabel,
}: Props) {
  const dates = data.map((d) => d.date)
  const rows = data.map((d) => ({ ...d, ts: toTs(d.date) }))
  const ticks = timeAxisTicks(dates)
  const fmt = timeTickFormatter(dates)

  const CustomTooltip = ({ active, payload, label }: any) => {
    if (!active || !payload || !payload.length) return null
    return (
      <div className="recharts-default-tooltip" style={{ padding: '8px 12px' }}>
        <div style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 4 }}>{tsLong(label)}</div>
        <div style={{ fontSize: 13 }}>
          {tooltipLabel}: <strong>{valueFormatter(payload[0].value)}</strong>
        </div>
      </div>
    )
  }

  return (
    <ResponsiveContainer width="100%" height={height}>
      <ComposedChart data={rows} margin={{ top: 8, right: 12, left: 4, bottom: 0 }}>
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.35} />
            <stop offset="100%" stopColor={color} stopOpacity={0.03} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
        <XAxis dataKey="date" ticks={ticks} tickFormatter={fmt} tickLine={false} axisLine={{ stroke: 'var(--border)' }} />
        <YAxis
          tickFormatter={valueFormatter}
          tickLine={false}
          axisLine={false}
          width={54}
          domain={['auto', 'auto']}
        />
        <Tooltip content={<CustomTooltip />} />
        <Area type="monotone" dataKey="value" stroke="none" fill={`url(#${gradientId})`} />
        <Line type="monotone" dataKey="value" stroke={color} strokeWidth={1.6} dot={false} />
      </ComposedChart>
    </ResponsiveContainer>
  )
}
