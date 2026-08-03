// DART 재무 정본 — PIT 불변성 · 정정공시 폴백 · 경계 처리 · 스키마 가드.
//
// 이 파일이 막는 사고는 다섯 가지다.
//
//   ① **재무판 미래참조.** FY2023 사업보고서는 2024년 3월에 접수된다. `bsnsYear`로 고르면
//      2023년 내내 "아직 존재하지 않는 숫자"로 PBR을 계산하게 된다. 백테스트는 그걸
//      아무 소리 없이 통과시키고 성적만 부풀린다. **절단 불변성의 재무판**을 여기서 강제한다 —
//      시점 D 이후에 접수된 레코드를 입력에 아무리 더 넣어도 D 시점 팩터가 변하면 실패.
//   ② **정정공시 미래참조.** 정정본은 접수일이 늦은 별개 공시다. 정정 이전 시점에서
//      정정 후 숫자를 쓰면 "나중에 고쳐질 걸 미리 안" 것이 된다.
//   ③ **경계값이 랭킹을 뒤집는 것.** 적자 PER을 0으로, 자본잠식 PBR을 음수로 두면
//      **최악의 회사가 최고 점수**를 받는다. null → 랭킹 제외 → 제외 수 보고까지 고정한다.
//   ④ **계정 매칭 실패가 0으로 위장되는 것.** 스키마가 바뀌어 계정을 못 찾았는데 0을 채우면
//      "자본 0 = 자본잠식"으로 둔갑한다. 못 찾으면 던져야 한다(규칙 4).
//   ⑤ **틀린 파라미터가 통과하는 것.** DART는 `reprt_code=99999`도 status=000으로 준다
//      (2026-08-03 실측). API가 안 막으므로 우리가 막는다.
//
// 네트워크를 타지 않는다(이 컨테이너는 DART가 403 — 실호출 금지). 전부 픽스처.

import { check, close as closeTo, eq, finish, section } from './harness'
import {
  DART_FUNDAMENTALS_LIMITS,
  DART_FUNDAMENTALS_SCHEMA_INDEX,
  DART_FUNDAMENTALS_SCHEMA_STOCK,
  DART_STORED_ACCOUNTS,
  assertDartFsDiv,
  assertDartReprtCode,
  buildFactorSnapshot,
  checkAccountingIdentity,
  computeValueQualityFactors,
  dartFundamentalFile,
  dartNum,
  dartPeriodEnd,
  dartStatusKind,
  dartStatusMeaning,
  extractFundamentalRecord,
  factorSnapshotNote,
  krxMarketCapSeries,
  marketCapKnownAt,
  netIncomeKnownAt,
  parseFundamentalIndex,
  parseFundamentalStock,
  rankFactor,
  rceptNoToDate,
  readDartEnvelope,
  recordsKnownAt,
  selectFundamentalKnownAt,
} from '../src/features/backtest/fundamentals'
import type { FundamentalRecord, MarketCapPoint } from '../src/features/backtest/fundamentals'
import type { KrxDailyIndex, KrxDailyStock } from '../src/features/backtest/krxDailyPrices'

const throws = (fn: () => unknown): string | null => {
  try {
    fn()
    return null
  } catch (e) {
    return (e as Error).message
  }
}

// ---------------------------------------------------------------- 픽스처

/** 사업보고서 레코드 하나. 접수일은 rceptNo에서 유도되므로 둘이 어긋날 수 없다. */
function rec(o: {
  year: number
  rceptNo: string
  equity?: number | null
  netIncome?: number | null
  reprt?: FundamentalRecord['reprtCode']
  fsDiv?: FundamentalRecord['fsDiv']
  assets?: number | null
  liabilities?: number | null
  netIncomeAdd?: number | null
}): FundamentalRecord {
  return {
    bsnsYear: o.year,
    reprtCode: o.reprt ?? '11011',
    fsDiv: o.fsDiv ?? 'CFS',
    rceptNo: o.rceptNo,
    rceptDt: rceptNoToDate(o.rceptNo),
    equity: o.equity ?? null,
    equitySource: o.equity == null ? null : 'parent',
    assets: o.assets ?? null,
    liabilities: o.liabilities ?? null,
    netIncome: o.netIncome ?? null,
    netIncomeSource: o.netIncome == null ? null : 'parent',
    netIncomeAdd: o.netIncomeAdd ?? null,
    revenue: null,
    revenueAdd: null,
    operatingIncome: null,
    operatingIncomeAdd: null,
  }
}

