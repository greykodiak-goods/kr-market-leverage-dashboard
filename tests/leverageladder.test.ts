// 동적 레버리지 사다리 — 규칙 1(미래참조 금지) 집행 테스트.
//
// 이 파일이 통과하지 못하면 사다리 엔진의 어떤 수치도 믿을 수 없다.
// 핵심은 두 가지 불변성이다:
//   ① 절단 불변성 — 뒷부분을 잘라내고 다시 돌려도 잘린 시점 **이전**의 매매·자산곡선이 동일
//   ② 미래 조작 불변성 — 봉 k 이후의 값을 아무리 바꿔도 k 이전 결과가 동일
// 둘 중 하나라도 깨지면 어딘가에서 미래를 본 것이다.

import { check, eq, close, section, finish, rng } from './harness'
import {
  ladderStep,
  runLeverageLadder,
  alignBars,
  synthLeveraged,
  synthTrackingGap,
  DEFAULT_LADDER_PARAMS,
  US_LADDER_COST,
  TRADING_DAYS,
  type LadderParams,
} from '../src/features/backtest/leverageLadder'
import type { DailyBar } from '../src/lib/history'

// ---- 결정적 시세 생성 -------------------------------------------------------

function makeBars(n: number, seed: number, drift = 0.0003, vol = 0.02): DailyBar[] {
  const r = rng(seed)
  const bars: DailyBar[] = []
  let c = 100
  for (let i = 0; i < n; i++) {
    const shock = (r() - 0.5) * 2 * vol + drift
    const prev = c
    c = Math.max(1, prev * (1 + shock))
    const o = prev * (1 + (r() - 0.5) * 0.004)
    const day = new Date(Date.UTC(2005, 0, 3) + i * 86400e3)
    bars.push({
      date: day.toISOString().slice(0, 10),
      t: Math.floor(day.getTime() / 1000),
      o,
      h: Math.max(o, c) * 1.001,
      l: Math.min(o, c) * 0.999,
      c,
      v: 1e6,
    })
  }
  return bars
}

/** 사다리 3종을 합성으로 만들어 축이 정확히 맞는 입력을 구성한다. */
function makeLadderInput(base: DailyBar[]) {
  const qld = synthLeveraged(base, { leverage: 2, expenseAnnualPct: 0.95, financingAnnualPct: 2 })
  const tqqq = synthLeveraged(base, { leverage: 3, expenseAnnualPct: 0.84, financingAnnualPct: 2 })
  return new Map<string, DailyBar[]>([
    ['QQQ', base],
    ['QLD', qld],
    ['TQQQ', tqqq],
  ])
}

const P: LadderParams = { ...DEFAULT_LADDER_PARAMS, stepPct: 20, bufPct: 3 }

// ============================================================================
section('1. 사다리 상태 전이 — 하락은 즉시, 회복은 버퍼를 넘겨야')
// ============================================================================

eq('평시(-0%)는 0칸', ladderStep(0, 0, P), 0)
eq('-19.9%는 아직 0칸', ladderStep(-19.9, 0, P), 0)
eq('-20.0%에서 1칸(경계 포함)', ladderStep(-20, 0, P), 1)
eq('-40.0%에서 2칸', ladderStep(-40, 0, P), 2)
eq('-80%는 사다리 끝(2칸)에서 멈춘다', ladderStep(-80, 0, P), 2)
eq('한 봉에 여러 칸 급락 가능', ladderStep(-45, 0, P), 2)

