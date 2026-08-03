// 배당 비대칭 제거 집행자 — 연구 러너 4종의 **비교 기준**(ReturnBasis) 규약.
//
// 무엇을 막는가:
//   ① **야후 경로의 조용한 회귀.** `PRICE_SOURCE=yahoo`면 비교 기준이 `'total'`이라 벤치·벽 수치가
//      **한 자리도 달라지면 안 된다.** `fetchDaily`에 `basis` 인자를 끼우면서 계수 산술이 미묘하게
//      달라지면 아무도 모른 채 알파만 바뀐다 — 그래서 가짜 fetch로 **곱해진 값 자체**를 못박는다.
//   ② **기준 누락.** 국내 유니버스가 KRX 정본(가격수익)인데 벤치·벽만 야후 총수익이면 KODEX 200
//      배당수익률만큼 알파가 전략에 불리하게 찍힌다(2026-08-03 이전 전 회차가 그 상태였다).
//      소스에 따라 기준이 자동으로 맞춰지는지, 그리고 **비교 대상 로더가 실제로 그 기준을 타는지**
//      끝까지 확인한다(상수만 맞고 배선이 빠지면 아무것도 안 고쳐진 것이다).
//   ③ **엉뚱한 자산까지 기준을 타는 것.** 환율(KRW=X)은 배당 개념이 없어 무관하고, 자산 슬리브·
//      신호(레짐) 계열은 **비교 대상이 아니라서** 기준을 타면 안 된다 — 타면 전략 행동이 바뀐다.
//   ④ **산출물 표기 유실.** `preset-precompute`는 화면에 뜨는 산출물이라 어느 기준으로 구웠는지
//      파일이 스스로 말해야 하고, **표기가 없는 옛 파일은 `'total'`로 읽혀야** 한다(그게 사실이다).
//
// 규칙 1(미래참조)과의 관계: 이 파일은 **로더와 표기**만 본다. 신호·체결의 절단 불변성은
// `tests/lookahead.test.ts`·각 러너 테스트가 그대로 집행한다 — 기준 도입이 그쪽을 건드리면 안 된다.
//
// ⚠️ 이 변경은 전략을 유리하게 만드는 보정이 아니라 **어느 쪽으로도 기울지 않은 비교**를 만드는
//    것이고, 그래서 결과가 나빠질 수도 있다. 테스트도 "좋아졌는가"가 아니라 "기준이 같은가"만 본다.

import { check, eq, finish, section } from './harness'
import * as shortlab from '../scripts/shortterm-lab.entry'
import * as plateau from '../scripts/plateau-lab.entry'
import * as valuelab from '../scripts/value-lab.entry'
import * as precompute from '../scripts/preset-precompute.entry'
import type { DailyBar } from '../src/features/backtest/types'
import type { CostSettings } from '../src/features/backtest/types'

// ---------------------------------------------------------------- 가짜 야후

/**
 * 야후 chart v8 응답 한 벌. 계수가 **정확히 0.5**가 되도록 값을 골랐다(부동소수 오차 없이
 * 곱셈 결과를 그대로 비교할 수 있다 — "대략 맞다"로는 회귀를 못 잡는다).
 */
const CLOSE = [100, 200]
const ADJ = [50, 100] // adjclose ÷ close = 0.5
const OPEN = [110, 210]
const HIGH = [120, 220]
const LOW = [90, 190]
const VOL = [1000, 2000]
const TS = [Date.UTC(2020, 0, 2) / 1000, Date.UTC(2020, 0, 3) / 1000]

function chartJson(adj: (number | null)[] | null = ADJ): unknown {
  return {
    chart: {
      result: [
        {
          timestamp: TS,
          indicators: {
            quote: [{ open: OPEN, high: HIGH, low: LOW, close: CLOSE, volume: VOL }],
            ...(adj == null ? {} : { adjclose: [{ adjclose: adj }] }),
          },
        },
      ],
    },
  }
}

interface FakeFetch {
  /** 호출된 URL 목록 — 어떤 심볼을 몇 번 불렀는지 본다. */
  urls: string[]
  restore: () => void
}

