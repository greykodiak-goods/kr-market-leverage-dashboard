// 가격 스냅샷 — 티커 목록의 최근 1개월 등락률 (GHA 러너 전용 · 야후 v8 · 키 불필요)
//
// 왜 GHA인가: AI 세션 컨테이너는 야후·stooq·finviz가 이그레스 정책으로 차단돼 있다
// (curl http 000 확인, 2026-08-08). 러너에서 돌려 로그로 회수한다.
// 규칙 4 게이트: 성공 카운터 · 전량 실패 시 비정상 종료 · 실패 티커는 명시.
//
// 실행: MODE=prices [TICKERS=NET,TWLO,...] node scripts/price-snapshot.mjs

const DEFAULT_TICKERS =
  'NET,TWLO,MDB,DDOG,FIG,GTLB,TEAM,SNOW,ESTC,OKTA,CFLT,DOCN,FSLY,MNDY,ASAN,' +
  'BAND,KVYO,BRZE,PYPL,XYZ,CRM,BOX,DBX,DOCU,PD,HUBS,NOW,FRSH,WIX,FROG,DT,AKAM,' +
  'MSFT,AMZN,GOOGL,SHOP,INTU'

const tickers = (process.env.TICKERS ?? DEFAULT_TICKERS).split(',').map((t) => t.trim()).filter(Boolean)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function fetchChart(sym) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=2mo&interval=1d`
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const j = await res.json()
  const r = j?.chart?.result?.[0]
  const ts = r?.timestamp
  const close = r?.indicators?.quote?.[0]?.close
  if (!ts?.length || !close?.length) throw new Error('빈 응답')
  const rows = ts.map((t, i) => ({ t: t * 1000, c: close[i] })).filter((x) => Number.isFinite(x.c))
  if (rows.length < 15) throw new Error(`봉 부족 ${rows.length}`)
  return rows
}

const ok = []
const fail = []
for (const sym of tickers) {
  try {
    const rows = await fetchChart(sym)
    const last = rows[rows.length - 1]
    const target = last.t - 30 * 86400e3
    // 1개월 전 이하 중 가장 가까운 봉 (없으면 첫 봉)
    let base = rows[0]
    for (const x of rows) if (x.t <= target) base = x
    const chg = (last.c / base.c - 1) * 100
    ok.push({ sym, chg, from: new Date(base.t).toISOString().slice(0, 10), to: new Date(last.t).toISOString().slice(0, 10), price: last.c })
  } catch (e) {
    fail.push(`${sym}(${e.message})`)
  }
  await sleep(250)
}

ok.sort((a, b) => b.chg - a.chg)
console.log(`# 1개월 등락 스냅샷 (야후 v8 · 생성 ${new Date().toISOString()})`)
console.log(`기준: 각 티커 마지막 종가 vs 30일 전 직전 봉 종가 · 성공 ${ok.length}/${tickers.length}`)
console.log('')
console.log('| 티커 | 1개월 | 현재가 | 기준구간 |')
console.log('|---|---|---|---|')
for (const r of ok) console.log(`| ${r.sym} | ${r.chg >= 0 ? '+' : ''}${r.chg.toFixed(1)}% | $${r.price.toFixed(2)} | ${r.from}→${r.to} |`)
if (fail.length) console.log(`\n⚠️ 실패 ${fail.length}건: ${fail.join(', ')}`)
if (ok.length === 0) {
  console.error('전량 실패 — 비정상 종료')
  process.exit(1)
}
