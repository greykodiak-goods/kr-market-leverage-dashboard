// 표준 성과 지표(src/features/backtest/perfStats.ts) 산식 검증.
//
// 전부 **손으로 계산 가능한 소형 케이스**다 — 구현을 그대로 베껴 기대값을 만들면 아무것도
// 검증하지 못하므로, 기대값은 정의식(√252 연환산 · 표본 표준편차 n−1 등)으로 직접 쓴다.
//
// ⚠️ 규칙 1(미래참조 금지)과의 관계: 여기서 재는 것은 **이미 확정된 자산곡선·매매 원장의
//    사후 요약**이다. 이 값들이 신호·임계값으로 되먹임되지 않으므로 전 구간 통계 금지에
//    걸리지 않는다(백테스트 자체의 인과성은 lookahead 테스트가 집행한다).

import { check, close, eq, finish, section } from './harness'
import {
  RISK_FREE_PCT,
  TRADING_DAYS_PER_YEAR,
  cagrPctOf,
  computeCurveStats,
  computeLedgerStats,
  dailyReturns,
  daysBetween,
  fmtDuration,
  fmtRatio,
  fmtYears,
  longestDrawdownSpan,
  perfStatFields,
} from '../src/features/backtest/perfStats'
import {
  PRECOMPUTE_SCHEMA,
  SUPPORTED_PRECOMPUTE_SCHEMAS,
  toPrecomputedIndex,
} from '../src/features/backtest/precomputed'
import { buildPayload, summarizePreset } from '../scripts/preset-precompute.entry'
import { DEFAULT_COST } from '../src/features/backtest/presets'
import type { PitChainResult } from '../src/features/backtest/pitChain'
import type { Trade } from '../src/features/backtest/types'

const DAY = 86400e3
const dstr = (t: number) => new Date(t).toISOString().slice(0, 10)

/** 지정한 일별 수익률을 그대로 밟는 곡선(2020-01-01부터 하루 간격). */
function curveFromReturns(rets: number[], start = 1_000_000): { date: string; equity: number }[] {
  const t0 = Date.parse('2020-01-01T00:00:00Z')
  const out = [{ date: dstr(t0), equity: start }]
  let e = start
  for (let i = 0; i < rets.length; i++) {
    e *= 1 + rets[i]
    out.push({ date: dstr(t0 + (i + 1) * DAY), equity: e })
  }
  return out
}

function trade(pnl: number, pnlPct: number, closed = true): Trade {
  return {
    entryDate: '2020-01-02',
    entryPrice: 100,
    qty: 10,
    exitDate: closed ? '2020-01-10' : null,
    exitPrice: closed ? 110 : null,
    pnl,
    pnlPct,
    reason: closed ? '조건 매도' : '보유중(미청산)',
  }
}

// ============================================================================
section('① 연환산 변동성 — 일수익률 표본 표준편차 × √252')
// ============================================================================

{
  eq('무위험수익률은 상수 0%', RISK_FREE_PCT, 0)
  eq('연환산 계수는 252 거래일', TRADING_DAYS_PER_YEAR, 252)

  // 수익률 [+2%, −2%] → 평균 0, 표본분산 = (0.02² + 0.02²)/(2−1) = 8e-4
  //                     표본 표준편차 = 0.02·√2, 연환산 = 0.02·√2·√252 × 100(%)
  const c = curveFromReturns([0.02, -0.02])
  eq('일수익률 2개', dailyReturns(c).length, 2)
  close('일수익률[0]', dailyReturns(c)[0], 0.02, 1e-12)
  const s = computeCurveStats(c, 10)
  const expectedVol = 0.02 * Math.sqrt(2) * Math.sqrt(252) * 100
  close('연환산 변동성', s.volAnnPct as number, expectedVol, 1e-9)
  check('상식 범위(≈44.9%)', Math.abs((s.volAnnPct as number) - 44.9) < 0.1, `got ${s.volAnnPct}`)

  // 매일 같은 비율로 오르면 흔들림이 없다 → 변동성 0 → 샤프는 나눌 수 없어 null(∞ 아님)
  const flat = computeCurveStats(curveFromReturns([0.01, 0.01, 0.01, 0.01]), 10)
  eq('일정 상승 → 변동성 null(표준편차 0)', flat.volAnnPct, null)
  eq('변동성이 없으면 샤프도 null', flat.sharpe, null)
  eq('하락일이 없으면 소르티노 null', flat.sortino, null)
  eq('하락일이 없으면 하방 변동성도 null', flat.downsideAnnPct, null)
}

