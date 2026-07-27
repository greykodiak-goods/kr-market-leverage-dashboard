import { useEffect, useMemo, useRef, useState } from 'react'
import { formatDistanceToNowStrict } from 'date-fns'
import { ko } from 'date-fns/locale'
import { useKeywords } from '../hooks/useKeywords'
import { useNews } from '../hooks/useNews'
import { KeywordManager } from './KeywordManager'
import { HYNIX_KEYWORD_CONFIG, type CategoryId, type Keyword, type KeywordCatalogConfig } from '../lib/keywords'
import {
  DAY_GROUP_ORDER,
  addId,
  dayGroup,
  isNew,
  keywordSurges,
  loadPrefs,
  matchesQuery,
  savePrefs,
  toggleId,
  type DayGroup,
  type NewsPrefs,
} from '../lib/newsPrefs'

type SortMode = 'recent' | 'hot'
type ReadFilter = 'all' | 'unread' | 'marked'

const DEFAULT_MAX_AGE_DAYS = 5 // hide items older than this by default
const PAGE = 30 // 한 번에 보여줄 건수 (더보기로 확장)

interface NewsFeedProps {
  catalog?: KeywordCatalogConfig // keyword catalog config (defaults to Hynix feed)
  title?: string
  subtitle?: string
  cacheKey?: string // per-feed localStorage last-good cache (omit = Hynix default)
  maxAgeDays?: number // default display window (긴 호흡 피드는 더 넓게, e.g. giants 30일)
  /** 열람 상태(읽음·북마크) 저장 네임스페이스. 피드마다 분리 */
  prefsKey?: string
}

