// 표준 성과 지표 — 백테스트가 **끝난 뒤** 자산곡선·매매 원장을 요약하는 순수 함수 모음.
//
// 대표 지시(2026-08-02): "(퀀트 블로그에) 나오는 지표들 다 넣어주고 지표 설명 아이콘도 추가해줘".
// 기존 KPI(총수익·CAGR·알파·MDD·수익÷MDD·칼마·승률/매매·10y 연평균)에 **추가만** 한다 —
// 엔진·기존 지표 정의는 건드리지 않는다.
//
// ── 규칙 1(미래참조 금지)과의 관계 ──────────────────────────────────────────
//   여기 있는 계산은 전부 **이미 확정된 결과의 사후 요약**이다. 값이 신호·임계값·판정으로
//   되먹임되지 않으므로 "전 구간 통계 금지"(규칙 1-5)에 걸리지 않는다. 반대로 이 함수들의
//   산출물을 전략 로직(진입·청산·사이징)에 넣는 순간 그것은 미래참조가 된다 — 표시 전용이다.
//
// ── 규칙 3(데이터 정직성) ───────────────────────────────────────────────────
//   계산 불가는 0이 아니라 **null**로 돌려준다. 손실 매매가 0건일 때 Profit Factor를 ∞나
//   999로 채우면 "무한히 좋은 전략"이라는 거짓이 된다 — null(= 화면의 '—')이 정직하다.
//
// ── 규칙 4(투자자문 아님) ───────────────────────────────────────────────────
//   이 파일은 수치만 만든다. 해석 문구는 화면(KpiCard의 info)에 두되 확정적 권유 표현을
//   쓰지 않는다.

import type { EquityPoint, Trade } from './types'

/** 연환산 계수 — 한국 주식 연간 거래일 근사(엔진·metrics.ts와 같은 상수). */
export const TRADING_DAYS_PER_YEAR = 252

/**
 * 샤프·소르티노에 쓰는 무위험수익률(연 %). **상수 0으로 고정**한다.
 * 외부 금리 시계열을 끌어오면 데이터 의존이 하나 늘고, 그 데이터의 기준일·보정 상태가
 * 또 다른 거짓말 경로가 된다. 대신 화면에 "0% 가정 — 실제 국고채 수익률만큼 낮아짐"을
 * 반드시 병기한다(규칙 3).
 */
export const RISK_FREE_PCT = 0

/** 표본 표준편차(n−1) — metrics.ts와 같은 정의. */
function stdev(xs: number[]): number {
  if (xs.length < 2) return 0
  const m = xs.reduce((s, v) => s + v, 0) / xs.length
  return Math.sqrt(xs.reduce((s, v) => s + (v - m) ** 2, 0) / (xs.length - 1))
}

/** 곡선에서 일별 단순수익률을 뽑는다(직전 값이 0 이하인 구간은 건너뛴다). */
export function dailyReturns(curve: { equity: number }[]): number[] {
  const out: number[] = []
  for (let i = 1; i < curve.length; i++) {
    const prev = curve[i - 1].equity
    if (!(prev > 0)) continue
    out.push(curve[i].equity / prev - 1)
  }
  return out
}

/** 두 날짜 사이 연수 — pitChain.yearsBetween과 같은 정의(365.25일/년). */
function yearsBetweenDates(a: string, b: string): number {
  return Math.max(1 / 365, (Date.parse(b) - Date.parse(a)) / (365.25 * 86400e3))
}

/** 두 날짜 사이 달력 일수(정수). */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86400e3)
}

/**
 * 곡선 양끝으로 잰 연환산 수익률(%) — 호출부가 CAGR을 넘기지 않을 때만 쓰는 보조 계산.
 * 화면·산출물은 이미 확정된 `cagrPct`를 넘겨 **같은 숫자**를 쓰게 한다(정의가 갈라지면 안 된다).
 */
export function cagrPctOf(curve: { date: string; equity: number }[]): number | null {
  if (curve.length < 2) return null
  const first = curve[0]
  const last = curve[curve.length - 1]
  if (!(first.equity > 0) || !(last.equity > 0)) return null
  const years = yearsBetweenDates(first.date, last.date)
  return (Math.pow(last.equity / first.equity, 1 / years) - 1) * 100
}

