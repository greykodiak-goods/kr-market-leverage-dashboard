// 조건식 시뮬레이터 — 영웅문 조건검색식의 **2차 검증** 화면.
//
// 워크플로:
//   1차 발굴: 대표가 영웅문4 조건검색으로 아이디어를 찾는다 (HTS)
//   2차 검증: 그 조건식을 여기 옮겨 적으면 **즉시 백테스트**된다 (이 화면)
//   실전 연결: 같은 스펙(JSON)이 그대로 실거래 어댑터의 입력이 된다 (미래 —
//              규칙 2의 단계 승인 후. 지금은 어댑터가 존재하지 않는다)
//
// 조건 판정은 strategySpec.evaluateEntry 하나뿐이다 — 여기서 통과한 조건식과
// 나중에 실시간으로 도는 조건식이 다른 코드를 탈 수 없다.
//
// 실계좌 경계(규칙 2): 이 화면은 시뮬레이션 전용. 주문·브로커·자격증명 없음.

// 2026-08-02 유니버스 전면 교체 (대표 지시):
//   이 화면은 예전에 "오늘의 시총 상위 N"을 표본으로 고정해 돌렸다. 그러면 오늘까지
//   살아남아 커진 종목만 표본에 들어가 성적이 부풀려진다(승자편향) — 같은 조건식이
//   고정 80 유니버스에서 총 +42,103%인데 연도별 그 해 상위 10+10으로 바꾸면 +841%로
//   무너졌다(21차 실측). 그래서 **고정 표본 입력·시총상위 퀵버튼·고정 유니버스 전제
//   프리셋을 전부 제거**하고, 유니버스는 "그 해 연초 상위 10+10" 하나로 고정했다.
//
// 2026-08-03 유니버스 실측 전환 (34차):
//   그 목록은 [추정](pitUniverse.ts PIT1010)이었고, 33차에서 **틀렸다는 것이 드러났다**
//   (xsmom 알파 +21.9%p → 실측 +2.6%p). 목록이 틀리면 그 위에서 고른 파라미터도 같이
//   무효이므로, 화면 실행 경로를 **KRX 실측**(public/data/krx-pit/universe.json ·
//   파서 krxPitUniverse.ts · 파생 krxUniverseSource.ts)으로 바꾸고 프리셋도 34차에서
//   다시 고른 2종으로 전면 교체했다. 실측 파일을 못 읽으면 **[추정]으로 폴백하지 않고
//   실행을 막는다** — 조용한 폴백이 33차와 같은 사고를 눈에 안 띄게 되풀이하기 때문이다.
//   (연쇄 실행 pitChain.ts·xsmomChain.ts는 그대로 — 헤드리스 러너와 같은 코드.)

import { useCallback, useEffect, useMemo, useState } from 'react'
import { BACKTEST_HISTORY_RANGE, KR_LOAD_NOTE, getDailyHistory } from '../../lib/history'
// 시세 소스는 **어댑터 하나**를 통해 고른다(야후 ↔ KRX 일별 정본).
// 사전계산 스크립트도 같은 함수를 쓰므로 화면과 산출물이 다른 소스로 갈릴 수 없다.
import {
  DEFAULT_PRICE_SOURCE,
  MIXED_SOURCE_NOTE,
  PRICE_SOURCES,
  PRICE_SOURCE_LABEL,
  krxFetchDeps,
  loadKrPrices,
  normalizePriceSource,
  probeKrxDaily,
  type PriceSource,
  type PriceSourceMeta,
} from './priceSource'
import type { DailyBar } from './types'
import { EXIT_LABELS, type CostSettings } from './conditionScreen'
import { annualize, runPitChained, yearsBetween, type PitChainResult } from './pitChain'
import { runXsmomChained } from './xsmomChain'
import {
  composeCombo,
  makeMarketGateExposure,
  spliceRegimeCurve,
  summarizeGate,
  toKrwCurve as toKrwSeries,
} from './marketGate'
// 유니버스는 **KRX 실측**(public/data/krx-pit/universe.json)에서 온다 — [추정] 목록(pitUniverse)이
// 아니다. 로드 실패 시 조용한 폴백은 없다(krxUniverseSource.ts 머리말 참조 · 33차 재발 방지).
import type { KrxPitUniverse } from './krxPitUniverse'
import {
  DEFAULT_KRX_WIDTH,
  KRX_TOP_N_CHOICES,
  KRX_UNIVERSE_START_DATE,
  deriveKrxUniverse,
  loadKrxUniverse,
  isDefaultKrxWidth,
  krxWidthLabel,
  normalizeTopN,
  normalizeWidth,
  type DerivedKrxUniverse,
  type KrxWidth,
} from './krxUniverseSource'
import {
  SPEC_VERSION,
  conditionLabel,
  validateSpec,
  type Condition,
  type ConditionNode,
  type ExitRule,
  type StrategySpec,
} from './strategySpec'
// 프리셋 정의는 **UI 무의존 정본**(presets.ts)에서 읽는다 — 사전계산 스크립트
// (scripts/preset-precompute.entry.ts)가 같은 배열을 읽으므로 둘이 갈라질 수 없다.
import {
  BENCH_SYMBOL,
  COMBO_WEIGHTS,
  DEFAULT_COMBO_WA,
  DEFAULT_COST,
  DEFAULT_GOLD_W,
  DEFAULT_MOM,
  FX_SYMBOL,
  GOLD_SYMBOL,
  GOLD_WEIGHTS,
  KOSPI_REGIME,
  KRXCAL_QQQ_WALL,
  MOM_SLOT_CHOICES,
  PRESETS,
  PRESET_BANNER,
  PRESET_FAILED_NOTE,
  PRESET_PIT_BASE,
  REGIME_FALLBACK_SYMBOL,
  normalizeGoldW,
  normalizeWA,
  type MomentumParams,
  type StrategyKind,
} from './presets'
import {
  augmentPresetLabel,
  precomputedToEquityRows,
  usePrecomputedPresets,
  type PrecomputedPreset,
} from './precomputed'
// 표준 성과 지표(변동성·샤프·소르티노·손익비·PF·최장 낙폭 기간) — 순수 계산은 전부 여기 있다.
// 이 화면은 **표시만** 한다(규칙 1: 사후 요약이므로 판정에 되먹임되지 않는다).
import {
  computeCurveStats,
  computeLedgerStats,
  fmtRatio,
  fmtDuration,
  fmtYears,
  type LedgerStats,
  type PerfStatFields,
} from './perfStats'
import { KpiCard } from '../../components/KpiCard'
import { EquityChart, type EquityRow } from './EquityChart'
import { InfoTip } from '../../components/InfoTip'
import { displaySymbol } from '../../lib/krNames'

// ---- 저장 ------------------------------------------------------------------

// v1 저장본에는 고정 표본(symbolsText)과 데이터 범위(range)가 들어 있었다 — 둘 다 사라졌으므로
// 키를 올려 옛 저장본을 불러오지 않는다(지운 입력이 되살아나는 혼선 방지).
//
// v2 → v3 (2026-08-03 · 34차): 유니버스가 [추정] 10+10(2000~)에서 **KRX 실측 10+10(2010~)**으로
// 바뀌었다. 저장된 시작일·전략 유형이 옛 구간 전제로 남아 있으면 새 유니버스 위에서 조용히
// 다른 구간을 돌게 되므로 키를 올려 새로 시작한다.
const STORE_KEY = 'spec-simulator:v3'

interface Saved {
  /** 전략 유형 — 없으면(구 저장본) 조건식 모드 */
  kind?: StrategyKind
  /** 모멘텀 모드 파라미터 — 없으면 기본값 */
  mom?: MomentumParams
  /** 결합 모드의 슬리브 A 가중(0.25·0.5·0.75) — 없으면 기본 0.5 */
  comboWA?: number
  /** 결합 모드에서 B 슬리브에 시장게이트(12-1)를 걸었는지 — 없으면 끔 */
  marketGate?: boolean
  /** 결합 모드의 금(GLD 원화) 슬리브 비중 — 없으면 0(금 없음) */
  goldW?: number
  /** 실측 유니버스 폭 — 시장별 상위 N. 숫자 하나(v3 저장본)면 두 시장 같은 폭으로 읽는다. */
  width?: KrxWidth | number
  /** 국내 종목 시세 소스 — 없으면 기본 야후(KRX 정본 파일이 아직 없다) */
  priceSource?: PriceSource
  spec: StrategySpec
  startDate: string
  /** 종료일 — 이 날짜 이후 봉을 잘라내고 실행한다. 없거나 빈 문자열이면 데이터 끝까지.
   *  기존 저장본(v1)에는 없는 필드라 **옵션**으로 둔다(STORE_KEY 버전을 올리지 않는다). */
  endDate?: string
  cost: CostSettings
}

// 비용 기본값·판정 벤치(KODEX 200)·레짐 게이트는 presets.ts가 정본이다 —
// 사전계산 스크립트가 같은 상수로 돌아야 두 수치가 비교된다.

// 참고 벤치(2026-08-02 대표 지시) — QQQ를 원화로 환산해 **나란히 보기만** 한다.
// ⚠️ 알파(규칙 5) 판정 기준은 여전히 KODEX 200이다. QQQ는 판정에 들어가지 않는다 —
//    통화·시장·거래시간이 다른 자산을 판정 기준으로 섞으면 알파의 의미가 무너진다.
const QQQ_SYMBOL = 'QQQ'
// USD/KRW 일봉 종가(결측일은 직전값 이월)는 참고 벤치(QQQ)와 금 슬리브가 **같은 심볼**을 쓴다 —
// presets.ts의 FX_SYMBOL 하나만 정본으로 두고 여기서 다시 정의하지 않는다.
const QQQ_LABEL = 'QQQ(원화 환산)'
// QLD(나스닥100 **일일 2배 레버리지**) 참고 벤치 — 2026-08-03 대표 지시. ⚠️ 규칙 4:
// 레버리지 ETF는 변동성 잠식(횡보장에서 2배 일일 복리가 원금을 갉음)·극단 낙폭(2008 −8x%,
// 2022 −6x%)이 구조적이며, 운용사 스스로 장기 보유 상품이 아니라고 고지한다. 판정 미반영.
const QLD_SYMBOL = 'QLD'
const QLD_LABEL = 'QLD(원화 환산 · 2배 레버리지)'

// ---- 유니버스 로드 (KRX 실측) ----------------------------------------------
//
// 유니버스는 이제 **런타임에 파일에서** 온다(모듈 상수가 아니다). 그래서 로딩·실패 상태가
// 생겼고, 화면은 그 셋을 구분해 보여준다: 로딩 중 / 준비됨 / **실패(실행 불가)**.
//
// ⚠️ 실패 시 [추정] 목록으로 내려가지 않는다. 33차가 무너진 경로가 "틀린 목록 위에서 조용히
//    계속 도는 것"이었고, 폴백은 그 사고를 눈에 안 띄게 재발시키는 장치다.

type UniverseState =
  | { status: 'loading' }
  | { status: 'ready'; uni: KrxPitUniverse }
  | { status: 'error'; message: string }

/** 실측 유니버스 파일을 한 번 읽는다. 실패는 삼키지 않고 상태로 남긴다. */
function useKrxUniverseFile(): UniverseState {
  const [state, setState] = useState<UniverseState>({ status: 'loading' })
  useEffect(() => {
    let alive = true
    loadKrxUniverse(import.meta.env.BASE_URL, (url) => fetch(url))
      .then((uni) => {
        if (alive) setState({ status: 'ready', uni })
      })
      .catch((e: unknown) => {
        if (alive) setState({ status: 'error', message: e instanceof Error ? e.message : String(e) })
      })
    return () => {
      alive = false
    }
  }, [])
  return state
}

// ---- 시세 소스 준비 상태 (KRX 일별 정본) ------------------------------------
//
// KRX 정본은 EC2가 수집해 리포에 커밋하는 정적 파일이라 **아직 없을 수 있다.**
// 그래서 화면은 먼저 "쓸 수 있는지"만 확인하고, 못 쓰면 그 사유를 그대로 보여주며
// 실행 버튼을 막는다 — 야후로 조용히 대신 돌리지 않는다(소스가 바뀌면 총수익/가격수익이
// 섞여 표가 거짓이 된다). 유니버스와 **같은 철학**이다.

type KrxDailyState =
  | { status: 'loading' }
  | { status: 'ready'; note: string; from: string; to: string; stocks: number }
  /** 파일이 아직 없다(수집 전) — 안내 문구가 "무엇을 하면 되는지"를 말한다 */
  | { status: 'missing'; reason: string }
  /** 파일이 깨졌다(스키마 위반·HTTP 오류) — 수집 전과 다음 행동이 다르다 */
  | { status: 'error'; reason: string }

function useKrxDailyStatus(): KrxDailyState {
  const [state, setState] = useState<KrxDailyState>({ status: 'loading' })
  useEffect(() => {
    let alive = true
    probeKrxDaily(krxFetchDeps(import.meta.env.BASE_URL, (url) => fetch(url)))
      .then((s) => {
        if (!alive) return
        if (s.ready)
          setState({
            status: 'ready',
            note: s.note,
            from: s.index.from,
            to: s.index.to,
            stocks: s.index.stocks.length,
          })
        else setState({ status: s.missing ? 'missing' : 'error', reason: s.reason })
      })
      .catch((e: unknown) => {
        if (alive) setState({ status: 'error', reason: e instanceof Error ? e.message : String(e) })
      })
    return () => {
      alive = false
    }
  }, [])
  return state
}

// ---- 프리셋 ----------------------------------------------------------------
//
// 프리셋 정의(조건식·모멘텀·결합)와 유형 타입은 **presets.ts가 정본**이다.
// 화면과 헤드리스 사전계산(scripts/preset-precompute.entry.ts)이 같은 배열을 읽어야
// 목록과 사전계산 산출물이 조용히 갈라지지 않는다. 여기서는 화면 전용 상태만 다룬다.

/**
 * 결합 모드에서 **각 슬리브를 단독으로** 돌린 성적. 결합 곡선은 두 곡선의 합성이라
 * 매매 원장이 어느 쪽에도 귀속되지 않는다 — 매매수·승률은 여기서만 읽을 수 있다.
 */
interface SleeveSummary {
  key: 'A' | 'B'
  label: string
  totalPct: number
  cagrPct: number
  mddPct: number
  alphaCagrPct: number | null
  tradeCount: number
  winRate: number | null
}

function loadSaved(): Saved {
  try {
    const raw = localStorage.getItem(STORE_KEY)
    if (raw) {
      const s = JSON.parse(raw) as Saved
      // endDate가 없는 구 저장본도 그대로 받는다(하위 호환)
      if (s.spec?.version === SPEC_VERSION)
        return {
          ...s,
          cost: s.cost ?? DEFAULT_COST,
          endDate: s.endDate ?? '',
          kind: s.kind === 'momentum' || s.kind === 'combo' ? s.kind : 'condition',
          mom: s.mom ?? DEFAULT_MOM,
          comboWA: normalizeWA(s.comboWA),
          marketGate: s.marketGate === true,
          goldW: normalizeGoldW(s.goldW),
          width: normalizeWidth((s as unknown as { width?: unknown; topN?: unknown }).width ?? (s as unknown as { topN?: unknown }).topN),
          priceSource: normalizePriceSource(s.priceSource),
        }
    }
  } catch {
    /* 손상 저장본은 기본값으로 */
  }
  return {
    // 기본 유형은 **모멘텀**이다 — 34차 판정을 통과한 프리셋 2종이 둘 다 모멘텀이라
    // 기본 화면 상태가 실제 프리셋과 같은 계열을 가리키게 맞춘다.
    // ('combo' 선택지는 그대로 남아 있다 — 연구·향후 재검증용.)
    kind: 'momentum',
    mom: DEFAULT_MOM,
    comboWA: DEFAULT_COMBO_WA,
    marketGate: false,
    goldW: DEFAULT_GOLD_W,
    width: { ...DEFAULT_KRX_WIDTH },
    // 기본은 **야후**다 — KRX 일별 정본 파일이 아직 리포에 없다(EC2 수집 중).
    // 데이터가 도착하면 기본값 전환은 총괄이 판단한다(화면이 먼저 넘어가면 실행 불가가 된다).
    priceSource: DEFAULT_PRICE_SOURCE,
    // 조건식 편집기의 시작 스펙일 뿐, 화면 프리셋 목록에는 없다(34차에서 조건식 계열은 전멸).
    spec: PRESET_PIT_BASE,
    // 실측 유니버스가 덮는 첫 해와 맞춘다(2010~). 옛 기본값은 ''(데이터 전 구간)이었다.
    startDate: KRX_UNIVERSE_START_DATE,
    endDate: '',
    cost: DEFAULT_COST,
  }
}

// ---- 조건 편집 (평탄한 AND 목록) -------------------------------------------
//
// 영웅문 조건식은 대부분 "A and B and C" 꼴이라 평탄한 목록 편집으로 충분하다.
// OR·NOT이 섞인 고급 트리는 JSON 편집으로만 다루고, 화면에는 읽기 전용 요약을 보여준다.

interface FlatCond {
  id?: string
  cond: Condition
}

function asFlatAnd(node: ConditionNode): FlatCond[] | null {
  if (node.op !== 'and') return null
  const out: FlatCond[] = []
  for (const n of node.nodes) {
    if (n.op !== 'cond') return null
    out.push({ id: n.id, cond: n.cond })
  }
  return out
}

function toEntry(flat: FlatCond[]): ConditionNode {
  return { op: 'and', nodes: flat.map((f) => ({ op: 'cond' as const, id: f.id, cond: f.cond })) }
}

const KIND_MENU: { kind: Condition['kind']; label: string; make: () => Condition }[] = [
  { kind: 'changeRank', label: '등락률 상위 N위', make: () => ({ kind: 'changeRank', top: 100 }) },
  { kind: 'changePct', label: '등락률 범위(%)', make: () => ({ kind: 'changePct', min: 3 }) },
  { kind: 'priceRange', label: '주가 범위(원)', make: () => ({ kind: 'priceRange', min: 2000, max: 50000 }) },
  { kind: 'candle', label: '양봉/음봉', make: () => ({ kind: 'candle', bull: true }) },
  { kind: 'maCross', label: '이평 돌파', make: () => ({ kind: 'maCross', period: 5, dir: 'above' }) },
  { kind: 'maPosition', label: '이평 위/아래 위치', make: () => ({ kind: 'maPosition', period: 20, dir: 'above' }) },
  { kind: 'maAlign', label: '이평 정배열', make: () => ({ kind: 'maAlign', fast: 5, slow: 10 }) },
  { kind: 'volume', label: '거래량 하한(주)', make: () => ({ kind: 'volume', min: 300_000 }) },
  { kind: 'tradingValue', label: '거래대금 하한(원)', make: () => ({ kind: 'tradingValue', min: 1e10 }) },
  { kind: 'volumeSurge', label: '거래량 급증(배)', make: () => ({ kind: 'volumeSurge', days: 20, ratio: 3 }) },
  { kind: 'disparity', label: '이격도(%)', make: () => ({ kind: 'disparity', period: 20, min: 100 }) },
  { kind: 'rsi', label: 'RSI', make: () => ({ kind: 'rsi', period: 14, max: 70 }) },
  { kind: 'highBreak', label: 'N일 신고가 돌파', make: () => ({ kind: 'highBreak', days: 20 }) },
  { kind: 'lowBreak', label: 'N일 신저가 이탈', make: () => ({ kind: 'lowBreak', days: 20 }) },
  { kind: 'streak', label: '연속 상승/하락', make: () => ({ kind: 'streak', dir: 'up', days: 3 }) },
]

