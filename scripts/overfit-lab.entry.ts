// 과최적화 랩 — 이미 돌린 회차의 **변형별 수익률 계열**을 받아 DSR·PBO·워크포워드로 채점한다.
//
// 왜 있나: 이 리포는 KRX 실측 유니버스에서 누적 79변형(33~36차)을 돌렸고 "판정 통과"를 센
// 것이 전부였다. 23차의 400조합 격자 1위가 33차에서 알파 −9.6%p로 무너진 전례가 말해주듯,
// **시도 횟수를 분모에 넣지 않은 성적은 성적이 아니다.** 이 러너는 회차 산출물을 받아
// "찾은 것이 우연일 확률"을 표로 찍는다. 계산은 전부 `src/features/backtest/overfit.ts`
// (순수 함수)가 하고, 여기서는 입력 읽기·검증·표 출력만 한다.
//
// ── 실행 ─────────────────────────────────────────────────────────────────────
//   MODE=overfit  node scripts/overfit-lab.mjs          (GHA: overfit:overfit)
//   MODE=selftest node scripts/overfit-lab.mjs          (합성 데이터 자기검증만)
//
//   실데이터를 채점하려면 입력 파일 경로를 환경변수로 준다:
//     OVERFIT_INPUT=public/data/rounds/36차.json MODE=overfit node scripts/overfit-lab.mjs
//
//   ⚠️ `OVERFIT_INPUT`이 없으면 **합성 데이터 자기검증만** 하고 결과에
//      `[미검증-실데이터]`를 명시한다. 합성 수치를 회차 성적인 양 쓰지 않는다(규칙 3).
//
// ── 🔌 입력 인터페이스 (후속 작업이 회차 러너에서 이 형태로 뱉으면 바로 물린다) ────
//
//   JSON 한 덩어리. **수익률(기간 수익률)** 계열이지 자산곡선 레벨이 아니다 —
//   레벨을 잘라 붙이면 블록 경계에서 거짓 수익이 생긴다.
//
//   {
//     "round": "36차 단기매매 랩",          // 표시용 라벨 (선택)
//     "periodsPerYear": 252,                 // 연환산 계수 (선택, 기본 252)
//     "trialsCumulative": 79,                // 누적 시도 수 — **진짜 분모** (선택, 기본 = 변형 수)
//     "dates": ["2020-01-02", ...],          // 표시용 (선택). 있으면 길이가 수익률과 같아야 한다
//     "benchmark": [0.0012, -0.0007, ...],   // 벤치마크 기간수익률 (선택, 있으면 OOS 알파 산출)
//     "isWindow": 500,                       // 워크포워드 IS 창 (선택, 기본 = 시점의 50%)
//     "oosWindow": 100,                      // 워크포워드 OOS 창 = 스텝 (선택, 기본 = 시점의 10%)
//     "blocks": 16,                          // PBO 블록 수 S (선택, 기본 16 → C(16,8)=12,870조합)
//     "variants": [
//       { "name": "종가매수-A", "returns": [0.001, -0.002, ...] },
//       { "name": "종가매수-B", "returns": [ ... ] }
//     ]
//   }
//
//   규약:
//     · 모든 변형의 `returns` 길이가 같아야 한다(같은 달력 위에 정렬돼 있어야 한다).
//     · 미보유 구간은 0으로 채운다(빈칸·null 금지 — 길이가 어긋나면 시점이 밀린다).
//     · `benchmark`·`dates`를 주면 길이가 `returns`와 같아야 한다.
//     · 변형은 2개 이상. 1개면 PBO가 정의되지 않는다.
//     · `trialsCumulative`는 **이번 회차 변형 수가 아니라 지금까지 본 총 시도 수**다.
//       같은 데이터를 여러 회차에 걸쳐 반복해 봤다면 그 전부가 분모다.
//
// ── 규칙 4(외부 API·입력 검증) 처리 ──────────────────────────────────────────
//   입력이 규약을 어기면 **조용히 넘어가지 않고 비정상 종료**한다. 항목별 try·catch로
//   오류를 삼켜 "다 실패했는데 종료코드 0"이 되는 것을 막기 위해, 성공 카운터를 두고
//   산출이 하나도 없으면 exit 1이다.
//
// ── 규칙 1(미래참조 금지) ────────────────────────────────────────────────────
//   여기서 계산하는 것은 **이미 확정된 수익률 계열의 사후 채점**이다. 산출값이 신호로
//   되먹임되지 않는다. 워크포워드만 구조가 인과적이며 그 경계는 라이브러리와
//   `tests/overfit.test.ts`가 강제한다.

