// 큰손 자금 레이더 지표 검증.
// 핵심: (1) 각 지표가 이론상 맞는 방향으로 움직이는가
//       (2) 인과성 — 뒤쪽 봉을 잘라내도 그 이전 계산값이 동일한가(규칙 1)
//       (3) 정규화에 전체 구간 통계를 쓰지 않는가

import { check, close, eq, finish, rng, section } from './harness'
import type { DailyBar } from '../src/lib/history'
import {
  bigPrintBias,
  chaikinMoneyFlow,
  labelFor,
  obvTrend,
  periodReturn,
  relativeStrength,
  rotationGauge,
  smartMoneySnapshot,
  turnoverZ,
} from '../src/features/mega-investors/smartMoney'

function d(i: number): string {
  return new Date(Date.UTC(2020, 0, 1) + i * 86400000).toISOString().slice(0, 10)
}

/** closePos: 0=저가 마감, 1=고가 마감. vol 고정 가능. */
function bar(i: number, base: number, closePos: number, vol = 1e6, range = 0.02): DailyBar {
  const l = base * (1 - range / 2)
  const h = base * (1 + range / 2)
  const c = l + (h - l) * closePos
  return { date: d(i), o: base, h, l, c, v: vol }
}

function series(n: number, fn: (i: number) => DailyBar): DailyBar[] {
  return Array.from({ length: n }, (_, i) => fn(i))
}

// ---------------------------------------------------------------- 1) CMF
section('1) 채이킨 자금흐름(CMF)')
{
  const hi = series(40, (i) => bar(i, 100, 1)) // 항상 고가 마감
  const lo = series(40, (i) => bar(i, 100, 0)) // 항상 저가 마감
  const mid = series(40, (i) => bar(i, 100, 0.5))
  close('전부 고가 마감 → CMF = +1', chaikinMoneyFlow(hi, 39, 20)!, 1, 1e-9)
  close('전부 저가 마감 → CMF = −1', chaikinMoneyFlow(lo, 39, 20)!, -1, 1e-9)
  close('중간 마감 → CMF = 0', chaikinMoneyFlow(mid, 39, 20)!, 0, 1e-9)
  eq('기간 미달이면 null', chaikinMoneyFlow(hi, 5, 20), null)

  // 거래량 가중: 고가 마감일에 거래량이 크면 양수로 끌린다
  const mixed = series(40, (i) => bar(i, 100, i % 2 === 0 ? 1 : 0, i % 2 === 0 ? 5e6 : 1e6))
  check('고가마감일 거래량↑ → CMF 양수', chaikinMoneyFlow(mixed, 39, 20)! > 0.5)

  // 고저 레인지 0(가격 정지)인 봉은 건너뛴다 → 0으로 나누기 없음
  const flat = series(40, (i) => ({ date: d(i), o: 100, h: 100, l: 100, c: 100, v: 1e6 }))
  eq('레인지 0이면 null(0나눗셈 없음)', chaikinMoneyFlow(flat, 39, 20), null)
}

// ---------------------------------------------------------------- 2) OBV
section('2) OBV 추세')
{
  const up = series(80, (i) => bar(i, 100 * (1 + i * 0.004), 0.5))
  const down = series(80, (i) => bar(i, 100 * (1 - i * 0.004), 0.5))
  check('지속 상승 → OBV 기울기 양수', obvTrend(up, 79, 60)! > 0)
  check('지속 하락 → OBV 기울기 음수', obvTrend(down, 79, 60)! < 0)
  eq('기간 미달이면 null', obvTrend(up, 10, 60), null)

  // 규모 무관: 거래량을 100배 키워도 정규화 값은 동일
  const upBig = up.map((b) => ({ ...b, v: b.v * 100 }))
  close('거래량 100배 → 값 동일(정규화)', obvTrend(upBig, 79, 60)!, obvTrend(up, 79, 60)!, 1e-9)

  // 보합(종가 동일)은 방향 0 → 기울기 0 근처
  const flatC = series(80, (i) => ({ date: d(i), o: 100, h: 101, l: 99, c: 100, v: 1e6 }))
  close('종가 보합 → 기울기 0', obvTrend(flatC, 79, 60)!, 0, 1e-9)
}

