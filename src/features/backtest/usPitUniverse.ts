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

// ═══════════════════════════════════════════════════════════════════════════
// 미장 **실측** 시점 고정 유니버스 — 스키마·파서·로더·되감기 신뢰구간 게이트
// ═══════════════════════════════════════════════════════════════════════════
//
// 왜 이 절이 생겼나 (2026-08-03):
//   위 US_PIT20·US_PIT80은 **[추정] 목록**이다(모델 지식 재구성 — 파일 머리 주석이
//   스스로 그렇게 밝히고 있다). 국장에서 똑같은 결함이 실제로 터졌다: 33차에서 [추정]
//   목록을 KRX 실측 목록으로 바꾸자 알파가 +21.9%p → +2.6%p로 무너졌고 승자 3종 중
//   2종이 전멸했다. **목록이 틀리면 그 목록 위에서 고른 파라미터도 같이 무효다.**
//   미장 쪽 유일한 판정 통과분(27차 US PIT 80 · xsmom 상위8+게이트 · 알파 +4.7%p)도
//   [추정] 목록 위에 있으므로, 실측으로 바꾸기 전에는 그 수치를 믿을 수 없다.
//
//   그래서 공개 소스(Wikipedia)에서 **시점별 실제 지수 구성종목**을 받아
//   `public/data/us-pit/universe.json`에 저장하고, 이 절이 그 파일의 **스키마 단일
//   원본**이 된다. 쓰는 쪽(`scripts/us-pit-collect.entry.ts`)과 읽는 쪽(화면·러너)이
//   같은 타입·같은 검증을 통과한다. 참고 정본은 `krxPitUniverse.ts`다.
//
// ⚠️ **의미가 바뀐다 — 지수 구성종목 ≠ 시총 상위 N.**
//   US_PIT20/US_PIT80은 "그 해 시총 상위 N"이었다. S&P 500은 **위원회가 고르는 목록**이고
//   편입 자체가 이벤트다(편입 발표 후 상승 — index inclusion effect). 따라서 실측
//   유니버스로 갈아끼운 수치를 옛 US_PIT 수치와 나란히 놓고 "좋아졌다/나빠졌다"로 읽으면
//   거짓이다. 시총 순위가 필요하면 **구성종목 × 그 시점 시총**으로 따로 뽑아야 하고,
//   그 시총 자체가 PIT여야 한다(오늘 시총으로 과거 순위를 매기면 그것이 곧 미래참조 —
//   규칙 1 위반). 이 모듈은 **순위를 만들지 않는다**(`rankSource: 'none'`).
//
// ⚠️ **[추정] 폴백을 두지 않는다.** 실측 파일을 못 읽으면 조용히 US_PIT20/80으로
//   내려가지 않고 **던진다**(`US_PIT_REAL_LOAD_FAIL`). 33차가 무너진 경로가 바로 "틀린
//   목록 위에서 조용히 계속 도는 것"이었다. `krxUniverseSource.ts`와 같은 이유다.
//   US_PIT20·US_PIT80은 **삭제하지 않았다** — 24·26·27차 재현에 그대로 필요하다.
//
// ⚠️ 생존편향은 여기서도 **제거되지 않고 측정만 된다.** 그 시절 구성종목이었다가
//   상장폐지된 회사는 목록에 **그대로 남기고**(빼지 않는다) Yahoo에 가격이 없으면 그 해
//   매핑 실패로 계수한다 — US_PIT20의 3중 처리 규약을 그대로 잇는다.

/** 리포 기준 상대 경로 — 쓰는 쪽(수집기)·읽는 쪽(스크립트)이 같은 상수를 쓴다. */
export const US_PIT_REAL_PATH = 'public/data/us-pit/universe.json'
/** 화면이 fetch할 정적 자산 경로(BASE_URL 뒤에 붙인다). */
export const US_PIT_REAL_ASSET_PATH = 'data/us-pit/universe.json'

/** 수집 대상 지수. 둘 다 Wikipedia의 "현재 목록 + 변경 이력" 구조가 같다. */
export type UsIndexKey = 'sp500' | 'ndx'
export const US_INDEX_KEYS: readonly UsIndexKey[] = ['sp500', 'ndx'] as const

/**
 * 지수별 구성종목 수 밴드 — **되감기 신뢰 게이트 ①**.
 *
 * 근거(sp500): 1996-01-02 ~ 2026-01-14의 실제 구성종목 수를 공개 실측 데이터셋
 * (github.com/fja05680/sp500 — A.Clenow 원본 + Wikipedia 갱신, 2718개 변경일 스냅샷)에서
 * 세어 보면 **연초 스냅샷 487~506**, 전 구간 최소 487 · 최대 507이고 연간 순증감 |net|의
 * 최대가 **5**였다(2026-08-03 측정). 밴드는 관측 구간 [487, 507]을 그 최대 순증감의
 * 2배(±10)만큼 넓힌 **[477, 517]**로 잡는다. 되감은 목록의 크기가 이 밖으로 나가면 변경
 * 이력표에 "한쪽만 적힌 행"(편입만 있고 짝이 되는 제외가 없음)이 누적됐다는 뜻이다.
 *
 * ndx는 같은 방식으로 측정하지 못했다 — 지수 정의상 100~102종목이라는 사실만으로
 * [95, 107]을 잡았다. **[미검증]** — 첫 수집 실행의 실제 값으로 확정한다.
 */
export const US_INDEX_SIZE_BAND: Record<UsIndexKey, [number, number]> = {
  sp500: [477, 517],
  ndx: [95, 107], // [미검증]
}

/** 밴드 근거 한 줄 — 데이터 파일에 그대로 박아 둔다(나중에 "왜 이 숫자?"를 잃지 않게). */
export const US_SIZE_BAND_BASIS =
  'sp500: 1996~2026 실제 구성종목 수 관측치 [487, 507](연초 스냅샷 487~506 · 연간 순증감 최대 ±5, ' +
  'fja05680/sp500 2026-08-03 측정)을 순증감 최대의 2배만큼 넓힘 → [477, 517]. ' +
  'ndx: 지수 정의(100~102)에서 잡은 [95, 107] [미검증]'

