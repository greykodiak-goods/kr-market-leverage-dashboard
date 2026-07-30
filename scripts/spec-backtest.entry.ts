// 5일선 매매법 헤드리스 백테스트 — GitHub Actions에서 실데이터로 실행.
//
// 검증 대상 (유튜브 @도깨비60 댓글, 2026-07-30 대표 지시):
//   유니버스 = 시총 상위(코스피40+코스닥40, 오늘 크론이 실측으로 뽑은 목록)
//   매수 = 양봉이 5일선 상향 돌파 → 종가 매수(LOC)
//   매도 = 5일선 이탈 → 매도 (재돌파 시 재편입은 엔진이 자동)
//
// 시뮬레이터 화면과 **같은 엔진**(runStrategySpec)을 부른다 — 여기서 나온 수치와
// 화면에서 돌린 수치가 다를 수 없다.
//
// 정직성:
//   - "오늘의 시총 상위"로 과거를 돌리므로 선택편향이 있다 — 전 구간 수치는
//     부풀려질 수 있어 최근 1·3년을 같은 무게로 본다.
//   - 판정은 알파(KODEX 200 단순보유 대비) — 규칙 5.
//   - 일봉 총수익 보정: adjclose ÷ close 계수를 OHLC에 적용(규칙 3).

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runStrategySpec, type ConditionResult, type CostSettings } from '../src/features/backtest/conditionScreen'
import { SPEC_VERSION, avgVolume, priorHigh, rsi, sma, type Condition, type ConditionNode, type StrategySpec } from '../src/features/backtest/strategySpec'
import type { DailyBar } from '../src/features/backtest/types'

// CJS 번들에서 import.meta.url이 없으므로 런처가 REPO_ROOT를 넘긴다.
const root = process.env.REPO_ROOT ?? process.cwd()

const COST: CostSettings = { initialCapital: 10_000_000, feePct: 0.015, taxPct: 0.15, slippagePct: 0.1 }
const NOCOST: CostSettings = { ...COST, feePct: 0, taxPct: 0, slippagePct: 0 }
const BENCH = '069500.KS' // KODEX 200
const ETF_IN_STORE = new Set([BENCH, '360750.KS']) // 수집 저장소에 있는 ETF — 전략 유니버스에서 제외

function log(msg: string) {
  console.log(msg)
}

// ---- 데이터 -----------------------------------------------------------------

