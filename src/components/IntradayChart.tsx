import { Area, AreaChart, ResponsiveContainer, Tooltip, YAxis } from 'recharts'
import { format } from 'date-fns'
import type { IntradayPoint } from '../lib/quotes'

interface Props {
  data: IntradayPoint[]
  color: string
  gradientId: string
  currency: string
  previousClose: number
}

export function IntradayChart({ data, color, gradientId, currency, previousClose }: Props) {
  if (!data.length) {
    return (
      <div style={{ height: 90, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-faint)', fontSize: 12 }}>
        일중 데이터 없음
      </div>
    )
  }
  const chartData = data.map((p) => ({ t: p.t, price: p.price }))

  const CustomTooltip = ({ active, payload }: any) => {
    if (!active || !payload || !payload.length) return null
    const p = payload[0].payload
    return (
      <div className="recharts-default-tooltip" style={{ padding: '6px 10px' }}>
        <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>{format(new Date(p.t * 1000), 'HH:mm')}</div>
        <div style={{ fontSize: 13 }}>
          {currency === 'USD' ? '$' : '₩'}
          {p.price.toLocaleString('ko-KR', { maximumFractionDigits: currency === 'USD' ? 2 : 0 })}
        </div>
      </div>
    )
  }

  return (
    <ResponsiveContainer width="100%" height={90}>
      <AreaChart data={chartData} margin={{ top: 4, right: 0, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.35} />
            <stop offset="100%" stopColor={color} stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <YAxis hide domain={['dataMin', 'dataMax']} />
        <Tooltip content={<CustomTooltip />} />
        {previousClose > 0 && (
          <Area type="monotone" dataKey="price" stroke="none" fill="transparent" />
        )}
        <Area type="monotone" dataKey="price" stroke={color} strokeWidth={1.6} fill={`url(#${gradientId})`} dot={false} isAnimationActive={false} />
      </AreaChart>
    </ResponsiveContainer>
  )
}
