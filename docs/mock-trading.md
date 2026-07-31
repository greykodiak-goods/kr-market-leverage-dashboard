# 모의투자 운용 가이드 (규칙 2 · 2단계)

키움 **모의서버 전용** 주문 어댑터와 일일 운용 러너의 운영 문서다.
상위 규칙은 리포 루트 `CLAUDE.md` 규칙 2(실계좌 경계), 시크릿은 규칙 2-1(Doppler 단일 원본)을 따른다.

> **이 문서가 다루는 범위 = 2단계(모의투자 주문)뿐이다.**
> 3단계(실계좌 소액)는 닫혀 있다. 실서버 주소·실서버 주문 엔드포인트는 코드에 없고,
> `tests/no-order-endpoint.test.ts` 가 매 `npm test` 마다 그것을 강제한다.
> 자금 이체·입출금 API는 **영구 금지**다.

---

## 1. 구성

| 파일 | 역할 |
| --- | --- |
| `scripts/lib/kiwoomOrder.mjs` | 모의서버 주문 어댑터. `placeOrder` / `cancelOrder` / `getBalance` / `getExecutions`. **모든 게이트가 여기 안에 있다.** |
| `scripts/kiwoom-order-probe.mjs` | 연결·TR 검증 스크립트(대표 PC에서 실행). 잔고 조회 → dryRun 계획 → (플래그 2개 시) 1주 매수·취소 왕복. |
| `scripts/mock-trade-daily.mjs` | 일일 운용 러너 런처(esbuild). 실제 로직은 `scripts/mock-trade-daily.entry.ts`. |
| `public/data/mock-live/journal.json` | 매 실행의 신호·주문·응답 저널(append). |
| `public/data/mock-live/order-count.json` | 일일 주문 건수 카운터(하드 게이트용). 날짜가 바뀌면 자동 리셋. |

---

## 2. 하드 게이트 (코드 상수 — 환경변수로 **완화 불가**)

`scripts/lib/kiwoomOrder.mjs` 의 `HARD_LIMITS`:

| 게이트 | 값 | 동작 |
| --- | --- | --- |
| 1회 주문액 | **≤ 15,000,000원** | 초과 시 전송 전에 거부 |
| 일일 주문 건수 | **≤ 30건** (신규·취소 합산) | 도달 시 이후 주문 전부 거부 |
| 킬 스위치 | 리포 루트의 **`HALT` 파일** | 존재하면 매수·매도·취소 **전부** 중단 |
| dryRun | **기본 `true`** | `--live` 를 명시하지 않으면 네트워크로 주문이 나가지 않는다 |
| 서버 | `mockapi.kiwoom.com` 고정 | 주소에 `mockapi` 가 없으면 어댑터 생성 자체가 실패 |

환경변수 `KIWOOM_MAX_ORDER_KRW` / `KIWOOM_MAX_DAILY_ORDERS` 는 **한도를 낮추는 방향으로만** 반영된다
(더 큰 값을 주면 무시). 게이트는 네트워크로 나가는 유일한 통로(`submit()`) 안에 있어 우회 경로가 없다.
검증: `tests/kiwoom-order.test.ts`(네트워크 없이 순수 로직).

### 킬 스위치 사용법

```powershell
# 중단 — 이 순간부터 모든 주문이 게이트에서 거부된다
New-Item -Path .\HALT -ItemType File -Force

# 재개
Remove-Item .\HALT
```

`HALT` 중에는 **취소 주문도 나가지 않는다.** 킬 스위치는 "코드가 계좌를 일절 건드리지 않는 상태"를
뜻하며, 그 상황에서 포지션 정리가 필요하면 대표가 모의 HTS에서 수동으로 한다.

---

## 3. 선행 조건 (대표 T0)

1. 키움 **모의투자용** 앱키 발급 — 실전 키를 모의서버에 쓰면 에러 8030(투자구분 불일치)이 난다.
2. Doppler `investing-ops` / config `prd` 에 등록 (값 입력은 대표만, AI 세션엔 `DOPPLER_TOKEN` 미부여):
   - `KIWOOM_MOCK_APP_KEY`
   - `KIWOOM_MOCK_APP_SECRET`
   - `KIWOOM_MOCK_ACCOUNT` (모의계좌번호 — 코드·로그·저널 어디에도 출력되지 않는다)
3. 키움 포털에서 실행 PC의 IP 등록.

---

## 4. 실행 순서

### ① 연결·TR 검증 (전송 없음)

```powershell
doppler run --project investing-ops --config prd -- node scripts/kiwoom-order-probe.mjs
```

출력에 잔고 응답 키·`return_code`·`return_msg` 가 나온다. **[미검증] TR 필드명 보정에 쓰이므로
출력 전체를 총괄 세션에 붙여넣는다.** 시크릿·계좌번호는 출력되지 않는다(길이만).

### ② 모의 주문 왕복 (플래그 2개 모두 필요)

```powershell
doppler run --project investing-ops --config prd -- node scripts/kiwoom-order-probe.mjs --live --confirm-mock
```

삼성전자 1주를 현재가 −5% 지정가로 매수(미체결 유도) → 즉시 취소한다.
취소가 실패하면 체결됐을 수 있으니 모의 HTS에서 잔고를 확인한다.

### ③ 일일 운용 (기본 dryRun)

```powershell
# 계획만 (아무것도 전송하지 않음)
doppler run --project investing-ops --config prd -- node scripts/mock-trade-daily.mjs

# 실제 모의서버 주문
doppler run --project investing-ops --config prd -- node scripts/mock-trade-daily.mjs --live
```

