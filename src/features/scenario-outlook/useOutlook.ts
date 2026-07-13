import { useQuery } from '@tanstack/react-query'
import { fetchOutlook, SEED_OUTLOOK } from './outlook'
import type { Outlook } from './outlook'

// Poll the static outlook asset a few times a day so a scheduled file swap on
// gh-pages is picked up without a rebuild.
export function useOutlook() {
  return useQuery<Outlook>({
    queryKey: ['hynix-outlook'],
    queryFn: fetchOutlook,
    refetchInterval: 60 * 60_000, // hourly (file updates ~2x/day)
    staleTime: 30 * 60_000,
    retry: 1,
    placeholderData: SEED_OUTLOOK,
  })
}
