import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import * as Tooltip from '@radix-ui/react-tooltip'
import App from './App'
import './index.css'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60 * 30,
      // Keep cache alive across tab round-trips: switching tabs unmounts a tab's
      // sections (stopping their polling); the cache survives ~5min so re-entry
      // paints instantly and only live queries re-fetch in the background.
      gcTime: 1000 * 60 * 5,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <Tooltip.Provider delayDuration={120} skipDelayDuration={300}>
        <App />
      </Tooltip.Provider>
    </QueryClientProvider>
  </StrictMode>,
)
