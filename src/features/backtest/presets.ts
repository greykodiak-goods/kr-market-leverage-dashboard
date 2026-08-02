// 시뮬레이터 프리셋 정본 — **UI 무의존 순수 모듈**.
//
// 왜 분리했나 (2026-08-02 대표 지시 "프리셋들 결과는 미리 돌려서 저장"):
//   프리셋 정의가 SpecSimulator.tsx 안에 있으면 헤드리스 사전계산 스크립트가 화면 코드를
//   import해야 하고, 그러면 React·recharts·localStorage가 통째로 딸려 온다(번들 오염·순환).
//   그래서 **정의는 여기, 실행은 양쪽**이라는 구조로 바꿨다 —
//   화면(SpecSimulator.tsx)과 사전계산(scripts/preset-precompute.entry.ts)이 **같은 배열**을 읽는다.
//   프리셋이 여기서 바뀌면 화면 목록과 사전계산 산출물이 자동으로 같이 바뀐다.
//
// 이 모듈은 React를 import하지 않는다 — 그 규약이 깨지면 스크립트 번들이 오염된다.
//
// ⚠️ note에 적힌 성적은 전부 **[추정·러너 실행값]**이며 매수 권유가 아니다(규칙 4).
//    수익률만 보고 고르지 못하도록 라벨에 MDD를 박아 둔다.

import { SPEC_VERSION, HEROMOON_MOMENTUM, type StrategySpec } from './strategySpec'
import type { CostSettings } from './conditionScreen'

// ---- 실행 공통 설정 ---------------------------------------------------------
//
// 화면 기본값과 사전계산이 **같은 상수**를 써야 두 수치가 비교 가능하다.
// (사전계산 산출물의 요약치는 화면에서 "직접 다시 돌리기" 했을 때와 같은 전제여야 한다.)

/** 화면 기본 비용 설정 · 사전계산 스크립트의 고정 비용 설정 */
export const DEFAULT_COST: CostSettings = {
  initialCapital: 10_000_000,
  feePct: 0.015,
  taxPct: 0.15,
  slippagePct: 0.1,
}

/** KODEX 200 — 알파 판정 기준(규칙 5). 이 벤치는 바꾸지 않는다. */
export const BENCH_SYMBOL = '069500.KS'
/** 코스피 지수 — 레짐 게이트 판정용(매매 대상 아님) */
export const KOSPI_INDEX = '^KS11'

/** 코스피 지수 5·10일선 정배열일 때만 신규 진입 (레짐 게이트) */
export const KOSPI_REGIME: NonNullable<StrategySpec['regime']> = {
  symbol: KOSPI_INDEX,
  entry: { op: 'and', nodes: [{ op: 'cond', cond: { kind: 'maAlign', fast: 5, slow: 10 } }] },
}

// ---- 조건식 프리셋 골격 -----------------------------------------------------
//
// 옛 프리셋(고정 유니버스 전제)은 **전부 삭제**했다. 그 성적표는 "오늘의 시총 상위"라는
// 승자편향 표본 위에서 나온 숫자라, 유니버스를 정직하게 바꾼 지금 화면에 그대로 두면
// 서로 다른 전제의 수치를 같은 이름으로 비교하게 된다. 아래 조합들은 **시점 고정 유니버스
// 전제로 다시 매긴** 것이다. 어느 쪽도 매수 권유가 아니다(규칙 4).

