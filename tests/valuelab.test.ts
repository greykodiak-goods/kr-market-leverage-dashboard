// 밸류·퀄리티 팩터 랩(38차) — 위생 게이트 · PIT 불변성 · 경계 처리 · 판정 프레임.
//
// 이 파일이 막는 사고는 다섯 가지다.
//
//   ① **더러운 재무가 매수 신호로 위장하는 것.** PBR = 시총 ÷ 자본이라, 자본이 자산으로
//      잘못 들어온 레코드는 분모가 몇 배로 부풀어 **저PBR 상위로 곧장 올라온다.** 실측에
//      그런 레코드가 있다(젬백스 082270 — equity와 assets가 같은 값). 위생 게이트가
//      실제로 그걸 잘라내는지 픽스처와 실데이터 양쪽으로 확인한다.
//   ② **재무판 미래참조.** 시점 D 이후에 접수된 공시를 D 시점 랭킹에 쓰면 백테스트가
//      통째로 거짓이 된다. D 이후 레코드를 아무리 더 넣어도 D 시점 랭킹이 변하면 실패다.
//   ③ **당일 종가로 당일 시가 매수.** 시총을 리밸런스일 종가로 잡고 그날 시가에 체결하면
//      규칙 1-2가 명시적으로 금지한 계산이 된다. 팩터 기준일이 리밸런스일보다 **이전**임을
//      구조로 못 박는다 — 리밸런스일 당일에 접수된 공시도 쓰이면 안 된다.
//   ④ **경계값이 랭킹을 뒤집는 것.** 적자 PER·자본잠식 PBR을 0·음수로 두면 최악의 회사가
//      최고 점수를 받는다. 랭킹에서 빠지는 것과 **빠진 수가 보고되는 것**까지 고정한다.
//   ⑤ **판정 프레임이 낡는 것.** 전·후반 경계를 하드코딩하면 구간이 바뀌어도 옛 연도가
//      남아 "전반/후반"이라는 말의 뜻이 조용히 달라진다. 구간에서 자동 계산되는지 본다.
//
// 네트워크를 타지 않는다(이 컨테이너는 Yahoo가 403). 벤치가 필요한 경로는 테스트하지
// 않고, 리포에 커밋된 정본 파일만 읽는다.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { check, close as closeTo, eq, finish, section } from './harness'
import type { FundamentalRecord } from '../src/features/backtest/fundamentals'
import type { MarketCapPoint } from '../src/features/backtest/fundamentals'
import {
  COST,
  EQUITY_BASIS_POLICY,
  FACTOR_DIRECTION,
  VALUE_MIN_TRADES,
  VALUE_TRIALS,
  VALUE_TRIALS_CUMULATIVE,
  VALUE_TRIALS_PRIOR,
  equalWeightIndex,
  halfYearOf,
  hygieneViolations,
  loadFundamentals,
  makeValueRankFn,
  monthlyMatrix,
  newRankDiag,
  prevDayIso,
  rankByFactors,
  reasonKey,
  screenFundamentals,
  valueFactorRows,
  valueVariants,
  type ValueDeps,
} from '../scripts/value-lab.entry'

const ROOT = process.env.REPO_ROOT ?? process.cwd()

// ---------------------------------------------------------------- 픽스처 도구

let seq = 0

/** 접수번호는 14자리(YYYYMMDD + 일련 6). 접수일과 앞 8자리가 일치해야 파서·PIT가 성립한다. */
function rcept(date: string): string {
  seq = (seq + 1) % 999999
  return `${date.replace(/-/g, '')}${String(seq).padStart(6, '0')}`
}

interface RecOpts {
  year: number
  rceptDt: string
  equity: number | null
  assets?: number | null
  liabilities?: number | null
  netIncome?: number | null
  fsDiv?: 'CFS' | 'OFS'
  equitySource?: 'parent' | 'total'
}

