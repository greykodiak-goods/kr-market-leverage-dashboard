// 재무데이터 프로브 (DART) — 밸류·퀄리티 팩터 착수 전 5항목 실측 확정.
//
// 왜 프로브가 먼저인가 (ops governance/TOP-PRIORITY.md 규칙 4):
//   외부 API는 **그럴듯한 값**으로 틀린다. 단위를 백만원으로 착각하면 PBR이 10^6배로
//   나오는데 테스트는 통과한 채 조용히 썩는다. 그래서 코드를 짜기 전에
//   **인증 구조 · 호출 한도 · 필드명/단위/타입 · 데이터 범위 · 실패 표현** 다섯 가지를
//   실호출로 확정한다. 확정 못 한 것은 `[미검증]`으로 남기고 추측으로 메우지 않는다.
//
// 이 스크립트가 확정하는 것 (DART 몫):
//   B-1 corp_code 매핑(6자리 종목코드 → 8자리) — corpCode.xml zip 경로 동작
//   B-2 rcept_no(접수번호) 존재·14자리 형식 · **접수일 > 사업연도 종료일** (PIT 성립 근거)
//   B-3 금액 단위 — thstrm_amount 가 원 단위인가, 회사 표시단위인가 (정답 아는 표본으로 자기검증)
//   B-4 fs_div CFS/OFS 차이 · **2015년 이전 호출의 실제 status 로 시작 연도 실측**
//   B-5 실패 표현 — 일부러 틀린 corp_code 로 status 코드 확인
//
// 사전 확정 사실 (재조사 불필요 · 2026-08-03):
//   - 무료 · 키 하나로 전 API(별도 승인 없음) · 한도 **일 20,000건**
//   - **오류를 HTTP status 가 아니라 200 본문의 `status` 코드로 준다**
//     000 정상 / 013 데이터없음 / 010·011 키오류 / 020 한도초과 / 100 필드부적절 / 800 점검
//     → HTTP 200 만 보고 성공으로 처리하면 전량 실패를 성공으로 오인한다.
//   - 금액은 **콤마 포함 문자열**, 값이 없으면 `"-"`
//
// 원칙:
//   - **조용한 폴백 금지** — 못 받으면 던진다. 기본값·빈 배열 대체 없음.
//   - **성공 카운터** — 전량 실패면 종료코드 1. 정상 0건(status 013)과 실패 0건(키오류·차단)을 구분.
//   - **수집·저장 금지** — 파일을 한 개도 쓰지 않는다(리포에 데이터 커밋 없음).
//   - 시크릿 값 미출력(길이만) · URL 로깅은 키 마스킹.
//
// 시크릿 (ops governance/SECRETS-POLICY.md · 리포 규칙 2-1):
//   DART_API_KEY 를 `scripts/lib/loadSecret.mjs` 단일 구현으로만 읽는다(하드코딩 경로 금지).
//   표준 실행:
//     doppler run --project investing-ops --config prd -- node scripts/fundamental-probe.mjs
//
// 참고: 기존 DART 클라이언트가 `convex/lib/dartRadar.ts` 에 있다(makeDartClient/num).
//       이 프로브는 status 코드 자체를 관측 대상으로 삼아야 해서(그 클라이언트는 비정상 status 를
//       던져버린다) 조사 전용으로 얇게 다시 만든다. convex/ 는 읽기만 하고 수정하지 않는다.

import { inflateRawSync } from 'node:zlib'
import { loadSecret, maskerFor } from './lib/loadSecret.mjs'

const DART = 'https://opendart.fss.or.kr/api'

// 프로브 대상 — 오래 상장돼 있고 12월 결산인 대형주.
const TICKERS = [
  { code: '005930', name: '삼성전자' },
  { code: '000660', name: 'SK하이닉스' },
  { code: '005380', name: '현대차' },
]
// 매핑 자기검증용 정답 — dartRadar.ts 에서 확정된 SK하이닉스 corp_code.
const KNOWN_CORP = { '000660': '00164779' }
const YEARS = [2015, 2020, 2024]
// 2015 절벽을 실제로 확인할 연도 (앞뒤로 브래킷)
const EARLY_YEARS = [2011, 2013, 2014, 2015]

