// 단기매매 랩(36차) **시세 소스 전환** 집행자 — `scripts/shortterm-lab.entry.ts`.
//
// 2026-08-03 대표 지시("야후 아예 보지 말고, 시세 편향 없애줘")로 이 러너의 국내 유니버스
// 시세가 야후 → KRX 일별 정본으로 넘어갔다. 이 파일이 막는 사고는 네 가지다.
//
//   ① **야후 경로의 조용한 회귀.** 36차 수치를 재현하려면 `PRICE_SOURCE=yahoo`가
//      **한 자리도 다르지 않게** 돌아야 한다. 옛 로더는 `.KQ`/`.KS`를 둘 다 조회해
//      **긴 이력**을 채택하고 **200봉 미만은 제외**했다. 어댑터(`loadKrDual`)로 갈아끼우면서
//      그 규약이 미묘하게 달라지면 아무도 모른 채 표만 바뀐다 — 그래서 **가짜 fetch**로
//      호출 순서·채택·제외를 전부 고정한다(네트워크를 타지 않는다).
//   ② **키 규약 붕괴.** 어댑터는 야후 경로에서 **심볼 키**(`005930.KS`)를 돌려주는데
//      이 러너의 연쇄(`buildYearly`)와 유니버스는 **코드 키**로 돈다. 되돌리는 한 줄이
//      빠지면 매핑률이 통째로 0이 되어 "조용히 아무것도 안 도는" 실행이 된다.
//   ③ **거래량 스케일 오해.** KRX 경로는 수정계수를 **가격에만** 곱하고 거래량은 원값을
//      둔다. ④ 장대양봉(20일 평균 대비 3배)과 거래대금 정렬이 여기 직접 걸리므로,
//      "실제로 그렇게 나온다"를 **문서가 아니라 테스트로** 못박는다. 이 성질이 바뀌면
//      여기서 깨져야 한다(그때 출력 문구도 같이 고쳐야 한다는 신호다).
//   ④ **소스 표기 누락.** 어느 시세로 구운 표인지 머리말이 말하지 않으면 그 표는 거짓이
//      된다(규칙 3). 벤치가 계속 야후라 알파가 편향된다는 사실도 함께 찍혀야 한다.
//
// 규칙 1(미래참조)과의 관계: 이 파일은 **로더**만 본다. 신호·체결 규약의 절단 불변성은
// `tests/shortterm.test.ts`가 그대로 집행한다 — 로더 교체가 그 테스트를 건드리면 안 된다.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { check, eq, close as closeTo, section, finish } from './harness'
import {
  KRX_DAILY_START_HINT,
  LIMITUP_REGIME_DATE,
  limitUpCensus,
  limitUpCensusTable,
  loadShortHistories,
  preamble,
  priceSourceHeadline,
  shortPriceSourceFromEnv,
  splitCountFromLimits,
  volumeHandlingNote,
} from '../scripts/shortterm-lab.entry'
import { DEFAULT_PRICE_SOURCE } from '../src/features/backtest/priceSource'
import { KR_MIN_BARS } from '../src/lib/history'
import type { DailyBar } from '../src/features/backtest/types'

function capture(fn: () => void): string[] {
  const out: string[] = []
  const orig = console.log
  console.log = (...args: unknown[]) => {
    out.push(args.map(String).join(' '))
  }
  try {
    fn()
  } finally {
    console.log = orig
  }
  return out
}

/** 합성 일봉 n개. 값은 검증에만 쓰이므로 단조 증가로 둔다(결정적). */
function bars(n: number, base = 1000): DailyBar[] {
  const out: DailyBar[] = []
  for (let i = 0; i < n; i++) {
    const day = new Date(Date.UTC(2015, 0, 1) + i * 86400_000)
    const date = day.toISOString().slice(0, 10)
    const c = base + i
    out.push({ date, t: Math.floor(day.getTime() / 1000), o: c, h: c, l: c, c, v: 100 + i })
  }
  return out
}

const noWait = async () => {}

interface FakeYahoo {
  calls: string[]
  fetchDaily: (symbol: string) => Promise<DailyBar[]>
}

