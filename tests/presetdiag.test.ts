// MODE=presetdiag 진단 로직 검증 (scripts/lib/presetDiag.ts).
//
// 왜 합성 데이터인가: 컨테이너는 Yahoo 403이라 실제 조회가 불가능하고, 실행은 GHA 몫이다.
// 그래서 여기서는 **진단기 자체가 옳게 판정하는가**를 못 박는다 —
//   ① 두 로더 채택 규칙(연구 fetchKrDual · 사전계산 first-win)을 그대로 재현하는가
//   ② 로드 대조가 "다른 종목만" 골라내고 유니버스 편입 연도 차이를 옳게 세는가
//   ③ 스펙 diff가 숨은 필드 차이를 잡고 이름표 차이는 표시용으로 분리하는가
//   ④ 2×2 러너가 데이터축·전략축을 실제로 갈라 다른 수치를 내는가
//   ⑤ 기여도 분해가 로그배수에서 **정확히 합이 맞는가**(잔차 0)
//
// ⚠️ 규칙 1(미래참조 금지)과의 관계: 이 진단기는 이미 확정된 백테스트 결과를 **비교**할 뿐
//    판정에 되먹이지 않는다. 2×2는 정본 엔진(runPitChained·runXsmomChained)을 그대로 부르므로
//    인과성은 pitchain·xsmomchain 테스트의 절단 불변성이 계속 집행한다.

import { check, close, eq, finish, section } from './harness'
import {
  RESEARCH_MIN_BARS,
  attributeGap,
  conclude,
  diffJson,
  diffLoad,
  diffSpecs,
  emptyProbe,
  isCosmetic,
  normalizeSpec,
  pickPrecompute,
  pickResearch,
  run2x2Condition,
  run2x2Xsmom,
  universeYears,
  type DataBundle,
  type SuffixProbe,
} from '../scripts/lib/presetDiag'
import { SPEC_VERSION, type StrategySpec } from '../src/features/backtest/strategySpec'
import type { DailyBar } from '../src/features/backtest/types'
import type { CostSettings } from '../src/features/backtest/conditionScreen'

// ---- 합성 도구 --------------------------------------------------------------

function probe(
  sym: string,
  suffix: string,
  bars: number,
  start = '2000-01-04',
  over: Partial<SuffixProbe> = {},
): SuffixProbe {
  return {
    sym,
    suffix,
    range: 'since:1999-01-01',
    ok: true,
    bars,
    start: bars ? start : '',
    // 공통 창(2000-01-01 이후) 첫 봉 — 합성에서는 1999 시작이어도 실제 첫 거래일은 같다고 본다
    startAtOrAfter: bars ? (start < '2000-01-01' ? '2000-01-04' : start) : '',
    end: bars ? '2026-07-31' : '',
    adjBars: bars,
    adjNonUnitBars: bars,
    error: '',
    ...over,
  }
}

// ============================================================================
section('① 두 로더 채택 규칙 재현')
// ============================================================================

{
  // 코스피 종목: .KQ는 404, .KS만 긴 이력 → 양쪽 다 .KS
  const ks = probe('005930.KS', '.KS', 6500, '1999-01-04')
  const both = { '.KQ': emptyProbe('005930.KQ', '.KQ', 'r', 'HTTP 404'), '.KS': ks }
  eq('연구: .KQ 실패면 .KS 채택', pickResearch(both)?.sym, '005930.KS')
  eq('사전계산: .KS 먼저 성공 → .KS 채택', pickPrecompute(both)?.sym, '005930.KS')
}

{
  // 코스닥→코스피 이전 종목: .KQ에 긴 과거, .KS엔 이전 후 짧은 이력만
  //   연구  = .KQ 먼저 보고 200봉 이상이라 **거기서 끊는다** → .KQ(긴 쪽)
  //   사전계산 = .KS 먼저 보고 1봉 이상이라 **즉시 확정** → .KS(짧은 쪽)
  const kq = probe('068270.KQ', '.KQ', 4400, '2009-01-02')
  const ks = probe('068270.KS', '.KS', 1900, '2018-02-09')
  const m = { '.KQ': kq, '.KS': ks }
  eq('연구: 이전 종목은 긴 .KQ 채택', pickResearch(m)?.sym, '068270.KQ')
  eq('사전계산: 같은 종목에서 짧은 .KS 채택', pickPrecompute(m)?.sym, '068270.KS')
  check('두 규약이 서로 다른 계열을 고른다', pickResearch(m)!.sym !== pickPrecompute(m)!.sym)
}

