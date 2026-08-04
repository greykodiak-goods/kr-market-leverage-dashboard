// ⚠️ 이 파일은 `scripts/dokkaebi-lab.entry.ts`에 대한 CLAUDE.md **규칙 1(미래참조 금지)의 집행자**다.
//
// 42차는 유튜브 댓글발 이평선 돌파 매매법을 재측정한다. 원문이 "**종가 매수**"라고 말하기 때문에
// 이 계열은 미래참조가 새기 가장 쉬운 자리다 — 오늘 종가로 돌파를 판정한 뒤 그 종가로 샀다고
// 계산하면 백테스트가 통째로 거짓이 된다. 그래서 여기서 검증하는 것:
//
//   1) **절단 불변성** — 데이터 뒷부분을 잘라내고 다시 돌렸을 때 잘린 시점 **이전**의
//      자산곡선·매매수가 완전히 동일. **MA2 경로를 반드시 포함**한다(이번 회차의 핵심 축).
//   2) **미래 조작 불변성** — 절단보다 강한 조작. 길이는 그대로 두고 **잘린 시점 이후 봉만
//      3배로 바꿔** 다시 돌렸을 때, 그 시점까지의 자산곡선이 **한 점도** 안 바뀐다
//      (길이가 같아 경계일까지 포함해 완전 일치를 요구한다).
//   3) **신호 함수의 미래맹목성** — `crossUpAt`·`breakdownAt`·`filterPasses`·`smaSeries`가
//      `bars[j+1..]`을 극단값으로 바꿔도 봉 j의 판정을 바꾸지 않는다.
//   4) **신호 → 체결 분리** — 손으로 계산한 토이 케이스에서 진입·청산이 **다음 봉 시가**에
//      정확히 체결된다(같은 봉 종가로 체결하지 않는다).
//   5) **마지막 봉 신규 진입 금지**(규칙 1-6).
//   6) **격자·이웃 산술** — 사전식 인덱싱, 필터 축의 **조건 격자 이웃**(대칭·자기참조 없음),
//      고원 점수 = **최솟값**(평균 아님).
//   7) **승격 관문** — 다섯 관문을 전부 통과해야만 승격("가장 덜 나쁜 칸 승격 금지"의 집행자).
//   8) **상수 대조** — 비용(shortterm-lab COST와 동일)·슬롯·거래량 임계(원문 숫자)·누적 분모·
//      비교 기준(`compareBasisFor('krx') === 'price'`).
//   9) **항등 점검** — MA5에서 `above5`는 돌파 조건에 포함되므로 `none`과 결과가 같아야 한다.
//  10) **결정론** — 같은 입력이면 같은 출력(난수 없음).
//
// 실데이터(야후 벤치)는 컨테이너에서 403이라 전부 **합성 시계열**로 검증한다.

import { check, close as closeTo, eq, section, finish } from './harness'
import {
  DOKKAEBI_COST,
  DOKKAEBI_DROP_THRESHOLD,
  DOKKAEBI_MIN_TRADES,
  DOKKAEBI_SLOTS,
  DOKKAEBI_TRIALS_PRIOR_TOTAL,
  FILTERS,
  FILTER_ADJACENCY,
  FILTER_IDS,
  FULL_GRID,
  MA2_GRID,
  MA_VALUES,
  QUICK_GRID,
  VOL_THRESHOLD_100,
  VOL_THRESHOLD_300,
  WIDTH_VALUES,
  breakdownAt,
  buildIndicators,
  buildYearCtxs,
  calmarOf,
  cellKey,
  compareBasisFor,
  crossUpAt,
  enumerateGrid,
  filterNeighbors,
  filterPasses,
  flatIndex,
  gridFor,
  halfYearOf,
  identityChecks,
  isDuplicateCell,
  localFailReasons,
  maOf,
  modeFromEnv,
  neighborsOf,
  perfOf,
  promotionVerdict,
  runDokkaebiChain,
  scorePlateau,
  simulateYear,
  smaSeries,
  syntheticBars,
  validateGrid,
  type CellResult,
  type Curve,
  type DokkaebiParams,
  type FilterId,
  type GridSpec,
  type PlateauScore,
  type YearCtx,
} from '../scripts/dokkaebi-lab.entry'
import type { DailyBar } from '../src/features/backtest/types'

// ============================================================================
// 합성 세계 — 결정적(난수 시드 고정)
// ============================================================================

const FROM = '2009-01-01'
const DAYS = 365 * 8 // 2009~2016

function world(nSyms = 10, seed = 21) {
  const histories: Record<string, DailyBar[]> = {}
  const codes: string[] = []
  for (let i = 0; i < nSyms; i++) {
    const code = `S${String(i).padStart(2, '0')}`
    codes.push(code)
    histories[code] = syntheticBars(seed + i * 17, FROM, DAYS, 10_000 + i * 250, (i - nSyms / 2) * 0.00008)
  }
  const years = [2010, 2011, 2012, 2013, 2014, 2015]
  return { histories, codes, years, codesFor: () => codes }
}

