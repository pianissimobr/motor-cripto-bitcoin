import { describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import {
  buildPossessionMessage,
  generatePossessionNonce,
  isPossessionPurpose,
  normalizePossessionAddress,
  verifyPossessionSignature,
} from '../src/domain/possession.js';

const ACCOUNT = privateKeyToAccount(
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
);

describe('prova de posse do endereco', () => {
  it('monta a mensagem canonica com endereco e nonce', () => {
    const message = buildPossessionMessage({
      purpose: 'client_registration',
      address: ACCOUNT.address,
      nonce: 'abc123',
    });
    expect(message).toBe(
      `btc-payments: prova de posse\nendereço: ${ACCOUNT.address}\nnonce: abc123`,
    );
  });

  it('gera nonce unico', () => {
    const nonces = new Set(Array.from({ length: 50 }, () => generatePossessionNonce()));
    expect(nonces.size).toBe(50);
  });

  it('reconhece os purposes validos', () => {
    expect(isPossessionPurpose('client_registration')).toBe(true);
    expect(isPossessionPurpose('wallet_registration')).toBe(true);
    expect(isPossessionPurpose('outro')).toBe(false);
  });

  it('normaliza o endereco para EIP-55', () => {
    expect(normalizePossessionAddress(ACCOUNT.address.toLowerCase())).toBe(
      ACCOUNT.address,
    );
    expect(() => normalizePossessionAddress('0x1234')).toThrow();
  });

  it('confere a assinatura EIP-191 do desafio', async () => {
    const message = 'btc-payments: prova de posse\nendereço: x\nnonce: 1';
    const signature = await ACCOUNT.signMessage({ message });
    expect(
      await verifyPossessionSignature({
        address: ACCOUNT.address,
        message,
        signature,
      }),
    ).toBe(true);
  });

  it('recusa assinatura de outra mensagem', async () => {
    const signature = await ACCOUNT.signMessage({ message: 'outra mensagem' });
    expect(
      await verifyPossessionSignature({
        address: ACCOUNT.address,
        message: 'btc-payments: prova de posse\nendereço: x\nnonce: 1',
        signature,
      }),
    ).toBe(false);
  });

  it('recusa assinatura de outra carteira', async () => {
    const outra = privateKeyToAccount(
      '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba',
    );
    const message = 'btc-payments: prova de posse\nendereço: x\nnonce: 1';
    const signature = await outra.signMessage({ message });
    expect(
      await verifyPossessionSignature({
        address: ACCOUNT.address,
        message,
        signature,
      }),
    ).toBe(false);
  });
});
