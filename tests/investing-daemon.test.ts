// 24시간 상주 모의투자 데몬(investing-daemon) 검증 — **네트워크 없음**.
//
// 데몬에서 사고가 나면 되돌릴 수 없는 자리는 세 곳이다. 그 셋만 본다.
//   ① **언제 도는가** — dueSlots/msUntilNextSlot 이 주말·슬롯 시각·만회·마감선·재시도를
//      정확히 판정하는가. 잘못되면 장 끝난 뒤에 주문이 나가거나, 데몬이 죽었다 살아난 날의
//      매도가 통째로 빠진다.
//   ② **두 번 돌아도 한 번인가** — 같은 날 같은 단계를 재실행해도 장부가 이중 반영되지 않는가.
//      재시작·수동 재실행이 일상이므로 멱등하지 않으면 장부가 조용히 부풀어 오른다.
//   ③ **아침 매도가 미래를 보지 않는가** (규칙 1) — 청산 판정이 **전일 종가까지만** 쓰는가.
//      당일 봉을 어떻게 흔들어도 판정이 바뀌지 않아야 한다(절단 불변성).
//
// ③은 이 데몬의 존재 이유와 직결된다. 09:00에 파는 이상 판단 근거는 전일 종가뿐이며,
// 여기서 당일 값이 새어 들어오면 백테스트 성적 전체가 거짓말이 된다.

import { check, eq, finish, section } from './harness'
import {
  DEFAULT_RETRY_GAP_SEC,
  SLOTS,
  dueSlots,
  hmsToSec,
  kstParts,
  msUntilNextSlot,
  nextSlot,
  type DayState,
  type PhaseName,
} from '../scripts/lib/daemonSchedule'
import { planPreloadSells, truncateHistories, repriceSells, type PaperConfig } from '../scripts/lib/mockTradeCore'
import {
  PHASE_HISTORY_DAYS,
  initLedger,
  markPhase,
  phaseDone,
  runLedgerPhase,
  type MockLedger,
  type MockLiveConfig,
  type PhaseFill,
} from '../src/features/backtest/mockLedger'
import type { DailyBar } from '../src/features/backtest/types'

// KST 시각을 UTC Date 로 (테스트가 읽기 쉽도록)
const kst = (iso: string) => new Date(`${iso}+09:00`)
const st = (over: Partial<DayState> = {}): DayState => ({ date: '2026-08-03', done: [], lastAttemptAt: {}, ...over })

// ── ① 스케줄 판정 ────────────────────────────────────────────────────────────
// 2026-08-03 = 월요일, 2026-08-08 = 토요일, 2026-08-09 = 일요일

