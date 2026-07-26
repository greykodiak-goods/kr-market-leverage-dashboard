// 다중 팩터 합성 — 여러 관점의 점수를 표준화해 하나로 합친다.
//
// ── 왜 필요한가 ────────────────────────────────────────────────────────
// 지금까지의 모델은 팩터 하나에 전부 걸었다(모멘텀만, 또는 평균회귀만).
// 그런데 팩터는 죽는다. 모멘텀은 2009년·2020년 급반등에서 크게 무너졌고,
// 저변동성은 강세장에서 오래 뒤진다. 한 팩터에 전부 걸면 그 팩터가 죽는 해에
// 계좌가 같이 죽는다.
//
// 해법은 **상관이 낮은 팩터 여러 개를 합치는 것**이다. 각 팩터가 서로 다른
// 이유로 작동하면, 하나가 부진해도 나머지가 버틴다. 이건 수익을 키우는 장치가
// 아니라 **성과의 기복을 줄이는 장치**다.
//
// ── 어떻게 합치나: z-score 표준화 ──────────────────────────────────────
// 팩터마다 단위가 다르다. 모멘텀은 "+35%", 변동성은 "28%", RSI는 "62".
// 그대로 더하면 숫자가 큰 팩터가 결과를 지배한다. 그래서 각 팩터를
//     z = (내 값 − 후보들의 평균) ÷ 후보들의 표준편차
// 로 바꾼다. 이러면 모든 팩터가 "이 후보군 안에서 몇 표준편차만큼 우수한가"라는
// 같은 척도가 되고, 가중합이 의미를 갖는다.
//
// 중요: 평균·표준편차는 **그 시점 후보군 안에서(횡단면)** 계산한다.
// 전체 기간 통계를 쓰면 그 자체가 미래 정보다(CLAUDE.md 규칙 1-5).
//
// ── 극단값 처리 ────────────────────────────────────────────────────────
// z-score는 이상치에 약하다. 한 종목이 +300% 오르면 그 종목의 z가 튀면서
// 나머지가 전부 −0.5쯤으로 뭉개진다. 그래서 z를 ±3으로 자른다(winsorize).
//
// ── 미래참조 금지 ──────────────────────────────────────────────────────
// 모든 팩터 값은 시점 i까지의 데이터로만 계산한다. 롤링 극값은 series.ts가
// 당일을 제외해 계산한다.

import type { DailyBar } from '../../lib/history'
import { operandSeries } from './series'

export type FactorKind =
  | 'momentum' // 장기 모멘텀 — 추세추종
  | 'shortReversal' // 단기 반전 — 최근 급락에 베팅(모멘텀과 반대 방향)
  | 'lowVol' // 저변동성 — 얌전한 종목 선호
  | 'trendQuality' // 추세 품질 — 수익률 ÷ 변동성 (같은 수익이면 덜 흔들린 쪽)
  | 'distanceFromHigh' // 신고가 근접도 — 52주 최고 대비 위치
  | 'volumeSurge' // 거래량 증가 — 관심 유입

export interface FactorSpec {
  kind: FactorKind
  weight: number // 합성 가중치 (음수 가능 — 반대 방향에 베팅)
  lookback: number // 측정 기간(거래일)
}

export interface MultiFactorParams {
  factors: FactorSpec[]
  topN: number // 보유 종목 수
  rebalanceDays: number // 리밸런싱 주기(거래일)
  minScore: number // 이 점수 미만이면 후보에서 제외(0 = 제한 없음)
  trendFilter: boolean // 장기 추세 위 종목만
  trendSma: number
}

export const FACTOR_LABELS: Record<FactorKind, { name: string; desc: string }> = {
  momentum: {
    name: '모멘텀',
    desc: '측정 기간 수익률. 이미 오르고 있는 종목이 더 간다는 관성에 베팅합니다. 가장 검증 이력이 두터운 팩터지만 급반등장에서 크게 무너집니다.',
  },
  shortReversal: {
    name: '단기 반전',
    desc: '최근 20일 수익률의 반대 부호. 단기 급락 종목이 되돌아온다는 데 베팅합니다. 모멘텀과 반대로 움직여 서로를 보완합니다.',
  },
  lowVol: {
    name: '저변동성',
    desc: '변동성이 낮을수록 높은 점수. 얌전한 종목이 위험 대비 성과가 좋다는 저변동성 이례현상에 베팅합니다. 강세장에서는 뒤집니다.',
  },
  trendQuality: {
    name: '추세 품질',
    desc: '수익률 ÷ 변동성. 같은 수익이라도 덜 흔들리며 오른 종목을 높게 봅니다. 모멘텀의 위험조정 버전입니다.',
  },
  distanceFromHigh: {
    name: '신고가 근접도',
    desc: '52주 최고가 대비 현재 위치. 고점 근처일수록 높은 점수 — 저항이 없는 구간이라는 해석입니다.',
  },
  volumeSurge: {
    name: '거래량 증가',
    desc: '최근 거래량 ÷ 장기 평균 거래량. 관심과 자금이 유입되는 종목을 포착합니다. 단독으로는 약하고 보조 팩터로 씁니다.',
  },
}

