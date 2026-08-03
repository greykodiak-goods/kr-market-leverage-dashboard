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
  MOM_SLOT_CHOICES,
  PRESETS,
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
  check('[추정] 고지 포함', payload.note.includes('[추정]'))

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

  // 2026-08-02 대표 지시로 추가한 고수익 프리셋 2개
  const hi = PRESETS.find((p) => p.id === 'xsmom-3-gate')
  check('xsmom-3-gate 존재', hi != null)
  check('xsmom-3-gate는 모멘텀·상위3·게이트 on', hi?.kind === 'momentum' && hi.mom.slots === 3 && hi.mom.gate === true)
  const combo25 = PRESETS.find((p) => p.id === 'combo-25-75')
  check('combo-25-75 존재', combo25 != null)
  check('combo-25-75는 결합·wA 0.25', combo25?.kind === 'combo' && combo25.wA === 0.25)

  // 2026-08-03 대표 지시로 추가한 32차 칼마 1위
  const cal = PRESETS.find((p) => p.id === 'calmar-max')
  check('calmar-max 존재', cal != null)
  check(
    'calmar-max는 결합·wA 0.5·상위5+게이트·시장게이트 on·금 20%',
    cal?.kind === 'combo' &&
      cal.wA === 0.5 &&
      cal.mom.slots === 5 &&
      cal.mom.gate === true &&
      cal.marketGate === true &&
      normalizeGoldW(cal.goldW) === 0.2,
  )
  const calNote = cal?.kind === 'combo' ? cal.note : ''
  // 구간이 다르다는 사실은 이 프리셋에서 **가장 잘 오해되는 지점**이라 note에서 강제한다
  check('calmar-max: 곡선 시작(2004-11) 명시', calNote.includes('2004-11'))
  check('calmar-max: 닷컴 붕괴 제외 명시', calNote.includes('닷컴'))
  check('calmar-max: 리밸런스 비용 미반영 경고', calNote.includes('리밸런스 비용 미반영'))
  check('calmar-max: 달러 노출 의존 경고', calNote.includes('달러'))
  check('calmar-max: 국내 대체품·세제 미반영 경고', calNote.includes('세제'))
  // 게이트 달의 청산·재매수 비용이 반영된다는 사실을 note가 밝혀야 한다
  // (예전 커브 마스크 구현에서는 이 비용이 빠져 있었고, 그게 폐기 사유였다)
  check('calmar-max: 게이트 달 청산 비용 반영 명시', calNote.includes('청산'))
  check('calmar-max: 커브 마스크 시절의 "실측치와 불일치" 문구가 남아 있지 않다', !calNote.includes('일치하지 않는다'))
  check('calmar-max: 매수 권유 아님 명시', calNote.includes('매수 권유가 아니다'))
  // 금 슬리브가 붙은 프리셋은 반드시 시장게이트 옵션 유무와 무관하게 비중이 선택지 안이어야 한다
  for (const p of PRESETS) {
    if (p.kind !== 'combo') continue
    check(
      `${p.id}: 금 비중이 화면 선택지 안에 있다`,
      (GOLD_WEIGHTS as readonly number[]).includes(normalizeGoldW(p.goldW)),
      `goldW=${p.goldW}`,
    )
  }

  // 화면에서 고를 수 없는 값이 프리셋에 들어가면 셀렉트가 빈칸이 된다(2026-08-02 실제로 걸림)
  for (const p of PRESETS) {
    if (p.kind === 'momentum' || p.kind === 'combo')
      check(`${p.id}: 슬롯이 화면 선택지 안에 있다`, (MOM_SLOT_CHOICES as readonly number[]).includes(p.mom.slots), `slots=${p.mom.slots}`)
    if (p.kind === 'combo')
      check(`${p.id}: 가중이 화면 선택지 안에 있다`, (COMBO_WEIGHTS as readonly number[]).includes(p.wA), `wA=${p.wA}`)
  }

  // 규칙 4 — 낙폭·다중검정 경고가 note에 남아 있어야 한다(수익률만 보고 고르는 것을 막는 장치)
  for (const p of PRESETS) {
    if (p.kind === 'condition') continue
    check(`${p.id}: note에 MDD 경고`, p.note.includes('MDD') || p.note.includes('낙폭'))
    check(`${p.id}: note에 과최적화·다중검정 경고`, p.note.includes('과최적화') || p.note.includes('다중'))
  }
  const hiNote = hi?.kind === 'momentum' ? hi.note : ''
  check('xsmom-3-gate: 집중도 위험 경고', hiNote.includes('집중도'))
  check('xsmom-3-gate: 매수 권유 아님 명시', hiNote.includes('매수 권유가 아니다'))
  const c25Note = combo25?.kind === 'combo' ? combo25.note : ''
  check('combo-25-75: 곡선맞춤 경고', c25Note.includes('곡선맞춤'))
  check('combo-25-75: 리밸런스 비용 미반영 경고', c25Note.includes('리밸런스 비용 미반영'))
  check('combo-25-75: 기본안 50:50 명시', c25Note.includes('50:50'))

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
