// 아이디어 랩 — 조건 확장 실험 러너 (2026-08-02 대표 지시)
//
//   "조건들을 더 넣어서 검토해보자. 예: 특정 계절마다 특정값 조정 /
//    특정 종목의 특정 월 상승 패턴 / 삼성전자·삼성전자우 주가 차이 기반 매매."
//
// MODE=seasonal  — 월별 계절성 기술통계 + 승자 조건식 위 월 필터 오버레이 A/B
// MODE=monthpat  — 종목×월 상승패턴 셀 선정(확장 윈도우) 후 해당 월만 보유
// MODE=pairprem  — 삼성전자/삼성전자우 괴리율 z-score 스위칭 (롱온리)
// MODE=flow      — 투자자 순매수(수급) 조건 A/B  (2026-08-02 대표 지시 "수급·거래량 기반 검토")
//
// ── 비(非)이평 계열 (2026-08-02 대표 지시 "MA 이평선 말고 다른 접근은 없냐") ──────
// MODE=xsmom    — 횡단면 모멘텀 랭킹(12-1). 이동평균을 아예 쓰지 않는다.
// MODE=volbrk   — 변동성 돌파(래리 윌리엄스 k). 전일 레인지만 쓴다.
// MODE=rsirev   — 단기 평균회귀(RSI2 · Wilder) + 200일선 추세 필터.
//
// ── 25차 승자(횡단면 모멘텀) 검증 3종 (2026-08-02 대표 승인 "모두 진행") ──────
// MODE=xswf     — 워크포워드 + 슬롯 민감도. "사후에 고른 5"와 "그때 골랐을 파라미터"의 차이.
// MODE=usxsmom  — 미장 교차 실행. 24차에서 추세돌파가 미국에서 전패한 것의 역질문.
// MODE=usxsmom80 — 같은 실험을 **미국 상위 80** 유니버스로(2026-08-02 대표 지시). 26차의
//                  "연 20종목이라 분위가 묽다"는 한계가 원인이었는지를 상위 8 = 상위 10%로 재검증.
// MODE=combo    — 기준선 + xsmom 반반 결합. 상관·낙폭 완화 폭을 잰다.
// MODE=overlay  — 위 승자(B=XSM 상위5+게이트 · C=결합 50:50) **위에** 리스크 오버레이 4종을
//                 얹어 수익÷MDD를 높일 수 있는지 본다(2026-08-02 대표 지시). 베이스 재탐색 없음 —
//                 바뀌는 것은 노출뿐이다: 시장 레짐 게이트 · 변동성 타게팅 · 월중 크래시 스톱 ·
//                 결합 역변동성 가중.
//   판정 기준선은 셋 다 **MA25×신고10→80선**(23차 격자 수익÷MDD 1위)을 같은 유니버스·
//   같은 비용으로 **재실행한** 수치다. 다른 표의 숫자를 옮겨 적지 않는다.
//
// ── 발굴 깔때기 1~2관문 — 미검증 랭킹 4계열 일괄 스크리너 ────────────────────
// MODE=screen   — lowvol · hi52 · strev · volrank 네 계열을 **한 번에** 1~2관문에 태운다.
//   계열 단위 탐색 원칙: 이미 판정이 끝난 계열(추세돌파 ✅ · xsmom ✅ · 변동성돌파 ❌ ·
//   RSI 평균회귀 ❌ · 계절성 ❌ · 월패턴 ❌ · 페어 ❌)은 다시 돌리지 않는다. 여기 있는 네 계열은
//   이 리포에서 **처음** 돌아가는 것들이다.
//   전부 xsmom과 **같은 깔때기**를 지난다 — 월 첫 거래일 시가 리밸런스 · 상위 N 동일가중 ·
//   연도별 PIT 10+10 유니버스 교체 연쇄 · 같은 비용 · 같은 벤치(KODEX 200) · 같은 기준선
//   재실행. 계열마다 바뀌는 것은 **랭킹 함수 하나뿐**이며, 그 구조를 `simulateRankYear`가
//   강제한다(xsmom도 이 러너에 얹혀 있어 두 경로가 갈라질 수 없다).
//   변형은 계열당 3개(N=5 · N=10 · N=5+게이트)로 묶어 둔다 — 이것은 정밀 격자가 아니라
//   "3관문으로 보낼 계열이 있는가"를 가리는 스크리닝이다. 변형을 늘릴수록 다중검정
//   위양성이 늘어난다는 것이 24~27차에서 반복 확인된 사실이다.
//
// ── 규칙 1(미래참조 금지) 준수 방법 ────────────────────────────────────────
//   · 모든 통계는 **확장 윈도우**다. 전체 구간 평균·표준편차·최대최소를 임계값
//     산출에 쓰지 않는다(그 자체가 미래 정보). 월 필터·셀 선정은 "그 해 1월 초까지의
//     데이터"만, 괴리율 z는 "그 시점까지의" 평균·표준편차만 쓴다.
//   · pairprem 신호는 당일 종가로 판정하고 **다음 거래일 시가**에 체결한다.
//   · flow는 **T−1 원칙**을 지킨다 — D일 진입 판단(종가 매수)에 쓰는 수급은
//     `dt < D`로 확정된 것만이다. D일 투자자별 순매수는 장 마감 후에야 확정되므로
//     그날 판단에 넣으면 그 자체가 미래참조다(makeFlowLens.before가 유일한 접근 경로).
//   · 마지막 봉에서는 신규 진입·신규 스위칭을 만들지 않는다(체결할 다음 봉이 없다).
//   · 집행자는 `tests/idealab.test.ts`의 절단 불변성 테스트다.
//
// ── 유니버스 ──────────────────────────────────────────────────────────────
//   고정 80종목 유니버스는 승자편향이 확인됐다(총 +42,103% → 연도별 상위 10+10
//   교체 시 +841%). 따라서 유니버스가 필요한 실험은 **연도별 상위 10+10 [추정]**
//   교체 유니버스로 돌린다. PIT1010 상수와 연쇄 로직은 spec-backtest.entry.ts에서
//   복사해 왔다 — 정본은 추후 `src/features/backtest/pitUniverse.ts`로 합류 예정
//   (지금 그 파일을 만들면 다른 워커의 작업 파일과 충돌한다).
//
// ⚠️ 컨테이너에서 Yahoo는 403이라 실데이터 실행은 여기서 하지 않았다.
//    로직은 합성 데이터 테스트로만 검증된 상태다 — 수치 산출은 [미검증-실데이터].

import {
  runStrategySpec,
  type ConditionResult,
  type CostSettings,
} from '../src/features/backtest/conditionScreen'
import {
  SPEC_VERSION,
  priorHigh,
  sma,
  type Condition,
  type ConditionNode,
  type StrategySpec,
} from '../src/features/backtest/strategySpec'
import type { DailyBar } from '../src/features/backtest/types'
import {
  US_COMPANY_NAMES,
  US_PIT80_SOURCE_NOTE,
  US_PIT80_UNION,
  US_PIT_SOURCE_NOTE,
  US_PIT_UNION,
  US_PIT_YEARS,
  resolveUsTicker,
  usPit80Codes,
  usPitCodes,
} from '../src/features/backtest/usPitUniverse'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const COST: CostSettings = { initialCapital: 10_000_000, feePct: 0.015, taxPct: 0.15, slippagePct: 0.1 }
const BENCH = '069500.KS' // KODEX 200
const HALF_SPLIT = '2013-06-30' // 기술통계 전·후반 분할 기준(대표 지시)
const HALF_YEAR = 2014 // 전략 연쇄는 연 단위라 연도 경계로 나눈다(2000~2013 / 2014~)

export function log(msg: string) {
  console.log(msg)
}
export const f1 = (v: number | null) => (v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(1)}`)
export const f2 = (v: number | null) => (v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}`)

// ============================================================================
// 데이터 로더 — spec-backtest.entry.ts에서 복사 (정본 합류 예정)
// ============================================================================

