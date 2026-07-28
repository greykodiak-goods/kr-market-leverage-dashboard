<!--
  총괄은 "코드를 다시 짜는" 방식이 아니라 이 PR diff 로 검토한다(governance/TOP-PRIORITY.md 규칙 1).
  즉 이 체크리스트가 사실상 유일한 게이트다 — 형식적으로 체크하지 말고 실제로 확인하고 채울 것.
  도메인 repo(awning-ops 등)에도 이 파일을 .github/pull_request_template.md 로 복사해 쓴다.
-->

## 무엇을 / 왜
<!-- 목표 1~2줄. 관련 지시서·백로그·이슈 링크 -->

## 어떻게 확인했나 (증빙)
<!-- 주장 말고 실제 결과. 예: web build green, vitest 42 passed, 운영 DB 실값 대조 결과 -->
- 빌드:
- 테스트:
- 운영 확인:

## 🔴 개발 기본기 (governance/TOP-PRIORITY.md 규칙 2)
> 데이터는 늘어난다고 가정한다. 해당 없으면 **비워 두지 말고 "N/A + 사유 1줄"**.

- [ ] **페이지네이션** — 새/수정 목록 조회에 상한이 있다(`.range`/`.limit`), 기본 size + 최대치 강제, 정렬키에 tie-breaker(`id`), 깊은 페이지는 커서(keyset)
- [ ] **총건수 분리** — 매 요청 `count exact` 를 같이 돌리지 않는다(`hasMore`/추정)
- [ ] **화면** — 서버 페이지네이션이다(전량 받아 프론트에서 자르지 않음). 대량 목록은 가상 스크롤
- [ ] **인덱스** — 새 `WHERE`/`ORDER BY`/`JOIN`/**FK** 조건에 인덱스를 이 PR 에서 만들었다(복합 순서 = 등치 → 범위 → 정렬)
- [ ] **인덱스 근거** — `explain analyze` 로 seq scan → index scan 전환 확인 (아래 붙임)
- [ ] **운영 테이블 인덱스**는 `create index concurrently`
- [ ] **N+1 없음** (루프 안 쿼리 → join/`.in([...])`), **`select('*')` 없음**
- N/A 항목 + 사유:

<details><summary>explain analyze 결과</summary>

```
(붙여넣기)
```
</details>

## 안전·도메인 규칙
- [ ] 마이그레이션이 **되돌릴 수 있다** / **T0 아님**(DROP·TRUNCATE·WHERE 없는 대량 DML 없음)
- [ ] 시크릿·API키 평문 없음(Doppler 경유), 브라우저 노출 0
- [ ] 고객 PII 저장·로그·익스포트 없음
- [ ] 도메인 규칙 훼손 없음(광고비 VAT ×1.1 / `isRealOrder` / `orderEffectiveDate` / `web/` 정본)
- [ ] 신규 내부 테이블 RLS = `for all to authenticated using(is_admin())` (qual=true 금지)

## 범위
- [ ] 지시 범위 밖 변경 없음(무관 파일·기회주의적 리팩토링 섞이지 않음)
- 미해결 / 다음 제안:
