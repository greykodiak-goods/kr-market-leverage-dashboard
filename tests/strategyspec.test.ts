// 전략 스펙(strategySpec.ts) 검증.
//
// 이 파일이 지키는 것:
//   1) 모든 조건 kind가 의도대로 판정되는가 (통과·탈락 양쪽)
//   2) AND/OR/NOT 트리가 맞는가 + detail에 말단 조건이 전부 남는가(단축 평가 금지)
//   3) 인과성 — 절단 불변성: bars를 i 이후에서 잘라도 i 시점 판정이 동일한가 (규칙 1)
//   4) 데이터 부족이면 관대하게 통과시키지 않는가 (passed=false)
//   5) validateSpec이 실행 불가능한 스펙을 잡아내는가
//   6) 스펙이 JSON 왕복(직렬화→역직렬화) 후에도 같은 판정을 내는가 — 실거래 어댑터로
//      넘어갈 때 스펙은 JSON으로 이동하므로 이게 깨지면 공유 계약이 아니다.

import { check, close, eq, finish, section } from './harness'
import {
  HEROMOON_MOMENTUM,
  SPEC_VERSION,
  avgVolume,
  changePctAt,
  conditionLabel,
  evaluateCondition,
  evaluateEntry,
  evaluatePersistence,
  priorHigh,
  priorLow,
  rsi,
  sma,
  streakLen,
  validateSpec,
} from '../src/features/backtest/strategySpec'
import type {
  Condition,
  ConditionNode,
  CrossSection,
  StrategySpec,
} from '../src/features/backtest/strategySpec'
import type { DailyBar } from '../src/features/backtest/types'

// ---------------------------------------------------------------- 헬퍼

function bar(i: number, c: number, over: Partial<DailyBar> = {}): DailyBar {
  const d = new Date(Date.UTC(2026, 0, 1 + i))
  return {
    date: d.toISOString().slice(0, 10),
    t: Math.floor(d.getTime() / 1000),
    o: over.o ?? c,
    h: over.h ?? Math.max(over.o ?? c, c),
    l: over.l ?? Math.min(over.o ?? c, c),
    c,
    v: over.v ?? 1_000_000,
  }
}

/** 종가 배열 → 봉 배열 */
function seq(closes: number[], overrides: Record<number, Partial<DailyBar>> = {}): DailyBar[] {
  return closes.map((c, i) => bar(i, c, overrides[i] ?? {}))
}

function evalOne(c: Condition, bars: DailyBar[], i: number, cs: CrossSection | null = null) {
  return evaluateCondition(c, bars, i, 'TEST', cs)
}

// ---------------------------------------------------------------- 1) 지표
section('1) 지표 — 값과 인과성')
{
  const bars = seq([10, 11, 12, 13, 14, 15])
  close('sma(3) at i=5', sma(bars, 5, 3)!, (13 + 14 + 15) / 3)
  eq('sma 데이터 부족 → null', sma(bars, 1, 3), null)
  eq('sma period 0 → null', sma(bars, 5, 0), null)

  // priorHigh는 **당일 제외** — 규칙 1-3의 핵심
  eq('priorHigh(3) at i=5 = max(12,13,14) — 당일(15) 제외', priorHigh(bars, 5, 3), 14)
  eq('priorLow(3) at i=5 = 12', priorLow(bars, 5, 3), 12)
  eq('priorHigh 데이터 부족 → null', priorHigh(bars, 2, 3), null)

  // avgVolume도 당일 제외 (당일 거래량으로 당일 서지를 판정해야 하므로)
  const vb = seq([1, 1, 1, 1], { 0: { v: 100 }, 1: { v: 200 }, 2: { v: 300 }, 3: { v: 900 } })
  close('avgVolume(3) at i=3 = (100+200+300)/3 — 당일 제외', avgVolume(vb, 3, 3)!, 200)

  close('changePctAt: 11→12', changePctAt(seq([11, 12]), 1)!, (12 / 11 - 1) * 100)
  eq('changePctAt i=0 → null', changePctAt(bars, 0), null)

  eq('streak up 5일 연속', streakLen(bars, 5, 'up'), 5)
  eq('streak down 0', streakLen(bars, 5, 'down'), 0)
  const zig = seq([10, 11, 10, 11, 12, 13])
  eq('streak up 끊긴 후 3', streakLen(zig, 5, 'up'), 3)

  // RSI: 전부 상승이면 100, 전부 하락이면 0
  eq('RSI 전부 상승 = 100', rsi(seq([10, 11, 12, 13, 14, 15]), 5, 5), 100)
  eq('RSI 전부 하락 = 0', rsi(seq([15, 14, 13, 12, 11, 10]), 5, 5), 0)
  eq('RSI 무변동 = 50', rsi(seq([10, 10, 10, 10, 10, 10]), 5, 5), 50)
  eq('RSI 데이터 부족 → null', rsi(seq([10, 11]), 1, 5), null)
}

