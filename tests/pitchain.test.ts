// ⚠️ 이 파일은 CLAUDE.md 규칙 1(미래참조 금지)을 **연도별 시점 고정 유니버스 연쇄 경로**에
// 적용하는 집행자다. 새 엔진 경로에는 절단 불변성 케이스가 반드시 함께 들어가야 한다.
//
// 검증 항목
//   1) 절단 불변성 — 뒷연도 봉을 통째로 잘라내도 앞 연도의 매매·연쇄 배수·자산곡선이 완전히 동일
//   2) 자본 이월 산술 — 전체 배수 = 연도별 배수의 곱
//   3) 매핑 5종목 미만인 해 = 현금 보유(평평한 자산곡선 · 매매 0 · 배수 변화 없음)
//   4) 유니버스 교체가 실제로 일어남 — 그 해 목록에 없는 종목은 매매되지 않는다
//
// 네트워크를 타지 않는다. 합성 시계열만 쓴다(컨테이너에서 Yahoo는 403).

import { check, eq, section, finish, rng, close } from './harness'
import { runPitChained } from '../src/features/backtest/pitChain'
import { PIT_UNION, PIT_YEARS, pitCodes } from '../src/features/backtest/pitUniverse'
import { SPEC_VERSION, type StrategySpec } from '../src/features/backtest/strategySpec'
import type { CostSettings } from '../src/features/backtest/conditionScreen'
import type { DailyBar } from '../src/features/backtest/types'

const COST: CostSettings = { initialCapital: 10_000_000, feePct: 0.015, taxPct: 0.15, slippagePct: 0.1 }

/** 합성 일봉 — 거래일 근사로 주말을 건너뛴다(엔진은 달력을 데이터에서 만들므로 충분). */
function makeBars(seed: number, fromYear: number, toYear: number, base = 50_000): DailyBar[] {
  const rnd = rng(seed)
  const bars: DailyBar[] = []
  let p = base
  const start = Date.UTC(fromYear, 0, 1)
  const end = Date.UTC(toYear + 1, 0, 1)
  for (let t = start; t < end; t += 86400000) {
    const d = new Date(t)
    const dow = d.getUTCDay()
    if (dow === 0 || dow === 6) continue
    const ret = 0.0004 + 0.025 * (rnd() * 2 - 1)
    const o = p
    const c = Math.max(1, p * (1 + ret))
    bars.push({
      date: d.toISOString().slice(0, 10),
      t: Math.floor(t / 1000),
      o,
      h: Math.max(o, c) * (1 + rnd() * 0.012),
      l: Math.min(o, c) * (1 - rnd() * 0.012),
      c,
      v: 500_000 + Math.floor(rnd() * 2_000_000),
    })
    p = c
  }
  return bars
}

const YEARS = [2001, 2002, 2003, 2004, 2005]
/** 합성 유니버스: 해마다 6종목씩, 한 종목씩 갈아탄다(교체가 실제로 반영되는지 보려고). */
const POOL = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J']
const CODES: Record<number, string[]> = {
  2001: ['A', 'B', 'C', 'D', 'E', 'F'],
  2002: ['B', 'C', 'D', 'E', 'F', 'G'],
  2003: ['C', 'D', 'E', 'F', 'G', 'H'],
  2004: ['D', 'E', 'F', 'G', 'H', 'I'],
  2005: ['E', 'F', 'G', 'H', 'I', 'J'],
}
const codesFor = (y: number) => CODES[y] ?? []

const HISTORIES: Record<string, DailyBar[]> = {}
POOL.forEach((s, i) => {
  HISTORIES[s] = makeBars(20260802 + i * 37, 2000, 2005, 20_000 + i * 5_000)
})
const BENCH = makeBars(777, 2000, 2005, 30_000)

const makeSpec = (symbols: string[]): StrategySpec => ({
  version: SPEC_VERSION,
  id: 'pit-test',
  name: 'PIT 연쇄 테스트',
  universe: {
    markets: ['KOSPI', 'KOSDAQ'],
    excludeAdministrative: true,
    excludeSuspended: true,
    excludeLiquidation: true,
    excludePreferred: true,
    excludeEtf: true,
    symbols,
  },
  entry: {
    op: 'and',
    nodes: [
      { op: 'cond', id: '10일선돌파', cond: { kind: 'maCross', period: 10, dir: 'above' } },
      { op: 'cond', id: '20일신고가', cond: { kind: 'highBreak', days: 20 } },
    ],
  },
  ranking: { by: 'tradingValue', dir: 'desc' },
  exits: [{ kind: 'maBreak', maPeriod: 60, pct: 2 }],
  sizing: { maxPositions: 3, mode: 'equalSlot' },
  execution: { timing: 'sameClose', orderType: 'market' },
})

