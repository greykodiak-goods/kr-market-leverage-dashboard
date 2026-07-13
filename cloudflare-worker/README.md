# 자체 CORS 프록시 (Cloudflare Worker) — 대체안(현재 미사용)

> **현재는 Supabase Edge Function 프록시를 1순위로 사용 중입니다**
> (`src/lib/proxyConfig.ts`의 `CUSTOM_PROXY`).
> 이 Cloudflare Worker 코드는 **대체안**으로 repo에 보관합니다. Supabase 프록시에
> 문제가 생기면 아래 절차로 배포해 `CUSTOM_PROXY`만 교체하면 됩니다.

---


대시보드가 Yahoo Finance·Google 뉴스 등 브라우저 CORS를 막는 API를 호출할 수 있게 해주는
**스코프 제한 프록시**입니다. 공개 프록시(cors.sh 등)가 속도제한에 걸릴 때를 대비한 안정적인 1순위 경로입니다.

- 허용 대상 호스트: `query1/query2.finance.yahoo.com`, `news.google.com`, `api.gdeltproject.org`, `stooq.com` (그 외 403)
- 허용 Origin: `https://greykodiak-goods.github.io` + localhost (그 외 브라우저 요청 403)
- 짧은 캐시(60초)

---

## 방법 A — Cloudflare 대시보드 (권장, 5분)

1. https://dash.cloudflare.com 로그인 (greykodiak1@gmail.com)
2. 왼쪽 메뉴 **Workers & Pages** → **Create application** → **Create Worker**
3. 이름 입력(예: `kr-market-proxy`) → **Deploy** (기본 코드로 일단 생성)
4. 생성 후 **Edit code** 클릭 → 편집기의 기존 코드를 **전부 지우고**,
   이 폴더의 [`proxy.js`](./proxy.js) 내용을 **통째로 붙여넣기**
5. 우측 상단 **Deploy** 클릭
6. 배포되면 상단에 `https://kr-market-proxy.<서브도메인>.workers.dev` 형태의 **URL이 생김 → 복사**
7. 그 URL을 총괄에게 전달 → 총괄이 `src/lib/proxyConfig.ts`의 `CUSTOM_PROXY`에 넣고 재배포하면 끝.

동작 확인(브라우저 주소창):
```
https://kr-market-proxy.<서브도메인>.workers.dev/?url=https%3A%2F%2Fquery1.finance.yahoo.com%2Fv8%2Ffinance%2Fchart%2F000660.KS%3Frange%3D1d%26interval%3D1d
```
→ JSON이 보이면 성공. (허용 안 된 host를 넣으면 403이 정상)

---

## 방법 B — Wrangler CLI (선택)

```bash
cd cloudflare-worker
npx wrangler login
npx wrangler deploy
```
배포 후 출력되는 `*.workers.dev` URL을 사용합니다.

---

## 연동 (총괄이 수행)

`src/lib/proxyConfig.ts`:
```ts
export const CUSTOM_PROXY = 'https://kr-market-proxy.<서브도메인>.workers.dev/?url='
```
- 이 한 줄만 채우면 시세(quotes.ts)·뉴스(news.ts) 프록시 배열의 **1순위**로 자동 사용됩니다.
- 비워두면(`''`) 기존 공개 프록시(cors.sh → allorigins → codetabs)만 사용합니다.
- 커밋 후 `main` push + gh-pages 재배포.

## 프록시 폴백 순서 (config 반영 후)

1. **CUSTOM_PROXY** (Cloudflare Worker, 설정된 경우)
2. cors.sh
3. allorigins
4. codetabs
5. (시세) direct
