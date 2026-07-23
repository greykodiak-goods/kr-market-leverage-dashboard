// 수급 레이더 데이터 레이어 — outlook.ts/megaInvestors.ts 패턴.
// public/data/supply-demand.json 을 런타임 fetch (?t= 캐시버스팅)로 읽고,
// 실패 시 빌드 시점에 함께 번들된 같은 JSON을 폴백으로 쓴다(빈 화면 금지, 단일 원본).

import seedJson from '../../../public/data/supply-demand.json'
import type { SupplyDemandData } from './types'

export const SEED_SUPPLY_DEMAND = seedJson as unknown as SupplyDemandData

const BASE = import.meta.env.BASE_URL

export async function fetchSupplyDemand(): Promise<SupplyDemandData> {
  const url = `${BASE}data/supply-demand.json?t=${Date.now()}`
  try {
    const res = await fetch(url, { cache: 'no-cache' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const json = (await res.json()) as SupplyDemandData
    if (!json.flow?.daily?.length || !json.meta) throw new Error('malformed supply-demand.json')
    return json
  } catch {
    return SEED_SUPPLY_DEMAND
  }
}

// DART 원문 공시 뷰어 링크.
export function dartLink(rceptNo: string): string {
  return `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${rceptNo}`
}