const ctxsOf = (histories: Record<string, DailyBar[]>, years: number[], codesFor: () => string[]): YearCtx[] =>
  buildYearCtxs(histories, years, codesFor, (c) => c)

/** 뒷부분을 잘라낸다(절단 불변성 조작). */
function truncate(histories: Record<string, DailyBar[]>, cut: string): Record<string, DailyBar[]> {
  const out: Record<string, DailyBar[]> = {}
  for (const [k, bars] of Object.entries(histories)) out[k] = bars.filter((b) => b.date <= cut)
  return out
}

/** 길이는 그대로 두고 **cut 이후 봉만** k배로 바꾼다(미래 조작 불변성 — 절단보다 강하다). */
function tamper(histories: Record<string, DailyBar[]>, cut: string, k: number): Record<string, DailyBar[]> {
  const out: Record<string, DailyBar[]> = {}
  for (const [key, bars] of Object.entries(histories))
    out[key] = bars.map((b) =>
      b.date > cut
        ? { ...b, o: b.o * k, h: b.h * k, l: b.l * k, c: b.c * k, v: Math.floor(b.v * k), rawClose: (b.rawClose ?? b.c) * k }
        : b,
    )
  return out
}

const curveUpTo = (c: Curve, to: string): Curve => c.filter((p) => p.date <= to)
const curveBefore = (c: Curve, before: string): Curve => c.filter((p) => p.date < before)

function sameCurve(name: string, a: Curve, b: Curve): void {
  if (a.length !== b.length) {
    check(name, false, `길이 ${a.length} vs ${b.length}`)
    return
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i].date !== b[i].date || Math.abs(a[i].equity - b[i].equity) > 1e-9) {
      check(name, false, `${i}번째 ${a[i].date}/${a[i].equity} vs ${b[i].date}/${b[i].equity}`)
      return
    }
  }
  check(name, true)
}

// ============================================================================
section('1. 상수 대조 — 34·36·39차와 같은 전제인가')
// ============================================================================

eq('비용 초기자본', DOKKAEBI_COST.initialCapital, 10_000_000)
closeTo('비용 수수료', DOKKAEBI_COST.feePct, 0.015)
closeTo('비용 거래세', DOKKAEBI_COST.taxPct, 0.15)
closeTo('비용 슬리피지', DOKKAEBI_COST.slippagePct, 0.1)
eq('슬롯 10 고정', DOKKAEBI_SLOTS, 10)
eq('매매수 관문 20', DOKKAEBI_MIN_TRADES, 20)
closeTo('고원 임계 0.30', DOKKAEBI_DROP_THRESHOLD, 0.3)
eq('거래량 임계 100만주(원문 숫자)', VOL_THRESHOLD_100, 1_000_000)
eq('거래량 임계 300만주(원문 숫자)', VOL_THRESHOLD_300, 3_000_000)
eq('누적 분모(33~40차 국장)', DOKKAEBI_TRIALS_PRIOR_TOTAL, 537)
eq('KRX 정본이면 비교 기준은 가격수익', compareBasisFor('krx'), 'price')
eq('야후면 비교 기준은 총수익', compareBasisFor('yahoo'), 'total')
eq('전·후반 경계(2010~2026)', halfYearOf([2010, 2026]), 2018)
eq('필터 9종', FILTER_IDS.length, 9)
eq('필터 정의와 id 개수 일치', FILTERS.length, FILTER_IDS.length)
check(
  '모든 필터에 원문 근거 문장이 있다',
  FILTERS.every((f) => f.origin.trim().length > 0),
)

// ============================================================================
section('2. 이동평균 — 인과적이고 앞 구간은 NaN')
// ============================================================================

{
  const bars: DailyBar[] = [10, 20, 30, 40, 50].map((c, i) => ({
    date: `2011-01-0${i + 3}`,
    t: i,
    o: c,
    h: c,
    l: c,
    c,
    v: 1,
  }))
  const ma2 = smaSeries(bars, 2)
  check('ma2[0]은 NaN(0으로 메우지 않는다)', Number.isNaN(ma2[0]))
  closeTo('ma2[1] = (10+20)/2', ma2[1], 15)
  closeTo('ma2[4] = (40+50)/2', ma2[4], 45)
  const ma5 = smaSeries(bars, 5)
  check('ma5[3]은 NaN', Number.isNaN(ma5[3]))
  closeTo('ma5[4] = 30', ma5[4], 30)
  let threw = false
  try {
    smaSeries(bars, 0)
  } catch {
    threw = true
  }
  check('기간 0이면 던진다', threw)

  // 미래맹목성 — j 이후 봉을 극단값으로 바꿔도 ma[j]가 안 바뀐다.
  const t = bars.map((b, i) => (i > 2 ? { ...b, c: b.c * 1000 } : b))
  const ma2t = smaSeries(t, 2)
  closeTo('ma2[2]는 j 이후 조작에 불변', ma2t[2], ma2[2])
}

