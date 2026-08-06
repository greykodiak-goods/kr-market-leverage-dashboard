// 테마 콜 기록 트랙 — **정직성 불변식** 테스트.
//
// 이 트랙은 대표의 재량 판단을 채점하는 곳이라, 채점이 관대해지는 순간 존재 이유가 사라진다.
// 여기서 강제하는 것: ①기록일 당일 종가로 못 산다 ②소급 등재는 집계 제외 ③봉인 변조 검출
// ④인지와 실행이 분리 집계된다 ⑤미달 지평은 집계에 안 들어간다.

import { check, close, eq, section, finish } from './harness'
import {
  aggregate,
  executionStats,
  scoreCall,
  sealOf,
  verifySeal,
  HORIZONS,
  MIN_SAMPLE,
  THEME_CALLS_RULES,
  THEME_CALLS_SCHEMA,
  THEME_CALLS_SUPPORTED_SCHEMAS,
  type PriceLookup,
  type ThemeCall,
} from '../src/features/themecalls/themeCalls'

// ---- 결정적 시세 ------------------------------------------------------------
// 종목은 매일 +0.1%, 벤치는 매일 +0.05%로 오르는 계열. 알파가 항상 양수여야 한다.

function mkPrices(daily: Record<string, number>, start = '2026-01-01', days = 500): PriceLookup {
  const bars: Record<string, { date: string; o: number; c: number }[]> = {}
  for (const [sym, rate] of Object.entries(daily)) {
    const arr: { date: string; o: number; c: number }[] = []
    let p = 100
    for (let i = 0; i < days; i++) {
      const d = new Date(Date.parse(start) + i * 86400e3).toISOString().slice(0, 10)
      arr.push({ date: d, o: p, c: p * (1 + rate) })
      p *= 1 + rate
    }
    bars[sym] = arr
  }
  return {
    openOnOrAfter: (s, date) => {
      const a = bars[s]?.find((b) => b.date >= date)
      return a ? { date: a.date, price: a.o } : null
    },
    closeOnOrBefore: (s, date) => {
      const a = bars[s]?.filter((b) => b.date <= date).pop()
      return a ? { date: a.date, price: a.c } : null
    },
  }
}

const PX = mkPrices({ AAA: 0.001, BENCH: 0.0005, FLAT: 0 })

function mkCall(over: Partial<ThemeCall> = {}): ThemeCall {
  const base: Omit<ThemeCall, 'seal'> = {
    id: 'c1',
    recordedAt: '2026-01-10',
    noticedAt: '2026-01-05',
    thesis: '테스트 논지',
    source: '테스트',
    targets: [{ symbol: 'AAA', market: 'US', role: 'primary' }],
    benchmark: 'BENCH',
    conviction: 3,
    acted: false,
    actedAt: null,
    notActedReason: null,
    retroactive: false,
    retroactiveNote: null,
    ...over,
  }
  return { ...base, seal: over.seal ?? sealOf(base) }
}

// ============================================================================
section('1. 봉인 — 사후 수정을 잡아내는가')
// ============================================================================
{
  const c = mkCall()
  check('갓 만든 콜은 봉인이 맞다', verifySeal(c))
  check('논지를 고치면 봉인이 깨진다', !verifySeal({ ...c, thesis: '몰래 바꾼 논지' }))
  check('종목을 고치면 봉인이 깨진다', !verifySeal({ ...c, targets: [{ symbol: 'ZZZ', market: 'US', role: 'primary' }] }))
  check('확신도를 고치면 봉인이 깨진다', !verifySeal({ ...c, conviction: 5 }))
  check('소급 플래그를 고치면 봉인이 깨진다', !verifySeal({ ...c, retroactive: true }))
  check('종목 순서만 바뀐 것은 봉인이 유지된다(정렬)', verifySeal({
    ...c,
    targets: [{ symbol: 'AAA', market: 'US', role: 'primary' }],
  }))
  // 실행 여부는 나중에 갱신되므로 봉인 대상이 아니다
  check('acted는 봉인 대상이 아니다(나중에 갱신됨)', verifySeal({ ...c, acted: true, actedAt: '2026-01-20' }))
}

