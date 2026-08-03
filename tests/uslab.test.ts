// ⚠️ 이 파일은 `scripts/us-lab.entry.ts`에 대한 CLAUDE.md **규칙 1(미래참조 금지)의 집행자**다.
//
// 41차 미장 랩은 다섯 계열(모멘텀·저변동성·52주 신고가 근접도·거래량 급증·단기 반전)을
// 분위 격자로 수십 번 돌린다. 그 안에서 미래참조가 **한 계열이라도** 새면 격자 전체가
// 조용히 거짓이 되고, "분위를 맞추니 살아났다"처럼 보이는 것이 실은 "미래를 봤다"가 된다.
// 계열마다 창의 정의가 다르므로(수익률·표준편차·최고가·거래대금) **계열별로 전부** 검증한다.
//
//   1) **절단 불변성** — 데이터 뒷부분을 잘라내고 다시 돌렸을 때 잘린 시점 **이전**의
//      자산곡선·연도별 수익률이 완전히 동일. (다섯 계열 × 절대슬롯·분위슬롯을 골고루 덮는다)
//   2) **미래 조작 불변성** — 길이는 그대로 두고 **잘린 시점 이후 봉만 3배로 바꿔** 다시 돌렸을 때
//      그 시점까지의 자산곡선이 **한 점도** 안 바뀐다. 절단은 "마지막 봉 신규 진입 금지"
//      (규칙 1-6) 때문에 경계 한 점이 달라질 수 있지만 이 조작은 길이가 같아 경계까지
//      완전 일치를 요구한다 — 더 강한 테스트다.
//   3) **랭킹 창의 인과성(계열별)** — 리밸런스 달의 봉을 통째로 조작해도 그날 점수가 안 바뀐다.
//      창의 오른쪽 경계가 `< 리밸런스 달 1일`이라는 규약을 계열마다 직접 확인한다.
//   4) **롤링 극값 시프트(규칙 1-3)** — 52주 최고가 창에 리밸런스 달 고가가 못 들어간다.
//   5) **마지막 봉 신규 진입 금지(규칙 1-6)** — 구간 마지막 봉이 리밸런스일이어도 보유 종목이
//      늘지 않는다.
//   6) **분위 슬롯 산술** — 이 회차의 핵심 축. 상위 X%가 `round(후보수 × X/100)`으로 떨어지고
//      경계에서 1 이상·후보수 이하로 잘린다.
//   7) **격자·이웃·고원 산술** — 사전식 인덱싱, 이웃 = ±1 스텝(대각선 제외), 경계 셀 표기,
//      고원 점수 = **최솟값**(평균 아님).
//   8) **승격 관문** — 다섯 관문을 전부 통과해야만 승격("가장 덜 나쁜 변형 승격 금지"의 집행자).
//   9) **27차 재현 격자·비용·누적 분모 대조** — 값이 갈리면 옛 표와 나란히 못 읽는다.
//  10) **결정론** — 같은 입력이면 같은 출력(난수 없음).
//
// 실데이터(Yahoo)는 컨테이너에서 403이라 전부 **합성 시계열**로 검증한다.

import { check, close as closeTo, eq, section, finish } from './harness'
import {
  BENCH_US,
  COST_US,
  DECILE_PCT,
  FACTORS,
  FACTOR_ORDER,
  MIN_SYMBOLS,
  PCT_VALUES,
  QUANTILE_GRIDS,
  REPRO_GRID,
  US_DROP_THRESHOLD,
  US_HALF_YEAR,
  US_MIN_TRADES,
  US_TRIALS_PRIOR_TOTAL,
  US_UNI20,
  US_UNI80,
  WALL_QQQ,
  alignDailyMatrix,
  alphaOf,
  buildYearCtxs,
  calmarOf,
  cellKey,
  compareBasisFor,
  countVariants,
  enumerateGrid,
  estimateBanner,
  fetchDelayMs,
  flatIndex,
  gridsForMode,
  hi52Ratio,
  idxBefore,
  isRebalanceMonth,
  lastCloseBefore,
  localFailReasons,
  lowVolStdev,
  modeFromEnv,
  momentumOf,
  neighborsOf,
  pboMaxCombinations,
  perfOf,
  pickUniverse,
  promotionVerdict,
  quantileGridOf,
  rankUniverse,
  runUsChain,
  scorePlateau,
  shiftMonthStart,
  shortRevReturn,
  simulateYear,
  slotsFor,
  syntheticBars,
  validateGrid,
  volSurgeRatio,
  type Curve,
  type LabGrid,
  type PlateauScore,
  type UsParams,
  type VariantResult,
  type YearCtx,
} from '../scripts/us-lab.entry'
import { US_BLOCKED_TICKERS, resolveUsTicker } from '../src/features/backtest/usPitUniverse'
import type { DailyBar } from '../src/features/backtest/types'

// ============================================================================
// 합성 세계 — 결정적(난수 시드 고정)
// ============================================================================

const FROM = '2009-01-01'
const DAYS = 365 * 9 // 2009~2017

function world(nSyms = 14, seed = 41) {
  const histories: Record<string, DailyBar[]> = {}
  const codes: string[] = []
  for (let i = 0; i < nSyms; i++) {
    const code = `S${String(i).padStart(2, '0')}`
    codes.push(code)
    histories[code] = syntheticBars(seed + i * 19, FROM, DAYS, 100 + i * 3, (i - nSyms / 2) * 0.00008)
  }
  const years = [2010, 2011, 2012, 2013, 2014, 2015, 2016, 2017]
  return { histories, codes, years, codesFor: () => codes }
}

