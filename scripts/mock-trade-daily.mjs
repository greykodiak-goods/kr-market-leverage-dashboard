// 모의투자 일일 운용 러너 런처 — TS 엔트리(mock-trade-daily.entry.ts)를 esbuild JS API로
// 번들해 실행한다(spec-backtest.mjs 와 같은 방식 — CLI 경로는 플랫폼마다 깨진다).
//
// 표준 실행 (기본 dryRun — 아무것도 전송하지 않는다):
//   doppler run --project investing-ops --config prd -- node scripts/mock-trade-daily.mjs
// 실제 모의서버 주문:
//   doppler run --project investing-ops --config prd -- node scripts/mock-trade-daily.mjs --live
import { mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { buildSync } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'node_modules', '.mock-trade-daily')
rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })
const out = join(outDir, 'entry.cjs')

buildSync({
  entryPoints: [join(root, 'scripts', 'mock-trade-daily.entry.ts')],
  bundle: true,
  platform: 'node',
  outfile: out,
  logLevel: 'error',
})

try {
  execFileSync(process.execPath, [out, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: { ...process.env, REPO_ROOT: root },
  })
} catch (e) {
  // 자식 프로세스가 이미 원인을 출력했다 — 런처 스택으로 로그를 덮지 않는다.
  process.exit(e?.status ?? 1)
}
