<?php
if (!defined('ABSPATH')) {
    exit;
}

use Automattic\WooCommerce\Blocks\Payments\Integrations\AbstractPaymentMethodType;

/** Mostra o meio de pagamento no checkout em blocos. */
final class LibreFlow_Blocks_Support extends AbstractPaymentMethodType
{
    protected $name = 'libreflow';

    public function initialize()
    {
        $this->settings = get_option('woocommerce_libreflow_settings', array());
    }

    public function is_active()
    {
        return !empty($this->settings['enabled']) && $this->settings['enabled'] === 'yes' && !empty($this->settings['store_key']);
    }

    public function get_payment_method_script_handles()
    {
        wp_register_script(
            'libreflow-blocks',
            plugins_url('assets/blocks.js', LIBREFLOW_GATEWAY_FILE),
            array('wc-blocks-registry', 'wc-settings', 'wp-element', 'wp-html-entities'),
            LIBREFLOW_GATEWAY_VERSION,
            true
        );
        return array('libreflow-blocks');
    }

    public function get_payment_method_data()
    {
        return array(
            'title' => isset($this->settings['title']) ? $this->settings['title'] : 'Pix ou Bitcoin',
            'description' => isset($this->settings['description']) ? $this->settings['description'] : '',
        );
    }
}
