// 36차 단기매매 랩 집행자 — 국내 단기 기법 14변형(scripts/shortterm-lab.entry.ts).
//
// 이 파일이 막는 사고는 다섯 가지다.
//
//   ① **미래참조(규칙 1).** 단기 기법은 "오늘 종가를 보고 오늘 종가에 산다", "오늘 상한가를
//      보고 오늘 샀다"는 말로 유통된다. 그대로 코딩하면 전부 미래참조다. 그래서
//      **계열마다** (a) 절단 불변성 (b) 신호 미래맹목성 두 겹으로 건다.
//      (b)는 이 리포에서 처음 쓰는 형태다 — 신호 함수에 **진입봉 이후를 극단값으로
//      바꾼 배열**을 주고 결과가 같은지 본다. 절단 불변성은 "잘라낸 뒤"를 보지만,
//      미래맹목성은 "봉이 거기 있는데도 안 보는지"를 본다.
//   ② **변형 수가 조용히 늘어나는 것.** 14가 곧 다중검정 분모다. 하나 늘면 p값이 거짓이 된다.
//   ③ **상한가 제도 경계 누락.** 2015-06-15 전후로 상한폭이 ±15%→±30%다. 한 임계로 전
//      구간을 판정하면 앞 구간 상한가가 통째로 사라지거나 뒷 구간 급등이 상한가로 잡힌다.
//   ④ **체결 보수성 훼손.** 손절 갭 관통은 시가(불리한 쪽), 익절은 기준가(유리한 쪽으로
//      앞당기지 않는다), 같은 봉에서 둘 다 닿으면 손절 먼저 — 셋 다 여기서 고정한다.
//   ⑤ **경고 없는 표.** 이 계열은 체결 현실성 경고 없이는 숫자가 거짓이다. 표를 찍는
//      함수가 경고를 **강제로** 함께 출력하는지 출력 캡처로 확인한다.
//
// 네트워크를 타지 않는다(컨테이너에서 Yahoo는 403).

import { check, eq, close as closeTo, section, finish, rng } from './harness'
import {
  BENCH,
  COST as SHORT_COST,
  COST_FREE,
  FAMILY_LABEL,
  LIMITUP_REGIME_DATE,
  LIMITUP_TH_NEW,
  LIMITUP_TH_OLD,
  PRIOR_KRX_REAL_TOTAL,
  SHORT_BODY_PCT,
  SHORT_GAP_PCT,
  SHORT_MIN_TRADES,
  SHORT_SL_PCT,
  SHORT_SLOTS,
  SHORT_TP_PCT,
  SHORT_TS_MAX_DAYS,
  SHORT_VARIANT_COUNT,
  SHORT_VOL_MULT,
  SHORT_VOL_WINDOW,
  activeRatePct,
  avgExposurePct,
  avgTradeRetPct,
  avgVolSeries,
  chgPct,
  costSensitivityTable,
  familyTables,
  isBigCandle,
  isDownStreak,
  isLimitUpClose,
  limitUpThresholdPct,
  planHoldDays,
  prevTradingValue,
  runShortChain,
  shortCalmarSort,
  shortFailReasons,
  shortHeadlineTable,
  shortMultipleTestingNote,
  shortPass,
  shortPlans,
  shortRankTable,
  simulateShortTermYear,
  type ShortFamily,
  type ShortPlan,
  type ShortVariant,
} from '../scripts/shortterm-lab.entry'
import { SCREEN_MIN_TRADES, buildYearly, type Perf, type StratRow } from '../scripts/idea-lab.entry'
import type { CostSettings } from '../src/features/backtest/conditionScreen'
import type { DailyBar } from '../src/features/backtest/types'

const COST: CostSettings = { initialCapital: 10_000_000, feePct: 0.015, taxPct: 0.15, slippagePct: 0.1 }

/** 표 출력을 가로채 문자열로 받는다 — 표가 던지지 않는지, 경고 문구가 나오는지 본다. */
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

// ============================================================================
// 합성 시세 — 계열마다 신호가 실제로 발생하도록 이벤트를 **인덱스 규칙**으로 심는다.
// rnd로 심으면 시드에 따라 어떤 계열은 매매 0건이 되어 테스트가 조용히 공허해진다.
// ============================================================================

const EV_LIMITUP = 53 // i % 53 === 5  → 상한가 마감, ===6 → 다음날 되돌림
const EV_BIG = 37 // i % 37 === 7  → 장대양봉(몸통 큼 · 거래량 급증), ===8 → 되돌림
const EV_GAPUP = 23 // i % 23 === 3  → 갭상승 시초
const EV_GAPDN = 29 // i % 29 === 11 → 갭하락 시초

/**
 * 합성 일봉 — 주말을 건너뛴 거래일 근사(엔진은 달력을 데이터에서 만든다).
 *
 * ⚠️ 이벤트에는 **반드시 되돌림을 붙인다.** 상한가(+31%)·장대양봉(+12%)만 주기적으로 심으면
 *    가격이 지수적으로 발산해 몇 년 뒤 한 주 값이 슬롯 금액을 넘고, 그러면 `bookBuy`가
 *    수량 0을 돌려주면서 **매매가 조용히 0건이 된다**(테스트는 통과하는데 아무것도 안 도는
 *    상태). 실제로 첫 스모크에서 그 일이 났다. 되돌림을 붙여 가격 수준을 잡아 둔다.
 */
