// 시세 소스 어댑터(src/features/backtest/priceSource.ts) — 라우팅·에러 경로·정직성 메타.
//
// 이 파일이 막는 사고는 네 가지다.
//
//   ① **조용한 폴백.** `'krx'`를 골랐는데 데이터가 없을 때 야후로 슬쩍 내려가면, 총수익(야후
//      adjclose)과 가격수익(KRX 원주가 보정)이 같은 표에 섞인 채 알파가 계산된다. 그건 거짓이다.
//      "던진다"를 테스트로 못 박는다 — 다음 세션이 "폴백이 편하다"며 되돌리지 못하게.
//   ② **에러 뭉개기.** "파일이 아직 없다"(수집 중)와 "파일이 깨졌다"(스키마 위반)는 다음 행동이
//      다르다. 두 경로가 같은 문구로 나오면 원인을 못 찾는다.
//   ③ **수정주가가 수익률을 바꾸는 것.** 어댑터를 태운 뒤에도 이벤트일을 뺀 모든 날의 일별
//      수익률이 원주가와 같아야 한다. 달라지면 과거 성적이 수집 시점마다 달라진다
//      (= 절단 불변성(규칙 1) 위반의 데이터 판).
//   ④ **야후 경로 회귀.** 어댑터를 끼우면서 .KQ/.KS 듀얼 로드 규약(긴 이력 채택 · 200봉 게이트)이
//      틀어지면 유니버스가 통째로 줄어든다(2026-08-02에 실제로 매핑률 98%→71%로 무너졌다).
//
// 네트워크를 타지 않는다 — 전부 픽스처. (KRX는 국내 IP 전용이라 컨테이너에서 어차피 막힌다.)

import { check, close as closeTo, eq, finish, rng, section } from './harness'
import {
  DEFAULT_PRICE_SOURCE,
  KRX_DAILY_ASSET_DIR,
  MIXED_SOURCE_NOTE,
  PRICE_SOURCES,
  PRICE_SOURCE_LABEL,
  krxFetchDeps,
  lastDateOf,
  loadKrPrices,
  normalizePriceSource,
  probeKrxDaily,
  type KrxPriceDeps,
  type PriceSourceDeps,
} from '../src/features/backtest/priceSource'
import {
  KRX_DAILY_LIMITS,
  KRX_DAILY_SCHEMA_INDEX,
  KRX_DAILY_SCHEMA_PRICES,
  buildKrxAdjEvents,
  krxDailyPriceFile,
  krxDailyRawBars,
  parseKrxDailyIndex,
  parseKrxDailyStock,
  type KrxDailyIndex,
  type KrxDailyRow,
  type KrxDailyStock,
} from '../src/features/backtest/krxDailyPrices'
import { KR_MIN_BARS, YAHOO_DAILY_LIMITS } from '../src/lib/history'
import { priceSourceFromEnv } from '../scripts/preset-precompute.entry'
import type { DailyBar } from '../src/features/backtest/types'

const throwsAsync = async (fn: () => Promise<unknown>): Promise<string | null> => {
  try {
    await fn()
    return null
  } catch (e) {
    return (e as Error).message
  }
}

// ---------------------------------------------------------------- 픽스처 헬퍼

function calendarOf(n: number, start = '2020-01-02'): string[] {
  const out: string[] = []
  const d = new Date(`${start}T00:00:00Z`)
  for (let i = 0; i < n; i++) {
    out.push(d.toISOString().slice(0, 10))
    d.setUTCDate(d.getUTCDate() + 1)
  }
  return out
}

