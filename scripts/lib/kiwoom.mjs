// 키움 REST API — 1단계 조회 전용 클라이언트 (규칙 2)
//
// 경계 (tests/no-order-endpoint.test.ts가 강제):
//   - 기본 서버 = 모의서버(mockapi.kiwoom.com). 실서버 주소는 3단계 승인 전까지
//     코드에 두지 않는다. 다른 서버가 필요하면 KIWOOM_BASE_URL 환경변수로만 받는다.
//   - 이 파일에 주문·이체 메서드는 존재하지 않는다. 2단계 모의 주문 어댑터는
//     별도 파일 + 가드 테스트 개정과 함께 들어간다.
//
// 시크릿: 값은 호출자가 loadSecret.mjs로 읽어 넘긴다. 이 파일은 값을 로그에 남기지
// 않으며, 에러 메시지에는 응답의 "키 이름"만 싣는다(값 미출력 원칙).
//
// 엔드포인트·TR 명세는 공식 문서 실측 전 [미검증] — kiwoom-probe.mjs 실행 결과로
// 보정한다. (인증 POST /oauth2/token · 분봉차트 api-id ka10080 · 경로 /api/dostk/chart)

export const MOCK_BASE = 'https://mockapi.kiwoom.com'

/**
 * @param {object} o
 * @param {string} o.appKey
 * @param {string} o.appSecret
 * @param {string} [o.baseUrl]      기본 모의서버. 변경은 KIWOOM_BASE_URL 환경변수로만.
 * @param {typeof fetch} [o.fetchImpl]
 * @param {number} [o.minIntervalMs] 호출 간 최소 간격(유량 제한 대응, 기본 350ms)
 */
export function createKiwoomClient({ appKey, appSecret, baseUrl, fetchImpl = fetch, minIntervalMs = 350 }) {
  const base = baseUrl ?? process.env.KIWOOM_BASE_URL ?? MOCK_BASE
  let token = null
  let tokenExpiresAt = 0
  let lastCallAt = 0

  const throttle = async () => {
    const wait = lastCallAt + minIntervalMs - Date.now()
    if (wait > 0) await new Promise((r) => setTimeout(r, wait))
    lastCallAt = Date.now()
  }

  // return_code/return_msg 는 시크릿이 아니라 API 상태 진단 필드 — 이 둘만 값을 노출한다.
  const apiStatus = (json) =>
    json && (json.return_code != null || json.return_msg)
      ? ` · return_code=${json.return_code} return_msg="${json.return_msg ?? ''}"`
      : ''

  /** 접근 토큰 발급 — 토큰 값은 반환하지 않는다(길이만). */
  async function issueToken() {
    await throttle()
    const res = await fetchImpl(`${base}/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json;charset=UTF-8' },
      body: JSON.stringify({ grant_type: 'client_credentials', appkey: appKey, secretkey: appSecret }),
    })
    const json = await res.json().catch(() => ({}))
    if (!res.ok)
      throw new Error(`토큰 발급 실패 HTTP ${res.status} — 응답 키: [${Object.keys(json).join(', ')}]${apiStatus(json)}`)
    token = json.token ?? json.access_token ?? null
    if (!token)
      throw new Error(`토큰 필드를 못 찾음 — 응답 키: [${Object.keys(json).join(', ')}]${apiStatus(json)} (문서 대조 필요)`)
    // 만료 필드 형식이 확정될 때까지 보수적으로 23시간 캐시 [미검증]
    tokenExpiresAt = Date.now() + 23 * 3600e3
    return { ok: true, tokenLength: String(token).length }
  }

  async function ensureToken() {
    if (!token || Date.now() > tokenExpiresAt) await issueToken()
  }

  /**
   * 조회 TR 공통 호출. 주문 계열 api-id는 이 클라이언트에서 호출하지 않는다.
   * @returns {{ json: any, cont: { contYn: string|null, nextKey: string|null } }}
   */
  async function request(path, apiId, body, { contYn = 'N', nextKey = '' } = {}) {
    await ensureToken()
    await throttle()
    const res = await fetchImpl(`${base}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json;charset=UTF-8',
        authorization: `Bearer ${token}`,
        'api-id': apiId,
        'cont-yn': contYn,
        'next-key': nextKey,
      },
      body: JSON.stringify(body),
    })
    const json = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(`${apiId} HTTP ${res.status} — 응답 키: [${Object.keys(json).join(', ')}]${apiStatus(json)}`)
    return { json, cont: { contYn: res.headers.get('cont-yn'), nextKey: res.headers.get('next-key') } }
  }

  /** 주식 분봉차트 조회 (api-id ka10080 [미검증]) — 조회 전용 */
  async function minuteChart(stockCode, { minutes = 5, adjusted = true, contYn = 'N', nextKey = '' } = {}) {
    return request(
      '/api/dostk/chart',
      'ka10080',
      { stk_cd: stockCode, tic_scope: String(minutes), upd_stkpc_tp: adjusted ? '1' : '0' },
      { contYn, nextKey },
    )
  }

  /** 주식 일봉차트 조회 (api-id ka10081 [미검증]) — 조회 전용 */
  async function dailyChart(stockCode, { baseDate = '', adjusted = true, contYn = 'N', nextKey = '' } = {}) {
    return request(
      '/api/dostk/chart',
      'ka10081',
      { stk_cd: stockCode, base_dt: baseDate, upd_stkpc_tp: adjusted ? '1' : '0' },
      { contYn, nextKey },
    )
  }

  return { base, issueToken, request, minuteChart, dailyChart }
}

