// ⚠️ 이 파일은 MODE=screen(미검증 랭킹 4계열 스크리너)에 대한 CLAUDE.md 규칙 1(미래참조
// 금지)의 집행자이자, xsmom을 공용 러너로 일반화한 리팩토링의 **바이트 불변 집행자**다.
//
// 여기서 검증하는 것:
//
//   1) 골든 지문 — xsmom 산출물이 리팩토링 **이전**과 바이트 단위로 같다. 공용 러너
//      (simulateRankYear)로 갈아 끼우면서 25차에서 검증이 끝난 경로가 조용히 달라지는 것을
//      막는다. 지문은 리팩토링 전 코드로 캡처한 값이며 새 코드가 그것을 재현해야 한다.
//   2) 랭킹 창의 오른쪽 경계 — 네 계열 전부 **리밸런스 달 1일 이후**를 보지 않는다.
//      그 구간을 3배로 조작해도 점수가 불변이어야 한다(당일·당월 제외 · 규칙 1-1,1-3).
//   3) 각 계열 점수의 산술 — 손으로 만든 봉과 손계산 대조.
//   4) 랭킹 방향 — "작을수록 좋은" 지표(저변동성·단기반전)의 부호가 뒤집혀 들어갔는가.
//      부호가 하나 뒤집히면 정반대 전략을 돌리고도 표는 멀쩡해 보인다.
//   5) 시뮬 절단 불변성 — 뒷부분을 잘라도 잘린 시점 이전의 체결·자산곡선이 완전히 동일(4계열).
//   6) 게이트 규약 — 슬롯 분모는 게이트와 무관하게 고정되고, 걸러진 슬롯은 **현금**으로 남는다.
//   7) 판정 로직 — 계열 대표 선정(알파 최고)과 채택 3조건.
//
// 실데이터(Yahoo)는 컨테이너에서 403이라 전부 합성 시계열로 검증한다.

import { createHash } from 'node:crypto'
import { check, close as closeTo, eq, section, finish, rng } from './harness'
import {
  HI52_GATE,
  PIT1010,
  SCREEN_FAMILIES,
  SCREEN_MIN_TRADES,
  VOLRANK_FAST,
  VOLRANK_GATE,
  VOLRANK_SLOW,
  buildYearly,
  familyVerdictTable,
  hi52Ratio,
  hi52Rank,
  idxBefore,
  judgeFamily,
  lastCloseBefore,
  lowVolRank,
  lowVolStdev,
  momentum12_1,
  runCustomChain,
  shiftMonthStart,
  shortRevRank,
  shortRevReturn,
  simulateRankYear,
  simulateXsMomYear,
  volRankRank,
  volSurgeRatio,
  xsmomRank,
  type FamilyVerdict,
  type Perf,
  type RankFn,
  type RankRow,
  type ScreenFamily,
  type StratRow,
} from '../scripts/idea-lab.entry'
import type { CostSettings } from '../src/features/backtest/conditionScreen'
import type { DailyBar } from '../src/features/backtest/types'

const COST: CostSettings = { initialCapital: 10_000_000, feePct: 0.015, taxPct: 0.15, slippagePct: 0.1 }

// ---- 합성 데이터 (idealab.test.ts와 **같은 생성기** — 골든 지문이 이 값에 걸려 있다) ----

const dayOf = (i: number) => new Date(Date.UTC(1999, 0, 1) + i * 86400000).toISOString().slice(0, 10)

function makeBars(seed: number, n: number, base = 10_000): DailyBar[] {
  const rnd = rng(seed)
  const bars: DailyBar[] = []
  let p = base
  for (let i = 0; i < n; i++) {
    const ret = 0.0004 + 0.025 * (rnd() * 2 - 1)
    const o = p
    const c = Math.max(1, p * (1 + ret))
    bars.push({
      date: dayOf(i),
      t: 0,
      o,
      h: Math.max(o, c) * (1 + rnd() * 0.012),
      l: Math.min(o, c) * (1 - rnd() * 0.012),
      c,
      v: 1_000_000 + Math.floor(rnd() * 1_000_000),
    })
    p = c
  }
  return bars
}

/** 잡음 없는 단조 시계열 — 게이트가 "전 종목 탈락"임을 확정적으로 만든다. */
function driftBars(n: number, base: number, drift: number, vol = 1_000_000): DailyBar[] {
  const bars: DailyBar[] = []
  let p = base
  for (let i = 0; i < n; i++) {
    const o = p
    const c = Math.max(1, p * (1 + drift))
    bars.push({ date: dayOf(i), t: 0, o, h: Math.max(o, c) * 1.002, l: Math.min(o, c) * 0.998, c, v: vol })
    p = c
  }
  return bars
}

