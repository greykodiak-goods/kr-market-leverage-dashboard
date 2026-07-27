import { useState } from 'react'
import { useQuote, useFxQuote } from '../hooks/useQuote'
import type { QuotePeriod } from '../lib/quotes'
import { krxStatus, nowKst } from '../lib/market'
import { RealtimeQuoteCard } from './RealtimeQuoteCard'
import { InfoTip } from './InfoTip'
import { TOOLTIPS } from '../lib/tooltips'
import { formatSignedPercent } from '../lib/format'
import { format } from 'date-fns'

const SYMBOL_KRX = '000660.KS'
const SYMBOL_ADR = 'SKHY' // SK hynix 정식 ADR (NasdaqGM). 구 when-issued 티커 SKHYV·OTC HXSCL/HXSCF는 폐지·전환됨.

// ADR 1주가 나타내는 원주 수 — 공식 비율(SEC 424B4 / SK하이닉스 나스닥 ADR 상장 공시).
// 10 ADR = 원주 1주.
const ADR_ORDINARY_RATIO = 0.1 // 1 ADR = 원주 1/10

export function RealtimeSection() {
  const [krxPeriod, setKrxPeriod] = useState<QuotePeriod>('1D')
  const [adrPeriod, setAdrPeriod] = useState<QuotePeriod>('1D')
  const [fxPeriod, setFxPeriod] = useState<QuotePeriod>('1D')

  const krx = useQuote(SYMBOL_KRX, krxPeriod)
  const adr = useQuote(SYMBOL_ADR, adrPeriod)
  const fx = useFxQuote(fxPeriod)
  const status = krxStatus()

  // ADR premium/discount vs KRX. meta.regularMarketPrice is current regardless of
  // the selected chart period, so premium stays correct even in long-range views.
  let premiumNode: React.ReactNode = null
  if (adr.data && krx.data && fx.data) {
    const fxRate = fx.data.price
    const adrKrwPerAdr = adr.data.price * fxRate // 1 ADR의 원화 가격
    const impliedPerShare = adrKrwPerAdr / ADR_ORDINARY_RATIO // ADR 환산 원주 1주 가격
    const premiumPct = (impliedPerShare / krx.data.price - 1) * 100
    const disc = premiumPct >= 0
    // 확장 세션(프리/애프터) 체결이 있으면 그 가격 기준 프리미엄을 "참고값"으로 병기.
    // 기본 지표(정규 종가 기준)는 그대로 유지 — 기준 혼동 금지.
    const ext = adr.data.extended
    const extPremiumPct = ext ? ((ext.price * fxRate) / ADR_ORDINARY_RATIO / krx.data.price - 1) * 100 : null
    const extLabel = ext ? (ext.session === 'pre' ? '프리장' : '애프터') : null
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
            {formatSignedPercent(premiumPct)} {disc ? '프리미엄' : '디스카운트'}
          </strong>
          {extPremiumPct != null && <span style={{ color: 'var(--text-faint)', fontSize: 11 }}> (정규 종가 기준)</span>}
          <InfoTip text={TOOLTIPS.premium} />
        </div>
        {extPremiumPct != null && (
          <div>
            {ext!.session === 'pre' ? '🌅' : '🌙'} {extLabel} 기준 프리미엄{' '}
            <strong style={{ color: extPremiumPct >= 0 ? 'var(--up)' : 'var(--down)' }}>
              {formatSignedPercent(extPremiumPct)}
            </strong>
            <span style={{ color: 'var(--text-faint)', fontSize: 11 }}>
              {' '}
              — 참고값 · {extLabel} 체결가 ${ext!.price.toLocaleString('ko-KR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} 기준(체결 얇음 주의)
            </span>
          </div>
        )}
        <div style={{ color: 'var(--text-faint)', fontSize: 11 }}>
          ※ 공식 비율 1 ADR = 원주 1/10 (SEC 424B4) · 신규 상장 초기라 괴리(프리미엄)가 클 수 있음
        </div>
      </div>
    )
  }

  return (
    <section style={{ marginBottom: 16 }}>
      <div className="header" style={{ marginBottom: 12 }}>
        <div>
          <h1 style={{ fontSize: 18 }}>SK하이닉스 실시간(근실시간) 시세 · 장기 히스토리</h1>
          <div className="subtitle">KRX 원주 · NASDAQ ADR · 원/달러 · 기간 버튼으로 최대 20년+ 조회</div>
        </div>
        <div className="badges">
          <span className={`badge ${status.isOpen ? 'live' : ''}`}>KRX {status.label}</span>
          <span className="badge">KST {format(nowKst(), 'HH:mm')}</span>
        </div>
      </div>

      <div className="grid-3">
        <RealtimeQuoteCard
          title="SK하이닉스"
          symbolLabel="KRX 000660 · 원주"
          quote={krx.data}
          isLoading={krx.isLoading}
          isError={krx.isError}
          onRetry={() => krx.refetch()}
          isRefetching={krx.isRefetching}
          color="var(--kospi)"
          gradientId="gQuoteKrx"
          period={krxPeriod}
          onPeriodChange={setKrxPeriod}
          tag="KOSPI"
          info={TOOLTIPS.hynixKrx}
        />
        <RealtimeQuoteCard
          title="SK하이닉스 ADR"
          symbolLabel="NASDAQ SKHY · 미국예탁증서"
          quote={adr.data}
          isLoading={adr.isLoading}
          isError={adr.isError}
          onRetry={() => adr.refetch()}
          isRefetching={adr.isRefetching}
          color="var(--kosdaq)"
          gradientId="gQuoteAdr"
          period={adrPeriod}
          onPeriodChange={setAdrPeriod}
          tag="NASDAQ ADS"
          extra={premiumNode}
          shortHistoryNote="신규 상장 ADR — 상장 이후 데이터만 표시될 수 있습니다."
          info={TOOLTIPS.hynixAdr}
        />
        <RealtimeQuoteCard
          title="원/달러 환율"
          symbolLabel="USD/KRW · KRW=X"
          quote={fx.data}
          isLoading={fx.isLoading}
          isError={fx.isError}
          onRetry={() => fx.refetch()}
          isRefetching={fx.isRefetching}
          color="#12b76a"
          gradientId="gQuoteFx"
          period={fxPeriod}
          onPeriodChange={setFxPeriod}
          tag="FX"
          info={TOOLTIPS.fx}
        />
      </div>
    </section>
  )
}