// ============================================================================
section('② 샤프 — (CAGR − 무위험 0%) ÷ 연환산 변동성 · 부호와 스케일')
// ============================================================================

{
  const c = curveFromReturns([0.02, -0.02])
  const vol = 0.02 * Math.sqrt(2) * Math.sqrt(252) * 100

  const pos = computeCurveStats(c, 20)
  close('CAGR 20% / 변동성', pos.sharpe as number, 20 / vol, 1e-9)
  check('CAGR 양수면 샤프 양수', (pos.sharpe as number) > 0)

  const neg = computeCurveStats(c, -20)
  close('CAGR −20% / 변동성', neg.sharpe as number, -20 / vol, 1e-9)
  check('CAGR 음수면 샤프 음수', (neg.sharpe as number) < 0)

  // CAGR = 변동성이면 정확히 1.0 — 스케일(%끼리 나눈다)이 어긋나지 않았는지 못 박는다
  close('CAGR = 변동성이면 샤프 1.0', computeCurveStats(c, vol).sharpe as number, 1, 1e-9)

  // CAGR을 안 넘기면 곡선 양끝으로 잰다 — 두 값이 같은 정의를 쓰는지 확인
  const derived = computeCurveStats(c)
  close('CAGR 미지정 시 곡선에서 유도', derived.cagrPct as number, cagrPctOf(c) as number, 1e-12)
}

// ============================================================================
section('③ 소르티노 — 분모는 음(−)의 일수익률만의 제곱평균제곱근')
// ============================================================================

{
  // 수익률 [+3%, −1%, +2%, −1%] → 음수는 −1% 두 번뿐이므로 하방편차 = 0.01
  const c = curveFromReturns([0.03, -0.01, 0.02, -0.01])
  const s = computeCurveStats(c, 12)
  const expectedDown = 0.01 * Math.sqrt(252) * 100
  close('하방 변동성', s.downsideAnnPct as number, expectedDown, 1e-9)
  close('소르티노', s.sortino as number, 12 / expectedDown, 1e-9)

  // 같은 곡선에서 소르티노 > 샤프여야 한다 — 상승 변동(+3%)이 분모에서 빠지기 때문.
  check('상승이 큰 곡선은 소르티노 > 샤프', (s.sortino as number) > (s.sharpe as number), `sortino=${s.sortino} sharpe=${s.sharpe}`)

  // 부호: CAGR이 음수면 소르티노도 음수
  const bad = computeCurveStats(c, -5)
  check('CAGR 음수면 소르티노 음수', (bad.sortino as number) < 0)
}

// ============================================================================
section('④ 최장 낙폭 기간 — 고점 회복까지의 최장 구간(일·년)')
// ============================================================================

