// KRX **실측** 시점 고정 유니버스 — 스키마 파서 + 유니버스 주입 경로 검증.
//
// 이 파일이 막는 사고는 두 가지다.
//
//   ① **틀린 유니버스 파일이 조용히 통과하는 것.** `public/data/krx-pit/universe.json`은
//      EC2에서 수집돼 리포에 커밋되고, GHA는 그것을 그대로 믿고 백테스트를 돌린다.
//      연도가 하나 빠졌거나 같은 종목이 두 번 들어 있으면 유니버스가 조용히 79종목·
//      16년이 되고, 그렇게 나온 표는 다른 표와 비교가 성립하지 않는다. 파서가 던져야 한다.
//   ② **유니버스 주입이 pitChain 규약을 벗어나는 것.** MODE=krxpit은 `buildYearly`의
//      `codesFor`만 갈아끼운다 — 편입 판정(그 해 6/30 이전 상장)·연말 절단·매핑률은
//      주입과 무관하게 같아야 한다. 실측 팔과 [추정] 팔이 다른 규약을 타면 두 표의 차이가
//      "목록 차이"가 아니라 "규약 차이"가 되어 비교 A의 결론이 통째로 거짓이 된다.
//
// ⚠️ 미래참조 금지(규칙 1)와의 관계 — **새 엔진 경로가 없다.** krxpit은 기존
//    runSpecChain/runCustomChain/simulateXsMomYear를 그대로 부르고 유니버스만 바꾼다.
//    연쇄 인과성·절단 불변성은 `tests/pitchain.test.ts`·`tests/idealab.test.ts`가 이미
//    집행한다. 여기서는 **주입 경로에서도** 그 성질이 유지되는지만 한 번 더 확인한다.
//
// 네트워크를 타지 않는다(컨테이너에서 Yahoo는 403).

import { check, eq, section, finish, rng } from './harness'
import {
  KRX_PIT_BASIS,
  KRX_PIT_SOURCE,
  buildKrxPitUniverse,
  krxPitCodes,
  krxPitMarketCodes,
  krxPitNames,
  krxPitSourceNote,
  krxPitSpan,
  krxPitUnion,
  krxPitYears,
  parseKrxPitUniverse,
} from '../src/features/backtest/krxPitUniverse'
import {
  PIT1010,
  baselineSpec,
  benchCurve,
  buildYearly,
  pit1010Codes,
  runSpecChain,
  runWinner3,
  universeDiffTable,
  widthDiffTable,
} from '../scripts/idea-lab.entry'
import type { CostSettings } from '../src/features/backtest/conditionScreen'
import type { DailyBar } from '../src/features/backtest/types'

const COST: CostSettings = { initialCapital: 10_000_000, feePct: 0.015, taxPct: 0.15, slippagePct: 0.1 }

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
  check(name, must === '' || msg.includes(must), `메시지에 "${must}"가 없다 — ${msg}`)
}

const entry = (code: string, name: string, rank: number) => ({ code, name, rank })

/** 정상 파일 한 장 — 연도 2개 × (코스피 3 + 코스닥 3). */
function sampleRaw() {
  return {
    source: KRX_PIT_SOURCE,
    asOf: '2026-08-03',
    basis: KRX_PIT_BASIS,
    missingYears: [2008, 2009],
    years: {
      '2010': {
        kospi: [entry('005930', '삼성전자', 1), entry('005490', 'POSCO', 2), entry('005380', '현대차', 3)],
        kosdaq: [entry('068270', '셀트리온', 1), entry('035720', '다음', 2), entry('046890', '서울반도체', 3)],
      },
      '2011': {
        kospi: [entry('005930', '삼성전자', 1), entry('005380', '현대차', 2), entry('012330', '현대모비스', 3)],
        kosdaq: [entry('068270', '셀트리온', 1), entry('035720', '다음', 2), entry('026960', '동서', 3)],
      },
    },
  }
}

