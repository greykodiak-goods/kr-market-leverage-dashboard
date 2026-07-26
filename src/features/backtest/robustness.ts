// 강건성(robustness) 검사 — "결과론적으로 좋았던 것"과 "진짜 우위"를 가른다.
//
// 핵심 발상: 진짜 우위가 있는 규칙은 파라미터를 조금 바꿔도 성과가 완만하게
// 변한다(고원 plateau). 반대로 특정 숫자에서만 좋고 옆으로 한 칸만 옮겨도
// 무너지면(첨탑 peak), 그 성적은 데이터에 우연히 맞춘 결과일 가능성이 크다.
//
// 세 가지 축으로 흔들어 본다:
//  ① 파라미터 민감도 — 각 변수를 한 번에 하나씩(OAT) ±로 옮겨 실행
//  ② 비용 민감도     — 수수료·슬리피지를 2배·3배로 올려도 살아남는가
//  ③ 시작 시점 민감도 — 시뮬레이션 시작일을 앞뒤로 옮겨도 유지되는가
//
// 판정 기준은 절대 수익률이 아니라 **알파(연환산 초과수익)**다. 장세로 번 것을
// 실력으로 오인하지 않기 위함(CLAUDE.md 규칙 5).
//
// 미래참조 없음: 각 변형은 동일한 워크포워드 엔진으로 독립 실행된다.

import type { HistoryResult } from '../../lib/history'
import { runPortfolio, type PortfolioResult } from './portfolio'
import { DEFAULT_SIGNAL_ROTATION } from './signalRotation'
import { DEFAULT_ROTATION } from './rotation'
import { DEFAULT_IB_PARAMS, DEFAULT_VR_PARAMS } from './algoEngine'
import { modelMeta, type ModelConfig } from './models'

export type Axis = '기준' | '파라미터' | '비용' | '시작시점'

export interface Variant {
  label: string
  axis: Axis
  cfg: ModelConfig
}

export interface RobustRow {
  label: string
  axis: Axis
  totalReturnPct: number
  benchReturnPct: number
  cagrPct: number
  alphaPct: number // 연환산 초과수익 = CAGR − 벤치마크 CAGR
  mddPct: number
  sharpe: number
  trades: number
  error?: string
}

export interface RobustnessReport {
  rows: RobustRow[]
  baseAlphaPct: number | null
  medianAlphaPct: number
  worstAlphaPct: number
  positiveRatio: number // 알파가 양수인 변형 비율
  costSurvives: boolean // 비용 축 변형이 전부 양의 알파인가
  spreadPct: number // 최고 − 최악 알파 (첨탑도 지표)
  verdict: string
  verdictLevel: 'good' | 'watch' | 'bad' | 'early'
}

function scaled(v: number, f: number, min = 1): number {
  return Math.max(min, Math.round(v * f))
}

