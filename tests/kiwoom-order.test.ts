// 규칙 2 「2단계」 주문 게이트 검증 — **네트워크 없이** 순수 로직만 본다.
//
// 여기서 지키는 것:
//   ① 하드 한도는 env 로 완화되지 않는다(강화만 가능).
//   ② 1회 주문액·일일 건수 초과는 전송 전에 거부된다.
//   ③ HALT 파일이 있으면 모든 주문이 막힌다.
//   ④ dryRun 이 기본값이고, dryRun 에서는 fetch 가 단 한 번도 호출되지 않는다.
//   ⑤ 모의서버가 아닌 주소로는 어댑터가 아예 생성되지 않는다(실서버 오배송 차단).
//   ⑥ 응답에서 계좌번호성 필드는 제거된다.

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  HARD_LIMITS,
  createKiwoomOrderClient,
  evaluateGates,
  parseBalance,
  readDailyCount,
  redactAccount,
  resolveLimits,
  toKiwoomCode,
} from '../scripts/lib/kiwoomOrder.mjs'
import { check, eq, finish, section } from './harness'

const LIM = { maxOrderAmountKrw: HARD_LIMITS.maxOrderAmountKrw, maxDailyOrders: HARD_LIMITS.maxDailyOrders }
const tmpRoot = (): string => mkdtempSync(join(tmpdir(), 'kiwoom-order-'))

section('0) 하드 상수가 지시서 값 그대로다')
{
  eq('1회 주문액 상한 15,000,000원', HARD_LIMITS.maxOrderAmountKrw, 15_000_000)
  eq('일일 주문 30건', HARD_LIMITS.maxDailyOrders, 30)
  eq('킬 스위치 파일명', HARD_LIMITS.haltFile, 'HALT')
}

section('1) resolveLimits — env 는 한도를 낮추기만 한다')
{
  eq('env 없음 → 하드 상수', resolveLimits({}).maxOrderAmountKrw, 15_000_000)
  eq('더 큰 값 요청은 무시', resolveLimits({ KIWOOM_MAX_ORDER_KRW: '999999999' }).maxOrderAmountKrw, 15_000_000)
  eq('더 작은 값은 반영(강화)', resolveLimits({ KIWOOM_MAX_ORDER_KRW: '1000000' }).maxOrderAmountKrw, 1_000_000)
  eq('일일 건수 확대 무시', resolveLimits({ KIWOOM_MAX_DAILY_ORDERS: '500' }).maxDailyOrders, 30)
  eq('일일 건수 축소 반영', resolveLimits({ KIWOOM_MAX_DAILY_ORDERS: '3' }).maxDailyOrders, 3)
  eq('쓰레기 값은 하드 상수 유지', resolveLimits({ KIWOOM_MAX_ORDER_KRW: 'abc' }).maxOrderAmountKrw, 15_000_000)
  eq('음수는 하드 상수 유지', resolveLimits({ KIWOOM_MAX_DAILY_ORDERS: '-1' }).maxDailyOrders, 30)
}

section('2) evaluateGates — 금액·건수·HALT')
{
  const base = { dailyCount: 0, halt: false, limits: LIM }
  check('정상 주문 통과', evaluateGates({ qty: 10, priceKrw: 70_000, ...base }).ok)
  eq('금액 계산', evaluateGates({ qty: 10, priceKrw: 70_000, ...base }).amountKrw, 700_000)

  const atLimit = evaluateGates({ qty: 1, priceKrw: 15_000_000, ...base })
  check('한도 정확히 = 통과', atLimit.ok)
  const over = evaluateGates({ qty: 1, priceKrw: 15_000_001, ...base })
  check('한도 1원 초과 = 거부', !over.ok)
  check('거부 사유에 한도 표기', /1회 주문액 한도 초과/.test(over.reason ?? ''))
  check('수량으로 초과해도 거부', !evaluateGates({ qty: 300, priceKrw: 70_000, ...base }).ok)

  check('29건째 통과', evaluateGates({ qty: 1, priceKrw: 1000, ...base, dailyCount: 29 }).ok)
  check('30건 도달 시 거부', !evaluateGates({ qty: 1, priceKrw: 1000, ...base, dailyCount: 30 }).ok)
  check('한도 초과 상태도 거부', !evaluateGates({ qty: 1, priceKrw: 1000, ...base, dailyCount: 99 }).ok)

  const halted = evaluateGates({ qty: 1, priceKrw: 1000, ...base, halt: true })
  check('HALT 시 거부', !halted.ok)
  check('HALT 사유 표기', /HALT/.test(halted.reason ?? ''))

  check('수량 0 거부', !evaluateGates({ qty: 0, priceKrw: 1000, ...base }).ok)
  check('소수 수량 거부', !evaluateGates({ qty: 1.5, priceKrw: 1000, ...base }).ok)
  check('기준가 0 거부(금액 게이트 계산 불가)', !evaluateGates({ qty: 1, priceKrw: 0, ...base }).ok)
  check('기준가 NaN 거부', !evaluateGates({ qty: 1, priceKrw: NaN, ...base }).ok)

  // 강화된 한도가 실제로 적용되는지 (env → resolveLimits → evaluateGates 경로)
  const tight = resolveLimits({ KIWOOM_MAX_ORDER_KRW: '100000' })
  check('강화 한도로 거부', !evaluateGates({ qty: 2, priceKrw: 70_000, dailyCount: 0, halt: false, limits: tight }).ok)
}

