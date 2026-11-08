<?php
namespace Libreflow\Pay\Controller\Ipn;

use Magento\Framework\App\CsrfAwareActionInterface;
use Magento\Framework\App\HttpPostActionInterface;
use Magento\Framework\App\Request\InvalidRequestException;
use Magento\Framework\App\RequestInterface;

/**
 * IPN: confere a assinatura (nao ha CSRF de formulario aqui: quem prova a
 * origem e o HMAC), reconsulta a fatura e atualiza o pedido.
 */
class Index implements HttpPostActionInterface, CsrfAwareActionInterface
{
    private $api;
    private $orderFactory;
    private $invoiceService;
    private $transaction;
    private $rawFactory;

    public function __construct(
        \Libreflow\Pay\Helper\Api $api,
        \Magento\Sales\Model\OrderFactory $orderFactory,
        \Magento\Sales\Model\Service\InvoiceService $invoiceService,
        \Magento\Framework\DB\Transaction $transaction,
        \Magento\Framework\Controller\Result\RawFactory $rawFactory
    ) {
        $this->api = $api;
        $this->orderFactory = $orderFactory;
        $this->invoiceService = $invoiceService;
        $this->transaction = $transaction;
        $this->rawFactory = $rawFactory;
    }

    public function createCsrfValidationException(RequestInterface $request): ?InvalidRequestException
    {
        return null;
    }

    public function validateForCsrf(RequestInterface $request): ?bool
    {
        return true;
    }

    private function reply($code, $text)
    {
        return $this->rawFactory->create()->setHttpResponseCode($code)->setContents($text);
    }

    public function execute()
    {
        $invoiceId = \LibreFlowApi::readIpn($this->api->ipnSecret());
        if ($invoiceId === null) {
            return $this->reply(401, 'assinatura invalida');
        }
        try {
            $invoice = $this->api->client()->getInvoice($invoiceId);
        } catch (\Exception $e) {
            return $this->reply(503, 'falha ao consultar a fatura');
        }
        if (!preg_match('/^mg-(.+)$/', (string) $invoice['order_id'], $m)) {
            return $this->reply(200, 'ok');
        }
        $order = $this->orderFactory->create()->loadByIncrementId($m[1]);
        if (!$order->getId()) {
            return $this->reply(200, 'ok');
        }
        if (!\LibreFlowApi::matches($invoice, $order->getGrandTotal(), $order->getOrderCurrencyCode())) {
            $order->addCommentToStatusHistory('LibreFlow: valor da fatura não confere com o pedido; nada foi alterado.')->save();
            return $this->reply(200, 'ok');
        }
        $pending = $order->getState() === \Magento\Sales\Model\Order::STATE_PENDING_PAYMENT;
        if ($invoice['status'] === 'pago' && $pending) {
            $txId = $invoice['tx_hash'] ? $invoice['tx_hash'] : $invoice['id'];
            $payment = $order->getPayment();
            $payment->setTransactionId($txId)->setLastTransId($txId)->setIsTransactionClosed(true);
            if ($order->canInvoice()) {
                $salesInvoice = $this->invoiceService->prepareInvoice($order);
                $salesInvoice->setRequestedCaptureCase(\Magento\Sales\Model\Order\Invoice::CAPTURE_OFFLINE);
                $salesInvoice->setTransactionId($txId);
                $salesInvoice->register();
                $this->transaction->addObject($salesInvoice)->addObject($order);
            }
            $order->setState(\Magento\Sales\Model\Order::STATE_PROCESSING)->setStatus('processing');
            $order->addCommentToStatusHistory('LibreFlow: pago com ' . $invoice['paid_rail'] . ($invoice['mode'] === 'test' ? ' (TESTE: nenhum dinheiro foi recebido)' : ''));
            $this->transaction->addObject($order)->save();
        } elseif (in_array($invoice['status'], array('expirado', 'cancelado'), true) && $pending) {
            $order->cancel();
            $order->addCommentToStatusHistory('LibreFlow: fatura expirada sem pagamento.');
            $order->save();
        }
        return $this->reply(200, 'ok');
    }
}
