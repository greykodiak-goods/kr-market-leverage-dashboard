// 미장 **실측** 시점 고정(PIT) 유니버스 수집기 — Wikipedia 되감기.
//
// 목적: `src/features/backtest/usPitUniverse.ts`의 US_PIT20·US_PIT80이 **[추정] 목록**이라
//   그 위에서 고른 파라미터도 함께 무효다(국장 33차 실측 교체에서 알파 +21.9%p → +2.6%p).
//   공개 소스에서 **시점별 실제 지수 구성종목**을 받아 `public/data/us-pit/universe.json`에
//   저장한다. 스키마·검증은 `usPitUniverse.ts`가 단일 원본이다 — 여기서 객체를 손으로
//   조립하지 않고 `buildUsPitRealUniverse`를 부른다(조립 즉시 파서로 자기검증한다).
//
// ─────────────────────────────────────────────────────────────────────────────
// 🔴 외부 API 사전 조사 (전역 규칙 4 — 착수 전 다섯 가지, 2026-08-03 조사)
//
//   대상: MediaWiki Action API  `https://en.wikipedia.org/w/api.php`
//
//   ① 인증: 읽기에는 **키·계정이 필요 없다.** 대신 Wikimedia는 **User-Agent 정책**을
//      강제한다 — UA가 없거나 비어 있거나 `python-requests/x` 같은 일반값이면 **HTTP 403**을
//      돌려준다(Policy:Wikimedia Foundation User-Agent Policy). 그래서 아래 `UA`처럼
//      "무엇이·어디서·연락처" 형태의 서술형 UA를 반드시 보낸다. 엔드포인트별 별도 승인은
//      없다(KRX Open API와 다른 점).
//   ② 한도: 익명 읽기에 문서화된 **수치 상한은 확인하지 못했다 [미검증]**. API:Etiquette는
//      "직렬로 요청하라(동시 요청 자제)"를 요구한다. 이 수집기는 지수당 **HTTP 요청 2건**
//      (현재 목록 1 + 변경 이력 1, 같은 문서면 1건)뿐이고 결과를 디스크에 캐시해 재실행 시
//      재요청하지 않는다.
//   ③ 필드명·형식:
//        요청  `action=parse&page=<title>&prop=wikitext&format=json&formatversion=2`
//        응답  `{ parse: { title, pageid, wikitext } }`  (formatversion=2에서 wikitext는 문자열,
//              formatversion=1이면 `wikitext['*']`) — **둘 다 받아들이는 관용 파싱**을 쓴다.
//        현재 구성종목 표의 열: `Symbol · Security · GICS Sector · GICS Sub-Industry ·
//              Headquarters Location · Date added · CIK · Founded`
//              (2026-07-13 시점 실제 표 헤더 — github.com/fja05680/sp500 노트북 출력으로 확인)
//        변경 이력표의 열: `Effective Date · Added(Ticker, Security) · Removed(Ticker, Security) · Reason`
//              (2026-08-04 GHA run 30873560955의 **실제 응답으로 확정**. 첫 실행은 여기서
//              실패했는데, 원인은 열 이름이 아니라 파서였다 — 2단 헤더 아랫줄이 `!!`가 아니라
//              `||`로 구분돼 있어 셀 1개로 뭉쳤다. 관용 파싱을 넓히는 대신 구분자를 고쳤다.)
//              하나도 못 찾으면 **던진다**(기본값으로 때우지 않는다).
//   ④ 데이터 범위: 현재 목록은 완전하다. 변경 이력표는 제목 그대로 **"Selected changes"**이며
//      **불완전하다.** 이 데이터셋을 10년 넘게 유지해 온 fja05680/sp500의 저자도 README에
//      이렇게 적어 두었다 — *"Wikipedia shows 'Selected Changes' not all changes. …
//      You can't reconstruct the past with only the Wikipedia changes mentioned."*
//      그래서 **"몇 년까지 되감아도 되는가"를 데이터가 스스로 판정**하게 만들었다
//      (`reliableFrom` · 게이트 2종 — usPitUniverse.ts 참조). 되감기 한계는 **추정하지 않고
//      측정한다.**
//   ⑤ 실패 표현: Action API는 오류를 **HTTP 200 본문**으로 준다 —
//      `{"error":{"code":"missingtitle","info":"..."}}`(구 형식) 또는 `{"errors":[{...}]}`(신
//      형식), 그리고 `MediaWiki-API-Error` 응답 헤더. 따라서 `res.ok`만 보면 오류를 통째로
//      놓친다. 아래 `wikiParse`는 **상태코드·헤더·error·errors·필드 존재**를 전부 확인하고
//      하나라도 어긋나면 던진다.
//
//   확정 못 한 항목은 코드·출력에 `[미검증]`으로 남아 있다. **첫 GHA 실행의 실제 응답으로
//   확정한 뒤 그 커밋에서 지운다.**
// ─────────────────────────────────────────────────────────────────────────────
//
// 🔴 규칙 1(미래참조 금지)과의 관계: 이 수집기는 **가격을 만들지 않는다.** 만드는 것은
//   "그 시점의 구성종목 목록"이고, 되감기는 정의상 과거로만 간다. 위험은 반대 방향이다 —
//   **오늘 살아남은 종목만 목록에 남는 것**(생존편향). 그래서 제외된 종목을 목록에서
//   빼지 않고 그대로 넣는다. 가격이 없으면 러너가 매핑 실패로 계수해 드러낸다.
//
// 실행(컨테이너 외부망이 막혀 있으므로 **GHA에서** 돈다):
//   US_PIT_COLLECT_RUN=1 node scripts/us-pit-collect.mjs
//   env: US_PIT_INDEX=sp500|ndx (기본 sp500) · US_PIT_FROM=1996 · US_PIT_TO=<올해>
//        US_PIT_REFRESH=1 (캐시 무시하고 다시 받기) · US_PIT_CONTACT=<연락처 URL/메일>

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  US_INDEX_META,
  US_INDEX_SIZE_BAND,
  US_LATE_ADDED_MAX,
  US_PIT_REAL_PATH,
  buildUsPitRealUniverse,
  usRealNameConflicts,
  usRealUnclassifiedConflicts,
  usRealSourceNote,
  type UsIndexKey,
  type UsPitEntry,
  type UsPitYearRecord,
} from '../src/features/backtest/usPitUniverse'

