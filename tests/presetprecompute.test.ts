// 프리셋 사전계산(scripts/preset-precompute.entry.ts)의 **사후 요약 산술** 검증.
//
// 왜 합성 데이터인가: 이 스크립트의 실행 경로(runPitChained·runXsmomChained·blendChainResults)는
// 이미 각각의 테스트가 덮고 있고, 실데이터는 Yahoo 접근이 필요해 컨테이너·CI에서 재현되지 않는다.
// 그래서 여기서는 스크립트가 **새로 만드는 계산만** 합성 곡선으로 못 박는다:
//   ① 최근 10년 CAGR 산술          ② 다운샘플이 MDD를 얕게 만들지 않는가
//   ③ 산출물 JSON 스키마·직렬화     ④ presets.ts 자체의 불변식(중복 id·화면에서 고를 수 없는 값)
//
// ⚠️ 규칙 1(미래참조 금지)과의 관계: 여기서 검증하는 것은 **이미 확정된 자산곡선의 사후 요약**이다.
//    요약값이 백테스트 판정으로 되먹임되지 않으므로 전 구간 통계 금지에 걸리지 않는다.
//    (백테스트 자체의 인과성은 lookahead·pitchain·xsmomchain·comboblend 테스트가 집행한다.)

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { check, close, eq, finish, section } from './harness'
import {
  buildPayload,
  downsampleWeekly,
  drawdownExtremes,
  mddPctOf,
  recentCagrPct,
  shiftYearsBack,
  summarizePreset,
  weekBucket,
  type CurvePoint,
} from '../scripts/preset-precompute.entry'
import {
  COMBO_WEIGHTS,
  DEFAULT_COST,
  GOLD_WEIGHTS,
  KRXCAL_QQQ_WALL,
  MOM_SLOT_CHOICES,
  PRESETS,
  PRESET_BANNER,
  PRESET_FAILED_NOTE,
  normalizeGoldW,
} from '../src/features/backtest/presets'
import { augmentPresetLabel, mddChip, tenYearChip } from '../src/features/backtest/precomputed'
import type { PitChainResult } from '../src/features/backtest/pitChain'

const ROOT = process.env.REPO_ROOT ?? process.cwd()

// ---- 합성 곡선 도구 ---------------------------------------------------------

const DAY = 86400e3
const dstr = (t: number) => new Date(t).toISOString().slice(0, 10)

/** `from`부터 n일치 일별 곡선. equityAt(i)로 값을 준다(벤치는 평평하게 둔다). */
function makeCurve(from: string, days: number, equityAt: (i: number) => number): CurvePoint[] {
  const t0 = Date.parse(`${from}T00:00:00Z`)
  const out: CurvePoint[] = []
  for (let i = 0; i < days; i++) out.push({ date: dstr(t0 + i * DAY), equity: equityAt(i), benchmark: 1_000_000 })
  return out
}

// ============================================================================
section('① 최근 10년 CAGR — "최근 10년 평균 수익률"의 구현 정의')
// ============================================================================

