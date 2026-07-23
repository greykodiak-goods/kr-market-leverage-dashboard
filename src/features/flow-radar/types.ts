// 수급 레이더 데이터 스키마 — public/data/supply-demand.json 의 형태.
// 생산자: scripts/fetch-supply-demand.mjs (DART LIVE + 플로우 SEED).
// 컴포넌트는 런타임 fetch로만 읽는다 (코드↔데이터 분리, HANDOVER-DEV §5).

export type SdBlockSource = 'seed' | 'dart' | 'dart+static' | 'kis'

export interface SdMeta {
  source: 'SEED' | 'LIVE'
  sourceLabel: string
  asOf: string // YYYY-MM-DD (KST)
  fetchedAt: string // ISO
  notes: string
}

export interface FlowDaily {
  date: string // YYYY-MM-DD
  foreignNetEok: number // 외국인 순매수 (억원, +매수/−매도)
  instNetEok: number // 기관 순매수 (억원)
  close: number // 종가 (원)
  valueEok: number // 거래대금 (억원)
  foreignHoldRatio: number // 외국인 보유율 (%)
}

export type SdEventType = 'major-stock' | 'insider' | 'overhang'

export interface SdEvent {
  type: SdEventType
  rceptNo: string
  rceptDt: string // YYYY-MM-DD
  reporter: string
  position?: string // 내부자 직위 (insider)
  shares?: number | null // 보고 후 보유주식수
  changeShares?: number | null // 증감 주식수
  ratioBefore?: number | null // 비율 전 (%)
  ratioAfter?: number | null // 비율 후 (%)
  ratioChange?: number | null // 비율 증감 (%p)
  reason?: string
  subtype?: string // overhang kind (유상증자/CB/DR·해외상장 …)
}

export interface OverhangItem {
  rceptNo: string
  rceptDt: string
  title: string // report_nm 원문
  filer: string
  kind: string
}

export interface MajorHolder {
  name: string
  ratio: number
  asOf: string
  note?: string
}

export interface Concentration {
  asOfLabel: string
  totalShares: number | null
  treasuryShares: number | null
  majorHolders: MajorHolder[]
  exitedNotes: string[]
  freeFloatRatioPct: number | null
  fivePctSum: number | null
  sensitivityScore: number // 1~5
  sensitivityLabel: string // 낮음/보통/높음
  note: string
}

export interface SupplyDemandData {
  meta: SdMeta
  sources: { flow: SdBlockSource; events: SdBlockSource; overhang: SdBlockSource; concentration: SdBlockSource }
  config: { twinStreakThreshold: number; zscoreWindow: number }
  flow: { daily: FlowDaily[] }
  events: SdEvent[]
  overhang: OverhangItem[]
  concentration: Concentration
  disclaimer: string
}
