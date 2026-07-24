// DART 수급 레이더 수집 — scripts/fetch-supply-demand.mjs의 Convex 이식 (기획서 §2-B dart-radar-*)
//
// 흐름: action(외부 fetch — 쿼리/뮤테이션은 fetch 불가) → 파싱·정규화(lib/dartRadar 순수함수)
//   → ① dartFilings 멱등 업서트(by_rceptNo — 이관 목표 ②: majorstock 최근 10건 유실 방지 아카이브)
//   → ② datasets["supply-demand"] 서빙 캐시 업서트(기존 public/data/supply-demand.json과 스키마 동일)
//   → ③ jobRuns 기록(성공/실패 — 크론 자동 재시도 없음, 다음 주기 멱등 업서트가 자연 복구)
//
// SECURITY: DART_API_KEY는 Convex env 전용. 로그·에러·반환값에 키 미포함(URL 로깅은 키 마스킹).

import { internalAction, internalMutation } from './_generated/server'
import { internal } from './_generated/api'
import { v } from 'convex/values'
import {
  CORP_CODE,
  assembleSupplyDemand,
  fetchConcentration,
  fetchInsiders,
  fetchMajorStock,
  fetchOverhang,
  kstISO,
  makeDartClient,
  overhangKindToType,
} from './lib/dartRadar'

// null → undefined (Convex v.optional은 null 미허용)
function opt<T>(value: T | null | undefined): T | undefined {
  return value == null ? undefined : value
}

const filingValidator = v.object({
  type: v.string(),
  rceptNo: v.string(),
  rceptDt: v.string(),
  corpCode: v.string(),
  reporter: v.optional(v.string()),
  reporterRole: v.optional(v.string()),
  shares: v.optional(v.number()),
  sharesChange: v.optional(v.number()),
  ratio: v.optional(v.number()),
  ratioChange: v.optional(v.number()),
  ratioBefore: v.optional(v.number()),
  reason: v.optional(v.string()),
  title: v.optional(v.string()),
  subtype: v.optional(v.string()),
  source: v.string(),
  fetchedAt: v.string(),
})

// 멱등 업서트: by_rceptNo 조회 → 있으면 (내용 변경 시에만) patch, 없으면 insert.
// 크론 중복 실행·수동 재실행에도 데이터가 깨지지 않는다 (기획서 §1-B).
export const upsertFilings = internalMutation({
  args: { filings: v.array(filingValidator) },
  handler: async (ctx, { filings }) => {
    let inserted = 0
    let updated = 0
    let unchanged = 0
    for (const f of filings) {
      const existing = await ctx.db
        .query('dartFilings')
        .withIndex('by_rceptNo', (q) => q.eq('rceptNo', f.rceptNo))
        .unique()
      if (!existing) {
        await ctx.db.insert('dartFilings', f)
        inserted++
        continue
      }
      // fetchedAt 제외 실내용 비교 — 무변경이면 patch 생략(쓰기 절약, 하루 2회 크론 churn 방지)
      const { fetchedAt: _a, ...next } = f
      const { _id, _creationTime, fetchedAt: _b, ...prev } = existing
      if (JSON.stringify(next) === JSON.stringify(prev)) {
        unchanged++
      } else {
        await ctx.db.patch(existing._id, f)
        updated++
      }
    }
    return { inserted, updated, unchanged }
  },
})

type UpsertResult = { inserted: number; updated: number; unchanged: number }
type CollectResult = UpsertResult & { ok: boolean; events: number; overhang: number; notes: string }

// DART 수집 본체 — 크론 2회/일 (dart-radar-noon KST 12:30 / dart-radar-evening KST 19:30).
// 수동 실행: npx convex run dart:collectSupplyDemand
export const collectSupplyDemand = internalAction({
  args: {},
  handler: async (ctx): Promise<CollectResult> => {
    const startedAt = Date.now()
    const jobName = 'dart-radar'
    try {
      const key = process.env.DART_API_KEY
      if (!key) throw new Error('DART_API_KEY env not set (Convex dashboard → Settings → Environment Variables)')
      const dart = makeDartClient(key)

      const major = await fetchMajorStock(dart)
      const insiders = await fetchInsiders(dart)
      const overhang = await fetchOverhang(dart)
      const conc = await fetchConcentration(dart, major)

      const fetchedAt = kstISO()
      const filings = [
        ...major.map((e) => ({
          type: 'major-stock',
          rceptNo: e.rceptNo,
          rceptDt: e.rceptDt,
          corpCode: CORP_CODE,
          reporter: opt(e.reporter),
          shares: opt(e.shares),
          sharesChange: opt(e.changeShares),
          ratio: opt(e.ratioAfter),
          ratioChange: opt(e.ratioChange),
          ratioBefore: opt(e.ratioBefore),
          reason: opt(e.reason),
          source: 'dart',
          fetchedAt,
        })),
        ...insiders.map((e) => ({
          type: 'insider',
          rceptNo: e.rceptNo,
          rceptDt: e.rceptDt,
          corpCode: CORP_CODE,
          reporter: opt(e.reporter),
          reporterRole: opt(e.position),
          shares: opt(e.shares),
          sharesChange: opt(e.changeShares),
          ratio: opt(e.ratioAfter),
          ratioChange: opt(e.ratioChange),
          source: 'dart',
          fetchedAt,
        })),
        ...overhang.map((o) => ({
          type: overhangKindToType(o.kind),
          rceptNo: o.rceptNo,
          rceptDt: o.rceptDt,
          corpCode: CORP_CODE,
          reporter: opt(o.filer),
          title: opt(o.title),
          subtype: opt(o.kind),
          source: 'dart',
          fetchedAt,
        })),
      ]
      const res: UpsertResult = await ctx.runMutation(internal.dart.upsertFilings, { filings })

      // 서빙 캐시 조립 — 스키마 계약(§3-A): 기존 정적 JSON과 구조 동일
      const json = assembleSupplyDemand({ major, insiders, overhang, conc })
      await ctx.runMutation(internal.datasets.upsert, {
        key: 'supply-demand',
        json,
        producer: 'convex-dart-cron',
      })

      const notes = `major=${major.length} insiders=${insiders.length} overhang=${overhang.length} filings: +${res.inserted} ~${res.updated} =${res.unchanged}`
      await ctx.runMutation(internal.ops.recordJobRun, {
        jobName,
        startedAt,
        finishedAt: Date.now(),
        ok: true,
        itemsUpserted: res.inserted + res.updated,
        notes,
      })
      return { ok: true, ...res, events: json.events.length, overhang: overhang.length, notes }
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e)
      await ctx.runMutation(internal.ops.recordJobRun, {
        jobName,
        startedAt,
        finishedAt: Date.now(),
        ok: false,
        error,
      })
      throw e
    }
  },
})
