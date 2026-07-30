// Convex 이관 Phase A 검증 — 네트워크 없이 순수 로직만 돌린다.
//
// 이 테스트가 지키는 것:
//   1) 서빙 응답이 **기존 정적 JSON과 같은 키 구조**인가 (프론트가 URL만 바꿔 끼울 수 있는가)
//   2) 봉 조회에 **상한과 커서**가 실제로 걸리는가 (ops 최우선 가이드 규칙 2 — 전체 조회 금지)
//   3) 경로 해석이 임의 문자열을 받아주지 않는가
//   4) 업로더의 배치 분할·URL 정규화·백오프가 맞는가 (500봉 상한 준수)
//   5) 왕복(pack→unpack)이 값을 잃지 않는가
//
// 재발방지: 다음 세션이 "간단하니까" 전체 봉을 한 번에 돌려주도록 바꾸면 여기서 깨진다.

import { check, eq, finish, section } from './harness'
import {
  DEFAULT_BAR_PAGE,
  INGEST_BAR_BATCH_MAX,
  MAX_BAR_PAGE,
  buildIndexResponse,
  buildSymbolResponse,
  normalizeIngestBars,
  packRows,
  parseDataPath,
  parsePageParams,
  sliceBarPage,
  unpackBars as unpackBarsTs,
  type BarRow,
} from '../convex/lib/intradayServe'
import httpRouter from '../convex/http'
// @ts-expect-error — .mjs 라이브러리(타입 선언 없음). esbuild가 번들한다.
import {
  backoffDelayMs,
  chunk,
  httpActionBase,
  indexHeader,
  isRetryableStatus,
  planSymbolIngest,
  unpackBars as unpackBarsMjs,
} from '../scripts/lib/convexSync.mjs'

// 5분봉 모사 — t는 epoch 초, 300초 간격.
function makeBars(n: number, startT = 1_777_852_800): BarRow[] {
  const out: BarRow[] = []
  for (let i = 0; i < n; i++) {
    out.push({ t: startT + i * 300, o: 1000 + i, h: 1010 + i, l: 990 + i, c: 1005 + i, v: 100 * i })
  }
  return out
}

// ─────────────────────────────────────────── 1) 경로 해석
section('1) 경로 해석 — 허용 패턴 밖은 404')
{
  eq('index 경로', parseDataPath('/data/intraday/index.json')?.kind, 'intraday-index')

  const sym = parseDataPath('/data/intraday/000660.KS.json')
  eq('심볼 경로 kind', sym?.kind, 'intraday-symbol')
  eq('심볼 추출', sym && sym.kind === 'intraday-symbol' ? sym.symbol : null, '000660.KS')

  eq('코스닥 접미사 허용', parseDataPath('/data/intraday/000250.KQ.json')?.kind, 'intraday-symbol')

  const paper = parseDataPath('/data/paper/all80.json')
  eq('페이퍼 트랙 추출', paper && paper.kind === 'paper' ? paper.track : null, 'all80')
  eq('config 트랙도 허용', parseDataPath('/data/paper/config.json')?.kind, 'paper')

  check('미국 티커 등 미허용 접미사 거부', parseDataPath('/data/intraday/AAPL.json') === null)
  check('경로 이탈 거부', parseDataPath('/data/intraday/../../etc/passwd.json') === null)
  check('대문자 트랙 거부', parseDataPath('/data/paper/ALL80.json') === null)
  check('빈 트랙 거부', parseDataPath('/data/paper/.json') === null)
  check('알 수 없는 경로 거부', parseDataPath('/data/whatever.json') === null)
}

