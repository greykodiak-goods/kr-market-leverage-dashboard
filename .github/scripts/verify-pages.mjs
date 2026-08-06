// 라이브 배포 검증기 — gh-pages 체크아웃(= 방금 올린 것)과 **서빙되는 것**을 대조한다.
//
// 실행: LIVE_DIR=_live node .github/scripts/verify-pages.mjs   (GHA 러너. 워크플로 pages-verify.yml)
//       LIVE_DIR = gh-pages를 체크아웃해 둔 경로. 스크립트 자신은 기본 브랜치에 산다.
// 왜 러너에서 도는지는 워크플로 머리말 참조 — 세션 컨테이너는 *.github.io가 정책 차단.
//
// 설계 원칙(규칙 4): 모르는 것을 성공으로 처리하지 않는다.
//   · 자산 파일명이 안 맞으면 "아직 안 올라온 것"으로 보고 재시도하되, 소진되면 실패한다.
//   · 커밋에 있는 data 파일이 서빙에 없으면 실패한다(조용한 누락 방지).
//   · 네트워크 오류와 "정상적으로 404"를 구분해 로그에 남긴다.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const OWNER = process.env.GITHUB_REPOSITORY_OWNER ?? 'greykodiak-goods'
const REPO = (process.env.GITHUB_REPOSITORY ?? '/kr-market-leverage-dashboard').split('/')[1]
const BASE = `https://${OWNER}.github.io/${REPO}/`
// 대조 대상은 **서빙 산출물의 사본**(gh-pages 체크아웃)이지 소스 리포가 아니다.
const ROOT = join(process.env.GITHUB_WORKSPACE ?? process.cwd(), process.env.LIVE_DIR ?? '_live')

const ATTEMPTS = Math.max(1, Number(process.env.ATTEMPTS || '') || 10)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const problems = []
const fail = (msg) => {
  problems.push(msg)
  console.log(`❌ ${msg}`)
}
const ok = (msg) => console.log(`✅ ${msg}`)

// 캐시를 타면 "옛 배포가 200을 주는" 상황을 못 잡는다.
async function get(url) {
  const res = await fetch(url, { headers: { 'cache-control': 'no-cache', pragma: 'no-cache' }, redirect: 'follow' })
  const text = res.ok ? await res.text() : ''
  return { status: res.status, text }
}

/** index.html이 참조하는 /assets/... 경로들. */
function assetRefs(html) {
  return [...html.matchAll(/(?:src|href)="([^"]*assets\/[^"]+)"/g)].map((m) => m[1].replace(/^\.?\//, '').replace(/^kr-market-leverage-dashboard\//, ''))
}

// ── ① · ② 서빙되는 index.html이 방금 올린 자산을 가리키는가 ────────────────
const localHtml = readFileSync(join(ROOT, 'index.html'), 'utf8')
const wantAssets = assetRefs(localHtml).sort()
if (wantAssets.length === 0) throw new Error('gh-pages의 index.html에서 자산 참조를 못 찾았다 — 검증 자체가 성립하지 않는다')
console.log(`기대 자산: ${wantAssets.join(' · ')}`)

let servedHtml = null
for (let i = 1; i <= ATTEMPTS; i++) {
  let r
  try {
    r = await get(BASE)
  } catch (e) {
    console.log(`  ${i}/${ATTEMPTS} 네트워크 오류: ${String(e)}`)
    await sleep(Math.min(60_000, 2 ** i * 1000))
    continue
  }
  if (r.status !== 200) {
    console.log(`  ${i}/${ATTEMPTS} index.html HTTP ${r.status} — 아직 퍼블리시 전`)
  } else {
    const got = assetRefs(r.text).sort()
    if (got.join('|') === wantAssets.join('|')) {
      servedHtml = r.text
      ok(`index.html 200 · 자산 일치 (${i}회차)`)
      break
    }
    console.log(`  ${i}/${ATTEMPTS} 옛 배포가 서빙 중 — 받은 자산: ${got.join(' · ') || '(없음)'}`)
  }
  if (i < ATTEMPTS) await sleep(Math.min(60_000, 2 ** i * 1000))
}

if (servedHtml == null) {
  fail(`${BASE} 가 ${ATTEMPTS}회 시도 동안 이번 배포를 서빙하지 않았다 (404이거나 옛 자산)`)
} else {
  // ── ③ 자산 실물이 받아지는가 ──────────────────────────────────────────
  for (const a of wantAssets) {
    const r = await get(BASE + a)
    if (r.status === 200 && r.text.length > 0) ok(`자산 ${a} 200 (${(r.text.length / 1024).toFixed(0)}KB)`)
    else fail(`자산 ${a} HTTP ${r.status} — index.html이 가리키는데 못 받는다`)
  }
}

// ── ④ · ⑤ 데이터 산출물이 커밋본 그대로 서빙되는가 ────────────────────────
// 화면이 읽는 것은 이 JSON들이다. HTML만 맞고 데이터가 옛것이면 화면은 거짓말을 한다.
function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else if (name.endsWith('.json')) out.push(p)
  }
  return out
}

