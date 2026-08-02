// 화면·사전계산의 KR 시세 로드 규약 집행자 — 2026-08-02 확정 버그의 회귀 방지.
//
// 무엇이 잘못됐었나 (GHA MODE=presetdiag 실측):
//   화면(SpecSimulator)·사전계산(preset-precompute)은 `.KS`→`.KQ` 순으로 **첫 성공(1봉 이상)에서
//   중단**했다. 그런데 Yahoo는 다수 코스닥 종목의 `.KS` 쿼리에 **11봉짜리(2026-07-16 시작) 가짜
//   시계열**을 돌려준다. 그 짧은 계열이 채택되면 `bars[0].date <= {해}-06-30` 편입 판정에서
//   **142 종목-해가 유니버스에서 통째로 빠지고**(평균 매핑률 98%→71%), 워밍업 부재(2000-01-01
//   시작)까지 겹쳐 연쇄 첫 해의 `maBreak` 청산·모멘텀 후보가 통째로 죽었다.
//
// 여기서 지키는 것
//   1) 듀얼 로더 — `.KQ`/`.KS` 둘 다 시도 · **긴 이력 채택** · 200봉 미만은 채택 자체를 포기 ·
//      200봉 이상을 만나면 조기 중단. 연구 정본(`fetchKrDual` ≡ presetDiag `pickResearch`)과 **동형**.
//   2) 워밍업 — 1999년 봉이 있으면 연쇄 첫 해(2000년)에 `maBreak` 청산·모멘텀 후보가 **정상 동작**하고,
//      없으면 그 해만 규칙이 다르게 작동한다. 워밍업 봉이 곡선 시작을 앞당기지 않는다(시작은 2000년).
//   3) 규칙 1(미래참조 금지) — 워밍업은 **과거 방향** 데이터 추가일 뿐이다. 워밍업이 붙은 상태에서도
//      절단 불변성(뒷구간을 잘라내도 앞 구간이 완전히 동일)이 유지되는지 확인한다.
//
// 네트워크를 타지 않는다. 조회는 주입한 가짜 함수, 시세는 합성 시계열이다(컨테이너에서 Yahoo는 403).

import { check, eq, finish, section } from './harness'
import { KR_MIN_BARS, KR_SUFFIXES, loadKrDual } from '../src/lib/history'
import { pickResearch, type SuffixProbe } from '../scripts/lib/presetDiag'
import { runPitChained } from '../src/features/backtest/pitChain'
import { runXsmomChained } from '../src/features/backtest/xsmomChain'
import { SPEC_VERSION, type StrategySpec } from '../src/features/backtest/strategySpec'
import type { CostSettings } from '../src/features/backtest/conditionScreen'
import type { DailyBar } from '../src/features/backtest/types'

const COST: CostSettings = { initialCapital: 10_000_000, feePct: 0.015, taxPct: 0.15, slippagePct: 0.1 }

// ============================================================================
// 합성 시세 — 주말을 건너뛴 거래일 근사(엔진이 달력을 데이터에서 만든다)
// ============================================================================

interface PathSeg {
  /** 이 구간 마지막 날(포함) */
  to: string
  /** 일일 수익률 */
  drift: number
}

/** `from`부터 구간별 드리프트로 걷는 결정적 시계열(잡음 없음 — 재현성). */
function makeBars(from: string, segs: PathSeg[], base = 10_000): DailyBar[] {
  const bars: DailyBar[] = []
  let p = base
  const start = Date.parse(`${from}T00:00:00Z`)
  const end = Date.parse(`${segs[segs.length - 1].to}T00:00:00Z`)
  for (let t = start; t <= end; t += 86400000) {
    const d = new Date(t)
    const dow = d.getUTCDay()
    if (dow === 0 || dow === 6) continue
    const date = d.toISOString().slice(0, 10)
    const seg = segs.find((s) => date <= s.to) ?? segs[segs.length - 1]
    const o = p
    const c = Math.max(1, p * (1 + seg.drift))
    bars.push({
      date,
      t: Math.floor(t / 1000),
      o,
      h: Math.max(o, c) * 1.002,
      l: Math.min(o, c) * 0.998,
      c,
      v: 1_000_000,
    })
    p = c
  }
  return bars
}