// ---------------------------------------------------------------- 2) 개별 조건
section('2) 조건 kind별 판정')
{
  // priceRange
  const p = seq([30000])
  check('priceRange 통과', evalOne({ kind: 'priceRange', min: 2000, max: 50000 }, p, 0).passed)
  check('priceRange max 초과 탈락', !evalOne({ kind: 'priceRange', max: 20000 }, p, 0).passed)
  check('priceRange min만 지정', evalOne({ kind: 'priceRange', min: 2000 }, p, 0).passed)

  // changePct
  const ch = seq([100, 110])
  check('changePct +10% ≥ min 5', evalOne({ kind: 'changePct', min: 5 }, ch, 1).passed)
  check('changePct max 8 탈락', !evalOne({ kind: 'changePct', min: 5, max: 8 }, ch, 1).passed)
  check('changePct i=0 판정 불가 → 탈락', !evalOne({ kind: 'changePct', min: 0 }, ch, 0).passed)

  // candle
  const bull = seq([105], { 0: { o: 100 } })
  const bear = seq([95], { 0: { o: 100 } })
  check('양봉 판정', evalOne({ kind: 'candle', bull: true }, bull, 0).passed)
  check('음봉은 양봉 조건 탈락', !evalOne({ kind: 'candle', bull: true }, bear, 0).passed)
  check('음봉 조건 통과', evalOne({ kind: 'candle', bull: false }, bear, 0).passed)

  // maCross above: 전일 종가 ≤ 전일 MA, 당일 종가 > 당일 MA
  //   종가 [10,10,10,10, 9,13]: i=5에서 MA5=(10+10+10+9+13)/5=10.4, 종가13>10.4
  //   i=4에서 MA5=(10+10+10+10+9)/5=9.8, 종가9 ≤ 9.8 → 돌파 성립
  const cross = seq([10, 10, 10, 10, 9, 13])
  check('maCross above 돌파 성립', evalOne({ kind: 'maCross', period: 5, dir: 'above' }, cross, 5).passed)
  // 이미 위에 있었으면(전일도 MA 위) 돌파 아님
  const stay = seq([10, 10, 10, 10, 12, 13])
  check('이미 위였으면 돌파 아님', !evalOne({ kind: 'maCross', period: 5, dir: 'above' }, stay, 5).passed)
  check('maCross 데이터 부족 탈락', !evalOne({ kind: 'maCross', period: 5, dir: 'above' }, cross, 3).passed)
  // 하향 돌파: 대칭
  const crossDn = seq([10, 10, 10, 10, 11, 7])
  check('maCross below 돌파 성립', evalOne({ kind: 'maCross', period: 5, dir: 'below' }, crossDn, 5).passed)

  // maPosition: 돌파 여부 무관, 위치만
  check('maPosition above (전일도 위)', evalOne({ kind: 'maPosition', period: 5, dir: 'above' }, stay, 5).passed)
  check('maPosition below 탈락', !evalOne({ kind: 'maPosition', period: 5, dir: 'below' }, stay, 5).passed)

  // maAlign: 정배열 — 상승 시계열이면 단기 > 장기
  const rising = seq([10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20])
  check('상승장 5·10 정배열', evalOne({ kind: 'maAlign', fast: 5, slow: 10 }, rising, 10).passed)
  const falling = seq([20, 19, 18, 17, 16, 15, 14, 13, 12, 11, 10])
  check('하락장 정배열 탈락(역배열)', !evalOne({ kind: 'maAlign', fast: 5, slow: 10 }, falling, 10).passed)
  check('maAlign 데이터 부족 탈락', !evalOne({ kind: 'maAlign', fast: 5, slow: 10 }, rising, 5).passed)

  // volume / tradingValue
  const vol = seq([10000], { 0: { v: 500_000 } })
  check('volume 통과', evalOne({ kind: 'volume', min: 300_000 }, vol, 0).passed)
  check('volume 탈락', !evalOne({ kind: 'volume', min: 600_000 }, vol, 0).passed)
  // 거래대금 = 10000원 × 50만주 = 50억
  check('tradingValue 50억 ≥ 30억', evalOne({ kind: 'tradingValue', min: 3e9 }, vol, 0).passed)
  check('tradingValue 100억 탈락', !evalOne({ kind: 'tradingValue', min: 1e10 }, vol, 0).passed)

  // volumeSurge: 직전 3일 평균 200, 당일 900 → 4.5배
  const surge = seq([1, 1, 1, 1], { 0: { v: 100 }, 1: { v: 200 }, 2: { v: 300 }, 3: { v: 900 } })
  check('volumeSurge 4.5배 ≥ 3배', evalOne({ kind: 'volumeSurge', days: 3, ratio: 3 }, surge, 3).passed)
  check('volumeSurge 5배 기준 탈락', !evalOne({ kind: 'volumeSurge', days: 3, ratio: 5 }, surge, 3).passed)
  check('volumeSurge 데이터 부족 탈락', !evalOne({ kind: 'volumeSurge', days: 3, ratio: 1 }, surge, 1).passed)

  // disparity: 종가 13, MA5 10.4 → 이격도 125
  const disp = seq([10, 10, 10, 10, 9, 13])
  const dv = evalOne({ kind: 'disparity', period: 5, min: 120 }, disp, 5)
  check('disparity 125 ≥ 120', dv.passed)
  check('disparity max 110 탈락', !evalOne({ kind: 'disparity', period: 5, max: 110 }, disp, 5).passed)

  // rsi 조건
  const up = seq([10, 11, 12, 13, 14, 15])
  check('rsi min 70 통과 (100)', evalOne({ kind: 'rsi', period: 5, min: 70 }, up, 5).passed)
  check('rsi max 70 탈락', !evalOne({ kind: 'rsi', period: 5, max: 70 }, up, 5).passed)

  // highBreak: 직전 3일 최고 14, 당일 15 → 돌파
  check('highBreak 통과', evalOne({ kind: 'highBreak', days: 3 }, up, 5).passed)
  // 당일 종가 = 직전고와 같으면 돌파 아님 (초과 조건)
  const flat = seq([10, 14, 14, 14, 14, 14])
  check('직전고와 같으면 돌파 아님', !evalOne({ kind: 'highBreak', days: 3 }, flat, 5).passed)

  // lowBreak
  const dn = seq([15, 14, 13, 12, 11, 10])
  check('lowBreak 통과', evalOne({ kind: 'lowBreak', days: 3 }, dn, 5).passed)
  check('lowBreak 상승장 탈락', !evalOne({ kind: 'lowBreak', days: 3 }, up, 5).passed)

  // streak
  check('streak up 3일 통과', evalOne({ kind: 'streak', dir: 'up', days: 3 }, up, 5).passed)
  check('streak up 6일 탈락 (5일뿐)', !evalOne({ kind: 'streak', dir: 'up', days: 6 }, up, 5).passed)

  // 인덱스 범위 밖
  check('i 범위 밖 → 탈락', !evalOne({ kind: 'candle', bull: true }, up, 99).passed)
  check('i 음수 → 탈락', !evalOne({ kind: 'candle', bull: true }, up, -1).passed)
}

