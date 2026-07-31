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
  // 'since:YYYY-MM-DD' 형식이면 period1/period2로 요청한다 — range=max는 Yahoo가
  // interval=1d를 무시하고 월봉을 돌려주므로(2026-07-30 실측) 장기 구간엔 쓰지 않는다.
  const qs = range.startsWith('since:')
    ? `period1=${Math.floor(Date.parse(range.slice(6)) / 1000)}&period2=${Math.floor(Date.now() / 1000)}`
    : `range=${range}`
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    symbol,
  )}?${qs}&interval=1d&events=div%2Csplit`
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
async function loadAll(range = '10y') {
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
      const bars = await fetchDaily(sym, range)
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
  const bench = await fetchDaily(BENCH, range)
  // 코스피 지수(레짐 판정용) — 매매 대상 아님
  try {
    histories[KOSPI_INDEX] = await fetchDaily(KOSPI_INDEX, range)
    log(`레짐 지수 ${KOSPI_INDEX}: ${histories[KOSPI_INDEX].length}봉`)
  } catch (e) {
    log(`⚠️ 지수 로드 실패 — 레짐 변형은 진입 0이 된다: ${(e as Error).message}`)
  }
  // 코스피 시총 상위 20 — index.json의 순서는 수집 당시 랭킹 순서다
  const ksRanked = allSyms.filter((s) => s.endsWith('.KS') && !ETF_IN_STORE.has(s))
  const kqRanked = allSyms.filter((s) => s.endsWith('.KQ') && !ETF_IN_STORE.has(s))
  const kospi20 = ksRanked.slice(0, 20)
  log(`일봉 로드: ${Object.keys(histories).length}종목 성공, 실패/제외 ${failed.length}${failed.length ? ` — ${failed.join(', ')}` : ''}`)
  log(`벤치마크 ${BENCH}: ${bench.length}봉 (${bench[0]?.date} ~ ${bench[bench.length - 1]?.date})`)
  // 지수는 레짐 판정 전용 — 매매 유니버스에서 항상 제외한 목록을 함께 준다
  const tradable = Object.keys(histories).filter((s) => s !== KOSPI_INDEX)
  return { histories, bench, kospi20, tradable, ksRanked, kqRanked }
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
 * 손익비 분해 (MODE=payoff) — "종합적으로 손익비 판단해서 좋은 기법 정리" (2026-07-30 대표).
 *
 * 지금까지의 최종 후보들만 골라, 승률·평균이익·평균손실을 분리해
 * 손익비(평균이익 ÷ |평균손실|)와 프로핏 팩터(총이익 ÷ |총손실|)를 실측한다.
 * 기대값/회 = 승률×평균이익 − 패률×|평균손실| (= 평균손익)과 반드시 함께 본다 —
 * 손익비 하나만으로는 회전·비용이 빠져 판단이 뒤집힐 수 있다.
 */
async function payoff() {
  const { histories, bench, kospi20, tradable } = await loadAll()
  const today = new Date()
  const y3 = new Date(today.getTime() - 3 * 365.25 * 86400e3).toISOString().slice(0, 10)
  const uni = { ...baseSpec({}).universe, symbols: tradable }
  const k20 = { ...baseSpec({}).universe, symbols: kospi20 }
  const ma20Entry = (...extra: ConditionNode[]): ConditionNode => ({
    op: 'and',
    nodes: [c('20일선돌파', { kind: 'maCross', period: 20, dir: 'above' }), ...extra],
  })
  const SLOW_EXIT = [{ kind: 'maBreak' as const, maPeriod: 40, pct: 2 }]

  const candidates: { label: string; spec: StrategySpec }[] = [
    { label: 'A 원문 5일선(기준)', spec: baseSpec({ universe: uni }) },
    {
      label: 'U 5일선·급증+신고+대금+버퍼',
      spec: baseSpec({ entry: withFilters(F.볼륨서지, F.신고가, F.거래대금), exits: BUFFER_EXIT, universe: uni }),
    },
    {
      label: 'V4 코스피20·레짐·급증+버퍼',
      spec: baseSpec({
        entry: { op: 'and', nodes: [...GOBLIN_NODES, F.볼륨서지] } as ConditionNode,
        universe: k20,
        regime: KOSPI_REGIME,
        exits: BUFFER_EXIT,
      }),
    },
    {
      label: 'X3 V4+익절+3%(고승률형)',
      spec: baseSpec({
        entry: { op: 'and', nodes: [...GOBLIN_NODES, F.볼륨서지] } as ConditionNode,
        universe: k20,
        regime: KOSPI_REGIME,
        exits: [{ kind: 'takeProfit' as const, pct: 3 }, { kind: 'maBreak' as const, maPeriod: 5, pct: 2 }],
      }),
    },
    { label: 'MA20·신고20·느린청산', spec: baseSpec({ entry: ma20Entry(F.신고가), exits: SLOW_EXIT, universe: uni }) },
    {
      label: 'MA20·급증+신고20·느린청산',
      spec: baseSpec({ entry: ma20Entry(F.볼륨서지, F.신고가), exits: SLOW_EXIT, universe: uni }),
    },
    {
      label: 'MA20·급증+신고20+대금·느린청산',
      spec: baseSpec({ entry: ma20Entry(F.볼륨서지, F.신고가, F.거래대금), exits: SLOW_EXIT, universe: uni }),
    },
    {
      label: 'MA20·급증·타이트(고회전)',
      spec: baseSpec({ entry: ma20Entry(F.볼륨서지), exits: [{ kind: 'maBreak' as const, maPeriod: 20 }], universe: uni }),
    },
  ]

  const windows: [string, string][] = [
    ['전체', '0000-00-00'],
    ['후반 2024~', '2024-01-01'],
    ['최근 3년', y3],
  ]
  log('')
  log('손익비 = 평균이익 ÷ |평균손실| · PF = 총이익 ÷ |총손실| · 기대값/회 = 승률 반영 평균손익 (비용 포함)')
  log('')
  log('| 전략 | 구간 | 승률 | 평균이익 | 평균손실 | **손익비** | PF | 기대값/회 | 매매 | 평균보유일 | **CAGR** | 벤치CAGR | 총수익 | 알파(연) | MDD |')
  log('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|')
  for (const v of candidates) {
    for (const [wLabel, start] of windows) {
      const r = runStrategySpec(histories, start, v.spec, COST)
      const s = stats(v.label, wLabel, r, bench, COST.initialCapital)
      const closed = r.trades.filter((t) => t.exitDate != null)
      const wins = closed.filter((t) => (t.pnlPct ?? 0) > 0)
      const losses = closed.filter((t) => (t.pnlPct ?? 0) <= 0)
      const avgOf = (a: typeof closed) => (a.length ? a.reduce((sum, t) => sum + (t.pnlPct ?? 0), 0) / a.length : null)
      const avgWin = avgOf(wins)
      const avgLoss = avgOf(losses)
      const ratio = avgWin != null && avgLoss != null && avgLoss !== 0 ? avgWin / Math.abs(avgLoss) : null
      const sumWin = wins.reduce((sum, t) => sum + (t.pnlPct ?? 0), 0)
      const sumLoss = Math.abs(losses.reduce((sum, t) => sum + (t.pnlPct ?? 0), 0))
      const pf = sumLoss > 0 ? sumWin / sumLoss : null
      log(
        `| ${v.label} | ${wLabel} | ${s.winRatePct?.toFixed(0) ?? '—'}% | ${f2(avgWin)}% | ${f2(avgLoss)}% | **${
          ratio?.toFixed(2) ?? '—'
        }** | ${pf?.toFixed(2) ?? '—'} | ${f2(s.avgPnlPct)}% | ${s.trades} | ${s.avgHoldDays?.toFixed(1) ?? '—'} | **${f1(
          s.cagrPct,
        )}%** | ${f1(s.benchCagrPct)}% | ${f1(s.totalPct)}% | ${f1(s.alphaPct)}%p | ${f1(s.mddPct)}% |`,
      )
    }
  }
  log('')
  log('⚠️ 선택편향(오늘의 시총 상위) 존재 — 절대 수치는 상한선. 손익비·PF의 상대 비교 중심으로 볼 것.')
  log('⚠️ 시뮬레이션이며 투자자문이 아니다. 판정은 알파+MDD(규칙 5), 손익비·승률은 구조 이해용.')
}

/**
 * 과거 구간 검증 (MODE=era) — "승자 조합을 2010~2023으로 돌리면?" (2026-07-30 대표).
 *
 * MA20×20일신고가·느린청산(40일선 −2%)을 Yahoo 'max' 범위로 당겨와
 * 2023-12-31에서 절단하고 2010-01-01부터 실행한다. 하위 구간도 나눠 본다 —
 * 14년 단일 수치는 구간 편차를 숨기기 때문.
 *
 * ⚠️ 정직성: 유니버스가 "2026년 오늘의 시총 상위 80"이므로 2010년 시점엔 알 수
 * 없던 목록이다(사후 선택). 2010년 이후 상장 종목은 상장일부터 편입된다.
 * 이 구간 수치는 상한선 중의 상한선 — 커버리지(2010년 초 시세 존재 종목 수)를 함께 찍는다.
 */
async function era() {
  // 2009년부터 당겨 2010년 첫 진입 전 MA40·신고가 워밍업 확보
  const { histories, bench, tradable } = await loadAll('since:2009-01-01')
  const entry20 = {
    op: 'and',
    nodes: [c('20일선돌파', { kind: 'maCross', period: 20, dir: 'above' }), c('20일신고가', { kind: 'highBreak', days: 20 })],
  } as ConditionNode
  const uni = { ...baseSpec({}).universe, symbols: tradable }
  const SLOW = { kind: 'maBreak' as const, maPeriod: 40, pct: 2 }
  // 지수 레짐: 코스피 종가가 지수 20일선 위일 때만 신규 진입 (채굴 5차에서 검증된 조건)
  const REGIME20: StrategySpec['regime'] = {
    symbol: KOSPI_INDEX,
    entry: { op: 'and', nodes: [c('지수20일선위', { kind: 'maPosition', period: 20, dir: 'above' })] },
  }
  // 손실 누적 완화 변형: 레짐 게이트(약세장 진입 차단) vs 초기 손절(개별 손실 꼬리 컷)
  const variants: { label: string; spec: StrategySpec }[] = [
    { label: '원형', spec: baseSpec({ entry: entry20, exits: [SLOW], universe: uni }) },
    { label: '+지수레짐(20일선)', spec: baseSpec({ entry: entry20, exits: [SLOW], universe: uni, regime: REGIME20 }) },
    { label: '+손절−7%', spec: baseSpec({ entry: entry20, exits: [{ kind: 'stopLoss', pct: 7 }, SLOW], universe: uni }) },
    {
      label: '+레짐+손절−7%',
      spec: baseSpec({ entry: entry20, exits: [{ kind: 'stopLoss', pct: 7 }, SLOW], universe: uni, regime: REGIME20 }),
    },
  ]

  const at2010 = tradable.filter((s) => (histories[s]?.[0]?.date ?? '9999') <= '2010-01-15').length
  log('')
  log(`데이터 커버리지: ${tradable.length}종목 중 2010년 초 시세 존재 ${at2010}종목 — 나머지는 상장 이후 시점부터 편입`)
  log('⚠️ 유니버스는 2026년 오늘의 시총 상위(사후 선택) — 2010년에 이 목록을 알 수 없었다. 수치는 상한선.')
  log('')
  log('| 변형 | 구간 | 승률 | 손익비 | PF | **CAGR** | 벤치CAGR | 알파(연) | 총수익 | MDD | 매매 | 평균보유일 |')
  log('|---|---|---|---|---|---|---|---|---|---|---|---|')
  const spans: [string, string, string][] = [
    ['2010–2023 전체', '2010-01-01', '2023-12-31'],
    ['2010–2015', '2010-01-01', '2015-12-31'],
    ['2016–2019', '2016-01-01', '2019-12-31'],
    ['2020–2023', '2020-01-01', '2023-12-31'],
    ['2024~현재', '2024-01-01', '9999-12-31'],
  ]
  for (const v of variants)
  for (const [label, start, end] of spans) {
    const hist: Record<string, DailyBar[]> = {}
    for (const [s, bars] of Object.entries(histories)) hist[s] = bars.filter((b) => b.date <= end)
    const benchCut = bench.filter((b) => b.date <= end)
    const r = runStrategySpec(hist, start, v.spec, COST)
    const s = stats(label, label, r, benchCut, COST.initialCapital)
    const closed = r.trades.filter((t) => t.exitDate != null)
    const wins = closed.filter((t) => (t.pnlPct ?? 0) > 0)
    const losses = closed.filter((t) => (t.pnlPct ?? 0) <= 0)
    const avgOf = (a: typeof closed) => (a.length ? a.reduce((sum, t) => sum + (t.pnlPct ?? 0), 0) / a.length : null)
    const avgWin = avgOf(wins)
    const avgLoss = avgOf(losses)
    const ratio = avgWin != null && avgLoss != null && avgLoss !== 0 ? avgWin / Math.abs(avgLoss) : null
    const sumWin = wins.reduce((sum, t) => sum + (t.pnlPct ?? 0), 0)
    const sumLoss = Math.abs(losses.reduce((sum, t) => sum + (t.pnlPct ?? 0), 0))
    const pf = sumLoss > 0 ? sumWin / sumLoss : null
    log(
      `| ${v.label} | ${label} | ${s.winRatePct?.toFixed(0) ?? '—'}% | ${ratio?.toFixed(2) ?? '—'} | ${
        pf?.toFixed(2) ?? '—'
      } | **${f1(s.cagrPct)}%** | ${f1(s.benchCagrPct)}% | ${f1(s.alphaPct)}%p | ${f1(s.totalPct)}% | ${f1(
        s.mddPct,
      )}% | ${s.trades} | ${s.avgHoldDays?.toFixed(1) ?? '—'} |`,
    )
  }
  log('')
  log('⚠️ 시뮬레이션이며 투자자문이 아니다. 선택편향·생존편향 최대 구간 — 절대 수치가 아니라 구간 간 일관성을 볼 것.')
}

/**
 * 시점 고정(point-in-time) 코스피 상위 10 검증 (MODE=pit) — 2026-07-30 대표 지시.
 *
 * "그 시점의 코스피 상위 10종목만 한다면?" — 오늘의 목록으로 과거를 돌리는
 * 선택편향을 제거하기 위해, 각 연도 초 기준 코스피 시총 상위 10을 유니버스로
 * 쓰고 해마다 갈아끼운다.
 *
 * ⚠️ 정직성(규칙 3): 연도별 상위 10 목록은 **모델 지식 기반 [추정]**이다 —
 * 과거 시총 랭킹의 무료 데이터 소스가 없어 정확한 순위가 아니며 ±2순위 오차가
 * 있을 수 있다(우선주 제외, 연초 기준 근사). 연 단위 실행을 이어붙이므로
 * 연말에 보유 중이던 포지션은 연말 종가 평가로 마감되고 다음 해 빈손 시작
 * (연말 강제 청산 근사)이라는 한계도 있다.
 */
const PIT_KOSPI10: Record<number, string[]> = {
  2010: ['005930', '005490', '005380', '055550', '105560', '015760', '066570', '017670', '051910', '009540'],
  2011: ['005930', '005490', '005380', '051910', '012330', '009540', '055550', '105560', '000270', '066570'],
  2012: ['005930', '005380', '005490', '012330', '000270', '051910', '032830', '055550', '105560', '009540'],
  2013: ['005930', '005380', '005490', '012330', '000270', '032830', '051910', '055550', '000660', '105560'],
  2014: ['005930', '005380', '005490', '012330', '000660', '032830', '051910', '055550', '000270', '015760'],
  2015: ['005930', '005380', '000660', '005490', '012330', '032830', '015760', '051910', '055550', '000270'],
  2016: ['005930', '000660', '005380', '012330', '032830', '015760', '090430', '051910', '055550', '035420'],
  2017: ['005930', '000660', '005380', '015760', '012330', '035420', '032830', '051910', '055550', '005490'],
  2018: ['005930', '000660', '068270', '005380', '051910', '012330', '005490', '035420', '105560', '055550'],
  2019: ['005930', '000660', '068270', '005380', '051910', '012330', '035420', '005490', '105560', '051900'],
  2020: ['005930', '000660', '035420', '051910', '068270', '005380', '035720', '012330', '051900', '006400'],
  2021: ['005930', '000660', '051910', '035420', '005380', '006400', '035720', '068270', '000270', '051900'],
  2022: ['005930', '373220', '000660', '006400', '035420', '051910', '005380', '035720', '000270', '068270'],
  2023: ['005930', '373220', '000660', '006400', '051910', '005380', '000270', '035420', '005490', '035720'],
}

async function pit() {
  const years = Object.keys(PIT_KOSPI10)
    .map(Number)
    .sort((a, b) => a - b)
  const uniq = [...new Set(Object.values(PIT_KOSPI10).flat())].map((s) => `${s}.KS`)
  log(`시점 고정 유니버스: ${years[0]}~${years[years.length - 1]} 연도별 코스피 상위 10 [추정] — 고유 종목 ${uniq.length}개`)
  const histories: Record<string, DailyBar[]> = {}
  const failed: string[] = []
  for (const sym of uniq) {
    try {
      const bars = await fetchDaily(sym, 'since:2009-01-01')
      if (bars.length >= 200) histories[sym] = bars
      else failed.push(`${sym}(짧음 ${bars.length})`)
    } catch (e) {
      failed.push(`${sym}(${(e as Error).message})`)
    }
    await sleep(150)
  }
  const bench = await fetchDaily(BENCH, 'since:2009-01-01')
  log(`일봉 로드: ${Object.keys(histories).length}종목, 실패 ${failed.length}${failed.length ? ` — ${failed.join(', ')}` : ''}`)

  const entry20 = {
    op: 'and',
    nodes: [c('20일선돌파', { kind: 'maCross', period: 20, dir: 'above' }), c('20일신고가', { kind: 'highBreak', days: 20 })],
  } as ConditionNode

  // 슬롯 10 = 원형 그대로(종목 10개면 노출이 희석됨) / 슬롯 3 = 종목당 자본 1/3로 집중
  for (const slots of [10, 3]) {
    log('')
    log(`### 슬롯 ${slots} (한 종목당 자본 1/${slots})`)
    log('| 연도 | 전략 수익 | 벤치(KODEX200) | 초과 | 매매 | 승률 | 평균손익/회 |')
    log('|---|---|---|---|---|---|---|')
    let factor = 1
    const chained: { date: string; eq: number }[] = []
    let winsTotal = 0
    let closedTotal = 0
    let pnlSum = 0
    let benchFactor = 1
    for (const y of years) {
      const syms = PIT_KOSPI10[y].map((s) => `${s}.KS`).filter((s) => histories[s])
      const end = `${y}-12-31`
      const hist: Record<string, DailyBar[]> = {}
      for (const s of syms) hist[s] = histories[s].filter((b) => b.date <= end)
      const spec = baseSpec({
        entry: entry20,
        exits: [{ kind: 'maBreak', maPeriod: 40, pct: 2 }],
        universe: { ...baseSpec({}).universe, symbols: syms },
        sizing: { maxPositions: slots, mode: 'equalSlot' },
      })
      const r = runStrategySpec(hist, `${y}-01-01`, spec, COST)
      const finalEq = r.equity.length ? r.equity[r.equity.length - 1].equity : COST.initialCapital
      const ret = finalEq / COST.initialCapital
      const inYear = bench.filter((b) => b.date >= `${y}-01-01` && b.date <= end)
      const bret = inYear.length >= 2 ? inYear[inYear.length - 1].c / inYear[0].c : 1
      for (const e of r.equity) chained.push({ date: e.date, eq: (factor * e.equity) / COST.initialCapital })
      factor *= ret
      benchFactor *= bret
      const closed = r.trades.filter((t) => t.exitDate != null)
      const wins = closed.filter((t) => (t.pnlPct ?? 0) > 0).length
      const pnl = closed.reduce((s2, t) => s2 + (t.pnlPct ?? 0), 0)
      winsTotal += wins
      closedTotal += closed.length
      pnlSum += pnl
      log(
        `| ${y} | ${f1((ret - 1) * 100)}% | ${f1((bret - 1) * 100)}% | ${f1((ret - bret) * 100)}%p | ${closed.length} | ${
          closed.length ? ((wins / closed.length) * 100).toFixed(0) : '—'
        }% | ${closed.length ? f2(pnl / closed.length) : '—'}% |`,
      )
    }
    let peak = 0
    let mdd = 0
    for (const p of chained) {
      if (p.eq > peak) peak = p.eq
      mdd = Math.min(mdd, peak > 0 ? (p.eq / peak - 1) * 100 : 0)
    }
    const yearsSpan = years.length
    const cagrPct = (Math.pow(factor, 1 / yearsSpan) - 1) * 100
    const benchCagrPct = (Math.pow(benchFactor, 1 / yearsSpan) - 1) * 100
    log('')
    log(
      `종합(슬롯 ${slots}) ${years[0]}~${years[years.length - 1]}: 총수익 ${f1((factor - 1) * 100)}% · CAGR **${f1(
        cagrPct,
      )}%** · 벤치 CAGR ${f1(benchCagrPct)}% · 알파(연) **${f1(cagrPct - benchCagrPct)}%p** · MDD ${f1(mdd)}% · ` +
        `매매 ${closedTotal}회 · 승률 ${closedTotal ? ((winsTotal / closedTotal) * 100).toFixed(0) : '—'}% · ` +
        `평균손익/회 ${closedTotal ? f2(pnlSum / closedTotal) : '—'}%`,
    )
  }
  log('')
  log('⚠️ 연도별 상위 10 목록은 모델 지식 기반 [추정](±2순위 오차 가능·우선주 제외). 연말 강제 청산 근사.')
  log('⚠️ 시뮬레이션이며 투자자문이 아니다.')
}

