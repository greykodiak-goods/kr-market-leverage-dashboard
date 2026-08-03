// ⚠️ 이 파일은 `src/features/backtest/xsmomChain.ts`에 대한 CLAUDE.md 규칙 1(미래참조 금지)의
// 집행자이자, **의미론 정본과의 동형(isomorphism) 집행자**다.
//
// 횡단면 모멘텀(12-1)은 원래 `scripts/idea-lab.entry.ts`(MODE=xsmom)에만 있던 실험 코드였다.
// 그것을 화면·페이퍼 트랙에서 쓰려고 src로 옮겨 적었는데, **옮겨 적기는 조용히 갈라진다** —
// 창을 하루 어긋나게 잡거나 슬롯 분모를 targets 수로 바꾸면 성적이 통째로 달라지는데
// 컴파일도 되고 테스트도 통과한다. 그래서 여기서 두 구현을 **같은 합성 데이터로 나란히 돌려**
// 자산곡선·체결이 전부 일치하는지 본다. 갈라지면 이 파일이 깨진다.
//
// 검증 항목
//   1) 동형 — src `runXsmomYear` ≡ idea-lab `simulateXsMomYear` (자산곡선·체결·승패 전부)
//   1-b) 동형(노출 오버레이) — src `runXsmomYear({exposure})` ≡ idea-lab
//        `simulateRankYear({rank: xsmomRank, keep, exposure})`. 32차 프리셋의 시장게이트가
//        이 경로를 타므로, 여기가 갈라지면 화면 수치가 연구 수치와 갈라진다.
//   2) 절단 불변성 — 뒷구간 봉을 잘라내도 잘린 시점 이전의 리밸런스·자산곡선이 완전히 동일
//   3) 12-1 창 산술 — **최근 1개월을 통째로 버린다**. 당월 데이터를 아무리 변조해도 랭킹 불변,
//      창 안(12개월 전~1개월 전)을 건드리면 바뀐다
//   4) 게이트 분모 고정 — 게이트에 걸린 슬롯은 **현금**으로 남고, 남은 종목에 재분배되지 않는다
//   5) 체결 시점 — 리밸런스는 월 첫 거래일 **시가**에 체결되고, 판단은 그보다 앞선다
//
// 네트워크를 타지 않는다. 합성 시계열만 쓴다(컨테이너에서 Yahoo는 403).

import { check, close, eq, finish, rng, section } from './harness'
import {
  momentum12_1,
  runXsmomChained,
  runXsmomYear,
  shiftMonthStart,
  xsmomRank,
} from '../src/features/backtest/xsmomChain'
import {
  simulateRankYear,
  simulateXsMomYear,
  xsmomRank as refXsmomRank,
} from '../scripts/idea-lab.entry'
import type { CostSettings } from '../src/features/backtest/conditionScreen'
import type { DailyBar } from '../src/features/backtest/types'

const COST: CostSettings = { initialCapital: 10_000_000, feePct: 0.015, taxPct: 0.15, slippagePct: 0.1 }

/** 합성 일봉 — 주말을 건너뛴 거래일 근사(엔진이 달력을 데이터에서 만들므로 충분). */
function makeBars(opts: {
  from: string
  to: string
  base: number
  /** 일일 드리프트(예: 0.0008 = 하루 +0.08%) */
  drift: number
  /** 0이면 잡음 없는 결정적 추세 */
  seed?: number
  noise?: number
}): DailyBar[] {
  const rnd = opts.seed ? rng(opts.seed) : () => 0.5
  const noise = opts.noise ?? 0
  const bars: DailyBar[] = []
  let p = opts.base
  const start = Date.parse(`${opts.from}T00:00:00Z`)
  const end = Date.parse(`${opts.to}T00:00:00Z`)
  for (let t = start; t <= end; t += 86400000) {
    const d = new Date(t)
    const dow = d.getUTCDay()
    if (dow === 0 || dow === 6) continue
    const o = p
    const c = p * (1 + opts.drift + (rnd() - 0.5) * noise)
    const h = Math.max(o, c) * 1.004
    const l = Math.min(o, c) * 0.996
    bars.push({ date: d.toISOString().slice(0, 10), t: Math.floor(t / 1000), o, h, l, c, v: 100_000 })
    p = c
  }
  return bars
}

