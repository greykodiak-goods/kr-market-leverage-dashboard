// 미국(NYSE+NASDAQ) 시점 고정(point-in-time) 유니버스 — **그 해 시가총액 상위 20**.
//
// ⚠️ [추정] 큐레이션 — **공식 PIT 랭킹 소스가 아니다.** 각 해 연초(= 전년 말) 시가총액
//    상위 20을 모델 지식으로 재구성한 목록이며, CRSP·Compustat 같은 시점 고정 랭킹
//    데이터베이스로 대조하지 않았다. 순위 경계(대략 15~25위)의 종목은 실제와 다를 수
//    있고, 특히 **2000년대 초반과 2026년 목록의 신뢰도가 가장 낮다**(전자는 오래되어
//    기억이 성기고, 후자는 연말 확정 시총이 아직 굳지 않은 시점이다).
//    결과 수치는 이 한계를 달고 읽는다 — 목록 자체가 틀렸을 수 있다는 뜻이다.
//
// 왜 이 목록이 필요한가 (2026-08-02 대표 지시 "백테스트에 미장 종목도 추가해.
// 그 당시 시점별 상위 종목들 데이터도 가져와서 편향 없애고"):
//   "오늘의 미국 시총 상위 20"으로 과거를 돌리면 AAPL·MSFT·NVDA처럼 **오늘까지 살아남아
//   커진 종목만** 표본에 들어간다(승자편향). 2000년 목록에 Lucent·AOL·WorldCom이,
//   2008년 목록에 AIG·Citigroup이 들어가야 그 시절 투자자가 실제로 마주한 표본이 된다.
//
// ── 생존편향 3중 처리 (규칙 3 정직성) ─────────────────────────────────────────
//   ① **포함**: 상장폐지·파산·피인수 종목을 목록에서 빼지 않는다. Lucent(2006 Alcatel
//      합병)·MCI WorldCom(2002 파산)·AOL·Tyco·EMC·Dell(2013 비상장화)이 그대로 들어 있다.
//      빼면 편향을 "숨기는" 것이고, 넣으면 아래 ②로 드러난다.
//   ② **매핑률**: Yahoo에 가격이 없는 종목은 그 해 '매핑 실패'로 계수되어 연도별
//      매핑률(n/20)로 보고된다. 2000년 매핑률이 낮게 나오는 것이 정상이며, 그것이
//      "이 구간 성적은 살아남은 종목 위주라 후하다"는 증거다.
//   ③ **해석문**: 러너(MODE=uspit)가 결과 하단에 매핑률과 잔존 편향을 명시한다.
//
//   남는 한계: 상폐 종목은 **가격 자체가 없어** 실제로는 매매되지 않는다. 즉 편향이
//   제거된 게 아니라 **측정 가능해진** 것뿐이다. 완전 제거는 유료 PIT 데이터가 필요하다.
//
// ── 티커 재사용 함정 ────────────────────────────────────────────────────────
//   미국 티커는 회사가 사라지면 **다른 회사에 재배정된다**. LU는 Lucent였지만 지금은
//   Lufax(2020 상장), SUNW는 Sun Microsystems였지만 지금은 Sunworks(태양광)다.
//   그대로 조회하면 "상폐된 대형주" 자리에 **전혀 다른 소형주 시계열**이 들어와
//   백테스트가 조용히 오염된다 — 매핑 실패보다 훨씬 나쁘다.
//   → `US_BLOCKED_TICKERS`에 올려 **매핑 자체를 거부**한다(= 정직한 실패로 계수).