/**
 * **되감기 잔여 위반 허용치 — 여전히 0.** (구 "게이트 ②"의 임계였던 상수)
 *
 * 현재 구성종목 표에는 `Date added`(편입일) 열이 있다. 되감기가 완전하다면 기준일 D의
 * 복원 목록에는 **편입일이 D보다 늦은 종목이 하나도 없어야 한다.**
 *
 * ⚠️ **2026-08-04 개정 — 이 값은 이제 "임계"가 아니라 "불변식"이다.**
 *   개정 전에는 이 수를 세어 0을 넘으면 그 해를 버렸는데, 그 설계가 **구조적 교착**을
 *   만들었다(GHA run 30874993266): 2026-03-23 편입된 SATS의 편입행이 변경 이력표에 없어
 *   `lateAdded=1`이 나왔고, 그 종목의 `addedOn`은 **모든 과거 연도 스냅샷에도 그대로 남으므로**
 *   어떤 해도 통과할 수 없어 데이터셋 전체가 거부됐다. 위키 파싱 자체는 정상이었다
 *   (현재 구성종목 504 · 편입일 503/503 · 변경행 406 · 버린 행 0).
 *
 *   해법은 임계 완화가 아니다 — **`Date added`를 되감기의 보조 진실로 쓴다.** `Date added`는
 *   현재 구성종목 **전원**에 있고, 변경 이력표는 스스로 "**Selected** changes"라 밝힌
 *   불완전한 소스다. 편입 사실에 관해서는 `Date added`가 더 완전하므로, 그 시점에 아직
 *   편입되지 않은 종목은 스냅샷에서 **제거**한다(`lateAddedFixed`로 계수).
 *   따라서 파일에 남는 `lateAdded`는 **구조상 0**이며, 0이 아니면 교정을 거치지 않은
 *   입력이라는 뜻이라 파서가 거부한다. **완화가 아니라 검사 방향의 교체다.**
 *
 * ⚠️ 이 검사는 **한 방향만** 잡는다. "그 시절 있었다가 지금은 없는 회사"는 현재 표에
 *   없으므로 편입일을 알 수 없고, 그 종목의 누락은 여기서 안 잡힌다. 즉 게이트를
 *   모두 통과해도 "완전하다"는 증명이 아니라 **"발견 가능한 결함이 없다"**는 뜻이다.
 */
export const US_LATE_ADDED_MAX = 0

/**
 * **되감기 신뢰 게이트 ②(신판)** — 그 해 스냅샷에서 교정으로 걷어낸 비율의 상한.
 *
 * 교정 건수 자체는 버그가 아니라 **"변경 이력표가 이만큼 불완전하다"는 측정값**이다.
 * 한 건도 없을 수는 없으므로(그 표는 Selected changes다) 임계는 **비율**에 건다:
 *   `lateAddedFixed / (교정 전 스냅샷 크기)` 가 이 값을 넘으면 그 해부터 신뢰 불가.
 *
 * 값의 근거는 `US_LATE_FIXED_RATE_BASIS`에 문장으로 남긴다(숫자만 두지 않는다).
 */
export const US_LATE_FIXED_RATE_MAX = 0.04

/**
 * 임계 0.04의 근거 — **데이터 파일에 그대로 박아 둔다**(나중에 "왜 이 숫자?"를 잃지 않게).
 *
 * 두 갈래가 같은 자리를 가리켜서 골랐다. 임의로 고른 숫자가 아니라는 뜻이지,
 * 최적값이라는 뜻은 아니다 — **첫 실행의 연도별 분포로 재검토한다**(수집기가 그 분포를 찍는다).
 */
export const US_LATE_FIXED_RATE_BASIS =
  '① 밴드 정합: 구성종목 수 밴드 [477,517]의 반폭 20을 중심 497로 나누면 4.02%다. ' +
  '수 게이트가 이미 "4% 어긋나면 못 믿는다"고 선언했으므로, 같은 스냅샷의 **구성 오차**에 ' +
  '다른 잣대를 새로 만들지 않고 같은 4%를 쓴다. ' +
  '② 회전율 정합: S&P 500의 연간 교체는 대략 20종목 ≈ 500의 4% 수준이다 [미검증 — 이 리포가 ' +
  '측정한 값은 **순증감** 최대 ±5뿐이고 총교체(gross)는 그보다 크다]. 한 해치 교체량보다 더 많이 ' +
  '교정해야 하는 스냅샷은 "그 다음 해 목록을 그대로 쓰는 것"보다 나을 근거가 없어 되감기의 의미가 없다. ' +
  '③ 백스톱: 교정은 스냅샷을 **줄이므로** 큰 교정은 결국 수 밴드에도 걸린다. 비율 게이트는 ' +
  '양방향 누락이 상쇄돼 수는 밴드 안에 남는 경우를 잡는 몫이다.'

/** 교정 비율 = 교정 건수 ÷ 교정 **전** 크기. 파일에 적힌 값과 정확히 비교하려고 6자리에서 끊는다. */
export function usFixedRate(size: number, fixed: number): number {
  const before = size + fixed
  if (!(before > 0)) return 0
  return Math.round((fixed / before) * 1e6) / 1e6
}

/**
 * `universe.json` 스키마 버전. **@2 = 2026-08-04 되감기 교정 도입판.**
 *   @1(미출시): `lateAdded`를 게이트 임계로 쓰던 판. 실제 데이터로는 한 번도 통과하지
 *   못해(교착) 파일이 생산된 적이 없다 — 그래서 마이그레이션 대상이 없다.
 *   @2: 스냅샷에 교정을 적용하고 `lateAddedFixed` 비율에 게이트를 건다.
 * 파서가 정확히 이 문자열을 요구한다 — 구판 파일이 조용히 읽히지 않게 한다.
 */
export const US_PIT_REAL_SCHEMA = 'us-pit/universe@2'

/** 한 종목 한 줄 — 그 시점 티커·회사명·(알면) 편입일. **시총 순위는 없다.** */
export interface UsPitEntry {
  /** 그 시점 표기 티커(PIT 정직성). 조회는 `resolveUsRealTicker`가 현재 티커로 바꾼다. */
  ticker: string
  name: string
  /** 지수 편입일 `YYYY-MM-DD`. 현재 구성종목 표에 없거나 파싱 불가면 null. */
  addedOn: string | null
}

/** 한 해의 복원 목록 + 그 해의 자기검증 결과. */
export interface UsPitYearRecord {
  /** 이 목록이 성립하는 기준일 `YYYY-MM-DD`(그 해 첫 거래일 근사). */
  asOfDate: string
  /** **교정 후** 구성종목. 편입일이 asOfDate보다 늦은 종목은 여기서 빠져 있다. */
  members: UsPitEntry[]
  /** 교정 후 남은 위반 수 — **구조상 0**. 0이 아니면 교정을 안 돌린 파일이다. */
  lateAdded: number
  /**
   * 교정으로 **걷어낸** 종목 수 = 변경 이력표에서 편입행이 빠진 종목의 하한.
   * 버그가 아니라 **불완전성의 측정값**이다 — 게이트 ②가 이 비율에 걸린다.
   */
  lateAddedFixed: number
  /** 걷어낸 표본 몇 개(진단용 · 최대 10개 · `TICKER(YYYY-MM-DD)`). */
  lateAddedFixedSample: string[]
  /** 교정 후 members 중 편입일을 아는 종목 수(검사 커버리지). */
  dateAddedKnown: number
  /**
   * 되감기 중 "편입인데 그 시점 목록에 없음"의 **누계**(asOf → 이 해까지).
   * 과거로 갈수록 줄지 않는다. 별도 임계를 두지 않는 이유는 `UsPitReliability` 주석 참조.
   */
  addNotPresent: number
  /** 되감기 중 "제외인데 이미 목록에 있음"의 **누계**(같은 규약). */
  removeAlreadyPresent: number
}

