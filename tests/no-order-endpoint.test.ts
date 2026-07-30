// 규칙 2 집행자 — 실서버 주문 경계 가드.
//
// 2026-07-30 대표 확정: 1·2단계(조회 + 모의서버 주문) 개방, 3단계(실계좌) 유지.
// 이에 따라 이 테스트가 강제하는 것:
//   (1) **실서버 주소('api.kiwoom.com')는 소스 어디에도 없다** — 3단계 승인 전까지.
//       조회 어댑터도 우선 모의서버(mockapi)로 시작하고, 실서버 조회를 열 때는
//       이 테스트를 "조회 파일 한정 허용" 형태로 함께 개정한다.
//   (2) **주문 엔드포인트 문자열은 모의서버 문맥에서만 존재할 수 있다** — 주문 경로
//       조각이 든 파일은 반드시 'mockapi'를 함께 포함해야 한다(실서버 주문 코드 차단).
//       현재는 브로커 코드가 전혀 없으므로 사실상 0건이어야 한다.
//   (3) 자금 이체·입출금 관련 API 문자열은 영구 금지(개정과 무관).
//
// 모의 주문 어댑터가 처음 들어가는 커밋에서 이 테스트를 함께 손봐야 하며(허용 파일
// 명시), 그 전에 어떤 파일이 걸리면 그것은 규칙 2 위반이다.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { check, eq, finish, section } from './harness'

const ROOT = join(__dirname, '..')
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
  // 키움 REST 주문 경로·주문 TR 패턴. 목록은 어댑터 착수 시 실제 문서 기준으로 갱신한다.
  const ORDER_PATTERNS = [/dostk\/ordr/i, /kt1000[0-9]/i, /\/order[s]?\/(buy|sell)/i]
  const offenders: string[] = []
  for (const f of files) {
    const text = readFileSync(f, 'utf8')
    const hit = ORDER_PATTERNS.find((re) => re.test(text))
    if (hit && !/mockapi/i.test(text)) offenders.push(`${f.slice(ROOT.length + 1)} (${hit})`)
  }
  eq('실서버 문맥 주문 엔드포인트 0건', offenders.join(', '), '')
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

finish()
