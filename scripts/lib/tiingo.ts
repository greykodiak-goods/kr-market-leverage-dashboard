// tiingo 일봉 시세 클라이언트 — **미장 상폐 종목을 주는 유일한 무료 소스**(2026-08-04 실측).
//
// ── 왜 이 파일이 생겼나 ──────────────────────────────────────────────────────
//   야후는 죽은 종목을 주지 않는다. 41차 미장 실행에서 2000년 유니버스 80종목 중 56종목만
//   확보(70%)됐고 실패 6건 중 5건이 상폐사였다 — 생존편향이 성적을 후하게 만든다(규칙 1-7).
//   2026-08-04 소스 실사(GHA run 30877434611)에서 tiingo만 상폐 3/8 회사일치 · 대조군 4/4로
//   답했다. 특히 **MER(메릴린치)**: 야후는 상폐 17년 뒤 날짜의 **1봉짜리 껍데기**를 200으로
//   주는데(= 다른 회사) tiingo는 진짜 메릴린치 506봉(2006-12-28~2008-12-31)을 준다.
//
//   그 실사 코드는 `scripts/us-source-probe.entry.ts` 안에 있었다. 백테스트 경로(us-lab)가
//   쓰려면 **복붙이 아니라 공용 모듈**이어야 한다 — 복붙하면 두 벌이 서로 다르게 썩는다.
//   위치는 리포 관례를 따랐다: 여러 러너가 공유하는 실행 라이브러리는 `scripts/lib/`에 있다
//   (`kiwoom.mjs`·`intraday.mjs`·`presetDiag.ts`·`mockTradeCore.ts`). TS 러너들이 import하므로
//   `.ts`로 둔다(`presetDiag.ts`와 같은 형태).
//
// ─────────────────────────────────────────────────────────────────────────────
// 🔴 외부 API 사전 조사 (전역 규칙 4 — 착수 전 다섯 가지)
//
//   ① 인증: `Authorization: Token <key>` 헤더. 계정 가입으로 발급되는 무료 티어 키 하나면
//      되고 **엔드포인트별 별도 승인 절차는 문서에 없다**(키움과 다른 점).
//      키는 `loadSecret('TIINGO_API_KEY')` **하나로만** 읽는다(규칙 2-1). 값은 어떤 경로로도
//      출력하지 않고, 오류 문자열에 섞여 나가지 않도록 `maskerFor`로 감싼다.
//   ② 한도: 무료 티어에 상한이 있다는 사실만 확인했고 **수치는 [미검증]**이다.
//      → 초과를 "데이터 없음"으로 오해하지 않도록 **HTTP 429를 명시적으로 실패로** 가른다.
//        호출 사이 간격은 호출부가 정한다(us-lab은 `US_FETCH_DELAY_MS`).
//   ③ 필드: `/tiingo/daily/<ticker>/prices` 는 **배열**을 준다. 행 필드(2026-08-04 실측 응답
//      기준): `date`(ISO8601 문자열) · `open` · `high` · `low` · `close` · `volume` ·
//      `adjOpen` · `adjHigh` · `adjLow` · `adjClose` · `adjVolume` · `divCash` · `splitFactor`.
//      ⚠️ **`adj*`가 배당까지 반영하는지는 문서 문구로 확정하지 않았다 [미검증]** —
//        이것이 이 작업의 가장 큰 함정이라 `auditTiingoAdjustment()`가 **실제 응답으로**
//        판정한다(아래 §4). 야후는 `adjclose ÷ close` 계수를 OHLC에 곱해 총수익을 만드는데,
//        기준이 어긋나면 40차에서 제거한 **배당 비대칭**이 되살아난다.
//   ④ 데이터 범위: `startDate`/`endDate` 쿼리로 지정. 공개 소개는 "30년+"라고 하고 실측으로
//      1990-03-26 시작 봉(CELG)을 확인했다. 종목별 실제 시작일은 **[미검증]**이며 응답의
//      첫 봉으로만 안다.
//   ⑤ 실패 표현 — **셋이 섞여 온다.** 하나로 뭉치면 "없는 결론"이 생긴다.
//        · HTTP 404 + JSON `{"detail": "Ticker 'WCOM' not found"}` → 그 종목이 없다(absent)
//        · HTTP 200 + **빈 배열** → absent (LEH·BSC·TYC가 이 형태였다. 무료 티어 제한인지
//          데이터 부재인지는 **[미검증]** — 그래서 absent로만 세고 "없다"고 단정하지 않는다)
//        · HTTP 401/403(키) · 429(한도) · 5xx → **소스 실패**. absent로 세면 안 된다.
//      배열이 아닌 응답·필드명 변경은 **던진다**(관용 파싱하되 하나도 못 찾으면 throw).
// ─────────────────────────────────────────────────────────────────────────────
//
// 🔴 규칙 1(미래참조 금지)과의 관계: 이 모듈은 **봉을 받아 옮길 뿐 신호를 만들지 않는다.**
//    다만 두 가지를 지킨다 — ① 봉을 날짜 오름차순으로 정렬해 돌려준다(순서 뒤집힘이
//    지표 창을 오염시킨다) ② 보정 계수는 **그 봉의 값만으로** 만든다(전 구간 통계 금지).