// ============================================================================
section('3. 신호 함수 — 돌파·이탈 정의와 미래맹목성')
// ============================================================================

function barsFromCloses(closes: number[], opens?: number[], vols?: number[]): DailyBar[] {
  return closes.map((c, i) => {
    const o = opens?.[i] ?? c
    return {
      date: `2011-${String(Math.floor(i / 20) + 1).padStart(2, '0')}-${String((i % 20) + 1).padStart(2, '0')}`,
      t: i,
      o,
      h: Math.max(o, c),
      l: Math.min(o, c),
      c,
      v: vols?.[i] ?? 500_000,
      rawClose: c,
    }
  })
}

{
  // MA2: c=[100,90,95,99,80] → j=2에서 상향 돌파, j=4에서 이탈
  const closes = [100, 90, 95, 99, 80, 80, 80]
  const bars = barsFromCloses(closes)
  const ind = buildIndicators(bars)
  const ma2 = maOf(ind, 2)
  check('MA2 j=0은 돌파 아님(직전 봉 없음)', !crossUpAt(bars, ma2, 0))
  check('MA2 j=1은 돌파 아님(종가<MA)', !crossUpAt(bars, ma2, 1))
  check('MA2 j=2에서 상향 돌파', crossUpAt(bars, ma2, 2))
  check('MA2 j=3은 이미 위라 재돌파 아님', !crossUpAt(bars, ma2, 3))
  check('MA2 j=3은 이탈 아님', !breakdownAt(bars, ma2, 3))
  check('MA2 j=4에서 이탈', breakdownAt(bars, ma2, 4))

  // 미래맹목성 — j=2 이후 봉을 극단값으로 바꿔도 j=2 판정은 그대로여야 한다.
  const t = bars.map((b, i) => (i > 2 ? { ...b, o: b.o * 500, h: b.h * 500, l: b.l * 500, c: b.c * 500 } : b))
  const tInd = buildIndicators(t)
  eq('MA2 돌파 판정이 미래 조작에 불변', crossUpAt(t, maOf(tInd, 2), 2), true)
  eq('MA2 이탈 판정이 미래 조작에 불변', breakdownAt(t, maOf(tInd, 2), 1), breakdownAt(bars, ma2, 1))
}

{
  // MA5: c=[100,100,100,100,100,101,...] 평평하다가 상승 → 돌파 발생
  const closes = [100, 100, 100, 100, 100, 99, 101, 101, 101, 90]
  const bars = barsFromCloses(closes)
  const ind = buildIndicators(bars)
  const ma5 = maOf(ind, 5)
  check('MA5 j=4는 종가=MA라 돌파 아님(> 이어야 한다)', !crossUpAt(bars, ma5, 4))
  check('MA5 j=5는 종가<MA → 이탈', breakdownAt(bars, ma5, 5))
  check('MA5 j=6에서 상향 돌파', crossUpAt(bars, ma5, 6))
}

// ---- 필터 ----------------------------------------------------------------
{
  const closes = [10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22]
  const vols = closes.map((_, i) => (i === 21 ? 3_000_000 : i === 20 ? 1_000_000 : 999_999))
  const bars = barsFromCloses(closes, undefined, vols)
  const ind = buildIndicators(bars)
  const j = 21
  check('none은 항상 통과', filterPasses('none', bars, ind, j))
  check('above5: 상승 구간에서 종가>MA5', filterPasses('above5', bars, ind, j))
  check('align: 상승 구간에서 MA5>MA10', filterPasses('align', bars, ind, j))
  check('ma2up: 상승 구간에서 MA2 상향', filterPasses('ma2up', bars, ind, j))
  check('slope10: ma10[j] > ma10[j-10]', filterPasses('slope10', bars, ind, j))
  check('vol300 경계값 3,000,000은 통과(>=)', filterPasses('vol300', bars, ind, 21))
  check('vol300은 1,000,000에서 탈락', !filterPasses('vol300', bars, ind, 20))
  check('vol100 경계값 1,000,000은 통과(>=)', filterPasses('vol100', bars, ind, 20))
  check('vol100은 999,999에서 탈락', !filterPasses('vol100', bars, ind, 19))
  check('조합 필터는 AND', filterPasses('align+slope10', bars, ind, j))
  check('평평 구간에서는 align 탈락(MA5=MA10)', !filterPasses('align', bars, ind, 9))
  check('이력 부족이면 slope10 탈락(낙관적으로 통과시키지 않는다)', !filterPasses('slope10', bars, ind, 3))
  check('이력 부족이면 align 탈락', !filterPasses('align', bars, ind, 2))

  // 필터 미래맹목성 — j 이후 봉 조작에 불변
  const t = bars.map((b, i) => (i > j ? { ...b, c: b.c * 100, v: b.v * 100 } : b))
  const tInd = buildIndicators(t)
  let allSame = true
  for (const id of FILTER_IDS) if (filterPasses(id, t, tInd, j) !== filterPasses(id, bars, ind, j)) allSame = false
  check('모든 필터가 j 이후 조작에 불변', allSame)
}

