# Convex Phase A 배포 가이드 (읽기 호환 백엔드)

> **이 문서에 시크릿 값을 적지 않는다.** 이름과 절차만 적는다.
> 값 입력·토큰 발급은 **대표 본인만**(T0). AI 세션에는 배포 키·DOPPLER_TOKEN을 주지 않는다.
> 근거: `ops/governance/SECRETS-POLICY.md`, 리포 CLAUDE.md 규칙 2-1.

## 0. 이 단계가 하는 일 / 안 하는 일

| | |
|---|---|
| **한다** | 정적 JSON(`public/data/**`)과 **같은 키 구조**를 주는 Convex HTTP 엔드포인트를 띄운다. |
| **한다** | 정적 파일을 읽어 Convex로 밀어 넣는 업로더(`scripts/convex-sync.mjs`)를 제공한다. |
| **안 한다** | 프론트 URL을 바꾸지 않는다. 이 배포는 **화면에 영향이 없다**. |
| **안 한다** | 기존 크론(EC2 `daily-intraday`, `paper-trading`)을 건드리지 않는다. 정적 파일이 여전히 정본이다. |
| **안 한다** | 스케줄 자동 실행. `convex-sync` 워크플로는 `workflow_dispatch` 전용이다. |

롤백은 "프론트를 안 바꿨으니 아무것도 안 해도 됨" 이다. 굳이 지우려면 새 테이블·라우트를
되돌리는 커밋 하나면 된다.

---

## 1. 배포 (대표 PC · Git Bash)

이 리포의 Convex 프로젝트는 이미 존재한다(`greykodiak1/stock-invest`, prod 배포 `valiant-vole-735`).
**새 프로젝트를 만들지 말고 기존 배포에 함수만 올린다.**

```bash
cd <repo>
npx convex login          # 최초 1회. 브라우저 인증 (T0 — 대표 본인)
npx convex deploy --yes   # convex/ 의 스키마·함수·HTTP 라우트를 prod에 반영
```

- Deploy key는 리포의 `.env.local`(gitignore)에서 CLI가 자동으로 읽는다. **키 값은 echo·로그·커밋 금지.**
- 배포되면 새 테이블 `intradayMeta` / `intradayBars` / `paperTracks` 가 생성된다.
  기존 테이블(`dartFilings`, `datasets`, …)은 건드리지 않는다.
- 확인: `npx convex env list` (이름만 나온다) / 대시보드 → Data 탭에 새 테이블 3개.

### 배포 후 스모크 테스트

