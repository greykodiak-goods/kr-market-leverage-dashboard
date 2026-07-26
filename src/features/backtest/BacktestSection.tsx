// 투자봇 시뮬레이터 (백테스트) — 과거 일봉 데이터 위에서 "그 시점에 미래를
// 모른다"는 전제로 전략 모델을 워크포워드 실행한다. 신호는 당일 종가에서
// 판단, 체결은 다음날 시가(규칙형) 또는 당일 종가 LOC(알고리즘형). 모의
// 시뮬레이션 전용 — 실계좌·실주문과 어떤 연결도 없다.
//
// 모델은 상단 버튼으로 선택하며, 종목·기간·시작시점·자금/비용·전략 변수는
// 모델별로 독립 저장된다(localStorage) — 모델을 오가도 각자의 세팅 유지.
// "전체 모델 비교"는 각 모델을 자기 세팅(자기 종목·구간·변수)으로 실행한다.

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
    name: '라오어 무한매수법 (근사)',
    short: '무한매수법',
    desc: '원금을 T분할(기본 40)해 매일 정액 0.5회분 + 종가가 평단 아래면 0.5회분 추가로 LOC 매수, 평단 +10% 지정가 전량 매도 후 재시작하는 분할매수 모델(v1 근사). 원금 소진 시 신규매수를 멈추고 목표 대기. 사이클 종료 시 현금 전액이 다음 원금(복리). SOXL 기준이 원저 세팅.',
    defaultSymbol: 'SOXL',
  },
  {
    id: 'value-rebalancing',
    name: '라오어 VR 밸류 리밸런싱 (근사)',
    short: 'VR 리밸런싱',
    desc: '자본의 일부(기본 75%)로 편입 후 V값을 주기(기본 10거래일)마다 g%(기본 1%) 성장시키고, 평가금이 밴드(±15%)를 벗어나면 V값까지 매도/매수해 현금 풀과 교환하는 장기 적립형 모델(근사). 추가 입금은 없다고 가정. TQQQ 기준이 원저 세팅.',
    defaultSymbol: 'TQQQ',
  },
] as const

const RULE_SHORT: Record<string, string> = {
  'golden-cross': '골든크로스',
  'rsi-reversal': 'RSI 반등',
  'bollinger-meanrev': '볼린저 회귀',
  breakout: '신고가 돌파',
  'macd-momentum': 'MACD 모멘텀',
  'trend-filter-cross': '추세+크로스',
}

const MIN_WARMUP = 120 // bars kept before sim start so 지표(최대 SMA120급) warm-up이 가능

// ---- 모델별 독립 설정 ------------------------------------------------------
interface ModelConfig {
  symbol: string
  customSymbol: string
  range: HistoryRange
  startDate: string // '' = 데이터 중간 지점
  settings: SimSettings
  strategy?: StrategyConfig // 규칙형만
  ib?: InfiniteBuyingParams
  vr?: VRParams
}

function defaultConfig(modelId: string): ModelConfig {
  if (modelId === 'infinite-buying')
    return { symbol: 'SOXL', customSymbol: '', range: '10y', startDate: '', settings: { ...DEFAULT_SETTINGS, sellTaxPct: 0 }, ib: { ...DEFAULT_IB_PARAMS } }
  if (modelId === 'value-rebalancing')
    return { symbol: 'TQQQ', customSymbol: '', range: '10y', startDate: '', settings: { ...DEFAULT_SETTINGS, sellTaxPct: 0 }, vr: { ...DEFAULT_VR_PARAMS } }
  return { symbol: '000660.KS', customSymbol: '', range: '10y', startDate: '', settings: { ...DEFAULT_SETTINGS }, strategy: clonePreset(modelId) }
}

const CFG_KEY = 'bt-model-configs-v1'
const ALL_MODEL_IDS = [...PRESET_STRATEGIES.map((s) => s.id), ...ALGO_MODELS.map((m) => m.id)]