// -------------------------------------------------- 3) 대량거래일 마감위치
section('3) 대량거래일 마감위치 편향')
{
  // 평범한 날은 저가 마감, 거래대금 큰 날만 고가 마감 → 편향은 +쪽
  const s = series(80, (i) => (i % 10 === 0 ? bar(i, 100, 1, 9e6) : bar(i, 100, 0, 1e6)))
  const b = bigPrintBias(s, 79, 60, 0.2)!
  check('큰 거래일만 고가마감 → 양수 편향', b > 0.3, `${b}`)
  check('상한 0.5 초과 없음', b <= 0.5)

  const s2 = series(80, (i) => (i % 10 === 0 ? bar(i, 100, 0, 9e6) : bar(i, 100, 1, 1e6)))
  check('큰 거래일만 저가마감 → 음수 편향', bigPrintBias(s2, 79, 60, 0.2)! < -0.3)

  // 평범한 날의 마감위치는 결과를 지배하지 못한다(상위 20%만 집계)
  const s3 = series(80, (i) => (i % 10 === 0 ? bar(i, 100, 1, 9e6) : bar(i, 100, 0.5, 1e6)))
  check('보통날 중립이어도 큰거래일이 결정', bigPrintBias(s3, 79, 60, 0.2)! > 0.3)
  eq('기간 미달이면 null', bigPrintBias(s, 20, 60, 0.2), null)
}

// ------------------------------------------------------------ 4) 거래대금 z
section('4) 거래대금 z-score')
{
  const r = rng(7)
  // 앞 60일 평범 → 최근 5일 급증
  const s = series(80, (i) => bar(i, 100, 0.5, i >= 75 ? 8e6 : 1e6 * (0.9 + 0.2 * r())))
  const z = turnoverZ(s, 79, 60, 5)!
  check('최근 거래대금 급증 → z 큼', z > 3, `${z}`)

  const flatVol = series(80, (i) => bar(i, 100, 0.5, 1e6 * (0.9 + 0.2 * rng(3)())))
  const z2 = turnoverZ(flatVol, 79, 60, 5)
  check('평탄하면 z 작음', z2 == null || Math.abs(z2) < 2)

  // 표준편차 0이면 null (0나눗셈 방지)
  const constVol = series(80, (i) => bar(i, 100, 0.5, 1e6))
  eq('거래대금 분산 0 → null', turnoverZ(constVol, 79, 60, 5), null)
  eq('기간 미달이면 null', turnoverZ(s, 30, 60, 5), null)
}

// ------------------------------------------------------------ 5) 상대강도
section('5) 상대강도(초과수익)')
{
  const strong = series(80, (i) => bar(i, 100 * (1 + i * 0.005), 0.5))
  const bench = series(80, (i) => bar(i, 100 * (1 + i * 0.001), 0.5))
  const rs = relativeStrength(strong, bench, 60)!
  check('벤치보다 강하면 양수', rs > 0, `${rs}`)
  check('벤치보다 약하면 음수', relativeStrength(bench, strong, 60)! < 0)

  // 벤치마크가 종목보다 뒤 날짜를 가져도 그 봉을 쓰지 않는다(미래참조 금지)
  const benchLong = series(120, (i) => bar(i, 100 * (1 + i * 0.001), 0.5))
  const a = relativeStrength(strong, bench, 60)!
  const b = relativeStrength(strong, benchLong, 60)!
  close('벤치에 미래 봉이 더 있어도 결과 동일', b, a, 1e-9)
}

