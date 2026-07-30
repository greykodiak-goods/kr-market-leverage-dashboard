// 페이퍼 트레이딩 런처 — TS 엔진(paper-trade.entry.ts)을 esbuild로 번들해 실행.
// (spec-backtest.mjs와 같은 방식)
import { mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { buildSync } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'node_modules', '.paper-trade')
rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })
const out = join(outDir, 'entry.cjs')

buildSync({
  entryPoints: [join(root, 'scripts', 'paper-trade.entry.ts')],
  bundle: true,
  platform: 'node',
  outfile: out,
  logLevel: 'error',
})

execFileSync(process.execPath, [out], { stdio: 'inherit', env: { ...process.env, REPO_ROOT: root } })