section('1) dueSlots — 주말·슬롯 시각·만회·마감선')
{
  eq('월요일 08:30:00 → preload', dueSlots(kst('2026-08-03T08:30:00'), st()).join(','), 'preload')
  eq('월요일 08:29:59 → 없음', dueSlots(kst('2026-08-03T08:29:59'), st()).join(','), '')
  eq('토요일 09:00 → 없음', dueSlots(kst('2026-08-08T09:00:00'), st({ date: '2026-08-08' })).join(','), '')
  eq('일요일 15:20 → 없음', dueSlots(kst('2026-08-09T15:20:00'), st({ date: '2026-08-09' })).join(','), '')

  // 매도접수는 08:59:30 — 개장 동시호가 마감 직전(시장가 접수 → 09:00 개장가 체결)
  eq(
    '08:59:29 → 매도 아직 아님(preload 만)',
    dueSlots(kst('2026-08-03T08:59:29'), st()).join(','),
    'preload',
  )
  eq(
    '08:59:30 → preload+sells',
    dueSlots(kst('2026-08-03T08:59:30'), st()).join(','),
    'preload,sells',
  )
  eq(
    '08:59:30 · preload 완료 → sells 만',
    dueSlots(kst('2026-08-03T08:59:30'), st({ done: ['preload'] })).join(','),
    'sells',
  )
  // 체결확인은 09:01 — 미체결 재주문·장부 반영
  eq(
    '09:01:00 · preload/sells 완료 → confirm',
    dueSlots(kst('2026-08-03T09:01:00'), st({ done: ['preload', 'sells'] })).join(','),
    'confirm',
  )
  eq(
    '09:00:59 · preload/sells 완료 → 아직 없음',
    dueSlots(kst('2026-08-03T09:00:59'), st({ done: ['preload', 'sells'] })).join(','),
    '',
  )

  // 만회 실행 — 데몬이 09:30에 재시작(오늘 아무것도 안 한 상태)
  eq(
    '09:30 재시작 → preload·sells·confirm 만회',
    dueSlots(kst('2026-08-03T09:30:00'), st()).join(','),
    'preload,sells,confirm',
  )
  eq(
    '09:30 재시작 · sells 만 남음 → sells·confirm',
    dueSlots(kst('2026-08-03T09:30:00'), st({ done: ['preload'] })).join(','),
    'sells,confirm',
  )
  // 만회는 하루 한 번뿐 — done 에 들어가면 다시 나오지 않는다
  eq(
    '만회 후 재호출 → 없음',
    dueSlots(kst('2026-08-03T09:31:00'), st({ done: ['preload', 'sells', 'confirm'] })).join(','),
    '',
  )

  // 마감선 — 장 끝난 뒤에는 주문 단계를 절대 만회하지 않는다
  eq('15:05 → sells/confirm 마감선 지남(buys 전)', dueSlots(kst('2026-08-03T15:05:00'), st({ done: ['preload'] })).join(','), '')
  eq('15:20 → buys', dueSlots(kst('2026-08-03T15:20:00'), st({ done: ['preload'] })).join(','), 'buys')
  eq('15:35 → buys 마감선 지남', dueSlots(kst('2026-08-03T15:35:00'), st({ done: ['preload'] })).join(','), '')
  eq('16:30 재시작 → close 만', dueSlots(kst('2026-08-03T16:30:00'), st()).join(','), 'close')
  eq('23:55 → 아무것도 없음(close 마감선 지남)', dueSlots(kst('2026-08-03T23:55:00'), st()).join(','), '')

  // 날짜가 바뀌면 어제의 done 은 무시된다
  eq(
    '전날 상태로 오늘 08:30 → preload',
    dueSlots(kst('2026-08-03T08:30:00'), st({ date: '2026-07-31', done: ['preload', 'sells', 'confirm', 'buys', 'close'] })).join(','),
    'preload',
  )
}

section('2) dueSlots — 실패 단계 재시도 간격')
{
  const attempted = (secAgo: number, at: string): DayState =>
    st({ lastAttemptAt: { preload: new Date(kst(at).getTime() - secAgo * 1000).toISOString() } })
  eq(
    `직전 시도 60초 전 → 보류(${DEFAULT_RETRY_GAP_SEC}초 간격)`,
    dueSlots(kst('2026-08-03T09:00:00'), attempted(60, '2026-08-03T09:00:00')).join(','),
    'sells',
  )
  eq(
    '직전 시도 400초 전 → 재시도',
    dueSlots(kst('2026-08-03T09:00:00'), attempted(400, '2026-08-03T09:00:00')).join(','),
    'preload,sells',
  )
}

section('3) 정밀 알람 — 다음 슬롯까지의 대기')
{
  const t = (at: string, state = st()) => msUntilNextSlot(kst(at), state)
  eq('08:00 → preload 까지 30분', Math.round(t('2026-08-03T08:00:00') / 1000), 30 * 60)
  eq('08:30 직후 → sells(08:59:30) 까지', Math.round(t('2026-08-03T08:30:00', st({ done: ['preload'] })) / 1000), 29 * 60 + 30)
  check('오늘 다 끝나면 다음 날 첫 슬롯까지 잔다', t('2026-08-03T17:00:00', st({ done: [...SLOTS.map((s) => s.name)] })) > 3600e3 * 5)
  check('상한(6h)을 넘지 않는다', t('2026-08-03T17:00:00') <= 6 * 3600e3)
  check('하한 1초 이상', t('2026-08-03T08:29:59.900') >= 1000)
  eq('다음 슬롯 안내', nextSlot(kst('2026-08-03T08:31:00'), st({ done: ['preload'] }))?.name ?? '', 'sells')
  // 슬롯 시각 '직후'에 깨어야 dueSlots(sec >= at)가 잡는다 — 여유 200ms
  const wake = new Date(kst('2026-08-03T08:00:00').getTime() + msUntilNextSlot(kst('2026-08-03T08:00:00'), st()))
  eq('알람이 깨는 시점에 슬롯이 due', dueSlots(wake, st()).join(','), 'preload')
}

