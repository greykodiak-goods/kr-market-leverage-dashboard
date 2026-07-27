import type { ComponentType } from 'react'
import { HynixGroupSection } from '../features/hynix/HynixGroupSection'
import { HynixFlowRadarSection } from '../features/flow-radar/HynixFlowRadarSection'
import { ShortCoveringSection } from '../features/short-covering/ShortCoveringSection'
import { OpportunitySignals } from '../features/opportunity-signals/OpportunitySignals'
import { SemiconductorSection } from '../features/semiconductor/SemiconductorSection'
import { MacroSection } from '../features/macro/MacroSection'
import { LeverageSection } from '../features/leverage/LeverageSection'
import { NewsForecastSection } from '../features/news/NewsForecastSection'
import { HynixNewsSection } from '../features/hynix/HynixNewsSection'
import { MegaInvestorsBoard } from '../features/mega-investors/MegaInvestorsBoard'
import { SmartMoneyRadar } from '../features/mega-investors/SmartMoneyRadar'
import { FlowRotation } from '../features/mega-investors/FlowRotation'
import { MegaInvestorsNews } from '../features/mega-investors/MegaInvestorsNews'
import { BacktestSection } from '../features/backtest/BacktestSection'

// ---- Tabs (topic grouping) ----------------------------------------------
// NOTE: tab-ia-plan §6 capped tabs at 5; 'sim' was added as the 6th by 대표
// 지시 (2026-07-26, 시뮬레이터 전용 탭 분리). Do NOT add a 7th — consider
// sub-groups/accordions inside an existing tab first.
export type TabId = 'hynix' | 'semi' | 'market' | 'sim' | 'news' | 'giants'

export interface TabDef {
  id: TabId
  label: string // desktop label
  short: string // mobile short label
}

export const TABS: TabDef[] = [
  { id: 'hynix', label: '🟢 하이닉스', short: '하이닉스' },
  { id: 'semi', label: '🔵 반도체·글로벌', short: '반도체' },
  { id: 'market', label: '🔴 시장·레버리지', short: '시장' },
  { id: 'sim', label: '🤖 시뮬레이터', short: '시뮬' },
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
  // 수급 레이더는 시세 바로 다음·signals 앞 (supply-demand-radar-plan §3-A 배치 확정)
  { id: 'hynix-flow-radar', tab: 'hynix', title: '🎯 하이닉스 수급 레이더', Component: HynixFlowRadarSection },
  { id: 'short-covering', tab: 'hynix', title: '🩳 공매도·대차 상환 모니터', Component: ShortCoveringSection },
  { id: 'signals', tab: 'hynix', title: '⚡ 기회 · 관찰 신호 보드', Component: OpportunitySignals },
  // 종목 뉴스·기술적 전망은 종목 탭에 — 뉴스 탭은 시장 전반만 다룬다.
  { id: 'hynix-news', tab: 'hynix', title: '📰 하이닉스 뉴스 · 기술적 전망', Component: HynixNewsSection },
  { id: 'semiconductor', tab: 'semi', title: '반도체 업황 · 상대강도', Component: SemiconductorSection },
  { id: 'leverage', tab: 'market', title: '시장 온도 · 레버리지', Component: LeverageSection },
  { id: 'macro', tab: 'market', title: '매크로 위험 · 지수', Component: MacroSection },
  { id: 'backtest', tab: 'sim', title: '🤖 투자봇 시뮬레이터 (백테스트)', Component: BacktestSection },
  { id: 'news', tab: 'news', title: '📰 시장 전반 뉴스', Component: NewsForecastSection },
  // 계산형(매일 바뀜)을 위, 정적 레퍼런스(분기 갱신)를 아래로 — 볼 것이 있는 순서.
  { id: 'smart-money-radar', tab: 'giants', title: '🎯 큰손 자금 레이더', Component: SmartMoneyRadar },
  { id: 'flow-rotation', tab: 'giants', title: '🔄 자금 로테이션 · 위험선호', Component: FlowRotation },
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