/**
 * 유니버스 밴드 탐색 (MODE=band) — "수익 최대·MDD 최소 종목 범위를 역산" (2026-07-30 대표).
 *
 * 승자 조합(MA20×신고20·느린청산)을 시총 랭킹 밴드별로 전수 실행한다.
 * 과최적화 방어: 전반(~2023)에서 고르고 후반(2024~)·3y에서 재현 확인 — 세 구간
 * 부호가 일치하는 밴드만 후보로 삼는다. 랭킹은 오늘 목록(선택편향 상한선)이며,
 * 9·10차 시점 고정 결과(초대형주 엣지 없음·코스닥 꼬리 실존)와 교차 해석할 것.
 */
async function band() {
  const { histories, bench, ksRanked, kqRanked } = await loadAll()
  const has = (s: string) => !!histories[s]
  const ks = ksRanked.filter(has)
  const kq = kqRanked.filter(has)
  const bands: { name: string; syms: string[] }[] = [
    { name: '코스피 1-10', syms: ks.slice(0, 10) },
    { name: '코스피 11-20', syms: ks.slice(10, 20) },
    { name: '코스피 21-40', syms: ks.slice(20, 40) },
    { name: '코스피 전체', syms: ks },
    { name: '코스닥 1-10', syms: kq.slice(0, 10) },
    { name: '코스닥 11-20', syms: kq.slice(10, 20) },
    { name: '코스닥 21-40', syms: kq.slice(20, 40) },
    { name: '코스닥 전체', syms: kq },
    { name: '전체 80', syms: [...ks, ...kq] },
    { name: '초대형 제외(KS11-40+KQ)', syms: [...ks.slice(10, 40), ...kq] },
    { name: '중소형(KS21-40+KQ11-40)', syms: [...ks.slice(20, 40), ...kq.slice(10, 40)] },
  ]
  const entry20 = {
    op: 'and',
    nodes: [c('20일선돌파', { kind: 'maCross', period: 20, dir: 'above' }), c('20일신고가', { kind: 'highBreak', days: 20 })],
  } as ConditionNode
  const CUT = '2023-12-31'
  const histFit: Record<string, DailyBar[]> = {}
  for (const [s, bars] of Object.entries(histories)) histFit[s] = bars.filter((b) => b.date <= CUT)
  const benchFit = bench.filter((b) => b.date <= CUT)
  const y3 = new Date(Date.now() - 3 * 365.25 * 86400e3).toISOString().slice(0, 10)

  log('')
  log('밴드별 승자 조합(MA20×신고20·느린청산) — 슬롯 = min(10, max(5, 종목수/2)) · 랭킹은 오늘 목록(상한선)')
  log('')
  log('| 밴드(종목수·슬롯) | 전반(~23) 알파/MDD | **후반(24~) 알파/MDD** | 3y 알파/MDD | 3y CAGR | 3y 승률 | 매매(3y) |')
  log('|---|---|---|---|---|---|---|')
  for (const b of bands) {
    const n = b.syms.length
    if (n < 5) {
      log(`| ${b.name} | 종목 부족(${n}) | | | | | |`)
      continue
    }
    const slots = Math.min(10, Math.max(5, Math.floor(n / 2)))
    const spec = baseSpec({
      entry: entry20,
      exits: [{ kind: 'maBreak', maPeriod: 40, pct: 2 }],
      universe: { ...baseSpec({}).universe, symbols: b.syms },
      sizing: { maxPositions: slots, mode: 'equalSlot' },
    })
    const fit = stats(b.name, 'fit', runStrategySpec(histFit, '0000-00-00', spec, COST), benchFit, COST.initialCapital)
    const val = stats(b.name, 'val', runStrategySpec(histories, '2024-01-01', spec, COST), bench, COST.initialCapital)
    const w3 = stats(b.name, '3y', runStrategySpec(histories, y3, spec, COST), bench, COST.initialCapital)
    log(
      `| ${b.name} (${n}·${slots}) | ${f1(fit.alphaPct)}%p/${f1(fit.mddPct)}% | **${f1(val.alphaPct)}%p/${f1(
        val.mddPct,
      )}%** | ${f1(w3.alphaPct)}%p/${f1(w3.mddPct)}% | ${f1(w3.cagrPct)}% | ${w3.winRatePct?.toFixed(0) ?? '—'}% | ${
        w3.trades
      } |`,
    )
  }
  log('')
  log('⚠️ 전반·후반·3y 부호가 모두 양수인 밴드만 후보. 밴드 선택 자체가 다중비교라 최종 판단은 페이퍼 트레이딩.')
  log('⚠️ 시점 고정이 아닌 오늘 목록 기준 — 절대 수치는 상한선(9·10차 참조). 시뮬레이션이며 투자자문이 아니다.')
}

