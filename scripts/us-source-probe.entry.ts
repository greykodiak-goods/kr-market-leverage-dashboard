// 미장 시세 소스 실사 — **무엇이 상폐 종목을 주는가**를 측정하는 프로브.
//
// 왜 만드는가 (2026-08-03 대표 질문: "미장 데이터는 야후뿐이야? 신뢰성 높냐? 키움엔 없나?")
//   야후의 문제는 값이 틀린 게 아니라 **죽은 종목을 안 주는 것**이다. 41차 미장 실행에서
//   2000년 유니버스 80종목 중 56종목만 확보(70%)됐고, 실패 6건 중 5건이 상폐사였다
//   (WCOM 파산·YHOO 피인수·TYC 합병·CELG 피인수·WBA 비상장전환). 나머지 1건 BK(BNY Mellon)는
//   **살아 있는 회사인데 404** — 야후 자체의 불안정성일 수 있어 재현 확인이 필요하다.
//   상폐 누락은 백테스트에서 **에러 없이 성적을 부풀리는** 최악의 실패 방식이다(생존편향).
//
// 이 프로브가 답하는 질문은 딱 하나다:
//   **"소스가 죽은 종목에 무엇이라고 답하는가 — 데이터를 주는가(ok) · 없다고 하는가(absent) ·
//     소스 자체가 실패하는가(error)?"**
//   이 셋을 섞으면 프로브가 오히려 사고를 만든다. 그래서 `applyLiveness()`가
//   **대조군(살아있는 티커)이 성공한 소스에서만 "absent"를 신뢰**하고, 대조군까지 실패한
//   소스의 "absent"는 전부 error로 강등한다(규칙 4-2 "정상 0건과 실패 0건을 구분").
//
// ⚠️ **티커 재사용 함정** — 미국 티커는 회사가 사라지면 재배정된다(LU=Lucent→Lufax,
//   S=Sprint→SentinelOne). 소스가 "데이터를 줬다"고 그게 그 회사인 것이 아니다.
//   `judgeCompany()`가 **응답의 첫/마지막 봉 날짜를 그 회사의 실제 상장폐지 이벤트와 대조**해
//   `reused`(마지막 봉이 상폐 후) · `mismatch`(첫 봉이 상폐 후) · `partial` · `match`로 가른다.
//   이 대조 없이 "커버리지 있음"으로 세면 안 된다.
//
// ─────────────────────────────────────────────────────────────────────────────
// 🔴 외부 API 사전 조사 (전역 규칙 4 — 착수 전 다섯 가지, 2026-08-03 조사)
//
// ■ 트랙 A — 키움 REST 해외(미국)주식  **문서상 존재 확인됨**
//   근거: 키움증권 공식 GitHub `Kiwoom-Securities/Kiwoom-REST-API`
//         `examples/미국주식/` 아래 12개 하위 분류(계좌·관심종목·순위정보·시세·실시간시세·
//         업종·조건검색·종목정보·주문·차트·투자정보·환전)가 실재한다. README는 "미국주식
//         134개" 예제를 명시한다.
//   ① 인증: 국내와 **같은 OAuth2**(`POST /oauth2/token`, appkey/secretkey → Bearer).
//      해외 전용 별도 승인·이용료가 있는지는 **공식 문서에서 확인하지 못했다 [미검증]**.
//      (키움 REST 신청 안내에는 "현재는 국내주식(ETF/ETN 포함)만 거래 가능"이라는 문구가
//       남아 있는 페이지가 있으나 이는 **거래** 기준 서술이고 시세 조회 권한과 같은지 불명.
//       → 첫 실행의 실제 응답(return_code/return_msg)으로 확정한다.)
//      운영키와 모의투자키는 **서로 다르다**(README: "운영(real)과 모의투자(demo)는 키가
//      서로 다릅니다" · 2026-07-30 실측 오류 8030 투자구분 불일치).
//   ② 한도: 해외 엔드포인트의 문서화된 수치 상한을 **확인하지 못했다 [미검증]**.
//      공식 예제는 페이지 간 `REQUEST_DELAY_SECONDS = 0.2`, `MAX_PAGES = 10`을 쓴다.
//      국내 실측으로는 토큰 발급·조회 모두 429가 난다 → `lib/kiwoom.mjs`의 350ms 스로틀 +
//      429 백오프 재시도를 그대로 탄다(그 파일은 수정하지 않는다).
//   ③ 필드·경로 (공식 예제 소스에서 확정):
//        일봉  api-id `usa06012`  path `/api/us/chart`
//              body { stex_tp, stk_cd, strt_dt(YYYYMMDD), upd_stkpc_tp, exrt_appl_tp }
//        분봉  api-id `usa06011`  path `/api/us/chart`  (+ tic_scope)
//        일별시세 api-id `usa20590` path `/api/us/mrkcond`
//        종목정보 api-id `usa10100` path `/api/us/stkinfo`  body { stex_tp, stk_cd }
//        `stex_tp` = NA(AMEX) · ND(NASDAQ) · NY(NYSE) — **필수**
//        응답 행 배열 키 `result_list`, 행 필드
//          dt(일자) · cur_prc(현재가=종가) · open_pric · high_pric · low_pric ·
//          acc_trde_qty(누적거래량) · pred_pre · flu_rt · upd_stkpc_tp · upd_rt
//        가격에 대비부호(+/-)가 붙을 수 있어 `numAbs`로 정규화한다(국내와 동일 규약).
//   ④ 데이터 범위: **문서에 없다 [미검증]**. `strt_dt`가 "그 날짜부터 앞으로"인지
//      "그 날짜에서 뒤로"인지도 문서로 확정되지 않았다 → 프로브가 **요청한 날짜와 실제
//      돌아온 첫/마지막 봉을 함께 출력**해 방향과 범위를 실측으로 확정한다.
//   ⑤ 실패 표현: 국내와 같이 **HTTP 200 본문의 `return_code`/`return_msg`** 로 온다(실측).
//      해외 엔드포인트도 같은지는 [미검증] → 파서가 return_code≠0이면 던지고, 행 배열이
//      아예 없으면(키 부재) 던진다. 빈 배열만 "정상 0건(absent)"으로 인정한다.
//   ⚠️ 서버: `lib/kiwoom.mjs` 기본값은 **모의서버**다. 미국주식 조회가 모의서버에서
//      제공되는지는 [미검증] — 안 되면 이 프로브가 그 사실을 그대로 보고한다.
//      다른 서버가 필요하면 **`KIWOOM_BASE_URL` 환경변수로만** 받는다(규칙 2: 실서버 주소를
//      코드에 두지 않는다). 서버 전환 판단은 총괄·대표 몫이지 이 스크립트의 기본값이 아니다.
//   🚫 주문·이체는 이 파일에 없다. 조회 3종(stkinfo·chart)만 호출한다(규칙 2 1단계).
//
// ■ 트랙 B — 무료 대안 (후보 선정 근거 포함)
//   채택
//     · **stooq** — 키 불필요 CSV(`stooq.com/q/d/l/?s=<t>.us&i=d`). 가장 마찰이 적어
//       "죽은 종목을 주는가"를 즉시 잴 수 있다. ①인증 없음 ②한도: 문서화된 수치 없음
//       [미검증] — 다만 초과 시 본문에 `Exceeded the daily hits limit` 문자열을 주는 것으로
//       알려져 있어 **그 문자열은 absent가 아니라 error로 처리**한다 ③CSV 헤더
//       `Date,Open,High,Low,Close,Volume` ④범위 20년+ 주장, 상폐 커버리지 불명 [미검증]
//       ⑤실패 표현: **HTTP 200 본문에 `No data`** — 상태코드만 보면 놓친다.
//     · **tiingo** — 무료 티어·키 필요. 선정 이유는 하나다: `supported_tickers` 메타에
//       **`endDate` 필드가 있다** = 종료된 티커를 자료구조상 인정한다(ticker·exchange·
//       assetType·priceCurrency·startDate·endDate). ①인증 Authorization: Token <key>
//       ②한도: 무료 티어 상한이 있으나 정확한 수치 [미검증] ③필드 date·open·high·low·
//       close·volume·adjClose… ④"30년+ 주식 데이터"(공개 소개 기준) ⑤미확인 티커는 404 +
//       JSON `detail` [미검증].
//     · **alphavantage** — 무료 키 필요. 선정 이유: `LISTING_STATUS&state=delisted`라는
//       **상장폐지 전용 엔드포인트를 공식 제공**한다(자산 생애주기·생존편향 연구 목적이라고
//       명시). ①인증 apikey 쿼리 ②한도 **무료 25 req/day · 5 req/min**(초과 시 200 본문
//       `Note`/`Information`) ③`Time Series (Daily)` → `1. open`…`5. volume`
//       ④20년+ ⑤**오류를 HTTP 200 본문 `Error Message`로** 준다. 단 "상폐·극소거래 종목은
//       빈 배열을 줄 수 있다"는 경고가 공개 문서에 있어 **커버리지는 종목별로 실측해야 한다**.
//     · **yahoo** — 대조 소스(현행). 새로 채택하는 게 아니라 **BK 404의 재현 여부**와
//       상폐 8종의 현재 상태를 같은 표에 놓기 위해 넣는다.
//   기각
//     · **Nasdaq Data Link(구 Quandl) WIKI EOD** — 무료지만 **2018-03-27로 갱신 중단**된
//       은퇴 데이터셋이라 2019년 CELG·2016년 TYC 이후를 못 준다. 현재 유지되는 미국 EOD
//       (Sharadar SEP 등)는 유료. → 이 프로브의 질문(무료 상폐 커버리지)에 답할 수 없다.
//     · **SEC EDGAR** — 상폐 사실·공시는 주지만 **가격 시계열이 없다**.
//
//   ⚠️ 키가 필요한 소스는 값이 없으면 **skipped**로 남긴다 — 실패로도 성공으로도 세지 않는다.
//      키 발급은 외부 계정 발급(T0)이라 AI 세션이 하지 않는다. 키가 들어오면 같은 명령이
//      그대로 그 소스를 켠다(추가 작업 없음).
// ─────────────────────────────────────────────────────────────────────────────
//
// 🔴 규칙 1(미래참조 금지)과의 관계: 이 프로브는 **전략을 돌리지 않는다.** 가격을 받아
//   개수·첫봉·마지막봉만 센다. 백테스트 경로에 값을 주입하지 않으므로 절단 불변성과 무관하다.
//
// 실행 (컨테이너는 외부망이 막혀 있다 — GHA/EC2에서 돈다):
//   MODE=free   node scripts/us-source-probe.mjs     # GHA 러너
//   MODE=kiwoom node scripts/us-source-probe.mjs     # EC2(국내 IP·키움 키)
//   MODE=all    node scripts/us-source-probe.mjs
//   env: US_PROBE_SOURCES=stooq,yahoo (필터) · KIWOOM_MAX_PAGES=10 · US_PROBE_TIMEOUT_MS=20000

