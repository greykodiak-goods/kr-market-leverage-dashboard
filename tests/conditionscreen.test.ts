// HTS 조건검색식(급등주 단타) 엔진 검증.
//
// 이 테스트가 지키는 것:
//   - 조건 A·B·J·K 각각이 의도대로 걸러지는가
//   - 손절·익절 체결이 보수적인가 (갭 관통 시 시가)
//   - 신호 → 익일 시가 체결이 지켜지는가
//   - 절단 불변성 (규칙 1) — 뒤를 잘라도 앞 매매가 동일한가
//   - 매도 규칙이 실제로 결과를 바꾸는가 (= 비교가 의미 있는가)

import { check, close, eq, finish, rng, section } from './harness'
import type { DailyBar } from '../src/features/backtest/types'
import {
  checkConditions,
  compareExits,
  DEFAULT_CONDITION,
  exitRuleLabel,
  runConditionScreen,
  smaAt,
  type ConditionParams,
  type CostSettings,
} from '../src/features/backtest/conditionScreen'

const COST: CostSettings = { initialCapital: 10_000_000, feePct: 0.015, taxPct: 0.15, slippagePct: 0.1 }
const NOCOST: CostSettings = { initialCapital: 10_000_000, feePct: 0, taxPct: 0, slippagePct: 0 }

function d(i: number): string {
  return new Date(Date.UTC(2024, 0, 1) + i * 86400000).toISOString().slice(0, 10)
}

function bar(i: number, o: number, h: number, l: number, c: number, v = 1_000_000): DailyBar {
  return { date: d(i), o, h, l, c, v }
}

/** 평탄한 가격에서 특정 날만 조건을 만족시키는 시계열 */
function flatThenBreakout(n: number, breakAt: number, opts: Partial<{ vol: number; close: number }> = {}): DailyBar[] {
  const out: DailyBar[] = []
  for (let i = 0; i < n; i++) {
    if (i === breakAt) {
      // 이평 위로 돌파 + 양봉 + 거래량 충분
      const c = opts.close ?? 11000
      out.push(bar(i, 10000, c + 200, 9900, c, opts.vol ?? 1_000_000))
    } else if (i > breakAt) {
      const base = opts.close ?? 11000
      out.push(bar(i, base, base + 100, base - 100, base, 1_000_000))
    } else {
      out.push(bar(i, 10000, 10100, 9900, 10000, 1_000_000))
    }
  }
  return out
}

// ------------------------------------------------------------------ 1) SMA
section('1) 이평 계산 (인과성)')
{
  const bars = Array.from({ length: 10 }, (_, i) => bar(i, 100, 100, 100, 100 + i))
  eq('기간 미달이면 null', smaAt(bars, 2, 5), null)
  close('5일 이평 = 최근 5봉 평균', smaAt(bars, 4, 5)!, (100 + 101 + 102 + 103 + 104) / 5, 1e-9)
  close('한 칸 뒤', smaAt(bars, 5, 5)!, (101 + 102 + 103 + 104 + 105) / 5, 1e-9)

  // 뒤쪽 봉을 조작해도 앞 인덱스 값은 안 변한다
  const tampered = [...bars]
  tampered[9] = bar(9, 999, 999, 999, 999999)
  close('뒤 봉 조작 → 앞 이평 불변', smaAt(tampered, 4, 5)!, smaAt(bars, 4, 5)!, 1e-9)
}

