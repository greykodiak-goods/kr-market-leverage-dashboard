// 큰손 자금 레이더 — 가격·거래량에서 기관성 자금의 매집/분산 흔적을 추정한다.
//
// ⚠️ 이것은 실제 보유지분(13F·5%룰 공시)이 아니라 **프록시(대리 지표)**다.
// 실제 기관 보유 데이터는 SEC EDGAR 13F / DART 대량보유공시가 원본이며,
// 현재 프록시 허용 호스트 밖이라 연동되어 있지 않다. 화면에서 반드시 프록시임을 밝힌다.
//
// 왜 가격·거래량으로 추정이 가능한가:
//   큰 자금은 한 번에 못 산다. 며칠~몇 주에 걸쳐 나눠 담고, 그 흔적이
//   "거래량이 실린 날의 종가 위치"와 "누적 거래량의 방향"에 남는다.
//   이것이 와이코프의 effort vs result, 그랜빌의 OBV, 채이킨의 자금흐름이
//   공통으로 보는 지점이다. 확정이 아니라 정황 증거다.
//
// 미래참조 금지(규칙 1) 준수:
//   - 모든 지표는 인덱스 i 시점에서 bars[0..i]만 사용한다.
//   - 정규화 스케일은 **고정 상수**를 쓴다. 전체 구간의 평균·표준편차로 정규화하면
//     그 자체가 미래 정보가 되기 때문이다(규칙 1-5).
//   - z-score가 필요한 곳은 직전 N일 롤링 윈도우로만 계산한다.

import type { DailyBar } from '../../lib/history'

// ---- 개별 지표 -----------------------------------------------------------

/**
 * 채이킨 자금흐름 (Chaikin Money Flow, 기본 20일).
 * 각 봉에서 종가가 고저 레인지의 어디에 붙었는지를 거래량으로 가중해 합산한다.
 * 고가 근처 마감 + 큰 거래량 = 매수 주도(매집), 저가 근처 = 매도 주도(분산).
 * 반환 범위 -1 ~ +1.
 */
export function chaikinMoneyFlow(bars: DailyBar[], i: number, period = 20): number | null {
  if (i < period - 1) return null
  let mfv = 0
  let vol = 0
  for (let k = i - period + 1; k <= i; k++) {
    const b = bars[k]
    const range = b.h - b.l
    if (!Number.isFinite(range) || range <= 0 || !Number.isFinite(b.v) || b.v <= 0) continue
    const mult = ((b.c - b.l) - (b.h - b.c)) / range // -1(저가 마감) ~ +1(고가 마감)
    mfv += mult * b.v
    vol += b.v
  }
  if (vol <= 0) return null
  return mfv / vol
}

/**
 * OBV(누적 거래량) 추세.
 * 상승일 거래량은 더하고 하락일 거래량은 뺀 누적선의 기울기를,
 * 같은 기간 평균 거래량으로 나눠 종목 규모와 무관하게 비교 가능한 값으로 만든다.
 * 양수 = 거래량이 상승 쪽에 실리는 중.
 */
export function obvTrend(bars: DailyBar[], i: number, period = 60): number | null {
  if (i < period) return null
  const obv: number[] = [0]
  let volSum = 0
  for (let k = i - period + 1; k <= i; k++) {
    const b = bars[k]
    const prev = bars[k - 1]
    if (!Number.isFinite(b.v) || b.v <= 0) {
      obv.push(obv[obv.length - 1])
      continue
    }
    const dir = b.c > prev.c ? 1 : b.c < prev.c ? -1 : 0
    obv.push(obv[obv.length - 1] + dir * b.v)
    volSum += b.v
  }
  const n = obv.length
  if (n < 3 || volSum <= 0) return null
  const avgVol = volSum / (n - 1)
  if (avgVol <= 0) return null
  // 최소제곱 기울기 (하루당 OBV 변화) → 평균 거래량으로 정규화
  const meanX = (n - 1) / 2
  let meanY = 0
  for (const v of obv) meanY += v
  meanY /= n
  let num = 0
  let den = 0
  for (let k = 0; k < n; k++) {
    num += (k - meanX) * (obv[k] - meanY)
    den += (k - meanX) * (k - meanX)
  }
  if (den <= 0) return null
  return num / den / avgVol
}

