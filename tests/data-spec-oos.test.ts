// 배당보정 파서 · 스펙지문 · OOS 분해 · 설명 레이어 검증
import { check, finish } from './harness'
import { parseYahooDaily } from '../src/lib/history'
import { buildSpec, fingerprint } from '../src/features/backtest/spec'
import { buildOosReport } from '../src/features/backtest/oos'
import { evalConditionAt, conditionText } from '../src/features/backtest/explain'
import { defaultConfig } from '../src/features/backtest/models'
import type { DailyBar } from '../src/lib/history'
import type { EquityPoint } from '../src/features/backtest/types'

// ===== 1) 배당 보정 파서 =====
// close=100,101,102 / adjclose=99,100.5,102 → f=0.99, 0.99505, 1.0
const fixture = {
  chart: { result: [{
    meta: { currency: 'USD', exchangeName: 'NMS', fullExchangeName: 'NasdaqGS', instrumentType: 'ETF', gmtoffset: -14400 },
    timestamp: [1704258000, 1704344400, 1704430800],
    indicators: {
      quote: [{ open: [99, 100, 101], high: [101, 102, 103], low: [98, 99, 100], close: [100, 101, 102], volume: [1e6, 2e6, 3e6] }],
      adjclose: [{ adjclose: [99, 100.5, 102] }],
    },
  }] },
}
// 봉 60개 미만이면 throw 하므로 확장
const big = JSON.parse(JSON.stringify(fixture))
for (let i = 3; i < 80; i++) {
  big.chart.result[0].timestamp.push(1704430800 + (i - 2) * 86400)
  big.chart.result[0].indicators.quote[0].open.push(101)
  big.chart.result[0].indicators.quote[0].high.push(103)
  big.chart.result[0].indicators.quote[0].low.push(100)
  big.chart.result[0].indicators.quote[0].close.push(102)
  big.chart.result[0].indicators.quote[0].volume.push(1e6)
  big.chart.result[0].indicators.adjclose[0].adjclose.push(102)
}
const h = parseYahooDaily('TEST', big, 'unit-test')
check('보정모드 = split+dividend', h.adjustment === 'split+dividend', h.adjustment)
check('배당계수 적용 close[0] = 99', Math.abs(h.bars[0].c - 99) < 1e-9, `${h.bars[0].c}`)
check('OHLC 동일계수 적용 open[0] = 99*0.99', Math.abs(h.bars[0].o - 99 * 0.99) < 1e-9, `${h.bars[0].o}`)
check('high[0] = 101*0.99', Math.abs(h.bars[0].h - 101 * 0.99) < 1e-9)
check('원본 종가 보존 rawClose=100', h.bars[0].rawClose === 100)
check('계수 1.0 구간 무변화', Math.abs(h.bars[2].c - 102) < 1e-9)
check('OHLC 대소관계 보존(l≤o,c≤h)', h.bars.every((b: DailyBar) => b.l <= b.o && b.l <= b.c && b.h >= b.o && b.h >= b.c))
check('provenance 필드', h.source.includes('Yahoo') && h.proxyUsed === 'unit-test' && h.currency === 'USD' && h.instrumentType === 'ETF')

// adjclose 없는 경우 → split-only, 가격 원본 유지
const noAdj = JSON.parse(JSON.stringify(big))
delete noAdj.chart.result[0].indicators.adjclose
const h2 = parseYahooDaily('TEST', noAdj, 'unit-test')
check('adjclose 없으면 split-only', h2.adjustment === 'split-only')
check('split-only는 원본가 유지', h2.bars[0].c === 100)

// 결측봉 카운트
const withNull = JSON.parse(JSON.stringify(big))
withNull.chart.result[0].indicators.quote[0].close[5] = null
const h3 = parseYahooDaily('TEST', withNull, 'unit-test')
check('결측봉 droppedBars=1', h3.droppedBars === 1, `${h3.droppedBars}`)

