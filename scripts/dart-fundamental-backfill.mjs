// DART 재무 정본화 — 실행 런처 (조회 전용 · 규칙 2 1단계).
//
// ─────────────────────────────────────────────────────────────────────────────
// 무엇을 하는가
// ─────────────────────────────────────────────────────────────────────────────
// DART OpenAPI의 **단일회사 전체 재무제표**(`fnlttSinglAcntAll.json`)를 krx-pit 40+40
// 유니버스 합집합(실측 275종목)에 대해 FY2015~올해까지 받아, 밸류·퀄리티 팩터의 정본을
// 만든다. 산출물은 두 가지다.
//
//   public/data/dart-fundamentals/stocks/{code}.json  종목별 재무 레코드(보고서 단위)
//   public/data/dart-fundamentals/index.json          종목 목록 · 결측 · 한계 · 최신 접수일
//
// 각 레코드에는 **rcept_no · 접수일(rceptDt) · bsnsYear · reprtCode · fsDiv**가 반드시 들어간다.
// 접수일이 PIT(시점 고정) 기준일이다 — `src/features/backtest/fundamentals.ts` 참조.
//
// ─────────────────────────────────────────────────────────────────────────────
// 왜 2015년부터인가 (구간 확장 방법)
// ─────────────────────────────────────────────────────────────────────────────
// DART OpenAPI의 재무데이터 시작이 **2015년**이다(2011·2013·2014 실호출 → status 013).
// 2026-08-03 대표 결정: "단축구간(2015~2026)만 우선해서 통계 정상 동작하게 해놓고
// 시뮬레이션 다 돌리고, 나중에 해결되면 이전 남은기간 추가해."
//   → 앞 구간(2015 이전)을 다른 경로로 확보하게 되면 **`--from-year`만 낮추면 된다.**
//     스키마·PIT 필터·팩터 계산은 연도에 의존하지 않는다. 다만 그 경로가 DART가 아니라면
//     `extractFundamentalRecord`에 소스별 어댑터를 하나 더 붙이고, 레코드에 접수일에
//     해당하는 "공시일"을 반드시 채워야 한다(없으면 PIT가 성립하지 않는다).
//   ⚠️ 시작 연도를 임의로 낮춰 돌리면 콜만 버린다(전부 013). 앞 구간 소스가 생기기 전에는
//     `--from-year=2015`를 유지하라.
//
// ─────────────────────────────────────────────────────────────────────────────
// 실행법 (EC2 — 키움/KRX와 달리 국내 IP 요건은 없으나, DART 키가 EC2 Doppler에 있다.
//          개발 컨테이너에서는 DART가 403이라 막힌다)
// ─────────────────────────────────────────────────────────────────────────────
//   doppler run --project investing-ops --config prd -- node scripts/dart-fundamental-backfill.mjs
//
//   옵션:
//     --from-year=2015 --to-year=2026   수집 연도 구간(기본 2015 ~ 실행연도 KST)
//     --reprt=all|annual|11011,11013    보고서 종류 (기본 all = 사업+1Q+반기+3Q)
//     --top=40                          krx-pit 시장별 상위 N (기본 40 → 합집합 275종목)
//     --codes=005930,000660             특정 종목만 (디버깅용)
//     --collect-only / --process-only   수집만 / 캐시로 가공만
//     --max-calls=19000                 이번 실행 콜 상한 (DART 한도 20,000건/일 보호)
//     --interval-ms=220                 콜 간 최소 간격 (하한 200ms)
//     --max-mb=50                       용량 예산
//
//   키: Doppler `investing-ops`의 **DART_API_KEY** 하나로 전 API(별도 승인 없음).
//       `scripts/lib/loadSecret.mjs`로만 읽고 값은 어떤 경로로도 출력하지 않는다(출처·길이만).
//       키 발급·값 입력은 대표만(T0).
//
// ─────────────────────────────────────────────────────────────────────────────
// 예상 호출량·시간
// ─────────────────────────────────────────────────────────────────────────────
//   275종목 × 12연도(2015~2026) × 4보고서 = **13,200콜**(연결 CFS 기준, 최소치).
//   연결이 없는 회사·연도는 별도(OFS)로 한 번 더 부르므로 상한은 26,400콜이다.
//   실측 기준 대부분 CFS에서 끝나므로 **14,000~17,000콜** 사이를 예상한다([추정]).
//   콜 간 220ms면 13,200콜 ≈ **48분**, 17,000콜 ≈ 62분.
//   DART 한도는 20,000건/일이라 **하루에 끝나는 것이 정상**이지만, 여유가 없으면
//   `--max-calls`로 나눠 이틀에 걸쳐 받아도 된다(캐시 덕분에 손실 없음).
//   먼저 `--reprt=annual`로 3,300콜만 받아 사업보고서 경로를 확인한 뒤 전체를 도는 것도 좋다.
//
// ─────────────────────────────────────────────────────────────────────────────
// 재개 (resumable)
// ─────────────────────────────────────────────────────────────────────────────
//   원시 응답을 `DART_CACHE_DIR`(기본 `~/.dart-cache`)의 `fs/{corp}-{year}-{reprt}-{div}.json`에
//   저장한다. **정상 0건(status 013)도 캐시한다** — 재실행 때 같은 013을 다시 사러 가지 않게.
//   corp_code 매핑도 `corp-map.json`으로 캐시된다(콜 1회 절약).
//   **수집이 완결되지 않으면 가공을 건너뛴다**(exit 2) — 반쪽 데이터셋을 커밋하지 않기 위함이다.
//
//     DART_CACHE_DIR=/data/dart-cache doppler run ... -- node scripts/dart-fundamental-backfill.mjs
//
// ─────────────────────────────────────────────────────────────────────────────
// 한계 (규칙 3 — 숨기지 않는다)
// ─────────────────────────────────────────────────────────────────────────────
//   · **2015년 이전 없음.** DART OpenAPI 재무데이터 시작이 2015년이다.
//   · **연결/별도 혼합.** CFS 우선, 없으면 OFS로 폴백한다. 어느 쪽을 썼는지 레코드마다
//     `fsDiv`로 남기고 index·자기검증에서 건수를 보고한다. 섞였다는 사실을 숨기지 않는다.
//   · **분기 누적/개별 [미검증].** 분기보고서 `thstrm_amount`가 3개월치인지 누적인지 확정하지
//     못했다. 기본 팩터 경로는 **사업보고서 연간값만** 쓴다(TTM은 명시적 opt-in + [미검증] 표기).
//   · **12월 결산 가정 [미검증].** 보고서 기간 종료일 유도에만 쓰이며 PIT 판정은 접수일로만 한다.
//   · **계정 6종만 저장.** 자본총계(지배주주 우선)·자산총계·부채총계·당기순이익·매출액·영업이익.
//     원시 전체 계정은 보관하지 않는다(용량 예산 50MB — 실제 산출물은 5MB 내외 [추정]).
//   · **생존편향은 유니버스에서 온다.** 이 수집기는 krx-pit 실측 유니버스(상폐 포함)를 따르므로
//     선택편향은 없지만, corp_code 매핑 실패 종목은 `index.unmappedCodes`로 남는다.
//
// ─────────────────────────────────────────────────────────────────────────────
// 종료코드
// ─────────────────────────────────────────────────────────────────────────────
//   0 정상  ·  1 실패(키 없음·전량 실패)  ·  2 미완결(재실행으로 이어받기)  ·  3 자기검증 실패
//
// 본체는 `scripts/dart-fundamental-backfill.entry.ts`다. 여기서는 esbuild JS API로 번들해
// 실행만 한다(run-tests.mjs·krx-daily-backfill.mjs와 같은 방식 — CLI 경로는 플랫폼마다 깨진다).

import { mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { buildSync } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'node_modules', '.dart-fundamental-backfill')
rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })
const out = join(outDir, 'entry.cjs')

buildSync({
  entryPoints: [join(root, 'scripts', 'dart-fundamental-backfill.entry.ts')],
  bundle: true,
  platform: 'node',
  outfile: out,
  logLevel: 'error',
})

try {
  execFileSync(process.execPath, [out, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: { ...process.env, REPO_ROOT: root },
  })
} catch (e) {
  process.exit(typeof e?.status === 'number' ? e.status : 1)
}
