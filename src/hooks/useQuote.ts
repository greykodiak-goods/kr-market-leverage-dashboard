import { useQuery } from '@tanstack/react-query'
import { getQuote, getUsdKrw } from '../lib/quotes'
import type { Quote } from '../lib/quotes'

const POLL_MS = 25_000 // ~25s near-real-time polling

export function useQuote(symbol: string) {
  return useQuery<Quote>({
    queryKey: ['quote', symbol],
    queryFn: () => getQuote(symbol),
    refetchInterval: POLL_MS,
    refetchOnWindowFocus: true,
    staleTime: 0,
    retry: 1,
  })
}

export function useUsdKrw() {
  return useQuery<number>({
    queryKey: ['fx', 'USDKRW'],
    queryFn: getUsdKrw,
    refetchInterval: POLL_MS,
    refetchOnWindowFocus: true,
    staleTime: 0,
    retry: 1,
  })
}