// ===== 2) 스펙 지문 =====
const cfgA = defaultConfig('golden-cross')
const specA = buildSpec('golden-cross', cfgA)
const fpA = fingerprint(specA)
check('지문 8자리 hex', /^[0-9A-F]{8}$/.test(fpA), fpA)
check('동일 설정 = 동일 지문 (재현성)', fingerprint(buildSpec('golden-cross', defaultConfig('golden-cross'))) === fpA)
// 유니버스 순서만 다르면 같은 지문(정규화)
const cfgOrder = { ...cfgA, symbols: [...cfgA.symbols].reverse() }
check('유니버스 순서 무관 = 동일 지문', fingerprint(buildSpec('golden-cross', cfgOrder)) === fpA)
// 파라미터 하나만 바꿔도 다른 지문
const cfgB = { ...cfgA, settings: { ...cfgA.settings, stopLossPct: 7 } }
check('손절 8→7 = 다른 지문', fingerprint(buildSpec('golden-cross', cfgB)) !== fpA)
const cfgC = { ...cfgA, symbols: [...cfgA.symbols, 'SPY'] }
check('종목 추가 = 다른 지문', fingerprint(buildSpec('golden-cross', cfgC)) !== fpA)
const cfgD = { ...cfgA, strategy: { ...cfgA.strategy!, buy: [{ left: { kind: 'SMA' as const, period: 7 }, op: 'crossAbove' as const, right: { kind: 'SMA' as const, period: 20 } }] } }
check('규칙 변경(SMA5→7) = 다른 지문', fingerprint(buildSpec('golden-cross', cfgD)) !== fpA)
check('스펙에 사람이 읽는 규칙 포함', (specA.rules.buy ?? []).some((r) => r.includes('SMA5') && r.includes('상향돌파')), JSON.stringify(specA.rules.buy))
const specIB = buildSpec('infinite-buying', defaultConfig('infinite-buying'))
check('알고리즘 스펙 파라미터', specIB.rules.params?.['분할수'] === 40 && specIB.rules.params?.['목표수익률Pct'] === 10)
check('실행규칙 명시(워크포워드)', specA.execution.lookahead.includes('미참조'))

// ===== 3) OOS 분해 =====
// 등록 전 100→200 (+100%), 등록 후 200→180 (-10%), 벤치는 등록후 200→220 (+10%)
const eq: EquityPoint[] = []
const mkDate = (i: number) => new Date(Date.UTC(2024, 0, 1) + i * 86400000).toISOString().slice(0, 10)
for (let i = 0; i < 100; i++) eq.push({ date: mkDate(i), equity: 100 + i, benchmark: 100 + i * 0.5, drawdownPct: 0 })
const enrollDate = mkDate(100)
for (let i = 100; i < 160; i++) eq.push({ date: mkDate(i), equity: 200 - (i - 100) * 0.34, benchmark: 150 + (i - 100) * 0.3, drawdownPct: 0 })
const rep = buildOosReport(eq, enrollDate)
check('등록 전 구간 분리', rep.inSample != null && rep.inSample.days === 100 && rep.inSample.to < enrollDate)
check('등록 후 구간 분리', rep.outSample != null && rep.outSample.days === 60 && rep.outSample.from === enrollDate)
check('등록 후 수익률 음수', (rep.outSample?.totalReturnPct ?? 0) < 0, `${rep.outSample?.totalReturnPct}`)
check('등록 후 초과수익 음수(벤치 미달)', (rep.outSample?.excessPct ?? 0) < 0)
check('CAGR 격차 음수(성과 저하)', (rep.cagrGapPct ?? 0) < 0)
check('판정 = 과최적화 의심', rep.verdictLevel === 'bad', rep.verdictLevel + ' | ' + rep.verdict)

// 짧은 OOS는 판단 유보
const shortEq = eq.slice(0, 105)
const repShort = buildOosReport(shortEq, enrollDate)
check('OOS 5일 → 판단 유보', repShort.verdictLevel === 'early', repShort.verdictLevel)

