// KRX 일별 시세 **정본** — 스키마·파서·수정주가 계수 산출·Bar 변환.
//
// 왜 이 파일이 있는가 (2026-08-03 · 야후 배제 1단계):
//   지금까지 백테스트 시세는 Yahoo였다. 두 가지가 깨져 있었다.
//     ① **생존편향** — 상장폐지된 종목은 Yahoo에 시계열이 없다. KRX 실측 유니버스
//        275종목 중 23종목이 매핑 실패했고, 그 23종목은 "성적이 나쁘지 않아서" 빠진 게
//        아니라 사라져서 빠진 것이다. 빠진 쪽이 나쁠 확률이 높으니 성적이 부풀려진다.
//     ② **가짜 시계열** — Yahoo가 코스닥 6자리 코드에 엉뚱한 티커의 시계열을 준 사고가
//        있었다. 조용히 틀린 숫자가 표에 들어갔다.
//   KRX Open API의 일별 전종목 단면(`stk_bydd_trd`/`ksq_bydd_trd`)은 **그날 상장돼 있던
//   전 종목**의 OHLC·시가총액·상장주식수를 준다. 상폐 종목도 상폐 전날까지는 들어 있다.
//   그래서 이걸 정본으로 삼으면 ①②가 동시에 사라진다.
//
// 대신 새로 생기는 문제: **KRX는 원주가(수정 전)다.**
//   액면분할·무상증가로 주식수가 바뀌면 가격이 계단처럼 끊긴다. 그대로 쓰면 분할일에
//   -98% 같은 가짜 수익률이 생겨 백테스트가 통째로 거짓이 된다. 배당·분할이 이미 반영된
//   Yahoo adjclose와 달리 **수정계수를 우리가 산출**해야 한다. 그 산출의 단일 원본이 이
//   파일이다 — 수집 스크립트(쓰는 쪽)와 로더(읽는 쪽)가 같은 함수를 쓴다.
//
// 정직성 (규칙 3):
//   · **배당 미반영.** 주식수 변화로 잡히는 것은 분할·병합·무상증자뿐이다. 현금배당은
//     주식수를 바꾸지 않으므로 여기서 보정되지 않는다 → 이 시계열은 **가격수익(price
//     return)**이지 총수익(total return)이 아니다. Yahoo adjclose 기반 시계열과 나란히
//     놓고 비교하면 안 된다. `KRX_DAILY_LIMITS`가 이 문구를 화면·로그로 나른다.
//   · **거래량은 기본 미수집**(용량 예산). 수집 시 `--with-volume`을 준 파일만 6번째
//     열을 갖는다. 없으면 `DailyBar.v = 0`이고 `volume:false`가 index에 박힌다.
//   · **2010년 이전 부재.** KRX Open API의 데이터 시작이 2010년이다.
//   · **분류 불확실.** 주식수 변화가 분할인지 유상증자인지는 가격 갭과의 정합으로
//     추정한다. 애매한 건은 `confidence:'low'`로 남기고 **기본적으로 보정하지 않는다** —
//     조용히 보정해서 틀리느니 드러내 놓고 안 건드린다.
//
// 이 파일은 브라우저 번들에도 들어갈 수 있으므로 **node:fs를 import하지 않는다.**
// 파일 입출력·네트워크는 부르는 쪽(`scripts/krx-daily-backfill.entry.ts`)이 하고,
// 여기서는 순수 데이터 변환·검증만 한다(krxPitUniverse.ts와 같은 철학).

import type { DailyBar } from './types'

// ---------------------------------------------------------------- 상수·경로

/** 리포 기준 상대 경로 — 쓰는 쪽·읽는 쪽이 같은 상수를 쓴다(경로가 갈리는 사고 방지). */
export const KRX_DAILY_DIR = 'public/data/krx-daily'
export const KRX_DAILY_INDEX_PATH = `${KRX_DAILY_DIR}/index.json`
export const KRX_DAILY_MONTHLY_PATH = `${KRX_DAILY_DIR}/monthly-universe.json`
export const KRX_DAILY_EVENTS_PATH = `${KRX_DAILY_DIR}/adj-events.json`
/** 종목 파일 경로(index 안의 file 필드와 같은 규약). */
export function krxDailyPriceFile(code: string): string {
  return `prices/${code}.json`
}

export const KRX_DAILY_SOURCE = 'KRX Open API (stk_bydd_trd · ksq_bydd_trd)'
export const KRX_DAILY_BASIS = '일별 전종목 시세 단면 · 원주가(수정 전) · 상장주식수 동반'
export const KRX_DAILY_SCHEMA_INDEX = 'krx-daily/index@1'
export const KRX_DAILY_SCHEMA_PRICES = 'krx-daily/prices@1'
export const KRX_DAILY_SCHEMA_MONTHLY = 'krx-daily/monthly-universe@1'
export const KRX_DAILY_SCHEMA_EVENTS = 'krx-daily/adj-events@1'

/**
 * 화면·로그·PR에 그대로 붙이는 한계 목록(규칙 3 — 출처·한계를 확인 가능하게).
 * 문구를 여기서만 바꾼다 — 여러 곳에 복사하면 하나만 낡는다.
 */
export const KRX_DAILY_LIMITS: readonly string[] = [
  '배당 미반영 — 가격수익(price return) 기준. 현금배당은 주식수를 바꾸지 않아 이 경로로는 보정되지 않는다.',
  '수정주가는 상장주식수 변화에서 **자체 산출**한 것이다(분할·병합·무상증자형). 공시 원본 대조는 [미검증].',
  '2010년 이전 없음 — KRX Open API 데이터 시작이 2010년이다.',
  '거래량은 기본 미수집(용량 예산) — index.volume=false면 DailyBar.v는 0이다.',
  '환율·수수료·세금 미반영. 원화 표시 원주가.',
]

/** 배지 한 줄 — 그래프·표 옆에 붙인다. */
export const KRX_DAILY_BADGE = 'KRX 실측 일별(원주가·분할보정) · 배당 미반영'

/** 출처 한 줄(규칙 3 — 실데이터 라벨). */
export function krxDailySourceNote(idx: KrxDailyIndex): string {
  const vol = idx.volume ? '거래량 포함' : '거래량 미수집'
  return (
    `시세: ${idx.source} ${idx.from}~${idx.to} (${idx.basis}) · 수집일 ${idx.asOf} · ` +
    `${idx.stocks.length}종목 · ${idx.calendar.length}거래일 · ${vol} · 배당 미반영`
  )
}