/** `globalThis.fetch`를 가짜로 바꾼다. 네트워크를 타지 않는다(컨테이너에서 야후는 403이다). */
function stubFetch(adj: (number | null)[] | null = ADJ): FakeFetch {
  const urls: string[] = []
  const orig = globalThis.fetch
  globalThis.fetch = (async (url: unknown) => {
    urls.push(String(url))
    return {
      ok: true,
      status: 200,
      json: async () => chartJson(adj),
    }
  }) as typeof globalThis.fetch
  return {
    urls,
    restore: () => {
      globalThis.fetch = orig
    },
  }
}

/** console.log를 가로챈다 — 머리말·한계 절이 실제로 무엇을 찍는지 본다. */
function capture(fn: () => void): string {
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
  return out.join('\n')
}

/** 봉 한 줄을 비교하기 쉬운 튜플로 — 값이 하나라도 어긋나면 눈에 띈다. */
const tup = (b: DailyBar): string => `${b.o}/${b.h}/${b.l}/${b.c}/${b.v}`

/** 계수 f를 곱한 기대 튜플. f=1이면 원값(가격수익). */
const expected = (i: number, f: number): string =>
  `${OPEN[i] * f}/${HIGH[i] * f}/${LOW[i] * f}/${CLOSE[i] * f}/${VOL[i]}`

// ---------------------------------------------------------------- 공통 규약

/**
 * 러너 하나의 비교 기준 규약을 통째로 검증한다. 네 러너가 **같은 이름·같은 의미**를 갖는지를
 * 한 자리에서 못박는다(러너끼리 import하지 않으므로 규약이 갈라질 여지가 실제로 있다).
 */
interface BasisModule {
  compareBasisFor: (source: 'yahoo' | 'krx') => 'total' | 'price'
  compareBasisNote: (b: 'total' | 'price') => string
  setCompareBasis: (b: 'total' | 'price') => void
  compareBasis: () => 'total' | 'price'
  fetchDaily: (symbol: string, range?: string, basis?: 'total' | 'price') => Promise<DailyBar[]>
}

