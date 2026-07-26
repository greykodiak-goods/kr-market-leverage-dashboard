// 신호형 종목발굴 엔진 — 스크리닝·순위·슬롯 + 미래참조 금지 검증.
import { check, close, finish, section, rng } from './harness'
import { runSignalRotation, DEFAULT_SIGNAL_ROTATION, type SignalRotationParams } from '../src/features/backtest/signalRotation'
import { DEFAULT_SETTINGS, type StrategyConfig } from '../src/features/backtest/types'
import type { DailyBar, HistoryResult } from '../src/lib/history'

function mkHist(symbol: string, closes: number[]): HistoryResult {
  const bars: DailyBar[] = closes.map((c, i) => ({
    date: new Date(Date.UTC(2018, 0, 1) + i * 86400000).toISOString().slice(0, 10),
    t: 0,
    o: c,
    h: c * 1.004,
    l: c * 0.996,
    c,
    v: 1e6,
  }))
  return {
    symbol, currency: 'USD', exchange: 'TEST', instrumentType: 'EQUITY', bars,
    stale: false, fetchedAt: 0, source: 'test', proxyUsed: 'test',
    adjustment: 'split+dividend', droppedBars: 0,
  }
}

function ramp(n: number, rate: number, base = 100): number[] {
  const out: number[] = []
  let p = base
  for (let i = 0; i < n; i++) { out.push(p); p *= 1 + rate }
  return out
}

const N = 900
const NO_COST = { ...DEFAULT_SETTINGS, initialCapital: 1_000_000, commissionPct: 0, sellTaxPct: 0, slippagePct: 0, stopLossPct: null, takeProfitPct: null }
const startDate = new Date(Date.UTC(2018, 0, 1) + 400 * 86400000).toISOString().slice(0, 10)

// 항상 매수 조건 참 / 매도 조건 없음 — 스크리닝·순위만 시험
const ALWAYS: StrategyConfig = {
  id: 'a', name: 'a', desc: '',
  buy: [{ left: { kind: 'CLOSE' }, op: 'gt', right: { kind: 'CONST', value: 0 } }],
  sell: [],
}
const P: SignalRotationParams = { ...DEFAULT_SIGNAL_ROTATION, topN: 2, trendFilter: false, rankLookback: 126 }

section('1) 순위 — 강한 종목부터 슬롯을 채운다')
{
  const hist = {
    STRONG: mkHist('STRONG', ramp(N, 0.0012)),
    MID: mkHist('MID', ramp(N, 0.0006)),
    WEAK: mkHist('WEAK', ramp(N, 0.0001)),
  }
  const r = runSignalRotation(hist, startDate, ALWAYS, P, NO_COST)
  const bought = new Set(r.events.filter((e) => e.action === '매수').map((e) => e.symbol))
  check('상위 2종목만 편입', bought.has('STRONG') && bought.has('MID') && !bought.has('WEAK'), [...bought].join(','))
  check('동시 보유 슬롯 준수', r.trades.filter((t) => t.exitDate == null).length <= 2)
  // 보유 중인 종목은 '후보'가 아니므로 순위가 없다(정상). 순위는 미보유 후보에만 매겨진다.
  check('보유 종목은 held=true', r.lastScreen.find((x) => x.symbol === 'STRONG')?.held === true)
  const unheld = r.lastScreen.filter((x) => !x.held && x.signal && x.trendOk)
  check('미보유 후보에 순위가 매겨짐', unheld.length === 0 || unheld.every((x) => x.rank != null))
  check('벤치마크(풀 균등보유) 존재', r.equity.every((e) => e.benchmark > 0))
  check('강한 종목 선택이 균등보유를 이김', r.equity[r.equity.length - 1].equity > r.equity[r.equity.length - 1].benchmark)
}