// ---------------------------------------------------------------- 3) 횡단면
section('3) 횡단면 조건 (changeRank)')
{
  const bars = seq([100, 110])
  const cs: CrossSection = {
    changePct: new Map([
      ['TEST', 10],
      ['A', 20],
      ['B', 15],
      ['C', 5],
      ['D', -3],
    ]),
  }
  const r = evalOne({ kind: 'changeRank', top: 3 }, bars, 1, cs)
  check('3위 → top 3 통과', r.passed)
  eq('순위 값 표기', r.value, '3위')
  check('top 2 탈락', !evalOne({ kind: 'changeRank', top: 2 }, bars, 1, cs).passed)
  check('횡단면 없으면 탈락', !evalOne({ kind: 'changeRank', top: 100 }, bars, 1, null).passed)
  const noMe: CrossSection = { changePct: new Map([['A', 1]]) }
  check('내 등락률 없으면 탈락', !evalOne({ kind: 'changeRank', top: 100 }, bars, 1, noMe).passed)
}

// ---------------------------------------------------------------- 4) 조건 트리
section('4) AND/OR/NOT 트리 + detail')
{
  const bars = seq([105], { 0: { o: 100, v: 500_000 } })
  const T: ConditionNode = { op: 'cond', cond: { kind: 'candle', bull: true } }
  const F: ConditionNode = { op: 'cond', cond: { kind: 'volume', min: 1e9 } }

  check('and(T,T) = T', evaluateEntry({ op: 'and', nodes: [T, T] }, bars, 0, 'X', null).passed)
  check('and(T,F) = F', !evaluateEntry({ op: 'and', nodes: [T, F] }, bars, 0, 'X', null).passed)
  check('or(F,T) = T', evaluateEntry({ op: 'or', nodes: [F, T] }, bars, 0, 'X', null).passed)
  check('or(F,F) = F', !evaluateEntry({ op: 'or', nodes: [F, F] }, bars, 0, 'X', null).passed)
  check('not(F) = T', evaluateEntry({ op: 'not', node: F }, bars, 0, 'X', null).passed)
  check('빈 and = F (빈 조건으로 전 종목 매수 방지)', !evaluateEntry({ op: 'and', nodes: [] }, bars, 0, 'X', null).passed)

  // 단축 평가 금지 — 첫 조건이 떨어져도 나머지 detail이 나와야 화면에 쓸 수 있다
  const r = evaluateEntry({ op: 'and', nodes: [F, T, F] }, bars, 0, 'X', null)
  eq('detail에 말단 3개 전부', r.detail.length, 3)
  eq('첫 조건 탈락 기록', r.detail[0].passed, false)
  eq('둘째 조건 통과 기록', r.detail[1].passed, true)
  check('실측값 존재', r.detail.every((d) => d.value !== null))

  // 중첩: and(or(F,T), not(F)) = T
  const nested: ConditionNode = {
    op: 'and',
    nodes: [{ op: 'or', nodes: [F, T] }, { op: 'not', node: F }],
  }
  const rn = evaluateEntry(nested, bars, 0, 'X', null)
  check('중첩 트리', rn.passed)
  eq('중첩이어도 말단만 detail에 (3개)', rn.detail.length, 3)
}

