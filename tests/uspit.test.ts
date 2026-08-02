// 미국 시점 고정 유니버스(usPitUniverse) + 거래소 현지 날짜 변환 검증.
//
// ⚠️ 미래참조 금지(규칙 1)와의 관계 — **새 엔진 경로가 없다**:
//   MODE=uspit은 KR과 **똑같은 runPitChained**를 부르고 resolve/codesFor/bench/years만
//   갈아끼운다. 연쇄 인과성·절단 불변성(뒷연도를 잘라내도 앞 연도 매매·자산곡선 동일)은
//   이미 `tests/pitchain.test.ts`가 집행하고 있으며, 그 테스트는 시장과 무관한 합성
//   시계열로 돌기 때문에 미국 유니버스에도 그대로 유효하다. 여기서 중복 검증하지 않는다.
//   → 엔진(engine.ts·algoEngine.ts·series.ts·pitChain.ts)을 고치면 그쪽 테스트가 집행자다.
//   이 파일이 덮는 것은 **순수 데이터·순수 매핑·순수 날짜 변환**뿐이다.
//
// 네트워크를 타지 않는다(컨테이너에서 Yahoo는 403).

import { check, eq, section, finish } from './harness'
import {
  US_BLOCKED_TICKERS,
  US_COMPANY_NAMES,
  US_PIT20,
  US_PIT_SOURCE_NOTE,
  US_PIT_UNION,
  US_PIT_YEARS,
  US_TICKER_RENAMES,
  exchangeLocalDate,
  fallbackGmtOffset,
  resolveUsTicker,
  usFetchTicker,
  usPitCodes,
} from '../src/features/backtest/usPitUniverse'

// ── 1) 유니버스 무결성 ───────────────────────────────────────────────────────
{
  section('미국 PIT 유니버스 무결성')

  check('연도가 2000~2026', US_PIT_YEARS[0] === 2000 && US_PIT_YEARS[US_PIT_YEARS.length - 1] === 2026)
  check('연도 사이에 빠진 해가 없다', US_PIT_YEARS.every((y, i) => i === 0 || y === US_PIT_YEARS[i - 1] + 1))
  eq('연도 수 27', US_PIT_YEARS.length, 27)

  check(
    '모든 해가 정확히 20종목',
    US_PIT_YEARS.every((y) => usPitCodes(y).length === 20),
    US_PIT_YEARS.filter((y) => usPitCodes(y).length !== 20).join(',') || '전부 20',
  )
  check(
    '한 해 안에 중복 티커가 없다',
    US_PIT_YEARS.every((y) => new Set(usPitCodes(y)).size === usPitCodes(y).length),
    US_PIT_YEARS.filter((y) => new Set(usPitCodes(y)).size !== usPitCodes(y).length).join(',') || '중복 없음',
  )
  // 미국 티커: 대문자 1~5자, 클래스 구분만 하이픈 1자('BRK-B'). 접미사(.KS)가 붙으면 안 된다.
  const allCodes = US_PIT_YEARS.flatMap((y) => usPitCodes(y))
  const badFormat = [...new Set(allCodes)].filter((t) => !/^[A-Z]{1,5}(-[A-Z])?$/.test(t))
  check('모든 티커가 미국 형식(대문자 1~5자, 클래스는 하이픈)', badFormat.length === 0, badFormat.join(',') || 'ok')
  check('한국식 접미사(.KS/.KQ)가 섞이지 않았다', allCodes.every((t) => !/\./.test(t)))

  const missingName = [...new Set(allCodes)].filter((t) => !US_COMPANY_NAMES[t])
  check('모든 티커에 회사명이 달려 있다(티커 재사용 대비)', missingName.length === 0, missingName.join(',') || 'ok')

  check('[추정] 라벨이 출처 표기에 남아 있다(규칙 3)', US_PIT_SOURCE_NOTE.includes('[추정]'))

  // 생존편향 처리 ① — 상폐·피인수 종목이 실제로 목록에 남아 있어야 한다.
  // 이것들이 빠지면 "오늘까지 살아남은 종목만" 표본이 되어 성적이 부풀려진다.
  const dead = ['LU', 'WCOM', 'AOL', 'TYC', 'EMC', 'DELL']
  const present = dead.filter((t) => allCodes.includes(t))
  eq('상폐·피인수 종목이 목록에 그대로 있다', present.length, dead.length)
  console.log(`  (참고) 잔존 확인: ${present.join(', ')}`)

  console.log(`  (참고) 합집합 고유 조회 티커 ${US_PIT_UNION.length}개`)
}