// 좋은 케이스
const eqGood: EquityPoint[] = []
for (let i = 0; i < 100; i++) eqGood.push({ date: mkDate(i), equity: 100 + i * 0.5, benchmark: 100 + i * 0.4, drawdownPct: 0 })
for (let i = 100; i < 200; i++) eqGood.push({ date: mkDate(i), equity: 150 + (i - 100) * 0.6, benchmark: 140 + (i - 100) * 0.2, drawdownPct: 0 })
const repGood = buildOosReport(eqGood, enrollDate)
check('좋은 케이스 판정 = good', repGood.verdictLevel === 'good', repGood.verdictLevel + ' | ' + repGood.verdict)
check('알파 = CAGR − 벤치CAGR', Math.abs((repGood.outSample!.alphaPct) - (repGood.outSample!.cagrPct - repGood.outSample!.benchCagrPct)) < 1e-9)
// 장세만 좋은 경우(전략=벤치와 동일 상승)는 알파 0 → good 아님
const eqBeta: EquityPoint[] = []
for (let i = 0; i < 100; i++) eqBeta.push({ date: mkDate(i), equity: 100 + i, benchmark: 100 + i, drawdownPct: 0 })
for (let i = 100; i < 200; i++) eqBeta.push({ date: mkDate(i), equity: 200 + (i - 100) * 2, benchmark: 200 + (i - 100) * 2, drawdownPct: 0 })
const repBeta = buildOosReport(eqBeta, mkDate(100))
check('장세뿐(알파 0) → good 아님', repBeta.verdictLevel !== 'good', repBeta.verdictLevel + ' | alpha ' + repBeta.outSample!.alphaPct.toFixed(2))

// 재현성: 같은 입력 두 번 → 같은 결과
check('OOS 재계산 결정적', JSON.stringify(buildOosReport(eq, enrollDate)) === JSON.stringify(rep))

// 구간 MDD는 구간 내 고점 기준으로 재산출
const eqDD: EquityPoint[] = []
for (let i = 0; i < 60; i++) eqDD.push({ date: mkDate(i), equity: 1000, benchmark: 1000, drawdownPct: -50 })
for (let i = 60; i < 120; i++) eqDD.push({ date: mkDate(i), equity: i < 90 ? 1000 : 900, benchmark: 1000, drawdownPct: -50 })
const repDD = buildOosReport(eqDD, mkDate(60))
check('구간 MDD 재기준(-10%)', Math.abs((repDD.outSample?.mddPct ?? 0) - -10) < 1e-9, `${repDD.outSample?.mddPct}`)

// ===== 4) 설명 레이어 =====
const bars: DailyBar[] = []
const prices = [10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 20, 20, 20, 20, 20]
prices.forEach((p, i) => bars.push({ date: mkDate(i), t: 0, o: p, h: p, l: p, c: p, v: 1 }))
const cond = { left: { kind: 'SMA' as const, period: 2 }, op: 'crossAbove' as const, right: { kind: 'SMA' as const, period: 5 } }
check('조건 텍스트 한국어', conditionText(cond) === 'SMA2 상향돌파 SMA5', conditionText(cond))
const ev11 = evalConditionAt(bars, cond, 10)
check('크로스 판정 met=true', ev11.met, JSON.stringify(ev11))
check('설명에 당일·전일 실측값 포함', ev11.detail.includes('당일') && ev11.detail.includes('전일'), ev11.detail)
const ev5 = evalConditionAt(bars, cond, 5)
check('평평구간 met=false', !ev5.met)
const evGt = evalConditionAt(bars, { left: { kind: 'CLOSE' }, op: 'gt', right: { kind: 'CONST', value: 15 } }, 12)
check('단순비교 판정', evGt.met && evGt.text === '종가 > 15', evGt.text)

finish()
