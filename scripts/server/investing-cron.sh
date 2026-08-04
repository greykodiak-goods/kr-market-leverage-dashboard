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

# ─── 동기화 (2026-08-04 전면 개정 — 사고 원인 실측 후) ────────────────────────
#
# 무엇이 잘못이었나 (gitdiag 실측, awning-ops run 30878440819):
#   `git pull --rebase --autostash` 가 **데이터 파일에 autostash 를 걸었다.**
#   수집기가 public/data/intraday/*.json 을 고쳐 놓은 채(커밋 전) 다음 실행이 오면
#   autostash 가 그걸 스태시했다가 pull 뒤 pop 하는데, origin 쪽에서도 같은 파일이
#   바뀌어 있으면 **pop 이 충돌**한다. 그 순간:
#     · 작업트리 JSON 에 충돌 마커가 박혀 **파일이 깨진다**(파싱 불가)
#     · rebase/merge 가 "진행 중"이 아니므로 `rebase --abort` 로는 못 푼다
#     · 다음 실행마다 `git pull` 이 "unmerged files" 로 즉사 → set -e →
#       **수집을 시작하기도 전에** 크론이 조용히 영구 정지
#   실측 결과: 미푸시 커밋 0건 · rebase 진행 중 아님 · UU 91개 파일(전부 intraday).
#   즉 원인은 "미푸시 커밋 누적"이 아니라 **커밋 안 된 데이터에 스태시를 건 것**이었다.
#
# 어떻게 바꿨나:
#   ① **스태시하지 않는다.** 데이터 경로가 더러우면 pull 전에 **먼저 커밋**한다.
#      커밋은 rebase 가 정상적으로 얹지만, 커밋 안 된 변경은 pop 충돌로 리포를 망가뜨린다.
#   ② 그래도 unmerged 가 남아 있으면 **덮어쓰지 말고 즉시 실패**한다 — 사람이 봐야 한다.
#      (조용히 고치면 다음 사고를 못 본다.)
#   ③ push 는 **pull 직후에, 재시도 루프 안에서** 한다. main 은 하루에도 여러 번 움직여서
#      pull 과 push 사이가 벌어지면 non-fast-forward 로 거부된다.
sync_guard() {
  if [ -n "$(git ls-files --unmerged)" ]; then
    echo "[investing-cron] ❌ 미해결 충돌이 남아 있다 — 자동 복구하지 않는다(데이터 손상 방지)." >&2
    echo "[investing-cron]    awning-ops deploy-investing.yml 을 backtest_mode=gitdiag 로 돌려 상태를 보고," >&2
    echo "[investing-cron]    backtest_mode=gitfix 로 백업 후 복구하라." >&2
    git status --short | head -20 >&2
    exit 1
  fi
}

# 데이터 경로의 커밋 안 된 변경을 **커밋으로 승격**한다(스태시 금지).
commit_stray_data() {
  git add public/data 2>/dev/null || true
  if ! git diff --cached --quiet; then
    echo "[investing-cron] 이전 실행이 남긴 미커밋 데이터 발견 — 스태시 대신 커밋으로 승격"
    git -c user.name="investing-cron" -c user.email="investing-cron@ec2.local" \
      commit -q -m "data: 이전 실행이 남긴 수집분 회수 (EC2 cron, 자동)"
  fi
  # package-lock 등 코드 파일의 잔여 변경은 데이터가 아니다 — 되돌린다(재생성 가능).
  git checkout -- package-lock.json 2>/dev/null || true
}

# pull → push 를 한 묶음으로, 재시도까지. 인자로 받은 함수가 없으면 pull 만 한다.
sync_push() {
  local i
  for i in 1 2 3; do
    git pull --rebase origin main || { sync_guard; return 1; }
    sync_guard
    if [ -z "$(git log --oneline origin/main..HEAD 2>/dev/null)" ]; then return 0; fi
    if git push origin main; then return 0; fi
    echo "[investing-cron] push 거부(main 이 그새 움직였다) — 재시도 $i/3"
    sleep $((i * 3))
  done
  echo "[investing-cron] ❌ 3회 시도 후에도 push 실패 — 커밋은 로컬에 남아 있다." >&2
  return 1
}

sync_guard
commit_stray_data
sync_push
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
    # 검증 범위를 **이번에 새로 들어온 날짜 이후**로도 좁힌다. 파일에 남은 야후 시절
    # 누적분은 매일 14:55에 끊겨 있어(2026-08-03 실측 96.7%) 전 구간 검증은 매일 FAIL이고,
    # 그러면 오늘 받은 정상 데이터까지 영원히 커밋되지 않는다 — 그동안 키움 소급 한도를
    # 넘어간 날은 영구히 못 받는다. 절단 구간의 결함은 주간 전수 검증이 계속 들고 있다.
    SINCE="$(sed -n 's/^UPDATED_FROM=//p' "$RUNLOG" | tail -1)"
    rm -f "$RUNLOG"
    if [ -z "$SYMS" ]; then
      echo "[daily-intraday] 갱신된 종목 없음(휴장일 등) — 검증·커밋 생략"
      exit 0
    fi
    # 검증 게이트 — FAIL이면 종료 코드 1 → set -e로 중단되어 오염 데이터가 커밋되지 않는다
    nice -n 10 "${DOPPLER[@]}" node scripts/verify-intraday.mjs --symbols="$SYMS" ${SINCE:+--since="$SINCE"}
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
# push 는 반드시 sync_push 로 — 맨손 `git push origin main` 은 main 이 그새 움직이면
# 거부되고, 그 커밋이 로컬에 남아 다음 실행의 rebase 대상이 된다(2026-08-04 사고의 씨앗).
git add $COMMIT_PATHS
if ! git diff --cached --quiet; then
  git -c user.name="investing-cron" -c user.email="investing-cron@ec2.local" commit -m "$MSG"
  sync_push
fi
echo "[investing-cron] ${1:-} 완료 $(date -u +%FT%TZ)"
