// Keyword catalog for the mega-investors ("큰손 동향") news feed.
// Policy (2026-07-21 대표 지시): the AUM ~1,000조원($700B) cutoff applies ONLY to
// the static reference board — news keywords keep below-cutoff giants
// (SoftBank·Berkshire·Bridgewater) because their AI/semiconductor news is
// directly relevant to Hynix demand/supply dynamics.
// label = display + Google News query term (한/영 병기), matchTerms = lowercase
// substrings used to tag article titles (Korean + English so both match).

import type { Keyword, KeywordCatalogConfig } from './keywords'

export const MEGA_INVESTOR_CATEGORIES: KeywordCatalogConfig['categories'] = [
  { id: 'mgr', label: '운용사' },
  { id: 'fund', label: '국부·연기금' },
  { id: 'tech', label: '테크 큰손' },
  { id: 'theme', label: '테마·수급' },
]

export const MEGA_INVESTOR_KEYWORDS: Keyword[] = [
  // 운용사 (Asset Managers)
  { id: 'blackrock', label: '블랙록 BlackRock', category: 'mgr', matchTerms: ['블랙록', 'blackrock', '아이셰어즈', 'ishares'] },
  { id: 'vanguard', label: '뱅가드 Vanguard', category: 'mgr', matchTerms: ['뱅가드', 'vanguard'] },
  { id: 'fidelity', label: '피델리티 Fidelity', category: 'mgr', matchTerms: ['피델리티', 'fidelity'] },
  { id: 'statestreet', label: '스테이트스트리트 State Street', category: 'mgr', matchTerms: ['스테이트스트리트', 'state street', 'spdr'] },
  { id: 'jpmorgan', label: 'JP모건 자산운용', category: 'mgr', matchTerms: ['jp모건', '제이피모간', 'jpmorgan asset', 'jpmam'] },
  { id: 'goldman', label: '골드만삭스 자산운용', category: 'mgr', matchTerms: ['골드만삭스 자산운용', 'goldman sachs asset', 'gsam'] },
  { id: 'capitalgroup', label: '캐피털그룹 Capital Group', category: 'mgr', matchTerms: ['캐피털그룹', 'capital group', 'american funds'] },
  { id: 'amundi', label: '아문디 Amundi', category: 'mgr', matchTerms: ['아문디', 'amundi'] },
  { id: 'pimco', label: '핌코 PIMCO', category: 'mgr', matchTerms: ['핌코', 'pimco'] },
  // 국부·연기금 (Sovereign Wealth / Pension)
  { id: 'nps', label: '국민연금 NPS', category: 'fund', matchTerms: ['국민연금', 'nps', '국민연금공단'] },
  { id: 'gpfg', label: '노르웨이 국부펀드', category: 'fund', matchTerms: ['노르웨이 국부펀드', '노르웨이 연기금', 'gpfg', 'norges', 'norway wealth'] },
  { id: 'gpif', label: '일본 GPIF', category: 'fund', matchTerms: ['gpif', '일본 연금', '일본 공적연금'] },
  { id: 'adia', label: '아부다비 ADIA', category: 'fund', matchTerms: ['아부다비', 'adia', 'abu dhabi'] },
  { id: 'pif', label: '사우디 PIF', category: 'fund', matchTerms: ['사우디 국부펀드', '사우디 pif', 'saudi pif', 'public investment fund'] },
  { id: 'gic', label: '싱가포르 GIC', category: 'fund', matchTerms: ['gic', '싱가포르 국부펀드', 'temasek', '테마섹'] },
  { id: 'cic', label: '중국 CIC', category: 'fund', matchTerms: ['중국투자공사', 'cic', 'china investment corp'] },
  { id: 'kic', label: '한국투자공사 KIC', category: 'fund', matchTerms: ['한국투자공사', 'kic'] },
  // 테크 큰손 — 커트라인 미달이어도 하이닉스 관련성으로 뉴스 키워드 유지
  { id: 'softbank', label: '소프트뱅크 SoftBank', category: 'tech', matchTerms: ['소프트뱅크', 'softbank', '비전펀드', 'vision fund', '손정의'] },
  { id: 'berkshire', label: '버크셔 Berkshire', category: 'tech', matchTerms: ['버크셔', 'berkshire', '버핏', 'buffett'] },
  { id: 'bridgewater', label: '브리지워터 Bridgewater', category: 'tech', matchTerms: ['브리지워터', 'bridgewater'] },
  // 테마·수급
  { id: 'semi-invest', label: '반도체 투자', category: 'theme', matchTerms: ['반도체 투자', '반도체 설비투자', 'chip investment'] },
  { id: 'ai-invest', label: 'AI 투자', category: 'theme', matchTerms: ['ai 투자', 'ai 인프라', '데이터센터 투자', 'ai capex'] },
  { id: 'foreign-buy', label: '외국인 순매수', category: 'theme', matchTerms: ['외국인 순매수', '외국인 매수', '외국인 매도', 'foreign buying'] },
  { id: 'stake-13f', label: '지분공시·13F', category: 'theme', matchTerms: ['13f', '대량보유', '지분 공시', 'stake', '보유 확대'] },
]

export const MEGA_INVESTOR_KEYWORD_CONFIG: KeywordCatalogConfig = {
  defaults: MEGA_INVESTOR_KEYWORDS,
  categories: MEGA_INVESTOR_CATEGORIES,
  storageKey: 'giants-keywords-v1',
}

// Per-feed last-good news cache (separate from the Hynix feed's news-cache-v3).
export const MEGA_INVESTOR_NEWS_CACHE_KEY = 'news-cache-giants-v1'