// 한 종목의 공시 이력.
//   FY2022 사업보고서   접수 2023-03-15  자본 1000  순이익 100
//   FY2023 사업보고서   접수 2024-03-14  자본 1200  순이익 150
//   FY2023 **정정본**   접수 2024-06-20  자본 1150  순이익 140
//   FY2024 사업보고서   접수 2025-03-17  자본 1300  순이익 −50(적자)
const FY2022 = rec({ year: 2022, rceptNo: '20230315000001', equity: 1000, netIncome: 100 })
const FY2023 = rec({ year: 2023, rceptNo: '20240314000002', equity: 1200, netIncome: 150 })
const FY2023_FIX = rec({ year: 2023, rceptNo: '20240620000003', equity: 1150, netIncome: 140 })
const FY2024 = rec({ year: 2024, rceptNo: '20250317000004', equity: 1300, netIncome: -50 })
const HISTORY = [FY2022, FY2023, FY2023_FIX, FY2024]

/** 일별 시총 시계열 픽스처(원주가 × 주식수). */
function capSeries(dates: string[], closes: number[], shares: number): MarketCapPoint[] {
  return dates.map((d, i) => ({ date: d, marketCap: closes[i] * shares }))
}

// ------------------------------------------------- 0) 상수·한계 표기 유지

section('0) 상수·한계 표기 (규칙 3 — 지우면 화면이 정직성을 잃는다)')
{
  check('한계 목록이 비어 있지 않다', DART_FUNDAMENTALS_LIMITS.length >= 5)
  check(
    '2015년 이전 부재를 한계에 명시',
    DART_FUNDAMENTALS_LIMITS.some((l) => l.includes('2015')),
  )
  check(
    '연결/별도 혼합을 한계에 명시',
    DART_FUNDAMENTALS_LIMITS.some((l) => l.includes('CFS') || l.includes('별도')),
  )
  check(
    '분기 누적/개별 [미검증]을 한계에 명시',
    DART_FUNDAMENTALS_LIMITS.some((l) => l.includes('[미검증]')),
  )
  eq('저장 계정 6종', DART_STORED_ACCOUNTS.length, 6)
  eq('파일 경로 규약', dartFundamentalFile('005930'), 'stocks/005930.json')
  eq('스키마 이름(index)', DART_FUNDAMENTALS_SCHEMA_INDEX, 'dart-fundamentals/index@1')
  eq('스키마 이름(stock)', DART_FUNDAMENTALS_SCHEMA_STOCK, 'dart-fundamentals/stock@1')
}

// ------------------------------------------- 1) 값 변환 · 접수일 유도

section('1) dartNum · rceptNoToDate — "-"를 0으로 뭉개지 않는다')
{
  eq('콤마 제거', dartNum('300,870,903,000,000'), 300870903000000)
  eq('"-"는 null (0 아님)', dartNum('-'), null)
  eq('빈값은 null', dartNum(''), null)
  eq('null은 null', dartNum(null), null)
  eq('음수', dartNum('-1,234'), -1234)
  eq('괄호 음수', dartNum('(1,234)'), -1234)
  eq('숫자 아님은 null', dartNum('N/A'), null)

  eq('접수일 유도', rceptNoToDate('20240314000002'), '2024-03-14')
  check('13자리는 던진다', throws(() => rceptNoToDate('2024031400000')) !== null)
  check('실재하지 않는 날짜(2024-02-31)는 던진다', throws(() => rceptNoToDate('20240231000001')) !== null)
  check('빈값은 던진다', throws(() => rceptNoToDate(undefined)) !== null)
}

// --------------------------------- 2) 파라미터 화이트리스트 (API가 안 막는다)

section('2) reprt_code·fs_div 화이트리스트 — DART는 99999도 status=000으로 준다(실측)')
{
  eq('11011 통과', assertDartReprtCode('11011'), '11011')
  eq('11014 통과', assertDartReprtCode('11014'), '11014')
  check('99999는 던진다', throws(() => assertDartReprtCode('99999')) !== null)
  check('빈값은 던진다', throws(() => assertDartReprtCode('')) !== null)
  eq('CFS 통과', assertDartFsDiv('CFS'), 'CFS')
  check('XFS는 던진다', throws(() => assertDartFsDiv('XFS')) !== null)

  eq('status 000 = ok', dartStatusKind('000'), 'ok')
  eq('status 013 = empty(정상 0건)', dartStatusKind('013'), 'empty')
  eq('status 020 = quota', dartStatusKind('020'), 'quota')
  eq('status 011 = auth', dartStatusKind('011'), 'auth')
  check('모르는 코드는 [미검증]로 남는다', dartStatusMeaning('777').includes('[미검증]'))
  eq('기간 종료일 유도(정렬용)', dartPeriodEnd(2023, '11013'), '2023-03-31')
}

// ----------------------------------------- 3) 응답 → 레코드 추출 (규칙 4)