// 회복 방향 — 버퍼 3%p
eq('1칸에서 -19% 회복은 버퍼 미달로 유지', ladderStep(-19, 1, P), 1)
// 진입은 -20%, 복귀는 -17%(= -20 + 버퍼 3). 즉 **더 많이 회복해야** 올라온다.
eq('1칸에서 -17.1%는 아직 경계 미달(유지)', ladderStep(-17.1, 1, P), 1)
eq('1칸에서 -16.9%면 버퍼(-17.0) 넘겨 0칸 복귀', ladderStep(-16.9, 1, P), 0)
eq('2칸에서 -38%는 유지(버퍼 미달)', ladderStep(-38, 2, P), 2)
eq('2칸에서 -36.9%면 1칸으로', ladderStep(-36.9, 2, P), 1)
eq('2칸에서 V자 반등(-5%)이면 0칸까지 직행', ladderStep(-5, 2, P), 0)

// 버퍼 0이면 경계에서 바로 복귀
const P0: LadderParams = { ...P, bufPct: 0 }
eq('버퍼 0: -19.9%에서 즉시 0칸', ladderStep(-19.9, 1, P0), 0)

check(
  '히스테리시스가 실재한다(같은 낙폭에서 직전 칸에 따라 결과가 다르다)',
  ladderStep(-19, 0, P) === 0 && ladderStep(-19, 1, P) === 1,
)

// ============================================================================
section('2. 🚫 절단 불변성 — 뒤를 잘라내도 앞이 그대로여야 한다')
// ============================================================================

{
  // 낙폭이 실제로 -20%를 여러 번 넘나드는 계열이라야 이 테스트가 헛돌지 않는다
  // (전환 0건짜리 계열로 "동일하다"를 확인하는 것은 아무것도 검증하지 않는 것이다).
  const base = makeBars(1200, 7, -0.0002, 0.028)
  const full = runLeverageLadder(base, alignBars(makeLadderInput(base)), P, US_LADDER_COST)
  check('원본에 전환이 충분히 있다(테스트가 헛돌지 않음)', full.switches.length >= 5, `${full.switches.length}건`)

  for (const cut of [400, 700, 1000]) {
    const cutBase = base.slice(0, cut)
    const cutRun = runLeverageLadder(cutBase, alignBars(makeLadderInput(cutBase)), P, US_LADDER_COST)

    // 자산곡선: 잘린 시점 이전이 완전히 동일해야 한다.
    let curveSame = cutRun.equity.length === cut
    for (let i = 0; i < cutRun.equity.length && curveSame; i++) {
      if (cutRun.equity[i].date !== full.equity[i].date) curveSame = false
      else if (Math.abs(cutRun.equity[i].equity - full.equity[i].equity) > 1e-9) curveSame = false
    }
    check(`절단 ${cut}봉 — 자산곡선 동일`, curveSame)

    // 매매: 마지막 봉 신규 진입 금지(규칙 1-6) 때문에 절단본의 **마지막 봉 전환**은
    // 원본에 있어도 절단본에 없을 수 있다. 그래서 마지막 봉 이전까지를 비교한다.
    const lastDate = cutBase[cutBase.length - 1].date
    const a = cutRun.switches.filter((s) => s.date < lastDate)
    const b = full.switches.filter((s) => s.date < lastDate)
    let switchSame = a.length === b.length
    for (let i = 0; i < a.length && switchSame; i++) {
      if (a[i].date !== b[i].date || a[i].from !== b[i].from || a[i].to !== b[i].to) switchSame = false
    }
    check(`절단 ${cut}봉 — 전환 이력 동일 (${a.length}건)`, switchSame, `절단 ${a.length} vs 원본 ${b.length}`)
    check(`절단 ${cut}봉 — 비교 대상이 비어있지 않다`, a.length > 0, `전환 ${a.length}건`)
  }
}

// ============================================================================
section('3. 🚫 미래 조작 불변성 — 뒤 봉을 바꿔치기해도 앞이 안 변해야 한다')
// ============================================================================