function makeBars(seed: number, fromYear: number, toYear: number, base = 50_000): DailyBar[] {
  const rnd = rng(seed)
  const bars: DailyBar[] = []
  let p = base
  const AVG_V = 500_000
  const start = Date.UTC(fromYear, 0, 1)
  const end = Date.UTC(toYear + 1, 0, 1)
  let i = 0
  for (let t = start; t < end; t += 86400000) {
    const d = new Date(t)
    const dow = d.getUTCDay()
    if (dow === 0 || dow === 6) continue
    let o: number
    let h: number
    let l: number
    let c: number
    let v: number
    if (i % EV_LIMITUP === 5) {
      // 상한가 굳힘 — 전일 종가 대비 +31%, **고가 = 종가**
      o = p * (1.08 + rnd() * 0.04)
      c = p * 1.31
      h = c
      l = o * 0.98
      v = AVG_V * (2 + rnd())
    } else if (i % EV_LIMITUP === 6) {
      // 상한가 다음날 되돌림 −22% (가격 발산 방지 + 따라잡기 계열에 손실 경로를 만든다)
      o = p * 0.95
      c = p * 0.78
      h = o * 1.01
      l = c * 0.99
      v = AVG_V * (1.5 + rnd())
    } else if (i % EV_BIG === 7) {
      // 장대양봉 — 몸통 +12%, 거래량 6배
      o = p * 0.99
      c = o * 1.12
      h = c * 1.005
      l = o * 0.99
      v = AVG_V * 6
    } else if (i % EV_BIG === 8) {
      o = p
      c = p * 0.9
      h = o * 1.005
      l = c * 0.99
      v = AVG_V * 2
    } else if (i % EV_GAPUP === 3) {
      // 갭상승으로 열고 종가는 전일 근처로 되돌린다(갭 판정은 시가만 본다)
      o = p * (1 + SHORT_GAP_PCT / 100 + 0.01 + rnd() * 0.02)
      c = p * (1 + (rnd() - 0.5) * 0.02)
      h = Math.max(o, c) * 1.01
      l = Math.min(o, c) * 0.99
      v = AVG_V * (0.6 + rnd())
    } else if (i % EV_GAPDN === 11) {
      o = p * (1 - SHORT_GAP_PCT / 100 - 0.01 - rnd() * 0.02)
      c = p * (1 + (rnd() - 0.5) * 0.02)
      h = Math.max(o, c) * 1.01
      l = Math.min(o, c) * 0.99
      v = AVG_V * (0.6 + rnd())
    } else {
      o = p * (1 + (rnd() - 0.5) * 0.01)
      c = Math.max(1, p * (1 + 0.0004 + 0.024 * (rnd() * 2 - 1)))
      h = Math.max(o, c) * (1 + rnd() * 0.012)
      l = Math.min(o, c) * (1 - rnd() * 0.012)
      v = AVG_V * (0.5 + rnd())
    }
    bars.push({ date: d.toISOString().slice(0, 10), t: Math.floor(t / 1000), o, h, l, c, v })
    p = c
    i++
  }
  return bars
}

const SYMS = ['000100', '000200', '000300', '000400', '000500', '000600', '000700', '000800']
/** 2016~2018 — 상한폭 ±30% 신제도 구간(상한가 판정이 29.5% 임계를 탄다). */
const HISTORIES: Record<string, DailyBar[]> = {}
// 시작가는 슬롯 금액(총자산÷10 = 100만) 대비 충분히 낮게 잡는다 — 한 주 값이 슬롯을
// 넘어서면 `bookBuy`가 수량 0을 돌려주며 매매가 조용히 사라진다(0) 섹션이 그걸 막는다).
SYMS.forEach((s, k) => {
  HISTORIES[s] = makeBars(1000 + k * 37, 2016, 2018, 8_000 + k * 2_000)
})
const YEARS = [2016, 2017, 2018]
const START = '2016-01-01'

function truncate(h: Record<string, DailyBar[]>, cutDate: string): Record<string, DailyBar[]> {
  const out: Record<string, DailyBar[]> = {}
  for (const [k, v] of Object.entries(h)) out[k] = v.filter((b) => b.date <= cutDate)
  return out
}

/** 진입봉 `idx` 이후(포함)를 전부 극단값으로 바꾼다 — "봉이 거기 있어도 안 본다"를 검증. */
function corruptFrom(bars: DailyBar[], idx: number): DailyBar[] {
  return bars.map((b, i) =>
    i < idx ? b : { ...b, o: 9.99e8, h: 9.99e8, l: 1e-6, c: 9.99e8, v: 9.99e11 },
  )
}

const PLANS = shortPlans()
const planOf = (key: string): ShortPlan => {
  const p = PLANS.find((x) => x.key === key)
  if (!p) throw new Error(`plan ${key} 없음`)
  return p
}

// ── 0) 픽스처 건전성 — "아무것도 안 도는데 통과"를 막는다 ────────────────────
{
  section('0) 합성 픽스처 건전성 — 가격 발산으로 매매가 0건이 되는 것을 막는다')

  // 이 검사가 없으면 이렇게 조용히 죽는다: 이벤트(+31%)만 주기적으로 심으면 가격이
  // 지수적으로 발산 → 한 주 값이 슬롯 금액을 넘음 → bookBuy가 수량 0 → 매매 0건.
  // 아래 절단 불변성·미래맹목성 테스트는 **매매가 0건이어도 전부 통과한다.**
  const slot = COST.initialCapital / SHORT_SLOTS
  for (const s of SYMS) {
    const bars = HISTORIES[s]
    let lo = Infinity
    let hi = 0
    for (const b of bars) {
      if (b.c < lo) lo = b.c
      if (b.c > hi) hi = b.c
    }
    check(`${s}: 가격이 발산하지 않는다 (최고/최저 ${(hi / lo).toFixed(1)}배)`, hi / lo < 200, `${lo} ~ ${hi}`)
    check(`${s}: 최고가에서도 슬롯 금액으로 10주 이상 살 수 있다`, hi * 10 <= slot, `hi=${hi} slot=${slot}`)
    check(`${s}: OHLC 정합(고가 ≥ max(시,종) · 저가 ≤ min(시,종))`,
      bars.every((b) => b.h >= Math.max(b.o, b.c) - 1e-9 && b.l <= Math.min(b.o, b.c) + 1e-9))
  }
}

