// ⚠️ 이 파일은 `scripts/plateau-lab.entry.ts`에 대한 CLAUDE.md **규칙 1(미래참조 금지)의 집행자**다.
//
// 39차 고원 격자는 파라미터 5축(관측·제외·슬롯·게이트MA·리밸주기)을 흔들며 수백 번 백테스트를
// 돌린다. 그 안에서 미래참조가 한 군데라도 새면 **격자 전체가 조용히 거짓**이 되고, 고원처럼
// 보이는 영역이 실은 "미래를 본 영역"이 된다. 그래서 여기서 검증하는 것:
//
//   1) **절단 불변성** — 데이터 뒷부분을 잘라내고 다시 돌렸을 때 잘린 시점 **이전**의
//      자산곡선·매매수가 완전히 동일. (다섯 축 조합을 골고루 덮는다)
//   2) **미래 조작 불변성** — 절단보다 강한 조작. 길이는 그대로 두고 **잘린 시점 이후 봉만
//      3배로 바꿔** 다시 돌렸을 때, 그 시점까지의 자산곡선이 **한 점도** 안 바뀐다.
//      (절단은 "마지막 봉 신규 진입 금지"(규칙 1-6) 때문에 경계 한 점이 달라질 수 있지만,
//       이 조작은 길이가 같아 경계까지 포함해 완전 일치를 요구한다 — 더 강한 테스트다.)
//   3) **모멘텀 창의 인과성** — 리밸런스일 **당일** 봉을 아무리 조작해도 그날의 랭킹이 안 바뀐다.
//      skip=0(직전 달까지 다 보는 가장 위험한 설정)에서도 성립해야 한다.
//   4) **시장게이트 MA의 인과성** — 판정일 당일·이후 값을 조작해도 그날 노출이 안 바뀐다.
//      데이터 부족이면 **열림(1)** (사후지식 없이 기본값).
//   5) **격자·이웃 산술** — 사전식 인덱싱, 이웃 = ±1 스텝(대각선 제외), 경계 셀의 이웃 부족
//      표기, 고원 점수 = **최솟값**(평균 아님).
//   6) **승격 관문** — 다섯 관문을 전부 통과해야만 승격. 하나라도 빠지면 승격되지 않는다
//      ("가장 덜 나쁜 칸 승격 금지"의 집행자).
//   7) **비용·상수 대조** — 34·36·38차와 같은 비용 전제, 누적 분모 97.
//   8) **결정론** — 같은 입력이면 같은 출력(난수 없음).
//
// 실데이터(Yahoo)는 컨테이너에서 403이라 전부 **합성 시계열**로 검증한다.

import { check, close as closeTo, eq, section, finish, rng } from './harness'
import {
  AXIS_KEYS,
  BENCH,
  FULL_GRID,
  FULL_GRID_CELLS,
  MIN_SYMBOLS,
  PLATEAU_COST,
  PLATEAU_DROP_THRESHOLD,
  PLATEAU_MIN_TRADES,
  PLATEAU_TRIALS_PRIOR_TOTAL,
  QUICK_GRID,
  alignDailyMatrix,
  alphaOf,
  buildYearCtxs,
  calmarOf,
  cellKey,
  dailyReturnsOf,
  enumerateGrid,
  equalWeightIndex,
  flatIndex,
  halfYearOf,
  isRebalanceMonth,
  lastCloseBefore,
  localFailReasons,
  makeMaGateExposure,
  momentumOf,
  neighborsOf,
  parseWidthEnv,
  pboMaxCombinations,
  perfOf,
  promotionVerdict,
  rankUniverse,
  runPlateauChain,
  scorePlateau,
  shiftMonthStart,
  syntheticBars,
  validateGrid,
  type CellResult,
  type Curve,
  type GridSpec,
  type PlateauParams,
  type PlateauScore,
} from '../scripts/plateau-lab.entry'
import type { DailyBar } from '../src/features/backtest/types'

// ============================================================================
// 합성 세계 — 결정적(난수 시드 고정)
// ============================================================================