import { readFileSync } from 'node:fs'
import {
  DSR_PASS_THRESHOLD,
  PBO_WARN_THRESHOLD,
  computePbo,
  multipleTestingReport,
  overfitScorecard,
  sharpeMetric,
  sharpeMoments,
  variance,
  walkForwardScore,
} from '../src/features/backtest/overfit'

// ── 출력 유틸 ────────────────────────────────────────────────────────────────

const log = (s = ''): void => console.log(s)

/** null은 '—'로 — 0·1로 채우지 않는다(규칙 3). */
function n(x: number | null | undefined, digits = 3): string {
  return x === null || x === undefined || !Number.isFinite(x) ? '—' : x.toFixed(digits)
}

function pad(s: string, w: number, right = false): string {
  // 한글은 폭 2로 세어 표가 어긋나지 않게 한다.
  let width = 0
  for (const ch of s) width += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹯＀-｠￠-￦]/.test(ch) ? 2 : 1
  const gap = Math.max(0, w - width)
  return right ? ' '.repeat(gap) + s : s + ' '.repeat(gap)
}

// ── 입력 스키마 ──────────────────────────────────────────────────────────────

export interface OverfitVariantInput {
  name: string
  returns: number[]
}

export interface OverfitLabInput {
  round?: string
  periodsPerYear?: number
  trialsCumulative?: number
  dates?: string[]
  benchmark?: number[]
  isWindow?: number
  oosWindow?: number
  blocks?: number
  variants: OverfitVariantInput[]
}

/** 입력을 규약대로 검증한다. 어기면 던진다(조용한 폴백 금지 — 규칙 4). */
export function validateInput(raw: unknown): OverfitLabInput {
  if (typeof raw !== 'object' || raw === null) throw new Error('입력이 객체가 아니다')
  const o = raw as Record<string, unknown>
  if (!Array.isArray(o.variants)) throw new Error('variants 배열이 없다')
  if (o.variants.length < 2) throw new Error(`variants가 ${o.variants.length}개 — PBO는 2개 이상 필요`)

  const variants: OverfitVariantInput[] = o.variants.map((v, i) => {
    if (typeof v !== 'object' || v === null) throw new Error(`variants[${i}]가 객체가 아니다`)
    const vv = v as Record<string, unknown>
    if (!Array.isArray(vv.returns)) throw new Error(`variants[${i}].returns 배열이 없다`)
    for (let t = 0; t < vv.returns.length; t++) {
      const r = vv.returns[t]
      if (typeof r !== 'number' || !Number.isFinite(r)) {
        throw new Error(`variants[${i}].returns[${t}]가 유한한 수가 아니다 (미보유 구간은 0으로 채울 것)`)
      }
    }
    return { name: typeof vv.name === 'string' ? vv.name : `변형${i}`, returns: vv.returns as number[] }
  })

  const len = variants[0].returns.length
  for (const v of variants) {
    if (v.returns.length !== len) {
      throw new Error(`변형별 시점 길이가 다르다 — "${variants[0].name}"=${len}, "${v.name}"=${v.returns.length}`)
    }
  }
  if (len < 30) throw new Error(`시점이 ${len}개 — 채점하기에 너무 짧다(최소 30)`)

  if (o.benchmark !== undefined) {
    if (!Array.isArray(o.benchmark) || o.benchmark.length !== len) {
      throw new Error(`benchmark 길이가 수익률 길이(${len})와 다르다`)
    }
  }
  if (o.dates !== undefined) {
    if (!Array.isArray(o.dates) || o.dates.length !== len) {
      throw new Error(`dates 길이가 수익률 길이(${len})와 다르다`)
    }
  }

  return {
    round: typeof o.round === 'string' ? o.round : undefined,
    periodsPerYear: typeof o.periodsPerYear === 'number' ? o.periodsPerYear : undefined,
    trialsCumulative: typeof o.trialsCumulative === 'number' ? o.trialsCumulative : undefined,
    dates: o.dates as string[] | undefined,
    benchmark: o.benchmark as number[] | undefined,
    isWindow: typeof o.isWindow === 'number' ? o.isWindow : undefined,
    oosWindow: typeof o.oosWindow === 'number' ? o.oosWindow : undefined,
    blocks: typeof o.blocks === 'number' ? o.blocks : undefined,
    variants,
  }
}