/**
 * 숫자 입력 공용 컴포넌트 — 이 화면의 **모든** 숫자 칸이 이걸 쓴다.
 *
 * 왜 로컬 문자열 상태인가 (2026-07-31 대표 실측 버그):
 *   컨트롤드 number 인풋이 입력값을 매 키 입력마다 숫자로 파싱해 되돌리면, 빈 문자열을
 *   숫자로 만들 수 없어 마지막 한 자리가 지워지지 않는다 — "34"에서 4는 지워지는데
 *   3이 안 지워진다. 그래서 **입력 중에는 문자열을 그대로 두고**(빈 값·"1."·"-" 허용),
 *   blur·Enter 시점에만 파싱해 스펙에 반영한다. 파싱 불가·빈 값이면 직전 유효값을 유지한다.
 *
 * 왜 type=text인가:
 *   type=number는 "1."·"-"·"1e" 같은 중간 상태에서 브라우저가 value를 ''로 돌려주는
 *   경우가 있어(bad input) 로컬 문자열 방식과 궁합이 나쁘다. 대신 inputMode로 모바일
 *   숫자 키패드를 띄우고(정수=numeric, 소수=decimal), ↑↓ 키 증감은 직접 구현한다.
 */
function Num({
  value,
  onChange,
  title,
  step = 1,
  optional = false,
  integer = false,
  min,
  max,
}: {
  value: number | undefined
  onChange: (v: number | undefined) => void
  title: string
  /** ↑↓ 키 증감 폭 */
  step?: number
  /** 비울 수 있는 값(비우면 undefined로 반영) */
  optional?: boolean
  /** 정수 전용 — 모바일 키패드를 numeric으로, 커밋 시 반올림 */
  integer?: boolean
  min?: number
  max?: number
}) {
  const shown = value == null ? '' : String(value)
  const [text, setText] = useState(shown)
  const [editing, setEditing] = useState(false)

  // 외부에서 값이 바뀌면(프리셋 불러오기·JSON 적용 등) 표시를 맞춘다.
  // 편집 중에는 손대지 않는다 — 사용자가 지우는 중인 글자를 되돌리면 위 버그가 재발한다.
  useEffect(() => {
    if (!editing) setText(value == null ? '' : String(value))
  }, [value, editing])

  /** 문자열 → 숫자 확정. 실패하면 직전 유효값으로 되돌린다. */
  function commit(raw: string) {
    const t = raw.trim().replace(/,/g, '')
    if (t === '') {
      if (optional) {
        setText('')
        onChange(undefined)
      } else {
        setText(value == null ? '' : String(value)) // 필수 칸은 비울 수 없다 → 직전 값 복원
      }
      return
    }
    const n = Number(t)
    if (!Number.isFinite(n)) {
      setText(value == null ? '' : String(value))
      return
    }
    let v = integer ? Math.round(n) : n
    if (min != null && v < min) v = min
    if (max != null && v > max) v = max
    setText(String(v))
    if (v !== value) onChange(v)
  }

  function bump(dir: 1 | -1) {
    const base = Number(text.trim() === '' ? (value ?? 0) : text)
    const cur = Number.isFinite(base) ? base : (value ?? 0)
    // 부동소수 누적오차 정리 (0.1 + 0.2 → 0.30000000000000004 방지)
    commit(String(Math.round((cur + dir * step) * 1e6) / 1e6))
  }

  return (
    <input
      type="text"
      className="bt-num"
      inputMode={integer ? 'numeric' : 'decimal'}
      value={text}
      placeholder={optional ? '—' : undefined}
      title={title}
      aria-label={title}
      autoComplete="off"
      onFocus={() => setEditing(true)}
      onChange={(e) => setText(e.target.value)} // 입력 중에는 검증하지 않는다
      onBlur={(e) => {
        setEditing(false)
        commit(e.target.value)
      }}
      onKeyDown={(e) => {
        if (e.key === 'ArrowUp') {
          e.preventDefault()
          bump(1)
        } else if (e.key === 'ArrowDown') {
          e.preventDefault()
          bump(-1)
        } else if (e.key === 'Enter') {
          e.currentTarget.blur() // blur에서 커밋된다
        }
      }}
    />
  )
}

function CondFields({ cond, onChange }: { cond: Condition; onChange: (c: Condition) => void }) {
  switch (cond.kind) {
    case 'priceRange':
      return (
        <>
          <Num value={cond.min} onChange={(min) => onChange({ ...cond, min })} title="하한(원)" step={100} integer min={0} optional />
          <span>~</span>
          <Num value={cond.max} onChange={(max) => onChange({ ...cond, max })} title="상한(원)" step={100} integer min={0} optional />
          <span>원</span>
        </>
      )
    case 'changeRank':
      return (
        <>
          <span>상위</span>
          <Num value={cond.top} onChange={(top) => onChange({ ...cond, top: top ?? 100 })} title="순위" integer min={1} />
          <span>위 이내</span>
        </>
      )
    case 'changePct':
      return (
        <>
          <Num value={cond.min} onChange={(min) => onChange({ ...cond, min })} title="하한(%)" step={0.5} optional />
          <span>~</span>
          <Num value={cond.max} onChange={(max) => onChange({ ...cond, max })} title="상한(%)" step={0.5} optional />
          <span>%</span>
        </>
      )
    case 'candle':
      return (
        <select value={cond.bull ? 'bull' : 'bear'} onChange={(e) => onChange({ ...cond, bull: e.target.value === 'bull' })}>
          <option value="bull">양봉</option>
          <option value="bear">음봉</option>
        </select>
      )
    case 'maCross':
    case 'maPosition':
      return (
        <>
          <Num value={cond.period} onChange={(period) => onChange({ ...cond, period: period ?? 5 })} title="이평 기간(일)" integer min={1} />
          <span>일선</span>
          <select value={cond.dir} onChange={(e) => onChange({ ...cond, dir: e.target.value as 'above' | 'below' })}>
            {cond.kind === 'maCross' ? (
              <>
                <option value="above">상향 돌파</option>
                <option value="below">하향 돌파</option>
              </>
            ) : (
              <>
                <option value="above">위</option>
                <option value="below">아래</option>
              </>
            )}
          </select>
        </>
      )
    case 'maAlign':
      return (
        <>
          <Num value={cond.fast} onChange={(fast) => onChange({ ...cond, fast: fast ?? 5 })} title="단기 이평(일)" integer min={1} />
          <span>일선 &gt;</span>
          <Num value={cond.slow} onChange={(slow) => onChange({ ...cond, slow: slow ?? 10 })} title="장기 이평(일)" integer min={1} />
          <span>일선 (정배열)</span>
        </>
      )
    case 'volume':
      return (
        <>
          <Num value={cond.min} onChange={(min) => onChange({ ...cond, min: min ?? 0 })} title="거래량 하한(주)" step={10000} integer min={0} />
          <span>주 이상</span>
        </>
      )
    case 'tradingValue':
      return (
        <>
          <Num value={cond.min} onChange={(min) => onChange({ ...cond, min: min ?? 0 })} title="거래대금 하한(원)" step={1e8} integer min={0} />
          <span>원 이상</span>
        </>
      )
    case 'volumeSurge':
      return (
        <>
          <span>직전</span>
          <Num value={cond.days} onChange={(days) => onChange({ ...cond, days: days ?? 20 })} title="평균 산출 일수" integer min={1} />
          <span>일 평균의</span>
          <Num value={cond.ratio} onChange={(ratio) => onChange({ ...cond, ratio: ratio ?? 2 })} title="배수" step={0.5} min={0} />
          <span>배 이상</span>
        </>
      )
    case 'disparity':
      return (
        <>
          <Num value={cond.period} onChange={(period) => onChange({ ...cond, period: period ?? 20 })} title="이평 기간(일)" integer min={1} />
          <span>일 이격도</span>
          <Num value={cond.min} onChange={(min) => onChange({ ...cond, min })} title="하한(%)" step={0.5} optional />
          <span>~</span>
          <Num value={cond.max} onChange={(max) => onChange({ ...cond, max })} title="상한(%)" step={0.5} optional />
        </>
      )
    case 'rsi':
      return (
        <>
          <span>RSI(</span>
          <Num value={cond.period} onChange={(period) => onChange({ ...cond, period: period ?? 14 })} title="기간(일)" integer min={1} />
          <span>)</span>
          <Num value={cond.min} onChange={(min) => onChange({ ...cond, min })} title="하한" min={0} max={100} optional />
          <span>~</span>
          <Num value={cond.max} onChange={(max) => onChange({ ...cond, max })} title="상한" min={0} max={100} optional />
        </>
      )
    case 'highBreak':
    case 'lowBreak':
      return (
        <>
          <Num value={cond.days} onChange={(days) => onChange({ ...cond, days: days ?? 20 })} title="기간(일)" integer min={1} />
          <span>{cond.kind === 'highBreak' ? '일 신고가 돌파(당일 제외 직전 극값 기준)' : '일 신저가 이탈'}</span>
        </>
      )
    case 'streak':
      return (
        <>
          <Num value={cond.days} onChange={(days) => onChange({ ...cond, days: days ?? 3 })} title="연속 일수" integer min={1} />
          <span>일 연속</span>
          <select value={cond.dir} onChange={(e) => onChange({ ...cond, dir: e.target.value as 'up' | 'down' })}>
            <option value="up">상승</option>
            <option value="down">하락</option>
          </select>
        </>
      )
  }
}

// ---- 매도 규칙 편집 --------------------------------------------------------

const EXIT_MENU: { label: string; make: () => ExitRule }[] = [
  { label: '손절 −X%', make: () => ({ kind: 'stopLoss', pct: 3 }) },
  { label: '익절 +X%', make: () => ({ kind: 'takeProfit', pct: 5 }) },
  { label: '이평 이탈', make: () => ({ kind: 'maBreak', maPeriod: 5 }) },
  { label: '당일 종가 청산', make: () => ({ kind: 'sameDayClose' }) },
  { label: 'N일 보유 후 청산', make: () => ({ kind: 'timeExit', days: 3 }) },
  { label: '트레일링 −X%', make: () => ({ kind: 'trailing', pct: 5 }) },
  { label: '조건 이탈 시 청산', make: () => ({ kind: 'conditionExit' }) },
]

function ExitFields({ rule, onChange }: { rule: ExitRule; onChange: (r: ExitRule) => void }) {
  switch (rule.kind) {
    case 'stopLoss':
    case 'takeProfit':
    case 'trailing':
      return (
        <>
          <Num value={rule.pct} onChange={(pct) => onChange({ ...rule, pct: pct ?? 3 })} title="%" step={0.5} min={0} />
          <span>%</span>
        </>
      )
    case 'maBreak':
      return (
        <>
          <Num
            value={rule.maPeriod}
            onChange={(maPeriod) => onChange({ ...rule, maPeriod: maPeriod ?? 5 })}
            title="이평 기간(일)"
            integer
            min={1}
          />
          <span>일선</span>
          <Num value={rule.pct} onChange={(pct) => onChange({ ...rule, pct })} title="이탈 버퍼(%) — 비우면 버퍼 없음" step={0.5} min={0} optional />
          <span>% 버퍼</span>
        </>
      )
    case 'timeExit':
      return (
        <>
          <Num value={rule.days} onChange={(days) => onChange({ ...rule, days: days ?? 3 })} title="보유 거래일" integer min={1} />
          <span>거래일</span>
        </>
      )
    default:
      return null
  }
}

// ---- 본체 ------------------------------------------------------------------

/** 원화 환산 QQQ 곡선의 한 점 */
interface FxPoint {
  date: string
  /** QQQ 총수익 보정 종가 × 그 시점 USD/KRW */
  krw: number
}

/**
 * QQQ(총수익 보정 종가)를 USD/KRW로 곱해 **원화 곡선**으로 만든다.
 * 환율은 거래일이 어긋나므로 `date` 이하의 마지막 환율을 이월해 쓴다(결측일 직전값 이월).
 * 환율이 아직 시작되지 않은 앞 구간은 환산할 값이 없으므로 버린다 — 임의로 채우면
 * 그 구간 비교가 거짓이 된다.
 *
 * ⚠️ 환헤지·거래비용·세금 미반영. 참고 표시 전용이며 알파 판정에 쓰지 않는다.
 */
function toKrwCurve(qqq: DailyBar[], fx: DailyBar[]): FxPoint[] {
  if (qqq.length === 0 || fx.length === 0) return []
  const out: FxPoint[] = []
  let j = 0
  let rate = 0
  for (const b of qqq) {
    while (j < fx.length && fx[j].date <= b.date) {
      if (fx[j].c > 0) rate = fx[j].c
      j++
    }
    if (rate > 0 && b.c > 0) out.push({ date: b.date, krw: b.c * rate })
  }
  return out
}

const fmtPct = (v: number, digits = 1) => `${v >= 0 ? '+' : ''}${v.toFixed(digits)}%`
const fmtWon = (v: number | null | undefined) => (v == null ? '—' : Math.round(v).toLocaleString('ko-KR'))
/** 자릿수 구분 — 총 수익률이 네 자리 %를 넘으면 구분 없이는 읽히지 않는다 */
const fmtPctGrouped = (v: number, digits = 1) =>
  `${v >= 0 ? '+' : '−'}${Math.abs(v).toLocaleString('ko-KR', { minimumFractionDigits: digits, maximumFractionDigits: digits })}%`
const fmtPp = (v: number, digits = 1) =>
  `${v >= 0 ? '+' : '−'}${Math.abs(v).toLocaleString('ko-KR', { minimumFractionDigits: digits, maximumFractionDigits: digits })}%p`

// ---- 표준 성과 지표 카드 (실행 결과·사전계산 **공용**) ---------------------------
//
// 대표 지시(2026-08-02): "나오는 지표들 다 넣어주고 지표 설명 아이콘도 추가해줘".
// 두 화면이 같은 컴포넌트를 쓰므로 정의·설명이 갈라질 수 없다. 계산은 perfStats.ts,
// 여기서는 **표시와 설명(ⓘ)만** 한다. 계산 불가는 0이 아니라 '—'다(규칙 3).

/** 원장이 이 결과에 귀속될 때만 채워지는 상세(평균 손익·손익 합) — 사전계산 경로엔 없다. */
interface LedgerDetail {
  avgWinPct: number | null
  avgLossPct: number | null
  grossProfit: number
  grossLoss: number
  winCount: number
  lossCount: number
}

function ledgerDetailOf(l: LedgerStats): LedgerDetail {
  return {
    avgWinPct: l.avgWinPct,
    avgLossPct: l.avgLossPct,
    grossProfit: l.grossProfit,
    grossLoss: l.grossLoss,
    winCount: l.winCount,
    lossCount: l.lossCount,
  }
}

function PerfStatCards({
  stats,
  detail,
  ledgerAttributed,
  legacyNote,
}: {
  stats: Partial<PerfStatFields>
  /** 실행 결과에서만 채워진다(사전계산 산출물엔 스칼라만 있다) */
  detail?: LedgerDetail | null
  /** 결합(곡선 합성)처럼 매매 원장이 귀속되지 않는 결과면 false — 0건이라는 뜻이 아니다 */
  ledgerAttributed: boolean
  /** 옛 스키마 산출물이라 값 자체가 없을 때 카드에 적을 설명 */
  legacyNote?: string
}) {
  const missing = legacyNote ?? '계산할 수 없습니다'
  const ledgerBlockedText = '결합 곡선에는 매매 원장이 없습니다 — A·B 단독 실행에서 확인하세요'
  return (
    <>
      <KpiCard
        label="연환산 변동성"
        value={stats.volAnnPct != null ? `${stats.volAnnPct.toFixed(1)}%` : '—'}
        unit=" / 연"
        changeText={stats.volAnnPct != null ? '일수익률 표준편차 × √252' : missing}
        changeLabel=""
        direction="flat"
        info="하루하루의 수익률이 평균에서 얼마나 흩어졌는지(표준편차)를 재서 1년치로 환산한(×√252) 값입니다. 20%면 '1년 수익률이 평균 ±20% 안에 들어올 때가 대략 3분의 2'라는 거친 눈금으로 읽습니다. 함정: 위아래를 구분하지 않아 급등도 변동성으로 잡히고, 드물게 오는 폭락(꼬리 위험)은 이 한 숫자에 담기지 않습니다. 체감 고통은 최대 낙폭(MDD)·최장 낙폭 기간과 함께 보세요."
      />
      <KpiCard
        label="샤프 비율"
        value={fmtRatio(stats.sharpe)}
        changeText={
          stats.sharpe != null
            ? '(연평균 수익률 − 무위험 0%) ÷ 연환산 변동성'
            : stats.volAnnPct != null
              ? '변동성이 0이라 나눌 수 없습니다'
              : missing
        }
        changeLabel=""
        direction="flat"
        badge="무위험 0% 가정"
        badgeTitle="무위험수익률을 상수 0%로 두고 계산했습니다 — 외부 금리 데이터에 의존하지 않기 위한 단순화입니다. 실제 국고채 수익률(예: 연 3%)만큼 이 값은 낮아집니다."
        info="연평균 수익률(CAGR)에서 무위험수익률을 뺀 뒤 연환산 변동성으로 나눈 값입니다. '흔들림 1단위를 감수하고 얼마를 벌었나'로 읽으며, 수익이 같다면 덜 흔들린 쪽이 높게 나옵니다. ⚠️ 여기서는 무위험수익률을 0%로 가정합니다 — 실제 국고채 수익률만큼 낮아집니다. 함정: 분모가 오르는 흔들림까지 벌점으로 세기 때문에 크게 오른 구간이 있으면 오히려 낮아 보일 수 있습니다. 또 이 값이 높은 조합을 골라내는 행위 자체가 곡선맞춤이라, 구간을 나눠도 유지되는지 함께 보세요(규칙 5)."
      />
      <KpiCard
        label="소르티노 비율"
        value={fmtRatio(stats.sortino)}
        changeText={stats.sortino != null ? '(연평균 수익률 − 무위험 0%) ÷ 하방 변동성' : missing}
        changeLabel=""
        direction="flat"
        badge="무위험 0% 가정"
        badgeTitle="샤프와 같은 가정입니다 — 무위험수익률 0%. 실제 국고채 수익률만큼 낮아집니다."
        info="샤프의 분모를 '떨어진 날의 흔들림'만으로 바꾼 값입니다(음(−)의 일수익률만 제곱평균해 연환산). 오르는 변동은 벌점이 아니라고 보기 때문에, 위로 크게 튀는 전략은 샤프보다 소르티노가 높게 나옵니다. 샤프와 같은 무위험수익률 0% 가정입니다. 함정: 하락한 날이 적은 짧은 구간에서는 분모 표본이 작아 값이 과장됩니다. 하락일이 하나도 없으면 계산하지 않고 '—'로 둡니다."
      />
      <KpiCard
        label="손익비 (Payoff)"
        value={ledgerAttributed ? fmtRatio(stats.payoffRatio) : '합성'}
        changeText={
          !ledgerAttributed
            ? ledgerBlockedText
            : stats.payoffRatio != null
              ? detail
                ? `평균 이익 ${detail.avgWinPct != null ? fmtPct(detail.avgWinPct, 2) : '—'} ÷ 평균 손실 ${detail.avgLossPct != null ? fmtPct(detail.avgLossPct, 2) : '—'}`
                : '평균 이익% ÷ |평균 손실%|'
              : detail && detail.lossCount === 0
                ? '손실 매매가 0건이라 나눌 수 없습니다 (∞로 채우지 않습니다)'
                : missing
        }
        changeLabel=""
        direction="flat"
        info="청산이 끝난 매매만 모아 '이익 매매의 평균 수익률'을 '손실 매매의 평균 손실률(절대값)'로 나눈 값입니다. 2라면 한 번 벌 때 잃을 때의 두 배를 벌었다는 뜻입니다. 승률과 짝으로 봐야 합니다 — 승률이 낮아도 손익비가 크면 합계는 남을 수 있고, 승률이 높아도 손익비가 1보다 많이 작으면 한 번의 손실이 여러 번의 이익을 지웁니다. 손실 매매가 0건이면 나눌 수 없어 '—'입니다(∞로 채우지 않습니다). 미청산 포지션은 확정 손익이 아니라 제외했습니다."
      />
      <KpiCard
        label="Profit Factor"
        value={ledgerAttributed ? fmtRatio(stats.profitFactor) : '합성'}
        changeText={
          !ledgerAttributed
            ? ledgerBlockedText
            : stats.profitFactor != null
              ? detail
                ? `이익합 ${fmtWon(detail.grossProfit)}원 ÷ 손실합 ${fmtWon(detail.grossLoss)}원`
                : '이익 매매 손익 합 ÷ |손실 매매 손익 합|'
              : detail && detail.lossCount === 0
                ? '손실 매매가 0건이라 나눌 수 없습니다 (∞로 채우지 않습니다)'
                : missing
        }
        changeLabel=""
        direction="flat"
        info="이익 매매의 손익 합(원)을 손실 매매의 손익 합(원, 절대값)으로 나눈 값입니다. 손익비가 '한 번당 평균'을 본다면 이쪽은 '기간 전체 금액'을 봅니다. 1이면 번 돈과 잃은 돈이 같고(수수료·세금·슬리피지 반영 후), 1보다 크면 남았다는 뜻입니다. 함정: 큰 이익 한 건이 값을 통째로 끌어올릴 수 있으므로 매매 건수와 함께 보세요 — 표본이 수십 건 이하면 우연일 가능성이 큽니다. 손실 매매가 0건이면 '—'입니다."
      />
      <KpiCard
        label="최장 낙폭 기간"
        value={fmtDuration(stats.maxDdDays)}
        unit={stats.maxDdDays != null ? ` · ${fmtYears(stats.maxDdDays)}` : ''}
        changeText={
          stats.maxDdDays == null
            ? missing
            : stats.maxDdStart && stats.maxDdEnd
              ? `${stats.maxDdStart} 고점 → ${stats.maxDdEnd}${stats.maxDdRecovered === false ? ' (아직 회복 못함)' : ' 회복'}`
              : stats.maxDdRecovered === false
                ? '마지막 날까지 회복하지 못했습니다'
                : '고점 회복까지 걸린 최장 기간'
        }
        changeLabel=""
        direction="flat"
        badge={stats.maxDdRecovered === false ? '⚠️ 미회복 구간 포함' : undefined}
        badgeTitle="마지막 날까지 직전 고점을 회복하지 못한 구간이 최장 기간입니다 — 즉 지금도 물려 있는 상태로 셌습니다."
        info="자산곡선이 최고점을 찍은 뒤 그 최고점을 다시 회복하기까지 걸린 가장 긴 시간입니다. 최대 낙폭(MDD)이 '얼마나 깊이 빠졌나'라면 이 값은 '얼마나 오래 물려 있었나' — 돈이 아니라 시간의 고통입니다. 깊이가 얕아도 회복에 몇 년이 걸리면 그동안 계좌는 계속 마이너스로 보이고, 중도 이탈은 대개 여기서 일어납니다. 마지막 날까지 회복하지 못한 구간도 포함해 셉니다(진행 중이라고 빼면 '지금 물려 있는 기간'이 통계에서 사라집니다)."
      />
    </>
  )
}

