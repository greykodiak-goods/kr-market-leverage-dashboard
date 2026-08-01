// 모의투자 일일 운용 러너 — 규칙 2 「2단계」. 대상 서버는 키움 모의서버(mockapi)뿐이다.
//
// ⚠️ **2026-08-01: 이 러너는 폐기 예정이다.** 표준은 상주 데몬 `scripts/investing-daemon.mjs`
//    (매도 09:00 · 매수 15:20 · 마감 16:10)이며, 이 러너는 데몬을 못 띄우는 환경의 폴백으로만
//    남긴다. 판단 로직은 scripts/lib/mockTradeCore.ts 를 데몬과 **공유**하므로 갈리지 않는다.
//    다만 체결 시점이 다르다 — 이 러너는 매도도 15:20 에 낸다(백테스트 가정과 어긋나는 지점).
//
// **2026-07-31 개편: 단일 전략 → 5기법 분리 운용.**
//   모의계좌는 1개(현금 1억)뿐이라 계좌를 쪼갤 수 없다. 그래서 **러너가 장부(ledger)로
//   5개 전략을 분리 관리한다** — 전략별 자본 2,000만원·슬롯 10(슬롯당 200만원),
//   전략별 현금·포지션·매매기록·자산곡선을 따로 굴리고, 주문만 전략 태그를 달아 한 계좌로 낸다.
//   목적은 "합쳐서 얼마 벌었나"가 아니라 **어느 기법이 벤치 대비 나은가**(규칙 5 — 알파)다.
//
// 실행 가정: **평일 15:20 (KST)** — 장 마감(15:30) 직전. 종가 근사로 판단해 그 자리에서
// 지정가 주문을 낸다(승자 전략의 체결 타이밍이 sameClose/LOC 이므로).
//
// 흐름
//   1) Yahoo 일봉(오늘 포함)으로 **전략마다** 개시일부터 오늘까지 전부 재계산한다
//      (paper-trade.entry.ts 와 같은 재실행형 — 상태 전이 버그 원천 차단).
//   2) **오늘 날짜에 새로 잡힌 진입/청산만** 뽑고, **장부 기준으로** 수량을 산출한다
//      (매도는 장부 보유분만, 매수는 장부 현금·슬롯 한도 안에서).
//   3) 계좌 제약을 씌운다 — 같은 종목 매도 합이 계좌 실보유량을 넘으면 축소(경고),
//      전략 합산 매수액이 계좌 현금을 넘으면 축소·제외.
//   4) scripts/lib/kiwoomOrder.mjs 로 모의 주문을 낸다(**기본 dryRun** — `--live` 필요).
//      게이트(1회 한도·일일 건수·HALT)는 그 어댑터가 강제한다. 여기서 우회하지 않는다.
//   5) 게이트를 통과한 주문만 **전송가를 체결가로 가정**해 장부에 반영하고,
//      ledger.json / summary.json / journal.json 을 갱신한다.
//
// 경계·한계
//   - 15:20 시점의 "오늘 봉"은 **미확정**이다. 종가 확정 전 값으로 판단하므로 시뮬레이션과
//     체결이 갈릴 수 있다 — 이 괴리(슬리피지·판정차)를 실측하는 것이 2단계 게이트의 목적이다.
//     과거를 앞당겨 보는 것이 아니므로 규칙 1(미래참조) 위반은 아니다.
//   - LOC(장마감 종가) 주문은 키움 REST 지원 여부 [미검증] — 지금은 **현재가 근사 지정가**로 낸다.
//     지정가라 미체결이 날 수 있고, 그 미체결률 자체가 2단계에서 측정할 값이다.
//   - **장부는 전송가 = 체결가로 가정한다.** 미체결·부분체결·실제 체결가 차이는 반영되지 않는다.
//     따라서 장부 성과는 "가정 체결 기준"이며 계좌 실잔고와 다를 수 있다(그 차이를 재는 게 목적).
//   - 같은 종목을 두 전략이 동시에 살 수 있다. 계좌 잔고는 섞이지만 장부는 분리 유지된다.
//   - 실계좌는 3단계 승인 전까지 열리지 않는다. 이 러너로는 실계좌에 주문할 수 없다.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  DEFAULT_SLOTS,
  allocateSellQty,
  applyLedgerFill,
  capBuysToCash,
  markEquity,
  summarize,
  syncLedger,
  type BuyRequest,
  type LedgerFill,
  type MockLedger,
  type MockLiveConfig,
  type StrategyLedger,
} from '../src/features/backtest/mockLedger'
// 데몬과 **공유**하는 코어 — 시세 로딩·신호·주문 계획은 여기 한 곳에만 있다(로직 복제 금지).
import {
  appendJournal,
  countWithBar,
  driftWarnings,
  entryCandidates,
  exitSignals,
  loadHistories,
  loadLedgerFile,
  neededSymbols,
  planBenchHold,
  planBuys,
  planSells,
  pricesOn,
  scopeFor,
  warmupStart,
  type PaperConfig,
  type PlannedOrder,
  type SignalLog,
} from './lib/mockTradeCore'
// JS 라이브러리(타입 선언 없음) — 게이트·시크릿 처리는 전부 이 모듈들이 강제한다.
import { createKiwoomOrderClient, readDailyCount, kstToday } from './lib/kiwoomOrder.mjs'
import { loadSecret } from './lib/loadSecret.mjs'

