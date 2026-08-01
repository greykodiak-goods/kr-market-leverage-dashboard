// 24시간 상주 모의투자 데몬 — 규칙 2 「2단계」. 대상 서버는 키움 모의서버(mockapi)뿐이다.
//
// ─────────────────────────────────────────────────────────────────────────────
// 왜 데몬인가 (2026-08-01 대표 지시)
//   기존 EC2 크론은 평일 15:20에 한 번 뜬다. 두 가지가 문제였다.
//   ① **콜드스타트** — 실행마다 git pull · npm install · 시세 80종목 로딩으로 수 분이 든다.
//      장 끝나기 10분 전에 시작하는 작업치고 위험한 준비시간이다.
//   ② **체결 시점 불일치** — 백테스트 가정은 "매도 = 익일 시가"인데 15:20에 팔면
//      하루치 종가 변동을 통째로 더 먹거나 잃는다. 시뮬과 실측을 대조하는 게 2단계
//      게이트의 목적인데, 그 대조 자체가 오염된다.
//   그래서 상주 프로세스로 바꾸고 **매도를 개장 동시호가에 시장가로 접수**한다.
//   시세·토큰은 08:30에 미리 데워 두므로 개장 시점의 준비시간은 0에 가깝다.
//
// 하루 (KST · scripts/lib/daemonSchedule.ts 가 정본)
//   08:30      프리로드 — 일봉 재로딩 · **전일 종가 기준** 청산 대상 확정 · 토큰 워밍업
//   08:59:30   매도접수 — 확정된 청산 대상을 **시장가**로 접수(개장 동시호가 참여)
//                         → 09:00 개장가 체결 = 백테스트의 "익일 시가 매도" 가정과 일치
//   09:01      체결확인 — 체결내역·잔고 조회, 미체결이면 **1회 재주문**, 체결가로 장부 반영
//   15:20      매수    — 당일 근실시간 시세로 진입 후보 산출 → 매수 주문 → 장부 반영
//   16:10      마감    — 평가·요약·저널 갱신 + public/data/mock-live 커밋·푸시
//   토·일      아무것도 하지 않는다. 공휴일은 "당일 봉이 없다"는 사실로 각 단계가 판정한다.
//
// 타이머: **다음 슬롯까지 자는 정밀 알람(setTimeout)** + 30초 보조 tick(놓친 슬롯 만회 전용).
//   초 단위 폴링은 하지 않는다. 어느 쪽으로 깨어나든 실행 판정은 순수 함수 `dueSlots` 하나가 한다.
//
// 규칙 1(미래참조 금지)과의 관계 — 이 데몬의 가장 민감한 지점
//   아침 청산 판정은 `planPreloadSells` 가 **당일 봉을 잘라낸** 시계열로만 한다.
//   당일 값이 무엇이든 판정이 바뀌지 않아야 하며, tests/investing-daemon.test.ts 의
//   절단 불변성 테스트가 이를 강제한다. 반면 **체결가**로 당일 시가·실체결가를 쓰는 것은
//   그 시점에 관측 가능한 값이므로 미래참조가 아니다(판단 데이터 ≠ 체결 데이터).
//
// 멱등: 단계별 반영 기록이 `ledger.phases[날짜][단계]` 에 남는다. 재시작하거나 같은 단계를
//   수동으로 다시 돌려도 장부가 이중 반영되지 않는다(runLedgerPhase 가 가드).
//
// 경계
//   - 주문은 scripts/lib/kiwoomOrder.mjs 의 submit() 단일 통로로만 나간다. **dryRun 기본 true**
//     (`--live` 를 줘야 실제 모의서버로 전송). 1회 한도·일일 건수·HALT 게이트는 그 어댑터가 강제한다.
//   - 데몬 루프도 HALT 파일을 직접 확인해 로그를 남기고 주문 단계를 보류한다(이중 방어).
//   - 실서버 주소·실서버 주문 엔드포인트는 이 파일에 없다(3단계 미승인 — 규칙 2).
//   - 시크릿은 loadSecret.mjs 로만 읽고 값은 어디에도 출력하지 않는다.
//   - 판단 로직은 scripts/lib/mockTradeCore.ts 를 일일 러너와 공유한다(복제 금지).
//
// 한계 (규칙 3 — 데이터 정직성)
//   - **공휴일 사전 판정 불가**: 오프라인 휴장 달력이 없어 개장 전 시장가 접수는 공휴일에도
//     나간다(브로커가 거부하고, 체결확인 단계가 "당일 봉 없음"으로 휴장을 판정해 장부를 건드리지
//     않는다). dryRun 에서는 아무것도 전송되지 않으므로 무해하다.
//   - **체결 확인 필드 [미검증]**: kt00007 응답 파싱은 문서상 추정이다. 못 읽으면 "확인 불가"로
//     기록하고 재주문하지 않는다 — 모르는 것을 미체결로 단정해 이중 매도를 내지 않는다.
//   - 장부는 확인된 체결가가 없으면 당일 시가, 그것도 없으면 전일 종가를 `[추정]` 으로 기록한다.
//
// 실행
//   상주:   doppler run --project investing-ops --config prd -- node scripts/investing-daemon.mjs
//   1회:    node scripts/investing-daemon.mjs --once=preload|sells|confirm|buys|close
//   실주문: 위 명령에 --live 추가 (모의서버 한정)
// ─────────────────────────────────────────────────────────────────────────────

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  DEFAULT_SLOTS,
  allocateSellQty,
  capBuysToCash,
  markEquity,
  markPhase,
  phaseDone,
  runLedgerPhase,
  summarize,
  syncLedger,
  type BuyRequest,
  type MockLedger,
  type MockLiveConfig,
  type PhaseFill,
  type StrategyLedger,
} from '../src/features/backtest/mockLedger'
import {
  appendJournal,
  countWithBar,
  entryCandidates,
  loadHistories,
  loadLedgerFile,
  neededSymbols,
  opensOn,
  planBenchHold,
  planBuys,
  planPreloadSells,
  pricesOn,
  repriceSells,
  scopeFor,
  warmupStart,
  writeJson,
  type PaperConfig,
  type PlannedOrder,
  type PreloadPlan,
  type SignalLog,
} from './lib/mockTradeCore'
import {
  DEFAULT_RETRY_GAP_SEC,
  OPEN_WAIT_UNTIL,
  SLOTS,
  dueSlots,
  hmsToSec,
  kstParts,
  msUntilNextSlot,
  nextSlot,
  type DayState,
  type PhaseName,
} from './lib/daemonSchedule'
// JS 라이브러리(타입 선언 없음) — 게이트·시크릿은 전부 이 모듈들이 강제한다.
import { HARD_LIMITS, createKiwoomOrderClient, parseExecutions, readDailyCount, kstToday } from './lib/kiwoomOrder.mjs'
import { loadSecret } from './lib/loadSecret.mjs'

