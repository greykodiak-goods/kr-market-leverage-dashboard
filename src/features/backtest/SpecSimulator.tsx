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

import { useEffect, useMemo, useState } from 'react'
import { getDailyHistory, type HistoryRange } from '../../lib/history'
import type { DailyBar } from './types'
import { runStrategySpec, EXIT_LABELS, type ConditionResult, type CostSettings } from './conditionScreen'
import {
  HEROMOON_MOMENTUM,
  SPEC_VERSION,
  conditionLabel,
  validateSpec,
  type Condition,
  type ConditionNode,
  type ExitRule,
  type StrategySpec,
} from './strategySpec'
import { KpiCard } from '../../components/KpiCard'
import { EquityChart } from './EquityChart'
import { InfoTip } from '../../components/InfoTip'
import { displaySymbol } from '../../lib/krNames'

// ---- 저장 ------------------------------------------------------------------

const STORE_KEY = 'spec-simulator:v1'

interface Saved {
  spec: StrategySpec
  symbolsText: string
  range: HistoryRange
  startDate: string
  /** 종료일 — 이 날짜 이후 봉을 잘라내고 실행한다. 없거나 빈 문자열이면 데이터 끝까지.
   *  기존 저장본(v1)에는 없는 필드라 **옵션**으로 둔다(STORE_KEY 버전을 올리지 않는다). */
  endDate?: string
  cost: CostSettings
}

const DEFAULT_COST: CostSettings = { initialCapital: 10_000_000, feePct: 0.015, taxPct: 0.15, slippagePct: 0.1 }

// 기본 표본 — 유동성 있는 국장 종목. 조건식 검증용 표본이지 추천 종목이 아니다.
const DEFAULT_SYMBOLS =
  '000660.KS, 005930.KS, 035420.KS, 051910.KS, 005380.KS, 000270.KS, 105560.KS, 055550.KS, 034020.KS, 010140.KS, 196170.KQ, 247540.KQ, 086520.KQ, 328130.KQ'

const BENCH_SYMBOL = '069500.KS' // KODEX 200 — 알파 판정 기준(규칙 5)
const ETF_SYMBOLS = new Set(['069500.KS', '360750.KS']) // 랭킹 저장소의 ETF — 표본 제외
const KOSPI_INDEX = '^KS11'

// 코스피 지수 5·10일선 정배열일 때만 신규 진입 (레짐 게이트)
const KOSPI_REGIME: NonNullable<StrategySpec['regime']> = {
  symbol: KOSPI_INDEX,
  entry: { op: 'and', nodes: [{ op: 'cond', cond: { kind: 'maAlign', fast: 5, slow: 10 } }] },
}

// ---- 프리셋 ----------------------------------------------------------------

const PRESET_GOBLIN: StrategySpec = {
  version: SPEC_VERSION,
  id: 'goblin-ma5',
  name: '5일선 기법 (정배열+지수 레짐)',
  source: '2026-07-30 대표 지정: 코스피 정배열일 때만, 종목 정배열+5일선 돌파',
  universe: HEROMOON_MOMENTUM.universe,
  entry: {
    op: 'and',
    nodes: [
      { op: 'cond', id: '정배열', cond: { kind: 'maAlign', fast: 5, slow: 10 } },
      { op: 'cond', id: '5일선돌파', cond: { kind: 'maCross', period: 5, dir: 'above' } },
    ],
  },
  ranking: { by: 'tradingValue', dir: 'desc' },
  exits: [{ kind: 'maBreak', maPeriod: 5 }],
  sizing: { maxPositions: 10, mode: 'equalSlot' },
  execution: { timing: 'sameClose', orderType: 'market' },
  regime: KOSPI_REGIME,
}