/** 프리셋 공통 골격 — 진입 이평·신고가 일수·청산 이평·버퍼만 다르다. */
export function pitPreset(
  id: string,
  name: string,
  source: string,
  maPeriod: number,
  opts: { highDays?: number; exitMa?: number; bufPct?: number } = {},
): StrategySpec {
  const highDays = opts.highDays ?? 20
  const exitMa = opts.exitMa ?? 60
  const bufPct = opts.bufPct ?? 2
  return {
    version: SPEC_VERSION,
    id,
    name,
    source,
    universe: HEROMOON_MOMENTUM.universe, // 종목 목록은 실행 시 그 해 유니버스로 주입된다
    entry: {
      op: 'and',
      nodes: [
        { op: 'cond', id: `${maPeriod}일선돌파`, cond: { kind: 'maCross', period: maPeriod, dir: 'above' } },
        { op: 'cond', id: `${highDays}일신고가`, cond: { kind: 'highBreak', days: highDays } },
      ],
    },
    ranking: { by: 'tradingValue', dir: 'desc' },
    exits: [{ kind: 'maBreak', maPeriod: exitMa, pct: bufPct }],
    sizing: { maxPositions: 10, mode: 'equalSlot' },
    execution: { timing: 'sameClose', orderType: 'market' },
  }
}

/** 현행 기준선 — 지금까지 페이퍼로 추적해 온 조합. 비교의 기준점으로 남긴다. */
export const PRESET_PIT_BASE = pitPreset(
  'pit-ma15-high20-slow60',
  '현행 기준선 — MA15×신고20→60선·버퍼2%',
  '시점 고정 유니버스(연도별 상위 10+10 [추정]) 전제로 재산출한 기준선 — 고정 유니버스 시절 수치와 직접 비교하지 말 것',
  15,
)

/** 21차 탐색에서 수익÷MDD 1위였던 조합. 탐색 자체가 곡선맞춤이므로 "1위"를 실력으로 읽지 않는다. */
export const PRESET_PIT_TOP = pitPreset(
  'pit-ma10-high20-slow60',
  '21차 1위 — MA10×신고20→60선·버퍼2%',
  '2026-08-02 21차 격자 탐색(연도별 상위 10+10 [추정] 유니버스) 수익÷MDD 1위 — 다중비교로 뽑은 1위라 과최적화 위험이 남아 있다',
  10,
)

/**
 * 23차 400조합 확장 격자(2026-08-02)의 수익률 1위 — 총 +5,899% · CAGR 16.7% · **MDD −40.2%** ·
 * 알파 +8.2%p/연 · 매매 1,528. ⚠️ 400개 중 1등을 고른 것 자체가 곡선맞춤이며, 이 조합의 대가는
 * 낙폭이다(−40%를 견뎌야 했다). 2016·2019·2025 등 벤치에 크게 뒤진 해도 있다.
 */
export const PRESET_PIT_MAXRET = pitPreset(
  'pit-ma5-high10-slow80',
  '23차 수익률 1위 — MA5×신고10→80선 (MDD −40%)',
  '2026-08-02 23차 400조합 격자(연도별 상위 10+10 [추정]) 총수익 1위 +5,899% — 다중비교 1등이라 과최적화 위험이 크고, MDD −40.2%가 대가다',
  5,
  { highDays: 10, exitMa: 80, bufPct: 0 },
)

/**
 * 23차 400조합 확장 격자의 수익÷MDD 1위 — 총 +5,442% · CAGR 16.3% · MDD −31.9% · 비율 170 ·
 * 알파 +7.9%p/연 · 매매 1,997. 수익률 1위보다 총수익은 조금 낮고 낙폭이 얕다. 같은 곡선맞춤 경고.
 */
export const PRESET_PIT_MAXRATIO = pitPreset(
  'pit-ma25-high10-slow80',
  '23차 수익÷MDD 1위 — MA25×신고10→80선',
  '2026-08-02 23차 400조합 격자(연도별 상위 10+10 [추정]) 수익÷MDD 1위 170.3 — 다중비교 1등이라 과최적화 위험 상존',
  25,
  { highDays: 10, exitMa: 80, bufPct: 0 },
)

