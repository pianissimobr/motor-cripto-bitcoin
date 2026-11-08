<?php
namespace Opencart\Catalog\Controller\Extension\Libreflow\Payment;

class Libreflow extends \Opencart\System\Engine\Controller
{
    private function api(): \LibreFlowApi
    {
        require_once DIR_EXTENSION . 'libreflow/system/library/LibreFlowApi.php';
        return new \LibreFlowApi($this->config->get('payment_libreflow_api_base'), $this->config->get('payment_libreflow_store_key'), 'opencart');
    }

    /** Botao "Confirmar pedido" no checkout. */
    public function index(): string
    {
        $this->load->language('extension/libreflow/payment/libreflow');
        $data['language'] = $this->config->get('config_language');
        return $this->load->view('extension/libreflow/payment/libreflow', $data);
    }

    /** Confirma o pedido como "aguardando", cria a fatura e devolve o redirect. */
    public function confirm(): void
    {
        $this->load->language('extension/libreflow/payment/libreflow');
        $json = array();
        if (!isset($this->session->data['order_id'])) {
            $json['error'] = $this->language->get('error_order');
        } elseif (!isset($this->session->data['payment_method']) || strpos($this->session->data['payment_method']['code'] ?? $this->session->data['payment_method'], 'libreflow') !== 0) {
            $json['error'] = $this->language->get('error_payment_method');
        }
        if (!$json) {
            $this->load->model('checkout/order');
            $orderId = (int) $this->session->data['order_id'];
            $order = $this->model_checkout_order->getOrder($orderId);
            $total = $this->currency->format($order['total'], $order['currency_code'], $order['currency_value'], false);
            try {
                $invoice = $this->api()->createInvoice(array(
                    'price_amount' => \LibreFlowApi::amount($total),
                    'price_currency' => strtoupper($order['currency_code']),
                    'order_id' => 'oc-' . $orderId,
                    'order_description' => sprintf('Pedido #%d', $orderId),
                    'customer_email' => $order['email'],
                    'success_url' => $this->url->link('checkout/success', 'language=' . $this->config->get('config_language')),
                    'cancel_url' => $this->url->link('checkout/checkout', 'language=' . $this->config->get('config_language')),
                    'ipn_callback_url' => $this->url->link('extension/libreflow/payment/libreflow.callback'),
                ));
                $this->model_checkout_order->addHistory($orderId, (int) $this->config->get('payment_libreflow_pending_status_id'), 'Fatura LibreFlow: ' . $invoice['id'] . ($invoice['mode'] === 'test' ? ' (TESTE)' : ''));
                $json['redirect'] = $invoice['invoice_url'];
            } catch (\Exception $e) {
                $json['error'] = sprintf($this->language->get('error_create'), $e->getMessage());
            }
        }
        $this->response->addHeader('Content-Type: application/json');
        $this->response->setOutput(json_encode($json));
    }

    /** IPN: confere assinatura, reconsulta a fatura e atualiza o pedido. */
    public function callback(): void
    {
        $invoiceId = \LibreFlowApi::readIpn((string) $this->config->get('payment_libreflow_ipn_secret'));
        if ($invoiceId === null) {
            http_response_code(401);
            $this->response->setOutput('assinatura invalida');
            return;
        }
        try {
            $invoice = $this->api()->getInvoice($invoiceId);
        } catch (\Exception $e) {
            http_response_code(503);
            $this->response->setOutput('falha ao consultar a fatura');
            return;
        }
        if (!preg_match('/^oc-(\d+)$/', (string) $invoice['order_id'], $m)) {
            $this->response->setOutput('ok');
            return;
        }
        $this->load->model('checkout/order');
        $order = $this->model_checkout_order->getOrder((int) $m[1]);
        if (!$order) {
            $this->response->setOutput('ok');
            return;
        }
        $total = $this->currency->format($order['total'], $order['currency_code'], $order['currency_value'], false);
        if (!\LibreFlowApi::matches($invoice, $total, $order['currency_code'])) {
            $this->model_checkout_order->addHistory((int) $m[1], (int) $order['order_status_id'], 'LibreFlow: valor da fatura não confere com o pedido; nada foi alterado.');
        } elseif ($invoice['status'] === 'pago' && (int) $order['order_status_id'] !== (int) $this->config->get('payment_libreflow_order_status_id')) {
            $note = 'LibreFlow: pago (' . $invoice['paid_rail'] . ')' . ($invoice['mode'] === 'test' ? ' — TESTE, nenhum dinheiro recebido' : '') . ($invoice['tx_hash'] ? ' · ' . $invoice['tx_hash'] : '');
            $this->model_checkout_order->addHistory((int) $m[1], (int) $this->config->get('payment_libreflow_order_status_id'), $note, true);
        }
        $this->response->setOutput('ok');
    }
}
