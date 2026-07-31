// 모의계좌 1개를 5기법 서브포트폴리오로 쪼개는 **장부** 검증 (네트워크 없음).
//
// 핵심 질문 네 가지:
//   ① 장부가 실전보다 관대하지 않은가 — 없는 현금·없는 물량으로 매매되지 않는가
//   ② 전략이 서로 섞이지 않는가 — 같은 종목을 두 전략이 사도 성과가 분리되는가
//   ③ 계좌 1개라는 제약(실보유량·현금)이 장부 합에 올바르게 씌워지는가
//   ④ 성과 판정이 벤치 대비(알파)로 나오는가 (규칙 5)

import { check, close, eq, finish, section } from './harness'
import {
  allocateSellQty,
  applyLedgerFill,
  capBuysToCash,
  initLedger,
  ledgerEquity,
  markEquity,
  slotQty,
  summarize,
  syncLedger,
  type LedgerFill,
  type MockLiveConfig,
  type StrategyLedger,
} from '../src/features/backtest/mockLedger'
import type { PaperCost } from '../src/features/backtest/paperTrading'
import { runStrategySpec, screenOnDate } from '../src/features/backtest/conditionScreen'
import type { DailyBar } from '../src/features/backtest/types'

const FREE: PaperCost = { feePct: 0, taxPct: 0 }
const COST: PaperCost = { feePct: 0.015, taxPct: 0.15 }

const CONFIG: MockLiveConfig = {
  inception: '2026-07-31',
  perStrategyCapitalKrw: 20_000_000,
  slotsPerStrategy: 10,
  strategies: [
    { id: 'ma20-all80', label: 'MA20 (승자)', entryMa: 20, universe: 'all80' },
    { id: 'ma15-all80', label: 'MA15 (도전자)', entryMa: 15, universe: 'all80' },
    { id: 'bench-hold', label: 'KODEX200 보유 (대조군)', type: 'benchHold', symbol: '069500.KS' },
  ],
}

function fill(over: Partial<LedgerFill> = {}): LedgerFill {
  return { date: '2026-07-31', symbol: '005930.KS', side: 'buy', qty: 10, price: 100_000, reason: '테스트', ...over }
}

// ------------------------------------------------------------ 1) 초기화
section('1) 초기화 · config 동기화')
{
  const l = initLedger(CONFIG)
  eq('전략 수', Object.keys(l.strategies).length, 3)
  eq('전략별 초기 현금 = 2,000만', l.strategies['ma20-all80'].cash, 20_000_000)
  eq('전략별 초기자본 기록', l.strategies['bench-hold'].initialCapital, 20_000_000)
  eq('개시일 전파', l.strategies['ma15-all80'].inception, '2026-07-31')
  eq('lastRunDate 없음', l.lastRunDate, null)
  check('총자본 = 5기법 기준 2,000만×3 = 6,000만', Object.values(l.strategies).reduce((s, x) => s + x.cash, 0) === 60_000_000)

  // 전략 교체: 새 전략은 신설되고, 빠진 전략은 **지워지지 않는다**(성과 기록 보존)
  const next: MockLiveConfig = {
    ...CONFIG,
    strategies: [CONFIG.strategies[0], { id: 'ma20-kosdaq', label: '코스닥40', entryMa: 20, universe: 'kosdaq40' }],
  }
  const { ledger: l2, added, retired } = syncLedger(l, next, '2026-08-10')
  eq('신설 1건', added.join(','), 'ma20-kosdaq')
  eq('퇴역 2건 보존', retired.sort().join(','), 'bench-hold,ma15-all80')
  eq('퇴역 장부가 남아 있다', Object.keys(l2.strategies).length, 4)
  eq('신설 전략 개시일 = 오늘(소급 금지)', l2.strategies['ma20-kosdaq'].inception, '2026-08-10')
  eq('기존 전략 개시일 유지', l2.strategies['ma20-all80'].inception, '2026-07-31')

  // 라벨만 바뀌면 성과는 그대로
  const renamed = syncLedger(l, { ...CONFIG, strategies: [{ ...CONFIG.strategies[0], label: '새 이름' }] }, '2026-08-10')
  eq('라벨 갱신', renamed.ledger.strategies['ma20-all80'].label, '새 이름')
  eq('현금 불변', renamed.ledger.strategies['ma20-all80'].cash, 20_000_000)
}

