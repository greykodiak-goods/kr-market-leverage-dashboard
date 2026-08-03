// 미장 시세 소스 실사 런처 — TS 엔트리(us-source-probe.entry.ts)를 esbuild JS API로
// 번들해 실행한다(run-tests.mjs·us-pit-collect.mjs와 같은 방식 — CLI 경로는 플랫폼마다
// 그 파일의 정체가 달라 깨진다).
//
// 실행 장소 (2026-08-02 대표 지시 "실행 장소 규칙"):
//   · MODE=free   → **GitHub Actions 러너**. 야후·stooq·tiingo·alphavantage 만 쓰므로
//                   국내 IP·키움 키가 필요 없다. EC2에서 돌리지 않는다.
//   · MODE=kiwoom → **EC2**. 키움 키·국내 IP가 필요하다.
//   · MODE=all    → 둘 다 필요하므로 EC2에서만 의미가 있다.
//
//   MODE=free   node scripts/us-source-probe.mjs
//   MODE=kiwoom doppler run --project investing-ops --config prd -- node scripts/us-source-probe.mjs
//
// env: MODE=free|kiwoom|all (기본 free) · US_PROBE_SOURCES=stooq,yahoo (필터)
//      US_PROBE_TIMEOUT_MS=20000 · KIWOOM_MAX_PAGES=10
//      KIWOOM_BASE_URL=<서버>  ← 규칙 2: 실서버 주소는 코드에 두지 않는다. 필요하면 여기로만.
//
// 시크릿은 `scripts/lib/loadSecret.mjs` 하나로만 읽고 값은 출력하지 않는다(길이만).
import { mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { buildSync } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'node_modules', '.us-source-probe')
rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })
const out = join(outDir, 'entry.cjs')

buildSync({
  entryPoints: [join(root, 'scripts', 'us-source-probe.entry.ts')],
  bundle: true,
  platform: 'node',
  outfile: out,
  logLevel: 'error',
})

// 엔트리의 종료코드를 **그대로** 넘긴다. 전량 실패(exit 1)를 런처가 스택트레이스로
// 덮어쓰면 CI 로그에서 "왜 실패했는지"가 묻힌다.
try {
  execFileSync(process.execPath, [out], {
    stdio: 'inherit',
    env: { ...process.env, REPO_ROOT: root, US_SOURCE_PROBE_RUN: '1' },
  })
} catch (e) {
  process.exit(typeof e?.status === 'number' ? e.status : 1)
}