동작: Yahoo 일봉(오늘 포함)으로 승자 전략(MA20 돌파 × 20일 신고가 / 40일선 −2% 청산 / 슬롯 10,
유니버스는 `public/data/paper/config.json` 의 `all80` 동결 목록)을 개시일부터 재계산 →
**오늘 새로 잡힌 진입·청산만** 추출 → 모의 주문 → 저널 append.
자본 배분은 (모의계좌 총평가 ÷ 10). 잔고 조회 실패 시 config 초기자본으로 `[추정]` 대체하고 저널에 표기한다.

---

## 5. Windows 작업 스케줄러 등록

평일 15:20 실행(장 마감 15:30 직전). 리포 경로는 실제 경로로 바꿔 넣는다.

```powershell
schtasks /create /tn "KiwoomMockTradeDaily" /sc weekly /d MON,TUE,WED,THU,FRI /st 15:20 /f /tr "cmd /c cd /d C:\path\to\kr-market-leverage-dashboard && doppler run --project investing-ops --config prd -- node scripts/mock-trade-daily.mjs --live >> logs\mock-trade.log 2>&1"
```

- **처음 최소 1주일은 `--live` 를 빼고** 등록해 계획만 쌓고, 저널을 눈으로 검토한 뒤 `--live` 를 붙인다.
- 휴장일에는 오늘 봉이 없으므로 러너가 스스로 주문 없이 종료하고 저널에 `skipped` 를 남긴다.
- 로그 폴더(`logs\`)는 미리 만들어 둔다. 로그에는 시크릿·계좌번호가 남지 않는다.
- 등록 확인/삭제: `schtasks /query /tn "KiwoomMockTradeDaily"` · `schtasks /delete /tn "KiwoomMockTradeDaily" /f`

---

## 6. 3단계 개방 게이트 체크리스트 (규칙 2)

2단계 통과 조건은 **최소 4주 연속 모의 운용 + 슬리피지·미체결률 실측 대조**다.
아래가 전부 충족되고 **대표의 별도 승인**이 있어야 3단계(실계좌 소액)가 열린다.

- [ ] 4주(20 영업일) 연속 실행 — 저널에 영업일 누락이 없다.
- [ ] 주문 → 체결 대조: 지정가 주문의 **미체결률**을 실측했다(체결내역 조회 대조).
- [ ] **슬리피지 실측**: 시뮬 체결가(Yahoo 종가 근사) vs 모의 실제 체결가의 차이를 종목·일자별로 집계했다.
- [ ] 그 슬리피지를 백테스트 비용 가정(`config.json` 의 `slippagePct` 0.1%)과 대조했고, 실측이 더 크면
      가정을 실측으로 갱신해 알파를 **재산출**했다.
- [ ] 재산출 후에도 알파가 양수다(규칙 5 — 절대 수익률 아님).
- [ ] 15:20 미확정 종가로 판단한 신호와, 종가 확정 후 시뮬 신호의 **불일치 건수**를 집계했다.
- [ ] 게이트(1회 한도·일일 건수·HALT)가 실제 운용 중 최소 1회씩 동작하는 것을 확인했다.
- [ ] 이상 없이 4주를 채웠고, 그 기록을 대표에게 보고했다.

3단계에서 추가로 요구되는 것(승인 후 착수): 총 투입 한도, 일일 손실 한도, 최대 보유 종목수,
킬 스위치, **기동은 대표 수동**.

---

## 7. [미검증] 항목 — probe로 확정할 것

주문·계좌 TR 명세는 문서상 추정치이며 모의서버 실측 전이다. 코드의 해당 지점에 `[미검증]` 주석이 있다.

| 항목 | 현재 추정값 | 확인 방법 |
| --- | --- | --- |
| 매수 / 매도 api-id | `kt10000` / `kt10001` | probe ②·④ 의 `return_code` |
| 정정 / 취소 api-id | `kt10002` / `kt10003` | probe ④ 의 취소 응답 |
| 주문 경로 | `/api/dostk/ordr` | 위와 동일 |
| 주문 바디 필드 | `dmst_stex_tp` / `stk_cd` / `ord_qty` / `ord_uv` / `trde_tp` | 실패 시 `return_msg` |
| 매매구분 코드 | 지정가 `0` / 시장가 `3` | 위와 동일 |
| 주문번호 응답 필드 | `ord_no` 또는 `odno` | probe ④ 의 "응답 키" 목록 |
| 잔고 TR / 경로 | `kt00018` / `/api/dostk/acnt` | probe ① |
| 잔고 필드(총평가·현금·보유) | `tot_evlt_amt` / `entr` / `acnt_evlt_remn_indv_tot` | probe ① 의 "응답 키" |
| 체결내역 TR | `kt00007` | probe ⑤ |
| LOC(장마감 종가) 주문 지원 여부 | 미지원 가정 → 지정가로 대체 | 키움 문서·probe |
| 호가 단위 반올림 | 5만↑ 100 / 2만↑ 50 / 그 외 10 | 주문 거부 메시지 |

이 컨테이너에서는 외부 네트워크가 차단돼 있어 **실행 검증을 할 수 없다.**
위 항목은 전부 대표 PC의 probe 실행으로만 확정된다.

---

## 8. 데이터 정직성 (규칙 3·4)

- 저널의 체결 가정은 **Yahoo 일봉(비공식·총수익 보정)의 15:20 미확정 종가 근사**다. 실호가가 아니다.
- 시뮬레이션 결과와 모의 실체결은 다를 수 있으며, 그 차이를 재는 것이 2단계의 목적이다.
- 본 산출물은 시스템 검증용이며 **투자자문이 아니다.** 손실 가능성·최대낙폭·무효화 지점을 함께 본다.
