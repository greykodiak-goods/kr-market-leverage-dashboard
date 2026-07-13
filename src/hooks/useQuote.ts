import { useQuery } from '@tanstack/react-query'
import { getQuote, getFxQuote, PERIOD_MAP } from '../lib/quotes'
import type { Quote, QuotePeriod } from '../lib/quotes'

const LIVE_POLL_MS = 25_000 // ~25s near-real-time for intraday (1D/5D)
const HIST_STALE_MS = 30 * 60_000 // long-range history changes slowly

function policy(period: QuotePeriod) {
  const live = PERIOD_MAP[period].live
  return {
    refetchInterval: live ? LIVE_POLL_MS : (false as const),
    staleTime: live ? 0 : HIST_STALE_MS,
    refetchOnWindowFocus: live,
  }
}

export function useQuote(symbol: string, period: QuotePeriod) {
  const p = policy(period)
  return useQuery<Quote>({
    queryKey: ['quote', symbol, period],
    queryFn: () => getQuote(symbol, period),
    retry: 1,
    ...p,
  })
}

export function useFxQuote(period: QuotePeriod) {
  const p = policy(period)
  return useQuery<Quote>({
    queryKey: ['fx', 'USDKRW', period],
    queryFn: () => getFxQuote(period),
    retry: 1,
    ...p,
  })
}
