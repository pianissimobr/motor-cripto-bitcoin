#!/usr/bin/env bash
# Configura a chave da tesouraria de gas do motor.
#
#   KEY=0x... ./scripts/set-gas-station-key.sh 0xENDERECO_ESPERADO
#
# A chave NUNCA e impressa: o script confere se ela deriva o endereco
# esperado e so entao grava no .env.production (0600) da VPS.
set -euo pipefail
umask 077

EXPECTED=${1:?informe o endereco esperado}
KEY=${KEY:?informe a chave em KEY=0x...}

cd /opt/motor-cripto/services/btc-payments

# 1. deriva o endereco da chave e confere
ADDR=$(docker compose -p motor-cripto --env-file .env.production \
  -f docker-compose.prod.yml -f docker-compose.vps.yml \
  exec -T -e KEY="$KEY" api node --input-type=module -e "
import { privateKeyToAccount } from 'viem/accounts';
process.stdout.write(privateKeyToAccount(process.env.KEY).address.toLowerCase());
")

if [ "$ADDR" != "$(echo "$EXPECTED" | tr 'A-Z' 'a-z')" ]; then
  echo "ERRO: a chave deriva $ADDR, nao $EXPECTED. Nada foi gravado."
  exit 1
fi
echo "chave confere com o endereco $ADDR"

# 2. grava no .env.production
python3 - "$KEY" <<'P'
import re, sys
key = sys.argv[1]
p = '.env.production'
s = open(p).read()
s = re.sub(r'(?m)^GAS_STATION_PRIVATE_KEY=.*$', f'GAS_STATION_PRIVATE_KEY={key}', s)
s = re.sub(r'(?m)^GAS_STATION_ENABLED=.*$', 'GAS_STATION_ENABLED=true', s)
open(p, 'w').write(s)
P
chmod 600 .env.production

# 3. sobe a API e confere
docker compose -p motor-cripto --env-file .env.production \
  -f docker-compose.prod.yml -f docker-compose.vps.yml \
  up -d --no-deps --force-recreate api >/dev/null
for i in $(seq 1 30); do curl -sf http://127.0.0.1:4580/health >/dev/null && break; sleep 2; done

set -a && . ./.env.production && set +a
curl -s http://127.0.0.1:4580/admin/api/status -H "Authorization: Bearer $ADMIN_TOKEN" \
  | grep -o 'gasStation[^}]*}'
