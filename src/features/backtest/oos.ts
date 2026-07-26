// 사후검증(out-of-sample) 분해 — 백테스트 성적이 실전에서도 유지되는가.
//
// 모의운용 등록일을 경계로 자산곡선을 둘로 나눈다:
//  · 등록 전(in-sample)  = 모델을 만들고 튜닝하며 본 구간. 좋게 나오는 게 당연.
//  · 등록 후(out-of-sample) = 규칙을 동결한 뒤 처음 보는 구간. 여기 성적이
//    진짜다. 두 구간의 격차(degradation)가 크면 과최적화 신호.
//
// 저장된 저널 없이 매번 재계산한다 — 규칙이 결정적이므로 같은 등록일·같은
// 스펙이면 언제 돌려도 같은 값이 나온다(재현성).

import type { EquityPoint } from './types'
import { computeAdvanced, type AdvancedMetrics } from './portfolio'

export interface SegmentStats {
  from: string
  to: string
  days: number
  totalReturnPct: number
  benchmarkReturnPct: number
  excessPct: number // 전략 − 벤치마크 (누적)
  cagrPct: number
  benchCagrPct: number
  alphaPct: number // 연환산 초과수익 = CAGR − 벤치CAGR. 구간 길이·장세에 중립적
  mddPct: number
  sharpe: number
  advanced: AdvancedMetrics
}

export interface OosReport {
  enrolledAt: string
  inSample: SegmentStats | null
  outSample: SegmentStats | null
  // 격차 진단 — 절대 수익률이 아니라 "벤치마크 대비 우위(알파)"가 유지되는지를
  // 본다. 절대 CAGR은 장세(강세장/약세장)에 좌우돼 과최적화 판정에 부적합하다.
  alphaGapPct: number | null // OOS 알파 − IS 알파 (음수 = 우위가 약해짐)
  cagrGapPct: number | null // 참고용 절대 성과 격차
  sharpeGap: number | null
  verdict: string
  verdictLevel: 'good' | 'watch' | 'bad' | 'early'
}

function segment(points: EquityPoint[]): SegmentStats | null {
  if (points.length < 2) return null
  const first = points[0]
  const last = points[points.length - 1]
  const totalReturnPct = (last.equity / first.equity - 1) * 100
  const benchmarkReturnPct = (last.benchmark / first.benchmark - 1) * 100
  const years = points.length / 252
  const cagrPct = years > 0 ? (Math.pow(last.equity / first.equity, 1 / years) - 1) * 100 : 0
  const benchCagrPct =
    years > 0 && first.benchmark > 0 ? (Math.pow(last.benchmark / first.benchmark, 1 / years) - 1) * 100 : 0

  // 구간 내부에서 고점을 다시 잡아 낙폭을 계산(전 구간 고점을 물려받지 않음)
  let peak = first.equity
  let mddPct = 0
  const rebased: EquityPoint[] = points.map((p) => {
    peak = Math.max(peak, p.equity)
    const dd = ((p.equity - peak) / peak) * 100
    mddPct = Math.min(mddPct, dd)
    return { ...p, drawdownPct: dd }
  })

  const rets: number[] = []
  for (let i = 1; i < points.length; i++) rets.push(points[i].equity / points[i - 1].equity - 1)
  const mean = rets.length ? rets.reduce((s, v) => s + v, 0) / rets.length : 0
  const sd =
    rets.length > 1 ? Math.sqrt(rets.reduce((s, v) => s + (v - mean) ** 2, 0) / (rets.length - 1)) : 0
  const sharpe = sd > 0 ? (mean / sd) * Math.sqrt(252) : 0

  return {
    from: first.date,
    to: last.date,
    days: points.length,
    totalReturnPct,
    benchmarkReturnPct,
    excessPct: totalReturnPct - benchmarkReturnPct,
    cagrPct,
    benchCagrPct,
    alphaPct: cagrPct - benchCagrPct,
    mddPct,
    sharpe,
    advanced: computeAdvanced(rebased, cagrPct, mddPct),
  }
}

const MIN_OOS_DAYS = 20 // 이보다 짧으면 판단 자체를 유보한다

export function buildOosReport(equity: EquityPoint[], enrolledAt: string): OosReport {
  const inPts = equity.filter((e) => e.date < enrolledAt)
  const outPts = equity.filter((e) => e.date >= enrolledAt)
  const inSample = segment(inPts)
  const outSample = segment(outPts)

  const cagrGapPct = inSample && outSample ? outSample.cagrPct - inSample.cagrPct : null
  const alphaGapPct = inSample && outSample ? outSample.alphaPct - inSample.alphaPct : null
  const sharpeGap = inSample && outSample ? outSample.sharpe - inSample.sharpe : null

  // 판정 기준은 "벤치마크 대비 우위(알파)가 등록 후에도 남아 있는가".
  // 절대 수익률로 판단하면 장세가 좋았을 뿐인 모델을 실력으로 오인한다.
  let verdict: string
  let verdictLevel: OosReport['verdictLevel']
  if (!outSample || outSample.days < MIN_OOS_DAYS) {
    verdictLevel = 'early'
    verdict = `사후검증 구간이 ${outSample?.days ?? 0}거래일뿐입니다 — 최소 ${MIN_OOS_DAYS}거래일(약 1개월)은 지나야 하고, 신뢰할 만한 판단에는 6개월 이상이 필요합니다.`
  } else if (!inSample) {
    verdictLevel = 'early'
    verdict = '등록 전 구간이 없어 비교할 기준이 없습니다.'
  } else if (outSample.alphaPct > 0 && alphaGapPct != null && alphaGapPct > -10) {
    verdictLevel = 'good'
    verdict = `등록 후에도 벤치마크 대비 우위가 유지됩니다(연환산 알파 ${outSample.alphaPct.toFixed(1)}%p, 등록 전 대비 ${alphaGapPct >= 0 ? '+' : ''}${alphaGapPct.toFixed(1)}%p). 다만 표본이 짧으면 우연일 수 있으니 계속 관찰하세요.`
  } else if (inSample.alphaPct > 0 && outSample.alphaPct <= 0) {
    verdictLevel = 'bad'
    verdict = `등록 전에는 벤치마크를 연 ${inSample.alphaPct.toFixed(1)}%p 앞섰지만 등록 후에는 ${outSample.alphaPct.toFixed(1)}%p로 우위가 사라졌습니다 — 백테스트 성적이 과최적화였을 가능성이 큽니다.`
  } else if (outSample.alphaPct <= 0) {
    verdictLevel = 'bad'
    verdict = `등록 후 벤치마크에 연환산 ${outSample.alphaPct.toFixed(1)}%p 뒤집니다 — 단순보유보다 나은 근거가 확인되지 않습니다.`
  } else {
    verdictLevel = 'watch'
    verdict = `등록 후 우위는 있으나(연환산 알파 ${outSample.alphaPct.toFixed(1)}%p) 등록 전보다 ${Math.abs(alphaGapPct ?? 0).toFixed(1)}%p 약해졌습니다. 더 지켜봐야 합니다.`
  }

  return { enrolledAt, inSample, outSample, alphaGapPct, cagrGapPct, sharpeGap, verdict, verdictLevel }
}
