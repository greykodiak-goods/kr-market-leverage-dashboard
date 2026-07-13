import type { ComponentType } from 'react'
import { HynixGroupSection } from '../features/hynix/HynixGroupSection'
import { OpportunitySignals } from '../features/opportunity-signals/OpportunitySignals'
import { SemiconductorSection } from '../features/semiconductor/SemiconductorSection'
import { MacroSection } from '../features/macro/MacroSection'
import { LeverageSection } from '../features/leverage/LeverageSection'
import { NewsForecastSection } from '../features/news/NewsForecastSection'

export interface SectionDef {
  id: string
  title: string
  Component: ComponentType
}

// Single source of truth for dashboard section order + membership. Adding,
// removing, or reordering a section = one edit here (small conflict surface).
//
// The "하이닉스 종목" group bundles realtime prices + technical scenario outlook
// into ONE draggable section (they move together) and sits at the top.
export const SECTIONS: SectionDef[] = [
  { id: 'hynix', title: '하이닉스 종목 (시세 + 기술적 전망)', Component: HynixGroupSection },
  { id: 'signals', title: '⚡ 기회 · 관찰 신호 보드', Component: OpportunitySignals },
  { id: 'semiconductor', title: '반도체 업황 · 상대강도', Component: SemiconductorSection },
  { id: 'macro', title: '매크로 위험 · 지수', Component: MacroSection },
  { id: 'leverage', title: '시장 온도 · 레버리지', Component: LeverageSection },
  { id: 'news', title: '뉴스 · 기술적 지표', Component: NewsForecastSection },
]

export const DEFAULT_ORDER = SECTIONS.map((s) => s.id)