/**
 * 강건성 검증 배터리 (MODE=robust) — "모델 검증 더 하자" (2026-07-30 대표).
 *
 * 승자 조합(MA20×신고20·느린청산·전체80)에 대해 아직 안 한 검증 4종:
 *   A. 연도별 일관성 — 해마다 알파가 나오나, 특정 해 몰빵인가
 *   B. 파라미터 고원 — 20/20/40/−2%가 뾰족한 봉우리(과최적화)인가 고원인가
 *   C. 비용 스트레스 — 슬리피지 2~5배에서도 알파가 사나
 *   D. 블록 부트스트랩 — 일별 수익률 재표집 500회로 CAGR·MDD 분포·손실 확률
 * 유니버스는 오늘 목록(상한선) — 절대치가 아니라 "구조가 버티는가"를 본다.
 */
async function robust() {
  const { histories, bench, tradable } = await loadAll()
  const uni = { ...baseSpec({}).universe, symbols: tradable }
  const mkSpec = (ma: number, hb: number, exitMa: number, exitPct: number): StrategySpec =>
    baseSpec({
      entry: {
        op: 'and',
        nodes: [c('돌파', { kind: 'maCross', period: ma, dir: 'above' }), c('신고가', { kind: 'highBreak', days: hb })],
      },
      exits: [{ kind: 'maBreak', maPeriod: exitMa, pct: exitPct }],
      universe: uni,
    })
  const WINNER = mkSpec(20, 20, 40, 2)
  const y3 = new Date(Date.now() - 3 * 365.25 * 86400e3).toISOString().slice(0, 10)

  // ---- A. 연도별 일관성 ------------------------------------------------------
  log('')
  log('### A. 연도별 일관성 (승자 조합 · 전체 80 · 오늘 목록 상한선)')
  log('| 연도 | 전략 | 벤치 | 초과 | 매매 | 승률 |')
  log('|---|---|---|---|---|---|')
  const thisYear = new Date().getFullYear()
  let positiveYears = 0
  let totalYears = 0
  for (let y = 2017; y <= thisYear; y++) {
    const end = `${y}-12-31`
    const hist: Record<string, DailyBar[]> = {}
    for (const [s, bars] of Object.entries(histories)) hist[s] = bars.filter((b) => b.date <= end)
    const r = runStrategySpec(hist, `${y}-01-01`, WINNER, COST)
    const finalEq = r.equity.length ? r.equity[r.equity.length - 1].equity : COST.initialCapital
    const ret = (finalEq / COST.initialCapital - 1) * 100
    const inYear = bench.filter((b) => b.date >= `${y}-01-01` && b.date <= end)
    const bret = inYear.length >= 2 ? (inYear[inYear.length - 1].c / inYear[0].c - 1) * 100 : 0
    const closed = r.trades.filter((t) => t.exitDate != null)
    const wins = closed.filter((t) => (t.pnlPct ?? 0) > 0).length
    totalYears++
    if (ret > bret) positiveYears++
    log(
      `| ${y} | ${f1(ret)}% | ${f1(bret)}% | ${f1(ret - bret)}%p | ${closed.length} | ${
        closed.length ? ((wins / closed.length) * 100).toFixed(0) : '—'
      }% |`,
    )
  }
  log(`벤치 초과 연도: ${positiveYears}/${totalYears}`)

  // ---- B. 파라미터 고원 ------------------------------------------------------
  log('')
  log('### B. 파라미터 고원 — 중심(20/20/40/−2%)에서 한 축씩 이동, 최근 3y 알파')
  log('| 변형 | 3y 알파 | 3y MDD | 매매 |')
  log('|---|---|---|---|')
  const variations: { label: string; spec: StrategySpec }[] = [
    { label: '중심 20/20/40/−2%', spec: WINNER },
    ...[15, 25, 30].map((ma) => ({ label: `진입 MA${ma}`, spec: mkSpec(ma, 20, 40, 2) })),
    ...[10, 30, 55].map((hb) => ({ label: `신고가 ${hb}일`, spec: mkSpec(20, hb, 40, 2) })),
    ...[30, 50, 60].map((em) => ({ label: `청산 MA${em}`, spec: mkSpec(20, 20, em, 2) })),
    ...[0, 1, 3].map((ep) => ({ label: `버퍼 −${ep}%`, spec: mkSpec(20, 20, 40, ep) })),
  ]
  for (const v of variations) {
    const s = stats(v.label, '3y', runStrategySpec(histories, y3, v.spec, COST), bench, COST.initialCapital)
    log(`| ${v.label} | ${f1(s.alphaPct)}%p | ${f1(s.mddPct)}% | ${s.trades} |`)
  }

  // ---- C. 비용 스트레스 ------------------------------------------------------
  log('')
  log('### C. 비용 스트레스 — 슬리피지 배수별 3y 알파 (기본 0.1%)')
  log('| 슬리피지 | 왕복 비용 | 3y 알파 | 3y CAGR |')
  log('|---|---|---|---|')
  for (const slip of [0.1, 0.2, 0.3, 0.5, 1.0]) {
    const cost: CostSettings = { ...COST, slippagePct: slip }
    const s = stats(`slip${slip}`, '3y', runStrategySpec(histories, y3, WINNER, cost), bench, COST.initialCapital)
    const roundTrip = COST.feePct * 2 + COST.taxPct + slip * 2
    log(`| ${slip}% | ~${roundTrip.toFixed(2)}% | ${f1(s.alphaPct)}%p | ${f1(s.cagrPct)}% |`)
  }

  // ---- D. 블록 부트스트랩 ----------------------------------------------------
  // 전략 일별 수익률(3y)을 20일 블록으로 재표집해 500개 가상 3y 경로 생성.
  // 순서 의존(추세 군집)을 블록이 보존한다. 시드 고정(재현 가능).
  log('')
  log('### D. 블록 부트스트랩 (3y 일별 수익률 · 블록 20일 · 500경로 · 시드 고정)')
  {
    const r = runStrategySpec(histories, y3, WINNER, COST)
    const eq = r.equity.map((e) => e.equity)
    const daily: number[] = []
    for (let i = 1; i < eq.length; i++) daily.push(eq[i] / eq[i - 1] - 1)
    const BLOCK = 20
    let seed = 20260730
    const rand = () => {
      // LCG — Math.random 대신 시드 고정
      seed = (seed * 1664525 + 1013904223) % 4294967296
      return seed / 4294967296
    }
    const totals: number[] = []
    const mdds: number[] = []
    for (let p = 0; p < 500; p++) {
      let equity = 1
      let peak = 1
      let mdd = 0
      let n = 0
      while (n < daily.length) {
        const start = Math.floor(rand() * Math.max(1, daily.length - BLOCK))
        for (let k = 0; k < BLOCK && n < daily.length; k++, n++) {
          equity *= 1 + daily[start + k]
          if (equity > peak) peak = equity
          mdd = Math.min(mdd, equity / peak - 1)
        }
      }
      totals.push((equity - 1) * 100)
      mdds.push(mdd * 100)
    }
    totals.sort((a, b) => a - b)
    mdds.sort((a, b) => a - b)
    const pct = (arr: number[], q: number) => arr[Math.min(arr.length - 1, Math.floor(q * arr.length))]
    const lossProb = (totals.filter((t) => t < 0).length / totals.length) * 100
    const benchIn = bench.filter((b) => b.date >= y3)
    const benchTotal = benchIn.length >= 2 ? (benchIn[benchIn.length - 1].c / benchIn[0].c - 1) * 100 : 0
    const underBench = (totals.filter((t) => t < benchTotal).length / totals.length) * 100
    log(`3y 총수익 분포: 5% ${f1(pct(totals, 0.05))}% · 중앙값 ${f1(pct(totals, 0.5))}% · 95% ${f1(pct(totals, 0.95))}%`)
    log(`3y MDD 분포:   5%(약한 쪽) ${f1(pct(mdds, 0.95))}% · 중앙값 ${f1(pct(mdds, 0.5))}% · 95%(깊은 쪽) ${f1(pct(mdds, 0.05))}%`)
    log(`3년 손실(원금 미만) 확률: ${lossProb.toFixed(1)}% · 벤치(${f1(benchTotal)}%) 미달 확률: ${underBench.toFixed(1)}%`)
  }
  log('')
  log('⚠️ 오늘 목록 유니버스 — 절대치는 상한선. 부트스트랩은 과거 분포의 재표집이지 미래 보장이 아니다.')
  log('⚠️ 시뮬레이션이며 투자자문이 아니다.')
}