import { createKiwoomClient, numAbs } from './lib/kiwoom.mjs'
import { loadSecret, maskerFor } from './lib/loadSecret.mjs'
// tiingo 호출은 **공용 모듈이 정본**이다(2026-08-04). 이 프로브와 백테스트 러너(us-lab)가
// 같은 URL·같은 상태코드 분류·같은 파서를 지나야 실사 결과와 실제 수집이 어긋나지 않는다.
// 복붙하면 두 벌이 서로 다르게 썩는다 — 실사에서 확인한 "404=absent / 429=실패"가
// 러너 쪽에서만 뭉개지는 식이다.
import { classifyTiingoStatus, parseTiingoRows, tiingoDailyUrl, tiingoHeaders } from './lib/tiingo'

// ── 0) 타입 ─────────────────────────────────────────────────────────────────

/** 한 번의 (소스 × 티커) 시도 결과 종류. 이 넷을 섞지 않는 것이 이 프로브의 존재 이유다. */
export type ProbeKind =
  | 'ok' // 데이터를 받았다
  | 'absent' // 소스는 살아 있는데 **그 종목이 없다**(정상 0건)
  | 'error' // **소스·인증·한도 쪽 실패**(실패 0건) — 커버리지 판정에 쓰면 안 된다
  | 'skipped' // 키 없음 등으로 시도조차 안 함

export interface Bar {
  /** YYYY-MM-DD */
  date: string
  close: number
}

export interface ParseOutcome {
  kind: 'ok' | 'absent'
  bars: Bar[]
  /** 파싱 근거·비고 (absent 사유 포함) */
  note: string
}

export interface ProbeResult {
  source: string
  ticker: string
  kind: ProbeKind
  bars: number
  firstDate: string | null
  lastDate: string | null
  lastClose: number | null
  /** 페이지 상한에 걸려 잘렸는가 (끝난 것과 구분한다) */
  truncated: boolean
  reason: string
}

