// 미국 시점 고정 유니버스 **상위 80**(US_PIT80) 검증.
//
// ⚠️ 미래참조 금지(규칙 1)와의 관계 — **새 엔진 경로가 없다**:
//   MODE=usxsmom80은 usxsmom과 **똑같은** runCustomChain/simulateXsMomYear를 부르고
//   유니버스(codesFor·union)만 갈아끼운다. 연쇄 인과성·절단 불변성은 이미
//   `tests/pitchain.test.ts`·`tests/idealab.test.ts`가 합성 시계열로 집행하고 있으며
//   유니버스 목록이 바뀐다고 그 성질이 달라지지 않는다. 여기서 중복 검증하지 않는다.
//   이 파일이 덮는 것은 **순수 데이터·순수 매핑**뿐이다.
//
// 여기서 지키는 것(이 순서가 곧 사고 예방 순서다):
//   ① 각 해 정확히 80종목·중복 없음        → 유니버스 크기가 조용히 79가 되지 않는다
//   ② 각 해 US_PIT20 ⊆ US_PIT80            → 상위 20 결과와의 연속성이 깨지지 않는다
//   ③ 전 티커가 US_COMPANY_NAMES에 등재     → "이 티커가 어느 회사였는지" 모르는 채 남지 않는다
//   ④ 차단 티커는 resolveUsTicker가 거부     → 재사용 티커로 인한 조용한 오염을 막는다
//   ⑤ 상장 이전 연도에 편입되지 않았다       → 규칙 1(미래참조 금지)의 데이터판
//   ⑥ 기존 상위 20 API가 그대로다            → MODE=uspit·usxsmom 동작 불변
//
// 네트워크를 타지 않는다(컨테이너에서 Yahoo는 403).

import { check, eq, section, finish } from './harness'
import { DECILE_SLOTS, US_UNI20, US_UNI80, buildYearlyUs } from '../scripts/idea-lab.entry'
import type { DailyBar } from '../src/features/backtest/types'
import {
  US_BLOCKED_TICKERS,
  US_COMPANY_NAMES,
  US_PIT20,
  US_PIT80,
  US_PIT80_SOURCE_NOTE,
  US_PIT80_TAIL,
  US_PIT80_UNION,
  US_PIT_UNION,
  US_PIT_YEARS,
  US_TICKER_RENAMES,
  resolveUsTicker,
  usFetchTicker,
  usPit80Codes,
  usPitCodes,
} from '../src/features/backtest/usPitUniverse'