{
  // 200봉 게이트: 양쪽 다 짧으면 연구는 **채택 포기**, 사전계산은 주워 담는다
  const kq = probe('999999.KQ', '.KQ', 40, '2025-06-02')
  const ks = probe('999999.KS', '.KS', 30, '2025-07-01')
  const m = { '.KQ': kq, '.KS': ks }
  eq(`연구: ${RESEARCH_MIN_BARS}봉 미만은 null`, pickResearch(m), null)
  eq('사전계산: 30봉짜리도 채택', pickPrecompute(m)?.bars, 30)
}

{
  // 연구는 .KQ가 200봉 미만이면 끊지 않고 .KS까지 보고 **긴 쪽**을 고른다
  const m = { '.KQ': probe('X.KQ', '.KQ', 150), '.KS': probe('X.KS', '.KS', 3000) }
  eq('연구: 짧은 .KQ면 계속 보고 긴 .KS 채택', pickResearch(m)?.sym, 'X.KS')
}

{
  // 사전계산은 .KS가 0봉이면(200 OK인데 빈 응답) .KQ로 넘어간다
  const m = { '.KS': probe('Y.KS', '.KS', 0), '.KQ': probe('Y.KQ', '.KQ', 3000) }
  eq('사전계산: 0봉 .KS는 건너뛴다', pickPrecompute(m)?.sym, 'Y.KQ')
  eq('사전계산: 전부 실패면 null', pickPrecompute({ '.KS': undefined, '.KQ': undefined }), null)
}

// ============================================================================
section('② 로드 대조 — 다른 종목만 · 편입 연도 차이')
// ============================================================================

const YEARS = [2010, 2015, 2020]
const always = () => true

{
  // 완전히 같으면 행을 만들지 않는다(표가 조용해야 진짜 차이가 보인다)
  const p = probe('A.KS', '.KS', 3000, '2005-03-02')
  eq('같은 채택이면 diff 없음', diffLoad('A', p, p, YEARS, always), null)
}

{
  const r = probe('B.KQ', '.KQ', 4400, '2009-01-02')
  const p = probe('B.KS', '.KS', 1900, '2018-02-09')
  const row = diffLoad('B', r, p, YEARS, always)!
  check('채택 심볼 차이를 잡는다', row.reasons.includes('채택심볼'))
  check('시작일 차이를 잡는다', row.reasons.includes('시작일'))
  check('편입연도 차이를 잡는다', row.reasons.includes('편입연도'))
  eq('연구에만 든 해 = 2010·2015', row.yearsOnlyResearch.join(','), '2010,2015')
  eq('사전계산에만 든 해 없음', row.yearsOnlyPrecompute.length, 0)
}

{
  // 구간 하한(1999 vs 2000) 때문에 생기는 "당연한" 시작일 차이는 diff로 세지 않는다
  const r = probe('C.KS', '.KS', 6500, '1999-01-04')
  const p = probe('C.KS', '.KS', 6300, '2000-01-04', { bars: 6300 })
  const row = diffLoad('C', r, p, YEARS, always)
  check('구간 차이만이면 시작일 사유 없음', !row || !row.reasons.includes('시작일'))
  check('그래도 편입 연도는 같다', !row || row.yearsOnlyResearch.length === 0)
}

{
  const r = probe('D.KS', '.KS', 3000, '2005-01-03')
  const row = diffLoad('D', r, null, YEARS, always)!
  check('한쪽만 채택을 잡는다', row.reasons.includes('한쪽만 채택'))
  eq('채택 못 한 쪽은 전 연도 상실', row.yearsOnlyResearch.length, 3)
}

