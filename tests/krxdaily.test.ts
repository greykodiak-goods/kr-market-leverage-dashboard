// KRX 일별 시세 정본 — 응답 파서 · 스키마 파서 · 수정계수 분류 · 수정주가 불변식.
//
// 이 파일이 막는 사고는 네 가지다.
//
//   ① **틀린 시세 파일이 조용히 통과하는 것.** `public/data/krx-daily/*`는 EC2에서 수집돼
//      리포에 커밋되고, 백테스트는 그것을 그대로 믿는다. 달력 인덱스가 어긋나거나 OHLC에
//      0이 섞이면 수익률이 −100%가 되고, 그렇게 나온 표는 거짓이다. 파서가 던져야 한다.
//   ② **수정계수 오분류.** 주식수가 늘어난 게 분할인지 유상증자인지 잘못 보면, 없는 수익을
//      만들거나(증자를 분할로 오인) 가짜 −98%를 남긴다(분할을 놓침). 분류 산술을 고정한다.
//   ③ **수정주가가 수익률을 바꾸는 것.** 표준 수정주가는 **이벤트일을 뺀 모든 날의 일별
//      수익률을 보존**해야 한다. 보존되지 않으면 과거 성적이 수집 시점마다 달라진다 —
//      그게 곧 절단 불변성(규칙 1) 위반의 데이터 판이다. 여기서 그 성질을 직접 검증한다.
//   ④ **한계 표기가 사라지는 것.** 배당 미반영·거래량 미수집은 규칙 3이 요구하는 라벨이다.
//      코드에서 지워지면 화면이 총수익인 척하게 된다.
//
// ⚠️ 미래참조 금지(규칙 1)와의 관계 — **새 엔진 경로가 없다.** 이 파일은 시세 로더일 뿐이고
//    엔진(engine/algoEngine/series)은 손대지 않았다. 다만 수정계수는 "미래 이벤트로 과거
//    가격을 다시 쓰는" 조작이므로, 그것이 **일별 수익률을 바꾸지 않는다**는 것을 ③에서
//    확인한다. 수익률이 그대로면 어제까지의 신호도 그대로다.
//
// 네트워크를 타지 않는다(KRX는 국내 IP 전용 — 컨테이너에서는 어차피 막힌다). 전부 픽스처.

import { check, eq, close as closeTo, finish, section, rng } from './harness'
import {
  KRX_DAILY_BADGE,
  KRX_DAILY_LIMITS,
  KRX_DAILY_SCHEMA_INDEX,
  KRX_DAILY_SCHEMA_MONTHLY,
  KRX_DAILY_SCHEMA_PRICES,
  buildKrxAdjEvents,
  classifyKrxShareChange,
  isKrxCommonStock,
  krxDailyBars,
  krxDailyPriceFile,
  krxDailyRawBars,
  krxDailySourceNote,
  krxMonthlyCodes,
  krxMonthlyUnion,
  parseKrxByddResponse,
  parseKrxDailyIndex,
  parseKrxDailyStock,
  parseKrxMonthlyUniverse,
} from '../src/features/backtest/krxDailyPrices'
import type { KrxDailyIndex, KrxDailyRow, KrxDailyStock } from '../src/features/backtest/krxDailyPrices'

const throws = (fn: () => unknown): string | null => {
  try {
    fn()
    return null
  } catch (e) {
    return (e as Error).message
  }
}

// ---------------------------------------------------------------- 픽스처 헬퍼

/** 연속 거래일 달력(주말 무시 — 인덱스 규약만 검증하면 되므로). */
function calendarOf(n: number, start = '2020-01-02'): string[] {
  const out: string[] = []
  const d = new Date(`${start}T00:00:00Z`)
  for (let i = 0; i < n; i++) {
    out.push(d.toISOString().slice(0, 10))
    d.setUTCDate(d.getUTCDate() + 1)
  }
  return out
}

/**
 * 결정적 난수로 만든 원주가 시계열 + (선택) 분할 이벤트.
 * `splitAt`에서 가격은 1/ratio, 주식수는 ×ratio가 된다 — 실제 액면분할과 같은 모양.
 */