async function fetchDaily(symbol: string, range = '10y'): Promise<DailyBar[]> {
  const qs = range.startsWith('since:')
    ? `period1=${Math.floor(Date.parse(range.slice(6)) / 1000)}&period2=${Math.floor(Date.now() / 1000)}`
    : `range=${range}`
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    symbol,
  )}?${qs}&interval=1d&events=div%2Csplit`
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' } })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const json = (await res.json()) as any
  const r = json?.chart?.result?.[0]
  if (!r) throw new Error(json?.chart?.error?.description ?? 'chart.result 없음')
  const ts: number[] = r.timestamp ?? []
  const q = r.indicators?.quote?.[0] ?? {}
  const adj: (number | null)[] = r.indicators?.adjclose?.[0]?.adjclose ?? []
  const out: DailyBar[] = []
  for (let i = 0; i < ts.length; i++) {
    const o = q.open?.[i]
    const h = q.high?.[i]
    const l = q.low?.[i]
    const cl = q.close?.[i]
    const v = q.volume?.[i]
    if ([o, h, l, cl].some((x: unknown) => x == null || !Number.isFinite(x as number))) continue
    // 총수익 보정(규칙 3): adjclose ÷ close 계수를 OHLC에 적용 (배당 재투자 기준)
    const f = adj[i] != null && Number.isFinite(adj[i]!) && cl > 0 ? adj[i]! / cl : 1
    const date = new Date(ts[i] * 1000 + 9 * 3600 * 1000).toISOString().slice(0, 10) // KST
    out.push({ date, t: ts[i], o: o * f, h: h * f, l: l * f, c: cl * f, v: Number.isFinite(v) ? v : 0 })
  }
  return out
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** 코스닥 출신 종목 폴백 로드 — .KQ 우선, 실패/짧으면 .KS */
async function fetchKrDual(code: string, range: string): Promise<DailyBar[] | null> {
  let best: DailyBar[] | null = null
  for (const suffix of ['.KQ', '.KS']) {
    try {
      const bars = await fetchDaily(`${code}${suffix}`, range)
      if (!best || bars.length > best.length) best = bars
      if (bars.length >= 200) break
    } catch {
      /* 다음 접미사 시도 */
    }
    await sleep(120)
  }
  return best && best.length >= 200 ? best : null
}

// ============================================================================
// 연도별 [추정] 상위 10+10 유니버스 — spec-backtest.entry.ts PIT1010 사본
// 정본은 추후 src/features/backtest/pitUniverse.ts로 합류 예정.
// ============================================================================

export const PIT1010: Record<number, { ks: string[]; kq: string[] }> = {
  2000: { ks: ['005930', '017670', '030200', '015760', '005490', '000660', '005380', '009150', '006400', '033780'], kq: ['035720', '035610', '030520', '036930', '053800'] },
  2001: { ks: ['005930', '017670', '030200', '015760', '005490', '000660', '005380', '033780', '006400', '009150'], kq: ['035720', '036570', '035610', '030520', '036930', '053800'] },
  2002: { ks: ['005930', '017670', '030200', '015760', '005490', '055550', '005380', '033780', '006400', '000660'], kq: ['036570', '035720', '030520', '035610', '036930', '053800', '046890'] },
  2003: { ks: ['005930', '017670', '030200', '015760', '005490', '055550', '005380', '066570', '033780', '012330'], kq: ['035250', '036570', '035760', '035720', '053800', '046890', '030520', '036930'] },
  2004: { ks: ['005930', '017670', '030200', '015760', '005490', '055550', '005380', '066570', '012330', '033780'], kq: ['035420', '032640', '035760', '035720', '034230', '046890', '053800', '036930', '030520', '041510'] },
  2005: { ks: ['005930', '005490', '015760', '017670', '030200', '055550', '005380', '033780', '012330', '009540'], kq: ['035420', '032640', '035760', '035720', '034230', '046890', '053800', '036930', '056190', '041510'] },
  2006: { ks: ['005930', '005490', '015760', '017670', '055550', '030200', '005380', '033780', '012330', '009540'], kq: ['035420', '032640', '035760', '035720', '046890', '034230', '053800', '056190', '041510', '036930'] },
  2007: { ks: ['005930', '005490', '009540', '015760', '055550', '017670', '005380', '034020', '010140', '030200'], kq: ['035420', '032640', '035760', '072870', '041510', '046890', '053800', '056190', '035720', '036930'] },
  2008: { ks: ['005930', '005490', '009540', '015760', '055550', '017670', '005380', '096770', '034020', '030200'], kq: ['035420', '032640', '035760', '072870', '041510', '046890', '056190', '053800', '035720', '036930'] },
  2009: { ks: ['005930', '005490', '015760', '055550', '105560', '017670', '005380', '009540', '051910', '030200'], kq: ['068270', '046890', '072870', '035720', '044490', '056190', '022100', '026960', '053800', '036930'] },
  2010: { ks: ['005930', '005490', '005380', '015760', '055550', '105560', '051910', '017670', '000270', '012330'], kq: ['068270', '046890', '035720', '072870', '022100', '026960', '044490', '056190', '041510', '053800'] },
  2011: { ks: ['005930', '005490', '005380', '012330', '051910', '055550', '105560', '032830', '000270', '015760'], kq: ['068270', '035720', '046890', '026960', '022100', '072870', '096530', '041510', '056190', '035600'] },
  2012: { ks: ['005930', '005380', '005490', '012330', '051910', '032830', '055550', '105560', '000270', '017670'], kq: ['068270', '035720', '046890', '026960', '096530', '041510', '022100', '072870', '056190', '053800'] },
  2013: { ks: ['005930', '005380', '005490', '012330', '051910', '032830', '055550', '105560', '000270', '035420'], kq: ['068270', '035720', '130960', '096530', '046890', '026960', '041510', '022100', '072870', '056190'] },
  2014: { ks: ['005930', '005380', '005490', '012330', '051910', '055550', '105560', '032830', '015760', '035420'], kq: ['068270', '035720', '130960', '046890', '026960', '096530', '041510', '078340', '022100', '072870'] },
  2015: { ks: ['005930', '005380', '015760', '012330', '055550', '032830', '051910', '105560', '005490', '035420'], kq: ['035720', '068270', '130960', '096530', '046890', '041510', '078340', '026960', '072870', '056190'] },
  2016: { ks: ['005930', '005380', '015760', '012330', '032830', '055550', '051910', '105560', '035420', '005490'], kq: ['035720', '068270', '130960', '084990', '041960', '096530', '046890', '041510', '078340', '026960'] },
  2017: { ks: ['005930', '000660', '005380', '015760', '035420', '012330', '051910', '055550', '105560', '032830'], kq: ['035720', '068270', '130960', '084990', '041960', '096530', '078340', '046890', '215600', '041510'] },
  2018: { ks: ['005930', '000660', '005380', '207940', '051910', '055550', '035420', '105560', '012330', '032830'], kq: ['068270', '091990', '215600', '130960', '084990', '263750', '253450', '086900', '096530', '035760'] },
  2019: { ks: ['005930', '000660', '207940', '051910', '068270', '005380', '012330', '055550', '105560', '035420'], kq: ['091990', '215600', '084990', '028300', '086900', '263750', '253450', '068760', '096530', '078340'] },
  2020: { ks: ['005930', '000660', '207940', '035420', '051910', '068270', '005380', '012330', '055550', '105560'], kq: ['091990', '028300', '084990', '263750', '253450', '086900', '068760', '096530', '196170', '278280'] },
  2021: { ks: ['005930', '000660', '051910', '207940', '035420', '005380', '035720', '068270', '006400', '012330'], kq: ['091990', '247540', '196170', '293490', '263750', '068760', '028300', '253450', '112040', '035900'] },
  2022: { ks: ['005930', '000660', '207940', '035420', '051910', '035720', '005380', '006400', '068270', '105560'], kq: ['091990', '247540', '086520', '196170', '293490', '263750', '035900', '112040', '253450', '068760'] },
  2023: { ks: ['005930', '373220', '000660', '207940', '005490', '005380', '051910', '035420', '000270', '012330'], kq: ['247540', '086520', '091990', '066970', '196170', '293490', '022100', '035900', '112040', '263750'] },
  2024: { ks: ['005930', '000660', '373220', '207940', '005380', '000270', '051910', '005490', '105560', '035420'], kq: ['086520', '247540', '066970', '022100', '196170', '028300', '293490', '058470', '348370', '263750'] },
  2025: { ks: ['005930', '000660', '373220', '207940', '005380', '068270', '000270', '105560', '035420', '051910'], kq: ['196170', '086520', '247540', '028300', '066970', '058470', '293490', '348370', '263750', '277810'] },
  2026: { ks: ['005930', '000660', '373220', '207940', '012450', '005380', '105560', '068270', '000270', '035420'], kq: ['196170', '086520', '247540', '277810', '028300', '058470', '066970', '293490', '263750', '348370'] },
}

// ============================================================================
// 스펙 조립 — spec-backtest.entry.ts baseSpec 사본 (승자 조건식 전용으로 축약)
// ============================================================================

const c = (id: string, cond: Condition): ConditionNode => ({ op: 'cond', id, cond })

/** 21차 1위 조건식 — MA10 × 신고20 → 60선 청산 · 이탈버퍼 2% */
export const WINNER = { ma: 10, hb: 20, xm: 60, buf: 2 } as const
export const WINNER_LABEL = `MA${WINNER.ma}×신고${WINNER.hb}→${WINNER.xm}선·버퍼${WINNER.buf}%`
export const MAX_POSITIONS = 10

/** 월 게이트용 합성 레짐 심볼 — 매매 대상이 아니다(엔진이 레짐 심볼을 유니버스에서 제외). */
export const MONTH_GATE = '__MONTHGATE__'

export function winnerSpec(symbols: string[], regimeSymbol: string | null): StrategySpec {
  return {
    version: SPEC_VERSION,
    id: 'idea-lab-winner',
    name: WINNER_LABEL,
    source: '21차 pit1010 1위 조건식',
    universe: {
      markets: ['KOSPI', 'KOSDAQ'],
      excludeAdministrative: true,
      excludeSuspended: true,
      excludeLiquidation: true,
      excludePreferred: true,
      excludeEtf: true,
      symbols,
    },
    entry: {
      op: 'and',
      nodes: [
        c(`${WINNER.ma}일선돌파`, { kind: 'maCross', period: WINNER.ma, dir: 'above' }),
        c(`${WINNER.hb}일신고가`, { kind: 'highBreak', days: WINNER.hb }),
      ],
    },
    ranking: { by: 'tradingValue', dir: 'desc' },
    exits: [{ kind: 'maBreak', maPeriod: WINNER.xm, pct: WINNER.buf }],
    sizing: { maxPositions: MAX_POSITIONS, mode: 'equalSlot' },
    execution: { timing: 'sameClose', orderType: 'market' },
    regime: regimeSymbol
      ? { symbol: regimeSymbol, entry: { op: 'and', nodes: [c('월필터', { kind: 'candle', bull: true })] } }
      : null,
  }
}

// ============================================================================
// 공용 유틸 — 달력·월별 수익·성과지표
// ============================================================================

export const monthOf = (date: string) => Number(date.slice(5, 7))
export const yearOf = (date: string) => Number(date.slice(0, 4))
export const ymOf = (date: string) => date.slice(0, 7)

export function calendarOf(histories: Record<string, DailyBar[]>): string[] {
  const set = new Set<string>()
  for (const bars of Object.values(histories)) for (const b of bars) set.add(b.date)
  return [...set].sort()
}

/**
 * 월 게이트용 합성 봉. 허용 월은 양봉(c>o), 금지 월은 음봉(c<o)으로 만들어
 * 엔진의 레짐 게이트(`{kind:'candle',bull:true}`)가 신규 진입만 막게 한다.
 * 보유 종목의 청산 규칙은 레짐과 무관하게 계속 동작한다(엔진 설계).
 * 각 봉의 값이 **그 날짜만으로** 결정되므로 미래참조가 원천적으로 불가능하다.
 */
export function monthGateBars(dates: string[], allowed: (date: string) => boolean): DailyBar[] {
  return dates.map((date) => {
    const ok = allowed(date)
    return { date, t: 0, o: 100, h: 101, l: 99, c: ok ? 101 : 99, v: 1 }
  })
}

/** 월별 수익비(종가 기준) — key `YYYY-MM`, value = 그 달 마지막종가/첫종가 */
export function monthlyRatios(bars: DailyBar[]): Map<string, number> {
  const first = new Map<string, number>()
  const last = new Map<string, number>()
  for (const b of bars) {
    const k = ymOf(b.date)
    if (!first.has(k)) first.set(k, b.c)
    last.set(k, b.c)
  }
  const out = new Map<string, number>()
  for (const [k, f] of first) {
    const l = last.get(k)!
    if (f > 0) out.set(k, l / f)
  }
  return out
}

export interface Perf {
  total: number // %
  cagr: number // %
  mdd: number // % (음수)
  obj: number | null // 총수익% ÷ |MDD%|
  years: number
}

export function perfOf(equity: { date: string; equity: number }[], from = '', to = '9999-12-31'): Perf {
  const win = equity.filter((e) => e.date >= from && e.date <= to)
  if (win.length < 2) return { total: 0, cagr: 0, mdd: 0, obj: null, years: 0 }
  const start = win[0].equity
  const end = win[win.length - 1].equity
  let peak = start
  let mdd = 0
  for (const e of win) {
    if (e.equity > peak) peak = e.equity
    else mdd = Math.min(mdd, (e.equity / peak - 1) * 100)
  }
  const years = Math.max(1 / 365, (Date.parse(win[win.length - 1].date) - Date.parse(win[0].date)) / (365.25 * 86400e3))
  const ratio = Math.max(end / start, 1e-9)
  const total = (ratio - 1) * 100
  const mddAbs = Math.abs(mdd)
  return { total, cagr: (Math.pow(ratio, 1 / years) - 1) * 100, mdd, obj: mddAbs > 0.01 ? total / mddAbs : null, years }
}

/** 이항 상측 꼬리 P(X ≥ k), X~Bin(n,p) — 다중검정 기대 위양성 계산용 */
export function binomTail(n: number, k: number, p = 0.5): number {
  if (k <= 0) return 1
  if (k > n) return 0
  let s = 0
  for (let i = k; i <= n; i++) {
    let ch = 1
    for (let j = 0; j < i; j++) ch = (ch * (n - j)) / (j + 1)
    s += ch * Math.pow(p, i) * Math.pow(1 - p, n - i)
  }
  return s
}

// ============================================================================
// PIT 연쇄 — spec-backtest.entry.ts pit1010() 사본 + 오버레이 훅
// ============================================================================

export interface YearSlice {
  y: number
  syms: string[]
  hist: Record<string, DailyBar[]>
  mapped: string
}

/** 연도별 유니버스·시계열 준비. 그 해 6월 30일 이전에 상장돼 있던 종목만 편입한다. */
export function buildYearly(histories: Record<string, DailyBar[]>, years: number[]): YearSlice[] {
  return years.map((y) => {
    const codes = [...(PIT1010[y]?.ks ?? []), ...(PIT1010[y]?.kq ?? [])]
    const syms = codes.filter((cd) => histories[cd] && (histories[cd][0]?.date ?? '9999') <= `${y}-06-30`)
    const end = `${y}-12-31`
    const hist: Record<string, DailyBar[]> = {}
    for (const s of syms) hist[s] = histories[s].filter((b) => b.date <= end)
    return { y, syms, hist, mapped: `${syms.length}/${codes.length}` }
  })
}

export interface Overlay {
  key: string
  label: string
  /** 그 해 신규 진입을 금지할 월 집합(1~12). **확장 윈도우로만** 산출할 것. */
  blockedMonths: (y: number) => Set<number>
  /** 그 해의 운용 구간. 구간 끝에서 전량 청산(근사)한다. */
  segments: (y: number) => { start: string; end: string }[]
}

const fullYearSegments = (y: number) => [{ start: `${y}-01-01`, end: `${y}-12-31` }]

/**
 * 구간 끝 청산 비용 근사. 엔진은 마지막 봉에서 미청산 포지션을 시가평가로 남기므로
 * 그대로 두면 "구간을 더 잘게 쪼갠 전략"이 매도비용을 면제받는 이득을 본다
 * (S2는 연 2회 청산, base는 연 1회). 투입비중 ≈ openAtEnd/maxPositions로 보고
 * 매도측 비용(수수료+거래세+슬리피지)을 차감한다. [추정] — 정확한 청산가가 아니다.
 */
export function liquidationHaircut(r: ConditionResult, cost: CostSettings, maxPositions: number): number {
  const frac = Math.min(1, Math.max(0, r.openAtEnd / Math.max(1, maxPositions)))
  return frac * ((cost.feePct + cost.taxPct + cost.slippagePct) / 100)
}

export interface ChainRes {
  equity: { date: string; equity: number }[] // 자본 배수(시작 1.0)
  perYear: { y: number; ret: number; mapped: string }[]
  trades: number
  totalNoHaircut: number // % — 청산 근사 비용 미적용(21차 대조용)
}

/**
 * 연도별 유니버스 교체 연쇄 실행. 각 해(그리고 오버레이가 나눈 각 구간)를 독립
 * 시뮬로 돌리고 자본을 이월해 자산곡선을 스티칭한다. 매핑 종목 5개 미만인 해는
 * 현금 보유로 간주한다(왜곡 방지).
 */
export function runOverlayChain(
  yearly: YearSlice[],
  overlay: Overlay,
  cost: CostSettings,
  applyHaircut = true,
): ChainRes {
  let factor = 1
  let factorNoHc = 1
  const equity: { date: string; equity: number }[] = []
  const perYear: { y: number; ret: number; mapped: string }[] = []
  let trades = 0

  for (const v of yearly) {
    const yearStart = factor
    if (v.syms.length < 5) {
      perYear.push({ y: v.y, ret: 1, mapped: v.mapped })
      continue
    }
    const blocked = overlay.blockedMonths(v.y)
    for (const seg of overlay.segments(v.y)) {
      const hist: Record<string, DailyBar[]> = {}
      for (const s of v.syms) hist[s] = v.hist[s].filter((b) => b.date <= seg.end)
      let spec = winnerSpec(v.syms, null)
      if (blocked.size > 0) {
        const dates = calendarOf(hist).filter((d) => d >= seg.start && d <= seg.end)
        if (dates.length === 0) continue
        hist[MONTH_GATE] = monthGateBars(dates, (d) => !blocked.has(monthOf(d)))
        spec = winnerSpec(v.syms, MONTH_GATE)
      }
      const r = runStrategySpec(hist, seg.start, spec, cost)
      trades += r.trades.length
      const base = factor
      for (const e of r.equity) equity.push({ date: e.date, equity: base * (e.equity / cost.initialCapital) })
      const finalEq = r.equity.length ? r.equity[r.equity.length - 1].equity : cost.initialCapital
      const segRet = finalEq / cost.initialCapital
      const hc = applyHaircut ? liquidationHaircut(r, cost, MAX_POSITIONS) : 0
      factor *= segRet * (1 - hc)
      factorNoHc *= segRet
    }
    perYear.push({ y: v.y, ret: factor / yearStart, mapped: v.mapped })
  }
  return { equity, perYear, trades, totalNoHaircut: (factorNoHc - 1) * 100 }
}

// ---- 오버레이 정의 ---------------------------------------------------------

export const OV_BASE: Overlay = {
  key: 'base',
  label: 'base (오버레이 없음)',
  blockedMonths: () => new Set(),
  segments: fullYearSegments,
}

const MAY_OCT = new Set([5, 6, 7, 8, 9, 10])

export const OV_S1: Overlay = {
  key: 'S1',
  label: 'S1 Sell in May (5~10월 신규 진입 금지)',
  blockedMonths: () => MAY_OCT,
  segments: fullYearSegments,
}

export const OV_S2: Overlay = {
  key: 'S2',
  label: 'S2 11~4월만 운용 (5~10월 진입 금지 + 4월 말 전량 청산)',
  blockedMonths: () => MAY_OCT,
  // 연 단위 유니버스 교체를 유지하면서 5~10월을 통째로 비운다.
  segments: (y) => [
    { start: `${y}-01-01`, end: `${y}-04-30` },
    { start: `${y}-11-01`, end: `${y}-12-31` },
  ],
}

/**
 * S3 동적 월 필터 — 매년 초, **직전 해까지의** 벤치 월별 평균 수익으로
 * 음(-)인 달을 그 해 진입 금지월로 지정한다. 표본 8년 미만이면 필터 없음.
 * 전체 구간 통계를 쓰지 않는다는 것이 이 실험의 핵심이다(규칙 1-5).
 */
export function blockedMonthsExpanding(
  benchMonthly: Map<string, number>,
  year: number,
  minYears = 8,
): Set<number> {
  const out = new Set<number>()
  for (let m = 1; m <= 12; m++) {
    const mm = String(m).padStart(2, '0')
    const rets: number[] = []
    for (const [k, ratio] of benchMonthly) {
      if (k.slice(5, 7) !== mm) continue
      if (Number(k.slice(0, 4)) >= year) continue // 그 해 1월 초 시점에는 알 수 없다
      rets.push(ratio - 1)
    }
    if (rets.length < minYears) continue
    const mean = rets.reduce((s, x) => s + x, 0) / rets.length
    if (mean < 0) out.add(m)
  }
  return out
}

export function makeOvS3(benchMonthly: Map<string, number>, minYears = 8): Overlay {
  const cache = new Map<number, Set<number>>()
  return {
    key: 'S3',
    label: `S3 동적 월 필터 (확장 윈도우 · 최소 표본 ${minYears}년)`,
    blockedMonths: (y) => {
      if (!cache.has(y)) cache.set(y, blockedMonthsExpanding(benchMonthly, y, minYears))
      return cache.get(y)!
    },
    segments: fullYearSegments,
  }
}

// ============================================================================
// MODE=seasonal
// ============================================================================

async function loadPitHistories(range = 'since:1999-01-01') {
  const years = Object.keys(PIT1010).map(Number).sort((a, b) => a - b)
  const union = new Set<string>()
  for (const y of years) for (const cd of [...PIT1010[y].ks, ...PIT1010[y].kq]) union.add(cd)
  const histories: Record<string, DailyBar[]> = {}
  let loadFail = 0
  for (const code of union) {
    const bars = await fetchKrDual(code, range)
    if (bars) histories[code] = bars
    else loadFail++
    await sleep(100)
  }
  const bench = await fetchDaily(BENCH, range)
  log(`시세 로드 ${Object.keys(histories).length}/${union.size} · 실패(상폐 등) ${loadFail}`)
  return { years, histories, bench }
}

function disclaimer(opts: { universe?: boolean; segmentExit?: boolean } = {}) {
  const { universe = true, segmentExit = true } = opts
  log('')
  log('---')
  if (universe) {
    log('⚠️ 유니버스 목록은 연초 시총 **[추정]**(KRX 실측 아님). 상폐·합병 종목은 가격 부재로 빠져')
    log('   특히 2000년대 초 구간이 실제보다 후하게 나온다(생존편향 · 상폐 가격편향).')
  }
  if (segmentExit) log('   구간 끝 청산은 시가평가 근사 + 매도비용 [추정] 차감이며 실제 청산가가 아니다.')
  log('⚠️ 이 수치는 시뮬레이션이며 **투자자문이 아니다.** 손실 경로는 MDD 열이 그 전략이 견뎌야 했던')
  log('   최대 하락이고, 무효화 지점은 "전·후반 중 한쪽이라도 벤치 대비 알파가 음수"다.')
  log('   과거 성적이 미래를 보장하지 않으며, 실제 체결·유동성·세제는 여기 가정과 다를 수 있다.')
}

/** 계절성 기술통계 표 — 월별 평균 수익·양(+)월 비율, 전·후반 분할 */
function seasonalTable(title: string, ratios: Map<string, number>[]) {
  const split = ymOf(HALF_SPLIT)
  const bucket = (m: number, half: 'all' | 'A' | 'B') => {
    const mm = String(m).padStart(2, '0')
    const out: number[] = []
    for (const r of ratios)
      for (const [k, v] of r) {
        if (k.slice(5, 7) !== mm) continue
        if (half === 'A' && k > split) continue
        if (half === 'B' && k <= split) continue
        out.push(v - 1)
      }
    return out
  }
  const cell = (xs: number[]) => {
    if (xs.length === 0) return '— | —'
    const mean = (xs.reduce((s, x) => s + x, 0) / xs.length) * 100
    const pos = (xs.filter((x) => x > 0).length / xs.length) * 100
    return `${f2(mean)}% | ${pos.toFixed(0)}%`
  }
  log('')
  log(`**${title}** (평균 월수익 | 양(+)월 비율, 표본 n)`)
  log('| 월 | 전체 평균 | 전체 +비율 | 전반(~2013-06) 평균 | 전반 +비율 | 후반(2013-07~) 평균 | 후반 +비율 | n(전체) |')
  log('|---|---|---|---|---|---|---|---|')
  for (let m = 1; m <= 12; m++) {
    const all = bucket(m, 'all')
    log(`| ${m}월 | ${cell(all)} | ${cell(bucket(m, 'A'))} | ${cell(bucket(m, 'B'))} | ${all.length} |`)
  }
}

function chainRow(label: string, r: ChainRes) {
  const full = perfOf(r.equity)
  const a = perfOf(r.equity, '', `${HALF_YEAR - 1}-12-31`)
  const b = perfOf(r.equity, `${HALF_YEAR}-01-01`)
  log(
    `| ${label} | ${f1(full.total)}% | ${f1(full.cagr)}% | ${f1(full.mdd)}% | ${full.obj?.toFixed(1) ?? '—'} | ${r.trades} | ` +
      `${f1(a.total)}% / ${f1(a.mdd)}% / ${a.obj?.toFixed(1) ?? '—'} | ${f1(b.total)}% / ${f1(b.mdd)}% / ${b.obj?.toFixed(1) ?? '—'} |`,
  )
}

async function seasonal() {
  log('# MODE=seasonal — 계절성 오버레이')
  log('')
  const { years, histories, bench } = await loadPitHistories()
  const benchMonthly = monthlyRatios(bench.filter((b) => b.date >= '2000-01-01'))
  const uniMonthly = Object.values(histories).map((bars) => monthlyRatios(bars.filter((b) => b.date >= '2000-01-01')))

  log('## 1) 기술통계 (보고용 — 전략 아님)')
  seasonalTable(`벤치 ${BENCH} 월별 수익`, [benchMonthly])
  seasonalTable('PIT 유니버스 종목 월별 수익 (종목×연 풀링)', uniMonthly)
  log('')
  log('※ 전·후반 값이 크게 다르면 그 계절성은 시대 안정성이 없다는 뜻이다 — 부호가 뒤집히는 달을')
  log('   전략으로 채택하면 안 된다.')

  log('')
  log('## 2) 전략 A/B — 승자 조건식 위 월 필터 오버레이')
  log(`조건식: **${WINNER_LABEL}** · 슬롯 ${MAX_POSITIONS} · 연도별 상위 10+10 [추정] 교체 유니버스`)
  const yearly = buildYearly(histories, years)
  log('')
  log(`연도별 매핑률: ${yearly.map((v) => `${v.y} ${v.mapped}`).join(' · ')}`)

  const overlays: Overlay[] = [OV_BASE, OV_S1, OV_S2, makeOvS3(benchMonthly)]
  const results = overlays.map((ov) => ({ ov, r: runOverlayChain(yearly, ov, COST) }))

  log('')
  log('| 전략 | 총수익 | CAGR | MDD | **수익÷MDD** | 매매 | 전반(2000~2013) 총/MDD/비 | 후반(2014~) 총/MDD/비 |')
  log('|---|---|---|---|---|---|---|---|')
  for (const { ov, r } of results) chainRow(ov.label, r)

  const base = results[0]
  log('')
  log(`base 총수익(청산비용 근사 미적용) = ${f1(base.r.totalNoHaircut)}% — 21차 pit1010 1위 수치와 대조용.`)
  log('(표의 base 총수익은 구간 끝 매도비용 [추정]을 뺀 값이라 21차보다 낮게 나오는 것이 정상이다.)')

  // S3가 실제로 어떤 달을 막았는지 — 필터가 해마다 흔들리면 그 자체가 불안정 신호다
  const s3 = overlays[3]
  log('')
  log('S3가 그 해 금지한 달 (확장 윈도우 판정):')
  log('| 연도 | 금지월 |')
  log('|---|---|')
  for (const y of years) {
    const b = [...s3.blockedMonths(y)].sort((a, z) => a - z)
    log(`| ${y} | ${b.length ? b.map((m) => `${m}월`).join(' ') : '(없음 — 표본 부족 또는 전월 양(+))'} |`)
  }

  log('')
  log('## 3) 연도별 수익 분해 (거짓 매끈함 방지)')
  log(`| 연도 | 매핑 | ${results.map((x) => x.ov.key).join(' | ')} | 벤치 |`)
  log(`|---|---|${results.map(() => '---').join('|')}|---|`)
  const benchRet = (y: number) => {
    const inYear = bench.filter((b) => b.date >= `${y}-01-01` && b.date <= `${y}-12-31`)
    return inYear.length >= 2 ? inYear[inYear.length - 1].c / inYear[0].c : 1
  }
  for (const [i, py] of base.r.perYear.entries()) {
    log(
      `| ${py.y} | ${py.mapped} | ${results.map((x) => f1((x.r.perYear[i].ret - 1) * 100) + '%').join(' | ')} | ${f1(
        (benchRet(py.y) - 1) * 100,
      )}% |`,
    )
  }

  log('')
  log('## 다중검정 경고')
  log('이 MODE는 월 필터 3종(S1·S2·S3)을 같은 데이터에 얹어 비교한다. 12개 달 중 "좋아 보이는" 달을')
  log('고르는 자유도까지 세면 실질 검정 횟수는 훨씬 크다. 귀무가설(계절성 없음)에서도 3종 중 하나가')
  log('base를 이길 확률은 상당히 높으므로, **전반·후반 두 구간 모두에서 base를 이긴 오버레이만**')
  log('패턴 후보로 읽는다. 한쪽만 이기면 우연으로 판정한다(21차 fullmar와 같은 판정 규칙).')
  disclaimer()
}

// ============================================================================
// MODE=monthpat — 종목×월 상승 패턴
// ============================================================================

export interface CellCriteria {
  minSample: number // 최소 표본 연수
  minHitRatio: number // 양(+)이었던 해 비율 하한
}
export const DEFAULT_CELLS: CellCriteria = { minSample: 8, minHitRatio: 0.65 }

export interface CellPick {
  symbol: string
  month: number
  n: number
  hits: number
  meanPct: number
}

/**
 * 그 해 1월 초 시점에 알 수 있는 정보만으로 (종목, 월) 셀을 고른다.
 * `year` 이후(같은 해 포함) 데이터는 절대 보지 않는다 — 확장 윈도우.
 */
export function selectMonthCells(
  monthlyBySymbol: Record<string, Map<string, number>>,
  year: number,
  crit: CellCriteria = DEFAULT_CELLS,
): CellPick[] {
  const out: CellPick[] = []
  for (const sym of Object.keys(monthlyBySymbol).sort()) {
    const mm = monthlyBySymbol[sym]
    for (let m = 1; m <= 12; m++) {
      const key = String(m).padStart(2, '0')
      const rets: number[] = []
      for (const [k, ratio] of mm) {
        if (k.slice(5, 7) !== key) continue
        if (Number(k.slice(0, 4)) >= year) continue
        rets.push(ratio - 1)
      }
      const n = rets.length
      if (n < crit.minSample) continue
      const hits = rets.filter((x) => x > 0).length
      const mean = rets.reduce((s, x) => s + x, 0) / n
      if (hits / n >= crit.minHitRatio && mean > 0) out.push({ symbol: sym, month: m, n, hits, meanPct: mean * 100 })
    }
  }
  return out
}

export interface MonthPatResult {
  equity: { date: string; equity: number }[]
  rebalances: number
  costPaid: number
}

/**
 * 셀에 걸린 (종목, 월)만 동일가중 보유하고 나머지는 현금.
 * 리밸런스는 각 월의 첫 거래일 **시가**에 한다. 그 달의 목표 집합은 그 해 1월 초에
 * 이미 확정돼 있으므로(확장 윈도우) 미래참조가 없다.
 */
export function simulateMonthPat(
  histories: Record<string, DailyBar[]>,
  cellsByYear: Map<number, CellPick[]>,
  cost: CostSettings,
  startDate: string,
): MonthPatResult {
  const calendar = calendarOf(histories).filter((d) => d >= startDate)
  const idx: Record<string, Map<string, number>> = {}
  for (const [s, bars] of Object.entries(histories)) {
    const m = new Map<string, number>()
    bars.forEach((b, i) => m.set(b.date, i))
    idx[s] = m
  }
  const buyPx = (p: number) => p * (1 + cost.slippagePct / 100)
  const sellPx = (p: number) => p * (1 - cost.slippagePct / 100)

  let cash = cost.initialCapital
  const holdings = new Map<string, number>() // symbol → qty
  const lastClose = new Map<string, number>()
  const equity: { date: string; equity: number }[] = []
  let rebalances = 0
  let costPaid = 0
  let curYm = ''

  for (const date of calendar) {
    const ym = ymOf(date)
    if (ym !== curYm) {
      curYm = ym
      // ---- 월 첫 거래일: 시가로 전량 청산 후 목표 집합 재편입 ----
      for (const [sym, qty] of holdings) {
        const bi = idx[sym].get(date)
        const px = bi != null ? histories[sym][bi].o : lastClose.get(sym)
        if (px == null) continue
        const gross = qty * sellPx(px)
        const fees = gross * ((cost.feePct + cost.taxPct) / 100)
        cash += gross - fees
        costPaid += fees + qty * px * (cost.slippagePct / 100)
        holdings.delete(sym)
      }
      const picks = (cellsByYear.get(yearOf(date)) ?? [])
        .filter((p) => p.month === monthOf(date))
        .map((p) => p.symbol)
        .filter((s) => idx[s]?.get(date) != null)
      if (picks.length > 0) {
        rebalances++
        const slot = cash / picks.length
        for (const sym of picks) {
          const bi = idx[sym].get(date)!
          const raw = histories[sym][bi].o
          const fill = buyPx(raw)
          const qty = Math.floor(slot / (fill * (1 + cost.feePct / 100)))
          if (qty <= 0) continue
          const gross = qty * fill
          const fee = gross * (cost.feePct / 100)
          cash -= gross + fee
          costPaid += fee + qty * raw * (cost.slippagePct / 100)
          holdings.set(sym, qty)
        }
      }
    }
    for (const sym of holdings.keys()) {
      const bi = idx[sym].get(date)
      if (bi != null) lastClose.set(sym, histories[sym][bi].c)
    }
    let mv = 0
    for (const [sym, qty] of holdings) mv += qty * (lastClose.get(sym) ?? 0)
    equity.push({ date, equity: cash + mv })
  }
  return { equity, rebalances, costPaid }
}

async function monthpat() {
  log('# MODE=monthpat — 종목별 월간 상승 패턴')
  log('')
  const { years, histories, bench } = await loadPitHistories()
  // 데이터 15년 이상 종목만
  const eligible: Record<string, DailyBar[]> = {}
  for (const [s, bars] of Object.entries(histories)) {
    if (bars.length < 2) continue
    const span = (Date.parse(bars[bars.length - 1].date) - Date.parse(bars[0].date)) / (365.25 * 86400e3)
    if (span >= 15) eligible[s] = bars
  }
  log(`대상: PIT 등장 종목 중 데이터 15년 이상 = ${Object.keys(eligible).length}개 / 로드 ${Object.keys(histories).length}개`)
  const monthlyBySymbol: Record<string, Map<string, number>> = {}
  for (const [s, bars] of Object.entries(eligible)) monthlyBySymbol[s] = monthlyRatios(bars)

  const cellsByYear = new Map<number, CellPick[]>()
  const meta: { y: number; cells: number; candidates: number; efp: number }[] = []
  for (const y of years) {
    const picks = selectMonthCells(monthlyBySymbol, y)
    cellsByYear.set(y, picks)
    // 기대 위양성: 그 해 판정 대상이 된 모든 (종목,월) 셀에 대해
    // 귀무(월수익 부호가 동전던지기)에서 "적중률 ≥65%"가 나올 확률의 합.
    let candidates = 0
    let efp = 0
    for (const s of Object.keys(monthlyBySymbol)) {
      for (let m = 1; m <= 12; m++) {
        const key = String(m).padStart(2, '0')
        let n = 0
        for (const k of monthlyBySymbol[s].keys())
          if (k.slice(5, 7) === key && Number(k.slice(0, 4)) < y) n++
        if (n < DEFAULT_CELLS.minSample) continue
        candidates++
        efp += binomTail(n, Math.ceil(DEFAULT_CELLS.minHitRatio * n), 0.5)
      }
    }
    meta.push({ y, cells: picks.length, candidates, efp })
  }

  const firstY = meta.find((m) => m.cells > 0)?.y ?? years[0]
  const sim = simulateMonthPat(eligible, cellsByYear, COST, `${firstY}-01-01`)
  const perf = perfOf(sim.equity)
  const perfA = perfOf(sim.equity, '', `${HALF_YEAR - 1}-12-31`)
  const perfB = perfOf(sim.equity, `${HALF_YEAR}-01-01`)

  // 벤치는 같은 구간 단순보유
  const benchEq = bench
    .filter((b) => b.date >= sim.equity[0]?.date)
    .map((b) => ({ date: b.date, equity: b.c }))
  const bPerf = perfOf(benchEq)
  const bA = perfOf(benchEq, '', `${HALF_YEAR - 1}-12-31`)
  const bB = perfOf(benchEq, `${HALF_YEAR}-01-01`)

  log('')
  log('## 성적 (셀 보유 전략 vs 벤치 단순보유)')
  log('| 전략 | 총수익 | CAGR | MDD | **수익÷MDD** | 리밸런스 | 누적비용 |')
  log('|---|---|---|---|---|---|---|')
  log(
    `| 월패턴 셀 보유 | ${f1(perf.total)}% | ${f1(perf.cagr)}% | ${f1(perf.mdd)}% | ${perf.obj?.toFixed(1) ?? '—'} | ${
      sim.rebalances
    } | ${Math.round(sim.costPaid).toLocaleString('ko-KR')}원 |`,
  )
  log(
    `| 벤치 ${BENCH} 단순보유 | ${f1(bPerf.total)}% | ${f1(bPerf.cagr)}% | ${f1(bPerf.mdd)}% | ${
      bPerf.obj?.toFixed(1) ?? '—'
    } | — | — |`,
  )
  log('')
  log('| 구간 | 전략 총수익 | 전략 MDD | 벤치 총수익 | 알파(CAGR) |')
  log('|---|---|---|---|---|')
  log(`| 전반 ~${HALF_YEAR - 1} | ${f1(perfA.total)}% | ${f1(perfA.mdd)}% | ${f1(bA.total)}% | ${f1(perfA.cagr - bA.cagr)}%p |`)
  log(`| 후반 ${HALF_YEAR}~ | ${f1(perfB.total)}% | ${f1(perfB.mdd)}% | ${f1(bB.total)}% | ${f1(perfB.cagr - bB.cagr)}%p |`)

  log('')
  log('## 선정 셀 수 추이 · 다중검정 규모')
  log('| 연도 | 판정 대상 셀 | 선정 셀 | **기대 위양성** | 선정÷기대 |')
  log('|---|---|---|---|---|')
  for (const m of meta)
    log(`| ${m.y} | ${m.candidates} | ${m.cells} | ${m.efp.toFixed(1)} | ${m.efp > 0 ? (m.cells / m.efp).toFixed(2) : '—'} |`)
  log('')
  log('**해석 규칙**: "기대 위양성"은 월수익 부호가 동전던지기(귀무가설)일 때도 "적중률 ≥65% & 표본 ≥8년"')
  log('조건을 통과했을 셀 수의 기댓값이다(이항 상측 꼬리 합). **선정÷기대 비율이 1에 가까우면 선정된 셀은**')
  log('**전부 우연으로 설명된다** — 그 해의 패턴은 없다고 읽어야 한다. 이 실험은 종목×12월이라 검정 횟수가')
  log('구조적으로 크고, 그래서 위양성이 크다. 비율이 2~3배 이상이고 전·후반 모두 알파가 양(+)일 때만')
  log('후보로 남긴다.')
  disclaimer({ segmentExit: false })
}

// ============================================================================
// MODE=pairprem — 삼성전자 / 삼성전자우 괴리 스위칭
// ============================================================================

export const SEC_COMMON = '005930.KS'
export const SEC_PREF = '005935.KS'

export interface PairBar {
  date: string
  oC: number
  cC: number
  oP: number
  cP: number
}

export function alignPair(common: DailyBar[], pref: DailyBar[]): PairBar[] {
  const p = new Map(pref.map((b) => [b.date, b]))
  const out: PairBar[] = []
  for (const b of common) {
    const q = p.get(b.date)
    if (!q) continue
    if (!(b.c > 0) || !(q.c > 0) || !(b.o > 0) || !(q.o > 0)) continue
    out.push({ date: b.date, oC: b.o, cC: b.c, oP: q.o, cP: q.c })
  }
  return out
}

/** 괴리율 d_t = 1 − 우선주가/보통주가 (총수익 보정 종가 기준) */
export const discountOf = (b: PairBar) => 1 - b.cP / b.cC

/**
 * 확장 윈도우 z-score. i 시점 값은 d[0..i]의 평균·표본표준편차만 쓴다.
 * 워밍업 미달이면 null(신호 없음). 전체 구간 통계 금지(규칙 1-5) 준수.
 */
export function expandingZ(d: number[], warmup: number): (number | null)[] {
  const out: (number | null)[] = []
  let sum = 0
  let sumSq = 0
  for (let i = 0; i < d.length; i++) {
    sum += d[i]
    sumSq += d[i] * d[i]
    const n = i + 1
    if (n < warmup) {
      out.push(null)
      continue
    }
    const mean = sum / n
    const varr = Math.max(0, (sumSq - n * mean * mean) / (n - 1))
    const sd = Math.sqrt(varr)
    out.push(sd > 1e-12 ? (d[i] - mean) / sd : null)
  }
  return out
}

export interface SwitchEvent {
  date: string
  from: 'common' | 'pref'
  to: 'common' | 'pref'
  price: number // 체결에 쓴 원 시가(비용 적용 전) — 신호 다음날 시가
  signalDate: string
}

export interface PairResult {
  equity: { date: string; equity: number }[]
  switches: SwitchEvent[]
  costPaid: number
}

/**
 * 롱온리 스위칭. 기본 보통주 100% 보유 → z > enterZ면 우선주로 전량 스위칭 →
 * z < exitZ면 보통주 복귀. 신호는 당일 **종가**로 판정하고 체결은 **다음 거래일 시가**
 * (규칙 1-2). 마지막 봉에서는 신호를 만들지 않는다(규칙 1-6).
 */
export function simulatePairSwitch(
  bars: PairBar[],
  z: (number | null)[],
  enterZ: number,
  exitZ: number,
  cost: CostSettings,
): PairResult {
  const buyPx = (p: number) => p * (1 + cost.slippagePct / 100)
  const sellPx = (p: number) => p * (1 - cost.slippagePct / 100)
  const equity: { date: string; equity: number }[] = []
  const switches: SwitchEvent[] = []
  let costPaid = 0
  if (bars.length === 0) return { equity, switches, costPaid }

  // 0일차 시가에 보통주 매수(비교군과 동일 조건)
  let side: 'common' | 'pref' = 'common'
  const fill0 = buyPx(bars[0].oC)
  let qty = cost.initialCapital / (fill0 * (1 + cost.feePct / 100))
  let cash = 0
  costPaid += qty * fill0 * (cost.feePct / 100) + qty * bars[0].oC * (cost.slippagePct / 100)
  let pending: 'common' | 'pref' | null = null
  let pendingSignalDate = ''

  for (let i = 0; i < bars.length; i++) {
    const b = bars[i]
    // 1) 전일 종가 신호 → 오늘 시가 체결
    if (pending && pending !== side) {
      const outRaw = side === 'common' ? b.oC : b.oP
      const inRaw = pending === 'common' ? b.oC : b.oP
      const gross = qty * sellPx(outRaw)
      const fees = gross * ((cost.feePct + cost.taxPct) / 100)
      cash = gross - fees
      costPaid += fees + qty * outRaw * (cost.slippagePct / 100)
      const fill = buyPx(inRaw)
      const newQty = cash / (fill * (1 + cost.feePct / 100))
      costPaid += newQty * fill * (cost.feePct / 100) + newQty * inRaw * (cost.slippagePct / 100)
      switches.push({ date: b.date, from: side, to: pending, price: inRaw, signalDate: pendingSignalDate })
      side = pending
      qty = newQty
      cash = 0
    }
    pending = null

    // 2) 오늘 종가로 마킹
    equity.push({ date: b.date, equity: cash + qty * (side === 'common' ? b.cC : b.cP) })

    // 3) 오늘 종가로 내일 신호 (마지막 봉이면 만들지 않는다)
    if (i === bars.length - 1) continue
    const zi = z[i]
    if (zi == null) continue
    if (side === 'common' && zi > enterZ) {
      pending = 'pref'
      pendingSignalDate = b.date
    } else if (side === 'pref' && zi < exitZ) {
      pending = 'common'
      pendingSignalDate = b.date
    }
  }
  return { equity, switches, costPaid }
}

/** 단순보유 비교군 — 0일차 시가 매수 후 종가 마킹 */
export function buyHold(bars: PairBar[], which: 'common' | 'pref', cost: CostSettings) {
  const raw = which === 'common' ? bars[0]?.oC : bars[0]?.oP
  if (raw == null) return [] as { date: string; equity: number }[]
  const fill = raw * (1 + cost.slippagePct / 100)
  const qty = cost.initialCapital / (fill * (1 + cost.feePct / 100))
  return bars.map((b) => ({ date: b.date, equity: qty * (which === 'common' ? b.cC : b.cP) }))
}

/** 50:50 연 1회 리밸런스 — 매년 첫 거래일 시가에 반반으로 맞춘다 */
export function halfHalfAnnual(bars: PairBar[], cost: CostSettings) {
  const buyPx = (p: number) => p * (1 + cost.slippagePct / 100)
  const sellPx = (p: number) => p * (1 - cost.slippagePct / 100)
  let qc = 0
  let qp = 0
  let curYear = -1
  const out: { date: string; equity: number }[] = []
  for (const b of bars) {
    const y = yearOf(b.date)
    if (y !== curYear) {
      curYear = y
      const gross = qc * sellPx(b.oC) + qp * sellPx(b.oP)
      const proceeds = qc + qp > 0 ? gross * (1 - (cost.feePct + cost.taxPct) / 100) : cost.initialCapital
      const half = proceeds / 2
      qc = half / (buyPx(b.oC) * (1 + cost.feePct / 100))
      qp = half / (buyPx(b.oP) * (1 + cost.feePct / 100))
    }
    out.push({ date: b.date, equity: qc * b.cC + qp * b.cP })
  }
  return out
}

/** ≈2년 워밍업 (국내 연 246거래일 기준) */
export const PAIR_WARMUP = 480

async function pairprem() {
  log('# MODE=pairprem — 삼성전자 / 삼성전자우 괴리 스위칭 (롱온리 · 공매도 없음)')
  log('')
  const common = await fetchDaily(SEC_COMMON, 'since:1999-01-01')
  await sleep(150)
  const pref = await fetchDaily(SEC_PREF, 'since:1999-01-01')
  const bars = alignPair(common, pref).filter((b) => b.date >= '2000-01-01')
  if (bars.length < PAIR_WARMUP + 50) {
    log(`❌ 정렬 봉 ${bars.length}개 — 워밍업(${PAIR_WARMUP})에 못 미쳐 중단`)
    return
  }
  log(`정렬 봉 ${bars.length}개 · ${bars[0].date} ~ ${bars[bars.length - 1].date}`)
  const d = bars.map(discountOf)
  const z = expandingZ(d, PAIR_WARMUP)
  const firstSignal = bars[z.findIndex((v) => v != null)]?.date ?? '—'
  log(`괴리율 d = 1 − 우선주/보통주 · 확장 윈도우 z(워밍업 ${PAIR_WARMUP}봉 ≈ 2년) · 첫 신호 가능일 ${firstSignal}`)
  log(`현재 괴리율 ${(d[d.length - 1] * 100).toFixed(1)}% · z ${z[z.length - 1]?.toFixed(2) ?? '—'} [관찰치이며 매수·매도 권유가 아니다]`)

  const rowOf = (label: string, eq: { date: string; equity: number }[], sw: number | null, cp: number | null) => {
    const p = perfOf(eq)
    const a = perfOf(eq, '', `${HALF_YEAR - 1}-12-31`)
    const b = perfOf(eq, `${HALF_YEAR}-01-01`)
    log(
      `| ${label} | ${f1(p.total)}% | ${f1(p.cagr)}% | ${f1(p.mdd)}% | ${p.obj?.toFixed(1) ?? '—'} | ${sw ?? '—'} | ${
        cp == null ? '—' : Math.round(cp).toLocaleString('ko-KR') + '원'
      } | ${f1(a.total)}% / ${f1(a.mdd)}% | ${f1(b.total)}% / ${f1(b.mdd)}% |`,
    )
  }

  log('')
  log('## 본 전략 (z > +1.5 → 우선주 / z < 0 → 보통주 복귀)')
  log('| 전략 | 총수익 | CAGR | MDD | **수익÷MDD** | 스위칭 | 누적비용 | 전반 총/MDD | 후반 총/MDD |')
  log('|---|---|---|---|---|---|---|---|---|')
  const main15 = simulatePairSwitch(bars, z, 1.5, 0, COST)
  rowOf('괴리 스위칭 z>1.5', main15.equity, main15.switches.length, main15.costPaid)
  rowOf('보통주 단순보유', buyHold(bars, 'common', COST), null, null)
  rowOf('우선주 단순보유', buyHold(bars, 'pref', COST), null, null)
  rowOf('50:50 연1회 리밸런스', halfHalfAnnual(bars, COST), null, null)

  log('')
  log('## 임계값 민감도 (복귀 임계 z<0 고정)')
  log('| 진입 z | 총수익 | CAGR | MDD | **수익÷MDD** | 스위칭 | 누적비용 | 전반 총/MDD | 후반 총/MDD |')
  log('|---|---|---|---|---|---|---|---|---|')
  for (const thr of [1.0, 1.5, 2.0]) {
    const r = simulatePairSwitch(bars, z, thr, 0, COST)
    rowOf(`z > +${thr.toFixed(1)}`, r.equity, r.switches.length, r.costPaid)
  }

  log('')
  log('## 스위칭 이력 (최근 20회)')
  log('| 신호일(종가 판정) | 체결일(익일 시가) | 방향 | 체결 기준가 |')
  log('|---|---|---|---|')
  for (const s of main15.switches.slice(-20))
    log(`| ${s.signalDate} | ${s.date} | ${s.from} → ${s.to} | ${Math.round(s.price).toLocaleString('ko-KR')} |`)

  log('')
  log('## 다중검정 경고')
  log('진입 임계값을 3개(1.0/1.5/2.0) 돌려 비교했다. 셋 중 최고를 골라 읽으면 그 자체가 곡선맞춤이다.')
  log('세 임계값 모두에서, 그리고 전·후반 모두에서 비교군(보통주 단순보유)을 이길 때만 패턴으로 읽는다.')
  log('한 임계값에서만 이기면 우연으로 판정한다.')
  log('')
  log('※ 구조적 한계: 우선주는 유동성이 낮아 실제 체결이 시가로 되지 않을 수 있고(슬리피지 과소평가),')
  log('   괴리율은 배당락·지배구조 이슈 등 회귀하지 않는 이유로도 벌어진다 — z 회귀 가정은 보장되지 않는다.')
  disclaimer({ universe: false, segmentExit: false })
}

// ============================================================================
// MODE=flow — 투자자 순매수(수급) 조건 A/B
// ============================================================================
//
// 데이터: public/data/flows/<code>.json (scripts/kiwoom-flow-backfill.mjs가 ka10059로
//         적재한 캐시). 이 모드는 **네트워크로 수급을 받지 않는다** — 캐시만 읽는다.
//
// ⚠️ T−1 원칙(규칙 1) — 이 모드의 존폐가 걸린 지점:
//   D일 종가에 매수를 판단한다. 그런데 D일의 투자자별 순매수는 **장 마감 후**에
//   확정된다. 따라서 D일 판단에 D일 수급을 쓰면 "오늘 결과를 보고 오늘 샀다"가 된다.
//   수급에 접근하는 경로를 `makeFlowLens(...).before(sym, date, k)` **하나로 좁히고**,
//   그 함수가 `dt < D`만 반환하도록 강제한다. 시뮬 루프는 이 렌즈 밖으로 수급을
//   읽지 않는다. 집행자는 tests/idealab.test.ts의 "D일 수급을 바꿔도 D일 판정 불변" 케이스.
//
// 결측 처리(보수적): 필요한 창(N일)이 캐시에 없으면 **필터를 통과하지 못한 것**으로
//   본다(유리한 쪽으로 가정하지 않는다 — 규칙 1-4의 정신). 랭킹 키를 못 구하면 최하위로
//   민다. 결측이 성적을 만든 게 아닌지 볼 수 있도록 결측 비율을 표에 함께 찍는다.

export const FLOW_START_YEAR = 2010 // 수급 이력 소급 한계(ka10059 실측)
export const FLOW_HALF_YEAR = 2018 // 전·후반 분할 — 2010 시작이라 중간점

export interface FlowRow {
  /** 'YYYYMMDD' */
  dt: string
  /** 개인 순매수 수량(단주, 부호 유지) */
  indNet: number
  /** 외국인 순매수 수량(단주, 부호 유지) */
  frgnNet: number
  /** 기관합 순매수 수량(단주, 부호 유지) */
  orgnNet: number
  /** 그 날 누적 거래대금(원, 무보정) */
  accTrdePrica: number
  /** 그 날 종가(원, 무보정) — 순매수 수량을 금액으로 바꿀 때만 쓴다 */
  curPrc: number
}

/** 종목 코드 → 날짜 오름차순 수급 행 */
export type FlowStore = Record<string, FlowRow[]>

/** 'YYYY-MM-DD' → 'YYYYMMDD' (이미 8자리면 그대로) */
export function toDt(date: string): string {
  return /^\d{8}$/.test(date) ? date : date.slice(0, 4) + date.slice(5, 7) + date.slice(8, 10)
}

export interface FlowLens {
  /**
   * 결정일 `date` **직전**까지 확정된 수급 행을 최대 k개, 과거→최근 순으로 반환한다.
   * `dt < date`만 본다 — 이것이 T−1 원칙의 유일한 집행 지점이다.
   */
  before(sym: string, date: string, k: number): FlowRow[]
  has(sym: string): boolean
}

export function makeFlowLens(store: FlowStore): FlowLens {
  const dtsOf: Record<string, string[]> = {}
  for (const [sym, rows] of Object.entries(store)) dtsOf[sym] = rows.map((r) => r.dt)
  return {
    has: (sym) => (store[sym]?.length ?? 0) > 0,
    before(sym, date, k) {
      const rows = store[sym]
      if (!rows?.length || k <= 0) return []
      const cut = toDt(date)
      // 이분 탐색: dt >= cut 인 첫 인덱스 → 쓸 수 있는 행은 [0, lo)
      const dts = dtsOf[sym]
      let lo = 0
      let hi = dts.length
      while (lo < hi) {
        const mid = (lo + hi) >> 1
        if (dts[mid] < cut) lo = mid + 1
        else hi = mid
      }
      return rows.slice(Math.max(0, lo - k), lo)
    },
  }
}

/** 수급 가설 한 개. admits=진입 자격 필터, rankKey=슬롯 초과 시 우선순위(내림차순). */
export interface FlowVariant {
  key: string
  label: string
  /** 진입 후보 자격. `null` = 수급 데이터 부족 → 보수적으로 불통과 처리된다. */
  admits?: (lens: FlowLens, sym: string, date: string) => boolean | null
  /** 랭킹 키(클수록 우선). `null` = 데이터 부족 → 최하위. 없으면 기본 거래대금 랭킹. */
  rankKey?: (lens: FlowLens, sym: string, date: string) => number | null
}

export const FLOW_BASE: FlowVariant = { key: 'base', label: `base ${WINNER_LABEL} · 거래대금 랭킹 (수급 조건 없음)` }

/** F1 — 직전 N영업일 외국인 순매수가 **연속 양(+)**인 종목만 진입 후보로 인정 */
export function flowF1(n: number): FlowVariant {
  return {
    key: `F1-${n}`,
    label: `F1 외국인 ${n}영업일 연속 순매수(+) 필터`,
    admits: (lens, sym, date) => {
      const w = lens.before(sym, date, n)
      if (w.length < n) return null // 창이 안 차면 판정 불가 → 보수적 탈락
      return w.every((r) => r.frgnNet > 0)
    },
  }
}

/**
 * F2 — 슬롯 초과 시 거래대금 대신 **수급강도** 순으로 고른다.
 * 강도 = Σ직전5영업일 (외국인+기관) 순매수량×그날 종가  ÷  Σ직전5영업일 거래대금.
 * 합계÷합계로 잡는다(일별 비율의 평균이 아니라) — 거래대금이 유난히 작은 하루가
 * 비율을 폭발시키는 것을 막기 위해서다. 분자·분모 모두 **무보정 원본**이라 배당·분할
 * 보정 계수가 종목마다 다르게 섞이지 않는다(그래서 백필러가 curPrc를 함께 저장한다).
 */
export const FLOW_F2: FlowVariant = {
  key: 'F2',
  label: 'F2 수급강도 랭킹 (직전 5영업일 외국인+기관 순매수대금 ÷ 거래대금)',
  rankKey: (lens, sym, date) => {
    const w = lens.before(sym, date, 5)
    if (w.length < 5) return null
    let net = 0
    let val = 0
    for (const r of w) {
      net += (r.frgnNet + r.orgnNet) * r.curPrc
      val += r.accTrdePrica
    }
    return val > 0 ? net / val : null
  },
}

/** F3 — 진입일 기준 **직전 영업일**에 외국인·기관이 모두 순매수(+)였던 종목만 */
export const FLOW_F3: FlowVariant = {
  key: 'F3',
  label: 'F3 직전 영업일 외국인·기관 동반 순매수(+) 필터',
  admits: (lens, sym, date) => {
    const w = lens.before(sym, date, 1)
    if (w.length < 1) return null
    return w[0].frgnNet > 0 && w[0].orgnNet > 0
  },
}

/**
 * 승자 조건식(MA10 상향돌파 × 20일 신고가) 진입 판정.
 * 엔진(evaluateEntry)이 쓰는 `sma`·`priorHigh` **같은 함수**를 부른다 — 지표를 다시
 * 구현하면 base 재현이 조용히 갈라진다. priorHigh는 당일을 제외한 직전 N일이다(규칙 1-3).
 */
export function flowEntryPassed(bars: DailyBar[], i: number): boolean {
  if (i < 1) return false
  const now = sma(bars, i, WINNER.ma)
  const prev = sma(bars, i - 1, WINNER.ma)
  if (now == null || prev == null) return false
  if (!(bars[i].c > now && bars[i - 1].c <= prev)) return false
  const h = priorHigh(bars, i, WINNER.hb)
  return h != null && bars[i].c > h
}

export interface FlowSimResult {
  equity: { date: string; equity: number }[]
  trades: number
  openAtEnd: number
  /** 수급 판정을 시도한 횟수(결측 비율의 분모) */
  evaluated: number
  /** 데이터 부족으로 진입 후보에서 보수적으로 탈락시킨 횟수 */
  missingAdmit: number
  /** 랭킹 키를 못 구해 최하위로 민 횟수 */
  missingRank: number
}

/**
 * 한 해치 bespoke 시뮬 — `runStrategySpec`의 승자 스펙 경로(진입 sameClose·청산
 * maBreak60 버퍼2%·거래대금 랭킹·equalSlot)를 그대로 옮긴 것이다. 엔진 코어를 고치지
 * 않고 수급 필터를 끼우기 위해 복제했으므로, **필터를 끄면 엔진과 완전히 같아야 한다**
 * (tests/idealab.test.ts가 자산곡선 전 점 일치를 강제한다 — 갈라지면 구현 버그).
 */
export function simulateFlowYear(
  histories: Record<string, DailyBar[]>,
  startDate: string,
  symbols: string[],
  cost: CostSettings,
  variant: FlowVariant,
  lens: FlowLens,
  maxPositions = MAX_POSITIONS,
): FlowSimResult {
  const universe = [...new Set(symbols)].filter((s) => histories[s]?.length).sort()
  const scoped: Record<string, DailyBar[]> = {}
  for (const s of universe) scoped[s] = histories[s]
  const calendar = calendarOf(scoped).filter((d) => d >= startDate)

  const idxOf: Record<string, Map<string, number>> = {}
  for (const s of universe) {
    const m = new Map<string, number>()
    histories[s].forEach((b, i) => m.set(b.date, i))
    idxOf[s] = m
  }

  const buyCost = (px: number) => px * (1 + cost.slippagePct / 100)
  const sellCost = (px: number) => px * (1 - cost.slippagePct / 100)

  interface Pos {
    entryPrice: number
    qty: number
    entryIdx: number
    peak: number
    lastClose: number
  }
  const positions = new Map<string, Pos>()
  let cash = cost.initialCapital
  const equity: { date: string; equity: number }[] = []
  let trades = 0
  let evaluated = 0
  let missingAdmit = 0
  let missingRank = 0

  for (let d = 0; d < calendar.length; d++) {
    const date = calendar[d]
    const isLast = d === calendar.length - 1

    // ---- 1) 청산 판정 — 전일 종가가 MA60×(1−2%) 아래면 오늘 시가 청산 -------
    for (const [sym, pos] of [...positions]) {
      const bi = idxOf[sym].get(date)
      if (bi == null) continue
      const bars = histories[sym]
      const bar = bars[bi]
      if (bar.h > pos.peak) pos.peak = bar.h
      if (d === pos.entryIdx) continue // 진입 당일은 평가하지 않는다(엔진과 동일)
      const pi = idxOf[sym].get(calendar[d - 1])
      if (pi == null) continue
      const ma = sma(bars, pi, WINNER.xm)
      if (ma == null) continue
      if (bars[pi].c < ma * (1 - WINNER.buf / 100)) {
        const fill = sellCost(bar.o)
        const gross = pos.qty * fill
        cash += gross - gross * (cost.feePct / 100) - gross * (cost.taxPct / 100)
        positions.delete(sym)
        trades++
      }
    }

    // ---- 2) 오늘 종가로 진입 (LOC · sameClose) -----------------------------
    // 마지막 봉에서도 sameClose는 체결 가능하지만, 엔진이 규칙 1-6으로 막고 있으므로
    // 동일하게 막는다(그래야 base가 재현된다).
    if (!isLast && positions.size < maxPositions) {
      const rows: { sym: string; bi: number; passed: boolean; key: number }[] = []
      for (const sym of universe) {
        const bi = idxOf[sym].get(date)
        if (bi == null) continue
        const bars = histories[sym]
        const b = bars[bi]
        let passed = flowEntryPassed(bars, bi)
        if (passed && variant.admits) {
          evaluated++
          const a = variant.admits(lens, sym, date)
          if (a == null) {
            missingAdmit++
            passed = false
          } else passed = a
        }
        let key = b.c * b.v
        if (variant.rankKey) {
          evaluated++
          const k = variant.rankKey(lens, sym, date)
          if (k == null) {
            missingRank++
            key = -Infinity
          } else key = k
        }
        rows.push({ sym, bi, passed, key })
      }
      // 엔진과 같은 비교자·같은 초기 순서(정렬된 심볼) — 동점은 심볼 오름차순으로 남는다
      const ranked = [...rows].sort((a, b) => (a.key === b.key ? 0 : (a.key - b.key) * -1))
      const picks = ranked.filter((r) => r.passed && !positions.has(r.sym)).slice(0, maxPositions - positions.size)
      for (const r of picks) {
        if (positions.size >= maxPositions) break
        const px = histories[r.sym][r.bi].c
        const slot = cash / Math.max(1, maxPositions - positions.size)
        const fill = buyCost(px)
        const qty = Math.floor(slot / (fill * (1 + cost.feePct / 100)))
        if (qty <= 0) continue
        const gross = qty * fill
        cash -= gross + gross * (cost.feePct / 100)
        positions.set(r.sym, { entryPrice: fill, qty, entryIdx: d, peak: px, lastClose: px })
      }
    }

    // ---- 3) 자산 평가 — 봉 없는 날은 마지막 관측 종가 이월 -------------------
    let holdings = 0
    for (const [sym, pos] of positions) {
      const bi = idxOf[sym].get(date)
      if (bi != null) pos.lastClose = histories[sym][bi].c
      holdings += pos.qty * pos.lastClose
    }
    equity.push({ date, equity: cash + holdings })
  }

  return { equity, trades, openAtEnd: positions.size, evaluated, missingAdmit, missingRank }
}

export interface FlowChainRes {
  equity: { date: string; equity: number }[]
  perYear: { y: number; ret: number; mapped: string }[]
  trades: number
  evaluated: number
  missingAdmit: number
  missingRank: number
}

/**
 * 연도별 유니버스 교체 연쇄 — `runOverlayChain(…, OV_BASE, …)`과 같은 이월·청산비용
 * 근사를 쓴다(그래야 base 대조가 성립한다). 매핑 5종목 미만인 해는 현금 보유.
 */
export function runFlowChain(
  yearly: YearSlice[],
  variant: FlowVariant,
  lens: FlowLens,
  cost: CostSettings,
  applyHaircut = true,
): FlowChainRes {
  let factor = 1
  const equity: { date: string; equity: number }[] = []
  const perYear: { y: number; ret: number; mapped: string }[] = []
  let trades = 0
  let evaluated = 0
  let missingAdmit = 0
  let missingRank = 0

  for (const v of yearly) {
    const yearStart = factor
    if (v.syms.length < 5) {
      perYear.push({ y: v.y, ret: 1, mapped: v.mapped })
      continue
    }
    const r = simulateFlowYear(v.hist, `${v.y}-01-01`, v.syms, cost, variant, lens)
    trades += r.trades
    evaluated += r.evaluated
    missingAdmit += r.missingAdmit
    missingRank += r.missingRank
    const base = factor
    for (const e of r.equity) equity.push({ date: e.date, equity: base * (e.equity / cost.initialCapital) })
    const finalEq = r.equity.length ? r.equity[r.equity.length - 1].equity : cost.initialCapital
    const segRet = finalEq / cost.initialCapital
    const frac = applyHaircut ? Math.min(1, Math.max(0, r.openAtEnd / Math.max(1, MAX_POSITIONS))) : 0
    const hc = frac * ((cost.feePct + cost.taxPct + cost.slippagePct) / 100)
    factor *= segRet * (1 - hc)
    perYear.push({ y: v.y, ret: factor / yearStart, mapped: v.mapped })
  }
  return { equity, perYear, trades, evaluated, missingAdmit, missingRank }
}

// ---- 캐시 로더 (네트워크 없음) ----------------------------------------------

export interface FlowCacheInfo {
  store: FlowStore
  files: number
  rows: number
  oldest: string
  newest: string
  incomplete: string[]
}

/** public/data/flows/*.json 을 읽어 FlowStore로. 파일이 없으면 빈 스토어. */
export function loadFlowCache(dir: string): FlowCacheInfo {
  const store: FlowStore = {}
  const incomplete: string[] = []
  let rows = 0
  let oldest = ''
  let newest = ''
  let names: string[] = []
  try {
    names = readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'index.json')
  } catch {
    return { store, files: 0, rows: 0, oldest: '', newest: '', incomplete }
  }
  for (const n of names.sort()) {
    let j: { code?: string; rows?: FlowRow[]; meta?: { complete?: boolean } }
    try {
      j = JSON.parse(readFileSync(join(dir, n), 'utf8'))
    } catch {
      continue
    }
    const code = String(j.code ?? n.replace(/\.json$/, ''))
    const rs = (j.rows ?? []).filter((r) => r && typeof r.dt === 'string')
    if (!rs.length) continue
    // 저장 시 오름차순이지만 방어적으로 다시 정렬한다(정렬 가정이 렌즈의 이분 탐색 전제)
    rs.sort((a, b) => (a.dt < b.dt ? -1 : a.dt > b.dt ? 1 : 0))
    store[code] = rs
    rows += rs.length
    if (!oldest || rs[0].dt < oldest) oldest = rs[0].dt
    if (!newest || rs[rs.length - 1].dt > newest) newest = rs[rs.length - 1].dt
    if (j.meta?.complete === false) incomplete.push(code)
  }
  return { store, files: Object.keys(store).length, rows, oldest, newest, incomplete }
}

async function flow() {
  log('# MODE=flow — 투자자 순매수(수급) 조건 A/B')
  log('')
  const dir = join(process.env.REPO_ROOT ?? process.cwd(), 'public', 'data', 'flows')
  const cache = loadFlowCache(dir)
  if (cache.files === 0) {
    log(`❌ 수급 캐시가 비어 있다 (${dir})`)
    log('   먼저 EC2/러너에서 `node scripts/kiwoom-flow-backfill.mjs`를 돌려 ka10059 이력을 적재한다.')
    log('   (컨테이너는 키움 접속이 막혀 있어 여기서 받을 수 없다.)')
    return
  }
  log(
    `수급 캐시: ${cache.files}종목 · ${cache.rows.toLocaleString('ko-KR')}행 · ${cache.oldest} ~ ${cache.newest}` +
      (cache.incomplete.length ? ` · ⚠️ 소급 미완 ${cache.incomplete.length}종목(재실행 필요)` : ''),
  )
  const lens = makeFlowLens(cache.store)

  // 지표 워밍업(MA60)을 위해 시작 2년 전부터 시세를 받는다
  const { years, histories } = await loadPitHistories(`since:${FLOW_START_YEAR - 2}-01-01`)
  const flowYears = years.filter((y) => y >= FLOW_START_YEAR)
  const yearly = buildYearly(histories, flowYears).filter((v) => v.syms.length > 0)
  if (yearly.length === 0) {
    log('❌ 시세 로드 실패로 실행할 해가 없다 — 중단')
    return
  }
  log(`실행 구간: ${flowYears[0]}~${flowYears[flowYears.length - 1]} · 전·후반 경계 ${FLOW_HALF_YEAR}`)
  const covered = yearly.reduce((n, v) => n + v.syms.filter((s) => lens.has(s)).length, 0)
  const totalSyms = yearly.reduce((n, v) => n + v.syms.length, 0)
  log(`수급 캐시 매칭: 연도별 유니버스 ${totalSyms}칸 중 ${covered}칸(${((covered / Math.max(1, totalSyms)) * 100).toFixed(0)}%)에 수급 파일이 있다`)

  // ---- 자기검증: bespoke base ≡ 엔진 base -----------------------------------
  const engineBase = runOverlayChain(yearly, OV_BASE, COST)
  const flowBase = runFlowChain(yearly, FLOW_BASE, lens, COST)
  let maxDiff = 0
  const sameLen = engineBase.equity.length === flowBase.equity.length
  if (sameLen)
    for (let i = 0; i < engineBase.equity.length; i++) {
      const a = engineBase.equity[i].equity
      const b = flowBase.equity[i].equity
      maxDiff = Math.max(maxDiff, Math.abs(a - b) / Math.max(1e-12, Math.abs(a)))
    }
  const baseOk = sameLen && maxDiff < 1e-9 && engineBase.trades === flowBase.trades
  log('')
  log('## 자기검증 — bespoke 루프가 엔진 base를 재현하는가')
  log(
    baseOk
      ? `✅ 일치 — 자산곡선 ${engineBase.equity.length}점 전부 동일(상대오차 ${maxDiff.toExponential(1)}), 매매수 ${engineBase.trades}건 동일.`
      : `❌ 불일치 — 구현 버그다. 곡선 길이 ${engineBase.equity.length} vs ${flowBase.equity.length} · 최대 상대오차 ${maxDiff.toExponential(1)} · 매매수 ${engineBase.trades} vs ${flowBase.trades}`,
  )
  if (!baseOk) {
    log('아래 A/B 수치는 base가 갈라진 상태이므로 **읽지 않는다.** 먼저 simulateFlowYear를 고친다.')
    return
  }
  log('※ 22차 수치와의 대조는 같은 구간(2000~)에서만 성립한다 — 이 표는 수급 캐시가 있는')
  log(`   ${FLOW_START_YEAR}년 이후만 돌리므로 22차 총수익과 직접 같지 않다. 아래 참고 행으로 전 구간 base를 함께 찍는다.`)
  const fullBase = runOverlayChain(buildYearly(histories, years), OV_BASE, COST)
  const fp = perfOf(fullBase.equity)
  log(`참고(22차 대조용) 엔진 base 전 구간 ${years[0]}~${years[years.length - 1]}: 총 ${f1(fp.total)}% · CAGR ${f1(fp.cagr)}% · MDD ${f1(fp.mdd)}% · 매매 ${fullBase.trades}건`)

  // ---- A/B -----------------------------------------------------------------
  const variants: FlowVariant[] = [FLOW_BASE, flowF1(3), flowF1(5), FLOW_F2, FLOW_F3]
  log('')
  log('## 수급 가설 A/B')
  log('| 전략 | 총수익 | CAGR | MDD | **수익÷MDD** | 매매 | 결측률 | 전반(~2017) 총/MDD/수익÷MDD | 후반(2018~) 총/MDD/수익÷MDD |')
  log('|---|---|---|---|---|---|---|---|---|')
  const results: { v: FlowVariant; r: FlowChainRes; full: Perf; a: Perf; b: Perf }[] = []
  for (const v of variants) {
    const r = v.key === FLOW_BASE.key ? flowBase : runFlowChain(yearly, v, lens, COST)
    const full = perfOf(r.equity)
    const a = perfOf(r.equity, '', `${FLOW_HALF_YEAR - 1}-12-31`)
    const b = perfOf(r.equity, `${FLOW_HALF_YEAR}-01-01`)
    results.push({ v, r, full, a, b })
    const miss = r.missingAdmit + r.missingRank
    const missPct = r.evaluated > 0 ? `${((miss / r.evaluated) * 100).toFixed(1)}% (${miss}/${r.evaluated})` : '—'
    log(
      `| ${v.label} | ${f1(full.total)}% | ${f1(full.cagr)}% | ${f1(full.mdd)}% | ${full.obj?.toFixed(1) ?? '—'} | ${r.trades} | ${missPct} | ` +
        `${f1(a.total)}% / ${f1(a.mdd)}% / ${a.obj?.toFixed(1) ?? '—'} | ${f1(b.total)}% / ${f1(b.mdd)}% / ${b.obj?.toFixed(1) ?? '—'} |`,
    )
  }

  // ---- 판정 ----------------------------------------------------------------
  const baseRow = results[0]
  log('')
  log('## 판정 (base 대비 · 규칙 5 — 절대 수익이 아니라 base 초과분으로 본다)')
  log('| 가설 | 전 구간 초과 | 전반 초과 | 후반 초과 | 두 구간 모두 개선? |')
  log('|---|---|---|---|---|')
  let winners = 0
  for (const x of results.slice(1)) {
    const dFull = x.full.total - baseRow.full.total
    const dA = x.a.total - baseRow.a.total
    const dB = x.b.total - baseRow.b.total
    const both = dA > 0 && dB > 0
    if (both) winners++
    log(`| ${x.v.key} | ${f1(dFull)}%p | ${f1(dA)}%p | ${f1(dB)}%p | ${both ? '✅' : '❌'} |`)
  }

  log('')
  log('## 다중검정 경고')
  const n = results.length - 1
  log(`수급 가설을 ${n}개(F1 N=3·N=5, F2, F3) 돌려 base와 비교했다. 이 중 ${winners}개가 전·후반 모두에서 base를 이겼다.`)
  log(
    `순수 우연이라면 한 가설이 두 구간 모두 이길 확률은 ≈25%이고, ${n}개 중 ${winners}개 이상이 그럴 확률은 ` +
      `약 ${(binomTail(n, winners, 0.25) * 100).toFixed(0)}%다 — 이 값이 크면 "찾아낸 패턴"이 아니라 표본 잡음이다.`,
  )
  log('가설 하나만 이겼다면 그것을 골라 읽는 순간 곡선맞춤이다. 채택 기준은 ① 전·후반 모두 개선 ②')
  log('결측률이 낮을 것(결측이 만든 성적이 아닐 것) ③ 매매수가 base 대비 극단적으로 줄지 않을 것(표본 소실)이다.')

  log('')
  log('## T−1 처리 · 결측 처리')
  log('· D일 종가 진입 판단에 쓴 수급은 **dt < D**로 확정된 것뿐이다(makeFlowLens.before). D일 수급은 장 마감')
  log('  후 확정이라 그날 판단에 넣으면 미래참조가 된다 — 렌즈 밖에서 수급을 읽는 경로는 시뮬에 없다.')
  log('· 필요한 창(N영업일)이 캐시에 없으면 **불통과**로 처리했다(유리한 쪽 가정 금지). 위 표의 결측률이')
  log('  높은 가설은 "필터가 좋아서"가 아니라 "데이터가 없어서" 매매가 줄었을 수 있으니 그렇게 읽는다.')
  log(`· 수급 캐시 소급 시작 ${cache.oldest} — 그 이전 구간은 이 실험에 포함하지 않았다.`)

  log('')
  log('⚠️ [미검증-실데이터] 이 러너는 컨테이너에서 Yahoo(403)·키움(키 없음) 접속이 막혀 있어')
  log('   합성 데이터 테스트로만 검증됐다. 위 수치는 EC2/러너 실행 결과로 채워야 한다.')
  disclaimer({ universe: true, segmentExit: true })
}

// ============================================================================
// 비(非)이평 전략군 — 공용 기반 (MODE=xsmom · volbrk · rsirev)
// ============================================================================
//
// 2026-08-02 대표 지시: "백테스트 MA 이평선 기반 말고 다른 접근은 없냐? 수익률이 좀 낮은데."
//
// 판정 기준선 = 현행 최고 조합 **MA25×신고10→80선**(23차 400조합 격자 수익÷MDD 1위).
// 기준선 수치를 다른 보고서에서 옮겨 적지 않고 **같은 PIT 유니버스·같은 비용·같은
// 연도 연쇄로 여기서 다시 돌린다** — 유니버스·구간·비용이 다르면 비교가 성립하지 않는다.
//
// ── 규칙 1(미래참조 금지) 준수 ─────────────────────────────────────────────
//   · xsmom : 리밸런스일 D의 랭킹은 `date < 전월 1일` 종가까지만 본다(12-1 모멘텀은
//             최근 1개월을 통째로 버리므로 D 근처 데이터가 아예 안 들어간다).
//             체결은 **월 첫 거래일 시가**.
//   · volbrk: 돌파가 = 당일 시가 + k×(**전일** 고가−저가). 전일 봉과 당일 시가는 주문
//             시점에 이미 확정된 값이다. 당일 고가는 "체결 여부 판정"에만 쓰고,
//             체결가는 `breakoutFill`이 **max(시가, 돌파가)** 로 불리한 쪽을 잡는다(규칙 1-4).
//             랭킹 키는 **전일** 거래대금이다 — 당일 거래대금은 장중에 확정되지 않는다.
//   · rsirev: RSI(2)·MA200 모두 당일 종가까지만 쓰는 재귀·롤링 계산. 신호는 D 종가,
//             체결은 **D+1 시가**. 마지막 봉에서는 신규 신호를 만들지 않는다(규칙 1-6).
//   · 집행자는 `tests/idealab.test.ts`의 절단 불변성 케이스다.
//
// ⚠️ 메모리: 변형별 자산곡선은 요약 즉시 버리고 **스칼라만** 남긴다(2026-08-02 pit1010
//    400조합 OOM 재발 방지). 표에 남는 것은 Perf 스칼라·연도별 배수뿐이다.

/** 23차 격자 수익÷MDD 1위 — 현행 최고 조합(총 +5,442% · CAGR 16.3% · 알파 +7.9%p/연). */
export const BASE25 = { ma: 25, hb: 10, xm: 80, buf: 0 } as const
export const BASELINE_LABEL = `기준선 MA${BASE25.ma}×신고${BASE25.hb}→${BASE25.xm}선`

/** 기준선 스펙 — src/features/backtest/SpecSimulator.tsx의 PRESET_PIT_MAXRATIO와 같은 파라미터. */
export function baselineSpec(symbols: string[]): StrategySpec {
  return {
    version: SPEC_VERSION,
    id: 'idea-lab-baseline-ma25',
    name: BASELINE_LABEL,
    source: '23차 400조합 격자 수익÷MDD 1위',
    universe: {
      markets: ['KOSPI', 'KOSDAQ'],
      excludeAdministrative: true,
      excludeSuspended: true,
      excludeLiquidation: true,
      excludePreferred: true,
      excludeEtf: true,
      symbols,
    },
    entry: {
      op: 'and',
      nodes: [
        c(`${BASE25.ma}일선돌파`, { kind: 'maCross', period: BASE25.ma, dir: 'above' }),
        c(`${BASE25.hb}일신고가`, { kind: 'highBreak', days: BASE25.hb }),
      ],
    },
    ranking: { by: 'tradingValue', dir: 'desc' },
    exits: [{ kind: 'maBreak', maPeriod: BASE25.xm, pct: BASE25.buf }],
    sizing: { maxPositions: MAX_POSITIONS, mode: 'equalSlot' },
    execution: { timing: 'sameClose', orderType: 'market' },
    regime: null,
  }
}

// ---- 장부(Book) — 세 전략이 공유하는 체결·손익 원장 ---------------------------

export interface BookPos {
  qty: number
  /** 취득 총원가(체결가×수량 + 매수수수료). 부분매도 시 비례 차감. */
  basis: number
  /** 부분매도까지 포함한 실현손익 누계 — 전량 청산 시 이 부호로 승패를 가른다. */
  realized: number
  /** 진입 체결일의 캘린더 인덱스(보유일수 계산용) */
  entryIdx: number
  /** 봉이 없는 날 평가에 쓰는 마지막 관측 종가 */
  lastClose: number
}

export interface Book {
  cash: number
  positions: Map<string, BookPos>
  /** 전량 청산으로 완결된 라운드트립 수 */
  closed: number
  /** 그중 실현손익 > 0 */
  wins: number
}

export const newBook = (cash: number): Book => ({ cash, positions: new Map(), closed: 0, wins: 0 })

/**
 * 매수. `rawPx`는 슬리피지 **적용 전** 기준가(시가·종가·돌파가)이며 여기서 불리한 쪽으로
 * 슬리피지를 얹는다. 예산·현금 한도 안에서 정수 주만 산다. 실제 매수 수량을 돌려준다.
 */
export function bookBuy(
  book: Book,
  cost: CostSettings,
  sym: string,
  rawPx: number,
  budget: number,
  idx: number,
): number {
  if (!(rawPx > 0) || !(budget > 0)) return 0
  const fill = rawPx * (1 + cost.slippagePct / 100)
  const qty = Math.floor(Math.min(budget, book.cash) / (fill * (1 + cost.feePct / 100)))
  if (qty <= 0) return 0
  const gross = qty * fill
  const fee = gross * (cost.feePct / 100)
  book.cash -= gross + fee
  const p = book.positions.get(sym)
  if (p) {
    p.qty += qty
    p.basis += gross + fee
  } else {
    book.positions.set(sym, { qty, basis: gross + fee, realized: 0, entryIdx: idx, lastClose: rawPx })
  }
  return qty
}

/** 매도(부분 가능). 전량이 나가면 라운드트립 1건으로 세고 실현손익 부호로 승패를 가른다. */
export function bookSell(book: Book, cost: CostSettings, sym: string, rawPx: number, qty: number): number {
  const p = book.positions.get(sym)
  if (!p || !(qty > 0) || !(rawPx > 0)) return 0
  const q = Math.min(qty, p.qty)
  const fill = rawPx * (1 - cost.slippagePct / 100)
  const gross = q * fill
  const net = gross - gross * ((cost.feePct + cost.taxPct) / 100)
  book.cash += net
  const portion = q / p.qty
  const basisOut = p.basis * portion
  p.realized += net - basisOut
  p.basis -= basisOut
  p.qty -= q
  if (p.qty <= 0) {
    book.closed++
    if (p.realized > 0) book.wins++
    book.positions.delete(sym)
  }
  return q
}

/** 종가 마킹 — 봉 없는 날은 마지막 관측 종가를 이월한다. 총자산(현금+평가)을 돌려준다. */
export function bookMark(book: Book, priceOf: (sym: string) => number | null): number {
  let mv = 0
  for (const [sym, p] of book.positions) {
    const px = priceOf(sym)
    if (px != null && px > 0) p.lastClose = px
    mv += p.qty * p.lastClose
  }
  return book.cash + mv
}

// ---- 한 해치 시뮬 공용 컨텍스트 ----------------------------------------------

export interface SimCtx {
  universe: string[]
  calendar: string[]
  idxOf: Record<string, Map<string, number>>
}

export function makeSimCtx(
  histories: Record<string, DailyBar[]>,
  symbols: string[],
  startDate: string,
): SimCtx {
  const universe = [...new Set(symbols)].filter((s) => histories[s]?.length).sort()
  const scoped: Record<string, DailyBar[]> = {}
  for (const s of universe) scoped[s] = histories[s]
  const calendar = calendarOf(scoped).filter((d) => d >= startDate)
  const idxOf: Record<string, Map<string, number>> = {}
  for (const s of universe) {
    const m = new Map<string, number>()
    histories[s].forEach((b, i) => m.set(b.date, i))
    idxOf[s] = m
  }
  return { universe, calendar, idxOf }
}

/**
 * 체결 1건. **테스트가 규칙 1을 집행하는 지점**이다 — "신호일 종가로 판단해 체결일 시가에
 * 샀다"를 검증하려면 체결일·신호일·체결 기준가가 다 남아 있어야 한다.
 * 연쇄(runCustomChain)는 이 배열을 누적하지 않는다(해마다 버린다 — 메모리).
 */
export interface FillEvent {
  date: string
  sym: string
  side: 'buy' | 'sell'
  /** 슬리피지 적용 **전** 기준가 — 시가·종가·돌파가 중 무엇을 썼는지 그대로 남긴다 */
  px: number
  qty: number
  /** 이 체결을 만든 판단이 이뤄진 날(종가 기준). 당일 판단·당일 체결이면 date와 같다. */
  signalDate: string
}

export interface CustomYearRun {
  equity: { date: string; equity: number }[]
  closed: number
  wins: number
  openAtEnd: number
  fills: FillEvent[]
}

export interface ChainStats {
  equity: { date: string; equity: number }[]
  perYear: { y: number; ret: number; mapped: string }[]
  closed: number
  wins: number
}

/**
 * 연도별 유니버스 교체 연쇄 — `runOverlayChain`/`runFlowChain`과 **같은** 이월·구간끝
 * 청산비용 근사를 쓴다(그래야 기준선 대조가 성립한다). 매핑 5종목 미만인 해는 현금.
 * 각 해는 독립 시뮬이라 12/31에 사실상 전량 정산되는 셈이며, 그 비용이 haircut이다.
 */
export function runCustomChain(
  yearly: YearSlice[],
  runYear: (v: YearSlice) => CustomYearRun,
  cost: CostSettings,
  slots: number,
  applyHaircut = true,
): ChainStats {
  let factor = 1
  const equity: { date: string; equity: number }[] = []
  const perYear: { y: number; ret: number; mapped: string }[] = []
  let closed = 0
  let wins = 0

  for (const v of yearly) {
    const yearStart = factor
    if (v.syms.length < 5) {
      perYear.push({ y: v.y, ret: 1, mapped: v.mapped })
      continue
    }
    const r = runYear(v)
    closed += r.closed
    wins += r.wins
    const base = factor
    for (const e of r.equity) equity.push({ date: e.date, equity: base * (e.equity / cost.initialCapital) })
    const finalEq = r.equity.length ? r.equity[r.equity.length - 1].equity : cost.initialCapital
    const segRet = finalEq / cost.initialCapital
    const frac = applyHaircut ? Math.min(1, Math.max(0, r.openAtEnd / Math.max(1, slots))) : 0
    factor *= segRet * (1 - frac * ((cost.feePct + cost.taxPct + cost.slippagePct) / 100))
    perYear.push({ y: v.y, ret: factor / yearStart, mapped: v.mapped })
  }
  return { equity, perYear, closed, wins }
}

/** 정본 엔진(runStrategySpec) 경로를 같은 연쇄에 태운다 — 기준선 재실행용. */
export function runSpecChain(
  yearly: YearSlice[],
  makeSpec: (syms: string[]) => StrategySpec,
  cost: CostSettings,
  applyHaircut = true,
): ChainStats {
  return runCustomChain(
    yearly,
    (v) => {
      const r = runStrategySpec(v.hist, `${v.y}-01-01`, makeSpec(v.syms), cost)
      const done = r.trades.filter((t) => t.exitDate != null)
      return {
        equity: r.equity.map((e) => ({ date: e.date, equity: e.equity })),
        closed: done.length,
        wins: done.filter((t) => (t.pnl ?? 0) > 0).length,
        openAtEnd: r.openAtEnd,
        fills: [],
      }
    },
    cost,
    MAX_POSITIONS,
    applyHaircut,
  )
}

// ---- 요약(스칼라만) · 알파 · 표 ----------------------------------------------

export interface StratRow {
  label: string
  full: Perf
  a: Perf
  b: Perf
  closed: number
  wins: number
  /** 벤치 대비 연환산 초과수익(%p). 벤치 구간이 없으면 null. */
  alphaFull: number | null
  alphaA: number | null
  alphaB: number | null
  perYear: { y: number; ret: number }[]
}

/**
 * 알파는 **두 곡선이 겹치는 구간**에서만 계산한다. 벤치(KODEX 200)는 2002년 상장이라
 * 2000~2001 구간에는 존재하지 않는데, 그 구간을 전략에만 유리하게 넣으면 알파가 부풀려진다.
 */
export function alphaOf(
  strat: { date: string; equity: number }[],
  bench: { date: string; equity: number }[],
  from: string,
  to: string,
): { s: Perf; b: Perf | null; alpha: number | null; from: string; to: string } {
  const bWin = bench.filter((e) => e.date >= from && e.date <= to)
  const sWin = strat.filter((e) => e.date >= from && e.date <= to)
  if (bWin.length < 2 || sWin.length < 2) return { s: perfOf(strat, from, to), b: null, alpha: null, from, to }
  const lo = bWin[0].date > sWin[0].date ? bWin[0].date : sWin[0].date
  const hi = bWin[bWin.length - 1].date < sWin[sWin.length - 1].date ? bWin[bWin.length - 1].date : sWin[sWin.length - 1].date
  const s = perfOf(strat, lo, hi)
  const b = perfOf(bench, lo, hi)
  if (s.years < 0.5 || b.years < 0.5) return { s, b, alpha: null, from: lo, to: hi }
  return { s, b, alpha: s.cagr - b.cagr, from: lo, to: hi }
}

/** 자산곡선을 스칼라로 접는다. 호출 뒤 곡선 배열은 버려도 된다(메모리). */
export function summarizeStrat(
  label: string,
  chain: ChainStats,
  benchEq: { date: string; equity: number }[],
  halfYear = HALF_YEAR,
): StratRow {
  return {
    label,
    full: perfOf(chain.equity),
    a: perfOf(chain.equity, '', `${halfYear - 1}-12-31`),
    b: perfOf(chain.equity, `${halfYear}-01-01`),
    closed: chain.closed,
    wins: chain.wins,
    alphaFull: alphaOf(chain.equity, benchEq, '', '9999-12-31').alpha,
    alphaA: alphaOf(chain.equity, benchEq, '', `${halfYear - 1}-12-31`).alpha,
    alphaB: alphaOf(chain.equity, benchEq, `${halfYear}-01-01`, '9999-12-31').alpha,
    perYear: chain.perYear.map((p) => ({ y: p.y, ret: p.ret })),
  }
}

const pctOrDash = (v: number | null) => (v == null ? '—' : `${f1(v)}%p`)

export function stratTable(rows: StratRow[], halfYear = HALF_YEAR) {
  log(
    `| 전략 | 총수익 | CAGR | MDD | **수익÷MDD** | 매매(청산완료) | 승률 | 알파(CAGR) | ` +
      `전반(~${halfYear - 1}) 총/MDD/알파 | 후반(${halfYear}~) 총/MDD/알파 |`,
  )
  log('|---|---|---|---|---|---|---|---|---|---|')
  for (const r of rows) {
    const wr = r.closed > 0 ? `${((r.wins / r.closed) * 100).toFixed(0)}%` : '—'
    log(
      `| ${r.label} | ${f1(r.full.total)}% | ${f1(r.full.cagr)}% | ${f1(r.full.mdd)}% | ` +
        `${r.full.obj?.toFixed(1) ?? '—'} | ${r.closed} | ${wr} | ${pctOrDash(r.alphaFull)} | ` +
        `${f1(r.a.total)}% / ${f1(r.a.mdd)}% / ${pctOrDash(r.alphaA)} | ` +
        `${f1(r.b.total)}% / ${f1(r.b.mdd)}% / ${pctOrDash(r.alphaB)} |`,
    )
  }
  // 전멸한 줄이 서로 똑같아 보이는 것을 "같은 전략"으로 오독하지 않게 못 박는다
  if (rows.some((r) => r.full.total <= -99.9))
    log(
      '※ 총수익 −100%인 줄은 **자본을 다 잃었다**는 뜻이다. 그런 줄끼리는 수치가 같아 보여도 같은 전략이 아니다 ' +
        '(자산곡선이 0에 붙으면 지표가 하한에서 뭉친다). 비교는 살아남은 줄끼리만 의미가 있다.',
    )
}

/**
 * 기준선 대조행 — 23차 격자 보고(+5,442% · CAGR 16.3%)는 구간끝 청산비용 근사가 없는
 * 수치다. 표의 기준선이 그보다 낮게 나오는 것이 정상이라는 걸 매번 보여준다
 * (안 보여주면 다음 세션이 "기준선이 깨졌다"고 오진한다).
 */
function baselineCrossCheck(yearly: YearSlice[]) {
  const p = perfOf(runSpecChain(yearly, baselineSpec, COST, false).equity)
  log('')
  log(
    `기준선 대조: 구간끝 청산비용 근사를 빼면 총 ${f1(p.total)}% · CAGR ${f1(p.cagr)}% · MDD ${f1(p.mdd)}% — ` +
      '23차 격자 보고(+5,442% · CAGR 16.3% · MDD −31.9%)와 맞춰 볼 값이다.',
  )
  log('(표의 기준선은 매년 말 정산비용 [추정]을 뺀 값이라 23차 수치보다 낮게 나오는 것이 정상이다.)')
}

/** rows[0]이 기준선이라는 전제. 전·후반 모두 기준선을 이긴 변형 수를 돌려준다. */
export function verdictTable(rows: StratRow[]): number {
  const base = rows[0]
  log('')
  log('## 판정 (기준선 대비 · 규칙 5 — 절대 수익이 아니라 초과분으로 본다)')
  log('| 전략 | 전 구간 초과 | 전반 초과 | 후반 초과 | 전·후반 모두 개선? |')
  log('|---|---|---|---|---|')
  let winners = 0
  for (const r of rows.slice(1)) {
    const dA = r.a.total - base.a.total
    const dB = r.b.total - base.b.total
    const both = dA > 0 && dB > 0
    if (both) winners++
    log(`| ${r.label} | ${f1(r.full.total - base.full.total)}%p | ${f1(dA)}%p | ${f1(dB)}%p | ${both ? '✅' : '❌'} |`)
  }
  return winners
}

/** `title`은 한 모드가 계열별로 표를 나눠 찍을 때만 바꾼다(기본값 = 기존 모드 출력 그대로). */
export function perYearTable(rows: StratRow[], title = '연도별 수익 분해 (거짓 매끈함 방지)') {
  log('')
  log(`## ${title}`)
  log(`| 연도 | ${rows.map((r) => r.label).join(' | ')} |`)
  log(`|---|${rows.map(() => '---').join('|')}|`)
  const years = rows[0].perYear.map((p) => p.y)
  for (const [i, y] of years.entries())
    log(`| ${y} | ${rows.map((r) => `${f1(((r.perYear[i]?.ret ?? 1) - 1) * 100)}%`).join(' | ')} |`)
}

