// Editable buy/sell rule rows for the strategy builder.

import type { CondOp, Condition, Operand, OperandKind } from './types'

const OPERAND_LABELS: { kind: OperandKind; label: string; hasPeriod: boolean }[] = [
  { kind: 'CLOSE', label: '종가', hasPeriod: false },
  { kind: 'SMA', label: 'SMA(단순이평)', hasPeriod: true },
  { kind: 'EMA', label: 'EMA(지수이평)', hasPeriod: true },
  { kind: 'RSI', label: 'RSI', hasPeriod: true },
  { kind: 'MACD_HIST', label: 'MACD 히스토그램', hasPeriod: false },
  { kind: 'BB_UPPER', label: '볼린저 상단', hasPeriod: true },
  { kind: 'BB_MID', label: '볼린저 중심', hasPeriod: true },
  { kind: 'BB_LOWER', label: '볼린저 하단', hasPeriod: true },
  { kind: 'HIGHEST', label: 'N일 최고가(직전)', hasPeriod: true },
  { kind: 'LOWEST', label: 'N일 최저가(직전)', hasPeriod: true },
  { kind: 'CONST', label: '상수값', hasPeriod: false },
]

const OP_LABELS: { op: CondOp; label: string }[] = [
  { op: 'crossAbove', label: '상향 돌파 ↗' },
  { op: 'crossBelow', label: '하향 돌파 ↘' },
  { op: 'gt', label: '> 보다 큼' },
  { op: 'lt', label: '< 보다 작음' },
]

function hasPeriod(kind: OperandKind): boolean {
  return OPERAND_LABELS.find((o) => o.kind === kind)?.hasPeriod ?? false
}

function OperandEditor({ value, onChange }: { value: Operand; onChange: (next: Operand) => void }) {
  return (
    <span className="bt-operand">
      <select
        value={value.kind}
        onChange={(e) => {
          const kind = e.target.value as OperandKind
          onChange({
            kind,
            period: hasPeriod(kind) ? (value.period ?? 20) : undefined,
            value: kind === 'CONST' ? (value.value ?? 0) : undefined,
          })
        }}
      >
        {OPERAND_LABELS.map((o) => (
          <option key={o.kind} value={o.kind}>
            {o.label}
          </option>
        ))}
      </select>
      {hasPeriod(value.kind) && (
        <input
          type="number"
          min={1}
          max={300}
          value={value.period ?? 20}
          onChange={(e) => onChange({ ...value, period: Number(e.target.value) })}
          title="기간(일)"
        />
      )}
      {value.kind === 'CONST' && (
        <input
          type="number"
          value={value.value ?? 0}
          onChange={(e) => onChange({ ...value, value: Number(e.target.value) })}
          title="상수값"
        />
      )}
    </span>
  )
}

interface Props {
  label: string
  combinator: 'AND' | 'OR'
  conditions: Condition[]
  onChange: (next: Condition[]) => void
}

export function ConditionEditor({ label, combinator, conditions, onChange }: Props) {
  function update(i: number, next: Condition) {
    onChange(conditions.map((c, j) => (j === i ? next : c)))
  }
  return (
    <div className="bt-cond-group">
      <div className="bt-cond-head">
        <strong>{label}</strong>
        <span className="bt-cond-comb">
          {combinator === 'AND' ? '모든 조건 충족 시 (AND)' : '하나라도 충족 시 (OR)'}
        </span>
        <button
          type="button"
          className="bt-btn-mini"
          onClick={() =>
            onChange([
              ...conditions,
              { left: { kind: 'CLOSE' }, op: 'gt', right: { kind: 'SMA', period: 20 } },
            ])
          }
        >
          + 조건 추가
        </button>
      </div>
      {conditions.length === 0 && <div className="bt-cond-empty">조건 없음 — 신호가 발생하지 않습니다</div>}
      {conditions.map((c, i) => (
        <div key={i} className="bt-cond-row">
          <OperandEditor value={c.left} onChange={(left) => update(i, { ...c, left })} />
          <select value={c.op} onChange={(e) => update(i, { ...c, op: e.target.value as CondOp })}>
            {OP_LABELS.map((o) => (
              <option key={o.op} value={o.op}>
                {o.label}
              </option>
            ))}
          </select>
          <OperandEditor value={c.right} onChange={(right) => update(i, { ...c, right })} />
          <button
            type="button"
            className="bt-btn-mini danger"
            aria-label="조건 삭제"
            onClick={() => onChange(conditions.filter((_, j) => j !== i))}
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  )
}