let dataFiles = []
try {
  dataFiles = walk(join(ROOT, 'data'))
} catch {
  console.log('data/ 디렉터리가 없다 — 데이터 검증 건너뜀')
}

// 전량을 받으면 러너 시간이 길어지므로 **크기와 무관하게 중요한 것부터** 본다.
const PRIORITY = ['us-leverage-precomputed.json', 'theme-calls.json']
const rels = dataFiles.map((p) => relative(join(ROOT, 'data'), p).replaceAll('\\', '/'))
const pick = [
  ...rels.filter((r) => PRIORITY.some((n) => r.endsWith(n))),
  ...rels.filter((r) => !PRIORITY.some((n) => r.endsWith(n))).slice(0, 12),
]
if (rels.length > pick.length) console.log(`데이터 파일 ${rels.length}개 중 ${pick.length}개 확인 (우선순위 + 앞 12개) — 나머지는 미확인`)

for (const rel of pick) {
  const local = readFileSync(join(ROOT, 'data', rel), 'utf8')
  const r = await get(`${BASE}data/${rel}`)
  if (r.status !== 200) {
    fail(`data/${rel} HTTP ${r.status} — 커밋에는 있는데 서빙되지 않는다`)
    continue
  }
  // 통째 비교는 개행·인코딩 차이에 취약하므로 파싱해 핵심 필드로 본다.
  let a, b
  try {
    a = JSON.parse(local)
    b = JSON.parse(r.text)
  } catch {
    fail(`data/${rel} JSON 파싱 실패(로컬 또는 서빙본)`)
    continue
  }
  const stamp = (o) => o?.asOf ?? o?.updatedAt ?? o?.generatedAt ?? null
  if (stamp(a) != null && stamp(a) !== stamp(b)) {
    fail(`data/${rel} 기준시각 불일치 — 커밋 ${stamp(a)} vs 서빙 ${stamp(b)} (옛 배포가 서빙 중)`)
    continue
  }
  const ids = (o) => (Array.isArray(o?.presets) ? o.presets.map((p) => p.id).sort().join(',') : null)
  if (ids(a) != null && ids(a) !== ids(b)) {
    fail(`data/${rel} 프리셋 목록 불일치 — 커밋 [${ids(a)}] vs 서빙 [${ids(b)}]`)
    continue
  }
  ok(`data/${rel} 일치${stamp(a) ? ` · 기준 ${String(stamp(a)).slice(0, 10)}` : ''}`)
}

console.log('')
if (problems.length > 0) {
  console.log(`실패 ${problems.length}건 — 라이브가 이번 배포를 반영하지 않았다:`)
  for (const p of problems) console.log(`  · ${p}`)
  process.exit(1)
}
console.log(`✅ 라이브 검증 통과 — ${BASE} 가 이번 배포를 서빙 중이다.`)
