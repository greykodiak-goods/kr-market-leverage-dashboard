// Fetches fresh market data from Yahoo Finance for SK Hynix technical outlook
// scenario analysis, computes indicators, and prints a JSON summary to stdout.
// Does NOT write files or commit — caller (agent) composes the final commentary
// and writes public/data/hynix-outlook.json.

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'

const SYMBOLS = ['000660.KS', 'SKHY', 'KRW=X', '^SOX', 'NVDA', 'MU', 'TSM', '^VIX', '^TNX']

async function fetchChart(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1y&interval=1d`
  const res = await fetch(url, { headers: { 'User-Agent': UA } })
  if (!res.ok) throw new Error(`${symbol}: HTTP ${res.status}`)
  const json = await res.json()
  const result = json?.chart?.result?.[0]
  if (!result) throw new Error(`${symbol}: no result (${JSON.stringify(json?.chart?.error)})`)
  const ts = result.timestamp || []
  const q = result.indicators?.quote?.[0] || {}
  const closes = q.close || []
  const dates = ts.map((t) => new Date(t * 1000).toISOString().slice(0, 10))
  const rows = dates.map((d, i) => ({ date: d, close: closes[i] })).filter((r) => r.close != null)
  return { symbol, meta: result.meta, rows }
}

function sma(arr, period, endIdx) {
  if (endIdx - period + 1 < 0) return null
  let sum = 0
  for (let i = endIdx - period + 1; i <= endIdx; i++) sum += arr[i]
  return sum / period
}

function rsi(closes, period = 14) {
  if (closes.length < period + 1) return null
  let gains = 0
  let losses = 0
  const n = closes.length
  for (let i = n - period; i < n; i++) {
    const diff = closes[i] - closes[i - 1]
    if (diff >= 0) gains += diff
    else losses -= diff
  }
  const avgGain = gains / period
  const avgLoss = losses / period
  if (avgLoss === 0) return 100
  const rs = avgGain / avgLoss
  return 100 - 100 / (1 + rs)
}

function bollinger(closes, period = 20, mult = 2) {
  const n = closes.length
  const slice = closes.slice(n - period, n)
  const mean = slice.reduce((a, b) => a + b, 0) / period
  const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period
  const sd = Math.sqrt(variance)
  return { mid: mean, upper: mean + mult * sd, lower: mean - mult * sd }
}

async function main() {
  const data = {}
  const errors = []
  for (const sym of SYMBOLS) {
    try {
      data[sym] = await fetchChart(sym)
    } catch (err) {
      errors.push(String(err.message || err))
    }
  }

  const out = { errors, symbols: {} }

  const hynix = data['000660.KS']
  if (hynix) {
    const closes = hynix.rows.map((r) => r.close)
    const n = closes.length
    const lastClose = closes[n - 1]
    const ma20 = sma(closes, 20, n - 1)
    const ma60 = sma(closes, 60, n - 1)
    const ma120 = sma(closes, 120, n - 1)
    const ma20prev = sma(closes, 20, n - 2)
    const ma60prev = sma(closes, 60, n - 2)
    const rsi14 = rsi(closes, 14)
    const bb = bollinger(closes, 20, 2)
    const last252 = closes.slice(Math.max(0, n - 252), n)
    const high52w = Math.max(...last252)
    const low52w = Math.min(...last252)
    const last20 = closes.slice(Math.max(0, n - 20), n)
    const recentLow = Math.min(...last20)
    const recentHigh = Math.max(...last20)
    const goldenCross = ma20 != null && ma60 != null && ma20 > ma60
    const deadCross = ma20 != null && ma60 != null && ma20 < ma60
    const crossFlip =
      ma20prev != null && ma60prev != null && ma20 != null && ma60 != null
        ? Math.sign(ma20 - ma60) !== Math.sign(ma20prev - ma60prev)
          ? goldenCross
            ? 'golden-cross-just-happened'
            : 'dead-cross-just-happened'
          : null
        : null

    out.symbols.hynix = {
      lastDate: hynix.rows[n - 1].date,
      lastClose,
      ma20,
      ma60,
      ma120,
      rsi14,
      bollinger: bb,
      high52w,
      low52w,
      recentLow20d: recentLow,
      recentHigh20d: recentHigh,
      goldenCross,
      deadCross,
      crossFlip,
      pctChange5d: ((lastClose - closes[n - 6]) / closes[n - 6]) * 100,
    }
  }

  for (const [key, label] of [
    ['SKHY', 'skhyAdr'],
    ['KRW=X', 'usdkrw'],
    ['^SOX', 'sox'],
    ['NVDA', 'nvda'],
    ['MU', 'mu'],
    ['TSM', 'tsm'],
    ['^VIX', 'vix'],
    ['^TNX', 'tnx'],
  ]) {
    const d = data[key]
    if (!d) continue
    const closes = d.rows.map((r) => r.close)
    const n = closes.length
    out.symbols[label] = {
      lastDate: d.rows[n - 1].date,
      last: closes[n - 1],
      pctChange5d: n > 5 ? ((closes[n - 1] - closes[n - 6]) / closes[n - 6]) * 100 : null,
      pctChange1d: n > 1 ? ((closes[n - 1] - closes[n - 2]) / closes[n - 2]) * 100 : null,
    }
  }

  if (out.symbols.hynix && out.symbols.skhyAdr && out.symbols.usdkrw) {
    const krw = out.symbols.hynix.lastClose
    const usdkrw = out.symbols.usdkrw.last
    const fairAdr = (krw / usdkrw) * 0.1
    const actualAdr = out.symbols.skhyAdr.last
    out.adrPremiumPct = (actualAdr / fairAdr - 1) * 100
    out.fairAdr = fairAdr
    out.actualAdr = actualAdr
  }

  console.log(JSON.stringify(out, null, 2))
}

main().catch((err) => {
  console.error('FATAL', err)
  process.exit(1)
})