function makeSeries(n: number, opts: { splitAt?: number; ratio?: number; seed?: number } = {}) {
  const r = rng(opts.seed ?? 7)
  const rows: KrxDailyRow[] = []
  const shares: number[] = []
  let px = 50_000
  let sh = 1_000_000
  for (let i = 0; i < n; i++) {
    if (opts.splitAt != null && i === opts.splitAt) {
      const k = opts.ratio ?? 50
      px = px / k
      sh = sh * k
    }
    px = px * (1 + (r() - 0.5) * 0.06)
    const c = Math.round(px * 100) / 100
    const o = Math.round(c * (1 + (r() - 0.5) * 0.02) * 100) / 100
    const h = Math.round(Math.max(o, c) * (1 + r() * 0.01) * 100) / 100
    const l = Math.round(Math.min(o, c) * (1 - r() * 0.01) * 100) / 100
    rows.push([i, o, h, l, c])
    shares.push(sh)
  }
  return { rows, shares }
}

function indexOf(calendar: string[], stocks: KrxDailyIndex['stocks']): KrxDailyIndex {
  return parseKrxDailyIndex({
    schema: KRX_DAILY_SCHEMA_INDEX,
    version: 1,
    source: 'KRX Open API (테스트 픽스처)',
    basis: '일별 전종목 단면 · 원주가',
    asOf: '2026-08-03',
    from: calendar[0],
    to: calendar[calendar.length - 1],
    calendar,
    missingDays: [],
    volume: false,
    limits: [...KRX_DAILY_LIMITS],
    stocks,
  })
}

function stockOf(code: string, rows: KrxDailyRow[], shares: number[], calendar: string[]): KrxDailyStock {
  const events = buildKrxAdjEvents(rows, shares, calendar)
  const pts: [number, number][] = [[rows[0][0], shares[0]]]
  for (let i = 1; i < rows.length; i++) if (shares[i] !== shares[i - 1]) pts.push([rows[i][0], shares[i]])
  return parseKrxDailyStock(
    {
      schema: KRX_DAILY_SCHEMA_PRICES,
      code,
      name: `테스트${code}`,
      adjustment: 'raw',
      dividendAdjusted: false,
      market: 'kospi',
      markets: ['kospi'],
      rows,
      shares: pts,
      events,
    },
    calendar.length,
  )
}

function entryOf(code: string, rows: KrxDailyRow[], calendar: string[], adjEvents: number) {
  return {
    code,
    name: `테스트${code}`,
    market: 'kospi' as const,
    from: calendar[rows[0][0]],
    to: calendar[rows[rows.length - 1][0]],
    bars: rows.length,
    gaps: rows[rows.length - 1][0] - rows[0][0] + 1 - rows.length,
    trimmed: false,
    adjEvents,
    file: krxDailyPriceFile(code),
  }
}

// ======================================================= 1) KRX 응답 관용 파싱

