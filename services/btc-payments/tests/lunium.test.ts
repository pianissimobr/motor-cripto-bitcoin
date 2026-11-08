import { describe, expect, it } from 'vitest';
import { isRetryable, LuniumClient, LuniumError } from '../src/adapters/lunium/client.js';
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

  it('consulta os limites do pagador uma vez e reaproveita o cache', async () => {
    let chamadas = 0;
    const client = new LuniumClient({
      apiUrl: 'https://lunium.test',
      apiKey: 'lun_test_key',
      timeoutMs: 5_000,
      limitsCacheMs: 60_000,
      fetchImpl: async () => {
        chamadas++;
        return jsonResponse({ max_amount_cents: 100_000 });
      },
    });

    await client.getLimits('00000000191');
    await client.getLimits('00000000191');
    await client.getLimits('00000000191');

    expect(chamadas).toBe(1);
  });

  it('nao reaproveita o cache dos limites entre pagadores diferentes', async () => {
    let chamadas = 0;
    const client = new LuniumClient({
      apiUrl: 'https://lunium.test',
      apiKey: 'lun_test_key',
      timeoutMs: 5_000,
      limitsCacheMs: 60_000,
      fetchImpl: async () => {
        chamadas++;
        return jsonResponse({ max_amount_cents: 100_000 });
      },
    });

    await client.getLimits('00000000191');
    await client.getLimits('00000000192');

    expect(chamadas).toBe(2);
  });

  it('mantem o catalogo em cache', async () => {
    let chamadas = 0;
    const client = new LuniumClient({
      apiUrl: 'https://lunium.test',
      apiKey: 'lun_test_key',
      timeoutMs: 5_000,
      catalogCacheMs: 60_000,
      fetchImpl: async () => {
        chamadas++;
        return jsonResponse({ fast: [{ asset: 'usdc', network: 'polygon' }] });
      },
    });

    const a = await client.getCatalog();
    const b = await client.getCatalog();

    expect(chamadas).toBe(1);
    expect(a).toEqual(b);
  });

  it('reduz o teto e espera o retry-after quando a Lunium recusa por limite', async () => {
    let chamadas = 0;
    const client = new LuniumClient({
      apiUrl: 'https://lunium.test',
      apiKey: 'lun_test_key',
      timeoutMs: 5_000,
      rateLimit: { maxRequests: 60, windowMs: 100 },
      fetchImpl: async () => {
        chamadas++;
        return new Response(JSON.stringify({ erro: 'limite_excedido' }), {
          status: 429,
          headers: { 'content-type': 'application/json', 'retry-after': '1' },
        });
      },
    });

    await expect(client.getCatalog()).rejects.toMatchObject({
      statusCode: 429,
      code: 'limite_excedido',
    });

    expect(chamadas).toBe(3); // duas tentativas e o erro final
    expect(client.rateLimiter.currentLimit).toBeLessThan(60);
  }, 20_000);

  it('respeita o acao da Lunium para decidir se repete', async () => {
    let calls = 0;
    const client = new LuniumClient({
      apiUrl: 'https://lunium.test',
      apiKey: 'lun_test_key',
      timeoutMs: 5_000,
      fetchImpl: async () => {
        calls += 1;
        return jsonResponse({ erro: 'config_provedor', acao: 'parar', detail: 'configuracao do provedor', request_id: 'req_2' }, 502);
      },
    });
    await expect(client.getCharge('ci_1')).rejects.toMatchObject({ code: 'config_provedor', action: 'parar' });
    // Nao repetiu: um 502 com "parar" e uma chamada so.
    expect(calls).toBe(1);
  });
});

describe('isRetryable', () => {
  it('acao manda mais que o status', () => {
    expect(isRetryable(502, { acao: 'parar' })).toBe(false);
    expect(isRetryable(503, { acao: 'falar_com_suporte' })).toBe(false);
    expect(isRetryable(500, { acao: 'corrigir' })).toBe(false);
    expect(isRetryable(503, { acao: 'repetir' })).toBe(true);
    expect(isRetryable(429, { acao: 'esperar' })).toBe(true);
    expect(isRetryable(502, null)).toBe(true);
    expect(isRetryable(400, null)).toBe(false);
  });
});
