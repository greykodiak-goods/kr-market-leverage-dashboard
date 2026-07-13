import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { fetchDashboardData } from '../../lib/data'
import { computeSentiment } from '../../lib/sentiment'
import {
  formatEok,
  formatEokShort,
  formatPercent,
  formatSignedEok,
  formatSignedPercent,
  pctChange,
} from '../../lib/format'
import type { DashboardData, ValuePoint } from '../../types'
import { sliceForPeriod, LEVERAGE_PERIODS } from '../../lib/period'
import type { LeveragePeriod } from '../../lib/period'
import { KpiCard } from '../../components/KpiCard'
import { CreditBalanceChart } from '../../components/CreditBalanceChart'
import { MarginCallRiskChart } from '../../components/MarginCallRiskChart'
import { SimpleLineChart } from '../../components/SimpleLineChart'
import { SentimentGauge } from '../../components/SentimentGauge'
import { PeriodSelector } from '../../components/PeriodSelector'
import { InfoTip } from '../../components/InfoTip'
import { TOOLTIPS } from '../../lib/tooltips'

function lastTwo<T>(arr: T[]): [T, T] {
  return [arr[arr.length - 2], arr[arr.length - 1]]
}
function dir(delta: number): 'up' | 'down' | 'flat' {
  if (delta > 0) return 'up'
  if (delta < 0) return 'down'
  return 'flat'
}
function latestVal(series: ValuePoint[]) {
  const [prev, curr] = lastTwo(series)
  return { prev: prev.value, curr: curr.value, delta: curr.value - prev.value }
}