section('1) KRX 일별 단면 응답 파싱 (필드명 [미검증] — 후보 관용 파싱)')
{
  const ok = {
    OutBlock_1: [
      {
        ISU_SRT_CD: '005930',
        ISU_ABBRV: '삼성전자',
        TDD_OPNPRC: '70,000',
        TDD_HGPRC: '71,500',
        TDD_LWPRC: '69,800',
        TDD_CLSPRC: '70,900',
        MKTCAP: '423,281,000,000,000',
        LIST_SHRS: '5,969,782,550',
        ACC_TRDVOL: '12,345,678',
      },
      // 우선주 — 파서는 버리지 않는다(보통주 필터는 isKrxCommonStock의 몫)
      { ISU_SRT_CD: '005935', ISU_ABBRV: '삼성전자우', TDD_OPNPRC: '60,000', TDD_HGPRC: '61,000', TDD_LWPRC: '59,000', TDD_CLSPRC: '60,500', MKTCAP: '1', LIST_SHRS: '822,886,700' },
      // 거래정지: 가격이 '-' → 버린다(0을 가격으로 저장하면 −100% 수익률이 생긴다)
      { ISU_SRT_CD: '900110', ISU_ABBRV: '이스트아시아', TDD_OPNPRC: '-', TDD_HGPRC: '-', TDD_LWPRC: '-', TDD_CLSPRC: '-', MKTCAP: '0', LIST_SHRS: '100' },
      // 주식수 0 → 수정계수 산출 불가라 버린다
      { ISU_SRT_CD: '123450', ISU_ABBRV: '주식수결측', TDD_OPNPRC: '1,000', TDD_HGPRC: '1,100', TDD_LWPRC: '900', TDD_CLSPRC: '1,050', MKTCAP: '0', LIST_SHRS: '0' },
      // 코드 형식 위반
      { ISU_SRT_CD: 'KR7005930003', ISU_ABBRV: '표준코드', TDD_OPNPRC: '1', TDD_HGPRC: '1', TDD_LWPRC: '1', TDD_CLSPRC: '1', LIST_SHRS: '1' },
    ],
  }
  const p = parseKrxByddResponse(ok)
  eq('정상 줄만 통과 (2줄)', p.rows.length, 2)
  eq('버린 줄 수를 센다', p.dropped, 3)
  eq('원본 줄 수 보고', p.total, 5)
  eq('쉼표 제거 후 숫자 변환 (종가)', p.rows[0].close, 70900)
  eq('상장주식수 변환', p.rows[0].shares, 5969782550)
  eq('거래량 변환', p.rows[0].volume, 12345678)
  eq('거래량 결측은 0', p.rows[1].volume, 0)
  check('첫 줄 키 목록을 보고한다(필드명 확정용)', p.rawKeys.includes('TDD_CLSPRC'))

  // 문서와 실제 필드명이 다른 경우 — 후보를 순서대로 시도한다
  const alt = { data: [{ ISU_CD: '035420', ISU_NM: 'NAVER', OPNPRC: '100', HGPRC: '110', LWPRC: '95', CLSPRC: '105', LISTSHRS: '1000' }] }
  const pa = parseKrxByddResponse(alt)
  eq('대체 필드명·대체 배열 키로도 파싱', pa.rows.length, 1)
  eq('대체 필드명 종가', pa.rows[0].close, 105)

  eq('휴장일(빈 배열)은 0줄', parseKrxByddResponse({ OutBlock_1: [] }).rows.length, 0)
  check('행 배열이 없으면 던진다', throws(() => parseKrxByddResponse({ errMsg: '인증 실패' }))?.includes('행 배열') === true)
  check('객체가 아니면 던진다', throws(() => parseKrxByddResponse('nope')) !== null)

  eq('보통주 필터: 보통주 통과', isKrxCommonStock('005930', '삼성전자'), true)
  eq('보통주 필터: 우선주 제외', isKrxCommonStock('005935', '삼성전자우'), false)
  eq('보통주 필터: 스팩 제외', isKrxCommonStock('123450', '엔에이치스팩29호'), false)
}

// ================================================= 2) 수정계수 분류 (핵심 산술)

