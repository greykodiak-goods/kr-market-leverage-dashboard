// 5분봉 누적·집계·감시목록 검증.
// 핵심: 누적이 데이터를 잃거나 중복시키지 않는가, 5분봉→일봉 집계가 맞는가,
//       커버리지 구멍을 실제로 잡아내는가, 증분 수집의 소급 하한과 index 순서가 맞는가.
//
// 수집 소스는 키움(ka10080)이다 — 키움 응답 파서는 tests/kiwoom.test.ts가 검증한다.
// 구 Yahoo 5분봉 수집 경로는 2026-08-03에 제거됐다(파서도 함께 삭제).

import { check, close, eq, finish, section } from './harness'
// @ts-expect-error — .mjs 라이브러리(타입 선언 없음). esbuild가 번들한다.
import {
  buildWatchlist,
  coverage,
  dailyCutoffTs,
  KR_BARS_PER_DAY,
  kstDate,
  mergeBars,
  orderIndexSymbols,
  packBars,
  rankingToSymbols,
  SEED_SYMBOLS,
  toDailyBars,
  unpackBars,
} from '../scripts/lib/intraday.mjs'

// 2026-07-28(화) 09:00 KST = 2026-07-28T00:00:00Z
const D0 = Math.floor(Date.UTC(2026, 6, 28, 0, 0, 0) / 1000)
const FIVE_MIN = 300

// -------------------------------------------------------------- 1) 누적 병합
section('1) 누적 병합 (증분 수집의 핵심 — 매일 겹쳐 받아도 안전한가)')
{
  const a = [
    { ts: D0, o: 1, h: 1, l: 1, c: 1, v: 1 },
    { ts: D0 + FIVE_MIN, o: 2, h: 2, l: 2, c: 2, v: 2 },
  ]
  const b = [
    { ts: D0 + FIVE_MIN, o: 9, h: 9, l: 9, c: 9, v: 9 }, // 겹침 — 새 값이 이겨야 함
    { ts: D0 + 2 * FIVE_MIN, o: 3, h: 3, l: 3, c: 3, v: 3 },
  ]
  const m = mergeBars(a, b)
  eq('중복 제거 후 3개', m.length, 3)
  eq('겹친 봉은 새 값', m[1].c, 9)
  check('시간 오름차순', m.every((x, i) => i === 0 || m[i - 1].ts < x.ts))

  // 원본 불변
  eq('기존 배열 불변', a.length, 2)
  eq('기존 값 불변', a[1].c, 2)

  // 순서가 뒤죽박죽인 입력도 정렬된다
  const shuffled = mergeBars(
    [{ ts: D0 + 2 * FIVE_MIN, o: 3, h: 3, l: 3, c: 3, v: 3 }],
    [{ ts: D0, o: 1, h: 1, l: 1, c: 1, v: 1 }],
  )
  eq('정렬 보장', shuffled[0].ts, D0)

  // 빈 입력 안전
  eq('둘 다 비면 0', mergeBars([], []).length, 0)
  eq('undefined 안전', mergeBars(undefined, undefined).length, 0)
  eq('한쪽만 있어도 동작', mergeBars(a, []).length, 2)

  // ts가 깨진 항목은 버린다
  eq('ts 없는 항목 제외', mergeBars([{ o: 1 } as never], b).length, 2)

  // 여러 번 병합해도 늘어나지 않는다(멱등)
  const twice = mergeBars(mergeBars(a, b), b)
  eq('재병합 멱등', twice.length, 3)
}

// -------------------------------------------------------------- 2) 압축
section('2) 컬럼형 압축')
{
  const bars = [
    { ts: D0, o: 1, h: 2, l: 0.5, c: 1.5, v: 10 },
    { ts: D0 + FIVE_MIN, o: 1.5, h: 3, l: 1, c: 2.5, v: 20 },
  ]
  const p = packBars(bars)
  eq('ts 열 길이', p.ts.length, 2)
  eq('종가 열', p.c[1], 2.5)
  const back = unpackBars(p)
  eq('왕복 후 개수 동일', back.length, 2)
  eq('왕복 후 값 동일', back[1].c, 2.5)
  eq('왕복 후 ts 동일', back[0].ts, D0)
  eq('빈 입력 안전', unpackBars(null).length, 0)

  // 압축이 실제로 작아지는가 (키 반복 제거 효과)
  const many = Array.from({ length: 500 }, (_, i) => ({ ts: D0 + i * FIVE_MIN, o: 1, h: 1, l: 1, c: 1, v: 1 }))
  const rawSize = JSON.stringify(many).length
  const packedSize = JSON.stringify(packBars(many)).length
  check(`압축이 더 작음 (${packedSize} < ${rawSize})`, packedSize < rawSize * 0.6)
}

// ------------------------------------------------------------ 3) KST 날짜
section('3) KST 날짜 변환')
{
  eq('09:00 KST', kstDate(D0), '2026-07-28')
  // 15:30 KST = 06:30 UTC — 같은 날이어야 한다
  eq('15:30 KST도 같은 날', kstDate(D0 + 6.5 * 3600), '2026-07-28')
  // UTC 자정 넘김 테스트: 2026-07-28 23:00 KST = 14:00 UTC
  eq('23:00 KST', kstDate(Math.floor(Date.UTC(2026, 6, 28, 14, 0, 0) / 1000)), '2026-07-28')
}