// -------------------------------------------------------- 2) 매수/매도 반영
section('2) 매수·매도 장부 반영')
{
  const base = initLedger(CONFIG).strategies['ma20-all80']

  const b1 = applyLedgerFill(base, fill(), FREE)
  eq('거부 없음', b1.rejected, undefined)
  eq('현금 차감', b1.ledger.cash, 20_000_000 - 1_000_000)
  eq('포지션 1개', b1.ledger.positions.length, 1)
  eq('진입일 기록', b1.ledger.positions[0].entryDate, '2026-07-31')
  eq('매매기록 1건', b1.ledger.trades.length, 1)
  eq('매매기록에 전략 태그', b1.ledger.trades[0].strategyId, 'ma20-all80')
  eq('매수는 실현손익 null', b1.ledger.trades[0].realizedPnl, null)
  eq('원본 불변(순수 함수)', base.positions.length, 0)

  // 추가 매수 — 평단 재계산, 진입일은 **최초 진입일 유지**
  const b2 = applyLedgerFill(b1.ledger, fill({ date: '2026-08-03', qty: 10, price: 120_000 }), FREE)
  eq('수량 합산', b2.ledger.positions[0].qty, 20)
  close('평단 = 가중평균', b2.ledger.positions[0].avgPrice, 110_000, 1e-9)
  eq('진입일 유지', b2.ledger.positions[0].entryDate, '2026-07-31')

  // 매도 — 실현손익이 매매기록에 남는다
  const s1 = applyLedgerFill(b1.ledger, fill({ date: '2026-08-05', side: 'sell', qty: 10, price: 110_000 }), FREE)
  eq('전량 매도 시 포지션 제거', s1.ledger.positions.length, 0)
  close('실현손익 = (110k−100k)×10', s1.ledger.realizedPnl, 100_000, 1e-6)
  close('매매기록의 실현손익', s1.ledger.trades[1].realizedPnl ?? 0, 100_000, 1e-6)
  close('현금 복귀', s1.ledger.cash, 20_000_000 + 100_000, 1e-6)

  // 재진입하면 진입일은 새로
  const b3 = applyLedgerFill(s1.ledger, fill({ date: '2026-08-06' }), FREE)
  eq('재진입 진입일 갱신', b3.ledger.positions[0].entryDate, '2026-08-06')

  // 비용이 붙으면 같은 값에 팔아도 손실
  const c1 = applyLedgerFill(base, fill(), COST)
  const c2 = applyLedgerFill(c1.ledger, fill({ side: 'sell', qty: 10, price: 100_000 }), COST)
  check('수수료·거래세만큼 손실', c2.ledger.realizedPnl < 0, `${c2.ledger.realizedPnl}`)
}

// ---------------------------------------------------- 3) 관대하지 않은가
section('3) 장부가 실전보다 관대하지 않은가 (거부)')
{
  const poor: StrategyLedger = { ...initLedger(CONFIG).strategies['ma20-all80'], cash: 1_000_000 }
  const r1 = applyLedgerFill(poor, fill({ qty: 100, price: 100_000 }), FREE) // 1,000만 필요
  eq('현금 부족 거부', r1.rejected, '현금 부족')
  eq('거부 시 현금 불변', r1.ledger.cash, 1_000_000)
  eq('거부 시 매매기록 없음', r1.ledger.trades.length, 0)

  eq('보유 없는데 매도 거부', applyLedgerFill(poor, fill({ side: 'sell' }), FREE).rejected, '보유 없음')

  const held = applyLedgerFill(initLedger(CONFIG).strategies['ma20-all80'], fill({ qty: 5 }), FREE).ledger
  eq('보유 초과 매도 거부', applyLedgerFill(held, fill({ side: 'sell', qty: 10 }), FREE).rejected, '보유 수량 초과')
  eq('수량 0 거부', applyLedgerFill(held, fill({ qty: 0 }), FREE).rejected, '수량 오류')
  eq('가격 0 거부', applyLedgerFill(held, fill({ price: 0 }), FREE).rejected, '체결가 오류')
}

