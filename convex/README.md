# convex/ — 클라우드 데이터 백엔드 운영 메모

> 정본 기획서: `stock-system-docs\convex-migration-plan.md` (2026-07-23). 이 폴더는 **소스 코드**다 —
> 데이터 스케줄 잡이 건드리지 않는다(잡은 Convex DB에만 쓴다). 프론트·convex 동시 수정은 커밋 분리.

## 배포

- 프로젝트: convex.dev `greykodiak1/stock-invest`
- 배포 명령(Git Bash): `CONVEX_DEPLOY_KEY="$(tr -d '\r\n ' < /c/Users/user/stock-system-docs/secrets/CONVEX_DEPLOY_KEY.txt)" npx convex deploy --yes`
  - **키 값은 절대 echo·로그·커밋 금지.** 키 파일은 secrets 폴더(T0) 전용.
  - ⚠️ 2026-07-24 현재 secrets의 키는 **preview 스코프** — 프로덕션 배포에는 대시보드에서
    **Production deploy key** 발급·교체 필요(T0, 대표). 그 전까지는 preview 배포로 검증:
    `npx convex deploy --yes --preview-create backend-v1`
- 검증용 preview 배포(2026-07-24): `combative-goshawk-682`
  - API: `https://combative-goshawk-682.convex.cloud` / HTTP 서빙: `https://combative-goshawk-682.convex.site`

## 환경변수 (Convex env 전용 — repo·클라이언트 번들 절대 금지)

| 이름 | 용도 | 로컬 원본(secrets) |
|---|---|---|
| `DART_API_KEY` | DART OpenAPI 수집 | `DART_API_KEY.txt` |
| `INGEST_TOKEN` | POST /ingest/* 쓰기 보호 | `CONVEX_INGEST_TOKEN.txt` |

설정: `npx convex env set NAME "$(tr -d '\r\n ' < <secrets파일>)"` (deploy key env 하에서) 또는 대시보드
Settings → Environment Variables. 확인은 `npx convex env list`로 **이름만**.

## 크론 (crons.ts — cron식은 UTC, KST=UTC+9)

| 이름 | KST | UTC cron | 내용 |
|---|---|---|---|
| dart-radar-noon | 매일 12:30 | `30 3 * * *` | DART 수집(5%룰·내부자·오버행·집중도) + 서빙 캐시 |
| dart-radar-evening | 매일 19:30 | `30 10 * * *` | 동일 — 당일 마감분 |
| cleanup | 일 03:00 | `0 18 * * 6` | jobRuns 90일 초과 삭제 |

실행 확인: `npx convex run ops:recentRuns '{"limit":5}'` 또는 대시보드 Logs.
수동 수집: `npx convex run dart:collectSupplyDemand` (멱등 — 재실행 안전).

## HTTP 엔드포인트 (`https://<deployment>.convex.site`)

- `GET /data/supply-demand.json` — 기존 `public/data/supply-demand.json`과 **스키마 동일** 서빙
  (CORS: github.io+localhost, `Cache-Control: public, max-age=600`)
- `GET /data/hynix-outlook.json` — ingest된 전망 JSON 서빙
- `POST /ingest/hynix-outlook` — 헤더 `x-ingest-token` 필수(INGEST_TOKEN). 로컬 LLM 잡 산출물 적재.

## 테이블 (schema.ts)

`dartFilings`(by_rceptNo 업서트, 영구) · `leverageSeries`(FreeSIS 예정) · `lendingSeries` ·
`holdRatioSeries` · `datasets`(통짜 JSON 최신 1건) · `jobRuns`(90일).
SEED(가상 표본)는 시계열 테이블 적재 금지 — 실측만.

## 현재 단계 (기획서 §6)

- [x] 2. 스캐폴드 배포 (preview에서 검증 완료 2026-07-24)
- [ ] 1'. **Production deploy key 교체(T0) → prod 배포 + prod env 등록** ← 다음 액션
- [ ] 3. 크론 가동 후 **로컬 잡과 1주 병행 diff** (프론트 무접촉)
- [ ] 4~5. 스키마 계약 테스트 → `src/lib/dataBase.ts`로 URL 점진 전환(폴백: Convex→정적→SEED)
- [ ] 6. 안정 2주 후 로컬 수집 잡 폐지

프론트는 아직 정적 URL 사용 중 — **이 폴더 배포는 화면에 영향 없음**(롤백 = convex/ 제거 커밋).
