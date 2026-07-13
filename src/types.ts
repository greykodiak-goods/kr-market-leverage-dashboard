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