const barsFrom = (bars: DailyBar[], from: string) => bars.filter((b) => b.date >= from)

/** 심볼 → 봉 수. 값이 없으면 조회 실패(예외)로 흉내 낸다. */
function fakeLoader(table: Record<string, number>) {
  const calls: string[] = []
  const fetchOne = async (sym: string): Promise<{ sym: string; n: number }> => {
    calls.push(sym)
    const n = table[sym]
    if (n == null) throw new Error(`HTTP 404 (${sym})`)
    return { sym, n }
  }
  return { calls, fetchOne, countOf: (v: { sym: string; n: number }) => v.n }
}

/** 같은 표를 연구 정본(presetDiag `pickResearch`)에 먹여 채택 심볼을 뽑는다. */
function researchPick(code: string, table: Record<string, number>): string | null {
  const probes: Record<string, SuffixProbe | undefined> = {}
  for (const suffix of KR_SUFFIXES) {
    const sym = `${code}${suffix}`
    const n = table[sym]
    if (n == null) continue
    probes[suffix] = {
      sym,
      suffix,
      range: 'since:1999-01-01',
      ok: true,
      bars: n,
      start: '',
      startAtOrAfter: '',
      end: '',
      adjBars: 0,
      adjNonUnitBars: 0,
      error: '',
    }
  }
  return pickResearch(probes)?.sym ?? null
}

async function testDualLoader(): Promise<void> {
  section('1) 듀얼 로더 — .KQ/.KS 둘 다 보고 긴 이력을 채택한다')
  eq('접미사 순서가 연구 정본과 같다(.KQ 먼저)', KR_SUFFIXES.join(','), '.KQ,.KS')
  eq('최소 봉 수 게이트', KR_MIN_BARS, 200)

  // (a) 확정 버그 그대로 — `.KS`가 11봉 가짜, `.KQ`가 진짜 6,000봉
  {
    const table = { '035720.KQ': 6000, '035720.KS': 11 }
    const f = fakeLoader(table)
    const picked = await loadKrDual('035720', f.fetchOne, f.countOf)
    eq('가짜 11봉이 아니라 긴 쪽을 채택', picked?.symbol, '035720.KQ')
    eq('채택 봉 수', picked?.barCount, 6000)
    eq('200봉 이상을 먼저 만나 조기 중단(왕복 1회)', f.calls.length, 1)
  }

  // (b) 순서가 반대인 경우 — `.KQ`가 가짜 11봉, `.KS`가 진짜. **둘 다 조회해야** 잡힌다.
  {
    const table = { '005930.KQ': 11, '005930.KS': 6500 }
    const f = fakeLoader(table)
    const picked = await loadKrDual('005930', f.fetchOne, f.countOf)
    eq('먼저 온 짧은 계열을 버리고 긴 쪽 채택', picked?.symbol, '005930.KS')
    eq('두 접미사를 모두 조회했다', f.calls.length, 2)
    eq('시도 기록도 2건', picked?.attempts.length, 2)
  }

  // (c) 200봉 게이트 — 양쪽 다 짧으면 **채택하지 않는다**(유니버스에서 빠지는 게 정답)
  {
    const table = { '999999.KQ': 11, '999999.KS': 199 }
    const f = fakeLoader(table)
    const picked = await loadKrDual('999999', f.fetchOne, f.countOf)
    eq('둘 다 200봉 미만이면 null', picked, null)
    eq('그래도 양쪽을 다 봤다', f.calls.length, 2)
  }
  {
    // 경계값 — 정확히 200봉이면 채택된다(게이트는 `>=`)
    const f = fakeLoader({ '111111.KQ': 200 })
    const picked = await loadKrDual('111111', f.fetchOne, f.countOf)
    eq('정확히 200봉은 채택', picked?.barCount, 200)
  }

  // (d) 한쪽 조회 실패는 예외로 새지 않고 다른 쪽으로 넘어간다
  {
    const f = fakeLoader({ '086520.KS': 3000 })
    const picked = await loadKrDual('086520', f.fetchOne, f.countOf)
    eq('.KQ 404여도 .KS로 채택', picked?.symbol, '086520.KS')
    eq('실패 사유가 시도 기록에 남는다', picked?.attempts[0].error.includes('404'), true)
  }
  {
    const f = fakeLoader({})
    const picked = await loadKrDual('000000', f.fetchOne, f.countOf)
    eq('양쪽 다 실패면 null(상장폐지 등)', picked, null)
  }

  // (e) betweenAttempts — 조기 중단하면 대기하지 않는다(불필요한 지연 방지)
  {
    let waits = 0
    const f1 = fakeLoader({ '035720.KQ': 6000, '035720.KS': 11 })
    await loadKrDual('035720', f1.fetchOne, f1.countOf, { betweenAttempts: async () => void waits++ })
    eq('조기 중단 시 대기 0회', waits, 0)
    const f2 = fakeLoader({ '005930.KQ': 11, '005930.KS': 6500 })
    await loadKrDual('005930', f2.fetchOne, f2.countOf, { betweenAttempts: async () => void waits++ })
    eq('두 번째 접미사를 볼 때만 1회 대기', waits, 1)
  }

  // (f) **동형 검증** — 연구 정본(`pickResearch`)과 채택 결과가 모든 조합에서 같다.
  //     여기가 깨지면 화면·사전계산이 다시 연구와 다른 시세를 쓰기 시작한 것이다.
  {
    const counts = [0, 11, 199, 200, 3000, 6500]
    let same = true
    let cases = 0
    for (const kq of counts) {
      for (const ks of counts) {
        const table: Record<string, number> = {}
        if (kq > 0) table['123456.KQ'] = kq
        if (ks > 0) table['123456.KS'] = ks
        const f = fakeLoader(table)
        const mine = (await loadKrDual('123456', f.fetchOne, f.countOf))?.symbol ?? null
        const theirs = researchPick('123456', table)
        cases++
        if (mine !== theirs) {
          same = false
          console.log(`    diff (kq=${kq}, ks=${ks}): loadKrDual=${mine} pickResearch=${theirs}`)
        }
      }
    }
    check(`연구 정본과 채택이 전 조합에서 동일 (${cases}조합)`, same)
  }
}

