#!/usr/bin/env node
/**
 * PostToolUse 훅 (matcher: Edit|Write|MultiEdit) — 개발 기본기 위반을 기계적으로 잡아 되먹인다.
 *
 * 왜 PostToolUse 인가: PreToolUse 로 막으면 오탐 하나에 작업이 멈춘다.
 * 여기선 편집은 통과시키되, 위반 의심이면 exit 2 + stderr 로 Claude 에게 경고를 되먹여
 * 같은 턴 안에서 고치게 한다. (exit 0 = 조용히 통과)
 *
 * 정본 규칙: governance/TOP-PRIORITY.md 규칙 2
 * 설치: .claude/settings.json 의 hooks.PostToolUse (reference/settings.hooks.json 참고)
 *
 * 휴리스틱이라 오탐이 있을 수 있다 — 경고지 판결이 아니다.
 * 근거가 있으면 "예외 + 근거 1줄"을 남기고 진행하면 된다.
 */

let raw = '';
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', () => {
  let payload;
  try {
    payload = JSON.parse(raw || '{}');
  } catch {
    process.exit(0); // 훅이 작업을 깨뜨리지 않는다
  }

  const input = payload.tool_input || {};
  const toolName = String(payload.tool_name || '');

  // 파일 편집만 보면 구멍이 난다: 이 조직은 스키마를 파일이 아니라 Supabase MCP 로 직접 넣는다.
  // apply_migration/execute_sql 의 query 도 SQL 로 취급해 같은 규칙을 건다.
  const isDbTool = /^mcp__[Ss]upabase__(apply_migration|execute_sql)$/.test(toolName);

  const filePath = isDbTool
    ? `${toolName}(${input.name || 'query'})`
    : String(input.file_path || '');
  if (!filePath) process.exit(0);

  // 편집으로 "새로 들어간" 텍스트만 본다 (기존 코드 전체를 훈계하지 않기 위해)
  const added = isDbTool
    ? String(input.query || '')
    : [
        input.content,
        input.new_string,
        ...(Array.isArray(input.edits) ? input.edits.map((e) => e && e.new_string) : []),
      ]
        .filter(Boolean)
        .join('\n');
  if (!added.trim()) process.exit(0);

  // 주석은 코드가 아니다 — 주석·JSDoc·주석처리된 코드에서 오탐이 난다
  // (실제로 이 파일 자신의 설명 주석이 오탐을 냈다). URL 의 "//" 는 남긴다.
  const stripComments = (src) =>
    src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:"'`\\])\/\/[^\n]*/g, '$1');

  const warnings = [];
  const isSql = isDbTool || /\.sql$/i.test(filePath) || /migrations?[\\/]/i.test(filePath);
  const isCode = !isDbTool && /\.(ts|tsx|js|jsx|mjs|cjs)$/i.test(filePath);

  // --- 규칙 2-2: 인덱스 ---
  if (isSql) {
    const sql = added.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, '');
    const createsTable = /create\s+table/i.test(sql);
    const hasIndex = /create\s+(unique\s+)?index/i.test(sql);
    if (createsTable && !hasIndex) {
      warnings.push(
        'CREATE TABLE 인데 CREATE INDEX 가 없다. WHERE/ORDER BY/JOIN/FK 컬럼 인덱스를 같은 마이그레이션에 넣어라(Postgres 는 FK 인덱스를 자동 생성하지 않는다).'
      );
    }
    if (/create\s+index/i.test(sql) && !/concurrently/i.test(sql)) {
      warnings.push(
        '운영 테이블 인덱스는 CREATE INDEX CONCURRENTLY 로 만들어라 — 일반 CREATE INDEX 는 테이블을 락 건다. (신규 빈 테이블이면 무시)'
      );
    }
    if (/\b(drop\s+(table|column)|truncate)\b/i.test(sql) || /delete\s+from(?![\s\S]{0,200}\bwhere\b)/i.test(sql)) {
      warnings.push(
        '⛔ 되돌릴 수 없는 DDL/DML 로 보인다(DROP·TRUNCATE·WHERE 없는 DELETE). 이건 T1 이 아니라 T0 — 자동 실행 금지, dry-run/롤백 스크립트까지만 만들고 대표 확인을 받아라.'
      );
    }
  }

  // --- 규칙 2-1: 페이지네이션 / 2-3: N+1·select * ---
  if (isCode) {
    const code = stripComments(added);
    // supabase 스타일 쿼리 체인에 상한이 없는 경우.
    // .range()/.limit() 는 .select() 뒤에 붙으므로 "구문 끝까지"를 검사창으로 잡는다
    // (세미콜론 또는 빈 줄까지, 최대 600자).
    const selectRe = /\.select\s*\(/g;
    let m;
    while ((m = selectRe.exec(code)) !== null) {
      const tail = code.slice(m.index, m.index + 600);
      const end = tail.search(/;|\n\s*\n/);
      const stmt = end === -1 ? tail : tail.slice(0, end);
      const bounded = /\.(range|limit|single|maybeSingle)\s*\(/.test(stmt);
      const isCount = /count\s*:/.test(stmt);
      if (!bounded && !isCount) {
        warnings.push(
          '상한 없는 목록 조회로 보인다(.range/.limit 없음). 페이지네이션을 붙여라 — 기본 size + 최대치 강제, 정렬키에 tie-breaker(id), 깊은 페이지는 커서(keyset). 소규모 고정 테이블이라 생략한다면 근거 1줄을 코드/PR 에 남겨라.'
        );
        break;
      }
    }
    if (/\.select\(\s*['"`]\*['"`]\s*\)/.test(code)) {
      warnings.push("select('*') 대신 필요한 컬럼만 지정해라(넓은 행 × 많은 건수 = 네트워크·메모리 비용).");
    }
    // 루프 안 await 쿼리 = N+1 냄새
    if (/for\s*\([^)]*\)\s*\{[\s\S]{0,300}?await[\s\S]{0,120}?\.(from|select|query)\(/.test(code)) {
      warnings.push('루프 안에서 쿼리를 날리는 N+1 패턴으로 보인다. join 또는 .in([...]) 배치 조회로 바꿔라.');
    }
  }

  if (!warnings.length) process.exit(0);

  process.stderr.write(
    `⚠️ 개발 기본기 체크 (governance/TOP-PRIORITY.md 규칙 2) — ${filePath}\n` +
      warnings.map((w) => `  - ${w}`).join('\n') +
      '\n지금 이 턴에서 고치거나, 해당 없으면 "예외 + 근거" 한 줄을 남기고 진행해라.\n'
  );
  process.exit(2); // stderr 를 Claude 에게 되먹인다 (작업은 이미 적용됨)
});