// ── 채점 표 출력 ─────────────────────────────────────────────────────────────

/** 산출에 성공한 지표 수 — 0이면 비정상 종료한다(규칙 4: 전량 실패는 exit 1). */
let produced = 0

function reportVariants(input: OverfitLabInput): number[] {
  const sharpes: number[] = []
  log('■ 변형별 전 구간 성적 (기간당 샤프 — 서열용, 연환산 아님)')
  log(`  ${pad('변형', 28)}${pad('샤프', 10, true)}${pad('누적수익%', 12, true)}`)
  for (const v of input.variants) {
    const s = sharpeMetric(v.returns)
    if (s !== null) sharpes.push(s)
    let eq = 1
    for (const r of v.returns) eq *= 1 + r
    log(`  ${pad(v.name, 28)}${pad(n(s, 4), 10, true)}${pad(n((eq - 1) * 100, 2), 12, true)}`)
  }
  log(`  → 시도 샤프 분산 V = ${n(variance(sharpes), 6)} (변형 ${sharpes.length}개 기준)`)
  log()
  return sharpes
}

function reportDsr(input: OverfitLabInput, sharpes: number[], winner: number): void {
  const w = input.variants[winner]
  const m = sharpeMoments(w.returns)
  log('① Deflated Sharpe Ratio — 시도 횟수를 감안해도 유의한가')
  log(`  승자: ${w.name}`)
  log(`  관측 샤프 ${n(m.sharpe, 4)} · 표본 ${m.sampleLength} · 왜도 ${n(m.skew, 3)} · 첨도 ${n(m.kurtosis, 3)}`)
  if (m.sharpe === null) {
    log(`  ⛔ DSR 계산 불가 — ${m.reason}`)
    log()
    return
  }
  const rep = multipleTestingReport({
    observedSharpe: m.sharpe,
    sampleLength: m.sampleLength,
    trialSharpeVariance: variance(sharpes),
    skew: m.skew ?? undefined,
    kurtosis: m.kurtosis ?? undefined,
    trialsThisRound: input.variants.length,
    trialsCumulative: input.trialsCumulative ?? input.variants.length,
  })
  log(`  ${pad('분모', 22)}${pad('시도 N', 9, true)}${pad('E[max SR]', 12, true)}${pad('DSR', 9, true)}  판정`)
  for (const [label, r, trials] of [
    ['이번 회차', rep.thisRound, rep.trialsThisRound],
    ['누적(진짜 분모)', rep.cumulative, rep.trialsCumulative],
  ] as const) {
    const verdict = r.dsr === null ? `— (${r.reason})` : r.dsr >= DSR_PASS_THRESHOLD ? '유의' : '유의하다고 말할 수 없음'
    log(`  ${pad(label, 22)}${pad(String(trials), 9, true)}${pad(n(r.expectedMaxSharpe, 4), 12, true)}${pad(n(r.dsr, 4), 9, true)}  ${verdict}`)
  }
  log(`  보정 전 p=${n(rep.rawPValue, 6)} · Šidák p=${n(rep.sidakPValue, 6)} · Bonferroni p=${n(rep.bonferroniPValue, 6)}`)
  log(`  ▶ ${rep.headline}`)
  log(`  해석 기준: DSR < ${DSR_PASS_THRESHOLD} → "시도 횟수를 감안하면 유의하다고 말할 수 없다"`)
  for (const note of rep.cumulative.notes) log(`  · ${note}`)
  log()
  produced++
}