const PRESET_BEST_U: StrategySpec = {
  version: SPEC_VERSION,
  id: 'combo-u',
  name: '급증×신고가×대금+이탈버퍼 (검증 최적)',
  source: '2026-07-30 백테스트 4라운드 최적 조합 U — 10y 알파 −0.8%p·MDD −27%',
  universe: HEROMOON_MOMENTUM.universe,
  entry: {
    op: 'and',
    nodes: [
      { op: 'cond', cond: { kind: 'candle', bull: true } },
      { op: 'cond', cond: { kind: 'maCross', period: 5, dir: 'above' } },
      { op: 'cond', cond: { kind: 'volumeSurge', days: 20, ratio: 1.5 } },
      { op: 'cond', cond: { kind: 'highBreak', days: 20 } },
      { op: 'cond', cond: { kind: 'tradingValue', min: 1e10 } },
    ],
  },
  ranking: { by: 'tradingValue', dir: 'desc' },
  exits: [{ kind: 'maBreak', maPeriod: 5, pct: 2 }],
  sizing: { maxPositions: 10, mode: 'equalSlot' },
  execution: { timing: 'sameClose', orderType: 'market' },
}

// 스윕 54구성 + 손익비 분해(5·6차 백테스트)의 승자 — 전 구간(전반·후반·3y) 알파 양수인 유일 그룹.
// 핵심은 익절 없이 40일선 −2%까지 이익을 끌고 가는 느린 청산(손익비 5~6.6). 절대 수치는 선택편향 상한선.
const PRESET_MA20_WINNER: StrategySpec = {
  version: SPEC_VERSION,
  id: 'ma20-high20-slow',
  name: 'MA20 돌파×20일 신고가·느린 청산',
  source: '2026-07-30 백테스트 5·6차 승자 — 손익비 5~6.6·PF 3~4·전 구간 알파 양수 (선택편향 주의)',
  universe: HEROMOON_MOMENTUM.universe,
  entry: {
    op: 'and',
    nodes: [
      { op: 'cond', id: '20일선돌파', cond: { kind: 'maCross', period: 20, dir: 'above' } },
      { op: 'cond', id: '20일신고가', cond: { kind: 'highBreak', days: 20 } },
    ],
  },
  ranking: { by: 'tradingValue', dir: 'desc' },
  exits: [{ kind: 'maBreak', maPeriod: 40, pct: 2 }],
  sizing: { maxPositions: 10, mode: 'equalSlot' },
  execution: { timing: 'sameClose', orderType: 'market' },
}

// 14차 도전자 — 진입 이평만 20→15일(신호 ~1주 빠름). 홀드아웃 3구간 전승했으나 다중비교
// 잔존 위험 + MDD 4~6%p 깊어짐. 페이퍼 3트랙 실측으로 판정 중 — 확정 전 참고용.
const PRESET_MA15_CHALLENGER: StrategySpec = {
  ...PRESET_MA20_WINNER,
  id: 'ma15-high20-slow',
  name: 'MA15 돌파×20일 신고가·느린 청산 (도전자)',
  source: '2026-07-30 백테스트 14차 도전자 — 후반 알파 +55.9%p·MDD −26~−28% (다중비교 주의, 페이퍼 판정 중)',
  entry: {
    op: 'and',
    nodes: [
      { op: 'cond', id: '15일선돌파', cond: { kind: 'maCross', period: 15, dir: 'above' } },
      { op: 'cond', id: '20일신고가', cond: { kind: 'highBreak', days: 20 } },
    ],
  },
}

// 위 승자에 거래량 급증을 얹은 방어 변형 — 알파는 조금 낮고 MDD가 얕다(−22→−19%), 매매도 감소.
const PRESET_MA20_DEFENSIVE: StrategySpec = {
  ...PRESET_MA20_WINNER,
  id: 'ma20-surge-high20-slow',
  name: 'MA20×급증×신고가·느린 청산 (방어형)',
  source: '2026-07-30 백테스트 6차 — 승자 변형: MDD 얕음(−18~21%)·매매 감소, 알파 소폭 하락',
  entry: {
    op: 'and',
    nodes: [
      { op: 'cond', id: '20일선돌파', cond: { kind: 'maCross', period: 20, dir: 'above' } },
      { op: 'cond', id: '거래량급증', cond: { kind: 'volumeSurge', days: 20, ratio: 1.5 } },
      { op: 'cond', id: '20일신고가', cond: { kind: 'highBreak', days: 20 } },
    ],
  },
}