export const DEFAULT_MULTIFACTOR: MultiFactorParams = {
  factors: [
    { kind: 'momentum', weight: 1, lookback: 252 },
    { kind: 'trendQuality', weight: 1, lookback: 126 },
    { kind: 'lowVol', weight: 0.5, lookback: 60 },
    { kind: 'shortReversal', weight: 0.5, lookback: 20 },
  ],
  topN: 4,
  rebalanceDays: 21,
  minScore: 0,
  trendFilter: true,
  trendSma: 200,
}

function stdev(xs: number[]): number {
  if (xs.length < 2) return 0
  const m = xs.reduce((s, v) => s + v, 0) / xs.length
  return Math.sqrt(xs.reduce((s, v) => s + (v - m) ** 2, 0) / (xs.length - 1))
}

// 팩터 원시값 — 클수록 좋은 방향으로 부호를 맞춰 반환한다.
// bars[0..i]만 사용한다.
export function rawFactor(bars: DailyBar[], i: number, f: FactorSpec): number | null {
  const lb = Math.max(2, Math.round(f.lookback))
  const start = i - lb
  if (start < 1 || i >= bars.length) return null

  const rets = (): number[] => {
    const out: number[] = []
    for (let j = start + 1; j <= i; j++) {
      const prev = bars[j - 1].c
      if (prev > 0 && bars[j].c > 0) out.push(bars[j].c / prev - 1)
    }
    return out
  }

  switch (f.kind) {
    case 'momentum': {
      const ps = bars[start].c
      const pe = bars[i].c
      return ps > 0 && pe > 0 ? pe / ps - 1 : null
    }
    case 'shortReversal': {
      const ps = bars[start].c
      const pe = bars[i].c
      // 최근 수익률의 반대 — 많이 빠진 종목이 높은 점수
      return ps > 0 && pe > 0 ? -(pe / ps - 1) : null
    }
    case 'lowVol': {
      const sd = stdev(rets())
      return sd > 0 ? -sd : null // 변동성이 낮을수록 높은 점수
    }
    case 'trendQuality': {
      const ps = bars[start].c
      const pe = bars[i].c
      if (!(ps > 0 && pe > 0)) return null
      const sd = stdev(rets())
      return sd > 0 ? (pe / ps - 1) / (sd * Math.sqrt(252)) : null
    }
    case 'distanceFromHigh': {
      const hi = operandSeries(bars, { kind: 'HIGHEST', period: Math.min(252, lb) })[i]
      if (hi == null || hi <= 0) return null
      return bars[i].c / hi - 1 // 0에 가까울수록(고점 근처) 높은 점수
    }
    case 'volumeSurge': {
      let recent = 0
      let recentN = 0
      for (let j = Math.max(1, i - 19); j <= i; j++) {
        if (bars[j].v > 0) {
          recent += bars[j].v
          recentN++
        }
      }
      let base = 0
      let baseN = 0
      for (let j = start; j <= i; j++) {
        if (bars[j].v > 0) {
          base += bars[j].v
          baseN++
        }
      }
      if (recentN === 0 || baseN === 0) return null
      const avgRecent = recent / recentN
      const avgBase = base / baseN
      return avgBase > 0 ? avgRecent / avgBase - 1 : null
    }
  }
}

export interface FactorBreakdown {
  kind: FactorKind
  raw: number | null
  z: number | null
  weighted: number | null
}

export interface CompositeRow {
  symbol: string
  score: number | null // 가중 z-score 합계
  rank: number | null
  breakdown: FactorBreakdown[]
  passed: boolean
  reasons: string[]
}

const Z_CLIP = 3

// 후보군 전체에 대해 팩터별 z-score를 내고 가중합한다.
// raws: symbol → (factorIndex → 원시값)
export function compositeScores(
  raws: Record<string, (number | null)[]>,
  factors: FactorSpec[],
): Record<string, { score: number | null; breakdown: FactorBreakdown[] }> {
  const symbols = Object.keys(raws)
  const out: Record<string, { score: number | null; breakdown: FactorBreakdown[] }> = {}

  // 팩터별로 이 시점 후보군의 평균·표준편차를 구한다(횡단면 표준화)
  const stats = factors.map((_, fi) => {
    const vals = symbols.map((s) => raws[s][fi]).filter((v): v is number => v != null && Number.isFinite(v))
    if (vals.length < 2) return null
    const m = vals.reduce((a, b) => a + b, 0) / vals.length
    const sd = stdev(vals)
    return sd > 0 ? { m, sd } : null
  })

  for (const s of symbols) {
    const breakdown: FactorBreakdown[] = []
    let sum = 0
    let usable = 0
    factors.forEach((f, fi) => {
      const raw = raws[s][fi]
      const st = stats[fi]
      let z: number | null = null
      let weighted: number | null = null
      if (raw != null && Number.isFinite(raw) && st) {
        z = Math.max(-Z_CLIP, Math.min(Z_CLIP, (raw - st.m) / st.sd))
        weighted = z * f.weight
        sum += weighted
        usable++
      }
      breakdown.push({ kind: f.kind, raw, z, weighted })
    })
    out[s] = { score: usable > 0 ? sum : null, breakdown }
  }
  return out
}
