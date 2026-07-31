// 전략 스펙 — 조건식을 **데이터로** 표현한다.
//
// 왜 스펙인가:
//   조건식을 코드에 하드코딩하면 시뮬레이터용 코드와 실거래용 코드가 따로 생기고,
//   그 둘이 미세하게 갈라지는 순간 **백테스트 결과가 실전을 설명하지 못한다.**
//   그래서 조건식을 JSON 직렬화 가능한 스펙으로 두고, 평가 함수는 **하나만** 쓴다.
//
//       StrategySpec (JSON)
//            ├─→ 백테스트 엔진      (과거 봉을 순회)
//            └─→ 실시간 평가기      (오늘 봉을 1회 평가)   ← 같은 evaluateEntry 사용
//
//   두 소비자가 같은 함수를 부르므로 "시뮬에선 됐는데 실전에선 다르다"가 구조적으로 불가능해진다.
//
// 실계좌 경계(규칙 2): 이 파일에는 주문·브로커·자격증명이 없다. 스펙은 "무엇을 살 것인가"까지만
//   기술하고, "어떻게 주문을 낼 것인가"는 담지 않는다. 주문은 별도 어댑터의 몫이며 현재 없다.
//
// 미래참조 금지(규칙 1): 모든 조건은 bars[0..i]만 본다. 횡단면 조건(등락률 순위)도
//   그 시점의 다른 종목 값만 쓴다. 평가 함수가 i를 넘는 인덱스에 접근하지 않는다.

import type { DailyBar } from './types'

export const SPEC_VERSION = 1 as const

// ---- 개별 조건 -------------------------------------------------------------
//
// 영웅문4 조건검색에서 실제로 쓰이는 항목들을 커버한다.
// 새 조건을 추가할 때는 (1) 여기 타입 (2) evaluateCondition의 case (3) 라벨
// (4) 테스트 — 네 곳을 같이 건드린다.

export type Condition =
  /** 주가 범위 (원) */
  | { kind: 'priceRange'; min?: number; max?: number }
  /** 등락률 상위 N위 이내 — 횡단면 조건(다른 종목과 비교) */
  | { kind: 'changeRank'; top: number }
  /** 등락률 범위 (%) */
  | { kind: 'changePct'; min?: number; max?: number }
  /** 양봉/음봉 */
  | { kind: 'candle'; bull: boolean }
  /** N일 이평 상향/하향 **돌파** (전일은 반대편, 당일은 이쪽) */
  | { kind: 'maCross'; period: number; dir: 'above' | 'below' }
  /** N일 이평 위/아래에 **위치** (돌파 여부 무관) */
  | { kind: 'maPosition'; period: number; dir: 'above' | 'below' }
  /** 이평 정배열 — 단기 이평이 장기 이평 위 (예: 5일선 > 10일선) */
  | { kind: 'maAlign'; fast: number; slow: number }
  /** 거래량 하한 (주) */
  | { kind: 'volume'; min: number }
  /** 거래대금 하한 (원) */
  | { kind: 'tradingValue'; min: number }
  /** 거래량이 직전 N일 평균의 X배 이상 */
  | { kind: 'volumeSurge'; days: number; ratio: number }
  /** 이격도 = 종가/이평 × 100 (%) */
  | { kind: 'disparity'; period: number; min?: number; max?: number }
  /** RSI (%) */
  | { kind: 'rsi'; period: number; min?: number; max?: number }
  /** N일 신고가 돌파 — 당일 제외한 직전 N일 최고 종가 초과 (규칙 1-3) */
  | { kind: 'highBreak'; days: number }
  /** N일 신저가 이탈 */
  | { kind: 'lowBreak'; days: number }
  /** 연속 상승/하락 일수 */
  | { kind: 'streak'; dir: 'up' | 'down'; days: number }

export type ConditionNode =
  | { op: 'and'; nodes: ConditionNode[] }
  | { op: 'or'; nodes: ConditionNode[] }
  | { op: 'not'; node: ConditionNode }
  | { op: 'cond'; id?: string; cond: Condition }

// ---- 매도 규칙 (기존 conditionScreen과 호환) --------------------------------

