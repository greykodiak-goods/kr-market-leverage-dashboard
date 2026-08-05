// 적립식(DCA) 계산 검증 — IRR은 틀리기 쉬워서 정답을 아는 표본으로 자기검증한다(규칙 4).

import { check, close, eq, section, finish } from './harness'
import { runDca, dcaIrr, dcaNpv } from '../scripts/us-leverage-lab.entry'
import type { DailyBar } from '../src/lib/history'

const FREE = { initialCapital: 0, feePct: 0, slippagePct: 0 }

/** 하루 r 비율로 정확히 오르는 결정적 계열 (시가=종가로 두어 계산을 단순화) */
function ramp(n: number, dailyRate: number, start = 100): DailyBar[] {
  const bars: DailyBar[] = []
  let c = start
  for (let i = 0; i < n; i++) {
    if (i > 0) c *= 1 + dailyRate
    const d = new Date(Date.UTC(2010, 0, 4) + i * 86400e3)
    bars.push({ date: d.toISOString().slice(0, 10), t: 0, o: c, h: c, l: c, c, v: 0 })
  }
  return bars
}

// ============================================================================
section('1. 가격이 일정하면 — 원금 그대로, IRR 0')
// ============================================================================
{
  const r = runDca(ramp(500, 0), 10_000, FREE)
  eq('누적 원금 = 일수 × 금액', r.contributed, 500 * 10_000)
  close('최종 평가액 = 원금', r.finalValue, r.contributed, 1e-6)
  close('배수 1.00', r.multiple, 1, 1e-9)
  check('IRR ≈ 0', r.irrPct !== null && Math.abs(r.irrPct) < 1e-3, `IRR=${r.irrPct}`)
  eq('수중일 0 (원금 아래로 안 감)', r.underwaterDays, 0)
}

// ============================================================================
section('2. 일정 비율 상승 — IRR이 연환산 상승률과 맞나')
// ============================================================================
{
  // 하루 0.05% → 365.25일 복리 연환산
  const daily = 0.0005
  const bars = ramp(2000, daily)
  const r = runDca(bars, 10_000, FREE)
  const expected = (Math.pow(1 + daily, 365.25) - 1) * 100
  check(
    `IRR ${r.irrPct === null ? '—' : r.irrPct.toFixed(2)}% ≈ 연환산 ${expected.toFixed(2)}%`,
    r.irrPct !== null && Math.abs(r.irrPct - expected) < 0.6,
    `차이 ${r.irrPct === null ? '—' : (r.irrPct - expected).toFixed(3)}%p`,
  )
  check('상승장이므로 배수 > 1', r.multiple > 1, `${r.multiple.toFixed(3)}배`)
  eq('상승만 하면 수중일 0', r.underwaterDays, 0)
}

// ============================================================================
section('3. 하락 계열 — 수중 구간을 잡아내나')
// ============================================================================
{
  const bars = ramp(600, -0.001)
  const r = runDca(bars, 10_000, FREE)
  check('하락장이므로 배수 < 1', r.multiple < 1, `${r.multiple.toFixed(3)}배`)
  check('IRR 음수', r.irrPct !== null && r.irrPct < 0, `IRR=${r.irrPct}`)
  check('거의 전 기간이 수중', r.underwaterDays > 590, `${r.underwaterDays}일`)
  check('최장 연속 수중 구간이 기록된다', r.longestUnderwater.days > 590 && r.longestUnderwater.from !== '')
}

// ============================================================================
section('4. NPV 함수 자체 — 부호가 뒤집히는가')
// ============================================================================
{
  const bars = ramp(300, 0.0005)
  const r = runDca(bars, 10_000, FREE)
  const lo = dcaNpv(bars, 10_000, r.finalValue, -0.5)
  const hi = dcaNpv(bars, 10_000, r.finalValue, 3)
  check('낮은 할인율에서 NPV > 0', lo > 0, `${lo}`)
  check('높은 할인율에서 NPV < 0', hi < 0, `${hi}`)
  const atIrr = dcaNpv(bars, 10_000, r.finalValue, (r.irrPct ?? 0) / 100)
  check('IRR 지점에서 NPV ≈ 0', Math.abs(atIrr) < Math.abs(lo) * 1e-6, `${atIrr}`)
}

// ============================================================================
section('5. 비용 · 방어')
// ============================================================================
{
  const bars = ramp(400, 0.0003)
  const free = runDca(bars, 10_000, FREE)
  const paid = runDca(bars, 10_000, { initialCapital: 0, feePct: 0.01, slippagePct: 0.05 })
  check('비용을 물리면 최종 평가액이 작다', paid.finalValue < free.finalValue)
  eq('비용은 납입 원금을 바꾸지 않는다', paid.contributed, free.contributed)

  let threw = false
  try {
    runDca([bars[0]], 10_000, FREE)
  } catch {
    threw = true
  }
  check('봉이 1개면 던진다', threw)

  let threw2 = false
  try {
    runDca([{ ...bars[0], o: 0 }, bars[1]], 10_000, FREE)
  } catch {
    threw2 = true
  }
  check('시가가 0이면 던진다(조용히 넘기지 않음)', threw2)

  eq('부호가 안 갈리면 IRR은 null', dcaIrr(bars, 10_000, -1), null)
}

finish()
