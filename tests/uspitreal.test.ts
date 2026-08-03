// 미장 **실측** PIT 유니버스 — 위키텍스트 파서 · 되감기 · 신뢰구간 게이트 · 스키마 검증.
//
// 이 파일이 막는 사고:
//
//   ① **틀린 목록이 그럴듯하게 통과하는 것.** 유니버스가 틀리면 그 위에서 고른 파라미터도
//      같이 무효다(국장 33차: [추정] → 실측 교체로 알파 +21.9%p → +2.6%p, 승자 3종 중 2종 전멸).
//      되감기는 "변경 이력표가 완전하다"는 가정 위에 서 있는데 Wikipedia의 그 표는 제목부터
//      "**Selected** changes"다. 그래서 **게이트 2종이 신뢰 경계를 데이터로 정하고**,
//      스키마 파서가 그 경계를 사람이 손으로 늘리지 못하게 막는다. 여기서 그 둘을 검증한다.
//
//   ② **티커 재사용 오염.** 미국 티커는 회사가 사라지면 다른 회사에 재배정된다
//      (LU=Lucent→Lufax, SUNW=Sun Microsystems→Sunworks). 그대로 조회하면 "상폐된 대형주"
//      자리에 전혀 다른 소형주 시계열이 들어와 백테스트가 **조용히** 오염된다 —
//      매핑 실패보다 훨씬 나쁘다. 사명 충돌을 잡아 조회를 거부하는지 검증한다.
//
//   ③ **열 밀림(rowspan).** 변경 이력표는 같은 날 여러 종목이 바뀌면 Date 칸을 rowspan으로
//      묶는다. 이걸 무시하면 뒤 행의 열이 한 칸씩 밀려 "티커 자리에 사유"가 들어온다.
//
// 네트워크를 타지 않는다 — 전부 **합성 픽스처**다(컨테이너에서 en.wikipedia.org는 403).
// 실제 응답으로 확정해야 할 항목은 코드에 `[미검증]`으로 남아 있고, 첫 GHA 실행에서 지운다.

import { check, eq, section, finish } from './harness'
import {
  US_BLOCKED_TICKERS,
  US_PIT_REAL_LOAD_FAIL,
  buildUsPitRealUniverse,
  deriveUsRealUniverse,
  judgeUsPitReliability,
  loadUsPitRealUniverse,
  parseUsPitRealUniverse,
  resolveUsRealTicker,
  usRealAllYears,
  usRealCodes,
  usRealFetchUnion,
  usRealNameConflicts,
  usRealSourceNote,
  usRealSpan,
  usRealUnclassifiedConflicts,
  usRealYears,
  type UsPitRealUniverse,
  type UsPitYearRecord,
} from '../src/features/backtest/usPitUniverse'
import {
  expandSpans,
  extractTableBlocks,
  extractWikitext,
  headerOf,
  normTicker,
  parseChangesTable,
  parseCurrentTable,
  parseTableRows,
  parseWikiDate,
  pickTable,
  plain,
  rewind,
  userAgent,
  type ChangeRow,
  type CurrentMember,
} from '../scripts/us-pit-collect.entry'

/** 던지는지 검사 — 메시지 일부까지 확인해 "다른 이유로 던진 것"을 통과시키지 않는다. */
function throws(name: string, fn: () => unknown, must = ''): void {
  let msg = ''
  try {
    fn()
  } catch (e) {
    msg = (e as Error).message
  }
  if (!msg) {
    check(name, false, '던지지 않았다')
    return
  }
  check(name, must === '' || msg.includes(must), must ? `메시지에 "${must}"가 없다 — ${msg}` : '')
}

async function throwsAsync(name: string, fn: () => Promise<unknown>, must = ''): Promise<void> {
  let msg = ''
  try {
    await fn()
  } catch (e) {
    msg = (e as Error).message
  }
  if (!msg) {
    check(name, false, '던지지 않았다')
    return
  }
  check(name, must === '' || msg.includes(must), must ? `메시지에 "${must}"가 없다 — ${msg}` : '')
}