section('2) 종목 발굴 — 사람이 지정하지 않은 종목을 스스로 담는다')
{
  // A: 먼저 강했다가 꺾인다 → 매도되어 슬롯이 빈다
  // LATE: 초반엔 잠잠하다가 뒤늦게 급등 → 모델이 스스로 찾아내야 한다
  const aUp = ramp(500, 0.0015)
  const aDown = ramp(400, -0.002, aUp[aUp.length - 1])
  const lateFlat = ramp(500, 0.00005)
  const lateSurge = ramp(400, 0.003, lateFlat[lateFlat.length - 1])
  const hist = {
    A: mkHist('A', [...aUp, ...aDown]),
    B: mkHist('B', ramp(N, 0.00005)),
    LATE: mkHist('LATE', [...lateFlat, ...lateSurge]),
  }
  // 매도 규칙이 있어야 슬롯이 비고 새 종목을 발굴할 수 있다(매도 없으면 영구 보유).
  const withExit: StrategyConfig = {
    id: 'x', name: 'x', desc: '',
    buy: [{ left: { kind: 'SMA', period: 5 }, op: 'gt', right: { kind: 'SMA', period: 60 } }],
    sell: [{ left: { kind: 'SMA', period: 5 }, op: 'lt', right: { kind: 'SMA', period: 60 } }],
  }
  const r = runSignalRotation(hist, startDate, withExit, { ...P, topN: 1, trendFilter: false }, NO_COST)
  const boughtLate = r.events.some((e) => e.action === '매수' && e.symbol === 'LATE')
  check('뒤늦게 강해진 종목을 발굴해 편입', boughtLate, r.events.filter((e) => e.action === '매수').map((e) => e.symbol).join(','))
  check('편입 이벤트에 종목 표기', r.events.every((e) => !!e.symbol))
  check('여러 종목을 오가며 매매', new Set(r.events.map((e) => e.symbol)).size >= 2)
}

section('3) 매수 조건 스크리닝 — 조건 미충족 종목은 안 산다')
{
  const gc: StrategyConfig = {
    id: 'g', name: 'g', desc: '',
    buy: [{ left: { kind: 'SMA', period: 5 }, op: 'gt', right: { kind: 'SMA', period: 60 } }],
    sell: [{ left: { kind: 'SMA', period: 5 }, op: 'lt', right: { kind: 'SMA', period: 60 } }],
  }
  const hist = { UP: mkHist('UP', ramp(N, 0.001)), DOWN: mkHist('DOWN', ramp(N, -0.001)) }
  const r = runSignalRotation(hist, startDate, gc, { ...P, topN: 2 }, NO_COST)
  const bought = new Set(r.events.filter((e) => e.action === '매수').map((e) => e.symbol))
  check('상승 종목만 매수', bought.has('UP') && !bought.has('DOWN'), [...bought].join(','))
  const downRow = r.lastScreen.find((x) => x.symbol === 'DOWN')
  check('하락 종목 탈락 사유 기록', downRow != null && !downRow.signal && downRow.reasons.length > 0, downRow?.reasons.join('/'))
}

section('4) 장기추세 필터')
{
  const hist = { UP: mkHist('UP', ramp(N, 0.001)), DOWN: mkHist('DOWN', ramp(N, -0.0008)) }
  const r = runSignalRotation(hist, startDate, ALWAYS, { ...P, trendFilter: true, trendSma: 200, topN: 2 }, NO_COST)
  const bought = new Set(r.events.filter((e) => e.action === '매수').map((e) => e.symbol))
  check('200일선 아래 종목 배제', !bought.has('DOWN'), [...bought].join(','))
  check('탈락 사유에 이평 언급', r.lastScreen.some((x) => x.reasons.some((s) => s.includes('일선'))))
}