import type { DailyBar } from '../../src/features/backtest/types'
import { loadSecret, maskerFor } from './loadSecret.mjs'

// ── 1) 상수 · 타입 ──────────────────────────────────────────────────────────

/** 조회 전용 베이스 URL. tiingo에는 주문 개념이 없다(규칙 2와 무관한 시세 소스). */
export const TIINGO_BASE = 'https://api.tiingo.com'

/** 시세 소스가 어떤 보정 기준으로 봉을 만들었는가. 파일·로그에 반드시 병기한다(규칙 3). */
export type TiingoBasis = 'total' | 'price'

/**
 * tiingo 원시 행 — 응답 필드를 **이름 그대로** 담는다(번역하면서 잃지 않기 위해).
 *
 * ⚠️ `date`·`close`만 필수다. OHLC를 필수로 잡으면 **종가만 필요한 소비자**(소스 실사
 *   프로브)가 쓰는 최소 응답을 통째로 "파싱 실패"로 던져 버린다. 없는 값을 종가로
 *   때우지 않고 `null`로 남기고, 백테스트용 봉으로 옮길 때 그 행을 **세어서 버린다**.
 */
export interface TiingoRow {
  date: string
  open: number | null
  high: number | null
  low: number | null
  close: number
  volume: number
  adjOpen: number | null
  adjHigh: number | null
  adjLow: number | null
  adjClose: number | null
  adjVolume: number | null
  divCash: number
  splitFactor: number
}

/** 파싱 결과 — "없다(absent)"와 "실패(throw)"를 섞지 않는다. */
export interface TiingoParseOutcome {
  rows: TiingoRow[]
  /** 소스는 살아 있는데 그 종목이 없다(빈 배열). */
  absent: boolean
  /** 형식이 어긋나 버린 행 수 — 0이 아니면 로그에 드러낸다. */
  dropped: number
}