section('2) 수정계수 분류 — 분할형 vs 유상증자형 vs [미검증] 저신뢰')
{
  const base = { date: '2020-06-01', idx: 5 }
  // 50:1 액면분할 — 주식수 ×50, 가격 1/50. 괴리 0 → split/high
  const split = classifyKrxShareChange({ ...base, sharesBefore: 128_386_494, sharesAfter: 6_419_324_700, prevClose: 2_650_000, close: 53_000 })
  eq('50:1 분할 → split', split?.kind, 'split')
  eq('50:1 분할 → high', split?.confidence, 'high')
  closeTo('factor = 주식수 비율', split?.factor ?? 0, 50, 1e-6)

  // 같은 분할인데 그날 −8% 하락이 겹친 경우 → 괴리 8% → split/medium
  const noisy = classifyKrxShareChange({ ...base, sharesBefore: 1_000_000, sharesAfter: 50_000_000, prevClose: 2_650_000, close: 53_000 * (1 / 0.92) })
  eq('분할 + 당일 등락 → split', noisy?.kind, 'split')
  eq('분할 + 당일 등락 → medium', noisy?.confidence, 'medium')

  // 1:5 액면병합 — 주식수 1/5, 가격 ×5
  const merge = classifyKrxShareChange({ ...base, sharesBefore: 50_000_000, sharesAfter: 10_000_000, prevClose: 1_000, close: 5_000 })
  eq('액면병합도 split으로 잡는다', merge?.kind, 'split')
  closeTo('병합 factor = 0.2', merge?.factor ?? 0, 0.2, 1e-9)

  // 1:1 무상증자 — 주식수 ×2, 가격 1/2
  const bonus = classifyKrxShareChange({ ...base, sharesBefore: 10_000_000, sharesAfter: 20_000_000, prevClose: 40_000, close: 20_200 })
  eq('무상증자 → split', bonus?.kind, 'split')

  // 30% 유상증자 — 주식수 ×1.3인데 가격은 −3%뿐 → 괴리 큼 → 보정 없음
  const rights = classifyKrxShareChange({ ...base, sharesBefore: 10_000_000, sharesAfter: 13_000_000, prevClose: 10_000, close: 9_700 })
  eq('유상증자 → shareChange', rights?.kind, 'shareChange')
  eq('유상증자 → factor 1 (보정 없음)', rights?.factor, 1)
  eq('유상증자 → high (뚜렷한 변화)', rights?.confidence, 'high')

  // 소폭(2%) 주식수 증가 + 우연히 맞는 −2% 하락 → low. 조용히 보정하지 않는다.
  const amb = classifyKrxShareChange({ ...base, sharesBefore: 10_000_000, sharesAfter: 10_200_000, prevClose: 10_200, close: 10_000 })
  eq('소폭 변화 + 가격 정합 → split', amb?.kind, 'split')
  eq('소폭 변화는 [미검증] low', amb?.confidence, 'low')

  // 소폭 변화인데 가격이 안 맞음 → 증자·전환 추정, 보정 없음
  const amb2 = classifyKrxShareChange({ ...base, sharesBefore: 10_000_000, sharesAfter: 10_200_000, prevClose: 10_000, close: 10_000 })
  eq('소폭 변화 + 가격 불일치 → shareChange', amb2?.kind, 'shareChange')
  eq('소폭 변화 + 가격 불일치 → medium', amb2?.confidence, 'medium')

  // ⚠️ 회귀 방지 — 상대 괴리(dev) 하나만 보면 ratio가 1에 가까울 때 자동으로 작아진다.
  // 5% 유상증자에 가격이 전혀 안 움직여도 dev는 4.8%라 "±5% 일치"에 걸려 분할로 오인되고,
  // 그러면 없는 +5% 수익이 시계열에 생긴다. 갭실현 지표가 이걸 0으로 잡아낸다.
  const flat5 = classifyKrxShareChange({ ...base, sharesBefore: 10_000_000, sharesAfter: 10_500_000, prevClose: 10_000, close: 10_000 })
  eq('5% 증자 + 가격 무변동 → shareChange (dev만 보면 오인되는 케이스)', flat5?.kind, 'shareChange')
  eq('5% 증자 + 가격 무변동 → factor 1', flat5?.factor, 1)
  // 반대로 큰 분할에 당일 등락이 섞이면 갭실현이 1 근처라 분할로 남는다
  const big = classifyKrxShareChange({ ...base, sharesBefore: 1_000_000, sharesAfter: 10_000_000, prevClose: 100_000, close: 10_800 })
  eq('10:1 분할 + 당일 등락 → split 유지', big?.kind, 'split')

  eq('1% 미만 변화는 후보가 아니다', classifyKrxShareChange({ ...base, sharesBefore: 10_000_000, sharesAfter: 10_050_000, prevClose: 100, close: 100 }), null)
  eq('변화 없음은 후보가 아니다', classifyKrxShareChange({ ...base, sharesBefore: 1_000, sharesAfter: 1_000, prevClose: 100, close: 100 }), null)
  eq('가격 결측이면 보정하지 않는다', classifyKrxShareChange({ ...base, sharesBefore: 1_000, sharesAfter: 2_000, prevClose: 0, close: 100 })?.factor, 1)
  eq('가격 결측이면 low', classifyKrxShareChange({ ...base, sharesBefore: 1_000, sharesAfter: 2_000, prevClose: 0, close: 100 })?.confidence, 'low')
}

// ======================================== 3) 수정주가 불변식 — 일별 수익률 보존

