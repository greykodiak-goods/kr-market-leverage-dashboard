export interface Meta {
  source: 'SEED' | 'LIVE'
  sourceLabel: string
  generatedAt: string
  asOf: string
  unit: string
  notes: string
  fetchedAt?: string // 수집 시각(KST ISO) — LIVE 데이터셋만
  start?: string // 시계열 시작일
  cadence?: string // 'daily' 등 갱신 주기
}

export interface CreditPoint {
  date: string
  kospi: number
  kosdaq: number
  total: number
}

export interface ValuePoint {
  date: string
  value: number
  // unsettled.json(위탁매매 미수금) 전용 부가 필드 — FreeSIS 증시자금추이 제공
  reverseTradeEok?: number // 미수금 대비 실제 반대매매금액(억원)
  reverseTradeRatioPct?: number // 미수금 대비 반대매매비중(%)
}

// Hynix stock lending (종목별 대차잔고) — LIVE source: data.go.kr 주식대차정보 (key pending).
export interface StockLendingPoint {
  date: string
  shares: number // 대차잔고 주수
  amountEok: number // 대차잔고 금액(억원)
}

// Hynix short-sale balance (공매도 잔고/비중) — source pending (KRX WAF blocked / gov API TBD).
export interface ShortBalancePoint {
  date: string
  shares: number // 공매도 잔고 주수
  amountEok: number // 공매도 잔고 금액(억원)
  ratioPct: number // 상장주식 대비 공매도 비중(%)
}

export interface Dataset<T> {
  meta: Meta
  series: T[]
}

export interface DashboardData {
  credit: Dataset<CreditPoint>
  unsettled: Dataset<ValuePoint>
  deposit: Dataset<ValuePoint>
  lending: Dataset<ValuePoint>
  creditRatio: Dataset<ValuePoint>
  turnover: Dataset<ValuePoint>
}
