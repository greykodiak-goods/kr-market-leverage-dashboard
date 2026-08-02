// 종목별 투자자(외국인·기관) 순매수 이력 프로브 — 수급 기반 전략 검증의 선행 조사.
// (2026-08-02 대표 지시 "수급·거래량 기반 투자 검토 → 해봐")
//
// 목적 (조회 전용 · 규칙 2 1단계 범위):
//   ① ka10059(종목별투자자기관별)·ka10060(차트형)의 REST 경로·요청 필드를 실측 확정
//      — 문서상 추정이라 후보 경로를 순회하며 응답 코드·키 이름을 그대로 출력한다.
//   ② 성공한 TR로 삼성전자(005930)를 연속조회해 **이력이 몇 년까지 소급되는지** 측정
//      — 짧으면 백테스트 불가 → 데몬 일일 적재(forward)로 전환해야 한다.
//
// 출력 원칙: 시크릿은 loadSecret 경유(값 미출력·길이만). 응답은 키 이름·날짜·행 수만 —
//            시세·수급 수치는 시크릿이 아니므로 표본 1~2행은 출력해 필드 의미를 확정한다.
//
// 실행(EC2): deploy-investing.yml backtest_mode=probe:flow
//   로컬: doppler run --project investing-ops --config prd -- node scripts/kiwoom-flow-probe.mjs

import { loadSecret } from './lib/loadSecret.mjs'
import { createKiwoomClient } from './lib/kiwoom.mjs'

const key = loadSecret('KIWOOM_MOCK_APP_KEY')
const secret = loadSecret('KIWOOM_MOCK_APP_SECRET')
if (!key.value || !secret.value) {
  console.error('모의투자 앱키 없음 — Doppler investing-ops 확인')
  process.exit(1)
}
console.log(`앱키: ${key.source} (길이 ${key.value.length}) · 시크릿: ${secret.source} (길이 ${secret.value.length})`)

const client = createKiwoomClient({ appKey: key.value, appSecret: secret.value })
console.log(`서버: ${client.base} (모의서버 고정 — 조회 전용, 주문 계열 api-id 없음)`)

const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10).replace(/-/g, '')
const STK = '005930'

// 후보 (경로 × api-id × 요청 바디) — 전부 [미검증] 추정, 실측으로 확정한다.
// OpenAPI+ OPT10059 계보: 일자·종목코드·금액수량구분(2:수량)·매매구분(0:순매수)·단위구분(1:단주)
const CANDIDATES = [
  { path: '/api/dostk/stkinfo', apiId: 'ka10059', body: { dt: today, stk_cd: STK, amt_qty_tp: '2', trde_tp: '0', unit_tp: '1' } },
  { path: '/api/dostk/frgnistt', apiId: 'ka10059', body: { dt: today, stk_cd: STK, amt_qty_tp: '2', trde_tp: '0', unit_tp: '1' } },
  { path: '/api/dostk/invsttrnd', apiId: 'ka10059', body: { dt: today, stk_cd: STK, amt_qty_tp: '2', trde_tp: '0', unit_tp: '1' } },
  { path: '/api/dostk/chart', apiId: 'ka10060', body: { dt: today, stk_cd: STK, amt_qty_tp: '2', trde_tp: '0', unit_tp: '1' } },
  { path: '/api/dostk/stkinfo', apiId: 'ka10060', body: { dt: today, stk_cd: STK, amt_qty_tp: '2', trde_tp: '0', unit_tp: '1' } },
]

const findRows = (json) => {
  for (const [k, v] of Object.entries(json)) if (Array.isArray(v) && v.length) return { key: k, rows: v }
  return null
}
const dateOf = (row) => {
  for (const k of ['dt', 'date', 'trde_dt', 'stck_bsop_date']) if (row?.[k]) return String(row[k])
  return null
}

let hit = null
for (const c of CANDIDATES) {
  try {
    const { json, cont } = await client.request(c.path, c.apiId, c.body)
    const rc = json.return_code ?? json.rt_cd ?? '?'
    const arr = findRows(json)
    console.log(`\n[${c.apiId} ${c.path}] return_code=${rc} · 응답 키: [${Object.keys(json).join(', ')}]`)
    if (arr) {
      console.log(`  ✅ 배열 "${arr.key}" ${arr.rows.length}행 · cont-yn=${cont.contYn}`)
      console.log(`  첫 행 필드: ${Object.keys(arr.rows[0]).join(', ')}`)
      console.log(`  첫 행 표본: ${JSON.stringify(arr.rows[0])}`)
      if (!hit && String(rc) === '0') hit = { ...c, listKey: arr.key, cont }
    } else {
      console.log(`  행 없음 — return_msg: ${String(json.return_msg ?? '').slice(0, 80)}`)
    }
  } catch (e) {
    console.log(`\n[${c.apiId} ${c.path}] ❌ ${String(e.message).slice(0, 140)}`)
  }
}

if (!hit) {
  console.log('\n결론: 어떤 후보도 행을 반환하지 않음 — api-id·경로·필드명 재조사 필요 [미검증 유지]')
  process.exit(0)
}

// 이력 깊이 측정 — 연속조회로 최대 40페이지(호출 유량 보호)
console.log(`\n[깊이 측정] ${hit.apiId} ${hit.path} — 연속조회로 소급 한계 확인 (최대 40페이지)`)
let contYn = hit.cont.contYn ?? 'N'
let nextKey = hit.cont.nextKey ?? ''
let pages = 1
let total = 0
let earliest = null
let latest = null
{
  const { json } = await client.request(hit.path, hit.apiId, hit.body)
  const arr = findRows(json)
  if (arr) {
    total += arr.rows.length
    for (const r of arr.rows) {
      const d = dateOf(r)
      if (d) {
        if (!earliest || d < earliest) earliest = d
        if (!latest || d > latest) latest = d
      }
    }
  }
}
while (contYn === 'Y' && pages < 40) {
  const { json, cont } = await client.request(hit.path, hit.apiId, hit.body, { contYn: 'Y', nextKey })
  const arr = findRows(json)
  if (!arr) break
  total += arr.rows.length
  for (const r of arr.rows) {
    const d = dateOf(r)
    if (d && (!earliest || d < earliest)) earliest = d
  }
  contYn = cont.contYn ?? 'N'
  nextKey = cont.nextKey ?? ''
  pages++
}
console.log(`페이지 ${pages} · 누적 ${total}행 · 최신 ${latest} · 최고(最古) ${earliest}${contYn === 'Y' ? ' · 더 있음(40p 상한 도달)' : ' · 끝 도달'}`)
console.log('\n판정 가이드: 최고 날짜가 수년 전이면 백테스트 가능 / 최근 수개월이면 데몬 일일 적재(forward)로 전환.')
console.log('※ 조회 전용 프로브 — 주문·자격증명 변경 없음. 수치는 모의서버 기준 [미검증-실서버 대조 전].')
