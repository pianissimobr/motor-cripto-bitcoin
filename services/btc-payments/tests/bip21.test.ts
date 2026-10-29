import { describe, expect, it } from 'vitest';
import { buildBip21, buildLnbitsWebhookUrl } from '../src/domain/bip21.js';

describe('bip21', () => {
  it('monta URI com amount, label e lightning codificados', () => {
    const uri = buildBip21({
      address: 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu',
      amountSats: 10_000n,
      label: 'Pedido 123',
      lightning: 'lnbc10u1p...',
    });
    expect(uri).toBe(
      'bitcoin:bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu?amount=0.00010000&label=Pedido%20123&lightning=lnbc10u1p...',
    );
  });

  it('omite label/lightning quando ausentes', () => {
    const uri = buildBip21({
      address: 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu',
      amountSats: 1n,
    });
    expect(uri).toBe(
      'bitcoin:bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu?amount=0.00000001',
    );
  });

  it('monta a URL de webhook do LNbits', () => {
    expect(
      buildLnbitsWebhookUrl('https://api.example.com/', 'token com espaço'),
    ).toBe('https://api.example.com/webhooks/lnbits?token=token%20com%20espa%C3%A7o');
  });
});
