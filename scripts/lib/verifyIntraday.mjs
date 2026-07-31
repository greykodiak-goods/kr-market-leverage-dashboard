// 5분봉 백데이터 정확성 검증 — 순수 함수만 (tests/verify-intraday.test.ts가 검증).
//
// 왜 필요한가: 백테스트는 데이터가 틀리면 결론 전체가 무효다. "받아졌다"와
// "맞다"는 다르다. 여기의 함수들은 세 층으로 데이터를 의심한다:
//   ① 구조 무결성 — 봉 자체가 물리적으로 말이 되는가 (OHLC 순서·5분 격자·장중 시간대·중복)
//   ② 스플라이스 감지 — 수정주가 소급 변경으로 과거 구간과 새 구간의 기준이 어긋났는가
//      (KRX 가격제한폭 ±30%를 넘는 하루 갭은 시장에서 생길 수 없다 → 병합 오염의 지문)
//   ③ 독립 시계열 대조 — 5분봉을 일봉으로 집계해 다른 출처의 일봉과 비교
//      (계통 편차 = 보정 기준 차이, 산발 편차 = 데이터 오류)
//
// 어떤 검증도 "원천 소스 둘 다 같은 방식으로 틀린 경우"는 못 잡는다 — 그래서
// 대조는 소스 내(키움 일봉)와 소스 간(Yahoo 일봉)을 둘 다 한다. 한계는 러너가 보고한다.

import { KR_BARS_PER_DAY, kstDate } from './intraday.mjs'

const FIVE_MIN = 300

/** epoch초 → KST 기준 요일 (0=일 … 6=토) */
export function kstDow(tsSec) {
  return new Date((tsSec + 9 * 3600) * 1000).getUTCDay()
}

/** epoch초 → KST 자정 기준 경과 분 */
export function kstMinOfDay(tsSec) {
  return Math.floor(((tsSec + 9 * 3600) % 86400) / 60)
}

/**
 * ① 구조 무결성 검사.
 * 정규장 09:00–15:30(장 시작 540분~930분, 봉 시작시각 기준) 밖의 봉,
 * OHLC 역전, 5분 격자 이탈, 중복·역순, 주말 봉을 센다.
 * thinDays: 봉이 정상(78개)의 80% 미만인 날(장 단축·수집 구멍).
 * excessDays: 79개 초과인 날(중복·시간축 오염 의심 — 정상적으론 불가능).
 */
export function checkStructure(bars) {
  const r = {
    bars: bars.length,
    ohlcBad: 0,
    offGrid: 0,
    outOfSession: 0,
    weekend: 0,
    dup: 0,
    unsorted: 0,
    nonPositive: 0,
    days: 0,
    firstDate: null,
    lastDate: null,
    thinDays: [],
    excessDays: [],
    zeroVolDays: [],
    fullDays: [], // 봉 수가 충분한 날 — 일봉 대조는 이 날들만 쓴다
  }
  if (!bars.length) return r
  const byDay = new Map() // date → { n, vol }
  let prevTs = -Infinity
  for (const b of bars) {
    if (!(b.o > 0 && b.h > 0 && b.l > 0 && b.c > 0)) r.nonPositive++
    else if (b.l > Math.min(b.o, b.c) + 1e-9 || b.h < Math.max(b.o, b.c) - 1e-9) r.ohlcBad++
    if (b.ts % FIVE_MIN !== 0) r.offGrid++
    const mod = kstMinOfDay(b.ts)
    if (mod < 540 || mod > 930) r.outOfSession++
    const dow = kstDow(b.ts)
    if (dow === 0 || dow === 6) r.weekend++
    if (b.ts === prevTs) r.dup++
    else if (b.ts < prevTs) r.unsorted++
    prevTs = b.ts
    const d = kstDate(b.ts)
    const cur = byDay.get(d) ?? { n: 0, vol: 0 }
    cur.n++
    cur.vol += b.v ?? 0
    byDay.set(d, cur)
  }
  const days = [...byDay.keys()].sort()
  r.days = days.length
  r.firstDate = days[0]
  r.lastDate = days[days.length - 1]
  for (const d of days) {
    const { n, vol } = byDay.get(d)
    if (n < KR_BARS_PER_DAY * 0.8) r.thinDays.push(d)
    else r.fullDays.push(d)
    if (n > KR_BARS_PER_DAY + 1) r.excessDays.push(d)
    if (vol === 0) r.zeroVolDays.push(d)
  }
  return r
}

