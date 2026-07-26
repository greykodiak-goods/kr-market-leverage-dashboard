// 투자봇 시뮬레이터 (백테스트) — 과거 일봉 데이터 위에서 "그 시점에 미래를
// 모른다"는 전제로 전략 모델을 워크포워드 실행한다. 신호는 당일 종가에서
// 판단, 체결은 다음날 시가(규칙형) 또는 당일 종가 LOC(알고리즘형). 모의
// 시뮬레이션 전용 — 실계좌·실주문과 어떤 연결도 없다.

import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { getDailyHistory, type HistoryRange } from '../../lib/history'
import { runBacktest } from './engine'
import {
  DEFAULT_IB_PARAMS,
  DEFAULT_VR_PARAMS,
  runInfiniteBuying,
  runValueRebalancing,
  type InfiniteBuyingParams,
  type VRParams,
} from './algoEngine'
import { PRESET_STRATEGIES, clonePreset } from './strategies'
import { ConditionEditor } from './ConditionEditor'
import { EquityChart } from './EquityChart'
import { KpiCard } from '../../components/KpiCard'
import { InfoTip } from '../../components/InfoTip'
import { DEFAULT_SETTINGS, type SimResult, type SimSettings, type StrategyConfig } from './types'

const SYMBOLS: { symbol: string; label: string }[] = [
  { symbol: '000660.KS', label: 'SK하이닉스' },
  { symbol: '005930.KS', label: '삼성전자' },
  { symbol: '069500.KS', label: 'KODEX 200' },
  { symbol: '122630.KS', label: 'KODEX 레버리지 (2배·고위험)' },
  { symbol: '^KS11', label: 'KOSPI 지수' },
  { symbol: 'QQQ', label: 'QQQ (나스닥100 ETF)' },
  { symbol: 'SOXL', label: 'SOXL (미 반도체 3배·초고위험)' },
  { symbol: 'TQQQ', label: 'TQQQ (나스닥100 3배·초고위험)' },
]

const LEVERAGED = new Set(['122630.KS', 'SOXL', 'TQQQ'])

// 알고리즘(자금관리형) 모델 — 조건 DSL이 아니라 자체 매매 규칙을 가진다.
const ALGO_MODELS = [
  {
    id: 'infinite-buying',
    name: '라오어 무한매수법 (근사) — SOXL 권장',
    desc: '원금을 T분할(기본 40)해 매일 정액 0.5회분 + 종가가 평단 아래면 0.5회분 추가로 LOC 매수, 평단 +10% 지정가 전량 매도 후 재시작하는 분할매수 모델(v1 근사). 원금 소진 시 신규매수를 멈추고 목표 대기. 사이클 종료 시 현금 전액이 다음 원금(복리).',
    defaultSymbol: 'SOXL',
  },
  {
    id: 'value-rebalancing',
    name: '라오어 VR 밸류 리밸런싱 (근사) — TQQQ 권장',
    desc: '자본의 일부(기본 75%)로 편입 후 V값을 주기(기본 10거래일)마다 g%(기본 1%) 성장시키고, 평가금이 밴드(±15%)를 벗어나면 V값까지 매도/매수해 현금 풀과 교환하는 장기 적립형 모델(근사). 추가 입금은 없다고 가정.',
    defaultSymbol: 'TQQQ',
  },
] as const

const MIN_WARMUP = 120 // bars kept before sim start so 지표(최대 SMA120급) warm-up이 가능

function fmtPct(v: number, digits = 1): string {
  return `${v >= 0 ? '+' : ''}${v.toFixed(digits)}%`
}

function num(v: string, fallback: number): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

