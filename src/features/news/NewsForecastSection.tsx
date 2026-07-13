import { NewsFeed } from '../../components/NewsFeed'
import { ForecastCard } from '../../components/ForecastCard'

// Composition of the news feed + technical indicator/projection card.
export function NewsForecastSection() {
  return (
    <div className="grid-news">
      <NewsFeed />
      <ForecastCard />
    </div>
  )
}
