// MODE=krxscreen (35차) — 비모멘텀 6계열 KRX 실측 재검증. 변형 매트릭스 산술 ·
// **훅 재사용 강제** · 유니버스 주입 규약 · 판정 프레임 공유 검증.
//
// 이 파일이 막는 사고는 네 가지다.
//
//   ① **변형 수가 조용히 달라지는 것.** 지시로 못 박은 상한은 20(10+10 12 · 40+40 8)이다.
//      하나라도 늘거나 줄면 다중검정 경고의 분모가 거짓이 되고, 그 위에서 계산한 p값도
//      거짓이 된다. 계열을 하나 더 끼워 넣고 싶은 유혹이 가장 흔한 실패 경로다.
//   ② **이 모드가 지표·임계를 "다시 정의"하는 것.** 이번 회차의 전부는 "검증된 경로의
//      유니버스만 교체"다. 랭킹 함수와 게이트 임계가 `SCREEN_FAMILIES`에서 온 그 객체가
//      아니라 복사본이면, 28차와 다른 전략을 28차 이름으로 부르는 셈이 된다. 그래서
//      **참조 동일성(identity)** 까지 본다 — 값이 같은 복사본은 통과시키지 않는다.
//   ③ **주입된 유니버스가 다른 코드 경로를 타는 것.** krxscreen 변형의 성적이 28차·25차
//      훅을 직접 부른 결과와 **점 단위로 같아야** 한다. 다르면 어딘가에 새 경로가 생긴
//      것이고, 그 경로는 기존 미래참조 집행자의 사정거리 밖이다.
//   ④ **판정 프레임이 34차와 갈라지는 것.** 칼마 정렬·탈락 사유·벽 넘김 판정은 34차
//      함수를 그대로 불러야 두 회차 표가 나란히 읽힌다.
//
// ⚠️ 미래참조 금지(규칙 1)와의 관계 — **새 지표·새 시뮬레이터가 없다.** krxscreen은
//    simulateRankYear / simulateRsiRevYear / simulateVolBrkYear를 그대로 부르고 유니버스와
//    슬롯만 바꾼다. 그 세 경로의 절단 불변성은 `tests/screen.test.ts`·`tests/idealab.test.ts`가
//    이미 집행한다. 여기서는 **"정말 그 경로를 타는가"** 를 ③으로 확인하고, 더해
//    연쇄가 해를 넘어 정보를 흘리지 않는지(연도 독립성)를 직접 본다.
//
// 네트워크를 타지 않는다(컨테이너에서 Yahoo는 403).

import { check, eq, section, finish, rng } from './harness'
import {
  CAL_SPACE_NOTE_KRXCAL,
  CAL_SPACE_NOTE_KRXSCREEN,
  HI52_GATE,
  KRXPIT_HALF,
  KRXSCREEN_MIN_TRADES,
  KRXSCREEN_NARROW_SLOTS,
  KRXSCREEN_RSIREV,
  KRXSCREEN_VOLBRK_EXIT,
  KRXSCREEN_VOLBRK_K,
  KRXSCREEN_WIDE_SLOTS,
  MAX_POSITIONS,
  RSIREV_DEFAULT,
  SCREEN_FAMILIES,
  SCREEN_MIN_TRADES,
  VOLRANK_GATE,
  benchCurve,
  buildYearly,
  halfSpanLabel,
  calFailReasons,
  calHeadline,
  calPassSummary,
  calRankTable,
  calmarSort,
  krxscreenAllDefs,
  krxscreenDefs,
  krxscreenHeadlineTable,
  krxscreenUniverse,
  runCustomChain,
  runKrxScreenDef,
  screenGateLabel,
  screenGateVariant,
  simulateRankYear,
  simulateRsiRevYear,
  simulateVolBrkYear,
  summarizeStrat,
  wallOf,
  type KrxScreenDef,
  type RankRow,
} from '../scripts/idea-lab.entry'
import type { CostSettings } from '../src/features/backtest/conditionScreen'
import type { DailyBar } from '../src/features/backtest/types'

const COST: CostSettings = { initialCapital: 10_000_000, feePct: 0.015, taxPct: 0.15, slippagePct: 0.1 }

/** 표 출력을 가로채 문자열로 받는다 — 표가 던지지 않는지, 문구가 나오는지 본다. */
function capture(fn: () => void): string[] {
  const out: string[] = []
  const orig = console.log
  console.log = (...args: unknown[]) => {
    out.push(args.map(String).join(' '))
  }
  try {
    fn()
  } finally {
    console.log = orig
  }
  return out
}

