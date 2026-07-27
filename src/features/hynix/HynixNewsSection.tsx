import { NewsFeed } from '../../components/NewsFeed'
import { ForecastCard } from '../../components/ForecastCard'

// 하이닉스 탭 — 종목 뉴스 + 기술적 전망.
// 원래 뉴스 탭에 있었으나 종목 정보는 종목 탭에 모으는 것이 맞아 이리로 옮겼다.
// 키워드 카탈로그·저장 키는 기존 하이닉스 것을 그대로 쓰므로 대표가 설정해둔
// 키워드 on/off 상태가 이동 후에도 유지된다.
export function HynixNewsSection() {
  return (
    <div className="grid-news">
      <NewsFeed prefsKey="hynix" />
      <ForecastCard />
    </div>
  )
}
