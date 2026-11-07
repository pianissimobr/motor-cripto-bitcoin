import { describe, expect, it } from 'vitest';
import { createWalletSchema } from '../src/http/wallet-schema.js';

const ADDRESS = '0xe49FBc85D36B37Ea85895c339aA9044b0D2B7ce6';

describe('cadastro de carteira da loja', () => {
  it('aceita a carteira de liquidacao da propria loja sem prova', () => {
    const result = createWalletSchema.safeParse({
      kind: 'usdc_settlement',
      address: ADDRESS,
    });
    expect(result.success).toBe(true);
    if (result.success && result.data.kind === 'usdc_settlement') {
      expect(result.data.purpose).toBe('loja');
    }
  });

  it('exige prova de posse para endereco de cliente', () => {
    const result = createWalletSchema.safeParse({
      kind: 'usdc_settlement',
      address: ADDRESS,
      purpose: 'cliente',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(['proof']);
    }
  });

  it('aceita endereco de cliente com a prova', () => {
    const result = createWalletSchema.safeParse({
      kind: 'usdc_settlement',
      address: ADDRESS,
      purpose: 'cliente',
      proof: { nonce: 'abcdef123456', signature: '0xabc123' },
    });
    expect(result.success).toBe(true);
  });

  it('continua aceitando as outras carteiras sem prova', () => {
    expect(
      createWalletSchema.safeParse({ kind: 'btc_deposit', xpub: 'tpubabc' }).success,
    ).toBe(true);
    expect(
      createWalletSchema.safeParse({
        kind: 'lightning_lnbits',
        lnbits_url: 'https://lnbits.test',
        invoice_key: 'invoice-key-123',
      }).success,
    ).toBe(true);
  });
});