/** 합성 일봉 — 주말을 건너뛴 거래일 근사(엔진은 달력을 데이터에서 만든다). */
function makeBars(seed: number, from: string, toYear: number, base = 50_000): DailyBar[] {
  const rnd = rng(seed)
  const bars: DailyBar[] = []
  let p = base
  const start = Date.parse(`${from}T00:00:00Z`)
  const end = Date.UTC(toYear + 1, 0, 1)
  for (let t = start; t < end; t += 86400000) {
    const d = new Date(t)
    const dow = d.getUTCDay()
    if (dow === 0 || dow === 6) continue
    const ret = 0.0005 + 0.025 * (rnd() * 2 - 1)
    const o = p
    const c = Math.max(1, p * (1 + ret))
    bars.push({
      date: d.toISOString().slice(0, 10),
      t: Math.floor(t / 1000),
      o,
      h: Math.max(o, c) * (1 + rnd() * 0.012),
      l: Math.min(o, c) * (1 - rnd() * 0.012),
      c,
      v: 400_000 + Math.floor(rnd() * 2_000_000),
    })
    p = c
  }
  return bars
}

const row = (aux: number): RankRow => ({ sym: '000000', score: 0, aux })

// ── 1) 변형 매트릭스 산술 — 20개 상한 ────────────────────────────────────────
{
  section('1) 변형 매트릭스 — 10+10 12 · 40+40 8 = 20 (지시 상한)')

  const d10 = krxscreenDefs(10)
  const d40 = krxscreenDefs(40)
  const all = krxscreenAllDefs()

  eq('10+10은 12변형', d10.length, 12)
  eq('40+40은 8변형', d40.length, 8)
  eq('총 20변형 — 다중검정 분모', all.length, 20)
  eq('전체 목록은 두 폭을 이어 붙인 것', all.map((d) => d.label).join('|'), [...d10, ...d40].map((d) => d.label).join('|'))
  eq('라벨이 전부 다르다(같은 줄이 두 번 세어지지 않는다)', new Set(all.map((d) => d.label)).size, 20)
  check('각 변형의 top이 자기 폭과 일치', d10.every((d) => d.top === 10) && d40.every((d) => d.top === 40))

  eq('랭킹 계열은 폭당 8행(4계열 × 2)', d10.filter((d) => d.group === '랭킹').length, 8)
  eq('40+40은 전부 랭킹 계열', d40.filter((d) => d.group === '랭킹').length, 8)
  eq('rsirev는 10+10에만 2행', d10.filter((d) => d.group === 'rsirev').length, 2)
  eq('volbrk는 10+10에만 2행', d10.filter((d) => d.group === 'volbrk').length, 2)
  eq('40+40에 rsirev 없음(신호 임계 전략이라 분위 질문에 답하지 않는다)', d40.filter((d) => d.group === 'rsirev').length, 0)
  eq('40+40에 volbrk 없음', d40.filter((d) => d.group === 'volbrk').length, 0)

  // 계열별 구성 — 28차 유보("20종목이라 상위5 = 25% 분위")를 직접 검증하는 배치인가
  for (const fam of SCREEN_FAMILIES) {
    const n = d10.filter((d) => d.label.startsWith(`${fam.key} `))
    const w = d40.filter((d) => d.label.startsWith(`${fam.key} `))
    eq(`${fam.key}: 10+10 2변형`, n.length, 2)
    eq(`${fam.key}: 40+40 2변형`, w.length, 2)
    eq(`${fam.key}: 10+10은 N=5 두 줄`, n.map((d) => d.slots).join(','), `${KRXSCREEN_NARROW_SLOTS},${KRXSCREEN_NARROW_SLOTS}`)
    check(`${fam.key}: 10+10 첫 줄은 게이트 없음`, n[0].keep === undefined, String(n[0].keep))
    check(`${fam.key}: 10+10 둘째 줄은 게이트 있음`, n[1].keep !== undefined)
    eq(`${fam.key}: 40+40 슬롯은 16·8(20%·10% 분위)`, w.map((d) => d.slots).join(','), KRXSCREEN_WIDE_SLOTS.join(','))
    check(`${fam.key}: 40+40은 두 줄 다 게이트 on`, w.every((d) => d.keep !== undefined))
  }

  eq('volbrk k는 0.5·0.7', d10.filter((d) => d.group === 'volbrk').map((d) => d.volbrkK).join(','), KRXSCREEN_VOLBRK_K.join(','))
  check('volbrk 슬롯은 기존 규약대로 MAX_POSITIONS', d10.filter((d) => d.group === 'volbrk').every((d) => d.slots === MAX_POSITIONS))
  eq('volbrk 청산은 당일 종가 고정(원저 데이트레이드형)', KRXSCREEN_VOLBRK_EXIT, 'close')
  eq('rsirev 2변형', KRXSCREEN_RSIREV.length, 2)
  eq('표본 소실 판정선은 28·34차와 같은 값', KRXSCREEN_MIN_TRADES, SCREEN_MIN_TRADES)
  eq('그 값은 20', KRXSCREEN_MIN_TRADES, 20)

  // 전·후반 길이는 **실제로 돈 해의 수**에서 만든다 — 상수를 찍으면 표본이 실제보다 커 보인다
  eq('17년이면 전·후반 8~9년', halfSpanLabel(17), '8~9')
  eq('짝수 구간은 한 숫자로', halfSpanLabel(6), '3')
  eq('1년짜리도 깨지지 않는다', halfSpanLabel(1), '0~1')
}