/** 티커 → 회사명. 티커 재사용 대비 — 어느 시점의 어느 회사인지 코드에 남긴다. */
export const US_COMPANY_NAMES: Record<string, string> = {
  AAPL: 'Apple',
  ADBE: 'Adobe',
  AIG: 'American International Group — 2008 구제금융, 2009 1:20 역분할(야후 보정)',
  AMZN: 'Amazon.com',
  AOL: 'America Online — 2001 Time Warner 합병. ⚠️ 이후 AOL Inc.(2009~2015)가 같은 티커를 씀',
  AVGO: 'Broadcom',
  BAC: 'Bank of America',
  BMY: 'Bristol-Myers Squibb',
  'BRK-B': 'Berkshire Hathaway Class B — 2010 50:1 분할(야후 보정)',
  C: 'Citigroup — 2011 1:10 역분할(야후 보정)',
  COP: 'ConocoPhillips',
  COST: 'Costco Wholesale',
  CSCO: 'Cisco Systems',
  CVX: 'Chevron',
  DELL: 'Dell — 2013 비상장화 → 2018 Dell Technologies 재상장. 야후 시계열은 2018~ 뿐이라 2004·2005년은 매핑 실패로 계수된다',
  DIS: 'Walt Disney',
  EMC: 'EMC Corp — 2016 Dell에 인수되어 상장폐지',
  FB: 'Facebook — 2022-06 META로 사명·티커 변경',
  GE: 'General Electric',
  GOOG: 'Alphabet (구 Google) — 2004-08 상장. 2014 분할 후 Class C',
  HD: 'Home Depot',
  HPQ: 'HP — 2002년 이전 티커는 HWP',
  IBM: 'IBM',
  INTC: 'Intel',
  JNJ: 'Johnson & Johnson',
  JPM: 'JPMorgan Chase',
  KO: 'Coca-Cola',
  LLY: 'Eli Lilly',
  LU: 'Lucent Technologies — 2006 Alcatel 합병 상장폐지. ⚠️ 현재 LU는 Lufax Holding(2020 상장)',
  MA: 'Mastercard — 2006 상장',
  META: 'Meta Platforms (구 Facebook)',
  MO: 'Altria (구 Philip Morris Companies)',
  MRK: 'Merck',
  MSFT: 'Microsoft',
  NFLX: 'Netflix',
  NVDA: 'NVIDIA',
  ORCL: 'Oracle',
  PEP: 'PepsiCo',
  PFE: 'Pfizer',
  PG: 'Procter & Gamble',
  PM: 'Philip Morris International — 2008 Altria에서 분사',
  PYPL: 'PayPal — 2015 eBay에서 분사',
  T: 'AT&T Inc. — 2005년 SBC가 구 AT&T Corp을 인수하며 티커 T를 승계했다. ⚠️ 야후 T 시계열은 SBC 계통이므로 2005년 이전 구간은 사실상 SBC Communications 가격이다',
  TSLA: 'Tesla — 2010-06 상장',
  TYC: 'Tyco International — 2016 Johnson Controls 합병',
  UNH: 'UnitedHealth Group',
  V: 'Visa — 2008-03 상장',
  VZ: 'Verizon Communications — 2000 Bell Atlantic+GTE 합병으로 출범',
  WCOM: 'MCI WorldCom — 2002 회계부정·파산으로 상장폐지(야후 데이터 없음 예상)',
  WFC: 'Wells Fargo',
  WMT: 'Walmart',
  XOM: 'Exxon Mobil',
}

/**
 * 구 티커 → 현재 티커. 목록에는 **그 시점의 티커**를 적고(PIT 정직성), 조회할 때만
 * 현재 티커로 바꾼다. 사명 변경은 회사의 연속성이 유지되므로 시계열을 이어 쓰는 것이 맞다.
 */
export const US_TICKER_RENAMES: Record<string, string> = {
  FB: 'META', // Facebook → Meta Platforms (2022-06)
  GOOGL: 'GOOG', // Alphabet Class A → Class C(야후 전 구간 보유). 목록은 GOOG로 통일
  HWP: 'HPQ', // Hewlett-Packard (2002 티커 변경)
  SBC: 'T', // SBC Communications → AT&T Inc. (2005)
  'BRK.B': 'BRK-B', // 야후 표기는 하이픈
}

/**
 * **다른 회사가 물려받은 티커** — 조회하면 엉뚱한 회사 시계열이 들어오므로 매핑을 거부한다.
 * 매핑 실패(= 매핑률 하락)로 계수되는 편이 조용한 오염보다 낫다.
 */
