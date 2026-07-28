// 페이퍼 트레이딩 저널 검증.
// 핵심: 페이퍼가 실전보다 관대하면 의미가 없다 — 현금 부족·보유 초과를 거부하는가,
//       평단·실현손익이 맞는가, 체결 괴리를 올바른 부호로 재는가.

import { check, close, eq, finish, section } from './harness'
import {
  applyFill,
  effectivePrice,
  newJournal,
  valuate,
  type PaperCost,
  type PaperFill,
} from '../src/features/backtest/paperTrading'

const COST: PaperCost = { feePct: 0.015, taxPct: 0.15 }
const FREE: PaperCost = { feePct: 0, taxPct: 0 }

function fill(over: Partial<PaperFill> = {}): PaperFill {
  return {
    signalAt: '2026-07-28T15:30:00+09:00',
    filledAt: '2026-07-29T09:00:00+09:00',
    symbol: '000660',
    side: '매수',
    qty: 10,
    assumedPrice: 100_000,
    actualPrice: null,
    reason: '조건식 편입',
    ...over,
  }
}

// ------------------------------------------------------------- 1) 매수·평단
section('1) 매수와 평단')
{
  const j0 = newJournal('cond', 10_000_000, '2026-07-28')
  eq('초기 현금 = 초기자본', j0.cash, 10_000_000)

  const { journal: j1, rejected } = applyFill(j0, fill(), FREE)
  eq('거부 없음', rejected, undefined)
  eq('현금 차감', j1.cash, 10_000_000 - 1_000_000)
  eq('포지션 1개', j1.positions.length, 1)
  eq('수량', j1.positions[0].qty, 10)
  close('평단 = 체결가(수수료 0)', j1.positions[0].avgPrice, 100_000, 1e-9)

  // 추가 매수 → 평단 재계산
  const { journal: j2 } = applyFill(j1, fill({ qty: 10, assumedPrice: 120_000 }), FREE)
  eq('수량 합산', j2.positions[0].qty, 20)
  close('평단 = 가중평균', j2.positions[0].avgPrice, 110_000, 1e-9)

  // 수수료가 평단에 포함되는가
  const { journal: jf } = applyFill(newJournal('c', 10_000_000, 'x'), fill(), COST)
  check('수수료가 평단에 반영(체결가보다 큼)', jf.positions[0].avgPrice > 100_000)
  close('평단 = (원금+수수료)/수량', jf.positions[0].avgPrice, (1_000_000 * 1.00015) / 10, 1e-6)

  // 원본 불변
  eq('원본 저널 불변', j0.positions.length, 0)
  eq('원본 현금 불변', j0.cash, 10_000_000)
}

// --------------------------------------------------------------- 2) 거부
section('2) 관대하지 않은가 (거부 동작)')
{
  const j = newJournal('c', 1_000_000, 'x')
  const r1 = applyFill(j, fill({ qty: 100, assumedPrice: 100_000 }), FREE) // 1,000만 필요
  eq('현금 부족은 거부', r1.rejected, '현금 부족')
  eq('거부 시 저널 불변', r1.journal.cash, 1_000_000)
  eq('거부 시 체결 기록 안 남음', r1.journal.fills.length, 0)

  const r2 = applyFill(j, fill({ side: '매도', qty: 1 }), FREE)
  eq('보유 없는데 매도는 거부', r2.rejected, '보유 없음')

  const { journal: bought } = applyFill(newJournal('c', 10_000_000, 'x'), fill({ qty: 5 }), FREE)
  const r3 = applyFill(bought, fill({ side: '매도', qty: 10 }), FREE)
  eq('보유 초과 매도는 거부', r3.rejected, '보유 수량 초과')

  eq('수량 0은 거부', applyFill(j, fill({ qty: 0 }), FREE).rejected, '수량 오류')
  eq('음수 수량 거부', applyFill(j, fill({ qty: -5 }), FREE).rejected, '수량 오류')
  eq('가격 0은 거부', applyFill(j, fill({ assumedPrice: 0 }), FREE).rejected, '체결가 오류')
  eq('NaN 가격 거부', applyFill(j, fill({ assumedPrice: NaN }), FREE).rejected, '체결가 오류')
}

