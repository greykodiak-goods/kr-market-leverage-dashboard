// Generates ~20 years of realistic SAMPLE data for the leverage/sentiment charts.
// UNIFORM WEEKLY cadence across the entire 2006~2026 window (one point every 7
// days) so time spacing is even — this avoids the chart distortion that occurs
// when point density varies across the range. Period buttons (1Y/5Y/10Y/20Y)
// just slice the tail of this uniform series.
//
// Values are modeled on typical Korean-market magnitudes (units: 억원 = 100M KRW)
// with a long-term trend, cyclical variation, and rough shocks for the 2008
// global financial crisis and the 2020 COVID crash. This is SAMPLE data so the
// dashboard renders fully; the live fetch script overwrites it when it succeeds.

import { writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUT = join(__dirname, '..', 'public', 'data')
mkdirSync(OUT, { recursive: true })

const END = new Date(Date.UTC(2026, 6, 10)) // 2026-07-10 (last business day of window)
const START_YEAR = 2006

// ---- deterministic pseudo-random ----------------------------------------
let _s = 20260710
function rnd() {
  _s = (_s * 1103515245 + 12345) & 0x7fffffff
  return _s / 0x7fffffff
}
function noise(amp) {
  return (rnd() - 0.5) * 2 * amp
}
function gauss(y, center, width) {
  return Math.exp(-Math.pow((y - center) / width, 2))
}

// yearFloat from a Date (e.g. 2020.21)
function yearFloat(d) {
  const y = d.getUTCFullYear()
  const start = Date.UTC(y, 0, 1)
  const end = Date.UTC(y + 1, 0, 1)
  return y + (d.getTime() - start) / (end - start)
}

// linear interpolation across yearly anchors { [year]: value }
function interp(anchors, y) {
  const years = Object.keys(anchors).map(Number).sort((a, b) => a - b)
  if (y <= years[0]) return anchors[years[0]]
  if (y >= years[years.length - 1]) return anchors[years[years.length - 1]]
  for (let i = 0; i < years.length - 1; i++) {
    if (y >= years[i] && y <= years[i + 1]) {
      const t = (y - years[i]) / (years[i + 1] - years[i])
      return anchors[years[i]] * (1 - t) + anchors[years[i + 1]] * t
    }
  }
  return anchors[years[years.length - 1]]
}

// ---- anchors (조원 unless noted) -----------------------------------------
const T = 10000 // 조 -> 억

const creditTotal = { 2006: 7.5, 2007: 9.5, 2008: 4.5, 2009: 6.5, 2010: 7.8, 2011: 7.0, 2012: 5.2, 2013: 5.0, 2014: 5.5, 2015: 7.2, 2016: 6.8, 2017: 9.5, 2018: 9.8, 2019: 9.2, 2020: 19.0, 2021: 23.0, 2022: 16.5, 2023: 17.8, 2024: 19.0, 2025: 20.0, 2026: 18.6 }
const depositA = { 2006: 11, 2007: 14, 2008: 10, 2009: 15, 2010: 16, 2011: 17, 2012: 18, 2013: 17, 2014: 17.5, 2015: 21, 2016: 22, 2017: 26, 2018: 25, 2019: 27, 2020: 65, 2021: 67, 2022: 50, 2023: 50, 2024: 52, 2025: 54, 2026: 46.4 }
const lendingA = { 2006: 5, 2007: 8, 2008: 6, 2009: 9, 2010: 15, 2011: 20, 2012: 24, 2013: 28, 2014: 35, 2015: 42, 2016: 48, 2017: 55, 2018: 58, 2019: 56, 2020: 60, 2021: 70, 2022: 66, 2023: 72, 2024: 76, 2025: 79, 2026: 81.7 }
const ratioA = { 2006: 0.55, 2007: 0.62, 2008: 0.35, 2009: 0.5, 2010: 0.55, 2011: 0.5, 2012: 0.4, 2013: 0.4, 2014: 0.42, 2015: 0.55, 2016: 0.5, 2017: 0.62, 2018: 0.65, 2019: 0.6, 2020: 0.85, 2021: 0.95, 2022: 0.72, 2023: 0.75, 2024: 0.72, 2025: 0.71, 2026: 0.706 }
const unsettledA = { 2006: 2200, 2007: 2600, 2008: 5500, 2009: 3000, 2010: 2400, 2011: 2800, 2012: 2000, 2013: 1900, 2014: 2000, 2015: 2600, 2016: 2300, 2017: 2800, 2018: 3000, 2019: 2500, 2020: 4200, 2021: 3200, 2022: 2800, 2023: 2700, 2024: 2650, 2025: 2680, 2026: 2702 }

// COVID March-2020 deep V and 2008 Q4 shocks (localized on top of anchors)
const covid = (y) => gauss(y, 2020.21, 0.12)
const gfc = (y) => gauss(y, 2008.83, 0.33)

function creditAt(d, daily) {
  const y = yearFloat(d)
  const total = interp(creditTotal, y) * T * (1 - 0.45 * covid(y)) + noise(daily ? 900 : 1500)
  const kosdaqShare = 0.42 + 0.05 * Math.sin(y * 1.3)
  const kosdaq = Math.round(total * kosdaqShare)
  const kospi = Math.round(total - kosdaq)
  return { kospi, kosdaq, total: kospi + kosdaq }
}
function depositAt(d, daily) {
  const y = yearFloat(d)
  return Math.round(interp(depositA, y) * T * (1 - 0.15 * covid(y)) + noise(daily ? 3000 : 6000))
}
function lendingAt(d, daily) {
  const y = yearFloat(d)
  return Math.round(interp(lendingA, y) * T * (1 + 0.1 * covid(y)) + noise(daily ? 5000 : 9000))
}
function ratioAt(d) {
  const y = yearFloat(d)
  return +Math.max(0.2, interp(ratioA, y) * (1 - 0.4 * covid(y)) + noise(0.01)).toFixed(3)
}
function unsettledAt(d, daily) {
  const y = yearFloat(d)
  const base = interp(unsettledA, y) + 3000 * gfc(y) + 3500 * covid(y)
  const spike = daily && rnd() > 0.94 ? 900 + rnd() * 1400 : 0
  return Math.round(Math.max(1200, base + spike + noise(daily ? 300 : 500)))
}
function turnoverAt(d) {
  const y = yearFloat(d)
  const v = 26 + 8 * Math.sin(y * 2.1) + 20 * covid(y) + 10 * gfc(y) + noise(3)
  return +Math.max(10, v).toFixed(2)
}

// ---- build date axis: monthly history + recent daily ---------------------
function iso(d) {
  return d.toISOString().slice(0, 10)
}
function isWeekday(d) {
  const day = d.getUTCDay()
  return day !== 0 && day !== 6
}

// Cadence: DAILY business days for the most recent 6 years (so 1M~1Y views are
// truly day-level), WEEKLY for the older 2006~ history (kept lighter). The charts
// use a time-scale X axis, so mixed spacing does not distort; long views are
// downsampled at display time for performance.
const DAILY_YEARS = 6
const dailyStart = new Date(Date.UTC(END.getUTCFullYear() - DAILY_YEARS, END.getUTCMonth(), END.getUTCDate()))

const dates = []
// weekly older history
let cur = new Date(Date.UTC(START_YEAR, 0, 2))
while (cur < dailyStart) {
  const day = isWeekday(cur) ? cur : new Date(cur.getTime() + 86400000)
  dates.push({ d: new Date(day), daily: false })
  cur = new Date(cur.getTime() + 7 * 86400000)
}
// daily business days for the recent window
let dcur = new Date(dailyStart)
while (dcur <= END) {
  if (isWeekday(dcur)) dates.push({ d: new Date(dcur), daily: true })
  dcur = new Date(dcur.getTime() + 86400000)
}
if (iso(dates[dates.length - 1].d) !== iso(END) && isWeekday(END)) dates.push({ d: new Date(END), daily: true })

// ---- assemble series -----------------------------------------------------
const creditSeries = dates.map(({ d, daily }) => {
  const c = creditAt(d, daily)
  return { date: iso(d), kospi: c.kospi, kosdaq: c.kosdaq, total: c.total }
})
const unsettledSeries = dates.map(({ d, daily }) => ({ date: iso(d), value: unsettledAt(d, daily) }))
const depositSeries = dates.map(({ d, daily }) => ({ date: iso(d), value: depositAt(d, daily) }))
const lendingSeries = dates.map(({ d, daily }) => ({ date: iso(d), value: lendingAt(d, daily) }))
const creditRatioSeries = dates.map(({ d }) => ({ date: iso(d), value: ratioAt(d) }))
const turnoverSeries = dates.map(({ d }) => ({ date: iso(d), value: turnoverAt(d) }))

const meta = {
  source: 'SEED',
  sourceLabel: '샘플 데이터 (KRX/FreeSIS 실데이터 미연동)',
  generatedAt: new Date().toISOString(),
  asOf: iso(END),
  start: iso(dates[0].d),
  unit: '억원',
  cadence: 'daily-recent+weekly-history',
  notes:
    '약 20년(2006~) 샘플: 최근 6년 일 단위, 과거는 주 단위. 2008 금융위기·2020 코로나 변동을 대략 반영한 현실적 샘플이며 실제 수치와 다릅니다. 실제 데이터는 KRX/금융투자협회 연동 시 자동 갱신됩니다.',
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

console.log(
  `Wrote 6 seed files: ${dates.length} points (${dates.filter((x) => !x.daily).length} monthly + ${dates.filter((x) => x.daily).length} daily), ${meta.start}~${meta.asOf}`,
)
