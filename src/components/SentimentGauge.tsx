import type { SentimentBreakdown } from '../lib/sentiment'

interface Props {
  data: SentimentBreakdown
}

// Semicircular fear/greed gauge drawn as SVG.
export function SentimentGauge({ data }: Props) {
  const { score, label, components } = data
  const cx = 130
  const cy = 130
  const r = 100
  const startAngle = 180 // left
  const endAngle = 0 // right

  // Map score 0..100 to angle 180..0
  const angle = startAngle - (score / 100) * (startAngle - endAngle)
  const rad = (angle * Math.PI) / 180
  const needleX = cx + Math.cos(rad) * (r - 12)
  const needleY = cy - Math.sin(rad) * (r - 12)

  // Colored arc segments (fear -> greed)
  const segments = [
    { from: 0, to: 25, color: '#2f6feb' }, // 극단적 공포 (blue)
    { from: 25, to: 45, color: '#4aa3df' },
    { from: 45, to: 62, color: '#98a2b3' }, // 중립
    { from: 62, to: 80, color: '#f79009' },
    { from: 80, to: 100, color: '#e5484d' }, // 극단적 탐욕 (red)
  ]

  function arcPath(from: number, to: number) {
    const a0 = (startAngle - (from / 100) * 180) * (Math.PI / 180)
    const a1 = (startAngle - (to / 100) * 180) * (Math.PI / 180)
    const x0 = cx + Math.cos(a0) * r
    const y0 = cy - Math.sin(a0) * r
    const x1 = cx + Math.cos(a1) * r
    const y1 = cy - Math.sin(a1) * r
    const largeArc = to - from > 50 ? 1 : 0
    return `M ${x0} ${y0} A ${r} ${r} 0 ${largeArc} 1 ${x1} ${y1}`
  }

  return (
    <div className="gauge-card">
      <svg viewBox="0 0 260 165" width="100%" style={{ maxWidth: 300 }} role="img" aria-label={`과열도 ${score}점 ${label}`}>
        {segments.map((s, i) => (
          <path
            key={i}
            d={arcPath(s.from, s.to)}
            stroke={s.color}
            strokeWidth={16}
            fill="none"
            strokeLinecap="butt"
            opacity={0.9}
          />
        ))}
        {/* needle */}
        <line x1={cx} y1={cy} x2={needleX} y2={needleY} stroke="var(--text)" strokeWidth={3} strokeLinecap="round" />
        <circle cx={cx} cy={cy} r={6} fill="var(--text)" />
        {/* score text */}
        <text x={cx} y={cy - 34} textAnchor="middle" fontSize={38} fontWeight={700} fill="var(--text)">
          {score}
        </text>
        <text x={cx} y={cy - 12} textAnchor="middle" fontSize={14} fill="var(--text-dim)">
          {label}
        </text>
        <text x={30} y={155} textAnchor="middle" fontSize={10} fill="var(--text-faint)">
          공포
        </text>
        <text x={230} y={155} textAnchor="middle" fontSize={10} fill="var(--text-faint)">
          탐욕
        </text>
      </svg>

      <div className="gauge-legend">
        {components.map((c) => (
          <div className="row" key={c.name}>
            <span style={{ minWidth: 96 }}>{c.name}</span>
            <span className="bar">
              <span style={{ width: `${Math.round(c.value)}%` }} />
            </span>
            <span style={{ minWidth: 30, textAlign: 'right' }}>{Math.round(c.value)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
