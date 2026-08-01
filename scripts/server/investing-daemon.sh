#!/usr/bin/env bash
# EC2 상주 데몬 pm2 래퍼 — awning-ops의 deploy-investing.yml이 이 스크립트를 pm2에 등록한다.
#   pm2 start ~/investing/kr-market/scripts/server/investing-daemon.sh --name investing-daemon --interpreter bash
#
# 전제·격리 원칙은 investing-cron.sh와 동일: 전용 Node·doppler·deploy key·256MB 상한.
# pm2가 재시작할 때마다 git pull → npm install → 데몬 기동이므로, 코드 갱신 배포는
# "main 푸시 후 pm2 restart investing-daemon" 한 번으로 끝난다.
#
# 인자는 데몬에 그대로 전달된다: --live(모의서버 실제 주문) / --once=단계(스모크 검증용)
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
# 네트워크 순단으로 pull이 실패해도 기존 코드로 기동한다(상주 프로세스 크래시루프 방지)
git pull --ff-only origin main || echo "[investing-daemon.sh] git pull 실패 — 기존 코드로 계속"
npm install --no-audit --no-fund --loglevel=error || echo "[investing-daemon.sh] npm install 실패 — 기존 의존성으로 계속"

exec nice -n 10 doppler run --project investing-ops --config prd -- \
  node scripts/investing-daemon.mjs "$@"
