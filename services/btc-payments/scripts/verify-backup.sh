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
  echo "uso: RESTORE_DATABASE_URL=postgres://... scripts/verify-backup.sh backups/arquivo.sql.gz" >&2
  exit 1
fi

: "${RESTORE_DATABASE_URL:?defina RESTORE_DATABASE_URL para um banco descartavel}"
compose_file="${COMPOSE_FILE:-docker-compose.yml}"
restore_db_service="${RESTORE_DB_SERVICE:-db}"

psql_cmd() {
  if command -v psql >/dev/null 2>&1; then
    psql "$RESTORE_DATABASE_URL" "$@"
  else
    : "${POSTGRES_USER:?defina POSTGRES_USER para usar psql via docker}"
    : "${POSTGRES_DB:?defina POSTGRES_DB para usar psql via docker}"
    docker compose -f "$compose_file" exec -T "$restore_db_service" \
      psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" "$@"
  fi
}

case "$RESTORE_DATABASE_URL" in
  *_test*|*restore*|*tmp*) ;;
  *)
    if [ "${ALLOW_RESTORE_OVERWRITE:-0}" != "1" ]; then
      echo "recusado: RESTORE_DATABASE_URL precisa conter _test, restore ou tmp" >&2
      echo "ou defina ALLOW_RESTORE_OVERWRITE=1 conscientemente" >&2
      exit 1
    fi
    ;;
esac

gzip -t "$file"
sha256sum -c "${file}.sha256" 2>/dev/null || echo "aviso: checksum .sha256 nao encontrado/validado"

echo "ATENCAO: restaurando $file em $RESTORE_DATABASE_URL"
read -r -p "Digite 'verificar' para continuar: " answer
if [ "$answer" != "verificar" ]; then
  echo "cancelado"
  exit 1
fi

gunzip -c "$file" | psql_cmd -v ON_ERROR_STOP=1 >/dev/null
DATABASE_URL="$RESTORE_DATABASE_URL" npm run migrate >/dev/null

tables="$(psql_cmd -Atc "select count(*) from information_schema.tables where table_schema='public'")"
intents="$(psql_cmd -Atc "select count(*) from payment_intents")"
entries="$(psql_cmd -Atc "select count(*) from ledger_entries")"
migrations="$(psql_cmd -Atc "select count(*) from drizzle.__drizzle_migrations")"

echo "OK: ${tables} tabelas, ${intents} intents, ${entries} lancamentos, ${migrations} migrations"
echo "Backup verificado em banco descartavel: $RESTORE_DATABASE_URL"
