// Preset strategy models. Each is expressed in the same Condition DSL the UI
// editor manipulates, so every preset's 매수/매도 조건 is fully inspectable and
// tweakable — presets are starting points, not black boxes.

import type { StrategyConfig } from './types'

export const PRESET_STRATEGIES: StrategyConfig[] = [
  {
    id: 'golden-cross',
    name: '이동평균 골든크로스',
    desc: '단기 SMA가 장기 SMA를 상향 돌파하면 매수, 하향 돌파하면 매도하는 추세추종 모델.',
    buy: [{ left: { kind: 'SMA', period: 5 }, op: 'crossAbove', right: { kind: 'SMA', period: 20 } }],
    sell: [{ left: { kind: 'SMA', period: 5 }, op: 'crossBelow', right: { kind: 'SMA', period: 20 } }],
  },
  {
    id: 'rsi-reversal',
    name: 'RSI 과매도 반등',
    desc: 'RSI가 과매도(30) 구간에서 위로 복귀할 때 매수, 과매수(70) 도달 시 매도하는 역추세 모델.',
    buy: [{ left: { kind: 'RSI', period: 14 }, op: 'crossAbove', right: { kind: 'CONST', value: 30 } }],
    sell: [{ left: { kind: 'RSI', period: 14 }, op: 'gt', right: { kind: 'CONST', value: 70 } }],
  },
  {
    id: 'bollinger-meanrev',
    name: '볼린저 평균회귀',
    desc: '종가가 볼린저 하단 밴드 아래로 과도하게 밀리면 매수, 중심선 회복 시 매도.',
    buy: [{ left: { kind: 'CLOSE' }, op: 'lt', right: { kind: 'BB_LOWER', period: 20 } }],
    sell: [{ left: { kind: 'CLOSE' }, op: 'gt', right: { kind: 'BB_MID', period: 20 } }],
  },
  {
    id: 'breakout',
    name: '신고가 돌파 (터틀형)',
    desc: '종가가 직전 20일 최고가를 넘으면 매수, 직전 10일 최저가를 깨면 매도하는 돌파 모델.',
    buy: [{ left: { kind: 'CLOSE' }, op: 'gt', right: { kind: 'HIGHEST', period: 20 } }],
    sell: [{ left: { kind: 'CLOSE' }, op: 'lt', right: { kind: 'LOWEST', period: 10 } }],
  },
  {
    id: 'macd-momentum',
    name: 'MACD 모멘텀',
    desc: 'MACD 히스토그램이 0선을 상향 돌파(모멘텀 전환)하면 매수, 하향 돌파하면 매도.',
    buy: [{ left: { kind: 'MACD_HIST' }, op: 'crossAbove', right: { kind: 'CONST', value: 0 } }],
    sell: [{ left: { kind: 'MACD_HIST' }, op: 'crossBelow', right: { kind: 'CONST', value: 0 } }],
  },
  {
    id: 'trend-filter-cross',
    name: '추세필터 + 골든크로스 (복합)',
    desc: '장기 추세(SMA60) 위에 있을 때만 단기 골든크로스를 매수하는 2중 조건 모델 — AND 조건 편집 예시.',
    buy: [
      { left: { kind: 'CLOSE' }, op: 'gt', right: { kind: 'SMA', period: 60 } },
      { left: { kind: 'SMA', period: 5 }, op: 'crossAbove', right: { kind: 'SMA', period: 20 } },
    ],
    sell: [{ left: { kind: 'CLOSE' }, op: 'crossBelow', right: { kind: 'SMA', period: 60 } }],
  },
]

export function findPreset(id: string): StrategyConfig {
  const p = PRESET_STRATEGIES.find((s) => s.id === id)
  if (!p) throw new Error(`unknown preset: ${id}`)
  return p
}

// Deep copy so the editor can mutate freely without touching the preset.
export function clonePreset(id: string): StrategyConfig {
  return JSON.parse(JSON.stringify(findPreset(id))) as StrategyConfig
}
