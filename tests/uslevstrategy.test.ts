// 미장 레버리지 혼합 전략 판단 코어 검증 — **네트워크 없음**.
//
// 자동매매가 이 코어의 출력을 그대로 주문으로 내보내므로, 여기서 틀리면 실제 돈이 틀린다.
// 되돌릴 수 없는 자리 넷만 본다.
//   ① **미래를 보지 않는가** (규칙 1) — 뒤를 잘라내고 다시 계획해도 잘린 시점 이전 계획이
//      완전히 같아야 한다. switch 신호가 당일 종가를 훔쳐보면 여기서 깨진다.
//   ② **신호가 정확한가** — 이평선 위/아래 판정과 "전일 기준" 사용.
//   ③ **VR 밴드가 정확한가** — 상단 초과 매도 / 하단 이탈 매수 / 밴드 안 무매매.
//   ④ **재배분 문턱이 작동하는가** — 이탈이 작으면 매매를 만들지 않는다(비용 낭비 방지).

import { check, eq, finish, section } from './harness'
import {
  makeConfig,
  planDay,
  type DailyBarLite,
  type PriceTable,
  type UsLevConfig,
  type UsLevState,
} from '../scripts/lib/usLevStrategy'

// ── 합성 시세 ────────────────────────────────────────────────────────────────
// 결정적 계열: QQQ가 오르다 꺾여 150일선을 아래로 깨고 다시 회복한다(교체가 반드시 발생).
function synth(n: number): PriceTable {
  const dates: string[] = []
  const qqq: DailyBarLite[] = []
  const tqqq: DailyBarLite[] = []
  const soxl: DailyBarLite[] = []
  const gld: DailyBarLite[] = []
  let q = 100
  let t = 100
  let s = 100
  let g = 100
  for (let i = 0; i < n; i++) {
    const d = new Date(Date.UTC(2020, 0, 6) + i * 86400e3).toISOString().slice(0, 10)
    // 0~250 상승 / 250~330 급락 / 330~ 회복
    const r = i < 250 ? 0.0012 : i < 330 ? -0.006 : 0.004
    q *= 1 + r
    t *= 1 + r * 3
    s *= 1 + r * 3 + (i % 7 === 0 ? 0.004 : -0.0006) // SOXL은 결이 다르게
    g *= 1 + (i % 5 === 0 ? 0.002 : -0.0003) // 금은 저상관 근사
    dates.push(d)
    qqq.push({ date: d, o: q * 0.999, c: q })
    tqqq.push({ date: d, o: t * 0.998, c: t })
    soxl.push({ date: d, o: s * 0.998, c: s })
    gld.push({ date: d, o: g * 0.999, c: g })
  }
  return { dates, series: { QQQ: qqq, TQQQ: tqqq, SOXL: soxl, GLD: gld } }
}

/** 계획을 순차 적용해 상태를 굴린다 — 데몬의 반영 로직을 최소로 흉내 낸 것. */
function runPlans(prices: PriceTable, cfg: UsLevConfig, upto: number): { plans: string[]; state: UsLevState } {
  const startIdx = 200
  const state: UsLevState = {
    startDate: prices.dates[startIdx],
    holdings: { TQQQ: 100, SOXL: 50, GLD: 30 },
    vrV: { 'vr-soxl': 50 * prices.series.SOXL[startIdx].c },
    vrCash: { 'vr-soxl': 5000 },
    switchHolding: { 'sw-tqqq': 'TQQQ', 'sw-soxl': 'SOXL' },
  }
  const plans: string[] = []
  for (let i = startIdx; i <= upto; i++) {
    const p = planDay(prices, i, cfg, state)
    plans.push(
      `${p.date}|${p.tradingDayIndex}|` +
        p.orders.map((o) => `${o.phase}:${o.side}:${o.symbol}:${o.qty}`).join(',') +
        '|' +
        p.notes.join(';'),
    )
    // 반영 — 계획대로 체결됐다고 가정(테스트 목적)
    for (const o of p.orders) {
      const px = o.phase === 'open' ? prices.series[o.symbol][i].o : prices.series[o.symbol][i].c
      const sleeve = cfg.sleeves.find((x) => x.id === o.sleeveId)
      if (o.side === 'sell') {
        const qty = o.qty
        state.holdings[o.symbol] = (state.holdings[o.symbol] ?? 0) - qty
        if (sleeve?.kind === 'vr') state.vrCash[sleeve.id] = (state.vrCash[sleeve.id] ?? 0) + qty * px
        else if (sleeve?.kind === 'switch') state.switchHolding[sleeve.id] = '__cash__:' + String(qty * px)
      } else {
        if (sleeve?.kind === 'switch') {
          const raw = state.switchHolding[sleeve.id] ?? ''
          const cash = raw.startsWith('__cash__:') ? Number(raw.slice(9)) : 0
          const qty = Math.floor(cash / px)
          state.holdings[o.symbol] = (state.holdings[o.symbol] ?? 0) + qty
          state.switchHolding[sleeve.id] = o.symbol
        } else {
          state.holdings[o.symbol] = (state.holdings[o.symbol] ?? 0) + o.qty
          if (sleeve?.kind === 'vr') state.vrCash[sleeve.id] = (state.vrCash[sleeve.id] ?? 0) - o.qty * px
        }
      }
    }
    // VR의 V는 점검일마다 성장 — 계획 함수와 같은 규칙으로 상태에 반영
    for (const s of cfg.sleeves) {
      if (s.kind !== 'vr') continue
      const t = i - startIdx
      if (t > 0 && t % s.periodDays === 0) state.vrV[s.id] = (state.vrV[s.id] ?? 0) * (1 + s.growthPct / 100)
    }
  }
  return { plans, state }
}