// ---------------------------------------------------------------- 5) 절단 불변성
section('5) 절단 불변성 — i 시점 판정은 미래와 무관 (규칙 1)')
{
  // 모든 조건을 한 트리에 넣고, 봉을 뒤에서 잘라도 같은 i의 판정·실측값이
  // 완전히 동일한지 본다. 하나라도 다르면 어딘가에서 bars[i+1..]을 읽은 것이다.
  const closes = [100, 102, 99, 104, 107, 103, 108, 112, 110, 115, 111, 118, 120, 117, 125, 122, 130, 128, 133, 131]
  const vols: Record<number, Partial<DailyBar>> = {}
  closes.forEach((_, i) => {
    vols[i] = { v: 100_000 + ((i * 37) % 11) * 50_000, o: closes[i] * (i % 3 === 0 ? 0.99 : 1.01) }
  })
  const bars = seq(closes, vols)

  const allConds: ConditionNode = {
    op: 'and',
    nodes: (
      [
        { kind: 'priceRange', min: 50, max: 200 },
        { kind: 'changePct', min: -10, max: 10 },
        { kind: 'candle', bull: true },
        { kind: 'maCross', period: 5, dir: 'above' },
        { kind: 'maPosition', period: 5, dir: 'above' },
        { kind: 'maAlign', fast: 5, slow: 10 },
        { kind: 'volume', min: 100_000 },
        { kind: 'tradingValue', min: 1e6 },
        { kind: 'volumeSurge', days: 5, ratio: 1 },
        { kind: 'disparity', period: 5, min: 90, max: 115 },
        { kind: 'rsi', period: 5, min: 20, max: 90 },
        { kind: 'highBreak', days: 5 },
        { kind: 'lowBreak', days: 5 },
        { kind: 'streak', dir: 'up', days: 2 },
      ] as Condition[]
    ).map((cond) => ({ op: 'cond' as const, cond })),
  }

  let mismatches = 0
  for (let cut = 8; cut < bars.length; cut++) {
    const truncated = bars.slice(0, cut)
    for (let i = 0; i < cut; i++) {
      const full = evaluateEntry(allConds, bars, i, 'X', null)
      const part = evaluateEntry(allConds, truncated, i, 'X', null)
      if (JSON.stringify(full) !== JSON.stringify(part)) mismatches++
    }
  }
  eq('절단 후 판정 불일치 0건', mismatches, 0)
}

