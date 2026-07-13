import { useQuote, useUsdKrw } from '../hooks/useQuote'
import { krxStatus, nowKst } from '../lib/market'
import { RealtimeQuoteCard } from './RealtimeQuoteCard'
import { format } from 'date-fns'

const SYMBOL_KRX = '000660.KS'
const SYMBOL_ADR = 'SKHYV' // SK hynix ADS (NASDAQ, 2026-07-10 상장). 구 OTC HXSCL/HXSCF는 상장폐지됨.

// ADR 1주가 나타내는 원주 수 — 공시 미확인 가정치. 프리미엄은 참고용.
const ADR_ORDINARY_RATIO = 0.125 // 1 ADR ≈ 1/8 원주 (가정)

export function RealtimeSection() {
  const krx = useQuote(SYMBOL_KRX)
  const adr = useQuote(SYMBOL_ADR)
  const fx = useUsdKrw()
  const status = krxStatus()

  // ADR premium/discount vs KRX (참고용, ratio·환율 가정 기반)
  let premiumNode: React.ReactNode = null
  if (adr.data && krx.data && fx.data) {
    const fxRate = fx.data
    const adrKrwPerAdr = adr.data.price * fxRate // 1 ADR의 원화 가격
    const impliedPerShare = adrKrwPerAdr / ADR_ORDINARY_RATIO // ADR 환산 원주 1주 가격
    const premiumPct = (impliedPerShare / krx.data.price - 1) * 100
    const disc = premiumPct >= 0
    premiumNode = (
      <div
        style={{
          background: 'var(--panel-2)',
          border: '1px solid var(--border)',
          borderRadius: 8,
          padding: '8px 10px',
          margin: '4px 0 8px',
          fontSize: 12,
          color: 'var(--text-dim)',
          lineHeight: 1.7,
        }}
      >
        <div>
          원화환산 <strong style={{ color: 'var(--text)' }}>₩{Math.round(adrKrwPerAdr).toLocaleString('ko-KR')}</strong>
          {' '}/ ADR · 환율 ₩{Math.round(fxRate).toLocaleString('ko-KR')}
        </div>
        <div>
          KRX 대비{' '}
          <strong style={{ color: disc ? 'var(--up)' : 'var(--down)' }}>
            {disc ? '+' : ''}
            {premiumPct.toFixed(2)}% {disc ? '프리미엄' : '디스카운트'}
          </strong>
        </div>
        <div style={{ color: 'var(--text-faint)', fontSize: 11 }}>
          ※ 비율 가정치 1 ADR = {ADR_ORDINARY_RATIO} 원주 · 환율/비율 가정 기반 참고값
        </div>
      </div>
    )
  }

  return (
    <section style={{ marginBottom: 16 }}>
      <div className="header" style={{ marginBottom: 12 }}>
        <div>
          <h1 style={{ fontSize: 18 }}>SK하이닉스 실시간(근실시간) 시세</h1>
          <div className="subtitle">KRX 원주 · NASDAQ ADR · ~25초 폴링 자동 갱신</div>
        </div>
        <div className="badges">
          <span className={`badge ${status.isOpen ? 'live' : ''}`}>KRX {status.label}</span>
          <span className="badge">KST {format(nowKst(), 'HH:mm')}</span>
        </div>
      </div>

      <div className="grid-2">
        <RealtimeQuoteCard
          title="SK하이닉스"
          symbolLabel="KRX 000660 · 원주"
          quote={krx.data}
          isLoading={krx.isLoading}
          isError={krx.isError}
          color="var(--kospi)"
          gradientId="gQuoteKrx"
          tag="KOSPI"
        />
        <RealtimeQuoteCard
          title="SK하이닉스 ADR"
          symbolLabel="NASDAQ SKHYV · 미국예탁증서"
          quote={adr.data}
          isLoading={adr.isLoading}
          isError={adr.isError}
          color="var(--kosdaq)"
          gradientId="gQuoteAdr"
          tag="NASDAQ ADS"
          extra={premiumNode}
        />
      </div>
    </section>
  )
}
