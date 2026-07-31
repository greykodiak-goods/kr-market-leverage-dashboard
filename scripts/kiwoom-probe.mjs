// 키움 REST API 1단계 연결 점검 (조회 전용) — 대표 PC에서 실행하는 스모크 테스트.
//
// 실행 표준 (시크릿은 Doppler 경유, 값은 화면에 안 찍힘):
//   doppler run --project <도플러프로젝트> --config prd -- node scripts/kiwoom-probe.mjs
//
// 하는 일: ①앱키 존재 확인(길이만) ②접근 토큰 발급 ③삼성전자 5분봉 1회 조회.
// 실패하면 응답의 "키 이름"만 출력한다 — 그 로그를 그대로 총괄 세션에 붙여넣으면
// TR 명세([미검증] 항목)를 보정한다. 주문·이체 호출은 이 스크립트에 없다(규칙 2).

import { loadSecret, maskerFor } from './lib/loadSecret.mjs'
import { createKiwoomClient } from './lib/kiwoom.mjs'

// 키움은 실전용/모의투자용 앱키가 별개다(에러 8030: 투자구분 불일치 — 2026-07-30 실측).
// 모의서버(기본)에는 모의투자용 키를 우선 쓰고, 없으면 공용 이름으로 폴백한다.
// 실전용 키(KIWOOM_APP_KEY)는 1단계 실서버 조회를 여는 시점(가드 테스트 개정 필요)까지 보관만.
const mockKey = loadSecret('KIWOOM_MOCK_APP_KEY')
const mockSecret = loadSecret('KIWOOM_MOCK_APP_SECRET')
const key = mockKey.value ? mockKey : loadSecret('KIWOOM_APP_KEY')
const secret = mockSecret.value ? mockSecret : loadSecret('KIWOOM_APP_SECRET')
if (!mockKey.value) console.error('ℹ️ KIWOOM_MOCK_APP_KEY 없음 — 공용 키로 폴백 (모의서버는 모의투자용 키 필요)')
if (!key.value || !secret.value) {
  console.error(key.help ?? secret.help)
  process.exit(1)
}
const mask = maskerFor(key.value, secret.value)

const client = createKiwoomClient({ appKey: key.value, appSecret: secret.value })
console.log(`서버: ${client.base} (기본 = 모의서버 — 규칙 2)`)

try {
  const t = await client.issueToken()
  console.log(`① 토큰 발급 OK (길이 ${t.tokenLength})`)
} catch (e) {
  console.error(`① 토큰 발급 실패: ${mask(e.message)}`)
  console.error('   → IP 등록 여부(포털)와 앱키 활성화 상태를 확인하세요. 이 로그를 총괄 세션에 붙여넣으면 보정합니다.')
  process.exit(1)
}

try {
  const { json } = await client.minuteChart('005930', { minutes: 5 })
  const keys = Object.keys(json)
  const arr = Object.values(json).find((v) => Array.isArray(v))
  console.log(`② 5분봉 조회(005930) OK — 응답 키: [${keys.join(', ')}] · 배열 길이: ${Array.isArray(arr) ? arr.length : '없음'}`)
  if (Array.isArray(arr) && arr.length) {
    console.log(`   첫 행 키: [${Object.keys(arr[0]).join(', ')}]`)
  }
  console.log('✅ 1단계 조회 연결 검증 통과 — 이 출력 전체를 총괄 세션에 붙여넣어 주세요(어댑터 필드 매핑에 사용).')
} catch (e) {
  console.error(`② 분봉 조회 실패: ${mask(e.message)}`)
  console.error('   → TR 명세 [미검증] 보정 필요 — 이 로그를 총괄 세션에 붙여넣어 주세요.')
  process.exit(1)
}