// ── 1) 스키마 파서 — 정상 파일 ────────────────────────────────────────────────
{
  section('1) universe.json 스키마 파서 — 정상 파일과 접근자')

  const u = parseKrxPitUniverse(sampleRaw())
  eq('source가 KRX Open API', u.source, KRX_PIT_SOURCE)
  eq('asOf가 그대로 읽힌다', u.asOf, '2026-08-03')
  eq('basis가 그대로 읽힌다', u.basis, KRX_PIT_BASIS)
  eq('missingYears가 읽힌다', u.missingYears.join(','), '2008,2009')
  eq('덮는 연도가 오름차순', krxPitYears(u).join(','), '2010,2011')

  eq('시장별 상위 2 (코스피)', krxPitMarketCodes(u, 2010, 'kospi', 2).join(','), '005930,005490')
  eq('시장별 상위 2 (코스닥)', krxPitMarketCodes(u, 2010, 'kosdaq', 2).join(','), '068270,035720')
  eq('topN=2면 각 시장 상위 2의 합(코스피 먼저)', krxPitCodes(u, 2010, 2).join(','), '005930,005490,068270,035720')
  eq('topN이 목록보다 크면 있는 만큼만', krxPitCodes(u, 2010, 40).length, 6)
  eq('목록에 없는 해는 빈 배열', krxPitCodes(u, 2009, 10).length, 0)
  eq(
    '합집합은 중복 제거·정렬',
    krxPitUnion(u, 40).join(','),
    '005380,005490,005930,012330,026960,035720,046890,068270',
  )
  eq('코드→이름 매핑', krxPitNames(u)['012330'], '현대모비스')
  check('출처 한 줄에 구간·수집일이 들어간다', krxPitSourceNote(u).includes('2010~2011') && krxPitSourceNote(u).includes('2026-08-03'))

  eq('구간 요청이 다 덮이면 그 연도들', krxPitSpan(u, 2010, 2011).join(','), '2010,2011')
  throws('덮이지 않는 구간을 요청하면 던진다', () => krxPitSpan(u, 2010, 2013), '2012, 2013')
}

// ── 2) 스키마 파서 — 거부해야 하는 파일 ───────────────────────────────────────
{
  section('2) universe.json 스키마 파서 — 결측 연도·중복 코드 거부')

  // 결측 연도: 2010·2012는 있는데 2011이 없고 missingYears에도 없다
  throws(
    '덮는 구간 안의 결측 연도를 거부한다',
    () => {
      const raw = sampleRaw()
      raw.years['2012'] = raw.years['2011']
      delete (raw.years as Record<string, unknown>)['2011']
      return parseKrxPitUniverse(raw)
    },
    '2011년이 빠졌는데',
  )
  check(
    '결측을 missingYears에 명시하면 통과한다',
    (() => {
      const raw = sampleRaw()
      raw.years['2012'] = raw.years['2011']
      delete (raw.years as Record<string, unknown>)['2011']
      raw.missingYears = [2008, 2009, 2011]
      return krxPitYears(parseKrxPitUniverse(raw)).join(',') === '2010,2012'
    })(),
  )
  throws(
    'missingYears와 years에 동시에 있으면 거부한다',
    () => {
      const raw = sampleRaw()
      raw.missingYears = [2010]
      return parseKrxPitUniverse(raw)
    },
    'missingYears에 있으면서',
  )

  throws(
    '한 시장 안의 중복 코드를 거부한다',
    () => {
      const raw = sampleRaw()
      raw.years['2010'].kospi[2] = entry('005930', '삼성전자', 3)
      return parseKrxPitUniverse(raw)
    },
    '중복 종목코드 005930',
  )
  throws(
    '코스피↔코스닥 사이의 중복 코드도 거부한다',
    () => {
      const raw = sampleRaw()
      raw.years['2011'].kosdaq[2] = entry('005930', '삼성전자', 3)
      return parseKrxPitUniverse(raw)
    },
    '중복 종목코드 005930',
  )

  throws(
    '순위에 빈틈이 있으면 거부한다',
    () => {
      const raw = sampleRaw()
      raw.years['2010'].kospi[2] = entry('012330', '현대모비스', 4)
      return parseKrxPitUniverse(raw)
    },
    '순위에 빈틈',
  )
  throws(
    '6자리가 아닌 코드를 거부한다',
    () => {
      const raw = sampleRaw()
      raw.years['2010'].kospi[0] = entry('5930', '삼성전자', 1)
      return parseKrxPitUniverse(raw)
    },
    '6자리 종목코드가 아니다',
  )
  throws(
    '이름이 비면 거부한다',
    () => {
      const raw = sampleRaw()
      raw.years['2010'].kosdaq[0] = entry('068270', '  ', 1)
      return parseKrxPitUniverse(raw)
    },
    'name이 비어 있다',
  )
  throws(
    'asOf 형식이 틀리면 거부한다',
    () => parseKrxPitUniverse({ ...sampleRaw(), asOf: '2026/08/03' }),
    'asOf가 YYYY-MM-DD가 아니다',
  )
  throws('빈 시장 배열을 거부한다', () => {
    const raw = sampleRaw()
    raw.years['2010'].kosdaq = []
    return parseKrxPitUniverse(raw)
  }, '비어 있다')
  throws('years가 비면 거부한다', () => parseKrxPitUniverse({ ...sampleRaw(), years: {} }), 'years가 비어 있다')
}

