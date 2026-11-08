#!/bin/sh
# Monta os pacotes dos plugins em $1 (padrao: ./dist). O cliente PHP
# compartilhado (shared/LibreFlowApi.php) e copiado para dentro de cada um.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
mkdir -p "${1:-$here/dist}"
out=$(cd "${1:-$here/dist}" && pwd)
rm -f "$out"/libreflow*.zip
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
shared="$here/shared/LibreFlowApi.php"
# O cliente compartilhado vai para pastas que so existem no pacote (o git
# nao guarda pasta vazia): cria antes de copiar.
put() { mkdir -p "$(dirname "$2")" && cp "$shared" "$2"; }

# WooCommerce (cliente proprio, com as funcoes HTTP do WordPress)
(cd "$here/woocommerce" && zip -qr "$out/libreflow-woocommerce.zip" libreflow-gateway)

# WHMCS: modules/gateways/...
cp -R "$here/whmcs" "$work/whmcs"
put "$shared" "$work/whmcs/modules/gateways/libreflow/LibreFlowApi.php"
(cd "$work/whmcs" && zip -qr "$out/libreflow-whmcs.zip" modules)

# OpenCart 4: .ocmod.zip com install.json na raiz
cp -R "$here/opencart/libreflow" "$work/opencart"
put "$shared" "$work/opencart/system/library/LibreFlowApi.php"
(cd "$work/opencart" && zip -qr "$out/libreflow.ocmod.zip" .)

# PrestaShop 8: pasta do modulo
cp -R "$here/prestashop/libreflowpay" "$work/libreflowpay"
put "$shared" "$work/libreflowpay/lib/LibreFlowApi.php"
(cd "$work" && zip -qr "$out/libreflow-prestashop.zip" libreflowpay)

# Magento 2: app/code/Libreflow/Pay
mkdir -p "$work/magento/app/code"
cp -R "$here/magento/Libreflow" "$work/magento/app/code/Libreflow"
put "$shared" "$work/magento/app/code/Libreflow/Pay/lib/LibreFlowApi.php"
(cd "$work/magento" && zip -qr "$out/libreflow-magento.zip" app)

ls -1 "$out"