// ── 1) 변형 정의 · 상수 정합 ─────────────────────────────────────────────────
{
  section('1) 변형 정의 — 14 고정 · 계열 분포 · 비용 상수 정합')

  eq(`총 변형 ${SHORT_VARIANT_COUNT}개`, PLANS.length, SHORT_VARIANT_COUNT)
  eq('변형 수 상수가 14', SHORT_VARIANT_COUNT, 14)
  eq('키 중복 없음', new Set(PLANS.map((p) => p.key)).size, PLANS.length)
  eq('라벨 중복 없음', new Set(PLANS.map((p) => p.label)).size, PLANS.length)

  const byFam = (f: ShortFamily) => PLANS.filter((p) => p.family === f).length
  eq('① 종가 매수 3변형', byFam('close'), 3)
  eq('② 상한가 따라잡기 4변형', byFam('limitup'), 4)
  eq('③ 갭 매매 3변형', byFam('gap'), 3)
  eq('④ 장대양봉 2변형', byFam('bigcandle'), 2)
  eq('⑤ 연속 하락 반등 2변형', byFam('rebound'), 2)
  eq('계열 라벨이 5개 전부 정의돼 있다', Object.keys(FAMILY_LABEL).length, 5)

  // 34차(krxcal)와 **같은 비용·슬롯**이어야 표가 나란히 읽힌다.
  eq('수수료 0.015%', SHORT_COST.feePct, COST.feePct)
  eq('거래세 0.15%', SHORT_COST.taxPct, COST.taxPct)
  eq('슬리피지 0.1%', SHORT_COST.slippagePct, COST.slippagePct)
  eq('초기자본 1천만', SHORT_COST.initialCapital, COST.initialCapital)
  eq('벤치는 KODEX 200', BENCH, '069500.KS')
  eq('슬롯 10', SHORT_SLOTS, 10)
  eq('표본 소실 판정선이 screen/krxcal과 같다', SHORT_MIN_TRADES, SCREEN_MIN_TRADES)

  // 비용 0 팔은 **비용만** 0이어야 한다(초기자본까지 바뀌면 두 팔이 다른 실험이 된다).
  eq('비용0 팔의 초기자본은 같다', COST_FREE.initialCapital, SHORT_COST.initialCapital)
  check(
    '비용0 팔은 수수료·세금·슬리피지가 전부 0',
    COST_FREE.feePct === 0 && COST_FREE.taxPct === 0 && COST_FREE.slippagePct === 0,
  )

  // 종가 매수 계열은 **반드시** 전일까지의 봉만 본다 — 여기가 이 회차의 핵심 위험이다.
  check(
    '① 종가 매수 3변형은 전부 scope=prevBars · 진입가=종가 · 청산=익일 시가',
    PLANS.filter((p) => p.family === 'close').every(
      (p) => p.scope === 'prevBars' && p.entryPrice === 'close' && p.exit.kind === 'nextOpen',
    ),
  )
  check(
    '갭 계열만 진입봉 시가를 본다(나머지는 전부 prevBars)',
    PLANS.every((p) => (p.scope === 'prevBarsPlusOpen') === (p.family === 'gap')),
  )
  check(
    '②④⑤는 전부 익일 시가 진입(신호 → 체결 분리)',
    PLANS.filter((p) => p.family === 'limitup' || p.family === 'bigcandle' || p.family === 'rebound').every(
      (p) => p.entryPrice === 'open' && p.scope === 'prevBars',
    ),
  )

  // 청산 규칙 4종이 지시서와 일치하는가
  eq('②-1 익일 종가 = 보유 1일', planHoldDays(planOf('limitup-close').exit), 1)
  eq('②-3 3일 보유', planHoldDays(planOf('limitup-h3').exit), 3)
  eq('②-4 5일 보유', planHoldDays(planOf('limitup-h5').exit), 5)
  eq('②-2 익절·손절 상한은 계열 최장(5일)과 같다', planHoldDays(planOf('limitup-ts').exit), SHORT_TS_MAX_DAYS)
  eq('②-2 익절 +5%', SHORT_TP_PCT, 5)
  eq('②-2 손절 −3%', SHORT_SL_PCT, 3)
  eq('③-1·③-2는 당일 종가 청산', planHoldDays(planOf('gap-up').exit), 1)
  eq('③-3은 익일 종가 청산(2일)', planHoldDays(planOf('gap-down-2d').exit), 2)
  eq('④-1 익일 종가', planHoldDays(planOf('big-close').exit), 1)
  eq('④-2 3일 보유', planHoldDays(planOf('big-h3').exit), 3)
  eq('⑤ 두 변형 다 2일 보유', PLANS.filter((p) => p.family === 'rebound').map((p) => planHoldDays(p.exit)).join(','), '2,2')
  eq('갭 임계 3%', SHORT_GAP_PCT, 3)
  eq('장대양봉 몸통 임계 8%', SHORT_BODY_PCT, 8)
  eq('거래량 배수 3배 · 창 20일', `${SHORT_VOL_MULT}/${SHORT_VOL_WINDOW}`, '3/20')
}

// ── 2) 상한가 제도 경계 ──────────────────────────────────────────────────────
{
  section('2) 상한가 제도 경계 — 2015-06-15 전 ±15% / 후 ±30%')

  eq('제도 변경일', LIMITUP_REGIME_DATE, '2015-06-15')
  eq('구제도 임계 14.5%', LIMITUP_TH_OLD, 14.5)
  eq('신제도 임계 29.5%', LIMITUP_TH_NEW, 29.5)
  eq('변경일 하루 전은 구제도', limitUpThresholdPct('2015-06-12'), LIMITUP_TH_OLD)
  eq('변경일 당일부터 신제도', limitUpThresholdPct('2015-06-15'), LIMITUP_TH_NEW)
  eq('변경일 이후는 신제도', limitUpThresholdPct('2016-01-04'), LIMITUP_TH_NEW)
  eq('2010년은 구제도', limitUpThresholdPct('2010-03-02'), LIMITUP_TH_OLD)

  /** 전일 종가 1000 → 당일 종가 c, 고가 h인 두 봉. */
  const pair = (date: string, c: number, h: number): DailyBar[] => [
    { date: '2000-01-01', t: 0, o: 1000, h: 1000, l: 1000, c: 1000, v: 1 },
    { date, t: 1, o: 1010, h, l: 1000, c, v: 1 },
  ]

  check('구제도 +15% 상한가 굳힘 → 상한가', isLimitUpClose(pair('2015-06-12', 1150, 1150), 1))
  check('구제도 +14.0%는 임계 미달 → 아님', !isLimitUpClose(pair('2015-06-12', 1140, 1140), 1))
  check(
    '같은 +15%도 신제도 구간에서는 상한가가 아니다 (제도 경계를 안 쓰면 여기서 오판)',
    !isLimitUpClose(pair('2015-06-15', 1150, 1150), 1),
  )
  check('신제도 +30% 굳힘 → 상한가', isLimitUpClose(pair('2016-01-04', 1300, 1300), 1))
  check(
    '신제도 +30%인데 고가 > 종가(상한가 풀림) → 아님',
    !isLimitUpClose(pair('2016-01-04', 1300, 1310), 1),
  )
  check(
    '구제도 구간의 +30%도 상한가로 잡힌다(그 시절엔 제도상 불가능하지만 임계 판정은 통과)',
    isLimitUpClose(pair('2010-03-02', 1300, 1300), 1),
  )
  check('첫 봉은 전일이 없어 판정 불가', !isLimitUpClose(pair('2016-01-04', 1300, 1300), 0))

  closeTo('chgPct 산술', chgPct(pair('2016-01-04', 1300, 1300), 1) ?? NaN, 30, 1e-9)
  eq('첫 봉 chgPct는 null', chgPct(pair('2016-01-04', 1300, 1300), 0), null)
}