{
  // 2006-01-02 ~ 2026-01-02 (20년+1일). 앞 10년은 평평, 뒤 10년은 정확히 2배.
  const t0 = Date.parse('2006-01-02T00:00:00Z')
  const cut = Date.parse('2016-01-02T00:00:00Z')
  const totalDays = Math.round((Date.parse('2026-01-02T00:00:00Z') - t0) / DAY) + 1
  const curve = makeCurve('2006-01-02', totalDays, (i) => {
    const t = t0 + i * DAY
    if (t <= cut) return 1_000_000
    // 마지막 날 정확히 2,000,000이 되도록 선형 보간(중간 경로는 무관하다)
    const frac = (t - cut) / (Date.parse('2026-01-02T00:00:00Z') - cut)
    return 1_000_000 * (1 + frac)
  })

  eq('마지막 날짜', curve[curve.length - 1].date, '2026-01-02')
  eq('10년 전 기준일 문자열', shiftYearsBack('2026-01-02', 10), '2016-01-02')
  eq('윤일도 사전순으로 안전', shiftYearsBack('2024-02-29', 10), '2014-02-29')

  // 기준점은 '2016-01-02'(= cutoff 이후 첫 점)이고 그 값은 1,000,000, 마지막은 2,000,000.
  // 연수는 yearsBetween 정의(365.25일/년)를 따른다: 3653일 / 365.25 = 10.0013689…
  const spanDays = Math.round((Date.parse('2026-01-02T00:00:00Z') - cut) / DAY)
  eq('기준일~마지막 일수', spanDays, 3653)
  const expected = (Math.pow(2, 1 / (3653 / 365.25)) - 1) * 100
  const got = recentCagrPct(curve, 10)
  check('최근 10년 CAGR 계산됨', got != null)
  close('최근 10년 CAGR = 2배의 연환산', got as number, expected, 1e-9)
  check('상식 범위(≈7.18%)', Math.abs((got as number) - 7.18) < 0.02, `got ${got}`)

  // 전 구간 CAGR(20년 동안 2배)은 훨씬 낮아야 한다 — 두 값이 섞이면 안 된다.
  const full = recentCagrPct(curve, 20)
  check('20년 CAGR < 10년 CAGR', (full as number) < (got as number), `20y=${full} 10y=${got}`)

  // 뒤 10년이 평평하면 0%
  const flat = makeCurve('2006-01-02', totalDays, () => 1_000_000)
  close('평평한 곡선의 10년 CAGR = 0', recentCagrPct(flat, 10) as number, 0, 1e-9)

  // 10년을 못 채우는 곡선은 **계산하지 않는다**(짧은 구간을 10년인 척 연환산하면 거짓)
  const short = makeCurve('2020-01-02', 400, (i) => 1_000_000 * (1 + i / 400))
  eq('10년 미만 곡선 → null', recentCagrPct(short, 10), null)
  eq('빈 곡선 → null', recentCagrPct([], 10), null)
  eq('점 1개 → null', recentCagrPct([{ date: '2026-01-02', equity: 1 }], 10), null)
}

// ============================================================================
section('② 주 1점 다운샘플 — MDD가 얕아지면 안 된다')
// ============================================================================

{
  // 주중(수요일)에만 깊게 파이는 곡선. 주 마지막 점만 남기면 최저점이 통째로 사라진다.
  // 1,000일치: 기본 100만, 고점은 400일째 200만, 최저점은 617일째 60만(수요일 여부와 무관하게
  // "주의 마지막 점이 아닌 날"에 오도록 인덱스를 잡았다).
  const PEAK_I = 400
  const TROUGH_I = 617
  const curve = makeCurve('2020-01-06', 1000, (i) => {
    if (i === PEAK_I) return 2_000_000
    if (i === TROUGH_I) return 600_000
    return 1_000_000 + (i % 7) * 1000 // 주 안에서 미세하게 움직인다
  })

  const ex = drawdownExtremes(curve)
  eq('MDD 고점 인덱스', ex.peakIdx, PEAK_I)
  eq('MDD 최저점 인덱스', ex.troughIdx, TROUGH_I)
  close('원곡선 MDD = 200만→60만 = −70%', ex.mddPct, -70, 1e-9)

  const ds = downsampleWeekly(curve)
  check('점 수가 줄었다', ds.length < curve.length, `${curve.length} → ${ds.length}`)
  check('주 1점 수준으로 줄었다(주 수 + 여유 4점 이내)', ds.length <= Math.ceil(1000 / 7) + 4, `${ds.length}`)
  eq('첫 점 보존', ds[0].date, curve[0].date)
  eq('최종일 보존', ds[ds.length - 1].date, curve[curve.length - 1].date)
  check('MDD 최저점 보존', ds.some((p) => p.date === curve[TROUGH_I].date))
  check('MDD 고점 보존', ds.some((p) => p.date === curve[PEAK_I].date))
  close('다운샘플 후에도 MDD 동일', mddPctOf(ds), ex.mddPct, 1e-9)

  // 날짜 오름차순·중복 없음
  let ordered = true
  for (let i = 1; i < ds.length; i++) if (!(ds[i].date > ds[i - 1].date)) ordered = false
  check('날짜 오름차순·중복 없음', ordered)

  // 강제 보존 점을 빼면(= 순수 주 마지막 점만) MDD가 **얕아진다** — 보존이 왜 필요한지의 근거
  const naive = curve.filter((_, i) => i === curve.length - 1 || weekBucket(curve[i + 1].date) !== weekBucket(curve[i].date))
  check('보존 없는 주말 표본은 MDD가 얕아진다', mddPctOf(naive) > ex.mddPct + 1, `naive=${mddPctOf(naive)}`)

  // 부분집합의 MDD는 원곡선보다 깊어질 수 없다(자산곡선 요약의 일반 성질)
  check('다운샘플 MDD ≥ 원곡선 MDD (더 깊어지지 않는다)', mddPctOf(ds) >= ex.mddPct - 1e-9)

  // 짧은 곡선은 그대로 돌려준다
  const tiny = makeCurve('2026-01-01', 3, () => 1_000_000)
  eq('3점 이하는 그대로', downsampleWeekly(tiny).length, 3)
}

