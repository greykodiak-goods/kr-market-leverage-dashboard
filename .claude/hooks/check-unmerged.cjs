#!/usr/bin/env node
/**
 * SessionStart 훅 — 기본 브랜치에 머지되지 않은 작업 브랜치를 세션 시작 때 알린다.
 *
 * 왜 있나 (2026-07-29 대표 지적 "전체 세션들이 브랜치 작업분을 마스터에 머지 안 하고 있다"):
 * 규칙은 "워커는 브랜치+PR까지, 머지는 메인 세션이" 였는데 **머지를 누가 언제 하는지**가
 * 없어서 아무도 안 했다. 실제 피해:
 *   - awning-ops PR #41 이 23일간 방치("셀프 머지 안 함, 확인 후 머지 바랍니다"라고 적힌 채)
 *   - ops 브랜치 3개는 PR 조차 없어 GitHub UI 에도 안 보였다
 *   - 그중 하나(개인정보 조항 완화)는 머지가 안 된 탓에 main 에 없었고,
 *     2026-07-29 메인 세션이 같은 문제를 처음부터 다시 풀었다 = 중복작업 실증
 *
 * 사람이 "PR 큐 봐야지" 하고 기억하는 것에 의존하지 않는다. 세션이 열릴 때마다 들이민다.
 * 조용히 성공한다(미머지 0건이면 출력 없음).
 */

const { execFileSync } = require('child_process');

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

try {
  git(['rev-parse', '--git-dir']); // git repo 가 아니면 throw

  // 기본 브랜치 판별 (main/master 혼재 — realestate-auction 은 master)
  let base = 'main';
  try {
    base = git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).replace(/^origin\//, '');
  } catch {
    try {
      git(['rev-parse', '--verify', 'origin/main']);
      base = 'main';
    } catch {
      base = 'master';
    }
  }

  const refs = git(['for-each-ref', '--format=%(refname:short)|%(committerdate:short)', 'refs/remotes/origin'])
    .split('\n')
    .filter(Boolean);

  const stale = [];
  for (const line of refs) {
    const [ref, date] = line.split('|');
    const name = ref.replace(/^origin\//, '');
    if (name === 'HEAD' || name === base) continue;
    let ahead = 0;
    try {
      ahead = parseInt(git(['rev-list', '--count', `origin/${base}..${ref}`]), 10) || 0;
    } catch {
      continue;
    }
    if (ahead > 0) stale.push({ name, ahead, date });
  }

  if (!stale.length) process.exit(0);

  stale.sort((a, b) => (a.date < b.date ? -1 : 1)); // 오래된 것 먼저
  const lines = stale
    .slice(0, 10)
    .map((s) => `  · ${s.name} — ${s.ahead}커밋 미머지 (최종 ${s.date})`);
  const more = stale.length > 10 ? `  … 외 ${stale.length - 10}개\n` : '';

  process.stdout.write(
    `⚠️ ${base} 에 머지되지 않은 브랜치 ${stale.length}개\n` +
      lines.join('\n') +
      '\n' +
      more +
      '메인 세션이면 지금 처리해라 — diff 검토 후 머지하거나, 폐기할 것이면 브랜치를 지워라.\n' +
      '방치하면 (a) main 이 앞서가며 충돌이 커지고 (b) 다른 세션이 같은 일을 다시 한다(실제 발생).\n'
  );
} catch {
  // git repo 가 아니거나 git 이 없으면 조용히 넘어간다 — 세션을 깨뜨리지 않는다
}