export const US_BLOCKED_TICKERS: Set<string> = new Set([
  'LU', // Lucent → 현 Lufax Holding
  'AOL', // America Online → 이후 별도 법인 AOL Inc.
  'SUNW', // Sun Microsystems → 현 Sunworks (목록 미사용, 재발 방지용 등재)
  'S', // Sprint → 현 SentinelOne (목록 미사용, 재발 방지용 등재)
])

/**
 * 연도 → 그 해 연초(전년 말) 미국 시총 상위 20 [추정].
 * NYSE+NASDAQ 통합, **미국 본사·미국 주시장 상장 보통주** 기준(외국 ADR 제외 —
 * Nokia·Vodafone·Toyota 등은 당시 상위였으나 주시장이 해외라 넣지 않았다).
 * 티커는 **그 시점 표기**를 쓴다(2022년의 Facebook은 FB) — 조회 시 US_TICKER_RENAMES로 변환.
 */
export const US_PIT20: Record<number, string[]> = {
  // 닷컴 정점. Lucent(7위권)·AOL·WorldCom이 실제로 이 자리에 있었다 — 셋 다 이후 소멸/급락.
  2000: ['MSFT', 'GE', 'CSCO', 'WMT', 'XOM', 'INTC', 'LU', 'IBM', 'C', 'AOL', 'ORCL', 'T', 'AIG', 'MRK', 'KO', 'PG', 'JNJ', 'WCOM', 'HD', 'DELL'],
  2001: ['GE', 'XOM', 'PFE', 'C', 'WMT', 'AIG', 'MRK', 'CSCO', 'MSFT', 'INTC', 'ORCL', 'T', 'KO', 'IBM', 'JNJ', 'BMY', 'EMC', 'VZ', 'AOL', 'HD'],
  2002: ['GE', 'MSFT', 'XOM', 'WMT', 'C', 'PFE', 'INTC', 'IBM', 'AIG', 'JNJ', 'AOL', 'T', 'MRK', 'CSCO', 'VZ', 'HD', 'KO', 'TYC', 'PG', 'MO'],
  2003: ['MSFT', 'GE', 'XOM', 'WMT', 'PFE', 'C', 'JNJ', 'AIG', 'IBM', 'MRK', 'KO', 'PG', 'VZ', 'BAC', 'INTC', 'CSCO', 'T', 'MO', 'WFC', 'PEP'],
  2004: ['GE', 'MSFT', 'XOM', 'PFE', 'C', 'WMT', 'INTC', 'AIG', 'CSCO', 'IBM', 'JNJ', 'PG', 'KO', 'BAC', 'MO', 'MRK', 'WFC', 'CVX', 'VZ', 'DELL'],
  2005: ['GE', 'XOM', 'MSFT', 'C', 'WMT', 'BAC', 'JNJ', 'PFE', 'AIG', 'IBM', 'JPM', 'PG', 'INTC', 'MO', 'CSCO', 'CVX', 'VZ', 'COP', 'WFC', 'DELL'],
  2006: ['GE', 'XOM', 'MSFT', 'C', 'PG', 'WMT', 'BAC', 'JNJ', 'AIG', 'PFE', 'MO', 'INTC', 'JPM', 'IBM', 'CVX', 'GOOG', 'WFC', 'CSCO', 'PEP', 'T'],
  2007: ['XOM', 'GE', 'MSFT', 'C', 'BAC', 'T', 'PG', 'JNJ', 'WMT', 'AIG', 'PFE', 'MO', 'BRK-B', 'CSCO', 'JPM', 'CVX', 'IBM', 'GOOG', 'WFC', 'INTC'],
  // 금융위기 직전. AIG·Citigroup이 아직 상위 — 이 해 목록이 승자편향 제거의 핵심 표본이다.
  2008: ['XOM', 'GE', 'MSFT', 'T', 'GOOG', 'BRK-B', 'CVX', 'PG', 'JNJ', 'WMT', 'BAC', 'AAPL', 'PFE', 'C', 'CSCO', 'IBM', 'JPM', 'INTC', 'MO', 'AIG'],
  2009: ['XOM', 'WMT', 'PG', 'JNJ', 'MSFT', 'GE', 'T', 'BRK-B', 'CVX', 'WFC', 'PFE', 'JPM', 'IBM', 'KO', 'GOOG', 'VZ', 'CSCO', 'PM', 'ORCL', 'HPQ'],
  2010: ['XOM', 'MSFT', 'WMT', 'GOOG', 'AAPL', 'JNJ', 'PG', 'IBM', 'T', 'JPM', 'GE', 'BRK-B', 'CVX', 'CSCO', 'PFE', 'WFC', 'KO', 'BAC', 'ORCL', 'HPQ'],
  2011: ['XOM', 'AAPL', 'MSFT', 'BRK-B', 'GE', 'WMT', 'GOOG', 'CVX', 'PG', 'IBM', 'JNJ', 'T', 'JPM', 'WFC', 'ORCL', 'KO', 'PFE', 'C', 'BAC', 'INTC'],
  2012: ['XOM', 'AAPL', 'IBM', 'CVX', 'MSFT', 'GOOG', 'WMT', 'BRK-B', 'GE', 'PG', 'T', 'JNJ', 'PFE', 'KO', 'WFC', 'ORCL', 'PM', 'JPM', 'INTC', 'MRK'],
  2013: ['AAPL', 'XOM', 'BRK-B', 'WMT', 'GOOG', 'GE', 'MSFT', 'IBM', 'CVX', 'JNJ', 'PG', 'T', 'PFE', 'WFC', 'JPM', 'KO', 'ORCL', 'PM', 'MRK', 'VZ'],
  2014: ['AAPL', 'XOM', 'GOOG', 'MSFT', 'BRK-B', 'GE', 'JNJ', 'WMT', 'CVX', 'WFC', 'PG', 'JPM', 'IBM', 'AMZN', 'PFE', 'T', 'ORCL', 'KO', 'BAC', 'C'],
  2015: ['AAPL', 'XOM', 'MSFT', 'BRK-B', 'GOOG', 'JNJ', 'WFC', 'WMT', 'GE', 'PG', 'JPM', 'CVX', 'FB', 'ORCL', 'PFE', 'VZ', 'BAC', 'KO', 'INTC', 'T'],
  2016: ['AAPL', 'GOOG', 'MSFT', 'BRK-B', 'XOM', 'AMZN', 'GE', 'FB', 'JNJ', 'WFC', 'JPM', 'PG', 'T', 'V', 'PFE', 'KO', 'WMT', 'VZ', 'DIS', 'BAC'],
  2017: ['AAPL', 'GOOG', 'MSFT', 'BRK-B', 'XOM', 'AMZN', 'FB', 'JNJ', 'JPM', 'GE', 'T', 'WFC', 'PG', 'CVX', 'BAC', 'VZ', 'WMT', 'PFE', 'KO', 'V'],
  2018: ['AAPL', 'GOOG', 'MSFT', 'AMZN', 'FB', 'BRK-B', 'JNJ', 'JPM', 'XOM', 'BAC', 'WFC', 'WMT', 'V', 'PG', 'CVX', 'T', 'UNH', 'HD', 'INTC', 'PFE'],
  2019: ['MSFT', 'AAPL', 'AMZN', 'GOOG', 'BRK-B', 'FB', 'JNJ', 'JPM', 'XOM', 'V', 'WMT', 'BAC', 'PFE', 'VZ', 'UNH', 'PG', 'INTC', 'WFC', 'T', 'CVX'],
  2020: ['AAPL', 'MSFT', 'GOOG', 'AMZN', 'FB', 'BRK-B', 'JPM', 'V', 'JNJ', 'WMT', 'PG', 'BAC', 'MA', 'XOM', 'T', 'INTC', 'DIS', 'UNH', 'VZ', 'HD'],
  2021: ['AAPL', 'MSFT', 'AMZN', 'GOOG', 'FB', 'TSLA', 'BRK-B', 'V', 'JNJ', 'WMT', 'JPM', 'MA', 'PG', 'UNH', 'DIS', 'NVDA', 'HD', 'PYPL', 'BAC', 'ADBE'],
  2022: ['AAPL', 'MSFT', 'GOOG', 'AMZN', 'TSLA', 'FB', 'NVDA', 'BRK-B', 'UNH', 'JPM', 'JNJ', 'V', 'HD', 'WMT', 'PG', 'BAC', 'MA', 'PFE', 'XOM', 'DIS'],
  2023: ['AAPL', 'MSFT', 'GOOG', 'AMZN', 'BRK-B', 'UNH', 'JNJ', 'XOM', 'V', 'JPM', 'TSLA', 'WMT', 'NVDA', 'PG', 'CVX', 'LLY', 'MA', 'HD', 'META', 'PFE'],
  2024: ['AAPL', 'MSFT', 'GOOG', 'AMZN', 'NVDA', 'META', 'TSLA', 'BRK-B', 'LLY', 'V', 'JPM', 'UNH', 'AVGO', 'WMT', 'MA', 'XOM', 'JNJ', 'HD', 'PG', 'COST'],
  2025: ['AAPL', 'NVDA', 'MSFT', 'GOOG', 'AMZN', 'META', 'TSLA', 'AVGO', 'BRK-B', 'LLY', 'WMT', 'JPM', 'V', 'XOM', 'MA', 'UNH', 'ORCL', 'COST', 'HD', 'PG'],
  // ⚠️ 신뢰도 최저 — 2025년 말 확정 시총이 아직 굳지 않은 시점의 [추정]이다.
  2026: ['NVDA', 'AAPL', 'MSFT', 'GOOG', 'AMZN', 'META', 'AVGO', 'TSLA', 'BRK-B', 'JPM', 'WMT', 'LLY', 'V', 'ORCL', 'MA', 'XOM', 'COST', 'JNJ', 'NFLX', 'HD'],
}