export type VerdictCode =
  | 'match' // 그 회사의 이력과 맞는다
  | 'partial' // 그 회사 같지만 마지막 구간이 없다 / 오래 멈췄다
  | 'reused' // 상폐 이후 데이터가 있다 = **다른 회사**(티커 재배정)
  | 'mismatch' // 시작조차 상폐 이후 = 다른 회사
  | 'unknown' // 판정할 데이터가 없다
  | 'n/a' // 응답 자체가 없어 판정 대상이 아니다

export interface Verdict {
  code: VerdictCode
  note: string
}

// ── 1) 대조 기준표 ───────────────────────────────────────────────────────────
//
// 출처: 공개된 기업 이벤트(파산 신청·인수 완료·합병 완료일). **정확한 최종 거래일이 아니라
// 이벤트일**이므로 판정에는 아래 관용치를 함께 쓴다. 종가 밴드는 자릿수 확인용 **소프트
// 경고**이며 판정(verdict)을 뒤집지 않는다 — 밴드를 근거로 커버리지를 부정하지 않는다.

export interface TickerRef {
  ticker: string
  company: string
  /** 키움 stex_tp: ND=NASDAQ · NY=NYSE · NA=AMEX */
  stexTp: 'ND' | 'NY' | 'NA'
  status: 'delisted' | 'live'
  /** 상장폐지·인수 완료 이벤트일 (YYYY-MM-DD) */
  eventDate?: string
  event?: string
  /** 마지막 거래 무렵 종가의 자릿수 범위 (넓게 — 소프트 경고 전용) */
  endCloseBand?: [number, number]
}

/** 측정 대상 — 상폐 8종 */
export const DELISTED_REFS: TickerRef[] = [
  { ticker: 'WCOM', company: 'WorldCom', stexTp: 'ND', status: 'delisted', eventDate: '2002-07-21', event: '파산보호 신청', endCloseBand: [0.02, 3] },
  { ticker: 'LEH', company: 'Lehman Brothers', stexTp: 'NY', status: 'delisted', eventDate: '2008-09-15', event: '파산보호 신청', endCloseBand: [0.02, 5] },
  { ticker: 'ENE', company: 'Enron', stexTp: 'NY', status: 'delisted', eventDate: '2001-12-02', event: '파산보호 신청', endCloseBand: [0.02, 3] },
  { ticker: 'BSC', company: 'Bear Stearns', stexTp: 'NY', status: 'delisted', eventDate: '2008-05-30', event: 'JPMorgan 피인수 완료', endCloseBand: [3, 30] },
  { ticker: 'MER', company: 'Merrill Lynch', stexTp: 'NY', status: 'delisted', eventDate: '2009-01-01', event: 'Bank of America 피인수 완료', endCloseBand: [3, 40] },
  { ticker: 'CELG', company: 'Celgene', stexTp: 'ND', status: 'delisted', eventDate: '2019-11-20', event: 'BMS 피인수 완료', endCloseBand: [60, 150] },
  { ticker: 'YHOO', company: 'Yahoo! Inc.', stexTp: 'ND', status: 'delisted', eventDate: '2017-06-13', event: 'Verizon 매각·Altaba 개명', endCloseBand: [25, 80] },
  { ticker: 'TYC', company: 'Tyco International', stexTp: 'NY', status: 'delisted', eventDate: '2016-09-06', event: 'Johnson Controls 합병', endCloseBand: [20, 70] },
]

/** 대조군 — 살아있는 티커. "소스가 죽었나 / 그 종목이 없나"를 가르는 기준선이다.
 *  BK는 41차에서 야후가 404를 준 종목 — **재현 확인이 이 프로브의 부수 목표**다. */
export const LIVE_REFS: TickerRef[] = [
  { ticker: 'AAPL', company: 'Apple', stexTp: 'ND', status: 'live' },
  { ticker: 'MSFT', company: 'Microsoft', stexTp: 'ND', status: 'live' },
  { ticker: 'JPM', company: 'JPMorgan Chase', stexTp: 'NY', status: 'live' },
  { ticker: 'BK', company: 'BNY Mellon', stexTp: 'NY', status: 'live' },
]

export const ALL_REFS: TickerRef[] = [...LIVE_REFS, ...DELISTED_REFS]

export function refFor(ticker: string): TickerRef | undefined {
  return ALL_REFS.find((r) => r.ticker === ticker)
}

// ── 2) 날짜 유틸 ─────────────────────────────────────────────────────────────

/** 'YYYY-MM-DD' → epoch day. 형식이 아니면 null(추측으로 메우지 않는다). */
export function toDay(date: string | null | undefined): number | null {
  const m = String(date ?? '').match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!m) return null
  return Math.floor(Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000)
}

export function dayDiff(a: string, b: string): number | null {
  const x = toDay(a)
  const y = toDay(b)
  return x == null || y == null ? null : x - y
}

/** 'YYYYMMDD' → 'YYYY-MM-DD'. 아니면 null. */
export function dashDate(compact: string | null | undefined): string | null {
  const m = String(compact ?? '').match(/^(\d{4})(\d{2})(\d{2})$/)
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null
}

export function todayUtc(now: number = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10)
}

// ── 3) 회사 일치 판정 ────────────────────────────────────────────────────────

/** 상폐일보다 이만큼 뒤의 봉이 있으면 **다른 회사**로 본다(티커 재배정). */
export const LATE_TOLERANCE_DAYS = 90
/** 상폐일보다 이만큼 앞에서 끊겼으면 "그 회사이지만 끝 구간이 없다"(partial). */
export const EARLY_TOLERANCE_DAYS = 400
/** 살아있는 티커인데 이보다 오래 멈췄으면 partial(신선도 경고). */
export const LIVE_STALE_DAYS = 21
/** 이보다 적은 봉은 "껍데기 응답" 의심 — 야후가 없는 심볼에 가짜 11봉을 준 전례가 있다. */
export const THIN_BARS = 20

/**
 * 응답이 **그 회사의 이력과 맞는지** 판정한다. 날짜가 하드 근거, 가격은 소프트 경고.
 * 이 함수가 없으면 "데이터를 줬다 = 커버리지 있다"로 잘못 세게 된다(LU·S 사례).
 */