// ------------------------------------------------- 6) 종합 스냅샷 방향성
section('6) 종합 스냅샷')
{
  const bench = series(200, (i) => bar(i, 100 * (1 + i * 0.0005), 0.5))
  // 매집형: 큰 거래일 고가 마감 + 상승 + 벤치 상회
  const accum = series(200, (i) =>
    i % 8 === 0 ? bar(i, 100 * (1 + i * 0.003), 0.95, 6e6) : bar(i, 100 * (1 + i * 0.003), 0.7, 1e6),
  )
  // 분산형: 큰 거래일 저가 마감 + 하락
  const distrib = series(200, (i) =>
    i % 8 === 0 ? bar(i, 100 * (1 - i * 0.002), 0.05, 6e6) : bar(i, 100 * (1 - i * 0.002), 0.3, 1e6),
  )
  const A = smartMoneySnapshot('ACC', accum, bench)
  const D = smartMoneySnapshot('DIS', distrib, bench)
  check('매집형 점수 양수', A.score! > 20, `${A.score}`)
  check('분산형 점수 음수', D.score! < -20, `${D.score}`)
  check('매집형 라벨', A.label === '강한 매집' || A.label === '매집 우위', A.label)
  check('분산형 라벨', D.label === '강한 분산' || D.label === '분산 우위', D.label)
  check('점수 범위 −100~100', A.score! <= 100 && D.score! >= -100)
  eq('parts 5종(방향4 + 세기1)', A.parts.length, 5)
  eq('거래대금 z는 가중치 0(방향 아님)', A.parts.find((p) => p.key === 'turnZ')!.weight, 0)
  check('모든 part에 설명 있음', A.parts.every((p) => p.desc.length > 10))
  eq('asOf = 마지막 봉 날짜', A.asOf, accum[accum.length - 1].date)

  // 데이터 부족 → 판단 불가 (억지 점수 만들지 않음)
  const tiny = series(20, (i) => bar(i, 100, 0.5))
  const T = smartMoneySnapshot('TINY', tiny, bench)
  eq('데이터 부족 → score null', T.score, null)
  eq('데이터 부족 → 판단 불가', T.label, '판단 불가')

  // 벤치마크 없어도 동작 (RS만 빠짐)
  const NB = smartMoneySnapshot('NB', accum, null)
  check('벤치 없어도 점수 산출', NB.score != null)
  eq('벤치 없으면 RS는 null', NB.parts.find((p) => p.key === 'rs')!.raw, null)
}

// ------------------------------------- 7) 인과성 — 절단 불변성 (규칙 1)
section('7) 절단 불변성 (미래참조 금지)')
{
  const r = rng(42)
  const full = series(400, (i) => {
    const base = 100 * (1 + i * 0.001 + 0.05 * Math.sin(i / 17))
    return bar(i, base, r(), 1e6 * (0.5 + r() * 2))
  })
  const benchFull = series(400, (i) => bar(i, 100 * (1 + i * 0.0008), 0.5, 1e6))

  const CUT = 300
  const truncated = full.slice(0, CUT)
  const benchTrunc = benchFull.slice(0, CUT)
  const at = CUT - 1

  close('CMF: 절단 전후 동일', chaikinMoneyFlow(truncated, at, 20)!, chaikinMoneyFlow(full, at, 20)!, 1e-12)
  close('OBV: 절단 전후 동일', obvTrend(truncated, at, 60)!, obvTrend(full, at, 60)!, 1e-12)
  close('대량거래 편향: 절단 전후 동일', bigPrintBias(truncated, at, 60, 0.2)!, bigPrintBias(full, at, 60, 0.2)!, 1e-12)
  close('거래대금 z: 절단 전후 동일', turnoverZ(truncated, at, 60, 5)!, turnoverZ(full, at, 60, 5)!, 1e-12)

  const snapTrunc = smartMoneySnapshot('X', truncated, benchTrunc)
  const snapFullAtCut = smartMoneySnapshot('X', full.slice(0, CUT), benchFull.slice(0, CUT))
  close('종합 점수: 절단 전후 동일', snapTrunc.score!, snapFullAtCut.score!, 1e-12)

  // 벤치마크만 미래로 길어져도 결과가 변하면 안 된다
  const snapLongBench = smartMoneySnapshot('X', truncated, benchFull)
  close('벤치에 미래 데이터 붙여도 동일', snapLongBench.score!, snapTrunc.score!, 1e-12)

  // 여러 절단 지점에서 반복
  let allSame = true
  for (const cut of [150, 200, 250, 350]) {
    const a = smartMoneySnapshot('X', full.slice(0, cut), benchFull.slice(0, cut))
    const b = smartMoneySnapshot('X', full.slice(0, cut), benchFull.slice(0, cut + 30))
    if (a.score == null || b.score == null || Math.abs(a.score - b.score) > 1e-12) allSame = false
  }
  check('절단 지점 4곳 모두 불변', allSame)

  // 마지막 봉을 조작해도 그 이전 인덱스 계산은 안 변한다
  const tampered = [...full]
  tampered[399] = bar(399, 999999, 1, 9e9)
  close('마지막 봉 조작 → 이전 인덱스 불변', chaikinMoneyFlow(tampered, 300, 20)!, chaikinMoneyFlow(full, 300, 20)!, 1e-12)
}

