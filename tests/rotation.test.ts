// 종목선정(로테이션) 엔진 검증 — 선정 로직 + 미래참조 금지.
import { check, close, finish, section, rng } from './harness'
import { runRotation, DEFAULT_ROTATION, type RotationParams } from '../src/features/backtest/rotation'
import { DEFAULT_SETTINGS } from '../src/features/backtest/types'
import type { DailyBar, HistoryResult } from '../src/lib/history'

function mkHist(symbol: string, closes: number[]): HistoryResult {
  const bars: DailyBar[] = closes.map((c, i) => ({
    date: new Date(Date.UTC(2018, 0, 1) + i * 86400000).toISOString().slice(0, 10),
    t: 0,
    o: c,
    h: c * 1.005,
    l: c * 0.995,
    c,
    v: 1e6,
  }))
  return {
    symbol,
    currency: 'USD',
    exchange: 'TEST',
    instrumentType: 'ETF',
    bars,
    stale: false,
    fetchedAt: 0,
    source: 'test',
    proxyUsed: 'test',
    adjustment: 'split+dividend',
    droppedBars: 0,
  }
}

function ramp(n: number, dailyRate: number, base = 100): number[] {
  const out: number[] = []
  let p = base
  for (let i = 0; i < n; i++) {
    out.push(p)
    p *= 1 + dailyRate
  }
  return out
}

const N = 900
const NO_COST = { ...DEFAULT_SETTINGS, initialCapital: 1_000_000, commissionPct: 0, sellTaxPct: 0, slippagePct: 0 }
const P: RotationParams = { ...DEFAULT_ROTATION, lookbackDays: 252, skipDays: 0, topN: 1, rebalanceDays: 21, absoluteFilter: 'none' }
const startDate = new Date(Date.UTC(2018, 0, 1) + 300 * 86400000).toISOString().slice(0, 10)

section('1) 상대 모멘텀 — 가장 강한 종목을 고른다')
{
  const hist = {
    STRONG: mkHist('STRONG', ramp(N, 0.0012)),
    MID: mkHist('MID', ramp(N, 0.0005)),
    WEAK: mkHist('WEAK', ramp(N, 0.0001)),
  }
  const r = runRotation(hist, startDate, P, NO_COST)
  const bought = new Set(r.events.filter((e) => e.action === '매수').map((e) => e.symbol))
  check('가장 강한 종목만 매수', bought.size === 1 && bought.has('STRONG'), [...bought].join(','))
  check('약한 종목은 매수 안 함', !bought.has('WEAK') && !bought.has('MID'))
  check('최신 선정에서 STRONG이 1위', r.lastSelection[0]?.symbol === 'STRONG', r.lastSelection.map((c) => c.symbol).join(','))
  check('순위가 매겨짐', r.lastSelection[0]?.rank === 1)
  check('자산곡선 생성', r.equity.length > 100)
  check('벤치마크(풀 균등보유) 존재', r.equity.every((e) => e.benchmark > 0))
  check('강세 선택이 균등보유를 이김', r.equity[r.equity.length - 1].equity > r.equity[r.equity.length - 1].benchmark)
}

section('2) 절대 모멘텀 게이트 — 전부 하락이면 현금')
{
  const hist = {
    DOWN1: mkHist('DOWN1', ramp(N, -0.0008)),
    DOWN2: mkHist('DOWN2', ramp(N, -0.0005)),
  }
  const r = runRotation(hist, startDate, { ...P, absoluteFilter: 'positive' }, NO_COST)
  check('매수가 한 건도 없음', r.events.filter((e) => e.action === '매수').length === 0)
  close('자산 = 초기자본 유지(현금)', r.equity[r.equity.length - 1].equity, NO_COST.initialCapital, 1)
  check('벤치마크는 손실', r.equity[r.equity.length - 1].benchmark < NO_COST.initialCapital)
  check('현금 방어가 균등보유보다 우수', r.equity[r.equity.length - 1].equity > r.equity[r.equity.length - 1].benchmark)
  check('전 후보 탈락 사유 기록', r.lastSelection.every((c) => !c.passed && c.reasons.length > 0))
  check('탈락 사유가 절대 모멘텀', r.lastSelection.some((c) => c.reasons.some((x) => x.includes('절대 모멘텀'))))
}