// ── 2) 훅 재사용 강제 — 새 지표·새 임계를 만들지 않았는가 ────────────────────
{
  section('2) 재사용 강제 — 랭킹 함수·게이트가 SCREEN_FAMILIES **그 객체**인가')

  const d10 = krxscreenDefs(10)
  const d40 = krxscreenDefs(40)

  for (const fam of SCREEN_FAMILIES) {
    const gate = screenGateVariant(fam)
    const mine = [...d10, ...d40].filter((d) => d.label.startsWith(`${fam.key} `))
    check(`${fam.key}: 랭킹 함수가 SCREEN_FAMILIES의 참조 그대로(복사본 아님)`, mine.every((d) => d.rank === fam.rank))
    check(
      `${fam.key}: 게이트가 28차 변형의 참조 그대로(임계를 다시 쓰지 않았다)`,
      mine.filter((d) => d.keep).every((d) => d.keep === gate.keep),
    )
    eq(`${fam.key}: 게이트 변형의 슬롯은 5(28차 설정)`, gate.slots, KRXSCREEN_NARROW_SLOTS)
  }

  // 게이트 라벨은 28차 라벨에서 접두만 뗀 것이어야 한다(문구를 새로 쓰면 보고서가 갈라진다)
  eq('lowvol 게이트 라벨', screenGateLabel(SCREEN_FAMILIES[0]), '절대모멘텀 게이트')
  eq('hi52 게이트 라벨', screenGateLabel(SCREEN_FAMILIES[1]), `근접도 ${HI52_GATE} 이상`)
  eq('strev 게이트 라벨', screenGateLabel(SCREEN_FAMILIES[2]), '실제 하락분만')
  eq('volrank 게이트 라벨', screenGateLabel(SCREEN_FAMILIES[3]), `급증비 ${VOLRANK_GATE}배 이상`)

  // 임계 자체가 28차 값인지 — 술어를 경계에서 직접 찔러 본다(상수만 보면 배선 오류를 못 잡는다)
  const gLow = screenGateVariant(SCREEN_FAMILIES[0]).keep!
  check('lowvol 게이트: 절대모멘텀 0은 통과, 음수는 탈락', gLow(row(0)) && !gLow(row(-0.001)))
  const gHi = screenGateVariant(SCREEN_FAMILIES[1]).keep!
  check(`hi52 게이트: 근접도 ${HI52_GATE} 경계 포함`, gHi(row(HI52_GATE)) && !gHi(row(HI52_GATE - 0.001)))
  const gRev = screenGateVariant(SCREEN_FAMILIES[2]).keep!
  check('strev 게이트: 실제로 빠진 것만(0 포함, 상승 제외)', gRev(row(0)) && gRev(row(-0.1)) && !gRev(row(0.001)))
  const gVol = screenGateVariant(SCREEN_FAMILIES[3]).keep!
  check(`volrank 게이트: 급증비 ${VOLRANK_GATE} 경계 포함`, gVol(row(VOLRANK_GATE)) && !gVol(row(VOLRANK_GATE - 0.001)))

  // rsirev 2변형은 25차 본안과 그 A/B다 — 임계를 새로 고른 것이 아니다
  check('rsirev 본안은 RSIREV_DEFAULT 그 객체', KRXSCREEN_RSIREV[0].opts === RSIREV_DEFAULT)
  const ab = KRXSCREEN_RSIREV[1].opts
  eq('A/B 변형은 추세필터만 뗀다 — 진입 임계 동일', ab.lowThr, RSIREV_DEFAULT.lowThr)
  eq('A/B 변형은 청산 임계 동일', ab.highThr, RSIREV_DEFAULT.highThr)
  eq('A/B 변형은 보유일 상한 동일', ab.maxHold, RSIREV_DEFAULT.maxHold)
  eq('A/B 변형은 RSI 기간 동일', ab.period, RSIREV_DEFAULT.period)
  eq('A/B 변형만 추세필터 0', ab.trendMa, 0)
  check('본안은 200일선 필터를 그대로 쓴다', RSIREV_DEFAULT.trendMa === 200)

  // 계열당 게이트 변형이 1개라는 28차 규약이 깨지면 조용히 다른 임계를 쓰지 않고 던져야 한다
  let threw = false
  try {
    screenGateVariant({ ...SCREEN_FAMILIES[0], variants: [] })
  } catch {
    threw = true
  }
  check('게이트 변형이 없으면 던진다(조용히 게이트 없이 돌지 않는다)', threw)
  threw = false
  try {
    screenGateVariant({ ...SCREEN_FAMILIES[0], variants: [...SCREEN_FAMILIES[0].variants, SCREEN_FAMILIES[0].variants[2]] })
  } catch {
    threw = true
  }
  check('게이트 변형이 둘이면 던진다(어느 쪽을 쓸지 추측하지 않는다)', threw)
}