// ---------------------------------------------------------- KRX 응답 관용 파싱

/** 하루치 단면 한 줄. 숫자는 전부 쉼표 제거 후 변환한다. */
export interface KrxByddRow {
  code: string
  name: string
  open: number
  high: number
  low: number
  close: number
  /** 응답의 MKTCAP(원). 검증용 — 파일에는 저장하지 않고 close×shares로 유도한다. */
  mktcap: number
  /** 상장주식수(LIST_SHRS) — 수정계수 산출의 근거. */
  shares: number
  /** 누적 거래량(ACC_TRDVOL). 없으면 0. */
  volume: number
}

export interface KrxByddParse {
  rows: KrxByddRow[]
  /** 첫 줄의 키 집합 — 필드명 [미검증] 확정용으로 첫 실행에서 출력한다. */
  rawKeys: string[]
  /** 필수 필드 결측·비정상 가격으로 버린 줄 수(조용히 버리지 않고 세어서 보고한다). */
  dropped: number
  /** 응답 줄 수(필터 전). 0이면 휴장일로 본다. */
  total: number
}

const NUM_BAD = Number.NaN

function num(v: unknown): number {
  if (v == null) return NUM_BAD
  const s = String(v).replace(/,/g, '').trim()
  if (!s || s === '-' || s === 'N/A') return NUM_BAD
  const n = Number(s)
  return Number.isFinite(n) ? n : NUM_BAD
}

function pick(r: Record<string, unknown>, keys: string[]): unknown {
  for (const k of keys) if (r[k] != null && String(r[k]).trim() !== '') return r[k]
  return undefined
}

// 필드명은 KRX 문서 기준이고 **첫 실행에서 확정**한다([미검증]). 그래서 후보를 나열해
// 관용 파싱한다 — 문서와 실제가 어긋나도 수집이 통째로 멈추지 않게.
const K_CODE = ['ISU_SRT_CD', 'ISU_CD', 'ISU_SRT_CODE', 'isuSrtCd']
const K_NAME = ['ISU_ABBRV', 'ISU_NM', 'ISU_KOR_ABBRV', 'isuAbbrv']
const K_OPEN = ['TDD_OPNPRC', 'OPNPRC', 'TDD_OPN_PRC', 'tddOpnprc']
const K_HIGH = ['TDD_HGPRC', 'HGPRC', 'TDD_HG_PRC', 'tddHgprc']
const K_LOW = ['TDD_LWPRC', 'LWPRC', 'TDD_LW_PRC', 'tddLwprc']
const K_CLOSE = ['TDD_CLSPRC', 'CLSPRC', 'TDD_CLS_PRC', 'tddClsprc']
const K_CAP = ['MKTCAP', 'MKT_CAP', 'mktcap']
const K_SHRS = ['LIST_SHRS', 'LISTSHRS', 'LIST_SHRS_CNT', 'listShrs']
const K_VOL = ['ACC_TRDVOL', 'TRDVOL', 'ACC_TRD_VOL', 'accTrdvol']

/**
 * KRX Open API 하루치 응답을 관용 파싱한다.
 *
 * 버리는 줄(조용히 넘기지 않고 `dropped`로 센다):
 *   · 6자리 종목코드가 아닌 줄
 *   · OHLC 중 하나라도 0 이하·비수치인 줄 (거래정지·정리매매 공백 등) — 그 날은 결측일로
 *     남고 시계열에서 빠진다. 0을 가격으로 저장하면 수익률이 −100%가 된다.
 *   · 상장주식수가 0 이하인 줄 (수정계수 산출 불가)
 *
 * @throws 응답에서 행 배열 자체를 찾지 못하면 던진다 — 스키마가 바뀌었거나 오류 응답이다.
 */
export function parseKrxByddResponse(json: unknown): KrxByddParse {
  if (typeof json !== 'object' || json == null) throw new Error('KRX 응답이 객체가 아니다')
  const o = json as Record<string, unknown>
  const arr = (Array.isArray(o.OutBlock_1) ? o.OutBlock_1 : Object.values(o).find(Array.isArray)) as
    | Record<string, unknown>[]
    | undefined
  if (!arr) {
    const keys = Object.keys(o).slice(0, 8).join(', ')
    throw new Error(`KRX 응답에서 행 배열을 찾지 못했다 (최상위 키: ${keys || '없음'})`)
  }
  const rows: KrxByddRow[] = []
  let dropped = 0
  for (const r of arr) {
    const code = String(pick(r, K_CODE) ?? '').trim()
    const name = String(pick(r, K_NAME) ?? '').trim()
    const open = num(pick(r, K_OPEN))
    const high = num(pick(r, K_HIGH))
    const low = num(pick(r, K_LOW))
    const close = num(pick(r, K_CLOSE))
    const shares = num(pick(r, K_SHRS))
    const mktcapRaw = num(pick(r, K_CAP))
    const volRaw = num(pick(r, K_VOL))
    if (!/^\d{6}$/.test(code) || !name) {
      dropped++
      continue
    }
    if (![open, high, low, close].every((v) => Number.isFinite(v) && v > 0)) {
      dropped++
      continue
    }
    if (!Number.isFinite(shares) || shares <= 0) {
      dropped++
      continue
    }
    rows.push({
      code,
      name,
      open,
      high,
      low,
      close,
      mktcap: Number.isFinite(mktcapRaw) ? mktcapRaw : 0,
      shares,
      volume: Number.isFinite(volRaw) ? volRaw : 0,
    })
  }
  const rawKeys = arr.length > 0 ? Object.keys(arr[0]) : []
  return { rows, rawKeys, dropped, total: arr.length }
}

/**
 * 보통주 필터 — `pityear`(spec-backtest.entry.ts)와 **같은 규칙**이어야 한다.
 * 6자리 코드 & 끝자리 '0'(우선주 5/7/9 제외) & 스팩 제외.
 * 규칙이 갈리면 월별 유니버스와 연도별 유니버스를 나란히 읽을 수 없다.
 */
