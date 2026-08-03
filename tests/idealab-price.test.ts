// 연구 러너(scripts/idea-lab.entry.ts)의 **시세 소스 전환**을 집행한다.
//
// 이 파일이 막는 사고는 다섯 가지다.
//
//   ① **야후 로딩 규약 회귀.** 어댑터를 끼우면서 .KQ/.KS 듀얼 로드(긴 이력 채택 · 200봉 게이트)가
//      한 자리라도 달라지면 유니버스가 통째로 줄어든다(2026-08-02에 실제로 매핑률 98%→71%로
//      무너졌다). `PRICE_SOURCE=yahoo`는 34·35·36차 재현용이므로 **바뀌면 안 된다.**
//   ② **조용한 폴백.** krx를 골랐는데 정본이 없으면 야후로 내려가지 않고 던져야 한다 —
//      총수익(야후)과 가격수익(KRX)이 한 표에 섞이면 알파가 거짓이 된다.
//   ③ **구간을 조용히 줄이는 것.** KRX 정본은 2010년부터다. PIT1010(2000~)을 krx로 돌리면
//      앞 10년이 빈다 — 경고 없이 짧게 도는 순간 옛 표와의 비교가 거짓이 된다.
//   ④ **전량 실패인데 종료코드 0.** 한 종목도 못 받으면 던져야 한다(규칙 4).
//   ⑤ **채점용 수익률 계열이 밀리는 것.** dates와 각 변형 returns의 길이가 어긋나면
//      PBO·DSR이 다른 시점을 비교하게 된다 — 길이 불일치는 던진다.
//
// 네트워크를 타지 않는다(전부 픽스처). 규칙 1(미래참조)은 tests/idealab.test.ts가 계속 집행한다 —
// 여기서 바뀌는 것은 **로더뿐**이고 신호 로직은 손대지 않았다.

import { check, eq, finish, section } from './harness'
import {
  KRX_DAILY_SCHEMA_INDEX,
  KRX_DAILY_SCHEMA_PRICES,
  buildKrxAdjEvents,
  krxDailyPriceFile,
  parseKrxDailyIndex,
  parseKrxDailyStock,
  type KrxDailyIndex,
  type KrxDailyRow,
  type KrxDailyStock,
} from '../src/features/backtest/krxDailyPrices'
import { KRX_DAILY_LIMITS } from '../src/features/backtest/krxDailyPrices'
import { MIXED_SOURCE_NOTE, type KrxPriceDeps } from '../src/features/backtest/priceSource'
import { KR_MIN_BARS } from '../src/lib/history'
import {
  RETURNS,
  RETURNS_SCHEMA,
  compareBasisFor,
  compareBasisNote,
  ideaPriceSource,
  krxYearGuard,
  loadKrHistories,
  priceSourceHeadline,
  rangeStart,
  summarizeStrat,
} from '../scripts/idea-lab.entry'
import type { DailyBar } from '../src/features/backtest/types'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const throwsAsync = async (fn: () => Promise<unknown>): Promise<string | null> => {
  try {
    await fn()
    return null
  } catch (e) {
    return (e as Error).message
  }
}

const throwsSync = (fn: () => unknown): string | null => {
  try {
    fn()
    return null
  } catch (e) {
    return (e as Error).message
  }
}

// ---------------------------------------------------------------- 야후 픽스처

/** 심볼 → 봉 수. 표에 없는 심볼은 조회 실패(상폐 티커의 404와 같은 자리). */
function yahooFake(table: Record<string, number>, start = '2010-01-04') {
  const calls: string[] = []
  const t0 = Date.parse(`${start}T00:00:00Z`)
  const fetchOne = async (symbol: string): Promise<DailyBar[]> => {
    calls.push(symbol)
    const n = table[symbol]
    if (n == null) throw new Error(`no data for ${symbol}`)
    return Array.from({ length: n }, (_, i) => ({
      date: new Date(t0 + i * 86400e3).toISOString().slice(0, 10),
      t: Math.floor((t0 + i * 86400e3) / 1000),
      o: 100,
      h: 101,
      l: 99,
      c: 100,
      v: 0,
    }))
  }
  return { calls, fetchOne }
}

const yahooOpts = (table: Record<string, number>, start?: string) => {
  const f = yahooFake(table, start)
  return {
    calls: f.calls,
    deps: { source: 'yahoo' as const, fetchOne: f.fetchOne, betweenAttempts: async () => {} },
  }
}

