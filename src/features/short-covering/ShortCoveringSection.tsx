import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  Area,
  AreaChart,
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { fetchShortBalance, fetchStockLending } from '../../lib/data'
import { useQuote } from '../../hooks/useQuote'
import { filterByPeriod, type LeveragePeriod } from '../../lib/period'
import { formatEok, formatEokShort } from '../../lib/format'
import { toTs, tsLong, timeAxisTicks, timeTickFormatter } from '../../components/chartUtils'
import { KpiCard } from '../../components/KpiCard'
import { PeriodSelector } from '../../components/PeriodSelector'
import { InfoTip } from '../../components/InfoTip'
import { TOOLTIPS } from '../../lib/tooltips'
import {
  coveringFlags,
  cumulativeCovered,
  daysToCover,
  directionBadge,
  pctChangeOver,
  squeezeWatch,
  streakDown,
} from './lib/covering'

const CHART_PERIODS: LeveragePeriod[] = ['3M', '6M', '1Y']

const DIR_META = {
  cover: { label: '▼ 상환 우위', color: 'var(--up)' }, // KR: 감소=상환, 초록 대신 상승색 아닌 별도 처리 아래
  newShort: { label: '▲ 신규 숏 우위', color: 'var(--down)' },
  neutral: { label: '— 중립', color: 'var(--text-dim)' },
} as const

// Covering(감소)은 초록으로 강조 (KR 상승/하락 색과 별개로 "상환=긍정" 시맨틱).
const COVER_GREEN = '#12b76a'

