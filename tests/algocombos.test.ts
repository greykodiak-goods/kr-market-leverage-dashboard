// 무한매수법 · VR  ×  SOXL · TQQQ = 4조합의 **배선** 검증.
//
// 이 파일이 막는 사고는 하나다: 엔진 분기가 modelId 문자열 비교로 흩어져 있으면
// 새 모델 id를 추가했을 때 어느 분기에도 안 걸려 **조용히 규칙형으로 돌거나**
// 파라미터 없이 깨진다. 그래서
//   1) 4조합이 각각 올바른 엔진·올바른 종목으로 라우팅되는지
//   2) 기존 2모델의 실행 결과가 리팩토링 전후로 **한 자리도** 안 바뀌는지
//   3) 새 조합도 절단 불변성(규칙 1)을 지키는지
// 를 못박는다.
//
// 컨테이너에서 야후가 403이라 TQQQ·SOXL 실데이터는 못 받는다 — 배선 검증은
// 결정적 합성 데이터로 한다(수치의 사실성이 아니라 배선이 검증 대상이다).

import { check, section, finish, rng } from './harness'
import { runPortfolio } from '../src/features/backtest/portfolio'
import { buyHoldYearlyRisk, worstCalendarYear } from '../src/features/backtest/portfolio'
import { MODEL_META, modelMeta, modelAlgo, defaultConfig } from '../src/features/backtest/models'
import { buildSpec, fingerprint } from '../src/features/backtest/spec'
import { buildVariants } from '../src/features/backtest/robustness'
import { computeSignals } from '../src/features/backtest/signals'
import { findDoc } from '../src/features/backtest/modelDocs'
import { runInfiniteBuying, runValueRebalancing, DEFAULT_IB_PARAMS, DEFAULT_VR_PARAMS } from '../src/features/backtest/algoEngine'
import { DEFAULT_SETTINGS } from '../src/features/backtest/types'
import type { DailyBar, HistoryResult } from '../src/lib/history'

const IB_SOXL = 'infinite-buying'
const IB_TQQQ = 'infinite-buying-tqqq'
const VR_TQQQ = 'value-rebalancing'
const VR_SOXL = 'value-rebalancing-soxl'
const COMBOS = [IB_SOXL, IB_TQQQ, VR_TQQQ, VR_SOXL]

function makeBars(seed: number, n = 900, base = 100): DailyBar[] {
  const rnd = rng(seed)
  const bars: DailyBar[] = []
  let p = base
  for (let i = 0; i < n; i++) {
    const ret = 0.0004 + 0.03 * (rnd() * 2 - 1)
    const o = p
    const c = p * (1 + ret)
    bars.push({
      date: new Date(Date.UTC(2019, 0, 1) + i * 86400000).toISOString().slice(0, 10),
      t: 0,
      o,
      h: Math.max(o, c) * (1 + rnd() * 0.012),
      l: Math.min(o, c) * (1 - rnd() * 0.012),
      c,
      v: 1e6,
    })
    p = c
  }
  return bars
}

function hist(symbol: string, bars: DailyBar[]): HistoryResult {
  return { symbol, currency: 'USD', exchange: 'NMS', bars, stale: false, fetchedAt: 0 }
}

const BARS_A = makeBars(20260803, 900)
const BARS_B = makeBars(11111, 900, 80)
const HISTS: Record<string, HistoryResult> = {
  SOXL: hist('SOXL', BARS_A),
  TQQQ: hist('TQQQ', BARS_B),
}

section('1) 4조합이 모델 목록에 올라와 있다 (기법 2 × 종목 2)')
{
  for (const id of COMBOS) {
    check(`${id}: MODEL_META에 존재`, MODEL_META.some((m) => m.id === id))
  }
  check('무한매수법 기본 종목 = SOXL (원저)', JSON.stringify(modelMeta(IB_SOXL).defaultSymbols) === '["SOXL"]')
  check('무한매수법 변형 기본 종목 = TQQQ', JSON.stringify(modelMeta(IB_TQQQ).defaultSymbols) === '["TQQQ"]')
  check('VR 기본 종목 = TQQQ (원저)', JSON.stringify(modelMeta(VR_TQQQ).defaultSymbols) === '["TQQQ"]')
  check('VR 변형 기본 종목 = SOXL', JSON.stringify(modelMeta(VR_SOXL).defaultSymbols) === '["SOXL"]')
  check('4조합이 서로 다른 id', new Set(COMBOS).size === 4)
  check('전체 모델 id 중복 없음', new Set(MODEL_META.map((m) => m.id)).size === MODEL_META.length)

  // 저장본 호환 — 기존 id는 절대 바뀌면 안 된다(모델별 설정·모의운용 등록의 키).
  check('기존 id 보존: infinite-buying', MODEL_META.some((m) => m.id === 'infinite-buying'))
  check('기존 id 보존: value-rebalancing', MODEL_META.some((m) => m.id === 'value-rebalancing'))
}

