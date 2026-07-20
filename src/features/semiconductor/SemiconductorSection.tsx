import { useMemo } from 'react'
import { useQuote } from '../../hooks/useQuote'
import { computeRelativeStrength } from '../../lib/rs'
import { QuoteMiniCard } from '../../components/QuoteMiniCard'
import { PlaceholderCard } from '../../components/PlaceholderCard'
import { SimpleLineChart } from '../../components/SimpleLineChart'
import { InfoTip } from '../../components/InfoTip'
import { TOOLTIPS } from '../../lib/tooltips'

export function SemiconductorSection() {
  // RS needs daily history for both legs.
  const hynix = useQuote('000660.KS', '6M')
  const sox = useQuote('^SOX', '6M')

  const rs = useMemo(() => {
    if (!hynix.data?.intraday?.length || !sox.data?.intraday?.length) return null
    return computeRelativeStrength(hynix.data.intraday, sox.data.intraday)
  }, [hynix.data, sox.data])

  const rsSeries = useMemo(
    () => (rs?.series ?? []).map((p) => ({ date: new Date(p.t * 1000).toISOString().slice(0, 10), value: p.rs })),
    [rs],
  )

  const trendLabel = rs ? (rs.trend === 'up' ? '추세 강세' : rs.trend === 'down' ? '추세 약세' : '추세 중립') : '—'
  const trendColor = rs?.trend === 'up' ? 'var(--up)' : rs?.trend === 'down' ? 'var(--down)' : 'var(--text-dim)'

  return (
    <div>
      <div className="header" style={{ marginBottom: 12 }}>
        <div>
          <h1 style={{ fontSize: 18 }}>반도체 업황 · 상대강도</h1>
          <div className="subtitle">글로벌 반도체 대표주 + 하이닉스 상대강도(RS vs SOX)</div>
        </div>
      </div>

      <div className="mini-grid">
        <QuoteMiniCard symbol="^SOX" label="필라델피아 반도체" tag="^SOX" unit="index" info={TOOLTIPS.sox} />
        <QuoteMiniCard symbol="NVDA" label="엔비디아" tag="NVDA" info={TOOLTIPS.nvda} />
        <QuoteMiniCard symbol="MU" label="마이크론" tag="MU" info={TOOLTIPS.micron} />
        <QuoteMiniCard symbol="TSM" label="TSMC" tag="TSM" info={TOOLTIPS.tsmc} />
        <QuoteMiniCard symbol="005930.KS" label="삼성전자" tag="005930" info={TOOLTIPS.samsung} />
      </div>

      <div className="grid-2" style={{ marginTop: 16 }}>
        <div className="panel">
          <div className="panel-head">
            <div>
              <h2>하이닉스 상대강도 (RS vs SOX)<InfoTip text={TOOLTIPS.rs} /></h2>
              <div className="panel-sub">000660 수익률 ÷ ^SOX 수익률 · 6M · 1.0 기준</div>
            </div>
            <div className="panel-latest">
              {rs ? <strong style={{ color: trendColor }}>{rs.latest.toFixed(3)}</strong> : <strong>—</strong>}
              <div style={{ fontSize: 11, color: trendColor }}>{trendLabel}</div>
            </div>
          </div>
          {rsSeries.length > 1 ? (
            <SimpleLineChart
              data={rsSeries}
              color="var(--kospi)"
              gradientId="gRS"
              valueFormatter={(v) => v.toFixed(3)}
              tooltipLabel="RS"
            />
          ) : (
            <div className="news-empty">RS 계산용 시세 불러오는 중…</div>
          )}
        </div>

        <div className="mini-grid" style={{ alignContent: 'start' }}>
          <PlaceholderCard label="외국인·기관 수급" note="순매수/순매도 (억원) — 무료 실시간 소스 확보 후 연동" info={TOOLTIPS.supply} />
          <PlaceholderCard label="DRAM 현물가" note="DDR 스팟 가격 추이 — 유료/제한 소스, 연동 예정" info={TOOLTIPS.dram} />
        </div>
      </div>
    </div>
  )
}