/**
 * 사전계산 결과 화면 — 프리셋을 고르는 즉시 뜨는 요약이다.
 *
 * 왜 별도 블록인가(규칙 3): 실행 결과와 **전제가 다르다**. 기준일이 과거일 수 있고,
 * 곡선은 주 1점으로 줄였으며, 연도별 분해·매매 이력은 산출물에 없다. 같은 화면에
 * 섞어 놓으면 "지금 돌린 결과"로 오해된다 — 그래서 배지·한계·재실행 버튼을 함께 둔다.
 * 카드·차트 컴포넌트(KpiCard·EquityChart)는 실행 결과 화면과 **같은 것**을 쓴다.
 */
function PrecomputedResult({
  pc,
  asOf,
  computedAt,
  mismatch,
  busy,
  onRerun,
}: {
  pc: PrecomputedPreset
  asOf: string
  computedAt: string
  /** 지금 화면 설정이 사전계산 전제와 다른 부분(없으면 null) */
  mismatch: string | null
  busy: boolean
  onRerun: () => void
}) {
  const rows = useMemo(() => precomputedToEquityRows(pc), [pc])
  return (
    <div className="bt-results">
      <div className="bt-chart-caption">
        <span className="badge sample">사전계산 (asOf {asOf || '—'}) · [추정]</span>{' '}
        <strong>{pc.label}</strong> — 미리 돌려 저장해 둔 결과입니다(지금 실행한 것이 아닙니다).
        구간 {pc.startDate}~{pc.endDate} · 초기자본 {fmtWon(pc.initialCapital)}원
        {computedAt && <> · 계산 시각 {computedAt.slice(0, 16).replace('T', ' ')}</>}
      </div>
      {mismatch && (
        <div className="bt-warn">
          ⚠️ 지금 화면의 설정(<strong>{mismatch}</strong>)은 사전계산 전제(<strong>전 구간 · 기본 비용</strong>)와
          다릅니다 — 아래 수치는 <strong>사전계산 전제</strong>의 것이고, 「직접 다시 돌리기」를 누르면 지금 설정으로
          실행되어 수치가 달라집니다.
        </div>
      )}
      <div className="kpi-row">
        <KpiCard
          label="총 수익률"
          value={fmtPctGrouped(pc.totalPct)}
          unit={` · 연 ${fmtPct(pc.cagrPct)}`}
          changeText={
            pc.benchCagrPct != null
              ? `벤치마크(KODEX 200) 연 ${fmtPct(pc.benchCagrPct)}`
              : '벤치마크 없음 — 알파를 계산할 수 없습니다'
          }
          changeLabel=""
          direction={pc.alphaCagrPct != null && pc.alphaCagrPct > 0 ? 'up' : 'down'}
          info="사전계산 산출물의 값입니다. 화면에서 「직접 다시 돌리기」를 누르면 같은 엔진·같은 비용으로 실행해 같은 수치가 나와야 합니다(데이터가 그 사이 늘었다면 기준일만큼 달라집니다)."
        />
        <KpiCard
          label="초과수익(알파, 연환산)"
          value={pc.alphaCagrPct != null ? fmtPp(pc.alphaCagrPct) : '—'}
          unit=" / 연"
          changeText={`${pc.startDate}~${pc.endDate}`}
          changeLabel=""
          direction={pc.alphaCagrPct != null && pc.alphaCagrPct > 0 ? 'up' : 'down'}
          info="규칙 5의 판정 기준은 연환산 알파(전략 CAGR − 벤치마크 CAGR)입니다. 음수면 그냥 지수를 사는 편이 나았다는 뜻입니다."
        />
        <KpiCard
          label="최대 낙폭(MDD)"
          value={fmtPct(pc.mddPct)}
          changeText="고점 대비 최대 하락 — 다운샘플 전 원곡선 기준"
          changeLabel=""
          direction="flat"
          info="아래 곡선은 주 1점으로 줄인 것이지만, 이 MDD는 줄이기 전 일별 곡선에서 잰 값입니다(줄인 곡선에서 재면 낙폭이 얕아 보입니다). 수익률보다 먼저 이 낙폭을 견딜 수 있는지 확인하세요."
        />
        <KpiCard
          label="연평균 ÷ MDD (칼마)"
          value={Math.abs(pc.mddPct) > 0.01 ? (pc.cagrPct / Math.abs(pc.mddPct)).toFixed(2) : '—'}
          changeText={`연 ${fmtPct(pc.cagrPct)} ÷ 낙폭 ${fmtPct(Math.abs(pc.mddPct))}`}
          changeLabel=""
          direction="flat"
          info="칼마 비율 — 연평균 수익률(CAGR)을 최대 낙폭으로 나눈 값입니다. 총수익÷MDD는 구간이 길수록 복리로 부풀어 오르지만, 이 값은 기간과 무관하게 '낙폭 1%를 견딘 대가로 연 몇 %를 벌었나'를 잽니다. 1을 넘으면 낙폭보다 연수익이 큰 것입니다."
        />
        <KpiCard
          label="최근 10년 연평균"
          value={pc.cagr10yPct != null ? fmtPct(pc.cagr10yPct) : '—'}
          unit=" / 연"
          changeText={pc.cagr10yPct != null ? `${asOf || pc.endDate} 기준 직전 10년 연환산` : '구간이 10년보다 짧아 계산하지 않았습니다'}
          changeLabel=""
          direction={pc.cagr10yPct != null && pc.cagr10yPct > 0 ? 'up' : 'down'}
          info="데이터 마지막 날에서 10년 전을 자르고, 그 이후 첫 점 대비 마지막 점의 배수를 연환산한 값입니다. 전 구간 CAGR과 다를 수 있습니다 — 초기 구간의 성적이 빠지기 때문입니다."
        />
        <KpiCard
          label="승률 / 매매"
          value={pc.tradeCount != null ? `${pc.tradeCount.toLocaleString('ko-KR')}회` : '합성'}
          unit=""
          changeText={
            pc.tradeCount != null
              ? '사전계산 산출물에는 매매 이력·승률이 들어 있지 않습니다 — 「직접 다시 돌리기」로 확인하세요'
              : '결합 곡선에는 매매 원장이 없습니다 — A·B 단독 실행에서 확인하세요'
          }
          changeLabel=""
          direction="flat"
          info="사전계산은 파일 크기를 줄이려고 요약 수치와 곡선만 담습니다. 매매 이력·연도별 분해·스크리닝은 직접 실행해야 나옵니다."
        />
        {/* 표준 성과 지표 — 실행 결과 화면과 **같은 카드**다. 산출물에는 스칼라만 있으므로
            평균 손익·손익 합 같은 상세(detail)는 넘기지 않는다(직접 실행에서만 나온다). */}
        <PerfStatCards
          stats={pc}
          ledgerAttributed={pc.tradeCount != null}
          legacyNote="옛 사전계산 산출물(schema 1)이라 이 지표가 들어 있지 않습니다 — 「직접 다시 돌리기」로 확인하세요"
        />
      </div>
      <EquityChart equity={rows} benchmarkLabel="KODEX 200 단순보유" />
      <div className="bt-note">
        ⚠️ 이 화면의 곡선은 <strong>주 1점(각 주 마지막 거래일)</strong>으로 줄인 것입니다 — 파일 크기를 줄이려는
        조작이며, 주중 등락은 보이지 않습니다(최저점과 최종일은 보존). 위 요약 수치는{' '}
        <strong>줄이기 전 일별 곡선</strong>에서 쟀습니다. 기준일(asOf {asOf || '—'}) 이후 거래일은 반영되어 있지
        않으므로, 최신 수치가 필요하면 아래 버튼으로 직접 돌리세요. 유니버스는 연도별 시총 상위 10+10{' '}
        <strong>[추정]</strong>이며 상장폐지 종목의 가격 부재로 <strong>생존편향</strong>이 남아 있습니다. 결합
        프리셋은 <strong>리밸런스 비용 미반영</strong>입니다. 매수 권유가 아닙니다(규칙 4).
      </div>
      <div className="bt-actions">
        <button type="button" className="bt-btn-run" disabled={busy} onClick={onRerun}>
          {busy ? '실행 중…' : '▶ 직접 다시 돌리기 (실데이터 재실행)'}
        </button>
      </div>
    </div>
  )
}

