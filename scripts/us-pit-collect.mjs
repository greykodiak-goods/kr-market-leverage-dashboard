// 미장 실측 PIT 유니버스 수집 런처 — TS 엔트리(us-pit-collect.entry.ts)를 esbuild
// JS API로 번들해 실행한다(run-tests.mjs·spec-backtest.mjs와 같은 방식 —
// CLI 경로는 플랫폼마다 그 파일의 정체가 달라 깨진다).
//
// 컨테이너·EC2가 아니라 **GitHub Actions 러너에서** 돌린다(en.wikipedia.org 접근 필요,
// 국내 IP·키움 키가 필요 없는 작업이므로 실행 장소 규칙상 GHA가 맞다).
//
//   US_PIT_INDEX=sp500 node scripts/us-pit-collect.mjs
//
// env: US_PIT_INDEX=sp500|ndx · US_PIT_FROM=1996 · US_PIT_TO=<올해>
//      US_PIT_REFRESH=1(캐시 무시) · US_PIT_CONTACT=<연락처> · US_PIT_OUT=<경로>
import { mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { buildSync } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'node_modules', '.us-pit-collect')
rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })
const out = join(outDir, 'entry.cjs')

buildSync({
  entryPoints: [join(root, 'scripts', 'us-pit-collect.entry.ts')],
  bundle: true,
  platform: 'node',
  outfile: out,
  logLevel: 'error',
})

execFileSync(process.execPath, [out], {
  stdio: 'inherit',
  env: { ...process.env, REPO_ROOT: root, US_PIT_COLLECT_RUN: '1' },
})