const idOf = (c: string) => c
const W = world()

/** 전 종목 봉을 `cut` 이후로 잘라낸다(절단 불변성 입력). */
function truncate(h: Record<string, DailyBar[]>, cut: string): Record<string, DailyBar[]> {
  const out: Record<string, DailyBar[]> = {}
  for (const [k, bars] of Object.entries(h)) out[k] = bars.filter((b) => b.date <= cut)
  return out
}

/** `cut` **이후** 봉만 배수로 조작한다(길이는 그대로 — 절단보다 강한 조작). */
function mutateAfter(h: Record<string, DailyBar[]>, cut: string, mul: number): Record<string, DailyBar[]> {
  const out: Record<string, DailyBar[]> = {}
  for (const [k, bars] of Object.entries(h))
    out[k] = bars.map((b) =>
      b.date > cut ? { ...b, o: b.o * mul, h: b.h * mul, l: b.l * mul, c: b.c * mul, v: b.v * mul } : b,
    )
  return out
}

/** `from` **이상**(포함) 봉을 배수로 조작한다 — 랭킹 창 경계 검증용. */
function mutateFrom(bars: DailyBar[], from: string, mul: number): DailyBar[] {
  return bars.map((b) =>
    b.date >= from ? { ...b, o: b.o * mul, h: b.h * mul, l: b.l * mul, c: b.c * mul, v: b.v * mul } : b,
  )
}

function chainOf(h: Record<string, DailyBar[]>, years: number[], codesFor: () => string[], p: UsParams) {
  const ctxs = buildYearCtxs(h, years, codesFor, idOf)
  return runUsChain(ctxs, COST_US, p)
}

/** 두 곡선을 `cut` 이전(또는 이하) 구간에서 완전 비교. 불일치 점 수를 돌려준다. */
function diffBefore(a: Curve, b: Curve, cut: string, inclusive: boolean): { n: number; diffs: number } {
  const fa = a.filter((p) => (inclusive ? p.date <= cut : p.date < cut))
  const fb = b.filter((p) => (inclusive ? p.date <= cut : p.date < cut))
  const n = Math.min(fa.length, fb.length)
  let diffs = Math.abs(fa.length - fb.length)
  for (let i = 0; i < n; i++) if (fa[i].date !== fb[i].date || !Object.is(fa[i].equity, fb[i].equity)) diffs++
  return { n: fa.length, diffs }
}

const base: UsParams = {
  factor: 'mom',
  lookback: 12,
  skip: 1,
  sizing: { kind: 'quantile', pct: DECILE_PCT },
  gate: false,
  rebalMonths: 1,
}

/**
 * 다섯 계열 × 슬롯 정의(절대·분위) × 게이트를 골고루 덮는다.
 * 한 계열만 덮으면 다른 계열 창의 미래참조를 놓친다 — 실제로 계열마다 창 정의가 다르다.
 */
const CASES: UsParams[] = [
  { ...base, factor: 'mom', sizing: { kind: 'fixed', n: 5 }, gate: true },
  { ...base, factor: 'mom', sizing: { kind: 'quantile', pct: 10 } },
  { ...base, factor: 'mom', lookback: 6, skip: 0, sizing: { kind: 'quantile', pct: 20 }, gate: true },
  { ...base, factor: 'lowvol', sizing: { kind: 'quantile', pct: 15 }, gate: true },
  { ...base, factor: 'lowvol', sizing: { kind: 'fixed', n: 3 } },
  { ...base, factor: 'hi52', sizing: { kind: 'quantile', pct: 10 }, gate: true },
  { ...base, factor: 'hi52', sizing: { kind: 'quantile', pct: 20 }, rebalMonths: 3 },
  { ...base, factor: 'volrank', sizing: { kind: 'quantile', pct: 10 }, gate: true },
  { ...base, factor: 'volrank', sizing: { kind: 'fixed', n: 5 } },
  { ...base, factor: 'strev', sizing: { kind: 'quantile', pct: 15 }, gate: true },
  { ...base, factor: 'strev', sizing: { kind: 'quantile', pct: 5 }, rebalMonths: 6 },
]

// ============================================================================
section('1) 절단 불변성 — 뒤를 잘라내도 잘린 시점 이전이 완전히 같다 (규칙 1 집행)')
// ============================================================================

for (const cut of ['2013-07-15', '2015-02-28']) {
  const truncH = truncate(W.histories, cut)
  for (const p of CASES) {
    const full = chainOf(W.histories, W.years, W.codesFor, p)
    const cutRun = chainOf(truncH, W.years, W.codesFor, p)
    const { n, diffs } = diffBefore(full.equity, cutRun.equity, cut, false)
    check(`[${cellKey(p)}] ${cut} 절단 — 이전 구간 ${n}점이 비지 않는다`, n > 200, `${n}점`)
    eq(`[${cellKey(p)}] ${cut} 절단 전 자산곡선 완전 일치`, diffs, 0)
  }
}