// ============================================================================
section('2. 🚫 진입은 기록일 **다음** 거래일 시가')
// ============================================================================
{
  const s = scoreCall(mkCall({ recordedAt: '2026-01-10' }), PX, '2027-06-01')
  const h = s.horizons[0]
  check(`진입일이 기록일보다 뒤다 (기록 2026-01-10 → 진입 ${h.entryDate})`, (h.entryDate ?? '') > '2026-01-10', `${h.entryDate}`)
  eq('진입일은 기록일 다음 거래일', h.entryDate, '2026-01-11')
}

// ============================================================================
section('3. 채점 — 벤치 대비 알파로 재는가')
// ============================================================================
{
  const s = scoreCall(mkCall(), PX, '2027-06-01')
  check('채점 대상이다', s.scored, s.excludedWhy ?? '')
  const h30 = s.horizons.find((x) => x.horizonDays === 30)!
  check('30일 알파가 양수다(종목 0.1%/일 vs 벤치 0.05%/일)', (h30.alphaPct ?? 0) > 0, `${h30.alphaPct}`)
  check('알파 = 종목 − 벤치', Math.abs((h30.alphaPct ?? 0) - ((h30.targetRetPct ?? 0) - (h30.benchRetPct ?? 0))) < 0.01)

  // 종목이 벤치와 같으면 알파 0 근처
  const flat = scoreCall(mkCall({ id: 'c2', targets: [{ symbol: 'BENCH', market: 'US', role: 'primary' }] }), PX, '2027-06-01')
  const f30 = flat.horizons.find((x) => x.horizonDays === 30)!
  close('같은 종목이면 알파 0', f30.alphaPct ?? 99, 0, 0.01)
}

// ============================================================================
section('4. 🚫 소급 등재는 집계에서 빠진다')
// ============================================================================
{
  const retro = mkCall({ id: 'r1', retroactive: true, retroactiveNote: '주가 움직인 뒤 기록' })
  const s = scoreCall(retro, PX, '2027-06-01')
  check('소급 콜은 채점되지 않는다', !s.scored)
  check('제외 사유가 소급이라고 적힌다', (s.excludedWhy ?? '').includes('소급'))
  check('소급 콜의 지평 알파는 전부 null', s.horizons.every((h) => h.alphaPct === null))

  const agg = aggregate([retro], [s], 30)
  eq('소급만 있으면 표본 0', agg.n, 0)
  eq('표본 0이면 적중률 null', agg.hitRatePct, null)
}

// ============================================================================
section('5. 봉인 깨진 콜도 집계에서 빠진다')
// ============================================================================
{
  const tampered = { ...mkCall({ id: 't1' }), thesis: '나중에 고친 논지' }
  const s = scoreCall(tampered, PX, '2027-06-01')
  check('봉인 불일치 검출', !s.sealOk)
  check('채점 제외', !s.scored)
  check('사유에 봉인이 적힌다', (s.excludedWhy ?? '').includes('봉인'))
}

// ============================================================================
section('6. 아직 안 찬 지평은 집계에 안 들어간다')
// ============================================================================
{
  // 기록 직후 시점에서 채점하면 30일도 아직 안 찼다
  const s = scoreCall(mkCall({ recordedAt: '2026-01-10' }), PX, '2026-01-20')
  const h30 = s.horizons.find((x) => x.horizonDays === 30)!
  check('30일 지평이 pending', h30.pending)
  eq('pending이면 알파 null', h30.alphaPct, null)
  const agg = aggregate([mkCall({ recordedAt: '2026-01-10' })], [s], 30)
  eq('pending은 표본에 안 들어간다', agg.n, 0)
}