function multipleTestingNote(n: number, winners: number) {
  log('')
  log('## 다중검정 경고')
  log(`같은 데이터에 변형 ${n}개를 돌려 기준선과 비교했다. 그중 ${winners}개가 전·후반 **모두**에서 기준선을 이겼다.`)
  log(
    `순수 우연이라도 한 변형이 두 구간 모두 이길 확률은 ≈25%이고, ${n}개 중 ${winners}개 이상이 그럴 확률은 ` +
      `약 ${(binomTail(n, winners, 0.25) * 100).toFixed(0)}%다 — 이 값이 크면 "찾아낸 패턴"이 아니라 표본 잡음이다.`,
  )
  log('채택 기준은 ① 전·후반 모두 기준선 초과 ② 두 구간 모두 알파 양(+) ③ 매매수가 극단적으로 적지 않을 것')
  log('(표본 소실)이다. 하나만 만족하는 변형을 골라 읽는 순간 곡선맞춤이다.')
}

/** 벤치 단순보유 곡선(총수익 보정 종가) — 알파 계산 기준. */
export const benchCurve = (bench: DailyBar[]) => bench.map((b) => ({ date: b.date, equity: b.c }))

function unverifiedNote() {
  log('')
  log('⚠️ [미검증-실데이터] 이 러너는 컨테이너에서 Yahoo가 403이라 합성 데이터 테스트로만 검증됐다.')
  log('   위 수치는 GitHub Actions(backtest.yml)·EC2 실행 결과로 채워야 한다.')
}