{
  const base = makeBars(900, 11)
  const K = 500
  const tampered = base.map((b, i) =>
    i < K ? b : { ...b, o: b.o * 3, h: b.h * 3, l: b.l * 3, c: b.c * 3 },
  )

  const orig = runLeverageLadder(base, alignBars(makeLadderInput(base)), P, US_LADDER_COST)
  const tamp = runLeverageLadder(tampered, alignBars(makeLadderInput(tampered)), P, US_LADDER_COST)

  let same = true
  for (let i = 0; i < K; i++) {
    if (Math.abs(orig.equity[i].equity - tamp.equity[i].equity) > 1e-9) {
      same = false
      break
    }
  }
  check(`봉 ${K} 이후를 3배로 조작해도 그 이전 자산곡선 불변`, same)

  const oa = orig.switches.filter((s) => s.date < base[K].date)
  const ta = tamp.switches.filter((s) => s.date < base[K].date)
  check('조작 이전 구간 전환 이력 불변', oa.length === ta.length && oa.every((s, i) => s.date === ta[i].date))
}

// ============================================================================
section('4. 신호 → 체결 분리 · 마지막 봉 규율')
// ============================================================================

{
  // 급락을 인위적으로 심어 전환이 **다음 봉**에 일어나는지 본다.
  const base = makeBars(300, 3, 0, 0.001) // 거의 평평
  // 봉 150에서 -25% 급락시키고 이후 유지
  for (let i = 150; i < base.length; i++) {
    base[i] = { ...base[i], o: base[i].o * 0.75, h: base[i].h * 0.75, l: base[i].l * 0.75, c: base[i].c * 0.75 }
  }
  const run = runLeverageLadder(base, alignBars(makeLadderInput(base)), P, US_LADDER_COST)
  const first = run.switches[0]
  check('급락 후 전환이 발생한다', !!first, `전환 ${run.switches.length}건`)
  if (first) {
    const idx = base.findIndex((b) => b.date === first.date)
    check(
      `전환 체결이 신호 봉의 **다음** 봉이다 (신호 150 → 체결 ${idx})`,
      idx === 151,
      `체결 인덱스 ${idx}`,
    )
    eq('전환 방향은 QQQ → QLD', `${first.from}>${first.to}`, 'QQQ>QLD')
  }

  // 마지막 봉 규율: 마지막 봉 날짜에 새 전환이 기록되면 안 된다.
  const lastDate = base[base.length - 1].date
  check('마지막 봉에 신규 전환 없음(규칙 1-6)', !run.switches.some((s) => s.date === lastDate))
}

// ============================================================================
section('5. 날짜 축 정렬 · 방어')
// ============================================================================

{
  const a = makeBars(10, 1)
  const b = makeBars(10, 2).filter((_, i) => i !== 4) // 하루 결측
  const aligned = alignBars(new Map<string, DailyBar[]>([['A', a], ['B', b]]))
  eq('교집합 길이(결측일 제거)', aligned.get('A')!.length, 9)
  eq('두 종목 길이 동일', aligned.get('B')!.length, 9)
  check('결측일이 실제로 빠졌다', !aligned.get('A')!.some((x) => x.date === a[4].date))

  // 축이 안 맞으면 조용히 맞추지 않고 던져야 한다.
  let threw = false
  try {
    runLeverageLadder(a, new Map<string, DailyBar[]>([['QQQ', a], ['QLD', b], ['TQQQ', a]]), P, US_LADDER_COST)
  } catch {
    threw = true
  }
  check('축 불일치는 던진다(조용한 보정 금지)', threw)

  let threw2 = false
  try {
    runLeverageLadder(a, new Map<string, DailyBar[]>([['QQQ', a]]), P, US_LADDER_COST)
  } catch {
    threw2 = true
  }
  check('사다리 종목 누락은 던진다', threw2)
}

// ============================================================================
section('6. 합성 레버리지 — 정의대로 계산되는가')
// ============================================================================

