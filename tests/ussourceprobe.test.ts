// 미장 시세 소스 실사 프로브 — 파서·회사일치 판정·생존 게이트 검증 (합성 픽스처, 네트워크 없음).
//
// 이 파일이 막는 사고는 세 가지다.
//
//   ① **"소스가 죽은 것"을 "종목이 없는 것"으로 착각하는 것.** 둘 다 0건이지만 뜻이 반대다.
//      토큰 만료·한도 초과로 전패한 소스의 "없음"을 커버리지 근거로 쓰면, 그 위에서 내리는
//      소스 전환 결정이 통째로 틀어진다. `applyLiveness`가 대조군 전패 소스의 absent를
//      error로 강등하는지 검증한다.
//   ② **티커 재사용을 커버리지로 세는 것.** 미국 티커는 회사가 사라지면 재배정된다
//      (LU=Lucent→Lufax, S=Sprint→SentinelOne). "WCOM에 데이터가 있다"가 곧 "WorldCom
//      데이터가 있다"가 아니다. `judgeCompany`가 상폐 이벤트일과 응답 날짜를 대조해
//      reused/mismatch를 가르는지, `summarize`가 **match만** 세는지 검증한다.
//   ③ **오류를 조용히 0건으로 삼키는 것.** 이 프로브가 상대하는 소스 넷 중 셋이 오류를
//      **HTTP 200 본문**으로 준다(stooq "No data"·alphavantage "Error Message"/"Note"·
//      키움 return_code). 한도 초과처럼 "소스 실패"인 것을 absent로 처리하면 없는 결론이
//      생긴다. 파서가 무엇을 absent로, 무엇을 throw로 가르는지 못박는다.
//
// 네트워크를 타지 않는다 — 어댑터가 아니라 순수 파서·판정 함수만 부른다.

import { check, eq, section, finish } from './harness'
import {
  DELISTED_REFS,
  LIVE_REFS,
  applyLiveness,
  dashDate,
  errorResult,
  judgeCompany,
  parseAlphaVantageDaily,
  parseKiwoomUsChart,
  parseStooqCsv,
  parseTiingoDaily,
  parseYahooChart,
  refFor,
  renderTable,
  renderVerdict,
  selectSources,
  skippedResult,
  summarize,
  toDay,
  toResult,
  type ProbeResult,
} from '../scripts/us-source-probe.entry'

const TODAY = '2026-08-03'

function threw(fn: () => unknown): string | null {
  try {
    fn()
    return null
  } catch (e) {
    return (e as Error).message
  }
}

/** ok 결과를 손으로 만든다(어댑터 없이 판정만 보기 위해). */
function okRow(source: string, ticker: string, bars: { date: string; close: number }[], truncated = false): ProbeResult {
  return toResult(source, ticker, { kind: 'ok', bars, note: '' }, { truncated })
}

// ────────────────────────────────────────────────────────── 1) 기준표
section('1) 대조 기준표')
{
  eq('상폐 대상 8종', DELISTED_REFS.length, 8)
  eq('대조군 4종', LIVE_REFS.length, 4)
  check('상폐 8종 전부 이벤트일 보유', DELISTED_REFS.every((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.eventDate ?? '')))
  check('BK가 대조군에 있다(41차 야후 404 재현 대상)', LIVE_REFS.some((r) => r.ticker === 'BK'))
  eq('refFor(WCOM).company', refFor('WCOM')?.company, 'WorldCom')
  eq('toDay 형식 위반은 null', toDay('2002/07/21'), null)
  eq('dashDate 20020721', dashDate('20020721'), '2002-07-21')
  eq('dashDate 형식 위반은 null', dashDate('2002-07-21'), null)
}

// ────────────────────────────────────────────────────────── 2) stooq
section('2) stooq CSV — 오류가 HTTP 200 본문으로 온다')
{
  const csv = 'Date,Open,High,Low,Close,Volume\n2002-06-26,0.83,0.91,0.09,0.20,1500000\n2002-06-25,1.79,1.90,0.80,0.83,900000\n'
  const out = parseStooqCsv(csv)
  eq('정상 CSV → ok', out.kind, 'ok')
  eq('봉 2개', out.bars.length, 2)
  eq('오름차순 정렬 첫 봉', out.bars[0].date, '2002-06-25')
  eq('마지막 종가', out.bars[1].close, 0.2)

  eq('"No data" → absent(그 종목이 없다)', parseStooqCsv('No data').kind, 'absent')
  check('일일 한도 초과는 absent가 아니라 throw', threw(() => parseStooqCsv('Exceeded the daily hits limit')) != null)
  check('빈 응답은 throw(정상 0건으로 취급 금지)', threw(() => parseStooqCsv('   ')) != null)
  check('헤더가 바뀌면 throw', threw(() => parseStooqCsv('Datum,Schluss\n2002-06-25,0.83')) != null)
  check('전 행 파싱 실패는 throw', threw(() => parseStooqCsv('Date,Open,High,Low,Close,Volume\nxxx,1,1,1,1,1')) != null)
}