// ============================================================================
// MODE=xsmom — 횡단면 모멘텀 랭킹 (12-1) · 이동평균 없음
// ============================================================================
//
// 학계 표준(Jegadeesh–Titman 계열): 매월 첫 거래일에 "12개월 전 ~ 1개월 전" 수익률로
// 전 종목을 줄 세우고 상위 N만 동일가중 보유, 다음 달 첫 거래일에 리밸런스.
// **최근 1개월을 통째로 버리는 것**이 핵심이다(단기 반전 효과 회피).
//
// 미래참조 차단: 랭킹은 `date < 전월 1일` 종가만 본다. 리밸런스일 D의 시가는 체결에만
// 쓰고 판정에는 쓰지 않는다. 12개월치 데이터가 없는 종목은 후보에서 뺀다.

/** 'YYYY-MM-DD'에서 k개월 이동한 달의 1일 — 'YYYY-MM-01' */
export function shiftMonthStart(date: string, k: number): string {
  const y = Number(date.slice(0, 4))
  const m = Number(date.slice(5, 7))
  const t = y * 12 + (m - 1) + k
  const yy = Math.floor(t / 12)
  const mm = t - yy * 12 + 1
  return `${String(yy).padStart(4, '0')}-${String(mm).padStart(2, '0')}-01`
}

/**
 * `date` **미만**(strictly before)인 봉의 개수 = 그 시점까지 확정된 봉의 오른쪽 경계 인덱스.
 * 랭킹 창은 전부 이 경계로 자른다 — `bars[idxBefore(bars, D) .. ]`는 D 시점에 아직
 * 모르는 미래이므로 어떤 계열도 읽지 않는다(규칙 1-1). 이분 탐색.
 */
