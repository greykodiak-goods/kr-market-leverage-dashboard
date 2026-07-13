import { useEffect, useState } from 'react'
import { DEFAULT_TAB, isTabId, type TabId } from '../../dashboard/sections'

function readHash(): TabId {
  const h = (location.hash || '').replace(/^#/, '')
  return isTabId(h) ? h : DEFAULT_TAB
}

// Two-way sync of the active tab with the URL hash (#hynix / #semi / …).
// replaceState so Back exits the site rather than cycling tabs; hashchange
// handles manual URL edits and browser back/forward.
export function useTabHash(): [TabId, (t: TabId) => void] {
  const [tab, setTab] = useState<TabId>(readHash)

  useEffect(() => {
    const onHash = () => setTab(readHash())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  const select = (t: TabId) => {
    setTab(t)
    const target = `#${t}`
    if (location.hash !== target) history.replaceState(null, '', target)
  }

  // Ensure the URL reflects the initial (possibly defaulted) tab.
  useEffect(() => {
    const target = `#${tab}`
    if (location.hash !== target) history.replaceState(null, '', target)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return [tab, select]
}
