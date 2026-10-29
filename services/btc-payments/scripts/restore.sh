#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -f .env.production ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env.production
  set +a
fi

file="${1:-}"
if [ -z "$file" ] || [ ! -f "$file" ]; then
  echo "uso: scripts/restore.sh backups/arquivo.sql.gz" >&2
  exit 1
fi

: "${POSTGRES_USER:?defina POSTGRES_USER}"
: "${POSTGRES_DB:?defina POSTGRES_DB}"
compose_file="${COMPOSE_FILE:-docker-compose.prod.yml}"
db_service="${DB_SERVICE:-db}"

echo "ATENCAO: isso sobrescreve objetos do banco ${POSTGRES_DB}."
read -r -p "Digite 'restaurar' para continuar: " answer
if [ "$answer" != "restaurar" ]; then
  echo "cancelado"
  exit 1
fi

gunzip -c "$file" | docker compose -f "$compose_file" exec -T "$db_service" \
  psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"

echo
echo "Restore concluido. Rode as migrations pendentes:"
echo "  docker compose -f $compose_file run --rm migrate"
