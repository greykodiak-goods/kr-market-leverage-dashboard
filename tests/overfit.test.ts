// 과최적화 측정 도구(src/features/backtest/overfit.ts) 검증.
//
// 이 도구들은 "찾은 것이 우연일 확률"을 말하는 계기판이다. 계기판이 거짓말하면
// 원본 백테스트가 거짓말하는 것보다 나쁘다 — 그래서 **알려진 성질**로만 검증한다.
// 구현식을 그대로 베껴 기대값을 만들면 아무것도 검증하지 못하므로, 기대값은
//   · 해석적으로 아는 값(Φ(0)=0.5, Φ(1.96)≈0.975)
//   · 단조성(시도 N↑ → DSR↓)
//   · 자기검증용 합성 데이터의 이론적 귀결(무신호 → PBO≈0.5, 지속적 우열 → PBO 낮음)
//   · 구조적 불변식(OOS 구간에 IS 인덱스가 섞이지 않는다)
// 로 세운다.
//
// 🚫 규칙 1: 여기서 검증하는 것은 **확정된 수익률 계열의 사후 채점**이다. 다만
//    워크포워드만은 구조가 인과적이어야 하므로, (a) 인덱스 경계 불겹침 (b) OOS 구간
//    데이터를 극단값으로 바꿔도 **선택이 불변**임을 단언한다 — 선택이 바뀌면 그것이 곧
//    미래참조다.
//
// 결정론: Math.random 금지. 합성 데이터는 harness의 시드 난수(rng)로만 만든다.

import { check, close, eq, finish, rng, section } from './harness'
import {
  DSR_MIN_OBSERVATIONS,
  DSR_PASS_THRESHOLD,
  EULER_MASCHERONI,
  PBO_WARN_THRESHOLD,
  annualizedPct,
  binomial,
  compound,
  computePbo,
  deflatedSharpe,
  deflatedSharpeFromReturns,
  expectedMaxSharpe,
  kurtosis,
  meanReturnMetric,
  median,
  multipleTestingReport,
  normalCdf,
  normalQuantile,
  overfitScorecard,
  probabilisticSharpe,
  sharpeMetric,
  sharpeMoments,
  skewness,
  stdev,
  unrankCombination,
  variance,
  walkForwardScore,
  walkForwardWindows,
} from '../src/features/backtest/overfit'
import { validateInput } from '../scripts/overfit-lab.entry'

// ── 합성 데이터 생성기 (전부 결정적) ────────────────────────────────────────

/** Box–Muller — 시드 난수 2개를 표준정규 1개로. */
function normalFrom(rand: () => number): number {
  const u1 = Math.max(1e-12, rand())
  const u2 = rand()
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
}

/**
 * 무신호 행렬 — 모든 변형이 평균 0·같은 분포의 독립 잡음.
 * 어떤 변형도 진짜 우위가 없으므로 IS 1위는 OOS에서 무작위 순위가 되어야 한다.
 */
function noiseMatrix(variants: number, obs: number, seed: number, sd = 0.01): number[][] {
  const rand = rng(seed)
  const out: number[][] = []
  for (let v = 0; v < variants; v++) {
    const row: number[] = []
    for (let t = 0; t < obs; t++) row.push(normalFrom(rand) * sd)
    out.push(row)
  }
  return out
}

/**
 * **지속적 우열**이 있는 행렬 — 변형 v의 기대수익이 v에 비례해 커진다(공통 드리프트 + 개별 엣지).
 *
 * ⚠️ 지시서 원문은 "모든 변형에 공통 드리프트"였는데, 공통 드리프트만 주면 변형 간 **서열**은
 *    여전히 순수 잡음이라 PBO는 0.5로 남는다(PBO는 절대 성과가 아니라 IS 1위의 OOS **순위**를
 *    재는 지표이기 때문이다). "실제 신호가 있다"를 PBO가 검출할 수 있는 형태로 옮기면
 *    **변형 간 지속적 성과 차이**가 된다 — 그래서 공통 드리프트에 개별 엣지를 더한다.
 */
function skillMatrix(variants: number, obs: number, seed: number, edge = 0.0016, sd = 0.01): number[][] {
  const rand = rng(seed)
  const out: number[][] = []
  for (let v = 0; v < variants; v++) {
    const drift = 0.0002 + edge * (v / Math.max(1, variants - 1)) // 공통 드리프트 + 변형별 엣지
    const row: number[] = []
    for (let t = 0; t < obs; t++) row.push(drift + normalFrom(rand) * sd)
    out.push(row)
  }
  return out
}