export function judgeCompany(ref: TickerRef, res: ProbeResult, today: string = todayUtc()): Verdict {
  if (res.kind !== 'ok') return { code: 'n/a', note: '' }
  if (!res.firstDate || !res.lastDate || res.bars === 0) return { code: 'unknown', note: '봉이 없다' }

  const notes: string[] = []
  if (res.bars < THIN_BARS) notes.push(`봉 ${res.bars}개뿐 — 껍데기 응답 의심`)
  if (res.truncated) notes.push('페이지 상한에 걸려 잘림(끝난 것 아님)')

  if (ref.status === 'live') {
    const stale = dayDiff(today, res.lastDate)
    if (stale != null && stale > LIVE_STALE_DAYS) {
      notes.push(`최신 봉이 ${stale}일 전 — 갱신 멈춤`)
      return { code: 'partial', note: notes.join(' · ') }
    }
    return { code: 'match', note: notes.join(' · ') }
  }

  const ev = ref.eventDate
  if (!ev) return { code: 'unknown', note: '기준 이벤트일 없음' }

  const lateEnd = dayDiff(res.lastDate, ev)
  const lateStart = dayDiff(res.firstDate, ev)
  if (lateStart != null && lateStart > 0)
    return {
      code: 'mismatch',
      note: [`첫 봉(${res.firstDate})이 ${ref.company} 상폐(${ev}) 이후 — 다른 회사`, ...notes].join(' · '),
    }
  if (lateEnd != null && lateEnd > LATE_TOLERANCE_DAYS)
    return {
      code: 'reused',
      note: [`마지막 봉(${res.lastDate})이 상폐(${ev}) +${lateEnd}일 — 티커 재배정 의심`, ...notes].join(' · '),
    }

  // 가격 자릿수 소프트 검증 (판정을 뒤집지 않는다)
  if (ref.endCloseBand && res.lastClose != null) {
    const [lo, hi] = ref.endCloseBand
    if (res.lastClose < lo || res.lastClose > hi)
      notes.push(`마지막 종가 ${res.lastClose} 가 예상대(${lo}~${hi}) 밖 [경고]`)
  }

  if (lateEnd != null && lateEnd < -EARLY_TOLERANCE_DAYS)
    return { code: 'partial', note: [`상폐(${ev})보다 ${-lateEnd}일 일찍 끊김`, ...notes].join(' · ') }

  return { code: 'match', note: notes.join(' · ') }
}

// ── 4) 소스 생존 게이트 ──────────────────────────────────────────────────────
//
// **이 프로브의 핵심.** "0건"에는 두 종류가 있다.
//   · 정상 0건 = 소스는 살아 있고 그 종목이 없다  → 커버리지 없음의 증거
//   · 실패 0건 = 소스·키·한도가 죽었다            → 아무것도 증명하지 못함
// 대조군(살아있는 티커)이 하나도 성공하지 못한 소스의 absent는 **전부 error로 강등**한다.

export function applyLiveness(rows: ProbeResult[]): ProbeResult[] {
  const liveTickers = new Set(LIVE_REFS.map((r) => r.ticker))
  const aliveBySource = new Map<string, boolean>()
  for (const r of rows) {
    if (!aliveBySource.has(r.source)) aliveBySource.set(r.source, false)
    if (r.kind === 'ok' && liveTickers.has(r.ticker)) aliveBySource.set(r.source, true)
  }
  return rows.map((r) => {
    if (r.kind !== 'absent') return r
    if (aliveBySource.get(r.source)) return r
    return {
      ...r,
      kind: 'error' as ProbeKind,
      reason: `${r.reason} ⚠️ 대조군(살아있는 티커) 전부 실패 — 소스 생존 미확인이라 "없음"을 신뢰할 수 없다`,
    }
  })
}

// ── 5) 파서 (순수 함수 — 네트워크 없이 테스트한다) ───────────────────────────

function finishBars(bars: Bar[], note: string): ParseOutcome {
  bars.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  return bars.length ? { kind: 'ok', bars, note } : { kind: 'absent', bars: [], note: note || '행 0건' }
}

/**
 * stooq CSV. 실패 표현이 **HTTP 200 본문 문자열**이라 상태코드만 보면 놓친다.
 *   · `No data`              → absent (그 종목이 없다)
 *   · `Exceeded the daily hits limit` → **throw**(한도 = 소스 실패, absent 아님)
 *   · 헤더가 기대와 다르면    → throw (조용히 0건으로 넘기지 않는다)
 */
export function parseStooqCsv(text: string): ParseOutcome {
  const body = String(text ?? '').trim()
  if (/exceeded the daily hits limit/i.test(body)) throw new Error('stooq 일일 한도 초과 (본문 문자열) — 소스 실패')
  if (/^no data/i.test(body)) return { kind: 'absent', bars: [], note: 'stooq "No data" (HTTP 200 본문)' }
  const lines = body.split(/\r?\n/).filter((l) => l.trim() !== '')
  if (lines.length === 0) throw new Error('stooq 응답이 비었다 — 빈 응답을 정상 0건으로 취급하지 않는다')
  const header = lines[0].split(',').map((h) => h.trim().toLowerCase())
  const iDate = header.indexOf('date')
  const iClose = header.indexOf('close')
  if (iDate < 0 || iClose < 0)
    throw new Error(`stooq CSV 헤더를 못 읽었다 — 받은 헤더: [${header.join(', ')}] (앞부분: ${body.slice(0, 80)})`)
  const bars: Bar[] = []
  let dropped = 0
  for (const line of lines.slice(1)) {
    const cols = line.split(',')
    const date = String(cols[iDate] ?? '').trim()
    const close = Number(String(cols[iClose] ?? '').trim())
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(close)) {
      dropped++
      continue
    }
    bars.push({ date, close })
  }
  if (bars.length === 0 && dropped > 0) throw new Error(`stooq 행 ${dropped}개를 모두 파싱 실패 — 형식 변경 의심`)
  return finishBars(bars, dropped ? `탈락 ${dropped}행` : '')
}

/**
 * tiingo daily — 빈 배열만 absent, 배열이 아니면 throw.
 * 파싱 본체는 `lib/tiingo.ts`가 정본이다(백테스트 러너와 **같은 코드**를 지난다).
 * 여기서는 프로브의 `ParseOutcome`(날짜·종가만) 모양으로 옮기기만 한다.
 */