/** `table`에 없는(또는 'throw'인) 심볼은 404처럼 던진다 — 옛 로더의 try/catch 폴백 경로. */
function fakeYahoo(table: Record<string, DailyBar[] | 'throw'>): FakeYahoo {
  const calls: string[] = []
  return {
    calls,
    fetchDaily: async (symbol: string) => {
      calls.push(symbol)
      const v = table[symbol]
      if (v == null || v === 'throw') throw new Error(`HTTP 404 ${symbol}`)
      return v
    },
  }
}

// ===========================================================================
function testSourceSelection(): void {
  section('1) 시세 소스 선택 — 기본이 KRX여야 한다(대표 지시 2026-08-03)')

  eq('빈 환경변수 → krx (기본)', shortPriceSourceFromEnv({}), 'krx')
  eq('빈 문자열 → krx', shortPriceSourceFromEnv({ PRICE_SOURCE: '' }), 'krx')
  eq('공백만 → krx', shortPriceSourceFromEnv({ PRICE_SOURCE: '   ' }), 'krx')
  eq('yahoo → yahoo (36차 재현용)', shortPriceSourceFromEnv({ PRICE_SOURCE: 'yahoo' }), 'yahoo')
  eq('대문자·공백 YAHOO → yahoo', shortPriceSourceFromEnv({ PRICE_SOURCE: '  YAHOO ' }), 'yahoo')
  eq('KRX → krx', shortPriceSourceFromEnv({ PRICE_SOURCE: 'KRX' }), 'krx')
  eq('모르는 값은 기본값으로 좁힌다(조용한 오작동 방지)', shortPriceSourceFromEnv({ PRICE_SOURCE: 'naver' }), 'krx')
  eq('러너 기본값 = 어댑터 기본값(둘이 갈리면 화면과 수치가 갈린다)', shortPriceSourceFromEnv({}), DEFAULT_PRICE_SOURCE)
}

// ===========================================================================
function testHeadline(): void {
  section('2) 머리말 — 어느 시세로 구운 표인지 표가 스스로 말한다(규칙 3)')

  const headKrx = priceSourceHeadline('krx')
  eq(
    'KRX 머리말 문구가 지시서 규약과 정확히 같다',
    headKrx,
    `시세 소스: krx (KRX 일별 정본 · 가격수익 · 상폐 포함 · ${KRX_DAILY_START_HINT}~)`,
  )
  check('KRX 머리말에 가격수익 표기', headKrx.includes('가격수익'))
  check('KRX 머리말에 상폐 포함 표기', headKrx.includes('상폐 포함'))
  check('실제 시작일을 넘기면 그 값이 찍힌다', priceSourceHeadline('krx', '2011-02-03').includes('2011-02-03~'))
  const headYahoo = priceSourceHeadline('yahoo')
  check('야후 머리말은 총수익·생존편향을 밝힌다', headYahoo.includes('총수익') && headYahoo.includes('생존편향'))

  for (const src of ['krx', 'yahoo'] as const) {
    const out = capture(() => preamble(14, 'all', src)).join('\n')
    check(`preamble(${src})이 시세 소스 한 줄을 찍는다`, out.includes(`시세 소스: ${src}`))
    check(`preamble(${src})이 혼합 소스 경고(벤치=야후)를 함께 찍는다`, out.includes('벤치마크') && out.includes('Yahoo'))
    check(`preamble(${src})이 알파 편향을 병기한다`, out.includes('편향'))
  }
  check(
    'KRX 머리말은 36차(야후) 수치와 직접 비교하지 말라고 못박는다',
    capture(() => preamble(14, 'all', 'krx'))
      .join('\n')
      .includes('직접 비교하지 마라'),
  )
}