section('0. 정규분포 유틸 — 해석적으로 아는 값')
close('Φ(0) = 0.5', normalCdf(0), 0.5, 1e-12)
close('Φ(1.959963985) ≈ 0.975', normalCdf(1.959963984540054), 0.975, 1e-9)
close('Φ(-1.959963985) ≈ 0.025', normalCdf(-1.959963984540054), 0.025, 1e-9)
close('Φ(1.6448536) ≈ 0.95', normalCdf(1.6448536269514722), 0.95, 1e-9)
close('Z⁻¹(0.975) ≈ 1.95996', normalQuantile(0.975), 1.959963984540054, 1e-9)
close('Z⁻¹(0.5) = 0', normalQuantile(0.5), 0, 1e-12)
close('왕복 Z⁻¹(Φ(1.3)) = 1.3', normalQuantile(normalCdf(1.3)), 1.3, 1e-9)
close('왕복 Z⁻¹(Φ(-2.7)) = -2.7', normalQuantile(normalCdf(-2.7)), -2.7, 1e-9)
check('Φ는 단조증가', normalCdf(-1) < normalCdf(0) && normalCdf(0) < normalCdf(1))
close('오일러–마스케로니 상수', EULER_MASCHERONI, 0.5772156649015329, 1e-15)

section('0-1. 표본 통계')
close('표본 표준편차 n−1 — [1,2,3,4]', stdev([1, 2, 3, 4]), Math.sqrt(5 / 3), 1e-12)
close('분산 = 표준편차²', variance([1, 2, 3, 4]), 5 / 3, 1e-12)
close('대칭 표본의 왜도 = 0', skewness([-2, -1, 0, 1, 2]) ?? NaN, 0, 1e-12)
// 균등격자 [-2..2]의 비초과 첨도: m4/m2² = (2·16+2·1)/5 ÷ ((2·4+2·1)/5)² = 6.8/4 = 1.7
close('균등격자의 비초과 첨도 = 1.7', kurtosis([-2, -1, 0, 1, 2]) ?? NaN, 1.7, 1e-12)
eq('왜도는 관측 3개 미만이면 null', skewness([1, 2]), null)
eq('첨도는 관측 4개 미만이면 null', kurtosis([1, 2, 3]), null)
eq('중앙값(짝수 개)', median([4, 1, 3, 2]), 2.5)
eq('빈 배열 중앙값은 null', median([]), null)
close('compound([0.1,0.1]) = 0.21', compound([0.1, 0.1]), 0.21, 1e-12)
close('연환산 — 252기간에 1% 복리씩', annualizedPct(new Array(252).fill(0.0001), 252) ?? NaN, (Math.pow(1.0001, 252) - 1) * 100, 1e-9)
eq('전액 소실이면 연환산 null', annualizedPct([-1, 0.5], 252), null)

section('0-2. 조합 유틸 (결정적 샘플링의 기반)')
eq('C(16,8) = 12870', binomial(16, 8), 12870)
eq('C(10,0) = 1', binomial(10, 0), 1)
eq('C(10,11) = 0', binomial(10, 11), 0)
eq('C(30,15) = 155117520', binomial(30, 15), 155117520)
eq('사전식 첫 조합', JSON.stringify(unrankCombination(6, 3, 0)), JSON.stringify([0, 1, 2]))
eq('사전식 마지막 조합', JSON.stringify(unrankCombination(6, 3, binomial(6, 3) - 1)), JSON.stringify([3, 4, 5]))
{
  // 전수 복원이 서로 다른 조합 C(8,4)=70개를 정확히 만들어내는가
  const seen = new Set<string>()
  let sortedOk = true
  for (let r = 0; r < binomial(8, 4); r++) {
    const c = unrankCombination(8, 4, r)
    if (c.length !== 4) sortedOk = false
    for (let i = 1; i < c.length; i++) if (c[i] <= c[i - 1]) sortedOk = false
    seen.add(c.join(','))
  }
  eq('C(8,4) 전수 복원이 70개 서로 다른 조합', seen.size, 70)
  check('복원된 조합은 항상 오름차순 4개', sortedOk)
}