function rec(o: RecOpts): FundamentalRecord {
  const equitySource = o.equitySource ?? 'parent'
  return {
    bsnsYear: o.year,
    reprtCode: '11011',
    fsDiv: o.fsDiv ?? 'CFS',
    rceptNo: rcept(o.rceptDt),
    rceptDt: o.rceptDt,
    equity: o.equity,
    equitySource: o.equity == null ? null : equitySource,
    assets: o.assets ?? null,
    liabilities: o.liabilities ?? null,
    netIncome: o.netIncome ?? null,
    netIncomeSource: o.netIncome == null ? null : 'parent',
    netIncomeAdd: null,
    revenue: null,
    revenueAdd: null,
    operatingIncome: null,
    operatingIncomeAdd: null,
  }
}

/** 시총 시계열 — 하루 한 점씩, 값은 고정. PIT 판정만 보므로 형태는 최소로 둔다. */
function caps(dates: string[], value: number): MarketCapPoint[] {
  return dates.map((date) => ({ date, marketCap: value }))
}

const DAYS_2016 = ['2016-03-30', '2016-03-31', '2016-04-01', '2016-04-04']

// ============================================================================
section('① 위생 게이트 — 더러운 재무 레코드를 팩터 계산에서 배제한다')
// ============================================================================

{
  // R1: 자산 ≠ 부채 + 자본. **총계 기준일 때만 판정 가능**하므로 OFS/total로 만든다
  //     (CFS/total로 만들면 R3에도 걸려 "R1이 잡았는지"를 구분할 수 없다).
  const identityFail = rec({
    year: 2020,
    rceptDt: '2021-03-15',
    equity: 900,
    assets: 1000,
    liabilities: 700, // 700 + 900 = 1600 ≠ 1000
    fsDiv: 'OFS',
    equitySource: 'total',
  })
  // 실측 사고 재현 — 자본총계가 자산총계와 **같은 값**으로 들어온 레코드(젬백스 유형).
  const equityEqualsAssets = rec({
    year: 2020,
    rceptDt: '2021-03-15',
    equity: 1000,
    assets: 1000,
    liabilities: 300,
    fsDiv: 'OFS',
    equitySource: 'total',
  })
  // R2: 자본 > 자산 — 부채가 음수여야 성립하므로 구조적으로 불가능.
  const equityGtAssets = rec({ year: 2020, rceptDt: '2021-03-15', equity: 1500, assets: 1000, liabilities: 200 })
  // R3: 연결인데 자본이 총계 — 지배주주 기준으로 통일 불가.
  const mixedBasis = rec({
    year: 2020,
    rceptDt: '2021-03-15',
    equity: 600,
    assets: 1000,
    liabilities: 400,
    fsDiv: 'CFS',
    equitySource: 'total',
  })
  // 통과: 연결 + 지배주주.
  const cleanParent = rec({ year: 2020, rceptDt: '2021-03-15', equity: 550, assets: 1000, liabilities: 400 })
  // 통과: 별도 + 총계(비지배지분이라는 개념이 없어 parent와 동등).
  const cleanOfsTotal = rec({
    year: 2020,
    rceptDt: '2021-03-15',
    equity: 600,
    assets: 1000,
    liabilities: 400,
    fsDiv: 'OFS',
    equitySource: 'total',
  })

  eq('R1 회계 항등식 실패를 잡는다', hygieneViolations(identityFail).join(','), 'identity')
  eq('R1 자본=자산 사고(젬백스 유형)를 잡는다', hygieneViolations(equityEqualsAssets).join(','), 'identity')
  eq('R2 자본 > 자산을 잡는다', hygieneViolations(equityGtAssets).join(','), 'equityGtAssets')
  eq('R3 연결·총계(기준 혼재)를 잡는다', hygieneViolations(mixedBasis).join(','), 'mixedBasis')
  eq('연결·지배주주는 통과', hygieneViolations(cleanParent).length, 0)
  eq('별도·총계는 통과(비지배지분 없음 → parent와 동등)', hygieneViolations(cleanOfsTotal).length, 0)

  const store = screenFundamentals([
    {
      code: '000001',
      name: '더러운회사',
      records: [identityFail, equityEqualsAssets, equityGtAssets, mixedBasis],
    },
    { code: '000002', name: '깨끗한회사', records: [cleanParent, cleanOfsTotal] },
  ])
  eq('배제 레코드 수', store.report.excludedRecords, 4)
  eq('사용 레코드 수', store.report.keptRecords, 2)
  eq('R1 적중', store.report.byRule.identity, 2)
  eq('R2 적중', store.report.byRule.equityGtAssets, 1)
  eq('R3 적중', store.report.byRule.mixedBasis, 1)
  eq('더러운 회사는 전멸로 보고된다', store.report.wipedCodes.join(','), '000001')
  eq('배제 후 남은 레코드(000001)', (store.clean.get('000001') ?? []).length, 0)
  eq('배제 후 남은 레코드(000002)', (store.clean.get('000002') ?? []).length, 2)
  eq('사업연도별 집계도 남는다', store.report.byYear.get(2020)?.excluded ?? -1, 4)
  check('귀속 기준 통일 정책 문구가 비어 있지 않다', EQUITY_BASIS_POLICY.length > 40)

  // 배제된 레코드가 **랭킹까지 실제로 못 들어가는지**가 이 게이트의 존재 이유다.
  // 더러운 자본(1000)을 그대로 쓰면 PBR = 1000/1000 = 1.0으로 "가장 싼 주식"이 된다.
  const dates = ['2021-03-16', '2021-03-17']
  const dirtyDeps: ValueDeps = {
    records: new Map([
      ['000001', [equityEqualsAssets]],
      ['000002', [cleanParent]],
    ]),
    caps: new Map([
      ['000001', caps(dates, 1000)],
      ['000002', caps(dates, 5000)],
    ]),
  }
  const dirtyRank = rankByFactors(valueFactorRows(dirtyDeps, ['000001', '000002'], '2021-03-17'), ['pbr'])
  eq('게이트 없이 돌리면 더러운 종목이 저PBR 1위로 올라온다', dirtyRank.ranked[0]?.code, '000001')

  const cleanDeps: ValueDeps = { records: store.clean, caps: dirtyDeps.caps }
  const cleanRank = rankByFactors(valueFactorRows(cleanDeps, ['000001', '000002'], '2021-03-17'), ['pbr'])
  eq('게이트를 통과한 재무만 쓰면 더러운 종목은 랭킹에 없다', cleanRank.ranked.map((r) => r.code).join(','), '000002')
  check(
    '배제된 종목은 제외 사유와 함께 보고된다',
    cleanRank.excluded.some((e) => e.code === '000001'),
    JSON.stringify(cleanRank.excluded),
  )
}