const root = process.env.REPO_ROOT ?? process.cwd()
const paperDir = join(root, 'public', 'data', 'paper')
const liveDir = join(root, 'public', 'data', 'mock-live')
const journalPath = join(liveDir, 'journal.json')
const ledgerPath = join(liveDir, 'ledger.json')
const summaryPath = join(liveDir, 'summary.json')
const configPath = join(liveDir, 'config.json')
const statePath = join(liveDir, 'daemon-state.json')

// ---- CLI --------------------------------------------------------------------

const argv = process.argv.slice(2)
const args = new Set(argv)
const live = args.has('--live')
const noGit = args.has('--no-git') || process.env.INVESTING_DAEMON_NO_GIT === '1'
const onceArg = argv.find((a) => a.startsWith('--once='))?.slice('--once='.length) ?? null
/** 보조 tick 주기(초) — 놓친 슬롯 만회 전용. 정밀 알람이 주 경로다. */
const tickSec = Number(argv.find((a) => a.startsWith('--interval='))?.slice('--interval='.length) ?? 30) || 30

const PHASES: PhaseName[] = ['preload', 'sells', 'confirm', 'buys', 'close']
if (onceArg && !PHASES.includes(onceArg as PhaseName)) {
  console.error(`--once 는 ${PHASES.join('|')} 중 하나여야 한다 (받은 값: ${onceArg})`)
  process.exit(2)
}

const log = (msg: string) => console.log(`[${new Date().toISOString()}] ${msg}`)

// ---- 데몬 상태 (재시작 대비) -------------------------------------------------

interface DaemonState extends DayState {
  version: 1
  updatedAt: string
  /** 프리로드 산출물 — 재시작해도 아침 매도가 그대로 나가도록 파일에 남긴다 */
  preload: (PreloadPlan & { at: string; tokenWarm: boolean | null }) | null
  /** 08:59:30에 실제로 접수(게이트 통과)된 매도 — 09:01 체결확인이 이걸 대조한다 */
  submitted: PlannedOrder[] | null
  submittedAt: string | null
  /**
   * 그 매도가 **실제로 브로커에 전송돼 수리**됐나(dryRun·자격증명 없음이면 false).
   * true 면 시장이 열려 있었다는 뜻이므로, 시세를 못 읽어도 휴장으로 판정하지 않는다 —
   * 실제로 판 물량을 장부에서 빠뜨리면 장부와 계좌가 조용히 갈라진다.
   */
  sentLive: boolean
  /** 미체결 재주문은 하루 1회만 */
  reorder: { checked: boolean; count: number; note: string | null }
  /** 최근 평가용 종가 맵 (마감 단계가 쓴다) */
  prices: Record<string, number> | null
  /** 당일 거래일 여부 — 휴장으로 판정되면 false (이후 주문 단계 전면 skip) */
  tradingDay: boolean | null
  notes: string[]
}

function emptyState(date: string): DaemonState {
  return {
    version: 1,
    date,
    done: [],
    lastAttemptAt: {},
    updatedAt: new Date().toISOString(),
    preload: null,
    submitted: null,
    submittedAt: null,
    sentLive: false,
    reorder: { checked: false, count: 0, note: null },
    prices: null,
    tradingDay: null,
    notes: [],
  }
}

function loadState(today: string): DaemonState {
  if (!existsSync(statePath)) return emptyState(today)
  try {
    const j = JSON.parse(readFileSync(statePath, 'utf8')) as DaemonState
    if (!j || j.date !== today) return emptyState(today)
    return { ...emptyState(today), ...j, date: today }
  } catch {
    // 깨진 상태 파일은 치명적이지 않다 — 오늘치를 새로 만든다(장부는 별도 파일이라 안전).
    return emptyState(today)
  }
}

function saveState(state: DaemonState): void {
  writeJson(statePath, { ...state, updatedAt: new Date().toISOString() })
}

// ---- 공통 컨텍스트 -----------------------------------------------------------

interface Ctx {
  today: string
  paper: PaperConfig
  config: MockLiveConfig
  slots: number
  ledger: MockLedger
}

function loadCtx(): Ctx {
  const today = kstToday()
  const paper = JSON.parse(readFileSync(join(paperDir, 'config.json'), 'utf8')) as PaperConfig
  if (!existsSync(configPath)) throw new Error('전략 설정이 없다: public/data/mock-live/config.json')
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as MockLiveConfig
  const slots = config.slotsPerStrategy ?? DEFAULT_SLOTS
  const ledger = syncLedger(loadLedgerFile(ledgerPath, config), config, today).ledger
  return { today, paper, config, slots, ledger }
}

const isHalted = () => existsSync(join(root, HARD_LIMITS.haltFile))

interface Balance {
  totalAssetKrw: number | null
  cashKrw: number | null
  holdings: { symbol: string; qty: number }[]
}