// ---- 응답 파서 (2026-07-30 실측 구조 기준) ----------------------------------
// ka10080 응답: { stk_cd, stk_min_pole_chart_qry: [행...], return_code, return_msg }
// 행 필드: cur_prc(종가), open_pric, high_pric, low_pric, trde_qty(거래량),
//          cntr_tm(체결시간 YYYYMMDDHHMMSS), acc_trde_qty, pred_pre, pred_pre_sig
// 키움 차트 가격엔 대비부호(+/-)가 앞에 붙을 수 있어 절대값으로 정규화한다 [실측 표본으로 확인 예정].

/** "+70200"·"-70200"·"70200" → 70200. 숫자 아니면 null. */
export function numAbs(raw) {
  if (raw == null) return null
  const s = String(raw).replace(/^[+-]/, '').trim()
  if (s === '') return null // Number('')===0 오염 방지
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

/** "YYYYMMDDHHMMSS" → epoch 초(KST 기준). 형식이 다르면 null. */
export function parseCntrTm(s) {
  const m = String(s ?? '').match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/)
  if (!m) return null
  const [, Y, M, D, h, mi, sec] = m
  // KST(UTC+9) 고정 — Date.UTC로 만들고 9시간을 뺀다
  return Math.floor(Date.UTC(+Y, +M - 1, +D, +h, +mi, +sec) / 1000) - 9 * 3600
}

/**
 * ka10080 분봉 응답 → 정규화 봉 배열 (오름차순).
 * @returns {{ symbol: string, bars: { t:number, o:number, h:number, l:number, c:number, v:number }[], dropped: number }}
 */
export function parseMinuteChart(json) {
  const rows = Array.isArray(json?.stk_min_pole_chart_qry) ? json.stk_min_pole_chart_qry : []
  const bars = []
  let dropped = 0
  for (const r of rows) {
    const t = parseCntrTm(r.cntr_tm)
    const o = numAbs(r.open_pric)
    const h = numAbs(r.high_pric)
    const l = numAbs(r.low_pric)
    const c = numAbs(r.cur_prc)
    const v = numAbs(r.trde_qty)
    if (t == null || o == null || h == null || l == null || c == null) {
      dropped++
      continue
    }
    bars.push({ t, o, h, l, c, v: v ?? 0 })
  }
  bars.sort((a, b) => a.t - b.t)
  return { symbol: String(json?.stk_cd ?? ''), bars, dropped }
}
