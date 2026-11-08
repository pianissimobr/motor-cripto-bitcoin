define(['Magento_Checkout/js/view/payment/default', 'mage/url'], function (Component, url) {
    'use strict';
    return Component.extend({
        defaults: { template: 'Libreflow_Pay/payment/libreflow' },
        // Fecha o pedido e so depois leva o cliente para a pagina de pagamento.
        redirectAfterPlaceOrder: false,
        afterPlaceOrder: function () {
            window.location.replace(url.build('libreflow/redirect'));
        }
    });
});
