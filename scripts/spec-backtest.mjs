// 헤드리스 백테스트 런처 — TS 엔진(spec-backtest.entry.ts)을 esbuild JS API로
// 번들해 실행한다(run-tests.mjs와 같은 방식 — CLI 경로는 플랫폼마다 깨진다).
import { mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { buildSync } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'node_modules', '.spec-backtest')
rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })
const out = join(outDir, 'entry.cjs')

buildSync({
  entryPoints: [join(root, 'scripts', 'spec-backtest.entry.ts')],
  bundle: true,
  platform: 'node',
  outfile: out,
  logLevel: 'error',
})

execFileSync(process.execPath, [out], { stdio: 'inherit', env: { ...process.env, REPO_ROOT: root } })
