// 구간분할 검증 로직 — 알려진 곡선으로 수치를 고정한다.
import { check, close, finish, section } from './harness'
import { buildWalkForward, MIN_FOLD_DAYS } from '../src/features/backtest/walkforward'
import type { EquityPoint } from '../src/features/backtest/types'

const mkDate = (i: number) => new Date(Date.UTC(2015, 0, 1) + i * 86400000).toISOString().slice(0, 10)

function curve(n: number, stratPerDay: number, benchPerDay: number): EquityPoint[] {
  const out: EquityPoint[] = []
  let e = 1000
  let b = 1000
  for (let i = 0; i < n; i++) {
    out.push({ date: mkDate(i), equity: e, benchmark: b, drawdownPct: 0 })
    e *= 1 + stratPerDay
    b *= 1 + benchPerDay
  }
  return out
}

section('1) 구간 분할 기본')
{
  const eq = curve(1200, 0.0006, 0.0003) // 전략이 매일 벤치보다 우위
  const wf = buildWalkForward(eq, 6)
  check('구간 6개 생성', wf.folds.length === 6)
  check('구간이 연속·비중첩', wf.folds.every((f, i) => i === 0 || f.from > wf.folds[i - 1].to))
  check('첫 구간 시작 = 곡선 시작', wf.folds[0].from === eq[0].date)
  check('마지막 구간 끝 = 곡선 끝', wf.folds[5].to === eq[eq.length - 1].date)
  check('전 구간 알파 양수', wf.folds.every((f) => f.alphaPct > 0))
  check('일관성 6/6', wf.consistency === '6/6')
  check('판정 = 재현성 있음', wf.verdictLevel === 'good', wf.verdict)
}

section('2) 특정 구간만 대박인 경우 — 걸러내야 한다')
{
  // 5개 구간은 벤치와 동일, 1개 구간만 폭등
  const n = 1200
  const out: EquityPoint[] = []
  let e = 1000
  let b = 1000
  for (let i = 0; i < n; i++) {
    out.push({ date: mkDate(i), equity: e, benchmark: b, drawdownPct: 0 })
    const inHot = i >= 400 && i < 600
    e *= 1 + (inHot ? 0.01 : 0.0003)
    b *= 1.0003
  }
  const wf = buildWalkForward(out, 6)
  check('소수 구간만 알파 양수', wf.positiveAlphaFolds <= 2, `${wf.consistency}`)
  check('판정 = 특정 구간 의존', wf.verdictLevel === 'bad', wf.verdict + ' | ' + wf.consistency)
  check('최고-최악 편차 큼', wf.bestAlphaPct - wf.worstAlphaPct > 50)
}

section('3) 전략=벤치마크(알파 0)는 good 아님')
{
  const eq = curve(1200, 0.0005, 0.0005)
  const wf = buildWalkForward(eq, 6)
  check('알파 ≈ 0', wf.folds.every((f) => Math.abs(f.alphaPct) < 0.01))
  check('판정 good 아님', wf.verdictLevel !== 'good', wf.verdictLevel)
}

section('4) 표본 부족 시 판단 유보')
{
  const eq = curve(100, 0.001, 0.0005)
  const wf = buildWalkForward(eq, 6) // 구간당 16일
  check('구간당 최소일수 미달 → early', wf.verdictLevel === 'early', wf.verdict)
  check('구간 없음', wf.folds.length === 0)
  check(`MIN_FOLD_DAYS=${MIN_FOLD_DAYS} 상수 노출`, MIN_FOLD_DAYS === 60)
}

section('5) 알파 = 연환산 초과수익 (수치 고정)')
{
  // 252일 = 1년. 전략 +20%, 벤치 +10% → 알파 ≈ 10%p
  const out: EquityPoint[] = []
  for (let i = 0; i < 504; i++) {
    const f = i / 252
    out.push({ date: mkDate(i), equity: 1000 * Math.pow(1.2, f), benchmark: 1000 * Math.pow(1.1, f), drawdownPct: 0 })
  }
  const wf = buildWalkForward(out, 2)
  check('2구간 생성', wf.folds.length === 2)
  close('구간1 알파 ≈ 10%p', wf.folds[0].alphaPct, 10, 0.6)
}

section('6) MDD는 구간 내부 고점 기준')
{
  const out: EquityPoint[] = []
  for (let i = 0; i < 600; i++) {
    // 구간2(300~599)에서만 20% 하락
    const v = i < 300 ? 1000 : i < 450 ? 1000 : 800
    out.push({ date: mkDate(i), equity: v, benchmark: 1000, drawdownPct: 0 })
  }
  const wf = buildWalkForward(out, 2)
  close('구간1 MDD 0%', wf.folds[0].mddPct, 0)
  close('구간2 MDD -20%', wf.folds[1].mddPct, -20)
}

section('7) 결정성')
{
  const eq = curve(1200, 0.0006, 0.0003)
  check('재실행 동일', JSON.stringify(buildWalkForward(eq, 6)) === JSON.stringify(buildWalkForward(eq, 6)))
}

finish()