export function SpecSimulator() {
  const [saved] = useState(loadSaved)
  const [kind, setKind] = useState<StrategyKind>(saved.kind ?? 'condition')
  const [mom, setMom] = useState<MomentumParams>(saved.mom ?? DEFAULT_MOM)
  /** 결합 모드의 슬리브 A 가중 */
  const [comboWA, setComboWA] = useState<number>(normalizeWA(saved.comboWA))
  /** 결합 모드 옵션 — B 슬리브 시장게이트(12-1) · 금(GLD 원화) 슬리브 비중 (32차) */
  const [marketGate, setMarketGate] = useState<boolean>(saved.marketGate === true)
  const [goldW, setGoldW] = useState<number>(normalizeGoldW(saved.goldW))
  /** 모멘텀·결합 프리셋을 고르면 그 경고문을 화면에 띄운다(라벨만으로는 낙폭 맥락이 안 전달된다) */
  const [momNote, setMomNote] = useState<string | null>(null)
  const [spec, setSpec] = useState<StrategySpec>(saved.spec)
  const [startDate, setStartDate] = useState(saved.startDate)
  const [endDate, setEndDate] = useState(saved.endDate ?? '')
  const [cost, setCost] = useState<CostSettings>(saved.cost)

  // ---- 유니버스 (KRX 실측) --------------------------------------------------
  const [width, setWidth] = useState<KrxWidth>(normalizeWidth(saved.width))
  const uniState = useKrxUniverseFile()
  /**
   * 파생 실패(결측 연도·빈 목록)도 로드 실패와 **같은 취급**이다 — 둘 다 실행 불가이며,
   * [추정] 목록으로 대신 돌리지 않는다.
   */
  const universe = useMemo<{ ok: DerivedKrxUniverse } | { err: string } | null>(() => {
    if (uniState.status === 'loading') return null
    if (uniState.status === 'error') return { err: uniState.message }
    try {
      return { ok: deriveKrxUniverse(uniState.uni, width) }
    } catch (e) {
      return { err: e instanceof Error ? e.message : String(e) }
    }
  }, [uniState, width])
  const uni = universe && 'ok' in universe ? universe.ok : null
  const uniError = universe && 'err' in universe ? universe.err : null

  // ---- 시세 소스 (야후 ↔ KRX 일별 정본) -------------------------------------
  const [priceSource, setPriceSource] = useState<PriceSource>(normalizePriceSource(saved.priceSource))
  const krxDaily = useKrxDailyStatus()
  /**
   * 지금 고른 소스를 **실행할 수 없는 사유**. null이면 실행 가능.
   * 야후는 언제나 가능하고, KRX는 파일이 있어야 가능하다 — 없으면 **막고 사유를 보여준다**
   * (야후로 조용히 대신 돌리지 않는다).
   */
  const priceSourceBlock = useMemo<string | null>(() => {
    if (priceSource !== 'krx') return null
    if (krxDaily.status === 'ready') return null
    if (krxDaily.status === 'loading') return 'KRX 일별 정본을 확인하는 중입니다…'
    return krxDaily.reason
  }, [priceSource, krxDaily])
  /** 실행 결과가 **실제로 어느 소스로** 나왔는지 — 설정값이 아니라 실행 결과다(규칙 3) */
  const [priceMeta, setPriceMeta] = useState<PriceSourceMeta | null>(null)

  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // 실행 중 생기는 안내는 **덮어쓰지 않고 쌓는다** — 예전엔 "로드 실패 종목" 안내가
  // 뒤이은 레짐 안내에 지워져 사용자가 못 보고 넘어갔다.
  const [notes, setNotes] = useState<string[]>([])
  /** 연도별 유니버스 연쇄 실행 결과 — 이 화면의 모든 수치가 여기서 나온다 */
  const [result, setResult] = useState<PitChainResult | null>(null)
  /** 벤치마크가 실제로 존재한 구간 — 실행 구간보다 늦게 시작하면 알파가 과대평가된다 */
  const [benchSpan, setBenchSpan] = useState<{ start: string; end: string } | null>(null)
  /** 참고 벤치 — QQQ 원화 환산 곡선. 로드 실패면 null이고 화면은 「—」로 둔다(실행은 계속). */
  const [qqqKrw, setQqqKrw] = useState<FxPoint[] | null>(null)
  /** 참고 벤치 — QLD(2배 레버리지) 원화 환산 곡선. 규칙 4 경고와 함께 참고로만 그린다. */
  const [qldKrw, setQldKrw] = useState<FxPoint[] | null>(null)
  /** 이 결과를 만들 때 쓴 초기자본 — 실행 후 입력을 바꿔도 참고곡선 정규화가 흔들리지 않게 붙잡아 둔다 */
  const [runCapital, setRunCapital] = useState<number | null>(null)
  /** 결합 모드에서 두 슬리브를 **단독으로** 돌린 성적 — 결합 곡선에 없는 매매수·승률이 여기 있다 */
  const [sleeves, setSleeves] = useState<SleeveSummary[] | null>(null)
  /**
   * 결합 옵션이 **실제로 무엇을 했는지** — 게이트가 현금으로 돌린 달 수, 금 슬리브가 섞인 구간.
   * 설정값이 아니라 **실행 결과**다(레짐·금 데이터를 못 받으면 0/null로 내려앉는다).
   */
  const [comboOpts, setComboOpts] = useState<{
    gatedMonths: number
    totalMonths: number
    goldW: number
    goldFrom: string | null
  } | null>(null)

  const addNote = (m: string) => setNotes((prev) => (prev.includes(m) ? prev : [...prev, m]))

  /** 사전계산 산출물(없으면 null) — 라벨 병기와 "프리셋 즉시 표시"에 쓴다 */
  const precomputed = usePrecomputedPresets()

  /**
   * QQQ 원화 보유 **벽** — 34차가 "어떤 조합도 넘지 못했다"고 판정한 기준선.
   * 사전계산 산출물에 같은 구간으로 다시 잰 값이 있으면 **그 실측값**을 쓰고, 없으면
   * 34차 실행값 상수로 강등한다(하드코딩이 유일한 근거가 되는 경우는 배지로 구분한다 — 규칙 3).
   * ⚠️ 이것은 참고 벽이지 알파 판정 벤치가 아니다(판정 벤치는 규칙 5대로 KODEX 200).
   */
  const wallFromFile = precomputed?.walls?.find((w) => w.kind === 'qqqKrw') ?? null
  const wall = wallFromFile ?? KRXCAL_QQQ_WALL
  /**
   * 지금 화면에 띄운 사전계산 결과. 프리셋을 고르면 채워지고,
   * 「직접 다시 돌리기」(= 실행)를 누르면 비워진다 — 실행 결과가 그 자리를 대신한다.
   */
  const [shownPre, setShownPre] = useState<PrecomputedPreset | null>(null)
  /**
   * 사전계산을 띄운 시점의 **설정 지문**. 사용자가 조건·슬롯·가중을 손대면 지문이 어긋나
   * 블록이 사라진다 — 바뀐 설정 위에 옛 프리셋 성적이 남아 있으면 그게 곧 거짓말이다.
   */
  const [preSig, setPreSig] = useState<string | null>(null)

  const [jsonOpen, setJsonOpen] = useState(false)
  const [jsonText, setJsonText] = useState('')
  const [jsonError, setJsonError] = useState<string | null>(null)

  useEffect(() => {
    try {
      localStorage.setItem(
        STORE_KEY,
        JSON.stringify({
          kind,
          mom,
          comboWA,
          marketGate,
          goldW,
          width,
          priceSource,
          spec,
          startDate,
          endDate,
          cost,
        } satisfies Saved),
      )
    } catch {
      /* 저장 실패는 치명적이지 않다 */
    }
  }, [kind, mom, comboWA, marketGate, goldW, width, priceSource, spec, startDate, endDate, cost])

  const flat = useMemo(() => asFlatAnd(spec.entry), [spec.entry])
  // 종목 목록은 실행 시 그 해 유니버스로 주입되므로, 검증에는 대표로 첫 해 목록을 쓴다.
  const issues = useMemo(
    () => validateSpec({ ...spec, universe: { ...spec.universe, symbols: uni?.union ?? [] } }),
    [spec, uni],
  )

  /** 전략 설정 지문 — 사전계산 블록이 지금 설정과 같은 전략을 가리키는지 판정한다 */
  const settingsSig = useMemo(
    () => JSON.stringify({ kind, mom, comboWA, marketGate, goldW, width, spec }),
    [kind, mom, comboWA, marketGate, goldW, width, spec],
  )
  /** 지문이 어긋나면 띄우지 않는다(설정을 손대면 사전계산 결과는 그 설정의 것이 아니다) */
  const showPre = shownPre != null && precomputed != null && preSig === settingsSig
  /**
   * 사전계산의 전제(전 구간 · presets.ts 기본 비용)와 지금 화면 설정이 다르면 알린다.
   * 숨기지 않고 **차이를 밝힌 채로** 보여준다 — 재실행하면 수치가 달라진다는 사실이 핵심이다.
   */
  const preMismatch = useMemo(() => {
    if (!showPre || !precomputed) return null
    const diffs: string[] = []
    if (startDate) diffs.push(`시작일 ${startDate}`)
    if (endDate) diffs.push(`종료일 ${endDate}`)
    // 시세 소스가 다르면 **수치의 의미 자체**가 다르다(총수익 vs 가격수익) — 가장 먼저 알린다.
    if (precomputed.priceSource !== priceSource)
      diffs.push(`시세 소스(사전계산 ${precomputed.priceSource} ↔ 지금 ${priceSource})`)
    const c = precomputed.cost
    if (
      c &&
      (c.initialCapital !== cost.initialCapital ||
        c.feePct !== cost.feePct ||
        c.taxPct !== cost.taxPct ||
        c.slippagePct !== cost.slippagePct)
    )
      diffs.push('비용 설정')
    return diffs.length ? diffs.join(' · ') : null
  }, [showPre, precomputed, startDate, endDate, cost, priceSource])

  /** 기간 입력 검증 — 실행 전에 막는다 */
  const dateError = useMemo(
    () => (startDate && endDate && endDate < startDate ? `종료일(${endDate})이 시작일(${startDate})보다 앞섭니다` : null),
    [startDate, endDate],
  )

  /** 조건식에 이미 들어 있는 종류 — 목록·드롭다운 하이라이팅용 */
  const usedCondKinds = useMemo(() => new Set((flat ?? []).map((f) => f.cond.kind)), [flat])
  const usedExitKinds = useMemo(() => new Set(spec.exits.map((r) => r.kind)), [spec.exits])

  function patchEntry(nextFlat: FlatCond[]) {
    setSpec((s) => ({ ...s, entry: toEntry(nextFlat) }))
  }

  // 종목명 맵 — index.json의 실측 이름(크론이 채움)이 정본, 정적 맵은 폴백
  const [nameMap, setNameMap] = useState<Record<string, string>>({})
  useEffect(() => {
    fetch(`${import.meta.env.BASE_URL}data/intraday/index.json`)
      .then((r) => (r.ok ? r.json() : null))
      .then((idx: { symbols?: Record<string, { name?: string }> } | null) => {
        if (!idx?.symbols) return
        const m: Record<string, string> = {}
        for (const [s, v] of Object.entries(idx.symbols)) if (v?.name) m[s] = v.name
        if (Object.keys(m).length) setNameMap(m)
      })
      .catch(() => {})
  }, [])
  const dispSym = (sym?: string) => (sym ? displaySymbol(sym, nameMap) : '—')

  /**
   * 실행 — 전 연도 합집합(KRX 실측) 시세를 한 번만 받아 연도별 유니버스 연쇄 백테스트를 돌린다.
   *
   * 시세는 **어댑터 하나**(`loadKrPrices`)를 통해 받는다. 사전계산 스크립트도 같은 함수를 쓰므로
   * 화면과 산출물이 다른 소스로 갈릴 수 없다.
   *   · `yahoo` — 6자리 코드에 `.KQ`/`.KS` **양쪽을 조회해 긴 이력을 채택**한다(연구 러너와 같은 규약).
   *     예전에는 `.KS` 첫 성공에서 중단했는데, Yahoo가 다수 코스닥 종목의 `.KS` 쿼리에 11봉짜리
   *     가짜 시계열을 돌려주는 탓에 시작일이 밀려 그 종목이 유니버스에서 통째로 빠졌다
   *     (2026-08-02 실측 — 평균 매핑률 98%→71%). 200봉 미만은 채택하지 않는다.
   *   · `krx`   — 리포에 커밋된 KRX 일별 정본(원주가 → 수정주가 보정). 상폐 종목도 들어 있어
   *     가격 생존편향이 크게 줄지만 **배당은 반영되지 않는다**(가격수익). 파일이 없으면 **던진다**.
   *
   * ⚠️ 어느 소스든 **국내 유니버스 종목만** 해당한다. 벤치(KODEX 200)·참고선(QQQ·QLD·금·환율)은
   *    아래에서 계속 Yahoo로 받는다 — 화면 안내(MIXED_SOURCE_NOTE)에 그 사실을 남긴다.
   */
  async function run() {
    if (busy) return // 중복 클릭 방어 (버튼 disabled와 이중 잠금)
    setBusy(true)
    setError(null)
    setNotes([])
    try {
      if (dateError) throw new Error(dateError)
      // 유니버스가 없으면 **여기서 멈춘다** — [추정] 목록으로 대신 돌리지 않는다(33차 재발 방지).
      if (uniError) throw new Error(uniError)
      if (!uni) throw new Error('KRX 실측 유니버스를 아직 읽는 중입니다 — 잠시 후 다시 실행하세요.')
      // 고른 소스를 쓸 수 없으면 **여기서 멈춘다** — 야후로 조용히 대신 돌리지 않는다.
      if (priceSourceBlock) throw new Error(priceSourceBlock)
      const codes = uni.union
      setProgress(`시세 로딩 0/${codes.length}…`)
      // 병렬 로딩(야후) — 순차(67회 왕복 직렬)가 시뮬 체감 지연의 주범이었다. 동시 6개:
      // 공용 CORS 프록시의 유량 제한을 넘지 않는 선에서 벽시계 시간을 ~1/6로 줄인다.
      // 범위는 BACKTEST_HISTORY_RANGE(1999~) 고정 — 유니버스가 2000년부터라 5y·10y로는 앞
      // 구간이 통째로 비고, 1999년 봉은 첫 해 지표 워밍업에 쓰인다(백테스트 시작은 2000년).
      const load = await loadKrPrices(codes, priceSource, {
        yahoo: {
          fetchDaily: (sym) => getDailyHistory(sym, BACKTEST_HISTORY_RANGE).then((h) => h.bars),
          concurrency: 6,
        },
        krx: krxFetchDeps(import.meta.env.BASE_URL, (url) => fetch(url)),
        onProgress: (done, total) => setProgress(`시세 로딩 ${done}/${total}…`),
      })
      // 아래에서 레짐·벤치 심볼을 더 담기 때문에 어댑터가 준 객체를 그대로 이어 쓴다.
      const histories: Record<string, DailyBar[]> = load.histories
      /** 유니버스 코드 → 실제로 시세를 받은 심볼(야후는 '005930.KS', KRX는 '005930') */
      const symOf: Record<string, string> = load.symOf
      const failed = load.failed
      const okCount = load.meta.loaded
      setPriceMeta(load.meta)
      if (okCount === 0) throw new Error('시세를 하나도 받지 못했습니다 — 네트워크/프록시 상태를 확인하세요')
      if (failed.length)
        addNote(
          `⚠️ 가격 없음(${priceSource === 'krx' ? '수집 범위 밖' : '상장폐지 등'})으로 제외: ${failed.join(', ')} — ` +
            `${okCount}/${codes.length}종목으로 실행합니다. 빠진 종목은 대부분 그 시절 상위였다가 사라진 회사라, ` +
            '성적이 실제보다 후하게 나옵니다(생존편향 잔존).',
        )
      // 소스가 섞이는 구간(벤치·참고선은 계속 야후)을 실행할 때마다 남긴다.
      addNote(`ℹ️ 시세 소스: ${load.meta.badge} · ${MIXED_SOURCE_NOTE}`)

      // 레짐 게이트가 있으면 지수 시세도 필요하다 (매매 대상 아님 — 판정 전용)
      const extraSymbols: string[] = []
      // 결합 모드의 슬리브 A도 조건식이므로 레짐 지수가 필요하다 (모멘텀 단독 모드만 안 쓴다)
      if (kind !== 'momentum' && spec.regime) {
        setProgress(`레짐 지수(${spec.regime.symbol}) 로딩…`)
        try {
          // 레짐 지수도 1999년부터 — 첫 해 레짐 판정에 쓰는 이평의 워밍업이 없으면
          // 2000년만 게이트가 다르게 작동한다(유니버스 종목과 같은 이유).
          const rh = await getDailyHistory(spec.regime.symbol, BACKTEST_HISTORY_RANGE)
          if (rh.bars.length > 0) {
            histories[spec.regime.symbol] = rh.bars
            extraSymbols.push(spec.regime.symbol)
          } else addNote('⚠️ 레짐 지수 데이터가 비어 있습니다 — 진입이 발생하지 않습니다')
        } catch {
          addNote('⚠️ 레짐 지수 로드 실패 — 진입이 발생하지 않습니다 (레짐을 "없음"으로 바꾸거나 재시도)')
        }
      }

      // 벤치마크 — 같은 연말 경계로 연쇄한 KODEX 200 단순보유 (규칙 5: 판정은 알파 기준)
      setProgress('벤치마크 로딩…')
      let bench: DailyBar[] | undefined
      try {
        // 벤치도 같은 구간으로 받는다(연구 러너와 동일). 연도별로 그 해 구간만 잘라 쓰므로
        // 1999년 봉은 수치에 들어가지 않는다 — 사전계산과 요청 구간을 어긋나게 두지 않으려는 것.
        const b = await getDailyHistory(BENCH_SYMBOL, BACKTEST_HISTORY_RANGE)
        if (b.bars.length >= 2) {
          bench = b.bars
          setBenchSpan({ start: b.bars[0].date, end: b.bars[b.bars.length - 1].date })
        } else setBenchSpan(null)
      } catch {
        setBenchSpan(null)
        addNote('⚠️ 벤치마크(KODEX 200) 로드 실패 — 알파를 계산할 수 없습니다')
      }

      // 참고 벤치(QQQ 원화 환산) — **실패해도 백테스트를 막지 않는다**. 참고 표시일 뿐이라
      // 이것 때문에 실행이 중단되면 배보다 배꼽이 크다. 실패 시 QQQ 행만 「—」로 남는다.
      setProgress('참고 벤치(QQQ·QLD·USD/KRW) 로딩…')
      try {
        const [q, fx] = await Promise.all([getDailyHistory(QQQ_SYMBOL, 'max'), getDailyHistory(FX_SYMBOL, 'max')])
        const curve = toKrwCurve(q.bars, fx.bars)
        if (curve.length >= 2) setQqqKrw(curve)
        else {
          setQqqKrw(null)
          addNote('⚠️ 참고 벤치(QQQ 원화 환산) 데이터가 부족합니다 — QQQ 비교만 「—」로 두고 백테스트는 그대로 진행합니다.')
        }
        // QLD(2배 레버리지)도 같은 환율 곡선으로 환산 — 실패해도 QLD 행만 「—」
        try {
          const ql = await getDailyHistory(QLD_SYMBOL, 'max')
          const qlCurve = toKrwCurve(ql.bars, fx.bars)
          setQldKrw(qlCurve.length >= 2 ? qlCurve : null)
        } catch {
          setQldKrw(null)
          addNote('⚠️ 참고 벤치(QLD 원화 환산) 로드 실패 — QLD 비교만 「—」로 두고 백테스트는 그대로 진행합니다.')
        }
      } catch {
        setQqqKrw(null)
        setQldKrw(null)
        addNote('⚠️ 참고 벤치(QQQ·USD/KRW) 로드 실패 — QQQ·QLD 비교만 「—」로 두고 백테스트는 그대로 진행합니다.')
      }

      setProgress('연도별 유니버스 연쇄 백테스트 실행…')
      // 세 유형 모두 **같은 연쇄 규약**을 쓴다 — 유니버스 교체·연말 이월·현금해·벤치 겹침 동일.
      const runCondition = () =>
        runPitChained(
          histories,
          (symbols) => ({ ...spec, universe: { ...spec.universe, symbols } }),
          cost,
          { resolve: (code) => symOf[code], startDate, endDate, bench, extraSymbols },
        )
      // 구간끝 청산비용 근사(haircut)는 **켠다** — 연구 러너(idea-lab runCustomChain)가 해마다
      // 물리는 비용이라 끄면 화면만 그 비용을 면제받아 낙관적으로 보인다. 방향이 보수적이고
      // 사전계산(preset-precompute)과도 같은 전제가 된다. 옵션 기본값(false)은 그대로 두고
      // 호출부에서만 켠다 — 다른 호출부·기존 테스트의 동작을 바꾸지 않기 위해서다.
      const runMomentum = (exposure?: (date: string) => number) =>
        runXsmomChained(histories, {
          cost,
          slots: mom.slots,
          gate: mom.gate,
          exposure,
          years: uni.years,
          codesFor: uni.codesFor,
          resolve: (code) => symOf[code],
          startDate,
          endDate,
          bench,
          applyLiquidationHaircut: true,
        })

      let chained: PitChainResult
      if (kind === 'combo') {
        // 결합 = **두 슬리브를 각각 전액 투자로 돌린 곡선**의 월 리밸런스 합성(정본 comboBlend.ts).
        // 두 슬리브가 같은 유니버스·같은 비용·같은 벤치를 쓰므로 결합 곡선이 같은 축에서 읽힌다.
        // ---- 옵션 슬리브(32차) — 시장게이트 레짐 곡선 · 금(GLD) 원화 곡선 ----------
        // 둘 다 **실패해도 백테스트를 막지 않는다**. 옵션만 꺼진 채 결합이 그대로 돌고,
        // 아래 배지가 "실제로 적용된 것"을 보여 준다(설정값이 아니라 결과다 — 규칙 3).
        //
        // ⚠️ 레짐은 **슬리브 B를 돌리기 전에** 만들어야 한다. 게이트는 곡선을 나중에 손보는
        //    후처리가 아니라 시뮬 안으로 들어가는 노출 훅이기 때문이다(그래야 게이트 달의
        //    청산 비용과 다음 달 재매수 비용이 성적에 실린다 — 정본과 같은 산술).
        let regime: { date: string; equity: number }[] | null = null
        if (marketGate) {
          if (!bench) addNote('⚠️ 벤치마크가 없어 시장게이트를 판정할 수 없습니다 — 게이트 없이 실행합니다.')
          else {
            setProgress(`시장게이트 레짐 지수(${REGIME_FALLBACK_SYMBOL}) 로딩…`)
            let fb: DailyBar[] = []
            try {
              fb = (await getDailyHistory(REGIME_FALLBACK_SYMBOL, BACKTEST_HISTORY_RANGE)).bars
            } catch {
              addNote(
                `⚠️ 레짐 폴백 지수(${REGIME_FALLBACK_SYMBOL}) 로드 실패 — 벤치 구간만으로 게이트를 판정합니다. ` +
                  '벤치가 시작하기 전 달은 판정 불가라 게이트가 열린 채로 지나갑니다.',
              )
            }
            const spliced = spliceRegimeCurve(bench, fb)
            regime = spliced.length >= 2 ? spliced : null
          }
        }
        let gold: { date: string; equity: number }[] | null = null
        if (goldW > 0) {
          setProgress(`금 슬리브(${GOLD_SYMBOL}·${FX_SYMBOL}) 로딩…`)
          try {
            const [g, fx] = await Promise.all([
              getDailyHistory(GOLD_SYMBOL, BACKTEST_HISTORY_RANGE),
              getDailyHistory(FX_SYMBOL, BACKTEST_HISTORY_RANGE),
            ])
            const curve = toKrwSeries(g.bars, fx.bars)
            if (curve.length >= 2) gold = curve
            else addNote(`⚠️ ${GOLD_SYMBOL} 원화 환산 실패(환율 구간 불일치) — 금 슬리브 없이 실행합니다.`)
          } catch {
            addNote(`⚠️ ${GOLD_SYMBOL}·${FX_SYMBOL} 로드 실패 — 금 슬리브 없이 실행합니다.`)
          }
        }

        setProgress('연도별 유니버스 연쇄 백테스트 실행…')
        const gateOf = regime ? makeMarketGateExposure(regime) : null
        const chainA = runCondition()
        // 게이트는 여기서 시뮬 안으로 들어간다 — 곡선을 나중에 마스킹하지 않는다.
        const chainB = runMomentum(gateOf ?? undefined)
        if (chainA.equity.length === 0 || chainB.equity.length === 0)
          throw new Error('결합할 슬리브 곡선이 비었습니다 — 시작일·종료일을 확인하세요')

        const gateInfo = gateOf ? summarizeGate(chainB.equity.map((p) => p.date), gateOf) : null
        const composed = composeCombo({
          chainA,
          chainB,
          wA: comboWA,
          capital: cost.initialCapital,
          gold,
          goldW,
        })
        chained = composed.result
        setComboOpts({
          gatedMonths: gateInfo?.gatedMonths.length ?? 0,
          totalMonths: gateInfo?.totalMonths ?? 0,
          goldW: composed.goldWApplied,
          goldFrom: composed.goldFrom,
        })
        if (composed.goldWApplied > 0)
          addNote(
            `금 슬리브 ${Math.round(composed.goldWApplied * 100)}%가 섞이면서 결합 구간이 ${composed.goldFrom}부터로 잘렸습니다 ` +
              `(${GOLD_SYMBOL} 상장 이후만 겹칩니다) — 2000년부터 시작하는 다른 프리셋과 MDD·CAGR을 직접 비교하지 마세요.`,
          )
        if (gateInfo)
          addNote(
            `시장게이트(12-1): 전체 ${gateInfo.totalMonths}달 중 ${gateInfo.gatedMonths.length}달을 B 슬리브 현금으로 돌렸습니다 — ` +
              '그 달 첫 거래일 시가에 전량 청산하고(매도 비용 지불) 게이트가 풀리는 달에 다시 삽니다. ' +
              '그 청산·재매수 비용은 아래 성적에 이미 반영돼 있습니다.',
          )
        setSleeves([
          {
            key: 'A',
            label: `A 조건식 · ${spec.name}`,
            totalPct: chainA.totalPct,
            cagrPct: chainA.cagrPct,
            mddPct: chainA.mddPct,
            alphaCagrPct: chainA.alphaCagrPct,
            tradeCount: chainA.tradeCount,
            winRate: chainA.winRate,
          },
          {
            key: 'B',
            // 게이트가 시뮬 안에서 걸렸으므로 이 행의 **모든 수치**(매매수·승률 포함)가
            // 게이트를 반영한 값이다 — 게이트 달의 청산이 원장에 그대로 들어 있다.
            label:
              `B 모멘텀 · 상위${mom.slots}${mom.gate ? '+게이트' : ''}` +
              (gateInfo && gateInfo.gatedMonths.length > 0
                ? ` + 시장게이트(12-1) ${gateInfo.gatedMonths.length}달 현금`
                : ''),
            totalPct: chainB.totalPct,
            cagrPct: chainB.cagrPct,
            mddPct: chainB.mddPct,
            alphaCagrPct: chainB.alphaCagrPct,
            tradeCount: chainB.tradeCount,
            winRate: chainB.winRate,
          },
        ])
        // 결합 구간은 두 곡선이 **겹치는 구간**뿐이다 — 한쪽만 있는 구간을 넣으면 그 구간이
        // 통째로 그 슬리브의 성적이 되므로 버린다. 구간이 줄었으면 숨기지 않고 알린다.
        if (chained.startDate > chainA.startDate || chained.startDate > chainB.startDate)
          addNote(
            `결합 구간은 두 슬리브가 겹치는 ${chained.startDate}~${chained.endDate}입니다 — ` +
              `A 단독(${chainA.startDate}~) · B 단독(${chainB.startDate}~)과 구간이 다르므로 수치를 직접 비교하지 마세요.`,
          )
      } else {
        setSleeves(null)
        setComboOpts(null)
        chained = kind === 'momentum' ? runMomentum() : runCondition()
      }
      if (chained.perYear.length === 0) throw new Error('실행할 연도가 없습니다 — 시작일·종료일을 확인하세요')
      setResult(chained)
      // 실행이 성공한 순간에만 사전계산 화면을 내린다 — 실행 중에는 그대로 둬야
      // 「직접 다시 돌리기」를 누른 버튼이 진행 상태를 계속 보여준다(빈 화면 방지).
      setShownPre(null)
      setRunCapital(cost.initialCapital)
      setTradesPage(0) // 새 실행마다 1페이지부터
      const cashYears = chained.perYear.filter((r) => r.cash).map((r) => r.year)
      if (cashYears.length)
        addNote(
          `표본 부족(매핑 5종목 미만)으로 현금 보유 처리한 해: ${cashYears.join(', ')} — 그 해는 매매하지 않고 자산을 그대로 이월했습니다.`,
        )
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
      setProgress(null)
    }
  }

  /**
   * 참고 벤치(QQQ 원화 환산)를 **실행 구간에 맞춰** 정규화한다.
   * 전략 곡선과 같은 시작값(초기자본)에서 출발시켜야 두 곡선이 같은 축에서 읽힌다.
   * 환율(KRW=X)이 실행 구간보다 늦게 시작하면 그 이전은 비울 수밖에 없으므로,
   * 실제로 덮은 구간(from~to)을 그대로 표시해 비교 구간이 다르다는 사실을 숨기지 않는다.
   */
  const refCurveOf = useCallback(
    (krw: FxPoint[] | null) => {
      if (!result || !krw?.length || result.equity.length === 0) return null
      const cap = runCapital ?? cost.initialCapital
      let i = 0
      let last: number | null = null
      let base: number | null = null
      let from = ''
      let to = ''
      let peak = 0
      let mdd = 0
      const byDate = new Map<string, number>()
      for (const p of result.equity) {
        while (i < krw.length && krw[i].date <= p.date) {
          last = krw[i].krw
          i++
        }
        if (last == null) continue // 환율·기초자산이 아직 시작되지 않은 앞 구간 — 임의로 채우지 않는다
        if (base == null) {
          base = last
          from = p.date
        }
        to = p.date
        const v = (last / base) * cap
        peak = Math.max(peak, v)
        if (peak > 0) mdd = Math.min(mdd, (v / peak - 1) * 100)
        byDate.set(p.date, v)
      }
      if (base == null || byDate.size < 2) return null
      const ratio = (byDate.get(to) as number) / cap
      return { byDate, totalPct: (ratio - 1) * 100, cagrPct: annualize(ratio, yearsBetween(from, to)), mddPct: mdd, from, to }
    },
    [result, runCapital, cost.initialCapital],
  )
  const qqqRef = useMemo(() => refCurveOf(qqqKrw), [refCurveOf, qqqKrw])
  const qldRef = useMemo(() => refCurveOf(qldKrw), [refCurveOf, qldKrw])

  // 벤치마크(KODEX 200)는 연쇄 실행기가 같은 연말 경계로 이어붙여 이미 넣어 준다 —
  // 여기서 다시 겹치지 않는다. QQQ만 참고 라인으로 얹는다.
  const chartEquity: EquityRow[] | null = useMemo(() => {
    if (!result || result.equity.length === 0) return null
    if (!qqqRef && !qldRef) return result.equity
    return result.equity.map((p) => ({
      ...p,
      benchmark2: qqqRef?.byDate.get(p.date) ?? null,
      benchmark3: qldRef?.byDate.get(p.date) ?? null,
    }))
  }, [result, qqqRef, qldRef])

  const summary = useMemo(() => {
    if (!result || result.equity.length === 0) return null
    return {
      totalPct: result.totalPct,
      mdd: result.mddPct,
      objective: result.objective,
      years: result.years,
      cagrPct: result.cagrPct,
      benchTotalPct: result.benchTotalPct,
      benchCagrPct: result.benchCagrPct,
      alphaCagrPct: result.alphaCagrPct,
      alphaTotalPct: result.alphaTotalPct,
      tradeCount: result.tradeCount,
      winRate: result.winRate,
      avgPnl: result.avgPnlPct,
    }
  }, [result])

  /**
   * 표준 성과 지표 — **이미 확정된** 자산곡선·매매 원장의 사후 요약이다(규칙 1: 판정에
   * 되먹임되지 않는다). CAGR은 화면이 이미 쓰는 값을 그대로 넘겨 두 카드가 다른 정의로
   * 갈라지지 않게 한다. 결합(combo)은 곡선 합성이라 원장이 귀속되지 않으므로 원장 지표는
   * 계산하지 않고 '합성'으로 표시한다(0건이라는 뜻이 아니다).
   */
  const perf = useMemo(() => {
    if (!result || result.equity.length < 2) return null
    const curve = computeCurveStats(result.equity, result.cagrPct)
    const attributed = kind !== 'combo'
    const ledger = attributed ? computeLedgerStats(result.trades) : null
    const stats: Partial<PerfStatFields> = {
      volAnnPct: curve.volAnnPct,
      sharpe: curve.sharpe,
      sortino: curve.sortino,
      maxDdDays: curve.longestDrawdown?.days ?? null,
      maxDdRecovered: curve.longestDrawdown?.recovered ?? null,
      maxDdStart: curve.longestDrawdown?.startDate ?? null,
      maxDdEnd: curve.longestDrawdown?.endDate ?? null,
      payoffRatio: ledger?.payoffRatio ?? null,
      profitFactor: ledger?.profitFactor ?? null,
    }
    return { stats, detail: ledger ? ledgerDetailOf(ledger) : null, attributed }
  }, [result, kind])
  /** 벤치마크가 실행 구간보다 늦게 시작하면 그 이전 구간의 알파는 벤치 부재로 과대평가된다.
   *  휴장일 차이로 하루이틀 어긋나는 것까지 경고하면 노이즈라 30일 이상만 잡는다.
   *  (KODEX 200 시세는 실행 구간보다 늦게 시작할 수 있다 — 그 앞 구간은 비교 대상이 없다) */
  const benchGap = useMemo(() => {
    if (!result || !benchSpan) return null
    const gapDays = (Date.parse(benchSpan.start) - Date.parse(result.startDate)) / 86400e3
    return gapDays > 30 ? benchSpan.start : null
  }, [result, benchSpan])

  function exportJson() {
    setJsonText(JSON.stringify(spec, null, 2))
    setJsonError(null)
    setJsonOpen(true)
  }

  function importJson() {
    try {
      const parsed = JSON.parse(jsonText) as StrategySpec
      const errs = validateSpec(parsed).filter((i) => i.level === 'error')
      if (errs.length) throw new Error(errs.map((e) => e.message).join(' / '))
      setSpec(parsed)
      setJsonError(null)
      setJsonOpen(false)
    } catch (e) {
      setJsonError(e instanceof Error ? e.message : String(e))
    }
  }

  // 매매 이력 — 최신순 전체를 페이지로 나눠 전량 열람 (전량 즉시 렌더는 수천 행에서 버벅임)
  const TRADES_PER_PAGE = 50
  const [tradesPage, setTradesPage] = useState(0)
  // 매 렌더마다 복사·역순 정렬하면 수천 건에서 낭비다 — 결과가 바뀔 때만 계산한다
  const allTrades = useMemo(() => (result ? [...result.trades].reverse() : []), [result])
  const tradePages = Math.max(1, Math.ceil(allTrades.length / TRADES_PER_PAGE))
  const pageClamped = Math.min(tradesPage, tradePages - 1)
  const recentTrades = allTrades.slice(pageClamped * TRADES_PER_PAGE, (pageClamped + 1) * TRADES_PER_PAGE)
  const screenRows = result ? result.lastScreen.slice(0, 12) : []

  return (
    <div className="panel bt-panel bt-sim">
      <div className="panel-head">
        <h2>
          ⚡ 조건식 시뮬레이터
          <InfoTip text="영웅문 조건검색식(1차 발굴)을 여기 옮겨 적으면 과거 데이터로 즉시 백테스트(2차 검증)합니다. 조건식은 JSON 스펙으로 저장되며, 시뮬레이터와 (미래의) 실시간 평가기가 같은 판정 함수를 씁니다 — 시뮬에서 통과한 조건식과 실전 조건식이 다른 코드를 탈 수 없습니다. 이 화면은 시뮬레이션 전용이며 주문·실계좌와 연결되지 않습니다." />
        </h2>
        <span className="badge sample">시뮬레이션 전용 · 실주문 없음</span>
      </div>
      <div className="panel-sub">
        영웅문 조건검색으로 찾은 조건식을 옮겨 적고 <strong>즉시 2차 검증</strong>합니다. 조건식 대신{' '}
        <strong>모멘텀 랭킹(12-1)</strong>으로도 같은 유니버스·같은 비용에서 돌려 비교할 수 있습니다. 신호는 종가 판단 → 익일 시가
        체결(미래참조 금지), 판정은 알파(벤치마크 대비) 기준. 유니버스는{' '}
        <strong>매년 그 해 시총 상위 10+10 [추정]</strong>으로 교체됩니다 — 종목을 고정할 수 없습니다(승자편향 제거).
      </div>

      {/* ---- 전략 유형 ---- */}
      <div className="bt-controls bt-settings">
        <label>
          전략 유형
          <InfoTip text="「조건식」은 이평·신고가 같은 조건을 만족하는 종목을 사는 방식입니다. 「모멘텀 랭킹」은 조건을 보지 않고 매월 첫 거래일에 '12개월 전~1개월 전' 수익률로 유니버스를 줄 세워 상위 N만 동일가중으로 보유합니다(최근 1개월은 단기 반전을 피하려고 창에서 뺍니다). 「결합」은 앞의 둘을 각각 전액 투자로 돌린 뒤 매월 첫 거래일에 자산을 정해진 비율로 되돌리는 합성입니다 — 새 매매 규칙이 아니라 두 곡선을 섞는 것이며, 리밸런스 매매비용은 반영되지 않습니다. 세 유형 모두 같은 유니버스·같은 비용·같은 연쇄 규약으로 돌아가므로 결과가 직접 비교됩니다." />
          <select value={kind} onChange={(e) => setKind(e.target.value as StrategyKind)} disabled={busy}>
            <option value="condition">조건식(현행)</option>
            <option value="momentum">모멘텀 랭킹</option>
            <option value="combo">결합 — 조건식 + 모멘텀</option>
          </select>
        </label>
        {kind === 'combo' && (
          <label>
            결합 가중 (A : B)
            <InfoTip text="슬리브 A(조건식)와 슬리브 B(모멘텀)에 자산을 얼마씩 나눌지입니다. 매월 첫 거래일 시작 시점에 총자산을 이 비율로 되돌리고, 달 안에서는 각 슬리브가 제 수익률대로 표류합니다. 가중을 정하는 데 쓰는 정보는 날짜뿐이라 미래참조가 들어갈 자리가 없습니다. 리밸런스에 드는 매매비용은 반영되지 않았습니다(낙관적 상한)." />
            <select
              value={comboWA}
              onChange={(e) => setComboWA(normalizeWA(Number(e.target.value)))}
              disabled={busy}
            >
              {COMBO_WEIGHTS.map((w) => (
                <option key={w} value={w}>
                  A {Math.round(w * 100)} : B {Math.round((1 - w) * 100)}
                  {w === DEFAULT_COMBO_WA ? ' (기본 · 26차 검증안)' : ' [민감도 참고]'}
                </option>
              ))}
            </select>
            <span className="bt-hint">
              50:50이 26차 검증 기본안이고, 25:75·75:25는 <strong>가중 민감도를 보기 위한 참고</strong>입니다
            </span>
          </label>
        )}
        {kind === 'combo' && (
          <label>
            시장게이트 (12-1) — 슬리브 B
            <InfoTip text="매월 첫 거래일에 벤치마크(KODEX 200 · 시작 이전 구간은 코스피 종합 수익률로 이어붙임)의 '12개월 전~1개월 전' 수익률을 봅니다. 그 값이 음수면 그 달은 슬리브 B(모멘텀) 전체를 현금으로 둡니다 — 그 달 첫 거래일 시가에 보유 종목을 전량 매도하고(수수료·거래세·슬리피지를 물고) 게이트가 풀리는 달에 다시 삽니다. 그 비용이 성적에 그대로 반영됩니다(연구 러너와 같은 산술). 판정 창의 두 기준 종가가 모두 그 달보다 과거라 미래참조가 들어갈 자리가 없고, 판정할 데이터가 없는 초기 구간은 게이트를 열어 둡니다(임의로 현금화하지 않습니다)." />
            <input
              type="checkbox"
              checked={marketGate}
              onChange={(e) => setMarketGate(e.target.checked)}
              disabled={busy}
            />
            <span className="bt-hint">
              벤치 12-1 모멘텀이 음수인 달은 <strong>B 슬리브 전체를 현금</strong>으로 (32차)
            </span>
          </label>
        )}
        {kind === 'combo' && (
          <label>
            금 슬리브 (GLD 원화)
            <InfoTip text="금 ETF(GLD)를 총수익 보정한 뒤 원/달러 종가를 곱해 원화 곡선으로 만들고, 결합 곡선과 매월 첫 거래일에 이 비율로 되돌립니다(환율 결측일은 직전 환율 이월 — 다음 환율을 당겨오면 미래참조입니다). ⚠️ GLD가 2004-11에 상장해서 이 옵션을 켜면 곡선이 2004-11부터 시작합니다 — 2000년부터 도는 다른 설정과 MDD·CAGR을 직접 비교하면 거짓입니다(겪은 위기의 수가 다릅니다). ⚠️ 원화 곡선에는 금 가격과 원/달러 변동이 섞여 있어 낙폭 완화의 상당 부분이 금이 아니라 달러 노출일 수 있습니다. 슬리브 간 이체 비용·환전 스프레드·세제는 반영되지 않았습니다." />
            <select value={goldW} onChange={(e) => setGoldW(normalizeGoldW(Number(e.target.value)))} disabled={busy}>
              {GOLD_WEIGHTS.map((w) => (
                <option key={w} value={w}>
                  {w === 0 ? '없음 (금 0%)' : `금 ${Math.round(w * 100)}% : 주식 ${Math.round((1 - w) * 100)}%`}
                  {w === 0.2 ? ' (32차 실측값)' : w === 0 ? '' : ' [민감도 참고]'}
                </option>
              ))}
            </select>
            <span className="bt-hint">
              켜면 곡선이 <strong>2004-11부터</strong> 시작합니다(GLD 상장) — 다른 설정과 구간이 달라집니다
            </span>
          </label>
        )}
        {kind !== 'condition' && (
          <>
            <label>
              보유 종목 수{kind === 'combo' ? ' (슬리브 B)' : ''}
              <InfoTip text="랭킹 상위 몇 종목을 동일가중으로 담을지입니다. 유니버스가 연 20종목이라 상위 5는 사실상 상위 25% 분위입니다 — 학계의 상위 10% 분위 모멘텀보다 신호가 묽습니다." />
              {/* 선택지는 presets.ts(MOM_SLOT_CHOICES)가 정본이다 — 프리셋이 쓰는 값이
                  목록에 없으면 셀렉트가 빈칸으로 보인다(tests/presetprecompute.test.ts가 강제). */}
              <select
                value={mom.slots}
                onChange={(e) => setMom((m) => ({ ...m, slots: Number(e.target.value) }))}
                disabled={busy}
              >
                {MOM_SLOT_CHOICES.map((n) => (
                  <option key={n} value={n}>
                    상위 {n}종목
                    {n === DEFAULT_MOM.slots ? ' (기본)' : ''}
                    {n === 3 ? ' — 집중도↑·낙폭↑' : ''}
                  </option>
                ))}
              </select>
            </label>
            <label>
              절대모멘텀 게이트{kind === 'combo' ? ' (슬리브 B)' : ''}
              <InfoTip text="12-1 수익률이 음수인 종목은 사지 않고 그 슬롯을 현금으로 둡니다. 슬롯 분모는 게이트와 무관하게 min(N, 후보수)로 고정되므로, 걸러진 슬롯의 돈이 남은 종목에 재분배되지 않습니다(게이트가 레버리지로 둔갑하지 않게). 25차 실측에서 게이트를 켜면 낙폭이 −68%→−61%로 줄었습니다." />
              <select
                value={mom.gate ? 'on' : 'off'}
                onChange={(e) => setMom((m) => ({ ...m, gate: e.target.value === 'on' }))}
                disabled={busy}
              >
                <option value="on">켬 — 음수 모멘텀 슬롯은 현금 (기본)</option>
                <option value="off">끔 — 상위 N을 그대로 보유</option>
              </select>
            </label>
            <div className="bt-note" style={{ width: '100%' }}>
              <strong>모멘텀 랭킹 (12-1){kind === 'combo' ? ' — 슬리브 B' : ''}</strong> — 매월{' '}
              <strong>첫 거래일 시가</strong>에 리밸런스합니다. 랭킹은
              <strong> 전월 1일 이전 종가까지만</strong> 보므로 판정에 당일·직전 한 달 데이터가 들어가지 않습니다
              (미래참조 금지). 이동평균·신고가·레짐·매도 규칙은 {kind === 'combo' ? '이 슬리브에서' : '이 모드에서'}{' '}
              쓰지 않습니다 — 청산은 월간 리밸런스로만 일어납니다. 12개월치 시세가 없는 종목은 그 시점 후보에서
              빠집니다.
            </div>
          </>
        )}
        {kind === 'combo' && (
          <div className="bt-note" style={{ width: '100%' }}>
            <strong>결합 (A {Math.round(comboWA * 100)} : B {Math.round((1 - comboWA) * 100)})</strong> — 아래 조건식이{' '}
            <strong>슬리브 A</strong>, 위 모멘텀 파라미터가 <strong>슬리브 B</strong>입니다. 두 슬리브를 각각{' '}
            <strong>전액 투자 기준</strong>으로 돌린 뒤, 매월 첫 거래일 시작 시점에 총자산을 이 비율로 되돌리고 달
            안에서는 표류시킵니다(가중 판단에 쓰는 정보는 <strong>날짜뿐</strong> — 미래참조 없음). 결합은 새 매매
            규칙이 아니라 <strong>두 곡선의 합성</strong>이라, <strong>리밸런스 매매비용이 반영되지 않은 낙관적
            상한</strong>이며 매매 원장(매매수·승률)이 어느 쪽에도 귀속되지 않습니다 — 그 수치는 아래{' '}
            <strong>슬리브 단독 성적</strong> 표에서 읽으세요.
          </div>
        )}
      </div>
      {momNote && kind !== 'condition' && <div className="bt-warn">⚠️ {momNote}</div>}

      {/* ---- 매수 조건 ---- (결합 모드에서는 이것이 슬리브 A다) */}
      {kind !== 'momentum' && (
      <div className="bt-controls">
        <strong>매수 조건 (전부 충족 시 편입 · AND){kind === 'combo' ? ' — 슬리브 A' : ''}</strong>
        {flat == null ? (
          <div className="bt-warn">
            이 스펙은 OR/NOT이 섞인 고급 트리라 목록 편집을 지원하지 않습니다 — 아래 JSON으로 편집하세요.
            <div style={{ marginTop: 4, fontSize: 12 }}>{summarizeNode(spec.entry)}</div>
          </div>
        ) : (
          <>
            {flat.length === 0 && <div className="bt-cond-empty">조건이 없습니다 — 아래에서 추가하세요 (조건 0개면 전 종목이 후보가 됩니다)</div>}
            {flat.map((f, i) => (
              // key에 kind를 섞어 종류가 바뀌면 입력 칸이 새로 마운트되게 한다
              // (인덱스만 쓰면 삭제 시 옆 행의 입력 상태가 딸려온다)
              <div key={`${i}:${f.cond.kind}`} className="bt-cond-row bt-cond-card is-active">
                <span className="bt-cond-flag" title="이 조건이 현재 조건식(AND)에 포함되어 있습니다">
                  ✓ 적용 중
                </span>
                <select
                  className="bt-cond-kind"
                  value={f.cond.kind}
                  aria-label={`조건 ${i + 1} 종류`}
                  onChange={(e) => {
                    const meta = KIND_MENU.find((k) => k.kind === e.target.value)
                    // 종류가 바뀌면 이전 종류에 붙어 있던 id 라벨은 버린다(라벨과 내용 불일치 방지)
                    if (meta) patchEntry(flat.map((x, j) => (j === i ? { cond: meta.make() } : x)))
                  }}
                >
                  {KIND_MENU.map((k) => (
                    <option key={k.kind} value={k.kind}>
                      {k.label}
                      {usedCondKinds.has(k.kind) && k.kind !== f.cond.kind ? ' ✓ 사용 중' : ''}
                    </option>
                  ))}
                </select>
                <CondFields cond={f.cond} onChange={(cond) => patchEntry(flat.map((x, j) => (j === i ? { ...x, cond } : x)))} />
                <button
                  type="button"
                  className="bt-btn-mini danger bt-cond-del"
                  aria-label={`조건 ${i + 1} 삭제`}
                  title="이 조건 삭제"
                  onClick={() => patchEntry(flat.filter((_, j) => j !== i))}
                >
                  ✕
                </button>
              </div>
            ))}
            <div className="bt-add-row">
              <select
                className="bt-add-select"
                value=""
                aria-label="조건 추가"
                onChange={(e) => {
                  const meta = KIND_MENU.find((k) => k.kind === e.target.value)
                  if (meta) patchEntry([...flat, { cond: meta.make() }])
                }}
              >
                <option value="">＋ 조건 추가…</option>
                {KIND_MENU.map((k) => (
                  <option key={k.kind} value={k.kind}>
                    {k.label}
                    {usedCondKinds.has(k.kind) ? ' ✓ 사용 중' : ''}
                  </option>
                ))}
              </select>
              <span className="bt-hint">
                ✓ 표시는 이미 조건식에 들어 있다는 뜻입니다 — 같은 종류를 여러 번 넣어도 됩니다(예: 5일선·20일선 돌파 동시).
              </span>
            </div>
          </>
        )}
      </div>
      )}

      {/* ---- 매도 조건 ---- (결합 모드에서는 이것이 슬리브 A다) */}
      {kind !== 'momentum' && (
      <div className="bt-controls">
        <strong>
          매도 조건 (먼저 걸리는 것이 청산)
          <InfoTip text="조건검색은 매수 신호만 줍니다 — 수익률을 가르는 건 매도 규칙입니다. 손절·익절은 장중 저가/고가가 닿으면 발동하되 갭으로 관통하면 시가(더 불리한 쪽)에 체결한 것으로 계산합니다." />
        </strong>
        {spec.exits.length === 0 && (
          <div className="bt-cond-empty">매도 규칙이 없습니다 — 청산 조건이 없으면 진입 후 끝까지 보유합니다.</div>
        )}
        {spec.exits.map((rule, i) => (
          <div key={`${i}:${rule.kind}`} className="bt-cond-row bt-cond-card is-active">
            <span className="bt-cond-flag" title="이 규칙이 현재 매도 조건에 포함되어 있습니다">
              ✓ 적용 중
            </span>
            <select
              className="bt-cond-kind"
              value={rule.kind}
              aria-label={`매도 규칙 ${i + 1} 종류`}
              onChange={(e) => {
                const meta = EXIT_MENU.find((m) => m.make().kind === e.target.value)
                if (meta) setSpec((s) => ({ ...s, exits: s.exits.map((x, j) => (j === i ? meta.make() : x)) }))
              }}
            >
              {EXIT_MENU.map((m) => {
                const k = m.make().kind
                return (
                  <option key={k} value={k}>
                    {EXIT_LABELS[k]}
                    {usedExitKinds.has(k) && k !== rule.kind ? ' ✓ 사용 중' : ''}
                  </option>
                )
              })}
            </select>
            <ExitFields rule={rule} onChange={(r) => setSpec((s) => ({ ...s, exits: s.exits.map((x, j) => (j === i ? r : x)) }))} />
            <button
              type="button"
              className="bt-btn-mini danger bt-cond-del"
              aria-label={`매도 규칙 ${i + 1} 삭제`}
              title="이 규칙 삭제"
              onClick={() => setSpec((s) => ({ ...s, exits: s.exits.filter((_, j) => j !== i) }))}
            >
              ✕
            </button>
          </div>
        ))}
        <div className="bt-add-row">
          <select
            className="bt-add-select"
            value=""
            aria-label="매도 규칙 추가"
            onChange={(e) => {
              const meta = EXIT_MENU.find((m) => m.make().kind === e.target.value)
              if (meta) setSpec((s) => ({ ...s, exits: [...s.exits, meta.make()] }))
            }}
          >
            <option value="">＋ 매도 규칙 추가…</option>
            {EXIT_MENU.map((m) => {
              const k = m.make().kind
              return (
                <option key={k} value={k}>
                  {m.label}
                  {usedExitKinds.has(k) ? ' ✓ 사용 중' : ''}
                </option>
              )
            })}
          </select>
          <span className="bt-hint">
            여러 규칙 중 <strong>먼저 걸리는 것</strong>이 청산입니다 — 같은 종류를 여러 번 넣어도 됩니다.
          </span>
        </div>
      </div>
      )}

      {/* ---- 실행 설정 ---- */}
      <div className="bt-controls bt-settings">
        {/* 아래 4개는 조건식 전용이다 — 모멘텀 모드는 상위 N·게이트만 쓰고 이 값들을 읽지 않는다.
            그대로 두면 "바꿔도 결과가 안 변하는 입력"이 되어 사용자를 속인다.
            결합 모드에서는 슬리브 A(조건식)가 이 값들을 그대로 쓰므로 함께 보여준다. */}
        {kind !== 'momentum' && (
        <>
        <label>
          동시 보유
          <span className="bt-inline-field">
            <Num
              value={spec.sizing.maxPositions}
              onChange={(v) => setSpec((s) => ({ ...s, sizing: { ...s.sizing, maxPositions: v ?? 1 } }))}
              title="동시 보유 종목 수"
              integer
              min={1}
              max={30}
            />
            종목
          </span>
        </label>
        <label>
          체결
          <select
            value={spec.execution.timing}
            onChange={(e) =>
              setSpec((s) => ({ ...s, execution: { ...s.execution, timing: e.target.value as StrategySpec['execution']['timing'] } }))
            }
          >
            <option value="nextOpen">익일 시가 (규칙형 기본)</option>
            <option value="sameClose">당일 종가 LOC (알고리즘형)</option>
          </select>
        </label>
        <label>
          우선순위
          <select
            value={spec.ranking ? `${spec.ranking.by}:${spec.ranking.dir}` : 'none'}
            onChange={(e) => {
              const v = e.target.value
              setSpec((s) => ({
                ...s,
                ranking:
                  v === 'none'
                    ? null
                    : { by: v.split(':')[0] as NonNullable<StrategySpec['ranking']>['by'], dir: v.split(':')[1] as 'asc' | 'desc' },
              }))
            }}
          >
            <option value="changePct:desc">등락률 높은 순</option>
            <option value="tradingValue:desc">거래대금 큰 순</option>
            <option value="volume:desc">거래량 많은 순</option>
            <option value="none">유니버스 순서</option>
          </select>
        </label>
        <label>
          장 레짐
          <InfoTip text="코스피 지수의 5·10일선이 정배열인 날에만 신규 진입 후보를 뽑습니다. 보유 종목의 매도 규칙은 레짐과 무관하게 계속 동작합니다. 백테스트 실측: 승률엔 +1~2%p지만 최대낙폭을 크게 줄입니다(−44%→−30%)." />
          <select
            value={spec.regime ? 'kospi' : 'none'}
            onChange={(e) => setSpec((s) => ({ ...s, regime: e.target.value === 'kospi' ? KOSPI_REGIME : null }))}
          >
            <option value="none">없음</option>
            <option value="kospi">코스피 5·10일선 정배열일 때만 진입</option>
          </select>
        </label>
        </>
        )}
        {kind !== 'condition' && (
          <label>
            보유 규칙{kind === 'combo' ? ' (슬리브 B)' : ''}
            <InfoTip text="모멘텀 모드는 동시 보유 수를 위의 '보유 종목 수'로, 체결을 '월 첫 거래일 시가'로 고정합니다. 우선순위는 12-1 모멘텀 순위이고, 매도 규칙·장 레짐은 쓰지 않습니다." />
            <span className="bt-hint">
              상위 {mom.slots}종목 동일가중 · 월초 시가 리밸런스 · 게이트 {mom.gate ? '켬' : '끔'}
            </span>
          </label>
        )}
        <label>
          시작일
          <input
            type="date"
            value={startDate}
            max={endDate || undefined}
            onChange={(e) => setStartDate(e.target.value)}
            title="비우면 데이터 시작부터"
          />
        </label>
        <label>
          종료일
          <InfoTip text="이 날짜 이후의 봉을 잘라낸 뒤 백테스트합니다(엔진에 넘기기 전에 자릅니다). 벤치마크·알파도 같은 구간으로 계산됩니다. 비우면 데이터 끝까지 — 최근 구간을 빼고 과거만 검증하는 홀드아웃에 쓰세요." />
          <input
            type="date"
            value={endDate}
            min={startDate || undefined}
            onChange={(e) => setEndDate(e.target.value)}
            title="비우면 데이터 끝까지"
          />
        </label>
        {endDate && (
          <button type="button" className="bt-btn-mini" onClick={() => setEndDate('')} title="종료일 지우기">
            종료일 해제
          </button>
        )}
      </div>
      {dateError && <div className="bt-warn">⛔ {dateError} — 기간을 수정하면 실행할 수 있습니다.</div>}

      <div className="bt-controls bt-settings">
        <label>
          유니버스 (고정 불가)
          <InfoTip text="종목을 직접 고르는 입력은 없앴습니다. 오늘 살아남은 대형주를 표본으로 고정하면 과거 성적이 크게 부풀려지기 때문입니다(승자편향). 목록은 KRX Open API 실측 랭킹이며, 매년 1월 1일에 그 해 유니버스로 교체하고 그 해를 독립 실행한 뒤 연말 평가액을 다음 해 자본으로 이월합니다. 실측 파일을 읽지 못하면 [추정] 목록으로 대신 돌리지 않고 실행을 막습니다 — 33차에서 [추정] 목록발 알파가 무너졌기 때문입니다." />
        </label>
        {/* 유니버스 폭은 **시장별로** 고른다(2026-08-03 대표 지시). 0을 고르면 그 시장을 뺀다 —
            코스피만·코스닥만 돌려 어느 쪽이 성적을 만들었는지 가를 수 있다. */}
        <label>
          코스피 상위
          <select
            value={width.kospi}
            disabled={busy}
            onChange={(e) => setWidth((w) => ({ ...w, kospi: normalizeTopN(Number(e.target.value)) }))}
            title="코스피에서 그 해 시총 상위 N을 잘라 씁니다. 0이면 코스피를 뺍니다."
          >
            {KRX_TOP_N_CHOICES.map((n) => (
              <option key={n} value={n}>
                {n === 0 ? '없음(제외)' : `상위 ${n}`}
              </option>
            ))}
          </select>
        </label>
        <label>
          코스닥 상위
          <InfoTip text="시장별로 따로 고릅니다. 수집 원본이 시장당 40종목이라 40이 상한이고, 0을 고르면 그 시장을 제외합니다(둘 다 0이면 실행할 수 없습니다). ⚠️ 프리셋 2종의 성적은 코스피 10 + 코스닥 10에서 나온 것이라, 폭을 바꾸면 그 수치와 직접 비교할 수 없습니다 — 폭을 바꾸면 프리셋 사전계산 수치는 화면에서 사라지고 직접 실행해야 합니다." />
          <select
            value={width.kosdaq}
            disabled={busy}
            onChange={(e) => setWidth((w) => ({ ...w, kosdaq: normalizeTopN(Number(e.target.value)) }))}
            title="코스닥에서 그 해 시총 상위 N을 잘라 씁니다. 0이면 코스닥을 뺍니다."
          >
            {KRX_TOP_N_CHOICES.map((n) => (
              <option key={n} value={n}>
                {n === 0 ? '없음(제외)' : `상위 ${n}`}
              </option>
            ))}
          </select>
        </label>
        {!isDefaultKrxWidth(width) && (
          <div className="bt-note" style={{ width: '100%' }}>
            ⚠️ 지금 폭은 <strong>{krxWidthLabel(width)}</strong>입니다 — 프리셋 2종의 성적이 나온 폭(
            {krxWidthLabel(DEFAULT_KRX_WIDTH)})과 달라서 <strong>그 수치와 직접 비교할 수 없습니다.</strong> 이
            폭의 성적은 직접 실행해야 나옵니다.
          </div>
        )}
        <label>
          시세 소스
          <select
            value={priceSource}
            disabled={busy}
            onChange={(e) => setPriceSource(normalizePriceSource(e.target.value))}
            title="국내 유니버스 종목의 시세를 어디서 받을지 — 벤치·참고선은 어느 쪽을 골라도 Yahoo입니다"
          >
            {PRICE_SOURCES.map((s) => (
              <option key={s} value={s}>
                {PRICE_SOURCE_LABEL[s]}
              </option>
            ))}
          </select>
          <InfoTip text="Yahoo는 배당까지 반영된 총수익 시계열이지만 상장폐지 종목이 통째로 빠져 생존편향이 남습니다(6자리 코드에 엉뚱한 티커의 짧은 응답이 온 사고도 있었습니다). KRX 일별 정본은 그날 상장돼 있던 전 종목의 실측 단면이라 상폐 종목도 들어 있지만, 원주가(수정 전)라 분할 보정을 우리가 산출하며 배당은 반영되지 않습니다(가격수익). 두 소스의 성적은 같은 표에서 직접 비교하면 안 됩니다. 데이터가 없으면 Yahoo로 조용히 대신 돌리지 않고 실행을 막습니다." />
        </label>
        <div className="bt-note" style={{ width: '100%' }}>
          {priceSource === 'krx' && krxDaily.status === 'loading' && <strong>KRX 일별 정본 확인 중…</strong>}
          {priceSource === 'krx' && (krxDaily.status === 'missing' || krxDaily.status === 'error') && (
            <div className="bt-warn" role="alert">
              ⛔ {krxDaily.reason}
              <div style={{ marginTop: 4 }}>
                {krxDaily.status === 'missing'
                  ? '수집이 끝나 public/data/krx-daily/ 파일이 리포에 커밋되면 이 선택지가 열립니다. 그때까지는 Yahoo로 돌리세요 — 다만 Yahoo 성적에는 생존편향이 남아 있습니다.'
                  : '파일은 있는데 형식이 맞지 않습니다 — 수집을 다시 돌려야 합니다(Yahoo로 대신 돌리는 것은 소스가 섞이므로 자동으로 하지 않습니다).'}
              </div>
            </div>
          )}
          {priceSource === 'krx' && krxDaily.status === 'ready' && (
            <>
              <span className="badge">KRX 실측 일별</span>{' '}
              <strong>
                {krxDaily.from}~{krxDaily.to} · {krxDaily.stocks}종목
              </strong>
              <div style={{ marginTop: 4, fontSize: 12 }}>{krxDaily.note}</div>
            </>
          )}
          {priceSource === 'yahoo' && krxDaily.status === 'ready' && (
            <div style={{ fontSize: 12 }}>
              KRX 일별 정본({krxDaily.from}~{krxDaily.to} · {krxDaily.stocks}종목)이 준비돼 있습니다 — 소스를 바꾸면
              상폐 종목이 포함된 시계열로 다시 돌릴 수 있습니다(대신 <strong>배당 미반영</strong>이라 수치를 Yahoo
              결과와 직접 비교하면 안 됩니다).
            </div>
          )}
          <div style={{ marginTop: 4, fontSize: 12 }}>{MIXED_SOURCE_NOTE}</div>
        </div>
        <div className="bt-note" style={{ width: '100%' }}>
          {uniError ? (
            <div className="bt-warn" role="alert">
              ⛔ {uniError}
            </div>
          ) : !uni ? (
            <strong>KRX 실측 유니버스 읽는 중…</strong>
          ) : (
            <>
              <strong>{uni.label}</strong> <span className="badge">KRX 실측</span>
              <div style={{ marginTop: 4, fontSize: 12 }}>
                {uni.sourceNote}
              </div>
              <div style={{ marginTop: 4, fontSize: 12 }}>
                매년 1/1 그 해 목록으로 교체 → 연 단위 독립 실행 → 연말 평가액 이월(연말 청산 근사).{' '}
                <strong>랭킹은 실측이라 목록 선택편향이 없습니다.</strong> 다만 상장폐지 종목은 가격이 없어 빠지므로{' '}
                <strong>가격 생존편향은 남아 있고</strong>, 그만큼 성적이 실제보다 후합니다 — 아래 연도별 표의
                매핑률로 확인하세요. 매핑 5종목 미만인 해는 현금 보유로 처리합니다.{' '}
                <strong>2010년 이전은 수집 자체가 불가능</strong>합니다(KRX Open API 시작) — 2008 금융위기 전반부가
                빠져 있어 2000년부터 돌던 옛 회차 수치와 직접 비교하면 거짓입니다.
              </div>
            </>
          )}
        </div>
        <div className="bt-controls bt-settings" style={{ padding: 0, border: 'none' }}>
          <label>
            수수료(%)
            <Num value={cost.feePct} onChange={(v) => setCost((c) => ({ ...c, feePct: v ?? 0 }))} title="편도 수수료(%)" step={0.005} min={0} />
          </label>
          <label>
            거래세(%)
            <Num value={cost.taxPct} onChange={(v) => setCost((c) => ({ ...c, taxPct: v ?? 0 }))} title="매도 거래세(%)" step={0.05} min={0} />
          </label>
          <label>
            슬리피지(%)
            <Num
              value={cost.slippagePct}
              onChange={(v) => setCost((c) => ({ ...c, slippagePct: v ?? 0 }))}
              title="편도 슬리피지(%)"
              step={0.05}
              min={0}
            />
          </label>
          <label>
            초기자본(원)
            <Num
              value={cost.initialCapital}
              onChange={(v) => setCost((c) => ({ ...c, initialCapital: v ?? DEFAULT_COST.initialCapital }))}
              title="초기 투입 자본(원)"
              step={1_000_000}
              integer
              min={100_000}
            />
          </label>
        </div>
      </div>

      {/* ---- 스펙 검증 경고 ---- */}
      {kind !== 'momentum' && issues.length > 0 && (
        <div className="bt-warn">
          {issues.map((it, i) => (
            <div key={i}>
              {it.level === 'error' ? '⛔' : '⚠️'} {it.message}
            </div>
          ))}
        </div>
      )}

      {/* ---- 실행 ---- */}
      <div className="bt-actions">
        <button
          type="button"
          className="bt-btn-run"
          disabled={
            busy ||
            dateError != null ||
            uni == null ||
            priceSourceBlock != null ||
            (kind !== 'momentum' && issues.some((i) => i.level === 'error'))
          }
          onClick={run}
        >
          {busy
            ? (progress ?? '실행 중…')
            : uniError
              ? '유니버스 로드 실패 — 실행 불가'
              : uni == null
                ? '유니버스 읽는 중…'
                : priceSourceBlock
                  ? krxDaily.status === 'loading'
                    ? 'KRX 정본 확인 중…'
                    : 'KRX 정본 없음 — 실행 불가'
                  : '▶ 백테스트 실행 (2차 검증)'}
        </button>
        {kind !== 'momentum' && (
          <button type="button" className="bt-btn-mini" onClick={exportJson}>
            스펙 JSON
          </button>
        )}
        <select
          value=""
          disabled={busy}
          aria-label="프리셋 불러오기"
          onChange={(e) => {
            const p = PRESETS.find((x) => x.id === e.target.value)
            if (!p) return
            setKind(p.kind)
            if (p.kind === 'condition') {
              setSpec(p.spec)
              setMomNote(null)
            } else if (p.kind === 'momentum') {
              setMom(p.mom)
              setMomNote(p.note)
            } else {
              // 결합 프리셋은 **두 슬리브와 옵션을 한꺼번에** 세팅한다 —
              // 한쪽만 바뀌면 검증된 조합이 아니게 된다(옵션도 조합의 일부다).
              setSpec(p.spec)
              setMom(p.mom)
              setComboWA(normalizeWA(p.wA))
              setMarketGate(p.marketGate === true)
              setGoldW(normalizeGoldW(p.goldW))
              setMomNote(p.note)
            }
            // 사전계산이 있으면 **즉시** 결과를 띄운다(수십 초짜리 실행을 기다리지 않는다).
            // 없으면 null — 예전처럼 실행 버튼을 눌러야 결과가 나온다(우아한 강등).
            setShownPre(precomputed?.byId[p.id] ?? null)
            // 이 프리셋이 만들 설정의 지문을 함께 박아 둔다. 이후 사용자가 조건·슬롯·가중을
            // 손대면 지문이 어긋나 블록이 사라진다(바뀐 설정에 옛 성적을 붙여 두지 않는다).
            setPreSig(
              JSON.stringify({
                kind: p.kind,
                mom: p.kind === 'condition' ? mom : p.mom,
                comboWA: p.kind === 'combo' ? normalizeWA(p.wA) : comboWA,
                marketGate: p.kind === 'combo' ? p.marketGate === true : marketGate,
                goldW: p.kind === 'combo' ? normalizeGoldW(p.goldW) : goldW,
                spec: p.kind === 'momentum' ? spec : p.spec,
              }),
            )
            setJsonOpen(false)
          }}
          title="프리셋 불러오기"
        >
          <option value="" disabled>
            프리셋 불러오기…
          </option>
          {/* 목록에 2종이 남아 있지만 **둘 다 40차에서 판정 탈락**했다(라벨이 ❌ [탈락]로 시작한다).
              지우지 않은 이유는 기록을 없애면 다음 세션이 같은 조합을 다시 후보로 올리기 때문이다.
              구 10종은 [추정] 목록 위에서 고른 것이라 33차에서 전부 뺐다. */}
          {/* 라벨의 MDD·10년 연평균은 **사전계산 산출물에서 온다** — 하드코딩이 아니라
              GHA가 파일을 갱신하면 라벨도 따라 바뀐다. 파일이 없으면 원래 라벨 그대로. */}
          {PRESETS.map((p) => (
            <option key={p.id} value={p.id}>
              {augmentPresetLabel(p.label, precomputed?.byId[p.id])}
            </option>
          ))}
        </select>
      </div>
      {/* 상시 안내 — 프리셋이 어떤 유니버스 위에서 나왔는지, 왜 구 프리셋이 사라졌는지 한 줄로 못 박는다.
          이 줄은 프리셋을 고르지 않아도 항상 보인다(고르고 나서야 알게 되면 늦다). */}
      {/* 40차(2026-08-03)부터 이 자리는 "프리셋 없음"을 말한다. 경고(bt-warn)로 올린 이유는
          이것이 안내가 아니라 **쓰지 말라는 통지**이기 때문이다 — 목록에 두 줄이 남아 있어서
          고를 수 있게 보이는 것이 이 화면의 유일한 위험 지점이다. */}
      <div className="bt-warn" role="alert">
        <strong>{PRESET_BANNER}</strong>
        <div style={{ marginTop: 4, fontSize: 12 }}>{PRESET_FAILED_NOTE}</div>
        <div style={{ marginTop: 4, fontSize: 12 }}>
          ⚠️ 같은 구간{' '}
          <strong>
            QQQ 원화 보유(칼마 {wall.calmar.toFixed(3)} · CAGR {fmtPct(wall.cagrPct)} · MDD {fmtPct(wall.mddPct)})를
            넘은 조합은 지금까지 하나도 없습니다
          </strong>{' '}
          — 34·40차 35변형 · 38차 밸류 18변형 · 39차 고원 405셀 전부입니다.
          {wallFromFile && ' (이 벽 수치는 사전계산 산출물에서 같은 구간으로 다시 잰 실측값입니다.)'}
        </div>
      </div>
      {error && (
        <div className="bt-warn" role="alert">
          ⛔ {error}
        </div>
      )}
      {/* 안내는 쌓아서 전부 보여준다 — 뒤 안내가 앞 안내를 지우지 않는다 */}
      {notes.map((n, i) => (
        <div key={i} className={n.startsWith('⚠️') ? 'bt-warn' : 'bt-note'}>
          {n}
        </div>
      ))}

      {/* ---- JSON 편집 ---- */}
      {jsonOpen && kind !== 'momentum' && (
        <div className="bt-controls">
          <strong>
            스펙 JSON — 이 문서가 조건식의 정본입니다
            <InfoTip text="시뮬레이터가 실행하는 것도, (미래에 대표 승인 후) 실시간 평가기가 실행하는 것도 이 JSON입니다. 복사해 두면 조건식을 잃지 않습니다. OR/NOT 트리 등 화면에 없는 고급 기능도 JSON으로 편집할 수 있습니다. 단 universe.symbols는 실행 시 그 해 유니버스로 덮어써지므로 여기서 종목을 고정할 수 없습니다." />
          </strong>
          <textarea
            value={jsonText}
            onChange={(e) => setJsonText(e.target.value)}
            rows={14}
            style={{ width: '100%', fontFamily: 'monospace', fontSize: 12 }}
            spellCheck={false}
          />
          {jsonError && <div className="bt-warn">⛔ {jsonError}</div>}
          <div className="bt-actions">
            <button type="button" className="bt-btn-mini primary" onClick={importJson}>
              JSON 적용
            </button>
            <button type="button" className="bt-btn-mini" onClick={() => setJsonOpen(false)}>
              닫기
            </button>
          </div>
        </div>
      )}

      {/* ---- 사전계산 결과 (프리셋을 고른 즉시) ---- */}
      {showPre && shownPre && precomputed && (
        <PrecomputedResult
          pc={shownPre}
          asOf={precomputed.asOf}
          computedAt={precomputed.computedAt}
          mismatch={preMismatch}
          busy={busy}
          onRerun={run}
        />
      )}

      {/* ---- 결과 ---- (사전계산을 띄운 동안에는 이전 실행 결과를 숨긴다 — 수치 혼동 방지) */}
      {!showPre && result && summary && (
        <div className="bt-results">
          <div className="kpi-row">
            <KpiCard
              label="총 수익률"
              value={fmtPctGrouped(summary.totalPct)}
              unit={` · 연 ${fmtPct(summary.cagrPct)}`}
              changeText={
                summary.benchTotalPct != null && summary.benchCagrPct != null
                  ? `벤치마크(KODEX 200) 총 ${fmtPctGrouped(summary.benchTotalPct)} · 연 ${fmtPct(summary.benchCagrPct)}`
                  : '벤치마크 로드 실패'
              }
              changeLabel=""
              direction={summary.benchTotalPct != null && summary.totalPct > summary.benchTotalPct ? 'up' : 'down'}
              info="연도별 유니버스를 갈아끼우며 연 단위로 이어붙인 누적 수익입니다. 총액 %는 구간이 길수록 복리로 부풀어 보이므로 실제 체감은 연환산(CAGR)으로 보세요. 벤치마크도 같은 연말 경계로 연쇄해 비교합니다."
            />
            <KpiCard
              label="초과수익(알파, 연환산)"
              value={summary.alphaCagrPct != null ? fmtPp(summary.alphaCagrPct) : '—'}
              unit=" / 연"
              changeText={
                summary.alphaTotalPct != null
                  ? `총 ${fmtPp(summary.alphaTotalPct)} · ${result.startDate}~${result.endDate} (${summary.years.toFixed(1)}년)`
                  : `${result.startDate}~${result.endDate} (${summary.years.toFixed(1)}년)`
              }
              changeLabel=""
              direction={summary.alphaCagrPct != null && summary.alphaCagrPct > 0 ? 'up' : 'down'}
              badge={benchGap ? `⚠️ 벤치 구간: ${benchGap}~` : undefined}
              badgeTitle={`벤치마크(KODEX 200) 데이터가 ${benchGap}부터라 그 이전 구간에는 비교 대상이 없습니다 — 그만큼 알파가 과대평가됩니다.`}
              info="규칙 5의 판정 기준은 연환산 알파(전략 CAGR − 벤치마크 CAGR)입니다. 총액 차이는 보조 지표로만 보세요. 음수면 그냥 지수를 사는 편이 나았다는 뜻입니다."
            />
            <KpiCard
              label="최대 낙폭(MDD)"
              value={fmtPct(summary.mdd)}
              changeText="고점 대비 최대 하락"
              changeLabel=""
              direction="flat"
              info="연도별 곡선을 이어붙인 전체 기간 기준입니다. 수익률보다 먼저, 이 낙폭을 실제로 견딜 수 있는지 확인하세요."
            />
            <KpiCard
              label="수익 ÷ MDD"
              value={summary.objective != null ? summary.objective.toFixed(1) : '—'}
              changeText="총수익% ÷ |MDD%|"
              changeLabel=""
              direction="flat"
              info="같은 수익이라도 덜 아프게 번 쪽을 고르기 위한 보조 지표입니다. 이 값을 최대화하도록 조합을 고르는 행위 자체가 곡선맞춤이므로, 구간을 나눠도 값이 유지되는지 함께 보세요(규칙 5)."
            />
            <KpiCard
              label="연평균 ÷ MDD (칼마)"
              value={Math.abs(summary.mdd) > 0.01 ? (summary.cagrPct / Math.abs(summary.mdd)).toFixed(2) : '—'}
              changeText={`연 ${fmtPct(summary.cagrPct)} ÷ 낙폭 ${fmtPct(Math.abs(summary.mdd))}`}
              changeLabel=""
              direction="flat"
              info="칼마 비율 — 연평균 수익률(CAGR)을 최대 낙폭으로 나눈 값입니다. 총수익÷MDD는 구간이 길수록 복리로 부풀어 오르지만, 이 값은 기간과 무관하게 '낙폭 1%를 견딘 대가로 연 몇 %를 벌었나'를 잽니다. 1을 넘으면 낙폭보다 연수익이 큰 것입니다."
            />
            {/* 결합 모드는 두 슬리브 **곡선의 합성**이라 체결이 어느 쪽에도 귀속되지 않는다.
                여기에 0/—을 그냥 두면 "매매가 없었다"로 읽히므로, 어디서 읽어야 하는지 명시한다. */}
            {kind === 'combo' ? (
              <KpiCard
                label="승률 / 매매"
                value="합성"
                unit=""
                changeText="결합 곡선에는 매매 원장이 없습니다 — A·B 단독 실행에서 확인하세요 (아래 슬리브 단독 성적 표)"
                changeLabel=""
                direction="flat"
                info="결합은 두 슬리브를 각각 전액 투자로 돌린 곡선을 월 단위로 합성한 것입니다. 체결(매수·매도)은 각 슬리브 안에서 일어나므로 결합 곡선 자체에는 귀속되는 매매가 없습니다. 0건이라는 뜻이 아닙니다 — 매매수·승률·평균손익은 아래 「슬리브 단독 성적」 표나 각 유형을 단독으로 실행해 읽으세요."
              />
            ) : (
              <KpiCard
                label="승률 / 매매"
                value={summary.winRate != null ? `${summary.winRate.toFixed(0)}%` : '—'}
                unit={summary.tradeCount ? ` / ${summary.tradeCount}회` : ''}
                changeText={`평균 손익 ${summary.avgPnl != null ? fmtPct(summary.avgPnl, 2) : '—'} · 연말 이월(미청산) ${result.openAtEnd}`}
                changeLabel=""
                direction="flat"
                info="청산이 끝난 매매 중 이익으로 끝난 비율입니다(미청산 포지션은 확정 손익이 아니라 제외 — 연말 이월 건수를 함께 적어 둡니다). 승률만으로는 성과를 알 수 없습니다: 조금씩 여러 번 벌고 한 번에 크게 잃으면 승률 80%도 손실로 끝납니다. 옆의 손익비·Profit Factor와 반드시 함께 보세요. 매매 수가 적으면(수십 건 이하) 승률은 우연의 산물일 수 있습니다."
              />
            )}
            {/* 표준 성과 지표 — 사전계산 화면과 **같은 카드**(정의·설명이 갈라질 수 없다) */}
            {perf && (
              <PerfStatCards stats={perf.stats} detail={perf.detail} ledgerAttributed={perf.attributed} />
            )}
          </div>

          {/* 시세 소스 — **설정값이 아니라 실행 결과**다(규칙 3). 어느 시세로 나온 수치인지
              표 옆에 붙여 두지 않으면 총수익(야후)과 가격수익(KRX)이 같은 축에서 읽힌다. */}
          {priceMeta && (
            <>
              <div className="badges">
                <span className="badge">{priceMeta.badge}</span>
                <span className="badge">
                  {priceMeta.loaded}/{priceMeta.requested}종목 · 데이터 끝 {priceMeta.asOf || '—'}
                </span>
              </div>
              <div className="bt-note" style={{ fontSize: 12 }}>
                <div>{priceMeta.note}</div>
                <ul style={{ margin: '4px 0 0 16px', padding: 0 }}>
                  {priceMeta.limits.map((l, i) => (
                    <li key={i}>{l}</li>
                  ))}
                </ul>
                <div style={{ marginTop: 4 }}>{MIXED_SOURCE_NOTE}</div>
              </div>
            </>
          )}

          {/* 슬리브 단독 성적 — 결합 곡선에 없는 매매 원장이 여기 있다 */}
          {kind === 'combo' && comboOpts && (comboOpts.gatedMonths > 0 || comboOpts.goldW > 0) && (
            <div className="badges">
              {comboOpts.gatedMonths > 0 && (
                <span className="badge sample">
                  시장게이트 적용 {comboOpts.gatedMonths}달 / {comboOpts.totalMonths}달 (B 슬리브 현금)
                </span>
              )}
              {comboOpts.goldW > 0 && (
                <span className="badge sample">
                  금 슬리브 {Math.round(comboOpts.goldW * 100)}% · {comboOpts.goldFrom ?? '—'}~
                </span>
              )}
            </div>
          )}
          {kind === 'combo' && sleeves && (
            <div className="bt-table-wrap">
              <div className="bt-chart-caption">
                슬리브 단독 성적 — 각 슬리브를 <strong>전액 투자 기준</strong>으로 따로 돌린 결과입니다. 결합 성적은
                이 두 곡선을 월초 {Math.round(comboWA * 100)}:{Math.round((1 - comboWA) * 100)}로 되돌리며 합성한 것이라
                매매 원장이 없습니다 — <strong>매매수·승률은 이 표에서 읽으세요</strong>.
                {comboOpts && comboOpts.gatedMonths > 0 && (
                  <>
                    {' '}
                    슬리브 B 행은 <strong>시장게이트를 반영한 값</strong>입니다 — 게이트가 시뮬 안에서 걸려
                    청산·재매수가 원장에 그대로 들어 있으므로 매매수·승률도 게이트 적용 후 수치입니다.
                  </>
                )}
                {comboOpts && comboOpts.goldW > 0 && (
                  <>
                    {' '}
                    금 슬리브 {Math.round(comboOpts.goldW * 100)}%는 이 표에 없습니다 — 위 결합 곡선에만 섞여 있고
                    매매 원장이 없는 보유 곡선입니다.
                  </>
                )}
              </div>
              <table>
                <thead>
                  <tr>
                    <th>슬리브</th>
                    <th>총 수익률</th>
                    <th>연환산</th>
                    <th>알파(연)</th>
                    <th>MDD</th>
                    <th>매매</th>
                    <th>승률</th>
                  </tr>
                </thead>
                <tbody>
                  {sleeves.map((s) => (
                    <tr key={s.key}>
                      <td>{s.label}</td>
                      <td className={s.totalPct >= 0 ? 'pos' : 'neg'}>{fmtPctGrouped(s.totalPct)}</td>
                      <td>{fmtPct(s.cagrPct)}</td>
                      <td className={(s.alphaCagrPct ?? 0) >= 0 ? 'pos' : 'neg'}>
                        {s.alphaCagrPct != null ? fmtPp(s.alphaCagrPct) : '—'}
                      </td>
                      <td className="neg">{fmtPct(s.mddPct)}</td>
                      <td>{s.tradeCount.toLocaleString('ko-KR')}회</td>
                      <td>{s.winRate != null ? `${s.winRate.toFixed(0)}%` : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="bt-note">
                ⚠️ 단독 행은 <strong>각 슬리브의 전체 구간</strong> 기준이고 결합은 <strong>두 구간이 겹치는
                구간</strong> 기준이라, 구간이 다르면 수치가 직접 비교되지 않습니다. 결합 성적에는{' '}
                <strong>월 리밸런스 매매비용이 반영되어 있지 않습니다</strong> — 실제로는 매월 두 슬리브의 편차만큼
                사고팔아야 하므로 그만큼 깎입니다(낙관적 상한).
              </div>
            </div>
          )}

          {/* 벤치마크 비교 — 2줄. 판정(알파)은 KODEX 200 한 줄뿐이고 QQQ는 참고다(규칙 5 판정 벤치 불변). */}
          <div className="bt-table-wrap">
            <div className="bt-chart-caption">
              벤치마크 비교 — <strong>알파 판정 기준은 KODEX 200</strong>이며, QQQ는 참고 표시입니다(판정에 들어가지 않음)
            </div>
            <table>
              <thead>
                <tr>
                  <th>벤치마크</th>
                  <th>총 수익률</th>
                  <th>연환산</th>
                  <th>MDD</th>
                  <th>비교 구간</th>
                  <th>역할</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>KODEX 200</td>
                  <td>{summary.benchTotalPct != null ? fmtPctGrouped(summary.benchTotalPct) : '—'}</td>
                  <td>{summary.benchCagrPct != null ? fmtPct(summary.benchCagrPct) : '—'}</td>
                  <td>—</td>
                  <td>
                    {result.startDate}~{result.endDate}
                  </td>
                  <td>알파 판정 기준 (규칙 5)</td>
                </tr>
                <tr>
                  <td>{QQQ_LABEL}</td>
                  <td>{qqqRef ? fmtPctGrouped(qqqRef.totalPct) : '—'}</td>
                  <td>{qqqRef ? fmtPct(qqqRef.cagrPct) : '—'}</td>
                  <td>{qqqRef ? fmtPct(qqqRef.mddPct) : '—'}</td>
                  <td>{qqqRef ? `${qqqRef.from}~${qqqRef.to}` : '—'}</td>
                  <td>참고 (알파 미반영)</td>
                </tr>
                <tr>
                  <td>{QLD_LABEL}</td>
                  <td>{qldRef ? fmtPctGrouped(qldRef.totalPct) : '—'}</td>
                  <td>{qldRef ? fmtPct(qldRef.cagrPct) : '—'}</td>
                  <td>{qldRef ? <strong>{fmtPct(qldRef.mddPct)}</strong> : '—'}</td>
                  <td>{qldRef ? `${qldRef.from}~${qldRef.to}` : '—'}</td>
                  <td>참고 (⚠️ 일일 2배 레버리지)</td>
                </tr>
              </tbody>
            </table>
            {qqqRef ? (
              <div className="bt-note">
                QQQ는 총수익 보정(adjclose) 가격에 <strong>USD/KRW(KRW=X) 종가</strong>를 곱한 원화 곡선입니다(결측일은
                직전 환율 이월) — <strong>환헤지·거래비용 미반영</strong>. 전략 곡선과 같은 시작값(초기자본)으로 맞춰
                그렸습니다.
                {qqqRef.from > result.startDate && (
                  <>
                    {' '}
                    ⚠️ 환율·QQQ 데이터가 <strong>{qqqRef.from}</strong>부터라 그 이전 구간은 QQQ 비교가 없습니다 —
                    전략 구간({result.startDate}~)과 <strong>비교 구간이 다릅니다</strong>.
                  </>
                )}
              </div>
            ) : (
              <div className="bt-note">
                QQQ 참고 비교를 표시할 수 없습니다 — QQQ 또는 USD/KRW(KRW=X) 시세를 받지 못했습니다. 백테스트 결과
                자체에는 영향이 없습니다.
              </div>
            )}
            {qldRef && (
              <div className="bt-warn">
                ⚠️ <strong>QLD는 나스닥100의 일일 수익률을 2배로 추적하는 레버리지 ETF입니다(규칙 4 경고).</strong>{' '}
                횡보장에서는 2배 일일 복리가 원금을 갉아먹고(변동성 잠식), 낙폭은 극단적입니다 — 위 MDD 열이 실제로
                견뎌야 했던 하락이며, 2008년급 위기가 오면 −80% 이상도 가능합니다. QLD가 2000~2002년(닷컴 붕괴)에
                존재했다면 −95% 이상을 겪었을 것으로 추정되나 상장(2006년) 전이라 이 비교 구간에는 그 시기가
                없습니다 — 표의 수익률은 <strong>강세장 표본에서 살아남은 성적</strong>입니다. 운용사 스스로 장기 보유
                상품이 아니라고 고지합니다. 환헤지·거래비용·배당세 미반영이며 매수 권유가 아닙니다.
              </div>
            )}
          </div>

          {benchGap && (
            <div className="bt-bench-note">
              ⚠️ <strong>벤치마크 구간 부족</strong> — 실행 구간은 {result.startDate}부터인데 KODEX 200 데이터는{' '}
              {benchGap}부터입니다. 그 이전 구간은 비교 대상 없이 전략 수익만 쌓이므로 <strong>알파가 과대평가</strong>됩니다.
              시작일을 {benchGap} 이후로 맞추면 같은 구간 비교가 됩니다.
            </div>
          )}

          {chartEquity && (
            <EquityChart
              equity={chartEquity}
              benchmarkLabel="KODEX 200 단순보유"
              benchmark2Label={qqqRef ? QQQ_LABEL : undefined}
              benchmark3Label={qldRef ? QLD_LABEL : undefined}
            />
          )}

          {/* 연도별 분해 — 몇 해에 몰려 번 것인지, 그 해 유니버스가 얼마나 채워졌는지 그대로 본다.
              매핑률이 낮은 해는 상장폐지 종목이 빠진 만큼 성적이 후하게 나온다(생존편향 잔존). */}
          {result.perYear.length > 0 && (
            <div className="bt-table-wrap">
              <div className="bt-chart-caption">
                연도별 분해 — 매핑률(그 해 목록 중 가격이 있는 종목){' '}
                {result.mappedAvgPct != null && <>· 평균 {result.mappedAvgPct.toFixed(0)}%</>} · 매핑률이 낮은 해일수록
                생존편향이 크게 남습니다
                {kind === 'combo' && (
                  <>
                    {' '}
                    · <strong>결합 모드의 「매매」 열은 두 슬리브 매매수의 합</strong>입니다(결합 곡선 자체에는 원장이
                    없습니다)
                  </>
                )}
              </div>
              <table>
                <thead>
                  <tr>
                    <th>연도</th>
                    <th>매핑률</th>
                    <th>전략</th>
                    <th>벤치(KODEX 200)</th>
                    <th>초과</th>
                    <th>매매</th>
                  </tr>
                </thead>
                <tbody>
                  {result.perYear.map((r) => (
                    <tr key={r.year}>
                      <td>{r.year}</td>
                      <td>
                        {r.mapped}/{r.total}
                        {r.cash && <span className="badge sample" style={{ marginLeft: 4 }}>현금</span>}
                      </td>
                      <td className={r.strategyPct >= 0 ? 'pos' : 'neg'}>{fmtPct(r.strategyPct)}</td>
                      <td className={(r.benchPct ?? 0) >= 0 ? 'pos' : 'neg'}>{r.benchPct != null ? fmtPct(r.benchPct) : '—'}</td>
                      <td className={r.benchPct != null && r.strategyPct - r.benchPct >= 0 ? 'pos' : 'neg'}>
                        {r.benchPct != null ? fmtPp(r.strategyPct - r.benchPct) : '—'}
                      </td>
                      <td>{r.trades}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* 매도 규칙별 발동 통계 */}
          {result.exitBreakdown.length > 0 && (
            <div className="bt-table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>매도 규칙</th>
                    <th>발동</th>
                    <th>평균 손익</th>
                  </tr>
                </thead>
                <tbody>
                  {result.exitBreakdown.map((b) => (
                    <tr key={b.kind}>
                      <td>{b.label}</td>
                      <td>{b.count}회</td>
                      <td className={b.avgPnlPct != null && b.avgPnlPct >= 0 ? 'pos' : 'neg'}>
                        {b.avgPnlPct != null ? fmtPct(b.avgPnlPct, 2) : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* 매매 이력 (최신순 · 페이지 전체 열람) — 페이지 컨트롤은 스크롤 영역 밖에 둔다 */}
          {allTrades.length > 0 && (
            <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span className="bt-chart-caption" style={{ margin: 0 }}>
                매매 이력 전체 {allTrades.length.toLocaleString()}건 (최신순) — {pageClamped + 1} / {tradePages} 페이지
              </span>
              {tradePages > 1 && (
                <>
                  <button type="button" className="bt-btn-mini" disabled={pageClamped === 0} onClick={() => setTradesPage(0)}>
                    ⏮ 처음
                  </button>
                  <button type="button" className="bt-btn-mini" disabled={pageClamped === 0} onClick={() => setTradesPage((p) => Math.max(0, p - 1))}>
                    ◀ 이전
                  </button>
                  <button type="button" className="bt-btn-mini" disabled={pageClamped >= tradePages - 1} onClick={() => setTradesPage((p) => Math.min(tradePages - 1, p + 1))}>
                    다음 ▶
                  </button>
                  <button type="button" className="bt-btn-mini" disabled={pageClamped >= tradePages - 1} onClick={() => setTradesPage(tradePages - 1)}>
                    끝 ⏭
                  </button>
                </>
              )}
            </div>
            <div className="bt-table-wrap bt-trades-table">
              <table>
                <thead>
                  <tr>
                    <th>종목</th>
                    <th>진입</th>
                    <th>매수가</th>
                    <th>청산</th>
                    <th>매도가</th>
                    <th>수량</th>
                    <th>비중</th>
                    <th>손익</th>
                    <th>사유</th>
                  </tr>
                </thead>
                <tbody>
                  {recentTrades.map((t, i) => (
                    <tr key={i}>
                      <td>{dispSym(t.symbol)}</td>
                      <td>{t.entryDate}</td>
                      <td>{fmtWon(t.entryPrice)}</td>
                      <td>{t.exitDate ?? '보유중'}</td>
                      <td>{fmtWon(t.exitPrice)}</td>
                      <td>{t.qty > 0 ? t.qty.toLocaleString('ko-KR') : '—'}</td>
                      {/* 비중 = 진입 직후 총자산(현금+보유 평가) 대비 매수금액. 슬롯 분할이라 보통 ≈ 100%/슬롯수 */}
                      <td>{t.entryWeightPct != null ? `${t.entryWeightPct.toFixed(1)}%` : '—'}</td>
                      <td className={(t.pnlPct ?? 0) >= 0 ? 'pos' : 'neg'}>{t.pnlPct != null ? fmtPct(t.pnlPct, 2) : '—'}</td>
                      <td>{t.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            </>
          )}

          {/* 마지막 스크리닝 — 왜 걸렸나/왜 떨어졌나 */}
          {screenRows.length > 0 && (
            <div className="bt-table-wrap">
              <div className="bt-chart-caption">
                {kind === 'momentum'
                  ? `마지막 리밸런스 랭킹 (${result.lastScreenDate}) — 12-1 모멘텀 상위와 게이트 판정`
                  : kind === 'combo'
                    ? `마지막 스크리닝 (${result.lastScreenDate}) — 슬리브 A(조건식) 기준입니다. 슬리브 B의 모멘텀 랭킹은 모멘텀 모드를 단독 실행해 확인하세요`
                    : `마지막 스크리닝 (${result.lastScreenDate}) — 조건식이 실제로 무엇을 거르는지 확인`}
              </div>
              <table>
                <thead>
                  <tr>
                    <th>순위</th>
                    <th>종목</th>
                    <th>{kind === 'momentum' ? '12-1 모멘텀' : '등락률'}</th>
                    <th>판정</th>
                    <th>{kind === 'momentum' ? '사유' : '탈락 사유'}</th>
                  </tr>
                </thead>
                <tbody>
                  {screenRows.map((r) => (
                    <tr key={r.symbol}>
                      <td>{r.rank ?? '—'}</td>
                      <td>{dispSym(r.symbol)}</td>
                      <td className={(r.changePct ?? 0) >= 0 ? 'pos' : 'neg'}>
                        {r.changePct != null ? fmtPct(r.changePct, 2) : '—'}
                      </td>
                      <td>{r.passed ? '✅ 편입' : '탈락'}</td>
                      <td style={{ fontSize: 11 }}>{r.reasons.join(' · ') || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {/* 규칙 4 — 수익 옆에 손실 경로를 같은 무게로 둔다. 모멘텀 모드는 낙폭이 특히 깊다. */}
          {kind === 'momentum' && (
            <div className="bt-warn">
              ⚠️ <strong>모멘텀 모드 낙폭 경고</strong> — 25차 실측에서 이 계열의 최대낙폭은{' '}
              <strong>−61%(게이트 켬) ~ −68%(게이트 끔)</strong>였습니다 [추정 · 러너 실행값]. 위 성적을 얻으려면{' '}
              <strong>자산이 고점 대비 3분의 2 가까이 사라지는 구간을 끝까지 들고 있어야 했습니다</strong> — 그 구간에
              중도 이탈하면 이 수익률은 실현되지 않습니다. 무효화 지점: 12-1 모멘텀이 유니버스 전반에서 음수로
              돌아서면(게이트가 대부분의 슬롯을 현금으로 돌리면) 이 전략은 수익원을 잃습니다. 상위 5/10 × 게이트
              on/off를 함께 돌려 그중 좋은 것을 고른 <strong>다중비교 승자</strong>라 과최적화 위험이 남아 있고, 연
              20종목 유니버스에서 상위 5는 사실상 상위 25% 분위라 학계의 분위 모멘텀보다 신호가 묽습니다. 매수 권유가
              아니며 관찰·조건부 서술입니다.
            </div>
          )}
          {/* 규칙 4 — 결합은 "낙폭이 줄어든다"는 기대로 고르는 조합이라, 그 기대가 어디서 깨지는지를
              수익과 같은 무게로 붙여 둔다. */}
          {kind === 'combo' && (
            <div className="bt-warn">
              ⚠️ <strong>결합 모드 낙폭·한계 경고</strong> — 26차 실측(50:50)의 최대낙폭은{' '}
              <strong>−43.1%</strong>였습니다 [추정 · 러너 실행값]. 결합의 존재 이유는 낙폭 완화인데, 실제 완화 폭은{' '}
              <strong>두 단독 평균 대비 +3.6%p뿐</strong>이라 <strong>분산 효과가 제한적</strong>입니다. 더 중요한
              것은 <strong>2008년 같은 위기 구간에서 두 슬리브의 상관이 1에 붙어 같이 무너졌다</strong>는 점입니다 —
              분산이 가장 필요한 순간에 사라졌습니다. 성적에는{' '}
              <strong>월 리밸런스 매매비용이 반영되어 있지 않습니다</strong>(슬리브 간 이체를 0원으로 본 낙관적
              상한). 슬리브 B(횡단면 모멘텀)는 <strong>미국 시장 교차 검증에서 알파가 남지 않았습니다</strong> —
              한국 표본 밖으로 일반화할 근거가 없어, 과거 한 표본의 성질일 수 있습니다. A·B 각각이 이미 여러 조합 중
              성적이 좋았던 것을 고른 다중비교 승자이고 결합 가중까지 함께 봤으므로{' '}
              <strong>다중검정으로 부풀려진 성적일 위험</strong>이 겹쳐 있습니다. 무효화 지점: 두 슬리브의 월수익률
              상관이 높아지거나(같은 것을 두 번 사는 셈) 슬리브 B의 모멘텀 알파가 사라지면 결합의 근거가 무너집니다.
              매수 권유가 아니며 관찰·조건부 서술입니다.
            </div>
          )}
        </div>
      )}

      <div className="bt-disclaimer">
        유니버스는 <strong>각 해 연초 시가총액 상위 코스피10+코스닥10 [추정]</strong>입니다 — KRX 실측이 아니며
        (Open API 키 등록 시 실측으로 대체 예정) 목록 자체가 틀렸을 수 있습니다. 상장폐지 종목은 가격 데이터가
        없어 빠지므로 <strong>일부 생존편향이 잔존</strong>하고(연도별 매핑률 참조), 매년 말 평가액을 다음 해로
        이월하는 <strong>연말 청산 근사</strong>가 들어갑니다. 시뮬레이션 전용 — 주문·실계좌·브로커 API와 연결되어
        있지 않습니다. 전 종목이 아니라 연 20종목 표본이므로 실제 조건검색과 결과가 다릅니다. 국내 종목 시세:{' '}
        <strong>{PRICE_SOURCE_LABEL[priceSource]}</strong>
        {priceSource === 'yahoo' ? (
          <>
            {' '}
            — 비공식 엔드포인트 · 정확성 미보증 · 환율 미반영. <strong>{KR_LOAD_NOTE}</strong>
          </>
        ) : (
          <>
            {' '}
            — KRX Open API 일별 단면의 원주가에 <strong>분할 보정을 자체 산출</strong>해 쓰며{' '}
            <strong>배당은 반영되지 않습니다(가격수익)</strong>. 2010년 이전 구간은 수집 자체가 불가능합니다.
          </>
        )}{' '}
        <strong>{MIXED_SOURCE_NOTE}</strong>{' '}
        모멘텀 모드는 연구 러너와 같게 <strong>구간끝 청산비용 근사(haircut)</strong>를 물립니다. 장중 조건(분봉)은
        일봉 백테스트로 검증되지 않습니다.
        <strong>QQQ 비교는 KRW=X 종가 환산 기준 — 환헤지·거래비용 미반영</strong>이며 참고 표시일 뿐 알파 판정에
        들어가지 않습니다(판정 벤치는 KODEX 200). 모멘텀 랭킹 모드는 매월 첫 거래일 시가에 리밸런스하는 12-1 횡단면
        모멘텀이며, 25차 실측 낙폭은 <strong>−61%~−68%</strong> [추정]입니다 — 프리셋은 여러 조합 중 성적이 좋았던
        것을 고른 것이라 <strong>과최적화 위험</strong>이 남아 있습니다. 결합 모드는 두 슬리브를 각각 전액 투자로
        돌린 <strong>곡선의 합성</strong>이라 매매 원장이 없고(매매수·승률은 단독 실행에서 확인),{' '}
        <strong>월 리밸런스 매매비용이 반영되지 않은 낙관적 상한</strong>입니다. 26차 실측 낙폭은{' '}
        <strong>−43.1%</strong> [추정]이고 두 단독 평균 대비 완화 폭은 <strong>+3.6%p</strong>에 그치며, 위기
        구간에서는 두 슬리브가 <strong>함께 무너졌습니다</strong>. 슬리브 B(횡단면 모멘텀)는 미국 시장 교차 검증에서
        알파가 남지 않아 <strong>한국 표본 밖 일반화 근거가 없습니다</strong>.
        백테스트 성적은 과최적화·체결 가정의 한계를 가지며 미래 수익을 보장하지 않습니다. 손실 경로는 MDD 카드가
        그 조합이 견뎌야 했던 최대 하락입니다. 본 화면은 정보·참고용이며 <strong>투자자문이 아닙니다</strong>.
        매수/매도 권유가 아니며 모든 투자 판단·손익 책임은 이용자 본인에게 있습니다.
      </div>
    </div>
  )
}

/** 고급 트리 읽기 전용 요약 */
function summarizeNode(n: ConditionNode): string {
  switch (n.op) {
    case 'and':
      return `(${n.nodes.map(summarizeNode).join(' AND ')})`
    case 'or':
      return `(${n.nodes.map(summarizeNode).join(' OR ')})`
    case 'not':
      return `NOT ${summarizeNode(n.node)}`
    case 'cond':
      return conditionLabel(n.cond)
  }
}
