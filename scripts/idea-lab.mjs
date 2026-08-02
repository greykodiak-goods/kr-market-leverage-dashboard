// 아이디어 랩 런처 — TS 러너(idea-lab.entry.ts)를 esbuild JS API로 번들해 실행한다
// (run-tests.mjs·spec-backtest.mjs와 같은 방식 — CLI 경로는 플랫폼마다 깨진다).
//
//   MODE=seasonal node scripts/idea-lab.mjs
//   MODE=monthpat node scripts/idea-lab.mjs
//   MODE=pairprem node scripts/idea-lab.mjs
//
// ⚠️ 컨테이너에서 Yahoo는 403이다. 실데이터 실행은 EC2/Actions 러너에서.
import { mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { buildSync } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'node_modules', '.idea-lab')
rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })
const out = join(outDir, 'entry.cjs')

buildSync({
  entryPoints: [join(root, 'scripts', 'idea-lab.entry.ts')],
  bundle: true,
  platform: 'node',
  outfile: out,
  logLevel: 'error',
})

// IDEA_LAB_RUN=1이 있을 때만 엔트리가 자동 실행된다(테스트 import 시엔 실행 안 됨).
execFileSync(process.execPath, [out], {
  stdio: 'inherit',
  env: { ...process.env, REPO_ROOT: root, IDEA_LAB_RUN: '1' },
})
