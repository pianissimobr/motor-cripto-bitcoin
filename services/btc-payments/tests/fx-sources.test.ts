import { describe, expect, it } from 'vitest';
import {
  CachedFxPriceProvider,
  HttpFxPriceProvider,
} from '../src/adapters/fx/http.js';
import { FxError } from '../src/domain/fx.js';

/**
 * As fontes de taxa sao publicas e falham sozinhas: a AwesomeAPI responde 429
 * e a do Coinbase ja devolveu 5xx. A cotacao nao pode depender de uma so, e
 * nao pode virar uma rajada de requisicoes.
 */
describe('fonte de taxa', () => {
  it('usa a primeira fonte que responde', async () => {
    const provider = new HttpFxPriceProvider({
      fetchImpl: async (url) => {
        const body = String(url).includes('coinbase')
          ? { data: { amount: '75000.00' } }
          : { USDBRL: { bid: '5.50' } };
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });

    const price = await provider.getBtcPrice('BRL');
    // 75.000 USD * 5,50 = 412.500 BRL por BTC
    expect(price.btcPriceCents).toBe(41_250_000n);
  });

  it('aceita preco que vem como numero', async () => {
    // A exchangerate-api devolve {"rates":{"BRL":5.42}} e a blockchain.info
    // devolve o last como numero: um numero tem que virar texto antes de
    // virar centavos, senao a fonte e descartada.
    const provider = new HttpFxPriceProvider({
      fetchImpl: async (url) => {
        const address = String(url);
        if (address.includes('coinbase')) {
          return new Response(JSON.stringify({ data: { amount: 75000 } }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ rates: { BRL: 5.5 } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });

    const price = await provider.getBtcPrice('BRL');
    expect(price.btcPriceCents).toBe(41_250_000n);
  });

  it('cai para a fonte seguinte quando a primeira falha', async () => {
    let calls = 0;
    const provider = new HttpFxPriceProvider({
      fetchImpl: async (url) => {
        calls += 1;
        const address = String(url);
        if (address.includes('coinbase')) {
          return new Response('limite', { status: 429 });
        }
        if (address.includes('bitstamp')) {
          return new Response(JSON.stringify({ last: '75100.00' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ USDBRL: { bid: '5.40' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });

    const price = await provider.getBtcPrice('BRL');
    expect(price.btcPriceCents).toBe(40_554_000n);
    expect(calls).toBeGreaterThan(1);
  });

  it('erro de taxa e 503 (nao 500): da para tentar de novo', async () => {
    const provider = new HttpFxPriceProvider({
      fetchImpl: async () => new Response('limite', { status: 429 }),
    });

    await expect(provider.getBtcPrice('BRL')).rejects.toMatchObject({
      name: 'FxError',
      statusCode: 503,
      code: 'fx_unavailable',
    });
  });

  it('o cache segura o preco por um tempo', async () => {
    let calls = 0;
    const inner = {
      getBtcPrice: async () => {
        calls += 1;
        return {
          currency: 'BRL' as const,
          btcPriceCents: 41_250_000n,
          source: 'teste',
          observedAt: new Date(),
        };
      },
    };
    let now = 1_000;
    const provider = new CachedFxPriceProvider(inner, 30_000, () => now);

    await provider.getBtcPrice('BRL');
    await provider.getBtcPrice('BRL');
    expect(calls).toBe(1);

    now += 31_000;
    await provider.getBtcPrice('BRL');
    expect(calls).toBe(2);
  });

  it('o cache nao esconde a falha da fonte', async () => {
    const provider = new CachedFxPriceProvider(
      {
        getBtcPrice: async () => {
          throw new FxError('sem preco');
        },
      },
      30_000,
    );
    await expect(provider.getBtcPrice('BRL')).rejects.toBeInstanceOf(FxError);
  });
});