section('① 절단 불변성 (규칙 1 집행자)')
{
  const cfg = makeConfig('half')
  const full = synth(420)
  const CUT = 400
  const truncated: PriceTable = {
    dates: full.dates.slice(0, CUT),
    series: Object.fromEntries(Object.entries(full.series).map(([k, v]) => [k, v.slice(0, CUT)])),
  }
  const a = runPlans(full, cfg, CUT - 1).plans
  const b = runPlans(truncated, cfg, CUT - 1).plans
  eq('계획 개수 동일', a.length, b.length)
  let firstDiff = -1
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      firstDiff = i
      break
    }
  }
  check(
    '잘린 시점 이전 계획이 완전히 동일',
    firstDiff === -1,
    firstDiff === -1 ? '전 구간 일치' : `첫 불일치 ${firstDiff}:\n  full=${a[firstDiff]}\n  cut =${b[firstDiff]}`,
  )
  const orderDays = a.filter((x) => x.split('|')[2].length > 0).length
  check('표본이 충분히 활동적(주문 발생일 5일 이상)', orderDays >= 5, `주문 발생일 ${orderDays}일`)
}

section('② switch 신호 — 전일 종가 기준·이평선 판정')
{
  // 명시적 시세: 10일선, 마지막 날 직전에 선을 아래로 깬다
  const dates = Array.from({ length: 14 }, (_, i) => `2024-01-${String(i + 1).padStart(2, '0')}`)
  const mk = (cs: number[]): DailyBarLite[] => cs.map((c, i) => ({ date: dates[i], o: c, c }))
  const up = [100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 80, 79]
  const prices: PriceTable = { dates, series: { QQQ: mk(up), TQQQ: mk(up.map((x) => x * 2)) } }
  const cfg: UsLevConfig = {
    sleeves: [
      { kind: 'switch', id: 'sw', weight: 1, signalSymbol: 'QQQ', upSymbol: 'TQQQ', downSymbol: 'QQQ', smaLen: 10 },
    ],
    rebalanceEveryDays: 0,
    driftTolerancePct: 1,
  }
  const state: UsLevState = {
    startDate: dates[9],
    holdings: { TQQQ: 10 },
    vrV: {},
    vrCash: {},
    switchHolding: { sw: 'TQQQ' },
  }
  // i=12(종가 80)에서 신호가 아니라, i=13에서 "전일(i=12) 종가 80 < 10일선" 판정이어야 한다
  const p12 = planDay(prices, 12, cfg, state)
  eq('급락 당일에는 교체 주문 없음(전일 기준이므로)', p12.orders.length, 0)
  const p13 = planDay(prices, 13, cfg, state)
  eq('다음날 교체 주문 2건(매도+매수)', p13.orders.length, 2)
  eq('매도 대상은 기존 보유 TQQQ', p13.orders[0].symbol, 'TQQQ')
  eq('매수 대상은 QQQ', p13.orders[1].symbol, 'QQQ')
  eq('체결 단계는 개장 시가', p13.orders[0].phase, 'open')
}