export function NewsFeed({
  catalog = HYNIX_KEYWORD_CONFIG,
  title = '하이닉스 영향 키워드 뉴스',
  subtitle,
  cacheKey,
  maxAgeDays = DEFAULT_MAX_AGE_DAYS,
  prefsKey = 'hynix',
}: NewsFeedProps = {}) {
  const { allKeywords, enabledIds, enabledKeywords, toggle, addCustom, removeCustom, resetKeywords } = useKeywords(catalog)
  const { data, isLoading, isError, error, isRefetching, refetch } = useNews(enabledKeywords, cacheKey, catalog.querySuffix)
  const [sort, setSort] = useState<SortMode>('hot')
  const [catFilter, setCatFilter] = useState<CategoryId | 'all'>('all')
  const [includeOld, setIncludeOld] = useState(false)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  // ---- 편의 기능 상태 ----
  const [query, setQuery] = useState('')
  const [readFilter, setReadFilter] = useState<ReadFilter>('all')
  const [sourceFilter, setSourceFilter] = useState<string>('all')
  const [limit, setLimit] = useState(PAGE)
  const [cursor, setCursor] = useState(-1) // 키보드 탐색 위치 (-1 = 선택 없음)
  const [prefs, setPrefs] = useState<NewsPrefs>(() => loadPrefs(prefsKey))
  const listRef = useRef<HTMLUListElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  // 이번 방문의 "이전 확인 시각" — 렌더 중 갱신되면 NEW 배지가 즉시 사라지므로
  // 마운트 시점 값을 고정해두고, 실제 lastSeen은 언마운트/이탈 때 저장한다.
  const seenAtMount = useRef(prefs.lastSeen)

  const updatePrefs = (fn: (p: NewsPrefs) => NewsPrefs) => {
    setPrefs((prev) => {
      const next = fn(prev)
      savePrefs(prefsKey, next)
      return next
    })
  }

  // 피드를 떠날 때 마지막 확인 시각을 지금으로. 다음 방문에서 NEW 판정 기준이 된다.
  useEffect(() => {
    return () => {
      const now = Date.now()
      setPrefs((prev) => {
        const next = { ...prev, lastSeen: now }
        savePrefs(prefsKey, next)
        return next
      })
    }
  }, [prefsKey])

  const kwById = useMemo(() => {
    const m = new Map<string, Keyword>()
    allKeywords.forEach((k) => m.set(k.id, k))
    return m
  }, [allKeywords])

  // 필터 이전의 원본 목록 — 급상승·매체목록 계산 기준
  const raw = data?.items ?? []

  const surges = useMemo(() => {
    if (!raw.length) return []
    return keywordSurges(raw, Date.now(), 24, 3).slice(0, 5)
  }, [raw])

  const sources = useMemo(() => {
    const counts = new Map<string, number>()
    for (const it of raw) {
      const s = it.source || '출처 미상'
      counts.set(s, (counts.get(s) ?? 0) + 1)
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)
  }, [raw])

  const filtered = useMemo(() => {
    let list = raw
    if (catFilter !== 'all') {
      list = list.filter((it) => it.matchedKeywordIds.some((id) => kwById.get(id)?.category === catFilter))
    }
    if (!includeOld) {
      const cutoff = Date.now() - maxAgeDays * 24 * 3600_000
      list = list.filter((it) => it.published >= cutoff)
    }
    if (sourceFilter !== 'all') list = list.filter((it) => (it.source || '출처 미상') === sourceFilter)
    if (readFilter === 'unread') list = list.filter((it) => !prefs.read.includes(it.id))
    if (readFilter === 'marked') list = list.filter((it) => prefs.marks.includes(it.id))
    if (query.trim()) list = list.filter((it) => matchesQuery(it, query))
    return [...list].sort((a, b) => (sort === 'recent' ? b.published - a.published : b.score - a.score))
  }, [raw, sort, catFilter, kwById, includeOld, maxAgeDays, sourceFilter, readFilter, prefs.read, prefs.marks, query])

  const items = filtered.slice(0, limit)

  // 필터가 바뀌면 페이지·커서를 처음으로
  useEffect(() => {
    setLimit(PAGE)
    setCursor(-1)
  }, [sort, catFilter, includeOld, sourceFilter, readFilter, query])

  // 최신순일 때만 날짜 그룹 헤더를 붙인다(화제순은 시간 순서가 아니라 의미 없음)
  const grouped = useMemo(() => {
    if (sort !== 'recent') return null
    const now = Date.now()
    const map = new Map<DayGroup, typeof items>()
    for (const it of items) {
      const g = dayGroup(it.published, now)
      const arr = map.get(g) ?? []
      arr.push(it)
      map.set(g, arr)
    }
    return DAY_GROUP_ORDER.filter((g) => map.has(g)).map((g) => ({ group: g, rows: map.get(g)! }))
  }, [items, sort])

  const markRead = (id: string) => updatePrefs((p) => ({ ...p, read: addId(p.read, id) }))
  const toggleMark = (id: string) => updatePrefs((p) => ({ ...p, marks: toggleId(p.marks, id) }))
  const toggleRead = (id: string) =>
    updatePrefs((p) => ({ ...p, read: p.read.includes(id) ? p.read.filter((x) => x !== id) : addId(p.read, id) }))

  const toggleExpand = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })

  // ---- 키보드 단축키 (j/k 이동 · o 열기 · m 읽음 · b 북마크 · / 검색) ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null
      const typing = el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
      if (typing) {
        if (e.key === 'Escape') (el as HTMLInputElement).blur()
        return
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return
      // 이 피드가 화면에 없으면(다른 탭) 단축키를 먹지 않는다
      if (!listRef.current?.isConnected) return

      if (e.key === '/') {
        e.preventDefault()
        searchRef.current?.focus()
        return
      }
      if (e.key === 'j' || e.key === 'k') {
        e.preventDefault()
        setCursor((c) => {
          const n = e.key === 'j' ? c + 1 : c - 1
          return Math.max(0, Math.min(items.length - 1, n))
        })
        return
      }
      if (cursor < 0 || cursor >= items.length) return
      const it = items[cursor]
      if (e.key === 'o' || e.key === 'Enter') {
        e.preventDefault()
        markRead(it.id)
        window.open(it.link, '_blank', 'noopener,noreferrer')
      } else if (e.key === 'm') {
        e.preventDefault()
        toggleRead(it.id)
      } else if (e.key === 'b') {
        e.preventDefault()
        toggleMark(it.id)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [items, cursor]) // eslint-disable-line react-hooks/exhaustive-deps

  // 커서가 움직이면 해당 행을 화면 안으로
  useEffect(() => {
    if (cursor < 0) return
    listRef.current?.querySelectorAll('.news-item')[cursor]?.scrollIntoView({ block: 'nearest' })
  }, [cursor])

  const totalClustered = raw.length
  const unreadCount = raw.filter((it) => !prefs.read.includes(it.id)).length

  const renderItem = (it: (typeof items)[number], idx: number) => {
    const read = prefs.read.includes(it.id)
    const marked = prefs.marks.includes(it.id)
    const fresh = isNew(it.published, { ...prefs, lastSeen: seenAtMount.current }, it.id)
    return (
      <li
        key={it.id}
        className={`news-item${read ? ' read' : ''}${cursor === idx ? ' cursor' : ''}`}
        onMouseEnter={() => setCursor(idx)}
      >
        <div className="news-main">
          <a
            href={it.link}
            target="_blank"
            rel="noopener noreferrer"
            className="news-title"
            onClick={() => markRead(it.id)}
          >
            {fresh && <span className="new-badge">NEW</span>}
            {it.hot && <span className="hot-badge">🔥 화제</span>}
            {it.title}
          </a>
          <div className="news-meta">
            <span className="news-source">{it.source || '출처 미상'}</span>
            <span className="news-dot">·</span>
            <span>{timeAgo(it.published)}</span>
            {it.clusterSize > 1 && (
              <>
                <span className="news-dot">·</span>
                <button
                  className="news-cluster-btn"
                  aria-expanded={expanded.has(it.id)}
                  onClick={() => toggleExpand(it.id)}
                >
                  {it.clusterSize}개 매체 보도
                  <span className={`news-cluster-chevron${expanded.has(it.id) ? ' open' : ''}`}>▾</span>
                </button>
              </>
            )}
            <span className="news-dot">·</span>
            <button
              type="button"
              className={`news-act${marked ? ' on' : ''}`}
              onClick={() => toggleMark(it.id)}
              aria-pressed={marked}
              title="북마크 (b)"
            >
              {marked ? '★ 저장됨' : '☆ 저장'}
            </button>
            <button
              type="button"
              className={`news-act${read ? ' on' : ''}`}
              onClick={() => toggleRead(it.id)}
              aria-pressed={read}
              title="읽음 표시 (m)"
            >
              {read ? '✓ 읽음' : '읽음 표시'}
            </button>
          </div>
          {expanded.has(it.id) && it.sources.length > 1 && (
            <div className="news-sources-wrap">
              <div className="news-sources">
                {it.sources.map((s, i) => (
                  <a key={i} href={s.link} target="_blank" rel="noopener noreferrer" className="news-source-pill">
                    <span className="news-source-avatar" style={{ background: sourceColor(s.source) }}>
                      {sourceInitial(s.source)}
                    </span>
                    {s.source || '매체'}
                  </a>
                ))}
              </div>
            </div>
          )}
        </div>
        <div className="news-chips">
          {it.matchedKeywordIds.slice(0, 4).map((id) => (
            <span key={id} className="news-kw-chip">
              {kwById.get(id)?.label ?? id}
            </span>
          ))}
          {it.matchedKeywordIds.length > 4 && <span className="news-kw-chip">+{it.matchedKeywordIds.length - 4}</span>}
        </div>
      </li>
    )
  }

  return (
    <section className="panel news-panel">
      <div className="panel-head" style={{ alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <div>
          <h2>{title}</h2>
          <div className="panel-sub">
            {subtitle && (
              <>
                {subtitle}
                <br />
              </>
            )}
            Google 뉴스 · 사건 단위 클러스터링(중복 병합)
            {data && ` · ${totalClustered}건 사건`}
            {data && unreadCount > 0 && ` · 안 읽음 ${unreadCount}`}
            {data?.stale && ' · 캐시(갱신실패)'}
            {data?.partial && (
              <>
                {' · 일부 키워드 배치 실패(속도제한 가능성)'}
                <button
                  type="button"
                  className="retry-btn retry-btn-inline"
                  onClick={() => refetch()}
                  disabled={isRefetching}
                >
                  {isRefetching ? '재시도 중…' : '↻ 재시도'}
                </button>
              </>
            )}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <div className="period-selector">
            <button className={`period-btn${sort === 'hot' ? ' active' : ''}`} onClick={() => setSort('hot')}>
              화제순
            </button>
            <button className={`period-btn${sort === 'recent' ? ' active' : ''}`} onClick={() => setSort('recent')}>
              최신순
            </button>
          </div>
        </div>
      </div>

      {/* 급상승 키워드 — "지금 뭐가 터졌나"를 한 줄로 */}
      {surges.length > 0 && (
        <div className="news-surge">
          <span className="news-surge-lbl">📈 24시간 급상승</span>
          {surges.map((s) => (
            <button
              key={s.keywordId}
              type="button"
              className="news-surge-chip"
              onClick={() => setQuery(kwById.get(s.keywordId)?.label ?? s.keywordId)}
              title={`최근 24h ${s.recent}건 · 직전 24h ${s.prior}건`}
            >
              {kwById.get(s.keywordId)?.label ?? s.keywordId}
              <strong>×{s.ratio.toFixed(1)}</strong>
            </button>
          ))}
          <span className="news-surge-note">직전 24시간 대비 언급 배수 · 누르면 검색</span>
        </div>
      )}

      {/* 검색 + 읽음 필터 */}
      <div className="news-searchbar">
        <div className="news-search-wrap">
          <span className="news-search-icon" aria-hidden>🔍</span>
          <input
            ref={searchRef}
            type="search"
            className="news-search"
            placeholder="제목·매체 검색 (단축키 /)"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="뉴스 검색"
          />
          {query && (
            <button type="button" className="news-search-clear" onClick={() => setQuery('')} aria-label="검색어 지우기">
              ✕
            </button>
          )}
        </div>
        <div className="cat-tabs">
          {(
            [
              { id: 'all', label: '전체' },
              { id: 'unread', label: '안 읽음' },
              { id: 'marked', label: `★ 저장 ${prefs.marks.length || ''}`.trim() },
            ] as const
          ).map((f) => (
            <button
              key={f.id}
              className={`cat-tab${readFilter === f.id ? ' active' : ''}`}
              onClick={() => setReadFilter(f.id as ReadFilter)}
            >
              {f.label}
            </button>
          ))}
        </div>
        <select
          className="news-source-select"
          value={sourceFilter}
          onChange={(e) => setSourceFilter(e.target.value)}
          aria-label="매체 필터"
        >
          <option value="all">전체 매체</option>
          {sources.map(([s, n]) => (
            <option key={s} value={s}>
              {s} ({n})
            </option>
          ))}
        </select>
      </div>

      <div className="news-controls">
        <div className="cat-tabs">
          <button className={`cat-tab${catFilter === 'all' ? ' active' : ''}`} onClick={() => setCatFilter('all')}>
            전체
          </button>
          {catalog.categories.map((c) => (
            <button
              key={c.id}
              className={`cat-tab${catFilter === c.id ? ' active' : ''}`}
              onClick={() => setCatFilter(c.id)}
            >
              {c.label}
            </button>
          ))}
          <button
            className={`cat-tab${includeOld ? ' active' : ''}`}
            onClick={() => setIncludeOld((v) => !v)}
            title={`${maxAgeDays}일 초과 뉴스 표시`}
          >
            {includeOld ? '오래된 뉴스 포함' : `최근 ${maxAgeDays}일만`}
          </button>
        </div>
        <KeywordManager
          allKeywords={allKeywords}
          enabledIds={enabledIds}
          categories={catalog.categories}
          onToggle={toggle}
          onAdd={addCustom}
          onRemove={removeCustom}
          onReset={resetKeywords}
        />
      </div>

      {isLoading && !data ? (
        <ul className="skeleton-news-list" aria-label="뉴스 불러오는 중" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {Array.from({ length: 5 }).map((_, i) => (
            <li key={i} className="skeleton-news-item">
              <div className="skeleton skeleton-title" />
              <div className="skeleton skeleton-meta" />
            </li>
          ))}
        </ul>
      ) : isError && !data ? (
        <div className="news-empty err">
          뉴스를 불러오지 못했습니다. Google 뉴스 속도제한일 수 있습니다 — 잠시 후 자동 재시도합니다.
          <div style={{ fontSize: 11, marginTop: 4, color: 'var(--text-faint)' }}>{String((error as Error)?.message ?? '')}</div>
          <button type="button" className="retry-btn" onClick={() => refetch()} disabled={isRefetching}>
            {isRefetching ? '재시도 중…' : '↻ 지금 다시 시도'}
          </button>
        </div>
      ) : items.length === 0 ? (
        <div className="news-empty">
          {query || readFilter !== 'all' || sourceFilter !== 'all'
            ? '조건에 맞는 뉴스가 없습니다. 검색어나 필터를 바꿔보세요.'
            : '표시할 뉴스가 없습니다. 키워드를 켜거나 필터를 바꿔보세요.'}
        </div>
      ) : (
        <>
          <ul className="news-list" ref={listRef}>
            {grouped
              ? grouped.map((g) => {
                  // 그룹 헤더를 넣어도 커서 인덱스는 전체 목록 기준을 유지해야 한다
                  const offset = items.indexOf(g.rows[0])
                  return (
                    <li key={g.group} className="news-group">
                      <div className="news-group-head">
                        {g.group} <span className="news-group-n">{g.rows.length}</span>
                      </div>
                      <ul className="news-sublist">{g.rows.map((it, i) => renderItem(it, offset + i))}</ul>
                    </li>
                  )
                })
              : items.map((it, i) => renderItem(it, i))}
          </ul>
          {filtered.length > items.length && (
            <button type="button" className="news-more" onClick={() => setLimit((l) => l + PAGE)}>
              더 보기 ({items.length} / {filtered.length})
            </button>
          )}
        </>
      )}

      <div className="news-foot">
        출처: Google 뉴스 RSS · 헤드라인/링크만 표기(원문은 각 매체). 동일 사건은 한 카드로 병합, "N개 매체 보도"로 표시.
        화제도 = 교차보도량+상관도+최신성 합성치(조회수 대용).
        <br />
        단축키: <code>j</code>/<code>k</code> 이동 · <code>o</code> 열기 · <code>m</code> 읽음 · <code>b</code> 저장 ·{' '}
        <code>/</code> 검색. 읽음·저장 표시는 <strong>이 브라우저에만</strong> 남고 기기 간 동기화되지 않습니다.
      </div>
    </section>
  )
}

function timeAgo(ms: number): string {
  try {
    return formatDistanceToNowStrict(new Date(ms), { addSuffix: true, locale: ko })
  } catch {
    return ''
  }
}

// Google News RSS only exposes the outlet name (no stable publisher domain for
// favicons), so we derive a deterministic color + initial as a lightweight
// stand-in "logo" instead of fetching per-outlet icons.
function sourceInitial(source: string): string {
  const trimmed = source.trim()
  return trimmed ? Array.from(trimmed)[0].toUpperCase() : '?'
}

function sourceColor(source: string): string {
  let hash = 0
  for (const ch of source) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0
  const hue = hash % 360
  return `hsl(${hue} 55% 42%)`
}