// 연도별 수익률도 앞 구간에서 같아야 한다(연 단위 연쇄라 절단 해는 제외하고 본다)
{
  const cut = '2014-12-31' // 연말 경계 — 절단 해가 통째로 끝나는 지점
  const truncH = truncate(W.histories, cut)
  for (const p of CASES) {
    const full = chainOf(W.histories, W.years, W.codesFor, p)
    const cutRun = chainOf(truncH, W.years, W.codesFor, p)
    const fullYears = full.perYear.filter((r) => r.y <= 2014)
    const cutYears = cutRun.perYear.filter((r) => r.y <= 2014)
    eq(`[${cellKey(p)}] 연말 절단 — 연도 수 동일`, cutYears.length, fullYears.length)
    let bad = 0
    for (let i = 0; i < fullYears.length; i++)
      if (fullYears[i].y !== cutYears[i].y || !Object.is(fullYears[i].ret, cutYears[i].ret)) bad++
    eq(`[${cellKey(p)}] 연말 절단 — 연도별 수익률 완전 일치`, bad, 0)
  }
}

// ============================================================================
section('2) 미래 조작 불변성 — 뒤를 3배로 바꿔도 그 이전이 한 점도 안 변한다 (절단보다 강함)')
// ============================================================================

for (const cut of ['2012-06-29', '2014-09-30']) {
  const mutH = mutateAfter(W.histories, cut, 3)
  for (const p of CASES) {
    const full = chainOf(W.histories, W.years, W.codesFor, p)
    const mut = chainOf(mutH, W.years, W.codesFor, p)
    // 길이가 같으므로 **경계 당일까지 포함**해 완전 일치를 요구한다.
    const { n, diffs } = diffBefore(full.equity, mut.equity, cut, true)
    check(`[${cellKey(p)}] ${cut} 이후 3배 조작 — 비교 구간 ${n}점`, n > 200, `${n}점`)
    eq(`[${cellKey(p)}] ${cut}까지 자산곡선 완전 일치(미래참조 0건)`, diffs, 0)
  }
}

// ============================================================================
section('3) 랭킹 창의 인과성 — 리밸런스 달 봉을 통째로 조작해도 그날 점수가 안 바뀐다 (계열별)')
// ============================================================================

{
  const REBAL = '2014-04-02' // 4월 첫 거래일 근처 — 창 경계는 2014-04-01
  const monthStart = shiftMonthStart(REBAL, 0)
  const sym = 'S03'
  const bars = W.histories[sym]
  const mutated = mutateFrom(bars, monthStart, 5)
  eq('조작 전후 봉 수가 같다(길이 조작 아님)', mutated.length, bars.length)
  check(
    '리밸런스 달 안의 봉이 실제로 바뀌었다(조작이 무의미하지 않은지 확인)',
    mutated.some((b, i) => b.date >= monthStart && b.c !== bars[i].c),
  )

  for (const f of FACTOR_ORDER) {
    const fam = FACTORS[f]
    const p: UsParams = { ...base, factor: f }
    const a = fam.score(bars, REBAL, p)
    const b = fam.score(mutated, REBAL, p)
    check(`[${f}] 점수를 낼 수 있다(창이 채워졌다)`, a != null && b != null)
    if (a && b) {
      eq(`[${f}] 리밸런스 달 조작에도 score 불변`, b.score, a.score)
      eq(`[${f}] 리밸런스 달 조작에도 aux 불변`, b.aux, a.aux)
    }
  }

  // 랭킹 결과(순서)도 통째로 같아야 한다 — 점수 하나가 아니라 단면 전체를 본다.
  for (const f of FACTOR_ORDER) {
    const mutWorld = { ...W.histories, [sym]: mutated }
    const p: UsParams = { ...base, factor: f }
    const r0 = rankUniverse(W.histories, W.codes, REBAL, p)
    const r1 = rankUniverse(mutWorld, W.codes, REBAL, p)
    eq(`[${f}] 랭킹 길이 불변`, r1.length, r0.length)
    let bad = 0
    for (let i = 0; i < Math.min(r0.length, r1.length); i++)
      if (r0[i].sym !== r1[i].sym || !Object.is(r0[i].score, r1[i].score)) bad++
    eq(`[${f}] 리밸런스 달 조작에도 랭킹 순서·점수 완전 일치`, bad, 0)
  }

  // 창 **밖**(직전 달)을 건드리면 반드시 바뀌어야 한다 — 테스트가 헛도는지 확인.
  const prevStart = shiftMonthStart(REBAL, -1)
  const sensitive = bars.map((b) =>
    b.date >= prevStart && b.date < monthStart ? { ...b, o: b.o * 2, h: b.h * 2, l: b.l * 2, c: b.c * 2, v: b.v * 2 } : b,
  )
  let changed = 0
  for (const f of FACTOR_ORDER) {
    const a = FACTORS[f].score(bars, REBAL, { ...base, factor: f })
    const b = FACTORS[f].score(sensitive, REBAL, { ...base, factor: f })
    if (a && b && a.score !== b.score) changed++
  }
  check(
    '직전 달(창 안)을 건드리면 점수가 바뀐다 — 인과성 테스트가 헛돌지 않는다',
    changed >= 4,
    `${changed}/5 계열이 반응`,
  )
}

// ============================================================================
section('4) 롤링 극값 시프트(규칙 1-3) · 창 경계 산술')
// ============================================================================