/** 연도별 게이트 판정. */
export interface UsPitYearVerdict {
  /** 교정 **후** 구성종목 수 — 백테스트가 실제로 쓰는 목록의 크기다. */
  size: number
  sizeOk: boolean
  /** 교정 후 잔여 위반(0이어야 한다 — 게이트가 아니라 불변식). */
  lateAdded: number
  lateAddedFixed: number
  /** 교정 전 크기 = size + lateAddedFixed. 비율의 분모를 검증 가능하게 남긴다. */
  sizeBeforeFix: number
  /** lateAddedFixed ÷ sizeBeforeFix (6자리 반올림). */
  fixedRate: number
  fixedRateOk: boolean
  ok: boolean
}

/**
 * `reliableFrom`을 어떻게 판정했는지 — 숫자로 남긴다.
 *
 * ⚠️ `addNotPresent`/`removeAlreadyPresent`에는 **별도 임계를 두지 않았다.** 둘 다
 *   되감기 상태의 **순 크기**를 흔드는 사건이고(짝이 없는 편입·제외 행), 그 누적 효과는
 *   게이트 ①(구성종목 수 밴드)이 **직접** 측정한다. 따로 임계를 세우면 같은 증거를 두 번
 *   세는 셈이라, **연도별로 기록만 하고 판정에는 쓰지 않는다**(숨기지도 않는다).
 */
export interface UsPitReliability {
  sizeBand: [number, number]
  sizeBandBasis: string
  /** 게이트 ② — 교정 비율 상한(0~1). */
  lateAddedFixedRateMax: number
  /** 그 숫자의 근거 문장. 비우면 파서가 거부한다. */
  lateAddedFixedRateBasis: string
  /** 변경 이력표에서 파싱한 가장 이른 행의 날짜 — 이보다 과거는 되감기 자체가 불가능하다. */
  changesFirstDate: string
  /** 파싱한 변경행 수(0이면 수집기가 던진다 — 조용한 빈 결과 금지). */
  changeRows: number
  years: Record<string, UsPitYearVerdict>
}

/** `public/data/us-pit/universe.json`의 전체 스키마. */
export interface UsPitRealUniverse {
  /** `US_PIT_REAL_SCHEMA`와 정확히 같아야 한다. */
  schema: string
  source: string
  sourceUrl: string
  license: string
  index: UsIndexKey
  /** 수집 실행일 `YYYY-MM-DD`(랭킹 기준일이 아니라 **뽑은 날**). */
  asOf: string
  /** 무엇을 담은 목록인지 한 줄 — "시총 상위 N이 아니다"를 문장으로 못 박는다. */
  basis: string
  /** 시총 순위 정보가 **없다**는 사실을 스키마에 박는다. 있는 척하지 않기 위해서다. */
  rankSource: 'none'
  /** 되감기를 신뢰할 수 있는 **가장 이른 해**. 이보다 과거는 접근에 명시적 동의가 필요하다. */
  reliableFrom: number
  reliability: UsPitReliability
  /** 복원 시도했으나 만들지 못한 해. */
  missingYears: number[]
  /** 연도(4자리 문자열) → 그 해 복원 목록. `reliableFrom` 미만 연도도 들어 있을 수 있다. */
  years: Record<string, UsPitYearRecord>
}

export const US_PIT_REAL_SOURCE = 'Wikipedia'
export const US_PIT_REAL_LICENSE = 'CC BY-SA 4.0 (Wikipedia)'

/** 지수별 Wikipedia 문서·근거 문장. 수집기와 스키마가 같은 상수를 쓴다. */
export const US_INDEX_META: Record<UsIndexKey, { page: string; url: string; basis: string }> = {
  sp500: {
    page: 'List of S&P 500 companies',
    url: 'https://en.wikipedia.org/wiki/List_of_S%26P_500_companies',
    basis:
      'S&P 500 **지수 구성종목**(위원회 선정) — 시총 상위 N이 아니다. 현재 구성종목 표를 ' +
      '변경 이력표("Selected changes to the list of S&P 500 components")로 역방향 되감아 복원. 순위 없음.',
  },
  ndx: {
    page: 'Nasdaq-100',
    url: 'https://en.wikipedia.org/wiki/Nasdaq-100',
    basis:
      'Nasdaq-100 **지수 구성종목**(규칙 기반 선정) — 시총 상위 N이 아니다. 현재 구성종목 표를 ' +
      '변경 이력표로 역방향 되감아 복원. 순위 없음. [미검증 — 첫 수집 실행에서 확정]',
  },
}

function ufail(msg: string): never {
  throw new Error(`us-pit universe.json 스키마 위반 — ${msg}`)
}

function parseUsEntries(raw: unknown, where: string): UsPitEntry[] {
  if (!Array.isArray(raw)) ufail(`${where}가 배열이 아니다`)
  if (raw.length === 0) ufail(`${where}가 비어 있다`)
  const out: UsPitEntry[] = []
  raw.forEach((r, i) => {
    if (typeof r !== 'object' || r == null) ufail(`${where}[${i}]가 객체가 아니다`)
    const e = r as Record<string, unknown>
    const ticker = String(e.ticker ?? '')
    const name = String(e.name ?? '')
    const addedOn = e.addedOn == null ? null : String(e.addedOn)
    // 미국 티커: 영문 대문자 1~5자 + 클래스 접미사(BRK-B). 소문자·공백·거래소 접미사(.KS)는 거부.
    if (!/^[A-Z]{1,5}(-[A-Z])?$/.test(ticker))
      ufail(`${where}[${i}].ticker가 미국 티커 형식이 아니다 (${ticker || '없음'})`)
    if (!name.trim()) ufail(`${where}[${i}].name이 비어 있다 (${ticker})`)
    if (addedOn !== null && !/^\d{4}-\d{2}-\d{2}$/.test(addedOn))
      ufail(`${where}[${i}].addedOn이 YYYY-MM-DD도 null도 아니다 (${ticker}: ${addedOn})`)
    out.push({ ticker, name, addedOn })
  })
  return out
}

