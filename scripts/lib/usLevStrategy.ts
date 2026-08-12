// 미장 레버리지 혼합 전략 — 판단 코어 (48~50차 확정 규칙의 코드화)
//
// 이 파일은 **무엇을 살지/팔지만 계산한다.** 주문 전송·시세 수집·스케줄은 하지 않는다
// (국내 mockTradeCore.ts 와 같은 분리 — 판단 로직을 데몬과 백테스트가 공유하게 하려는 것).
//
// ── 전략 (ops/context/investing/혼합전략-운용규칙서_2026-08-09.md 정본) ───────────
//   슬리브 3종을 고정 비중으로 굴린다. 비중은 **설정값**이다(50차에서 금 슬리브가 더 나은
//   조합을 냈으므로 코드에 특정 배분을 박지 않는다):
//     · switch — 신호자산의 N일선 위/아래로 up/down 자산을 100% 교체. 체결 = 익일 시가.
//     · vr     — 라오어 밸류 리밸런싱 근사. periodDays마다 V×(1+growth) 갱신 후 밴드 밖이면
//                V까지 부분 매수/매도. 체결 = 당일 종가(원저 방식).
//     · hold   — 매수 후 보유(금 등). 재배분 때만 건드린다.
//   재배분: rebalanceEveryDays 거래일마다, 목표에서 driftTolerancePct 이상 어긋난 경우에만.
//
// ── 규칙 1 (미래참조 금지) ───────────────────────────────────────────────────────
//   · switch 신호는 **전일 종가와 전일 SMA**만 본다 → 당일 시가에 체결(신호·체결 분리).
//   · vr·재배분은 당일 종가로 판정하고 당일 종가에 체결한다. 종가는 그 시점에 관측된
//     값이므로 미래참조가 아니다(판단 데이터 = 체결 데이터, 규칙 1-2 알고리즘형 허용).
//   · 주기 카운트는 **운용 시작일로부터 지난 거래일 수**로 센다. 데이터 끝에서 역산하지
//     않는다(역산하면 미래 길이를 아는 셈이 된다).
//   · 집행자: tests/uslevstrategy.test.ts 의 절단 불변성 — 뒤를 잘라내고 다시 계획해도
//     잘린 시점 이전 계획이 완전히 동일해야 한다.
//
// ── 경계 ────────────────────────────────────────────────────────────────────────
//   실행 게이트(dryRun·한도·HALT)는 이 파일이 아니라 주문 어댑터가 강제한다. 여기서는
//   **주문 의도**만 만든다 — 규칙 2 3단계(실계좌)와 무관하게 계산·검증 가능한 계층이다.

export interface DailyBarLite {
  date: string
  o: number
  c: number
}

export interface SwitchSleeve {
  kind: 'switch'
  id: string
  weight: number
  /** 신호를 읽는 심볼 (예: QQQ) */
  signalSymbol: string
  /** 선 위일 때 보유 */
  upSymbol: string
  /** 선 아래일 때 보유 */
  downSymbol: string
  /** 이동평균 기간 (거래일) */
  smaLen: number
}

export interface VrSleeve {
  kind: 'vr'
  id: string
  weight: number
  symbol: string
  /** 점검 주기(거래일) */
  periodDays: number
  /** 점검마다 V를 올리는 비율(%) */
  growthPct: number
  /** 밴드 폭(%) — 밖으로 나가야 매매 */
  bandPct: number
  /** 최초 편입 비율(%) — 나머지는 현금 */
  initialStockPct: number
}

export interface HoldSleeve {
  kind: 'hold'
  id: string
  weight: number
  symbol: string
}

export type Sleeve = SwitchSleeve | VrSleeve | HoldSleeve

export interface UsLevConfig {
  sleeves: Sleeve[]
  /** 슬리브 간 재배분 주기(거래일). 0이면 재배분하지 않는다. */
  rebalanceEveryDays: number
  /** 목표 비중에서 이만큼(%p) 이상 어긋나야 재배분한다 */
  driftTolerancePct: number
}

