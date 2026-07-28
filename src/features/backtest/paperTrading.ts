// 페이퍼 트레이딩 저널 — 시그널을 기록하고 가상 잔고·평단·손익을 추적한다.
//
// 규칙 2가 명시적으로 허용하는 범위다:
//   "만들 수 있는 것은 모의 시뮬레이터·분석·**페이퍼 트레이딩**까지이며,
//    실계좌 연동과 집행은 대표 본인이 수동으로 한다."
//
// 그래서 이 파일에는 주문 API가 없다. 있는 것은
//   (1) 시그널을 시각과 함께 남기고
//   (2) "그때 샀다면" 을 가정한 가상 포지션을 굴리고
//   (3) 나중에 실제 체결과 대조할 수 있게 근거를 보존하는 것
// 뿐이다. 대표가 수동으로 체결한 뒤 그 체결가를 입력하면 실측 괴리도 볼 수 있다.
//
// 왜 필요한가: 백테스트가 좋게 나와도 실전에서 재현되지 않는 게 일반적이다.
// 그 간극(슬리피지·미체결·심리)을 돈을 잃지 않고 재는 유일한 방법이 페이퍼다.

export type PaperSide = '매수' | '매도'

export interface PaperFill {
  /** 시그널 발생 시각 (ISO) — 판단이 언제 이뤄졌는지 */
  signalAt: string
  /** 체결(가정) 시각 */
  filledAt: string
  symbol: string
  side: PaperSide
  qty: number
  /** 가정 체결가 — 백테스트 규칙대로라면 익일 시가 */
  assumedPrice: number
  /** 대표가 실제로 수동 체결한 가격(입력 시). null = 미입력 */
  actualPrice: number | null
  /** 이 시그널이 나온 근거 (조건식 이름·탈락사유 등) */
  reason: string
}

export interface PaperPosition {
  symbol: string
  qty: number
  /** 평균 단가 — 수수료 포함 */
  avgPrice: number
  /** 누적 투입 원금(수수료 포함) */
  costBasis: number
}

export interface PaperJournal {
  /** 저널 식별자 — 전략별로 분리 */
  strategyId: string
  startedAt: string
  initialCapital: number
  cash: number
  positions: PaperPosition[]
  fills: PaperFill[]
  /** 실현 손익 누계 */
  realizedPnl: number
}

export interface PaperCost {
  feePct: number
  taxPct: number
}

export function newJournal(strategyId: string, initialCapital: number, startedAt: string): PaperJournal {
  return {
    strategyId,
    startedAt,
    initialCapital,
    cash: initialCapital,
    positions: [],
    fills: [],
    realizedPnl: 0,
  }
}

function findPos(j: PaperJournal, symbol: string): PaperPosition | undefined {
  return j.positions.find((p) => p.symbol === symbol)
}

/** 체결가 결정 — 대표가 실제 체결가를 넣었으면 그것을, 아니면 가정가를 쓴다. */
export function effectivePrice(f: PaperFill): number {
  return f.actualPrice != null && Number.isFinite(f.actualPrice) ? f.actualPrice : f.assumedPrice
}

/**
 * 체결 기록 반영. 순수 함수 — 새 저널을 반환한다(원본 불변).
 * 수량·가격이 유효하지 않거나 현금·보유수량이 부족하면 **거부**하고 그대로 돌려준다.
 * 조용히 마이너스 잔고를 만들지 않는다 — 페이퍼가 실전보다 관대하면 의미가 없다.
 */
