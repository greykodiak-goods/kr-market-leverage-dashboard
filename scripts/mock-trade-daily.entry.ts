// 모의투자 일일 운용 러너 — 규칙 2 「2단계」. 대상 서버는 키움 모의서버(mockapi)뿐이다.
//
// 실행 가정: **평일 15:20 (KST)** — 장 마감(15:30) 직전. 종가 근사로 판단해 그 자리에서
// 지정가 주문을 낸다(승자 전략의 체결 타이밍이 sameClose/LOC 이므로).
//
// 흐름
//   1) Yahoo 일봉(오늘 포함)으로 승자 전략을 개시일부터 오늘까지 **전부 재계산**한다
//      (paper-trade.entry.ts 와 같은 재실행형 — 상태 전이 버그 원천 차단).
//   2) **오늘 날짜에 새로 잡힌 진입/청산만** 뽑는다. 어제까지의 매매는 이미 처리된 것으로 본다.
//   3) scripts/lib/kiwoomOrder.mjs 로 모의 주문을 낸다(**기본 dryRun** — `--live` 필요).
//   4) 주문·응답·시각을 public/data/mock-live/journal.json 에 append 한다.
//
// 경계·한계
//   - 15:20 시점의 "오늘 봉"은 **미확정**이다. 종가 확정 전 값으로 판단하므로 시뮬레이션과
//     체결이 갈릴 수 있다 — 이 괴리(슬리피지·판정차)를 실측하는 것이 2단계 게이트의 목적이다.
//     과거를 앞당겨 보는 것이 아니므로 규칙 1(미래참조) 위반은 아니다.
//   - LOC(장마감 종가) 주문은 키움 REST 지원 여부 [미검증] — 지금은 **현재가 근사 지정가**로 낸다.
//     지정가라 미체결이 날 수 있고, 그 미체결률 자체가 2단계에서 측정할 값이다.
//   - 자금 배분: (모의계좌 총평가 ÷ 슬롯 10). 잔고 조회가 실패하면 config 초기자본으로 [추정] 대체하고
//     저널에 그 사실을 남긴다.
//   - 실계좌는 3단계 승인 전까지 열리지 않는다. 이 러너로는 실계좌에 주문할 수 없다.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { runStrategySpec, type CostSettings } from '../src/features/backtest/conditionScreen'
import { SPEC_VERSION, type ConditionNode, type StrategySpec } from '../src/features/backtest/strategySpec'
import type { DailyBar, Trade } from '../src/features/backtest/types'
// JS 라이브러리(타입 선언 없음) — 게이트·시크릿 처리는 전부 이 모듈들이 강제한다.
import { createKiwoomOrderClient, toKiwoomCode, kstToday } from './lib/kiwoomOrder.mjs'
import { loadSecret } from './lib/loadSecret.mjs'

const root = process.env.REPO_ROOT ?? process.cwd()
const paperDir = join(root, 'public', 'data', 'paper')
const liveDir = join(root, 'public', 'data', 'mock-live')
const journalPath = join(liveDir, 'journal.json')

const SLOTS = 10
const TRACK = 'all80' // 승자 전략 트랙(유니버스 동결 목록) — config.json 이 단일 원본

const args = new Set(process.argv.slice(2))
const live = args.has('--live')

interface PaperConfig {
  inception: string
  cost: CostSettings
  tracks: Record<string, { label: string; symbols: string[]; entryMa?: number; inception?: string }>
  benchmark: string
}

