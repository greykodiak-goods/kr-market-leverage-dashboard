import { useCallback, useState } from 'react'

const STORAGE_KEY = 'dashboard-section-order-v3'

// Persisted section ordering. The registry supplies the default id order; user
// reordering (drag or ▲▼) is stored as an id array in localStorage.
export function useSectionOrder(defaultOrder: string[]) {
  const [order, setOrderState] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (raw) {
        const saved = JSON.parse(raw) as string[]
        // Reconcile with the registry: keep saved order, drop unknown ids,
        // append any new sections not yet in the saved list.
        const known = saved.filter((id) => defaultOrder.includes(id))
        const missing = defaultOrder.filter((id) => !known.includes(id))
        return [...known, ...missing]
      }
    } catch {
      /* ignore */
    }
    return defaultOrder
  })

  const persist = useCallback((next: string[]) => {
    setOrderState(next)
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    } catch {
      /* ignore */
    }
  }, [])

  const setOrder = useCallback((next: string[]) => persist(next), [persist])

  const move = useCallback(
    (id: string, dir: -1 | 1) => {
      setOrderState((prev) => {
        const i = prev.indexOf(id)
        const j = i + dir
        if (i < 0 || j < 0 || j >= prev.length) return prev
        const next = [...prev]
        ;[next[i], next[j]] = [next[j], next[i]]
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
        } catch {
          /* ignore */
        }
        return next
      })
    },
    [],
  )

  const reset = useCallback(() => {
    try {
      localStorage.removeItem(STORAGE_KEY)
    } catch {
      /* ignore */
    }
    setOrderState(defaultOrder)
  }, [defaultOrder])

  return { order, setOrder, move, reset }
}