export function parseTiingoDaily(json: unknown): ParseOutcome {
  const out = parseTiingoRows(json)
  if (out.absent) return { kind: 'absent', bars: [], note: 'tiingo 빈 배열' }
  const bars: Bar[] = out.rows.map((r) => ({ date: r.date, close: r.close }))
  return finishBars(bars, out.dropped ? `탈락 ${out.dropped}행` : '')
}

/**
 * alphavantage — **오류를 HTTP 200 본문**으로 준다.
 *   · `Error Message`        → absent (잘못된/없는 심볼)
 *   · `Note` / `Information` → throw  (한도 = 소스 실패)
 */
export function parseAlphaVantageDaily(json: unknown): ParseOutcome {
  const o = (json ?? {}) as Record<string, unknown>
  if (o['Note'] || o['Information'])
    throw new Error(`alphavantage 한도·안내 응답(HTTP 200): ${String(o['Note'] ?? o['Information']).slice(0, 160)}`)
  if (o['Error Message'])
    return { kind: 'absent', bars: [], note: `alphavantage "Error Message": ${String(o['Error Message']).slice(0, 100)}` }
  const seriesKey = Object.keys(o).find((k) => /^Time Series/i.test(k))
  if (!seriesKey) throw new Error(`alphavantage 시계열 키를 못 찾음 — 응답 키: [${Object.keys(o).join(', ')}]`)
  const series = o[seriesKey] as Record<string, Record<string, string>>
  const dates = Object.keys(series ?? {})
  if (dates.length === 0) return { kind: 'absent', bars: [], note: 'alphavantage 시계열 0건' }
  const bars: Bar[] = []
  let dropped = 0
  for (const date of dates) {
    const row = series[date] ?? {}
    const closeKey = Object.keys(row).find((k) => /close/i.test(k) && !/adjust/i.test(k)) ?? Object.keys(row).find((k) => /close/i.test(k))
    const close = Number(closeKey ? row[closeKey] : NaN)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(close)) {
      dropped++
      continue
    }
    bars.push({ date, close })
  }
  if (bars.length === 0) throw new Error(`alphavantage ${dates.length}행을 모두 파싱 실패 — 필드명 변경 의심`)
  return finishBars(bars, dropped ? `탈락 ${dropped}행` : '')
}

/**
 * yahoo v8 chart. `chart.error`가 **본문**에 오고 상태코드가 404인 경우가 섞인다.
 * `Not Found` 계열만 absent, 나머지는 throw.
 */
export function parseYahooChart(json: unknown): ParseOutcome {
  const o = (json ?? {}) as Record<string, unknown>
  const chart = o.chart as Record<string, unknown> | undefined
  if (!chart) throw new Error(`yahoo 응답에 chart가 없다 — 키: [${Object.keys(o).join(', ') || '없음'}]`)
  const err = chart.error as Record<string, unknown> | null | undefined
  if (err) {
    const code = String(err.code ?? '')
    const desc = String(err.description ?? '')
    if (/not.?found|no data|invalid/i.test(`${code} ${desc}`))
      return { kind: 'absent', bars: [], note: `yahoo error.code=${code}` }
    throw new Error(`yahoo error.code=${code} — ${desc.slice(0, 120)}`)
  }
  const result = chart.result as unknown[] | null | undefined
  if (!Array.isArray(result) || result.length === 0) return { kind: 'absent', bars: [], note: 'yahoo result 없음' }
  const r0 = result[0] as Record<string, unknown>
  const ts = r0.timestamp as number[] | undefined
  const ind = r0.indicators as Record<string, unknown> | undefined
  const quote = (ind?.quote as Record<string, unknown>[] | undefined)?.[0]
  const closes = quote?.close as (number | null)[] | undefined
  if (!Array.isArray(ts) || !Array.isArray(closes))
    throw new Error(`yahoo timestamp/close를 못 찾음 — result[0] 키: [${Object.keys(r0).join(', ')}]`)
  const bars: Bar[] = []
  let dropped = 0
  for (let i = 0; i < ts.length; i++) {
    const c = closes[i]
    if (typeof ts[i] !== 'number' || typeof c !== 'number' || !Number.isFinite(c)) {
      dropped++
      continue
    }
    bars.push({ date: new Date(ts[i] * 1000).toISOString().slice(0, 10), close: c })
  }
  return finishBars(bars, dropped ? `탈락 ${dropped}행` : '')
}

/**
 * 키움 미국주식 차트(usa06012) / 종목정보(usa10100) 공통 파서.
 * return_code≠0이면 **던진다**(200 본문 오류). 행 배열 키가 아예 없어도 던진다.
 * 빈 배열만 absent로 인정한다.
 */
export function parseKiwoomUsChart(json: unknown): ParseOutcome {
  const o = (json ?? {}) as Record<string, unknown>
  const rc = o.return_code
  if (rc != null && Number(rc) !== 0)
    throw new Error(`키움 return_code=${String(rc)} return_msg="${String(o.return_msg ?? '')}"`)
  let rows: Record<string, unknown>[] | null = null
  if (Array.isArray(o.result_list)) rows = o.result_list as Record<string, unknown>[]
  else {
    // 관용 파싱 — 문서에 없는 키로 바뀌었을 때 "객체 배열인 첫 값"을 행으로 본다.
    for (const v of Object.values(o)) {
      if (Array.isArray(v) && (v.length === 0 || (typeof v[0] === 'object' && v[0] !== null))) {
        rows = v as Record<string, unknown>[]
        break
      }
    }
  }
  if (rows == null)
    throw new Error(`키움 응답에서 행 배열을 못 찾음 — 키: [${Object.keys(o).join(', ') || '없음'}] (문서 대조 필요)`)
  if (rows.length === 0) return { kind: 'absent', bars: [], note: '키움 result_list 0건' }
  const bars: Bar[] = []
  let dropped = 0
  for (const row of rows) {
    const date = dashDate(String(row.dt ?? ''))
    const close = numAbs(row.cur_prc)
    if (date == null || close == null) {
      dropped++
      continue
    }
    bars.push({ date, close })
  }
  if (bars.length === 0) throw new Error(`키움 ${rows.length}행을 모두 파싱 실패 — 행 키: [${Object.keys(rows[0]).join(', ')}]`)
  return finishBars(bars, dropped ? `탈락 ${dropped}행` : '')
}

// ── 6) ParseOutcome → ProbeResult ────────────────────────────────────────────