// ------------------------------------------------------------- 4) 슬롯 수량
section('4) 슬롯 수량 (엔진과 같은 규칙)')
{
  const s = initLedger(CONFIG).strategies['ma20-all80']
  eq('빈 장부 · 슬롯10 · 20만원 → 10주', slotQty(s, 10, 200_000, 0), 10)
  eq('수수료가 붙으면 1주 덜 산다', slotQty(s, 10, 200_000, 0.015) < 10, true)
  const half: StrategyLedger = { ...s, cash: 10_000_000, positions: Array.from({ length: 5 }, (_, i) => ({ symbol: `S${i}`, qty: 1, avgPrice: 1, costBasis: 1, entryDate: 'x' })) }
  eq('남은 현금 ÷ 남은 슬롯 (1,000만÷5=200만)', slotQty(half, 10, 200_000, 0), 10)
  eq('가격이 현금보다 크면 0주', slotQty(s, 10, 50_000_000, 0), 0)
  eq('가격 NaN 이면 0주', slotQty(s, 10, NaN, 0), 0)
}

// --------------------------------------- 5) 계좌 실보유량 부족 → 매도 축소
section('5) 계좌 실보유 부족 시 매도 축소 (장부 5개 → 계좌 1개)')
{
  const req = [
    { strategyId: 'a', qty: 10 },
    { strategyId: 'b', qty: 10 },
  ]
  const full = allocateSellQty(req, 20)
  eq('충분하면 그대로', full.map((r) => r.qty).join(','), '10,10')
  eq('축소 표식 없음', full.some((r) => r.reduced), false)

  const cut = allocateSellQty(req, 15)
  eq('합계는 계좌 보유량 이하', cut.reduce((s, r) => s + r.qty, 0) <= 15, true)
  eq('비례 축소(8/7)', cut.map((r) => r.qty).join(','), '8,7')
  eq('축소 표식', cut.every((r) => r.reduced), true)
  eq('원 요청 보존', cut.map((r) => r.requested).join(','), '10,10')

  eq('보유 0이면 전부 0주', allocateSellQty(req, 0).map((r) => r.qty).join(','), '0,0')
  eq('잔고 미상(null)이면 요청 유지', allocateSellQty(req, null).map((r) => r.qty).join(','), '10,10')

  // 비대칭 요청도 합계를 넘지 않는다
  const asym = allocateSellQty([{ strategyId: 'a', qty: 30 }, { strategyId: 'b', qty: 5 }], 7)
  eq('비대칭도 합계 ≤ 보유', asym.reduce((s, r) => s + r.qty, 0) <= 7, true)
  check('큰 요청이 더 많이 받는다', asym[0].qty >= asym[1].qty, JSON.stringify(asym))
}

// ------------------------------------ 6) 계좌 현금 부족 → 매수 축소·제외
section('6) 전략 합산 매수액이 계좌 현금을 넘지 않는가')
{
  const buys = [
    { strategyId: 'a', symbol: 'X', qty: 10, price: 1_000 },
    { strategyId: 'b', symbol: 'Y', qty: 10, price: 1_000 },
    { strategyId: 'c', symbol: 'Z', qty: 10, price: 1_000 },
  ]
  const ok = capBuysToCash(buys, 30_000)
  eq('충분하면 그대로', ok.map((b) => b.qty).join(','), '10,10,10')
  eq('메모 없음', ok.every((b) => b.note == null), true)

  const cut = capBuysToCash(buys, 15_000)
  eq('앞에서부터 채우고 줄인다', cut.map((b) => b.qty).join(','), '10,5,0')
  check('축소 사유 기록', (cut[1].note ?? '').includes('축소'), cut[1].note ?? '')
  check('제외 사유 기록', (cut[2].note ?? '').includes('제외'), cut[2].note ?? '')
  eq('총 주문액 ≤ 계좌 현금', cut.reduce((s, b) => s + b.qty * b.price, 0) <= 15_000, true)

  eq('현금 0이면 전부 제외', capBuysToCash(buys, 0).map((b) => b.qty).join(','), '0,0,0')
  eq('잔고 미상(null)이면 자르지 않는다', capBuysToCash(buys, null).map((b) => b.qty).join(','), '10,10,10')
}