/** 데몬이 파일로 들고 다니는 상태. 계획은 (시세, 상태)의 순수 함수다. */
export interface UsLevState {
  /** 운용 시작 거래일 (이 날짜의 봉이 index 기준점) */
  startDate: string
  /** 슬리브별 보유 수량 — 심볼 단위 (소수점 허용 안 함: 정수 주식) */
  holdings: Record<string, number>
  /** VR 슬리브별 목표값 V (USD) */
  vrV: Record<string, number>
  /** VR 슬리브별 현금 (USD) */
  vrCash: Record<string, number>
  /** switch 슬리브별 현재 보유 자산 심볼 */
  switchHolding: Record<string, string>
}

export type OrderPhase = 'open' | 'close'

export interface PlannedOrder {
  phase: OrderPhase
  symbol: string
  side: 'buy' | 'sell'
  qty: number
  /** 사람이 읽을 근거 — 로그·알림에 그대로 쓴다 */
  reason: string
  sleeveId: string
}

export interface DayPlan {
  date: string
  /** 이날 거래일 순번 (startDate = 0) */
  tradingDayIndex: number
  orders: PlannedOrder[]
  notes: string[]
}

export interface PriceTable {
  dates: string[]
  /** 심볼 → 봉 배열 (dates와 같은 길이·같은 순서) */
  series: Record<string, DailyBarLite[]>
}

function sma(bars: DailyBarLite[], endIdx: number, len: number): number | null {
  if (endIdx < len - 1) return null
  let sum = 0
  for (let k = endIdx - len + 1; k <= endIdx; k++) sum += bars[k].c
  return sum / len
}

function need(prices: PriceTable, symbol: string): DailyBarLite[] {
  const s = prices.series[symbol]
  if (!s) throw new Error(`시세 없음: ${symbol}`)
  if (s.length !== prices.dates.length) throw new Error(`시세 길이 불일치: ${symbol}`)
  return s
}

/** 슬리브 평가액 (USD) — 종가 기준 */
export function sleeveValue(sleeve: Sleeve, state: UsLevState, prices: PriceTable, i: number): number {
  if (sleeve.kind === 'switch') {
    const sym = state.switchHolding[sleeve.id]
    if (!sym) return 0
    return (state.holdings[sym] ?? 0) * need(prices, sym)[i].c
  }
  if (sleeve.kind === 'vr') {
    return (state.holdings[sleeve.symbol] ?? 0) * need(prices, sleeve.symbol)[i].c + (state.vrCash[sleeve.id] ?? 0)
  }
  return (state.holdings[sleeve.symbol] ?? 0) * need(prices, sleeve.symbol)[i].c
}

/**
 * 하루치 주문 계획.
 *
 * @param prices  전 심볼 정렬된 일봉 (dates 공통)
 * @param i       오늘의 인덱스
 * @param cfg     전략 설정 (배분 포함)
 * @param state   전일까지 반영된 상태 — **이 함수는 state를 변경하지 않는다**
 *
 * 반환된 주문을 실제 체결가로 반영하는 것은 호출자(데몬)의 몫이다. 계획과 반영을 나눈
 * 이유는 실체결가가 계획가와 다를 수 있기 때문이다(슬리피지·미체결).
 */