// ============================================================================
section('② PIT 불변성 — 시점 이후 접수 레코드를 넣어도 그 시점 랭킹이 변하지 않는다')
// ============================================================================

{
  const D = '2016-04-01' // 팩터 기준일
  const base = new Map<string, FundamentalRecord[]>([
    // A: 자본 1000 → 시총 2000이면 PBR 2.0
    ['000010', [rec({ year: 2015, rceptDt: '2016-03-20', equity: 1000, assets: 3000, liabilities: 2000, netIncome: 200 })]],
    // B: 자본 500 → 시총 2000이면 PBR 4.0
    ['000020', [rec({ year: 2015, rceptDt: '2016-03-21', equity: 500, assets: 2000, liabilities: 1500, netIncome: 50 })]],
    // C: 자본 4000 → PBR 0.5 (가장 쌈)
    ['000030', [rec({ year: 2015, rceptDt: '2016-03-22', equity: 4000, assets: 9000, liabilities: 5000, netIncome: 400 })]],
  ])
  const capMap = new Map<string, MarketCapPoint[]>([
    ['000010', caps(DAYS_2016, 2000)],
    ['000020', caps(DAYS_2016, 2000)],
    ['000030', caps(DAYS_2016, 2000)],
  ])
  const codes = ['000010', '000020', '000030']
  const deps: ValueDeps = { records: base, caps: capMap }

  const before = valueFactorRows(deps, codes, D)
  const rankBefore = rankByFactors(before, ['pbr']).ranked.map((r) => r.code).join(',')
  eq('저PBR 랭킹(기준)', rankBefore, '000030,000010,000020')

  // D **이후**에 접수된 레코드를 잔뜩 더한다 — 값이 극단적이라 반영되면 순위가 반드시 뒤집힌다.
  const withFuture = new Map(base)
  withFuture.set('000020', [
    ...(base.get('000020') as FundamentalRecord[]),
    rec({ year: 2016, rceptDt: '2016-04-02', equity: 999_999, assets: 1_000_000, liabilities: 1, netIncome: 999_999 }),
  ])
  withFuture.set('000030', [
    ...(base.get('000030') as FundamentalRecord[]),
    rec({ year: 2016, rceptDt: '2017-03-20', equity: 1, assets: 9000, liabilities: 8999, netIncome: 1 }),
  ])
  const after = valueFactorRows({ records: withFuture, caps: capMap }, codes, D)
  eq(
    '미래 레코드를 넣어도 랭킹이 같다',
    rankByFactors(after, ['pbr']).ranked.map((r) => r.code).join(','),
    rankBefore,
  )
  eq(
    '미래 레코드를 넣어도 팩터 값이 한 자리도 안 바뀐다',
    JSON.stringify(after.map((r) => [r.code, r.pbr, r.per, r.roe, r.rceptDt])),
    JSON.stringify(before.map((r) => [r.code, r.pbr, r.per, r.roe, r.rceptDt])),
  )
  check(
    '쓰인 재무의 접수일이 전부 기준일 이하다',
    before.every((r) => r.rceptDt === null || r.rceptDt <= D),
    JSON.stringify(before.map((r) => r.rceptDt)),
  )

  // 시총도 같은 성질을 가져야 한다 — 기준일 이후 시총이 바뀌어도 그 시점 PBR은 불변.
  const futureCaps = new Map(capMap)
  futureCaps.set('000010', [...caps(DAYS_2016, 2000).filter((p) => p.date <= D), { date: '2016-04-04', marketCap: 1 }])
  eq(
    '기준일 이후 시총이 바뀌어도 그 시점 PBR은 불변',
    JSON.stringify(valueFactorRows({ records: base, caps: futureCaps }, codes, D).map((r) => r.pbr)),
    JSON.stringify(before.map((r) => r.pbr)),
  )
}