// ────────────────────────────────────────────────────────── 3) tiingo
section('3) tiingo — 배열 응답')
{
  const rows = [
    { date: '2019-11-20T00:00:00.000Z', close: 108.24, adjClose: 108.24 },
    { date: '2019-11-19T00:00:00.000Z', close: 108.1, adjClose: 108.1 },
  ]
  const out = parseTiingoDaily(rows)
  eq('정상 → ok', out.kind, 'ok')
  eq('ISO 날짜를 YYYY-MM-DD로 절단', out.bars[0].date, '2019-11-19')
  eq('빈 배열 → absent', parseTiingoDaily([]).kind, 'absent')
  check('오류 본문(detail) → throw', threw(() => parseTiingoDaily({ detail: 'Error: Ticker not found' })) != null)
  check('배열이 아니면 throw', threw(() => parseTiingoDaily('nope')) != null)
  check('필드명이 바뀌면 throw', threw(() => parseTiingoDaily([{ d: '2019-11-20', c: 1 }])) != null)
}

// ────────────────────────────────────────────────────────── 4) alphavantage
section('4) alphavantage — 오류·한도가 HTTP 200 본문')
{
  const json = {
    'Meta Data': { '2. Symbol': 'CELG' },
    'Time Series (Daily)': {
      '2019-11-20': { '1. open': '108.0', '2. high': '108.5', '3. low': '107.9', '4. close': '108.24', '5. volume': '100' },
      '2019-11-19': { '1. open': '107.0', '2. high': '108.2', '3. low': '106.9', '4. close': '108.10', '5. volume': '120' },
    },
  }
  const out = parseAlphaVantageDaily(json)
  eq('정상 → ok', out.kind, 'ok')
  eq('봉 2개', out.bars.length, 2)
  eq('종가 파싱', out.bars[1].close, 108.24)

  eq('"Error Message"(없는 심볼) → absent', parseAlphaVantageDaily({ 'Error Message': 'Invalid API call' }).kind, 'absent')
  check('"Note"(한도) → throw', threw(() => parseAlphaVantageDaily({ Note: 'standard API call frequency is 5 calls per minute' })) != null)
  check('"Information"(한도) → throw', threw(() => parseAlphaVantageDaily({ Information: 'rate limit' })) != null)
  check('시계열 키가 없으면 throw', threw(() => parseAlphaVantageDaily({ foo: 1 })) != null)
  eq('시계열이 비면 absent', parseAlphaVantageDaily({ 'Time Series (Daily)': {} }).kind, 'absent')
}

// ────────────────────────────────────────────────────────── 5) yahoo
section('5) yahoo v8 chart')
{
  const json = {
    chart: {
      result: [
        {
          meta: { symbol: 'AAPL' },
          timestamp: [1500000000, 1500086400],
          indicators: { quote: [{ close: [150.5, null] }] },
        },
      ],
      error: null,
    },
  }
  const out = parseYahooChart(json)
  eq('정상 → ok', out.kind, 'ok')
  eq('null 종가는 탈락', out.bars.length, 1)

  const notFound = { chart: { result: null, error: { code: 'Not Found', description: 'No data found, symbol may be delisted' } } }
  eq('Not Found → absent(그 종목이 없다)', parseYahooChart(notFound).kind, 'absent')
  check(
    '그 외 error는 throw',
    threw(() => parseYahooChart({ chart: { result: null, error: { code: 'Unauthorized', description: 'x' } } })) != null,
  )
  check('chart 키가 없으면 throw', threw(() => parseYahooChart({ finance: {} })) != null)
  check(
    'timestamp/close를 못 찾으면 throw',
    threw(() => parseYahooChart({ chart: { result: [{ meta: {} }], error: null } })) != null,
  )
}