section('3) 계정 추출 — account_id 우선 · 못 찾으면 던진다(0으로 채우지 않는다)')
{
  const row = (o: Record<string, unknown>): Record<string, unknown> => ({
    rcept_no: '20240314000002',
    reprt_code: '11011',
    bsns_year: '2023',
    ...o,
  })
  const list = [
    row({ sj_div: 'BS', account_id: 'ifrs-full_Assets', account_nm: '자산총계', thstrm_amount: '1,000' }),
    row({ sj_div: 'BS', account_id: 'ifrs-full_Liabilities', account_nm: '부채총계', thstrm_amount: '400' }),
    row({ sj_div: 'BS', account_id: 'ifrs-full_Equity', account_nm: '자본총계', thstrm_amount: '600' }),
    row({
      sj_div: 'BS',
      account_id: 'ifrs-full_EquityAttributableToOwnersOfParent',
      account_nm: '지배기업의 소유주에게 귀속되는 자본',
      thstrm_amount: '550',
    }),
    row({ sj_div: 'IS', account_id: 'ifrs-full_Revenue', account_nm: '매출액', thstrm_amount: '2,000' }),
    row({ sj_div: 'IS', account_id: 'dart_OperatingIncomeLoss', account_nm: '영업이익', thstrm_amount: '300' }),
    row({ sj_div: 'IS', account_id: 'ifrs-full_ProfitLoss', account_nm: '당기순이익', thstrm_amount: '250' }),
  ]
  const r = extractFundamentalRecord(list, { bsnsYear: 2023, reprtCode: '11011', fsDiv: 'CFS' })
  eq('자산총계', r.assets, 1000)
  eq('부채총계', r.liabilities, 400)
  eq('자본 = 지배주주분 우선', r.equity, 550)
  eq('자본 출처 기록', r.equitySource, 'parent')
  eq('순이익(지배주주 계정 없으면 총계)', r.netIncome, 250)
  eq('순이익 출처 기록', r.netIncomeSource, 'total')
  eq('매출액', r.revenue, 2000)
  eq('영업이익', r.operatingIncome, 300)
  eq('접수일이 PIT 기준일로 들어간다', r.rceptDt, '2024-03-14')
  eq('fsDiv가 행에 남는다', r.fsDiv, 'CFS')

  // 항등식은 총계 기준으로만 판정한다 — 지배주주분을 썼으면 건너뛴다(비지배지분 때문에 안 맞는다).
  const idParent = checkAccountingIdentity(r)
  eq('지배주주 자본이면 항등식 판정 건너뜀', idParent.checked, false)
  const totalOnly = extractFundamentalRecord(
    list.filter((x) => x.account_id !== 'ifrs-full_EquityAttributableToOwnersOfParent'),
    { bsnsYear: 2023, reprtCode: '11011', fsDiv: 'CFS' },
  )
  const idTotal = checkAccountingIdentity(totalOnly)
  check('총계 기준 항등식 자산=부채+자본 통과', idTotal.checked && idTotal.ok)

  // account_id가 없어도 account_nm 관용 매칭으로 잡는다(공백 무시).
  const nmOnly = [
    row({ sj_div: 'BS', account_id: '-표준계정없음-', account_nm: ' 자 본 총 계 ', thstrm_amount: '700' }),
    row({ sj_div: 'IS', account_id: '-표준계정없음-', account_nm: '당기순이익(손실)', thstrm_amount: '80' }),
  ]
  const r2 = extractFundamentalRecord(nmOnly, { bsnsYear: 2023, reprtCode: '11011', fsDiv: 'OFS' })
  eq('account_nm 폴백(자본)', r2.equity, 700)
  eq('account_nm 폴백은 총계로 기록', r2.equitySource, 'total')
  eq('account_nm 폴백(순이익)', r2.netIncome, 80)

  // ④ 하나도 못 찾으면 던진다 — 0으로 채우면 자본잠식으로 둔갑한다.
  const junk = [row({ sj_div: 'BS', account_id: 'ifrs-full_Nonsense', account_nm: '알수없는계정', thstrm_amount: '1' })]
  const msg = throws(() => extractFundamentalRecord(junk, { bsnsYear: 2023, reprtCode: '11011', fsDiv: 'CFS' }))
  check('계정 전량 실패는 던진다', msg !== null && msg.includes('하나도 찾지 못했다'))

  check('list가 비면 던진다', throws(() => extractFundamentalRecord([], { bsnsYear: 2023, reprtCode: '11011', fsDiv: 'CFS' })) !== null)
  check(
    '응답 reprt_code가 요청과 다르면 던진다(파라미터 무시 탐지)',
    throws(() => extractFundamentalRecord(list, { bsnsYear: 2023, reprtCode: '11013', fsDiv: 'CFS' })) !== null,
  )
  check(
    '응답 bsns_year가 요청과 다르면 던진다',
    throws(() => extractFundamentalRecord(list, { bsnsYear: 2020, reprtCode: '11011', fsDiv: 'CFS' })) !== null,
  )
  check(
    '화이트리스트 밖 reprt_code는 추출 단계에서도 던진다',
    throws(() => extractFundamentalRecord(list, { bsnsYear: 2023, reprtCode: '99999' as never, fsDiv: 'CFS' })) !== null,
  )

  // 봉투 파싱 — HTTP 200이어도 본문 status가 진실이다.
  const env = readDartEnvelope({ status: '013', message: '조회된 데이타가 없습니다.' })
  eq('013 봉투', env.status, '013')
  eq('013은 list 빈 배열', env.list.length, 0)
  check('status 없는 응답은 던진다', throws(() => readDartEnvelope({ list: [] })) !== null)
}