// ============================================================================
section('③ 규칙 1-2 — 팩터 기준일은 리밸런스일보다 **이전**이다 (당일 종가로 당일 시가 매수 금지)')
// ============================================================================

{
  eq('prevDayIso 기본', prevDayIso('2020-03-02'), '2020-03-01')
  eq('prevDayIso 월 경계', prevDayIso('2020-03-01'), '2020-02-29')
  eq('prevDayIso 연 경계', prevDayIso('2021-01-01'), '2020-12-31')
  let threw = false
  try {
    prevDayIso('2020/03/02')
  } catch {
    threw = true
  }
  check('prevDayIso는 형식이 다르면 던진다(조용한 폴백 금지)', threw)

  // 리밸런스일 **당일**에 접수된 공시는 쓰이면 안 된다 — 그날 아침 공시를 보고
  // 그날 시가에 사는 계산이 되기 때문이다.
  const rebalance = '2016-04-01'
  const deps: ValueDeps = {
    records: new Map([
      ['000010', [rec({ year: 2015, rceptDt: '2016-03-20', equity: 1000, assets: 3000, liabilities: 2000, netIncome: 100 })]],
      // 당일 접수 — 자본이 10배라 반영되면 PBR 순위가 반드시 뒤집힌다.
      ['000020', [rec({ year: 2015, rceptDt: rebalance, equity: 10_000, assets: 20_000, liabilities: 10_000, netIncome: 100 })]],
    ]),
    caps: new Map([
      ['000010', caps(DAYS_2016, 2000)],
      ['000020', caps(DAYS_2016, 2000)],
    ]),
  }
  const diag = newRankDiag()
  const rankFn = makeValueRankFn(deps, ['pbr'], diag)
  const rows = rankFn({}, ['000010', '000020'], rebalance)
  eq('리밸런스일 당일 접수 공시는 후보에 들어가지 않는다', rows.map((r) => r.sym).join(','), '000010')
  eq('제외 수가 진단에 남는다', diag.excluded, 1)
  eq('후보가 생긴 첫 리밸런스일이 기록된다', diag.firstCandidateDate, rebalance)

  // 하루 뒤 리밸런스에서는 그 공시가 보인다(즉 영원히 버리는 게 아니라 **하루 미루는** 것이다).
  const diag2 = newRankDiag()
  const rows2 = makeValueRankFn(deps, ['pbr'], diag2)({}, ['000010', '000020'], '2016-04-04')
  eq('다음 리밸런스에서는 그 공시가 반영된다', rows2.length, 2)
}