section('5) 매도 조건 · 손절')
{
  const gc: StrategyConfig = {
    id: 'g', name: 'g', desc: '',
    buy: [{ left: { kind: 'SMA', period: 5 }, op: 'gt', right: { kind: 'SMA', period: 20 } }],
    sell: [{ left: { kind: 'SMA', period: 5 }, op: 'lt', right: { kind: 'SMA', period: 20 } }],
  }
  const up = ramp(600, 0.0015)
  const down = ramp(300, -0.004, up[up.length - 1])
  const hist = { X: mkHist('X', [...up, ...down]) }
  const r = runSignalRotation(hist, startDate, gc, { ...P, topN: 1, trendFilter: false }, NO_COST)
  check('조건 매도 발생', r.trades.some((t) => t.reason === '조건 매도'))

  // 손절 단독 검증 — 매도 조건을 비워 손절만 발동하게 한다
  const noExit: StrategyConfig = { id: 'ne', name: 'ne', desc: '', buy: ALWAYS.buy, sell: [] }
  const rStop = runSignalRotation(hist, startDate, noExit, { ...P, topN: 1, trendFilter: false }, { ...NO_COST, stopLossPct: 5 })
  check('손절 발생', rStop.trades.some((t) => t.reason === '손절'), rStop.trades.map((t) => t.reason).join(','))
  const st = rStop.trades.find((t) => t.reason === '손절')
  if (st) close('손절가 = 진입가 −5%', st.exitPrice ?? 0, st.entryPrice * 0.95, 1e-6)
}

section('6) 신호→체결 분리 — 편입가는 결정 다음날 시가')
{
  const hist = { A: mkHist('A', ramp(N, 0.0012)) }
  const r = runSignalRotation(hist, startDate, ALWAYS, { ...P, topN: 1, trendFilter: false }, NO_COST)
  const buy = r.events.find((e) => e.action === '매수')
  check('매수 발생', buy != null)
  if (buy) {
    const bar = hist.A.bars.find((b) => b.date === buy.date)
    check('체결가 = 그날 시가', bar != null && Math.abs(bar.o - buy.price) < 1e-9, `${buy.price} vs ${bar?.o}`)
  }
}

section('7) 마지막 봉 신규 편입 없음')
{
  const hist = { A: mkHist('A', ramp(N, 0.0012)), B: mkHist('B', ramp(N, 0.0009)) }
  const r = runSignalRotation(hist, startDate, ALWAYS, P, NO_COST)
  const lastDate = hist.A.bars[N - 1].date
  check('마지막 날 신규 매수 없음', !r.events.some((e) => e.action === '매수' && e.date === lastDate))
}

section('8) 미래참조 금지 — 절단 불변성')
{
  const mk = (seed: number) => {
    const r2 = rng(seed)
    const out: number[] = []
    let p = 100
    for (let i = 0; i < N; i++) { out.push(p); p *= 1 + 0.0004 + 0.02 * (r2() * 2 - 1) }
    return out
  }
  const gc: StrategyConfig = {
    id: 'g', name: 'g', desc: '',
    buy: [{ left: { kind: 'SMA', period: 5 }, op: 'crossAbove', right: { kind: 'SMA', period: 20 } }],
    sell: [{ left: { kind: 'SMA', period: 5 }, op: 'crossBelow', right: { kind: 'SMA', period: 20 } }],
  }
  const full = { A: mkHist('A', mk(11)), B: mkHist('B', mk(22)), C: mkHist('C', mk(33)) }
  const CUT = 750
  const trunc = { A: mkHist('A', mk(11).slice(0, CUT)), B: mkHist('B', mk(22).slice(0, CUT)), C: mkHist('C', mk(33).slice(0, CUT)) }
  const params = { ...P, topN: 2, trendFilter: true, trendSma: 200 }
  const withStop = { ...NO_COST, stopLossPct: 8 }
  const rFull = runSignalRotation(full, startDate, gc, params, withStop)
  const rTrunc = runSignalRotation(trunc, startDate, gc, params, withStop)
  const boundary = full.A.bars[CUT - 3].date

  const evF = rFull.events.filter((e) => e.date <= boundary)
  const evT = rTrunc.events.filter((e) => e.date <= boundary)
  check('경계 이전 체결 이벤트 완전 동일', JSON.stringify(evF) === JSON.stringify(evT), `${evF.length} vs ${evT.length}`)
  const eqF = rFull.equity.filter((e) => e.date <= boundary).map((e) => `${e.date}|${e.equity.toFixed(6)}`)
  const eqT = rTrunc.equity.filter((e) => e.date <= boundary).map((e) => `${e.date}|${e.equity.toFixed(6)}`)
  check('경계 이전 자산곡선 완전 동일', JSON.stringify(eqF) === JSON.stringify(eqT))
  check('매매가 실제로 발생함(테스트 유효성)', evF.length > 0)
}

