import { useCallback, useMemo, useState } from 'react'
import {
  DEFAULT_KEYWORDS,
  loadKeywordState,
  saveKeywordState,
  type CategoryId,
  type Keyword,
} from '../lib/keywords'

export function useKeywords() {
  const [state, setState] = useState(loadKeywordState)

  const allKeywords: Keyword[] = useMemo(
    () => [...DEFAULT_KEYWORDS, ...state.custom],
    [state.custom],
  )

  const persist = useCallback((next: typeof state) => {
    setState(next)
    saveKeywordState(next)
  }, [])

  const toggle = useCallback(
    (id: string) => {
      const on = state.enabledIds.includes(id)
      const enabledIds = on ? state.enabledIds.filter((x) => x !== id) : [...state.enabledIds, id]
      persist({ ...state, enabledIds })
    },
    [state, persist],
  )

  const addCustom = useCallback(
    (label: string, category: CategoryId) => {
      const trimmed = label.trim()
      if (!trimmed) return
      const id = 'custom-' + trimmed.toLowerCase().replace(/\s+/g, '-') + '-' + Date.now().toString(36)
      const kw: Keyword = { id, label: trimmed, category, matchTerms: [trimmed.toLowerCase()], custom: true }
      persist({ enabledIds: [...state.enabledIds, id], custom: [...state.custom, kw] })
    },
    [state, persist],
  )

  const removeCustom = useCallback(
    (id: string) => {
      persist({
        enabledIds: state.enabledIds.filter((x) => x !== id),
        custom: state.custom.filter((k) => k.id !== id),
      })
    },
    [state, persist],
  )

  const enabledKeywords = useMemo(
    () => allKeywords.filter((k) => state.enabledIds.includes(k.id)),
    [allKeywords, state.enabledIds],
  )

  return { allKeywords, enabledIds: state.enabledIds, enabledKeywords, toggle, addCustom, removeCustom }
}
