// KRX 일별 시세 정본화 파이프라인 — 실행 런처 (조회 전용 · 규칙 2 1단계).
//
// ─────────────────────────────────────────────────────────────────────────────
// 무엇을 하는가
// ─────────────────────────────────────────────────────────────────────────────
// KRX Open API의 **일별 전종목 단면**(stk_bydd_trd / ksq_bydd_trd)을 2010-01-01부터
// 실행일까지 하루씩 받아, 백테스트용 정본 시세를 만든다. 산출물은 세 가지다.
//
//   public/data/krx-daily/monthly-universe.json  매월 첫 거래일 시총 상위 40(코스피)+40(코스닥)
//   public/data/krx-daily/prices/{code}.json     그 유니버스 합집합 종목의 전 기간 일별 시세(원주가)
//   public/data/krx-daily/index.json             거래일 달력 · 종목 목록 · 결측/한계 표기
//   public/data/krx-daily/adj-events.json        수정주가 이벤트(분할·무상증자형 / 증자·전환형)
//
// 왜 야후가 아니라 KRX인가(2026-08-03 대표 지시 — 야후 배제 1단계):
//   ① 야후에는 **상장폐지 종목 시세가 없다** → 생존편향. krx-pit 실측 유니버스 275종목 중
//      23종목이 매핑 실패했고, 사라진 쪽이 나쁠 확률이 높으니 성적이 부풀려진다.
//   ② 야후가 코스닥 6자리 코드에 **엉뚱한 티커의 시계열**을 준 사고가 있었다(조용히 틀린 숫자).
//   KRX 단면은 그날 상장돼 있던 전 종목을 주므로 ①②가 동시에 사라진다.
//
// ─────────────────────────────────────────────────────────────────────────────
// 실행법 (EC2 — 국내 IP 필요. 개발 컨테이너·GHA에서는 막힌다)
// ─────────────────────────────────────────────────────────────────────────────
//   doppler run --project investing-ops --config prd -- node scripts/krx-daily-backfill.mjs
//
//   옵션:
//     --from=2010-01-01 --to=2026-08-03   수집 범위(기본: 2010-01-01 ~ 실행일 KST)
//     --top=40                             월별 유니버스 시장별 상위 N (기본 40)
//     --with-volume                        거래량(ACC_TRDVOL)까지 파일에 담는다 (기본 미수집 — 용량)
//     --collect-only / --process-only      수집만 / 캐시로 가공만
//     --max-calls=9500                     이번 실행 콜 상한 (KRX 한도 1만건/일 보호)
//     --interval-ms=320                    콜 간 최소 간격 (기본 320ms ≥ 300ms 요구)
//     --max-mb=50 --warmup-bars=300 --tail-bars=60   용량 예산과 초과 시 잘라내는 창
//
//   키: Doppler `investing-ops`의 **KRX_API_KEY** 하나. `scripts/lib/loadSecret.mjs`로만 읽고
//       값은 어떤 경로로도 출력하지 않는다(출처·길이만). 키가 없으면 표준 안내 후 종료한다.
//       키 발급·값 입력은 대표만(T0).
//
// ─────────────────────────────────────────────────────────────────────────────
// 재개 (resumable)
// ─────────────────────────────────────────────────────────────────────────────
//   원시 응답을 `KRX_CACHE_DIR`(기본 `~/.krx-cache`)에 `YYYYMMDD-{stk|ksq}.json`으로 캐시한다.
//   캐시가 있는 콜은 건너뛰므로, **같은 명령을 다시 실행하면 끊긴 지점부터 이어간다.**
//   중간에 끊겨도(SSH 끊김·한도 도달·키 만료) 받은 데이터는 남는다.
//
//     KRX_CACHE_DIR=/data/krx-cache doppler run ... -- node scripts/krx-daily-backfill.mjs
//
//   전체 소요: 평일 약 4,300일 × 2시장 ≈ **8,600콜**. 콜 간 320ms면 약 46분.
//   KRX 한도는 1만건/일이라 하루 안에 끝나지만, 여유가 없으면 `--max-calls`로 나눠 이틀에
//   걸쳐 받아도 된다(캐시 덕분에 손실 없음). 진행 로그에 남은 콜 수와 예상 시간이 나온다.
//   **수집이 완결되지 않으면 가공을 건너뛴다** — 반쪽 데이터셋을 리포에 커밋하지 않기 위함이다.
//
// ─────────────────────────────────────────────────────────────────────────────
// 한계 (규칙 3 — 숨기지 않는다)
// ─────────────────────────────────────────────────────────────────────────────
//   · **배당 미반영.** 수정계수는 상장주식수 변화(분할·병합·무상증자)에서만 산출된다.
//     현금배당은 주식수를 바꾸지 않으므로 이 시계열은 **가격수익(price return)**이다.
//     Yahoo adjclose(총수익) 기반 성적과 직접 비교하면 안 된다.
//   · **2010년 이전 없음.** KRX Open API의 데이터 시작이 2010년이다.
//   · **응답 필드명 [미검증].** 문서 기준으로 관용 파싱한다(ISU_SRT_CD·TDD_OPNPRC 등의 후보를
//     순서대로 시도). **첫 성공 응답에서 실제 키 목록을 로그로 출력**하므로 그때 확정된다.
//   · **분류 불확실.** 주식수 변화가 분할인지 유상증자인지는 가격 갭과의 정합으로 추정한다.
//     애매한 건은 `confidence:'low'`로 남기고 **기본적으로 보정하지 않는다**(조용히 보정해
//     틀리느니 드러내 놓고 안 건드린다). 야후 등 외부 시세로 교차검증하지 않는다(대표 지시).
//   · **거래량 기본 미수집.** `--with-volume` 없이 만든 파일은 `DailyBar.v = 0`이다.
//   · **시가총액 미저장.** `종가 × 상장주식수`로 유도한다. 유도가 응답 MKTCAP과 맞는지는
//     자기검증 배터리 ④가 실측 일치율로 보고한다.
//
// ─────────────────────────────────────────────────────────────────────────────
// 자기검증 배터리 (수집 끝나고 자동 실행 · 실패하면 종료코드 3 — 커밋하지 말 것)
// ─────────────────────────────────────────────────────────────────────────────
//   ① 공지된 액면분할 3건 검출: 삼성전자 005930 2018-05 50:1 / NAVER 035420 2018-10 5:1 /
//      카카오 035720 2021-04 5:1
//   ② 연초 첫 거래일 top10 대 `public/data/krx-pit/universe.json`(연 단위 정본) 대조
//   ③ 시계열 결측일(상장 기간 중 빠진 거래일) 통계
//   ④ MKTCAP 유도(종가×주식수) 실측 일치율
//   ⑤ 수정 이벤트 분포(분할/증자 × 신뢰도)
//
// 본체는 `scripts/krx-daily-backfill.entry.ts`다. 여기서는 esbuild JS API로 번들해 실행만
// 한다(run-tests.mjs·spec-backtest.mjs와 같은 방식 — CLI 경로는 플랫폼마다 깨진다).

import { mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { buildSync } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'node_modules', '.krx-daily-backfill')
rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })
const out = join(outDir, 'entry.cjs')

buildSync({
  entryPoints: [join(root, 'scripts', 'krx-daily-backfill.entry.ts')],
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