const YEARS = [2000, 2001, 2002, 2003, 2004, 2005]
const N_DAYS = 2600
const CODES = [...new Set(YEARS.flatMap((y) => [...PIT1010[y].ks, ...PIT1010[y].kq]))]
const HISTORIES: Record<string, DailyBar[]> = {}
CODES.forEach((cd, i) => (HISTORIES[cd] = makeBars(20260802 + i * 977, N_DAYS, 5_000 + i * 137)))

function truncate(h: Record<string, DailyBar[]>, cutDate: string): Record<string, DailyBar[]> {
  const out: Record<string, DailyBar[]> = {}
  for (const [s, bars] of Object.entries(h)) out[s] = bars.filter((b) => b.date <= cutDate)
  return out
}

// ============================================================================
section('1) 골든 지문 — xsmom이 공용 러너 리팩토링 전과 바이트 단위로 같다')
// ============================================================================
{
  // 아래 지문은 **리팩토링 이전 코드**(simulateXsMomYear가 자체 루프를 갖고 있던 판)로
  // 캡처한 값이다. 지금 코드는 simulateRankYear에 12-1 랭킹을 끼운 구조인데, 그 결과가
  // 이 지문을 재현하지 못하면 "결과는 그대로 두고 구조만 바꾼다"는 전제가 깨진 것이다.
  // 지문이 깨졌는데 새 동작이 옳다고 판단되면, 왜 옳은지를 PR에 남기고 상수를 갱신할 것.
  const GOLDEN_LINES = 17583
  const GOLDEN_SHA256 = 'd988a16ff746cc9e5dc5e3b25ee703fb54cc69169178c1ad42639801fc9c585c'

  const parts: string[] = []
  for (const slots of [5, 10]) {
    for (const gate of [false, true]) {
      for (const y of [2001, 2003]) {
        const syms = [...PIT1010[y].ks, ...PIT1010[y].kq]
        const r = simulateXsMomYear(HISTORIES, `${y}-01-01`, syms, COST, { slots, gate })
        parts.push(`SIM ${slots} ${gate} ${y}`)
        for (const e of r.equity) parts.push(`E ${e.date} ${e.equity.toExponential(17)}`)
        for (const f of r.fills)
          parts.push(`F ${f.date} ${f.sym} ${f.side} ${f.px.toExponential(17)} ${f.qty} ${f.signalDate}`)
        parts.push(`S ${r.closed} ${r.wins} ${r.openAtEnd}`)
      }
    }
  }
  for (const d of ['2001-03-05', '2003-07-01', '2005-01-03']) {
    for (const r of xsmomRank(HISTORIES, CODES, d)) parts.push(`R ${d} ${r.sym} ${r.mom.toExponential(17)}`)
  }
  const yearly = buildYearly(HISTORIES, YEARS)
  const chain = runCustomChain(
    yearly,
    (v) => simulateXsMomYear(v.hist, `${v.y}-01-01`, v.syms, COST, { slots: 5, gate: true }),
    COST,
    5,
  )
  for (const e of chain.equity) parts.push(`C ${e.date} ${e.equity.toExponential(17)}`)
  for (const p of chain.perYear) parts.push(`Y ${p.y} ${p.ret.toExponential(17)} ${p.mapped}`)
  parts.push(`CS ${chain.closed} ${chain.wins}`)

  eq('지문 표본 수 동일', parts.length, GOLDEN_LINES)
  eq('xsmom 산출물 지문 동일 (리팩토링 바이트 불변)', createHash('sha256').update(parts.join('\n')).digest('hex'), GOLDEN_SHA256)

  // 래퍼가 정말 공용 러너를 부르는지 — 같은 인자로 두 경로가 완전히 일치해야 한다
  const syms = PIT1010[2003].ks
  const viaWrapper = simulateXsMomYear(HISTORIES, '2001-01-01', syms, COST, { slots: 5, gate: true })
  const viaRunner = simulateRankYear(HISTORIES, '2001-01-01', syms, COST, {
    slots: 5,
    rank: xsmomRank,
    keep: (r) => r.aux >= 0,
  })
  check(
    'simulateXsMomYear = simulateRankYear(xsmomRank, 절대모멘텀 게이트)',
    viaWrapper.equity.length === viaRunner.equity.length &&
      viaWrapper.equity.every((e, i) => e.date === viaRunner.equity[i].date && Object.is(e.equity, viaRunner.equity[i].equity)) &&
      viaWrapper.fills.length === viaRunner.fills.length &&
      viaWrapper.fills.every((f, i) => f.sym === viaRunner.fills[i].sym && Object.is(f.px, viaRunner.fills[i].px)),
    `${viaWrapper.fills.length} vs ${viaRunner.fills.length}`,
  )
  // xsmomRank의 mom은 score·aux와 같은 값이어야 한다(호환 필드가 조용히 갈라지면 게이트가 틀어진다)
  const ranked = xsmomRank(HISTORIES, CODES, '2003-07-01')
  check('mom = score = aux', ranked.every((r) => Object.is(r.mom, r.score) && Object.is(r.mom, r.aux)), `${ranked.length}`)
}

