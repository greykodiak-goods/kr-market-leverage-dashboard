# `public/data/us-pit/` — 미장 실측 PIT 유니버스

이 디렉터리에는 수집기가 만든 `universe.json` **하나**가 들어간다.
스키마·검증의 단일 원본은 `src/features/backtest/usPitUniverse.ts`다.

## ⚠️ 지금 `universe.json`이 없는 이유

**만들지 않았다. 지어내지 않기 위해서다.**

이 파일을 만들려면 `en.wikipedia.org`에 접속해야 하는데, 작업 컨테이너는 외부망이 막혀 있다
(직접 curl · 에이전트 프록시 · Wikipedia REST 세 경로 전부 `403 CONNECT`). 데이터를 받지 못한
상태에서 "그럴듯한 목록"을 손으로 채워 넣는 것은 이 작업에서 **가장 나쁜 결과**다 —
`usPitUniverse.ts`의 `US_PIT20`·`US_PIT80`이 정확히 그렇게 만들어진 `[추정]` 목록이고,
국장에서 같은 결함이 실제로 터졌다(33차: 실측 교체로 알파 +21.9%p → +2.6%p, 승자 3종 중 2종 전멸).

로더는 이 파일이 없으면 **던진다.** `[추정]` 목록으로 조용히 내려가지 않는다
(`US_PIT_REAL_LOAD_FAIL` · `krxUniverseSource.ts`의 `KRX_UNIVERSE_LOAD_FAIL`과 같은 이유).

## 만드는 법 — GitHub Actions 러너에서

Wikipedia만 쓰므로 **국내 IP·키움 키가 필요 없다** → 실행 장소 규칙상 EC2가 아니라 GHA다.

```bash
US_PIT_INDEX=sp500 node scripts/us-pit-collect.mjs
```

| env | 기본값 | 뜻 |
|---|---|---|
| `US_PIT_INDEX` | `sp500` | `sp500` \| `ndx` |
| `US_PIT_FROM` | `1996` | 되감기 목표 시작 연도 |
| `US_PIT_TO` | 올해 | 되감기 목표 끝 연도 |
| `US_PIT_REFRESH` | (없음) | `1`이면 캐시 무시하고 다시 받는다 |
| `US_PIT_CONTACT` | (없음) | User-Agent에 넣을 연락처(Wikimedia UA 정책) |
| `US_PIT_OUT` | `public/data/us-pit/universe.json` | 저장 경로 |

수집기는 위키 응답을 `node_modules/.us-pit-cache/`에 캐시한다 — 중간에 죽어도 재실행 시
네트워크를 다시 타지 않는다(재개 가능). 성공 카운터(수신·현재목록·변경행·복원연도) 중
하나라도 0이면 **파일을 쓰지 않고 exit 1**로 죽는다.

## 데이터를 읽을 때 반드시 알아야 할 것

1. **지수 구성종목 ≠ 시총 상위 N.** `US_PIT20`/`US_PIT80`은 "그 해 시총 상위 N"이었다.
   S&P 500은 위원회가 고르는 목록이고 편입 자체가 이벤트다. **옛 US_PIT 수치와 직접
   비교하면 거짓이다.** 이 파일에는 순위가 없다(`rankSource: "none"`).
2. **`reliableFrom` 밖은 쓰지 마라.** Wikipedia의 변경 이력표는 제목부터
   "**Selected** changes"이고 실제로 불완전하다. 그래서 되감기 신뢰 경계를 게이트 2종
   (구성종목 수 밴드 · 늦은편입 위반 0)이 **데이터로** 정한다. 접근자는 경계 밖 연도를
   요청하면 던진다.
3. **생존편향은 제거되지 않고 측정만 된다.** 상장폐지된 구성종목은 목록에 그대로 두고,
   가격이 없으면 러너가 매핑 실패로 계수해 드러낸다.
4. **티커 재사용**(LU=Lucent→Lufax, SUNW=Sun Microsystems→Sunworks)은 같은 티커에 다른
   회사명이 붙는 것으로 검출된다. 개명(`US_TICKER_RENAMES`)인지 재사용(`US_BLOCKED_TICKERS`)인지
   **사람이 분류하기 전까지 조회를 거부**한다 — 오염보다 정직한 매핑 실패가 낫다.

출처: Wikipedia (CC BY-SA 4.0). 수집기가 `source`·`sourceUrl`·`license`를 데이터에 남긴다.
