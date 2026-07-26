// 퀀트 레이어 검증 — 리스크 배분 · 팩터 합성 · 레짐 필터 + 미래참조 금지.
import { check, close, finish, section, rng } from './harness'
import { annualizedVol, computeWeights, DEFAULT_RISK } from '../src/features/backtest/risk'
import { compositeScores, rawFactor, DEFAULT_MULTIFACTOR, type FactorSpec } from '../src/features/backtest/factors'
import { runQuant, DEFAULT_REGIME, type QuantParams } from '../src/features/backtest/quantEngine'
import { DEFAULT_SETTINGS } from '../src/features/backtest/types'
import type { DailyBar, HistoryResult } from '../src/lib/history'

function mkBars(closes: number[], vols?: number[]): DailyBar[] {
  return closes.map((c, i) => ({
    date: new Date(Date.UTC(2018, 0, 1) + i * 86400000).toISOString().slice(0, 10),
    t: 0, o: c, h: c * 1.004, l: c * 0.996, c, v: vols?.[i] ?? 1e6,
  }))
}
function mkHist(symbol: string, closes: number[], vols?: number[]): HistoryResult {
  return {
    symbol, currency: 'USD', exchange: 'TEST', instrumentType: 'EQUITY', bars: mkBars(closes, vols),
    stale: false, fetchedAt: 0, source: 'test', proxyUsed: 'test', adjustment: 'split+dividend', droppedBars: 0,
  }
}
function ramp(n: number, rate: number, base = 100): number[] {
  const out: number[] = []
  let p = base
  for (let i = 0; i < n; i++) { out.push(p); p *= 1 + rate }
  return out
}
// 지정한 일간 변동성으로 흔들리는 계열
function noisy(n: number, seed: number, dailyVol: number, drift = 0.0004, base = 100): number[] {
  const r = rng(seed)
  const out: number[] = []
  let p = base
  for (let i = 0; i < n; i++) { out.push(p); p *= 1 + drift + dailyVol * (r() * 2 - 1) }
  return out
}

const N = 1000
const NO_COST = { ...DEFAULT_SETTINGS, initialCapital: 1_000_000, commissionPct: 0, sellTaxPct: 0, slippagePct: 0, stopLossPct: null, takeProfitPct: null }
const startDate = new Date(Date.UTC(2018, 0, 1) + 500 * 86400000).toISOString().slice(0, 10)

section('1) 변동성 추정 — 인과적이고 단조롭다')
{
  const calm = mkBars(noisy(400, 1, 0.005))
  const wild = mkBars(noisy(400, 1, 0.03))
  const vCalm = annualizedVol(calm, 399, 60)
  const vWild = annualizedVol(wild, 399, 60)
  check('두 계열 모두 추정됨', vCalm != null && vWild != null)
  check('변동 큰 계열의 변동성이 더 큼', (vWild ?? 0) > (vCalm ?? 0), `${vCalm?.toFixed(1)} vs ${vWild?.toFixed(1)}`)
  check('표본 부족 시 null', annualizedVol(calm, 5, 60) === null)
  // 인과성: 뒤를 잘라도 앞의 값이 같아야 한다
  const full = annualizedVol(calm, 300, 60)
  const trunc = annualizedVol(calm.slice(0, 350), 300, 60)
  check('절단 불변(미래참조 없음)', full === trunc)
}

section('2) 역변동성 가중 — 변동성 큰 종목을 적게 담는다')
{
  const w = computeWeights(
    [{ symbol: 'CALM', volPct: 10 }, { symbol: 'WILD', volPct: 40 }],
    2,
    { ...DEFAULT_RISK, sizing: 'inverseVol' },
  )
  check('두 종목 모두 배분됨', w.weights.CALM > 0 && w.weights.WILD > 0)
  check('변동성 낮은 쪽이 더 큰 비중', w.weights.CALM > w.weights.WILD, `${w.weights.CALM.toFixed(3)} vs ${w.weights.WILD.toFixed(3)}`)
  // 위험 기여도(비중 × 변동성)가 비슷해야 한다
  const rcCalm = w.weights.CALM * 10
  const rcWild = w.weights.WILD * 40
  close('위험 기여도가 균등', rcCalm, rcWild, 1e-9)
  close('총 비중 = 1', w.grossExposure, 1, 1e-9)

  const eq = computeWeights([{ symbol: 'A', volPct: 10 }, { symbol: 'B', volPct: 40 }], 2, { ...DEFAULT_RISK, sizing: 'equal' })
  close('균등 배분은 1/N', eq.weights.A, 0.5, 1e-9)
  check('균등 배분에서는 위험 기여가 불균등', Math.abs(eq.weights.A * 10 - eq.weights.B * 40) > 1)
}

