// 5분봉 백데이터 검증 배터리의 검증 — 검증기가 실제로 오류를 잡는지 확인한다.
// 핵심: ①구조 위반을 하나씩 주입해 각각 잡히는가 ②수정주가 스플라이스(±30% 초과 갭)를
// 잡되 상한가 갭(+30%)은 오탐하지 않는가 ③계통 편차와 산발 오류를 구분하는가.

import { check, close, eq, finish, section } from './harness'
// @ts-expect-error — .mjs 라이브러리(타입 선언 없음). esbuild가 번들한다.
import {
  checkStructure,
  compareDailySeries,
  compareVolume,
  dayGapSuspects,
  kstDow,
  kstMinOfDay,
  verdictOf,
} from '../scripts/lib/verifyIntraday.mjs'
// @ts-expect-error — .mjs 라이브러리(타입 선언 없음)
import { parseDailyChart } from '../scripts/lib/kiwoom.mjs'

const FIVE_MIN = 300
// 2026-07-28(화) 09:00 KST = 2026-07-28T00:00:00Z
const D0 = Math.floor(Date.UTC(2026, 6, 28, 0, 0, 0) / 1000)

type Bar = { ts: number; o: number; h: number; l: number; c: number; v: number }

/** 하루치 정상 5분봉 78개 (09:00~15:25 시작시각) */
function cleanDay(dayStartTs: number, price = 100): Bar[] {
  const out: Bar[] = []
  for (let i = 0; i < 78; i++) {
    out.push({ ts: dayStartTs + i * FIVE_MIN, o: price, h: price + 1, l: price - 1, c: price, v: 1000 })
  }
  return out
}

// -------------------------------------------------------------- 1) 시간 헬퍼
section('1) KST 시간 헬퍼')
eq('화요일 판정', kstDow(D0), 2)
eq('일요일 판정', kstDow(D0 - 2 * 86400), 0)
eq('09:00 = 540분', kstMinOfDay(D0), 540)
eq('15:25 = 925분', kstMinOfDay(D0 + 77 * FIVE_MIN), 925)

// -------------------------------------------------------------- 2) 구조 무결성
section('2) 구조 무결성 — 정상 데이터')
{
  const s = checkStructure(cleanDay(D0))
  eq('정상 하루 위반 0', s.ohlcBad + s.offGrid + s.outOfSession + s.weekend + s.dup + s.unsorted + s.nonPositive, 0)
  eq('days=1', s.days, 1)
  eq('fullDays 포함', s.fullDays.length, 1)
  eq('thinDays 없음', s.thinDays.length, 0)
}

section('2-1) 구조 위반 각각 검출')
{
  const bad = cleanDay(D0)
  bad[3] = { ...bad[3], l: 200 } // 저가 > 시가·종가
  eq('OHLC 역전 검출', checkStructure(bad).ohlcBad, 1)
}
{
  const bad = cleanDay(D0)
  bad[5] = { ...bad[5], ts: bad[5].ts + 17 } // 격자 이탈
  eq('5분 격자 이탈 검출', checkStructure(bad).offGrid, 1)
}
{
  const bars = [...cleanDay(D0 - 2 * 86400), ...cleanDay(D0)] // 일요일 하루 포함
  eq('주말 봉 검출', checkStructure(bars).weekend, 78)
}
{
  const bad = cleanDay(D0)
  bad.push({ ...bad[76] }, { ...bad[77] }) // 같은 ts 중복 2개 → 80봉
  bad.sort((a, b) => a.ts - b.ts)
  const s = checkStructure(bad)
  eq('중복 검출', s.dup, 2)
  // 하루 정상 상한은 79봉(15:30 마감 동시호가 봉 포함 가능) — 80봉부터 초과 판정
  eq('80봉 → 초과일 검출', s.excessDays.length, 1)
}
{
  const bad = cleanDay(D0)
  ;[bad[10], bad[11]] = [bad[11], bad[10]] // 역순
  check('역순 검출', checkStructure(bad).unsorted >= 1)
}
{
  const bad = cleanDay(D0)
  bad[0] = { ...bad[0], ts: D0 - 2 * FIVE_MIN } // 08:50 — 장전
  eq('장외 시간 검출', checkStructure(bad).outOfSession, 1)
}
{
  const thin = cleanDay(D0).slice(0, 40) // 40/78 = 51%
  const s = checkStructure(thin)
  eq('구멍 난 날 검출', s.thinDays.length, 1)
  eq('구멍 난 날은 fullDays 제외', s.fullDays.length, 0)
}
{
  const zv = cleanDay(D0).map((b) => ({ ...b, v: 0 }))
  eq('거래량 0인 날 검출', checkStructure(zv).zeroVolDays.length, 1)
}