// ============================================================================
section('2) 창 경계 — 네 계열 전부 리밸런스 달 1일 이후를 보지 않는다')
// ============================================================================
{
  // ---- idxBefore = 경계 **미포함** ------------------------------------------
  const bars = HISTORIES[CODES[0]]
  const n = bars.filter((b) => b.date < '2001-02-01').length
  eq('idxBefore = 경계 미만 봉 수', idxBefore(bars, '2001-02-01'), n)
  eq('경계 직전 종가와 짝이 맞는다', lastCloseBefore(bars, '2001-02-01'), bars[n - 1].c)
  eq('데이터 이전 시점은 0', idxBefore(bars, '1998-01-01'), 0)
  eq('데이터 이후 시점은 전체 길이', idxBefore(bars, '2099-01-01'), bars.length)

  // ---- 리밸런스 달(D의 달) 전체를 3배로 조작해도 점수 불변 -------------------
  // 당일만이 아니라 **그 달 전체**를 조작한다 — 창의 오른쪽 경계가 달의 1일이기 때문이다.
  const D = '2003-07-01'
  const cut = shiftMonthStart(D, 0)
  const tamper = (bs: DailyBar[]) =>
    bs.map((x) => (x.date >= cut ? { ...x, o: x.o * 3, h: x.h * 3, l: x.l * 3, c: x.c * 3, v: x.v * 7 } : x))

  const scorers: { name: string; f: (b: DailyBar[], d: string) => number | null }[] = [
    { name: 'lowvol σ', f: (b, d) => lowVolStdev(b, d) },
    { name: 'hi52 근접도', f: (b, d) => hi52Ratio(b, d) },
    { name: 'strev 1개월 수익', f: (b, d) => shortRevReturn(b, d) },
    { name: 'volrank 급증비', f: (b, d) => volSurgeRatio(b, d) },
  ]
  for (const s of scorers) {
    const base = s.f(bars, D)
    check(`${s.name}: 값이 산출된다`, base != null && Number.isFinite(base), `${base}`)
    eq(`${s.name}: 당월 이후를 조작해도 불변(미래 미포함)`, s.f(tamper(bars), D), base)
  }

  // 랭킹 전체도 같아야 한다 — 계열 러너가 보는 것이 점수 함수뿐임을 확인
  const tamperedAll: Record<string, DailyBar[]> = {}
  for (const [k, v] of Object.entries(HISTORIES)) tamperedAll[k] = tamper(v)
  const ranks: { name: string; f: RankFn }[] = [
    { name: 'lowvol', f: lowVolRank },
    { name: 'hi52', f: hi52Rank },
    { name: 'strev', f: shortRevRank },
    { name: 'volrank', f: volRankRank },
  ]
  for (const r of ranks) {
    const a = r.f(HISTORIES, CODES, D)
    const b = r.f(tamperedAll, CODES, D)
    check(
      `${r.name} 랭킹: 당월 이후 조작에도 순위·점수 불변`,
      a.length > 5 && a.length === b.length && a.every((x, i) => x.sym === b[i].sym && Object.is(x.score, b[i].score) && Object.is(x.aux, b[i].aux)),
      `${a.length} vs ${b.length}`,
    )
  }
}

