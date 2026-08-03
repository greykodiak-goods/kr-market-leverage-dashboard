// 5분봉 파싱·누적 병합 — 순수 함수만 둔다(테스트 가능).
//
// 수집 소스 (2026-08-03 대표 지시 "5분봉도 키움으로 전환"):
//   정본은 **키움 REST ka10080 분봉**이다(`scripts/kiwoom-backfill.mjs`).
//   매일 증분(`--daily`)과 주간 소급 보정(옵션 없음)이 같은 저장소에 병합된다.
//   구 수집 경로였던 Yahoo v8 5분봉(60일 롤링)은 제거됐다 — 다만 **2026-08-03 이전
//   구간에는 Yahoo로 받은 봉이 저장소에 남아 있다**(같은 파일에 병합됨). 그래서
//   병합·대조 함수는 소스 중립으로 유지한다.
//
// 저장 포맷은 컬럼형이다. 봉마다 키 이름을 반복하면 용량이 몇 배가 된다
// (일봉 캐시에서 이미 localStorage 한도를 터뜨린 전례가 있어 같은 방식을 쓴다).

/** 국장 정규장 09:00–15:30 = 390분 → 5분봉 78개/일 */
export const KR_BARS_PER_DAY = 78

/**
 * 감시목록 폴백 시드 — 네이버 시총 랭킹 조회가 죽었을 때만 쓴다.
 * [추정 스냅샷 2026-07 기준, 정본은 실행 시점 랭킹] 순위 정확성보다
 * "유동성 있는 대형주 표본"이면 충분하다.
 */
export const SEED_SYMBOLS = [
  ...[
    '005930', '000660', '373220', '207940', '005380', '000270', '068270', '105560', '035420', '329180',
    '055550', '012450', '028260', '012330', '005490', '032830', '009540', '086790', '051910', '042660',
    '138040', '000810', '035720', '006400', '033780', '096770', '066570', '034020', '017670', '316140',
    '030200', '259960', '011200', '402340', '010130', '015760', '024110', '003550', '010140', '086280',
  ].map((c) => `${c}.KS`),
  ...[
    '196170', '247540', '086520', '028300', '214450', '000250', '214150', '141080', '145020', '277810',
    '087010', '950160', '348370', '035900', '041510', '257720', '058470', '068760', '310210', '078600',
    '240810', '039030', '036930', '357780', '403870', '089030', '005290', '095340', '399720', '237690',
    '225570', '293490', '112040', '263750', '328130', '376300',
  ].map((c) => `${c}.KQ`),
]

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
 *   - ETF·ETN 제외 — 네이버 시총 랭킹은 ETF를 종목과 섞어서 준다(2026-07-30 첫 실행에서
 *     TIGER 미국S&P500이 코스피 상위권에 실제로 들어왔다). 브랜드 접두어로 거른다.
 * 랭킹 순서를 유지하고 topN에서 자른다.
 */
const ETF_BRAND =
  /^(KODEX|TIGER|RISE|KBSTAR|ACE|SOL|PLUS|ARIRANG|HANARO|KOSEF|KIWOOM|WON|1Q|KoAct|TIMEFOLIO|FOCUS|BNK|UNICORN|마이티|히어로즈)\s/i

export function rankingToSymbols(json, market, topN) {
  const suffix = market === 'KOSDAQ' ? '.KQ' : '.KS'
  const out = []
  for (const s of json?.stocks ?? []) {
    const code = s?.itemCode
    const name = s?.stockName ?? ''
    if (!/^\d{6}$/.test(code ?? '')) continue
    if (/우[BC]?$/.test(name)) continue
    if (/스팩|SPAC/i.test(name)) continue
    if (ETF_BRAND.test(name) || /\bETN\b/.test(name)) continue
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
 * 매일 증분 수집의 소급 하한(= 이 시각까지만 거슬러 받는다).
 *
 * 매일 도는 수집은 "어제까지 쌓인 것 뒤"만 받으면 된다. 그래서 기준은
 * **저장소의 최신 봉**이고, 정렬·대조를 위해 하루치(overlapSec)를 겹쳐 받는다.
 * 다만 오래 멈춰 있었거나 신규 편입 종목이면 무한정 거슬러 올라가게 되므로
 * maxDays로 바닥을 깐다(그 이상의 소급은 주간 백필의 몫).
 *
 * @param {number|null} newestExistingTs 저장소 최신 봉 epoch초 (없으면 null)
 * @param {number} nowSec 현재 epoch초
 * @param {number} maxDays 최대 소급 일수 (기본 7)
 * @param {number} overlapSec 겹침 여유 (기본 1일)
 */
export function dailyCutoffTs(newestExistingTs, nowSec, maxDays = 7, overlapSec = 86400) {
  const floor = nowSec - maxDays * 86400
  if (!Number.isFinite(newestExistingTs)) return floor
  return Math.max(floor, newestExistingTs - overlapSec)
}

/**
 * index.json에 실을 심볼 순서.
 *
 * 순서에 의미가 있다 — `scripts/spec-backtest.entry.ts`가 index.json의 순서를
 * "수집 당시 시총 랭킹 순"으로 읽어 상위 20을 자른다. 그래서 오늘 랭킹(preferred)
 * 순서를 앞에 두고, 랭킹에서 빠졌지만 계속 누적 중인 종목(고아)을 뒤에 코드순으로 붙인다.
 * 실제 파일이 있는 심볼(stored)만 남긴다 — 수집 실패로 파일이 없는 종목은 싣지 않는다.
 */
export function orderIndexSymbols(preferred, stored) {
  const have = new Set(stored ?? [])
  const out = []
  const seen = new Set()
  for (const s of preferred ?? []) {
    if (have.has(s) && !seen.has(s)) {
      out.push(s)
      seen.add(s)
    }
  }
  for (const s of [...have].sort()) if (!seen.has(s)) out.push(s)
  return out
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