// ============================================================================
// ① 곡선 기반 — 변동성 · 샤프 · 소르티노 · 최장 낙폭 기간
// ============================================================================

/** 최장 낙폭 기간(고점 → 그 고점 회복). `recovered=false`면 마지막 날까지 회복 못한 것. */
export interface UnderwaterSpan {
  /** 낙폭이 시작된 고점의 날짜 */
  startDate: string
  /** 고점을 회복한 날짜(회복 못했으면 곡선 마지막 날) */
  endDate: string
  /** 달력 일수 */
  days: number
  /** 연 단위(365.25일) — "몇 년을 물려 있었나" */
  years: number
  /** 마지막 날까지 고점을 회복했는지 */
  recovered: boolean
}

export interface CurveStats {
  /** 연환산 변동성(%) — 일수익률 표준편차 × √252. 표본이 2개 미만이면 null */
  volAnnPct: number | null
  /** 연환산 하방 변동성(%) — 음(−)의 일수익률만의 제곱평균제곱근 × √252. 음수일이 없으면 null */
  downsideAnnPct: number | null
  /** 샤프 비율 — (CAGR − 무위험 0%) ÷ 연환산 변동성 */
  sharpe: number | null
  /** 소르티노 비율 — (CAGR − 무위험 0%) ÷ 하방 변동성 */
  sortino: number | null
  /** 최장 낙폭 기간. 곡선이 한 번도 고점 아래로 내려간 적 없으면 null */
  longestDrawdown: UnderwaterSpan | null
  /** 계산에 쓴 CAGR(%) — 호출부가 넘긴 값 또는 곡선에서 잰 값 */
  cagrPct: number | null
}

const EMPTY_CURVE_STATS: CurveStats = {
  volAnnPct: null,
  downsideAnnPct: null,
  sharpe: null,
  sortino: null,
  longestDrawdown: null,
  cagrPct: null,
}

/**
 * 자산곡선 사후 요약.
 *
 * @param curve   일별(또는 임의 간격) 자산곡선. **다운샘플 전 원곡선**을 넣어야 한다 —
 *                주 1점으로 줄인 곡선에서 재면 변동성·낙폭 기간이 전부 왜곡된다.
 * @param cagrPct 이미 확정된 연환산 수익률(%). 넘기지 않으면 곡선 양끝으로 잰다.
 *
 * 변동성 연환산은 **일별 곡선 전제**다(×√252). 간격이 다른 곡선을 넣으면 스케일이 어긋난다.
 */
export function computeCurveStats(
  curve: { date: string; equity: number }[] | EquityPoint[],
  cagrPct?: number | null,
): CurveStats {
  if (!curve || curve.length < 2) return EMPTY_CURVE_STATS

  const rets = dailyReturns(curve)
  const sd = stdev(rets)
  const volAnnPct = rets.length >= 2 && sd > 0 ? sd * Math.sqrt(TRADING_DAYS_PER_YEAR) * 100 : null

  // 하방 변동성: 음수 수익률만 모아 **제곱평균제곱근**(평균을 빼지 않는다 — 목표수익률 0 대비 하방편차).
  const negs = rets.filter((r) => r < 0)
  const downsideAnnPct = negs.length
    ? Math.sqrt(negs.reduce((s, r) => s + r * r, 0) / negs.length) * Math.sqrt(TRADING_DAYS_PER_YEAR) * 100
    : null

  const cagr = cagrPct != null && Number.isFinite(cagrPct) ? cagrPct : cagrPctOf(curve)
  const excess = cagr != null ? cagr - RISK_FREE_PCT : null

  return {
    volAnnPct,
    downsideAnnPct,
    sharpe: excess != null && volAnnPct != null && volAnnPct > 0 ? excess / volAnnPct : null,
    sortino: excess != null && downsideAnnPct != null && downsideAnnPct > 0 ? excess / downsideAnnPct : null,
    longestDrawdown: longestDrawdownSpan(curve),
    cagrPct: cagr,
  }
}

