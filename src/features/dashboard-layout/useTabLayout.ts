import { useCallback, useState } from 'react'
import { defaultTabLayout, SECTIONS, TABS, type TabId } from '../../dashboard/sections'

const V4_KEY = 'dashboard-tab-layout-v4'
const V3_KEY = 'dashboard-section-order-v3' // legacy flat order for migration

type TabLayout = Record<TabId, string[]>

// Reconcile a saved per-tab map with the registry:
//  (a) drop ids no longer in the registry / not belonging to that tab,
//  (b) append each tab's default members missing from the saved list.
function reconcile(saved: Partial<Record<TabId, string[]>>): TabLayout {
  const base = defaultTabLayout()
  const out = {} as TabLayout
  for (const t of TABS) {
    const allowed = base[t.id] // valid ids for this tab
    const savedIds = (saved[t.id] ?? []).filter((id) => allowed.includes(id))
    const missing = allowed.filter((id) => !savedIds.includes(id))
    out[t.id] = [...savedIds, ...missing]
  }
  return out
}

// One-time migration: flat v3 order → per-tab v4 map (preserve relative order).
function migrateFromV3(): TabLayout {
  const base = defaultTabLayout()
  try {
    const raw = localStorage.getItem(V3_KEY)
    if (!raw) return base
    const flat = JSON.parse(raw) as string[]
    const tabOf = new Map(SECTIONS.map((s) => [s.id, s.tab]))
    const out = {} as TabLayout
    for (const t of TABS) out[t.id] = []
    // place saved ids into their tab buckets in saved order
    for (const id of flat) {
      const tab = tabOf.get(id)
      if (tab && base[tab].includes(id) && !out[tab].includes(id)) out[tab].push(id)
    }
    return reconcile(out)
  } catch {
    return base
  }
}

function load(): TabLayout {
  try {
    const raw = localStorage.getItem(V4_KEY)
    if (raw) return reconcile(JSON.parse(raw) as Partial<Record<TabId, string[]>>)
  } catch {
    /* fall through */
  }
  // no v4 yet → migrate from v3 if present, else defaults
  const migrated = migrateFromV3()
  try {
    localStorage.setItem(V4_KEY, JSON.stringify(migrated))
  } catch {
    /* ignore */
  }
  return migrated
}

export function useTabLayout() {
  const [layout, setLayout] = useState<TabLayout>(load)

  const persist = useCallback((next: TabLayout) => {
    setLayout(next)
    try {
      localStorage.setItem(V4_KEY, JSON.stringify(next))
    } catch {
      /* ignore */
    }
  }, [])

  const setTabOrder = useCallback(
    (tab: TabId, order: string[]) => {
      setLayout((prev) => {
        const next = { ...prev, [tab]: order }
        try {
          localStorage.setItem(V4_KEY, JSON.stringify(next))
        } catch {
          /* ignore */
        }
        return next
      })
    },
    [],
  )

  const move = useCallback((tab: TabId, id: string, dir: -1 | 1) => {
    setLayout((prev) => {
      const arr = prev[tab]
      const i = arr.indexOf(id)
      const j = i + dir
      if (i < 0 || j < 0 || j >= arr.length) return prev
      const nextArr = [...arr]
      ;[nextArr[i], nextArr[j]] = [nextArr[j], nextArr[i]]
      const next = { ...prev, [tab]: nextArr }
      try {
        localStorage.setItem(V4_KEY, JSON.stringify(next))
      } catch {
        /* ignore */
      }
      return next
    })
  }, [])

  const reset = useCallback(() => {
    try {
      localStorage.removeItem(V4_KEY)
    } catch {
      /* ignore */
    }
    persist(defaultTabLayout())
  }, [persist])

  return { layout, setTabOrder, move, reset }
}
