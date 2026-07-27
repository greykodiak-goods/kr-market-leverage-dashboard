// 뉴스 열람 상태·급상승·검색·날짜그룹 검증.
// 시간에 의존하는 함수는 전부 now를 주입받게 만들었으므로 결정적으로 테스트한다.

import { check, eq, finish, section } from './harness'
import {
  addId,
  dayGroup,
  DAY_GROUP_ORDER,
  EMPTY_PREFS,
  isNew,
  keywordSurges,
  matchesQuery,
  removeId,
  toggleId,
  trimPrefs,
  type NewsPrefs,
} from '../src/lib/newsPrefs'

const HOUR = 3600_000
const DAY = 24 * HOUR

// ------------------------------------------------------------ 1) id 목록 조작
section('1) 읽음·북마크 id 목록')
{
  eq('없으면 추가', addId([], 'a').join(','), 'a')
  eq('중복 추가 안 함', addId(['a'], 'a').join(','), 'a')
  eq('최신이 뒤로', addId(['a'], 'b').join(','), 'a,b')
  eq('제거', removeId(['a', 'b', 'c'], 'b').join(','), 'a,c')
  eq('없는 것 제거해도 안전', removeId(['a'], 'z').join(','), 'a')
  eq('토글 — 없으면 추가', toggleId(['a'], 'b').join(','), 'a,b')
  eq('토글 — 있으면 제거', toggleId(['a', 'b'], 'b').join(','), 'a')

  // 원본 불변 (React state로 쓰므로 중요)
  const orig = ['a', 'b']
  addId(orig, 'c')
  removeId(orig, 'a')
  toggleId(orig, 'a')
  eq('원본 배열 불변', orig.join(','), 'a,b')
}

// -------------------------------------------------------------- 2) 상한 정리
section('2) 저장 상한')
{
  const many = Array.from({ length: 900 }, (_, i) => `r${i}`)
  const t = trimPrefs({ read: many, marks: [], lastSeen: 5 })
  eq('읽음 800건으로 절단', t.read.length, 800)
  eq('오래된 쪽(앞)부터 버림', t.read[0], 'r100')
  eq('최신은 보존', t.read[t.read.length - 1], 'r899')
  eq('lastSeen 보존', t.lastSeen, 5)

  const marks = Array.from({ length: 400 }, (_, i) => `m${i}`)
  eq('북마크 300건으로 절단', trimPrefs({ read: [], marks, lastSeen: 0 }).marks.length, 300)

  const small: NewsPrefs = { read: ['a'], marks: ['b'], lastSeen: 1 }
  eq('상한 이하는 그대로', trimPrefs(small).read.length, 1)
}

// ---------------------------------------------------------------- 3) 새 글 판정
section('3) NEW 판정')
{
  const now = 1_700_000_000_000
  const prefs: NewsPrefs = { read: ['seen'], marks: [], lastSeen: now - DAY }

  check('마지막 확인 이후 발행 → NEW', isNew(now, prefs, 'fresh'))
  check('마지막 확인 이전 발행 → NEW 아님', !isNew(now - 2 * DAY, prefs, 'old'))
  check('이미 읽었으면 NEW 아님', !isNew(now, prefs, 'seen'))

  // 첫 방문(lastSeen=0)에 전부 NEW로 도배되지 않아야 한다
  const first: NewsPrefs = { ...EMPTY_PREFS }
  check('첫 방문이면 NEW 없음', !isNew(now, first, 'x'))
  check('첫 방문 — 아주 최신도 NEW 아님', !isNew(now + HOUR, first, 'y'))

  // 경계: 정확히 lastSeen과 같은 시각은 NEW 아님(이미 봤던 것)
  check('lastSeen과 동일 시각 → NEW 아님', !isNew(prefs.lastSeen, prefs, 'edge'))
}

