import { useQuery } from '@tanstack/react-query'
import { fetchNews } from '../lib/news'
import type { NewsResult } from '../lib/news'
import type { Keyword } from '../lib/keywords'

const POLL_MS = 5 * 60_000 // refresh every 5 minutes

// cacheKey (optional) namespaces both the react-query key and the localStorage
// last-good fallback so multiple feeds (Hynix / mega-investors) never mix.
// querySuffix (optional) is forwarded to fetchNews (Google News operator).
export function useNews(enabledKeywords: Keyword[], cacheKey?: string, querySuffix?: string) {
  // Stable key from the enabled set so toggling keywords refetches.
  const key = enabledKeywords.map((k) => k.id).sort().join(',')
  return useQuery<NewsResult>({
    queryKey: ['news', cacheKey ?? 'default', key],
    queryFn: () => fetchNews(enabledKeywords, cacheKey, querySuffix),
    enabled: enabledKeywords.length > 0,
    refetchInterval: POLL_MS,
    staleTime: POLL_MS,
    retry: 0, // when proxies are rate-limited, retrying immediately won't help; wait for next poll
  })
}