// ---------------------------------------------------------- 3) 매도·실현손익
section('3) 매도와 실현손익')
{
  const j0 = newJournal('c', 10_000_000, 'x')
  const { journal: j1 } = applyFill(j0, fill({ qty: 10, assumedPrice: 100_000 }), FREE)
  const { journal: j2 } = applyFill(j1, fill({ side: '매도', qty: 10, assumedPrice: 110_000 }), FREE)

  eq('전량 매도 시 포지션 제거', j2.positions.length, 0)
  close('실현손익 = (110k−100k)×10', j2.realizedPnl, 100_000, 1e-6)
  close('현금 복귀', j2.cash, 10_000_000 + 100_000, 1e-6)

  // 부분 매도
  const { journal: p1 } = applyFill(j0, fill({ qty: 10, assumedPrice: 100_000 }), FREE)
  const { journal: p2 } = applyFill(p1, fill({ side: '매도', qty: 4, assumedPrice: 120_000 }), FREE)
  eq('부분 매도 후 잔량', p2.positions[0].qty, 6)
  close('평단은 유지', p2.positions[0].avgPrice, 100_000, 1e-9)
  close('실현손익 = (120k−100k)×4', p2.realizedPnl, 80_000, 1e-6)

  // 세금·수수료가 실현손익을 깎는가
  const { journal: t1 } = applyFill(newJournal('c', 10_000_000, 'x'), fill({ qty: 10 }), COST)
  const { journal: t2 } = applyFill(t1, fill({ side: '매도', qty: 10, assumedPrice: 100_000 }), COST)
  check('같은 가격에 팔면 비용만큼 손실', t2.realizedPnl < 0, `${t2.realizedPnl}`)
}

// -------------------------------------------------------------- 4) 평가
section('4) 평가(valuation)')
{
  const j0 = newJournal('c', 10_000_000, 'x')
  const { journal: j1 } = applyFill(j0, fill({ qty: 10, assumedPrice: 100_000 }), FREE)

  const v = valuate(j1, { '000660': 120_000 })
  close('보유 평가액', v.holdingsValue, 1_200_000, 1e-6)
  close('총자산 = 현금 + 보유', v.equity, 9_000_000 + 1_200_000, 1e-6)
  close('미실현 손익', v.unrealizedPnl, 200_000, 1e-6)
  close('총수익률', v.totalReturnPct, ((10_200_000 / 10_000_000) - 1) * 100, 1e-9)

  // 가격 없는 종목은 평단으로 — 과대평가 방지
  const vNo = valuate(j1, {})
  close('가격 없으면 평단 평가', vNo.holdingsValue, 1_000_000, 1e-6)
  close('그때 미실현 = 0', vNo.unrealizedPnl, 0, 1e-9)

  const vBad = valuate(j1, { '000660': NaN })
  close('NaN 가격도 평단 폴백', vBad.holdingsValue, 1_000_000, 1e-6)
}

// ------------------------------------------------ 5) 체결 괴리 (핵심 목적)
section('5) 실제 체결가 대비 괴리')
{
  const j0 = newJournal('c', 100_000_000, 'x')

  // 매수를 가정보다 비싸게 → 불리(+)
  const { journal: a } = applyFill(j0, fill({ assumedPrice: 100_000, actualPrice: 102_000 }), FREE)
  const va = valuate(a, {})
  close('매수 2% 비싸게 → +2%p 불리', va.slippageVsAssumedPct!, 2, 1e-9)
  eq('실제가 입력 건수', va.actualEnteredCount, 1)

  // 매도를 가정보다 싸게 → 불리(+)
  const { journal: b } = applyFill(a, fill({ side: '매도', qty: 10, assumedPrice: 100_000, actualPrice: 98_000 }), FREE)
  const vb = valuate(b, {})
  close('매수+2 / 매도-2 → 평균 +2%p 불리', vb.slippageVsAssumedPct!, 2, 1e-9)

  // 실제가 미입력이면 괴리 계산 안 함
  const { journal: c } = applyFill(newJournal('c', 100_000_000, 'x'), fill(), FREE)
  eq('실제가 없으면 null', valuate(c, {}).slippageVsAssumedPct, null)

  // 체결가는 실제가 우선
  close('실제가 우선', effectivePrice(fill({ assumedPrice: 100, actualPrice: 111 })), 111, 1e-9)
  close('없으면 가정가', effectivePrice(fill({ assumedPrice: 100 })), 100, 1e-9)
}

// ------------------------------------------------------- 6) 근거 보존
section('6) 시그널 근거가 남는가')
{
  const j0 = newJournal('cond-screen', 10_000_000, '2026-07-28')
  const { journal: j1 } = applyFill(j0, fill({ reason: '등락률 상위 + 5일선 돌파' }), FREE)
  eq('체결 기록 1건', j1.fills.length, 1)
  eq('근거 보존', j1.fills[0].reason, '등락률 상위 + 5일선 돌파')
  check('시그널 시각과 체결 시각이 분리 보존', j1.fills[0].signalAt !== j1.fills[0].filledAt)
  eq('전략 id 유지', j1.strategyId, 'cond-screen')
}

finish()