// ============================================================================
// 2) 워밍업 — 1999년 봉이 연쇄 첫 해(2000년)의 규칙을 정상 작동시킨다
// ============================================================================
//
// 시나리오: 1999년 내내 상승 → 2000년 1월 초까지 신고가 → 1월 중순부터 급락.
//   워밍업 있음: 2000-01-03에 이미 `highBreak(20)`·`sma(60)`이 계산되므로 1월 초 진입,
//                급락과 함께 60일선을 깨고 **1월 안에 청산**된다.
//   워밍업 없음: 2000-01-03에는 직전 20일 고가도 60일 이평도 없어 "데이터 부족" —
//                진입도 청산도 그 해 앞 구간에서 일어나지 않는다.

const WARM_FROM = '1999-01-02'
const COLD_FROM = '2000-01-01'
const PATH: PathSeg[] = [
  { to: '2000-01-14', drift: 0.004 }, // 1999~2000-01 중순: 꾸준한 상승(신고가 갱신)
  { to: '2000-06-30', drift: -0.006 }, // 급락 — 60일선을 아래로 깬다
  { to: '2000-12-31', drift: 0.002 }, // 완만한 회복
]
const SYMS = ['A', 'B', 'C', 'D', 'E', 'F']
const FULL: Record<string, DailyBar[]> = {}
SYMS.forEach((s, i) => {
  FULL[s] = makeBars(WARM_FROM, PATH, 10_000 + i * 1_000)
})
const WARM = FULL
const COLD: Record<string, DailyBar[]> = {}
for (const [s, bars] of Object.entries(FULL)) COLD[s] = barsFrom(bars, COLD_FROM)

const YEARS = [2000]
const codesFor = () => SYMS
const chainOpts = { years: YEARS, codesFor, minSymbols: 5 }

const makeSpec = (symbols: string[]): StrategySpec => ({
  version: SPEC_VERSION,
  id: 'warmup-test',
  name: '워밍업 검증',
  universe: {
    markets: ['KOSPI', 'KOSDAQ'],
    excludeAdministrative: true,
    excludeSuspended: true,
    excludeLiquidation: true,
    excludePreferred: true,
    excludeEtf: true,
    symbols,
  },
  entry: { op: 'and', nodes: [{ op: 'cond', id: '20일신고가', cond: { kind: 'highBreak', days: 20 } }] },
  ranking: { by: 'tradingValue', dir: 'desc' },
  exits: [{ kind: 'maBreak', maPeriod: 60, pct: 0 }],
  sizing: { maxPositions: 3, mode: 'equalSlot' },
  execution: { timing: 'sameClose', orderType: 'market' },
})

