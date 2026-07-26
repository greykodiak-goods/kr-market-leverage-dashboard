// 모델 상세 — 가상 투자자 1명의 전용 조회 화면.
// 유니버스·기간·변수 편집 + 실행 + 정밀 평가 지표(기본/위험조정/일관성).

import { useState } from 'react'
import { getDailyHistory, type HistoryResult } from '../../lib/history'
import { runPortfolio, type PortfolioResult } from './portfolio'
import { modelMeta, MODEL_META, type ModelConfig } from './models'
import { DEFAULT_IB_PARAMS, DEFAULT_VR_PARAMS } from './algoEngine'
import { DEFAULT_ROTATION } from './rotation'
import { findDoc } from './modelDocs'
import { ConditionEditor } from './ConditionEditor'
import { UniverseEditor, symbolLabel } from './UniverseEditor'
import { EquityChart } from './EquityChart'
import { KpiCard } from '../../components/KpiCard'
import { InfoTip } from '../../components/InfoTip'
import { clonePreset } from './strategies'
import { LiveTracking } from './LiveTracking'
import { DataProvenance } from './DataProvenance'
import type { Enrollment } from './spec'
import type { SimSettings } from './types'

const LEVERAGED = new Set(['122630.KS', 'SOXL', 'TQQQ', 'SOXS', 'SQQQ', 'UPRO', 'TMF'])

function fmtPct(v: number, digits = 1): string {
  return `${v >= 0 ? '+' : ''}${v.toFixed(digits)}%`
}

function num(v: string, fallback: number): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

interface Props {
  modelId: string
  cfg: ModelConfig
  result: PortfolioResult | null
  histories: Record<string, HistoryResult>
  enrollment: Enrollment | null
  onPatch: (p: Partial<ModelConfig>) => void
  onReset: () => void
  onBack: () => void
  onSwitch: (id: string) => void
  onResult: (res: PortfolioResult, histories: Record<string, HistoryResult>) => void
  onEnroll: (e: Enrollment) => void
  onUnenroll: () => void
}

