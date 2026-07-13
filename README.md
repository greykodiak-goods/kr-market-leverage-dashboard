# 국내증시 레버리지 · 투자심리 대시보드

국내 주식시장의 **레버리지·투자심리** 지표를 한눈에 보는 대시보드입니다.
신용거래융자 잔고와 미수금 등 위험 지표 + SK하이닉스 원주/ADR 근실시간 시세를 함께 제공합니다.

**라이브:** https://greykodiak-goods.github.io/kr-market-leverage-dashboard/

## 지표

| 지표 | 설명 | 데이터 |
|------|------|--------|
| 신용거래융자 잔고 | 코스피/코스닥 분리 + 합계, 시계열 | 샘플 |
| 미수금 | 반대매매 위험 강조 | 샘플 |
| 투자자예탁금 | 대기 매수자금 | 샘플 |
| 신용잔고율 | 신용융자/시가총액 % | 샘플 |
| 대차잔고 | 공매도 선행지표 | 샘플 |
| 예탁금 회전율 | 매매 활발도 | 샘플 |
| 종합 과열 게이지 | 위 지표 0~100 심리지수 | 파생 |
| SK하이닉스 시세 | KRX 000660 원주 | **실시간(Yahoo)** |
| SK하이닉스 ADR | NASDAQ SKHYV + 원화환산·KRX 프리미엄 | **실시간(Yahoo)** |

레버리지 지표는 금융투자협회 FreeSIS / KRX 정보데이터시스템 공개통계 구조를 반영한 **현실적 샘플 데이터**입니다
(KRX 서버 봇차단으로 자동 수집이 막힌 상태). `scripts/fetch-data.mjs` 가 실데이터 연동 시 `public/data/*.json` 을 갱신합니다.

실시간 시세는 Yahoo Finance chart API를 CORS 프록시 경유(우선순위 폴백)로 호출하며 ~25초 폴링합니다.

## 기술 스택

Vite + React + TypeScript · recharts · @tanstack/react-query · date-fns

## 개발

```bash
npm install
npm run dev          # 로컬 개발 서버
npm run seed-data    # 샘플 데이터 재생성
npm run fetch-data   # 실데이터 수집 시도(실패 시 샘플 유지)
npm run build        # 프로덕션 빌드
```

## 배포

`main` push 및 매 평일(cron) GitHub Actions 가 빌드 후 GitHub Pages로 배포합니다.

> 정보 제공 목적이며 투자 자문이 아닙니다.
