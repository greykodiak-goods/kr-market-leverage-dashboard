import { useEffect, useRef } from 'react'
import { TABS, type TabId } from '../../dashboard/sections'

interface Props {
  active: TabId
  onSelect: (t: TabId) => void
}

// Sticky, accessible topic tab bar. Horizontal-scroll + snap on narrow screens.
export function TabBar({ active, onSelect }: Props) {
  const refs = useRef<Record<string, HTMLButtonElement | null>>({})

  useEffect(() => {
    refs.current[active]?.scrollIntoView({ inline: 'nearest', block: 'nearest' })
  }, [active])

  function onKeyDown(e: React.KeyboardEvent) {
    const i = TABS.findIndex((t) => t.id === active)
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault()
      const delta = e.key === 'ArrowRight' ? 1 : -1
      const next = TABS[(i + delta + TABS.length) % TABS.length]
      onSelect(next.id)
      refs.current[next.id]?.focus()
    }
  }

  return (
    <div className="tabbar" role="tablist" aria-label="대시보드 주제 탭" onKeyDown={onKeyDown}>
      {TABS.map((t) => {
        const sel = t.id === active
        return (
          <button
            key={t.id}
            ref={(el) => { refs.current[t.id] = el }}
            role="tab"
            id={`tab-${t.id}`}
            aria-selected={sel}
            aria-controls={`panel-${t.id}`}
            tabIndex={sel ? 0 : -1}
            className={`tab-btn${sel ? ' active' : ''}`}
            onClick={() => onSelect(t.id)}
          >
            <span className="tab-full">{t.label}</span>
            <span className="tab-short">{t.short}</span>
          </button>
        )
      })}
    </div>
  )
}