export function idxBefore(bars: DailyBar[], date: string): number {
  let lo = 0
  let hi = bars.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (bars[mid].date < date) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** `date` **미만**(strictly before) 마지막 봉의 종가. 없으면 null. */
export function lastCloseBefore(bars: DailyBar[], date: string): number | null {
  const n = idxBefore(bars, date)
  return n > 0 ? bars[n - 1].c : null
}

/**
 * 12-1 모멘텀. 리밸런스일 `date`(월 첫 거래일) 기준으로
 *   시작 = 12개월 전 달 1일 직전 종가 · 끝 = 1개월 전 달 1일 직전 종가.
 * 두 기준일 모두 `date`보다 과거라 미래참조가 원천적으로 불가능하고, 직전 한 달의
 * 수익은 창에서 빠진다. 12개월치 데이터가 없으면(시작 종가 부재) null = 후보 제외.
 */
export function momentum12_1(bars: DailyBar[], date: string): number | null {
  const pe = lastCloseBefore(bars, shiftMonthStart(date, -1))
  const ps = lastCloseBefore(bars, shiftMonthStart(date, -12))
  if (pe == null || ps == null || !(ps > 0)) return null
  return pe / ps - 1
}

// ---- 랭킹 계열 공용 러너 -----------------------------------------------------
//
// xsmom·lowvol·hi52·strev·volrank는 **랭킹 함수 하나만** 다르고 나머지(월 첫 거래일 시가
// 리밸런스·상위 N 동일가중·슬롯 분모 고정·게이트는 현금)는 전부 같다. 그 공통부를 여기
// 한 군데 두고 계열은 `RankFn`만 갈아 끼운다 — 계열마다 시뮬을 복사하면 미묘하게 갈라져
// "서로 다른 전략을 비교하는" 사고가 난다(그래서 xsmom도 이 러너 위에 올려 두었다).

export interface RankRow {
  sym: string
  /**
   * 랭킹 점수 — **클수록 상위**. 계열이 부호를 맞춰 넣는다(저변동성·단기반전처럼
   * "작을수록 좋은" 지표는 음수로 뒤집어 넣는다). 러너는 항상 상위 N을 담는다.
   */
  score: number
  /**
   * 게이트 판정용 보조 스칼라 — 계열이 의미를 정의한다(xsmom=절대모멘텀 · hi52=근접도 ·
   * strev=직전 1개월 수익 원값 · volrank=급증비 · lowvol=절대모멘텀). 랭킹 자체에는
   * 관여하지 않고 `keep`만 읽는다.
   */
  aux: number
}

export type RankFn = (histories: Record<string, DailyBar[]>, universe: string[], date: string) => RankRow[]

/**
 * 종목별 점수를 매겨 **score 내림차순 · 동점은 심볼 오름차순**(결정적)으로 세운다.
 * `scoreOf`가 null을 주면 후보에서 뺀다(창을 채울 데이터가 없는 종목).
 */
export function rankUniverse(
  histories: Record<string, DailyBar[]>,
  universe: string[],
  date: string,
  scoreOf: (bars: DailyBar[], date: string) => { score: number; aux: number } | null,
): RankRow[] {
  const rows: RankRow[] = []
  for (const s of universe) {
    const bars = histories[s]
    if (!bars?.length) continue
    const v = scoreOf(bars, date)
    if (v == null) continue
    rows.push({ sym: s, score: v.score, aux: v.aux })
  }
  rows.sort((x, y) => (y.score !== x.score ? y.score - x.score : x.sym < y.sym ? -1 : x.sym > y.sym ? 1 : 0))
  return rows
}

export interface RankSimOpts {
  /** 보유 종목 수 N */
  slots: number
  /** 계열의 랭킹 함수 */
  rank: RankFn
  /**
   * 상위 N을 **뽑은 뒤** 거르는 게이트. 걸러진 슬롯은 다른 종목으로 메우지 않고
   * **현금**으로 남는다(아래 분모 고정 주석 참조). 없으면 게이트 없음.
   */
  keep?: (row: RankRow) => boolean
  /**
   * 리스크 오버레이 — 그 달의 **노출 비중** w∈[0,1] (MODE=overlay).
   * 리밸런스일(월 첫 거래일)에만 읽어 슬롯 금액을 `eq×w/denom`으로 줄이고, 남는 몫은
   * 현금으로 둔다. **분모(denom)는 건드리지 않는다** — 분모를 같이 줄이면 남은 종목에
   * 레버리지를 거는 셈이라 A/B가 오염된다(게이트와 같은 이유). w=0이면 그 달은 슬리브
   * 전체가 현금이다(시장 레짐 게이트). 상한 1 — 레버리지는 만들지 않는다.
   *
   * ⚠️ 규칙 1: 이 함수는 리밸런스일 **이전에 확정된** 정보만으로 값을 정해야 한다.
   *    (호출부가 지키는 계약이며, `tests/overlay.test.ts`가 절단 불변성으로 집행한다.)
   * 지정하지 않으면 슬롯 계산식 자체가 기존 경로 그대로다(골든 지문 불변).
   */
  exposure?: (date: string) => number
  /**
   * 월중 크래시 스톱 — 그 달 매수가(월초 시가) 대비 `stopPct`% 이탈하면 **그 슬롯만**
   * 즉시 청산하고 다음 리밸런스까지 현금으로 둔다(다른 종목으로 메우지 않는다).
   * 갭 관통 시 기준가가 아니라 **시가**로 체결한다 — 규칙 1-4, 유리한 쪽으로 가정하지 않는다.
   * 없거나 0 이하면 스톱 없음.
   */
  stopPct?: number
}

/**
 * 한 해치 랭킹 전략 시뮬. 월 첫 거래일 **시가**에 리밸런스한다.
 * 슬롯 분모는 게이트와 무관하게 `min(N, 후보수)`로 고정한다 — 그래야 게이트 A/B가
 * "같은 슬롯 중 몇 개를 현금으로 돌렸나"의 비교가 된다(분모를 같이 줄이면 게이트가
 * 남은 종목에 레버리지를 거는 셈이라 비교가 오염된다).
 *
 * 미래참조(규칙 1): 랭킹 창은 계열 랭킹 함수가 전부 **리밸런스 달 시작 이전** 확정 봉으로
 * 자른다. 리밸런스일 D의 시가는 **체결에만** 쓰고 판정에는 쓰지 않는다.
 */
export function simulateRankYear(
  histories: Record<string, DailyBar[]>,
  startDate: string,
  symbols: string[],
  cost: CostSettings,
  opts: RankSimOpts,
): CustomYearRun {
  const { universe, calendar, idxOf } = makeSimCtx(histories, symbols, startDate)
  const book = newBook(cost.initialCapital)
  const equity: { date: string; equity: number }[] = []
  const fills: FillEvent[] = []
  /** 크래시 스톱 기준가 = 그 달 매수가(월초 시가). 스톱이 꺼져 있으면 항상 비어 있다. */
  const entryRef = new Map<string, number>()
  const stopOn = (opts.stopPct ?? 0) > 0
  const closeAt = (date: string) => (s: string) => {
    const bi = idxOf[s]?.get(date)
    return bi != null ? histories[s][bi].c : null
  }
  let curYm = ''

  for (let d = 0; d < calendar.length; d++) {
    const date = calendar[d]
    // 랭킹은 전월 1일 이전 종가까지만 보므로 판단 시점은 늦어도 직전 거래일이다
    const signalDate = d > 0 ? calendar[d - 1] : date
    const sell = (sym: string, px: number, qty: number) => {
      const q = bookSell(book, cost, sym, px, qty)
      if (q > 0) fills.push({ date, sym, side: 'sell', px, qty: q, signalDate })
    }
    const buy = (sym: string, px: number, budget: number) => {
      const q = bookBuy(book, cost, sym, px, budget, d)
      if (q > 0) fills.push({ date, sym, side: 'buy', px, qty: q, signalDate })
    }
    const ym = ymOf(date)
    if (ym !== curYm) {
      curYm = ym
      // ---- 월 첫 거래일: 시가 리밸런스 ----------------------------------
      const openPx = new Map<string, number | null>()
      for (const s of universe) {
        const bi = idxOf[s].get(date)
        openPx.set(s, bi != null ? histories[s][bi].o : null)
      }
      let eq = book.cash
      for (const [s, p] of book.positions) {
        const px = openPx.get(s)
        eq += p.qty * (px != null && px > 0 ? px : p.lastClose)
      }
      // 후보: 랭킹 산출 가능 + 오늘 실제로 거래되는 종목만(체결 불가 종목을 담지 않는다)
      const ranked = opts.rank(histories, universe, date).filter((r) => (openPx.get(r.sym) ?? 0) > 0)
      const denom = Math.max(1, Math.min(opts.slots, ranked.length))
      const picked = ranked.slice(0, denom)
      const targets = opts.keep ? picked.filter(opts.keep) : picked
      const targetSet = new Set(targets.map((r) => r.sym))
      // 오버레이가 없으면 식 자체가 예전 그대로다(부동소수점까지 동일 — 골든 지문 보호).
      const slot = opts.exposure ? (eq * Math.min(1, Math.max(0, opts.exposure(date)))) / denom : eq / denom

      // 1) 목표 밖 전량 매도 (봉이 없으면 못 판다 — 다음 기회로 이월)
      for (const s of [...book.positions.keys()]) {
        if (targetSet.has(s)) continue
        const px = openPx.get(s)
        if (px == null || !(px > 0)) continue
        sell(s, px, book.positions.get(s)!.qty)
      }
      // 2) 목표 초과분 트림
      for (const r of targets) {
        const p = book.positions.get(r.sym)
        if (!p) continue
        const px = openPx.get(r.sym)!
        const want = Math.floor(slot / px)
        if (p.qty > want) sell(r.sym, px, p.qty - want)
      }
      // 3) 부족분 매수
      for (const r of targets) {
        const px = openPx.get(r.sym)!
        const held = book.positions.get(r.sym)?.qty ?? 0
        const budget = Math.min(slot - held * px, book.cash)
        if (budget <= 0) continue
        buy(r.sym, px, budget)
      }
      // 4) 크래시 스톱 기준가 갱신 — 이 달의 "매수가"는 **오늘 시가**다.
      //    오늘 봉이 없어 손도 못 댄 종목은 지난달 기준가를 그대로 둔다(스톱을 꺼 주지 않는다).
      if (stopOn) {
        for (const s of [...entryRef.keys()]) if (!book.positions.has(s)) entryRef.delete(s)
        for (const s of book.positions.keys()) {
          const px = openPx.get(s)
          if (px != null && px > 0) entryRef.set(s, px)
        }
      }
    }
    // ---- 월중 크래시 스톱 (규칙 1-4: 갭 관통은 시가로 체결) --------------------
    //
    // 스톱 주문은 그 달 리밸런스 시점에 이미 걸어 둔 조건부 주문이다 — 판단에 쓰는 값은
    // 기준가(월초 시가)와 오늘 봉의 저가·시가뿐이고, 오늘 종가나 이후 봉은 보지 않는다.
    // 리밸런스 당일에도 검사한다(시가에 샀으니 그날 장중 −X% 이탈이 실제로 가능하다).
    if (stopOn && entryRef.size > 0) {
      const th = 1 - opts.stopPct! / 100
      for (const [s, ref] of [...entryRef]) {
        const p = book.positions.get(s)
        if (!p) {
          entryRef.delete(s)
          continue
        }
        const bi = idxOf[s]?.get(date)
        if (bi == null) continue // 오늘 봉이 없으면 체결 자체가 불가 — 다음 기회로
        const bar = histories[s][bi]
        const stop = ref * th
        if (!(bar.l <= stop)) continue
        // 시가가 이미 기준선 아래로 갭 관통했으면 기준가가 아니라 **시가**(더 불리한 쪽)로 체결
        sell(s, bar.o <= stop ? bar.o : stop, p.qty)
        entryRef.delete(s)
      }
    }
    equity.push({ date, equity: bookMark(book, closeAt(date)) })
  }
  return { equity, closed: book.closed, wins: book.wins, openAtEnd: book.positions.size, fills }
}

/** 12-1 모멘텀 랭킹 행. `mom`은 `score`·`aux`와 같은 값이다(기존 호출부 호환). */
export type MomRow = RankRow & { mom: number }

/** 모멘텀 내림차순, 동점은 심볼 오름차순(결정적). */
export function xsmomRank(histories: Record<string, DailyBar[]>, universe: string[], date: string): MomRow[] {
  return rankUniverse(histories, universe, date, (bars, d) => {
    const m = momentum12_1(bars, d)
    return m == null ? null : { score: m, aux: m }
  }).map((r) => ({ ...r, mom: r.score }))
}

export interface XsMomOpts {
  /** 보유 종목 수 N */
  slots: number
  /** 절대 모멘텀 게이트 — 12-1 수익 < 0인 종목은 그 슬롯을 **현금**으로 둔다 */
  gate: boolean
}

/**
 * 한 해치 횡단면 모멘텀 시뮬 — 공용 러너에 12-1 랭킹만 끼운 것이다.
 * (25차에서 검증이 끝난 경로라 결과가 바뀌면 안 된다. `tests/screen.test.ts`의
 * 골든 지문 테스트가 리팩토링 전 산출물과의 바이트 동일성을 집행한다.)
 */
export function simulateXsMomYear(
  histories: Record<string, DailyBar[]>,
  startDate: string,
  symbols: string[],
  cost: CostSettings,
  opts: XsMomOpts,
): CustomYearRun {
  return simulateRankYear(histories, startDate, symbols, cost, {
    slots: opts.slots,
    rank: xsmomRank,
    keep: opts.gate ? (r) => r.aux >= 0 : undefined,
  })
}

async function xsmom() {
  log('# MODE=xsmom — 횡단면 모멘텀 랭킹 (12-1) · 이동평균 없음')
  log('')
  log('매월 첫 거래일에 "12개월 전~1개월 전" 수익률로 줄 세워 상위 N만 동일가중 보유하고,')
  log('다음 달 첫 거래일 **시가**에 리밸런스한다. 최근 1개월은 단기 반전을 피하려고 통째로 뺀다.')
  log('이동평균·신고가 같은 추세 지표를 전혀 쓰지 않는 접근이다.')
  log('')
  const { years, histories, bench } = await loadPitHistories()
  const yearly = buildYearly(histories, years)
  if (yearly.every((v) => v.syms.length < 5)) {
    log('❌ 시세 로드 실패로 실행할 해가 없다 — 중단')
    return
  }
  const benchEq = benchCurve(bench)
  log(`연도별 매핑률: ${yearly.map((v) => `${v.y} ${v.mapped}`).join(' · ')}`)
  log(`벤치 ${BENCH} 데이터 시작 ${bench[0]?.date ?? '—'} — 알파는 이 날짜 이후 겹치는 구간에서만 계산한다.`)

  const rows: StratRow[] = []
  rows.push(summarizeStrat(BASELINE_LABEL, runSpecChain(yearly, baselineSpec, COST), benchEq))
  for (const slots of [5, 10]) {
    for (const gate of [false, true]) {
      const label = `XSM 상위 ${slots}${gate ? ' + 절대모멘텀 게이트' : ''}`
      // 변형별 자산곡선은 이 블록 안에서만 살아 있다 — 요약 후 즉시 회수된다(메모리)
      const chain = runCustomChain(
        yearly,
        (v) => simulateXsMomYear(v.hist, `${v.y}-01-01`, v.syms, COST, { slots, gate }),
        COST,
        slots,
      )
      rows.push(summarizeStrat(label, chain, benchEq))
    }
  }

  log('')
  log('## 성적 (기준선을 같은 유니버스·같은 비용으로 재실행한 값과 나란히)')
  stratTable(rows)
  baselineCrossCheck(yearly)
  const winners = verdictTable(rows)
  perYearTable(rows)
  multipleTestingNote(rows.length - 1, winners)

  log('')
  log('## 이 실험의 구조적 한계')
  log('· 유니버스가 연 20종목뿐이라 "상위 5/10"은 사실상 상위 25~50% 분위다 — 학계의 상위 10% 분위')
  log('  모멘텀보다 신호가 훨씬 묽다. 알파가 안 나와도 "모멘텀이 죽었다"가 아니라 "이 유니버스에서는')
  log('  분위가 안 갈린다"일 수 있다.')
  log('· 연도별 유니버스 교체 구조라 매년 1월 초 전량 재편입 + 12월 말 정산 근사가 들어간다.')
  log('· 12개월치 시세가 없는 종목은 그 시점 후보에서 빠진다(신규 편입 종목은 1년 뒤부터 랭킹 대상).')
  unverifiedNote()
  disclaimer()
}

// ============================================================================
// MODE=screen — 미검증 랭킹 4계열 일괄 스크리너 (발굴 깔때기 1~2관문)
// ============================================================================
//
// 네 계열 전부 xsmom과 **같은 깔때기**(월 첫 거래일 시가 리밸런스 · 상위 N 동일가중 ·
// 연도별 PIT 10+10 교체 연쇄 · 같은 비용·벤치·기준선)를 지난다. 계열이 바꾸는 것은
// `RankFn` 하나뿐이고, 그 제약을 `simulateRankYear`가 구조적으로 강제한다.
//
// ── 랭킹 창의 오른쪽 경계 = **리밸런스 달의 1일**(규칙 1) ─────────────────────
// 리밸런스일 D는 그 달의 첫 거래일이므로 `date < shiftMonthStart(D, 0)`으로 자르면
// **직전 달 마지막 확정 종가까지**만 남는다. 당일 봉은 물론 그 달 어떤 봉도 창에 못 들어온다.
// 52주 최고가·변동성·거래대금 창이 전부 이 경계를 공유하며, 각 계열마다 "그 경계 이후를
// 3배로 조작해도 점수가 불변"인 테스트가 `tests/screen.test.ts`에 붙어 있다.
//
// ── 계열 정의 ────────────────────────────────────────────────────────────────
//   lowvol  : 직전 12개월 **일수익률 표준편차가 낮은** 상위 N (저변동성 이상현상)
//   hi52    : 직전 종가 ÷ 직전 52주 최고가가 **높은** 상위 N (George & Hwang 2004)
//   strev   : 직전 1개월 수익률이 **낮은**(가장 많이 빠진) 상위 N (단기 반전)
//   volrank : 직전 5일 평균 거래대금 ÷ 직전 60일 평균 거래대금이 **높은** 상위 N (거래량 급증)
//
// ⚠️ 메모리: 변형별 자산곡선은 요약 즉시 버리고 스칼라만 남긴다(pit1010 400조합 OOM 교훈).

/** 랭킹 창 기본 길이(개월) — lowvol·hi52가 공유한다. 52주 ≈ 12개월. */
export const SCREEN_WINDOW_MONTHS = 12
/** 12개월 창이 실제로 채워졌다고 볼 최소 봉 수. 거래정지·희소 종목을 후보에서 뺀다. */
export const SCREEN_MIN_BARS = 120
/** volrank 단기·장기 창(거래일). */
export const VOLRANK_FAST = 5
export const VOLRANK_SLOW = 60
/** 계열 채택 판정에 요구하는 최소 청산완료 매매 수 — 이보다 적으면 표본 소실로 본다. */
export const SCREEN_MIN_TRADES = 20

/**
 * 랭킹 창 [12개월 전 달 1일, 리밸런스 달 1일)의 봉 구간 [lo, hi).
 * `lo === 0`(= 창 시작 이전 봉이 아예 없음)이면 12개월치가 없는 종목이므로 null —
 * `momentum12_1`이 12개월치 없는 종목을 빼는 것과 같은 규약이다.
 */
function monthWindow(bars: DailyBar[], date: string, months: number, minBars: number) {
  const hi = idxBefore(bars, shiftMonthStart(date, 0))
  const lo = idxBefore(bars, shiftMonthStart(date, -months))
  if (lo === 0 || hi - lo < minBars) return null
  return { lo, hi }
}

/**
 * 직전 12개월 **일수익률 표준편차**(모표준편차). 창 안의 연속 종가 쌍만 쓴다 —
 * 창 밖(미래) 종가를 끌어와 첫 수익률을 만들지 않는다.
 */
export function lowVolStdev(
  bars: DailyBar[],
  date: string,
  months = SCREEN_WINDOW_MONTHS,
  minBars = SCREEN_MIN_BARS,
): number | null {
  const w = monthWindow(bars, date, months, minBars)
  if (!w) return null
  const rets: number[] = []
  for (let i = w.lo + 1; i < w.hi; i++) {
    const p0 = bars[i - 1].c
    const p1 = bars[i].c
    if (!(p0 > 0) || !(p1 > 0)) return null
    rets.push(p1 / p0 - 1)
  }
  if (rets.length < minBars - 1) return null
  let sum = 0
  for (const r of rets) sum += r
  const mean = sum / rets.length
  let ss = 0
  for (const r of rets) ss += (r - mean) * (r - mean)
  return Math.sqrt(ss / rets.length)
}

/**
 * 52주 신고가 근접도 = (창 오른쪽 끝 확정 종가) ÷ (창 안 최고 고가). 1에 가까울수록
 * 신고가 부근이다. 최고가 창은 **당일은 물론 리밸런스 달 전체를 제외**한다(규칙 1-3).
 */
export function hi52Ratio(
  bars: DailyBar[],
  date: string,
  months = SCREEN_WINDOW_MONTHS,
  minBars = SCREEN_MIN_BARS,
): number | null {
  const w = monthWindow(bars, date, months, minBars)
  if (!w) return null
  const px = bars[w.hi - 1].c
  if (!(px > 0)) return null
  let peak = 0
  for (let i = w.lo; i < w.hi; i++) if (bars[i].h > peak) peak = bars[i].h
  if (!(peak > 0)) return null
  return px / peak
}

/**
 * 직전 1개월(직전 달) 수익률 = (직전 달 마지막 확정 종가) ÷ (그 전 달 마지막 확정 종가) − 1.
 * 두 기준일 모두 리밸런스 달 시작 이전이라 미래참조가 원천적으로 불가능하다.
 * 단기 반전은 이 값이 **낮을수록** 상위이므로 랭킹 점수는 부호를 뒤집어 쓴다.
 */
export function shortRevReturn(bars: DailyBar[], date: string): number | null {
  const pe = lastCloseBefore(bars, shiftMonthStart(date, 0))
  const ps = lastCloseBefore(bars, shiftMonthStart(date, -1))
  if (pe == null || ps == null || !(ps > 0)) return null
  return pe / ps - 1
}

/**
 * 거래량 급증비 = 직전 `fast`일 평균 거래대금 ÷ 직전 `slow`일 평균 거래대금.
 * 두 창 모두 리밸런스 달 시작 이전 봉으로만 만든다 — 당일 거래대금은 장이 끝나야
 * 확정되므로 진입 판단에 넣으면 그 자체가 미래참조다(volbrk와 같은 규약).
 * 거래대금은 종가×거래량 근사다(체결가별 대금이 아니라 일봉 근사).
 */
export function volSurgeRatio(
  bars: DailyBar[],
  date: string,
  fast = VOLRANK_FAST,
  slow = VOLRANK_SLOW,
): number | null {
  const hi = idxBefore(bars, shiftMonthStart(date, 0))
  if (hi < slow || fast > slow || fast <= 0) return null
  let slowSum = 0
  for (let i = hi - slow; i < hi; i++) slowSum += bars[i].c * bars[i].v
  let fastSum = 0
  for (let i = hi - fast; i < hi; i++) fastSum += bars[i].c * bars[i].v
  const slowAvg = slowSum / slow
  if (!(slowAvg > 0)) return null
  return fastSum / fast / slowAvg
}

// ---- 계열별 RankFn — 부호를 여기서 맞춘다(러너는 항상 상위 N을 담는다) --------

/** 저변동성: 표준편차가 **작을수록** 상위 → 점수는 −σ. 보조값은 절대모멘텀(게이트용). */
export const lowVolRank: RankFn = (h, u, d) =>
  rankUniverse(h, u, d, (bars, date) => {
    const sd = lowVolStdev(bars, date)
    if (sd == null) return null
    const m = momentum12_1(bars, date)
    return { score: -sd, aux: m ?? Number.NEGATIVE_INFINITY }
  })

/** 52주 신고가 근접도: 클수록 상위. 보조값 = 근접도 자신(임계 게이트용). */
export const hi52Rank: RankFn = (h, u, d) =>
  rankUniverse(h, u, d, (bars, date) => {
    const r = hi52Ratio(bars, date)
    return r == null ? null : { score: r, aux: r }
  })

/** 단기 반전: 직전 1개월 수익이 **작을수록** 상위 → 점수는 −수익. 보조값 = 수익 원값. */
export const shortRevRank: RankFn = (h, u, d) =>
  rankUniverse(h, u, d, (bars, date) => {
    const r = shortRevReturn(bars, date)
    return r == null ? null : { score: -r, aux: r }
  })

/** 거래량 급증: 급증비가 클수록 상위. 보조값 = 급증비 자신(임계 게이트용). */
export const volRankRank: RankFn = (h, u, d) =>
  rankUniverse(h, u, d, (bars, date) => {
    const r = volSurgeRatio(bars, date)
    return r == null ? null : { score: r, aux: r }
  })

// ---- 계열·변형 정의 ----------------------------------------------------------

export interface ScreenVariant {
  /** 표에 찍히는 변형 이름(계열명 뒤에 붙는다) */
  label: string
  slots: number
  /** 상위 N을 뽑은 뒤 거르는 게이트. 걸러진 슬롯은 현금. */
  keep?: (row: RankRow) => boolean
}

export interface ScreenFamily {
  key: string
  name: string
  /** 계열 정의 한 줄 — 보고서와 코드가 **같은 문장**을 쓰게 강제한다 */
  def: string
  /** 왜 이 계열을 보는가(학계 근거) */
  basis: string
  rank: RankFn
  variants: ScreenVariant[]
}

/** hi52 게이트 임계 — 52주 최고가 대비 10% 이내. */
export const HI52_GATE = 0.9
/** volrank 게이트 임계 — 5일 평균 거래대금이 60일 평균의 1.5배 이상. */
export const VOLRANK_GATE = 1.5

/**
 * 계열당 변형 3개(N=5 · N=10 · N=5+게이트)로 고정한다. 게이트는 계열마다 **그 계열의
 * 보조값**에 거는 자연스러운 임계 하나뿐이다 — 게이트를 계열마다 여러 개 달면 그게 곧
 * 격자 탐색이 되고, 1~2관문에서 격자를 돌리면 3관문에 보낼 계열을 잡음으로 고르게 된다.
 */
export const SCREEN_FAMILIES: ScreenFamily[] = [
  {
    key: 'lowvol',
    name: '저변동성 랭킹',
    def: '직전 12개월 일수익률 표준편차가 **낮은** 상위 N 동일가중',
    basis: '저변동성 이상현상(low-vol anomaly) — 위험이 낮은 쪽이 위험조정 후 더 벌었다는 학계 관측',
    rank: lowVolRank,
    variants: [
      { label: '상위 5', slots: 5 },
      { label: '상위 10', slots: 10 },
      { label: '상위 5 + 절대모멘텀 게이트', slots: 5, keep: (r) => r.aux >= 0 },
    ],
  },
  {
    key: 'hi52',
    name: '52주 신고가 근접도 랭킹',
    def: '직전 확정 종가 ÷ 직전 52주 최고가가 **높은** 상위 N 동일가중',
    basis: 'George & Hwang(2004) — 52주 신고가 근접도가 모멘텀 수익의 상당 부분을 설명한다',
    rank: hi52Rank,
    variants: [
      { label: '상위 5', slots: 5 },
      { label: '상위 10', slots: 10 },
      { label: `상위 5 + 근접도 ${HI52_GATE} 이상`, slots: 5, keep: (r) => r.aux >= HI52_GATE },
    ],
  },
  {
    key: 'strev',
    name: '단기(1개월) 반전 랭킹',
    def: '직전 1개월 수익률이 **낮은**(가장 많이 빠진) 상위 N 동일가중',
    basis: '단기 반전(short-term reversal) — xsmom이 12-1로 최근 1개월을 빼는 이유가 이 효과다',
    rank: shortRevRank,
    variants: [
      { label: '상위 5', slots: 5 },
      { label: '상위 10', slots: 10 },
      { label: '상위 5 + 실제 하락분만', slots: 5, keep: (r) => r.aux <= 0 },
    ],
  },
  {
    key: 'volrank',
    name: '거래량 급증 랭킹',
    def: `직전 ${VOLRANK_FAST}일 평균 거래대금 ÷ 직전 ${VOLRANK_SLOW}일 평균 거래대금이 **높은** 상위 N 동일가중`,
    basis: '거래량 급증이 정보 유입·관심 집중의 대리변수라는 관측(거래대금은 종가×거래량 근사)',
    rank: volRankRank,
    variants: [
      { label: '상위 5', slots: 5 },
      { label: '상위 10', slots: 10 },
      { label: `상위 5 + 급증비 ${VOLRANK_GATE}배 이상`, slots: 5, keep: (r) => r.aux >= VOLRANK_GATE },
    ],
  },
]

// ---- 계열 종합 판정 ----------------------------------------------------------

export interface FamilyVerdict {
  key: string
  name: string
  /** 계열 안에서 알파가 가장 높은 변형 */
  best: StratRow
  /** 전·후반 **둘 다** 기준선 총수익을 넘었나 */
  bothHalves: boolean
  /** 전·후반 **둘 다** 알파가 양(+)인가 */
  bothAlpha: boolean
  /** 표본이 남아 있나 */
  enoughTrades: boolean
  /** 위 셋을 모두 만족해야 3관문 진행 권고 */
  advance: boolean
  /** 탈락 사유(진행 권고면 빈 문자열) */
  reason: string
}

/**
 * 계열 하나를 판정한다. **알파 최고 변형**을 계열 대표로 세우고(규칙 5 — 절대 수익이
 * 아니라 초과분), 그 대표가 채택 3조건을 모두 통과할 때만 다음 관문을 권고한다.
 * 대표를 사후에 고르는 것 자체가 선택편향이라, 이 값은 "계열의 상한"으로만 읽어야 한다.
 */
export function judgeFamily(fam: ScreenFamily, base: StratRow, rows: StratRow[]): FamilyVerdict {
  // 알파를 못 잰 변형(벤치 구간 부재)은 최하위로 민다. **뺄셈으로 비교하지 않는다** —
  // 둘 다 −Infinity면 차가 NaN이라 모든 비교가 거짓이 되고 대표가 첫 줄로 굳는다(실제로 그랬다).
  const key = (r: StratRow) => r.alphaFull ?? Number.NEGATIVE_INFINITY
  const tieKey = (r: StratRow) => r.full.obj ?? Number.NEGATIVE_INFINITY
  let best = rows[0]
  for (const r of rows.slice(1)) {
    const a = key(r)
    const b = key(best)
    if (a > b || (a === b && tieKey(r) > tieKey(best))) best = r
  }
  const bothHalves = best.a.total - base.a.total > 0 && best.b.total - base.b.total > 0
  const bothAlpha = (best.alphaA ?? -1) > 0 && (best.alphaB ?? -1) > 0
  const enoughTrades = best.closed >= SCREEN_MIN_TRADES
  const reasons: string[] = []
  if (!bothHalves) reasons.push('전·후반 중 한쪽이 기준선 미달')
  if (!bothAlpha) reasons.push('전·후반 중 한쪽 알파 음(−)')
  if (!enoughTrades) reasons.push(`매매 ${best.closed}건(<${SCREEN_MIN_TRADES})으로 표본 부족`)
  return {
    key: fam.key,
    name: fam.name,
    best,
    bothHalves,
    bothAlpha,
    enoughTrades,
    advance: bothHalves && bothAlpha && enoughTrades,
    reason: reasons.join(' · '),
  }
}

export function familyVerdictTable(vs: FamilyVerdict[]) {
  log('')
  log('## 4계열 종합 판정표 (다음 관문 진행 여부)')
  log('| 계열 | 최고 변형(알파 기준) | 전 구간 알파 | 전반 알파 | 후반 알파 | 전·후반 모두 통과? | 매매 | 다음 관문 진행 |')
  log('|---|---|---|---|---|---|---|---|')
  for (const v of vs)
    log(
      `| ${v.name} | ${v.best.label} | ${pctOrDash(v.best.alphaFull)} | ${pctOrDash(v.best.alphaA)} | ` +
        `${pctOrDash(v.best.alphaB)} | ${v.bothHalves && v.bothAlpha ? '✅' : '❌'} | ${v.best.closed} | ` +
        `${v.advance ? '✅ 3관문 진행' : `❌ 종료 — ${v.reason}`} |`,
    )
  log('')
  log('"최고 변형"은 **사후에 고른 것**이라 그 자체로 낙관 편향이 있다 — 계열의 상한으로만 읽고,')
  log('진행 권고가 붙은 계열도 3관문(워크포워드·파라미터 안정성·교차시장)에서 다시 떨어질 수 있다.')
}

async function screen() {
  log('# MODE=screen — 미검증 랭킹 4계열 일괄 스크리너 (발굴 깔때기 1~2관문)')
  log('')
  log('발굴을 계열 단위로 진행한다. 이미 판정이 끝난 계열(추세돌파 ✅ · 횡단면 모멘텀 ✅ ·')
  log('변동성 돌파 ❌ · RSI 평균회귀 ❌ · 계절성 ❌ · 월패턴 ❌ · 페어 ❌)은 재실행하지 않고,')
  log('이 리포에서 **처음 돌아가는 4계열**만 같은 깔때기에 한 번에 태운다.')
  log('')
  log('| 계열 | 정의 | 근거 |')
  log('|---|---|---|')
  for (const fam of SCREEN_FAMILIES) log(`| ${fam.key} — ${fam.name} | ${fam.def} | ${fam.basis} |`)
  log('')
  log('공통 규약(계열 간 비교가 성립하도록 **랭킹 함수 말고는 전부 동일**하게 고정):')
  log('· 매월 첫 거래일 **시가** 리밸런스 · 상위 N 동일가중 · 슬롯 분모는 게이트와 무관하게 고정')
  log('· 연도별 PIT 상위 10+10 [추정] 교체 유니버스 연쇄 · 구간 끝 청산비용 근사')
  log(`· 비용 수수료 ${COST.feePct}% · 거래세 ${COST.taxPct}% · 슬리피지 ${COST.slippagePct}%(왕복 약 0.38%)`)
  log(`· 벤치 ${BENCH}(KODEX 200) 대비 알파 · ${BASELINE_LABEL}을 같은 조건으로 재실행해 대조`)
  log('· 랭킹 창은 전부 **리밸런스 달 1일 이전** 확정 봉으로 자른다(규칙 1 — 당일·당월 제외)')
  log('')
  const { years, histories, bench } = await loadPitHistories()
  const yearly = buildYearly(histories, years)
  if (yearly.every((v) => v.syms.length < 5)) {
    log('❌ 시세 로드 실패로 실행할 해가 없다 — 중단')
    return
  }
  const benchEq = benchCurve(bench)
  log(`연도별 매핑률: ${yearly.map((v) => `${v.y} ${v.mapped}`).join(' · ')}`)
  log(`벤치 ${BENCH} 데이터 시작 ${bench[0]?.date ?? '—'} — 알파는 이 날짜 이후 겹치는 구간에서만 계산한다.`)

  const baseRow = summarizeStrat(BASELINE_LABEL, runSpecChain(yearly, baselineSpec, COST), benchEq)
  const rows: StratRow[] = [baseRow]
  const verdicts: FamilyVerdict[] = []

  for (const fam of SCREEN_FAMILIES) {
    const famRows: StratRow[] = []
    for (const v of fam.variants) {
      // 변형별 자산곡선은 이 블록 안에서만 살아 있다 — 요약 후 즉시 회수된다(메모리)
      const chain = runCustomChain(
        yearly,
        (y) => simulateRankYear(y.hist, `${y.y}-01-01`, y.syms, COST, { slots: v.slots, rank: fam.rank, keep: v.keep }),
        COST,
        v.slots,
      )
      const row = summarizeStrat(`${fam.key} ${v.label}`, chain, benchEq)
      famRows.push(row)
      rows.push(row)
    }
    verdicts.push(judgeFamily(fam, baseRow, famRows))
  }

  log('')
  log('## 성적 (기준선을 같은 유니버스·같은 비용으로 재실행한 값과 나란히)')
  stratTable(rows)
  baselineCrossCheck(yearly)
  const winners = verdictTable(rows)

  // 연도별 분해는 기준선 + 계열 대표만 — 13열을 다 찍으면 표가 읽히지 않는다
  perYearTable([baseRow, ...verdicts.map((v) => v.best)])
  multipleTestingNote(rows.length - 1, winners)
  familyVerdictTable(verdicts)

  const advancing = verdicts.filter((v) => v.advance)
  log('')
  log(
    advancing.length === 0
      ? '→ 이번 스크리닝에서 3관문으로 보낼 계열은 **없다**. 네 계열 모두 여기서 종료한다.'
      : `→ 3관문 진행 권고: ${advancing.map((v) => v.name).join(' · ')} (${advancing.length}/${verdicts.length}계열)`,
  )

  log('')
  log('## 이 실험의 구조적 한계')
  log('· 유니버스가 연 20종목뿐이라 "상위 5/10"은 사실상 상위 25~50% 분위다 — 학계의 상위 10%')
  log('  분위 랭킹보다 신호가 훨씬 묽다. 알파가 안 나와도 "그 이상현상이 죽었다"가 아니라')
  log('  "이 유니버스에서는 분위가 안 갈린다"일 수 있다. 특히 저변동성·거래량 계열은 대형주 20종목')
  log('  안에서 분산이 작아 랭킹이 잡음에 가까워질 수 있다.')
  log('· 왕복 비용 약 0.38%가 월 리밸런스에 그대로 얹힌다. strev(단기 반전)는 회전율이 가장 높은')
  log('  계열이라 이 비용을 못 넘기면 이론 알파가 있어도 실전에서 사라진다 — 이번 관문의 핵심 질문이다.')
  log('· 거래대금은 **종가×거래량 근사**이며 실제 체결대금이 아니다. 유동성·호가 잔량도 반영하지 않아')
  log('  volrank 상위 종목이 실제로 그 가격에 담기는지는 확인되지 않았다.')
  log('· 연도별 유니버스 교체 구조라 매년 1월 초 전량 재편입 + 12월 말 정산 근사가 들어간다.')
  log('· 12개월 창을 못 채우는 종목은 그 시점 후보에서 빠진다(신규 편입 종목은 1년 뒤부터 랭킹 대상).')
  log(`· 변형 ${rows.length - 1}개를 같은 데이터에 돌렸다 — 다중검정 경고를 판정표보다 먼저 읽을 것.`)
  unverifiedNote()
  disclaimer()
}

// ============================================================================
// MODE=volbrk — 변동성 돌파 (래리 윌리엄스 k)
// ============================================================================
//
// 돌파가 = 당일 시가 + k×(전일 고가 − 전일 저가). 당일 고가가 돌파가에 닿으면 매수한다.
//
// ⚠️ 일봉 근사의 한계(출력에도 명시한다):
//   · 일봉에는 **장중 경로**가 없다. 고가가 돌파가를 넘었다는 사실만 알 뿐, 그것이 언제
//     찍혔는지·그 가격에 실제로 체결됐는지(호가 잔량)는 알 수 없다.
//   · 청산 변형이 "당일 종가"인 경우, 돌파 체결 → 종가 청산의 순서만 가정할 뿐 그 사이
//     저가를 관통했는지는 반영하지 못한다(손절 없음).
//   · 랭킹은 **전일** 거래대금으로 한다 — 당일 거래대금은 장이 끝나야 확정되므로
//     진입 시점에 쓰면 미래참조다.

/**
 * 돌파 체결가. 고가가 돌파가에 못 닿으면 체결 없음(null).
 * **시가가 이미 돌파가 위면 시가**로 체결한다 — 갭으로 관통한 경우 유리한 쪽(돌파가)이
 * 아니라 불리한 쪽을 잡는 것이 규칙 1-4다.
 */
export function breakoutFill(open: number, high: number, target: number): number | null {
  if (!(high >= target)) return null
  return Math.max(open, target)
}

export interface VolBrkOpts {
  k: number
  /** 'close' = 당일 종가 청산(데이트레이드형) · 'nextOpen' = 익일 시가 청산 */
  exit: 'close' | 'nextOpen'
  slots: number
}

export function simulateVolBrkYear(
  histories: Record<string, DailyBar[]>,
  startDate: string,
  symbols: string[],
  cost: CostSettings,
  opts: VolBrkOpts,
): CustomYearRun {
  const { universe, calendar, idxOf } = makeSimCtx(histories, symbols, startDate)
  const book = newBook(cost.initialCapital)
  const equity: { date: string; equity: number }[] = []
  const fills: FillEvent[] = []
  const closeAt = (date: string) => (s: string) => {
    const bi = idxOf[s]?.get(date)
    return bi != null ? histories[s][bi].c : null
  }

  for (let d = 0; d < calendar.length; d++) {
    const date = calendar[d]
    const isLast = d === calendar.length - 1
    const sell = (sym: string, px: number, qty: number, signalDate: string) => {
      const q = bookSell(book, cost, sym, px, qty)
      if (q > 0) fills.push({ date, sym, side: 'sell', px, qty: q, signalDate })
    }

    // ---- 1) 익일 시가 청산 변형 — 전일 진입분을 오늘 시가에 전량 청산 ----------
    if (opts.exit === 'nextOpen') {
      for (const [s, p] of [...book.positions]) {
        if (p.entryIdx >= d) continue
        const bi = idxOf[s].get(date)
        if (bi == null) continue
        sell(s, histories[s][bi].o, p.qty, calendar[Math.max(0, d - 1)])
      }
    }

    // ---- 2) 돌파 진입 -------------------------------------------------------
    // 마지막 봉에서는 신규 진입을 만들지 않는다(규칙 1-6 — 익일 청산이 불가능하고
    // 엔진 기준선도 같은 날 신규 진입을 막으므로 비교 조건을 맞춘다).
    if (!isLast && book.positions.size < opts.slots) {
      const cands: { sym: string; fill: number; key: number }[] = []
      for (const s of universe) {
        if (book.positions.has(s)) continue
        const bi = idxOf[s].get(date)
        if (bi == null || bi < 1) continue
        const bars = histories[s]
        const b = bars[bi]
        const prev = bars[bi - 1]
        const range = prev.h - prev.l
        if (!(range > 0)) continue // 레인지 0(상·하한가 잠김 등)은 돌파 정의가 성립하지 않는다
        const fill = breakoutFill(b.o, b.h, b.o + opts.k * range)
        if (fill == null) continue
        cands.push({ sym: s, fill, key: prev.c * prev.v }) // 전일 거래대금 — 당일 값은 미래참조
      }
      cands.sort((x, y) => (y.key !== x.key ? y.key - x.key : x.sym < y.sym ? -1 : x.sym > y.sym ? 1 : 0))
      for (const cd of cands) {
        if (book.positions.size >= opts.slots) break
        const slot = book.cash / Math.max(1, opts.slots - book.positions.size)
        const q = bookBuy(book, cost, cd.sym, cd.fill, slot, d)
        // 판단도 체결도 당일 장중이라 signalDate = date다(장중 스톱 주문 근사)
        if (q > 0) fills.push({ date, sym: cd.sym, side: 'buy', px: cd.fill, qty: q, signalDate: date })
      }
    }

    // ---- 3) 당일 종가 청산 변형 ---------------------------------------------
    if (opts.exit === 'close') {
      for (const [s, p] of [...book.positions]) {
        const bi = idxOf[s].get(date)
        if (bi == null) continue
        sell(s, histories[s][bi].c, p.qty, date)
      }
    }

    equity.push({ date, equity: bookMark(book, closeAt(date)) })
  }
  return { equity, closed: book.closed, wins: book.wins, openAtEnd: book.positions.size, fills }
}

async function volbrk() {
  log('# MODE=volbrk — 변동성 돌파 (래리 윌리엄스 k)')
  log('')
  log('돌파가 = **당일 시가 + k×(전일 고가−전일 저가)**. 당일 고가가 돌파가에 닿으면 매수하고,')
  log('당일 종가(데이트레이드형) 또는 익일 시가에 청산한다. 이동평균을 쓰지 않는다.')
  log('')
  const { years, histories, bench } = await loadPitHistories()
  const yearly = buildYearly(histories, years)
  if (yearly.every((v) => v.syms.length < 5)) {
    log('❌ 시세 로드 실패로 실행할 해가 없다 — 중단')
    return
  }
  const benchEq = benchCurve(bench)
  log(`연도별 매핑률: ${yearly.map((v) => `${v.y} ${v.mapped}`).join(' · ')}`)
  log(`슬롯 ${MAX_POSITIONS} · 후보 초과 시 **전일** 거래대금 순 · 벤치 ${BENCH} 시작 ${bench[0]?.date ?? '—'}`)

  const rows: StratRow[] = []
  rows.push(summarizeStrat(BASELINE_LABEL, runSpecChain(yearly, baselineSpec, COST), benchEq))
  for (const k of [0.5, 0.7]) {
    for (const exit of ['close', 'nextOpen'] as const) {
      const label = `VB k=${k.toFixed(1)} · ${exit === 'close' ? '당일 종가 청산' : '익일 시가 청산'}`
      const chain = runCustomChain(
        yearly,
        (v) => simulateVolBrkYear(v.hist, `${v.y}-01-01`, v.syms, COST, { k, exit, slots: MAX_POSITIONS }),
        COST,
        MAX_POSITIONS,
      )
      rows.push(summarizeStrat(label, chain, benchEq))
    }
  }

  log('')
  log('## 성적 (기준선을 같은 유니버스·같은 비용으로 재실행한 값과 나란히)')
  stratTable(rows)
  baselineCrossCheck(yearly)
  const winners = verdictTable(rows)
  perYearTable(rows)
  multipleTestingNote(rows.length - 1, winners)

  log('')
  log('## ⚠️ 일봉 근사의 한계 — 이 수치를 실전 기대치로 읽지 말 것')
  log('· **실제 체결 순서를 알 수 없다.** 일봉에는 장중 경로가 없어서 "고가가 돌파가에 닿았다"만 알고')
  log('  언제 닿았는지·그 가격에 체결됐는지(호가 잔량·상한가 잠김)는 알 수 없다. 체결 가정이 낙관적이면')
  log('  성적은 통째로 허수가 된다. 이 계열은 분봉으로 재검증하기 전에는 채택 후보로도 올리지 않는다.')
  log('· 갭 관통 보수 처리: 시가가 이미 돌파가 위면 **시가(더 불리한 쪽)** 로 체결했다(규칙 1-4).')
  log('  다만 돌파가를 당일 시가 기준으로 잡는 정의에서는 이 경우가 전일 레인지 0일 때뿐이라,')
  log('  실제로는 전일 레인지 0을 후보에서 제외해 그 구간을 아예 만들지 않았다.')
  log('· 당일 종가 청산 변형에는 **손절이 없다** — 진입가 아래로 흘러도 종가까지 들고 간다.')
  log('  일봉으로는 장중 손절 체결가를 알 수 없어 넣지 않았다(넣으면 유리한 쪽 가정이 된다).')
  log('· 회전율이 극단적으로 높아 비용이 성적을 지배한다 — 왕복 1회에 매수 슬리피지 0.1% + 매수 수수료 0.015%')
  log('  + 매도 슬리피지 0.1% + 매도 수수료 0.015% + 거래세 0.15% = **약 0.38%**가 나간다. 매매수와 승률을')
  log('  같이 보고, 승률이 높아도 총수익이 안 나오면 비용이 먹은 것이다.')
  unverifiedNote()
  disclaimer()
}

// ============================================================================
// MODE=rsirev — 단기 평균회귀 (RSI2 · Wilder) + 200일선 추세 필터
// ============================================================================
//
// RSI(2) < 10 이면서 종가가 200일선 위(장기 추세 안에 있는 눌림)일 때 D+1 시가 매수,
// RSI(2) > 60 또는 5거래일 경과 시 D+1 시가 청산. 추세 지표를 필터로만 쓰고 진입 신호는
// 평균회귀라 이평 돌파 계열과 성격이 반대다.

const rsiFrom = (avgGain: number, avgLoss: number) =>
  avgLoss === 0 ? (avgGain === 0 ? 50 : 100) : 100 - 100 / (1 + avgGain / avgLoss)

/**
 * Wilder RSI. 첫 `period`개 변화량의 단순평균으로 시드하고 이후 Wilder 평활
 * (avg = (avg×(period−1) + 오늘값) / period)로 이어간다.
 *
 * 인덱스 i의 값은 `bars[0..i]`만으로 결정된다 — 재귀가 앞에서 뒤로만 흐르므로
 * **뒤를 잘라내도 앞의 값이 바뀌지 않는다**(절단 불변). 엔진의 `rsi()`는 단순평균
 * 방식이라 값이 다르다. 여기서는 지시대로 Wilder를 쓰므로 별도 함수로 둔다.
 */
export function wilderRsi(bars: DailyBar[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(bars.length).fill(null)
  if (period <= 0 || bars.length <= period) return out
  let g = 0
  let l = 0
  for (let i = 1; i <= period; i++) {
    const dv = bars[i].c - bars[i - 1].c
    if (dv > 0) g += dv
    else l -= dv
  }
  let ag = g / period
  let al = l / period
  out[period] = rsiFrom(ag, al)
  for (let i = period + 1; i < bars.length; i++) {
    const dv = bars[i].c - bars[i - 1].c
    ag = (ag * (period - 1) + Math.max(0, dv)) / period
    al = (al * (period - 1) + Math.max(0, -dv)) / period
    out[i] = rsiFrom(ag, al)
  }
  return out
}

export interface RsiRevOpts {
  slots: number
  period: number
  /** 진입 임계 — RSI(2)가 이 값 **미만** */
  lowThr: number
  /** 청산 임계 — RSI(2)가 이 값 **초과** */
  highThr: number
  /** 최대 보유 거래일 — 진입 체결일로부터 이만큼 지나면 강제 청산 신호 */
  maxHold: number
  /** 추세 필터 이동평균 기간. 0이면 필터 없음(A/B용). */
  trendMa: number
}

export const RSIREV_DEFAULT: RsiRevOpts = {
  slots: MAX_POSITIONS,
  period: 2,
  lowThr: 10,
  highThr: 60,
  maxHold: 5,
  trendMa: 200,
}

/**
 * 신호는 **당일 종가**, 체결은 **다음 거래일 시가**(규칙 1-2 규칙형). 마지막 봉에서는
 * 신규 신호를 만들지 않는다(규칙 1-6). 슬롯 초과 시 RSI가 낮은(더 과매도) 순으로 채운다.
 */
export function simulateRsiRevYear(
  histories: Record<string, DailyBar[]>,
  startDate: string,
  symbols: string[],
  cost: CostSettings,
  opts: RsiRevOpts,
): CustomYearRun {
  const { universe, calendar, idxOf } = makeSimCtx(histories, symbols, startDate)
  const rsiOf: Record<string, (number | null)[]> = {}
  for (const s of universe) rsiOf[s] = wilderRsi(histories[s], opts.period)
  const book = newBook(cost.initialCapital)
  const equity: { date: string; equity: number }[] = []
  const fills: FillEvent[] = []
  const closeAt = (date: string) => (s: string) => {
    const bi = idxOf[s]?.get(date)
    return bi != null ? histories[s][bi].c : null
  }
  let pendingBuys: { sym: string; key: number }[] = []
  let pendingSells: string[] = []
  /** 대기 주문을 만든 신호일(그날 **종가**로 판정했다) */
  let signalDate = ''

  for (let d = 0; d < calendar.length; d++) {
    const date = calendar[d]
    const isLast = d === calendar.length - 1

    // ---- 1) 어제 종가 신호 → 오늘 시가 청산 (먼저 슬롯을 비운다) --------------
    for (const s of pendingSells) {
      const p = book.positions.get(s)
      if (!p) continue
      const bi = idxOf[s].get(date)
      if (bi == null) continue // 봉이 없으면 못 판다 — 다음 봉에서 다시 신호가 잡힌다
      const px = histories[s][bi].o
      const q = bookSell(book, cost, s, px, p.qty)
      if (q > 0) fills.push({ date, sym: s, side: 'sell', px, qty: q, signalDate })
    }
    pendingSells = []

    // ---- 2) 어제 종가 신호 → 오늘 시가 매수 ---------------------------------
    for (const cand of pendingBuys) {
      if (book.positions.size >= opts.slots) break
      if (book.positions.has(cand.sym)) continue
      const bi = idxOf[cand.sym].get(date)
      if (bi == null) continue
      const slot = book.cash / Math.max(1, opts.slots - book.positions.size)
      const px = histories[cand.sym][bi].o
      const q = bookBuy(book, cost, cand.sym, px, slot, d)
      if (q > 0) fills.push({ date, sym: cand.sym, side: 'buy', px, qty: q, signalDate })
    }
    pendingBuys = []

    // ---- 3) 종가 마킹 --------------------------------------------------------
    equity.push({ date, equity: bookMark(book, closeAt(date)) })

    // ---- 4) 오늘 종가로 내일 신호 (마지막 봉이면 만들지 않는다) ---------------
    if (isLast) continue
    for (const [s, p] of book.positions) {
      const bi = idxOf[s].get(date)
      if (bi == null) continue
      const r = rsiOf[s][bi]
      if ((r != null && r > opts.highThr) || d - p.entryIdx >= opts.maxHold) pendingSells.push(s)
    }
    const cands: { sym: string; key: number }[] = []
    for (const s of universe) {
      if (book.positions.has(s)) continue
      const bi = idxOf[s].get(date)
      if (bi == null) continue
      const r = rsiOf[s][bi]
      if (r == null || !(r < opts.lowThr)) continue
      if (opts.trendMa > 0) {
        const ma = sma(histories[s], bi, opts.trendMa)
        if (ma == null || !(histories[s][bi].c > ma)) continue
      }
      cands.push({ sym: s, key: r })
    }
    cands.sort((x, y) => (x.key !== y.key ? x.key - y.key : x.sym < y.sym ? -1 : x.sym > y.sym ? 1 : 0))
    pendingBuys = cands
    signalDate = date
  }
  return { equity, closed: book.closed, wins: book.wins, openAtEnd: book.positions.size, fills }
}

async function rsirev() {
  log('# MODE=rsirev — 단기 평균회귀 (RSI2 · Wilder)')
  log('')
  log('RSI(2) < 10 **그리고** 종가가 200일선 위일 때 다음 거래일 **시가** 매수 →')
  log('RSI(2) > 60 또는 5거래일 경과 시 다음 거래일 **시가** 청산. 추세 돌파와 부호가 반대인 접근이다.')
  log('')
  const { years, histories, bench } = await loadPitHistories()
  const yearly = buildYearly(histories, years)
  if (yearly.every((v) => v.syms.length < 5)) {
    log('❌ 시세 로드 실패로 실행할 해가 없다 — 중단')
    return
  }
  const benchEq = benchCurve(bench)
  log(`연도별 매핑률: ${yearly.map((v) => `${v.y} ${v.mapped}`).join(' · ')}`)
  log(`슬롯 ${MAX_POSITIONS} · 후보 초과 시 RSI 낮은 순 · 벤치 ${BENCH} 시작 ${bench[0]?.date ?? '—'}`)

  const variants: { label: string; opts: RsiRevOpts }[] = [
    { label: 'RSI2<10 · 200일선 위 (본안)', opts: RSIREV_DEFAULT },
    { label: 'RSI2<5 · 200일선 위 (민감도)', opts: { ...RSIREV_DEFAULT, lowThr: 5 } },
    { label: 'RSI2<15 · 200일선 위 (민감도)', opts: { ...RSIREV_DEFAULT, lowThr: 15 } },
    { label: 'RSI2<10 · 추세필터 없음 (A/B)', opts: { ...RSIREV_DEFAULT, trendMa: 0 } },
  ]

  const rows: StratRow[] = []
  rows.push(summarizeStrat(BASELINE_LABEL, runSpecChain(yearly, baselineSpec, COST), benchEq))
  for (const v of variants) {
    const chain = runCustomChain(
      yearly,
      (ys) => simulateRsiRevYear(ys.hist, `${ys.y}-01-01`, ys.syms, COST, v.opts),
      COST,
      v.opts.slots,
    )
    rows.push(summarizeStrat(v.label, chain, benchEq))
  }

  log('')
  log('## 성적 (기준선을 같은 유니버스·같은 비용으로 재실행한 값과 나란히)')
  stratTable(rows)
  baselineCrossCheck(yearly)
  const winners = verdictTable(rows)
  perYearTable(rows)
  multipleTestingNote(rows.length - 1, winners)

  log('')
  log('## 이 실험의 구조적 한계')
  log('· RSI(2)는 Wilder 평활이며 **당일 종가까지만** 쓴다. 신호(D 종가)와 체결(D+1 시가)이 분리돼 있어')
  log('  갭 오픈이 성적을 크게 흔든다 — 과매도 다음날 갭하락으로 시작하면 그 손실을 그대로 먹는다.')
  log('· 평균회귀는 승률이 높고 손실이 꼬리에 몰리는 구조다. **승률이 높다고 좋은 전략이 아니다** —')
  log('  MDD·수익÷MDD를 같은 무게로 본다. 2008·2020 같은 급락 구간에서 "싸 보이는" 종목을 계속')
  log('  받아내다 크게 다치는 경로가 이 계열의 전형적 실패 방식이다.')
  log('· 임계값 3종(5/10/15)과 추세필터 A/B를 함께 돌렸다 — 그중 최고를 골라 읽으면 곡선맞춤이다.')
  log('· 5거래일 강제 청산은 진입 **체결일**로부터 센다(신호일이 아니다).')
  unverifiedNote()
  disclaimer()
}

// ============================================================================
// 검증 3종 공용 기반 (MODE=xswf · usxsmom · combo)
// ============================================================================
//
// 25차 실측에서 횡단면 모멘텀(12-1 · 상위5 + 절대모멘텀 게이트)이 기준선을 전·후반 모두
// 앞섰다. 좋아 보이는 결과가 나왔을 때 해야 할 일은 그것을 자랑하는 게 아니라 **깨지는지
// 두드려 보는 것**이다. 여기 세 모드가 그 세 가지 두드림이다.
//
//   xswf    — 파라미터 5가 고원인가 뾰족한 봉우리인가(민감도) + "그때 골랐을 파라미터"로
//             굴렸어도 성적이 남는가(워크포워드 OOS). 사후에 고른 5의 이득을 벗겨낸다.
//   usxsmom — 같은 규칙을 미국 시장에 그대로 옮겼을 때도 알파가 남는가. 24차에서 추세돌파는
//             미국에서 전패했다 — 그 역질문이다.
//   combo   — 기준선과 xsmom을 반반 섞으면 낙폭이 줄어드는가(두 슬리브 상관계수 포함).
//
// ── 규칙 1(미래참조 금지) 준수 ─────────────────────────────────────────────
//   · 워크포워드 선택은 **그 해 1월 1일 이전에 끝난 해들**의 누적 성적만 본다. 선택 대상
//     연도(그리고 그 이후)의 성적은 선택식에 들어가지 않는다 — `wfPick`이 `y < year`로
//     자른다. 학습 표본이 최소 연수에 못 미치면 사후지식 없이 기본값을 쓴다.
//   · 결합(combo)은 **당일까지 확정된 두 곡선의 일수익률**만 합성하고, 월 첫 거래일에
//     날짜만 보고 가중을 되돌린다. 미래 수익률을 보고 가중을 고르지 않는다.
//   · 환율 환산은 **직전(포함) 환율 이월**만 한다 — 결측일에 다음 환율을 당겨오면
//     그 자체가 미래참조다(`valueAsOf`는 과거 방향으로만 탐색한다).
//   · 집행자는 `tests/idealab.test.ts`의 워크포워드 불변성·결합 산술·절단 불변성 케이스다.
//
// ⚠️ 메모리: 후보별로 **연도별 상대곡선**만 들고 있고(그 해 시작=1.0), 표에 남기는 것은
//    요약 스칼라다. 조합 수만큼 전체 매매이력을 쌓지 않는다(2026-08-02 OOM 재발 방지).

/** 곡선에서 `date` **이하** 마지막 값. 없으면 null. 이월은 과거 방향으로만 한다(규칙 1). */
export function valueAsOf(curve: { date: string; equity: number }[], date: string): number | null {
  let lo = 0
  let hi = curve.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (curve[mid].date <= date) lo = mid + 1
    else hi = mid
  }
  return lo > 0 ? curve[lo - 1].equity : null
}

/** 곡선의 [시작일, 종료일]. 빈 곡선이면 빈 문자열. */
export function spanOf(curve: { date: string; equity: number }[]): [string, string] {
  return curve.length ? [curve[0].date, curve[curve.length - 1].date] : ['', '']
}

/**
 * 두 곡선을 **겹치는 구간**의 날짜 합집합으로 정렬한다. 한쪽에 봉이 없는 날은 그 곡선의
 * 직전 값을 이월한다(= 그날 수익률 0). 겹치지 않는 구간은 애초에 비교가 성립하지 않으므로
 * 버린다 — 한쪽만 있는 구간을 넣으면 그 구간이 통째로 그 곡선의 성적이 된다.
 */
export function alignCurves(
  a: { date: string; equity: number }[],
  b: { date: string; equity: number }[],
): { dates: string[]; ea: number[]; eb: number[] } {
  if (a.length < 1 || b.length < 1) return { dates: [], ea: [], eb: [] }
  const start = a[0].date > b[0].date ? a[0].date : b[0].date
  const end = a[a.length - 1].date < b[b.length - 1].date ? a[a.length - 1].date : b[b.length - 1].date
  if (start > end) return { dates: [], ea: [], eb: [] }
  const set = new Set<string>()
  for (const p of a) if (p.date >= start && p.date <= end) set.add(p.date)
  for (const p of b) if (p.date >= start && p.date <= end) set.add(p.date)
  const dates = [...set].sort()
  const ea: number[] = []
  const eb: number[] = []
  for (const d of dates) {
    ea.push(valueAsOf(a, d)!)
    eb.push(valueAsOf(b, d)!)
  }
  return { dates, ea, eb }
}

/**
 * 두 슬리브를 가중 `wA : 1−wA`로 섞되 **월 첫 거래일에 가중을 되돌린다**.
 * 달 안에서는 각 슬리브가 제 수익률대로 표류하고, 달이 바뀌는 첫 거래일 **시작 시점에**
 * 총자산을 다시 wA:1−wA로 나눈다. 리밸런스 판단에 쓰는 정보는 **날짜뿐**이라
 * 미래참조가 원천적으로 불가능하다.
 * 반환 곡선은 시작 1.0 배수다.
 */
export function blendMonthlyRebalanced(dates: string[], ea: number[], eb: number[], wA: number): number[] {
  if (dates.length < 1) return []
  let vA = wA
  let vB = 1 - wA
  let curYm = ymOf(dates[0])
  const out: number[] = [vA + vB]
  for (let i = 1; i < dates.length; i++) {
    const ym = ymOf(dates[i])
    if (ym !== curYm) {
      curYm = ym
      const v = vA + vB
      vA = v * wA
      vB = v * (1 - wA)
    }
    const ra = ea[i - 1] > 0 ? ea[i] / ea[i - 1] : 1
    const rb = eb[i - 1] > 0 ? eb[i] / eb[i - 1] : 1
    vA *= ra
    vB *= rb
    out.push(vA + vB)
  }
  return out
}

/** 두 곡선의 월 가중 결합 — `alignCurves` + `blendMonthlyRebalanced` 묶음. */
export function blendCurves(
  a: { date: string; equity: number }[],
  b: { date: string; equity: number }[],
  wA: number,
): { date: string; equity: number }[] {
  const { dates, ea, eb } = alignCurves(a, b)
  const v = blendMonthlyRebalanced(dates, ea, eb, wA)
  return dates.map((date, i) => ({ date, equity: v[i] }))
}

/** 월별 수익률(종가→종가, 달 마지막 값 기준). key `YYYY-MM`. */
export function monthlyReturnsOf(curve: { date: string; equity: number }[]): Map<string, number> {
  const last = new Map<string, number>()
  for (const p of curve) last.set(ymOf(p.date), p.equity)
  const keys = [...last.keys()].sort()
  const out = new Map<string, number>()
  for (let i = 1; i < keys.length; i++) {
    const prev = last.get(keys[i - 1])!
    const cur = last.get(keys[i])!
    if (prev > 0) out.set(keys[i], cur / prev - 1)
  }
  return out
}

/** 피어슨 상관계수. 표본 3 미만이거나 한쪽이 상수면 null. */
export function pearson(xs: number[], ys: number[]): number | null {
  const n = Math.min(xs.length, ys.length)
  if (n < 3) return null
  let mx = 0
  let my = 0
  for (let i = 0; i < n; i++) {
    mx += xs[i]
    my += ys[i]
  }
  mx /= n
  my /= n
  let sxy = 0
  let sxx = 0
  let syy = 0
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx
    const dy = ys[i] - my
    sxy += dx * dy
    sxx += dx * dx
    syy += dy * dy
  }
  if (!(sxx > 0) || !(syy > 0)) return null
  return sxy / Math.sqrt(sxx * syy)
}