// ── 2) 합집합(조회 목록) 규칙 ────────────────────────────────────────────────
{
  section('조회용 합집합(US_PIT_UNION)')

  check('합집합에 중복이 없다', new Set(US_PIT_UNION).size === US_PIT_UNION.length)
  check(
    '합집합이 정렬돼 있다',
    US_PIT_UNION.every((t, i) => i === 0 || US_PIT_UNION[i - 1] <= t),
  )
  // 합집합은 **조회용**이므로 전부 현재 티커여야 한다(구 티커가 남아 있으면 404가 난다).
  check(
    '합집합 원소가 전부 정규 티커(usFetchTicker 고정점)',
    US_PIT_UNION.every((t) => usFetchTicker(t) === t),
    US_PIT_UNION.filter((t) => usFetchTicker(t) !== t).join(',') || 'ok',
  )
  check(
    '재사용 티커는 조회 목록에 들어가지 않는다',
    US_PIT_UNION.every((t) => !US_BLOCKED_TICKERS.has(t)),
    US_PIT_UNION.filter((t) => US_BLOCKED_TICKERS.has(t)).join(',') || 'ok',
  )
  check('사명 변경된 구 티커(FB)는 합집합에 없다', !US_PIT_UNION.includes('FB'))
  check('사명 변경 후 현 티커(META)는 합집합에 있다', US_PIT_UNION.includes('META'))

  // 합집합은 "차단되지 않은 모든 해의 티커"를 정확히 덮어야 한다.
  const expected = new Set<string>()
  for (const y of US_PIT_YEARS) for (const t of usPitCodes(y)) if (!US_BLOCKED_TICKERS.has(t)) expected.add(US_TICKER_RENAMES[t] ?? t)
  eq('합집합 크기가 기대와 일치', US_PIT_UNION.length, expected.size)
  check(
    '합집합이 차단되지 않은 모든 해의 티커를 덮는다',
    [...expected].every((t) => US_PIT_UNION.includes(t)),
  )
}

// ── 3) 티커 매핑 순수 로직 ───────────────────────────────────────────────────
{
  section('티커 매핑 (resolveUsTicker / usFetchTicker)')

  // usFetchTicker — 조회 대상 결정
  eq('평범한 티커는 그대로', usFetchTicker('AAPL'), 'AAPL')
  eq('클래스 티커도 그대로(BRK-B)', usFetchTicker('BRK-B'), 'BRK-B')
  eq('사명 변경은 현 티커로(FB→META)', usFetchTicker('FB'), 'META')
  eq('SBC는 T로 승계', usFetchTicker('SBC'), 'T')
  eq('GOOGL은 GOOG로 통일', usFetchTicker('GOOGL'), 'GOOG')
  eq('재사용 티커는 조회 금지(LU=현 Lufax)', usFetchTicker('LU'), null)
  eq('재사용 티커는 조회 금지(SUNW=현 Sunworks)', usFetchTicker('SUNW'), null)

  // resolveUsTicker — histories 키 매핑. 두 번째 인자는 "그 심볼 시세를 갖고 있나".
  const hasOf = (...syms: string[]) => {
    const set = new Set(syms)
    return (s: string) => set.has(s)
  }

  eq('시세가 있으면 직행', resolveUsTicker('AAPL', hasOf('AAPL', 'MSFT')), 'AAPL')
  eq('시세가 없으면 매핑 실패', resolveUsTicker('AAPL', hasOf('MSFT')), undefined)
  eq('구 티커 → 현 티커 폴백(FB→META)', resolveUsTicker('FB', hasOf('META')), 'META')
  // 그 시점 티커가 실제로 있으면 그것을 먼저 쓴다(폴백은 어디까지나 차선).
  eq('그 시점 티커가 있으면 폴백보다 우선', resolveUsTicker('FB', hasOf('FB', 'META')), 'FB')

  // 🔴 핵심: 재사용 티커는 **시세가 있어도** 거부한다.
  // 그대로 매핑하면 Lucent 자리에 Lufax 시계열이 들어와 백테스트가 조용히 오염된다 —
  // 정직한 매핑 실패(매핑률 하락)가 훨씬 낫다.
  eq('재사용 티커는 시세가 있어도 거부(LU)', resolveUsTicker('LU', hasOf('LU')), undefined)
  eq('재사용 티커는 시세가 있어도 거부(AOL)', resolveUsTicker('AOL', hasOf('AOL')), undefined)

  // 상폐 종목은 시세 자체가 없어 실패한다 — 이것이 연도별 매핑률로 드러나는 잔존 생존편향.
  eq('상폐 종목은 매핑 실패로 계수(WCOM)', resolveUsTicker('WCOM', hasOf('AAPL', 'MSFT')), undefined)

  // 2000년 목록을 "오늘 조회 가능한 종목만"으로 풀면 매핑률이 20/20이 될 수 없다.
  const survivors2000 = usPitCodes(2000).filter((t) => resolveUsTicker(t, hasOf(...US_PIT_UNION)) !== undefined)
  check(
    '2000년은 20/20 매핑이 불가능하다(생존편향이 수치로 드러남)',
    survivors2000.length < 20,
    `${survivors2000.length}/20`,
  )
  console.log(`  (참고) 2000년 목록 중 차단/구티커 제외 후 조회 시도 대상 ${survivors2000.length}/20`)
}