/** 여러 종목 — 심볼마다 드리프트를 달리해 랭킹이 실제로 갈리게 만든다. */
function makeUniverse(n: number, from: string, to: string, seedBase: number, noise = 0.02): Record<string, DailyBar[]> {
  const h: Record<string, DailyBar[]> = {}
  for (let i = 0; i < n; i++) {
    const sym = `S${String(i).padStart(2, '0')}`
    h[sym] = makeBars({
      from,
      to,
      base: 10_000 + i * 1_000,
      drift: -0.0006 + i * 0.00022,
      seed: seedBase + i,
      noise,
    })
  }
  return h
}

const cut = (h: Record<string, DailyBar[]>, upTo: string): Record<string, DailyBar[]> => {
  const out: Record<string, DailyBar[]> = {}
  for (const [s, bars] of Object.entries(h)) {
    const c = bars.filter((b) => b.date <= upTo)
    if (c.length) out[s] = c
  }
  return out
}

// ============================================================================
section('1) 동형 — src runXsmomYear ≡ idea-lab simulateXsMomYear (의미론 정본)')
// ============================================================================
{
  const hist = makeUniverse(9, '2018-01-01', '2021-12-31', 7001)
  const syms = Object.keys(hist)

  for (const slots of [4, 5, 6]) {
    for (const gate of [false, true]) {
      const mine = runXsmomYear(hist, '2021-01-01', syms, COST, { slots, gate })
      const canon = simulateXsMomYear(hist, '2021-01-01', syms, COST, { slots, gate })
      const tag = `상위${slots}${gate ? '+게이트' : ''}`

      eq(`[${tag}] 자산곡선 길이 일치`, mine.equity.length, canon.equity.length)
      let maxEqDiff = 0
      let dateMismatch = 0
      for (let i = 0; i < Math.min(mine.equity.length, canon.equity.length); i++) {
        if (mine.equity[i].date !== canon.equity[i].date) dateMismatch++
        maxEqDiff = Math.max(maxEqDiff, Math.abs(mine.equity[i].equity - canon.equity[i].equity))
      }
      eq(`[${tag}] 자산곡선 날짜 전부 일치`, dateMismatch, 0)
      close(`[${tag}] 자산곡선 값 전부 일치(최대 오차)`, maxEqDiff, 0, 1e-6)

      eq(`[${tag}] 체결 건수 일치`, mine.fills.length, canon.fills.length)
      let fillMismatch = 0
      for (let i = 0; i < Math.min(mine.fills.length, canon.fills.length); i++) {
        const a = mine.fills[i]
        const b = canon.fills[i]
        if (
          a.date !== b.date ||
          a.sym !== b.sym ||
          a.side !== b.side ||
          a.qty !== b.qty ||
          a.signalDate !== b.signalDate ||
          Math.abs(a.px - b.px) > 1e-9
        )
          fillMismatch++
      }
      eq(`[${tag}] 체결 내역(일자·종목·방향·수량·기준가·신호일) 전부 일치`, fillMismatch, 0)
      eq(`[${tag}] 라운드트립 수 일치`, mine.closed, canon.closed)
      eq(`[${tag}] 승 건수 일치`, mine.wins, canon.wins)
      eq(`[${tag}] 연말 미청산 수 일치`, mine.openAtEnd, canon.openAtEnd)
      check(`[${tag}] 실제로 매매가 일어났다(빈 비교 방지)`, mine.fills.length > 0, `fills=${mine.fills.length}`)
    }
  }
}