// ---- 전략 유형 --------------------------------------------------------------
//
// 이 화면은 원래 조건식(이평·신고가) 하나만 돌렸다. 2026-08-02 25차 실측에서 이동평균을
// 전혀 쓰지 않는 **횡단면 모멘텀(12-1)** 이 기준선을 크게 앞서서 유형을 하나 더 열었고,
// 26차에서 두 유형을 섞은 **결합**이 전·후반 모두 기준선을 이겨서 세 번째 유형이 열렸다.
// 세 유형은 **같은 연쇄 규약**(연도별 유니버스 교체·연말 이월·현금해 처리·벤치 겹침)을
// 쓰므로 결과가 직접 비교된다.

export type StrategyKind = 'condition' | 'momentum' | 'combo'

/** 모멘텀 모드 파라미터 — 상위 N과 절대모멘텀 게이트뿐이다(그 외는 정본 그대로 고정). */
export interface MomentumParams {
  slots: number
  gate: boolean
}

export const DEFAULT_MOM: MomentumParams = { slots: 5, gate: true }

/** 화면에서 고를 수 있는 보유 종목 수 — 프리셋이 쓰는 값은 여기 전부 들어 있어야 한다. */
export const MOM_SLOT_CHOICES = [3, 4, 5, 6] as const

/** 결합 모드에서 고를 수 있는 슬리브 A 가중. 50:50이 26차 검증 기본안이고 나머지는 민감도 참고다. */
export const COMBO_WEIGHTS = [0.25, 0.5, 0.75] as const
export const DEFAULT_COMBO_WA = 0.5

/** 저장본·프리셋에서 들어온 가중을 허용값으로 좁힌다(임의 값이 새어 들어오면 기본값으로) */
export function normalizeWA(v: number | undefined): number {
  return COMBO_WEIGHTS.includes(v as (typeof COMBO_WEIGHTS)[number]) ? (v as number) : DEFAULT_COMBO_WA
}

export type Preset =
  | { id: string; label: string; kind: 'condition'; spec: StrategySpec; note?: string }
  | { id: string; label: string; kind: 'momentum'; mom: MomentumParams; note: string }
  | { id: string; label: string; kind: 'combo'; spec: StrategySpec; mom: MomentumParams; wA: number; note: string }

/**
 * ⚠️ 모멘텀·결합 프리셋은 전부 **여러 조합 중 성적이 좋았던 것**을 고른 다중비교 승자다.
 * 라벨에 MDD를 함께 적는 이유는, 이 조합들의 대가가 낙폭이기 때문이다 — 수익률만 보고
 * 고르는 것을 막으려고 이름에 박아 둔다(규칙 4).
 */