function reportPbo(input: OverfitLabInput): void {
  const matrix = input.variants.map((v) => v.returns)
  const r = computePbo(matrix, { blocks: input.blocks })
  log('② PBO (CSCV) — 인샘플 1위가 아웃샘플에서 중앙값 이하로 떨어질 확률')
  if (r.pbo === null) {
    log(`  ⛔ 계산 불가 — ${r.reason}`)
    log()
    return
  }
  log(
    `  블록 S=${r.blocks}(블록당 ${r.blockSize}관측, 버림 ${r.droppedObservations}) · ` +
      `조합 ${r.combinationsEvaluated}/${r.combinationsTotal}${r.exhaustive ? ' (전수)' : ' (등간격 결정적 샘플링)'}`,
  )
  log(`  PBO = ${n(r.pbo, 4)} · λ중앙값 ${n(r.medianLambda, 3)} · IS 1위의 평균 OOS 상대순위 ω=${n(r.meanOosRank, 3)}`)
  log(`  ▶ ${r.overfitLikely ? '⚠️ 탐색의 산물일 가능성이 높다' : '순위가 아웃샘플에서 유지되는 편'}`)
  log(`  해석 기준: PBO > ${PBO_WARN_THRESHOLD} → "IS 1위가 OOS에서 평균 이하일 확률이 반 이상" = 탐색의 산물`)
  log('  ⚠️ 단일 회차의 PBO는 표본 실현에 따라 크게 흔들린다(무신호 합성 40회에서 0.09~0.89).')
  log('     한 숫자로 결론짓지 말고 DSR·워크포워드와 함께 읽을 것.')
  for (const note of r.notes) log(`  · ${note}`)
  log()
  produced++
}

function reportWalkForward(input: OverfitLabInput): void {
  const matrix = input.variants.map((v) => v.returns)
  const len = matrix[0].length
  const isWindow = input.isWindow ?? Math.max(2, Math.floor(len * 0.5))
  const oosWindow = input.oosWindow ?? Math.max(1, Math.floor(len * 0.1))
  const r = walkForwardScore(matrix, {
    isWindow,
    oosWindow,
    periodsPerYear: input.periodsPerYear ?? 252,
    benchmark: input.benchmark,
  })
  log('③ 워크포워드 채점 — 롤링 IS 최적화 → 직후 OOS 구간만 성적으로 인정')
  if (r.reason !== null) {
    log(`  ⛔ 계산 불가 — ${r.reason}`)
    log()
    return
  }
  log(`  창: IS ${isWindow} / OOS ${oosWindow} (스텝 = OOS) · 구간 ${r.segments.length}개`)
  log(`  ${pad('#', 4)}${pad('IS구간', 16)}${pad('OOS구간', 16)}${pad('선택 변형', 24)}${pad('IS성과', 10, true)}${pad('OOS성과', 10, true)}`)
  for (const s of r.segments) {
    const name = input.variants[s.selectedVariant]?.name ?? `변형${s.selectedVariant}`
    const dt = (i: number) => (input.dates ? input.dates[i] ?? String(i) : String(i))
    log(
      `  ${pad(String(s.index), 4)}${pad(`${dt(s.isFrom)}~${dt(s.isTo - 1)}`, 16)}${pad(`${dt(s.oosFrom)}~${dt(s.oosTo - 1)}`, 16)}` +
        `${pad(name, 24)}${pad(n(s.isMetric, 4), 10, true)}${pad(n(s.oosMetric, 4), 10, true)}`,
    )
  }
  log(`  OOS 누적수익 ${n(r.oosTotalReturnPct, 2)}% · OOS 연환산 ${n(r.oosAnnualizedPct, 2)}%`)
  log(`  벤치 연환산 ${n(r.benchAnnualizedPct, 2)}% · **OOS 알파 ${n(r.oosAlphaPct, 2)}%p** (규칙 5 — 판정은 알파로)`)
  log(`  IS→OOS 성능 저하율 ${n(r.degradationPct, 1)}% (IS중앙값 ${n(r.medianIsMetric, 4)} → OOS중앙값 ${n(r.medianOosMetric, 4)})`)
  log('  해석 기준: OOS 알파 ≤ 0 이면 그 절차는 실전에서 벤치를 못 이긴다. 저하율 50%↑는 과최적화 신호.')
  for (const note of r.notes) log(`  · ${note}`)
  log()
  produced++
}