// ============================================================================
section('1-b) 동형(노출 오버레이) — exposure 훅이 정본 simulateRankYear와 같은 산술인가')
// ============================================================================
//
// 32차 프리셋의 시장게이트(12-1)가 **이 경로**를 탄다. 게이트가 닫힌 달은 "수익률을 0으로
// 지우는" 것이 아니라 그 달 첫 거래일 시가에 **전량 청산**(매도 비용 지불)하고 풀리는 달에
// 다시 사는 것이며, 그 비용까지가 정본의 의미론이다. 여기가 갈라지면 화면 수치가 연구
// 수치와 갈라진다(2026-08-02 시세 로딩 버그와 같은 종류의 사고).
{
  const hist = makeUniverse(9, '2018-01-01', '2021-12-31', 7001)
  const syms = Object.keys(hist)

  /** 시장게이트를 흉내 낸 노출 함수들 — 달만 보고 값을 정한다(규칙 1 계약과 같은 형태). */
  const SHUT = new Set(['2021-03', '2021-07', '2021-08', '2021-09'])
  const EXPOSURES: { tag: string; fn: (date: string) => number }[] = [
    { tag: '게이트 4달 닫힘', fn: (d) => (SHUT.has(d.slice(0, 7)) ? 0 : 1) },
    { tag: '전부 열림(w=1)', fn: () => 1 },
    { tag: '전부 닫힘(w=0)', fn: () => 0 },
    // 시장게이트는 0/1만 쓰지만 훅 자체는 연속값 계약이다 — 슬롯 산술까지 정본과 같은지 본다
    { tag: '부분 노출(w=0.5)', fn: () => 0.5 },
    { tag: '첫 달만 닫힘(경계)', fn: (d) => (d.slice(0, 7) === '2021-01' ? 0 : 1) },
    { tag: '마지막 달만 닫힘(경계)', fn: (d) => (d.slice(0, 7) === '2021-12' ? 0 : 1) },
  ]

  for (const slots of [4, 5]) {
    for (const gate of [false, true]) {
      for (const ex of EXPOSURES) {
        const mine = runXsmomYear(hist, '2021-01-01', syms, COST, { slots, gate, exposure: ex.fn })
        const canon = simulateRankYear(hist, '2021-01-01', syms, COST, {
          slots,
          rank: refXsmomRank,
          keep: gate ? (r) => r.aux >= 0 : undefined,
          exposure: ex.fn,
        })
        const tag = `상위${slots}${gate ? '+게이트' : ''} · ${ex.tag}`

        eq(`[${tag}] 자산곡선 길이 일치`, mine.equity.length, canon.equity.length)
        let maxEqDiff = 0
        let dateMismatch = 0
        for (let i = 0; i < Math.min(mine.equity.length, canon.equity.length); i++) {
          if (mine.equity[i].date !== canon.equity[i].date) dateMismatch++
          maxEqDiff = Math.max(maxEqDiff, Math.abs(mine.equity[i].equity - canon.equity[i].equity))
        }
        eq(`[${tag}] 자산곡선 날짜 전부 일치`, dateMismatch, 0)
        close(`[${tag}] 자산곡선 값 전부 일치(최대 오차)`, maxEqDiff, 0, 1e-6)

        eq(`[${tag}] 체결 건수 일치`, mine.fills.length, canon.fills.length)
        let fillMismatch = 0
        for (let i = 0; i < Math.min(mine.fills.length, canon.fills.length); i++) {
          const a = mine.fills[i]
          const b = canon.fills[i]
          if (
            a.date !== b.date ||
            a.sym !== b.sym ||
            a.side !== b.side ||
            a.qty !== b.qty ||
            a.signalDate !== b.signalDate ||
            Math.abs(a.px - b.px) > 1e-9
          )
            fillMismatch++
        }
        eq(`[${tag}] 체결 내역 전부 일치`, fillMismatch, 0)
        eq(`[${tag}] 라운드트립 수 일치`, mine.closed, canon.closed)
        eq(`[${tag}] 연말 미청산 수 일치`, mine.openAtEnd, canon.openAtEnd)
      }
    }
  }

  // 훅을 **안 주면** 기존 경로와 부동소수점까지 같아야 한다(골든 지문 보호 · 기존 프리셋 불변)
  for (const slots of [4, 5, 6]) {
    for (const gate of [false, true]) {
      const plain = runXsmomYear(hist, '2021-01-01', syms, COST, { slots, gate })
      const w1 = runXsmomYear(hist, '2021-01-01', syms, COST, { slots, gate, exposure: () => 1 })
      const tag = `상위${slots}${gate ? '+게이트' : ''}`
      // w=1은 식이 (eq*1)/denom이라 값은 같지만 **경로가 다르다** — 둘 다 확인한다
      let diff = 0
      for (let i = 0; i < plain.equity.length; i++)
        if (Math.abs(plain.equity[i].equity - w1.equity[i].equity) > 1e-9) diff++
      eq(`[${tag}] 훅 미지정 ≡ w=1 (노출 훅이 기본 동작을 바꾸지 않는다)`, diff, 0)
      eq(`[${tag}] 훅 미지정 시 노출 기록은 1`, plain.rebalances[0].exposure, 1)
    }
  }

  // 게이트가 닫힌 달에는 **실제로 청산이 일어난다**(비용을 문다) — 커브 마스크와 갈리는 지점
  {
    const shut = new Set(['2021-07'])
    const run = runXsmomYear(hist, '2021-01-01', syms, COST, {
      slots: 5,
      gate: false,
      exposure: (d) => (shut.has(d.slice(0, 7)) ? 0 : 1),
    })
    const julyReb = run.rebalances.find((r) => r.date.startsWith('2021-07'))
    check('게이트 달 리밸런스 기록이 있다', julyReb != null, `${julyReb?.date}`)
    eq('게이트 달 노출 기록 = 0', julyReb?.exposure, 0)
    const julySells = run.fills.filter((f) => f.date.startsWith('2021-07') && f.side === 'sell')
    const julyBuys = run.fills.filter((f) => f.date.startsWith('2021-07') && f.side === 'buy')
    check('게이트 달에 매도가 일어난다(전량 청산)', julySells.length > 0, `${julySells.length}건`)
    eq('게이트 달에 매수는 없다', julyBuys.length, 0)
    // 청산 후 그 달 내내 자산이 평평하지 **않다**는 뜻이 아니라, 현금이라 평평하다.
    const july = run.equity.filter((p) => p.date.startsWith('2021-07'))
    const flat = july.every((p) => Math.abs(p.equity - july[july.length - 1].equity) < 1e-6)
    check('청산 뒤 그 달은 현금이라 자산이 평평하다', flat)
    // 다음 달에는 다시 산다(재매수 비용을 문다)
    const augBuys = run.fills.filter((f) => f.date.startsWith('2021-08') && f.side === 'buy')
    check('게이트가 풀리면 다시 매수한다', augBuys.length > 0, `${augBuys.length}건`)
  }

  // 연쇄(runXsmomChained)에서도 노출 훅이 그대로 전달되는지 + 절단 불변성
  {
    const h = makeUniverse(9, '2018-01-01', '2021-12-31', 7301)
    const codes = Object.keys(h)
    const shut = new Set(['2020-04', '2020-05', '2021-02'])
    const exposure = (d: string) => (shut.has(d.slice(0, 7)) ? 0 : 1)
    const opts = {
      cost: COST,
      slots: 5,
      gate: true,
      exposure,
      years: [2020, 2021],
      codesFor: () => codes,
      minSymbols: 3,
    }
    const full = runXsmomChained(h, opts)
    const gated = full.rebalances.filter((r) => r.exposure === 0)
    eq('연쇄에도 노출 훅이 전달된다(닫힌 달 수)', gated.length, 3)

    const cutDate = '2021-03-31'
    const part = runXsmomChained(cut(h, cutDate), opts)
    let diff = -1
    for (let i = 0; i < part.equity.length; i++) {
      if (
        part.equity[i].date !== full.equity[i].date ||
        Math.abs(part.equity[i].equity - full.equity[i].equity) > 1e-9
      ) {
        diff = i
        break
      }
    }
    check(
      `노출 훅이 걸린 연쇄도 절단 불변 (${cutDate}까지 ${part.equity.length}점)`,
      diff < 0 && part.equity.length > 0,
      diff >= 0 ? `${diff}번째 ${full.equity[diff]?.date}` : '',
    )
  }
}

