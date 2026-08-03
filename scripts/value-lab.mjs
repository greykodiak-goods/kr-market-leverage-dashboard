// 밸류·퀄리티 팩터 랩 런처 — TS 러너(value-lab.entry.ts)를 esbuild JS API로 번들해 실행한다
// (run-tests.mjs·idea-lab.mjs·shortterm-lab.mjs와 같은 방식 — CLI 경로는 플랫폼마다 깨진다).
//
//   MODE=all     node scripts/value-lab.mjs   # 18변형 전부 (GHA: value:all · 벤치 KODEX 200 · QQQ 벽)
//   MODE=offline node scripts/value-lab.mjs   # 네트워크 없이 · 벤치는 유니버스 동일가중 [KODEX 200 아님]
//   MODE=hygiene node scripts/value-lab.mjs   # 재무 위생 게이트 리포트만
//
// 시세(public/data/krx-daily)·재무(public/data/dart-fundamentals)·유니버스(public/data/krx-pit)는
// 전부 **리포에 커밋된 정본**이라 네트워크가 필요 없다. 야후가 필요한 것은 벤치(069500.KS)와
// 참고 벽(QQQ·KRW=X)뿐이다 — 그래서 MODE=all의 실행 장소는 **EC2가 아니라 GHA**다
// (2026-08-02 실행 장소 규칙: 야후만 쓰는 백테스트는 GHA 러너).
import { mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { buildSync } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'node_modules', '.value-lab')
rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })
const out = join(outDir, 'entry.cjs')

buildSync({
  entryPoints: [join(root, 'scripts', 'value-lab.entry.ts')],
  bundle: true,
  platform: 'node',
  outfile: out,
  logLevel: 'error',
})

// VALUE_LAB_RUN=1이 있을 때만 엔트리가 자동 실행된다(테스트 import 시엔 실행 안 됨).
// IDEA_LAB_RUN은 비워서 넘긴다 — 넘기면 import한 idea-lab.entry.ts까지 같이 돈다.
execFileSync(process.execPath, [out], {
  stdio: 'inherit',
  env: { ...process.env, REPO_ROOT: root, VALUE_LAB_RUN: '1', IDEA_LAB_RUN: '' },
})