// ============================================================================
section('3) 계열 점수 산술 — 손으로 만든 봉과 손계산 대조')
// ============================================================================
{
  // 창 = [2001-02-01, 2001-03-01) 이 되도록 D=2001-03-01 · months=1
  // 인덱스 0(01-31)은 창 **왼쪽 밖**이라 어떤 계열도 읽으면 안 된다.
  const mk = (date: string, o: number, h: number, l: number, c: number, v: number): DailyBar => ({ date, t: 0, o, h, l, c, v })
  const hand: DailyBar[] = [
    mk('2001-01-31', 108.9, 1000, 1, 108.9, 9), // 창 밖 — 고가 1000은 hi52가 무시해야 한다
    mk('2001-02-01', 100, 121, 99, 100, 10),
    mk('2001-02-02', 110, 112, 108, 110, 10),
    mk('2001-02-03', 99, 100, 98, 99, 10),
    mk('2001-02-04', 108.9, 110, 107, 108.9, 10),
    mk('2001-02-05', 98.01, 99, 97, 98.01, 10),
    mk('2001-03-01', 500, 5000, 400, 500, 900), // 창 밖(당월) — 전 계열이 무시해야 한다
  ]
  const D = '2001-03-01'

  // 창 안 종가 100 → 110 → 99 → 108.9 → 98.01 이므로 일수익률은 +10%,−10%,+10%,−10%
  // 평균 0 · 모표준편차 0.1
  closeTo('lowvol σ = 0.1 (창 안 연속 종가쌍만)', lowVolStdev(hand, D, 1, 5)!, 0.1, 1e-12)

  // 근접도 = 창 오른쪽 끝 확정 종가(98.01) ÷ 창 안 최고 고가(121)
  closeTo('hi52 근접도 = 98.01/121', hi52Ratio(hand, D, 1, 5)!, 98.01 / 121, 1e-12)
  check('창 밖 고가 1000·5000을 최고가로 쓰지 않는다', hi52Ratio(hand, D, 1, 5)! > 0.8)

  // 직전 1개월 = (2월 마지막 확정 종가 98.01) ÷ (1월 마지막 확정 종가 108.9) − 1 = −0.1
  closeTo('strev 직전 1개월 수익 = −0.1', shortRevReturn(hand, D)!, -0.1, 1e-12)

  // 대금 = 종가×거래량. 창 안 5봉의 대금 = 1000,1100,990,1089,980.1
  // fast=2 → (1089+980.1)/2 = 1034.55 · slow=4 → (1100+990+1089+980.1)/4 = 1039.775
  closeTo('volrank 급증비 = fast2/slow4', volSurgeRatio(hand, D, 2, 4)!, 1034.55 / 1039.775, 1e-12)
  // 당월(03-01) 대금 450,000을 넣으면 값이 폭발한다 — 안 넣었음을 값으로 확인
  check('당월 대금 45만을 창에 넣지 않았다', volSurgeRatio(hand, D, 2, 4)! < 2, `${volSurgeRatio(hand, D, 2, 4)}`)

  // ---- 데이터 부족 → null(후보 제외) ----------------------------------------
  eq('12개월 창 못 채우면 lowvol null', lowVolStdev(hand, D), null)
  eq('12개월 창 못 채우면 hi52 null', hi52Ratio(hand, D), null)
  eq('60일 창 못 채우면 volrank null', volSurgeRatio(hand, D), null)
  eq('창 왼쪽 밖 봉이 없으면 null(신규 상장)', lowVolStdev(hand.slice(1), D, 1, 5), null)
  eq('직전 달 종가가 없으면 strev null', shortRevReturn(hand.slice(1), D), null)
  const bars = HISTORIES[CODES[0]]
  eq('12개월 미만 종목은 lowvol 후보 제외', lowVolStdev(bars.filter((x) => x.date >= '2003-01-01'), '2003-07-01'), null)
}

