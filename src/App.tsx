import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { fetchDashboardData } from './lib/data'
import { computeSentiment } from './lib/sentiment'
import {
  formatEok,
  formatEokShort,
  formatPercent,
  formatSignedEok,
  formatSignedPercent,
  pctChange,
} from './lib/format'
import type { DashboardData, ValuePoint } from './types'
import { filterByPeriod, LEVERAGE_PERIODS } from './lib/period'
import type { LeveragePeriod } from './lib/period'
import { KpiCard } from './components/KpiCard'
import { CreditBalanceChart } from './components/CreditBalanceChart'
import { MarginCallRiskChart } from './components/MarginCallRiskChart'
import { SimpleLineChart } from './components/SimpleLineChart'
import { SentimentGauge } from './components/SentimentGauge'
import { RealtimeSection } from './components/RealtimeSection'
import { PeriodSelector } from './components/PeriodSelector'
import { tickDateLong } from './components/chartUtils'

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

export default function App() {
  const [levPeriod, setLevPeriod] = useState<LeveragePeriod>('1Y')
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['dashboard'],
    queryFn: fetchDashboardData,
  })

  if (isLoading) return <div className="loading">데이터 불러오는 중…</div>
  if (isError || !data)
    return <div className="error">데이터 로드 실패: {String((error as Error)?.message ?? 'unknown')}</div>

  const meta = data.credit.meta
  const isLive = meta.source === 'LIVE'

  // KPI 전일대비 uses the unfiltered (daily-tailed) series.
  const [creditPrev, creditCurr] = lastTwo(data.credit.series)
  const creditDelta = creditCurr.total - creditPrev.total
  const creditDeltaPct = pctChange(creditCurr.total, creditPrev.total)

  const unsettled = latestVal(data.unsettled.series)
  const deposit = latestVal(data.deposit.series)
  const ratio = latestVal(data.creditRatio.series)

  // Charts + sentiment gauge reflect the selected leverage period window.
  const fCredit = filterByPeriod(data.credit.series, levPeriod)
  const fUnsettled = filterByPeriod(data.unsettled.series, levPeriod)
  const fDeposit = filterByPeriod(data.deposit.series, levPeriod)
  const fLending = filterByPeriod(data.lending.series, levPeriod)
  const fRatio = filterByPeriod(data.creditRatio.series, levPeriod)
  const fTurnover = filterByPeriod(data.turnover.series, levPeriod)

  const sentimentInput = {
    credit: { series: fCredit },
    creditRatio: { series: fRatio },
    deposit: { series: fDeposit },
    lending: { series: fLending },
    turnover: { series: fTurnover },
    unsettled: { series: fUnsettled },
  } as unknown as DashboardData
  const sentiment = computeSentiment(sentimentInput)

  const depositLatest = data.deposit.series[data.deposit.series.length - 1]
  const lendingLatest = data.lending.series[data.lending.series.length - 1]
  const turnoverLatest = data.turnover.series[data.turnover.series.length - 1]

  return (
    <div className="app">
      <header className="header">
        <div>
          <h1>국내증시 레버리지 · 투자심리 대시보드</h1>
          <div className="subtitle">신용거래융자 · 미수금 · 예탁금 중심 과열도 모니터링</div>
        </div>
        <div className="badges">
          <span className={`badge ${isLive ? 'live' : 'sample'}`}>
            {isLive ? '실데이터' : '샘플 데이터'}
          </span>
          <span className="badge">기준일 {tickDateLong(meta.asOf)}</span>
          <span className="badge">단위 {meta.unit}</span>
        </div>
      </header>

      <RealtimeSection />

      <hr style={{ border: 'none', borderTop: '1px solid var(--border)', margin: '4px 0 16px' }} />

      <div className="lev-period-bar">
        <div>
          <strong style={{ fontSize: 15 }}>레버리지 · 투자심리 지표</strong>
          <span className="badge sample" style={{ marginLeft: 8, fontSize: 11 }}>샘플(장기)</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>차트 기간</span>
          <PeriodSelector periods={LEVERAGE_PERIODS} value={levPeriod} onChange={setLevPeriod} />
        </div>
      </div>

      <section className="kpi-row">
        <KpiCard
          label="신용거래융자 잔고 (합계)"
          value={formatEokShort(creditCurr.total)}
          unit="원"
          changeText={`${formatSignedEok(creditDelta)} (${formatSignedPercent(creditDeltaPct)})`}
          direction={dir(creditDelta)}
        />
        <KpiCard
          label="미수금"
          value={formatEokShort(unsettled.curr)}
          unit="원"
          changeText={`${formatSignedEok(unsettled.delta)} (${formatSignedPercent(pctChange(unsettled.curr, unsettled.prev))})`}
          direction={dir(unsettled.delta)}
          invertColor
        />
        <KpiCard
          label="투자자예탁금"
          value={formatEokShort(deposit.curr)}
          unit="원"
          changeText={`${formatSignedEok(deposit.delta)} (${formatSignedPercent(pctChange(deposit.curr, deposit.prev))})`}
          direction={dir(deposit.delta)}
        />
        <KpiCard
          label="신용잔고율 (신용융자/시총)"
          value={formatPercent(ratio.curr, 3)}
          changeText={formatSignedPercent(ratio.delta, 3) + 'p'}
          direction={dir(ratio.delta)}
        />
      </section>

      <section className="grid">
        <div className="panel">
          <div className="panel-head">
            <div>
              <h2>신용거래융자 잔고 추이</h2>
              <div className="panel-sub">코스피 · 코스닥 분리 (stacked) · {levPeriod}</div>
            </div>
            <div className="panel-latest">
              합계 <strong>{formatEok(creditCurr.total)}</strong>
            </div>
          </div>
          <CreditBalanceChart data={fCredit} />
        </div>

        <div className="panel">
          <div className="panel-head">
            <div>
              <h2>종합 과열 게이지</h2>
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
              <h2>미수금 & 반대매매 위험</h2>
              <div className="panel-sub">미수금 급증 시 반대매매 물량 확대</div>
            </div>
            <div className="panel-latest">
              <strong>{formatEok(unsettled.curr)}</strong>
            </div>
          </div>
          <MarginCallRiskChart data={fUnsettled} />
        </div>

        <div className="panel">
          <div className="panel-head">
            <div>
              <h2>투자자예탁금</h2>
              <div className="panel-sub">대기 매수자금 추이</div>
            </div>
            <div className="panel-latest">
              <strong>{formatEok(depositLatest.value)}</strong>
            </div>
          </div>
          <SimpleLineChart
            data={fDeposit}
            color="var(--accent)"
            gradientId="gDeposit"
            valueFormatter={(v) => formatEokShort(v)}
            tooltipLabel="예탁금"
          />
        </div>
      </section>

      <section className="grid-2">
        <div className="panel">
          <div className="panel-head">
            <div>
              <h2>신용잔고율</h2>
              <div className="panel-sub">신용융자 / 시가총액 (%) · 과열도</div>
            </div>
            <div className="panel-latest">
              <strong>{formatPercent(ratio.curr, 3)}</strong>
            </div>
          </div>
          <SimpleLineChart
            data={fRatio}
            color="var(--kosdaq)"
            gradientId="gRatio"
            valueFormatter={(v) => `${v.toFixed(2)}%`}
            tooltipLabel="신용잔고율"
          />
        </div>

        <div className="panel">
          <div className="panel-head">
            <div>
              <h2>대차잔고</h2>
              <div className="panel-sub">공매도 선행지표</div>
            </div>
            <div className="panel-latest">
              <strong>{formatEok(lendingLatest.value)}</strong>
            </div>
          </div>
          <SimpleLineChart
            data={fLending}
            color="#8b5cf6"
            gradientId="gLending"
            valueFormatter={(v) => formatEokShort(v)}
            tooltipLabel="대차잔고"
          />
        </div>
      </section>

      <section className="grid-2">
        <div className="panel">
          <div className="panel-head">
            <div>
              <h2>예탁금 회전율</h2>
              <div className="panel-sub">거래대금 / 예탁금 (%) · 매매 활발도</div>
            </div>
            <div className="panel-latest">
              <strong>{turnoverLatest.value.toFixed(2)}%</strong>
            </div>
          </div>
          <SimpleLineChart
            data={fTurnover}
            color="#12b76a"
            gradientId="gTurnover"
            valueFormatter={(v) => `${v.toFixed(0)}%`}
            tooltipLabel="회전율"
          />
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

      <footer className="footer">
        <div>
          데이터 출처: 금융투자협회 FreeSIS(freesis.kofia.or.kr), KRX 정보데이터시스템(data.krx.co.kr).
          {' '}
          {isLive
            ? '실데이터 연동됨.'
            : '현재 표시 데이터는 위 기관 공개 통계 구조를 반영한 샘플이며, 실제 수치와 다를 수 있습니다.'}
        </div>
        <div>기준일 {tickDateLong(meta.asOf)} · 생성 {new Date(meta.generatedAt).toLocaleString('ko-KR')} · 단위 {meta.unit}(100만원의 100배)</div>
        <div>본 대시보드는 정보 제공 목적이며 투자 자문이 아닙니다.</div>
      </footer>
    </div>
  )
}