// ---------------------------------------------------------- 7) 평가·자산곡선
section('7) 평가와 자산곡선')
{
  const s0 = initLedger(CONFIG).strategies['ma20-all80']
  const s1 = applyLedgerFill(s0, fill({ qty: 10, price: 100_000 }), FREE).ledger
  close('보유 평가 반영', ledgerEquity(s1, { '005930.KS': 120_000 }), 19_000_000 + 1_200_000, 1e-6)
  close('가격 없으면 평단 평가(과대평가 방지)', ledgerEquity(s1, {}), 20_000_000, 1e-6)

  const m1 = markEquity(s1, '2026-07-31', { '005930.KS': 120_000 })
  eq('자산곡선 1점', m1.equityHistory.length, 1)
  eq('값 반올림', m1.equityHistory[0].equity, 20_200_000)
  const m2 = markEquity(m1, '2026-07-31', { '005930.KS': 130_000 })
  eq('같은 날 재실행해도 점이 늘지 않는다', m2.equityHistory.length, 1)
  eq('같은 날은 덮어쓴다', m2.equityHistory[0].equity, 20_300_000)
  const m3 = markEquity(m2, '2026-08-03', { '005930.KS': 90_000 })
  eq('다음 날은 추가', m3.equityHistory.length, 2)
  eq('날짜 정렬', m3.equityHistory.map((e) => e.date).join(','), '2026-07-31,2026-08-03')
}

// -------------------------------------------- 8) 요약 집계 · 알파 (규칙 5)
section('8) 전략별 분리 성과와 벤치 대비 알파')
{
  let l = initLedger(CONFIG)
  const apply = (id: string, f: LedgerFill) => {
    const r = applyLedgerFill(l.strategies[id], f, FREE)
    check(`반영 ok (${id} ${f.side} ${f.symbol})`, r.rejected == null, r.rejected ?? '')
    l = { ...l, strategies: { ...l.strategies, [id]: r.ledger } }
  }

  // 같은 종목을 두 전략이 동시에 산다 — 계좌는 섞이지만 장부는 분리돼야 한다
  apply('ma20-all80', fill({ symbol: 'A.KS', qty: 100, price: 100_000 })) // 1,000만
  apply('ma15-all80', fill({ symbol: 'A.KS', qty: 50, price: 100_000 })) // 500만
  apply('bench-hold', fill({ symbol: '069500.KS', qty: 200, price: 100_000 })) // 2,000만

  const prices = { 'A.KS': 110_000, '069500.KS': 105_000 }
  for (const [id, s] of Object.entries(l.strategies)) l.strategies[id] = markEquity(s, '2026-07-31', prices)

  const sum = summarize(l, CONFIG, prices, '2026-07-31', { dryRun: true, now: '2026-07-31T06:20:00Z' })
  const byId = Object.fromEntries(sum.strategies.map((r) => [r.id, r]))

  eq('전략 3개 분리 집계', sum.strategies.length, 3)
  eq('벤치 전략 식별', sum.benchStrategyId, 'bench-hold')
  eq('승자 평가액', byId['ma20-all80'].equity, 20_000_000 + 100 * 10_000)
  eq('도전자 평가액', byId['ma15-all80'].equity, 20_000_000 + 50 * 10_000)
  check('같은 종목이어도 성과가 다르다(분리 유지)', byId['ma20-all80'].equity !== byId['ma15-all80'].equity)
  close('승자 수익률 +5%', byId['ma20-all80'].totalPct, 5, 1e-9)
  close('벤치 수익률 +5%', byId['bench-hold'].totalPct, 5, 1e-9)
  close('도전자 수익률 +2.5%', byId['ma15-all80'].totalPct, 2.5, 1e-9)

  eq('벤치 자신의 알파는 null', byId['bench-hold'].alphaPct, null)
  close('승자 알파 = 5 − 5 = 0%p', byId['ma20-all80'].alphaPct ?? NaN, 0, 1e-9)
  close('도전자 알파 = 2.5 − 5 = −2.5%p', byId['ma15-all80'].alphaPct ?? NaN, -2.5, 1e-9)
  eq('짧은 구간은 연환산 알파를 내지 않는다', byId['ma20-all80'].alphaAnnualizedPct, null)

  eq('합계 초기자본', sum.totals.initialCapital, 60_000_000)
  eq('dryRun 표기', sum.dryRun, true)
  check('데이터 한계 고지 포함(체결 가정)', sum.dataNote.includes('체결가로 가정'))
  check('투자자문 아님 고지 포함', sum.disclaimer.includes('투자자문이 아니다'))
  eq('오늘 주문이 전략별로 붙는다', byId['ma20-all80'].todayOrders.length, 1)
  eq('다른 날 주문은 안 붙는다', summarize(l, CONFIG, prices, '2026-08-04', { dryRun: true }).strategies[0].todayOrders.length, 0)
}

