#!/usr/bin/env bash
# EC2 투자 크론 러너 — awning-ops의 deploy-investing.yml 워크플로가 이 스크립트를 크론에 등록한다.
#
# 전제(부트스트랩이 준비): ~/investing/node(전용 Node — 시스템 node는 쿠팡 프록시 것, 건드리지 않는다)
#   ~/investing/bin/doppler · ~/investing/.doppler.env(read-only 서비스 토큰, 600)
#   ~/.ssh/kr_market_deploy(리포 전용 deploy key) · ~/investing/kr-market(이 리포 클론)
#
# 격리 원칙(같은 서버의 쿠팡 프록시 = 사업 매출 경로 보호):
#   - nice -n 10 + NODE_OPTIONS 256MB 상한 — t2.micro(1GB)에서 프록시 메모리를 침범하지 않는다
#   - 실패 시 그냥 종료(set -e) — 재시도 폭주·프로세스 잔류 없음. 로그는 ~/investing/logs/
#
# 서브커맨드:
#   mock-trade [--live]   평일 15:20 KST — 모의운용 러너(기본 dryRun, --live는 검증 후 크론 재설치로)
#   daily-intraday        평일 16:15 KST — 5분봉 **증분**(당일분) 수집 → 검증 → 데이터 커밋·푸시
#   weekly-backfill       토 09:30 KST — 5분봉 **소급 보정**(과거 구간) → 검증 → 데이터 커밋·푸시
#
# daily vs weekly (둘 다 같은 스크립트·같은 저장소, 소급 범위만 다르다):
#   daily  = 저장소 최신 봉 뒤부터만 받는다(최근 7일 한도). 종목당 1~2요청 [추정].
#            감시목록(네이버 시총 상위 40+40 ∪ 기존 누적)과 index.json도 이 잡이 갱신한다.
#   weekly = 연속조회로 서버 소급 한도까지 당겨 과거 구멍을 메운다(종목당 수십 요청).
#   키움은 등록 IP를 요구해 GitHub Actions에서 못 돈다 — 매일 수집이 EC2로 온 이유다
#   (2026-08-03 대표 지시 "5분봉도 키움으로 전환", 구 GHA intraday-cron.yml 폐지).
set -euo pipefail

DIR="$HOME/investing"
REPO="$DIR/kr-market"
export PATH="$DIR/node/bin:$DIR/bin:$PATH"
# DOPPLER_TOKEN — read-only 서비스 토큰(값은 로그에 안 남긴다)
if [ -f "$DIR/.doppler.env" ]; then set -a; . "$DIR/.doppler.env"; set +a; fi
export GIT_SSH_COMMAND="ssh -i $HOME/.ssh/kr_market_deploy -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"
export NODE_OPTIONS="--max-old-space-size=256"
export KIWOOM_TOKEN_CACHE="$DIR/.kiwoom-token-cache.json"

cd "$REPO"
git pull --ff-only origin main
npm install --no-audit --no-fund --loglevel=error

DOPPLER=(doppler run --project investing-ops --config prd --)
COMMIT_PATHS=""
MSG=""

case "${1:-}" in
  mock-trade)
    shift
    nice -n 10 "${DOPPLER[@]}" node scripts/mock-trade-daily.mjs "$@"
    COMMIT_PATHS="public/data/mock-live"
    MSG="data: 모의운용 일일 갱신 (EC2 cron)"
    ;;
  daily-intraday)
    # 수집기가 전량 실패(앱키·IP·서버 점검)하면 스스로 exit 1 한다 → pipefail+set -e로 여기서 멈춘다.
    RUNLOG="$(mktemp)"
    nice -n 10 "${DOPPLER[@]}" node scripts/kiwoom-backfill.mjs --daily | tee "$RUNLOG"
    # 검증 범위를 **이번에 갱신된 종목**으로 좁힌다. 전체를 검증하면 관련 없는 종목 파일 하나가
    # FAIL일 때 set -e가 커밋·푸시까지 막아, 매일 수집이 조용히 얼어붙는다(알림 경로가 없다).
    SYMS="$(sed -n 's/^UPDATED_SYMBOLS=//p' "$RUNLOG" | tail -1)"
    rm -f "$RUNLOG"
    if [ -z "$SYMS" ]; then
      echo "[daily-intraday] 갱신된 종목 없음(휴장일 등) — 검증·커밋 생략"
      exit 0
    fi
    # 검증 게이트 — FAIL이면 종료 코드 1 → set -e로 중단되어 오염 데이터가 커밋되지 않는다
    nice -n 10 "${DOPPLER[@]}" node scripts/verify-intraday.mjs --symbols="$SYMS"
    COMMIT_PATHS="public/data/intraday"
    MSG="data: 키움 5분봉 일일 증분 (EC2 cron, 갱신분 3층 검증 통과)"
    ;;
  weekly-backfill)
    nice -n 10 "${DOPPLER[@]}" node scripts/kiwoom-backfill.mjs
    nice -n 10 "${DOPPLER[@]}" node scripts/verify-intraday.mjs
    COMMIT_PATHS="public/data/intraday"
    MSG="data: 키움 5분봉 주간 백필 (EC2 cron, 3층 검증 통과)"
    ;;
  *)
    echo "사용법: investing-cron.sh {mock-trade [--live]|daily-intraday|weekly-backfill}" >&2
    exit 2
    ;;
esac

# 변경분이 있을 때만 커밋·푸시 (데이터 크론 커밋은 paper-trading.yml과 동일한 관례)
git add $COMMIT_PATHS
if ! git diff --cached --quiet; then
  git -c user.name="investing-cron" -c user.email="investing-cron@ec2.local" commit -m "$MSG"
  git push origin main
fi
echo "[investing-cron] ${1:-} 완료 $(date -u +%FT%TZ)"
