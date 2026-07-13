import type { ComponentType } from 'react'
import { HynixGroupSection } from '../features/hynix/HynixGroupSection'
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
//
// The "하이닉스 종목" group bundles realtime prices + technical scenario outlook
// into ONE draggable section (they move together) and sits at the top.
export const SECTIONS: SectionDef[] = [
  { id: 'hynix', title: '하이닉스 종목 (시세 + 기술적 전망)', Component: HynixGroupSection },
  { id: 'leverage', title: '시장 온도 · 레버리지', Component: LeverageSection },
  { id: 'macro', title: '코스피 · 야간 프록시', Component: MacroSection },
  { id: 'news', title: '뉴스 · 기술적 지표', Component: NewsForecastSection },
]

export const DEFAULT_ORDER = SECTIONS.map((s) => s.id)