// -------------------------------------------------------------- 3) 스플라이스 감지
section('3) 수정주가 스플라이스 감지')
{
  const daily = [
    { date: '2026-07-27', o: 100, h: 101, l: 99, c: 100, v: 1 },
    { date: '2026-07-28', o: 50, h: 51, l: 49, c: 50, v: 1 }, // 1/2 분할 자국: −50%
  ]
  const sus = dayGapSuspects(daily)
  eq('분할 자국(−50%) 검출', sus.length, 1)
  close('갭 크기', sus[0].gapPct, -50, 0.2)
}
{
  const daily = [
    { date: '2026-07-27', o: 100, h: 101, l: 99, c: 100, v: 1 },
    { date: '2026-07-28', o: 129, h: 130, l: 128, c: 130, v: 1 }, // +29% 갭 상승 — 시장에서 가능
  ]
  eq('상한가 갭(+29%)은 오탐 안 함', dayGapSuspects(daily).length, 0)
}

// -------------------------------------------------------------- 4) 일봉 대조
section('4) 일봉 시계열 대조 — 계통 vs 산발')
{
  const agg = [
    { date: '2026-07-27', o: 100, h: 101, l: 99, c: 100, v: 500 },
    { date: '2026-07-28', o: 100, h: 101, l: 99, c: 100, v: 500 },
  ]
  const ref = agg.map((d) => ({ ...d }))
  const cmp = compareDailySeries(agg, ref)
  eq('완전 일치 n=2', cmp.n, 2)
  close('완전 일치 badPct=0', cmp.badPct, 0)
}
{
  // 계통 편차: 전 날짜가 같은 방향으로 0.5% — 보정 기준 차이의 지문
  const agg = [1, 2, 3, 4].map((i) => ({ date: `2026-07-0${i}`, o: 100, h: 101, l: 99, c: 100.5, v: 500 }))
  const ref = [1, 2, 3, 4].map((i) => ({ date: `2026-07-0${i}`, o: 100, h: 101, l: 99, c: 100, v: 500 }))
  const cmp = compareDailySeries(agg, ref)
  close('계통 편차 중앙값 ≈ +0.5%', cmp.medianSignedDevPct, 0.5, 0.01)
  close('계통 편차 badPct=100', cmp.badPct, 100)
}
{
  // 산발 오류: 하루만 5% 튐 — 중앙값은 0에 머문다
  const agg = [1, 2, 3, 4, 5].map((i) => ({ date: `2026-07-0${i}`, o: 100, h: 101, l: 99, c: i === 3 ? 105 : 100, v: 500 }))
  const ref = [1, 2, 3, 4, 5].map((i) => ({ date: `2026-07-0${i}`, o: 100, h: 101, l: 99, c: 100, v: 500 }))
  const cmp = compareDailySeries(agg, ref)
  close('산발 오류 중앙값 ≈ 0', cmp.medianSignedDevPct, 0, 0.01)
  eq('worst에 해당 날짜', cmp.worst[0]?.date, '2026-07-03')
}
{
  // onlyDates 필터 — 미완성 날 제외
  const agg = [
    { date: '2026-07-27', o: 100, h: 101, l: 99, c: 100, v: 500 },
    { date: '2026-07-28', o: 100, h: 101, l: 99, c: 90, v: 500 }, // 장중 미완성이라 틀린 날
  ]
  const ref = agg.map((d) => ({ ...d, c: 100 }))
  const cmp = compareDailySeries(agg, ref, { onlyDates: ['2026-07-27'] })
  eq('필터 후 n=1', cmp.n, 1)
  close('필터 후 badPct=0', cmp.badPct, 0)
}
{
  const agg = [1, 2, 3].map((i) => ({ date: `2026-07-0${i}`, o: 0, h: 0, l: 0, c: 100, v: 800 }))
  const ref = [1, 2, 3].map((i) => ({ date: `2026-07-0${i}`, o: 0, h: 0, l: 0, c: 100, v: 1000 }))
  close('거래량 중앙 비율 0.8', compareVolume(agg, ref).medianRatio, 0.8, 1e-9)
}