// ---- Yahoo 일봉 (paper-trade.entry.ts 와 동일 로직 — 총수익 보정) ------------
async function fetchDaily(symbol: string, since: string): Promise<DailyBar[]> {
  const p1 = Math.floor(Date.parse(since) / 1000)
  const p2 = Math.floor(Date.now() / 1000)
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    symbol,
  )}?period1=${p1}&period2=${p2}&interval=1d&events=div%2Csplit`
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' } })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const json = (await res.json()) as any
  const r = json?.chart?.result?.[0]
  if (!r) throw new Error(json?.chart?.error?.description ?? 'chart.result 없음')
  const ts: number[] = r.timestamp ?? []
  const q = r.indicators?.quote?.[0] ?? {}
  const adj: (number | null)[] = r.indicators?.adjclose?.[0]?.adjclose ?? []
  const out: DailyBar[] = []
  for (let i = 0; i < ts.length; i++) {
    const o = q.open?.[i]
    const h = q.high?.[i]
    const l = q.low?.[i]
    const cl = q.close?.[i]
    const v = q.volume?.[i]
    if ([o, h, l, cl].some((x: unknown) => x == null || !Number.isFinite(x as number))) continue
    const f = adj[i] != null && Number.isFinite(adj[i]!) && cl > 0 ? adj[i]! / cl : 1
    const date = new Date(ts[i] * 1000 + 9 * 3600 * 1000).toISOString().slice(0, 10)
    out.push({ date, t: ts[i], o: o * f, h: h * f, l: l * f, c: cl * f, v: Number.isFinite(v) ? v : 0 })
  }
  return out
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const cond = (id: string, c: unknown): ConditionNode => ({ op: 'cond', id, cond: c as never })

/** 승자 전략: MA20 돌파 × 20일 신고가 진입 / 40일선 −2% 청산 / 슬롯 10 */
function winnerSpec(symbols: string[], entryMa = 20): StrategySpec {
  return {
    version: SPEC_VERSION,
    id: `mocklive-ma${entryMa}-high20-slow`,
    name: `MA${entryMa}돌파×20일신고가·느린청산 (모의 실전)`,
    source: '백테스트 5·6차 승자 — 2단계 모의투자 운용',
    universe: {
      markets: ['KOSPI', 'KOSDAQ'],
      excludeAdministrative: true,
      excludeSuspended: true,
      excludeLiquidation: true,
      excludePreferred: true,
      excludeEtf: true,
      symbols,
    },
    entry: {
      op: 'and',
      nodes: [
        cond(`${entryMa}일선돌파`, { kind: 'maCross', period: entryMa, dir: 'above' }),
        cond('20일신고가', { kind: 'highBreak', days: 20 }),
      ],
    },
    ranking: { by: 'tradingValue', dir: 'desc' },
    exits: [{ kind: 'maBreak', maPeriod: 40, pct: 2 }],
    sizing: { maxPositions: SLOTS, mode: 'equalSlot' },
    execution: { timing: 'sameClose', orderType: 'market' },
  }
}

interface PlannedOrder {
  side: 'buy' | 'sell'
  symbol: string
  code: string
  qty: number
  price: number
  reason: string
}

/** 오늘 새로 잡힌 신호만 추출한다. 어제까지의 매매는 이미 처리된 것으로 본다. */
export function todaySignals(trades: Trade[], today: string): { entries: Trade[]; exits: Trade[] } {
  return {
    entries: trades.filter((t) => t.entryDate === today),
    exits: trades.filter((t) => t.exitDate === today),
  }
}

/** 저널 append — 배열 파일이 없으면 만든다. */
function appendJournal(entry: unknown): number {
  mkdirSync(liveDir, { recursive: true })
  let list: unknown[] = []
  if (existsSync(journalPath)) {
    try {
      const parsed = JSON.parse(readFileSync(journalPath, 'utf8'))
      if (Array.isArray(parsed)) list = parsed
    } catch {
      /* 깨진 파일은 덮지 않고 새 배열로 시작 — 원본은 git 이력에 남는다 */
    }
  }
  list.push(entry)
  writeFileSync(journalPath, JSON.stringify(list, null, 1))
  return list.length
}

async function main() {
  const today = kstToday()
  const config = JSON.parse(readFileSync(join(paperDir, 'config.json'), 'utf8')) as PaperConfig
  const track = config.tracks[TRACK]
  if (!track) throw new Error(`config.json 에 트랙 ${TRACK} 없음`)
  const inception = track.inception ?? config.inception
  const warmupStart = new Date(Date.parse(inception) - 183 * 86400e3).toISOString().slice(0, 10)

  console.log(`모의투자 일일 운용 — ${today} · 트랙 ${TRACK}(${track.label}) · 종목 ${track.symbols.length} · 모드 ${live ? '⚠️ LIVE' : 'dryRun'}`)

  // ── 1) 시세 로드 & 전략 재계산 ─────────────────────────────────────────────
  const histories: Record<string, DailyBar[]> = {}
  const failed: string[] = []
  for (const sym of track.symbols) {
    try {
      const bars = await fetchDaily(sym, warmupStart)
      if (bars.length >= 60) histories[sym] = bars
      else failed.push(`${sym}(짧음 ${bars.length})`)
    } catch (e) {
      failed.push(`${sym}(${(e as Error).message})`)
    }
    await sleep(150)
  }
  if (failed.length) console.log(`⚠️ 로드 실패 ${failed.length}: ${failed.slice(0, 10).join(', ')}${failed.length > 10 ? ' …' : ''}`)
  if (Object.keys(histories).length < 20)
    throw new Error(`시세 로드가 ${Object.keys(histories).length}종목뿐이라 중단 — 주문을 내지 않는다`)

  // 오늘 봉이 실제로 들어왔는지 확인 — 휴장일·데이터 지연이면 아무것도 하지 않는다.
  const withToday = Object.values(histories).filter((bars) => bars[bars.length - 1]?.date === today).length
  if (withToday < Object.keys(histories).length * 0.5) {
    console.log(`오늘(${today}) 봉이 있는 종목 ${withToday}개뿐 — 휴장 또는 데이터 미갱신으로 보고 주문 없이 종료`)
    appendJournal({ at: new Date().toISOString(), date: today, skipped: '오늘 봉 부족(휴장/지연)', withToday })
    return
  }

  const spec = winnerSpec(
    track.symbols.filter((s) => histories[s]),
    track.entryMa ?? 20,
  )
  const result = runStrategySpec(histories, inception, spec, config.cost)
  const { entries, exits } = todaySignals(result.trades, today)
  console.log(`오늘 신호 — 신규 진입 ${entries.length} · 청산 ${exits.length} (보유 ${result.openAtEnd})`)

  // ── 2) 모의계좌 자격증명 · 잔고 ────────────────────────────────────────────
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
      console.log(`잔고 — 총평가 ${balance?.totalAssetKrw ?? '[파싱실패]'} · 보유 ${balance?.holdings.length ?? 0}종목`)
    } catch (e) {
      console.error(`⚠️ 잔고 조회 실패: ${(e as Error).message} — 초기자본으로 [추정] 대체`)
    }
  } else {
    console.log('ℹ️ 모의투자 앱키 없음 — 주문 계획만 계산한다(전송 없음)')
  }

  const capitalBasis = balance?.totalAssetKrw ?? config.cost.initialCapital
  const capitalEstimated = balance?.totalAssetKrw == null
  const slotCapital = capitalBasis / SLOTS
  console.log(`슬롯 자본 ${Math.round(slotCapital).toLocaleString()}원 (총 ${Math.round(capitalBasis).toLocaleString()}원 ÷ ${SLOTS})${capitalEstimated ? ' [추정]' : ''}`)

  // ── 3) 주문 계획 ───────────────────────────────────────────────────────────
  const priceOf = (sym: string): number | null => {
    const bars = histories[sym]
    const last = bars?.[bars.length - 1]
    return last && last.date === today ? last.c : null
  }
  const planned: PlannedOrder[] = []
  const skipped: string[] = []

  for (const t of exits) {
    const sym = t.symbol ?? ''
    const price = priceOf(sym)
    if (price == null || price <= 0) {
      skipped.push(`매도 ${sym}(오늘 시세 없음)`)
      continue
    }
    let code: string
    try {
      code = toKiwoomCode(sym)
    } catch {
      skipped.push(`매도 ${sym}(코드 변환 불가)`)
      continue
    }
    // 실제 보유 수량이 있으면 그것을 쓴다(시뮬 수량과 다를 수 있다 — 실계좌 상태가 우선).
    const held = balance?.holdings.find((h) => h.symbol === code)?.qty
    const qty = Math.floor(held ?? t.qty)
    if (!(qty > 0)) {
      skipped.push(`매도 ${sym}(보유 수량 0)`)
      continue
    }
    planned.push({ side: 'sell', symbol: sym, code, qty, price: Math.round(price), reason: `청산(${t.reason})` })
  }

  for (const t of entries) {
    const sym = t.symbol ?? ''
    const price = priceOf(sym)
    if (price == null || price <= 0) {
      skipped.push(`매수 ${sym}(오늘 시세 없음)`)
      continue
    }
    let code: string
    try {
      code = toKiwoomCode(sym)
    } catch {
      skipped.push(`매수 ${sym}(코드 변환 불가)`)
      continue
    }
    const qty = Math.floor(slotCapital / price)
    if (!(qty > 0)) {
      skipped.push(`매수 ${sym}(슬롯 자본으로 1주도 못 삼)`)
      continue
    }
    planned.push({ side: 'buy', symbol: sym, code, qty, price: Math.round(price), reason: 'MA20돌파×20일신고가' })
  }

  if (skipped.length) console.log(`건너뜀 ${skipped.length}: ${skipped.join(', ')}`)

  // ── 4) 전송 (매도 먼저 — 현금 확보 후 매수) ────────────────────────────────
  planned.sort((a, b) => (a.side === b.side ? 0 : a.side === 'sell' ? -1 : 1))
  const results: unknown[] = []
  for (const p of planned) {
    console.log(`${p.side === 'buy' ? '매수' : '매도'} ${p.code} ${p.qty}주 @ ${p.price.toLocaleString()} — ${p.reason}`)
    if (!client) {
      results.push({ ...p, sent: false, note: '자격증명 없음 — 계획만' })
      continue
    }
    const r = await client.placeOrder({ side: p.side, symbol: p.code, qty: p.qty, price: p.price, orderType: 'limit' })
    results.push({ ...p, ...r })
  }

  // ── 5) 저널 ────────────────────────────────────────────────────────────────
  const n = appendJournal({
    at: new Date().toISOString(),
    date: today,
    mode: live ? 'live-mock' : 'dryRun',
    server: client?.base ?? null,
    limits: client?.limits ?? null,
    halted: client?.isHalted() ?? null,
    capital: { basisKrw: Math.round(capitalBasis), slotKrw: Math.round(slotCapital), estimated: capitalEstimated },
    signals: {
      entries: entries.map((t) => ({ symbol: t.symbol, price: t.entryPrice })),
      exits: exits.map((t) => ({ symbol: t.symbol, price: t.exitPrice, reason: t.reason })),
      openAtEnd: result.openAtEnd,
    },
    orders: results,
    skipped,
    dataNote:
      'Yahoo 일봉(비공식·총수익 보정) 15:20 미확정 종가 근사. LOC 미지원 가정으로 지정가 주문 [미검증]. 시뮬레이션 검증용이며 투자자문 아님.',
    excluded: failed,
  })
  console.log(`저널 기록 완료 — public/data/mock-live/journal.json (총 ${n}건)`)
  console.log(live ? '⚠️ LIVE 모드로 실행됨 — 모의서버 주문 결과를 HTS(모의)에서 대조하세요.' : 'dryRun 완료 — 실제 주문은 --live 를 줘야 나갑니다.')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