{
  eq('달력 일수', daysBetween('2020-01-01', '2020-01-11'), 10)

  // 100(1/1 고점) → 90 → 95 → 1/11 100 회복  = 10일
  // 이어서 120(1/12 새 고점) → 110 → 1/20 130 회복 = 8일
  const curve = [
    { date: '2020-01-01', equity: 100 },
    { date: '2020-01-02', equity: 90 },
    { date: '2020-01-03', equity: 95 },
    { date: '2020-01-11', equity: 100 },
    { date: '2020-01-12', equity: 120 },
    { date: '2020-01-13', equity: 110 },
    { date: '2020-01-20', equity: 130 },
  ]
  const span = longestDrawdownSpan(curve)
  check('낙폭 구간 있음', span != null)
  eq('시작(고점 날짜)', span?.startDate, '2020-01-01')
  eq('끝(회복 날짜)', span?.endDate, '2020-01-11')
  eq('일수', span?.days, 10)
  eq('회복함', span?.recovered, true)
  close('연 단위 병기', span?.years as number, 10 / 365.25, 1e-12)

  // 마지막 날까지 회복 못한 구간도 후보에 넣는다 — 진행 중이라고 빼면 통계가 낙관적이 된다
  const ongoing = [
    { date: '2020-01-01', equity: 100 },
    { date: '2020-01-02', equity: 90 },
    { date: '2020-01-11', equity: 100 }, // 10일 만에 회복
    { date: '2020-01-12', equity: 130 }, // 새 고점
    { date: '2020-01-13', equity: 100 },
    { date: '2020-03-01', equity: 110 }, // 130 미회복 = 49일
  ]
  const on = longestDrawdownSpan(ongoing)
  eq('미회복 구간이 더 길면 그쪽', on?.startDate, '2020-01-12')
  eq('끝은 곡선 마지막 날', on?.endDate, '2020-03-01')
  eq('회복 못함 표시', on?.recovered, false)
  eq('미회복 일수', on?.days, daysBetween('2020-01-12', '2020-03-01'))

  // 한 번도 고점 아래로 내려간 적이 없으면 낙폭 구간 자체가 없다
  eq('단조 증가 곡선은 낙폭 구간 없음', longestDrawdownSpan(curveFromReturns([0.01, 0.01, 0.01])), null)

  eq('일수 표기', fmtDuration(1234), '1,234일')
  eq('연수 표기', fmtYears(1234), '3.4년')
  eq('없으면 —', fmtDuration(null), '—')
}

// ============================================================================
section('⑤ 손익비 · Profit Factor — 원장 기반, 경계는 ∞가 아니라 —')
// ============================================================================

{
  // 이익 +10%, +20% (평균 +15%) / 손실 −5%, −5% (평균 −5%) → 손익비 3
  // 금액: 이익 100 + 200 = 300, 손실 50 + 50 = 100 → PF 3
  const l = computeLedgerStats([
    trade(100, 10),
    trade(200, 20),
    trade(-50, -5),
    trade(-50, -5),
  ])
  eq('청산 매매 수', l.closedCount, 4)
  eq('이익 건수', l.winCount, 2)
  eq('손실 건수', l.lossCount, 2)
  close('평균 이익%', l.avgWinPct as number, 15, 1e-12)
  close('평균 손실%', l.avgLossPct as number, -5, 1e-12)
  close('손익비 = 15 ÷ |−5|', l.payoffRatio as number, 3, 1e-12)
  close('이익합', l.grossProfit, 300, 1e-12)
  close('손실합(절대값)', l.grossLoss, 100, 1e-12)
  close('Profit Factor = 300 ÷ 100', l.profitFactor as number, 3, 1e-12)

  // 손실 0건 → ∞로 채우지 않고 null(화면 '—')
  const noLoss = computeLedgerStats([trade(100, 10), trade(200, 20)])
  eq('손실 0건이면 손익비 null', noLoss.payoffRatio, null)
  eq('손실 0건이면 PF null', noLoss.profitFactor, null)
  eq('그래도 이익 건수는 센다', noLoss.winCount, 2)
  eq('null은 화면에서 —', fmtRatio(noLoss.profitFactor), '—')

  // 미청산은 확정 손익이 아니므로 제외한다(평가손익이 성적에 섞이면 안 된다)
  const withOpen = computeLedgerStats([trade(100, 10), trade(-50, -5), trade(9999, 999, false)])
  eq('미청산 제외', withOpen.closedCount, 2)
  close('미청산 값이 이익합에 안 섞임', withOpen.grossProfit, 100, 1e-12)

  // 본전(0원) 매매는 기존 승률 정의(pnl > 0만 승)와 같게 **손실 쪽**으로 센다
  const flatTrade = computeLedgerStats([trade(100, 10), trade(0, 0)])
  eq('0원 매매는 손실 쪽', flatTrade.lossCount, 1)
  eq('평균 손실 0이면 손익비 null(0으로 나누지 않는다)', flatTrade.payoffRatio, null)
  eq('손실합 0이면 PF null', flatTrade.profitFactor, null)

  eq('원장 없음 → 0건', computeLedgerStats([]).closedCount, 0)
  eq('원장 undefined → PF null', computeLedgerStats(undefined).profitFactor, null)
}