export function toResult(source: string, ticker: string, out: ParseOutcome, extra: { truncated?: boolean; note?: string } = {}): ProbeResult {
  const bars = out.bars
  const notes = [out.note, extra.note].filter(Boolean).join(' · ')
  return {
    source,
    ticker,
    kind: out.kind,
    bars: bars.length,
    firstDate: bars.length ? bars[0].date : null,
    lastDate: bars.length ? bars[bars.length - 1].date : null,
    lastClose: bars.length ? bars[bars.length - 1].close : null,
    truncated: Boolean(extra.truncated),
    reason: notes,
  }
}

export function errorResult(source: string, ticker: string, reason: string): ProbeResult {
  return { source, ticker, kind: 'error', bars: 0, firstDate: null, lastDate: null, lastClose: null, truncated: false, reason }
}

export function skippedResult(source: string, ticker: string, reason: string): ProbeResult {
  return { source, ticker, kind: 'skipped', bars: 0, firstDate: null, lastDate: null, lastClose: null, truncated: false, reason }
}

// ── 7) 표 · 판정 렌더링 ──────────────────────────────────────────────────────

function pad(s: string, n: number): string {
  // 한글은 2칸 폭으로 센다(표가 어긋나면 사람이 안 읽는다)
  const w = (t: string) => [...t].reduce((a, ch) => a + (ch.charCodeAt(0) > 0x1100 ? 2 : 1), 0)
  const need = Math.max(0, n - w(s))
  return s + ' '.repeat(need)
}

export function renderTable(rows: ProbeResult[], today: string = todayUtc()): string {
  const head = ['소스', '티커', '상태', '봉수', '첫봉', '마지막봉', '판정', '사유']
  const widths = [14, 6, 8, 7, 12, 12, 10, 0]
  const lines: string[] = []
  lines.push(head.map((h, i) => pad(h, widths[i])).join(' '))
  lines.push(widths.map((w) => '-'.repeat(w || 40)).join(' '))
  for (const r of rows) {
    const ref = refFor(r.ticker)
    const v = ref ? judgeCompany(ref, r, today) : { code: 'unknown' as VerdictCode, note: '기준표에 없는 티커' }
    const cells = [
      r.source,
      r.ticker,
      r.kind,
      r.kind === 'ok' ? `${r.bars}${r.truncated ? '+' : ''}` : '-',
      r.firstDate ?? '-',
      r.lastDate ?? '-',
      v.code,
      [r.reason, v.note].filter(Boolean).join(' | '),
    ]
    lines.push(cells.map((c, i) => pad(String(c), widths[i])).join(' '))
  }
  return lines.join('\n')
}

export interface SourceSummary {
  source: string
  delistedMatch: number
  delistedTotal: number
  liveOk: number
  liveTotal: number
  errors: number
  skipped: number
  alive: boolean
}

export function summarize(rows: ProbeResult[], today: string = todayUtc()): SourceSummary[] {
  const delisted = new Set(DELISTED_REFS.map((r) => r.ticker))
  const live = new Set(LIVE_REFS.map((r) => r.ticker))
  const bySource = new Map<string, SourceSummary>()
  for (const r of rows) {
    if (!bySource.has(r.source))
      bySource.set(r.source, { source: r.source, delistedMatch: 0, delistedTotal: 0, liveOk: 0, liveTotal: 0, errors: 0, skipped: 0, alive: false })
    const s = bySource.get(r.source)!
    if (delisted.has(r.ticker)) s.delistedTotal++
    if (live.has(r.ticker)) s.liveTotal++
    if (r.kind === 'error') s.errors++
    if (r.kind === 'skipped') s.skipped++
    if (r.kind === 'ok' && live.has(r.ticker)) {
      s.liveOk++
      s.alive = true
    }
    if (r.kind === 'ok' && delisted.has(r.ticker)) {
      const ref = refFor(r.ticker)!
      // **match만 센다.** reused(티커 재배정)를 커버리지로 세면 이 프로브가 사고를 만든다.
      if (judgeCompany(ref, r, today).code === 'match') s.delistedMatch++
    }
  }
  return [...bySource.values()]
}

/** 판정 한 줄 — "상폐 커버리지가 있는 소스가 있는가 / 유료 검토가 필요한가". */
export function renderVerdict(rows: ProbeResult[], today: string = todayUtc()): string {
  const sums = summarize(rows, today)
  const usable = sums.filter((s) => s.alive && s.delistedMatch > 0)
  const lines: string[] = []
  lines.push('')
  lines.push('■ 소스별 요약 (상폐 8종 중 회사일치 match 개수 / 대조군 성공)')
  for (const s of sums)
    lines.push(
      `  ${pad(s.source, 14)} 상폐 ${s.delistedMatch}/${s.delistedTotal} · 대조군 ${s.liveOk}/${s.liveTotal} · error ${s.errors} · skipped ${s.skipped}${s.alive ? '' : '  ⚠️ 소스 생존 미확인 — 이 행의 "없음"은 근거가 아니다'}`,
    )
  lines.push('')
  if (usable.length === 0) {
    const anyAlive = sums.some((s) => s.alive)
    lines.push(
      anyAlive
        ? '■ 판정: **상폐 커버리지를 확인한 무료 소스가 없다** → 유료 소스(상폐 포함 EOD) 검토가 필요하다.'
        : '■ 판정: **판정 불가** — 살아있는 대조군조차 못 받았다(소스·네트워크·키 실패). 이 실행으로는 아무것도 결론내지 마라.',
    )
  } else {
    const best = usable.sort((a, b) => b.delistedMatch - a.delistedMatch)[0]
    lines.push(
      `■ 판정: **상폐 커버리지가 있는 소스가 있다** — 최상 ${best.source} (상폐 ${best.delistedMatch}/${best.delistedTotal} 회사일치). ` +
        `단 ${best.delistedMatch < best.delistedTotal ? '전량이 아니므로 남은 종목은 여전히 생존편향으로 남는다.' : '전량 일치이므로 교체 후보다.'}`,
    )
  }
  return lines.join('\n')
}

// ── 8) 어댑터 (네트워크) ─────────────────────────────────────────────────────

const TIMEOUT_MS = Number(process.env.US_PROBE_TIMEOUT_MS ?? 20000)

async function getText(url: string, headers: Record<string, string> = {}): Promise<{ status: number; text: string }> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(url, { headers, signal: ctl.signal })
    return { status: res.status, text: await res.text() }
  } finally {
    clearTimeout(timer)
  }
}