// ------------------------------------------------- 4) PIT 필터 (규칙 1)

section('4) PIT 선택 — 접수일 기준. bsnsYear로 고르면 미래참조다')
{
  const at = (d: string): FundamentalRecord | null => selectFundamentalKnownAt(HISTORY, d)

  eq('2023-03-14(FY2022 접수 하루 전) → 쓸 재무 없음', at('2023-03-14'), null)
  eq('2023-03-15(접수 당일) → FY2022', at('2023-03-15')?.bsnsYear, 2022)
  // ⚠️ 여기가 핵심 — 2023-12-31에 FY2023을 쓰면 미래참조다(FY2023 공시는 2024-03-14 접수).
  eq('2023-12-31 → FY2022 (FY2023 아님!)', at('2023-12-31')?.bsnsYear, 2022)
  eq('2023-12-31 자본은 1000', at('2023-12-31')?.equity, 1000)
  eq('2024-03-14 → FY2023 원본', at('2024-03-14')?.rceptNo, '20240314000002')
  eq('2024-04-01 → FY2023 원본(자본 1200)', at('2024-04-01')?.equity, 1200)
  eq('2025-06-01 → FY2024', at('2025-06-01')?.bsnsYear, 2024)

  check('asOf 형식이 틀리면 던진다', throws(() => selectFundamentalKnownAt(HISTORY, '2024/03/14')) !== null)

  // 보고서 종류 필터 — 기본은 사업보고서만(분기 누적 [미검증] 때문에 보수적 경로).
  const q1 = rec({ year: 2024, rceptNo: '20240515000005', reprt: '11013', equity: 1250, netIncome: 40 })
  const withQ = [...HISTORY, q1]
  // 기본값(사업보고서만)에서는 2024-05-15 접수된 1Q2024가 보이지 않는다 → FY2023 정정본이 남는다.
  eq('기본은 사업보고서만 본다 → 2024-06-30은 FY2023 정정본', selectFundamentalKnownAt(withQ, '2024-06-30')?.rceptNo, '20240620000003')
  eq('기본값에서 1Q2024는 후보에 없다', selectFundamentalKnownAt(withQ, '2024-06-30')?.reprtCode, '11011')
  eq(
    '분기를 명시하면 더 최근 기간인 1Q2024가 잡힌다',
    selectFundamentalKnownAt(withQ, '2024-06-30', { reprtCodes: ['11011', '11013'] })?.rceptNo,
    '20240515000005',
  )
  eq(
    '분기를 명시해도 1Q 접수 이전(2024-05-14)에는 FY2023 원본',
    selectFundamentalKnownAt(withQ, '2024-05-14', { reprtCodes: ['11011', '11013'] })?.rceptNo,
    '20240314000002',
  )

  eq('recordsKnownAt은 D 이하만 돌려준다', recordsKnownAt(HISTORY, '2024-03-14').length, 2)
  check(
    'recordsKnownAt 결과에 D 이후 접수가 없다',
    recordsKnownAt(HISTORY, '2024-03-14').every((r) => r.rceptDt <= '2024-03-14'),
  )
}

// ------------------------------------------------- 5) 정정공시 폴백

section('5) 정정공시 — D가 정정 접수일 이전이면 직전 보고서를 쓴다')
{
  eq('2024-06-19(정정 하루 전) → 원본 자본 1200', selectFundamentalKnownAt(HISTORY, '2024-06-19')?.equity, 1200)
  eq('2024-06-20(정정 당일) → 정정본 자본 1150', selectFundamentalKnownAt(HISTORY, '2024-06-20')?.equity, 1150)
  eq('2024-06-20 정정본 접수번호', selectFundamentalKnownAt(HISTORY, '2024-06-20')?.rceptNo, '20240620000003')
  eq('2024-12-31 → 정정본이 계속 유지된다', selectFundamentalKnownAt(HISTORY, '2024-12-31')?.equity, 1150)

  // 정정본이 아직 없던 시점의 계산은 **원본 값으로 남아야 한다** — 나중에 정정본이 붙어도 변하면 안 된다.
  const before = selectFundamentalKnownAt([FY2022, FY2023], '2024-06-19')
  const after = selectFundamentalKnownAt(HISTORY, '2024-06-19')
  eq('정정본을 데이터에 추가해도 정정 이전 시점 값은 그대로', before?.equity, after?.equity)
}