export type ExitKind =
  | 'stopLoss'
  | 'takeProfit'
  | 'maBreak'
  | 'sameDayClose'
  | 'timeExit'
  | 'trailing'
  | 'conditionExit'

export interface ExitRule {
  kind: ExitKind
  pct?: number
  maPeriod?: number
  days?: number
}

// ---- 전략 스펙 -------------------------------------------------------------

export interface UniverseSpec {
  /** 대상 시장 */
  markets: ('KOSPI' | 'KOSDAQ')[]
  /** 제외 — 영웅문 "대상변경"에 해당 */
  excludeAdministrative: boolean // 관리종목
  excludeSuspended: boolean // 거래정지
  excludeLiquidation: boolean // 정리매매
  excludePreferred: boolean // 우선주
  excludeEtf: boolean // ETF/ETN
  /** 명시적 종목 목록 — 있으면 위 필터 대신 이것만 쓴다(백테스트 표본용) */
  symbols?: string[]
}

export interface RankSpec {
  /** 후보가 슬롯보다 많을 때 무엇으로 줄 세우나 */
  by: 'changePct' | 'tradingValue' | 'volume' | 'none'
  dir: 'desc' | 'asc'
}

export interface SizingSpec {
  /** 동시 보유 종목 수 = 슬롯 */
  maxPositions: number
  /** 슬롯당 배분 방식 */
  mode: 'equalSlot'
}

export interface ExecutionSpec {
  /**
   * 신호 → 체결 타이밍.
   *   nextOpen  : 종가로 판단 → 익일 시가 (규칙 1-2 기본값)
   *   sameClose : 당일 종가 (알고리즘형 LOC. 종가 확정 후 정보는 안 씀)
   *   intraday  : 장중 신호 즉시 (분봉 데이터 필요 — 일봉 백테스트로는 검증 불가)
   */
  timing: 'nextOpen' | 'sameClose' | 'intraday'
  /** 주문 유형 — 시뮬에선 체결 가정, 실거래에선 주문 파라미터가 된다 */
  orderType: 'market' | 'limit'
  /** limit일 때 기준가 대비 오프셋 % (매수는 +면 불리하게 위로) */
  limitOffsetPct?: number
}

export interface StrategySpec {
  version: typeof SPEC_VERSION
  id: string
  name: string
  /** 출처 메모 — 영웅문 조건식 이름 등 */
  source?: string
  universe: UniverseSpec
  entry: ConditionNode
  ranking: RankSpec | null
  exits: ExitRule[]
  sizing: SizingSpec
  execution: ExecutionSpec
  /**
   * 장(레짐) 게이트 — 지정 심볼(예: 코스피 지수 ^KS11)의 조건이 참인 날에만
   * **신규 진입 후보를 뽑는다**. 보유 종목의 청산 규칙은 레짐과 무관하게 계속
   * 동작한다(안 그러면 하락장에서 청산도 못 하는 모순이 생긴다).
   * 레짐 판정도 당일 종가 확정 후 → 다음날 체결 순서라 미래참조가 없다.
   */
  regime?: { symbol: string; entry: ConditionNode } | null
}

// ---- 평가 컨텍스트 ---------------------------------------------------------

/**
 * 횡단면 조건(등락률 순위)을 풀려면 그 시점 다른 종목들의 값이 필요하다.
 * 백테스트는 그날 전 종목을 알고 있고, 실시간은 스크리너 응답을 넣으면 된다 —
 * 둘 다 같은 모양이라 평가 함수를 공유할 수 있다.
 */
export interface CrossSection {
  /** 심볼 → 그 시점 등락률(%) */
  changePct: Map<string, number>
  /** 심볼 → 그 시점 거래대금(원) */
  tradingValue?: Map<string, number>
}

export interface EvalResult {
  passed: boolean
  /** 조건별 통과 여부 — 화면에 "왜 걸렸나/왜 떨어졌나"를 보여주기 위함 */
  detail: { label: string; passed: boolean; value: string | null }[]
}