function reportScorecard(input: OverfitLabInput): void {
  const matrix = input.variants.map((v) => v.returns)
  const len = matrix[0].length
  const card = overfitScorecard({
    matrix,
    benchmark: input.benchmark,
    trialsCumulative: input.trialsCumulative,
    periodsPerYear: input.periodsPerYear,
    pbo: { blocks: input.blocks },
    walkForward: {
      isWindow: input.isWindow ?? Math.max(2, Math.floor(len * 0.5)),
      oosWindow: input.oosWindow ?? Math.max(1, Math.floor(len * 0.1)),
    },
  })
  log('■ 종합')
  log(`  ${card.headline}`)
  log()
}

function disclaimer(): void {
  log('---')
  log('⚠️ 이 표는 **채점표이지 투자자문이 아니다.** 여기 있는 수치는 과거 시뮬레이션 결과의')
  log('   사후 통계이며, 통과했다고 해서 미래 수익을 보장하지 않는다. DSR·PBO 모두 근사식이고')
  log('   가정(시도 독립·정규 근사)이 깨지면 값이 흔들린다 — 각 항목의 [미검증] 메모를 같이 읽을 것.')
  log('   유니버스에 상장폐지·합병 종목이 빠져 있으면 원래 성적 자체가 부풀려져 있다(생존편향).')
}

// ── 회차 채점 ────────────────────────────────────────────────────────────────

export function scoreRound(input: OverfitLabInput, realData: boolean): void {
  log('='.repeat(96))
  log(`과최적화 채점 — ${input.round ?? '(라벨 없음)'}${realData ? '' : '   [미검증-실데이터]'}`)
  log('='.repeat(96))
  log(
    `변형 ${input.variants.length}개 · 시점 ${input.variants[0].returns.length}개 · ` +
      `누적 시도 N=${input.trialsCumulative ?? input.variants.length} · ` +
      `벤치마크 ${input.benchmark ? '있음' : '없음(알파 산출 불가)'}`,
  )
  log()

  const sharpes = reportVariants(input)
  let winner = -1
  let bestScore = -Infinity
  for (let i = 0; i < input.variants.length; i++) {
    const s = sharpeMetric(input.variants[i].returns)
    if (s === null) continue
    if (s > bestScore) {
      bestScore = s
      winner = i
    }
  }
  if (winner < 0) {
    log('⛔ 모든 변형의 샤프를 계산할 수 없다 — 승자를 정할 수 없어 DSR을 건너뛴다')
    log()
  } else {
    reportDsr(input, sharpes, winner)
  }
  reportPbo(input)
  reportWalkForward(input)
  reportScorecard(input)
  disclaimer()
}

// ── 합성 자기검증 ────────────────────────────────────────────────────────────
//
// 실데이터가 없을 때 도구 자체가 살아 있는지만 확인한다. **정답을 아는 표본**을 쓴다
// (규칙 4: 자기검증) — 무신호 집합은 경고가 떠야 하고, 지속적 우열이 있는 집합은
// 경고가 뜨지 않아야 한다. 여기서 나온 수치는 회차 성적이 아니다.