// ── 3) 쓰는 쪽(pityear) 조립기 ────────────────────────────────────────────────
{
  section('3) buildKrxPitUniverse — 수집 결과 조립 + 자기검증')

  const lists = {
    2011: {
      ks: [{ code: '005930', name: '삼성전자' }, { code: '005380', name: '현대차' }],
      kq: [{ code: '068270', name: '셀트리온' }],
    },
    2010: {
      ks: [{ code: '005930', name: '삼성전자' }, { code: '005490', name: 'POSCO' }],
      kq: [{ code: '035720', name: '다음' }],
    },
  }
  const u = buildKrxPitUniverse(lists, { asOf: '2026-08-03', missingYears: [2009, 2006] })
  eq('연도가 오름차순으로 들어간다', krxPitYears(u).join(','), '2010,2011')
  eq('순위는 수집 순서대로 1부터', u.years['2010'].kospi.map((e) => e.rank).join(','), '1,2')
  eq('missingYears는 정렬된다', u.missingYears.join(','), '2006,2009')
  eq('기본 source', u.source, KRX_PIT_SOURCE)
  eq('기본 basis', u.basis, KRX_PIT_BASIS)
  throws(
    '수집 결과에 중복이 있으면 조립 단계에서 던진다(파일로 나가기 전에)',
    () =>
      buildKrxPitUniverse(
        { 2010: { ks: [{ code: '005930', name: '삼성전자' }], kq: [{ code: '005930', name: '삼성전자' }] } },
        { asOf: '2026-08-03', missingYears: [] },
      ),
    '중복 종목코드',
  )
}

/** 합성 일봉 — 주말을 건너뛴 거래일 근사(엔진은 달력을 데이터에서 만든다). */
function makeBars(seed: number, from: string, toYear: number, base = 50_000): DailyBar[] {
  const rnd = rng(seed)
  const bars: DailyBar[] = []
  let p = base
  const start = Date.parse(`${from}T00:00:00Z`)
  const end = Date.UTC(toYear + 1, 0, 1)
  for (let t = start; t < end; t += 86400000) {
    const d = new Date(t)
    const dow = d.getUTCDay()
    if (dow === 0 || dow === 6) continue
    const ret = 0.0005 + 0.025 * (rnd() * 2 - 1)
    const o = p
    const c = Math.max(1, p * (1 + ret))
    bars.push({
      date: d.toISOString().slice(0, 10),
      t: Math.floor(t / 1000),
      o,
      h: Math.max(o, c) * (1 + rnd() * 0.012),
      l: Math.min(o, c) * (1 - rnd() * 0.012),
      c,
      v: 400_000 + Math.floor(rnd() * 2_000_000),
    })
    p = c
  }
  return bars
}