// -------------------------------------------------------------- 4) 키워드 급상승
section('4) 키워드 급상승')
{
  const now = 1_700_000_000_000
  const mk = (hoursAgo: number, ids: string[]) => ({ published: now - hoursAgo * HOUR, matchedKeywordIds: ids })

  const items = [
    // 최근 24h: hbm 5건, rate 3건, ai 1건
    mk(1, ['hbm']), mk(2, ['hbm']), mk(3, ['hbm']), mk(4, ['hbm']), mk(5, ['hbm']),
    mk(6, ['rate']), mk(7, ['rate']), mk(8, ['rate']),
    mk(9, ['ai']),
    // 직전 24h: hbm 1건, rate 3건
    mk(30, ['hbm']),
    mk(31, ['rate']), mk(32, ['rate']), mk(33, ['rate']),
    // 그 이전(무시되어야 함)
    mk(100, ['hbm']), mk(101, ['hbm']), mk(102, ['hbm']),
  ]

  const s = keywordSurges(items, now, 24, 3)
  const hbm = s.find((x) => x.keywordId === 'hbm')
  check('급증 키워드 검출', !!hbm)
  eq('최근 창 건수', hbm!.recent, 5)
  eq('직전 창 건수', hbm!.prior, 1)
  eq('배수', hbm!.ratio, 5)

  check('평탄한 키워드는 제외(rate 3→3)', !s.some((x) => x.keywordId === 'rate'))
  check('건수 미달은 제외(ai 1건)', !s.some((x) => x.keywordId === 'ai'))
  eq('배수 높은 순 정렬', s[0].keywordId, 'hbm')

  // 창 밖 기사는 계산에 안 들어간다
  const onlyOld = keywordSurges([mk(100, ['hbm']), mk(101, ['hbm']), mk(102, ['hbm'])], now, 24, 3)
  eq('창 밖만 있으면 결과 없음', onlyOld.length, 0)

  // 직전 창이 0이면 max(prior,1)로 나눠 무한대가 되지 않는다
  const fresh = keywordSurges([mk(1, ['x']), mk(2, ['x']), mk(3, ['x']), mk(4, ['x'])], now, 24, 3)
  eq('신규 키워드 배수 = 건수', fresh[0].ratio, 4)
  check('무한대·NaN 없음', Number.isFinite(fresh[0].ratio))

  // 한 사건에 같은 키워드가 중복돼도 1건
  const dup = keywordSurges(
    [mk(1, ['k', 'k', 'k']), mk(2, ['k']), mk(3, ['k'])],
    now, 24, 3,
  )
  eq('사건 내 키워드 중복은 1건', dup[0].recent, 3)

  // 빈 입력
  eq('빈 입력 안전', keywordSurges([], now).length, 0)
}

// ------------------------------------------------------------------- 5) 검색
section('5) 검색')
{
  const it = { title: 'SK하이닉스 HBM4 양산 돌입', source: '한국경제' }
  check('빈 질의는 전부 통과', matchesQuery(it, ''))
  check('공백만 있어도 통과', matchesQuery(it, '   '))
  check('제목 부분일치', matchesQuery(it, 'hbm4'))
  check('대소문자 무시', matchesQuery(it, 'HBM4'))
  check('매체명으로도 검색', matchesQuery(it, '한국경제'))
  check('여러 토큰은 AND', matchesQuery(it, 'hbm4 양산'))
  check('한 토큰이라도 없으면 불일치', !matchesQuery(it, 'hbm4 없는말'))
  check('제목+매체 교차 AND', matchesQuery(it, '하이닉스 한국경제'))
  check('무관한 질의 불일치', !matchesQuery(it, '삼성전자'))
}

// -------------------------------------------------------------- 6) 날짜 그룹
section('6) 날짜 그룹')
{
  // 자정 경계가 로컬 타임존 기준이어야 하므로 오늘 12:00을 기준으로 잡는다
  const noon = new Date()
  noon.setHours(12, 0, 0, 0)
  const now = noon.getTime()

  eq('지금 → 오늘', dayGroup(now, now), '오늘')
  eq('오늘 새벽 → 오늘', dayGroup(now - 11 * HOUR, now), '오늘')
  eq('어제 → 어제', dayGroup(now - DAY, now), '어제')
  eq('3일 전 → 이번 주', dayGroup(now - 3 * DAY, now), '이번 주')
  eq('10일 전 → 이전', dayGroup(now - 10 * DAY, now), '이전')

  // 자정 직전/직후 경계
  const startToday = new Date(now)
  startToday.setHours(0, 0, 0, 0)
  eq('오늘 00:00 → 오늘', dayGroup(startToday.getTime(), now), '오늘')
  eq('오늘 00:00 직전 → 어제', dayGroup(startToday.getTime() - 1, now), '어제')

  eq('그룹 순서 4종', DAY_GROUP_ORDER.length, 4)
  eq('첫 그룹은 오늘', DAY_GROUP_ORDER[0], '오늘')
}

finish()
