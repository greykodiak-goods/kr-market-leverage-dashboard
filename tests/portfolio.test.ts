// 포트폴리오 집계 + 고급지표 검증
import { check, finish, close as closeTo } from './harness'
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
check('규칙형 = 스크리닝 모드(슬리브 없음)', res.isScreening === true && res.sleeves.length === 0)
check('스크리닝 결과 존재', (res.lastScreen ?? []).length === 3)
check('후보 풀 3종목 유지', res.universe.length === 3)
check('유니버스 기록', JSON.stringify(res.universe) === '["A","B","C"]')
check('NAV가 유한하고 양수', Number.isFinite(res.metrics.finalEquity) && res.metrics.finalEquity > 0)
check('벤치마크(후보 풀 균등보유) 산출', res.equity.every((e) => e.benchmark > 0))
const firstNav = res.equity[0].equity
check('시작 NAV ≈ 초기자본', Math.abs(firstNav - cfg.settings.initialCapital) / cfg.settings.initialCapital < 0.05, `${firstNav}`)
check('매매에 종목 라벨', res.trades.every((t) => !!t.symbol))
check('총수익률 = NAV 기준', Math.abs(res.metrics.totalReturnPct - (res.metrics.finalEquity / cfg.settings.initialCapital - 1) * 100) < 1e-6)

// 2) 단일종목 = 슬리브 그대로 (집계가 값을 왜곡하지 않음)
const cfg1 = { ...defaultConfig('golden-cross'), symbols: ['A'] }
const res1 = runPortfolio('golden-cross', cfg1, { A: hists.A })
check('단일종목도 정상 실행', Number.isFinite(res1.metrics.finalEquity) && res1.universe.length === 1)

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
// 2026-08-03: 미지정 기본값이 "데이터 중간 지점"에서 **워밍업 직후**로 바뀌었다.
// 중간 기본값은 받아온 이력의 절반을 버려 10년을 불러도 5년만 돌게 만들었다.
check('startIdx 미지정 = 워밍업 직후(전 구간 사용)', computeStartIdx(bars, '') === 120)
check('startIdx 미지정은 데이터 절반을 버리지 않는다', computeStartIdx(bars, '') < Math.floor(bars.length / 2))
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


// ===== 최근 1년(달력 기준) 수익률 =====
{
  const mk = (i: number) => new Date(Date.UTC(2023, 0, 1) + i * 86400000).toISOString().slice(0, 10)
  // 2년치: 1년차 전략 +100%, 2년차 +20%. 벤치는 1년차 +50%, 2년차 +10%.
  const eq2: EquityPoint[] = []
  for (let i = 0; i <= 730; i++) {
    const y = i / 365
    const stratV = y <= 1 ? 1000 * (1 + y) : 2000 * (1 + 0.2 * (y - 1))
    const benchV = y <= 1 ? 1000 * (1 + 0.5 * y) : 1500 * (1 + 0.1 * (y - 1))
    eq2.push({ date: mk(i), equity: stratV, benchmark: benchV, drawdownPct: 0 })
  }
  const a2 = computeAdvanced(eq2, 0, -10)
  // 기준일은 "마지막 날짜의 정확히 1년 전 이후 첫 관측치"여야 한다
  const lastDate = eq2[eq2.length - 1].date
  const expectedCut = new Date(Date.parse(lastDate + 'T00:00:00Z'))
  expectedCut.setUTCFullYear(expectedCut.getUTCFullYear() - 1)
  const cutStr = expectedCut.toISOString().slice(0, 10)
  check('최근 1년 기준일 = 1년 전 이후 첫 관측치', a2.oneYearFrom === cutStr, `${a2.oneYearFrom} vs ${cutStr}`)
  check('기준일이 마지막보다 앞섬', (a2.oneYearFrom ?? '') < lastDate)
  check('구간이 1년 이상이면 partial=false', a2.oneYearPartial === false)
  closeTo('최근 1년 수익률 ≈ +20%', a2.return1yPct ?? 0, 20, 0.5)
  closeTo('최근 1년 벤치마크 ≈ +10%', a2.bench1yPct ?? 0, 10, 0.5)
  closeTo('최근 1년 초과 ≈ +10%p', a2.excess1yPct ?? 0, 10, 0.5)
  // 전체 누적(+100%)과 최근 1년(+20%)이 다르게 나와야 의미가 있다
  const totalRet = (eq2[eq2.length - 1].equity / eq2[0].equity - 1) * 100
  check('최근 1년이 전체 누적과 구분됨', Math.abs(totalRet - (a2.return1yPct ?? 0)) > 50, `total ${totalRet.toFixed(0)} vs 1y ${(a2.return1yPct ?? 0).toFixed(0)}`)
}

{
  const mk = (i: number) => new Date(Date.UTC(2025, 0, 1) + i * 86400000).toISOString().slice(0, 10)
  // 180일치만 있는 짧은 구간 → partial 표시, 있는 구간 전체로 계산
  const eqShort: EquityPoint[] = []
  for (let i = 0; i <= 180; i++) eqShort.push({ date: mk(i), equity: 1000 * (1 + (0.3 * i) / 180), benchmark: 1000, drawdownPct: 0 })
  const aS = computeAdvanced(eqShort, 0, -5)
  check('1년 미만이면 partial=true', aS.oneYearPartial === true)
  closeTo('있는 구간 전체로 계산(+30%)', aS.return1yPct ?? 0, 30, 0.1)
}

{
  // 관측치가 1개면 계산 불가 → null
  const one: EquityPoint[] = [{ date: '2026-01-02', equity: 1000, benchmark: 1000, drawdownPct: 0 }]
  const a1 = computeAdvanced(one, 0, 0)
  check('관측치 1개면 null', a1.return1yPct === null && a1.bench1yPct === null && a1.oneYearFrom === null)
}


// ===== 벤치마크 정체 표기 =====
{
  const res = runPortfolio('golden-cross', cfg, hists)
  check('벤치마크 라벨에 종목 수', res.benchmarkLabel.includes('3종목'), res.benchmarkLabel)
  check('벤치마크 라벨에 균등보유', res.benchmarkLabel.includes('균등보유'))
  check('벤치마크 설명에 구성 종목 나열', res.benchmarkDetail.includes('A') && res.benchmarkDetail.includes('B') && res.benchmarkDetail.includes('C'), res.benchmarkDetail.slice(0, 80))
  check('벤치마크 설명에 계산 방식', res.benchmarkDetail.includes('등분') && res.benchmarkDetail.includes('끝까지'))
}
{
  const resIB = runPortfolio('infinite-buying', { ...cfgIB, symbols: ['A'] }, { A: hists.A })
  check('단일종목 자금관리형 = 단순보유 라벨', resIB.benchmarkLabel.includes('단순보유'), resIB.benchmarkLabel)
  check('단일종목 라벨에 종목명', resIB.benchmarkLabel.includes('A'))
}

finish()