// 파라미터를 한 번에 하나씩 흔든다(One-At-a-Time). 상호작용까지 보려면 격자
// 탐색이 필요하지만, 그건 그 자체로 과최적화 유혹이 커서 의도적으로 피한다.
export function buildVariants(modelId: string, base: ModelConfig): Variant[] {
  const meta = modelMeta(modelId)
  const out: Variant[] = [{ label: '기준 설정', axis: '기준', cfg: base }]

  const push = (label: string, axis: Axis, patch: Partial<ModelConfig>) =>
    out.push({ label, axis, cfg: { ...base, ...patch } })

  if (meta.type === 'rule') {
    const sig = base.sig ?? DEFAULT_SIGNAL_ROTATION
    for (const n of [Math.max(1, sig.topN - 2), sig.topN + 2]) {
      if (n !== sig.topN) push(`슬롯 ${sig.topN}→${n}`, '파라미터', { sig: { ...sig, topN: n } })
    }
    for (const f of [0.6, 1.6]) {
      push(`순위기간 ×${f}`, '파라미터', { sig: { ...sig, rankLookback: scaled(sig.rankLookback, f, 20) } })
    }
    for (const f of [0.6, 1.5]) {
      push(`추세이평 ×${f}`, '파라미터', { sig: { ...sig, trendSma: scaled(sig.trendSma, f, 20) } })
    }
    push('추세필터 해제', '파라미터', { sig: { ...sig, trendFilter: !sig.trendFilter } })
    // 전략 조건의 기간 파라미터를 한꺼번에 ±30%
    if (base.strategy) {
      for (const f of [0.7, 1.3]) {
        const scale = (conds: typeof base.strategy.buy) =>
          conds.map((c) => ({
            ...c,
            left: c.left.period ? { ...c.left, period: scaled(c.left.period, f, 2) } : c.left,
            right: c.right.period ? { ...c.right, period: scaled(c.right.period, f, 2) } : c.right,
          }))
        push(`지표기간 ×${f}`, '파라미터', {
          strategy: { ...base.strategy, buy: scale(base.strategy.buy), sell: scale(base.strategy.sell) },
        })
      }
    }
  } else if (meta.type === 'rotation') {
    const rot = base.rot ?? DEFAULT_ROTATION
    for (const f of [0.6, 1.5]) push(`측정기간 ×${f}`, '파라미터', { rot: { ...rot, lookbackDays: scaled(rot.lookbackDays, f, 20) } })
    for (const n of [Math.max(1, rot.topN - 1), rot.topN + 2]) {
      if (n !== rot.topN) push(`보유수 ${rot.topN}→${n}`, '파라미터', { rot: { ...rot, topN: n } })
    }
    for (const f of [0.5, 2]) push(`리밸주기 ×${f}`, '파라미터', { rot: { ...rot, rebalanceDays: scaled(rot.rebalanceDays, f, 5) } })
    push(`최근제외 ${rot.skipDays}→${rot.skipDays > 0 ? 0 : 21}`, '파라미터', { rot: { ...rot, skipDays: rot.skipDays > 0 ? 0 : 21 } })
  } else if (modelId === 'infinite-buying') {
    const ib = base.ib ?? DEFAULT_IB_PARAMS
    for (const f of [0.5, 1.5]) push(`분할수 ×${f}`, '파라미터', { ib: { ...ib, splits: scaled(ib.splits, f, 2) } })
    for (const t of [Math.max(1, ib.targetPct - 5), ib.targetPct + 5]) {
      push(`목표 ${ib.targetPct}%→${t}%`, '파라미터', { ib: { ...ib, targetPct: t } })
    }
  } else {
    const vr = base.vr ?? DEFAULT_VR_PARAMS
    for (const f of [0.5, 2]) push(`주기 ×${f}`, '파라미터', { vr: { ...vr, periodDays: scaled(vr.periodDays, f, 1) } })
    for (const f of [0.5, 2]) push(`밴드 ×${f}`, '파라미터', { vr: { ...vr, bandPct: scaled(vr.bandPct, f, 1) } })
    for (const g of [Math.max(0, vr.growthPct - 0.5), vr.growthPct + 0.5]) {
      push(`V성장 ${vr.growthPct}%→${g}%`, '파라미터', { vr: { ...vr, growthPct: g } })
    }
  }

  // 비용 민감도 — 수수료·슬리피지를 올려도 우위가 남는가
  for (const mult of [2, 3]) {
    push(`거래비용 ×${mult}`, '비용', {
      settings: {
        ...base.settings,
        commissionPct: base.settings.commissionPct * mult,
        slippagePct: base.settings.slippagePct * mult,
      },
    })
  }

  return out
}

// 시작 시점을 앞뒤로 옮긴 변형 — 실제 데이터 길이를 알아야 하므로 별도.
export function buildStartVariants(base: ModelConfig, equityDates: string[]): Variant[] {
  if (equityDates.length < 300) return []
  const out: Variant[] = []
  const pick = (frac: number, label: string) => {
    const i = Math.floor(equityDates.length * frac)
    const d = equityDates[Math.min(i, equityDates.length - 200)]
    if (d) out.push({ label, axis: '시작시점', cfg: { ...base, startDate: d } })
  }
  pick(0.1, '시작 10% 지점')
  pick(0.3, '시작 30% 지점')
  return out
}

