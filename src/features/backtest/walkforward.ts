// 구간분할 검증 — 같은 규칙을 여러 개의 연속 구간에서 각각 평가한다.
//
// 왜 필요한가: 단일 구간 성적은 "그 장세에 맞았다"는 것 이상을 말해주지 못한다.
// 규칙을 고정한 채 서로 겹치지 않는 여러 구간에서 각각 벤치마크 대비 알파를
// 재고, 몇 구간에서 우위가 재현되는지를 본다. 한두 구간의 대박으로 전체
// 성적이 만들어졌다면 여기서 드러난다.
//
// 미래참조 없음: 각 구간의 성적은 그 구간 안의 자산곡선만으로 계산하며,
// 자산곡선 자체는 워크포워드 엔진이 만든 것이다(뒤를 보지 않는다).

import type { EquityPoint } from './types'

export interface Fold {
  index: number
  from: string
  to: string
  days: number
  returnPct: number
  benchPct: number
  alphaPct: number // 연환산 초과수익
  mddPct: number
}

export interface WalkForwardReport {
  folds: Fold[]
  positiveAlphaFolds: number
  medianAlphaPct: number
  worstAlphaPct: number
  bestAlphaPct: number
  consistency: string // '4/6'
  verdict: string
  verdictLevel: 'good' | 'watch' | 'bad' | 'early'
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

export const MIN_FOLD_DAYS = 60 // 구간이 이보다 짧으면 통계적 의미가 희박

export function buildWalkForward(equity: EquityPoint[], foldCount = 6): WalkForwardReport {
  const n = equity.length
  const k = Math.max(2, Math.min(12, Math.floor(foldCount)))
  const size = Math.floor(n / k)

  if (size < MIN_FOLD_DAYS) {
    return {
      folds: [],
      positiveAlphaFolds: 0,
      medianAlphaPct: 0,
      worstAlphaPct: 0,
      bestAlphaPct: 0,
      consistency: `0/0`,
      verdict: `구간당 ${size}거래일뿐이라 분할 검증이 의미가 없습니다 — 시뮬레이션 기간을 늘리거나 구간 수를 줄이세요(구간당 최소 ${MIN_FOLD_DAYS}거래일).`,
      verdictLevel: 'early',
    }
  }

  const folds: Fold[] = []
  for (let i = 0; i < k; i++) {
    const from = i * size
    const to = i === k - 1 ? n - 1 : (i + 1) * size - 1
    const a = equity[from]
    const b = equity[to]
    const days = to - from + 1
    const years = days / 252
    const ret = b.equity / a.equity - 1
    const bench = b.benchmark / a.benchmark - 1
    const cagr = years > 0 ? Math.pow(1 + ret, 1 / years) - 1 : 0
    const benchCagr = years > 0 ? Math.pow(1 + bench, 1 / years) - 1 : 0

    let peak = a.equity
    let mdd = 0
    for (let j = from; j <= to; j++) {
      peak = Math.max(peak, equity[j].equity)
      mdd = Math.min(mdd, ((equity[j].equity - peak) / peak) * 100)
    }

    folds.push({
      index: i + 1,
      from: a.date,
      to: b.date,
      days,
      returnPct: ret * 100,
      benchPct: bench * 100,
      alphaPct: (cagr - benchCagr) * 100,
      mddPct: mdd,
    })
  }

  const alphas = folds.map((f) => f.alphaPct)
  const positive = alphas.filter((a) => a > 0).length
  const med = median(alphas)
  const worst = Math.min(...alphas)
  const best = Math.max(...alphas)
  const ratio = positive / folds.length

  let verdict: string
  let verdictLevel: WalkForwardReport['verdictLevel']
  if (ratio >= 0.7 && med > 0) {
    verdictLevel = 'good'
    verdict = `${folds.length}개 구간 중 ${positive}개에서 벤치마크를 앞섰고 중앙값 알파가 ${med.toFixed(1)}%p입니다 — 특정 장세에만 통한 규칙은 아닌 것으로 보입니다. 최악 구간 ${worst.toFixed(1)}%p는 감내 가능한지 확인하세요.`
  } else if (ratio <= 0.34 || med <= 0) {
    verdictLevel = 'bad'
    verdict = `${folds.length}개 구간 중 ${positive}개에서만 벤치마크를 앞섰고 중앙값 알파가 ${med.toFixed(1)}%p입니다 — 전체 성적이 소수 구간(최고 ${best.toFixed(1)}%p)에 의존했을 가능성이 큽니다.`
  } else {
    verdictLevel = 'watch'
    verdict = `${folds.length}개 구간 중 ${positive}개 우위, 중앙값 알파 ${med.toFixed(1)}%p — 재현성이 뚜렷하지 않습니다. 구간별 편차(최고 ${best.toFixed(1)}%p / 최악 ${worst.toFixed(1)}%p)를 함께 보세요.`
  }

  return {
    folds,
    positiveAlphaFolds: positive,
    medianAlphaPct: med,
    worstAlphaPct: worst,
    bestAlphaPct: best,
    consistency: `${positive}/${folds.length}`,
    verdict,
    verdictLevel,
  }
}
