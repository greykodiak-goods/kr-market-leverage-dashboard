// MODE=krxcal — KRX 실측 유니버스 위 칼마 재탐색. 격자 산술 · 유니버스 주입 규약 ·
// 판정/정렬 산술 · 오버레이 재사용 경로 검증.
//
// 이 파일이 막는 사고는 네 가지다.
//
//   ① **격자가 조용히 달라지는 것.** 12조합(MA 3 × 신고 2 × 청산선 2)이 하나라도 빠지거나
//      중복되면 "35변형"이라는 다중검정 분모가 거짓이 되고, 그 위에서 계산한 p값도 거짓이 된다.
//   ② **격자 스펙이 기준선과 다른 엔진 경로를 타는 것.** (25,10,80)은 곧 23차 기준선이다.
//      `krxcalGridSpec`이 `baselineSpec`과 조금이라도 다른 스펙을 만들면 격자 안의 기준선이
//      기준선이 아니게 되고, 33차 표와 나란히 읽을 수 없다.
//   ③ **판정 산술이 무너지는 것.** 칼마 정렬·탈락 사유·벽 넘김 판정이 어긋나면 헤드라인
//      ("QQQ 벽을 넘은 변형이 있는가")이 통째로 뒤집힌다. 없는데 있다고 쓰는 것이 최악이다.
//   ④ **오버레이가 새 의미론을 만드는 것.** 오버레이는 32차와 **같은 두 줄**(노출 훅 →
//      2단 blend)이어야 한다. 여기서는 그 재사용 결과가 독립 계산과 일치하는지까지 본다.
//
// ⚠️ 미래참조 금지(규칙 1)와의 관계 — **새 엔진 경로가 없다.** krxcal은 기존
//    runSpecChain/runCustomChain/simulateXsMomYear/blendCurves를 그대로 부르고 파라미터와
//    유니버스만 바꾼다. 다만 **격자 파라미터 조합은 이 리포에서 처음 도는 것**이므로
//    12조합 전부에 절단 불변성 케이스를 건다(규칙 1 "새 전략을 추가하면 그 경로를 덮는
//    절단 불변성 케이스를 함께 추가한다").
//
// 네트워크를 타지 않는다(컨테이너에서 Yahoo는 403).

import { check, eq, section, finish, rng } from './harness'
import {
  KRXCAL_GOLD_EQUITY_W,
  KRXCAL_HB,
  KRXCAL_MA,
  KRXCAL_MIN_TRADES,
  KRXCAL_XM,
  KRXCAL_XSMOM_NARROW,
  KRXCAL_XSMOM_WIDE,
  baselineSpec,
  benchCurve,
  blendCurves,
  buildYearly,
  calFailReasons,
  calHeadline,
  calPass,
  calPassSummary,
  calRankTable,
  calmarOf,
  calmarSort,
  gridLabel,
  krxcalGrid,
  krxcalGridSpec,
  krxcalUniverse,
  makeRegimeExposure,
  perfOf,
  runCustomChain,
  runSpecChain,
  simulateRankYear,
  spanOf,
  wallOf,
  xsmomRank,
  type CalVariant,
  type Perf,
  type StratRow,
} from '../scripts/idea-lab.entry'
import type { CostSettings } from '../src/features/backtest/conditionScreen'
import type { DailyBar } from '../src/features/backtest/types'

const COST: CostSettings = { initialCapital: 10_000_000, feePct: 0.015, taxPct: 0.15, slippagePct: 0.1 }

/** 표 출력을 가로채 문자열로 받는다 — 표가 던지지 않는지, 문구가 나오는지 본다. */
function capture(fn: () => void): string[] {
  const out: string[] = []
  const orig = console.log
  console.log = (...args: unknown[]) => {
    out.push(args.map(String).join(' '))
  }
  try {
    fn()
  } finally {
    console.log = orig
  }
  return out
}