/**
 * JSON을 검증하며 읽는다. **거부하는 것**(조용히 넘어가면 백테스트가 거짓말을 한다):
 *   · 필수 필드 누락·타입 오류 · 티커 형식 위반
 *   · 한 해 안의 **중복 티커**
 *   · 덮는 구간 안의 **결측 연도** — `missingYears`에 명시되지 않은 구멍은 거부
 *   · `missingYears`에 넣어 놓고 `years`에도 있는 모순
 *   · `reliableFrom`이 판정표(`reliability.years`)와 어긋나는 것 — 신뢰구간을 손으로
 *     늘려 적는 것도, 반대로 통과한 해를 임의로 버리는 것도 막는다. **경계는 게이트가 정한다.**
 *   · 게이트 판정이 실제 목록 크기·위반 수와 다른 것(판정 위조 방지)
 *   · **교정을 돌리지 않은 파일** — `members`에서 직접 다시 세어 늦은편입 잔여가 있으면 거부한다.
 *     숫자(`lateAdded`)만 0으로 고쳐 적는 위조는 이 재계산에 걸린다.
 *   · 교정 건수·비율·이상징후 누계의 위조(전부 재계산·단조성으로 대조)
 */
export function parseUsPitRealUniverse(raw: unknown): UsPitRealUniverse {
  if (typeof raw !== 'object' || raw == null) ufail('최상위가 객체가 아니다')
  const o = raw as Record<string, unknown>
  const schema = String(o.schema ?? '')
  if (schema !== US_PIT_REAL_SCHEMA)
    ufail(
      `schema가 ${US_PIT_REAL_SCHEMA}가 아니다 (${schema || '없음'}) — 구판 파일을 조용히 읽지 않는다. ` +
        `GHA(uspit:collect)로 다시 수집하라.`,
    )
  const source = String(o.source ?? '')
  const sourceUrl = String(o.sourceUrl ?? '')
  const license = String(o.license ?? '')
  const asOf = String(o.asOf ?? '')
  const basis = String(o.basis ?? '')
  const index = String(o.index ?? '') as UsIndexKey
  if (!source.trim()) ufail('source가 비어 있다')
  if (!sourceUrl.trim()) ufail('sourceUrl이 비어 있다')
  if (!license.trim()) ufail('license가 비어 있다 — 출처 라이선스를 지우지 마라(CC BY-SA)')
  if (!US_INDEX_KEYS.includes(index)) ufail(`index가 ${US_INDEX_KEYS.join('|')}가 아니다 (${index || '없음'})`)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) ufail(`asOf가 YYYY-MM-DD가 아니다 (${asOf || '없음'})`)
  if (!basis.trim()) ufail('basis가 비어 있다')
  if (o.rankSource !== 'none')
    ufail(`rankSource는 'none'이어야 한다 (${String(o.rankSource)}) — 이 파일에는 시총 순위가 없다`)

  if (!Array.isArray(o.missingYears)) ufail('missingYears가 배열이 아니다')
  const missingYears = o.missingYears.map((v, i) => {
    const y = Number(v)
    if (!Number.isInteger(y) || y < 1900 || y > 2999) ufail(`missingYears[${i}]가 연도가 아니다 (${String(v)})`)
    return y
  })

  if (typeof o.years !== 'object' || o.years == null || Array.isArray(o.years)) ufail('years가 객체가 아니다')
  const yearsRaw = o.years as Record<string, unknown>
  const keys = Object.keys(yearsRaw)
  if (keys.length === 0) ufail('years가 비어 있다')

  const years: Record<string, UsPitYearRecord> = {}
  for (const k of keys) {
    if (!/^\d{4}$/.test(k)) ufail(`years 키가 4자리 연도가 아니다 (${k})`)
    const yv = yearsRaw[k]
    if (typeof yv !== 'object' || yv == null) ufail(`years.${k}가 객체가 아니다`)
    const rec = yv as Record<string, unknown>
    const asOfDate = String(rec.asOfDate ?? '')
    if (!/^\d{4}-\d{2}-\d{2}$/.test(asOfDate))
      ufail(`years.${k}.asOfDate가 YYYY-MM-DD가 아니다 (${asOfDate || '없음'})`)
    if (asOfDate.slice(0, 4) !== k) ufail(`years.${k}.asOfDate의 연도가 키와 다르다 (${asOfDate})`)
    const members = parseUsEntries(rec.members, `years.${k}.members`)
    const seen = new Set<string>()
    for (const e of members) {
      if (seen.has(e.ticker)) ufail(`years.${k}에 중복 티커 ${e.ticker}(${e.name})가 있다`)
      seen.add(e.ticker)
    }
    const lateAdded = Number(rec.lateAdded)
    const dateAddedKnown = Number(rec.dateAddedKnown)
    const lateAddedFixed = Number(rec.lateAddedFixed)
    const addNotPresent = Number(rec.addNotPresent)
    const removeAlreadyPresent = Number(rec.removeAlreadyPresent)
    for (const [n, v] of [
      ['lateAdded', lateAdded],
      ['dateAddedKnown', dateAddedKnown],
      ['lateAddedFixed', lateAddedFixed],
      ['addNotPresent', addNotPresent],
      ['removeAlreadyPresent', removeAlreadyPresent],
    ] as const)
      if (!Number.isInteger(v) || v < 0) ufail(`years.${k}.${n}이 0 이상의 정수가 아니다 (${String(rec[n])})`)

    // 🔴 **교정 재계산** — 숫자만 고쳐 적는 위조를 막는 핵심 검사다.
    //    members에서 직접 다시 세므로, `lateAdded: 0`이라 적어 두고 실제로는 교정하지 않은
    //    파일이 통과할 수 없다(게이트 위조 방지 규약을 신설 필드에도 같은 급으로 건다).
    const residual = members.filter((m) => m.addedOn !== null && m.addedOn > asOfDate)
    if (residual.length > 0)
      ufail(
        `years.${k}.members에 asOfDate(${asOfDate})보다 늦게 편입된 종목이 ${residual.length}건 남아 있다 ` +
          `(${residual.slice(0, 3).map((m) => `${m.ticker}(${m.addedOn})`).join(', ')}) — 되감기 교정이 적용되지 않았다`,
      )
    if (lateAdded !== 0)
      ufail(`years.${k}.lateAdded가 0이 아니다 (${lateAdded}) — 교정 후 잔여 위반은 구조상 0이어야 한다`)
    const known = members.filter((m) => m.addedOn !== null).length
    if (dateAddedKnown !== known)
      ufail(`years.${k}.dateAddedKnown(${dateAddedKnown})이 실제 값(${known})과 다르다`)

    if (!Array.isArray(rec.lateAddedFixedSample)) ufail(`years.${k}.lateAddedFixedSample이 배열이 아니다`)
    const lateAddedFixedSample = rec.lateAddedFixedSample.map(String)
    if (lateAddedFixedSample.length > Math.min(10, lateAddedFixed))
      ufail(
        `years.${k}.lateAddedFixedSample이 ${lateAddedFixedSample.length}개인데 교정 건수는 ${lateAddedFixed}건이다 — 표본을 지어내지 마라`,
      )
    for (const s of lateAddedFixedSample)
      if (!/^[A-Z]{1,5}(-[A-Z])?\(\d{4}-\d{2}-\d{2}\)$/.test(s))
        ufail(`years.${k}.lateAddedFixedSample에 형식이 다른 항목이 있다 (${s}) — TICKER(YYYY-MM-DD)여야 한다`)

    years[k] = {
      asOfDate,
      members,
      lateAdded,
      lateAddedFixed,
      lateAddedFixedSample,
      dateAddedKnown,
      addNotPresent,
      removeAlreadyPresent,
    }
  }

  const present = keys.map(Number).sort((a, b) => a - b)
  const missSet = new Set(missingYears)
  for (const y of present) if (missSet.has(y)) ufail(`${y}년이 missingYears에 있으면서 years에도 있다`)
  for (let y = present[0]; y <= present[present.length - 1]; y++) {
    if (years[String(y)]) continue
    if (missSet.has(y)) continue
    ufail(`${y}년이 빠졌는데 missingYears에도 없다 — 결측을 숨기지 마라`)
  }

  // 이상 징후는 되감기 **누계**라 과거로 갈수록 줄지 않는다. 뒤집혀 있으면 손으로 적은 값이다.
  for (let i = 1; i < present.length; i++) {
    const older = years[String(present[i - 1])]
    const newer = years[String(present[i])]
    if (older.addNotPresent < newer.addNotPresent)
      ufail(
        `addNotPresent 누계가 과거로 갈수록 줄었다 (${present[i]}년 ${newer.addNotPresent} → ${present[i - 1]}년 ${older.addNotPresent}) — 누계가 아니다`,
      )
    if (older.removeAlreadyPresent < newer.removeAlreadyPresent)
      ufail(
        `removeAlreadyPresent 누계가 과거로 갈수록 줄었다 (${present[i]}년 ${newer.removeAlreadyPresent} → ${present[i - 1]}년 ${older.removeAlreadyPresent}) — 누계가 아니다`,
      )
  }

  // ── 신뢰구간 판정표 검증 ────────────────────────────────────────────────
  const rel = o.reliability
  if (typeof rel !== 'object' || rel == null) ufail('reliability가 객체가 아니다')
  const r = rel as Record<string, unknown>
  if (!Array.isArray(r.sizeBand) || r.sizeBand.length !== 2) ufail('reliability.sizeBand가 [min,max]가 아니다')
  const sizeBand: [number, number] = [Number(r.sizeBand[0]), Number(r.sizeBand[1])]
  if (!Number.isFinite(sizeBand[0]) || !Number.isFinite(sizeBand[1]) || sizeBand[0] > sizeBand[1])
    ufail(`reliability.sizeBand가 유효한 구간이 아니다 (${sizeBand.join(', ')})`)
  const sizeBandBasis = String(r.sizeBandBasis ?? '')
  if (!sizeBandBasis.trim()) ufail('reliability.sizeBandBasis가 비어 있다 — 밴드 숫자의 근거를 지우지 마라')
  const lateAddedFixedRateMax = Number(r.lateAddedFixedRateMax)
  if (!Number.isFinite(lateAddedFixedRateMax) || lateAddedFixedRateMax < 0 || lateAddedFixedRateMax > 1)
    ufail(`reliability.lateAddedFixedRateMax가 0~1의 비율이 아니다 (${String(r.lateAddedFixedRateMax)})`)
  const lateAddedFixedRateBasis = String(r.lateAddedFixedRateBasis ?? '')
  if (!lateAddedFixedRateBasis.trim())
    ufail('reliability.lateAddedFixedRateBasis가 비어 있다 — 임계 숫자의 근거를 지우지 마라')
  const changesFirstDate = String(r.changesFirstDate ?? '')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(changesFirstDate))
    ufail(`reliability.changesFirstDate가 YYYY-MM-DD가 아니다 (${changesFirstDate || '없음'})`)
  const changeRows = Number(r.changeRows)
  if (!Number.isInteger(changeRows) || changeRows <= 0)
    ufail(`reliability.changeRows가 1 이상의 정수가 아니다 (${String(r.changeRows)}) — 변경행 0건은 되감기가 아니다`)
  if (typeof r.years !== 'object' || r.years == null || Array.isArray(r.years))
    ufail('reliability.years가 객체가 아니다')
  const verdictRaw = r.years as Record<string, unknown>
  const verdicts: Record<string, UsPitYearVerdict> = {}
  for (const k of keys) {
    const v = verdictRaw[k]
    if (typeof v !== 'object' || v == null) ufail(`reliability.years.${k}가 없다 — 판정하지 않은 해를 넣지 마라`)
    const vv = v as Record<string, unknown>
    const size = Number(vv.size)
    const lateAdded = Number(vv.lateAdded)
    const lateAddedFixed = Number(vv.lateAddedFixed)
    const sizeBeforeFix = Number(vv.sizeBeforeFix)
    const fixedRate = Number(vv.fixedRate)
    if (size !== years[k].members.length)
      ufail(`reliability.years.${k}.size(${size})가 실제 구성종목 수(${years[k].members.length})와 다르다`)
    if (lateAdded !== years[k].lateAdded)
      ufail(`reliability.years.${k}.lateAdded(${lateAdded})가 실제 값(${years[k].lateAdded})과 다르다`)
    if (lateAddedFixed !== years[k].lateAddedFixed)
      ufail(`reliability.years.${k}.lateAddedFixed(${lateAddedFixed})가 실제 값(${years[k].lateAddedFixed})과 다르다`)
    if (sizeBeforeFix !== size + lateAddedFixed)
      ufail(
        `reliability.years.${k}.sizeBeforeFix(${sizeBeforeFix})가 size+lateAddedFixed(${size + lateAddedFixed})와 다르다 — 비율의 분모를 손대지 마라`,
      )
    const expectedRate = usFixedRate(size, lateAddedFixed)
    if (fixedRate !== expectedRate)
      ufail(`reliability.years.${k}.fixedRate(${fixedRate})가 재계산값(${expectedRate})과 다르다`)
    const sizeOk = size >= sizeBand[0] && size <= sizeBand[1]
    const fixedRateOk = fixedRate <= lateAddedFixedRateMax
    if (vv.sizeOk !== sizeOk) ufail(`reliability.years.${k}.sizeOk가 밴드 계산과 다르다`)
    if (vv.fixedRateOk !== fixedRateOk) ufail(`reliability.years.${k}.fixedRateOk가 임계 계산과 다르다`)
    if (vv.ok !== (sizeOk && fixedRateOk)) ufail(`reliability.years.${k}.ok가 두 게이트의 논리곱과 다르다`)
    verdicts[k] = { size, sizeOk, lateAdded, lateAddedFixed, sizeBeforeFix, fixedRate, fixedRateOk, ok: sizeOk && fixedRateOk }
  }

  const reliableFrom = Number(o.reliableFrom)
  if (!Number.isInteger(reliableFrom)) ufail(`reliableFrom이 정수가 아니다 (${String(o.reliableFrom)})`)
  const trusted = present.filter((y) => y >= reliableFrom)
  if (trusted.length === 0) ufail(`reliableFrom(${reliableFrom}) 이상인 연도가 하나도 없다 — 쓸 수 있는 구간이 없다`)
  for (const y of trusted)
    if (!verdicts[String(y)].ok)
      ufail(`${y}년이 reliableFrom(${reliableFrom}) 이상인데 게이트를 통과하지 못했다 — 신뢰구간을 늘려 적지 마라`)
  // 경계 바로 아래 해가 통과했다면 경계를 더 내렸어야 한다 — 판정은 데이터가 하고
  // 사람이 손으로 올리거나 내리지 못하게 한다.
  const below = reliableFrom - 1
  if (years[String(below)] && verdicts[String(below)].ok)
    ufail(`${below}년이 게이트를 통과했는데 reliableFrom이 ${reliableFrom}이다 — 경계는 게이트가 정한다`)

  return {
    schema: US_PIT_REAL_SCHEMA,
    source,
    sourceUrl,
    license,
    index,
    asOf,
    basis,
    rankSource: 'none',
    reliableFrom,
    reliability: {
      sizeBand,
      sizeBandBasis,
      lateAddedFixedRateMax,
      lateAddedFixedRateBasis,
      changesFirstDate,
      changeRows,
      years: verdicts,
    },
    missingYears,
    years,
  }
}