/**
 * ② 수정주가 스플라이스(병합 기준 어긋남) 감지.
 * KRX 가격제한폭은 ±30% — 전일 종가 대비 시가 갭이 그걸 넘으면 시장 가격이 아니라
 * "서로 다른 수정주가 기준의 두 구간을 이어붙인 자국"이다(액면분할 1/2=−50%, 1/5=−80% 등).
 * threshold 기본 31%: 상한가 갭(+30%)은 통과시키고 분할 자국만 잡는다.
 */
export function dayGapSuspects(dailyBars, thresholdPct = 31) {
  const out = []
  for (let i = 1; i < dailyBars.length; i++) {
    const prev = dailyBars[i - 1]
    const cur = dailyBars[i]
    if (!(prev.c > 0) || !(cur.o > 0)) continue
    const gapPct = (cur.o / prev.c - 1) * 100
    if (Math.abs(gapPct) > thresholdPct) {
      out.push({ date: cur.date, prevDate: prev.date, gapPct: Math.round(gapPct * 10) / 10 })
    }
  }
  return out
}

/**
 * ③ 일봉 시계열 대조 — 날짜로 매칭해 종가 편차를 잰다.
 * medianSignedDevPct가 0에서 벗어나 있으면 계통 편차(보정 기준 차이),
 * avg는 작은데 badPct만 높으면 산발 오류(특정 날 데이터가 틀림)다. 둘은 처방이 다르다.
 * onlyDates를 주면 그 날짜(봉이 온전한 날)만 비교한다 — 장중 미완성 날 오탐 방지.
 */
export function compareDailySeries(aggDaily, refDaily, { closeTolPct = 0.1, onlyDates = null } = {}) {
  const refBy = new Map(refDaily.map((d) => [d.date, d]))
  const filter = onlyDates ? new Set(onlyDates) : null
  let n = 0
  let bad = 0
  let sumAbs = 0
  const signed = []
  const worst = []
  for (const a of aggDaily) {
    if (filter && !filter.has(a.date)) continue
    const ref = refBy.get(a.date)
    if (!ref || !(ref.c > 0)) continue
    n++
    const devPct = (a.c / ref.c - 1) * 100
    signed.push(devPct)
    sumAbs += Math.abs(devPct)
    if (Math.abs(devPct) > closeTolPct) {
      bad++
      worst.push({ date: a.date, agg: a.c, ref: ref.c, devPct: Math.round(devPct * 100) / 100 })
    }
  }
  worst.sort((x, y) => Math.abs(y.devPct) - Math.abs(x.devPct))
  signed.sort((x, y) => x - y)
  return {
    n,
    badPct: n ? (bad / n) * 100 : null,
    avgAbsDevPct: n ? sumAbs / n : null,
    medianSignedDevPct: n ? signed[Math.floor(n / 2)] : null,
    worst: worst.slice(0, 3),
  }
}

/**
 * ③-거래량 대조 — 가격 보정과 무관해서 파싱·결측 오류에 특히 민감한 지표.
 * 정규장 5분봉 합계는 시간외·블록딜이 빠져 공식 일거래량보다 약간 작은 게 정상이다.
 * medianRatio(집계/기준)가 0.5 밑이면 봉 결측, 1.1 위면 중복·단위 오류를 의심한다.
 * 주의: 수정주가 기준 소스는 분할 시 거래량도 역보정한다 — 무보정 소스와 섞어 비교하지 말 것.
 */
