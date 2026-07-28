#!/usr/bin/env node
/**
 * UserPromptSubmit 훅 — 최우선 규칙을 매 프롬프트마다 컨텍스트에 강제 주입한다.
 *
 * 왜 있나: 거버넌스 문서를 "필요할 때 읽어라"로 두면 세션이 안 읽고 그냥 넘어간다.
 * (2026-07-27 대표: "애들이 자꾸 여기 내용을 놓쳐")
 * 읽기 여부를 모델 판단에 맡기지 않고, 훅으로 매번 밀어 넣는다.
 *
 * 정본: governance/TOP-PRIORITY.md  ← 규칙을 고치면 여기 요약도 같은 커밋에서 고친다.
 * 설치: .claude/settings.json 의 hooks.UserPromptSubmit (reference/settings.hooks.json 참고)
 *
 * stdout 은 그대로 컨텍스트에 추가된다. 토큰 아끼려 6줄 이내로 유지할 것.
 */

process.stdout.write(
  [
    '[최우선 규칙 · 자동주입]',
    '1) 큰 작업(파일 5개↑ / 하위작업 2개↑ / 30분↑ / DB+API+화면 동시 / 신규기능·마이그레이션)은 직접 구현하지 말고 서브에이전트에 분담한다. 브랜치+PR 제약은 워커에만 적용된다 — 워커는 격리 워크트리에서 브랜치 push + PR까지만, 자기가 만든 걸 자기가 머지하지 않는다. 대표와 대화하는 메인 세션은 main에 바로 커밋·push 한다(워커 PR은 diff 검토 후 --ff-only 머지).',
    '2) 데이터는 늘어난다고 가정한다 — 목록 조회엔 페이지네이션(상한 강제·정렬키+id·커서 우선), 새 WHERE/ORDER BY/JOIN/FK 조건엔 인덱스를 같은 PR에서 만든다. N+1·select * 금지.',
    '   위반 예외는 "조용히 생략" 금지 — PR에 근거 1줄을 남긴다.',
    '전문·체크리스트: governance/TOP-PRIORITY.md (개발/구현/데이터 작업이면 착수 전 필독)',
  ].join('\n') + '\n'
);