export const PRESETS: Preset[] = [
  { id: 'pit-base', label: '현행 기준선 MA15×신고20→60선·버퍼2%', kind: 'condition', spec: PRESET_PIT_BASE },
  { id: 'pit-top', label: '21차 1위 MA10×신고20→60선·버퍼2%', kind: 'condition', spec: PRESET_PIT_TOP },
  { id: 'pit-maxret', label: '23차 수익률 1위 MA5×신고10→80선 (MDD −40%)', kind: 'condition', spec: PRESET_PIT_MAXRET },
  { id: 'pit-maxratio', label: '🟢 최소낙폭형 — 추세 단독 MA25×신고10→80선 (23차 수익÷MDD 1위)', kind: 'condition', spec: PRESET_PIT_MAXRATIO },
  {
    id: 'xsmom-5-gate',
    label: '🟡 균형형(주력 후보) — XSM 모멘텀 상위5+게이트 (25차)',
    kind: 'momentum',
    mom: { slots: 5, gate: true },
    note:
      '2026-08-02 25차 실측 — CAGR 30.5% · 알파 +21.9%p/연 · MDD −61% [추정·러너 실행값]. ' +
      '⚠️ 여러 조합(상위 5/10 × 게이트 on/off)을 함께 돌려 그중 성적이 좋았던 것을 고른 **다중비교 승자**라 ' +
      '과최적화 위험이 남아 있고, 이 성적을 얻으려면 자산이 고점 대비 **−61%까지 내려앉는 구간을 견뎌야 했다**. ' +
      '연 20종목 유니버스에서 상위 5는 사실상 상위 25% 분위라 학계의 분위 모멘텀보다 신호가 묽다.',
  },
  {
    id: 'xsmom-5',
    label: '25차 모멘텀 상위5 (MDD −68%)',
    kind: 'momentum',
    mom: { slots: 5, gate: false },
    note:
      '2026-08-02 25차 실측 — 게이트를 끈 변형. MDD −68% [추정·러너 실행값]. ' +
      '⚠️ **다중비교 승자라 과최적화 위험이 있고, −68% 낙폭을 견뎌야 했다.** ' +
      '절대모멘텀 게이트가 없으므로 전 종목이 하락하는 국면에도 상위 5종목을 그대로 들고 간다 — ' +
      '하락장에서 게이트 버전보다 더 깊게 파인다.',
  },
  // ── 2026-08-02 대표 지시 "수익률 높은 거 찾아서 프리셋에 좀 넣어봐"로 추가한 2개.
  //    검증(전·후반 모두 기준선 초과 + 양쪽 알파 양수)을 통과한 것 중 수익률 상위만 넣었다.
  //    "수익률 최고"라서 안전한 것이 아니라, **낙폭이 더 깊어진 대가로** 그 수익이 나왔다.
  {
    id: 'xsmom-3-gate',
    label: '🔴 수익률최대형 — XSM 모멘텀 상위3+게이트 (26차 · 낙폭 최대)',
    kind: 'momentum',
    mom: { slots: 3, gate: true },
    note:
      '2026-08-02 26차 xswf(슬롯 민감도) 실측 — 총 +183,708% · CAGR 32.7% · MDD **−71.1%** · ' +
      '알파 +24.4%p/연 [추정·러너 실행값]. 전·후반 구간 **모두** 기준선을 이겼고 양쪽 알파가 양수다. ' +
      '⚠️ **이 화면에서 수익률이 가장 높은 슬롯이지만, 그 수익의 정체는 집중도이고 집중도가 곧 위험이다.** ' +
      '슬롯이 적을수록 한 종목의 사고(감자·상폐·분식·급락)가 곧바로 전체 자산의 사고가 된다 — ' +
      '25차에서는 반대로 슬롯을 늘린 상위10이 **후반 구간에서 붕괴**했으므로, 슬롯 수는 안전판이 아니라 ' +
      '어느 쪽으로도 무너질 수 있는 손잡이로 봐야 한다. ' +
      '⚠️ **MDD −71.1%는 자산의 3분의 2가 사라지는 구간을 견뎠다는 뜻이다** — 1억이 2,900만 원이 되는 국면을 ' +
      '그대로 통과해야 이 수익이 나온다. 그 구간에서 중단하면 수익은 실현되지 않는다. ' +
      '⚠️ 슬롯 3~10 × 게이트 on/off 등 **12개 변형을 함께 돌려 그중 1등을 고른 다중검정 승자**라, ' +
      '성적이 우연으로 부풀려졌을 위험이 구조적으로 남아 있다(같은 데이터에서 12번 고르면 1등은 늘 나온다). ' +
      '생존편향(상폐 종목 가격 부재)·리밸런스 비용 전제도 그대로 얹혀 있다. **매수 권유가 아니다**(규칙 4).',
  },
  {
    id: 'combo-50',
    label: '🟢 낙폭억제형 — 결합 50:50 추세+모멘텀 (26차)',
    kind: 'combo',
    // 슬리브 A = 23차 수익÷MDD 1위와 **같은 스펙**(MA25돌파×신고10 진입 → 80선 이탈 청산·버퍼 0).
    // 같은 객체를 그대로 쓴다 — 두 프리셋의 스펙이 조용히 갈라지지 않게 하려는 것이다.
    spec: PRESET_PIT_MAXRATIO,
    mom: { slots: 5, gate: true },
    wA: 0.5,
    note:
      '2026-08-02 26차 실측(GHA idea:combo) — 슬리브 A 기준선(MA25×신고10→80선) + 슬리브 B XSM 상위5+게이트를 ' +
      '월초 50:50으로 되돌리는 결합. 총 +32,525% · CAGR 24.3% · MDD −43.1% · 알파 +17.2%p/연 [추정·러너 실행값]로 ' +
      '전·후반 구간 모두 기준선을 이겼다. ' +
      '⚠️ **리밸런스 비용 미반영** — 슬리브 간 이체를 0원으로 본 낙관적 상한이라 실제 성적은 이보다 낮다. ' +
      '⚠️ 분산 효과는 제한적이다: 두 단독 평균 대비 MDD 완화 폭이 **+3.6%p뿐**이고, ' +
      '2008년 같은 위기 구간에서는 두 슬리브 상관이 1에 붙어 **같이 무너졌다** — 정작 분산이 필요한 순간에 사라졌다. ' +
      '슬리브 B(xsmom)의 미장 교차 검증: 상위 20 유니버스(26차)에서는 6변형 전패였으나, ' +
      '**상위 80으로 넓혀 상위 10% 분위를 만든 27차에서는 8변형 전부 전·후반 알파 양(+)** (상위8+게이트 +4.7%p/연) — ' +
      '시장을 건너 생존한다는 방증이 붙었다. 다만 미국 알파(+4.7%p)는 한국(+21.9%p)보다 훨씬 작아, ' +
      '한국 수치는 소형 유니버스·생존편향으로 부풀려졌을 가능성을 같이 봐야 한다. ' +
      '⚠️ A·B 각각이 이미 여러 조합 중 성적이 좋았던 것을 고른 다중비교 승자이고 결합 가중까지 3개를 함께 봤으므로, ' +
      '다중검정으로 부풀려진 성적일 위험이 겹쳐 있다. 매수 권유가 아니다.',
  },
  {
    id: 'combo-25-75',
    label: '🟡 결합 25:75 추세+모멘텀 (26차 · 가중 민감도 참고)',
    kind: 'combo',
    // 슬리브 A = 23차 수익÷MDD 1위와 **같은 스펙 객체**(combo-50과 동일) — 조용히 갈라지지 않게.
    spec: PRESET_PIT_MAXRATIO,
    mom: { slots: 5, gate: true },
    wA: 0.25,
    note:
      '2026-08-02 26차 combo 실측 — 슬리브 A(MA25×신고10→80선) 25 : 슬리브 B(XSM 상위5+게이트) 75 결합. ' +
      '총 +66,525% · CAGR 27.7% · MDD −52.6% · 알파 +19.9%p/연 [추정·러너 실행값]로 전·후반 구간 모두 ' +
      '기준선을 이겼다. ' +
      '⚠️ **가중 3종(25:75 · 50:50 · 75:25)을 함께 보고 그중 수익이 가장 높은 것을 고른 것 자체가 곡선맞춤이다** — ' +
      '25:75가 옳다는 근거가 아니라 이 데이터에서 그랬다는 기록일 뿐이고, 26차 검증 **기본안은 50:50**이다. ' +
      '가중을 모멘텀 쪽으로 기울인 만큼 낙폭도 50:50(−43%)보다 깊다(−52.6%). ' +
      '⚠️ **리밸런스 비용 미반영** — 매월 두 슬리브 편차만큼 사고팔아야 하는 비용을 0원으로 본 낙관적 상한이라 ' +
      '실제 성적은 이보다 낮다. ' +
      '⚠️ 2008년 같은 위기 구간에서는 두 슬리브 상관이 1에 붙어 같이 무너졌다 — 분산이 정작 필요한 순간에 사라졌다. ' +
      'A·B 각각이 이미 다중비교 승자이므로 다중검정 위험이 겹쳐 있다. **매수 권유가 아니다**(규칙 4).',
  },
]