{
  const bars = W.histories['S05']
  const date = '2015-07-01'
  const monthStart = shiftMonthStart(date, 0)
  // 리밸런스 달에 **터무니없이 높은 고가**를 심어도 52주 최고가가 안 바뀌어야 한다.
  const spiked = bars.map((b) => (b.date >= monthStart ? { ...b, h: b.h * 100 } : b))
  const r0 = hi52Ratio(bars, date)
  const r1 = hi52Ratio(spiked, date)
  check('hi52 근접도를 낼 수 있다', r0 != null)
  eq('당일·당월 고가를 심어도 52주 최고가 창이 안 변한다(규칙 1-3)', r1, r0)

  eq('shiftMonthStart 0 = 그 달 1일', shiftMonthStart('2015-07-23', 0), '2015-07-01')
  eq('shiftMonthStart -12 = 12개월 전 달 1일', shiftMonthStart('2015-01-05', -12), '2014-01-01')
  eq('shiftMonthStart -1 연도 경계', shiftMonthStart('2015-01-05', -1), '2014-12-01')

  const idx = idxBefore(bars, '2012-01-01')
  check('idxBefore는 strictly before만 센다', bars[idx - 1].date < '2012-01-01' && bars[idx].date >= '2012-01-01')
  eq('lastCloseBefore는 그 경계 직전 종가', lastCloseBefore(bars, '2012-01-01'), bars[idx - 1].c)

  // 계열 창이 하나라도 미래를 보면 아래 값들이 조작에 반응한다 — 개별로도 한 번 더 못 박는다.
  const mut = mutateFrom(bars, monthStart, 7)
  eq('lowVolStdev 창 경계', lowVolStdev(mut, date), lowVolStdev(bars, date))
  eq('shortRevReturn 창 경계', shortRevReturn(mut, date), shortRevReturn(bars, date))
  eq('volSurgeRatio 창 경계', volSurgeRatio(mut, date), volSurgeRatio(bars, date))
  eq('momentumOf 창 경계', momentumOf(mut, date, 12, 1), momentumOf(bars, date, 12, 1))
}

// ============================================================================
section('5) 마지막 봉 신규 진입 금지 (규칙 1-6)')
// ============================================================================

{
  const ctxs = buildYearCtxs(W.histories, [2013], W.codesFor, idOf)
  const ctx = ctxs[0]
  // 2월 첫 거래일(= 두 번째 리밸런스일)의 인덱스를 찾는다
  let febIdx = -1
  for (let i = 1; i < ctx.calendar.length; i++)
    if (ctx.calendar[i].slice(0, 7) === '2013-02' && ctx.calendar[i - 1].slice(0, 7) === '2013-01') {
      febIdx = i
      break
    }
  check('2월 첫 거래일을 찾았다', febIdx > 0, `febIdx=${febIdx}`)
  const p: UsParams = { ...base, factor: 'mom', sizing: { kind: 'fixed', n: 5 } }
  const cut = (k: number): YearCtx => ({ ...ctx, calendar: ctx.calendar.slice(0, k + 1) })
  const upTo = simulateYear(cut(febIdx), COST_US, p)
  const before = simulateYear(cut(febIdx - 1), COST_US, p)
  check(
    '구간 마지막 봉이 리밸런스일이면 보유 종목이 늘지 않는다(매도·트림만 허용)',
    upTo.openAtEnd <= before.openAtEnd,
    `${before.openAtEnd} → ${upTo.openAtEnd}`,
  )
  check('그 이전까지는 실제로 보유가 있었다(테스트가 공허하지 않다)', before.openAtEnd > 0, `${before.openAtEnd}`)

  // 하루짜리 구간(그날이 리밸런스일)은 신규 진입이 0이어야 한다
  const oneDay = simulateYear(cut(0), COST_US, p)
  eq('첫날이자 마지막 날인 구간 — 신규 진입 0', oneDay.openAtEnd, 0)
  eq('첫날이자 마지막 날인 구간 — 자산 = 초기자본', oneDay.equity[0].equity, COST_US.initialCapital)
}

// ============================================================================
section('6) 분위 슬롯 산술 — 이 회차의 핵심 축')
// ============================================================================

eq('상위 10% × 후보 80 = 8슬롯 (27차 상위8과 정확히 겹친다)', slotsFor({ kind: 'quantile', pct: 10 }, 80), 8)
eq('상위 5% × 후보 80 = 4슬롯', slotsFor({ kind: 'quantile', pct: 5 }, 80), 4)
eq('상위 20% × 후보 80 = 16슬롯', slotsFor({ kind: 'quantile', pct: 20 }, 80), 16)
eq('상위 10% × 후보 20 = 2슬롯 (상위 20 유니버스에서는 분위가 이렇게 얇아진다)', slotsFor({ kind: 'quantile', pct: 10 }, 20), 2)
eq('분위가 0으로 떨어져도 최소 1슬롯', slotsFor({ kind: 'quantile', pct: 5 }, 3), 1)
eq('분위 슬롯은 후보수를 넘지 않는다', slotsFor({ kind: 'quantile', pct: 100 }, 7), 7)
eq('절대 슬롯은 후보수로 잘린다', slotsFor({ kind: 'fixed', n: 12 }, 5), 5)
eq('후보 0이면 1(0으로 나누지 않는다)', slotsFor({ kind: 'fixed', n: 5 }, 0), 1)