export function isKrxCommonStock(code: string, name: string): boolean {
  return /^\d{6}$/.test(code) && code.endsWith('0') && !/스팩|SPAC/i.test(name)
}

// -------------------------------------------------------- 수정주가 이벤트 분류

export type KrxAdjKind =
  /** 액면분할·액면병합·무상증자형 — 가격 보정 대상. */
  | 'split'
  /** 유상증자·CB전환·감자 등 — 주식수만 변하고 가격은 연속. 보정하지 않는다. */
  | 'shareChange'

export type KrxAdjConfidence = 'high' | 'medium' | 'low'

export interface KrxAdjEvent {
  /** 새 주식수가 처음 관측된 거래일(YYYY-MM-DD). 이 날부터 새 가격 스케일이다. */
  date: string
  /** 전역 거래일 달력(index.calendar) 인덱스. */
  idx: number
  kind: KrxAdjKind
  sharesBefore: number
  sharesAfter: number
  /** 주식수 비율 = after / before. 50:1 분할이면 50. */
  ratio: number
  /** 가격이 말하는 비율 = 직전 종가 / 당일 종가. 50:1 분할이면 ≈50. */
  impliedRatio: number
  /** 가격 보정 계수. split이면 ratio(이전 가격에 1/factor를 곱한다), 아니면 1. */
  factor: number
  confidence: KrxAdjConfidence
  note: string
}

/** 이 비율 미만의 주식수 변화는 후보로 보지 않는다(자사주 소각 등 잡음). */
export const KRX_SHARE_CHANGE_MIN = 0.01
/** 주식수 변화가 이보다 작으면 "소폭"으로 보고 분할 판정을 신뢰하지 않는다. */
const SMALL_CHANGE = 0.05
/** 가격 갭과 주식수 비율의 상대 괴리 허용치(지시: ±15%). */
const MATCH_TOL = 0.15
const MATCH_TOL_TIGHT = 0.05
/** "벌어져야 할 갭 중 실제로 벌어진 비율"의 허용치 — ratio가 1에 가까울 때 MATCH_TOL이 무의미해지는 것을 막는다. */
const REALIZED_TOL = 0.25
const REALIZED_TOL_TIGHT = 0.1

export interface KrxShareChangeInput {
  date: string
  idx: number
  sharesBefore: number
  sharesAfter: number
  /** 직전 거래일 종가(원주가). */
  prevClose: number
  /** 당일 종가(원주가). */
  close: number
}

/**
 * 주식수 변화 한 건을 분류한다. 후보가 아니면 `null`.
 *
 * 판정 (야후 등 외부 시세를 쓰지 않는다 — 대표 지시로 야후 완전 배제). 두 지표를 **함께** 본다.
 *   ratio       = 주식수 after/before        (50:1 분할이면 50)
 *   impliedRatio= 직전종가/당일종가          (분할이면 ≈ratio)
 *   dev         = |impliedRatio/ratio − 1|   ← 지시받은 "±15% 일치" 규칙
 *   realized    = (impliedRatio − 1)/(ratio − 1)  ← "기계적으로 벌어져야 할 갭 중 실제로 벌어진 비율"
 *
 *   분할형 판정 = dev ≤ 15% **그리고** |realized − 1| ≤ 25%
 *     · 신뢰도 high  : dev ≤ 5% 이고 |realized − 1| ≤ 10%
 *     · 신뢰도 medium: 그 외 (같은 날 실제 등락이 섞인 경우)
 *     · 주식수 변화가 5% 미만이면 위를 만족해도 **low로 낮춘다** — 우연일 수 있다.
 *   그 외 = shareChange(유상증자·CB전환·감자형, 가격은 연속) → factor 1, 보정하지 않는다.
 *
 * 왜 dev 하나로는 안 되나(2026-08-03 테스트에서 잡힌 결함): ratio가 1에 가까우면 dev도
 * 자동으로 작아진다. 5% 유상증자에 가격이 **전혀 안 움직여도** dev는 4.8%라 "±5% 일치"에
 * 걸려 분할로 오인되고, 그러면 없는 +5% 수익이 시계열에 생긴다. realized는 그 상황에서
 * 0이 되어(갭이 하나도 안 벌어졌다) 정확히 걸러낸다. 반대로 realized 하나만 쓰면 큰 분할에
 * 붙는 당일 등락을 과대평가하므로, 지시받은 dev 규칙과 둘 다 요구한다.
 *
 * 왜 소폭 변화를 low로 떨구나: 2% 주식수 증가(소량 CB 전환)와 그날의 −1.96% 하락이 우연히
 * 겹치면 두 지표가 다 통과한다. 그걸 분할로 보고 보정하면 없는 2% 수익을 만들어낸다.
 * 그래서 남기되(숨기지 않는다) **기본적으로는 적용하지 않는다**(krxDailyBars 기본값).
 */
export function classifyKrxShareChange(inp: KrxShareChangeInput): KrxAdjEvent | null {
  const { sharesBefore, sharesAfter, prevClose, close } = inp
  if (!(sharesBefore > 0) || !(sharesAfter > 0)) return null
  const ratio = sharesAfter / sharesBefore
  if (Math.abs(ratio - 1) < KRX_SHARE_CHANGE_MIN) return null

  const base = {
    date: inp.date,
    idx: inp.idx,
    sharesBefore,
    sharesAfter,
    ratio,
  }
  if (!(prevClose > 0) || !(close > 0)) {
    return {
      ...base,
      kind: 'shareChange',
      impliedRatio: 0,
      factor: 1,
      confidence: 'low',
      note: '[미검증] 가격 결측으로 대조 불가 — 보정하지 않는다',
    }
  }
  const impliedRatio = prevClose / close
  const dev = Math.abs(impliedRatio / ratio - 1)
  const realized = (impliedRatio - 1) / (ratio - 1)
  const realizedOff = Math.abs(realized - 1)
  const small = Math.abs(ratio - 1) < SMALL_CHANGE
  const pct = (v: number) => `${(v * 100).toFixed(1)}%`
  const shape = `주식수 ×${ratio.toFixed(4)} · 가격비 ×${impliedRatio.toFixed(4)} (괴리 ${pct(dev)} · 갭실현 ${pct(realized)})`

  if (dev <= MATCH_TOL && realizedOff <= REALIZED_TOL) {
    const confidence: KrxAdjConfidence = small ? 'low' : dev <= MATCH_TOL_TIGHT && realizedOff <= REALIZED_TOL_TIGHT ? 'high' : 'medium'
    return {
      ...base,
      kind: 'split',
      impliedRatio,
      factor: ratio,
      confidence,
      note: small
        ? `[미검증] 소폭 변화라 우연일 수 있다 — 기본 미보정. ${shape}`
        : `분할/병합/무상증자형 — ${shape}`,
    }
  }
  return {
    ...base,
    kind: 'shareChange',
    impliedRatio,
    factor: 1,
    confidence: small ? 'medium' : 'high',
    note: `유상증자·CB전환·감자형(가격 연속) — 보정 없음. ${shape}`,
  }
}