// ── 3) 지표 산술 — 당일 제외 규약 ────────────────────────────────────────────
{
  section('3) 지표 산술 — 20일 평균거래량은 **당일 제외**, 연속 하락, 장대양봉')

  const bars: DailyBar[] = []
  for (let i = 0; i < 30; i++)
    bars.push({ date: `2020-01-${String(i + 1).padStart(2, '0')}`, t: i, o: 100, h: 101, l: 99, c: 100, v: (i + 1) * 10 })

  const av = avgVolSeries(bars, 5)
  eq('창이 안 찬 앞 구간은 null', av.slice(0, 5).every((x) => x == null), true)
  // out[5] = mean(v[0..4]) = mean(10,20,30,40,50) = 30
  closeTo('out[5] = 직전 5일 평균', av[5] ?? NaN, 30, 1e-9)
  // out[6] = mean(v[1..5]) = mean(20,30,40,50,60) = 40
  closeTo('out[6] = 한 칸 밀린 직전 5일 평균', av[6] ?? NaN, 40, 1e-9)
  check(
    '당일을 포함하지 않는다 — 당일 거래량을 바꿔도 그날 평균값은 불변',
    (() => {
      const spiked = bars.map((b, i) => (i === 10 ? { ...b, v: 1e9 } : b))
      return (avgVolSeries(spiked, 5)[10] ?? NaN) === (av[10] ?? NaN)
    })(),
  )
  check(
    '미래 봉을 바꿔도 앞 구간 평균은 불변(절단 불변성의 지표판)',
    (() => {
      const later = avgVolSeries(corruptFrom(bars, 12), 5)
      return av.slice(0, 12).every((x, i) => x === later[i])
    })(),
  )

  // 연속 하락
  const dn = (closes: number[]): DailyBar[] =>
    closes.map((c, i) => ({ date: `2020-02-${String(i + 1).padStart(2, '0')}`, t: i, o: c, h: c, l: c, c, v: 1 }))
  check('3일 연속 하락', isDownStreak(dn([100, 99, 98, 97]), 3, 3))
  check('중간에 반등이 있으면 아님', !isDownStreak(dn([100, 99, 100, 97]), 3, 3))
  check('5일 연속 하락', isDownStreak(dn([100, 99, 98, 97, 96, 95]), 5, 5))
  check('4일치뿐이면 5연속 판정 불가', !isDownStreak(dn([100, 99, 98, 97, 96]), 4, 5))
  check('데이터가 부족하면 false(예외 아님)', !isDownStreak(dn([100, 99]), 1, 3))

  // 장대양봉
  const aux = { avgVol: [null, 100, 100, 100] as (number | null)[] }
  const bc = (o: number, c: number, v: number): DailyBar[] => [
    { date: '2020-03-01', t: 0, o: 100, h: 100, l: 100, c: 100, v: 100 },
    { date: '2020-03-02', t: 1, o, h: Math.max(o, c), l: Math.min(o, c), c, v },
  ]
  check(`몸통 +${SHORT_BODY_PCT}% & 거래량 ${SHORT_VOL_MULT}배 → 장대양봉`, isBigCandle(bc(100, 110, 300), 1, aux))
  check('몸통이 모자라면 아님', !isBigCandle(bc(100, 105, 300), 1, aux))
  check('거래량이 모자라면 아님', !isBigCandle(bc(100, 110, 299), 1, aux))
  check('평균 거래량이 없으면(창 미충족) 아님', !isBigCandle(bc(100, 110, 300), 1, { avgVol: [null, null] }))

  // 전일 거래대금
  closeTo('전일 거래대금 = 전일 종가 × 전일 거래량', prevTradingValue(bc(100, 110, 300), 1), 100 * 100, 1e-9)
  eq('첫 봉은 전일이 없어 0', prevTradingValue(bc(100, 110, 300), 0), 0)
}

// ── 4) 🚫 신호 미래맹목성 — 14변형 전부 ───────────────────────────────────────
{
  section('4) 신호 미래맹목성 — 진입봉 이후를 극단값으로 바꿔도 신호가 같아야 한다')

  // 절단 불변성은 "잘라낸 뒤"를 본다. 이 테스트는 **봉이 거기 있는데도 안 보는지**를 본다.
  // 두 겹이 필요한 이유: 신호가 bars[i]를 읽어도 절단만으로는 안 걸리는 경로가 있다.
  let anySignal = 0
  for (const plan of PLANS) {
    const bars = HISTORIES['000100']
    const auxFull = { avgVol: avgVolSeries(bars) }
    let same = 0
    let diff = 0
    let fired = 0
    for (let i = 30; i < bars.length - 1; i++) {
      const entryOpen = plan.scope === 'prevBarsPlusOpen' ? bars[i].o : null
      const a = plan.signal(bars, i, entryOpen, auxFull)
      const cor = corruptFrom(bars, i)
      // aux도 **오염된 배열에서 다시** 계산한다 — 사전계산 경로로 미래가 새는지까지 본다.
      const b = plan.signal(cor, i, entryOpen, { avgVol: avgVolSeries(cor) })
      if (a === b) same++
      else diff++
      if (a) fired++
    }
    eq(`${plan.key}: 진입봉 이후 오염에도 신호 불변`, diff, 0)
    check(`${plan.key}: 신호가 실제로 발생한다(공허한 통과 방지) — ${fired}회`, fired > 0, `same=${same}`)
    anySignal += fired
  }
  check('전 변형 합계 신호 발생', anySignal > 0)

  // 갭 계열이 **시가 외의 당일 정보**를 안 보는지 따로 확인한다.
  for (const key of ['gap-up', 'gap-down', 'gap-down-2d']) {
    const plan = planOf(key)
    const bars = HISTORIES['000200']
    const aux = { avgVol: avgVolSeries(bars) }
    let diff = 0
    for (let i = 30; i < bars.length - 1; i++) {
      // 진입봉의 고가·저가·종가·거래량을 통째로 바꾸고 **시가만** 원본을 넘긴다.
      const wrecked = bars.map((b, j) => (j === i ? { ...b, h: 9e8, l: 1e-6, c: 9e8, v: 9e11 } : b))
      if (plan.signal(bars, i, bars[i].o, aux) !== plan.signal(wrecked, i, bars[i].o, aux)) diff++
    }
    eq(`${key}: 진입봉의 시가 외 값에 의존하지 않는다`, diff, 0)
  }

  // 종가 매수 계열이 **당일 등락률·당일 거래대금**을 안 쓰는지(이 회차의 최대 위험).
  for (const key of ['close-all', 'close-up', 'close-value']) {
    const plan = planOf(key)
    const bars = HISTORIES['000300']
    const aux = { avgVol: avgVolSeries(bars) }
    let diff = 0
    for (let i = 30; i < bars.length - 1; i++) {
      const wrecked = bars.map((b, j) => (j === i ? { ...b, o: 1, h: 9e8, l: 1e-6, c: 9e8, v: 9e11 } : b))
      // 종가 매수는 entryOpen을 못 받는다(null) — 당일 봉 자체가 판단에서 배제된다.
      if (plan.signal(bars, i, null, aux) !== plan.signal(wrecked, i, null, aux)) diff++
    }
    eq(`${key}: 당일 봉(등락률·거래대금)을 판단에 쓰지 않는다`, diff, 0)
  }
}