// ---- 지표 (전부 bars[0..i]만 사용) -----------------------------------------
//
// 지표 캐시: 시뮬 루프는 같은 bars 배열에 (지표, 기간) 조합을 날짜 수만큼 반복 계산한다
// (80종목 × 4,000일 × MA20·MA40이면 창 합산만 수천만 회). 배열 단위로 전 구간을 한 번만
// 계산해 두면 이후 조회는 O(1)이다. 각 원소는 **기존과 같은 순서의 창 루프**로 계산해
// 부동소수 결과까지 완전히 동일하다(합산 순서가 다르면 경계 비교가 갈릴 수 있다).
// 인과성(규칙 1): 원소 j는 j 이전 창만 읽으므로 미래참조가 없고, 절단 불변성도 유지된다.
// bars는 로드 때마다 새 배열이므로 WeakMap 키로 안전하며, 길이가 바뀌면 다시 만든다.
const indicatorCache = new WeakMap<DailyBar[], Map<string, { len: number; arr: Float64Array }>>()

function cachedSeries(bars: DailyBar[], key: string, fill: (arr: Float64Array) => void): Float64Array {
  let byKey = indicatorCache.get(bars)
  if (!byKey) {
    byKey = new Map()
    indicatorCache.set(bars, byKey)
  }
  const hit = byKey.get(key)
  if (hit && hit.len === bars.length) return hit.arr
  const arr = new Float64Array(bars.length).fill(NaN)
  fill(arr)
  byKey.set(key, { len: bars.length, arr })
  return arr
}

const seriesAt = (arr: Float64Array, i: number): number | null =>
  i >= 0 && i < arr.length && !Number.isNaN(arr[i]) ? arr[i] : null

export function sma(bars: DailyBar[], i: number, period: number): number | null {
  if (period <= 0) return null
  const arr = cachedSeries(bars, `sma:${period}`, (a) => {
    for (let j = period - 1; j < bars.length; j++) {
      let s = 0
      for (let k = j - period + 1; k <= j; k++) s += bars[k].c
      a[j] = s / period
    }
  })
  return seriesAt(arr, i)
}

export function rsi(bars: DailyBar[], i: number, period: number): number | null {
  if (period <= 0) return null
  const arr = cachedSeries(bars, `rsi:${period}`, (a) => {
    for (let j = period; j < bars.length; j++) {
      let gain = 0
      let loss = 0
      for (let k = j - period + 1; k <= j; k++) {
        const d = bars[k].c - bars[k - 1].c
        if (d > 0) gain += d
        else loss -= d
      }
      const avgG = gain / period
      const avgL = loss / period
      a[j] = avgL === 0 ? (avgG === 0 ? 50 : 100) : 100 - 100 / (1 + avgG / avgL)
    }
  })
  return seriesAt(arr, i)
}

/** 당일을 **제외한** 직전 N일 최고 종가 (규칙 1-3 — 당일 포함하면 미래참조) */
export function priorHigh(bars: DailyBar[], i: number, days: number): number | null {
  if (days <= 0) return null
  const arr = cachedSeries(bars, `phi:${days}`, (a) => {
    // 단조 감소 덱으로 O(N) — max는 계산 순서와 무관해 기존 루프와 값이 동일하다
    const dq = new Int32Array(bars.length)
    let h = 0
    let t = 0
    for (let j = 0; j < bars.length; j++) {
      while (t > h && dq[h] < j - days) h++
      if (j >= days && t > h) a[j] = bars[dq[h]].c
      while (t > h && bars[dq[t - 1]].c <= bars[j].c) t--
      dq[t++] = j
    }
  })
  return seriesAt(arr, i)
}

export function priorLow(bars: DailyBar[], i: number, days: number): number | null {
  if (days <= 0) return null
  const arr = cachedSeries(bars, `plo:${days}`, (a) => {
    const dq = new Int32Array(bars.length)
    let h = 0
    let t = 0
    for (let j = 0; j < bars.length; j++) {
      while (t > h && dq[h] < j - days) h++
      if (j >= days && t > h) a[j] = bars[dq[h]].c
      while (t > h && bars[dq[t - 1]].c >= bars[j].c) t--
      dq[t++] = j
    }
  })
  return seriesAt(arr, i)
}

export function avgVolume(bars: DailyBar[], i: number, days: number): number | null {
  if (days <= 0) return null
  const arr = cachedSeries(bars, `avol:${days}`, (a) => {
    for (let j = days; j < bars.length; j++) {
      let s = 0
      for (let k = j - days; k <= j - 1; k++) s += bars[k].v
      a[j] = s / days
    }
  })
  return seriesAt(arr, i)
}