// ─────────────────────────────────────────── 2) 페이지 파라미터
section('2) 페이지 파라미터 — 기본값·상한')
{
  const p = (qs: string) => parsePageParams(new URLSearchParams(qs))

  eq('from 없으면 null (최신 모드)', p('').from, null)
  eq('기본 limit', p('').limit, DEFAULT_BAR_PAGE)
  eq('from 파싱', p('from=1777852800').from, 1777852800)
  eq('limit 파싱', p('limit=10').limit, 10)
  eq('limit 상한 강제', p('limit=999999').limit, MAX_BAR_PAGE)
  eq('limit 0 → 기본값', p('limit=0').limit, DEFAULT_BAR_PAGE)
  eq('limit 음수 → 기본값', p('limit=-5').limit, DEFAULT_BAR_PAGE)
  eq('limit 비숫자 → 기본값', p('limit=abc').limit, DEFAULT_BAR_PAGE)
  eq('from 비숫자 → null', p('from=abc').from, null)
  eq('from 음수 → 0으로 클램프', p('from=-100').from, 0)

  check('상한이 실제로 유한하다 (전체 조회 금지)', Number.isFinite(MAX_BAR_PAGE) && MAX_BAR_PAGE > 0)
}

// ─────────────────────────────────────────── 3) 커서 로직
section('3) 커서 페이지네이션 — 경계 봉 중복·누락 없음')
{
  // from 모드: limit+1개를 읽어와 "더 있는지"를 count 없이 판정한다.
  const rowsPlusOne = makeBars(4) // limit 3 + 1
  const r = sliceBarPage(rowsPlusOne, 3, 'from', rowsPlusOne[0].t)
  eq('limit만큼만 반환', r.rows.length, 3)
  eq('hasMore 참', r.page.hasMore, true)
  eq('nextFrom = 마지막봉 +1초', r.page.nextFrom, rowsPlusOne[2].t + 1)
  eq('oldestT', r.page.oldestT, rowsPlusOne[0].t)
  eq('returned', r.page.returned, 3)

  // 이어받기: nextFrom 으로 다음 페이지를 뜨면 경계 봉이 두 번 나오지 않아야 한다.
  const all = makeBars(7)
  const page1raw = all.filter((b) => b.t >= all[0].t).slice(0, 4) // limit 3 + 1
  const p1 = sliceBarPage(page1raw, 3, 'from', all[0].t)
  const page2raw = all.filter((b) => b.t >= (p1.page.nextFrom as number)).slice(0, 4)
  const p2 = sliceBarPage(page2raw, 3, 'from', p1.page.nextFrom)
  const seen = [...p1.rows, ...p2.rows].map((b) => b.t)
  eq('두 페이지 합계 6봉', seen.length, 6)
  eq('중복 없음', new Set(seen).size, 6)
  eq('순서 유지', seen.join(','), all.slice(0, 6).map((b) => b.t).join(','))

  // latest 모드: 최신 쪽 끝이라 nextFrom 없음.
  const l = sliceBarPage(makeBars(3), 3, 'latest', null)
  eq('latest 모드 hasMore 거짓', l.page.hasMore, false)
  eq('latest 모드 nextFrom null', l.page.nextFrom, null)
  eq('latest 모드 mode', l.page.mode, 'latest')

  // 빈 결과
  const e = sliceBarPage([], 3, 'from', 0)
  eq('빈 페이지 returned 0', e.page.returned, 0)
  eq('빈 페이지 nextFrom null', e.page.nextFrom, null)
  eq('빈 페이지 oldestT null', e.page.oldestT, null)
}