const FROM = '2009-01-01'
const DAYS = 365 * 9 // 2009~2017

function world(nSyms = 12, seed = 11) {
  const histories: Record<string, DailyBar[]> = {}
  const codes: string[] = []
  for (let i = 0; i < nSyms; i++) {
    const code = `S${String(i).padStart(2, '0')}`
    codes.push(code)
    histories[code] = syntheticBars(seed + i * 13, FROM, DAYS, 10_000 + i * 250, (i - nSyms / 2) * 0.00008)
  }
  const years = [2010, 2011, 2012, 2013, 2014, 2015, 2016, 2017]
  return { histories, codes, years, codesFor: () => codes }
}

const idOf = (c: string) => c

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
      b.date > cut ? { ...b, o: b.o * mul, h: b.h * mul, l: b.l * mul, c: b.c * mul } : b,
    )
  return out
}

function chainOf(h: Record<string, DailyBar[]>, years: number[], codesFor: () => string[], p: PlateauParams, regime?: Curve) {
  const ctxs = buildYearCtxs(h, years, codesFor, idOf)
  const exposure = p.gateMa > 0 && regime && regime.length >= 2 ? makeMaGateExposure(regime, p.gateMa) : undefined
  return runPlateauChain(ctxs, PLATEAU_COST, p, exposure)
}

/** 두 곡선을 `cut` 이전(또는 이하) 구간에서 완전 비교. 불일치 점 수를 돌려준다. */
function diffBefore(a: Curve, b: Curve, cut: string, inclusive: boolean): { n: number; diffs: number } {
  const fa = a.filter((p) => (inclusive ? p.date <= cut : p.date < cut))
  const fb = b.filter((p) => (inclusive ? p.date <= cut : p.date < cut))
  const n = Math.min(fa.length, fb.length)
  let diffs = Math.abs(fa.length - fb.length)
  for (let i = 0; i < n; i++) {
    if (fa[i].date !== fb[i].date || !Object.is(fa[i].equity, fb[i].equity)) diffs++
  }
  return { n: fa.length, diffs }
}

// ============================================================================
section('1) 절단 불변성 — 뒤를 잘라내도 잘린 시점 이전이 완전히 같다 (규칙 1 집행)')
// ============================================================================

const W = world()
const REGIME = equalWeightIndex(W.histories, W.codes, '2009-01-01')

/** 다섯 축을 골고루 덮는 조합 — 한 축만 덮으면 다른 축 경로의 미래참조를 놓친다. */
const TRUNC_CASES: PlateauParams[] = [
  { lookback: 12, skip: 1, slots: 5, gateMa: 0, rebalMonths: 1 },
  { lookback: 3, skip: 0, slots: 3, gateMa: 0, rebalMonths: 1 }, // skip=0 — 가장 위험한 설정
  { lookback: 6, skip: 2, slots: 8, gateMa: 150, rebalMonths: 3 },
  { lookback: 15, skip: 1, slots: 3, gateMa: 200, rebalMonths: 6 },
  { lookback: 9, skip: 2, slots: 5, gateMa: 200, rebalMonths: 3 },
]

for (const cut of ['2013-07-15', '2015-02-28']) {
  const truncH = truncate(W.histories, cut)
  const truncRegime = REGIME.filter((p) => p.date <= cut)
  for (const p of TRUNC_CASES) {
    const full = chainOf(W.histories, W.years, W.codesFor, p, REGIME)
    const cutRun = chainOf(truncH, W.years, W.codesFor, p, truncRegime)
    const { n, diffs } = diffBefore(full.equity, cutRun.equity, cut, false)
    check(`[${cellKey(p)}] ${cut} 절단 — 이전 구간 ${n}점이 비지 않는다`, n > 200, `${n}점`)
    eq(`[${cellKey(p)}] ${cut} 절단 전 자산곡선 완전 일치`, diffs, 0)
  }
}

