/**
 * Motor Cripto — snippet de checkout embutível.
 *
 * Inclua:
 *   <script src="https://SEU-DOMINIO/checkout.js" defer></script>
 *
 * Use com atributo de dados em qualquer elemento clicável:
 *   <button data-motor-checkout="<payment_id>">Pagar</button>
 *
 * Ou programaticamente:
 *   MotorCheckout.open('<payment_id>');
 */
(function (global) {
  function open(paymentId) {
    if (!paymentId) throw new Error('MotorCheckout: payment_id ausente');
    const url = '/pay/' + encodeURIComponent(paymentId);
    const name = 'motor-checkout';
    const width = 480;
    const height = 760;
    const left = Math.max(0, Math.round((window.screenX || 0) + (window.outerWidth - width) / 2));
    const top = Math.max(0, Math.round((window.screenY || 0) + (window.outerHeight - height) / 2));
    const features = [
      'popup=yes',
      'width=' + width,
      'height=' + height,
      'left=' + left,
      'top=' + top,
      'noopener,noreferrer',
    ].join(',');
    window.open(url, name, features);
  }

  function bind() {
    document.querySelectorAll('[data-motor-checkout]').forEach(function (el) {
      if (el.__motorBound) return;
      el.__motorBound = true;
      el.addEventListener('click', function (event) {
        event.preventDefault();
        open(el.getAttribute('data-motor-checkout') || '');
      });
    });
  }

  function init() {
    bind();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  global.MotorCheckout = { open, bind, init };
})(window);