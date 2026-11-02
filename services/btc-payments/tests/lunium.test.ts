import { describe, expect, it } from 'vitest';
import { LuniumClient, LuniumError } from '../src/adapters/lunium/client.js';
import { signWebhook } from '../src/crypto/hmac.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('LuniumClient', () => {
  it('envia a cobranca PIX com idempotencia e destino USDC Base', async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    const client = new LuniumClient({
      apiUrl: 'https://lunium.test',
      apiKey: 'lun_test_key',
      timeoutMs: 5_000,
      fetchImpl: async (url, init) => {
        captured = { url: String(url), init: init ?? {} };
        return jsonResponse({
          cashin_id: 'ci_123',
          status: 'pending',
          settlement_status: 'pending',
          amount_cents: 2500,
          qr_copypaste: '000201-pix',
          qr_image_url: 'https://img.test/qr.png',
          expires_at: '2026-10-30T20:00:00.000Z',
        }, 200);
      },
    });

    const charge = await client.createCharge({
      amountCents: 2500n,
      payerTaxNumber: '00000000191',
      payerName: 'Cliente',
      externalId: 'pix_local_1',
      asset: 'usdc',
      chain: 'base',
      payoutAddress: '0x1111111111111111111111111111111111111111',
    });

    expect(charge.cashin_id).toBe('ci_123');
    expect(captured).not.toBeNull();
    expect(captured!.url).toBe('https://lunium.test/cashin/charge');
    expect((captured!.init.headers as Record<string, string>)['x-api-key']).toBe(
      'lun_test_key',
    );
    expect(JSON.parse(String(captured!.init.body))).toMatchObject({
      amount_cents: 2500,
      payer_tax_number: '00000000191',
      destino: 'cripto',
      asset: 'usdc',
      chain: 'base',
      payout_address: '0x1111111111111111111111111111111111111111',
      external_id: 'pix_local_1',
    });
  });

  it('mapeia erro estavel da Lunium', async () => {
    const client = new LuniumClient({
      apiUrl: 'https://lunium.test',
      apiKey: 'lun_test_key',
      timeoutMs: 5_000,
      fetchImpl: async () =>
        jsonResponse(
          {
            erro: 'valor_abaixo_do_minimo',
            acao: 'corrigir',
            detail: 'valor minimo R$ 25,00',
            request_id: 'req_1',
          },
          400,
        ),
    });

    await expect(
      client.createCharge({
        amountCents: 1n,
        payerTaxNumber: '00000000191',
        externalId: 'pix_local_2',
        asset: 'usdc',
        chain: 'base',
        payoutAddress: '0x1111111111111111111111111111111111111111',
      }),
    ).rejects.toMatchObject({
      name: 'LuniumError',
      statusCode: 400,
      code: 'valor_abaixo_do_minimo',
      requestId: 'req_1',
    } satisfies Partial<LuniumError>);
  });


  it('mapeia erro estavel da Lunium sem depender do texto', async () => {
    const client = new LuniumClient({
      apiUrl: 'https://lunium.test',
      apiKey: 'lun_test_key',
      timeoutMs: 5_000,
      fetchImpl: async () =>
        jsonResponse(
          {
            erro: 'valor_abaixo_do_minimo',
            acao: 'corrigir',
            detail: 'valor muito baixo',
            request_id: 'req_2',
          },
          400,
        ),
    });

    await expect(
      client.createCharge({
        amountCents: 1n,
        payerTaxNumber: '00000000191',
        externalId: 'pix_local_2',
        asset: 'usdc',
        chain: 'base',
        payoutAddress: '0x1111111111111111111111111111111111111111',
      }),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: 'valor_abaixo_do_minimo',
      action: 'corrigir',
      requestId: 'req_2',
    });
  });

  it('valida a assinatura HMAC do webhook sobre o corpo bruto', () => {
    const body = JSON.stringify({
      event: 'cashin.settled',
      event_id: 'evt_1',
      data: { cashin_id: 'ci_123', status: 'paid', settlement_status: 'sent' },
    });
    const client = new LuniumClient({
      apiUrl: 'https://lunium.test',
      apiKey: 'lun_test_key',
      webhookSecret: 'secret',
      timeoutMs: 5_000,
    });
    const signature = signWebhook('secret', Math.floor(Date.now() / 1000), body);

    const verified = client.verifyWebhook({
      signature,
      rawBody: body,
      eventId: 'evt_1',
    });
    expect(verified.event).toBe('cashin.settled');
    expect(verified.eventId).toBe('evt_1');

    expect(() =>
      client.verifyWebhook({
        signature: signature.replace('v1=', 'v1=0'),
        rawBody: body,
        eventId: 'evt_1',
      }),
    ).toThrow(LuniumError);
  });
});