// CJS 번들에서 import.meta.url이 없으므로 런처가 REPO_ROOT를 넘긴다.
const root = process.env.REPO_ROOT ?? process.cwd()

export function log(...args: unknown[]): void {
  console.log(...args)
}

// ── ① Wikipedia 클라이언트 ──────────────────────────────────────────────────

/**
 * Wikimedia User-Agent 정책 준수 — 서술형 UA가 아니면 **403**이 온다.
 * 연락처는 `US_PIT_CONTACT`로 넘기고, 없으면 리포 URL만 넣는다(비워 두지 않는다).
 */
export function userAgent(contact = process.env.US_PIT_CONTACT ?? ''): string {
  const repo = 'https://github.com/greykodiak-goods/kr-market-leverage-dashboard'
  return `kr-market-leverage-dashboard-us-pit-collect/1.0 (${repo}${contact ? `; contact: ${contact}` : ''})`
}

/** fetch 응답 최소 계약 — 테스트가 가짜 응답을 끼울 수 있게 좁혀 둔다. */
export interface WikiResponse {
  ok: boolean
  status: number
  headers: { get: (k: string) => string | null }
  text: () => Promise<string>
}

/**
 * `action=parse&prop=wikitext` 응답에서 위키텍스트를 꺼낸다.
 *
 * **어떤 실패도 삼키지 않는다**(규칙 4-2):
 *   · HTTP 오류 → 던진다(403이면 UA 정책 위반일 가능성을 메시지에 적는다)
 *   · `MediaWiki-API-Error` 헤더 → 던진다
 *   · 본문 `error` / `errors` → 던진다 (**상태코드는 200이다**)
 *   · `parse.wikitext`가 문자열도 `{'*': string}`도 아니면 → 던진다
 *   · 위키텍스트가 비었으면 → 던진다 (빈 문자열을 "정상 0건"으로 취급하지 않는다)
 */
export function extractWikitext(status: number, apiErrorHeader: string | null, body: string): string {
  if (apiErrorHeader) throw new Error(`Wikipedia API 오류 헤더 MediaWiki-API-Error=${apiErrorHeader} (HTTP ${status})`)
  let json: unknown
  try {
    json = JSON.parse(body)
  } catch {
    throw new Error(`Wikipedia 응답이 JSON이 아니다 (HTTP ${status}) — 앞부분: ${body.slice(0, 200).replace(/\s+/g, ' ')}`)
  }
  const o = json as Record<string, unknown>
  if (o.error) {
    const e = o.error as Record<string, unknown>
    throw new Error(`Wikipedia API error: ${String(e.code)} — ${String(e.info)} (HTTP ${status})`)
  }
  if (Array.isArray(o.errors) && o.errors.length > 0) {
    const e = o.errors[0] as Record<string, unknown>
    throw new Error(`Wikipedia API errors[0]: ${String(e.code)} — ${String(e.text ?? e.info ?? '')} (HTTP ${status})`)
  }
  const parse = o.parse as Record<string, unknown> | undefined
  if (!parse) throw new Error(`Wikipedia 응답에 parse가 없다 (HTTP ${status}) — 키: ${Object.keys(o).join(', ') || '없음'}`)
  const w = parse.wikitext
  const text = typeof w === 'string' ? w : typeof w === 'object' && w != null ? String((w as Record<string, unknown>)['*'] ?? '') : ''
  if (!text.trim())
    throw new Error(
      `Wikipedia 위키텍스트가 비어 있다 (HTTP ${status}) — parse 키: ${Object.keys(parse).join(', ')}. ` +
        `빈 응답을 "정상 0건"으로 취급하지 않는다.`,
    )
  return text
}