/**
 * 최장 낙폭 기간 — 자산곡선이 직전 고점을 **회복하기까지** 걸린 가장 긴 구간.
 *
 * MDD가 "얼마나 깊이 빠졌나"라면 이 값은 "얼마나 오래 물려 있었나"다. 깊이가 얕아도
 * 회복이 몇 년씩 걸리면 실제로는 그 전략을 계속 들고 있기 어렵다 — 돈이 아니라 시간의 고통.
 *
 * 마지막 날까지 회복하지 못한 구간도 **후보에 포함**한다(`recovered=false`). 진행 중이라는
 * 이유로 빼면 "지금 물려 있는 3년"이 통계에서 사라져 낙관적으로 보인다.
 */
export function longestDrawdownSpan(curve: { date: string; equity: number }[]): UnderwaterSpan | null {
  if (!curve || curve.length < 2) return null
  let peak = curve[0].equity
  let peakDate = curve[0].date
  let underwater = false
  let best: UnderwaterSpan | null = null

  const consider = (start: string, end: string, recovered: boolean) => {
    const days = daysBetween(start, end)
    if (days <= 0) return
    if (best == null || days > best.days) {
      best = { startDate: start, endDate: end, days, years: days / 365.25, recovered }
    }
  }

  for (let i = 1; i < curve.length; i++) {
    const p = curve[i]
    if (p.equity >= peak) {
      if (underwater) consider(peakDate, p.date, true)
      peak = p.equity
      peakDate = p.date
      underwater = false
    } else {
      underwater = true
    }
  }
  if (underwater) consider(peakDate, curve[curve.length - 1].date, false)
  return best
}

// ============================================================================
// ② 원장 기반 — 손익비(Payoff) · Profit Factor
// ============================================================================

export interface LedgerStats {
  /** 청산 완료 매매 수 */
  closedCount: number
  winCount: number
  lossCount: number
  /** 이익 매매 평균 수익률(%) */
  avgWinPct: number | null
  /** 손실 매매 평균 수익률(%) — 음수 */
  avgLossPct: number | null
  /** 손익비 = 평균 이익% ÷ |평균 손실%|. 손실 0건이면 null(∞ 아님) */
  payoffRatio: number | null
  /** 이익 매매 손익 합(원) */
  grossProfit: number
  /** 손실 매매 손익 합의 절대값(원) */
  grossLoss: number
  /** Profit Factor = 이익합 ÷ |손실합|. 손실 0건이면 null */
  profitFactor: number | null
}

const EMPTY_LEDGER_STATS: LedgerStats = {
  closedCount: 0,
  winCount: 0,
  lossCount: 0,
  avgWinPct: null,
  avgLossPct: null,
  payoffRatio: null,
  grossProfit: 0,
  grossLoss: 0,
  profitFactor: null,
}

/**
 * 매매 원장 사후 요약 — **청산 완료 매매만** 센다(미청산은 평가손익이라 확정 손익이 아니다).
 *
 * 승·패 분류는 기존 승률(metrics.ts)과 같은 기준: `pnl > 0`이면 이익, 그 외(0 포함)는 손실.
 * 같은 화면에서 승률 60%인데 손익비가 다른 모집단으로 계산되면 서로 말이 안 맞는다.
 *
 * ⚠️ 결합(combo)처럼 **곡선 합성** 산출물에는 귀속되는 원장이 없다. 그때 이 함수를 빈 배열로
 * 부르면 "매매 0건"이 되는데 이는 사실이 아니다 — 호출부가 '귀속 불가'로 따로 표시해야 한다.
 */