/**
 * 게이트를 돌려 `reliableFrom`을 **데이터가 정하게** 한다.
 *
 * 최신 연도부터 과거로 내려가며 두 게이트를 모두 통과하는 동안만 신뢰구간을 넓힌다.
 * 한 해라도 걸리면 거기서 멈춘다 — **중간에 뚫린 해를 건너뛰고 더 과거까지 신뢰한다고
 * 말하지 않는다.** 되감기 오류는 과거로 갈수록 누적되므로, 한 번 깨진 뒤의 통과는
 * 우연일 수 있다.
 */
export function judgeUsPitReliability(
  years: Record<string, UsPitYearRecord>,
  sizeBand: [number, number],
  fixedRateMax: number,
): { reliableFrom: number; verdicts: Record<string, UsPitYearVerdict> } {
  const keys = Object.keys(years)
    .map(Number)
    .sort((a, b) => a - b)
  if (keys.length === 0) throw new Error('판정할 연도가 없다')
  const verdicts: Record<string, UsPitYearVerdict> = {}
  for (const y of keys) {
    const rec = years[String(y)]
    // 불변식 — 교정을 거치지 않은 입력은 판정 대상이 아니다(게이트가 아니라 전제 위반이다).
    if (rec.lateAdded !== 0)
      throw new Error(
        `${y}년 스냅샷에 교정되지 않은 늦은편입이 ${rec.lateAdded}건 남아 있다 — ` +
          `되감기 교정(rewind)을 거치지 않은 입력이다. 임계를 올려 넘길 문제가 아니다.`,
      )
    const size = rec.members.length
    const lateAddedFixed = rec.lateAddedFixed
    const sizeBeforeFix = size + lateAddedFixed
    const fixedRate = usFixedRate(size, lateAddedFixed)
    const sizeOk = size >= sizeBand[0] && size <= sizeBand[1]
    const fixedRateOk = fixedRate <= fixedRateMax
    verdicts[String(y)] = {
      size,
      sizeOk,
      lateAdded: rec.lateAdded,
      lateAddedFixed,
      sizeBeforeFix,
      fixedRate,
      fixedRateOk,
      ok: sizeOk && fixedRateOk,
    }
  }
  const newest = keys[keys.length - 1]
  const nv = verdicts[String(newest)]
  // ── 최신 연도 실패의 **진단을 게이트별로 가른다.** ────────────────────────────
  //    구판은 둘을 뭉쳐 "현재 목록 파싱이 틀렸을 가능성이 높다"고만 말했는데,
  //    2026-08-04 실측(run 30874993266)에서 그 진단은 **틀렸다** — 파싱은 멀쩡했고
  //    변경 이력표가 불완전했을 뿐이다. 같은 오진을 되풀이하지 않는다.
  if (!nv.sizeOk)
    throw new Error(
      `가장 최근 연도(${newest})의 **구성종목 수**가 밴드 밖이다(${nv.size}종목 · 허용 ${sizeBand.join('~')}) — ` +
        `되감기 이전에 **현재 목록 파싱**이 이미 틀렸을 가능성이 높다(표 선택·열 매핑을 먼저 보라).`,
    )
  if (!nv.fixedRateOk)
    throw new Error(
      `가장 최근 연도(${newest})의 **변경 이력 교정 비율**이 임계를 넘었다` +
        `(${(nv.fixedRate * 100).toFixed(2)}% = ${nv.lateAddedFixed}/${nv.sizeBeforeFix} · 허용 ≤${(fixedRateMax * 100).toFixed(2)}%) — ` +
        `현재 목록 파싱은 정상이다(구성종목 ${nv.size}종목이 밴드 ${sizeBand.join('~')} 안). ` +
        `**변경 이력표가 가장 최근 구간부터 이미 불완전**하다는 뜻이고, 그러면 되감기로 신뢰할 수 있는 해가 없다.`,
    )
  let reliableFrom = newest
  for (let i = keys.length - 1; i >= 0; i--) {
    if (!verdicts[String(keys[i])].ok) break
    reliableFrom = keys[i]
  }
  return { reliableFrom, verdicts }
}