// 단위 자기검증 앵커 — 삼성전자 연결 매출액 [참고값 · 공시 공지치, 원 단위].
// 정확한 끝자리를 맞추려는 게 아니라 **자릿수(배율)** 를 판정하는 용도다.
const REVENUE_ANCHOR_KRW = {
  2015: 200_653_482_000_000,
  2020: 236_806_988_000_000,
  2024: 300_870_903_000_000,
}

const stat = { ok: 0, empty: 0, fail: 0, calls: 0 }
const findings = {}
const out = (s = '') => console.log(s)

// ---------------------------------------------------------------- 키 로딩
const secret = loadSecret('DART_API_KEY', { project: 'investing-ops' })
if (!secret.value) {
  console.error('')
  console.error(secret.help)
  process.exit(1)
}
const KEY = secret.value
const mask = maskerFor(KEY)

// ---------------------------------------------------------------- 호출부
/**
 * DART 호출 — **status 를 던지지 않고 그대로 돌려준다.**
 * 이 프로브의 관측 대상이 status 코드 자체이기 때문이다(실패 표현 확정).
 * 단 HTTP 레벨 실패·JSON 파싱 실패는 던진다(조용한 폴백 금지).
 */
async function call(path, params) {
  const qs = new URLSearchParams({ crtfc_key: KEY, ...params })
  const safe = new URLSearchParams({ crtfc_key: '****', ...params })
  stat.calls++
  const res = await fetch(`${DART}/${path}?${qs}`)
  if (!res.ok) throw new Error(mask(`${path} HTTP ${res.status} (${safe})`))
  const text = await res.text()
  let json
  try {
    json = JSON.parse(text)
  } catch {
    throw new Error(mask(`${path} JSON 파싱 실패 — 앞부분: ${text.slice(0, 160)}`))
  }
  return { json, safe: String(safe) }
}

/** status 코드의 의미 (사전 확정 표) */
const STATUS_MEANING = {
  '000': '정상',
  '010': '등록되지 않은 키',
  '011': '사용할 수 없는 키',
  '013': '조회된 데이터 없음',
  '020': '요청 제한 초과(일 20,000건)',
  '100': '필드의 부적절한 값',
  '800': '시스템 점검',
  '900': '정의되지 않은 오류',
  '901': '사용자 계정의 개인정보보유기간 만료',
}
const meaning = (s) => STATUS_MEANING[s] ?? '[미검증] 표에 없는 코드'

/** 콤마 문자열 → 숫자. `"-"`·빈값은 null (0으로 뭉개지 않는다). */
function num(v) {
  if (v == null || v === '' || v === '-') return null
  const n = Number(String(v).replace(/,/g, ''))
  return Number.isFinite(n) ? n : null
}

// ------------------------------------------------- B-1 corp_code 매핑(zip)
/** ZIP 최소 파서 — 중앙 디렉터리를 읽고 첫 항목을 푼다(외부 의존 없음). */
function unzipFirstEntry(buf) {
  const EOCD_SIG = 0x06054b50
  let eocd = -1
  const floor = Math.max(0, buf.length - 22 - 65536)
  for (let i = buf.length - 22; i >= floor; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('ZIP 아님 — EOCD 서명을 찾지 못했다')
  const count = buf.readUInt16LE(eocd + 10)
  let p = buf.readUInt32LE(eocd + 16)
  const entries = []
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error(`중앙 디렉터리 서명 불일치 @${p}`)
    const method = buf.readUInt16LE(p + 10)
    const compSize = buf.readUInt32LE(p + 20)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const localOff = buf.readUInt32LE(p + 42)
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen)
    entries.push({ name, method, compSize, localOff })
    p += 46 + nameLen + extraLen + commentLen
  }
  if (entries.length === 0) throw new Error('ZIP 안에 항목이 없다')
  const e = entries[0]
  if (buf.readUInt32LE(e.localOff) !== 0x04034b50) throw new Error('로컬 헤더 서명 불일치')
  const nLen = buf.readUInt16LE(e.localOff + 26)
  const xLen = buf.readUInt16LE(e.localOff + 28)
  const start = e.localOff + 30 + nLen + xLen
  const data = buf.subarray(start, start + e.compSize)
  const plain = e.method === 0 ? data : inflateRawSync(data)
  return { names: entries.map((x) => x.name), xml: plain.toString('utf8') }
}