/** 실제 네트워크 호출 + 디스크 캐시(재개 가능). 캐시가 있으면 재요청하지 않는다. */
async function wikiParse(page: string, cachePath: string, refresh: boolean): Promise<string> {
  if (!refresh && existsSync(cachePath)) {
    const cached = readFileSync(cachePath, 'utf8')
    log(`   ↻ 캐시 재사용: ${cachePath} (${cached.length.toLocaleString()}자) — 다시 받으려면 US_PIT_REFRESH=1`)
    return cached
  }
  const url =
    `https://en.wikipedia.org/w/api.php?action=parse&page=${encodeURIComponent(page)}` +
    `&prop=wikitext&format=json&formatversion=2&redirects=1`
  const res = (await fetch(url, {
    headers: { 'User-Agent': userAgent(), Accept: 'application/json' },
  })) as unknown as WikiResponse
  const body = await res.text()
  if (!res.ok)
    throw new Error(
      `Wikipedia HTTP ${res.status} — ${body.slice(0, 200).replace(/\s+/g, ' ')}` +
        (res.status === 403
          ? ' (403의 흔한 원인 둘: ①Wikimedia User-Agent 정책 위반 — 서술형 UA 필요 ' +
            '②실행 환경의 외부망 차단. 본문 메시지로 구분하라. 작업 컨테이너는 ②라 GHA에서 돌린다)'
          : ''),
    )
  const text = extractWikitext(res.status, res.headers.get('MediaWiki-API-Error'), body)
  mkdirSync(dirname(cachePath), { recursive: true })
  writeFileSync(cachePath, text, 'utf8')
  log(`   ⤓ 수신·캐시: ${page} (${text.length.toLocaleString()}자) → ${cachePath}`)
  return text
}

// ── ② 위키텍스트 표 파서 ────────────────────────────────────────────────────
//
// 위키 표 문법: `{|` 로 열고 `|}` 로 닫는다. `|-`가 행 구분, `!`가 헤더 셀, `|`가 데이터 셀.
// 한 줄에 `||`(또는 `!!`)로 여러 셀을 이어 붙일 수 있다. 셀은 `| 속성 | 내용` 형태로
// 속성을 가질 수 있고, 그 속성에 `rowspan`/`colspan`이 온다.
//
// **rowspan을 반드시 처리해야 한다**: S&P 500 변경 이력표는 같은 날짜에 여러 종목이
// 바뀌면 Date 칸을 rowspan으로 묶는다. 이걸 무시하면 뒤따르는 행의 열이 한 칸씩 밀려
// "티커 자리에 사유가 들어오는" 조용한 오염이 난다.

/** 한 셀 — 속성 문자열과 내용. */
export interface WikiCell {
  attrs: string
  text: string
}

/** 링크·템플릿 안의 `|`는 셀 구분자가 아니다 — 깊이를 세며 자른다. */
function splitTopLevel(line: string, sep: string): string[] {
  const out: string[] = []
  let depth = 0
  let buf = ''
  for (let i = 0; i < line.length; i++) {
    const two = line.slice(i, i + 2)
    if (two === '[[' || two === '{{' || two === '{|') {
      depth++
      buf += two
      i++
      continue
    }
    if (two === ']]' || two === '}}' || two === '|}') {
      depth = Math.max(0, depth - 1)
      buf += two
      i++
      continue
    }
    if (depth === 0 && line.startsWith(sep, i)) {
      out.push(buf)
      buf = ''
      i += sep.length - 1
      continue
    }
    buf += line[i]
  }
  out.push(buf)
  return out
}