async function testRunner(name: string, m: BasisModule, fetchCompare: (sym: string) => Promise<DailyBar[]>) {
  section(`${name} — 비교 기준 규약`)

  // ---- 소스 → 기준 매핑 (정본 idea-lab과 같은 의미여야 한다) ----
  eq(`${name}: krx 소스면 벤치·벽도 가격수익`, m.compareBasisFor('krx'), 'price')
  eq(`${name}: yahoo 소스면 둘 다 총수익`, m.compareBasisFor('yahoo'), 'total')

  const p = m.compareBasisNote('price')
  check(`${name}: 가격수익 문구가 "같은 기준"을 말한다`, p.includes('가격수익') && p.includes('같은 기준'), p)
  check(`${name}: 편향이 제거됐음을 명시`, p.includes('편향'), p)
  const t = m.compareBasisNote('total')
  check(`${name}: 총수익 문구는 기준이 같음을 말한다`, t.includes('총수익') && t.includes('기준이 같다'), t)

  // ---- ① 야후 경로 회귀 방지 — 기본값(total)의 산술이 예전 그대로인가 ----
  //
  // 예전 코드: `const f = adj != null && Number.isFinite(adj) && cl > 0 ? adj / cl : 1`
  // 인자를 안 주면 **그 식 그대로**여야 한다. 여기가 깨지면 야후 회차 수치가 조용히 바뀐다.
  {
    const f = stubFetch()
    try {
      const bars = await m.fetchDaily('069500.KS')
      eq(`${name}: 기본값은 총수익 — 2봉`, bars.length, 2)
      eq(`${name}: 기본값 봉[0] = OHLC × (adjclose÷close)`, tup(bars[0]), expected(0, 0.5))
      eq(`${name}: 기본값 봉[1] = OHLC × (adjclose÷close)`, tup(bars[1]), expected(1, 0.5))
      check(`${name}: 거래량은 계수와 무관하게 원값`, bars[0].v === VOL[0] && bars[1].v === VOL[1])

      const same = await m.fetchDaily('069500.KS', undefined, 'total')
      eq(`${name}: 명시 total = 기본값과 완전히 같다`, JSON.stringify(same), JSON.stringify(bars))
    } finally {
      f.restore()
    }
  }

  // ---- ② 가격수익 — 계수를 곱하지 않는다(원 OHLC 그대로) ----
  {
    const f = stubFetch()
    try {
      const bars = await m.fetchDaily('069500.KS', undefined, 'price')
      eq(`${name}: price 봉[0] = 원 OHLC (계수 미적용)`, tup(bars[0]), expected(0, 1))
      eq(`${name}: price 봉[1] = 원 OHLC (계수 미적용)`, tup(bars[1]), expected(1, 1))
      check(`${name}: price가 total보다 배당만큼 높다(계수 0.5의 반대)`, bars[0].c > CLOSE[0] * 0.5)
    } finally {
      f.restore()
    }
  }

  // ---- ③ adjclose가 없거나 못 쓰는 값이면 total도 계수 1 (옛 폴백 보존) ----
  {
    const f = stubFetch(null)
    try {
      const bars = await m.fetchDaily('069500.KS')
      eq(`${name}: adjclose 없음 → total도 계수 1(옛 폴백 그대로)`, tup(bars[0]), expected(0, 1))
    } finally {
      f.restore()
    }
    const g = stubFetch([null, Number.NaN])
    try {
      const bars = await m.fetchDaily('069500.KS')
      eq(`${name}: adjclose가 null/NaN이면 계수 1`, tup(bars[0]), expected(0, 1))
      eq(`${name}: NaN adjclose도 계수 1`, tup(bars[1]), expected(1, 1))
    } finally {
      g.restore()
    }
  }

  // ---- ④ 배선 — **비교 대상 로더**가 실제로 모듈 기준을 타는가 ----
  //
  // 상수(`compareBasisFor`)만 맞고 벤치·벽이 여전히 기본값으로 로드되면 아무것도 안 고쳐진 것이다.
  {
    const before = m.compareBasis()
    try {
      m.setCompareBasis('total')
      eq(`${name}: setCompareBasis(total) 반영`, m.compareBasis(), 'total')
      const f = stubFetch()
      try {
        const bars = await fetchCompare('069500.KS')
        eq(`${name}: 기준 total이면 비교 대상도 총수익(야후 회차 수치 불변)`, tup(bars[0]), expected(0, 0.5))
      } finally {
        f.restore()
      }

      // krx 소스에서 유도한 기준을 그대로 건다 — "krx 경로는 price 기준"의 실제 배선 확인.
      m.setCompareBasis(m.compareBasisFor('krx'))
      eq(`${name}: krx에서 유도한 기준이 price`, m.compareBasis(), 'price')
      const g = stubFetch()
      try {
        const bars = await fetchCompare('069500.KS')
        eq(`${name}: 기준 price면 비교 대상은 가격수익(계수 미적용)`, tup(bars[0]), expected(0, 1))
      } finally {
        g.restore()
      }
    } finally {
      m.setCompareBasis(before)
    }
  }
}

