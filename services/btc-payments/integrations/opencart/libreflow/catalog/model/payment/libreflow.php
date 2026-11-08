<?php
namespace Opencart\Catalog\Model\Extension\Libreflow\Payment;

class Libreflow extends \Opencart\System\Engine\Model
{
    /** OpenCart 4.0.2+ */
    public function getMethods(array $address = array()): array
    {
        $this->load->language('extension/libreflow/payment/libreflow');
        if (!$this->available()) {
            return array();
        }
        $option['libreflow'] = array('code' => 'libreflow.libreflow', 'name' => $this->language->get('heading_title'));
        return array(
            'code' => 'libreflow',
            'name' => $this->language->get('heading_title'),
            'option' => $option,
            'sort_order' => $this->config->get('payment_libreflow_sort_order'),
        );
    }

    /** OpenCart 4.0.0 a 4.0.1 */
    public function getMethod(array $address = array()): array
    {
        $this->load->language('extension/libreflow/payment/libreflow');
        if (!$this->available()) {
            return array();
        }
        return array(
            'code' => 'libreflow',
            'title' => $this->language->get('heading_title'),
            'sort_order' => $this->config->get('payment_libreflow_sort_order'),
        );
    }

    private function available(): bool
    {
        $currency = isset($this->session->data['currency']) ? strtoupper($this->session->data['currency']) : '';
        return (bool) $this->config->get('payment_libreflow_status')
            && (string) $this->config->get('payment_libreflow_store_key') !== ''
            && in_array($currency, array('BRL', 'USD'), true);
    }
}