{
  // 분위 슬롯이 실제 시뮬에서 후보 수에 따라 움직이는지 — 상수로 굳어 있으면 분위가 아니다
  const ctxs = buildYearCtxs(W.histories, W.years, W.codesFor, idOf)
  const q10 = runUsChain(ctxs, COST_US, { ...base, sizing: { kind: 'quantile', pct: 10 } })
  const q20 = runUsChain(ctxs, COST_US, { ...base, sizing: { kind: 'quantile', pct: 20 } })
  check('분위 10% 평균 슬롯 < 분위 20% 평균 슬롯', (q10.avgSlots ?? 0) < (q20.avgSlots ?? 0), `${q10.avgSlots} vs ${q20.avgSlots}`)
  closeTo('합성 14종목 × 10% ≈ 1슬롯', q10.avgSlots ?? 0, 1, 0.5)
  closeTo('합성 14종목 × 20% ≈ 3슬롯', q20.avgSlots ?? 0, 3, 0.6)
}

eq('리밸런스 달 판정 — 매월', isRebalanceMonth(7, 1), true)
eq('리밸런스 달 판정 — 분기(1·4·7·10월)', [1, 4, 7, 10].every((m) => isRebalanceMonth(m, 3)), true)
eq('리밸런스 달 판정 — 분기 아님(2·3·5월)', [2, 3, 5].some((m) => isRebalanceMonth(m, 3)), false)

// ============================================================================
section('7) 격자·이웃·고원 산술')
// ============================================================================

{
  const g: LabGrid = {
    id: 't',
    label: 't',
    question: 't',
    base,
    axes: [
      { key: 'pct', label: '분위', values: [5, 10, 15, 20], unit: '%' },
      { key: 'gate', label: '게이트', values: [0, 1], unit: '' },
    ],
  }
  const cells = enumerateGrid(g)
  eq('격자 셀 수 = 축 값 수의 곱', cells.length, 8)
  // 사전식 = 마지막 축이 가장 빨리 돈다
  eq('사전식 순서 — 0번 셀', cells[0].key, cellKey({ ...base, sizing: { kind: 'quantile', pct: 5 }, gate: false }))
  eq('사전식 순서 — 1번 셀(마지막 축이 먼저 돈다)', cells[1].key, cellKey({ ...base, sizing: { kind: 'quantile', pct: 5 }, gate: true }))
  eq('사전식 순서 — 2번 셀', cells[2].key, cellKey({ ...base, sizing: { kind: 'quantile', pct: 10 }, gate: false }))
  eq('globalIndex 오프셋이 반영된다', enumerateGrid(g, 100)[3].globalIndex, 103)

  eq('flatIndex 격자 밖은 -1', flatIndex([4, 0], [4, 2]), -1)
  eq('flatIndex 사전식', flatIndex([2, 1], [4, 2]), 5)

  // 이웃 = 각 축 ±1, 대각선 제외
  const inner = cells[2] // pct=10, gate=0 → pct± 둘 다 있고 gate+만 있다
  const nb = neighborsOf(inner, g)
  eq('내부 pct + 경계 gate → 이웃 3개', nb.found.length, 3)
  eq('gate 축의 한쪽이 없다', nb.missing.length, 1)
  check('대각선은 이웃이 아니다', nb.found.every((n) => n.axis === 'pct' || n.axis === 'gate'))

  const corner = cells[0] // pct=5, gate=0 → 양 축 모두 한쪽만
  eq('모서리 셀 이웃 2개', neighborsOf(corner, g).found.length, 2)
  eq('모서리 셀 missing 2개', neighborsOf(corner, g).missing.length, 2)

  // 축 값이 1개면 frozen(경계가 아니라 설계상 고정)
  const frozenGrid: LabGrid = { ...g, axes: [g.axes[0], { key: 'gate', label: 'g', values: [1], unit: '' }] }
  eq('값 1개 축은 frozen으로 계수된다', neighborsOf(enumerateGrid(frozenGrid)[1], frozenGrid).frozen.length, 1)

  // 고원 점수 = **최솟값**(평균 아님)
  const scores = [0.9, 0.5, 1.0, 0.2, 0.4, 0.4, 0.4, 0.4]
  const pass = scores.map(() => true)
  const ps = scorePlateau(cells, g, scores, pass)
  const at2 = ps[2] // pct=10,gate=0 — 이웃: idx0(0.9)·idx4(0.4)·idx3(0.2)
  eq('이웃최솟값 = min(이웃)', at2.minNeighbor, 0.2)
  eq('plateauScore = min(셀, 이웃최솟값) — 평균이 아니다', at2.plateauScore, 0.2)
  closeTo('plateauDrop = (셀 − 이웃최솟값) ÷ |셀|', at2.plateauDrop ?? -1, (1.0 - 0.2) / 1.0, 1e-12)
  check('경계 셀은 sampleShort로 라벨된다', ps[0].sampleShort)

  // 이웃 성적이 하나라도 null이면 고원 판정 불가 — 0이나 평균으로 메우지 않는다
  const withNull = scorePlateau(cells, g, [0.9, 0.5, 1.0, null, 0.4, 0.4, 0.4, 0.4], pass)
  eq('이웃 null이면 minNeighbor도 null', withNull[2].minNeighbor, null)
  eq('이웃 null이면 plateauScore도 null(0으로 메우지 않는다)', withNull[2].plateauScore, null)
  check('null 사유를 남긴다(조용히 빈칸 아님)', (withNull[2].reason ?? '').includes('이웃'))

  // 이웃 중 관문 탈락이 있으면 neighborsPassLocal=false
  const mixed = scorePlateau(cells, g, scores, [true, true, true, false, true, true, true, true])
  eq('이웃 중 탈락이 있으면 false', mixed[2].neighborsPassLocal, false)

  // 격자 검증
  let threw = false
  try {
    validateGrid({ ...g, axes: [{ key: 'pct', label: 'x', values: [20, 5], unit: '%' }] })
  } catch {
    threw = true
  }
  check('축이 내림차순이면 던진다(이웃 정의가 깨지므로)', threw)

  threw = false
  try {
    validateGrid({
      ...g,
      axes: [
        { key: 'pct', label: 'x', values: [5, 10], unit: '%' },
        { key: 'slots', label: 'y', values: [3, 5], unit: '종목' },
      ],
    })
  } catch {
    threw = true
  }
  check('slots와 pct를 동시에 축으로 두면 던진다(슬롯 정의가 두 개가 된다)', threw)
}