section('3) 게이트를 끄면 하락장에서도 산다 (필터 효과 확인)')
{
  const hist = { DOWN1: mkHist('DOWN1', ramp(N, -0.0008)), DOWN2: mkHist('DOWN2', ramp(N, -0.0005)) }
  const r = runRotation(hist, startDate, { ...P, absoluteFilter: 'none' }, NO_COST)
  check('게이트 없으면 매수 발생', r.events.filter((e) => e.action === '매수').length > 0)
  check('덜 나쁜 종목을 선택', r.events.find((e) => e.action === '매수')?.symbol === 'DOWN2')
  check('게이트 없이는 손실', r.equity[r.equity.length - 1].equity < NO_COST.initialCapital)
}

section('4) Top-N 분산 — N=2면 두 종목 보유')
{
  const hist = {
    A: mkHist('A', ramp(N, 0.0012)),
    B: mkHist('B', ramp(N, 0.0010)),
    C: mkHist('C', ramp(N, 0.0002)),
  }
  const r = runRotation(hist, startDate, { ...P, topN: 2 }, NO_COST)
  const bought = new Set(r.events.filter((e) => e.action === '매수').map((e) => e.symbol))
  check('상위 2종목 보유', bought.has('A') && bought.has('B'), [...bought].join(','))
  check('3위는 미보유', !bought.has('C'))
  const open = r.trades.filter((t) => t.exitDate == null)
  check('미청산 보유 2건', open.length === 2, `${open.length}`)
}

section('5) 이동평균 필터 (aboveSMA)')
{
  // 전반 상승 후 급락 → 200일선 아래로 내려가면 제외되어야 한다
  const up = ramp(600, 0.0015)
  const down = ramp(300, -0.004, up[up.length - 1])
  const hist = { X: mkHist('X', [...up, ...down]), Y: mkHist('Y', ramp(900, 0.0001)) }
  const r = runRotation(hist, startDate, { ...P, absoluteFilter: 'aboveSMA', absSmaPeriod: 200, topN: 1 }, NO_COST)
  const sells = r.events.filter((e) => e.action === '매도' && e.symbol === 'X')
  check('급락 후 X 매도 발생', sells.length > 0)
  check('탈락 사유에 이평 언급', r.lastSelection.some((c) => c.reasons.some((x) => x.includes('일선'))))
}

section('6) 미너비니 추세 템플릿 — 조건 미달 종목 배제')
{
  // 계속 하락하는 종목은 7조건을 통과할 수 없다
  const hist = {
    GOOD: mkHist('GOOD', ramp(N, 0.0012)),
    BAD: mkHist('BAD', ramp(N, -0.0010)),
  }
  const r = runRotation(hist, startDate, { ...P, trendTemplate: true, absoluteFilter: 'none', topN: 2 }, NO_COST)
  const bought = new Set(r.events.filter((e) => e.action === '매수').map((e) => e.symbol))
  check('상승 종목만 편입', bought.has('GOOD') && !bought.has('BAD'), [...bought].join(','))
  const badCand = r.lastSelection.find((c) => c.symbol === 'BAD')
  check('하락 종목 탈락', badCand != null && !badCand.passed)
  check('탈락 사유가 구체적', (badCand?.reasons.length ?? 0) > 0, badCand?.reasons.join(' / '))
  const goodCand = r.lastSelection.find((c) => c.symbol === 'GOOD')
  check('상승 종목은 통과', goodCand?.passed === true, goodCand?.reasons.join(' / '))
}