// ===========================================================================
async function testYahooRegression(): Promise<void> {
  section('3) 야후 경로 회귀 방지 — .KQ/.KS 듀얼 · 긴 이력 채택 · 200봉 게이트')

  {
    // (a) .KQ가 충분히 길면 .KS는 **조회하지 않는다** — 옛 로더의 `break`와 같다.
    const f = fakeYahoo({ '000100.KQ': bars(KR_MIN_BARS), '000100.KS': bars(9999) })
    const load = await loadShortHistories(['000100'], 'yahoo', { fetchDaily: f.fetchDaily, betweenAttempts: noWait })
    eq('.KQ가 200봉이면 .KS를 조회하지 않는다', f.calls.join(','), '000100.KQ')
    eq('히스토리 키는 **코드**다(심볼 아님)', Object.keys(load.histories).join(','), '000100')
    eq('채택 봉 수 = .KQ', load.histories['000100'].length, KR_MIN_BARS)
    eq('실패 없음', load.failed.length, 0)
    eq('메타 소스 표기', load.meta.source, 'yahoo')
    eq('메타 로드 수', load.meta.loaded, 1)
  }

  {
    // (b) .KQ가 짧으면 .KS까지 조회하고 **긴 쪽**을 채택한다.
    const f = fakeYahoo({ '000200.KQ': bars(150), '000200.KS': bars(500) })
    const load = await loadShortHistories(['000200'], 'yahoo', { fetchDaily: f.fetchDaily, betweenAttempts: noWait })
    eq('두 접미사를 .KQ → .KS 순서로 조회한다', f.calls.join(','), '000200.KQ,000200.KS')
    eq('긴 이력(.KS)을 채택한다', load.histories['000200'].length, 500)
    eq('실패 없음', load.failed.length, 0)
  }

  {
    // (c) 둘 다 200봉 미만이면 **제외**한다(가짜 응답 게이트). 긴 쪽이라도 채택하지 않는다.
    const f = fakeYahoo({ '000300.KQ': bars(150), '000300.KS': bars(199) })
    const load = await loadShortHistories(['000300'], 'yahoo', { fetchDaily: f.fetchDaily, betweenAttempts: noWait })
    eq('200봉 미만은 히스토리에 없다', Object.keys(load.histories).length, 0)
    eq('실패 목록에 코드가 남는다(숨기지 않는다)', load.failed.join(','), '000300')
    eq('메타에도 실패가 남는다', load.meta.failed.join(','), '000300')
  }

  {
    // (d) 경계값 — 정확히 200봉은 채택, 199봉은 제외(옛 로더의 `>= 200`).
    const f = fakeYahoo({ '000400.KQ': bars(KR_MIN_BARS) })
    const load = await loadShortHistories(['000400'], 'yahoo', { fetchDaily: f.fetchDaily, betweenAttempts: noWait })
    eq('정확히 200봉은 통과', load.histories['000400']?.length, KR_MIN_BARS)
    const g = fakeYahoo({ '000500.KQ': bars(KR_MIN_BARS - 1), '000500.KS': bars(KR_MIN_BARS - 1) })
    const load2 = await loadShortHistories(['000500'], 'yahoo', { fetchDaily: g.fetchDaily, betweenAttempts: noWait })
    eq('199봉은 제외', load2.failed.join(','), '000500')
  }

  {
    // (e) .KQ가 던지면 .KS로 폴백한다(옛 로더의 try/catch).
    const f = fakeYahoo({ '000600.KQ': 'throw', '000600.KS': bars(300) })
    const load = await loadShortHistories(['000600'], 'yahoo', { fetchDaily: f.fetchDaily, betweenAttempts: noWait })
    eq('.KQ 실패 후 .KS를 조회한다', f.calls.join(','), '000600.KQ,000600.KS')
    eq('.KS를 채택', load.histories['000600']?.length, 300)
  }

  {
    // (f) 둘 다 던지면 실패로 센다(조용히 빈 시계열을 만들지 않는다).
    const f = fakeYahoo({ '000700.KQ': 'throw', '000700.KS': 'throw' })
    const load = await loadShortHistories(['000700'], 'yahoo', { fetchDaily: f.fetchDaily, betweenAttempts: noWait })
    eq('전량 실패는 failed로', load.failed.join(','), '000700')
    eq('히스토리는 비어 있다', Object.keys(load.histories).length, 0)
  }

  {
    // (g) 봉 내용은 **손대지 않는다** — 로더 교체가 값을 바꾸면 안 된다.
    const src = bars(250, 5000)
    const f = fakeYahoo({ '000800.KQ': src })
    const load = await loadShortHistories(['000800'], 'yahoo', { fetchDaily: f.fetchDaily, betweenAttempts: noWait })
    check('봉 배열이 원본과 같다', JSON.stringify(load.histories['000800']) === JSON.stringify(src))
  }

  {
    // (h) 여러 코드 — 성공·실패가 섞여도 각각 제자리에 남는다(성공 카운터 규약).
    const f = fakeYahoo({
      '000900.KQ': bars(300),
      '001000.KQ': bars(10),
      '001000.KS': bars(10),
      '001100.KS': bars(400),
    })
    const load = await loadShortHistories(['000900', '001000', '001100'], 'yahoo', {
      fetchDaily: f.fetchDaily,
      betweenAttempts: noWait,
    })
    eq('성공 2건', Object.keys(load.histories).sort().join(','), '000900,001100')
    eq('실패 1건', load.failed.join(','), '001000')
    eq('요청 수', load.meta.requested, 3)
    eq('로드 수', load.meta.loaded, 2)
  }
}