/**
 * 지시에서 예로 든 몰락 기업의 실제 편입 여부 — 넣고 싶어서 순위를 왜곡하지 않았다(규칙 3).
 *   - WorldCom(WCOM): 1999년 말 약 $151B 로 **상위 20 안** → 2000년 목록에 포함.
 *   - AOL: 2000~2002년 목록에 포함(2001 Time Warner 합병 이후 포함).
 *   - Lucent(LU): 1999년 말 약 $234B, 당시 7위권 → 2000년 목록에 포함.
 *   - Dell(DELL): 2003·2004년 말 기준 상위 20 → 2004·2005년 목록에 포함
 *     (2013 비상장화로 야후 시계열이 2018년부터라 해당 연도는 매핑 실패로 잡힌다 — 의도된 결과).
 *   - **Enron(ENE)**: 2000년 말 시총 약 $60B 로 대략 25~30위 → 상위 **20**에는 못 든다.
 *   - **Lehman Brothers(LEH)**: 정점(2007년 말)에도 약 $34B 로 20위권 밖.
 *   - **Yahoo!(YHOO)**: 1999년 말 약 $115B 로 20위 문턱 바로 밖(대략 22~25위).
 * 즉 Enron·Lehman·Yahoo!는 "당시 상위였으면 포함" 조건에 걸리지 않는다. 상위 **40**으로
 * 넓히면 셋 다 들어오므로, 폭을 넓힐 때 함께 들어와야 할 후보로 여기 남긴다.
 */
