// 키움 **모의서버 전용** 주문 어댑터 — 규칙 2 「2단계 모의투자 주문」 (2026-07-30 대표 개방)
//
// ─────────────────────────────────────────────────────────────────────────────
// 경계 (tests/no-order-endpoint.test.ts · tests/kiwoom-order.test.ts 가 강제)
//   - 모의서버(mockapi.kiwoom.com)만 부른다. 실서버 주소는 3단계 승인 전까지 코드에
//     두지 않는다. 서버 주소는 kiwoom.mjs 의 MOCK_BASE(기본) / KIWOOM_BASE_URL 만.
//   - 자금 이체·입출금 API는 **영구 금지** — 이 파일에 그런 경로는 없고 앞으로도 없다.
//   - `dryRun` 기본 true. 실제 전송은 호출자가 명시적으로 dryRun:false 를 줄 때만.
//   - 하드 게이트는 아래 HARD_LIMITS 상수 — **환경변수로 완화 불가, 강화만 가능**.
//   - 실계좌 주문은 이 어댑터로 낼 수 없다(주소 자체가 모의서버). 3단계는 별도 승인.
//
// 게이트 우회 경로가 없도록, 네트워크로 나가는 모든 주문은 내부 submit() 한 곳만
// 통과한다. placeOrder/cancelOrder 는 전부 submit() 을 부른다.
//
// 시크릿: 값은 호출자가 loadSecret.mjs 로 읽어 넘긴다. 이 파일은 앱키·시크릿·계좌번호를
// 로그·에러·저널 어디에도 남기지 않는다(존재/길이만).
//
// ⚠️ [미검증] 주문·잔고 TR 명세는 **문서상 추정치**다. 모의서버 실측 전이므로
//    scripts/kiwoom-order-probe.mjs 를 대표 PC에서 돌려 return_code/return_msg 와
//    응답 키로 보정해야 한다. 각 추정 지점에 [미검증] 주석을 달아 두었다.
// ─────────────────────────────────────────────────────────────────────────────

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createKiwoomClient } from './kiwoom.mjs'

// ---- 하드 게이트 (코드 상수 · env 로 완화 불가) ------------------------------
export const HARD_LIMITS = Object.freeze({
  /** 1회 주문액 상한 (원) */
  maxOrderAmountKrw: 15_000_000,
  /** 일일 주문 건수 상한 (신규·정정·취소 전부 합산) */
  maxDailyOrders: 30,
  /** 킬 스위치 파일명 — 리포 루트에 존재하면 모든 주문 중단 */
  haltFile: 'HALT',
})

/** [미검증] 키움 REST 주문·계좌 TR — probe 실측으로 보정 대상 */
export const TR = Object.freeze({
  buy: 'kt10000', //  [미검증] 주식 매수주문
  sell: 'kt10001', // [미검증] 주식 매도주문
  modify: 'kt10002', // [미검증] 주식 정정주문 (현재 미사용 — 인터페이스 예약)
  cancel: 'kt10003', // [미검증] 주식 취소주문
  balance: 'kt00018', // [미검증] 계좌평가잔고내역요청
  executions: 'kt00007', // [미검증] 계좌별주문체결내역상세요청
})

export const PATH = Object.freeze({
  order: '/api/dostk/ordr', // [미검증] 주문 계열 공통 경로
  account: '/api/dostk/acnt', // [미검증] 계좌 계열 공통 경로
})

/** [미검증] 매매구분 코드 — 0=보통(지정가), 3=시장가 */
export const TRDE_TP = Object.freeze({ limit: '0', market: '3' })

// ---- 순수 게이트 로직 (네트워크·fs 없음 → 테스트 대상) -----------------------

/**
 * 실효 한도 계산. **환경변수는 한도를 낮추기만 한다** — 더 큰 값을 주면 무시된다.
 * @param {Record<string,string|undefined>} [env]
 */
export function resolveLimits(env = process.env) {
  const num = (raw) => {
    const n = Number(String(raw ?? '').trim())
    return Number.isFinite(n) && n > 0 ? n : null
  }
  const reqAmount = num(env.KIWOOM_MAX_ORDER_KRW)
  const reqDaily = num(env.KIWOOM_MAX_DAILY_ORDERS)
  return {
    maxOrderAmountKrw: Math.min(HARD_LIMITS.maxOrderAmountKrw, reqAmount ?? Infinity),
    maxDailyOrders: Math.min(HARD_LIMITS.maxDailyOrders, reqDaily ?? Infinity),
  }
}

