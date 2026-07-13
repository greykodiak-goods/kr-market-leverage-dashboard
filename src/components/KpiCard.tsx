interface KpiCardProps {
  label: string
  value: string
  unit?: string
  changeText?: string
  direction?: 'up' | 'down' | 'flat'
  invertColor?: boolean // when true, up is treated as "bad" (e.g. 미수금 증가)
}

export function KpiCard({ label, value, unit, changeText, direction = 'flat', invertColor }: KpiCardProps) {
  let cls = 'muted'
  let arrow = '→'
  if (direction === 'up') {
    arrow = '▲'
    cls = invertColor ? 'up' : 'up'
  } else if (direction === 'down') {
    arrow = '▼'
    cls = 'down'
  }

  return (
    <div className="kpi-card">
      <div className="label">{label}</div>
      <div className="value">
        {value}
        {unit && <span className="unit">{unit}</span>}
      </div>
      {changeText && (
        <div className="change">
          <span className={cls}>
            {arrow} {changeText}
          </span>
          <span className="muted">전일대비</span>
        </div>
      )}
    </div>
  )
}
