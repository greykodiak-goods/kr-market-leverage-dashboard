// Keyword catalogs for keyword-driven news feeds. Users can toggle/add/remove;
// selection persists in localStorage (one storage key per catalog). The Hynix
// catalog below is the default; other feeds (e.g. mega-investors) supply their
// own KeywordCatalogConfig.

export interface Keyword {
  id: string
  label: string // display (+ default Google News query term)
  category: CategoryId
  matchTerms: string[] // lowercased substrings used to tag an article title
  custom?: boolean
  // Optional Google News query override. IMPORTANT: multi-word un-quoted terms
  // OR-joined in one query are parsed by Google as term-level AND/OR crossings
  // ("블랙록 BlackRock OR 뱅가드" → 블랙록 AND (BlackRock OR 뱅가드)) which
  // near-zeroes results. Use a single token or a "quoted phrase" here when the
  // display label is multi-word (e.g. bilingual labels).
  queryTerm?: string
}

// Union across ALL catalogs (hynix: tech/macro/geo/stock · giants: mgr/fund/tech/theme).
export type CategoryId = 'tech' | 'macro' | 'geo' | 'stock' | 'mgr' | 'fund' | 'theme'

// A pluggable keyword catalog: defaults + category labels + its own storage key.
export interface KeywordCatalogConfig {
  defaults: Keyword[]
  categories: { id: CategoryId; label: string }[]
  storageKey: string
  // Optional Google News query operator appended to every batch query
  // (e.g. 'when:30d' to bias low-volume catalogs toward recent articles).
  querySuffix?: string
}

export const CATEGORIES: { id: CategoryId; label: string }[] = [
  { id: 'tech', label: '기술·산업' },
  { id: 'macro', label: '거시·정책' },
  { id: 'geo', label: '지정학' },
  { id: 'stock', label: '종목' },
]

export const DEFAULT_KEYWORDS: Keyword[] = [
  // 기술·산업
  { id: 'ai', label: 'AI', category: 'tech', matchTerms: ['ai', '인공지능'] },
  { id: 'hbm', label: 'HBM', category: 'tech', matchTerms: ['hbm'] },
  { id: 'semi', label: '반도체', category: 'tech', matchTerms: ['반도체', 'semiconductor'] },
  { id: 'memory', label: '메모리 반도체', category: 'tech', matchTerms: ['메모리'] },
  { id: 'dram', label: 'DRAM', category: 'tech', matchTerms: ['dram', 'd램', '디램'] },
  { id: 'shortage', label: '메모리 쇼티지', category: 'tech', matchTerms: ['쇼티지', 'shortage', '공급부족'] },
  { id: 'nvidia', label: '엔비디아', category: 'tech', matchTerms: ['엔비디아', 'nvidia'] },
  { id: 'samsung', label: '삼성전자', category: 'tech', matchTerms: ['삼성전자', 'samsung'] },
  // 거시·정책
  { id: 'trump', label: '트럼프', category: 'macro', matchTerms: ['트럼프', 'trump'] },
  { id: 'tariff', label: '관세', category: 'macro', matchTerms: ['관세', 'tariff'] },
  { id: 'trade', label: '무역분쟁', category: 'macro', matchTerms: ['무역'] },
  { id: 'exportctrl', label: '수출규제', category: 'macro', matchTerms: ['수출규제', '수출 통제', 'export control'] },
  { id: 'rate', label: '금리', category: 'macro', matchTerms: ['금리', '기준금리'] },
  // 지정학
  { id: 'war', label: '전쟁', category: 'geo', matchTerms: ['전쟁', 'war'] },
  { id: 'taiwan', label: '대만', category: 'geo', matchTerms: ['대만', 'taiwan', 'tsmc'] },
  { id: 'chinasemi', label: '중국 반도체', category: 'geo', matchTerms: ['중국 반도체', '중국반도체', 'china chip'] },
  { id: 'iran', label: '이란', category: 'geo', matchTerms: ['이란', 'iran'] },
  { id: 'oman', label: '오만', category: 'geo', matchTerms: ['오만', 'oman'] },
  // 종목
  { id: 'hynix', label: 'SK하이닉스', category: 'stock', matchTerms: ['sk하이닉스', '하이닉스', 'sk hynix', 'hynix'] },
  { id: 'hynixadr', label: 'SK하이닉스 ADR', category: 'stock', matchTerms: ['adr', 'skhyv'] },
]

const STORAGE_KEY = 'news-keywords-v3'

// Default (Hynix) catalog config — existing behavior/storage key unchanged.
export const HYNIX_KEYWORD_CONFIG: KeywordCatalogConfig = {
  defaults: DEFAULT_KEYWORDS,
  categories: CATEGORIES,
  storageKey: STORAGE_KEY,
}

export interface KeywordState {
  enabledIds: string[]
  custom: Keyword[]
}

export function loadKeywordState(
  defaults: Keyword[] = DEFAULT_KEYWORDS,
  storageKey: string = STORAGE_KEY,
): KeywordState {
  try {
    const raw = localStorage.getItem(storageKey)
    if (raw) return JSON.parse(raw) as KeywordState
  } catch {
    /* ignore */
  }
  return { enabledIds: defaults.map((k) => k.id), custom: [] }
}

export function saveKeywordState(s: KeywordState, storageKey: string = STORAGE_KEY) {
  try {
    localStorage.setItem(storageKey, JSON.stringify(s))
  } catch {
    /* ignore */
  }
}