// 매매수도 앞 구간에서 같아야 한다(연 단위 연쇄라 절단 해의 미청산분은 제외하고 본다)
{
  const cut = '2014-12-31' // 연말 경계 — 절단 해가 통째로 끝나는 지점
  const truncH = truncate(W.histories, cut)
  const truncRegime = REGIME.filter((p) => p.date <= cut)
  for (const p of TRUNC_CASES) {
    const full = chainOf(W.histories, W.years, W.codesFor, p, REGIME)
    const cutRun = chainOf(truncH, W.years, W.codesFor, p, truncRegime)
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
  const mutRegime = equalWeightIndex(mutH, W.codes, '2009-01-01')
  for (const p of TRUNC_CASES) {
    const full = chainOf(W.histories, W.years, W.codesFor, p, REGIME)
    const mut = chainOf(mutH, W.years, W.codesFor, p, mutRegime)
    // 길이가 같으므로 **경계 당일까지 포함**해 완전 일치를 요구한다.
    const { n, diffs } = diffBefore(full.equity, mut.equity, cut, true)
    check(`[${cellKey(p)}] ${cut} 이후 3배 조작 — 비교 구간 ${n}점`, n > 200, `${n}점`)
    eq(`[${cellKey(p)}] ${cut}까지 자산곡선 완전 일치(미래참조 0건)`, diffs, 0)
  }
}

// ============================================================================
section('3) 모멘텀 창의 인과성 — 리밸런스일 당일 봉을 조작해도 랭킹이 안 바뀐다')
// ============================================================================

{
  const date = '2014-04-01'
  for (const [lookback, skip] of [
    [12, 1],
    [3, 0],
    [6, 2],
    [15, 1],
  ] as const) {
    const base = rankUniverse(W.histories, W.codes, date, lookback, skip)
    // 당일 **및 이후** 봉을 100배로 — 미래참조가 있으면 랭킹이 반드시 뒤집힌다
    const mut: Record<string, DailyBar[]> = {}
    for (const [k, bars] of Object.entries(W.histories))
      mut[k] = bars.map((b) => (b.date >= date ? { ...b, o: b.o * 100, h: b.h * 100, l: b.l * 100, c: b.c * 100 } : b))
    const after = rankUniverse(mut, W.codes, date, lookback, skip)
    eq(`모멘텀(${lookback}-${skip}) 랭킹 길이 불변`, after.length, base.length)
    let bad = 0
    for (let i = 0; i < base.length; i++)
      if (base[i].sym !== after[i].sym || !Object.is(base[i].mom, after[i].mom)) bad++
    eq(`모멘텀(${lookback}-${skip}) 당일·이후 조작에도 랭킹 완전 일치`, bad, 0)
  }
  // skip=0의 기준일이 "이번 달 1일 직전 종가"인지 직접 확인 — 당일 종가가 아니다
  const bars = W.histories.S00
  const m0 = momentumOf(bars, date, 3, 0)
  const pe = lastCloseBefore(bars, '2014-04-01')
  const ps = lastCloseBefore(bars, '2014-01-01')
  check('skip=0 끝 기준가 = 전월 마지막 종가(당일 종가 아님)', pe != null && ps != null && m0 != null)
  if (pe != null && ps != null && m0 != null) closeTo('skip=0 모멘텀 손계산 일치', m0, pe / ps - 1, 1e-12)
  // 관측 창이 비는 조합은 던진다(조용히 이상한 값을 만들지 않는다)
  let threw = false
  try {
    momentumOf(bars, date, 1, 1)
  } catch {
    threw = true
  }
  check('lookback <= skip이면 던진다', threw)
  eq('shiftMonthStart 연 경계', shiftMonthStart('2014-01-05', -1), '2013-12-01')
  eq('shiftMonthStart 12개월', shiftMonthStart('2014-04-20', -12), '2013-04-01')
}

// ============================================================================
section('4) 시장게이트 MA의 인과성 — 당일·이후를 조작해도 그날 노출이 안 바뀐다')
// ============================================================================

{
  const curve: Curve = []
  for (let i = 0; i < 400; i++) {
    const t = Date.parse('2010-01-01T00:00:00Z') + i * 86400e3
    curve.push({ date: new Date(t).toISOString().slice(0, 10), equity: 100 + i })
  }
  const judge = curve[350].date
  const g = makeMaGateExposure(curve, 200)
  const before = g(judge)
  const mutated = curve.map((p, i) => (p.date >= judge ? { ...p, equity: i < 380 ? 1 : 1e6 } : p))
  const g2 = makeMaGateExposure(mutated, 200)
  eq('게이트 판정 — 당일·이후 조작에도 불변', g2(judge), before)
  eq('상승 추세에서는 게이트 열림', before, 1)

  // 하락 전환 — 직전 종가가 MA 아래면 닫힌다
  const down: Curve = curve.map((p, i) => ({ ...p, equity: i < 300 ? 100 + i : 400 - (i - 300) * 3 }))
  const gd = makeMaGateExposure(down, 200)
  eq('하락 전환 뒤에는 게이트 닫힘', gd(down[390].date), 0)

  // 데이터 부족 → **열림(1)**. 사후지식 없이 기본값을 쓴다.
  eq('MA 표본 부족이면 열림(1)', makeMaGateExposure(curve, 200)(curve[10].date), 1)
  // maDays=0 = 게이트 없음
  eq('gateMa=0이면 항상 1', makeMaGateExposure(curve, 0)(curve[350].date), 1)
  // 곡선 밖(맨 앞) 날짜도 안전하게 1
  eq('곡선 시작 이전 날짜는 1', makeMaGateExposure(curve, 200)('2000-01-01'), 1)
}

// ============================================================================
section('5) 격자·이웃 산술 — 사전식 인덱싱 · ±1 스텝 · 경계 셀 표기')
// ============================================================================

{
  validateGrid(FULL_GRID)
  const cells = enumerateGrid(FULL_GRID)
  eq('전체 격자 셀 수', cells.length, FULL_GRID_CELLS)
  eq('전체 격자 셀 수 = 축 곱', cells.length, FULL_GRID.reduce((s, a) => s * a.values.length, 1))
  check('셀 수가 지시 예산(200~400 대략) 안', cells.length <= 420, `${cells.length}셀`)
  eq('축 개수 5', FULL_GRID.length, AXIS_KEYS.length)
  eq('셀 키 중복 없음', new Set(cells.map((c) => c.key)).size, cells.length)
  check('모든 셀에서 lookback > skip', cells.every((c) => c.params.lookback > c.params.skip))

  // 사전식: 마지막 축이 가장 빨리 돈다
  const sizes = FULL_GRID.map((a) => a.values.length)
  eq('flatIndex 왕복', flatIndex(cells[123].coords, sizes), 123)
  eq('격자 밖 좌표는 -1', flatIndex([0, 0, 0, 0, -1], sizes), -1)

  // 이웃: 내부 셀은 2×축수, 경계 셀은 부족분이 missing에 담긴다
  const interior = cells.find((c) => c.coords.every((v, a) => v > 0 && v < sizes[a] - 1))
  check('완전 내부 셀이 존재한다', interior != null)
  if (interior) {
    const nb = neighborsOf(interior, FULL_GRID)
    eq('내부 셀 이웃 수 = 2 × 축수', nb.found.length, 2 * FULL_GRID.length)
    eq('내부 셀은 missing 없음', nb.missing.length, 0)
    // 이웃은 정확히 한 축만 1스텝 다르다(대각선 제외)
    let bad = 0
    for (const n of nb.found) {
      const other = cells[n.index]
      const diff = other.coords.map((v, a) => Math.abs(v - interior.coords[a]))
      if (diff.reduce((s, v) => s + v, 0) !== 1) bad++
    }
    eq('이웃은 정확히 한 축만 ±1 (대각선 없음)', bad, 0)
  }
  const corner = cells[0]
  const cnb = neighborsOf(corner, FULL_GRID)
  eq('꼭짓점 셀 이웃 수 = 축수', cnb.found.length, FULL_GRID.length)
  eq('꼭짓점 셀 missing 수 = 축수', cnb.missing.length, FULL_GRID.length)

  // 오름차순이 아닌 축은 던진다(이웃 정의가 깨지므로)
  let threw = false
  try {
    validateGrid([{ key: 'lookback', label: 'x', values: [3, 3], unit: '개월' }] as unknown as GridSpec)
  } catch {
    threw = true
  }
  check('축이 오름차순이 아니면 던진다', threw)
}

// ============================================================================
section('6) 고원 점수 — 최솟값(평균 아님) · 경계 셀 [표본부족] · null 사유')
// ============================================================================

{
  // 1축 3레벨 × 1축 3레벨로 축소한 격자를 만들어 손계산과 대조한다.
  const g: GridSpec = [
    { key: 'lookback', label: 'L', values: [3, 6, 9], unit: '개월' },
    { key: 'skip', label: 'S', values: [0, 1, 2], unit: '개월' },
    { key: 'slots', label: 'N', values: [5], unit: '종목' },
    { key: 'gateMa', label: 'G', values: [0], unit: '일' },
    { key: 'rebalMonths', label: 'R', values: [1], unit: '개월' },
  ]
  const cells = enumerateGrid(g)
  eq('축소 격자 셀 수', cells.length, 9)
  // 사전식 인덱스: i = lookbackIdx*3 + skipIdx
  //   성적표(칼마):   [0]=0.5 [1]=0.5 [2]=0.5
  //                   [3]=0.5 [4]=1.0 [5]=0.5   ← 4번이 단일 봉우리
  //                   [6]=0.5 [7]=0.5 [8]=0.5
  const scores = [0.5, 0.5, 0.5, 0.5, 1.0, 0.5, 0.5, 0.5, 0.5]
  const pass = scores.map(() => true)
  const ps = scorePlateau(cells, g, scores, pass)
  const center = ps[4]
  eq('중심 셀 이웃 수 4(1레벨 축은 이웃 없음)', center.neighbors, 4)
  closeTo('중심 이웃 최솟값', center.minNeighbor as number, 0.5)
  closeTo('plateauScore = min(셀, 이웃) = 0.5 (평균 0.6이 아니다)', center.plateauScore as number, 0.5)
  closeTo('plateauDrop = (1.0−0.5)/1.0 = 0.5', center.plateauDrop as number, 0.5)
  check('단일 봉우리는 고원 임계를 넘는다', (center.plateauDrop as number) > PLATEAU_DROP_THRESHOLD)
  eq('중심 셀은 경계가 아니다', center.sampleShort, false)
  eq('값 1개짜리 축은 frozen으로 분리(경계와 뭉치지 않는다)', center.frozen.length, 3)

  // 평평한 격자 — drop 0
  const flat = scorePlateau(cells, g, scores.map(() => 0.4), pass)
  closeTo('평평하면 plateauDrop = 0', flat[4].plateauDrop as number, 0)
  closeTo('평평하면 plateauScore = 셀 성적', flat[4].plateauScore as number, 0.4)

  // 경계 셀 — 이웃 부족을 반드시 표기한다
  eq('꼭짓점 셀 경계 표기', ps[0].sampleShort, true)
  eq('꼭짓점 셀 missing 수 2(2축 × 각 1방향)', ps[0].missing.length, 2)

  // 이웃 성적이 null이면 고원 판정 불가 + 사유
  const withNull = scores.slice()
  const holed = scorePlateau(cells, g, [...withNull.slice(0, 1), null, ...withNull.slice(2)], pass)
  eq('이웃 성적이 null이면 plateauScore도 null', holed[4].plateauScore === null || holed[1].plateauScore === null, true)
  check('null이면 사유가 남는다(규칙 3)', holed.some((p) => p.reason != null))

  // 이웃 중 관문① 탈락자가 있으면 neighborsPassLocal=false
  const p2 = pass.slice()
  p2[1] = false
  const withFail = scorePlateau(cells, g, scores, p2)
  eq('이웃 중 관문① 탈락자가 있으면 false', withFail[4].neighborsPassLocal, false)

  // 길이 불일치는 던진다(조용히 어긋난 채로 채점하지 않는다)
  let threw = false
  try {
    scorePlateau(cells, g, [0.1], pass)
  } catch {
    threw = true
  }
  check('성적 배열 길이가 다르면 던진다', threw)
}

// ============================================================================
section('7) 승격 관문 — 다섯 개 전부 통과해야만 승격 ("가장 덜 나쁜 칸" 승격 금지)')
// ============================================================================

{
  const cell = enumerateGrid(QUICK_GRID)[0]
  const good: CellResult = {
    cell,
    full: { total: 100, cagr: 10, mdd: -20, years: 10 },
    a: { total: 50, cagr: 8, mdd: -15, years: 5 },
    b: { total: 50, cagr: 12, mdd: -20, years: 5 },
    calmar: 0.5,
    sharpeDaily: 0.05,
    alphaFull: 3,
    alphaA: 2,
    alphaB: 4,
    trades: 50,
    rebalances: 120,
    gatedRebalances: 0,
    dailyReturns: [],
  }
  const okPs: PlateauScore = {
    index: 0,
    self: 0.5,
    neighbors: 10,
    missing: [],
    frozen: [],
    minNeighbor: 0.45,
    plateauScore: 0.45,
    plateauDrop: 0.1,
    neighborsPassLocal: true,
    sampleShort: false,
    reason: null,
  }
  const okRound = { pbo: 0.3, wfOosAlpha: 2 }
  eq('다섯 관문 전부 통과 → 승격', promotionVerdict(good, okPs, okRound).promoted, true)

  // 하나씩 깨뜨린다
  eq('①전반 알파 음수 → 탈락', promotionVerdict({ ...good, alphaA: -1 }, okPs, okRound).promoted, false)
  eq('①후반 알파 음수 → 탈락', promotionVerdict({ ...good, alphaB: -1 }, okPs, okRound).promoted, false)
  eq('①알파 null → 탈락', promotionVerdict({ ...good, alphaA: null }, okPs, okRound).promoted, false)
  eq('②매매 부족 → 탈락', promotionVerdict({ ...good, trades: 19 }, okPs, okRound).promoted, false)
  eq('③PBO 0.5 이상 → 탈락', promotionVerdict(good, okPs, { pbo: 0.5, wfOosAlpha: 2 }).promoted, false)
  eq('③PBO 계산불가 → 탈락', promotionVerdict(good, okPs, { pbo: null, wfOosAlpha: 2 }).promoted, false)
  eq('④WF OOS 알파 0 이하 → 탈락', promotionVerdict(good, okPs, { pbo: 0.3, wfOosAlpha: 0 }).promoted, false)
  eq('④WF 계산불가 → 탈락', promotionVerdict(good, okPs, { pbo: 0.3, wfOosAlpha: null }).promoted, false)
  eq(
    '⑤plateauDrop 초과 → 탈락',
    promotionVerdict(good, { ...okPs, plateauDrop: PLATEAU_DROP_THRESHOLD + 0.01 }, okRound).promoted,
    false,
  )
  eq('⑤고원 판정불가 → 탈락', promotionVerdict(good, { ...okPs, plateauDrop: null }, okRound).promoted, false)
  eq(
    '⑤이웃 중 관문① 탈락 존재 → 탈락',
    promotionVerdict(good, { ...okPs, neighborsPassLocal: false }, okRound).promoted,
    false,
  )
  eq('임계 정확히 0.30은 통과(≤)', promotionVerdict(good, { ...okPs, plateauDrop: 0.3 }, okRound).promoted, true)

  // localFailReasons — 관문①② 사유가 사람이 읽을 수 있게 남는가
  eq('관문①② 통과면 사유 없음', localFailReasons(good).length, 0)
  check('알파 탈락 사유 표기', localFailReasons({ ...good, alphaB: -1 })[0].includes('알파'))
  check('매매 탈락 사유 표기', localFailReasons({ ...good, trades: 0 }).some((r) => r.includes('매매')))
}

// ============================================================================
section('8) 비용·상수·유틸 대조 — 34·36·38차와 같은 전제인가')
// ============================================================================

{
  eq('초기자본', PLATEAU_COST.initialCapital, 10_000_000)
  closeTo('수수료 0.015%', PLATEAU_COST.feePct, 0.015)
  closeTo('거래세 0.15%', PLATEAU_COST.taxPct, 0.15)
  closeTo('슬리피지 0.1%', PLATEAU_COST.slippagePct, 0.1)
  eq('매매 최소 건수 20', PLATEAU_MIN_TRADES, 20)
  eq('누적 시도 분모(38차까지) 97', PLATEAU_TRIALS_PRIOR_TOTAL, 97)
  eq('벤치 심볼', BENCH, '069500.KS')
  eq('고원 임계 0.30', PLATEAU_DROP_THRESHOLD, 0.3)
  eq('현금 처리 최소 종목수', MIN_SYMBOLS, 5)

  eq('전·후반 경계 2010~2026 → 2018', halfYearOf([2010, 2018, 2026]), 2018)
  eq('전·후반 경계 2015~2026 → 2021', halfYearOf([2015, 2026]), 2021)

  eq('리밸 매월', [1, 2, 3, 12].every((m) => isRebalanceMonth(m, 1)), true)
  eq('리밸 3개월 = 1·4·7·10월', [1, 4, 7, 10].every((m) => isRebalanceMonth(m, 3)), true)
  eq('리밸 3개월 — 2월은 아니다', isRebalanceMonth(2, 3), false)
  eq('리밸 6개월 = 1·7월', isRebalanceMonth(1, 6) && isRebalanceMonth(7, 6), true)
  eq('리밸 6개월 — 4월은 아니다', isRebalanceMonth(4, 6), false)

  eq('KRX_WIDTH 미지정 → 10+10', JSON.stringify(parseWidthEnv(undefined)), JSON.stringify({ kospi: 10, kosdaq: 10 }))
  eq('KRX_WIDTH=40x40', JSON.stringify(parseWidthEnv('40x40')), JSON.stringify({ kospi: 40, kosdaq: 40 }))
  eq('KRX_WIDTH=30 (단일 숫자)', JSON.stringify(parseWidthEnv('30')), JSON.stringify({ kospi: 30, kosdaq: 30 }))
  eq('KRX_WIDTH 이상값 → 기본', JSON.stringify(parseWidthEnv('나쁨')), JSON.stringify({ kospi: 10, kosdaq: 10 }))

  // PBO 조합 상한 — 변형이 많아질수록 좁아지되 하한·상한이 있다
  check('변형이 많으면 조합 상한이 좁아진다', pboMaxCombinations(405) < pboMaxCombinations(20))
  check('조합 상한 하한 200', pboMaxCombinations(1e9) >= 200)
  check('조합 상한 상한 20000', pboMaxCombinations(1) <= 20000)

  // 칼마 정의
  closeTo('칼마 = CAGR ÷ |MDD|', calmarOf({ total: 0, cagr: 12, mdd: -24, years: 5 }) as number, 0.5)
  eq('MDD≈0이면 칼마 null (0으로 채우지 않는다)', calmarOf({ total: 0, cagr: 5, mdd: 0, years: 1 }), null)
}

// ============================================================================
section('9) 결정론 · 수익률 정렬 · 알파 겹침 구간')
// ============================================================================

{
  const p: PlateauParams = { lookback: 12, skip: 1, slots: 5, gateMa: 150, rebalMonths: 3 }
  const a = chainOf(W.histories, W.years, W.codesFor, p, REGIME)
  const b = chainOf(W.histories, W.years, W.codesFor, p, REGIME)
  eq('같은 입력 → 같은 곡선(난수 없음)', JSON.stringify(a.equity), JSON.stringify(b.equity))
  eq('같은 입력 → 같은 매매수', a.closed, b.closed)
  check('합성 세계에서 매매가 실제로 일어난다', a.closed > 10, `${a.closed}건`)
  check('자산곡선이 비지 않는다', a.equity.length > 1000, `${a.equity.length}점`)

  // 일간 수익률 — 첫 점은 기준이라 빠진다
  const dr = dailyReturnsOf(a.equity)
  eq('일간 수익률 개수 = 곡선 점수 − 1', dr.returns.length, a.equity.length - 1)
  eq('일간 수익률 날짜 정렬', dr.dates[0], a.equity[1].date)

  // 정렬 — 한 변형에만 있는 날은 버리고 그 수를 돌려준다
  const s1 = { dates: ['2010-01-04', '2010-01-05', '2010-01-06'], returns: [0.1, 0.2, 0.3] }
  const s2 = { dates: ['2010-01-04', '2010-01-06'], returns: [0.4, 0.6] }
  const al = alignDailyMatrix([s1, s2])
  eq('공통 날짜만 남는다', al.dates.length, 2)
  eq('버린 날 수를 돌려준다', al.dropped, 1)
  eq('행렬이 공통 날짜에 정렬된다', JSON.stringify(al.matrix), JSON.stringify([[0.1, 0.3], [0.4, 0.6]]))

  // 알파는 겹치는 구간에서만 — 벤치가 없는 구간을 전략에만 유리하게 넣지 않는다
  const strat: Curve = [
    { date: '2010-01-01', equity: 100 },
    { date: '2012-01-01', equity: 200 },
    { date: '2014-01-01', equity: 400 },
  ]
  const bench: Curve = [
    { date: '2012-01-01', equity: 100 },
    { date: '2014-01-01', equity: 150 },
  ]
  const alpha = alphaOf(strat, bench, '', '9999-12-31')
  const sPerf = perfOf(strat, '2012-01-01', '2014-01-01')
  const bPerf = perfOf(bench, '2012-01-01', '2014-01-01')
  check('알파가 계산된다', alpha != null)
  if (alpha != null) closeTo('알파 = 겹치는 구간의 CAGR 차', alpha, sPerf.cagr - bPerf.cagr, 1e-9)
  eq('겹치는 구간이 없으면 null', alphaOf(strat, [{ date: '2030-01-01', equity: 1 }], '', '9999-12-31'), null)
}

// ============================================================================
section('10) 연도 컨텍스트 — 6/30 편입 판정 · 연말 절단 · 매핑 부족 연도')
// ============================================================================

{
  const late = { ...W.histories }
  // 그 해 7월에 상장한 종목은 그 해 유니버스에 들어가지 않는다
  late.LATE = syntheticBars(999, '2012-07-02', 365 * 5, 10_000)
  const codes = [...W.codes, 'LATE']
  const ctxs = buildYearCtxs(late, [2012, 2013], () => codes, idOf)
  check('7월 상장 종목은 그 해 유니버스에서 빠진다', !ctxs[0].symbols.includes('LATE'))
  check('다음 해에는 편입된다', ctxs[1].symbols.includes('LATE'))
  // 연말 절단 — 그 해 봉만 넘어간다
  for (const ctx of ctxs)
    check(
      `${ctx.y}년 컨텍스트에 그 해 이후 봉이 없다`,
      Object.values(ctx.hist).every((bars) => bars.every((b) => b.date <= ctx.end)),
    )
  check('달력이 그 해 안에 있다', ctxs[0].calendar.every((d) => d >= ctxs[0].start && d <= ctxs[0].end))

  // 매핑 종목이 MIN_SYMBOLS 미만이면 현금 보유 — 곡선이 평평하고 연수가 유지된다
  const thin = { A: W.histories.S00, B: W.histories.S01 }
  const thinCtxs = buildYearCtxs(thin, [2012, 2013], () => ['A', 'B'], idOf)
  const chain = runPlateauChain(thinCtxs, PLATEAU_COST, {
    lookback: 12,
    skip: 1,
    slots: 5,
    gateMa: 0,
    rebalMonths: 1,
  })
  eq('현금 연도가 연도표에 남는다(건너뛰지 않는다)', chain.perYear.length, 2)
  check('현금 연도 표기', chain.perYear.every((r) => r.cash === true))
  check('현금 곡선은 평평하다', new Set(chain.equity.map((p) => p.equity)).size === 1)
  eq('현금 연도는 매매 0', chain.closed, 0)
}

finish()
