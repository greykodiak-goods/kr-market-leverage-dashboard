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
  runProportionalLadder,
  runProportionalLadderDca,
  runGeneralLadder,
  SPEC_PROPORTIONAL,
  type LadderParams,
  type ProportionalParams,
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

// ============================================================================
section('9. 비중 분할 사다리 — 대표 지시 정본 (QQQ→50/50→QLD·TQQQ + 익절 래칫)')
// ============================================================================

const PP: ProportionalParams = { ...SPEC_PROPORTIONAL }

{
  // 지시대로 움직이는지 **결정적 계열**로 확인한다.
  // 0~99 평평(고점 형성) → 100~199 -25%까지 하락 → 200~ 회복
  const bars: DailyBar[] = []
  let c = 100
  for (let i = 0; i < 400; i++) {
    if (i < 100) c = 100
    else if (i < 200) c = 100 * (1 - 0.25 * ((i - 99) / 100))
    else c = 75 * (1 + 0.6 * ((i - 199) / 200))
    const d = new Date(Date.UTC(2010, 0, 4) + i * 86400e3)
    bars.push({ date: d.toISOString().slice(0, 10), t: 0, o: c, h: c, l: c, c, v: 0 })
  }
  const assets = alignBars(makeLadderInput(bars))
  const run = runProportionalLadder(bars, assets, PP, US_LADDER_COST)

  const kinds = run.events.map((e) => e.kind)
  check('1단 진입이 발생한다', kinds.includes('1단 진입'), kinds.join(','))
  check('2단 진입이 발생한다', kinds.includes('2단 진입'))
  check('익절이 발생한다', kinds.includes('익절'))

  const e1 = run.events.find((e) => e.kind === '1단 진입')!
  const e2 = run.events.find((e) => e.kind === '2단 진입')!
  check(`1단 진입은 -10% 부근 (${e1.ddPct.toFixed(1)}%)`, e1.ddPct <= -10 && e1.ddPct > -11)
  check(`2단 진입은 -20% 부근 (${e2.ddPct.toFixed(1)}%)`, e2.ddPct <= -20 && e2.ddPct > -21)

  // 1단 직후 비중은 QQQ 50 / QLD 50 근처
  check(
    `1단 직후 QQQ≈50·QLD≈50 (${e1.weights.map((w) => w.toFixed(0)).join('/')})`,
    Math.abs(e1.weights[0] - 50) < 2 && Math.abs(e1.weights[1] - 50) < 2 && e1.weights[2] === 0,
  )
  // 2단 직후 QQQ가 비고 TQQQ가 생긴다
  check(
    `2단 직후 QQQ≈0·TQQQ 보유 (${e2.weights.map((w) => w.toFixed(0)).join('/')})`,
    e2.weights[0] < 1 && e2.weights[2] > 20,
  )
  check('전 구간 레버리지 보유일이 0이 아니다', run.daysLevered > 0, `${run.daysLevered}일`)
}

{
  // 절단 불변성 — 이 엔진에도 규칙 1이 그대로 걸린다.
  const base = makeBars(1200, 91, -0.0003, 0.025)
  const full = runProportionalLadder(base, alignBars(makeLadderInput(base)), PP, US_LADDER_COST)
  check('원본에 행동이 충분히 있다', full.events.length >= 5, `${full.events.length}건`)

  for (const cut of [400, 700, 1000]) {
    const cb = base.slice(0, cut)
    const cr = runProportionalLadder(cb, alignBars(makeLadderInput(cb)), PP, US_LADDER_COST)
    let same = cr.equity.length === cut
    for (let i = 0; i < cr.equity.length && same; i++) {
      if (cr.equity[i].date !== full.equity[i].date) same = false
      else if (Math.abs(cr.equity[i].equity - full.equity[i].equity) > 1e-9) same = false
    }
    check(`[비중] 절단 ${cut}봉 — 자산곡선 동일`, same)

    // 일별 비중 시계열도 절단 앞부분이 완전히 같아야 한다(새 출력도 규칙 1을 진다)
    let wSame = cr.weightsDaily.length === cut
    for (let i = 0; i < cr.weightsDaily.length && wSame; i++)
      for (let k = 0; k < 3 && wSame; k++)
        if (Math.abs(cr.weightsDaily[i][k] - full.weightsDaily[i][k]) > 1e-9) wSame = false
    check(`[비중] 절단 ${cut}봉 — 일별 비중 시계열 동일`, wSame)

    const lastDate = cb[cb.length - 1].date
    const a = cr.events.filter((e) => e.date < lastDate)
    const b = full.events.filter((e) => e.date < lastDate)
    check(
      `[비중] 절단 ${cut}봉 — 행동 이력 동일 (${a.length}건)`,
      a.length === b.length && a.every((e, i) => e.date === b[i].date && e.kind === b[i].kind),
      `절단 ${a.length} vs 원본 ${b.length}`,
    )
    check(`[비중] 절단 ${cut}봉 — 비교 대상이 비어있지 않다`, a.length > 0)
  }
}