// ---------------------------------------------------------------- 6) JSON 왕복
section('6) JSON 왕복 — 스펙은 이동 가능한 계약')
{
  const spec = HEROMOON_MOMENTUM
  const revived = JSON.parse(JSON.stringify(spec)) as StrategySpec
  eq('왕복 후 버전 유지', revived.version, SPEC_VERSION)

  // 같은 봉에 대해 원본 스펙과 왕복 스펙이 같은 판정을 내는가
  const bars = seq([10000, 10000, 10000, 10000, 9500, 12000], {
    5: { o: 11000, v: 500_000 },
  })
  const cs: CrossSection = { changePct: new Map([['X', 26.3]]) }
  const a = evaluateEntry(spec.entry, bars, 5, 'X', cs)
  const b = evaluateEntry(revived.entry, bars, 5, 'X', cs)
  eq('왕복 전후 동일 판정', JSON.stringify(a), JSON.stringify(b))
}

// ---------------------------------------------------------------- 7) validateSpec
section('7) validateSpec')
{
  eq('프리셋은 에러 0', validateSpec(HEROMOON_MOMENTUM).filter((i) => i.level === 'error').length, 0)

  const base = JSON.parse(JSON.stringify(HEROMOON_MOMENTUM)) as StrategySpec

  const noExit = { ...base, exits: [] }
  check(
    '매도 없음 → 경고',
    validateSpec(noExit).some((i) => i.level === 'warn' && i.message.includes('매도')),
  )

  const emptyEntry = { ...base, entry: { op: 'and', nodes: [] } as ConditionNode }
  check(
    '매수 조건 없음 → 에러',
    validateSpec(emptyEntry).some((i) => i.level === 'error' && i.message.includes('매수')),
  )

  const badVer = { ...base, version: 99 as unknown as typeof SPEC_VERSION }
  check('버전 불일치 → 에러', validateSpec(badVer).some((i) => i.level === 'error' && i.message.includes('버전')))

  const zeroPos = { ...base, sizing: { ...base.sizing, maxPositions: 0 } }
  check('보유 0종목 → 에러', validateSpec(zeroPos).some((i) => i.level === 'error'))

  const narrow = { ...base, universe: { ...base.universe, symbols: ['A', 'B', 'C'] } }
  check(
    '순위 조건 + 좁은 표본 → 경고',
    validateSpec(narrow).some((i) => i.level === 'warn' && i.message.includes('순위')),
  )

  const intraday = { ...base, execution: { ...base.execution, timing: 'intraday' as const } }
  check(
    'intraday → 분봉 경고',
    validateSpec(intraday).some((i) => i.level === 'warn' && i.message.includes('분봉')),
  )

  const limitNoOffset = { ...base, execution: { timing: 'nextOpen' as const, orderType: 'limit' as const } }
  check(
    '지정가 + 오프셋 없음 → 경고',
    validateSpec(limitNoOffset).some((i) => i.level === 'warn' && i.message.includes('오프셋')),
  )
}

