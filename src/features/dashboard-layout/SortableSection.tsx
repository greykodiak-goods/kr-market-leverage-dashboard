import type { ReactNode } from 'react'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'

interface Props {
  id: string
  title: string
  editing: boolean
  isFirst: boolean
  isLast: boolean
  onMove: (id: string, dir: -1 | 1) => void
  children: ReactNode
}

// Wraps a dashboard section. In edit mode it shows a drag handle (desktop/touch)
// plus ▲▼ buttons (reliable mobile/a11y fallback).
export function SortableSection({ id, title, editing, isFirst, isLast, onMove, children }: Props) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
    id,
    disabled: !editing,
  })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : 1,
    position: 'relative' as const,
    zIndex: isDragging ? 5 : 'auto',
  }

  return (
    <section ref={setNodeRef} style={style} className={`dash-section${editing ? ' editing' : ''}`}>
      {editing && (
        <div className="section-editbar">
          <button
            ref={setActivatorNodeRef}
            className="drag-handle"
            aria-label={`${title} 드래그로 이동`}
            {...attributes}
            {...listeners}
          >
            ⠿ {title}
          </button>
          <div className="move-btns">
            <button aria-label="위로 이동" disabled={isFirst} onClick={() => onMove(id, -1)}>▲</button>
            <button aria-label="아래로 이동" disabled={isLast} onClick={() => onMove(id, 1)}>▼</button>
          </div>
        </div>
      )}
      {children}
    </section>
  )
}