section('7) 미래참조 금지 — 절단 불변성')
{
  const rnd = rng(777)
  const mk = (seed: number) => {
    const r2 = rng(seed)
    const out: number[] = []
    let p = 100
    for (let i = 0; i < N; i++) {
      out.push(p)
      p *= 1 + 0.0004 + 0.02 * (r2() * 2 - 1)
    }
    return out
  }
  const full = { A: mkHist('A', mk(1)), B: mkHist('B', mk(2)), C: mkHist('C', mk(3)) }
  const CUT = 700
  const trunc = {
    A: mkHist('A', mk(1).slice(0, CUT)),
    B: mkHist('B', mk(2).slice(0, CUT)),
    C: mkHist('C', mk(3).slice(0, CUT)),
  }
  void rnd
  const params = { ...P, absoluteFilter: 'positive' as const, topN: 1 }
  const rFull = runRotation(full, startDate, params, NO_COST)
  const rTrunc = runRotation(trunc, startDate, params, NO_COST)
  const boundary = full.A.bars[CUT - 3].date

  const evF = rFull.events.filter((e) => e.date <= boundary)
  const evT = rTrunc.events.filter((e) => e.date <= boundary)
  check('경계 이전 체결 이벤트 완전 동일', JSON.stringify(evF) === JSON.stringify(evT), `${evF.length} vs ${evT.length}`)

  const eqF = rFull.equity.filter((e) => e.date <= boundary).map((e) => `${e.date}|${e.equity.toFixed(6)}`)
  const eqT = rTrunc.equity.filter((e) => e.date <= boundary).map((e) => `${e.date}|${e.equity.toFixed(6)}`)
  check('경계 이전 자산곡선 완전 동일', JSON.stringify(eqF) === JSON.stringify(eqT))
  check('매매가 실제로 발생함(테스트 유효성)', evF.length > 0)
}

section('8) 신호→체결 분리 — 편입가는 결정 다음날 시가')
{
  const hist = { A: mkHist('A', ramp(N, 0.0012)), B: mkHist('B', ramp(N, 0.0002)) }
  const r = runRotation(hist, startDate, P, NO_COST)
  const buy = r.events.find((e) => e.action === '매수')
  check('매수 이벤트 존재', buy != null)
  if (buy) {
    const bar = hist.A.bars.find((b) => b.date === buy.date)
    check('체결가 = 그날 시가', bar != null && Math.abs(bar.o - buy.price) < 1e-9, `${buy.price} vs ${bar?.o}`)
  }
}

section('9) 마지막 봉에서 신규 편입 없음')
{
  const hist = { A: mkHist('A', ramp(N, 0.0012)) }
  const r = runRotation(hist, startDate, P, NO_COST)
  const lastDate = hist.A.bars[N - 1].date
  check('마지막 날 신규 매수 없음', !r.events.some((e) => e.action === '매수' && e.date === lastDate))
}

section('10) 비용 반영 · 결정성')
{
  const hist = { A: mkHist('A', ramp(N, 0.0012)), B: mkHist('B', ramp(N, 0.0009)) }
  const cheap = runRotation(hist, startDate, { ...P, rebalanceDays: 5 }, NO_COST)
  const costly = runRotation(hist, startDate, { ...P, rebalanceDays: 5 }, { ...NO_COST, commissionPct: 0.5, slippagePct: 0.5 })
  check('비용이 성과를 낮춤', costly.equity[costly.equity.length - 1].equity < cheap.equity[cheap.equity.length - 1].equity)
  const again = runRotation(hist, startDate, { ...P, rebalanceDays: 5 }, NO_COST)
  check('재실행 결과 동일(결정성)', JSON.stringify(cheap.equity) === JSON.stringify(again.equity))
}

section('11) 데이터 없는 후보는 안전하게 제외')
{
  const hist = { A: mkHist('A', ramp(N, 0.0012)), SHORT: mkHist('SHORT', ramp(80, 0.003)) }
  const r = runRotation(hist, startDate, P, NO_COST)
  check('짧은 데이터 종목 미편입', !r.events.some((e) => e.symbol === 'SHORT' && e.action === '매수'))
  check('실행 자체는 정상 완료', r.equity.length > 100)
}

finish()