// --------------------------------------------- 6) PIT 불변성 (집행자)

section('6) PIT 불변성 — D 이후 접수 레코드를 넣어도 D 시점 팩터가 변하지 않는다')
{
  const dates = ['2024-03-28', '2024-03-29', '2024-04-01', '2024-04-02', '2025-06-02']
  const caps = capSeries(dates, [100, 101, 102, 103, 120], 10) // 시총 1000·1010·1020·1030·1200

  const snapshotAt = (asOf: string, records: FundamentalRecord[]): string =>
    JSON.stringify(buildFactorSnapshot(asOf, [{ code: '005930', records, marketCaps: caps }]))

  for (const d of ['2023-12-31', '2024-04-01', '2024-06-19', '2024-06-20']) {
    // D 시점에 실제로 존재하던 데이터만 담은 "그때의 리포"
    const truncated = HISTORY.filter((r) => r.rceptDt <= d)
    // 오늘의 리포(미래 공시가 전부 들어 있다)
    const full = HISTORY
    eq(`절단 불변성 ${d}`, snapshotAt(d, truncated), snapshotAt(d, full))
  }

  // 미래 레코드를 아무리 붙여도 과거 단면이 변하지 않는다(무작위성 없는 결정론적 확인).
  const noisy = [
    ...HISTORY,
    rec({ year: 2025, rceptNo: '20260316000009', equity: 9999, netIncome: 9999 }),
    rec({ year: 2026, rceptNo: '20270316000010', equity: 1, netIncome: 1 }),
  ]
  eq('미래 공시를 더해도 2024-04-01 단면 동일', snapshotAt('2024-04-01', HISTORY), snapshotAt('2024-04-01', noisy))

  // 스냅샷이 실제로 D 이전 접수만 쓰는지 직접 확인.
  const snap = buildFactorSnapshot('2024-04-01', [{ code: '005930', records: HISTORY, marketCaps: caps }])
  check(
    '스냅샷의 rceptDt가 asOf를 넘지 않는다',
    snap.rows.every((r) => r.rceptDt === null || r.rceptDt <= r.asOf),
  )
  check(
    '스냅샷의 가격일자가 asOf를 넘지 않는다',
    snap.rows.every((r) => r.priceDate === null || r.priceDate <= r.asOf),
  )
  eq('가격은 D 이하 마지막 거래일', snap.rows[0].priceDate, '2024-04-01')
  closeTo('PBR = 시총 1020 ÷ 자본 1200', snap.rows[0].pbr ?? -1, 1020 / 1200, 1e-12)
  closeTo('PER = 시총 1020 ÷ 순이익 150', snap.rows[0].per ?? -1, 1020 / 150, 1e-12)
  closeTo('ROE = 순이익 150 ÷ 자본 1200', snap.rows[0].roe ?? -1, 150 / 1200, 1e-12)
  eq('순이익 기준은 기본이 연간', snap.rows[0].netIncomeBasis, 'annual')
}

// ------------------------------------------------- 7) 경계 처리