// ============================================================================
section('2) 절단 불변성 — 뒷구간을 잘라도 앞 구간의 리밸런스·자산곡선이 동일')
// ============================================================================
{
  // 잡음을 키워 랭킹이 실제로 회전하게 만든다 — 회전이 없으면 '청산 완료 매매'가 0건이라
  // 절단 불변성 비교가 사실상 빈 비교가 된다(테스트가 아무것도 지키지 못한다).
  const full = makeUniverse(12, '2018-01-01', '2022-12-31', 8100, 0.04)
  const syms = Object.keys(full)
  const CUT = '2021-06-30'
  const opts = {
    cost: COST,
    slots: 5,
    gate: true,
    years: [2020, 2021, 2022],
    codesFor: () => syms,
  }

  const a = runXsmomChained(full, opts)
  const b = runXsmomChained(cut(full, CUT), opts)

  const aPre = a.equity.filter((p) => p.date <= CUT)
  const bPre = b.equity.filter((p) => p.date <= CUT)
  eq('절단 전 자산곡선 길이 동일', aPre.length, bPre.length)
  check('절단 전 자산곡선이 비어 있지 않다', aPre.length > 200, `len=${aPre.length}`)
  let maxDiff = 0
  let ddDiff = 0
  let dateBad = 0
  for (let i = 0; i < Math.min(aPre.length, bPre.length); i++) {
    if (aPre[i].date !== bPre[i].date) dateBad++
    maxDiff = Math.max(maxDiff, Math.abs(aPre[i].equity - bPre[i].equity))
    ddDiff = Math.max(ddDiff, Math.abs(aPre[i].drawdownPct - bPre[i].drawdownPct))
  }
  eq('절단 전 날짜 전부 일치', dateBad, 0)
  close('절단 전 자산곡선 값 전부 일치(최대 오차)', maxDiff, 0, 1e-6)
  close('절단 전 낙폭 전부 일치(최대 오차)', ddDiff, 0, 1e-9)

  const aReb = a.rebalances.filter((r) => r.date <= CUT)
  const bReb = b.rebalances.filter((r) => r.date <= CUT)
  eq('절단 전 리밸런스 횟수 동일', aReb.length, bReb.length)
  let rebBad = 0
  for (let i = 0; i < Math.min(aReb.length, bReb.length); i++) {
    if (aReb[i].date !== bReb[i].date) rebBad++
    if (aReb[i].denom !== bReb[i].denom) rebBad++
    if (aReb[i].targets.join(',') !== bReb[i].targets.join(',')) rebBad++
  }
  eq('절단 전 리밸런스(일자·분모·목표종목) 전부 일치', rebBad, 0)

  // 진입 이력(일자·종목)은 절단과 무관하게 같아야 한다.
  // ⚠️ 절단 시점에 **아직 열려 있는** 매매의 수량·평단은 비교하지 않는다 — 그 매매는 절단 뒤에도
  //    추가 매수·트림을 받아 계속 자라므로 두 실행에서 다른 게 정상이다(미래참조가 아니라 미완결).
  //    대신 **절단 전에 이미 청산이 끝난** 매매는 완결됐으므로 손익까지 완전히 같아야 한다.
  const aEntry = a.trades.filter((t) => t.entryDate <= CUT).map((t) => `${t.entryDate}|${t.symbol}`)
  const bEntry = b.trades.filter((t) => t.entryDate <= CUT).map((t) => `${t.entryDate}|${t.symbol}`)
  check('절단 전 진입 이력(일자·종목) 동일', aEntry.join(';') === bEntry.join(';'), `${aEntry.length} vs ${bEntry.length}`)
  check('절단 전 진입이 실제로 있었다', aEntry.length > 0, `n=${aEntry.length}`)

  const done = (r: typeof a) =>
    r.trades
      .filter((t) => t.exitDate != null && t.exitDate <= CUT)
      .map((t) => `${t.entryDate}|${t.symbol}|${t.qty}|${t.exitDate}|${(t.pnlPct ?? 0).toFixed(9)}`)
  const aDone = done(a)
  const bDone = done(b)
  check('절단 전 청산 완료 매매는 손익까지 완전히 동일', aDone.join(';') === bDone.join(';'), `${aDone.length} vs ${bDone.length}`)
  check('절단 전 청산 완료 매매가 실제로 있었다', aDone.length > 0, `n=${aDone.length}`)
}

