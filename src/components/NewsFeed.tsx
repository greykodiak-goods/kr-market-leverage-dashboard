import { useMemo, useState } from 'react'
import { formatDistanceToNowStrict } from 'date-fns'
import { ko } from 'date-fns/locale'
import { useKeywords } from '../hooks/useKeywords'
import { useNews } from '../hooks/useNews'
import { KeywordManager } from './KeywordManager'
import { CATEGORIES, type CategoryId, type Keyword } from '../lib/keywords'

type SortMode = 'recent' | 'hot'

export function NewsFeed() {
  const { allKeywords, enabledIds, enabledKeywords, toggle, addCustom, removeCustom } = useKeywords()
  const { data, isLoading, isError, error } = useNews(enabledKeywords)
  const [sort, setSort] = useState<SortMode>('hot')
  const [catFilter, setCatFilter] = useState<CategoryId | 'all'>('all')

  const kwById = useMemo(() => {
    const m = new Map<string, Keyword>()
    allKeywords.forEach((k) => m.set(k.id, k))
    return m
  }, [allKeywords])

  const items = useMemo(() => {
    let list = data?.items ?? []
    if (catFilter !== 'all') {
      list = list.filter((it) =>
        it.matchedKeywordIds.some((id) => kwById.get(id)?.category === catFilter),
      )
    }
    const sorted = [...list].sort((a, b) =>
      sort === 'recent' ? b.published - a.published : b.score - a.score,
    )
    return sorted.slice(0, 40)
  }, [data, sort, catFilter, kwById])

  return (
    <section className="panel news-panel">
      <div className="panel-head" style={{ alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <div>
          <h2>하이닉스 영향 키워드 뉴스</h2>
          <div className="panel-sub">
            Google 뉴스 실시간 · 교차보도·상관도·최신성 합성 화제 랭킹
            {data?.stale && ' · 캐시(갱신실패)'}
            {data?.partial && ' · 일부 배치 실패'}
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

      <div className="news-controls">
        <div className="cat-tabs">
          <button className={`cat-tab${catFilter === 'all' ? ' active' : ''}`} onClick={() => setCatFilter('all')}>
            전체
          </button>
          {CATEGORIES.map((c) => (
            <button
              key={c.id}
              className={`cat-tab${catFilter === c.id ? ' active' : ''}`}
              onClick={() => setCatFilter(c.id)}
            >
              {c.label}
            </button>
          ))}
        </div>
        <KeywordManager
          allKeywords={allKeywords}
          enabledIds={enabledIds}
          onToggle={toggle}
          onAdd={addCustom}
          onRemove={removeCustom}
        />
      </div>

      {isLoading && !data ? (
        <div className="news-empty">뉴스 불러오는 중…</div>
      ) : isError && !data ? (
        <div className="news-empty err">
          뉴스를 불러오지 못했습니다. Google 뉴스 속도제한일 수 있습니다 — 잠시 후 자동 재시도합니다.
          <div style={{ fontSize: 11, marginTop: 4, color: 'var(--text-faint)' }}>{String((error as Error)?.message ?? '')}</div>
        </div>
      ) : items.length === 0 ? (
        <div className="news-empty">표시할 뉴스가 없습니다. 키워드를 켜거나 카테고리 필터를 바꿔보세요.</div>
      ) : (
        <ul className="news-list">
          {items.map((it) => (
            <li key={it.id} className="news-item">
              <div className="news-main">
                <a href={it.link} target="_blank" rel="noopener noreferrer" className="news-title">
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
                      <span>{it.clusterSize}개 매체</span>
                    </>
                  )}
                </div>
              </div>
              <div className="news-chips">
                {it.matchedKeywordIds.slice(0, 4).map((id) => (
                  <span key={id} className="news-kw-chip">
                    {kwById.get(id)?.label ?? id}
                  </span>
                ))}
              </div>
            </li>
          ))}
        </ul>
      )}

      <div className="news-foot">
        출처: Google 뉴스 RSS · 헤드라인/링크만 표기(원문은 각 매체). 폴링 5분 · 조회수 대용은 교차보도량+상관도+최신성 합성치입니다.
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