데이터를 아직 안 넣었으므로 **404가 정상**이다(정직한 404 — 프론트 폴백 체인이 받는다).

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://<deployment>.convex.site/data/intraday/index.json
# → 404 (아직 비어 있음). 500이 나오면 배포가 잘못된 것.
```

---

## 2. Convex 환경변수 (대시보드에서 대표가 직접 · T0)

Convex 대시보드 → 해당 배포 → **Settings → Environment Variables**

| 이름 | 용도 | 비고 |
|---|---|---|
| `INGEST_SECRET` | `POST /ingest/*` 쓰기 보호 | 이미 `INGEST_TOKEN`이 등록돼 있으면 **그대로 두고 새로 만들지 않아도 된다** — 코드가 둘 다 받는다 |
| `DART_API_KEY` | (기존) DART 수집 | Phase A와 무관 |

값은 충분히 긴 난수 문자열이면 된다. **이 문서·커밋·로그에 값을 남기지 않는다.**

---

## 3. Doppler 등록 (`investing-ops` / `prd` · 값 입력은 대표만 T0)

업로더가 읽는 시크릿은 **이름 두 개**뿐이다.

| Doppler 이름 | 값 | 설명 |
|---|---|---|
| `CONVEX_URL` | `https://<deployment>.convex.site` | ⚠️ **`.convex.site`** 다. `.convex.cloud`(함수 API)를 넣어도 스크립트가 교정하고 경고하지만, 처음부터 `.site`로 넣는 것이 맞다 |
| `CONVEX_INGEST_SECRET` | 2번에서 넣은 `INGEST_SECRET`과 **같은 값** | 다르면 401 |

실행:

```bash
doppler run --project investing-ops --config prd -- node scripts/convex-sync.mjs --dry-run
```

`--dry-run`은 네트워크 전송 없이 "몇 건 보낼지"만 출력한다. 로그에는 시크릿 **출처와 길이**만
남고 값은 어떤 경로로도 나오지 않는다(`scripts/lib/loadSecret.mjs` 강제, `tests/loadsecret.test.ts` 검증).

---

## 4. 최초 적재 (백필) → 이후 증분

```bash
# 1) 백필 — 종목당 ~9요청 × 80종목 + 페이퍼 4건 ≒ 725요청, 수 분 소요
doppler run --project investing-ops --config prd -- node scripts/convex-sync.mjs

# 2) 이후 증분 — 종목당 1요청 ≒ 81요청 (5분봉은 하루 78개라 500봉이면 충분히 겹친다)
doppler run --project investing-ops --config prd -- node scripts/convex-sync.mjs --recent=500
```

업서트는 `[symbol, t]` 기준으로 **멱등**하다 — 같은 구간을 몇 번 다시 밀어도 값이 같으면
쓰기가 발생하지 않는다. 중단됐으면 그냥 다시 실행하면 된다.

기타 옵션: `--only=005930.KS,000660.KS` / `--skip-intraday` / `--skip-paper`

---

## 5. 적재 후 검증 (여기까지 통과해야 "완료")

```bash
D=https://<deployment>.convex.site

# 인덱스 — 정적 파일과 키 구조가 같아야 한다
curl -s "$D/data/intraday/index.json" | head -c 400

# 개별 심볼 — 기본 최근 500봉
curl -s "$D/data/intraday/000660.KS.json" | node -e "
  let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
    const j=JSON.parse(s);
    console.log('keys', Object.keys(j));
    console.log('bars', j.bars.ts.length, 'page', j.page);
  })"

# 커서 이어받기 — page.nextFrom 을 ?from= 에 넣으면 다음 페이지
curl -s "$D/data/intraday/000660.KS.json?from=1777852800&limit=100" | head -c 200

# 페이퍼 트랙
curl -s "$D/data/paper/all80.json" | head -c 200
```

정적 파일과의 대조(권장 · 병행 검증 1주):

```bash
diff <(curl -s "$D/data/paper/all80.json") public/data/paper/all80.json && echo "일치"
```

> 5분봉 개별 심볼은 **페이지네이션 때문에 전량 비교가 안 된다** — 응답에 `page` 키가 추가되고
> 기본 500봉만 온다. 전량 비교가 필요하면 `?from=0&limit=2000`을 `page.nextFrom`이 null이 될
> 때까지 이어 받아 합친 뒤 비교한다.

---

## 6. GitHub Actions 연동 (선택 · 기본 비활성)

`.github/workflows/convex-sync.yml` 은 **`workflow_dispatch` 전용**이고 스케줄이 없다.
리포 시크릿 `CONVEX_URL` / `CONVEX_INGEST_SECRET` 이 없으면 명시적으로 스킵한다.

1. 리포 → Settings → Secrets and variables → Actions → New repository secret (**대표 T0**)
   - `CONVEX_URL`, `CONVEX_INGEST_SECRET` (3번과 같은 값)
2. Actions 탭 → `convex-sync` → Run workflow (`recent=500`, `dry_run` 체크로 먼저 확인)
3. 자동화까지 원하면 워크플로 상단 주석의 `schedule` 블록을 켠다
   (평일 07:45 UTC = 16:45 KST — EC2 5분봉 증분 크론 `daily-intraday`(16:15 KST)가
   커밋을 푸시한 뒤. 2026-08-03 이전에는 GHA `intraday-cron`이 그 자리였다).
   **이건 병행 검증이 끝난 뒤에 한다.**

---

## 7. 프론트 URL 교체 지점 (Phase B — 이번 범위 아님)

현재 프론트가 `public/data`를 직접 읽는 곳은 아래가 전부다. 전환 시 **폴백 체인
(Convex → 정적 → SEED)** 을 유지한 채 하나씩 옮긴다.

| 파일 | 라인(2026-07-30 기준) | 현재 | 전환 후 |
|---|---|---|---|
| `src/lib/data.ts` | `loadJson()` — `${BASE}data/${file}` | 레버리지·수급 등 대부분의 JSON이 이 함수를 탄다 | 이 **한 곳**에 Convex 베이스 URL과 폴백을 넣는 것이 가장 싸다 |
| `src/features/backtest/SpecSimulator.tsx` | 479 | `${BASE}data/intraday/index.json` | `${CONVEX}/data/intraday/index.json` |
| `src/features/flow-radar/supplyDemand.ts` | 10 | `BASE` 상수 | 이미 Convex에 `/data/supply-demand.json` 있음 |
| `src/features/scenario-outlook/outlook.ts` | 25 | `BASE` 상수 | 이미 Convex에 `/data/hynix-outlook.json` 있음 |
| `src/features/mega-investors/megaInvestors.ts` | 52 | `BASE` 상수 | Phase A 범위 밖(아직 Convex에 없음) |

> **개별 심볼 5분봉을 프론트에서 쓰게 될 때 주의**: Convex 응답은 기본 최근 500봉이다.
> 전량이 필요하면 `page.nextFrom`으로 이어 받는 루프를 클라이언트에 넣어야 한다
> (상한 없는 전체 조회는 금지 — ops 최우선 가이드 규칙 2).
>
> 페이퍼 트랙 JSON(`public/data/paper/*.json`)은 **현재 프론트에서 읽는 코드가 없다**
> (크론 산출물만 존재). 화면에 붙일 때 Convex URL로 바로 시작하면 된다.

---

## 8. 대표 확인이 필요한 항목 (T0 요약)

- [ ] `npx convex login` → `npx convex deploy --yes` (배포 키 취급)
- [ ] Convex 대시보드에 `INGEST_SECRET` 값 입력 (또는 기존 `INGEST_TOKEN` 유지 확인)
- [ ] Doppler `investing-ops/prd`에 `CONVEX_URL`, `CONVEX_INGEST_SECRET` 값 입력
- [ ] (선택) 리포 Actions 시크릿 등록
- [ ] (선택) 병행 검증 후 `convex-sync.yml` 의 `schedule` 활성화

## 9. 참고

- 엔드포인트·테이블 요약: `convex/README.md`
- 서빙·커서 로직의 순수 함수: `convex/lib/intradayServe.ts` (테스트: `tests/convex-sync.test.ts`)
- 시크릿 표준: `ops/governance/SECRETS-POLICY.md`, 리포 CLAUDE.md 규칙 2-1