{
  // 미래 조작 불변성
  const base = makeBars(900, 93, -0.0003, 0.025)
  const K = 500
  const tampered = base.map((b, i) => (i < K ? b : { ...b, o: b.o * 3, h: b.h * 3, l: b.l * 3, c: b.c * 3 }))
  const o = runProportionalLadder(base, alignBars(makeLadderInput(base)), PP, US_LADDER_COST)
  const t = runProportionalLadder(tampered, alignBars(makeLadderInput(tampered)), PP, US_LADDER_COST)
  let same = true
  for (let i = 0; i < K; i++) if (Math.abs(o.equity[i].equity - t.equity[i].equity) > 1e-9) { same = false; break }
  check('[비중] 봉 500 이후 조작해도 그 이전 불변', same)
}

{
  // 마지막 봉 규율 + 방어
  const base = makeBars(600, 95, -0.001, 0.03)
  const run = runProportionalLadder(base, alignBars(makeLadderInput(base)), PP, US_LADDER_COST)
  const lastDate = base[base.length - 1].date
  check('[비중] 마지막 봉에 신규 행동 없음(규칙 1-6)', !run.events.some((e) => e.date === lastDate))

  let threw = false
  try {
    runProportionalLadder(base, alignBars(makeLadderInput(base)), { ...PP, band1Pct: 20, band2Pct: 10 }, US_LADDER_COST)
  } catch { threw = true }
  check('[비중] 밴드 순서가 뒤집히면 던진다', threw)

  const free = runProportionalLadder(base, alignBars(makeLadderInput(base)), PP, { initialCapital: 10_000, feePct: 0, slippagePct: 0 })
  check('[비중] 비용을 물리면 최종 자산이 더 작다', run.equity[run.equity.length - 1].equity < free.equity[free.equity.length - 1].equity)
  check('[비중] 평균 비중 합이 100 근처', Math.abs(run.avgWeights.reduce((a, b) => a + b, 0) - 100) < 0.5)

  // 일별 비중 시계열 — 화면 차트가 읽는 값의 기본 무결성
  check('[비중] 일별 비중 길이 = 자산곡선 길이', run.weightsDaily.length === run.equity.length)
  check(
    '[비중] 일별 비중 각 날 합이 100',
    run.weightsDaily.every((w) => Math.abs(w[0] + w[1] + w[2] - 100) < 1e-6),
  )
  check(
    '[비중] 일별 비중 전 성분이 0~100 범위',
    run.weightsDaily.every((w) => w.every((x) => x >= -1e-9 && x <= 100 + 1e-9)),
  )
}

{
  // 신고가 회복 시 QQQ 100%로 정리되는가
  const bars: DailyBar[] = []
  let c = 100
  for (let i = 0; i < 300; i++) {
    if (i < 50) c = 100
    else if (i < 150) c = 100 * (1 - 0.25 * ((i - 49) / 100))
    else c = 75 * (1 + 0.5 * ((i - 149) / 150)) // 최종 112.5 → 신고가 돌파
    const d = new Date(Date.UTC(2010, 0, 4) + i * 86400e3)
    bars.push({ date: d.toISOString().slice(0, 10), t: 0, o: c, h: c, l: c, c, v: 0 })
  }
  const run = runProportionalLadder(bars, alignBars(makeLadderInput(bars)), PP, US_LADDER_COST)
  check('신고가 정리 이벤트가 있다', run.events.some((e) => e.kind === '신고가 정리'), run.events.map((e) => e.kind).join(','))
  const last = run.events[run.events.length - 1]
  check(`정리 후 QQQ 100% 근처 (${last.weights.map((w) => w.toFixed(0)).join('/')})`, last.weights[0] > 99)
}