section('4) 슬롯 정의 자체의 불변식')
{
  const names = SLOTS.map((s) => s.name).join(',')
  eq('단계 순서', names, 'preload,sells,confirm,buys,close')
  check(
    '모든 슬롯: 실행 시각 < 만회 마감',
    SLOTS.every((s) => hmsToSec(s.at) < hmsToSec(s.until)),
  )
  check(
    '슬롯 시각이 오름차순',
    SLOTS.every((s, i) => i === 0 || hmsToSec(SLOTS[i - 1].at) < hmsToSec(s.at)),
  )
  check('매도 접수는 개장(09:00) 전', hmsToSec(SLOTS[1].at) < hmsToSec('09:00:00'))
  check('주문 단계 만회 마감은 장 마감(15:30) 전', hmsToSec(SLOTS[3].until) < hmsToSec('15:30:00'))
  const p = kstParts(kst('2026-08-03T08:59:30'))
  eq('kstParts 날짜', p.date, '2026-08-03')
  eq('kstParts 초', p.sec, hmsToSec('08:59:30'))
  eq('kstParts 요일(월)', p.weekday, 1)
}

// ── ② 단계 멱등 ──────────────────────────────────────────────────────────────

const COST = { feePct: 0.015, taxPct: 0.18 }

function ledgerWithPosition(): MockLedger {
  const config: MockLiveConfig = {
    inception: '2026-08-01',
    perStrategyCapitalKrw: 20_000_000,
    slotsPerStrategy: 10,
    strategies: [{ id: 's1', label: 'S1', entryMa: 20, universe: 't1' }],
  }
  const l = initLedger(config)
  l.strategies.s1 = {
    ...l.strategies.s1,
    cash: 18_000_000,
    positions: [{ symbol: '000001.KS', qty: 100, avgPrice: 20_000, costBasis: 2_000_000, entryDate: '2026-07-30' }],
  }
  return l
}

const sellFill = (): PhaseFill => ({
  strategyId: 's1',
  date: '2026-08-03',
  symbol: '000001.KS',
  side: 'sell',
  qty: 100,
  price: 21_000,
  reason: '청산(maBreak)',
})

section('5) 단계 멱등 — 같은 날 같은 단계를 두 번 돌려도 장부는 하나')
{
  const base = ledgerWithPosition()
  const first = runLedgerPhase(base, '2026-08-03', 'confirm', [sellFill()], COST)
  eq('1회차: 건너뛰지 않음', first.skipped, false)
  eq('1회차: 반영 1건', first.applied.length, 1)
  eq('1회차: 포지션 정리됨', first.ledger.strategies.s1.positions.length, 0)
  check('1회차: 현금 증가', first.ledger.strategies.s1.cash > base.strategies.s1.cash)
  eq('1회차: 단계 기록됨', phaseDone(first.ledger, '2026-08-03', 'confirm'), true)

  // 같은 fills 로 다시 — 재시작·수동 재실행 상황
  const second = runLedgerPhase(first.ledger, '2026-08-03', 'confirm', [sellFill()], COST)
  eq('2회차: 건너뜀', second.skipped, true)
  eq('2회차: 반영 0건', second.applied.length, 0)
  eq('2회차 장부 === 1회차 장부(완전 동일)', JSON.stringify(second.ledger), JSON.stringify(first.ledger))
  eq('2회차: 매매기록도 1건뿐', second.ledger.strategies.s1.trades.length, 1)

  // 다른 단계는 막히지 않는다(같은 날 매도 → 매수)
  const buys = runLedgerPhase(second.ledger, '2026-08-03', 'buys', [], COST)
  eq('다른 단계는 정상 진행', buys.skipped, false)
  eq('두 단계 모두 기록', `${phaseDone(buys.ledger, '2026-08-03', 'confirm')}/${phaseDone(buys.ledger, '2026-08-03', 'buys')}`, 'true/true')
  // 다음 날은 다시 열린다
  eq('다음 날 같은 단계는 열려 있다', phaseDone(buys.ledger, '2026-08-04', 'confirm'), false)
}