const PRESETS: { id: string; label: string; spec: StrategySpec }[] = [
  { id: 'ma20-winner', label: 'MA20×신고가·느린 청산 (백테스트 승자)', spec: PRESET_MA20_WINNER },
  { id: 'ma15-chal', label: 'MA15×신고가·느린 청산 (도전자 — 검증 중)', spec: PRESET_MA15_CHALLENGER },
  { id: 'ma20-def', label: 'MA20×급증×신고가 (방어형)', spec: PRESET_MA20_DEFENSIVE },
  { id: 'heromoon', label: '급등주 5일선 돌파 (영웅문 조건식)', spec: HEROMOON_MOMENTUM },
  { id: 'goblin', label: '5일선 기법 — 정배열+코스피 레짐', spec: PRESET_GOBLIN },
  { id: 'best-u', label: '급증×신고가×버퍼 (5일선 계열 최적)', spec: PRESET_BEST_U },
]

function loadSaved(): Saved {
  try {
    const raw = localStorage.getItem(STORE_KEY)
    if (raw) {
      const s = JSON.parse(raw) as Saved
      // endDate가 없는 구 저장본도 그대로 받는다(하위 호환)
      if (s.spec?.version === SPEC_VERSION) return { ...s, cost: s.cost ?? DEFAULT_COST, endDate: s.endDate ?? '' }
    }
  } catch {
    /* 손상 저장본은 기본값으로 */
  }
  return {
    spec: HEROMOON_MOMENTUM,
    symbolsText: DEFAULT_SYMBOLS,
    range: '5y',
    startDate: '',
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

const fmtPct = (v: number, digits = 1) => `${v >= 0 ? '+' : ''}${v.toFixed(digits)}%`
const fmtWon = (v: number | null | undefined) => (v == null ? '—' : Math.round(v).toLocaleString('ko-KR'))
/** 자릿수 구분 — 총 수익률이 네 자리 %를 넘으면 구분 없이는 읽히지 않는다 */
const fmtPctGrouped = (v: number, digits = 1) =>
  `${v >= 0 ? '+' : '−'}${Math.abs(v).toLocaleString('ko-KR', { minimumFractionDigits: digits, maximumFractionDigits: digits })}%`
const fmtPp = (v: number, digits = 1) =>
  `${v >= 0 ? '+' : '−'}${Math.abs(v).toLocaleString('ko-KR', { minimumFractionDigits: digits, maximumFractionDigits: digits })}%p`

/** 두 날짜 사이 연수 — 헤드리스 러너(scripts/spec-backtest)의 정의와 동일 */
function yearsBetween(a: string, b: string): number {
  return Math.max(1 / 365, (Date.parse(b) - Date.parse(a)) / (365.25 * 86400e3))
}
/** 연환산 수익률(%) — 누적배수와 연수로 계산 */
function cagr(totalRatio: number, years: number): number {
  return (Math.pow(Math.max(totalRatio, 1e-9), 1 / years) - 1) * 100
}

export function SpecSimulator() {
  const [saved] = useState(loadSaved)
  const [spec, setSpec] = useState<StrategySpec>(saved.spec)
  const [symbolsText, setSymbolsText] = useState(saved.symbolsText)
  const [range, setRange] = useState<HistoryRange>(saved.range)
  const [startDate, setStartDate] = useState(saved.startDate)
  const [endDate, setEndDate] = useState(saved.endDate ?? '')
  const [cost, setCost] = useState<CostSettings>(saved.cost)

  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // 실행 중 생기는 안내는 **덮어쓰지 않고 쌓는다** — 예전엔 "로드 실패 종목" 안내가
  // 뒤이은 레짐 안내에 지워져 사용자가 못 보고 넘어갔다.
  const [notes, setNotes] = useState<string[]>([])
  const [result, setResult] = useState<ConditionResult | null>(null)
  const [benchPct, setBenchPct] = useState<number | null>(null)
  const [benchEquity, setBenchEquity] = useState<Map<string, number> | null>(null)
  /** 벤치마크가 실제로 존재한 구간 — 실행 구간보다 늦게 시작하면 알파가 과대평가된다 */
  const [benchSpan, setBenchSpan] = useState<{ start: string; end: string } | null>(null)
  /** 결과 계산의 기준 자본 — **실행 시점 값을 고정**한다.
   *  설정을 나중에 바꿔도 이미 나온 결과표의 수익률이 따라 흔들리면 안 된다. */
  const [ranCapital, setRanCapital] = useState(saved.cost.initialCapital)

  const addNote = (m: string) => setNotes((prev) => (prev.includes(m) ? prev : [...prev, m]))

  const [jsonOpen, setJsonOpen] = useState(false)
  const [jsonText, setJsonText] = useState('')
  const [jsonError, setJsonError] = useState<string | null>(null)

  useEffect(() => {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ spec, symbolsText, range, startDate, endDate, cost } satisfies Saved))
    } catch {
      /* 저장 실패는 치명적이지 않다 */
    }
  }, [spec, symbolsText, range, startDate, endDate, cost])

  const flat = useMemo(() => asFlatAnd(spec.entry), [spec.entry])
  const issues = useMemo(() => {
    const symbols = symbolsText.split(',').map((s) => s.trim()).filter(Boolean)
    return validateSpec({ ...spec, universe: { ...spec.universe, symbols } })
  }, [spec, symbolsText])

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

  // 시총 상위 원클릭 — 5분봉 크론이 매일 실측으로 갱신하는 랭킹 목록(index.json)에서 가져온다
  async function loadTopSymbols(kind: 'kospi20' | 'kospi40' | 'all') {
    try {
      const res = await fetch(`${import.meta.env.BASE_URL}data/intraday/index.json`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const idx = (await res.json()) as { symbols?: Record<string, unknown> }
      const syms = Object.keys(idx.symbols ?? {}).filter((s) => !ETF_SYMBOLS.has(s))
      const ks = syms.filter((s) => s.endsWith('.KS'))
      const pick = kind === 'kospi20' ? ks.slice(0, 20) : kind === 'kospi40' ? ks.slice(0, 40) : syms
      if (pick.length === 0) throw new Error('목록이 비어 있습니다')
      setSymbolsText(pick.join(', '))
      setNotes([`시총 상위 목록 적용: ${pick.length}종목 (크론이 매일 갱신하는 실측 랭킹)`])
    } catch (e) {
      setNotes([`⚠️ 시총 랭킹 목록 로드 실패: ${e instanceof Error ? e.message : String(e)}`])
    }
  }

  async function run() {
    if (busy) return // 중복 클릭 방어 (버튼 disabled와 이중 잠금)
    setBusy(true)
    setError(null)
    setNotes([])
    try {
      if (dateError) throw new Error(dateError)
      const symbols = symbolsText.split(',').map((s) => s.trim()).filter(Boolean)
      if (symbols.length === 0) throw new Error('표본 종목이 비어 있습니다')
      const histories: Record<string, DailyBar[]> = {}
      const failed: string[] = []
      // 병렬 로딩 — 순차(80회 왕복 직렬)가 시뮬 체감 지연의 주범이었다. 동시 6개:
      // 공용 CORS 프록시의 유량 제한을 넘지 않는 선에서 벽시계 시간을 ~1/6로 줄인다.
      {
        let done = 0
        setProgress(`시세 로딩 0/${symbols.length}…`)
        const queue = [...symbols]
        const CONCURRENCY = 6
        const worker = async () => {
          for (;;) {
            const sym = queue.shift()
            if (!sym) return
            try {
              const h = await getDailyHistory(sym, range)
              if (h.bars.length > 0) histories[sym] = h.bars
              else failed.push(sym)
            } catch {
              failed.push(sym)
            }
            done++
            setProgress(`시세 로딩 ${done}/${symbols.length}…`)
          }
        }
        await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker))
      }
      const okCount = Object.keys(histories).length
      if (okCount === 0) throw new Error('시세를 하나도 받지 못했습니다 — 네트워크/프록시 상태를 확인하세요')
      if (failed.length) addNote(`⚠️ 로드 실패로 제외: ${failed.join(', ')} (${okCount}종목으로 실행)`)

      // 레짐 게이트가 있으면 지수 시세도 필요하다 (매매 대상 아님 — 판정 전용)
      if (spec.regime) {
        setProgress(`레짐 지수(${spec.regime.symbol}) 로딩…`)
        try {
          const rh = await getDailyHistory(spec.regime.symbol, range)
          if (rh.bars.length > 0) histories[spec.regime.symbol] = rh.bars
          else addNote('⚠️ 레짐 지수 데이터가 비어 있습니다 — 진입이 발생하지 않습니다')
        } catch {
          addNote('⚠️ 레짐 지수 로드 실패 — 진입이 발생하지 않습니다 (레짐을 "없음"으로 바꾸거나 재시도)')
        }
      }

      // 종료일 절단 — **엔진은 건드리지 않고 입력 봉만 자른다**(헤드리스 러너와 같은 방식).
      // 규칙 1(미래참조 금지)의 절단 불변성과 같은 조작이라, 잘라낸 구간 이전 결과는
      // 자르지 않은 실행과 동일해야 한다.
      if (endDate) {
        for (const s of Object.keys(histories)) {
          const cut = histories[s].filter((b) => b.date <= endDate)
          if (cut.length === 0) delete histories[s]
          else histories[s] = cut
        }
        const left = Object.keys(histories).filter((s) => s !== spec.regime?.symbol)
        if (left.length === 0) throw new Error(`종료일(${endDate}) 이전 데이터가 없습니다 — 기간을 다시 확인하세요`)
        if (left.length < okCount) addNote(`⚠️ 종료일 이전 데이터가 없어 제외된 종목이 있습니다 (${left.length}종목으로 실행)`)
      }

      setProgress('백테스트 실행…')
      const tradable = Object.keys(histories).filter((s) => s !== spec.regime?.symbol)
      const effective: StrategySpec = { ...spec, universe: { ...spec.universe, symbols: tradable } }
      const res = runStrategySpec(histories, startDate || '0000-00-00', effective, cost)
      setResult(res)
      setRanCapital(cost.initialCapital)
      setTradesPage(0) // 새 실행마다 1페이지부터

      // 벤치마크 — 같은 구간 KODEX 200 단순보유 (규칙 5: 판정은 알파 기준).
      // res.startDate/endDate는 위에서 잘라낸 봉으로 만든 달력의 양끝이므로,
      // 종료일을 지정하면 벤치마크·알파도 자동으로 같은 구간으로 잘린다.
      setProgress('벤치마크 로딩…')
      try {
        const bench = await getDailyHistory(BENCH_SYMBOL, range)
        const inRange = bench.bars.filter((b) => b.date >= res.startDate && b.date <= res.endDate)
        if (inRange.length >= 2) {
          const first = inRange[0].c
          setBenchPct((inRange[inRange.length - 1].c / first - 1) * 100)
          const m = new Map<string, number>()
          for (const b of inRange) m.set(b.date, (b.c / first) * cost.initialCapital)
          setBenchEquity(m)
          setBenchSpan({ start: inRange[0].date, end: inRange[inRange.length - 1].date })
        } else {
          setBenchPct(null)
          setBenchEquity(null)
          setBenchSpan(null)
        }
      } catch {
        setBenchPct(null)
        setBenchEquity(null)
        setBenchSpan(null)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
      setProgress(null)
    }
  }

  // 벤치마크를 자산곡선에 겹친다 (표시용 — 엔진 결과는 그대로 둔다)
  const chartEquity = useMemo(() => {
    if (!result) return null
    if (!benchEquity) return result.equity
    let lastBench = ranCapital
    return result.equity.map((p) => {
      lastBench = benchEquity.get(p.date) ?? lastBench
      return { ...p, benchmark: lastBench }
    })
  }, [result, benchEquity, ranCapital])

  const summary = useMemo(() => {
    if (!result || result.equity.length === 0) return null
    const finalEq = result.equity[result.equity.length - 1].equity
    const totalPct = (finalEq / ranCapital - 1) * 100
    const mdd = result.equity.reduce((m, e) => Math.min(m, e.drawdownPct), 0)
    const closed = result.trades.filter((t) => t.exitDate != null)
    const wins = closed.filter((t) => (t.pnlPct ?? 0) > 0).length
    // 연환산 — 자산곡선 시작·끝 **날짜** 기준 (헤드리스 러너 stats()와 같은 정의).
    // 총액 %만 보면 장기 구간에서 복리 착시가 생기고, 규칙 5의 판정 기준(연환산 알파)과 어긋난다.
    const years = yearsBetween(result.startDate, result.endDate)
    const cagrPct = cagr(finalEq / ranCapital, years)
    const benchCagrPct = benchPct != null ? cagr(1 + benchPct / 100, years) : null
    return {
      totalPct,
      mdd,
      years,
      cagrPct,
      benchCagrPct,
      alphaCagrPct: benchCagrPct != null ? cagrPct - benchCagrPct : null,
      alphaTotalPct: benchPct != null ? totalPct - benchPct : null,
      tradeCount: closed.length,
      winRate: closed.length ? (wins / closed.length) * 100 : null,
      avgPnl: closed.length ? closed.reduce((s, t) => s + (t.pnlPct ?? 0), 0) / closed.length : null,
    }
  }, [result, ranCapital, benchPct])

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
        영웅문 조건검색으로 찾은 조건식을 옮겨 적고 <strong>즉시 2차 검증</strong>합니다. 신호는 종가 판단 → 익일 시가
        체결(미래참조 금지), 판정은 알파(벤치마크 대비) 기준.
      </div>

      {/* ---- 매수 조건 ---- */}
      <div className="bt-controls">
        <strong>매수 조건 (전부 충족 시 편입 · AND)</strong>
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

      {/* ---- 매도 조건 ---- */}
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

      {/* ---- 실행 설정 ---- */}
      <div className="bt-controls bt-settings">
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
        <label>
          데이터
          <select value={range} onChange={(e) => setRange(e.target.value as HistoryRange)}>
            <option value="5y">5년</option>
            <option value="10y">10년</option>
            <option value="max">최대</option>
          </select>
        </label>
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
          표본 종목 (쉼표 구분)
          <InfoTip text="조건식을 검증할 표본입니다. 아래 버튼으로 시가총액 상위 목록(크론이 매일 실측 갱신)을 한 번에 넣을 수 있습니다. 전 종목이 아니라 표본이므로 '등락률 상위 N위'는 표본 내 순위로 계산되고, 상장폐지 종목이 빠진 표본은 성적을 부풀립니다(생존편향)." />
        </label>
        <div className="bt-actions">
          <button type="button" className="bt-btn-mini" disabled={busy} onClick={() => loadTopSymbols('kospi20')}>
            시총 상위: 코스피 20
          </button>
          <button type="button" className="bt-btn-mini" disabled={busy} onClick={() => loadTopSymbols('kospi40')}>
            코스피 40
          </button>
          <button type="button" className="bt-btn-mini" disabled={busy} onClick={() => loadTopSymbols('all')}>
            코스피+코스닥 78
          </button>
        </div>
        <textarea
          value={symbolsText}
          onChange={(e) => setSymbolsText(e.target.value)}
          rows={2}
          style={{ width: '100%', fontFamily: 'monospace', fontSize: 12 }}
          placeholder="000660.KS, 005930.KS, …"
        />
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
      {issues.length > 0 && (
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
          disabled={busy || dateError != null || issues.some((i) => i.level === 'error')}
          onClick={run}
        >
          {busy ? (progress ?? '실행 중…') : '▶ 백테스트 실행 (2차 검증)'}
        </button>
        <button type="button" className="bt-btn-mini" onClick={exportJson}>
          스펙 JSON
        </button>
        <select
          value=""
          disabled={busy}
          aria-label="프리셋 불러오기"
          onChange={(e) => {
            const p = PRESETS.find((x) => x.id === e.target.value)
            if (p) {
              setSpec(p.spec)
              setJsonOpen(false)
            }
          }}
          title="프리셋 불러오기"
        >
          <option value="" disabled>
            프리셋 불러오기…
          </option>
          {PRESETS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
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
      {jsonOpen && (
        <div className="bt-controls">
          <strong>
            스펙 JSON — 이 문서가 조건식의 정본입니다
            <InfoTip text="시뮬레이터가 실행하는 것도, (미래에 대표 승인 후) 실시간 평가기가 실행하는 것도 이 JSON입니다. 복사해 두면 조건식을 잃지 않습니다. OR/NOT 트리·표본 지정 등 화면에 없는 고급 기능도 JSON으로 편집할 수 있습니다." />
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

      {/* ---- 결과 ---- */}
      {result && summary && (
        <div className="bt-results">
          <div className="kpi-row">
            <KpiCard
              label="총 수익률"
              value={fmtPctGrouped(summary.totalPct)}
              unit={` · 연 ${fmtPct(summary.cagrPct)}`}
              changeText={
                benchPct != null && summary.benchCagrPct != null
                  ? `벤치마크(KODEX 200) 총 ${fmtPctGrouped(benchPct)} · 연 ${fmtPct(summary.benchCagrPct)}`
                  : '벤치마크 로드 실패'
              }
              changeLabel=""
              direction={benchPct != null && summary.totalPct > benchPct ? 'up' : 'down'}
              info="총액 %는 구간이 길수록 복리로 부풀어 보입니다 — 실제 체감은 연환산(CAGR)으로 보세요. 같은 구간 KODEX 200 단순보유와 비교하고, 장이 좋아 번 것은 실력으로 치지 않습니다(판정은 알파 기준)."
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
              info="수익률보다 먼저, 이 낙폭을 실제로 견딜 수 있는지 확인하세요."
            />
            <KpiCard
              label="승률 / 매매"
              value={summary.winRate != null ? `${summary.winRate.toFixed(0)}%` : '—'}
              unit={summary.tradeCount ? ` / ${summary.tradeCount}회` : ''}
              changeText={`평균 손익 ${summary.avgPnl != null ? fmtPct(summary.avgPnl, 2) : '—'} · 미청산 ${result.openAtEnd}`}
              changeLabel=""
              direction="flat"
            />
          </div>

          {benchGap && (
            <div className="bt-bench-note">
              ⚠️ <strong>벤치마크 구간 부족</strong> — 실행 구간은 {result.startDate}부터인데 KODEX 200 데이터는{' '}
              {benchGap}부터입니다. 그 이전 구간은 비교 대상 없이 전략 수익만 쌓이므로 <strong>알파가 과대평가</strong>됩니다.
              시작일을 {benchGap} 이후로 맞추면 같은 구간 비교가 됩니다.
            </div>
          )}

          {chartEquity && <EquityChart equity={chartEquity} benchmarkLabel="KODEX 200 단순보유" />}

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
                마지막 스크리닝 ({result.lastScreenDate}) — 조건식이 실제로 무엇을 거르는지 확인
              </div>
              <table>
                <thead>
                  <tr>
                    <th>순위</th>
                    <th>종목</th>
                    <th>등락률</th>
                    <th>판정</th>
                    <th>탈락 사유</th>
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
        </div>
      )}

      <div className="bt-disclaimer">
        시뮬레이션 전용 — 주문·실계좌·브로커 API와 연결되어 있지 않습니다. 표본 종목으로만 검증하므로 전 종목
        조건검색과 결과가 다르며, 상장폐지 종목이 빠진 표본은 성적을 부풀립니다(생존편향). 데이터: Yahoo Finance
        일봉(비공식 엔드포인트 · 정확성 미보증). 장중 조건(분봉)은 일봉 백테스트로 검증되지 않습니다. 백테스트
        성적은 과최적화·체결 가정의 한계를 가지며 미래 수익을 보장하지 않습니다. 본 화면은 정보·참고용이며
        투자자문이 아닙니다. 매수/매도 권유가 아니며 모든 투자 판단·손익 책임은 이용자 본인에게 있습니다.
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