// ===========================================================================
async function testKrxPath(): Promise<void> {
  section('4) KRX 경로 — 가격은 보정, **거래량은 원값**(④ 장대양봉·거래대금에 직결)')

  const fixtureRoot = mkdtempSync(join(tmpdir(), 'shortlab-krx-'))
  try {
    const dir = join(fixtureRoot, 'public', 'data', 'krx-daily')
    mkdirSync(join(dir, 'prices'), { recursive: true })
    const calendar = ['2010-01-04', '2010-01-05', '2010-01-06', '2010-01-07', '2010-01-08']
    writeFileSync(
      join(dir, 'index.json'),
      JSON.stringify({
        schema: 'krx-daily/index@1',
        version: 1,
        source: '테스트 픽스처(합성)',
        basis: '합성 · 원주가',
        asOf: '2026-08-03',
        from: calendar[0],
        to: calendar[calendar.length - 1],
        calendar,
        missingDays: [],
        volume: true,
        limits: ['테스트 픽스처 — 실데이터가 아니다'],
        stocks: [
          {
            code: '000100',
            name: '분할테스트',
            market: 'kospi',
            from: calendar[0],
            to: calendar[4],
            bars: 5,
            gaps: 0,
            trimmed: false,
            adjEvents: 1,
            file: 'prices/000100.json',
          },
        ],
      }),
      'utf8',
    )
    // 10:1 액면분할이 idx=2에 있다. 분할 전 종가 100 → 분할 후 10, 거래량은 1,000 → 50,000.
    writeFileSync(
      join(dir, 'prices', '000100.json'),
      JSON.stringify({
        schema: 'krx-daily/prices@1',
        code: '000100',
        name: '분할테스트',
        adjustment: 'raw',
        dividendAdjusted: false,
        market: 'kospi',
        markets: ['kospi'],
        rows: [
          [0, 100, 110, 90, 100, 1000],
          [1, 100, 110, 90, 100, 1000],
          [2, 10, 11, 9, 10, 50000],
          [3, 10, 11, 9, 10, 50000],
          [4, 10, 11, 9, 10, 50000],
        ],
        shares: [
          [0, 1000],
          [2, 10000],
        ],
        events: [
          {
            date: calendar[2],
            idx: 2,
            kind: 'split',
            sharesBefore: 1000,
            sharesAfter: 10000,
            ratio: 10,
            impliedRatio: 10,
            factor: 10,
            confidence: 'high',
            note: '테스트 10:1 분할',
          },
        ],
      }),
      'utf8',
    )

    const load = await loadShortHistories(['000100', '999999'], 'krx', { krxRoot: fixtureRoot })
    const b = load.histories['000100']
    eq('KRX도 **코드 키**로 돌려준다', Object.keys(load.histories).join(','), '000100')
    eq('봉 수', b.length, 5)
    eq('수집 범위 밖 코드는 실패로 센다', load.failed.join(','), '999999')
    eq('메타 소스 표기', load.meta.source, 'krx')
    eq('krxIndex를 함께 돌려준다(구간 경고용)', load.krxIndex?.from, '2010-01-04')

    closeTo('분할 이전 종가에 1/ratio가 곱해진다', b[0].c, 10)
    closeTo('분할 이전 고가도 같은 계수', b[0].h, 11)
    closeTo('분할일 종가는 그대로', b[2].c, 10)
    check('분할일 전후 가격이 연속이다(가짜 −90%가 생기지 않는다)', b[2].c === b[1].c)

    eq('⚠️ 거래량은 **원값 그대로**(계수가 곱해지지 않는다) — 분할 이전', b[0].v, 1000)
    eq('⚠️ 거래량은 **원값 그대로** — 분할 이후', b[2].v, 50000)
    check(
      '그래서 분할일에 거래량 스케일이 끊긴다(가격은 연속, 거래량은 50배)',
      b[2].c / b[1].c === 1 && b[2].v / b[1].v === 50,
    )
    check('원종가(rawClose)는 보존된다', b[0].rawClose === 100 && b[2].rawClose === 10)

    // 정본이 없는 루트를 주면 **던진다**(야후로 조용히 내려가지 않는다).
    let threw = ''
    try {
      await loadShortHistories(['000100'], 'krx', { krxRoot: join(fixtureRoot, 'nope') })
    } catch (e) {
      threw = String(e)
    }
    check('KRX 정본이 없으면 던진다(조용한 야후 폴백 없음)', threw.includes('KRX 일별 정본'), threw)
    check('야후로 대신 돌리지 않는다고 말한다', threw.includes('야후로 조용히'), threw)
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true })
  }
}