export const US_NOTABLE_EXCLUSIONS = ['ENE (Enron)', 'LEH (Lehman Brothers)', 'YHOO (Yahoo!)'] as const

/** 목록이 덮는 연도(오름차순). */
export const US_PIT_YEARS: number[] = Object.keys(US_PIT20)
  .map(Number)
  .sort((a, b) => a - b)

/** 그 해의 유니버스 티커(그 시점 표기). 목록에 없는 해는 빈 배열. */
export function usPitCodes(year: number): string[] {
  return US_PIT20[year] ?? []
}

/**
 * 그 시점 티커 → **조회에 쓸 현재 티커**. 재사용 티커는 `null`(조회 금지 — 다른 회사다).
 * 미국 티커는 접미사가 없다('AAPL'), 클래스 구분만 하이픈을 쓴다('BRK-B').
 */
export function usFetchTicker(code: string): string | null {
  if (US_BLOCKED_TICKERS.has(code)) return null
  return US_TICKER_RENAMES[code] ?? code
}

/**
 * pitChain 의 `resolve` 로 넘길 매핑: 그 시점 티커 → `histories` 키.
 * ① 재사용 티커면 즉시 실패(오염 방지) ② 그 시점 티커가 그대로 있으면 그것
 * ③ 없으면 사명 변경 폴백(FB→META). 어디에도 없으면 undefined = 그 해 매핑 실패.
 */