/**
 * 대량거래일 종가 위치 편향 (big-print bias).
 * 최근 window일 중 **거래대금 상위 topPct** 날만 골라, 그날 종가가 당일 레인지의
 * 어디에서 마감했는지 평균한다. 0.5가 중립이므로 0.5를 빼서 -0.5 ~ +0.5로 만든다.
 *
 * 큰돈이 들어온 날 고가권에서 끝났다면 매수자가 급했다는 뜻이고,
 * 저가권에서 끝났다면 파는 쪽이 급했다는 뜻이다. 평범한 날은 노이즈라 버린다.
 */
export function bigPrintBias(bars: DailyBar[], i: number, window = 60, topPct = 0.2): number | null {
  if (i < window - 1) return null
  const slice: { turnover: number; pos: number }[] = []
  for (let k = i - window + 1; k <= i; k++) {
    const b = bars[k]
    const range = b.h - b.l
    if (!Number.isFinite(range) || range <= 0 || !Number.isFinite(b.v) || b.v <= 0) continue
    slice.push({ turnover: b.c * b.v, pos: (b.c - b.l) / range })
  }
  if (slice.length < 10) return null
  const take = Math.max(3, Math.round(slice.length * topPct))
  const top = [...slice].sort((a, b) => b.turnover - a.turnover).slice(0, take)
  let wSum = 0
  let w = 0
  for (const t of top) {
    wSum += t.pos * t.turnover
    w += t.turnover
  }
  if (w <= 0) return null
  return wSum / w - 0.5
}

/**
 * 거래대금 z-score — 최근 5일 평균 거래대금이 직전 window일 분포에서 몇 표준편차인가.
 * 자금 유입의 "규모가 이례적인지"를 본다. 방향이 아니라 세기다.
 * 롤링 윈도우만 사용(전체 구간 통계 금지).
 */
export function turnoverZ(bars: DailyBar[], i: number, window = 60, recent = 5): number | null {
  if (i < window + recent) return null
  const hist: number[] = []
  for (let k = i - recent - window + 1; k <= i - recent; k++) {
    const b = bars[k]
    if (!Number.isFinite(b.v) || b.v <= 0) continue
    hist.push(b.c * b.v)
  }
  if (hist.length < 20) return null
  const mean = hist.reduce((a, b) => a + b, 0) / hist.length
  const varc = hist.reduce((a, b) => a + (b - mean) * (b - mean), 0) / hist.length
  const sd = Math.sqrt(varc)
  if (!Number.isFinite(sd) || sd <= 0) return null
  let rSum = 0
  let rN = 0
  for (let k = i - recent + 1; k <= i; k++) {
    const b = bars[k]
    if (!Number.isFinite(b.v) || b.v <= 0) continue
    rSum += b.c * b.v
    rN++
  }
  if (rN === 0) return null
  return (rSum / rN - mean) / sd
}

/**
 * 상대강도 — 같은 기간 벤치마크 대비 초과 수익률(%p).
 * 기관 자금은 시장을 이기는 쪽으로 흐른다는 관찰(오닐 RS)의 단순 구현.
 * 두 시계열의 날짜를 맞춰 비교한다.
 */
export function relativeStrength(
  bars: DailyBar[],
  bench: DailyBar[],
  period = 60,
): number | null {
  if (bars.length < period + 1 || bench.length < period + 1) return null
  const endDate = bars[bars.length - 1].date
  // 벤치마크에서 종목 마지막 날짜 이하의 마지막 봉을 찾는다(미래 봉 사용 금지).
  let bEnd = -1
  for (let k = bench.length - 1; k >= 0; k--) {
    if (bench[k].date <= endDate) {
      bEnd = k
      break
    }
  }
  if (bEnd < period) return null
  const aRet = (bars[bars.length - 1].c / bars[bars.length - 1 - period].c - 1) * 100
  const bRet = (bench[bEnd].c / bench[bEnd - period].c - 1) * 100
  if (!Number.isFinite(aRet) || !Number.isFinite(bRet)) return null
  return aRet - bRet
}