function alphaOf(res: PortfolioResult): number {
  const days = res.equity.length
  const years = days / 252
  if (years <= 0) return 0
  const first = res.equity[0]
  const last = res.equity[days - 1]
  if (first.equity <= 0 || first.benchmark <= 0) return 0
  const cagr = (Math.pow(last.equity / first.equity, 1 / years) - 1) * 100
  const benchCagr = (Math.pow(last.benchmark / first.benchmark, 1 / years) - 1) * 100
  return cagr - benchCagr
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

export function runRobustness(
  modelId: string,
  variants: Variant[],
  histories: Record<string, HistoryResult>,
): RobustnessReport {
  const rows: RobustRow[] = []
  for (const v of variants) {
    try {
      const res = runPortfolio(modelId, v.cfg, histories)
      rows.push({
        label: v.label,
        axis: v.axis,
        totalReturnPct: res.metrics.totalReturnPct,
        benchReturnPct: res.metrics.benchmarkReturnPct,
        cagrPct: res.metrics.cagrPct,
        alphaPct: alphaOf(res),
        mddPct: res.metrics.mddPct,
        sharpe: res.metrics.sharpe,
        trades: res.metrics.tradeCount,
      })
    } catch (e) {
      rows.push({
        label: v.label,
        axis: v.axis,
        totalReturnPct: 0,
        benchReturnPct: 0,
        cagrPct: 0,
        alphaPct: 0,
        mddPct: 0,
        sharpe: 0,
        trades: 0,
        error: String((e as Error).message ?? e),
      })
    }
  }

  const ok = rows.filter((r) => !r.error)
  const base = ok.find((r) => r.axis === '기준') ?? null
  const others = ok.filter((r) => r.axis !== '기준')
  const alphas = others.map((r) => r.alphaPct)
  const med = median(alphas)
  const worst = alphas.length ? Math.min(...alphas) : 0
  const best = alphas.length ? Math.max(...alphas) : 0
  const positiveRatio = alphas.length ? alphas.filter((a) => a > 0).length / alphas.length : 0
  const costRows = ok.filter((r) => r.axis === '비용')
  const costSurvives = costRows.length > 0 && costRows.every((r) => r.alphaPct > 0)
  const spread = best - worst

  let verdict: string
  let verdictLevel: RobustnessReport['verdictLevel']

  if (alphas.length < 3) {
    verdictLevel = 'early'
    verdict = '변형 실행이 부족해 판단할 수 없습니다.'
  } else if ((base?.alphaPct ?? 0) <= 0) {
    verdictLevel = 'bad'
    verdict = `기준 설정부터 알파가 ${(base?.alphaPct ?? 0).toFixed(1)}%p로 벤치마크에 뒤집니다 — 파라미터를 흔들 것도 없이 이 후보 풀·구간에서는 우위가 없습니다.`
  } else if (positiveRatio >= 0.7 && med > 0 && costSurvives) {
    verdictLevel = 'good'
    verdict = `변형 ${others.length}개 중 ${Math.round(positiveRatio * 100)}%가 양의 알파를 유지했고(중앙값 ${med.toFixed(1)}%p), 거래비용을 2~3배로 올려도 우위가 남습니다. 특정 숫자에 맞춘 성적이 아니라 완만한 고원(plateau)에 가깝습니다. 다만 이것도 같은 데이터 위의 검사이므로, 사후검증(모의운용)이 최종 관문입니다.`
  } else if (positiveRatio < 0.4 || med <= 0) {
    verdictLevel = 'bad'
    verdict = `변형 ${others.length}개 중 양의 알파는 ${Math.round(positiveRatio * 100)}%뿐이고 중앙값이 ${med.toFixed(1)}%p입니다 — 기준 설정(${(base?.alphaPct ?? 0).toFixed(1)}%p)에서만 좋고 옆으로 한 칸만 옮기면 무너지는 첨탑(peak)입니다. 그 성적은 데이터에 우연히 맞춘 결과일 가능성이 큽니다.`
  } else if (!costSurvives) {
    verdictLevel = 'watch'
    verdict = `파라미터 변화에는 어느 정도 견디지만(양의 알파 ${Math.round(positiveRatio * 100)}%), 거래비용을 올리면 우위가 사라집니다 — 실제 체결 환경에서는 남는 게 없을 수 있습니다.`
  } else {
    verdictLevel = 'watch'
    verdict = `양의 알파 ${Math.round(positiveRatio * 100)}%, 중앙값 ${med.toFixed(1)}%p, 최악 ${worst.toFixed(1)}%p — 우위가 있긴 하나 파라미터에 따라 편차가 큽니다(최고−최악 ${spread.toFixed(1)}%p). 더 지켜봐야 합니다.`
  }

  return {
    rows,
    baseAlphaPct: base?.alphaPct ?? null,
    medianAlphaPct: med,
    worstAlphaPct: worst,
    positiveRatio,
    costSurvives,
    spreadPct: spread,
    verdict,
    verdictLevel,
  }
}
