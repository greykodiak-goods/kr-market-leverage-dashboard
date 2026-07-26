// 강건성 검사 — 고원(plateau) vs 첨탑(peak) 판별 검증.
import { check, finish, section, rng } from './harness'
import { buildVariants, buildStartVariants, runRobustness } from '../src/features/backtest/robustness'
import { defaultConfig } from '../src/features/backtest/models'
import type { DailyBar, HistoryResult } from '../src/lib/history'

function mkHist(symbol: string, closes: number[]): HistoryResult {
  const bars: DailyBar[] = closes.map((c, i) => ({
    date: new Date(Date.UTC(2018, 0, 1) + i * 86400000).toISOString().slice(0, 10),
    t: 0, o: c, h: c * 1.004, l: c * 0.996, c, v: 1e6,
  }))
  return {
    symbol, currency: 'USD', exchange: 'TEST', instrumentType: 'EQUITY', bars,
    stale: false, fetchedAt: 0, source: 'test', proxyUsed: 'test',
    adjustment: 'split+dividend', droppedBars: 0,
  }
}

function walk(seed: number, n: number, drift = 0.0004, vol = 0.02): number[] {
  const r = rng(seed)
  const out: number[] = []
  let p = 100
  for (let i = 0; i < n; i++) { out.push(p); p *= 1 + drift + vol * (r() * 2 - 1) }
  return out
}

const N = 1000

section('1) 변형 생성 — 축별로 골고루 만든다')
{
  const cfg = defaultConfig('golden-cross')
  const vs = buildVariants('golden-cross', cfg)
  check('기준 변형이 정확히 1개', vs.filter((v) => v.axis === '기준').length === 1)
  check('파라미터 축 변형 5개 이상', vs.filter((v) => v.axis === '파라미터').length >= 5, `${vs.filter((v) => v.axis === '파라미터').length}`)
  check('비용 축 변형 2개', vs.filter((v) => v.axis === '비용').length === 2)
  check('기준은 원본 설정 그대로', vs[0].cfg === cfg)
  check('변형마다 라벨이 다름', new Set(vs.map((v) => v.label)).size === vs.length)
  // 비용 변형은 실제로 비용이 올라야 한다
  const costV = vs.find((v) => v.axis === '비용')!
  check('비용 변형이 수수료를 올림', costV.cfg.settings.commissionPct > cfg.settings.commissionPct)
  check('비용 변형이 슬리피지를 올림', costV.cfg.settings.slippagePct > cfg.settings.slippagePct)
  // 파라미터 변형은 유니버스를 건드리지 않아야 한다(비교 가능성 유지)
  check('모든 변형이 같은 유니버스', vs.every((v) => JSON.stringify(v.cfg.symbols) === JSON.stringify(cfg.symbols)))
}

section('2) 모델 유형별 변형 축')
{
  for (const id of ['dual-momentum', 'infinite-buying', 'value-rebalancing', 'rs-rotation']) {
    const vs = buildVariants(id, defaultConfig(id))
    check(`${id}: 변형 5개 이상 생성`, vs.length >= 5, `${vs.length}`)
    check(`${id}: 비용 축 포함`, vs.some((v) => v.axis === '비용'))
  }
}

section('3) 시작시점 변형')
{
  const dates = Array.from({ length: 800 }, (_, i) =>
    new Date(Date.UTC(2018, 0, 1) + i * 86400000).toISOString().slice(0, 10))
  const vs = buildStartVariants(defaultConfig('golden-cross'), dates)
  check('시작시점 변형 2개', vs.length === 2)
  check('시작일이 실제로 다름', vs[0].cfg.startDate !== vs[1].cfg.startDate)
  check('데이터가 짧으면 생성 안 함', buildStartVariants(defaultConfig('golden-cross'), dates.slice(0, 100)).length === 0)
}

