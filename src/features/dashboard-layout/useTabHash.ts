import { useEffect, useState } from 'react'
import { DEFAULT_TAB, isTabId, type TabId } from '../../dashboard/sections'

// 해시는 '탭' 또는 '탭/하위경로' 형태다(예: '#sim/dual-momentum').
// 탭 판별은 첫 구획만 본다 — 하위 경로는 각 섹션이 스스로 해석한다.
function readHash(): TabId {
  const h = (location.hash || '').replace(/^#/, '')
  const tab = h.split('/')[0]
  return isTabId(tab) ? tab : DEFAULT_TAB
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
    // 탭 전환은 하위 경로를 버린다(#sim/xxx → #news)
    const target = `#${t}`
    if (location.hash !== target) history.replaceState(null, '', target)
  }

  // Ensure the URL reflects the initial (possibly defaulted) tab.
  // 하위 경로(#sim/xxx)로 진입한 경우에는 건드리지 않는다.
  useEffect(() => {
    const raw = (location.hash || '').replace(/^#/, '')
    if (raw.includes('/')) return
    const target = `#${tab}`
    if (location.hash !== target) history.replaceState(null, '', target)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return [tab, select]
}
