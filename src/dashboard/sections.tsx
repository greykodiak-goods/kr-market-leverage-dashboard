import type { ComponentType } from 'react'
import { ScenarioSection } from '../features/scenario-outlook/ScenarioSection'
import { RealtimeSection } from '../components/RealtimeSection'
import { LeverageSection } from '../features/leverage/LeverageSection'
import { MacroSection } from '../features/macro/MacroSection'
import { NewsForecastSection } from '../features/news/NewsForecastSection'

export interface SectionDef {
  id: string
  title: string
  Component: ComponentType
}

// Single source of truth for dashboard section order + membership. Adding,
// removing, or reordering a section = one edit here (small conflict surface).
// The scenario board sits at the top by default.
export const SECTIONS: SectionDef[] = [
  { id: 'scenario', title: '기술적 시나리오 전망', Component: ScenarioSection },
  { id: 'realtime', title: 'SK하이닉스 실시간 시세', Component: RealtimeSection },
  { id: 'leverage', title: '시장 온도 · 레버리지', Component: LeverageSection },
  { id: 'macro', title: '코스피 · 야간 프록시', Component: MacroSection },
  { id: 'news', title: '뉴스 · 기술적 지표', Component: NewsForecastSection },
]

export const DEFAULT_ORDER = SECTIONS.map((s) => s.id)
