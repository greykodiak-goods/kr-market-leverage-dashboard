// 레버리지 지표 LIVE 파이프라인 — 금융투자협회 FreeSIS → public/data/*.json
//
// 무키·무계정 공개 통계 API (2026-07-24 실측 확인):
//   POST https://freesis.kofia.or.kr/meta/getMetaDataList.do
//   body: {"dmSearch":{"tmpV40":"1000000","tmpV41":"1","tmpV1":"D",
//          "tmpV45":"YYYYMMDD(시작)","tmpV46":"YYYYMMDD(끝)","OBJ_NM":"<serviceId>BO"}}
//   - tmpV40/41 = 단위 나눗수(1000000 → 백만원), tmpV1 'D' = 일별
//   - 응답: {"ds1":[{"TMPV1":"YYYYMMDD","TMPV2":...}]} (최신일 → 과거 순)
//
// 사용 통계 (그리드 헤더 실측으로 컬럼 확정):
//   STATSCU0100000060BO 증시자금추이 — TMPV2 투자자예탁금(장내파생 예수금 제외),
//     TMPV3 장내파생 거래예수금, TMPV4 대고객 RP 매도잔고, TMPV5 위탁매매 미수금,
//     TMPV6 미수금 대비 실제 반대매매금액, TMPV7 미수금 대비 반대매매비중(%)
//   STATSCU0100000070BO 신용공여 잔고 추이 — TMPV2 신용거래융자 전체, TMPV3 유가,
//     TMPV4 코스닥, TMPV5~7 신용거래대주(전체/유가/코스닥), TMPV8 청약자금대출,
//     TMPV9 예탁증권담보융자
//   STATSCU0100000020BO/030BO 유가증권/코스닥 시장 — TMPV2 지수, TMPV3 거래량,
//     TMPV4 거래대금, TMPV5 시가총액, TMPV6 외국인 시가총액, TMPV7 외국인 비중(%)
//
// 산출 (기존 대시보드 스키마 그대로, 단위 억원 = 백만원/100):
//   credit-balance.json  {date,kospi,kosdaq,total}      — LIVE (STATSCU0100000070)
//   deposit.json         {date,value}                   — LIVE (STATSCU0100000060)
//   unsettled.json       {date,value,+반대매매 필드}     — LIVE (STATSCU0100000060)
//   credit-ratio.json    {date,value%}  파생 근사        — 신용융자 ÷ (KOSPI+KOSDAQ 시총)
//   turnover.json        {date,value%}  파생 근사        — (KOSPI+KOSDAQ 거래대금) ÷ 예탁금
//   lending.json         건드리지 않음(SEED 유지 — FreeSIS 대차 통계는 파라미터 미해결)
//
// 안전: 응답 검증(행수·최신일) 실패 시 기존 파일을 절대 덮어쓰지 않는다.
// 빈도: 통계당 1회 호출 + 1.5초 간격 (총 4회) — 정중한 수준 유지. 스케줄은 일 1회면 충분.
//
// Usage: node scripts/fetch-leverage.mjs   (또는 npm run fetch-leverage)

import { writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUT = join(__dirname, '..', 'public', 'data')

const API = 'https://freesis.kofia.or.kr/meta/getMetaDataList.do'
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'
const START = '20100101' // FreeSIS 해당 통계 제공 시작(2010-01-04)

const KST_MS = 9 * 3600 * 1000
function kstNow() {
  return new Date(Date.now() + KST_MS)
}
function ymd(d, sep = '') {
  return [
    d.getUTCFullYear(),
    String(d.getUTCMonth() + 1).padStart(2, '0'),
    String(d.getUTCDate()).padStart(2, '0'),
  ].join(sep)
}
function kstISO() {
  return kstNow().toISOString().replace('Z', '+09:00').replace(/\.\d{3}/, '')
}
function isoDate(yyyymmdd) {
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const eok = (millionKrw) => Math.round((millionKrw / 100) * 10) / 10 // 백만원 → 억원(소수1)
const round = (v, d) => Math.round(v * 10 ** d) / 10 ** d

async function freesis(objNm) {
  const body = {
    dmSearch: {
      tmpV40: '1000000',
      tmpV41: '1',
      tmpV1: 'D',
      tmpV45: START,
      tmpV46: ymd(kstNow()),
      OBJ_NM: objNm,
    },
  }
  const res = await fetch(API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=UTF-8',
      'User-Agent': UA,
      Referer: 'https://freesis.kofia.or.kr/stat/FreeSIS.do',
      Origin: 'https://freesis.kofia.or.kr',
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`${objNm} HTTP ${res.status}`)
  const text = await res.text()
  if (!text.trim().startsWith('{')) throw new Error(`${objNm} non-JSON response (bot page?)`)
  const rows = JSON.parse(text).ds1
  if (!Array.isArray(rows) || rows.length < 100) {
    throw new Error(`${objNm} suspicious row count: ${rows?.length ?? 'none'}`)
  }
  // 응답은 최신 → 과거. 오름차순으로 뒤집는다.
  rows.sort((a, b) => (a.TMPV1 < b.TMPV1 ? -1 : 1))
  const latest = rows[rows.length - 1].TMPV1
  const ageDays = (Date.now() + KST_MS - Date.parse(isoDate(latest))) / 86400000
  if (ageDays > 15) throw new Error(`${objNm} stale latest date ${latest}`)
  console.log(`[freesis] ${objNm}: ${rows.length} rows, ${rows[0].TMPV1} → ${latest}`)
  return rows
}

function meta({ series, unit, notes }) {
  return {
    source: 'LIVE',
    sourceLabel: 'LIVE — 금융투자협회 종합통계(FreeSIS) 실데이터',
    generatedAt: new Date().toISOString(),
    fetchedAt: kstISO(),
    asOf: series[series.length - 1].date,
    start: series[0].date,
    unit,
    cadence: 'daily',
    notes,
  }
}

function writeDataset(file, dataset) {
  writeFileSync(join(OUT, file), JSON.stringify(dataset) + '\n', 'utf8')
  console.log(`[write] ${file}: ${dataset.series.length} pts, asOf ${dataset.meta.asOf}`)
}

const DELAY_NOTE = '일별 공표 통계로 최신일은 보통 1~2영업일 지연이 정상입니다.'

async function main() {
  // ---- fetch (정중한 간격) --------------------------------------------------
  const credit = await freesis('STATSCU0100000070BO')
  await sleep(1500)
  const funds = await freesis('STATSCU0100000060BO')
  await sleep(1500)
  const kospiMkt = await freesis('STATSCU0100000020BO')
  await sleep(1500)
  const kosdaqMkt = await freesis('STATSCU0100000030BO')

  // ---- normalize ------------------------------------------------------------
  // 신용거래융자 (억원)
  const creditSeries = credit
    .filter((r) => r.TMPV2 != null && r.TMPV3 != null && r.TMPV4 != null)
    .map((r) => ({
      date: isoDate(r.TMPV1),
      kospi: eok(r.TMPV3),
      kosdaq: eok(r.TMPV4),
      total: eok(r.TMPV2),
    }))

  // 투자자예탁금 (억원)
  const depositSeries = funds
    .filter((r) => r.TMPV2 != null)
    .map((r) => ({ date: isoDate(r.TMPV1), value: eok(r.TMPV2) }))

  // 위탁매매 미수금 (억원) + 반대매매 부가 필드
  const unsettledSeries = funds
    .filter((r) => r.TMPV5 != null)
    .map((r) => ({
      date: isoDate(r.TMPV1),
      value: eok(r.TMPV5),
      ...(r.TMPV6 != null ? { reverseTradeEok: eok(r.TMPV6) } : {}),
      ...(r.TMPV7 != null ? { reverseTradeRatioPct: r.TMPV7 } : {}),
    }))

  // 파생 근사 1: 신용잔고율(%) = 신용융자 합계 ÷ (KOSPI 시총 + KOSDAQ 시총) × 100
  const mktCapByDate = new Map()
  for (const r of kospiMkt) if (r.TMPV5 != null) mktCapByDate.set(r.TMPV1, { kospi: r.TMPV5 })
  for (const r of kosdaqMkt) {
    if (r.TMPV5 == null) continue
    const e = mktCapByDate.get(r.TMPV1)
    if (e) e.kosdaq = r.TMPV5
  }
  const ratioSeries = credit
    .map((r) => {
      const cap = mktCapByDate.get(r.TMPV1)
      if (!cap || cap.kosdaq == null || r.TMPV2 == null) return null
      return { date: isoDate(r.TMPV1), value: round((r.TMPV2 / (cap.kospi + cap.kosdaq)) * 100, 3) }
    })
    .filter(Boolean)

  // 파생 근사 2: 예탁금 회전율(%) = (KOSPI 거래대금 + KOSDAQ 거래대금) ÷ 예탁금 × 100
  const valueByDate = new Map()
  for (const r of kospiMkt) if (r.TMPV4 != null) valueByDate.set(r.TMPV1, { kospi: r.TMPV4 })
  for (const r of kosdaqMkt) {
    if (r.TMPV4 == null) continue
    const e = valueByDate.get(r.TMPV1)
    if (e) e.kosdaq = r.TMPV4
  }
  const turnoverSeries = funds
    .map((r) => {
      const v = valueByDate.get(r.TMPV1)
      if (!v || v.kosdaq == null || !r.TMPV2) return null
      return { date: isoDate(r.TMPV1), value: round(((v.kospi + v.kosdaq) / r.TMPV2) * 100, 2) }
    })
    .filter(Boolean)

  // ---- write ---------------------------------------------------------------
  mkdirSync(OUT, { recursive: true })
  writeDataset('credit-balance.json', {
    meta: meta({
      series: creditSeries,
      unit: '억원',
      notes: `금융투자협회 FreeSIS 신용공여 잔고 추이(STATSCU0100000070) — 신용거래융자 코스피/코스닥 실데이터, 2010-01-04부터 일별. ${DELAY_NOTE}`,
    }),
    series: creditSeries,
  })
  writeDataset('deposit.json', {
    meta: meta({
      series: depositSeries,
      unit: '억원',
      notes: `금융투자협회 FreeSIS 증시자금추이(STATSCU0100000060) — 투자자예탁금(장내파생상품 거래예수금 제외) 실데이터, 일별. ${DELAY_NOTE}`,
    }),
    series: depositSeries,
  })
  writeDataset('unsettled.json', {
    meta: meta({
      series: unsettledSeries,
      unit: '억원',
      notes: `금융투자협회 FreeSIS 증시자금추이(STATSCU0100000060) — 위탁매매 미수금 실데이터, 일별. 반대매매금액(reverseTradeEok)·미수금 대비 반대매매비중(reverseTradeRatioPct) 필드 포함. ${DELAY_NOTE}`,
    }),
    series: unsettledSeries,
  })
  writeDataset('credit-ratio.json', {
    meta: meta({
      series: ratioSeries,
      unit: '%',
      notes: `파생 근사 지표: 신용거래융자 잔고 ÷ (KOSPI+KOSDAQ 시가총액) × 100. 분자·분모 모두 금융투자협회 FreeSIS 실데이터(STATSCU0100000070 · 0020/0030). 시총 미공표일은 제외. ${DELAY_NOTE}`,
    }),
    series: ratioSeries,
  })
  writeDataset('turnover.json', {
    meta: meta({
      series: turnoverSeries,
      unit: '%',
      notes: `파생 근사 지표: (KOSPI+KOSDAQ 거래대금) ÷ 투자자예탁금 × 100. 모두 금융투자협회 FreeSIS 실데이터(STATSCU0100000020/0030 · 0060). 거래대금 미공표일은 제외. ${DELAY_NOTE}`,
    }),
    series: turnoverSeries,
  })
  console.log('[fetch-leverage] done — lending.json은 SEED 유지(대차 통계 파라미터 미해결).')
}

main().catch((e) => {
  console.error('[fetch-leverage] FAILED (기존 파일 유지):', e.message)
  process.exit(1)
})
