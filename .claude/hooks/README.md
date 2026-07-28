# .claude/hooks — 최우선 규칙 강제 훅 (ops 정본의 **사본**)

## 정본은 여기가 아니다
이 디렉터리의 `.js` 3개는 **`ops` repo `hooks/`의 사본**이다. 규칙이 바뀌면
**ops에서 먼저 고치고 여기로 복사**한다. 여기서 직접 고치면 repo마다 다른 규칙이 돌아간다.

```bash
cp <ops>/hooks/inject-core-rules.cjs <ops>/hooks/check-dev-baseline.cjs <ops>/hooks/install-githooks.cjs .claude/hooks/
cp <ops>/githooks/pre-commit .githooks/pre-commit
```

- 규칙 정본: `ops/governance/TOP-PRIORITY.md`
- 갱신 절차: `ops/governance/GOVERNANCE-README.md`의 "규칙 바뀔 때 갱신 절차" 0번

## 왜 사본을 두나
훅 `command`는 절대경로나 `$CLAUDE_PROJECT_DIR` 기준 경로여야 하는데, ops clone 위치는
PC마다 다르다(`/home/user/ops` vs `C:/Users/user/ops`). 사본을 repo 안에 두면
`$CLAUDE_PROJECT_DIR/.claude/hooks/...`로 어느 환경에서든 동작한다 — 설치 절차 0단계.

## 왜 `.githooks/`인가 (`githooks/`가 아니라)
도메인 repo 공통 규약이다. `.github`처럼 dot 디렉터리로 두어 루트를 어지럽히지 않고,
정적 호스팅이 리포 루트를 그대로 서빙하는 repo(awning-ops)에서 공개 URL로 노출되는 것도 막는다.
`install-githooks.cjs`가 `githooks/`·`.githooks/` 둘 다 인식한다(ops repo 는 `githooks/` 사용).

## 각 훅이 하는 일
| 훅 | 시점 | 하는 일 |
|---|---|---|
| `install-githooks.cjs` | SessionStart | `core.hooksPath`를 자동 설정(디렉터리 실재 시에만 — 기존 `.git/hooks` 무력화 방지) |
| `inject-core-rules.cjs` | UserPromptSubmit | 최우선 규칙 2개를 매 프롬프트 컨텍스트에 주입 |
| `check-dev-baseline.cjs` | PostToolUse | 페이지네이션·인덱스·N+1·파괴적DML 위반을 편집/마이그레이션 직후 되먹임(exit 2) |

`check-dev-baseline`은 파일 편집뿐 아니라 **Supabase MCP `apply_migration`·`execute_sql`도** 검사한다
— 이 조직은 스키마를 파일이 아니라 MCP로 넣기 때문에 파일만 보면 구멍이 난다.
