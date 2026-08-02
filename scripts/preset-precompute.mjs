// 프리셋 사전계산 런처 — TS 엔트리(preset-precompute.entry.ts)를 esbuild JS API로
// 번들해 실행한다(run-tests.mjs와 같은 방식 — CLI 경로는 플랫폼마다 깨진다).
//
// 산출물: public/data/presets-precomputed.json  (GHA backtest.yml MODE=presets가 커밋)
import { mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { buildSync } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'node_modules', '.preset-precompute')
rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })
const out = join(outDir, 'entry.cjs')

buildSync({
  entryPoints: [join(root, 'scripts', 'preset-precompute.entry.ts')],
  bundle: true,
  platform: 'node',
  outfile: out,
  logLevel: 'error',
})

// PRESET_PRECOMPUTE_RUN=1 을 넘겨야 엔트리가 main()을 돈다 —
// 테스트가 같은 모듈을 import할 때 자동 실행되지 않게 하는 장치다.
execFileSync(process.execPath, [out], {
  stdio: 'inherit',
  env: { ...process.env, REPO_ROOT: root, PRESET_PRECOMPUTE_RUN: '1' },
})
