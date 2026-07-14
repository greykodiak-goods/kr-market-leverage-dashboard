// LIVE data pipeline for the short-covering monitor — RUN AFTER KEY IS ISSUED.
//
// Fetches 종목별(000660) 대차잔고 실수치 from data.go.kr 주식대차정보 and bakes
// public/data/hynix-lending.json with meta.source = 'LIVE'. The dashboard
// components render off meta.source, so swapping this file needs NO code change
// (code↔data separation).
//
// SECURITY / SEPARATION RULES (do not violate):
//  - The API key is a SECRET. Inject via env `DATA_GO_KR_KEY` (GH Actions Secret
//    or local env). NEVER hardcode it, NEVER ship it in the client bundle.
//  - The browser cannot call data.go.kr (Supabase proxy allowlist blocks it);
//    this Node script runs at build/schedule time only.
//  - This job commits ONLY public/data/*.json — never .ts/.tsx source.
//  - Separate file from the outlook twice-daily job → no conflict.
//
// STATUS: scaffold only. Endpoint field mapping is filled in once the key and
// the exact API spec (getFtsBrhLoanStatus 등) are confirmed. Until then the
// SEED file from scripts/generate-short-seed.mjs is used and shows a
// '실데이터 연동 예정' badge.

import { writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUT = join(__dirname, '..', 'public', 'data')

const KEY = process.env.DATA_GO_KR_KEY
const HYNIX = '005930' // NOTE: 000660 for SK hynix; corp/isin code confirmed at wiring time

async function main() {
  if (!KEY) {
    console.error('[fetch-hynix-lending] DATA_GO_KR_KEY not set — skipping LIVE fetch (SEED stays).')
    process.exit(0)
  }

  // TODO (key 확보 후):
  //  1) data.go.kr 주식대차정보 엔드포인트로 000660 일별 대차잔고 조회
  //     (serviceKey=KEY, 종목코드, 기간). JSON/XML 파싱.
  //  2) 정규화 → series: [{ date, shares, amountEok }] (오름차순, 영업일).
  //  3) meta.source='LIVE', sourceLabel='실데이터 (금융위 주식대차정보 · data.go.kr)'.
  //  4) writeFileSync(join(OUT,'hynix-lending.json'), JSON.stringify({meta,series},null,0))
  //  (공매도 잔고 오픈API 확보 시 hynix-short-balance.json도 동일 패턴으로.)
  console.log('[fetch-hynix-lending] wiring pending — implement endpoint mapping when key + spec confirmed.')
  mkdirSync(OUT, { recursive: true })
  void HYNIX
  process.exit(0)
}

main()