// ============================================================================
section('⑥ 빈 입력·짧은 입력 — 0으로 채우지 않고 null')
// ============================================================================

{
  const empty = computeCurveStats([])
  eq('빈 곡선 변동성', empty.volAnnPct, null)
  eq('빈 곡선 샤프', empty.sharpe, null)
  eq('빈 곡선 소르티노', empty.sortino, null)
  eq('빈 곡선 최장 낙폭', empty.longestDrawdown, null)
  eq('빈 곡선 CAGR', empty.cagrPct, null)

  const one = computeCurveStats([{ date: '2020-01-01', equity: 100 }])
  eq('한 점 곡선도 전부 null', one.volAnnPct, null)
  eq('한 점 곡선 CAGR null', one.cagrPct, null)
  eq('한 점 곡선 낙폭 구간 null', longestDrawdownSpan([{ date: '2020-01-01', equity: 100 }]), null)

  // 두 점(수익률 1개)이면 표본 표준편차를 낼 수 없다 — 0이 아니라 null
  eq('수익률 1개면 변동성 null', computeCurveStats(curveFromReturns([0.05]), 10).volAnnPct, null)

  // 자산이 0으로 무너진 구간은 수익률 계산에서 건너뛴다(0으로 나누지 않는다)
  const wiped = [
    { date: '2020-01-01', equity: 100 },
    { date: '2020-01-02', equity: 0 },
    { date: '2020-01-03', equity: 0 },
  ]
  eq('0 자산 구간은 수익률에서 제외', dailyReturns(wiped).length, 1)
}

// ============================================================================
section('⑦ perfStatFields — 산출물용 스칼라 묶음 · 결합은 원장 귀속 불가')
// ============================================================================

{
  const c = curveFromReturns([0.03, -0.01, 0.02, -0.01])
  const trades = [trade(100, 10), trade(-50, -5)]

  const own = perfStatFields(c, trades, 12, true)
  check('변동성 채워짐', own.volAnnPct != null)
  close('손익비 = 10 ÷ 5', own.payoffRatio as number, 2, 1e-12)
  close('PF = 100 ÷ 50', own.profitFactor as number, 2, 1e-12)

  // 결합(곡선 합성)은 원장이 어느 슬리브에도 귀속되지 않는다 → 원장 지표는 null.
  // 곡선 지표는 그대로 계산된다(합성 곡선 자체는 존재한다).
  const combo = perfStatFields(c, trades, 12, false)
  eq('결합 손익비 null(귀속 불가)', combo.payoffRatio, null)
  eq('결합 PF null(귀속 불가)', combo.profitFactor, null)
  check('결합도 곡선 지표는 있다', combo.volAnnPct != null && combo.sharpe != null)
}

// ============================================================================
section('⑧ 사전계산 스키마 2 — 신규 지표 포함 · schema 1 하위호환')
// ============================================================================

/** presetprecompute.test.ts의 fakeResult와 같은 취지의 최소 더미(원곡선·원장 포함). */
function fakeResult(over: Partial<PitChainResult> = {}): PitChainResult {
  const t0 = Date.parse('2018-01-01T00:00:00Z')
  const equity = Array.from({ length: 400 }, (_, i) => ({
    date: dstr(t0 + i * DAY),
    equity: 1_000_000 * (1 + i * 0.002) * (i % 7 === 0 ? 0.99 : 1),
    benchmark: 1_000_000 * (1 + i * 0.001),
    drawdownPct: 0,
  }))
  return {
    equity,
    trades: [trade(100_000, 12), trade(-40_000, -4), trade(60_000, 8)],
    perYear: [],
    startDate: equity[0].date,
    endDate: equity[equity.length - 1].date,
    years: 1.1,
    totalPct: 80,
    cagrPct: 18.4,
    mddPct: -12.3,
    objective: 6.5,
    benchTotalPct: 40,
    benchCagrPct: 8.8,
    alphaCagrPct: 9.6,
    alphaTotalPct: 40,
    tradeCount: 3,
    winRate: 66.7,
    avgPnlPct: 5.3,
    openAtEnd: 0,
    exitBreakdown: [],
    lastScreen: [],
    lastScreenDate: '',
    mappedAvgPct: 88,
    ...over,
  } as PitChainResult
}