/**
 * 주문 1건이 게이트를 통과하는지 판정한다. 통과 못 하면 이유를 돌려주고 전송하지 않는다.
 *
 * @param {object} o
 * @param {number} o.qty            주문 수량(정수 > 0)
 * @param {number} o.priceKrw       게이트 산정용 단가(원). 시장가라도 **기준가는 필수** —
 *                                  금액을 모르면 1회 주문액 한도를 지킬 수 없기 때문이다.
 * @param {number} o.dailyCount     오늘 이미 나간 주문 건수
 * @param {boolean} o.halt          HALT 파일 존재 여부
 * @param {{maxOrderAmountKrw:number,maxDailyOrders:number}} o.limits
 * @returns {{ ok: boolean, reason: string|null, amountKrw: number }}
 */
export function evaluateGates({ qty, priceKrw, dailyCount, halt, limits }) {
  const amountKrw = Number(qty) * Number(priceKrw)
  if (halt) return { ok: false, reason: `HALT 파일 존재 — 모든 주문 중단(킬 스위치)`, amountKrw }
  if (!Number.isInteger(qty) || qty <= 0) return { ok: false, reason: `수량이 양의 정수가 아님(${qty})`, amountKrw }
  if (!Number.isFinite(priceKrw) || priceKrw <= 0)
    return { ok: false, reason: `기준가가 유효하지 않음(${priceKrw}) — 금액 게이트를 계산할 수 없어 거부`, amountKrw }
  if (amountKrw > limits.maxOrderAmountKrw)
    return {
      ok: false,
      reason: `1회 주문액 한도 초과 — ${Math.round(amountKrw).toLocaleString()}원 > ${limits.maxOrderAmountKrw.toLocaleString()}원`,
      amountKrw,
    }
  if (dailyCount >= limits.maxDailyOrders)
    return { ok: false, reason: `일일 주문 건수 한도 도달 — ${dailyCount}/${limits.maxDailyOrders}건`, amountKrw }
  return { ok: true, reason: null, amountKrw }
}

/** '005930.KS' · '005930.KQ' · '005930' → '005930' (키움 6자리 종목코드) */
export function toKiwoomCode(symbol) {
  const s = String(symbol ?? '').trim().toUpperCase()
  const m = s.match(/^(\d{6})(?:\.[A-Z]{2})?$/)
  if (!m) throw new Error(`국내 6자리 종목코드가 아님: "${s}"`)
  return m[1]
}

/** 오늘(KST) 날짜 문자열 */
export function kstToday(now = new Date()) {
  return new Date(now.getTime() + 9 * 3600e3).toISOString().slice(0, 10)
}

// ---- 일일 카운터 (프로세스 재실행에도 유지되도록 파일에 둔다) ----------------

const counterPath = (root) => join(root, 'public', 'data', 'mock-live', 'order-count.json')

/** @returns {{ date: string, count: number }} */
export function readDailyCount(root, today = kstToday()) {
  try {
    const j = JSON.parse(readFileSync(counterPath(root), 'utf8'))
    if (j && j.date === today && Number.isFinite(j.count)) return { date: today, count: j.count }
  } catch {
    /* 없거나 깨졌으면 0부터 */
  }
  return { date: today, count: 0 }
}

function bumpDailyCount(root, today) {
  const cur = readDailyCount(root, today)
  const next = { date: today, count: cur.count + 1 }
  mkdirSync(join(root, 'public', 'data', 'mock-live'), { recursive: true })
  writeFileSync(counterPath(root), JSON.stringify(next, null, 1))
  return next.count
}

// ---- 어댑터 -----------------------------------------------------------------

/**
 * 모의서버 주문 클라이언트.
 *
 * @param {object} o
 * @param {string} o.appKey          모의투자용 앱키 (KIWOOM_MOCK_APP_KEY)
 * @param {string} o.appSecret       모의투자용 시크릿 (KIWOOM_MOCK_APP_SECRET)
 * @param {string} [o.accountNo]     모의계좌번호 (KIWOOM_MOCK_ACCOUNT) — 로그·저널에 남기지 않는다.
 *                                   [미검증] 키움 REST는 토큰에 계좌가 묶이는 구조로 보여 기본은
 *                                   바디에 넣지 않는다. probe 응답이 계좌 필드를 요구하면 그때 넣는다.
 * @param {boolean} [o.dryRun=true]  **기본 true** — false 를 명시해야 실제 전송.
 * @param {string} [o.root]          리포 루트(HALT·카운터 파일 기준). 기본 process.cwd()
 * @param {string} [o.baseUrl]       기본 = kiwoom.mjs 의 모의서버. mockapi 가 아니면 생성 자체가 실패한다.
 * @param {typeof fetch} [o.fetchImpl]
 * @param {Record<string,string|undefined>} [o.env]
 * @param {(msg:string)=>void} [o.log]
 */
