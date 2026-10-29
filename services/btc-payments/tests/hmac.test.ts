import { describe, expect, it } from 'vitest';
import {
  buildCanonicalRequest,
  signRequest,
  signWebhook,
  verifyRequestSignature,
  verifyWebhookSignature,
} from '../src/crypto/hmac.js';

const secret = 'segredo-de-teste';
const request = {
  method: 'POST',
  path: '/v1/payment-intents',
  timestamp: '1800000000',
  nonce: 'nonce-123',
  body: JSON.stringify({ external_id: 'pedido-1', amount_sats: 10000 }),
};

describe('hmac', () => {
  it('assina e verifica a requisicao', () => {
    const signature = signRequest(secret, request);
    expect(
      verifyRequestSignature(secret, request, signature),
    ).toBe(true);
    expect(
      verifyRequestSignature(secret, { ...request, body: '{}' }, signature),
    ).toBe(false);
  });

  it('ignora a query string no caminho canonico', () => {
    const canonical = buildCanonicalRequest({
      ...request,
      path: '/v1/payment-intents?foo=bar',
    });
    expect(canonical.split('\n')[1]).toBe('/v1/payment-intents');
  });

  it('assina e verifica webhook com janela de tempo', () => {
    const now = 1_800_000_000;
    const header = signWebhook(secret, now, '{"event":"paid"}');
    expect(
      verifyWebhookSignature({
        secret,
        header,
        body: '{"event":"paid"}',
        nowSeconds: now,
      }),
    ).toBe(true);
    expect(
      verifyWebhookSignature({
        secret,
        header,
        body: '{"event":"tampered"}',
        nowSeconds: now,
      }),
    ).toBe(false);
    expect(
      verifyWebhookSignature({
        secret,
        header,
        body: '{"event":"paid"}',
        nowSeconds: now + 301,
      }),
    ).toBe(false);
  });
});
