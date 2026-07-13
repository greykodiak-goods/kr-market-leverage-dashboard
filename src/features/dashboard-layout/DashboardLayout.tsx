import { useMemo } from 'react'
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import { arrayMove, SortableContext, sortableKeyboardCoordinates, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { SECTIONS } from '../../dashboard/sections'
import { SortableSection } from './SortableSection'

interface Props {
  editing: boolean
  order: string[]
  onReorder: (next: string[]) => void
  onMove: (id: string, dir: -1 | 1) => void
}

// Thin, data-driven layout: renders sections in the given order from the
// registry. No section-specific logic lives here.
export function DashboardLayout({ editing, order, onReorder, onMove }: Props) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 180, tolerance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  const sectionById = useMemo(() => new Map(SECTIONS.map((s) => [s.id, s])), [])

  function onDragEnd(e: DragEndEvent) {
    const { active, over } = e
    if (!over || active.id === over.id) return
    const oldIndex = order.indexOf(String(active.id))
    const newIndex = order.indexOf(String(over.id))
    if (oldIndex < 0 || newIndex < 0) return
    onReorder(arrayMove(order, oldIndex, newIndex))
  }

  const ordered = order.map((id) => sectionById.get(id)).filter(Boolean) as typeof SECTIONS

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <SortableContext items={order} strategy={verticalListSortingStrategy}>
        {ordered.map((s, i) => {
          const Comp = s.Component
          return (
            <SortableSection
              key={s.id}
              id={s.id}
              title={s.title}
              editing={editing}
              isFirst={i === 0}
              isLast={i === ordered.length - 1}
              onMove={onMove}
            >
              <Comp />
            </SortableSection>
          )
        })}
      </SortableContext>
    </DndContext>
  )
}
