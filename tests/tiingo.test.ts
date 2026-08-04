// tiingo 시세 소스 — 파서 · **배당 보정 감사** · 티커 재사용 가드 · 폴백 정책 (합성 픽스처).
//
// 이 파일이 막는 사고는 넷이다.
//
//   ① 🔴 **배당 비대칭이 되살아나는 것 — 이 작업의 가장 큰 함정.**
//      야후 경로는 `adjclose ÷ close` 계수로 총수익을 만든다. tiingo `adj*`가 **분할만**
//      반영한다면 전략은 가격수익, 벤치·벽은 총수익이 되어 2026-08-03 국장 40차에서
//      제거한 배당 비대칭이 그대로 돌아온다. 컨테이너는 외부망이 막혀 실응답을 볼 수 없으므로
//      **양쪽 규약으로 만든 합성 응답**을 넣어 감사가 둘을 갈라내는지 검증한다.
//      실제 기준은 첫 GHA 실행의 응답이 확정한다 — 그때까지 코드·출력에 `[미검증]`이 남는다.
//   ② **"없음"과 "실패"를 섞는 것.** 404·빈 배열은 absent(그 종목이 없다), 401/403/429/5xx는
//      소스 실패다. 뭉치면 "상폐 커버리지가 없다"는 없는 결론이 생긴다(8/3에 실제로 그랬다 —
//      키가 없어 skipped였던 것을 0으로 뭉갰다면 판정이 굳었을 것이다).
//   ③ **티커 재사용 오염.** 야후는 메릴린치 상폐 17년 뒤 날짜의 **1봉짜리 껍데기**를 200으로
//      준다. 같은 오염을 tiingo 경로에서 막는지(긴 공백 → 티커 전체 거부) 검증한다.
//   ④ **조용한 폴백.** tiingo 실패를 야후로 메우면 소스가 섞여 보정 기준이 종목마다 달라진다.
//      us-lab이 실패를 실패로 세고 출처를 기록하는지 본다.
//
// 네트워크를 타지 않는다 — 어댑터에는 가짜 fetch를 끼우고 나머지는 순수 함수만 부른다.

import { check, eq, section, finish } from './harness'
import {
  TIINGO_ADJ_TOLERANCE,
  TIINGO_REUSE_GAP_DAYS,
  TIINGO_UNVERIFIED,
  auditTiingoAdjustment,
  checkTickerReuseGap,
  classifyTiingoStatus,
  fetchTiingoDaily,
  hasDividendFields,
  parseTiingoRows,
  tiingoBarsToDaily,
  tiingoDailyUrl,
  tiingoHeaders,
  type TiingoRow,
} from '../scripts/lib/tiingo'
import {
  compareBasisFor,
  compareBasisNote,
  estimateBanner,
  loadRealUniverseFromDisk,
  newPriceTally,
  pickPriceSource,
  pickUniverse,
  rangeToStartDate,
  realUniverseFrom,
  sourceMixLine,
  tiingoBasisGate,
} from '../scripts/us-lab.entry'
import { buildUsPitRealUniverse } from '../src/features/backtest/usPitUniverse'

function threw(fn: () => unknown): string | null {
  try {
    fn()
    return null
  } catch (e) {
    return (e as Error).message
  }
}

async function threwAsync(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn()
    return null
  } catch (e) {
    return (e as Error).message
  }
}

// ═════════════════════════════════════════════════════════════════════════════
section('① URL · 헤더 — 키는 헤더로만 나간다')

const url = tiingoDailyUrl('MER', { startDate: '1999-01-01' })
check('일봉 경로', /\/tiingo\/daily\/mer\/prices/.test(url))
check('startDate가 실린다', /startDate=1999-01-01/.test(url))
check('format=json', /format=json/.test(url))
check('🔴 키가 쿼리에 실리지 않는다(로그·리퍼러에 남는다)', !/token|apikey|key=/i.test(url))
eq('인증은 Authorization 헤더', tiingoHeaders('ABC').Authorization, 'Token ABC')

