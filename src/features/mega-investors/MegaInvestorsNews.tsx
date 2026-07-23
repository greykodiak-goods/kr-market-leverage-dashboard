import { NewsFeed } from '../../components/NewsFeed'
import { MEGA_INVESTOR_KEYWORD_CONFIG, MEGA_INVESTOR_NEWS_CACHE_KEY } from '../../lib/mega-investor-keywords'

// 큰손·기관 동향 뉴스 — 기존 NewsFeed 인프라를 카탈로그 주입으로 재사용.
// 커트라인 미달 큰손(소프트뱅크·버크셔 등)도 하이닉스 관련성이 커서 키워드 유지.
export function MegaInvestorsNews() {
  return (
    <NewsFeed
      catalog={MEGA_INVESTOR_KEYWORD_CONFIG}
      title="큰손·기관 동향 뉴스"
      subtitle="초대형 투자사·국부펀드·연기금 관련 뉴스 · 반도체/AI/한국 우선"
      cacheKey={MEGA_INVESTOR_NEWS_CACHE_KEY}
    />
  )
}