// --------------------------------------------------- 9) 승률·MDD·retired
section('9) 승률 · 최대낙폭 · 퇴역 표기')
{
  let s = initLedger(CONFIG).strategies['ma20-all80']
  // 2승 1패
  const round = (sym: string, buy: number, sell: number) => {
    s = applyLedgerFill(s, fill({ symbol: sym, qty: 10, price: buy }), FREE).ledger
    s = applyLedgerFill(s, fill({ symbol: sym, side: 'sell', qty: 10, price: sell }), FREE).ledger
  }
  round('A.KS', 100_000, 110_000)
  round('B.KS', 100_000, 120_000)
  round('C.KS', 100_000, 90_000)
  s = { ...s, equityHistory: [
    { date: '2026-07-31', equity: 20_000_000 },
    { date: '2026-08-03', equity: 24_000_000 },
    { date: '2026-08-04', equity: 18_000_000 },
  ] }

  const l = { ...initLedger(CONFIG), strategies: { ...initLedger(CONFIG).strategies, 'ma20-all80': s, 'old-strat': { ...s, id: 'old-strat', label: '퇴역 전략' } } }
  const sum = summarize(l, CONFIG, {}, '2026-08-04', { dryRun: false })
  const row = sum.strategies.find((r) => r.id === 'ma20-all80')!

  eq('청산 3건', row.closedTrades, 3)
  close('승률 2/3', row.winRatePct ?? 0, 66.7, 0.05)
  close('MDD = 18/24−1 = −25%', row.mddPct, -25, 1e-9)
  eq('config 에 있는 전략은 retired=false', row.retired, false)
  eq('config 에서 빠진 전략은 retired=true', sum.strategies.find((r) => r.id === 'old-strat')!.retired, true)
  eq('live 모드 표기', sum.dryRun, false)
}