// ============================================================================
section('③ 산출물 스키마 — 화면이 읽을 수 있는 형태인가')
// ============================================================================

/** 요약에 필요한 필드만 채운 가짜 실행 결과(엔진을 돌리지 않는다) */
function fakeResult(over: Partial<PitChainResult> = {}): PitChainResult {
  // 10년 CAGR이 나오려면 곡선이 10년보다 길어야 한다(짧으면 null이 정상 동작이다)
  const equity = makeCurve('2010-01-04', 4200, (i) => 1_000_000 * (1 + i / 1000)).map((p) => ({
    date: p.date,
    equity: p.equity,
    benchmark: p.benchmark,
    drawdownPct: 0,
  }))
  return {
    equity,
    trades: [],
    perYear: [],
    startDate: equity[0].date,
    endDate: equity[equity.length - 1].date,
    years: 8.2,
    totalPct: 299.9,
    cagrPct: 18.4,
    mddPct: -12.3,
    objective: 24.4,
    benchTotalPct: 100,
    benchCagrPct: 8.8,
    alphaCagrPct: 9.6,
    alphaTotalPct: 199.9,
    tradeCount: 1234,
    winRate: 51.2,
    avgPnlPct: 0.8,
    openAtEnd: 3,
    exitBreakdown: [],
    lastScreen: [],
    lastScreenDate: '',
    mappedAvgPct: 88,
    ...over,
  } as PitChainResult
}

{
  const row = summarizePreset({ id: 'x-1', label: '테스트', kind: 'momentum' }, fakeResult(), 10_000_000)
  const keys = [
    'id',
    'label',
    'kind',
    'mddPct',
    'cagrPct',
    'cagr10yPct',
    'totalPct',
    'alphaCagrPct',
    'benchCagrPct',
    'tradeCount',
    'startDate',
    'endDate',
    'initialCapital',
    'curve',
  ]
  for (const k of keys) check(`필드 존재: ${k}`, k in (row as unknown as Record<string, unknown>))
  eq('mddPct는 원곡선 요약을 그대로 쓴다', row.mddPct, -12.3)
  eq('tradeCount(단독 모드)', row.tradeCount, 1234)
  check('cagr10yPct 계산됨', row.cagr10yPct != null)
  check('curve는 3원소 튜플', row.curve.every((t) => Array.isArray(t) && t.length === 3))
  check('curve 날짜는 문자열·값은 정수', row.curve.every((t) => typeof t[0] === 'string' && Number.isInteger(t[1]) && Number.isInteger(t[2])))

  // 결합은 매매 원장이 없다 — 0(매매 없음)이 아니라 null(귀속 불가)
  const combo = summarizePreset({ id: 'c-1', label: '결합', kind: 'combo' }, fakeResult({ tradeCount: 0 }), 10_000_000)
  eq('결합 tradeCount는 null(귀속 불가)', combo.tradeCount, null)

  const payload = buildPayload([row, combo], '2026-08-01', '2026-08-02T00:00:00.000Z', DEFAULT_COST)
  eq('asOf', payload.asOf, '2026-08-01')
  eq('curveInterval', payload.curveInterval, 'weekly')
  eq('프리셋 수', payload.presets.length, 2)
  check('스키마 버전 존재', typeof payload.schema === 'number')
  check('비용 전제 기록', payload.cost.initialCapital === DEFAULT_COST.initialCapital)
  // 34차 이후 note는 "[추정] 목록"이 아니라 **실측 유니버스**를 말한다. 대신 남아 있는 한계
  // (가격 생존편향·2010 이전 부재)와 규칙 4 고지가 반드시 붙어야 한다.
  check('실측 유니버스 명시', payload.note.includes('실측'))
  check('가격 생존편향 고지', payload.note.includes('생존편향'))
  check('2010 이전 부재 고지', payload.note.includes('2010'))
  check('매수 권유 아님 고지', payload.note.includes('매수 권유가 아니다'))
  check('벽이 판정 벤치가 아님을 명시', payload.note.includes('판정 벤치가 아니다'))
  eq('walls 기본값은 빈 배열', payload.walls.length, 0)

  // JSON 왕복 — 화면이 fetch로 읽는 형태 그대로
  const round = JSON.parse(JSON.stringify(payload))
  eq('왕복 후 asOf', round.asOf, payload.asOf)
  eq('왕복 후 곡선 길이', round.presets[0].curve.length, row.curve.length)
  eq('왕복 후 null 유지', round.presets[1].tradeCount, null)
}

