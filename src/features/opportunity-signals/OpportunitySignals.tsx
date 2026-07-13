import { useMemo } from 'react'
import { useQuote, useFxQuote } from '../../hooks/useQuote'
import { computeIndicators, type Candle } from '../../lib/indicators'
import { computeRelativeStrength } from '../../lib/rs'
import { computeSignals } from './signals'
import { InfoTip } from '../../components/InfoTip'
import { TOOLTIPS } from '../../lib/tooltips'

const ADR_ORDINARY_RATIO = 0.1 // 1 ADR = 원주 1/10 (SEC 424B4)

export function OpportunitySignals() {
  const hynix = useQuote('000660.KS', '6M')
  const sox = useQuote('^SOX', '6M')
  const vix = useQuote('^VIX', '1M')
  const krw = useFxQuote('1D')
  const tnx = useQuote('^TNX', '1D')
  const adr = useQuote('SKHYV', '1D')

  const ind = useMemo(() => {
    if (!hynix.data?.intraday?.length) return null
    const candles: Candle[] = hynix.data.intraday.map((p) => ({ t: p.t, price: p.price }))
    return computeIndicators(candles, 10)
  }, [hynix.data])

  const rsTrend = useMemo(() => {
    if (!hynix.data?.intraday?.length || !sox.data?.intraday?.length) return null
    return computeRelativeStrength(hynix.data.intraday, sox.data.intraday).trend
  }, [hynix.data, sox.data])

  const adrPremiumPct = useMemo(() => {
    if (!adr.data || !hynix.data || !krw.data) return null
    const impliedPerShare = (adr.data.price * krw.data.price) / ADR_ORDINARY_RATIO
    return (impliedPerShare / hynix.data.price - 1) * 100
  }, [adr.data, hynix.data, krw.data])

  const signals = useMemo(
    () =>
      computeSignals({
        ind,
        fiftyTwoWeekLow: hynix.data?.fiftyTwoWeekLow ?? null,
        price: hynix.data?.price ?? null,
        rsTrend,
        vix: vix.data ?? null,
        krw: krw.data ?? null,
        tnx: tnx.data ?? null,
        adrPremiumPct,
      }),
    [ind, hynix.data, rsTrend, vix.data, krw.data, tnx.data, adrPremiumPct],
  )

  const metCount = signals.filter((s) => s.met).length

  return (
    <div className="panel">
      <div className="panel-head" style={{ alignItems: 'baseline', flexWrap: 'wrap', gap: 6 }}>
        <div>
          <h2>
            ⚡ 기회 · 관찰 신호 보드
            <span className="badge" style={{ fontSize: 11, marginLeft: 8 }}>관찰 전용</span>
            <InfoTip text={TOOLTIPS.signalBoard} />
          </h2>
          <div className="panel-sub">기술적 관찰 포인트 자동 점검 · 충족 {metCount}/{signals.length} · 매매권유 아님</div>
        </div>
      </div>

      <div className="disclaimer" role="note">
        ⚠️ 각 항목은 기술적 관찰 포인트의 충족 여부만 표시합니다. 매수/매도 신호나 투자자문이 아니며, 미래 수익을 보장하지 않습니다.
      </div>

      <div className="signal-grid">
        {signals.map((s) => (
          <div key={s.id} className={`signal-card ${s.tone}${s.met ? ' met' : ''}`}>
            <div className="signal-top">
              <span className={`signal-dot ${s.met ? 'on' : ''}`} aria-hidden />
              <span className="signal-label">{s.label}</span>
              <span className={`signal-badge ${s.met ? 'met' : ''}`}>{s.met ? '충족' : '미충족'}</span>
            </div>
            <div className="signal-detail">{s.detail}</div>
          </div>
        ))}
      </div>

      <div className="news-foot">
        관찰 포인트는 technicalindicators 계산 + 실시간 시세 기반입니다. 정보 제공 목적이며 투자 자문이 아닙니다.
      </div>
    </div>
  )
}
