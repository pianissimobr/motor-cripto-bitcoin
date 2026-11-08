<?php
namespace Libreflow\Pay\Controller\Redirect;

use Magento\Framework\App\Action\HttpGetActionInterface;

/** Depois de fechar o pedido: cria a fatura e leva o cliente para pagar. */
class Index implements HttpGetActionInterface
{
    private $checkoutSession;
    private $api;
    private $redirectFactory;
    private $url;
    private $messageManager;
    private $logger;

    public function __construct(
        \Magento\Checkout\Model\Session $checkoutSession,
        \Libreflow\Pay\Helper\Api $api,
        \Magento\Framework\Controller\Result\RedirectFactory $redirectFactory,
        \Magento\Framework\UrlInterface $url,
        \Magento\Framework\Message\ManagerInterface $messageManager,
        \Psr\Log\LoggerInterface $logger
    ) {
        $this->checkoutSession = $checkoutSession;
        $this->api = $api;
        $this->redirectFactory = $redirectFactory;
        $this->url = $url;
        $this->messageManager = $messageManager;
        $this->logger = $logger;
    }

    public function execute()
    {
        $redirect = $this->redirectFactory->create();
        $order = $this->checkoutSession->getLastRealOrder();
        if (!$order || !$order->getId() || $order->getPayment()->getMethod() !== \Libreflow\Pay\Model\Payment\Libreflow::CODE) {
            return $redirect->setPath('checkout/cart');
        }
        try {
            $invoice = $this->api->client()->createInvoice(array(
                'price_amount' => \LibreFlowApi::amount($order->getGrandTotal()),
                'price_currency' => strtoupper($order->getOrderCurrencyCode()),
                'order_id' => 'mg-' . $order->getIncrementId(),
                'order_description' => 'Pedido #' . $order->getIncrementId(),
                'customer_email' => $order->getCustomerEmail(),
                'success_url' => $this->url->getUrl('checkout/onepage/success'),
                'cancel_url' => $this->url->getUrl('checkout/cart'),
                'ipn_callback_url' => $this->url->getUrl('libreflow/ipn'),
            ));
        } catch (\Exception $e) {
            $this->logger->error('LibreFlow: ' . $e->getMessage());
            $this->messageManager->addErrorMessage(__('Não foi possível iniciar o pagamento. Tente de novo.'));
            $this->checkoutSession->restoreQuote();
            return $redirect->setPath('checkout/cart');
        }
        $order->addCommentToStatusHistory('Fatura LibreFlow: ' . $invoice['id'] . ($invoice['mode'] === 'test' ? ' (TESTE)' : ''));
        $order->save();
        return $redirect->setUrl($invoice['invoice_url']);
    }
}
