// 테마 콜 기록 트랙 — **대표의 재량 판단을 검증 가능하게 만드는** 순수 모듈.
//
// ── 왜 만드나 (2026-08-06 대표 지시) ────────────────────────────────────────
//   대표가 AI 바이브코딩을 하다 "DB·클라우드 수요가 늘겠다"고 직감했고, 며칠 뒤 아마존이
//   AWS 성장 가속(28%→37%)으로 하루 +15% 갔다. 직감은 맞았다. **그런데 사지 않았다.**
//
//   이 트랙이 답하려는 질문은 "직감이 맞았나"가 **아니다.** 맞은 직감은 기억에 남고 틀린
//   직감은 안 남기 때문에, 기억만으로는 영원히 알 수 없다. 답해야 하는 질문은 셋이다:
//     ① **인지 정확도** — 기록한 콜들이 벤치를 이겼나 (확증편향 없이 전수로)
//     ② **실행률** — 맞은 직감 중 실제로 실행한 비율은 얼마나 되나
//     ③ 둘 중 **어디가 병목인가** — 못 맞히는 것인가, 맞히고도 안 사는 것인가
//   ①과 ②는 완전히 다른 문제이고 처방도 다르다. 그래서 한 덩어리로 기록하지 않는다.
//
// ── 🚫 이 트랙의 미래참조 금지 (규칙 1의 이 맥락 판) ─────────────────────────
//   백테스트가 아니라 **전진 기록**이므로 절단 불변성 대신 다음을 강제한다:
//     1. 채점 시작가는 **기록 시점(recordedAt) 다음 거래일 시가**다. 기록한 날 종가로
//        살 수는 없다 — 그건 그날 장 마감을 보고 산 것이 된다.
//     2. **소급 등재는 채점에서 제외**한다(`retroactive: true`). 주가가 이미 움직인 뒤에
//        "나 그거 알았는데"를 넣으면 성적표가 통째로 거짓이 된다. 지우지 않고 남기되
//        집계에서 뺀다 — 기록은 남기고 점수는 안 준다.
//     3. `noticedAt`(대표가 인지했다고 말한 시점)은 **자기신고**라 채점에 쓰지 않는다.
//        표시만 하고 [자기신고] 딱지를 붙인다.
//     4. 콜은 기록과 동시에 **봉인**된다(`seal`). 나중에 논지·종목을 고치면 검출된다.
//
// ── 정직성(규칙 3·5) ───────────────────────────────────────────────────────
//   · 절대수익이 아니라 **벤치 대비 알파**로 채점한다. 장이 좋아 오른 것은 실력이 아니다.
//   · 표본이 적으면 적다고 말한다 — 5건 미만이면 집계에 `[표본부족]`을 붙인다.
//   · 실패한 콜을 지우는 경로를 코드에 두지 않는다.

export const THEME_CALLS_SCHEMA = 1
export const THEME_CALLS_SUPPORTED_SCHEMAS: readonly number[] = [1]
export const THEME_CALLS_DATA_URL = 'data/theme-calls.json'

/** 집계를 믿을 만하다고 말하기 위한 최소 표본. 이보다 적으면 숫자에 딱지를 붙인다. */
export const MIN_SAMPLE = 5

/** 채점 지평(일). 짧은 것만 보면 노이즈, 긴 것만 보면 피드백이 늦다. */
export const HORIZONS = [30, 90, 180, 365] as const
export type Horizon = (typeof HORIZONS)[number]

export interface ThemeTarget {
  symbol: string
  market: 'US' | 'KR'
  /** primary = 이 논지의 대표 종목. proxy = 직접 못 사서 대신 담는 것. */
  role: 'primary' | 'proxy'
}