// ------------------------------------------------------- 2) 조건 A·B·J·K
section('2) 개별 조건 판정')
{
  const p = { ...DEFAULT_CONDITION }
  const bars = flatThenBreakout(20, 10)
  const ok = checkConditions(bars, 10, p)
  check('돌파일 A 통과(가격대)', ok.A)
  check('돌파일 B 통과(양봉)', ok.B)
  check('돌파일 J 통과(5일선 상향돌파)', ok.J, ok.reasons.join(','))
  check('돌파일 K 통과(거래량)', ok.K)
  check('등락률 산출됨', ok.changePct != null && ok.changePct > 0)

  // A — 가격대 밖
  const cheap = checkConditions(flatThenBreakout(20, 10, { close: 1500 }), 10, p)
  check('저가주는 A 탈락', !cheap.A)
  check('탈락 사유 표기', cheap.reasons.some((r) => r.includes('가격대')))

  // B — 음봉
  const bearish = [...bars]
  bearish[10] = bar(10, 11500, 11600, 10800, 11000, 1_000_000) // 종가 < 시가
  check('음봉은 B 탈락', !checkConditions(bearish, 10, p).B)

  // J — 이미 이평 위(신규 돌파 아님)
  check('돌파 다음날은 J 탈락(이미 위)', !checkConditions(bars, 11, p).J)
  check('그 사유가 명시됨', checkConditions(bars, 11, p).reasons.some((r) => r.includes('신규 돌파 아님')))

  // K — 거래량 미달
  const thin = checkConditions(flatThenBreakout(20, 10, { vol: 1000 }), 10, p)
  check('거래량 미달은 K 탈락', !thin.K)

  // 이평 데이터 부족
  check('초반 봉은 이평 부족으로 J 불가', !checkConditions(bars, 1, p).J)
}

// ------------------------------------------------- 3) 신호 → 익일 시가 체결
section('3) 신호 → 익일 시가 체결 (규칙 1-2)')
{
  const p: ConditionParams = { ...DEFAULT_CONDITION, maxPositions: 1, exits: [{ kind: 'timeExit', days: 3 }] }
  const bars = flatThenBreakout(30, 10)
  // 돌파 다음날 시가를 특이값으로 둬서 그 가격에 체결됐는지 확인
  bars[11] = bar(11, 12345, 12500, 12000, 12400, 1_000_000)
  const r = runConditionScreen({ AAA: bars }, d(0), p, NOCOST)

  const buy = r.events.find((e) => e.action === '매수')
  check('매수 발생', !!buy)
  eq('체결일 = 돌파 다음날', buy!.date, d(11))
  close('체결가 = 그날 시가', buy!.price, 12345, 1e-9)
  check('종가가 아님', buy!.price !== 12400)
}

// --------------------------------------------------- 4) 손절·익절 보수성
section('4) 청산 체결 보수성 (규칙 1-4)')
{
  const p: ConditionParams = {
    ...DEFAULT_CONDITION,
    maxPositions: 1,
    exits: [{ kind: 'stopLoss', pct: 5 }],
  }
  const bars = flatThenBreakout(30, 10)
  bars[11] = bar(11, 10000, 10100, 9900, 10000, 1_000_000) // 진입 시가 10000
  // 12일: 장중 저가가 손절선(9500)을 터치하되 갭은 없음 → 기준가 체결
  bars[12] = bar(12, 9900, 9950, 9400, 9600, 1_000_000)
  const touch = runConditionScreen({ AAA: bars }, d(0), p, NOCOST)
  const sell1 = touch.events.find((e) => e.action === '매도')
  check('손절 발동', !!sell1)
  close('기준선(−5%)에서 체결', sell1!.price, 9500, 1e-6)

  // 갭 관통 — 시가가 이미 손절선 아래 → 시가(더 불리)로 체결
  const gap = flatThenBreakout(30, 10)
  gap[11] = bar(11, 10000, 10100, 9900, 10000, 1_000_000)
  gap[12] = bar(12, 9000, 9100, 8800, 8900, 1_000_000) // 시가 9000 < 9500
  const gapRun = runConditionScreen({ AAA: gap }, d(0), p, NOCOST)
  const sell2 = gapRun.events.find((e) => e.action === '매도')
  close('갭 관통 시 시가 체결', sell2!.price, 9000, 1e-6)
  check('유리한 기준가로 체결하지 않음', sell2!.price < 9500)
}