section('1. Deflated Sharpe — 시도 N이 늘면 단조 감소')
{
  const V = 0.0025 // 시도 샤프의 분산(기간당 샤프 기준, 표준편차 0.05)
  const base = { observedSharpe: 0.09, sampleLength: 1000, trialSharpeVariance: V, skew: -0.3, kurtosis: 5 }

  const trialsList = [2, 5, 20, 79, 400, 5000]
  const emaxes = trialsList.map((n) => expectedMaxSharpe(n, V) as number)
  let emaxMono = true
  for (let i = 1; i < emaxes.length; i++) if (!(emaxes[i] > emaxes[i - 1])) emaxMono = false
  check('E[max SR]은 시도 N이 늘수록 커진다', emaxMono, emaxes.map((x) => x.toFixed(4)).join(' → '))

  const dsrs = trialsList.map((n) => deflatedSharpe({ ...base, trials: n }).dsr as number)
  let dsrMono = true
  for (let i = 1; i < dsrs.length; i++) if (!(dsrs[i] < dsrs[i - 1])) dsrMono = false
  check(
    '① DSR은 시도 N이 늘수록 단조 감소',
    dsrMono,
    trialsList.map((n, i) => `N=${n}:${dsrs[i].toFixed(4)}`).join(' '),
  )
  check('DSR은 확률이므로 [0,1]', dsrs.every((d) => d >= 0 && d <= 1))
  check(
    '같은 샤프도 N=2면 유의, N=5000이면 비유의로 뒤집힌다',
    dsrs[0] >= DSR_PASS_THRESHOLD && dsrs[dsrs.length - 1] < DSR_PASS_THRESHOLD,
    `N=2:${dsrs[0].toFixed(3)} / N=5000:${dsrs[dsrs.length - 1].toFixed(3)}`,
  )

  eq('시도 N=1이면 E[max SR]=0 (선택편의 없음)', expectedMaxSharpe(1, V), 0)
  eq('시도 분산 V=0이면 E[max SR]=0', expectedMaxSharpe(100, 0), 0)
  close(
    'N=1의 DSR = PSR(0)',
    deflatedSharpe({ ...base, trials: 1 }).dsr ?? NaN,
    probabilisticSharpe(base.observedSharpe, 0, base.sampleLength, base.skew, base.kurtosis) ?? NaN,
    1e-12,
  )
  check('N=1 결과에는 선택편의 없음 메모가 붙는다', deflatedSharpe({ ...base, trials: 1 }).notes.some((s) => s.includes('선택편의')))

  const r = deflatedSharpe({ ...base, trials: 79 })
  close('excessOverExpectedMax = 관측샤프 − E[max SR]', r.excessOverExpectedMax ?? NaN, 0.09 - (r.expectedMaxSharpe as number), 1e-12)
  eq('passes는 임계 0.95 기준', r.passes, (r.dsr as number) >= DSR_PASS_THRESHOLD)
  check('근사 한계가 [미검증] 메모로 남는다', r.notes.some((s) => s.includes('[미검증]')))
}

section('1-1. PSR 성질')
{
  close('관측 샤프 = 기준이면 PSR = 0.5', probabilisticSharpe(0.05, 0.05, 500) ?? NaN, 0.5, 1e-12)
  const a = probabilisticSharpe(0.08, 0.05, 500) as number
  const b = probabilisticSharpe(0.08, 0.05, 2000) as number
  check('표본이 길수록 같은 우위가 더 유의해진다', b > a, `T=500:${a.toFixed(4)} T=2000:${b.toFixed(4)}`)
  const fat = probabilisticSharpe(0.08, 0.05, 500, 0, 12) as number
  check('첨도(꼬리)가 두꺼우면 PSR이 낮아진다', fat < a, `정규:${a.toFixed(4)} 첨도12:${fat.toFixed(4)}`)
  const neg = probabilisticSharpe(0.08, 0.05, 500, -1.5, 3) as number
  check('음의 왜도는 PSR을 낮춘다', neg < a, `왜도0:${a.toFixed(4)} 왜도-1.5:${neg.toFixed(4)}`)
}

section('2. PBO(CSCV) — 구조 검증 (전수 조합·블록 분할)')
{
  const structural = computePbo(noiseMatrix(20, 800, 20260803), { blocks: 16 })
  eq('전수 평가 — C(16,8)', structural.combinationsTotal, 12870)
  eq('전수 여부 플래그', structural.exhaustive, true)
  eq('평가한 조합 수 = 전체', structural.combinationsEvaluated, 12870)
  eq('블록 크기 = floor(800/16)', structural.blockSize, 50)
  eq('버린 관측 없음', structural.droppedObservations, 0)
  eq('λ 개수 = 평가한 조합 수', structural.lambdas.length, 12870)
  check('PBO는 [0,1]', (structural.pbo as number) >= 0 && (structural.pbo as number) <= 1)
  check('PBO = λ ≤ 0 비율과 일치', Math.abs((structural.pbo as number) - structural.lambdas.filter((l) => l <= 0).length / 12870) < 1e-12)
  eq('경고 플래그는 임계 0.5 기준', structural.overfitLikely, (structural.pbo as number) > PBO_WARN_THRESHOLD)

  // S로 나누어떨어지지 않는 길이 → 뒤에서 버리고 메모를 남긴다
  const ragged = computePbo(noiseMatrix(6, 805, 5), { blocks: 16 })
  eq('블록 크기 = floor(805/16)', ragged.blockSize, 50)
  eq('버린 관측 5개', ragged.droppedObservations, 5)
  check('버린 사실이 메모에 남는다', ragged.notes.some((s) => s.includes('버렸다')))
}

