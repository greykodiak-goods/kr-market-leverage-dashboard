// tests/*.test.ts 를 esbuild로 번들해 순차 실행한다.
// 외부 테스트 러너 의존 없이 `npm test` 한 줄로 엔진 불변식을 검증한다.

import { readdirSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
// esbuild를 **JS API로** 부른다. CLI 경로로 부르면 플랫폼마다 그 파일의 정체가
// 달라 깨진다 — Windows에서는 node_modules/.bin/esbuild가 확장자 없는 셸
// 스크립트라 execFileSync로 스폰이 안 되고, Linux에서는 esbuild/bin/esbuild가
// JS 셔임이 아니라 ELF 네이티브 바이너리라 node로 실행하면 "Invalid or
// unexpected token"이 난다. 두 번 다 같은 자리에서 났다.
// JS API는 Node의 모듈 해석을 타므로 플랫폼과 무관하게 동작한다.
import { buildSync } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const testsDir = join(root, 'tests')
const outDir = join(root, 'node_modules', '.test-build')

rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })

const files = readdirSync(testsDir).filter((f) => f.endsWith('.test.ts')).sort()
if (files.length === 0) {
  console.error('테스트 파일이 없습니다 (tests/*.test.ts)')
  process.exit(1)
}

let failed = 0
for (const f of files) {
  const out = join(outDir, f.replace(/\.ts$/, '.cjs'))
  console.log(`\n=== ${f} ===`)
  try {
    buildSync({
      entryPoints: [join(testsDir, f)],
      bundle: true,
      platform: 'node',
      outfile: out,
      logLevel: 'error',
    })
  } catch (e) {
    console.error(`번들 실패: ${f} — ${e?.message ?? e}`)
    failed++
    continue
  }
  try {
    // REPO_ROOT를 넘긴다 — 번들 산출물은 node_modules/.test-build 아래에서 돌기 때문에
    // 테스트가 __dirname으로 리포 루트를 잡으면 node_modules를 스캔하게 된다(실제로 그랬다).
    execFileSync(process.execPath, [out], { stdio: 'inherit', env: { ...process.env, REPO_ROOT: root } })
  } catch {
    failed++
  }
}

console.log(failed === 0 ? '\n✅ 전체 테스트 통과' : `\n❌ ${failed}개 테스트 파일 실패`)
process.exit(failed === 0 ? 0 : 1)
