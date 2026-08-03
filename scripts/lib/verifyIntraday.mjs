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

import { KR_BARS_PER_DAY, SESSION_CLOSE_MIN, kstDate } from './intraday.mjs'

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
 * 하루가 "장 마감까지 닿았다"고 인정하는 마지막 봉의 최소 시작시각(KST 분).
 *
 * 왜 개수가 아니라 **시각**을 보는가 (2026-08-03 실측으로 밝혀진 사고):
 *   기존 게이트는 `봉 개수 ≥ 78×0.8 = 62.4`만 봤다. 그런데 야후 5분봉은 하루 72봉을
 *   09:00~**14:55**로 주고 끝난다 — 개수 게이트는 통과하지만 **15:00~15:30이 통째로 없다.**
 *   한국장의 공식 종가는 15:20~15:30 종가 단일가에서 정해지므로, 이 데이터를 일봉으로
 *   집계하면 "종가"가 실제 종가가 아니라 **15:00 직전 가격**이 된다.
 *   80종목 4,800일 전수 조사: **96.7%가 14:55에 끝난다.** KRX 일별 정본 종가와 대조하면
 *   88.5%가 0.1% 허용치를 벗어나고 평균 절대편차 0.712%(부호 중앙값 −0.084% — 계통 편차가
 *   아니라 산발, 즉 마감 구간 가격 변동 그 자체다).
 *   개수만 세는 게이트가 이 결함을 몇 달 동안 통과시켰다. 그래서 **마감 도달 여부**를 본다.
 *
 * 15:15(915분)로 잡은 이유: 14:55(895분) 절단은 20분 차이로 확실히 잡으면서,
 * 마지막 봉이 15:20·15:25·15:30 중 무엇으로 찍히든 통과시킨다.
 * ⚠️ **키움 5분봉의 마지막 봉 시각이 정확히 몇 분인지는 `[미검증]`이다** — 첫 실제 수집
 * 응답으로 확정한 뒤 이 상수를 조이고 주석의 [미검증]을 지운다(글로벌 규칙 4).
 */
// 정의는 intraday.mjs 하나뿐이다 — 두 곳에 두면 조용히 갈라진다.
export { SESSION_CLOSE_MIN }

/**
 * ① 구조 무결성 검사.
 * 정규장 09:00–15:30(장 시작 540분~930분, 봉 시작시각 기준) 밖의 봉,
 * OHLC 역전, 5분 격자 이탈, 중복·역순, 주말 봉을 센다.
 * thinDays: 봉이 정상(78개)의 80% 미만인 날(장 단축·수집 구멍).
 * truncatedDays: 봉 수는 충분한데 **마지막 봉이 SESSION_CLOSE_MIN 이전**인 날 —
 *   종가 단일가 구간이 없으므로 이 날의 "종가"는 실제 종가가 아니다.
 * excessDays: 79개 초과인 날(중복·시간축 오염 의심 — 정상적으론 불가능).
 * fullDays: thin·truncated 둘 다 아닌 날 — **일봉 대조는 이 날들만 쓴다.**
 */