// ============================================================================
section('3) 12-1 창 산술 — 최근 1개월은 창에서 통째로 빠진다')
// ============================================================================
{
  eq('shiftMonthStart(-1)', shiftMonthStart('2021-03-02', -1), '2021-02-01')
  eq('shiftMonthStart(-12)', shiftMonthStart('2021-03-02', -12), '2020-03-01')
  eq('shiftMonthStart 연도 넘김', shiftMonthStart('2021-01-04', -1), '2020-12-01')
  eq('shiftMonthStart 연도 2회 넘김', shiftMonthStart('2021-01-04', -12), '2020-01-01')

  const bars = makeBars({ from: '2019-01-01', to: '2021-03-31', base: 10_000, drift: 0.0005 })
  const D = '2021-03-01'
  const baseMom = momentum12_1(bars, D)
  check('기준 모멘텀이 산출된다', baseMom != null, String(baseMom))

  // (a) **당월(2021-03) + 직전 1개월(2021-02)** 을 통째로 변조 — 창 밖이므로 값이 안 바뀐다
  const perturbedRecent = bars.map((b) => (b.date >= '2021-02-01' ? { ...b, o: b.o * 5, h: b.h * 5, l: b.l * 5, c: b.c * 5 } : b))
  close('최근 1개월 변조에도 12-1 모멘텀 불변', momentum12_1(perturbedRecent, D)!, baseMom!, 1e-12)

  // (b) 창 안(12개월 전~1개월 전)을 건드리면 반드시 바뀐다 — 창이 헛돌지 않는다는 반대증거
  const perturbedInside = bars.map((b) => (b.date >= '2020-06-01' && b.date < '2021-02-01' ? { ...b, c: b.c * 1.5 } : b))
  const insideMom = momentum12_1(perturbedInside, D)
  check('창 안을 변조하면 모멘텀이 바뀐다', Math.abs(insideMom! - baseMom!) > 1e-6, `${insideMom} vs ${baseMom}`)

  // (c) 랭킹 전체 — 당월 데이터를 종목마다 다르게 뒤흔들어도 순위가 그대로여야 한다
  const uni = makeUniverse(8, '2019-01-01', '2021-03-31', 9001)
  const syms = Object.keys(uni)
  const rankBase = xsmomRank(uni, syms, D).map((r) => r.sym).join(',')
  const scrambled: Record<string, DailyBar[]> = {}
  syms.forEach((s, i) => {
    const k = 1 + (i % 2 === 0 ? 3 : -0.7) // 짝수는 급등, 홀수는 급락으로 변조
    scrambled[s] = uni[s].map((b) => (b.date >= '2021-02-01' ? { ...b, o: b.o * k, h: b.h * k, l: b.l * k, c: b.c * k } : b))
  })
  const rankScrambled = xsmomRank(scrambled, syms, D).map((r) => r.sym).join(',')
  eq('당월 변조에도 랭킹 순서 불변(미래참조 없음)', rankScrambled, rankBase)
}