export function changePctAt(bars: DailyBar[], i: number): number | null {
  if (i < 1) return null
  const p = bars[i - 1].c
  if (!(p > 0)) return null
  return (bars[i].c / p - 1) * 100
}

export function streakLen(bars: DailyBar[], i: number, dir: 'up' | 'down'): number {
  let n = 0
  for (let k = i; k >= 1; k--) {
    const up = bars[k].c > bars[k - 1].c
    const down = bars[k].c < bars[k - 1].c
    if ((dir === 'up' && up) || (dir === 'down' && down)) n++
    else break
  }
  return n
}

// ---- 조건 라벨 -------------------------------------------------------------

export function conditionLabel(c: Condition): string {
  switch (c.kind) {
    case 'priceRange':
      return `주가 ${c.min?.toLocaleString('ko-KR') ?? '0'}~${c.max?.toLocaleString('ko-KR') ?? '∞'}원`
    case 'changeRank':
      return `등락률 상위 ${c.top}위 이내`
    case 'changePct':
      return `등락률 ${c.min ?? '−∞'}~${c.max ?? '∞'}%`
    case 'candle':
      return c.bull ? '양봉' : '음봉'
    case 'maCross':
      return `${c.period}일선 ${c.dir === 'above' ? '상향' : '하향'} 돌파`
    case 'maPosition':
      return `${c.period}일선 ${c.dir === 'above' ? '위' : '아래'}`
    case 'maAlign':
      return `${c.fast}·${c.slow}일선 정배열`
    case 'volume':
      return `거래량 ${c.min.toLocaleString('ko-KR')}주 이상`
    case 'tradingValue':
      return `거래대금 ${Math.round(c.min / 1e8).toLocaleString('ko-KR')}억 이상`
    case 'volumeSurge':
      return `거래량 ${c.days}일 평균의 ${c.ratio}배 이상`
    case 'disparity':
      return `${c.period}일 이격도 ${c.min ?? '−∞'}~${c.max ?? '∞'}%`
    case 'rsi':
      return `RSI(${c.period}) ${c.min ?? '−∞'}~${c.max ?? '∞'}`
    case 'highBreak':
      return `${c.days}일 신고가 돌파`
    case 'lowBreak':
      return `${c.days}일 신저가 이탈`
    case 'streak':
      return `${c.days}일 연속 ${c.dir === 'up' ? '상승' : '하락'}`
  }
}

// ---- 조건 평가 -------------------------------------------------------------

interface CondEval {
  passed: boolean
  /** 실측값 — 화면에 근거로 표시 */
  value: string | null
}

/**
 * 단일 조건 평가. **bars[i] 이후를 절대 보지 않는다.**
 * 데이터가 모자라 판정할 수 없으면 passed=false (관대하게 통과시키지 않는다).
 */
