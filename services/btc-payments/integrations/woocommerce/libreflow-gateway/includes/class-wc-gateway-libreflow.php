<?php
if (!defined('ABSPATH')) {
    exit;
}

/**
 * Meio de pagamento "LibreFlow Pay": cria a fatura hospedada, manda o
 * cliente para ela e marca o pedido como pago quando chega o IPN.
 */
class WC_Gateway_LibreFlow extends WC_Payment_Gateway
{
    const META_INVOICE = '_libreflow_invoice_id';

    public function __construct()
    {
        $this->id = 'libreflow';
        $this->method_title = 'LibreFlow Pay';
        $this->method_description = 'Pix e Bitcoin, liquidados em dólar digital (USDC) direto na carteira da loja. O cliente paga numa página segura e a loja é avisada automaticamente.';
        $this->has_fields = false;
        $this->supports = array('products');

        $this->init_form_fields();
        $this->init_settings();

        $this->title = $this->get_option('title');
        $this->description = $this->get_option('description');
        $this->enabled = $this->get_option('enabled');

        add_action('woocommerce_update_options_payment_gateways_' . $this->id, array($this, 'process_admin_options'));
        add_action('woocommerce_api_libreflow_ipn', array($this, 'handle_ipn'));
    }

    public function init_form_fields()
    {
        $this->form_fields = array(
            'enabled' => array(
                'title' => 'Ativar',
                'type' => 'checkbox',
                'label' => 'Aceitar pagamentos com LibreFlow Pay',
                'default' => 'no',
            ),
            'title' => array(
                'title' => 'Nome no checkout',
                'type' => 'text',
                'default' => 'Pix ou Bitcoin',
            ),
            'description' => array(
                'title' => 'Descrição no checkout',
                'type' => 'textarea',
                'default' => 'Você será levado a uma página segura para pagar com Pix ou Bitcoin.',
            ),
            'api_base' => array(
                'title' => 'Endereço da API',
                'type' => 'text',
                'default' => 'https://cripto.libreflowdigital.com',
            ),
            'store_key' => array(
                'title' => 'Chave de loja',
                'type' => 'password',
                'description' => 'Gerada no painel, em Integração e API. Comece pela chave de teste (mk_store_test_…).',
                'default' => '',
            ),
            'ipn_secret' => array(
                'title' => 'Segredo IPN',
                'type' => 'password',
                'description' => 'Mostrado junto com a chave. Confere que o aviso de pagamento veio mesmo da LibreFlow.',
                'default' => '',
            ),
            'expires' => array(
                'title' => 'Validade da fatura (minutos)',
                'type' => 'number',
                'default' => '60',
                'custom_attributes' => array('min' => 15, 'max' => 1440),
            ),
        );
    }

    private function client()
    {
        return new LibreFlow_Client($this->get_option('api_base'), $this->get_option('store_key'));
    }

    /** Ao salvar, testa a conexao e mostra o resultado (o "Testar conexao"). */
    public function process_admin_options()
    {
        $saved = parent::process_admin_options();
        if ($this->get_option('store_key') === '') {
            return $saved;
        }
        $ping = $this->client()->ping();
        if (is_wp_error($ping)) {
            WC_Admin_Settings::add_error('LibreFlow Pay: não foi possível conectar (' . $ping->get_error_message() . ').');
        } else {
            $mode = $ping['mode'] === 'test' ? 'TESTE (nenhum dinheiro é cobrado)' : 'PRODUÇÃO';
            WC_Admin_Settings::add_message('LibreFlow Pay conectado à loja "' . $ping['merchant_name'] . '" em modo ' . $mode . '.');
        }
        return $saved;
    }

    public function is_available()
    {
        if (!parent::is_available() || $this->get_option('store_key') === '') {
            return false;
        }
        // Pix e em real; em dolar o motor oferece so Bitcoin.
        return in_array(get_woocommerce_currency(), array('BRL', 'USD'), true);
    }