section('7) 경계 — 적자 PER null · 자본잠식 PBR/ROE null (0·무한대로 두면 랭킹이 뒤집힌다)')
{
  const normal = computeValueQualityFactors({ marketCap: 1000, equity: 500, netIncome: 100 })
  closeTo('정상 PBR', normal.pbr ?? -1, 2, 1e-12)
  closeTo('정상 PER', normal.per ?? -1, 10, 1e-12)
  closeTo('정상 ROE', normal.roe ?? -1, 0.2, 1e-12)

  const loss = computeValueQualityFactors({ marketCap: 1000, equity: 500, netIncome: -100 })
  eq('적자 → PER null', loss.per, null)
  closeTo('적자여도 PBR은 산출', loss.pbr ?? -1, 2, 1e-12)
  closeTo('적자 ROE는 음수로 살아 있다', loss.roe ?? 0, -0.2, 1e-12)
  check('적자 사유를 남긴다', loss.reasons.some((r) => r.includes('적자')))

  const zeroNi = computeValueQualityFactors({ marketCap: 1000, equity: 500, netIncome: 0 })
  eq('순이익 0도 PER null (무한대 금지)', zeroNi.per, null)

  const negEq = computeValueQualityFactors({ marketCap: 1000, equity: -200, netIncome: 100 })
  eq('자본잠식 → PBR null', negEq.pbr, null)
  eq('자본잠식 → ROE null', negEq.roe, null)
  closeTo('자본잠식이어도 흑자면 PER은 산출', negEq.per ?? -1, 10, 1e-12)
  check('자본잠식 사유를 남긴다', negEq.reasons.some((r) => r.includes('자본잠식')))

  const noData = computeValueQualityFactors({ marketCap: null, equity: null, netIncome: null })
  eq('데이터 없음 → PBR null', noData.pbr, null)
  eq('데이터 없음 → PER null', noData.per, null)
  eq('데이터 없음 → ROE null', noData.roe, null)

  // 랭킹 — null은 **제외**한다. 최하위로 밀어넣으면 결과가 뒤집힌다.
  const ranked = rankFactor(
    [
      { code: 'A', value: 3 },
      { code: 'B', value: 1 },
      { code: 'C', value: null, reason: '적자' },
      { code: 'D', value: 2 },
      { code: 'E', value: Number.NaN, reason: '비수치' },
    ],
    'asc',
  )
  eq('랭킹 대상은 3종목', ranked.ranked.length, 3)
  eq('제외 2종목', ranked.excludedCount, 2)
  eq('1위는 가장 작은 값', ranked.ranked[0].code, 'B')
  eq('3위는 가장 큰 값', ranked.ranked[2].code, 'A')
  check('제외 종목이 랭킹에 없다', !ranked.ranked.some((r) => r.code === 'C' || r.code === 'E'))
  eq('제외 사유가 남는다', ranked.excluded[0].reason, '적자')

  const desc = rankFactor(
    [
      { code: 'A', value: 0.1 },
      { code: 'B', value: 0.3 },
    ],
    'desc',
  )
  eq('desc는 큰 값이 1위', desc.ranked[0].code, 'B')

  // 동점 → 종목코드로 깨서 결정론 보장
  const tie = rankFactor(
    [
      { code: 'Z', value: 1 },
      { code: 'A', value: 1 },
    ],
    'asc',
  )
  eq('동점은 코드 오름차순', tie.ranked[0].code, 'A')
  eq('랭킹은 결정론적', JSON.stringify(rankFactor([{ code: 'Z', value: 1 }, { code: 'A', value: 1 }], 'asc')), JSON.stringify(tie))
}

// ---------------------------------- 8) 단면 — 제외 수를 반드시 보고한다

section('8) 단면 스냅샷 — 제외 수 집계 · 재무 없는 종목')
{
  const dates = ['2025-06-02']
  const caps = capSeries(dates, [100], 10)
  const emptyCaps: MarketCapPoint[] = []
  const negEquity = [rec({ year: 2024, rceptNo: '20250317000011', equity: -100, netIncome: 20 })]
  const lossCo = [rec({ year: 2024, rceptNo: '20250317000012', equity: 500, netIncome: -20 })]

  const snap = buildFactorSnapshot('2025-06-30', [
    { code: '000001', records: HISTORY, marketCaps: caps }, // FY2024 적자 → PER null
    { code: '000002', records: negEquity, marketCaps: caps }, // 자본잠식 → PBR·ROE null
    { code: '000003', records: lossCo, marketCaps: caps }, // 적자 → PER null
    { code: '000004', records: [], marketCaps: caps }, // 재무 없음
    { code: '000005', records: HISTORY, marketCaps: emptyCaps }, // 시총 없음
  ])
  eq('행 수', snap.rows.length, 5)
  eq('코드 오름차순으로 정렬', snap.rows.map((r) => r.code).join(','), '000001,000002,000003,000004,000005')
  eq('재무 없는 종목 수', snap.noFundamental, 1)
  eq('PER 제외 수(적자 2 + 재무없음 1 + 시총없음 1)', snap.excluded.per, 4)
  eq('PBR 제외 수(자본잠식 1 + 재무없음 1 + 시총없음 1)', snap.excluded.pbr, 3)
  eq('ROE 제외 수(자본잠식 1 + 재무없음 1)', snap.excluded.roe, 2)
  check('요약 한 줄에 제외 수가 들어간다', factorSnapshotNote(snap).includes('제외'))
  check('재무 없는 종목에 사유가 남는다', snap.rows[3].notes.some((n) => n.includes('재무가 없다')))

  // 결정론 — 같은 입력을 두 번 돌리면 완전히 같다.
  const again = buildFactorSnapshot('2025-06-30', [
    { code: '000001', records: HISTORY, marketCaps: caps },
    { code: '000002', records: negEquity, marketCaps: caps },
    { code: '000003', records: lossCo, marketCaps: caps },
    { code: '000004', records: [], marketCaps: caps },
    { code: '000005', records: HISTORY, marketCaps: emptyCaps },
  ])
  eq('결정론', JSON.stringify(snap), JSON.stringify(again))
}