export function evaluateCondition(
  c: Condition,
  bars: DailyBar[],
  i: number,
  symbol: string,
  cs: CrossSection | null,
  lite = false, // true면 표시용 value 문자열을 만들지 않는다 — 핫루프에서 toLocaleString이 지배적 비용이라
): CondEval {
  if (i < 0 || i >= bars.length) return { passed: false, value: null }
  const b = bars[i]

  switch (c.kind) {
    case 'priceRange': {
      const ok = (c.min == null || b.c >= c.min) && (c.max == null || b.c <= c.max)
      return { passed: ok, value: lite ? null : `${Math.round(b.c).toLocaleString('ko-KR')}원` }
    }
    case 'changeRank': {
      if (!cs) return { passed: false, value: '횡단면 없음' }
      const mine = cs.changePct.get(symbol)
      if (mine == null || !Number.isFinite(mine)) return { passed: false, value: null }
      // 나보다 등락률이 높은 종목 수 + 1 = 내 순위
      let better = 0
      for (const [s, v] of cs.changePct) {
        if (s === symbol) continue
        if (Number.isFinite(v) && v > mine) better++
      }
      const rank = better + 1
      return { passed: rank <= c.top, value: lite ? null : `${rank}위` }
    }
    case 'changePct': {
      const v = changePctAt(bars, i)
      if (v == null) return { passed: false, value: null }
      const ok = (c.min == null || v >= c.min) && (c.max == null || v <= c.max)
      return { passed: ok, value: lite ? null : `${v >= 0 ? '+' : ''}${v.toFixed(2)}%` }
    }
    case 'candle': {
      const bull = b.c > b.o
      return { passed: c.bull ? bull : !bull, value: lite ? null : bull ? '양봉' : '음봉' }
    }
    case 'maCross': {
      const now = sma(bars, i, c.period)
      const prev = i > 0 ? sma(bars, i - 1, c.period) : null
      if (now == null || prev == null || i < 1) return { passed: false, value: '데이터 부족' }
      const pc = bars[i - 1].c
      const ok = c.dir === 'above' ? b.c > now && pc <= prev : b.c < now && pc >= prev
      return { passed: ok, value: lite ? null : `종가 ${Math.round(b.c).toLocaleString('ko-KR')} vs MA ${Math.round(now).toLocaleString('ko-KR')}` }
    }
    case 'maPosition': {
      const now = sma(bars, i, c.period)
      if (now == null) return { passed: false, value: '데이터 부족' }
      const ok = c.dir === 'above' ? b.c > now : b.c < now
      return { passed: ok, value: lite ? null : `종가 ${Math.round(b.c).toLocaleString('ko-KR')} vs MA ${Math.round(now).toLocaleString('ko-KR')}` }
    }
    case 'maAlign': {
      const fast = sma(bars, i, c.fast)
      const slow = sma(bars, i, c.slow)
      if (fast == null || slow == null) return { passed: false, value: '데이터 부족' }
      return {
        passed: fast > slow,
        value: lite ? null : `MA${c.fast} ${Math.round(fast).toLocaleString('ko-KR')} vs MA${c.slow} ${Math.round(slow).toLocaleString('ko-KR')}`,
      }
    }
    case 'volume':
      return { passed: Number.isFinite(b.v) && b.v >= c.min, value: lite ? null : `${Math.round(b.v).toLocaleString('ko-KR')}주` }
    case 'tradingValue': {
      const tv = b.c * b.v
      return { passed: Number.isFinite(tv) && tv >= c.min, value: lite ? null : `${Math.round(tv / 1e8).toLocaleString('ko-KR')}억` }
    }
    case 'volumeSurge': {
      const avg = avgVolume(bars, i, c.days)
      if (avg == null || avg <= 0) return { passed: false, value: '데이터 부족' }
      const r = b.v / avg
      return { passed: r >= c.ratio, value: lite ? null : `${r.toFixed(1)}배` }
    }
    case 'disparity': {
      const m = sma(bars, i, c.period)
      if (m == null || m <= 0) return { passed: false, value: '데이터 부족' }
      const d = (b.c / m) * 100
      const ok = (c.min == null || d >= c.min) && (c.max == null || d <= c.max)
      return { passed: ok, value: lite ? null : `${d.toFixed(1)}%` }
    }
    case 'rsi': {
      const v = rsi(bars, i, c.period)
      if (v == null) return { passed: false, value: '데이터 부족' }
      const ok = (c.min == null || v >= c.min) && (c.max == null || v <= c.max)
      return { passed: ok, value: lite ? null : v.toFixed(1) }
    }
    case 'highBreak': {
      const h = priorHigh(bars, i, c.days)
      if (h == null) return { passed: false, value: '데이터 부족' }
      return { passed: b.c > h, value: lite ? null : `종가 ${Math.round(b.c).toLocaleString('ko-KR')} vs 직전고 ${Math.round(h).toLocaleString('ko-KR')}` }
    }
    case 'lowBreak': {
      const l = priorLow(bars, i, c.days)
      if (l == null) return { passed: false, value: '데이터 부족' }
      return { passed: b.c < l, value: lite ? null : `종가 ${Math.round(b.c).toLocaleString('ko-KR')} vs 직전저 ${Math.round(l).toLocaleString('ko-KR')}` }
    }
    case 'streak': {
      const n = streakLen(bars, i, c.dir)
      return { passed: n >= c.days, value: lite ? null : `${n}일` }
    }
  }
}

/**
 * 조건 트리 평가.
 * detail에는 **말단 조건만** 담는다 — 화면에서 "무엇이 걸렸나"를 보려면 그게 필요하다.
 */
