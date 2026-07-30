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
  paramsToSpec,
  runConditionScreen,
  runStrategySpec,
  smaAt,
  type ConditionParams,
  type CostSettings,
} from '../src/features/backtest/conditionScreen'
import { SPEC_VERSION, type StrategySpec } from '../src/features/backtest/strategySpec'

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
  eq('프리셋 11종 비교', rows.length, 11)
  check('조건 이탈 프리셋 포함', rows.some((r) => r.label === '조건 이탈'))
  check('손절+조건이탈 조합 포함', rows.some((r) => r.label === '손절 −3% + 조건 이탈'))

  const trailing = rows.find((r) => r.label === '트레일링 −5%')!
  const noExit = rows.find((r) => r.label === '청산 없음(대조군)')!
  check('트레일링이 청산없음과 다른 결과', Math.abs(trailing.totalReturnPct - noExit.totalReturnPct) > 1e-9)
  check('되돌림 구간에서 트레일링이 방어', trailing.totalReturnPct > noExit.totalReturnPct, `${trailing.totalReturnPct} vs ${noExit.totalReturnPct}`)

  const tp = rows.find((r) => r.label === '손절 −3% + 익절 +5%')!
  check('익절 조합은 매매 발생', tp.tradeCount >= 1)
  check('모든 행에 MDD ≤ 0', rows.every((r) => r.mddPct <= 0))
  check('승률 0~100 범위', rows.every((r) => r.winRatePct >= 0 && r.winRatePct <= 100))
}

