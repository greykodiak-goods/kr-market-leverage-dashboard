// 뉴스 열람 상태 — 읽음·북마크·최근 확인 시각을 피드별로 보관한다.
//
// 매일 같은 피드를 보는 사람에게 가장 큰 편의는 "지난번 이후 새로 뜬 게 뭔가"이다.
// 그래서 읽음 표시와 마지막 확인 시각을 저장한다. 서버가 없으므로 localStorage 전용이며,
// 기기 간 동기화는 되지 않는다(화면에 명시).
//
// 저장 크기 관리: 읽음 id는 무한히 쌓이면 용량을 먹으므로 상한을 두고 오래된 것부터 버린다.
// 클러스터 id는 대표 제목 기반이라 기사가 사라져도 id는 남는데, 어차피 상한에서 밀려난다.

const PREFIX = 'news-prefs:'
const READ_CAP = 800 // 읽음 id 보관 상한 (초과 시 오래된 것부터 제거)
const MARK_CAP = 300 // 북마크 상한

export interface NewsPrefs {
  /** 읽은 클러스터 id — 앞이 오래된 것, 뒤가 최신 */
  read: string[]
  /** 북마크한 클러스터 id */
  marks: string[]
  /** 마지막으로 피드를 확인한 시각(epoch ms). 0이면 확인 이력 없음 */
  lastSeen: number
}

export const EMPTY_PREFS: NewsPrefs = { read: [], marks: [], lastSeen: 0 }

function keyOf(feed: string): string {
  return `${PREFIX}${feed}`
}

export function loadPrefs(feed: string): NewsPrefs {
  try {
    const raw = localStorage.getItem(keyOf(feed))
    if (!raw) return { ...EMPTY_PREFS }
    const p = JSON.parse(raw) as Partial<NewsPrefs>
    return {
      read: Array.isArray(p.read) ? p.read.filter((x): x is string => typeof x === 'string') : [],
      marks: Array.isArray(p.marks) ? p.marks.filter((x): x is string => typeof x === 'string') : [],
      lastSeen: typeof p.lastSeen === 'number' && Number.isFinite(p.lastSeen) ? p.lastSeen : 0,
    }
  } catch {
    return { ...EMPTY_PREFS }
  }
}

export function savePrefs(feed: string, p: NewsPrefs): void {
  try {
    localStorage.setItem(keyOf(feed), JSON.stringify(trimPrefs(p)))
  } catch {
    /* 용량 초과 등 — 열람 상태는 없어도 기능이 죽지 않으므로 조용히 무시 */
  }
}

/** 상한을 넘긴 항목을 오래된 쪽부터 잘라낸다. */
export function trimPrefs(p: NewsPrefs): NewsPrefs {
  return {
    read: p.read.length > READ_CAP ? p.read.slice(p.read.length - READ_CAP) : p.read,
    marks: p.marks.length > MARK_CAP ? p.marks.slice(p.marks.length - MARK_CAP) : p.marks,
    lastSeen: p.lastSeen,
  }
}

/** 이미 있으면 그대로, 없으면 뒤에 붙인다(중복 없이 최신이 뒤). */
export function addId(list: string[], id: string): string[] {
  return list.includes(id) ? list : [...list, id]
}

export function removeId(list: string[], id: string): string[] {
  return list.filter((x) => x !== id)
}

export function toggleId(list: string[], id: string): string[] {
  return list.includes(id) ? removeId(list, id) : addId(list, id)
}

/**
 * 기사가 "새 것"인가 — 마지막 확인 시각 이후 나왔고 아직 안 읽은 것.
 * lastSeen이 0(첫 방문)이면 전부 새 것으로 보지 않는다. 첫 화면이 온통 NEW가 되면
 * 표시가 무의미해지기 때문이다.
 */
export function isNew(publishedMs: number, prefs: NewsPrefs, id: string): boolean {
  if (prefs.lastSeen <= 0) return false
  if (prefs.read.includes(id)) return false
  return publishedMs > prefs.lastSeen
}

// ---- 키워드 급상승 --------------------------------------------------------

export interface KeywordSurge {
  keywordId: string
  recent: number // 최근 창 내 언급 사건 수
  prior: number // 직전 동일 길이 창 언급 수
  ratio: number // recent / max(prior, 1)
}

/**
 * 키워드별 언급량 급상승 — "지금 뭐가 터졌나"를 한 줄로 보여주기 위한 계산.
 *
 * 최근 windowHours 구간과 그 직전 동일 길이 구간의 언급 사건 수를 비교한다.
 * 비교 기준을 전체 기간 평균으로 잡지 않는 이유: 피드에 담긴 기간이 들쭉날쭉해서
 * 전체 평균은 창 길이에 따라 의미가 달라지기 때문이다. 인접 두 창 비교가 더 정직하다.
 *
 * @param now 기준 시각(주입 — 테스트 재현성)
 * @param minRecent 이 미만이면 급상승으로 치지 않는다(1~2건은 노이즈)
 */
export function keywordSurges(
  items: { published: number; matchedKeywordIds: string[] }[],
  now: number,
  windowHours = 24,
  minRecent = 3,
): KeywordSurge[] {
  const w = windowHours * 3600_000
  const recentFrom = now - w
  const priorFrom = now - 2 * w

  const recent = new Map<string, number>()
  const prior = new Map<string, number>()
  for (const it of items) {
    const bucket = it.published >= recentFrom ? recent : it.published >= priorFrom ? prior : null
    if (!bucket) continue
    // 한 사건이 같은 키워드를 여러 번 달고 있어도 1건으로 센다.
    for (const id of new Set(it.matchedKeywordIds)) bucket.set(id, (bucket.get(id) ?? 0) + 1)
  }

  const out: KeywordSurge[] = []
  for (const [id, r] of recent) {
    if (r < minRecent) continue
    const p = prior.get(id) ?? 0
    const ratio = r / Math.max(p, 1)
    if (ratio < 1.5) continue // 1.5배 미만은 평소 변동
    out.push({ keywordId: id, recent: r, prior: p, ratio })
  }
  // 배수 높은 순, 같으면 건수 많은 순
  return out.sort((a, b) => b.ratio - a.ratio || b.recent - a.recent)
}

// ---- 검색 -----------------------------------------------------------------

/** 공백으로 나눈 모든 토큰이 제목 또는 매체명에 들어있어야 통과(AND). */
export function matchesQuery(item: { title: string; source: string }, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  const hay = `${item.title} ${item.source}`.toLowerCase()
  return q.split(/\s+/).every((tok) => hay.includes(tok))
}

// ---- 날짜 그룹 ------------------------------------------------------------

export type DayGroup = '오늘' | '어제' | '이번 주' | '이전'

/** 기사 발행 시각을 사람이 읽는 묶음으로. 기준 시각을 주입해 테스트 가능하게 둔다. */
export function dayGroup(publishedMs: number, now: number): DayGroup {
  const startOfDay = (ms: number) => {
    const d = new Date(ms)
    d.setHours(0, 0, 0, 0)
    return d.getTime()
  }
  const today = startOfDay(now)
  const day = 86400_000
  if (publishedMs >= today) return '오늘'
  if (publishedMs >= today - day) return '어제'
  if (publishedMs >= today - 7 * day) return '이번 주'
  return '이전'
}

export const DAY_GROUP_ORDER: DayGroup[] = ['오늘', '어제', '이번 주', '이전']