// ---- 종합 점수 -----------------------------------------------------------

export type FlowLabel = '강한 매집' | '매집 우위' | '중립' | '분산 우위' | '강한 분산' | '판단 불가'

export interface ScorePart {
  key: string
  label: string
  raw: number | null
  /** 고정 스케일로 -1~+1 정규화한 값 */
  norm: number | null
  weight: number
  /** 사람이 읽는 값 표기 */
  display: string
  /** 이 지표가 무엇을 보는지 */
  desc: string
}

export interface SmartMoneySnapshot {
  symbol: string
  asOf: string
  score: number | null // -100 ~ +100
  label: FlowLabel
  parts: ScorePart[]
  bars: number
}

// 정규화 스케일은 고정 상수 — 전체 구간 통계를 쓰면 그 자체가 미래 정보다(규칙 1-5).
// 값은 지표의 이론적/경험적 범위에서 잡았다.
const SCALE = {
  cmf: 0.15, //  ±0.15면 뚜렷한 매집/분산으로 본다
  obv: 0.5, //   기울기/평균거래량 ±0.5
  bigPrint: 0.2, // 종가 위치 편향 ±0.2 (레인지의 20%)
  turnZ: 2, //   거래대금 z ±2
  rs: 15, //     60일 초과수익 ±15%p
} as const

function clamp1(x: number): number {
  return Math.max(-1, Math.min(1, x))
}

export function labelFor(score: number | null): FlowLabel {
  if (score == null) return '판단 불가'
  if (score >= 45) return '강한 매집'
  if (score >= 15) return '매집 우위'
  if (score <= -45) return '강한 분산'
  if (score <= -15) return '분산 우위'
  return '중립'
}

/**
 * 한 종목의 큰손 자금 스냅샷.
 * 마지막 봉 기준으로 계산하며, 어떤 지표도 그 이후 데이터를 보지 않는다.
 *
 * 거래대금 z는 **방향이 아니라 세기**라서 종합 점수에 부호로 넣지 않는다.
 * 대신 다른 지표들이 만든 방향의 신뢰도를 키우는 증폭 계수로만 쓴다
 * (돈이 몰린 상태에서 나온 매집 신호가, 거래 없는 매집 신호보다 무겁다).
 */