/** 결정적 난수 원주가 + (선택) 액면분할 — 가격 1/ratio · 주식수 ×ratio. */
function makeSeries(n: number, opts: { splitAt?: number; ratio?: number; seed?: number } = {}) {
  const r = rng(opts.seed ?? 11)
  const rows: KrxDailyRow[] = []
  const shares: number[] = []
  let px = 60_000
  let sh = 2_000_000
  for (let i = 0; i < n; i++) {
    if (opts.splitAt != null && i === opts.splitAt) {
      const k = opts.ratio ?? 10
      px = px / k
      sh = sh * k
    }
    px = px * (1 + (r() - 0.5) * 0.05)
    const c = Math.round(px * 100) / 100
    const o = Math.round(c * (1 + (r() - 0.5) * 0.02) * 100) / 100
    const h = Math.round(Math.max(o, c) * (1 + r() * 0.01) * 100) / 100
    const l = Math.round(Math.min(o, c) * (1 - r() * 0.01) * 100) / 100
    rows.push([i, o, h, l, c])
    shares.push(sh)
  }
  return { rows, shares }
}

function stockOf(code: string, rows: KrxDailyRow[], shares: number[], calendar: string[]): KrxDailyStock {
  const events = buildKrxAdjEvents(rows, shares, calendar)
  const pts: [number, number][] = [[rows[0][0], shares[0]]]
  for (let i = 1; i < rows.length; i++) if (shares[i] !== shares[i - 1]) pts.push([rows[i][0], shares[i]])
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
      shares: pts,
      events,
    },
    calendar.length,
  )
}

function entryOf(code: string, rows: KrxDailyRow[], calendar: string[], adjEvents: number) {
  return {
    code,
    name: `테스트${code}`,
    market: 'kospi' as const,
    from: calendar[rows[0][0]],
    to: calendar[rows[rows.length - 1][0]],
    bars: rows.length,
    gaps: rows[rows.length - 1][0] - rows[0][0] + 1 - rows.length,
    trimmed: false,
    adjEvents,
    file: krxDailyPriceFile(code),
  }
}

/** 종목 몇 개짜리 KRX 정본 픽스처 — index.json + prices/*.json 짝을 함께 만든다. */
function makeKrxFixture(specs: { code: string; n: number; splitAt?: number; ratio?: number; seed?: number }[]) {
  const maxN = Math.max(...specs.map((s) => s.n))
  const calendar = calendarOf(maxN)
  const stocks: Record<string, KrxDailyStock> = {}
  const entries: KrxDailyIndex['stocks'] = []
  for (const s of specs) {
    const { rows, shares } = makeSeries(s.n, { splitAt: s.splitAt, ratio: s.ratio, seed: s.seed })
    const st = stockOf(s.code, rows, shares, calendar)
    stocks[s.code] = st
    entries.push(entryOf(s.code, rows, calendar, st.events.length))
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
  const index = parseKrxDailyIndex(indexRaw)
  const stockRaw: Record<string, unknown> = {}
  for (const s of specs)
    stockRaw[krxDailyPriceFile(s.code)] = {
      schema: KRX_DAILY_SCHEMA_PRICES,
      code: s.code,
      name: `테스트${s.code}`,
      adjustment: 'raw',
      dividendAdjusted: false,
      market: 'kospi',
      markets: ['kospi'],
      rows: stocks[s.code].rows,
      shares: stocks[s.code].shares,
      events: stocks[s.code].events,
    }
  return { calendar, index, indexRaw, stocks, stockRaw }
}

/** 픽스처를 읽어주는 KRX deps + 호출 기록. */
function krxDepsOf(
  indexRaw: unknown | null,
  stockRaw: Record<string, unknown>,
  opts: { indexThrows?: string } = {},
): KrxPriceDeps & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    readIndex: async () => {
      calls.push('index')
      if (opts.indexThrows) throw new Error(opts.indexThrows)
      return indexRaw
    },
    readStock: async (_code: string, file: string) => {
      calls.push(file)
      return file in stockRaw ? stockRaw[file] : null
    },
  }
}

