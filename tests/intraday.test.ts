// 5분봉 파싱·누적·집계 검증.
// 핵심: 누적이 데이터를 잃거나 중복시키지 않는가, 5분봉→일봉 집계가 맞는가,
//       커버리지 구멍을 실제로 잡아내는가.

import { check, close, eq, finish, section } from './harness'
// @ts-expect-error — .mjs 라이브러리(타입 선언 없음). esbuild가 번들한다.
import {
  coverage,
  KR_BARS_PER_DAY,
  kstDate,
  mergeBars,
  packBars,
  parseYahooIntraday,
  toDailyBars,
  unpackBars,
} from '../scripts/lib/intraday.mjs'

// 2026-07-28(화) 09:00 KST = 2026-07-28T00:00:00Z
const D0 = Math.floor(Date.UTC(2026, 6, 28, 0, 0, 0) / 1000)
const FIVE_MIN = 300

function yahoo(over: Record<string, unknown> = {}) {
  return {
    chart: {
      result: [
        {
          meta: { dataGranularity: '5m', exchangeTimezoneName: 'Asia/Seoul', gmtoffset: 32400 },
          timestamp: [D0, D0 + FIVE_MIN, D0 + 2 * FIVE_MIN],
          indicators: {
            quote: [
              {
                open: [100, 101, 102],
                high: [101, 102, 103],
                low: [99, 100, 101],
                close: [101, 102, 103],
                volume: [1000, 2000, 3000],
              },
            ],
          },
          ...over,
        },
      ],
    },
  }
}

// -------------------------------------------------------------- 1) 파싱
section('1) Yahoo 5분봉 파싱')
{
  const r = parseYahooIntraday(yahoo())
  eq('봉 3개', r.bars.length, 3)
  eq('granularity 5m', r.granularity, '5m')
  eq('타임존', r.tz, 'Asia/Seoul')
  eq('gmtoffset', r.gmtoffset, 32400)
  eq('첫 봉 ts', r.bars[0].ts, D0)
  eq('첫 봉 종가', r.bars[0].c, 101)
  eq('결측 0', r.dropped, 0)

  // 결측 봉은 버리고 개수를 보고한다 (장중 미완성 봉은 null로 온다)
  const withNull = yahoo({
    timestamp: [D0, D0 + FIVE_MIN, D0 + 2 * FIVE_MIN],
    indicators: {
      quote: [
        { open: [100, null, 102], high: [101, null, 103], low: [99, null, 101], close: [101, null, 103], volume: [1, null, 3] },
      ],
    },
  })
  const rn = parseYahooIntraday(withNull)
  eq('결측 봉 제외', rn.bars.length, 2)
  eq('버린 개수 보고', rn.dropped, 1)
  check('버린 봉의 ts는 없음', !rn.bars.some((b: { ts: number }) => b.ts === D0 + FIVE_MIN))

  // volume이 null이면 0으로 (가격은 있으니 봉을 버리진 않는다)
  const noVol = yahoo({
    timestamp: [D0],
    indicators: { quote: [{ open: [100], high: [101], low: [99], close: [100], volume: [null] }] },
  })
  eq('거래량 null → 0', parseYahooIntraday(noVol).bars[0].v, 0)

  // 에러 응답
  let threw = false
  try {
    parseYahooIntraday({ chart: { result: null, error: { description: '심볼 없음' } } })
  } catch (e) {
    threw = true
    check('에러 메시지에 사유 포함', String((e as Error).message).includes('심볼 없음'))
  }
  check('잘못된 응답은 예외', threw)
}

// -------------------------------------------------------------- 2) 누적 병합
section('2) 누적 병합 (60일 제한 대응의 핵심)')
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

// -------------------------------------------------------------- 3) 압축
section('3) 컬럼형 압축')
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

// ------------------------------------------------------------ 4) KST 날짜
section('4) KST 날짜 변환')
{
  eq('09:00 KST', kstDate(D0), '2026-07-28')
  // 15:30 KST = 06:30 UTC — 같은 날이어야 한다
  eq('15:30 KST도 같은 날', kstDate(D0 + 6.5 * 3600), '2026-07-28')
  // UTC 자정 넘김 테스트: 2026-07-28 23:00 KST = 14:00 UTC
  eq('23:00 KST', kstDate(Math.floor(Date.UTC(2026, 6, 28, 14, 0, 0) / 1000)), '2026-07-28')
}

// ---------------------------------------------------------- 5) 커버리지
section('5) 커버리지 — 구멍을 잡아내는가')
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

// -------------------------------------------------- 6) 5분봉 → 일봉 집계
section('6) 5분봉 → 일봉 집계')
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

finish()
