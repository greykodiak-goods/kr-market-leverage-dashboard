// 미장 전략 탐색 랩 런처 — TS 러너(us-lab.entry.ts)를 esbuild JS API로 번들해 실행한다
// (run-tests.mjs·plateau-lab.mjs·value-lab.mjs와 같은 방식 — CLI 경로는 플랫폼마다 깨진다).
//
//   MODE=xsmom    node scripts/us-lab.mjs   27차 재현 + 모멘텀 분위 민감도 (야후 필요)
//   MODE=quantile node scripts/us-lab.mjs   다섯 계열 분위 정합 검증 (야후 필요)
//   MODE=all      node scripts/us-lab.mjs   위 전부 + 종합 판정 (야후 필요)
//   MODE=quick    node scripts/us-lab.mjs   축소 격자 스모크런 (야후 필요)
//   MODE=selftest node scripts/us-lab.mjs   합성 자기검증 (파일·네트워크 불필요)
//
// 환경변수: US_UNIVERSE(80 기본 · 20) · US_PBO_MAX_COMBOS · US_FETCH_DELAY_MS(기본 120)
//
// 미장 시세는 KRX Open API 밖이라 **전량 야후**다 — selftest 말고는 전부 네트워크가 필요하다.
// 컨테이너에서 야후는 403이므로 실데이터 실행은 GHA에서 돈다
// (.github/workflows/backtest.yml · mode `us:all` 형태로 부른다).
import { mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { buildSync } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'node_modules', '.us-lab')
rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })
const out = join(outDir, 'entry.cjs')

buildSync({
  entryPoints: [join(root, 'scripts', 'us-lab.entry.ts')],
  bundle: true,
  platform: 'node',
  outfile: out,
  logLevel: 'error',
})

// US_LAB_RUN=1이 있을 때만 엔트리가 자동 실행된다(테스트 import 시엔 실행 안 됨).
execFileSync(process.execPath, [out], {
  stdio: 'inherit',
  env: { ...process.env, REPO_ROOT: root, US_LAB_RUN: '1' },
})