// ⚠️ 여기서부터가 이 도구의 **자기검증**이다.
//    "알파 0이면 PBO ≈ 0.5"는 **여러 독립 실현의 기대값**에서 성립하는 성질이지 한 번의
//    회차에서 보장되는 값이 아니다(한 벌의 데이터에서 실현된 서열이 IS·OOS 양쪽에 함께
//    들어가기 때문). 실제로 아래 40회 실현에서 개별 PBO는 0.09~0.89까지 퍼졌다.
//    그래서 단일 실행이 아니라 **실현 평균**으로 못 박는다 — 이것이 정직한 검증이다.
const MC_REPS = 40
section('2-1. ② 무신호(알파 0) 집합 — 실현 40회 평균 PBO ≈ 0.5')
let noiseMeanPbo = 0
{
  const vals: number[] = []
  for (let k = 0; k < MC_REPS; k++) {
    const r = computePbo(noiseMatrix(10, 480, 1000 + k * 37), { blocks: 8 })
    vals.push(r.pbo as number)
  }
  noiseMeanPbo = vals.reduce((a, b) => a + b, 0) / vals.length
  const lo = Math.min(...vals)
  const hi = Math.max(...vals)
  check(
    '② 알파 0인 변형 10개 × 40실현 → 평균 PBO ≈ 0.5',
    noiseMeanPbo >= 0.4 && noiseMeanPbo <= 0.6,
    `평균 ${noiseMeanPbo.toFixed(4)} (개별 ${lo.toFixed(3)}~${hi.toFixed(3)})`,
  )
  check(
    '단일 실현의 PBO는 크게 흔들린다 — 한 숫자로 결론짓지 말라는 근거',
    hi - lo > 0.3,
    `퍼짐 ${(hi - lo).toFixed(3)}`,
  )
  const meanOmega =
    vals.length === 0
      ? NaN
      : (() => {
          let s = 0
          for (let k = 0; k < MC_REPS; k++) {
            s += computePbo(noiseMatrix(10, 480, 1000 + k * 37), { blocks: 8 }).meanOosRank as number
          }
          return s / MC_REPS
        })()
  check(
    '무신호에서 IS 1위의 평균 OOS 상대순위도 0.5 근방',
    Math.abs(meanOmega - 0.5) < 0.1,
    `평균 ω=${meanOmega.toFixed(4)}`,
  )
}

section('2-2. ③ 변형 간 지속적 성과차가 있으면 PBO가 낮게 나온다')
{
  const vals: number[] = []
  for (let k = 0; k < 20; k++) {
    const r = computePbo(skillMatrix(10, 480, 2000 + k * 37, 0.003), { blocks: 8 })
    vals.push(r.pbo as number)
  }
  const m = vals.reduce((a, b) => a + b, 0) / vals.length
  const hi = Math.max(...vals)
  check(
    '③ 지속적 우열이 있는 합성 데이터 20실현 → 평균 PBO 낮음',
    m < 0.15,
    `평균 ${m.toFixed(4)} (최악 ${hi.toFixed(3)}) — 무신호 평균 ${noiseMeanPbo.toFixed(4)}`,
  )
  check('최악의 실현조차 0.35를 넘지 않는다', hi < 0.35, `최악 ${hi.toFixed(3)}`)
  check('무신호 평균보다 확실히 낮다', m < noiseMeanPbo - 0.25, `${m.toFixed(4)} vs ${noiseMeanPbo.toFixed(4)}`)

  // 큰 표본(20변형 × 1600관측, S=16 전수)에서도 같은 결론
  const big = computePbo(skillMatrix(20, 800, 424242, 0.003), { blocks: 16 })
  check('S=16 전수 실행에서도 PBO 낮음', (big.pbo as number) < 0.2, `PBO=${(big.pbo as number).toFixed(4)}`)
  check('λ 중앙값이 양수 = 전형적 조합에서도 OOS 순위 유지', (big.medianLambda as number) > 0)
  eq('경고 플래그 없음', big.overfitLikely, false)
}

section('2-3. ⑤ PBO — 표본 부족·입력 이상은 null + 사유')
{
  const tooShort = computePbo(noiseMatrix(10, 20, 1), { blocks: 16 })
  eq('블록당 2개 미만이면 pbo=null', tooShort.pbo, null)
  check('사유에 표본 부족이 적힌다', (tooShort.reason ?? '').includes('표본 부족'), tooShort.reason ?? '')

  const oneVariant = computePbo(noiseMatrix(1, 800, 2))
  eq('변형 1개면 pbo=null', oneVariant.pbo, null)
  check('사유에 변형 수가 적힌다', (oneVariant.reason ?? '').includes('변형'), oneVariant.reason ?? '')

  const oddBlocks = computePbo(noiseMatrix(10, 800, 3), { blocks: 15 })
  eq('홀수 블록이면 pbo=null', oddBlocks.pbo, null)

  const ragged = computePbo([[0.1, 0.2, 0.3], [0.1, 0.2]])
  eq('행 길이가 다르면 pbo=null', ragged.pbo, null)
  check('사유에 길이 불일치가 적힌다', (ragged.reason ?? '').includes('길이'), ragged.reason ?? '')

  // 상수 수익률(표준편차 0) → 샤프 계산 불가 → 전 조합 스킵 → null + 사유.
  // ⚠️ 이 케이스는 실제로 버그를 잡았다: 부동소수 누적오차 때문에 상수 계열의 표준편차가
  //    정확히 0이 아니라 1e-19가 되어 샤프가 1.5e15로 튀었다(= 가짜 초대박 전략).
  //    `DEGENERATE_SD_RATIO` 상대 판정으로 막았다.
  const flat = computePbo([new Array(800).fill(0.001), new Array(800).fill(0.002)], { blocks: 16 })
  eq('변동성 0이면 샤프 서열화 불가 → null', flat.pbo, null)
  check('사유가 비어 있지 않다', (flat.reason ?? '').length > 0, flat.reason ?? '')
  // 같은 데이터라도 평균수익 지표로는 서열화된다(지표 플러그 동작 확인)
  const flatMean = computePbo([new Array(800).fill(0.001), new Array(800).fill(0.002)], {
    blocks: 16,
    metric: meanReturnMetric,
  })
  eq('평균수익 지표로 바꾸면 계산된다 — 항상 2번이 이기므로 PBO=0', flatMean.pbo, 0)
}