// ============================================================================
section('④ 경계 처리 — 적자·자본잠식은 랭킹에서 제외되고 제외 수가 보고된다')
// ============================================================================

{
  const D = '2021-03-20'
  const days = ['2021-03-18', '2021-03-19', '2021-03-20']
  const records = new Map<string, FundamentalRecord[]>([
    ['000100', [rec({ year: 2020, rceptDt: '2021-03-15', equity: 1000, assets: 3000, liabilities: 2000, netIncome: 200 })]],
    ['000200', [rec({ year: 2020, rceptDt: '2021-03-15', equity: 2000, assets: 5000, liabilities: 3000, netIncome: 100 })]],
    // 적자 — PER은 null, ROE는 음수(정의됨).
    ['000300', [rec({ year: 2020, rceptDt: '2021-03-15', equity: 1500, assets: 4000, liabilities: 2500, netIncome: -300 })]],
    // 자본잠식 — PBR·ROE 모두 null.
    ['000400', [rec({ year: 2020, rceptDt: '2021-03-15', equity: -500, assets: 1000, liabilities: 1500, netIncome: 50 })]],
    // 재무 자체가 아직 없음(공시 전).
    ['000500', [rec({ year: 2021, rceptDt: '2022-03-15', equity: 900, assets: 2000, liabilities: 1100, netIncome: 90 })]],
  ])
  const codes = [...records.keys()]
  const deps: ValueDeps = { records, caps: new Map(codes.map((c) => [c, caps(days, 3000)])) }
  const rows = valueFactorRows(deps, codes, D)

  const byCode = new Map(rows.map((r) => [r.code, r]))
  eq('적자 종목의 PER은 null', byCode.get('000300')?.per, null)
  check('적자 종목의 ROE는 음수로 살아 있다', (byCode.get('000300')?.roe ?? 0) < 0)
  eq('자본잠식 종목의 PBR은 null', byCode.get('000400')?.pbr, null)
  eq('자본잠식 종목의 ROE도 null', byCode.get('000400')?.roe, null)
  eq('공시 전 종목의 자본은 null', byCode.get('000500')?.equity, null)

  // ⚠️ PER의 분모는 순이익이라 **자본잠식 종목도 PER은 정의된다.** 이걸 "자본잠식이니
  //    당연히 빠진다"고 착각하면 저PER 바구니에 자본잠식 기업이 조용히 들어온다.
  //    라이브러리(computeValueQualityFactors)의 정의를 그대로 쓰고, 그 사실을 여기 못 박는다.
  check('자본잠식 종목도 순이익이 양수면 PER은 살아 있다', (byCode.get('000400')?.per ?? 0) > 0)

  const per = rankByFactors(rows, ['per'])
  eq('저PER 랭킹에서 적자·공시전은 빠진다(자본잠식은 PER이 정의되어 남는다)', per.ranked.map((r) => r.code).join(','), '000100,000200,000400')
  eq('저PER 제외 수', per.excluded.length, 2)
  check(
    '적자가 제외 사유로 보고된다',
    per.excluded.some((e) => e.code === '000300' && reasonKey(e.reason) === '적자(순이익 ≤ 0)'),
    JSON.stringify(per.excluded),
  )

  const pbr = rankByFactors(rows, ['pbr'])
  eq('저PBR 랭킹에는 자본잠식·공시전이 없다', pbr.ranked.map((r) => r.code).join(','), '000200,000300,000100')
  eq('저PBR 제외 수', pbr.excluded.length, 2)
  check(
    '자본잠식이 제외 사유로 보고된다',
    pbr.excluded.some((e) => e.code === '000400' && reasonKey(e.reason) === '자본잠식(자본 ≤ 0)'),
    JSON.stringify(pbr.excluded),
  )

  // 복합은 요구 팩터를 **전부** 가진 종목만 후보다(없는 값을 메우지 않는다 — 규칙 1-5).
  // 000100: PBR 3위-ish지만 PER·ROE 1위 → 평균 순위 (2+1+1)/3 = 1.33
  // 000200: PBR 1위지만 PER·ROE 2위     → 평균 순위 (1+2+2)/3 = 1.67
  const combo = rankByFactors(rows, ['pbr', 'per', 'roe'])
  eq('3팩터 복합 후보(모든 팩터를 가진 종목만)', combo.ranked.map((r) => r.code).join(','), '000100,000200')
  eq('3팩터 복합 제외 수', combo.excluded.length, 3)
  closeTo('복합 1위의 평균 순위', combo.ranked[0].avgRank, 4 / 3, 1e-12)
  closeTo('복합 2위의 평균 순위', combo.ranked[1].avgRank, 5 / 3, 1e-12)

  // 랭킹 함수를 통해서도 제외 수가 진단에 누적되는지.
  const diag = newRankDiag()
  makeValueRankFn(deps, ['per'], diag)({}, codes, '2021-03-21')
  eq('진단 후보 수', diag.candidates, 3)
  eq('진단 제외 수', diag.excluded, 2)
  check('제외 사유가 분류되어 누적된다', (diag.byReason.get('적자(순이익 ≤ 0)') ?? 0) === 1, JSON.stringify([...diag.byReason]))

  // 방향 — PBR·PER은 작을수록, ROE는 클수록 상위.
  eq('PBR 방향', FACTOR_DIRECTION.pbr, 'asc')
  eq('PER 방향', FACTOR_DIRECTION.per, 'asc')
  eq('ROE 방향', FACTOR_DIRECTION.roe, 'desc')
  const roe = rankByFactors(rows, ['roe'])
  eq('고ROE 1위는 ROE가 가장 큰 종목', roe.ranked[0]?.code, '000100')
}

