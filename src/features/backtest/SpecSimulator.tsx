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

// ---- 저장 ------------------------------------------------------------------

const STORE_KEY = 'spec-simulator:v1'

interface Saved {
  spec: StrategySpec
  symbolsText: string
  range: HistoryRange
  startDate: string
  cost: CostSettings
}

const DEFAULT_COST: CostSettings = { initialCapital: 10_000_000, feePct: 0.015, taxPct: 0.15, slippagePct: 0.1 }

// 기본 표본 — 유동성 있는 국장 종목. 조건식 검증용 표본이지 추천 종목이 아니다.
const DEFAULT_SYMBOLS =
  '000660.KS, 005930.KS, 035420.KS, 051910.KS, 005380.KS, 000270.KS, 105560.KS, 055550.KS, 034020.KS, 010140.KS, 196170.KQ, 247540.KQ, 086520.KQ, 328130.KQ'

const BENCH_SYMBOL = '069500.KS' // KODEX 200 — 알파 판정 기준(규칙 5)

function loadSaved(): Saved {
  try {
    const raw = localStorage.getItem(STORE_KEY)
    if (raw) {
      const s = JSON.parse(raw) as Saved
      if (s.spec?.version === SPEC_VERSION) return { ...s, cost: s.cost ?? DEFAULT_COST }
    }
  } catch {
    /* 손상 저장본은 기본값으로 */
  }
  return {
    spec: HEROMOON_MOMENTUM,
    symbolsText: DEFAULT_SYMBOLS,
    range: '5y',
    startDate: '',
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

function Num({
  value,
  onChange,
  title,
  step = 1,
  optional = false,
}: {
  value: number | undefined
  onChange: (v: number | undefined) => void
  title: string
  step?: number
  optional?: boolean
}) {
  return (
    <input
      type="number"
      step={step}
      value={value ?? ''}
      placeholder={optional ? '—' : undefined}
      title={title}
      onChange={(e) => {
        const raw = e.target.value
        if (raw === '') {
          if (optional) onChange(undefined)
          return
        }
        const n = Number(raw)
        if (Number.isFinite(n)) onChange(n)
      }}
    />
  )
}

function CondFields({ cond, onChange }: { cond: Condition; onChange: (c: Condition) => void }) {
  switch (cond.kind) {
    case 'priceRange':
      return (
        <>
          <Num value={cond.min} onChange={(min) => onChange({ ...cond, min })} title="하한(원)" step={100} optional />
          <span>~</span>
          <Num value={cond.max} onChange={(max) => onChange({ ...cond, max })} title="상한(원)" step={100} optional />
          <span>원</span>
        </>
      )
    case 'changeRank':
      return (
        <>
          <span>상위</span>
          <Num value={cond.top} onChange={(top) => onChange({ ...cond, top: top ?? 100 })} title="순위" />
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
          <Num value={cond.period} onChange={(period) => onChange({ ...cond, period: period ?? 5 })} title="이평 기간(일)" />
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
          <Num value={cond.fast} onChange={(fast) => onChange({ ...cond, fast: fast ?? 5 })} title="단기 이평(일)" />
          <span>일선 &gt;</span>
          <Num value={cond.slow} onChange={(slow) => onChange({ ...cond, slow: slow ?? 10 })} title="장기 이평(일)" />
          <span>일선 (정배열)</span>
        </>
      )
    case 'volume':
      return (
        <>
          <Num value={cond.min} onChange={(min) => onChange({ ...cond, min: min ?? 0 })} title="거래량 하한(주)" step={10000} />
          <span>주 이상</span>
        </>
      )
    case 'tradingValue':
      return (
        <>
          <Num value={cond.min} onChange={(min) => onChange({ ...cond, min: min ?? 0 })} title="거래대금 하한(원)" step={1e8} />
          <span>원 이상</span>
        </>
      )
    case 'volumeSurge':
      return (
        <>
          <span>직전</span>
          <Num value={cond.days} onChange={(days) => onChange({ ...cond, days: days ?? 20 })} title="평균 산출 일수" />
          <span>일 평균의</span>
          <Num value={cond.ratio} onChange={(ratio) => onChange({ ...cond, ratio: ratio ?? 2 })} title="배수" step={0.5} />
          <span>배 이상</span>
        </>
      )
    case 'disparity':
      return (
        <>
          <Num value={cond.period} onChange={(period) => onChange({ ...cond, period: period ?? 20 })} title="이평 기간(일)" />
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
          <Num value={cond.period} onChange={(period) => onChange({ ...cond, period: period ?? 14 })} title="기간(일)" />
          <span>)</span>
          <Num value={cond.min} onChange={(min) => onChange({ ...cond, min })} title="하한" optional />
          <span>~</span>
          <Num value={cond.max} onChange={(max) => onChange({ ...cond, max })} title="상한" optional />
        </>
      )
    case 'highBreak':
    case 'lowBreak':
      return (
        <>
          <Num value={cond.days} onChange={(days) => onChange({ ...cond, days: days ?? 20 })} title="기간(일)" />
          <span>{cond.kind === 'highBreak' ? '일 신고가 돌파(당일 제외 직전 극값 기준)' : '일 신저가 이탈'}</span>
        </>
      )
    case 'streak':
      return (
        <>
          <Num value={cond.days} onChange={(days) => onChange({ ...cond, days: days ?? 3 })} title="연속 일수" />
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
          <Num value={rule.pct} onChange={(pct) => onChange({ ...rule, pct: pct ?? 3 })} title="%" step={0.5} />
          <span>%</span>
        </>
      )
    case 'maBreak':
      return (
        <>
          <Num value={rule.maPeriod} onChange={(maPeriod) => onChange({ ...rule, maPeriod: maPeriod ?? 5 })} title="이평 기간(일)" />
          <span>일선</span>
        </>
      )
    case 'timeExit':
      return (
        <>
          <Num value={rule.days} onChange={(days) => onChange({ ...rule, days: days ?? 3 })} title="보유 거래일" />
          <span>거래일</span>
        </>
      )
    default:
      return null
  }
}

// ---- 본체 ------------------------------------------------------------------

const fmtPct = (v: number, digits = 1) => `${v >= 0 ? '+' : ''}${v.toFixed(digits)}%`

export function SpecSimulator() {
  const [saved] = useState(loadSaved)
  const [spec, setSpec] = useState<StrategySpec>(saved.spec)
  const [symbolsText, setSymbolsText] = useState(saved.symbolsText)
  const [range, setRange] = useState<HistoryRange>(saved.range)
  const [startDate, setStartDate] = useState(saved.startDate)
  const [cost, setCost] = useState<CostSettings>(saved.cost)

  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loadNote, setLoadNote] = useState<string | null>(null)
  const [result, setResult] = useState<ConditionResult | null>(null)
  const [benchPct, setBenchPct] = useState<number | null>(null)
  const [benchEquity, setBenchEquity] = useState<Map<string, number> | null>(null)

  const [jsonOpen, setJsonOpen] = useState(false)
  const [jsonText, setJsonText] = useState('')
  const [jsonError, setJsonError] = useState<string | null>(null)

  useEffect(() => {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ spec, symbolsText, range, startDate, cost } satisfies Saved))
    } catch {
      /* 저장 실패는 치명적이지 않다 */
    }
  }, [spec, symbolsText, range, startDate, cost])

  const flat = useMemo(() => asFlatAnd(spec.entry), [spec.entry])
  const issues = useMemo(() => {
    const symbols = symbolsText.split(',').map((s) => s.trim()).filter(Boolean)
    return validateSpec({ ...spec, universe: { ...spec.universe, symbols } })
  }, [spec, symbolsText])

  function patchEntry(nextFlat: FlatCond[]) {
    setSpec((s) => ({ ...s, entry: toEntry(nextFlat) }))
  }

  async function run() {
    setBusy(true)
    setError(null)
    setLoadNote(null)
    try {
      const symbols = symbolsText.split(',').map((s) => s.trim()).filter(Boolean)
      if (symbols.length === 0) throw new Error('표본 종목이 비어 있습니다')
      const histories: Record<string, DailyBar[]> = {}
      const failed: string[] = []
      for (const sym of symbols) {
        setProgress(`${sym} 시세 로딩…`)
        try {
          const h = await getDailyHistory(sym, range)
          if (h.bars.length > 0) histories[sym] = h.bars
          else failed.push(sym)
        } catch {
          failed.push(sym)
        }
      }
      const okCount = Object.keys(histories).length
      if (okCount === 0) throw new Error('시세를 하나도 받지 못했습니다 — 네트워크/프록시 상태를 확인하세요')
      if (failed.length) setLoadNote(`⚠️ 로드 실패로 제외: ${failed.join(', ')} (${okCount}종목으로 실행)`)

      setProgress('백테스트 실행…')
      const effective: StrategySpec = { ...spec, universe: { ...spec.universe, symbols: Object.keys(histories) } }
      const res = runStrategySpec(histories, startDate || '0000-00-00', effective, cost)
      setResult(res)

      // 벤치마크 — 같은 구간 KODEX 200 단순보유 (규칙 5: 판정은 알파 기준)
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
        } else {
          setBenchPct(null)
          setBenchEquity(null)
        }
      } catch {
        setBenchPct(null)
        setBenchEquity(null)
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
    let lastBench = cost.initialCapital
    return result.equity.map((p) => {
      lastBench = benchEquity.get(p.date) ?? lastBench
      return { ...p, benchmark: lastBench }
    })
  }, [result, benchEquity, cost.initialCapital])

  const summary = useMemo(() => {
    if (!result || result.equity.length === 0) return null
    const finalEq = result.equity[result.equity.length - 1].equity
    const totalPct = (finalEq / cost.initialCapital - 1) * 100
    const mdd = result.equity.reduce((m, e) => Math.min(m, e.drawdownPct), 0)
    const closed = result.trades.filter((t) => t.exitDate != null)
    const wins = closed.filter((t) => (t.pnlPct ?? 0) > 0).length
    return {
      totalPct,
      mdd,
      tradeCount: closed.length,
      winRate: closed.length ? (wins / closed.length) * 100 : null,
      avgPnl: closed.length ? closed.reduce((s, t) => s + (t.pnlPct ?? 0), 0) / closed.length : null,
    }
  }, [result, cost.initialCapital])

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

  const recentTrades = result ? [...result.trades].slice(-12).reverse() : []
  const screenRows = result ? result.lastScreen.slice(0, 12) : []

  return (
    <div className="panel bt-panel">
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
            {flat.map((f, i) => (
              <div key={i} className="bt-cond-row">
                <select
                  value={f.cond.kind}
                  onChange={(e) => {
                    const meta = KIND_MENU.find((k) => k.kind === e.target.value)
                    if (meta) patchEntry(flat.map((x, j) => (j === i ? { ...x, cond: meta.make() } : x)))
                  }}
                >
                  {KIND_MENU.map((k) => (
                    <option key={k.kind} value={k.kind}>
                      {k.label}
                    </option>
                  ))}
                </select>
                <CondFields cond={f.cond} onChange={(cond) => patchEntry(flat.map((x, j) => (j === i ? { ...x, cond } : x)))} />
                <button
                  type="button"
                  className="bt-btn-mini danger"
                  aria-label="조건 삭제"
                  onClick={() => patchEntry(flat.filter((_, j) => j !== i))}
                >
                  ✕
                </button>
              </div>
            ))}
            <button type="button" className="bt-btn-mini" onClick={() => patchEntry([...flat, { cond: KIND_MENU[0].make() }])}>
              + 조건 추가
            </button>
          </>
        )}
      </div>

      {/* ---- 매도 조건 ---- */}
      <div className="bt-controls">
        <strong>
          매도 조건 (먼저 걸리는 것이 청산)
          <InfoTip text="조건검색은 매수 신호만 줍니다 — 수익률을 가르는 건 매도 규칙입니다. 손절·익절은 장중 저가/고가가 닿으면 발동하되 갭으로 관통하면 시가(더 불리한 쪽)에 체결한 것으로 계산합니다." />
        </strong>
        {spec.exits.map((rule, i) => (
          <div key={i} className="bt-cond-row">
            <select
              value={rule.kind}
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
                  </option>
                )
              })}
            </select>
            <ExitFields rule={rule} onChange={(r) => setSpec((s) => ({ ...s, exits: s.exits.map((x, j) => (j === i ? r : x)) }))} />
            <button
              type="button"
              className="bt-btn-mini danger"
              aria-label="매도 규칙 삭제"
              onClick={() => setSpec((s) => ({ ...s, exits: s.exits.filter((_, j) => j !== i) }))}
            >
              ✕
            </button>
          </div>
        ))}
        <button
          type="button"
          className="bt-btn-mini"
          onClick={() => setSpec((s) => ({ ...s, exits: [...s.exits, { kind: 'stopLoss', pct: 3 }] }))}
        >
          + 매도 규칙 추가
        </button>
      </div>

      {/* ---- 실행 설정 ---- */}
      <div className="bt-controls bt-settings">
        <label>
          동시 보유
          <input
            type="number"
            min={1}
            max={30}
            value={spec.sizing.maxPositions}
            onChange={(e) =>
              setSpec((s) => ({ ...s, sizing: { ...s.sizing, maxPositions: Math.max(1, Number(e.target.value) || 1) } }))
            }
          />
          종목
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
          데이터
          <select value={range} onChange={(e) => setRange(e.target.value as HistoryRange)}>
            <option value="5y">5년</option>
            <option value="10y">10년</option>
            <option value="max">최대</option>
          </select>
        </label>
        <label>
          시작일
          <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} title="비우면 데이터 시작부터" />
        </label>
      </div>

      <div className="bt-controls bt-settings">
        <label>
          표본 종목 (쉼표 구분)
          <InfoTip text="조건식을 검증할 표본입니다. 전 종목이 아니라 표본이므로 '등락률 상위 N위'는 표본 내 순위로 계산됩니다 — 실제 전 종목 순위와 다릅니다. 상장폐지 종목이 빠진 표본은 성적을 부풀립니다(생존편향)." />
        </label>
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
            <input
              type="number"
              step={0.005}
              value={cost.feePct}
              onChange={(e) => setCost((c) => ({ ...c, feePct: Number(e.target.value) || 0 }))}
            />
          </label>
          <label>
            거래세(%)
            <input
              type="number"
              step={0.05}
              value={cost.taxPct}
              onChange={(e) => setCost((c) => ({ ...c, taxPct: Number(e.target.value) || 0 }))}
            />
          </label>
          <label>
            슬리피지(%)
            <input
              type="number"
              step={0.05}
              value={cost.slippagePct}
              onChange={(e) => setCost((c) => ({ ...c, slippagePct: Number(e.target.value) || 0 }))}
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
        <button type="button" className="bt-btn-run" disabled={busy || issues.some((i) => i.level === 'error')} onClick={run}>
          {busy ? (progress ?? '실행 중…') : '▶ 백테스트 실행 (2차 검증)'}
        </button>
        <button type="button" className="bt-btn-mini" onClick={exportJson}>
          스펙 JSON
        </button>
        <button
          type="button"
          className="bt-btn-mini"
          onClick={() => {
            setSpec(HEROMOON_MOMENTUM)
            setJsonOpen(false)
          }}
        >
          프리셋: 급등주 5일선 돌파
        </button>
      </div>
      {error && <div className="bt-warn">⛔ {error}</div>}
      {loadNote && <div className="bt-warn">{loadNote}</div>}

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
              value={fmtPct(summary.totalPct)}
              changeText={benchPct != null ? `벤치마크(KODEX 200) ${fmtPct(benchPct)}` : '벤치마크 로드 실패'}
              changeLabel=""
              direction={benchPct != null && summary.totalPct > benchPct ? 'up' : 'down'}
              info="같은 구간 KODEX 200 단순보유와 비교하세요. 장이 좋아 번 것은 실력이 아닙니다(판정은 알파 기준)."
            />
            <KpiCard
              label="초과수익(알파)"
              value={benchPct != null ? fmtPct(summary.totalPct - benchPct) : '—'}
              changeText={`${result.startDate} ~ ${result.endDate}`}
              changeLabel=""
              direction={benchPct != null && summary.totalPct - benchPct > 0 ? 'up' : 'down'}
              info="전략 수익률 − 벤치마크 수익률(같은 구간 누적). 이 값이 음수면 그냥 지수를 사는 편이 나았다는 뜻입니다."
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

          {/* 최근 매매 */}
          {recentTrades.length > 0 && (
            <div className="bt-table-wrap bt-trades-table">
              <table>
                <thead>
                  <tr>
                    <th>종목</th>
                    <th>진입</th>
                    <th>청산</th>
                    <th>손익</th>
                    <th>사유</th>
                  </tr>
                </thead>
                <tbody>
                  {recentTrades.map((t, i) => (
                    <tr key={i}>
                      <td>{t.symbol}</td>
                      <td>{t.entryDate}</td>
                      <td>{t.exitDate ?? '보유중'}</td>
                      <td className={(t.pnlPct ?? 0) >= 0 ? 'pos' : 'neg'}>{t.pnlPct != null ? fmtPct(t.pnlPct, 2) : '—'}</td>
                      <td>{t.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
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
                      <td>{r.symbol}</td>
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