function num(v: unknown): number | null {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

// ── 2) URL ──────────────────────────────────────────────────────────────────

/** 일봉 URL. 키는 **헤더로만** 보낸다 — 쿼리에 넣으면 로그·리퍼러에 남는다. */
export function tiingoDailyUrl(ticker: string, opts: { startDate?: string; endDate?: string } = {}): string {
  const qs = new URLSearchParams({ format: 'json' })
  if (opts.startDate) qs.set('startDate', opts.startDate)
  if (opts.endDate) qs.set('endDate', opts.endDate)
  return `${TIINGO_BASE}/tiingo/daily/${encodeURIComponent(ticker.toLowerCase())}/prices?${qs.toString()}`
}

/** 인증 헤더. 값은 여기서만 만들고 어디에도 로그하지 않는다. */
export function tiingoHeaders(token: string): Record<string, string> {
  return { Authorization: `Token ${token}`, 'Content-Type': 'application/json' }
}

/**
 * HTTP 상태코드 분류 — **"없음"과 "실패"를 가르는 자리.**
 * 404만 absent다. 401/403(키)·429(한도)·5xx는 소스 실패이며 절대 absent로 세지 않는다.
 */
export function classifyTiingoStatus(status: number, body: string): { kind: 'ok' | 'absent'; note: string } {
  if (status === 200) return { kind: 'ok', note: '' }
  if (status === 404) return { kind: 'absent', note: `tiingo HTTP 404: ${body.slice(0, 120)}` }
  if (status === 401 || status === 403) throw new Error(`tiingo 인증 실패 HTTP ${status} — 키 확인 필요(값은 출력하지 않는다)`)
  if (status === 429) throw new Error('tiingo HTTP 429 한도 초과 — 소스 실패다(absent 아님). 무료 티어 수치 상한은 [미검증]')
  throw new Error(`tiingo HTTP ${status} — 앞부분: ${body.slice(0, 160).replace(/\s+/g, ' ')}`)
}

// ── 3) 파서 (순수 함수 — 네트워크 없이 테스트한다) ──────────────────────────

/**
 * 응답 JSON → 행 배열. **관용 파싱하되 하나도 못 찾으면 던진다**(규칙 4-2).
 *   · 객체이면서 `detail`/`message`/`error`가 있으면 → throw (오류 본문)
 *   · 배열이 아니면 → throw (형식 변경)
 *   · 빈 배열 → absent (정상 0건)
 *   · 날짜·종가를 못 읽은 행은 버리되, **전량 버리면 throw**
 */
export function parseTiingoRows(json: unknown): TiingoParseOutcome {
  if (json && typeof json === 'object' && !Array.isArray(json)) {
    const o = json as Record<string, unknown>
    const detail = o.detail ?? o.message ?? o.error
    if (detail) throw new Error(`tiingo 오류 본문: ${String(detail).slice(0, 160)}`)
  }
  if (!Array.isArray(json)) throw new Error(`tiingo 응답이 배열이 아니다 — 형식: ${typeof json}`)
  if (json.length === 0) return { rows: [], absent: true, dropped: 0 }

  const rows: TiingoRow[] = []
  let dropped = 0
  for (const raw of json as Record<string, unknown>[]) {
    const date = String(raw.date ?? '').slice(0, 10)
    const o = num(raw.open)
    const h = num(raw.high)
    const l = num(raw.low)
    const c = num(raw.close)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || c == null) {
      dropped++
      continue
    }
    rows.push({
      date,
      open: o,
      high: h,
      low: l,
      close: c,
      volume: num(raw.volume) ?? 0,
      adjOpen: num(raw.adjOpen),
      adjHigh: num(raw.adjHigh),
      adjLow: num(raw.adjLow),
      adjClose: num(raw.adjClose),
      adjVolume: num(raw.adjVolume),
      // 없는 필드를 0/1로 때우면 §4 감사가 "배당이 없다"고 잘못 읽는다 → null이 아니라
      // **필드 부재를 감사 쪽에서 알 수 있게** 기본값을 명시적으로 둔다(아래 hasDividendFields).
      divCash: num(raw.divCash) ?? 0,
      splitFactor: num(raw.splitFactor) ?? 1,
    })
  }
  if (rows.length === 0)
    throw new Error(
      `tiingo ${json.length}행을 모두 파싱 실패 — 필드명 변경 의심 (첫 행 키: ${Object.keys((json[0] ?? {}) as object).join(', ')})`,
    )
  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  return { rows, absent: false, dropped }
}

/** 응답에 배당·분할 필드가 실제로 있었는가 — 감사 판정의 전제. */
export function hasDividendFields(json: unknown): boolean {
  if (!Array.isArray(json) || json.length === 0) return false
  const k = Object.keys((json[0] ?? {}) as object)
  return k.includes('divCash') && k.includes('splitFactor')
}

// ── 4) 🔴 배당·분할 보정 감사 — **이 작업의 가장 큰 함정** ───────────────────
//
// 야후 경로는 `adjclose ÷ close` 계수를 OHLC에 곱해 총수익을 만든다(규칙 3). tiingo는
// `adjOpen`… 를 직접 주는데, 그것이 **분할만** 반영한 값이면 전략은 가격수익, 벤치는
// 총수익이 되어 40차에서 제거한 **배당 비대칭**이 되살아난다. 문서 문구로 믿지 않고
// **응답 자체로 판정**한다.
//
// 판정 원리: 배당락일 i(divCash_i > 0, 분할 없음)를 사이에 둔 두 봉의 보정계수
//   f = adjClose ÷ close
// 를 비교한다.
//   · 배당이 반영돼 있다면  f_{i-1} / f_i ≈ 1 − div_i / close_{i-1}   (< 1)
//   · 반영돼 있지 않다면    f_{i-1} / f_i ≈ 1                          (분할이 없으므로)
// 두 예측값 중 관측값에 더 가까운 쪽으로 그 사건을 분류하고, 사건들을 모아 판정한다.
// 어느 쪽에도 안 가까우면 `unknown`으로 남긴다 — **추측으로 메우지 않는다.**

