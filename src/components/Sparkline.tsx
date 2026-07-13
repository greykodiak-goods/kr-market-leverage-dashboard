import { Area, AreaChart, ResponsiveContainer, YAxis } from 'recharts'
import type { IntradayPoint } from '../lib/quotes'

export function Sparkline({ data, color, height = 38 }: { data: IntradayPoint[]; color: string; height?: number }) {
  if (!data || data.length < 2) {
    return <div style={{ height, display: 'flex', alignItems: 'center', color: 'var(--text-faint)', fontSize: 10 }}>—</div>
  }
  const gid = 'sp' + Math.random().toString(36).slice(2, 8)
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ top: 2, right: 0, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.3} />
            <stop offset="100%" stopColor={color} stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <YAxis hide domain={['dataMin', 'dataMax']} />
        <Area type="monotone" dataKey="price" stroke={color} strokeWidth={1.4} fill={`url(#${gid})`} dot={false} isAnimationActive={false} />
      </AreaChart>
    </ResponsiveContainer>
  )
}
