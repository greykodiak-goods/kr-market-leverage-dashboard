interface Props<T extends string> {
  periods: readonly T[]
  value: T
  onChange: (p: T) => void
}

export function PeriodSelector<T extends string>({ periods, value, onChange }: Props<T>) {
  return (
    <div className="period-selector" role="group" aria-label="기간 선택">
      {periods.map((p) => (
        <button
          key={p}
          type="button"
          className={`period-btn${p === value ? ' active' : ''}`}
          onClick={() => onChange(p)}
          aria-pressed={p === value}
        >
          {p}
        </button>
      ))}
    </div>
  )
}