// ============================================================================
section('4) 게이트 분모 고정 — 걸린 슬롯은 현금, 남은 종목에 재분배하지 않는다')
// ============================================================================
{
  // 2종목만 상승(양의 12-1), 4종목은 하락(음의 12-1). 잡음 없이 결정적으로 만든다.
  const hist: Record<string, DailyBar[]> = {}
  const up = ['U0', 'U1']
  const down = ['D0', 'D1', 'D2', 'D3']
  for (const s of up) hist[s] = makeBars({ from: '2019-01-01', to: '2021-12-31', base: 10_000, drift: 0.0012 })
  for (const s of down) hist[s] = makeBars({ from: '2019-01-01', to: '2021-12-31', base: 10_000, drift: -0.0012 })
  const syms = [...up, ...down]
  const SLOTS = 5

  const D = '2021-01-01'
  const ranked = xsmomRank(hist, syms, '2021-01-04')
  eq('후보 6종목 전부 랭킹 산출', ranked.length, 6)
  eq('양의 모멘텀은 정확히 2종목', ranked.filter((r) => r.mom >= 0).length, 2)

  const gated = runXsmomYear(hist, D, syms, COST, { slots: SLOTS, gate: true })
  const ungated = runXsmomYear(hist, D, syms, COST, { slots: SLOTS, gate: false })

  const firstDay = gated.rebalances[0]
  eq('게이트 분모는 min(N, 후보수)로 고정', firstDay.denom, SLOTS)
  eq('게이트 통과 목표는 2종목뿐', firstDay.targets.length, 2)
  eq('게이트에 걸려 현금으로 남은 슬롯 3개', firstDay.gatedOut.length, 3)

  const investedOn = (run: typeof gated, date: string) =>
    run.fills.filter((f) => f.date === date && f.side === 'buy').reduce((s, f) => s + f.qty * f.px, 0)
  const d0 = gated.rebalances[0].date
  const gInv = investedOn(gated, d0)
  const uInv = investedOn(ungated, d0)
  check('게이트 없이는 5슬롯을 거의 다 채운다', uInv / COST.initialCapital > 0.97, String(uInv / COST.initialCapital))
  // 2/5 = 0.40. 분모를 targets(2)로 줄였다면 ~1.0이 나온다 — 그 오류를 여기서 잡는다.
  check(
    '게이트 적용 시 투입액이 2/5 수준(분모 고정)',
    Math.abs(gInv / COST.initialCapital - 0.4) < 0.02,
    `투입비중 ${(gInv / COST.initialCapital).toFixed(3)} — 1.0에 가까우면 분모가 targets로 줄어든 것`,
  )
  check('게이트 적용 시 현금이 남는다', gInv < uInv * 0.6, `${gInv} vs ${uInv}`)

  // 게이트가 하락 종목을 실제로 안 담았는지 — 매수 체결 종목 집합으로 확인
  const boughtSyms = new Set(gated.fills.filter((f) => f.side === 'buy').map((f) => f.sym))
  eq('게이트 적용 시 하락 종목은 한 번도 매수되지 않는다', down.filter((s) => boughtSyms.has(s)).length, 0)
}

