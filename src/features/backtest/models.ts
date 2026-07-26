// 모델 레지스트리 + 모델별 독립 설정(유니버스·기간·변수) 저장.
//
// 플랫폼 관점: 모델 1개 = 가상 투자자 1명. 각 모델은 자기 유니버스(국장·미장
// 혼합 가능한 여러 종목)를 자기 규칙으로 운용하고, 그 트랙레코드를 지표로
// 평가받는다. 단계: 백테스트 → 모의운용 → 대표 검토 → 실계좌(대표 직접).
// 실계좌 연동·자동매매 파이프라인은 이 코드베이스에서 만들지 않는다(T0 —
// 대표 본인만 진행 가능).

import { PRESET_STRATEGIES, clonePreset } from './strategies'
import { DEFAULT_IB_PARAMS, DEFAULT_VR_PARAMS, type InfiniteBuyingParams, type VRParams } from './algoEngine'
import { DEFAULT_ROTATION, type RotationParams } from './rotation'
import { DEFAULT_SETTINGS, type SimSettings, type StrategyConfig } from './types'
import type { HistoryRange } from '../../lib/history'

export type ModelType = 'rule' | 'algo' | 'rotation'

export interface ModelMeta {
  id: string
  name: string
  short: string
  type: ModelType
  desc: string
  defaultSymbols: string[]
  defaultTaxZero?: boolean // 기본 유니버스가 해외 상장이라 거래세 0 시작
  rotation?: RotationParams // type==='rotation'일 때 기본 파라미터
}

export const MODEL_META: ModelMeta[] = [
  ...PRESET_STRATEGIES.map((s) => ({
    id: s.id,
    name: s.name,
    short:
      (
        {
          'golden-cross': '골든크로스',
          'rsi-reversal': 'RSI 반등',
          'bollinger-meanrev': '볼린저 회귀',
          breakout: '신고가 돌파',
          'macd-momentum': 'MACD 모멘텀',
          'trend-filter-cross': '추세+크로스',
        } as Record<string, string>
      )[s.id] ?? s.name,
    type: 'rule' as const,
    desc: s.desc,
    defaultSymbols: ['000660.KS', '005930.KS', 'QQQ'],
  })),
  {
    id: 'infinite-buying',
    name: '라오어 무한매수법 (근사)',
    short: '무한매수법',
    type: 'algo',
    desc: '원금을 T분할(기본 40)해 매일 정액 0.5회분 + 종가가 평단 아래면 0.5회분 추가로 LOC 매수, 평단 +10% 지정가 전량 매도 후 재시작하는 분할매수 모델(v1 근사). 원금 소진 시 신규매수를 멈추고 목표 대기. 사이클 종료 시 현금 전액이 다음 원금(복리). SOXL 기준이 원저 세팅.',
    defaultSymbols: ['SOXL'],
    defaultTaxZero: true,
  },
  {
    id: 'value-rebalancing',
    name: '라오어 VR 밸류 리밸런싱 (근사)',
    short: 'VR 리밸런싱',
    type: 'algo',
    desc: '자본의 일부(기본 75%)로 편입 후 V값을 주기(기본 10거래일)마다 g%(기본 1%) 성장시키고, 평가금이 밴드(±15%)를 벗어나면 V값까지 매도/매수해 현금 풀과 교환하는 장기 적립형 모델(근사). 추가 입금은 없다고 가정. TQQQ 기준이 원저 세팅.',
    defaultSymbols: ['TQQQ'],
    defaultTaxZero: true,
  },
  {
    id: 'dual-momentum',
    name: '듀얼 모멘텀 (Antonacci GEM)',
    short: '듀얼모멘텀',
    type: 'rotation',
    desc: 'Gary Antonacci의 Global Equity Momentum. 후보 자산의 12개월 수익률을 비교해 가장 강한 하나만 보유하되(상대 모멘텀), 그것조차 수익률이 마이너스면 전부 현금으로 물러난다(절대 모멘텀). 월 1회 판단하며, 종목을 우리가 고르지 않고 순위가 정한다.',
    defaultSymbols: ['SPY', 'QQQ', '069500.KS', 'GLD', 'TLT'],
    defaultTaxZero: true,
    rotation: { ...DEFAULT_ROTATION, lookbackDays: 252, skipDays: 0, topN: 1, rebalanceDays: 21, absoluteFilter: 'positive' },
  },
  {
    id: 'rs-rotation',
    name: '상대강도 섹터 로테이션 (Top-N)',
    short: 'RS 로테이션',
    type: 'rotation',
    desc: '후보 풀을 최근 6개월 수익률(최근 1개월 제외)로 줄 세워 상위 N개만 보유하고 월 1회 교체합니다. 200일선 아래 종목은 아예 후보에서 제외해 하락 자산을 걸러냅니다. Jegadeesh–Titman 모멘텀 연구 계열의 표준 구현입니다.',
    defaultSymbols: ['XLK', 'SMH', 'XLV', 'XLF', 'XLE', 'XLY', 'XLI', 'QQQ'],
    defaultTaxZero: true,
    rotation: { ...DEFAULT_ROTATION, lookbackDays: 126, skipDays: 21, topN: 3, rebalanceDays: 21, absoluteFilter: 'aboveSMA', absSmaPeriod: 200 },
  },
  {
    id: 'trend-template',
    name: '미너비니 추세 템플릿 (종목선정)',
    short: '추세템플릿',
    type: 'rotation',
    desc: "Mark Minervini의 Trend Template — 50·150·200일선 정렬, 200일선 상승, 52주 최저 대비 +30% 이상, 52주 최고 대비 -25% 이내 등 7개 절대 조건을 모두 통과한 종목만 후보로 남기고, 그중 상대강도 상위 N개를 보유합니다. '강한 종목만 산다'는 선별이 핵심입니다.",
    defaultSymbols: ['NVDA', 'AVGO', 'MSFT', 'AAPL', 'AMD', 'META', '000660.KS', '005930.KS'],
    defaultTaxZero: true,
    rotation: { ...DEFAULT_ROTATION, lookbackDays: 126, skipDays: 21, topN: 3, rebalanceDays: 21, absoluteFilter: 'none', trendTemplate: true },
  },
  {
    id: 'gtaa',
    name: 'Faber 자산배분 타이밍 (GTAA)',
    short: 'GTAA',
    type: 'rotation',
    desc: 'Meb Faber의 Global Tactical Asset Allocation. 서로 상관이 낮은 자산군(주식·해외·채권·금·리츠)을 각각 200일선(10개월선)과 비교해, 위에 있는 것만 균등 보유하고 아래면 그 몫을 현금으로 뺍니다. 수익 극대화가 아니라 낙폭 축소가 목적인 방어형 모델입니다.',
    defaultSymbols: ['SPY', 'EFA', 'IEF', 'GLD', 'VNQ'],
    defaultTaxZero: true,
    rotation: { ...DEFAULT_ROTATION, lookbackDays: 126, skipDays: 0, topN: 5, rebalanceDays: 21, absoluteFilter: 'aboveSMA', absSmaPeriod: 200 },
  },
]

