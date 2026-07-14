import { InfoTip } from './InfoTip'

interface KpiCardProps {
  label: string
  value: string
  unit?: string
  changeText?: string
  changeLabel?: string
  direction?: 'up' | 'down' | 'flat'
  invertColor?: boolean // when true, up is treated as "bad" (e.g. 미수금 증가)
  info?: string
}

export function KpiCard({
  label,
  value,
  unit,
  changeText,
  changeLabel = '전일대비',
  direction = 'flat',
  invertColor,
  info,
}: KpiCardProps) {
  // Default: KR convention (up = red, down = blue). invertColor flips the
  // *meaning* so a decrease reads positive (green) and an increase negative
  // (red) — e.g. 대차잔고·공매도 감소 = 상환(긍정).
  let cls = 'muted'
  let arrow = '→'
  if (direction === 'up') {
    arrow = '▲'
    cls = invertColor ? 'up' : 'up'
  } else if (direction === 'down') {
    arrow = '▼'
    cls = invertColor ? 'cover' : 'down'
  }

  return (
    <div className="kpi-card">
      <div className="label">
        {label}
        {info && <InfoTip text={info} />}
      </div>
      <div className="value">
        {value}
        {unit && <span className="unit">{unit}</span>}
      </div>
      {changeText && (
        <div className="change">
          <span className={cls}>
            {arrow} {changeText}
          </span>
          <span className="muted">{changeLabel}</span>
        </div>
      )}
    </div>
  )
}
