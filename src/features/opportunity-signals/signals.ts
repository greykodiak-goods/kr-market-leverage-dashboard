import type { IndicatorResult } from '../../lib/indicators'
import type { Quote } from '../../lib/quotes'
import type { CreditPoint } from '../../types'
import { formatPercent, formatSignedPercent } from '../../lib/format'

export type SignalTone = 'watch-up' | 'watch-risk' | 'neutral'

export interface Signal {
  id: string
  label: string
  met: boolean
  detail: string
  tone: SignalTone
}

export interface SignalInputs {
  ind: IndicatorResult | null // hynix 000660 indicators
  fiftyTwoWeekLow: number | null
  price: number | null
  rsTrend: 'up' | 'down' | 'flat' | null
  vix: Quote | null // ^VIX (1M) for peak-pass
  krw: Quote | null // USD/KRW
  tnx: Quote | null // ^TNX
  adrPremiumPct: number | null
  lendingDrop5Pct?: number | null // hynix 대차잔고 최근 5일 % 변화
  creditPulse?: CreditPulse | null // 시장 신용융자 잔고 일간 증감 z-score (FreeSIS LIVE)
  kospi?: Quote | null // ^KS11 (1D) — 청산 소진 후 반등 동반 확인용
}

// 신용융자 잔고 일간 증감의 z-score (window일 기준). 시장 전체 기준 —
// 종목별 신용잔고는 FreeSIS 미제공이라 하이닉스 버전은 데이터 확보 전 불가.
export interface CreditPulse {
  z: number | null // 최신 일간 증감의 z-score
  deltaEok: number | null // 최신 일간 증감(억원)
  asOf: string | null // 신용 데이터 기준일 (보통 1~2영업일 지연)
  live: boolean // SEED 샘플 기반이면 false (신호 판정 제외)
}

export function computeCreditPulse(series: CreditPoint[], live: boolean, window = 60): CreditPulse {
  if (series.length < window + 2) return { z: null, deltaEok: null, asOf: null, live }
  const tail = series.slice(-(window + 1)).map((p) => p.total)
  const diffs: number[] = []
  for (let i = 1; i < tail.length; i++) diffs.push(tail[i] - tail[i - 1])
  const latest = diffs[diffs.length - 1]
  const mean = diffs.reduce((s, v) => s + v, 0) / diffs.length
  const variance = diffs.reduce((s, v) => s + (v - mean) ** 2, 0) / diffs.length
  const std = Math.sqrt(variance)
  return {
    z: std > 0 ? (latest - mean) / std : null,
    deltaEok: latest,
    asOf: series[series.length - 1].date,
    live,
  }
}

function smaVal(ind: IndicatorResult | null, period: number): number | null {
  return ind?.sma.find((s) => s.period === period)?.value ?? null
}