// -------------------------------------------------------------- 5) 키움 일봉 파서
section('5) ka10081 일봉 파서 (필드명 관용 파싱)')
{
  const json = {
    stk_cd: '005930',
    return_code: 0,
    stk_dt_pole_chart_qry: [
      { dt: '20260727', open_pric: '+100', high_pric: '101', low_pric: '99', cur_prc: '-100', trde_qty: '5000' },
      { dt: '20260728', open_pric: '101', high_pric: '102', low_pric: '100', cur_prc: '102', trde_qty: '6000' },
      { dt: 'bogus', open_pric: '1', high_pric: '1', low_pric: '1', cur_prc: '1', trde_qty: '1' },
    ],
  }
  const p = parseDailyChart(json)
  eq('행 2개 파싱', p.daily.length, 2)
  eq('불량 행 dropped', p.dropped, 1)
  eq('날짜 정규화', p.daily[0].date, '2026-07-27')
  eq('대비부호 제거', p.daily[0].c, 100)
  eq('오름차순 정렬', p.daily[1].date, '2026-07-28')
}
{
  eq('빈 응답 → 0행', parseDailyChart({ stk_cd: 'x', return_code: 0 }).daily.length, 0)
}

// -------------------------------------------------------------- 6) 판정
section('6) 판정 — FAIL/WARN/PASS')
{
  const structure = checkStructure(cleanDay(D0))
  const clean = verdictOf({ structure, splices: [], kiwoomCmp: { n: 10, badPct: 0, avgAbsDevPct: 0 }, yahooCmp: { n: 10, badPct: 0, avgAbsDevPct: 0, medianSignedDevPct: 0 }, yahooVol: { n: 10, medianRatio: 0.95 } })
  eq('정상 → PASS', clean.level, 'PASS')

  const spliced = verdictOf({ structure, splices: [{ date: '2026-07-28', prevDate: '2026-07-27', gapPct: -50 }], kiwoomCmp: null, yahooCmp: null, yahooVol: null })
  eq('스플라이스 → FAIL', spliced.level, 'FAIL')

  const kiwoomOff = verdictOf({ structure, splices: [], kiwoomCmp: { n: 100, badPct: 5, avgAbsDevPct: 0.5 }, yahooCmp: null, yahooVol: null })
  eq('키움 교차 어긋남 → FAIL', kiwoomOff.level, 'FAIL')

  const yahooSys = verdictOf({ structure, splices: [], kiwoomCmp: { n: 100, badPct: 0, avgAbsDevPct: 0 }, yahooCmp: { n: 100, badPct: 98, avgAbsDevPct: 0.2, medianSignedDevPct: 0.2 }, yahooVol: { n: 100, medianRatio: 0.9 } })
  eq('Yahoo 계통 편차 → WARN(FAIL 아님)', yahooSys.level, 'WARN')
  check('WARN 사유에 보정 기준 명시', yahooSys.warns.some((w: string) => w.includes('보정 기준')))
}

finish()