{
  // 배당 보정이 한쪽만 걸린 경우(규칙 3 — adjclose 부재 시 조용히 계수 1 폴백)
  const r = probe('E.KS', '.KS', 3000, '2005-01-03')
  const p = probe('E.KS', '.KS', 3000, '2005-01-03', { adjBars: 0, adjNonUnitBars: 0 })
  const row = diffLoad('E', r, p, YEARS, always)!
  check('배당보정 유무 차이를 잡는다', row.reasons.includes('배당보정'))
}

{
  const p = probe('F.KS', '.KS', 3000, '2016-01-04')
  eq('편입 판정은 {해}-06-30 기준', universeYears(p, YEARS, always).join(','), '2020')
  eq('채택 없으면 편입 연도 없음', universeYears(null, YEARS, always).length, 0)
  // 그 해 목록에 없는 코드는 시작일과 무관하게 편입되지 않는다
  eq('연도 목록 필터가 걸린다', universeYears(probe('G.KS', '.KS', 9, '1999-01-04'), YEARS, (y) => y === 2015).join(','), '2015')
}

// ============================================================================
section('③ 스펙 diff — 숨은 필드 차이 vs 이름표 차이')
// ============================================================================

const UNI: StrategySpec['universe'] = {
  markets: ['KOSPI'],
  excludeAdministrative: true,
  excludeSuspended: true,
  excludeLiquidation: true,
  excludePreferred: true,
  excludeEtf: true,
}

function spec(over: Partial<StrategySpec> = {}): StrategySpec {
  return {
    version: SPEC_VERSION,
    id: 'x',
    name: 'x',
    universe: { ...UNI, symbols: ['A'] },
    entry: { op: 'and', nodes: [{ op: 'cond', id: 'm', cond: { kind: 'maCross', period: 25, dir: 'above' } }] },
    ranking: { by: 'tradingValue', dir: 'desc' },
    exits: [{ kind: 'maBreak', maPeriod: 80, pct: 0 }],
    sizing: { maxPositions: 10, mode: 'equalSlot' },
    execution: { timing: 'sameClose', orderType: 'market' },
    ...over,
  }
}

{
  eq('같은 스펙은 diff 0', diffSpecs(spec(), spec()).length, 0)
  // 키 순서가 달라도 같은 스펙이다(정규화가 정렬한다)
  const reordered = JSON.parse(JSON.stringify(spec(), ['version', 'id', 'name', 'universe', 'markets', 'excludeEtf', 'symbols'])) as StrategySpec
  eq('정규화는 키 순서에 흔들리지 않는다', JSON.stringify(normalizeSpec(reordered)), JSON.stringify(normalizeSpec(reordered)))
}

{
  // 의심 후보 4: 유니버스에 숨은 추가 제약(거래대금 하한 등)이 들어오면 반드시 잡혀야 한다
  const a = spec()
  const b = spec({ universe: { ...a.universe, minTradingValue: 1e10 } as StrategySpec['universe'] })
  const rows = diffSpecs(a, b)
  eq('숨은 유니버스 제약을 잡는다', rows.length, 1)
  eq('경로가 정확하다', rows[0].path, 'universe.minTradingValue')
  eq('없는 쪽은 (없음)으로 표기', rows[0].left, '(없음)')
  check('표시용 필드가 아니다', !isCosmetic(rows[0].path))
}

{
  const rows = diffSpecs(spec(), spec({ id: 'y', name: 'z', source: 's' }))
  eq('이름표 3개가 잡힌다', rows.length, 3)
  check('전부 표시용으로 분류된다', rows.every((r) => isCosmetic(r.path)))
  eq('행동 필드 차이는 0', rows.filter((r) => !isCosmetic(r.path)).length, 0)
}

{
  const rows = diffSpecs(spec(), spec({ exits: [{ kind: 'maBreak', maPeriod: 60, pct: 2 }] }))
  eq('청산 규칙 차이 2개(기간·버퍼)', rows.length, 2)
  eq('배열 경로 표기', rows[0].path, 'exits[0].maPeriod')
}