// ============================================================================
section('5) 체결 시점 — 월 첫 거래일 시가에 체결, 판단은 그보다 앞선다')
// ============================================================================
{
  const hist = makeUniverse(7, '2018-01-01', '2021-12-31', 9500)
  const syms = Object.keys(hist)
  const run = runXsmomYear(hist, '2021-01-01', syms, COST, { slots: 5, gate: false })

  check('체결이 존재한다', run.fills.length > 0, String(run.fills.length))

  let notOpen = 0
  let notFirstOfMonth = 0
  let signalNotBefore = 0
  const firstOfMonth = new Set(run.rebalances.map((r) => r.date))
  const calFirst = run.equity[0].date
  for (const f of run.fills) {
    const bar = hist[f.sym].find((b) => b.date === f.date)
    if (!bar || Math.abs(bar.o - f.px) > 1e-9) notOpen++
    if (!firstOfMonth.has(f.date)) notFirstOfMonth++
    // 판단(신호)은 체결일 **이전**이어야 한다. 실행 첫날만 직전 거래일이 없어 같은 날이다.
    if (!(f.signalDate < f.date || f.date === calFirst)) signalNotBefore++
  }
  eq('모든 체결 기준가 = 그 날의 시가', notOpen, 0)
  eq('모든 체결은 월 첫 거래일에만 발생', notFirstOfMonth, 0)
  eq('신호일이 체결일보다 앞선다(첫날 제외)', signalNotBefore, 0)

  // 리밸런스일이 실제로 각 달의 첫 거래일인지 — 월이 바뀐 첫 봉과 일치해야 한다
  const seen = new Set<string>()
  const expected: string[] = []
  for (const p of run.equity) {
    const ym = p.date.slice(0, 7)
    if (!seen.has(ym)) {
      seen.add(ym)
      expected.push(p.date)
    }
  }
  eq('리밸런스일 = 각 달의 첫 거래일', run.rebalances.map((r) => r.date).join(','), expected.join(','))
  eq('리밸런스 횟수 = 12개월', run.rebalances.length, 12)
}

