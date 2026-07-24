// 크론 등록 — 기획서 §2-B 표 그대로. ⚠️ Convex 크론식은 UTC 기준 (KST = UTC+9).
// KST 오전 07~08시대는 UTC로 전날이 되어 평일 마스크(1-5)가 틀어짐 → KST 09시 이후만 사용(§2-B 함정 주의).
//
// | 크론 이름          | 주기 (KST)     | cron식 (UTC)   | 하는 일                                  |
// |--------------------|---------------|----------------|------------------------------------------|
// | dart-radar-noon    | 매일 12:30    | 30 3 * * *     | DART 수집 + 서빙 캐시 갱신 (오전 접수분)  |
// | dart-radar-evening | 매일 19:30    | 30 10 * * *    | DART 수집 + 서빙 캐시 갱신 (당일 마감분)  |
// | cleanup            | 일요일 03:00  | 0 18 * * 6     | jobRuns 90일 초과분 삭제 (UTC 토 18시)    |
//
// 주말 DART 실행은 013(데이터 없음)으로 무해·멱등. 크론 자동 재시도 없음 — 실패는 jobRuns에
// 기록되고 다음 주기의 멱등 업서트가 과거 접수분 재조회로 자연 복구한다(§2-C).
//
// freesis-leverage(평일 17:30 잠정)·lending-daily·kis-flow는 각 스크립트/키 확보 후 추가(§2-B).

import { cronJobs } from 'convex/server'
import { internal } from './_generated/api'

const crons = cronJobs()

crons.cron('dart-radar-noon', '30 3 * * *', internal.dart.collectSupplyDemand, {})
crons.cron('dart-radar-evening', '30 10 * * *', internal.dart.collectSupplyDemand, {})
crons.cron('cleanup', '0 18 * * 6', internal.ops.cleanup, {})

export default crons