/** 60일 이평이 만들어지기 전 구간 — 워밍업이 없으면 여기서 아무 일도 일어날 수 없다 */
const EARLY = '2000-03-01'

function testWarmup(): void {
  section('2) 워밍업 — 1999년 봉이 있으면 첫 해 maBreak 청산이 정상 발동한다')
  const warm = runPitChained(WARM, makeSpec, COST, chainOpts)
  const cold = runPitChained(COLD, makeSpec, COST, chainOpts)

  const warmEarlyEntries = warm.trades.filter((t) => t.entryDate <= EARLY)
  const coldEarlyEntries = cold.trades.filter((t) => t.entryDate <= EARLY)
  check('워밍업 있음: 첫 해 앞 구간에 진입이 발생', warmEarlyEntries.length > 0, `${warmEarlyEntries.length}건`)
  eq('워밍업 없음: 앞 구간 진입 0건(직전 20일 고가 부재)', coldEarlyEntries.length, 0)

  // 청산 규칙은 maBreak 하나뿐이므로 앞 구간의 청산 = maBreak 발동이다.
  const warmEarlyExits = warm.trades.filter((t) => t.exitDate != null && t.exitDate <= EARLY)
  const coldEarlyExits = cold.trades.filter((t) => t.exitDate != null && t.exitDate <= EARLY)
  check('워밍업 있음: 첫 해 앞 구간에 청산(maBreak)이 발동', warmEarlyExits.length > 0, `${warmEarlyExits.length}건`)
  eq('워밍업 없음: 앞 구간 청산 0건(60일 이평 부재)', coldEarlyExits.length, 0)
  const warmMaBreak = warm.exitBreakdown.find((e) => e.kind === 'maBreak')?.count ?? 0
  check('워밍업 실행의 청산 내역에 maBreak가 잡힌다', warmMaBreak > 0, `${warmMaBreak}건`)

  check(
    '두 실행의 2000년 성적이 실제로 갈린다(무의미한 통과 방지)',
    !Object.is(warm.perYear[0].strategyPct, cold.perYear[0].strategyPct),
    `warm=${warm.perYear[0]?.strategyPct} cold=${cold.perYear[0]?.strategyPct}`,
  )

  // 워밍업은 **입력만** 늘린다 — 곡선 시작(=백테스트 시작)은 그대로 2000년이어야 한다.
  check('워밍업이 곡선 시작을 1999년으로 앞당기지 않는다', warm.equity[0].date >= '2000-01-01', warm.equity[0].date)
  eq('곡선 시작일이 워밍업 유무와 무관하게 같다', warm.equity[0].date, cold.equity[0].date)
  eq('실행 구간 시작(startDate)도 동일', warm.startDate, cold.startDate)
}

function testMomentumWarmup(): void {
  section('3) 워밍업 — 모멘텀(12-1) 후보가 첫 해에 살아난다')
  const opts = { cost: COST, slots: 3, gate: false, years: YEARS, codesFor }
  const warm = runXsmomChained(WARM, opts)
  const cold = runXsmomChained(COLD, opts)

  const warmPicked = warm.rebalances.reduce((n, r) => n + r.targets.length, 0)
  const coldPicked = cold.rebalances.reduce((n, r) => n + r.targets.length, 0)
  check('워밍업 있음: 2000년 리밸런스에 후보가 뽑힌다', warmPicked > 0, `${warmPicked}슬롯`)
  eq('워밍업 없음: 12개월 창이 안 차 후보 0(전량 현금)', coldPicked, 0)

  // haircut 옵션은 화면·사전계산에서 켠다 — 방향이 보수적(성적을 낮춤)인지 여기서 못 박는다.
  const off = runXsmomChained(WARM, opts)
  const on = runXsmomChained(WARM, { ...opts, applyLiquidationHaircut: true })
  check('haircut ON은 OFF보다 성적이 낮다(비용이므로)', on.totalPct < off.totalPct, `on=${on.totalPct} off=${off.totalPct}`)
}