export type TiingoAdjVerdict = 'total' | 'price' | 'unknown'

export interface TiingoAdjAudit {
  verdict: TiingoAdjVerdict
  /** 검사에 쓸 수 있었던 배당 사건 수(분할이 겹친 날은 뺀다). */
  events: number
  totalVotes: number
  priceVotes: number
  /** adjOpen/open 과 adjClose/close 가 **같은 계수**인지(야후식 단일 계수 모델 성립 여부). */
  singleFactorOk: boolean
  singleFactorChecked: number
  note: string
}

/** 이 비율 안이면 "같다"고 본다. 소수 반올림·1센트 단위 배당을 견디는 폭. */
export const TIINGO_ADJ_TOLERANCE = 0.002

/**
 * 실제 응답으로 보정 기준을 판정한다. **문서를 믿지 않고 데이터로 확정하는 자리.**
 * 판정에 쓸 사건이 없으면 `unknown` — 그 경우 호출부가 [미검증]으로 남기거나 멈춘다.
 */
export function auditTiingoAdjustment(rows: TiingoRow[]): TiingoAdjAudit {
  let events = 0
  let totalVotes = 0
  let priceVotes = 0
  let singleFactorChecked = 0
  let singleFactorBad = 0

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]
    // (a) 단일 계수 모델 — adjOpen/open 과 adjClose/close 가 같아야 야후식 변환과 호환된다.
    if (r.adjOpen != null && r.adjClose != null && r.open != null && r.open > 0 && r.close > 0) {
      const fo = r.adjOpen / r.open
      const fc = r.adjClose / r.close
      if (fc > 0) {
        singleFactorChecked++
        if (Math.abs(fo / fc - 1) > TIINGO_ADJ_TOLERANCE) singleFactorBad++
      }
    }
    // (b) 배당 사건 — 분할이 겹치지 않은 날만 쓴다(두 효과가 섞이면 판정이 흐려진다).
    if (i === 0) continue
    const p = rows[i - 1]
    if (!(r.divCash > 0) || Math.abs(r.splitFactor - 1) > 1e-9) continue
    if (r.adjClose == null || p.adjClose == null || r.close <= 0 || p.close <= 0) continue
    const fCur = r.adjClose / r.close
    const fPrev = p.adjClose / p.close
    if (!(fCur > 0) || !(fPrev > 0)) continue
    const observed = fPrev / fCur
    const expectedTotal = 1 - r.divCash / p.close
    const expectedPrice = 1
    events++
    if (Math.abs(observed - expectedTotal) <= Math.abs(observed - expectedPrice)) totalVotes++
    else priceVotes++
  }

  const singleFactorOk = singleFactorChecked > 0 && singleFactorBad === 0
  // 사건이 너무 적으면 판정하지 않는다 — 한두 건으로 기준을 정하지 않는다.
  const MIN_EVENTS = 3
  let verdict: TiingoAdjVerdict = 'unknown'
  let note = ''
  if (events < MIN_EVENTS) {
    note = `배당 사건 ${events}건뿐(최소 ${MIN_EVENTS}건 필요) — 보정 기준을 판정하지 않는다 [미검증]`
  } else if (totalVotes >= events * 0.9) {
    verdict = 'total'
    note = `배당 사건 ${events}건 중 ${totalVotes}건이 배당 반영과 일치 — adj*는 **분할+배당**(야후 adjclose와 같은 기준)`
  } else if (priceVotes >= events * 0.9) {
    verdict = 'price'
    note = `배당 사건 ${events}건 중 ${priceVotes}건이 배당 **미반영**과 일치 — adj*는 분할만 반영한다`
  } else {
    note = `배당 사건 ${events}건이 총수익 ${totalVotes} / 가격수익 ${priceVotes}로 갈렸다 — 판정 불가 [미검증]`
  }
  if (singleFactorChecked > 0 && !singleFactorOk)
    note += ` · ⚠️ adjOpen/open ≠ adjClose/close 인 봉 ${singleFactorBad}/${singleFactorChecked} — 단일 계수 모델이 성립하지 않는다`

  return { verdict, events, totalVotes, priceVotes, singleFactorOk, singleFactorChecked, note }
}

// ── 5) 봉 변환 ──────────────────────────────────────────────────────────────