// ------------------------------------------------------- 5) 매도 규칙 효과
section('5) 매도 규칙이 결과를 바꾸는가')
{
  const bars = flatThenBreakout(60, 10)
  bars[11] = bar(11, 10000, 10100, 9900, 10000, 1_000_000)
  // 진입 후 급등했다가 되돌림 — 매도 규칙에 따라 결과가 갈려야 한다
  for (let i = 12; i <= 20; i++) bars[i] = bar(i, 10000 + (i - 11) * 300, 10000 + (i - 11) * 350, 9900 + (i - 11) * 250, 10000 + (i - 11) * 300, 1_000_000)
  for (let i = 21; i <= 40; i++) bars[i] = bar(i, 12700 - (i - 20) * 250, 12800 - (i - 20) * 250, 12500 - (i - 20) * 260, 12700 - (i - 20) * 250, 1_000_000)

  const base: ConditionParams = { ...DEFAULT_CONDITION, maxPositions: 1, exits: [] }
  const rows = compareExits({ AAA: bars }, d(0), base, NOCOST)
  eq('프리셋 9종 비교', rows.length, 9)

  const trailing = rows.find((r) => r.label === '트레일링 −5%')!
  const noExit = rows.find((r) => r.label === '청산 없음(대조군)')!
  check('트레일링이 청산없음과 다른 결과', Math.abs(trailing.totalReturnPct - noExit.totalReturnPct) > 1e-9)
  check('되돌림 구간에서 트레일링이 방어', trailing.totalReturnPct > noExit.totalReturnPct, `${trailing.totalReturnPct} vs ${noExit.totalReturnPct}`)

  const tp = rows.find((r) => r.label === '손절 −3% + 익절 +5%')!
  check('익절 조합은 매매 발생', tp.tradeCount >= 1)
  check('모든 행에 MDD ≤ 0', rows.every((r) => r.mddPct <= 0))
  check('승률 0~100 범위', rows.every((r) => r.winRatePct >= 0 && r.winRatePct <= 100))
}

// -------------------------------------------------------- 6) 비용의 영향
section('6) 비용이 수익을 먹는가 (단타의 핵심)')
{
  const bars = flatThenBreakout(80, 10)
  // 반복 진입/청산이 나오도록 5일선을 계속 오르내리게 만든다
  for (let i = 11; i < 80; i++) {
    const up = Math.floor((i - 11) / 3) % 2 === 0
    const px = up ? 11000 : 10500
    bars[i] = bar(i, px, px + 150, px - 150, up ? px + 100 : px - 100, 1_000_000)
  }
  const p: ConditionParams = { ...DEFAULT_CONDITION, maxPositions: 1, exits: [{ kind: 'timeExit', days: 1 }] }
  const free = runConditionScreen({ AAA: bars }, d(0), p, NOCOST)
  const paid = runConditionScreen({ AAA: bars }, d(0), p, COST)

  const eqOf = (r: typeof free) => (r.equity.length ? r.equity[r.equity.length - 1].equity : 0)
  check('매매가 여러 번 발생', free.trades.length >= 2, `${free.trades.length}`)
  check('비용 반영 시 결과가 더 나쁨', eqOf(paid) < eqOf(free), `${eqOf(paid)} vs ${eqOf(free)}`)
}

// ------------------------------------------ 7) 절단 불변성 (규칙 1 집행)
section('7) 절단 불변성 (미래참조 금지)')
{
  const r = rng(17)
  const mk = (seed: number): DailyBar[] => {
    const g = rng(seed)
    const out: DailyBar[] = []
    let px = 10000
    for (let i = 0; i < 300; i++) {
      const ret = 0.03 * (g() * 2 - 1)
      const o = px
      const c = px * (1 + ret)
      out.push(bar(i, o, Math.max(o, c) * 1.01, Math.min(o, c) * 0.99, c, 500_000 + Math.floor(g() * 2_000_000)))
      px = c
    }
    return out
  }
  const hist = { AAA: mk(1), BBB: mk(2), CCC: mk(3) }
  const p: ConditionParams = {
    ...DEFAULT_CONDITION,
    topRank: 3,
    maxPositions: 2,
    exits: [{ kind: 'stopLoss', pct: 3 }, { kind: 'maBreak', maPeriod: 5 }],
  }

  const CUT = 200
  const truncated = {
    AAA: hist.AAA.slice(0, CUT),
    BBB: hist.BBB.slice(0, CUT),
    CCC: hist.CCC.slice(0, CUT),
  }
  const full = runConditionScreen(hist, d(0), p, COST)
  const cut = runConditionScreen(truncated, d(0), p, COST)

  // 잘린 시점 이전의 매매가 완전히 같아야 한다
  const fullBefore = full.events.filter((e) => e.date < d(CUT - 1))
  const cutBefore = cut.events.filter((e) => e.date < d(CUT - 1))
  eq('절단 전 체결 건수 동일', cutBefore.length, fullBefore.length)
  let same = true
  for (let i = 0; i < cutBefore.length; i++) {
    const a = cutBefore[i]
    const b = fullBefore[i]
    if (a.date !== b.date || a.action !== b.action || a.symbol !== b.symbol || Math.abs(a.price - b.price) > 1e-9) same = false
  }
  check('절단 전 체결 내역 완전 일치', same)

  // 자산곡선도 동일
  let eqSame = true
  for (let i = 0; i < cut.equity.length - 1; i++) {
    if (cut.equity[i].date !== full.equity[i].date) { eqSame = false; break }
    if (Math.abs(cut.equity[i].equity - full.equity[i].equity) > 1e-6) { eqSame = false; break }
  }
  check('절단 전 자산곡선 일치', eqSame)

  check('결정적 재실행', JSON.stringify(runConditionScreen(hist, d(0), p, COST).trades) === JSON.stringify(full.trades))
  void r
}