// ============================================================================
section('4. 신호 → 체결 분리 — 손으로 계산한 토이 케이스')
// ============================================================================

{
  // c = [100, 90, 95, 99, 80, 80, ...] · MA2 기준
  //   j=2 상향 돌파 → **봉 3의 시가(200)**에 매수
  //   j=4 이탈      → **봉 5의 시가(300)**에 매도
  // 비용 0 · 슬롯 1 이면 최종 자산 = 초기자본 × 300/200 = 15,000,000 (수량 정수 나눗셈이 딱 떨어진다)
  const closes = [100, 90, 95, 99, 80, 80, 80, 80, 80, 80]
  const opens = [100, 100, 100, 200, 100, 300, 100, 100, 100, 100]
  const bars = closes.map((c, i) => ({
    date: `2011-01-${String(i + 3).padStart(2, '0')}`,
    t: i,
    o: opens[i],
    h: Math.max(opens[i], c),
    l: Math.min(opens[i], c),
    c,
    v: 1_000_000,
    rawClose: c,
  }))
  const ctxs = buildYearCtxs({ X: bars }, [2011], () => ['X'], (x) => x)
  eq('토이 컨텍스트 1년', ctxs.length, 1)
  eq('토이 심볼 1종', ctxs[0].symbols.length, 1)
  const zero = { ...DOKKAEBI_COST, feePct: 0, taxPct: 0, slippagePct: 0 }
  const params: DokkaebiParams = { maN: 2, topN: 20, filter: 'none' }
  const run = simulateYear(ctxs[0], zero, params, 1)
  eq('진입 1회', run.entries, 1)
  eq('청산 1회(라운드트립)', run.closed, 1)
  const last = run.equity[run.equity.length - 1].equity
  closeTo('체결가가 다음 봉 시가 — 최종자산 = 초기 × 300/200', last, 15_000_000, 1e-6)

  // 같은 봉 종가로 체결했다면 99/95 배가 되어 이 값이 나올 수 없다.
  check('당일 종가 체결이 아니다', Math.abs(last - 10_000_000 * (80 / 95)) > 1_000_000)

  // 매수 전날(봉 2, 2011-01-05)까지는 현금 그대로여야 한다.
  const beforeBuy = run.equity.find((p) => p.date === '2011-01-05')!
  closeTo('돌파 당일에는 아직 현금(체결은 다음날)', beforeBuy.equity, 10_000_000, 1e-6)
  const buyDay = run.equity.find((p) => p.date === '2011-01-06')!
  // 봉 3: 200에 50,000주 매수 → 종가 99로 마킹 = 4,950,000
  closeTo('매수 당일 종가 마킹', buyDay.equity, 50_000 * 99, 1e-6)

  // 비용을 넣으면 반드시 나빠진다(비용 배선 확인).
  const withCost = simulateYear(ctxs[0], DOKKAEBI_COST, params, 1)
  const lastCost = withCost.equity[withCost.equity.length - 1].equity
  check('비용을 물리면 최종자산이 줄어든다', lastCost < last, `${lastCost} vs ${last}`)
}

// ---- 마지막 봉 신규 진입 금지 --------------------------------------------
{
  // 마지막 봉 직전에 돌파가 나도록 만들고, 마지막 봉에서 진입이 생기지 않는지 본다.
  const closes = [100, 90, 95]
  const opens = [100, 100, 100]
  const bars = closes.map((c, i) => ({
    date: `2011-01-0${i + 3}`,
    t: i,
    o: opens[i],
    h: 100,
    l: 90,
    c,
    v: 1_000_000,
    rawClose: c,
  }))
  // j=2에서 돌파지만 체결할 봉이 없다 → 진입 0
  const ctxs = buildYearCtxs({ X: bars }, [2011], () => ['X'], (x) => x)
  const run = simulateYear(ctxs[0], DOKKAEBI_COST, { maN: 2, topN: 20, filter: 'none' }, 1)
  eq('마지막 봉에서는 신규 진입을 만들지 않는다', run.entries, 0)
}

// ============================================================================
section('5. 절단 불변성 — MA2 경로 포함 (규칙 1의 집행자)')
// ============================================================================

const W = world()
const CUT = '2013-06-28'

const TRUNC_CASES: DokkaebiParams[] = [
  { maN: 2, topN: 20, filter: 'none' }, // 🆕 MA2 축 — 이번 회차의 핵심
  { maN: 2, topN: 20, filter: 'ma2up' }, // 🆕 MA2 × MA2 필터
  { maN: 2, topN: 20, filter: 'vol300' },
  { maN: 5, topN: 20, filter: 'none' },
  { maN: 5, topN: 20, filter: 'align+slope10' },
  { maN: 5, topN: 20, filter: 'vol100' },
]

