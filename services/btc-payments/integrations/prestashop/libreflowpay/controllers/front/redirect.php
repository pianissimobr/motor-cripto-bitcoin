<?php
/**
 * Cria o pedido em "Aguardando pagamento LibreFlow", a fatura no LibreFlow
 * e leva o cliente para pagar.
 */
class LibreflowPayRedirectModuleFrontController extends ModuleFrontController
{
    public function postProcess()
    {
        $cart = $this->context->cart;
        if (!$cart->id || !$cart->id_customer || !$cart->id_address_delivery || !$this->module->active) {
            Tools::redirect('index.php?controller=order&step=1');
        }
        $customer = new Customer((int) $cart->id_customer);
        if (!Validate::isLoadedObject($customer)) {
            Tools::redirect('index.php?controller=order&step=1');
        }
        $currency = new Currency((int) $cart->id_currency);
        $total = (float) $cart->getOrderTotal(true, Cart::BOTH);

        $this->module->validateOrder(
            (int) $cart->id,
            (int) Configuration::get(LibreflowPay::CONF_STATE),
            $total,
            $this->module->displayName,
            null,
            array(),
            (int) $currency->id,
            false,
            $customer->secure_key
        );
        $order = new Order((int) $this->module->currentOrder);

        $successUrl = $this->context->link->getPageLink('order-confirmation', true, null, array(
            'id_cart' => (int) $cart->id,
            'id_module' => (int) $this->module->id,
            'id_order' => (int) $order->id,
            'key' => $customer->secure_key,
        ));
        try {
            $invoice = $this->module->api()->createInvoice(array(
                'price_amount' => LibreFlowApi::amount($total),
                'price_currency' => strtoupper($currency->iso_code),
                'order_id' => 'ps-' . $order->reference,
                'order_description' => 'Pedido ' . $order->reference,
                'customer_email' => $customer->email,
                'success_url' => $successUrl,
                'cancel_url' => $this->context->link->getPageLink('history', true),
                'ipn_callback_url' => $this->context->link->getModuleLink($this->module->name, 'ipn', array(), true),
            ));
        } catch (Exception $e) {
            PrestaShopLogger::addLog('LibreFlow: ' . $e->getMessage(), 3, null, 'Order', (int) $order->id);
            $this->errors[] = 'Não foi possível iniciar o pagamento. Tente de novo pelo histórico de pedidos.';
            $this->redirectWithNotifications($this->context->link->getPageLink('history', true));
            return;
        }
        Db::getInstance()->insert('message', array(
            'id_order' => (int) $order->id,
            'id_customer' => (int) $customer->id,
            'message' => pSQL('Fatura LibreFlow: ' . $invoice['id'] . ($invoice['mode'] === 'test' ? ' (TESTE)' : '')),
            'private' => 1,
            'date_add' => date('Y-m-d H:i:s'),
        ));
        Tools::redirect($invoice['invoice_url']);
    }
}
