// Mega-investors ("큰손") static reference data layer.
// The catalog lives in a STATIC asset (public/data/mega-investors.json) so it
// can be refreshed (quarterly-ish, manual) by replacing just that file on
// gh-pages — no rebuild (HANDOVER-DEV §5 code↔data separation). The component
// reads it at runtime only; the build-time JSON import below doubles as the
// in-code SEED fallback so the board is never empty (single source, no copy).

import seedJson from '../../../public/data/mega-investors.json'

export type InvestorType =
  | 'asset-manager'
  | 'sovereign-wealth'
  | 'pension'
  | 'tech-fund'
  | 'hedge-fund'
  | 'holding'

export const INVESTOR_TYPE_LABELS: Record<InvestorType, string> = {
  'asset-manager': '자산운용',
  'sovereign-wealth': '국부펀드',
  pension: '연기금',
  'tech-fund': '테크·벤처펀드',
  'hedge-fund': '헤지펀드',
  holding: '지주·투자',
}

export interface MegaInvestor {
  id: string
  name: string
  nameKo: string
  type: InvestorType
  aumUsd: number // approximate, USD
  asOf: string // e.g. "2025-Q4"
  approx: boolean
  belowCutoff: boolean // true → §1-C reference-only item (below the 1,000조 cutoff)
  relevanceTags: string[]
  relevanceNote: string
}

export interface MegaInvestorsData {
  asOf: string
  fxUsdKrw: number // display-only approximate FX for KRW conversion (runtime-computed)
  cutoffUsd: number
  cutoffNote: string
  disclaimer: string
  investors: MegaInvestor[]
}

// Baked-in fallback = the same JSON at build time (never render an empty board).
export const SEED_MEGA_INVESTORS = seedJson as MegaInvestorsData

const BASE = import.meta.env.BASE_URL

export async function fetchMegaInvestors(): Promise<MegaInvestorsData> {
  // Cache-busting query so a replaced static file is picked up without a rebuild.
  const url = `${BASE}data/mega-investors.json?t=${Date.now()}`
  try {
    const res = await fetch(url, { cache: 'no-cache' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const json = (await res.json()) as MegaInvestorsData
    if (!json.investors?.length) throw new Error('empty investors')
    return json
  } catch {
    return SEED_MEGA_INVESTORS
  }
}

// ---- display formatting (approximate values, Korean units) ----------------

// $14.0e12 → "약 14.0조 달러" · $925e9 → "약 9,250억 달러"
export function formatAumUsd(v: number): string {
  if (v >= 1e12) return `약 ${(v / 1e12).toFixed(1)}조 달러`
  return `약 ${Math.round(v / 1e8).toLocaleString('ko-KR')}억 달러`
}

// KRW conversion at data-file FX. ≥1경 → "약 1.96경원", else "약 2,940조원"
export function formatAumKrw(aumUsd: number, fxUsdKrw: number): string {
  const krw = aumUsd * fxUsdKrw
  if (krw >= 1e16) return `약 ${(krw / 1e16).toFixed(2)}경원`
  return `약 ${Math.round(krw / 1e12).toLocaleString('ko-KR')}조원`
}