section('2-4. PBO — 조합 상한 초과 시 결정적 등간격 샘플링(무작위 금지)')
{
  const m = noiseMatrix(8, 1000, 55)
  const capped = computePbo(m, { blocks: 20, maxCombinations: 500 })
  eq('C(20,10) = 184756', capped.combinationsTotal, 184756)
  eq('상한만큼만 평가', capped.combinationsEvaluated, 500)
  eq('전수 아님', capped.exhaustive, false)
  check('샘플링 사실이 메모로 남는다', capped.notes.some((s) => s.includes('등간격')))
  const again = computePbo(noiseMatrix(8, 1000, 55), { blocks: 20, maxCombinations: 500 })
  eq('같은 입력 → 같은 PBO (결정적 샘플링)', capped.pbo, again.pbo)
  eq('λ 배열도 완전히 동일', JSON.stringify(capped.lambdas), JSON.stringify(again.lambdas))
}

section('3. 워크포워드 — IS/OOS 인덱스 경계 (미래참조 차단)')
{
  const windows = walkForwardWindows(1000, 400, 100)
  eq('창 개수 = floor((1000−400−100)/100)+1', windows.length, 6)
  let boundaryOk = true
  let ordered = true
  for (let i = 0; i < windows.length; i++) {
    const w = windows[i]
    if (w.oosFrom !== w.isTo) boundaryOk = false
    if (!(w.isFrom < w.isTo && w.isTo <= w.oosFrom && w.oosFrom < w.oosTo)) boundaryOk = false
    if (w.isTo - w.isFrom !== 400 || w.oosTo - w.oosFrom !== 100) boundaryOk = false
    if (i > 0 && !(windows[i].oosFrom >= windows[i - 1].oosTo)) ordered = false
  }
  check('④ OOS는 IS 바로 뒤에서 시작하고 겹치지 않는다', boundaryOk)
  check('OOS 조각들은 시간 순으로 겹치지 않는다', ordered)
  check('마지막 창이 데이터 끝을 넘지 않는다', windows[windows.length - 1].oosTo <= 1000)
}

let wf: ReturnType<typeof walkForwardScore>
{
  const m = skillMatrix(12, 1200, 9090)
  const bench = m[0].map((_, t) => 0.0003 + (m[0][t] - 0.0002) * 0.4)
  wf = walkForwardScore(m, { isWindow: 400, oosWindow: 100, benchmark: bench })
  eq('구간 수', wf.segments.length, 8)
  let segOk = true
  const covered = new Set<number>()
  for (const s of wf.segments) {
    if (s.oosFrom !== s.isTo) segOk = false
    if (s.isFrom >= s.isTo || s.oosFrom >= s.oosTo) segOk = false
    for (let t = s.oosFrom; t < s.oosTo; t++) {
      if (covered.has(t)) segOk = false // OOS 구간이 서로 겹치면 성적을 두 번 세는 것
      covered.add(t)
    }
    // IS 인덱스가 OOS 인덱스와 섞이지 않는다
    for (let t = s.isFrom; t < s.isTo; t++) if (t >= s.oosFrom) segOk = false
  }
  check('④ 세그먼트 경계 단언 — IS·OOS 불겹침 + OOS 중복 없음', segOk)
  eq('이어 붙인 OOS 길이 = 구간수 × OOS창', wf.oosReturns.length, 8 * 100)
  eq('OOS 자산곡선 길이 = 수익률+1', wf.oosEquity.length, wf.oosReturns.length + 1)
  eq('자산곡선은 1에서 시작', wf.oosEquity[0], 1)
  check('OOS 알파가 계산된다(규칙 5)', wf.oosAlphaPct !== null, `알파 ${(wf.oosAlphaPct ?? NaN).toFixed(2)}%p`)
  close(
    '알파 = OOS 연환산 − 벤치 연환산',
    wf.oosAlphaPct ?? NaN,
    (wf.oosAnnualizedPct as number) - (wf.benchAnnualizedPct as number),
    1e-12,
  )
  check('IS 대비 성능 저하율이 계산된다', wf.degradationPct !== null, `저하 ${(wf.degradationPct ?? NaN).toFixed(1)}%`)
}

