// Generates SEED sample data for the short-covering monitor:
//   public/data/hynix-lending.json      (종목별 대차잔고 — LIVE는 data.go.kr 주식대차정보)
//   public/data/hynix-short-balance.json (공매도 잔고/비중 — 소스 미확정)
//
// ~13 months of daily business-day points modeled to tell a realistic story:
// a short build-up peaking, then a multi-week COVERING phase (declining lending
// & short balance). Values are illustrative SAMPLE only; components render off
// meta.source so LIVE swap needs no code change.

import { writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUT = join(__dirname, '..', 'public', 'data')
mkdirSync(OUT, { recursive: true })

const END = new Date(Date.UTC(2026, 6, 10))
const DAYS = 400

let _s = 20260714
function rnd() {
  _s = (_s * 1103515245 + 12345) & 0x7fffffff
  return _s / 0x7fffffff
}
const noise = (a) => (rnd() - 0.5) * 2 * a

function isWeekday(d) {
  const x = d.getUTCDay()
  return x !== 0 && x !== 6
}
const iso = (d) => d.toISOString().slice(0, 10)

const dates = []
for (let i = DAYS; i >= 0; i--) {
  const d = new Date(END)
  d.setUTCDate(d.getUTCDate() - i)
  if (isWeekday(d)) dates.push(d)
}
const n = dates.length
const T = (i) => i / (n - 1)

// Hynix ~ 728M shares outstanding (근사). Price ~1.85M KRW.
const PRICE = 1_850_000
const SHARES_OUT = 728_000_000

// Lending balance (shares): rises into a peak ~62% of window, then COVERS down.
function lendingShares(i) {
  const t = T(i)
  // hump peaking around t=0.62, then decline (covering)
  const hump = Math.exp(-Math.pow((t - 0.62) / 0.28, 2))
  const base = 9_000_000 + 20_000_000 * hump
  const lateCover = t > 0.62 ? -6_000_000 * (t - 0.62) / 0.38 : 0
  return Math.max(4_000_000, Math.round(base + lateCover + noise(500_000)))
}

// Short balance shares ~ 60% of lending (short-specific subset), similar arc.
function shortShares(i, lend) {
  return Math.max(2_000_000, Math.round(lend * (0.58 + 0.05 * Math.sin(T(i) * 5)) + noise(300_000)))
}

const lendingSeries = dates.map((d, i) => {
  const shares = lendingShares(i)
  return { date: iso(d), shares, amountEok: Math.round((shares * PRICE) / 1e8) }
})

const shortSeries = dates.map((d, i) => {
  const shares = shortShares(i, lendingSeries[i].shares)
  const amountEok = Math.round((shares * PRICE) / 1e8)
  const ratioPct = +((shares / SHARES_OUT) * 100).toFixed(3)
  return { date: iso(d), shares, amountEok, ratioPct }
})

function meta(label, notes) {
  return {
    source: 'SEED',
    sourceLabel: label,
    generatedAt: new Date().toISOString(),
    asOf: iso(dates[n - 1]),
    unit: '주 / 억원',
    notes,
  }
}

writeFileSync(
  join(OUT, 'hynix-lending.json'),
  JSON.stringify(
    {
      meta: meta(
        '샘플 데이터 (실데이터 연동 예정 · 주식대차정보 data.go.kr)',
        '종목(000660) 대차잔고 샘플. 숏 빌드업→커버링 국면을 반영한 illustrative 값. 실데이터는 data.go.kr 주식대차정보 키 확보 후 자동 교체(컴포넌트 무변경).',
      ),
      series: lendingSeries,
    },
    null,
    0,
  ),
)

writeFileSync(
  join(OUT, 'hynix-short-balance.json'),
  JSON.stringify(
    {
      meta: meta(
        '샘플 데이터 (공매도 잔고 소스 미확정 · KRX WAF 차단)',
        '공매도 잔고/비중 샘플. KRX 공매도종합포털은 WAF 차단, data.go.kr 대체 오픈API 확인 예정. illustrative 값.',
      ),
      series: shortSeries,
    },
    null,
    0,
  ),
)

console.log(
  `Wrote hynix-lending.json / hynix-short-balance.json (${n} business days, asOf ${iso(dates[n - 1])})`,
)
console.log(
  `  lending last: ${lendingSeries[n - 1].shares.toLocaleString()}주 / ${lendingSeries[n - 1].amountEok}억`,
)
console.log(`  short last: 비중 ${shortSeries[n - 1].ratioPct}% / ${shortSeries[n - 1].amountEok}억`)