export function evaluateEntry(
  node: ConditionNode,
  bars: DailyBar[],
  i: number,
  symbol: string,
  cs: CrossSection | null,
  collectDetail = true, // false = 핫루프 모드: 상세·문자열 생략 + 단축 평가 (passed 결과는 동일 — 조건은 전부 순수 함수)
): EvalResult {
  const detail: EvalResult['detail'] = []

  const walk = (n: ConditionNode): boolean => {
    switch (n.op) {
      case 'and': {
        if (collectDetail)
          // 전부 평가한다(단축 평가 안 함) — 화면에 모든 조건의 통과 여부를 보여야 하므로
          return n.nodes.map(walk).every(Boolean) && n.nodes.length > 0
        if (n.nodes.length === 0) return false
        for (const child of n.nodes) if (!walk(child)) return false
        return true
      }
      case 'or': {
        if (collectDetail) return n.nodes.map(walk).some(Boolean)
        for (const child of n.nodes) if (walk(child)) return true
        return false
      }
      case 'not':
        return !walk(n.node)
      case 'cond': {
        const r = evaluateCondition(n.cond, bars, i, symbol, cs, !collectDetail)
        if (collectDetail) detail.push({ label: conditionLabel(n.cond), passed: r.passed, value: r.value })
        return r.passed
      }
    }
  }

  const passed = walk(node)
  return { passed, detail }
}

// ---- 조건 존속 판정 (conditionExit용) --------------------------------------

/**
 * 조건 **존속** 판정 — "조건 이탈 시 청산"(conditionExit)이 쓴다.
 *
 * 진입 조건을 그대로 재평가하면 안 되는 이유: 트리거 성격의 조건(돌파·순위·양봉)은
 * 정의상 다음날 거짓이 된다. 그대로 쓰면 "진입 다음날 무조건 청산"이 되어
 * 조건 이탈이 아니라 1일 보유 전략을 재는 셈이다. 그래서 변환표를 적용한다:
 *
 *   제외 (트리거 — 존속 판정에서 무시):
 *     candle, changeRank, changePct, volumeSurge, highBreak, lowBreak, streak
 *   유지형 변환:
 *     maCross above → 종가 ≥ 이평 (경계 **포함** — strict >를 쓰면 평탄 구간에서
 *                      종가 == 이평이 되어 아무 일 없는데 청산되는 오작동이 난다)
 *     maCross below → 종가 ≤ 이평
 *   그대로 (상태 성격):
 *     priceRange, volume, tradingValue, maPosition, maAlign, disparity, rsi
 *
 * 트리거만으로 이뤄진 스펙이면 존속 판정이 불가능하므로 항상 true(이탈 없음).
 * 반환이 false면 청산 신호다. bars[0..i]만 본다 — 보통 i는 전일 인덱스로 호출된다.
 */
export function evaluatePersistence(node: ConditionNode, bars: DailyBar[], i: number, symbol: string): boolean {
  // true/false = 판정, null = 이 가지는 존속 판정에서 제외
  const walk = (n: ConditionNode): boolean | null => {
    switch (n.op) {
      case 'and': {
        const vs = n.nodes.map(walk).filter((v): v is boolean => v !== null)
        return vs.length === 0 ? null : vs.every(Boolean)
      }
      case 'or': {
        const vs = n.nodes.map(walk).filter((v): v is boolean => v !== null)
        return vs.length === 0 ? null : vs.some(Boolean)
      }
      case 'not': {
        const v = walk(n.node)
        return v === null ? null : !v
      }
      case 'cond': {
        const c = n.cond
        switch (c.kind) {
          case 'candle':
          case 'changeRank':
          case 'changePct':
          case 'volumeSurge':
          case 'highBreak':
          case 'lowBreak':
          case 'streak':
            return null // 트리거 — 존속 판정 제외
          case 'maCross': {
            if (i < 0 || i >= bars.length) return false
            const m = sma(bars, i, c.period)
            // 이평을 계산할 수 없으면 보수적으로 이탈 처리 (관대하게 보유하지 않는다)
            if (m == null) return false
            return c.dir === 'above' ? bars[i].c >= m : bars[i].c <= m
          }
          default:
            return evaluateCondition(c, bars, i, symbol, null).passed
        }
      }
    }
  }
  const v = walk(node)
  return v === null ? true : v
}