/**
 * 한 종목의 시계열에서 수정 이벤트를 전부 뽑는다(수집 스크립트가 쓰는 경로).
 * `rows`는 idx 오름차순이어야 하고, `shares[i]`는 `rows[i]`와 같은 날의 상장주식수다.
 */
export function buildKrxAdjEvents(rows: KrxDailyRow[], shares: number[], calendar: string[]): KrxAdjEvent[] {
  if (rows.length !== shares.length) throw new Error(`rows(${rows.length})와 shares(${shares.length}) 길이가 다르다`)
  const out: KrxAdjEvent[] = []
  for (let i = 1; i < rows.length; i++) {
    const ev = classifyKrxShareChange({
      date: calendar[rows[i][0]] ?? '',
      idx: rows[i][0],
      sharesBefore: shares[i - 1],
      sharesAfter: shares[i],
      prevClose: rows[i - 1][4],
      close: rows[i][4],
    })
    if (ev) out.push(ev)
  }
  return out
}

// ------------------------------------------------------------------- 스키마

/**
 * 압축 시세 한 줄 — `[달력인덱스, 시가, 고가, 저가, 종가]` (+ 거래량 수집 시 6번째).
 *
 * 왜 이렇게 압축했나(용량 예산 50MB): 날짜 문자열은 전역 달력(index.calendar)의 인덱스로,
 * 시가총액은 `종가 × 상장주식수`로 유도 가능하므로 저장하지 않는다(수집 시 응답의 MKTCAP과
 * 대조해 일치율을 보고한다). 상장주식수는 **변한 날만** `shares`에 따로 적는다.
 */
export type KrxDailyRow = [number, number, number, number, number] | [number, number, number, number, number, number]

/** 상장주식수 변경점 — `[달력인덱스, 상장주식수]`. 첫 원소는 반드시 시계열 첫 날이다. */
export type KrxSharesPoint = [number, number]

export interface KrxDailyStock {
  schema: string
  code: string
  name: string
  /** 'raw' 고정 — 파일에 담긴 가격은 **원주가**다. 보정은 읽는 쪽(krxDailyBars)이 한다. */
  adjustment: 'raw'
  /** 항상 false — 배당은 이 경로로 보정되지 않는다(규칙 3). */
  dividendAdjusted: false
  /** 관측된 시장(마지막 관측 기준). 이전상장 종목은 markets에 둘 다 남는다. */
  market: KrxDailyMarket
  markets: KrxDailyMarket[]
  rows: KrxDailyRow[]
  shares: KrxSharesPoint[]
  events: KrxAdjEvent[]
}

export type KrxDailyMarket = 'kospi' | 'kosdaq'

export interface KrxDailyStockEntry {
  code: string
  name: string
  market: KrxDailyMarket
  /** 파일에 담긴 첫/마지막 거래일. */
  from: string
  to: string
  bars: number
  /** [from, to] 구간의 거래일 중 이 종목에 시세가 없던 날 수(거래정지·미상장 등). */
  gaps: number
  /** 용량 예산으로 앞뒤를 잘랐으면 true — 잘랐다는 사실을 숨기지 않는다. */
  trimmed: boolean
  adjEvents: number
  file: string
}

export interface KrxDailyIndex {
  schema: string
  version: number
  source: string
  basis: string
  /** 수집 실행일(YYYY-MM-DD, KST). */
  asOf: string
  from: string
  to: string
  /** 전 기간 거래일(오름차순·중복 없음). 종목 파일의 인덱스가 여기를 가리킨다. */
  calendar: string[]
  /** 응답이 비어 있어 거래일인지 확정할 수 없던 평일(YYYY-MM-DD). 결측을 숨기지 않는다. */
  missingDays: string[]
  /** 거래량 수집 여부. false면 DailyBar.v = 0이다. */
  volume: boolean
  /** 한계 목록 — 화면·로그가 그대로 나른다. */
  limits: string[]
  stocks: KrxDailyStockEntry[]
}

export interface KrxMonthlyEntry {
  code: string
  name: string
  rank: number
  /** 시가총액(억원, 반올림). 원 단위는 자릿수가 커서 용량만 먹는다. */
  capEok: number
}

export interface KrxMonthlyMonth {
  /** 그 달의 첫 거래일(YYYY-MM-DD). */
  date: string
  kospi: KrxMonthlyEntry[]
  kosdaq: KrxMonthlyEntry[]
}

export interface KrxMonthlyUniverse {
  schema: string
  version: number
  source: string
  basis: string
  asOf: string
  topN: number
  /** 거래일을 못 찾은 달(YYYY-MM). 조용히 건너뛰지 못하게 파일에 박는다. */
  missingMonths: string[]
  months: Record<string, KrxMonthlyMonth>
}

export interface KrxAdjEventsFile {
  schema: string
  version: number
  asOf: string
  /** 판정 규칙 한 줄 — 나중에 규칙을 바꾸면 여기도 바뀐다. */
  rule: string
  events: (KrxAdjEvent & { code: string; name: string })[]
}

// -------------------------------------------------------------------- 파서