export function createKiwoomOrderClient({
  appKey,
  appSecret,
  accountNo,
  dryRun = true,
  root = process.env.REPO_ROOT ?? process.cwd(),
  baseUrl,
  fetchImpl = fetch,
  env = process.env,
  log = (m) => console.error(m),
}) {
  const client = createKiwoomClient({ appKey, appSecret, baseUrl, fetchImpl })
  const limits = resolveLimits(env)
  // 실서버 오배송 방지 — 주소에 'mockapi' 가 없으면 이 어댑터는 아예 동작하지 않는다.
  if (!/mockapi/i.test(client.base))
    throw new Error(`모의서버가 아닌 주소로는 주문할 수 없다(규칙 2 · 3단계 미승인): ${client.base}`)

  const haltPath = join(root, HARD_LIMITS.haltFile)
  const isHalted = () => existsSync(haltPath)

  /**
   * **네트워크로 나가는 유일한 주문 통로.** 게이트를 여기서만 판정하므로 우회 경로가 없다.
   * @param {{ kind: string, apiId: string, path: string, body: object, qty: number, priceKrw: number, plan: object }} req
   */
  async function submit({ kind, apiId, path, body, qty, priceKrw, plan }) {
    const today = kstToday()
    const { count } = readDailyCount(root, today)
    const gate = evaluateGates({ qty, priceKrw, dailyCount: count, halt: isHalted(), limits })
    const base = {
      kind,
      apiId,
      dryRun,
      at: new Date().toISOString(),
      plan: { ...plan, amountKrw: Math.round(gate.amountKrw) },
      gate: { ...gate, dailyCount: count, limits },
    }
    if (!gate.ok) {
      log(`⛔ 게이트 차단 [${kind}] ${gate.reason}`)
      return { ...base, sent: false, blocked: true, ok: false }
    }
    if (dryRun) {
      log(`🧪 dryRun [${kind}] 전송 안 함 — ${JSON.stringify(base.plan)}`)
      return { ...base, sent: false, blocked: false, ok: true }
    }
    // 실제 전송은 카운터를 **먼저** 올린다(응답 실패로 카운터가 새지 않게 보수적으로).
    const dailyCount = bumpDailyCount(root, today)
    try {
      const { json } = await client.request(path, apiId, body)
      const ok = json?.return_code === 0 || json?.return_code === '0'
      log(
        `${ok ? '✅' : '⚠️'} [${kind}] return_code=${json?.return_code} return_msg="${json?.return_msg ?? ''}" · 응답 키: [${Object.keys(
          json ?? {},
        ).join(', ')}]`,
      )
      return {
        ...base,
        sent: true,
        blocked: false,
        ok,
        gate: { ...base.gate, dailyCount },
        returnCode: json?.return_code ?? null,
        returnMsg: json?.return_msg ?? null,
        responseKeys: Object.keys(json ?? {}),
        // 주문번호 필드명 [미검증] — probe 로 확정
        orderNo: json?.ord_no ?? json?.odno ?? null,
      }
    } catch (e) {
      log(`❌ [${kind}] 전송 실패 — ${e.message}`)
      return { ...base, sent: true, blocked: false, ok: false, error: e.message, gate: { ...base.gate, dailyCount } }
    }
  }

  /**
   * 주문 제출. 지정가가 기본 — 시장가라도 게이트 산정을 위해 기준가(price)는 필수다.
   * @param {object} o
   * @param {'buy'|'sell'} o.side
   * @param {string} o.symbol        '005930' 또는 '005930.KS'
   * @param {number} o.qty
   * @param {number} o.price         지정가(=주문단가) 또는 시장가의 기준가
   * @param {'limit'|'market'} [o.orderType='limit']
   */
  async function placeOrder({ side, symbol, qty, price, orderType = 'limit' }) {
    if (side !== 'buy' && side !== 'sell') throw new Error(`side 는 'buy'|'sell' 만: "${side}"`)
    if (orderType !== 'limit' && orderType !== 'market') throw new Error(`orderType 는 'limit'|'market' 만: "${orderType}"`)
    const code = toKiwoomCode(symbol)
    const apiId = side === 'buy' ? TR.buy : TR.sell
    // [미검증] 바디 필드명 — dmst_stex_tp(국내거래소구분) / stk_cd / ord_qty / ord_uv(주문단가) / trde_tp(매매구분)
    const body = {
      dmst_stex_tp: 'KRX',
      stk_cd: code,
      ord_qty: String(qty),
      ord_uv: orderType === 'market' ? '' : String(Math.round(price)),
      trde_tp: TRDE_TP[orderType],
    }
    return submit({
      kind: side === 'buy' ? '매수' : '매도',
      apiId,
      path: PATH.order,
      body,
      qty,
      priceKrw: price,
      plan: { side, symbol: code, qty, price: Math.round(price), orderType },
    })
  }

  /**
   * 주문 취소. 게이트는 동일하게 적용된다(HALT 시에는 취소도 나가지 않는다 —
   * 킬 스위치는 "코드가 계좌를 건드리지 않는 상태"를 뜻하며, 그 상황의 청산은 대표가 HTS로 한다).
   * @param {object} o
   * @param {string} o.orderNo   원주문번호
   * @param {string} o.symbol
   * @param {number} o.qty
   * @param {number} o.price     게이트 산정용 기준가
   */
  async function cancelOrder({ orderNo, symbol, qty, price }) {
    const code = toKiwoomCode(symbol)
    // [미검증] 취소 바디 — orig_ord_no(원주문번호) / stk_cd / cncl_qty(취소수량, '0'=전량)
    const body = { dmst_stex_tp: 'KRX', orig_ord_no: String(orderNo), stk_cd: code, cncl_qty: String(qty) }
    return submit({
      kind: '취소',
      apiId: TR.cancel,
      path: PATH.order,
      body,
      qty,
      priceKrw: price,
      plan: { action: 'cancel', symbol: code, qty, orderNo: String(orderNo) },
    })
  }

  /**
   * 계좌평가잔고 조회 — 조회는 게이트 대상이 아니다(주문이 아니므로).
   * dryRun 이어도 조회는 나간다. 반환값에서 계좌번호성 필드는 제거한다.
   * @returns {{ raw:any, totalAssetKrw:number|null, cashKrw:number|null, holdings:{symbol:string,qty:number,avgPrice:number|null}[] }}
   */
  async function getBalance() {
    // [미검증] kt00018 바디 — qry_tp(조회구분 1=합산) / dmst_stex_tp
    const { json } = await client.request(PATH.account, TR.balance, { qry_tp: '1', dmst_stex_tp: 'KRX' })
    return { ...parseBalance(json), raw: redactAccount(json) }
  }

  /**
   * 주문·체결 내역 조회 (조회 전용).
   * @param {{ date?: string, stockCode?: string }} [o]
   */
  async function getExecutions({ date = '', stockCode = '' } = {}) {
    // [미검증] kt00007 바디 — ord_dt(주문일자) / qry_tp / stk_bond_tp / sell_tp / stk_cd / dmst_stex_tp
    const { json } = await client.request(PATH.account, TR.executions, {
      ord_dt: date.replace(/-/g, ''),
      qry_tp: '1',
      stk_bond_tp: '0',
      sell_tp: '0',
      stk_cd: stockCode ? toKiwoomCode(stockCode) : '',
      fr_ord_no: '',
      dmst_stex_tp: 'KRX',
    })
    return { raw: redactAccount(json), returnCode: json?.return_code ?? null, returnMsg: json?.return_msg ?? null }
  }

  return {
    base: client.base,
    dryRun,
    limits,
    hasAccountNo: Boolean(accountNo), // 계좌번호 자체는 절대 노출하지 않는다
    isHalted,
    placeOrder,
    cancelOrder,
    getBalance,
    getExecutions,
  }
}