section('3) toKiwoomCode — 종목코드 정규화')
{
  eq('.KS 접미', toKiwoomCode('005930.KS'), '005930')
  eq('.KQ 접미', toKiwoomCode('196170.KQ'), '196170')
  eq('접미 없음', toKiwoomCode('005930'), '005930')
  let threw = false
  try {
    toKiwoomCode('AAPL')
  } catch {
    threw = true
  }
  check('국내 코드 아니면 예외', threw)
}

async function main(): Promise<void> {
  section('4) createKiwoomOrderClient — dryRun 기본 · 네트워크 미호출')
  const root = tmpRoot()
  let fetchCalls = 0
  const spyFetch = async (): Promise<never> => {
    fetchCalls++
    throw new Error('dryRun 인데 네트워크를 탔다 — 게이트 우회')
  }
  const c = createKiwoomOrderClient({
    appKey: 'k'.repeat(20),
    appSecret: 's'.repeat(20),
    root,
    fetchImpl: spyFetch,
    env: {},
    log: () => {},
  })
  eq('dryRun 기본값 true', c.dryRun, true)
  check('모의서버 주소', /mockapi/.test(c.base))

  const res = await c.placeOrder({ side: 'buy', symbol: '005930.KS', qty: 1, price: 70_000 })
  eq('dryRun: 전송 안 함', res.sent, false)
  eq('dryRun: 차단 아님(계획은 유효)', res.blocked, false)
  eq('fetch 호출 0회', fetchCalls, 0)
  eq('계획 금액', res.plan.amountKrw, 70_000)
  eq('종목코드 정규화됨', res.plan.symbol, '005930')

  // 한도 초과는 dryRun 에서도 차단으로 표시된다
  const over = await c.placeOrder({ side: 'buy', symbol: '005930', qty: 1000, price: 70_000 })
  eq('한도 초과 차단', over.blocked, true)
  eq('fetch 여전히 0회', fetchCalls, 0)

  // HALT 파일은 생성 시점이 아니라 **주문 시점**에 본다
  writeFileSync(join(root, HARD_LIMITS.haltFile), '')
  check('HALT 감지', c.isHalted())
  const halted = await c.placeOrder({ side: 'buy', symbol: '005930', qty: 1, price: 70_000 })
  eq('HALT 시 차단', halted.blocked, true)
  check('HALT 사유', /HALT/.test(halted.gate.reason ?? ''))
  const cancelHalted = await c.cancelOrder({ orderNo: '1', symbol: '005930', qty: 1, price: 70_000 })
  eq('HALT 시 취소도 차단', cancelHalted.blocked, true)
  eq('전 과정 fetch 0회', fetchCalls, 0)

  section('5) 실서버 주소 거부 · 일일 카운터')
  let threw = false
  try {
    createKiwoomOrderClient({
      appKey: 'k'.repeat(20),
      appSecret: 's'.repeat(20),
      baseUrl: 'https://example.invalid',
      root,
      fetchImpl: spyFetch,
      env: {},
      log: () => {},
    })
  } catch {
    threw = true
  }
  check('모의서버 아닌 주소로는 어댑터 생성 불가', threw)

  const r2 = tmpRoot()
  eq('카운터 파일 없으면 0', readDailyCount(r2, '2026-07-31').count, 0)
  mkdirSync(join(r2, 'public', 'data', 'mock-live'), { recursive: true })
  writeFileSync(join(r2, 'public', 'data', 'mock-live', 'order-count.json'), JSON.stringify({ date: '2026-07-31', count: 7 }))
  eq('같은 날짜면 이어서 센다', readDailyCount(r2, '2026-07-31').count, 7)
  eq('날짜가 바뀌면 0으로 리셋', readDailyCount(r2, '2026-08-03').count, 0)

  section('6) 응답 정규화 — 계좌번호 제거 · 잔고 파싱')
  const redacted = redactAccount({
    acnt_no: '1234567890',
    accnt_prsm: 'x',
    tot_evlt_amt: '10000000',
    rows: [{ acnt_nm: 'a', stk_cd: '005930' }],
  })
  eq('계좌 필드 제거(acnt_no)', redacted.acnt_no, undefined)
  eq('계좌 필드 제거(accnt_prsm)', redacted.accnt_prsm, undefined)
  eq('중첩 배열 안 계좌 필드 제거', redacted.rows[0].acnt_nm, undefined)
  eq('무관 필드는 보존', redacted.tot_evlt_amt, '10000000')

  const bal = parseBalance({
    tot_evlt_amt: '12,345,678',
    entr: '+1000000',
    acnt_evlt_remn_indv_tot: [
      { stk_cd: 'A005930', rmnd_qty: '10', pur_pric: '70000' },
      { stk_cd: 'A000660', rmnd_qty: '0', pur_pric: '200000' },
    ],
  })
  eq('총평가(콤마 제거)', bal.totalAssetKrw, 12_345_678)
  eq('현금(부호 제거)', bal.cashKrw, 1_000_000)
  eq('보유 1종목(수량 0 제외)', bal.holdings.length, 1)
  eq('종목코드 6자리', bal.holdings[0].symbol, '005930')
  eq('빈 응답', parseBalance({}).holdings.length, 0)
}

main().then(finish, (e) => {
  console.error(`테스트 실행 중 예외: ${e?.stack ?? e}`)
  process.exit(1)
})