// ============================================================================
section('4) 랭킹 방향 — "작을수록 좋은" 지표의 부호가 뒤집혀 들어갔는가')
// ============================================================================
{
  // 부호가 하나 뒤집히면 정반대 전략을 돌리고도 표는 멀쩡해 보인다. 여기서 못 잡으면 못 잡는다.
  const D = '2003-07-01'

  // (a) lowvol — 변동성이 작은 종목이 상위
  const lv = lowVolRank(HISTORIES, CODES, D)
  check('lowvol: 후보가 있다', lv.length > 5, `${lv.length}`)
  check('lowvol: 점수 내림차순', lv.every((r, i) => i === 0 || lv[i - 1].score >= r.score))
  const sd = (s: string) => lowVolStdev(HISTORIES[s], D)!
  check('lowvol: **σ가 작은** 종목이 1위', lv.every((r) => sd(lv[0].sym) <= sd(r.sym)), `1위 σ=${sd(lv[0].sym)}`)
  check('lowvol: 점수 = −σ', lv.every((r) => Math.abs(r.score + sd(r.sym)) < 1e-12))

  // (b) hi52 — 근접도가 큰 종목이 상위
  const h5 = hi52Rank(HISTORIES, CODES, D)
  const ratio = (s: string) => hi52Ratio(HISTORIES[s], D)!
  check('hi52: **근접도가 큰** 종목이 1위', h5.every((r) => ratio(h5[0].sym) >= ratio(r.sym)), `1위=${ratio(h5[0].sym)}`)
  check('hi52: 점수 = 근접도', h5.every((r) => Object.is(r.score, ratio(r.sym))))

  // (c) strev — 가장 많이 **빠진** 종목이 상위
  const sr = shortRevRank(HISTORIES, CODES, D)
  const ret1m = (s: string) => shortRevReturn(HISTORIES[s], D)!
  check('strev: **가장 많이 빠진** 종목이 1위', sr.every((r) => ret1m(sr[0].sym) <= ret1m(r.sym)), `1위 수익=${ret1m(sr[0].sym)}`)
  check('strev: 점수 = −수익 · 보조값 = 수익 원값', sr.every((r) => Math.abs(r.score + r.aux) < 1e-15 && Object.is(r.aux, ret1m(r.sym))))
  check('strev 1위는 xsmom 1위와 다르다(반대 방향 지표임을 실제로 확인)', sr[0].sym !== xsmomRank(HISTORIES, CODES, D)[0].sym)

  // (d) volrank — 급증비가 큰 종목이 상위
  const vr = volRankRank(HISTORIES, CODES, D)
  const surge = (s: string) => volSurgeRatio(HISTORIES[s], D)!
  check('volrank: **급증비가 큰** 종목이 1위', vr.every((r) => surge(vr[0].sym) >= surge(r.sym)), `1위=${surge(vr[0].sym)}`)

  // (e) 동점·결정성 — 같은 점수면 심볼 오름차순, 두 번 불러도 같은 순서
  // 가격이 완전히 일정하면 σ가 전 종목 0이라 확정적 동점이 된다.
  const flat: Record<string, DailyBar[]> = {}
  for (const s of ['EEE', 'CCC', 'AAA', 'DDD', 'BBB']) flat[s] = driftBars(900, 1000, 0)
  const tied = lowVolRank(flat, ['EEE', 'CCC', 'AAA', 'DDD', 'BBB'], '2001-06-01')
  check('전제: 동점 테스트의 σ가 전부 0', tied.length === 5 && tied.every((r) => r.score === 0), `${tied.length}`)
  eq('동점이면 심볼 오름차순', tied.map((r) => r.sym).join(','), 'AAA,BBB,CCC,DDD,EEE')
  check('두 번 불러도 같은 순서(결정적)', volRankRank(HISTORIES, CODES, D).map((r) => r.sym).join(',') === vr.map((r) => r.sym).join(','))
}

// ============================================================================
section('5) 시뮬 절단 불변성 — 4계열 전부 (뒤를 잘라도 앞이 안 변한다)')
// ============================================================================
{
  const syms = PIT1010[2003].ks
  const CUT = '2004-07-20'
  const truncated = truncate(HISTORIES, CUT)
  const fams: { key: string; rank: RankFn }[] = [
    { key: 'lowvol', rank: lowVolRank },
    { key: 'hi52', rank: hi52Rank },
    { key: 'strev', rank: shortRevRank },
    { key: 'volrank', rank: volRankRank },
  ]
  for (const fam of fams) {
    const opts = { slots: 5, rank: fam.rank }
    const full = simulateRankYear(HISTORIES, '2001-01-01', syms, COST, opts)
    const cut = simulateRankYear(truncated, '2001-01-01', syms, COST, opts)
    const fe = full.equity.filter((e) => e.date <= CUT)
    const ce = cut.equity.filter((e) => e.date <= CUT)
    check(
      `[${fam.key}] 절단 전 자산곡선 동일 (${fe.length}점)`,
      fe.length > 900 && fe.length === ce.length && fe.every((e, i) => e.date === ce[i].date && Object.is(e.equity, ce[i].equity)),
      `full=${fe.length} cut=${ce.length}`,
    )
    const ff = full.fills.filter((f) => f.date <= CUT)
    const cf = cut.fills.filter((f) => f.date <= CUT)
    check(
      `[${fam.key}] 절단 전 체결 이력 동일 (${ff.length}건)`,
      ff.length > 10 &&
        ff.length === cf.length &&
        ff.every(
          (f, i) =>
            f.date === cf[i].date && f.sym === cf[i].sym && f.side === cf[i].side && Object.is(f.px, cf[i].px) && f.qty === cf[i].qty,
        ),
      `full=${ff.length} cut=${cf.length}`,
    )
    check(`[${fam.key}] 절단 후 구간은 달라진다(테스트가 실제로 무언가를 재고 있다)`, full.equity.length > cut.equity.length)

    // 체결은 월 첫 거래일 시가에만 — 계열이 바뀌어도 깔때기는 같다
    const monthFirst = new Set<string>()
    let curYm = ''
    for (const e of full.equity) {
      const ym = e.date.slice(0, 7)
      if (ym !== curYm) {
        curYm = ym
        monthFirst.add(e.date)
      }
    }
    check(`[${fam.key}] 모든 체결이 월 첫 거래일`, full.fills.every((f) => monthFirst.has(f.date)), `fills=${full.fills.length}`)
    const barAt = (sym: string, date: string) => HISTORIES[sym].find((x) => x.date === date)
    check(`[${fam.key}] 체결 기준가 = 그 날 시가`, full.fills.every((f) => Object.is(f.px, barAt(f.sym, f.date)?.o)))
  }
}

