<?php
/** IPN: confere assinatura, reconsulta a fatura e atualiza o pedido. */
class LibreflowPayIpnModuleFrontController extends ModuleFrontController
{
    public $ssl = true;
    public $display_column_left = false;
    public $display_column_right = false;

    public function postProcess()
    {
        $invoiceId = LibreFlowApi::readIpn((string) Configuration::get(LibreflowPay::CONF_SECRET));
        if ($invoiceId === null) {
            $this->finish(401, 'assinatura invalida');
        }
        try {
            $invoice = $this->module->api()->getInvoice($invoiceId);
        } catch (Exception $e) {
            $this->finish(503, 'falha ao consultar a fatura');
        }
        if (!preg_match('/^ps-([A-Z0-9]+)$/', (string) $invoice['order_id'], $m)) {
            $this->finish(200, 'ok');
        }
        $orders = Order::getByReference($m[1]);
        $order = $orders ? $orders->getFirst() : null;
        if (!$order || !Validate::isLoadedObject($order)) {
            $this->finish(200, 'ok');
        }
        $currency = new Currency((int) $order->id_currency);
        if (!LibreFlowApi::matches($invoice, $order->total_paid, $currency->iso_code)) {
            PrestaShopLogger::addLog('LibreFlow: valor da fatura nao confere com o pedido ' . $order->reference, 3, null, 'Order', (int) $order->id);
            $this->finish(200, 'ok');
        }
        $awaiting = (int) Configuration::get(LibreflowPay::CONF_STATE);
        $current = (int) $order->getCurrentState();
        if ($invoice['status'] === 'pago' && $current === $awaiting) {
            $history = new OrderHistory();
            $history->id_order = (int) $order->id;
            $history->changeIdOrderState((int) Configuration::get('PS_OS_PAYMENT'), $order, true);
            $history->addWithemail();
            $payments = $order->getOrderPaymentCollection();
            if (count($payments) > 0) {
                $payment = $payments->getFirst();
                $payment->transaction_id = $invoice['tx_hash'] ? $invoice['tx_hash'] : $invoice['id'];
                $payment->update();
            }
        } elseif (($invoice['status'] === 'expirado' || $invoice['status'] === 'cancelado') && $current === $awaiting) {
            $history = new OrderHistory();
            $history->id_order = (int) $order->id;
            $history->changeIdOrderState((int) Configuration::get('PS_OS_CANCELED'), $order);
            $history->add();
        }
        $this->finish(200, 'ok');
    }

    private function finish($code, $text)
    {
        http_response_code($code);
        header('Content-Type: text/plain');
        echo $text;
        exit;
    }
}