export function checkStructure(bars) {
  const r = {
    bars: bars.length,
    ohlcBad: 0,
    offGrid: 0,
    outOfSession: 0,
    outOfSessionTimes: new Map(),
    afterHours: 0,
    weekend: 0,
    dup: 0,
    unsorted: 0,
    nonPositive: 0,
    days: 0,
    firstDate: null,
    lastDate: null,
    thinDays: [],
    truncatedDays: [], // 봉 수는 충분한데 마감 구간이 없는 날(종가가 실제 종가가 아니다)
    lastBarMinHist: new Map(), // 막봉 시작시각(분) → 일수 — 절단의 지문을 눈에 보이게
    excessDays: [],
    zeroVolDays: [],
    fullDays: [], // 봉 수도 충분하고 마감까지 닿은 날 — 일봉 대조는 이 날들만 쓴다
  }
  if (!bars.length) return r
  const byDay = new Map() // date → { n, vol, lastMin }
  let prevTs = -Infinity
  for (const b of bars) {
    if (!(b.o > 0 && b.h > 0 && b.l > 0 && b.c > 0)) r.nonPositive++
    else if (b.l > Math.min(b.o, b.c) + 1e-9 || b.h < Math.max(b.o, b.c) - 1e-9) r.ohlcBad++
    if (b.ts % FIVE_MIN !== 0) r.offGrid++
    const mod = kstMinOfDay(b.ts)
    if (mod > 930 && mod <= 965) {
      // 장후 시간외 종가매매 봉(15:35~16:05 시작시각) — 2026-07-31 실측으로 확정:
      // 하루 ~1개, 유동성 비례, 체결가는 당일 종가와 동일(키움 일봉 교차 0.00x%로 확인).
      // 데이터 오류가 아니므로 WARN 대상이 아니다. 단 장중 전략 엔진은 이 봉을 신호에
      // 쓰면 안 되므로(정규장 밖) 개수를 따로 세어 보고한다.
      r.afterHours++
    } else if (mod < 540 || mod > 930) {
      r.outOfSession++
      // 어느 시각의 봉이 장외로 찍히는지 — 원인 진단용(예: 전부 15:35면 종가 동시호가 표기 문제)
      r.outOfSessionTimes.set(mod, (r.outOfSessionTimes.get(mod) ?? 0) + 1)
    }
    const dow = kstDow(b.ts)
    if (dow === 0 || dow === 6) r.weekend++
    if (b.ts === prevTs) r.dup++
    else if (b.ts < prevTs) r.unsorted++
    prevTs = b.ts
    const d = kstDate(b.ts)
    const cur = byDay.get(d) ?? { n: 0, vol: 0, lastMin: -1, lastTs: -Infinity }
    cur.n++
    cur.vol += b.v ?? 0
    // 막봉은 "가장 늦은 봉"이지 "배열 마지막 봉"이 아니다 — 역순 데이터에서도 맞게 잡는다.
    if (b.ts > cur.lastTs) {
      cur.lastTs = b.ts
      cur.lastMin = mod
    }
    byDay.set(d, cur)
  }
  const days = [...byDay.keys()].sort()
  r.days = days.length
  r.firstDate = days[0]
  r.lastDate = days[days.length - 1]
  for (const d of days) {
    const { n, vol, lastMin } = byDay.get(d)
    r.lastBarMinHist.set(lastMin, (r.lastBarMinHist.get(lastMin) ?? 0) + 1)
    // 두 게이트를 **둘 다** 통과해야 대조에 쓴다: 개수(구멍 없음) + 마감 도달(종가 유효).
    // 개수만 보던 시절 야후의 14:55 절단이 몇 달을 통과했다(위 SESSION_CLOSE_MIN 주석).
    const thin = n < KR_BARS_PER_DAY * 0.8
    const truncated = lastMin < SESSION_CLOSE_MIN
    if (thin) r.thinDays.push(d)
    if (truncated) r.truncatedDays.push(d)
    if (!thin && !truncated) r.fullDays.push(d)
    if (n > KR_BARS_PER_DAY + 1) r.excessDays.push(d)
    if (vol === 0) r.zeroVolDays.push(d)
  }
  return r
}

/** 자정 기준 경과 분 → "15:25" */
export function fmtMin(m) {
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}

