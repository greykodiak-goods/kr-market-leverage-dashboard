// Keyword catalog for the Hynix-impact news feed. Users can toggle/add/remove;
// selection persists in localStorage.

export interface Keyword {
  id: string
  label: string // display + Google News query term
  category: CategoryId
  matchTerms: string[] // lowercased substrings used to tag an article title
  custom?: boolean
}

export type CategoryId = 'tech' | 'macro' | 'geo' | 'stock'

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
  // 종목
  { id: 'hynix', label: 'SK하이닉스', category: 'stock', matchTerms: ['sk하이닉스', '하이닉스', 'sk hynix', 'hynix'] },
  { id: 'hynixadr', label: 'SK하이닉스 ADR', category: 'stock', matchTerms: ['adr', 'skhyv'] },
]

const STORAGE_KEY = 'news-keywords-v2'

export interface KeywordState {
  enabledIds: string[]
  custom: Keyword[]
}

export function loadKeywordState(): KeywordState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) return JSON.parse(raw) as KeywordState
  } catch {
    /* ignore */
  }
  return { enabledIds: DEFAULT_KEYWORDS.map((k) => k.id), custom: [] }
}

export function saveKeywordState(s: KeywordState) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s))
  } catch {
    /* ignore */
  }
}
