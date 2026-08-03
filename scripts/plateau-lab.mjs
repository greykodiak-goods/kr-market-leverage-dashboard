// 고원(plateau) 랩 런처 — TS 러너(plateau-lab.entry.ts)를 esbuild JS API로 번들해 실행한다
// (run-tests.mjs·value-lab.mjs·overfit-lab.mjs와 같은 방식 — CLI 경로는 플랫폼마다 깨진다).
//
//   MODE=plateau  node scripts/plateau-lab.mjs   전체 격자 (벤치 KODEX 200 · 야후 필요)
//   MODE=quick    node scripts/plateau-lab.mjs   축소 격자 스모크런 (야후 필요)
//   MODE=offline  node scripts/plateau-lab.mjs   전체 격자 · 벤치=유니버스 동일가중 (네트워크 불필요)
//   MODE=selftest node scripts/plateau-lab.mjs   합성 자기검증 (파일·네트워크 불필요)
//
// 환경변수: PRICE_SOURCE(기본 krx) · KRX_WIDTH(기본 10x10, 예 40x40) · PLATEAU_PBO_MAX_COMBOS
//
// 국내 시세·유니버스는 리포에 커밋된 정본을 읽으므로 네트워크가 필요 없다. 야후가 필요한 것은
// **벤치(069500.KS)와 참고 벽(QQQ·KRW=X)**뿐이다 — 그래서 MODE=plateau/quick은 GHA에서,
// MODE=offline/selftest는 어디서든 돈다.
// GHA 러너에서는 `plateau:plateau` 형태로 부른다(.github/workflows/backtest.yml).
import { mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { buildSync } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'node_modules', '.plateau-lab')
rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })
const out = join(outDir, 'entry.cjs')

buildSync({
  entryPoints: [join(root, 'scripts', 'plateau-lab.entry.ts')],
  bundle: true,
  platform: 'node',
  outfile: out,
  logLevel: 'error',
})

// PLATEAU_LAB_RUN=1이 있을 때만 엔트리가 자동 실행된다(테스트 import 시엔 실행 안 됨).
execFileSync(process.execPath, [out], {
  stdio: 'inherit',
  env: { ...process.env, REPO_ROOT: root, PLATEAU_LAB_RUN: '1' },
})
