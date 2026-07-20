import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import type { CreditPoint } from '../types'
import { formatEok, formatEokShort } from '../lib/format'
import { toTs, tsLong, timeAxisTicks, timeTickFormatter } from './chartUtils'

interface Props {
  data: CreditPoint[]
}

function CreditTooltip({ active, payload, label }: any) {
  if (!active || !payload || !payload.length) return null
  const kospi = payload.find((p: any) => p.dataKey === 'kospi')?.value ?? 0
  const kosdaq = payload.find((p: any) => p.dataKey === 'kosdaq')?.value ?? 0
  return (
    <div className="recharts-default-tooltip">
      <div className="tooltip-label">{tsLong(label)}</div>
      <div style={{ fontSize: 13 }}>합계: <strong>{formatEok(kospi + kosdaq)}</strong></div>
      <div style={{ fontSize: 12, color: 'var(--kospi)' }}>코스피: {formatEok(kospi)}</div>
      <div style={{ fontSize: 12, color: 'var(--kosdaq)' }}>코스닥: {formatEok(kosdaq)}</div>
    </div>
  )
}

export function CreditBalanceChart({ data }: Props) {
  const dates = data.map((d) => d.date)
  const rows = data.map((d) => ({ ...d, ts: toTs(d.date) }))
  const ticks = timeAxisTicks(dates)
  const fmt = timeTickFormatter(dates)
  return (
    <ResponsiveContainer width="100%" height={300}>
      <AreaChart data={rows} margin={{ top: 8, right: 12, left: 4, bottom: 0 }}>
        <defs>
          <linearGradient id="gKospi" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--kospi)" stopOpacity={0.55} />
            <stop offset="100%" stopColor="var(--kospi)" stopOpacity={0.05} />
          </linearGradient>
          <linearGradient id="gKosdaq" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--kosdaq)" stopOpacity={0.55} />
            <stop offset="100%" stopColor="var(--kosdaq)" stopOpacity={0.05} />
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
        <YAxis
          tickFormatter={(v) => formatEokShort(v)}
          tickLine={false}
          axisLine={false}
          width={54}
        />
        <Tooltip content={<CreditTooltip />} cursor={{ stroke: 'var(--text-faint)', strokeDasharray: '3 3' }} />
        <Area
          type="monotone"
          dataKey="kosdaq"
          stackId="1"
          stroke="var(--kosdaq)"
          fill="url(#gKosdaq)"
          strokeWidth={1.5}
          name="코스닥"
        />
        <Area
          type="monotone"
          dataKey="kospi"
          stackId="1"
          stroke="var(--kospi)"
          fill="url(#gKospi)"
          strokeWidth={1.5}
          name="코스피"
        />
      </AreaChart>
    </ResponsiveContainer>
  )
}
