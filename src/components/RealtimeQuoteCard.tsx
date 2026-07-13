import { format } from 'date-fns'
import type { Quote } from '../lib/quotes'
import { IntradayChart } from './IntradayChart'

interface Props {
  title: string
  symbolLabel: string
  quote?: Quote
  isLoading: boolean
  isError: boolean
  color: string
  gradientId: string
  tag?: string // e.g. 'NASDAQ' or '저유동성 OTC'
  extra?: React.ReactNode // extra rows (e.g. ADR premium)
}

function money(v: number, currency: string) {
  const digits = currency === 'USD' ? 2 : 0
  const symbol = currency === 'USD' ? '$' : '₩'
  return `${symbol}${v.toLocaleString('ko-KR', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`
}

export function RealtimeQuoteCard({ title, symbolLabel, quote, isLoading, isError, color, gradientId, tag, extra }: Props) {
  const up = quote ? quote.change > 0 : false
  const down = quote ? quote.change < 0 : false
  // KR convention: up = red, down = blue
  const changeColor = up ? 'var(--up)' : down ? 'var(--down)' : 'var(--text-faint)'
  const arrow = up ? '▲' : down ? '▼' : '→'

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
        <div style={{ height: 150, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-dim)', fontSize: 13 }}>
          시세 불러오는 중…
        </div>
      ) : isError && !quote ? (
        <div style={{ height: 150, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--danger)', fontSize: 13, textAlign: 'center', padding: 12 }}>
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
            </div>
          </div>

          <div style={{ display: 'flex', gap: 16, margin: '8px 0 4px', fontSize: 12, color: 'var(--text-dim)' }}>
            <span>고 {money(quote.dayHigh, quote.currency)}</span>
            <span>저 {money(quote.dayLow, quote.currency)}</span>
            <span>전일 {money(quote.previousClose, quote.currency)}</span>
          </div>

          {extra}

          <IntradayChart
            data={quote.intraday}
            color={color}
            gradientId={gradientId}
            currency={quote.currency}
            previousClose={quote.previousClose}
          />

          <div style={{ fontSize: 11, color: 'var(--text-faint)', marginTop: 2 }}>
            최종 갱신 {format(new Date(quote.fetchedAt), 'HH:mm:ss')} · 경로 {quote.proxyUsed} · 약 30초 지연 시세
          </div>
        </>
      ) : null}
    </div>
  )
}