/**
 * 도전자 비교 (MODE=challenger) — "더 좋은 기법은 없을까" (2026-07-30 대표).
 *
 * 승자(MA20×신고20·느린청산·슬롯10·거래대금랭킹)를 기준으로, 구조가 다른 도전자를
 * 같은 홀드아웃 규율(전반 ~23 / 후반 24~ / 3y)로 비교한다. 세 구간 모두 승자보다
 * 좋아야 교체 후보다(한 구간 우위는 노이즈로 취급).
 *
 * 추가로 승자의 알려진 약점(초강세장 추격 실패 = 유휴현금이 놀아서)을 겨냥해
 * **유휴현금 지수(KODEX200) 파킹**을 [근사] 오버레이로 계산한다 — 엔진 수정 없이
 * 일별 투자비중을 매매 기록에서 재구성해 유휴분에 벤치 일수익을 얹는다
 * (슬롯 크기 피드백은 무시하는 1차 근사).
 */
async function challenger() {
  const { histories, bench, tradable } = await loadAll()
  const uni = { ...baseSpec({}).universe, symbols: tradable }
  const mk = (over: Partial<StrategySpec> & { entry?: ConditionNode }): StrategySpec =>
    baseSpec({
      entry: {
        op: 'and',
        nodes: [c('돌파', { kind: 'maCross', period: 20, dir: 'above' }), c('신고가', { kind: 'highBreak', days: 20 })],
      },
      exits: [{ kind: 'maBreak', maPeriod: 40, pct: 2 }],
      universe: uni,
      ...over,
    })
  const WINNER = mk({})
  const contenders: { label: string; spec: StrategySpec }[] = [
    { label: '기준: 승자(슬롯10·대금랭킹)', spec: WINNER },
    { label: '슬롯 5 (집중)', spec: mk({ sizing: { maxPositions: 5, mode: 'equalSlot' } }) },
    { label: '슬롯 15 (분산)', spec: mk({ sizing: { maxPositions: 15, mode: 'equalSlot' } }) },
    { label: '슬롯 20 (분산)', spec: mk({ sizing: { maxPositions: 20, mode: 'equalSlot' } }) },
    { label: '랭킹: 등락률(돌파 강도순)', spec: mk({ ranking: { by: 'changePct', dir: 'desc' } }) },
    {
      label: '진입 MA15',
      spec: mk({
        entry: {
          op: 'and',
          nodes: [c('돌파', { kind: 'maCross', period: 15, dir: 'above' }), c('신고가', { kind: 'highBreak', days: 20 })],
        },
      }),
    },
    {
      label: '신고가 10일',
      spec: mk({
        entry: {
          op: 'and',
          nodes: [c('돌파', { kind: 'maCross', period: 20, dir: 'above' }), c('신고가', { kind: 'highBreak', days: 10 })],
        },
      }),
    },
    {
      label: 'MA15×신고10 (결합)',
      spec: mk({
        entry: {
          op: 'and',
          nodes: [c('돌파', { kind: 'maCross', period: 15, dir: 'above' }), c('신고가', { kind: 'highBreak', days: 10 })],
        },
      }),
    },
    { label: '청산: 트레일링 −10%', spec: mk({ exits: [{ kind: 'trailing', pct: 10 }] }) },
    { label: '청산: 트레일링 −15%', spec: mk({ exits: [{ kind: 'trailing', pct: 15 }] }) },
    { label: '청산: MA40−2% + 트레일링 −20%', spec: mk({ exits: [{ kind: 'trailing', pct: 20 }, { kind: 'maBreak', maPeriod: 40, pct: 2 }] }) },
  ]

  const CUT = '2023-12-31'
  const histFit: Record<string, DailyBar[]> = {}
  for (const [s, bars] of Object.entries(histories)) histFit[s] = bars.filter((b) => b.date <= CUT)
  const benchFit = bench.filter((b) => b.date <= CUT)
  const y3 = new Date(Date.now() - 3 * 365.25 * 86400e3).toISOString().slice(0, 10)

  log('')
  log('| 도전자 | 전반(~23) 알파/MDD | **후반(24~) 알파/MDD** | 3y 알파/MDD | 3y CAGR | 매매(3y) |')
  log('|---|---|---|---|---|---|')
  for (const v of contenders) {
    const fit = stats(v.label, 'fit', runStrategySpec(histFit, '0000-00-00', v.spec, COST), benchFit, COST.initialCapital)
    const val = stats(v.label, 'val', runStrategySpec(histories, '2024-01-01', v.spec, COST), bench, COST.initialCapital)
    const w3 = stats(v.label, '3y', runStrategySpec(histories, y3, v.spec, COST), bench, COST.initialCapital)
    log(
      `| ${v.label} | ${f1(fit.alphaPct)}%p/${f1(fit.mddPct)}% | **${f1(val.alphaPct)}%p/${f1(val.mddPct)}%** | ${f1(
        w3.alphaPct,
      )}%p/${f1(w3.mddPct)}% | ${f1(w3.cagrPct)}% | ${w3.trades} |`,
    )
  }

  // ---- 유휴현금 지수 파킹 [근사] --------------------------------------------
  // 일별 투자금 = 열려 있는 매매의 qty×종가 합. 유휴비중 × 벤치 일수익을 엔진
  // 수익률에 더한다. 슬롯 크기 피드백(파킹 수익이 슬롯을 키우는 효과)은 무시 — 1차 근사.
  log('')
  log('### 유휴현금 KODEX200 파킹 [근사 오버레이] — 승자 기준')
  log('| 구간 | 원본 총수익 | 파킹 총수익 | 원본 알파(연) | **파킹 알파(연)** | 평균 유휴비중 |')
  log('|---|---|---|---|---|---|')
  const closeMaps: Record<string, Map<string, number>> = {}
  for (const [s, bars] of Object.entries(histories)) closeMaps[s] = new Map(bars.map((b) => [b.date, b.c]))
  const benchMap = new Map(bench.map((b) => [b.date, b.c]))
  const windows: [string, string, Record<string, DailyBar[]>, DailyBar[]][] = [
    ['전반(~23)', '0000-00-00', histFit, benchFit],
    ['후반(24~)', '2024-01-01', histories, bench],
    ['최근 3y', y3, histories, bench],
  ]
  for (const [label, start, hist, benchWin] of windows) {
    const r = runStrategySpec(hist, start, WINNER, COST)
    if (r.equity.length < 2) continue
    // 일별 투자금 재구성
    const investedByDate = new Map<string, number>()
    for (const t of r.trades) {
      const cm = closeMaps[t.symbol]
      if (!cm) continue
      for (const e of r.equity) {
        if (e.date < t.entryDate) continue
        if (t.exitDate != null && e.date >= t.exitDate) continue
        const px = cm.get(e.date)
        if (px != null) investedByDate.set(e.date, (investedByDate.get(e.date) ?? 0) + t.qty * px)
      }
    }
    let overlay = 1
    let idleSum = 0
    let prevBench = benchMap.get(r.equity[0].date) ?? null
    for (let i = 1; i < r.equity.length; i++) {
      const prev = r.equity[i - 1]
      const cur = r.equity[i]
      const stratRet = cur.equity / prev.equity - 1
      const invested = investedByDate.get(prev.date) ?? 0
      const idleFrac = Math.max(0, Math.min(1, 1 - invested / prev.equity))
      idleSum += idleFrac
      const bNow = benchMap.get(cur.date) ?? null
      const bRet = prevBench != null && bNow != null ? bNow / prevBench - 1 : 0
      if (bNow != null) prevBench = bNow
      overlay *= 1 + stratRet + idleFrac * bRet
    }
    const years = yearsBetween(r.equity[0].date, r.equity[r.equity.length - 1].date)
    const origTotal = (r.equity[r.equity.length - 1].equity / COST.initialCapital - 1) * 100
    const overlayTotal = (overlay - 1) * 100
    const bIn = benchWin.filter((b) => b.date >= r.equity[0].date && b.date <= r.equity[r.equity.length - 1].date)
    const bCagr = bIn.length >= 2 ? cagr(bIn[bIn.length - 1].c / bIn[0].c, years) : 0
    log(
      `| ${label} | ${f1(origTotal)}% | ${f1(overlayTotal)}% | ${f1(cagr(1 + origTotal / 100, years) - bCagr)}%p | **${f1(
        cagr(overlay, years) - bCagr,
      )}%p** | ${((idleSum / (r.equity.length - 1)) * 100).toFixed(0)}% |`,
    )
  }
  log('')
  log('⚠️ 세 구간 모두 기준 초과인 도전자만 교체 후보 — 한 구간 우위는 다중비교 노이즈. 오늘 목록 상한선 동일.')
  log('⚠️ 파킹 오버레이는 1차 근사(슬롯 피드백 무시) — 채택하려면 엔진에 정식 구현 후 절단 불변성 테스트 필수.')
  log('⚠️ 시뮬레이션이며 투자자문이 아니다.')
}