export function LeverageSection() {
  const [levPeriod, setLevPeriod] = useState<LeveragePeriod>('6M')
  const { data, isLoading, isError, error } = useQuery({ queryKey: ['dashboard'], queryFn: fetchDashboardData })

  if (isLoading) return <div className="news-empty">시장 온도 데이터 불러오는 중…</div>
  if (isError || !data)
    return <div className="news-empty err">데이터 로드 실패: {String((error as Error)?.message ?? 'unknown')}</div>

  const [creditPrev, creditCurr] = lastTwo(data.credit.series)
  const creditDelta = creditCurr.total - creditPrev.total
  const creditDeltaPct = pctChange(creditCurr.total, creditPrev.total)
  const unsettled = latestVal(data.unsettled.series)
  const deposit = latestVal(data.deposit.series)
  const ratio = latestVal(data.creditRatio.series)

  const fCredit = sliceForPeriod(data.credit.series, levPeriod)
  const fUnsettled = sliceForPeriod(data.unsettled.series, levPeriod)
  const fDeposit = sliceForPeriod(data.deposit.series, levPeriod)
  const fLending = sliceForPeriod(data.lending.series, levPeriod)
  const fRatio = sliceForPeriod(data.creditRatio.series, levPeriod)
  const fTurnover = sliceForPeriod(data.turnover.series, levPeriod)

  const sentiment = computeSentiment({
    credit: { series: fCredit },
    creditRatio: { series: fRatio },
    deposit: { series: fDeposit },
    lending: { series: fLending },
    turnover: { series: fTurnover },
    unsettled: { series: fUnsettled },
  } as unknown as DashboardData)

  const depositLatest = data.deposit.series[data.deposit.series.length - 1]
  const lendingLatest = data.lending.series[data.lending.series.length - 1]
  const turnoverLatest = data.turnover.series[data.turnover.series.length - 1]

  return (
    <div>
      <div className="lev-period-bar">
        <div>
          <strong style={{ fontSize: 15 }}>시장 온도 · 레버리지 · 투자심리</strong>
          <span className="badge sample" style={{ marginLeft: 8, fontSize: 11 }}>샘플(장기)</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>차트 기간</span>
          <PeriodSelector periods={LEVERAGE_PERIODS} value={levPeriod} onChange={setLevPeriod} />
        </div>
      </div>

      <section className="kpi-row">
        <KpiCard label="신용거래융자 잔고 (합계)" value={formatEokShort(creditCurr.total)} unit="원"
          changeText={`${formatSignedEok(creditDelta)} (${formatSignedPercent(creditDeltaPct)})`}
          changeLabel="전일대비" direction={dir(creditDelta)} info={TOOLTIPS.credit} />
        <KpiCard label="미수금" value={formatEokShort(unsettled.curr)} unit="원"
          changeText={`${formatSignedEok(unsettled.delta)} (${formatSignedPercent(pctChange(unsettled.curr, unsettled.prev))})`}
          changeLabel="전일대비" direction={dir(unsettled.delta)} invertColor info={TOOLTIPS.unsettled} />
        <KpiCard label="투자자예탁금" value={formatEokShort(deposit.curr)} unit="원"
          changeText={`${formatSignedEok(deposit.delta)} (${formatSignedPercent(pctChange(deposit.curr, deposit.prev))})`}
          changeLabel="전일대비" direction={dir(deposit.delta)} info={TOOLTIPS.deposit} />
        <KpiCard label="신용잔고율 (신용융자/시총)" value={formatPercent(ratio.curr, 3)}
          changeText={formatSignedPercent(ratio.delta, 3) + 'p'} changeLabel="전일대비"
          direction={dir(ratio.delta)} info={TOOLTIPS.creditRatio} />
      </section>

      <section className="grid">
        <div className="panel">
          <div className="panel-head">
            <div>
              <h2>신용거래융자 잔고 추이<InfoTip text={TOOLTIPS.credit} /></h2>
              <div className="panel-sub">코스피 · 코스닥 분리 (stacked) · {levPeriod}</div>
            </div>
            <div className="panel-latest">합계 <strong>{formatEok(creditCurr.total)}</strong></div>
          </div>
          <CreditBalanceChart data={fCredit} />
        </div>
        <div className="panel">
          <div className="panel-head">
            <div>
              <h2>종합 과열 게이지<InfoTip text={TOOLTIPS.gauge} /></h2>
              <div className="panel-sub">레버리지·심리 지표 0~100 환산</div>
            </div>
          </div>
          <SentimentGauge data={sentiment} />
        </div>
      </section>

      <section className="grid-2">
        <div className="panel">
          <div className="panel-head">
            <div>
              <h2>미수금 &amp; 반대매매 위험<InfoTip text={TOOLTIPS.unsettled} /></h2>
              <div className="panel-sub">미수금 급증 시 반대매매 물량 확대</div>
            </div>
            <div className="panel-latest"><strong>{formatEok(unsettled.curr)}</strong></div>
          </div>
          <MarginCallRiskChart data={fUnsettled} />
        </div>
        <div className="panel">
          <div className="panel-head">
            <div>
              <h2>투자자예탁금<InfoTip text={TOOLTIPS.deposit} /></h2>
              <div className="panel-sub">대기 매수자금 추이</div>
            </div>
            <div className="panel-latest"><strong>{formatEok(depositLatest.value)}</strong></div>
          </div>
          <SimpleLineChart data={fDeposit} color="var(--accent)" gradientId="gDeposit"
            valueFormatter={(v) => formatEokShort(v)} tooltipLabel="예탁금" />
        </div>
      </section>

      <section className="grid-2">
        <div className="panel">
          <div className="panel-head">
            <div>
              <h2>신용잔고율<InfoTip text={TOOLTIPS.creditRatio} /></h2>
              <div className="panel-sub">신용융자 / 시가총액 (%) · 과열도</div>
            </div>
            <div className="panel-latest"><strong>{formatPercent(ratio.curr, 3)}</strong></div>
          </div>
          <SimpleLineChart data={fRatio} color="var(--kosdaq)" gradientId="gRatio"
            valueFormatter={(v) => `${v.toFixed(2)}%`} tooltipLabel="신용잔고율" />
        </div>
        <div className="panel">
          <div className="panel-head">
            <div>
              <h2>대차잔고<InfoTip text={TOOLTIPS.lending} /></h2>
              <div className="panel-sub">공매도 선행지표</div>
            </div>
            <div className="panel-latest"><strong>{formatEok(lendingLatest.value)}</strong></div>
          </div>
          <SimpleLineChart data={fLending} color="#8b5cf6" gradientId="gLending"
            valueFormatter={(v) => formatEokShort(v)} tooltipLabel="대차잔고" />
        </div>
      </section>

      <section className="grid-2">
        <div className="panel">
          <div className="panel-head">
            <div>
              <h2>예탁금 회전율<InfoTip text={TOOLTIPS.turnover} /></h2>
              <div className="panel-sub">거래대금 / 예탁금 (%) · 매매 활발도</div>
            </div>
            <div className="panel-latest"><strong>{turnoverLatest.value.toFixed(2)}%</strong></div>
          </div>
          <SimpleLineChart data={fTurnover} color="#12b76a" gradientId="gTurnover"
            valueFormatter={(v) => `${v.toFixed(0)}%`} tooltipLabel="회전율" />
        </div>
        <div className="panel" style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
          <h2 style={{ marginBottom: 10 }}>지표 요약 해설</h2>
          <ul style={{ margin: 0, paddingLeft: 18, color: 'var(--text-dim)', fontSize: 13, lineHeight: 1.8 }}>
            <li>신용융자 잔고·신용잔고율 상승 → 레버리지 과열 신호</li>
            <li>미수금 급등 → 익일 반대매매 출회 위험</li>
            <li>예탁금 감소 → 대기 매수여력 위축</li>
            <li>대차잔고 상승 → 공매도 압력 확대 가능성</li>
            <li>종합 게이지 80↑ → 극단적 탐욕(경계), 25↓ → 극단적 공포(저점 신호)</li>
          </ul>
        </div>
      </section>
    </div>
  )
}
