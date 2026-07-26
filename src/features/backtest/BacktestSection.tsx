// 투자봇 시뮬레이터 (백테스트) — 과거 일봉 데이터 위에서 "그 시점에 미래를
// 모른다"는 전제로 전략 모델을 워크포워드 실행한다. 신호는 당일 종가에서
// 판단, 체결은 다음날 시가 (+슬리피지·수수료·거래세). 모의 시뮬레이션 전용 —
// 실계좌·실주문과 어떤 연결도 없다.

import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { getDailyHistory, type HistoryRange } from '../../lib/history'
import { runBacktest } from './engine'
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
  { symbol: '122630.KS', label: 'KODEX 레버리지 (고위험)' },
  { symbol: '^KS11', label: 'KOSPI 지수' },
  { symbol: 'QQQ', label: 'QQQ (나스닥100 ETF)' },
]

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

  const [presetId, setPresetId] = useState(PRESET_STRATEGIES[0].id)
  const [strategy, setStrategy] = useState<StrategyConfig>(() => clonePreset(PRESET_STRATEGIES[0].id))
  const [settings, setSettings] = useState<SimSettings>(DEFAULT_SETTINGS)

  const [result, setResult] = useState<SimResult | null>(null)
  const [comparison, setComparison] = useState<SimResult[] | null>(null)
  const [runError, setRunError] = useState<string | null>(null)

  function selectPreset(id: string) {
    setPresetId(id)
    setStrategy(clonePreset(id))
  }

  function run() {
    if (!bars) return
    try {
      setRunError(null)
      setResult(runBacktest(bars, startIdx, strategy, settings))
      setComparison(null)
    } catch (e) {
      setRunError(String((e as Error).message ?? e))
    }
  }

  function runComparison() {
    if (!bars) return
    try {
      setRunError(null)
      const rows = PRESET_STRATEGIES.map((s) => runBacktest(bars, startIdx, s, settings))
      setComparison(rows)
      setResult(null)
    } catch (e) {
      setRunError(String((e as Error).message ?? e))
    }
  }

  const setNum = (key: keyof SimSettings, fallback: number) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setSettings((s) => ({ ...s, [key]: num(e.target.value, fallback) }))

  const m = result?.metrics

  return (
    <div className="panel bt-panel">
      <div className="panel-head">
        <h2>
          🤖 투자봇 시뮬레이터
          <InfoTip text="과거 일봉 데이터로 전략 모델을 시뮬레이션합니다. 각 시점에서 그 이후(미래) 데이터는 일절 사용하지 않으며(워크포워드), 신호는 당일 종가 판단 → 다음날 시가 체결로 처리해 미리보기 편향을 차단합니다. 수수료·증권거래세·슬리피지 반영. 모의 시뮬레이션 전용입니다." />
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
            일봉 {bars.length.toLocaleString()}개 · {bars[0].date} ~ {bars[bars.length - 1].date} · 시뮬레이션 구간:{' '}
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

          {/* ---- 전략 모델 + 조건 편집 ---- */}
          <div className="bt-strategy">
            <div className="bt-controls">
              <label>
                전략 모델
                <select value={presetId} onChange={(e) => selectPreset(e.target.value)}>
                  {PRESET_STRATEGIES.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </label>
              <div className="bt-strategy-desc">{PRESET_STRATEGIES.find((s) => s.id === presetId)?.desc}</div>
            </div>
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
          </div>

          {/* ---- 자금 · 비용 · 리스크 ---- */}
          <div className="bt-controls bt-settings">
            <label>
              초기자본
              <input type="number" min={100000} step={1000000} value={settings.initialCapital} onChange={setNum('initialCapital', 10_000_000)} />
            </label>
            <label>
              진입 비중 %
              <InfoTip text="매수 신호 시 현재 자산 중 몇 %를 투입할지 (포지션 사이징). 100% 몰빵은 손실 변동성을 크게 키웁니다." />
              <input type="number" min={1} max={100} value={settings.positionPct} onChange={setNum('positionPct', 50)} />
            </label>
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
          </div>

          <div className="bt-actions">
            <button type="button" className="bt-btn-run" onClick={run}>
              ▶ 시뮬레이션 실행
            </button>
            <button type="button" className="bt-btn-run alt" onClick={runComparison}>
              ⚖ 전체 모델 비교 (동일 조건)
            </button>
            {settings.stopLossPct == null && (
              <span className="bt-warn">⚠️ 손절 미설정 — 최대 낙폭이 크게 확대될 수 있습니다</span>
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
                  value={`${m.winRatePct.toFixed(0)}%`}
                  unit={` / ${m.tradeCount}회`}
                  changeText={`손익비 ${m.profitFactor == null ? '∞' : m.profitFactor.toFixed(2)} · 노출 ${m.exposurePct.toFixed(0)}%`}
                  changeLabel=""
                  direction="flat"
                />
              </div>

              <EquityChart equity={result.equity} />

              <details className="bt-trades">
                <summary>매매 내역 {result.trades.length}건</summary>
                <div className="bt-table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>진입일</th>
                        <th>진입가</th>
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
                          <td>{Math.round(t.entryPrice).toLocaleString()}</td>
                          <td>{t.qty.toLocaleString()}</td>
                          <td>{t.exitDate ?? '—'}</td>
                          <td>{t.exitPrice != null ? Math.round(t.exitPrice).toLocaleString() : '—'}</td>
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
                          <td>{r.metrics.winRatePct.toFixed(0)}%</td>
                          <td>{r.metrics.tradeCount}</td>
                          <td>{r.metrics.profitFactor == null ? '∞' : r.metrics.profitFactor.toFixed(2)}</td>
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
                동일 자금·비용·리스크 설정으로 전 모델을 같은 구간에 실행한 결과입니다. 특정 구간의 우위가 다른
                구간·종목에서 재현된다는 보장은 없습니다(과최적화 주의).
              </div>
            </div>
          )}

          <div className="bt-disclaimer">
            본 시뮬레이터는 모의(백테스트) 전용이며 실주문·실계좌와 연결되지 않습니다. 본 내용은 정보·참고용이며
            투자자문이 아닙니다. 작성자는 투자자문 라이선스가 없습니다. 매수/매도 권유가 아니며, 모든 투자 판단과
            실행·손익 책임은 대표 본인에게 있습니다. 시장은 불확실하며 손실이 발생할 수 있습니다. 데이터 출처: Yahoo
            Finance 일봉(수정주가 기준이 아닐 수 있어 배당·감자 등은 미반영).
          </div>
        </>
      )}
    </div>
  )
}