// ─────────────────────────────────────────── 4) 응답 스키마 호환
section('4) 응답 스키마 — 기존 정적 JSON과 동일 키')
{
  // 개별 심볼 파일 실측 키: symbol / bars{ts,o,h,l,c,v} / coverage / tz  (+ page 는 추가분)
  const rows = makeBars(3)
  const res = buildSymbolResponse({
    symbol: '000660.KS',
    rows,
    meta: {
      symbol: '000660.KS',
      bars: 4286,
      days: 60,
      first: '2026-05-04',
      last: '2026-07-30',
      thin: 0,
      coverage: { days: 60, bars: 4286, firstDate: '2026-05-04', lastDate: '2026-07-30', thinDays: [] },
      tz: 'Asia/Seoul',
    },
    page: sliceBarPage(rows, 500, 'latest', null).page,
  })
  eq('symbol', res.symbol, '000660.KS')
  const bars = res.bars as Record<string, number[]>
  eq('bars 키 집합', Object.keys(bars).join(','), 'ts,o,h,l,c,v')
  eq('ts 길이', bars.ts.length, 3)
  eq('o 첫값', bars.o[0], rows[0].o)
  eq('v 마지막값', bars.v[2], rows[2].v)
  eq('tz 유지', res.tz, 'Asia/Seoul')
  check('coverage 유지', res.coverage != null)
  check('page 키 추가됨(기존 키는 불변)', res.page != null)
  eq('기존 4키가 모두 존재', ['symbol', 'bars', 'coverage', 'tz'].every((k) => k in res), true)

  // meta가 아직 없을 때도 응답 구조는 유지된다(폴백).
  const noMeta = buildSymbolResponse({ symbol: 'X.KS', rows: [], meta: null, page: sliceBarPage([], 500, 'latest', null).page })
  eq('meta 없어도 tz 기본값', noMeta.tz, 'Asia/Seoul')
  eq('meta 없으면 coverage null', noMeta.coverage, null)

  // index.json 실측 키: source/interval/range/note/barsPerDay/updatedAt/symbolCount/symbols
  const idx = buildIndexResponse({
    header: {
      source: 'Yahoo Finance chart API v8',
      interval: '5m',
      range: '60d',
      note: '누적 필요',
      barsPerDay: 78,
      updatedAt: '2026-07-30T08:43:43.600Z',
    },
    metas: [
      { symbol: '000660.KS', bars: 4286, days: 60, first: '2026-05-04', last: '2026-07-30', thin: 0, updatedAt: '2026-07-30T00:00:00.000Z' },
      { symbol: '005930.KS', bars: 4286, days: 60, first: '2026-05-04', last: '2026-07-30', thin: 1, updatedAt: '2026-07-30T00:00:00.000Z' },
    ],
    truncated: false,
  })
  eq(
    'index 키 집합',
    Object.keys(idx).join(','),
    'source,interval,range,note,barsPerDay,updatedAt,symbolCount,symbols',
  )
  eq('symbolCount는 실제 서빙 수로 재계산', idx.symbolCount, 2)
  const symbols = idx.symbols as Record<string, Record<string, unknown>>
  eq('심볼 요약 키 집합', Object.keys(symbols['000660.KS']).join(','), 'bars,days,first,last,thin')
  eq('thin 값 보존', symbols['005930.KS'].thin, 1)
  check('truncated 아니면 키 없음', !('truncated' in idx))

  // 상한에 걸리면 조용히 넘기지 않고 응답에 남긴다(정직성 규칙 3).
  const cut = buildIndexResponse({ header: null, metas: [{ symbol: 'A.KS', bars: 1, days: 1, first: 'x', last: 'x', thin: 0 }], truncated: true })
  check('truncated 표기', (cut as Record<string, unknown>).truncated != null)
  eq('헤더 없으면 null로 채움(키는 유지)', cut.source, null)
}

// ─────────────────────────────────────────── 5) 컬럼형 왕복
section('5) pack/unpack 왕복 — 값 손실 없음')
{
  const rows = makeBars(50)
  const back = unpackBarsTs(packRows(rows))
  eq('길이 보존', back.length, rows.length)
  eq('전 필드 일치', JSON.stringify(back), JSON.stringify(rows))

  // 축 길이가 어긋난 손상 파일 → 가장 짧은 축까지만 (undefined 밀어넣기 방지)
  const broken = unpackBarsTs({ ts: [1, 2, 3], o: [1, 2], h: [1, 2, 3], l: [1, 2, 3], c: [1, 2, 3], v: [1, 2, 3] })
  eq('손상 파일은 짧은 축까지만', broken.length, 2)
  eq('null 입력은 빈 배열', unpackBarsTs(null).length, 0)

  // .mjs 구현도 같은 결과여야 한다(업로더/서빙이 다른 봉을 보면 안 된다)
  eq('mjs 구현과 동일', JSON.stringify(unpackBarsMjs(packRows(rows))), JSON.stringify(rows))
}