export function smartMoneySnapshot(
  symbol: string,
  bars: DailyBar[],
  bench: DailyBar[] | null,
): SmartMoneySnapshot {
  const i = bars.length - 1
  const asOf = i >= 0 ? bars[i].date : '—'

  const cmf = chaikinMoneyFlow(bars, i, 20)
  const obv = obvTrend(bars, i, 60)
  const big = bigPrintBias(bars, i, 60, 0.2)
  const tz = turnoverZ(bars, i, 60, 5)
  const rs = bench && bench.length ? relativeStrength(bars, bench, 60) : null

  const parts: ScorePart[] = [
    {
      key: 'cmf',
      label: '자금흐름(CMF 20일)',
      raw: cmf,
      norm: cmf == null ? null : clamp1(cmf / SCALE.cmf),
      weight: 1.2,
      display: cmf == null ? '—' : `${cmf >= 0 ? '+' : ''}${(cmf * 100).toFixed(1)}%`,
      desc: '거래량이 실린 날 종가가 고가권이면 +, 저가권이면 −. 매집/분산의 1차 증거.',
    },
    {
      key: 'obv',
      label: 'OBV 추세(60일)',
      raw: obv,
      norm: obv == null ? null : clamp1(obv / SCALE.obv),
      weight: 1.0,
      display: obv == null ? '—' : `${obv >= 0 ? '+' : ''}${obv.toFixed(2)}`,
      desc: '누적 거래량의 방향. 가격은 제자리인데 OBV가 오르면 조용히 담기는 중.',
    },
    {
      key: 'bigPrint',
      label: '대량거래일 마감위치',
      raw: big,
      norm: big == null ? null : clamp1(big / SCALE.bigPrint),
      weight: 1.3,
      display: big == null ? '—' : `${big >= 0 ? '+' : ''}${(big * 100).toFixed(0)}%p`,
      desc: '거래대금 상위 20% 날만 골라 종가 위치를 봄. 큰돈이 급했던 방향.',
    },
    {
      key: 'rs',
      label: '상대강도(60일 초과)',
      raw: rs,
      norm: rs == null ? null : clamp1(rs / SCALE.rs),
      weight: 0.8,
      display: rs == null ? '—' : `${rs >= 0 ? '+' : ''}${rs.toFixed(1)}%p`,
      desc: '벤치마크 대비 초과 수익. 기관 자금은 이기는 쪽으로 흐르는 경향.',
    },
  ]

  let wSum = 0
  let w = 0
  for (const p of parts) {
    if (p.norm == null) continue
    wSum += p.norm * p.weight
    w += p.weight
  }
  // 방향 지표가 절반도 안 살아있으면 판단하지 않는다.
  let score: number | null = w >= 2 ? (wSum / w) * 100 : null

  // 거래대금 세기로 증폭(0.8~1.2배) — 방향은 바꾸지 않는다.
  if (score != null && tz != null) {
    const amp = 1 + clamp1(tz / SCALE.turnZ) * 0.2
    score = Math.max(-100, Math.min(100, score * amp))
  }

  parts.push({
    key: 'turnZ',
    label: '거래대금 z(60일)',
    raw: tz,
    norm: tz == null ? null : clamp1(tz / SCALE.turnZ),
    weight: 0, // 방향 아님 — 증폭 계수로만 사용
    display: tz == null ? '—' : `${tz >= 0 ? '+' : ''}${tz.toFixed(2)}σ`,
    desc: '자금 규모의 이례성. 방향이 아니라 세기라서 점수 방향엔 안 넣고 신뢰도만 조정.',
  })

  return { symbol, asOf, score, label: labelFor(score), parts, bars: bars.length }
}

// ---- 자금 로테이션 (위험선호 게이지) --------------------------------------

export interface RotationLeg {
  symbol: string
  label: string
  ret: number | null // period 수익률 %
}

export interface RotationGauge {
  riskOn: RotationLeg[]
  riskOff: RotationLeg[]
  spreadPct: number | null // 위험자산 평균 − 방어자산 평균
  stance: '위험선호' | '중립' | '위험회피' | '판단 불가'
  periodDays: number
}

export function periodReturn(bars: DailyBar[], days: number): number | null {
  if (bars.length < days + 1) return null
  const a = bars[bars.length - 1 - days].c
  const b = bars[bars.length - 1].c
  if (!Number.isFinite(a) || a <= 0 || !Number.isFinite(b)) return null
  return (b / a - 1) * 100
}

export function rotationGauge(
  riskOn: RotationLeg[],
  riskOff: RotationLeg[],
  periodDays: number,
): RotationGauge {
  const on = riskOn.filter((l) => l.ret != null).map((l) => l.ret as number)
  const off = riskOff.filter((l) => l.ret != null).map((l) => l.ret as number)
  if (!on.length || !off.length) {
    return { riskOn, riskOff, spreadPct: null, stance: '판단 불가', periodDays }
  }
  const avgOn = on.reduce((a, b) => a + b, 0) / on.length
  const avgOff = off.reduce((a, b) => a + b, 0) / off.length
  const spread = avgOn - avgOff
  const stance = spread >= 3 ? '위험선호' : spread <= -3 ? '위험회피' : '중립'
  return { riskOn, riskOff, spreadPct: spread, stance, periodDays }
}