{
  // `regime: null` vs 부재 — 엔진 동작은 같아도 diff는 숨기지 않는다(정직성)
  const rows = diffSpecs(spec({ regime: null }), spec())
  eq('null과 부재는 표에 드러난다', rows.length, 1)
  eq('null 쪽', rows[0].left, 'null')
  eq('부재 쪽', rows[0].right, '(없음)')
  // undefined는 부재와 같게 취급한다
  eq('undefined는 부재와 동일', diffSpecs(spec({ regime: undefined }), spec()).length, 0)
}

{
  // 배열 길이가 다르면 남는 원소가 (없음)으로 잡힌다
  const rows = diffJson(normalizeSpec([1, 2]), normalizeSpec([1]))
  eq('배열 길이 차이', rows.length, 1)
  eq('없는 쪽 표기', rows[0].right, '(없음)')
}

// ============================================================================
section('④ 2×2 재실행 — 두 축이 실제로 갈리는가')
// ============================================================================

const COST: CostSettings = { initialCapital: 10_000_000, feePct: 0.015, taxPct: 0.15, slippagePct: 0.1 }
const DAY = 86400e3

/**
 * 합성 일봉. `from`부터 영업일 근사(주말 제외 없이 연속일)로 n개, 종가는 톱니(오르내림)로
 * 만들어 이평 돌파·이탈이 실제로 발생하게 한다. 결정적이라 재현된다.
 */
function series(from: string, n: number, base: number, amp: number, drift: number, phase = 0): DailyBar[] {
  const t0 = Date.parse(`${from}T00:00:00Z`)
  const out: DailyBar[] = []
  for (let i = 0; i < n; i++) {
    const c = base * (1 + drift * i) * (1 + amp * Math.sin((i + phase) / 9))
    const o = base * (1 + drift * i) * (1 + amp * Math.sin((i - 1 + phase) / 9))
    const hi = Math.max(o, c) * 1.01
    const lo = Math.min(o, c) * 0.99
    const t = Math.floor((t0 + i * DAY) / 1000)
    out.push({ date: new Date(t0 + i * DAY).toISOString().slice(0, 10), t, o, h: hi, l: lo, c, v: 1_000_000 })
  }
  return out
}

const CODES = ['C1', 'C2', 'C3', 'C4', 'C5', 'C6']
const DIAG_YEARS = [2001, 2002, 2003]
const codesFor = () => CODES

/** 긴 데이터(워밍업 있음) — 연구식 상당 */
const longHist: Record<string, DailyBar[]> = {}
/** 짧은 데이터(워밍업 없음) — 사전계산식 상당. 같은 계열의 뒷부분이라 **오직 앞부분만** 다르다. */
const shortHist: Record<string, DailyBar[]> = {}
CODES.forEach((code, i) => {
  const full = series('2000-01-03', 1500, 1000 + i * 50, 0.10, 0.0004, i * 7)
  longHist[code] = full
  shortHist[`${code}.KS`] = full.filter((b) => b.date >= '2001-01-01')
})
const bench = series('2000-01-03', 1500, 500, 0.03, 0.0002, 3)

const bundles: DataBundle[] = [
  { label: '긴 데이터', histories: longHist, bench },
  { label: '짧은 데이터', histories: shortHist, resolve: (code: string) => `${code}.KS`, bench },
]
const env = { cost: COST, years: DIAG_YEARS, codesFor }

const armSlow: StrategySpec['exits'] = [{ kind: 'maBreak', maPeriod: 80, pct: 0 }]
const armFast: StrategySpec['exits'] = [{ kind: 'maBreak', maPeriod: 10, pct: 0 }]
const makeArm = (exits: StrategySpec['exits']) => (symbols: string[]): StrategySpec =>
  spec({ exits, universe: { ...UNI, symbols } })

{
  const cells = run2x2Condition(
    bundles,
    [
      { label: '느린 청산', make: makeArm(armSlow) },
      { label: '빠른 청산', make: makeArm(armFast) },
    ],
    env,
  )
  eq('2×2는 셀 4개', cells.length, 4)
  eq('라벨이 축을 그대로 옮긴다', cells.map((s) => `${s.dataLabel}/${s.armLabel}`).join('|'),
    '긴 데이터/느린 청산|긴 데이터/빠른 청산|짧은 데이터/느린 청산|짧은 데이터/빠른 청산')
  check('resolve로 접미사 키를 찾아 실행된다(매매가 발생)', cells[2].tradeCount + cells[3].tradeCount > 0)

  const dataAxis = cells[0].totalPct !== cells[2].totalPct
  const armAxis = cells[0].totalPct !== cells[1].totalPct
  check('데이터축(워밍업 유무)이 수치를 바꾼다', dataAxis)
  check('전략축(청산 이평)이 수치를 바꾼다', armAxis)
  check('모든 셀이 같은 연쇄 구간을 본다', cells.every((s) => s.startDate.slice(0, 4) === '2001'))
}

