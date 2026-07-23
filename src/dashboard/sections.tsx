import type { ComponentType } from 'react'
import { HynixGroupSection } from '../features/hynix/HynixGroupSection'
import { ShortCoveringSection } from '../features/short-covering/ShortCoveringSection'
import { OpportunitySignals } from '../features/opportunity-signals/OpportunitySignals'
import { SemiconductorSection } from '../features/semiconductor/SemiconductorSection'
import { MacroSection } from '../features/macro/MacroSection'
import { LeverageSection } from '../features/leverage/LeverageSection'
import { NewsForecastSection } from '../features/news/NewsForecastSection'
import { MegaInvestorsBoard } from '../features/mega-investors/MegaInvestorsBoard'
import { MegaInvestorsNews } from '../features/mega-investors/MegaInvestorsNews'

// ---- Tabs (topic grouping) ----------------------------------------------
// NOTE: 5 tabs = the IA cap (tab-ia-plan §6). Do NOT append a 6th tab —
// consider sub-groups/accordions inside an existing tab first.
export type TabId = 'hynix' | 'semi' | 'market' | 'news' | 'giants'

export interface TabDef {
  id: TabId
  label: string // desktop label
  short: string // mobile short label
}

export const TABS: TabDef[] = [
  { id: 'hynix', label: '🟢 하이닉스', short: '하이닉스' },
  { id: 'semi', label: '🔵 반도체·글로벌', short: '반도체' },
  { id: 'market', label: '🔴 시장·레버리지', short: '시장' },
  { id: 'news', label: '📰 뉴스', short: '뉴스' },
  { id: 'giants', label: '🏦 큰손 동향', short: '큰손' },
]

export const DEFAULT_TAB: TabId = 'hynix'

export function isTabId(x: string): x is TabId {
  return TABS.some((t) => t.id === x)
}

// ---- Sections (each belongs to exactly one tab) --------------------------
export interface SectionDef {
  id: string
  tab: TabId
  title: string
  Component: ComponentType
}

// Single source of truth for section → tab membership + order. Adding, removing,
// reordering, or re-homing a section = one edit here (small conflict surface).
// The "하이닉스 종목" group bundles realtime prices + scenario outlook into ONE
// draggable section (they move together).
export const SECTIONS: SectionDef[] = [
  { id: 'hynix', tab: 'hynix', title: '하이닉스 종목 (시세 + 기술적 전망)', Component: HynixGroupSection },
  { id: 'short-covering', tab: 'hynix', title: '🩳 공매도·대차 상환 모니터', Component: ShortCoveringSection },
  { id: 'signals', tab: 'hynix', title: '⚡ 기회 · 관찰 신호 보드', Component: OpportunitySignals },
  { id: 'semiconductor', tab: 'semi', title: '반도체 업황 · 상대강도', Component: SemiconductorSection },
  { id: 'leverage', tab: 'market', title: '시장 온도 · 레버리지', Component: LeverageSection },
  { id: 'macro', tab: 'market', title: '매크로 위험 · 지수', Component: MacroSection },
  { id: 'news', tab: 'news', title: '뉴스 · 기술적 지표', Component: NewsForecastSection },
  { id: 'mega-investors-ref', tab: 'giants', title: '🏦 세계 초대형 투자사 레퍼런스', Component: MegaInvestorsBoard },
  { id: 'mega-investors-news', tab: 'giants', title: '🏦 큰손·기관 동향 뉴스', Component: MegaInvestorsNews },
]

// Default section-id order per tab (registry order filtered by tab).
export function defaultTabLayout(): Record<TabId, string[]> {
  const map = {} as Record<TabId, string[]>
  for (const t of TABS) map[t.id] = []
  for (const s of SECTIONS) map[s.tab].push(s.id)
  return map
}