// ============================================================================
async function main(): Promise<void> {
  // ---- 러너 4종 — 같은 이름·같은 의미를 각자 자립적으로 갖는다 ----
  await testRunner('shortterm-lab', shortlab, (s) => shortlab.fetchCompare(s))
  await testRunner('value-lab', valuelab, (s) => valuelab.fetchCompare(s))
  await testRunner('preset-precompute', precompute, (s) => precompute.fetchCompare(s))
  await testRunner('plateau-lab', plateau, async (s) => {
    const tally = plateau.newYahooTally()
    const bars = await plateau.tallyFetchCompare(tally, s)
    if (!bars) throw new Error('가짜 fetch가 봉을 주지 못했다 — 테스트 배선을 확인하라')
    return bars
  })

  // ---- 네 러너의 문구가 서로 갈리지 않는가 ----
  section('러너 간 일관성 — 같은 기준이면 같은 문구여야 표가 나란히 읽힌다')
  for (const b of ['total', 'price'] as const) {
    const notes = [
      shortlab.compareBasisNote(b),
      plateau.compareBasisNote(b),
      valuelab.compareBasisNote(b),
      precompute.compareBasisNote(b),
    ]
    check(`4개 러너의 ${b} 문구가 동일`, new Set(notes).size === 1, notes.join(' || '))
  }

  // ---- value-lab — 국내 시세가 KRX 정본 전용이라 기준이 price로 정해진다 ----
  section('value-lab — 소스가 KRX 정본 고정이므로 비교 기준은 가격수익')
  eq('선언된 시세 소스', valuelab.VALUE_PRICE_SOURCE, 'krx')
  eq('그 소스에서 유도한 기준', valuelab.compareBasisFor(valuelab.VALUE_PRICE_SOURCE), 'price')

  // ---- plateau-lab — tallyFetch 기본값은 총수익(신호·환율 계열이 이걸 쓴다) ----
  section('plateau-lab — tallyFetch 기본값은 총수익 · 카운터는 그대로 돈다')
  {
    plateau.setCompareBasis('price')
    const f = stubFetch()
    try {
      const tally = plateau.newYahooTally()
      const bars = await plateau.tallyFetch(tally, 'KRW=X')
      check('tallyFetch 기본값은 총수익 — 기준이 price여도 계수가 적용된다', tup(bars![0]) === expected(0, 0.5))
      eq('성공 카운터가 돈다(규칙 4)', tally.ok, 1)
      eq('시도 카운터가 돈다', tally.attempted, 1)
    } finally {
      f.restore()
      plateau.setCompareBasis('total')
    }
  }

  // ---- 출력 — 표가 스스로 기준을 말하는가(규칙 3) ----
  //
  // 표만 떼어 가도 어느 기준으로 잰 알파인지 남아야 한다. 그리고 **이전 회차와 직접 비교하지
  // 말라는 경고**가 같이 찍혀야 한다 — 2026-08-03 이전 알파는 벤치만 총수익이라 기울어 있었다.
  section('머리말·한계 절 — 비교 기준을 표가 스스로 말한다')
  {
    const krx = capture(() => shortlab.preamble(14, 'all', 'krx'))
    check('shortterm 머리말(krx)이 비교 기준을 찍는다', krx.includes('비교 기준') && krx.includes('가격수익'), krx.slice(0, 200))
    check('shortterm 머리말(krx)이 이전 회차와 비교 금지를 경고', krx.includes('직접 비교하지 마라'))
    const yah = capture(() => shortlab.preamble(14, 'all', 'yahoo'))
    check('shortterm 머리말(yahoo)은 총수익 기준을 찍는다', yah.includes('비교 기준') && yah.includes('총수익'))
    check('shortterm 머리말(yahoo)엔 기준 전환 경고가 없다', !yah.includes('벤치만 총수익'), yah.slice(0, 300))
    // 기본 인자로 불러도 소스에서 기준이 유도돼야 한다(호출부가 안 넘겨도 표가 거짓말하지 않는다).
    check('기준 인자를 안 넘겨도 소스에서 유도한다', capture(() => shortlab.preamble(1, 'all', 'krx')).includes('가격수익'))
  }
  {
    const opts = {
      benchLabel: '069500.KS KODEX 200',
      offlineBench: false,
      universeNote: 'u',
      cellCount: 405,
      pboMaxCombos: 10,
      pboExhaustive: true,
    }
    const priced = capture(() => plateau.limitsSection({ ...opts, basis: 'price' }))
    check('plateau 한계 절(price)이 비대칭 제거를 명시', priced.includes('제거했다'), priced.slice(0, 300))
    check('plateau 한계 절(price)이 결과가 나빠질 수도 있음을 밝힌다', priced.includes('나빠질 수도 있다'))
    check('plateau 한계 절(price)이 레짐은 총수익임을 남긴다', priced.includes('레짐'))
    check('plateau 한계 절(price)이 절대 수익률 한계를 남긴다', priced.includes('절대 수익률'))
    // 기준을 안 넘기면 total — 옛 호출부의 의미를 조용히 바꾸지 않는다.
    const legacy = capture(() => plateau.limitsSection(opts))
    check('plateau 한계 절 기본값은 total 서술', legacy.includes('총수익'), legacy.slice(0, 300))
    check('plateau 한계 절 기본값은 "제거했다"고 말하지 않는다', !legacy.includes('제거했다'))
  }
  {
    const priced = capture(() => valuelab.disclaimer(false, 'price'))
    check('value 고지 절(price)이 비대칭 제거를 명시', priced.includes('제거했다'), priced.slice(0, 300))
    check('value 고지 절(price)이 게이트는 총수익임을 남긴다', priced.includes('시장게이트'))
    const legacy = capture(() => valuelab.disclaimer(false))
    check('value 고지 절 기본값은 옛 서술(편향 있음) 그대로', legacy.includes('전략에 불리한 쪽으로'), legacy.slice(0, 300))
  }

  // ---- preset-precompute 산출물 — 기준을 필드로 남기고, 없으면 total로 읽는다 ----
  section('preset-precompute 산출물 — 비교 기준 표기 · 옛 파일은 total')
  {
    const cost: CostSettings = { initialCapital: 1_000_000, feePct: 0, taxPct: 0, slippagePct: 0 }
    const asOf = '2026-07-31'
    const at = '2026-08-03T00:00:00.000Z'

    // 안 넘기면 total — 2026-08-03 이전 산출물이 전부 총수익 벤치였다는 **사실**을 보존한다.
    // (조용히 새 기본값으로 읽으면 옛 수치의 의미가 바뀐다. `priceSource ?? 'yahoo'`와 같은 패턴.)
    const legacy = precompute.buildPayload([], asOf, at, cost)
    eq('기준을 안 넘기면 total (옛 호출부 의미 보존)', legacy.compareBasis, 'total')
    check('total 산출물 note가 기준을 밝힌다', legacy.note.includes('총수익'), legacy.note.slice(0, 120))

    const priced = precompute.buildPayload([], asOf, at, cost, [], { source: 'krx', note: 'n', limits: [] }, 'price')
    eq('price를 넘기면 그대로 기록', priced.compareBasis, 'price')
    eq('시세 소스도 함께 기록', priced.priceSource, 'krx')
    check('price 산출물 note가 "가격수익"을 밝힌다', priced.note.includes('가격수익'), priced.note.slice(0, 200))
    check(
      'price 산출물 note가 옛 회차와 직접 비교하지 말라고 못박는다',
      priced.note.includes('직접 비교하지 마라'),
    )
    check(
      'price 산출물 note가 전략에 유리한 보정이 아님을 밝힌다',
      priced.note.includes('기울지 않은 비교'),
      priced.note.slice(0, 400),
    )
    // 규칙 3 — **아는 편향을 안 적는 것**이 이 프로젝트의 반복 사고다.
    check('price 산출물 note가 총수익 슬리브(금) 잔존 편향을 남긴다', priced.note.includes('슬리브'))
    check('price 산출물 note가 절대 수익률 한계를 남긴다', priced.note.includes('절대 수익률'))

    const total = precompute.buildPayload([], asOf, at, cost, [], { source: 'yahoo', note: 'n', limits: [] }, 'total')
    eq('yahoo + total이면 total로 기록', total.compareBasis, 'total')

    // 야후 회차 재현 경로: buildPayload가 기준 인자 유무와 무관하게 나머지 필드를 바꾸지 않는다.
    const a = { ...legacy, computedAt: '' } as Record<string, unknown>
    const b = { ...precompute.buildPayload([], asOf, at, cost, [], undefined, 'total'), computedAt: '' } as Record<
      string,
      unknown
    >
    eq('기준을 명시해도 total 산출물은 한 자리도 다르지 않다', JSON.stringify(a), JSON.stringify(b))
  }
}

main().then(finish, (e) => {
  console.error(`테스트 실행 중 예외: ${e?.stack ?? e}`)
  process.exit(1)
})
