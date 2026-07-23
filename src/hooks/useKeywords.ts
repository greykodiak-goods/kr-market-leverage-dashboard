import { useCallback, useMemo, useState } from 'react'
import {
  HYNIX_KEYWORD_CONFIG,
  loadKeywordState,
  saveKeywordState,
  type CategoryId,
  type Keyword,
  type KeywordCatalogConfig,
} from '../lib/keywords'

// Keyword toggle/add/remove state for ONE catalog. Defaults to the Hynix
// catalog (100% backward compatible); pass another KeywordCatalogConfig
// (e.g. mega-investors) to run an independent feed with its own storage key.
export function useKeywords(cfg: KeywordCatalogConfig = HYNIX_KEYWORD_CONFIG) {
  const [state, setState] = useState(() => loadKeywordState(cfg.defaults, cfg.storageKey))

  const allKeywords: Keyword[] = useMemo(
    () => [...cfg.defaults, ...state.custom],
    [cfg.defaults, state.custom],
  )

  const persist = useCallback(
    (next: typeof state) => {
      setState(next)
      saveKeywordState(next, cfg.storageKey)
    },
    [cfg.storageKey],
  )

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

  const resetKeywords = useCallback(() => {
    persist({ enabledIds: cfg.defaults.map((k) => k.id), custom: [] })
  }, [persist, cfg.defaults])

  const enabledKeywords = useMemo(
    () => allKeywords.filter((k) => state.enabledIds.includes(k.id)),
    [allKeywords, state.enabledIds],
  )

  return { allKeywords, enabledIds: state.enabledIds, enabledKeywords, toggle, addCustom, removeCustom, resetKeywords }
}
