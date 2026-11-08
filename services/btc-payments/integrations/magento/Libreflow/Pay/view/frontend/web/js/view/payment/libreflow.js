define(['uiComponent', 'Magento_Checkout/js/model/payment/renderer-list'], function (Component, rendererList) {
    'use strict';
    rendererList.push({ type: 'libreflow', component: 'Libreflow_Pay/js/view/payment/method-renderer/libreflow-method' });
    return Component.extend({});
});
