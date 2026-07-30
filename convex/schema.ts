// Convex 스키마 — 주식 대시보드 데이터 백엔드
// 근거: stock-system-docs\convex-migration-plan.md §1 (2026-07-23 대표 확정안)
//
// 원칙:
//  - 날짜는 정렬 가능한 "YYYY-MM-DD" 문자열 (기존 public/data/*.json 스키마와 동일).
//  - 모든 수집 mutation은 고유 키 인덱스로 업서트 → 크론 중복 실행·수동 재실행에 멱등.
//  - SEED(가상 표본)는 시계열 테이블에 절대 넣지 않는다 — 실측만 적재.
//    (서빙 계약상 필요한 SEED 블록은 datasets의 조립 JSON 안에서 sources.*="seed"로 정직 표기)
//  - enum성 필드는 v.string()으로 두고 주석으로 값 집합을 문서화 (기획서의 "…" 확장 여지 반영).

import { defineSchema, defineTable } from 'convex/server'
import { v } from 'convex/values'

export default defineSchema({
  // 5%룰·내부자·주요사항(오버행) 통합 이벤트 아카이브 — 영구 보존.
  // DART majorstock은 최근 10건 고정이라 여기 쌓지 않으면 과거가 유실된다(이관 목표 ②의 본체).
  dartFilings: defineTable({
    // "major-stock" | "insider" | "insider-plan" | "capital-increase" | "cb" | "lockup" | "other"
    type: v.string(),
    rceptNo: v.string(), // 업서트·중복 방지 키
    rceptDt: v.string(), // "YYYY-MM-DD"
    corpCode: v.string(), // 00164779 = SK하이닉스
    reporter: v.optional(v.string()),
    reporterRole: v.optional(v.string()), // 내부자 직위·등기여부
    shares: v.optional(v.number()),
    sharesChange: v.optional(v.number()),
    ratio: v.optional(v.number()), // 보고 후 보유비율 %
    ratioChange: v.optional(v.number()),
    ratioBefore: v.optional(v.number()), // 5%룰: stkrt - stkrt_irds
    reason: v.optional(v.string()),
    title: v.optional(v.string()), // 오버행: report_nm
    subtype: v.optional(v.string()), // 오버행 세부: "유상증자"|"CB"|"DR·해외상장"|…
    source: v.string(), // "dart"
    fetchedAt: v.string(), // KST ISO
  })
    .index('by_rceptNo', ['rceptNo'])
    .index('by_date', ['rceptDt'])
    .index('by_type_date', ['type', 'rceptDt']),

  // 시장 단위 일별 시계열 (신용융자·미수금·예탁금 등) — FreeSIS 액션(별도 워커)이 적재. 영구 보존.
  leverageSeries: defineTable({
    // "creditBalance" | "unsettled" | "deposit" | "creditRatio" | "turnover" | …
    indicator: v.string(),
    date: v.string(), // "YYYY-MM-DD"
    value: v.number(),
    market: v.optional(v.string()), // "kospi" | "kosdaq" | "total"
    source: v.string(), // "freesis" | "freesis-backfill" | …
    fetchedAt: v.string(),
  }).index('by_indicator_date', ['indicator', 'date']),

  // 종목 단위 대차·공매도 잔고 (data.go.kr 키 확보 시) — 영구 보존.
  lendingSeries: defineTable({
    symbol: v.string(), // "000660"
    metric: v.string(), // "lendingBalance" | "shortBalance"
    date: v.string(),
    shares: v.optional(v.number()),
    amountEok: v.optional(v.number()),
    source: v.string(),
    fetchedAt: v.string(),
  }).index('by_symbol_metric_date', ['symbol', 'metric', 'date']),

  // 종목 단위 보유율 등 일별 스냅샷 (KIS 키 확보 시 — 매일 적재로만 시계열 구축 가능) — 영구 보존.
  holdRatioSeries: defineTable({
    symbol: v.string(),
    metric: v.string(), // "foreignHoldRatio" | "foreignNet" | "instNet"
    date: v.string(),
    value: v.number(),
    source: v.string(),
    fetchedAt: v.string(),
  }).index('by_symbol_metric_date', ['symbol', 'metric', 'date']),

  // 통짜 JSON 산출물 (key-value, 최신 1건만 업서트 유지)
  //  - "supply-demand": DART 크론이 조립한 서빙 캐시 (public/data/supply-demand.json과 스키마 동일)
  //  - "hynix-outlook": 로컬 LLM 잡이 POST /ingest/hynix-outlook 으로 적재
  datasets: defineTable({
    key: v.string(),
    json: v.any(),
    updatedAt: v.string(), // ISO
    producer: v.string(), // "convex-dart-cron" | "local-llm-job" | …
  }).index('by_key', ['key']),

  // ── Phase A(읽기 호환 백엔드): 정적 JSON으로 서빙 중인 것들의 DB 사본 ──────────
  // 목적은 "프론트가 URL만 바꿔 끼울 수 있게" 하는 것이다. 스키마는 기존 파일 구조에서
  // 역으로 도출했다(2026-07-30 public/data 실파일 기준). 파일 구조가 바뀌면 여기도 함께 바꾼다.

  // 종목별 5분봉 요약 — index.json의 symbols[심볼] + 개별 파일의 coverage/tz를 한 문서에 모은다.
  // (두 엔드포인트가 같은 문서를 쓰므로 요약이 서로 어긋날 수 없다.)
  intradayMeta: defineTable({
    symbol: v.string(), // "000660.KS"
    bars: v.number(), // 누적 봉 수
    days: v.number(), // 거래일 수
    first: v.string(), // "YYYY-MM-DD"
    last: v.string(),
    thin: v.number(), // 봉이 모자란 날 수
    coverage: v.optional(v.any()), // 개별 파일의 coverage 객체 원형
    tz: v.optional(v.string()), // "Asia/Seoul"
    // 아래 3개는 현재 정적 index.json에 없다 — 랭킹·종목명 이관 시 채운다.
    // 값이 없으면 응답에도 넣지 않으므로 기존 스키마 호환은 깨지지 않는다.
    name: v.optional(v.string()),
    market: v.optional(v.string()), // "KS" | "KQ"
    rank: v.optional(v.number()),
    updatedAt: v.string(), // ISO
  }).index('by_symbol', ['symbol']),

  // 5분봉 본체. t = epoch **초**(정적 JSON의 ts와 같은 단위).
  // [symbol, t] 복합 인덱스가 곧 고유키다 — 재수집·크론 중복 실행에도 업서트로 멱등.
  // 이 인덱스는 서빙의 범위 조회(symbol 등치 → t 범위 → t 정렬)에도 그대로 쓰인다.
  intradayBars: defineTable({
    symbol: v.string(),
    t: v.number(),
    o: v.number(),
    h: v.number(),
    l: v.number(),
    c: v.number(),
    v: v.number(),
  }).index('by_symbol_t', ['symbol', 't']),

  // 페이퍼 트레이딩 트랙 JSON — 트랙마다 키 구조가 달라(all80/kosdaq40/ma15/config)
  // 파싱하지 않고 **문자열 그대로** 보관한다. 왕복하면서 키 순서·수치 표현이 바뀌지 않는다.
  paperTracks: defineTable({
    track: v.string(), // "all80" | "kosdaq40" | "ma15" | "config"
    payload: v.string(), // JSON 문자열 원본
    updatedAt: v.string(), // ISO
  }).index('by_track', ['track']),

  // 운영: 크론 실행 로그 — 90일 보존(cleanup 크론이 삭제)
  jobRuns: defineTable({
    jobName: v.string(),
    startedAt: v.number(), // epoch ms
    finishedAt: v.number(),
    ok: v.boolean(),
    error: v.optional(v.string()),
    itemsUpserted: v.optional(v.number()),
    notes: v.optional(v.string()),
  }).index('by_job', ['jobName', 'startedAt']),
})
