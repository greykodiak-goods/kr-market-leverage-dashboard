// 규칙 2 집행자 — 실서버 주문 경계 가드.
//
// 2026-07-30 대표 확정: 1·2단계(조회 + 모의서버 주문) 개방, 3단계(실계좌) 유지.
// **2026-07-31 개정 — "모의 한정 허용"**: 2단계 모의 주문 어댑터
// (scripts/lib/kiwoomOrder.mjs)가 들어오면서, 규칙 2가 예고한 대로 이 테스트를
// "주문 코드는 모의서버 문맥에서만 존재 가능" 형태로 확정한다.
//
// 이 테스트가 강제하는 것:
//   (1) **실서버 주소('api.kiwoom.com')는 소스 어디에도 없다** — 3단계 승인 전까지.
//       조회 어댑터도 모의서버(mockapi)로 시작하고, 실서버 조회를 열 때는
//       이 테스트를 "조회 파일 한정 허용" 형태로 함께 개정한다.
//   (2) **주문 엔드포인트 문자열은 모의서버 문맥에서만 존재할 수 있다** — 주문 경로
//       조각이 든 파일은 반드시 'mockapi'를 함께 포함해야 한다(실서버 주문 코드 차단).
//   (3) 자금 이체·입출금 관련 API 문자열은 영구 금지(개정과 무관).
//   (4) 모의 주문 어댑터 자신이 모의서버 잠금을 유지한다 — 주소에 mockapi가 없으면
//       어댑터 생성 자체가 실패해야 한다(런타임 동작은 tests/kiwoom-order.test.ts).
//
// 3단계(실계좌)가 승인되기 전에는 어떤 파일도 (1)(3)에 걸려선 안 되고,
// 주문 코드는 (2)의 모의 문맥 밖으로 나가선 안 된다.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { check, eq, finish, section } from './harness'

// ⚠️ __dirname 을 쓰면 안 된다 — 이 테스트는 esbuild 번들로 node_modules/.test-build
// 아래에서 실행되므로 __dirname/'..' 은 **node_modules** 를 가리킨다. 그러면 가드가
// 리포가 아니라 npm 패키지를 스캔하면서 조용히 통과한다(2026-07-31 발견·수정).
const ROOT = process.env.REPO_ROOT ?? process.cwd()
// 소스로 취급하는 디렉터리 — 문서(md)·테스트는 제외한다(규칙 설명에 문자열이 필요하므로)
const SCAN_DIRS = ['src', 'scripts', 'convex', 'functions', 'supabase']
const EXTS = new Set(['.ts', '.tsx', '.mjs', '.cjs', '.js', '.py', '.json'])

function listFiles(dir: string): string[] {
  let out: string[] = []
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const name of entries) {
    if (name === 'node_modules' || name.startsWith('.')) continue
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) out = out.concat(listFiles(p))
    else if (EXTS.has(name.slice(name.lastIndexOf('.')))) out.push(p)
  }
  return out
}

const files = SCAN_DIRS.flatMap((d) => listFiles(join(ROOT, d)))

section('0) 스캔 대상이 실제로 존재한다 (공허한 통과 방지)')
{
  check(`소스 파일 ${files.length}개 스캔`, files.length > 50)
}

// -------------------------------------------------- 1) 실서버 주소 금지
section('1) 실서버 주소 금지 (3단계 승인 전)')
{
  // 'api.kiwoom.com'은 잡되 모의서버 'mockapi.kiwoom.com'은 허용해야 하므로
  // 앞 문자를 함께 본다.
  const offenders: string[] = []
  for (const f of files) {
    const text = readFileSync(f, 'utf8')
    const m = text.match(/(?<![a-z])api\.kiwoom\.com/i)
    if (m) offenders.push(f.slice(ROOT.length + 1))
  }
  eq('실서버 주소(api.kiwoom.com) 0건', offenders.join(', '), '')
}

// -------------------------------------------------- 2) 주문 엔드포인트
section('2) 주문 엔드포인트 — 모의서버 문맥 밖 금지')
{
  // 키움 REST 주문 경로·주문 TR 패턴 (kt10000 매수 / kt10001 매도 / kt10002 정정 / kt10003 취소).
  const ORDER_PATTERNS = [/dostk\/ordr/i, /kt1000[0-9]/i, /\/order[s]?\/(buy|sell)/i]
  const offenders: string[] = []
  const orderFiles: string[] = []
  for (const f of files) {
    const text = readFileSync(f, 'utf8')
    const hit = ORDER_PATTERNS.find((re) => re.test(text))
    if (!hit) continue
    orderFiles.push(f.slice(ROOT.length + 1))
    if (!/mockapi/i.test(text)) offenders.push(`${f.slice(ROOT.length + 1)} (${hit})`)
  }
  eq('실서버 문맥 주문 엔드포인트 0건', offenders.join(', '), '')
  // 어떤 파일이 주문 코드를 들고 있는지 로그에 남겨 검토 대상을 눈에 보이게 한다.
  console.log(`  (주문 문자열 보유 파일: ${orderFiles.length ? orderFiles.join(', ') : '없음'})`)
}

// -------------------------------------------------- 3) 자금 이체 영구 금지
section('3) 자금 이체·입출금 API 영구 금지')
{
  // 이체·출금 성격의 API 경로/TR 문자열. 한글 단어는 UI 문구에서 오탐이 나므로
  // 코드 성격의 패턴만 잡는다.
  const TRANSFER_PATTERNS = [/acnt.*trns/i, /\/transfer\b/i, /\/withdraw\b/i, /\/deposit\/(execute|submit)/i]
  const offenders: string[] = []
  for (const f of files) {
    const text = readFileSync(f, 'utf8')
    const hit = TRANSFER_PATTERNS.find((re) => re.test(text))
    if (hit) offenders.push(`${f.slice(ROOT.length + 1)} (${hit})`)
  }
  eq('이체·입출금 API 문자열 0건', offenders.join(', '), '')
}

// -------------------------------------------------- 4) 어댑터의 모의서버 잠금
section('4) 모의 주문 어댑터가 모의서버 잠금을 유지한다')
{
  const adapter = join(ROOT, 'scripts', 'lib', 'kiwoomOrder.mjs')
  let text = ''
  try {
    text = readFileSync(adapter, 'utf8')
  } catch {
    /* 없으면 아래에서 실패 */
  }
  check('주문 어댑터 존재 (scripts/lib/kiwoomOrder.mjs)', text.length > 0)
  check('모의서버 문맥(mockapi) 포함', /mockapi/i.test(text))
  // 주소 검사를 통째로 지우는 회귀를 잡는다 — 런타임 검증은 tests/kiwoom-order.test.ts
  check('비-모의 주소에서 생성 실패시키는 가드 존재', /mockapi\/i\.test\(client\.base\)/.test(text))
  check('dryRun 기본값 true', /dryRun\s*=\s*true/.test(text))
}

finish()