section('3-1. 워크포워드 — OOS 데이터를 바꿔도 선택은 불변 (누수 없음)')
{
  const base = skillMatrix(12, 1200, 9090)
  const tampered = base.map((row) => row.slice())
  // 첫 구간의 OOS 이후 전 구간을 극단값으로 오염시킨다. 각 구간의 선택은 자기 IS만
  // 보므로, **첫 구간의 선택**은 절대 바뀌면 안 된다(바뀌면 미래를 본 것).
  for (let v = 0; v < tampered.length; v++) {
    for (let t = 400; t < 1200; t++) tampered[v][t] = v === tampered.length - 1 ? -0.5 : 0.5
  }
  const tamperedWf = walkForwardScore(tampered, { isWindow: 400, oosWindow: 100 })
  eq(
    '첫 구간(IS=[0,400))의 선택이 OOS 오염에 영향받지 않는다',
    tamperedWf.segments[0].selectedVariant,
    wf.segments[0].selectedVariant,
  )
  close('첫 구간의 IS 성과도 동일', tamperedWf.segments[0].isMetric, wf.segments[0].isMetric, 1e-12)
  check(
    '반대로 OOS 성적은 오염을 반영한다(테스트가 실제로 데이터를 바꿨음을 확인)',
    tamperedWf.segments[0].oosMetric !== wf.segments[0].oosMetric,
  )

  // IS 구간을 바꾸면 선택은 바뀔 수 있어야 한다 — 선택이 IS를 실제로 읽고 있다는 반대 방향 확인
  const isTampered = base.map((row) => row.slice())
  // 0번 변형을 IS 구간에서만 압도적으로 좋게 만든다(변동성은 남겨야 샤프가 정의된다).
  for (let t = 0; t < 400; t++) isTampered[0][t] = 0.05 + base[0][t]
  const isWf = walkForwardScore(isTampered, { isWindow: 400, oosWindow: 100 })
  eq('IS를 바꾸면 첫 구간 선택이 그 변형으로 바뀐다', isWf.segments[0].selectedVariant, 0)
}

section('3-2. 워크포워드 — 표본 부족·입력 이상은 null + 사유')
{
  const short = walkForwardScore(noiseMatrix(5, 50, 11), { isWindow: 400, oosWindow: 100 })
  eq('창을 하나도 못 만들면 결과 null', short.oosAnnualizedPct, null)
  check('사유에 표본 부족이 적힌다', (short.reason ?? '').includes('표본 부족'), short.reason ?? '')
  eq('세그먼트도 비어 있다', short.segments.length, 0)

  const badBench = walkForwardScore(noiseMatrix(5, 1000, 12), { isWindow: 400, oosWindow: 100, benchmark: [0.1] })
  check('벤치마크 길이 불일치는 사유와 함께 실패', (badBench.reason ?? '').includes('벤치마크'), badBench.reason ?? '')

  const noBench = walkForwardScore(noiseMatrix(5, 1000, 13), { isWindow: 400, oosWindow: 100 })
  eq('벤치마크가 없으면 알파는 null(0으로 채우지 않는다)', noBench.oosAlphaPct, null)
  check('그 사실이 메모에 남는다', noBench.notes.some((s) => s.includes('벤치마크 미제공')))

  const zeroWin = walkForwardScore(noiseMatrix(5, 1000, 14), { isWindow: 0, oosWindow: 100 })
  check('창 길이 0은 사유와 함께 실패', (zeroWin.reason ?? '').includes('창 길이'), zeroWin.reason ?? '')
}

section('4. 다중검정 보정 — 이번 회차 N vs 누적 N')
{
  const rep = multipleTestingReport({
    observedSharpe: 0.085,
    sampleLength: 1200,
    trialSharpeVariance: 0.0025,
    skew: -0.4,
    kurtosis: 6,
    trialsThisRound: 14,
    trialsCumulative: 79,
  })
  check('두 DSR이 모두 계산된다', rep.thisRound.dsr !== null && rep.cumulative.dsr !== null)
  check(
    '누적 N이 더 크므로 누적 DSR ≤ 이번 회차 DSR',
    (rep.cumulative.dsr as number) <= (rep.thisRound.dsr as number),
    `회차 ${(rep.thisRound.dsr as number).toFixed(4)} → 누적 ${(rep.cumulative.dsr as number).toFixed(4)}`,
  )
  check('보정 전 p값이 나온다', rep.rawPValue !== null && (rep.rawPValue as number) >= 0)
  check(
    'Bonferroni ≥ Šidák ≥ 원본 p (보수성 순서)',
    (rep.bonferroniPValue as number) >= (rep.sidakPValue as number) - 1e-12 &&
      (rep.sidakPValue as number) >= (rep.rawPValue as number) - 1e-12,
    `raw ${(rep.rawPValue as number).toExponential(3)} / šidák ${(rep.sidakPValue as number).toExponential(3)} / bonf ${(rep.bonferroniPValue as number).toExponential(3)}`,
  )
  eq('판정은 누적 DSR 기준', rep.verdict, (rep.cumulative.dsr as number) >= DSR_PASS_THRESHOLD ? 'pass' : 'fail')
  check('헤드라인에 누적 시도 수가 들어간다', rep.headline.includes('79'), rep.headline)

  const weak = multipleTestingReport({
    observedSharpe: 0.02,
    sampleLength: 300,
    trialSharpeVariance: 0.01,
    trialsThisRound: 5,
    trialsCumulative: 400,
  })
  eq('약한 성적 + 큰 누적 N → 불합격', weak.verdict, 'fail')

  const tooShort = multipleTestingReport({
    observedSharpe: 0.2,
    sampleLength: 10,
    trialSharpeVariance: 0.0025,
    trialsThisRound: 3,
    trialsCumulative: 79,
  })
  eq('⑤ 표본 부족이면 판정 불가(0·1로 채우지 않는다)', tooShort.verdict, 'unknown')
  eq('DSR은 null', tooShort.cumulative.dsr, null)
  check(
    '사유에 최소 관측 수가 적힌다',
    (tooShort.cumulative.reason ?? '').includes(String(DSR_MIN_OBSERVATIONS)),
    tooShort.cumulative.reason ?? '',
  )
}