/** 합성 일봉 — 주말을 건너뛴 거래일 근사(엔진은 달력을 데이터에서 만든다). */
function makeBars(seed: number, from: string, toYear: number, base = 50_000): DailyBar[] {
  const rnd = rng(seed)
  const bars: DailyBar[] = []
  let p = base
  const start = Date.parse(`${from}T00:00:00Z`)
  const end = Date.UTC(toYear + 1, 0, 1)
  for (let t = start; t < end; t += 86400000) {
    const d = new Date(t)
    const dow = d.getUTCDay()
    if (dow === 0 || dow === 6) continue
    const ret = 0.0005 + 0.025 * (rnd() * 2 - 1)
    const o = p
    const c = Math.max(1, p * (1 + ret))
    bars.push({
      date: d.toISOString().slice(0, 10),
      t: Math.floor(t / 1000),
      o,
      h: Math.max(o, c) * (1 + rnd() * 0.012),
      l: Math.min(o, c) * (1 - rnd() * 0.012),
      c,
      v: 400_000 + Math.floor(rnd() * 2_000_000),
    })
    p = c
  }
  return bars
}

// ── 1) 격자 산술 ──────────────────────────────────────────────────────────────
{
  section('1) 조건식 격자 — 12조합 산술과 순서')

  const g = krxcalGrid()
  eq('축 곱이 곧 조합 수', g.length, KRXCAL_MA.length * KRXCAL_HB.length * KRXCAL_XM.length)
  eq('12조합이다', g.length, 12)
  eq('중복 조합이 없다', new Set(g.map((x) => `${x.ma}/${x.hb}/${x.xm}`)).size, 12)
  eq('라벨도 전부 다르다', new Set(g.map(gridLabel)).size, 12)
  check(
    '축 값이 선언된 집합을 벗어나지 않는다',
    g.every((x) => (KRXCAL_MA as readonly number[]).includes(x.ma) && (KRXCAL_HB as readonly number[]).includes(x.hb) && (KRXCAL_XM as readonly number[]).includes(x.xm)),
  )
  eq('전개 순서가 고정이다(MA→신고→청산선)', g.slice(0, 3).map(gridLabel).join(' / '), 'MA10×신고10→60선 / MA10×신고10→80선 / MA10×신고20→60선')
  check(
    '23차 기준선(25×10→80)이 격자 안에 들어 있다 — 대조군을 따로 안 붙여도 된다',
    g.some((x) => x.ma === 25 && x.hb === 10 && x.xm === 80),
  )

  // 총 변형 수 = 지시서의 상한(36) 이하인가. 이 값이 다중검정 경고의 분모다.
  const totalVariants = 12 * 2 + KRXCAL_XSMOM_NARROW.length + KRXCAL_XSMOM_WIDE.length + 3 * 2
  eq('총 변형 수는 35', totalVariants, 35)
  check('총 변형 수가 상한 36 이하', totalVariants <= 36, String(totalVariants))
  eq('10+10 xsmom 후보는 3개', KRXCAL_XSMOM_NARROW.length, 3)
  eq('40+40 xsmom 후보는 2개', KRXCAL_XSMOM_WIDE.length, 2)
  check('xsmom 후보는 전부 게이트 on(변형 수를 늘리지 않는다)', [...KRXCAL_XSMOM_NARROW, ...KRXCAL_XSMOM_WIDE].every((c) => c.gate))
  eq('10+10 슬롯은 3·5·7', KRXCAL_XSMOM_NARROW.map((c) => c.slots).join(','), '3,5,7')
  eq('40+40 슬롯은 8·16 (상위 10%·20% 분위)', KRXCAL_XSMOM_WIDE.map((c) => c.slots).join(','), '8,16')
  eq('금 슬리브 배합은 주식 80 : 금 20', KRXCAL_GOLD_EQUITY_W, 0.8)
}