// ── 1) 유니버스 무결성 ───────────────────────────────────────────────────────
{
  section('미국 PIT 유니버스 상위 80 — 무결성')

  eq('상위 80이 덮는 연도 수가 상위 20과 같다', Object.keys(US_PIT80).length, US_PIT_YEARS.length)
  check(
    '모든 해가 정확히 80종목',
    US_PIT_YEARS.every((y) => usPit80Codes(y).length === 80),
    US_PIT_YEARS.filter((y) => usPit80Codes(y).length !== 80)
      .map((y) => `${y}:${usPit80Codes(y).length}`)
      .join(',') || '전부 80',
  )
  check(
    '21~80위 꼬리가 모든 해 정확히 60종목',
    US_PIT_YEARS.every((y) => (US_PIT80_TAIL[y] ?? []).length === 60),
    US_PIT_YEARS.filter((y) => (US_PIT80_TAIL[y] ?? []).length !== 60).join(',') || '전부 60',
  )
  check(
    '한 해 안에 중복 티커가 없다',
    US_PIT_YEARS.every((y) => new Set(usPit80Codes(y)).size === 80),
    US_PIT_YEARS.filter((y) => new Set(usPit80Codes(y)).size !== 80).join(',') || '중복 없음',
  )

  // 🔴 조회 티커 기준 중복도 없어야 한다. 목록에는 다른 티커인데 사명 변경 매핑 후 같은
  //    심볼이 되면(SBC→T 가 그 해 T와 겹치는 식) 유니버스가 조용히 79종목이 된다.
  const collide = US_PIT_YEARS.filter((y) => {
    const res = usPit80Codes(y)
      .map(usFetchTicker)
      .filter((t): t is string => t != null)
    return new Set(res).size !== res.length
  })
  check('사명 변경 후에도 같은 해 안에서 심볼이 겹치지 않는다', collide.length === 0, collide.join(',') || 'ok')

  const allCodes = US_PIT_YEARS.flatMap((y) => usPit80Codes(y))
  const badFormat = [...new Set(allCodes)].filter((t) => !/^[A-Z]{1,5}(-[A-Z])?$/.test(t))
  check('모든 티커가 미국 형식(대문자 1~5자, 클래스는 하이픈)', badFormat.length === 0, badFormat.join(',') || 'ok')
  check('한국식 접미사(.KS/.KQ)가 섞이지 않았다', allCodes.every((t) => !/\./.test(t)))

  const missingName = [...new Set(allCodes)].filter((t) => !US_COMPANY_NAMES[t])
  check('모든 티커에 회사명이 달려 있다(티커 재사용 대비)', missingName.length === 0, missingName.join(',') || 'ok')

  check('[추정] 라벨이 출처 표기에 남아 있다(규칙 3)', US_PIT80_SOURCE_NOTE.includes('[추정]'))
  check(
    '출처 표기가 21~80위의 낮은 신뢰도를 명시한다(규칙 3)',
    US_PIT80_SOURCE_NOTE.includes('21~80') && US_PIT80_SOURCE_NOTE.includes('신뢰도'),
    US_PIT80_SOURCE_NOTE,
  )

  console.log(`  (참고) 상위 80 고유 티커 ${new Set(allCodes).size}개 · 조회 합집합 ${US_PIT80_UNION.length}개`)
}

// ── 2) 상위 20 ⊆ 상위 80 ─────────────────────────────────────────────────────
{
  section('상위 20이 상위 80의 부분집합인가 (연속성)')

  const broken = US_PIT_YEARS.filter((y) => {
    const wide = new Set(usPit80Codes(y))
    return !usPitCodes(y).every((t) => wide.has(t))
  })
  check('모든 해에서 US_PIT20 ⊆ US_PIT80', broken.length === 0, broken.join(',') || 'ok')

  // 순서까지 보존되는가 — 앞 20칸이 상위 20 그대로여야 "1~20위 유지"라고 말할 수 있다.
  const orderBroken = US_PIT_YEARS.filter((y) => usPit80Codes(y).slice(0, 20).join(',') !== usPitCodes(y).join(','))
  check('앞 20칸이 US_PIT20과 순서까지 동일', orderBroken.length === 0, orderBroken.join(',') || 'ok')

  // 꼬리에는 그 해 상위 20이 다시 나오면 안 된다(중복 검사와 별개로 의미를 못 박는다).
  const tailDup = US_PIT_YEARS.filter((y) => {
    const top = new Set(usPitCodes(y))
    return (US_PIT80_TAIL[y] ?? []).some((t) => top.has(t))
  })
  check('21~80위 꼬리에 그 해 상위 20이 섞이지 않았다', tailDup.length === 0, tailDup.join(',') || 'ok')
}