/** 두 곡선의 **공통 월**에서만 월수익률 상관을 잰다. */
export function monthlyCorrelation(
  a: { date: string; equity: number }[],
  b: { date: string; equity: number }[],
): { r: number | null; n: number } {
  const ma = monthlyReturnsOf(a)
  const mb = monthlyReturnsOf(b)
  const xs: number[] = []
  const ys: number[] = []
  for (const [k, v] of ma) {
    const w = mb.get(k)
    if (w == null) continue
    xs.push(v)
    ys.push(w)
  }
  return { r: pearson(xs, ys), n: xs.length }
}

/** 그 해 **연초 대비 고점 기준** 최대 낙폭(%, 음수). 해당 연도 점이 2개 미만이면 null. */
export function yearMaxDrawdown(curve: { date: string; equity: number }[], year: number): number | null {
  const win = curve.filter((p) => yearOf(p.date) === year)
  if (win.length < 2) return null
  let peak = win[0].equity
  let mdd = 0
  for (const p of win) {
    if (p.equity > peak) peak = p.equity
    else mdd = Math.min(mdd, (p.equity / peak - 1) * 100)
  }
  return mdd
}

/** 연도별 수익비(그 해 마지막 값 ÷ 직전 해 마지막 값). 점이 없는 해는 1(현금). */
export function perYearOfCurve(
  curve: { date: string; equity: number }[],
  years: number[],
): { y: number; ret: number; mapped: string }[] {
  return years.map((y) => {
    const end = valueAsOf(curve, `${y}-12-31`)
    const prev = valueAsOf(curve, `${y - 1}-12-31`) ?? (curve.length ? curve[0].equity : null)
    const has = curve.some((p) => yearOf(p.date) === y)
    if (!has || end == null || prev == null || !(prev > 0)) return { y, ret: 1, mapped: '' }
    return { y, ret: end / prev, mapped: '' }
  })
}

/** 임의의 자산곡선을 `StratRow`로 접는다(매매 집계가 없는 결합·벤치 곡선용). */
export function curveStrat(
  label: string,
  equity: { date: string; equity: number }[],
  benchEq: { date: string; equity: number }[],
  years: number[],
  halfYear = HALF_YEAR,
): StratRow {
  return summarizeStrat(
    label,
    { equity, perYear: perYearOfCurve(equity, years), closed: 0, wins: 0 },
    benchEq,
    halfYear,
  )
}

/** 단순보유 비교 행. 전략 연쇄와 **같은 구간**으로 잘라 계산한다. */
export interface HoldRow {
  label: string
  curve: { date: string; equity: number }[]
  note?: string
}

export function holdTable(title: string, rows: HoldRow[], from: string, to: string) {
  log('')
  log(`## ${title}`)
  log(`비교 구간 ${from} ~ ${to} — 전략 연쇄와 겹치는 구간에서만 자른다.`)
  log('"실제 구간"이 더 짧으면 그 벤치의 데이터가 늦게 시작한 것이며, 그만큼 직접 비교가 약해진다.')
  log('| 비교 대상 | 총수익 | CAGR | MDD | 수익÷MDD | 실제 구간 | 비고 |')
  log('|---|---|---|---|---|---|---|')
  for (const r of rows) {
    const w = r.curve.filter((e) => e.date >= from && e.date <= to)
    if (w.length < 2) {
      log(`| ${r.label} | — | — | — | — | 데이터 없음 | ${r.note ?? ''} |`)
      continue
    }
    const p = perfOf(w)
    log(
      `| ${r.label} | ${f1(p.total)}% | ${f1(p.cagr)}% | ${f1(p.mdd)}% | ${p.obj?.toFixed(1) ?? '—'} | ` +
        `${w[0].date}~${w[w.length - 1].date} | ${r.note ?? ''} |`,
    )
  }
}

// ---- QQQ 원화 환산 벤치 (2026-08-02 대표 추가 지시) ---------------------------
//
// 대표 지시: "벤치 비교에 KODEX 200만 말고 QQQ도 넣어라."
// QQQ는 달러 자산이라 원화 성적과 그대로 비교하면 환율 변동분이 통째로 빠진다.
// 그래서 KR 모드에서는 **QQQ(총수익 보정) × 원/달러 종가**로 원화 곡선을 만들어 비교한다.
// 환율 결측일은 **직전 환율 이월**이다(다음 환율을 당겨오면 미래참조).
//
// ⚠️ 알파 판정 벤치는 바뀌지 않는다 — KR은 KODEX 200, US는 SPY다(규칙 5).
//    QQQ는 "그 돈으로 나스닥100을 사서 들고 있었으면?"을 보여주는 **참고 행**이다.

/** 달러 곡선(총수익 보정 봉) × 환율 = 원화 곡선. 환율이 아직 없는 앞 구간은 버린다. */
export function toKrwCurve(usd: DailyBar[], fx: DailyBar[]): { date: string; equity: number }[] {
  const fxCurve = fx.filter((b) => b.c > 0).map((b) => ({ date: b.date, equity: b.c }))
  const out: { date: string; equity: number }[] = []
  for (const b of usd) {
    if (!(b.c > 0)) continue
    const rate = valueAsOf(fxCurve, b.date) // 그 날짜 이하 마지막 환율 = 직전 이월
    if (rate == null || !(rate > 0)) continue
    out.push({ date: b.date, equity: b.c * rate })
  }
  return out
}

export const FX_KRW = 'KRW=X'
export const FX_NOTE = '환산: Yahoo KRW=X 종가 기준 · 결측일은 직전 환율 이월'

/** QQQ 원화 환산 보유 곡선. 로드 실패 시 null(비교 행만 생략하고 모드는 계속 돈다). */
async function loadQqqKrwCurve(range = 'since:1999-01-01'): Promise<HoldRow | null> {
  try {
    const qqq = await fetchDaily('QQQ', range)
    await sleep(120)
    const fx = await fetchDaily(FX_KRW, range)
    const curve = toKrwCurve(qqq, fx)
    if (curve.length < 2) {
      log(`⚠️ QQQ 원화 환산 실패 — 환율(${FX_KRW}) 구간이 겹치지 않는다. 비교 행 생략.`)
      return null
    }
    return {
      label: 'QQQ 원화 환산 보유 [참고]',
      curve,
      note: `${FX_NOTE} · QQQ ${qqq.length}봉 / 환율 ${fx.length}봉`,
    }
  } catch (e) {
    log(`⚠️ QQQ·환율 로드 실패 — 비교 행 생략 (${String(e)})`)
    return null
  }
}

/** 달러 그대로의 QQQ 보유 곡선(미장 모드용 — 같은 통화라 환산 불필요). */
async function loadQqqUsdCurve(range = 'since:1999-01-01'): Promise<HoldRow | null> {
  try {
    const qqq = await fetchDaily('QQQ', range)
    if (qqq.length < 2) return null
    return { label: 'QQQ 보유 (USD) [참고]', curve: benchCurve(qqq), note: '총수익 보정(adjclose 계수) · 환율 미반영' }
  } catch (e) {
    log(`⚠️ QQQ 로드 실패 — 비교 행 생략 (${String(e)})`)
    return null
  }
}

// ============================================================================
// MODE=xswf — 워크포워드 + 슬롯 민감도
// ============================================================================
//
// 25차에서 "상위 5 + 절대모멘텀 게이트"가 이겼다. 문제는 그 5가 **결과를 다 보고 고른 5**라는
// 점이다. 두 가지를 본다.
//
//   ① 슬롯 민감도 — N=3~8 × 게이트 on/off를 전 기간에 다 돌려 표로 편다. 5 옆의 4·6이 같이
//      좋으면 **고원**(파라미터가 아니라 현상이 있는 것), 5만 튀면 **뾰족한 봉우리**(잡음에
//      맞춘 것)다. 봉우리면 실전에서 5를 골랐을 리도 없고, 골랐어도 못 유지한다.
//   ② 워크포워드 — 매년 초에 **그때까지의 누적 성적(수익÷MDD)**으로 N∈{4,5,6}×게이트 중
//      하나를 골라 그 해에 쓴다. 최소 학습 5년, 그 전에는 기본값(5+게이트)이다. 이렇게 굴린
//      OOS 연쇄를 "사후에 고른 고정 5+게이트"·기준선과 나란히 놓는다. 둘의 격차가 곧
//      **사후선택 프리미엄**이며, 그게 크면 25차 성적의 상당 부분은 실전에서 못 얻는다.

/** 워크포워드 후보 — 25차 승자(5) 주변만 본다. 후보를 넓힐수록 선택 잡음이 커진다. */
export interface WfCand {
  slots: number
  gate: boolean
}
export const WF_CANDS: WfCand[] = [4, 5, 6].flatMap((slots) => [false, true].map((gate) => ({ slots, gate })))
export const WF_DEFAULT: WfCand = { slots: 5, gate: true }
export const WF_MIN_YEARS = 5
export const wfLabel = (c: WfCand) => `상위${c.slots}${c.gate ? '+게이트' : ''}`

/** 슬롯 민감도 격자 — 5가 고원인지 보려면 양옆이 넉넉해야 한다. */
export const SENS_SLOTS = [3, 4, 5, 6, 7, 8] as const

/**
 * 한 해의 상대 자산곡선. `rel`은 그 해 시작=1.0 배수이고, `endFactor`는 **연말 정산 근사
 * (미청산 비중 × 매도측 비용)까지 반영한** 그 해의 이월 배수다. `runCustomChain`이 쓰는
 * 계산과 같은 식이라, 전 연도를 이어붙이면 `runCustomChain`의 곡선과 점 단위로 일치한다.
 */
export interface YearCurve {
  y: number
  rel: { date: string; rel: number }[]
  endFactor: number
}

/** 후보 하나를 연도별 상대곡선으로 분해한다(연쇄 산술은 `runCustomChain`과 동일). */
export function yearCurvesOf(
  yearly: YearSlice[],
  runYear: (v: YearSlice) => CustomYearRun,
  cost: CostSettings,
  slots: number,
  applyHaircut = true,
): YearCurve[] {
  const out: YearCurve[] = []
  for (const v of yearly) {
    if (v.syms.length < 5) {
      out.push({ y: v.y, rel: [], endFactor: 1 })
      continue
    }
    const r = runYear(v)
    const rel = r.equity.map((e) => ({ date: e.date, rel: e.equity / cost.initialCapital }))
    const finalEq = r.equity.length ? r.equity[r.equity.length - 1].equity : cost.initialCapital
    const segRet = finalEq / cost.initialCapital
    const frac = applyHaircut ? Math.min(1, Math.max(0, r.openAtEnd / Math.max(1, slots))) : 0
    out.push({ y: v.y, rel, endFactor: segRet * (1 - frac * ((cost.feePct + cost.taxPct + cost.slippagePct) / 100)) })
  }
  return out
}

/** 연도별 상대곡선을 이어붙여 절대 곡선(시작 1.0)으로 만든다. */
export function stitchYears(curves: YearCurve[]): { date: string; equity: number }[] {
  let factor = 1
  const out: { date: string; equity: number }[] = []
  for (const c of curves) {
    const base = factor
    for (const p of c.rel) out.push({ date: p.date, equity: base * p.rel })
    factor = base * c.endFactor
  }
  return out
}

export type WfTable = { cand: WfCand; years: YearCurve[] }[]

/**
 * `year`에 쓸 후보를 고른다. **`y < year`인 해만** 본다 — 선택 대상 연도와 그 이후의
 * 성적은 어떤 형태로도 선택식에 들어가지 않는다(규칙 1). 점수는 누적 수익÷MDD다.
 * 학습 표본(실제로 매매가 있었던 해)이 `minYears` 미만이면 사후지식 없는 기본값을 쓴다.
 */
export function wfPick(
  table: WfTable,
  year: number,
  minYears = WF_MIN_YEARS,
  fallback = WF_DEFAULT,
): { pick: WfCand; score: number | null; trained: number } {
  if (table.length === 0) return { pick: fallback, score: null, trained: 0 }
  const trained = table[0].years.filter((c) => c.y < year && c.rel.length > 0).length
  if (trained < minYears) return { pick: fallback, score: null, trained }
  let best: WfCand | null = null
  let bestScore = Number.NEGATIVE_INFINITY
  for (const row of table) {
    const eq = stitchYears(row.years.filter((c) => c.y < year))
    const p = perfOf(eq)
    // MDD가 사실상 0인 구간은 나눗셈이 성립하지 않는다 — 부호로만 순서를 준다.
    const score = p.obj ?? (p.total > 0 ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY)
    if (score > bestScore) {
      bestScore = score
      best = row.cand
    }
  }
  return { pick: best ?? fallback, score: Number.isFinite(bestScore) ? bestScore : null, trained }
}

export interface WfPickRow {
  y: number
  pick: WfCand
  score: number | null
  trained: number
  ret: number
}

export interface WfResult {
  picks: WfPickRow[]
  equity: { date: string; equity: number }[]
  perYear: { y: number; ret: number; mapped: string }[]
}

/** 워크포워드 연쇄 — 해마다 `wfPick`이 고른 후보의 그 해 곡선만 이어붙인다. */
export function runWalkForward(
  table: WfTable,
  years: number[],
  minYears = WF_MIN_YEARS,
  fallback = WF_DEFAULT,
): WfResult {
  const picks: WfPickRow[] = []
  const equity: { date: string; equity: number }[] = []
  const perYear: { y: number; ret: number; mapped: string }[] = []
  let factor = 1
  for (const y of years) {
    const { pick, score, trained } = wfPick(table, y, minYears, fallback)
    const row = table.find((t) => t.cand.slots === pick.slots && t.cand.gate === pick.gate)
    const yc = row?.years.find((c) => c.y === y)
    const base = factor
    if (yc) {
      for (const p of yc.rel) equity.push({ date: p.date, equity: base * p.rel })
      factor = base * yc.endFactor
    }
    const ret = factor / base
    picks.push({ y, pick, score, trained, ret })
    perYear.push({ y, ret, mapped: '' })
  }
  return { picks, equity, perYear }
}

/**
 * "5가 고원인가 봉우리인가" 판정. `objs[idx]`가 중심(N=5)이고 양옆이 이웃이다.
 * 이웃 평균이 중심의 70% 이상이면 고원으로 본다 — 임계값 0.7은 자의적이며, 판정문에
 * 비율을 그대로 찍어 읽는 사람이 다시 판단할 수 있게 남긴다.
 */
export function plateauness(
  objs: (number | null)[],
  idx: number,
  ratioThreshold = 0.7,
): { ratio: number | null; verdict: string } {
  const center = objs[idx]
  const near = [objs[idx - 1], objs[idx + 1]].filter((v): v is number => v != null)
  if (center == null || !(center > 0) || near.length === 0)
    return { ratio: null, verdict: '판정 불가(중심 또는 이웃 값 없음)' }
  const mean = near.reduce((s, v) => s + v, 0) / near.length
  const ratio = mean / center
  return {
    ratio,
    verdict:
      ratio >= ratioThreshold
        ? '고원 — 이웃 슬롯도 비슷하게 좋다(파라미터가 아니라 현상일 가능성)'
        : '뾰족한 봉우리 — 이웃 슬롯이 급락한다(잡음에 맞춘 것일 가능성이 높다)',
  }
}

async function xswf() {
  log('# MODE=xswf — 횡단면 모멘텀 워크포워드 + 슬롯 민감도')
  log('')
  log('25차에서 "12-1 모멘텀 상위 5 + 절대모멘텀 게이트"가 기준선을 압도했다. 그 5는 **결과를 다 보고**')
  log('고른 값이다. 여기서는 ①옆 슬롯도 같이 좋은지(고원/봉우리) ②그때그때 골랐어도 성적이 남는지')
  log('(워크포워드 OOS)를 본다. 둘 다 못 넘기면 25차 성적은 실전에서 재현되지 않는다.')
  log('')
  const { years, histories, bench } = await loadPitHistories()
  const yearly = buildYearly(histories, years)
  if (yearly.every((v) => v.syms.length < 5)) {
    log('❌ 시세 로드 실패로 실행할 해가 없다 — 중단')
    return
  }
  const benchEq = benchCurve(bench)
  const qqqKrw = await loadQqqKrwCurve()
  log(`연도별 매핑률: ${yearly.map((v) => `${v.y} ${v.mapped}`).join(' · ')}`)
  log(`벤치 ${BENCH} 데이터 시작 ${bench[0]?.date ?? '—'} — 알파는 이 날짜 이후 겹치는 구간에서만 계산한다.`)

  // ---- 1) 슬롯 민감도 -------------------------------------------------------
  const baseChain = runSpecChain(yearly, baselineSpec, COST)
  const rows: StratRow[] = [summarizeStrat(BASELINE_LABEL, baseChain, benchEq)]
  const objByGate: Record<'off' | 'on', (number | null)[]> = { off: [], on: [] }
  for (const gate of [false, true]) {
    for (const slots of SENS_SLOTS) {
      // 변형별 자산곡선은 이 블록 안에서만 살아 있다 — 요약 후 즉시 회수된다(메모리)
      const chain = runCustomChain(
        yearly,
        (v) => simulateXsMomYear(v.hist, `${v.y}-01-01`, v.syms, COST, { slots, gate }),
        COST,
        slots,
      )
      const row = summarizeStrat(`XSM ${wfLabel({ slots, gate })}`, chain, benchEq)
      rows.push(row)
      objByGate[gate ? 'on' : 'off'].push(row.full.obj)
    }
  }

  log('')
  log('## 1) 슬롯 민감도 — N=3~8 × 게이트 on/off (전 기간)')
  stratTable(rows)
  baselineCrossCheck(yearly)

  log('')
  log('### 5는 고원인가 뾰족한 봉우리인가')
  log('| 게이트 | ' + SENS_SLOTS.map((n) => `N=${n}`).join(' | ') + ' | 5 대비 이웃(4·6) 평균 | 판정 |')
  log(`|---|${SENS_SLOTS.map(() => '---').join('|')}|---|---|`)
  const idx5 = SENS_SLOTS.indexOf(5)
  for (const g of ['off', 'on'] as const) {
    const objs = objByGate[g]
    const pl = plateauness(objs, idx5)
    log(
      `| ${g === 'on' ? '게이트 ON' : '게이트 OFF'} | ${objs.map((v) => v?.toFixed(1) ?? '—').join(' | ')} | ` +
        `${pl.ratio != null ? `${(pl.ratio * 100).toFixed(0)}%` : '—'} | ${pl.verdict} |`,
    )
  }
  log('(값은 **수익÷MDD**다. 5 옆이 같이 높으면 고원, 5만 솟아 있으면 그 5는 잡음에 맞춘 값이다.)')

  // ---- 2) 워크포워드 --------------------------------------------------------
  log('')
  log(`## 2) 워크포워드 — 매년 초 N∈{4,5,6}×게이트 중 **직전까지의 누적 수익÷MDD** 1위를 채택`)
  log(`선택은 그 해 1월 1일 **이전에 끝난 해들**만 본다. 학습 표본 ${WF_MIN_YEARS}년 미만인 초기에는`)
  log(`사후지식 없는 기본값(${wfLabel(WF_DEFAULT)})을 쓴다 — 초기 구간에 "이미 알고 있던 정답"을 넣지 않기 위해서다.`)

  const table: WfTable = WF_CANDS.map((cand) => ({
    cand,
    years: yearCurvesOf(
      yearly,
      (v) => simulateXsMomYear(v.hist, `${v.y}-01-01`, v.syms, COST, cand),
      COST,
      cand.slots,
    ),
  }))
  const wf = runWalkForward(table, years, WF_MIN_YEARS, WF_DEFAULT)
  const fixedRow = table.find((t) => t.cand.slots === WF_DEFAULT.slots && t.cand.gate === WF_DEFAULT.gate)!
  const fixedEq = stitchYears(fixedRow.years)

  const oosRows: StratRow[] = [
    summarizeStrat(BASELINE_LABEL, baseChain, benchEq),
    curveStrat(`고정 ${wfLabel(WF_DEFAULT)} (사후선택)`, fixedEq, benchEq, years),
    curveStrat(`워크포워드 OOS (최소학습 ${WF_MIN_YEARS}년)`, wf.equity, benchEq, years),
  ]
  log('')
  stratTable(oosRows)
  log('※ 고정·워크포워드 행의 "매매(청산완료)·승률"이 0/—인 것은 **매매가 없었다는 뜻이 아니다** —')
  log('  연도별 곡선만 남기고 매매 이력은 버리는 경로(메모리 보호)라 집계가 안 잡힌 것이다.')
  log(`  실제 매매수는 위 민감도 표의 같은 파라미터 행(XSM ${wfLabel(WF_DEFAULT)})에서 읽는다.`)

  const fixedP = oosRows[1].full
  const oosP = oosRows[2].full
  log('')
  log('### 사후선택 프리미엄')
  log(
    `고정 ${wfLabel(WF_DEFAULT)} CAGR ${f1(fixedP.cagr)}% vs 워크포워드 OOS CAGR ${f1(oosP.cagr)}% → ` +
      `차이 ${f1(fixedP.cagr - oosP.cagr)}%p.`,
  )
  log('이 차이가 "결과를 보고 5를 고른 덕"이다. 실전에서는 OOS 쪽이 실제로 손에 쥐었을 성적에 더 가깝다.')
  log('OOS가 기준선을 못 이기면, 25차의 승리는 파라미터 사후선택으로 상당 부분 설명된다.')

  log('')
  log('### 연도별 선택 이력 (그 해에 실제로 무엇을 골랐나)')
  log('| 연도 | 채택 | 학습 표본(년) | 선택 시점 누적 수익÷MDD | 그 해 수익 |')
  log('|---|---|---|---|---|')
  for (const p of wf.picks)
    log(
      `| ${p.y} | ${wfLabel(p.pick)}${p.trained < WF_MIN_YEARS ? ' (기본값)' : ''} | ${p.trained} | ` +
        `${p.score != null ? p.score.toFixed(1) : '—'} | ${f1((p.ret - 1) * 100)}% |`,
    )
  const switches = wf.picks.filter((p, i) => i > 0 && wfLabel(p.pick) !== wfLabel(wf.picks[i - 1].pick)).length
  log('')
  log(`파라미터 교체 횟수 ${switches}회 — 잦으면 선택 규칙 자체가 잡음을 쫓고 있다는 신호다.`)

  const [from, to] = spanOf(baseChain.equity)
  const holds: HoldRow[] = [{ label: `${BENCH} 보유 (KODEX 200 · 알파 판정 벤치)`, curve: benchEq, note: '총수익 보정' }]
  if (qqqKrw) holds.push(qqqKrw)
  holdTable('3) 단순보유 비교 행', holds, from, to)
  log('')
  log('⚠️ QQQ 행은 **참고**다. 알파(규칙 5) 판정 벤치는 국내 전략이므로 KODEX 200을 유지한다 —')
  log('   통화·시장·세제가 다른 자산을 판정 기준으로 바꾸면 "실력"과 "환율·시장 선택"이 뒤섞인다.')

  perYearTable(oosRows)
  const winners = verdictTable(rows)
  multipleTestingNote(rows.length - 1, winners)

  log('')
  log('## 이 실험의 구조적 한계')
  log(`· 워크포워드 후보가 ${WF_CANDS.length}개(N∈{4,5,6}×게이트)뿐이다. 후보를 25차 승자 주변으로 좁힌 것`)
  log('  자체가 약한 사후지식이다 — 진짜 OOS라면 2000년에 그 범위를 알 수 없었다. 여기 OOS 성적도')
  log('  그만큼은 낙관적으로 읽어야 한다.')
  log('· 선택 점수가 누적 수익÷MDD 하나뿐이라 초반 몇 해의 우연이 오래 남는다(고착). 교체 횟수를')
  log('  같이 보는 이유다.')
  log('· 연 단위 선택이라 그 해 안에서는 파라미터를 못 바꾼다. 실제 운용은 더 자주 흔들릴 수 있다.')
  log('· 민감도 표는 같은 데이터에 12개 변형을 돌린 결과다 — 그중 최고를 골라 읽는 순간 곡선맞춤이다.')
  unverifiedNote()
  disclaimer()
}

