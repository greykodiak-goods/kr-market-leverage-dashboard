// intraday — 5분봉 적재(멱등 업서트) + 서빙 조회.
//
// 설계 메모:
//  · 봉 1건 = 1행. [symbol, t] 복합 인덱스가 고유키이자 서빙 범위 조회 인덱스다.
//  · 업서트를 "봉마다 point lookup"으로 하면 500봉에 500번 인덱스 조회가 난다.
//    대신 배치의 [minT, maxT] 구간을 **한 번의 범위 스캔**으로 읽어 Map으로 만든 뒤 대조한다.
//  · 상한 없는 조회 금지(ops 최우선 가이드 규칙 2) — 적재·서빙 모두 take()로 못을 박는다.

import { internalMutation, internalQuery } from './_generated/server'
import { v } from 'convex/values'
import {
  DEFAULT_BAR_PAGE,
  INGEST_BAR_BATCH_MAX,
  MAX_BAR_PAGE,
  MAX_INDEX_SYMBOLS,
  type BarRow,
} from './lib/intradayServe'

const barValidator = v.object({
  t: v.number(),
  o: v.number(),
  h: v.number(),
  l: v.number(),
  c: v.number(),
  v: v.number(),
})

/**
 * 심볼 1개의 봉 배열 업서트. 1회 호출 상한 500봉 — 넘으면 거부한다(조용히 자르지 않는다).
 * 같은 [symbol, t]가 이미 있으면 값을 갱신하고, 없으면 삽입한다 → 재실행 안전.
 */
export const ingestBatch = internalMutation({
  args: {
    symbol: v.string(),
    bars: v.array(barValidator),
  },
  handler: async (ctx, { symbol, bars }) => {
    if (bars.length === 0) return { inserted: 0, updated: 0, skipped: 0 }
    if (bars.length > INGEST_BAR_BATCH_MAX) {
      throw new Error(`배치 상한 초과: ${bars.length}봉 (최대 ${INGEST_BAR_BATCH_MAX}) — 호출부에서 쪼개 보낼 것`)
    }

    // 같은 배치 안의 중복 t는 마지막 것만 남긴다(입력 정합성 방어).
    const byT = new Map<number, BarRow>()
    for (const b of bars) byT.set(b.t, b)

    const ts = [...byT.keys()]
    const minT = Math.min(...ts)
    const maxT = Math.max(...ts)

    // 구간 1회 스캔. 스캔량은 배치 폭 안의 기존 봉 수로 한정되며, take로 상한도 둔다.
    const existingDocs = await ctx.db
      .query('intradayBars')
      .withIndex('by_symbol_t', (q) => q.eq('symbol', symbol).gte('t', minT).lte('t', maxT))
      .take(INGEST_BAR_BATCH_MAX * 2)

    const existing = new Map(existingDocs.map((d) => [d.t, d]))

    let inserted = 0
    let updated = 0
    let skipped = 0
    for (const [t, b] of byT) {
      const cur = existing.get(t)
      if (!cur) {
        await ctx.db.insert('intradayBars', { symbol, t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v })
        inserted++
        continue
      }
      // 값이 같으면 쓰지 않는다 — 매일 같은 60일치를 다시 밀어도 쓰기가 발생하지 않게.
      if (cur.o === b.o && cur.h === b.h && cur.l === b.l && cur.c === b.c && cur.v === b.v) {
        skipped++
        continue
      }
      await ctx.db.patch(cur._id, { o: b.o, h: b.h, l: b.l, c: b.c, v: b.v })
      updated++
    }

    return { inserted, updated, skipped }
  },
})

/** 심볼 요약(index.json 한 줄 + 개별 파일의 coverage/tz) 업서트. */
export const upsertMeta = internalMutation({
  args: {
    symbol: v.string(),
    bars: v.number(),
    days: v.number(),
    first: v.string(),
    last: v.string(),
    thin: v.number(),
    coverage: v.optional(v.any()),
    tz: v.optional(v.string()),
    name: v.optional(v.string()),
    market: v.optional(v.string()),
    rank: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const updatedAt = new Date().toISOString()
    const existing = await ctx.db
      .query('intradayMeta')
      .withIndex('by_symbol', (q) => q.eq('symbol', args.symbol))
      .unique()
    if (existing) {
      await ctx.db.patch(existing._id, { ...args, updatedAt })
      return { updated: true as const, updatedAt }
    }
    await ctx.db.insert('intradayMeta', { ...args, updatedAt })
    return { updated: false as const, updatedAt }
  },
})

/** index.json 서빙용 — 심볼 요약 전체. 상한(MAX_INDEX_SYMBOLS)에 걸리면 truncated로 알린다. */
export const listMeta = internalQuery({
  args: {},
  handler: async (ctx) => {
    const metas = await ctx.db.query('intradayMeta').take(MAX_INDEX_SYMBOLS + 1)
    const truncated = metas.length > MAX_INDEX_SYMBOLS
    const page = truncated ? metas.slice(0, MAX_INDEX_SYMBOLS) : metas
    // 정적 index.json은 시총 랭킹 순이었으나 DB에는 랭킹이 아직 없다 — 심볼 오름차순으로
    // **결정적**으로 정렬한다(응답이 호출마다 달라지지 않게).
    page.sort((a, b) => (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0))
    return { metas: page, truncated }
  },
})

/** 개별 심볼 요약 1건. */
export const getMeta = internalQuery({
  args: { symbol: v.string() },
  handler: async (ctx, { symbol }) => {
    return await ctx.db
      .query('intradayMeta')
      .withIndex('by_symbol', (q) => q.eq('symbol', symbol))
      .unique()
  },
})

/**
 * 봉 페이지 조회.
 *  · from 없음  → 최신 limit봉(내림차순으로 take한 뒤 오름차순으로 뒤집어 반환)
 *  · from 있음  → t >= from 오름차순, limit+1개를 읽어 "더 있는지"를 count 없이 판정
 * 반환은 항상 **오름차순**이며, 마지막 원소는 호출부(sliceBarPage)가 잘라낼 수 있다.
 */
export const listBars = internalQuery({
  args: { symbol: v.string(), from: v.optional(v.number()), limit: v.optional(v.number()) },
  handler: async (ctx, { symbol, from, limit }) => {
    const n = Math.min(Math.max(1, Math.floor(limit ?? DEFAULT_BAR_PAGE)), MAX_BAR_PAGE)

    if (from == null) {
      const desc = await ctx.db
        .query('intradayBars')
        .withIndex('by_symbol_t', (q) => q.eq('symbol', symbol))
        .order('desc')
        .take(n)
      return desc.reverse().map(toBar)
    }

    const asc = await ctx.db
      .query('intradayBars')
      .withIndex('by_symbol_t', (q) => q.eq('symbol', symbol).gte('t', from))
      .take(n + 1) // +1 = hasMore 판정용
    return asc.map(toBar)
  },
})

function toBar(d: { t: number; o: number; h: number; l: number; c: number; v: number }): BarRow {
  return { t: d.t, o: d.o, h: d.h, l: d.l, c: d.c, v: d.v }
}