export const ALL_MODEL_IDS = MODEL_META.map((m) => m.id)

export function modelMeta(id: string): ModelMeta {
  const m = MODEL_META.find((x) => x.id === id)
  if (!m) throw new Error(`unknown model: ${id}`)
  return m
}

// ---- 모델별 설정 -----------------------------------------------------------
export interface ModelConfig {
  symbols: string[] // 유니버스 — 자본을 종목 수만큼 균등 분할(슬리브)해 각 종목 독립 운용
  range: HistoryRange
  startDate: string // '' = 데이터 중간 지점
  settings: SimSettings
  strategy?: StrategyConfig // 규칙형만
  ib?: InfiniteBuyingParams
  vr?: VRParams
  rot?: RotationParams
}

export function defaultConfig(modelId: string): ModelConfig {
  const meta = modelMeta(modelId)
  const settings: SimSettings = { ...DEFAULT_SETTINGS, ...(meta.defaultTaxZero ? { sellTaxPct: 0 } : {}) }
  const base: ModelConfig = { symbols: [...meta.defaultSymbols], range: '10y', startDate: '', settings }
  if (modelId === 'infinite-buying') return { ...base, ib: { ...DEFAULT_IB_PARAMS } }
  if (modelId === 'value-rebalancing') return { ...base, vr: { ...DEFAULT_VR_PARAMS } }
  if (meta.type === 'rotation') return { ...base, rot: { ...(meta.rotation ?? DEFAULT_ROTATION) } }
  return { ...base, strategy: clonePreset(modelId) }
}

const CFG_KEY_V2 = 'bt-model-configs-v2'
const CFG_KEY_V1 = 'bt-model-configs-v1'

export function loadConfigs(): Record<string, ModelConfig> {
  let saved: Partial<Record<string, Partial<ModelConfig> & { symbol?: string; customSymbol?: string }>> = {}
  try {
    const v2 = localStorage.getItem(CFG_KEY_V2)
    if (v2) saved = JSON.parse(v2)
    else {
      // v1(단일 종목) → v2(유니버스) 마이그레이션
      const v1 = JSON.parse(localStorage.getItem(CFG_KEY_V1) ?? '{}')
      for (const [id, c] of Object.entries(v1 as Record<string, { symbol?: string; customSymbol?: string } & Partial<ModelConfig>>)) {
        const sym = (c.customSymbol ?? '').trim() || c.symbol
        saved[id] = { ...c, symbols: sym ? [sym] : undefined }
      }
    }
  } catch {
    /* 손상 저장값 무시 */
  }
  const out: Record<string, ModelConfig> = {}
  for (const id of ALL_MODEL_IDS) {
    const d = defaultConfig(id)
    const s = saved[id] ?? {}
    out[id] = {
      ...d,
      ...s,
      symbols: Array.isArray(s.symbols) && s.symbols.length > 0 ? s.symbols.filter((x): x is string => typeof x === 'string') : d.symbols,
      settings: { ...d.settings, ...(s.settings ?? {}) },
    }
  }
  return out
}

export function saveConfigs(configs: Record<string, ModelConfig>) {
  try {
    localStorage.setItem(CFG_KEY_V2, JSON.stringify(configs))
  } catch {
    /* ignore */
  }
}

// ---- 보드(리더보드) 요약 캐시 ----------------------------------------------
export interface BoardSummary {
  ranAt: number // epoch ms
  universe: string[]
  period: string // '2021-01-04 ~ 2026-07-25'
  totalReturnPct: number
  benchmarkReturnPct: number
  return1yPct: number | null
  bench1yPct: number | null
  oneYearPartial: boolean
  cagrPct: number
  mddPct: number
  sharpe: number
  sortino: number
  calmar: number | null
  volPct: number
  yearsBeatBench: string // '4/6'
}

const BOARD_KEY = 'bt-board-summary-v1'

export function loadBoard(): Record<string, BoardSummary> {
  try {
    return JSON.parse(localStorage.getItem(BOARD_KEY) ?? '{}')
  } catch {
    return {}
  }
}

export function saveBoard(b: Record<string, BoardSummary>) {
  try {
    localStorage.setItem(BOARD_KEY, JSON.stringify(b))
  } catch {
    /* ignore */
  }
}