/** 수집 결과를 스키마 객체로 조립한다(쓰는 쪽 단일 경로). 조립 즉시 파서로 자기검증한다. */
export function buildUsPitRealUniverse(input: {
  index: UsIndexKey
  asOf: string
  years: Record<number, UsPitYearRecord>
  missingYears: number[]
  changesFirstDate: string
  changeRows: number
  sizeBand?: [number, number]
  fixedRateMax?: number
  /** 임계 근거 문장(기본은 정본 상수). 합성 임계를 쓰는 테스트가 근거도 함께 바꾸도록 열어 둔다. */
  fixedRateBasis?: string
}): UsPitRealUniverse {
  const meta = US_INDEX_META[input.index]
  const sizeBand = input.sizeBand ?? US_INDEX_SIZE_BAND[input.index]
  const fixedRateMax = input.fixedRateMax ?? US_LATE_FIXED_RATE_MAX
  const years: Record<string, UsPitYearRecord> = {}
  for (const y of Object.keys(input.years)
    .map(Number)
    .sort((a, b) => a - b))
    years[String(y)] = input.years[y]
  const { reliableFrom, verdicts } = judgeUsPitReliability(years, sizeBand, fixedRateMax)
  return parseUsPitRealUniverse({
    schema: US_PIT_REAL_SCHEMA,
    source: US_PIT_REAL_SOURCE,
    sourceUrl: meta.url,
    license: US_PIT_REAL_LICENSE,
    index: input.index,
    asOf: input.asOf,
    basis: meta.basis,
    rankSource: 'none',
    reliableFrom,
    reliability: {
      sizeBand,
      sizeBandBasis: US_SIZE_BAND_BASIS,
      lateAddedFixedRateMax: fixedRateMax,
      lateAddedFixedRateBasis: input.fixedRateBasis ?? US_LATE_FIXED_RATE_BASIS,
      changesFirstDate: input.changesFirstDate,
      changeRows: input.changeRows,
      years: verdicts,
    },
    missingYears: [...input.missingYears].sort((a, b) => a - b),
    years,
  })
}

