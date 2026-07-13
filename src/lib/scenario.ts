import type { IndicatorResult } from './indicators'
import type { ScenarioKey } from './outlook'

export type ScenarioStatus = 'active' | 'watch' | 'inactive'

export interface ScenarioAssessment {
  active: ScenarioKey
  scores: Record<ScenarioKey, number>
  statusByKey: Record<ScenarioKey, ScenarioStatus>
  reasons: string[]
}

function smaVal(r: IndicatorResult, period: number): number | null {
  return r.sma.find((s) => s.period === period)?.value ?? null
}

// Re-derive the technically "weighted" scenario from live 000660 indicators.
// Qualitative only — this is a market-state read, not a recommendation.
export function assessScenario(r: IndicatorResult): ScenarioAssessment {
  const close = r.lastPrice
  const sma20 = smaVal(r, 20)
  const sma60 = smaVal(r, 60)
  const sma120 = smaVal(r, 120)
  const rsi = r.rsi
  const reasons: string[] = []

  let bull = 0
  let base = 0
  let bear = 0

  // Bull signals
  if (sma20 != null && close > sma20) { bull++; reasons.push('종가 > 20일선') }
  if (sma20 != null && sma60 != null && sma20 > sma60) { bull++; reasons.push('20일선 > 60일선(정배열)') }
  if (rsi != null && rsi >= 50 && rsi <= 70) { bull++; reasons.push(`RSI ${rsi.toFixed(0)} (강세 중립권)`) }

  // Bear signals
  if (sma20 != null && sma60 != null && sma20 < sma60) { bear++; reasons.push('20일선 < 60일선(역배열)') }
  if (sma120 != null && close < sma120) { bear++; reasons.push('종가 < 120일선(장기선 이탈)') }
  if (rsi != null && rsi <= 40) { bear++; reasons.push(`RSI ${rsi.toFixed(0)} (약세권 접근)`) }

  // Base signals
  if (rsi != null && rsi > 40 && rsi < 60) base++
  if (sma20 != null && sma60 != null) {
    const hi = Math.max(sma20, sma60)
    const lo = Math.min(sma20, sma60)
    if (close <= hi && close >= lo) { base++; reasons.push('20~60일선 박스권') }
  }

  const scores: Record<ScenarioKey, number> = { bull, base, bear }
  // Require a strict majority for a directional call; ties/ambiguity → base
  // (neutral), so we never overstate direction.
  let active: ScenarioKey = 'base'
  if (bull > bear && bull > base) active = 'bull'
  else if (bear > bull && bear > base) active = 'bear'
  else active = 'base'

  const rank = (['bull', 'base', 'bear'] as ScenarioKey[]).sort((a, b) => scores[b] - scores[a])
  const statusByKey = {} as Record<ScenarioKey, ScenarioStatus>
  for (const k of ['bull', 'base', 'bear'] as ScenarioKey[]) {
    if (k === active) statusByKey[k] = 'active'
    else if (scores[k] > 0 && k === rank[1]) statusByKey[k] = 'watch'
    else statusByKey[k] = scores[k] > 0 ? 'watch' : 'inactive'
  }

  return { active, scores, statusByKey, reasons }
}

export const STATUS_LABEL: Record<ScenarioStatus, string> = {
  active: '현재 무게 실림',
  watch: '관찰',
  inactive: '비활성',
}
