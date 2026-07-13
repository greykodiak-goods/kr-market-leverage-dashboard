import { useState } from 'react'
import { useQuote } from '../../hooks/useQuote'
import type { QuotePeriod } from '../../lib/quotes'
import { krxStatus, nowKst } from '../../lib/market'
import { RealtimeQuoteCard } from '../../components/RealtimeQuoteCard'
import { TOOLTIPS } from '../../lib/tooltips'
import { format } from 'date-fns'

// Is it the US-session window (~22:30–05:00 KST) where EWY trades and best
// reflects overnight direction for Korean equities?
function isNightWindow(): boolean {
  const k = nowKst()
  const min = k.getHours() * 60 + k.getMinutes()
  return min >= 22 * 60 + 30 || min <= 5 * 60
}

export function MacroSection() {
  const [kospiPeriod, setKospiPeriod] = useState<QuotePeriod>('1D')
  const [ewyPeriod, setEwyPeriod] = useState<QuotePeriod>('1D')
  const kospi = useQuote('^KS11', kospiPeriod)
  const ewy = useQuote('EWY', ewyPeriod)
  const status = krxStatus()
  const night = isNightWindow()

  return (
    <div>
      <div className="header" style={{ marginBottom: 12 }}>
        <div>
          <h1 style={{ fontSize: 18 }}>코스피 · 야간 프록시</h1>
          <div className="subtitle">
            주간=코스피지수(^KS11) · 야간=EWY(미국상장 한국ETF) · ~25초 폴링
          </div>
        </div>
        <div className="badges">
          <span className={`badge ${status.isOpen ? 'live' : ''}`}>KRX {status.label}</span>
          <span className={`badge ${night ? 'live' : ''}`}>{night ? '야간(미국장) 활성' : '야간 대기'}</span>
          <span className="badge">KST {format(nowKst(), 'HH:mm')}</span>
        </div>
      </div>

      <div className="grid-2">
        <RealtimeQuoteCard
          title="코스피 종합지수"
          symbolLabel="^KS11 · 주간 지수"
          quote={kospi.data}
          isLoading={kospi.isLoading}
          isError={kospi.isError}
          color="var(--kospi)"
          gradientId="gKospiIdx"
          period={kospiPeriod}
          onPeriodChange={setKospiPeriod}
          tag={status.isOpen ? '주간 활성' : 'KOSPI'}
          info={TOOLTIPS.kospi}
          indexPoints
        />
        <RealtimeQuoteCard
          title="코스피 야간 프록시"
          symbolLabel="EWY · iShares MSCI Korea (NYSE)"
          quote={ewy.data}
          isLoading={ewy.isLoading}
          isError={ewy.isError}
          color="#8b5cf6"
          gradientId="gEwy"
          period={ewyPeriod}
          onPeriodChange={setEwyPeriod}
          tag={night ? '야간 활성' : '야간 프록시'}
          info={TOOLTIPS.nightProxy}
          extra={
            <div style={{ fontSize: 11, color: 'var(--text-faint)', margin: '2px 0 6px' }}>
              ※ 정식 코스피 야간선물 아님 · 미국 상장 한국 ETF(USD) 방향성 참고. 등락률(%) 중심으로 보세요.
            </div>
          }
        />
      </div>
    </div>
  )
}
