import { Area, AreaChart, CartesianGrid, ReferenceArea, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { format } from 'date-fns'
import type { IntradayPoint, SessionBounds } from '../lib/quotes'

interface Props {
  data: IntradayPoint[]
  color: string
  gradientId: string
  currency: string
  height?: number
  // 미국 세션 경계(1D 인트라데이 전용) — 주면 프리/애프터 구간을 옅게 음영 처리.
  sessionBounds?: SessionBounds
}

function spanDaysOf(data: IntradayPoint[]): number {
  if (data.length < 2) return 0
  return (data[data.length - 1].t - data[0].t) / 86400
}

export function IntradayChart({ data, color, gradientId, currency, height = 120, sessionBounds }: Props) {
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

  // 프리/애프터 음영 — X축이 카테고리축이라 경계값은 실제 데이터 포인트의
  // 타임스탬프로 클램프해야 한다. 1일(1D) 뷰에서만 표시.
  let preArea: { x1: number; x2: number } | null = null
  let postArea: { x1: number; x2: number } | null = null
  if (sessionBounds && span < 2) {
    const preTs = data.filter((p) => p.t < sessionBounds.regStart)
    if (preTs.length >= 2) preArea = { x1: preTs[0].t, x2: preTs[preTs.length - 1].t }
    const postTs = data.filter((p) => p.t >= sessionBounds.regEnd)
    if (postTs.length >= 2) postArea = { x1: postTs[0].t, x2: postTs[postTs.length - 1].t }
  }

  const CustomTooltip = ({ active, payload }: any) => {
    if (!active || !payload || !payload.length) return null
    const p = payload[0].payload
    return (
      <div className="recharts-default-tooltip">
        <div className="tooltip-label">{tipFmt(p.t)}</div>
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
        {preArea && (
          <ReferenceArea x1={preArea.x1} x2={preArea.x2} fill="var(--text-faint)" fillOpacity={0.07} strokeOpacity={0} ifOverflow="visible" />
        )}
        {postArea && (
          <ReferenceArea x1={postArea.x1} x2={postArea.x2} fill="var(--text-faint)" fillOpacity={0.07} strokeOpacity={0} ifOverflow="visible" />
        )}
        <Tooltip content={<CustomTooltip />} cursor={{ stroke: 'var(--text-faint)', strokeDasharray: '3 3' }} />
        <Area type="monotone" dataKey="price" stroke={color} strokeWidth={1.6} fill={`url(#${gradientId})`} dot={false} isAnimationActive={false} />
      </AreaChart>
    </ResponsiveContainer>
  )
}