// ===========================================================================
function testLimitUpCensus(): void {
  section('5) 상한가 검출 집계 — 소스 전환의 실증 숫자')

  const mk = (date: string, prevClose: number, c: number, h: number): DailyBar => ({
    date,
    t: Math.floor(Date.parse(`${date}T00:00:00Z`) / 1000),
    o: prevClose,
    h,
    l: Math.min(prevClose, c),
    c,
    v: 1,
  })
  // 구제도(±15%) 구간에 상한가 1건, 신제도(±30%) 구간에 1건. 고가=종가(굳힘)만 인정한다.
  const series: DailyBar[] = [
    mk('2014-01-02', 1000, 1000, 1000),
    mk('2014-01-03', 1000, 1150, 1150), // +15.0% · 고가=종가 → 구제도 상한가
    mk('2014-01-06', 1150, 1150, 1150),
    mk('2014-01-07', 1150, 1330, 1400), // +15.7%지만 고가>종가 → 굳히지 못함
    mk('2016-01-04', 1330, 1330, 1330),
    mk('2016-01-05', 1330, 1730, 1730), // +30.1% · 고가=종가 → 신제도 상한가
    mk('2016-01-06', 1730, 1990, 1990), // +15.0% — 신제도에서는 상한가가 아니다
  ]
  const c = limitUpCensus({ A: series, B: bars(50) })
  eq('총 검출 2건', c.total, 2)
  eq('원주가가 없는 시계열이면 보정 영향은 [미검증](null)', c.adjFlipped, null)
  eq('구제도 1건', c.old, 1)
  eq('신제도 1건', c.neo, 1)
  eq('검출 종목 1개', c.symbols, 1)
  eq('판정 봉 = 각 종목 첫 봉 제외 합', c.bars, series.length - 1 + (50 - 1))
  eq('제도 경계 상수를 실제로 쓴다', LIMITUP_REGIME_DATE, '2015-06-15')

  const out = capture(() => limitUpCensusTable('krx', c)).join('\n')
  check('표에 소스가 찍힌다', out.includes('krx'))
  check('표에 전체 건수가 찍힌다', out.includes('| 2 |'))
  check('KRX는 배당락 오분류가 없다고 밝힌다', out.includes('오분류가 사라진다'))
  check('매매 건수가 아니라고 못박는다', out.includes('매매 건수가 아니다'))

  const outY = capture(() => limitUpCensusTable('yahoo', c)).join('\n')
  check('야후 표는 총수익 보정 오분류를 경고한다', outY.includes('총수익 보정') && outY.includes('오분류'))
  check('원주가가 없으면 보정 영향을 [미검증]으로 남긴다', outY.includes('[미검증]'))

  // 보정이 판정을 뒤집은 건수 — 원주가(rawClose)가 있으면 실제로 센다.
  // 분할 계수 때문에 보정 종가로는 +30% 상한가로 보이지만 원주가로는 아닌 하루를 만든다.
  const withRaw: DailyBar[] = [
    { date: '2016-03-02', t: 1, o: 1000, h: 1000, l: 1000, c: 1000, v: 1, rawClose: 1000 },
    // 보정 종가는 +30.1%(상한가로 잡힘), 원주가는 +1%(아님) → 보정이 판정을 만들어낸 봉
    { date: '2016-03-03', t: 2, o: 1000, h: 1302, l: 1000, c: 1302, v: 1, rawClose: 1010 },
    // 반대 방향 — 보정으로는 +1%, 원주가로는 +30.1% → 보정이 판정을 지운 봉
    { date: '2016-03-04', t: 3, o: 1302, h: 1315, l: 1302, c: 1315, v: 1, rawClose: 1315 },
  ]
  const cr = limitUpCensus({ A: withRaw })
  eq('보정 기준 검출 1건', cr.total, 1)
  eq('보정이 판정을 흔든 봉 2건(만든 1 + 지운 1)', cr.adjFlipped, 2)
  const outR = capture(() => limitUpCensusTable('krx', cr)).join('\n')
  check('흔든 건수를 표에 찍는다', outR.includes('흔든 건수: 2건'))

  // 빈 입력 — 정상 0건이지 실패가 아니다(둘을 뭉개지 않는다).
  const empty = limitUpCensus({})
  eq('빈 히스토리는 0건', empty.total, 0)
  eq('판정 봉도 0', empty.bars, 0)
  eq('구간은 빈 문자열', empty.from, '')
}