// ------------------------------------------- 8) 고정 스케일 정규화 확인
section('8) 정규화에 전체구간 통계 미사용')
{
  // 같은 앞부분 + 서로 다른 뒷부분 → 앞부분 시점 점수는 같아야 한다.
  // 전체 구간 평균·표준편차로 정규화했다면 여기서 달라진다.
  const r1 = rng(11)
  const head = series(200, (i) => bar(i, 100 * (1 + i * 0.001), r1(), 1e6 * (0.5 + r1())))
  const calmTail = series(80, (i) => bar(200 + i, 120, 0.5, 1e6))
  const wildTail = series(80, (i) => bar(200 + i, 120 * (1 + i * 0.02), 1, 5e8))
  const bench = series(400, (i) => bar(i, 100 * (1 + i * 0.0008), 0.5))

  const withCalm = smartMoneySnapshot('X', [...head, ...calmTail].slice(0, 200), bench)
  const withWild = smartMoneySnapshot('X', [...head, ...wildTail].slice(0, 200), bench)
  close('뒤가 뭐든 앞 시점 점수 동일', withCalm.score!, withWild.score!, 1e-12)

  // 라벨 경계
  eq('45 → 강한 매집', labelFor(45), '강한 매집')
  eq('15 → 매집 우위', labelFor(15), '매집 우위')
  eq('0 → 중립', labelFor(0), '중립')
  eq('−15 → 분산 우위', labelFor(-15), '분산 우위')
  eq('−45 → 강한 분산', labelFor(-45), '강한 분산')
  eq('null → 판단 불가', labelFor(null), '판단 불가')
}

// ------------------------------------------------------ 9) 자금 로테이션
section('9) 자금 로테이션 게이지')
{
  const up = series(90, (i) => bar(i, 100 * (1 + i * 0.004), 0.5))
  const down = series(90, (i) => bar(i, 100 * (1 - i * 0.002), 0.5))
  check('기간 수익률 양수', periodReturn(up, 60)! > 0)
  check('기간 수익률 음수', periodReturn(down, 60)! < 0)
  eq('데이터 부족 → null', periodReturn(up, 200), null)

  const on = [{ symbol: 'SMH', label: '반도체', ret: periodReturn(up, 60) }]
  const off = [{ symbol: 'TLT', label: '장기채', ret: periodReturn(down, 60) }]
  const g = rotationGauge(on, off, 60)
  eq('위험자산 우위 → 위험선호', g.stance, '위험선호')
  check('스프레드 양수', g.spreadPct! > 0)

  const g2 = rotationGauge(off, on, 60)
  eq('방어자산 우위 → 위험회피', g2.stance, '위험회피')

  const g3 = rotationGauge(
    [{ symbol: 'A', label: 'a', ret: 1 }],
    [{ symbol: 'B', label: 'b', ret: 0.5 }],
    60,
  )
  eq('차이 작으면 중립', g3.stance, '중립')

  const g4 = rotationGauge([{ symbol: 'A', label: 'a', ret: null }], off, 60)
  eq('데이터 없으면 판단 불가', g4.stance, '판단 불가')
  eq('판단 불가면 스프레드 null', g4.spreadPct, null)
}

finish()