/** 모의서버 주문 클라이언트 — 자격증명이 없으면 null(장부만 굴린다). */
function makeClient(): any | null {
  const key = loadSecret('KIWOOM_MOCK_APP_KEY')
  const secret = loadSecret('KIWOOM_MOCK_APP_SECRET')
  const account = loadSecret('KIWOOM_MOCK_ACCOUNT')
  if (!key.value || !secret.value) {
    if (live) throw new Error('--live 인데 모의투자 앱키가 없다 — 전송하지 않고 중단')
    return null
  }
  return createKiwoomOrderClient({
    appKey: key.value,
    appSecret: secret.value,
    accountNo: account.value ?? undefined,
    dryRun: !live,
    root,
  })
}

async function fetchBalance(client: any | null): Promise<Balance | null> {
  if (!client) return null
  try {
    const b = (await client.getBalance()) as Balance
    log(`잔고 — 총평가 ${b?.totalAssetKrw ?? '[파싱실패]'} · 현금 ${b?.cashKrw ?? '[파싱실패]'} · 보유 ${b?.holdings?.length ?? 0}종목`)
    return b
  } catch (e) {
    log(`⚠️ 잔고 조회 실패: ${(e as Error).message} — 계좌 제약은 장부 합으로 [추정] 대체`)
    return null
  }
}

/** 주문 전송 → **게이트를 통과한 것만** 돌려준다. 장부 반영은 호출자가 runLedgerPhase 로 한다. */
async function sendOrders(
  client: any | null,
  orders: PlannedOrder[],
): Promise<{ results: unknown[]; accepted: PlannedOrder[] }> {
  const results: unknown[] = []
  const accepted: PlannedOrder[] = []
  for (const p of orders) {
    const kind = p.orderType === 'market' ? '시장가' : '지정가'
    log(`[${p.strategyId}] ${p.side === 'buy' ? '매수' : '매도'} ${p.code} ${p.qty}주 ${kind}(기준 ${p.price.toLocaleString()}) — ${p.reason}`)
    let sendResult: Record<string, unknown>
    if (!client) {
      // 자격증명이 없어도 **장부는 굴린다** — 개통 전에도 5기법 비교 리포트가 쌓이게.
      sendResult = { sent: false, ok: true, note: '자격증명 없음 — 전송 없이 장부만(가정 체결)' }
    } else {
      sendResult = await client.placeOrder({
        side: p.side,
        symbol: p.code,
        qty: p.qty,
        price: p.price,
        orderType: p.orderType ?? 'limit',
      })
    }
    if (sendResult.ok === true) accepted.push(p)
    results.push({ ...p, ...sendResult })
  }
  return { results, accepted }
}

/** 계좌 실보유량 제약 — 같은 종목 매도 합이 계좌 보유를 넘으면 줄인다(없는 물량 매도 금지). */
function capSellsToAccount(sells: PlannedOrder[], balance: Balance | null, warnings: string[]): PlannedOrder[] {
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
      if (alloc[i].qty === group[i].qty) continue
      warnings.push(
        `계좌 실보유 부족 — ${code} 매도 [${group[i].strategyId}] ${alloc[i].requested}→${alloc[i].qty}주 (계좌 보유 ${accountQty}주 · 장부 합 ${requestedSum}주)`,
      )
      group[i].note = `계좌 보유 부족으로 ${alloc[i].requested}→${alloc[i].qty}주 축소`
      group[i].qty = alloc[i].qty
    }
  }
  return sells.filter((p) => p.qty > 0)
}

/** 일일 건수 한도 초과 예고(하드 게이트 자체는 어댑터가 강제한다). */
function warnDailyLimit(client: any | null, count: number, today: string, warnings: string[]): void {
  if (!client) return
  const { count: sentToday } = readDailyCount(root, today)
  const remaining = (client.limits?.maxDailyOrders ?? 30) - sentToday
  if (count > remaining) {
    const msg = `주문 ${count}건인데 오늘 남은 한도 ${remaining}건 — 초과분은 게이트가 차단하고 장부에도 반영되지 않는다`
    log(`⚠️ ${msg}`)
    warnings.push(msg)
  }
}

interface PhaseOutcome {
  /** false 면 단계를 완료로 기록하지 않고 나중에 재시도한다 */
  ok: boolean
  note: string
}

const done = (note: string): PhaseOutcome => ({ ok: true, note })
const retry = (note: string): PhaseOutcome => ({ ok: false, note })

/** 장부를 건드리지 않고 단계만 닫는다(주문할 것이 없거나 휴장인 날). */
function closePhaseOnly(ctx: Ctx, phase: 'sells' | 'confirm' | 'buys'): void {
  const applied = runLedgerPhase(ctx.ledger, ctx.today, phase, [], { feePct: 0, taxPct: 0 })
  if (!applied.skipped) writeJson(ledgerPath, applied.ledger)
}

// ---- 단계 ① 프리로드 (08:30) --------------------------------------------------