// ---- 스펙 검증 -------------------------------------------------------------

export interface SpecIssue {
  level: 'error' | 'warn'
  message: string
}

/**
 * 스펙이 실행 가능한지 검사한다. 실거래 어댑터가 붙을 때도 같은 검사를 통과해야 하므로
 * 여기 한 곳에 둔다.
 */
export function validateSpec(spec: StrategySpec): SpecIssue[] {
  const issues: SpecIssue[] = []
  if (spec.version !== SPEC_VERSION) issues.push({ level: 'error', message: `지원하지 않는 스펙 버전: ${spec.version}` })
  if (!spec.id) issues.push({ level: 'error', message: 'id가 없습니다' })

  const countLeaves = (n: ConditionNode): number => {
    switch (n.op) {
      case 'cond':
        return 1
      case 'not':
        return countLeaves(n.node)
      default:
        return n.nodes.reduce((s, x) => s + countLeaves(x), 0)
    }
  }
  if (countLeaves(spec.entry) === 0) issues.push({ level: 'error', message: '매수 조건이 비어 있습니다' })

  if (spec.exits.length === 0) {
    issues.push({
      level: 'warn',
      message: '매도 조건이 없습니다 — 사면 영원히 보유합니다. 검색기는 매수 신호만 주므로 여기서 수익률이 갈립니다.',
    })
  }
  if (spec.sizing.maxPositions < 1) issues.push({ level: 'error', message: '보유 종목 수는 1 이상이어야 합니다' })

  // 횡단면 조건이 있는데 유니버스가 좁으면 순위가 의미를 잃는다
  const hasRank = JSON.stringify(spec.entry).includes('"changeRank"')
  const n = spec.universe.symbols?.length ?? 0
  if (hasRank && n > 0 && n < 50) {
    issues.push({
      level: 'warn',
      message: `등락률 순위 조건이 있는데 후보가 ${n}종목뿐입니다. 전 종목 대비 순위가 아니라 표본 내 순위라 실제와 다릅니다.`,
    })
  }

  if (spec.execution.timing === 'intraday') {
    issues.push({
      level: 'warn',
      message: '장중 즉시 체결은 분봉 데이터가 있어야 검증됩니다. 일봉 백테스트로는 다른 전략을 재는 셈입니다.',
    })
  }
  if (spec.execution.orderType === 'limit' && spec.execution.limitOffsetPct == null) {
    issues.push({ level: 'warn', message: '지정가인데 오프셋이 없습니다 — 미체결률을 가정할 수 없습니다.' })
  }
  return issues
}

// ---- 프리셋 — 영웅문 조건식 "I and A and B and J and K" --------------------

export const HEROMOON_MOMENTUM: StrategySpec = {
  version: SPEC_VERSION,
  id: 'heromoon-momentum',
  name: '급등주 5일선 돌파 (영웅문 조건식)',
  source: '영웅문4 · I and A and B and J and K',
  universe: {
    markets: ['KOSPI', 'KOSDAQ'],
    excludeAdministrative: true,
    excludeSuspended: true,
    excludeLiquidation: true,
    excludePreferred: true,
    excludeEtf: true,
  },
  entry: {
    op: 'and',
    nodes: [
      { op: 'cond', id: 'I', cond: { kind: 'changeRank', top: 100 } },
      { op: 'cond', id: 'A', cond: { kind: 'priceRange', min: 2000, max: 50000 } },
      { op: 'cond', id: 'B', cond: { kind: 'candle', bull: true } },
      { op: 'cond', id: 'J', cond: { kind: 'maCross', period: 5, dir: 'above' } },
      { op: 'cond', id: 'K', cond: { kind: 'volume', min: 300_000 } },
    ],
  },
  ranking: { by: 'changePct', dir: 'desc' },
  exits: [
    { kind: 'stopLoss', pct: 3 },
    { kind: 'maBreak', maPeriod: 5 },
  ],
  sizing: { maxPositions: 5, mode: 'equalSlot' },
  execution: { timing: 'nextOpen', orderType: 'market' },
}