const root = process.env.REPO_ROOT ?? process.cwd()
const paperDir = join(root, 'public', 'data', 'paper')
const liveDir = join(root, 'public', 'data', 'mock-live')
const journalPath = join(liveDir, 'journal.json')
const ledgerPath = join(liveDir, 'ledger.json')
const summaryPath = join(liveDir, 'summary.json')
const configPath = join(liveDir, 'config.json')

const args = new Set(process.argv.slice(2))
const live = args.has('--live')
/** 같은 날 두 번째 실행에서도 장부를 다시 반영한다(기본은 이중 반영 방지로 건너뛴다). */
const again = args.has('--again')

async function main() {
  const today = kstToday()
  const paper = JSON.parse(readFileSync(join(paperDir, 'config.json'), 'utf8')) as PaperConfig
  if (!existsSync(configPath)) throw new Error('전략 설정이 없다: public/data/mock-live/config.json')
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as MockLiveConfig
  const slots = config.slotsPerStrategy ?? DEFAULT_SLOTS
  const cost = paper.cost
  const paperCost = { feePct: cost.feePct, taxPct: cost.taxPct }

  console.log(
    `모의투자 일일 운용 — ${today} · 전략 ${config.strategies.length}개 × ${config.perStrategyCapitalKrw.toLocaleString()}원(슬롯 ${slots}) · 모드 ${
      live ? '⚠️ LIVE' : 'dryRun'
    }`,
  )

  // ── 0) 장부 로드·동기화 ────────────────────────────────────────────────────
  let ledger: MockLedger = loadLedgerFile(ledgerPath, config)
  const synced = syncLedger(ledger, config, today)
  ledger = synced.ledger
  if (synced.added.length) console.log(`장부 신설: ${synced.added.join(', ')}`)
  if (synced.retired.length) console.log(`⚠️ config 에서 빠진 전략(기록 보존): ${synced.retired.join(', ')}`)
  const alreadyRan = ledger.lastRunDate === today && !again
  if (alreadyRan) console.log(`ℹ️ 오늘(${today}) 이미 반영됨 — 주문 없이 평가·요약만 갱신한다(재반영은 --again).`)

  // ── 1) 시세 로드 ───────────────────────────────────────────────────────────
  // 전략들이 참조하는 트랙(유니버스 단일 원본 = paper/config.json)과 벤치 심볼만 받는다.
  const { needed } = neededSymbols(paper, config)
  const since = warmupStart(ledger, config)
  console.log(`시세 로드 ${needed.length}종목 · 워밍업 ${since}~`)

  const { histories, failed } = await loadHistories({ symbols: needed, since })
  if (failed.length) console.log(`⚠️ 로드 실패 ${failed.length}: ${failed.slice(0, 10).join(', ')}${failed.length > 10 ? ' …' : ''}`)
  if (Object.keys(histories).length < 20)
    throw new Error(`시세 로드가 ${Object.keys(histories).length}종목뿐이라 중단 — 주문을 내지 않는다`)

  // 오늘 봉이 실제로 들어왔는지 확인 — 휴장일·데이터 지연이면 아무것도 하지 않는다.
  const withToday = countWithBar(histories, today)
  if (withToday < Object.keys(histories).length * 0.5) {
    console.log(`오늘(${today}) 봉이 있는 종목 ${withToday}개뿐 — 휴장 또는 데이터 미갱신으로 보고 주문 없이 종료`)
    appendJournal(journalPath, {
      at: new Date().toISOString(),
      date: today,
      runner: 'mock-trade-daily',
      skipped: '오늘 봉 부족(휴장/지연)',
      withToday,
    })
    return
  }

  /** 오늘 종가(미확정 근사) — 오늘 봉이 없는 종목은 제외 */
  const prices = pricesOn(histories, today)

  // ── 2) 전략별 신호 → 장부 기준 주문 계획 ───────────────────────────────────
  const planned: PlannedOrder[] = []
  const skipped: string[] = []
  const signalLog: Record<string, SignalLog> = {}

  for (const cfg of config.strategies) {
    const s = ledger.strategies[cfg.id]
    if (!s) continue

    // 대조군: 엔진 없이 첫 실행일에 전략자본어치 매수 후 보유(잔여 현금은 그대로 둔다).
    if (cfg.type === 'benchHold') {
      const orders = planBenchHold({ cfg, ledger: s, prices, cost, skipped })
      signalLog[cfg.id] = {
        entries: orders.map((o) => o.symbol),
        exits: [],
        engineOpen: s.positions.length,
        ledgerOpen: s.positions.length,
      }
      planned.push(...orders)
      continue
    }

    // 규칙형 전략: 개시일부터 오늘까지 엔진 재계산 → 오늘 신호만
    const scope = scopeFor(cfg, paper, histories, slots)
    if (!scope) {
      skipped.push(`[${cfg.id}] universe 미지정`)
      continue
    }
    // 청산은 엔진(과거 재계산)에서, 진입은 오늘 스크리닝에서 — 엔진은 마지막 봉에 진입을
    // 만들지 않기 때문이다(규칙 1-6). 판정 함수는 둘 다 evaluateEntry 하나라 갈라지지 않는다.
    const { exits, engineOpen, engineOpenSymbols } = exitSignals({
      cfg,
      ledger: s,
      scoped: scope.scoped,
      spec: scope.spec,
      cost,
      signalDate: today,
    })
    const { candidates, regimeOff } = entryCandidates({ ledger: s, scoped: scope.scoped, spec: scope.spec, date: today })
    signalLog[cfg.id] = {
      entries: candidates,
      exits: exits.map((t) => t.symbol ?? ''),
      engineOpen,
      ledgerOpen: s.positions.length,
    }
    console.log(
      `[${cfg.id}] ${cfg.label} — 후보 ${candidates.length}${regimeOff ? '(레짐 OFF)' : ''} · 청산 ${exits.length} (엔진 보유 ${engineOpen} / 장부 보유 ${
        s.positions.length
      })`,
    )

    // 청산: **장부 보유분만** 판다(없는 물량을 파는 주문을 만들지 않는다).
    const sells = planSells({ cfg, ledger: s, exits, prices, date: today, skipped })
    planned.push(...sells)
    // 장부에는 있는데 엔진은 안 들고 있는 종목 = 표류 — 조용히 묵지 않게 보이게 만든다.
    skipped.push(
      ...driftWarnings({ cfg, ledger: s, engineOpenSymbols, sellingNow: new Set(sells.map((p) => p.symbol)), today }),
    )
    // 진입: 엔진과 같은 순서 — **오늘 청산분을 먼저 반영한 뒤**(슬롯·현금이 풀린다) 채운다.
    planned.push(
      ...planBuys({ cfg, ledger: s, candidates, prices, slots, cost, date: today, appliedSells: sells, skipped }),
    )
  }

  // ── 3) 모의계좌 자격증명 · 잔고 ────────────────────────────────────────────
  const key = loadSecret('KIWOOM_MOCK_APP_KEY')
  const secret = loadSecret('KIWOOM_MOCK_APP_SECRET')
  const account = loadSecret('KIWOOM_MOCK_ACCOUNT')
  const hasCreds = Boolean(key.value && secret.value)
  if (!hasCreds && live) {
    console.error(key.help ?? secret.help)
    throw new Error('--live 인데 모의투자 앱키가 없다 — 전송하지 않고 중단')
  }

  let client: any = null
  let balance: { totalAssetKrw: number | null; cashKrw: number | null; holdings: { symbol: string; qty: number }[] } | null = null
  if (hasCreds) {
    client = createKiwoomOrderClient({
      appKey: key.value,
      appSecret: secret.value,
      accountNo: account.value ?? undefined,
      dryRun: !live,
      root,
    })
    if (client.isHalted()) console.log('🛑 HALT 파일 존재 — 게이트가 모든 주문을 차단한다(계획만 기록)')
    try {
      balance = await client.getBalance()
      console.log(
        `잔고 — 총평가 ${balance?.totalAssetKrw ?? '[파싱실패]'} · 현금 ${balance?.cashKrw ?? '[파싱실패]'} · 보유 ${balance?.holdings.length ?? 0}종목`,
      )
    } catch (e) {
      console.error(`⚠️ 잔고 조회 실패: ${(e as Error).message} — 계좌 제약은 장부 합으로 [추정] 대체`)
    }
  } else {
    console.log('ℹ️ 모의투자 앱키 없음 — 전송 없이 장부만 굴린다(가정 체결).')
  }

  // ── 4) 계좌 제약 적용 (장부 5개 → 계좌 1개) ────────────────────────────────
  const warnings: string[] = []
  const sells = planned.filter((p) => p.side === 'sell')
  const buys = planned.filter((p) => p.side === 'buy')

  // 4-1) 같은 종목 매도 합 > 계좌 실보유량이면 축소한다(없는 물량을 팔지 않는다).
  const byCode = new Map<string, PlannedOrder[]>()
  for (const p of sells) byCode.set(p.code, [...(byCode.get(p.code) ?? []), p])
  for (const [code, group] of byCode) {
    const accountQty = balance ? balance.holdings.find((h) => h.symbol === code)?.qty ?? 0 : null
    const requestedSum = group.reduce((sum, g) => sum + g.qty, 0)
    const alloc = allocateSellQty(
      group.map((g) => ({ strategyId: g.strategyId, qty: g.qty })),
      accountQty,
    )
    for (let i = 0; i < group.length; i++) {
      const a = alloc[i]
      if (a.qty === group[i].qty) continue
      warnings.push(
        `계좌 실보유 부족 — ${code} 매도 [${group[i].strategyId}] ${a.requested}→${a.qty}주 (계좌 보유 ${accountQty}주 · 장부 합 ${requestedSum}주)`,
      )
      group[i].note = `계좌 보유 부족으로 ${a.requested}→${a.qty}주 축소`
      group[i].qty = a.qty
    }
  }

  // 4-2) 전략 합산 매수액 > 계좌 현금이면 줄이거나 뺀다.
  //      잔고를 못 읽었으면 장부 현금 합을 [추정] 한도로 쓴다(보수적).
  const ledgerCashSum = Object.values(ledger.strategies).reduce((sum, x) => sum + x.cash, 0)
  const cashCap = balance?.cashKrw ?? (hasCreds ? ledgerCashSum : null)
  const cashCapEstimated = balance?.cashKrw == null
  const capped = capBuysToCash(
    buys.map<BuyRequest>((b) => ({ strategyId: b.strategyId, symbol: b.symbol, qty: b.qty, price: b.price })),
    cashCap,
  )
  for (let i = 0; i < buys.length; i++) {
    if (!capped[i].note) continue
    warnings.push(`[${buys[i].strategyId}] 매수 ${buys[i].symbol} — ${capped[i].note}${cashCapEstimated ? ' [추정 한도]' : ''}`)
    buys[i].note = capped[i].note
    buys[i].qty = capped[i].qty
  }

  // 매도 먼저 — 현금 확보 후 매수. 수량 0이 된 건은 내보내지 않는다.
  const toSend = [...sells, ...buys].filter((p) => p.qty > 0)
  if (skipped.length) console.log(`건너뜀 ${skipped.length}: ${skipped.slice(0, 20).join(', ')}${skipped.length > 20 ? ' …' : ''}`)
  for (const w of warnings) console.log(`⚠️ ${w}`)

  // 일일 주문 건수 하드 게이트는 어댑터가 강제한다 — 여기서는 초과가 예상되면 알리기만 한다.
  const { count: sentToday } = readDailyCount(root, today)
  const remaining = (client?.limits?.maxDailyOrders ?? 30) - sentToday
  if (client && toSend.length > remaining) {
    const msg = `주문 ${toSend.length}건인데 오늘 남은 한도 ${remaining}건 — 초과분은 게이트가 차단하고 장부에도 반영되지 않는다`
    console.log(`⚠️ ${msg}`)
    warnings.push(msg)
  }

  // ── 5) 전송 → 통과한 것만 장부에 반영 ──────────────────────────────────────
  const results: unknown[] = []
  for (const p of toSend) {
    console.log(
      `[${p.strategyId}] ${p.side === 'buy' ? '매수' : '매도'} ${p.code} ${p.qty}주 @ ${p.price.toLocaleString()} — ${p.reason}`,
    )
    let sendResult: Record<string, unknown>
    if (alreadyRan) {
      sendResult = { sent: false, ok: false, note: '오늘 이미 반영됨 — 전송·반영 안 함(--again 으로 강제)' }
    } else if (!client) {
      // 자격증명이 없으면 전송은 못 하지만 **장부는 굴린다** — 그래야 개통 전에도
      // 5기법 비교 리포트가 쌓인다. 계좌와 다르다는 사실은 저널·요약에 남는다.
      sendResult = { sent: false, ok: true, note: '자격증명 없음 — 전송 없이 장부만(가정 체결)' }
    } else {
      sendResult = await client.placeOrder({ side: p.side, symbol: p.code, qty: p.qty, price: p.price, orderType: 'limit' })
    }

    let ledgerApplied = false
    let ledgerRejected: string | null = null
    if (sendResult.ok === true) {
      const applied = applyLedgerFill(
        ledger.strategies[p.strategyId],
        { date: today, symbol: p.symbol, side: p.side, qty: p.qty, price: p.price, reason: p.reason } satisfies LedgerFill,
        paperCost,
      )
      if (applied.rejected) {
        ledgerRejected = applied.rejected
        console.log(`  ⚠️ 장부 거부 — ${applied.rejected}`)
        warnings.push(`[${p.strategyId}] ${p.symbol} 장부 거부: ${applied.rejected}`)
      } else {
        ledger = { ...ledger, strategies: { ...ledger.strategies, [p.strategyId]: applied.ledger } }
        ledgerApplied = true
      }
    }
    results.push({ ...p, ...sendResult, ledgerApplied, ledgerRejected })
  }

  // ── 6) 평가·저장 ───────────────────────────────────────────────────────────
  const marked: Record<string, StrategyLedger> = {}
  for (const [id, s] of Object.entries(ledger.strategies)) marked[id] = markEquity(s, today, prices)
  ledger = {
    ...ledger,
    strategies: marked,
    updatedAt: new Date().toISOString(),
    lastRunDate: alreadyRan ? ledger.lastRunDate : today,
  }

  mkdirSync(liveDir, { recursive: true })
  writeFileSync(ledgerPath, JSON.stringify(ledger, null, 1))

  const summary = summarize(ledger, config, prices, today, { dryRun: !live })
  writeFileSync(summaryPath, JSON.stringify(summary, null, 1))

  console.log('\n── 전략별 성과 (가정 체결 기준) ──')
  for (const r of summary.strategies) {
    const alpha = r.alphaPct == null ? '(벤치)' : `${r.alphaPct >= 0 ? '+' : ''}${r.alphaPct}%p`
    console.log(
      `  ${r.id.padEnd(12)} 평가 ${r.equity.toLocaleString().padStart(12)}원 (${r.totalPct >= 0 ? '+' : ''}${r.totalPct}%) · 알파 ${alpha} · 보유 ${
        r.positions
      } · 청산 ${r.closedTrades} · 승률 ${r.winRatePct ?? '—'}%${r.retired ? ' [retired]' : ''}`,
    )
  }
  console.log(
    `  합계 평가 ${summary.totals.equity.toLocaleString()}원 (${summary.totals.totalPct >= 0 ? '+' : ''}${summary.totals.totalPct}%)`,
  )

  const n = appendJournal(journalPath, {
    at: new Date().toISOString(),
    date: today,
    runner: 'mock-trade-daily',
    mode: live ? 'live-mock' : 'dryRun',
    server: client?.base ?? null,
    limits: client?.limits ?? null,
    halted: client?.isHalted() ?? null,
    alreadyRan,
    capital: {
      perStrategyKrw: config.perStrategyCapitalKrw,
      slots,
      accountCashCapKrw: cashCap == null ? null : Math.round(cashCap),
      accountCashEstimated: cashCapEstimated,
      accountTotalAssetKrw: balance?.totalAssetKrw ?? null,
    },
    signals: signalLog,
    orders: results,
    skipped,
    warnings,
    summary: summary.strategies.map((r) => ({
      id: r.id,
      equity: r.equity,
      totalPct: r.totalPct,
      alphaPct: r.alphaPct,
      positions: r.positions,
      closedTrades: r.closedTrades,
      winRatePct: r.winRatePct,
    })),
    dataNote: summary.dataNote,
    excluded: failed,
  })
  console.log(`\n저널 ${n}건 · 장부 public/data/mock-live/ledger.json · 요약 summary.json 갱신`)
  console.log(live ? '⚠️ LIVE 모드로 실행됨 — 모의서버 주문 결과를 HTS(모의)에서 대조하세요.' : 'dryRun 완료 — 실제 주문은 --live 를 줘야 나갑니다.')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
