<?php
namespace Libreflow\Pay\Model\Payment;

/**
 * Meio de pagamento com redirecionamento: o pedido nasce em
 * pending_payment e o IPN o move para processing.
 */
class Libreflow extends \Magento\Payment\Model\Method\AbstractMethod
{
    const CODE = 'libreflow';

    protected $_code = self::CODE;
    protected $_isOffline = false;
    protected $_isInitializeNeeded = true;
    protected $_canUseInternal = false;
    protected $_canUseCheckout = true;

    public function initialize($paymentAction, $stateObject)
    {
        $stateObject->setState(\Magento\Sales\Model\Order::STATE_PENDING_PAYMENT);
        $stateObject->setStatus('pending_payment');
        $stateObject->setIsNotified(false);
        return $this;
    }

    public function canUseForCurrency($currencyCode)
    {
        return in_array(strtoupper($currencyCode), array('BRL', 'USD'), true);
    }

    public function isAvailable(\Magento\Quote\Api\Data\CartInterface $quote = null)
    {
        return parent::isAvailable($quote) && (string) $this->getConfigData('store_key') !== '';
    }
}