// -------------------------------------------- 5-1) 조건 이탈 매도 규칙
section('5-1) 조건 이탈(conditionExit) 규칙')
{
  eq('라벨', exitRuleLabel({ kind: 'conditionExit' }), '조건 이탈 시 청산')

  // 진입 후 이평 아래로 무너지면 이탈로 청산돼야 한다
  const bars = flatThenBreakout(40, 10)
  bars[11] = bar(11, 11000, 11100, 10900, 11000, 1_000_000) // 진입일
  bars[12] = bar(12, 11000, 11050, 10900, 11000, 1_000_000)
  for (let i = 13; i <= 25; i++) bars[i] = bar(i, 9000, 9100, 8900, 9000, 1_000_000) // 이평 아래로 붕괴
  const r = runConditionScreen(
    { AAA: bars },
    d(0),
    { ...DEFAULT_CONDITION, maxPositions: 1, exits: [{ kind: 'conditionExit' }] },
    NOCOST,
  )
  const sell = r.events.find((e) => e.action === '매도')
  check('조건 이탈로 청산됨', !!sell, JSON.stringify(r.exitBreakdown))
  eq('청산 사유가 조건 이탈', r.exitBreakdown[0]?.kind, 'conditionExit')
  check('익일 시가 체결(종가 아님)', !!sell && sell.price === bars.find((b) => b.date === sell.date)!.o)

  // 조건이 유지되면 청산되지 않는다 — 규칙이 아무때나 발동하면 안 된다
  const hold = flatThenBreakout(40, 10)
  for (let i = 11; i <= 39; i++) hold[i] = bar(i, 11500, 11600, 11400, 11500, 1_000_000) // 계속 이평 위
  const rHold = runConditionScreen(
    { AAA: hold },
    d(0),
    { ...DEFAULT_CONDITION, maxPositions: 1, exits: [{ kind: 'conditionExit' }] },
    NOCOST,
  )
  check('조건 유지 중엔 청산 안 함', !rHold.events.some((e) => e.action === '매도'))

  // 거래량이 말라도 이탈로 본다(K 조건 위반)
  const dry = flatThenBreakout(40, 10)
  dry[11] = bar(11, 11000, 11100, 10900, 11000, 1_000_000)
  for (let i = 12; i <= 25; i++) dry[i] = bar(i, 11500, 11600, 11400, 11500, 100) // 이평 위지만 거래량 붕괴
  const rDry = runConditionScreen(
    { AAA: dry },
    d(0),
    { ...DEFAULT_CONDITION, maxPositions: 1, exits: [{ kind: 'conditionExit' }] },
    NOCOST,
  )
  check('거래량 붕괴도 이탈로 판정', rDry.events.some((e) => e.action === '매도'))
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

// ---------------------------------------------- 9-1) 이탈 버퍼 (maBreak pct)
section('9-1) 5일선 이탈 버퍼 — 살짝 스치면 보유, 확실히 깨지면 매도')
{
  // 진입 후 종가가 이평 대비 약 −1%까지만 내려가는 시계열
  const mk = (dipPct: number): DailyBar[] => {
    const bars = flatThenBreakout(40, 10)
    bars[11] = bar(11, 11000, 11100, 10900, 11000, 1_000_000)
    // 12일 이후: 이평(≈11000) 아래로 dipPct%만큼 내려간 종가 유지
    const c = 11000 * (1 - dipPct / 100)
    for (let i = 12; i <= 25; i++) bars[i] = bar(i, c, c + 50, c - 50, c, 1_000_000)
    return bars
  }
  const noBuffer = runConditionScreen(
    { AAA: mk(1) },
    d(0),
    { ...DEFAULT_CONDITION, maxPositions: 1, exits: [{ kind: 'maBreak', maPeriod: 5 }] },
    NOCOST,
  )
  check('버퍼 없음 → 얕은 이탈에도 청산', noBuffer.events.some((e) => e.action === '매도'))

  const withBuffer = runConditionScreen(
    { AAA: mk(1) },
    d(0),
    { ...DEFAULT_CONDITION, maxPositions: 1, exits: [{ kind: 'maBreak', maPeriod: 5, pct: 3 }] },
    NOCOST,
  )
  check('버퍼 3% → 얕은 이탈(−1%)은 보유 유지', !withBuffer.events.some((e) => e.action === '매도'))

  const deepBreak = runConditionScreen(
    { AAA: mk(8) },
    d(0),
    { ...DEFAULT_CONDITION, maxPositions: 1, exits: [{ kind: 'maBreak', maPeriod: 5, pct: 3 }] },
    NOCOST,
  )
  check('버퍼 3% → 깊은 이탈(−8%)은 청산', deepBreak.events.some((e) => e.action === '매도'))

  eq('버퍼 라벨', exitRuleLabel({ kind: 'maBreak', maPeriod: 5, pct: 3 }), '5일선 −3% 이탈')
  eq('버퍼 없는 라벨은 기존 유지', exitRuleLabel({ kind: 'maBreak', maPeriod: 5 }), '5일선 이탈')
}

// ------------------------------------------ 10) 스펙 엔진 (runStrategySpec)
section('10) 전략 스펙 엔진 — 정본 경로')
{
  const BASE_UNIVERSE: StrategySpec['universe'] = {
    markets: ['KOSPI', 'KOSDAQ'],
    excludeAdministrative: true,
    excludeSuspended: true,
    excludeLiquidation: true,
    excludePreferred: true,
    excludeEtf: true,
  }

  // (a) 래퍼 등가성 — 파라미터 경로와 스펙 경로가 같은 결과를 내는가 (회귀 가드)
  {
    const hist = { AAA: flatThenBreakout(30, 10), BBB: flatThenBreakout(30, 15) }
    const p: ConditionParams = { ...DEFAULT_CONDITION, maxPositions: 1, exits: [{ kind: 'timeExit', days: 2 }] }
    const a = runConditionScreen(hist, d(0), p, NOCOST)
    const b = runStrategySpec(hist, d(0), paramsToSpec(p), NOCOST)
    eq('파라미터 경로 = 스펙 경로 (체결)', JSON.stringify(a.events), JSON.stringify(b.events))
    eq('파라미터 경로 = 스펙 경로 (자산곡선)', JSON.stringify(a.equity), JSON.stringify(b.equity))
  }

  // (b) universe.symbols — 표본을 지정하면 그 밖의 종목은 절대 사지 않는다
  {
    const hist = { AAA: flatThenBreakout(30, 10), BBB: flatThenBreakout(30, 15) }
    const spec: StrategySpec = {
      ...paramsToSpec({ ...DEFAULT_CONDITION, maxPositions: 2, exits: [{ kind: 'timeExit', days: 2 }] }),
      universe: { ...BASE_UNIVERSE, symbols: ['AAA'] },
    }
    const r = runStrategySpec(hist, d(0), spec, NOCOST)
    const buys = r.events.filter((e) => e.action === '매수')
    check('표본 내 종목은 매수됨', buys.some((e) => e.symbol === 'AAA'))
    check('표본 밖 종목은 매수 안 됨', !buys.some((e) => e.symbol === 'BBB'))
    eq('유니버스도 표본만', r.universe.join(','), 'AAA')
  }

  // (c) timing=sameClose(LOC) — 신호일 **당일 종가** 체결
  {
    const bars = flatThenBreakout(20, 10)
    const spec: StrategySpec = {
      ...paramsToSpec({ ...DEFAULT_CONDITION, maxPositions: 1, exits: [{ kind: 'timeExit', days: 2 }] }),
      execution: { timing: 'sameClose', orderType: 'market' },
    }
    const r = runStrategySpec({ AAA: bars }, d(0), spec, NOCOST)
    const buy = r.events.find((e) => e.action === '매수')
    check('LOC 체결 발생', !!buy)
    if (buy) {
      eq('체결일 = 신호일(돌파일)', buy.date, d(10))
      close('체결가 = 신호일 종가', buy.price, bars[10].c, 1e-9)
    }
    // 마지막 봉 신호는 LOC라도 만들지 않는다 (규칙 1-6 보수 적용)
    const lastBreak = flatThenBreakout(20, 19)
    const rLast = runStrategySpec({ AAA: lastBreak }, d(0), spec, NOCOST)
    eq('마지막 봉 LOC 진입 없음', rLast.events.filter((e) => e.action === '매수').length, 0)
  }

  // (d) OR 트리 — 고정형 파라미터로는 표현 불가능한 조건식이 돈다
  {
    // +5% 급등 **또는** −5% 급락에 진입 (양방향 이벤트 스터디용)
    const closes = [10000, 10000, 10000, 10000, 10000, 11000, 11000, 11000, 11000, 11000, 9900, 9900, 9900, 9900]
    const bars = closes.map((c, i) => bar(i, i > 0 ? closes[i - 1] : c, Math.max(c, i > 0 ? closes[i - 1] : c), Math.min(c, i > 0 ? closes[i - 1] : c), c))
    const orSpec: StrategySpec = {
      version: SPEC_VERSION,
      id: 'or-test',
      name: '급등락 이벤트',
      universe: BASE_UNIVERSE,
      entry: {
        op: 'or',
        nodes: [
          { op: 'cond', cond: { kind: 'changePct', min: 5 } },
          { op: 'cond', cond: { kind: 'changePct', max: -5 } },
        ],
      },
      ranking: null,
      exits: [{ kind: 'timeExit', days: 1 }],
      sizing: { maxPositions: 1, mode: 'equalSlot' },
      execution: { timing: 'nextOpen', orderType: 'market' },
    }
    const r = runStrategySpec({ AAA: bars }, d(0), orSpec, NOCOST)
    const buys = r.events.filter((e) => e.action === '매수')
    eq('급등·급락 각 1회 진입', buys.length, 2)
    eq('급등 신호 → 익일 체결', buys[0]?.date, d(6))
    eq('급락 신호 → 익일 체결', buys[1]?.date, d(11))
  }

  // (e) 스펙 경로 절단 불변성 (규칙 1) — 새 경로도 미래를 보지 않는다
  {
    const mk = (seed: number): DailyBar[] => {
      const g = rng(seed)
      const out: DailyBar[] = []
      let px = 10000
      for (let i = 0; i < 200; i++) {
        const ret = 0.04 * (g() * 2 - 1)
        const o = px
        const c = px * (1 + ret)
        out.push(bar(i, o, Math.max(o, c) * 1.01, Math.min(o, c) * 0.99, c, 500_000 + Math.floor(g() * 2_000_000)))
        px = c
      }
      return out
    }
    const hist = { AAA: mk(11), BBB: mk(12) }
    const spec: StrategySpec = {
      version: SPEC_VERSION,
      id: 'trunc-test',
      name: '절단 검증',
      universe: BASE_UNIVERSE,
      entry: {
        op: 'or',
        nodes: [
          { op: 'cond', cond: { kind: 'highBreak', days: 10 } },
          {
            op: 'and',
            nodes: [
              { op: 'cond', cond: { kind: 'rsi', period: 14, max: 30 } },
              { op: 'not', node: { op: 'cond', cond: { kind: 'streak', dir: 'down', days: 5 } } },
            ],
          },
        ],
      },
      ranking: { by: 'tradingValue', dir: 'desc' },
      exits: [{ kind: 'stopLoss', pct: 4 }, { kind: 'conditionExit' }],
      sizing: { maxPositions: 2, mode: 'equalSlot' },
      execution: { timing: 'nextOpen', orderType: 'market' },
    }
    const CUT = 140
    const full = runStrategySpec(hist, d(0), spec, COST)
    const cut = runStrategySpec({ AAA: hist.AAA.slice(0, CUT), BBB: hist.BBB.slice(0, CUT) }, d(0), spec, COST)
    const fullBefore = full.events.filter((e) => e.date < d(CUT - 1))
    const cutBefore = cut.events.filter((e) => e.date < d(CUT - 1))
    eq('절단 전 체결 건수 동일', cutBefore.length, fullBefore.length)
    eq('절단 전 체결 내역 일치', JSON.stringify(cutBefore), JSON.stringify(fullBefore))
    check('체결이 실제로 존재(공허한 통과 방지)', fullBefore.filter((e) => e.action === '매수').length > 0)
  }
}

// ---------------------------------------------- 11) 장 레짐 게이트 (regime)
section('11) 레짐 게이트 — 지수 조건이 꺼지면 신규 진입 금지, 청산은 계속')
{
  const BASE_UNIVERSE: StrategySpec['universe'] = {
    markets: ['KOSPI', 'KOSDAQ'],
    excludeAdministrative: true,
    excludeSuspended: true,
    excludeLiquidation: true,
    excludePreferred: true,
    excludeEtf: true,
  }
  const spec = (regimeEntry: StrategySpec['entry'] | null): StrategySpec => ({
    version: SPEC_VERSION,
    id: 'regime-test',
    name: '레짐 테스트',
    universe: BASE_UNIVERSE,
    entry: {
      op: 'and',
      nodes: [{ op: 'cond', cond: { kind: 'maCross', period: 5, dir: 'above' } }],
    },
    ranking: null,
    exits: [{ kind: 'timeExit', days: 2 }],
    sizing: { maxPositions: 1, mode: 'equalSlot' },
    execution: { timing: 'nextOpen', orderType: 'market' },
    regime: regimeEntry ? { symbol: 'INDEX', entry: regimeEntry } : null,
  })
  const alignNode: StrategySpec['entry'] = { op: 'and', nodes: [{ op: 'cond', cond: { kind: 'maAlign', fast: 5, slow: 10 } }] }

  const stock = flatThenBreakout(30, 12)
  // 지수: 꾸준한 상승(정배열 유지) vs 꾸준한 하락(역배열)
  const idxUp = Array.from({ length: 30 }, (_, i) => bar(i, 100 + i, 100.5 + i, 99.5 + i, 100 + i))
  const idxDown = Array.from({ length: 30 }, (_, i) => bar(i, 200 - i, 200.5 - i, 199.5 - i, 200 - i))

  const on = runStrategySpec({ AAA: stock, INDEX: idxUp }, d(0), spec(alignNode), NOCOST)
  check('레짐 ON(지수 정배열) → 진입 발생', on.events.some((e) => e.action === '매수'))
  check('지수 심볼은 매매 대상 아님', !on.events.some((e) => e.symbol === 'INDEX'))
  check('유니버스에서 지수 제외', !on.universe.includes('INDEX'))

  const off = runStrategySpec({ AAA: stock, INDEX: idxDown }, d(0), spec(alignNode), NOCOST)
  eq('레짐 OFF(지수 역배열) → 진입 0', off.events.filter((e) => e.action === '매수').length, 0)

  // 레짐 데이터가 없으면 보수적으로 진입 금지
  const noIdx = runStrategySpec({ AAA: stock }, d(0), spec(alignNode), NOCOST)
  eq('레짐 심볼 데이터 없음 → 진입 0 (보수)', noIdx.events.filter((e) => e.action === '매수').length, 0)

  // 레짐 없는 스펙은 종전과 동일
  const plain = runStrategySpec({ AAA: stock }, d(0), spec(null), NOCOST)
  check('레짐 미지정 → 정상 진입', plain.events.some((e) => e.action === '매수'))

  // 청산은 레짐과 무관: 레짐이 중간에 꺼져도 보유분은 timeExit로 청산된다
  // 지수: 전반 상승 → 후반 하락 (돌파 시점엔 ON, 이후 OFF)
  const idxFlip = Array.from({ length: 30 }, (_, i) =>
    i <= 14 ? bar(i, 100 + i, 100.5 + i, 99.5 + i, 100 + i) : bar(i, 130 - (i - 14) * 3, 130.5 - (i - 14) * 3, 129.5 - (i - 14) * 3, 130 - (i - 14) * 3),
  )
  const flip = runStrategySpec({ AAA: stock, INDEX: idxFlip }, d(0), spec(alignNode), NOCOST)
  check('레짐 꺼진 뒤에도 청산은 실행', flip.events.some((e) => e.action === '매도'))
}

finish()
