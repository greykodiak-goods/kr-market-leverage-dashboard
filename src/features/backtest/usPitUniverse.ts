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
//
// ── 상위 80 확장 (US_PIT80 · 2026-08-02 대표 지시 "미장 상위 80종목으로 돌려봐") ──
//   왜: 상위 20 유니버스에서는 "상위 5"가 이미 상위 25% 분위라 학계 표준(상위 10% 분위)
//   모멘텀보다 신호가 훨씬 묽다. 80종목이면 상위 8 = 상위 10%로 분위가 정합해진다.
//
//   ⚠️⚠️ **21~80위 구간의 [추정] 신뢰도는 상위 20보다 한층 더 낮다.** 이유:
//     ① 순위 경계가 넓다 — 20위 문턱은 기억이 비교적 또렷하지만 60~80위 문턱은 그렇지
//        않다. 그 구간 종목의 **누락·오배치가 실제로 있다고 가정하고 읽어야 한다.**
//     ② CRSP·Compustat 같은 시점 고정 랭킹 DB로 **대조하지 않았다**(상위 20과 동일).
//     ③ 순위 자체는 백테스트에 쓰이지 않는다 — xsmom은 "그 해 유니버스 소속 여부"만
//        본다. 따라서 21~80위 안에서의 순서 오차는 결과에 영향이 없고, **편입/누락**만이
//        결과를 바꾼다. 그럼에도 편입/누락 오차가 상위 20보다 크다는 사실은 변하지 않는다.
//     ④ 1~20위는 `US_PIT20`을 **그대로 부분집합으로 포함**한다(기존 결과와의 연속성).
//   즉 US_PIT80 기반 수치는 "상위 20 결과보다 넓은 표본"이지 "더 정확한 표본"이 아니다.
//
//   생존편향 처리 방식은 상위 20과 동일하다 — Enron(ENE)·Lehman(LEH)·Bear Stearns(BSC)·
//   Wachovia(WB)·Merrill Lynch(MER)·Yahoo!(YHOO)·Compaq(CPQ)·Warner-Lambert(WLA)처럼
//   사라진 회사를 **그대로 넣는다.** 그중 티커가 다른 회사에 재배정된 것(WB→Weibo,
//   TX→Ternium, BUD→AB InBev ADR)은 `US_BLOCKED_TICKERS`로 매핑을 거부한다.
//   재사용 여부가 **불확실한** 상폐 티커도 오염 방지를 위해 차단 쪽으로 보수적으로 처리했다
//   (차단은 "정직한 매핑 실패"로 계수될 뿐이지만, 오염은 결과를 조용히 거짓말시킨다).

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

  // ── 21~80위 확장분(US_PIT80)에서 새로 등장하는 티커 ─────────────────────────
  // 상폐·개명·티커 재사용 이력을 반드시 남긴다. 여기 없는 티커는 테스트가 잡는다.
  ABBV: 'AbbVie — 2013-01 Abbott에서 분사 상장',
  ABT: 'Abbott Laboratories',
  ACN: 'Accenture — 2001-07 상장(본사 아일랜드, 주시장 NYSE)',
  AHP: 'American Home Products — 2002 Wyeth(WYE)로 사명·티커 변경, AHP 소멸',
  ALL: 'Allstate',
  AMAT: 'Applied Materials',
  AMD: 'Advanced Micro Devices',
  AMGN: 'Amgen',
  APC: 'Anadarko Petroleum — 2019 Occidental에 인수되어 상장폐지',
  AXP: 'American Express',
  BA: 'Boeing',
  BAX: 'Baxter International',
  BB: 'BlackBerry (구 Research In Motion) — RIMM의 시계열 승계자',
  BEL: 'Bell Atlantic — 2000-06 GTE와 합병해 Verizon 출범. 시계열은 VZ로 이어진다',
  BIIB: 'Biogen',
  BK: 'Bank of New York Mellon',
  BLK: 'BlackRock',
  BSC: 'Bear Stearns — 2008-03 JPMorgan에 헐값 인수되어 상장폐지',
  BSX: 'Boston Scientific',
  BUD: 'Anheuser-Busch — 2008 InBev에 인수. ⚠️ 현재 BUD는 AB InBev ADR(다른 법인)',
  CA: 'Computer Associates(→CA Inc) — 2018 Broadcom에 인수되어 상장폐지',
  CAT: 'Caterpillar',
  CELG: 'Celgene — 2019 Bristol-Myers Squibb에 인수되어 상장폐지',
  CHV: 'Chevron의 2001년 이전 티커 — Texaco 합병 후 CVX로 변경',
  CI: 'Cigna Group',
  CL: 'Colgate-Palmolive',
  CMCSA: 'Comcast',
  CPQ: 'Compaq Computer — 2002 HP에 합병되어 상장폐지',
  CRM: 'Salesforce — 2004-06 상장',
  CVS: 'CVS Health',
  DD: 'DuPont — 2017 Dow와 합병(DowDuPont) 후 2019 재분할. 시계열 연속성이 불완전하다',
  DE: 'Deere & Company',
  DHR: 'Danaher',
  DOW: 'Dow Chemical → 현 Dow Inc. 2019 분할 재상장이라 야후 시계열은 2019~ 뿐이다',
  DUK: 'Duke Energy',
  EBAY: 'eBay',
  EK: 'Eastman Kodak — 2012 파산보호로 구 티커 EK 소멸(현 KODK는 재상장 법인)',
  ELV: 'Elevance Health — 구 WellPoint(WLP) → Anthem(ANTM) → 2022 ELV',
  EMR: 'Emerson Electric',
  ENE: 'Enron — 2001-12 회계부정·파산으로 상장폐지',
  EOG: 'EOG Resources',
  F: 'Ford Motor',
  FNM: 'Fannie Mae — 2010 NYSE 상장폐지(현 OTC FNMA)',
  FRE: 'Freddie Mac — 2010 NYSE 상장폐지(현 OTC FMCC)',
  GILD: 'Gilead Sciences',
  GLW: 'Corning',
  GM: 'General Motors — **신** GM(2010-11 재상장)만 목록에 쓴다(2011년~). 구 GM(2009 파산·상폐)은 같은 티커가 신 GM에 재배정돼 연도별로 차단할 수 없어 2000~2007년 목록에서 뺐다 — 아래 US_PIT80_TAIL 주석 참조',
  GS: 'Goldman Sachs — 1999-05 상장',
  GTE: 'GTE — 2000 Bell Atlantic과 합병해 Verizon 출범, 티커 소멸',
  HCA: 'HCA Healthcare — 2006 비상장화 후 2011 재상장. 야후 시계열은 2011~',
  HON: 'Honeywell',
  HWP: 'Hewlett-Packard의 2002년 이전 티커(→HPQ)',
  ISRG: 'Intuitive Surgical',
  JDSU: 'JDS Uniphase — 2015 Viavi(VIAV)·Lumentum으로 분할. 시계열은 VIAV로 이어진다',
  KFT: 'Kraft Foods — 2012-10 Mondelez(MDLZ)로 사명·티커 변경',
  KMB: 'Kimberly-Clark',
  LEH: 'Lehman Brothers — 2008-09 파산으로 상장폐지',
  LIN: 'Linde plc — 2018 Praxair와 합병',
  LOW: "Lowe's",
  MCD: "McDonald's",
  MDLZ: 'Mondelez International (구 Kraft Foods)',
  MDT: 'Medtronic',
  MER: 'Merrill Lynch — 2009 Bank of America에 인수되어 상장폐지',
  MET: 'MetLife — 2000-04 상장',
  MMM: '3M',
  MON: 'Monsanto — 2018 Bayer에 인수되어 상장폐지',
  MOT: 'Motorola — 2011 Motorola Solutions(MSI)와 Mobility로 분할. 시계열은 MSI로 이어진다',
  MS: 'Morgan Stanley — 2002년 이전 티커는 MWD',
  MSI: 'Motorola Solutions (구 Motorola)',
  MU: 'Micron Technology',
  MWD: 'Morgan Stanley Dean Witter — 2002 Morgan Stanley(MS)로 사명·티커 변경',
  NEE: 'NextEra Energy',
  NKE: 'Nike',
  NOW: 'ServiceNow — 2012-06 상장',
  ONE: 'Bank One — 2004 JPMorgan Chase에 합병되어 티커 소멸',
  OXY: 'Occidental Petroleum',
  PLTR: 'Palantir Technologies — 2020-09 상장',
  PRU: 'Prudential Financial — 2001-12 상장',
  QCOM: 'Qualcomm',
  REGN: 'Regeneron Pharmaceuticals',
  RIMM: 'Research In Motion — 2013 BlackBerry(BB)로 사명·티커 변경',
  RTX: 'RTX (구 United Technologies) — UTX의 시계열 승계자',
  SBC: 'SBC Communications — 2005 구 AT&T Corp 인수 후 티커를 T로 변경',
  SBUX: 'Starbucks',
  SCH: 'Charles Schwab의 구 티커(→SCHW)',
  SCHW: 'Charles Schwab',
  SGP: 'Schering-Plough — 2009 Merck에 합병되어 상장폐지',
  SLB: 'Schlumberger (현 SLB)',
  SO: 'Southern Company',
  SPGI: 'S&P Global',
  SQ: 'Block (구 Square) — 2025 티커 XYZ로 변경 [추정 — 미대조]',
  SUNW: 'Sun Microsystems — 2010 Oracle에 인수. ⚠️ 현재 SUNW는 Sunworks(태양광, 다른 회사)',
  TGT: 'Target',
  TMO: 'Thermo Fisher Scientific',
  TWX: 'Time Warner — 2018 AT&T에 인수되어 티커 소멸',
  TX: 'Texaco — 2001 Chevron에 합병. ⚠️ 현재 TX는 Ternium ADR(전혀 다른 회사)',
  TXN: 'Texas Instruments',
  UNP: 'Union Pacific',
  UPS: 'United Parcel Service — 1999-11 상장',
  USB: 'U.S. Bancorp',
  UTX: 'United Technologies — 2020 Raytheon과 합병해 RTX로 변경',
  VIA: 'Viacom — 2019 CBS와 재합병(ViacomCBS→Paramount), 구 티커 소멸',
  VIAV: 'Viavi Solutions (구 JDS Uniphase)',
  VRTX: 'Vertex Pharmaceuticals',
  WAG: 'Walgreen — 2014-12 Walgreens Boots Alliance(WBA)로 사명·티커 변경',
  WB: 'Wachovia — 2008 Wells Fargo에 인수. ⚠️ 현재 WB는 Weibo(2014 상장)',
  WBA: 'Walgreens Boots Alliance',
  WLA: 'Warner-Lambert — 2000 Pfizer에 합병되어 상장폐지',
  WYE: 'Wyeth (구 American Home Products) — 2009 Pfizer에 인수되어 상장폐지',
  XRX: 'Xerox',
  XYZ: 'Block Inc. — SQ의 현 티커 [추정 — 미대조]',
  YHOO: 'Yahoo! — 2017 핵심사업 Verizon 매각, 잔여법인 Altaba(AABA)로 개명 후 2019 청산',
  ZM: 'Zoom Communications',
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

  // ── US_PIT80(21~80위)에서 새로 필요해진 사명·티커 변경 ──────────────────────
  // 전부 **회사의 연속성이 유지된** 경우다(합병 소멸·파산은 여기가 아니라 차단/실패로 간다).
  BEL: 'VZ', // Bell Atlantic → Verizon (2000-06, GTE와 합병)
  CHV: 'CVX', // Chevron Corp → Texaco 합병 후 CVX (2001)
  MWD: 'MS', // Morgan Stanley Dean Witter → Morgan Stanley (2002)
  SCH: 'SCHW', // Charles Schwab 티커 변경
  WAG: 'WBA', // Walgreen → Walgreens Boots Alliance (2014-12)
  KFT: 'MDLZ', // Kraft Foods → Mondelez (2012-10)
  UTX: 'RTX', // United Technologies → RTX (2020, Raytheon 합병)
  MOT: 'MSI', // Motorola → Motorola Solutions (2011 분할, 존속법인)
  RIMM: 'BB', // Research In Motion → BlackBerry (2013)
  JDSU: 'VIAV', // JDS Uniphase → Viavi Solutions (2015 분할, 존속법인)
  SQ: 'XYZ', // Block(구 Square) 티커 변경 (2025) [추정 — 미대조]
}