// ── 4) 유니버스 주입이 pitChain 규약을 그대로 타는가 (합성 데이터) ──────────────
{
  section('4) buildYearly 유니버스 주입 — 6/30 편입 판정·연말 절단·매핑률')

  // 코드 8개: 6개는 처음부터, 1개는 그 해 6/30 **이후** 상장(=편입 금지), 1개는 6/30 직전 상장.
  const EARLY = ['100010', '100020', '100030', '100040', '100050', '100060']
  const LATE = '100070' // 2011-07-01 상장 → 2011년 편입 금지, 2012년부터 편입
  const JUST = '100080' // 2011-06-29 상장 → 2011년 편입 가능
  const HISTORIES: Record<string, DailyBar[]> = {}
  EARLY.forEach((cd, i) => {
    HISTORIES[cd] = makeBars(20260803 + i * 41, '2009-01-01', 2013, 20_000 + i * 3_000)
  })
  HISTORIES[LATE] = makeBars(555, '2011-07-01', 2013, 30_000)
  HISTORIES[JUST] = makeBars(556, '2011-06-29', 2013, 31_000)

  const YEARS = [2011, 2012, 2013]
  const injected = (y: number) => (y === 2011 ? [...EARLY, LATE, JUST] : [...EARLY, LATE])
  const yearly = buildYearly(HISTORIES, YEARS, injected)

  const y2011 = yearly[0]
  check('6/30 이후 상장 종목은 그 해 유니버스에 안 들어간다', !y2011.syms.includes(LATE), y2011.syms.join(','))
  check('6/30 직전 상장 종목은 그 해 유니버스에 들어간다', y2011.syms.includes(JUST))
  eq('매핑률 분모는 주입 목록 길이', y2011.mapped, `${y2011.syms.length}/8`)
  eq('다음 해에는 늦은 상장 종목도 편입된다', yearly[1].syms.includes(LATE), true)

  const lastBar = (bars: DailyBar[]) => bars[bars.length - 1].date
  check(
    '연도 슬라이스의 시계열은 그 해 12/31까지로 잘린다',
    y2011.syms.every((s) => lastBar(y2011.hist[s]) <= '2011-12-31'),
  )
  check(
    '연도 슬라이스는 상장 이후 전 구간을 그대로 들고 있다(지표 워밍업 보존)',
    y2011.hist[EARLY[0]][0].date < '2010-01-01',
    y2011.hist[EARLY[0]][0].date,
  )

  // 기본 codesFor는 손대지 않았다 — 기존 모드 출력이 바뀌면 안 된다.
  eq('codesFor 기본값은 PIT1010 10+10', pit1010Codes(2020).join(','), [...PIT1010[2020].ks, ...PIT1010[2020].kq].join(','))
  const defaultYearly = buildYearly(HISTORIES, [2020])
  eq('인자를 안 주면 PIT1010을 본다(합성 코드와 안 겹쳐 0종목)', defaultYearly[0].mapped, '0/20')

  // 주입 경로도 같은 연쇄 엔진을 탄다 — 그 해 유니버스 밖 종목이 체결되면 안 된다.
  const chain = runSpecChain(yearly, baselineSpec, COST)
  eq('연쇄가 연도 수만큼 행을 만든다', chain.perYear.length, YEARS.length)
  check('자산곡선이 비어 있지 않다', chain.equity.length > 100, `${chain.equity.length}점`)

  // 유니버스를 좁히면(상위 5만) 결과가 실제로 달라져야 한다 — 주입이 먹히는지의 반증.
  const narrow = buildYearly(HISTORIES, YEARS, () => EARLY.slice(0, 5))
  const narrowChain = runSpecChain(narrow, baselineSpec, COST)
  check(
    '유니버스를 갈아끼우면 연쇄 결과가 달라진다(주입이 실제로 먹힌다)',
    JSON.stringify(narrowChain.perYear) !== JSON.stringify(chain.perYear),
  )

  // 절단 불변성(규칙 1) — 뒷연도를 통째로 잘라도 앞 연도 자산곡선이 그대로여야 한다.
  const CUT = '2012-12-31'
  const truncated: Record<string, DailyBar[]> = {}
  for (const [s, bars] of Object.entries(HISTORIES)) truncated[s] = bars.filter((b) => b.date <= CUT)
  const cutChain = runSpecChain(buildYearly(truncated, [2011, 2012], injected), baselineSpec, COST)
  const head = chain.equity.filter((p) => p.date <= CUT)
  check(
    '절단 전 구간의 자산곡선이 완전히 동일하다 (미래참조 없음)',
    head.length === cutChain.equity.length &&
      head.every((p, i) => p.date === cutChain.equity[i].date && Object.is(p.equity, cutChain.equity[i].equity)),
    `${head.length} vs ${cutChain.equity.length}`,
  )
}

// ── 5) 실측 목록 주입이 topN 규약대로 잘리는가 ────────────────────────────────
{
  section('5) 실측 목록 주입 — topN이 각 시장 상위 N을 자른다')

  const mk = (n: number, prefix: string) =>
    Array.from({ length: n }, (_, i) => entry(`${prefix}${String(i).padStart(3, '0')}`, `종목${prefix}${i}`, i + 1))
  const u = parseKrxPitUniverse({
    source: KRX_PIT_SOURCE,
    asOf: '2026-08-03',
    basis: KRX_PIT_BASIS,
    missingYears: [],
    years: { '2015': { kospi: mk(40, '100'), kosdaq: mk(40, '200') } },
  })
  eq('40+40이면 80종목', krxPitCodes(u, 2015, 40).length, 80)
  eq('10+10이면 20종목', krxPitCodes(u, 2015, 10).length, 20)
  check(
    '10+10은 40+40의 부분집합이다(같은 랭킹에서 잘라 쓴다)',
    krxPitCodes(u, 2015, 10).every((cd) => krxPitCodes(u, 2015, 40).includes(cd)),
  )
  eq('10+10의 앞 10개는 코스피 상위 10', krxPitCodes(u, 2015, 10).slice(0, 10).join(','), mk(10, '100').map((e) => e.code).join(','))
}