// ------------------------------------------------- 9) 순이익 기준(TTM)

section('9) 순이익 — 기본은 사업보고서 연간값. TTM은 [미검증] opt-in')
{
  const annual = netIncomeKnownAt(HISTORY, '2024-04-01')
  eq('기본 basis', annual.basis, 'annual')
  eq('기본 값 = FY2023 연간', annual.value, 150)

  // 분기가 섞여 있어도 기본 경로는 사업보고서만 본다.
  const q1_2024 = rec({ year: 2024, rceptNo: '20240515000021', reprt: '11013', netIncome: 40, netIncomeAdd: 40 })
  const withQ = [...HISTORY, q1_2024]
  eq('분기가 있어도 기본은 연간', netIncomeKnownAt(withQ, '2024-06-01').basis, 'annual')
  eq('분기가 있어도 기본 값은 FY2023 연간', netIncomeKnownAt(withQ, '2024-06-01').value, 150)

  // TTM opt-in — 근거(전년 동기 누적)가 없으면 조용히 계산하지 않고 연간으로 내려온다.
  const noBase = netIncomeKnownAt(withQ, '2024-06-01', { mode: 'ttm' })
  eq('TTM 근거 부족 → annual 폴백', noBase.basis, 'annual')
  check('폴백 사유를 남긴다', noBase.notes.some((n) => n.includes('폴백')))

  // 전년 동기 누적이 있으면 TTM을 계산하되 [미검증] 표기를 단다.
  const q1_2023 = rec({ year: 2023, rceptNo: '20230515000022', reprt: '11013', netIncome: 30, netIncomeAdd: 30 })
  const full = [...HISTORY, q1_2023, q1_2024]
  const ttm = netIncomeKnownAt(full, '2024-06-01', { mode: 'ttm' })
  eq('TTM basis', ttm.basis, 'ttm-unverified')
  eq('TTM = 40 + 150 − 30', ttm.value, 160)
  check('[미검증] 표기가 붙는다', ttm.notes.some((n) => n.includes('[미검증]')))

  eq('D 시점에 아무 공시도 없으면 none', netIncomeKnownAt(HISTORY, '2020-01-01').basis, 'none')
}

// ------------------------------------------- 10) 시가총액(KRX 일별 정본)

section('10) 시가총액 = 원주가 종가 × 상장주식수 (수정주가로 곱하면 분할 때 틀린다)')
{
  const calendar = ['2020-01-02', '2020-01-03', '2020-01-06', '2020-01-07']
  const index = {
    schema: 'krx-daily/index@1',
    version: 1,
    source: 'fixture',
    basis: 'fixture',
    asOf: '2020-01-08',
    from: calendar[0],
    to: calendar[calendar.length - 1],
    calendar,
    missingDays: [],
    volume: false,
    limits: ['fixture'],
    stocks: [],
  } as KrxDailyIndex

  // 2020-01-06에 2:1 분할 — 가격 반토막, 주식수 2배. 시총은 이어져야 한다.
  const stock = {
    schema: 'krx-daily/prices@1',
    code: '005930',
    name: '테스트',
    adjustment: 'raw',
    dividendAdjusted: false,
    market: 'kospi',
    markets: ['kospi'],
    rows: [
      [0, 100, 100, 100, 100],
      [1, 100, 100, 100, 100],
      [2, 50, 50, 50, 50],
      [3, 52, 52, 52, 52],
    ],
    shares: [
      [0, 1000],
      [2, 2000],
    ],
    events: [],
  } as unknown as KrxDailyStock

  const series = krxMarketCapSeries(index, stock)
  eq('시계열 길이', series.length, 4)
  eq('분할 전 시총', series[1].marketCap, 100 * 1000)
  eq('분할 당일 시총(연속)', series[2].marketCap, 50 * 2000)
  eq('날짜 매핑', series[3].date, '2020-01-07')

  eq('거래일 당일', marketCapKnownAt(series, '2020-01-06')?.date, '2020-01-06')
  eq('휴장일은 직전 거래일', marketCapKnownAt(series, '2020-01-05')?.date, '2020-01-03')
  eq('시계열 시작 이전은 null', marketCapKnownAt(series, '2019-12-31'), null)
  eq('마지막 이후는 마지막 거래일', marketCapKnownAt(series, '2030-01-01')?.date, '2020-01-07')
  check('asOf 형식 위반은 던진다', throws(() => marketCapKnownAt(series, '20200106')) !== null)
}

// ------------------------------------------------- 11) 스키마 가드