// ────────────────────────────────────────────────────────── 6) 키움
section('6) 키움 미국주식 차트(usa06012) — return_code는 HTTP 200 본문')
{
  const json = {
    result_list: [
      { dt: '20260731', cur_prc: '+150200', open_pric: '149000', high_pric: '151000', low_pric: '148000', acc_trde_qty: '1000' },
      { dt: '20260730', cur_prc: '-149000', open_pric: '150000', high_pric: '150500', low_pric: '148500', acc_trde_qty: '900' },
    ],
    return_code: 0,
    return_msg: '정상적으로 처리되었습니다',
  }
  const out = parseKiwoomUsChart(json)
  eq('정상 → ok', out.kind, 'ok')
  eq('YYYYMMDD → YYYY-MM-DD', out.bars[0].date, '2026-07-30')
  eq('대비부호(-) 제거', out.bars[0].close, 149000)
  eq('대비부호(+) 제거', out.bars[1].close, 150200)

  eq('빈 result_list → absent', parseKiwoomUsChart({ result_list: [], return_code: 0 }).kind, 'absent')
  check(
    'return_code≠0 → throw (200이라도 실패다)',
    threw(() => parseKiwoomUsChart({ result_list: [], return_code: 3, return_msg: '조회 권한 없음' })) != null,
  )
  check('행 배열 키가 아예 없으면 throw', threw(() => parseKiwoomUsChart({ return_code: 0 })) != null)
  // 관용 파싱 — 문서에 없는 키로 바뀌어도 "객체 배열인 첫 값"을 행으로 본다
  const renamed = { us_chart_qry: [{ dt: '20260731', cur_prc: '10' }], return_code: 0 }
  eq('키가 바뀌어도 관용 파싱', parseKiwoomUsChart(renamed).bars.length, 1)
  check('행은 있는데 전부 파싱 실패면 throw', threw(() => parseKiwoomUsChart({ result_list: [{ x: 1 }], return_code: 0 })) != null)
}

// ────────────────────────────────────────────────────────── 7) 회사 일치 판정
section('7) 회사 일치 판정 — 티커 재사용 함정')
{
  const wcom = refFor('WCOM')!
  const real = okRow('stooq', 'WCOM', [
    { date: '1996-01-02', close: 22.5 },
    { date: '2002-06-26', close: 0.2 },
  ])
  eq('상폐 직전까지 있는 데이터 → match', judgeCompany(wcom, real, TODAY).code, 'match')

  const reused = okRow('stooq', 'WCOM', [
    { date: '1996-01-02', close: 22.5 },
    { date: '2020-06-26', close: 31.4 },
  ])
  eq('상폐 후까지 이어지면 → reused(다른 회사)', judgeCompany(wcom, reused, TODAY).code, 'reused')

  const otherCompany = okRow('stooq', 'WCOM', [
    { date: '2015-01-02', close: 12.5 },
    { date: '2020-06-26', close: 31.4 },
  ])
  eq('시작조차 상폐 이후면 → mismatch', judgeCompany(wcom, otherCompany, TODAY).code, 'mismatch')

  const celg = refFor('CELG')!
  const early = okRow('tiingo', 'CELG', [
    { date: '2005-01-03', close: 27 },
    { date: '2016-01-04', close: 105 },
  ])
  eq('상폐보다 한참 일찍 끊기면 → partial', judgeCompany(celg, early, TODAY).code, 'partial')

  // 가격 밴드는 **소프트 경고**다 — 판정을 뒤집지 않는다
  const oddPrice = okRow('stooq', 'CELG', [
    { date: '2005-01-03', close: 27 },
    { date: '2019-11-19', close: 3.2 },
  ])
  const v = judgeCompany(celg, oddPrice, TODAY)
  eq('가격이 밴드 밖이어도 판정은 match', v.code, 'match')
  check('대신 경고가 사유에 남는다', /경고/.test(v.note))

  const aapl = refFor('AAPL')!
  eq('살아있는 티커 최신 → match', judgeCompany(aapl, okRow('stooq', 'AAPL', [{ date: '1996-01-02', close: 5 }, { date: '2026-08-01', close: 250 }]), TODAY).code, 'match')
  eq(
    '살아있는데 오래 멈췄으면 → partial',
    judgeCompany(aapl, okRow('stooq', 'AAPL', [{ date: '1996-01-02', close: 5 }, { date: '2025-01-02', close: 200 }]), TODAY).code,
    'partial',
  )

  eq('응답 자체가 없으면 판정 대상 아님', judgeCompany(wcom, errorResult('stooq', 'WCOM', 'HTTP 500'), TODAY).code, 'n/a')

  const thin = okRow('yahoo', 'WCOM', [{ date: '2002-06-26', close: 0.2 }])
  check('봉이 너무 적으면 껍데기 의심을 사유에 남긴다', /껍데기/.test(judgeCompany(wcom, thin, TODAY).note))
  const trunc = okRow('kiwoom-us', 'WCOM', [{ date: '1996-01-02', close: 22.5 }, { date: '2002-06-26', close: 0.2 }], true)
  check('페이지 상한에 걸린 것과 끝난 것을 구분한다', /잘림/.test(judgeCompany(wcom, trunc, TODAY).note))
}