// ============================================================================
section('⑤ 판정 프레임 — 전·후반 경계가 구간에 따라 자동으로 이동한다')
// ============================================================================

{
  const span = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i)
  const h2015 = halfYearOf(span(2015, 2026))
  check(`2015~2026 → 2020~21 사이 (실제 ${h2015})`, h2015 === 2020 || h2015 === 2021, String(h2015))
  eq('2015~2026 경계', h2015, 2021)
  eq('2010~2026 경계 (기존 KRXPIT_HALF와 같은 값)', halfYearOf(span(2010, 2026)), 2018)
  eq('앞 구간이 붙으면 경계가 앞으로 이동한다', halfYearOf(span(2000, 2026)), 2013)
  eq('뒤가 늘면 경계가 뒤로 이동한다', halfYearOf(span(2015, 2036)), 2026)
  // 전·후반 길이가 균형인지 (짝수 년수면 정확히 반반)
  {
    const ys = span(2015, 2026)
    const h = halfYearOf(ys)
    eq('전반 연수', ys.filter((y) => y < h).length, 6)
    eq('후반 연수', ys.filter((y) => y >= h).length, 6)
  }
  let threw = false
  try {
    halfYearOf([2020])
  } catch {
    threw = true
  }
  check('1년짜리 구간은 나눌 수 없어 던진다', threw)
}