async function probeB1() {
  out('\n' + '='.repeat(78))
  out('B-1. corp_code 매핑 (6자리 종목코드 → 8자리 고유번호) · corpCode.xml zip 경로')
  out('='.repeat(78))
  const qs = new URLSearchParams({ crtfc_key: KEY })
  stat.calls++
  const res = await fetch(`${DART}/corpCode.xml?${qs}`)
  out(`  HTTP ${res.status} · content-type=${res.headers.get('content-type')}`)
  const buf = Buffer.from(await res.arrayBuffer())
  out(`  본문 ${buf.length.toLocaleString()} 바이트 · 앞 2바이트 ${JSON.stringify(buf.toString('latin1', 0, 2))}`)

  // 키 오류면 zip 이 아니라 JSON(또는 XML)이 온다 — 실패 표현 확정 지점
  if (buf.toString('latin1', 0, 2) !== 'PK') {
    stat.fail++
    out(`  ⛔ zip 이 아니다 — 본문 앞부분: ${mask(buf.toString('utf8', 0, 300))}`)
    findings.b1 = '⛔ corpCode.xml 이 zip 으로 오지 않음 (키·권한 확인)'
    return null
  }

  const { names, xml } = unzipFirstEntry(buf)
  out(`  zip 항목: ${names.join(', ')} · XML ${xml.length.toLocaleString()}자`)

  const map = new Map()
  const re = /<list>([\s\S]*?)<\/list>/g
  let m
  let total = 0
  while ((m = re.exec(xml))) {
    total++
    const body = m[1]
    const corp = /<corp_code>([^<]*)<\/corp_code>/.exec(body)?.[1]?.trim()
    const stock = /<stock_code>([^<]*)<\/stock_code>/.exec(body)?.[1]?.trim()
    const nm = /<corp_name>([^<]*)<\/corp_name>/.exec(body)?.[1]?.trim()
    if (corp && stock && /^\d{6}$/.test(stock)) map.set(stock, { corp, name: nm })
  }
  out(`  <list> ${total.toLocaleString()}건 · 상장 종목코드 보유 ${map.size.toLocaleString()}건`)
  // 하나도 못 찾으면 던진다(관용 파싱하되 전부 실패는 비정상 — 규칙 4)
  if (map.size === 0) throw new Error('corpCode XML 파싱 결과 0건 — 스키마가 바뀌었다')
  stat.ok++

  const lines = []
  for (const t of TICKERS) {
    const hit = map.get(t.code)
    const known = KNOWN_CORP[t.code]
    const verdict = !hit
      ? '⛔ 매핑 실패'
      : !/^\d{8}$/.test(hit.corp)
        ? `⛔ 8자리 아님(${hit.corp})`
        : known
          ? hit.corp === known
            ? `✅ ${hit.corp} (정답 표본 일치)`
            : `⛔ ${hit.corp} ≠ 알려진 값 ${known}`
          : `✅ ${hit.corp}`
    lines.push(`  ${t.name}(${t.code}) → ${verdict}${hit ? ` · 이름 "${hit.name}"` : ''}`)
    if (hit) t.corp = hit.corp
  }
  lines.forEach(out)
  findings.b1 = map.size
    ? `✅ 매핑 동작 (상장 ${map.size.toLocaleString()}종목) · 자기검증 표본 SK하이닉스=${map.get('000660')?.corp ?? '없음'}`
    : '⛔ 매핑 실패'
  out(`\n>>> B-1 판정: ${findings.b1}`)
  return map
}

// ------------------------------------------- 재무제표 조회 + 계정 추출
const ACCOUNTS = {
  assets: { names: ['자산총계'], ids: ['ifrs-full_Assets', 'ifrs_Assets'], sj: ['BS'] },
  liabilities: { names: ['부채총계'], ids: ['ifrs-full_Liabilities', 'ifrs_Liabilities'], sj: ['BS'] },
  equity: { names: ['자본총계'], ids: ['ifrs-full_Equity', 'ifrs_Equity'], sj: ['BS'] },
  revenue: {
    names: ['매출액', '수익(매출액)', '영업수익'],
    ids: ['ifrs-full_Revenue', 'ifrs_Revenue', 'ifrs-full_RevenueFromContractsWithCustomers'],
    sj: ['IS', 'CIS'],
  },
}