export function compareVolume(aggDaily, refDaily, { onlyDates = null } = {}) {
  const refBy = new Map(refDaily.map((d) => [d.date, d]))
  const filter = onlyDates ? new Set(onlyDates) : null
  const ratios = []
  for (const a of aggDaily) {
    if (filter && !filter.has(a.date)) continue
    const ref = refBy.get(a.date)
    if (!ref || !(ref.v > 0) || !(a.v >= 0)) continue
    ratios.push(a.v / ref.v)
  }
  ratios.sort((x, y) => x - y)
  return { n: ratios.length, medianRatio: ratios.length ? ratios[Math.floor(ratios.length / 2)] : null }
}

/**
 * 층별 결과 → 판정. FAIL은 "백테스트에 쓰면 안 된다", WARN은 "쓰되 한계를 명시하라".
 * 키움 일봉 대조는 같은 소스·같은 보정이라 편차가 사실상 0이어야 정상(엄격),
 * Yahoo 대조는 보정 정책이 달라 계통 편차가 날 수 있다(느슨 — 계통이면 WARN에 사유 표시).
 */
export function verdictOf({ structure, splices, kiwoomCmp, yahooCmp, yahooVol }) {
  const fails = []
  const warns = []
  const s = structure
  if (s.ohlcBad || s.offGrid || s.weekend || s.dup || s.unsorted || s.nonPositive)
    fails.push(
      `구조 위반 ohlc=${s.ohlcBad} 격자=${s.offGrid} 주말=${s.weekend} 중복=${s.dup} 역순=${s.unsorted} 비양수=${s.nonPositive}`,
    )
  if (s.excessDays.length) fails.push(`봉 초과일 ${s.excessDays.length}일(${s.excessDays.slice(0, 2).join(',')})`)
  if (s.outOfSession) warns.push(`장외 시간 봉 ${s.outOfSession}개`)
  if (splices.length)
    fails.push(`수정주가 스플라이스 의심 ${splices.length}건(${splices.map((x) => `${x.date} ${x.gapPct}%`).slice(0, 2).join(', ')}) → 파일 삭제 후 전체 재수집`)
  if (s.days && s.thinDays.length > s.days * 0.05) warns.push(`구멍 난 날 ${s.thinDays.length}/${s.days}일`)
  if (s.zeroVolDays.length) warns.push(`거래량 0인 날 ${s.zeroVolDays.length}일`)
  if (kiwoomCmp && kiwoomCmp.n) {
    if (kiwoomCmp.badPct > 1) fails.push(`키움 일봉 불일치 ${kiwoomCmp.badPct.toFixed(1)}% (같은 소스인데 어긋남 — 파싱·병합 버그 의심)`)
  } else if (kiwoomCmp) warns.push('키움 일봉 겹침 0일 — 교차 불가')
  if (yahooCmp && yahooCmp.n) {
    const systematic = yahooCmp.medianSignedDevPct != null && Math.abs(yahooCmp.medianSignedDevPct) > 0.1
    if (yahooCmp.badPct > 2)
      warns.push(
        systematic
          ? `Yahoo 계통 편차 중앙값 ${yahooCmp.medianSignedDevPct.toFixed(2)}% (보정 기준 차이 — 벤치 혼용 금지)`
          : `Yahoo 산발 불일치 ${yahooCmp.badPct.toFixed(1)}% (특정일 오류 의심 — worst 확인)`,
      )
  }
  if (yahooVol && yahooVol.n && yahooVol.medianRatio != null) {
    if (yahooVol.medianRatio < 0.5 || yahooVol.medianRatio > 1.1)
      warns.push(`거래량 비율 이상 중앙값 ${yahooVol.medianRatio.toFixed(2)} (결측·중복·단위 의심)`)
  }
  return { level: fails.length ? 'FAIL' : warns.length ? 'WARN' : 'PASS', fails, warns }
}