// ── 2) 격자 스펙이 기준선과 같은 엔진 경로인가 ────────────────────────────────
{
  section('2) krxcalGridSpec — (25,10,80)은 baselineSpec과 같은 스펙이어야 한다')

  const SYMS = ['005930', '000660']
  const base = baselineSpec(SYMS)
  const grid = krxcalGridSpec({ ma: 25, hb: 10, xm: 80 })(SYMS)

  eq('entry 조건이 동일', JSON.stringify(grid.entry), JSON.stringify(base.entry))
  eq('exits(청산선·버퍼)가 동일', JSON.stringify(grid.exits), JSON.stringify(base.exits))
  eq('sizing이 동일', JSON.stringify(grid.sizing), JSON.stringify(base.sizing))
  eq('execution이 동일', JSON.stringify(grid.execution), JSON.stringify(base.execution))
  eq('ranking이 동일', JSON.stringify(grid.ranking), JSON.stringify(base.ranking))
  eq('universe가 동일(주입 심볼 포함)', JSON.stringify(grid.universe), JSON.stringify(base.universe))
  eq('regime이 동일(둘 다 없음)', JSON.stringify(grid.regime ?? null), JSON.stringify(base.regime ?? null))
  eq('spec version이 동일', grid.version, base.version)
  check('id는 격자 좌표를 담아 서로 구분된다', grid.id !== base.id && grid.id.includes('ma25'), grid.id)

  // 파라미터가 실제로 스펙에 흘러 들어가는가(오타로 한 축이 고정되는 사고 방지)
  const other = krxcalGridSpec({ ma: 10, hb: 20, xm: 60 })(SYMS)
  check('MA 축이 entry에 반영된다', JSON.stringify(other.entry).includes('"period":10'), JSON.stringify(other.entry))
  check('신고 축이 entry에 반영된다', JSON.stringify(other.entry).includes('"days":20'), JSON.stringify(other.entry))
  check('청산선 축이 exits에 반영된다', JSON.stringify(other.exits).includes('"maPeriod":60'), JSON.stringify(other.exits))
  check('버퍼는 0 고정', JSON.stringify(other.exits).includes('"pct":0'), JSON.stringify(other.exits))
}