// ---- 응답 정규화 (순수 함수 · 테스트 대상) -----------------------------------

const ACCOUNT_KEYS = /(acnt|accnt|account)/i

/** 응답에서 계좌번호성 필드를 지운다 — 저널·로그에 계좌번호가 새지 않도록. */
export function redactAccount(json) {
  if (json == null || typeof json !== 'object') return json
  if (Array.isArray(json)) return json.map(redactAccount)
  const out = {}
  for (const [k, v] of Object.entries(json)) {
    if (ACCOUNT_KEYS.test(k)) continue
    out[k] = typeof v === 'object' ? redactAccount(v) : v
  }
  return out
}

const n = (raw) => {
  if (raw == null) return null
  const s = String(raw).replace(/^[+-]/, '').replace(/,/g, '').trim()
  if (s === '') return null
  const v = Number(s)
  return Number.isFinite(v) ? v : null
}

const pick = (obj, keys) => {
  for (const k of keys) {
    const v = n(obj?.[k])
    if (v != null) return v
  }
  return null
}

/**
 * kt00018 응답 → 총평가·현금·보유목록. [미검증] 필드명은 probe 로 확정한다.
 * 후보 키를 순서대로 훑어 처음 잡히는 값을 쓴다(문서·실측 불일치 대비).
 */
