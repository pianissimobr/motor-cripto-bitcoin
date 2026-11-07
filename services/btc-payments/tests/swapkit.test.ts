import { describe, expect, it } from 'vitest';
import {
  formatBtcAmount,
  SwapKitClient,
  SwapKitError,
  usdcToMinor,
} from '../src/adapters/swapkit/client.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('SwapKitClient', () => {
  it('manda a chave no cabecalho x-api-key', async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    const client = new SwapKitClient({
      apiUrl: 'https://swapkit.test',
      apiKey: 'sk_test',
      fetchImpl: async (url, init) => {
        captured = { url: String(url), init: init ?? {} };
        return jsonResponse({ routes: [] });
      },
    });

    await client.quote({
      sellAsset: 'BTC.BTC',
      buyAsset: 'POL.USDC-0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
      sellAmount: '0.001',
      destinationAddress: '0x1111111111111111111111111111111111111111',
      sourceAddress: 'bc1qgkju4yvvtuz0s8vqn837q396jezu2h8ex7gk98',
      providers: ['NEAR'],
    });

    expect(captured).not.toBeNull();
    expect(captured!.url).toBe('https://swapkit.test/v3/quote');
    const headers = captured!.init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('sk_test');
    expect(JSON.parse(String(captured!.init.body))).toMatchObject({
      sellAsset: 'BTC.BTC',
      buyAsset: 'POL.USDC-0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
      sellAmount: '0.001',
      sourceAddress: 'bc1qgkju4yvvtuz0s8vqn837q396jezu2h8ex7gk98',
      providers: ['NEAR'],
    });
  });

  it('mapeia o erro do provedor para um erro estavel', async () => {
    const client = new SwapKitClient({
      apiUrl: 'https://swapkit.test',
      apiKey: 'sk_test',
      fetchImpl: async () => jsonResponse({ error: 'noRoutesFound' }, 404),
    });

    await expect(
      client.quote({
        sellAsset: 'BTC.BTC',
        buyAsset: 'POL.USDC-0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
        sellAmount: '0.001',
        destinationAddress: '0x1111111111111111111111111111111111111111',
        sourceAddress: 'bc1qgkju4yvvtuz0s8vqn837q396jezu2h8ex7gk98',
      }),
    ).rejects.toBeInstanceOf(SwapKitError);
  });

  it('nao repete a chamada quando o erro nao e retentavel', async () => {
    let calls = 0;
    const client = new SwapKitClient({
      apiUrl: 'https://swapkit.test',
      apiKey: 'sk_test',
      fetchImpl: async () => {
        calls += 1;
        return jsonResponse({ error: 'isSanctionedAddress' }, 400);
      },
    });

    await expect(
      client.swap({
        routeId: 'route_1',
        sourceAddress: 'bc1qgkju4yvvtuz0s8vqn837q396jezu2h8ex7gk98',
        destinationAddress: '0x1111111111111111111111111111111111111111',
      }),
    ).rejects.toThrow(SwapKitError);
    expect(calls).toBe(1);
  });

  it('pede o deposito sem montar transacao e sem conferir saldo', async () => {
    // Quem paga e o pagador: o motor nao monta PSBT e o endereco de origem da
    // plataforma nao tem saldo para ter.
    let captured: { url: string; init: RequestInit } | null = null;
    const client = new SwapKitClient({
      apiUrl: 'https://swapkit.test',
      apiKey: 'sk_test',
      fetchImpl: async (url, init) => {
        captured = { url: String(url), init: init ?? {} };
        return jsonResponse({ swapId: 'swap_1', inboundAddress: 'bc1pdepósito' });
      },
    });

    await client.swap({
      routeId: 'route_1',
      sourceAddress: 'bc1qgkju4yvvtuz0s8vqn837q396jezu2h8ex7gk98',
      destinationAddress: '0x1111111111111111111111111111111111111111',
    });

    const body = JSON.parse(String(captured!.init.body));
    expect(body.disableBuildTx).toBe(true);
    expect(body.disableBalanceCheck).toBe(true);
    expect(body.sourceAddress).toBe('bc1qgkju4yvvtuz0s8vqn837q396jezu2h8ex7gk98');
  });

  it('leva o endereco de deposito e o canal no rastreio', async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    const client = new SwapKitClient({
      apiUrl: 'https://swapkit.test',
      apiKey: 'sk_test',
      fetchImpl: async (url, init) => {
        captured = { url: String(url), init: init ?? {} };
        return jsonResponse({ status: 'completed' });
      },
    });

    await client.track({
      depositChannelId: 'dc_1',
      depositAddress: 'bc1qexemplo',
    });

    expect(captured!.url).toBe('https://swapkit.test/track');
    expect(JSON.parse(String(captured!.init.body))).toMatchObject({
      depositChannelId: 'dc_1',
      depositAddress: 'bc1qexemplo',
    });
  });
});

describe('unidades do swap', () => {
  it('formata sats em BTC decimal', () => {
    expect(formatBtcAmount(100_000n)).toBe('0.001');
    expect(formatBtcAmount(1n)).toBe('0.00000001');
    expect(formatBtcAmount(123_456_789n)).toBe('1.23456789');
    expect(formatBtcAmount(100_000_000n)).toBe('1');
  });

  it('formata sats em unidade base', () => {
    expect(formatBtcAmount(100_000n, 'base')).toBe('100000');
  });

  it('converte USDC para unidades minimas', () => {
    expect(usdcToMinor('1')).toBe(1_000_000n);
    expect(usdcToMinor('1.5')).toBe(1_500_000n);
    expect(usdcToMinor('0.000001')).toBe(1n);
    expect(usdcToMinor(null)).toBeNull();
    expect(usdcToMinor('abc')).toBeNull();
  });
});