function fail(what: string, msg: string): never {
  throw new Error(`${what} 스키마 위반 — ${msg}`)
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function asArray(v: unknown, what: string, where: string): unknown[] {
  if (!Array.isArray(v)) fail(what, `${where}가 배열이 아니다`)
  return v
}

/**
 * `index.json`을 검증하며 읽는다. **거부하는 것**(조용히 넘어가면 백테스트가 거짓말을 한다):
 *   · 스키마·버전 불일치, 필수 필드 누락
 *   · 달력이 오름차순이 아니거나 중복 날짜가 있음
 *   · 종목 코드 중복 / 파일 경로 규약 위반
 *   · from·to가 달력 양 끝과 다름
 */
export function parseKrxDailyIndex(raw: unknown): KrxDailyIndex {
  const W = 'krx-daily/index.json'
  if (typeof raw !== 'object' || raw == null) fail(W, '최상위가 객체가 아니다')
  const o = raw as Record<string, unknown>
  const schema = String(o.schema ?? '')
  if (schema !== KRX_DAILY_SCHEMA_INDEX) fail(W, `schema가 ${KRX_DAILY_SCHEMA_INDEX}가 아니다 (${schema || '없음'})`)
  const version = Number(o.version)
  if (!Number.isInteger(version) || version < 1) fail(W, `version이 1 이상의 정수가 아니다 (${String(o.version)})`)
  const source = String(o.source ?? '')
  const basis = String(o.basis ?? '')
  const asOf = String(o.asOf ?? '')
  if (!source.trim()) fail(W, 'source가 비어 있다')
  if (!basis.trim()) fail(W, 'basis가 비어 있다')
  if (!DATE_RE.test(asOf)) fail(W, `asOf가 YYYY-MM-DD가 아니다 (${asOf || '없음'})`)

  const calRaw = asArray(o.calendar, W, 'calendar')
  if (calRaw.length === 0) fail(W, 'calendar가 비어 있다')
  const calendar: string[] = []
  calRaw.forEach((d, i) => {
    const s = String(d)
    if (!DATE_RE.test(s)) fail(W, `calendar[${i}]가 YYYY-MM-DD가 아니다 (${s})`)
    if (i > 0 && s <= calendar[i - 1]) fail(W, `calendar[${i}](${s})가 오름차순이 아니다 — 중복·역순은 인덱스를 무의미하게 만든다`)
    calendar.push(s)
  })

  const missingDays = asArray(o.missingDays, W, 'missingDays').map((d, i) => {
    const s = String(d)
    if (!DATE_RE.test(s)) fail(W, `missingDays[${i}]가 YYYY-MM-DD가 아니다 (${s})`)
    return s
  })
  const from = String(o.from ?? '')
  const to = String(o.to ?? '')
  if (from !== calendar[0]) fail(W, `from(${from || '없음'})이 calendar 첫 날(${calendar[0]})과 다르다`)
  if (to !== calendar[calendar.length - 1]) fail(W, `to(${to || '없음'})가 calendar 마지막 날과 다르다`)
  const volume = o.volume
  if (typeof volume !== 'boolean') fail(W, 'volume이 boolean이 아니다')
  const limits = asArray(o.limits, W, 'limits').map(String)
  if (limits.length === 0) fail(W, 'limits가 비어 있다 — 한계 표기를 지우지 마라(규칙 3)')

  const stocksRaw = asArray(o.stocks, W, 'stocks')
  if (stocksRaw.length === 0) fail(W, 'stocks가 비어 있다')
  const seen = new Set<string>()
  const stocks: KrxDailyStockEntry[] = stocksRaw.map((r, i) => {
    if (typeof r !== 'object' || r == null) fail(W, `stocks[${i}]가 객체가 아니다`)
    const e = r as Record<string, unknown>
    const code = String(e.code ?? '')
    const name = String(e.name ?? '')
    const market = String(e.market ?? '')
    if (!/^\d{6}$/.test(code)) fail(W, `stocks[${i}].code가 6자리가 아니다 (${code || '없음'})`)
    if (seen.has(code)) fail(W, `stocks에 중복 종목코드 ${code}가 있다`)
    seen.add(code)
    if (!name.trim()) fail(W, `stocks[${i}].name이 비어 있다 (${code})`)
    if (market !== 'kospi' && market !== 'kosdaq') fail(W, `stocks[${i}].market이 kospi/kosdaq가 아니다 (${market})`)
    const fromD = String(e.from ?? '')
    const toD = String(e.to ?? '')
    if (!DATE_RE.test(fromD) || !DATE_RE.test(toD)) fail(W, `stocks[${i}]의 from/to가 YYYY-MM-DD가 아니다 (${code})`)
    if (fromD > toD) fail(W, `stocks[${i}].from이 to보다 늦다 (${code})`)
    const bars = Number(e.bars)
    if (!Number.isInteger(bars) || bars < 1) fail(W, `stocks[${i}].bars가 1 이상의 정수가 아니다 (${code})`)
    const gaps = Number(e.gaps)
    if (!Number.isInteger(gaps) || gaps < 0) fail(W, `stocks[${i}].gaps가 0 이상의 정수가 아니다 (${code})`)
    const adjEvents = Number(e.adjEvents)
    if (!Number.isInteger(adjEvents) || adjEvents < 0) fail(W, `stocks[${i}].adjEvents가 0 이상의 정수가 아니다 (${code})`)
    const trimmed = e.trimmed
    if (typeof trimmed !== 'boolean') fail(W, `stocks[${i}].trimmed가 boolean이 아니다 (${code})`)
    const file = String(e.file ?? '')
    if (file !== krxDailyPriceFile(code)) fail(W, `stocks[${i}].file이 규약(${krxDailyPriceFile(code)})과 다르다 (${file || '없음'})`)
    return { code, name, market: market as KrxDailyMarket, from: fromD, to: toD, bars, gaps, trimmed, adjEvents, file }
  })

  return {
    schema,
    version,
    source,
    basis,
    asOf,
    from,
    to,
    calendar,
    missingDays,
    volume,
    limits,
    stocks,
  }
}

function parseAdjEvent(raw: unknown, W: string, where: string, calLen: number): KrxAdjEvent {
  if (typeof raw !== 'object' || raw == null) fail(W, `${where}가 객체가 아니다`)
  const e = raw as Record<string, unknown>
  const date = String(e.date ?? '')
  if (!DATE_RE.test(date)) fail(W, `${where}.date가 YYYY-MM-DD가 아니다 (${date || '없음'})`)
  const idx = Number(e.idx)
  if (!Number.isInteger(idx) || idx < 0 || (calLen > 0 && idx >= calLen)) fail(W, `${where}.idx가 달력 범위를 벗어났다 (${idx})`)
  const kind = String(e.kind ?? '')
  if (kind !== 'split' && kind !== 'shareChange') fail(W, `${where}.kind가 split/shareChange가 아니다 (${kind})`)
  const confidence = String(e.confidence ?? '')
  if (!['high', 'medium', 'low'].includes(confidence)) fail(W, `${where}.confidence가 high/medium/low가 아니다 (${confidence})`)
  const ratio = Number(e.ratio)
  const factor = Number(e.factor)
  if (!Number.isFinite(ratio) || ratio <= 0) fail(W, `${where}.ratio가 양수가 아니다 (${String(e.ratio)})`)
  if (!Number.isFinite(factor) || factor <= 0) fail(W, `${where}.factor가 양수가 아니다 (${String(e.factor)})`)
  if (kind === 'shareChange' && factor !== 1) fail(W, `${where}: shareChange인데 factor가 1이 아니다 (${factor}) — 보정 대상이 아니다`)
  const sharesBefore = Number(e.sharesBefore)
  const sharesAfter = Number(e.sharesAfter)
  if (!(sharesBefore > 0) || !(sharesAfter > 0)) fail(W, `${where}의 상장주식수가 양수가 아니다`)
  return {
    date,
    idx,
    kind,
    sharesBefore,
    sharesAfter,
    ratio,
    impliedRatio: Number(e.impliedRatio) || 0,
    factor,
    confidence: confidence as KrxAdjConfidence,
    note: String(e.note ?? ''),
  }
}

/**
 * `prices/{code}.json`을 검증하며 읽는다. **거부하는 것**:
 *   · 스키마 불일치, 코드 형식 위반
 *   · rows의 달력 인덱스가 오름차순이 아니거나 달력 범위를 벗어남
 *   · OHLC가 0 이하 / 고가<max(시,종) / 저가>min(시,종) — 가격 정합 위반
 *   · shares의 첫 원소가 rows 첫 날이 아님(그 이전 구간의 주식수를 모르게 된다)
 *   · 이벤트가 rows에 없는 날을 가리킴
 *
 * `calendarLen`을 주면 인덱스 상한까지 본다(index.json과 함께 읽을 때).
 */
export function parseKrxDailyStock(raw: unknown, calendarLen = 0): KrxDailyStock {
  const W = 'krx-daily/prices'
  if (typeof raw !== 'object' || raw == null) fail(W, '최상위가 객체가 아니다')
  const o = raw as Record<string, unknown>
  const schema = String(o.schema ?? '')
  if (schema !== KRX_DAILY_SCHEMA_PRICES) fail(W, `schema가 ${KRX_DAILY_SCHEMA_PRICES}가 아니다 (${schema || '없음'})`)
  const code = String(o.code ?? '')
  if (!/^\d{6}$/.test(code)) fail(W, `code가 6자리가 아니다 (${code || '없음'})`)
  const name = String(o.name ?? '')
  if (!name.trim()) fail(W, `name이 비어 있다 (${code})`)
  if (o.adjustment !== 'raw') fail(W, `${code}: adjustment가 'raw'가 아니다 — 파일에는 원주가만 담는다`)
  if (o.dividendAdjusted !== false) fail(W, `${code}: dividendAdjusted가 false가 아니다 — 배당은 보정되지 않는다(규칙 3)`)
  const market = String(o.market ?? '')
  if (market !== 'kospi' && market !== 'kosdaq') fail(W, `${code}: market이 kospi/kosdaq가 아니다 (${market})`)
  const markets = asArray(o.markets, W, `${code}.markets`).map((m) => {
    const s = String(m)
    if (s !== 'kospi' && s !== 'kosdaq') fail(W, `${code}: markets에 kospi/kosdaq가 아닌 값 (${s})`)
    return s as KrxDailyMarket
  })
  if (markets.length === 0) fail(W, `${code}: markets가 비어 있다`)

  const rowsRaw = asArray(o.rows, W, `${code}.rows`)
  if (rowsRaw.length === 0) fail(W, `${code}: rows가 비어 있다`)
  const rows: KrxDailyRow[] = []
  let prevIdx = -1
  rowsRaw.forEach((r, i) => {
    if (!Array.isArray(r) || (r.length !== 5 && r.length !== 6)) fail(W, `${code}: rows[${i}]가 길이 5·6 배열이 아니다`)
    const nums = r.map(Number)
    if (nums.some((v) => !Number.isFinite(v))) fail(W, `${code}: rows[${i}]에 비수치 값이 있다`)
    const [idx, open, high, low, close] = nums
    if (!Number.isInteger(idx) || idx < 0) fail(W, `${code}: rows[${i}][0]이 0 이상의 정수 인덱스가 아니다 (${idx})`)
    if (calendarLen > 0 && idx >= calendarLen) fail(W, `${code}: rows[${i}]의 달력 인덱스 ${idx}가 달력 길이 ${calendarLen}를 넘는다`)
    if (idx <= prevIdx) fail(W, `${code}: rows[${i}]의 인덱스 ${idx}가 오름차순이 아니다 (직전 ${prevIdx})`)
    prevIdx = idx
    if (![open, high, low, close].every((v) => v > 0)) fail(W, `${code}: rows[${i}]의 OHLC에 0 이하가 있다 — 결측을 0으로 저장하지 마라`)
    if (high < Math.max(open, close) || low > Math.min(open, close))
      fail(W, `${code}: rows[${i}]의 고저가 시종가를 감싸지 않는다 (o${open} h${high} l${low} c${close})`)
    if (r.length === 6 && nums[5] < 0) fail(W, `${code}: rows[${i}]의 거래량이 음수다`)
    rows.push((r.length === 6 ? [idx, open, high, low, close, nums[5]] : [idx, open, high, low, close]) as KrxDailyRow)
  })

  const sharesRaw = asArray(o.shares, W, `${code}.shares`)
  if (sharesRaw.length === 0) fail(W, `${code}: shares가 비어 있다 — 수정계수 산출 근거가 사라진다`)
  const shares: KrxSharesPoint[] = []
  let prevSIdx = -1
  sharesRaw.forEach((s, i) => {
    if (!Array.isArray(s) || s.length !== 2) fail(W, `${code}: shares[${i}]가 길이 2 배열이 아니다`)
    const idx = Number(s[0])
    const v = Number(s[1])
    if (!Number.isInteger(idx) || idx <= prevSIdx) fail(W, `${code}: shares[${i}]의 인덱스가 오름차순 정수가 아니다 (${idx})`)
    if (!(v > 0)) fail(W, `${code}: shares[${i}]의 상장주식수가 양수가 아니다 (${v})`)
    prevSIdx = idx
    shares.push([idx, v])
  })
  if (shares[0][0] !== rows[0][0]) fail(W, `${code}: shares 첫 원소(${shares[0][0]})가 rows 첫 날(${rows[0][0]})이 아니다`)

  const rowIdxSet = new Set(rows.map((r) => r[0]))
  const events = asArray(o.events, W, `${code}.events`).map((e, i) => {
    const ev = parseAdjEvent(e, W, `${code}.events[${i}]`, calendarLen)
    if (!rowIdxSet.has(ev.idx)) fail(W, `${code}: events[${i}]가 시세에 없는 날(idx ${ev.idx})을 가리킨다`)
    if (ev.idx === rows[0][0]) fail(W, `${code}: events[${i}]가 첫 봉을 가리킨다 — 직전 봉이 없어 판정 근거가 없다`)
    return ev
  })

  return {
    schema,
    code,
    name,
    adjustment: 'raw',
    dividendAdjusted: false,
    market: market as KrxDailyMarket,
    markets,
    rows,
    shares,
    events,
  }
}

/** `monthly-universe.json`을 검증하며 읽는다. 순위 빈틈·중복·결측 은닉을 거부한다. */
export function parseKrxMonthlyUniverse(raw: unknown): KrxMonthlyUniverse {
  const W = 'krx-daily/monthly-universe.json'
  if (typeof raw !== 'object' || raw == null) fail(W, '최상위가 객체가 아니다')
  const o = raw as Record<string, unknown>
  if (String(o.schema ?? '') !== KRX_DAILY_SCHEMA_MONTHLY)
    fail(W, `schema가 ${KRX_DAILY_SCHEMA_MONTHLY}가 아니다 (${String(o.schema ?? '없음')})`)
  const version = Number(o.version)
  if (!Number.isInteger(version) || version < 1) fail(W, 'version이 1 이상의 정수가 아니다')
  const source = String(o.source ?? '')
  const basis = String(o.basis ?? '')
  const asOf = String(o.asOf ?? '')
  if (!source.trim()) fail(W, 'source가 비어 있다')
  if (!basis.trim()) fail(W, 'basis가 비어 있다')
  if (!DATE_RE.test(asOf)) fail(W, `asOf가 YYYY-MM-DD가 아니다 (${asOf || '없음'})`)
  const topN = Number(o.topN)
  if (!Number.isInteger(topN) || topN < 1) fail(W, 'topN이 1 이상의 정수가 아니다')

  const missingMonths = asArray(o.missingMonths, W, 'missingMonths').map((m, i) => {
    const s = String(m)
    if (!/^\d{4}-\d{2}$/.test(s)) fail(W, `missingMonths[${i}]가 YYYY-MM이 아니다 (${s})`)
    return s
  })

  if (typeof o.months !== 'object' || o.months == null || Array.isArray(o.months)) fail(W, 'months가 객체가 아니다')
  const monthsRaw = o.months as Record<string, unknown>
  const keys = Object.keys(monthsRaw).sort()
  if (keys.length === 0) fail(W, 'months가 비어 있다')

  const parseSide = (v: unknown, where: string): KrxMonthlyEntry[] => {
    const arr = asArray(v, W, where)
    if (arr.length === 0) fail(W, `${where}가 비어 있다`)
    const seen = new Set<string>()
    return arr.map((r, i) => {
      if (typeof r !== 'object' || r == null) fail(W, `${where}[${i}]가 객체가 아니다`)
      const e = r as Record<string, unknown>
      const code = String(e.code ?? '')
      const name = String(e.name ?? '')
      const rank = Number(e.rank)
      const capEok = Number(e.capEok)
      if (!/^\d{6}$/.test(code)) fail(W, `${where}[${i}].code가 6자리가 아니다 (${code || '없음'})`)
      if (seen.has(code)) fail(W, `${where}에 중복 종목코드 ${code}가 있다`)
      seen.add(code)
      if (!name.trim()) fail(W, `${where}[${i}].name이 비어 있다 (${code})`)
      if (rank !== i + 1) fail(W, `${where}[${i}].rank가 ${i + 1}이 아니다 (${rank}) — 순위에 빈틈이 있다`)
      if (!Number.isFinite(capEok) || capEok <= 0) fail(W, `${where}[${i}].capEok이 양수가 아니다 (${code})`)
      return { code, name, rank, capEok }
    })
  }

  const missSet = new Set(missingMonths)
  const months: Record<string, KrxMonthlyMonth> = {}
  for (const k of keys) {
    if (!/^\d{4}-\d{2}$/.test(k)) fail(W, `months 키가 YYYY-MM이 아니다 (${k})`)
    if (missSet.has(k)) fail(W, `${k}가 missingMonths에 있으면서 months에도 있다`)
    const mv = monthsRaw[k]
    if (typeof mv !== 'object' || mv == null) fail(W, `months.${k}가 객체가 아니다`)
    const rec = mv as Record<string, unknown>
    const date = String(rec.date ?? '')
    if (!DATE_RE.test(date)) fail(W, `months.${k}.date가 YYYY-MM-DD가 아니다 (${date || '없음'})`)
    if (date.slice(0, 7) !== k) fail(W, `months.${k}.date(${date})가 그 달이 아니다`)
    const kospi = parseSide(rec.kospi, `months.${k}.kospi`)
    const kosdaq = parseSide(rec.kosdaq, `months.${k}.kosdaq`)
    const seen = new Set<string>()
    for (const e of [...kospi, ...kosdaq]) {
      if (seen.has(e.code)) fail(W, `months.${k}에 시장을 가로지르는 중복 종목코드 ${e.code}가 있다`)
      seen.add(e.code)
    }
    months[k] = { date, kospi, kosdaq }
  }

  // 덮는 구간 안의 구멍은 missingMonths에 명시되지 않으면 거부한다(결측 은닉 금지).
  const present = keys.slice().sort()
  const monthSeq = (s: string): number => Number(s.slice(0, 4)) * 12 + Number(s.slice(5, 7)) - 1
  for (let m = monthSeq(present[0]); m <= monthSeq(present[present.length - 1]); m++) {
    const key = `${String(Math.floor(m / 12)).padStart(4, '0')}-${String((m % 12) + 1).padStart(2, '0')}`
    if (months[key]) continue
    if (missSet.has(key)) continue
    fail(W, `${key}가 빠졌는데 missingMonths에도 없다 — 결측을 숨기지 마라`)
  }

  return { schema: KRX_DAILY_SCHEMA_MONTHLY, version, source, basis, asOf, topN, missingMonths, months }
}

/** 그 달 그 시장의 상위 `topN` 코드. 없는 달은 빈 배열. */
export function krxMonthlyMarketCodes(u: KrxMonthlyUniverse, month: string, market: KrxDailyMarket, topN: number): string[] {
  const m = u.months[month]
  if (!m) return []
  return m[market].slice(0, Math.max(0, topN)).map((e) => e.code)
}

/** 그 달 유니버스 = 각 시장 상위 `topN`의 합집합(코스피 먼저). */
export function krxMonthlyCodes(u: KrxMonthlyUniverse, month: string, topN: number): string[] {
  return [...krxMonthlyMarketCodes(u, month, 'kospi', topN), ...krxMonthlyMarketCodes(u, month, 'kosdaq', topN)]
}

/** 전 기간 합집합(시세를 한 번만 받기 위한 조회용). */
export function krxMonthlyUnion(u: KrxMonthlyUniverse, topN: number): string[] {
  const set = new Set<string>()
  for (const k of Object.keys(u.months)) for (const c of krxMonthlyCodes(u, k, topN)) set.add(c)
  return [...set].sort()
}

// ------------------------------------------------------------- Bar 변환(보정)

export interface KrxDailyBarsOptions {
  /**
   * confidence:'low'인 분할 후보도 보정할지. 기본 false —
   * 애매한 건을 조용히 보정해 없는 수익을 만들지 않는다. 켜면 `applied`에 들어온다.
   */
  applyLowConfidence?: boolean
}

export interface KrxDailyBarsResult {
  /** 수정주가가 적용된 봉(오름차순). 배당은 반영되지 않는다. */
  bars: DailyBar[]
  /** 실제로 가격에 반영한 이벤트. */
  applied: KrxAdjEvent[]
  /** 보정하지 않은 이벤트(유상증자형·low confidence) — 숨기지 않고 돌려준다. */
  skipped: KrxAdjEvent[]
  /** 한계·주의 문구(배지용). */
  notes: string[]
}

/**
 * 원주가 파일 → **수정주가 Bar 배열**.
 *
 * 표준 수정주가: 분할형 이벤트가 idx=E에 있으면 E **이전** 봉의 가격에 1/ratio를 곱해
 * 이후 스케일로 맞춘다(누적). 그러면 이벤트일을 제외한 모든 날의 **일별 수익률이
 * 보정 전후로 동일**하다 — 이 성질을 `tests/krxdaily.test.ts`가 검증한다.
 *
 * 미래참조(규칙 1)와의 관계: 수정계수는 **과거 가격을 미래 이벤트로 다시 쓰는** 조작이다.
 * 이는 업계 표준 수정주가와 같은 성질이며(Yahoo adjclose도 동일), 어제까지의 수익률을
 * 바꾸지 않는다는 점에서 전략 신호의 인과성을 깨지 않는다. 다만 **절대 가격 수준**은
 * 파일을 다시 수집하면 바뀔 수 있으므로, 가격 절대값에 기대는 규칙(예: "10,000원 이하")은
 * 이 시계열에서 쓰지 않는다.
 */
export function krxDailyBars(index: KrxDailyIndex, stock: KrxDailyStock, opts: KrxDailyBarsOptions = {}): KrxDailyBarsResult {
  const { calendar } = index
  const applyLow = opts.applyLowConfidence === true
  const applied: KrxAdjEvent[] = []
  const skipped: KrxAdjEvent[] = []
  const byIdx = new Map<number, KrxAdjEvent>()
  for (const ev of stock.events) {
    const use = ev.kind === 'split' && (ev.confidence !== 'low' || applyLow)
    if (use) {
      applied.push(ev)
      byIdx.set(ev.idx, ev)
    } else skipped.push(ev)
  }

  // 뒤에서 앞으로 누적 — 이벤트일 자신은 이미 새 스케일이므로 현재 계수를 그대로 받고,
  // 그보다 **이전** 봉부터 1/ratio가 곱해진다.
  const n = stock.rows.length
  const factors = new Array<number>(n).fill(1)
  let f = 1
  for (let i = n - 1; i >= 0; i--) {
    factors[i] = f
    const ev = byIdx.get(stock.rows[i][0])
    if (ev) f = f / ev.ratio
  }

  const bars: DailyBar[] = stock.rows.map((r, i) => {
    const date = calendar[r[0]]
    if (!date) throw new Error(`${stock.code}: 달력 인덱스 ${r[0]}에 해당하는 날짜가 없다`)
    const k = factors[i]
    return {
      date,
      t: Math.floor(Date.parse(`${date}T00:00:00Z`) / 1000),
      o: r[1] * k,
      h: r[2] * k,
      l: r[3] * k,
      c: r[4] * k,
      v: (r as number[])[5] ?? 0,
      rawClose: r[4],
    }
  })

  const notes = [...KRX_DAILY_LIMITS]
  if (skipped.length > 0)
    notes.push(
      `미보정 주식수 변화 ${skipped.length}건(유상증자·CB전환형 또는 [미검증] 저신뢰) — ` +
        skipped.map((e) => `${e.date}(×${e.ratio.toFixed(3)}·${e.confidence})`).join(', '),
    )
  if (!index.volume) notes.push('거래량 미수집 — DailyBar.v는 0이다. 거래량 기반 규칙을 이 시계열에 쓰지 마라.')
  return { bars, applied, skipped, notes }
}

/** 보정하지 않은 원주가 봉(대조·검증용). */
export function krxDailyRawBars(index: KrxDailyIndex, stock: KrxDailyStock): DailyBar[] {
  return krxDailyBars(index, { ...stock, events: [] }).bars
}