// ── 4) 거래소 현지 날짜 변환 회귀 ────────────────────────────────────────────
// scripts/spec-backtest.entry.ts 의 fetchDaily 가 `+9*3600*1000` 하드코딩에서
// gmtoffset 기반 변환으로 바뀐 것에 대한 회귀 테스트.
{
  section('거래소 현지 날짜 변환 (exchangeLocalDate)')

  const KR = 32400 // 한국거래소 — 서머타임 없음, 항상 +9h
  const EST = -18000 // 미 동부 겨울(-5h)
  const EDT = -14400 // 미 동부 서머타임(-4h)
  const legacy = (ts: number) => new Date(ts * 1000 + 9 * 3600 * 1000).toISOString().slice(0, 10)

  // (a) KR 결과 불변 — 이 변경의 안전성 근거.
  // KRX 일봉은 개장시각 09:00 KST = 00:00 UTC 스탬프다.
  const krOpen = Math.floor(Date.UTC(2024, 0, 2, 0, 0, 0) / 1000) // 2024-01-02 09:00 KST
  eq('KR 확정 일봉 날짜', exchangeLocalDate(krOpen, KR), '2024-01-02')
  eq('KR 확정 일봉 — 구 하드코딩과 동일', exchangeLocalDate(krOpen, KR), legacy(krOpen))

  // 자정 경계·연말·윤년을 포함해 전 구간에서 구식과 **완전히** 같은지 확인한다.
  // (수식이 `ts*1000 + 9h` 와 대수적으로 동일하므로 반례가 있으면 안 된다.)
  let krMismatch = 0
  for (let ts = Date.UTC(1999, 0, 1) / 1000; ts < Date.UTC(2026, 6, 1) / 1000; ts += 3607) {
    if (exchangeLocalDate(ts, KR) !== legacy(ts)) krMismatch++
  }
  eq('KR(+32400)은 전 구간에서 구 하드코딩과 1건도 다르지 않다', krMismatch, 0)

  // KR 장중(진행 중) 봉도 동일 — 기존 KR 모드가 어떤 상황에서도 안 바뀐다.
  const krIntraday = Math.floor(Date.UTC(2024, 0, 2, 5, 0, 0) / 1000) // 14:00 KST
  eq('KR 장중 봉도 구식과 동일', exchangeLocalDate(krIntraday, KR), legacy(krIntraday))
  eq('KR 장중 봉 날짜', exchangeLocalDate(krIntraday, KR), '2024-01-02')

  // (b) 미국 확정 일봉 — 개장시각 09:30 ET 스탬프.
  const usWinterOpen = Math.floor(Date.UTC(2024, 0, 2, 14, 30, 0) / 1000) // 09:30 EST
  eq('미국 겨울 확정 일봉 날짜', exchangeLocalDate(usWinterOpen, EST), '2024-01-02')
  // 확정 봉에서는 구 하드코딩도 **우연히** 같은 답을 냈다(14:30+9h=23:30 같은 날).
  eq('확정 봉은 구식도 우연히 맞았다', legacy(usWinterOpen), '2024-01-02')

  const usSummerOpen = Math.floor(Date.UTC(2024, 6, 1, 13, 30, 0) / 1000) // 09:30 EDT
  eq('미국 서머타임 확정 일봉 날짜', exchangeLocalDate(usSummerOpen, EDT), '2024-07-01')
  eq('서머타임 확정 봉도 구식과 같음', legacy(usSummerOpen), '2024-07-01')

  // (c) 🔴 이 변경이 실제로 고치는 것 — 당일 진행 중인 봉.
  // 장중에는 현재시각으로 스탬프되므로 +9h를 더하면 날짜가 하루 밀린다.
  const usIntraday = Math.floor(Date.UTC(2024, 0, 2, 20, 0, 0) / 1000) // 15:00 EST(장중)
  eq('미국 장중 봉 — 새 변환은 당일', exchangeLocalDate(usIntraday, EST), '2024-01-02')
  eq('미국 장중 봉 — 구 하드코딩은 하루 밀렸다', legacy(usIntraday), '2024-01-03')
  check('장중 봉에서 두 방식이 실제로 갈린다(회귀의 존재 증명)', exchangeLocalDate(usIntraday, EST) !== legacy(usIntraday))

  // 미 동부 마감 16:00 ET 스탬프도 당일로 떨어져야 한다.
  const usClose = Math.floor(Date.UTC(2024, 0, 2, 21, 0, 0) / 1000) // 16:00 EST
  eq('미국 마감시각 스탬프도 당일', exchangeLocalDate(usClose, EST), '2024-01-02')
  eq('마감시각 스탬프는 구식이 하루 밀린다', legacy(usClose), '2024-01-03')

  // (d) gmtoffset 이 비었을 때의 보수적 기본값 — KR 동작 보존이 목적이다.
  eq('.KS는 +32400으로 보존', fallbackGmtOffset('005930.KS'), 32400)
  eq('.KQ는 +32400으로 보존', fallbackGmtOffset('035720.KQ'), 32400)
  eq('소문자 접미사도 인식', fallbackGmtOffset('005930.ks'), 32400)
  eq('미국 티커는 0(UTC)', fallbackGmtOffset('AAPL'), 0)
  eq('클래스 티커도 0', fallbackGmtOffset('BRK-B'), 0)
}

finish()
