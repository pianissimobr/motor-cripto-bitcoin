import { describe, expect, it } from 'vitest';
import { buildRampLink, RampLinkError } from '../src/core/ramp/link-builder.js';

const profile = {
  chain: 'polygon',
  asset: 'USDC',
  fiatCurrency: 'BRL',
  baseUrl: 'https://buy.ramp.network/',
  paramStyle: 'legacy' as const,
  hostAppName: 'Motor Cripto',
  hostLogoUrl: undefined,
  hostApiKey: undefined,
};

const ADDRESS = '0xB528b506718d18eB4Ab7EC6ca42a47C7740022b6';

describe('buildRampLink', () => {
  it('monta a URL no estilo legacy (conta pessoal, sem hostApiKey)', () => {
    const url = new URL(
      buildRampLink({
        profile,
        depositAddress: ADDRESS,
        amountCents: 15_000,
        paymentId: 'abc-123',
      }),
    );
    expect(url.origin + url.pathname).toBe('https://buy.ramp.network/');
    expect(url.searchParams.get('userAddress')).toBe(ADDRESS);
    expect(url.searchParams.get('asset')).toBe('USDC');
    expect(url.searchParams.get('network')).toBe('polygon');
    expect(url.searchParams.get('fiatValue')).toBe('150.00');
    expect(url.searchParams.get('fiatCurrency')).toBe('BRL');
    expect(url.searchParams.get('hostPaymentId')).toBe('abc-123');
    expect(url.searchParams.has('hostApiKey')).toBe(false);
  });

  it('monta a URL no estilo unified com unidades ISO-4217', () => {
    const url = new URL(
      buildRampLink({
        profile: { ...profile, baseUrl: 'https://app.rampnetwork.com/', paramStyle: 'unified' },
        depositAddress: ADDRESS,
        amountCents: 15_000,
        paymentId: 'abc-123',
      }),
    );
    expect(url.searchParams.get('defaultFlow')).toBe('ONRAMP');
    expect(url.searchParams.get('inAsset')).toBe('BRL');
    expect(url.searchParams.get('inAssetValue')).toBe('15000');
    expect(url.searchParams.get('enabledCryptoAssets')).toBe('POLYGON_USDC');
    expect(url.searchParams.get('userAddress')).toBe(ADDRESS);
  });

  it('usa a chave de asset informada quando existir', () => {
    const url = new URL(
      buildRampLink({
        profile: {
          ...profile,
          baseUrl: 'https://app.rampnetwork.com/',
          paramStyle: 'unified',
          rampAssetKey: 'POLYGON_USDT0',
        },
        depositAddress: ADDRESS,
        amountCents: 100,
        paymentId: 'x',
      }),
    );
    expect(url.searchParams.get('enabledCryptoAssets')).toBe('POLYGON_USDT0');
  });

  it('rejeita endereco invalido', () => {
    expect(() =>
      buildRampLink({ profile, depositAddress: '0x123', amountCents: 100, paymentId: 'x' }),
    ).toThrow(RampLinkError);
  });

  it('rejeita valor nao positivo', () => {
    expect(() =>
      buildRampLink({ profile, depositAddress: ADDRESS, amountCents: 0, paymentId: 'x' }),
    ).toThrow(/valor de cobranca invalido/);
    expect(() =>
      buildRampLink({ profile, depositAddress: ADDRESS, amountCents: -1, paymentId: 'x' }),
    ).toThrow(RampLinkError);
  });

  it('rejeita moeda fiat invalida', () => {
    expect(() =>
      buildRampLink({
        profile: { ...profile, fiatCurrency: 'REAL' },
        depositAddress: ADDRESS,
        amountCents: 100,
        paymentId: 'x',
      }),
    ).toThrow(/moeda fiat invalida/);
  });
});