// ── 3) 차단·매핑 (재사용 티커 오염 방지) ─────────────────────────────────────
{
  section('상위 80 매핑 — 재사용 티커 차단')

  const hasAll = () => true

  // 🔴 핵심: 재사용이 확인된 티커는 **시세가 있어도** 거부한다.
  eq('WB(구 Wachovia)는 거부 — 현 Weibo', resolveUsTicker('WB', hasAll), undefined)
  eq('TX(구 Texaco)는 거부 — 현 Ternium', resolveUsTicker('TX', hasAll), undefined)
  eq('BUD(구 Anheuser-Busch)는 거부 — 현 AB InBev ADR', resolveUsTicker('BUD', hasAll), undefined)
  eq('SUNW(구 Sun Microsystems)는 거부 — 현 Sunworks', resolveUsTicker('SUNW', hasAll), undefined)
  // 재사용 여부가 불확실한 상폐 티커도 보수적으로 차단한다(오염보다 실패가 낫다).
  for (const t of ['ENE', 'LEH', 'BSC', 'MER', 'FNM', 'FRE', 'ONE', 'CA', 'EK', 'TWX', 'VIA', 'WLA', 'WYE', 'SGP'])
    eq(`상폐 티커 ${t}는 보수적 차단`, resolveUsTicker(t, hasAll), undefined)
  check('usFetchTicker도 차단 티커에 null을 준다', ['WB', 'TX', 'BUD', 'ENE', 'LEH'].every((t) => usFetchTicker(t) === null))

  // 사명 변경(회사 연속성 유지)은 반대로 **이어 써야** 한다.
  eq('HWP → HPQ', usFetchTicker('HWP'), 'HPQ')
  eq('MWD → MS', usFetchTicker('MWD'), 'MS')
  eq('WAG → WBA', usFetchTicker('WAG'), 'WBA')
  eq('KFT → MDLZ', usFetchTicker('KFT'), 'MDLZ')
  eq('UTX → RTX', usFetchTicker('UTX'), 'RTX')
  eq('RIMM → BB', usFetchTicker('RIMM'), 'BB')
  eq('BEL → VZ', usFetchTicker('BEL'), 'VZ')
  eq('CHV → CVX', usFetchTicker('CHV'), 'CVX')

  const renameTargetsMissing = Object.values(US_TICKER_RENAMES).filter((t) => !US_COMPANY_NAMES[t])
  check('사명 변경 대상 티커에도 회사명이 있다', renameTargetsMissing.length === 0, renameTargetsMissing.join(',') || 'ok')

  // 생존편향 처리 ① — 사라진 회사가 실제로 목록에 남아 있어야 한다.
  const allCodes = new Set(US_PIT_YEARS.flatMap((y) => usPit80Codes(y)))
  const dead = ['ENE', 'LEH', 'BSC', 'WB', 'MER', 'YHOO', 'CPQ', 'WLA', 'SUNW', 'TWX']
  const present = dead.filter((t) => allCodes.has(t))
  eq('상폐·피인수 종목이 목록에 그대로 있다', present.length, dead.length)
  console.log(`  (참고) 잔존 확인: ${present.join(', ')}`)
}

// ── 4) 조회용 합집합 ─────────────────────────────────────────────────────────
{
  section('상위 80 조회용 합집합(US_PIT80_UNION)')

  check('합집합에 중복이 없다', new Set(US_PIT80_UNION).size === US_PIT80_UNION.length)
  check(
    '합집합이 정렬돼 있다',
    US_PIT80_UNION.every((t, i) => i === 0 || US_PIT80_UNION[i - 1] <= t),
  )
  check(
    '합집합 원소가 전부 정규 티커(usFetchTicker 고정점)',
    US_PIT80_UNION.every((t) => usFetchTicker(t) === t),
    US_PIT80_UNION.filter((t) => usFetchTicker(t) !== t).join(',') || 'ok',
  )
  check(
    '재사용·차단 티커는 조회 목록에 들어가지 않는다',
    US_PIT80_UNION.every((t) => !US_BLOCKED_TICKERS.has(t)),
    US_PIT80_UNION.filter((t) => US_BLOCKED_TICKERS.has(t)).join(',') || 'ok',
  )

  const expected = new Set<string>()
  for (const y of US_PIT_YEARS)
    for (const t of usPit80Codes(y)) if (!US_BLOCKED_TICKERS.has(t)) expected.add(US_TICKER_RENAMES[t] ?? t)
  eq('합집합 크기가 기대와 일치', US_PIT80_UNION.length, expected.size)

  // 상위 20의 조회 목록은 상위 80 조회 목록에 그대로 포함돼야 한다.
  const missing20 = US_PIT_UNION.filter((t) => !US_PIT80_UNION.includes(t))
  check('상위 20 합집합 ⊆ 상위 80 합집합', missing20.length === 0, missing20.join(',') || 'ok')
  check('상위 80 합집합이 상위 20보다 넓다', US_PIT80_UNION.length > US_PIT_UNION.length, `${US_PIT_UNION.length} → ${US_PIT80_UNION.length}`)
}