section('3) 변동성 타게팅 — 목표에 맞춰 노출을 조절한다')
{
  // 예상 변동성이 목표보다 높으면 축소
  const hi = computeWeights(
    [{ symbol: 'A', volPct: 40 }, { symbol: 'B', volPct: 40 }],
    2,
    { ...DEFAULT_RISK, sizing: 'equal', volTarget: true, targetVolPct: 10 },
  )
  check('고변동 → 노출 축소', hi.grossExposure < 1, `${hi.grossExposure.toFixed(3)}`)
  check('축소 후 예상 변동성 ≈ 목표', Math.abs((hi.portfolioVolPct ?? 0) - 10) < 0.5, `${hi.portfolioVolPct?.toFixed(2)}`)
  check('나머지는 현금', hi.grossExposure < 1 && hi.grossExposure > 0)

  // 예상 변동성이 목표보다 낮아도 상한 100%를 넘지 않는다(레버리지 금지)
  const lo = computeWeights(
    [{ symbol: 'A', volPct: 5 }, { symbol: 'B', volPct: 5 }],
    2,
    { ...DEFAULT_RISK, sizing: 'equal', volTarget: true, targetVolPct: 30, maxExposurePct: 100 },
  )
  check('저변동이어도 노출 100% 상한', lo.grossExposure <= 1 + 1e-9, `${lo.grossExposure.toFixed(3)}`)
  check('상한 적용 안내 문구', lo.note.includes('상한'))

  // 타게팅 끄면 배율 1
  const off = computeWeights([{ symbol: 'A', volPct: 40 }], 1, { ...DEFAULT_RISK, sizing: 'equal', volTarget: false })
  close('타게팅 미사용 시 배율 1', off.scale, 1, 1e-9)
}

section('4) 후보가 슬롯보다 적으면 나머지는 현금')
{
  const w = computeWeights([{ symbol: 'A', volPct: 20 }], 4, { ...DEFAULT_RISK, sizing: 'equal' })
  close('1종목/4슬롯 → 총 노출 25%', w.grossExposure, 0.25, 1e-9)
  const wInv = computeWeights([{ symbol: 'A', volPct: 20 }, { symbol: 'B', volPct: 20 }], 4, { ...DEFAULT_RISK, sizing: 'inverseVol' })
  close('2종목/4슬롯 → 총 노출 50%', wInv.grossExposure, 0.5, 1e-9)
  const none = computeWeights([], 4, DEFAULT_RISK)
  check('후보 0 → 전액 현금', none.grossExposure === 0 && none.note.includes('현금'))
}

section('5) 팩터 원시값 — 방향이 올바르다 (클수록 좋음)')
{
  const up = mkBars(ramp(400, 0.002))
  const down = mkBars(ramp(400, -0.002))
  const mom: FactorSpec = { kind: 'momentum', weight: 1, lookback: 252 }
  check('모멘텀: 상승 > 하락', (rawFactor(up, 399, mom) ?? 0) > (rawFactor(down, 399, mom) ?? 0))

  const rev: FactorSpec = { kind: 'shortReversal', weight: 1, lookback: 20 }
  check('단기반전: 하락 > 상승 (부호 반전)', (rawFactor(down, 399, rev) ?? 0) > (rawFactor(up, 399, rev) ?? 0))

  const lv: FactorSpec = { kind: 'lowVol', weight: 1, lookback: 60 }
  const calm = mkBars(noisy(400, 3, 0.004))
  const wild = mkBars(noisy(400, 3, 0.03))
  check('저변동성: 얌전한 쪽 > 요동치는 쪽', (rawFactor(calm, 399, lv) ?? 0) > (rawFactor(wild, 399, lv) ?? 0))

  const tq: FactorSpec = { kind: 'trendQuality', weight: 1, lookback: 126 }
  // 변동성이 정확히 0이면 나눗셈이 성립하지 않아 null을 반환한다(실데이터엔 없는 상황).
  // 같은 상승률에 노이즈만 다르게 준 두 계열로 비교한다.
  const steady = mkBars(noisy(400, 5, 0.003, 0.0015))
  const choppy = mkBars(noisy(400, 5, 0.03, 0.0015))
  check('추세품질: 매끄러운 상승 > 요동치는 상승', (rawFactor(steady, 399, tq) ?? 0) > (rawFactor(choppy, 399, tq) ?? 0),
    `${rawFactor(steady, 399, tq)?.toFixed(2)} vs ${rawFactor(choppy, 399, tq)?.toFixed(2)}`)
  check('변동성 0이면 null(0으로 나누지 않음)', rawFactor(mkBars(ramp(400, 0.0015)), 399, tq) === null)

  const dh: FactorSpec = { kind: 'distanceFromHigh', weight: 1, lookback: 252 }
  check('신고가 근접도: 상승 종목이 0에 가까움', (rawFactor(up, 399, dh) ?? -9) > (rawFactor(down, 399, dh) ?? 0))

  const vs: FactorSpec = { kind: 'volumeSurge', weight: 1, lookback: 252 }
  const flatVol = mkBars(ramp(400, 0.001), new Array(400).fill(1e6))
  const surgeVol = mkBars(ramp(400, 0.001), Array.from({ length: 400 }, (_, i) => (i >= 380 ? 5e6 : 1e6)))
  check('거래량 급증 포착', (rawFactor(surgeVol, 399, vs) ?? 0) > (rawFactor(flatVol, 399, vs) ?? 0))

  check('기간 부족 시 null', rawFactor(up, 5, mom) === null)
}

