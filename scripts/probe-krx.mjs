// KRX 공식 Open API 조사기 — "투자자별 거래실적을 제공하는가"를 실응답으로 확인한다.
//
// 왜 조사기가 먼저인가:
//   수급 레이더의 쌍끌이·외인 누적 순매수·외국인 보유율 블록은 아직 샘플이다.
//   KRX Open API가 이 데이터를 주는지가 확정되지 않은 상태라, 파서를 미리 쓰면
//   추측으로 짠 코드가 된다. 실제 응답을 먼저 받아보고 그 위에서 수집기를 만든다.
//
// SECURITY:
//   - 시크릿 로딩은 `scripts/lib/loadSecret.mjs` 단일 구현만 쓴다
//     (ops governance/SECRETS-POLICY.md — 시크릿 단일 원본 = Doppler).
//     하드코딩 경로 금지. 값은 어떤 경로로도 출력하지 않는다.
//   - KRX Open API는 **공공 데이터 인증키**이지 브로커 계좌 자격증명이 아니다.
//     주문 기능이 없으므로 리포 규칙 2(실계좌 경계)에 걸리지 않는다.
//   - 이 스크립트는 읽기만 한다. 파일을 쓰지 않고 커밋도 하지 않는다.
//
// 사용법 (표준):
//   doppler run --project investing-ops --config prd -- node scripts/probe-krx.mjs
//
// 출력: 후보 엔드포인트별 HTTP 상태 + 응답 앞부분(키 마스킹). 그대로 복사해 전달하면
//       그 구조에 맞춰 수집기를 작성한다.

import { loadSecret, maskerFor } from './lib/loadSecret.mjs'

// ---- key loading (값은 절대 출력되지 않는다) --------------------------------
const secret = loadSecret('KRX_API_KEY', { project: 'investing-ops' })
if (!secret.value) {
  console.error('')
  console.error(secret.help)
  console.error('')
  console.error('키 발급: KRX 오픈API 포털 회원가입 → 인증키 신청.')
  process.exit(1)
}
const KEY = secret.value
const mask = maskerFor(KEY)

// ---- 후보 엔드포인트 --------------------------------------------------------
// KRX 오픈API의 정확한 베이스/경로가 확정되지 않아 후보를 순회하며 무엇이 응답하는지 본다.
// 인증키 전달 방식도 헤더/쿼리 두 가지를 모두 시도한다.
const BASES = [
  'https://data-dbg.krx.co.kr/svc/apis',
  'https://openapi.krx.co.kr/svc/apis',
  'http://data-dbg.krx.co.kr/svc/apis',
]

// KRX가 서비스명을 어떻게 쪼개는지 모르므로, 주식 일별매매정보(거의 확실히 존재)와
// 투자자별 거래실적(우리가 필요한 것) 후보를 함께 던져 본다.
const PATHS = [
  { name: '주식 일별매매정보(유가)', path: '/sto/stk_bydd_trd' },
  { name: '투자자별 거래실적 후보 A', path: '/sto/stk_invsr_trd' },
  { name: '투자자별 거래실적 후보 B', path: '/sto/invsr_trd' },
  { name: '투자자별 거래실적 후보 C', path: '/sto/stk_isu_invsr_trd' },
  { name: '서비스 목록 후보', path: '/svc/apis' },
]

// 직전 영업일 근사 — 주말이면 금요일로 당긴다(공휴일은 무시, 조사용).
function lastBusinessDay() {
  const kst = new Date(Date.now() + 9 * 3600 * 1000)
  kst.setUTCDate(kst.getUTCDate() - 1)
  while (kst.getUTCDay() === 0 || kst.getUTCDay() === 6) kst.setUTCDate(kst.getUTCDate() - 1)
  const y = kst.getUTCFullYear()
  const m = String(kst.getUTCMonth() + 1).padStart(2, '0')
  const d = String(kst.getUTCDate()).padStart(2, '0')
  return `${y}${m}${d}`
}

const BASDD = lastBusinessDay()

async function probe(base, { name, path }, authMode) {
  const url = new URL(base + path)
  url.searchParams.set('basDd', BASDD)
  if (authMode === 'query') url.searchParams.set('AUTH_KEY', KEY)

  const headers = { Accept: 'application/json' }
  if (authMode === 'header') headers.AUTH_KEY = KEY

  const label = `${name} [${authMode}] ${mask(url.toString())}`
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 15000)
    const res = await fetch(url, { headers, signal: ctrl.signal })
    clearTimeout(timer)
    const text = await res.text()
    const head = mask(text).replace(/\s+/g, ' ').slice(0, 400)
    return { label, status: res.status, ok: res.ok, head, bytes: text.length }
  } catch (e) {
    return { label, status: 0, ok: false, head: `ERROR ${mask(e.message)}`, bytes: 0 }
  }
}

console.log(`KRX Open API 조사 — 기준일 ${BASDD}`)
console.log('(인증키는 출력되지 않습니다)\n')

// 응답 자체가 없거나(0) 호스트가 막힌(403) 베이스는 나머지 경로를 볼 필요가 없다.
// 인증 실패(401)나 경로 없음(404)은 "베이스는 살아있다"는 뜻이므로 계속 훑는다.
function baseIsDead(r) {
  return r.status === 0 || r.status === 403
}

let anyOk = false
for (const base of BASES) {
  console.log(`\n===== ${base} =====`)
  let dead = false
  for (const p of PATHS) {
    for (const mode of ['header', 'query']) {
      const r = await probe(base, p, mode)
      const flag = r.ok ? '✅' : r.status === 0 ? '⛔' : '⚠️ '
      console.log(`${flag} ${r.status} (${r.bytes}B) ${r.label}`)
      if (r.head) console.log(`     ${r.head}`)
      if (r.ok) anyOk = true
      if (p === PATHS[0] && baseIsDead(r)) dead = true
      else dead = false
    }
    if (dead) {
      console.log('     ↳ 이 베이스는 접속 자체가 안 됩니다. 나머지 경로는 건너뜁니다.')
      break
    }
  }
}

console.log('\n----------------------------------------------------------')
if (anyOk) {
  console.log('✅ 응답한 엔드포인트가 있습니다. 위 출력 전체를 그대로 복사해 전달해 주십시오.')
  console.log('   응답 구조를 보고 투자자별 거래실적 제공 여부를 확정한 뒤 수집기를 작성합니다.')
} else {
  console.log('⚠️  응답한 엔드포인트가 없습니다. 다음 중 하나입니다:')
  console.log('   1) 인증키가 아직 승인 대기 상태 (KRX는 신청 후 승인까지 시간이 걸릴 수 있음)')
  console.log('   2) 베이스 URL·경로가 위 후보와 다름 → 포털의 "API 명세" 화면 캡처를 보내주시면 맞춰 넣겠습니다')
  console.log('   3) 네트워크·방화벽 차단')
  console.log('   어느 경우든 위 출력을 그대로 전달해 주시면 원인을 좁힐 수 있습니다.')
}
console.log('----------------------------------------------------------')