/** `속성 | 내용` 분리. 속성처럼 안 생겼으면(=이 없거나 링크가 있으면) 전부 내용으로 본다. */
function splitAttrs(raw: string): WikiCell {
  const parts = splitTopLevel(raw, '|')
  if (parts.length >= 2) {
    const head = parts[0]
    if (/=/.test(head) && !/\[\[|\{\{/.test(head)) return { attrs: head.trim(), text: parts.slice(1).join('|').trim() }
  }
  return { attrs: '', text: raw.trim() }
}

/** 위키텍스트에서 `{| ... |}` 블록들을 (중첩 고려하여) 잘라낸다. */
export function extractTableBlocks(wikitext: string): string[] {
  const lines = wikitext.split('\n')
  const out: string[] = []
  let depth = 0
  let buf: string[] = []
  for (const line of lines) {
    const t = line.trim()
    if (t.startsWith('{|')) {
      depth++
      if (depth === 1) {
        buf = []
        continue
      }
    }
    if (t === '|}' || t.startsWith('|}')) {
      depth--
      if (depth === 0) {
        out.push(buf.join('\n'))
        buf = []
        continue
      }
    }
    if (depth >= 1) buf.push(line)
  }
  return out
}

/** 원시 행(셀 배열)으로 자른다. 헤더 행은 `isHeader`로 구분한다. */
export function parseTableRows(block: string): { isHeader: boolean; cells: WikiCell[] }[] {
  const rows: { isHeader: boolean; cells: WikiCell[] }[] = []
  let cur: { isHeader: boolean; cells: WikiCell[] } | null = null
  const push = () => {
    if (cur && cur.cells.length > 0) rows.push(cur)
    cur = null
  }
  for (const rawLine of block.split('\n')) {
    const line = rawLine.replace(/\s+$/, '')
    const t = line.trim()
    if (t.startsWith('|-')) {
      push()
      cur = { isHeader: false, cells: [] }
      continue
    }
    if (t.startsWith('!')) {
      if (!cur) cur = { isHeader: true, cells: [] }
      cur.isHeader = true
      // 헤더 행의 인라인 구분자는 `!!` **와** `||` 둘 다다 — MediaWiki가 둘을 같게 취급한다.
      // `!!`만 자르면 `! Ticker || Security || Ticker || Security` 한 줄이 셀 1개로 뭉쳐
      // 2단 헤더가 무너진다(2026-08-04 uspit:collect run 30873560955 실패의 원인:
      // 헤더가 `Added Ticker || Security || Ticker || Security`로 나와 'Added Security'를 못 찾았다).
      for (const h of splitTopLevel(t.slice(1), '!!'))
        for (const c of splitTopLevel(h, '||')) cur.cells.push(splitAttrs(c))
      continue
    }
    if (t.startsWith('|+')) continue // 표 캡션 — 셀이 아니다
    if (t.startsWith('|') && !t.startsWith('|}')) {
      if (!cur) cur = { isHeader: false, cells: [] }
      for (const c of splitTopLevel(t.slice(1), '||')) cur.cells.push(splitAttrs(c))
      continue
    }
    // 여러 줄에 걸친 셀 내용 — 직전 셀에 이어 붙인다.
    if (cur && cur.cells.length > 0 && t) cur.cells[cur.cells.length - 1].text += ` ${t}`
  }
  push()
  return rows
}

function spanOf(attrs: string, key: 'rowspan' | 'colspan'): number {
  const m = new RegExp(`${key}\\s*=\\s*"?(\\d+)"?`, 'i').exec(attrs)
  const n = m ? Number(m[1]) : 1
  return Number.isFinite(n) && n >= 1 ? Math.min(n, 200) : 1
}

/**
 * rowspan/colspan을 펼쳐 **직사각형 격자**로 만든다. HTML 표 의미 그대로다 —
 * rowspan이 걸린 셀은 아래 행의 같은 열에 복제된다. 이걸 하지 않으면 열이 밀린다.
 */
export function expandSpans(rows: { isHeader: boolean; cells: WikiCell[] }[]): { isHeader: boolean; cells: string[] }[] {
  const grid: { isHeader: boolean; cells: string[] }[] = []
  /** 열 인덱스 → 남은 행 수·내용 */
  let pending: { col: number; left: number; text: string }[] = []
  for (const row of rows) {
    const outCells: string[] = []
    let src = 0
    let col = 0
    const carry = pending.filter((p) => p.left > 0)
    const guard = 500
    while ((src < row.cells.length || carry.some((p) => p.col === col && p.left > 0)) && col < guard) {
      const c = carry.find((p) => p.col === col && p.left > 0)
      if (c) {
        outCells.push(c.text)
        c.left--
        col++
        continue
      }
      if (src >= row.cells.length) break
      const cell = row.cells[src++]
      const rs = spanOf(cell.attrs, 'rowspan')
      const cs = spanOf(cell.attrs, 'colspan')
      for (let k = 0; k < cs; k++) {
        outCells.push(cell.text)
        if (rs > 1) carry.push({ col, left: rs - 1, text: cell.text })
        col++
      }
    }
    pending = carry.filter((p) => p.left > 0)
    grid.push({ isHeader: row.isHeader, cells: outCells })
  }
  return grid
}

/** 위키 마크업을 사람이 읽는 평문으로 — 링크·템플릿·주석·태그·엔티티 정리. */
export function plain(s: string): string {
  let t = s
  t = t.replace(/<ref[^>]*\/>/gi, '')
  t = t.replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, '')
  t = t.replace(/<!--[\s\S]*?-->/g, '')
  t = t.replace(/<br\s*\/?>/gi, ' ')
  t = t.replace(/<[^>]+>/g, '')
  // [[문서|표시]] → 표시,  [[문서]] → 문서
  t = t.replace(/\[\[([^\]|]*)\|([^\]]*)\]\]/g, '$2')
  t = t.replace(/\[\[([^\]]*)\]\]/g, '$1')
  // {{템플릿|a|b}} → 마지막 인자(대부분 표시 문자열). 이름만 있는 템플릿은 버린다.
  t = t.replace(/\{\{([^{}]*)\}\}/g, (_m, inner: string) => {
    const parts = String(inner).split('|')
    if (parts.length === 1) return ''
    const last = parts[parts.length - 1]
    return /=/.test(last) ? parts[1] ?? '' : last
  })
  t = t.replace(/'''?/g, '')
  t = t.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&ndash;|&mdash;/g, '-')
  t = t.replace(/\[https?:\/\/\S+\s+([^\]]*)\]/g, '$1').replace(/\[https?:\/\/\S+\]/g, '')
  return t.replace(/\s+/g, ' ').trim()
}

// ── ③ 표 선택 · 열 매핑 ─────────────────────────────────────────────────────

/** 헤더 후보를 여러 개 받아들이되(관용 파싱) **하나도 못 찾으면 던진다**(규칙 4-2). */
export function findColumn(header: string[], candidates: RegExp[], where: string): number {
  for (const re of candidates) {
    const i = header.findIndex((h) => re.test(h))
    if (i >= 0) return i
  }
  throw new Error(
    `${where}: 필요한 열을 찾지 못했다 (후보 ${candidates.map((r) => r.source).join(' | ')}). ` +
      `실제 헤더: [${header.join(' | ')}] — 기본값으로 때우지 않고 여기서 멈춘다.`,
  )
}

/** 표 격자에서 헤더 행들을 합쳐 열 이름을 만든다(2단 헤더 대응: 상단+하단을 이어 붙인다). */
export function headerOf(grid: { isHeader: boolean; cells: string[] }[]): string[] {
  const heads = grid.filter((r) => r.isHeader)
  if (heads.length === 0) return []
  const width = Math.max(...heads.map((h) => h.cells.length))
  const out: string[] = []
  for (let c = 0; c < width; c++) {
    const parts = heads.map((h) => plain(h.cells[c] ?? '')).filter(Boolean)
    // 2단 헤더에서 상단이 rowspan으로 복제되면 같은 문자열이 두 번 온다 — 중복 제거.
    out.push([...new Set(parts)].join(' '))
  }
  return out
}

// ── ④ 현재 구성종목 표 ──────────────────────────────────────────────────────

export interface CurrentMember {
  ticker: string
  name: string
  addedOn: string | null
}

/** `1957-03-04` · `March 4, 1957` · `4 March 1957` · `1976` 를 받아 `YYYY-MM-DD`로. 못 읽으면 null. */
export function parseWikiDate(raw: string): string | null {
  const s = plain(raw).replace(/\(.*?\)/g, '').trim()
  if (!s) return null
  let m = /(\d{4})-(\d{2})-(\d{2})/.exec(s)
  if (m) return `${m[1]}-${m[2]}-${m[3]}`
  const MONTHS: Record<string, string> = {
    january: '01', february: '02', march: '03', april: '04', may: '05', june: '06',
    july: '07', august: '08', september: '09', october: '10', november: '11', december: '12',
  }
  m = /([A-Za-z]+)\.?\s+(\d{1,2}),?\s+(\d{4})/.exec(s)
  if (m) {
    const mo = MONTHS[m[1].toLowerCase()]
    if (mo) return `${m[3]}-${mo}-${String(m[2]).padStart(2, '0')}`
  }
  m = /(\d{1,2})\s+([A-Za-z]+)\.?,?\s+(\d{4})/.exec(s)
  if (m) {
    const mo = MONTHS[m[2].toLowerCase()]
    if (mo) return `${m[3]}-${mo}-${String(m[1]).padStart(2, '0')}`
  }
  // 연도만 아는 경우 — 그 해 1월 1일로 내리면 "실제보다 이르게" 잡혀 늦은편입 게이트가
  // 못 잡는다. 보수적으로 **연말**로 잡아 게이트가 걸리게 한다(모르면 실패 쪽으로).
  m = /^(\d{4})$/.exec(s)
  if (m) return `${m[1]}-12-31`
  return null
}

/** 티커 정규화: `BRK.B` → `BRK-B`(야후 표기), 공백·주석 제거. 형식에 안 맞으면 null. */
export function normTicker(raw: string): string | null {
  const t = plain(raw).toUpperCase().replace(/\s+/g, '').replace(/\./g, '-')
  return /^[A-Z]{1,5}(-[A-Z])?$/.test(t) ? t : null
}

/**
 * 현재 구성종목 표를 읽는다. 열 이름은 2026-07-13 실제 헤더로 확인된
 * `Symbol · Security · … · Date added · …` 를 1순위로 하되 `Ticker`도 받아들인다.
 */
export function parseCurrentTable(block: string, where = '현재 구성종목 표'): CurrentMember[] {
  const grid = expandSpans(parseTableRows(block))
  const header = headerOf(grid)
  const iSym = findColumn(header, [/^symbol$/i, /ticker\s*symbol/i, /^ticker$/i], where)
  const iName = findColumn(header, [/^security$/i, /^company$/i, /^name$/i], where)
  let iAdded = -1
  try {
    iAdded = findColumn(header, [/date\s*added/i, /^added$/i, /date\s*first\s*added/i], where)
  } catch {
    // 편입일 열이 없으면 게이트 ②를 못 돌린다 — 치명적이므로 여기서 멈춘다.
    throw new Error(
      `${where}: 'Date added' 열이 없다 — 되감기 자기검증(늦은편입 게이트)을 돌릴 수 없다. ` +
        `실제 헤더: [${header.join(' | ')}]`,
    )
  }
  const out: CurrentMember[] = []
  for (const row of grid) {
    if (row.isHeader) continue
    if (row.cells.length < header.length) continue
    const ticker = normTicker(row.cells[iSym] ?? '')
    const name = plain(row.cells[iName] ?? '')
    if (!ticker || !name) continue
    out.push({ ticker, name, addedOn: parseWikiDate(row.cells[iAdded] ?? '') })
  }
  return out
}

// ── ⑤ 변경 이력표 ───────────────────────────────────────────────────────────

export interface ChangeRow {
  date: string
  added: { ticker: string; name: string }[]
  removed: { ticker: string; name: string }[]
}

/**
 * 변경 이력표를 읽는다. 헤더는 2단(`Effective Date | Added(Ticker,Security) |
 * Removed(Ticker,Security) | Reason`)이라 `expandSpans`가 펼친 뒤 상·하단을 이어 붙인
 * 이름으로 매칭한다. 열 이름은 2026-08-04 실제 응답으로 확정했다.
 * 하나도 못 맞추면 `findColumn`이 실제 헤더를 찍고 던진다.
 */
export function parseChangesTable(block: string, where = '변경 이력표'): { rows: ChangeRow[]; skipped: number } {
  const grid = expandSpans(parseTableRows(block))
  const header = headerOf(grid)
  const iDate = findColumn(header, [/^date$/i, /date/i], where)
  // "Added Ticker" / "Added Symbol" 같이 상단+하단이 붙은 이름을 노린다.
  const iAddT = findColumn(header, [/added\s*(ticker|symbol)/i, /^added$/i], where)
  const iAddN = findColumn(header, [/added\s*(security|company|name)/i], where)
  const iRemT = findColumn(header, [/removed\s*(ticker|symbol)/i, /^removed$/i], where)
  const iRemN = findColumn(header, [/removed\s*(security|company|name)/i], where)
  const rows: ChangeRow[] = []
  let skipped = 0
  for (const row of grid) {
    if (row.isHeader) continue
    const date = parseWikiDate(row.cells[iDate] ?? '')
    const at = normTicker(row.cells[iAddT] ?? '')
    const rt = normTicker(row.cells[iRemT] ?? '')
    if (!date || (!at && !rt)) {
      // 날짜도 티커도 없는 행 = 표의 장식/주석 행이거나 파싱 실패. 세어서 드러낸다.
      if (plain(row.cells.join(' ')).trim()) skipped++
      continue
    }
    rows.push({
      date,
      added: at ? [{ ticker: at, name: plain(row.cells[iAddN] ?? '') || at }] : [],
      removed: rt ? [{ ticker: rt, name: plain(row.cells[iRemN] ?? '') || rt }] : [],
    })
  }
  return { rows, skipped }
}

/** 페이지 안의 표들 중 파서가 통과하는 첫 표를 고른다 — 표 순서(index 0/1)에 의존하지 않는다. */
export function pickTable<T>(blocks: string[], parse: (b: string) => T, what: string): { value: T; index: number } {
  const errs: string[] = []
  for (let i = 0; i < blocks.length; i++) {
    try {
      return { value: parse(blocks[i]), index: i }
    } catch (e) {
      errs.push(`  표#${i}: ${(e as Error).message.slice(0, 180)}`)
    }
  }
  throw new Error(`${what}를 찾지 못했다 — 표 ${blocks.length}개 전부 실패:\n${errs.join('\n')}`)
}

// ── ⑥ 되감기 ────────────────────────────────────────────────────────────────

export interface RewindAnomalies {
  /** 변경행이 "편입"이라 말하는데 그 시점 목록에 없던 티커 수(= 앞선 변경행 누락의 증거). */
  addNotPresent: number
  /** 변경행이 "제외"라 말하는데 이미 목록에 있는 티커 수(중복 행·짝 어긋남). */
  removeAlreadyPresent: number
  samples: string[]
}

export interface RewindResult {
  years: Record<number, UsPitYearRecord>
  missingYears: number[]
  anomalies: RewindAnomalies
}

/**
 * 현재 목록 + 변경 이력 → 연도별 시점 목록.
 *
 * 되감기 규칙(한 변경행 c를 과거로 되돌릴 때):
 *   c 이전 목록 = (c 이후 목록 − c.added) ∪ c.removed
 *
 * 티커 개명(FB→META)은 변경 이력에 "같은 날 add META / remove FB"로 들어오므로 이 규칙이
 * 그대로 옳다 — 과거 목록에는 **그 시점 티커**(FB)가 남는다. 티커 **재사용**은 되감기로
 * 구분할 수 없고, 사후에 `usRealNameConflicts`가 사명 충돌로 잡아 조회를 거부한다.
 *
 * 🔴 각 연도 스냅샷은 **그 시점까지의 변경만** 적용한다(미래참조 금지). 구현상으로도
 *    변경행을 날짜 내림차순으로 한 번만 훑으며 경계를 넘어설 때만 적용한다.
 */
export function rewind(
  current: CurrentMember[],
  changes: ChangeRow[],
  asOfDate: string,
  fromYear: number,
  toYear: number,
): RewindResult {
  const state = new Map<string, UsPitEntry>()
  for (const m of current) state.set(m.ticker, { ticker: m.ticker, name: m.name, addedOn: m.addedOn })
  const desc = [...changes].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
  const anomalies: RewindAnomalies = { addNotPresent: 0, removeAlreadyPresent: 0, samples: [] }
  const note = (s: string) => {
    if (anomalies.samples.length < 12) anomalies.samples.push(s)
  }
  const years: Record<number, UsPitYearRecord> = {}
  const missingYears: number[] = []
  let p = 0
  for (let y = toYear; y >= fromYear; y--) {
    const target = `${y}-01-01`
    if (target > asOfDate) {
      // 아직 오지 않은 해 — 만들지 않는다(미래 목록을 지어내지 않는다).
      missingYears.push(y)
      continue
    }
    while (p < desc.length && desc[p].date > target) {
      const c = desc[p++]
      for (const a of c.added) {
        if (!state.has(a.ticker)) {
          anomalies.addNotPresent++
          note(`${c.date} add ${a.ticker}: 되감기 시점 목록에 없음`)
        }
        state.delete(a.ticker)
      }
      for (const r of c.removed) {
        if (state.has(r.ticker)) {
          anomalies.removeAlreadyPresent++
          note(`${c.date} remove ${r.ticker}: 이미 목록에 있음`)
          continue
        }
        state.set(r.ticker, { ticker: r.ticker, name: r.name, addedOn: null })
      }
    }
    const members = [...state.values()].sort((a, b) => (a.ticker < b.ticker ? -1 : 1))
    const late = members.filter((m) => m.addedOn !== null && m.addedOn > target)
    years[y] = {
      asOfDate: target,
      members: members.map((m) => ({ ...m })),
      lateAdded: late.length,
      lateAddedSample: late.slice(0, 10).map((m) => `${m.ticker}(${m.addedOn})`),
      dateAddedKnown: members.filter((m) => m.addedOn !== null).length,
    }
  }
  return { years, missingYears: missingYears.sort((a, b) => a - b), anomalies }
}

// ── ⑦ 실행 ──────────────────────────────────────────────────────────────────

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10)
}

export async function collect(): Promise<number> {
  const index = (process.env.US_PIT_INDEX ?? 'sp500') as UsIndexKey
  if (!US_INDEX_META[index]) {
    console.error(`알 수 없는 US_PIT_INDEX=${index} — 가능: ${Object.keys(US_INDEX_META).join(', ')}`)
    return 1
  }
  const meta = US_INDEX_META[index]
  const asOf = todayUtc()
  const toYear = Number(process.env.US_PIT_TO ?? asOf.slice(0, 4))
  const fromYear = Number(process.env.US_PIT_FROM ?? 1996)
  const refresh = process.env.US_PIT_REFRESH === '1'
  const cacheDir = join(root, 'node_modules', '.us-pit-cache')

  log(`미장 실측 PIT 유니버스 수집 — ${meta.page} (${fromYear}~${toYear})`)
  log(`출처: ${meta.url} · 라이선스 CC BY-SA · UA=${userAgent()}`)
  log('⚠️ 변경 이력표는 "Selected changes"라 **불완전하다**. 되감기 한계는 추정하지 않고 게이트로 측정한다.')
  log('✅ 변경 이력표 열 이름은 2026-08-04 실제 응답으로 확정: Effective Date / Added(Ticker,Security)')
  log('   / Removed(Ticker,Security) / Reason. 2단 헤더 아랫줄 구분자는 `!!`가 아니라 `||`다.')
  log('⚠️ [미검증] Wikipedia 익명 읽기의 수치 호출 상한. 이 수집기는 지수당 HTTP 1건 + 디스크 캐시다.')
  log('')

  // 성공 카운터 — 하나라도 0이면 비정상 종료한다(전량 실패가 종료코드 0이 되는 것을 막는다).
  let fetchOk = 0
  let currentN = 0
  let changeN = 0
  let builtYears = 0

  const wikitext = await wikiParse(meta.page, join(cacheDir, `${index}.wikitext`), refresh)
  fetchOk++

  const blocks = extractTableBlocks(wikitext)
  log(`   표 ${blocks.length}개 발견`)
  if (blocks.length === 0) throw new Error('위키텍스트에서 표를 하나도 찾지 못했다 — 문서 구조가 바뀌었다.')

  const cur = pickTable(blocks, (b) => parseCurrentTable(b), '현재 구성종목 표')
  const current = cur.value
  currentN = current.length
  const knownAdded = current.filter((m) => m.addedOn).length
  log(`   현재 구성종목: ${currentN}종목 (표#${cur.index}) · 편입일 파싱 성공 ${knownAdded}/${currentN}`)
  if (currentN === 0) throw new Error('현재 구성종목이 0종목 — 파싱 실패다(정상 0건이 아니다).')

  const chg = pickTable(blocks, (b) => parseChangesTable(b), '변경 이력표')
  const { rows: changes, skipped } = chg.value
  changeN = changes.length
  log(`   변경 이력: ${changeN}행 (표#${chg.index}) · 파싱 실패로 버린 행 ${skipped}`)
  if (changeN === 0) throw new Error('변경 이력 0행 — 되감기가 불가능하다(정상 0건이 아니다).')
  const dates = changes.map((c) => c.date).sort()
  const changesFirstDate = dates[0]
  log(`   변경행 날짜 범위: ${changesFirstDate} ~ ${dates[dates.length - 1]}`)
  if (skipped > changeN * 0.2)
    throw new Error(`변경 이력표의 ${skipped}/${skipped + changeN}행을 못 읽었다 — 열 매핑이 틀렸을 가능성이 높다.`)

  const { years, missingYears, anomalies } = rewind(current, changes, asOf, fromYear, toYear)
  builtYears = Object.keys(years).length
  log('')
  log(`되감기 결과: ${builtYears}개 연도 복원 · 복원 불가 ${missingYears.join(', ') || '없음'}`)
  log(`이상 징후(변경 이력 불완전의 직접 증거): 편입인데 목록에 없음 ${anomalies.addNotPresent}건 · 제외인데 이미 있음 ${anomalies.removeAlreadyPresent}건`)
  for (const s of anomalies.samples) log(`   · ${s}`)
  if (builtYears === 0) throw new Error('복원한 연도가 0개다.')

  const uni = buildUsPitRealUniverse({
    index,
    asOf,
    years,
    missingYears,
    changesFirstDate,
    changeRows: changeN,
    sizeBand: US_INDEX_SIZE_BAND[index],
    lateAddedMax: US_LATE_ADDED_MAX,
  })

  log('')
  log('| 연도 | 구성종목 | 밴드 | 늦은편입 위반 | 판정 |')
  log('|---|---|---|---|---|')
  for (const y of Object.keys(uni.years).map(Number).sort((a, b) => a - b)) {
    const v = uni.reliability.years[String(y)]
    log(`| ${y} | ${v.size} | ${v.sizeOk ? 'OK' : '❌'} | ${v.lateAdded} | ${v.ok ? '✅' : '❌ 신뢰구간 밖'} |`)
  }
  log('')
  log(`🎯 reliableFrom = ${uni.reliableFrom} (게이트가 정했다 — 사람이 늘려 적을 수 없다)`)
  log(`   ${usRealSourceNote(uni)}`)

  const conflicts = usRealNameConflicts(uni)
  const unclassified = usRealUnclassifiedConflicts(uni)
  log('')
  log(`티커 사명 충돌 ${Object.keys(conflicts).length}건 · 그중 **미분류** ${unclassified.length}건`)
  log('   미분류 = 개명(US_TICKER_RENAMES)인지 재사용(US_BLOCKED_TICKERS)인지 아직 사람이 안 정한 것.')
  log('   → 분류 전까지 조회를 **거부**한다(매핑 실패로 계수). 오염보다 정직한 실패가 낫다.')
  for (const t of unclassified.slice(0, 40)) log(`   · ${t}: ${conflicts[t].join(' → ')}`)
  if (unclassified.length > 40) log(`   · … 외 ${unclassified.length - 40}건`)

  const outPath = join(root, process.env.US_PIT_OUT ?? US_PIT_REAL_PATH)
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, `${JSON.stringify(uni, null, 2)}\n`, 'utf8')
  log('')
  log(`💾 저장: ${process.env.US_PIT_OUT ?? US_PIT_REAL_PATH}`)
  log('   → 이 파일을 리포에 커밋하면 러너·화면이 Wikipedia 접속 없이 실측 유니버스를 쓴다.')

  if (fetchOk === 0 || currentN === 0 || changeN === 0 || builtYears === 0) {
    console.error('성공 카운터가 0인 항목이 있다 — 비정상 종료한다.')
    return 1
  }
  return 0
}

// 런처(scripts/us-pit-collect.mjs)만 US_PIT_COLLECT_RUN=1을 넘긴다.
// 테스트가 이 모듈을 import할 때는 자동 실행되지 않는다.
if (process.env.US_PIT_COLLECT_RUN === '1') {
  collect()
    .then((code) => process.exit(code))
    .catch((e) => {
      console.error('수집 실패:', e)
      // 조용한 부분 성공을 만들지 않는다 — 실패하면 파일을 쓰지 않고 1로 죽는다.
      process.exit(1)
    })
}