// ------------------------------------------------- 8) 마지막 봉 진입 금지
section('8) 마지막 봉 신규 신호 금지 (규칙 1-6)')
{
  // 규칙 1-6이 금지하는 건 "마지막 봉에서 **신호를 만드는 것**"이다.
  // 체결할 다음 봉이 없기 때문. 반대로 직전 봉 신호가 마지막 봉 시가에 체결되는 건
  // 정당하다 — 그 시가는 신호 시점 이후에 실제로 존재한 가격이다.
  const p: ConditionParams = { ...DEFAULT_CONDITION, maxPositions: 1, exits: [] }

  // (a) 마지막 봉에서 조건이 성립해도 신호를 만들지 않는다
  const lastBreak = flatThenBreakout(20, 19) // 마지막 봉에서 돌파
  const rLast = runConditionScreen({ AAA: lastBreak }, d(0), p, NOCOST)
  const lastDate = lastBreak[lastBreak.length - 1].date
  check('마지막 봉은 스크리닝 대상이 아님', rLast.lastScreenDate !== lastDate, rLast.lastScreenDate)
  check('마지막 봉 신호로 인한 매수 없음', rLast.events.filter((e) => e.action === '매수').length === 0)

  // (b) 직전 봉 신호 → 마지막 봉 시가 체결은 허용된다
  const prevBreak = flatThenBreakout(20, 18)
  const rPrev = runConditionScreen({ AAA: prevBreak }, d(0), p, NOCOST)
  const buy = rPrev.events.find((e) => e.action === '매수')
  check('직전 봉 신호는 마지막 봉 시가에 체결', !!buy && buy.date === lastDate, buy?.date)
  if (buy) close('체결가 = 마지막 봉 시가', buy.price, prevBreak[19].o, 1e-9)
}

// ---------------------------------------------------------- 9) 부가 검증
section('9) 라벨·집계')
{
  eq('손절 라벨', exitRuleLabel({ kind: 'stopLoss', pct: 3 }), '손절 −3%')
  eq('이평이탈 라벨', exitRuleLabel({ kind: 'maBreak', maPeriod: 5 }), '5일선 이탈')
  eq('당일청산 라벨', exitRuleLabel({ kind: 'sameDayClose' }), '당일 종가 청산')
  eq('기간 라벨', exitRuleLabel({ kind: 'timeExit', days: 3 }), '3일 보유 후 청산')

  const bars = flatThenBreakout(40, 10)
  bars[11] = bar(11, 10000, 10100, 9900, 10000, 1_000_000)
  bars[12] = bar(12, 9900, 9950, 9000, 9100, 1_000_000)
  const r = runConditionScreen(
    { AAA: bars },
    d(0),
    { ...DEFAULT_CONDITION, maxPositions: 1, exits: [{ kind: 'stopLoss', pct: 5 }] },
    NOCOST,
  )
  check('청산 사유 집계 존재', r.exitBreakdown.length >= 1)
  eq('손절로 집계', r.exitBreakdown[0].kind, 'stopLoss')
  check('평균 손익 음수(손절이므로)', (r.exitBreakdown[0].avgPnlPct ?? 0) < 0)
  check('스크리닝 결과 보존', r.lastScreen.length >= 1)
}

finish()
