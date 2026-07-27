// Doppler 키 존재 확인 — **값은 절대 출력하지 않는다.**
//
// ops governance/SECRETS-POLICY.md §2: "검증은 값 미출력 원칙: 존재 여부(SET/MISSING)·길이만 표시."
// 참고 구현: awning-ops/.github/workflows/doppler-check.yml
//
// 왜 필요한가:
//   AI 세션에는 DOPPLER_TOKEN이 없다(§2, 의도된 제약). 그래서 어떤 키가 Doppler에
//   들어갔는지 AI가 직접 확인할 방법이 없다. 대표가 이 스크립트를 한 번 돌려 그 출력을
//   주면, 값 노출 없이 "무엇이 준비됐고 무엇이 비었는지"만 공유된다.
//
// 사용법:
//   doppler run --project investing-ops --config prd -- node scripts/doppler-check.mjs
//
// 출력 예:
//   ✅ SET     DART_API_KEY        (40자)  — DART 공시 수집
//   ⛔ MISSING DATA_GO_KR_KEY              — 공공데이터포털(대차·공매도)

import { resolveSecret } from './lib/loadSecret.mjs'

// 투자 도메인이 쓰는(또는 쓸) 시크릿 목록. 값은 여기 적지 않는다 — 이름표일 뿐.
const KEYS = [
  { name: 'DART_API_KEY', use: 'DART 공시 수집 (5%룰·내부자·오버행)', status: '연동됨' },
  { name: 'KRX_API_KEY', use: 'KRX 오픈API (투자자별 거래실적 조사 중)', status: '신규' },
  { name: 'DATA_GO_KR_KEY', use: '공공데이터포털 (주식대차정보 등)', status: '대기' },
  { name: 'CONVEX_DEPLOY_KEY', use: 'Convex 배포', status: '이관대상' },
  { name: 'INGEST_TOKEN', use: 'Convex POST /ingest/* 쓰기 보호', status: '이관대상' },
]

const env = process.env
const viaDoppler = Boolean(env.DOPPLER_PROJECT || env.DOPPLER_CONFIG)

console.log('투자 도메인 시크릿 점검 — 값은 출력되지 않습니다')
console.log(
  viaDoppler
    ? `✅ Doppler 경유: ${env.DOPPLER_PROJECT ?? '?'} / ${env.DOPPLER_CONFIG ?? '?'}`
    : '⚠️  Doppler 경유가 아닙니다. 표준: doppler run --project investing-ops --config prd -- node scripts/doppler-check.mjs',
)
console.log('')

let set = 0
const missing = []
for (const k of KEYS) {
  const r = resolveSecret({ name: k.name, env })
  if (r.value) {
    set++
    console.log(`✅ SET     ${k.name.padEnd(20)} (${String(r.value.length).padStart(3)}자)  — ${k.use}`)
  } else {
    missing.push(k)
    console.log(`⛔ MISSING ${k.name.padEnd(20)}          — ${k.use} [${k.status}]`)
  }
}

console.log('')
console.log(`${set}/${KEYS.length} 준비됨`)
if (missing.length) {
  console.log('')
  console.log('비어 있는 키는 Doppler 콘솔에서 대표님이 직접 입력하십시오(T0).')
  console.log(`  프로젝트 investing-ops / config prd → Add Secret: ${missing.map((m) => m.name).join(', ')}`)
  console.log('  (AI 세션에는 DOPPLER_TOKEN을 주지 않습니다 — SECRETS-POLICY §2)')
}
console.log('')
console.log('이 출력은 값이 없으므로 그대로 복사해 공유하셔도 안전합니다.')