function loadConfigs(): Record<string, ModelConfig> {
  let saved: Partial<Record<string, ModelConfig>> = {}
  try {
    saved = JSON.parse(localStorage.getItem(CFG_KEY) ?? '{}')
  } catch {
    /* 손상된 저장값은 무시 */
  }
  const out: Record<string, ModelConfig> = {}
  for (const id of ALL_MODEL_IDS) out[id] = { ...defaultConfig(id), ...(saved[id] ?? {}) }
  return out
}

function fmtPct(v: number, digits = 1): string {
  return `${v >= 0 ? '+' : ''}${v.toFixed(digits)}%`
}

function num(v: string, fallback: number): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

function computeStartIdx(barsLen: number, bars: { date: string }[], startDate: string): number {
  if (!startDate) return Math.max(MIN_WARMUP, Math.floor(barsLen / 2))
  const i = bars.findIndex((b) => b.date >= startDate)
  if (i < 0) return Math.max(MIN_WARMUP, barsLen - 2)
  return Math.max(MIN_WARMUP, i)
}

function runModelWith(id: string, cfg: ModelConfig, bars: NonNullable<Awaited<ReturnType<typeof getDailyHistory>>['bars']>, startIdx: number): SimResult {
  if (id === 'infinite-buying') return runInfiniteBuying(bars, startIdx, cfg.ib ?? DEFAULT_IB_PARAMS, cfg.settings)
  if (id === 'value-rebalancing') return runValueRebalancing(bars, startIdx, cfg.vr ?? DEFAULT_VR_PARAMS, cfg.settings)
  return runBacktest(bars, startIdx, cfg.strategy ?? clonePreset(id), cfg.settings)
}

interface CompareRow {
  res: SimResult
  symbol: string
  error?: string
  name: string
}

