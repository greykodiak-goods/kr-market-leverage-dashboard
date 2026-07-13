import { format } from 'date-fns'
import type { Quote, QuotePeriod } from '../lib/quotes'
import { QUOTE_PERIODS } from '../lib/quotes'
import { IntradayChart } from './IntradayChart'
import { PeriodSelector } from './PeriodSelector'

interface Props {
  title: string
  symbolLabel: string
  quote?: Quote
  isLoading: boolean
  isError: boolean
  color: string
  gradientId: string
  period: QuotePeriod
  onPeriodChange: (p: QuotePeriod) => void
  tag?: string
  extra?: React.ReactNode
  shortHistoryNote?: string // shown when a long period returns little data (e.g. newly-listed ADR)
}

function money(v: number, currency: string) {
  const digits = currency === 'USD' ? 2 : 0
  const symbol = currency === 'USD' ? '$' : '₩'
  return `${symbol}${v.toLocaleString('ko-KR', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`
}

function spanDays(quote: Quote): number {
  const d = quote.intraday
  if (d.length < 2) return 0
  return (d[d.length - 1].t - d[0].t) / 86400
}

export function RealtimeQuoteCard({
  title,
  symbolLabel,
  quote,
  isLoading,
  isError,
  color,
  gradientId,
  period,
  onPeriodChange,
  tag,
  extra,
  shortHistoryNote,
}: Props) {
  const up = quote ? quote.change > 0 : false
  const down = quote ? quote.change < 0 : false
  // KR convention: up = red, down = blue
  const changeColor = up ? 'var(--up)' : down ? 'var(--down)' : 'var(--text-faint)'
  const arrow = up ? '▲' : down ? '▼' : '→'
  const changeLabel = period === '1D' ? '전일대비' : '기간대비'

  // Detect a long period that only returned a short history window.
  const isLongPeriod = period === '5Y' || period === '10Y' || period === 'MAX'
  const showShortNote = !!shortHistoryNote && !!quote && isLongPeriod && spanDays(quote) < 60

  return (
    <div className="panel quote-card">
      <div className="panel-head" style={{ alignItems: 'center' }}>
        <div>
          <h2 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {title}
            {tag && <span className="badge" style={{ fontSize: 11 }}>{tag}</span>}
          </h2>
          <div className="panel-sub">{symbolLabel}</div>
        </div>
        {quote?.stale && <span className="badge sample" style={{ fontSize: 11 }}>캐시(갱신실패)</span>}
      </div>

      {isLoading && !quote ? (
        <div style={{ height: 180, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-dim)', fontSize: 13 }}>
          시세 불러오는 중…
        </div>
      ) : isError && !quote ? (
        <div style={{ height: 180, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--danger)', fontSize: 13, textAlign: 'center', padding: 12 }}>
          시세를 가져오지 못했습니다.<br />(CORS 프록시 전부 응답 없음)
        </div>
      ) : quote ? (
        <>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
            <div style={{ fontSize: 30, fontWeight: 700, letterSpacing: '-0.02em' }}>
              {money(quote.price, quote.currency)}
            </div>
            <div style={{ color: changeColor, fontSize: 15, fontWeight: 600 }}>
              {arrow} {money(Math.abs(quote.change), quote.currency)} ({quote.change >= 0 ? '+' : '-'}
              {Math.abs(quote.changePct).toFixed(2)}%)
              <span style={{ color: 'var(--text-faint)', fontWeight: 400, fontSize: 12, marginLeft: 6 }}>{changeLabel}</span>
            </div>
          </div>

          <div style={{ display: 'flex', gap: 16, margin: '8px 0 6px', fontSize: 12, color: 'var(--text-dim)' }}>
            <span>고 {money(quote.dayHigh, quote.currency)}</span>
            <span>저 {money(quote.dayLow, quote.currency)}</span>
            <span>기준 {money(quote.previousClose, quote.currency)}</span>
          </div>

          {extra}

          <PeriodSelector periods={QUOTE_PERIODS} value={period} onChange={onPeriodChange} />

          <IntradayChart data={quote.intraday} color={color} gradientId={gradientId} currency={quote.currency} />

          {showShortNote && (
            <div style={{ fontSize: 11, color: 'var(--kosdaq)', marginTop: 2 }}>ⓘ {shortHistoryNote}</div>
          )}

          <div style={{ fontSize: 11, color: 'var(--text-faint)', marginTop: 2 }}>
            최종 갱신 {format(new Date(quote.fetchedAt), 'HH:mm:ss')} · 경로 {quote.proxyUsed}
            {period === '1D' ? ' · 약 30초 지연 시세' : ` · ${period} 히스토리`}
          </div>
        </>
      ) : null}
    </div>
  )
}