export interface ThemeCall {
  id: string
  /** 기록 시점 — **채점의 유일한 기준**. 이 값이 콜의 시작이다. */
  recordedAt: string
  /** 대표가 인지했다고 말한 시점. **자기신고이며 채점에 쓰지 않는다.** */
  noticedAt: string | null
  /** 무엇을 봤나 — 한 문장으로 검증 가능하게 */
  thesis: string
  /** 어디서 왔나 (직접 체험 / 기사 / 데이터 …) */
  source: string
  targets: ThemeTarget[]
  /** 알파 판정 기준(규칙 5). 미장은 QQQ·SPY, 국장은 069500.KS 등. */
  benchmark: string
  /** 확신도 1~5 — 나중에 "확신이 높을수록 잘 맞았나"를 볼 수 있게 */
  conviction: 1 | 2 | 3 | 4 | 5
  /** **실제로 샀나.** 인지와 실행을 가르는 필드다. */
  acted: boolean
  actedAt: string | null
  /** 안 샀다면 왜 — 실행 병목의 정체를 찾는 데 쓴다 */
  notActedReason: string | null
  /**
   * 주가가 이미 움직인 뒤에 등재한 콜. **채점 집계에서 제외**된다.
   * 기록은 남기되 점수는 주지 않는다.
   */
  retroactive: boolean
  /** 소급이면 왜 남기는지 */
  retroactiveNote: string | null
  /** 봉인 — 사후 수정 **감지**용이지 위조 방지가 아니다(규칙 3: 과장하지 않는다). */
  seal: string
}

export interface ThemeCallLedger {
  schema: number
  updatedAt: string
  note: string
  calls: ThemeCall[]
}

// ── 봉인 ────────────────────────────────────────────────────────────────────

/**
 * FNV-1a 32비트. **암호학적 서명이 아니다** — 마음먹고 고치면 해시도 다시 만들 수 있다.
 * 목적은 "무심코 논지를 고쳤는데 아무도 모르는 것"을 막는 것이다.
 * 브라우저·Node 양쪽에서 같은 값을 내려고 crypto 대신 순수 함수를 쓴다.
 */