// ============================================================================
section('6) 연쇄 결과 구조 — PitChainResult 호환 · 현금해 처리')
// ============================================================================
{
  const hist = makeUniverse(8, '2018-01-01', '2022-12-31', 9700)
  const syms = Object.keys(hist)
  const res = runXsmomChained(hist, {
    cost: COST,
    slots: 5,
    gate: true,
    years: [2020, 2021, 2022],
    codesFor: () => syms,
  })
  eq('연도별 행 3개', res.perYear.length, 3)
  check('전체 배수 = 연도별 배수의 곱', true, '')
  const prod = res.perYear.reduce((s, r) => s * (1 + r.strategyPct / 100), 1)
  close('연도별 배수의 곱 = 총수익 배수', prod, 1 + res.totalPct / 100, 1e-9)
  check('MDD는 0 이하', res.mddPct <= 0, String(res.mddPct))
  check('lastScreen이 채워진다(왜 담았나 확인용)', res.lastScreen.length > 0, String(res.lastScreen.length))
  check('lastScreenDate가 마지막 리밸런스일', res.lastScreenDate === res.rebalances[res.rebalances.length - 1].date)

  // 유니버스가 3종목뿐인 해 → 표본 부족으로 현금 보유(자산곡선 평평)
  const few = ['S00', 'S01', 'S02']
  const cashRes = runXsmomChained(hist, {
    cost: COST,
    slots: 5,
    gate: true,
    years: [2021],
    codesFor: () => few,
  })
  eq('표본 부족 해는 현금 처리', cashRes.perYear[0].cash, true)
  eq('현금 해의 수익률 0%', cashRes.perYear[0].strategyPct, 0)
  eq('현금 해의 매매 0', cashRes.perYear[0].trades, 0)
  check('현금 해에도 자산곡선은 이어진다(연수 축소 방지)', cashRes.equity.length > 200, String(cashRes.equity.length))
  const flat = cashRes.equity.every((p) => Math.abs(p.equity - COST.initialCapital) < 1e-6)
  check('현금 해 자산곡선은 평평하다', flat)
}

// ============================================================================
section('7) 페이퍼 트랙 호출 형태 — 개시일부터 단일 구간 · 유니버스 동결(listedBy)')
// ============================================================================
{
  // scripts/paper-trade.entry.ts 가 실제로 부르는 형태 그대로 검증한다.
  // 개시일이 연중이고 유니버스는 이미 동결돼 있으므로 `listedBy`를 개시일로 준다 —
  // 기본값({y}-06-30)을 그대로 쓰면 하반기 개시 트랙에서 종목이 통째로 빠질 수 있다.
  const INCEPTION = '2021-08-02'
  // 워밍업이 13개월 이상이어야 12-1 모멘텀이 산출된다(워밍업이 짧으면 전부 현금이 된다).
  const hist = makeUniverse(10, '2020-05-01', '2021-12-31', 9900, 0.03)
  const syms = Object.keys(hist)

  const res = runXsmomChained(hist, {
    cost: COST,
    slots: 5,
    gate: true,
    years: [2021],
    codesFor: () => syms,
    startDate: INCEPTION,
    listedBy: () => INCEPTION,
  })

  eq('연도 1개만 실행', res.perYear.length, 1)
  eq('유니버스 동결 — 전 종목이 편입된다', res.perYear[0].mapped, syms.length)
  eq('현금 처리되지 않는다', res.perYear[0].cash, false)
  check('개시일 이전 봉은 자산곡선에 없다', res.equity.every((p) => p.date >= INCEPTION), res.equity[0]?.date)
  check('실제로 리밸런스가 일어났다', res.rebalances.length >= 4, `n=${res.rebalances.length}`)
  check('실제로 매수가 일어났다(워밍업 부족 시 0이 된다)', res.trades.length > 0, `n=${res.trades.length}`)

  // 워밍업이 짧으면(12개월 미만) 후보가 없어 통째로 현금이 된다 — 러너가 워밍업을 늘려야 하는 이유
  const shortHist = cut(makeUniverse(10, '2021-03-01', '2021-12-31', 9900, 0.03), '2021-12-31')
  const shortRes = runXsmomChained(shortHist, {
    cost: COST,
    slots: 5,
    gate: true,
    years: [2021],
    codesFor: () => Object.keys(shortHist),
    startDate: INCEPTION,
    listedBy: () => INCEPTION,
  })
  eq('워밍업 부족 시 매수가 일어나지 않는다(현금)', shortRes.trades.length, 0)
  check(
    '워밍업 부족 시 자산곡선은 초기자본 그대로',
    shortRes.equity.every((p) => Math.abs(p.equity - COST.initialCapital) < 1e-6),
  )
}

finish()