{
  // 비용 0으로 두면 순수 일간 배수여야 한다.
  const base = makeBars(200, 21)
  const x2 = synthLeveraged(base, { leverage: 2, expenseAnnualPct: 0, financingAnnualPct: 0 })
  let ok = true
  for (let i = 1; i < base.length; i++) {
    const rb = base[i].c / base[i - 1].c - 1
    const rl = x2[i].c / x2[i - 1].c - 1
    if (Math.abs(rl - 2 * rb) > 1e-9) {
      ok = false
      break
    }
  }
  check('비용 0인 2배 합성 = 일간 수익률 × 2', ok)

  // 배수 1 + 비용 0이면 기초지수와 같은 수익률.
  const x1 = synthLeveraged(base, { leverage: 1, expenseAnnualPct: 0, financingAnnualPct: 0 })
  close('배수 1은 기초지수와 동일한 총수익', x1[199].c / x1[0].c, base[199].c / base[0].c, 1e-9)

  // 비용은 성적을 **깎는** 방향으로만 작동해야 한다.
  const withCost = synthLeveraged(base, { leverage: 2, expenseAnnualPct: 0.95, financingAnnualPct: 2 })
  check('운용보수·차입비용은 성적을 깎는다', withCost[199].c < x2[199].c)

  // 일할 드래그가 정의대로인지 1봉으로 확인
  const drag = (0.95 + 1 * 2) / 100 / TRADING_DAYS
  const r1 = base[1].c / base[0].c - 1
  close('1봉 드래그 반영식 일치', withCost[1].c / withCost[0].c - 1, 2 * r1 - drag, 1e-12)

  // 변동성 잠식: 오르내림 반복이면 2배가 기초지수 2배보다 나쁘다.
  const chop: DailyBar[] = []
  let c = 100
  for (let i = 0; i < 500; i++) {
    c = i % 2 === 0 ? c * 1.05 : c / 1.05
    const d = new Date(Date.UTC(2010, 0, 4) + i * 86400e3)
    chop.push({ date: d.toISOString().slice(0, 10), t: 0, o: c, h: c, l: c, c, v: 0 })
  }
  const chop2 = synthLeveraged(chop, { leverage: 2, expenseAnnualPct: 0, financingAnnualPct: 0 })
  check(
    '횡보장에서 변동성 잠식이 나타난다(2배가 원금 아래로)',
    chop2[chop2.length - 1].c < chop2[0].c * 0.99,
    `최종 ${chop2[chop2.length - 1].c.toFixed(2)}`,
  )
}

// ============================================================================
section('7. 합성 자기검증 지표')
// ============================================================================

{
  const base = makeBars(800, 33)
  const synth = synthLeveraged(base, { leverage: 2, expenseAnnualPct: 0, financingAnnualPct: 0 })
  const gap = synthTrackingGap(synth, synth)
  check('같은 계열끼리는 괴리 0', gap !== null && Math.abs(gap) < 1e-9, `gap=${gap}`)

  const short = makeBars(100, 34)
  eq('표본이 짧으면 판정 불가(null)', synthTrackingGap(short, synthLeveraged(short, { leverage: 2, expenseAnnualPct: 0, financingAnnualPct: 0 })), null)
}

// ============================================================================
section('8. 비용이 실제로 빠지는가')
// ============================================================================

{
  const base = makeBars(600, 55, -0.001, 0.03) // 전환이 실제로 발생하는 하락 계열
  const input = makeLadderInput(base)
  const free = runLeverageLadder(base, alignBars(input), P, { initialCapital: 10_000, feePct: 0, slippagePct: 0 })
  const paid = runLeverageLadder(base, alignBars(input), P, US_LADDER_COST)
  check('전환이 1회 이상 있었다', free.switches.length > 0, `${free.switches.length}건`)
  check(
    '비용을 물리면 최종 자산이 더 작다',
    paid.equity[paid.equity.length - 1].equity < free.equity[free.equity.length - 1].equity,
  )
  eq('비용 유무가 전환 횟수를 바꾸지는 않는다', paid.switches.length, free.switches.length)
  eq('보유일수 합 = 전체 봉 수', paid.daysInStep.reduce((a, b) => a + b, 0), base.length)
}

finish()
