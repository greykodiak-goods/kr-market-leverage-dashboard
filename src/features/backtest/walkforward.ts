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
  excessPct: number // 누적 초과수익 (전략 − 벤치마크). 구간 길이가 같으므로
  // 연환산하지 않는다 — 짧은 구간을 연환산하면 수치가 지수적으로 부풀려져
  // (예: 0.8년 구간의 벤치 +400% → 연환산 +620%) 해석을 방해한다.
  mddPct: number
  trades: number // 이 구간에서 발생한 진입 횟수 (0 = 아예 매매 없음)
}

export interface WalkForwardReport {
  folds: Fold[]
  positiveFolds: number
  medianExcessPct: number
  worstExcessPct: number
  bestExcessPct: number
  noTradeFolds: number
  consistency: string // '4/6'
  // 열위 패턴 구분: 'persistent' = 대부분 구간에서 뒤짐,
  // 'concentrated' = 전체 성적이 소수 구간에 의존
  pattern: 'reproducible' | 'concentrated' | 'persistent' | 'mixed' | 'insufficient'
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

export function buildWalkForward(
  equity: EquityPoint[],
  foldCount = 6,
  trades: { entryDate: string }[] = [],
): WalkForwardReport {
  const n = equity.length
  const k = Math.max(2, Math.min(12, Math.floor(foldCount)))
  const size = Math.floor(n / k)

  if (size < MIN_FOLD_DAYS) {
    return {
      folds: [],
      positiveFolds: 0,
      medianExcessPct: 0,
      worstExcessPct: 0,
      bestExcessPct: 0,
      noTradeFolds: 0,
      consistency: `0/0`,
      pattern: 'insufficient',
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
    const ret = (b.equity / a.equity - 1) * 100
    const bench = (b.benchmark / a.benchmark - 1) * 100

    let peak = a.equity
    let mdd = 0
    for (let j = from; j <= to; j++) {
      peak = Math.max(peak, equity[j].equity)
      mdd = Math.min(mdd, ((equity[j].equity - peak) / peak) * 100)
    }

    const tradeCount = trades.filter((t) => t.entryDate >= a.date && t.entryDate <= b.date).length

    folds.push({
      index: i + 1,
      from: a.date,
      to: b.date,
      days,
      returnPct: ret,
      benchPct: bench,
      excessPct: ret - bench,
      mddPct: mdd,
      trades: tradeCount,
    })
  }

  const excesses = folds.map((f) => f.excessPct)
  const positive = excesses.filter((x) => x > 0).length
  const med = median(excesses)
  const worst = Math.min(...excesses)
  const best = Math.max(...excesses)
  const ratio = positive / folds.length
  const noTrade = folds.filter((f) => f.trades === 0).length
  const noTradeNote =
    noTrade > 0 ? ` ${noTrade}개 구간은 아예 매매가 없었습니다(현금 보유) — 그 구간의 마이너스는 손실이 아니라 놓친 기회입니다.` : ''

  let verdict: string
  let verdictLevel: WalkForwardReport['verdictLevel']
  let pattern: WalkForwardReport['pattern']

  if (ratio >= 0.7 && med > 0) {
    pattern = 'reproducible'
    verdictLevel = 'good'
    verdict = `${folds.length}개 구간 중 ${positive}개에서 벤치마크를 앞섰고 중앙값 초과수익이 ${med.toFixed(1)}%p입니다 — 특정 장세에만 통한 규칙은 아닌 것으로 보입니다. 최악 구간 ${worst.toFixed(1)}%p는 감내 가능한지 확인하세요.${noTradeNote}`
  } else if (med <= 0 && positive <= folds.length / 3) {
    // 대부분의 구간에서 뒤짐 = 지속적 열위. "소수 구간 의존"과는 다른 상황이다.
    pattern = 'persistent'
    verdictLevel = 'bad'
    verdict = `${folds.length}개 구간 중 ${positive}개에서만 벤치마크를 앞섰고, 중앙값 초과수익이 ${med.toFixed(1)}%p로 대부분의 구간에서 단순보유에 뒤졌습니다 — 이 종목·기간에서 이 규칙이 단순보유보다 낫다는 근거가 없습니다.${noTradeNote}`
  } else if (med <= 0 && best > 0) {
    // 전체 합계는 나쁘지 않을 수 있으나 중앙값이 음수 = 소수 구간이 성적을 끌었다.
    pattern = 'concentrated'
    verdictLevel = 'bad'
    verdict = `중앙값 초과수익이 ${med.toFixed(1)}%p인데 최고 구간은 ${best.toFixed(1)}%p입니다 — 전체 성적이 소수 구간에 의존했을 가능성이 큽니다. 그 구간이 반복된다는 보장은 없습니다.${noTradeNote}`
  } else {
    pattern = 'mixed'
    verdictLevel = 'watch'
    verdict = `${folds.length}개 구간 중 ${positive}개 우위, 중앙값 초과수익 ${med.toFixed(1)}%p — 재현성이 뚜렷하지 않습니다. 구간별 편차(최고 ${best.toFixed(1)}%p / 최악 ${worst.toFixed(1)}%p)를 함께 보세요.${noTradeNote}`
  }

  return {
    folds,
    positiveFolds: positive,
    medianExcessPct: med,
    worstExcessPct: worst,
    bestExcessPct: best,
    noTradeFolds: noTrade,
    consistency: `${positive}/${folds.length}`,
    pattern,
    verdict,
    verdictLevel,
  }
}