export function computeLedgerStats(trades: Trade[] | undefined | null): LedgerStats {
  if (!trades || trades.length === 0) return EMPTY_LEDGER_STATS
  const closed = trades.filter((t) => t.exitDate != null && t.pnl != null)
  if (closed.length === 0) return EMPTY_LEDGER_STATS

  const wins = closed.filter((t) => (t.pnl ?? 0) > 0)
  const losses = closed.filter((t) => (t.pnl ?? 0) <= 0)

  const pctOf = (ts: Trade[]) => ts.filter((t) => t.pnlPct != null && Number.isFinite(t.pnlPct))
  const winPcts = pctOf(wins)
  const lossPcts = pctOf(losses)
  const avgWinPct = winPcts.length ? winPcts.reduce((s, t) => s + (t.pnlPct as number), 0) / winPcts.length : null
  const avgLossPct = lossPcts.length ? lossPcts.reduce((s, t) => s + (t.pnlPct as number), 0) / lossPcts.length : null

  const grossProfit = wins.reduce((s, t) => s + (t.pnl as number), 0)
  const grossLoss = Math.abs(losses.reduce((s, t) => s + (t.pnl as number), 0))

  return {
    closedCount: closed.length,
    winCount: wins.length,
    lossCount: losses.length,
    avgWinPct,
    avgLossPct,
    // 손실이 0건이거나 평균 손실이 정확히 0이면 나눌 수 없다 — ∞ 대신 null(화면 '—').
    payoffRatio: avgWinPct != null && avgLossPct != null && Math.abs(avgLossPct) > 0 ? avgWinPct / Math.abs(avgLossPct) : null,
    grossProfit,
    grossLoss,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : null,
  }
}

// ============================================================================
// ③ 산출물/화면 공용 스칼라 묶음
// ============================================================================

/**
 * 사전계산 JSON·화면이 같이 쓰는 납작한 지표 묶음.
 * (JSON에 넣을 것이므로 중첩 객체 대신 스칼라만 둔다 — 스키마 하위호환을 다루기 쉽다.)
 */
export interface PerfStatFields {
  /** 연환산 변동성(%) */
  volAnnPct: number | null
  /** 샤프 비율(무위험 0% 가정) */
  sharpe: number | null
  /** 소르티노 비율(무위험 0% 가정) */
  sortino: number | null
  /** 최장 낙폭 기간(달력 일수) */
  maxDdDays: number | null
  /** 그 구간을 마지막 날까지 회복했는지 — false면 아직 물려 있는 상태 */
  maxDdRecovered: boolean | null
  /** 최장 낙폭 기간의 시작(고점) 날짜 */
  maxDdStart: string | null
  /** 최장 낙폭 기간의 끝(회복일 또는 곡선 마지막 날) */
  maxDdEnd: string | null
  /** 손익비 — 원장이 귀속되지 않는 결합은 null */
  payoffRatio: number | null
  /** Profit Factor — 원장이 귀속되지 않는 결합은 null */
  profitFactor: number | null
}

/**
 * 곡선·원장에서 산출물용 스칼라 묶음을 만든다.
 * @param hasLedger 원장이 이 결과에 귀속되는가(결합=false). false면 원장 지표는 null.
 */
export function perfStatFields(
  curve: { date: string; equity: number }[],
  trades: Trade[] | undefined | null,
  cagrPct: number | null | undefined,
  hasLedger: boolean,
): PerfStatFields {
  const c = computeCurveStats(curve, cagrPct)
  const l = hasLedger ? computeLedgerStats(trades) : EMPTY_LEDGER_STATS
  return {
    volAnnPct: c.volAnnPct,
    sharpe: c.sharpe,
    sortino: c.sortino,
    maxDdDays: c.longestDrawdown?.days ?? null,
    maxDdRecovered: c.longestDrawdown?.recovered ?? null,
    maxDdStart: c.longestDrawdown?.startDate ?? null,
    maxDdEnd: c.longestDrawdown?.endDate ?? null,
    payoffRatio: hasLedger ? l.payoffRatio : null,
    profitFactor: hasLedger ? l.profitFactor : null,
  }
}

// ---- 표시 도우미 ------------------------------------------------------------

/** 비율 지표 표시 — 계산 불가는 '—'(0이나 ∞로 채우지 않는다). */
export function fmtRatio(v: number | null | undefined, digits = 2): string {
  return v == null || !Number.isFinite(v) ? '—' : v.toFixed(digits)
}

/** `1,234일 · 3.4년` — 최장 낙폭 기간의 표준 표기(일·년 병기). */
export function fmtDuration(days: number | null | undefined): string {
  if (days == null || !Number.isFinite(days)) return '—'
  return `${Math.round(days).toLocaleString('ko-KR')}일`
}

/** 일수 → 연수 문자열(`3.4년`). */
export function fmtYears(days: number | null | undefined): string {
  if (days == null || !Number.isFinite(days)) return '—'
  return `${(days / 365.25).toFixed(1)}년`
}