function testTruncationInvariance(): void {
  section('4) 절단 불변성 — 워밍업이 붙어도 미래를 보지 않는다 (규칙 1)')
  const CUT = '2000-06-30'
  const truncated: Record<string, DailyBar[]> = {}
  for (const [s, bars] of Object.entries(WARM)) truncated[s] = bars.filter((b) => b.date <= CUT)

  const full = runPitChained(WARM, makeSpec, COST, chainOpts)
  const cut = runPitChained(truncated, makeSpec, COST, chainOpts)

  const fullBefore = full.trades.filter((t) => t.entryDate <= CUT)
  const cutBefore = cut.trades.filter((t) => t.entryDate <= CUT)
  check('절단 이전 매매가 0건이 아니다(무의미한 통과 방지)', fullBefore.length > 0, `${fullBefore.length}건`)
  eq('절단 이전 매매 건수 동일', cutBefore.length, fullBefore.length)
  let tradesSame = true
  for (let i = 0; i < Math.min(fullBefore.length, cutBefore.length); i++) {
    const a = fullBefore[i]
    const b = cutBefore[i]
    if (a.symbol !== b.symbol || a.entryDate !== b.entryDate || a.entryPrice !== b.entryPrice || a.qty !== b.qty) {
      tradesSame = false
      console.log(`    trade diff #${i}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`)
    }
    if (a.exitDate != null && a.exitDate <= CUT) {
      if (a.exitDate !== b.exitDate || a.exitPrice !== b.exitPrice || !Object.is(a.pnlPct, b.pnlPct)) {
        tradesSame = false
        console.log(`    exit diff #${i}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`)
      }
    }
  }
  check('절단 이전 매매의 진입·청산이 완전히 동일', tradesSame)

  const fullEq = full.equity.filter((p) => p.date <= CUT)
  const cutEq = cut.equity.filter((p) => p.date <= CUT)
  eq('절단 이전 자산곡선 길이 동일', cutEq.length, fullEq.length)
  let eqSame = fullEq.length === cutEq.length
  for (let i = 0; i < Math.min(fullEq.length, cutEq.length); i++) {
    if (fullEq[i].date !== cutEq[i].date || fullEq[i].equity !== cutEq[i].equity) {
      eqSame = false
      console.log(`    equity diff @${fullEq[i].date}: ${fullEq[i].equity} vs ${cutEq[i].equity}`)
      break
    }
  }
  check('절단 이전 자산곡선이 완전히 동일', eqSame)
  check('자산곡선이 비어 있지 않다(무의미한 통과 방지)', fullEq.length > 50, `${fullEq.length}점`)

  // 모멘텀 경로도 같은 절단으로 확인한다(워밍업 봉이 랭킹에 미래를 흘리지 않는지)
  const mOpts = { cost: COST, slots: 3, gate: false, years: YEARS, codesFor }
  const mFull = runXsmomChained(WARM, mOpts)
  const mCut = runXsmomChained(truncated, mOpts)
  const rFull = mFull.rebalances.filter((r) => r.date <= CUT)
  const rCut = mCut.rebalances.filter((r) => r.date <= CUT)
  check('절단 이전 리밸런스가 0건이 아니다', rFull.length > 0, `${rFull.length}건`)
  eq('절단 이전 리밸런스 건수 동일', rCut.length, rFull.length)
  let rebSame = rFull.length === rCut.length
  for (let i = 0; i < Math.min(rFull.length, rCut.length); i++) {
    if (rFull[i].date !== rCut[i].date || rFull[i].targets.join(',') !== rCut[i].targets.join(',')) {
      rebSame = false
      console.log(`    rebalance diff @${rFull[i].date}: ${rFull[i].targets} vs ${rCut[i].targets}`)
      break
    }
  }
  check('절단 이전 리밸런스 대상이 완전히 동일', rebSame)
}

async function main(): Promise<void> {
  await testDualLoader()
  testWarmup()
  testMomentumWarmup()
  testTruncationInvariance()
}

main().then(finish, (e) => {
  console.error(`테스트 실행 중 예외: ${e?.stack ?? e}`)
  process.exit(1)
})