section('11) 스키마 파서 — 틀린 파일이 조용히 통과하지 않는다')
{
  const stockObj = {
    schema: DART_FUNDAMENTALS_SCHEMA_STOCK,
    code: '005930',
    corpCode: '00126380',
    name: '삼성전자',
    unit: 'KRW',
    records: [FY2022, FY2023, FY2023_FIX, FY2024],
  }
  const parsed = parseFundamentalStock(stockObj)
  eq('정상 파일은 통과', parsed.records.length, 4)
  eq('레코드 왕복(JSON) 동일', JSON.stringify(parseFundamentalStock(JSON.parse(JSON.stringify(stockObj)))), JSON.stringify(parsed))

  check('스키마 이름이 다르면 던진다', throws(() => parseFundamentalStock({ ...stockObj, schema: 'x' })) !== null)
  check('code가 6자리가 아니면 던진다', throws(() => parseFundamentalStock({ ...stockObj, code: '5930' })) !== null)
  check('corpCode가 8자리가 아니면 던진다', throws(() => parseFundamentalStock({ ...stockObj, corpCode: '123' })) !== null)
  check('unit이 KRW가 아니면 던진다', throws(() => parseFundamentalStock({ ...stockObj, unit: 'MKRW' })) !== null)
  check('records가 비면 던진다', throws(() => parseFundamentalStock({ ...stockObj, records: [] })) !== null)
  check(
    '접수일 오름차순이 아니면 던진다',
    throws(() => parseFundamentalStock({ ...stockObj, records: [FY2023, FY2022] })) !== null,
  )
  check(
    '같은 공시 중복이면 던진다',
    throws(() => parseFundamentalStock({ ...stockObj, records: [FY2022, FY2022] })) !== null,
  )
  check(
    'rceptDt가 rceptNo와 어긋나면 던진다',
    throws(() => parseFundamentalStock({ ...stockObj, records: [{ ...FY2022, rceptDt: '2023-03-16' }] })) !== null,
  )
  check(
    '화이트리스트 밖 reprtCode면 던진다',
    throws(() => parseFundamentalStock({ ...stockObj, records: [{ ...FY2022, reprtCode: '99999' }] })) !== null,
  )
  check(
    '계정이 전부 null인 빈 레코드는 던진다',
    throws(() =>
      parseFundamentalStock({
        ...stockObj,
        records: [{ ...FY2022, equity: null, equitySource: null, netIncome: null, netIncomeSource: null }],
      }),
    ) !== null,
  )
  check(
    '접수일이 사업연도 시작보다 이르면 던진다(PIT 근거 위반)',
    throws(() => parseFundamentalStock({ ...stockObj, records: [rec({ year: 2024, rceptNo: '20230315000001', equity: 1 })] })) !==
      null,
  )

  const indexObj = {
    schema: DART_FUNDAMENTALS_SCHEMA_INDEX,
    version: 1,
    source: 'DART OpenAPI',
    basis: 'fixture',
    asOf: '2026-08-03',
    fromYear: 2015,
    toYear: 2026,
    reprtCodes: ['11011', '11013'],
    accounts: [...DART_STORED_ACCOUNTS],
    accountsTrimmed: true,
    missingCodes: ['123456'],
    unmappedCodes: [],
    latestRceptDt: '2026-05-15',
    limits: [...DART_FUNDAMENTALS_LIMITS],
    stocks: [
      {
        code: '005930',
        corpCode: '00126380',
        name: '삼성전자',
        records: 4,
        firstYear: 2022,
        lastYear: 2024,
        latestRceptDt: '2025-03-17',
        fsDivs: ['CFS'],
        file: 'stocks/005930.json',
      },
    ],
  }
  eq('정상 index는 통과', parseFundamentalIndex(indexObj).stocks.length, 1)
  check('한계 목록을 지우면 던진다', throws(() => parseFundamentalIndex({ ...indexObj, limits: [] })) !== null)
  check('accounts를 지우면 던진다', throws(() => parseFundamentalIndex({ ...indexObj, accounts: [] })) !== null)
  check(
    'file 경로 규약을 어기면 던진다',
    throws(() => parseFundamentalIndex({ ...indexObj, stocks: [{ ...indexObj.stocks[0], file: '005930.json' }] })) !== null,
  )
  check(
    'fsDivs가 비면 던진다(연결/별도 은닉 금지)',
    throws(() => parseFundamentalIndex({ ...indexObj, stocks: [{ ...indexObj.stocks[0], fsDivs: [] }] })) !== null,
  )
  check(
    'missingCodes에 6자리 아닌 값이 있으면 던진다',
    throws(() => parseFundamentalIndex({ ...indexObj, missingCodes: ['abc'] })) !== null,
  )
  check('중복 종목코드는 던진다', throws(() => parseFundamentalIndex({ ...indexObj, stocks: [indexObj.stocks[0], indexObj.stocks[0]] })) !== null)
}

finish()