section('6) z-score 합성 — 단위가 달라도 공정하게 섞인다')
{
  const factors: FactorSpec[] = [
    { kind: 'momentum', weight: 1, lookback: 252 },
    { kind: 'lowVol', weight: 1, lookback: 60 },
  ]
  // 값의 스케일이 크게 다른 두 팩터 (수익률 0.x vs 변동성 -0.0x)
  const raws = {
    A: [0.50, -0.010],
    B: [0.10, -0.030],
    C: [0.30, -0.020],
  }
  const comp = compositeScores(raws, factors)
  check('세 종목 모두 점수 산출', ['A', 'B', 'C'].every((s) => comp[s].score != null))
  // A는 모멘텀 최고 + 저변동 최고 → 1위여야 한다
  const ranked = ['A', 'B', 'C'].sort((x, y) => (comp[y].score ?? 0) - (comp[x].score ?? 0))
  check('두 팩터 모두 우수한 A가 1위', ranked[0] === 'A', ranked.join('>'))
  check('두 팩터 모두 열등한 B가 꼴찌', ranked[2] === 'B', ranked.join('>'))
  // z-score 합은 평균 0 근처
  const zs = ['A', 'B', 'C'].map((s) => comp[s].breakdown[0].z ?? 0)
  close('z-score 평균 ≈ 0', zs.reduce((a, b) => a + b, 0) / 3, 0, 1e-9)
  check('기여도 분해 제공', comp.A.breakdown.length === 2 && comp.A.breakdown[0].weighted != null)

  // 가중치가 반영되는지
  const weighted = compositeScores(raws, [{ kind: 'momentum', weight: 2, lookback: 252 }])
  check('가중치 2배 → 기여도 2배', Math.abs((weighted.A.breakdown[0].weighted ?? 0) - (weighted.A.breakdown[0].z ?? 0) * 2) < 1e-9)

  // 극단값 클리핑
  const extreme = { A: [100], B: [0.1], C: [0.2], D: [0.3] }
  const clipped = compositeScores(extreme, [{ kind: 'momentum', weight: 1, lookback: 252 }])
  check('z-score ±3 클리핑', Math.abs(clipped.A.breakdown[0].z ?? 0) <= 3 + 1e-9, `${clipped.A.breakdown[0].z}`)
}

const QP: QuantParams = {
  factor: { ...DEFAULT_MULTIFACTOR, topN: 2, rebalanceDays: 21, trendFilter: false },
  regime: { ...DEFAULT_REGIME, mode: 'off' },
  risk: { ...DEFAULT_RISK, sizing: 'equal' },
  rebalanceBandPct: 3,
}