async function runPreload(state: DaemonState): Promise<PhaseOutcome> {
  const ctx = loadCtx()
  const { needed } = neededSymbols(ctx.paper, ctx.config)
  const since = warmupStart(ctx.ledger, ctx.config)
  log(`프리로드 — 시세 ${needed.length}종목 로딩 (워밍업 ${since}~)`)
  const { histories, failed } = await loadHistories({ symbols: needed, since })
  if (Object.keys(histories).length < 20)
    return retry(`시세 ${Object.keys(histories).length}종목뿐 — 재시도 (실패 ${failed.length})`)

  // ⚠️ 규칙 1 — 청산 판정은 **당일 봉을 잘라낸** 시계열로만 한다(planPreloadSells 내부에서 절단).
  const plan = planPreloadSells({
    config: ctx.config,
    ledger: ctx.ledger,
    paper: ctx.paper,
    histories,
    today: ctx.today,
    slots: ctx.slots,
    cost: ctx.paper.cost,
  })
  if (!plan.asOf) return retry('확정 봉이 없어 청산 판정 불가 — 재시도')

  // 토큰 워밍업 — 조회 1회로 액세스 토큰을 미리 받아 둔다(개장 시점에 발급 지연이 없도록).
  let tokenWarm: boolean | null = null
  try {
    const client = makeClient()
    if (client) {
      await client.getBalance()
      tokenWarm = true
    }
  } catch (e) {
    tokenWarm = false
    log(`⚠️ 토큰 워밍업 실패: ${(e as Error).message} — 매도 단계에서 다시 시도한다`)
  }

  state.preload = { ...plan, at: new Date().toISOString(), tokenWarm }
  state.prices = pricesOn(histories, plan.asOf)
  state.notes.push(`프리로드 ${plan.asOf} 기준 · 청산 ${plan.sells.length}건 · 시세 ${Object.keys(histories).length}종목`)
  log(
    `프리로드 완료 — 판단 기준일 ${plan.asOf}(전 거래일) · 청산 대상 ${plan.sells.length}건 · 토큰 ${
      tokenWarm == null ? '없음(자격증명 미설정)' : tokenWarm ? '워밍업 OK' : '워밍업 실패'
    }`,
  )
  if (plan.skipped.length) log(`  건너뜀/표류 ${plan.skipped.length}: ${plan.skipped.slice(0, 10).join(', ')}`)
  appendJournal(journalPath, {
    at: new Date().toISOString(),
    date: ctx.today,
    runner: 'investing-daemon',
    phase: 'preload',
    asOf: plan.asOf,
    sells: plan.sells,
    signals: plan.signals,
    skipped: plan.skipped,
    excluded: failed,
    tokenWarm,
  })
  return done(`청산 대상 ${plan.sells.length}건 확정 (기준일 ${plan.asOf})`)
}

// ---- 단계 ② 매도 접수 (08:59:30 · 시장가) --------------------------------------

async function runSells(state: DaemonState, now: Date): Promise<PhaseOutcome> {
  const ctx = loadCtx()
  if (phaseDone(ctx.ledger, ctx.today, 'sells')) return done('이미 접수됨(멱등)')
  if (state.tradingDay === false) return done('휴장으로 판정된 날 — 주문 없음')
  if (!state.preload) {
    const pre = await runPreload(state)
    if (!pre.ok) return retry(`프리로드가 아직 안 끝남 — ${pre.note}`)
    state.done = [...new Set([...state.done, 'preload' as PhaseName])]
    saveState(state)
  }
  const plan = state.preload!
  if (isHalted()) return retry('🛑 HALT 파일 존재 — 매도 접수 보류(파일을 지우면 15:00 전까지 만회)')
  if (!plan.sells.length) {
    closePhaseOnly(ctx, 'sells')
    state.submitted = []
    return done('청산 대상 없음')
  }

  const { sec } = kstParts(now)
  const onTime = sec <= hmsToSec('09:00:00')
  const warnings: string[] = []
  if (!onTime)
    warnings.push(
      '[만회 실행] 동시호가를 놓쳐 장중 시장가로 접수한다 — 체결가가 개장가가 아니므로 시가 가정과 어긋난다',
    )

  // **시장가**로 낸다 — 동시호가에 참여해 09:00 개장가로 체결시키기 위함이다.
  // price 는 게이트(1회 주문액 한도) 산정용 기준가이며 전일 종가를 쓴다.
  const orders: PlannedOrder[] = plan.sells.map((s) => ({ ...s, orderType: 'market' as const }))

  const client = makeClient()
  if (!client) log('ℹ️ 모의투자 앱키 없음 — 전송 없이 장부만 굴린다(가정 체결).')
  if (client?.isHalted()) log('🛑 HALT 파일 존재 — 게이트가 모든 주문을 차단한다')
  const balance = await fetchBalance(client)
  const toSend = capSellsToAccount(orders, balance, warnings)
  warnDailyLimit(client, toSend.length, ctx.today, warnings)
  for (const w of warnings) log(`⚠️ ${w}`)

  const { results, accepted } = await sendOrders(client, toSend)
  // 장부는 여기서 건드리지 않는다 — 체결가를 모르기 때문이다(09:01 confirm 이 반영).
  closePhaseOnly(ctx, 'sells')
  state.submitted = accepted
  state.submittedAt = new Date().toISOString()
  // 브로커가 실제로 수리한 주문이 하나라도 있으면 시장이 열려 있었다는 뜻이다.
  state.sentLive = results.some((r) => (r as Record<string, unknown>).sent === true && (r as Record<string, unknown>).ok === true)

  appendJournal(journalPath, {
    at: new Date().toISOString(),
    date: ctx.today,
    runner: 'investing-daemon',
    phase: 'sells',
    mode: live ? 'live-mock' : 'dryRun',
    server: client?.base ?? null,
    halted: client?.isHalted() ?? null,
    asOf: plan.asOf,
    orderType: 'market',
    onTime,
    orders: results,
    warnings,
    note: '개장 동시호가 시장가 접수 — 장부 반영은 09:01 체결확인 단계에서 한다',
  })
  return done(`시장가 매도 ${accepted.length}/${toSend.length}건 접수${onTime ? ' (동시호가)' : ' (만회·장중)'}`)
}

// ---- 단계 ③ 체결 확인 (09:01) --------------------------------------------------

/** 브로커 체결내역에서 종목별 체결가·미체결 수량을 뽑는다. 못 읽으면 null(=확인 불가). */
async function readFills(
  client: any | null,
  today: string,
): Promise<{ price: Record<string, number>; openQty: Record<string, number>; readable: boolean; note: string }> {
  if (!client) return { price: {}, openQty: {}, readable: false, note: '자격증명 없음 — 체결 확인 불가' }
  try {
    const res = await client.getExecutions({ date: today })
    const rows = parseExecutions(res?.raw) as {
      symbol: string
      filledQty: number | null
      avgPrice: number | null
      openQty: number | null
    }[]
    const price: Record<string, number> = {}
    const openQty: Record<string, number> = {}
    for (const r of rows) {
      if (r.avgPrice != null && r.avgPrice > 0) price[r.symbol] = r.avgPrice
      if (r.openQty != null) openQty[r.symbol] = r.openQty
    }
    return {
      price,
      openQty,
      readable: rows.length > 0,
      note: rows.length ? `체결내역 ${rows.length}종목 파싱 [미검증 필드]` : '체결내역 행 없음 — 확인 불가',
    }
  } catch (e) {
    return { price: {}, openQty: {}, readable: false, note: `체결내역 조회 실패: ${(e as Error).message}` }
  }
}