export function planDay(prices: PriceTable, i: number, cfg: UsLevConfig, state: UsLevState): DayPlan {
  const date = prices.dates[i]
  const startIdx = prices.dates.indexOf(state.startDate)
  if (startIdx < 0) throw new Error(`운용 시작일이 시세에 없다: ${state.startDate}`)
  if (i < startIdx) throw new Error(`운용 시작 전 날짜는 계획하지 않는다: ${date}`)
  const t = i - startIdx
  const orders: PlannedOrder[] = []
  const notes: string[] = []

  const totalWeight = cfg.sleeves.reduce((s, x) => s + x.weight, 0)
  if (Math.abs(totalWeight - 1) > 1e-9) throw new Error(`비중 합이 1이 아니다: ${totalWeight}`)

  // ── ① 개장 시가: switch 슬리브 교체 (신호 = 전일 종가 vs 전일 SMA) ──────────────
  for (const s of cfg.sleeves) {
    if (s.kind !== 'switch') continue
    if (i === 0) continue
    const sig = need(prices, s.signalSymbol)
    const line = sma(sig, i - 1, s.smaLen)
    if (line === null) {
      notes.push(`${s.id}: SMA${s.smaLen} 미충족(데이터 부족) — 교체 판단 보류`)
      continue
    }
    const want = sig[i - 1].c > line ? s.upSymbol : s.downSymbol
    const cur = state.switchHolding[s.id]
    if (!cur) {
      notes.push(`${s.id}: 초기 편입 대상 ${want} (최초 진입은 데몬 초기화가 처리)`)
      continue
    }
    if (want === cur) continue
    const qty = state.holdings[cur] ?? 0
    if (qty > 0) {
      orders.push({
        phase: 'open',
        symbol: cur,
        side: 'sell',
        qty,
        reason: `${s.id}: 전일 ${s.signalSymbol} 종가 ${sig[i - 1].c.toFixed(2)} ${sig[i - 1].c > line ? '>' : '≤'} ${s.smaLen}일선 ${line.toFixed(2)} → ${want}로 교체(매도)`,
        sleeveId: s.id,
      })
    }
    // 매수 수량은 매도 체결대금이 확정돼야 정해지므로 qty=0(대금 전액)으로 표기한다.
    orders.push({
      phase: 'open',
      symbol: want,
      side: 'buy',
      qty: 0,
      reason: `${s.id}: ${cur} 매도대금 전액으로 ${want} 매수`,
      sleeveId: s.id,
    })
  }

  // ── ② 종가: VR 점검 (운용 시작일로부터 periodDays 배수인 날) ────────────────────
  for (const s of cfg.sleeves) {
    if (s.kind !== 'vr') continue
    if (t === 0 || t % s.periodDays !== 0) continue
    const bars = need(prices, s.symbol)
    const px = bars[i].c
    const v0 = state.vrV[s.id] ?? 0
    const v = v0 * (1 + s.growthPct / 100)
    const stockVal = (state.holdings[s.symbol] ?? 0) * px
    if (stockVal > v * (1 + s.bandPct / 100)) {
      const qty = Math.floor((stockVal - v) / px)
      if (qty >= 1) {
        orders.push({
          phase: 'close',
          symbol: s.symbol,
          side: 'sell',
          qty,
          reason: `${s.id}: 평가액 $${Math.round(stockVal)} > 목표V $${Math.round(v)} +${s.bandPct}% → V까지 부분 매도`,
          sleeveId: s.id,
        })
      } else notes.push(`${s.id}: 밴드 상단 초과지만 1주 미만이라 보류`)
    } else if (stockVal < v * (1 - s.bandPct / 100)) {
      const budget = Math.min(state.vrCash[s.id] ?? 0, v - stockVal)
      const qty = Math.floor(budget / px)
      if (qty >= 1) {
        orders.push({
          phase: 'close',
          symbol: s.symbol,
          side: 'buy',
          qty,
          reason: `${s.id}: 평가액 $${Math.round(stockVal)} < 목표V $${Math.round(v)} −${s.bandPct}% → 현금으로 V까지 매수`,
          sleeveId: s.id,
        })
      } else {
        notes.push(
          `${s.id}: 밴드 하단 이탈이지만 ${(state.vrCash[s.id] ?? 0) < px ? '현금 부족' : '1주 미만'}이라 보류`,
        )
      }
    } else {
      notes.push(`${s.id}: 밴드 안(평가 $${Math.round(stockVal)} vs V $${Math.round(v)}) — 매매 없음`)
    }
  }

  // ── ③ 종가: 슬리브 간 재배분 ──────────────────────────────────────────────────
  if (cfg.rebalanceEveryDays > 0 && t > 0 && t % cfg.rebalanceEveryDays === 0) {
    const vals = cfg.sleeves.map((s) => sleeveValue(s, state, prices, i))
    const total = vals.reduce((a, b) => a + b, 0)
    if (total > 0) {
      const drifts = cfg.sleeves.map((s, k) => (vals[k] / total - s.weight) * 100)
      const worst = Math.max(...drifts.map(Math.abs))
      if (worst >= cfg.driftTolerancePct) {
        notes.push(
          `재배분: 최대 이탈 ${worst.toFixed(1)}%p ≥ 허용 ${cfg.driftTolerancePct}%p → 목표 비중 복원 (` +
            cfg.sleeves.map((s, k) => `${s.id} ${(vals[k] / total * 100).toFixed(0)}→${(s.weight * 100).toFixed(0)}`).join(', ') +
            ')',
        )
        for (let k = 0; k < cfg.sleeves.length; k++) {
          const s = cfg.sleeves[k]
          const diff = vals[k] - total * s.weight
          if (Math.abs(diff) < 1) continue
          const sym = s.kind === 'switch' ? state.switchHolding[s.id] : s.symbol
          if (!sym) continue
          const px = need(prices, sym)[i].c
          // VR 슬리브는 현금 쿠션이 있으니 현금부터 조절하고, 모자라면 주식으로 채운다.
          const cashPart = s.kind === 'vr' ? Math.min(Math.abs(diff), state.vrCash[s.id] ?? 0) : 0
          const stockPart = Math.abs(diff) - (diff > 0 ? cashPart : 0)
          const qty = Math.floor(stockPart / px)
          if (qty >= 1) {
            orders.push({
              phase: 'close',
              symbol: sym,
              side: diff > 0 ? 'sell' : 'buy',
              qty,
              reason: `재배분: ${s.id} 비중 ${(vals[k] / total * 100).toFixed(1)}% → 목표 ${(s.weight * 100).toFixed(0)}%`,
              sleeveId: s.id,
            })
          }
        }
      } else {
        notes.push(`재배분일이지만 최대 이탈 ${worst.toFixed(1)}%p < 허용 ${cfg.driftTolerancePct}%p — 생략`)
      }
    }
  }

  return { date, tradingDayIndex: t, orders, notes }
}