section('2) 엔진 분기는 id가 아니라 algo 필드가 정한다')
{
  check('IB(원저) algo=infinite-buying', modelAlgo(IB_SOXL) === 'infinite-buying')
  check('IB(TQQQ) algo=infinite-buying', modelAlgo(IB_TQQQ) === 'infinite-buying')
  check('VR(원저) algo=value-rebalancing', modelAlgo(VR_TQQQ) === 'value-rebalancing')
  check('VR(SOXL) algo=value-rebalancing', modelAlgo(VR_SOXL) === 'value-rebalancing')
  // 자금관리형이 아닌 모델은 algo가 없어야 한다(있으면 규칙형이 알고리즘으로 샌다)
  for (const m of MODEL_META) {
    if (m.type !== 'algo') check(`${m.id}: 자금관리형이 아니면 algo 없음`, m.algo === undefined)
    else check(`${m.id}: 자금관리형이면 algo 필수`, m.algo != null)
  }
  // defaultConfig도 algo 기준 — 파라미터가 안 붙으면 화면에서 편집기가 사라진다
  check('IB(TQQQ) 기본설정에 ib 파라미터', defaultConfig(IB_TQQQ).ib != null && defaultConfig(IB_TQQQ).vr == null)
  check('VR(SOXL) 기본설정에 vr 파라미터', defaultConfig(VR_SOXL).vr != null && defaultConfig(VR_SOXL).ib == null)
  check('IB 변형 기본 파라미터 = 원저와 동일', JSON.stringify(defaultConfig(IB_TQQQ).ib) === JSON.stringify(defaultConfig(IB_SOXL).ib))
  check('VR 변형 기본 파라미터 = 원저와 동일', JSON.stringify(defaultConfig(VR_SOXL).vr) === JSON.stringify(defaultConfig(VR_TQQQ).vr))
}

section('3) 실행 라우팅 — 새 id가 조용히 규칙형으로 새지 않는다')
{
  // 같은 종목·같은 파라미터를 주면, 기법이 같은 두 모델은 **완전히 같은 결과**를
  // 내야 한다. 새 모델이 규칙형으로 샜다면 여기서 즉시 갈라진다.
  const cfgIbA = { ...defaultConfig(IB_SOXL), symbols: ['SOXL'] }
  const cfgIbB = { ...defaultConfig(IB_TQQQ), symbols: ['SOXL'] }
  const rIbA = runPortfolio(IB_SOXL, cfgIbA, HISTS)
  const rIbB = runPortfolio(IB_TQQQ, cfgIbB, HISTS)
  check(
    '무한매수법: 같은 종목이면 원저판·변형판 자산곡선 동일',
    JSON.stringify(rIbA.equity) === JSON.stringify(rIbB.equity),
  )
  check('무한매수법: 매매 내역도 동일', JSON.stringify(rIbA.trades) === JSON.stringify(rIbB.trades))
  check('무한매수법 변형이 실제로 사이클 매수를 냈다', rIbB.events.length > 0)

  const cfgVrA = { ...defaultConfig(VR_TQQQ), symbols: ['TQQQ'] }
  const cfgVrB = { ...defaultConfig(VR_SOXL), symbols: ['TQQQ'] }
  const rVrA = runPortfolio(VR_TQQQ, cfgVrA, HISTS)
  const rVrB = runPortfolio(VR_SOXL, cfgVrB, HISTS)
  check('VR: 같은 종목이면 원저판·변형판 자산곡선 동일', JSON.stringify(rVrA.equity) === JSON.stringify(rVrB.equity))
  check('VR은 라운드트립이 없어 trades 비어 있음', rVrB.trades.length === 0 && rVrB.events.length > 0)

  // 기법이 다르면 결과도 달라야 한다(둘 다 같은 엔진으로 샜을 가능성 배제)
  const rIbOnTqqq = runPortfolio(IB_TQQQ, { ...defaultConfig(IB_TQQQ), symbols: ['TQQQ'] }, HISTS)
  check(
    '같은 종목(TQQQ)이라도 기법이 다르면 결과가 다르다',
    JSON.stringify(rIbOnTqqq.equity) !== JSON.stringify(rVrA.equity),
  )

  // 슬리브 결과의 귀속 — 어느 모델 것인지 잘못 말하면 기록이 섞인다
  for (const id of COMBOS) {
    const cfg = defaultConfig(id)
    const res = runPortfolio(id, cfg, HISTS)
    check(`${id}: 결과 strategyId = 모델 id`, res.sleeves.every((s) => s.res.strategyId === id), res.sleeves.map((s) => s.res.strategyId).join(','))
    check(`${id}: 결과 strategyName = 모델 이름`, res.sleeves.every((s) => s.res.strategyName === modelMeta(id).name))
    check(`${id}: 유니버스 = 기본 종목`, JSON.stringify(res.universe) === JSON.stringify(modelMeta(id).defaultSymbols))
    check(`${id}: 규칙형 경로로 새지 않음`, !res.isScreening && !res.isRotation && !res.isQuant && res.sleeves.length === 1)
  }
}

