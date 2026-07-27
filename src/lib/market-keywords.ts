// 시장 전반 뉴스 키워드 카탈로그 — 뉴스 탭 전용.
//
// 하이닉스 관련 키워드는 여기 두지 않는다. 종목 뉴스는 하이닉스 탭의
// "하이닉스 영향 키워드 뉴스"가 담당하고, 이 탭은 판 전체(거시·지정학·산업·증시)를 본다.
// 저장 키가 하이닉스 카탈로그와 분리돼 있어 서로의 키워드 설정을 건드리지 않는다.
//
// Google 뉴스 질의 주의(keywords.ts 주석과 동일): 여러 단어를 따옴표 없이 OR로 묶으면
// 구글이 term 단위 AND/OR로 해석해 결과가 급감한다. 라벨이 여러 단어면 queryTerm에
// 단일 토큰이나 "따옴표 구문"을 넣는다.

import type { CategoryId, Keyword, KeywordCatalogConfig } from './keywords'

export const MARKET_CATEGORIES: { id: CategoryId; label: string }[] = [
  { id: 'macro', label: '거시·정책' },
  { id: 'geo', label: '지정학' },
  { id: 'tech', label: '산업·기술' },
  { id: 'stock', label: '증시·수급' },
]

export const MARKET_KEYWORDS: Keyword[] = [
  // 거시·정책
  { id: 'm-fed', label: '연준', category: 'macro', matchTerms: ['연준', 'fed', 'fomc', '연방준비'] },
  { id: 'm-rate', label: '금리', category: 'macro', matchTerms: ['금리', '기준금리'] },
  { id: 'm-inflation', label: '물가', category: 'macro', matchTerms: ['물가', '인플레이션', 'cpi', 'inflation'] },
  { id: 'm-fx', label: '환율', category: 'macro', matchTerms: ['환율', '원달러', '원·달러', '달러인덱스'] },
  { id: 'm-oil', label: '유가', category: 'macro', matchTerms: ['유가', '국제유가', 'wti', '브렌트'] },
  { id: 'm-recession', label: '경기침체', category: 'macro', matchTerms: ['경기침체', '침체', 'recession'] },
  { id: 'm-tariff', label: '관세', category: 'macro', matchTerms: ['관세', 'tariff'] },
  { id: 'm-trump', label: '트럼프', category: 'macro', matchTerms: ['트럼프', 'trump'] },

  // 지정학
  { id: 'g-taiwan', label: '대만', category: 'geo', matchTerms: ['대만', 'taiwan'] },
  { id: 'g-china', label: '중국 경제', category: 'geo', queryTerm: '"중국 경제"', matchTerms: ['중국 경제', '중국경제', '중국 증시'] },
  { id: 'g-war', label: '전쟁', category: 'geo', matchTerms: ['전쟁', 'war'] },
  { id: 'g-mideast', label: '중동', category: 'geo', matchTerms: ['중동', '이란', '이스라엘'] },
  { id: 'g-exportctrl', label: '수출규제', category: 'geo', matchTerms: ['수출규제', '수출 통제', 'export control'] },

  // 산업·기술
  { id: 't-ai', label: 'AI', category: 'tech', matchTerms: ['ai', '인공지능'] },
  { id: 't-semi', label: '반도체', category: 'tech', matchTerms: ['반도체', 'semiconductor'] },
  { id: 't-battery', label: '2차전지', category: 'tech', matchTerms: ['2차전지', '이차전지', '배터리'] },
  { id: 't-bio', label: '바이오', category: 'tech', matchTerms: ['바이오', '제약'] },
  { id: 't-auto', label: '자동차', category: 'tech', matchTerms: ['자동차', '완성차', '전기차'] },
  { id: 't-defense', label: '방산', category: 'tech', matchTerms: ['방산', '방위산업'] },
  { id: 't-ship', label: '조선', category: 'tech', matchTerms: ['조선', '수주'] },

  // 증시·수급
  { id: 's-kospi', label: '코스피', category: 'stock', matchTerms: ['코스피', 'kospi'] },
  { id: 's-kosdaq', label: '코스닥', category: 'stock', matchTerms: ['코스닥', 'kosdaq'] },
  { id: 's-foreign', label: '외국인 수급', category: 'stock', queryTerm: '"외국인 순매수"', matchTerms: ['외국인 순매수', '외국인 매도', '외국인 매수'] },
  { id: 's-short', label: '공매도', category: 'stock', matchTerms: ['공매도'] },
  { id: 's-ipo', label: '공모주', category: 'stock', matchTerms: ['공모주', 'ipo', '상장'] },
  { id: 's-dividend', label: '배당', category: 'stock', matchTerms: ['배당'] },
  { id: 's-nasdaq', label: '나스닥', category: 'stock', matchTerms: ['나스닥', 'nasdaq', 's&p', 'sp500'] },
]

export const MARKET_NEWS_CACHE_KEY = 'market-news-cache-v1'

export const MARKET_KEYWORD_CONFIG: KeywordCatalogConfig = {
  defaults: MARKET_KEYWORDS,
  categories: MARKET_CATEGORIES,
  storageKey: 'market-news-keywords-v1',
}
