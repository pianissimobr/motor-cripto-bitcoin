<?php
/**
 * Plugin Name:       LibreFlow Pay para WooCommerce
 * Description:       Receba em Pix e Bitcoin, liquidado em dólar digital (USDC) direto na sua carteira.
 * Version:           0.1.0
 * Requires at least: 6.0
 * Requires PHP:      7.4
 * Author:            LibreFlow Digital
 * License:           GPL-2.0-or-later
 * Text Domain:       libreflow-gateway
 * WC requires at least: 7.0
 */

if (!defined('ABSPATH')) {
    exit;
}

define('LIBREFLOW_GATEWAY_VERSION', '0.1.0');
define('LIBREFLOW_GATEWAY_FILE', __FILE__);

// Compatibilidade com o armazenamento de pedidos (HPOS) e o checkout em blocos.
add_action('before_woocommerce_init', function () {
    if (class_exists('\Automattic\WooCommerce\Utilities\FeaturesUtil')) {
        \Automattic\WooCommerce\Utilities\FeaturesUtil::declare_compatibility('custom_order_tables', __FILE__, true);
        \Automattic\WooCommerce\Utilities\FeaturesUtil::declare_compatibility('cart_checkout_blocks', __FILE__, true);
    }
});

add_action('plugins_loaded', function () {
    if (!class_exists('WC_Payment_Gateway')) {
        return;
    }
    require_once __DIR__ . '/includes/class-libreflow-client.php';
    require_once __DIR__ . '/includes/class-wc-gateway-libreflow.php';

    add_filter('woocommerce_payment_gateways', function ($gateways) {
        $gateways[] = 'WC_Gateway_LibreFlow';
        return $gateways;
    });
});

// Checkout em blocos (WooCommerce 8.3+ usa por padrao).
add_action('woocommerce_blocks_loaded', function () {
    if (!class_exists('\Automattic\WooCommerce\Blocks\Payments\Integrations\AbstractPaymentMethodType')) {
        return;
    }
    require_once __DIR__ . '/includes/class-libreflow-blocks.php';
    add_action('woocommerce_blocks_payment_method_type_registration', function ($registry) {
        $registry->register(new LibreFlow_Blocks_Support());
    });
});

add_filter('plugin_action_links_' . plugin_basename(__FILE__), function ($links) {
    $url = admin_url('admin.php?page=wc-settings&tab=checkout&section=libreflow');
    array_unshift($links, '<a href="' . esc_url($url) . '">' . esc_html__('Configurações', 'libreflow-gateway') . '</a>');
    return $links;
});