// ============================================================================
// MODE=usxsmom — 미장 교차 실행 (24차의 역질문)
// ============================================================================
//
// 24차에서 **추세돌파 계열은 미국에서 전패**했다(같은 조건식이 KR에서는 알파를 내고 US에서는
// 못 냈다). 그렇다면 역질문이 남는다 — **횡단면 모멘텀은 미국에서도 되는가?**
//   · 된다면: 25차 결과가 한국 표본 특유의 잡음이 아니라는 방증이 하나 붙는다.
//   · 안 된다면: 25차 성적은 "한국 대형주 20종목·26년"이라는 한 표본에만 있는 것이다.
// 어느 쪽이든 결론이 나오는 실험이라 돌릴 가치가 있다.
//
// 유니버스는 `src/features/backtest/usPitUniverse.ts`(그 해 시총 상위 20 [추정])를 **수정 없이**
// import한다. 비용은 MODE=uspit과 같은 값을 쓴다(수수료 0.1% · 매도 거래세 0 · 슬리피지 0.1%) —
// spec-backtest.entry.ts의 COST_US 정의를 그대로 옮긴 것이며 그 파일은 건드리지 않았다.

/** MODE=uspit의 COST_US 사본. 미국은 매도 거래세가 없다(KR 0.15% → 0). 수수료 0.1%는 [추정]. */
export const COST_US: CostSettings = { initialCapital: 10_000_000, feePct: 0.1, taxPct: 0, slippagePct: 0.1 }
export const BENCH_US = 'SPY'

/** 24차 미장 수익률 1위 추세 조합 — 미장 기준선으로 같은 유니버스에서 재실행한다. */
export const US_TREND = { ma: 10, hb: 20, xm: 80, buf: 2 } as const
export const US_TREND_LABEL = `미장 추세 기준선 MA${US_TREND.ma}×신고${US_TREND.hb}→${US_TREND.xm}선·버퍼${US_TREND.buf}%`

export function usTrendSpec(symbols: string[]): StrategySpec {
  return {
    version: SPEC_VERSION,
    id: 'idea-lab-us-trend',
    name: US_TREND_LABEL,
    source: '24차 uspit 수익률 1위',
    universe: {
      markets: ['KOSPI', 'KOSDAQ'], // symbols가 있으면 엔진이 markets를 쓰지 않는다(conditionScreen)
      excludeAdministrative: true,
      excludeSuspended: true,
      excludeLiquidation: true,
      excludePreferred: true,
      excludeEtf: true,
      symbols,
    },
    entry: {
      op: 'and',
      nodes: [
        c(`${US_TREND.ma}일선돌파`, { kind: 'maCross', period: US_TREND.ma, dir: 'above' }),
        c(`${US_TREND.hb}일신고가`, { kind: 'highBreak', days: US_TREND.hb }),
      ],
    },
    ranking: { by: 'tradingValue', dir: 'desc' },
    exits: [{ kind: 'maBreak', maPeriod: US_TREND.xm, pct: US_TREND.buf }],
    sizing: { maxPositions: MAX_POSITIONS, mode: 'equalSlot' },
    execution: { timing: 'sameClose', orderType: 'market' },
    regime: null,
  }
}

/**
 * 미국 연도별 유니버스 슬라이스. 그 시점 티커 → 조회 티커 매핑은 `resolveUsTicker`가 한다
 * (재사용 티커는 매핑 거부 = 정직한 실패). 그 해 6월 30일 이전 상장분만 편입하는 규칙은
 * KR `buildYearly`와 동일하게 맞춘다 — 두 시장 표를 나란히 읽으려면 규칙이 같아야 한다.
 */
export function buildYearlyUs(
  histories: Record<string, DailyBar[]>,
  years: number[],
  codesFor: (y: number) => string[] = usPitCodes,
): YearSlice[] {
  return years.map((y) => {
    const codes = codesFor(y)
    const syms: string[] = []
    for (const cd of codes) {
      const r = resolveUsTicker(cd, (s) => !!histories[s]?.length)
      if (!r) continue
      if ((histories[r][0]?.date ?? '9999') > `${y}-06-30`) continue
      if (!syms.includes(r)) syms.push(r)
    }
    const end = `${y}-12-31`
    const hist: Record<string, DailyBar[]> = {}
    for (const s of syms) hist[s] = histories[s].filter((b) => b.date <= end)
    return { y, syms, hist, mapped: `${syms.length}/${codes.length}` }
  })
}

async function loadUsPitHistories(range = 'since:1999-01-01', union: string[] = US_PIT_UNION) {
  const years = US_PIT_YEARS
  const histories: Record<string, DailyBar[]> = {}
  const failed: string[] = []
  for (const ticker of union) {
    try {
      const bars = await fetchDaily(ticker, range)
      if (bars.length >= 200) histories[ticker] = bars
      else failed.push(ticker)
    } catch {
      failed.push(ticker) // 상폐 티커는 Yahoo 404 — 정상적인 결과다
    }
    await sleep(120)
  }
  log(`시세 로드 ${Object.keys(histories).length}/${union.length} · 실패(상폐·데이터 부족) ${failed.length}`)
  if (failed.length) {
    const shown = failed.slice(0, 25).map((t) => `${t}(${US_COMPANY_NAMES[t]?.split(' —')[0] ?? '?'})`)
    log(`실패 티커: ${shown.join(', ')}${failed.length > 25 ? ` … 외 ${failed.length - 25}개` : ''}`)
    log('  ↑ 이들이 빠지는 것이 곧 잔존 생존편향이다 — 연도별 매핑률로 크기를 잰다.')
  }
  const bench = await fetchDaily(BENCH_US, range)
  return { years, histories, bench }
}

/**
 * 미장 xsmom 실험의 **유니버스 축**. 상위 20과 상위 80이 같은 판정 프레임을 공유하도록
 * 이것만 갈아끼운다 — 비용·벤치·분할연도·알파 판정·다중검정 경고는 전부 동일하다.
 * (유니버스 정의 자체는 `src/features/backtest/usPitUniverse.ts`가 정본이고 여기선 읽기만 한다.)
 */
export interface UsUniverseCfg {
  /** 그 해 목록의 종목 수(매핑률 분모 · 표 제목에 쓴다). */
  size: number
  codesFor: (y: number) => string[]
  /** 시세를 한 번만 받기 위한 조회용 합집합. */
  union: string[]
  sourceNote: string
}

export const US_UNI20: UsUniverseCfg = {
  size: 20,
  codesFor: usPitCodes,
  union: US_PIT_UNION,
  sourceNote: US_PIT_SOURCE_NOTE,
}
export const US_UNI80: UsUniverseCfg = {
  size: 80,
  codesFor: usPit80Codes,
  union: US_PIT80_UNION,
  sourceNote: US_PIT80_SOURCE_NOTE,
}

interface UsXsMomCfg {
  /** 첫 줄 제목(모드명 포함). */
  heading: string
  /** 제목 아래 도입 문단. */
  intro: string[]
  uni: UsUniverseCfg
  /** 돌릴 슬롯 수 목록. 각 슬롯 × 게이트 on/off = 변형 2개. */
  slotList: number[]
  /** 성적표 직후에 끼워 넣을 추가 해설(대조 문단 등). */
  afterTable?: (rows: StratRow[]) => void
  /** '이 실험의 구조적 한계' 항목. */
  limits: string[]
}

/**
 * MODE=usxsmom / usxsmom80 공용 실행부.
 *
 * ⚠️ 메모리(2026-08-02 OOM 재발 방지): 변형별로 남기는 것은 `summarizeStrat`가 접은
 *    **요약 스칼라(StratRow)**뿐이다. 자산곡선 배열은 `runCustomChain` → `summarizeStrat`
 *    구간에서만 살아 있고 루프를 나가면 버려진다. 변형 수만큼 곡선을 쌓지 않는다.
 *    시세도 유니온 기준으로 **한 번만** 받아 모든 해가 나눠 쓴다(기존 fetch 경로 그대로 —
 *    딜레이·재시도·404 처리를 새로 짜지 않는다).
 */
async function runUsXsMom(cfg: UsXsMomCfg) {
  log(cfg.heading)
  log('')
  for (const line of cfg.intro) log(line)
  log('')
  log(`⚠️ ${cfg.uni.sourceNote}`)
  log(
    `비용: 수수료 ${COST_US.feePct}% · 거래세 ${COST_US.taxPct}%(미국은 매도 거래세 없음) · ` +
      `슬리피지 ${COST_US.slippagePct}% [추정] — MODE=uspit과 같은 값이다.`,
  )
  log('⚠️ 환율 미반영 — 전 구간 USD 기준 수익률이다. 원화 환산 시 원/달러 변동이 그대로 더해진다.')
  log('')

  const { years, histories, bench } = await loadUsPitHistories('since:1999-01-01', cfg.uni.union)
  const yearly = buildYearlyUs(histories, years, cfg.uni.codesFor)
  if (yearly.every((v) => v.syms.length < 5)) {
    log('❌ 시세 로드 실패로 실행할 해가 없다 — 중단')
    return
  }
  const benchEq = benchCurve(bench)
  const qqqUsd = await loadQqqUsdCurve()
  log(`연도별 매핑률: ${yearly.map((v) => `${v.y} ${v.mapped}`).join(' · ')}`)
  log('매핑률이 100%가 아닌 만큼이 상폐·재사용 티커로 빠진 표본이다 — 그 구간 성적은 실제보다 후하다.')
  log(`벤치 ${BENCH_US} 데이터 시작 ${bench[0]?.date ?? '—'} — 알파는 이 날짜 이후 겹치는 구간에서만 계산한다.`)

  // 기준선(rows[0])은 **미장 추세 기준선**이다 — 판정은 "미장에서 추세 대비 모멘텀"이다.
  const trendChain = runSpecChain(yearly, usTrendSpec, COST_US)
  const rows: StratRow[] = [summarizeStrat(US_TREND_LABEL, trendChain, benchEq)]
  for (const slots of cfg.slotList) {
    for (const gate of [false, true]) {
      const chain = runCustomChain(
        yearly,
        (v) => simulateXsMomYear(v.hist, `${v.y}-01-01`, v.syms, COST_US, { slots, gate }),
        COST_US,
        slots,
      )
      rows.push(summarizeStrat(`XSM ${wfLabel({ slots, gate })}`, chain, benchEq))
    }
  }

  log('')
  log(`## 성적 (미국 연도별 상위${cfg.uni.size} 교체 유니버스 · 알파는 vs SPY)`)
  stratTable(rows)
  cfg.afterTable?.(rows)

  const [from, to] = spanOf(trendChain.equity)
  const holds: HoldRow[] = [
    { label: `${BENCH_US} 보유 (알파 판정 벤치)`, curve: benchEq, note: '총수익 보정(adjclose 계수)' },
  ]
  if (qqqUsd) holds.push(qqqUsd)
  holdTable('단순보유 비교 행 (같은 통화 — 환산 불필요)', holds, from, to)

  // ---- 판정: 미국에서 xsmom 알파가 양(+)인가 --------------------------------
  const xsRows = rows.slice(1)
  const posFull = xsRows.filter((r) => (r.alphaFull ?? -1) > 0)
  const posBoth = xsRows.filter((r) => (r.alphaA ?? -1) > 0 && (r.alphaB ?? -1) > 0)
  log('')
  log('## 판정 — 미국에서 횡단면 모멘텀 알파가 양(+)인가')
  log(`| 항목 | 결과 |`)
  log('|---|---|')
  log(`| 변형 수 | ${xsRows.length} |`)
  log(`| 전 구간 알파 > 0 | ${posFull.length}/${xsRows.length} (${posFull.map((r) => r.label).join(', ') || '없음'}) |`)
  log(`| 전·후반 **모두** 알파 > 0 | ${posBoth.length}/${xsRows.length} (${posBoth.map((r) => r.label).join(', ') || '없음'}) |`)
  log(
    `| 미장 추세 기준선 알파 | ${pctOrDash(rows[0].alphaFull)} (24차 "추세는 미국에서 전패" 재현 여부를 여기서 확인한다) |`,
  )
  log('')
  if (posBoth.length === 0) {
    log('→ **미국에서는 전·후반 모두 알파를 낸 변형이 없다.** 25차 한국 결과는 이 표본 밖으로')
    log('   넘어가지 않는다고 읽어야 한다 — 시장 교차 검증에서 떨어진 것이다.')
  } else {
    log(`→ **${posBoth.length}개 변형이 전·후반 모두 알파 양(+)이다.** 추세돌파가 미국에서 전패했던 것과 대비되며,`)
    log('   횡단면 모멘텀이 시장을 건너 살아남는다는 방증이 하나 붙는다. 다만 아래 한계를 함께 읽는다.')
  }

  const winners = verdictTable(rows)
  perYearTable(rows)
  multipleTestingNote(rows.length - 1, winners)

  log('')
  log('## 이 실험의 구조적 한계')
  for (const line of cfg.limits) log(line)
  log('· 비용 0.1%는 국내 증권사 해외주식 수수료 [추정]이며 환전 스프레드·최소수수료가 빠져 있다.')
  log('· 상폐 종목은 가격 부재로 빠진다 — 매핑률로 크기를 드러냈을 뿐 편향이 제거된 것은 아니다.')
  log('· 배당은 adjclose 계수로 OHLC에 반영했지만 **미국 배당세(원천징수 15%)는 반영하지 않았다** —')
  log('  실제 세후 수익은 이보다 낮다.')
  unverifiedNote()
  disclaimer({ segmentExit: true })
}

async function usxsmom() {
  await runUsXsMom({
    heading: '# MODE=usxsmom — 횡단면 모멘텀 미장 교차 실행 (24차의 역질문)',
    intro: [
      '24차에서 추세돌파 계열은 미국에서 전패했다. 같은 규칙을 미국 시총 상위20 [추정] 유니버스에',
      '그대로 옮겼을 때 **횡단면 모멘텀은 알파를 내는가**를 본다. 미국에서도 되면 25차 결과가',
      '한국 표본 특유의 잡음이 아니라는 방증이 되고, 안 되면 25차는 한 표본에만 있는 성적이다.',
    ],
    uni: US_UNI20,
    slotList: [4, 5, 6],
    limits: [
      '· 유니버스가 연 20종목이라 "상위 4~6"은 상위 20~30% 분위다. 학계의 상위 10% 분위 모멘텀보다',
      '  신호가 훨씬 묽다 — 알파가 안 나와도 "미국에서 모멘텀이 죽었다"가 아니라 "이 표본에서는',
      '  분위가 안 갈린다"일 수 있다.',
      '· 미국 대형주 상위 20은 서로 상관이 매우 높다(같은 지수·같은 매크로). 분산 효과가 작아',
      '  KR 결과와 직접 비교할 때 유니버스 성격 차이를 감안해야 한다.',
    ],
  })
}

// ============================================================================
// MODE=usxsmom80 — 같은 실험을 상위 80 유니버스로 (26차 한계의 직접 검증)
// ============================================================================
//
// 26차(MODE=usxsmom · 상위20)에서 12-1 횡단면 모멘텀 6변형이 **전부 알파 음수**였고,
// 그때 명시한 구조적 한계가 이것이었다 — "연 20종목이라 상위 4~6은 상위 20~30% 분위라
// 학계의 상위 10% 분위 모멘텀보다 신호가 묽다". 그 한계가 **원인이었는지**를 재는 실험이다.
//
//   유니버스를 80으로 넓히면 **상위 8 = 상위 10%** 로 학계 분위와 정합해진다.
//   · 알파가 살아나면: 26차의 음수 알파는 "미국에서 모멘텀이 안 먹힌다"가 아니라
//     **분위가 안 갈리는 유니버스** 탓이었다는 뜻이 된다.
//   · 그래도 음수면: 유니버스 폭은 원인이 아니었고, 미국 대형주 표본에서 12-1 모멘텀이
//     비용 차감 후 알파를 못 낸다는 쪽 증거가 하나 더 붙는다.
// 어느 쪽이든 결론이 나오므로 돌릴 가치가 있다(26차와 같은 판정 프레임을 그대로 쓴다).
//
// ⚠️ 슬롯을 4→16까지 넓힌 만큼 **변형 수가 8개로 늘었다** — 다중검정 경고를 26차보다
//    더 무겁게 읽어야 한다. "8개 중 하나가 좋았다"는 그 자체로는 증거가 아니다.

/** 26차(MODE=usxsmom · 상위20) 실측 요약 — 대조 문단에 그대로 인용한다. */
export const USXSMOM20_PRIOR = { variants: 6, positiveAlpha: 0, bestAlphaPp: -1.0 } as const

/** 학계 표준 분위(상위 10%)와 정합하는 슬롯 수 = 80 × 10%. */
export const DECILE_SLOTS = 8

async function usxsmom80() {
  await runUsXsMom({
    heading: '# MODE=usxsmom80 — 횡단면 모멘텀 미장 교차 실행 (유니버스 상위 80)',
    intro: [
      '26차(상위20)에서 12-1 횡단면 모멘텀은 6변형 전부 알파 음수였다. 그때 적어 둔 한계가',
      '"연 20종목이라 상위 4~6은 상위 20~30% 분위 — 학계의 상위 10% 분위보다 신호가 묽다"였다.',
      '**유니버스를 80으로 넓혀 분위를 갈랐을 때 알파가 사는가**가 이 실험의 질문이다.',
      `학계 분위와 정합한 슬롯은 **상위 ${DECILE_SLOTS}**(80 × 10%)이며, 나머지 슬롯(5·12·16)은`,
      '그 주변의 민감도를 보기 위한 행이다 — 최고 성적 슬롯을 골라 읽으라는 표가 아니다.',
    ],
    uni: US_UNI80,
    slotList: [5, DECILE_SLOTS, 12, 16],
    afterTable: (rows) => {
      const xs = rows.slice(1)
      const decile = xs.filter((r) => r.label.includes(`상위${DECILE_SLOTS}`))
      const pos = xs.filter((r) => (r.alphaFull ?? -1) > 0)
      log('')
      log('## 26차(상위20) 대조 — 유니버스를 넓히자 분위가 갈렸는가')
      log('| 실험 | 유니버스 | 변형 수 | 전 구간 알파 > 0 | 최고 알파 |')
      log('|---|---|---|---|---|')
      log(
        `| 26차 usxsmom | 상위 20 | ${USXSMOM20_PRIOR.variants} | ${USXSMOM20_PRIOR.positiveAlpha}개 | ` +
          `${f1(USXSMOM20_PRIOR.bestAlphaPp)}%p |`,
      )
      const best = xs.reduce<number | null>((m, r) => (r.alphaFull == null ? m : m == null || r.alphaFull > m ? r.alphaFull : m), null)
      log(`| 이번 usxsmom80 | 상위 80 | ${xs.length} | ${pos.length}개 | ${pctOrDash(best)} |`)
      log('')
      log(`**학계 분위와 정합한 슬롯은 ${DECILE_SLOTS}이다**(상위 80의 10%). 그 두 행(게이트 on/off)의 알파:`)
      for (const r of decile) log(`· ${r.label} — 전 구간 ${pctOrDash(r.alphaFull)} · 전반 ${pctOrDash(r.alphaA)} · 후반 ${pctOrDash(r.alphaB)}`)
      log('')
      if (pos.length === 0) {
        log('→ 유니버스를 4배로 넓혀 상위 10% 분위를 만들었는데도 **전 구간 알파가 양(+)인 변형이 없다.**')
        log('   26차의 "분위가 묽어서"라는 설명은 이 표본에서 지지되지 않는다 — 유니버스 폭이 아니라')
        log('   **미국 대형주에서 12-1 모멘텀 자체가 비용 차감 후 초과수익을 못 낸다**는 쪽으로 읽어야 한다.')
      } else {
        log(`→ 상위 80에서는 ${pos.length}개 변형이 전 구간 알파 양(+)이다. 26차와 갈린 지점이 유니버스 폭이라는`)
        log('   방증이 된다. 다만 **전·후반 모두** 양(+)인지(아래 판정)와 다중검정 경고를 함께 통과해야')
        log('   의미가 있다 — 전 구간 알파 하나만으로 채택하지 않는다.')
      }
    },
    limits: [
      `· 유니버스가 연 80종목이라 "상위 ${DECILE_SLOTS}"이 상위 10% 분위다(26차의 상위 20~30%보다 학계 표준에`,
      '  가깝다). 다만 **21~80위 목록의 [추정] 신뢰도는 상위 20보다 한 단계 낮다** — 순위 경계가 넓어',
      '  누락·오배치가 있을 수 있고 CRSP/Compustat와 대조하지 않았다. 유니버스가 틀리면 결과도 틀린다.',
      '· 넓힌 구간에는 상폐·피인수 종목(Enron·Lehman·Bear Stearns·Wachovia·Merrill·Warner-Lambert 등)이',
      '  더 많이 들어 있고, 그만큼 초기 연도의 매핑률이 상위 20보다 낮게 나온다 — 매핑률 표를 반드시 함께',
      '  읽는다. 낮은 매핑률 구간의 성적은 "살아남은 종목 위주"라 실제보다 후하다.',
      '· 미국 대형주는 상위 80까지 넓혀도 서로 상관이 높다(같은 지수·같은 매크로). 분위를 갈랐다고',
      '  분산까지 좋아지는 것은 아니다.',
      `· 변형이 ${2 * 4}개다(슬롯 4종 × 게이트 2). 26차(6개)보다 다중검정 위험이 크다 — 아래 경고를 그만큼`,
      '  무겁게 읽는다.',
    ],
  })
}

// ============================================================================
// MODE=combo — 기준선 + 횡단면 모멘텀 반반 결합
// ============================================================================
//
// 두 전략이 **서로 다른 때에 벌면** 섞었을 때 수익은 평균으로 가되 낙폭은 평균보다 줄어든다.
// 기준선(MA25×신고10→80선)은 추세 추종이고 xsmom(상위5+게이트)은 횡단면 랭킹이라 신호원이
// 다르다 — 실제로 상관이 낮은지, 낮다면 낙폭이 얼마나 완화되는지를 잰다.
//
// 결합 방식: 월 첫 거래일에 두 슬리브 가중을 목표치로 되돌리고, 달 안에서는 각자 표류한다.
// **일수익률 가중 합성**이라 미래참조가 들어갈 자리가 없다(가중 결정에 쓰는 정보는 날짜뿐).
// 리밸런스 비용은 반영하지 않았다 — 슬리브 간 이체를 0원으로 본 낙관적 가정이다(아래 한계).

export const COMBO_WEIGHTS = [0.75, 0.5, 0.25] as const
export const COMBO_XSMOM: WfCand = { slots: 5, gate: true }

async function combo() {
  log('# MODE=combo — 기준선 + 횡단면 모멘텀 반반 결합')
  log('')
  log(`슬리브 A = ${BASELINE_LABEL}(추세 추종) · 슬리브 B = XSM ${wfLabel(COMBO_XSMOM)}(횡단면 랭킹).`)
  log('월 첫 거래일에 두 슬리브 가중을 목표치로 되돌린다. 신호원이 다르면 수익은 평균으로 가되')
  log('낙폭은 평균보다 줄어야 한다 — 그게 결합의 유일한 존재 이유다. 안 줄면 섞을 이유가 없다.')
  log('')
  const { years, histories, bench } = await loadPitHistories()
  const yearly = buildYearly(histories, years)
  if (yearly.every((v) => v.syms.length < 5)) {
    log('❌ 시세 로드 실패로 실행할 해가 없다 — 중단')
    return
  }
  const benchEq = benchCurve(bench)
  const qqqKrw = await loadQqqKrwCurve()
  log(`연도별 매핑률: ${yearly.map((v) => `${v.y} ${v.mapped}`).join(' · ')}`)

  const chainA = runSpecChain(yearly, baselineSpec, COST)
  const chainB = runCustomChain(
    yearly,
    (v) => simulateXsMomYear(v.hist, `${v.y}-01-01`, v.syms, COST, COMBO_XSMOM),
    COST,
    COMBO_XSMOM.slots,
  )

  const rows: StratRow[] = [
    summarizeStrat(`A 단독 · ${BASELINE_LABEL}`, chainA, benchEq),
    summarizeStrat(`B 단독 · XSM ${wfLabel(COMBO_XSMOM)}`, chainB, benchEq),
  ]
  const blends = COMBO_WEIGHTS.map((wA) => ({
    wA,
    curve: blendCurves(chainA.equity, chainB.equity, wA),
  }))
  for (const b of blends)
    rows.push(
      curveStrat(
        `결합 A${(b.wA * 100).toFixed(0)}:B${((1 - b.wA) * 100).toFixed(0)}${b.wA === 0.5 ? ' ★' : ' [참고]'}`,
        b.curve,
        benchEq,
        years,
      ),
    )

  log('')
  log('## 성적 — 단독 vs 결합')
  stratTable(rows)
  log('(★ = 대표 지시 기본안 50:50. 25/75·75/25는 가중 민감도를 보기 위한 참고 행이다.)')
  log('※ 결합 행의 "매매·승률"이 0/—인 것은 매매가 없다는 뜻이 아니라, 결합이 **두 슬리브 곡선의**')
  log('  합성이라 매매 원장이 한쪽에 귀속되지 않기 때문이다. 매매수는 A·B 단독 행에서 읽는다.')

  // ---- 상관계수 -------------------------------------------------------------
  const { r, n } = monthlyCorrelation(chainA.equity, chainB.equity)
  log('')
  log('## 두 슬리브 월수익률 상관계수')
  log(`ρ = ${r != null ? r.toFixed(3) : '—'} (공통 월 ${n}개)`)
  if (r != null) {
    log(
      r < 0.3
        ? '→ 상관이 낮다. 신호원이 실제로 다르게 작동했다는 뜻이며, 결합의 낙폭 완화 효과가 클 조건이다.'
        : r < 0.7
          ? '→ 상관이 중간이다. 완화 효과는 있으나 제한적이다.'
          : '→ 상관이 높다. 사실상 같은 것을 두 번 사는 셈이라 섞는 이득이 거의 없다.',
    )
  }
  log('⚠️ 상관은 **평균적인 값**이다. 위기 구간에서는 대부분의 롱 전략 상관이 1에 붙는다 —')
  log('   정작 낙폭이 필요한 순간에 분산이 사라진다는 뜻이며, 아래 연도별 낙폭표에서 확인한다.')

  // ---- 낙폭 곡선 비교 -------------------------------------------------------
  const half = blends.find((b) => b.wA === 0.5)!
  const mddA = rows[0].full.mdd
  const mddB = rows[1].full.mdd
  const mddC = perfOf(half.curve).mdd
  const worstSolo = Math.min(mddA, mddB)
  log('')
  log('## 낙폭 완화 폭 (최심 MDD)')
  log('| 곡선 | 전 구간 MDD |')
  log('|---|---|')
  log(`| A 단독 | ${f1(mddA)}% |`)
  log(`| B 단독 | ${f1(mddB)}% |`)
  log(`| 결합 50:50 | ${f1(mddC)}% |`)
  log('')
  log(
    `더 깊었던 단독(${f1(worstSolo)}%) 대비 결합의 완화 폭 = ${f1(mddC - worstSolo)}%p · ` +
      `두 단독 평균(${f1((mddA + mddB) / 2)}%) 대비 = ${f1(mddC - (mddA + mddB) / 2)}%p.`,
  )
  log('두 단독 **평균보다** 얕아야 진짜 분산 효과다. 단순히 더 깊은 쪽보다 얕은 것은')
  log('"덜 나쁜 쪽을 절반 섞었으니 당연한" 산술이라 분산의 증거가 아니다.')

  log('')
  log('### 연도별 최대 낙폭 (그 해 안의 고점 기준)')
  log('| 연도 | A 단독 | B 단독 | 결합 50:50 | 결합 − 두 단독 평균 |')
  log('|---|---|---|---|---|')
  for (const y of years) {
    const a = yearMaxDrawdown(chainA.equity, y)
    const b = yearMaxDrawdown(chainB.equity, y)
    const cmb = yearMaxDrawdown(half.curve, y)
    const gap = a != null && b != null && cmb != null ? f1(cmb - (a + b) / 2) : '—'
    if (a == null && b == null && cmb == null) continue
    log(
      `| ${y} | ${a != null ? `${f1(a)}%` : '—'} | ${b != null ? `${f1(b)}%` : '—'} | ` +
        `${cmb != null ? `${f1(cmb)}%` : '—'} | ${gap}%p |`,
    )
  }
  log('마지막 열이 음수인 해가 결합이 실제로 도움이 된 해다. 양수인 해가 섞여 있다면 그 해에는')
  log('두 슬리브가 같이 무너졌다는 뜻이다.')

  const [from, to] = spanOf(chainA.equity)
  const holds: HoldRow[] = [{ label: `${BENCH} 보유 (KODEX 200 · 알파 판정 벤치)`, curve: benchEq, note: '총수익 보정' }]
  if (qqqKrw) holds.push(qqqKrw)
  holdTable('단순보유 비교 행', holds, from, to)
  log('')
  log('⚠️ QQQ 행은 **참고**다. 알파(규칙 5) 판정 벤치는 KODEX 200을 유지한다.')

  perYearTable(rows)
  const winners = verdictTable(rows)
  multipleTestingNote(rows.length - 1, winners)

  log('')
  log('## 이 실험의 구조적 한계')
  log('· **리밸런스 비용 미반영.** 월마다 두 슬리브 사이에서 자금을 옮기려면 실제로는 한쪽을 팔고')
  log('  다른 쪽을 사야 한다(수수료·거래세·슬리피지). 그 비용을 0으로 본 낙관적 상한이며, 월 12회')
  log('  ×26년이면 누적 차이가 작지 않다.')
  log('· 두 슬리브를 **각각 전액 투자 기준**으로 돌린 뒤 곡선을 합성했다. 실제로는 자본을 반씩 나눠')
  log('  운용하므로 슬롯당 금액이 절반이 되고, 최소 주문 단위·단주 반올림에서 미세한 차이가 난다.')
  log('· 가중 3종(75/50/25)을 같이 돌렸다 — 그중 가장 좋아 보이는 가중을 골라 읽으면 그것도 곡선맞춤이다.')
  log('  기본안은 대표 지시대로 50:50이며, 나머지는 민감도 확인용이다.')
  log('· 상관계수는 전 구간 평균이라 위기 구간의 상관 급등을 감추지 못한다 — 연도별 낙폭표를 같이 본다.')
  unverifiedNote()
  disclaimer()
}