const opts = { years: YEARS, codesFor, bench: BENCH, minSymbols: 5 }

section('1) 절단 불변성 — 뒷연도를 잘라내도 앞 연도가 그대로여야 한다 (규칙 1)')
{
  const CUT = '2003-12-31'
  const truncated: Record<string, DailyBar[]> = {}
  for (const [s, bars] of Object.entries(HISTORIES)) truncated[s] = bars.filter((b) => b.date <= CUT)
  const benchCut = BENCH.filter((b) => b.date <= CUT)

  const full = runPitChained(HISTORIES, makeSpec, COST, opts)
  const cut = runPitChained(truncated, makeSpec, COST, { ...opts, bench: benchCut })

  check('전체 실행이 5개 연도를 모두 돌았다', full.perYear.length === 5, `perYear=${full.perYear.length}`)
  check('절단 실행은 3개 연도까지만 돌았다', cut.perYear.length === 3, `perYear=${cut.perYear.length}`)

  // (a) 연도별 결과가 완전히 동일 — 소수점 오차조차 허용하지 않는다
  let yearsSame = true
  for (let i = 0; i < cut.perYear.length; i++) {
    const a = full.perYear[i]
    const b = cut.perYear[i]
    if (
      a.year !== b.year ||
      a.mapped !== b.mapped ||
      a.cash !== b.cash ||
      a.trades !== b.trades ||
      !Object.is(a.strategyPct, b.strategyPct) ||
      !Object.is(a.benchPct, b.benchPct)
    ) {
      yearsSame = false
      console.log(`    diff @${a.year}: full=${JSON.stringify(a)} cut=${JSON.stringify(b)}`)
    }
  }
  check('절단 이전 연도의 전략·벤치 수익률이 완전히 동일', yearsSame)

  // (b) 매매 이력 — 절단 이전 구간의 매매가 한 건도 달라지지 않아야 한다
  const fullBefore = full.trades.filter((t) => t.entryDate <= CUT)
  const cutBefore = cut.trades.filter((t) => t.entryDate <= CUT)
  eq('절단 이전 매매 건수 동일', cutBefore.length, fullBefore.length)
  check('절단 이전 매매가 0건이 아니다(무의미한 통과 방지)', fullBefore.length > 0, `${fullBefore.length}건`)
  let tradesSame = true
  for (let i = 0; i < Math.min(fullBefore.length, cutBefore.length); i++) {
    const a = fullBefore[i]
    const b = cutBefore[i]
    // 청산이 절단선을 넘어간 매매는 절단본에서 미청산으로 끝나는 게 정상 — 진입만 비교한다
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

  // (c) 자산곡선 — 절단선 이전의 모든 점이 동일
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
  check('자산곡선이 비어 있지 않다(무의미한 통과 방지)', fullEq.length > 100, `${fullEq.length}점`)
}

section('2) 자본 이월 산술 — 전체 배수 = 연도별 배수의 곱')
{
  const r = runPitChained(HISTORIES, makeSpec, COST, opts)
  let product = 1
  for (const y of r.perYear) product *= 1 + y.strategyPct / 100
  close('총 배수가 연도별 배수의 곱과 일치', 1 + r.totalPct / 100, product, 1e-6)

  // 자산곡선 마지막 값도 같은 배수여야 한다(스티칭 누락 방지)
  const last = r.equity[r.equity.length - 1]
  close('자산곡선 마지막 평가액이 총 배수와 일치', last.equity / COST.initialCapital, product, 1e-6)

  // MDD는 이어붙인 곡선 기준 — 연도별 MDD의 최솟값보다 나쁠 수 있어도 0 이하여야 한다
  check('MDD가 0 이하', r.mddPct <= 0, `${r.mddPct}`)
  check(
    '수익÷MDD 정의가 맞다',
    r.objective == null || Math.abs(r.objective - r.totalPct / Math.abs(r.mddPct)) < 1e-9,
    `${r.objective}`,
  )
  check('벤치 연쇄가 계산됐다', r.benchTotalPct != null && r.benchCagrPct != null)
  check(
    '알파 = 전략 CAGR − 벤치 CAGR',
    r.alphaCagrPct != null && r.benchCagrPct != null && Math.abs(r.alphaCagrPct - (r.cagrPct - r.benchCagrPct)) < 1e-9,
  )
}

section('3) 매핑 5종목 미만인 해 = 현금 보유')
{
  // 2003년만 2종목으로 줄인다 — 그 해는 매매 없이 배수가 유지되어야 한다
  const thin = (y: number) => (y === 2003 ? ['C', 'D'] : codesFor(y))
  const r = runPitChained(HISTORIES, makeSpec, COST, { ...opts, codesFor: thin })
  const row = r.perYear.find((v) => v.year === 2003)
  check('2003년이 현금 보유로 표시된다', row?.cash === true, JSON.stringify(row))
  eq('현금 보유 해의 매매는 0건', row?.trades, 0)
  eq('현금 보유 해의 수익률은 0%', row?.strategyPct, 0)
  check('현금 보유 해에도 벤치 수익률은 기록된다', row?.benchPct != null, `${row?.benchPct}`)

  // 자산곡선이 그 해 동안 평평해야 한다(구간을 건너뛰면 연수가 줄어 CAGR이 부풀려진다)
  const inYear = r.equity.filter((p) => p.date >= '2003-01-01' && p.date <= '2003-12-31')
  check('현금 보유 해에도 자산곡선 점이 존재한다', inYear.length > 200, `${inYear.length}점`)
  const flat = inYear.every((p) => Math.abs(p.equity - inYear[0].equity) < 1e-6)
  check('현금 보유 해의 자산곡선이 평평하다', flat)

  // 그 해에 매매가 없으니 전체 배수는 나머지 4개 해의 곱과 같아야 한다
  let product = 1
  for (const y of r.perYear) product *= 1 + y.strategyPct / 100
  close('현금 해를 포함해도 배수 곱이 일치', 1 + r.totalPct / 100, product, 1e-6)
}

section('4) 유니버스 교체가 실제로 일어난다 — 그 해 목록 밖 종목은 매매되지 않는다')
{
  const r = runPitChained(HISTORIES, makeSpec, COST, opts)
  let leaked = 0
  for (const t of r.trades) {
    const y = Number(t.entryDate.slice(0, 4))
    if (!codesFor(y).includes(t.symbol ?? '')) leaked++
  }
  eq('그 해 유니버스 밖 진입 0건', leaked, 0)
  check('연도별 심볼 목록이 해마다 다르다', new Set(r.perYear.map((v) => v.symbols.join(','))).size === 5)
  check('실제로 매매가 발생했다(무의미한 통과 방지)', r.trades.length > 10, `${r.trades.length}건`)
}

section('5) 시작일·종료일이 연쇄 범위를 제한한다')
{
  const r = runPitChained(HISTORIES, makeSpec, COST, { ...opts, startDate: '2002-01-01', endDate: '2004-12-31' })
  eq('실행된 연도 수', r.perYear.length, 3)
  eq('첫 연도', r.perYear[0].year, 2002)
  eq('마지막 연도', r.perYear[r.perYear.length - 1].year, 2004)
  check('자산곡선이 구간 밖으로 나가지 않는다', r.equity.every((p) => p.date >= '2002-01-01' && p.date <= '2004-12-31'))
  check('구간 밖 매매가 없다', r.trades.every((t) => t.entryDate >= '2002-01-01' && t.entryDate <= '2004-12-31'))
}

section('6) 유니버스 목록(pitUniverse) 정합성')
{
  check('연도가 2000~2026 연속', PIT_YEARS[0] === 2000 && PIT_YEARS[PIT_YEARS.length - 1] === 2026)
  check('연도 사이에 빠진 해가 없다', PIT_YEARS.every((y, i) => i === 0 || y === PIT_YEARS[i - 1] + 1))
  check(
    '모든 해의 코드가 6자리 숫자',
    PIT_YEARS.every((y) => pitCodes(y).every((c) => /^\d{6}$/.test(c))),
  )
  check(
    '한 해 안에 중복 코드가 없다',
    PIT_YEARS.every((y) => new Set(pitCodes(y)).size === pitCodes(y).length),
  )
  check(
    '2010년 이후는 해마다 20종목',
    PIT_YEARS.filter((y) => y >= 2010).every((y) => pitCodes(y).length === 20),
  )
  check('합집합에 중복이 없다', new Set(PIT_UNION).size === PIT_UNION.length)
  check('합집합이 모든 해의 코드를 덮는다', PIT_YEARS.every((y) => pitCodes(y).every((c) => PIT_UNION.includes(c))))
  console.log(`  (참고) 합집합 고유 종목 ${PIT_UNION.length}개`)
}

finish()
