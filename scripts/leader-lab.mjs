// 주도주 랩 런처 — TS 러너(leader-lab.entry.ts)를 esbuild JS API로 번들해 실행한다
// (run-tests.mjs·shortterm-lab.mjs와 같은 방식 — CLI 경로는 플랫폼마다 깨진다,
//  run-tests.mjs 8~13줄 사고기록 참조).
//
//   MODE=all node scripts/leader-lab.mjs         # 12변형 전부 (GHA: leader:all)
//   MODE=next|gap|vbrk|persist                   # 같은 12변형의 부분집합
//
// 시세는 KRX 커밋 정본이라 로컬에서 돈다. 벤치(야후 KODEX 200)만 네트워크를 타며,
// 막히면 [벤치 미로딩]으로 계속 돈다 — 알파가 필요한 실행은 GHA(backtest.yml `leader:*`)에서.
import { mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { buildSync } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'node_modules', '.leader-lab')
rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })
const out = join(outDir, 'entry.cjs')

buildSync({
  entryPoints: [join(root, 'scripts', 'leader-lab.entry.ts')],
  bundle: true,
  platform: 'node',
  outfile: out,
  logLevel: 'error',
})

// LEADER_LAB_RUN=1이 있을 때만 엔트리가 자동 실행된다(테스트 import 시엔 실행 안 됨).
// SHORT_LAB_RUN·IDEA_LAB_RUN은 비워서 넘긴다 — 안 비우면 import된 shortterm/idea-lab
// 엔트리까지 같이 돈다(shortterm-lab.mjs의 관례).
execFileSync(process.execPath, [out], {
  stdio: 'inherit',
  env: { ...process.env, REPO_ROOT: root, LEADER_LAB_RUN: '1', SHORT_LAB_RUN: '', IDEA_LAB_RUN: '' },
})