function jsonOrThrow(source: string, status: number, text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`${source} 응답이 JSON이 아니다 (HTTP ${status}) — 앞부분: ${text.slice(0, 160).replace(/\s+/g, ' ')}`)
  }
}

async function probeStooq(ref: TickerRef): Promise<ProbeResult> {
  const url = `https://stooq.com/q/d/l/?s=${encodeURIComponent(ref.ticker.toLowerCase())}.us&i=d`
  const { status, text } = await getText(url)
  if (status !== 200) throw new Error(`stooq HTTP ${status}`)
  return toResult('stooq', ref.ticker, parseStooqCsv(text))
}

async function probeTiingo(ref: TickerRef, token: string): Promise<ProbeResult> {
  // URL·헤더·상태코드 분류 전부 공용 모듈이 정본이다(복붙 금지 — 두 벌이 어긋나면
  // "실사에서는 absent였는데 러너에서는 실패"처럼 조용히 갈린다).
  const url = tiingoDailyUrl(ref.ticker, { startDate: '1990-01-01' })
  const { status, text } = await getText(url, tiingoHeaders(token))
  const cls = classifyTiingoStatus(status, text)
  if (cls.kind === 'absent') return toResult('tiingo', ref.ticker, { kind: 'absent', bars: [], note: cls.note })
  return toResult('tiingo', ref.ticker, parseTiingoDaily(jsonOrThrow('tiingo', status, text)))
}

async function probeAlphaVantage(ref: TickerRef, key: string): Promise<ProbeResult> {
  const url = `https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol=${encodeURIComponent(ref.ticker)}&outputsize=full&apikey=${encodeURIComponent(key)}`
  const { status, text } = await getText(url)
  if (status !== 200) throw new Error(`alphavantage HTTP ${status}`)
  return toResult('alphavantage', ref.ticker, parseAlphaVantageDaily(jsonOrThrow('alphavantage', status, text)))
}