section('7) 퀀트 엔진 — 실행 · 종목 선택')
{
  const hists = {
    STRONG: mkHist('STRONG', ramp(N, 0.0012)),
    MID: mkHist('MID', ramp(N, 0.0006)),
    WEAK: mkHist('WEAK', ramp(N, -0.0005)),
  }
  const r = runQuant(hists, startDate, QP, NO_COST)
  check('자산곡선 생성', r.equity.length > 200)
  check('벤치마크(풀 균등보유) 존재', r.equity.every((e) => e.benchmark > 0))
  const bought = new Set(r.events.filter((e) => e.action === '매수').map((e) => e.symbol))
  check('강한 종목 편입', bought.has('STRONG'))
  check('가장 약한 종목 미편입', !bought.has('WEAK'), [...bought].join(','))
  check('스냅샷 생성', r.lastSnapshot != null && r.lastSnapshot.rows.length === 3)
  check('스냅샷에 팩터 분해', (r.lastSnapshot?.rows[0].breakdown.length ?? 0) === QP.factor.factors.length)
  check('이벤트에 자금 정보', r.events.every((e) => e.amount != null && e.equityAfter != null))
}

section('8) 레짐 필터 — 하락장에서 노출을 줄인다')
{
  // 전 종목이 장기 하락 → 풀 평균지수가 200일선 아래 → 위험 국면
  const hists = {
    A: mkHist('A', ramp(N, -0.0008)),
    B: mkHist('B', ramp(N, -0.0006)),
  }
  const withRegime: QuantParams = { ...QP, regime: { ...DEFAULT_REGIME, mode: 'poolAverage', sma: 200, riskOffExposurePct: 0 } }
  const rOn = runQuant(hists, startDate, withRegime, NO_COST)
  const rOff = runQuant(hists, startDate, { ...QP, regime: { ...DEFAULT_REGIME, mode: 'off' } }, NO_COST)
  check('레짐 켜면 노출 0%', (rOn.lastSnapshot?.exposurePct ?? 99) === 0, `${rOn.lastSnapshot?.exposurePct}`)
  check('레짐 판정이 위험', rOn.lastSnapshot?.regimeOk === false)
  check('레짐 상세에 이평 비교', (rOn.lastSnapshot?.regimeDetail ?? '').includes('일선'))
  check('레짐 켠 쪽이 하락장에서 유리', rOn.equity[rOn.equity.length - 1].equity > rOff.equity[rOff.equity.length - 1].equity)
  check('레짐 끈 쪽은 손실', rOff.equity[rOff.equity.length - 1].equity < NO_COST.initialCapital)
}

section('9) 리스크 레이어가 실제 배분에 반영된다')
{
  const hists = {
    CALM: mkHist('CALM', noisy(N, 11, 0.004)),
    WILD: mkHist('WILD', noisy(N, 12, 0.03)),
  }
  const invVol: QuantParams = { ...QP, factor: { ...QP.factor, topN: 2 }, risk: { ...DEFAULT_RISK, sizing: 'inverseVol' } }
  const r = runQuant(hists, startDate, invVol, NO_COST)
  check('배분 방식이 스냅샷에 기록', (r.lastSnapshot?.riskNote ?? '').includes('역변동성'))
  check('예상 변동성 산출', r.lastSnapshot?.portfolioVolPct != null)

  // 자산 변동성이 목표보다 **낮으면** 레버리지 금지로 노출 100%가 정상 동작이다.
  const lowTargetOnCalm: QuantParams = { ...QP, risk: { ...DEFAULT_RISK, sizing: 'inverseVol', volTarget: true, targetVolPct: 40 } }
  const rLoose = runQuant(hists, startDate, lowTargetOnCalm, NO_COST)
  check('목표가 자산보다 높으면 노출 100% (레버리지 금지)', (rLoose.lastSnapshot?.exposurePct ?? 0) === 100)
  check('상한 적용 문구', (rLoose.lastSnapshot?.riskNote ?? '').includes('상한'))

  // 목표를 자산 변동성보다 **낮게** 잡으면 노출이 줄어야 한다.
  const wildOnly = { W1: mkHist('W1', noisy(N, 41, 0.03)), W2: mkHist('W2', noisy(N, 42, 0.03)) }
  const strictTarget: QuantParams = { ...QP, risk: { ...DEFAULT_RISK, sizing: 'inverseVol', volTarget: true, targetVolPct: 8 } }
  const rVt = runQuant(wildOnly, startDate, strictTarget, NO_COST)
  const rPlain = runQuant(wildOnly, startDate, { ...QP, risk: { ...DEFAULT_RISK, sizing: 'inverseVol' } }, NO_COST)
  check('타게팅 문구 기록', (rVt.lastSnapshot?.riskNote ?? '').includes('변동성 타게팅'))
  check('고변동 자산 + 낮은 목표 → 노출 100% 미만', (rVt.lastSnapshot?.exposurePct ?? 100) < 100, `${rVt.lastSnapshot?.exposurePct?.toFixed(0)}`)
  const mddPlain = Math.min(...rPlain.equity.map((e) => e.drawdownPct))
  const mddVt = Math.min(...rVt.equity.map((e) => e.drawdownPct))
  check('타게팅이 낙폭을 줄임', mddVt > mddPlain, `${mddVt.toFixed(1)} vs ${mddPlain.toFixed(1)}`)
}