export function ModelDetail({
  modelId,
  cfg,
  result,
  histories,
  enrollment,
  onPatch,
  onReset,
  onBack,
  onSwitch,
  onResult,
  onEnroll,
  onUnenroll,
}: Props) {
  const meta = modelMeta(modelId)
  const isAlgo = meta.type === 'algo'
  const isRot = meta.type === 'rotation'
  const doc = findDoc(modelId)

  const [busy, setBusy] = useState(false)
  const [runError, setRunError] = useState<string | null>(null)
  const [loadNotes, setLoadNotes] = useState<string[]>([])

  const patchSettings = (p: Partial<SimSettings>) => onPatch({ settings: { ...cfg.settings, ...p } })
  const setNum = (key: keyof SimSettings, fallback: number) => (e: React.ChangeEvent<HTMLInputElement>) =>
    patchSettings({ [key]: num(e.target.value, fallback) })

  async function run() {
    if (cfg.symbols.length === 0) {
      setRunError('유니버스에 종목을 1개 이상 추가하세요')
      return
    }
    setBusy(true)
    setRunError(null)
    const notes: string[] = []
    try {
      const loaded: Record<string, HistoryResult> = {}
      for (const sym of cfg.symbols) {
        try {
          loaded[sym] = await getDailyHistory(sym, cfg.range)
          if (loaded[sym].stale) notes.push(`${sym}: 캐시 사용(갱신 실패)`)
        } catch (e) {
          notes.push(`${sym}: 로드 실패 — 제외됨 (${String((e as Error).message ?? e)})`)
        }
      }
      setLoadNotes(notes)
      const res = runPortfolio(modelId, cfg, loaded)
      onResult(res, loaded)
    } catch (e) {
      setRunError(String((e as Error).message ?? e))
    } finally {
      setBusy(false)
    }
  }

  const m = result?.metrics
  const adv = result?.advanced
  const hasLeveraged = cfg.symbols.some((s) => LEVERAGED.has(s))
  const hasForeign = cfg.symbols.some((s) => !s.endsWith('.KS') && !s.startsWith('^KS'))
  const mixed = hasForeign && cfg.symbols.some((s) => s.endsWith('.KS') || s.startsWith('^KS'))

  return (
    <div>
      <div className="bt-detail-head">
        <button type="button" className="bt-btn-mini" onClick={onBack}>
          ← 모델 보드
        </button>
        <h3>
          {meta.name} <span className="bt-card-stage">백테스트 단계</span>
        </h3>
        <span className={`bt-card-type ${meta.type}`}>
          {meta.type === 'rule' ? '규칙형' : meta.type === 'algo' ? '자금관리' : '종목선정'}
        </span>
      </div>

      {/* 다른 기법으로 바로 전환 — 보드를 거치지 않는다 */}
      <div className="bt-switcher">
        <span className="bt-switcher-label">기법 전환</span>
        {MODEL_META.map((m) => (
          <button
            key={m.id}
            type="button"
            className={`bt-model-btn${m.id === modelId ? ' active' : ''}${m.type !== 'rule' ? ` ${m.type}` : ''}`}
            onClick={() => onSwitch(m.id)}
          >
            {m.short}
          </button>
        ))}
      </div>

      <div className="bt-strategy-desc bt-model-desc">{meta.desc}</div>

      {doc && (
        <details className="bt-doc" open>
          <summary>📖 투자 철학 · 사용법 · 매수매도 규칙 (이 기법 완전 설명)</summary>
          <div className="bt-doc-body">
            {doc.sections.map((sec) => (
              <div key={sec.h} className="bt-doc-sec">
                <h4>{sec.h}</h4>
                <ul>
                  {sec.lines.map((line, i) => (
                    <li key={i}>{line}</li>
                  ))}
                </ul>
              </div>
            ))}
            <div className="bt-chart-caption">
              위 설명은 정보·교육 목적이며 투자자문·매매 권유가 아닙니다. 어떤 기법도 손실을 막아주지 못하며, 과거
              성과는 미래를 보장하지 않습니다.
            </div>
          </div>
        </details>
      )}

      <UniverseEditor symbols={cfg.symbols} onChange={(symbols) => onPatch({ symbols })} isPool={isRot} />
      {hasLeveraged && (
        <div className="bt-warn bt-lev-warn">
          ⚠️ 유니버스에 레버리지 ETF 포함 — 변동성 잠식으로 장기 성과가 기초지수와 크게 괴리될 수 있고, 하락장에서
          −80~90%대 낙폭이 실제 발생한 상품군입니다(SOXL 2022년 약 −91%).
        </div>
      )}
      {mixed && (
        <div className="bt-chart-caption">
          ℹ️ 국장·미장 혼합 유니버스 — 각 종목은 현지통화 수익률 기준으로 균등가중 합산되며 환율 변동 손익은 반영되지
          않습니다. 거래세는 한국 상장 종목에만 해당(설정값이 전 종목에 일괄 적용되는 근사).
        </div>
      )}

      <div className="bt-controls">
        <label>
          데이터 범위
          <select value={cfg.range} onChange={(e) => onPatch({ range: e.target.value as ModelConfig['range'] })}>
            <option value="5y">5년</option>
            <option value="10y">10년</option>
            <option value="max">전체</option>
          </select>
        </label>
        <label>
          시뮬레이션 시작일
          <InfoTip text="이 날짜 이전 데이터는 지표 계산용 과거로만 쓰이고, 이후 구간을 하루씩 전진하며 그 시점까지의 정보만으로 판단합니다. 비우면 각 종목 데이터의 중간 지점부터 시작합니다." />
          <input type="date" value={cfg.startDate} onChange={(e) => onPatch({ startDate: e.target.value })} />
        </label>
      </div>

      {/* ---- 조건/파라미터 ---- */}
      <div className="bt-strategy">
        {meta.type === 'rule' && cfg.strategy && (
          <>
            <ConditionEditor
              label="🟢 매수 조건"
              combinator="AND"
              conditions={cfg.strategy.buy}
              onChange={(buy) => onPatch({ strategy: { ...cfg.strategy!, buy } })}
            />
            <ConditionEditor
              label="🔵 매도 조건"
              combinator="OR"
              conditions={cfg.strategy.sell}
              onChange={(sell) => onPatch({ strategy: { ...cfg.strategy!, sell } })}
            />
            <div className="bt-actions" style={{ margin: '8px 0 0' }}>
              <button type="button" className="bt-btn-mini" onClick={() => onPatch({ strategy: clonePreset(modelId) })}>
                ↺ 조건 기본값 복원
              </button>
            </div>
          </>
        )}

        {modelId === 'infinite-buying' && (
          <div className="bt-controls bt-algo-params">
            <label>
              분할 수 (T)
              <input type="number" min={2} max={200} value={(cfg.ib ?? DEFAULT_IB_PARAMS).splits} onChange={(e) => onPatch({ ib: { ...(cfg.ib ?? DEFAULT_IB_PARAMS), splits: num(e.target.value, 40) } })} />
            </label>
            <label>
              목표 수익률 % (평단 대비)
              <input type="number" min={1} max={100} step={0.5} value={(cfg.ib ?? DEFAULT_IB_PARAMS).targetPct} onChange={(e) => onPatch({ ib: { ...(cfg.ib ?? DEFAULT_IB_PARAMS), targetPct: num(e.target.value, 10) } })} />
            </label>
            <label>
              사이클 손절 % (0=없음, v1 기본)
              <input
                type="number"
                min={0}
                max={90}
                value={(cfg.ib ?? DEFAULT_IB_PARAMS).cycleStopPct ?? 0}
                onChange={(e) => onPatch({ ib: { ...(cfg.ib ?? DEFAULT_IB_PARAMS), cycleStopPct: num(e.target.value, 0) > 0 ? num(e.target.value, 0) : null } })}
              />
            </label>
          </div>
        )}

        {modelId === 'value-rebalancing' && (
          <div className="bt-controls bt-algo-params">
            <label>
              리밸런싱 주기 (거래일)
              <input type="number" min={1} max={60} value={(cfg.vr ?? DEFAULT_VR_PARAMS).periodDays} onChange={(e) => onPatch({ vr: { ...(cfg.vr ?? DEFAULT_VR_PARAMS), periodDays: num(e.target.value, 10) } })} />
            </label>
            <label>
              V값 성장률 %/주기
              <input type="number" min={0} max={10} step={0.1} value={(cfg.vr ?? DEFAULT_VR_PARAMS).growthPct} onChange={(e) => onPatch({ vr: { ...(cfg.vr ?? DEFAULT_VR_PARAMS), growthPct: num(e.target.value, 1) } })} />
            </label>
            <label>
              밴드 폭 ±%
              <input type="number" min={1} max={50} value={(cfg.vr ?? DEFAULT_VR_PARAMS).bandPct} onChange={(e) => onPatch({ vr: { ...(cfg.vr ?? DEFAULT_VR_PARAMS), bandPct: num(e.target.value, 15) } })} />
            </label>
            <label>
              초기 주식 비중 %
              <input type="number" min={10} max={100} value={(cfg.vr ?? DEFAULT_VR_PARAMS).initialStockPct} onChange={(e) => onPatch({ vr: { ...(cfg.vr ?? DEFAULT_VR_PARAMS), initialStockPct: num(e.target.value, 75) } })} />
            </label>
          </div>
        )}

        {isRot && (
          <div className="bt-controls bt-algo-params">
            <label>
              보유 종목 수 (Top-N)
              <InfoTip text="순위 상위 몇 종목을 들고 갈지. 1이면 가장 강한 하나에 집중(수익·변동성 모두 큼), 3~5면 분산됩니다." />
              <input type="number" min={1} max={20} value={(cfg.rot ?? DEFAULT_ROTATION).topN}
                onChange={(e) => onPatch({ rot: { ...(cfg.rot ?? DEFAULT_ROTATION), topN: num(e.target.value, 1) } })} />
            </label>
            <label>
              점수 측정 기간 (거래일)
              <InfoTip text="252 ≈ 12개월. 모멘텀 연구에서 가장 많은 사후검증 근거를 가진 기간입니다. 짧게 잡으면 반응이 빠르지만 매매가 늘고 소음에 흔들립니다." />
              <input type="number" min={20} max={504} value={(cfg.rot ?? DEFAULT_ROTATION).lookbackDays}
                onChange={(e) => onPatch({ rot: { ...(cfg.rot ?? DEFAULT_ROTATION), lookbackDays: num(e.target.value, 252) } })} />
            </label>
            <label>
              최근 제외 (거래일)
              <InfoTip text="21 ≈ 1개월. 직전 1개월을 점수에서 빼는 관행(12-1 모멘텀) — 단기 반전 효과에 당하지 않기 위함입니다. 0이면 최근까지 전부 반영." />
              <input type="number" min={0} max={63} value={(cfg.rot ?? DEFAULT_ROTATION).skipDays}
                onChange={(e) => onPatch({ rot: { ...(cfg.rot ?? DEFAULT_ROTATION), skipDays: num(e.target.value, 21) } })} />
            </label>
            <label>
              리밸런싱 주기 (거래일)
              <input type="number" min={5} max={252} value={(cfg.rot ?? DEFAULT_ROTATION).rebalanceDays}
                onChange={(e) => onPatch({ rot: { ...(cfg.rot ?? DEFAULT_ROTATION), rebalanceDays: num(e.target.value, 21) } })} />
            </label>
            <label>
              점수 방식
              <select value={(cfg.rot ?? DEFAULT_ROTATION).scoreMethod}
                onChange={(e) => onPatch({ rot: { ...(cfg.rot ?? DEFAULT_ROTATION), scoreMethod: e.target.value as 'momentum' | 'sharpe' } })}>
                <option value="momentum">수익률 (모멘텀)</option>
                <option value="sharpe">위험조정 수익률</option>
              </select>
            </label>
            <label>
              하락 방어 필터
              <InfoTip text="후보가 이 조건을 못 넘으면 아예 사지 않고 그 몫을 현금으로 둡니다. 하락장에서 손실을 줄이는 핵심 장치입니다." />
              <select value={(cfg.rot ?? DEFAULT_ROTATION).absoluteFilter}
                onChange={(e) => onPatch({ rot: { ...(cfg.rot ?? DEFAULT_ROTATION), absoluteFilter: e.target.value as 'none' | 'positive' | 'aboveSMA' } })}>
                <option value="none">없음</option>
                <option value="positive">수익률 양수일 때만 (절대 모멘텀)</option>
                <option value="aboveSMA">이동평균선 위일 때만</option>
              </select>
            </label>
            {(cfg.rot ?? DEFAULT_ROTATION).absoluteFilter === 'aboveSMA' && (
              <label>
                이평 기간
                <input type="number" min={20} max={300} value={(cfg.rot ?? DEFAULT_ROTATION).absSmaPeriod}
                  onChange={(e) => onPatch({ rot: { ...(cfg.rot ?? DEFAULT_ROTATION), absSmaPeriod: num(e.target.value, 200) } })} />
              </label>
            )}
            <label className="bt-check">
              <input type="checkbox" checked={(cfg.rot ?? DEFAULT_ROTATION).trendTemplate}
                onChange={(e) => onPatch({ rot: { ...(cfg.rot ?? DEFAULT_ROTATION), trendTemplate: e.target.checked } })} />
              미너비니 추세 템플릿 적용
              <InfoTip text="50·150·200일선 정렬, 200일선 상승, 52주 최저 대비 +30% 이상, 52주 최고 대비 -25% 이내 등 7개 조건을 모두 통과한 종목만 후보로 남깁니다." />
            </label>
          </div>
        )}

        {isRot && (
          <div className="bt-chart-caption">
            로테이션형은 <strong>후보 풀에서 모델이 스스로 종목을 고릅니다</strong> — 위 유니버스는 "살 수 있는
            후보 목록"이지 보유 종목이 아닙니다. 벤치마크는 <strong>후보 풀 전체 균등보유</strong>이므로, 초과수익이
            양수라면 "고른 것"이 "다 들고 있는 것"보다 나았다는 뜻입니다. 설정의 진입비중·손절·익절은 적용되지
            않습니다(Top-N 균등배분).
          </div>
        )}

        {isAlgo && (
          <div className="bt-chart-caption">
            자금관리 알고리즘은 자체 분할·리밸런싱 규칙을 사용하므로 아래 설정의 진입 비중·손절·익절은 적용되지
            않습니다(초기자본·수수료·거래세·슬리피지만 적용).
          </div>
        )}
      </div>

      {/* ---- 자금 · 비용 ---- */}
      <div className="bt-controls bt-settings">
        <label>
          초기자본 (전 종목 균등분할)
          <input type="number" min={1000} step={1000000} value={cfg.settings.initialCapital} onChange={setNum('initialCapital', 10_000_000)} />
        </label>
        {!isAlgo && (
          <label>
            진입 비중 % (슬리브당)
            <input type="number" min={1} max={100} value={cfg.settings.positionPct} onChange={setNum('positionPct', 50)} />
          </label>
        )}
        <label>
          수수료 %(편도)
          <input type="number" min={0} step={0.005} value={cfg.settings.commissionPct} onChange={setNum('commissionPct', 0.015)} />
        </label>
        <label>
          거래세 %(매도)
          <input type="number" min={0} step={0.05} value={cfg.settings.sellTaxPct} onChange={setNum('sellTaxPct', 0.15)} />
        </label>
        <label>
          슬리피지 %
          <input type="number" min={0} step={0.05} value={cfg.settings.slippagePct} onChange={setNum('slippagePct', 0.1)} />
        </label>
        {!isAlgo && (
          <>
            <label>
              손절 %
              <input
                type="number"
                min={0}
                max={50}
                value={cfg.settings.stopLossPct ?? 0}
                onChange={(e) => patchSettings({ stopLossPct: num(e.target.value, 0) > 0 ? num(e.target.value, 0) : null })}
              />
            </label>
            <label>
              익절 %
              <input
                type="number"
                min={0}
                max={200}
                value={cfg.settings.takeProfitPct ?? 0}
                onChange={(e) => patchSettings({ takeProfitPct: num(e.target.value, 0) > 0 ? num(e.target.value, 0) : null })}
              />
            </label>
          </>
        )}
      </div>

      <div className="bt-actions">
        <button type="button" className="bt-btn-run" onClick={run} disabled={busy}>
          {busy ? '⏳ 데이터 로드·실행 중…' : `▶ ${meta.short} 평가 실행`}
        </button>
        <button type="button" className="bt-btn-mini" onClick={onReset}>
          ↺ 이 모델 설정 초기화
        </button>
        {!isAlgo && cfg.settings.stopLossPct == null && (
          <span className="bt-warn">⚠️ 손절 미설정 — 최대 낙폭이 크게 확대될 수 있습니다</span>
        )}
        {modelId === 'infinite-buying' && (cfg.ib ?? DEFAULT_IB_PARAMS).cycleStopPct == null && (
          <span className="bt-warn">⚠️ 사이클 손절 없음(v1 기본) — 장기 하락장에서 원금 대부분이 묶일 수 있습니다</span>
        )}
      </div>
      {runError && <div className="news-empty err">{runError}</div>}
      {loadNotes.length > 0 && (
        <div className="bt-chart-caption">{loadNotes.join(' · ')}</div>
      )}

      {result && m && adv && (
        <div className="bt-results">
          <div className="bt-data-info">
            평가 구간 <strong>{result.startDate} ~ {result.endDate}</strong> · 유니버스{' '}
            {result.universe.map((s) => symbolLabel(s)).join(' · ')} ({result.universe.length}종목 균등분할)
          </div>

          <DataProvenance histories={histories} />

          <LiveTracking
            modelId={modelId}
            cfg={cfg}
            result={result}
            histories={histories}
            enrollment={enrollment}
            onEnroll={onEnroll}
            onUnenroll={onUnenroll}
          />

          <div className="kpi-row">
            <KpiCard
              label="총 수익률"
              value={fmtPct(m.totalReturnPct)}
              changeText={`단순보유 ${fmtPct(m.benchmarkReturnPct)}`}
              changeLabel="벤치마크"
              direction={m.totalReturnPct > m.benchmarkReturnPct ? 'up' : 'down'}
            />
            <KpiCard label="연환산(CAGR)" value={fmtPct(m.cagrPct)} changeText={`변동성 ${fmtPct(adv.volPct, 0)}`} changeLabel="연환산" direction="flat" />
            <KpiCard
              label="최대 낙폭(MDD)"
              value={fmtPct(m.mddPct)}
              changeText={`최장 ${adv.maxUnderwaterDays}거래일 수면 아래`}
              changeLabel=""
              direction="flat"
              info="고점 대비 최대 하락률과, 이전 고점을 회복하지 못한 최장 기간. 수익률보다 먼저 견딜 수 있는 낙폭인지 확인하세요."
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
          <div className="kpi-row">
            <KpiCard label="샤프" value={m.sharpe.toFixed(2)} changeText="총변동성 대비 초과수익" changeLabel="" direction="flat" info="일간 수익률 평균÷표준편차를 연환산. 1 이상이면 위험 대비 수익이 준수하다고 봅니다." />
            <KpiCard label="소르티노" value={adv.sortino.toFixed(2)} changeText="하락변동성만 벌점" changeLabel="" direction="flat" info="샤프와 달리 하락 변동성만 위험으로 칩니다. 상승 변동이 큰 전략에 유리한 관점." />
            <KpiCard label="칼마" value={adv.calmar != null ? adv.calmar.toFixed(2) : '—'} changeText="CAGR ÷ |MDD|" changeLabel="" direction="flat" info="연수익률을 최대낙폭으로 나눈 값. 낙폭 대비 수익 효율 — 높을수록 같은 고통으로 더 벌었다는 뜻." />
            <KpiCard
              label="월 승률 · 연도 초과"
              value={`${adv.monthlyWinRatePct.toFixed(0)}%`}
              unit={` · ${adv.yearsBeatBench}`}
              changeText={`최고월 ${fmtPct(adv.bestMonthPct)} · 최악월 ${fmtPct(adv.worstMonthPct)}`}
              changeLabel=""
              direction="flat"
              info="월간 수익이 플러스인 달의 비율, 그리고 연도별로 벤치마크(단순보유)를 이긴 횟수. 특정 구간 한 방이 아니라 꾸준했는지를 보는 일관성 지표입니다."
            />
          </div>

          <EquityChart equity={result.equity} />

          {/* 연도별 일관성 */}
          <div className="bt-table-wrap" style={{ marginTop: 12 }}>
            <table>
              <thead>
                <tr>
                  <th>연도</th>
                  {result.advanced.yearly.map((y) => (
                    <th key={y.year}>{y.year}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>전략</td>
                  {result.advanced.yearly.map((y) => (
                    <td key={y.year} className={y.retPct >= 0 ? 'bt-pos' : 'bt-neg'}>
                      {fmtPct(y.retPct, 0)}
                    </td>
                  ))}
                </tr>
                <tr className="bt-bench-row">
                  <td>단순보유</td>
                  {result.advanced.yearly.map((y) => (
                    <td key={y.year}>{fmtPct(y.benchRetPct, 0)}</td>
                  ))}
                </tr>
              </tbody>
            </table>
          </div>
          <div className="bt-chart-caption">
            연도별 수익률 — 한 해의 대박이 아니라 여러 구간에서 꾸준히 벤치마크를 이겼는지 보세요. 과거 일관성도 미래를
            보장하지는 않습니다.
          </div>

          {/* 종목(슬리브)별 기여 */}
          <div className="bt-table-wrap" style={{ marginTop: 12 }}>
            <table>
              <thead>
                <tr>
                  <th>종목</th>
                  <th>수익률</th>
                  <th>단순보유</th>
                  <th>MDD</th>
                  <th>매매</th>
                  <th>승률</th>
                </tr>
              </thead>
              <tbody>
                {result.sleeves.map((s) => (
                  <tr key={s.symbol}>
                    <td>
                      {symbolLabel(s.symbol)} <code>{s.symbol}</code>
                    </td>
                    <td className={s.res.metrics.totalReturnPct >= 0 ? 'bt-pos' : 'bt-neg'}>
                      {fmtPct(s.res.metrics.totalReturnPct)}
                    </td>
                    <td>{fmtPct(s.res.metrics.benchmarkReturnPct)}</td>
                    <td>{fmtPct(s.res.metrics.mddPct)}</td>
                    <td>{s.res.metrics.tradeCount > 0 ? s.res.metrics.tradeCount : '—'}</td>
                    <td>{s.res.metrics.tradeCount > 0 ? `${s.res.metrics.winRatePct.toFixed(0)}%` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {result.trades.length > 0 && (
            <details className="bt-trades">
              <summary>매매/사이클 내역 {result.trades.length}건</summary>
              <div className="bt-table-wrap bt-events">
                <table>
                  <thead>
                    <tr>
                      <th>종목</th>
                      <th>진입일</th>
                      <th>진입가</th>
                      <th>수량</th>
                      <th>청산일</th>
                      <th>청산가</th>
                      <th>수익률</th>
                      <th>사유</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.trades.slice(-400).map((t, i) => (
                      <tr key={i}>
                        <td>{t.symbol ?? '—'}</td>
                        <td>{t.entryDate}</td>
                        <td>{t.entryPrice.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
                        <td>{t.qty.toLocaleString()}</td>
                        <td>{t.exitDate ?? '—'}</td>
                        <td>{t.exitPrice != null ? t.exitPrice.toLocaleString(undefined, { maximumFractionDigits: 2 }) : '—'}</td>
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

          {result.events.length > 0 && (
            <details className="bt-trades">
              <summary>체결 이벤트 {result.events.length.toLocaleString()}건 (최근 300건 표시)</summary>
              <div className="bt-table-wrap bt-events">
                <table>
                  <thead>
                    <tr>
                      <th>일자</th>
                      <th>종목</th>
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
                        <td>{ev.symbol ?? '—'}</td>
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
    </div>
  )
}