// ── 3) 판정·정렬 산술 (합성 StratRow) ─────────────────────────────────────────
{
  section('3) 칼마 정렬 · 탈락 사유 — 판정 산술')

  const perf = (cagr: number, mdd: number): Perf => ({ total: 0, cagr, mdd, obj: null, years: 10 })
  const mkRow = (label: string, cagr: number, mdd: number, aA: number | null, aB: number | null): StratRow => ({
    label,
    full: perf(cagr, mdd),
    a: perf(cagr, mdd),
    b: perf(cagr, mdd),
    closed: 0,
    wins: 0,
    alphaFull: null,
    alphaA: aA,
    alphaB: aB,
    perYear: [],
  })
  const mkVar = (
    label: string,
    cagr: number,
    mdd: number,
    opts: { aA?: number | null; aB?: number | null; trades?: number } = {},
  ): CalVariant => ({
    label,
    group: '조건식',
    // `?? 1`을 쓰면 **명시적 null**(벤치 구간 없음)이 1로 삼켜져 그 케이스를 못 본다.
    row: mkRow(label, cagr, mdd, 'aA' in opts ? opts.aA! : 1, 'aB' in opts ? opts.aB! : 1),
    trades: opts.trades ?? 100,
    synth: false,
  })

  const hi = mkVar('hi', 12, -20) // 칼마 0.600
  const lo = mkVar('lo', 5, -25) // 칼마 0.200
  const flat = mkVar('flat', 8, 0) // MDD 0 → 칼마 산출 불가(null)
  const tieA = mkVar('aaa', 6, -20) // 0.300
  const tieB = mkVar('bbb', 6, -20) // 0.300

  eq('칼마 계산이 CAGR÷|MDD|', calmarOf(hi.row.full)?.toFixed(3), '0.600')
  eq('칼마 내림차순', calmarSort([lo, hi]).map((v) => v.label).join(','), 'hi,lo')
  eq('산출 불가(MDD 0)는 맨 뒤', calmarSort([flat, lo, hi]).map((v) => v.label).join(','), 'hi,lo,flat')
  eq('동점은 라벨 오름차순(결정적)', calmarSort([tieB, tieA]).map((v) => v.label).join(','), 'aaa,bbb')
  eq('정렬이 원본 배열을 건드리지 않는다', [lo, hi].map((v) => v.label).join(','), 'lo,hi')

  eq('알파·매매 다 좋으면 탈락 사유 없음', calFailReasons(hi).join(','), '')
  check('그 경우 통과', calPass(hi))
  eq('전반 알파가 0 이하면 탈락', calFailReasons(mkVar('x', 9, -20, { aA: 0 })).join(','), '알파')
  eq('후반 알파가 음수면 탈락', calFailReasons(mkVar('x', 9, -20, { aB: -0.1 })).join(','), '알파')
  eq('알파가 null(벤치 구간 없음)이면 탈락', calFailReasons(mkVar('x', 9, -20, { aA: null })).join(','), '알파')
  eq('매매수가 기준 미만이면 탈락', calFailReasons(mkVar('x', 9, -20, { trades: KRXCAL_MIN_TRADES - 1 })).join(','), '매매')
  check('매매수가 기준과 같으면 통과(경계 포함)', calPass(mkVar('x', 9, -20, { trades: KRXCAL_MIN_TRADES })))
  eq(
    '둘 다 나쁘면 사유가 둘 다 남는다',
    calFailReasons(mkVar('x', 9, -20, { aA: -1, trades: 0 })).join('·'),
    '알파·매매',
  )

  // ---- 벽 · 순위표 · 헤드라인 --------------------------------------------------
  const wallCurve = [
    { date: '2010-01-04', equity: 100 },
    { date: '2015-01-05', equity: 60 }, // MDD −40%
    { date: '2019-12-30', equity: 200 },
  ]
  const w = wallOf('QQQ 원화 보유', wallCurve, '2010-01-01', '2019-12-31')
  check('벽이 만들어진다', w != null)
  eq('벽 구간이 잘린 실제 양끝', w!.span, '2010-01-04~2019-12-30')
  check('벽 칼마가 유한하다', w!.calmar != null && Number.isFinite(w!.calmar))
  eq('겹치는 구간이 없으면 벽은 null', wallOf('x', wallCurve, '2030-01-01', '2030-12-31'), null)

  const lines = capture(() => calRankTable('테스트 순위', [lo, hi, flat], w))
  const rows = lines.filter((l) => /^\| \d+ \|/.test(l))
  eq('데이터 행 수 = 변형 수', rows.length, 3)
  check('1순위가 칼마 1위', rows[0].includes('| hi |'), rows[0])
  check('통과 행에 ✅', rows[0].includes('✅'), rows[0])
  check('벽 열이 붙는다', lines.some((l) => l.includes('QQQ 원화 보유 벽')), lines[1])

  // 벽보다 낮은 변형만 있으면 "없다"가 나와야 한다 — 헤드라인의 핵심.
  const low = mkVar('아주낮음', 1, -50) // 칼마 0.02
  const noneOut = capture(() => calHeadline('실측 10+10', calmarSort([low]), w))
  check('벽을 못 넘으면 "없다"를 크게 쓴다', noneOut.some((l) => l.includes('**없다.**')), noneOut.join(' / '))

  const high = mkVar('아주높음', 90, -10) // 칼마 9.0
  let overCount = -1
  const someOut = capture(() => {
    overCount = calHeadline('실측 10+10', calmarSort([high, low]), w)
  })
  check('벽을 넘으면 변형을 나열한다', someOut.some((l) => l.includes('아주높음')), someOut.join(' / '))
  check('넘어도 "채택이 아니다" 경고가 따라붙는다', someOut.some((l) => l.includes('채택이 아니다')))
  eq('넘은 변형 수만 세어 돌려준다(못 넘은 것은 안 센다)', overCount, 1)
  let noneCount = -1
  capture(() => {
    noneCount = calHeadline('u', calmarSort([low]), w)
  })
  eq('아무도 못 넘으면 0', noneCount, 0)
  let nullWallCount = -1
  const nullWallOut = capture(() => {
    nullWallCount = calHeadline('u', calmarSort([high]), null)
  })
  eq('벽 자체가 없으면 0이되 "없다"로 읽지 말라고 적는다', nullWallCount, 0)
  check('벽 결측을 "없음"과 구분해 경고한다', nullWallOut.some((l) => l.includes('성립하지 않는다')), nullWallOut.join(' / '))

  // 벽을 넘어도 판정(알파·매매)에 걸리면 헤드라인에서 빠진다 — 규칙 5.
  const highBadAlpha = mkVar('벽넘음_알파음수', 90, -10, { aB: -1 })
  const badOut = capture(() => calHeadline('u', calmarSort([highBadAlpha]), w))
  check('칼마만 높고 알파가 음수면 헤드라인에 안 올라간다', badOut.some((l) => l.includes('**없다.**')), badOut.join(' / '))

  // 통과 판정은 **칼마와 무관하다** — 칼마가 낮아도 알파·매매가 좋으면 통과다.
  // 벽 넘김과 판정 통과를 갈라 두는 이유가 여기 있다(둘 다 만족해야 헤드라인에 오른다).
  const thin = mkVar('표본소실', 20, -20, { trades: 1 })
  const passOut = capture(() => calPassSummary('실측 10+10', calmarSort([highBadAlpha, thin])))
  check('통과가 하나도 없으면 "없음"이라 적는다', passOut.some((l) => l.includes('**없음.**')), passOut.join(' / '))
  const passOut2 = capture(() => calPassSummary('실측 10+10', calmarSort([low, highBadAlpha, thin])))
  check('칼마가 낮아도 알파·매매가 좋으면 통과 목록에 오른다', passOut2.some((l) => l.startsWith('| 아주낮음 |')), passOut2.join(' / '))
  check('알파 탈락 변형은 통과 목록에 없다', !passOut2.some((l) => l.startsWith('| 벽넘음_알파음수 |')))
  check('표본소실 변형도 통과 목록에 없다', !passOut2.some((l) => l.startsWith('| 표본소실 |')))
}