for (const p of TRUNC_CASES) {
  const fullCtxs = ctxsOf(W.histories, W.years, W.codesFor)
  const full = runDokkaebiChain(fullCtxs, DOKKAEBI_COST, p)

  // (a) 절단 — 데이터 뒷부분을 잘라내고 그 시점까지의 연도만 돌린다.
  const cutYears = W.years.filter((y) => y <= Number(CUT.slice(0, 4)))
  const cutCtxs = ctxsOf(truncate(W.histories, CUT), cutYears, W.codesFor)
  const cut = runDokkaebiChain(cutCtxs, DOKKAEBI_COST, p)
  sameCurve(`절단 불변 ${cellKey(p)}`, curveBefore(full.equity, CUT), curveBefore(cut.equity, CUT))

  // (b) 미래 조작 — 길이는 그대로, cut 이후 봉만 3배. 경계일까지 완전 일치를 요구한다.
  const tamperedCtxs = ctxsOf(tamper(W.histories, CUT, 3), W.years, W.codesFor)
  const tampered = runDokkaebiChain(tamperedCtxs, DOKKAEBI_COST, p)
  sameCurve(`미래 조작 불변 ${cellKey(p)}`, curveUpTo(full.equity, CUT), curveUpTo(tampered.equity, CUT))
}

// 매매가 실제로 일어났는지 — 0건이면 위 불변성 테스트가 공허해진다.
{
  const ctxs = ctxsOf(W.histories, W.years, W.codesFor)
  const ma2 = runDokkaebiChain(ctxs, DOKKAEBI_COST, { maN: 2, topN: 20, filter: 'none' })
  const ma5 = runDokkaebiChain(ctxs, DOKKAEBI_COST, { maN: 5, topN: 20, filter: 'none' })
  check('MA2 경로에서 매매가 충분히 발생한다', ma2.closed > 100, `closed=${ma2.closed}`)
  check('MA5 경로에서 매매가 충분히 발생한다', ma5.closed > 50, `closed=${ma5.closed}`)
  check('MA2가 MA5보다 회전이 빠르다', ma2.closed > ma5.closed, `${ma2.closed} vs ${ma5.closed}`)
}

// ---- 결정론 ---------------------------------------------------------------
{
  const p: DokkaebiParams = { maN: 2, topN: 20, filter: 'ma2up' }
  const a = runDokkaebiChain(ctxsOf(W.histories, W.years, W.codesFor), DOKKAEBI_COST, p)
  const b = runDokkaebiChain(ctxsOf(W.histories, W.years, W.codesFor), DOKKAEBI_COST, p)
  sameCurve('결정론 — 같은 입력이면 같은 곡선', a.equity, b.equity)
  eq('결정론 — 매매수 동일', a.closed, b.closed)
}

// ============================================================================
section('6. 항등 점검 — MA5에서 above5는 돌파 조건에 이미 포함된다')
// ============================================================================

{
  const ctxs = ctxsOf(W.histories, W.years, W.codesFor)
  const none = runDokkaebiChain(ctxs, DOKKAEBI_COST, { maN: 5, topN: 20, filter: 'none' })
  const above5 = runDokkaebiChain(ctxs, DOKKAEBI_COST, { maN: 5, topN: 20, filter: 'above5' })
  sameCurve('MA5 · above5 ≡ none', none.equity, above5.equity)
  const ma2up = runDokkaebiChain(ctxs, DOKKAEBI_COST, { maN: 5, topN: 20, filter: 'ma2up' })
  const combo = runDokkaebiChain(ctxs, DOKKAEBI_COST, { maN: 5, topN: 20, filter: 'above5+ma2up' })
  sameCurve('MA5 · above5+ma2up ≡ ma2up', ma2up.equity, combo.equity)

  // MA2에서는 항등이 성립하지 않아야 한다(above5는 진짜 추가 조건이다).
  const m2none = runDokkaebiChain(ctxs, DOKKAEBI_COST, { maN: 2, topN: 20, filter: 'none' })
  const m2above5 = runDokkaebiChain(ctxs, DOKKAEBI_COST, { maN: 2, topN: 20, filter: 'above5' })
  check('MA2에서는 above5가 실제로 매매를 줄인다', m2above5.closed < m2none.closed, `${m2above5.closed} vs ${m2none.closed}`)

  check('중복셀 라벨: MA5·above5', isDuplicateCell({ maN: 5, topN: 20, filter: 'above5' }))
  check('중복셀 라벨 아님: MA2·above5', !isDuplicateCell({ maN: 2, topN: 20, filter: 'above5' }))
}

// ============================================================================
section('7. 격자 · 이웃 산술')
// ============================================================================

