// 단기매매 랩 런처 — TS 러너(shortterm-lab.entry.ts)를 esbuild JS API로 번들해 실행한다
// (run-tests.mjs·idea-lab.mjs와 같은 방식 — CLI 경로는 플랫폼마다 깨진다).
//
//   MODE=all node scripts/shortterm-lab.mjs        # 14변형 전부 (GHA: short:all)
//   MODE=close node scripts/shortterm-lab.mjs      # 종가 매수 3변형만
//   MODE=limitup|gap|bigcandle|rebound             # 같은 14변형의 부분집합
//
// ⚠️ 컨테이너에서 Yahoo는 403이다. 실데이터 실행은 GitHub Actions(backtest.yml) 러너에서.
//    이 계열은 Yahoo 일봉만 쓰므로 **EC2가 아니라 GHA**가 실행 장소다(2026-08-02 실행 장소 규칙).
import { mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { buildSync } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'node_modules', '.shortterm-lab')
rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })
const out = join(outDir, 'entry.cjs')

buildSync({
  entryPoints: [join(root, 'scripts', 'shortterm-lab.entry.ts')],
  bundle: true,
  platform: 'node',
  outfile: out,
  logLevel: 'error',
})

// SHORT_LAB_RUN=1이 있을 때만 엔트리가 자동 실행된다(테스트 import 시엔 실행 안 됨).
// IDEA_LAB_RUN은 넘기지 않는다 — 넘기면 import한 idea-lab.entry.ts까지 같이 돈다.
execFileSync(process.execPath, [out], {
  stdio: 'inherit',
  env: { ...process.env, REPO_ROOT: root, SHORT_LAB_RUN: '1', IDEA_LAB_RUN: '' },
})
