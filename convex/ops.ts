// ops — 크론 실행 로그(jobRuns) 기록 + 보존 정책 정리 크론 구현
// 기획서 §2-C: Convex 크론은 자동 재시도 없음 → action이 try/catch 후 여기로 기록.
// 기획서 §1-B: Convex에 TTL 없음 → cleanup 크론이 jobRuns 90일 초과분 삭제(운영 로그 한정).
import { internalMutation, internalQuery } from './_generated/server'
import { v } from 'convex/values'

export const recordJobRun = internalMutation({
  args: {
    jobName: v.string(),
    startedAt: v.number(),
    finishedAt: v.number(),
    ok: v.boolean(),
    error: v.optional(v.string()),
    itemsUpserted: v.optional(v.number()),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert('jobRuns', args)
  },
})

// 운영 확인용: 잡별 최근 실행 상태 (총괄 일일 루틴에서 npx convex run ops:recentRuns 로 확인)
export const recentRuns = internalQuery({
  args: { jobName: v.optional(v.string()), limit: v.optional(v.number()) },
  handler: async (ctx, { jobName, limit }) => {
    const n = Math.min(limit ?? 10, 50)
    if (jobName) {
      return await ctx.db
        .query('jobRuns')
        .withIndex('by_job', (q) => q.eq('jobName', jobName))
        .order('desc')
        .take(n)
    }
    return await ctx.db.query('jobRuns').order('desc').take(n)
  },
})

// jobRuns 90일 초과분 삭제 — 운영 로그 보존 정책(기획서 §1-A 표). 핵심 시계열은 영구 보존이라 미대상.
export const cleanup = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - 90 * 24 * 3600 * 1000
    // jobRuns 볼륨: 크론 하루 ~3회 → 90일에 수백 행 수준. 전량 스캔으로 충분.
    const all = await ctx.db.query('jobRuns').collect()
    let deleted = 0
    for (const run of all) {
      if (run.startedAt < cutoff) {
        await ctx.db.delete(run._id)
        deleted++
      }
    }
    return { deleted, kept: all.length - deleted }
  },
})