/**
 * tiingo 행 → 백테스트 `DailyBar`.
 *
 * `basis='total'`이면 **`adjClose ÷ close` 계수를 OHLC에 곱한다** — 야후 경로와 **똑같은
 * 변환식**을 쓴다. `adjOpen`을 그대로 쓰지 않는 이유가 여기 있다: 두 소스가 같은 식을
 * 지나야 알파가 소스 선택으로 기울지 않는다(40차 배당 비대칭 사고의 교훈).
 * `singleFactorOk`가 거짓이면 이 가정이 깨진 것이므로 감사에서 드러난다.
 *
 * ⚠️ 계수는 **그 봉의 값만으로** 만든다(전 구간 통계 금지 — 규칙 1-5).
 */
export function tiingoBarsToDaily(rows: TiingoRow[], basis: TiingoBasis): { bars: DailyBar[]; dropped: number } {
  const out: DailyBar[] = []
  let dropped = 0
  for (const r of rows) {
    // OHLC가 하나라도 없으면 **버린다.** 종가로 때우면 시가 체결·장중 손절이 거짓이 된다.
    if (r.open == null || r.high == null || r.low == null) {
      dropped++
      continue
    }
    const fac = basis === 'price' ? 1 : r.adjClose != null && r.close > 0 ? r.adjClose / r.close : 1
    // tiingo는 거래소 현지일을 그대로 주므로 야후처럼 gmtoffset 환산을 하지 않는다.
    // `t`는 표시·정렬 보조값이고 **정본은 `date` 문자열**이다(21:00Z ≈ 16:00 ET 종가 시각).
    const t = Math.floor(Date.parse(`${r.date}T21:00:00Z`) / 1000)
    out.push({
      date: r.date,
      t,
      o: r.open * fac,
      h: r.high * fac,
      l: r.low * fac,
      c: r.close * fac,
      v: r.volume,
      rawClose: r.close,
    })
  }
  return { bars: out, dropped }
}

// ── 6) 티커 재사용 차단 ─────────────────────────────────────────────────────
//
// MER 사건이 이 가드의 실물이다 — 야후는 메릴린치 상폐 17년 뒤 날짜의 1봉을 200으로 줬다.
// 미국 티커는 회사가 사라지면 **다른 회사에 재배정**되므로 "데이터를 줬다"가 "그 회사다"가
// 아니다. tiingo 경로에도 같은 방어를 건다.
//
//   ① `US_BLOCKED_TICKERS` — 호출부(유니버스)가 이미 매핑 자체를 거부한다.
//   ② 최소 봉수 — 껍데기 응답(1~11봉)을 걸러낸다. 호출부가 정한다.
//   ③ **긴 공백** — 한 티커의 시계열에 이 일수를 넘는 공백이 있으면 앞뒤가 **다른 상장**일
//      가능성이 높다. 뒤 구간만 잘라 쓰면 조용한 오염이 되므로 **티커 전체를 거부**한다
//      (정직한 매핑 실패로 계수되는 편이 낫다 — usPitUniverse.ts의 규약과 같다).

/** 이 일수를 넘는 공백은 "다른 상장"으로 본다. 미국 정규장은 최장 연휴도 2주를 넘지 않는다. */
export const TIINGO_REUSE_GAP_DAYS = 400

export interface GapCheck {
  ok: boolean
  /** 가장 긴 공백(일). */
  maxGapDays: number
  reason: string
}

export function checkTickerReuseGap(rows: TiingoRow[], maxGapDays = TIINGO_REUSE_GAP_DAYS): GapCheck {
  let worst = 0
  let at = ''
  for (let i = 1; i < rows.length; i++) {
    const d = (Date.parse(rows[i].date) - Date.parse(rows[i - 1].date)) / 86400000
    if (d > worst) {
      worst = d
      at = `${rows[i - 1].date} → ${rows[i].date}`
    }
  }
  if (worst > maxGapDays)
    return {
      ok: false,
      maxGapDays: worst,
      reason: `시계열에 ${Math.round(worst)}일 공백(${at}) — 티커 재사용(다른 상장) 의심이라 거부한다. 뒤 구간만 쓰면 조용한 오염이 된다`,
    }
  return { ok: true, maxGapDays: worst, reason: '' }
}

// ── 7) 네트워크 ─────────────────────────────────────────────────────────────