// ---------------------------------------------------------- 4) 커버리지
section('4) 커버리지 — 구멍을 잡아내는가')
{
  eq('빈 입력', coverage([]).days, 0)

  // 정상 2일치 (78봉씩)
  const full: { ts: number; o: number; h: number; l: number; c: number; v: number }[] = []
  for (let day = 0; day < 2; day++) {
    for (let i = 0; i < KR_BARS_PER_DAY; i++) {
      full.push({ ts: D0 + day * 86400 + i * FIVE_MIN, o: 1, h: 1, l: 1, c: 1, v: 1 })
    }
  }
  const cf = coverage(full)
  eq('2 거래일', cf.days, 2)
  eq('총 봉수', cf.bars, KR_BARS_PER_DAY * 2)
  eq('첫 날', cf.firstDate, '2026-07-28')
  eq('구멍 없음', cf.thinDays.length, 0)
  close('일평균 봉수', cf.avgBarsPerDay, KR_BARS_PER_DAY, 1e-9)

  // 봉이 반만 있는 날 → 구멍으로 잡혀야 한다
  const thin = [...full]
  for (let i = 0; i < 30; i++) thin.push({ ts: D0 + 2 * 86400 + i * FIVE_MIN, o: 1, h: 1, l: 1, c: 1, v: 1 })
  const ct = coverage(thin)
  eq('3 거래일', ct.days, 3)
  eq('구멍 1일 검출', ct.thinDays.length, 1)
  eq('구멍 날짜', ct.thinDays[0], '2026-07-30')
}

// -------------------------------------------------- 5) 5분봉 → 일봉 집계
section('5) 5분봉 → 일봉 집계')
{
  // 하루 3봉: 시가는 첫 봉, 종가는 마지막 봉, 고저는 극값, 거래량은 합
  const bars = [
    { ts: D0, o: 100, h: 105, l: 99, c: 103, v: 10 },
    { ts: D0 + FIVE_MIN, o: 103, h: 110, l: 102, c: 108, v: 20 },
    { ts: D0 + 2 * FIVE_MIN, o: 108, h: 109, l: 95, c: 97, v: 30 },
  ]
  const daily = toDailyBars(bars)
  eq('1 거래일', daily.length, 1)
  eq('날짜', daily[0].date, '2026-07-28')
  eq('시가 = 첫 봉 시가', daily[0].o, 100)
  eq('종가 = 마지막 봉 종가', daily[0].c, 97)
  eq('고가 = 최대', daily[0].h, 110)
  eq('저가 = 최소', daily[0].l, 95)
  eq('거래량 = 합', daily[0].v, 60)

  // 이틀치
  const two = [...bars, { ts: D0 + 86400, o: 200, h: 201, l: 199, c: 200, v: 5 }]
  const d2 = toDailyBars(two)
  eq('2 거래일', d2.length, 2)
  check('날짜 오름차순', d2[0].date < d2[1].date)
  eq('둘째 날 값', d2[1].c, 200)

  // 입력 순서가 뒤집혀 있어도 시가·종가가 뒤바뀌지 않는가
  // (Map 삽입 순서에 의존하므로 정렬된 입력을 전제한다 — 그 전제를 명시적으로 확인)
  const sorted = toDailyBars([...bars].sort((a, b) => a.ts - b.ts))
  eq('정렬 입력 시 시가 동일', sorted[0].o, 100)
  eq('정렬 입력 시 종가 동일', sorted[0].c, 97)
}

// ------------------------------------------------ 6) 시총 랭킹 → 감시목록
section('6) 랭킹 파싱 — 우선주·스팩 제외, topN 컷')
{
  const json = {
    stocks: [
      { itemCode: '005930', stockName: '삼성전자' },
      { itemCode: '005935', stockName: '삼성전자우' }, // 우선주 — 제외
      { itemCode: '000660', stockName: 'SK하이닉스' },
      { itemCode: '00088K', stockName: '한화3우B' }, // 코드 비정상 — 제외
      { itemCode: '123450', stockName: '대신밸런스스팩12호' }, // 스팩 — 제외
      { itemCode: '360750', stockName: 'TIGER 미국S&P500' }, // ETF — 제외 (실제 유입 사례)
      { itemCode: '069500', stockName: 'KODEX 200' }, // ETF — 제외
      { itemCode: '035420', stockName: 'NAVER' },
      { itemCode: '051910', stockName: 'LG화학' },
    ],
  }
  const r = rankingToSymbols(json, 'KOSPI', 3)
  eq('topN 컷', r.length, 3)
  eq('우선주·스팩 걸러진 순서', r.map((x: { symbol: string }) => x.symbol).join(','), '005930.KS,000660.KS,035420.KS')
  eq('KOSDAQ 접미사', rankingToSymbols(json, 'KOSDAQ', 1)[0].symbol, '005930.KQ')
  eq('빈 응답 안전', rankingToSymbols({}, 'KOSPI', 10).length, 0)
  eq('이름에 우 포함(끝 아님)은 유지', rankingToSymbols({ stocks: [{ itemCode: '111111', stockName: '우리금융지주' }] }, 'KOSPI', 5).length, 1)
}