async function runConfirm(state: DaemonState, now: Date): Promise<PhaseOutcome> {
  const ctx = loadCtx()
  if (phaseDone(ctx.ledger, ctx.today, 'confirm')) return done('장부에 이미 반영됨(멱등)')
  const submitted = state.submitted
  if (submitted == null) return retry('아직 매도 접수 단계를 돌지 않았다 — 매도접수 후 재시도')
  if (submitted.length === 0) {
    closePhaseOnly(ctx, 'confirm')
    return done('접수된 매도 없음')
  }

  const client = makeClient()
  const warnings: string[] = []
  const fills = await readFills(client, ctx.today)

  // ── 미체결 재주문 (하루 1회) ───────────────────────────────────────────────
  // 모르는 것을 미체결로 단정하지 않는다 — 체결내역을 못 읽으면 재주문하지 않고 기록만 남긴다.
  let reordered: unknown[] = []
  if (!state.reorder.checked) {
    state.reorder.checked = true
    if (!fills.readable) {
      state.reorder.note = `재주문 없음 — ${fills.note}(이중 매도 위험이라 추정으로 재주문하지 않는다)`
      warnings.push(state.reorder.note)
    } else if (isHalted()) {
      state.reorder.note = '🛑 HALT — 재주문하지 않음'
      warnings.push(state.reorder.note)
    } else {
      const unfilled = submitted
        .map((s) => ({ order: s, open: fills.openQty[s.code] ?? 0 }))
        .filter((x) => x.open > 0)
        .map((x) => ({ ...x.order, qty: Math.min(x.order.qty, Math.floor(x.open)), note: '미체결 재주문(1회)' }))
      if (unfilled.length) {
        log(`미체결 ${unfilled.length}건 — 시장가 재주문 1회`)
        const r = await sendOrders(client, unfilled)
        reordered = r.results
        state.reorder.count = r.accepted.length
        state.reorder.note = `미체결 ${unfilled.length}건 재주문 · 접수 ${r.accepted.length}건`
      } else {
        state.reorder.note = '미체결 없음'
      }
    }
    log(`체결확인 — ${state.reorder.note}`)
  }

  // ── 장부 반영가 결정: 실체결가 → 당일 시가 → 참조 종가 순 ────────────────
  let priceBySymbol: Record<string, number> = {}
  for (const s of submitted) {
    const px = fills.price[s.code]
    if (px > 0) priceBySymbol[s.symbol] = px
  }
  const needOpen = submitted.filter((s) => !(priceBySymbol[s.symbol] > 0)).map((s) => s.symbol)
  if (needOpen.length) {
    const since = new Date(Date.parse(ctx.today) - 20 * 86400e3).toISOString().slice(0, 10)
    const { histories } = await loadHistories({ symbols: [...new Set(needOpen)], since, minBars: 1, delayMs: 200 })
    const opens = opensOn(histories, ctx.today)
    priceBySymbol = { ...opens, ...priceBySymbol }
    if (Object.keys(opens).length === 0 && !fills.readable) {
      // 개장했다면 이 시각에 당일 봉이 있어야 한다. 없으면 휴장이거나 데이터 장애다.
      const { sec } = kstParts(now)
      if (sec < hmsToSec(OPEN_WAIT_UNTIL)) return retry(`체결가·당일 시가 모두 미확인 — ${OPEN_WAIT_UNTIL} 까지 재시도`)
      if (!state.sentLive) {
        // 아무것도 전송되지 않았다(dryRun·자격증명 없음) → 판 것이 없으므로 장부를 건드리지 않는다.
        state.tradingDay = false
        state.notes.push('당일 봉·체결내역 모두 없음 — 휴장/데이터 장애로 판정, 장부 미반영')
        closePhaseOnly(ctx, 'confirm')
        appendJournal(journalPath, {
          at: new Date().toISOString(),
          date: ctx.today,
          runner: 'investing-daemon',
          phase: 'confirm',
          skipped: '당일 봉·체결내역 없음(휴장/데이터 장애) — 장부 미반영',
          submitted: submitted.length,
          warnings,
        })
        return done('휴장/데이터 장애 판정 — 장부 미반영')
      }
      // 브로커가 수리한 주문이 있다 = 시장이 열려 있었다. **실제로 판 물량을 장부에서
      // 빠뜨리면 장부와 계좌가 조용히 갈라진다** — 참조 종가로라도 기록하고 크게 표시한다.
      warnings.push(
        '⚠️ 전송·수리된 매도인데 체결가·시가를 확인할 수 없다 — 참조 종가(전일 종가)로 [추정] 기록한다(이 건은 슬리피지 실측 대상에서 제외)',
      )
    }
  }

  const { orders, priced, fallback } = repriceSells(submitted, priceBySymbol)
  if (fallback.length) warnings.push(`[추정] 체결가·시가 미확인 ${fallback.length}건 — 참조 종가로 기록: ${fallback.join(', ')}`)
  for (const w of warnings) log(`⚠️ ${w}`)

  const cost = { feePct: ctx.paper.cost.feePct, taxPct: ctx.paper.cost.taxPct }
  const phaseFills: PhaseFill[] = orders.map((p) => ({
    strategyId: p.strategyId,
    date: ctx.today,
    symbol: p.symbol,
    side: p.side,
    qty: p.qty,
    price: p.price,
    reason: p.reason,
  }))
  const phase = runLedgerPhase(ctx.ledger, ctx.today, 'confirm', phaseFills, cost)
  for (const r of phase.rejected) log(`  ⚠️ 장부 거부 [${r.fill.strategyId}] ${r.fill.symbol} — ${r.reason}`)
  writeJson(ledgerPath, { ...phase.ledger, updatedAt: new Date().toISOString(), lastRunDate: ctx.today })

  // 슬리피지 실측(2단계 게이트의 목적) — 참조 종가 대비 체결가 차이를 남긴다.
  const slippage = orders.map((p) => {
    const ref = state.preload?.refClose?.[p.symbol] ?? null
    return {
      symbol: p.symbol,
      refClose: ref,
      filled: p.price,
      diffPct: ref && ref > 0 ? +(((p.price - ref) / ref) * 100).toFixed(3) : null,
      source: fills.price[p.code] > 0 ? 'broker' : fallback.includes(p.symbol) ? '[추정] refClose' : 'yahooOpen',
    }
  })

  appendJournal(journalPath, {
    at: new Date().toISOString(),
    date: ctx.today,
    runner: 'investing-daemon',
    phase: 'confirm',
    mode: live ? 'live-mock' : 'dryRun',
    executionsReadable: fills.readable,
    executionsNote: fills.note,
    reorder: state.reorder,
    reordered,
    priceBasis: `실체결·시가 ${priced}건 · 참조 종가 대체 ${fallback.length}건`,
    slippage,
    ledgerApplied: phase.applied.length,
    ledgerRejected: phase.rejected.map((r) => ({ strategyId: r.fill.strategyId, symbol: r.fill.symbol, reason: r.reason })),
    warnings,
  })
  return done(`체결확인 — 장부 반영 ${phase.applied.length}건 (실체결·시가 ${priced} / 추정 ${fallback.length})`)
}