export function applyFill(j: PaperJournal, f: PaperFill, cost: PaperCost): { journal: PaperJournal; rejected?: string } {
  const px = effectivePrice(f)
  if (!Number.isFinite(px) || px <= 0) return { journal: j, rejected: '체결가 오류' }
  if (!Number.isFinite(f.qty) || f.qty <= 0) return { journal: j, rejected: '수량 오류' }

  const gross = px * f.qty
  const fee = gross * (cost.feePct / 100)

  if (f.side === '매수') {
    const need = gross + fee
    if (need > j.cash + 1e-9) return { journal: j, rejected: '현금 부족' }
    const positions = j.positions.map((p) => ({ ...p }))
    const cur = positions.find((p) => p.symbol === f.symbol)
    if (cur) {
      cur.costBasis += need
      cur.qty += f.qty
      cur.avgPrice = cur.costBasis / cur.qty
    } else {
      positions.push({ symbol: f.symbol, qty: f.qty, avgPrice: need / f.qty, costBasis: need })
    }
    return {
      journal: { ...j, cash: j.cash - need, positions, fills: [...j.fills, f] },
    }
  }

  // 매도
  const cur = findPos(j, f.symbol)
  if (!cur) return { journal: j, rejected: '보유 없음' }
  if (f.qty > cur.qty + 1e-9) return { journal: j, rejected: '보유 수량 초과' }

  const tax = gross * (cost.taxPct / 100)
  const proceeds = gross - fee - tax
  // 매도분에 대응하는 원가 = 평단 × 수량
  const soldCost = cur.avgPrice * f.qty
  const realized = proceeds - soldCost

  const positions = j.positions
    .map((p) => {
      if (p.symbol !== f.symbol) return { ...p }
      const qty = p.qty - f.qty
      return { ...p, qty, costBasis: qty > 0 ? p.avgPrice * qty : 0 }
    })
    .filter((p) => p.qty > 1e-9)

  return {
    journal: {
      ...j,
      cash: j.cash + proceeds,
      positions,
      realizedPnl: j.realizedPnl + realized,
      fills: [...j.fills, f],
    },
  }
}

export interface PaperValuation {
  cash: number
  holdingsValue: number
  equity: number
  realizedPnl: number
  unrealizedPnl: number
  totalReturnPct: number
  /** 실제 체결가가 입력된 건에 한해, 가정가 대비 얼마나 불리했나 (%p 평균) */
  slippageVsAssumedPct: number | null
  filledCount: number
  actualEnteredCount: number
}

/** 현재가 맵으로 평가. 가격이 없는 종목은 평단으로 평가한다(과대평가 방지). */
export function valuate(j: PaperJournal, prices: Record<string, number>): PaperValuation {
  let holdings = 0
  let unreal = 0
  for (const p of j.positions) {
    const px = Number.isFinite(prices[p.symbol]) ? prices[p.symbol] : p.avgPrice
    holdings += px * p.qty
    unreal += (px - p.avgPrice) * p.qty
  }
  const equity = j.cash + holdings

  // 체결 괴리 — 매수는 비싸게 샀으면 불리(+), 매도는 싸게 팔았으면 불리(+)
  const withActual = j.fills.filter((f) => f.actualPrice != null && f.assumedPrice > 0)
  const slip = withActual.length
    ? withActual.reduce((s, f) => {
        const diff = ((f.actualPrice as number) - f.assumedPrice) / f.assumedPrice
        return s + (f.side === '매수' ? diff : -diff) * 100
      }, 0) / withActual.length
    : null

  return {
    cash: j.cash,
    holdingsValue: holdings,
    equity,
    realizedPnl: j.realizedPnl,
    unrealizedPnl: unreal,
    totalReturnPct: j.initialCapital > 0 ? (equity / j.initialCapital - 1) * 100 : 0,
    slippageVsAssumedPct: slip,
    filledCount: j.fills.length,
    actualEnteredCount: withActual.length,
  }
}

// ---- 저장 (localStorage) ---------------------------------------------------

const KEY_PREFIX = 'paper-journal:'

export function loadJournal(strategyId: string): PaperJournal | null {
  try {
    const raw = localStorage.getItem(KEY_PREFIX + strategyId)
    if (!raw) return null
    const j = JSON.parse(raw) as PaperJournal
    // 최소 형태 검증 — 깨진 저장본으로 화면이 죽지 않게
    if (typeof j.strategyId !== 'string' || !Array.isArray(j.fills) || !Array.isArray(j.positions)) return null
    return j
  } catch {
    return null
  }
}

export function saveJournal(j: PaperJournal): void {
  try {
    localStorage.setItem(KEY_PREFIX + j.strategyId, JSON.stringify(j))
  } catch {
    /* 용량 초과 등 — 저널이 없다고 앱이 죽지는 않는다 */
  }
}
