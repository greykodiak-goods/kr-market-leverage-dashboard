import { useQuote } from '../hooks/useQuote'
import type { QuotePeriod } from '../lib/quotes'
import { Sparkline } from './Sparkline'
import { InfoTip } from './InfoTip'
import { changeArrow } from '../lib/format'

export type MiniUnit = 'auto' | 'index' | 'percent'

interface Props {
  symbol: string
  label: string
  tag?: string
  unit?: MiniUnit
  color?: string
  info?: string
  period?: QuotePeriod
  highlight?: boolean
}

function fmt(v: number, currency: string, unit: MiniUnit): string {
  if (unit === 'percent') return `${v.toFixed(2)}%`
  if (unit === 'index') return v.toLocaleString('ko-KR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  const sym = currency === 'USD' ? '$' : currency === 'KRW' ? '₩' : ''
  const digits = currency === 'KRW' ? 0 : 2
  return `${sym}${v.toLocaleString('ko-KR', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`
}

export function QuoteMiniCard({ symbol, label, tag, unit = 'auto', color = 'var(--accent)', info, period = '1D', highlight }: Props) {
  const { data, isLoading, isError, isRefetching, refetch } = useQuote(symbol, period)
  const up = data ? data.change > 0 : false
  const down = data ? data.change < 0 : false
  const cc = up ? 'var(--up)' : down ? 'var(--down)' : 'var(--text-faint)'
  const arrow = changeArrow(data?.change)

  return (
    <div className={`mini-card${highlight ? ' highlight' : ''}`}>
      <div className="mini-head">
        <span className="mini-label">
          {label}
          {info && <InfoTip text={info} />}
        </span>
        {tag && <span className="mini-tag">{tag}</span>}
      </div>
      {isLoading && !data ? (
        <div className="mini-skeleton" aria-label="시세 불러오는 중">
          <div className="skeleton skeleton-price" />
          <div className="skeleton skeleton-change" />
          <div className="skeleton skeleton-spark" />
        </div>
      ) : isError && !data ? (
        <div className="mini-loading err">
          시세 실패
          <button type="button" className="retry-btn" onClick={() => refetch()} disabled={isRefetching}>
            {isRefetching ? '재시도 중…' : '↻ 재시도'}
          </button>
        </div>
      ) : data ? (
        <>
          <div className="mini-price">{fmt(data.price, data.currency, unit)}</div>
          <div className="mini-change" style={{ color: cc }}>
            {arrow} {Math.abs(data.changePct).toFixed(2)}%
            <span className="mini-abs">
              {data.change >= 0 ? '+' : '−'}
              {unit === 'percent'
                ? Math.abs(data.change).toFixed(2)
                : fmt(Math.abs(data.change), data.currency, unit === 'auto' ? 'auto' : unit).replace(/^[₩$]/, '')}
            </span>
          </div>
          <Sparkline data={data.intraday} color={down ? 'var(--down)' : up ? 'var(--up)' : color} />
        </>
      ) : null}
    </div>
  )
}