// ---------------------------------------------------------------- 8) 프리셋
section('8) 영웅문 프리셋 (I·A·B·J·K)')
{
  // 5개 조건이 전부 걸리는 봉을 구성:
  //   MA5 돌파(J): [10000×4, 9500, 12000] — i=5에서 MA5=10300, 종가 12000 > MA;
  //   i=4에서 MA5=9900, 종가 9500 ≤ 9900 → 돌파 성립
  //   양봉(B): o=11000 < c=12000 / 주가범위(A): 2000~50000 / 거래량(K): 50만 ≥ 30만
  //   등락률 순위(I): 횡단면에서 1위
  const bars = seq([10000, 10000, 10000, 10000, 9500, 12000], { 5: { o: 11000, v: 500_000 } })
  const cs: CrossSection = { changePct: new Map([['X', 26.3], ['Y', 3], ['Z', -2]]) }

  const r = evaluateEntry(HEROMOON_MOMENTUM.entry, bars, 5, 'X', cs)
  check('전 조건 충족 시 통과', r.passed)
  eq('말단 조건 5개', r.detail.length, 5)
  check('전 조건 개별 통과', r.detail.every((d) => d.passed))

  // 음봉이면 B에서 탈락 — 나머지 detail은 그대로 나와야 한다
  const bearBars = seq([10000, 10000, 10000, 10000, 9500, 12000], { 5: { o: 12500, v: 500_000 } })
  const rb = evaluateEntry(HEROMOON_MOMENTUM.entry, bearBars, 5, 'X', cs)
  check('음봉이면 전체 탈락', !rb.passed)
  eq('탈락해도 detail 5개', rb.detail.length, 5)
  eq('B만 탈락', rb.detail.filter((d) => !d.passed).length, 1)

  // 라벨 스모크 — 모든 kind가 라벨을 만든다
  const kinds: Condition[] = [
    { kind: 'priceRange', min: 1, max: 2 },
    { kind: 'changeRank', top: 10 },
    { kind: 'changePct', min: 1 },
    { kind: 'candle', bull: true },
    { kind: 'maCross', period: 5, dir: 'above' },
    { kind: 'maPosition', period: 5, dir: 'below' },
    { kind: 'maAlign', fast: 5, slow: 10 },
    { kind: 'volume', min: 1 },
    { kind: 'tradingValue', min: 1e8 },
    { kind: 'volumeSurge', days: 5, ratio: 2 },
    { kind: 'disparity', period: 20, min: 100 },
    { kind: 'rsi', period: 14, max: 30 },
    { kind: 'highBreak', days: 20 },
    { kind: 'lowBreak', days: 20 },
    { kind: 'streak', dir: 'up', days: 3 },
  ]
  check('모든 kind 라벨 생성', kinds.every((k) => conditionLabel(k).length > 0))
}