export function BacktestSection() {
  const [symbol, setSymbol] = useState('000660.KS')
  const [customSymbol, setCustomSymbol] = useState('')
  const [range, setRange] = useState<HistoryRange>('10y')
  const activeSymbol = customSymbol.trim() || symbol

  const { data: hist, isLoading, isError, error } = useQuery({
    queryKey: ['history', activeSymbol, range],
    queryFn: () => getDailyHistory(activeSymbol, range),
    staleTime: 12 * 60 * 60 * 1000,
    retry: 1,
  })

  const bars = hist?.bars

  // 시뮬레이션 시작 시점 — 이 날짜 이전 데이터는 지표 warm-up용 "과거"로만
  // 쓰이고, 이후 구간은 하루씩 전진하며 그 시점까지의 정보만으로 판단한다.
  const [startDate, setStartDate] = useState('')
  const startIdx = useMemo(() => {
    if (!bars) return -1
    if (!startDate) return Math.max(MIN_WARMUP, Math.floor(bars.length / 2))
    const i = bars.findIndex((b) => b.date >= startDate)
    if (i < 0) return Math.max(MIN_WARMUP, bars.length - 2)
    return Math.max(MIN_WARMUP, i)
  }, [bars, startDate])

  const [modelId, setModelId] = useState<string>(PRESET_STRATEGIES[0].id)
  const [strategy, setStrategy] = useState<StrategyConfig>(() => clonePreset(PRESET_STRATEGIES[0].id))
  const [ibParams, setIbParams] = useState<InfiniteBuyingParams>(DEFAULT_IB_PARAMS)
  const [vrParams, setVrParams] = useState<VRParams>(DEFAULT_VR_PARAMS)
  const [settings, setSettings] = useState<SimSettings>(DEFAULT_SETTINGS)

  const isAlgo = ALGO_MODELS.some((m) => m.id === modelId)
  const algoModel = ALGO_MODELS.find((m) => m.id === modelId)
  const preset = PRESET_STRATEGIES.find((s) => s.id === modelId)

  const [result, setResult] = useState<SimResult | null>(null)
  const [comparison, setComparison] = useState<SimResult[] | null>(null)
  const [runError, setRunError] = useState<string | null>(null)

  function selectModel(id: string) {
    setModelId(id)
    const algo = ALGO_MODELS.find((m) => m.id === id)
    if (algo) {
      // 라오어 전략은 미국 상장 3배 ETF 기준이 원저 세팅 — 권장 심볼로 전환하고
      // 한국 증권거래세를 0으로(미국 종목 비적용, 아래 입력에서 조정 가능).
      setSymbol(algo.defaultSymbol)
      setCustomSymbol('')
      setSettings((s) => ({ ...s, sellTaxPct: 0 }))
    } else {
      setStrategy(clonePreset(id))
    }
  }

  function runModel(id: string): SimResult {
    if (!bars) throw new Error('데이터 없음')
    if (id === 'infinite-buying') return runInfiniteBuying(bars, startIdx, ibParams, settings)
    if (id === 'value-rebalancing') return runValueRebalancing(bars, startIdx, vrParams, settings)
    const cfg = id === modelId && !isAlgo ? strategy : PRESET_STRATEGIES.find((s) => s.id === id)!
    return runBacktest(bars, startIdx, cfg, settings)
  }

  function run() {
    if (!bars) return
    try {
      setRunError(null)
      setResult(runModel(modelId))
      setComparison(null)
    } catch (e) {
      setRunError(String((e as Error).message ?? e))
    }
  }

  function runComparison() {
    if (!bars) return
    try {
      setRunError(null)
      const rows = [
        ...PRESET_STRATEGIES.map((s) => runBacktest(bars, startIdx, s, settings)),
        runInfiniteBuying(bars, startIdx, ibParams, settings),
        runValueRebalancing(bars, startIdx, vrParams, settings),
      ]
      setComparison(rows)
      setResult(null)
    } catch (e) {
      setRunError(String((e as Error).message ?? e))
    }
  }

  const setNum = (key: keyof SimSettings, fallback: number) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setSettings((s) => ({ ...s, [key]: num(e.target.value, fallback) }))

  const m = result?.metrics
  const isForeign = hist != null && hist.currency !== 'KRW'

  return (
    <div className="panel bt-panel">
      <div className="panel-head">
        <h2>
          🤖 투자봇 시뮬레이터
          <InfoTip text="과거 일봉 데이터로 전략 모델을 시뮬레이션합니다. 각 시점에서 그 이후(미래) 데이터는 일절 사용하지 않으며(워크포워드), 규칙형은 당일 종가 판단 → 다음날 시가 체결, 알고리즘형(무한매수법·VR)은 원저 방식대로 당일 종가 LOC 체결로 처리해 미리보기 편향을 차단합니다. 수수료·증권거래세·슬리피지 반영. 모의 시뮬레이션 전용입니다." />
        </h2>
        <span className="badge sample">모의 시뮬레이션 · 실주문 없음</span>
      </div>
      <div className="panel-sub">
        특정 시점을 잡아 "미래를 모른다"는 전제로 전략을 하루씩 전진 실행합니다. 과거 성과는 미래 수익을 보장하지
        않습니다.
      </div>

      {/* ---- 데이터 · 기간 ---- */}
      <div className="bt-controls">
        <label>
          종목
          <select value={symbol} onChange={(e) => { setSymbol(e.target.value); setCustomSymbol('') }}>
            {SYMBOLS.map((s) => (
              <option key={s.symbol} value={s.symbol}>
                {s.label} ({s.symbol})
              </option>
            ))}
          </select>
        </label>
        <label>
          직접 입력(야후 심볼)
          <input
            type="text"
            placeholder="예: 035420.KS"
            value={customSymbol}
            onChange={(e) => setCustomSymbol(e.target.value)}
          />
        </label>
        <label>
          데이터 범위
          <select value={range} onChange={(e) => setRange(e.target.value as HistoryRange)}>
            <option value="5y">5년</option>
            <option value="10y">10년</option>
            <option value="max">전체</option>
          </select>
        </label>
        <label>
          시뮬레이션 시작일
          <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
        </label>
      </div>

      {isLoading && <div className="skeleton skeleton-chart-lg" />}
      {isError && (
        <div className="news-empty err">데이터 로드 실패: {String((error as Error)?.message ?? 'unknown')}</div>
      )}

      {bars && (
        <>
          <div className="bt-data-info">
            {hist!.stale && <span className="badge sample">캐시(갱신 실패)</span>}
            일봉 {bars.length.toLocaleString()}개 · {bars[0].date} ~ {bars[bars.length - 1].date} · 통화 {hist!.currency}
            {' '}· 시뮬레이션 구간:{' '}
            <strong>
              {bars[startIdx]?.date} ~ {bars[bars.length - 1].date}
            </strong>{' '}
            ({(bars.length - startIdx).toLocaleString()}일 · 이전 구간은 지표 계산용 과거)
            <span className="bt-quick">
              {([25, 50, 75] as const).map((p) => (
                <button
                  key={p}
                  type="button"
                  className="bt-btn-mini"
                  onClick={() => setStartDate(bars[Math.max(MIN_WARMUP, Math.floor((bars.length * p) / 100))].date)}
                >
                  {p}% 지점
                </button>
              ))}
            </span>
          </div>
          {LEVERAGED.has(activeSymbol) && (
            <div className="bt-warn bt-lev-warn">
              ⚠️ 레버리지 ETF — 변동성 잠식으로 기초지수 대비 장기 성과가 크게 괴리될 수 있고, 하락장에서 −80~90%대
              낙폭이 실제로 발생한 상품군입니다(SOXL 2022년 약 −91%). 시뮬레이션 결과와 무관하게 극단적 손실 가능성을
              전제로 보세요.
            </div>
          )}
          {isForeign && settings.sellTaxPct > 0 && (
            <div className="bt-chart-caption">
              ℹ️ 해외 상장 종목에는 한국 증권거래세가 적용되지 않습니다 — 거래세 0% 권장 (현재 {settings.sellTaxPct}%).
            </div>
          )}

          {/* ---- 전략 모델 + 조건/파라미터 편집 ---- */}
          <div className="bt-strategy">
            <div className="bt-controls">
              <label>
                전략 모델
                <select value={modelId} onChange={(e) => selectModel(e.target.value)}>
                  <optgroup label="규칙 기반 (매수·매도 조건 편집형)">
                    {PRESET_STRATEGIES.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </optgroup>
                  <optgroup label="자금관리 알고리즘 (라오어 시리즈)">
                    {ALGO_MODELS.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </optgroup>
                </select>
              </label>
              <div className="bt-strategy-desc">{isAlgo ? algoModel?.desc : preset?.desc}</div>
            </div>

            {!isAlgo && (
              <>
                <ConditionEditor
                  label="🟢 매수 조건"
                  combinator="AND"
                  conditions={strategy.buy}
                  onChange={(buy) => setStrategy((s) => ({ ...s, buy }))}
                />
                <ConditionEditor
                  label="🔵 매도 조건"
                  combinator="OR"
                  conditions={strategy.sell}
                  onChange={(sell) => setStrategy((s) => ({ ...s, sell }))}
                />
              </>
            )}

            {modelId === 'infinite-buying' && (
              <div className="bt-controls bt-algo-params">
                <label>
                  분할 수 (T)
                  <input type="number" min={2} max={200} value={ibParams.splits} onChange={(e) => setIbParams((p) => ({ ...p, splits: num(e.target.value, 40) }))} />
                </label>
                <label>
                  목표 수익률 % (평단 대비)
                  <input type="number" min={1} max={100} step={0.5} value={ibParams.targetPct} onChange={(e) => setIbParams((p) => ({ ...p, targetPct: num(e.target.value, 10) }))} />
                </label>
                <label>
                  사이클 손절 % (0=없음, v1 기본)
                  <InfoTip text="평단 대비 하락률이 이 값에 닿으면 사이클 전체를 손절하고 재시작합니다. 원저 v1은 손절 없이 목표 대기지만, 손절 없는 운용은 레버리지 ETF 장기 하락 구간에서 원금 대부분이 물릴 수 있습니다." />
                  <input
                    type="number"
                    min={0}
                    max={90}
                    value={ibParams.cycleStopPct ?? 0}
                    onChange={(e) => setIbParams((p) => ({ ...p, cycleStopPct: num(e.target.value, 0) > 0 ? num(e.target.value, 0) : null }))}
                  />
                </label>
              </div>
            )}

            {modelId === 'value-rebalancing' && (
              <div className="bt-controls bt-algo-params">
                <label>
                  리밸런싱 주기 (거래일)
                  <input type="number" min={1} max={60} value={vrParams.periodDays} onChange={(e) => setVrParams((p) => ({ ...p, periodDays: num(e.target.value, 10) }))} />
                </label>
                <label>
                  V값 성장률 %/주기
                  <InfoTip text="주기마다 목표 평가금(V값)을 이만큼 키웁니다. 기초자산의 장기 기대성장을 낙관적으로 잡을수록 하락장에서 현금 풀이 빨리 소진됩니다." />
                  <input type="number" min={0} max={10} step={0.1} value={vrParams.growthPct} onChange={(e) => setVrParams((p) => ({ ...p, growthPct: num(e.target.value, 1) }))} />
                </label>
                <label>
                  밴드 폭 ±%
                  <input type="number" min={1} max={50} value={vrParams.bandPct} onChange={(e) => setVrParams((p) => ({ ...p, bandPct: num(e.target.value, 15) }))} />
                </label>
                <label>
                  초기 주식 비중 %
                  <input type="number" min={10} max={100} value={vrParams.initialStockPct} onChange={(e) => setVrParams((p) => ({ ...p, initialStockPct: num(e.target.value, 75) }))} />
                </label>
              </div>
            )}

            {isAlgo && (
              <div className="bt-chart-caption">
                자금관리 알고리즘은 자체 분할·리밸런싱 규칙을 사용하므로 아래 설정의 진입 비중·손절·익절은 적용되지
                않습니다(초기자본·수수료·거래세·슬리피지만 적용). 라오어 원저 공개 버전의 근사 구현이며 실제 운용
                버전과 다를 수 있습니다.
              </div>
            )}
          </div>

          {/* ---- 자금 · 비용 · 리스크 ---- */}
          <div className="bt-controls bt-settings">
            <label>
              초기자본 ({hist!.currency})
              <input type="number" min={1000} step={1000000} value={settings.initialCapital} onChange={setNum('initialCapital', 10_000_000)} />
            </label>
            {!isAlgo && (
              <label>
                진입 비중 %
                <InfoTip text="매수 신호 시 현재 자산 중 몇 %를 투입할지 (포지션 사이징). 100% 몰빵은 손실 변동성을 크게 키웁니다." />
                <input type="number" min={1} max={100} value={settings.positionPct} onChange={setNum('positionPct', 50)} />
              </label>
            )}
            <label>
              수수료 %(편도)
              <input type="number" min={0} step={0.005} value={settings.commissionPct} onChange={setNum('commissionPct', 0.015)} />
            </label>
            <label>
              거래세 %(매도)
              <input type="number" min={0} step={0.05} value={settings.sellTaxPct} onChange={setNum('sellTaxPct', 0.15)} />
            </label>
            <label>
              슬리피지 %
              <input type="number" min={0} step={0.05} value={settings.slippagePct} onChange={setNum('slippagePct', 0.1)} />
            </label>
            {!isAlgo && (
              <>
                <label>
                  손절 %
                  <InfoTip text="진입가 대비 하락 시 자동 손절. 비우면(0) 손절 없음 — 손절 없는 전략은 미완성으로 간주하세요." />
                  <input
                    type="number"
                    min={0}
                    max={50}
                    value={settings.stopLossPct ?? 0}
                    onChange={(e) => setSettings((s) => ({ ...s, stopLossPct: num(e.target.value, 0) > 0 ? num(e.target.value, 0) : null }))}
                  />
                </label>
                <label>
                  익절 %
                  <input
                    type="number"
                    min={0}
                    max={200}
                    value={settings.takeProfitPct ?? 0}
                    onChange={(e) => setSettings((s) => ({ ...s, takeProfitPct: num(e.target.value, 0) > 0 ? num(e.target.value, 0) : null }))}
                  />
                </label>
              </>
            )}
          </div>

          <div className="bt-actions">
            <button type="button" className="bt-btn-run" onClick={run}>
              ▶ 시뮬레이션 실행
            </button>
            <button type="button" className="bt-btn-run alt" onClick={runComparison}>
              ⚖ 전체 모델 비교 (동일 구간)
            </button>
            {!isAlgo && settings.stopLossPct == null && (
              <span className="bt-warn">⚠️ 손절 미설정 — 최대 낙폭이 크게 확대될 수 있습니다</span>
            )}
            {modelId === 'infinite-buying' && ibParams.cycleStopPct == null && (
              <span className="bt-warn">⚠️ 사이클 손절 없음(v1 기본) — 장기 하락장에서 원금 대부분이 묶일 수 있습니다</span>
            )}
          </div>
          {runError && <div className="news-empty err">{runError}</div>}

          {/* ---- 단일 실행 결과 ---- */}
          {result && m && (
            <div className="bt-results">
              <div className="kpi-row">
                <KpiCard
                  label="총 수익률"
                  value={fmtPct(m.totalReturnPct)}
                  changeText={`단순보유 ${fmtPct(m.benchmarkReturnPct)}`}
                  changeLabel="벤치마크"
                  direction={m.totalReturnPct > m.benchmarkReturnPct ? 'up' : 'down'}
                />
                <KpiCard label="연환산(CAGR)" value={fmtPct(m.cagrPct)} changeText={`샤프 ${m.sharpe.toFixed(2)}`} changeLabel="위험조정" direction="flat" />
                <KpiCard
                  label="최대 낙폭(MDD)"
                  value={fmtPct(m.mddPct)}
                  changeText={`단순보유 ${fmtPct(m.benchmarkMddPct)}`}
                  changeLabel="벤치마크"
                  direction="flat"
                  info="고점 대비 최대 하락률. 수익률보다 먼저 견딜 수 있는 낙폭인지 확인하세요."
                />
                <KpiCard
                  label="승률 / 매매"
                  value={m.tradeCount > 0 ? `${m.winRatePct.toFixed(0)}%` : '—'}
                  unit={m.tradeCount > 0 ? ` / ${m.tradeCount}회` : ''}
                  changeText={`손익비 ${m.tradeCount === 0 ? '—' : m.profitFactor == null ? '∞' : m.profitFactor.toFixed(2)} · 노출 ${m.exposurePct.toFixed(0)}%`}
                  changeLabel=""
                  direction="flat"
                />
              </div>

              <EquityChart equity={result.equity} />

              {result.trades.length > 0 && (
                <details className="bt-trades">
                  <summary>
                    {result.strategyId === 'infinite-buying' ? '사이클 내역' : '매매 내역'} {result.trades.length}건
                  </summary>
                  <div className="bt-table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>진입일</th>
                          <th>{result.strategyId === 'infinite-buying' ? '최종 평단' : '진입가'}</th>
                          <th>수량</th>
                          <th>청산일</th>
                          <th>청산가</th>
                          <th>손익</th>
                          <th>수익률</th>
                          <th>사유</th>
                        </tr>
                      </thead>
                      <tbody>
                        {result.trades.map((t, i) => (
                          <tr key={i}>
                            <td>{t.entryDate}</td>
                            <td>{t.entryPrice.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
                            <td>{t.qty.toLocaleString()}</td>
                            <td>{t.exitDate ?? '—'}</td>
                            <td>{t.exitPrice != null ? t.exitPrice.toLocaleString(undefined, { maximumFractionDigits: 2 }) : '—'}</td>
                            <td className={t.pnl != null && t.pnl >= 0 ? 'bt-pos' : 'bt-neg'}>
                              {t.pnl != null ? Math.round(t.pnl).toLocaleString() : '—'}
                            </td>
                            <td className={t.pnlPct != null && t.pnlPct >= 0 ? 'bt-pos' : 'bt-neg'}>
                              {t.pnlPct != null ? fmtPct(t.pnlPct) : '—'}
                            </td>
                            <td>{t.reason}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </details>
              )}

              {result.events && result.events.length > 0 && (
                <details className="bt-trades">
                  <summary>체결 이벤트 {result.events.length.toLocaleString()}건 (최근 300건 표시)</summary>
                  <div className="bt-table-wrap bt-events">
                    <table>
                      <thead>
                        <tr>
                          <th>일자</th>
                          <th>구분</th>
                          <th>가격</th>
                          <th>수량</th>
                          <th>메모</th>
                        </tr>
                      </thead>
                      <tbody>
                        {result.events.slice(-300).map((ev, i) => (
                          <tr key={i}>
                            <td>{ev.date}</td>
                            <td className={ev.action === '매수' ? 'bt-pos' : 'bt-neg'}>{ev.action}</td>
                            <td>{ev.price.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
                            <td>{ev.qty.toLocaleString()}</td>
                            <td style={{ textAlign: 'left' }}>{ev.note}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </details>
              )}
            </div>
          )}

          {/* ---- 전체 모델 비교 ---- */}
          {comparison && (
            <div className="bt-results">
              <div className="bt-table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>모델</th>
                      <th>총수익률</th>
                      <th>CAGR</th>
                      <th>MDD</th>
                      <th>샤프</th>
                      <th>승률</th>
                      <th>매매</th>
                      <th>손익비</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...comparison]
                      .sort((a, b) => b.metrics.totalReturnPct - a.metrics.totalReturnPct)
                      .map((r) => (
                        <tr key={r.strategyId}>
                          <td>{r.strategyName}</td>
                          <td className={r.metrics.totalReturnPct >= 0 ? 'bt-pos' : 'bt-neg'}>
                            {fmtPct(r.metrics.totalReturnPct)}
                          </td>
                          <td>{fmtPct(r.metrics.cagrPct)}</td>
                          <td>{fmtPct(r.metrics.mddPct)}</td>
                          <td>{r.metrics.sharpe.toFixed(2)}</td>
                          <td>{r.metrics.tradeCount > 0 ? `${r.metrics.winRatePct.toFixed(0)}%` : '—'}</td>
                          <td>{r.metrics.tradeCount > 0 ? r.metrics.tradeCount : '—'}</td>
                          <td>
                            {r.metrics.tradeCount === 0
                              ? '—'
                              : r.metrics.profitFactor == null
                                ? '∞'
                                : r.metrics.profitFactor.toFixed(2)}
                          </td>
                        </tr>
                      ))}
                    <tr className="bt-bench-row">
                      <td>단순보유(벤치마크)</td>
                      <td className={comparison[0].metrics.benchmarkReturnPct >= 0 ? 'bt-pos' : 'bt-neg'}>
                        {fmtPct(comparison[0].metrics.benchmarkReturnPct)}
                      </td>
                      <td>—</td>
                      <td>{fmtPct(comparison[0].metrics.benchmarkMddPct)}</td>
                      <td colSpan={4}>—</td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <div className="bt-chart-caption">
                동일 자본·비용으로 전 모델을 같은 구간에 실행한 결과입니다. 규칙형 모델은 설정의 진입비중·손절·익절을
                따르고, 라오어 계열은 자체 파라미터(분할·목표·주기·밴드)를 따릅니다. 특정 구간의 우위가 다른
                구간·종목에서 재현된다는 보장은 없습니다(과최적화 주의). VR은 라운드트립이 없어 승률·매매·손익비를
                표기하지 않습니다.
              </div>
            </div>
          )}

          <div className="bt-disclaimer">
            본 시뮬레이터는 모의(백테스트) 전용이며 실주문·실계좌와 연결되지 않습니다. 라오어 무한매수법·VR은 공개된
            방법론의 근사 구현으로 원저·실제 운용 버전과 다를 수 있습니다. 본 내용은 정보·참고용이며 투자자문이
            아닙니다. 작성자는 투자자문 라이선스가 없습니다. 매수/매도 권유가 아니며, 모든 투자 판단과 실행·손익
            책임은 대표 본인에게 있습니다. 시장은 불확실하며 손실이 발생할 수 있습니다. 특히 3배 레버리지 ETF는
            변동성 잠식·상장폐지 리스크가 있는 초고위험 상품입니다. 데이터 출처: Yahoo Finance 일봉(수정주가 기준이
            아닐 수 있어 배당·감자 등은 미반영).
          </div>
        </>
      )}
    </div>
  )
}
