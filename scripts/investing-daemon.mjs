// 24시간 상주 모의투자 데몬 런처 — TS 엔트리(investing-daemon.entry.ts)를 esbuild JS API로
// 번들해 실행한다(mock-trade-daily.mjs 와 같은 방식 — CLI 경로는 플랫폼마다 깨진다).
//
// 표준 실행 (상주 · 기본 dryRun — 아무것도 전송하지 않는다):
//   doppler run --project investing-ops --config prd -- node scripts/investing-daemon.mjs
// 실제 모의서버 주문:
//   doppler run --project investing-ops --config prd -- node scripts/investing-daemon.mjs --live
// 단계 1회 실행(디버깅·검증):
//   node scripts/investing-daemon.mjs --once=preload|sells|confirm|buys|close
//
// mock-trade-daily.mjs 와 다른 점: 상주 프로세스라 **spawn + 시그널 전달**을 쓴다.
// execFileSync 로 띄우면 pm2 가 보낸 SIGTERM 이 부모만 죽이고 자식이 고아로 남는다.
import { mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { buildSync } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'node_modules', '.investing-daemon')
rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })
const out = join(outDir, 'entry.cjs')

buildSync({
  entryPoints: [join(root, 'scripts', 'investing-daemon.entry.ts')],
  bundle: true,
  platform: 'node',
  outfile: out,
  logLevel: 'error',
})

const child = spawn(process.execPath, [out, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: { ...process.env, REPO_ROOT: root },
})

// pm2 stop / Ctrl+C 가 데몬에 그대로 전달되게 한다(고아 프로세스 방지).
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => child.kill(sig))
}
child.on('exit', (code, signal) => {
  process.exit(signal ? 1 : code ?? 0)
})