section('9) 비용 반영 · 결정성 · 안전성')
{
  const hist = { A: mkHist('A', ramp(N, 0.0012)), B: mkHist('B', ramp(N, 0.0009)) }
  const cheap = runSignalRotation(hist, startDate, ALWAYS, P, NO_COST)
  const costly = runSignalRotation(hist, startDate, ALWAYS, P, { ...NO_COST, commissionPct: 0.5, slippagePct: 0.5 })
  check('비용이 성과를 낮춤', costly.equity[costly.equity.length - 1].equity < cheap.equity[cheap.equity.length - 1].equity)
  const again = runSignalRotation(hist, startDate, ALWAYS, P, NO_COST)
  check('재실행 결과 동일(결정성)', JSON.stringify(cheap.equity) === JSON.stringify(again.equity))
  check('현금이 음수가 되지 않음', cheap.equity.every((e) => Number.isFinite(e.equity) && e.equity > 0))

  // 조건이 하나도 안 맞으면 매매 없이 현금 유지
  const never: StrategyConfig = { id: 'n', name: 'n', desc: '', buy: [{ left: { kind: 'CLOSE' }, op: 'lt', right: { kind: 'CONST', value: 0 } }], sell: [] }
  const rNever = runSignalRotation(hist, startDate, never, P, NO_COST)
  check('조건 미충족 시 매매 0건', rNever.events.length === 0)
  close('자산 = 초기자본 유지', rNever.equity[rNever.equity.length - 1].equity, NO_COST.initialCapital, 1)
}

section('10) 체결 이력의 자금 정보 — 얼마를 어떻게 샀나')
{
  const hist = {
    A: mkHist('A', ramp(N, 0.0012)),
    B: mkHist('B', ramp(N, 0.0009)),
    C: mkHist('C', ramp(N, 0.0006)),
  }
  const CAP = 1_000_000
  const r = runSignalRotation(hist, startDate, ALWAYS, { ...P, topN: 3, trendFilter: false }, { ...NO_COST, initialCapital: CAP })
  const buys = r.events.filter((e) => e.action === '매수')
  check('매수 이벤트 존재', buys.length > 0)

  check('체결금액 = 수량 × 가격', buys.every((e) => Math.abs((e.amount ?? 0) - e.qty * e.price) < 1e-6))
  check('잔여현금 기록됨(음수 아님)', buys.every((e) => e.cashAfter != null && e.cashAfter >= -1e-6))
  check('총자산 기록됨(양수)', buys.every((e) => (e.equityAfter ?? 0) > 0))
  check('보유 종목 수 기록', buys.every((e) => (e.positionsAfter ?? 0) >= 1))
  check('비중이 0~100% 범위', buys.every((e) => (e.weightPct ?? -1) >= 0 && (e.weightPct ?? 101) <= 100))

  // 전액 몰빵이 아니라 슬롯 분할인지: 첫 편입 3건의 비중 합이 100% 근처, 각각은 100% 미만
  const firstDay = buys[0].date
  const sameDay = buys.filter((e) => e.date === firstDay)
  check(`첫날 3종목 동시 편입 (실제 ${sameDay.length})`, sameDay.length === 3)
  check('각 종목 비중 < 60% (전액 매수 아님)', sameDay.every((e) => (e.weightPct ?? 100) < 60), sameDay.map((e) => (e.weightPct ?? 0).toFixed(0)).join('/'))
  const lastOfDay = sameDay[sameDay.length - 1]
  check('3종목 편입 후 총자산 ≈ 초기자본', Math.abs((lastOfDay.equityAfter ?? 0) - CAP) < CAP * 0.02, `${lastOfDay.equityAfter}`)
  check('3종목 편입 후 현금 소진', (lastOfDay.cashAfter ?? CAP) < CAP * 0.05, `${lastOfDay.cashAfter}`)

  // 매도는 전량 표기
  const sells = r.events.filter((e) => e.action === '매도')
  check('매도는 전량(full=true)', sells.length === 0 || sells.every((e) => e.full === true))
  check('매도 후 비중 0', sells.length === 0 || sells.every((e) => e.weightPct === 0))
}

