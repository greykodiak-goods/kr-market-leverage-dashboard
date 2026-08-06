// QQQ 배수 전략 프리셋 사전계산 런처 — TS 엔트리를 esbuild JS API로 번들해 실행한다.
//
//   node scripts/us-leverage-precompute.mjs
//
// 시세는 tiingo(종목 3개)이며 TIINGO_API_KEY가 필요하다. 산출물은
// public/data/us-leverage-precomputed.json — GHA(backtest.yml MODE=lev:bake)가 굽고 커밋한다.
// 브라우저에서 tiingo를 부르면 키가 노출되므로(규칙 2-1) 화면은 이 파일을 읽기만 한다.
import { mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { buildSync } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'node_modules', '.us-leverage-precompute')
rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })
const out = join(outDir, 'entry.cjs')

buildSync({
  entryPoints: [join(root, 'scripts', 'us-leverage-precompute.entry.ts')],
  bundle: true,
  platform: 'node',
  outfile: out,
  logLevel: 'error',
})

execFileSync(process.execPath, [out], {
  stdio: 'inherit',
  env: { ...process.env, REPO_ROOT: root, US_LEV_BAKE: '1' },
})