// ── 5) 🔴 미래참조 금지의 데이터판 — 상장 이전 연도 편입 금지 ────────────────
// 유니버스 목록은 "그 시점의 투자자가 볼 수 있었던 것"이어야 한다. 2004년에 상장한
// 회사를 2001년 목록에 넣으면 그것만으로 백테스트가 미래를 본 것이 된다(규칙 1).
{
  section('상장·분사 이전 연도에 편입되지 않았다 (규칙 1)')

  // 티커 → 그 티커가 목록에 등장할 수 있는 **최초 연도**(= 상장 다음 해 목록).
  const firstAllowed: Record<string, number> = {
    GOOG: 2005, // 2004-08 상장
    MA: 2007, // 2006-05 상장
    V: 2009, // 2008-03 상장
    PM: 2009, // 2008-03 Altria 분사
    TSLA: 2011, // 2010-06 상장
    GM: 2011, // 2010-11 재상장(구 GM은 2009 파산)
    FB: 2013, // 2012-05 상장
    NOW: 2013, // 2012-06 상장
    ABBV: 2014, // 2013-01 Abbott 분사
    MDLZ: 2013, // 2012-10 Kraft Foods 개명
    PYPL: 2016, // 2015-07 eBay 분사
    META: 2023, // 2022-06 Facebook 개명
    PLTR: 2021, // 2020-09 상장
    UPS: 2000, // 1999-11 상장
    GS: 2000, // 1999-05 상장
    MET: 2001, // 2000-04 상장
    PRU: 2002, // 2001-12 상장
    ACN: 2002, // 2001-07 상장
    CRM: 2005, // 2004-06 상장
    AVGO: 2010, // 2009-08 상장(Avago)
  }
  const violations: string[] = []
  for (const y of US_PIT_YEARS)
    for (const t of usPit80Codes(y)) {
      const min = firstAllowed[t]
      if (min != null && y < min) violations.push(`${y}:${t}`)
    }
  check('상장·분사 이전 연도에 들어간 종목이 없다', violations.length === 0, violations.join(',') || 'ok')

  // 반대 방향도 확인한다 — 규칙을 지킨 대가로 그 종목이 아예 사라지면 목록이 부실한 것이다.
  eq('GOOG는 2005년 목록에 실제로 편입돼 있다', usPit80Codes(2005).includes('GOOG'), true)
  eq('FB는 2013년 목록에 실제로 편입돼 있다', usPit80Codes(2013).includes('FB'), true)
  eq('GM은 2011년 목록에 실제로 편입돼 있다', usPit80Codes(2011).includes('GM'), true)

  // 개명 전후가 같은 해에 함께 있으면 그 해 유니버스가 같은 회사를 두 번 담는다.
  const both = US_PIT_YEARS.filter((y) => {
    const s = new Set(usPit80Codes(y))
    return Object.entries(US_TICKER_RENAMES).some(([from, to]) => s.has(from) && s.has(to))
  })
  check('같은 해에 구 티커와 현 티커가 함께 있지 않다', both.length === 0, both.join(',') || 'ok')
}

