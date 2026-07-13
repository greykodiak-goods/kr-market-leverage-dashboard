// Generates ~12 months of realistic daily seed data for the dashboard.
// Values are modeled on typical 2025-2026 Korean market magnitudes (units: 억원 = 100M KRW),
// with plausible trends, weekly cycles and noise. This is SAMPLE data used so the
// dashboard renders fully even when live KRX/FreeSIS endpoints are blocked.
// The live fetch script (fetch-data.mjs) overwrites these files when it succeeds.

import { writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUT = join(__dirname, '..', 'public', 'data')
mkdirSync(OUT, { recursive: true })

const DAYS = 365
const today = new Date('2026-07-10T00:00:00+09:00') // last KRX business day in seed window

function isWeekday(d) {
  const day = d.getUTCDay()
  return day !== 0 && day !== 6
}

// Build the business-day date axis (weekdays only) for the last ~12 months.
const dates = []
for (let i = DAYS; i >= 0; i--) {
  const d = new Date(today)
  d.setUTCDate(d.getUTCDate() - i)
  if (isWeekday(d)) dates.push(d)
}

function iso(d) {
  return d.toISOString().slice(0, 10)
}

// Deterministic pseudo-random so seed data is stable across runs.
let _s = 20260710
function rnd() {
  _s = (_s * 1103515245 + 12345) & 0x7fffffff
  return _s / 0x7fffffff
}
function noise(amp) {
  return (rnd() - 0.5) * 2 * amp
}

const n = dates.length
// t in [0,1] across the window
const T = (i) => i / (n - 1)

// --- Model builders -------------------------------------------------------

// Credit balance (신용거래융자 잔고), 억원. KOSPI rises into a spring peak then eases.
function creditKospi(i) {
  const t = T(i)
  const base = 92000 + 34000 * Math.sin(Math.PI * (t * 0.9 + 0.05)) // hump peaking mid-window
  const drift = 6000 * t
  return Math.round(base + drift + noise(1200))
}
function creditKosdaq(i) {
  const t = T(i)
  const base = 78000 + 22000 * Math.sin(Math.PI * (t * 0.9 + 0.08))
  const drift = 3000 * t
  return Math.round(base + drift + noise(1000))
}

// Margin call / 미수금 (억원): spikes on volatile days.
function unsettled(i) {
  const t = T(i)
  const base = 2600 + 700 * Math.sin(Math.PI * 3 * t)
  const spike = rnd() > 0.94 ? 900 + rnd() * 1400 : 0
  return Math.round(Math.max(1500, base + spike + noise(300)))
}

// Investor deposits 투자자예탁금 (억원) ~ 50조원 = 500,000억
function deposit(i) {
  const t = T(i)
  const base = 505000 + 45000 * Math.cos(Math.PI * (t * 1.1)) // was higher, dips, recovers
  return Math.round(base + noise(6000))
}

// Market cap (시가총액, 억원) for credit-ratio calc ~ 2,600조 total (KOSPI+KOSDAQ)
function marketCap(i) {
  const t = T(i)
  return Math.round(25800000 + 2200000 * Math.sin(Math.PI * (t * 0.9 + 0.05)) + noise(120000))
}

// Securities lending balance 대차잔고 (억원) ~ 75조
function lending(i) {
  const t = T(i)
  return Math.round(720000 + 90000 * t + 40000 * Math.sin(Math.PI * 2 * t) + noise(9000))
}

// --- Assemble series ------------------------------------------------------

const creditSeries = dates.map((d, i) => {
  const kospi = creditKospi(i)
  const kosdaq = creditKosdaq(i)
  return { date: iso(d), kospi, kosdaq, total: kospi + kosdaq }
})

const unsettledSeries = dates.map((d, i) => ({ date: iso(d), value: unsettled(i) }))
const depositSeries = dates.map((d, i) => ({ date: iso(d), value: deposit(i) }))
const lendingSeries = dates.map((d, i) => ({ date: iso(d), value: lending(i) }))

const creditRatioSeries = dates.map((d, i) => {
  const credit = creditSeries[i].total
  const cap = marketCap(i)
  return { date: iso(d), value: +((credit / cap) * 100).toFixed(3) }
})

// 예탁금 회전율 (%) = 거래대금 / 예탁금. Model daily turnover of deposits.
const turnoverSeries = dates.map((d, i) => {
  const t = T(i)
  const val = 30 + 12 * Math.sin(Math.PI * 4 * t) + noise(4)
  return { date: iso(d), value: +Math.max(12, val).toFixed(2) }
})

const meta = {
  source: 'SEED', // 'SEED' = sample data; live fetch sets 'LIVE'
  sourceLabel: '샘플 데이터 (KRX/FreeSIS 실데이터 미연동)',
  generatedAt: new Date().toISOString(),
  asOf: iso(dates[dates.length - 1]),
  unit: '억원',
  notes:
    '금융투자협회 FreeSIS / KRX 정보데이터시스템 공개 통계 구조를 반영한 현실적 샘플입니다. 실데이터 연동 시 scripts/fetch-data.mjs 가 이 파일들을 갱신합니다.',
}

function save(name, series) {
  writeFileSync(join(OUT, name), JSON.stringify({ meta, series }, null, 0))
}

save('credit-balance.json', creditSeries)
save('unsettled.json', unsettledSeries)
save('deposit.json', depositSeries)
save('lending.json', lendingSeries)
save('credit-ratio.json', creditRatioSeries)
save('turnover.json', turnoverSeries)

console.log(`Wrote 6 seed files to ${OUT} (${n} business days, asOf ${meta.asOf})`)