/** 막봉 시각 분포를 사람이 읽는 한 줄로 — "14:55×4640 15:00×80" 형태(많은 순 3개). */
export function lastBarMinSummary(hist, top = 3) {
  return [...(hist ?? new Map()).entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, top)
    .map(([m, n]) => `${fmtMin(m)}×${n}`)
    .join(' ')
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
export function verdictOf({ structure, splices, kiwoomCmp, kiwoomVol, yahooCmp, yahooVol }) {
  const fails = []
  const warns = []
  const s = structure
  if (s.ohlcBad || s.offGrid || s.weekend || s.dup || s.unsorted || s.nonPositive)
    fails.push(
      `구조 위반 ohlc=${s.ohlcBad} 격자=${s.offGrid} 주말=${s.weekend} 중복=${s.dup} 역순=${s.unsorted} 비양수=${s.nonPositive}`,
    )
  if (s.excessDays.length) fails.push(`봉 초과일 ${s.excessDays.length}일(${s.excessDays.slice(0, 2).join(',')})`)
  if (s.outOfSession) warns.push(`장외 시간 봉 ${s.outOfSession}개(${lastBarMinSummary(s.outOfSessionTimes)})`)
  if (splices.length)
    fails.push(`수정주가 스플라이스 의심 ${splices.length}건(${splices.map((x) => `${x.date} ${x.gapPct}%`).slice(0, 2).join(', ')}) → 파일 삭제 후 전체 재수집`)
  if (s.days && s.thinDays.length > s.days * 0.05) warns.push(`구멍 난 날 ${s.thinDays.length}/${s.days}일`)
  // 마감 절단 — **키움 일봉 불일치보다 먼저** 판정한다. 절단된 데이터를 일봉과 대조하면
  // "불일치 88%"라는 2차 증상만 보이고 원인(마감 구간 결측)은 안 보이기 때문이다.
  // 2026-08-03에 실제로 그렇게 오진했다: 키움 파싱 버그를 의심했는데 범인은 야후 누적분이었다.
  if (s.days && s.truncatedDays.length) {
    const ratio = s.truncatedDays.length / s.days
    const msg =
      `마감 구간 결측 ${s.truncatedDays.length}/${s.days}일 — 막봉이 ${fmtMin(SESSION_CLOSE_MIN)} 이전에 끝난다` +
      ` (막봉 시각 ${lastBarMinSummary(s.lastBarMinHist)}).` +
      ` 한국장 공식 종가는 15:20~15:30 종가 단일가에서 정해지므로 이 날들의 "종가"는 실제 종가가 아니다` +
      ` → 일봉 대조에서 제외했고, 장중 전략·종가 기준 신호에 쓰면 안 된다.`
    if (ratio > 0.05) fails.push(msg)
    else warns.push(`${msg} (장 단축일일 수 있다 — 비율 ${(ratio * 100).toFixed(1)}%)`)
  }
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
  // 거래량: 키움 일봉(같은 소스) 대조가 1차 기준 — 여기가 어긋나면 우리 데이터 결측·중복.
  // 키움과는 맞는데 Yahoo와만 어긋나면 Yahoo 측 이상(보정·단위 차이)으로 분류한다.
  const kiwoomVolOk = kiwoomVol && kiwoomVol.n && kiwoomVol.medianRatio != null && kiwoomVol.medianRatio >= 0.9 && kiwoomVol.medianRatio <= 1.05
  if (kiwoomVol && kiwoomVol.n && kiwoomVol.medianRatio != null && !kiwoomVolOk)
    warns.push(`키움 일봉 대비 거래량 비율 ${kiwoomVol.medianRatio.toFixed(2)} (봉 결측·중복 의심)`)
  if (yahooVol && yahooVol.n && yahooVol.medianRatio != null) {
    if (yahooVol.medianRatio < 0.5 || yahooVol.medianRatio > 1.1)
      warns.push(
        kiwoomVolOk
          ? `거래량 Yahoo와만 불일치(중앙값 ${yahooVol.medianRatio.toFixed(2)}) — 키움 일봉과는 일치, Yahoo 측 이상 [추정]`
          : `거래량 비율 이상 중앙값 ${yahooVol.medianRatio.toFixed(2)} (결측·중복·단위 의심)`,
      )
  }
  return { level: fails.length ? 'FAIL' : warns.length ? 'WARN' : 'PASS', fails, warns }
}