async function probeYahoo(ref: TickerRef): Promise<ProbeResult> {
  // range=max 는 interval=1d 를 무시하고 월봉을 주는 조합이 있다(실측) → period1/period2 고정.
  const p2 = Math.floor(Date.now() / 1000)
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ref.ticker)}?period1=0&period2=${p2}&interval=1d`
  const { status, text } = await getText(url, { 'User-Agent': 'Mozilla/5.0 (compatible; kr-market-us-source-probe/1.0)' })
  const json = jsonOrThrow('yahoo', status, text)
  const out = parseYahooChart(json)
  // 404 + chart.error 는 파서가 absent로 판정한다. 그 외 비정상 상태코드는 실패로 남긴다.
  if (status !== 200 && out.kind !== 'absent') throw new Error(`yahoo HTTP ${status}`)
  return toResult('yahoo', ref.ticker, out, { note: status === 200 ? '' : `HTTP ${status}` })
}

/** 키움 조회 3종. 주문·이체는 호출하지 않는다(규칙 2 1단계). */
async function probeKiwoom(
  ref: TickerRef,
  client: { request: (p: string, id: string, b: unknown, o?: { contYn?: string; nextKey?: string }) => Promise<{ json: unknown; cont: { contYn: string | null; nextKey: string | null } }> },
): Promise<ProbeResult> {
  const maxPages = Math.max(1, Number(process.env.KIWOOM_MAX_PAGES ?? 10))
  // 거래소구분(stex_tp)이 틀리면 "없음"이 나올 수 있다 → 기준표 값을 먼저, 그 다음 나머지.
  const order = [ref.stexTp, ...(['ND', 'NY', 'NA'] as const).filter((x) => x !== ref.stexTp)]
  const notes: string[] = []
  for (const stex of order) {
    // ① 종목정보 — "그 종목을 아는가"를 먼저 묻는다(종목없음 vs 데이터없음 구분)
    let known = '?'
    try {
      const info = await client.request('/api/us/stkinfo', 'usa10100', { stex_tp: stex, stk_cd: ref.ticker })
      const io = (info.json ?? {}) as Record<string, unknown>
      known = Number(io.return_code ?? 0) === 0 && (io.stk_nm || io.stk_enm) ? 'known' : 'unknown'
    } catch (e) {
      known = `info실패(${(e as Error).message.slice(0, 60)})`
    }
    // ② 일봉차트 — strt_dt 방향은 [미검증]이므로 요청값을 사유에 함께 남긴다
    const strtDt = (ref.eventDate ?? todayUtc()).replace(/-/g, '')
    const bars: Bar[] = []
    let contYn = 'N'
    let nextKey = ''
    let pages = 0
    let truncated = false
    let kind: 'ok' | 'absent' = 'absent'
    for (; pages < maxPages; pages++) {
      const { json, cont } = await client.request(
        '/api/us/chart',
        'usa06012',
        { stex_tp: stex, stk_cd: ref.ticker, strt_dt: strtDt, upd_stkpc_tp: '1', exrt_appl_tp: '0' },
        { contYn, nextKey },
      )
      const out = parseKiwoomUsChart(json)
      if (out.kind === 'ok') {
        kind = 'ok'
        bars.push(...out.bars)
      }
      if (cont.contYn !== 'Y' || !cont.nextKey) break
      contYn = 'Y'
      nextKey = cont.nextKey
      if (pages === maxPages - 1) truncated = true
    }
    notes.push(`stex_tp=${stex} strt_dt=${strtDt} 종목정보=${known} 페이지=${pages + 1}`)
    if (kind === 'ok')
      return toResult('kiwoom-us', ref.ticker, finishBars(bars, ''), { truncated, note: notes.join(' / ') })
  }
  return toResult('kiwoom-us', ref.ticker, { kind: 'absent', bars: [], note: '거래소 3종 모두 0건' }, { note: notes.join(' / ') })
}

// ── 9) 메인 ──────────────────────────────────────────────────────────────────

type SourceName = 'stooq' | 'tiingo' | 'alphavantage' | 'yahoo' | 'kiwoom-us'
const FREE_SOURCES: SourceName[] = ['stooq', 'tiingo', 'alphavantage', 'yahoo']

export function selectSources(mode: string, filter?: string): SourceName[] {
  const base: SourceName[] =
    mode === 'kiwoom' ? ['kiwoom-us'] : mode === 'all' ? [...FREE_SOURCES, 'kiwoom-us'] : FREE_SOURCES
  if (!filter) return base
  const want = new Set(
    filter
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  )
  return base.filter((s) => want.has(s))
}

/** `[미검증]` 잔여 목록 — 첫 실행의 실제 응답으로 지워야 하는 것들(규칙 4-1-3). */
export const UNVERIFIED: string[] = [
  '키움 해외 엔드포인트가 **모의서버**에서 제공되는지',
  '키움 해외 시세에 별도 이용신청·승인·이용료가 필요한지',
  '키움 usa06012 `strt_dt` 방향(그 날짜부터 앞으로 / 뒤로)과 과거 제공 연수',
  '키움 해외 엔드포인트 호출 한도 수치',
  'tiingo 무료 티어 한도 수치 · 미확인 티커의 404 본문 형식',
  'stooq 일일 한도 수치 · 상폐 티커 보관 정책',
  'alphavantage 상폐 종목의 실제 시계열 제공 여부(공식 문서가 "빈 배열 가능"을 경고)',
]

async function main(): Promise<void> {
  const mode = (process.env.MODE ?? 'free').toLowerCase()
  const sources = selectSources(mode, process.env.US_PROBE_SOURCES)
  const today = todayUtc()
  console.log(`미장 시세 소스 실사 — MODE=${mode} · 소스=[${sources.join(', ')}] · 기준일 ${today}`)
  console.log(`대상: 상폐 ${DELISTED_REFS.length}종 + 대조군(살아있는) ${LIVE_REFS.length}종`)
  console.log('※ "absent"는 소스가 살아있을 때만 근거가 된다 — 대조군 전패 시 error로 강등한다.\n')

  const rows: ProbeResult[] = []
  let attempted = 0
  let succeeded = 0 // ok + absent (= 소스와 대화가 성립한 횟수)
  let failed = 0

  // 키 로딩 — 값은 어떤 경로로도 출력하지 않는다(길이만, loadSecret가 stderr에 출처 1줄).
  let tiingoKey: string | null = null
  let avKey: string | null = null
  let kiwoomClient: ReturnType<typeof createKiwoomClient> | null = null
  let mask: (s: string) => string = (s) => s

  if (sources.includes('tiingo')) tiingoKey = loadSecret('TIINGO_API_KEY').value
  if (sources.includes('alphavantage')) avKey = loadSecret('ALPHAVANTAGE_API_KEY').value
  if (sources.includes('kiwoom-us')) {
    const mockKey = loadSecret('KIWOOM_MOCK_APP_KEY')
    const mockSecret = loadSecret('KIWOOM_MOCK_APP_SECRET')
    const key = mockKey.value ? mockKey : loadSecret('KIWOOM_APP_KEY')
    const secret = mockSecret.value ? mockSecret : loadSecret('KIWOOM_APP_SECRET')
    if (key.value && secret.value) {
      mask = maskerFor(key.value, secret.value)
      kiwoomClient = createKiwoomClient({ appKey: key.value, appSecret: secret.value })
      console.log(`키움 서버: ${kiwoomClient.base} (기본=모의서버. 변경은 KIWOOM_BASE_URL 환경변수로만 — 규칙 2)`)
    }
  }

  for (const source of sources) {
    for (const ref of ALL_REFS) {
      // 키 없는 소스는 skipped — 실패로도 성공으로도 세지 않는다
      if (source === 'tiingo' && !tiingoKey) {
        rows.push(skippedResult(source, ref.ticker, 'TIINGO_API_KEY 없음 (외부 계정 발급=T0)'))
        continue
      }
      if (source === 'alphavantage' && !avKey) {
        rows.push(skippedResult(source, ref.ticker, 'ALPHAVANTAGE_API_KEY 없음 (외부 계정 발급=T0)'))
        continue
      }
      if (source === 'kiwoom-us' && !kiwoomClient) {
        rows.push(skippedResult(source, ref.ticker, '키움 앱키 없음 — doppler run 으로 실행하세요'))
        continue
      }
      attempted++
      try {
        let r: ProbeResult
        if (source === 'stooq') r = await probeStooq(ref)
        else if (source === 'tiingo') r = await probeTiingo(ref, tiingoKey!)
        else if (source === 'alphavantage') r = await probeAlphaVantage(ref, avKey!)
        else if (source === 'yahoo') r = await probeYahoo(ref)
        else r = await probeKiwoom(ref, kiwoomClient!)
        rows.push(r)
        succeeded++
      } catch (e) {
        failed++
        rows.push(errorResult(source, ref.ticker, mask((e as Error).message).slice(0, 220)))
      }
      // 예의상 간격 — alphavantage 무료는 5 req/min 이라 별도로 더 쉰다
      await new Promise((r) => setTimeout(r, source === 'alphavantage' ? 13000 : 400))
    }
  }

  const gated = applyLiveness(rows)
  console.log(`\n${renderTable(gated, today)}`)
  console.log(renderVerdict(gated, today))
  console.log('')
  console.log(`시도 ${attempted}건 · 소스와 대화 성립 ${succeeded}건 · 소스 실패 ${failed}건 · 건너뜀 ${rows.filter((r) => r.kind === 'skipped').length}건`)
  console.log('\n■ 아직 [미검증]인 것 (이 실행의 실제 응답으로 확정되면 코드에서 지운다)')
  for (const u of UNVERIFIED) console.log(`  · [미검증] ${u}`)
  console.log(
    '\n⚠️ 이 표는 데이터 소스 실사 결과이며 투자 판단·권유가 아니다. 상폐 종목이 빠진 유니버스는 성적을 부풀린다(생존편향).',
  )

  // 성공 카운터 — 전량 실패는 **비정상 종료**. 항목별 try/catch가 "다 실패했는데 종료코드 0"을
  // 만드는 것을 막는다(규칙 4-2).
  if (attempted > 0 && succeeded === 0) {
    console.error('\n⛔ 시도한 모든 요청이 실패했다 — 결과를 근거로 쓰지 마라.')
    process.exit(1)
  }
  if (attempted === 0) {
    console.error('\n⛔ 시도한 요청이 0건이다(키 부재 또는 소스 필터) — 판정할 것이 없다.')
    process.exit(1)
  }
}

// 런처가 넘기는 플래그가 있을 때만 실행한다(테스트가 import해도 네트워크를 타지 않는다).
if (process.env.US_SOURCE_PROBE_RUN === '1') {
  main().catch((e) => {
    console.error(`⛔ 프로브 비정상 종료: ${(e as Error).message}`)
    process.exit(1)
  })
}