/**
 * 초장기(2000~) 결과 전수검사 (MODE=longcheck) — "+8,986%가 가능하냐" (2026-07-31 대표).
 *
 * UI에서 2000-01~2026-07 승자 조합이 총수익 +8,985.8%(연환산 +18.6%)를 냈다.
 * 검사 항목:
 *   A. 연대별 분해 — 수익이 특정 연대 몰빵인지, 연환산 알파가 기존 실측(7차 +9.7%p)과 정합인지
 *   B. 연도별 유니버스 커버리지 — 2000년대 초 표본이 몇 종목뿐인지(집중 리스크·선택편향 극대 구간)
 *   C. 이상 트레이드 검출 — 단일 매매 수익 상위 10개(저유동성·데이터 오류 의심 구간 식별)
 */
async function longcheck() {
  const { histories, bench, tradable } = await loadAll('since:1999-06-01')
  const spec = baseSpec({
    entry: {
      op: 'and',
      nodes: [c('돌파', { kind: 'maCross', period: 20, dir: 'above' }), c('신고가', { kind: 'highBreak', days: 20 })],
    },
    exits: [{ kind: 'maBreak', maPeriod: 40, pct: 2 }],
    universe: { ...baseSpec({}).universe, symbols: tradable },
  })

  // ---- B. 연도별 커버리지 ----------------------------------------------------
  log('')
  log('### B. 연도별 유니버스 커버리지 (그 해 1월에 시세가 존재한 종목 수 / 78)')
  const years: number[] = []
  for (let y = 2000; y <= new Date().getFullYear(); y += 2) years.push(y)
  const cov = years
    .map((y) => {
      const n = tradable.filter((s) => (histories[s]?.[0]?.date ?? '9999') <= `${y}-01-31`).length
      return `${y}: ${n}`
    })
    .join(' · ')
  log(cov)

  // ---- A. 연대별 분해 --------------------------------------------------------
  log('')
  log('### A. 연대별 분해 (같은 스펙 · 종료일 절단)')
  log('| 구간 | 총수익 | CAGR | 벤치CAGR | 알파(연) | MDD | 매매 | 승률 |')
  log('|---|---|---|---|---|---|---|---|')
  const spans: [string, string, string][] = [
    ['전체 2000~', '2000-01-01', '9999-12-31'],
    ['2000–2004', '2000-01-01', '2004-12-31'],
    ['2005–2009', '2005-01-01', '2009-12-31'],
    ['2010–2015', '2010-01-01', '2015-12-31'],
    ['2016–2023', '2016-01-01', '2023-12-31'],
    ['2024~현재', '2024-01-01', '9999-12-31'],
  ]
  let fullTrades: ConditionResult['trades'] = []
  for (const [label, start, end] of spans) {
    const hist: Record<string, DailyBar[]> = {}
    for (const [s, bars] of Object.entries(histories)) hist[s] = bars.filter((b) => b.date <= end)
    const benchCut = bench.filter((b) => b.date <= end)
    const r = runStrategySpec(hist, start, spec, COST)
    if (label.startsWith('전체')) fullTrades = r.trades
    const s = stats(label, label, r, benchCut, COST.initialCapital)
    log(
      `| ${label} | ${f1(s.totalPct)}% | **${f1(s.cagrPct)}%** | ${f1(s.benchCagrPct)}% | ${f1(s.alphaPct)}%p | ${f1(
        s.mddPct,
      )}% | ${s.trades} | ${s.winRatePct?.toFixed(0) ?? '—'}% |`,
    )
  }

  // ---- C. 이상 트레이드 검출 -------------------------------------------------
  log('')
  log('### C. 단일 매매 수익 상위 10 (저유동성·데이터 오류 의심 구간 수동 확인용)')
  const closed = fullTrades.filter((t) => t.exitDate != null && t.pnlPct != null)
  const top = [...closed].sort((a, b) => (b.pnlPct ?? 0) - (a.pnlPct ?? 0)).slice(0, 10)
  for (const t of top) log(`- ${t.symbol} ${t.entryDate} → ${t.exitDate} : ${f2(t.pnlPct ?? 0)}%`)
  const over100 = closed.filter((t) => (t.pnlPct ?? 0) > 100).length
  const totalWinPnl = closed.filter((t) => (t.pnlPct ?? 0) > 0).reduce((s2, t) => s2 + (t.pnlPct ?? 0), 0)
  const top10Share = totalWinPnl > 0 ? (top.reduce((s2, t) => s2 + (t.pnlPct ?? 0), 0) / totalWinPnl) * 100 : 0
  log(`+100% 초과 매매: ${over100}건 / ${closed.length} · 상위 10개가 전체 이익 합의 ${top10Share.toFixed(1)}% 기여`)
  log('')
  log('⚠️ 2000년대 초는 표본이 얇고(커버리지 참조) 오늘의 시총 상위라는 선택편향이 극대인 구간 — 절대 수치는 상한선.')
  log('⚠️ 시뮬레이션이며 투자자문이 아니다.')
}

