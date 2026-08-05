// 동적 레버리지 사다리 러너 런처 — TS 엔트리를 esbuild JS API로 번들해 실행한다
// (us-lab.mjs·plateau-lab.mjs와 같은 방식 — CLI 경로는 플랫폼마다 깨진다).
//
//   MODE=real     node scripts/us-leverage-lab.mjs   실측 구간 격자 (판정) — 기본
//   MODE=synth    node scripts/us-leverage-lab.mjs   합성 스트레스 (닷컴·금융위기) — 참고
//   MODE=all      node scripts/us-leverage-lab.mjs   둘 다
//   MODE=selftest node scripts/us-leverage-lab.mjs   네트워크 불필요 자기검증
//
// 시세는 tiingo다(종목 4개 — 무료 티어 한도와 무관). 컨테이너에서 외부망이 막히므로
// 실데이터 실행은 GHA(.github/workflows/backtest.yml · mode `lev:real`)에서 돈다.
import { mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { buildSync } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'node_modules', '.us-leverage-lab')
rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })
const out = join(outDir, 'entry.cjs')

buildSync({
  entryPoints: [join(root, 'scripts', 'us-leverage-lab.entry.ts')],
  bundle: true,
  platform: 'node',
  outfile: out,
  logLevel: 'error',
})

// US_LEV_RUN=1이 있을 때만 엔트리가 자동 실행된다(테스트 import 시엔 실행 안 됨).
execFileSync(process.execPath, [out], {
  stdio: 'inherit',
  env: { ...process.env, REPO_ROOT: root, US_LEV_RUN: '1' },
})