// ============================================================================
section('8) 승격 관문 — 다섯 개를 전부 통과해야만 승격')
// ============================================================================

{
  const good: VariantResult = {
    gridId: 'g',
    cell: { index: 0, coords: [0], params: base, key: 'k', globalIndex: 0 },
    full: { total: 100, cagr: 10, mdd: -20, years: 8 },
    a: { total: 40, cagr: 8, mdd: -15, years: 4 },
    b: { total: 40, cagr: 9, mdd: -18, years: 4 },
    calmar: 0.5,
    sharpeDaily: 0.05,
    alphaFull: 3,
    alphaA: 2,
    alphaB: 1,
    trades: 50,
    wins: 25,
    rebalances: 96,
    avgSlots: 8,
    perYear: [],
    dailyReturns: [],
  }
  const flat: PlateauScore = {
    index: 0,
    self: 0.5,
    neighbors: 3,
    missing: [],
    frozen: [],
    minNeighbor: 0.45,
    plateauScore: 0.45,
    plateauDrop: 0.1,
    neighborsPassLocal: true,
    sampleShort: false,
    reason: null,
  }
  const round = { pbo: 0.3, wfOosAlpha: 2 }
  eq('다섯 관문 전부 통과 → 승격', promotionVerdict(good, flat, round).promoted, true)
  eq('①전반 알파 음수 → 탈락', promotionVerdict({ ...good, alphaA: -1 }, flat, round).promoted, false)
  eq('①후반 알파 음수 → 탈락', promotionVerdict({ ...good, alphaB: -1 }, flat, round).promoted, false)
  eq('①알파 null → 탈락(계산 불가를 통과로 읽지 않는다)', promotionVerdict({ ...good, alphaA: null }, flat, round).promoted, false)
  eq(`②매매수 < ${US_MIN_TRADES} → 탈락`, promotionVerdict({ ...good, trades: US_MIN_TRADES - 1 }, flat, round).promoted, false)
  eq('③PBO ≥ 0.5 → 탈락', promotionVerdict(good, flat, { pbo: 0.5, wfOosAlpha: 2 }).promoted, false)
  eq('③PBO 계산불가 → 탈락', promotionVerdict(good, flat, { pbo: null, wfOosAlpha: 2 }).promoted, false)
  eq('④WF OOS 알파 ≤ 0 → 탈락', promotionVerdict(good, flat, { pbo: 0.3, wfOosAlpha: 0 }).promoted, false)
  eq('④WF 계산불가 → 탈락', promotionVerdict(good, flat, { pbo: 0.3, wfOosAlpha: null }).promoted, false)
  eq(
    `⑤plateauDrop > ${US_DROP_THRESHOLD} → 탈락`,
    promotionVerdict(good, { ...flat, plateauDrop: US_DROP_THRESHOLD + 0.01 }, round).promoted,
    false,
  )
  eq('⑤이웃 중 관문 탈락 존재 → 탈락', promotionVerdict(good, { ...flat, neighborsPassLocal: false }, round).promoted, false)
  eq('⑤고원 판정 불가 → 탈락', promotionVerdict(good, { ...flat, plateauDrop: null }, round).promoted, false)
  eq(`⑤임계 경계값(정확히 ${US_DROP_THRESHOLD})은 통과`, promotionVerdict(good, { ...flat, plateauDrop: US_DROP_THRESHOLD }, round).promoted, true)

  eq('localFailReasons — 전부 통과면 빈 배열', localFailReasons(good).length, 0)
  eq('localFailReasons — 사유를 문자열로 남긴다', localFailReasons({ ...good, trades: 1 }).length, 1)
}

// ============================================================================
section('9) 27차 재현 격자 · 비용 · 벤치 · 누적 분모 대조 (값이 갈리면 옛 표와 못 읽는다)')
// ============================================================================

eq('비용 — 초기자본', COST_US.initialCapital, 10_000_000)
eq('비용 — 수수료 0.1%', COST_US.feePct, 0.1)
eq('비용 — 미국은 매도 거래세 0', COST_US.taxPct, 0)
eq('비용 — 슬리피지 0.1%', COST_US.slippagePct, 0.1)
eq('벤치는 SPY(규칙 5)', BENCH_US, 'SPY')
eq('참고 벽은 QQQ', WALL_QQQ, 'QQQ')
eq('전·후반 분할은 2014 고정(idea-lab HALF_YEAR와 같은 값)', US_HALF_YEAR, 2014)
eq('표본 소실 판정선 20', US_MIN_TRADES, 20)
eq('고원 임계 0.30(39차와 같은 값)', US_DROP_THRESHOLD, 0.3)
eq('그 해 매핑 최소 종목 5', MIN_SYMBOLS, 5)
eq('미장 누적 분모 = 36 + 6 + 8 = 50 (국장 97과 섞지 않는다)', US_TRIALS_PRIOR_TOTAL, 50)
eq('학계 표준 분위 = 10%', DECILE_PCT, 10)
eq('분위 축은 10%를 가운데 둔다', PCT_VALUES.join(','), '5,10,15,20')
eq('미장 비교 기준은 총수익 하나뿐(배당 비대칭 없음)', compareBasisFor('yahoo'), 'total')