// ── 5) 🚫 절단 불변성 — 계열마다 (규칙 1 집행자) ─────────────────────────────
{
  section('5) 절단 불변성 — 14변형 전부, 잘린 시점 이전의 매매·자산곡선이 완전 동일')

  const CUT = '2017-06-30'
  for (const plan of PLANS) {
    const full = simulateShortTermYear(HISTORIES, START, SYMS, COST, plan)
    const cutHist = truncate(HISTORIES, CUT)
    const cut = simulateShortTermYear(cutHist, START, SYMS, COST, plan)

    // 잘린 쪽의 **마지막 봉은 신규 진입을 만들지 않는다**(규칙 1-6) — 경계 한 칸 앞까지 비교.
    const lastDate = cut.equity.length ? cut.equity[cut.equity.length - 1].date : CUT
    const cmp = (e: { date: string }) => e.date < lastDate

    const fe = full.equity.filter(cmp)
    const ce = cut.equity.filter(cmp)
    eq(`${plan.key}: 자산곡선 길이 동일`, ce.length, fe.length)
    let bad = 0
    for (let i = 0; i < Math.min(fe.length, ce.length); i++) {
      if (fe[i].date !== ce[i].date || fe[i].equity !== ce[i].equity) bad++
    }
    eq(`${plan.key}: 자산곡선 값 완전 동일`, bad, 0)

    const ff = full.fills.filter(cmp)
    const cf = cut.fills.filter(cmp)
    eq(`${plan.key}: 체결 건수 동일`, cf.length, ff.length)
    const sig = (f: { date: string; sym: string; side: string; px: number; qty: number; signalDate: string }) =>
      `${f.date}/${f.sym}/${f.side}/${f.px}/${f.qty}/${f.signalDate}`
    eq(`${plan.key}: 체결 원장 완전 동일`, cf.map(sig).join('|'), ff.map(sig).join('|'))
    check(`${plan.key}: 절단 전 구간에 체결이 있다(공허한 통과 방지)`, ff.length > 0, `${ff.length}건`)
  }
}

// ── 6) 신호 → 체결 분리 ──────────────────────────────────────────────────────
{
  section('6) 신호 → 체결 분리 · 마지막 봉 진입 금지 · 피라미딩 금지')

  for (const plan of PLANS) {
    const r = simulateShortTermYear(HISTORIES, START, SYMS, COST, plan)
    const buys = r.fills.filter((f) => f.side === 'buy')
    check(`${plan.key}: 매수 체결이 있다`, buys.length > 0, `${buys.length}건`)

    if (plan.scope === 'prevBars') {
      eq(
        `${plan.key}: 모든 매수의 신호일 < 체결일 (당일 정보로 당일 체결하지 않는다)`,
        buys.filter((f) => !(f.signalDate < f.date)).length,
        0,
      )
    } else {
      // 갭 계열은 진입봉 시가를 보므로 신호일 = 체결일이다. 미래로는 못 간다.
      eq(`${plan.key}: 갭 계열의 신호일 = 체결일 (미래일은 없다)`, buys.filter((f) => f.signalDate > f.date).length, 0)
    }

    // 규칙 1-6 — 마지막 봉 신규 진입 금지
    const lastDate = r.equity[r.equity.length - 1].date
    eq(`${plan.key}: 마지막 봉에 신규 매수 없음`, buys.filter((f) => f.date === lastDate).length, 0)

    // 구간 **후반부**에도 매수가 있어야 한다 — 앞쪽에서만 몇 건 돌고 죽는 경우
    // (가격 발산으로 수량 0이 되는 등) 위 검사들은 전부 통과해 버린다.
    const tail = r.equity[Math.floor(r.equity.length * 0.7)].date
    check(`${plan.key}: 구간 후반(70% 이후)에도 매수가 있다`, buys.some((f) => f.date >= tail), `${buys.length}건`)

    // 피라미딩 금지 + 슬롯 상한
    const held = new Set<string>()
    let dup = 0
    let orphan = 0
    let maxHeld = 0
    for (const f of r.fills) {
      if (f.side === 'buy') {
        if (held.has(f.sym)) dup++
        held.add(f.sym)
      } else {
        if (!held.has(f.sym)) orphan++
        held.delete(f.sym)
      }
      maxHeld = Math.max(maxHeld, held.size)
    }
    eq(`${plan.key}: 보유 중 재매수(피라미딩) 없음`, dup, 0)
    eq(`${plan.key}: 보유하지 않은 종목 매도 없음`, orphan, 0)
    check(`${plan.key}: 동시 보유 ≤ ${SHORT_SLOTS}슬롯`, maxHeld <= SHORT_SLOTS, `최대 ${maxHeld}`)
  }
}

