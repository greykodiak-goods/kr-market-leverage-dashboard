// ⚠️ 이 파일은 CLAUDE.md 규칙 1(미래참조 금지)의 집행자다.
//
// 핵심 아이디어 — 절단 불변성(truncation invariance):
//   데이터의 뒷부분을 잘라내고 다시 시뮬레이션했을 때, 잘린 시점 이전의 매매와
//   자산곡선이 완전히 같아야 한다. 하나라도 달라졌다면 엔진이 어딘가에서
//   "그 시점에는 알 수 없었을 값"을 참조했다는 뜻이다.
//
// 지표를 추가하거나 엔진을 수정하면 그 경로를 덮는 케이스를 여기에 추가할 것.

import { check, section, finish, rng, close } from './harness'
import { runBacktest } from '../src/features/backtest/engine'
import { runInfiniteBuying, runValueRebalancing } from '../src/features/backtest/algoEngine'
import { operandSeries } from '../src/features/backtest/series'
import { PRESET_STRATEGIES } from '../src/features/backtest/strategies'
import { DEFAULT_SETTINGS, type Operand, type StrategyConfig } from '../src/features/backtest/types'
import type { DailyBar } from '../src/lib/history'

function makeBars(seed: number, n: number, base = 100): DailyBar[] {
  const rnd = rng(seed)
  const bars: DailyBar[] = []
  let p = base
  for (let i = 0; i < n; i++) {
    const ret = 0.0003 + 0.022 * (rnd() * 2 - 1)
    const o = p
    const c = p * (1 + ret)
    bars.push({
      date: new Date(Date.UTC(2018, 0, 1) + i * 86400000).toISOString().slice(0, 10),
      t: 0,
      o,
      h: Math.max(o, c) * (1 + rnd() * 0.01),
      l: Math.min(o, c) * (1 - rnd() * 0.01),
      c,
      v: 1e6,
    })
    p = c
  }
  return bars
}

const BARS = makeBars(20260726, 900)
const START = 200
const CUT = 700 // 이 인덱스 이후를 잘라낸다
const SETTINGS = { ...DEFAULT_SETTINGS, initialCapital: 10_000_000 }

// 잘린 데이터에서도 계산 가능한 마지막 안전 지점. 마지막 봉은 신규 진입을
// 만들지 않는 규칙이 있으므로 경계 한 칸 앞까지만 비교한다.
const BOUNDARY = BARS[CUT - 2].date

section('1) 지표(operand) 인과성 — 뒤를 잘라도 앞의 값이 변하지 않아야 한다')
{
  const full = BARS
  const trunc = BARS.slice(0, CUT)
  const operands: Operand[] = [
    { kind: 'CLOSE' },
    { kind: 'SMA', period: 20 },
    { kind: 'EMA', period: 20 },
    { kind: 'RSI', period: 14 },
    { kind: 'MACD_HIST' },
    { kind: 'BB_UPPER', period: 20 },
    { kind: 'BB_MID', period: 20 },
    { kind: 'BB_LOWER', period: 20 },
    { kind: 'HIGHEST', period: 20 },
    { kind: 'LOWEST', period: 10 },
  ]
  for (const op of operands) {
    const a = operandSeries(full, op).slice(0, CUT)
    const b = operandSeries(trunc, op)
    const same = a.length === b.length && a.every((v, i) => Object.is(v, b[i]))
    check(`${op.kind}${op.period ?? ''} 절단 불변`, same)
  }
}

section('2) HIGHEST/LOWEST 는 당일을 제외해야 한다 (당일 포함 시 미래참조)')
{
  // 마지막 봉에서 고가가 튀는 데이터. HIGHEST가 당일을 포함하면 값이 그 고가로
  // 오염되고, 돌파 조건이 자기 자신을 넘는 모순이 생긴다.
  const bars: DailyBar[] = []
  for (let i = 0; i < 30; i++) {
    const p = 100
    bars.push({ date: `2020-01-${String(i + 1).padStart(2, '0')}`, t: 0, o: p, h: p, l: p, c: p, v: 1 })
  }
  bars[29] = { ...bars[29], h: 999, c: 500 }
  const hi = operandSeries(bars, { kind: 'HIGHEST', period: 5 })
  close('HIGHEST가 당일 고가(999)를 포함하지 않음', hi[29] as number, 100)
  const lo = operandSeries(bars, { kind: 'LOWEST', period: 5 })
  close('LOWEST도 당일 제외', lo[29] as number, 100)
}

section('3) 규칙형 엔진 — 전 프리셋 절단 불변성')
{
  for (const preset of PRESET_STRATEGIES) {
    const full = runBacktest(BARS, START, preset, SETTINGS)
    const trunc = runBacktest(BARS.slice(0, CUT), START, preset, SETTINGS)

    const fullTrades = full.trades.filter((t) => t.entryDate <= BOUNDARY).map((t) => `${t.entryDate}|${t.entryPrice}|${t.qty}`)
    const truncTrades = trunc.trades.filter((t) => t.entryDate <= BOUNDARY).map((t) => `${t.entryDate}|${t.entryPrice}|${t.qty}`)
    check(`${preset.name}: 경계 이전 매매 동일`, JSON.stringify(fullTrades) === JSON.stringify(truncTrades))

    const fullEq = full.equity.filter((e) => e.date <= BOUNDARY).map((e) => `${e.date}|${e.equity.toFixed(6)}`)
    const truncEq = trunc.equity.filter((e) => e.date <= BOUNDARY).map((e) => `${e.date}|${e.equity.toFixed(6)}`)
    check(`${preset.name}: 경계 이전 자산곡선 동일`, JSON.stringify(fullEq) === JSON.stringify(truncEq))
  }
}

