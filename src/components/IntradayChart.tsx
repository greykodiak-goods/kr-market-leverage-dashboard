import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { format } from 'date-fns'
import type { IntradayPoint } from '../lib/quotes'

interface Props {
  data: IntradayPoint[]
  color: string
  gradientId: string
  currency: string
  height?: number
}

function spanDaysOf(data: IntradayPoint[]): number {
  if (data.length < 2) return 0
  return (data[data.length - 1].t - data[0].t) / 86400
}

export function IntradayChart({ data, color, gradientId, currency, height = 120 }: Props) {
  if (!data.length) {
    return (
      <div style={{ height, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-faint)', fontSize: 12 }}>
        데이터 없음
      </div>
    )
  }
  const span = spanDaysOf(data)
  const axisFmt = (t: number) => {
    const d = new Date(t * 1000)
    if (span < 2) return format(d, 'HH:mm')
    if (span < 200) return format(d, 'MM/dd')
    return format(d, 'yyyy')
  }
  const tipFmt = (t: number) => {
    const d = new Date(t * 1000)
    if (span < 2) return format(d, 'HH:mm')
    if (span < 200) return format(d, 'yyyy.MM.dd')
    return format(d, 'yyyy.MM')
  }
  const priceFmt = (v: number) =>
    `${currency === 'USD' ? '$' : '₩'}${v.toLocaleString('ko-KR', { maximumFractionDigits: currency === 'USD' ? 2 : 0 })}`

  const CustomTooltip = ({ active, payload }: any) => {
    if (!active || !payload || !payload.length) return null
    const p = payload[0].payload
    return (
      <div className="recharts-default-tooltip" style={{ padding: '6px 10px' }}>
        <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>{tipFmt(p.t)}</div>
        <div style={{ fontSize: 13 }}>{priceFmt(p.price)}</div>
      </div>
    )
  }

  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.35} />
            <stop offset="100%" stopColor={color} stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
        <XAxis
          dataKey="t"
          tickFormatter={axisFmt}
          tickLine={false}
          axisLine={{ stroke: 'var(--border)' }}
          minTickGap={40}
          interval="preserveStartEnd"
        />
        <YAxis hide domain={['dataMin', 'dataMax']} />
        <Tooltip content={<CustomTooltip />} />
        <Area type="monotone" dataKey="price" stroke={color} strokeWidth={1.6} fill={`url(#${gradientId})`} dot={false} isAnimationActive={false} />
      </AreaChart>
    </ResponsiveContainer>
  )
}