// ── 7) 청산 규칙 — 보유일수 · 익절/손절 보수성 ───────────────────────────────
{
  section('7) 청산 규칙 — 보유일수 · 익절/손절 체결 보수성')

  /** 손으로 짠 시나리오 한 종목. 2016년(신제도) 구간. */
  function scenario(rows: [string, number, number, number, number, number][]): Record<string, DailyBar[]> {
    return {
      AAA: rows.map(([date, o, h, l, c, v], i) => ({ date, t: i, o, h, l, c, v })),
    }
  }
  const d = (n: number) => `2016-0${Math.floor((n - 1) / 28) + 1}-${String(((n - 1) % 28) + 1).padStart(2, '0')}`

  // 상한가 → 익일 진입. 진입일 시가 1000 → 손절 970 / 익절 1050.
  const base: [string, number, number, number, number, number][] = [
    [d(1), 1000, 1000, 1000, 1000, 1000], // 기준 종가 1000
    [d(2), 1100, 1310, 1080, 1310, 5000], // +31% 상한가 굳힘(h=c)
  ]

  // (a) 손절 — 저가가 손절선 아래, 시가는 손절선 위 → **기준가(970)**로 체결
  {
    const h = scenario([...base, [d(3), 1000, 1020, 900, 1010, 3000], [d(4), 1010, 1020, 1000, 1015, 1000]])
    const r = simulateShortTermYear(h, d(1), ['AAA'], COST, planOf('limitup-ts'))
    const sells = r.fills.filter((f) => f.side === 'sell')
    eq('(a) 손절 1건', sells.length, 1)
    closeTo('(a) 손절 체결가 = 진입시가 × 0.97', sells[0]?.px ?? NaN, 1000 * (1 - SHORT_SL_PCT / 100), 1e-9)
    eq('(a) 손절일은 진입 당일', sells[0]?.date, d(3))
  }

  // (b) 익절 — 시가가 익절선보다 높아도 **기준가(1050)**로만 체결(유리한 쪽으로 앞당기지 않는다)
  {
    const h = scenario([
      ...base,
      [d(3), 1000, 1000, 1000, 1000, 3000], // 진입일 — 아무것도 안 닿음(시가=고가=저가=종가)
      [d(4), 1200, 1300, 1190, 1250, 1000], // 다음날 시가부터 익절선 위
      [d(5), 1250, 1260, 1240, 1255, 1000],
    ])
    const r = simulateShortTermYear(h, d(1), ['AAA'], COST, planOf('limitup-ts'))
    const sells = r.fills.filter((f) => f.side === 'sell')
    eq('(b) 익절 1건', sells.length, 1)
    closeTo('(b) 익절 체결가 = 진입시가 × 1.05 (시가 1200이 아니다)', sells[0]?.px ?? NaN, 1000 * (1 + SHORT_TP_PCT / 100), 1e-9)
  }

  // (c) 손절 갭 관통 — 시가가 손절선 아래로 갭 → **시가**(더 불리한 쪽)로 체결
  {
    const h = scenario([
      ...base,
      [d(3), 1000, 1000, 1000, 1000, 3000], // 진입일 — 무접촉
      [d(4), 900, 950, 890, 940, 1000], // 시가 900 < 손절선 970 → 900으로 체결
      [d(5), 940, 950, 930, 945, 1000],
    ])
    const r = simulateShortTermYear(h, d(1), ['AAA'], COST, planOf('limitup-ts'))
    const sells = r.fills.filter((f) => f.side === 'sell')
    eq('(c) 갭 손절 1건', sells.length, 1)
    closeTo('(c) 갭 관통은 기준가가 아니라 시가로 체결', sells[0]?.px ?? NaN, 900, 1e-9)
  }

  // (d) 같은 봉에서 손절선·익절선 둘 다 접촉 → **손절 먼저**
  {
    const h = scenario([...base, [d(3), 1000, 1100, 900, 1050, 3000], [d(4), 1050, 1060, 1040, 1055, 1000]])
    const r = simulateShortTermYear(h, d(1), ['AAA'], COST, planOf('limitup-ts'))
    const sells = r.fills.filter((f) => f.side === 'sell')
    eq('(d) 1건', sells.length, 1)
    closeTo('(d) 둘 다 닿으면 손절(970)로 본다', sells[0]?.px ?? NaN, 970, 1e-9)
  }

  // (e) 보유일수 — 3일 보유는 진입일 포함 3거래일째 종가
  {
    const rows: [string, number, number, number, number, number][] = [...base]
    for (let k = 3; k <= 9; k++) rows.push([d(k), 1000, 1005, 995, 1000, 1000])
    const h = scenario(rows)
    const r3 = simulateShortTermYear(h, d(1), ['AAA'], COST, planOf('limitup-h3'))
    const s3 = r3.fills.filter((f) => f.side === 'sell')
    const b3 = r3.fills.filter((f) => f.side === 'buy')
    eq('(e) 3일 보유 — 진입일 d(3)', b3[0]?.date, d(3))
    eq('(e) 3일 보유 — 청산일 d(5)', s3[0]?.date, d(5))
    closeTo('(e) 청산 기준가는 종가', s3[0]?.px ?? NaN, 1000, 1e-9)

    const r5 = simulateShortTermYear(h, d(1), ['AAA'], COST, planOf('limitup-h5'))
    const s5 = r5.fills.filter((f) => f.side === 'sell')
    eq('(e) 5일 보유 — 청산일 d(7)', s5[0]?.date, d(7))

    const r1 = simulateShortTermYear(h, d(1), ['AAA'], COST, planOf('limitup-close'))
    const s1 = r1.fills.filter((f) => f.side === 'sell')
    eq('(e) 익일 종가 청산 — 진입일 당일 종가', s1[0]?.date, d(3))
  }

  // (f) 오버나이트 — 종가 매수 → **다음 거래일 시가** 매도
  {
    const rows: [string, number, number, number, number, number][] = []
    for (let k = 1; k <= 8; k++) rows.push([d(k), 1000 + k, 1010 + k, 990 + k, 1000 + k, 1000])
    const h = scenario(rows)
    const r = simulateShortTermYear(h, d(1), ['AAA'], COST, planOf('close-all'))
    const buys = r.fills.filter((f) => f.side === 'buy')
    const sells = r.fills.filter((f) => f.side === 'sell')
    check('(f) 오버나이트 매수가 있다', buys.length > 0)
    eq('(f) 매수·매도 건수 동일(당일 왕복 없음)', sells.length, buys.length)
    let bad = 0
    for (let i = 0; i < Math.min(buys.length, sells.length); i++) {
      if (!(sells[i].date > buys[i].date)) bad++
      // 매수는 종가, 매도는 다음날 시가여야 한다
      const bi = rows.findIndex((x) => x[0] === buys[i].date)
      const si = rows.findIndex((x) => x[0] === sells[i].date)
      if (rows[bi][4] !== buys[i].px) bad++ // c
      if (rows[si][1] !== sells[i].px) bad++ // o
      if (si !== bi + 1) bad++
    }
    eq('(f) 종가 매수 → 익일 시가 매도가 전 건 성립', bad, 0)
  }

  // (g) 갭 매매 — 갭이 난 날 **시가**에 사고 그날 종가에 판다
  {
    const rows: [string, number, number, number, number, number][] = [
      [d(1), 1000, 1005, 995, 1000, 1000],
      [d(2), 1050, 1080, 1040, 1060, 1000], // +5% 갭상승
      [d(3), 1060, 1065, 1055, 1060, 1000],
      [d(4), 1060, 1065, 1055, 1060, 1000],
    ]
    const h = scenario(rows)
    const r = simulateShortTermYear(h, d(1), ['AAA'], COST, planOf('gap-up'))
    const buys = r.fills.filter((f) => f.side === 'buy')
    const sells = r.fills.filter((f) => f.side === 'sell')
    eq('(g) 갭상승일에 1건 매수', buys.length, 1)
    eq('(g) 매수일 = 갭 발생일', buys[0]?.date, d(2))
    closeTo('(g) 매수 기준가 = 그날 시가', buys[0]?.px ?? NaN, 1050, 1e-9)
    eq('(g) 같은 날 종가 청산', sells[0]?.date, d(2))
    closeTo('(g) 청산 기준가 = 그날 종가', sells[0]?.px ?? NaN, 1060, 1e-9)

    // 갭하락 매수는 이 시나리오에서 발생하지 않아야 한다(방향 오배선 방지)
    const rd = simulateShortTermYear(h, d(1), ['AAA'], COST, planOf('gap-down'))
    eq('(g) 갭상승 데이터에 갭하락 진입은 없다', rd.fills.filter((f) => f.side === 'buy').length, 0)
  }
}