// ═════════════════════════════════════════════════════════════════════════════
section('② 상태코드 — 없음(absent)과 실패(throw)를 가른다')

eq('200 → ok', classifyTiingoStatus(200, '[]').kind, 'ok')
eq('404(없는 티커) → absent', classifyTiingoStatus(404, '{"detail":"Ticker not found"}').kind, 'absent')
check('401은 절대 absent가 아니다 — 키 실패', /인증 실패/.test(threw(() => classifyTiingoStatus(401, '')) ?? ''))
check('403도 인증 실패', /인증 실패/.test(threw(() => classifyTiingoStatus(403, '')) ?? ''))
check('429는 한도 초과 = 소스 실패', /429/.test(threw(() => classifyTiingoStatus(429, '')) ?? ''))
check('5xx도 소스 실패', /500/.test(threw(() => classifyTiingoStatus(500, 'oops')) ?? ''))

// ═════════════════════════════════════════════════════════════════════════════
section('③ 파서 — 형식 변경은 던지고, 빈 배열만 absent')

const ROWS = [
  { date: '2008-12-30T00:00:00.000Z', open: 11, high: 12, low: 10, close: 11.5, volume: 100, adjClose: 11.5, adjOpen: 11, divCash: 0, splitFactor: 1 },
  { date: '2008-12-31T00:00:00.000Z', open: 11.5, high: 13, low: 11, close: 12.8, volume: 120, adjClose: 12.8, adjOpen: 11.5, divCash: 0, splitFactor: 1 },
]
const parsed = parseTiingoRows(ROWS)
eq('행 2개', parsed.rows.length, 2)
eq('날짜는 ISO8601에서 앞 10자만', parsed.rows[0].date, '2008-12-30')
check('오름차순 정렬', parsed.rows[0].date < parsed.rows[1].date)
eq('빈 배열은 absent(정상 0건)', parseTiingoRows([]).absent, true)
check('오류 본문(detail)은 던진다', /오류 본문/.test(threw(() => parseTiingoRows({ detail: "Ticker 'WCOM' not found" })) ?? ''))
check('배열이 아니면 던진다', /배열이 아니다/.test(threw(() => parseTiingoRows({ foo: 1 })) ?? ''))
check(
  '필드명이 통째로 바뀌면 조용히 0건이 아니라 던진다',
  /모두 파싱 실패/.test(threw(() => parseTiingoRows([{ d: '2020-01-01', c: 1 }])) ?? ''),
)
eq('종가만 있는 최소 응답도 읽는다(프로브가 쓰는 형태)', parseTiingoRows([{ date: '2020-01-02', close: 5 }]).rows.length, 1)
eq('OHLC 없는 행은 봉으로 옮길 때 **버린다**(종가로 때우지 않는다)', tiingoBarsToDaily(parseTiingoRows([{ date: '2020-01-02', close: 5 }]).rows, 'total').dropped, 1)
eq('divCash·splitFactor가 없는 응답은 감사 전제가 성립하지 않는다', hasDividendFields([{ date: '2020-01-02', close: 5 }]), false)
eq('divCash·splitFactor가 있으면 true', hasDividendFields(ROWS), true)

// ═════════════════════════════════════════════════════════════════════════════
section('④ 🔴 배당·분할 보정 감사 — 문서를 믿지 않고 응답으로 판정한다')
//
// 합성 시계열: 종가 100 고정 · 60일마다 배당 1.0. 분할은 없다.
//   · 총수익 규약  → adjClose는 배당락마다 계수가 계단식으로 낮아진다(과거일수록 작다)
//   · 가격수익 규약 → adjClose == close (계수 항상 1)