export function ShortCoveringSection() {
  const lendingQ = useQuery({ queryKey: ['hynix-lending'], queryFn: fetchStockLending })
  const shortQ = useQuery({ queryKey: ['hynix-short'], queryFn: fetchShortBalance })
  const hynix = useQuote('000660.KS', '6M')

  const [period, setPeriod] = useState<LeveragePeriod>('6M')
  const [covN, setCovN] = useState<5 | 10>(5)

  const lending = lendingQ.data
  const short = shortQ.data

  // ---- KPI derivations ----
  const lendVals = lending?.series.map((p) => p.amountEok) ?? []
  const lendLast = lending?.series[lending.series.length - 1]
  const lendPrev = lending?.series[lending.series.length - 2]
  const lendDelta = lendLast && lendPrev ? lendLast.amountEok - lendPrev.amountEok : 0
  const streak = streakDown(lendVals)
  const cumCovered = cumulativeCovered(lendVals, covN) // 억원, 양수=순상환
  const dir = directionBadge(lendVals, 5)

  const shortLast = short?.series[short.series.length - 1]
  const shortPrev = short?.series[short.series.length - 2]
  const ratioDelta = shortLast && shortPrev ? shortLast.ratioPct - shortPrev.ratioPct : 0

  const dtc = shortLast && hynix.data?.avg20Volume ? daysToCover(shortLast.shares, hynix.data.avg20Volume) : null

  // ---- Chart A data (lending) ----
  const lendFiltered = useMemo(() => (lending ? filterByPeriod(lending.series, period) : []), [lending, period])
  const lendRows = useMemo(() => {
    const flags = coveringFlags(lendFiltered.map((p) => ({ date: p.date, value: p.amountEok })))
    return lendFiltered.map((p, i) => ({
      ts: toTs(p.date),
      value: p.amountEok,
      cover: flags[i] ? p.amountEok : null, // green overlay only on covering runs
    }))
  }, [lendFiltered])
  const lendDates = lendFiltered.map((p) => p.date)
  const lendTicks = timeAxisTicks(lendDates)
  const lendFmt = timeTickFormatter(lendDates)

  // ---- Chart B data (short balance & ratio) ----
  const shortFiltered = useMemo(() => (short ? filterByPeriod(short.series, period) : []), [short, period])
  const shortRows = useMemo(
    () => shortFiltered.map((p) => ({ ts: toTs(p.date), amount: p.amountEok, ratio: p.ratioPct })),
    [shortFiltered],
  )
  const shortDates = shortFiltered.map((p) => p.date)
  const shortTicks = timeAxisTicks(shortDates)
  const shortFmt = timeTickFormatter(shortDates)

  // ---- Squeeze watch ----
  const squeeze = useMemo(() => {
    const priceCloses = hynix.data?.intraday.map((p) => p.price) ?? []
    return squeezeWatch({
      lendingDrop5Pct: pctChangeOver(lendVals, 5),
      priceGain5Pct: pctChangeOver(priceCloses, 5),
      volRatio: hynix.data?.avg20Volume ? (hynix.data.lastVolume || hynix.data.avg20Volume) / hynix.data.avg20Volume : 0,
    })
  }, [lendVals, hynix.data])

  // ---- 상환 추정 (5/10/20일 누적 감소) ----
  const coverEstimates = [5, 10, 20].map((n) => ({ n, eok: cumulativeCovered(lendVals, n) }))

  const isSeed = (lending?.meta.source ?? 'SEED') === 'SEED'
  const loading = lendingQ.isLoading || shortQ.isLoading

  return (
    <div className="panel short-covering">
      <div className="panel-head" style={{ alignItems: 'baseline', flexWrap: 'wrap', gap: 6 }}>
        <div>
          <h2>
            🩳 공매도 · 대차 상환 모니터
            <span className="badge" style={{ fontSize: 11, marginLeft: 8 }}>관찰 전용</span>
            <InfoTip text={TOOLTIPS.stockLending} />
          </h2>
          <div className="panel-sub">
            대차잔고 감소 = 숏 상환(커버) 가능성 · 000660 · {isSeed ? '샘플' : '실데이터'}
          </div>
        </div>
        {isSeed && <span className="badge sample" style={{ fontSize: 11 }}>실데이터 연동 예정 (주식대차정보 · data.go.kr)</span>}
      </div>

      <div className="disclaimer" role="note">
        ⚠️ 참고·관찰용입니다. 대차잔고 감소가 곧 숏 커버 확정은 아니며(헤지·차익·ETF LP 물량 포함) 매매신호·투자자문이 아닙니다.
      </div>

      {loading && !lending ? (
        <div aria-label="상환 모니터 데이터 불러오는 중">
          <div className="skeleton-kpi-row">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="skeleton" />
            ))}
          </div>
          <div className="skeleton skeleton-chart-lg" />
        </div>
      ) : (
        <>
          {/* KPI row */}
          <section className="kpi-row">
            <KpiCard
              label="종목 대차잔고"
              value={lendLast ? formatEokShort(lendLast.amountEok) : '—'}
              unit="원"
              changeText={lendLast ? `${formatEokShort(Math.abs(lendDelta))}${lendDelta < 0 ? ' 상환' : ''}` : undefined}
              changeLabel="전일대비"
              direction={lendDelta < 0 ? 'down' : lendDelta > 0 ? 'up' : 'flat'}
              invertColor
              info={TOOLTIPS.stockLending}
            />
            <KpiCard
              label="공매도 잔고비중"
              value={shortLast ? `${shortLast.ratioPct.toFixed(3)}%` : '—'}
              changeText={shortLast ? `${ratioDelta >= 0 ? '+' : ''}${ratioDelta.toFixed(3)}%p` : undefined}
              changeLabel="전일대비"
              direction={ratioDelta < 0 ? 'down' : ratioDelta > 0 ? 'up' : 'flat'}
              invertColor
              info={TOOLTIPS.shortBalance}
            />
            <KpiCard
              label={`${covN}일 누적 상환량(추정)`}
              value={formatEokShort(Math.max(0, cumCovered))}
              unit="원"
              changeText={`연속 감소 ${streak}일`}
              changeLabel={dir === 'cover' ? '상환 우위' : dir === 'newShort' ? '신규 숏 우위' : '중립'}
              direction={dir === 'cover' ? 'down' : dir === 'newShort' ? 'up' : 'flat'}
              invertColor
              info={TOOLTIPS.coveringPace}
            />
            <KpiCard
              label="Days-to-Cover"
              value={dtc != null ? `${dtc.toFixed(1)}일` : '—'}
              changeText={isSeed ? '분자 샘플 기반' : undefined}
              changeLabel="참고"
              direction="flat"
              info={TOOLTIPS.daysToCover}
            />
          </section>

          <div style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '4px 0 10px', flexWrap: 'wrap' }}>
            <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>기간</span>
            <PeriodSelector periods={CHART_PERIODS} value={period} onChange={setPeriod} />
            <span style={{ fontSize: 12, color: 'var(--text-dim)', marginLeft: 8 }}>누적 상환</span>
            <PeriodSelector periods={['5', '10']} value={String(covN)} onChange={(v) => setCovN(Number(v) as 5 | 10)} />
          </div>

          {/* Chart A: lending with covering highlight */}
          <div className="panel-head" style={{ marginTop: 4 }}>
            <div>
              <h3 style={{ margin: 0, fontSize: 14 }}>종목 대차잔고 추이 · 상환 진행 하이라이트</h3>
              <div className="panel-sub">초록 음영 = 연속 감소(상환 관찰) 구간 · {period}</div>
            </div>
            <div className="panel-latest">
              <span className="cover-dir" style={{ color: dir === 'cover' ? COVER_GREEN : DIR_META[dir].color }}>
                {dir === 'cover' ? '▼ 상환 우위' : DIR_META[dir].label}
              </span>
            </div>
          </div>
          <ResponsiveContainer width="100%" height={230}>
            <AreaChart data={lendRows} margin={{ top: 8, right: 12, left: 4, bottom: 0 }}>
              <defs>
                <linearGradient id="gLendCover" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#8b5cf6" stopOpacity={0.4} />
                  <stop offset="100%" stopColor="#8b5cf6" stopOpacity={0.03} />
                </linearGradient>
                <linearGradient id="gCoverGreen" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={COVER_GREEN} stopOpacity={0.5} />
                  <stop offset="100%" stopColor={COVER_GREEN} stopOpacity={0.06} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
              <XAxis dataKey="ts" type="number" scale="time" domain={['dataMin', 'dataMax']} ticks={lendTicks} tickFormatter={lendFmt} tickLine={false} axisLine={{ stroke: 'var(--border)' }} />
              <YAxis tickFormatter={(v) => formatEokShort(v)} tickLine={false} axisLine={false} width={54} />
              <Tooltip
                content={({ active, payload, label }: any) =>
                  active && payload?.length ? (
                    <div className="recharts-default-tooltip" style={{ padding: '8px 12px' }}>
                      <div style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 4 }}>{tsLong(label)}</div>
                      <div style={{ fontSize: 13 }}>대차잔고 <strong>{formatEok(payload[0].value)}</strong></div>
                    </div>
                  ) : null
                }
              />
              <Area type="monotone" dataKey="value" stroke="#8b5cf6" strokeWidth={1.6} fill="url(#gLendCover)" dot={false} isAnimationActive={false} />
              {/* Green overlay on sustained-decline (covering) runs */}
              <Area type="monotone" dataKey="cover" stroke={COVER_GREEN} strokeWidth={2} fill="url(#gCoverGreen)" dot={false} isAnimationActive={false} connectNulls={false} />
            </AreaChart>
          </ResponsiveContainer>

          {/* Chart B: short balance amount (bar) + ratio (line) */}
          <div className="panel-head" style={{ marginTop: 14 }}>
            <div>
              <h3 style={{ margin: 0, fontSize: 14 }}>공매도 잔고 &amp; 비중<InfoTip text={TOOLTIPS.shortBalance} /></h3>
              <div className="panel-sub">막대=잔고(억원) · 라인=비중(%) · 둘 다 우하향이면 커버링 관찰</div>
            </div>
            {isSeed && short && (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
                <span className="badge sample" style={{ fontSize: 10 }}>샘플</span>
                <InfoTip label="샘플 데이터 설명" text={`${short.meta.sourceLabel} · 기준일 ${short.meta.asOf}. ${short.meta.notes}`} />
              </span>
            )}
          </div>
          <ResponsiveContainer width="100%" height={200}>
            <ComposedChart data={shortRows} margin={{ top: 8, right: 12, left: 4, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
              <XAxis dataKey="ts" type="number" scale="time" domain={['dataMin', 'dataMax']} ticks={shortTicks} tickFormatter={shortFmt} tickLine={false} axisLine={{ stroke: 'var(--border)' }} />
              <YAxis yAxisId="amt" tickFormatter={(v) => formatEokShort(v)} tickLine={false} axisLine={false} width={50} />
              <YAxis yAxisId="ratio" orientation="right" tickFormatter={(v) => `${v.toFixed(2)}%`} tickLine={false} axisLine={false} width={48} />
              <Tooltip
                content={({ active, payload, label }: any) =>
                  active && payload?.length ? (
                    <div className="recharts-default-tooltip" style={{ padding: '8px 12px' }}>
                      <div style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 4 }}>{tsLong(label)}</div>
                      <div style={{ fontSize: 12 }}>잔고 {formatEok(payload.find((p: any) => p.dataKey === 'amount')?.value ?? 0)}</div>
                      <div style={{ fontSize: 12, color: 'var(--kosdaq)' }}>비중 {(payload.find((p: any) => p.dataKey === 'ratio')?.value ?? 0).toFixed(3)}%</div>
                    </div>
                  ) : null
                }
              />
              <Bar yAxisId="amt" dataKey="amount" fill="var(--down)" fillOpacity={0.35} isAnimationActive={false} />
              <Line yAxisId="ratio" type="monotone" dataKey="ratio" stroke="var(--kosdaq)" strokeWidth={1.6} dot={false} isAnimationActive={false} />
            </ComposedChart>
          </ResponsiveContainer>

          {/* Auxiliary: 상환 추정 + 스퀴즈 경계 */}
          <div className="grid-2" style={{ marginTop: 14 }}>
            <div className="aux-card">
              <div className="aux-title">대차 상환 추정 <InfoTip text={TOOLTIPS.coveringPace} /></div>
              <div className="aux-note">대차잔고 일별 감소 누계 (원장 아닌 추정치)</div>
              <div className="cover-est-rows">
                {coverEstimates.map((e) => (
                  <div key={e.n} className="cover-est-row">
                    <span>{e.n}일 누적</span>
                    <strong style={{ color: e.eok > 0 ? COVER_GREEN : 'var(--text-dim)' }}>{formatEok(e.eok)}</strong>
                  </div>
                ))}
              </div>
            </div>

            <div className="aux-card">
              <div className="aux-title">
                숏스퀴즈 경계 (참고)
                <InfoTip text={TOOLTIPS.shortSqueezeWatch} />
                <span className={`squeeze-badge ${squeeze.met ? 'on' : ''}`}>{squeeze.met ? '관찰 국면' : '해당 없음'}</span>
              </div>
              <div className="aux-note">3요소 동시 충족 시에만 관찰 국면 · 매매신호 아님</div>
              <ul className="squeeze-list">
                <li className={squeeze.conditions.lendingDrop ? 'met' : ''}>
                  <span className="sq-dot" /> 대차잔고 급감 (최근 5일 −5%↓)
                </li>
                <li className={squeeze.conditions.priceUp ? 'met' : ''}>
                  <span className="sq-dot" /> 주가 급등 (최근 5일 +5%↑)
                </li>
                <li className={squeeze.conditions.volUp ? 'met' : ''}>
                  <span className="sq-dot" /> 거래량 급증 (20일 평균 1.5배↑)
                </li>
              </ul>
            </div>
          </div>

          {/* 해석 가이드 */}
          <div className="aux-card" style={{ marginTop: 12 }}>
            <div className="aux-title">해석 가이드</div>
            <ul style={{ margin: '4px 0 0', paddingLeft: 18, color: 'var(--text-dim)', fontSize: 13, lineHeight: 1.8 }}>
              <li>대차잔고 감소 → 숏 상환(커버) 가능성. 단 헤지·차익·ETF LP 물량도 대차에 포함되어 감소가 곧 커버 확정은 아님.</li>
              <li>공매도 비중 감소가 동반되면 커버링 신뢰도↑.</li>
              <li>Days-to-Cover가 높을수록 잔여 숏 청산에 시간 필요 → 커버 매수세가 주가에 우호적으로 작용할 수 있음(참고).</li>
            </ul>
          </div>

          <div className="news-foot">
            대차·공매도 지표는 참고·관찰 목적이며 매매신호·투자자문이 아닙니다.
            {isSeed && ' 현재 표시값은 샘플이며, data.go.kr 주식대차정보 키 확보 시 실데이터로 자동 교체됩니다.'}
          </div>
        </>
      )}
    </div>
  )
}