// ===========================================================================
function testVolumeNote(): void {
  section('6) 거래량 취급 문구 — 확인한 것과 [미검증]을 나눠 남긴다(규칙 4)')

  const outK = capture(() => volumeHandlingNote('krx', undefined, 7)).join('\n')
  check('KRX 절이 "가격에만 곱한다"를 명시', outK.includes('가격(OHLC)에만'))
  check('KRX 절이 "원값 그대로"를 명시', outK.includes('원값 그대로'))
  check('KRX 절이 ④ 장대양봉 거짓 급증 위험을 밝힌다', outK.includes('거짓 급증'))
  check('KRX 절이 반영된 분할 건수를 찍는다', outK.includes('7건'))
  check('측정하지 않은 부분을 [미검증]으로 남긴다', outK.includes('[미검증]'))

  const outNull = capture(() => volumeHandlingNote('krx', undefined, null)).join('\n')
  check('건수를 못 찾으면 0으로 메우지 않는다', outNull.includes('0건으로 메우지 않는다'))

  const outY = capture(() => volumeHandlingNote('yahoo')).join('\n')
  check('야후 거래량 보정 여부는 [미검증]으로 남긴다', outY.includes('[미검증]'))
  check('추측으로 메우지 않는다고 밝힌다', outY.includes('추측으로 메우지 않는다'))

  eq('한계 문구에서 분할 반영 건수를 뽑는다', splitCountFromLimits(['수정주가 반영 12건 · 미보정 3건']), 12)
  eq('0건도 0으로 읽는다(못 찾은 것과 구분)', splitCountFromLimits(['수정주가 반영 0건 · 미보정 0건']), 0)
  eq('문구가 없으면 null(0으로 메우지 않는다)', splitCountFromLimits(['배당 미반영']), null)
  eq('빈 목록도 null', splitCountFromLimits([]), null)
}

async function main(): Promise<void> {
  testSourceSelection()
  testHeadline()
  await testYahooRegression()
  await testKrxPath()
  testLimitUpCensus()
  testVolumeNote()
}

main().then(finish, (e) => {
  console.error(`테스트 실행 중 예외: ${e?.stack ?? e}`)
  process.exit(1)
})