function buildSeries(mode: 'total' | 'price', n = 300, div = 1.0, close = 100): TiingoRow[] {
  const rows: TiingoRow[] = []
  const divAt = (i: number): number => (i > 0 && i % 60 === 0 ? div : 0)
  // 총수익 계수는 **뒤에서 앞으로** 누적한다(최신 봉의 계수가 1).
  const factors: number[] = new Array(n).fill(1)
  for (let i = n - 2; i >= 0; i--) factors[i] = factors[i + 1] * (1 - divAt(i + 1) / close)
  for (let i = 0; i < n; i++) {
    const d = new Date(Date.UTC(2020, 0, 1) + i * 86400000).toISOString().slice(0, 10)
    const f = mode === 'total' ? factors[i] : 1
    rows.push({
      date: d,
      open: close,
      high: close,
      low: close,
      close,
      volume: 1000,
      adjOpen: close * f,
      adjHigh: close * f,
      adjLow: close * f,
      adjClose: close * f,
      adjVolume: 1000,
      divCash: divAt(i),
      splitFactor: 1,
    })
  }
  return rows
}

const auditTotal = auditTiingoAdjustment(buildSeries('total'))
eq('배당 반영 시계열 → total', auditTotal.verdict, 'total')
check('배당 사건을 실제로 세었다', auditTotal.events >= 3 && auditTotal.totalVotes === auditTotal.events)
check('adjOpen/open = adjClose/close (야후식 단일 계수 모델 성립)', auditTotal.singleFactorOk)

const auditPrice = auditTiingoAdjustment(buildSeries('price'))
eq('🔴 배당 미반영 시계열 → price (이걸 못 잡으면 배당 비대칭이 되살아난다)', auditPrice.verdict, 'price')
check('가격수익 규약에서는 배당 사건이 전부 price로 투표된다', auditPrice.priceVotes === auditPrice.events)

const auditNoDiv = auditTiingoAdjustment(buildSeries('total', 30))
eq('배당 사건이 부족하면 판정하지 않는다(unknown)', auditNoDiv.verdict, 'unknown')
check('판정불가 사유에 [미검증]을 남긴다', /\[미검증\]/.test(auditNoDiv.note))
eq('빈 시계열도 unknown', auditTiingoAdjustment([]).verdict, 'unknown')

// adjOpen만 다른 계수를 쓰는 응답 — 단일 계수 모델이 깨진 것을 잡아낸다.
const skewed = buildSeries('total').map((r, i) => (i % 2 === 0 ? { ...r, adjOpen: (r.adjOpen ?? 0) * 1.05 } : r))
check('adjOpen/open ≠ adjClose/close 면 경고를 남긴다', !auditTiingoAdjustment(skewed).singleFactorOk)
check('허용 오차는 상수로 노출돼 있다', TIINGO_ADJ_TOLERANCE > 0 && TIINGO_ADJ_TOLERANCE < 0.01)

// ── 게이트: 판정 결과가 실행을 막는가 ────────────────────────────────────────
check('total이면 통과하고 근거를 남긴다', /분할\+배당/.test(tiingoBasisGate(auditTotal, false)))
check(
  '🔴 price면 **실행을 중단**한다 — 배당 비대칭을 경고로 넘기지 않는다',
  /배당 비대칭/.test(threw(() => tiingoBasisGate(auditPrice, false)) ?? ''),
)
check('unknown이면 기본적으로 중단', /US_TIINGO_ALLOW_UNVERIFIED/.test(threw(() => tiingoBasisGate(auditNoDiv, false)) ?? ''))
check('unknown은 명시 플래그로만 통과하고 [미검증] 딱지가 붙는다', /\[미검증\]/.test(tiingoBasisGate(auditNoDiv, true)))

// ── 봉 변환: 야후와 **같은 변환식**을 쓴다 ──────────────────────────────────
const conv = tiingoBarsToDaily(buildSeries('total', 121), 'total')
eq('봉 수', conv.bars.length, 121)
eq('버린 행 없음', conv.dropped, 0)
check('총수익 계수가 OHLC 전체에 곱해진다(시가 체결이 같은 기준을 쓴다)', Math.abs(conv.bars[0].o - conv.bars[0].c) < 1e-9)
check('과거 봉이 배당만큼 낮게 조정된다(계수 < 1)', conv.bars[0].c < conv.bars[conv.bars.length - 1].c)
check('원시 종가는 따로 남긴다(대조용)', conv.bars[0].rawClose === 100)
const convPrice = tiingoBarsToDaily(buildSeries('total', 121), 'price')
check('basis=price면 계수를 곱하지 않는다', convPrice.bars.every((b) => Math.abs(b.c - 100) < 1e-9))

