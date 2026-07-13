// Formatting helpers. Base unit of all series is 억원 (100M KRW).

export function formatEok(value: number): string {
  // Show 조원 (trillion) when large, otherwise 억원.
  if (Math.abs(value) >= 10000) {
    return `${(value / 10000).toLocaleString('ko-KR', { maximumFractionDigits: 2 })}조원`
  }
  return `${Math.round(value).toLocaleString('ko-KR')}억원`
}

export function formatEokShort(value: number): string {
  if (Math.abs(value) >= 10000) {
    return `${(value / 10000).toLocaleString('ko-KR', { maximumFractionDigits: 1 })}조`
  }
  return `${Math.round(value).toLocaleString('ko-KR')}억`
}

export function formatPercent(value: number, digits = 2): string {
  return `${value.toLocaleString('ko-KR', { minimumFractionDigits: digits, maximumFractionDigits: digits })}%`
}

export function formatSignedEok(value: number): string {
  const sign = value > 0 ? '+' : ''
  return `${sign}${formatEokShort(value)}`
}

export function formatSignedPercent(value: number, digits = 2): string {
  const sign = value > 0 ? '+' : ''
  return `${sign}${value.toLocaleString('ko-KR', { minimumFractionDigits: digits, maximumFractionDigits: digits })}%`
}

export function pctChange(curr: number, prev: number): number {
  if (!prev) return 0
  return ((curr - prev) / prev) * 100
}