// ─────────────────────────────────────────── 6) ingest 검증
section('6) ingest 본문 검증 — 배치 상한·타입')
{
  const ok = normalizeIngestBars(makeBars(3))
  eq('정상 통과', ok.ok, true)

  const over = normalizeIngestBars(makeBars(INGEST_BAR_BATCH_MAX + 1))
  eq('상한 초과 거부', over.ok, false)
  check('거부 사유에 상한 명시', !over.ok && over.error.includes(String(INGEST_BAR_BATCH_MAX)))

  eq('배열 아니면 거부', normalizeIngestBars({ t: 1 }).ok, false)
  eq('숫자 아닌 필드 거부', normalizeIngestBars([{ t: 1, o: 'x', h: 1, l: 1, c: 1, v: 1 }]).ok, false)
  eq('NaN 거부', normalizeIngestBars([{ t: 1, o: NaN, h: 1, l: 1, c: 1, v: 1 }]).ok, false)
  eq('소수 t 거부', normalizeIngestBars([{ t: 1.5, o: 1, h: 1, l: 1, c: 1, v: 1 }]).ok, false)
  eq('음수 t 거부', normalizeIngestBars([{ t: -1, o: 1, h: 1, l: 1, c: 1, v: 1 }]).ok, false)
  eq('빈 배열 허용', normalizeIngestBars([]).ok, true)

  // 같은 t 중복은 마지막 것만 남고, 결과는 오름차순
  const dup = normalizeIngestBars([
    { t: 300, o: 1, h: 1, l: 1, c: 1, v: 1 },
    { t: 100, o: 2, h: 2, l: 2, c: 2, v: 2 },
    { t: 300, o: 9, h: 9, l: 9, c: 9, v: 9 },
  ])
  check('중복 제거 후 2봉', dup.ok && dup.bars.length === 2)
  check('오름차순 정렬', dup.ok && dup.bars[0].t === 100 && dup.bars[1].t === 300)
  check('중복은 마지막 값 채택', dup.ok && dup.bars[1].o === 9)
}