{
  // 진단기는 재현 가능해야 한다 — 같은 입력을 두 번 돌리면 1비트도 달라지면 안 된다.
  // (수치가 흔들리면 "갭의 원인"이라는 판정 자체가 성립하지 않는다.)
  const arms = [
    { label: '느린 청산', make: makeArm(armSlow) },
    { label: '빠른 청산', make: makeArm(armFast) },
  ]
  const a = run2x2Condition(bundles, arms, env)
  const b = run2x2Condition(bundles, arms, env)
  eq('2×2 재실행은 결정적', JSON.stringify(a), JSON.stringify(b))

  // 그리고 2×2의 네 셀은 ⑤의 분해와 **정확히** 맞물려야 한다(표와 결론이 갈라지지 않게).
  const g = attributeGap(a[0].totalPct, a[1].totalPct, a[2].totalPct, a[3].totalPct)
  close('실측 셀에서도 두 몫의 합 = 전체 갭', g.dataLog + g.armLog, g.totalLogGap, 1e-12)
}

{
  const cells = run2x2Xsmom(
    bundles,
    [
      { label: 'haircut ON', slots: 3, gate: false, haircut: true },
      { label: 'haircut OFF', slots: 3, gate: false, haircut: false },
    ],
    env,
  )
  eq('xsmom 2×2도 셀 4개', cells.length, 4)
  check('haircut ON이 OFF보다 낮다(비용이므로)', cells[0].totalPct < cells[1].totalPct)
  check('데이터축이 xsmom에서도 갈린다', cells[1].totalPct !== cells[3].totalPct)
}

// ============================================================================
section('⑤ 기여도 분해 — 로그배수에서 합이 정확히 맞는가')
// ============================================================================

{
  // 순수 데이터축: 팔을 바꿔도 값이 안 변한다 → 전부 데이터축
  const g = attributeGap(900, 900, 100, 100)
  close('전략축 기여 0', g.armLog, 0, 1e-12)
  close('데이터축이 전체 갭', g.dataLog, g.totalLogGap, 1e-12)
  eq('데이터축 몫 100%', Math.round(g.dataSharePct!), 100)
}

{
  // 순수 전략축
  const g = attributeGap(900, 100, 900, 100)
  close('데이터축 기여 0', g.dataLog, 0, 1e-12)
  eq('전략축 몫 100%', Math.round(g.armSharePct!), 100)
}

{
  // 섞인 경우 — 두 몫의 합은 **항상** 전체 갭과 같아야 한다(잔차 0)
  const g = attributeGap(5442, 3000, 1200, 558)
  close('두 몫의 합 = 전체 갭 (잔차 없음)', g.dataLog + g.armLog, g.totalLogGap, 1e-12)
  close('몫 비율의 합 = 100%', g.dataSharePct! + g.armSharePct!, 100, 1e-9)
  check('실제 증상 수치에서는 데이터축이 우세', Math.abs(g.dataLog) > Math.abs(g.armLog))
  check('결론 문장이 데이터축을 지목', conclude('pit-maxratio', g).includes('데이터축'))
}

{
  // 총수익이 −100%(전액 손실)여도 로그가 폭발하지 않는다
  const g = attributeGap(-100, -100, -100, -100)
  check('전손 케이스에서 NaN이 없다', Number.isFinite(g.totalLogGap) && Number.isFinite(g.dataLog))
  eq('갭이 0이면 몫은 null', g.dataSharePct, null)
  check('그 경우 결론이 재현 실패를 말한다', conclude('x', g).includes('재현되지 않았다'))
}

finish()