// ============================================================================
section('6) 게이트 — 분모는 고정 · 걸러진 슬롯은 현금')
// ============================================================================
{
  // ---- (a) 전 종목 탈락이면 매수 0 · 자본 불변(현금) -------------------------
  const syms = ['AAA', 'BBB', 'CCC', 'DDD', 'EEE']
  const down: Record<string, DailyBar[]> = {}
  const up: Record<string, DailyBar[]> = {}
  syms.forEach((s, i) => {
    down[s] = driftBars(1200, 10_000 + i * 100, -0.002)
    up[s] = driftBars(1200, 10_000 + i * 100, +0.002)
  })
  const allCash = (name: string, h: Record<string, DailyBar[]>, rank: RankFn, keep: (r: RankRow) => boolean) => {
    const gated = simulateRankYear(h, '2001-01-01', syms, COST, { slots: 5, rank, keep })
    const open = simulateRankYear(h, '2001-01-01', syms, COST, { slots: 5, rank })
    check(
      `${name}: 게이트 ON → 매수 0 · 자본 불변(현금)`,
      gated.fills.length === 0 && gated.equity.length > 100 && gated.equity.every((e) => Object.is(e.equity, COST.initialCapital)),
      `fills=${gated.fills.length}`,
    )
    check(`${name}: 게이트 OFF는 같은 데이터에서 매수가 일어난다`, open.fills.some((f) => f.side === 'buy'), `fills=${open.fills.length}`)
  }
  // 하락 일변도 → 절대모멘텀 음(−) · 52주 최고가에서 한참 멀다
  allCash('lowvol(절대모멘텀 게이트)', down, lowVolRank, (r) => r.aux >= 0)
  allCash('hi52(근접도 게이트)', down, hi52Rank, (r) => r.aux >= HI52_GATE)
  // 상승 일변도 → 직전 1개월 수익이 양(+) → "실제 하락분만" 게이트가 전부 거른다
  allCash('strev(실제 하락분 게이트)', up, shortRevRank, (r) => r.aux <= 0)
  // 거래량 일정 → 급증비 ≈ 1 < 1.5
  allCash('volrank(급증비 게이트)', up, volRankRank, (r) => r.aux >= VOLRANK_GATE)

  // 게이트가 정말 "그 조건"을 재고 있는지 — 하락장에서 절대모멘텀은 음수여야 한다
  check('전제 확인: 하락 시계열의 12-1 절대모멘텀 < 0', momentum12_1(down.AAA, '2002-01-01')! < 0)
  check('전제 확인: 상승 시계열의 직전 1개월 수익 > 0', shortRevReturn(up.AAA, '2002-01-01')! > 0)
}

{
  // ---- (b) 슬롯 분모 고정 — 5칸 중 1칸만 통과하면 **1/5만** 투자되고 나머지는 현금 ----
  // 가격은 전 종목 1000 고정, 거래량만 조작한다(가격 효과를 지운 순수 게이트 실험).
  const syms = ['AAA', 'BBB', 'CCC', 'DDD', 'EEE']
  const h: Record<string, DailyBar[]> = {}
  for (const s of syms) h[s] = driftBars(800, 1000, 0, 1000)
  // AAA만 리밸런스 직전 5일 거래대금을 5배로 — 급증비 3.75 > 1.5
  h.AAA = h.AAA.map((b) => (b.date >= '2000-12-27' && b.date < '2001-01-01' ? { ...b, v: 5000 } : b))

  const D0 = '2001-01-01'
  check('전제: AAA만 급증비가 게이트를 넘는다', volSurgeRatio(h.AAA, D0)! >= VOLRANK_GATE && syms.slice(1).every((s) => volSurgeRatio(h[s], D0)! < VOLRANK_GATE), `AAA=${volSurgeRatio(h.AAA, D0)}`)

  const gated = simulateRankYear(h, D0, syms, COST, { slots: 5, rank: volRankRank, keep: (r) => r.aux >= VOLRANK_GATE })
  const open = simulateRankYear(h, D0, syms, COST, { slots: 5, rank: volRankRank })
  const notionalOn = (r: { fills: { date: string; side: string; px: number; qty: number }[] }, date: string) =>
    r.fills.filter((f) => f.date === date && f.side === 'buy').reduce((s, f) => s + f.px * f.qty, 0)

  const gOn = notionalOn(gated, D0)
  const gOff = notionalOn(open, D0)
  eq('게이트 ON: 첫 리밸런스 매수 종목 = 1개', gated.fills.filter((f) => f.date === D0 && f.side === 'buy').length, 1)
  eq('게이트 OFF: 첫 리밸런스 매수 종목 = 5개', open.fills.filter((f) => f.date === D0 && f.side === 'buy').length, 5)
  check(
    '게이트 ON 투자금 ≈ 자본의 1/5 (분모를 5로 유지 — 남은 4칸은 현금)',
    gOn > COST.initialCapital * 0.19 && gOn < COST.initialCapital * 0.201,
    `${gOn}`,
  )
  check('게이트 OFF 투자금 ≈ 자본 전액', gOff > COST.initialCapital * 0.98, `${gOff}`)
  check(
    '게이트가 남은 종목에 레버리지를 걸지 않는다(ON ≈ OFF/5)',
    Math.abs(gOn - gOff / 5) < COST.initialCapital * 0.01,
    `on=${gOn} off/5=${gOff / 5}`,
  )
}