// ─────────────────────────────────────────── 7) 업로더 배치 분할
section('7) 업로더 — 배치 분할이 상한을 넘지 않는다')
{
  eq('정확히 나누어떨어짐', chunk(makeBars(1000), 500).length, 2)
  eq('나머지 배치', chunk(makeBars(1001), 500).length, 3)
  eq('빈 배열', chunk([], 500).length, 0)
  eq('size보다 작으면 1덩어리', chunk(makeBars(3), 500).length, 1)

  const cs = chunk(makeBars(4286), INGEST_BAR_BATCH_MAX)
  check('실데이터 규모(4286봉) 전 배치가 상한 이하', cs.every((c: BarRow[]) => c.length <= INGEST_BAR_BATCH_MAX))
  eq('총 봉 수 보존', cs.reduce((a: number, c: BarRow[]) => a + c.length, 0), 4286)
  eq('배치 수', cs.length, 9)

  // 실파일 모양 그대로의 계획 수립
  const plan = planSymbolIngest({
    symbol: '000660.KS',
    file: {
      symbol: '000660.KS',
      bars: packRows(makeBars(1200)),
      coverage: { days: 60, bars: 1200, firstDate: '2026-05-04', lastDate: '2026-07-30', thinDays: [] },
      tz: 'Asia/Seoul',
    },
    summary: { bars: 1200, days: 60, first: '2026-05-04', last: '2026-07-30', thin: 0 },
  })
  eq('배치 3개', plan.batches.length, 3)
  eq('meta.first', plan.meta.first, '2026-05-04')
  eq('meta.thin', plan.meta.thin, 0)
  eq('meta.tz', plan.meta.tz, 'Asia/Seoul')
  check('coverage 원형 유지', plan.meta.coverage?.avgBarsPerDay === undefined && plan.meta.coverage?.days === 60)

  // summary 없이 coverage만 있어도 meta가 만들어진다
  const plan2 = planSymbolIngest({
    symbol: 'X.KS',
    file: { bars: packRows(makeBars(2)), coverage: { days: 1, bars: 2, firstDate: 'a', lastDate: 'b', thinDays: ['a'] } },
  })
  eq('coverage 폴백 first', plan2.meta.first, 'a')
  eq('thinDays 길이 → thin', plan2.meta.thin, 1)

  // --recent=N: 일일 크론이 전량을 다시 밀지 않도록 꼬리만 보낸다.
  // meta는 항상 **전체** 기준이어야 한다(꼬리만 보냈다고 bars 수가 줄면 index가 거짓말을 한다).
  const inc = planSymbolIngest({
    symbol: '000660.KS',
    file: { bars: packRows(makeBars(1200)), coverage: { days: 60, bars: 1200, firstDate: 'a', lastDate: 'b', thinDays: [] } },
    summary: { bars: 1200, days: 60, first: 'a', last: 'b', thin: 0 },
    recent: 200,
  })
  eq('recent=200 → 1배치', inc.batches.length, 1)
  eq('recent=200 → 200봉', inc.batches[0].length, 200)
  eq('꼬리(최신) 쪽을 보낸다', inc.batches[0][199].t, makeBars(1200)[1199].t)
  eq('meta는 전체 기준 유지', inc.meta.bars, 1200)
  eq('totalBars 보고', inc.totalBars, 1200)

  const incAll = planSymbolIngest({ symbol: 'Z.KS', file: { bars: packRows(makeBars(50)) }, recent: 200 })
  eq('보유량이 recent보다 적으면 전량', incAll.batches[0].length, 50)

  // 정렬되지 않은 파일도 결정적으로 오름차순 배치가 된다
  const shuffled = { bars: packRows([makeBars(3)[2], makeBars(3)[0], makeBars(3)[1]]) }
  const plan3 = planSymbolIngest({ symbol: 'Y.KS', file: shuffled })
  const ts = plan3.batches[0].map((b: BarRow) => b.t)
  eq('오름차순 정렬됨', ts.join(','), [...ts].sort((a: number, b: number) => a - b).join(','))
}

// ─────────────────────────────────────────── 8) URL 정규화·백오프
section('8) 업로더 — URL 정규화 / 재시도')
{
  // 함정: 함수 API는 .convex.cloud, HTTP action은 .convex.site 로 도메인이 다르다.
  const c = httpActionBase('https://valiant-vole-735.convex.cloud')
  eq('.cloud → .site 교정', c.base, 'https://valiant-vole-735.convex.site')
  eq('교정 사실을 알린다', c.converted, true)

  const s = httpActionBase('https://valiant-vole-735.convex.site/')
  eq('.site 그대로', s.base, 'https://valiant-vole-735.convex.site')
  eq('교정 없음', s.converted, false)

  let threw = false
  try {
    httpActionBase('http://example.com')
  } catch {
    threw = true
  }
  eq('http 거부', threw, true)

  threw = false
  try {
    httpActionBase('')
  } catch {
    threw = true
  }
  eq('빈 값 거부', threw, true)

  // 지수 백오프 (지터 고정)
  eq('1회차', backoffDelayMs(1, { baseMs: 500, jitter: 1 }), 500)
  eq('2회차', backoffDelayMs(2, { baseMs: 500, jitter: 1 }), 1000)
  eq('3회차', backoffDelayMs(3, { baseMs: 500, jitter: 1 }), 2000)
  eq('상한 적용', backoffDelayMs(10, { baseMs: 500, maxMs: 8000, jitter: 1 }), 8000)

  eq('500은 재시도', isRetryableStatus(500), true)
  eq('429는 재시도', isRetryableStatus(429), true)
  eq('408은 재시도', isRetryableStatus(408), true)
  eq('네트워크 예외(null)는 재시도', isRetryableStatus(null), true)
  eq('400은 재시도 안 함', isRetryableStatus(400), false)
  eq('401은 재시도 안 함', isRetryableStatus(401), false)
  eq('200은 재시도 안 함', isRetryableStatus(200), false)
}