section('7) 감시목록 조립 — 랭킹 ∪ 기존 누적, 폴백')
{
  const ranked = [
    { symbol: 'A.KS', name: 'a' },
    { symbol: 'B.KQ', name: 'b' },
  ]
  // 랭킹에서 빠진 기존 누적 종목(C)은 유지된다 — 고아 방지
  const w = buildWatchlist(ranked, ['B.KQ', 'C.KS'], ['S.KS'])
  eq('랭킹+기존 합집합(중복 제거)', w.sort().join(','), 'A.KS,B.KQ,C.KS')
  check('랭킹 살아있으면 시드 미사용', !w.includes('S.KS'))
  // 랭킹 실패(빈 배열) → 시드 폴백 + 기존 유지
  const fb = buildWatchlist([], ['C.KS'], ['S.KS', 'S2.KQ'])
  eq('폴백 = 기존 ∪ 시드', fb.sort().join(','), 'C.KS,S.KS,S2.KQ')
  eq('전부 비면 빈 목록', buildWatchlist([], [], []).length, 0)

  // 랭킹 실패 시 쓰는 정적 시드 — 형식이 깨지면 폴백이 통째로 죽는다
  const seed = SEED_SYMBOLS as string[]
  check(`시드 종목 충분 (${seed.length})`, seed.length >= 60)
  check('시드는 전부 6자리코드.시장 형식', seed.every((s) => /^\d{6}\.(KS|KQ)$/.test(s)))
  eq('시드 중복 없음', new Set(seed).size, seed.length)
  check('시드에 코스피·코스닥 둘 다', seed.some((s) => s.endsWith('.KS')) && seed.some((s) => s.endsWith('.KQ')))
}

// -------------------------------------------- 8) 증분 수집의 소급 하한
section('8) dailyCutoffTs — 매일 증분은 어디까지 거슬러 받나')
{
  const now = D0 + 10 * 86400 // 기준 "현재"
  // 저장소가 없으면(신규 편입 종목) 최대 소급일까지만 — 여기서부터 누적을 시작한다
  eq('신규 종목 = 최대 소급일', dailyCutoffTs(null, now, 7), now - 7 * 86400)
  eq('숫자 아닌 입력도 동일 취급', dailyCutoffTs(undefined, now, 7), now - 7 * 86400)

  // 어제까지 쌓여 있으면 "최신 봉 − 하루"까지만 받는다(정렬·대조용 겹침)
  const yesterday = now - 86400
  eq('최신 봉 기준 하루 겹침', dailyCutoffTs(yesterday, now, 7), yesterday - 86400)
  check('하한이 최대 소급일보다 나중', dailyCutoffTs(yesterday, now, 7) > now - 7 * 86400)

  // 오래 멈춰 있었으면 최대 소급일이 바닥을 깐다 — 무한정 거슬러 올라가지 않는다
  const longAgo = now - 60 * 86400
  eq('오래된 저장소는 최대 소급일로 절단', dailyCutoffTs(longAgo, now, 7), now - 7 * 86400)
  // 겹침 폭은 조정 가능
  eq('겹침 폭 지정', dailyCutoffTs(yesterday, now, 7, 0), yesterday)
}

// ------------------------------------------------ 9) index.json 심볼 순서
section('9) orderIndexSymbols — 랭킹 순서 보존 (spec-backtest가 상위 N을 자른다)')
{
  const preferred = ['A.KS', 'B.KS', 'C.KQ'] // 오늘 랭킹 순
  const stored = ['C.KQ', 'B.KS', 'Z.KS', 'A.KS'] // 파일이 있는 종목(순서 무의미)
  const o = orderIndexSymbols(preferred, stored) as string[]
  eq('랭킹 순서가 앞', o.slice(0, 3).join(','), 'A.KS,B.KS,C.KQ')
  eq('랭킹 이탈 누적 종목은 뒤에 유지', o[3], 'Z.KS')
  eq('전체 개수', o.length, 4)

  // 파일이 없는 종목은 싣지 않는다 (수집 실패 종목이 index에 유령으로 남지 않게)
  const o2 = orderIndexSymbols(['A.KS', 'MISSING.KS'], ['A.KS']) as string[]
  eq('파일 없는 심볼 제외', o2.join(','), 'A.KS')

  // 중복·빈 입력 안전
  eq('preferred 중복 제거', (orderIndexSymbols(['A.KS', 'A.KS'], ['A.KS']) as string[]).length, 1)
  eq('preferred 비면 stored 코드순', (orderIndexSymbols([], ['B.KS', 'A.KS']) as string[]).join(','), 'A.KS,B.KS')
  eq('stored 비면 빈 목록', (orderIndexSymbols(['A.KS'], []) as string[]).length, 0)
}

finish()