/**
 * 코스피 상승추세 레짐 기준 탐색 (MODE=regime) — 2026-07-30 대표 지시.
 *
 * "코스피 지수가 상승추세일 때만 진입"을 전제로, '상승추세'의 판단 기준 후보 7종을
 * 승자 조합(MA20×신고20·느린청산·전체80)에 레짐 게이트로 끼워 전수 비교한다.
 * 레짐 의미: 지수 조건이 참인 날만 **신규 진입** 허용(당일 종가 판정→익일 반영),
 * 청산은 항상 동작 — 추세 이탈 시 강제 전량 청산은 하지 않는다(별도 설계 사안).
 * 판정: 알파 유지력 + MDD 개선 + fit/val 일관성 (알파만도, MDD만도 아닌 균형).
 */
async function regime() {
  const { histories, bench, tradable } = await loadAll()
  const uni = { ...baseSpec({}).universe, symbols: tradable }
  const entry20 = {
    op: 'and',
    nodes: [c('돌파', { kind: 'maCross', period: 20, dir: 'above' }), c('신고가', { kind: 'highBreak', days: 20 })],
  } as ConditionNode
  const gate = (nodes: ConditionNode[]): StrategySpec['regime'] => ({
    symbol: KOSPI_INDEX,
    entry: { op: 'and', nodes },
  })
  const R: { label: string; regime: StrategySpec['regime'] | null }[] = [
    { label: 'R0 레짐 없음 (기준)', regime: null },
    { label: 'R1 지수>20일선', regime: gate([c('r', { kind: 'maPosition', period: 20, dir: 'above' })]) },
    { label: 'R2 지수>60일선', regime: gate([c('r', { kind: 'maPosition', period: 60, dir: 'above' })]) },
    { label: 'R3 지수>120일선', regime: gate([c('r', { kind: 'maPosition', period: 120, dir: 'above' })]) },
    { label: 'R4 정배열 5>10', regime: gate([c('r', { kind: 'maAlign', fast: 5, slow: 10 })]) },
    { label: 'R5 정배열 20>60', regime: gate([c('r', { kind: 'maAlign', fast: 20, slow: 60 })]) },
    {
      label: 'R6 20>60 그리고 지수>20일선',
      regime: gate([c('r1', { kind: 'maAlign', fast: 20, slow: 60 }), c('r2', { kind: 'maPosition', period: 20, dir: 'above' })]),
    },
    { label: 'R7 지수 RSI14≥50', regime: gate([c('r', { kind: 'rsi', period: 14, min: 50 })]) },
  ]
  const CUT = '2023-12-31'
  const histFit: Record<string, DailyBar[]> = {}
  for (const [s, bars] of Object.entries(histories)) histFit[s] = bars.filter((b) => b.date <= CUT)
  const benchFit = bench.filter((b) => b.date <= CUT)
  const y3 = new Date(Date.now() - 3 * 365.25 * 86400e3).toISOString().slice(0, 10)

  log('')
  log('| 상승추세 기준 | 전반(~23) 알파/MDD | **후반(24~) 알파/MDD** | 3y 알파/MDD | 3y CAGR | 매매(3y) | MAR(3y) |')
  log('|---|---|---|---|---|---|---|')
  for (const r of R) {
    const spec = baseSpec({
      entry: entry20,
      exits: [{ kind: 'maBreak', maPeriod: 40, pct: 2 }],
      universe: uni,
      ...(r.regime ? { regime: r.regime } : {}),
    })
    const fit = stats(r.label, 'fit', runStrategySpec(histFit, '0000-00-00', spec, COST), benchFit, COST.initialCapital)
    const val = stats(r.label, 'val', runStrategySpec(histories, '2024-01-01', spec, COST), bench, COST.initialCapital)
    const w3 = stats(r.label, '3y', runStrategySpec(histories, y3, spec, COST), bench, COST.initialCapital)
    const mar = w3.mddPct !== 0 ? (w3.cagrPct / Math.abs(w3.mddPct)).toFixed(2) : '—'
    log(
      `| ${r.label} | ${f1(fit.alphaPct)}%p/${f1(fit.mddPct)}% | **${f1(val.alphaPct)}%p/${f1(val.mddPct)}%** | ${f1(
        w3.alphaPct,
      )}%p/${f1(w3.mddPct)}% | ${f1(w3.cagrPct)}% | ${w3.trades} | ${mar} |`,
    )
  }
  log('')
  log('MAR = 3y CAGR ÷ |3y MDD| — 낙폭 한 단위당 수익. 레짐의 가치는 알파가 아니라 MAR·MDD로 본다.')
  log('⚠️ 오늘 목록 상한선 동일. 8차 실측(2010~23)에서 지수>20일선 레짐은 MDD −30→−21 개선·CAGR 14.8→8.6 훼손이었다 — 장기 구간 교차 확인 필요 시 era 변형으로.')
  log('⚠️ 시뮬레이션이며 투자자문이 아니다.')
}