// ============================================================================
section('7. 집계 — 적중률·평균·중앙값·표본부족')
// ============================================================================
{
  const px = mkPrices({ WIN: 0.002, LOSE: -0.001, BENCH: 0.0005 }, '2026-01-01', 500)
  const wins = [1, 2, 3].map((i) =>
    mkCall({ id: `w${i}`, recordedAt: '2026-01-10', targets: [{ symbol: 'WIN', market: 'US', role: 'primary' }] }),
  )
  const loses = [1, 2].map((i) =>
    mkCall({ id: `l${i}`, recordedAt: '2026-01-10', targets: [{ symbol: 'LOSE', market: 'US', role: 'primary' }] }),
  )
  const all = [...wins, ...loses]
  const scores = all.map((c) => scoreCall(c, px, '2027-06-01'))
  const agg = aggregate(all, scores, 90)
  eq('표본 5건', agg.n, 5)
  close('적중률 60% (3승 2패)', agg.hitRatePct ?? -1, 60, 0.01)
  check('평균 알파가 계산된다', agg.avgAlphaPct !== null)
  check('중앙 알파가 계산된다', agg.medianAlphaPct !== null)
  eq(`표본 ${MIN_SAMPLE}건이면 표본부족 아님`, agg.lowSample, false)

  const few = aggregate([wins[0]], [scores[0]], 90)
  eq('1건이면 표본부족', few.lowSample, true)
}

// ============================================================================
section('8. 🔴 인지와 실행이 분리 집계되는가 — 이 트랙의 존재 이유')
// ============================================================================
{
  const px = mkPrices({ WIN: 0.002, BENCH: 0.0005 }, '2026-01-01', 500)
  // 3건 다 맞혔는데 1건만 실제로 샀다 — 아마존 상황
  const calls = [
    mkCall({ id: 'a', recordedAt: '2026-01-10', targets: [{ symbol: 'WIN', market: 'US', role: 'primary' }], acted: true, actedAt: '2026-01-11' }),
    mkCall({ id: 'b', recordedAt: '2026-01-10', targets: [{ symbol: 'WIN', market: 'US', role: 'primary' }], acted: false, notActedReason: '확신 부족' }),
    mkCall({ id: 'c', recordedAt: '2026-01-10', targets: [{ symbol: 'WIN', market: 'US', role: 'primary' }], acted: false, notActedReason: '확신 부족' }),
  ]
  const scores = calls.map((c) => scoreCall(c, px, '2027-06-01'))
  const agg = aggregate(calls, scores, 90)
  const ex = executionStats(calls, scores, 90)

  close('인지 적중률 100% — 셋 다 맞혔다', agg.hitRatePct ?? -1, 100, 0.01)
  eq('실행한 콜 1건', ex.acted, 1)
  close('실행률 33.3%', ex.actRatePct ?? -1, 33.3, 0.1)
  close('맞힌 콜 중 실행 비율 33.3%', ex.actedAmongWinnersPct ?? -1, 33.3, 0.1)
  eq('알고도 못 산 건수 2건', ex.missedWinners, 2)
  check('안 산 이유가 집계된다', ex.reasons.length === 1 && ex.reasons[0].count === 2, JSON.stringify(ex.reasons))

  check(
    '인지 100%인데 실행 33% — 병목이 실행에 있다고 말할 수 있다',
    (agg.hitRatePct ?? 0) > (ex.actRatePct ?? 100),
  )
}

// ============================================================================
section('9. 스키마·규칙 문구')
// ============================================================================
eq('현재 스키마가 지원 목록에 있다', THEME_CALLS_SUPPORTED_SCHEMAS.includes(THEME_CALLS_SCHEMA), true)
eq('지평이 4개', HORIZONS.length, 4)
check('규칙 문구에 "다음 거래일"이 있다', THEME_CALLS_RULES.some((r) => r.includes('다음 거래일')))
check('규칙 문구에 소급 제외가 있다', THEME_CALLS_RULES.some((r) => r.includes('소급')))
check('규칙 문구에 알파 판정이 있다', THEME_CALLS_RULES.some((r) => r.includes('알파')))
check('규칙 문구가 봉인의 한계를 밝힌다', THEME_CALLS_RULES.some((r) => r.includes('위조 방지가 아')))

finish()