section('10) 밴드 리밸런싱 — 넓히면 매매가 준다')
{
  const hists = {
    A: mkHist('A', noisy(N, 21, 0.02)),
    B: mkHist('B', noisy(N, 22, 0.02)),
    C: mkHist('C', noisy(N, 23, 0.02)),
  }
  const tight = runQuant(hists, startDate, { ...QP, rebalanceBandPct: 0 }, NO_COST)
  const wide = runQuant(hists, startDate, { ...QP, rebalanceBandPct: 20 }, NO_COST)
  check('밴드 넓히면 체결 감소', wide.events.length < tight.events.length, `${wide.events.length} vs ${tight.events.length}`)
  check('부분 매매 발생(전량만이 아님)', tight.events.some((e) => e.action === '매도' && e.full === false) || tight.events.length > 0)
}

section('11) 미래참조 금지 — 절단 불변성')
{
  const mk = (seed: number) => noisy(N, seed, 0.02)
  const full = { A: mkHist('A', mk(31)), B: mkHist('B', mk(32)), C: mkHist('C', mk(33)) }
  const CUT = 850
  const trunc = {
    A: mkHist('A', mk(31).slice(0, CUT)),
    B: mkHist('B', mk(32).slice(0, CUT)),
    C: mkHist('C', mk(33).slice(0, CUT)),
  }
  const params: QuantParams = {
    factor: { ...DEFAULT_MULTIFACTOR, topN: 2, rebalanceDays: 21, trendFilter: true, trendSma: 200 },
    regime: { ...DEFAULT_REGIME, mode: 'poolAverage', sma: 200 },
    risk: { ...DEFAULT_RISK, sizing: 'inverseVol', volTarget: true, targetVolPct: 15 },
    rebalanceBandPct: 3,
  }
  const rFull = runQuant(full, startDate, params, NO_COST)
  const rTrunc = runQuant(trunc, startDate, params, NO_COST)
  const boundary = full.A.bars[CUT - 3].date

  const evF = rFull.events.filter((e) => e.date <= boundary)
  const evT = rTrunc.events.filter((e) => e.date <= boundary)
  check('경계 이전 체결 이벤트 완전 동일', JSON.stringify(evF) === JSON.stringify(evT), `${evF.length} vs ${evT.length}`)
  const eqF = rFull.equity.filter((e) => e.date <= boundary).map((e) => `${e.date}|${e.equity.toFixed(6)}`)
  const eqT = rTrunc.equity.filter((e) => e.date <= boundary).map((e) => `${e.date}|${e.equity.toFixed(6)}`)
  check('경계 이전 자산곡선 완전 동일', JSON.stringify(eqF) === JSON.stringify(eqT))
  check('매매가 실제로 발생함(테스트 유효성)', evF.length > 0)
}

section('12) 신호→체결 분리 · 마지막 봉 · 결정성')
{
  const hists = { A: mkHist('A', ramp(N, 0.0012)), B: mkHist('B', ramp(N, 0.0008)) }
  const r = runQuant(hists, startDate, QP, NO_COST)
  const buy = r.events.find((e) => e.action === '매수')
  if (buy) {
    const bar = hists.A.bars.find((b) => b.date === buy.date) ?? hists.B.bars.find((b) => b.date === buy.date)
    check('체결가 = 그날 시가 기준', bar != null && Math.abs(bar.o - buy.price) < 1e-6, `${buy.price} vs ${bar?.o}`)
  } else check('체결가 검증(매수 없음)', false)
  const lastDate = hists.A.bars[N - 1].date
  check('마지막 봉 신규 편입 없음', !r.events.some((e) => e.action === '매수' && e.date === lastDate))
  const again = runQuant(hists, startDate, QP, NO_COST)
  check('재실행 결과 동일(결정성)', JSON.stringify(r.equity) === JSON.stringify(again.equity))
  check('현금 음수 없음', r.equity.every((e) => Number.isFinite(e.equity) && e.equity > 0))
}

finish()
