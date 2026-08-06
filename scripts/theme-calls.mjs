// 테마 콜 기록 트랙 런처 — TS 엔트리를 esbuild JS API로 번들해 실행한다.
//
//   MODE=add  CALL_ID=… CALL_THESIS=… …  node scripts/theme-calls.mjs
//   MODE=score                            node scripts/theme-calls.mjs   (tiingo 키 필요)
//
// 대장 public/data/theme-calls.json 은 **손으로 쓰는 원본**,
// 산출 public/data/theme-calls-scored.json 은 **기계가 굽는 채점표**다.
// 섞으면 채점 결과를 손으로 고칠 수 있게 되고 그 순간 이 트랙의 의미가 사라진다.
import { mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { buildSync } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'node_modules', '.theme-calls')
rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })
const out = join(outDir, 'entry.cjs')

buildSync({
  entryPoints: [join(root, 'scripts', 'theme-calls.entry.ts')],
  bundle: true,
  platform: 'node',
  outfile: out,
  logLevel: 'error',
})

execFileSync(process.execPath, [out], {
  stdio: 'inherit',
  env: { ...process.env, REPO_ROOT: root, THEME_CALLS_RUN: '1' },
})
