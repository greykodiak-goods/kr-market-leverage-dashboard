// datasets — 통짜 JSON 산출물 upsert/get (기획서 §1-A: 최신 1건만 유지, by_key 업서트)
import { internalMutation, internalQuery } from './_generated/server'
import { v } from 'convex/values'

export const upsert = internalMutation({
  args: {
    key: v.string(),
    json: v.any(),
    producer: v.string(),
  },
  handler: async (ctx, { key, json, producer }) => {
    const updatedAt = new Date().toISOString()
    const existing = await ctx.db
      .query('datasets')
      .withIndex('by_key', (q) => q.eq('key', key))
      .unique()
    if (existing) {
      await ctx.db.patch(existing._id, { json, updatedAt, producer })
      return { updated: true as const, updatedAt }
    }
    await ctx.db.insert('datasets', { key, json, updatedAt, producer })
    return { updated: false as const, updatedAt }
  },
})

export const get = internalQuery({
  args: { key: v.string() },
  handler: async (ctx, { key }) => {
    return await ctx.db
      .query('datasets')
      .withIndex('by_key', (q) => q.eq('key', key))
      .unique()
  },
})