// ============================================================================
section('④ presets.ts 불변식 — 화면과 사전계산이 같은 배열을 읽는다')
// ============================================================================

{
  const ids = PRESETS.map((p) => p.id)
  eq('id 중복 없음', new Set(ids).size, ids.length)
  check('모든 프리셋에 라벨', PRESETS.every((p) => p.label.length > 0))

  // ── 34차 전면 교체(2026-08-03) ────────────────────────────────────────────
  // 구 10종은 전부 [추정] 목록(PIT1010) 위에서 고른 것이라 33차에서 무효가 됐다.
  // 화면 목록에 그중 하나라도 되살아나면 서로 다른 전제의 수치를 같은 이름으로 비교하게 된다.
  eq('프리셋은 34차 판정 통과 2종뿐', PRESETS.length, 2)
  eq('프리셋 id는 실측 2종', ids.slice().sort().join(','), 'krx-xsmom3g,krx-xsmom5g')
  for (const dead of ['pit-base', 'pit-top', 'pit-maxret', 'pit-maxratio', 'xsmom-5-gate', 'xsmom-5', 'xsmom-3-gate', 'combo-50', 'combo-25-75', 'calmar-max'])
    check(`구 프리셋 ${dead}는 목록에 없다`, !ids.includes(dead))

  const p3 = PRESETS.find((p) => p.id === 'krx-xsmom3g')
  const p5 = PRESETS.find((p) => p.id === 'krx-xsmom5g')
  check('krx-xsmom3g 존재', p3 != null)
  check('krx-xsmom5g 존재', p5 != null)
  check('krx-xsmom3g는 모멘텀·상위3·게이트 on', p3?.kind === 'momentum' && p3.mom.slots === 3 && p3.mom.gate === true)
  check('krx-xsmom5g는 모멘텀·상위5·게이트 on', p5?.kind === 'momentum' && p5.mom.slots === 5 && p5.mom.gate === true)

  // 화면에서 고를 수 없는 값이 프리셋에 들어가면 셀렉트가 빈칸이 된다(2026-08-02 실제로 걸림)
  for (const p of PRESETS) {
    if (p.kind === 'momentum' || p.kind === 'combo')
      check(`${p.id}: 슬롯이 화면 선택지 안에 있다`, (MOM_SLOT_CHOICES as readonly number[]).includes(p.mom.slots), `slots=${p.mom.slots}`)
    if (p.kind === 'combo') {
      check(`${p.id}: 가중이 화면 선택지 안에 있다`, (COMBO_WEIGHTS as readonly number[]).includes(p.wA), `wA=${p.wA}`)
      check(`${p.id}: 금 비중이 화면 선택지 안에 있다`, (GOLD_WEIGHTS as readonly number[]).includes(normalizeGoldW(p.goldW)), `goldW=${p.goldW}`)
    }
  }

  // ── note 필수 병기(규칙 3·4) ──────────────────────────────────────────────
  // 40차(2026-08-03) 이후 두 프리셋의 결론은 "판정에서 **탈락**했다"이다.
  // 34차의 "판정은 통과했지만 벽은 못 넘었다"에서 한 단계 더 내려갔다 —
  // 37차(가격 생존편향 제거)와 40차(배당 비대칭 제거)로 통과 근거 자체가 사라졌다.
  // 그 사실이 note 맨 앞에서 빠지면 탈락한 조합을 고를 수 있게 되고, 그것이 이 화면의
  // 유일한 실질 위험이다(라벨·note가 유일한 방어선이다).
  const NOTE_MUST: [string, string][] = [
    ['판정 탈락 명시', '판정 탈락'],
    ['탈락 회차(40차) 표기', '40차'],
    ['실매매 금지 경고', '실제 매매를 붙이지 마라'],
    ['유리하게 고쳐도 안 됐다는 사실', '유리한 쪽으로 고쳤는데도'],
    ['34차 실측 표기', '34차'],
    ['칼마 수치', '칼마'],
    ['CAGR 수치', 'CAGR'],
    ['MDD 수치', 'MDD'],
    ['전반 알파', '전반'],
    ['후반 알파', '후반'],
    ['QQQ 벽을 넘지 못했다', '넘지 못했다'],
    ['QQQ 벽 칼마 0.625(40차 갱신)', '0.625'],
    ['35변형 다중검정', '35변형'],
    ['우연 가능성 병기', '우연'],
    ['17년 표본', '17년'],
    ['가격 생존편향', '생존편향'],
    ['상폐 23종목', '23종목'],
    ['2010 이전 부재', '2010년 이전'],
    ['매수 권유 아님', '매수 권유가 아니다'],
  ]
  for (const p of PRESETS) {
    const note = p.kind === 'condition' ? (p.note ?? '') : p.note
    for (const [what, needle] of NOTE_MUST)
      check(`${p.id}: note에 ${what}`, note.includes(needle), `'${needle}' 없음`)
    check(`${p.id}: note에 낙폭 경고`, note.includes('MDD') || note.includes('낙폭'))
    check(`${p.id}: note에 과최적화·다중검정 경고`, note.includes('과최적화') || note.includes('다중'))
  }

  // 각 프리셋의 고유 실측 수치가 서로 뒤바뀌지 않았는지(복사 실수 방지)
  const n3 = p3?.kind === 'momentum' ? p3.note : ''
  const n5 = p5?.kind === 'momentum' ? p5.note : ''
  // 40차 재측정치가 정본이다. 옛 34차 수치는 "폐기됨" 맥락에서만 남아 있어야 한다 —
  // 두 수치가 나란히 있으면 어느 쪽이 현재값인지가 이 표의 생사를 가른다.
  check('krx-xsmom3g: 40차 칼마 0.252·CAGR 14.8%·MDD −58.9%', n3.includes('0.252') && n3.includes('14.8') && n3.includes('58.9'))
  check('krx-xsmom3g: 40차 전반 −6.4%p · 후반 +17.1%p', n3.includes('−6.4%p') && n3.includes('+17.1%p'))
  check('krx-xsmom5g: 40차 칼마 0.128·CAGR 7.1%·MDD −55.0%', n5.includes('0.128') && n5.includes('7.1') && n5.includes('55.0'))
  check('krx-xsmom5g: 40차 전반 −6.1%p · 후반 +0.3%p', n5.includes('−6.1%p') && n5.includes('+0.3%p'))
  check('krx-xsmom5g: 전 구간 알파도 음수임을 명시', n5.includes('전 구간 알파가 음수'))
  // 옛 수치를 지우지 않되 **폐기 표시와 함께**만 둔다(다음 세션이 그것을 근거로 쓰지 않게).
  check('krx-xsmom3g: 옛 34차 수치는 폐기 표시와 함께', n3.includes('폐기된 34차'))
  check('krx-xsmom5g: 옛 34차 수치는 폐기 표시와 함께', n5.includes('폐기된 34차'))

  // 상시 안내 배너 — 화면 상단에 항상 뜬다(프리셋을 고르지 않아도 보여야 한다)
  // 배너는 프리셋을 고르지 않아도 항상 보인다 — 40차부터 이 자리는 "권장 프리셋 없음"을 말한다.
  check('배너: 권장 프리셋 없음 명시', PRESET_BANNER.includes('권장 프리셋이 없습니다'))
  check('배너: 탈락 사실 명시', PRESET_BANNER.includes('탈락'))
  check('배너: 실매매 금지', PRESET_BANNER.includes('실제 매매에 쓰지 마'))
  check('탈락 사유: 생존편향 제거(37차)', PRESET_FAILED_NOTE.includes('37차') && PRESET_FAILED_NOTE.includes('생존편향'))
  check('탈락 사유: 배당 비대칭 제거(40차)', PRESET_FAILED_NOTE.includes('40차') && PRESET_FAILED_NOTE.includes('배당'))
  check('탈락 사유: 유리하게 고쳐도 음수였다', PRESET_FAILED_NOTE.includes('유리한 쪽으로 고쳤는데도'))

  // 벽 상수 — 화면이 사전계산 없이 강등할 때 쓰는 값.
  // 40차에서 벽도 가격수익으로 다시 쟀다(0.670/20.3 → 0.625/19.3). 벽을 낮춘 것이 아니라
  // 전략과 **같은 기준**으로 맞춘 것이다 — 전략이 가격수익인데 벽만 배당 재투자면 벽이 부당하게 높다.
  eq('벽 칼마 상수(40차 가격수익 기준)', KRXCAL_QQQ_WALL.calmar, 0.625)
  eq('벽 CAGR 상수(40차 가격수익 기준)', KRXCAL_QQQ_WALL.cagrPct, 19.3)
  check('벽 MDD 상수는 음수', KRXCAL_QQQ_WALL.mddPct < 0)

  // presets.ts는 UI 무의존이어야 한다 — React가 들어오면 스크립트 번들이 오염된다
  const src = readFileSync(join(ROOT, 'src', 'features', 'backtest', 'presets.ts'), 'utf8')
  check('presets.ts는 react를 import하지 않는다', !/from\s+'react/.test(src))
  check('presets.ts는 .tsx를 import하지 않는다', !/from\s+'[^']*\.tsx'/.test(src))
}

// ============================================================================
section('⑤ 라벨 병기 — 수치는 사전계산에서 오고, 없으면 원래 라벨로 강등한다')
// ============================================================================

{
  const pc = {
    id: 'x',
    label: 'L',
    kind: 'momentum' as const,
    mddPct: -61.4,
    cagrPct: 30.5,
    cagr10yPct: 12.34,
    totalPct: 1000,
    alphaCagrPct: 21.9,
    benchCagrPct: 8.6,
    tradeCount: 100,
    startDate: '2000-01-04',
    endDate: '2026-08-01',
    initialCapital: 10_000_000,
    curve: [] as [string, number, number][],
  }

  eq('MDD 칩(정수 %)', mddChip(pc.mddPct), 'MDD −61%')
  eq('10y 칩(소수 1자리)', tenYearChip(pc.cagr10yPct), '10y 연평균 +12.3%')
  eq('음수 10y도 유니코드 −', tenYearChip(-3.25), '10y 연평균 −3.3%')
  eq('10y 없음 → 칩 없음', tenYearChip(null), null)

  eq('사전계산 없으면 원래 라벨 그대로', augmentPresetLabel('원래 라벨 (MDD −61%)', null), '원래 라벨 (MDD −61%)')
  eq(
    '병기 형태',
    augmentPresetLabel('25차 모멘텀 상위5+게이트', pc),
    '25차 모멘텀 상위5+게이트 · MDD −61% · 10y 연평균 +12.3%',
  )
  // 손으로 박아 둔 (MDD …)는 사전계산 값으로 **대체**된다 — 같은 지표가 두 번 붙으면 안 된다
  const dup = augmentPresetLabel('25차 모멘텀 상위5+게이트 (MDD −61%)', pc)
  eq('하드코딩 MDD 조각 제거', dup, '25차 모멘텀 상위5+게이트 · MDD −61% · 10y 연평균 +12.3%')
  eq('MDD가 라벨에 한 번만 등장', dup.split('MDD').length - 1, 1)

  // 실제 프리셋 라벨에 그대로 적용해도 **MDD 수치 칩**이 중복되지 않는다.
  // (pit-maxratio 라벨의 "수익÷MDD 1위"처럼 수치가 아닌 'MDD'는 그대로 둔다 — 지표 이름이지 값이 아니다.)
  for (const p of PRESETS) {
    const out = augmentPresetLabel(p.label, { ...pc, id: p.id, label: p.label })
    const chips = out.match(/MDD\s*[−+-]\d/g) ?? []
    check(`${p.id}: MDD 수치 칩 1회`, chips.length === 1, `${chips.length}회 · ${out}`)
  }
}

finish()
