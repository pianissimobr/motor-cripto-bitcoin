#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -f .env.production ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env.production
  set +a
fi

mkdir -p backups
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
out="backups/btc-payments-${stamp}.sql.gz"
compose_file="${COMPOSE_FILE:-docker-compose.prod.yml}"
db_service="${DB_SERVICE:-db}"

if command -v pg_dump >/dev/null 2>&1 && [ -n "${DATABASE_URL:-}" ]; then
  pg_dump "$DATABASE_URL" --no-owner --no-privileges | gzip > "$out"
else
  : "${POSTGRES_USER:?defina POSTGRES_USER}"
  : "${POSTGRES_DB:?defina POSTGRES_DB}"
  docker compose -f "$compose_file" exec -T "$db_service" \
    pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --no-privileges \
    | gzip > "$out"
fi

echo "Banco salvo em: $out"
echo
echo "Nao esqueca de guardar tambem, fora do servidor:"
echo "  - data/keystore.json (se SIGNER_MODE=local)"
echo "  - BTC_XPUB impresso na criacao da carteira"
echo "  - mnemonic da carteira (offline, nunca no servidor)"
echo "  - endereco da carteira fria"
echo
echo "Exemplo: BACKUP_KEYSTORE=1 $0 (copia o keystore para backups/)"
if [ "${BACKUP_KEYSTORE:-0}" = "1" ] && [ -f data/keystore.json ]; then
  cp data/keystore.json "backups/keystore-${stamp}.json"
  chmod 600 "backups/keystore-${stamp}.json"
  echo "Keystore copiado para backups/keystore-${stamp}.json"
fi