section('3) 수정 적용 전후 일별 수익률이 이벤트일을 빼면 전 구간 동일 (핵심 불변식)')
{
  const cal = calendarOf(60)
  const { rows, shares } = makeSeries(60, { splitAt: 30, ratio: 50, seed: 11 })
  const stock = stockOf('005930', rows, shares, cal)
  const index = indexOf(cal, [entryOf('005930', rows, cal, stock.events.length)])

  eq('분할 1건이 검출된다', stock.events.filter((e) => e.kind === 'split').length, 1)
  eq('분할일이 idx 30이다', stock.events[0]?.idx, 30)

  const res = krxDailyBars(index, stock)
  const raw = krxDailyRawBars(index, stock)
  eq('보정 적용 1건', res.applied.length, 1)
  eq('미보정 0건', res.skipped.length, 0)
  eq('봉 수 동일', res.bars.length, raw.length)

  const eventIdx = new Set(res.applied.map((e) => e.idx))
  let compared = 0
  let worst = 0
  for (let i = 1; i < res.bars.length; i++) {
    if (eventIdx.has(rows[i][0])) continue
    const a = res.bars[i].c / res.bars[i - 1].c
    const b = raw[i].c / raw[i - 1].c
    compared++
    worst = Math.max(worst, Math.abs(a / b - 1))
  }
  eq('비교한 날 수 = 전체 − 1(첫날) − 1(이벤트일)', compared, res.bars.length - 2)
  check(`이벤트일 제외 전 구간 수익률 동일 (최대 상대오차 ${worst.toExponential(2)})`, worst < 1e-12)

  // 이벤트일 자신은 **달라야** 한다 — 그게 보정의 목적이다(가짜 −98% 제거)
  const evPos = rows.findIndex((r) => r[0] === 30)
  const adjRet = res.bars[evPos].c / res.bars[evPos - 1].c
  const rawRet = raw[evPos].c / raw[evPos - 1].c
  check(`이벤트일 원주가 수익률은 붕괴한다 (${(rawRet * 100 - 100).toFixed(1)}%)`, rawRet < 0.1)
  check(`보정 후 이벤트일 수익률은 정상 범위 (${(adjRet * 100 - 100).toFixed(1)}%)`, adjRet > 0.8 && adjRet < 1.25)
  closeTo('보정 수익률 = 원주가 수익률 × 주식수비율', adjRet, rawRet * 50, 1e-9)

  // OHLC 전부 같은 계수로 스케일된다 — 고저가만 안 맞으면 손절 판정이 틀어진다
  let ohlcOk = true
  for (let i = 0; i < res.bars.length; i++) {
    const k = res.bars[i].c / raw[i].c
    if (Math.abs(res.bars[i].o / raw[i].o - k) > 1e-12) ohlcOk = false
    if (Math.abs(res.bars[i].h / raw[i].h - k) > 1e-12) ohlcOk = false
    if (Math.abs(res.bars[i].l / raw[i].l - k) > 1e-12) ohlcOk = false
  }
  check('O/H/L/C가 같은 계수로 스케일된다', ohlcOk)
  check('보정 후에도 고가 ≥ 종가 ≥ 저가', res.bars.every((b) => b.h >= b.c && b.c >= b.l))
  eq('rawClose에 원주가를 남긴다', res.bars[0].rawClose, rows[0][4])
  eq('날짜가 달력과 일치', res.bars[5].date, cal[5])
  eq('거래량 미수집이면 v=0', res.bars[0].v, 0)

  // 분할이 두 번 있어도 누적이 맞아야 한다
  const cal2 = calendarOf(90)
  const s2 = makeSeries(90, { seed: 3 })
  for (let i = 30; i < 90; i++) {
    s2.rows[i] = [i, s2.rows[i][1] / 10, s2.rows[i][2] / 10, s2.rows[i][3] / 10, s2.rows[i][4] / 10]
    s2.shares[i] = s2.shares[i] * 10
  }
  for (let i = 60; i < 90; i++) {
    s2.rows[i] = [i, s2.rows[i][1] / 5, s2.rows[i][2] / 5, s2.rows[i][3] / 5, s2.rows[i][4] / 5]
    s2.shares[i] = s2.shares[i] * 5
  }
  const st2 = stockOf('000660', s2.rows, s2.shares, cal2)
  const ix2 = indexOf(cal2, [entryOf('000660', s2.rows, cal2, st2.events.length)])
  const r2 = krxDailyBars(ix2, st2)
  const raw2 = krxDailyRawBars(ix2, st2)
  eq('분할 2건 검출', r2.applied.length, 2)
  closeTo('첫 구간 누적 계수 = 1/(10×5)', r2.bars[0].c / raw2[0].c, 1 / 50, 1e-12)
  closeTo('두 번째 구간 계수 = 1/5', r2.bars[40].c / raw2[40].c, 1 / 5, 1e-12)
  eq('마지막 구간은 계수 1', r2.bars[80].c / raw2[80].c, 1)
  const ev2 = new Set(r2.applied.map((e) => e.idx))
  let worst2 = 0
  for (let i = 1; i < r2.bars.length; i++) {
    if (ev2.has(s2.rows[i][0])) continue
    worst2 = Math.max(worst2, Math.abs((r2.bars[i].c / r2.bars[i - 1].c) / (raw2[i].c / raw2[i - 1].c) - 1))
  }
  check(`분할 2건에서도 수익률 보존 (최대 오차 ${worst2.toExponential(2)})`, worst2 < 1e-12)
}