export function resolveUsTicker(code: string, has: (sym: string) => boolean): string | undefined {
  if (US_BLOCKED_TICKERS.has(code)) return undefined
  if (has(code)) return code
  const renamed = US_TICKER_RENAMES[code]
  if (renamed && has(renamed)) return renamed
  return undefined
}

/** 전 연도 합집합 — 시세를 한 번만 받아 모든 해가 나눠 쓰기 위한 **조회용** 목록(중복 제거·정렬). */
export const US_PIT_UNION: string[] = (() => {
  const set = new Set<string>()
  for (const y of US_PIT_YEARS) {
    for (const code of usPitCodes(y)) {
      const t = usFetchTicker(code)
      if (t) set.add(t)
    }
  }
  return [...set].sort()
})()

/** 화면·로그에 그대로 붙일 수 있는 한 줄 출처 표기(규칙 3 — 추정치 라벨). */
export const US_PIT_SOURCE_NOTE =
  '유니버스: 각 해 연초 미국(NYSE+NASDAQ) 시총 상위 20 [추정] — 공식 PIT 랭킹 소스 아님(모델 지식 재구성, CRSP/Compustat 미대조). 2000년대 초·2026년 신뢰도 최저'

// ── 거래소 현지 날짜 변환 ────────────────────────────────────────────────────
//
// 여기 있는 이유: `scripts/spec-backtest.entry.ts`는 최상단에서 스스로를 실행하는
// 엔트리라 테스트가 import 할 수 없다(import 하는 순간 백테스트가 돈다).
// **미장 지원 때문에 새로 필요해진** 함수이므로 이 모듈에 두고 러너와 테스트가 함께 쓴다.
// (`src/lib/history.ts`의 toLocalDate와 같은 공식이다 — 그쪽은 IndexedDB·localStorage를
//  건드리는 브라우저 전용 모듈이라 노드 테스트에서 import 하지 않는다.)

/**
 * epoch초 + 거래소 GMT offset(초) → 거래소 **현지 날짜** `YYYY-MM-DD`.
 * Yahoo `meta.gmtoffset`을 그대로 넣는다(한국 +32400 고정, 미 동부 −18000/−14400 서머타임).
 */
export function exchangeLocalDate(epochSec: number, gmtOffsetSec: number): string {
  return new Date((epochSec + gmtOffsetSec) * 1000).toISOString().slice(0, 10)
}

/**
 * `meta.gmtoffset`이 없을 때 쓸 보수적 기본값.
 *
 * ⚠️ **기존 KR 결과 불변 근거**: 한국거래소는 서머타임이 없어 gmtoffset이 **항상 +32400**이다.
 * 따라서 `exchangeLocalDate(ts, 32400)` = `new Date(ts*1000 + 9*3600*1000)` 로 기존
 * 하드코딩과 **수식이 완전히 동일**하다 — 값이 1비트도 바뀌지 않는다.
 * meta가 비는 예외 상황에서도 `.KS`/`.KQ`는 +32400로 떨어뜨려 기존 동작을 보존한다.
 */
export function fallbackGmtOffset(symbol: string): number {
  return /\.(KS|KQ)$/i.test(symbol) ? 32400 : 0
}
