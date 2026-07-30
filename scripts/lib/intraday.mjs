// 5분봉 파싱·누적 병합 — 순수 함수만 둔다(테스트 가능).
//
// 왜 누적이 필요한가:
//   Yahoo v8 chart는 interval=5m 을 지원하지만 **최근 60일치만** 준다(1m은 7일).
//   백테스트에 쓰려면 매일 받아 쌓아야 한다. 60일 롤링 윈도우이므로 오늘부터
//   모으면 시간이 갈수록 길어진다 — 6개월 뒤엔 6개월치가 된다.
//   과거를 소급해 늘릴 방법은 (무료 경로에는) 없다. 이건 시간이 해결하는 종류의 제약이다.
//
// 저장 포맷은 컬럼형이다. 봉마다 키 이름을 반복하면 용량이 몇 배가 된다
// (일봉 캐시에서 이미 localStorage 한도를 터뜨린 전례가 있어 같은 방식을 쓴다).

/** 국장 정규장 09:00–15:30 = 390분 → 5분봉 78개/일 */
export const KR_BARS_PER_DAY = 78

/**
 * Yahoo v8 chart 응답 → 5분봉 배열.
 * ts는 epoch **초**(Yahoo 원본 그대로). 결측(null OHLC) 봉은 버리고 개수를 보고한다.
 */
export function parseYahooIntraday(json) {
  const res = json?.chart?.result?.[0]
  if (!res) {
    const msg = json?.chart?.error?.description ?? 'chart.result 없음'
    throw new Error(`Yahoo 응답 파싱 실패: ${msg}`)
  }
  const ts = res.timestamp ?? []
  const q = res.indicators?.quote?.[0] ?? {}
  const granularity = res.meta?.dataGranularity ?? null
  const tz = res.meta?.exchangeTimezoneName ?? null
  const gmtoffset = res.meta?.gmtoffset ?? null

  const bars = []
  let dropped = 0
  for (let i = 0; i < ts.length; i++) {
    const o = q.open?.[i]
    const h = q.high?.[i]
    const l = q.low?.[i]
    const c = q.close?.[i]
    const v = q.volume?.[i]
    if ([o, h, l, c].some((x) => x == null || !Number.isFinite(x))) {
      dropped++
      continue
    }
    bars.push({ ts: ts[i], o, h, l, c, v: Number.isFinite(v) ? v : 0 })
  }
  return { bars, dropped, granularity, tz, gmtoffset }
}

/**
 * 기존 누적분 + 새로 받은 분을 병합한다.
 *
 * 규칙:
 *   - ts 기준 중복 제거. **새 데이터가 이긴다**(장중에 받은 미완성 봉이 마감 후 확정값으로 갱신되므로).
 *   - 시간 오름차순 정렬 보장.
 *   - 원본 배열을 변형하지 않는다.
 */
export function mergeBars(existing, incoming) {
  const m = new Map()
  for (const b of existing ?? []) if (Number.isFinite(b?.ts)) m.set(b.ts, b)
  for (const b of incoming ?? []) if (Number.isFinite(b?.ts)) m.set(b.ts, b) // 새 값 우선
  return [...m.values()].sort((a, b) => a.ts - b.ts)
}

/** 컬럼형으로 압축 — 키 반복 제거 */
export function packBars(bars) {
  return {
    ts: bars.map((b) => b.ts),
    o: bars.map((b) => b.o),
    h: bars.map((b) => b.h),
    l: bars.map((b) => b.l),
    c: bars.map((b) => b.c),
    v: bars.map((b) => b.v),
  }
}

export function unpackBars(p) {
  if (!p?.ts) return []
  const out = []
  for (let i = 0; i < p.ts.length; i++) {
    out.push({ ts: p.ts[i], o: p.o[i], h: p.h[i], l: p.l[i], c: p.c[i], v: p.v[i] })
  }
  return out
}