// ============================================================================
// MODE=overlay — 검증된 승자 위에 얹는 리스크 오버레이 4종
// ============================================================================
//
// 2026-08-02 대표 지시: "지금 프리셋에 있는 조건들을 좀 더 개선해서 수익률/MDD 수치
// 높일 수 없나?"
//
// 방침: **신규 계열을 더 파지 않는다.** 분자(수익)를 키우는 재탐색은 같은 데이터에
// 변형을 더 던지는 일이라 곡선맞춤 위험이 그대로 커진다. 대신 이미 25·26차에서 검증이
// 끝난 승자 두 개를 **베이스로 고정**하고, 분모(낙폭)를 깎는 오버레이만 얹는다.
//
//   B = XSM 상위5+게이트        (25차 승자 · 횡단면 모멘텀)
//   C = 결합 50:50 (기준선 + B) (26차 승자 · 낙폭 완화형)
//
// 베이스는 **손대지 않는다** — 파라미터를 다시 고르는 순간 "오버레이의 효과"와
// "재탐색의 이득"이 섞여 무엇이 개선했는지 알 수 없게 된다.
//
// ── 오버레이 4종 (총 변형 8개) ──────────────────────────────────────────────
//   1. 시장 레짐 게이트(듀얼 모멘텀) — 벤치 모멘텀이 꺾인 달은 B 슬리브 전체를 현금.
//      변형 2개: {12-1 모멘텀 음수, 10개월 이평 이탈}
//   2. 변동성 타게팅 — 전략 자체의 직전 60일 실현 변동성이 목표를 넘으면 노출을
//      목표/실현으로 축소. **상한 100%**(레버리지 금지). 목표 2개: {15%, 20%}
//   3. 월중 크래시 스톱 — 월초 시가 대비 −X% 이탈한 슬롯만 월말까지 현금. X 2개: {15%, 20%}
//   4. 결합 위험가중 — C의 50:50을 두 슬리브 6개월 실현 변동성 **역수 비례**로. 1개
//      + C의 B 슬리브에 1번 게이트를 얹은 변형 1개.
//
//   각 오버레이는 베이스 위에 **하나씩만** 얹는다(조합 폭발 금지 — 오버레이를 겹치면
//   변형 수가 곱으로 늘어 다중검정 위양성이 폭발한다).
//
// ── 판정 기준 (대표 지시 2026-08-02) ────────────────────────────────────────
//   ① **수익÷MDD가 베이스보다 개선** ② 전·후반 **모두 알파 양(+)** ③ CAGR 하락 폭 명시.
//   수익이 줄어도 비율이 크게 오르면 개선으로 본다 — 다만 **하락 폭을 숨기지 않는다.**
//
// ── 규칙 1(미래참조 금지) 준수 ─────────────────────────────────────────────
//   · 레짐 판정: 12-1은 리밸런스 달의 **한 달 전 1일 직전** 종가까지만, 10개월 이평은
//     리밸런스 달 **이전에 끝난** 달들의 월말 종가만 본다.
//   · 변동성 타게팅: 노출은 **베이스 곡선의 직전 60거래일**(리밸런스일 미만) 일수익률
//     표본표준편차로 정한다. 전 구간 표준편차를 쓰지 않는다(규칙 1-5).
//   · 결합 위험가중: 가중은 리밸런스일 **미만** 인덱스의 직전 126거래일 수익률만 본다.
//   · 크래시 스톱: 기준가는 그 달 시가, 판정은 그날 저가, 갭 관통은 **시가** 체결(규칙 1-4).
//   · 집행자는 `tests/overlay.test.ts`의 절단 불변성 + 창 경계 조작 케이스다.
//
// ⚠️ 메모리: 변형 곡선은 요약·위기연도 스칼라를 뽑는 즉시 버린다. 끝까지 들고 있는 곡선은
//    A·B·게이트B·C 넷뿐이다(2026-08-02 OOM 재발 방지).

/** 오버레이가 얹히는 승자 B — 26차 결합과 **같은** 파라미터를 쓴다(베이스 고정). */
export const OVERLAY_B: WfCand = COMBO_XSMOM
/** 변동성 타게팅 목표(연환산 %) */
export const OVL_VOL_TARGETS = [15, 20] as const
/** 변동성 타게팅 관측창(거래일) */
export const OVL_VOL_WIN = 60
/** 월중 크래시 스톱 폭(%) */
export const OVL_STOP_PCTS = [15, 20] as const
/** 결합 위험가중 관측창(거래일 ≈ 6개월) */
export const OVL_RP_WIN = 126
/** 10개월 이평 레짐의 월 수 */
export const OVL_MA_MONTHS = 10
/** 벤치 시작 이전 구간을 메우는 레짐 폴백 지수 — 코스피 종합 */
export const REGIME_FALLBACK = '^KS11'
/** 위기 연도 — 오버레이가 정확히 언제 도움이 됐는지 보는 구간 */
export const CRISIS_YEARS = [2008, 2020, 2022] as const

// ---- 곡선 유틸 ---------------------------------------------------------------

/** 곡선에서 `date` **미만**(strictly before)인 점의 개수 = 그 시점 확정 구간의 오른쪽 경계. */
export function curveIdxBefore(curve: { date: string; equity: number }[], date: string): number {
  let lo = 0
  let hi = curve.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (curve[mid].date < date) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** 곡선에서 `date` **미만** 마지막 값. 없으면 null. (`valueAsOf`는 이하 — 여기선 미만이 필요하다) */
export function valueBefore(curve: { date: string; equity: number }[], date: string): number | null {
  const n = curveIdxBefore(curve, date)
  return n > 0 ? curve[n - 1].equity : null
}

/** 월말 종가(그 달 마지막 값) 목록 — `ym` 오름차순. */
export function monthEndCloses(curve: { date: string; equity: number }[]): { ym: string; close: number }[] {
  const last = new Map<string, number>()
  for (const p of curve) last.set(ymOf(p.date), p.equity)
  return [...last.keys()].sort().map((ym) => ({ ym, close: last.get(ym)! }))
}

/**
 * 일수익률 표본표준편차 — `vals`의 인덱스 `end` **미만**만, 최대 `win`개 수익률.
 * 오른쪽 경계가 `end` 미만이라 판정일 당일 수익률은 들어가지 않는다(규칙 1).
 * 표본이 `minN` 미만이면 null(= 사후지식 없이 기본값을 쓰라는 신호).
 */
export function stdevReturns(vals: number[], end: number, win: number, minN = 20): number | null {
  const hi = Math.min(end, vals.length)
  const lo = Math.max(1, hi - win)
  const rets: number[] = []
  for (let i = lo; i < hi; i++) {
    const a = vals[i - 1]
    if (a > 0) rets.push(vals[i] / a - 1)
  }
  if (rets.length < minN) return null
  let mean = 0
  for (const r of rets) mean += r
  mean /= rets.length
  let v = 0
  for (const r of rets) v += (r - mean) * (r - mean)
  v /= rets.length - 1
  return Math.sqrt(v)
}

/** 연환산 실현 변동성(%). 거래일 252일 가정. 표본 부족이면 null. */
export function realizedVolPct(vals: number[], end: number, win: number): number | null {
  const sd = stdevReturns(vals, end, win)
  return sd == null ? null : sd * Math.sqrt(252) * 100
}

// ---- 오버레이 1: 시장 레짐 게이트 --------------------------------------------

/**
 * 벤치 시작 이전 구간을 폴백 지수로 메운 **연속** 레짐 시계열.
 * 두 지수의 레벨을 그냥 이어 붙이면 이음매에서 가짜 급등락이 생기므로, 앞 구간은
 * 폴백의 **수익률만** 쓰고 이음매 값을 벤치 첫 값에 맞춘다(이음매 하루 수익 = 0).
 * 폴백이 없거나 짧으면 벤치만 그대로 돌려준다.
 */
export function spliceRegimeCurve(primary: DailyBar[], fallback: DailyBar[]): { date: string; equity: number }[] {
  const p = primary.filter((b) => b.c > 0)
  const f = fallback.filter((b) => b.c > 0)
  if (p.length < 2) return f.map((b) => ({ date: b.date, equity: b.c }))
  if (f.length < 1) return p.map((b) => ({ date: b.date, equity: b.c }))
  const cut = p[0].date
  const head = f.filter((b) => b.date < cut)
  if (head.length < 2) return p.map((b) => ({ date: b.date, equity: b.c }))
  const scale = p[0].c / head[head.length - 1].c
  const out = head.map((b) => ({ date: b.date, equity: b.c * scale }))
  for (const b of p) out.push({ date: b.date, equity: b.c })
  return out
}

/**
 * 레짐 곡선의 12-1 모멘텀. `momentum12_1`과 **같은 창**이다(시작 = 12개월 전 달 1일 직전,
 * 끝 = 1개월 전 달 1일 직전). 두 기준일이 모두 `date`보다 과거라 미래참조가 불가능하다.
 */
export function regimeMom12_1(curve: { date: string; equity: number }[], date: string): number | null {
  const pe = valueBefore(curve, shiftMonthStart(date, -1))
  const ps = valueBefore(curve, shiftMonthStart(date, -12))
  if (pe == null || ps == null || !(ps > 0)) return null
  return pe / ps - 1
}

/**
 * 10개월 이평 레짐 — `date`가 속한 달 **이전에 끝난** 달들의 월말 종가만 본다.
 * 마지막 월말 종가 > 직전 10개 월말 평균이면 위험선호(true). 표본 부족이면 null.
 * 리밸런스 달의 진행 중인 월말은 아직 확정되지 않았으므로 창에서 뺀다(규칙 1-3와 같은 취지).
 */
export function regimeMaRiskOn(ends: { ym: string; close: number }[], ym: string, months: number): boolean | null {
  const past = ends.filter((e) => e.ym < ym)
  if (past.length < months) return null
  const win = past.slice(-months)
  let s = 0
  for (const e of win) s += e.close
  return win[win.length - 1].close > s / months
}

export type RegimeKind = 'mom12_1' | 'ma10m'

/**
 * 월별 노출 함수 — 위험선호 1 / 위험회피 0.
 * **판정 불가(데이터 부족)면 1**이다. 사후지식 없이 기본값을 쓰는 원칙이며(워크포워드와
 * 같은 취지), 초기 구간을 임의로 현금화해 성적을 만들지 않기 위해서다.
 */
export function makeRegimeExposure(
  curve: { date: string; equity: number }[],
  kind: RegimeKind,
  months = OVL_MA_MONTHS,
): (date: string) => number {
  const ends = monthEndCloses(curve)
  const memo = new Map<string, number>()
  return (date: string) => {
    const ym = ymOf(date)
    const hit = memo.get(ym)
    if (hit != null) return hit
    let on: boolean | null
    if (kind === 'mom12_1') {
      // ym만으로 창이 결정된다 — 달 안 어느 거래일에 불려도 같은 값이다
      const m = regimeMom12_1(curve, `${ym}-01`)
      on = m == null ? null : m >= 0
    } else {
      on = regimeMaRiskOn(ends, ym, months)
    }
    const w = on === false ? 0 : 1
    memo.set(ym, w)
    return w
  }
}

// ---- 오버레이 2: 변동성 타게팅 ------------------------------------------------

/**
 * 노출 = min(1, 목표변동성 / 실현변동성). 실현이 목표 이하면 그대로 1이다 —
 * **레버리지를 만들지 않는다**(목표/실현 > 1인 구간에서 노출을 1보다 키우면 그건
 * 다른 전략이지 리스크 오버레이가 아니다).
 *
 * 실현 변동성은 **베이스(무보정) 곡선**에서 잰다. 축소된 곡선에서 재면 자기 자신을
 * 참조하는 순환이 되고, 실무에서도 "기초자산의 변동성을 재서 포지션을 줄인다"가 표준이다.
 * 베이스 곡선은 시장 데이터의 결정적 함수이며 리밸런스일 **미만** 구간만 읽으므로
 * 절단 불변성이 유지된다(2패스 구조 — 1패스로 베이스, 2패스로 축소본).
 */
export function makeVolTargetExposure(
  base: { date: string; equity: number }[],
  targetPct: number,
  win = OVL_VOL_WIN,
): (date: string) => number {
  const vals = base.map((p) => p.equity)
  const memo = new Map<string, number>()
  return (date: string) => {
    const hit = memo.get(date)
    if (hit != null) return hit
    const rv = realizedVolPct(vals, curveIdxBefore(base, date), win)
    const w = rv == null || !(rv > targetPct) ? 1 : targetPct / rv
    memo.set(date, w)
    return w
  }
}

// ---- 오버레이 4: 결합 위험가중 (역변동성) -------------------------------------

/**
 * 역변동성 가중 wA — 두 슬리브의 직전 `win` 거래일 실현 변동성 역수 비례.
 * 창은 인덱스 `i` **미만**만 보므로 리밸런스일 당일 수익률이 들어가지 않는다.
 * 한쪽이라도 표본이 모자라면 **0.5**(= 사후지식 없는 기본값 = 기존 50:50).
 */
export function invVolWeight(ea: number[], eb: number[], i: number, win: number): number {
  const sa = stdevReturns(ea, i, win)
  const sb = stdevReturns(eb, i, win)
  if (sa == null || sb == null || !(sa > 0) || !(sb > 0)) return 0.5
  const ia = 1 / sa
  const ib = 1 / sb
  return ia / (ia + ib)
}

/**
 * 월 첫 거래일마다 가중을 **역변동성 비례**로 다시 잡는 결합.
 * `blendMonthlyRebalanced`와 뼈대가 같고 가중만 고정 → 동적으로 바뀐 것이다.
 * 가중은 항상 합 1이고 둘 다 0~1이라 레버리지가 생길 수 없다.
 * 반환 곡선은 시작 1.0 배수다.
 */
export function blendRiskParity(
  a: { date: string; equity: number }[],
  b: { date: string; equity: number }[],
  win = OVL_RP_WIN,
): { date: string; equity: number }[] {
  const { dates, ea, eb } = alignCurves(a, b)
  if (dates.length < 1) return []
  let wA = 0.5
  let vA = wA
  let vB = 1 - wA
  const out: number[] = [vA + vB]
  let curYm = ymOf(dates[0])
  for (let i = 1; i < dates.length; i++) {
    const ym = ymOf(dates[i])
    if (ym !== curYm) {
      curYm = ym
      wA = invVolWeight(ea, eb, i, win)
      const v = vA + vB
      vA = v * wA
      vB = v * (1 - wA)
    }
    const ra = ea[i - 1] > 0 ? ea[i] / ea[i - 1] : 1
    const rb = eb[i - 1] > 0 ? eb[i] / eb[i - 1] : 1
    vA *= ra
    vB *= rb
    out.push(vA + vB)
  }
  return dates.map((date, i) => ({ date, equity: out[i] }))
}

// ---- 위기 연도 · 판정 표 -------------------------------------------------------

export interface CrisisStat {
  y: number
  /** 그 해 수익(%) — **곡선 기준**(연말 청산비용 근사 미반영) */
  ret: number | null
  /** 그 해 안의 고점 대비 최대 낙폭(%) */
  mdd: number | null
}

/** 위기 연도 스칼라만 뽑는다 — 뽑고 나면 곡선은 버려도 된다(메모리). */
export function crisisStats(
  curve: { date: string; equity: number }[],
  years: readonly number[] = CRISIS_YEARS,
): CrisisStat[] {
  return years.map((y) => {
    const has = curve.some((p) => yearOf(p.date) === y)
    if (!has) return { y, ret: null, mdd: null }
    const end = valueAsOf(curve, `${y}-12-31`)
    const prev = valueAsOf(curve, `${y - 1}-12-31`) ?? curve[0].equity
    const ret = end != null && prev != null && prev > 0 ? (end / prev - 1) * 100 : null
    return { y, ret, mdd: yearMaxDrawdown(curve, y) }
  })
}

export function crisisTable(rows: { label: string; crisis: CrisisStat[] }[], years: readonly number[] = CRISIS_YEARS) {
  log('')
  log('## 위기 연도 해부 — 오버레이가 **언제** 도움이 됐나')
  log(`| 곡선 | ${years.map((y) => `${y} 수익 | ${y} 연중MDD`).join(' | ')} |`)
  log(`|---|${years.map(() => '---|---').join('|')}|`)
  for (const r of rows) {
    const cells = r.crisis
      .map((cs) => `${cs.ret != null ? `${f1(cs.ret)}%` : '—'} | ${cs.mdd != null ? `${f1(cs.mdd)}%` : '—'}`)
      .join(' | ')
    log(`| ${r.label} | ${cells} |`)
  }
  log('연중MDD는 **그 해 안의** 고점 기준이라 전 구간 MDD와 다르다(위기의 국소 깊이를 본다).')
  log('연수익은 곡선 기준이라 연말 청산비용 근사가 빠져 있다 — 연도별 분해표와 소수점이 다를 수 있다.')
}

/**
 * 오버레이 판정 — 대표 지시 기준 3항.
 *   ① 수익÷MDD가 베이스보다 개선  ② 전·후반 **모두** 알파 양(+)  ③ CAGR 하락 폭 명시
 * 수익이 줄어도 비율이 크게 오르면 개선이다. **하락 폭은 열로 항상 드러낸다.**
 * 채택된 변형 수를 돌려준다.
 */
export function overlayVerdictTable(base: StratRow, rows: StratRow[]): number {
  log('')
  log(`## 판정 — 베이스 \`${base.label}\` 대비 (기준: 수익÷MDD 개선 + 전·후반 알파 양수)`)
  log('| 변형 | 수익÷MDD | Δ비율 | MDD | ΔMDD | CAGR | **ΔCAGR** | 전반 알파 | 후반 알파 | 판정 |')
  log('|---|---|---|---|---|---|---|---|---|---|')
  let adopted = 0
  for (const r of rows) {
    const objUp = base.full.obj != null && r.full.obj != null && r.full.obj > base.full.obj
    const alphaOk = (r.alphaA ?? -1) > 0 && (r.alphaB ?? -1) > 0
    const ok = objUp && alphaOk
    if (ok) adopted++
    const dObj = base.full.obj != null && r.full.obj != null ? f1(r.full.obj - base.full.obj) : '—'
    log(
      `| ${r.label} | ${r.full.obj?.toFixed(1) ?? '—'} | ${dObj} | ${f1(r.full.mdd)}% | ` +
        `${f1(r.full.mdd - base.full.mdd)}%p | ${f1(r.full.cagr)}% | ${f1(r.full.cagr - base.full.cagr)}%p | ` +
        `${pctOrDash(r.alphaA)} | ${pctOrDash(r.alphaB)} | ${ok ? '✅' : objUp ? '△ 비율만' : '❌'} |`,
    )
  }
  log('△ = 수익÷MDD는 올랐지만 전·후반 알파 조건을 못 채운 것. 비율만 보고 채택하면 규칙 5 위반이다.')
  log('**ΔCAGR이 음수인 변형은 수익을 깎아 낙폭을 산 것이다** — 그 값을 보고도 받아들일 수 있어야 채택이다.')
  return adopted
}

/** 오버레이 전용 다중검정 경고 — 판정 기준이 달라 기존 노트를 그대로 쓸 수 없다. */
function overlayMultipleTestingNote(n: number, adopted: number) {
  log('')
  log('## 다중검정 경고')
  log(`같은 데이터에 오버레이 변형 ${n}개를 얹어 베이스와 비교했고, 그중 ${adopted}개가 판정 기준을 통과했다.`)
  log('오버레이는 **베이스를 재탐색하지 않는다**는 점에서 신규 계열 발굴보다 위양성 위험이 작지만,')
  log('그렇다고 0은 아니다 — 목표 변동성 15/20, 스톱 15/20처럼 파라미터를 2개씩만 둔 것도 그 때문이다.')
  if (adopted === 0)
    log('통과가 0개면 다중검정을 따질 것도 없다 — 이 오버레이들은 이 데이터에서 베이스를 개선하지 못했다.')
  else
    log(
      `순수 우연이라도 한 변형이 두 구간 모두 알파 양수일 확률을 ≈25%로 보면, ${n}개 중 ${adopted}개 이상이 ` +
        `그럴 확률은 약 ${(binomTail(n, adopted, 0.25) * 100).toFixed(0)}%다 — 이 값이 크면 표본 잡음이다.`,
    )
  log('⚠️ **사후선택 경고**: 여기서 가장 좋아 보이는 변형 하나를 골라 프리셋에 올리는 순간, 그 선택 자체가')
  log('   곡선맞춤이다. 채택하려면 ① 판정 3항을 다 만족하고 ② 위기 연도 표에서 도움이 된 시점이 설명되며')
  log('   ③ 파라미터 이웃값(15↔20)에서도 방향이 같아야 한다 — 한쪽만 좋으면 그건 고원이 아니라 봉우리다.')
}

async function overlay() {
  log('# MODE=overlay — 승자 전략에 리스크 오버레이를 얹어 수익÷MDD를 높일 수 있는가')
  log('')
  log('대표 지시(2026-08-02): "지금 프리셋에 있는 조건들을 좀 더 개선해서 수익률/MDD 수치 높일 수 없나?"')
  log('')
  log('**베이스는 손대지 않는다.** 파라미터를 다시 고르면 "오버레이의 효과"와 "재탐색의 이득"이 섞여')
  log('무엇이 개선했는지 알 수 없게 된다. 여기서 바뀌는 것은 **노출(얼마나 담느냐)뿐**이고,')
  log('종목 선택 규칙은 25·26차 승자 그대로다.')
  log('')
  log(`· B = XSM ${wfLabel(OVERLAY_B)} (25차 승자)`)
  log(`· C = 결합 50:50 (${BASELINE_LABEL} + B) (26차 승자)`)
  log('')
  const { years, histories, bench } = await loadPitHistories()
  const yearly = buildYearly(histories, years)
  if (yearly.every((v) => v.syms.length < 5)) {
    log('❌ 시세 로드 실패로 실행할 해가 없다 — 중단')
    return
  }
  const benchEq = benchCurve(bench)
  log(`연도별 매핑률: ${yearly.map((v) => `${v.y} ${v.mapped}`).join(' · ')}`)

  // ---- 레짐 시계열 (벤치 + 폴백) ---------------------------------------------
  let regime = benchEq
  let usedFallback = false
  let regimeNote = `${BENCH} 단독 (${bench[0]?.date ?? '—'} 시작 — 그 이전 달은 판정 불가 = 게이트 미작동)`
  try {
    const ks = await fetchDaily(REGIME_FALLBACK, 'since:1999-01-01')
    const spliced = spliceRegimeCurve(bench, ks)
    if (spliced.length > benchEq.length) {
      regime = spliced
      usedFallback = true
      regimeNote =
        `${BENCH} + ${REGIME_FALLBACK}(코스피 종합) 폴백 — ${bench[0]?.date ?? '—'} 이전 구간은 ` +
        `${REGIME_FALLBACK}의 **수익률만** 이어 붙였다(이음매 레벨 정합, 하루 수익 0 삽입).`
    }
  } catch (e) {
    log(`⚠️ ${REGIME_FALLBACK} 로드 실패 — 레짐은 벤치 구간만으로 판정한다 (${String(e)})`)
  }
  log(`레짐 판정 시계열: ${regimeNote}`)
  if (usedFallback)
    log(`⚠️ ${REGIME_FALLBACK}는 가격지수라 배당이 빠져 있다 — 레짐 **방향** 판정에만 쓰고 수익 계산에는 쓰지 않는다.`)

  // ---- 베이스 두 개 -----------------------------------------------------------
  const chainA = runSpecChain(yearly, baselineSpec, COST)
  const chainB = runCustomChain(
    yearly,
    (v) => simulateXsMomYear(v.hist, `${v.y}-01-01`, v.syms, COST, OVERLAY_B),
    COST,
    OVERLAY_B.slots,
  )
  const curveC = blendCurves(chainA.equity, chainB.equity, 0.5)

  /** B 위에 오버레이 옵션만 갈아 끼워 같은 연쇄로 돌린다 — 랭킹·게이트·슬롯은 그대로. */
  const runB = (extra: { exposure?: (date: string) => number; stopPct?: number }) =>
    runCustomChain(
      yearly,
      (v) =>
        simulateRankYear(v.hist, `${v.y}-01-01`, v.syms, COST, {
          slots: OVERLAY_B.slots,
          rank: xsmomRank,
          keep: (r) => r.aux >= 0,
          ...extra,
        }),
      COST,
      OVERLAY_B.slots,
    )

  const baseB = summarizeStrat(`B 베이스 · XSM ${wfLabel(OVERLAY_B)}`, chainB, benchEq)
  const baseC = curveStrat('C 베이스 · 결합 50:50', curveC, benchEq, years)
  const crisis: { label: string; crisis: CrisisStat[] }[] = [
    { label: baseB.label, crisis: crisisStats(chainB.equity) },
    { label: baseC.label, crisis: crisisStats(curveC) },
  ]

  // ---- 오버레이 1: 시장 레짐 게이트 -------------------------------------------
  const bRows: StratRow[] = []
  const gateChain = runB({ exposure: makeRegimeExposure(regime, 'mom12_1') })
  const gRow = summarizeStrat('B+G1 시장게이트(12-1 모멘텀 음수 → 현금)', gateChain, benchEq)
  bRows.push(gRow)
  crisis.push({ label: gRow.label, crisis: crisisStats(gateChain.equity) })
  {
    const ch = runB({ exposure: makeRegimeExposure(regime, 'ma10m') })
    bRows.push(summarizeStrat(`B+G2 시장게이트(${OVL_MA_MONTHS}개월 이평 이탈 → 현금)`, ch, benchEq))
    crisis.push({ label: bRows[bRows.length - 1].label, crisis: crisisStats(ch.equity) })
  }

  // ---- 오버레이 2: 변동성 타게팅 ----------------------------------------------
  for (const t of OVL_VOL_TARGETS) {
    const ch = runB({ exposure: makeVolTargetExposure(chainB.equity, t) })
    bRows.push(summarizeStrat(`B+V${t} 변동성 타게팅 목표 ${t}% (${OVL_VOL_WIN}일 창)`, ch, benchEq))
    crisis.push({ label: bRows[bRows.length - 1].label, crisis: crisisStats(ch.equity) })
  }

  // ---- 오버레이 3: 월중 크래시 스톱 -------------------------------------------
  for (const x of OVL_STOP_PCTS) {
    const ch = runB({ stopPct: x })
    bRows.push(summarizeStrat(`B+S${x} 월중 크래시 스톱 −${x}%`, ch, benchEq))
    crisis.push({ label: bRows[bRows.length - 1].label, crisis: crisisStats(ch.equity) })
  }

  // ---- 오버레이 4: 결합 위험가중 · 결합 게이트 --------------------------------
  const cRows: StratRow[] = []
  {
    const rp = blendRiskParity(chainA.equity, chainB.equity)
    cRows.push(curveStrat(`C+RP 결합 역변동성 가중 (${OVL_RP_WIN}거래일 ≈ 6개월)`, rp, benchEq, years))
    crisis.push({ label: cRows[0].label, crisis: crisisStats(rp) })
  }
  {
    const cg = blendCurves(chainA.equity, gateChain.equity, 0.5)
    cRows.push(curveStrat('C+G1 결합 50:50 (B 슬리브에 시장게이트 12-1)', cg, benchEq, years))
    crisis.push({ label: cRows[1].label, crisis: crisisStats(cg) })
  }

  // ---- 표 ---------------------------------------------------------------------
  const perfA = perfOf(chainA.equity)
  log('')
  log('## 성적 — 베이스 vs 오버레이 변형')
  stratTable([baseB, ...bRows, baseC, ...cRows])
  log('')
  log(
    `참고: 결합의 다른 한쪽인 A 단독(${BASELINE_LABEL}) = 총 ${f1(perfA.total)}% · CAGR ${f1(perfA.cagr)}% · ` +
      `MDD ${f1(perfA.mdd)}% · 수익÷MDD ${perfA.obj?.toFixed(1) ?? '—'}.`,
  )
  log('※ 결합 행(C 계열)의 "매매·승률"이 0/—인 것은 매매가 없다는 뜻이 아니라 두 슬리브 곡선의 합성이라')
  log('  매매 원장이 한쪽에 귀속되지 않기 때문이다(26차와 같은 이유).')

  const adoptedB = overlayVerdictTable(baseB, bRows)
  const adoptedC = overlayVerdictTable(baseC, cRows)
  crisisTable(crisis)

  perYearTable([baseB, ...bRows], '연도별 수익 분해 — B 계열 (거짓 매끈함 방지)')
  perYearTable([baseC, ...cRows], '연도별 수익 분해 — C 계열')

  overlayMultipleTestingNote(bRows.length + cRows.length, adoptedB + adoptedC)

  log('')
  log('## 이 실험의 구조적 한계')
  log('· **리밸런스 비용**: B 계열 오버레이(게이트·변동성 타게팅·스톱)는 실제 장부에서 팔고 사므로')
  log('  수수료·거래세·슬리피지가 **반영돼 있다**. 반면 C 계열(결합)은 두 슬리브 곡선의 합성이라')
  log('  **슬리브 간 이체 비용이 0으로 가정**돼 있다 — 26차와 같은 낙관적 상한이며, 역변동성 가중은')
  log('  50:50보다 가중이 더 자주 움직이므로 그 미반영 비용이 **더 크다**. C+RP의 개선폭은 상한으로 읽어라.')
  log('· **변동성 타게팅은 2패스**다 — 노출을 정하는 변동성은 베이스(무보정) 곡선에서 잰다. 축소된')
  log('  곡선에서 재면 자기 참조 순환이 되고, 실무 표준도 "기초자산 변동성을 재서 포지션을 줄인다"다.')
  log('  다만 그래서 **실현 변동성이 목표에 정확히 맞지는 않는다**(사후 실현치는 목표보다 낮게 나온다).')
  log('· **레짐 게이트는 지연된다** — 12-1도 10개월 이평도 월 단위 신호라 급락의 첫 달은 그대로 맞는다.')
  log('  2020년처럼 한 달 만에 바닥을 찍고 되돌린 구간에서는 오히려 반등을 놓칠 수 있다(위기 표 확인).')
  log('· **크래시 스톱은 봉 내부를 모른다** — 저가가 기준선을 스쳤는지 관통했는지를 일봉으로는 못 가른다.')
  log('  갭 관통을 시가로 체결해 보수적으로 잡았지만, 장중 변동이 큰 종목에서는 실제보다 낙관적일 수 있다.')
  log('· 오버레이는 **분모(낙폭)를 깎는 도구**다. 분자(수익)를 키우지 않으므로 CAGR은 대체로 내려간다.')
  log('  판정표의 ΔCAGR 열이 그 대가이며, 그 값을 보고도 받아들일 수 있을 때만 채택이다.')
  log('· 유니버스·비용·벤치·연쇄 규약은 25·26차와 동일하다. 다른 표의 숫자를 옮겨 적지 않았다.')
  unverifiedNote()
  disclaimer()
}

// ============================================================================

const MODES: Record<string, () => Promise<void>> = {
  seasonal,
  monthpat,
  pairprem,
  flow,
  xsmom,
  screen,
  volbrk,
  rsirev,
  xswf,
  usxsmom,
  usxsmom80,
  combo,
  overlay,
}

// 런처(scripts/idea-lab.mjs)만 IDEA_LAB_RUN=1을 넘긴다. 테스트가 이 모듈을
// import할 때는 자동 실행되지 않는다.
if (process.env.IDEA_LAB_RUN === '1') {
  const mode = process.env.MODE ?? 'seasonal'
  const entry = MODES[mode]
  if (!entry) {
    console.error(`알 수 없는 MODE=${mode} — 가능: ${Object.keys(MODES).join(', ')}`)
    process.exit(1)
  }
  entry().catch((e) => {
    console.error('실행 실패:', e)
    process.exit(1)
  })
}