section('③ VR 밴드 판정')
{
  const dates = Array.from({ length: 41 }, (_, i) => `2024-02-${String((i % 28) + 1).padStart(2, '0')}-${i}`)
  const flat = (v: number): DailyBarLite[] => dates.map((d) => ({ date: d, o: v, c: v }))
  const cfg: UsLevConfig = {
    sleeves: [
      { kind: 'vr', id: 'vr', weight: 1, symbol: 'SOXL', periodDays: 20, growthPct: 0, bandPct: 20, initialStockPct: 50 },
    ],
    rebalanceEveryDays: 0,
    driftTolerancePct: 1,
  }
  const base: UsLevState = {
    startDate: dates[0],
    holdings: { SOXL: 100 },
    vrV: { vr: 10000 },
    vrCash: { vr: 10000 },
    switchHolding: {},
  }
  // 주가 130 → 평가 13,000 > V 10,000 × 1.2 = 12,000 → 매도
  {
    const prices: PriceTable = { dates, series: { SOXL: flat(130) } }
    const p = planDay(prices, 20, cfg, base)
    eq('밴드 상단 초과 → 매도 1건', p.orders.length, 1)
    eq('매도 방향', p.orders[0].side, 'sell')
    eq('V까지 줄이는 수량', p.orders[0].qty, Math.floor((13000 - 10000) / 130))
  }
  // 주가 70 → 평가 7,000 < V × 0.8 = 8,000 → 매수
  {
    const prices: PriceTable = { dates, series: { SOXL: flat(70) } }
    const p = planDay(prices, 20, cfg, base)
    eq('밴드 하단 이탈 → 매수 1건', p.orders.length, 1)
    eq('매수 방향', p.orders[0].side, 'buy')
    eq('V까지 채우는 수량', p.orders[0].qty, Math.floor(Math.min(10000, 10000 - 7000) / 70))
  }
  // 주가 105 → 평가 10,500, 밴드 8,000~12,000 안 → 무매매
  {
    const prices: PriceTable = { dates, series: { SOXL: flat(105) } }
    const p = planDay(prices, 20, cfg, base)
    eq('밴드 안 → 주문 없음', p.orders.length, 0)
    check('무매매 사유가 기록됨', p.notes.some((n) => n.includes('밴드 안')), p.notes.join(' / '))
  }
  // 점검일이 아니면 아무 일도 없다
  {
    const prices: PriceTable = { dates, series: { SOXL: flat(130) } }
    const p = planDay(prices, 19, cfg, base)
    eq('점검일 아님 → 주문 없음', p.orders.length, 0)
  }
}

section('④ 재배분 문턱')
{
  const dates = Array.from({ length: 30 }, (_, i) => `2024-03-${i}`)
  const flat = (v: number): DailyBarLite[] => dates.map((d) => ({ date: d, o: v, c: v }))
  const prices: PriceTable = { dates, series: { QQQ: flat(100), TQQQ: flat(100), GLD: flat(100) } }
  const cfg: UsLevConfig = {
    sleeves: [
      { kind: 'switch', id: 'sw', weight: 0.5, signalSymbol: 'QQQ', upSymbol: 'TQQQ', downSymbol: 'QQQ', smaLen: 5 },
      { kind: 'hold', id: 'gold', weight: 0.5, symbol: 'GLD' },
    ],
    rebalanceEveryDays: 21,
    driftTolerancePct: 1,
  }
  // 50:50 정확히 맞는 상태 → 재배분일이어도 매매 없음
  {
    const state: UsLevState = {
      startDate: dates[0],
      holdings: { TQQQ: 100, GLD: 100 },
      vrV: {},
      vrCash: {},
      switchHolding: { sw: 'TQQQ' },
    }
    const p = planDay(prices, 21, cfg, state)
    eq('비중 정확 → 재배분 주문 없음', p.orders.filter((o) => o.reason.startsWith('재배분')).length, 0)
    check('생략 사유 기록', p.notes.some((n) => n.includes('생략')), p.notes.join(' / '))
  }
  // 70:30으로 벌어진 상태 → 재배분 발생
  {
    const state: UsLevState = {
      startDate: dates[0],
      holdings: { TQQQ: 140, GLD: 60 },
      vrV: {},
      vrCash: {},
      switchHolding: { sw: 'TQQQ' },
    }
    const p = planDay(prices, 21, cfg, state)
    const rb = p.orders.filter((o) => o.reason.startsWith('재배분'))
    eq('재배분 주문 2건', rb.length, 2)
    eq('과대 슬리브는 매도', rb.find((o) => o.symbol === 'TQQQ')?.side, 'sell')
    eq('과소 슬리브는 매수', rb.find((o) => o.symbol === 'GLD')?.side, 'buy')
    // 총 20,000 · 목표 각 10,000 · TQQQ 평가 14,000 → 초과 4,000 → 40주
    eq('매도 수량 = 초과분/가격', rb.find((o) => o.symbol === 'TQQQ')?.qty, 40)
    eq('매수 수량도 동일 규모', rb.find((o) => o.symbol === 'GLD')?.qty, 40)
  }
}

section('⑤ 설정 검증')
{
  const prices = synth(300)
  const bad: UsLevConfig = {
    sleeves: [{ kind: 'hold', id: 'g', weight: 0.7, symbol: 'GLD' }],
    rebalanceEveryDays: 21,
    driftTolerancePct: 1,
  }
  const state: UsLevState = { startDate: prices.dates[10], holdings: {}, vrV: {}, vrCash: {}, switchHolding: {} }
  let threw = false
  try {
    planDay(prices, 20, bad, state)
  } catch {
    threw = true
  }
  check('비중 합이 1이 아니면 던진다', threw, '조용히 진행하면 자산 일부가 방치된다')

  const half = makeConfig('half')
  eq('half 프리셋 슬리브 2개', half.sleeves.length, 2)
  eq('half 비중 합 1', half.sleeves.reduce((s, x) => s + x.weight, 0), 1)
  eq('gold20 프리셋 슬리브 4개', makeConfig('gold20').sleeves.length, 4)
  eq('gold10 비중 합 1', Number(makeConfig('gold10').sleeves.reduce((s, x) => s + x.weight, 0).toFixed(10)), 1)
}

finish()