/** 야후 픽스처 — 심볼마다 봉 수를 정해 준다(표에 없으면 조회 실패). */
function yahooDepsOf(table: Record<string, number>, opts: { concurrency?: number } = {}) {
  const calls: string[] = []
  const fetchDaily = async (symbol: string): Promise<DailyBar[]> => {
    calls.push(symbol)
    const n = table[symbol]
    if (n == null) throw new Error(`no data for ${symbol}`)
    const t0 = Date.parse('2010-01-04T00:00:00Z')
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
  return { calls, deps: { fetchDaily, concurrency: opts.concurrency } }
}

// ============================================================================
function testKinds(): void {
  section('① 소스 종류 · 정규화 — 임의 값이 새어 들어와도 야후로 좁힌다')

  eq('소스는 두 가지뿐', PRICE_SOURCES.join(','), 'yahoo,krx')
  // ⚠️ 기본값은 **야후**다. 데이터 도착 전에 기본을 바꾸면 화면이 통째로 실행 불가가 된다.
  eq('기본값은 KRX 정본(2026-08-03 전환 — 생존편향 제거)', DEFAULT_PRICE_SOURCE, 'krx')
  eq('krx는 그대로', normalizePriceSource('krx'), 'krx')
  eq('모르는 값은 기본값으로', normalizePriceSource('naver'), 'krx')
  eq('undefined도 기본값으로', normalizePriceSource(undefined), 'krx')
  check(
    '라벨이 총수익/가격수익을 구분한다',
    PRICE_SOURCE_LABEL.yahoo.includes('총수익') && PRICE_SOURCE_LABEL.krx.includes('가격수익'),
  )
  check('벤치·참고선이 야후로 남는다는 안내가 있다', MIXED_SOURCE_NOTE.includes('Yahoo'))
}

// ============================================================================
async function testRouting(): Promise<void> {
  section('② 라우팅 — 고른 소스의 의존성만 쓴다(다른 쪽은 건드리지 않는다)')

  const fx = makeKrxFixture([{ code: '005930', n: 300 }])
  const krx = krxDepsOf(fx.indexRaw, fx.stockRaw)
  const y = yahooDepsOf({ '005930.KS': 400 })
  const deps: PriceSourceDeps = { yahoo: y.deps, krx }

  const viaYahoo = await loadKrPrices(['005930'], 'yahoo', deps)
  eq('야후를 고르면 KRX 파일을 읽지 않는다', krx.calls.length, 0)
  eq('야후 심볼이 채택된다', viaYahoo.symOf['005930'], '005930.KS')
  eq('야후 메타', viaYahoo.meta.source, 'yahoo')

  const yCallsBefore = y.calls.length
  const viaKrx = await loadKrPrices(['005930'], 'krx', deps)
  eq('KRX를 고르면 야후를 부르지 않는다', y.calls.length, yCallsBefore)
  eq('KRX는 6자리 코드가 곧 심볼', viaKrx.symOf['005930'], '005930')
  eq('KRX 메타', viaKrx.meta.source, 'krx')
  eq('index를 함께 돌려준다', viaKrx.krxIndex?.calendar.length, fx.calendar.length)
  eq('봉 수', viaKrx.histories['005930'].length, 300)
  eq('요청/성공 집계', `${viaKrx.meta.requested}/${viaKrx.meta.loaded}`, '1/1')
  eq('asOf는 실제 마지막 거래일', viaKrx.meta.asOf, fx.calendar[299])
}

// ============================================================================
async function testNoFallback(): Promise<void> {
  section('③ 조용한 폴백 금지 — 데이터가 없으면 던진다')

  {
    const y = yahooDepsOf({ '005930.KS': 400 })
    const krx = krxDepsOf(null, {}) // 파일 없음 = 수집 전
    const msg = await throwsAsync(() => loadKrPrices(['005930'], 'krx', { yahoo: y.deps, krx }))
    check('던진다', msg != null)
    check('사유에 EC2 수집 미완료가 명시된다', (msg ?? '').includes('EC2 krxdaily 수집이 아직 안 끝났습니다'))
    eq('야후로 내려가지 않았다(fetch 0회)', y.calls.length, 0)

    // 파일이 **깨진** 것과 **없는** 것은 다음 행동이 다르다 — 문구가 갈려야 한다.
    const broken = krxDepsOf({ schema: 'krx-daily/index@0', version: 1 }, {})
    const msg2 = await throwsAsync(() => loadKrPrices(['005930'], 'krx', { yahoo: y.deps, krx: broken }))
    check('스키마 위반은 스키마 사유로 던진다', (msg2 ?? '').includes('스키마 위반'))
    check('스키마 위반을 "수집 전"으로 뭉개지 않는다', !(msg2 ?? '').includes('EC2 krxdaily 수집이 아직'))

    // 읽기 자체가 터진 경우(HTTP 500 등)도 폴백하지 않는다.
    const boom = krxDepsOf(null, {}, { indexThrows: 'HTTP 500' })
    const msg3 = await throwsAsync(() => loadKrPrices(['005930'], 'krx', { yahoo: y.deps, krx: boom }))
    check('읽기 실패 사유가 메시지에 남는다', (msg3 ?? '').includes('HTTP 500'))
    eq('세 경로 어디서도 야후를 부르지 않았다', y.calls.length, 0)
  }

  {
    // index에는 있는데 종목 파일이 없다 = 수집이 중간에 끊겼다 → 유니버스가 조용히 줄지 않게 던진다.
    const fx = makeKrxFixture([{ code: '005930', n: 250 }])
    const partial = krxDepsOf(fx.indexRaw, {}) // prices/*.json 하나도 없음
    const msg = await throwsAsync(() => loadKrPrices(['005930'], 'krx', { krx: partial }))
    check('중간에 끊긴 수집은 던진다', (msg ?? '').includes('수집이 중간에 끊긴'))
  }

  {
    // 수집 범위 밖 코드는 **실패로 세어** 돌려준다(조용히 빼면 매핑률이 부풀려진다).
    const fx = makeKrxFixture([{ code: '005930', n: 250 }])
    const krx = krxDepsOf(fx.indexRaw, fx.stockRaw)
    const res = await loadKrPrices(['005930', '999999'], 'krx', { krx })
    eq('실패 코드가 남는다', res.failed.join(','), '999999')
    eq('성공은 1종목', res.meta.loaded, 1)
    eq('요청은 2종목', res.meta.requested, 2)
  }

  {
    // 의존성 주입 자체를 빠뜨린 경우 — 조용히 빈 결과를 내지 않는다.
    const msg = await throwsAsync(() => loadKrPrices(['005930'], 'krx', {}))
    check('KRX deps 누락은 던진다', (msg ?? '').includes('주입되지 않았습니다'))
    const msg2 = await throwsAsync(() => loadKrPrices(['005930'], 'yahoo', {}))
    check('야후 deps 누락도 던진다', (msg2 ?? '').includes('주입되지 않았습니다'))
  }
}

// ============================================================================
async function testAdjustment(): Promise<void> {
  section('④ 수정주가 — 이벤트일을 뺀 모든 날의 일별 수익률이 원주가와 같다')

  {
    // 10:1 액면분할이 120번째 봉에 있는 300봉 시계열.
    const SPLIT_AT = 120
    const fx = makeKrxFixture([{ code: '005930', n: 300, splitAt: SPLIT_AT, ratio: 10, seed: 3 }])
    const krx = krxDepsOf(fx.indexRaw, fx.stockRaw)
    const res = await loadKrPrices(['005930'], 'krx', { krx })
    const adj = res.histories['005930']
    const raw = krxDailyRawBars(fx.index, fx.stocks['005930'])
    eq('봉 수는 같다', adj.length, raw.length)

    let same = 0
    const diff: string[] = []
    for (let i = 1; i < adj.length; i++) {
      if (i === SPLIT_AT) continue // 이벤트일은 원주가 쪽이 계단으로 끊긴다(그게 보정하는 이유)
      const ra = adj[i].c / adj[i - 1].c
      const rr = raw[i].c / raw[i - 1].c
      if (Math.abs(ra - rr) <= 1e-9) same++
      else diff.push(`${adj[i].date}: ${ra} vs ${rr}`)
    }
    eq('보정 전후 일별 수익률이 전부 동일', diff.length, 0)
    check('검사한 날이 충분히 많다', same >= 290, `same=${same}`)

    // 분할일에는 **원주가 쪽이** 계단을 만들고, 보정본은 그 계단이 사라져야 한다.
    const rawStep = raw[SPLIT_AT].c / raw[SPLIT_AT - 1].c
    const adjStep = adj[SPLIT_AT].c / adj[SPLIT_AT - 1].c
    check('원주가에는 가짜 −90% 계단이 있다', rawStep < 0.2, `rawStep=${rawStep}`)
    check('보정본에는 계단이 없다', Math.abs(adjStep - 1) < 0.1, `adjStep=${adjStep}`)
    closeTo('분할 전 가격은 1/10 스케일로 맞춰진다', adj[0].c / raw[0].c, 0.1, 1e-9)
    check('한계 문구에 수정주가 반영 건수가 남는다', res.meta.limits.some((l) => l.includes('수정주가 반영 1건')))
  }

  {
    // 절단 불변성(규칙 1의 데이터 판) — 뒤를 잘라도 앞 구간 봉이 **완전히 동일**해야 한다.
    // (자르는 구간에 수정 이벤트가 없을 때. 이벤트가 뒤에 생기면 과거 가격 스케일이 바뀌는데,
    //  그것은 업계 표준 수정주가와 같은 성질이며 **일별 수익률은 그대로**다 — 위에서 검증했다.)
    const full = makeKrxFixture([{ code: '000660', n: 300, splitAt: 100, ratio: 5, seed: 5 }])
    const cut = makeKrxFixture([{ code: '000660', n: 200, splitAt: 100, ratio: 5, seed: 5 }])
    const a = (await loadKrPrices(['000660'], 'krx', { krx: krxDepsOf(full.indexRaw, full.stockRaw) })).histories[
      '000660'
    ]
    const b = (await loadKrPrices(['000660'], 'krx', { krx: krxDepsOf(cut.indexRaw, cut.stockRaw) })).histories['000660']
    eq('잘린 쪽 봉 수', b.length, 200)
    let mismatch = 0
    for (let i = 0; i < b.length; i++)
      if (a[i].date !== b[i].date || Math.abs(a[i].c - b[i].c) > 1e-9 || Math.abs(a[i].o - b[i].o) > 1e-9) mismatch++
    eq('잘린 시점 이전 봉이 완전히 동일', mismatch, 0)
  }
}

// ============================================================================
async function testYahooRegression(): Promise<void> {
  section('⑤ 야후 경로 무회귀 — .KQ/.KS 듀얼 로드 규약이 그대로다')

  {
    // .KQ가 가짜(11봉)이고 .KS가 진짜(4000봉)인 종목 — 첫 성공에서 멈추면 안 된다.
    const y = yahooDepsOf({ '035720.KQ': 11, '035720.KS': 4000 })
    const res = await loadKrPrices(['035720'], 'yahoo', { yahoo: y.deps })
    eq('긴 이력을 채택한다', res.symOf['035720'], '035720.KS')
    eq('양쪽 다 조회했다', y.calls.join(','), '035720.KQ,035720.KS')
    eq('실패 없음', res.failed.length, 0)
  }

  {
    // .KQ가 충분히 길면 .KS는 조회하지 않는다(왕복 절약) — 기존 규약 그대로.
    const y = yahooDepsOf({ '086520.KQ': 3000, '086520.KS': 11 })
    const res = await loadKrPrices(['086520'], 'yahoo', { yahoo: y.deps })
    eq('KQ에서 끊는다', y.calls.join(','), '086520.KQ')
    eq('KQ 채택', res.symOf['086520'], '086520.KQ')
  }

  {
    // 둘 다 200봉 미만 = 상장폐지·가짜 응답 → 채택하지 않고 실패로 센다.
    const y = yahooDepsOf({ '111111.KQ': 11, '111111.KS': 11 })
    const res = await loadKrPrices(['111111'], 'yahoo', { yahoo: y.deps })
    eq(`${KR_MIN_BARS}봉 미만은 제외`, res.failed.join(','), '111111')
    eq('histories에 들어가지 않는다', Object.keys(res.histories).length, 0)
    eq('meta.failed에도 남는다', res.meta.failed.join(','), '111111')
  }

  {
    // 동시 로딩(화면 경로 · CONCURRENCY 6)이 결과를 바꾸지 않는다.
    const table: Record<string, number> = {}
    const codes: string[] = []
    for (let i = 0; i < 20; i++) {
      const code = String(100000 + i)
      codes.push(code)
      table[`${code}.${i % 3 === 0 ? 'KQ' : 'KS'}`] = 1000 + i
      if (i % 5 === 0) delete table[`${code}.KQ`] // 일부는 KQ 자체가 없음
    }
    const seq = await loadKrPrices(codes, 'yahoo', { yahoo: yahooDepsOf(table, { concurrency: 1 }).deps })
    const par = await loadKrPrices(codes, 'yahoo', { yahoo: yahooDepsOf(table, { concurrency: 6 }).deps })
    eq('동시 6개도 같은 매핑', JSON.stringify(par.symOf), JSON.stringify(seq.symOf))
    eq('실패 집합도 같다', par.failed.slice().sort().join(','), seq.failed.slice().sort().join(','))

    // 진행 콜백은 요청 수만큼 정확히 온다(화면 진행 표시가 어긋나지 않게).
    let last = 0
    let ticks = 0
    await loadKrPrices(codes, 'yahoo', {
      yahoo: yahooDepsOf(table, { concurrency: 4 }).deps,
      onProgress: (done, total) => {
        ticks++
        last = done
        if (total !== codes.length) ticks = -1
      },
    })
    eq('진행 콜백 횟수 = 코드 수', ticks, codes.length)
    eq('마지막 진행값 = 코드 수', last, codes.length)
  }

  {
    // 중복 코드는 접어서 한 번만 조회한다.
    const y = yahooDepsOf({ '005930.KQ': 500 })
    const res = await loadKrPrices(['005930', '005930'], 'yahoo', { yahoo: y.deps })
    eq('한 번만 조회', y.calls.length, 1)
    eq('요청 수도 접힌다', res.meta.requested, 1)
  }
}

// ============================================================================
async function testMeta(): Promise<void> {
  section('⑥ 정직성 메타 — 배지·출처·한계가 소스마다 다르게 붙는다 (규칙 3)')

  const fx = makeKrxFixture([{ code: '005930', n: 250 }])
  const krxRes = await loadKrPrices(['005930'], 'krx', { krx: krxDepsOf(fx.indexRaw, fx.stockRaw) })
  const yRes = await loadKrPrices(['005930'], 'yahoo', { yahoo: yahooDepsOf({ '005930.KS': 500 }).deps })

  check('KRX 배지에 "배당 미반영"이 있다', krxRes.meta.badge.includes('배당 미반영'))
  check('KRX 한계에 배당 미반영 문구가 있다', krxRes.meta.limits.some((l) => l.includes('배당 미반영')))
  check('KRX 한계에 2010년 이전 부재가 있다', krxRes.meta.limits.some((l) => l.includes('2010년 이전')))
  check('KRX 한계에 워밍업 경고가 있다', krxRes.meta.limits.some((l) => l.includes('워밍업')))
  check('KRX 한계는 정본 목록을 그대로 담는다', KRX_DAILY_LIMITS.every((l) => krxRes.meta.limits.includes(l)))
  check('KRX 출처에 수집일·종목수가 있다', krxRes.meta.note.includes('수집일') && krxRes.meta.note.includes('종목'))

  check('야후 한계에 생존편향이 있다', yRes.meta.limits.some((l) => l.includes('생존편향')))
  check('야후 한계에 가짜 시계열 경고가 있다', yRes.meta.limits.some((l) => l.includes('가짜 시계열')))
  eq('야후 한계는 history.ts 정본을 그대로 쓴다', yRes.meta.limits.length, YAHOO_DAILY_LIMITS.length)
  check('두 배지가 다르다', krxRes.meta.badge !== yRes.meta.badge)
  // 총수익/가격수익이 섞이지 않게 **양쪽 다** 기준을 밝혀야 한다.
  check('야후는 총수익 기준을 밝힌다', yRes.meta.limits.some((l) => l.includes('총수익')))
  check('KRX는 가격수익 기준을 밝힌다', krxRes.meta.limits.some((l) => l.includes('가격수익')))
}

// ============================================================================
async function testProbe(): Promise<void> {
  section('⑦ 준비 상태 확인(probe) · fetch 어댑터 — 화면 게이트가 쓰는 경로')

  {
    const fx = makeKrxFixture([{ code: '005930', n: 250 }])
    const ok = await probeKrxDaily(krxDepsOf(fx.indexRaw, fx.stockRaw))
    check('데이터가 있으면 ready', ok.ready)
    if (ok.ready) check('출처 한 줄을 함께 준다', ok.note.includes('KRX'))

    const none = await probeKrxDaily(krxDepsOf(null, {}))
    check('데이터가 없으면 ready=false', !none.ready)
    if (!none.ready) {
      check('사유가 그대로 화면에 나갈 문구다', none.reason.includes('EC2 krxdaily 수집이 아직 안 끝났습니다'))
      check('"파일 없음"으로 분류된다', none.missing)
    }
    const broken = await probeKrxDaily(krxDepsOf({ schema: 'x' }, {}))
    check('깨진 파일은 missing=false(수집 전이 아니라 파일이 틀린 것)', !broken.ready && !broken.missing)
  }

  {
    // fetch 어댑터: 404는 "아직 없음"(null), 그 외 오류는 던진다.
    const fx = makeKrxFixture([{ code: '005930', n: 250 }])
    const urls: string[] = []
    const fake = (status: number, body: unknown) => async (url: string) => {
      urls.push(url)
      return { ok: status >= 200 && status < 300, status, json: async () => body }
    }
    const d404 = krxFetchDeps('/base/', fake(404, null))
    eq('404 → null', await d404.readIndex(), null)
    eq('자산 경로 규약', urls[0], `/base/${KRX_DAILY_ASSET_DIR}/index.json`)

    const d500 = krxFetchDeps('/base/', fake(500, null))
    const msg = await throwsAsync(() => d500.readIndex())
    check('500은 던진다(없음과 구분)', (msg ?? '').includes('HTTP 500'))

    const dOk = krxFetchDeps('/base/', fake(200, fx.indexRaw))
    const idx = await loadKrPrices([], 'krx', { krx: dOk })
    eq('200이면 정상 파싱', idx.krxIndex?.stocks.length, 1)
    eq('빈 코드 목록도 안전', idx.meta.loaded, 0)
  }
}

// ============================================================================
function testEnv(): void {
  section('⑧ 사전계산 스크립트의 소스 선택 — 환경변수 기본은 KRX 정본')

  eq('미지정이면 기본값(krx)', priceSourceFromEnv({}), 'krx')
  eq('PRICE_SOURCE=krx', priceSourceFromEnv({ PRICE_SOURCE: 'krx' }), 'krx')
  eq('대소문자·공백 허용', priceSourceFromEnv({ PRICE_SOURCE: ' KRX ' }), 'krx')
  eq('모르는 값은 기본값(krx)으로 좁힌다', priceSourceFromEnv({ PRICE_SOURCE: 'naver' }), 'krx')
}

// ============================================================================
function testUtil(): void {
  section('⑨ 유틸 — asOf 계산')

  const bar = (date: string): DailyBar => ({ date, t: 0, o: 1, h: 1, l: 1, c: 1, v: 0 })
  eq('비어 있으면 빈 문자열', lastDateOf({}), '')
  eq('여러 종목의 최대 마지막 날', lastDateOf({ a: [bar('2020-01-01')], b: [bar('2021-05-05')] }), '2021-05-05')
  eq('봉이 없는 종목은 건너뛴다', lastDateOf({ a: [], b: [bar('2019-03-03')] }), '2019-03-03')
}

async function main(): Promise<void> {
  testKinds()
  await testRouting()
  await testNoFallback()
  await testAdjustment()
  await testYahooRegression()
  await testMeta()
  await testProbe()
  testEnv()
  testUtil()
}

main().then(finish, (e) => {
  console.error(`테스트 실행 중 예외: ${e?.stack ?? e}`)
  process.exit(1)
})
