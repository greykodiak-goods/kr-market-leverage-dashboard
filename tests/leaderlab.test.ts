// 주도주 랩 집행자 — 국장 "당일 주도주" 추종 12변형(scripts/leader-lab.entry.ts).
// tests/shortterm.test.ts의 11섹션 구조를 본떴다.
//
// 이 파일이 막는 사고:
//   ① **미래참조(규칙 1).** "주도주를 보고 따라붙는다"는 서술은 "오늘 거래대금 상위를 오늘
//      샀다"로 코딩되기 쉽다 — 전부 미래참조다. 계열(트랙 A·B·C)마다 (a) 절단 불변성
//      (b) 신호 미래맹목성 두 겹으로 건다.
//   ② **변형 수가 조용히 늘어나는 것.** 12가 곧 다중검정 분모다(LEADER_VARIANT_COUNT 정합).
//   ③ **체결 보수성 훼손.** 손절·트레일 갭 관통은 시가(불리한 쪽), 손절이 종가 청산보다 먼저,
//      트레일 고점은 전일까지의 종가(당일 종가로 당일 저가를 판정하면 봉 내부 미래참조).
//   ④ **시가 상한가 매수.** 상한가 시가는 체결이 안 잡힌다 — 스킵을 여기서 고정한다.
//   ⑤ **슬롯·타이브레이크 비결정성.** 전일 거래대금 내림차순 · 동점 코드 오름차순.
//   ⑥ **유니버스 미래참조.** 월별 시총 유니버스는 측정일 **다음 날부터** 적용(측정일 시총은
//      그날 종가로 잰 값이다).
//
// 네트워크를 타지 않는다(시세·유니버스 전부 합성 — 컨테이너에서 야후는 403).

import { check, eq, close as closeTo, section, finish, rng } from './harness'
import {
  COST_2X,
  GROUP_LABEL,
  LEADER_B2_STOP_PCT,
  LEADER_CHG_PCT,
  LEADER_GAP_PCT,
  LEADER_MIN_TRADES,
  LEADER_NEARHIGH_PCT,
  LEADER_PERSIST_MULT,
  LEADER_SLOTS,
  LEADER_SURGE_MULT,
  LEADER_TRAIL_PCT,
  LEADER_TV_WINDOW,
  LEADER_VARIANT_COUNT,
  LEADER_VBRK_K1,
  LEADER_VBRK_K2,
  brokePrevMaxClose,
  buildLeaderAux,
  gapPct,
  isLimitUpOpen,
  isPersistentLeader,
  isPrevDaySurge,
  leaderPlans,
  perYearFromCurve,
  simulateLeader,
  toChain,
  universeAt,
  vbrkTrigger,
  type LeaderGroup,
  type LeaderPlan,
  type PreparedUniverse,
} from '../scripts/leader-lab.entry'
import { COST as SHORT_COST } from '../scripts/shortterm-lab.entry'
import { MAX_POSITIONS, SCREEN_MIN_TRADES } from '../scripts/idea-lab.entry'
import type { CostSettings } from '../src/features/backtest/conditionScreen'
import type { DailyBar } from '../src/features/backtest/types'

const COST: CostSettings = { initialCapital: 10_000_000, feePct: 0.015, taxPct: 0.15, slippagePct: 0.1 }

// ============================================================================
// 합성 시세 — 계열마다 신호가 실제로 발생하도록 이벤트를 **인덱스 규칙**으로 심는다.
// 난수로 심으면 시드에 따라 어떤 계열은 매매 0건이 되어 테스트가 조용히 공허해진다.
// ============================================================================

const EV_LIMITUP = 53 // i % 53 === 5 → 상한가 마감(+31% · 고가=종가), ===6 → −22% 되돌림
const EV_SURGE = 41 // i % 41 === 8 → 거래대금 서지(+6% · 거래량 8배), ===9 → −6% 되돌림
const EV_GAPUP = 23 // i % 23 === 3 → 갭상승 시초(+4~6%)
const EV_RUN = 67 // i % 67 ∈ [20,25] → 관성 랠리(+3.5%/일 · 거래량 4배), 26·27 → −5%씩 되돌림

/**
 * 합성 일봉 — 주말을 건너뛴 거래일 근사. ⚠️ 이벤트에는 반드시 되돌림을 붙인다 —
 * 급등만 심으면 가격이 발산해 한 주 값이 슬롯 금액을 넘고 매매가 조용히 0건이 된다
 * (shortterm.test.ts에서 실제로 났던 사고 — §0이 그걸 막는다).
 */