/** 관용 파싱: 계정명 정확일치 → account_id 일치 순. 못 찾으면 null 을 주고 호출부가 판단한다. */
function findAccount(list, spec) {
  const inSj = list.filter((r) => spec.sj.includes(String(r.sj_div ?? '')))
  const pool = inSj.length ? inSj : list
  for (const nm of spec.names) {
    const hit = pool.find((r) => String(r.account_nm ?? '').replace(/\s/g, '') === nm)
    if (hit) return hit
  }
  for (const id of spec.ids) {
    const hit = pool.find((r) => String(r.account_id ?? '').startsWith(id))
    if (hit) return hit
  }
  return null
}

async function fetchFs({ corp, year, reprt = '11011', fsDiv = 'CFS' }) {
  const { json } = await call('fnlttSinglAcntAll.json', {
    corp_code: corp,
    bsns_year: String(year),
    reprt_code: reprt,
    fs_div: fsDiv,
  })
  return json
}

// ------------------------------------------- B-2 rcept_no · PIT 성립 근거
async function probeB2() {
  out('\n' + '='.repeat(78))
  out('B-2. rcept_no(접수번호) 형식 · 접수일 > 사업연도 종료일 (PIT 성립 근거)')
  out('='.repeat(78))
  out('  판정 기준: rcept_no 14자리(YYYYMMDD+6) 이고 앞 8자리(접수일)가 사업연도 종료일 이후여야')
  out('             "그 시점에 알 수 있었던 정보"로 쓸 수 있다. 접수일 이전 시점에 쓰면 미래참조.')
  const rows = []
  for (const t of TICKERS) {
    if (!t.corp) {
      out(`  ○ ${t.name}: corp_code 미확정 — 건너뜀`)
      continue
    }
    for (const y of YEARS) {
      let json
      try {
        json = await fetchFs({ corp: t.corp, year: y })
      } catch (e) {
        stat.fail++
        out(`  ⛔ ${t.name} ${y}: 호출 실패 ${e.message}`)
        continue
      }
      const st = String(json.status)
      if (st === '013') {
        stat.empty++
        out(`  ○ ${t.name} ${y}: status=013 (${meaning(st)}) — 정상 0건, 실패 아님`)
        continue
      }
      if (st !== '000') {
        stat.fail++
        out(`  ⛔ ${t.name} ${y}: status=${st} (${meaning(st)}) msg=${json.message}`)
        continue
      }
      const list = json.list ?? []
      if (list.length === 0) throw new Error(`${t.name} ${y}: status=000 인데 list 가 비었다 — 스키마 변경 의심`)
      stat.ok++
      const rcept = String(list[0].rcept_no ?? '')
      const ok14 = /^\d{14}$/.test(rcept)
      const dt = rcept.slice(0, 8)
      const after = ok14 && dt > `${y}1231`
      rows.push({ t: t.name, y, rcept, ok14, dt, after })
      out(
        `  ${t.name} ${y}: ${list.length}행 · rcept_no=${rcept} (${ok14 ? '14자리 ✅' : '⛔ 형식 이상'}) ` +
          `· 접수일 ${dt} ${after ? '✅ 사업연도 종료 이후' : '⛔ 사업연도 종료 이전/불명'}`,
      )
      if (rows.length === 1) {
        // 첫 성공 응답의 필드명·타입을 그대로 남긴다 (규칙 4 — 필드명/단위/타입 확정)
        out(`      응답 필드: [${Object.keys(list[0]).join(', ')}]`)
        out(`      표본 행: ${JSON.stringify(list[0])}`)
      }
    }
  }
  const allOk = rows.length > 0 && rows.every((r) => r.ok14 && r.after)
  findings.b2 = !rows.length
    ? '❓ 판정 불가 — 유효 응답 0건'
    : allOk
      ? `✅ rcept_no 14자리 · 접수일 전부 사업연도 종료 이후 (${rows.length}건) — PIT 기준일로 사용 가능`
      : `⛔ 이상 표본 존재: ${rows.filter((r) => !r.ok14 || !r.after).map((r) => `${r.t}/${r.y}`).join(', ')}`
  out(`\n>>> B-2 판정: ${findings.b2}`)
  // 접수일 분포 — 팩터 반영 시차(사업연도 종료 → 공시)를 눈에 보이게
  for (const r of rows) out(`      ${r.t} FY${r.y} → 접수 ${r.dt} (${Number(r.dt.slice(0, 4)) - r.y}년 +${r.dt.slice(4, 6)}월)`)
  return rows
}