{
  validateGrid(FULL_GRID)
  const cells = enumerateGrid(FULL_GRID)
  eq('전체 격자 = 2 × 2 × 9 = 36변형', cells.length, 36)
  eq('MA2 격자 = 1 × 2 × 9 = 18변형', enumerateGrid(MA2_GRID).length, 18)
  eq('스모크 격자 = 2 × 2 × 1 = 4변형', enumerateGrid(QUICK_GRID).length, 4)
  eq('MA 축 값 2종', MA_VALUES.length, 2)
  eq('폭 축 값 2종', WIDTH_VALUES.length, 2)

  // 사전식 — 마지막 축(filter)이 가장 빨리 돈다
  eq('셀0 = MA2·U40·none', cells[0].key, cellKey({ maN: 2, topN: 20, filter: 'none' }))
  eq('셀1은 필터만 한 칸 이동', cells[1].params.filter, FILTER_IDS[1])
  eq('셀1의 MA는 그대로', cells[1].params.maN, 2)
  eq('셀9는 폭이 한 칸 이동', cells[9].params.topN, 40)
  eq('셀18은 MA가 한 칸 이동', cells[18].params.maN, 5)
  check('키가 전부 유일하다', new Set(cells.map((c) => c.key)).size === cells.length)

  eq('flatIndex 격자 밖은 -1', flatIndex([0, 0, -1], [2, 2, 9]), -1)
  eq('flatIndex 사전식', flatIndex([1, 0, 3], [2, 2, 9]), 1 * 18 + 0 * 9 + 3)

  // 축 검증 — 오름차순 위반·알 수 없는 필터
  let threw = false
  try {
    validateGrid({
      id: 'x',
      label: 'x',
      axes: [
        { key: 'ma', label: 'ma', values: [5, 2], unit: '일', ordered: true },
        { key: 'width', label: 'w', values: [20], unit: '', ordered: true },
        { key: 'filter', label: 'f', values: ['none'], unit: '', ordered: false },
      ],
    } as GridSpec)
  } catch {
    threw = true
  }
  check('숫자 축이 내림차순이면 던진다', threw)

  threw = false
  try {
    validateGrid({
      id: 'x',
      label: 'x',
      axes: [
        { key: 'ma', label: 'ma', values: [2], unit: '일', ordered: true },
        { key: 'width', label: 'w', values: [20], unit: '', ordered: true },
        { key: 'filter', label: 'f', values: ['없는필터'], unit: '', ordered: false },
      ],
    } as GridSpec)
  } catch {
    threw = true
  }
  check('알 수 없는 필터면 던진다', threw)
}

// ---- 필터 축의 조건 격자 이웃 ---------------------------------------------
{
  // 대칭성 — a가 b의 이웃이면 b도 a의 이웃
  let symmetric = true
  for (const id of FILTER_IDS)
    for (const nb of filterNeighbors(id)) if (!filterNeighbors(nb).includes(id)) symmetric = false
  check('필터 이웃 관계는 대칭이다', symmetric)

  let selfRef = false
  for (const [a, b] of FILTER_ADJACENCY) if (a === b) selfRef = true
  check('자기 자신을 이웃으로 두지 않는다', !selfRef)

  let known = true
  for (const [a, b] of FILTER_ADJACENCY)
    if (!FILTER_IDS.includes(a) || !FILTER_IDS.includes(b)) known = false
  check('이웃 표의 모든 id가 정의돼 있다', known)

  check('none은 단일 필터 6종과 이웃', filterNeighbors('none').length === 6)
  check('vol100 ↔ vol300은 임계 한 칸 이웃', filterNeighbors('vol100').includes('vol300'))
  check('조합 필터는 구성요소 2개와 이웃', filterNeighbors('align+slope10').length === 2)
  check('align+slope10의 이웃은 align·slope10', filterNeighbors('align+slope10').sort().join(',') === 'align,slope10')
  check('none과 조합 필터는 이웃이 아니다(두 칸 거리)', !filterNeighbors('none').includes('align+slope10'))

  // 모든 필터가 최소 2개의 이웃을 갖는다 — 고립된 노드가 있으면 고원 판정이 공허해진다.
  check(
    '고립된 필터가 없다(이웃 ≥ 2)',
    FILTER_IDS.every((id) => filterNeighbors(id).length >= 2),
  )
}

{
  const cells = enumerateGrid(FULL_GRID)
  // MA2·U40·none: ma+ 1개, width+ 1개, filter 6개 = 8 이웃 / missing = ma−, width−
  const c0 = cells[0]
  const n0 = neighborsOf(c0, FULL_GRID)
  eq('MA2·U40·none 이웃 수', n0.found.length, 8)
  eq('경계 방향 2개(ma−·width−)', n0.missing.length, 2)
  check('대각선 이웃은 없다 — 한 번에 한 축만 바뀐다', n0.found.every((nb) => {
    const t = cells[nb.index]
    let diff = 0
    if (t.params.maN !== c0.params.maN) diff++
    if (t.params.topN !== c0.params.topN) diff++
    if (t.params.filter !== c0.params.filter) diff++
    return diff === 1
  }))

  // 스모크 격자는 필터 축이 값 1개 → frozen
  const q = enumerateGrid(QUICK_GRID)
  const nq = neighborsOf(q[0], QUICK_GRID)
  check('값 1개짜리 축은 frozen으로 표시된다', nq.frozen.includes('filter'))
  check('frozen 축은 이웃을 만들지 않는다', nq.found.every((x) => x.axis !== 'filter'))

  // MA2 격자에서는 ma 축이 frozen
  const m = enumerateGrid(MA2_GRID)
  check('MA2 격자에서 ma 축은 frozen', neighborsOf(m[0], MA2_GRID).frozen.includes('ma'))
}