section('4) 회귀 — 기존 2모델의 결과가 한 자리도 바뀌지 않는다')
{
  // 리팩토링 전 엔진은 identity 인자가 없었다. 인자를 생략한 직접 호출(구 경로)과
  // 포트폴리오 경로(신 경로)의 수치가 완전히 같아야 한다.
  const settings = { ...DEFAULT_SETTINGS, sellTaxPct: 0, initialCapital: 10_000_000 }
  const legacyIb = runInfiniteBuying(BARS_A, 120, DEFAULT_IB_PARAMS, settings)
  const nowIb = runPortfolio(IB_SOXL, { ...defaultConfig(IB_SOXL), symbols: ['SOXL'] }, HISTS)
  check('IB 자산곡선 불변', JSON.stringify(legacyIb.equity) === JSON.stringify(nowIb.sleeves[0].res.equity))
  check('IB 매매내역 불변', JSON.stringify(legacyIb.trades) === JSON.stringify(nowIb.sleeves[0].res.trades))
  check('IB 지표 불변', JSON.stringify(legacyIb.metrics) === JSON.stringify(nowIb.sleeves[0].res.metrics))
  check('IB 기본 identity 유지(인자 생략 시)', legacyIb.strategyId === 'infinite-buying' && legacyIb.strategyName === '라오어 무한매수법 (근사)')

  const legacyVr = runValueRebalancing(BARS_B, 120, DEFAULT_VR_PARAMS, settings)
  const nowVr = runPortfolio(VR_TQQQ, { ...defaultConfig(VR_TQQQ), symbols: ['TQQQ'] }, HISTS)
  check('VR 자산곡선 불변', JSON.stringify(legacyVr.equity) === JSON.stringify(nowVr.sleeves[0].res.equity))
  check('VR 지표 불변', JSON.stringify(legacyVr.metrics) === JSON.stringify(nowVr.sleeves[0].res.metrics))
  check('VR 기본 identity 유지(인자 생략 시)', legacyVr.strategyId === 'value-rebalancing' && legacyVr.strategyName === '라오어 VR 밸류 리밸런싱 (근사)')

  // 모의운용 지문 — 기존 등록이 "설정이 바뀌었다"고 튕기면 안 된다.
  const specIb = buildSpec(IB_SOXL, defaultConfig(IB_SOXL))
  const specVr = buildSpec(VR_TQQQ, defaultConfig(VR_TQQQ))
  check('IB 스펙 engine 문자열 불변', specIb.engine === 'infinite-buying')
  check('VR 스펙 engine 문자열 불변', specVr.engine === 'value-rebalancing')
  check('IB 스펙 modelName 불변', specIb.modelName === '라오어 무한매수법 (근사)')
  check('VR 스펙 modelName 불변', specVr.modelName === '라오어 VR 밸류 리밸런싱 (근사)')
  // 지문 고정값 — 이 값이 바뀌면 대표의 기존 모의운용 등록이 전부 깨진다.
  // (배선 리팩토링 직전 커밋에서 실측한 값. 모델 id·name·engine·기본 파라미터
  //  중 하나라도 건드리면 여기서 잡힌다.)
  check('IB 지문 고정 (등록 호환)', fingerprint(specIb) === '1113D214', fingerprint(specIb))
  check('VR 지문 고정 (등록 호환)', fingerprint(specVr) === 'A8F0564D', fingerprint(specVr))
  // 규칙형/로테이션 경로도 종전 그대로여야 한다
  check('규칙형 engine 불변', buildSpec('golden-cross', defaultConfig('golden-cross')).engine === 'rule')
  check('로테이션 engine 불변', buildSpec('dual-momentum', defaultConfig('dual-momentum')).engine === 'rotation')
  check('퀀트도 종전대로 rule 취급', buildSpec('quant-composite', defaultConfig('quant-composite')).engine === 'rule')
}