section('4-1. 수익률 계열에서 바로 DSR')
{
  const rand = rng(31337)
  const rets: number[] = []
  for (let t = 0; t < 1000; t++) rets.push(0.0006 + normalFrom(rand) * 0.01)
  const moments = sharpeMoments(rets)
  check('샤프·왜도·첨도가 모두 나온다', moments.sharpe !== null && moments.skew !== null && moments.kurtosis !== null)
  eq('사유 없음', moments.reason, null)

  const trialSharpes = [0.02, 0.04, -0.01, 0.06, 0.03, 0.05, 0.0, 0.07]
  const d = deflatedSharpeFromReturns(rets, trialSharpes)
  check('DSR이 계산된다', d.dsr !== null, `DSR=${(d.dsr ?? NaN).toFixed(4)}`)
  eq('시도 수 기본값 = 시도 샤프 개수', d.input.trials, 8)
  close('시도 분산 = 표본분산', d.input.trialSharpeVariance, variance(trialSharpes), 1e-12)
  const d79 = deflatedSharpeFromReturns(rets, trialSharpes, 79)
  check(
    '누적 79회를 명시하면 DSR이 낮아진다',
    (d79.dsr as number) < (d.dsr as number),
    `N=8:${(d.dsr as number).toFixed(4)} → N=79:${(d79.dsr as number).toFixed(4)}`,
  )

  // 상수 계열 — 이론상 표준편차 0이지만 부동소수 잔차가 남는다. 그것을 나눠
  // 1e15짜리 샤프를 만들면 안 된다(DEGENERATE_SD_RATIO가 막는다).
  const constant = new Array(100).fill(0.001)
  check('상수 계열의 표준편차는 정확히 0이 아니다(부동소수 잔차)', stdev(constant) !== 0, `sd=${stdev(constant)}`)
  const flat = sharpeMoments(constant)
  eq('그래도 샤프는 null', flat.sharpe, null)
  check('사유가 함께 온다', (flat.reason ?? '').includes('표준편차'), flat.reason ?? '')
  eq('그 경우 DSR도 null', deflatedSharpeFromReturns(constant, trialSharpes).dsr, null)
  check('사유가 전달된다', (deflatedSharpeFromReturns(constant, trialSharpes).reason ?? '').length > 0)
}

section('5. 통합 채점 — 무신호 회차는 경고, 신호 있는 회차는 통과')
{
  const bench = new Array(1000).fill(0.0002)
  const cardNoise = overfitScorecard({
    matrix: noiseMatrix(20, 1000, 20260803),
    benchmark: bench,
    trialsCumulative: 79,
    pbo: { blocks: 8 },
    walkForward: { isWindow: 500, oosWindow: 100 },
  })
  check('승자가 정해진다', cardNoise.winner !== null)
  eq('사유 없음', cardNoise.reason, null)
  check('무신호 회차는 경고가 뜬다', cardNoise.headline.includes('과최적화 경고'), cardNoise.headline)
  eq('누적 79회 기준 DSR 판정은 불합격', cardNoise.multipleTesting?.verdict, 'fail')
  eq('누적 시도 수가 반영된다', cardNoise.multipleTesting?.trialsCumulative, 79)
  eq('이번 회차 시도 수 = 변형 수', cardNoise.multipleTesting?.trialsThisRound, 20)

  const cardSkill = overfitScorecard({
    matrix: skillMatrix(20, 1000, 424242, 0.003),
    benchmark: bench,
    trialsCumulative: 79,
    pbo: { blocks: 8 },
    walkForward: { isWindow: 500, oosWindow: 100 },
  })
  eq('신호 있는 회차는 PBO 경고 없음', cardSkill.pbo.overfitLikely, false)
  check(
    '신호 있는 회차의 워크포워드 OOS 알파는 양수',
    (cardSkill.walkForward.oosAlphaPct as number) > 0,
    `알파 ${(cardSkill.walkForward.oosAlphaPct ?? NaN).toFixed(2)}%p`,
  )
  check('무신호 채점표와는 다른 결론', cardSkill.headline !== cardNoise.headline, cardSkill.headline)
}