export function parseBalance(json) {
  const totalAssetKrw = pick(json, ['tot_evlt_amt', 'tot_est_amt', 'prsm_dpst_aset_amt', 'tot_evltv'])
  const cashKrw = pick(json, ['entr', 'dpst', 'prsm_dpst_aset_amt', 'd2_entra'])
  const rows = Array.isArray(json?.acnt_evlt_remn_indv_tot)
    ? json.acnt_evlt_remn_indv_tot
    : Object.values(json ?? {}).find((v) => Array.isArray(v)) ?? []
  const holdings = []
  for (const r of rows) {
    const code = String(r?.stk_cd ?? '').replace(/[^0-9]/g, '').slice(-6)
    const qty = pick(r, ['rmnd_qty', 'hldg_qty', 'trde_able_qty'])
    if (!code || qty == null || qty <= 0) continue
    holdings.push({ symbol: code, qty, avgPrice: pick(r, ['pur_pric', 'avg_prc', 'pchs_avg_pric']) })
  }
  return { totalAssetKrw, cashKrw, holdings }
}

/**
 * kt00007 응답 → 종목별 **체결 수량·체결가·미체결 수량**. 상주 데몬의 09:01 체결 확인이 쓴다.
 *
 * ⚠️ [미검증] 필드명은 전부 문서상 추정이다(probe 로 확정 대상). 못 읽으면 값이 null 로
 * 나오고, 호출자는 그때 "체결 확인 불가"로 처리한다 — **모르는 것을 체결로 단정하지 않는다.**
 * 같은 종목이 여러 줄로 나뉘면 수량 가중 평균가로 합친다.
 *
 * @returns {{ symbol: string, filledQty: number|null, avgPrice: number|null, openQty: number|null }[]}
 */
export function parseExecutions(json) {
  const rows = Array.isArray(json?.acnt_ord_cntr_prps_dtl)
    ? json.acnt_ord_cntr_prps_dtl
    : Object.values(json ?? {}).find((v) => Array.isArray(v)) ?? []
  /** @type {Map<string, {qty:number, amount:number, openQty:number|null, seen:boolean}>} */
  const agg = new Map()
  for (const r of rows) {
    const code = String(r?.stk_cd ?? '').replace(/[^0-9]/g, '').slice(-6)
    if (!code) continue
    const filled = pick(r, ['cntr_qty', 'tot_cntr_qty', 'cntr_tot_qty'])
    const price = pick(r, ['cntr_uv', 'cntr_pric', 'cntr_avg_uv', 'avg_cntr_uv'])
    const open = pick(r, ['oso_qty', 'rmn_qty', 'ord_rmnq', 'unsett_qty'])
    const cur = agg.get(code) ?? { qty: 0, amount: 0, openQty: null, seen: false }
    if (filled != null && filled > 0) {
      cur.qty += filled
      if (price != null && price > 0) cur.amount += filled * price
    }
    if (open != null) cur.openQty = (cur.openQty ?? 0) + open
    cur.seen = true
    agg.set(code, cur)
  }
  return [...agg.entries()].map(([symbol, v]) => ({
    symbol,
    filledQty: v.qty > 0 ? v.qty : v.seen ? 0 : null,
    avgPrice: v.qty > 0 && v.amount > 0 ? v.amount / v.qty : null,
    openQty: v.openQty,
  }))
}
