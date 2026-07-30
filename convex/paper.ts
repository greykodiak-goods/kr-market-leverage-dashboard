// paper — 페이퍼 트레이딩 트랙 JSON 적재·서빙.
//
// 트랙 JSON은 트랙마다 키 구조가 다르고(all80/kosdaq40/ma15는 성과 리포트, config는 동결 설정),
// 앞으로 필드가 더 붙는다. 파싱해서 테이블로 펼치면 그때마다 스키마가 흔들리므로
// Phase A에서는 **문자열 그대로** 보관하고 그대로 돌려준다(왕복 무손실).

import { internalMutation, internalQuery } from './_generated/server'
import { v } from 'convex/values'

/** 트랙 JSON 통째 업서트 — 트랙당 최신 1건만 유지한다. */
export const upsertTrack = internalMutation({
  args: { track: v.string(), payload: v.string() },
  handler: async (ctx, { track, payload }) => {
    // 저장 전에 파싱 가능한 JSON인지만 확인한다(깨진 문자열이 그대로 서빙되지 않게).
    try {
      JSON.parse(payload)
    } catch {
      throw new Error(`track "${track}" payload가 유효한 JSON이 아닙니다`)
    }

    const updatedAt = new Date().toISOString()
    const existing = await ctx.db
      .query('paperTracks')
      .withIndex('by_track', (q) => q.eq('track', track))
      .unique()
    if (existing) {
      if (existing.payload === payload) return { updated: false as const, unchanged: true as const, updatedAt: existing.updatedAt }
      await ctx.db.patch(existing._id, { payload, updatedAt })
      return { updated: true as const, unchanged: false as const, updatedAt }
    }
    await ctx.db.insert('paperTracks', { track, payload, updatedAt })
    return { updated: false as const, unchanged: false as const, updatedAt }
  },
})

export const getTrack = internalQuery({
  args: { track: v.string() },
  handler: async (ctx, { track }) => {
    return await ctx.db
      .query('paperTracks')
      .withIndex('by_track', (q) => q.eq('track', track))
      .unique()
  },
})