// ----------------------------------------------------------------- KRX 픽스처

function calendarOf(n: number, start = '2010-01-04'): string[] {
  const out: string[] = []
  const d = new Date(`${start}T00:00:00Z`)
  for (let i = 0; i < n; i++) {
    out.push(d.toISOString().slice(0, 10))
    d.setUTCDate(d.getUTCDate() + 1)
  }
  return out
}

/** 분할 없는 결정적 원주가 — 이 파일은 로더 배선을 보므로 수정주가 산술은 다루지 않는다. */
function makeRows(n: number): { rows: KrxDailyRow[]; shares: number[] } {
  const rows: KrxDailyRow[] = []
  const shares: number[] = []
  for (let i = 0; i < n; i++) {
    const c = 10_000 + i
    rows.push([i, c - 5, c + 8, c - 12, c])
    shares.push(1_000_000)
  }
  return { rows, shares }
}

function stockOf(code: string, rows: KrxDailyRow[], shares: number[], calendar: string[]): KrxDailyStock {
  const events = buildKrxAdjEvents(rows, shares, calendar)
  return parseKrxDailyStock(
    {
      schema: KRX_DAILY_SCHEMA_PRICES,
      code,
      name: `테스트${code}`,
      adjustment: 'raw',
      dividendAdjusted: false,
      market: 'kospi',
      markets: ['kospi'],
      rows,
      shares: [[rows[0][0], shares[0]]],
      events,
    },
    calendar.length,
  )
}

/** 종목 몇 개짜리 KRX 정본 픽스처(index.json + prices/*.json 짝). */
function makeKrxFixture(specs: { code: string; n: number }[], start = '2010-01-04') {
  const calendar = calendarOf(Math.max(...specs.map((s) => s.n)), start)
  const entries: KrxDailyIndex['stocks'] = []
  const stockRaw: Record<string, unknown> = {}
  for (const s of specs) {
    const { rows, shares } = makeRows(s.n)
    const st = stockOf(s.code, rows, shares, calendar)
    entries.push({
      code: s.code,
      name: `테스트${s.code}`,
      market: 'kospi',
      from: calendar[0],
      to: calendar[s.n - 1],
      bars: s.n,
      gaps: 0,
      trimmed: false,
      adjEvents: st.events.length,
      file: krxDailyPriceFile(s.code),
    })
    stockRaw[krxDailyPriceFile(s.code)] = {
      schema: KRX_DAILY_SCHEMA_PRICES,
      code: s.code,
      name: `테스트${s.code}`,
      adjustment: 'raw',
      dividendAdjusted: false,
      market: 'kospi',
      markets: ['kospi'],
      rows: st.rows,
      shares: st.shares,
      events: st.events,
    }
  }
  const indexRaw = {
    schema: KRX_DAILY_SCHEMA_INDEX,
    version: 1,
    source: 'KRX Open API (테스트 픽스처)',
    basis: '일별 전종목 단면 · 원주가',
    asOf: '2026-08-03',
    from: calendar[0],
    to: calendar[calendar.length - 1],
    calendar,
    missingDays: [],
    volume: false,
    limits: [...KRX_DAILY_LIMITS],
    stocks: entries,
  }
  parseKrxDailyIndex(indexRaw) // 픽스처 자체가 스키마를 지키는지 먼저 확인
  return { calendar, indexRaw, stockRaw }
}

function krxDepsOf(indexRaw: unknown | null, stockRaw: Record<string, unknown>): KrxPriceDeps {
  return {
    readIndex: async () => indexRaw,
    readStock: async (_code: string, file: string) => (file in stockRaw ? stockRaw[file] : null),
  }
}