// ---- 고원 점수 = 최솟값(평균 아님) ----------------------------------------
{
  const cells = enumerateGrid(FULL_GRID)
  const scores: (number | null)[] = cells.map(() => 1)
  const passes = cells.map(() => true)
  // 0번 셀의 이웃 하나만 0.1로 떨어뜨린다 — 평균이면 거의 안 움직이지만 최솟값이면 0.1이 된다.
  const n0 = neighborsOf(cells[0], FULL_GRID)
  scores[n0.found[0].index] = 0.1
  const ps = scorePlateau(cells, FULL_GRID, scores, passes)
  closeTo('plateauScore는 이웃 최솟값을 따른다(평균 아님)', ps[0].plateauScore as number, 0.1)
  closeTo('plateauDrop = (셀 − 이웃최솟값)/|셀|', ps[0].plateauDrop as number, 0.9)
  check('경계 셀은 [표본부족]으로 표시된다', ps[0].sampleShort)

  // 이웃 하나가 관문① 탈락이면 neighborsPassLocal이 false
  const passes2 = cells.map((_, i) => i !== n0.found[0].index)
  const ps2 = scorePlateau(cells, FULL_GRID, scores, passes2)
  eq('이웃 중 하나라도 관문① 탈락이면 false', ps2[0].neighborsPassLocal, false)

  // 성적 계산 불가(null) 이웃이 있으면 조용히 넘어가지 않고 사유를 남긴다
  const scores3 = cells.map((_, i) => (i === n0.found[0].index ? null : 1)) as (number | null)[]
  const ps3 = scorePlateau(cells, FULL_GRID, scores3, passes)
  eq('이웃 성적 null이면 plateauScore도 null', ps3[0].plateauScore, null)
  check('null 사유를 남긴다(빈칸으로 두지 않는다)', (ps3[0].reason ?? '').length > 0)

  let threw = false
  try {
    scorePlateau(cells, FULL_GRID, [1], passes)
  } catch {
    threw = true
  }
  check('배열 길이가 다르면 던진다', threw)
}

// ============================================================================
section('8. 승격 관문 — 다섯 개를 전부 통과해야만 승격')
// ============================================================================

function fakeResult(over: Partial<CellResult> = {}): CellResult {
  const cells = enumerateGrid(FULL_GRID)
  const flat: Perf = { total: 0, cagr: 0, mdd: -10, years: 10 }
  return {
    cell: cells[0],
    full: flat,
    a: flat,
    b: flat,
    calmar: 1,
    sharpeDaily: 0.1,
    alphaFull: 5,
    alphaA: 5,
    alphaB: 5,
    trades: 100,
    wins: 40,
    entries: 100,
    skippedSignals: 0,
    dailyReturns: [],
    ...over,
  } as CellResult
}
type Perf = ReturnType<typeof perfOf>

function fakePlateau(over: Partial<PlateauScore> = {}): PlateauScore {
  return {
    index: 0,
    self: 1,
    neighbors: 8,
    missing: [],
    frozen: [],
    minNeighbor: 0.9,
    plateauScore: 0.9,
    plateauDrop: 0.1,
    neighborsPassLocal: true,
    sampleShort: false,
    reason: null,
    ...over,
  }
}