/**
 * 시점 고정 코스닥 상위 검증 (MODE=pitkq) — 2026-07-30 대표 지시.
 *
 * "그 시점 코스닥 상위 40으로" — 단 과거 코스닥 랭킹 40개 전체의 신뢰 가능한
 * 소스가 없어 **연도별 상위 ~12종목 [추정: 모델 지식 기반]**으로 축소 실행한다.
 * 순위 오차가 코스피보다 크고, 상폐·합병 종목(SK브로드밴드·GS홈쇼핑·
 * 셀트리온헬스케어·SK머티리얼즈·코오롱티슈진 등)은 Yahoo에 데이터가 없어
 * 빠진다 — **이 공백 자체가 생존편향**이므로 연도별 커버리지를 함께 찍는다.
 * 코스닥→코스피 이전 종목은 현재 접미사로 전 기간 시세가 이어진다(.KQ→.KS 폴백).
 */
const PIT_KOSDAQ12: Record<number, string[]> = {
  2010: ['068270', '046890', '035720', '072870', '033630', '035760', '044490', '022100', '026960', '014620', '034230', '028150'],
  2011: ['068270', '035720', '046890', '035760', '033630', '034230', '026960', '022100', '072870', '028150', '130960', '053800'],
  2012: ['068270', '035720', '130960', '034230', '026960', '035760', '033630', '046890', '028150', '022100', '112040', '053800'],
  2013: ['068270', '035720', '130960', '034230', '035760', '026960', '033630', '028150', '046890', '022100', '096530', '086900'],
  2014: ['035720', '068270', '026960', '130960', '034230', '035760', '028150', '078340', '086900', '096530', '022100', '039030'],
  2015: ['035720', '068270', '026960', '130960', '086900', '041960', '084990', '078340', '035760', '034230', '016170', '145020'],
  2016: ['068270', '035720', '130960', '016170', '086900', '041960', '084990', '078340', '036490', '034230', '035760', '145020'],
  2017: ['068270', '091990', '215600', '130960', '084990', '086900', '145020', '041960', '016170', '253450', '263750', '036490'],
  2018: ['091990', '215600', '035760', '084990', '086900', '263750', '253450', '028300', '145020', '068760', '003670', '112040'],
  2019: ['091990', '035760', '028300', '084990', '263750', '253450', '086900', '145020', '032500', '068760', '036490', '034230'],
  2020: ['091990', '096530', '028300', '196170', '068760', '293490', '247540', '263750', '036490', '035760', '032500', '095700'],
  2021: ['091990', '247540', '263750', '293490', '066970', '112040', '036490', '096530', '068760', '028300', '196170', '278280'],
  2022: ['091990', '247540', '066970', '293490', '263750', '028300', '068760', '086520', '278280', '112040', '196170', '035900'],
  2023: ['247540', '086520', '091990', '066970', '028300', '035900', '022100', '068760', '196170', '293490', '263750', '214150'],
}

/** 코스닥 출신 종목 폴백 로드 — .KQ 우선, 실패/짧으면 .KS (이전 상장 종목은 현재 접미사에 전 이력) */
async function fetchKrDual(code: string, range: string): Promise<DailyBar[] | null> {
  let best: DailyBar[] | null = null
  for (const suffix of ['.KQ', '.KS']) {
    try {
      const bars = await fetchDaily(`${code}${suffix}`, range)
      if (!best || bars.length > best.length) best = bars
      if (bars.length >= 200) break
    } catch {
      /* 다음 접미사 시도 */
    }
    await sleep(120)
  }
  return best && best.length >= 200 ? best : null
}