section('5) 새 조합의 스펙·강건성·판정설명도 올바른 엔진을 탄다')
{
  const specIbT = buildSpec(IB_TQQQ, defaultConfig(IB_TQQQ))
  check('IB 변형 스펙 engine', specIbT.engine === 'infinite-buying')
  check('IB 변형 스펙 파라미터 표기', specIbT.rules.params?.['분할수'] === 40 && specIbT.rules.params?.['목표수익률Pct'] === 10)
  const specVrS = buildSpec(VR_SOXL, defaultConfig(VR_SOXL))
  check('VR 변형 스펙 engine', specVrS.engine === 'value-rebalancing')
  check('VR 변형 스펙 파라미터 표기', specVrS.rules.params?.['밴드Pct'] === 15)
  check('4조합 지문이 서로 다름', new Set(COMBOS.map((id) => fingerprint(buildSpec(id, defaultConfig(id))))).size === 4)

  // 강건성 변형축 — IB 변형이 VR 파라미터로 흔들리면 안 된다
  const vIb = buildVariants(IB_TQQQ, defaultConfig(IB_TQQQ))
  check('IB 변형: 분할수 축 존재', vIb.some((v) => v.label.includes('분할수')))
  check('IB 변형: VR 축 없음', !vIb.some((v) => v.label.includes('V성장')))
  const vVr = buildVariants(VR_SOXL, defaultConfig(VR_SOXL))
  check('VR 변형: V성장 축 존재', vVr.some((v) => v.label.includes('V성장')))
  check('VR 변형: 분할수 축 없음', !vVr.some((v) => v.label.includes('분할수')))

  // "오늘의 판정" — 새 id가 '규칙 정보 없음'으로 떨어지면 안 된다
  for (const id of COMBOS) {
    const cfg = defaultConfig(id)
    const res = runPortfolio(id, cfg, HISTS)
    const sigs = computeSignals(id, cfg, res, HISTS)
    check(`${id}: 판정 설명 생성`, sigs.length === 1 && sigs[0].reasons.length > 0 && sigs[0].summary !== '규칙 정보 없음', sigs[0]?.summary)
  }
}

section('6) 규칙 4 — 레버리지 경고 · "검증 전" 표기가 4조합 모두에 붙어 있다')
{
  for (const id of COMBOS) {
    const meta = modelMeta(id)
    check(`${id}: 검증 전 플래그`, meta.unvalidated === true)
    check(`${id}: desc에 변동성 잠식 경고`, meta.desc.includes('변동성 잠식'))
    check(`${id}: desc에 3배 레버리지 명시`, meta.desc.includes('3배'))
    check(`${id}: desc에 장기보유 상품 아님 고지`, meta.desc.includes('장기 보유 상품이 아니라'))
    check(`${id}: desc에 물타기·원금 소진 경고`, meta.desc.includes('물타기') && meta.desc.includes('원금이 소진'))
    check(`${id}: desc에 검증 전 명시`, meta.desc.includes('검증 전'))
    // "추천/승자/검증됨"은 **부정형으로만** 등장해야 한다 — 긍정 주장 금지.
    check(`${id}: 추천·승자 아님을 명시`, meta.desc.includes('추천·승자 전략이 아니라'))
    check(
      `${id}: 검증 통과 프리셋으로 주장하지 않음`,
      !/검증됨|검증 완료|추천 전략|추천합니다|승자 전략입니다|통과한 프리셋/.test(meta.desc),
      meta.desc.slice(0, 40),
    )

    const doc = findDoc(id)
    check(`${id}: 문서 존재`, doc != null)
    const heads = (doc?.sections ?? []).map((s) => s.h).join(' | ')
    check(`${id}: 문서에 레버리지 경고 섹션`, heads.includes('레버리지 ETF 경고'), heads)
    check(`${id}: 문서에 검증 전 섹션`, heads.includes('검증 전'), heads)
    check(`${id}: 문서 첫 섹션이 조합 안내`, (doc?.sections[0]?.h ?? '').includes('이 조합'), doc?.sections[0]?.h)
  }

  // 원저 세팅 / 변형 구분이 숨겨지지 않아야 한다
  check('IB 원저판: 원저 세팅 명시', modelMeta(IB_SOXL).desc.includes('원저 세팅'))
  check('VR 원저판: 원저 세팅 명시', modelMeta(VR_TQQQ).desc.includes('원저 세팅'))
  check('IB 변형판: 원저 아님 명시', modelMeta(IB_TQQQ).desc.includes('원저 세팅이 아닙니다'))
  check('VR 변형판: 원저 아님 명시', modelMeta(VR_SOXL).desc.includes('원저 세팅이 아닙니다'))
  check('IB 변형 문서: 원저 아님 명시', (findDoc(IB_TQQQ)?.sections[0].lines.join(' ') ?? '').includes('원저가 상정한 조합이 아닙니다'))
  check('VR 변형 문서: 원저 아님 명시', (findDoc(VR_SOXL)?.sections[0].lines.join(' ') ?? '').includes('원저가 상정한 조합이 아닙니다'))

  // 낙폭 숫자를 기억으로 적어두지 않았는가 — 실측으로 찍어야 한다
  const allText = COMBOS.map((id) => modelMeta(id).desc + (findDoc(id)?.sections ?? []).map((s) => s.h + s.lines.join(' ')).join(' ')).join(' ')
  check('설명에 하드코딩된 낙폭 수치 없음', !/−?-?9[01](\.\d)?%/.test(allText.replace(/−80~90%대/g, '')), '기억으로 적은 낙폭 수치가 남아 있음')
  check('실측 표기로 안내', allText.includes('[실측]'))
}