// ── 4) 유니버스 주입 · 오버레이 재사용 (합성 데이터) ──────────────────────────
{
  section('4) krxcalUniverse — 유니버스 주입 규약 · 계열 구성 · 오버레이 재사용')

  const CODES = ['400010', '400020', '400030', '400040', '400050', '400060', '400070', '400080']
  const H: Record<string, DailyBar[]> = {}
  CODES.forEach((cd, i) => {
    H[cd] = makeBars(20260803 + i * 137, '2009-01-01', 2013, 20_000 + i * 2_500)
  })
  const BENCH_BARS = makeBars(4242, '2009-01-01', 2013, 30_000)
  const benchEq = benchCurve(BENCH_BARS)
  const REGIME = benchEq
  const GOLD = benchCurve(makeBars(9999, '2009-01-01', 2013, 1_500_000))
  const YEARS = [2011, 2012, 2013]

  const yearly = buildYearly(H, YEARS, () => CODES)
  const XS = [
    { slots: 3, gate: true },
    { slots: 5, gate: true },
  ]
  const res = krxcalUniverse({ key: '테스트', yearly, years: YEARS, benchEq, regime: REGIME, gold: GOLD, xsCands: XS })
  const vs = res.variants

  eq('격자 12 + xsmom 2 + 오버레이 3 = 17행', vs.length, 17)
  eq('조건식 계열 12행', vs.filter((v) => v.group === '조건식').length, 12)
  eq('xsmom 계열 2행', vs.filter((v) => v.group === 'xsmom').length, 2)
  eq('오버레이 계열 3행', vs.filter((v) => v.group === '오버레이').length, 3)
  check('조건식 행 라벨이 격자 라벨과 일치', vs.filter((v) => v.group === '조건식').every((v, i) => v.label === gridLabel(krxcalGrid()[i])))
  check('전 행의 CAGR이 유한하다', vs.every((v) => Number.isFinite(v.row.full.cagr)))
  check('연도별 분해가 연도 수만큼 있다', vs.every((v) => v.row.perYear.length === YEARS.length))
  check('실행 구간(span)이 나온다', res.span != null && res.span[0] < res.span[1], JSON.stringify(res.span))

  const ovl = vs.filter((v) => v.group === '오버레이')
  check('오버레이는 전부 합성 행으로 표시된다', ovl.every((v) => v.synth))
  check('오버레이 매매수는 구성요소 합을 물려받는다(0이 아니다)', ovl.every((v) => v.trades > 0), ovl.map((v) => v.trades).join(','))
  check('오버레이 행 자체엔 매매 원장이 없다', ovl.every((v) => v.row.closed === 0))
  check('금 20% 행이 있다', ovl.some((v) => v.label.includes('금 20%')), ovl.map((v) => v.label).join(' / '))
  check('시장게이트 행이 있다', ovl.some((v) => v.label.includes('시장게이트')))

  // 금 곡선이 없으면 그 행만 빠지고 나머지는 그대로 돈다.
  const noGold = krxcalUniverse({ key: '테스트', yearly, years: YEARS, benchEq, regime: REGIME, gold: null, xsCands: XS })
  eq('금이 없으면 오버레이가 2행', noGold.variants.filter((v) => v.group === '오버레이').length, 2)
  eq('나머지 행 수는 그대로', noGold.variants.length, 16)

  // 오버레이 구성요소는 **각 계열의 칼마 1위**여야 한다(사후선택이지만, 규칙대로 골랐는가).
  const bestGrid = calmarSort(vs.filter((v) => v.group === '조건식'))[0]
  const bestXs = calmarSort(vs.filter((v) => v.group === 'xsmom'))[0]
  const combo = ovl.find((v) => v.label.startsWith('결합 50:50 ('))!
  check('결합 라벨이 두 계열 1위를 가리킨다', combo.label.includes('①1위') && combo.label.includes('②1위'), combo.label)

  // 재사용 경로 대조 — 결합 50:50이 독립 계산(runSpecChain + simulateXsMomYear + blendCurves)과 같은가.
  const chainA = runSpecChain(yearly, krxcalGridSpec(bestGrid.grid!), COST)
  const chainB = runCustomChain(
    yearly,
    (v) => simulateRankYear(v.hist, `${v.y}-01-01`, v.syms, COST, { slots: bestXs.cand!.slots, rank: xsmomRank, keep: (r) => r.aux >= 0 }),
    COST,
    bestXs.cand!.slots,
  )
  const indep = blendCurves(chainA.equity, chainB.equity, 0.5)
  const indepPerf = perfOf(indep)
  eq('결합 구간이 독립 계산과 같다', spanOf(indep).join('~'), `${res.span![0]}~${res.span![1]}`)
  check('결합 CAGR이 독립 계산과 완전히 같다', Math.abs(combo.row.full.cagr - indepPerf.cagr) < 1e-9, `${combo.row.full.cagr} vs ${indepPerf.cagr}`)
  check('결합 MDD도 독립 계산과 같다', Math.abs(combo.row.full.mdd - indepPerf.mdd) < 1e-9, `${combo.row.full.mdd} vs ${indepPerf.mdd}`)
  eq('결합 매매수 = ①1위 + ②1위 청산완료 합', combo.trades, chainA.closed + chainB.closed)
  check(
    '결합 성적이 두 단독 사이 어딘가에 있다(월 리밸런스 합성)',
    combo.row.full.cagr >= Math.min(bestGrid.row.full.cagr, bestXs.row.full.cagr) - 1e-6 &&
      combo.row.full.cagr <= Math.max(bestGrid.row.full.cagr, bestXs.row.full.cagr) + 1e-6,
    `${combo.row.full.cagr} vs [${bestGrid.row.full.cagr}, ${bestXs.row.full.cagr}]`,
  )

  // 시장게이트는 **노출 훅**으로만 들어간다 — 32차와 같은 자리인지 독립 계산으로 대조.
  const gateChain = runCustomChain(
    yearly,
    (v) =>
      simulateRankYear(v.hist, `${v.y}-01-01`, v.syms, COST, {
        slots: bestXs.cand!.slots,
        rank: xsmomRank,
        keep: (r) => r.aux >= 0,
        exposure: makeRegimeExposure(REGIME, 'mom12_1'),
      }),
    COST,
    bestXs.cand!.slots,
  )
  const gatedIndep = blendCurves(chainA.equity, gateChain.equity, 0.5)
  const gatedPerf = perfOf(gatedIndep)
  const gated = ovl.find((v) => v.label.includes('시장게이트'))!
  check(
    '게이트 결합이 노출 훅 독립 계산과 완전히 같다 (32차와 같은 자리)',
    Math.abs(gated.row.full.cagr - gatedPerf.cagr) < 1e-9 && Math.abs(gated.row.full.mdd - gatedPerf.mdd) < 1e-9,
    `${gated.row.full.cagr}/${gated.row.full.mdd} vs ${gatedPerf.cagr}/${gatedPerf.mdd}`,
  )
  check(
    '게이트를 얹으면 게이트 없는 결합과 실제로 달라진다(훅이 먹힌다)',
    Math.abs(gated.row.full.cagr - combo.row.full.cagr) > 1e-9,
    `${gated.row.full.cagr} vs ${combo.row.full.cagr}`,
  )
  eq('게이트 결합 매매수 = ① + 게이트 연쇄 청산완료 합', gated.trades, chainA.closed + gateChain.closed)

  // 금 20%는 2단 blend(32차 구조)여야 한다 — 3자 동시 결합이 아니라 게이트 곡선 위에 얹는다.
  const goldIndep = blendCurves(gatedIndep, GOLD, KRXCAL_GOLD_EQUITY_W)
  const goldPerf = perfOf(goldIndep)
  const goldRow = ovl.find((v) => v.label.includes('금 20%'))!
  check(
    '금 20% 행이 2단 blend 독립 계산과 완전히 같다',
    Math.abs(goldRow.row.full.total - goldPerf.total) < 1e-9 && Math.abs(goldRow.row.full.mdd - goldPerf.mdd) < 1e-9,
    `${goldRow.row.full.total}/${goldRow.row.full.mdd} vs ${goldPerf.total}/${goldPerf.mdd}`,
  )
  check(
    '금을 얹으면 게이트 결합과 달라진다(금 슬리브가 실제로 붙는다)',
    Math.abs(goldRow.row.full.total - gated.row.full.total) > 1e-9,
  )

  // 유니버스를 갈아끼우면 결과가 실제로 달라진다 — 주입이 먹히는지의 반증.
  const narrow = buildYearly(H, YEARS, () => CODES.slice(0, 5))
  const narrowRes = krxcalUniverse({ key: 'narrow', yearly: narrow, years: YEARS, benchEq, regime: REGIME, gold: GOLD, xsCands: XS })
  check(
    '유니버스를 좁히면 격자 성적이 달라진다',
    JSON.stringify(narrowRes.variants.filter((v) => v.group === '조건식').map((v) => v.row.full.cagr)) !==
      JSON.stringify(vs.filter((v) => v.group === '조건식').map((v) => v.row.full.cagr)),
  )

  // 매핑률·6/30 편입 판정은 buildYearly 하나가 결정한다(krxpit과 같은 규약).
  eq('매핑률 분모는 주입 목록 길이', yearly[0].mapped, `${yearly[0].syms.length}/${CODES.length}`)
}