/** 50차 기준 후보 배분들 — 데몬 설정의 출발점. 어느 것을 쓸지는 대표가 정한다. */
export function makeConfig(
  preset: 'half' | 'gold10' | 'gold20',
  overrides: Partial<Pick<UsLevConfig, 'rebalanceEveryDays' | 'driftTolerancePct'>> = {},
): UsLevConfig {
  const sw = (id: string, weight: number, up: string, signalSymbol: string, smaLen: number): SwitchSleeve => ({
    kind: 'switch',
    id,
    weight,
    signalSymbol,
    upSymbol: up,
    downSymbol: 'QQQ',
    smaLen,
  })
  const vr = (weight: number): VrSleeve => ({
    kind: 'vr',
    id: 'vr-soxl',
    weight,
    symbol: 'SOXL',
    periodDays: 20,
    growthPct: 2,
    bandPct: 20,
    initialStockPct: 50,
  })
  const gold = (weight: number): HoldSleeve => ({ kind: 'hold', id: 'gold', weight, symbol: 'GLD' })

  const sleeves: Sleeve[] =
    preset === 'half'
      ? [sw('sw-tqqq', 0.5, 'TQQQ', 'QQQ', 170), vr(0.5)]
      : preset === 'gold10'
        ? [sw('sw-tqqq', 0.4, 'TQQQ', 'QQQ', 170), sw('sw-soxl', 0.1, 'SOXL', 'SOXL', 150), vr(0.4), gold(0.1)]
        : [sw('sw-tqqq', 0.3, 'TQQQ', 'QQQ', 170), sw('sw-soxl', 0.2, 'SOXL', 'SOXL', 150), vr(0.3), gold(0.2)]

  return { sleeves, rebalanceEveryDays: 21, driftTolerancePct: 1, ...overrides }
}