// ── 3) 유니버스 주입 — 기존 훅과 **점 단위로 같은 결과**인가 ─────────────────
{
  section('3) krxscreenUniverse — 주입된 실측 유니버스가 28차·25차와 같은 경로를 타는가')

  const CODES = ['400010', '400020', '400030', '400040', '400050', '400060', '400070', '400080']
  const H: Record<string, DailyBar[]> = {}
  CODES.forEach((cd, i) => {
    H[cd] = makeBars(20260803 + i * 137, '2009-01-01', 2013, 20_000 + i * 2_500)
  })
  const benchEq = benchCurve(makeBars(4242, '2009-01-01', 2013, 30_000))
  const YEARS = [2011, 2012, 2013]
  // KRX 실측 주입 자리와 **같은 형태**의 codesFor — 33·34차와 같은 한 자리다
  const yearly = buildYearly(H, YEARS, () => CODES)

  const res = krxscreenUniverse({ top: 10, yearly, benchEq, cost: COST })
  eq('10+10 유니버스에서 12행이 나온다', res.variants.length, 12)
  check('실행 구간(span)이 나온다', res.span != null && res.span[0] < res.span[1], JSON.stringify(res.span))
  check('전 행의 CAGR이 유한하다', res.variants.every((v) => Number.isFinite(v.row.full.cagr)))
  check('연도별 분해가 연도 수만큼 있다', res.variants.every((v) => v.row.perYear.length === YEARS.length))
  check('합성 행이 하나도 없다(전부 자기 매매 원장을 가진다)', res.variants.every((v) => !v.synth))
  check('전·후반 분할은 34차와 같은 2018 규약', KRXPIT_HALF === 2018)

  const wide = krxscreenUniverse({ top: 40, yearly, benchEq, cost: COST })
  eq('40+40 유니버스에서 8행이 나온다', wide.variants.length, 8)

  // ---- 경로 동일성: 랭킹 계열 -------------------------------------------------
  const fam = SCREEN_FAMILIES[0] // lowvol
  const gate = screenGateVariant(fam)
  const mineGated = krxscreenDefs(10).find((d) => d.label === `${fam.key} 상위${gate.slots} + ${screenGateLabel(fam)}`)!
  const got = runKrxScreenDef(mineGated, yearly, benchEq, COST).variant
  // 28차가 부르는 그대로를 여기서 다시 조립한다 — 두 결과가 다르면 새 경로가 생긴 것이다
  const direct = runCustomChain(
    yearly,
    (v) => simulateRankYear(v.hist, `${v.y}-01-01`, v.syms, COST, { slots: gate.slots, rank: fam.rank, keep: gate.keep }),
    COST,
    gate.slots,
  )
  const expect = summarizeStrat(mineGated.label, direct, benchEq, KRXPIT_HALF)
  eq('랭킹 계열 총수익이 28차 훅 직접 호출과 동일', got.row.full.total, expect.full.total)
  eq('랭킹 계열 MDD 동일', got.row.full.mdd, expect.full.mdd)
  eq('랭킹 계열 CAGR 동일', got.row.full.cagr, expect.full.cagr)
  eq('랭킹 계열 매매수 동일', got.trades, direct.closed)
  eq(
    '랭킹 계열 연도별 배수까지 동일',
    got.row.perYear.map((p) => p.ret).join(','),
    expect.perYear.map((p) => p.ret).join(','),
  )

  // ---- 경로 동일성: rsirev ----------------------------------------------------
  const rsiDef = krxscreenDefs(10).find((d) => d.group === 'rsirev')!
  const rsiGot = runKrxScreenDef(rsiDef, yearly, benchEq, COST).variant
  const rsiDirect = runCustomChain(
    yearly,
    (v) => simulateRsiRevYear(v.hist, `${v.y}-01-01`, v.syms, COST, rsiDef.rsi!),
    COST,
    rsiDef.slots,
  )
  eq('rsirev 총수익이 25차 훅 직접 호출과 동일', rsiGot.row.full.total, summarizeStrat('x', rsiDirect, benchEq, KRXPIT_HALF).full.total)
  eq('rsirev 매매수 동일', rsiGot.trades, rsiDirect.closed)

  // ---- 경로 동일성: volbrk ----------------------------------------------------
  const vbDef = krxscreenDefs(10).find((d) => d.group === 'volbrk')!
  const vbGot = runKrxScreenDef(vbDef, yearly, benchEq, COST).variant
  const vbDirect = runCustomChain(
    yearly,
    (v) =>
      simulateVolBrkYear(v.hist, `${v.y}-01-01`, v.syms, COST, {
        k: vbDef.volbrkK!,
        exit: KRXSCREEN_VOLBRK_EXIT,
        slots: vbDef.slots,
      }),
    COST,
    vbDef.slots,
  )
  eq('volbrk 총수익이 25차 훅 직접 호출과 동일', vbGot.row.full.total, summarizeStrat('x', vbDirect, benchEq, KRXPIT_HALF).full.total)
  eq('volbrk 매매수 동일', vbGot.trades, vbDirect.closed)

  // ---- 유니버스 폭이 실제로 성적을 바꾸는가(주입이 먹히는지 역확인) ------------
  const NARROW = CODES.slice(0, 5)
  const yearlyNarrow = buildYearly(H, YEARS, () => NARROW)
  const narrowRes = krxscreenUniverse({ top: 10, yearly: yearlyNarrow, benchEq, cost: COST })
  check(
    '유니버스를 좁히면 성적이 달라진다 — codesFor 주입이 실제로 먹힌다',
    narrowRes.variants.some((v, i) => v.row.full.total !== res.variants[i].row.full.total),
  )

  // ---- 연도 독립성: 뒤 해를 붙여도 앞 해의 성적이 안 바뀐다(연쇄 누수 차단) ----
  const short = buildYearly(H, [2011, 2012], () => CODES)
  const shortRes = krxscreenUniverse({ top: 10, yearly: short, benchEq, cost: COST })
  check(
    '2013년을 떼어내도 2011·2012 연도 배수가 그대로다(미래 정보가 앞 해로 새지 않는다)',
    shortRes.variants.every((v, i) =>
      v.row.perYear.every((p, k) => p.ret === res.variants[i].row.perYear[k].ret),
    ),
  )
}