// ------------------------------------------------------- B-3 금액 단위
async function probeB3() {
  out('\n' + '='.repeat(78))
  out('B-3. 금액 단위 확정 — thstrm_amount 가 원 단위인가 (정답 아는 표본으로 자기검증)')
  out('='.repeat(78))
  const t = TICKERS.find((x) => x.code === '005930')
  if (!t?.corp) {
    findings.b3 = '❓ 판정 불가 — 삼성전자 corp_code 미확정'
    out(`\n>>> B-3 판정: ${findings.b3}`)
    return
  }
  const verdicts = []
  for (const y of YEARS) {
    let json
    try {
      json = await fetchFs({ corp: t.corp, year: y })
    } catch (e) {
      stat.fail++
      out(`  ⛔ ${y}: ${e.message}`)
      continue
    }
    const st = String(json.status)
    if (st !== '000') {
      if (st === '013') stat.empty++
      else stat.fail++
      out(`  ${st === '013' ? '○' : '⛔'} ${y}: status=${st} (${meaning(st)})`)
      continue
    }
    stat.ok++
    const list = json.list ?? []
    const get = (k) => {
      const row = findAccount(list, ACCOUNTS[k])
      return { row, v: row ? num(row.thstrm_amount) : null }
    }
    const A = get('assets')
    const L = get('liabilities')
    const E = get('equity')
    const R = get('revenue')
    // 하나도 못 찾으면 던진다 — 관용 파싱의 전량 실패는 비정상(규칙 4)
    if (!A.row && !L.row && !E.row && !R.row) {
      throw new Error(`${y}: 자산·부채·자본·매출 계정을 하나도 찾지 못했다 — 계정명/ID 스키마 변경`)
    }
    out(`  --- ${y} (CFS) ---`)
    out(`    통화(currency)=${list[0]?.currency ?? '[미검증]'} · 행 ${list.length}개`)
    for (const [k, o] of [['자산총계', A], ['부채총계', L], ['자본총계', E], ['매출액', R]]) {
      out(
        `    ${k}: ${o.row ? `${JSON.stringify(o.row.thstrm_amount)} → ${o.v}` : '⛔ 계정 못 찾음'}` +
          (o.row ? ` (account_nm="${o.row.account_nm}" id="${o.row.account_id}" sj=${o.row.sj_div})` : ''),
      )
    }
    // ① 회계 항등식 자기검증 — 외부 지식이 필요 없는 강한 검증
    if (A.v && L.v && E.v) {
      const diff = Math.abs(A.v - (L.v + E.v)) / A.v
      out(`    ① 항등식 자산 = 부채 + 자본 : 오차 ${(diff * 100).toFixed(4)}% ${diff < 0.005 ? '✅' : '⛔'}`)
      verdicts.push({ year: y, identity: diff < 0.005 })
    }
    // ② 자릿수 판정 — 응답값 ÷ 공지값(원)의 배율로 단위를 읽는다
    const anchor = REVENUE_ANCHOR_KRW[y]
    if (R.v && anchor) {
      const ratio = R.v / anchor
      const unit =
        Math.abs(ratio - 1) < 0.1
          ? '원 단위 ✅'
          : Math.abs(ratio - 1e-6) < 1e-7
            ? '⚠️ 백만원 단위'
            : Math.abs(ratio - 1e-8) < 1e-9
              ? '⚠️ 억원 단위'
              : `⛔ 불일치 (배율 ${ratio.toExponential(3)})`
      out(`    ② 매출액 자기검증: 응답 ${R.v.toExponential(4)} vs 공지값[참고] ${anchor.toExponential(4)} → 배율 ${ratio.toFixed(6)} → ${unit}`)
      verdicts.push({ year: y, unit })
    } else if (R.v) {
      out(`    ② 매출액 ${R.v} — 대조 공지값 없음 [미검증]`)
    }
  }
  const units = verdicts.map((v) => v.unit).filter(Boolean)
  const identities = verdicts.filter((v) => v.identity !== undefined)
  findings.b3 = !units.length
    ? '❓ 단위 판정 불가 — 대조 가능한 응답 없음 [미검증]'
    : units.every((u) => u.startsWith('원 단위'))
      ? `✅ 원(KRW) 단위 확정 — ${units.length}개 연도 전부 배율 1.0 · 항등식 ${identities.filter((i) => i.identity).length}/${identities.length} 통과`
      : `⚠️ 단위 불일치 표본 존재: ${units.join(' / ')}`
  out(`\n>>> B-3 판정: ${findings.b3}`)
}