// ────────────────────────────────────────────────────────── 8) 생존 게이트
section('8) 소스 생존 게이트 — 정상 0건 vs 실패 0건')
{
  const absent = (source: string, ticker: string): ProbeResult =>
    toResult(source, ticker, { kind: 'absent', bars: [], note: '없음' })

  // (a) 대조군이 성공한 소스: absent는 그대로 신뢰한다
  const alive = applyLiveness([
    okRow('stooq', 'AAPL', [{ date: '1996-01-02', close: 5 }, { date: '2026-08-01', close: 250 }]),
    absent('stooq', 'WCOM'),
  ])
  eq('대조군 성공 소스의 absent는 유지', alive[1].kind, 'absent')

  // (b) 대조군이 전패한 소스: absent를 error로 강등한다
  const dead = applyLiveness([errorResult('tiingo', 'AAPL', 'HTTP 401'), absent('tiingo', 'WCOM')])
  eq('대조군 전패 소스의 absent는 error로 강등', dead[1].kind, 'error')
  check('강등 사유가 남는다', /생존 미확인/.test(dead[1].reason))

  // (c) 강등은 소스별로만 일어난다(다른 소스를 오염시키지 않는다)
  const mixed = applyLiveness([
    okRow('stooq', 'AAPL', [{ date: '2026-08-01', close: 250 }]),
    absent('stooq', 'WCOM'),
    errorResult('tiingo', 'AAPL', 'HTTP 401'),
    absent('tiingo', 'WCOM'),
  ])
  eq('stooq absent 유지', mixed[1].kind, 'absent')
  eq('tiingo absent 강등', mixed[3].kind, 'error')
}

// ────────────────────────────────────────────────────────── 9) 요약·판정
section('9) 요약·판정 한 줄')
{
  const liveOk = LIVE_REFS.map((r) => okRow('stooq', r.ticker, [{ date: '1996-01-02', close: 5 }, { date: '2026-08-01', close: 250 }]))

  // reused는 커버리지가 아니다 — 이걸 세면 이 프로브가 사고를 만든다
  const withReuse = [...liveOk, okRow('stooq', 'WCOM', [{ date: '1996-01-02', close: 22 }, { date: '2020-06-26', close: 31 }])]
  eq('reused는 상폐 커버리지로 세지 않는다', summarize(withReuse, TODAY)[0].delistedMatch, 0)

  const withReal = [...liveOk, okRow('stooq', 'WCOM', [{ date: '1996-01-02', close: 22 }, { date: '2002-06-26', close: 0.2 }])]
  eq('회사일치 상폐 1건은 센다', summarize(withReal, TODAY)[0].delistedMatch, 1)
  check('판정: 커버리지 있는 소스가 있다', /상폐 커버리지가 있는 소스가 있다/.test(renderVerdict(withReal, TODAY)))

  const noCoverage = [...liveOk, toResult('stooq', 'WCOM', { kind: 'absent', bars: [], note: 'No data' })]
  check('판정: 무료 소스에 커버리지 없음 → 유료 검토', /유료 소스.*검토/.test(renderVerdict(applyLiveness(noCoverage), TODAY)))

  const allDead = LIVE_REFS.map((r) => errorResult('stooq', r.ticker, 'HTTP 500'))
  check('대조군 전패면 "판정 불가"', /판정 불가/.test(renderVerdict(applyLiveness(allDead), TODAY)))

  // skipped(키 없음)는 실패로도 성공으로도 세지 않는다
  const sum = summarize([skippedResult('tiingo', 'WCOM', '키 없음')], TODAY)[0]
  eq('skipped는 error로 안 센다', sum.errors, 0)
  eq('skipped 카운트', sum.skipped, 1)
}

// ────────────────────────────────────────────────────────── 10) 모드·표
section('10) MODE 라우팅 · 표 렌더')
{
  eq('MODE=kiwoom은 키움만', selectSources('kiwoom').join(','), 'kiwoom-us')
  check('MODE=free는 키움을 부르지 않는다(EC2 전용 경로 차단)', !selectSources('free').includes('kiwoom-us'))
  eq('MODE=all은 5소스', selectSources('all').length, 5)
  eq('필터가 걸리면 교집합', selectSources('all', 'stooq,yahoo').join(','), 'stooq,yahoo')

  const table = renderTable(
    [
      okRow('stooq', 'WCOM', [{ date: '1996-01-02', close: 22 }, { date: '2002-06-26', close: 0.2 }]),
      errorResult('tiingo', 'WCOM', 'HTTP 401'),
    ],
    TODAY,
  )
  check('표에 소스·티커·판정이 들어간다', /stooq/.test(table) && /WCOM/.test(table) && /match/.test(table))
  check('표에 error 행도 남는다', /tiingo/.test(table) && /error/.test(table))
}

finish()
