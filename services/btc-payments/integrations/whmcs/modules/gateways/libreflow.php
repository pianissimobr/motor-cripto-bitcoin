<?php
/**
 * LibreFlow Pay para WHMCS: Pix, Bitcoin e USDC, liquidado em dolar digital
 * (ou Pix em reais na conta da empresa, se o banco estiver conectado no
 * painel). O cliente paga na pagina hospedada; o callback registra o
 * pagamento na fatura do WHMCS.
 */

if (!defined('WHMCS')) {
    die('This file cannot be accessed directly');
}

require_once __DIR__ . '/libreflow/LibreFlowApi.php';

function libreflow_MetaData()
{
    return array('DisplayName' => 'LibreFlow Pay (Pix, Bitcoin e USDC)', 'APIVersion' => '1.1');
}

function libreflow_config()
{
    return array(
        'FriendlyName' => array('Type' => 'System', 'Value' => 'Pix ou Bitcoin (LibreFlow Pay)'),
        'apiBase' => array(
            'FriendlyName' => 'Endereço da API',
            'Type' => 'text',
            'Size' => '60',
            'Default' => 'https://cripto.libreflowdigital.com',
        ),
        'storeKey' => array(
            'FriendlyName' => 'Chave de loja',
            'Type' => 'password',
            'Size' => '60',
            'Description' => 'Painel LibreFlow → Integração e API. Comece pela chave de teste.',
        ),
        'ipnSecret' => array(
            'FriendlyName' => 'Segredo IPN',
            'Type' => 'password',
            'Size' => '60',
        ),
    );
}

/** Botao "Pagar agora" na fatura: cria (ou reaproveita) a fatura no LibreFlow. */
function libreflow_link($params)
{
    $api = new LibreFlowApi($params['apiBase'], $params['storeKey'], 'whmcs');
    $currency = strtoupper($params['currency']);
    if ($currency !== 'BRL' && $currency !== 'USD') {
        return '<div class="alert alert-warning">Moeda não suportada pelo LibreFlow Pay.</div>';
    }
    try {
        $invoice = $api->createInvoice(array(
            'price_amount' => LibreFlowApi::amount($params['amount']),
            'price_currency' => $currency,
            // O id da fatura do WHMCS e a idempotencia: reabrir a pagina
            // devolve a mesma fatura.
            'order_id' => 'whmcs-' . $params['invoiceid'],
            'order_description' => $params['description'],
            'customer_email' => $params['clientdetails']['email'],
            'success_url' => $params['returnurl'],
            'cancel_url' => $params['returnurl'],
            'ipn_callback_url' => rtrim($params['systemurl'], '/') . '/modules/gateways/callback/libreflow.php',
        ));
    } catch (Exception $e) {
        logModuleCall('libreflow', 'createInvoice', $params['invoiceid'], $e->getMessage());
        return '<div class="alert alert-danger">Não foi possível iniciar o pagamento. Tente de novo em instantes.</div>';
    }
    $url = htmlspecialchars($invoice['invoice_url'], ENT_QUOTES, 'UTF-8');
    $label = htmlspecialchars($params['langpaynow'], ENT_QUOTES, 'UTF-8');
    return '<a class="btn btn-primary" href="' . $url . '">' . $label . '</a>';
}