// ================================== 4) 저신뢰·유상증자형은 기본 미보정 + 드러난다

section('4) 미보정 이벤트를 숨기지 않는다')
{
  const cal = calendarOf(40)
  const { rows, shares } = makeSeries(40, { seed: 5 })
  // idx 20에 30% 유상증자(가격 연속) — 보정 대상이 아니다
  for (let i = 20; i < 40; i++) shares[i] = Math.round(shares[i] * 1.3)
  const stock = stockOf('068270', rows, shares, cal)
  const index = indexOf(cal, [entryOf('068270', rows, cal, stock.events.length)])
  const res = krxDailyBars(index, stock)
  eq('유상증자형 1건 검출', stock.events.length, 1)
  eq('보정 0건', res.applied.length, 0)
  eq('미보정 1건이 결과에 남는다', res.skipped.length, 1)
  check('미보정 사실이 notes로 나온다', res.notes.some((n) => n.includes('미보정')))
  let same = true
  for (let i = 0; i < res.bars.length; i++) if (res.bars[i].c !== rows[i][4]) same = false
  check('보정 대상이 없으면 가격이 원주가 그대로', same)

  // 저신뢰(low) 분할 후보 — 기본은 미보정, 옵션을 켜면 보정
  const cal2 = calendarOf(40)
  const s2 = makeSeries(40, { seed: 9 })
  const at = 20
  const k = 1.02
  for (let i = at; i < 40; i++) {
    s2.rows[i] = [i, s2.rows[i][1] / k, s2.rows[i][2] / k, s2.rows[i][3] / k, s2.rows[i][4] / k]
    s2.shares[i] = Math.round(s2.shares[i] * k)
  }
  // 이벤트일 가격을 직전일의 정확히 1/k로 둔다 — 가격비가 주식수비와 딱 맞는(=가장 헷갈리는)
  // 상황을 만들어야 "소폭이면 맞아도 low"라는 규칙이 실제로 걸리는지 검증할 수 있다.
  s2.rows[at] = [at, s2.rows[at - 1][1] / k, s2.rows[at - 1][2] / k, s2.rows[at - 1][3] / k, s2.rows[at - 1][4] / k]
  const st2 = stockOf('035720', s2.rows, s2.shares, cal2)
  const ix2 = indexOf(cal2, [entryOf('035720', s2.rows, cal2, st2.events.length)])
  eq('소폭 변화는 low로 기록된다', st2.events[0]?.confidence, 'low')
  eq('기본은 미보정', krxDailyBars(ix2, st2).applied.length, 0)
  eq('옵션을 켜면 보정', krxDailyBars(ix2, st2, { applyLowConfidence: true }).applied.length, 1)
}

// ======================================================= 5) 스키마 파서 — 거부