// ─────────────────────────────────────────── 9) index 헤더 분리
section('9) index 헤더 — 심볼 목록은 헤더에 중복 저장하지 않는다')
{
  const h = indexHeader({
    source: 'Yahoo',
    interval: '5m',
    range: '60d',
    note: 'n',
    barsPerDay: 78,
    updatedAt: '2026-07-30T08:43:43.600Z',
    symbolCount: 80,
    symbols: { 'A.KS': { bars: 1, days: 1, first: 'a', last: 'a', thin: 0 } },
  })
  check('symbols 제거', !('symbols' in h))
  check('symbolCount 제거(서빙 시 재계산)', !('symbolCount' in h))
  eq('나머지 헤더 유지', Object.keys(h).join(','), 'source,interval,range,note,barsPerDay,updatedAt')
  eq('빈 입력 안전', Object.keys(indexHeader(null)).length, 0)
}

// ─────────────────────────────────────────── 10) 시크릿 미포함 가드
section('10) 시크릿 미포함 — 이름만 코드에 둔다')
{
  // 값이 코드에 섞여 들어가는 것을 막는 최소 가드. 실제 값 검출은 불가능하므로
  // "이름만 참조하는가"를 본다. (전수 스캔은 tests/loadsecret.test.ts 담당)
  const syncSrc = String(planSymbolIngest)
  check('순수 로직에 토큰 관련 코드 없음', !/token|secret/i.test(syncSrc))
}

// ─────────────────────────────────────────── 11) 라우트 등록
section('11) httpRouter — 새 라우트가 실제로 매칭된다')
{
  // 배포 없이 잡을 수 있는 유일한 라우팅 오류(경로 오타·prefix 누락·기존 라우트 파괴)를 여기서 잡는다.
  // convex/http.ts 는 _generated/server 를 타는데 그것은 convex/server 재수출이라 Node에서 번들된다.
  const routes = (httpRouter as unknown as { getRoutes(): unknown[] }).getRoutes()
  check('라우트가 등록되어 있다', routes.length > 0)

  const lookup = (p: string, m: string) =>
    (httpRouter as unknown as { lookup(p: string, m: string): unknown }).lookup(p, m)

  check('GET /data/intraday/index.json', lookup('/data/intraday/index.json', 'GET') != null)
  check('GET /data/intraday/<심볼>.json', lookup('/data/intraday/000660.KS.json', 'GET') != null)
  check('GET /data/paper/<트랙>.json', lookup('/data/paper/all80.json', 'GET') != null)
  check('POST /ingest/intraday', lookup('/ingest/intraday', 'POST') != null)
  check('POST /ingest/intraday-index', lookup('/ingest/intraday-index', 'POST') != null)
  check('POST /ingest/paper', lookup('/ingest/paper', 'POST') != null)
  check('OPTIONS 프리플라이트(심볼)', lookup('/data/intraday/000660.KS.json', 'OPTIONS') != null)

  // 기존 라우트를 깨지 않았는가 (회귀 방지)
  check('기존 GET /data/supply-demand.json 유지', lookup('/data/supply-demand.json', 'GET') != null)
  check('기존 GET /data/hynix-outlook.json 유지', lookup('/data/hynix-outlook.json', 'GET') != null)
  check('기존 POST /ingest/hynix-outlook 유지', lookup('/ingest/hynix-outlook', 'POST') != null)

  check('미등록 경로는 매칭 안 됨', lookup('/nope.json', 'GET') == null)
}

finish()