// ---- 단계 ④ 매수 (15:20) ------------------------------------------------------

async function runBuys(state: DaemonState): Promise<PhaseOutcome> {
  const ctx = loadCtx()
  if (phaseDone(ctx.ledger, ctx.today, 'buys')) return done('장부에 이미 반영됨(멱등)')
  if (state.tradingDay === false) return done('휴장으로 판정된 날 — 주문 없음')
  if (isHalted()) return retry('🛑 HALT 파일 존재 — 매수 단계 보류')
  if (state.submitted?.length && !phaseDone(ctx.ledger, ctx.today, 'confirm'))
    log('⚠️ 아침 매도의 체결확인이 아직 장부에 반영되지 않았다 — 매수는 장부 현금 한도 안에서만 나간다(보수적)')

  const { needed } = neededSymbols(ctx.paper, ctx.config)
  const since = warmupStart(ctx.ledger, ctx.config)
  log(`매수 단계 — 시세 ${needed.length}종목 재로딩(근실시간)`)
  const { histories, failed } = await loadHistories({ symbols: needed, since })
  if (Object.keys(histories).length < 20) return retry(`시세 ${Object.keys(histories).length}종목뿐 — 재시도`)

  const withToday = countWithBar(histories, ctx.today)
  if (withToday < Object.keys(histories).length * 0.5) {
    state.tradingDay = false
    log(`오늘(${ctx.today}) 봉이 있는 종목 ${withToday}개뿐 — 휴장/데이터 미갱신으로 보고 주문 없이 종료`)
    appendJournal(journalPath, {
      at: new Date().toISOString(),
      date: ctx.today,
      runner: 'investing-daemon',
      phase: 'buys',
      skipped: '오늘 봉 부족(휴장/지연)',
      withToday,
    })
    closePhaseOnly(ctx, 'buys')
    return done('휴장/데이터 미갱신 — 주문 없음')
  }
  state.tradingDay = true

  const prices = pricesOn(histories, ctx.today)
  state.prices = prices
  const planned: PlannedOrder[] = []
  const skipped: string[] = []
  const signalLog: Record<string, SignalLog> = {}

  for (const cfg of ctx.config.strategies) {
    const s = ctx.ledger.strategies[cfg.id]
    if (!s) continue
    if (cfg.type === 'benchHold') {
      const orders = planBenchHold({ cfg, ledger: s, prices, cost: ctx.paper.cost, skipped })
      signalLog[cfg.id] = {
        entries: orders.map((o) => o.symbol),
        exits: [],
        engineOpen: s.positions.length,
        ledgerOpen: s.positions.length,
      }
      planned.push(...orders)
      continue
    }
    const scope = scopeFor(cfg, ctx.paper, histories, ctx.slots)
    if (!scope) {
      skipped.push(`[${cfg.id}] universe 미지정`)
      continue
    }
    // 진입만 본다 — 청산은 아침에 끝났다. 엔진은 마지막 봉에 진입을 만들지 않으므로(규칙 1-6)
    // 후보는 screenOnDate 로 뽑는다.
    const { candidates, regimeOff } = entryCandidates({ ledger: s, scoped: scope.scoped, spec: scope.spec, date: ctx.today })
    signalLog[cfg.id] = { entries: candidates, exits: [], engineOpen: 0, ledgerOpen: s.positions.length }
    log(`[${cfg.id}] ${cfg.label} — 후보 ${candidates.length}${regimeOff ? '(레짐 OFF)' : ''} · 장부 보유 ${s.positions.length}`)
    // 아침 매도가 이미 장부에 반영돼 있으므로 appliedSells 는 비운다(현금·슬롯이 이미 풀린 상태).
    planned.push(
      ...planBuys({
        cfg,
        ledger: s,
        candidates,
        prices,
        slots: ctx.slots,
        cost: ctx.paper.cost,
        date: ctx.today,
        skipped,
      }),
    )
  }

  const warnings: string[] = []
  const client = makeClient()
  if (!client) log('ℹ️ 모의투자 앱키 없음 — 전송 없이 장부만 굴린다(가정 체결).')
  if (client?.isHalted()) log('🛑 HALT 파일 존재 — 게이트가 모든 주문을 차단한다')
  const balance = await fetchBalance(client)

  // 계좌 현금 상한 — 잔고를 못 읽었으면 장부 현금 합을 [추정] 한도로 쓴다(보수적).
  const ledgerCashSum = Object.values(ctx.ledger.strategies).reduce((sum, x) => sum + x.cash, 0)
  const cashCap = balance?.cashKrw ?? (client ? ledgerCashSum : null)
  const cashCapEstimated = balance?.cashKrw == null
  const capped = capBuysToCash(
    planned.map<BuyRequest>((b) => ({ strategyId: b.strategyId, symbol: b.symbol, qty: b.qty, price: b.price })),
    cashCap,
  )
  for (let i = 0; i < planned.length; i++) {
    if (!capped[i].note) continue
    warnings.push(`[${planned[i].strategyId}] 매수 ${planned[i].symbol} — ${capped[i].note}${cashCapEstimated ? ' [추정 한도]' : ''}`)
    planned[i].note = capped[i].note
    planned[i].qty = capped[i].qty
  }
  const toSend = planned.filter((p) => p.qty > 0)
  if (skipped.length) log(`건너뜀 ${skipped.length}: ${skipped.slice(0, 20).join(', ')}${skipped.length > 20 ? ' …' : ''}`)
  warnDailyLimit(client, toSend.length, ctx.today, warnings)
  for (const w of warnings) log(`⚠️ ${w}`)

  const { results, accepted } = await sendOrders(client, toSend)
  const cost = { feePct: ctx.paper.cost.feePct, taxPct: ctx.paper.cost.taxPct }
  const phaseFills: PhaseFill[] = accepted.map((p) => ({
    strategyId: p.strategyId,
    date: ctx.today,
    symbol: p.symbol,
    side: p.side,
    qty: p.qty,
    price: p.price,
    reason: p.reason,
  }))
  const phase = runLedgerPhase(ctx.ledger, ctx.today, 'buys', phaseFills, cost)
  for (const r of phase.rejected) log(`  ⚠️ 장부 거부 [${r.fill.strategyId}] ${r.fill.symbol} — ${r.reason}`)
  writeJson(ledgerPath, { ...phase.ledger, updatedAt: new Date().toISOString(), lastRunDate: ctx.today })

  appendJournal(journalPath, {
    at: new Date().toISOString(),
    date: ctx.today,
    runner: 'investing-daemon',
    phase: 'buys',
    mode: live ? 'live-mock' : 'dryRun',
    server: client?.base ?? null,
    halted: client?.isHalted() ?? null,
    capital: {
      perStrategyKrw: ctx.config.perStrategyCapitalKrw,
      slots: ctx.slots,
      accountCashCapKrw: cashCap == null ? null : Math.round(cashCap),
      accountCashEstimated: cashCapEstimated,
      accountTotalAssetKrw: balance?.totalAssetKrw ?? null,
    },
    signals: signalLog,
    orders: results,
    ledgerApplied: phase.applied.length,
    ledgerRejected: phase.rejected.map((r) => ({ strategyId: r.fill.strategyId, symbol: r.fill.symbol, reason: r.reason })),
    skipped,
    warnings,
    excluded: failed,
  })
  return done(`매수 ${toSend.length}건 전송 · 장부 반영 ${phase.applied.length}건`)
}