// ============================================================================
section('10. 비중 분할 사다리 — 적립식(DCA) 판')
// ============================================================================

{
  const base = makeBars(1200, 77, -0.0003, 0.025)
  const assets = alignBars(makeLadderInput(base))
  const AMT = 10_000

  const w = runProportionalLadderDca(base, assets, PP, US_LADDER_COST, AMT, 'weights')
  const q = runProportionalLadderDca(base, assets, PP, US_LADDER_COST, AMT, 'qqq')

  eq('누적 원금 = 일수 × 납입액', w.contributed, base.length * AMT)
  eq('배분 방식이 원금을 바꾸지는 않는다', q.contributed, w.contributed)
  eq('곡선 길이 = 봉 수', w.curve.length, base.length)
  check('행동이 발생한다', w.events.length > 0, `${w.events.length}건`)
  check('평균 비중 합이 100 근처', Math.abs(w.avgWeights.reduce((a, b) => a + b, 0) - 100) < 0.5)
  check(
    'qqq 배분은 weights 배분보다 QQQ 평균 비중이 높다',
    q.avgWeights[0] > w.avgWeights[0],
    `qqq ${q.avgWeights[0].toFixed(1)}% vs weights ${w.avgWeights[0].toFixed(1)}%`,
  )
  check('두 배분 방식의 최종 평가액이 다르다(축이 실제로 작동)', Math.abs(q.finalValue - w.finalValue) > 1)

  // 절단 불변성 — 적립식에도 규칙 1이 그대로 걸린다
  for (const cut of [400, 700, 1000]) {
    const cb = base.slice(0, cut)
    const ca = alignBars(makeLadderInput(cb))
    const cr = runProportionalLadderDca(cb, ca, PP, US_LADDER_COST, AMT, 'weights')
    let same = cr.curve.length === cut
    for (let i = 0; i < cr.curve.length && same; i++) {
      if (cr.curve[i].date !== w.curve[i].date) same = false
      else if (Math.abs(cr.curve[i].equity - w.curve[i].equity) > 1e-9) same = false
    }
    check(`[DCA] 절단 ${cut}봉 — 자산곡선 동일`, same)
    const lastDate = cb[cb.length - 1].date
    const a = cr.events.filter((e) => e.date < lastDate)
    const b = w.events.filter((e) => e.date < lastDate)
    check(
      `[DCA] 절단 ${cut}봉 — 행동 이력 동일 (${a.length}건)`,
      a.length === b.length && a.every((e, i) => e.date === b[i].date && e.kind === b[i].kind),
    )
    check(`[DCA] 절단 ${cut}봉 — 비교 대상이 비어있지 않다`, a.length > 0)
  }

  // 미래 조작 불변성
  const K = 600
  const tampered = base.map((b, i) => (i < K ? b : { ...b, o: b.o * 3, h: b.h * 3, l: b.l * 3, c: b.c * 3 }))
  const t = runProportionalLadderDca(tampered, alignBars(makeLadderInput(tampered)), PP, US_LADDER_COST, AMT, 'weights')
  let inv = true
  for (let i = 0; i < K; i++) if (Math.abs(w.curve[i].equity - t.curve[i].equity) > 1e-9) { inv = false; break }
  check('[DCA] 봉 600 이후 조작해도 그 이전 불변', inv)

  // 마지막 봉 규율 — 납입은 계속되지만 신규 전환은 없다
  const lastDate = base[base.length - 1].date
  check('[DCA] 마지막 봉에 신규 전환 없음(규칙 1-6)', !w.events.some((e) => e.date === lastDate))
}

