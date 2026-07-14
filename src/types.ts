export interface Meta {
  source: 'SEED' | 'LIVE'
  sourceLabel: string
  generatedAt: string
  asOf: string
  unit: string
  notes: string
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