/** fetch 응답 최소 계약 — 테스트가 가짜 응답을 끼울 수 있게 좁혀 둔다. */
export interface TiingoResponse {
  status: number
  text: () => Promise<string>
}

export interface TiingoFetchResult {
  kind: 'ok' | 'absent'
  rows: TiingoRow[]
  dropped: number
  note: string
  /** 감사 결과 — 부르는 쪽이 기준 일치를 확인하는 데 쓴다. */
  audit: TiingoAdjAudit
  /** 응답에 배당·분할 필드가 실제로 있었는가. */
  hadDividendFields: boolean
}

/**
 * 일봉 1종목. **어떤 실패도 삼키지 않는다** — 상태코드·오류 본문·형식 변경 전부 던지고,
 * "그 종목이 없다"만 `absent`로 돌려준다.
 */
export async function fetchTiingoDaily(
  ticker: string,
  token: string,
  opts: { startDate?: string; endDate?: string; timeoutMs?: number; fetchImpl?: (url: string, init: { headers: Record<string, string>; signal?: AbortSignal }) => Promise<TiingoResponse> } = {},
): Promise<TiingoFetchResult> {
  const url = tiingoDailyUrl(ticker, opts)
  const doFetch =
    opts.fetchImpl ??
    ((u: string, init: { headers: Record<string, string>; signal?: AbortSignal }) => fetch(u, init) as unknown as Promise<TiingoResponse>)
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 20000)
  let status: number
  let body: string
  try {
    const res = await doFetch(url, { headers: tiingoHeaders(token), signal: ctl.signal })
    status = res.status
    body = await res.text()
  } finally {
    clearTimeout(timer)
  }
  const cls = classifyTiingoStatus(status, body)
  if (cls.kind === 'absent')
    return {
      kind: 'absent',
      rows: [],
      dropped: 0,
      note: cls.note,
      audit: auditTiingoAdjustment([]),
      hadDividendFields: false,
    }
  let json: unknown
  try {
    json = JSON.parse(body)
  } catch {
    throw new Error(`tiingo 응답이 JSON이 아니다 (HTTP ${status}) — 앞부분: ${body.slice(0, 160).replace(/\s+/g, ' ')}`)
  }
  const parsed = parseTiingoRows(json)
  if (parsed.absent)
    return {
      kind: 'absent',
      rows: [],
      dropped: 0,
      note: 'tiingo 빈 배열 — 무료 티어 제한인지 데이터 부재인지 [미검증]',
      audit: auditTiingoAdjustment([]),
      hadDividendFields: hasDividendFields(json),
    }
  return {
    kind: 'ok',
    rows: parsed.rows,
    dropped: parsed.dropped,
    note: parsed.dropped ? `탈락 ${parsed.dropped}행` : '',
    audit: auditTiingoAdjustment(parsed.rows),
    hadDividendFields: hasDividendFields(json),
  }
}

// ── 8) 키 로딩 (규칙 2-1 — Doppler 단일 원본) ───────────────────────────────

export interface TiingoKey {
  value: string | null
  /** 로그·오류에 키가 섞여 나가지 않게 감싸는 함수. */
  mask: (s: string) => string
  help: string | null
}

/**
 * `loadSecret` **하나만** 쓴다. 값은 반환만 하고 어떤 경로로도 출력하지 않는다
 * (loadSecret가 stderr에 출처·길이만 한 줄 남긴다). 하드코딩 기본 경로를 두지 않는다.
 */
export function loadTiingoKey(): TiingoKey {
  const r = loadSecret('TIINGO_API_KEY') as { value: string | null; help: string | null }
  return { value: r.value, mask: r.value ? maskerFor(r.value) : (s: string) => s, help: r.help }
}

/** 아직 실제 응답으로 확정하지 못한 것들 — 실행 로그에 그대로 찍어 남긴다(규칙 4-1-3). */
export const TIINGO_UNVERIFIED: string[] = [
  'tiingo 무료 티어 호출 한도 **수치**(있다는 사실만 확인)',
  '빈 배열(LEH·BSC·TYC)이 무료 티어 제한인지 데이터 부재인지',
  '종목별 과거 제공 시작일(응답의 첫 봉으로만 안다)',
  'adj* 필드의 배당 반영 여부를 **문서 문구로는** 확정하지 못했다 → auditTiingoAdjustment가 응답으로 판정한다',
]
