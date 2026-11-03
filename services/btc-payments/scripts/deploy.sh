#!/usr/bin/env bash
# Deploy do motor na VPS.
#
# O codigo chega por `git archive` (a VPS nao tem acesso ao repositorio) e o
# container e reconstruido. Os segredos ficam so na VPS.
#
#   ./scripts/deploy.sh            # deploy do HEAD
#   ./scripts/deploy.sh <revisao>  # deploy de um commit especifico
#
# O SSH vai por kombitech (Tailscale) e dai para vps-tarsila.
set -euo pipefail

REPO_ROOT=$(cd "$(dirname "$0")/../.." && pwd)
REV=${1:-HEAD}
JUMP=${JUMP:-kombi@kombitech}
TARGET=${TARGET:-vps-tarsila}
DEST=${DEST:-/opt/motor-cripto}

cd "$REPO_ROOT"
COMMIT=$(git rev-parse "$REV")
echo "deploy de $COMMIT ($REV) para $TARGET:$DEST"

# O arquivo vai por stdin; a senha do admin nao passa pelo shell.
git archive --format=tar "$COMMIT" | ssh -o BatchMode=yes "$JUMP" \
  "ssh -o BatchMode=yes $TARGET 'tar xf - -C $DEST && echo $COMMIT > $DEST/REVISION'"

ssh -o BatchMode=yes "$JUMP" "ssh -o BatchMode=yes $TARGET 'cd $DEST/services/btc-payments && \
  docker compose -p motor-cripto --env-file .env.production \
  -f docker-compose.prod.yml -f docker-compose.vps.yml \
  up -d --build migrate api worker && \
  for i in \$(seq 1 30); do curl -sf http://127.0.0.1:4580/health >/dev/null && break; sleep 2; done && \
  echo ready: \$(curl -s http://127.0.0.1:4580/ready)'"

echo "deploy concluido: $COMMIT"