/** 파일에 들어 있는 **모든** 연도(신뢰 못 하는 구간 포함 · 오름차순). 진단 전용. */
export function usRealAllYears(u: UsPitRealUniverse): number[] {
  return Object.keys(u.years)
    .map(Number)
    .sort((a, b) => a - b)
}

/** **신뢰구간 안의** 연도만(오름차순). 백테스트가 쓰는 기본 접근자다. */
export function usRealYears(u: UsPitRealUniverse): number[] {
  return usRealAllYears(u).filter((y) => y >= u.reliableFrom)
}

/**
 * 그 해 구성종목(그 시점 티커). **신뢰구간 밖이면 던진다** — 조용히 쓰지 못하게 한다.
 * 진단 목적이면 `allowUnreliable: true`를 명시해야 한다.
 */
export function usRealCodes(u: UsPitRealUniverse, year: number, allowUnreliable = false): string[] {
  if (year < u.reliableFrom && !allowUnreliable)
    throw new Error(
      `${year}년은 되감기 신뢰구간 밖이다(reliableFrom=${u.reliableFrom}) — ` +
        `변경 이력표가 그 시점까지 완전하지 않다는 뜻이므로 백테스트에 쓰지 않는다. ` +
        `진단 목적이면 allowUnreliable을 명시하라.`,
    )
  return (u.years[String(year)]?.members ?? []).map((e) => e.ticker)
}

/** 티커 → 그 티커에 붙었던 회사명들(등장 순서 · 중복 제거). 재사용/개명 탐지의 원재료. */
export function usRealNameHistory(u: UsPitRealUniverse): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const y of usRealAllYears(u))
    for (const e of u.years[String(y)].members) {
      const arr = (out[e.ticker] ??= [])
      if (!arr.includes(e.name)) arr.push(e.name)
    }
  return out
}

/**
 * **티커 재사용 탐지** — 같은 티커에 회사명이 둘 이상 붙은 경우를 모은다.
 *
 * 이 상태는 둘 중 하나다: ① 회사는 그대로인데 **사명만** 바뀌었다(Facebook→Meta) —
 * 시계열을 이어 쓰는 것이 맞다. ② 회사가 사라지고 **다른 회사가 티커를 물려받았다**
 * (LU=Lucent→Lufax, SUNW=Sun→Sunworks) — 이어 쓰면 백테스트가 조용히 오염된다.
 * 자동으로는 구분할 수 없다. 그래서 **사람이 분류할 때까지 조회를 거부**한다
 * (`resolveUsRealTicker`). 차단의 대가는 매핑률 하락뿐이고, 오염은 결과를 거짓말시킨다.
 */
export function usRealNameConflicts(u: UsPitRealUniverse): Record<string, string[]> {
  const hist = usRealNameHistory(u)
  const out: Record<string, string[]> = {}
  for (const [t, names] of Object.entries(hist)) if (names.length > 1) out[t] = names
  return out
}

/** 아직 `US_TICKER_RENAMES`(개명)에도 `US_BLOCKED_TICKERS`(재사용)에도 없는 충돌 티커. */
export function usRealUnclassifiedConflicts(u: UsPitRealUniverse): string[] {
  return Object.keys(usRealNameConflicts(u))
    .filter((t) => !(t in US_TICKER_RENAMES) && !US_BLOCKED_TICKERS.has(t))
    .sort()
}

/**
 * 그 시점 티커 → `histories` 키. 기존 `resolveUsTicker` 규약을 그대로 잇고 **한 겹 더** 막는다.
 *   ① 재사용 확정 티커(`US_BLOCKED_TICKERS`) → undefined
 *   ② **미분류 사명 충돌** → undefined (재사용일 수 있으므로 정직한 매핑 실패로 계수)
 *   ③ 그 외는 `resolveUsTicker`와 동일(그 시점 티커 → 없으면 개명 폴백)
 */
export function resolveUsRealTicker(
  u: UsPitRealUniverse,
  code: string,
  has: (sym: string) => boolean,
  unclassified: Set<string> = new Set(usRealUnclassifiedConflicts(u)),
): string | undefined {
  if (unclassified.has(code)) return undefined
  return resolveUsTicker(code, has)
}

/** 신뢰구간 전 연도 합집합 — 시세를 한 번만 받기 위한 **조회용** 목록(차단·미분류 제외·정렬). */
export function usRealFetchUnion(u: UsPitRealUniverse): string[] {
  const unclassified = new Set(usRealUnclassifiedConflicts(u))
  const set = new Set<string>()
  for (const y of usRealYears(u))
    for (const code of usRealCodes(u, y)) {
      if (unclassified.has(code)) continue
      const t = usFetchTicker(code)
      if (t) set.add(t)
    }
  return [...set].sort()
}