// ── 6) 기존 상위 20 API 불변 (MODE=uspit·usxsmom 동작 보존) ──────────────────
{
  section('상위 20 API 불변 — 확장이 기존 모드를 건드리지 않았다')

  check('US_PIT20은 여전히 모든 해 20종목', US_PIT_YEARS.every((y) => usPitCodes(y).length === 20))
  check(
    '상위 20 목록에는 새로 차단된 티커가 하나도 없다(매핑률 불변)',
    US_PIT_YEARS.every((y) => usPitCodes(y).every((t) => !['WB', 'TX', 'BUD', 'ENE', 'LEH', 'BSC', 'MER', 'FNM', 'FRE', 'ONE', 'CA', 'EK', 'TWX', 'VIA', 'WLA', 'AHP', 'WYE', 'SGP', 'GTE', 'CPQ', 'MON', 'APC'].includes(t))),
  )
  check(
    '상위 20 목록 티커의 조회 매핑이 그대로다',
    US_PIT_YEARS.every((y) => usPitCodes(y).every((t) => usFetchTicker(t) === (US_BLOCKED_TICKERS.has(t) ? null : (US_TICKER_RENAMES[t] ?? t)))),
  )
  // 상위 20 합집합은 상위 20 목록만으로 재계산해도 같아야 한다(확장분이 새지 않았다).
  const expected20 = new Set<string>()
  for (const y of US_PIT_YEARS)
    for (const t of usPitCodes(y)) if (!US_BLOCKED_TICKERS.has(t)) expected20.add(US_TICKER_RENAMES[t] ?? t)
  eq('US_PIT_UNION 크기가 상위 20만으로 재계산한 값과 같다', US_PIT_UNION.length, expected20.size)
  check('US_PIT_UNION 원소가 상위 20 재계산 결과와 일치', US_PIT_UNION.every((t) => expected20.has(t)))
}

// ── 7) 러너 배선 — MODE=usxsmom80이 실제로 80을 쓰고 usxsmom은 그대로인가 ─────
// 유니버스를 파라미터로 뽑는 리팩토링을 했으므로, **기본값이 예전 그대로**이고
// 새 모드만 80을 본다는 것을 못 박는다(기존 MODE=usxsmom 결과 불변 근거).
{
  section('러너 배선 (US_UNI20 / US_UNI80 · buildYearlyUs)')

  eq('US_UNI20의 크기는 20', US_UNI20.size, 20)
  eq('US_UNI80의 크기는 80', US_UNI80.size, 80)
  eq('학계 분위 슬롯 = 80의 10%', DECILE_SLOTS, 8)
  check('US_UNI20은 상위 20 목록을 본다', US_UNI20.codesFor(2000).length === 20)
  check('US_UNI80은 상위 80 목록을 본다', US_UNI80.codesFor(2000).length === 80)
  check('US_UNI80의 조회 합집합이 상위 20보다 넓다', US_UNI80.union.length > US_UNI20.union.length)

  // 합성 시계열 — 네트워크를 타지 않는다. 2000년 목록 앞쪽 종목만 시세를 준다.
  const bars = (n: number): DailyBar[] =>
    Array.from({ length: n }, (_, i) => {
      const d = new Date(Date.parse('1999-01-04T00:00:00Z') + i * 86400000).toISOString().slice(0, 10)
      return { date: d, o: 100, h: 101, l: 99, c: 100, v: 1000 }
    })
  const hist: Record<string, DailyBar[]> = {}
  for (const t of ['MSFT', 'GE', 'CSCO', 'WMT', 'XOM', 'IBM', 'HWP'].map((t) => t)) hist[t] = bars(900)
  // HWP는 목록 티커이고 조회 심볼은 HPQ다 — 매핑을 거치는지 확인하려면 HPQ로 넣어야 한다.
  delete hist.HWP
  hist.HPQ = bars(900)

  const [slice20] = buildYearlyUs(hist, [2000])
  eq('기본 인자는 상위 20 그대로(분모 20)', slice20.mapped.split('/')[1], '20')

  const [slice80] = buildYearlyUs(hist, [2000], usPit80Codes)
  eq('상위 80을 넘기면 분모가 80', slice80.mapped.split('/')[1], '80')
  check('상위 80 슬라이스가 상위 20 슬라이스를 포함한다', slice20.syms.every((s) => slice80.syms.includes(s)), slice80.syms.join(','))
  check('꼬리 구간 종목도 사명 변경을 거쳐 편입된다(HWP→HPQ)', slice80.syms.includes('HPQ') && !slice20.syms.includes('HPQ'))
}

finish()