async function pitkq() {
  const years = Object.keys(PIT_KOSDAQ12)
    .map(Number)
    .sort((a, b) => a - b)
  const uniq = [...new Set(Object.values(PIT_KOSDAQ12).flat())]
  log(`시점 고정 코스닥 상위 ~12 [추정] · ${years[0]}~${years[years.length - 1]} · 고유 종목 ${uniq.length}개`)
  const histories: Record<string, DailyBar[]> = {}
  const failed: string[] = []
  for (const code of uniq) {
    const bars = await fetchKrDual(code, 'since:2009-01-01')
    if (bars) histories[code] = bars
    else failed.push(code)
    await sleep(150)
  }
  const bench = await fetchDaily(BENCH, 'since:2009-01-01')
  let kqIndex: DailyBar[] = []
  try {
    kqIndex = await fetchDaily('^KQ11', 'since:2009-01-01')
  } catch {
    log('⚠️ 코스닥 지수(^KQ11) 로드 실패 — 지수 비교 생략')
  }
  log(
    `일봉 로드: ${Object.keys(histories).length}/${uniq.length}종목 · 데이터 없음(상폐·합병 등) ${failed.length}개 — ${failed.join(', ')}`,
  )
  log('⚠️ 빠진 종목이 당시 시총 상위였다는 사실 자체가 생존편향 공백이다(신라젠 정지·헬스케어 합병 등).')

  const entry20 = {
    op: 'and',
    nodes: [c('20일선돌파', { kind: 'maCross', period: 20, dir: 'above' }), c('20일신고가', { kind: 'highBreak', days: 20 })],
  } as ConditionNode

  for (const slots of [10, 5]) {
    log('')
    log(`### 슬롯 ${slots} (한 종목당 자본 1/${slots})`)
    log('| 연도 | 커버 | 전략 수익 | KODEX200 | 코스닥지수 | 초과(vs KODEX) | 매매 | 승률 | 평균손익/회 |')
    log('|---|---|---|---|---|---|---|---|---|')
    let factor = 1
    const chained: number[] = []
    let winsTotal = 0
    let closedTotal = 0
    let pnlSum = 0
    let benchFactor = 1
    for (const y of years) {
      const list = PIT_KOSDAQ12[y]
      const syms = list.filter((s) => histories[s])
      const end = `${y}-12-31`
      const hist: Record<string, DailyBar[]> = {}
      for (const s of syms) hist[s] = histories[s].filter((b) => b.date <= end)
      const spec = baseSpec({
        entry: entry20,
        exits: [{ kind: 'maBreak', maPeriod: 40, pct: 2 }],
        universe: { ...baseSpec({}).universe, symbols: syms },
        sizing: { maxPositions: slots, mode: 'equalSlot' },
      })
      const r = runStrategySpec(hist, `${y}-01-01`, spec, COST)
      const finalEq = r.equity.length ? r.equity[r.equity.length - 1].equity : COST.initialCapital
      const ret = finalEq / COST.initialCapital
      const inYear = bench.filter((b) => b.date >= `${y}-01-01` && b.date <= end)
      const bret = inYear.length >= 2 ? inYear[inYear.length - 1].c / inYear[0].c : 1
      const kqYear = kqIndex.filter((b) => b.date >= `${y}-01-01` && b.date <= end)
      const kqret = kqYear.length >= 2 ? kqYear[kqYear.length - 1].c / kqYear[0].c : null
      for (const e of r.equity) chained.push((factor * e.equity) / COST.initialCapital)
      factor *= ret
      benchFactor *= bret
      const closed = r.trades.filter((t) => t.exitDate != null)
      const wins = closed.filter((t) => (t.pnlPct ?? 0) > 0).length
      const pnl = closed.reduce((s2, t) => s2 + (t.pnlPct ?? 0), 0)
      winsTotal += wins
      closedTotal += closed.length
      pnlSum += pnl
      log(
        `| ${y} | ${syms.length}/${list.length} | ${f1((ret - 1) * 100)}% | ${f1((bret - 1) * 100)}% | ${
          kqret != null ? `${f1((kqret - 1) * 100)}%` : '—'
        } | ${f1((ret - bret) * 100)}%p | ${closed.length} | ${
          closed.length ? ((wins / closed.length) * 100).toFixed(0) : '—'
        }% | ${closed.length ? f2(pnl / closed.length) : '—'}% |`,
      )
    }
    let peak = 0
    let mdd = 0
    for (const eq of chained) {
      if (eq > peak) peak = eq
      mdd = Math.min(mdd, peak > 0 ? (eq / peak - 1) * 100 : 0)
    }
    const yearsSpan = years.length
    const cagrPct = (Math.pow(factor, 1 / yearsSpan) - 1) * 100
    const benchCagrPct = (Math.pow(benchFactor, 1 / yearsSpan) - 1) * 100
    log('')
    log(
      `종합(슬롯 ${slots}) ${years[0]}~${years[years.length - 1]}: 총수익 ${f1((factor - 1) * 100)}% · CAGR **${f1(
        cagrPct,
      )}%** · KODEX200 CAGR ${f1(benchCagrPct)}% · 알파(연) **${f1(cagrPct - benchCagrPct)}%p** · MDD ${f1(mdd)}% · ` +
        `매매 ${closedTotal}회 · 승률 ${closedTotal ? ((winsTotal / closedTotal) * 100).toFixed(0) : '—'}% · ` +
        `평균손익/회 ${closedTotal ? f2(pnlSum / closedTotal) : '—'}%`,
    )
  }
  log('')
  log('⚠️ 유니버스는 연도별 상위 ~12 [추정: 모델 지식·순위 오차 큼] — "상위 40"의 대용이지 실측 랭킹이 아니다.')
  log('⚠️ 상폐·합병 종목 데이터 공백 = 생존편향 잔존. 연말 강제 청산 근사. 시뮬레이션이며 투자자문이 아니다.')
}

/**
 * 라오어 무한매수법 TQQQ 비교 (MODE=tqqq) — 2026-07-30 대표 지시.
 *
 * 구현은 **원조 v1의 단순화판**임을 명시한다(규칙 3):
 *   - 원금 40분할, 매일 종가에 1회분 매수 (분할 소진 시 매수 중단·보유 대기)
 *   - 평단가(수수료 포함) +10% 도달 종가에 전량 매도 → 원금+수익 재분할(복리)
 *   - 손절 없음 (v1 원칙)
 *   - 미구현: v2.2의 LOC 반반 매수·전후반전 로직·큰수매수 — 결과가 다를 수 있다
 * 비용: 왕복 0.2% 가정(해외 수수료+환전 스프레드 근사). USD 기준 — 환율 손익·
 * 해외주식 양도세 22% 미반영. 소수점 수량 허용(시뮬 단순화).
 */
async function tqqq() {
  const bars = await fetchDaily('TQQQ', 'since:2010-02-01')
  log(`TQQQ ${bars.length}봉 (${bars[0]?.date} ~ ${bars[bars.length - 1]?.date}) — 총수익 보정(adjclose) 적용`)
  const FEE = 0.1 // 편도 %

  interface SimRes {
    cagrPct: number
    totalPct: number
    mddPct: number
    cycles: number
  }
  const dd = (eq: number, peak: number) => (peak > 0 ? (eq / peak - 1) * 100 : 0)

  function infiniteBuy(win: DailyBar[]): SimRes | null {
    if (win.length < 60) return null
    let cash = 10_000
    let shares = 0
    let cost = 0 // 보유분 총매입원가(수수료 포함) — 평단 = cost/shares
    let splits = 0
    let splitAmt = cash / 40
    let cycles = 0
    let peak = cash
    let mdd = 0
    for (const b of win) {
      const px = b.c
      const avg = shares > 0 ? cost / shares : 0
      if (shares > 0 && px >= avg * 1.1) {
        cash += shares * px * (1 - FEE / 100)
        shares = 0
        cost = 0
        splits = 0
        cycles++
        splitAmt = cash / 40
      } else if (splits < 40 && cash > 0) {
        const spend = Math.min(splitAmt, cash)
        const qty = spend / (px * (1 + FEE / 100))
        shares += qty
        cost += spend
        cash -= spend
        splits++
      }
      const eq = cash + shares * px
      if (eq > peak) peak = eq
      mdd = Math.min(mdd, dd(eq, peak))
    }
    const finalEq = cash + shares * win[win.length - 1].c
    const years = yearsBetween(win[0].date, win[win.length - 1].date)
    return { cagrPct: cagr(finalEq / 10_000, years), totalPct: (finalEq / 10_000 - 1) * 100, mddPct: mdd, cycles }
  }

  function buyHold(win: DailyBar[]): SimRes | null {
    if (win.length < 2) return null
    let peak = 0
    let mdd = 0
    for (const b of win) {
      if (b.c > peak) peak = b.c
      mdd = Math.min(mdd, dd(b.c, peak))
    }
    const ratio = (win[win.length - 1].c * (1 - FEE / 100)) / (win[0].c * (1 + FEE / 100))
    const years = yearsBetween(win[0].date, win[win.length - 1].date)
    return { cagrPct: cagr(ratio, years), totalPct: (ratio - 1) * 100, mddPct: mdd, cycles: 0 }
  }

  const spans: [string, string, string][] = [
    ['2010–2023 (14y)', '2010-02-01', '2023-12-31'],
    ['2010–2015', '2010-02-01', '2015-12-31'],
    ['2016–2019', '2016-01-01', '2019-12-31'],
    ['2020–2023', '2020-01-01', '2023-12-31'],
    ['2024~현재', '2024-01-01', '9999-12-31'],
    ['전체 2010~현재', '2010-02-01', '9999-12-31'],
  ]
  log('')
  log('| 구간 | 무한매수 CAGR | 무한매수 총수익 | 무한매수 MDD | 사이클 | TQQQ 거치 CAGR | TQQQ 거치 MDD |')
  log('|---|---|---|---|---|---|---|')
  for (const [label, start, end] of spans) {
    const win = bars.filter((b) => b.date >= start && b.date <= end)
    const ib = infiniteBuy(win)
    const bh = buyHold(win)
    if (!ib || !bh) {
      log(`| ${label} | 데이터 부족 | | | | | |`)
      continue
    }
    log(
      `| ${label} | **${f1(ib.cagrPct)}%** | ${f1(ib.totalPct)}% | ${f1(ib.mddPct)}% | ${ib.cycles}회 | ${f1(
        bh.cagrPct,
      )}% | ${f1(bh.mddPct)}% |`,
    )
  }
  log('')
  log('⚠️ 단순화 v1 구현(LOC 반반·전후반전 미구현) — 라오어 원저 성적과 다를 수 있다. USD 기준·환율/양도세 미반영.')
  log('⚠️ 시뮬레이션이며 투자자문이 아니다. 3배 레버리지 ETF는 변동성 잠식·극단 낙폭(−80%대) 상품이다.')
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

const MODES: Record<string, () => Promise<void>> = {
  sweep,
  mine,
  payoff,
  era,
  tqqq,
  pit,
  pitkq,
  band,
  robust,
  challenger,
  regime,
  longcheck,
  backtest: main,
}
const entry = MODES[process.env.MODE ?? 'backtest'] ?? main
entry().catch((e) => {
  console.error('실행 실패:', e)
  process.exit(1)
})
