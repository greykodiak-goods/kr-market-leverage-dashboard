#!/usr/bin/env node
/**
 * SessionStart 훅 — git 훅을 세션마다 자동 설치한다.
 *
 * 왜 있나: githooks/ 는 repo 에 커밋돼 있어도 `git config core.hooksPath githooks` 를
 * 안 하면 동작하지 않는다. 새 clone·새 PC·클라우드 세션마다 사람이 기억해서 쳐야 하는데,
 * 그게 바로 안 되는 지점이다. 세션 시작 때 자동으로 건다.
 *
 * 조용히 성공한다(정상이면 출력 없음). 이미 설정돼 있으면 아무것도 하지 않는다.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

try {
  git(['rev-parse', '--git-dir']); // git repo 가 아니면 여기서 throw

  // ⚠️ 훅 디렉터리가 없는데 core.hooksPath 를 걸면 기존 .git/hooks(husky 등)가 조용히 무력화된다.
  // 실제로 확인한 회귀 — 디렉터리가 실재할 때만 건다.
  //
  // 이름이 둘인 이유: 정적 호스팅(Cloudflare Pages)이 리포 루트를 그대로 서빙하는 repo 에서는
  // 루트 `githooks/` 가 공개 URL 로 노출된다. 그런 repo 는 `.githooks/`(dot 디렉터리)를 쓴다.
  const root = git(['rev-parse', '--show-toplevel']);
  const dir = ['githooks', '.githooks'].find((d) => fs.existsSync(path.join(root, d)));
  if (!dir) {
    process.exit(0); // 이 repo 엔 아직 훅이 없다 — 아무것도 건드리지 않는다
  }

  let current = '';
  try {
    current = git(['config', '--get', 'core.hooksPath']);
  } catch {
    current = '';
  }
  if (current !== dir) {
    git(['config', 'core.hooksPath', dir]);
    process.stdout.write(`[setup] git 훅 설치됨 (core.hooksPath=${dir}) — 워커의 main 직접 커밋 차단 활성\n`);
  }
} catch {
  // git repo 가 아니거나 git 이 없으면 조용히 넘어간다 — 세션을 깨뜨리지 않는다
}