section('4) 알고리즘 엔진(무한매수법·VR) 절단 불변성')
{
  const ibFull = runInfiniteBuying(BARS, START, { splits: 40, targetPct: 10, cycleStopPct: null }, SETTINGS)
  const ibTrunc = runInfiniteBuying(BARS.slice(0, CUT), START, { splits: 40, targetPct: 10, cycleStopPct: null }, SETTINGS)
  const evF = (ibFull.events ?? []).filter((e) => e.date <= BOUNDARY)
  const evT = (ibTrunc.events ?? []).filter((e) => e.date <= BOUNDARY)
  check('무한매수법: 경계 이전 체결 이벤트 동일', JSON.stringify(evF) === JSON.stringify(evT))

  const vrFull = runValueRebalancing(BARS, START, { periodDays: 10, growthPct: 1, bandPct: 15, initialStockPct: 75 }, SETTINGS)
  const vrTrunc = runValueRebalancing(BARS.slice(0, CUT), START, { periodDays: 10, growthPct: 1, bandPct: 15, initialStockPct: 75 }, SETTINGS)
  const vF = (vrFull.events ?? []).filter((e) => e.date <= BOUNDARY)
  const vT = (vrTrunc.events ?? []).filter((e) => e.date <= BOUNDARY)
  check('VR: 경계 이전 체결 이벤트 동일', JSON.stringify(vF) === JSON.stringify(vT))
}

section('5) 신호→체결 분리 — 진입가는 신호 다음 봉의 시가여야 한다')
{
  const strat: StrategyConfig = {
    id: 'x',
    name: 'x',
    desc: '',
    buy: [{ left: { kind: 'SMA', period: 3 }, op: 'crossAbove', right: { kind: 'SMA', period: 10 } }],
    sell: [{ left: { kind: 'SMA', period: 3 }, op: 'crossBelow', right: { kind: 'SMA', period: 10 } }],
  }
  const noCost = { ...SETTINGS, commissionPct: 0, sellTaxPct: 0, slippagePct: 0, stopLossPct: null, takeProfitPct: null }
  const res = runBacktest(BARS, START, strat, noCost)
  check('매매가 발생함(테스트 유효성)', res.trades.length > 0)
  let allNextOpen = true
  for (const t of res.trades) {
    const idx = BARS.findIndex((b) => b.date === t.entryDate)
    if (idx < 0 || Math.abs(BARS[idx].o - t.entryPrice) > 1e-9) allNextOpen = false
    // 진입일의 '전일'에 신호가 성립했어야 한다 = 진입일 종가로 판단하지 않았다
    if (idx <= 0) allNextOpen = false
  }
  check('모든 진입가 = 진입일 시가 (당일 종가 체결 아님)', allNextOpen)
}

section('6) 마지막 봉에서 신규 진입을 만들지 않는다')
{
  // 항상 매수 조건이 참인 전략 — 마지막 봉에서도 진입을 만들면 체결할 다음 봉이 없다.
  const always: StrategyConfig = {
    id: 'a',
    name: 'a',
    desc: '',
    buy: [{ left: { kind: 'CLOSE' }, op: 'gt', right: { kind: 'CONST', value: 0 } }],
    sell: [],
  }
  const res = runBacktest(BARS, BARS.length - 5, always, SETTINGS)
  const lastDate = BARS[BARS.length - 1].date
  check('마지막 봉 진입 없음', !res.trades.some((t) => t.entryDate === lastDate))
}

section('7) 손절 갭 관통 시 기준가가 아니라 시가(불리한 쪽)로 체결')
{
  const bars: DailyBar[] = []
  for (let i = 0; i < 20; i++) {
    const p = 100 + i
    bars.push({ date: `2021-02-${String(i + 1).padStart(2, '0')}`, t: 0, o: p, h: p + 1, l: p - 1, c: p, v: 1 })
  }
  // 갭 하락: 시가 80이 손절선보다 아래 → 손절가(≈ 진입가×0.9)가 아니라 80에 체결돼야 함
  bars.push({ date: '2021-02-21', t: 0, o: 80, h: 82, l: 78, c: 81, v: 1 })
  bars.push({ date: '2021-02-22', t: 0, o: 81, h: 82, l: 80, c: 81, v: 1 })
  const strat: StrategyConfig = {
    id: 's',
    name: 's',
    desc: '',
    buy: [{ left: { kind: 'CLOSE' }, op: 'gt', right: { kind: 'SMA', period: 3 } }],
    sell: [],
  }
  const noCost = { ...SETTINGS, commissionPct: 0, sellTaxPct: 0, slippagePct: 0, stopLossPct: 10, takeProfitPct: null }
  const res = runBacktest(bars, 5, strat, noCost)
  const stop = res.trades.find((t) => t.reason === '손절')
  check('손절 발생', stop != null)
  if (stop) {
    check('갭 관통 시 시가(80) 체결 — 손절선보다 불리', Math.abs((stop.exitPrice ?? 0) - 80) < 1e-9, `exit=${stop.exitPrice}`)
  }
}

section('8) 동일 입력 → 동일 출력 (결정성)')
{
  const a = runBacktest(BARS, START, PRESET_STRATEGIES[0], SETTINGS)
  const b = runBacktest(BARS, START, PRESET_STRATEGIES[0], SETTINGS)
  check('재실행 결과 완전 동일', JSON.stringify(a) === JSON.stringify(b))
}

finish()
