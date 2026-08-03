// 과최적화 랩 런처 — TS 러너(overfit-lab.entry.ts)를 esbuild JS API로 번들해 실행한다
// (run-tests.mjs·idea-lab.mjs와 같은 방식 — CLI 경로는 플랫폼마다 깨진다).
//
//   MODE=overfit  node scripts/overfit-lab.mjs                       (자기검증만)
//   OVERFIT_INPUT=<회차.json> MODE=overfit node scripts/overfit-lab.mjs   (실데이터 채점)
//   MODE=selftest node scripts/overfit-lab.mjs                       (항상 합성 자기검증)
//
// 네트워크를 쓰지 않는다(이미 확정된 수익률 계열을 받아 채점만 한다) — 어디서 돌려도 된다.
// GHA 러너에서는 `overfit:overfit` 형태로 부른다(.github/workflows/backtest.yml).
import { mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { buildSync } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'node_modules', '.overfit-lab')
rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })
const out = join(outDir, 'entry.cjs')

buildSync({
  entryPoints: [join(root, 'scripts', 'overfit-lab.entry.ts')],
  bundle: true,
  platform: 'node',
  outfile: out,
  logLevel: 'error',
})

// OVERFIT_LAB_RUN=1이 있을 때만 엔트리가 자동 실행된다(테스트 import 시엔 실행 안 됨).
execFileSync(process.execPath, [out], {
  stdio: 'inherit',
  env: { ...process.env, REPO_ROOT: root, OVERFIT_LAB_RUN: '1' },
})
