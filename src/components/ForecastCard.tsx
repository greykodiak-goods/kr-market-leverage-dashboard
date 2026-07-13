import { useMemo } from 'react'
import {
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { format } from 'date-fns'
import { useQuote } from '../hooks/useQuote'
import { computeIndicators, type Candle } from '../lib/indicators'
import { InfoTip } from './InfoTip'
import { TOOLTIPS } from '../lib/tooltips'
import { ScenarioBoard } from './ScenarioBoard'

const DISCLAIMER =
  '본 지표는 과거 데이터 기반 통계·기술적 참고 정보이며 투자자문·매매권유가 아닙니다. 미래 가격·수익을 보장하지 않습니다.'

function won(v: number | null | undefined) {
  if (v == null) return '—'
  return `₩${Math.round(v).toLocaleString('ko-KR')}`
}

export function ForecastCard() {
  // 1Y daily history (range=1y, interval=1d) → ~250 closes for indicators.
  const { data, isLoading, isError } = useQuote('000660.KS', '1Y')

  const result = useMemo(() => {
    if (!data?.intraday?.length) return null
    const candles: Candle[] = data.intraday.map((p) => ({ t: p.t, price: p.price }))
    return computeIndicators(candles, 10)
  }, [data])

  const chartData = useMemo(() => {
    if (!result) return []
    const M = 120
    const closes = result.closes
    const start = Math.max(0, closes.length - M)
    const rows: any[] = []
    for (let i = start; i < closes.length; i++) {
      rows.push({
        t: closes[i].t,
        price: closes[i].price,
        sma20: result.smaSeries[20]?.[i] ?? null,
        sma60: result.smaSeries[60]?.[i] ?? null,
      })
    }
    // continuity: seed projection at the last actual point
    if (rows.length) {
      const last = rows[rows.length - 1]
      last.projMid = last.price
      last.projUpper = last.price
      last.projLower = last.price
    }
    for (const p of result.projection) {
      rows.push({ t: p.t, projMid: p.mid, projUpper: p.upper, projLower: p.lower })
    }
    return rows
  }, [result])

  const axisFmt = (t: number) => format(new Date(t * 1000), 'MM/dd')

  const Tip = ({ active, payload }: any) => {
    if (!active || !payload || !payload.length) return null
    const row = payload[0].payload
    return (
      <div className="recharts-default-tooltip" style={{ padding: '6px 10px' }}>
        <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>{format(new Date(row.t * 1000), 'yyyy.MM.dd')}</div>
        {row.price != null && <div style={{ fontSize: 13 }}>종가 {won(row.price)}</div>}
        {row.projMid != null && row.price == null && (
          <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>
            추세 투영 {won(row.projMid)} <span style={{ color: 'var(--text-faint)' }}>({won(row.projLower)}~{won(row.projUpper)})</span>
          </div>
        )}
      </div>
    )
  }

  return (
    <section className="panel forecast-card">
      <div className="panel-head">
        <div>
          <h2>SK하이닉스 기술적 전망 <span className="badge" style={{ fontSize: 11 }}>참고용</span></h2>
          <div className="panel-sub">000660 · SMA/RSI/볼린저/MACD + 통계 추세 투영 (참고)</div>
        </div>
      </div>

      <div className="disclaimer" role="note">⚠️ {DISCLAIMER}</div>

      {isLoading && !result ? (
        <div className="news-empty">지표 계산용 시세 불러오는 중…</div>
      ) : isError && !result ? (
        <div className="news-empty err">기술적 지표용 시세를 가져오지 못했습니다 (프록시 응답 없음).</div>
      ) : !result ? (
        <div className="news-empty">데이터가 충분하지 않습니다.</div>
      ) : (
        <>
          <div className="ind-grid">
            {result.sma.map((s) => (
              <div key={s.period} className="ind-cell">
                <span className="ind-k">SMA{s.period}{s.period === 5 && <InfoTip text={TOOLTIPS.maBoll} />}</span>
                <span className="ind-v">{won(s.value)}</span>
              </div>
            ))}
            <div className="ind-cell">
              <span className="ind-k">RSI(14)<InfoTip text={TOOLTIPS.rsi} /></span>
              <span className="ind-v">
                {result.rsi != null ? result.rsi.toFixed(1) : '—'}
                <span className={`rsi-state ${result.rsiState === '중립' ? '' : 'warn'}`}> {result.rsiState}</span>
              </span>
            </div>
            <div className="ind-cell">
              <span className="ind-k">볼린저 %B<InfoTip text={TOOLTIPS.maBoll} /></span>
              <span className="ind-v">{result.bollinger?.pctB != null ? `${result.bollinger.pctB.toFixed(0)}%` : '—'}</span>
            </div>
            <div className="ind-cell" style={{ gridColumn: 'span 2' }}>
              <span className="ind-k">MACD</span>
              <span className="ind-v" style={{ fontSize: 12 }}>{result.macd.state}</span>
            </div>
          </div>

          <div style={{ fontSize: 12, color: 'var(--text-dim)', margin: '8px 0 2px' }}>
            최근 {chartData.filter((r) => r.price != null).length}거래일 + 통계 추세 투영 {result.projHorizon}거래일 (±1σ 변동성 밴드)
          </div>
          <ResponsiveContainer width="100%" height={220}>
            <ComposedChart data={chartData} margin={{ top: 6, right: 8, left: 4, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
              <XAxis dataKey="t" tickFormatter={axisFmt} tickLine={false} axisLine={{ stroke: 'var(--border)' }} minTickGap={40} />
              <YAxis tickFormatter={(v) => `${Math.round(v / 1000)}k`} tickLine={false} axisLine={false} width={44} domain={['auto', 'auto']} />
              <Tooltip content={<Tip />} />
              <Line type="monotone" dataKey="price" stroke="var(--kospi)" strokeWidth={1.7} dot={false} name="종가" isAnimationActive={false} connectNulls={false} />
              <Line type="monotone" dataKey="sma20" stroke="#f79009" strokeWidth={1} dot={false} name="SMA20" isAnimationActive={false} connectNulls />
              <Line type="monotone" dataKey="sma60" stroke="#8b5cf6" strokeWidth={1} dot={false} name="SMA60" isAnimationActive={false} connectNulls />
              <Line type="monotone" dataKey="projMid" stroke="var(--text-dim)" strokeWidth={1.4} strokeDasharray="5 4" dot={false} name="추세 투영" isAnimationActive={false} connectNulls />
              <Line type="monotone" dataKey="projUpper" stroke="var(--text-faint)" strokeWidth={1} strokeDasharray="2 3" dot={false} name="+1σ" isAnimationActive={false} connectNulls />
              <Line type="monotone" dataKey="projLower" stroke="var(--text-faint)" strokeWidth={1} strokeDasharray="2 3" dot={false} name="−1σ" isAnimationActive={false} connectNulls />
            </ComposedChart>
          </ResponsiveContainer>

          <div className="news-foot">
            지표는 검증 라이브러리 technicalindicators 기반. 추세 투영은 최근 {result.projWindow}거래일 선형회귀 연장 + 과거 변동성 밴드로, 예측이 아닌 통계 참고선입니다. {DISCLAIMER}
          </div>
        </>
      )}

      <ScenarioBoard result={result} />
    </section>
  )
}
