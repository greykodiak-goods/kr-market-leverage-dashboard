// 34차 프리셋 재세팅 — **화면 유니버스가 KRX 실측으로 바뀌었는가**의 집행자.
//
// 이 파일이 지키는 것은 하나다: **[추정] 목록으로 조용히 내려가지 않는다.**
// 33차가 무너진 경로가 "틀린 목록([추정] PIT1010) 위에서 조용히 계속 도는 것"이었고,
// 폴백은 그 사고를 눈에 안 띄게 재발시키는 장치다. 그래서 로드 실패는 **에러여야** 하고,
// 화면 실행 경로에는 pitUniverse가 **import되어 있으면 안 된다**(연구 경로에는 남아 있다).
//
// 규칙 1(미래참조 금지)과의 관계: 여기서 검증하는 것은 유니버스 **목록 구성**과 사후 요약
// 산술뿐이다. 백테스트 인과성은 lookahead·pitchain·xsmomchain 테스트가 그대로 집행한다.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { check, close, eq, finish, section } from './harness'
import {
  DEFAULT_KRX_TOP_N,
  KRX_TOP_N_CHOICES,
  KRX_UNIVERSE_FROM,
  KRX_UNIVERSE_START_DATE,
  deriveKrxUniverse,
  loadKrxUniverse,
  normalizeTopN,
  type KrxUniverseResponse,
} from '../src/features/backtest/krxUniverseSource'
import { parseKrxPitUniverse } from '../src/features/backtest/krxPitUniverse'
import { loadKrxUniverseFile, wallStats } from '../scripts/preset-precompute.entry'
import { PRESETS } from '../src/features/backtest/presets'
import { PIT1010 } from '../src/features/backtest/pitUniverse'

const ROOT = process.env.REPO_ROOT ?? process.cwd()

// ---- 합성 유니버스 ----------------------------------------------------------
//
// 실측 파일과 **코드가 겹치지 않는** 합성 코드를 쓴다 — 겹치면 "진짜 파일을 읽은 것"과
// "합성을 읽은 것"을 구별할 수 없다.

/** `9xxxxx` 대역 합성 코드 — PIT1010([추정])과도, 실측 파일과도 겹치지 않게 잡았다. */
function syntheticUniverse(years: number[], perMarket = 40) {
  const mk = (prefix: number, y: number) =>
    Array.from({ length: perMarket }, (_, i) => ({
      code: String(prefix * 100000 + (y % 100) * 1000 + i).padStart(6, '0'),
      name: `합성${prefix}-${y}-${i + 1}`,
      rank: i + 1,
    }))
  const out: Record<string, { kospi: unknown[]; kosdaq: unknown[] }> = {}
  for (const y of years) out[String(y)] = { kospi: mk(8, y), kosdaq: mk(9, y) }
  return {
    source: 'KRX Open API',
    asOf: '2026-08-03',
    basis: '연초 첫 거래일 시총, 보통주만·스팩 제외',
    // 실측 파일과 같은 규약: Open API 이전(2006~2009)은 수집 불가로 명시한다.
    // 단 그 해가 실제로 들어 있으면 빼야 한다 — "missingYears에 있으면서 years에도 있다"는 파서가 거부한다.
    missingYears: [2006, 2007, 2008, 2009].filter((y) => !years.includes(y)),
    years: out,
  }
}

/** 가짜 fetch — 상태·본문을 마음대로 만든다. */
function fakeFetch(res: Partial<KrxUniverseResponse> & { body?: unknown; throws?: unknown }) {
  return async (): Promise<KrxUniverseResponse> => {
    if (res.throws) throw res.throws
    return {
      ok: res.ok ?? true,
      status: res.status ?? 200,
      json: async () => {
        if (res.json) return res.json()
        return res.body
      },
    }
  }
}