{
  const good = { pbo: 0.2, wfOosAlpha: 3 }
  eq('전부 만족하면 승격', promotionVerdict(fakeResult(), fakePlateau(), good).promoted, true)
  eq(
    '① 전반 알파가 음수면 탈락',
    promotionVerdict(fakeResult({ alphaA: -0.1 }), fakePlateau(), good).promoted,
    false,
  )
  eq(
    '① 후반 알파가 음수면 탈락',
    promotionVerdict(fakeResult({ alphaB: -0.1 }), fakePlateau(), good).promoted,
    false,
  )
  eq(
    '② 매매수 미달이면 탈락',
    promotionVerdict(fakeResult({ trades: DOKKAEBI_MIN_TRADES - 1 }), fakePlateau(), good).promoted,
    false,
  )
  eq('③ PBO 0.5 이상이면 탈락', promotionVerdict(fakeResult(), fakePlateau(), { pbo: 0.5, wfOosAlpha: 3 }).promoted, false)
  eq('③ PBO 계산불가면 탈락', promotionVerdict(fakeResult(), fakePlateau(), { pbo: null, wfOosAlpha: 3 }).promoted, false)
  eq(
    '④ 워크포워드 OOS 알파 0 이하면 탈락',
    promotionVerdict(fakeResult(), fakePlateau(), { pbo: 0.2, wfOosAlpha: 0 }).promoted,
    false,
  )
  eq(
    '⑤ plateauDrop 초과면 탈락',
    promotionVerdict(fakeResult(), fakePlateau({ plateauDrop: 0.31 }), good).promoted,
    false,
  )
  eq(
    '⑤ 이웃 중 관문① 탈락이 있으면 탈락',
    promotionVerdict(fakeResult(), fakePlateau({ neighborsPassLocal: false }), good).promoted,
    false,
  )
  eq(
    '⑤ 고원 판정 불가면 탈락(모르면 통과가 아니다)',
    promotionVerdict(fakeResult(), fakePlateau({ plateauDrop: null, reason: '계산불가' }), good).promoted,
    false,
  )
  // 알파가 null(벤치 미겹침)이면 통과가 아니라 탈락이어야 한다.
  eq(
    '알파 null은 통과가 아니다',
    promotionVerdict(fakeResult({ alphaA: null, alphaB: null }), fakePlateau(), good).promoted,
    false,
  )
  check('관문 실패 사유가 문자열로 남는다', promotionVerdict(fakeResult({ trades: 1 }), fakePlateau(), good).failed.length > 0)

  eq('localFailReasons: 정상이면 빈 배열', localFailReasons(fakeResult()).length, 0)
  eq('localFailReasons: 매매 부족을 잡는다', localFailReasons(fakeResult({ trades: 3 })).length, 1)
}

// ============================================================================
section('9. 항등 점검기 · 성과 지표 · 모드 파서')
// ============================================================================

{
  const same = fakeResult()
  const cells = enumerateGrid(FULL_GRID)
  const a = { ...same, cell: cells.find((c) => c.key === cellKey({ maN: 5, topN: 20, filter: 'above5' }))! }
  const b = { ...same, cell: cells.find((c) => c.key === cellKey({ maN: 5, topN: 20, filter: 'none' }))! }
  eq('항등 점검: 같으면 ok', identityChecks([a, b])[0].ok, true)
  const bad = { ...b, trades: 999 }
  eq('항등 점검: 다르면 실패로 잡는다', identityChecks([a, bad])[0].ok, false)
}

{
  const c: Curve = [
    { date: '2011-01-01', equity: 100 },
    { date: '2011-07-01', equity: 50 },
    { date: '2012-01-01', equity: 200 },
  ]
  const p = perfOf(c)
  closeTo('총수익 +100%', p.total, 100, 1e-9)
  closeTo('MDD −50%', p.mdd, -50, 1e-9)
  check('칼마 = CAGR ÷ |MDD|', Math.abs((calmarOf(p) as number) - p.cagr / 50) < 1e-9)
  eq('MDD≈0이면 칼마 null', calmarOf({ total: 0, cagr: 5, mdd: 0, years: 1 }), null)
}

{
  eq('MODE 기본은 all', modeFromEnv({} as NodeJS.ProcessEnv), 'all')
  eq('MODE=ma2', modeFromEnv({ MODE: 'ma2' } as NodeJS.ProcessEnv), 'ma2')
  eq('MODE=selftest', modeFromEnv({ MODE: ' SELFTEST ' } as NodeJS.ProcessEnv), 'selftest')
  let threw = false
  try {
    modeFromEnv({ MODE: '엉뚱' } as NodeJS.ProcessEnv)
  } catch {
    threw = true
  }
  check('알 수 없는 MODE는 던진다(조용히 기본값으로 내려가지 않는다)', threw)
  eq('gridFor(ma2)는 MA2 격자', gridFor('ma2').id, 'ma2')
  eq('gridFor(quick)는 스모크 격자', gridFor('quick').id, 'quick')
  eq('gridFor(all)는 전체 격자', gridFor('all').id, 'all')
}

// ============================================================================
section('10. 필터가 실제로 매매를 줄이는가 — 배선이 죽어 있지 않은지')
// ============================================================================

{
  const ctxs = ctxsOf(W.histories, W.years, W.codesFor)
  const base = runDokkaebiChain(ctxs, DOKKAEBI_COST, { maN: 2, topN: 20, filter: 'none' })
  const seen: string[] = []
  for (const id of FILTER_IDS) {
    if (id === 'none') continue
    const r = runDokkaebiChain(ctxs, DOKKAEBI_COST, { maN: 2, topN: 20, filter: id as FilterId })
    if (!(r.closed < base.closed) || r.closed === 0) seen.push(`${id}(${r.closed}/${base.closed})`)
  }
  check(
    '모든 필터가 매매를 줄이되 0으로 만들지 않는다',
    seen.length === 0,
    `이상한 필터: ${seen.join(', ')}`,
  )
}

finish()