// ── 6) 승자 3종 러너 · 비교표 (합성 데이터) ───────────────────────────────────
{
  section('6) runWinner3 · 비교표 — 행 구성과 차이 산술')

  const CODES = ['300010', '300020', '300030', '300040', '300050', '300060', '300070']
  const H: Record<string, DailyBar[]> = {}
  CODES.forEach((cd, i) => {
    H[cd] = makeBars(31415 + i * 97, '2009-01-01', 2012, 25_000 + i * 2_000)
  })
  const BENCH_BARS = makeBars(2718, '2009-01-01', 2012, 30_000)
  const benchEq = benchCurve(BENCH_BARS)
  const YEARS = [2011, 2012]

  const wide = buildYearly(H, YEARS, () => CODES)
  const narrow = buildYearly(H, YEARS, () => CODES.slice(0, 5))
  const rowsWide = runWinner3(wide, benchEq, YEARS, [3])
  const rowsNarrow = runWinner3(narrow, benchEq, YEARS)

  eq('승자 3종 + 분위 보정 1행 = 4행', rowsWide.length, 4)
  eq('승자 3종만이면 3행', rowsNarrow.length, 3)
  check('①은 기준선', rowsWide[0].label.startsWith('① '), rowsWide[0].label)
  check('②는 XSM 상위5+게이트', rowsWide[1].label.includes('상위5+게이트'), rowsWide[1].label)
  check('②′는 분위 보정 행', rowsWide[2].label.includes('[10% 분위]'), rowsWide[2].label)
  check('③은 결합 50:50', rowsWide[3].label.startsWith('③ '), rowsWide[3].label)
  eq('결합 행은 매매 원장이 없다(곡선 합성)', rowsWide[3].closed, 0)
  check('전 행의 CAGR이 유한하다', rowsWide.every((r) => Number.isFinite(r.full.cagr)))
  check(
    '결합 성적은 두 단독 사이 어딘가에 있다(월 리밸런스 합성)',
    rowsWide[3].full.cagr >= Math.min(rowsWide[0].full.cagr, rowsWide[1].full.cagr) - 1e-6 &&
      rowsWide[3].full.cagr <= Math.max(rowsWide[0].full.cagr, rowsWide[1].full.cagr) + 1e-6,
    `${rowsWide[3].full.cagr} vs [${rowsWide[0].full.cagr}, ${rowsWide[1].full.cagr}]`,
  )
  check('연도별 분해가 연도 수만큼 있다', rowsWide.every((r) => r.perYear.length === YEARS.length))

  /** 표 출력을 가로채 문자열로 받는다 — 표가 던지지 않는지, 산술이 맞는지 본다. */
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

  /** 라벨 칸을 뺀 나머지 숫자 칸이 전부 0인가 — 차이 표의 산술 검증. */
  const dataRows = (lines: string[]) => lines.filter((l) => /^\| [①②③]/.test(l))
  const allZero = (line: string) =>
    line
      .split('|')
      .slice(2, -1)
      .every((cell) => {
        const v = Number(cell.replace(/[%p\s+]/g, ''))
        return cell.trim() === '—' || (Number.isFinite(v) && Math.abs(v) < 1e-9)
      })

  const same = capture(() => universeDiffTable(rowsWide, rowsWide))
  check('비교 A 표가 전략 행을 모두 찍는다', rowsWide.every((r) => same.some((l) => l.startsWith(`| ${r.label} |`))))
  eq('비교 A 표의 데이터 행 수 = 전략 수', dataRows(same).length, rowsWide.length)
  check(
    '같은 표를 두 번 넣으면 모든 차이가 0이다(산술 검증)',
    dataRows(same).every(allZero),
    dataRows(same).find((l) => !allZero(l)) ?? '',
  )

  // 폭 비교 표는 **절대값 열과 차이 열이 섞여 있다** — 차이 열(4번째·7번째)만 0인지 본다.
  const zeroCell = (line: string, i: number) => Math.abs(Number(line.split('|')[i].replace(/[%p\s+]/g, ''))) < 1e-9
  const width = capture(() => widthDiffTable(rowsWide, rowsWide))
  check(
    '폭 비교 표도 자기 자신과는 차이 열이 0',
    dataRows(width).every((l) => zeroCell(l, 4) && zeroCell(l, 7)),
    dataRows(width).join(' / '),
  )

  const widthReal = capture(() => widthDiffTable(rowsNarrow, rowsWide))
  eq('짝이 있는 행만 찍는다(②′는 짝이 없어 빠진다)', dataRows(widthReal).length, rowsNarrow.length)
  check('②′ 행은 폭 비교 표에 없다', !widthReal.some((l) => l.includes('[10% 분위]')), widthReal.join(' / '))
  check(
    '폭이 다르면 CAGR 차가 실제로 0이 아니다',
    dataRows(widthReal).some((l) => !zeroCell(l, 4)),
    dataRows(widthReal).join(' / '),
  )
}

finish()
