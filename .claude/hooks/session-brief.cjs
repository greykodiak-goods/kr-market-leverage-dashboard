#!/usr/bin/env node
/**
 * SessionStart 훅 — "지금 이 프로젝트에서 무슨 일이 벌어지고 있나"를 세션 시작 때 자동 브리핑.
 *
 * 왜 있나 (2026-07-29 대표 질문):
 *   "여러 세션에서 프로젝트 수정할 때, 기존에 어떤 작업들이 진행되었었는지 이력 파악 어떻게 하냐?
 *    그리고 검토중인 작업 뭐뭐 있는지도 서로 공유했으면 좋겠는데"
 *
 * 설계 원칙: **사람이 갱신해야 하는 문서는 반드시 낡는다.**
 *   실제로 session-architecture.md 는 7/24 에 멈춰 있었고(5일 방치), 그 사이 세션들이
 *   서로 뭘 하는지 모른 채 중복작업을 했다. 그래서 이 브리핑은 **git 에서 자동 생성**한다.
 *   git 은 거짓말하지 않고 낡지도 않는다.
 *
 *   git 으로 못 뽑는 것(대표 결재 대기·착수 예정 등 "의도")만 context/_master/WORKBOARD.md 에
 *   수동으로 두고, 이 훅이 그 파일의 갱신 지연까지 같이 감시한다.
 *
 * 조용히 실패한다 — 어떤 이유로든 못 뽑으면 세션을 방해하지 않는다.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const DAYS = 7;
const out = [];

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

try {
  git(['rev-parse', '--git-dir']);

  let base = 'main';
  try {
    base = git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).replace(/^origin\//, '');
  } catch {
    try {
      git(['rev-parse', '--verify', 'origin/main']);
    } catch {
      base = 'master';
    }
  }

  // ── ① 최근 이력: 누가 무엇을 바꿨나 (git = 절대 낡지 않는 원본) ──────────────
  let recent = [];
  try {
    recent = git([
      'log', `origin/${base}`, `--since=${DAYS}.days`, '--no-merges',
      '--format=%ad|%s', '--date=short',
    ])
      .split('\n')
      .filter(Boolean);
  } catch {
    recent = [];
  }

  if (recent.length) {
    out.push(`📜 최근 ${DAYS}일 ${base} 변경 ${recent.length}건 (중복작업 방지 — 착수 전 확인)`);
    for (const line of recent.slice(0, 12)) {
      const [d, ...rest] = line.split('|');
      out.push(`  ${d}  ${rest.join('|').slice(0, 90)}`);
    }
    if (recent.length > 12) out.push(`  … 외 ${recent.length - 12}건 (git log 로 확인)`);
    out.push('');
  }

  // ── ② 진행 중 / 검토 대기: 미머지 브랜치 ────────────────────────────────────
  const stale = [];
  try {
    for (const line of git(['for-each-ref', '--format=%(refname:short)|%(committerdate:short)', 'refs/remotes/origin'])
      .split('\n')
      .filter(Boolean)) {
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
  } catch {
    /* noop */
  }

  if (stale.length) {
    stale.sort((a, b) => (a.date < b.date ? -1 : 1));
    out.push(`⚠️ ${base} 미머지 브랜치 ${stale.length}개 — 다른 세션이 작업 중이거나 검토 대기 중이다`);
    for (const s of stale.slice(0, 10)) out.push(`  · ${s.name} — ${s.ahead}커밋 (최종 ${s.date})`);
    if (stale.length > 10) out.push(`  … 외 ${stale.length - 10}개`);
    out.push('  → 같은 파일을 건드릴 참이면 먼저 확인해라. 메인 세션이면 머지하거나 브랜치를 지워라.');
    out.push('');
  }

  // ── ③ 사람이 적는 것: WORKBOARD (대표 결재 대기·착수 예정) ──────────────────
  try {
    const root = git(['rev-parse', '--show-toplevel']);
    let board = path.join(root, 'context/_master/WORKBOARD.md');
    if (!fs.existsSync(board)) board = path.join(root, '../ops/context/_master/WORKBOARD.md');
    if (fs.existsSync(board)) {
      const text = fs.readFileSync(board, 'utf8');
      const rows = text.split('\n').filter((l) => /^\|\s*[^|\s-]/.test(l) && !/^\|\s*(구분|상태|:?-)/.test(l));
      if (rows.length) {
        out.push(`📋 WORKBOARD 등재 ${rows.length}건 — 진행중·검토중·대표결재대기`);
        out.push('  → context/_master/WORKBOARD.md 확인. 착수하면 네 작업도 한 줄 등재해라.');
      }
      // 보드가 실제로 갱신되고 있는지 감시 (문서는 반드시 낡는다)
      try {
        const last = git(['log', '-1', '--format=%ad', '--date=short', '--', board]);
        const days = Math.floor((Date.parse(new Date().toISOString().slice(0, 10)) - Date.parse(last)) / 86400000);
        if (days >= 3) out.push(`  ⚠️ WORKBOARD 가 ${days}일째 그대로다 — 실제 상태와 어긋났을 가능성. 갱신해라.`);
      } catch {
        /* noop */
      }
      out.push('');
    }
  } catch {
    /* noop */
  }

  if (out.length) process.stdout.write(out.join('\n') + '\n');
} catch {
  // git 이 없거나 repo 가 아니면 조용히 종료
}
