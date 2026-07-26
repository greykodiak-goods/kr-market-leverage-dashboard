// 모델 스펙 동결(freeze) · 지문(fingerprint) · 등록(enroll).
//
// 재현성 원칙: 모델은 "언제든 복제 가능하고, 명확한 기준으로 설명되며, 같은
// 입력이면 항상 같은 결과"여야 한다. 이를 위해
//  1) 모델의 모든 결정 변수(유니버스·규칙·파라미터·비용·시작일)를 하나의
//     정규화된 스펙 JSON으로 직렬화하고,
//  2) 그 JSON에서 결정적 지문(해시)을 뽑는다.
// 스펙이 한 글자라도 바뀌면 지문이 바뀐다 = "다른 모델"이다. 모의운용 등록
// 후 스펙을 고치면 지문 불일치로 화면에 경고가 뜨고, 성적을 이어붙일 수 없다
// (사후 조정으로 성적을 예쁘게 만드는 커브피팅 차단).
//
// 모의운용 성적은 별도 저널에 "쌓지" 않는다 — 규칙이 결정적이고 데이터가
// 재조회 가능하므로, 등록일부터 오늘까지 매번 재계산하면 항상 같은 값이
// 나온다. 저장된 기록이 없으니 조작·유실·드리프트가 원천적으로 불가능하다.

import type { ModelConfig } from './models'
import { modelMeta } from './models'
import { conditionText } from './explain'
import { DEFAULT_IB_PARAMS, DEFAULT_VR_PARAMS } from './algoEngine'

export const SPEC_VERSION = 1

export interface ModelSpec {
  specVersion: number
  modelId: string
  modelName: string
  engine: 'rule' | 'infinite-buying' | 'value-rebalancing'
  universe: string[]
  dataRange: ModelConfig['range']
  simStartDate: string
  costs: {
    initialCapital: number
    positionPct: number
    commissionPct: number
    sellTaxPct: number
    slippagePct: number
    stopLossPct: number | null
    takeProfitPct: number | null
  }
  rules: {
    buy?: string[] // 사람이 읽는 규칙 (설명용)
    sell?: string[]
    params?: Record<string, number | null> // 알고리즘 파라미터
    raw?: unknown // 기계 재현용 원본
  }
  execution: {
    signal: string
    fill: string
    lookahead: string
  }
}

// 키 순서에 의존하지 않는 정규화 직렬화 (지문 안정성).
function canonical(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v)
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`
  const o = v as Record<string, unknown>
  const keys = Object.keys(o).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`
}

// FNV-1a 32bit — 결정적이고 동기적. 충돌 저항이 필요한 보안 용도가 아니라
// "설정이 바뀌었는지" 감지용이므로 충분하다.
export function fingerprint(spec: ModelSpec): string {
  const s = canonical(spec)
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0').toUpperCase()
}

export function buildSpec(modelId: string, cfg: ModelConfig): ModelSpec {
  const meta = modelMeta(modelId)
  const engine =
    modelId === 'infinite-buying' ? 'infinite-buying' : modelId === 'value-rebalancing' ? 'value-rebalancing' : 'rule'

  const rules: ModelSpec['rules'] = {}
  if (engine === 'rule' && cfg.strategy) {
    rules.buy = cfg.strategy.buy.map(conditionText)
    rules.sell = cfg.strategy.sell.map(conditionText)
    rules.raw = { buy: cfg.strategy.buy, sell: cfg.strategy.sell }
  } else if (engine === 'infinite-buying') {
    const p = cfg.ib ?? DEFAULT_IB_PARAMS
    rules.params = { 분할수: p.splits, 목표수익률Pct: p.targetPct, 사이클손절Pct: p.cycleStopPct }
    rules.raw = p
  } else {
    const p = cfg.vr ?? DEFAULT_VR_PARAMS
    rules.params = { 주기거래일: p.periodDays, V성장률Pct: p.growthPct, 밴드Pct: p.bandPct, 초기주식비중Pct: p.initialStockPct }
    rules.raw = p
  }

  return {
    specVersion: SPEC_VERSION,
    modelId,
    modelName: meta.name,
    engine,
    universe: [...cfg.symbols].sort(),
    dataRange: cfg.range,
    simStartDate: cfg.startDate || '(데이터 중간지점 자동)',
    costs: {
      initialCapital: cfg.settings.initialCapital,
      positionPct: cfg.settings.positionPct,
      commissionPct: cfg.settings.commissionPct,
      sellTaxPct: cfg.settings.sellTaxPct,
      slippagePct: cfg.settings.slippagePct,
      stopLossPct: cfg.settings.stopLossPct,
      takeProfitPct: cfg.settings.takeProfitPct,
    },
    rules,
    execution: {
      signal: engine === 'rule' ? '당일 종가 기준 판정' : '당일 종가 LOC(원저 방식)',
      fill: engine === 'rule' ? '익일 시가 + 슬리피지' : '당일 종가 + 슬리피지 (목표매도는 지정가)',
      lookahead: '각 시점에서 이후 데이터 미참조 (워크포워드)',
    },
  }
}

// ---- 모의운용 등록 ---------------------------------------------------------
export interface Enrollment {
  modelId: string
  fingerprint: string
  spec: ModelSpec
  enrolledAt: string // YYYY-MM-DD — 이 날짜 이후가 사후검증(out-of-sample) 구간
  note: string
}

const ENROLL_KEY = 'bt-enrollments-v1'

export function loadEnrollments(): Record<string, Enrollment> {
  try {
    return JSON.parse(localStorage.getItem(ENROLL_KEY) ?? '{}')
  } catch {
    return {}
  }
}

export function saveEnrollments(e: Record<string, Enrollment>) {
  try {
    localStorage.setItem(ENROLL_KEY, JSON.stringify(e))
  } catch {
    /* ignore */
  }
}

export function todayISO(): string {
  return new Date().toISOString().slice(0, 10)
}
