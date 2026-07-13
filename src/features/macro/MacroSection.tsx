import { krxStatus, nowKst } from '../../lib/market'
import { QuoteMiniCard } from '../../components/QuoteMiniCard'
import { TOOLTIPS } from '../../lib/tooltips'
import { format } from 'date-fns'

// Is it the US-session window (~22:30–05:00 KST) where EWY best reflects
// overnight direction for Korean equities?
function isNightWindow(): boolean {
  const k = nowKst()
  const min = k.getHours() * 60 + k.getMinutes()
  return min >= 22 * 60 + 30 || min <= 5 * 60
}

export function MacroSection() {
  const status = krxStatus()
  const night = isNightWindow()

  return (
    <div>
      <div className="header" style={{ marginBottom: 12 }}>
        <div>
          <h1 style={{ fontSize: 18 }}>매크로 위험 · 지수</h1>
          <div className="subtitle">변동성·금리·달러 + 코스피 지수 + 야간 프록시(EWY)</div>
        </div>
        <div className="badges">
          <span className={`badge ${status.isOpen ? 'live' : ''}`}>KRX {status.label}</span>
          <span className={`badge ${night ? 'live' : ''}`}>{night ? '야간(미국장) 활성' : '야간 대기'}</span>
          <span className="badge">KST {format(nowKst(), 'HH:mm')}</span>
        </div>
      </div>

      <div className="mini-grid">
        <QuoteMiniCard symbol="^VIX" label="변동성지수 VIX" tag="^VIX" unit="index" color="#e5484d" info={TOOLTIPS.vix} />
        <QuoteMiniCard symbol="^TNX" label="미 10년물 금리" tag="^TNX" unit="percent" color="#f79009" info={TOOLTIPS.tnx} />
        <QuoteMiniCard symbol="DX-Y.NYB" label="달러인덱스" tag="DXY" unit="index" color="#8b5cf6" info={TOOLTIPS.dxy} />
        <QuoteMiniCard symbol="^KS11" label="코스피" tag="^KS11" unit="index" color="var(--kospi)" info={TOOLTIPS.kospi} />
        <QuoteMiniCard symbol="^KS200" label="코스피200" tag="^KS200" unit="index" color="var(--kospi)" info={TOOLTIPS.kospi200} />
        <QuoteMiniCard symbol="EWY" label="코스피 야간 프록시" tag={night ? '야간 활성' : 'EWY'} color="#12b76a" info={TOOLTIPS.nightProxy} highlight={night} />
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-faint)', marginTop: 8 }}>
        ※ EWY는 미국 상장 한국 ETF(USD)로 정식 코스피 야간선물이 아닙니다 — 밤사이 방향성 참고용(등락률 중심).
      </div>
    </div>
  )
}