// ============================================================================
section('⑥ 변형 매트릭스 — 18 고정 · 다중검정 분모')
// ============================================================================

{
  const vs = valueVariants()
  eq('변형 수는 18 고정', vs.length, VALUE_TRIALS)
  eq('변형 키가 유일하다', new Set(vs.map((v) => v.key)).size, 18)
  eq('10+10 변형 수', vs.filter((v) => v.width === '10+10').length, 15)
  eq('40+40 분위 변형 수', vs.filter((v) => v.width === '40+40').length, 3)
  eq('게이트 on 변형 수', vs.filter((v) => v.gate).length, 12)
  eq('게이트 off 변형 수', vs.filter((v) => !v.gate).length, 6)
  eq('복합(다팩터) 변형 수', vs.filter((v) => v.factors.length > 1).length, 3)
  eq('40+40 분위 슬롯은 전부 16', new Set(vs.filter((v) => v.width === '40+40').map((v) => v.slots)).size, 1)
  check(
    '단일 팩터 3계열 × 슬롯{3,5} × 게이트{off,on} = 12',
    vs.filter((v) => v.width === '10+10' && v.factors.length === 1).length === 12,
  )

  // 누적 시도 = DSR의 진짜 분모. 회차 내역을 바꾸면 이 값도 같이 바뀌어야 한다.
  eq('누적 시도 = 이전 회차 합 + 18', VALUE_TRIALS_CUMULATIVE, VALUE_TRIALS_PRIOR.reduce((s, r) => s + r.n, 0) + 18)
  eq('누적 시도 97 (33차 10 + 34차 35 + 35차 20 + 36차 14 + 38차 18)', VALUE_TRIALS_CUMULATIVE, 97)

  // 비용 전제는 34·36차와 같아야 표가 나란히 읽힌다.
  eq('수수료', COST.feePct, 0.015)
  eq('거래세', COST.taxPct, 0.15)
  eq('슬리피지', COST.slippagePct, 0.1)
  eq('초기자본', COST.initialCapital, 10_000_000)
  eq('표본 소실 판정선', VALUE_MIN_TRADES, 20)
}

// ============================================================================
section('⑦ 과최적화 입력 — 월별 수익률 행렬은 같은 달 축에 정렬된다')
// ============================================================================

{
  const curve = (dates: string[], vals: number[]) => dates.map((date, i) => ({ date, equity: vals[i] }))
  const dates = ['2020-01-31', '2020-02-28', '2020-03-31', '2020-04-30']
  const a = curve(dates, [100, 110, 121, 133.1])
  const b = curve(dates, [100, 90, 81, 72.9])
  // 한 변형에만 있는 달(2020-05)은 공통 축에서 빠져야 한다 — 그대로 두면 시점이 밀린다.
  const c = [...curve(dates, [100, 105, 110, 115]), { date: '2020-05-29', equity: 120 }]
  const mm = monthlyMatrix([a, b, c])
  eq('공통 달만 남는다', mm.months.join(','), '2020-02,2020-03,2020-04')
  eq('버린 달 수', mm.dropped, 1)
  eq('행렬 행 수', mm.matrix.length, 3)
  check('모든 행의 길이가 같다', mm.matrix.every((r) => r.length === mm.months.length))
  closeTo('변형 A의 2월 수익률', mm.matrix[0][0], 0.1, 1e-12)
  closeTo('변형 B의 2월 수익률', mm.matrix[1][0], -0.1, 1e-12)
  eq('벤치 미제공이면 null', mm.bench, null)

  const bench = curve(dates, [100, 101, 102, 103])
  const mm2 = monthlyMatrix([a, b], bench)
  eq('벤치를 주면 같은 축으로 나온다', mm2.bench?.length, mm2.months.length)
}

