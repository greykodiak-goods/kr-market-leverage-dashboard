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