// ═════════════════════════════════════════════════════════════════════════════
section('① Wikipedia 응답 처리 — 오류는 HTTP 200 본문으로 온다(규칙 4 ⑤)')

check('서술형 User-Agent — 정책 위반(빈 UA·일반값) 방지', /kr-market-leverage-dashboard/.test(userAgent()) && /https:\/\//.test(userAgent()))

eq(
  'formatversion=2: parse.wikitext가 문자열',
  extractWikitext(200, null, JSON.stringify({ parse: { title: 'X', wikitext: '{|\n|}' } })),
  '{|\n|}',
)
eq(
  "formatversion=1: parse.wikitext['*'] 도 받아들인다(관용 파싱)",
  extractWikitext(200, null, JSON.stringify({ parse: { title: 'X', wikitext: { '*': 'abc' } } })),
  'abc',
)
throws(
  'HTTP 200인데 본문 error → 던진다',
  () => extractWikitext(200, null, JSON.stringify({ error: { code: 'missingtitle', info: 'nope' } })),
  'missingtitle',
)
throws(
  'HTTP 200인데 본문 errors[] → 던진다',
  () => extractWikitext(200, null, JSON.stringify({ errors: [{ code: 'badvalue', text: 'nope' }] })),
  'badvalue',
)
throws('MediaWiki-API-Error 헤더 → 던진다', () => extractWikitext(200, 'ratelimited', '{}'), 'ratelimited')
throws('JSON이 아니면 던진다', () => extractWikitext(200, null, '<html>403</html>'), 'JSON이 아니다')
throws('parse가 없으면 던진다', () => extractWikitext(200, null, JSON.stringify({ batchcomplete: true })), 'parse가 없다')
throws(
  '빈 위키텍스트를 "정상 0건"으로 취급하지 않는다',
  () => extractWikitext(200, null, JSON.stringify({ parse: { wikitext: '   ' } })),
  '비어 있다',
)

// ═════════════════════════════════════════════════════════════════════════════
section('② 위키텍스트 표 파서 — 링크·템플릿·rowspan/colspan')

eq('링크 [[문서|표시]] → 표시', plain('[[Meta Platforms|Meta]]'), 'Meta')
eq('링크 [[문서]] → 문서', plain('[[Apple Inc.]]'), 'Apple Inc.')
eq('ref 태그 제거', plain('Alpha<ref name="a">출처</ref> Co'), 'Alpha Co')
eq('self-closing ref 제거', plain('Beta<ref name="b" />'), 'Beta')
eq('주석 제거', plain('Gam<!-- 편집 메모 -->ma'), 'Gamma')
eq('굵게·nbsp 정리', plain("'''Delta'''&nbsp;Inc"), 'Delta Inc')
eq('템플릿 마지막 인자', plain('{{sort|Alphabet|Alphabet Inc.}}'), 'Alphabet Inc.')

eq('날짜: ISO', parseWikiDate('1957-03-04'), '1957-03-04')
eq('날짜: March 4, 1957', parseWikiDate('March 4, 1957'), '1957-03-04')
eq('날짜: 4 March 1957', parseWikiDate('4 March 1957'), '1957-03-04')
eq('날짜: 각주·괄호 섞임', parseWikiDate('September 22, 2025<ref>x</ref> (effective)'), '2025-09-22')
eq('날짜: 연도만 → 보수적으로 연말(게이트가 걸리는 쪽)', parseWikiDate('1976'), '1976-12-31')
eq('날짜: 못 읽으면 null', parseWikiDate('unknown'), null)

eq('티커: 점 표기 BRK.B → BRK-B(야후)', normTicker('BRK.B'), 'BRK-B')
eq('티커: 링크 안에 있어도 뽑는다', normTicker('[[3M|MMM]]'), 'MMM')
eq('티커: 형식 위반은 null', normTicker('N/A'), null)
eq('티커: 6자리 숫자(국장 코드)는 미장 티커가 아니다', normTicker('005930'), null)

const SPAN_TABLE = `
! rowspan="2" | Date
! colspan="2" | Added
! colspan="2" | Removed
! rowspan="2" | Reason
|-
! Ticker !! Security !! Ticker !! Security
|-
| rowspan="2" | September 22, 2025 || AAA || Alpha Co || BBB || Beta Co || S&P 500 재구성
|-
| CCC || Gamma Co || DDD || Delta Co || 인수 완료
`
const spanGrid = expandSpans(parseTableRows(SPAN_TABLE))
eq('2단 헤더 → 열 이름 합성', headerOf(spanGrid).join('|'), 'Date|Added Ticker|Added Security|Removed Ticker|Removed Security|Reason')
const spanData = spanGrid.filter((r) => !r.isHeader)
eq('rowspan 행도 6칸으로 펼쳐진다', spanData[1].cells.length, 6)
eq('rowspan된 날짜가 다음 행에 복제된다(열 밀림 방지)', plain(spanData[1].cells[0]), 'September 22, 2025')
eq('열이 밀리지 않았다 — 2행 Added Ticker', plain(spanData[1].cells[1]), 'CCC')
eq('열이 밀리지 않았다 — 2행 Reason', plain(spanData[1].cells[5]), '인수 완료')

// ═════════════════════════════════════════════════════════════════════════════
section('③ 현재 구성종목 표 · 변경 이력표 파싱')

const CURRENT_TABLE = `
|+ S&P 500 component stocks
! Symbol !! Security !! GICS Sector !! GICS Sub-Industry !! Headquarters Location !! Date added !! CIK !! Founded
|-
| [[MMM]] || [[3M]] || Industrials || Conglomerates || Saint Paul, Minnesota || 1957-03-04 || 0000066740 || 1902
|-
| BRK.B || [[Berkshire Hathaway]] || Financials || Multi-Sector || Omaha, Nebraska || 2010-02-16 || 0001067983 || 1839
|-
| META || [[Meta Platforms]]<ref>x</ref> || Communication Services || Interactive Media || Menlo Park, California || December 23, 2013 || 0001326801 || 2004
`
const DECOY_TABLE = `
! Year !! Return
|-
| 2024 || 25.0%
`
const CHANGES_TABLE = SPAN_TABLE

const curParsed = parseCurrentTable(CURRENT_TABLE)
eq('현재 표 3종목', curParsed.length, 3)
eq('티커 정규화(BRK.B→BRK-B)', curParsed[1].ticker, 'BRK-B')
eq('회사명 링크 해제', curParsed[2].name, 'Meta Platforms')
eq('편입일 ISO', curParsed[0].addedOn, '1957-03-04')
eq('편입일 영문 날짜', curParsed[2].addedOn, '2013-12-23')
check('캡션(|+)을 셀로 오인하지 않는다', curParsed.every((m) => m.ticker !== null))

throws(
  "Date added 열이 없으면 던진다 — 게이트 ②를 못 돌리는 채로 진행하지 않는다",
  () => parseCurrentTable(`! Symbol !! Security\n|-\n| AAA || Alpha`),
  'Date added',
)
throws(
  'Symbol/Ticker 열이 없으면 던진다(기본값으로 때우지 않는다)',
  () => parseCurrentTable(`! Foo !! Bar !! Date added\n|-\n| a || b || 2020-01-01`),
  '필요한 열을 찾지 못했다',
)

const chgParsed = parseChangesTable(CHANGES_TABLE)
eq('변경 이력 2행', chgParsed.rows.length, 2)
eq('rowspan된 날짜가 2행에도 붙는다', chgParsed.rows[1].date, '2025-09-22')
eq('편입 티커', chgParsed.rows[1].added[0].ticker, 'CCC')
eq('제외 티커', chgParsed.rows[1].removed[0].ticker, 'DDD')

// 표 순서에 의존하지 않는다 — 파서가 통과하는 표를 고른다.
const blocks = extractTableBlocks(`{|\n${DECOY_TABLE}\n|}\n\n{|\n${CURRENT_TABLE}\n|}\n\n{|\n${CHANGES_TABLE}\n|}`)
eq('표 블록 3개 추출', blocks.length, 3)
eq('현재 표는 index 0이 아니라 1', pickTable(blocks, (b) => parseCurrentTable(b), '현재 표').index, 1)
eq('변경 표는 index 2', pickTable(blocks, (b) => parseChangesTable(b), '변경 표').index, 2)
throws(
  '어느 표도 안 맞으면 실제 헤더를 찍고 던진다',
  () => pickTable([DECOY_TABLE], (b) => parseCurrentTable(b), '현재 표'),
  '찾지 못했다',
)

// ═════════════════════════════════════════════════════════════════════════════
section('④ 되감기 — 편입 · 제외 · 티커변경 · 티커재사용 · 이력 구멍')

// 합성 지수(9종목). 실제 S&P 500 대신 작은 지수를 쓴다 — 밴드를 [7,11]로 좁혀 게이트 논리만 본다.
const CURRENT: CurrentMember[] = [
  { ticker: 'AAA', name: 'Alpha Co', addedOn: '2000-01-01' },
  { ticker: 'BBB', name: 'Beta Co', addedOn: '2010-01-27' },
  { ticker: 'META', name: 'Meta Platforms', addedOn: '2022-06-09' },
  { ticker: 'NEW', name: 'Newco', addedOn: '2024-06-01' },
  { ticker: 'SUNW', name: 'Sunworks', addedOn: '2023-03-01' },
  { ticker: 'DDD', name: 'Delta Co', addedOn: '1990-01-01' },
  // 🔴 이력 구멍: 2015-04-01에 편입됐는데 **변경 이력표에 그 행이 없다.**
  //    되감으면 2015년 이전 목록에 GAP이 남아 lateAdded가 잡힌다 = 누락의 직접 증거.
  { ticker: 'GAP', name: 'Gapco', addedOn: '2015-04-01' },
  { ticker: 'TTT', name: 'Tau Industries', addedOn: '2018-02-01' },
  { ticker: 'JJJ', name: 'Jay Corp', addedOn: '2011-09-01' },
]
const CHANGES: ChangeRow[] = [
  // 평범한 편입/제외
  { date: '2024-06-01', added: [{ ticker: 'NEW', name: 'Newco' }], removed: [{ ticker: 'OLD', name: 'Oldco' }] },
  { date: '2023-03-01', added: [{ ticker: 'SUNW', name: 'Sunworks' }], removed: [{ ticker: 'ZZZ', name: 'Zeta Co' }] },
  // 🔴 티커 **변경**(회사 생존): FB → META. 같은 날 add META / remove FB로 들어온다.
  { date: '2022-06-09', added: [{ ticker: 'META', name: 'Meta Platforms' }], removed: [{ ticker: 'FB', name: 'Facebook' }] },
  // 🔴 티커 **재사용**(미분류): TTT가 2011년엔 Tau Mining, 2018년엔 Tau Industries.
  { date: '2018-02-01', added: [{ ticker: 'TTT', name: 'Tau Industries' }], removed: [{ ticker: 'PPP', name: 'Pi Corp' }] },
  { date: '2011-09-01', added: [{ ticker: 'JJJ', name: 'Jay Corp' }], removed: [{ ticker: 'TTT', name: 'Tau Mining' }] },
  // 🔴 티커 **재사용**(기존 규약으로 이미 분류됨): SUNW = Sun Microsystems → Sunworks.
  { date: '2010-01-27', added: [{ ticker: 'BBB', name: 'Beta Co' }], removed: [{ ticker: 'SUNW', name: 'Sun Microsystems' }] },
]

const rw = rewind(CURRENT, CHANGES, '2026-08-03', 2008, 2027)
eq('아직 오지 않은 해는 만들지 않는다(미래 목록 금지)', rw.missingYears.join(','), '2027')
eq('2026 스냅샷 9종목', rw.years[2026].members.length, 9)

const at = (y: number) => rw.years[y].members.map((m) => m.ticker).join(',')
check('편입 되감기: 2024-06-01 편입된 NEW는 2024-01-01 목록에 없다', !at(2024).includes('NEW'))
check('제외 되감기: 같은 날 빠진 OLD는 2024-01-01 목록에 있다', at(2024).includes('OLD'))
check('티커변경: 2022-01-01 목록에는 FB가 있고 META는 없다', at(2022).includes('FB') && !at(2022).includes('META'))
check('티커변경: 2023-01-01 목록에는 META가 있고 FB는 없다', at(2023).includes('META') && !at(2023).includes('FB'))
check('티커재사용: 2009 목록의 SUNW는 Sun Microsystems', rw.years[2009].members.some((m) => m.ticker === 'SUNW' && m.name === 'Sun Microsystems'))
check('티커재사용: 2026 목록의 SUNW는 Sunworks', rw.years[2026].members.some((m) => m.ticker === 'SUNW' && m.name === 'Sunworks'))
eq('이력 구멍: 2015 목록에 늦은편입 1건(GAP)', rw.years[2015].lateAdded, 1)
eq('이력 구멍: 2016 목록에는 0건', rw.years[2016].lateAdded, 0)
eq('늦은편입 표본에 티커·편입일이 남는다', rw.years[2015].lateAddedSample[0], 'GAP(2015-04-01)')
check('되감기가 크기를 흔들지 않았다(전 연도 9종목)', Object.values(rw.years).every((r) => r.members.length === 9))
check(
  '되감기로 재편입된 종목은 편입일을 모른다(null) — 모르는 것을 지어내지 않는다',
  rw.years[2024].members.find((m) => m.ticker === 'OLD')?.addedOn === null,
)

// 인과성: 각 스냅샷은 **그 시점 이후의 변경을 반영하지 않는다.**
// 되감기 범위를 잘라 다시 돌려도 겹치는 해의 목록이 완전히 같아야 한다(절단 불변성).
const rwShort = rewind(CURRENT, CHANGES, '2026-08-03', 2012, 2026)
check(
  '절단 불변성: 범위를 잘라도 겹치는 해의 목록이 1비트도 다르지 않다',
  [2012, 2015, 2020, 2026].every((y) => JSON.stringify(rw.years[y]) === JSON.stringify(rwShort.years[y])),
)
// 미래 변경행을 하나 더 넣어도 **과거 스냅샷은 변하지 않아야** 한다(미래참조 금지).
const rwFuture = rewind(
  [...CURRENT, { ticker: 'FUT', name: 'Future Co', addedOn: '2026-07-01' }],
  [...CHANGES, { date: '2026-07-01', added: [{ ticker: 'FUT', name: 'Future Co' }], removed: [] }],
  '2026-08-03',
  2008,
  2026,
)
check(
  '미래참조 금지: 2026-07-01 편입 사건이 2015년 목록을 바꾸지 않는다',
  JSON.stringify(rw.years[2015].members) === JSON.stringify(rwFuture.years[2015].members),
)

// ═════════════════════════════════════════════════════════════════════════════
section('⑤ 신뢰구간 게이트 — reliableFrom은 데이터가 정한다')

const BAND: [number, number] = [7, 11]
const judged = judgeUsPitReliability(
  Object.fromEntries(Object.entries(rw.years).map(([k, v]) => [k, v as UsPitYearRecord])),
  BAND,
  0,
)
eq('reliableFrom = 2016 (2015년 늦은편입 1건에서 끊긴다)', judged.reliableFrom, 2016)
check('2015년 판정 실패', judged.verdicts['2015'].ok === false && judged.verdicts['2015'].lateAddedOk === false)
check('2016년 판정 통과', judged.verdicts['2016'].ok === true)

throws(
  '가장 최근 연도부터 깨지면 던진다(되감기 이전에 현재 목록 파싱이 틀린 것)',
  () => judgeUsPitReliability(Object.fromEntries(Object.entries(rw.years).map(([k, v]) => [k, v as UsPitYearRecord])), [100, 200], 0),
  '가장 최근 연도',
)

const uni = buildUsPitRealUniverse({
  index: 'sp500',
  asOf: '2026-08-03',
  years: rw.years,
  missingYears: rw.missingYears,
  changesFirstDate: '2010-01-27',
  changeRows: CHANGES.length,
  sizeBand: BAND,
  lateAddedMax: 0,
})
eq('빌드 결과 reliableFrom', uni.reliableFrom, 2016)
eq('시총 순위는 만들지 않는다', uni.rankSource, 'none')
check('라이선스(CC BY-SA)를 데이터에 남긴다', /CC BY-SA/.test(uni.license))
check('출처 문구에 "시총 상위 N이 아니다"가 들어 있다', /시총 상위 N이 아니다/.test(uni.basis))
eq('신뢰구간 연도 = 2016~2026', usRealYears(uni).join(','), '2016,2017,2018,2019,2020,2021,2022,2023,2024,2025,2026')
check('전체 연도는 2008부터 남아 있다(버리지 않고 경계만 기록)', usRealAllYears(uni)[0] === 2008)
check('출처 한 줄에 신뢰구간·게이트 수치가 들어 있다', /reliableFrom|신뢰|되감기 신뢰 판정/.test(usRealSourceNote(uni)))

throws('신뢰구간 밖 연도는 조용히 못 쓴다 — 던진다', () => usRealCodes(uni, 2012), '신뢰구간 밖')
eq('진단 목적이면 명시적으로만 꺼낼 수 있다', usRealCodes(uni, 2012, true).length, 9)
throws('구간 시작이 신뢰구간 밖이면 던진다', () => usRealSpan(uni, 2010, 2026), '신뢰구간')
eq('신뢰구간 안이면 구멍 없이 돌려준다', usRealSpan(uni, 2018, 2020).join(','), '2018,2019,2020')

// ═════════════════════════════════════════════════════════════════════════════
section('⑥ 티커 재사용 — 사명 충돌은 분류 전까지 조회 거부')

const conflicts = usRealNameConflicts(uni)
check('SUNW 사명 충돌 검출', (conflicts.SUNW ?? []).length === 2)
check('TTT 사명 충돌 검출', (conflicts.TTT ?? []).length === 2)
check('티커변경(FB→META)은 서로 다른 티커라 충돌이 아니다', !('FB' in conflicts) && !('META' in conflicts))
check('기존 규약 유지: SUNW는 이미 US_BLOCKED_TICKERS에 있다', US_BLOCKED_TICKERS.has('SUNW'))
eq('미분류 충돌 = TTT 뿐(SUNW는 분류돼 있다)', usRealUnclassifiedConflicts(uni).join(','), 'TTT')

const has = (s: string) => ['AAA', 'BBB', 'META', 'NEW', 'DDD', 'GAP', 'JJJ', 'OLD', 'ZZZ', 'PPP', 'TTT', 'SUNW', 'FB'].includes(s)
eq('미분류 재사용 티커는 조회 거부(정직한 매핑 실패)', resolveUsRealTicker(uni, 'TTT', has), undefined)
eq('차단 티커도 거부', resolveUsRealTicker(uni, 'SUNW', has), undefined)
eq('정상 티커는 그대로', resolveUsRealTicker(uni, 'AAA', has), 'AAA')
eq('개명 티커는 현재 티커로 폴백(FB→META)', resolveUsRealTicker(uni, 'FB', (s) => s === 'META'), 'META')

const union = usRealFetchUnion(uni)
check('조회 합집합에서 SUNW·TTT 제외', !union.includes('SUNW') && !union.includes('TTT'))
check('FB는 META로 접혀 중복되지 않는다', union.filter((t) => t === 'META').length === 1 && !union.includes('FB'))
eq('조회 합집합 10종목', union.length, 10)

const derived = deriveUsRealUniverse(uni)
eq('파생: 실행 연도', derived.years.length, 11)
check('파생 라벨에 "순위 없음"이 박혀 있다', /순위 없음/.test(derived.label))
eq('파생 codesFor는 그 해 구성종목', derived.codesFor(2026).length, 9)

// ═════════════════════════════════════════════════════════════════════════════
section('⑦ 스키마 파서 — 틀린 파일이 조용히 통과하지 않는다')

const good = JSON.parse(JSON.stringify(uni)) as Record<string, unknown>
const mutate = (f: (o: Record<string, unknown>) => void): Record<string, unknown> => {
  const o = JSON.parse(JSON.stringify(good)) as Record<string, unknown>
  f(o)
  return o
}

check('정상 파일은 통과', parseUsPitRealUniverse(good).reliableFrom === 2016)
throws('rankSource를 순위 있는 것처럼 바꾸면 거부', () => parseUsPitRealUniverse(mutate((o) => (o.rankSource = 'marketcap'))), 'rankSource')
throws('라이선스 삭제 거부', () => parseUsPitRealUniverse(mutate((o) => (o.license = ''))), 'license')
throws(
  '한 해 안의 중복 티커 거부',
  () =>
    parseUsPitRealUniverse(
      mutate((o) => {
        const y = (o.years as Record<string, { members: unknown[] }>)['2026']
        y.members.push(JSON.parse(JSON.stringify(y.members[0])))
      }),
    ),
  '중복 티커',
)
throws(
  '결측 연도를 숨기면 거부',
  () =>
    parseUsPitRealUniverse(
      mutate((o) => {
        delete (o.years as Record<string, unknown>)['2020']
        delete ((o.reliability as Record<string, unknown>).years as Record<string, unknown>)['2020']
      }),
    ),
  'missingYears에도 없다',
)
throws(
  'reliableFrom을 손으로 늘려 적으면 거부',
  () => parseUsPitRealUniverse(mutate((o) => (o.reliableFrom = 2010))),
  '신뢰구간을 늘려 적지 마라',
)
throws(
  'reliableFrom을 임의로 올려 통과한 해를 버려도 거부(경계는 게이트가 정한다)',
  () => parseUsPitRealUniverse(mutate((o) => (o.reliableFrom = 2018))),
  '경계는 게이트가 정한다',
)
throws(
  '판정표의 size를 위조하면 거부',
  () =>
    parseUsPitRealUniverse(
      mutate((o) => {
        ;((o.reliability as Record<string, unknown>).years as Record<string, { size: number }>)['2015'].size = 9999
      }),
    ),
  '실제 구성종목 수',
)
throws(
  '변경행 0건은 되감기가 아니다',
  () => parseUsPitRealUniverse(mutate((o) => ((o.reliability as Record<string, unknown>).changeRows = 0))),
  '변경행 0건',
)
throws(
  '국장 6자리 코드를 티커로 넣으면 거부',
  () =>
    parseUsPitRealUniverse(
      mutate((o) => {
        ;((o.years as Record<string, { members: { ticker: string }[] }>)['2026'].members[0].ticker = '005930')
      }),
    ),
  '미국 티커 형식',
)

// ═════════════════════════════════════════════════════════════════════════════
section('⑧ 로더 — [추정] 목록으로 조용히 내려가지 않는다')

const ok = { ok: true, status: 200, json: async () => good }
void (async () => {
  const loaded = await loadUsPitRealUniverse('/', async () => ok)
  eq('정상 로드', loaded.reliableFrom, 2016)

  await throwsAsync(
    'HTTP 404 → 폴백 없이 던진다',
    () => loadUsPitRealUniverse('/', async () => ({ ok: false, status: 404, json: async () => ({}) })),
    US_PIT_REAL_LOAD_FAIL.slice(0, 30),
  )
  await throwsAsync(
    '네트워크 오류 → 폴백 없이 던진다',
    () =>
      loadUsPitRealUniverse('/', async () => {
        throw new Error('boom')
      }),
    '네트워크 오류',
  )
  await throwsAsync(
    'JSON 파싱 실패 → 던진다',
    () =>
      loadUsPitRealUniverse('/', async () => ({
        ok: true,
        status: 200,
        json: async () => {
          throw new Error('bad json')
        },
      })),
    'JSON 파싱 실패',
  )
  await throwsAsync(
    '스키마 위반은 사유를 붙여 던진다',
    () => loadUsPitRealUniverse('/', async () => ({ ok: true, status: 200, json: async () => ({ years: {} }) })),
    '스키마 위반',
  )
  check('실패 안내가 "[추정] 목록으로 대신 돌리지 않는다"를 명시한다', /대신 돌리지 않습니다/.test(US_PIT_REAL_LOAD_FAIL))

  finish()
})()

// 타입만 쓰고 런타임에 안 쓰는 심볼 경고 방지
void (null as unknown as UsPitRealUniverse)