{
  const cells = enumerateGrid(REPRO_GRID)
  eq('27차 재현 격자 = 8변형(슬롯 4종 × 게이트 2)', cells.length, 8)
  const slots = [...new Set(cells.map((c) => (c.params.sizing.kind === 'fixed' ? c.params.sizing.n : -1)))].sort((a, b) => a - b)
  eq('27차 슬롯 목록 5·8·12·16 그대로', slots.join(','), '5,8,12,16')
  check('재현 격자는 전부 12-1 모멘텀', cells.every((c) => c.params.factor === 'mom' && c.params.lookback === 12 && c.params.skip === 1))
  check('재현 격자는 전부 절대 슬롯(분위 아님)', cells.every((c) => c.params.sizing.kind === 'fixed'))
  check(
    '27차 승자(상위8+게이트)가 격자 안에 있다',
    cells.some((c) => c.params.sizing.kind === 'fixed' && c.params.sizing.n === 8 && c.params.gate),
  )

  eq('분위 격자는 다섯 계열', QUANTILE_GRIDS.length, 5)
  check('분위 격자는 전부 분위 슬롯', QUANTILE_GRIDS.every((g) => g.base.sizing.kind === 'quantile'))
  check(
    '분위 격자 기본값이 학계 분위(10%)',
    QUANTILE_GRIDS.every((g) => g.base.sizing.kind === 'quantile' && g.base.sizing.pct === DECILE_PCT),
  )
  eq('MODE=all 변형 수 = 재현 8 + 계열 5×8 = 48', countVariants(gridsForMode('all')), 48)
  eq('MODE=xsmom 변형 수 = 재현 8 + 모멘텀 분위 8 = 16', countVariants(gridsForMode('xsmom')), 16)
  eq('MODE=quantile 변형 수 = 40', countVariants(gridsForMode('quantile')), 40)
  // MODE=all에서 모멘텀 분위 격자가 두 번 세어지지 않아야 한다(id로 확인)
  const ids = gridsForMode('all').map((g) => g.id)
  eq('MODE=all 격자 id 중복 없음', new Set(ids).size, ids.length)
  eq('MODE=xsmom의 모멘텀 분위 격자는 quantile 모드의 그것과 같은 id', quantileGridOf('mom').id, 'quantile-mom')
}

eq('MODE 파싱 — 기본값 all', modeFromEnv(undefined), 'all')
eq('MODE 파싱 — 대소문자·공백 무시', modeFromEnv(' Quantile '), 'quantile')
{
  let threw = false
  try {
    modeFromEnv('nope')
  } catch {
    threw = true
  }
  check('모르는 MODE는 던진다(조용히 기본값으로 넘어가지 않는다)', threw)
}

eq('야후 호출 간격 기본 120ms', fetchDelayMs(undefined), 120)
eq('빈 문자열을 0으로 읽지 않는다', fetchDelayMs(''), 120)
eq('숫자는 그대로 쓴다', fetchDelayMs('250'), 250)
eq('이상한 값은 기본값으로', fetchDelayMs('abc'), 120)

// ============================================================================
section('10) 유니버스 어댑터 · [추정] 경고 · 티커 재사용 차단')
// ============================================================================

eq('기본 유니버스는 US PIT 80(27차가 알파를 낸 유일한 표본)', pickUniverse(undefined).key, '80')
eq('US_UNIVERSE=20으로 갈아끼울 수 있다', pickUniverse('20').key, '20')
{
  let threw = false
  try {
    pickUniverse('999')
  } catch {
    threw = true
  }
  check('모르는 유니버스는 던진다(어느 목록으로 돌았는지가 해석의 전제라서)', threw)
}
check('US PIT 80은 [추정] 목록으로 표시된다', US_UNI80.estimated)
check('US PIT 20도 [추정] 목록으로 표시된다', US_UNI20.estimated)
check('[추정] 배너에 경고가 들어간다', estimateBanner(US_UNI80).includes('[추정]'))
check('실측 목록으로 바뀌면 배너 문구도 바뀐다', estimateBanner({ ...US_UNI80, estimated: false }).includes('실측'))
check('상위 80 합집합이 상위 20보다 넓다', US_UNI80.union.length > US_UNI20.union.length)
check('상위 80은 상위 20을 부분집합으로 포함한다', US_UNI20.union.every((t) => US_UNI80.union.includes(t)))

// 티커 재사용 차단 규약(정본 그대로 쓰는지) — 상폐 대형주 자리에 엉뚱한 소형주가 들어오면
// 백테스트가 조용히 오염된다. 매핑 거부(= 정직한 실패)가 정답이다.
check('US_BLOCKED_TICKERS가 비어 있지 않다', US_BLOCKED_TICKERS.size > 0)
for (const t of ['LU', 'WB', 'ENE', 'LEH']) {
  check(`${t}는 차단 목록에 있다`, US_BLOCKED_TICKERS.has(t))
  eq(`${t}는 시세가 있어도 매핑을 거부한다`, resolveUsTicker(t, () => true), undefined)
}
eq('차단되지 않은 티커는 정상 매핑된다', resolveUsTicker('AAPL', (s) => s === 'AAPL'), 'AAPL')
eq('사명 변경은 이어 쓴다(FB→META)', resolveUsTicker('FB', (s) => s === 'META'), 'META')
eq('시세가 없으면 매핑 실패(조용한 대체 없음)', resolveUsTicker('AAPL', () => false), undefined)

