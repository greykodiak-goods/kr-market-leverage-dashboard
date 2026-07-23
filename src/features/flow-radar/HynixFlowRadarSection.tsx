import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  Area,
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { KpiCard } from '../../components/KpiCard'
import { InfoTip } from '../../components/InfoTip'
import { PeriodSelector } from '../../components/PeriodSelector'
import { Sparkline } from '../../components/Sparkline'
import { formatEok, formatPercent, formatSignedEok } from '../../lib/format'
import { toTs, tsLong, timeAxisTicks, timeTickFormatter } from '../../components/chartUtils'
import { fetchSupplyDemand, SEED_SUPPLY_DEMAND, dartLink } from './supplyDemand'
import { cumulative, lastZScore, maSeries, outflowAlert, trailingStreak, trendArrow, twinStatus } from './lib/flowMetrics'
import type { SdEvent, SdEventType } from './types'

// ---- local constants --------------------------------------------------------

const COLOR_FOREIGN = '#2563eb' // 외인 막대
const COLOR_INST = '#f59e0b' // 기관 막대
const COLOR_CLOSE = '#8b5cf6' // 종가 라인
const COLOR_HOLD = '#10b981' // 보유율 area

type FlowPeriod = '20일' | '60일' | '전체'
const FLOW_PERIODS: FlowPeriod[] = ['20일', '60일', '전체']
type ChartView = '순매수 플로우' | '보유율 추세'
const CHART_VIEWS: ChartView[] = ['순매수 플로우', '보유율 추세']

type FeedFilter = 'all' | SdEventType
const FEED_FILTERS: { id: FeedFilter; label: string }[] = [
  { id: 'all', label: '전체' },
  { id: 'major-stock', label: '5%룰' },
  { id: 'insider', label: '내부자' },
  { id: 'overhang', label: '오버행' },
]
const EVENT_TAGS: Record<SdEventType, { label: string; cls: string }> = {
  'major-stock': { label: '5%룰', cls: 'major' },
  insider: { label: '내부자', cls: 'insider' },
  overhang: { label: '오버행', cls: 'overhang' },
}
const FEED_PAGE = 8

const TIPS = {
  twin: '외국인과 기관이 같은 방향으로 연속 순매수(도)한 일수입니다. 임계값(기본 3일)은 관행적 기준이며 검증된 표준이 아니고, 매매 신호가 아닙니다. 현재 플로우 데이터는 샘플입니다.',
  cum: '최근 5·20거래일 순매수 금액 합계와, 5일 순매수의 같은 기간 거래대금 대비 비중(수급 점유율)입니다. 점유율이 높을수록 해당 주체가 가격에 미친 영향이 컸다는 참고 지표입니다.',
  hold: '외국인 보유율(%)과 20일 이동평균 기울기 화살표입니다. 순매수 집계보다 느리지만 왜곡이 적은 확인 지표로 통용됩니다. 현재 데이터는 샘플입니다.',
  sens: '산식: 1점 + [5% 이상 보유자 합산 ≥30% +1] + [유통비율 <70% +1] + [유통비율 <50% +1] + [최근 3개월 물량성 공시 존재 +1] → 1~2 낮음 / 3 보통 / 4~5 높음. 분기·공시 기준이라 시차가 있으며 참고용입니다.',
  alert:
    '보유율 20일 추세 하락 + 외인 연속 순매도(임계 이상) + 순매도 강도(z-score ≤ −1)가 동시에 충족될 때만 표시되는 관찰 국면입니다. 임계값은 관행적 기준이며 매매 신호가 아닙니다.',
  feed: '5%룰·내부자 공시는 사유 발생 후 최대 5영업일(경우에 따라 그 이상) 지연 보고되는 사후 확인 정보입니다. 공시 시점에는 정보가 이미 주가에 반영됐을 수 있습니다.',
  overhang:
    '시장에 쏟아질 수 있는 잠재 물량(유상증자·CB·DR 등) 공시의 접수 목록입니다. 확정 일정(청구·상장예정일)은 원문 공시에서 확인하세요. 초대형주는 평시 비어 있는 것이 정상입니다.',
}