// ---- 단계 ⑤ 마감 (16:10) ------------------------------------------------------

async function runClose(state: DaemonState): Promise<PhaseOutcome> {
  const ctx = loadCtx()
  let prices = state.prices ?? {}
  // 매수 단계를 못 돌았으면(재시작 등) 보유 종목만 다시 받아 평가한다.
  const held = [...new Set(Object.values(ctx.ledger.strategies).flatMap((s) => s.positions.map((p) => p.symbol)))]
  const missing = held.filter((sym) => !(prices[sym] > 0))
  if (missing.length) {
    const since = new Date(Date.parse(ctx.today) - 20 * 86400e3).toISOString().slice(0, 10)
    const { histories } = await loadHistories({ symbols: missing, since, minBars: 1, delayMs: 200 })
    prices = { ...prices, ...pricesOn(histories, ctx.today) }
  }

  const marked: Record<string, StrategyLedger> = {}
  for (const [id, s] of Object.entries(ctx.ledger.strategies)) marked[id] = markEquity(s, ctx.today, prices)
  const ledger: MockLedger = markPhase(
    { ...ctx.ledger, strategies: marked, updatedAt: new Date().toISOString(), lastRunDate: ctx.today },
    ctx.today,
    'close',
  )
  writeJson(ledgerPath, ledger)

  const summary = summarize(ledger, ctx.config, prices, ctx.today, { dryRun: !live })
  writeJson(summaryPath, summary)

  console.log('\n── 전략별 성과 (가정 체결 기준) ──')
  for (const r of summary.strategies) {
    const alpha = r.alphaPct == null ? '(벤치)' : `${r.alphaPct >= 0 ? '+' : ''}${r.alphaPct}%p`
    console.log(
      `  ${r.id.padEnd(12)} 평가 ${r.equity.toLocaleString().padStart(12)}원 (${r.totalPct >= 0 ? '+' : ''}${r.totalPct}%) · 알파 ${alpha} · 보유 ${
        r.positions
      } · 청산 ${r.closedTrades} · 승률 ${r.winRatePct ?? '—'}%${r.retired ? ' [retired]' : ''}`,
    )
  }

  const n = appendJournal(journalPath, {
    at: new Date().toISOString(),
    date: ctx.today,
    runner: 'investing-daemon',
    phase: 'close',
    mode: live ? 'live-mock' : 'dryRun',
    tradingDay: state.tradingDay,
    notes: state.notes,
    summary: summary.strategies.map((r) => ({
      id: r.id,
      equity: r.equity,
      totalPct: r.totalPct,
      alphaPct: r.alphaPct,
      positions: r.positions,
      closedTrades: r.closedTrades,
      winRatePct: r.winRatePct,
    })),
    totals: summary.totals,
    dataNote: summary.dataNote,
  })
  saveState(state)
  const git = noGit ? 'git 생략(--no-git)' : commitData(`data: 모의운용 일일 갱신 ${ctx.today} (investing-daemon)`)
  log(`마감 — 저널 ${n}건 · ${git}`)
  return done(`평가·요약 갱신 · ${git}`)
}