/**
 * **다른 회사가 물려받은 티커** — 조회하면 엉뚱한 회사 시계열이 들어오므로 매핑을 거부한다.
 * 매핑 실패(= 매핑률 하락)로 계수되는 편이 조용한 오염보다 낫다.
 */
export const US_BLOCKED_TICKERS: Set<string> = new Set([
  'LU', // Lucent → 현 Lufax Holding
  'AOL', // America Online → 이후 별도 법인 AOL Inc.
  'SUNW', // Sun Microsystems → 현 Sunworks (US_PIT80 2000·2001년 목록에서 사용)
  'S', // Sprint → 현 SentinelOne (목록 미사용, 재발 방지용 등재)

  // ── US_PIT80(21~80위) 확장분 ────────────────────────────────────────────────
  // 🔴 확정 재사용 — 조회하면 **전혀 다른 회사** 시계열이 들어온다.
  'WB', // Wachovia → 현 Weibo(2014 상장)
  'TX', // Texaco → 현 Ternium ADR(2006 상장)
  'BUD', // Anheuser-Busch → 현 AB InBev ADR
  // ⚠️ 재사용 여부 **불확실** — 오염 방지를 위해 보수적으로 차단한다.
  //    이들은 전부 소멸(파산·피인수)한 회사이고 티커가 3자 이하라 재배정 확률이 높다.
  //    차단의 대가는 "매핑률 하락"뿐이고, 그건 잔존 생존편향을 드러내는 정직한 신호다.
  'ENE', // Enron (2001 파산)
  'LEH', // Lehman Brothers (2008 파산)
  'BSC', // Bear Stearns (2008 피인수)
  'MER', // Merrill Lynch (2009 피인수)
  'FNM', // Fannie Mae (2010 NYSE 상폐)
  'FRE', // Freddie Mac (2010 NYSE 상폐)
  'ONE', // Bank One (2004 피인수)
  'CA', // Computer Associates (2018 피인수)
  'EK', // Eastman Kodak 구 티커 (2012 파산보호)
  'TWX', // Time Warner (2018 피인수)
  'VIA', // Viacom (2019 재합병)
  'WLA', // Warner-Lambert (2000 피인수)
  'AHP', // American Home Products (2002 개명 → WYE)
  'WYE', // Wyeth (2009 피인수)
  'SGP', // Schering-Plough (2009 피인수)
  'GTE', // GTE (2000 합병 소멸)
  'CPQ', // Compaq (2002 피인수)
  'MON', // Monsanto (2018 피인수)
  'APC', // Anadarko Petroleum (2019 피인수)
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
 * 넓히면 셋 다 들어온다.
 *
 * → **US_PIT80에서는 셋 다 편입됐다**: ENE 2000·2001, LEH 2007·2008, YHOO 2000~2016.
 *   (상위 20 목록은 그대로 두었다 — 넓힌 목록에만 들어오는 것이 순위상 맞다.)
 */
export const US_NOTABLE_EXCLUSIONS = ['ENE (Enron)', 'LEH (Lehman Brothers)', 'YHOO (Yahoo!)'] as const

/**
 * 연도 → 그 해 연초(전년 말) 미국 시총 **21~80위** [추정] 60종목.
 *
 * ⚠️ 파일 머리 주석의 경고를 다시 적는다 — **이 구간의 [추정] 신뢰도는 상위 20보다 낮다.**
 * 순위 경계가 넓어 누락·오배치가 있을 수 있고 CRSP/Compustat와 대조하지 않았다.
 * 다만 xsmom은 "그 해 유니버스 소속 여부"만 쓰므로 21~80위 **안에서의 순서**는 결과에
 * 영향이 없다(편입/누락만이 결과를 바꾼다).
 *
 * 🔴 규칙 1(미래참조 금지): 각 해 목록은 **그 시점에 이미 존재·상장한 회사**만 담는다.
 *   그 해 이후에 상장·분사한 종목을 소급해 넣지 않는다. 실제 적용 예 —
 *   GOOG 2005~(2004-08 상장) · MA 2007~ · V 2009~ · PM 2009~(2008 분사) · TSLA 2011~ ·
 *   GM 2011~(2010-11 재상장) · FB 2013~(2012-05 상장) · ABBV 2014~(2013-01 분사) ·
 *   NOW 2013~ · PYPL 2016~(2015-07 분사) · MDLZ 2013~(2012-10 개명, 그 전 해는 KFT) ·
 *   PLTR 2021~(2020-09 상장). 티커도 **그 시점 표기**를 쓴다(2001년 HP는 HWP, 2003년
 *   모건스탠리는 MWD) — 조회 시 `US_TICKER_RENAMES`가 현 티커로 바꾼다.
 *
 * 주의: 2000~2004년 목록에 **SBC Communications를 넣지 않았다.** 그 시절 SBC는 실제로
 * 상위 20위권이었지만 티커 SBC가 `US_TICKER_RENAMES`로 T에 매핑되는데, 같은 해 상위 20에
 * 이미 T(구 AT&T Corp)가 있어 **같은 심볼로 겹친다.** 겹치면 유니버스가 조용히 79종목이
 * 되므로 아예 뺐다(2005년 목록에는 T가 없어 SBC를 넣었다). [추정] 목록의 알려진 구멍이다.
 *
 * ⚠️ **구 GM(2009 파산)도 뺐다 — 생존편향 포함 원칙의 예외이며 정직하게 적어 둔다.**
 * 구 GM은 2000년대 내내 상위 80에 있던 회사라 원칙대로면 넣어야 하지만, 티커 GM이 2010-11
 * 재상장한 **신 GM에 재배정**됐다. 이 모듈의 차단은 티커 단위라 "2007년의 GM은 거부하고
 * 2011년의 GM은 허용"하는 연도별 차단을 표현할 수 없다. 넣으면 신 GM 시계열이 구 GM 자리에
 * 들어오는 오염 위험(LU→Lufax와 같은 유형)이 생기므로 **차단이 아니라 제외**를 택했다.
 * 대가: 2000~2007년 표본에서 "파산한 대형주" 하나가 빠져 그 구간 성적이 그만큼 후해진다.
 * (같은 이유로 다른 해의 GM은 전부 신 GM이며 2011년 목록부터만 등장한다.)
 */
export const US_PIT80_TAIL: Record<number, string[]> = {
  // 닷컴 정점(1999년 말). Warner-Lambert·Compaq·Sun·Enron이 실제로 이 구간에 있었다.
  2000: ['HWP', 'SUNW', 'TXN', 'QCOM', 'YHOO', 'PFE', 'BMY', 'WLA', 'BEL', 'EMC', 'TWX', 'VIA', 'BAC', 'MOT', 'AXP', 'DD', 'MWD', 'TYC', 'ENE', 'AMGN', 'SGP', 'F', 'GS', 'JDSU', 'GLW', 'AMAT', 'WFC', 'FNM', 'CHV', 'MO', 'LLY', 'BUD', 'CMCSA', 'ABT', 'MCD', 'DIS', 'CA', 'PEP', 'SCH', 'ONE', 'CL', 'KMB', 'TGT', 'HON', 'CPQ', 'MDT', 'MER', 'MMM', 'ALL', 'WB', 'FRE', 'BA', 'GTE', 'AHP', 'EBAY', 'AMZN', 'MU', 'BAX', 'XRX', 'EK'],
  2001: ['HWP', 'SUNW', 'TXN', 'QCOM', 'YHOO', 'LU', 'WCOM', 'DELL', 'MO', 'PG', 'AMGN', 'LLY', 'SGP', 'AHP', 'ABT', 'MDT', 'BAX', 'MMM', 'BA', 'UTX', 'HON', 'MCD', 'DIS', 'TWX', 'VIA', 'CMCSA', 'EBAY', 'AMZN', 'AMAT', 'MU', 'GLW', 'JDSU', 'CA', 'MOT', 'BAC', 'WFC', 'JPM', 'ONE', 'WB', 'MER', 'MWD', 'GS', 'AXP', 'FNM', 'FRE', 'SCH', 'ALL', 'TYC', 'ENE', 'F', 'TGT', 'CHV', 'TX', 'DD', 'EK', 'XRX', 'CPQ', 'PEP', 'CL', 'KMB'],
  2002: ['BAC', 'WFC', 'JPM', 'ONE', 'WB', 'MER', 'MWD', 'GS', 'AXP', 'FNM', 'FRE', 'SCH', 'ALL', 'MET', 'PRU', 'BRK-B', 'AMGN', 'LLY', 'SGP', 'AHP', 'ABT', 'MDT', 'BAX', 'BSX', 'UNH', 'HCA', 'MMM', 'BA', 'UTX', 'HON', 'CAT', 'EMR', 'MCD', 'DIS', 'TWX', 'VIA', 'CMCSA', 'EBAY', 'AMZN', 'DELL', 'HWP', 'TXN', 'QCOM', 'MU', 'AMAT', 'GLW', 'MOT', 'EMC', 'ORCL', 'CVX', 'SO', 'SLB', 'DD', 'DOW', 'F', 'TGT', 'PEP', 'CL', 'KMB', 'LU'],
  2003: ['HD', 'ORCL', 'DELL', 'AMGN', 'LLY', 'WYE', 'SGP', 'ABT', 'MDT', 'BAX', 'BSX', 'UNH', 'HCA', 'MMM', 'BA', 'UTX', 'HON', 'CAT', 'EMR', 'MCD', 'DIS', 'TWX', 'VIA', 'CMCSA', 'EBAY', 'AMZN', 'YHOO', 'QCOM', 'TXN', 'MU', 'AMAT', 'GLW', 'MOT', 'EMC', 'HPQ', 'JPM', 'ONE', 'WB', 'MER', 'MWD', 'GS', 'AXP', 'FNM', 'FRE', 'SCHW', 'ALL', 'MET', 'PRU', 'BRK-B', 'TYC', 'CVX', 'COP', 'SLB', 'DD', 'DOW', 'F', 'TGT', 'CL', 'KMB', 'WAG'],
  2004: ['HD', 'ORCL', 'AMGN', 'LLY', 'WYE', 'SGP', 'ABT', 'MDT', 'BAX', 'BSX', 'UNH', 'HCA', 'MMM', 'BA', 'UTX', 'HON', 'CAT', 'EMR', 'MCD', 'DIS', 'TWX', 'VIA', 'CMCSA', 'EBAY', 'AMZN', 'YHOO', 'QCOM', 'TXN', 'MU', 'AMAT', 'GLW', 'MOT', 'EMC', 'HPQ', 'JPM', 'ONE', 'WB', 'MER', 'MS', 'GS', 'AXP', 'FNM', 'FRE', 'SCHW', 'ALL', 'MET', 'PRU', 'BRK-B', 'TYC', 'COP', 'SLB', 'DD', 'DOW', 'F', 'LOW', 'CL', 'KMB', 'WAG', 'TGT', 'PEP'],
  // GOOG는 2004-08 상장 → 2005년 목록(전년 말 시총)부터 편입 가능하다.
  2005: ['HD', 'ORCL', 'GOOG', 'AMGN', 'LLY', 'WYE', 'SGP', 'ABT', 'MDT', 'BAX', 'BSX', 'UNH', 'HCA', 'MRK', 'MMM', 'BA', 'UTX', 'HON', 'CAT', 'EMR', 'MCD', 'DIS', 'TWX', 'VIA', 'CMCSA', 'EBAY', 'AMZN', 'YHOO', 'QCOM', 'TXN', 'AMAT', 'GLW', 'MOT', 'EMC', 'HPQ', 'WB', 'MER', 'MS', 'GS', 'AXP', 'FNM', 'FRE', 'SCHW', 'ALL', 'MET', 'PRU', 'BRK-B', 'TYC', 'SLB', 'DD', 'DOW', 'F', 'LOW', 'CL', 'KMB', 'WAG', 'TGT', 'PEP', 'KO', 'SBC'],
  2006: ['HD', 'ORCL', 'DELL', 'AMGN', 'LLY', 'WYE', 'SGP', 'ABT', 'MDT', 'BAX', 'BSX', 'UNH', 'MRK', 'KO', 'MMM', 'BA', 'UTX', 'HON', 'CAT', 'DE', 'EMR', 'MCD', 'DIS', 'TWX', 'VIA', 'CMCSA', 'EBAY', 'AMZN', 'YHOO', 'QCOM', 'TXN', 'AMAT', 'GLW', 'MOT', 'EMC', 'HPQ', 'WB', 'MER', 'MS', 'GS', 'AXP', 'FNM', 'FRE', 'SCHW', 'ALL', 'MET', 'PRU', 'BRK-B', 'TYC', 'SLB', 'COP', 'DD', 'DOW', 'F', 'LOW', 'CL', 'KMB', 'WAG', 'TGT', 'UPS'],
  // AAPL은 2006년 말 시총 기준 30위권 — 상위 20 진입은 2008년 목록부터다.
  2007: ['HD', 'ORCL', 'DELL', 'AMGN', 'LLY', 'WYE', 'SGP', 'ABT', 'MDT', 'BAX', 'BSX', 'UNH', 'MRK', 'KO', 'PEP', 'MMM', 'BA', 'UTX', 'HON', 'CAT', 'DE', 'EMR', 'MCD', 'DIS', 'TWX', 'VIA', 'CMCSA', 'EBAY', 'AMZN', 'YHOO', 'QCOM', 'TXN', 'AAPL', 'AMAT', 'GLW', 'MOT', 'EMC', 'HPQ', 'WB', 'MER', 'MS', 'GS', 'AXP', 'FNM', 'FRE', 'SCHW', 'ALL', 'MET', 'PRU', 'TYC', 'SLB', 'COP', 'DD', 'LEH', 'F', 'LOW', 'CL', 'KMB', 'WAG', 'TGT'],
  // 금융위기 직전. Lehman·Bear Stearns·Merrill·Wachovia가 전부 이 해 안에 사라진다.
  2008: ['WFC', 'HD', 'ORCL', 'DELL', 'AMGN', 'LLY', 'WYE', 'SGP', 'ABT', 'MDT', 'BSX', 'UNH', 'MRK', 'KO', 'PEP', 'MMM', 'BA', 'UTX', 'HON', 'CAT', 'DE', 'EMR', 'MCD', 'DIS', 'TWX', 'CMCSA', 'EBAY', 'AMZN', 'YHOO', 'QCOM', 'TXN', 'AMAT', 'GLW', 'MOT', 'EMC', 'HPQ', 'WB', 'MER', 'MS', 'GS', 'LEH', 'BSC', 'AXP', 'FNM', 'FRE', 'SCHW', 'ALL', 'MET', 'PRU', 'TYC', 'SLB', 'COP', 'OXY', 'DD', 'UPS', 'RIMM', 'CL', 'KMB', 'WAG', 'TGT'],
  2009: ['BAC', 'C', 'AIG', 'INTC', 'MRK', 'ABT', 'AMGN', 'LLY', 'WYE', 'SGP', 'MDT', 'BMY', 'UNH', 'MO', 'PEP', 'MMM', 'BA', 'UTX', 'HON', 'CAT', 'DE', 'EMR', 'MCD', 'DIS', 'TWX', 'CMCSA', 'AAPL', 'EBAY', 'AMZN', 'YHOO', 'QCOM', 'TXN', 'GLW', 'MOT', 'EMC', 'DELL', 'HD', 'LOW', 'TGT', 'COST', 'WAG', 'CVS', 'MS', 'GS', 'AXP', 'SCHW', 'ALL', 'MET', 'PRU', 'USB', 'BK', 'COP', 'SLB', 'OXY', 'DD', 'DOW', 'UPS', 'NKE', 'GILD', 'MON'],
  2010: ['PM', 'VZ', 'MRK', 'ABT', 'AMGN', 'LLY', 'BMY', 'UNH', 'MDT', 'GILD', 'MO', 'PEP', 'MMM', 'BA', 'UTX', 'HON', 'CAT', 'DE', 'EMR', 'MCD', 'DIS', 'TWX', 'CMCSA', 'EBAY', 'AMZN', 'YHOO', 'QCOM', 'TXN', 'INTC', 'GLW', 'MOT', 'EMC', 'DELL', 'HD', 'LOW', 'TGT', 'COST', 'WAG', 'CVS', 'MS', 'GS', 'AXP', 'SCHW', 'MET', 'PRU', 'USB', 'BK', 'C', 'AIG', 'COP', 'SLB', 'OXY', 'DD', 'DOW', 'UPS', 'NKE', 'MON', 'RIMM', 'ACN', 'SBUX'],
  // GM은 2010-11 재상장 → 2011년 목록부터 편입 가능(구 GM은 2009 파산·상폐).
  2011: ['PM', 'VZ', 'MRK', 'ABT', 'AMGN', 'LLY', 'BMY', 'UNH', 'MDT', 'GILD', 'MO', 'PEP', 'MMM', 'BA', 'UTX', 'HON', 'CAT', 'DE', 'EMR', 'MCD', 'DIS', 'TWX', 'CMCSA', 'EBAY', 'AMZN', 'YHOO', 'QCOM', 'TXN', 'GLW', 'EMC', 'DELL', 'HD', 'LOW', 'TGT', 'COST', 'WAG', 'CVS', 'MS', 'GS', 'AXP', 'SCHW', 'MET', 'PRU', 'USB', 'BK', 'AIG', 'COP', 'SLB', 'OXY', 'APC', 'DD', 'DOW', 'UPS', 'NKE', 'MON', 'RIMM', 'ACN', 'SBUX', 'CRM', 'GM'],
  2012: ['VZ', 'ABT', 'AMGN', 'LLY', 'BMY', 'UNH', 'MDT', 'GILD', 'MO', 'PEP', 'MMM', 'BA', 'UTX', 'HON', 'CAT', 'DE', 'EMR', 'MCD', 'DIS', 'TWX', 'CMCSA', 'EBAY', 'AMZN', 'YHOO', 'QCOM', 'TXN', 'GLW', 'EMC', 'DELL', 'HD', 'LOW', 'TGT', 'COST', 'WAG', 'CVS', 'MS', 'GS', 'AXP', 'SCHW', 'MET', 'PRU', 'USB', 'BK', 'C', 'BAC', 'AIG', 'COP', 'SLB', 'OXY', 'APC', 'DD', 'DOW', 'UPS', 'NKE', 'MON', 'ACN', 'SBUX', 'CRM', 'GM', 'KFT'],
  // FB는 2012-05 상장 → 2013년 목록부터. KFT는 2012-10 MDLZ로 개명 → 여기부터 MDLZ.
  2013: ['AMZN', 'FB', 'C', 'BAC', 'INTC', 'ABT', 'AMGN', 'LLY', 'BMY', 'UNH', 'MDT', 'GILD', 'MO', 'PEP', 'MMM', 'BA', 'UTX', 'HON', 'CAT', 'DE', 'EMR', 'MCD', 'DIS', 'TWX', 'CMCSA', 'EBAY', 'YHOO', 'QCOM', 'TXN', 'EMC', 'DELL', 'HD', 'LOW', 'TGT', 'COST', 'WAG', 'CVS', 'MS', 'GS', 'AXP', 'SCHW', 'MET', 'PRU', 'USB', 'BK', 'AIG', 'COP', 'SLB', 'OXY', 'APC', 'DD', 'DOW', 'UPS', 'NKE', 'MON', 'ACN', 'SBUX', 'CRM', 'GM', 'MDLZ'],
  // ABBV는 2013-01 Abbott 분사 → 2014년 목록부터.
  2014: ['FB', 'VZ', 'MRK', 'PM', 'INTC', 'V', 'ABBV', 'ABT', 'AMGN', 'LLY', 'BMY', 'UNH', 'MDT', 'GILD', 'CELG', 'BIIB', 'MO', 'PEP', 'MMM', 'BA', 'UTX', 'HON', 'CAT', 'DE', 'EMR', 'MCD', 'DIS', 'TWX', 'CMCSA', 'EBAY', 'YHOO', 'QCOM', 'TXN', 'EMC', 'HD', 'LOW', 'TGT', 'COST', 'WAG', 'CVS', 'MS', 'GS', 'AXP', 'SCHW', 'MET', 'PRU', 'USB', 'BK', 'AIG', 'COP', 'SLB', 'OXY', 'EOG', 'DD', 'DOW', 'UPS', 'NKE', 'MON', 'ACN', 'SBUX'],
  2015: ['AMZN', 'IBM', 'MRK', 'PM', 'MO', 'V', 'MA', 'ABBV', 'ABT', 'AMGN', 'LLY', 'BMY', 'UNH', 'MDT', 'GILD', 'CELG', 'BIIB', 'PEP', 'MMM', 'BA', 'UTX', 'HON', 'CAT', 'DE', 'EMR', 'MCD', 'DIS', 'TWX', 'CMCSA', 'EBAY', 'YHOO', 'QCOM', 'TXN', 'EMC', 'HD', 'LOW', 'TGT', 'COST', 'WBA', 'CVS', 'MS', 'GS', 'AXP', 'SCHW', 'MET', 'PRU', 'USB', 'BK', 'AIG', 'COP', 'SLB', 'OXY', 'EOG', 'DD', 'DOW', 'UPS', 'NKE', 'MON', 'ACN', 'SBUX'],
  // PYPL은 2015-07 eBay 분사 → 2016년 목록부터.
  2016: ['IBM', 'INTC', 'CVX', 'MRK', 'PM', 'MO', 'MA', 'ABBV', 'ABT', 'AMGN', 'LLY', 'BMY', 'UNH', 'MDT', 'GILD', 'CELG', 'BIIB', 'PEP', 'MMM', 'BA', 'UTX', 'HON', 'CAT', 'DE', 'EMR', 'MCD', 'TWX', 'CMCSA', 'NFLX', 'EBAY', 'YHOO', 'QCOM', 'TXN', 'EMC', 'HD', 'LOW', 'TGT', 'COST', 'WBA', 'CVS', 'MS', 'GS', 'AXP', 'SCHW', 'MET', 'PRU', 'USB', 'BK', 'AIG', 'COP', 'SLB', 'OXY', 'EOG', 'DD', 'DOW', 'UPS', 'NKE', 'ACN', 'SBUX', 'PYPL'],
  2017: ['IBM', 'INTC', 'MRK', 'PM', 'MO', 'MA', 'ABBV', 'ABT', 'AMGN', 'LLY', 'BMY', 'UNH', 'MDT', 'GILD', 'CELG', 'BIIB', 'PEP', 'MMM', 'BA', 'UTX', 'HON', 'CAT', 'DE', 'EMR', 'MCD', 'DIS', 'TWX', 'CMCSA', 'NFLX', 'ADBE', 'CRM', 'NVDA', 'AVGO', 'TXN', 'QCOM', 'ORCL', 'CSCO', 'HD', 'LOW', 'TGT', 'COST', 'WBA', 'CVS', 'MS', 'GS', 'AXP', 'SCHW', 'MET', 'PRU', 'USB', 'BK', 'C', 'AIG', 'COP', 'SLB', 'OXY', 'EOG', 'UPS', 'NKE', 'ACN'],
  2018: ['IBM', 'MRK', 'PM', 'MO', 'MA', 'ABBV', 'ABT', 'AMGN', 'LLY', 'BMY', 'MDT', 'GILD', 'CELG', 'BIIB', 'PEP', 'KO', 'MMM', 'BA', 'UTX', 'HON', 'CAT', 'DE', 'EMR', 'MCD', 'DIS', 'TWX', 'CMCSA', 'NFLX', 'ADBE', 'CRM', 'NVDA', 'AVGO', 'TXN', 'QCOM', 'ORCL', 'CSCO', 'VZ', 'C', 'LOW', 'TGT', 'COST', 'WBA', 'CVS', 'MS', 'GS', 'AXP', 'SCHW', 'MET', 'PRU', 'USB', 'BK', 'AIG', 'COP', 'SLB', 'OXY', 'EOG', 'UPS', 'NKE', 'ACN', 'PYPL'],
  2019: ['MRK', 'KO', 'HD', 'MA', 'DIS', 'CSCO', 'PEP', 'MCD', 'ABBV', 'ABT', 'AMGN', 'LLY', 'BMY', 'MDT', 'TMO', 'DHR', 'GILD', 'CELG', 'BIIB', 'PM', 'MO', 'MMM', 'BA', 'UTX', 'HON', 'CAT', 'DE', 'EMR', 'UNP', 'NEE', 'DUK', 'SO', 'NFLX', 'ADBE', 'CRM', 'NVDA', 'AVGO', 'TXN', 'QCOM', 'ORCL', 'IBM', 'C', 'GS', 'MS', 'AXP', 'SCHW', 'USB', 'BK', 'COST', 'LOW', 'TGT', 'WBA', 'CVS', 'NKE', 'SBUX', 'UPS', 'ACN', 'PYPL', 'COP', 'SLB'],
  // CELG는 2019-11 BMY에 인수 → 2020년 목록에서 빠진다(그 시점에 이미 없다).
  2020: ['PFE', 'MRK', 'KO', 'PEP', 'CVX', 'WFC', 'CSCO', 'ABBV', 'ABT', 'AMGN', 'LLY', 'BMY', 'MDT', 'TMO', 'DHR', 'GILD', 'BIIB', 'PM', 'MO', 'MMM', 'BA', 'UTX', 'HON', 'CAT', 'DE', 'EMR', 'UNP', 'NEE', 'DUK', 'SO', 'NFLX', 'ADBE', 'CRM', 'NVDA', 'AVGO', 'TXN', 'QCOM', 'ORCL', 'IBM', 'C', 'GS', 'MS', 'AXP', 'SCHW', 'USB', 'BK', 'COST', 'LOW', 'TGT', 'WBA', 'CVS', 'NKE', 'SBUX', 'UPS', 'ACN', 'PYPL', 'COP', 'SLB', 'MCD', 'AMD'],
  2021: ['INTC', 'VZ', 'CMCSA', 'KO', 'PEP', 'MRK', 'PFE', 'ABT', 'ABBV', 'TMO', 'DHR', 'LLY', 'BMY', 'AMGN', 'GILD', 'MDT', 'T', 'XOM', 'CVX', 'CSCO', 'ORCL', 'CRM', 'AVGO', 'TXN', 'QCOM', 'AMD', 'NFLX', 'COST', 'NKE', 'MCD', 'SBUX', 'LOW', 'TGT', 'CVS', 'WBA', 'UPS', 'ACN', 'IBM', 'C', 'WFC', 'GS', 'MS', 'AXP', 'SCHW', 'USB', 'BK', 'BLK', 'SPGI', 'NEE', 'DUK', 'SO', 'UNP', 'HON', 'MMM', 'BA', 'CAT', 'DE', 'NOW', 'SQ', 'ZM'],
  2022: ['ADBE', 'CRM', 'NFLX', 'AVGO', 'CSCO', 'ORCL', 'INTC', 'AMD', 'QCOM', 'TXN', 'NOW', 'PYPL', 'CMCSA', 'VZ', 'T', 'KO', 'PEP', 'MRK', 'ABT', 'ABBV', 'TMO', 'DHR', 'LLY', 'BMY', 'AMGN', 'GILD', 'MDT', 'CVX', 'COP', 'NEE', 'DUK', 'SO', 'LIN', 'UNP', 'HON', 'MMM', 'BA', 'CAT', 'DE', 'COST', 'NKE', 'MCD', 'SBUX', 'LOW', 'TGT', 'CVS', 'UPS', 'ACN', 'IBM', 'C', 'WFC', 'GS', 'MS', 'AXP', 'SCHW', 'USB', 'BLK', 'SPGI', 'GE', 'MU'],
  2023: ['ABBV', 'MRK', 'KO', 'PEP', 'COST', 'AVGO', 'CSCO', 'ORCL', 'ADBE', 'CRM', 'AMD', 'QCOM', 'TXN', 'INTC', 'IBM', 'NFLX', 'CMCSA', 'VZ', 'T', 'DIS', 'MCD', 'NKE', 'SBUX', 'LOW', 'TGT', 'CVS', 'UPS', 'ACN', 'ABT', 'TMO', 'DHR', 'AMGN', 'GILD', 'BMY', 'MDT', 'ELV', 'CI', 'COP', 'SLB', 'EOG', 'NEE', 'DUK', 'SO', 'LIN', 'UNP', 'HON', 'MMM', 'BA', 'CAT', 'DE', 'GE', 'BAC', 'WFC', 'C', 'GS', 'MS', 'AXP', 'SCHW', 'BLK', 'SPGI'],
  2024: ['ORCL', 'ADBE', 'CRM', 'AMD', 'QCOM', 'TXN', 'INTC', 'IBM', 'NFLX', 'CSCO', 'CMCSA', 'VZ', 'T', 'DIS', 'MCD', 'NKE', 'SBUX', 'LOW', 'TGT', 'CVS', 'UPS', 'ACN', 'ABT', 'TMO', 'DHR', 'AMGN', 'GILD', 'BMY', 'MDT', 'PFE', 'MRK', 'ABBV', 'ELV', 'CI', 'KO', 'PEP', 'CVX', 'COP', 'SLB', 'EOG', 'NEE', 'DUK', 'SO', 'LIN', 'UNP', 'HON', 'MMM', 'BA', 'CAT', 'DE', 'GE', 'BAC', 'WFC', 'C', 'GS', 'MS', 'AXP', 'SCHW', 'BLK', 'SPGI'],
  2025: ['JNJ', 'ABBV', 'MRK', 'PFE', 'TMO', 'ABT', 'DHR', 'AMGN', 'GILD', 'BMY', 'MDT', 'ELV', 'CI', 'ISRG', 'VRTX', 'REGN', 'KO', 'PEP', 'MCD', 'NKE', 'SBUX', 'LOW', 'TGT', 'CVS', 'UPS', 'ACN', 'CRM', 'ADBE', 'AMD', 'QCOM', 'TXN', 'INTC', 'MU', 'IBM', 'NFLX', 'CSCO', 'CMCSA', 'VZ', 'T', 'DIS', 'NOW', 'PLTR', 'CVX', 'COP', 'SLB', 'EOG', 'NEE', 'DUK', 'SO', 'LIN', 'UNP', 'HON', 'GE', 'BA', 'CAT', 'DE', 'BAC', 'WFC', 'GS', 'MS'],
  // ⚠️ 신뢰도 최저 — 2025년 말 확정 시총이 굳지 않은 시점의 [추정](상위 20과 같은 한계).
  2026: ['PG', 'UNH', 'ABBV', 'MRK', 'PFE', 'TMO', 'ABT', 'DHR', 'AMGN', 'GILD', 'BMY', 'MDT', 'ELV', 'CI', 'ISRG', 'VRTX', 'REGN', 'KO', 'PEP', 'MCD', 'NKE', 'SBUX', 'LOW', 'TGT', 'CVS', 'UPS', 'ACN', 'CRM', 'ADBE', 'AMD', 'QCOM', 'TXN', 'INTC', 'MU', 'IBM', 'CSCO', 'CMCSA', 'VZ', 'T', 'DIS', 'NOW', 'PLTR', 'CVX', 'COP', 'SLB', 'EOG', 'NEE', 'DUK', 'SO', 'LIN', 'UNP', 'HON', 'GE', 'BA', 'CAT', 'DE', 'BAC', 'WFC', 'GS', 'MS'],
}

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

// ── 상위 80 유니버스 (US_PIT20 ⊕ US_PIT80_TAIL) ──────────────────────────────
//
// 🔴 상위 20을 **구조적으로** 부분집합으로 만든다. 목록을 두 번 적어 손으로 맞추면
//    언젠가 어긋나므로, 여기서 이어 붙여 어긋날 수 없게 한다(테스트도 함께 검증한다).
//    기존 API(US_PIT20 · usPitCodes · US_PIT_UNION)는 손대지 않았다 —
//    MODE=uspit·usxsmom의 동작은 이 확장으로 1비트도 바뀌지 않는다.

/** 연도 → 그 해 연초 미국 시총 상위 80 [추정]. 앞 20개는 `US_PIT20`과 완전히 같다. */
export const US_PIT80: Record<number, string[]> = (() => {
  const out: Record<number, string[]> = {}
  for (const y of Object.keys(US_PIT20).map(Number)) out[y] = [...US_PIT20[y], ...(US_PIT80_TAIL[y] ?? [])]
  return out
})()

/** 그 해의 상위 80 유니버스 티커(그 시점 표기). 목록에 없는 해는 빈 배열. */
export function usPit80Codes(year: number): string[] {
  return US_PIT80[year] ?? []
}

/** 상위 80 전 연도 합집합 — **조회용** 목록(재사용 티커 제외·중복 제거·정렬). */
export const US_PIT80_UNION: string[] = (() => {
  const set = new Set<string>()
  for (const y of US_PIT_YEARS) {
    for (const code of usPit80Codes(y)) {
      const t = usFetchTicker(code)
      if (t) set.add(t)
    }
  }
  return [...set].sort()
})()

/** 화면·로그에 그대로 붙일 수 있는 한 줄 출처 표기(규칙 3 — 추정치 라벨). */
export const US_PIT80_SOURCE_NOTE =
  '유니버스: 각 해 연초 미국(NYSE+NASDAQ) 시총 상위 80 [추정] — 1~20위는 US_PIT20 그대로, ' +
  '**21~80위는 신뢰도가 한 단계 더 낮다**(순위 경계가 넓어 누락·오배치 가능, CRSP/Compustat 미대조). ' +
  '2000년대 초·2026년 신뢰도 최저'

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
