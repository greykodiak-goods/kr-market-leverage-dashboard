// tests/*.test.ts 를 esbuild로 번들해 순차 실행한다.
// 외부 테스트 러너 의존 없이 `npm test` 한 줄로 엔진 불변식을 검증한다.

import { readdirSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const testsDir = join(root, 'tests')
const outDir = join(root, 'node_modules', '.test-build')
// esbuild는 JS bin 엔트리를 node로 직접 실행한다 — Windows에서
// 확장자 없는 .bin 셸 스크립트는 execFileSync로 실행되지 않는다.
const esbuildJs = join(root, 'node_modules', 'esbuild', 'bin', 'esbuild')

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
    execFileSync(process.execPath, [esbuildJs, join(testsDir, f), '--bundle', '--platform=node', `--outfile=${out}`], {
      stdio: ['ignore', 'ignore', 'inherit'],
    })
  } catch {
    console.error(`번들 실패: ${f}`)
    failed++
    continue
  }
  try {
    execFileSync(process.execPath, [out], { stdio: 'inherit' })
  } catch {
    failed++
  }
}

console.log(failed === 0 ? '\n✅ 전체 테스트 통과' : `\n❌ ${failed}개 테스트 파일 실패`)
process.exit(failed === 0 ? 0 : 1)
