import type {
  CreditPoint,
  Dataset,
  DashboardData,
  ShortBalancePoint,
  StockLendingPoint,
  ValuePoint,
} from '../types'

// Vite exposes BASE_URL as the configured `base` (e.g. /kr-market-leverage-dashboard/).
// Using it keeps fetch paths correct both locally and on GitHub Pages.
const BASE = import.meta.env.BASE_URL

export async function loadJson<T>(file: string): Promise<Dataset<T>> {
  const res = await fetch(`${BASE}data/${file}`)
  if (!res.ok) throw new Error(`Failed to load ${file}: ${res.status}`)
  return (await res.json()) as Dataset<T>
}

// Short-covering monitor datasets. Components render off meta.source (SEED/LIVE),
// so swapping the JSON for real data (data.go.kr) needs no component change.
export async function fetchStockLending(): Promise<Dataset<StockLendingPoint>> {
  return loadJson<StockLendingPoint>('hynix-lending.json')
}
export async function fetchShortBalance(): Promise<Dataset<ShortBalancePoint>> {
  return loadJson<ShortBalancePoint>('hynix-short-balance.json')
}

export async function fetchDashboardData(): Promise<DashboardData> {
  const [credit, unsettled, deposit, lending, creditRatio, turnover] = await Promise.all([
    loadJson<CreditPoint>('credit-balance.json'),
    loadJson<ValuePoint>('unsettled.json'),
    loadJson<ValuePoint>('deposit.json'),
    loadJson<ValuePoint>('lending.json'),
    loadJson<ValuePoint>('credit-ratio.json'),
    loadJson<ValuePoint>('turnover.json'),
  ])
  return { credit, unsettled, deposit, lending, creditRatio, turnover }
}