// Pure evaluation of technical observation points. Observation only — NOT advice.
export function computeSignals(inp: SignalInputs): Signal[] {
  const out: Signal[] = []
  const rsi = inp.ind?.rsi ?? null
  const sma20 = smaVal(inp.ind, 20)
  const sma60 = smaVal(inp.ind, 60)

  // 1) 과매도 (RSI < 30)
  out.push({
    id: 'oversold',
    label: 'RSI 과매도 (<30)',
    met: rsi != null && rsi < 30,
    detail: rsi != null ? `RSI ${rsi.toFixed(1)}` : '데이터 대기',
    tone: 'watch-up',
  })

  // 2) 52주 저점 +10% 이내
  let low10 = false
  let lowDetail = '데이터 대기'
  if (inp.price != null && inp.fiftyTwoWeekLow != null && inp.fiftyTwoWeekLow > 0) {
    const gap = (inp.price - inp.fiftyTwoWeekLow) / inp.fiftyTwoWeekLow
    low10 = gap <= 0.1
    lowDetail = `저점 대비 +${formatPercent(gap * 100, 1)}`
  }
  out.push({ id: 'near52wLow', label: '52주 저점 +10% 이내', met: low10, detail: lowDetail, tone: 'watch-up' })

  // 3) 골든크로스 (20일선 > 60일선)
  out.push({
    id: 'golden',
    label: '골든크로스 (SMA20 > SMA60)',
    met: sma20 != null && sma60 != null && sma20 > sma60,
    detail: sma20 != null && sma60 != null ? `20:${Math.round(sma20).toLocaleString()} / 60:${Math.round(sma60).toLocaleString()}` : '데이터 대기',
    tone: 'watch-up',
  })

  // 4) VIX 정점 통과 (최근 고점 대비 -15%, 고점 > 20)
  let vixPass = false
  let vixDetail = '데이터 대기'
  if (inp.vix?.intraday?.length) {
    const vals = inp.vix.intraday.map((p) => p.price)
    const peak = Math.max(...vals)
    const cur = inp.vix.price
    vixPass = peak > 20 && cur < peak * 0.85
    vixDetail = `VIX ${cur.toFixed(1)} (기간 고점 ${peak.toFixed(1)})`
  }
  out.push({ id: 'vixPeak', label: 'VIX 정점 통과(불안 완화)', met: vixPass, detail: vixDetail, tone: 'watch-up' })

  // 5) 하이닉스 RS > SOX (상대강세)
  out.push({
    id: 'rsStrong',
    label: '하이닉스 RS 상승 (vs SOX)',
    met: inp.rsTrend === 'up',
    detail: inp.rsTrend ? `추세 ${inp.rsTrend === 'up' ? '강세' : inp.rsTrend === 'down' ? '약세' : '중립'}` : '데이터 대기',
    tone: 'watch-up',
  })

  // 6) ADR 프리미엄 급변 (|프리미엄| > 25%)
  out.push({
    id: 'adrPremium',
    label: 'ADR 프리미엄 급변 (±25%↑)',
    met: inp.adrPremiumPct != null && Math.abs(inp.adrPremiumPct) > 25,
    detail: inp.adrPremiumPct != null ? `프리미엄 ${formatPercent(inp.adrPremiumPct, 1)}` : '데이터 대기',
    tone: 'watch-risk',
  })

  // 7) USD/KRW 급등 (당일 +0.5%↑)
  out.push({
    id: 'krwSpike',
    label: 'USD/KRW 급등 (+0.5%↑)',
    met: inp.krw != null && inp.krw.changePct > 0.5,
    detail: inp.krw != null ? `환율 ${Math.round(inp.krw.price).toLocaleString()} (${formatSignedPercent(inp.krw.changePct)})` : '데이터 대기',
    tone: 'watch-risk',
  })

  // 8) 미 10년물 금리 급등 (당일 +2%↑)
  out.push({
    id: 'tnxSpike',
    label: '미 10년물 금리 급등 (+2%↑)',
    met: inp.tnx != null && inp.tnx.changePct > 2,
    detail: inp.tnx != null ? `${formatPercent(inp.tnx.price)} (${formatSignedPercent(inp.tnx.changePct)})` : '데이터 대기',
    tone: 'watch-risk',
  })

  // 9) 대차잔고 급감 = 숏 상환(커버) 관찰 (최근 5일 −5%↓)
  out.push({
    id: 'lendingDrop',
    label: '대차잔고 급감 (상환 관찰, 5일 −5%↓)',
    met: inp.lendingDrop5Pct != null && inp.lendingDrop5Pct <= -5,
    detail: inp.lendingDrop5Pct != null ? `대차잔고 5일 ${formatSignedPercent(inp.lendingDrop5Pct, 1)}` : '데이터 대기',
    tone: 'watch-up',
  })

  // 10) 레버리지 청산(디레버리징) 소진 관찰 — 시장 신용융자 일간 급감(z ≤ −2, 60일 기준)
  //     + KOSPI 당일 급등(+1.5%↑) 동반 시 "청산 소진 후 반등 국면 관찰". 임계값은
  //     관행적 기준(2σ)이며 매매 신호가 아니다. 신용 데이터는 1~2영업일 지연(기준일 표기).
  {
    const pulse = inp.creditPulse ?? null
    const z = pulse?.live ? pulse.z : null // SEED 샘플 기반이면 판정하지 않음
    const kospiPct = inp.kospi?.changePct ?? null
    const met = z != null && z <= -2 && kospiPct != null && kospiPct >= 1.5
    let detail = '데이터 대기'
    if (pulse && !pulse.live) detail = '신용융자 데이터 샘플 — LIVE 전환 시 판정'
    else if (z != null) {
      detail = `신용융자 일간증감 z ${z.toFixed(2)} (기준일 ${pulse?.asOf ?? '—'}) · KOSPI ${
        kospiPct != null ? formatSignedPercent(kospiPct, 1) : '—'
      }`
    }
    out.push({
      id: 'deleverageRebound',
      label: '레버리지 청산 소진 관찰 (신용급감 z−2 + KOSPI +1.5%↑)',
      met,
      detail,
      tone: 'watch-up',
    })
  }

  return out
}