// ── 8) 슬롯·선정 규칙 ───────────────────────────────────────────────────────
{
  section('8) 슬롯 균등 · 거래대금 정렬 · 순환 배분')

  // 거래대금 정렬: 전일 거래대금이 큰 종목이 먼저 담긴다.
  {
    const rows = (mult: number): DailyBar[] => {
      const out: DailyBar[] = []
      for (let i = 0; i < 12; i++)
        out.push({
          date: `2016-01-${String(i + 1).padStart(2, '0')}`,
          t: i,
          o: 1000,
          h: 1005,
          l: 995,
          c: 1000,
          v: 1000 * mult,
        })
      return out
    }
    const h: Record<string, DailyBar[]> = {}
    // 코드 오름차순과 거래대금 내림차순이 **반대**가 되게 심는다 — 정렬이 코드순으로
    // 흘러가면 여기서 걸린다.
    for (let k = 0; k < 20; k++) h[`9000${String(k).padStart(2, '0')}`] = rows(20 - k)
    const syms = Object.keys(h)
    const r = simulateShortTermYear(h, '2016-01-01', syms, COST, planOf('close-value'))
    const firstDay = r.fills.filter((f) => f.side === 'buy' && f.date === r.equity[1].date)
    check('거래대금 상위 변형은 하루에 최대 10종목', firstDay.length <= SHORT_SLOTS)
    check(
      '거래대금 큰 순(=코드 작은 순)으로 담긴다',
      firstDay.every((f) => Number(f.sym) < 900010),
      firstDay.map((f) => f.sym).join(','),
    )
  }

  // 순환 배분: 유니버스 20종목 · 슬롯 10이면 며칠 안에 10종목을 넘겨 돈다.
  {
    const flat = (): DailyBar[] => {
      const out: DailyBar[] = []
      for (let i = 0; i < 40; i++)
        out.push({
          date: `2016-0${Math.floor(i / 28) + 1}-${String((i % 28) + 1).padStart(2, '0')}`,
          t: i,
          o: 1000,
          h: 1005,
          l: 995,
          c: 1001,
          v: 1000,
        })
      return out
    }
    const h: Record<string, DailyBar[]> = {}
    for (let k = 0; k < 20; k++) h[`8000${String(k).padStart(2, '0')}`] = flat()
    const syms = Object.keys(h)
    const r = simulateShortTermYear(h, '2016-01-01', syms, COST, planOf('close-all'))
    const touched = new Set(r.fills.filter((f) => f.side === 'buy').map((f) => f.sym))
    check(
      `순환 배분이 유니버스를 고르게 돈다 — ${touched.size}/20종목 진입`,
      touched.size > SHORT_SLOTS,
      [...touched].join(','),
    )
    // 결정적이어야 한다(같은 입력 → 같은 출력)
    const r2 = simulateShortTermYear(h, '2016-01-01', syms, COST, planOf('close-all'))
    eq(
      '순환 배분은 결정적이다',
      r.fills.map((f) => `${f.date}/${f.sym}/${f.side}`).join('|'),
      r2.fills.map((f) => `${f.date}/${f.sym}/${f.side}`).join('|'),
    )
  }
}

// ── 9) 연쇄 · 비용 민감도 ────────────────────────────────────────────────────
{
  section('9) 연쇄 실행 · 통계 · 비용 민감도')

  const yearly = buildYearly(HISTORIES, YEARS, () => SYMS)
  check('연도 슬라이스 3개', yearly.length === 3)

  for (const plan of PLANS) {
    const real = runShortChain(yearly, plan, SHORT_COST)
    const free = runShortChain(yearly, plan, COST_FREE)
    check(`${plan.key}: 연쇄 자산곡선이 만들어진다`, real.chain.equity.length > 100, String(real.chain.equity.length))
    check(`${plan.key}: 청산 완료 매매가 있다`, real.chain.closed > 0, String(real.chain.closed))
    eq(`${plan.key}: 거래손익률 집계 건수 = 청산 건수`, real.stats.retCount, real.chain.closed)
    const ex = avgExposurePct(real.stats)
    check(`${plan.key}: 오버나이트 노출이 0~100% 범위`, ex != null && ex >= 0 && ex <= 100.0001, String(ex))
    const ar = activeRatePct(real.stats)
    check(`${plan.key}: 가동률이 0~100% 범위이고 0보다 크다`, ar != null && ar > 0 && ar <= 100.0001, String(ar))
    // 당일 왕복 계열은 종가 노출이 0인데 가동률은 0이 아니다 — 두 지표가 다르다는 것을 고정.
    if (planHoldDays(plan.exit) === 1 && plan.exit.kind !== 'nextOpen')
      check(`${plan.key}: 당일 왕복 — 종가 노출 ≈ 0인데 가동률 > 0`, (ex ?? 1) < 1 && (ar ?? 0) > 0, `ex=${ex} ar=${ar}`)
    // 비용을 지우면 거래당 평균 손익은 **반드시** 좋아진다(같은 매매 경로가 아니어도
    // 비용이 음의 상수로 얹히는 구조라 방향이 뒤집히면 비용 배선이 잘못된 것이다).
    const aReal = avgTradeRetPct(real.stats)
    const aFree = avgTradeRetPct(free.stats)
    check(
      `${plan.key}: 비용 0의 거래당 평균이 실제 비용보다 높다`,
      aReal != null && aFree != null && aFree > aReal,
      `free=${aFree} real=${aReal}`,
    )
  }

  // 연쇄 절단 불변성 — 계열마다 한 변형씩(연쇄 레이어에서 새는 미래참조까지 덮는다)
  const CUT_Y = [2016, 2017]
  for (const key of ['close-all', 'limitup-ts', 'gap-down-2d', 'big-h3', 'rebound-3']) {
    const plan = planOf(key)
    const fullChain = runShortChain(buildYearly(HISTORIES, YEARS, () => SYMS), plan, SHORT_COST)
    const cutChain = runShortChain(buildYearly(HISTORIES, CUT_Y, () => SYMS), plan, SHORT_COST)
    const cutEnd = '2017-12-01' // 잘린 해의 마지막 봉 효과를 피해 한 달 앞에서 비교
    const fe = fullChain.chain.equity.filter((e) => e.date < cutEnd)
    const ce = cutChain.chain.equity.filter((e) => e.date < cutEnd)
    eq(`${key}: 연쇄 절단 — 곡선 길이 동일`, ce.length, fe.length)
    let bad = 0
    for (let i = 0; i < Math.min(fe.length, ce.length); i++)
      if (fe[i].date !== ce[i].date || Math.abs(fe[i].equity - ce[i].equity) > 1e-9) bad++
    eq(`${key}: 연쇄 절단 — 곡선 값 동일`, bad, 0)
    check(`${key}: 비교 구간이 비어 있지 않다`, fe.length > 50, String(fe.length))
  }
}

