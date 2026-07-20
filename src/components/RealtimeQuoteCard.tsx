import { format } from 'date-fns'
import type { Quote, QuotePeriod } from '../lib/quotes'
import { QUOTE_PERIODS } from '../lib/quotes'
import { IntradayChart } from './IntradayChart'
import { PeriodSelector } from './PeriodSelector'
import { InfoTip } from './InfoTip'

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
  onRetry?: () => void
  isRefetching?: boolean
  tag?: string
  extra?: React.ReactNode
  shortHistoryNote?: string // shown when a long period returns little data (e.g. newly-listed ADR)
  info?: string
  indexPoints?: boolean // render as plain index points (no currency symbol)
}

function money(v: number, currency: string, indexPoints?: boolean) {
  if (indexPoints) {
    return v.toLocaleString('ko-KR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  }
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
  onRetry,
  isRefetching,
  tag,
  extra,
  shortHistoryNote,
  info,
  indexPoints,
}: Props) {
  const m = (v: number) => money(v, quote?.currency ?? '', indexPoints)
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
            {info && <InfoTip text={info} />}
          </h2>
          <div className="panel-sub">{symbolLabel}</div>
        </div>
        {quote?.stale && <span className="badge sample" style={{ fontSize: 11 }}>캐시(갱신실패)</span>}
      </div>

      {isLoading && !quote ? (
        <div className="quote-skeleton" aria-label="시세 불러오는 중">
          <div className="skeleton skeleton-price" />
          <div className="skeleton skeleton-change" />
          <div className="skeleton skeleton-meta" />
          <div className="skeleton skeleton-chart" />
        </div>
      ) : isError && !quote ? (
        <div style={{ height: 180, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: 'var(--danger)', fontSize: 13, textAlign: 'center', padding: 12 }}>
          시세를 가져오지 못했습니다.<br />(CORS 프록시 전부 응답 없음)
          {onRetry && (
            <button type="button" className="retry-btn" onClick={onRetry} disabled={isRefetching}>
              {isRefetching ? '재시도 중…' : '↻ 다시 시도'}
            </button>
          )}
        </div>
      ) : quote ? (
        <>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
            <div style={{ fontSize: 30, fontWeight: 700, letterSpacing: '-0.02em' }}>
              {m(quote.price)}
            </div>
            <div style={{ color: changeColor, fontSize: 15, fontWeight: 600 }}>
              {arrow} {m(Math.abs(quote.change))} ({quote.change >= 0 ? '+' : '-'}
              {Math.abs(quote.changePct).toFixed(2)}%)
              <span style={{ color: 'var(--text-faint)', fontWeight: 400, fontSize: 12, marginLeft: 6 }}>{changeLabel}</span>
            </div>
          </div>

          <div style={{ display: 'flex', gap: 16, margin: '8px 0 6px', fontSize: 12, color: 'var(--text-dim)' }}>
            <span>고 {m(quote.dayHigh)}</span>
            <span>저 {m(quote.dayLow)}</span>
            <span>기준 {m(quote.previousClose)}</span>
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