section('6) 단계 기록은 무한히 쌓이지 않는다')
{
  let l = ledgerWithPosition()
  for (let i = 0; i < PHASE_HISTORY_DAYS + 15; i++) {
    const d = new Date(Date.parse('2026-01-01') + i * 86400e3).toISOString().slice(0, 10)
    l = markPhase(l, d, 'close')
  }
  eq(`보관 날짜 ${PHASE_HISTORY_DAYS}일치로 제한`, Object.keys(l.phases ?? {}).length, PHASE_HISTORY_DAYS)
  const dates = Object.keys(l.phases ?? {}).sort()
  eq('최신 날짜가 남는다', dates[dates.length - 1], new Date(Date.parse('2026-01-01') + (PHASE_HISTORY_DAYS + 14) * 86400e3).toISOString().slice(0, 10))
  // 거부된 체결은 기록되지 않는다(장부가 실전보다 관대하면 의미가 없다)
  const over = runLedgerPhase(ledgerWithPosition(), '2026-08-03', 'confirm', [{ ...sellFill(), qty: 999 }], COST)
  eq('보유 초과 매도는 거부', over.rejected.length, 1)
  eq('거부되면 매매기록 없음', over.ledger.strategies.s1.trades.length, 0)
  eq('거부돼도 단계는 닫힌다(무한 재시도 방지)', phaseDone(over.ledger, '2026-08-03', 'confirm'), true)
}

// ── ③ 아침 청산 판정의 절단 불변성 (규칙 1) ──────────────────────────────────

const SYM = '000001.KS'
const TODAY = '2026-08-03'

/**
 * 합성 시계열: 평탄(100) → 돌파(110) → 고원 → **직전일 급락(80)** → 당일(=asOf) 시가 79.
 * 엔진이 돌파에서 진입하고 40일선 −2% 이탈로 asOf 날 청산 신호를 내도록 만든 데이터다.
 * 마지막에 `today` 봉을 붙이는데, **이 봉은 판정에 절대 쓰이면 안 된다.**
 */
function buildBars(todayClose: number): DailyBar[] {
  const bars: DailyBar[] = []
  const push = (date: string, o: number, h: number, l: number, c: number, v = 1000) =>
    bars.push({ date, t: Math.floor(Date.parse(date) / 1000), o, h, l, c, v })
  const day = (i: number) => new Date(Date.parse('2026-01-05') + i * 86400e3).toISOString().slice(0, 10)
  let i = 0
  for (; i < 60; i++) push(day(i), 100, 100, 100, 100) // 평탄 — MA20=MA40=100
  push(day(i++), 105, 112, 104, 110) // 돌파: MA20 상향 교차 + 20일 신고가 → 진입 신호
  for (; i < 150; i++) push(day(i), 110, 111, 109, 110) // 고원 — MA40이 110 근처로 수렴
  push(day(i++), 108, 108, 79, 80) // 급락 종가 80 → MA40×0.98 아래로 이탈 확정
  push(ASOF, 79, 80, 78, 79) // asOf(전 거래일) — 전일 이탈을 받아 시가 청산
  push(TODAY, 79, todayClose + 5, todayClose - 5, todayClose) // ← 당일 봉(판정에 쓰이면 안 됨)
  return bars
}
/** today 바로 앞 거래일 — 아침 판정의 유일한 근거일 */
const ASOF = '2026-07-31'

const paper: PaperConfig = {
  inception: '2026-03-01',
  cost: { initialCapital: 20_000_000, feePct: 0.015, taxPct: 0.18, slippagePct: 0.1 },
  tracks: { t1: { label: '테스트', symbols: [SYM] } },
  benchmark: SYM,
}
const cfg: MockLiveConfig = {
  inception: '2026-03-01',
  perStrategyCapitalKrw: 20_000_000,
  slotsPerStrategy: 10,
  strategies: [{ id: 's1', label: 'S1', entryMa: 20, universe: 't1' }],
}

function ledgerHolding(): MockLedger {
  const l = initLedger(cfg)
  l.strategies.s1 = {
    ...l.strategies.s1,
    inception: '2026-03-01',
    cash: 18_000_000,
    positions: [{ symbol: SYM, qty: 100, avgPrice: 110, costBasis: 11_000, entryDate: '2026-03-10' }],
  }
  return l
}