/** epoch초 → KST 날짜 'YYYY-MM-DD' (거래일 집계용) */
export function kstDate(tsSec) {
  const d = new Date(tsSec * 1000 + 9 * 3600 * 1000)
  return d.toISOString().slice(0, 10)
}

/**
 * 커버리지 요약 — 얼마나 쌓였고 구멍이 있는지.
 * 백테스트를 돌리기 전에 "이 데이터로 판정해도 되나"를 보는 용도다.
 */
export function coverage(bars) {
  if (!bars.length) return { days: 0, bars: 0, firstDate: null, lastDate: null, thinDays: [], avgBarsPerDay: 0 }
  const byDay = new Map()
  for (const b of bars) {
    const d = kstDate(b.ts)
    byDay.set(d, (byDay.get(d) ?? 0) + 1)
  }
  const days = [...byDay.keys()].sort()
  // 봉이 정상 개수의 80% 미만인 날 = 구멍(장 단축·수집 실패)
  const thinDays = days.filter((d) => byDay.get(d) < KR_BARS_PER_DAY * 0.8)
  return {
    days: days.length,
    bars: bars.length,
    firstDate: days[0],
    lastDate: days[days.length - 1],
    thinDays,
    avgBarsPerDay: bars.length / days.length,
  }
}

/**
 * 네이버 시총 랭킹 응답 → 감시 심볼 목록.
 *
 * 유니버스 정책(전략 스펙과 동일)에 따라 걸러낸다:
 *   - 우선주 제외: 이름이 '우'/'우B'/'우C'로 끝나거나 코드가 6자리 숫자가 아닌 것
 *     (우선주 변형 코드 00088K 등 — Yahoo 심볼도 없다)
 *   - 스팩 제외
 * 랭킹 순서를 유지하고 topN에서 자른다.
 */
export function rankingToSymbols(json, market, topN) {
  const suffix = market === 'KOSDAQ' ? '.KQ' : '.KS'
  const out = []
  for (const s of json?.stocks ?? []) {
    const code = s?.itemCode
    const name = s?.stockName ?? ''
    if (!/^\d{6}$/.test(code ?? '')) continue
    if (/우[BC]?$/.test(name)) continue
    if (/스팩|SPAC/i.test(name)) continue
    out.push({ symbol: code + suffix, name })
    if (out.length >= topN) break
  }
  return out
}

/**
 * 최종 감시목록 = 오늘 랭킹 ∪ 기존 누적 종목 (∪ 시드 — 랭킹 실패 시).
 *
 * 기존 누적 종목을 유지하는 이유: 시총 순위는 매일 바뀐다. 랭킹에서 빠졌다고
 * 수집을 끊으면 그 종목의 누적 구간이 고아가 되고, 나중에 다시 들어오면
 * 중간에 구멍이 생긴다. 한 번 시작한 종목은 계속 쌓는다(용량은 index가 보고).
 */
export function buildWatchlist(ranked, existingSymbols, seedSymbols) {
  const set = new Set()
  for (const r of ranked) set.add(r.symbol)
  for (const s of existingSymbols ?? []) set.add(s)
  if (ranked.length === 0) for (const s of seedSymbols ?? []) set.add(s)
  return [...set]
}

/**
 * 5분봉 → 일봉 집계. 조건식의 일봉 조건(등락률·양봉·이평)을 같은 데이터에서
 * 계산하려면 필요하다. 서로 다른 소스를 섞으면 정합성이 깨진다.
 */
export function toDailyBars(bars) {
  const byDay = new Map()
  for (const b of bars) {
    const d = kstDate(b.ts)
    const cur = byDay.get(d)
    if (!cur) {
      byDay.set(d, { date: d, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v })
    } else {
      cur.h = Math.max(cur.h, b.h)
      cur.l = Math.min(cur.l, b.l)
      cur.c = b.c // 마지막 봉의 종가
      cur.v += b.v
    }
  }
  return [...byDay.values()].sort((a, b) => (a.date < b.date ? -1 : 1))
}