export function BacktestSection() {
  const [configs, setConfigs] = useState<Record<string, ModelConfig>>(loadConfigs)
  const [modelId, setModelId] = useState<string>(PRESET_STRATEGIES[0].id)

  const cfg = configs[modelId]
  const isAlgo = ALGO_MODELS.some((m) => m.id === modelId)
  const algoModel = ALGO_MODELS.find((m) => m.id === modelId)
  const preset = PRESET_STRATEGIES.find((s) => s.id === modelId)
  const activeSymbol = cfg.customSymbol.trim() || cfg.symbol

  function patch(p: Partial<ModelConfig>) {
    setConfigs((prev) => {
      const next = { ...prev, [modelId]: { ...prev[modelId], ...p } }
      try {
        localStorage.setItem(CFG_KEY, JSON.stringify(next))
      } catch {
        /* ignore */
      }
      return next
    })
  }
  const patchSettings = (p: Partial<SimSettings>) => patch({ settings: { ...cfg.settings, ...p } })

  const { data: hist, isLoading, isError, error } = useQuery({
    queryKey: ['history', activeSymbol, cfg.range],
    queryFn: () => getDailyHistory(activeSymbol, cfg.range),
    staleTime: 12 * 60 * 60 * 1000,
    retry: 1,
  })
  const bars = hist?.bars

  const startIdx = useMemo(() => (bars ? computeStartIdx(bars.length, bars, cfg.startDate) : -1), [bars, cfg.startDate])

  const [result, setResult] = useState<SimResult | null>(null)
  const [comparison, setComparison] = useState<CompareRow[] | null>(null)
  const [compareBusy, setCompareBusy] = useState(false)
  const [runError, setRunError] = useState<string | null>(null)

  function selectModel(id: string) {
    setModelId(id)
    setResult(null)
    setRunError(null)
  }

  function run() {
    if (!bars) return
    try {
      setRunError(null)
      setResult(runModelWith(modelId, cfg, bars, startIdx))
      setComparison(null)
    } catch (e) {
      setRunError(String((e as Error).message ?? e))
    }
  }

  // 각 모델을 "자기 세팅"(자기 종목·구간·변수)으로 실행해 나란히 비교한다.
  async function runComparison() {
    setCompareBusy(true)
    setRunError(null)
    try {
      const rows: CompareRow[] = []
      for (const id of ALL_MODEL_IDS) {
        const c = configs[id]
        const name = ALGO_MODELS.find((m) => m.id === id)?.name ?? PRESET_STRATEGIES.find((s) => s.id === id)?.name ?? id
        const sym = c.customSymbol.trim() || c.symbol
        try {
          const h = await getDailyHistory(sym, c.range)
          const sIdx = computeStartIdx(h.bars.length, h.bars, c.startDate)
          rows.push({ res: runModelWith(id, c, h.bars, sIdx), symbol: sym, name })
        } catch (e) {
          rows.push({ res: null as unknown as SimResult, symbol: sym, name, error: String((e as Error).message ?? e) })
        }
      }
      setComparison(rows)
      setResult(null)
    } finally {
      setCompareBusy(false)
    }
  }

  const setNum = (key: keyof SimSettings, fallback: number) => (e: React.ChangeEvent<HTMLInputElement>) =>
    patchSettings({ [key]: num(e.target.value, fallback) })

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
        모델 버튼을 눌러 선택하세요 — 종목·기간·시작시점·전략 변수는 <strong>모델별로 따로 저장</strong>됩니다. 특정
        시점을 잡아 "미래를 모른다"는 전제로 하루씩 전진 실행하며, 과거 성과는 미래 수익을 보장하지 않습니다.
      </div>

      {/* ---- 모델 선택 버튼 ---- */}
      <div className="bt-model-picker">
        <div className="bt-model-group">
          <span className="bt-model-group-label">규칙 기반 (조건 편집형)</span>
          {PRESET_STRATEGIES.map((s) => (
            <button
              key={s.id}
              type="button"
              className={`bt-model-btn${modelId === s.id ? ' active' : ''}`}
              onClick={() => selectModel(s.id)}
            >
              {RULE_SHORT[s.id] ?? s.name}
            </button>
          ))}
        </div>
        <div className="bt-model-group">
          <span className="bt-model-group-label">자금관리 알고리즘 (라오어)</span>
          {ALGO_MODELS.map((s) => (
            <button
              key={s.id}
              type="button"
              className={`bt-model-btn algo${modelId === s.id ? ' active' : ''}`}
              onClick={() => selectModel(s.id)}
            >
              {s.short}
            </button>
          ))}
        </div>
      </div>

      <div className="bt-strategy-desc bt-model-desc">
        <strong>{isAlgo ? algoModel?.name : preset?.name}</strong> — {isAlgo ? algoModel?.desc : preset?.desc}
      </div>

      {/* ---- 데이터 · 기간 (모델별 저장) ---- */}
      <div className="bt-controls">
        <label>
          종목
          <select value={cfg.symbol} onChange={(e) => patch({ symbol: e.target.value, customSymbol: '' })}>
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
            value={cfg.customSymbol}
            onChange={(e) => patch({ customSymbol: e.target.value })}
          />
        </label>
        <label>
          데이터 범위
          <select value={cfg.range} onChange={(e) => patch({ range: e.target.value as HistoryRange })}>
            <option value="5y">5년</option>
            <option value="10y">10년</option>
            <option value="max">전체</option>
          </select>
        </label>
        <label>
          시뮬레이션 시작일
          <input type="date" value={cfg.startDate} onChange={(e) => patch({ startDate: e.target.value })} />
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
                  onClick={() => patch({ startDate: bars[Math.max(MIN_WARMUP, Math.floor((bars.length * p) / 100))].date })}
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
          {isForeign && cfg.settings.sellTaxPct > 0 && (
            <div className="bt-chart-caption">
              ℹ️ 해외 상장 종목에는 한국 증권거래세가 적용되지 않습니다 — 거래세 0% 권장 (현재 {cfg.settings.sellTaxPct}%).
            </div>
          )}

          {/* ---- 조건/파라미터 편집 (모델별 저장) ---- */}
          <div className="bt-strategy">
            {!isAlgo && cfg.strategy && (
              <>
                <ConditionEditor
                  label="🟢 매수 조건"
                  combinator="AND"
                  conditions={cfg.strategy.buy}
                  onChange={(buy) => patch({ strategy: { ...cfg.strategy!, buy } })}
                />
                <ConditionEditor
                  label="🔵 매도 조건"
                  combinator="OR"
                  conditions={cfg.strategy.sell}
                  onChange={(sell) => patch({ strategy: { ...cfg.strategy!, sell } })}
                />
                <div className="bt-actions" style={{ margin: '8px 0 0' }}>
                  <button type="button" className="bt-btn-mini" onClick={() => patch({ strategy: clonePreset(modelId) })}>
                    ↺ 조건 기본값 복원
                  </button>
                </div>
              </>
            )}

            {modelId === 'infinite-buying' && (
              <div className="bt-controls bt-algo-params">
                <label>
                  분할 수 (T)
                  <input type="number" min={2} max={200} value={(cfg.ib ?? DEFAULT_IB_PARAMS).splits} onChange={(e) => patch({ ib: { ...(cfg.ib ?? DEFAULT_IB_PARAMS), splits: num(e.target.value, 40) } })} />
                </label>
                <label>
                  목표 수익률 % (평단 대비)
                  <input type="number" min={1} max={100} step={0.5} value={(cfg.ib ?? DEFAULT_IB_PARAMS).targetPct} onChange={(e) => patch({ ib: { ...(cfg.ib ?? DEFAULT_IB_PARAMS), targetPct: num(e.target.value, 10) } })} />
                </label>
                <label>
                  사이클 손절 % (0=없음, v1 기본)
                  <InfoTip text="평단 대비 하락률이 이 값에 닿으면 사이클 전체를 손절하고 재시작합니다. 원저 v1은 손절 없이 목표 대기지만, 손절 없는 운용은 레버리지 ETF 장기 하락 구간에서 원금 대부분이 물릴 수 있습니다." />
                  <input
                    type="number"
                    min={0}
                    max={90}
                    value={(cfg.ib ?? DEFAULT_IB_PARAMS).cycleStopPct ?? 0}
                    onChange={(e) => patch({ ib: { ...(cfg.ib ?? DEFAULT_IB_PARAMS), cycleStopPct: num(e.target.value, 0) > 0 ? num(e.target.value, 0) : null } })}
                  />
                </label>
              </div>
            )}

            {modelId === 'value-rebalancing' && (
              <div className="bt-controls bt-algo-params">
                <label>
                  리밸런싱 주기 (거래일)
                  <input type="number" min={1} max={60} value={(cfg.vr ?? DEFAULT_VR_PARAMS).periodDays} onChange={(e) => patch({ vr: { ...(cfg.vr ?? DEFAULT_VR_PARAMS), periodDays: num(e.target.value, 10) } })} />
                </label>
                <label>
                  V값 성장률 %/주기
                  <InfoTip text="주기마다 목표 평가금(V값)을 이만큼 키웁니다. 기초자산의 장기 기대성장을 낙관적으로 잡을수록 하락장에서 현금 풀이 빨리 소진됩니다." />
                  <input type="number" min={0} max={10} step={0.1} value={(cfg.vr ?? DEFAULT_VR_PARAMS).growthPct} onChange={(e) => patch({ vr: { ...(cfg.vr ?? DEFAULT_VR_PARAMS), growthPct: num(e.target.value, 1) } })} />
                </label>
                <label>
                  밴드 폭 ±%
                  <input type="number" min={1} max={50} value={(cfg.vr ?? DEFAULT_VR_PARAMS).bandPct} onChange={(e) => patch({ vr: { ...(cfg.vr ?? DEFAULT_VR_PARAMS), bandPct: num(e.target.value, 15) } })} />
                </label>
                <label>
                  초기 주식 비중 %
                  <input type="number" min={10} max={100} value={(cfg.vr ?? DEFAULT_VR_PARAMS).initialStockPct} onChange={(e) => patch({ vr: { ...(cfg.vr ?? DEFAULT_VR_PARAMS), initialStockPct: num(e.target.value, 75) } })} />
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

          {/* ---- 자금 · 비용 · 리스크 (모델별 저장) ---- */}
          <div className="bt-controls bt-settings">
            <label>
              초기자본 ({hist!.currency})
              <input type="number" min={1000} step={1000000} value={cfg.settings.initialCapital} onChange={setNum('initialCapital', 10_000_000)} />
            </label>
            {!isAlgo && (
              <label>
                진입 비중 %
                <InfoTip text="매수 신호 시 현재 자산 중 몇 %를 투입할지 (포지션 사이징). 100% 몰빵은 손실 변동성을 크게 키웁니다." />
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
                  <InfoTip text="진입가 대비 하락 시 자동 손절. 비우면(0) 손절 없음 — 손절 없는 전략은 미완성으로 간주하세요." />
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
            <button type="button" className="bt-btn-run" onClick={run}>
              ▶ {isAlgo ? algoModel?.short : RULE_SHORT[modelId]} 실행
            </button>
            <button type="button" className="bt-btn-run alt" onClick={runComparison} disabled={compareBusy}>
              {compareBusy ? '⏳ 비교 실행 중…' : '⚖ 전체 모델 비교 (각자 세팅)'}
            </button>
            <button
              type="button"
              className="bt-btn-mini"
              onClick={() => {
                const next = { ...configs, [modelId]: defaultConfig(modelId) }
                setConfigs(next)
                try {
                  localStorage.setItem(CFG_KEY, JSON.stringify(next))
                } catch { /* ignore */ }
              }}
            >
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

          {/* ---- 전체 모델 비교 (각 모델 자기 세팅) ---- */}
          {comparison && (
            <div className="bt-results">
              <div className="bt-table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>모델</th>
                      <th>종목</th>
                      <th>구간</th>
                      <th>총수익률</th>
                      <th>단순보유</th>
                      <th>CAGR</th>
                      <th>MDD</th>
                      <th>샤프</th>
                      <th>승률</th>
                      <th>매매</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...comparison]
                      .sort((a, b) => (b.res?.metrics.totalReturnPct ?? -Infinity) - (a.res?.metrics.totalReturnPct ?? -Infinity))
                      .map((row) =>
                        row.error || !row.res ? (
                          <tr key={row.name}>
                            <td>{row.name}</td>
                            <td>{row.symbol}</td>
                            <td colSpan={8} className="bt-neg">
                              실행 실패: {row.error}
                            </td>
                          </tr>
                        ) : (
                          <tr key={row.res.strategyId + row.symbol}>
                            <td>{row.name}</td>
                            <td>{row.symbol}</td>
                            <td>
                              {row.res.startDate} ~ {row.res.endDate}
                            </td>
                            <td className={row.res.metrics.totalReturnPct >= 0 ? 'bt-pos' : 'bt-neg'}>
                              {fmtPct(row.res.metrics.totalReturnPct)}
                            </td>
                            <td className={row.res.metrics.benchmarkReturnPct >= 0 ? 'bt-pos' : 'bt-neg'}>
                              {fmtPct(row.res.metrics.benchmarkReturnPct)}
                            </td>
                            <td>{fmtPct(row.res.metrics.cagrPct)}</td>
                            <td>{fmtPct(row.res.metrics.mddPct)}</td>
                            <td>{row.res.metrics.sharpe.toFixed(2)}</td>
                            <td>{row.res.metrics.tradeCount > 0 ? `${row.res.metrics.winRatePct.toFixed(0)}%` : '—'}</td>
                            <td>{row.res.metrics.tradeCount > 0 ? row.res.metrics.tradeCount : '—'}</td>
                          </tr>
                        ),
                      )}
                  </tbody>
                </table>
              </div>
              <div className="bt-chart-caption">
                각 모델을 <strong>자기 세팅(자기 종목·구간·변수)</strong>으로 실행한 결과입니다. 종목·구간이 다르면
                수익률을 직접 비교하기보다 각 모델의 벤치마크(단순보유) 대비 성과와 MDD를 보세요. 특정 구간의 우위가
                다른 구간·종목에서 재현된다는 보장은 없습니다(과최적화 주의). VR은 라운드트립이 없어 승률·매매를
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