// ============================================================================
section('7) 계열·변형 정의 — 1~2관문 규약(계열당 변형 4개 이하)')
// ============================================================================
{
  eq('계열 4개', SCREEN_FAMILIES.length, 4)
  eq('계열 키', SCREEN_FAMILIES.map((f) => f.key).join(','), 'lowvol,hi52,strev,volrank')
  for (const fam of SCREEN_FAMILIES) {
    check(`[${fam.key}] 변형 4개 이하 (정밀 격자가 아니라 스크리닝)`, fam.variants.length <= 4 && fam.variants.length >= 2, `${fam.variants.length}`)
    check(`[${fam.key}] 변형 이름이 서로 다르다`, new Set(fam.variants.map((v) => v.label)).size === fam.variants.length)
    check(`[${fam.key}] 슬롯은 5 또는 10`, fam.variants.every((v) => v.slots === 5 || v.slots === 10))
    check(`[${fam.key}] 게이트 변형은 1개 이하`, fam.variants.filter((v) => v.keep).length <= 1)
    check(`[${fam.key}] 정의·근거 문장이 있다`, fam.def.length > 10 && fam.basis.length > 10)
  }
  eq('총 변형 수 12개', SCREEN_FAMILIES.reduce((s, f) => s + f.variants.length, 0), 12)
  eq('volrank 창 상수', `${VOLRANK_FAST}/${VOLRANK_SLOW}`, '5/60')

  // 계열 전체가 연쇄에서 실제로 돌아간다 — 스칼라만 남기고 곡선은 버린다(메모리 규약)
  const yearly = buildYearly(HISTORIES, YEARS)
  for (const fam of SCREEN_FAMILIES) {
    const v = fam.variants[0]
    const chain = runCustomChain(
      yearly,
      (y) => simulateRankYear(y.hist, `${y.y}-01-01`, y.syms, COST, { slots: v.slots, rank: fam.rank, keep: v.keep }),
      COST,
      v.slots,
    )
    check(`[${fam.key}] 연쇄가 자산곡선을 만든다`, chain.equity.length > 1000, `${chain.equity.length}`)
    eq(`[${fam.key}] 연쇄 길이 = 연도 수`, chain.perYear.length, YEARS.length)
    check(`[${fam.key}] 매매가 발생한다`, chain.closed > 0, `closed=${chain.closed}`)
    check(`[${fam.key}] 승리 수 ≤ 청산 수`, chain.wins >= 0 && chain.wins <= chain.closed, `${chain.wins}/${chain.closed}`)
  }
}

