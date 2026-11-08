// Script do checkout Nuvemshop (checkout_js_url do provedor LibreFlow Pay).
// Registra a opcao "Pix, Bitcoin ou USDC" e, ao finalizar, manda o cliente
// para a fatura hospedada.
LoadCheckoutPaymentContext(function (Checkout, PaymentOptions) {
  var option = PaymentOptions.ExternalPayment({
    id: 'libreflow_redirect',
    version: 'v2',
    onSubmit: function () {
      var urls = Checkout.getData('callbackUrls') || {};
      Checkout.processPayment({
        email: Checkout.getData('order.contact.email'),
        success_url: urls.success,
        cancel_url: urls.cancel || urls.failure,
      })
        .then(function (response) {
          window.parent.location.href = response.redirect_url;
        })
        .catch(function (error) {
          var message = error && error.response && error.response.data && error.response.data.message;
          Checkout.showErrorCode(message || 'payment_processing_error');
        });
    },
  });
  Checkout.addPaymentOption(option);
});
