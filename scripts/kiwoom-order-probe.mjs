// 키움 **모의서버** 주문 어댑터 검증 스크립트 — 대표 PC에서 실행하는 스모크 테스트.
// 규칙 2 「2단계 모의투자 주문」. 실서버(3단계)와는 무관하며 주소는 mockapi 고정이다.
//
// 실행 (시크릿은 Doppler 경유 · 값은 화면에 안 찍힘):
//   ① 조회 + dryRun 계획만 (아무것도 전송하지 않음 — 기본)
//      doppler run --project investing-ops --config prd -- node scripts/kiwoom-order-probe.mjs
//   ② 실제 모의 주문 왕복 (삼성전자 1주 매수 → 즉시 취소) — 플래그 **둘 다** 필요
//      doppler run --project investing-ops --config prd -- node scripts/kiwoom-order-probe.mjs --live --confirm-mock
//
// 출력 원칙: 시크릿·계좌번호는 어떤 경로로도 출력하지 않는다(존재/길이만).
//            return_code/return_msg 와 응답 "키 이름"은 TR 명세 [미검증] 보정용이라 출력한다.
//            시세·수량·금액은 시크릿이 아니므로 출력한다.
//
// 이 로그 전체를 총괄 세션에 붙여넣으면 [미검증] TR 필드명을 실측으로 확정한다.

import { loadSecret, maskerFor } from './lib/loadSecret.mjs'
import { createKiwoomOrderClient, HARD_LIMITS, parseBalance } from './lib/kiwoomOrder.mjs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = process.env.REPO_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), '..')
const args = new Set(process.argv.slice(2))
const live = args.has('--live')
const confirmed = args.has('--confirm-mock')

const key = loadSecret('KIWOOM_MOCK_APP_KEY')
const secret = loadSecret('KIWOOM_MOCK_APP_SECRET')
const account = loadSecret('KIWOOM_MOCK_ACCOUNT')
if (!key.value || !secret.value) {
  console.error(key.help ?? secret.help)
  console.error('\n※ 모의서버는 **모의투자용** 앱키가 따로 필요하다(실전 키를 쓰면 에러 8030).')
  process.exit(1)
}
if (!account.value) console.error('ℹ️ KIWOOM_MOCK_ACCOUNT 없음 — 조회·주문은 토큰에 묶인 계좌로 나간다 [미검증]')
const mask = maskerFor(key.value, secret.value, account.value)

const client = createKiwoomOrderClient({
  appKey: key.value,
  appSecret: secret.value,
  accountNo: account.value ?? undefined,
  dryRun: !live,
  root,
})

console.log(`\n서버: ${client.base} (모의서버 고정 — 규칙 2)`)
console.log(`모드: ${client.dryRun ? 'dryRun (전송 안 함)' : '⚠️ LIVE (모의서버로 실제 주문 전송)'}`)
console.log(
  `게이트: 1회 ≤ ${client.limits.maxOrderAmountKrw.toLocaleString()}원 · 일일 ≤ ${client.limits.maxDailyOrders}건 · HALT=${
    client.isHalted() ? '존재(주문 전면 중단)' : '없음'
  }`,
)
console.log(`계좌 시크릿: ${client.hasAccountNo ? '설정됨' : '없음'} (값 미출력)`)

const SYMBOL = '005930' // 삼성전자
let refPrice = null

// ── ① 잔고 조회 ──────────────────────────────────────────────────────────────
try {
  const bal = await client.getBalance()
  console.log(`\n① 잔고 조회 OK — 응답 키: [${Object.keys(bal.raw ?? {}).join(', ')}]`)
  console.log(`   총평가 ${bal.totalAssetKrw ?? '[파싱실패]'} · 현금 ${bal.cashKrw ?? '[파싱실패]'} · 보유 ${bal.holdings.length}종목`)
  for (const h of bal.holdings.slice(0, 10)) console.log(`   - ${h.symbol} ${h.qty}주 @ ${h.avgPrice ?? '?'}`)
  if (bal.totalAssetKrw == null)
    console.log('   ⚠️ [미검증] 총평가 필드명을 못 찾음 — 위 응답 키를 총괄 세션에 붙여넣어 parseBalance 보정 필요')
} catch (e) {
  console.error(`\n① 잔고 조회 실패: ${mask(e.message)}`)
  console.error('   → [미검증] kt00018 경로·필드 보정 필요. 이 로그를 총괄 세션에 붙여넣어 주세요.')
}

// ── ② 현재가(주문 기준가) ────────────────────────────────────────────────────
// 게이트가 금액을 계산해야 하므로 기준가는 필수다. 일봉 마지막 종가로 근사한다.
try {
  const { createKiwoomClient } = await import('./lib/kiwoom.mjs')
  const q = createKiwoomClient({ appKey: key.value, appSecret: secret.value })
  const { json } = await q.dailyChart(SYMBOL)
  const rows = Object.values(json).find((v) => Array.isArray(v)) ?? []
  const last = rows[0] ?? rows[rows.length - 1]
  const raw = last?.cur_prc ?? last?.close_pric
  refPrice = raw != null ? Math.abs(Number(String(raw).replace(/^[+-]/, ''))) : null
  console.log(`\n② 기준가(005930 일봉 최근 종가): ${refPrice ?? '[미확인]'}`)
} catch (e) {
  console.error(`\n② 기준가 조회 실패: ${mask(e.message)} — 아래 단계는 기준가 없이는 게이트가 거부한다`)
}