// --------------------------------- B-4 fs_div 차이 · 데이터 시작 연도 실측
async function probeB4() {
  out('\n' + '='.repeat(78))
  out('B-4. fs_div(CFS 연결 / OFS 별도) 차이 · 2015년 이전 호출의 실제 status 로 시작 연도 실측')
  out('='.repeat(78))
  const t = TICKERS.find((x) => x.code === '005930')
  if (!t?.corp) {
    findings.b4 = '❓ 판정 불가 — corp_code 미확정'
    out(`\n>>> B-4 판정: ${findings.b4}`)
    return
  }

  out('  --- fs_div 비교 (2023 사업보고서) ---')
  const pair = {}
  for (const fsDiv of ['CFS', 'OFS']) {
    try {
      const json = await fetchFs({ corp: t.corp, year: 2023, fsDiv })
      const st = String(json.status)
      if (st !== '000') {
        if (st === '013') stat.empty++
        else stat.fail++
        out(`    ${fsDiv}: status=${st} (${meaning(st)})`)
        continue
      }
      stat.ok++
      const list = json.list ?? []
      const a = findAccount(list, ACCOUNTS.assets)
      const r = findAccount(list, ACCOUNTS.revenue)
      pair[fsDiv] = { rows: list.length, assets: a ? num(a.thstrm_amount) : null, revenue: r ? num(r.thstrm_amount) : null }
      out(`    ${fsDiv}: ${list.length}행 · 자산총계=${pair[fsDiv].assets} · 매출액=${pair[fsDiv].revenue}`)
    } catch (e) {
      stat.fail++
      out(`    ⛔ ${fsDiv}: ${e.message}`)
    }
  }
  if (pair.CFS?.assets && pair.OFS?.assets) {
    const gap = (pair.CFS.assets - pair.OFS.assets) / pair.CFS.assets
    out(`    → 연결 − 별도 자산 차이 ${(gap * 100).toFixed(2)}% ${Math.abs(gap) > 1e-6 ? '(값이 실제로 다르다 ✅ 파라미터 유효)' : '(동일 — fs_div 가 무시됐을 가능성 [미검증])'}`)
  }

  out('  --- 시작 연도 실측 (status 013 = 데이터 없음) ---')
  let earliest = null
  for (const y of EARLY_YEARS) {
    try {
      const json = await fetchFs({ corp: t.corp, year: y })
      const st = String(json.status)
      const n = (json.list ?? []).length
      if (st === '000') {
        stat.ok++
        earliest = earliest ?? y
        const rc = String(json.list[0].rcept_no ?? '')
        out(`    ${y}: ✅ status=000 · ${n}행 · rcept_no=${rc} (접수 ${rc.slice(0, 8)})`)
      } else if (st === '013') {
        stat.empty++
        out(`    ${y}: ○ status=013 (${meaning(st)}) — 정상 0건. 이 연도는 제공되지 않는다`)
      } else {
        stat.fail++
        out(`    ${y}: ⛔ status=${st} (${meaning(st)}) msg=${json.message} — 실패이지 "데이터 없음"이 아니다`)
      }
    } catch (e) {
      stat.fail++
      out(`    ${y}: ⛔ 호출 실패 ${e.message}`)
    }
  }
  findings.b4 = earliest
    ? `연결/별도 파라미터 유효 · **재무데이터 시작 ${earliest}년** (그 이전은 status 013)`
    : '❓ 시작 연도 판정 불가 — status 000 응답 없음'
  out(`\n>>> B-4 판정: ${findings.b4}`)
}