section('6. 결정론 — 같은 입력 두 번 호출하면 완전히 같은 출력')
{
  const m = noiseMatrix(12, 1200, 606)
  const a = computePbo(m, { blocks: 8 })
  const b = computePbo(m, { blocks: 8 })
  eq('PBO 결과 전체가 동일', JSON.stringify(a), JSON.stringify(b))

  const w1 = walkForwardScore(m, { isWindow: 400, oosWindow: 100 })
  const w2 = walkForwardScore(m, { isWindow: 400, oosWindow: 100 })
  eq('워크포워드 결과 전체가 동일', JSON.stringify(w1), JSON.stringify(w2))

  const in1 = { observedSharpe: 0.07, sampleLength: 900, trialSharpeVariance: 0.003, trials: 79 }
  eq('DSR 결과 전체가 동일', JSON.stringify(deflatedSharpe(in1)), JSON.stringify(deflatedSharpe(in1)))

  const c1 = overfitScorecard({ matrix: m, trialsCumulative: 79, pbo: { blocks: 8 } })
  const c2 = overfitScorecard({ matrix: m, trialsCumulative: 79, pbo: { blocks: 8 } })
  eq('통합 채점표 전체가 동일', JSON.stringify(c1), JSON.stringify(c2))

  // 서로 다른 두 배열이 같은 값을 담고 있으면 결과도 같아야 한다(참조 의존 없음)
  const copy = m.map((r) => r.slice())
  eq('배열 사본으로 호출해도 동일', JSON.stringify(computePbo(copy, { blocks: 8 })), JSON.stringify(a))
}

section('7. 지표 플러그')
{
  eq('샤프 지표 — 관측 2개 미만이면 null', sharpeMetric([0.01]), null)
  eq('샤프 지표 — 변동성 0이면 null', sharpeMetric([0.01, 0.01, 0.01]), null)
  close('샤프 지표 = 평균/표준편차', sharpeMetric([0.01, -0.01, 0.02]) ?? NaN, (0.02 / 3) / stdev([0.01, -0.01, 0.02]), 1e-12)
  eq('평균수익 지표 — 빈 배열이면 null', meanReturnMetric([]), null)
}

// ============================================================================
// 8. 러너 입력 인터페이스 — 규약 위반은 조용히 넘어가지 않고 던진다(규칙 4)
// ============================================================================
//
// 후속 작업이 회차 러너에서 이 형태로 JSON을 뱉으면 바로 물린다. 규약이 문서에만
// 있으면 다음 세션이 어긴다 — 그래서 검증 함수를 테스트로 못 박는다.

section('8. overfit-lab 입력 검증')
{
  const good = {
    round: 'T',
    trialsCumulative: 79,
    variants: [
      { name: 'A', returns: new Array(40).fill(0).map((_, i) => (i % 3 === 0 ? 0.01 : -0.005)) },
      { name: 'B', returns: new Array(40).fill(0).map((_, i) => (i % 2 === 0 ? 0.02 : -0.01)) },
    ],
  }
  const parsed = validateInput(good)
  eq('정상 입력이 통과한다', parsed.variants.length, 2)
  eq('누적 시도 수가 실린다', parsed.trialsCumulative, 79)

  const throws = (name: string, raw: unknown, fragment: string) => {
    let msg = ''
    try {
      validateInput(raw)
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e)
    }
    check(name, msg.includes(fragment), `메시지="${msg}" (기대 조각 "${fragment}")`)
  }
  throws('객체가 아니면 던진다', 42, '객체')
  throws('variants가 없으면 던진다', {}, 'variants')
  throws('변형 1개면 던진다', { variants: [good.variants[0]] }, 'PBO')
  throws(
    '변형별 길이가 다르면 던진다',
    { variants: [good.variants[0], { name: 'B', returns: new Array(39).fill(0.01) }] },
    '길이가 다르다',
  )
  throws(
    'null·문자열이 섞이면 던진다(미보유 구간은 0으로 채울 것)',
    {
      variants: [
        good.variants[0],
        { name: 'B', returns: [...new Array(39).fill(0.01), null] },
      ],
    },
    '유한한 수가 아니다',
  )
  throws(
    '시점 30개 미만이면 던진다',
    { variants: [{ name: 'A', returns: new Array(10).fill(0.01) }, { name: 'B', returns: new Array(10).fill(0.02) }] },
    '너무 짧다',
  )
  throws('벤치마크 길이가 다르면 던진다', { ...good, benchmark: [0.001] }, 'benchmark')
  throws('dates 길이가 다르면 던진다', { ...good, dates: ['2020-01-02'] }, 'dates')
}

finish()