function planWith(todayClose: number) {
  return planPreloadSells({
    config: cfg,
    ledger: ledgerHolding(),
    paper,
    histories: { [SYM]: buildBars(todayClose) },
    today: TODAY,
    slots: 10,
    cost: paper.cost,
  })
}

section('7) 절단 불변성 — 아침 청산 판정은 전일 종가까지만 쓴다 (규칙 1)')
{
  const crash = planWith(40) // 당일 −50% 폭락
  const spike = planWith(200) // 당일 +150% 폭등
  const flat = planWith(79)

  // 공허한 통과 방지 — 실제로 청산 신호가 나오는 데이터인지 먼저 못 박는다.
  check(`청산 신호가 실제로 발생한다 (sells=${crash.sells.length}, asOf=${crash.asOf})`, crash.sells.length === 1)
  eq('판단 기준일 = 전 거래일(당일 아님)', crash.asOf, ASOF)
  check('판단 기준일이 today 보다 앞선다', String(crash.asOf) < TODAY)

  eq('당일 폭락/폭등에도 매도 계획이 동일', JSON.stringify(crash.sells), JSON.stringify(spike.sells))
  eq('당일 값과 무관하게 평탄 케이스와도 동일', JSON.stringify(crash.sells), JSON.stringify(flat.sells))
  eq('신호 로그도 동일', JSON.stringify(crash.signals), JSON.stringify(spike.signals))
  eq('참조 종가(전일 종가)도 동일', JSON.stringify(crash.refClose), JSON.stringify(spike.refClose))
  check('참조 종가는 당일 값이 아니다', crash.refClose[SYM] !== 200 && crash.refClose[SYM] !== 40)

  // 당일 봉을 아예 붙이지 않은 시계열과도 같아야 한다(= 절단 불변성의 정의)
  const noToday = planPreloadSells({
    config: cfg,
    ledger: ledgerHolding(),
    paper,
    histories: { [SYM]: buildBars(79).filter((b) => b.date !== TODAY) },
    today: TODAY,
    slots: 10,
    cost: paper.cost,
  })
  eq('당일 봉이 없는 시계열과 결과 동일', JSON.stringify(noToday.sells), JSON.stringify(crash.sells))

  // 매도 계획은 장부 보유 수량을 넘지 않는다(없는 물량을 팔지 않는다)
  eq('매도 수량 = 장부 보유량', crash.sells[0].qty, 100)
  eq('매도 지정가 기준 = 전일 종가', crash.sells[0].price, Math.round(crash.refClose[SYM]))
}

section('8) truncateHistories — 절단 자체의 동작')
{
  const bars = buildBars(123)
  const cut = truncateHistories({ [SYM]: bars }, TODAY)[SYM]
  eq('당일 봉이 제거된다', cut.filter((b) => b.date === TODAY).length, 0)
  eq('그 전 봉은 모두 남는다', cut.length, bars.length - 1)
  eq('마지막 봉 = 전 거래일', cut[cut.length - 1].date, ASOF)
  const cutTwice = truncateHistories({ [SYM]: cut }, TODAY)[SYM]
  eq('두 번 잘라도 같다(멱등)', cutTwice.length, cut.length)
}

section('9) 체결가 반영 — 확인된 값만 쓰고 나머지는 [추정] 표시')
{
  const plan = planWith(79)
  const withFill = repriceSells(plan.sells, { [SYM]: 77 })
  eq('체결가로 갱신', withFill.orders[0].price, 77)
  eq('갱신 건수', withFill.priced, 1)
  eq('대체 없음', withFill.fallback.length, 0)
  const noFill = repriceSells(plan.sells, {})
  eq('체결가 없으면 참조 종가 유지', noFill.orders[0].price, plan.sells[0].price)
  eq('대체 건수', noFill.fallback.length, 1)
  check('[추정] 표시가 남는다', String(noFill.orders[0].note).includes('[추정]'))
  // 원본을 훼손하지 않는다(순수 함수)
  eq('원본 불변', plan.sells[0].price, Math.round(plan.refClose[SYM]))
}

finish()