section('5) index.json / prices 스키마 — 결측·모순을 거부한다')
{
  const cal = calendarOf(10)
  const { rows, shares } = makeSeries(10, { seed: 2 })
  const good = {
    schema: KRX_DAILY_SCHEMA_INDEX,
    version: 1,
    source: 'KRX Open API',
    basis: '일별 단면',
    asOf: '2026-08-03',
    from: cal[0],
    to: cal[9],
    calendar: cal,
    missingDays: [],
    volume: false,
    limits: [...KRX_DAILY_LIMITS],
    stocks: [entryOf('005930', rows, cal, 0)],
  }
  check('정상 index는 통과', parseKrxDailyIndex(good).stocks.length === 1)
  check('schema 불일치 거부', throws(() => parseKrxDailyIndex({ ...good, schema: 'x' })) !== null)
  check('달력 역순 거부', throws(() => parseKrxDailyIndex({ ...good, calendar: [...cal].reverse() })) !== null)
  check('달력 중복 거부', throws(() => parseKrxDailyIndex({ ...good, calendar: [cal[0], cal[0], ...cal.slice(1)] })) !== null)
  check('from이 달력 첫날과 다르면 거부', throws(() => parseKrxDailyIndex({ ...good, from: '2019-01-01' })) !== null)
  check('종목 코드 중복 거부', throws(() => parseKrxDailyIndex({ ...good, stocks: [good.stocks[0], good.stocks[0]] })) !== null)
  check('file 경로 규약 위반 거부', throws(() => parseKrxDailyIndex({ ...good, stocks: [{ ...good.stocks[0], file: 'x.json' }] })) !== null)
  check('limits를 비우면 거부(한계 표기 삭제 방지)', throws(() => parseKrxDailyIndex({ ...good, limits: [] })) !== null)
  check('volume 누락 거부', throws(() => parseKrxDailyIndex({ ...good, volume: undefined })) !== null)

  const st = stockOf('005930', rows, shares, cal)
  check('정상 prices는 통과', parseKrxDailyStock(st, cal.length).rows.length === 10)
  check('OHLC 0 거부', throws(() => parseKrxDailyStock({ ...st, rows: [[0, 0, 0, 0, 0], ...rows.slice(1)] }, cal.length)) !== null)
  check('고저가가 시종가를 감싸지 않으면 거부', throws(() => parseKrxDailyStock({ ...st, rows: [[0, 100, 90, 80, 95], ...rows.slice(1)] }, cal.length)) !== null)
  check('인덱스 역순 거부', throws(() => parseKrxDailyStock({ ...st, rows: [...rows].reverse() }, cal.length)) !== null)
  check('달력 범위 초과 인덱스 거부', throws(() => parseKrxDailyStock({ ...st, rows: [...rows.slice(0, 9), [999, 1, 1, 1, 1]] }, cal.length)) !== null)
  check('shares 첫 원소가 첫 봉이 아니면 거부', throws(() => parseKrxDailyStock({ ...st, shares: [[3, 1000]] }, cal.length)) !== null)
  check("adjustment가 'raw'가 아니면 거부", throws(() => parseKrxDailyStock({ ...st, adjustment: 'split' }, cal.length)) !== null)
  check('dividendAdjusted=true 거부 (배당은 보정되지 않는다)', throws(() => parseKrxDailyStock({ ...st, dividendAdjusted: true }, cal.length)) !== null)
  check(
    'shareChange인데 factor≠1이면 거부',
    throws(() =>
      parseKrxDailyStock(
        {
          ...st,
          events: [
            { date: cal[3], idx: 3, kind: 'shareChange', sharesBefore: 1, sharesAfter: 2, ratio: 2, impliedRatio: 2, factor: 2, confidence: 'high', note: '' },
          ],
        },
        cal.length,
      ),
    ) !== null,
  )
  check(
    '시세에 없는 날을 가리키는 이벤트 거부',
    throws(() =>
      parseKrxDailyStock(
        {
          ...st,
          events: [
            { date: cal[9], idx: 9999, kind: 'split', sharesBefore: 1, sharesAfter: 2, ratio: 2, impliedRatio: 2, factor: 2, confidence: 'high', note: '' },
          ],
        },
        cal.length,
      ),
    ) !== null,
  )
}