/**
 * `[from, to]` 구간을 전부 덮는지 확인하고 덮는 연도만 돌려준다.
 * 구멍이 있으면 **던진다** — 조용히 짧은 구간으로 돌면 다른 표와 비교가 성립하지 않는다.
 */
export function usRealSpan(u: UsPitRealUniverse, from: number, to: number): number[] {
  if (from < u.reliableFrom)
    throw new Error(
      `요청 구간 시작(${from})이 되감기 신뢰구간(${u.reliableFrom}~) 밖이다 — ` +
        `그 시점 변경 이력이 불완전하므로 목록이 틀린다.`,
    )
  const have = new Set(usRealYears(u))
  const missing: number[] = []
  const out: number[] = []
  for (let y = from; y <= to; y++) {
    if (have.has(y)) out.push(y)
    else missing.push(y)
  }
  if (missing.length > 0)
    throw new Error(
      `실측 유니버스에 ${from}~${to} 중 ${missing.join(', ')}년이 없다 — ` +
        `${US_PIT_REAL_PATH}를 GHA(us-pit-collect)로 다시 수집하라(복원 불가 연도: ${u.missingYears.join(', ') || '없음'}).`,
    )
  return out
}

/** 화면·로그용 한 줄 출처 표기(규칙 3 — 실데이터 라벨 + 한계 병기). */
export function usRealSourceNote(u: UsPitRealUniverse): string {
  const ys = usRealYears(u)
  const span = ys.length ? `${ys[0]}~${ys[ys.length - 1]}` : '(없음)'
  const all = usRealAllYears(u)
  const dropped = all.filter((y) => y < u.reliableFrom)
  const drop = dropped.length ? ` · 신뢰구간 밖이라 버린 해 ${dropped[0]}~${dropped[dropped.length - 1]}` : ''
  const miss = u.missingYears.length ? ` · 복원 불가 연도 ${u.missingYears.join(', ')}` : ''
  // 교정 규모도 한 줄에 남긴다 — "변경 이력표가 이만큼 불완전했다"를 화면·로그에서 숨기지 않는다.
  const fixes = ys.map((y) => u.reliability.years[String(y)])
  const worst = fixes.reduce((a, b) => (b.fixedRate > a.fixedRate ? b : a), fixes[0])
  const fixNote = worst
    ? ` · 신뢰구간 안 최대 교정 ${(worst.fixedRate * 100).toFixed(2)}%(${worst.lateAddedFixed}/${worst.sizeBeforeFix})`
    : ''
  return (
    `유니버스: ${u.source} ${US_INDEX_META[u.index].page} 실측 구성종목 ${span} · 수집일 ${u.asOf}${drop}${miss} — ` +
    `${u.basis} 되감기 신뢰 판정: 구성종목 수 ${u.reliability.sizeBand.join('~')} · ` +
    `변경이력 교정 비율 ≤${(u.reliability.lateAddedFixedRateMax * 100).toFixed(2)}%${fixNote} ` +
    `(변경행 ${u.reliability.changeRows}건 · 가장 이른 행 ${u.reliability.changesFirstDate})`
  )
}

/** 실측 유니버스에서 파생된 실행 재료 — 화면·러너가 **같은 함수**로 만든다. */
export interface DerivedUsRealUniverse {
  years: number[]
  union: string[]
  codesFor: (year: number) => string[]
  label: string
  sourceNote: string
}

/**
 * 파싱된 실측 유니버스 → 실행 재료. 구간에 구멍이 있으면 **던진다**(usRealSpan).
 * `from`을 생략하면 신뢰구간의 첫 해부터다.
 */
export function deriveUsRealUniverse(u: UsPitRealUniverse, from?: number, to?: number): DerivedUsRealUniverse {
  const covered = usRealYears(u)
  if (covered.length === 0)
    throw new Error(`실측 유니버스에 신뢰 가능한 연도가 없다 — ${US_PIT_REAL_PATH}를 다시 수집하라.`)
  const years = usRealSpan(u, from ?? covered[0], to ?? covered[covered.length - 1])
  const union = usRealFetchUnion(u)
  if (union.length === 0) throw new Error('실측 유니버스에서 조회 가능한 티커를 하나도 뽑지 못했다.')
  return {
    years,
    union,
    codesFor: (year: number) => usRealCodes(u, year),
    label: `${US_INDEX_META[u.index].page} 실측 구성종목 · ${years[0]}~${years[years.length - 1]} · 고유 ${union.length}종목(순위 없음)`,
    sourceNote: usRealSourceNote(u),
  }
}

/** 로드 실패 시 화면·로그에 그대로 보여줄 안내 — "폴백은 없다"를 문장으로 못 박는다. */
export const US_PIT_REAL_LOAD_FAIL =
  `미장 실측 유니버스(${US_PIT_REAL_PATH})를 읽지 못했습니다 — 백테스트를 실행할 수 없습니다. ` +
  `[추정] 목록(US_PIT20·US_PIT80)으로 대신 돌리지 않습니다(국장 33차에서 [추정] 목록발 알파가 ` +
  `+21.9%p → +2.6%p로 무너졌고, 조용한 폴백은 그 사고를 눈에 안 띄게 되풀이합니다). ` +
  `GHA 워크플로(us-pit-collect)를 돌려 파일을 생성·커밋하세요.`

/** fetch 응답 최소 계약 — 테스트가 가짜 fetch를 끼울 수 있게 좁혀 둔다. */
export interface UsUniverseResponse {
  ok: boolean
  status: number
  json: () => Promise<unknown>
}

/**
 * 실측 유니버스 파일을 읽어 파싱한다. **어떤 실패도 삼키지 않는다** —
 * 네트워크·HTTP·JSON·스키마 위반 전부 던진다. 부르는 쪽이 그 메시지를 화면에 띄운다.
 */
export async function loadUsPitRealUniverse(
  baseUrl: string,
  fetchImpl: (url: string) => Promise<UsUniverseResponse>,
): Promise<UsPitRealUniverse> {
  const url = `${baseUrl}${US_PIT_REAL_ASSET_PATH}`
  let res: UsUniverseResponse
  try {
    res = await fetchImpl(url)
  } catch (e) {
    throw new Error(`${US_PIT_REAL_LOAD_FAIL} (네트워크 오류: ${String(e)})`)
  }
  if (!res.ok) throw new Error(`${US_PIT_REAL_LOAD_FAIL} (HTTP ${res.status} · ${url})`)
  let raw: unknown
  try {
    raw = await res.json()
  } catch (e) {
    throw new Error(`${US_PIT_REAL_LOAD_FAIL} (JSON 파싱 실패: ${String(e)})`)
  }
  return parseUsPitRealUniverse(raw)
}