/** 결정적 난수(tests/harness.ts와 같은 정의 — Math.random 금지). */
function rng(seed: number): () => number {
  let s = seed
  return () => {
    s |= 0
    s = (s + 0x6d2b79f5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function normalFrom(rand: () => number): number {
  const u1 = Math.max(1e-12, rand())
  const u2 = rand()
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
}

function syntheticRound(kind: 'noise' | 'skill', variants = 20, obs = 1000, seed = 20260803): OverfitLabInput {
  const rand = rng(seed)
  const out: OverfitVariantInput[] = []
  for (let v = 0; v < variants; v++) {
    const drift = kind === 'noise' ? 0 : 0.0002 + 0.003 * (v / Math.max(1, variants - 1))
    const returns: number[] = []
    for (let t = 0; t < obs; t++) returns.push(drift + normalFrom(rand) * 0.01)
    out.push({ name: `${kind === 'noise' ? '무신호' : '우열'}변형${String(v).padStart(2, '0')}`, returns })
  }
  return {
    round: kind === 'noise' ? '합성 자기검증 A — 알파 0(무신호) 20변형' : '합성 자기검증 B — 지속적 우열 20변형',
    periodsPerYear: 252,
    trialsCumulative: 79,
    benchmark: new Array(obs).fill(0.0002),
    isWindow: 500,
    oosWindow: 100,
    blocks: 8,
    variants: out,
  }
}

export function selfTest(): void {
  log('')
  log('※ OVERFIT_INPUT이 없어 **합성 데이터 자기검증만** 수행한다. 아래 수치는 도구가')
  log('  살아 있는지 확인하는 값이며 어떤 회차의 성적도 아니다 — [미검증-실데이터].')
  log('  실데이터 채점: OVERFIT_INPUT=<회차.json> MODE=overfit node scripts/overfit-lab.mjs')
  log('  입력 스키마는 이 파일(scripts/overfit-lab.entry.ts) 머리말의 "입력 인터페이스" 참조.')
  log('')
  scoreRound(syntheticRound('noise'), false)
  log('')
  scoreRound(syntheticRound('skill'), false)
  log('')
  log('※ 기대되는 자기검증 결과: A(무신호)는 DSR 미달 + PBO > 0.5 + OOS 알파 음수로 **경고**,')
  log('  B(지속적 우열)는 세 지표 모두 통과. 이와 다르면 도구가 고장난 것이다.')
}

// ── 엔트리 ───────────────────────────────────────────────────────────────────

function runOverfit(): void {
  const path = process.env.OVERFIT_INPUT
  if (!path) {
    selfTest()
    produced++ // 자기검증도 산출로 친다(입력이 없는 것은 오류가 아니다)
    return
  }
  const raw = readFileSync(path, 'utf8')
  const input = validateInput(JSON.parse(raw))
  log(`입력: ${path} (${raw.length}바이트)`)
  scoreRound(input, true)
}

const MODES: Record<string, () => void> = {
  overfit: runOverfit,
  selftest: () => {
    selfTest()
    produced++
  },
}

// 런처(scripts/overfit-lab.mjs)만 OVERFIT_LAB_RUN=1을 넘긴다. 테스트가 이 모듈을
// import할 때는 자동 실행되지 않는다.
if (process.env.OVERFIT_LAB_RUN === '1') {
  const mode = process.env.MODE ?? 'overfit'
  const entry = MODES[mode]
  if (!entry) {
    console.error(`알 수 없는 MODE=${mode} — 가능: ${Object.keys(MODES).join(', ')}`)
    process.exit(1)
  }
  try {
    entry()
  } catch (e) {
    console.error('실행 실패:', e instanceof Error ? e.message : e)
    process.exit(1)
  }
  // 규칙 4 — 항목별 오류를 삼켜 "다 실패했는데 종료코드 0"이 되는 것을 막는다.
  if (produced === 0) {
    console.error('⛔ 산출된 지표가 하나도 없다 — 입력·표본을 확인할 것')
    process.exit(1)
  }
}