// ---- small formatters -------------------------------------------------------

function streakText(n: number): string {
  if (n > 0) return `${n}일 매수`
  if (n < 0) return `${-n}일 매도`
  return '중립'
}

function formatShares(n: number): string {
  const abs = Math.abs(n)
  const sign = n > 0 ? '+' : n < 0 ? '−' : ''
  if (abs >= 10000) return `${sign}${Math.round(abs / 10000).toLocaleString('ko-KR')}만주`
  return `${sign}${abs.toLocaleString('ko-KR')}주`
}

function ratioText(ev: SdEvent): string | null {
  if (ev.ratioBefore == null || ev.ratioAfter == null) return null
  const d = ev.ratioChange ?? ev.ratioAfter - ev.ratioBefore
  const sign = d > 0 ? '+' : d < 0 ? '−' : ''
  return `${ev.ratioBefore}% → ${ev.ratioAfter}% (${sign}${Math.abs(Math.round(d * 100) / 100)}%p)`
}

// ---- component --------------------------------------------------------------

export function HynixFlowRadarSection() {
  const q = useQuery({ queryKey: ['supply-demand'], queryFn: fetchSupplyDemand, staleTime: 30 * 60 * 1000 })
  const data = q.data ?? SEED_SUPPLY_DEMAND

  const [period, setPeriod] = useState<FlowPeriod>('60일')
  const [view, setView] = useState<ChartView>('순매수 플로우')
  const [entity, setEntity] = useState<'외인' | '기관'>('외인')
  const [filter, setFilter] = useState<FeedFilter>('all')
  const [showAll, setShowAll] = useState(false)

  const daily = data.flow.daily
  const flowSeed = data.sources.flow === 'seed'
  const eventsLive = data.sources.events === 'dart'

  // ---- KPI derivations ----
  const foreignVals = useMemo(() => daily.map((d) => d.foreignNetEok), [daily])
  const instVals = useMemo(() => daily.map((d) => d.instNetEok), [daily])
  const holdRatios = useMemo(() => daily.map((d) => d.foreignHoldRatio), [daily])

  const fStreak = trailingStreak(foreignVals)
  const iStreak = trailingStreak(instVals)
  const twin = twinStatus(fStreak, iStreak, data.config.twinStreakThreshold)
  const fZ = lastZScore(foreignVals, data.config.zscoreWindow)

  const entityVals = entity === '외인' ? foreignVals : instVals
  const cum5 = cumulative(entityVals, 5)
  const cum20 = cumulative(entityVals, 20)
  const value5 = cumulative(
    daily.map((d) => d.valueEok),
    5,
  )
  const share5 = value5 > 0 ? (Math.abs(cum5) / value5) * 100 : 0

  const lastHold = holdRatios[holdRatios.length - 1]
  const holdArrow = trendArrow(holdRatios)
  const alertOn = outflowAlert({ holdRatios, foreignStreak: fStreak, foreignZ: fZ, threshold: data.config.twinStreakThreshold })

  const conc = data.concentration

  // ---- chart data ----
  const sliced = useMemo(() => {
    if (period === '20일') return daily.slice(-20)
    if (period === '60일') return daily.slice(-60)
    return daily
  }, [daily, period])
  const dates = sliced.map((d) => d.date)
  const ticks = timeAxisTicks(dates)
  const tickFmt = timeTickFormatter(dates)
  const flowRows = useMemo(() => sliced.map((d) => ({ ts: toTs(d.date), 외인: d.foreignNetEok, 기관: d.instNetEok, 종가: d.close })), [sliced])
  const holdRows = useMemo(() => {
    const ma20 = maSeries(holdRatios, 20)
    const ma60 = maSeries(holdRatios, 60)
    const offset = daily.length - sliced.length
    return sliced.map((d, i) => ({
      ts: toTs(d.date),
      보유율: d.foreignHoldRatio,
      'MA20': ma20[offset + i],
      'MA60': ma60[offset + i],
    }))
  }, [sliced, daily.length, holdRatios])

  const holdSpark = useMemo(() => holdRatios.slice(-30).map((v, i) => ({ t: i, price: v })), [holdRatios])

  // ---- feed ----
  const filtered = useMemo(() => (filter === 'all' ? data.events : data.events.filter((e) => e.type === filter)), [data.events, filter])
  const visible = showAll ? filtered : filtered.slice(0, FEED_PAGE)

  const twinValue = twin.status === 'both-buy' ? `🟢 동반 순매수 ${twin.days}일` : twin.status === 'both-sell' ? `🔴 동반 순매도 ${twin.days}일` : '⚪ 엇갈림'

  const loading = q.isLoading && !q.data

  return (
    <div className="panel flow-radar">
      <div className="panel-head" style={{ alignItems: 'baseline', flexWrap: 'wrap', gap: 6 }}>
        <div>
          <h2>
            🎯 하이닉스 수급 레이더
            <span className="badge" style={{ fontSize: 11, marginLeft: 8 }}>관찰 전용</span>
            {alertOn && (
              <span className="badge sample" style={{ fontSize: 11, marginLeft: 6 }}>
                🔴 수급 이탈 관찰 국면
                <InfoTip text={TIPS.alert} />
              </span>
            )}
          </h2>
          <div className="panel-sub">000660 · 기준일 {data.meta.asOf} · 큰손 매도·수급 이벤트 포착</div>
        </div>
        <div className="badges">
          {eventsLive ? (
            <span className="badge live" style={{ fontSize: 11 }}>공시 LIVE (DART)</span>
          ) : (
            <span className="badge sample" style={{ fontSize: 11 }}>공시 샘플</span>
          )}
          {flowSeed && <span className="badge sample" style={{ fontSize: 11 }}>쌍끌이 샘플 · 실데이터 연동 예정 (KIS 키 필요)</span>}
        </div>
      </div>

      <div className="disclaimer" role="note">
        ⚠️ 공시·집계 기반 참고 정보입니다. 5%룰·내부자 공시는 사유 발생 후 최대 5영업일(경우에 따라 그 이상) 지연 보고되는 <strong>사후 확인 정보</strong>이며, 매매신호·투자자문이 아닙니다.
      </div>

      {loading ? (
        <div aria-label="수급 레이더 데이터 불러오는 중">
          <div className="skeleton-kpi-row">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="skeleton" />
            ))}
          </div>
          <div className="skeleton skeleton-chart-lg" />
        </div>
      ) : (
        <>
          {/* ① KPI strip */}
          <section className="kpi-row">
            <KpiCard
              label={`쌍끌이 상태${flowSeed ? ' (샘플)' : ''}`}
              value={twinValue}
              changeText={`외인 ${streakText(fStreak)} · 기관 ${streakText(iStreak)}`}
              changeLabel="연속일수"
              direction={twin.status === 'both-buy' ? 'up' : twin.status === 'both-sell' ? 'down' : 'flat'}
              info={TIPS.twin}
            />
            <div className="kpi-card">
              <div className="label">
                {entity} 누적 순매수{flowSeed ? ' (샘플)' : ''}
                <InfoTip text={TIPS.cum} />
              </div>
              <div className="value">
                {formatSignedEok(cum5)}
                <span className="unit">원 · 5일</span>
              </div>
              <div className="change">
                <span className={cum20 > 0 ? 'up' : cum20 < 0 ? 'down' : 'muted'}>
                  20일 {formatSignedEok(cum20)}
                </span>
                <span className="muted">점유율 {share5.toFixed(1)}%</span>
              </div>
              <div style={{ marginTop: 6 }}>
                <PeriodSelector periods={['외인', '기관'] as const} value={entity} onChange={setEntity} />
              </div>
            </div>
            <div className="kpi-card">
              <div className="label">
                외국인 보유율{flowSeed ? ' (샘플)' : ''}
                <InfoTip text={TIPS.hold} />
              </div>
              <div className="value">
                {lastHold != null ? formatPercent(lastHold) : '—'}
                <span className="unit">{holdArrow} 20일 추세</span>
              </div>
              <Sparkline data={holdSpark} color={COLOR_HOLD} height={34} />
            </div>
            <KpiCard
              label="급락 민감도"
              value={`${conc.sensitivityLabel} ${conc.sensitivityScore}/5`}
              changeText={conc.freeFloatRatioPct != null ? `유통비율 ${formatPercent(conc.freeFloatRatioPct, 1)} · 5%↑ 합산 ${conc.fivePctSum != null ? formatPercent(conc.fivePctSum, 1) : '—'}` : undefined}
              changeLabel={conc.asOfLabel}
              direction="flat"
              info={TIPS.sens}
            />
          </section>

          {/* ② combo chart */}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '2px 0 10px', flexWrap: 'wrap' }}>
            <PeriodSelector periods={CHART_VIEWS} value={view} onChange={setView} />
            <span style={{ fontSize: 12, color: 'var(--text-dim)', marginLeft: 4 }}>기간</span>
            <PeriodSelector periods={FLOW_PERIODS} value={period} onChange={setPeriod} />
            {flowSeed && <span className="badge sample" style={{ fontSize: 10 }}>샘플</span>}
          </div>

          {view === '순매수 플로우' ? (
            <>
              <div className="panel-sub" style={{ marginBottom: 4 }}>
                막대 = 일별 순매수(억원, <span style={{ color: COLOR_FOREIGN }}>■ 외인</span> · <span style={{ color: COLOR_INST }}>■ 기관</span>) · 라인 = 종가(원)
              </div>
              <ResponsiveContainer width="100%" height={240}>
                <ComposedChart data={flowRows} margin={{ top: 8, right: 8, left: 4, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                  <XAxis dataKey="ts" type="number" scale="time" domain={['dataMin', 'dataMax']} ticks={ticks} tickFormatter={tickFmt} tickLine={false} axisLine={{ stroke: 'var(--border)' }} />
                  <YAxis yAxisId="flow" tickFormatter={(v) => `${Math.round(v / 1000)}천억`} tickLine={false} axisLine={false} width={52} />
                  <YAxis yAxisId="price" orientation="right" domain={['auto', 'auto']} tickFormatter={(v) => `${Math.round(v / 10000)}만`} tickLine={false} axisLine={false} width={44} />
                  <Tooltip
                    cursor={{ stroke: 'var(--text-faint)', strokeDasharray: '3 3' }}
                    content={({ active, payload, label }: any) =>
                      active && payload?.length ? (
                        <div className="recharts-default-tooltip">
                          <div className="tooltip-label">{tsLong(label)}</div>
                          <div style={{ fontSize: 12, color: COLOR_FOREIGN }}>외인 {formatEok(payload.find((p: any) => p.dataKey === '외인')?.value ?? 0)}</div>
                          <div style={{ fontSize: 12, color: COLOR_INST }}>기관 {formatEok(payload.find((p: any) => p.dataKey === '기관')?.value ?? 0)}</div>
                          <div style={{ fontSize: 12 }}>종가 {(payload.find((p: any) => p.dataKey === '종가')?.value ?? 0).toLocaleString('ko-KR')}원</div>
                        </div>
                      ) : null
                    }
                  />
                  <Bar yAxisId="flow" dataKey="외인" fill={COLOR_FOREIGN} fillOpacity={0.75} isAnimationActive={false} />
                  <Bar yAxisId="flow" dataKey="기관" fill={COLOR_INST} fillOpacity={0.75} isAnimationActive={false} />
                  <Line yAxisId="price" type="monotone" dataKey="종가" stroke={COLOR_CLOSE} strokeWidth={1.6} dot={false} isAnimationActive={false} />
                </ComposedChart>
              </ResponsiveContainer>
            </>
          ) : (
            <>
              <div className="panel-sub" style={{ marginBottom: 4 }}>
                외국인 보유율(%) + 20·60일 이동평균 — 20일선 아래로 꺾이면 이탈 국면 관찰(신호 6)
              </div>
              <ResponsiveContainer width="100%" height={240}>
                <ComposedChart data={holdRows} margin={{ top: 8, right: 8, left: 4, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                  <XAxis dataKey="ts" type="number" scale="time" domain={['dataMin', 'dataMax']} ticks={ticks} tickFormatter={tickFmt} tickLine={false} axisLine={{ stroke: 'var(--border)' }} />
                  <YAxis domain={[(min: number) => Math.floor((min - 0.2) * 10) / 10, (max: number) => Math.ceil((max + 0.2) * 10) / 10]} tickFormatter={(v) => formatPercent(v, 1)} tickLine={false} axisLine={false} width={52} />
                  <Tooltip
                    cursor={{ stroke: 'var(--text-faint)', strokeDasharray: '3 3' }}
                    content={({ active, payload, label }: any) =>
                      active && payload?.length ? (
                        <div className="recharts-default-tooltip">
                          <div className="tooltip-label">{tsLong(label)}</div>
                          {payload.map((p: any) =>
                            p.value != null ? (
                              <div key={p.dataKey} style={{ fontSize: 12, color: p.color }}>
                                {p.dataKey} {formatPercent(p.value)}
                              </div>
                            ) : null,
                          )}
                        </div>
                      ) : null
                    }
                  />
                  <Area type="monotone" dataKey="보유율" stroke={COLOR_HOLD} strokeWidth={1.6} fill={COLOR_HOLD} fillOpacity={0.12} dot={false} isAnimationActive={false} />
                  <Line type="monotone" dataKey="MA20" stroke={COLOR_INST} strokeWidth={1.3} dot={false} strokeDasharray="4 2" isAnimationActive={false} connectNulls />
                  <Line type="monotone" dataKey="MA60" stroke={COLOR_CLOSE} strokeWidth={1.3} dot={false} strokeDasharray="2 3" isAnimationActive={false} connectNulls />
                </ComposedChart>
              </ResponsiveContainer>
            </>
          )}

          {/* ③ event feed */}
          <div className="panel-head" style={{ marginTop: 16 }}>
            <div>
              <h3 style={{ margin: 0, fontSize: 14 }}>
                공시 이벤트 피드 <InfoTip text={TIPS.feed} />
              </h3>
              <div className="panel-sub">5%룰 · 내부자 · 오버행 통합 타임라인 · 최신순{eventsLive ? ' · DART 실공시' : ' · 샘플'}</div>
            </div>
          </div>
          <div className="cat-tabs" style={{ marginBottom: 8 }}>
            {FEED_FILTERS.map((f) => (
              <button
                key={f.id}
                type="button"
                className={`cat-tab${filter === f.id ? ' active' : ''}`}
                onClick={() => {
                  setFilter(f.id)
                  setShowAll(false)
                }}
              >
                {f.label}
              </button>
            ))}
          </div>

          {filtered.length === 0 ? (
            <div className="news-empty">최근 신규 이벤트 없음 — 5%룰·내부자·주요사항 공시 기준</div>
          ) : (
            <>
              <ul className="sd-event-list">
                {visible.map((ev) => {
                  const tag = EVENT_TAGS[ev.type]
                  const ratio = ratioText(ev)
                  return (
                    <li key={ev.rceptNo + ev.reporter} className="sd-event">
                      <div className="sd-event-top">
                        <span className={`sd-tag ${tag.cls}`}>{ev.subtype ?? tag.label}</span>
                        <span className="sd-event-reporter">{ev.reporter}</span>
                        {ev.position && <span className="sd-event-pos">{ev.position}</span>}
                        <span className="sd-event-date">{ev.rceptDt} 접수</span>
                      </div>
                      {(ratio || ev.changeShares != null || ev.reason) && (
                        <div className="sd-event-body">
                          {ratio && <span className="sd-event-ratio">{ratio}</span>}
                          {ev.changeShares != null && ev.changeShares !== 0 && (
                            <span className={`sd-event-shares ${ev.changeShares > 0 ? 'buy' : 'sell'}`}>{formatShares(ev.changeShares)}</span>
                          )}
                          {ev.reason && <span className="sd-event-reason">{ev.reason}</span>}
                        </div>
                      )}
                      <div className="sd-event-foot">
                        <span>접수일 기준 · 실제 체결은 최대 5영업일+ 이전일 수 있음</span>
                        <a href={dartLink(ev.rceptNo)} target="_blank" rel="noreferrer noopener">
                          원문 공시 ↗
                        </a>
                      </div>
                    </li>
                  )
                })}
              </ul>
              {filtered.length > FEED_PAGE && (
                <button type="button" className="cat-tab" style={{ marginTop: 8 }} onClick={() => setShowAll((v) => !v)}>
                  {showAll ? '접기' : `더 보기 (+${filtered.length - FEED_PAGE}건)`}
                </button>
              )}
            </>
          )}

          {/* ④ overhang calendar + ⑤ concentration */}
          <div className="grid-2" style={{ marginTop: 14 }}>
            <div className="aux-card">
              <div className="aux-title">
                오버행 캘린더 (잠재 물량) <InfoTip text={TIPS.overhang} />
              </div>
              <div className="aux-note">최근 3개월 주요사항·증권신고 접수 기준 · 확정 일정은 원문 확인</div>
              {data.overhang.length === 0 ? (
                <div style={{ fontSize: 13, color: 'var(--text-dim)', padding: '8px 0' }}>현재 확인된 잠재 물량 이벤트 없음 ✅</div>
              ) : (
                <ul className="sd-overhang-list">
                  {data.overhang.slice(0, 6).map((o) => (
                    <li key={o.rceptNo}>
                      <span className="sd-tag overhang">{o.kind}</span>
                      <a href={dartLink(o.rceptNo)} target="_blank" rel="noreferrer noopener" className="sd-overhang-title">
                        {o.title}
                      </a>
                      <span className="sd-event-date">{o.rceptDt}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="aux-card">
              <div className="aux-title">
                보유 집중도 <InfoTip text={TIPS.sens} />
              </div>
              <div className="aux-note">
                {conc.asOfLabel}
                {conc.totalShares != null && ` · 총 발행 ${Math.round(conc.totalShares / 10000).toLocaleString('ko-KR')}만주`}
              </div>
              <div className="sd-holder-rows">
                {conc.majorHolders.map((h) => (
                  <div key={h.name} className="sd-holder-row" title={h.note}>
                    <span className="sd-holder-name">{h.name}</span>
                    <strong>{formatPercent(h.ratio, 2)}</strong>
                  </div>
                ))}
                {conc.freeFloatRatioPct != null && (
                  <div className="sd-holder-row sd-holder-free">
                    <span className="sd-holder-name">유통주식비율(추정)</span>
                    <strong>{formatPercent(conc.freeFloatRatioPct, 1)}</strong>
                  </div>
                )}
              </div>
              {conc.exitedNotes.length > 0 && (
                <div style={{ fontSize: 11.5, color: 'var(--text-dim)', marginTop: 6, lineHeight: 1.6 }}>
                  {conc.exitedNotes.map((n) => (
                    <div key={n}>· {n}</div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* ⑤ disclaimer */}
          <div className="news-foot">{data.disclaimer}</div>
        </>
      )}
    </div>
  )
}
