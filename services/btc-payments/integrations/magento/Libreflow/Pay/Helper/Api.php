<?php
namespace Libreflow\Pay\Helper;

require_once __DIR__ . '/../lib/LibreFlowApi.php';

class Api
{
    private $scopeConfig;
    private $encryptor;

    public function __construct(
        \Magento\Framework\App\Config\ScopeConfigInterface $scopeConfig,
        \Magento\Framework\Encryption\EncryptorInterface $encryptor
    ) {
        $this->scopeConfig = $scopeConfig;
        $this->encryptor = $encryptor;
    }

    private function config($field)
    {
        return (string) $this->scopeConfig->getValue('payment/libreflow/' . $field, \Magento\Store\Model\ScopeInterface::SCOPE_STORE);
    }

    public function client()
    {
        return new \LibreFlowApi($this->config('api_base'), $this->encryptor->decrypt($this->config('store_key')), 'magento');
    }

    public function ipnSecret()
    {
        return $this->encryptor->decrypt($this->config('ipn_secret'));
    }
}