    public function process_payment($order_id)
    {
        $order = wc_get_order($order_id);
        $body = array(
            'price_amount' => wc_format_decimal($order->get_total(), 2),
            'price_currency' => $order->get_currency(),
            // Pedido + chave do pedido: um novo pedido com o mesmo numero
            // (ex.: loja reinstalada) nao reaproveita fatura antiga.
            'order_id' => $order->get_order_number() . '-' . substr($order->get_order_key(), -6),
            'order_description' => sprintf('Pedido #%s', $order->get_order_number()),
            'success_url' => $this->get_return_url($order),
            'cancel_url' => $order->get_cancel_order_url_raw(),
            'ipn_callback_url' => WC()->api_request_url('libreflow_ipn'),
            'expires_in_minutes' => max(15, min(1440, (int) $this->get_option('expires', 60))),
        );
        $email = $order->get_billing_email();
        if ($email) {
            $body['customer_email'] = $email;
        }

        $invoice = $this->client()->create_invoice($body);
        if (is_wp_error($invoice)) {
            wc_add_notice('Não foi possível iniciar o pagamento: ' . $invoice->get_error_message(), 'error');
            return array('result' => 'failure');
        }

        $order->update_meta_data(self::META_INVOICE, $invoice['id']);
        $order->update_status('pending', 'Fatura LibreFlow criada: ' . $invoice['id'] . ($invoice['mode'] === 'test' ? ' (TESTE)' : ''));
        $order->save();

        return array('result' => 'success', 'redirect' => $invoice['invoice_url']);
    }

    /**
     * IPN: confere a assinatura, busca a fatura de novo na API (o corpo do
     * aviso nunca e a unica prova) e atualiza o pedido.
     */
    public function handle_ipn()
    {
        $raw = file_get_contents('php://input');
        $signature = isset($_SERVER['HTTP_X_WEBHOOK_SIGNATURE']) ? wp_unslash($_SERVER['HTTP_X_WEBHOOK_SIGNATURE']) : '';
        if (!LibreFlow_Client::verify_signature($raw, $signature, $this->get_option('ipn_secret'))) {
            status_header(401);
            exit('assinatura invalida');
        }
        $payload = json_decode($raw, true);
        $invoice_id = isset($payload['data']['id']) ? sanitize_text_field($payload['data']['id']) : '';
        if ($invoice_id === '') {
            status_header(400);
            exit('sem fatura');
        }

        $orders = wc_get_orders(array('limit' => 1, 'meta_key' => self::META_INVOICE, 'meta_value' => $invoice_id));
        $order = $orders ? $orders[0] : null;
        if (!$order) {
            // Fatura de outro sistema: confirma o recebimento e ignora.
            status_header(200);
            exit('ok');
        }

        $invoice = $this->client()->get_invoice($invoice_id);
        if (is_wp_error($invoice)) {
            // A LibreFlow tenta de novo depois.
            status_header(503);
            exit('falha ao consultar a fatura');
        }

        $total = wc_format_decimal($order->get_total(), 2);
        if ($invoice['price_amount'] !== $total || $invoice['price_currency'] !== $order->get_currency()) {
            $order->add_order_note('LibreFlow: valor da fatura não confere com o pedido; nada foi alterado.');
            status_header(200);
            exit('ok');
        }

        switch ($invoice['status']) {
            case 'pago':
                if (!$order->is_paid()) {
                    $rail = $invoice['paid_rail'] === 'bitcoin' ? 'Bitcoin' : 'Pix';
                    $order->payment_complete($invoice['tx_hash'] ? $invoice['tx_hash'] : $invoice_id);
                    $order->add_order_note(sprintf('LibreFlow: pago com %s%s.', $rail, $invoice['mode'] === 'test' ? ' (TESTE: nenhum dinheiro foi recebido)' : ''));
                }
                break;
            case 'confirmando':
                if ($order->has_status('pending')) {
                    $order->update_status('on-hold', 'LibreFlow: pagamento recebido, aguardando confirmação na rede.');
                }
                break;
            case 'expirado':
            case 'cancelado':
                if ($order->has_status(array('pending', 'on-hold'))) {
                    $order->update_status('cancelled', 'LibreFlow: fatura expirada sem pagamento.');
                }
                break;
        }

        status_header(200);
        exit('ok');
    }
}
