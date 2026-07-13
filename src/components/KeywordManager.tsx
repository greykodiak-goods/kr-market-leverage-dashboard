import { useState } from 'react'
import { CATEGORIES, type CategoryId, type Keyword } from '../lib/keywords'

interface Props {
  allKeywords: Keyword[]
  enabledIds: string[]
  onToggle: (id: string) => void
  onAdd: (label: string, category: CategoryId) => void
  onRemove: (id: string) => void
}

export function KeywordManager({ allKeywords, enabledIds, onToggle, onAdd, onRemove }: Props) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const [cat, setCat] = useState<CategoryId>('tech')

  const enabledCount = enabledIds.length

  return (
    <div className="kw-manager">
      <button type="button" className="kw-toggle" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        키워드 관리 ({enabledCount}) {open ? '▲' : '▼'}
      </button>

      {open && (
        <div className="kw-panel">
          {CATEGORIES.map((c) => {
            const kws = allKeywords.filter((k) => k.category === c.id)
            return (
              <div key={c.id} className="kw-group">
                <div className="kw-group-label">{c.label}</div>
                <div className="kw-chips">
                  {kws.map((k) => {
                    const on = enabledIds.includes(k.id)
                    return (
                      <span key={k.id} className={`kw-chip${on ? ' on' : ''}`}>
                        <button type="button" className="kw-chip-btn" onClick={() => onToggle(k.id)} aria-pressed={on}>
                          {k.label}
                        </button>
                        {k.custom && (
                          <button type="button" className="kw-chip-x" title="삭제" onClick={() => onRemove(k.id)}>
                            ×
                          </button>
                        )}
                      </span>
                    )
                  })}
                </div>
              </div>
            )
          })}

          <div className="kw-add">
            <select value={cat} onChange={(e) => setCat(e.target.value as CategoryId)} aria-label="카테고리">
              {CATEGORIES.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
            <input
              type="text"
              value={draft}
              placeholder="키워드 추가"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  onAdd(draft, cat)
                  setDraft('')
                }
              }}
            />
            <button
              type="button"
              onClick={() => {
                onAdd(draft, cat)
                setDraft('')
              }}
            >
              추가
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