// ── 4) 판정 프레임이 34차와 같은 함수인가 ────────────────────────────────────
{
  section('4) 판정·헤드라인 — 34차 함수를 그대로 부르는가')

  const CODES = ['400010', '400020', '400030', '400040', '400050', '400060']
  const H: Record<string, DailyBar[]> = {}
  CODES.forEach((cd, i) => {
    H[cd] = makeBars(777 + i * 91, '2009-01-01', 2012, 15_000 + i * 3_000)
  })
  const benchEq = benchCurve(makeBars(31337, '2009-01-01', 2012, 25_000))
  const YEARS = [2011, 2012]
  const yearly = buildYearly(H, YEARS, () => CODES)
  const { variants, span } = krxscreenUniverse({ top: 40, yearly, benchEq, cost: COST })

  const [FROM, TO] = span ?? ['2011-01-01', '2012-12-31']
  const wall = wallOf('QQQ 원화 보유', benchEq, FROM, TO)

  const lines = capture(() => calRankTable('테스트 순위', variants, wall, KRXSCREEN_MIN_TRADES))
  const rows = lines.filter((l) => /^\| \d+ \|/.test(l))
  eq('순위표 데이터 행 수 = 변형 수', rows.length, variants.length)
  check('벽 열이 붙는다', lines.some((l) => l.includes('QQQ 원화 보유 벽')), lines[1] ?? '')
  check('전·후반 분할 연도가 34차와 같다(헤더에 2018)', lines.some((l) => l.includes(`전반(~${KRXPIT_HALF - 1})`)))
  check('계열 열에 랭킹이 찍힌다', rows.every((l) => l.includes('| 랭킹 |')), rows[0])

  // 판정선이 krxscreen 값으로 전달되는가 — 기본값(34차)이 아니라 인자를 쓰는지 본다
  const sorted = calmarSort(variants)
  const thin = { ...sorted[0], trades: KRXSCREEN_MIN_TRADES - 1 }
  check('매매수가 기준 미만이면 탈락 사유에 "매매"가 남는다', calFailReasons(thin, KRXSCREEN_MIN_TRADES).includes('매매'))
  check('기준과 같으면 매매 사유 없음(경계 포함)', !calFailReasons({ ...sorted[0], trades: KRXSCREEN_MIN_TRADES }, KRXSCREEN_MIN_TRADES).includes('매매'))

  let over = -1
  const headOut = capture(() => {
    over = calHeadline('실측 40+40', sorted, wall, KRXSCREEN_MIN_TRADES, CAL_SPACE_NOTE_KRXSCREEN)
  })
  check('헤드라인이 던지지 않고 숫자를 돌려준다', over >= 0, String(over))
  check('벽을 넘은 게 없으면 "없다"를 크게 쓴다', over > 0 || headOut.some((l) => l.includes('**없다.**')), headOut.join(' / '))

  // 탐색 공간 문단이 **이 모드의 것**인가 — 34차 기본값을 그대로 쓰면
  // "조건식 격자·xsmom 분위를 돌렸다"는 거짓 문단이 찍힌다(스모크에서 실제로 그랬다).
  const lowOnly = [{ ...sorted[0], row: { ...sorted[0].row, full: { ...sorted[0].row.full, cagr: -99, mdd: -99 } } }]
  const mine = capture(() => calHeadline('실측 10+10', lowOnly, wall, KRXSCREEN_MIN_TRADES, CAL_SPACE_NOTE_KRXSCREEN))
  check('못 넘었을 때 35차 탐색 공간(비모멘텀 6계열)을 적는다', mine.some((l) => l.includes('비모멘텀 6계열')), mine.join(' / '))
  check('34차 탐색 공간 문구(조건식 격자·xsmom 분위)를 쓰지 않는다', !mine.some((l) => l.includes('조건식 격자·xsmom 분위')))
  const dflt = capture(() => calHeadline('실측 10+10', lowOnly, wall, KRXSCREEN_MIN_TRADES))
  check('기본값은 34차 문단 그대로 — krxcal 출력이 바뀌지 않는다', CAL_SPACE_NOTE_KRXCAL.every((l) => dflt.includes(l)), dflt.join(' / '))
  const passOut = capture(() => calPassSummary('실측 40+40', sorted, KRXSCREEN_MIN_TRADES))
  check('판정 통과 표가 나온다(없으면 "없음"이라 적는다)', passOut.length > 0)

  // 헤드라인 집계표 — 합계가 실제 합인가
  const tbl = capture(() =>
    krxscreenHeadlineTable([
      { key: '실측 10+10', n: 12, pass: 2, over: 1 },
      { key: '실측 40+40', n: 8, pass: 0, over: 0 },
    ]),
  )
  check('합계 행이 붙는다', tbl.some((l) => l.includes('**합계**')), tbl.join(' / '))
  check('변형 합계 20', tbl.some((l) => l.includes('**20**')), tbl.join(' / '))
  check('통과 합계 2', tbl.some((l) => l.includes('| **20** | **2** | **1** |')), tbl.join(' / '))
  check('벽 초과가 판정 통과분만 센다고 명시한다', tbl.some((l) => l.includes('판정까지 통과한 것만')))
}

finish()
