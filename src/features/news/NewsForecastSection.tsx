import { NewsFeed } from '../../components/NewsFeed'
import { MARKET_KEYWORD_CONFIG, MARKET_NEWS_CACHE_KEY } from '../../lib/market-keywords'

// 뉴스 탭 — 시장 전반(거시·지정학·산업·증시).
// 종목(하이닉스) 뉴스와 하이닉스 기술적 전망은 여기 두지 않고 하이닉스 탭이 담당한다.
// 키워드·뉴스캐시·열람상태 저장 키가 모두 분리돼 있어 두 피드가 서로의 설정을 건드리지 않는다.
export function NewsForecastSection() {
  return (
    <NewsFeed
      catalog={MARKET_KEYWORD_CONFIG}
      title="시장 전반 뉴스"
      subtitle="거시·정책 · 지정학 · 산업·기술 · 증시·수급 — 종목 뉴스는 🟢 하이닉스 탭에 있습니다"
      cacheKey={MARKET_NEWS_CACHE_KEY}
      prefsKey="market"
    />
  )
}