{
  // 가격이 일정하면 비용만큼만 손실 — 적립식 회계가 새지 않는지 확인
  const flat: DailyBar[] = []
  for (let i = 0; i < 300; i++) {
    const d = new Date(Date.UTC(2010, 0, 4) + i * 86400e3)
    flat.push({ date: d.toISOString().slice(0, 10), t: 0, o: 100, h: 100, l: 100, c: 100, v: 0 })
  }
  const a = alignBars(makeLadderInput(flat))
  const r = runProportionalLadderDca(flat, a, PP, { initialCapital: 0, feePct: 0, slippagePct: 0 }, 10_000, 'weights')
  close('[DCA] 비용 0 · 가격 불변이면 평가액 = 원금', r.finalValue, r.contributed, 1e-6)
  eq('[DCA] 전환 0건(낙폭 없음)', r.events.length, 0)
  eq('[DCA] 수중일 0', r.underwaterDays, 0)
}

{
  // 방어
  const base = makeBars(300, 79)
  const a = alignBars(makeLadderInput(base))
  let threw = false
  try { runProportionalLadderDca(base, a, PP, US_LADDER_COST, 0, 'weights') } catch { threw = true }
  check('[DCA] 납입액 0이면 던진다', threw)
  let threw2 = false
  try { runProportionalLadderDca(base, a, { ...PP, band1Pct: 30, band2Pct: 10 }, US_LADDER_COST, 10_000, 'weights') } catch { threw2 = true }
  check('[DCA] 밴드 순서가 뒤집히면 던진다', threw2)
}

// ============================================================================
section('11. 일반화 사다리 — 4변수 (분할매도 폭·횟수 × 분할매수 폭·등분)')
// ============================================================================

{
  // ★ 상호 검증: (10%, 2회, 10%, 10등분) = 기존 정본(SPEC_PROPORTIONAL)과
  //   자산곡선이 완전히 같아야 한다. 두 독립 구현이 같은 답을 내는지가 곧 검증이다.
  const base = makeBars(1400, 91, -0.0003, 0.025)
  const assets = alignBars(makeLadderInput(base))
  const prop = runProportionalLadder(base, assets, SPEC_PROPORTIONAL, US_LADDER_COST)
  const gen = runGeneralLadder(base, assets, { dropStepPct: 10, sellTranches: 2, riseStepPct: 10, buyTranches: 10 }, US_LADDER_COST)
  let same = gen.equity.length === prop.equity.length
  let maxDiff = 0
  for (let i = 0; i < gen.equity.length && same; i++) {
    const d = Math.abs(gen.equity[i].equity - prop.equity[i].equity)
    maxDiff = Math.max(maxDiff, d)
    if (d > 1e-6) same = false
  }
  check(`(10,2,10,10) = 정본과 자산곡선 동일 (최대 오차 ${maxDiff.toExponential(1)})`, same)
  check('(10,2,10,10) 매매 수 동일', gen.trades === prop.trades, `${gen.trades} vs ${prop.trades}`)
  check('상호검증 표본에 매매가 실제로 있다(공허 방지)', gen.trades > 0)

  // 파라미터 방어
  let threw = 0
  try { runGeneralLadder(base, assets, { dropStepPct: 0, sellTranches: 2, riseStepPct: 10, buyTranches: 10 }, US_LADDER_COST) } catch { threw++ }
  try { runGeneralLadder(base, assets, { dropStepPct: 10, sellTranches: 0, riseStepPct: 10, buyTranches: 10 }, US_LADDER_COST) } catch { threw++ }
  try { runGeneralLadder(base, assets, { dropStepPct: 10, sellTranches: 2.5, riseStepPct: 10, buyTranches: 10 }, US_LADDER_COST) } catch { threw++ }
  check('무효 파라미터 3종이 전부 던진다', threw === 3, `${threw}/3`)
}

