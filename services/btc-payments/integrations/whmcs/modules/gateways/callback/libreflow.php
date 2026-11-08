<?php
/**
 * IPN do LibreFlow Pay: confere a assinatura, consulta a fatura de novo na
 * API e so entao registra o pagamento na fatura do WHMCS.
 */

require_once __DIR__ . '/../../../init.php';
require_once __DIR__ . '/../../../includes/gatewayfunctions.php';
require_once __DIR__ . '/../../../includes/invoicefunctions.php';
require_once __DIR__ . '/../libreflow/LibreFlowApi.php';

$gatewayModuleName = 'libreflow';
$gateway = getGatewayVariables($gatewayModuleName);
if (!$gateway['type']) {
    http_response_code(503);
    die('modulo inativo');
}

$invoiceId = LibreFlowApi::readIpn($gateway['ipnSecret']);
if ($invoiceId === null) {
    http_response_code(401);
    die('assinatura invalida');
}

try {
    $api = new LibreFlowApi($gateway['apiBase'], $gateway['storeKey'], 'whmcs');
    $invoice = $api->getInvoice($invoiceId);
} catch (Exception $e) {
    // O LibreFlow tenta de novo depois.
    http_response_code(503);
    die('falha ao consultar a fatura');
}

if (!preg_match('/^whmcs-(\d+)$/', (string) $invoice['order_id'], $m)) {
    http_response_code(200);
    die('ok');
}
$whmcsInvoiceId = checkCbInvoiceID((int) $m[1], $gatewayModuleName);
logTransaction($gatewayModuleName, $invoice, $invoice['status']);

if ($invoice['status'] === 'pago') {
    $transactionId = $invoice['tx_hash'] ? $invoice['tx_hash'] : $invoice['id'];
    // Ignora se esta transacao ja foi registrada (IPN repetido).
    checkCbTransID($transactionId);
    if ($invoice['mode'] === 'test') {
        logTransaction($gatewayModuleName, $invoice, 'TESTE: nenhum dinheiro foi recebido; pagamento nao registrado');
    } else {
        addInvoicePayment($whmcsInvoiceId, $transactionId, $invoice['price_amount'], 0, $gatewayModuleName);
    }
}

http_response_code(200);
echo 'ok';