{
  // 3 = 참고 벽(walls) 추가(34차). 필드 추가만이라 옛 산출물도 계속 읽힌다.
  eq('굽는 쪽 스키마는 3', PRECOMPUTE_SCHEMA, 3)
  check('화면은 1도 읽는다', SUPPORTED_PRECOMPUTE_SCHEMAS.includes(1))
  check('화면은 2도 읽는다', SUPPORTED_PRECOMPUTE_SCHEMAS.includes(2))
  check('화면은 3도 읽는다', SUPPORTED_PRECOMPUTE_SCHEMAS.includes(3))

  const row = summarizePreset({ id: 'x-1', label: '테스트', kind: 'momentum' }, fakeResult(), 10_000_000)
  for (const k of ['volAnnPct', 'sharpe', 'sortino', 'maxDdDays', 'maxDdRecovered', 'payoffRatio', 'profitFactor'])
    check(`신규 필드 존재: ${k}`, k in (row as unknown as Record<string, unknown>))
  check('변동성은 원곡선에서 계산', row.volAnnPct != null && row.volAnnPct > 0)
  close('손익비 = 평균이익 10% ÷ 평균손실 4%', row.payoffRatio as number, 10 / 4, 1e-12)
  close('PF = 160,000 ÷ 40,000', row.profitFactor as number, 4, 1e-12)
  check('최장 낙폭 기간 계산됨', row.maxDdDays != null && (row.maxDdDays as number) > 0)

  // 결합은 원장 귀속 불가 — 기존 tradeCount와 같은 취급(0이 아니라 null)
  const combo = summarizePreset({ id: 'c-1', label: '결합', kind: 'combo' }, fakeResult(), 10_000_000)
  eq('결합 손익비 null', combo.payoffRatio, null)
  eq('결합 PF null', combo.profitFactor, null)
  check('결합도 곡선 지표는 있다', combo.sharpe != null)

  // ---- 화면 로더 왕복: 현행 스키마 ----
  const payload = buildPayload([row, combo], '2026-08-01', '2026-08-02T00:00:00.000Z', DEFAULT_COST)
  eq('payload 스키마 3', payload.schema, 3)
  check('note에 무위험 0% 가정 명시', payload.note.includes('무위험수익률 0%'))
  const idx2 = toPrecomputedIndex(JSON.parse(JSON.stringify(payload)))
  check('현행 스키마 파일을 읽는다', idx2 != null)
  eq('읽은 스키마 기록', idx2?.schema, 3)
  close('왕복 후 샤프 유지', idx2?.byId['x-1'].sharpe as number, row.sharpe as number, 1e-12)
  eq('왕복 후 결합 PF는 null 유지', idx2?.byId['c-1'].profitFactor, null)

  // ---- 하위호환: 신규 필드가 통째로 없는 schema 1 파일 ----
  const legacy = JSON.parse(JSON.stringify(payload))
  legacy.schema = 1
  for (const p of legacy.presets)
    for (const k of ['volAnnPct', 'sharpe', 'sortino', 'maxDdDays', 'maxDdRecovered', 'maxDdStart', 'maxDdEnd', 'payoffRatio', 'profitFactor'])
      delete p[k]
  const idx1 = toPrecomputedIndex(legacy)
  check('schema 1 파일도 계속 읽는다', idx1 != null)
  eq('옛 파일 스키마 기록', idx1?.schema, 1)
  eq('옛 파일의 기존 지표는 그대로', idx1?.byId['x-1'].mddPct, row.mddPct)
  eq('옛 파일에 신규 지표는 없음(0으로 채우지 않는다)', idx1?.byId['x-1'].sharpe, undefined)
  eq('신규 지표 없음은 화면에서 —', fmtRatio(idx1?.byId['x-1'].sharpe), '—')

  // 모르는 스키마는 여전히 없는 셈 친다(우아한 강등)
  const future = JSON.parse(JSON.stringify(payload))
  future.schema = 99
  eq('모르는 스키마는 무시', toPrecomputedIndex(future), null)
}

finish()