// ------------------------------------------------------- B-5 실패 표현
async function probeB5() {
  out('\n' + '='.repeat(78))
  out('B-5. 실패 표현 — 일부러 틀린 입력으로 status 코드 확인 (HTTP 200 + 본문 status)')
  out('='.repeat(78))
  const cases = [
    { label: '존재하지 않는 corp_code(00000000)', p: { corp_code: '00000000', bsns_year: '2023', reprt_code: '11011', fs_div: 'CFS' } },
    { label: '형식이 틀린 corp_code(ABC)', p: { corp_code: 'ABC', bsns_year: '2023', reprt_code: '11011', fs_div: 'CFS' } },
    { label: '필수 파라미터 누락(bsns_year 없음)', p: { corp_code: TICKERS[0].corp ?? '00126380', reprt_code: '11011', fs_div: 'CFS' } },
    { label: '잘못된 reprt_code(99999)', p: { corp_code: TICKERS[0].corp ?? '00126380', bsns_year: '2023', reprt_code: '99999', fs_div: 'CFS' } },
  ]
  const seen = []
  for (const c of cases) {
    try {
      const { json } = await call('fnlttSinglAcntAll.json', c.p)
      const st = String(json.status)
      seen.push(`${c.label} → ${st}`)
      // 실패 표현 확인은 "성공한 관측"이다. 다만 정상(000)이 나오면 그게 이상하다.
      if (st === '000') {
        stat.fail++
        out(`  ⛔ ${c.label}: status=000 — 틀린 입력인데 정상 응답. 검증 로직을 신뢰할 수 없다`)
      } else {
        stat.ok++
        out(`  ✅ ${c.label}: HTTP 200 · status=${st} (${meaning(st)}) msg="${json.message}"`)
      }
    } catch (e) {
      stat.fail++
      out(`  ⛔ ${c.label}: 호출 실패 ${e.message}`)
    }
  }
  findings.b5 = seen.length ? `실패는 HTTP 200 + 본문 status 로 온다 — 관측: ${seen.join(' · ')}` : '❓ 관측 실패'
  out(`\n>>> B-5 판정: ${findings.b5}`)
  out('  ※ 따라서 수집기는 res.ok 만 보고 성공 처리하면 안 되고 **status === "000" 을 필수 검사**해야 한다.')
}

// ---------------------------------------------------------------- 요약
function summary() {
  out('\n' + '='.repeat(78))
  out('판정 요약 (DART) — 총괄 보고용')
  out('='.repeat(78))
  out(`  B-1 corp_code 매핑   : ${findings.b1 ?? '❓ 미실행'}`)
  out(`  B-2 rcept_no · PIT   : ${findings.b2 ?? '❓ 미실행'}`)
  out(`  B-3 금액 단위        : ${findings.b3 ?? '❓ 미실행'}`)
  out(`  B-4 fs_div · 시작연도: ${findings.b4 ?? '❓ 미실행'}`)
  out(`  B-5 실패 표현        : ${findings.b5 ?? '❓ 미실행'}`)
  out('')
  out(`  인증 구조            : 키 1개(DART_API_KEY)로 전 API · 별도 승인 없음 (사전 확정)`)
  out(`  호출 한도            : 일 20,000건 · 이번 실행 ${stat.calls}회 사용`)
  out(`  호출 성공 ${stat.ok}건 · 정상 0건(status 013) ${stat.empty}건 · 실패 ${stat.fail}건`)
  const b2ok = String(findings.b2 ?? '').startsWith('✅')
  const b3ok = String(findings.b3 ?? '').startsWith('✅')
  const go =
    b2ok && b3ok
      ? '✅ 착수 가능 — rcept_no 접수일을 PIT 기준일로, 금액은 원 단위로 다룬다'
      : '⏸ 보류 — PIT 근거(B-2) 또는 단위(B-3)가 확정되지 않았다. 확정 전에는 팩터 계산을 만들지 않는다'
  out(`  착수 가능 여부       : ${go}`)
  out('')
  out('  ※ 여기서 "판정 불가"로 남은 항목은 [미검증]이며 추측으로 메우지 않는다.')
}

// ---------------------------------------------------------------- 실행
let exitCode = 0
try {
  await probeB1()
  await probeB2()
  await probeB3()
  await probeB4()
  await probeB5()
} catch (e) {
  stat.fail++
  console.error(`\n⛔ 프로브 중단: ${mask(String(e?.stack ?? e))}`)
  exitCode = 1
} finally {
  summary()
}
// 전량 실패를 종료코드로 드러낸다 — 항목별 try 가 오류를 삼켜 "다 실패했는데 0" 이 되는 것을 막는다.
if (stat.ok === 0) {
  console.error('⛔ 성공 호출 0건 — 전량 실패로 종료(종료코드 1). 키 유효성·한도(020)·차단을 먼저 의심할 것.')
  exitCode = 1
}
process.exit(exitCode)