// ── 5) 절단 불변성 — 격자 12조합 전부 (규칙 1) ────────────────────────────────
{
  section('5) 절단 불변성 — 격자 12조합 전부에서 미래참조가 없는가')

  const CODES = ['500010', '500020', '500030', '500040', '500050', '500060']
  const H: Record<string, DailyBar[]> = {}
  CODES.forEach((cd, i) => {
    H[cd] = makeBars(777 + i * 53, '2009-01-01', 2013, 18_000 + i * 4_000)
  })
  const YEARS = [2011, 2012, 2013]
  const CUT = '2012-12-31'
  const truncated: Record<string, DailyBar[]> = {}
  for (const [s, bars] of Object.entries(H)) truncated[s] = bars.filter((b) => b.date <= CUT)

  let bad = 0
  let badLabel = ''
  for (const g of krxcalGrid()) {
    const full = runSpecChain(buildYearly(H, YEARS, () => CODES), krxcalGridSpec(g), COST)
    const cut = runSpecChain(buildYearly(truncated, [2011, 2012], () => CODES), krxcalGridSpec(g), COST)
    const head = full.equity.filter((p) => p.date <= CUT)
    const same =
      head.length === cut.equity.length &&
      head.every((p, i) => p.date === cut.equity[i].date && Object.is(p.equity, cut.equity[i].equity))
    if (!same) {
      bad++
      badLabel = badLabel || `${gridLabel(g)} (${head.length} vs ${cut.equity.length})`
    }
  }
  eq('12조합 전부 절단 전 구간의 자산곡선이 완전히 동일하다 (미래참조 없음)', bad, 0)
  check('실패한 조합이 없다', bad === 0, badLabel)

  // 반증 — 격자가 실제로 서로 다른 전략이어야 이 테스트가 의미를 가진다.
  const cagrs = krxcalGrid().map((g) => runSpecChain(buildYearly(H, YEARS, () => CODES), krxcalGridSpec(g), COST).equity.length)
  check('12조합이 전부 곡선을 만든다', cagrs.every((n) => n > 100), cagrs.join(','))
}

finish()