// ================================================= 6) 월별 유니버스 스키마·접근자

section('6) monthly-universe.json — 순위 빈틈·결측 은닉을 거부한다')
{
  const side = (codes: string[]) => codes.map((c, i) => ({ code: c, name: `종목${c}`, rank: i + 1, capEok: 1000 - i }))
  const good = {
    schema: KRX_DAILY_SCHEMA_MONTHLY,
    version: 1,
    source: 'KRX Open API',
    basis: '매월 첫 거래일 시총 상위',
    asOf: '2026-08-03',
    topN: 2,
    missingMonths: ['2020-02'],
    months: {
      '2020-01': { date: '2020-01-02', kospi: side(['005930', '000660']), kosdaq: side(['247540', '086520']) },
      '2020-03': { date: '2020-03-02', kospi: side(['005930', '035420']), kosdaq: side(['247540', '091990']) },
    },
  }
  const u = parseKrxMonthlyUniverse(good)
  eq('두 달 통과', Object.keys(u.months).length, 2)
  eq('그 달 코드 = 코스피 먼저 + 코스닥', krxMonthlyCodes(u, '2020-01', 2).join(','), '005930,000660,247540,086520')
  eq('topN 절단', krxMonthlyCodes(u, '2020-01', 1).join(','), '005930,247540')
  eq('없는 달은 빈 배열', krxMonthlyCodes(u, '2020-02', 2).length, 0)
  eq('합집합', krxMonthlyUnion(u, 2).join(','), '000660,005930,035420,086520,091990,247540')

  check(
    '결측 월을 missingMonths에 안 적으면 거부',
    throws(() => parseKrxMonthlyUniverse({ ...good, missingMonths: [] })) !== null,
  )
  check(
    'missingMonths와 months에 동시에 있으면 거부',
    throws(() => parseKrxMonthlyUniverse({ ...good, missingMonths: ['2020-01', '2020-02'] })) !== null,
  )
  check(
    '순위 빈틈 거부',
    throws(() =>
      parseKrxMonthlyUniverse({
        ...good,
        months: { ...good.months, '2020-01': { ...good.months['2020-01'], kospi: [{ code: '005930', name: 'x', rank: 2, capEok: 1 }] } },
      }),
    ) !== null,
  )
  check(
    '시장을 가로지르는 중복 종목 거부',
    throws(() =>
      parseKrxMonthlyUniverse({
        ...good,
        months: { ...good.months, '2020-01': { ...good.months['2020-01'], kosdaq: side(['005930', '086520']) } },
      }),
    ) !== null,
  )
  check(
    'date가 그 달이 아니면 거부',
    throws(() => parseKrxMonthlyUniverse({ ...good, months: { ...good.months, '2020-01': { ...good.months['2020-01'], date: '2019-12-30' } } })) !== null,
  )
}

// ================================================== 7) 정직성 라벨 (규칙 3 집행)

section('7) 배당 미반영·거래량 미수집 라벨이 코드에서 사라지지 않는다')
{
  check('배지에 배당 미반영이 있다', KRX_DAILY_BADGE.includes('배당 미반영'))
  check('한계 목록에 배당 미반영이 있다', KRX_DAILY_LIMITS.some((l) => l.includes('배당 미반영')))
  check('한계 목록에 2010년 이전 부재가 있다', KRX_DAILY_LIMITS.some((l) => l.includes('2010')))
  check('한계 목록에 자체 산출 사실이 있다', KRX_DAILY_LIMITS.some((l) => l.includes('자체 산출')))

  const cal = calendarOf(5)
  const { rows, shares } = makeSeries(5, { seed: 1 })
  const st = stockOf('005930', rows, shares, cal)
  const ix = indexOf(cal, [entryOf('005930', rows, cal, 0)])
  const note = krxDailySourceNote(ix)
  check('출처 한 줄에 배당 미반영이 있다', note.includes('배당 미반영'))
  check('출처 한 줄에 기간·종목수가 있다', note.includes(cal[0]) && note.includes('1종목'))
  check('notes에 거래량 미수집 경고가 있다', krxDailyBars(ix, st).notes.some((n) => n.includes('거래량 미수집')))
}

finish()
