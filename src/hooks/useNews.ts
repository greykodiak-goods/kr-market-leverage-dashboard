import { useQuery } from '@tanstack/react-query'
import { fetchNews } from '../lib/news'
import type { NewsResult } from '../lib/news'
import type { Keyword } from '../lib/keywords'

const POLL_MS = 5 * 60_000 // refresh every 5 minutes

export function useNews(enabledKeywords: Keyword[]) {
  // Stable key from the enabled set so toggling keywords refetches.
  const key = enabledKeywords.map((k) => k.id).sort().join(',')
  return useQuery<NewsResult>({
    queryKey: ['news', key],
    queryFn: () => fetchNews(enabledKeywords),
    enabled: enabledKeywords.length > 0,
    refetchInterval: POLL_MS,
    staleTime: POLL_MS,
    retry: 0, // when proxies are rate-limited, retrying immediately won't help; wait for next poll
  })
}