/**
 * 데이터 커밋·푸시 — 크론 러너(scripts/server/investing-cron.sh)와 같은 관례.
 * **main 브랜치에서만** 한다(다른 브랜치에 데이터가 얹히는 사고 방지).
 * 실패해도 데몬을 죽이지 않는다 — 다음 날 함께 커밋된다.
 */
function commitData(message: string): string {
  const git = (a: string[]) => execFileSync('git', a, { cwd: root, encoding: 'utf8' }).trim()
  try {
    const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'])
    if (branch !== 'main') return `커밋 생략 — 브랜치가 main 이 아님(${branch})`
    git(['add', 'public/data/mock-live'])
    const clean = spawnSync('git', ['diff', '--cached', '--quiet'], { cwd: root }).status === 0
    if (clean) return '변경분 없음'
    const ident = ['-c', 'user.name=investing-daemon', '-c', 'user.email=investing-daemon@ec2.local']
    git([...ident, 'commit', '-m', message])
    // 상주 프로세스라 로컬이 remote보다 뒤처진다(페이퍼 트래킹 GHA가 매일 main에 커밋).
    // rebase 없이 push하면 둘째 날부터 항상 거부되므로 push 직전에 당겨 얹는다.
    git([...ident, 'pull', '--rebase', 'origin', 'main'])
    git(['push', 'origin', 'main'])
    return '커밋·푸시 완료'
  } catch (e) {
    return `⚠️ git 실패(무시하고 계속): ${(e as Error).message.split('\n')[0]}`
  }
}

// ---- 스케줄 루프 -------------------------------------------------------------

async function runPhase(phase: PhaseName, state: DaemonState, now: Date): Promise<PhaseOutcome> {
  switch (phase) {
    case 'preload':
      return runPreload(state)
    case 'sells':
      return runSells(state, now)
    case 'confirm':
      return runConfirm(state, now)
    case 'buys':
      return runBuys(state)
    case 'close':
      return runClose(state)
  }
}

let ticking = false

async function tick(): Promise<void> {
  if (ticking) return // 앞선 tick 이 아직 돌고 있다 — 겹쳐 실행하지 않는다
  ticking = true
  try {
    const now = new Date()
    const state = loadState(kstToday(now))
    const due = dueSlots(now, state)
    if (!due.length) return
    if (isHalted()) log('🛑 HALT 파일 존재 — 주문 단계는 게이트에서도 차단된다(파일을 지우면 재개)')
    for (const phase of due) {
      const label = SLOTS.find((s) => s.name === phase)?.label ?? phase
      log(`▶ ${label}(${phase}) 시작`)
      state.lastAttemptAt = { ...state.lastAttemptAt, [phase]: new Date().toISOString() }
      saveState(state)
      try {
        const out = await runPhase(phase, state, now)
        if (out.ok) {
          state.done = [...new Set([...state.done, phase])]
          log(`✔ ${label} 완료 — ${out.note}`)
        } else {
          log(`… ${label} 보류 — ${out.note} (${DEFAULT_RETRY_GAP_SEC}초 뒤 재시도)`)
        }
      } catch (e) {
        // 한 단계가 터져도 데몬은 살아 있어야 한다 — 다음 재시도 창에서 다시 시도한다.
        log(`❌ ${label} 실패 — ${(e as Error).message}`)
        console.error(e)
      }
      saveState(state)
    }
  } finally {
    ticking = false
  }
}

let alarmTimer: ReturnType<typeof setTimeout> | null = null

/** 다음 슬롯까지 자는 **정밀 알람**. 깨어나면 tick 하고 다시 잡는다(초 단위 폴링 금지). */
function scheduleAlarm(): void {
  const state = loadState(kstToday())
  const ms = msUntilNextSlot(new Date(), state)
  const next = nextSlot(new Date(), state)
  log(`⏰ 다음 알람 ${Math.round(ms / 1000)}초 후${next ? ` — ${next.label} ${next.at} KST` : ' (다음 영업일)'}`)
  alarmTimer = setTimeout(() => {
    void tick().finally(scheduleAlarm)
  }, ms)
}

async function main(): Promise<void> {
  const { date, weekday } = kstParts(new Date())
  log(
    `investing-daemon 기동 — KST ${date}(요일 ${weekday}) · 모드 ${live ? '⚠️ LIVE(모의서버 전송)' : 'dryRun(전송 없음)'} · 보조 tick ${tickSec}초` +
      `${noGit ? ' · git 생략' : ''}`,
  )
  log(`스케줄(KST): ${SLOTS.map((s) => `${s.label} ${s.at}`).join(' · ')}`)

  if (onceArg) {
    const state = loadState(kstToday())
    const now = new Date()
    log(`▶ 1회 실행 모드 — ${onceArg}`)
    const out = await runPhase(onceArg as PhaseName, state, now)
    if (out.ok) state.done = [...new Set([...state.done, onceArg as PhaseName])]
    state.lastAttemptAt = { ...state.lastAttemptAt, [onceArg as PhaseName]: now.toISOString() }
    saveState(state)
    log(`${out.ok ? '✔' : '…'} ${onceArg} — ${out.note}`)
    process.exit(out.ok ? 0 : 1)
  }

  // 보조 tick — 알람이 밀렸거나 재시도가 걸린 슬롯을 만회하는 용도(판정은 dueSlots 가 한다).
  const backup = setInterval(() => {
    void tick()
  }, tickSec * 1000)
  const stop = (sig: string) => {
    log(`${sig} 수신 — 데몬 종료`)
    clearInterval(backup)
    if (alarmTimer) clearTimeout(alarmTimer)
    process.exit(0)
  }
  process.on('SIGINT', () => stop('SIGINT'))
  process.on('SIGTERM', () => stop('SIGTERM'))

  await tick() // 기동 직후 한 번 — 놓친 슬롯을 곧바로 만회한다
  scheduleAlarm()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