function makeBars(seed: number, fromYear: number, toYear: number, base = 8_000): DailyBar[] {
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
    const mRun = i % EV_RUN
    if (i % EV_LIMITUP === 5) {
      o = p * 1.1
      c = p * 1.31
      h = c
      l = o * 0.98
      v = AVG_V * (2 + rnd())
    } else if (i % EV_LIMITUP === 6) {
      o = p * 0.95
      c = p * 0.78
      h = o * 1.01
      l = c * 0.99
      v = AVG_V * (1.5 + rnd())
    } else if (i % EV_SURGE === 8) {
      o = p * 1.005
      c = p * 1.06
      h = c * 1.004
      l = o * 0.995
      v = AVG_V * 8
    } else if (i % EV_SURGE === 9) {
      o = p * 0.99
      c = p * 0.94
      h = o * 1.005
      l = c * 0.995
      v = AVG_V * 2
    } else if (i % EV_GAPUP === 3) {
      o = p * (1 + LEADER_GAP_PCT / 100 + 0.01 + rnd() * 0.02)
      c = p * (1 + (rnd() - 0.5) * 0.02)
      h = Math.max(o, c) * 1.01
      l = Math.min(o, c) * 0.99
      v = AVG_V * (0.8 + rnd())
    } else if (mRun >= 20 && mRun <= 25) {
      o = p * 1.001
      c = p * 1.035
      h = c * 1.004
      l = o * 0.996
      v = AVG_V * 4
    } else if (mRun === 26 || mRun === 27) {
      o = p * 0.995
      c = p * 0.95
      h = o * 1.004
      l = c * 0.996
      v = AVG_V * 2
    } else {
      o = p * (1 + (rnd() - 0.5) * 0.01)
      c = Math.max(1, p * (1 + 0.0002 + 0.02 * (rnd() * 2 - 1)))
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
/** 2016~2018 — 상한폭 ±30% 신제도 구간. 시작가는 슬롯(100만) 대비 충분히 낮게. */
const HISTORIES: Record<string, DailyBar[]> = {}
SYMS.forEach((s, k) => {
  HISTORIES[s] = makeBars(1000 + k * 37, 2016, 2018, 5_000 + k * 1_500)
})
const START = '2016-01-01'

/** 전 기간 전 종목 유니버스 — 측정일이 시작 전(2015-12-01)이라 첫날부터 적용된다. */
const PU_ALL: PreparedUniverse = { dates: ['2015-12-01'], sets: [new Set(SYMS)] }

function truncate(h: Record<string, DailyBar[]>, cutDate: string): Record<string, DailyBar[]> {
  const out: Record<string, DailyBar[]> = {}
  for (const [k, v] of Object.entries(h)) out[k] = v.filter((b) => b.date <= cutDate)
  return out
}

/** 진입봉 `idx` 이후(포함)를 극단값으로 — keepOpen이면 진입봉 **시가만** 원본을 남긴다. */
function corruptFrom(bars: DailyBar[], idx: number, keepOpen = false): DailyBar[] {
  return bars.map((b, j) => {
    if (j < idx) return b
    const w = { ...b, o: 9.99e8, h: 9.99e8, l: 1e-6, c: 9.99e8, v: 9.99e11 }
    if (j === idx && keepOpen) w.o = b.o
    return w
  })
}

const PLANS = leaderPlans()
const planOf = (key: string): LeaderPlan => {
  const p = PLANS.find((x) => x.key === key)
  if (!p) throw new Error(`plan ${key} 없음`)
  return p
}

/** 청산·체결 시나리오용 커스텀 플랜(엔진 규약 검증 — 12변형 정의와 무관). */
const mkPlan = (over: Partial<LeaderPlan>): LeaderPlan => ({
  key: 'test',
  label: 'test',
  track: 'A',
  group: 'next',
  scope: 'prevBars',
  entry: { kind: 'open' },
  exit: { holdDays: 1 },
  signal: (_bars, i) => i >= 1,
  note: '',
  ...over,
})

/** 손으로 짠 시나리오 한 종목(AAA). 2016년(신제도) 구간. */
function scenario(rows: [string, number, number, number, number, number][]): Record<string, DailyBar[]> {
  return { AAA: rows.map(([date, o, h, l, c, v], i) => ({ date, t: i, o, h, l, c, v })) }
}
const dday = (n: number) => `2016-0${Math.floor((n - 1) / 28) + 1}-${String(((n - 1) % 28) + 1).padStart(2, '0')}`
const PU_AAA: PreparedUniverse = { dates: ['2015-12-31'], sets: [new Set(['AAA'])] }

// ── 0) 픽스처 건전성 — "아무것도 안 도는데 통과"를 막는다 ────────────────────
{
  section('0) 합성 픽스처 건전성 — 가격 발산으로 매매가 0건이 되는 것을 막는다')

  const slot = COST.initialCapital / LEADER_SLOTS
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
    check(
      `${s}: OHLC 정합(고가 ≥ max(시,종) · 저가 ≤ min(시,종))`,
      bars.every((b) => b.h >= Math.max(b.o, b.c) - 1e-9 && b.l <= Math.min(b.o, b.c) + 1e-9),
    )
  }
}

// ── 1) 변형 정의 — 12 고정 · 그룹 분포 · 비용 상수 정합 ──────────────────────
{
  section('1) 변형 정의 — 12 고정 · 트랙/그룹 분포 · 비용 상수 정합')

  eq('변형 수 = LEADER_VARIANT_COUNT', PLANS.length, LEADER_VARIANT_COUNT)
  eq('LEADER_VARIANT_COUNT = 12 (다중검정 분모)', LEADER_VARIANT_COUNT, 12)
  eq('key 중복 없음', new Set(PLANS.map((p) => p.key)).size, PLANS.length)
  const byGroup: Record<LeaderGroup, number> = { next: 0, gap: 0, vbrk: 0, persist: 0 }
  for (const p of PLANS) byGroup[p.group]++
  eq('트랙 A(next) 4변형', byGroup.next, 4)
  eq('트랙 B 갭(gap) 2변형', byGroup.gap, 2)
  eq('트랙 B 돌파(vbrk) 2변형', byGroup.vbrk, 2)
  eq('트랙 C(persist) 4변형', byGroup.persist, 4)
  check('그룹 라벨이 전 그룹을 덮는다', (Object.keys(GROUP_LABEL) as LeaderGroup[]).every((g) => byGroup[g] > 0))

  // 트랙 A·C는 prevBars, 트랙 B는 prevBarsPlusOpen — 스코프가 곧 규칙 1 계약이다.
  for (const p of PLANS)
    eq(
      `${p.key}: scope가 트랙과 일치`,
      p.scope,
      p.track === 'B' ? 'prevBarsPlusOpen' : 'prevBars',
    )

  // 비용은 shortterm-lab과 **같은 상수**를 재사용한다(표가 나란히 읽혀야 한다).
  eq('수수료 동일', SHORT_COST.feePct, COST.feePct)
  eq('거래세 동일', SHORT_COST.taxPct, COST.taxPct)
  eq('슬리피지 동일', SHORT_COST.slippagePct, COST.slippagePct)
  eq('COST_2X 수수료 = 2×', COST_2X.feePct, COST.feePct * 2)
  eq('COST_2X 거래세 = 2×', COST_2X.taxPct, COST.taxPct * 2)
  eq('COST_2X 슬리피지 = 2×', COST_2X.slippagePct, COST.slippagePct * 2)
  eq('COST_2X 자본은 그대로', COST_2X.initialCapital, COST.initialCapital)
  eq('슬롯 = MAX_POSITIONS', LEADER_SLOTS, MAX_POSITIONS)
  eq('표본 판정선 = SCREEN_MIN_TRADES', LEADER_MIN_TRADES, SCREEN_MIN_TRADES)
}

// ── 2) 시가 상한가 판정 산술 — 제도 경계(2015-06-15 ±15→±30) ─────────────────
{
  section('2) 시가 상한가 판정 — 갭 산술 · 제도 경계')

  const mk = (date: string, prevC: number, o: number): DailyBar[] => [
    { date: '2000-01-01', t: 0, o: prevC, h: prevC, l: prevC, c: prevC, v: 1 },
    { date, t: 1, o, h: o * 1.01, l: o * 0.99, c: o, v: 1 },
  ]
  closeTo('갭 산술: 10000 → 10400 시가 = +4%', gapPct(mk('2016-01-05', 10000, 10400), 1)!, 4, 1e-9)
  eq('갭: 첫 봉은 null(전일이 없다)', gapPct(mk('2016-01-05', 10000, 10400), 0), null)
  eq('신제도(2016): +30% 시가 = 상한가 → 스킵 대상', isLimitUpOpen(mk('2016-01-05', 10000, 13000), 1), true)
  eq('신제도(2016): +20% 시가는 상한가 아님', isLimitUpOpen(mk('2016-01-05', 10000, 12000), 1), false)
  eq('구제도(2014): +15% 시가 = 상한가', isLimitUpOpen(mk('2014-01-05', 10000, 11500), 1), true)
  eq('구제도(2014): +14% 시가는 상한가 아님', isLimitUpOpen(mk('2014-01-05', 10000, 11400), 1), false)
  eq('경계일(2015-06-15)부터 신제도: +15%는 상한가 아님', isLimitUpOpen(mk('2015-06-15', 10000, 11500), 1), false)
}

// ── 3) 지표 산술 — 롤링은 전부 당일 제외(규칙 1-3) ───────────────────────────
{
  section('3) 지표 산술 — 거래대금 롤링·극값은 전부 당일 제외')

  // c = i+1, v = 1 → tv[i] = i+1. 손으로 계산 가능한 사다리.
  const bars: DailyBar[] = []
  for (let i = 0; i < 40; i++) {
    const c = i + 1
    bars.push({ date: `2016-01-${String(i + 1).padStart(2, '0')}`, t: i, o: c, h: c, l: c, c, v: 1 })
  }
  const aux = buildLeaderAux(bars)
  closeTo('avgTv20[25] = mean(tv[5..24]) = 15.5 (당일 제외)', aux.avgTv20[25]!, 15.5, 1e-9)
  eq('avgTv20[19] = null (표본 부족)', aux.avgTv20[19], null)
  closeTo('sum5Tv[25] = tv[20..24] 합 = 115', aux.sum5Tv[25]!, 115, 1e-9)
  closeTo('avgTvPrior20[25] = mean(tv[0..19]) = 10.5', aux.avgTvPrior20[25]!, 10.5, 1e-9)
  closeTo('maxC20[25] = max(c[5..24]) = 25 (당일 26 제외)', aux.maxC20[25]!, 25, 1e-9)
  closeTo('maxH20[25] = max(h[5..24]) = 25', aux.maxH20[25]!, 25, 1e-9)

  // 서지 판정: D−1(인덱스 30)에 거래량 폭증 + 등락률 — 진입은 인덱스 31.
  const sb = bars.map((b) => ({ ...b }))
  sb[30] = { ...sb[30], c: sb[29].c * (1 + LEADER_CHG_PCT / 100 + 0.01), v: 100 } // tv ≈ 31.8×100
  const sAux = buildLeaderAux(sb)
  eq('전일 서지+등락 → A1 신호 참', isPrevDaySurge(sb, 31, sAux), true)
  eq('평상시 → A1 신호 거짓', isPrevDaySurge(bars, 31, aux), false)
  // 등락률 미달이면 거짓(서지만으로는 부족).
  const sb2 = bars.map((b) => ({ ...b }))
  sb2[30] = { ...sb2[30], c: sb2[29].c * 1.01, v: 100 }
  eq('서지만 있고 등락률 미달 → 거짓', isPrevDaySurge(sb2, 31, buildLeaderAux(sb2)), false)

  // 돌파: 사다리는 매일 신고 종가라 항상 참 — 전일이 직전 20일 최고 종가보다 높다.
  eq('전일 종가가 직전 20일 최고 종가 돌파', brokePrevMaxClose(bars, 31, aux), true)
  const flat = bars.map((b) => ({ ...b, o: 10, h: 10, l: 10, c: 10 }))
  eq('평평한 시세는 돌파 아님(같음은 돌파가 아니다)', brokePrevMaxClose(flat, 31, buildLeaderAux(flat)), false)

  // 관성: 직전 5일 거래대금을 키우고 신고가 근접을 만들면 참.
  const pb = bars.map((b) => ({ ...b }))
  for (let j = 26; j <= 30; j++) pb[j] = { ...pb[j], v: 20 } // 5일 합 ≈ 20×평균 ≫ 2×
  const pAux = buildLeaderAux(pb)
  eq('5일 누적 서지 + 신고가 근접 → C1 신호 참', isPersistentLeader(pb, 31, pAux), true)
  eq('평상시 → C1 신호 거짓', isPersistentLeader(bars, 31, aux), false)
  check('임계 상수 정합(서지 3배·근접 90%·관성 2배)', LEADER_SURGE_MULT === 3 && LEADER_NEARHIGH_PCT === 90 && LEADER_PERSIST_MULT === 2)

  // 변동성 돌파 트리거 = 시가 + k×전일(고−저).
  const vb: DailyBar[] = [
    { date: '2016-01-04', t: 0, o: 10000, h: 10200, l: 9800, c: 10000, v: 1 },
    { date: '2016-01-05', t: 1, o: 10100, h: 10400, l: 10000, c: 10300, v: 1 },
  ]
  closeTo(`트리거 k=${LEADER_VBRK_K1}: 10100 + 0.5×400 = 10300`, vbrkTrigger(vb, 1, LEADER_VBRK_K1)!, 10300, 1e-9)
  closeTo(`트리거 k=${LEADER_VBRK_K2}: 10100 + 0.3×400 = 10220`, vbrkTrigger(vb, 1, LEADER_VBRK_K2)!, 10220, 1e-9)
  eq('첫 봉 트리거는 null', vbrkTrigger(vb, 0, LEADER_VBRK_K1), null)

  // 연도별 분해 산술.
  const py = perYearFromCurve([
    { date: '2016-06-30', equity: 1 },
    { date: '2016-12-29', equity: 1.1 },
    { date: '2017-06-30', equity: 1.32 },
    { date: '2017-12-28', equity: 1.21 },
  ])
  eq('perYear 연도 수', py.length, 2)
  closeTo('2016 수익 ×1.1', py[0].ret, 1.1, 1e-9)
  closeTo('2017 수익 ×1.1 (1.21/1.1)', py[1].ret, 1.1, 1e-9)
}

// ── 4) 신호 미래맹목성 — 진입봉 이후를 극단값으로 바꿔도 신호가 같아야 한다 ──
{
  section('4) 신호 미래맹목성 — 진입봉 이후 오염에도 신호 불변')

  // 절단 불변성은 "잘라낸 뒤"를 본다. 이 테스트는 **봉이 거기 있는데도 안 보는지**를 본다.
  // 트랙 B는 진입봉 **시가만** 남기고 나머지(고·저·종·거래량)를 오염시킨다 — 시가 외의
  // 당일 정보에 의존하면 여기서 걸린다. aux도 오염된 배열에서 다시 계산한다(사전계산 누수 검출).
  for (const plan of PLANS) {
    let diff = 0
    let fired = 0
    for (const s of SYMS) {
      const bars = HISTORIES[s]
      const auxFull = buildLeaderAux(bars)
      for (let i = 30; i < bars.length - 1; i++) {
        const a = plan.signal(bars, i, auxFull)
        const cor = corruptFrom(bars, i, plan.scope === 'prevBarsPlusOpen')
        const b = plan.signal(cor, i, buildLeaderAux(cor))
        if (a !== b) diff++
        if (a) fired++
      }
    }
    eq(`${plan.key}: 진입봉 이후 오염에도 신호 불변`, diff, 0)
    check(`${plan.key}: 신호가 실제로 발생한다(공허한 통과 방지) — ${fired}회`, fired > 0)
  }
}

// ── 5) 🚫 절단 불변성 — 트랙 A·B·C 각각 (규칙 1 집행자) ──────────────────────
{
  section('5) 절단 불변성 — 12변형 전부(트랙 A·B·C), 잘린 시점 이전의 매매·자산곡선 완전 동일')

  const CUT = '2017-06-30'
  for (const plan of PLANS) {
    const full = simulateLeader(HISTORIES, SYMS, COST, plan, PU_ALL, undefined, START)
    const cutHist = truncate(HISTORIES, CUT)
    const cut = simulateLeader(cutHist, SYMS, COST, plan, PU_ALL, undefined, START)

    // 잘린 쪽의 마지막 봉은 신규 진입을 만들지 않는다(규칙 1-6) — 경계 한 칸 앞까지 비교.
    const lastDate = cut.equity.length ? cut.equity[cut.equity.length - 1].date : CUT
    const cmp = (e: { date: string }) => e.date < lastDate

    const fe = full.equity.filter(cmp)
    const ce = cut.equity.filter(cmp)
    eq(`[트랙${plan.track}] ${plan.key}: 자산곡선 길이 동일`, ce.length, fe.length)
    let bad = 0
    for (let i = 0; i < Math.min(fe.length, ce.length); i++) {
      if (fe[i].date !== ce[i].date || fe[i].equity !== ce[i].equity) bad++
    }
    eq(`[트랙${plan.track}] ${plan.key}: 자산곡선 값 완전 동일`, bad, 0)

    const sig = (f: { date: string; sym: string; side: string; px: number; qty: number; signalDate: string }) =>
      `${f.date}/${f.sym}/${f.side}/${f.px}/${f.qty}/${f.signalDate}`
    const ff = full.fills.filter(cmp)
    const cf = cut.fills.filter(cmp)
    eq(`[트랙${plan.track}] ${plan.key}: 체결 건수 동일`, cf.length, ff.length)
    eq(`[트랙${plan.track}] ${plan.key}: 체결 원장 완전 동일`, cf.map(sig).join('|'), ff.map(sig).join('|'))
    check(`[트랙${plan.track}] ${plan.key}: 절단 전 구간에 체결이 있다(공허한 통과 방지)`, ff.length > 0, `${ff.length}건`)
  }
}

// ── 6) 신호 → 체결 분리 · 마지막 봉 진입 금지 · 피라미딩 · 슬롯 상한 ─────────
{
  section('6) 신호 → 체결 분리 · 마지막 봉 진입 금지 · 피라미딩 금지 · 슬롯 상한')

  for (const plan of PLANS) {
    const r = simulateLeader(HISTORIES, SYMS, COST, plan, PU_ALL, undefined, START)
    const buys = r.fills.filter((f) => f.side === 'buy')
    check(`${plan.key}: 매수 체결이 있다`, buys.length > 0, `${buys.length}건`)

    if (plan.scope === 'prevBars') {
      eq(
        `${plan.key}: 모든 매수의 신호일 < 체결일 (당일 정보로 당일 체결하지 않는다)`,
        buys.filter((f) => !(f.signalDate < f.date)).length,
        0,
      )
    } else {
      eq(`${plan.key}: 트랙 B의 신호일 = 체결일 (미래일은 없다)`, buys.filter((f) => f.signalDate !== f.date).length, 0)
    }

    const lastDate = r.equity[r.equity.length - 1].date
    eq(`${plan.key}: 마지막 봉에 신규 매수 없음`, buys.filter((f) => f.date === lastDate).length, 0)

    const tail = r.equity[Math.floor(r.equity.length * 0.7)].date
    check(`${plan.key}: 구간 후반(70% 이후)에도 매수가 있다`, buys.some((f) => f.date >= tail), `${buys.length}건`)

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
    check(`${plan.key}: 동시 보유 ≤ ${LEADER_SLOTS}슬롯`, maxHeld <= LEADER_SLOTS, `최대 ${maxHeld}`)
  }
}

// ── 7) 청산 보수성 — 손절 갭 관통 시가 · 손절 우선 · 트레일 인과성 · 돌파 체결가 ─
{
  section('7) 청산 보수성 — 갭 관통 시가 체결 · 손절 우선 · 트레일 고점 인과성')

  // (a) 장중 손절 터치 → 손절가 체결. 진입 다음 날 저가가 손절선을 스친다.
  {
    const hist = scenario([
      [dday(1), 10000, 10100, 9900, 10000, 1000],
      [dday(2), 10000, 10100, 9900, 10050, 1000], // 진입(시가 10000) · 손절 3% → 9700
      [dday(3), 9900, 9950, 9600, 9800, 1000], // 저가 9600 ≤ 9700, 시가 9900 > 9700 → 9700 체결
      [dday(4), 9800, 9850, 9750, 9800, 1000],
      [dday(5), 9800, 9850, 9750, 9800, 1000],
    ])
    const r = simulateLeader(hist, ['AAA'], COST, mkPlan({ exit: { holdDays: 5, stopPct: 3 } }), PU_AAA)
    const sell = r.fills.find((f) => f.side === 'sell')
    check('(a) 손절 매도가 있다', sell != null)
    if (sell) {
      eq('(a) 손절 체결일 = 터치일', sell.date, dday(3))
      closeTo('(a) 체결가 = 손절가 9700 (터치 시 기준가)', sell.px, 9700, 1e-9)
    }
  }

  // (b) 갭으로 손절선을 관통 → 기준가가 아니라 **시가**(더 불리한 쪽) 체결.
  {
    const hist = scenario([
      [dday(1), 10000, 10100, 9900, 10000, 1000],
      [dday(2), 10000, 10100, 9900, 10050, 1000], // 진입 10000 · 손절선 9700
      [dday(3), 9300, 9350, 9200, 9300, 1000], // 시가 9300 < 9700 (갭 관통)
      [dday(4), 9300, 9350, 9250, 9300, 1000],
      [dday(5), 9300, 9350, 9250, 9300, 1000],
    ])
    const r = simulateLeader(hist, ['AAA'], COST, mkPlan({ exit: { holdDays: 5, stopPct: 3 } }), PU_AAA)
    const sell = r.fills.find((f) => f.side === 'sell')
    check('(b) 손절 매도가 있다', sell != null)
    if (sell) closeTo('(b) 갭 관통 체결가 = 시가 9300 (기준가 9700이 아니다)', sell.px, 9300, 1e-9)
  }

  // (c) 손절과 예약 종가 청산이 같은 날 → **손절 먼저**(종가가 아니라 손절가로 남는다).
  {
    const hist = scenario([
      [dday(1), 10000, 10100, 9900, 10000, 1000],
      [dday(2), 10000, 10100, 9900, 10050, 1000], // 진입 · holdDays 2 → dday(3) 종가 예약
      [dday(3), 9900, 10400, 9600, 10300, 1000], // 저가가 손절선 9700 터치 + 예약 종가일
      [dday(4), 10300, 10350, 10250, 10300, 1000],
    ])
    const r = simulateLeader(hist, ['AAA'], COST, mkPlan({ exit: { holdDays: 2, stopPct: 3 } }), PU_AAA)
    const sell = r.fills.find((f) => f.side === 'sell')
    check('(c) 매도가 있다', sell != null)
    if (sell) closeTo('(c) 같은 날 손절·종가청산 → 손절가 9700 체결(종가 10300 아님)', sell.px, 9700, 1e-9)
  }

  // (d) 트레일링 — 고점은 **전일까지의 종가**. 진입 당일은 고점이 없어 판정하지 않는다
  //     (당일 종가로 당일 저가를 판정하면 봉 내부 미래참조다).
  {
    const hist = scenario([
      [dday(1), 10000, 10100, 9900, 10000, 1000],
      [dday(2), 10000, 10600, 9950, 10500, 1000], // 진입 · 당일 저가 9950: 당일 종가(10500) 고점으로 판정하면 9975 터치 → 오답
      [dday(3), 10400, 10450, 10100, 10400, 1000], // 트레일 = 10500×0.95 = 9975 · 저가 10100 > 9975 → 보유
      [dday(4), 9900, 9950, 9800, 9900, 1000], // 시가 9900 < 9975 (갭 관통) → 시가 체결
      [dday(5), 9900, 9950, 9850, 9900, 1000],
    ])
    const r = simulateLeader(hist, ['AAA'], COST, mkPlan({ exit: { holdDays: 10, trailPct: LEADER_TRAIL_PCT } }), PU_AAA)
    const sells = r.fills.filter((f) => f.side === 'sell')
    eq('(d) 진입 당일 트레일 발동 없음(고점 인과성)', sells.filter((f) => f.date === dday(2)).length, 0)
    check('(d) 트레일 매도가 있다', sells.length > 0)
    if (sells.length) {
      eq('(d) 체결일 = 갭 관통일', sells[0].date, dday(4))
      closeTo('(d) 갭 관통 체결가 = 시가 9900 (트레일가 9975가 아니다)', sells[0].px, 9900, 1e-9)
    }
  }

  // (e) 트레일 장중 터치(관통 아님) → 트레일가 체결.
  {
    const hist = scenario([
      [dday(1), 10000, 10100, 9900, 10000, 1000],
      [dday(2), 10000, 10600, 9950, 10500, 1000], // 진입 · 고점(종가) 10500
      [dday(3), 10100, 10150, 9900, 10000, 1000], // 저가 9900 ≤ 9975 · 시가 10100 > 9975 → 9975 체결
      [dday(4), 10000, 10050, 9950, 10000, 1000],
    ])
    const r = simulateLeader(hist, ['AAA'], COST, mkPlan({ exit: { holdDays: 10, trailPct: LEADER_TRAIL_PCT } }), PU_AAA)
    const sell = r.fills.find((f) => f.side === 'sell')
    check('(e) 트레일 매도가 있다', sell != null)
    if (sell) closeTo('(e) 장중 터치 체결가 = 트레일가 10500×0.95', sell.px, 10500 * 0.95, 1e-9)
  }

  // (f) B2 — 당일 왕복의 장중 손절: 시가×0.97 터치 → 손절가, 미터치 → 종가.
  {
    const gapStop = planOf('gap-stop')
    const touch = scenario([
      [dday(1), 10000, 10100, 9900, 10000, 1000],
      [dday(2), 10400, 10450, 10050, 10200, 1000], // 갭 +4% 진입 · 손절 10400×0.97=10088 · 저가 10050 터치
      [dday(3), 10200, 10250, 10150, 10200, 1000],
    ])
    const r1 = simulateLeader(touch, ['AAA'], COST, gapStop, PU_AAA)
    const s1 = r1.fills.find((f) => f.side === 'sell')
    check('(f) B2 손절 매도가 있다', s1 != null)
    if (s1) closeTo('(f) 체결가 = 시가×0.97', s1.px, 10400 * (1 - LEADER_B2_STOP_PCT / 100), 1e-9)
    const hold = scenario([
      [dday(1), 10000, 10100, 9900, 10000, 1000],
      [dday(2), 10400, 10450, 10150, 10250, 1000], // 저가 10150 > 10088 → 종가 청산
      [dday(3), 10250, 10300, 10200, 10250, 1000],
    ])
    const r2 = simulateLeader(hold, ['AAA'], COST, gapStop, PU_AAA)
    const s2 = r2.fills.find((f) => f.side === 'sell')
    check('(f) 미터치면 매도가 있다', s2 != null)
    if (s2) closeTo('(f) 미터치 → 당일 종가 체결', s2.px, 10250, 1e-9)
  }

  // (g) B3 — 돌파 체결가 = max(시가, 트리거)(불리한 쪽) · 미터치면 미체결.
  {
    const vbrk = planOf('vbrk-05')
    const touch = scenario([
      [dday(1), 10000, 10200, 9800, 10000, 1000], // 전일 범위 400 → 트리거 = 시가+200
      [dday(2), 10100, 10350, 10050, 10250, 1000], // 트리거 10300 ≤ 고가 10350 → 10300 체결
      [dday(3), 10250, 10300, 10200, 10250, 1000],
    ])
    const r1 = simulateLeader(touch, ['AAA'], COST, vbrk, PU_AAA)
    const b1 = r1.fills.find((f) => f.side === 'buy')
    check('(g) 돌파 매수가 있다', b1 != null)
    if (b1) closeTo('(g) 체결가 = 트리거 10300 (시가 10100이 아니다)', b1.px, 10300, 1e-9)
    const miss = scenario([
      [dday(1), 10000, 10200, 9800, 10000, 1000],
      [dday(2), 10100, 10250, 10050, 10200, 1000], // 고가 10250 < 트리거 10300 → 미체결
      [dday(3), 10200, 10250, 10150, 10200, 1000],
    ])
    const r2 = simulateLeader(miss, ['AAA'], COST, vbrk, PU_AAA)
    eq('(g) 미터치면 매수 없음(주문 미체결)', r2.fills.filter((f) => f.side === 'buy' && f.date === dday(2)).length, 0)
  }
}

// ── 8) 시가 상한가 스킵 — 상한가 시가는 체결이 안 잡힌다 ─────────────────────
{
  section('8) 시가 상한가 스킵 — 신호가 참이어도 매수하지 않고 스킵으로 센다')

  const b1 = planOf('gap-1d')
  const hist = scenario([
    [dday(1), 10000, 10100, 9900, 10000, 1000],
    [dday(2), 13100, 13200, 13000, 13100, 1000], // 갭 +31% ≥ 임계 29.5 → 신호(≥3%)는 참, 매수 불가
    [dday(3), 13100, 13200, 13000, 13100, 1000],
  ])
  const r = simulateLeader(hist, ['AAA'], COST, b1, PU_AAA)
  eq('상한가 시가엔 매수 없음', r.fills.filter((f) => f.side === 'buy' && f.date === dday(2)).length, 0)
  check('스킵 카운트에 잡힌다(조용히 사라지지 않는다)', r.skippedLimitUpOpen >= 1, `${r.skippedLimitUpOpen}`)

  // 상한가 미만 갭은 정상 매수 — 스킵 규칙이 과잉 차단하지 않는지 대조.
  const ok = scenario([
    [dday(1), 10000, 10100, 9900, 10000, 1000],
    [dday(2), 10500, 10600, 10400, 10500, 1000], // 갭 +5% → 정상 진입
    [dday(3), 10500, 10600, 10400, 10500, 1000],
  ])
  const r2 = simulateLeader(ok, ['AAA'], COST, b1, PU_AAA)
  eq('상한가 미만 갭은 매수된다', r2.fills.filter((f) => f.side === 'buy' && f.date === dday(2)).length, 1)
  eq('그 경우 스킵 카운트 0', r2.skippedLimitUpOpen, 0)
}

// ── 9) 슬롯·타이브레이크 결정성 — 전일 거래대금 내림차순 · 동점 코드 오름차순 ─
{
  section('9) 슬롯 배분 — 전일 거래대금 내림차순 · 동점은 코드 오름차순 · 결정적')

  const syms12 = Array.from({ length: 12 }, (_, k) => `10${String(k + 1).padStart(2, '0')}00`)
  const hist: Record<string, DailyBar[]> = {}
  syms12.forEach((s, k) => {
    // 전일 거래대금 = 10000 × v. k가 작을수록 크게 — 단 k=9와 k=10은 **동점**으로 만든다.
    const v = k === 9 || k === 10 ? 3000 : (12 - k) * 1000
    hist[s] = [
      { date: '2016-03-02', t: 0, o: 10000, h: 10100, l: 9900, c: 10000, v },
      { date: '2016-03-03', t: 1, o: 10400, h: 10450, l: 10350, c: 10400, v: 1000 }, // 전원 갭 +4%
      { date: '2016-03-04', t: 2, o: 10400, h: 10450, l: 10350, c: 10400, v: 1000 },
    ]
  })
  const pu: PreparedUniverse = { dates: ['2016-01-04'], sets: [new Set(syms12)] }
  const b1 = planOf('gap-1d')
  const r = simulateLeader(hist, syms12, COST, b1, pu, undefined, '2016-01-01')
  const buys = r.fills.filter((f) => f.side === 'buy' && f.date === '2016-03-03').map((f) => f.sym)
  eq(`슬롯만큼만 산다 (${LEADER_SLOTS})`, buys.length, LEADER_SLOTS)
  // 후보 12 중 거래대금 하위 2개가 탈락해야 한다: 동점(k=9 '101000', k=10 '101100')은
  // 코드 오름차순으로 '101000'이 선발되고 '101100'과 k=11('101200')이 탈락.
  const expected = [...syms12.slice(0, 9), syms12[9]]
  eq('선발 = 거래대금 상위 10 (동점은 코드 오름차순)', [...buys].sort().join(','), [...expected].sort().join(','))
  check('탈락 = 동점 후순위 코드와 최하위', !buys.includes(syms12[10]) && !buys.includes(syms12[11]))
  // 매수 순서 자체도 정렬 순서를 따른다(결정성) — 거래대금 내림차순.
  eq('체결 순서 = 거래대금 내림차순·코드 오름차순', buys.join(','), expected.join(','))
  // 같은 입력 → 같은 출력(전 구간 결정성).
  const r2 = simulateLeader(hist, syms12, COST, b1, pu, undefined, '2016-01-01')
  eq('재실행 시 체결 원장 완전 동일(결정성)', JSON.stringify(r.fills), JSON.stringify(r2.fills))
}

// ── 10) 비용 산술 — 수수료·거래세·슬리피지 왕복이 손으로 계산한 값과 같다 ─────
{
  section('10) 비용 산술 — 왕복 1회의 현금 흐름을 손으로 재계산해 대조')

  const hist = scenario([
    [dday(1), 10000, 10100, 9900, 10000, 1000],
    [dday(2), 10000, 10600, 9950, 10500, 1000], // 진입 시가 10000 → 당일 종가 10500 청산
    [dday(3), 10500, 10600, 10400, 10500, 1000],
  ])
  const r = simulateLeader(hist, ['AAA'], COST, mkPlan({ exit: { holdDays: 1 } }), PU_AAA)
  const buy = r.fills.find((f) => f.side === 'buy' && f.date === dday(2))
  const sell = r.fills.find((f) => f.side === 'sell' && f.date === dday(2))
  check('왕복이 있다', buy != null && sell != null)
  if (buy && sell) {
    // 매수: 체결 = 기준가×(1+슬리피지), 수량 = floor(예산 ÷ (체결×(1+수수료))), 현금 −= 총액+수수료
    const slot = COST.initialCapital / LEADER_SLOTS
    const bFill = 10000 * (1 + COST.slippagePct / 100)
    const qty = Math.floor(slot / (bFill * (1 + COST.feePct / 100)))
    eq('매수 수량 = 산식과 일치', buy.qty, qty)
    const bGross = qty * bFill
    const bFee = bGross * (COST.feePct / 100)
    // 매도: 체결 = 기준가×(1−슬리피지), 순수령 = 총액×(1−수수료−거래세)
    const sFill = 10500 * (1 - COST.slippagePct / 100)
    const sGross = qty * sFill
    const sNet = sGross - sGross * ((COST.feePct + COST.taxPct) / 100)
    const expectedCash = COST.initialCapital - bGross - bFee + sNet
    const finalEq = r.equity[r.equity.length - 1].equity
    closeTo('왕복 후 총자산 = 손계산 현금과 일치', finalEq, expectedCash, 1e-6)
    check('비용이 실제로 차감됐다(공짜 왕복 아님)', expectedCash < COST.initialCapital + qty * 500)
  }

  // 같은 왕복을 비용 0으로 돌리면 정확히 (10500−10000)×수량만큼 남는다.
  const free: CostSettings = { initialCapital: COST.initialCapital, feePct: 0, taxPct: 0, slippagePct: 0 }
  const rf = simulateLeader(hist, ['AAA'], free, mkPlan({ exit: { holdDays: 1 } }), PU_AAA)
  const fBuy = rf.fills.find((f) => f.side === 'buy')
  if (fBuy) {
    const gain = fBuy.qty * 500
    closeTo('비용 0 왕복 손익 = 가격차×수량', rf.equity[rf.equity.length - 1].equity, free.initialCapital + gain, 1e-6)
  }
  // toChain 정규화 — 시작 자본으로 나눈 배수 곡선.
  const chain = toChain(r, COST.initialCapital)
  closeTo('toChain 시작 배수 ≈ 1', chain.equity[0].equity, r.equity[0].equity / COST.initialCapital, 1e-12)
}

// ── 11) 월별 유니버스 인과성 — 측정일 당일엔 그 달 목록을 쓰지 않는다 ─────────
{
  section('11) 월별 유니버스 — 측정일 당일 미사용(엄격 부등호) · 유니버스 밖 종목 미매수')

  const pu: PreparedUniverse = {
    dates: ['2016-03-02', '2016-04-01'],
    sets: [new Set(['AAA']), new Set(['BBB'])],
  }
  eq('측정일 전엔 유니버스 없음', universeAt(pu, '2016-03-01'), null)
  eq('측정일 **당일**에도 그 달 목록을 쓰지 않는다(시총이 그날 종가다 — 규칙 1)', universeAt(pu, '2016-03-02'), null)
  check('측정일 다음 날부터 적용', universeAt(pu, '2016-03-03')?.has('AAA') === true)
  check('다음 달 측정일 당일엔 아직 전월 목록', universeAt(pu, '2016-04-01')?.has('AAA') === true)
  check('다음 달 측정일 다음 날부터 교체', universeAt(pu, '2016-04-02')?.has('BBB') === true)
  check('교체 후 전월 종목은 빠진다', universeAt(pu, '2016-04-02')?.has('AAA') === false)

  // 시뮬 수준: 유니버스 개시(측정일) **이전·당일** 매수가 없어야 한다.
  const gate: PreparedUniverse = { dates: ['2016-06-01'], sets: [new Set(['000100'])] }
  const b1 = planOf('gap-1d')
  const r = simulateLeader({ '000100': HISTORIES['000100'] }, ['000100'], COST, b1, gate, undefined, START)
  const buys = r.fills.filter((f) => f.side === 'buy')
  check('개시 후 매수가 있다(공허한 통과 방지)', buys.length > 0, `${buys.length}건`)
  eq('개시일(측정일) 이전·당일 매수 0건', buys.filter((f) => f.date <= '2016-06-01').length, 0)

  // 유니버스 밖 종목은 신호가 참이어도 사지 않는다.
  const only100: PreparedUniverse = { dates: ['2015-12-01'], sets: [new Set(['000100'])] }
  const r2 = simulateLeader(HISTORIES, SYMS, COST, b1, only100, undefined, START)
  eq('유니버스 밖 종목 매수 0건', r2.fills.filter((f) => f.side === 'buy' && f.sym !== '000100').length, 0)
}

finish()