// 로드 실패 검증에 await가 필요한데 테스트 번들 형식이 CJS라 최상위 await를 쓸 수 없다.
// 그래서 전 구간을 async main으로 감싸고 마지막에 finish()를 부른다.
async function main(): Promise<void> {
  // ============================================================================
  section('① 유니버스 전환 — 화면 실행 경로가 KRX 실측 목록을 쓴다')
  // ============================================================================

  {
    const raw = syntheticUniverse([2010, 2011, 2012])
    const uni = parseKrxPitUniverse(raw)
    const d10 = deriveKrxUniverse(uni, 10)

    eq('연도는 2010부터', d10.years[0], 2010)
    eq('연도 수', d10.years.length, 3)
    eq('기본 폭은 10+10', DEFAULT_KRX_TOP_N, 10)
    eq('그 해 유니버스는 10+10 = 20종목', d10.codesFor(2010).length, 20)
    // 각 시장 상위 10만 잘라 쓴다 — 합성은 시장당 40개를 넣어 뒀으므로 절단이 실제로 일어난다
    eq('코스피 상위 10 절단', d10.codesFor(2010).filter((c) => c.startsWith('8')).length, 10)
    eq('코스닥 상위 10 절단', d10.codesFor(2010).filter((c) => c.startsWith('9')).length, 10)
    eq('합집합 = 3년 × 20종목(연도별 코드가 다르다)', d10.union.length, 60)

    // 화면에서 고른 코드가 **실측 목록에서 온 것**임을 확인한다([추정] 목록과 겹치지 않는다)
    const est = new Set(Object.values(PIT1010).flatMap((y) => [...y.ks, ...y.kq]))
    check('실측 코드가 [추정] 목록과 섞이지 않는다', d10.union.every((c) => !est.has(c)))

    // 폭 선택(10+10 / 40+40)이 실제로 목록을 바꾼다
    const d40 = deriveKrxUniverse(uni, 40)
    eq('40+40은 80종목', d40.codesFor(2010).length, 80)
    check('폭을 넓히면 합집합이 커진다', d40.union.length > d10.union.length)
    eq('폭 선택지는 10·40 둘뿐', KRX_TOP_N_CHOICES.join(','), '10,40')
    eq('임의 폭은 기본값으로 좁혀진다', normalizeTopN(7), DEFAULT_KRX_TOP_N)
    eq('저장본 없음도 기본값', normalizeTopN(undefined), DEFAULT_KRX_TOP_N)
    eq('허용 폭은 그대로', normalizeTopN(40), 40)

    // 라벨·출처 표기(규칙 3) — 화면에 [추정] 문구가 남아 있으면 안 된다
    check('라벨에 "KRX 실측" 표기', d10.label.includes('KRX 실측'))
    check('라벨에 상위 10+10 표기', d10.label.includes('10+10'))
    check('라벨에 구간 표기', d10.label.includes('2010'))
    check('라벨에 [추정] 문구 없음', !d10.label.includes('[추정]'))
    check('출처 표기에 수집 불가 연도 명시', d10.sourceNote.includes('2006'))

    eq('기본 시작일은 실측 첫 해', KRX_UNIVERSE_START_DATE, '2010-01-01')
    eq('실측 시작 연도 상수', KRX_UNIVERSE_FROM, 2010)

    // 2010년 이전 데이터가 섞여 들어오면 잘라낸다(수집 불가 구간을 조용히 쓰지 않는다)
    const withOld = parseKrxPitUniverse(syntheticUniverse([2005, 2006, 2007, 2008, 2009, 2010, 2011]))
    const dOld = deriveKrxUniverse(withOld, 10)
    eq('2010 이전은 실행 연도에서 제외', dOld.years[0], 2010)
    check('2005년 코드는 합집합에 없다', !dOld.union.some((c) => c.startsWith('805') || c.startsWith('905')))
  }

  // ============================================================================
  section('② [추정] 폴백 부재 — 로드 실패는 조용히 넘어가지 않고 던진다')
  // ============================================================================

  {
    const good = syntheticUniverse([2010, 2011])

    async function expectThrow(label: string, fn: () => Promise<unknown>, needle?: string) {
      let threw = false
      let msg = ''
      try {
        await fn()
      } catch (e) {
        threw = true
        msg = e instanceof Error ? e.message : String(e)
      }
      check(label, threw && (needle == null || msg.includes(needle)), threw ? `msg=${msg}` : '던지지 않았다')
    }

    await expectThrow('HTTP 404 → 던진다', () => loadKrxUniverse('/', fakeFetch({ ok: false, status: 404 })), 'HTTP 404')
    await expectThrow('네트워크 오류 → 던진다', () =>
      loadKrxUniverse('/', fakeFetch({ throws: new Error('offline') })),
    )
    await expectThrow('JSON 파싱 실패 → 던진다', () =>
      loadKrxUniverse('/', fakeFetch({ json: async () => { throw new Error('bad json') } })),
    )
    // 스키마 위반은 파서가 사유를 붙여 던진다 — 조용히 빈 유니버스로 넘어가지 않는다
    await expectThrow('스키마 위반(빈 years) → 던진다', () =>
      loadKrxUniverse('/', fakeFetch({ body: { ...good, years: {} } })), '스키마 위반')
    await expectThrow('스키마 위반(순위 빈틈) → 던진다', () =>
      loadKrxUniverse('/', fakeFetch({
        body: { ...good, years: { '2010': { kospi: [{ code: '800001', name: 'a', rank: 2 }], kosdaq: [{ code: '900001', name: 'b', rank: 1 }] } } },
      })), '스키마 위반')
    // 숨긴 결측 연도도 거부한다(2010·2012만 있고 2011이 없는데 missingYears에 없음)
    await expectThrow('숨긴 결측 연도 → 던진다', () => {
      const bad = syntheticUniverse([2010, 2012])
      return loadKrxUniverse('/', fakeFetch({ body: bad }))
    }, '결측을 숨기지 마라')

    // 성공 경로는 그대로 파싱된다(에러만 던지는 게 아니라는 대조군)
    const ok = await loadKrxUniverse('/base/', fakeFetch({ body: good }))
    eq('정상 응답은 파싱된다', Object.keys(ok.years).sort().join(','), '2010,2011')

    // 2010년 이후 데이터가 아예 없으면 파생 단계에서 던진다(빈 유니버스로 돌지 않는다)
    let derThrew = false
    try {
      deriveKrxUniverse(parseKrxPitUniverse(syntheticUniverse([2001, 2002])), 10)
    } catch {
      derThrew = true
    }
    check('2010 이후 데이터 없음 → 파생이 던진다', derThrew)

    // ---- 소스 수준 — 화면이 [추정] 목록을 import하지 못하게 못 박는다 ----
    const sim = readFileSync(join(ROOT, 'src', 'features', 'backtest', 'SpecSimulator.tsx'), 'utf8')
    check('SpecSimulator는 pitUniverse를 import하지 않는다', !/from\s+'\.\/pitUniverse'/.test(sim))
    check('SpecSimulator는 krxUniverseSource를 import한다', /from\s+'\.\/krxUniverseSource'/.test(sim))
    check('SpecSimulator에 PIT_UNION·pitCodes 사용이 없다', !/\bPIT_UNION\b|\bpitCodes\b/.test(sim))
    check('화면 유니버스 라벨에 "[추정] 목록" 배지가 없다', !sim.includes('[추정] 목록 · KRX 실측 아님'))

    const pre = readFileSync(join(ROOT, 'scripts', 'preset-precompute.entry.ts'), 'utf8')
    check('사전계산도 pitUniverse를 import하지 않는다', !/from\s+'\.\.\/src\/features\/backtest\/pitUniverse'/.test(pre))

    // 연구 경로는 **그대로 남아 있어야 한다**(삭제가 아니라 분리다 — 골든 재현용)
    check('pitUniverse(PIT1010)는 삭제되지 않았다', Object.keys(PIT1010).length > 20)
  }

  // ============================================================================
  section('③ 프리셋 정의 — 34차 판정 통과 2종')
  // ============================================================================

  {
    eq('프리셋 2종', PRESETS.length, 2)
    for (const p of PRESETS) {
      check(`${p.id}: 모멘텀 계열`, p.kind === 'momentum')
      check(`${p.id}: 게이트 on`, p.kind === 'momentum' && p.mom.gate === true)
      check(`${p.id}: id가 krx- 접두(실측 기반 표시)`, p.id.startsWith('krx-'))
      check(`${p.id}: 라벨에 KRX 실측 표기`, p.label.includes('KRX 실측'))
      check(`${p.id}: 라벨에 34차 표기`, p.label.includes('34차'))
    }
    const slots = PRESETS.map((p) => (p.kind === 'momentum' ? p.mom.slots : 0)).sort()
    eq('슬롯은 3·5', slots.join(','), '3,5')
  }

  // ============================================================================
  section('④ 사전계산 — 실측 유니버스 파일을 직접 읽고 벽을 다시 잰다')
  // ============================================================================

  {
    // 리포에 실제로 들어 있는 실측 파일을 읽는다(합성이 아니다) — 굽는 쪽 경로 전체 검증
    const u = loadKrxUniverseFile(ROOT)
    eq('사전계산 유니버스도 2010부터', u.years[0], KRX_UNIVERSE_FROM)
    eq('사전계산 기본 폭은 10+10', u.topN, DEFAULT_KRX_TOP_N)
    check('실행 연도가 17년 안팎', u.years.length >= 15, `${u.years.length}년`)
    check('연도에 빈틈이 없다', u.years.every((y, i) => i === 0 || y === u.years[i - 1] + 1))
    check('그 해 유니버스는 최대 20종목', u.years.every((y) => u.codesFor(y).length <= 20))
    check('합집합이 비어 있지 않다', u.union.length > 20)
    check('라벨에 KRX 실측', u.label.includes('KRX 실측'))

    // 못 읽으면 **던진다** — [추정]으로 대신 굽지 않는다
    let threw = false
    let msg = ''
    try {
      loadKrxUniverseFile(join(ROOT, 'no-such-dir'))
    } catch (e) {
      threw = true
      msg = e instanceof Error ? e.message : String(e)
    }
    check('파일 없음 → 사전계산이 던진다', threw && msg.includes('[추정] 목록으로 대신 굽지 않습니다'), msg)

    // ---- 벽 산술 — 옮겨 적지 않고 구간을 잘라 다시 잰다 ----
    // 100 → 200 (2배)로 오르되 중간에 200 → 100 (−50%)을 겪는 곡선.
    const curve = [
      { date: '2010-01-04', equity: 100 },
      { date: '2013-01-04', equity: 200 },
      { date: '2016-01-04', equity: 100 },
      { date: '2020-01-06', equity: 300 },
    ]
    const w = wallStats('qqqKrw', 'QQQ 원화 보유', curve, '2010-01-01', '2020-12-31')
    check('벽 계산됨', w != null)
    eq('벽 종류', w?.kind, 'qqqKrw')
    eq('벽 구간 시작', w?.startDate, '2010-01-04')
    eq('벽 구간 끝', w?.endDate, '2020-01-06')
    close('벽 MDD = 200→100 = −50%', w?.mddPct as number, -50, 1e-9)
    close('벽 칼마 = CAGR ÷ |MDD|', w?.calmar as number, (w?.cagrPct as number) / 50, 1e-12)

    // 구간을 자르면 **수치가 달라진다**(옮겨 적은 값이 아니라는 증거)
    const cut = wallStats('qqqKrw', 'QQQ 원화 보유', curve, '2010-01-01', '2013-12-31')
    eq('자른 구간의 끝', cut?.endDate, '2013-01-04')
    close('자른 구간엔 낙폭이 없다', cut?.mddPct as number, 0, 1e-9)
    check('낙폭 0이면 칼마는 0으로 둔다(무한대 금지)', cut?.calmar === 0)

    // 구간과 겹치지 않으면 null — 없는 값을 0으로 채우지 않는다(규칙 3)
    eq('겹치지 않는 구간 → null', wallStats('qqqKrw', 'x', curve, '2030-01-01', '2031-01-01'), null)
    eq('점 1개 → null', wallStats('qqqKrw', 'x', curve, '2010-01-01', '2010-06-01'), null)
  }

  finish()
}

main().catch((e) => {
  console.error('테스트 실행 실패:', e)
  process.exit(1)
})
