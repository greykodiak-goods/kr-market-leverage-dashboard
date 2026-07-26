// 포트폴리오 집계 + 고급지표 검증
import { check, finish } from './harness'
import { runPortfolio, computeAdvanced, computeStartIdx } from '../src/features/backtest/portfolio'
import { defaultConfig } from '../src/features/backtest/models'
import type { DailyBar, HistoryResult } from '../src/lib/history'
import type { EquityPoint } from '../src/features/backtest/types'

function mk(seed: number, n = 900, base = 100, drift = 0.0004): HistoryResult {
  let s = seed
  const rnd = () => { s |= 0; s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
  const bars: DailyBar[] = []
  let p = base
  for (let i = 0; i < n; i++) {
    const ret = drift + 0.02 * (rnd() * 2 - 1)
    const o = p, c = p * (1 + ret)
    bars.push({ date: new Date(Date.UTC(2020, 0, 1) + i * 86400000).toISOString().slice(0, 10), t: 0, o, h: Math.max(o, c) * 1.005, l: Math.min(o, c) * 0.995, c, v: 1e6 })
    p = c
  }
  return { symbol: `S${seed}`, currency: 'KRW', exchange: 'T', bars, stale: false, fetchedAt: Date.now() }
}

// 1) 멀티종목 NAV = 슬리브 합, 초기자본 보존
const cfg = { ...defaultConfig('golden-cross'), symbols: ['A', 'B', 'C'], startDate: '' }
const hists = { A: mk(1), B: mk(2), C: mk(3) }
const res = runPortfolio('golden-cross', cfg, hists)
check('3종목 슬리브 생성', res.sleeves.length === 3)
check('유니버스 기록', JSON.stringify(res.universe) === '["A","B","C"]')
const sleeveSum = res.sleeves.reduce((s, x) => s + x.res.metrics.finalEquity, 0)
check('NAV 최종값 = 슬리브 합', Math.abs(res.metrics.finalEquity - sleeveSum) < 1, `${res.metrics.finalEquity} vs ${sleeveSum}`)
const firstNav = res.equity[0].equity
check('시작 NAV ≈ 초기자본', Math.abs(firstNav - cfg.settings.initialCapital) / cfg.settings.initialCapital < 0.05, `${firstNav}`)
check('매매에 종목 라벨', res.trades.every((t) => !!t.symbol))
check('총수익률 = NAV 기준', Math.abs(res.metrics.totalReturnPct - (res.metrics.finalEquity / cfg.settings.initialCapital - 1) * 100) < 1e-6)

// 2) 단일종목 = 슬리브 그대로 (집계가 값을 왜곡하지 않음)
const cfg1 = { ...defaultConfig('golden-cross'), symbols: ['A'] }
const res1 = runPortfolio('golden-cross', cfg1, { A: hists.A })
check('단일종목 집계 무왜곡', Math.abs(res1.metrics.finalEquity - res1.sleeves[0].res.metrics.finalEquity) < 1e-6)

// 3) 알고리즘 모델도 포트폴리오 실행 가능
const cfgIB = { ...defaultConfig('infinite-buying'), symbols: ['A', 'B'] }
const resIB = runPortfolio('infinite-buying', cfgIB, { A: hists.A, B: hists.B })
check('무한매수법 멀티종목 실행', resIB.sleeves.length === 2 && resIB.events.length > 0 && resIB.events.every((e) => !!e.symbol))

// 4) 고급지표 수치 검증 — 알려진 곡선
// 매일 정확히 +1% 상승하는 곡선: 변동성 0, MDD 0, calmar null, 월승률 100%
const eqUp: EquityPoint[] = []
let v = 100
for (let i = 0; i < 300; i++) {
  eqUp.push({ date: new Date(Date.UTC(2021, 0, 1) + i * 86400000).toISOString().slice(0, 10), equity: v, benchmark: 100, drawdownPct: 0 })
  v *= 1.01
}
const advUp = computeAdvanced(eqUp, 50, 0)
check('무변동 상승: 변동성 ≈ 0', advUp.volPct < 1e-6, `${advUp.volPct}`)
check('무변동 상승: 소르티노 0 (하락 없음)', advUp.sortino === 0)
check('MDD 0 → 칼마 null', advUp.calmar === null)
check('월 승률 100%', advUp.monthlyWinRatePct === 100)
check('수면 아래 0일', advUp.maxUnderwaterDays === 0)

// 5) 낙폭 지속일 검증: 5일 하락 후 회복
const eqDD: EquityPoint[] = []
const vals = [100, 100, 95, 92, 90, 95, 99, 101, 102] // idx2~6이 고점(100) 아래 = 5일
let peak = 0
vals.forEach((x, i) => {
  peak = Math.max(peak, x)
  eqDD.push({ date: `2021-01-${String(i + 1).padStart(2, '0')}`, equity: x, benchmark: 100, drawdownPct: ((x - peak) / peak) * 100 })
})
const advDD = computeAdvanced(eqDD, 10, -10)
check('최장 수면아래 5일', advDD.maxUnderwaterDays === 5, `${advDD.maxUnderwaterDays}`)
check('칼마 = CAGR/|MDD| = 1.0', advDD.calmar === 1)

// 6) 연도별 집계 + 벤치 초과 카운트
const eqY: EquityPoint[] = []
// 2021: 전략 +20%, 벤치 +10% (초과) / 2022: 전략 -10%, 벤치 +5% (미달)
eqY.push({ date: '2020-12-31', equity: 100, benchmark: 100, drawdownPct: 0 })
eqY.push({ date: '2021-12-31', equity: 120, benchmark: 110, drawdownPct: 0 })
eqY.push({ date: '2022-12-31', equity: 108, benchmark: 115.5, drawdownPct: -10 })
const advY = computeAdvanced(eqY, 5, -10)
check('연도 수 3개(2020·2021·2022)', advY.yearly.length === 3, JSON.stringify(advY.yearly.map((y) => y.year)))
const y21 = advY.yearly.find((y) => y.year === '2021')!
check('2021 전략 +20%', Math.abs(y21.retPct - 20) < 1e-9, `${y21.retPct}`)
check('2021 벤치 +10%', Math.abs(y21.benchRetPct - 10) < 1e-9)
const y22 = advY.yearly.find((y) => y.year === '2022')!
check('2022 전략 -10%', Math.abs(y22.retPct - -10) < 1e-9)
check('벤치 초과 1/3', advY.yearsBeatBench === '1/3', advY.yearsBeatBench)

// 7) startIdx: 시작일 지정/미지정
const bars = hists.A.bars
check('startIdx 미지정 = 중간', computeStartIdx(bars, '') === Math.max(120, Math.floor(bars.length / 2)))
const target = bars[500].date
check('startIdx 날짜 지정', computeStartIdx(bars, target) === 500)
check('startIdx 워밍업 하한 적용', computeStartIdx(bars, bars[10].date) === 120)

// 8) 날짜 어긋난 종목 합산(휴일 차이) — 직전값 유지로 NAV 연속
const hA = mk(5, 400)
const hB = { ...mk(6, 400), bars: mk(6, 400).bars.filter((_, i) => i % 7 !== 3) } // 일부 날짜 결측
const resMix = runPortfolio('golden-cross', { ...defaultConfig('golden-cross'), symbols: ['A', 'B'] }, { A: hA, B: hB })
check('결측일 있어도 NAV 연속·유한', resMix.equity.every((e) => Number.isFinite(e.equity) && e.equity > 0))
check('NAV 날짜 오름차순', resMix.equity.every((e, i, a) => i === 0 || a[i - 1].date < e.date))

// 9) 로드 실패 종목 제외 처리
const resPartial = runPortfolio('golden-cross', { ...defaultConfig('golden-cross'), symbols: ['A', 'MISSING'] }, { A: hists.A })
check('로드 실패 종목 제외 후 실행', resPartial.universe.length === 1 && resPartial.universe[0] === 'A')

finish()