// ═════════════════════════════════════════════════════════════════════════════
section('⑤ 티커 재사용 가드 — MER 껍데기 사건을 tiingo 경로에서도 막는다')

const contiguous = buildSeries('total', 120)
check('정상 시계열은 통과', checkTickerReuseGap(contiguous).ok)

// 메릴린치(2008-12-31 상폐) 자리에 17년 뒤 봉이 붙은 형태.
const reused: TiingoRow[] = [
  ...contiguous.slice(0, 30),
  { ...contiguous[0], date: '2026-07-17' },
]
const gap = checkTickerReuseGap(reused)
check('🔴 긴 공백이 있으면 거부한다(뒤 구간만 잘라 쓰면 조용한 오염)', !gap.ok)
check('거부 사유에 공백 구간이 찍힌다', /공백/.test(gap.reason) && /재사용/.test(gap.reason))
check('임계는 상수로 노출(미국 정규장 최장 연휴보다 훨씬 크다)', TIINGO_REUSE_GAP_DAYS >= 200)

// ═════════════════════════════════════════════════════════════════════════════
section('⑥ 어댑터 — 가짜 fetch로 실패 분류를 확인한다(네트워크 없음)')

const fakeFetch = (status: number, body: string) => async () => ({ status, text: async () => body })

void (async () => {
  const ok = await fetchTiingoDaily('MER', 'K', { fetchImpl: fakeFetch(200, JSON.stringify(ROWS)) as never })
  eq('200 + 배열 → ok', ok.kind, 'ok')
  eq('행 수', ok.rows.length, 2)

  const absent404 = await fetchTiingoDaily('WCOM', 'K', { fetchImpl: fakeFetch(404, '{"detail":"not found"}') as never })
  eq('404 → absent', absent404.kind, 'absent')

  const absentEmpty = await fetchTiingoDaily('LEH', 'K', { fetchImpl: fakeFetch(200, '[]') as never })
  eq('빈 배열 → absent', absentEmpty.kind, 'absent')
  check('빈 배열의 의미는 단정하지 않는다', /\[미검증\]/.test(absentEmpty.note))

  check(
    '429는 absent가 아니라 던진다',
    /429/.test((await threwAsync(() => fetchTiingoDaily('AAPL', 'K', { fetchImpl: fakeFetch(429, '') as never }))) ?? ''),
  )
  check(
    'JSON이 아니면 던진다',
    /JSON이 아니다/.test((await threwAsync(() => fetchTiingoDaily('AAPL', 'K', { fetchImpl: fakeFetch(200, '<html>') as never }))) ?? ''),
  )

  // ═══════════════════════════════════════════════════════════════════════════
  section('⑦ 러너 배선 — 소스 선택 · 폴백 정책 · 출처 기록')

  eq('기본 소스는 yahoo(41차 수치와의 연속성)', pickPriceSource(undefined), 'yahoo')
  eq('명시하면 tiingo', pickPriceSource('tiingo'), 'tiingo')
  check('모르는 값은 조용히 기본값으로 넘어가지 않고 던진다', /알 수 없는 US_PRICE_SOURCE/.test(threw(() => pickPriceSource('bloomberg')) ?? ''))
  eq('두 소스 모두 비교 기준은 총수익(한 실행 안에서 일치)', compareBasisFor('tiingo'), 'total')
  check('출력 문구가 소스를 밝힌다', /tiingo/.test(compareBasisNote('total', 'tiingo')))
  check('야후 문구는 그대로', /야후/.test(compareBasisNote('total', 'yahoo')))

  eq('구간 규약 변환', rangeToStartDate('since:1999-01-01'), '1999-01-01')
  check('야후 전용 range 표기는 추측하지 않고 던진다', /since:/.test(threw(() => rangeToStartDate('max')) ?? ''))

  const t = newPriceTally()
  t.sourceOf['AAPL'] = 'tiingo'
  t.sourceOf['MSFT'] = 'tiingo'
  check('출처가 한 소스면 그대로 기록', /tiingo 2종목/.test(sourceMixLine(t)))
  t.sourceOf['SPY'] = 'yahoo'
  check('🔴 소스가 섞이면 경고한다(조용한 폴백 금지의 감시자)', /섞였다/.test(sourceMixLine(t)))

  check('[미검증] 목록이 코드에 남아 있다', TIINGO_UNVERIFIED.length >= 3)
  check('한도 수치가 [미검증]으로 남아 있다', TIINGO_UNVERIFIED.some((u) => /한도/.test(u)))

  // ═══════════════════════════════════════════════════════════════════════════
  section('⑧ 실측 유니버스 어댑터 — 갈래 1(수집기)과 갈래 2(시세)를 잇는 자리')
  //
  // 41차 재측정이 성립하려면 러너가 **실측 목록**을 그대로 받아야 한다.
  // 연도·전후반 경계는 사람이 적지 않고 **되감기 신뢰구간이 정한다.**

  const member = (t: string, added: string | null) => ({ ticker: t, name: `${t} Co`, addedOn: added })
  const yearRec = (y: number, tickers: string[]) => ({
    asOfDate: `${y}-01-01`,
    members: tickers.map((t) => member(t, '1990-01-01')),
    lateAdded: 0,
    lateAddedFixed: 0,
    lateAddedFixedSample: [],
    dateAddedKnown: tickers.length,
    addNotPresent: 0,
    removeAlreadyPresent: 0,
  })
  const TICKERS = ['AAA', 'BBB', 'CCC', 'DDD', 'EEE', 'FFF', 'GGG', 'HHH']
  const realRaw = buildUsPitRealUniverse({
    index: 'sp500',
    asOf: '2026-08-04',
    years: Object.fromEntries([2020, 2021, 2022, 2023, 2024, 2025, 2026].map((y) => [y, yearRec(y, TICKERS)])),
    missingYears: [],
    changesFirstDate: '2019-01-01',
    changeRows: 12,
    sizeBand: [7, 11],
    fixedRateMax: 0.05,
    fixedRateBasis: '합성 픽스처용 임계',
  })
  const realUni = realUniverseFrom(realRaw)
  eq('실측 유니버스는 [추정]이 아니다', realUni.estimated, false)
  eq('실행 연도는 신뢰구간이 정한다', realUni.years.join(','), '2020,2021,2022,2023,2024,2025,2026')
  check('전·후반 경계도 데이터가 정한다(사람이 적지 않는다)', realUni.halfYear > 2020 && realUni.halfYear < 2026)
  eq('그 해 구성종목을 그대로 준다', realUni.codesFor(2023).length, 8)
  check('출처 한 줄에 "순위 없음"이 박혀 있다', /순위 없음/.test(realUni.label))
  check('경고 문구가 [추정]에서 실측으로 바뀐다', /실측 유니버스/.test(estimateBanner(realUni)))
  eq('US_UNIVERSE=real 로만 켜진다', pickUniverse('real', () => realUni).key, 'real')
  check('기본값은 여전히 [추정] 80(41차 연속성)', pickUniverse(undefined).key === '80' && pickUniverse(undefined).estimated)
  check(
    '모르는 유니버스 키는 던지고 안내에 real이 들어 있다',
    /real/.test(threw(() => pickUniverse('crsp', () => realUni)) ?? ''),
  )
  check(
    '실측 파일이 없으면 [추정] 목록으로 조용히 내려가지 않고 던진다',
    /대신 돌리지 않습니다/.test(threw(() => loadRealUniverseFromDisk('/nonexistent-root-for-test')) ?? ''),
  )

  finish()
})()