section('4) 판정 — 기준부터 알파가 음수면 bad')
{
  const rows = [
    { label: '기준 설정', axis: '기준' as const, totalReturnPct: 5, benchReturnPct: 40, cagrPct: 2, alphaPct: -12, mddPct: -20, sharpe: 0.1, trades: 10 },
  ]
  // runRobustness는 실행까지 하므로, 여기서는 판정 로직을 실제 실행으로 확인한다.
  void rows
  const hists: Record<string, HistoryResult> = { A: mkHist('A', walk(1, N)), B: mkHist('B', walk(2, N)) }
  const cfg = { ...defaultConfig('golden-cross'), symbols: ['A', 'B'], startDate: '' }
  const rep = runRobustness('golden-cross', buildVariants('golden-cross', cfg), hists)
  check('행 수 = 변형 수', rep.rows.length === buildVariants('golden-cross', cfg).length)
  check('기준 알파 산출됨', rep.baseAlphaPct != null)
  check('판정 문구 존재', rep.verdict.length > 10)
  check('판정 레벨 유효', ['good', 'watch', 'bad', 'early'].includes(rep.verdictLevel))
  if ((rep.baseAlphaPct ?? 0) <= 0) {
    check('기준 알파 음수 → bad 판정', rep.verdictLevel === 'bad', `${rep.baseAlphaPct?.toFixed(1)} | ${rep.verdictLevel}`)
    check('문구가 원인을 명시', rep.verdict.includes('기준 설정부터'))
  }
}

section('5) 알파는 벤치마크 대비로 계산된다 (장세 보정)')
{
  // 전 종목이 똑같이 오르는 시장 — 무엇을 골라도 벤치마크와 같아 알파 ≈ 0
  const same = walk(7, N, 0.0008, 0.015)
  const hists: Record<string, HistoryResult> = { A: mkHist('A', same), B: mkHist('B', [...same]), C: mkHist('C', [...same]) }
  const cfg = { ...defaultConfig('golden-cross'), symbols: ['A', 'B', 'C'], startDate: '' }
  const rep = runRobustness('golden-cross', buildVariants('golden-cross', cfg), hists)
  const ok = rep.rows.filter((r) => !r.error)
  check('동일 종목 시장에서 알파가 크지 않음', ok.every((r) => Math.abs(r.alphaPct) < 30), ok.map((r) => r.alphaPct.toFixed(0)).join(','))
  check('장세만으로 good 판정 나지 않음', rep.verdictLevel !== 'good' || rep.medianAlphaPct > 0)
}

section('6) 비용 민감도가 판정에 반영된다')
{
  const hists: Record<string, HistoryResult> = { A: mkHist('A', walk(11, N)), B: mkHist('B', walk(12, N)), C: mkHist('C', walk(13, N)) }
  const cfg = { ...defaultConfig('golden-cross'), symbols: ['A', 'B', 'C'], startDate: '' }
  const rep = runRobustness('golden-cross', buildVariants('golden-cross', cfg), hists)
  const costRows = rep.rows.filter((r) => r.axis === '비용')
  check('비용 축 결과 2건', costRows.length === 2)
  check('costSurvives는 비용 축 전부 양수일 때만 true',
    rep.costSurvives === (costRows.length > 0 && costRows.every((r) => r.alphaPct > 0)))
  check('costSurvives=false면 good 아님', rep.costSurvives || rep.verdictLevel !== 'good')
}

section('7) 결정성 — 같은 입력이면 같은 결과')
{
  const hists: Record<string, HistoryResult> = { A: mkHist('A', walk(21, N)), B: mkHist('B', walk(22, N)) }
  const cfg = { ...defaultConfig('golden-cross'), symbols: ['A', 'B'], startDate: '' }
  const a = runRobustness('golden-cross', buildVariants('golden-cross', cfg), hists)
  const b = runRobustness('golden-cross', buildVariants('golden-cross', cfg), hists)
  check('두 번 실행 결과 동일', JSON.stringify(a) === JSON.stringify(b))
}

section('8) 실행 실패한 변형이 전체를 무너뜨리지 않는다')
{
  const hists: Record<string, HistoryResult> = { A: mkHist('A', walk(31, 200)) } // 짧은 데이터 → 일부 변형 실패 가능
  const cfg = { ...defaultConfig('golden-cross'), symbols: ['A'], startDate: '' }
  let threw = false
  try {
    const rep = runRobustness('golden-cross', buildVariants('golden-cross', cfg), hists)
    check('실패해도 행은 반환됨', rep.rows.length > 0)
    check('판정 문구 존재', rep.verdict.length > 0)
  } catch {
    threw = true
  }
  check('예외가 전파되지 않음', !threw)
}

finish()
