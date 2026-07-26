// "오늘의 판정" — 최신 봉 기준으로 각 종목에 대해 모델이 무엇을 하려는지와
// 그 근거를 실측 지표값으로 설명한다. 백테스트와 완전히 같은 규칙·같은 함수를
// 쓰므로, 화면에 보이는 판정이 곧 시뮬레이션이 내렸을 판정이다.

import type { HistoryResult } from '../../lib/history'
import type { PortfolioResult } from './portfolio'
import { explainRuleSignal, type SignalExplain } from './explain'
import { DEFAULT_IB_PARAMS, DEFAULT_VR_PARAMS } from './algoEngine'
import type { ModelConfig } from './models'

export interface SymbolSignal {
  symbol: string
  asOf: string // 판정 기준 봉 날짜
  holding: boolean
  position: string // '보유 없음' | '120주 · 평단 72,340'
  decision: string
  reasons: { text: string; detail: string; met: boolean }[]
  summary: string
}

export function computeSignals(
  modelId: string,
  cfg: ModelConfig,
  result: PortfolioResult,
  histories: Record<string, HistoryResult>,
): SymbolSignal[] {
  // 로테이션형: 최신 리밸런싱 시점의 후보 순위·탈락 사유를 그대로 보여준다.
  if (result.isRotation) {
    const held = new Set(result.trades.filter((t) => t.exitDate == null).map((t) => t.symbol))
    return (result.lastSelection ?? []).map((c) => ({
      symbol: c.symbol ?? '',
      asOf: result.lastSelectionDate ?? '—',
      holding: held.has(c.symbol),
      position: held.has(c.symbol) ? '보유 중' : '미보유',
      decision: c.passed ? (c.rank != null && c.rank <= (cfg.rot?.topN ?? 1) ? `편입 (순위 ${c.rank}위)` : `대기 (순위 ${c.rank ?? '—'}위)`) : '제외',
      reasons: c.passed
        ? [{ text: '모든 선정 조건 통과', detail: `점수 ${c.score != null ? (c.score * 100).toFixed(1) + '%' : '—'} · 순위 ${c.rank ?? '—'}위`, met: true }]
        : c.reasons.map((r) => ({ text: r, detail: `점수 ${c.score != null ? (c.score * 100).toFixed(1) + '%' : '—'}`, met: false })),
      summary: c.passed
        ? `선정 조건을 통과했고 후보 중 ${c.rank ?? '—'}위입니다`
        : `탈락: ${c.reasons.join(' / ')}`,
    }))
  }

  return result.sleeves.map((sleeve) => {
    const hist = histories[sleeve.symbol]
    const bars = hist?.bars ?? []
    const i = bars.length - 1
    const open = sleeve.res.trades.find((t) => t.exitDate == null)
    const holding = open != null
    const position = open
      ? `${open.qty.toLocaleString()}주 · 평단 ${open.entryPrice.toLocaleString(undefined, { maximumFractionDigits: 2 })}`
      : '보유 없음'

    if (modelId === 'infinite-buying') {
      const p = cfg.ib ?? DEFAULT_IB_PARAMS
      const target = open ? open.entryPrice * (1 + p.targetPct / 100) : null
      const last = bars[i]?.c ?? 0
      const belowAvg = open != null && last < open.entryPrice
      return {
        symbol: sleeve.symbol,
        asOf: bars[i]?.date ?? '—',
        holding,
        position,
        decision: holding ? '분할매수 진행 + 목표가 매도 대기' : '신규 사이클 시작 매수',
        reasons: [
          {
            text: '정액매수 0.5회분',
            detail: `가격과 무관하게 종가 매수 (1회분 = 원금 ÷ ${p.splits})`,
            met: true,
          },
          {
            text: '평단매수 0.5회분',
            detail: open
              ? `종가 ${last.toLocaleString(undefined, { maximumFractionDigits: 2 })} vs 평단 ${open.entryPrice.toLocaleString(undefined, { maximumFractionDigits: 2 })} — ${belowAvg ? '평단 아래 → 체결' : '평단 위 → 미체결'}`
              : '사이클 시작 전',
            met: belowAvg,
          },
          {
            text: `목표가 매도 (평단 +${p.targetPct}%)`,
            detail: target
              ? `목표 ${target.toLocaleString(undefined, { maximumFractionDigits: 2 })} · 현재 ${last.toLocaleString(undefined, { maximumFractionDigits: 2 })} (${(((last - target) / target) * 100).toFixed(1)}%)`
              : '보유 없음',
            met: target != null && last >= target,
          },
        ],
        summary: holding
          ? `분할매수 사이클 진행 중 — 목표가 도달 시 전량 익절 후 재시작`
          : '보유 없음 — 다음 거래일 사이클 시작 매수',
      }
    }

    if (modelId === 'value-rebalancing') {
      const p = cfg.vr ?? DEFAULT_VR_PARAMS
      return {
        symbol: sleeve.symbol,
        asOf: bars[i]?.date ?? '—',
        holding,
        position,
        decision: `${p.periodDays}거래일 주기 리밸런싱 점검`,
        reasons: [
          { text: 'V값 성장', detail: `주기마다 목표 평가금 +${p.growthPct}%`, met: true },
          { text: '밴드 상단 초과 시 매도', detail: `평가금 > V×${(1 + p.bandPct / 100).toFixed(2)} → V값까지 매도`, met: false },
          { text: '밴드 하단 이탈 시 매수', detail: `평가금 < V×${(1 - p.bandPct / 100).toFixed(2)} → 풀에서 V값까지 매수`, met: false },
        ],
        summary: '주기 도래일에만 매매 — 그 외에는 보유 유지',
      }
    }

    // 규칙형
    if (!cfg.strategy || bars.length === 0) {
      return {
        symbol: sleeve.symbol,
        asOf: bars[i]?.date ?? '—',
        holding,
        position,
        decision: '—',
        reasons: [],
        summary: '규칙 정보 없음',
      }
    }
    const ex: SignalExplain = explainRuleSignal(bars, cfg.strategy.buy, cfg.strategy.sell, i, holding)
    return {
      symbol: sleeve.symbol,
      asOf: ex.date,
      holding,
      position,
      decision: ex.decision,
      reasons: (holding ? ex.sellConds : ex.buyConds).map((c) => ({ text: c.text, detail: c.detail, met: c.met })),
      summary: ex.summary,
    }
  })
}