async function fetchDaily(symbol: string, range = '10y'): Promise<DailyBar[]> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    symbol,
  )}?range=${range}&interval=1d&events=div%2Csplit`
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
    const c = q.close?.[i]
    const v = q.volume?.[i]
    if ([o, h, l, c].some((x: unknown) => x == null || !Number.isFinite(x as number))) continue
    // 총수익 보정(규칙 3): adjclose ÷ close 계수를 OHLC에 적용 (배당 재투자 기준)
    const f = adj[i] != null && Number.isFinite(adj[i]!) && c > 0 ? adj[i]! / c : 1
    const date = new Date(ts[i] * 1000 + 9 * 3600 * 1000).toISOString().slice(0, 10) // KST
    out.push({ date, t: ts[i], o: o * f, h: h * f, l: l * f, c: c * f, v: Number.isFinite(v) ? v : 0 })
  }
  return out
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ---- 스펙 -------------------------------------------------------------------

function baseSpec(over: Partial<StrategySpec> & { entry?: ConditionNode }): StrategySpec {
  return {
    version: SPEC_VERSION,
    id: 'ma5-method',
    name: '시총 상위 5일선 추세 매매',
    source: '유튜브 @도깨비60 댓글 (리처드 데니스 영상)',
    universe: {
      markets: ['KOSPI', 'KOSDAQ'],
      excludeAdministrative: true,
      excludeSuspended: true,
      excludeLiquidation: true,
      excludePreferred: true,
      excludeEtf: true,
    },
    entry: {
      op: 'and',
      nodes: [
        { op: 'cond', id: '양봉', cond: { kind: 'candle', bull: true } },
        { op: 'cond', id: '5일선돌파', cond: { kind: 'maCross', period: 5, dir: 'above' } },
      ],
    },
    ranking: { by: 'tradingValue', dir: 'desc' }, // 슬롯 초과 시 거래대금 큰 순
    exits: [{ kind: 'maBreak', maPeriod: 5 }],
    sizing: { maxPositions: 10, mode: 'equalSlot' },
    execution: { timing: 'sameClose', orderType: 'market' }, // 원문: 돌파하면 "종가 매수"
    ...over,
  }
}

// 필터 조립 헬퍼 — 기본 진입(양봉+5일선 돌파)에 종목선정 필터를 얹는다
const c = (id: string, cond: Condition): ConditionNode => ({ op: 'cond', id, cond })
const BASE = [c('양봉', { kind: 'candle', bull: true }), c('5일선돌파', { kind: 'maCross', period: 5, dir: 'above' })]
const withFilters = (...extra: ConditionNode[]): ConditionNode => ({ op: 'and', nodes: [...BASE, ...extra] })

const F = {
  정배열: c('정배열', { kind: 'maAlign', fast: 5, slow: 10 }),
  거래대금: c('거래대금100억', { kind: 'tradingValue', min: 1e10 }),
  볼륨서지: c('거래량1.5배', { kind: 'volumeSurge', days: 20, ratio: 1.5 }),
  중기추세: c('20일선위', { kind: 'maPosition', period: 20, dir: 'above' }),
  강한돌파: c('등락률+2%', { kind: 'changePct', min: 2 }),
  신고가: c('20일신고가', { kind: 'highBreak', days: 20 }),
  과열회피: c('RSI≤70', { kind: 'rsi', period: 14, max: 70 }),
}
const BUFFER_EXIT = [{ kind: 'maBreak' as const, maPeriod: 5, pct: 2 }]

// 코스피 지수 레짐: 지수 5·10일선 정배열일 때만 신규 진입 (2026-07-30 대표 지정 기법)
const KOSPI_INDEX = '^KS11'
const KOSPI_REGIME = {
  symbol: KOSPI_INDEX,
  entry: { op: 'and', nodes: [c('지수정배열', { kind: 'maAlign', fast: 5, slow: 10 })] } as ConditionNode,
}
// 대표 지정 종목 조건: 종목 정배열(5>10) + 5일선 아래→위 돌파 (양봉 요구 없음)
const GOBLIN_NODES: ConditionNode[] = [
  c('정배열', { kind: 'maAlign', fast: 5, slow: 10 }),
  c('5일선돌파', { kind: 'maCross', period: 5, dir: 'above' }),
]
const GOBLIN_ENTRY: ConditionNode = { op: 'and', nodes: GOBLIN_NODES }

// ---- 지표 계산 --------------------------------------------------------------

interface RunStats {
  label: string
  window: string
  totalPct: number
  cagrPct: number
  benchPct: number
  benchCagrPct: number
  alphaPct: number // 연환산 CAGR 차이
  mddPct: number
  trades: number
  winRatePct: number | null
  avgPnlPct: number | null
  avgHoldDays: number | null
  maBreakCount: number
  maBreakAvgPnl: number | null
  openAtEnd: number
}

function yearsBetween(a: string, b: string): number {
  return Math.max(1 / 365, (Date.parse(b) - Date.parse(a)) / (365.25 * 86400e3))
}

function cagr(totalRatio: number, years: number): number {
  return (Math.pow(Math.max(totalRatio, 1e-9), 1 / years) - 1) * 100
}

function stats(
  label: string,
  windowLabel: string,
  r: ConditionResult,
  benchBars: DailyBar[],
  capital: number,
): RunStats {
  const finalEq = r.equity.length ? r.equity[r.equity.length - 1].equity : capital
  const totalPct = (finalEq / capital - 1) * 100
  const years = yearsBetween(r.startDate, r.endDate)
  const inWin = benchBars.filter((b) => b.date >= r.startDate && b.date <= r.endDate)
  const benchPct = inWin.length >= 2 ? (inWin[inWin.length - 1].c / inWin[0].c - 1) * 100 : 0
  const mdd = r.equity.reduce((m, e) => Math.min(m, e.drawdownPct), 0)
  const closed = r.trades.filter((t) => t.exitDate != null)
  const wins = closed.filter((t) => (t.pnlPct ?? 0) > 0).length
  const holdDays = closed.length
    ? closed.reduce((s, t) => s + Math.max(0, (Date.parse(t.exitDate!) - Date.parse(t.entryDate)) / 86400e3), 0) /
      closed.length
    : null
  const mb = r.exitBreakdown.find((b) => b.kind === 'maBreak')
  const c = cagr(finalEq / capital, years)
  const bc = cagr(1 + benchPct / 100, years)
  return {
    label,
    window: windowLabel,
    totalPct,
    cagrPct: c,
    benchPct,
    benchCagrPct: bc,
    alphaPct: c - bc,
    mddPct: mdd,
    trades: closed.length,
    winRatePct: closed.length ? (wins / closed.length) * 100 : null,
    avgPnlPct: closed.length ? closed.reduce((s, t) => s + (t.pnlPct ?? 0), 0) / closed.length : null,
    avgHoldDays: holdDays,
    maBreakCount: mb?.count ?? 0,
    maBreakAvgPnl: mb?.avgPnlPct ?? null,
    openAtEnd: r.openAtEnd,
  }
}

const f1 = (v: number | null) => (v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(1)}`)
const f2 = (v: number | null) => (v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}`)

function printRow(s: RunStats) {
  log(
    `| ${s.label} | ${s.window} | ${f1(s.totalPct)}% | ${f1(s.cagrPct)}% | ${f1(s.benchCagrPct)}% | ${f1(
      s.alphaPct,
    )}%p | ${f1(s.mddPct)}% | ${s.trades} | ${s.winRatePct?.toFixed(0) ?? '—'}% | ${f2(s.avgPnlPct)}% | ${
      s.avgHoldDays?.toFixed(1) ?? '—'
    } | ${s.maBreakCount}회/${f2(s.maBreakAvgPnl)}% |`,
  )
}

// ---- 실행 -------------------------------------------------------------------

/** 데이터 일괄 로드 — main()·sweep() 공용 */
async function loadAll() {
  // 유니버스 = 5분봉 크론이 오늘 실측으로 뽑은 시총 상위 목록 (ETF 제외)
  // 로컬에 없으면(작업 브랜치 체크아웃) main의 실측 목록을 가져온다.
  let index: { symbols?: Record<string, unknown> }
  try {
    index = JSON.parse(readFileSync(join(root, 'public', 'data', 'intraday', 'index.json'), 'utf8'))
  } catch {
    const res = await fetch(
      'https://raw.githubusercontent.com/greykodiak-goods/kr-market-leverage-dashboard/main/public/data/intraday/index.json',
    )
    if (!res.ok) throw new Error(`index.json 로드 실패 (HTTP ${res.status})`)
    index = (await res.json()) as { symbols?: Record<string, unknown> }
  }
  const allSyms: string[] = Object.keys(index.symbols ?? {})
  const universe = allSyms.filter((s) => !ETF_IN_STORE.has(s))
  log(`유니버스 ${universe.length}종목 (시총 상위 실측 목록, ETF 제외) · 벤치마크 ${BENCH}`)

  const histories: Record<string, DailyBar[]> = {}
  const failed: string[] = []
  for (const sym of universe) {
    try {
      const bars = await fetchDaily(sym)
      if (bars.length >= 300) histories[sym] = bars
      else failed.push(`${sym}(짧음 ${bars.length})`)
    } catch (e) {
      failed.push(`${sym}(${(e as Error).message})`)
    }
    await sleep(150)
  }
  if (Object.keys(histories).length < 10) {
    throw new Error(`일봉 로드 ${Object.keys(histories).length}종목뿐 — 표본이 너무 얇아 중단 (실패: ${failed.slice(0, 5).join(', ')} …)`)
  }
  const bench = await fetchDaily(BENCH)
  // 코스피 지수(레짐 판정용) — 매매 대상 아님
  try {
    histories[KOSPI_INDEX] = await fetchDaily(KOSPI_INDEX)
    log(`레짐 지수 ${KOSPI_INDEX}: ${histories[KOSPI_INDEX].length}봉`)
  } catch (e) {
    log(`⚠️ 지수 로드 실패 — 레짐 변형은 진입 0이 된다: ${(e as Error).message}`)
  }
  // 코스피 시총 상위 20 — index.json의 순서는 수집 당시 랭킹 순서다
  const kospi20 = allSyms.filter((s) => s.endsWith('.KS') && !ETF_IN_STORE.has(s)).slice(0, 20)
  log(`일봉 로드: ${Object.keys(histories).length}종목 성공, 실패/제외 ${failed.length}${failed.length ? ` — ${failed.join(', ')}` : ''}`)
  log(`벤치마크 ${BENCH}: ${bench.length}봉 (${bench[0]?.date} ~ ${bench[bench.length - 1]?.date})`)
  // 지수는 레짐 판정 전용 — 매매 유니버스에서 항상 제외한 목록을 함께 준다
  const tradable = Object.keys(histories).filter((s) => s !== KOSPI_INDEX)
  return { histories, bench, kospi20, tradable }
}

async function main() {
  const { histories, bench, kospi20, tradable } = await loadAll()
  // 유니버스 미지정 스펙에 지수(^KS11)가 섞이지 않도록 tradable을 채운다
  const withUni = (spec: StrategySpec): StrategySpec =>
    spec.universe.symbols?.length ? spec : { ...spec, universe: { ...spec.universe, symbols: tradable } }

  // 구간: 전체(10y) · 최근 3년 · 최근 1년
  const today = new Date()
  const iso = (d: Date) => d.toISOString().slice(0, 10)
  const y3 = iso(new Date(today.getTime() - 3 * 365.25 * 86400e3))
  const y1 = iso(new Date(today.getTime() - 1 * 365.25 * 86400e3))
  const windows: [string, string][] = [
    ['전체(~10y)', '0000-00-00'],
    ['최근 3년', y3],
    ['최근 1년', y1],
  ]

  const w2 = [windows[0], windows[1]] // 전체 + 최근 3년 — 두 구간 모두 개선돼야 '고원'
  const variants: { label: string; spec: StrategySpec; cost: CostSettings; windows: [string, string][] }[] = [
    { label: 'A 원문형(기준선)', spec: baseSpec({}), cost: COST, windows },
    { label: 'D 원문형·비용0(참고)', spec: baseSpec({}), cost: NOCOST, windows: [windows[0]] },
    // ---- 종목선정 필터 단독 (진입 조건 추가) --------------------------------
    { label: 'G 거래대금≥100억', spec: baseSpec({ entry: withFilters(F.거래대금) }), cost: COST, windows: w2 },
    { label: 'H 거래량 1.5배 급증', spec: baseSpec({ entry: withFilters(F.볼륨서지) }), cost: COST, windows: w2 },
    { label: 'I 20일선 위(중기추세)', spec: baseSpec({ entry: withFilters(F.중기추세) }), cost: COST, windows: w2 },
    { label: 'J 정배열+20일선 위', spec: baseSpec({ entry: withFilters(F.정배열, F.중기추세) }), cost: COST, windows: w2 },
    { label: 'K 돌파일 등락률≥+2%', spec: baseSpec({ entry: withFilters(F.강한돌파) }), cost: COST, windows: w2 },
    { label: 'L 20일 신고가 동반', spec: baseSpec({ entry: withFilters(F.신고가) }), cost: COST, windows: w2 },
    { label: 'M RSI(14)≤70 과열회피', spec: baseSpec({ entry: withFilters(F.과열회피) }), cost: COST, windows: w2 },
    // ---- 이탈 버퍼 (whipsaw 직접 공략) --------------------------------------
    { label: 'P 이탈버퍼 −2%', spec: baseSpec({ exits: BUFFER_EXIT }), cost: COST, windows: w2 },
    // ---- 콤보 ---------------------------------------------------------------
    {
      label: 'N 콤보(대금+20일선+돌파2%)',
      spec: baseSpec({ entry: withFilters(F.거래대금, F.중기추세, F.강한돌파) }),
      cost: COST,
      windows: w2,
    },
    {
      label: 'O 콤보N+정배열',
      spec: baseSpec({ entry: withFilters(F.거래대금, F.중기추세, F.강한돌파, F.정배열) }),
      cost: COST,
      windows: w2,
    },
    {
      label: 'Q 콤보O+이탈버퍼−2%',
      spec: baseSpec({ entry: withFilters(F.거래대금, F.중기추세, F.강한돌파, F.정배열), exits: BUFFER_EXIT }),
      cost: COST,
      windows: w2,
    },
    {
      label: 'R 버퍼+신고가+거래대금',
      spec: baseSpec({ entry: withFilters(F.거래대금, F.신고가), exits: BUFFER_EXIT }),
      cost: COST,
      windows: w2,
    },
    // ---- 1차 그리드의 두 승자(거래량 급증 H · 신고가 L) 결합 -----------------
    { label: 'S 급증+신고가', spec: baseSpec({ entry: withFilters(F.볼륨서지, F.신고가) }), cost: COST, windows: w2 },
    {
      label: 'T 급증+신고가+버퍼−2%',
      spec: baseSpec({ entry: withFilters(F.볼륨서지, F.신고가), exits: BUFFER_EXIT }),
      cost: COST,
      windows: w2,
    },
    {
      label: 'U 급증+신고가+대금+버퍼',
      spec: baseSpec({ entry: withFilters(F.볼륨서지, F.신고가, F.거래대금), exits: BUFFER_EXIT }),
      cost: COST,
      windows: w2,
    },
    // ---- 대표 지정 기법(2026-07-30): 코스피20 · 지수 레짐 · 종목 정배열+돌파 --
    {
      label: 'V0 코스피20 정배열돌파(레짐 없음)',
      spec: baseSpec({ entry: GOBLIN_ENTRY, universe: { ...baseSpec({}).universe, symbols: kospi20 } }),
      cost: COST,
      windows: w2,
    },
    {
      label: 'V1 V0+지수레짐(5>10)',
      spec: baseSpec({ entry: GOBLIN_ENTRY, universe: { ...baseSpec({}).universe, symbols: kospi20 }, regime: KOSPI_REGIME }),
      cost: COST,
      windows: w2,
    },
    {
      label: 'V2 V1+이탈버퍼−2%',
      spec: baseSpec({
        entry: GOBLIN_ENTRY,
        universe: { ...baseSpec({}).universe, symbols: kospi20 },
        regime: KOSPI_REGIME,
        exits: BUFFER_EXIT,
      }),
      cost: COST,
      windows: w2,
    },
    {
      label: 'V3 V1+거래량급증',
      spec: baseSpec({
        entry: { op: 'and', nodes: [...GOBLIN_NODES, F.볼륨서지] } as ConditionNode,
        universe: { ...baseSpec({}).universe, symbols: kospi20 },
        regime: KOSPI_REGIME,
      }),
      cost: COST,
      windows: w2,
    },
    {
      label: 'V4 V1+급증+버퍼',
      spec: baseSpec({
        entry: { op: 'and', nodes: [...GOBLIN_NODES, F.볼륨서지] } as ConditionNode,
        universe: { ...baseSpec({}).universe, symbols: kospi20 },
        regime: KOSPI_REGIME,
        exits: BUFFER_EXIT,
      }),
      cost: COST,
      windows: w2,
    },
    // ---- 조기 익절 변형: 승률 60%가 나오는가, 대가는 얼마인가 ---------------
    // 익절이 먼저 걸리고(배열 순서), 안 걸리면 기존 5일선 이탈로 청산.
    ...([2, 3, 5] as const).map((tp) => ({
      label: `W${tp} V1+익절+${tp}%`,
      spec: baseSpec({
        entry: GOBLIN_ENTRY,
        universe: { ...baseSpec({}).universe, symbols: kospi20 },
        regime: KOSPI_REGIME,
        exits: [{ kind: 'takeProfit' as const, pct: tp }, { kind: 'maBreak' as const, maPeriod: 5 }],
      }),
      cost: COST,
      windows: w2,
    })),
    ...([3, 5] as const).map((tp) => ({
      label: `X${tp} V4+익절+${tp}%`,
      spec: baseSpec({
        entry: { op: 'and', nodes: [...GOBLIN_NODES, F.볼륨서지] } as ConditionNode,
        universe: { ...baseSpec({}).universe, symbols: kospi20 },
        regime: KOSPI_REGIME,
        exits: [{ kind: 'takeProfit' as const, pct: tp }, { kind: 'maBreak' as const, maPeriod: 5, pct: 2 }],
      }),
      cost: COST,
      windows: w2,
    })),
  ]

  log('')
  log('| 변형 | 구간 | 총수익 | CAGR | 벤치CAGR | 알파(연) | MDD | 매매 | 승률 | 평균손익 | 평균보유일 | 5일선이탈 |')
  log('|---|---|---|---|---|---|---|---|---|---|---|---|')
  const all: RunStats[] = []
  for (const v of variants) {
    for (const [wLabel, start] of v.windows) {
      const r = runStrategySpec(histories, start, withUni(v.spec), v.cost)
      const s = stats(v.label, wLabel, r, bench, v.cost.initialCapital)
      all.push(s)
      printRow(s)
    }
  }

  // ---- 홀드아웃 (과최적화 방어) --------------------------------------------
  // 필터를 같은 데이터로 고르고 같은 데이터로 자랑하면 과최적화다.
  // 전반부(~2023-12-31)에서의 성적과, 그 뒤(2024~)에서의 성적을 분리해서 본다 —
  // 후반부에서도 개선이 유지돼야 '고원'이다.
  const CUT = '2023-12-31'
  const histFit: Record<string, DailyBar[]> = {}
  for (const [s, bars] of Object.entries(histories)) histFit[s] = bars.filter((b) => b.date <= CUT)
  const benchFit = bench.filter((b) => b.date <= CUT)
  const finalists = variants.filter((v) =>
    ['A', 'H', 'L', 'P', 'R', 'S', 'T', 'U', 'V0', 'V1', 'V2', 'V3', 'V4', 'W2', 'W3', 'W5', 'X3', 'X5'].includes(
      v.label.split(' ')[0],
    ),
  )
  log('')
  log(`홀드아웃 분리: 전반부(~${CUT}) vs 후반부(2024-01-01~)`)
  log('| 변형 | 전반 알파(연) | 전반 승률 | 후반 알파(연) | 후반 승률 | 후반 MDD |')
  log('|---|---|---|---|---|---|')
  for (const v of finalists) {
    const fit = stats(v.label, 'fit', runStrategySpec(histFit, '0000-00-00', withUni(v.spec), v.cost), benchFit, v.cost.initialCapital)
    const val = stats(v.label, 'val', runStrategySpec(histories, '2024-01-01', withUni(v.spec), v.cost), bench, v.cost.initialCapital)
    log(
      `| ${v.label} | ${f1(fit.alphaPct)}%p | ${fit.winRatePct?.toFixed(0) ?? '—'}% | ${f1(val.alphaPct)}%p | ${
        val.winRatePct?.toFixed(0) ?? '—'
      }% | ${f1(val.mddPct)}% |`,
    )
  }

  // whipsaw 진단 — A 원문형 전체 구간의 손실 매매 분포
  const rA = runStrategySpec(histories, '0000-00-00', withUni(variants[0].spec), COST)
  const closed = rA.trades.filter((t) => t.exitDate != null)
  const losers = closed.filter((t) => (t.pnlPct ?? 0) <= 0)
  const quickLosers = losers.filter(
    (t) => (Date.parse(t.exitDate!) - Date.parse(t.entryDate)) / 86400e3 <= 4,
  )
  log('')
  log(
    `whipsaw 진단(A·전체): 매매 ${closed.length}건 중 손실 ${losers.length}건(${(
      (losers.length / Math.max(1, closed.length)) * 100
    ).toFixed(0)}%), 그중 4일 내 잘림 ${quickLosers.length}건 — 손실의 ${(
      (quickLosers.length / Math.max(1, losers.length)) * 100
    ).toFixed(0)}%`,
  )
  log('')
  log('⚠️ 선택편향: 유니버스가 "오늘의 시총 상위"라 과거 구간 성적은 부풀려질 수 있다. 최근 1·3년을 같은 무게로 볼 것.')
  log('⚠️ 본 결과는 시뮬레이션이며 투자자문이 아니다. 판정 기준은 알파(연환산, KODEX 200 대비).')
}

/**
 * 수익 조건 탐색 스윕 (MODE=sweep) — "수익이 나는 조건을 찾아봐" (2026-07-30 대표).
 *
 * 이평 기간 × 필터 × 청산 방식 그리드를 전반부(~2023-12-31)에서 전수 실행해
 * 알파 순으로 줄 세우고, 상위 12개만 후반부(2024~)와 최근 3년으로 검증한다.
 * 선발과 검증을 같은 데이터로 하지 않는 것이 핵심 — 후반에서도 살아남아야 진짜다.
 */
async function sweep() {
  const { histories, bench, tradable } = await loadAll()
  const CUT = '2023-12-31'
  const histFit: Record<string, DailyBar[]> = {}
  for (const [s, bars] of Object.entries(histories)) histFit[s] = bars.filter((b) => b.date <= CUT)
  const benchFit = bench.filter((b) => b.date <= CUT)
  const today = new Date()
  const y3 = new Date(today.getTime() - 3 * 365.25 * 86400e3).toISOString().slice(0, 10)

  const filterSets: { name: string; nodes: ConditionNode[] }[] = [
    { name: '필터없음', nodes: [] },
    { name: '급증1.5', nodes: [F.볼륨서지] },
    { name: '신고20', nodes: [F.신고가] },
    { name: '급증+신고20', nodes: [F.볼륨서지, F.신고가] },
    { name: '급증+신고55', nodes: [F.볼륨서지, c('55일신고가', { kind: 'highBreak', days: 55 })] },
    { name: '급증+신고20+대금', nodes: [F.볼륨서지, F.신고가, F.거래대금] },
  ]
  const exitKinds = ['타이트', '버퍼2', '느린청산'] as const
  const exitsOf = (p: number, k: (typeof exitKinds)[number]) =>
    k === '타이트'
      ? [{ kind: 'maBreak' as const, maPeriod: p }]
      : k === '버퍼2'
        ? [{ kind: 'maBreak' as const, maPeriod: p, pct: 2 }]
        : [{ kind: 'maBreak' as const, maPeriod: p * 2, pct: 2 }]

  interface Row {
    label: string
    spec: StrategySpec
    fit: RunStats
  }
  const rows: Row[] = []
  for (const p of [5, 10, 20]) {
    for (const fs of filterSets) {
      for (const ek of exitKinds) {
        const spec = baseSpec({
          entry: { op: 'and', nodes: [c('돌파', { kind: 'maCross', period: p, dir: 'above' }), ...fs.nodes] },
          exits: exitsOf(p, ek),
          universe: { ...baseSpec({}).universe, symbols: tradable },
        })
        const label = `MA${p}·${fs.name}·${ek}`
        const fit = stats(label, 'fit', runStrategySpec(histFit, '0000-00-00', spec, COST), benchFit, COST.initialCapital)
        rows.push({ label, spec, fit })
      }
    }
  }
  rows.sort((a, b) => b.fit.alphaPct - a.fit.alphaPct)
  const fitPositive = rows.filter((r) => r.fit.alphaPct > 0).length
  log('')
  log(`스윕 ${rows.length}개 구성 — 전반부(2016~2023) 알파 양수: ${fitPositive}개`)
  log('')
  log('| 구성 (전반부 상위 12) | 전반 알파 | 전반 승률 | **후반(2024~) 알파** | 후반 승률 | 후반 MDD | 3y 알파 | 3y 총수익 | 매매(전반) |')
  log('|---|---|---|---|---|---|---|---|---|')
  for (const r of rows.slice(0, 12)) {
    const val = stats(r.label, 'val', runStrategySpec(histories, '2024-01-01', r.spec, COST), bench, COST.initialCapital)
    const w3 = stats(r.label, '3y', runStrategySpec(histories, y3, r.spec, COST), bench, COST.initialCapital)
    log(
      `| ${r.label} | ${f1(r.fit.alphaPct)}%p | ${r.fit.winRatePct?.toFixed(0)}% | **${f1(val.alphaPct)}%p** | ${
        val.winRatePct?.toFixed(0) ?? '—'
      }% | ${f1(val.mddPct)}% | ${f1(w3.alphaPct)}%p | ${f1(w3.totalPct)}% | ${r.fit.trades} |`,
    )
  }
  log('')
  log('| (참고) 전반부 하위 3 | 전반 알파 |')
  for (const r of rows.slice(-3)) log(`| ${r.label} | ${f1(r.fit.alphaPct)}%p |`)
  log('')
  log('⚠️ 상위 구성을 다시 고르는 행위 자체가 다중비교 편향을 만든다 — 후반·3y가 모두 양수인 구성만 후보로 삼고, 최종 판단은 페이퍼 트레이딩 실측으로.')
}

/**
 * 돌파 이벤트 채굴 (MODE=mine) — 대표 제안(2026-07-30):
 * "5일선 돌파 구간을 모두 기록한 다음, 수익 나는 시점의 주변 조건들을 추려서
 *  가장 많이 겹치는 조건을 찾는다."
 *
 * 방법: 유니버스 전 종목의 5일선 상향 돌파를 전수 기록하고, 각 이벤트를 원문
 * 규칙(종가 LOC 매수 → 5일선 이탈 익일 시가 매도, 비용 포함)으로 라벨링한 뒤
 * 이벤트 시점의 조건 13종을 기록 → 조건별·조건쌍별 승률/평균손익 리프트를 계산.
 * 전반부(~2023)에서 발견 → 후반부(2024~)에서 재현되는지 검증(과최적화 방어).
 * 모든 조건은 이벤트 당일까지의 데이터만 사용(미래참조 없음).
 */
async function mine() {
  const { histories, tradable } = await loadAll()
  const idx = histories[KOSPI_INDEX] ?? []
  const idxByDate = new Map<string, number>()
  idx.forEach((b, i) => idxByDate.set(b.date, i))
  const CUT = '2023-12-31'
  const slip = COST.slippagePct / 100
  const fee = COST.feePct / 100
  const tax = COST.taxPct / 100

  interface Ev {
    pnl: number
    win: boolean
    hold: number
    feats: Record<string, boolean>
    era: 'fit' | 'val'
  }
  const evs: Ev[] = []

  for (const sym of tradable) {
    const bars = histories[sym]
    for (let i = 60; i < bars.length - 1; i++) {
      const s5 = sma(bars, i, 5)
      const p5 = sma(bars, i - 1, 5)
      if (s5 == null || p5 == null) continue
      if (!(bars[i].c > s5 && bars[i - 1].c <= p5)) continue // 5일선 상향 돌파 이벤트

      // 라벨: 원문 규칙 그대로 — 종가 LOC 매수, 첫 5일선 이탈 종가 확인 후 익일 시가 매도
      let exitPx: number | null = null
      let hold = 0
      for (let j = i + 1; j < bars.length; j++) {
        const m = sma(bars, j, 5)
        if (m != null && bars[j].c < m) {
          if (j + 1 < bars.length) {
            exitPx = bars[j + 1].o
            hold = j + 1 - i
          }
          break
        }
      }
      if (exitPx == null) continue // 데이터 끝까지 미청산 — 라벨 불가라 제외
      const buy = bars[i].c * (1 + slip) * (1 + fee)
      const sell = exitPx * (1 - slip) * (1 - fee - tax)
      const pnl = (sell / buy - 1) * 100

      const ii = idxByDate.get(bars[i].date)
      const i5 = ii != null ? sma(idx, ii, 5) : null
      const i10 = ii != null ? sma(idx, ii, 10) : null
      const i20 = ii != null ? sma(idx, ii, 20) : null
      const s10 = sma(bars, i, 10)
      const s20 = sma(bars, i, 20)
      const av20 = avgVolume(bars, i, 20)
      const ph20 = priorHigh(bars, i, 20)
      const ph55 = priorHigh(bars, i, 55)
      const r14 = rsi(bars, i, 14)
      const chg = bars[i - 1].c > 0 ? (bars[i].c / bars[i - 1].c - 1) * 100 : 0

      evs.push({
        pnl,
        win: pnl > 0,
        hold,
        era: bars[i].date <= CUT ? 'fit' : 'val',
        feats: {
          '종목정배열(5>10)': s10 != null && s5 > s10,
          '20일선 위': s20 != null && bars[i].c > s20,
          '지수정배열(5>10)': i5 != null && i10 != null && i5 > i10,
          '지수 20일선 위': ii != null && i20 != null && idx[ii].c > i20,
          '거래량 1.5배 급증': av20 != null && av20 > 0 && bars[i].v >= av20 * 1.5,
          '20일 신고가': ph20 != null && bars[i].c > ph20,
          '55일 신고가': ph55 != null && bars[i].c > ph55,
          '양봉': bars[i].c > bars[i].o,
          '등락률 +2%↑': chg >= 2,
          '갭상승 시가': bars[i].o > bars[i - 1].c,
          'RSI50 이상': r14 != null && r14 >= 50,
          '돌파폭 +1%↑': bars[i].c / s5 >= 1.01,
          '거래대금 100억↑': bars[i].c * bars[i].v >= 1e10,
        },
      })
    }
  }

  const agg = (list: Ev[]) => ({
    n: list.length,
    win: list.length ? (list.filter((e) => e.win).length / list.length) * 100 : 0,
    pnl: list.length ? list.reduce((s, e) => s + e.pnl, 0) / list.length : 0,
  })
  const fitAll = evs.filter((e) => e.era === 'fit')
  const valAll = evs.filter((e) => e.era === 'val')
  const bf = agg(fitAll)
  const bv = agg(valAll)
  log('')
  log(`돌파 이벤트 전수: ${evs.length}건 (전반 ${bf.n} · 후반 ${bv.n})`)
  log(`베이스라인 — 전반: 승률 ${bf.win.toFixed(0)}% · 평균손익 ${f2(bf.pnl)}% / 후반: 승률 ${bv.win.toFixed(0)}% · ${f2(bv.pnl)}%`)
  log('')

  const featNames = Object.keys(evs[0]?.feats ?? {})
  log('| 조건 (단독) | 전반 승률(리프트) | 전반 평균손익 | 후반 승률(리프트) | 후반 평균손익 | n(전반/후반) |')
  log('|---|---|---|---|---|---|')
  const singles: { name: string; fit: ReturnType<typeof agg>; val: ReturnType<typeof agg> }[] = []
  for (const fn of featNames) {
    const f = agg(fitAll.filter((e) => e.feats[fn]))
    const v = agg(valAll.filter((e) => e.feats[fn]))
    singles.push({ name: fn, fit: f, val: v })
  }
  singles.sort((a, b) => b.fit.pnl - a.fit.pnl)
  for (const s of singles) {
    log(
      `| ${s.name} | ${s.fit.win.toFixed(0)}% (${f1(s.fit.win - bf.win)}) | ${f2(s.fit.pnl)}% | ${s.val.win.toFixed(0)}% (${f1(
        s.val.win - bv.win,
      )}) | ${f2(s.val.pnl)}% | ${s.fit.n}/${s.val.n} |`,
    )
  }

  // 조건쌍 — 전반 평균손익 기준 상위 (표본 200건 이상만), 후반 재현 병기
  interface Pair {
    name: string
    fit: ReturnType<typeof agg>
    val: ReturnType<typeof agg>
  }
  const pairs: Pair[] = []
  for (let a = 0; a < featNames.length; a++) {
    for (let b = a + 1; b < featNames.length; b++) {
      const fa = featNames[a]
      const fb = featNames[b]
      const f = agg(fitAll.filter((e) => e.feats[fa] && e.feats[fb]))
      if (f.n < 200) continue
      const v = agg(valAll.filter((e) => e.feats[fa] && e.feats[fb]))
      pairs.push({ name: `${fa} × ${fb}`, fit: f, val: v })
    }
  }
  pairs.sort((a, b) => b.fit.pnl - a.fit.pnl)
  log('')
  log('| 조건 조합 (전반 평균손익 상위 10 · n≥200) | 전반 승률 | 전반 평균손익 | **후반 승률** | **후반 평균손익** | n(전반/후반) |')
  log('|---|---|---|---|---|---|')
  for (const p of pairs.slice(0, 10)) {
    log(
      `| ${p.name} | ${p.fit.win.toFixed(0)}% | ${f2(p.fit.pnl)}% | **${p.val.win.toFixed(0)}%** | **${f2(p.val.pnl)}%** | ${
        p.fit.n
      }/${p.val.n} |`,
    )
  }
  log('')
  log('읽는 법: 리프트 = 그 조건이 있을 때 승률이 베이스라인보다 몇 %p 높은가. 평균손익이 양수여야 조건으로서 의미가 있고, 전반에서 찾은 조합이 후반에서도 유지돼야 진짜다.')
  log('⚠️ 유니버스가 "오늘의 시총 상위"라 수치는 부풀려질 수 있다(선택편향). 조건 간 상대 비교 중심으로 볼 것.')
}

const entry = process.env.MODE === 'sweep' ? sweep : process.env.MODE === 'mine' ? mine : main
entry().catch((e) => {
  console.error('실행 실패:', e)
  process.exit(1)
})