section('7) 실측 낙폭 계산기 — 하드코딩 대신 데이터에서 뽑는다')
{
  // 알려진 곡선: 2021년 100→50(반토막 후 회복 없음), 2022년 완만 상승
  const bars: { date: string; c: number }[] = []
  for (let i = 0; i < 100; i++) bars.push({ date: `2021-${String(Math.floor(i / 28) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`, c: 100 - i * 0.5 })
  for (let i = 0; i < 100; i++) bars.push({ date: `2022-${String(Math.floor(i / 28) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`, c: 50 + i * 0.2 })
  const rows = buyHoldYearlyRisk(bars)
  check('연도 2개 산출', rows.length === 2, JSON.stringify(rows.map((r) => r.year)))
  const y21 = rows.find((r) => r.year === '2021')!
  check('2021 낙폭 = 연중 고점 대비 −49.5%', Math.abs(y21.mddPct - -49.5) < 1e-9, `${y21.mddPct}`)
  check('2021 수익률 = −49.5%', Math.abs(y21.retPct - -49.5) < 1e-9)
  const y22 = rows.find((r) => r.year === '2022')!
  check('2022 낙폭 0 (단조 상승)', y22.mddPct === 0, `${y22.mddPct}`)
  const worst = worstCalendarYear(bars)
  check('최악 연도 = 2021', worst?.year === '2021')
  check('데이터 없으면 null', worstCalendarYear([]) === null)
  check('반쪽 연도(60봉 미만) 제외', worstCalendarYear(bars.slice(0, 30)) === null)
}

section('8) 규칙 1 — 새 조합도 절단 불변성을 지킨다')
{
  // 뒤를 잘라내고 다시 돌렸을 때, 잘린 시점 이전 구간이 완전히 같아야 한다.
  const CUT = 700
  for (const id of COMBOS) {
    const sym = modelMeta(id).defaultSymbols[0]
    const full = HISTS[sym].bars
    const cfg = defaultConfig(id)
    const resFull = runPortfolio(id, cfg, { [sym]: hist(sym, full) })
    const resCut = runPortfolio(id, cfg, { [sym]: hist(sym, full.slice(0, CUT)) })
    const boundary = full[CUT - 2].date

    const fullEq = resFull.equity.filter((e) => e.date <= boundary).map((e) => e.equity)
    const cutEq = resCut.equity.filter((e) => e.date <= boundary).map((e) => e.equity)
    check(`${id}: 절단 전 자산곡선 길이 동일`, fullEq.length === cutEq.length && fullEq.length > 100, `${fullEq.length} vs ${cutEq.length}`)
    check(`${id}: 절단 전 자산곡선 값 동일`, fullEq.every((v, i) => v === cutEq[i]))

    const fullEv = resFull.events.filter((e) => e.date <= boundary).map((e) => `${e.date}|${e.action}|${e.qty}|${e.price}`)
    const cutEv = resCut.events.filter((e) => e.date <= boundary).map((e) => `${e.date}|${e.action}|${e.qty}|${e.price}`)
    check(`${id}: 절단 전 체결 이력 동일`, JSON.stringify(fullEv) === JSON.stringify(cutEv), `${fullEv.length} vs ${cutEv.length}`)
  }
}

finish()