{
  // 절단 불변성 — 새 엔진에도 규칙 1이 그대로 걸린다.
  const GP = { dropStepPct: 6, sellTranches: 3, riseStepPct: 8, buyTranches: 4 }
  const base = makeBars(1200, 91, -0.0004, 0.03)
  const full = runGeneralLadder(base, alignBars(makeLadderInput(base)), GP, US_LADDER_COST)
  check('[일반화] 원본에 행동이 충분히 있다', full.events.length >= 5, `${full.events.length}건`)

  for (const cut of [400, 800]) {
    const cb = base.slice(0, cut)
    const cr = runGeneralLadder(cb, alignBars(makeLadderInput(cb)), GP, US_LADDER_COST)
    let same = cr.equity.length === cut
    for (let i = 0; i < cr.equity.length && same; i++)
      if (Math.abs(cr.equity[i].equity - full.equity[i].equity) > 1e-9) same = false
    check(`[일반화] 절단 ${cut}봉 — 자산곡선 동일`, same)
    let wSame = cr.weightsDaily.length === cut
    for (let i = 0; i < cr.weightsDaily.length && wSame; i++)
      for (let k = 0; k < 3 && wSame; k++)
        if (Math.abs(cr.weightsDaily[i][k] - full.weightsDaily[i][k]) > 1e-9) wSame = false
    check(`[일반화] 절단 ${cut}봉 — 일별 비중 동일`, wSame)
    const lastDate = cb[cb.length - 1].date
    const a = cr.events.filter((e) => e.date < lastDate)
    const b = full.events.filter((e) => e.date < lastDate)
    check(`[일반화] 절단 ${cut}봉 — 행동 이력 동일 (${a.length}건)`, a.length === b.length && a.every((e, i) => e.date === b[i].date && e.kind === b[i].kind))
    check(`[일반화] 절단 ${cut}봉 — 비교가 공허하지 않다`, a.length > 0)
  }

  // 미래 조작 불변성
  const K = 600
  const tampered = base.map((b, i) => (i < K ? b : { ...b, o: b.o * 3, h: b.h * 3, l: b.l * 3, c: b.c * 3 }))
  const t = runGeneralLadder(tampered, alignBars(makeLadderInput(tampered)), GP, US_LADDER_COST)
  let sameT = true
  for (let i = 0; i < K; i++) if (Math.abs(full.equity[i].equity - t.equity[i].equity) > 1e-9) { sameT = false; break }
  check('[일반화] 봉 600 이후 조작해도 그 이전 불변', sameT)

  // 마지막 봉 규율 + 기본 무결성
  const lastDate = base[base.length - 1].date
  check('[일반화] 마지막 봉에 신규 행동 없음(규칙 1-6)', !full.events.some((e) => e.date === lastDate))
  check('[일반화] 일별 비중 합 100', full.weightsDaily.every((w) => Math.abs(w[0] + w[1] + w[2] - 100) < 1e-6))
  check('[일반화] 비중 길이 = 곡선 길이', full.weightsDaily.length === full.equity.length)
}

{
  // 결정적 계열로 분할 규칙 자체를 확인 — N=4, 8% 간격: −8/−16/−24/−32에서 1/4씩,
  // 앞 두 번은 QLD, 뒤 두 번은 TQQQ. 마지막 회가 QQQ를 비우는지도 본다.
  const bars: DailyBar[] = []
  let c = 100
  for (let i = 0; i < 300; i++) {
    if (i < 50) c = 100
    else if (i < 200) c = 100 * (1 - 0.36 * ((i - 49) / 150))
    else c = 64 * (1 + 0.2 * ((i - 199) / 100))
    const d = new Date(Date.UTC(2012, 0, 3) + i * 86400e3)
    bars.push({ date: d.toISOString().slice(0, 10), t: 0, o: c, h: c, l: c, c, v: 0 })
  }
  const run = runGeneralLadder(bars, alignBars(makeLadderInput(bars)), { dropStepPct: 8, sellTranches: 4, riseStepPct: 10, buyTranches: 5 }, US_LADDER_COST)
  const sells = run.events.filter((e) => e.kind.startsWith('분할매도'))
  eq('분할매도가 정확히 4회', sells.length, 4)
  check('1회차 목적지가 QLD (QLD 비중 증가)', sells[0].weights[1] > 5)
  check('4회차 후 QQQ가 비었다', sells[3].weights[0] < 1, sells[3].weights.map((w) => w.toFixed(0)).join('/'))
  check('4회차 후 TQQQ 보유', sells[3].weights[2] > 20)
}

finish()