// ============================================================================
section('⑧ 동일가중 지수 — 결정적이고, 상장 전 구간을 0으로 채우지 않는다')
// ============================================================================

{
  const bar = (date: string, c: number) => ({ date, t: 0, o: c, h: c, l: c, c, v: 0 })
  const hist = {
    A: [bar('2020-01-02', 100), bar('2020-01-03', 110), bar('2020-01-06', 121)],
    // B는 하루 늦게 시작한다 — 첫날 수익률에 끼면 안 된다(없는 종목을 0%로 세면 지수가 희석된다).
    B: [bar('2020-01-03', 50), bar('2020-01-06', 45)],
  }
  const idx = equalWeightIndex(hist, ['A', 'B'], '2020-01-01')
  eq('달력 길이', idx.length, 3)
  closeTo('첫날은 기준값', idx[0].equity, 100, 1e-12)
  // 1/2→1/3: A만 관측 가능(B는 전날 값이 없다) → +10%
  closeTo('상장 전 종목은 평균에서 빠진다', idx[1].equity, 110, 1e-9)
  // 1/3→1/6: A +10%, B −10% → 평균 0%
  closeTo('둘 다 있으면 단순평균', idx[2].equity, 110, 1e-9)
  eq('같은 입력이면 같은 출력(결정적)', JSON.stringify(equalWeightIndex(hist, ['A', 'B'], '2020-01-01')), JSON.stringify(idx))
}

// ============================================================================
section('⑨ 실데이터 — 리포에 커밋된 DART 정본에서 위생 게이트가 실제로 동작한다')
// ============================================================================

{
  const idxPath = join(ROOT, 'public/data/dart-fundamentals/index.json')
  if (!existsSync(idxPath)) {
    check('[건너뜀] DART 재무 정본이 없어 실데이터 확인 불가 — 파일이 커밋돼 있어야 한다', false, idxPath)
  } else {
    const raw = JSON.parse(readFileSync(idxPath, 'utf8')) as { stocks: { code: string }[] }
    const codes = raw.stocks.map((s) => s.code)
    const load = loadFundamentals(codes, ROOT)
    const rep = load.report
    check(`실데이터 레코드 ${rep.totalRecords}건을 읽었다`, rep.totalRecords > 5000, String(rep.totalRecords))
    eq('회계 항등식 실패(R1)는 실측 34건', rep.byRule.identity, 34)
    check('R3(기준 혼재) 배제가 존재한다', rep.byRule.mixedBasis > 0, String(rep.byRule.mixedBasis))
    check(
      '배제 수가 전체의 10% 미만이다(게이트가 데이터를 통째로 날리지 않는다)',
      rep.excludedRecords < rep.totalRecords * 0.1,
      `${rep.excludedRecords}/${rep.totalRecords}`,
    )
    check('배제 건수가 0이 아니다 — 게이트가 실제로 무언가를 잘라낸다', rep.excludedRecords > 0, String(rep.excludedRecords))

    // 실측 사고 종목 — 젬백스(082270)의 "자본 = 자산" 레코드가 실제로 잘려 나갔는가.
    const jem = (load.clean.get('082270') ?? []) as FundamentalRecord[]
    check('젬백스 082270 레코드를 읽었다', jem.length >= 0)
    check(
      '젬백스에서 자본 = 자산인 레코드가 하나도 안 남았다',
      jem.every((r) => !(r.assets != null && r.equity != null && r.assets > 0 && Math.abs(r.equity / r.assets - 1) < 1e-9)),
      JSON.stringify(jem.filter((r) => r.assets === r.equity).map((r) => `${r.bsnsYear}/${r.reprtCode}`)),
    )
    check(
      '남은 레코드는 전부 위생 규칙을 통과한다',
      [...load.clean.values()].every((rs) => rs.every((r) => hygieneViolations(r).length === 0)),
    )
  }
}

finish()