section('10b) 슬롯이 하나씩 비어도 한 종목에 몰리지 않는다 (전액매수 버그 회귀)')
{
  // 종목마다 매도 시점이 어긋나 슬롯이 하나씩 비는 상황을 만든다.
  const hist = {
    A: mkHist('A', [...ramp(400, 0.002), ...ramp(500, -0.001, 100 * Math.pow(1.002, 399))]),
    B: mkHist('B', [...ramp(550, 0.0018), ...ramp(350, -0.001, 100 * Math.pow(1.0018, 549))]),
    C: mkHist('C', ramp(N, 0.001)),
    D: mkHist('D', ramp(N, 0.0008)),
  }
  const gc: StrategyConfig = {
    id: 'g', name: 'g', desc: '',
    buy: [{ left: { kind: 'SMA', period: 5 }, op: 'gt', right: { kind: 'SMA', period: 60 } }],
    sell: [{ left: { kind: 'SMA', period: 5 }, op: 'lt', right: { kind: 'SMA', period: 60 } }],
  }
  const r = runSignalRotation(hist, startDate, gc, { ...P, topN: 3, trendFilter: false }, NO_COST)
  const buys = r.events.filter((e) => e.action === '매수')
  check('매수 다수 발생', buys.length >= 3)
  // 슬롯 3개면 한 종목 비중은 대략 1/3 — 어떤 매수도 60%를 넘으면 안 된다
  const over = buys.filter((e) => (e.weightPct ?? 0) > 60)
  check('어떤 편입도 비중 60% 초과 없음', over.length === 0, over.map((e) => `${e.symbol} ${(e.weightPct ?? 0).toFixed(0)}%`).join(', '))
  // 1주짜리 껍데기 편입(비중 ~0%)도 없어야 한다
  const tiny = buys.filter((e) => (e.weightPct ?? 0) < 5)
  check('비중 5% 미만 껍데기 편입 없음', tiny.length === 0, tiny.map((e) => `${e.symbol} ${(e.weightPct ?? 0).toFixed(1)}%`).join(', '))
}

section('11) 슬롯 1개면 사실상 전액 — 슬롯 수가 비중을 결정한다')
{
  const hist = { A: mkHist('A', ramp(N, 0.0012)), B: mkHist('B', ramp(N, 0.0009)) }
  const r1 = runSignalRotation(hist, startDate, ALWAYS, { ...P, topN: 1, trendFilter: false }, NO_COST)
  const b1 = r1.events.filter((e) => e.action === '매수')[0]
  check('슬롯 1개 → 비중 95% 이상', (b1.weightPct ?? 0) > 95, `${(b1.weightPct ?? 0).toFixed(1)}%`)
  const r2 = runSignalRotation(hist, startDate, ALWAYS, { ...P, topN: 2, trendFilter: false }, NO_COST)
  const b2 = r2.events.filter((e) => e.action === '매수')[0]
  check('슬롯 2개 → 비중 약 50%', (b2.weightPct ?? 0) > 40 && (b2.weightPct ?? 0) < 60, `${(b2.weightPct ?? 0).toFixed(1)}%`)
}

finish()