// ── ③ dryRun 주문 계획 (항상 실행 · 전송 없음) ───────────────────────────────
{
  const plannerRoot = root
  const planner = createKiwoomOrderClient({
    appKey: key.value,
    appSecret: secret.value,
    accountNo: account.value ?? undefined,
    dryRun: true, // 이 블록은 --live 여부와 무관하게 항상 dryRun
    root: plannerRoot,
  })
  const r = await planner.placeOrder({ side: 'buy', symbol: SYMBOL, qty: 1, price: refPrice ?? 0 })
  console.log(`\n③ dryRun 매수 계획 — 전송 ${r.sent ? '함(버그!)' : '안 함'} · 게이트 ${r.gate.ok ? '통과' : `차단(${r.gate.reason})`}`)
  console.log(`   계획: ${JSON.stringify(r.plan)}`)

  // 게이트가 실제로 막는지도 같은 자리에서 확인한다(한도의 100배 주문).
  const over = await planner.placeOrder({ side: 'buy', symbol: SYMBOL, qty: 1, price: HARD_LIMITS.maxOrderAmountKrw + 1 })
  console.log(`   한도 초과 주문 차단 확인: ${over.blocked ? `✅ 차단 — ${over.gate.reason}` : '❌ 통과됨(버그!)'}`)
}

// ── ④ 실제 모의 주문 왕복 (플래그 2개 모두 필요) ─────────────────────────────
if (!live || !confirmed) {
  console.log(
    `\n④ 실제 모의 주문 왕복 건너뜀 — 필요하면 두 플래그를 모두 주세요: --live --confirm-mock (현재 --live=${live}, --confirm-mock=${confirmed})`,
  )
  console.log('\n완료. 위 출력 전체를 총괄 세션에 붙여넣어 주세요([미검증] TR 확정용).')
  process.exit(0)
}

if (refPrice == null) {
  console.error('\n④ 기준가를 못 구해 왕복 테스트를 중단한다(금액 게이트 계산 불가).')
  process.exit(1)
}

console.log('\n④ 모의서버 실주문 왕복 — 삼성전자 1주 지정가 매수 → 즉시 취소')
// 즉시 체결되면 취소가 실패하는 게 정상이다. 체결을 피하려고 호가를 크게 낮추면 주문 자체가
// 거부될 수 있어, 현재가보다 5% 낮은 지정가로 낸다(미체결 유도 · [미검증] 호가단위 반올림).
const tick = refPrice >= 50000 ? 100 : refPrice >= 20000 ? 50 : 10
const limitPrice = Math.floor((refPrice * 0.95) / tick) * tick
console.log(`   지정가 ${limitPrice} (현재가 ${refPrice} 대비 -5% · 호가단위 ${tick} [미검증])`)

const buy = await client.placeOrder({ side: 'buy', symbol: SYMBOL, qty: 1, price: limitPrice })
console.log(`   매수 응답: return_code=${buy.returnCode} return_msg="${buy.returnMsg ?? ''}"`)
console.log(`   응답 키: [${(buy.responseKeys ?? []).join(', ')}] · 주문번호 파싱: ${buy.orderNo ?? '[미검증 — 필드명 확인 필요]'}`)
if (buy.error) console.error(`   ❌ ${mask(buy.error)}`)

if (buy.orderNo) {
  const cancel = await client.cancelOrder({ orderNo: buy.orderNo, symbol: SYMBOL, qty: 1, price: limitPrice })
  console.log(`   취소 응답: return_code=${cancel.returnCode} return_msg="${cancel.returnMsg ?? ''}"`)
  console.log(`   응답 키: [${(cancel.responseKeys ?? []).join(', ')}]`)
  if (cancel.error) console.error(`   ❌ ${mask(cancel.error)}`)
  console.log(
    cancel.ok
      ? '   ✅ 왕복 완료 — 잔고에 포지션이 남지 않았는지 ①을 다시 돌려 확인하세요.'
      : '   ⚠️ 취소 실패 — 체결됐을 수 있습니다. HTS(모의)에서 잔고를 직접 확인하세요.',
  )
} else {
  console.log('   ⚠️ 주문번호를 파싱하지 못해 취소를 시도하지 않았다. 응답 키를 총괄 세션에 붙여넣어 주세요.')
  console.log('      (주문이 접수됐다면 모의 HTS에서 수동 취소 필요)')
}

// 체결내역도 한 번 훑어 필드명을 확보한다.
try {
  const ex = await client.getExecutions({ date: new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10) })
  console.log(`\n⑤ 체결내역 조회 — return_code=${ex.returnCode} return_msg="${ex.returnMsg ?? ''}"`)
  console.log(`   응답 키: [${Object.keys(ex.raw ?? {}).join(', ')}]`)
} catch (e) {
  console.error(`\n⑤ 체결내역 조회 실패: ${mask(e.message)} — [미검증] kt00007 보정 필요`)
}

console.log('\n완료. 위 출력 전체를 총괄 세션에 붙여넣어 주세요([미검증] TR 확정용).')