// ------------------------------- 10) 오늘 스크리닝 (규칙 1 — 절단 불변성)
section('10) 오늘 진입 스크리닝 · 절단 불변성')
{
  // 평평하다가 마지막 날 급등 → MA20 상향돌파 + 20일 신고가. 거래량은 종목마다 다르게.
  const mkBars = (base: number, vol: number, jump: boolean): DailyBar[] => {
    const out: DailyBar[] = []
    for (let i = 0; i < 60; i++) {
      const last = i === 59
      const c = last && jump ? base * 1.2 : base
      const date = new Date(Date.UTC(2026, 4, 1) + i * 86400e3).toISOString().slice(0, 10)
      out.push({ date, t: Date.parse(date) / 1000, o: c, h: c, l: c, c, v: vol })
    }
    return out
  }
  const day = (i: number) => new Date(Date.UTC(2026, 4, 1) + i * 86400e3).toISOString().slice(0, 10)
  const histories: Record<string, DailyBar[]> = {
    'A.KS': mkBars(10_000, 1_000, true), // 급등 + 거래대금 중
    'B.KS': mkBars(20_000, 5_000, true), // 급등 + 거래대금 최대
    'C.KS': mkBars(10_000, 1_000, false), // 급등 없음 → 탈락
  }
  const spec = {
    version: 1,
    id: 'test',
    name: 'test',
    universe: {
      markets: ['KOSPI'],
      excludeAdministrative: true,
      excludeSuspended: true,
      excludeLiquidation: true,
      excludePreferred: true,
      excludeEtf: true,
      symbols: ['A.KS', 'B.KS', 'C.KS'],
    },
    entry: {
      op: 'and',
      nodes: [
        { op: 'cond', id: 'ma', cond: { kind: 'maCross', period: 20, dir: 'above' } },
        { op: 'cond', id: 'hi', cond: { kind: 'highBreak', days: 20 } },
      ],
    },
    ranking: { by: 'tradingValue', dir: 'desc' },
    exits: [{ kind: 'maBreak', maPeriod: 40, pct: 2 }],
    sizing: { maxPositions: 10, mode: 'equalSlot' },
    execution: { timing: 'sameClose', orderType: 'market' },
  } as const

  const last = day(59)
  const screen = screenOnDate(histories, spec as never, last)
  eq('통과 2종목', screen.passed.length, 2)
  eq('거래대금 큰 쪽이 먼저(랭킹)', screen.passed[0], 'B.KS')
  check('조건 미달 종목은 탈락', !screen.passed.includes('C.KS'))
  check('탈락 사유가 남는다', (screen.rows.find((r) => r.symbol === 'C.KS')?.reasons.length ?? 0) > 0)

  // 엔진은 마지막 봉에 진입을 만들지 않는다 — 이 함수가 필요한 이유(회귀 방지)
  const engine = runStrategySpec(histories, day(40), spec as never, {
    initialCapital: 10_000_000,
    feePct: 0,
    taxPct: 0,
    slippagePct: 0,
  })
  eq('엔진의 마지막 봉 신규 진입 = 0건 (규칙 1-6)', engine.trades.filter((t) => t.entryDate === last).length, 0)

  // 절단 불변성: 그 날 이후 봉이 있든 없든 그 날의 판정은 같아야 한다(규칙 1)
  const mid = day(50)
  const full = screenOnDate(histories, spec as never, mid)
  const truncated = screenOnDate(
    Object.fromEntries(Object.entries(histories).map(([k, v]) => [k, v.slice(0, 51)])),
    spec as never,
    mid,
  )
  eq(
    '뒷부분을 잘라도 그 날 스크리닝 결과가 동일',
    JSON.stringify(full.rows),
    JSON.stringify(truncated.rows),
  )
  const lastFull = screenOnDate(histories, spec as never, last)
  const lastTrunc = screenOnDate(
    Object.fromEntries(Object.entries(histories).map(([k, v]) => [k, v.slice(0, 60)])),
    spec as never,
    last,
  )
  eq('마지막 날도 동일', JSON.stringify(lastFull.passed), JSON.stringify(lastTrunc.passed))

  // 그날 봉이 없는 종목은 판정 대상에서 빠진다(휴장·정지)
  const missing = screenOnDate({ ...histories, 'D.KS': mkBars(10_000, 1_000, true).slice(0, 30) }, spec as never, last)
  check('유니버스 밖 종목은 무시', !missing.passed.includes('D.KS'))
}

finish()
