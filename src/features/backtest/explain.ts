// 설명가능성(explainability) 레이어 — "왜 샀는가/왜 안 샀는가"를 그날의
// 실측 지표값으로 서술한다. 모델이 블랙박스가 아니라 검증 가능한 규칙임을
// 보이는 것이 목적이며, 백테스트·모의운용·오늘의 신호 모두 같은 함수를 쓴다.

import type { Condition, DailyBar, Operand, CondOp } from './types'
import { operandSeries } from './series'

const OPERAND_NAME: Record<Operand['kind'], (p?: number) => string> = {
  CLOSE: () => '종가',
  SMA: (p) => `SMA${p}`,
  EMA: (p) => `EMA${p}`,
  RSI: (p) => `RSI${p}`,
  MACD_HIST: () => 'MACD히스토그램',
  BB_UPPER: (p) => `볼린저상단(${p})`,
  BB_MID: (p) => `볼린저중심(${p})`,
  BB_LOWER: (p) => `볼린저하단(${p})`,
  HIGHEST: (p) => `직전${p}일고가`,
  LOWEST: (p) => `직전${p}일저가`,
  CONST: () => '',
}

const OP_TEXT: Record<CondOp, string> = {
  crossAbove: '상향돌파',
  crossBelow: '하향돌파',
  gt: '>',
  lt: '<',
}

export function operandName(op: Operand): string {
  if (op.kind === 'CONST') return String(op.value ?? 0)
  return OPERAND_NAME[op.kind](op.period)
}

export function conditionText(c: Condition): string {
  return `${operandName(c.left)} ${OP_TEXT[c.op]} ${operandName(c.right)}`
}

function fmtVal(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return '—'
  const abs = Math.abs(v)
  if (abs >= 1000) return Math.round(v).toLocaleString()
  if (abs >= 10) return v.toFixed(1)
  return v.toFixed(2)
}

export interface ConditionEval {
  text: string // 'SMA5 상향돌파 SMA20'
  detail: string // 'SMA5 72,340 vs SMA20 71,890 (전일 71,500 / 71,920)'
  met: boolean
}

// 조건 하나를 bars[i] 시점에서 평가하고 실측값과 함께 설명한다.
export function evalConditionAt(bars: DailyBar[], c: Condition, i: number): ConditionEval {
  const L = operandSeries(bars, c.left)
  const R = operandSeries(bars, c.right)
  const l = L[i]
  const r = R[i]
  const lp = i > 0 ? L[i - 1] : null
  const rp = i > 0 ? R[i - 1] : null

  let met = false
  if (l != null && r != null) {
    if (c.op === 'gt') met = l > r
    else if (c.op === 'lt') met = l < r
    else if (c.op === 'crossAbove') met = lp != null && rp != null && lp <= rp && l > r
    else if (c.op === 'crossBelow') met = lp != null && rp != null && lp >= rp && l < r
  }

  const isCross = c.op === 'crossAbove' || c.op === 'crossBelow'
  const detail = isCross
    ? `당일 ${operandName(c.left)} ${fmtVal(l)} / ${operandName(c.right)} ${fmtVal(r)} · 전일 ${fmtVal(lp)} / ${fmtVal(rp)}`
    : `${operandName(c.left)} ${fmtVal(l)} / ${operandName(c.right)} ${fmtVal(r)}`

  return { text: conditionText(c), detail, met }
}

export interface SignalExplain {
  date: string
  holding: boolean
  decision: '매수 신호' | '매도 신호' | '관망(조건 미충족)' | '보유 유지'
  buyConds: ConditionEval[]
  sellConds: ConditionEval[]
  summary: string
}

// 규칙형 모델의 특정 시점 판정 + 근거. holding=현재 보유 여부.
export function explainRuleSignal(
  bars: DailyBar[],
  buy: Condition[],
  sell: Condition[],
  i: number,
  holding: boolean,
): SignalExplain {
  const buyConds = buy.map((c) => evalConditionAt(bars, c, i))
  const sellConds = sell.map((c) => evalConditionAt(bars, c, i))
  const buyMet = buy.length > 0 && buyConds.every((c) => c.met)
  const sellMet = sellConds.some((c) => c.met)

  let decision: SignalExplain['decision']
  let summary: string
  if (!holding) {
    decision = buyMet ? '매수 신호' : '관망(조건 미충족)'
    summary = buyMet
      ? `매수 조건 ${buy.length}개 모두 충족 — ${buyConds.map((c) => c.text).join(' / ')}`
      : `미충족: ${buyConds.filter((c) => !c.met).map((c) => c.text).join(' / ') || '조건 없음'}`
  } else {
    decision = sellMet ? '매도 신호' : '보유 유지'
    summary = sellMet
      ? `매도 조건 충족 — ${sellConds.filter((c) => c.met).map((c) => c.text).join(' / ')}`
      : `매도 조건 미충족 — ${sellConds.map((c) => c.text).join(' / ') || '조건 없음'}`
  }
  return { date: bars[i].date, holding, decision, buyConds, sellConds, summary }
}
