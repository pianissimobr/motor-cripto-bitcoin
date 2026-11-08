(function () {
  const settings = window.wc.wcSettings.getSetting('libreflow_data', {});
  const { decodeEntities } = window.wp.htmlEntities;
  const el = window.wp.element.createElement;
  const label = decodeEntities(settings.title || 'Pix ou Bitcoin');
  const Content = () => el('div', null, decodeEntities(settings.description || ''));
  window.wc.wcBlocksRegistry.registerPaymentMethod({
    name: 'libreflow',
    label: el('span', null, label),
    content: el(Content),
    edit: el(Content),
    canMakePayment: () => true,
    ariaLabel: label,
    supports: { features: ['products'] },
  });
})();