{
  // 차단 티커는 연도 컨텍스트에서도 빠져 매핑률로 드러나야 한다
  const hist: Record<string, DailyBar[]> = { LU: syntheticBars(1, FROM, DAYS, 100), AAPL: syntheticBars(2, FROM, DAYS, 100) }
  const ctxs = buildYearCtxs(hist, [2012], () => ['LU', 'AAPL'], (c) => resolveUsTicker(c, (s) => !!hist[s]?.length))
  eq('차단 티커는 편입되지 않는다', ctxs[0].symbols.join(','), 'AAPL')
  eq('매핑률 분모는 원래 코드 수 그대로(실패를 숨기지 않는다)', ctxs[0].totalCodes, 2)
}

// ============================================================================
section('11) 성과 지표 · 행렬 정렬 · PBO 예산')
// ============================================================================

{
  const curve: Curve = [
    { date: '2010-01-01', equity: 100 },
    { date: '2010-07-01', equity: 150 },
    { date: '2011-01-01', equity: 120 },
    { date: '2012-01-01', equity: 200 },
  ]
  const p = perfOf(curve)
  closeTo('총수익', p.total, 100, 1e-9)
  closeTo('MDD는 고점 대비 낙폭', p.mdd, (120 / 150 - 1) * 100, 1e-9)
  check('CAGR은 2년 복리에 가깝다', Math.abs(p.cagr - 41.4) < 1.5, `${p.cagr}`)
  closeTo('칼마 = CAGR ÷ |MDD|', calmarOf(p) ?? 0, p.cagr / Math.abs(p.mdd), 1e-9)
  eq('MDD≈0이면 칼마는 null(0으로 메우지 않는다)', calmarOf({ total: 5, cagr: 5, mdd: 0, years: 1 }), null)

  // 알파는 **겹치는 구간에서만** — 벤치 없는 구간을 전략에만 유리하게 넣지 않는다
  const bench: Curve = [
    { date: '2011-01-01', equity: 100 },
    { date: '2012-01-01', equity: 110 },
  ]
  const a = alphaOf(curve, bench, '', '9999-12-31')
  check('알파가 겹치는 구간에서만 계산된다', a != null)
  const noOverlap = alphaOf(curve, [{ date: '2030-01-01', equity: 1 }, { date: '2031-01-01', equity: 2 }], '', '9999-12-31')
  eq('겹치지 않으면 알파는 null(0으로 읽지 않는다)', noOverlap, null)
}

{
  const s1 = { dates: ['a', 'b', 'c'], returns: [1, 2, 3] }
  const s2 = { dates: ['b', 'c', 'd'], returns: [20, 30, 40] }
  const al = alignDailyMatrix([s1, s2])
  eq('공통 날짜만 남긴다', al.dates.join(','), 'b,c')
  eq('버린 날 수를 조용히 삼키지 않는다', al.dropped, 2)
  eq('행렬이 같은 날짜 축에 정렬된다', al.matrix.map((r) => r.join('|')).join(' / '), '2|3 / 20|30')
  const withBench = alignDailyMatrix([s1, s2], { dates: ['c'], returns: [7] })
  eq('벤치가 없는 날도 뺀다(시점 밀림 방지)', withBench.dates.join(','), 'c')
}

check('PBO 조합 상한은 변형 수에 반비례한다', pboMaxCombinations(48) < pboMaxCombinations(4) || pboMaxCombinations(48) === 20000)
eq('상한 하한선 200', pboMaxCombinations(100000), 200)
eq('상한 최대 20000', pboMaxCombinations(1), 20000)

// ============================================================================
section('12) 결정론 — 같은 입력이면 같은 출력(난수 없음)')
// ============================================================================

for (const p of CASES.slice(0, 5)) {
  const a = chainOf(W.histories, W.years, W.codesFor, p)
  const b = chainOf(W.histories, W.years, W.codesFor, p)
  let diffs = Math.abs(a.equity.length - b.equity.length)
  for (let i = 0; i < Math.min(a.equity.length, b.equity.length); i++)
    if (!Object.is(a.equity[i].equity, b.equity[i].equity)) diffs++
  eq(`[${cellKey(p)}] 두 번 돌려도 자산곡선 완전 동일`, diffs, 0)
  eq(`[${cellKey(p)}] 매매수 동일`, a.closed, b.closed)
}

{
  // 동점 처리도 결정적이어야 한다 — 같은 점수면 심볼 오름차순
  const flatBars = (seed: number) => syntheticBars(seed, FROM, 400, 100)
  const h: Record<string, DailyBar[]> = { BBB: flatBars(9), AAA: flatBars(9), CCC: flatBars(9) }
  const r = rankUniverse(h, ['CCC', 'BBB', 'AAA'], '2010-03-01', { ...base, factor: 'mom' })
  eq('동점은 심볼 오름차순(결정적)', r.map((x) => x.sym).join(','), 'AAA,BBB,CCC')
}

finish()