// ============================================================================
async function main() {
  section('1) 야후 경로 회귀 — .KQ/.KS 듀얼 로드 규약이 한 자리도 바뀌지 않는다')

  {
    // .KQ가 이미 충분히 길면(≥200봉) .KS는 **조회하지 않는다** — 예전 fetchKrDual의 break와 같다.
    const y = yahooOpts({ '035720.KQ': 300, '035720.KS': 500 })
    const load = await loadKrHistories(['035720'], 'since:1999-01-01', y.deps)
    eq('.KQ가 200봉 이상이면 .KS를 조회하지 않는다', y.calls.join(','), '035720.KQ')
    eq('채택 봉 수 = .KQ 300봉(더 긴 .KS를 보지 않는다)', load.histories['035720']?.length, 300)
    eq('키는 6자리 코드다(야후 심볼이 아니다)', Object.keys(load.histories).join(','), '035720')
    eq('실패 없음', load.failed.length, 0)
    eq('메타 소스', load.meta.source, 'yahoo')
  }

  {
    // .KQ가 짧으면 .KS까지 보고 **긴 쪽**을 채택한다.
    const y = yahooOpts({ '005930.KQ': 100, '005930.KS': 400 })
    const load = await loadKrHistories(['005930'], 'since:1999-01-01', y.deps)
    eq('짧은 .KQ 뒤에 .KS까지 조회한다', y.calls.join(','), '005930.KQ,005930.KS')
    eq('긴 이력(.KS 400봉)을 채택한다', load.histories['005930']?.length, 400)
  }

  {
    // 앞 접미사가 던져도 다음 접미사를 시도한다.
    const y = yahooOpts({ '000660.KS': 250 })
    const load = await loadKrHistories(['000660'], 'since:1999-01-01', y.deps)
    eq('.KQ 실패 후 .KS 조회', y.calls.join(','), '000660.KQ,000660.KS')
    eq('.KS 250봉 채택', load.histories['000660']?.length, 250)
  }

  {
    // 200봉 미만은 **가짜 응답**으로 보고 제외한다(2026-08-02 사고 재발 방지).
    const y = yahooOpts({ '111111.KQ': 150, '111111.KS': KR_MIN_BARS - 1, '222222.KS': KR_MIN_BARS })
    const load = await loadKrHistories(['111111', '222222'], 'since:1999-01-01', y.deps)
    eq(`둘 다 ${KR_MIN_BARS}봉 미만이면 제외`, load.histories['111111'], undefined)
    eq('제외된 코드는 failed에 남는다', load.failed.join(','), '111111')
    eq(`정확히 ${KR_MIN_BARS}봉은 채택된다(경계)`, load.histories['222222']?.length, KR_MIN_BARS)
  }

  {
    // 규칙 4 — 전량 실패는 던진다(예전에는 종료코드 0으로 끝났다).
    const y = yahooOpts({})
    const msg = await throwsAsync(() => loadKrHistories(['111111', '222222'], 'since:1999-01-01', y.deps))
    check('한 종목도 못 받으면 던진다', msg != null && msg.includes('한 종목도 받지 못했다'), String(msg))
  }

  {
    // 야후 경로는 **구간을 자르지 않는다** — 받은 그대로 넘긴다(옛 회차 재현용).
    const y = yahooOpts({ '005930.KS': 400 }, '2005-01-03')
    const load = await loadKrHistories(['005930'], 'since:2008-01-01', y.deps)
    eq('야후 봉은 자르지 않는다', load.histories['005930']?.length, 400)
    eq('krxFrom은 야후에서 null', load.krxFrom, null)
  }

  section('2) KRX 경로 — 정본을 읽고, 없으면 던진다(조용한 폴백 없음)')

  const fx = makeKrxFixture([{ code: '005930', n: 300 }, { code: '035720', n: 300 }])

  {
    const y = yahooOpts({ '005930.KS': 999 })
    const load = await loadKrHistories(['005930', '035720', '999999'], 'since:1999-01-01', {
      source: 'krx',
      fetchOne: y.fetchOne,
      krx: krxDepsOf(fx.indexRaw, fx.stockRaw),
    })
    eq('KRX 경로에서 야후를 한 번도 부르지 않는다', y.calls.length, 0)
    eq('코드 키로 돌아온다', Object.keys(load.histories).sort().join(','), '005930,035720')
    eq('수집 범위 밖 코드는 failed', load.failed.join(','), '999999')
    eq('메타 소스', load.meta.source, 'krx')
    eq('krxFrom = 정본 시작일', load.krxFrom, fx.calendar[0])
    eq('봉 수', load.histories['005930']?.length, 300)
  }

  {
    // 정본이 없으면 **야후로 내려가지 않고 던진다.**
    const y = yahooOpts({ '005930.KS': 400 })
    const msg = await throwsAsync(() =>
      loadKrHistories(['005930'], 'since:1999-01-01', {
        source: 'krx',
        fetchOne: y.fetchOne,
        krx: krxDepsOf(null, {}),
      }),
    )
    check('index.json이 없으면 던진다', msg != null && msg.includes('KRX 일별 정본'), String(msg))
    eq('던지는 동안에도 야후를 부르지 않는다', y.calls.length, 0)
  }

  {
    // KRX 파일은 전 구간을 담고 있다 — 야후와 같은 창이 되게 `since:`로 자른다.
    const cut = fx.calendar[100]
    const load = await loadKrHistories(['005930'], `since:${cut}`, {
      source: 'krx',
      krx: krxDepsOf(fx.indexRaw, fx.stockRaw),
    })
    eq('요청 구간 이전 봉이 잘린다', load.histories['005930']?.[0]?.date, cut)
    eq('남은 봉 수', load.histories['005930']?.length, 200)
  }

  section('3) 구간 경고 — KRX 정본(2010~)으로 PIT1010(2000~)을 돌릴 때')

  {
    const years = Array.from({ length: 27 }, (_, i) => 2000 + i)
    const kept = krxYearGuard(years, { source: 'krx', krxFrom: '2010-01-04' })
    eq('실행 구간 시작이 2010으로 밀린다', kept[0], 2010)
    eq('끝은 그대로', kept[kept.length - 1], 2026)
    eq('빈 해가 제거된다', kept.length, 17)
    const same = krxYearGuard(years, { source: 'yahoo', krxFrom: null })
    eq('야후 경로는 구간을 건드리지 않는다(옛 회차 재현)', same.length, years.length)
    const msg = throwsSync(() => krxYearGuard([2005, 2006], { source: 'krx', krxFrom: '2010-01-04' }))
    check('남는 해가 하나도 없으면 던진다', msg != null && msg.includes('실행할 해가 하나도 없다'), String(msg))
  }

  section('4) 머리말 — 어떤 소스로 구운 숫자인지 표에서 즉시 보인다')

  {
    const krx = priceSourceHeadline('krx', '2010-01-04~2026-07-31')
    check('krx 머리말에 소스·구간이 있다', krx.startsWith('시세 소스: krx') && krx.includes('2010-01-04~2026-07-31'), krx)
    check('krx 머리말에 가격수익 표기', krx.includes('가격수익'), krx)
    const yh = priceSourceHeadline('yahoo')
    check('yahoo 머리말에 총수익 표기', yh.startsWith('시세 소스: yahoo') && yh.includes('총수익'), yh)
    check('혼합 소스 경고가 벤치·참고선을 지목한다', MIXED_SOURCE_NOTE.includes('Yahoo') && MIXED_SOURCE_NOTE.includes('KODEX 200'), MIXED_SOURCE_NOTE)
    // 40차에서 배당 비대칭을 제거했다. 문구가 옛것으로 남으면 **없는 편향을 있다고** 말하게 되고
    // 읽는 사람이 알파를 약 2%p 깎아서 읽는다 — 규칙 3은 없는 편향을 적으라는 것이 아니다.
    check('편향이 제거됐음을 말한다', MIXED_SOURCE_NOTE.includes('편향은 없습니다'), MIXED_SOURCE_NOTE)
    check('깎아 읽지 말라고 못 박는다', MIXED_SOURCE_NOTE.includes('깎아 읽지 마'), MIXED_SOURCE_NOTE)
    check('남은 혼재(슬리브)를 지목한다', MIXED_SOURCE_NOTE.includes('슬리브'), MIXED_SOURCE_NOTE)
    eq('기본 소스는 krx', ideaPriceSource({}), 'krx')
    eq('PRICE_SOURCE=yahoo로 옛 회차 재현', ideaPriceSource({ PRICE_SOURCE: 'yahoo' }), 'yahoo')
    eq('모르는 값은 기본값으로 좁힌다', ideaPriceSource({ PRICE_SOURCE: 'naver' }), 'krx')
    eq('range 파싱', rangeStart('since:2008-01-01'), '2008-01-01')
    eq('range가 since 형식이 아니면 null', rangeStart('10y'), null)
  }

  // ⑥ **배당 비대칭.** 전략이 KRX 원주가(가격수익)인데 벤치·벽만 야후 adjclose(총수익)면
  //    KODEX 200 배당수익률만큼 알파가 전략에 불리하게 찍힌다. 2026-08-03 이전 전 회차가
  //    그 상태였다. 소스에 따라 비교 기준이 자동으로 맞춰지는지 못박는다.
  section('6) 비교 기준 — 전략과 벤치·벽의 배당 반영 여부를 일치시킨다')

  {
    eq('krx 소스면 벤치·벽도 가격수익', compareBasisFor('krx'), 'price')
    eq('yahoo 소스면 둘 다 총수익', compareBasisFor('yahoo'), 'total')
    const p = compareBasisNote('price')
    check('가격수익 문구가 "같은 기준"을 말한다', p.includes('가격수익') && p.includes('같은 기준'), p)
    check('편향이 제거됐음을 명시', p.includes('편향'), p)
    const t = compareBasisNote('total')
    check('총수익 문구는 기준이 같음을 말한다', t.includes('총수익') && t.includes('기준이 같다'), t)
  }

  section('5) 변형별 일간 수익률 계열 — 과최적화 소급 채점 입력')

  {
    const curve = (pts: [string, number][]) => pts.map(([date, equity]) => ({ date, equity }))
    const chain = (pts: [string, number][]) => ({ equity: curve(pts), perYear: [], closed: 0, wins: 0 })
    const bench = curve([['2010-01-04', 100], ['2010-01-05', 100], ['2010-01-06', 100]])

    RETURNS.begin('unit', 'krx')
    // summarizeStrat 한 곳에 수집이 걸려 있다 — 모드가 등록을 빠뜨릴 수 없다.
    summarizeStrat('A', chain([['2010-01-04', 100], ['2010-01-05', 110], ['2010-01-06', 99]]), bench)
    // 달력이 다른 변형(하루 늦게 시작) — 공통 달력에 정렬되고 빈 날은 0으로 채워진다.
    summarizeStrat('B', chain([['2010-01-05', 200], ['2010-01-07', 100]]), bench)
    summarizeStrat('[참고] KODEX 200 단독', chain([['2010-01-04', 100], ['2010-01-05', 120]]), bench)
    summarizeStrat('A', chain([['2010-01-04', 100], ['2010-01-05', 110], ['2010-01-06', 99]]), bench)

    const payload = RETURNS.build()
    check('payload가 만들어진다', payload != null, 'null')
    if (!payload) return
    eq('스키마 버전', payload.schema, RETURNS_SCHEMA)
    eq('모드', payload.mode, 'unit')
    eq('시세 소스가 파일에 박힌다', payload.priceSource, 'krx')
    eq('참고선은 변형이 아니다', payload.variants.some((v) => v.label.startsWith('[참고]')), false)
    eq('같은 라벨·같은 계열 중복은 접힌다', payload.variants.length, 2)
    eq('공통 달력 = 두 변형의 합집합', payload.dates.join(','), '2010-01-04,2010-01-05,2010-01-06,2010-01-07')
    eq('asOf = 마지막 관측일', payload.asOf, '2010-01-07')
    for (const v of payload.variants)
      eq(`${v.label}: dates와 returns 길이가 같다`, v.returns.length, payload.dates.length)
    const a = payload.variants.find((v) => v.label === 'A')
    check('A 첫 시점 수익률은 0(직전 값이 없다)', a?.returns[0] === 0, String(a?.returns[0]))
    check('A 1일차 +10%', Math.abs((a?.returns[1] ?? 0) - 0.1) < 1e-12, String(a?.returns[1]))
    check('A 2일차 −10%', Math.abs((a?.returns[2] ?? 0) - (99 / 110 - 1)) < 1e-12, String(a?.returns[2]))
    eq('A는 마지막 날 관측이 없어 0(미보유)', a?.returns[3], 0)
    const b = payload.variants.find((v) => v.label === 'B')
    eq('B는 시작 전 시점이 0', b?.returns[0], 0)
    check('B는 관측이 없는 날을 건너뛰어 복리를 잇는다', Math.abs((b?.returns[3] ?? 0) - (100 / 200 - 1)) < 1e-12, String(b?.returns[3]))
    eq('overfit-lab이 읽는 name 필드가 채워진다', b?.name, 'B')

    // 파일로 남긴다 — overfit-lab이 그대로 먹는 모양인지 확인한다.
    const dir = mkdtempSync(join(tmpdir(), 'idea-returns-'))
    try {
      const path = RETURNS.write(dir)
      check('artifacts/returns 아래에 쓴다', path != null && path.includes(join('artifacts', 'returns')), String(path))
      const round = JSON.parse(readFileSync(path as string, 'utf8')) as typeof payload
      eq('파일의 변형 수', round.variants.length, payload.variants.length)
      eq('파일의 시점 수', round.dates.length, payload.dates.length)
      for (const v of round.variants)
        eq(`파일 ${v.label}: 길이 일치`, v.returns.length, round.dates.length)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  finish()
}

void main()