export function sealOf(call: Omit<ThemeCall, 'seal'>): string {
  const canon = JSON.stringify([
    call.id,
    call.recordedAt,
    call.thesis,
    call.targets.map((t) => `${t.market}:${t.symbol}:${t.role}`).sort(),
    call.benchmark,
    call.conviction,
    call.retroactive,
  ])
  let h = 0x811c9dc5
  for (let i = 0; i < canon.length; i++) {
    h ^= canon.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return `fnv1a:${h.toString(16).padStart(8, '0')}`
}

export function verifySeal(call: ThemeCall): boolean {
  const { seal: _seal, ...rest } = call
  return sealOf(rest) === call.seal
}

// ── 채점 ────────────────────────────────────────────────────────────────────

export interface PriceLookup {
  /** 그 날짜 **이후 첫 거래일의 시가**. 없으면 null. */
  openOnOrAfter: (symbol: string, date: string) => { date: string; price: number } | null
  /** 그 날짜 **이전 마지막 거래일의 종가**. 없으면 null. */
  closeOnOrBefore: (symbol: string, date: string) => { date: string; price: number } | null
}

export interface HorizonScore {
  horizonDays: number
  /** 지평 끝 날짜(달력) */
  endDate: string
  /** 아직 지평이 안 찼으면 true — 이때 수익률은 **집계에 넣지 않는다** */
  pending: boolean
  targetRetPct: number | null
  benchRetPct: number | null
  alphaPct: number | null
  /** 실제로 체결 가정한 시작일(기록일 다음 거래일) */
  entryDate: string | null
}

export interface CallScore {
  id: string
  sealOk: boolean
  scored: boolean
  /** 채점에서 빠졌다면 이유 */
  excludedWhy: string | null
  horizons: HorizonScore[]
}

const dayMs = 86400e3
const addDays = (iso: string, n: number): string =>
  new Date(Date.parse(iso.slice(0, 10)) + n * dayMs).toISOString().slice(0, 10)

/**
 * 콜 하나를 채점한다.
 *
 * 시작가는 **기록일 다음 거래일 시가**다(규칙 1-2의 이 맥락 판). 대표 종목이 여럿이면
 * 동일가중 평균으로 본다 — 사이징을 기록하지 않았으므로 임의 가중은 거짓이 된다.
 *
 * @param asOf 오늘(채점 실행일). 이보다 뒤인 지평은 `pending`으로 두고 집계에서 뺀다.
 */
export function scoreCall(call: ThemeCall, px: PriceLookup, asOf: string): CallScore {
  const sealOk = verifySeal(call)
  const primaries = call.targets.filter((t) => t.role === 'primary')
  const universe = primaries.length > 0 ? primaries : call.targets

  let excludedWhy: string | null = null
  if (call.retroactive) excludedWhy = '소급 등재 — 주가가 움직인 뒤 기록되어 집계에서 제외'
  else if (!sealOk) excludedWhy = '봉인 불일치 — 기록 후 내용이 바뀌었다'
  else if (universe.length === 0) excludedWhy = '대상 종목 없음'

  // 진입일 = 기록일 다음 거래일. 기록일 당일 종가로 사는 것은 미래참조다.
  const entryBase = addDays(call.recordedAt, 1)
  const entries = universe.map((t) => ({ t, e: px.openOnOrAfter(t.symbol, entryBase) }))
  const benchEntry = px.openOnOrAfter(call.benchmark, entryBase)

  const horizons: HorizonScore[] = HORIZONS.map((h) => {
    const endDate = addDays(call.recordedAt, h)
    const pending = endDate > asOf
    if (pending || excludedWhy || !benchEntry || entries.some((x) => !x.e))
      return {
        horizonDays: h,
        endDate,
        pending,
        targetRetPct: null,
        benchRetPct: null,
        alphaPct: null,
        entryDate: benchEntry?.date ?? null,
      }

    const rets = entries.map(({ t, e }) => {
      const end = px.closeOnOrBefore(t.symbol, endDate)
      return end && e ? (end.price / e.price - 1) * 100 : null
    })
    const benchEnd = px.closeOnOrBefore(call.benchmark, endDate)
    if (rets.some((r) => r === null) || !benchEnd)
      return { horizonDays: h, endDate, pending: false, targetRetPct: null, benchRetPct: null, alphaPct: null, entryDate: benchEntry.date }

    const tgt = (rets as number[]).reduce((a, b) => a + b, 0) / rets.length
    const bch = (benchEnd.price / benchEntry.price - 1) * 100
    return {
      horizonDays: h,
      endDate,
      pending: false,
      targetRetPct: +tgt.toFixed(2),
      benchRetPct: +bch.toFixed(2),
      alphaPct: +(tgt - bch).toFixed(2),
      entryDate: benchEntry.date,
    }
  })

  return { id: call.id, sealOk, scored: excludedWhy === null, excludedWhy, horizons }
}

// ── 집계 ────────────────────────────────────────────────────────────────────

export interface Aggregate {
  horizonDays: number
  /** 채점 가능했던 콜 수 */
  n: number
  /** 알파 > 0 인 콜 비율(%) */
  hitRatePct: number | null
  /** 평균 알파(%p) */
  avgAlphaPct: number | null
  /** 중앙 알파 — 한 건이 평균을 끌고 가는 것을 드러낸다 */
  medianAlphaPct: number | null
  /** 표본이 MIN_SAMPLE 미만이면 true — 화면이 딱지를 붙인다 */
  lowSample: boolean
}

export interface ExecutionStats {
  /** 채점 대상 콜 수(소급·봉인불일치 제외) */
  total: number
  acted: number
  /** 실행률(%) */
  actRatePct: number | null
  /** 알파 양수였던 콜 중 실제로 산 비율 — **이것이 실행 병목의 크기다** */
  actedAmongWinnersPct: number | null
  /** 알파 양수인데 안 산 콜 수 — "알고도 못 산" 건수 */
  missedWinners: number
  /** 안 산 이유 집계 */
  reasons: { reason: string; count: number }[]
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

export function aggregate(calls: ThemeCall[], scores: CallScore[], horizon: number): Aggregate {
  const byId = new Map(scores.map((s) => [s.id, s]))
  const alphas: number[] = []
  for (const c of calls) {
    const s = byId.get(c.id)
    if (!s || !s.scored) continue
    const h = s.horizons.find((x) => x.horizonDays === horizon)
    if (!h || h.pending || h.alphaPct === null) continue
    alphas.push(h.alphaPct)
  }
  const n = alphas.length
  return {
    horizonDays: horizon,
    n,
    hitRatePct: n === 0 ? null : +((alphas.filter((a) => a > 0).length / n) * 100).toFixed(1),
    avgAlphaPct: n === 0 ? null : +(alphas.reduce((a, b) => a + b, 0) / n).toFixed(2),
    medianAlphaPct: n === 0 ? null : +(median(alphas) as number).toFixed(2),
    lowSample: n < MIN_SAMPLE,
  }
}

/** 인지와 실행을 가른다 — 이 트랙의 존재 이유다. */
export function executionStats(calls: ThemeCall[], scores: CallScore[], horizon: number): ExecutionStats {
  const byId = new Map(scores.map((s) => [s.id, s]))
  const scorable = calls.filter((c) => byId.get(c.id)?.scored)
  const acted = scorable.filter((c) => c.acted).length

  let winners = 0
  let actedWinners = 0
  let missedWinners = 0
  for (const c of scorable) {
    const h = byId.get(c.id)!.horizons.find((x) => x.horizonDays === horizon)
    if (!h || h.pending || h.alphaPct === null) continue
    if (h.alphaPct > 0) {
      winners++
      if (c.acted) actedWinners++
      else missedWinners++
    }
  }

  const reasonMap = new Map<string, number>()
  for (const c of scorable) {
    if (c.acted || !c.notActedReason) continue
    reasonMap.set(c.notActedReason, (reasonMap.get(c.notActedReason) ?? 0) + 1)
  }

  return {
    total: scorable.length,
    acted,
    actRatePct: scorable.length === 0 ? null : +((acted / scorable.length) * 100).toFixed(1),
    actedAmongWinnersPct: winners === 0 ? null : +((actedWinners / winners) * 100).toFixed(1),
    missedWinners,
    reasons: [...reasonMap.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count),
  }
}

/** 화면·보고에 같은 문장을 쓰도록 상수로 둔다. */
export const THEME_CALLS_BANNER =
  '📓 **테마 콜 기록** — 대표의 재량 판단을 기록해 두고 **벤치 대비로 전진 채점**합니다. ' +
  '맞은 직감은 기억에 남고 틀린 직감은 안 남기 때문에, 기록하지 않으면 우위가 있는지 영원히 알 수 없습니다. ' +
  '이 트랙은 그 기억의 편향을 없애려고 있습니다 — **틀린 콜도 지워지지 않습니다.**'

export const THEME_CALLS_RULES = [
  '채점 시작가는 **기록일 다음 거래일 시가**입니다 — 기록한 날 종가로 살 수는 없습니다.',
  '**소급 등재는 집계에서 제외**됩니다. 주가가 움직인 뒤 "그거 알았는데"를 넣으면 성적표가 거짓이 됩니다.',
  '`인지 시점`은 자기신고라 채점에 쓰지 않고 표시만 합니다.',
  '판정은 절대수익이 아니라 **벤치 대비 알파**입니다(규칙 5).',
  '표본 5건 미만이면 숫자에 **[표본부족]**이 붙습니다.',
  '봉인(seal)은 사후 수정을 **감지**하는 용도이며 위조 방지가 아닙니다.',
]