// ── 10) 판정 산술 ────────────────────────────────────────────────────────────
{
  section('10) 판정 산술 — 전·후반 알파 양수 + 매매수')

  const perf = (cagr: number, mdd: number): Perf => ({ total: 0, cagr, mdd, obj: null, years: 10 })
  const mkRow = (label: string, cagr: number, mdd: number, aA: number | null, aB: number | null, closed: number): StratRow => ({
    label,
    full: perf(cagr, mdd),
    a: perf(cagr, mdd),
    b: perf(cagr, mdd),
    closed,
    wins: Math.floor(closed / 2),
    alphaFull: null,
    alphaA: aA,
    alphaB: aB,
    perYear: [],
  })

  eq('둘 다 양수 + 매매 충분 → 통과', shortFailReasons(mkRow('x', 10, -20, 1, 1, 100), 100).join(','), '')
  eq('전반 알파 음수 → 알파 탈락', shortFailReasons(mkRow('x', 10, -20, -1, 1, 100), 100).join(','), '알파')
  eq('후반 알파 음수 → 알파 탈락', shortFailReasons(mkRow('x', 10, -20, 1, -1, 100), 100).join(','), '알파')
  eq('알파 null(벤치 구간 없음) → 탈락', shortFailReasons(mkRow('x', 10, -20, null, 1, 100), 100).join(','), '알파')
  eq('매매수 부족 → 매매 탈락', shortFailReasons(mkRow('x', 10, -20, 1, 1, 3), 3).join(','), '매매')
  eq(
    '둘 다 실패하면 사유 둘 다',
    shortFailReasons(mkRow('x', 10, -20, -1, -1, 1), 1).join('·'),
    '알파·매매',
  )
  eq(`경계값 ${SHORT_MIN_TRADES}건은 통과`, shortPass(mkRow('x', 10, -20, 1, 1, SHORT_MIN_TRADES), SHORT_MIN_TRADES), true)
  eq(`${SHORT_MIN_TRADES - 1}건은 탈락`, shortPass(mkRow('x', 10, -20, 1, 1, SHORT_MIN_TRADES - 1), SHORT_MIN_TRADES - 1), false)

  // 칼마 정렬 — 결정적이며 null은 뒤로
  const mkVar = (key: string, cagr: number, mdd: number): ShortVariant => ({
    plan: { ...planOf('close-all'), key, label: key },
    row: mkRow(key, cagr, mdd, 1, 1, 100),
    stats: { retSum: 1, retCount: 100, investedSum: 50, markDays: 100, activeDays: 80 },
    freeRow: mkRow(key, cagr, mdd, 1, 1, 100),
    freeStats: { retSum: 2, retCount: 100, investedSum: 50, markDays: 100, activeDays: 80 },
  })
  const sorted = shortCalmarSort([mkVar('flat', 8, 0), mkVar('lo', 5, -25), mkVar('hi', 12, -20), mkVar('aaa', 6, -20), mkVar('bbb', 6, -20)])
  eq('칼마 내림차순 · 동점은 키 오름차순 · null은 뒤', sorted.map((v) => v.plan.key).join(','), 'hi,aaa,bbb,lo,flat')

  closeTo('평균 거래손익률 = 합 ÷ 건수 × 100', avgTradeRetPct({ retSum: 2, retCount: 100, investedSum: 0, markDays: 0, activeDays: 0 }) ?? NaN, 2, 1e-9)
  eq('거래가 없으면 null', avgTradeRetPct({ retSum: 0, retCount: 0, investedSum: 0, markDays: 0, activeDays: 0 }), null)
  closeTo('오버나이트 노출률 = 합 ÷ 일수 × 100', avgExposurePct({ retSum: 0, retCount: 0, investedSum: 50, markDays: 100, activeDays: 100 }) ?? NaN, 50, 1e-9)
  closeTo('가동률 = 활동일 ÷ 평가일 × 100', activeRatePct({ retSum: 0, retCount: 0, investedSum: 0, markDays: 200, activeDays: 50 }) ?? NaN, 25, 1e-9)
  eq('평가일이 없으면 가동률 null', activeRatePct({ retSum: 0, retCount: 0, investedSum: 0, markDays: 0, activeDays: 0 }), null)
}

// ── 11) 경고 강제 출력 ───────────────────────────────────────────────────────
{
  section('11) 체결 현실성 경고 — 표가 경고를 강제로 함께 찍는다')

  const perf = (cagr: number, mdd: number): Perf => ({ total: 0, cagr, mdd, obj: null, years: 10 })
  const mkRow = (label: string, closed: number): StratRow => ({
    label,
    full: perf(10, -20),
    a: perf(10, -20),
    b: perf(10, -20),
    closed,
    wins: Math.floor(closed / 2),
    alphaFull: 1,
    alphaA: 1,
    alphaB: 1,
    perYear: [],
  })
  const vars: ShortVariant[] = PLANS.map((p) => ({
    plan: p,
    row: mkRow(p.label, 100),
    stats: { retSum: 0.5, retCount: 100, investedSum: 40, markDays: 100, activeDays: 70 },
    freeRow: mkRow(`${p.label} [비용0]`, 100),
    freeStats: { retSum: 1.5, retCount: 100, investedSum: 40, markDays: 100, activeDays: 70 },
  }))
  const wall = { label: 'QQQ 원화 보유', perf: perf(9, -30), calmar: 0.3, span: '2016~2018' }

  const out = capture(() => shortRankTable('테스트 순위', vars, wall)).join('\n')
  check('순위표가 체결 현실성 경고를 함께 찍는다', out.includes('체결 현실성 경고'))
  check('상한가 매수 잔량 경고', out.includes('매수 잔량'))
  check('하한가에서 못 파는 위험 경고', out.includes('하한가'))
  check('종가 단일가 슬리피지 경고', out.includes('단일가'))
  check('분봉 필요 경고', out.includes('분봉'))
  check('비용이 알파를 먹는다는 경고', out.includes('비용'))
  check('14행이 전부 찍힌다', PLANS.every((p) => out.includes(p.label)))

  const famOut = capture(() => familyTables(vars, wall)).join('\n')
  for (const fam of ['close', 'limitup', 'gap', 'bigcandle', 'rebound'] as ShortFamily[])
    check(`${fam} 계열 표에 계열 경고가 붙는다`, famOut.includes(FAMILY_LABEL[fam]))
  check('상한가 제도 경계가 출력된다', famOut.includes(LIMITUP_REGIME_DATE) && famOut.includes('±30%'))
  check('구제도 임계도 출력된다', famOut.includes(String(LIMITUP_TH_OLD)))

  const costOut = capture(() => costSensitivityTable(vars)).join('\n')
  check('비용 민감도 표가 비용 0 열을 찍는다', costOut.includes('비용0') || costOut.includes('비용 0'))

  const headOut = capture(() => shortHeadlineTable({ total: 14, passed: 0, over: 0, costKilled: 0 }, wall)).join('\n')
  check('통과 0이면 "하나도 없다"를 크게 쓴다', headOut.includes('하나도 없다'))
  check('헤드라인에 판정 통과 n/14가 있다', headOut.includes('0 / 14'))

  const mtOut = capture(() => shortMultipleTestingNote(14, 2, 1)).join('\n')
  check('다중검정 경고에 이번 회차 14가 있다', mtOut.includes('14'))
  check('누적 분모를 함께 찍는다', mtOut.includes('누적'))
  check(
    '누적 합이 사전 회차 + 이번 회차와 일치',
    mtOut.includes(String(PRIOR_KRX_REAL_TOTAL + 14)),
    String(PRIOR_KRX_REAL_TOTAL + 14),
  )
  check('누적 회차 수가 0이 아니다(공허한 누적 방지)', PRIOR_KRX_REAL_TOTAL > 0, String(PRIOR_KRX_REAL_TOTAL))
}

finish()