// ---------------------------------------------------------------- 9) 존속 판정
section('9) evaluatePersistence — 조건 이탈(conditionExit)의 판정자')
{
  const node = (c: Condition): ConditionNode => ({ op: 'cond', cond: c })

  // maCross above → "이평 위 유지"로 변환. 경계(종가 == 이평)는 **존속**이다.
  const flat = seq([10, 10, 10, 10, 10, 10])
  check('평탄 구간(종가==이평)은 존속', evaluatePersistence(node({ kind: 'maCross', period: 5, dir: 'above' }), flat, 5, 'X'))

  // 이평 아래로 내려가면 이탈
  const drop = seq([12, 12, 12, 12, 12, 8])
  check('이평 아래 = 이탈', !evaluatePersistence(node({ kind: 'maCross', period: 5, dir: 'above' }), drop, 5, 'X'))

  // 이평 계산 불가(데이터 부족)면 보수적으로 이탈
  check('데이터 부족 = 이탈', !evaluatePersistence(node({ kind: 'maCross', period: 5, dir: 'above' }), flat, 2, 'X'))

  // 트리거 성격 조건은 존속 판정에서 제외 — 트리거만 있으면 항상 존속(이탈 판정 불가)
  check('candle만 → 항상 존속', evaluatePersistence(node({ kind: 'candle', bull: true }), drop, 5, 'X'))
  check('changeRank만 → 항상 존속', evaluatePersistence(node({ kind: 'changeRank', top: 10 }), drop, 5, 'X'))
  check('highBreak만 → 항상 존속', evaluatePersistence(node({ kind: 'highBreak', days: 3 }), drop, 5, 'X'))

  // 상태 성격 조건은 그대로 재평가
  const cheap = seq([1500])
  check('가격대 이탈 = 이탈', !evaluatePersistence(node({ kind: 'priceRange', min: 2000, max: 50000 }), cheap, 0, 'X'))
  const fallSeq = seq([20, 19, 18, 17, 16, 15, 14, 13, 12, 11, 10])
  check('정배열 붕괴 = 이탈 (상태 조건 유지 판정)', !evaluatePersistence(node({ kind: 'maAlign', fast: 5, slow: 10 }), fallSeq, 10, 'X'))
  const thin = seq([10000], { 0: { v: 1000 } })
  check('거래량 미달 = 이탈', !evaluatePersistence(node({ kind: 'volume', min: 300_000 }), thin, 0, 'X'))

  // AND 트리: 트리거(candle·changeRank)는 빠지고 상태 조건만 남는다 —
  // I·A·B·J·K 프리셋의 존속 = A(가격대) ∧ J′(이평 위) ∧ K(거래량)
  const entry = HEROMOON_MOMENTUM.entry
  const holding = seq([10000, 10000, 10000, 10000, 9500, 12000], { 5: { o: 11000, v: 500_000 } })
  check('프리셋: 진입 다음날에도 존속(이평 위·가격대·거래량 유지)', evaluatePersistence(entry, holding, 5, 'X'))
  const broke = seq([12000, 12000, 12000, 12000, 12000, 9000], { 5: { v: 500_000 } })
  check('프리셋: 이평 아래로 무너지면 이탈', !evaluatePersistence(entry, broke, 5, 'X'))

  // OR: 남은 가지 중 하나라도 참이면 존속 / NOT(트리거)는 통째로 제외
  const orNode: ConditionNode = {
    op: 'or',
    nodes: [node({ kind: 'priceRange', min: 100000 }), node({ kind: 'volume', min: 1 })],
  }
  check('OR: 한 가지라도 참이면 존속', evaluatePersistence(orNode, thin, 0, 'X'))
  const notTrigger: ConditionNode = { op: 'not', node: node({ kind: 'streak', dir: 'down', days: 5 }) }
  check('NOT(트리거) → 제외 → 항상 존속', evaluatePersistence(notTrigger, drop, 5, 'X'))
  const notState: ConditionNode = { op: 'not', node: node({ kind: 'priceRange', min: 2000, max: 50000 }) }
  check('NOT(상태): 범위 안이면 NOT은 거짓 = 이탈', !evaluatePersistence(notState, seq([10000]), 0, 'X'))
}

finish()
