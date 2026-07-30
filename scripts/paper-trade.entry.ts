// 페이퍼 트레이딩 일일 갱신 — GitHub Actions 크론(장마감 후)에서 실행.
//
// 방식 = **엔진 재실행형**: 상태를 따로 굴리지 않고, 매일 개시일(inception)부터
// 오늘까지를 시뮬레이터와 같은 엔진(runStrategySpec)으로 전부 재계산해 트랙별
// JSON(public/data/paper/<track>.json)으로 커밋한다.
//   - 장점: 시뮬과 수치가 갈라질 수 없고, 상태 전이 버그가 원천 차단된다.
//     절단 불변성(규칙 1)이 성립하므로 과거 매매는 재실행해도 변하지 않는다.
//   - 유니버스·스펙·비용은 config.json에 **동결** — 개시 후 바꾸지 않는다
//     (오늘의 목록을 개시일에 고정했으므로 이후 구간에 미래참조 없음).
//   - 한계: 체결은 Yahoo 종가/시가 근사(슬리피지 가정치 0.1%). 실호가 대조는
//     2단계(키움 모의서버) 개통 후. Yahoo 배당 보정 계수가 갱신되면 과거
//     평가액이 미세 조정될 수 있다(매매 자체는 불변).
//
// 실계좌 경계(규칙 2): 조회·시뮬레이션만. 주문·자격증명 없음.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { runStrategySpec, type CostSettings } from '../src/features/backtest/conditionScreen'
import { SPEC_VERSION, type ConditionNode, type StrategySpec } from '../src/features/backtest/strategySpec'
import type { DailyBar } from '../src/features/backtest/types'

const root = process.env.REPO_ROOT ?? process.cwd()
const paperDir = join(root, 'public', 'data', 'paper')

interface PaperConfig {
  inception: string
  cost: CostSettings
  tracks: Record<string, { label: string; symbols: string[]; entryMa?: number; inception?: string }>
  benchmark: string
}

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

function winnerSpec(symbols: string[], entryMa = 20): StrategySpec {
  return {
    version: SPEC_VERSION,
    id: `paper-ma${entryMa}-high20-slow`,
    name: `MA${entryMa}돌파×20일신고가·느린청산 (페이퍼)`,
    source: '백테스트 5·6차 승자 (MA15 변형은 14차 도전자) — 2026-07-30 페이퍼 트레이딩 개시',
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
    sizing: { maxPositions: 10, mode: 'equalSlot' },
    execution: { timing: 'sameClose', orderType: 'market' },
  }
}

async function main() {
  const config = JSON.parse(readFileSync(join(paperDir, 'config.json'), 'utf8')) as PaperConfig
  // 워밍업: 개시일 이전 6개월 — MA40·신고20 계산분
  const warmupStart = new Date(Date.parse(config.inception) - 183 * 86400e3).toISOString().slice(0, 10)
  const uniq = [...new Set(Object.values(config.tracks).flatMap((t) => t.symbols))]
  console.log(`페이퍼 트레이딩 갱신 — 개시 ${config.inception} · 종목 ${uniq.length} · 워밍업 ${warmupStart}~`)

  const histories: Record<string, DailyBar[]> = {}
  const failed: string[] = []
  for (const sym of uniq) {
    try {
      const bars = await fetchDaily(sym, warmupStart)
      if (bars.length >= 60) histories[sym] = bars
      else failed.push(`${sym}(짧음 ${bars.length})`)
    } catch (e) {
      failed.push(`${sym}(${(e as Error).message})`)
    }
    await sleep(150)
  }
  if (failed.length) console.log(`⚠️ 로드 실패 ${failed.length}: ${failed.join(', ')}`)
  if (Object.keys(histories).length < 20) throw new Error('시세 로드가 너무 적어 중단 — 오늘 기록을 갱신하지 않는다')
  // 개시일이 아직 오지 않았을 수 있으므로(미래 period1 → Yahoo 400) 워밍업 시점부터 받아 자른다
  const bench = (await fetchDaily(config.benchmark, warmupStart)).filter((b) => b.date >= config.inception)

  mkdirSync(paperDir, { recursive: true })
  for (const [trackId, track] of Object.entries(config.tracks)) {
    const spec = winnerSpec(track.symbols.filter((s) => histories[s]), track.entryMa ?? 20)
    const inception = track.inception ?? config.inception
    const r = runStrategySpec(histories, inception, spec, config.cost)
    const finalEq = r.equity.length ? r.equity[r.equity.length - 1].equity : config.cost.initialCapital
    const benchRet = bench.length >= 2 ? (bench[bench.length - 1].c / bench[0].c - 1) * 100 : null
    const closed = r.trades.filter((t) => t.exitDate != null)
    const wins = closed.filter((t) => (t.pnlPct ?? 0) > 0).length
    const out = {
      track: trackId,
      label: track.label,
      updatedAt: new Date().toISOString(),
      inception,
      dataNote: 'Yahoo 일봉(비공식·총수익 보정) 근사 체결 — 실호가 대조는 2단계에서. 시뮬레이션이며 투자자문 아님.',
      summary: {
        equity: Math.round(finalEq),
        totalPct: +((finalEq / config.cost.initialCapital - 1) * 100).toFixed(2),
        benchTotalPct: benchRet != null ? +benchRet.toFixed(2) : null,
        mddPct: +r.equity.reduce((m, e) => Math.min(m, e.drawdownPct), 0).toFixed(2),
        trades: closed.length,
        open: r.openAtEnd,
        winRatePct: closed.length ? +((wins / closed.length) * 100).toFixed(1) : null,
      },
      openPositions: r.trades.filter((t) => t.exitDate == null),
      trades: r.trades,
      equity: r.equity.map((e) => ({ date: e.date, equity: Math.round(e.equity) })),
      excluded: failed,
    }
    writeFileSync(join(paperDir, `${trackId}.json`), JSON.stringify(out, null, 1))
    console.log(
      `[${trackId}] ${track.label}: 평가액 ${out.summary.equity.toLocaleString()} (${out.summary.totalPct >= 0 ? '+' : ''}${
        out.summary.totalPct
      }%) · 벤치 ${out.summary.benchTotalPct ?? '—'}% · 매매 ${out.summary.trades} · 보유 ${out.summary.open}`,
    )
  }
  console.log('완료 — public/data/paper/*.json 갱신')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