// ============================================================================
section('8) 판정 로직 — 계열 대표 선정(알파 최고)과 채택 3조건')
// ============================================================================
{
  const perf = (total: number, obj: number | null = 1): Perf => ({ total, cagr: total / 10, mdd: -10, obj, years: 20 })
  const row = (
    label: string,
    o: { total?: number; a?: number; b?: number; alphaFull?: number | null; alphaA?: number | null; alphaB?: number | null; closed?: number; obj?: number | null },
  ): StratRow => ({
    label,
    full: perf(o.total ?? 100, o.obj ?? 1),
    a: perf(o.a ?? 50),
    b: perf(o.b ?? 50),
    closed: o.closed ?? 100,
    wins: 50,
    alphaFull: o.alphaFull === undefined ? 1 : o.alphaFull,
    alphaA: o.alphaA === undefined ? 1 : o.alphaA,
    alphaB: o.alphaB === undefined ? 1 : o.alphaB,
    perYear: [],
  })
  const fam = SCREEN_FAMILIES[0]
  const base = row('기준선', { a: 40, b: 40 })

  // (a) 대표는 **알파 최고** 변형 — 총수익이 더 높아도 알파가 낮으면 대표가 아니다
  const v1 = judgeFamily(fam, base, [row('X 상위5', { alphaFull: 2 }), row('X 상위10', { total: 999, alphaFull: 1 })])
  eq('대표 = 알파 최고 변형(총수익 아님 · 규칙 5)', v1.best.label, 'X 상위5')

  // (b) 알파 동점이면 수익÷MDD로 가른다
  const v2 = judgeFamily(fam, base, [row('A', { alphaFull: 2, obj: 1 }), row('B', { alphaFull: 2, obj: 5 })])
  eq('알파 동점 → 수익÷MDD 우위', v2.best.label, 'B')

  // (c) 알파가 전부 null이면 그래도 대표는 하나 정해진다(표가 비지 않는다)
  const v3 = judgeFamily(fam, base, [row('A', { alphaFull: null, obj: 1 }), row('B', { alphaFull: null, obj: 3 })])
  eq('알파 전부 null이어도 대표가 정해진다', v3.best.label, 'B')

  // (d) 채택 3조건 — 전·후반 기준선 초과 · 전·후반 알파 양(+) · 표본
  const pass = judgeFamily(fam, base, [row('good', { a: 60, b: 60, alphaFull: 3, alphaA: 1, alphaB: 1, closed: 100 })])
  check('3조건 모두 만족 → 진행 권고', pass.advance && pass.bothHalves && pass.bothAlpha && pass.enoughTrades, pass.reason)
  eq('진행 권고면 사유는 비어 있다', pass.reason, '')

  const halfFail = judgeFamily(fam, base, [row('half', { a: 60, b: 30, alphaFull: 3, alphaA: 1, alphaB: 1 })])
  check('후반이 기준선 미달 → 종료', !halfFail.advance && !halfFail.bothHalves, halfFail.reason)
  check('사유에 한쪽 미달이 적힌다', halfFail.reason.includes('기준선 미달'), halfFail.reason)

  const alphaFail = judgeFamily(fam, base, [row('alpha', { a: 60, b: 60, alphaFull: 3, alphaA: 1, alphaB: -1 })])
  check('후반 알파 음(−) → 종료', !alphaFail.advance && !alphaFail.bothAlpha, alphaFail.reason)

  const nullAlpha = judgeFamily(fam, base, [row('nul', { a: 60, b: 60, alphaFull: 3, alphaA: null, alphaB: 1 })])
  check('알파를 못 재면(null) 통과로 치지 않는다', !nullAlpha.advance, nullAlpha.reason)

  const few = judgeFamily(fam, base, [row('few', { a: 60, b: 60, alphaFull: 3, alphaA: 1, alphaB: 1, closed: SCREEN_MIN_TRADES - 1 })])
  check('표본 부족 → 종료', !few.advance && !few.enoughTrades, few.reason)
  check('사유에 매매 수가 적힌다', few.reason.includes('표본 부족'), few.reason)

  const exact = judgeFamily(fam, base, [row('edge', { a: 60, b: 60, alphaFull: 3, alphaA: 1, alphaB: 1, closed: SCREEN_MIN_TRADES })])
  check(`매매 ${SCREEN_MIN_TRADES}건 경계는 통과`, exact.advance, exact.reason)

  const tie = judgeFamily(fam, base, [row('tie', { a: 40, b: 60, alphaFull: 3, alphaA: 1, alphaB: 1 })])
  check('기준선과 동률(초과 아님)은 통과가 아니다', !tie.advance && !tie.bothHalves, tie.reason)

  // (e) 표 렌더링이 죽지 않는다 — 보고 경로가 예외로 끊기면 러너 전체가 무의미해진다
  const verdicts: FamilyVerdict[] = SCREEN_FAMILIES.map((f: ScreenFamily) =>
    judgeFamily(f, base, [row(`${f.key} 상위5`, { alphaFull: null, alphaA: null, alphaB: null, closed: 0 })]),
  )
  let lines = 0
  let threw = ''
  const orig = console.log
  console.log = () => {
    lines++
  }
  try {
    familyVerdictTable(verdicts)
  } catch (e) {
    threw = String(e)
  } finally {
    console.log = orig
  }
  check('familyVerdictTable이 알파 null·매매 0에도 렌더링된다', threw === '' && lines > 6, threw || `lines=${lines}`)
}

finish()
