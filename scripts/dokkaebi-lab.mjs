// 42차 도깨비 랩 런처 — TS 러너(dokkaebi-lab.entry.ts)를 esbuild JS API로 번들해 실행한다
// (run-tests.mjs·plateau-lab.mjs·us-lab.mjs와 같은 방식 — CLI 경로는 플랫폼마다 깨진다).
//
//   MODE=all      node scripts/dokkaebi-lab.mjs   전체 격자 36변형 (벤치 야후 필요)
//   MODE=ma2      node scripts/dokkaebi-lab.mjs   MA2 축만 18변형   (벤치 야후 필요)
//   MODE=quick    node scripts/dokkaebi-lab.mjs   스모크런 4변형    (벤치 야후 필요)
//   MODE=selftest node scripts/dokkaebi-lab.mjs   합성 자기검증 (파일·네트워크 불필요)
//
// 환경변수: PRICE_SOURCE(기본 krx) · DOKKAEBI_PBO_MAX_COMBOS
//
// 국내 유니버스 시세는 **리포에 커밋된 KRX 일별 정본**이라 네트워크가 필요 없다.
// 야후는 **벤치(KODEX 200) 한 종목**에만 쓴다 — 컨테이너에서 야후는 403이므로
// 실데이터 실행은 GHA에서 돈다(.github/workflows/backtest.yml · mode `dokkaebi:all`).
import { mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { buildSync } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'node_modules', '.dokkaebi-lab')
rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })
const out = join(outDir, 'entry.cjs')

buildSync({
  entryPoints: [join(root, 'scripts', 'dokkaebi-lab.entry.ts')],
  bundle: true,
  platform: 'node',
  outfile: out,
  logLevel: 'error',
})

// DOKKAEBI_LAB_RUN=1이 있을 때만 엔트리가 자동 실행된다(테스트 import 시엔 실행 안 됨).
execFileSync(process.execPath, [out], {
  stdio: 'inherit',
  env: { ...process.env, REPO_ROOT: root, DOKKAEBI_LAB_RUN: '1' },
})
