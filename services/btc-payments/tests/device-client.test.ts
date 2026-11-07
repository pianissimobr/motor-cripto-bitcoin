import { describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import type { Repositories } from '../src/db/repositories.js';
import type { ApiClient, PossessionChallenge } from '../src/domain/types.js';
import { DeviceClientService } from '../src/services/device-client-service.js';
import { silentLogger } from '../src/logger.js';
import { testConfig } from './helpers.js';

const ACCOUNT = privateKeyToAccount(
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
);

type FakeState = {
  challenges: Map<string, PossessionChallenge>;
  clients: Map<string, ApiClient>;
  rotations: number;
};

function fakeRepos(state: FakeState): Repositories {
  return {
    createPossessionChallenge: async (input: Parameters<Repositories['createPossessionChallenge']>[0]) => {
      const row: PossessionChallenge = {
        id: `ch_${state.challenges.size + 1}`,
        nonce: input.nonce,
        address: input.address,
        purpose: input.purpose,
        message: input.message,
        expiresAt: input.expiresAt,
        consumedAt: null,
        createdAt: new Date(),
      };
      state.challenges.set(row.nonce, row);
      return row;
    },
    consumePossessionChallenge: async (nonce: string) => {
      const row = state.challenges.get(nonce);
      if (!row || row.consumedAt) return null;
      const consumed = { ...row, consumedAt: new Date() };
      state.challenges.set(nonce, consumed);
      return consumed;
    },
    findClientBySettlementAddress: async (address: string) => {
      for (const client of state.clients.values()) {
        if ((client.settlementAddress ?? '').toLowerCase() === address.toLowerCase()) {
          return client;
        }
      }
      return null;
    },
    createClient: async (input: Parameters<Repositories['createClient']>[0]) => {
      const row = {
        ...input,
        status: 'ativo',
        baseCurrency: 'BRL',
        settlementAsset: 'USDC',
        settlementChain: 'polygon',
        spreadBps: 0,
        autoPayoutLimitBrl: 0n,
        autoPayoutLimitUsd: 0n,
        unverifiedDailyLimitBrl: 0n,
        unverifiedTotalLimitBrl: 0n,
        verificationStatus: 'unverified',
        payoutBatchSeconds: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as unknown as ApiClient;
      state.clients.set(row.id, row);
      return row;
    },
    rotateClientKey: async (id: string, input: Parameters<Repositories['rotateClientKey']>[1]) => {
      state.rotations += 1;
      const current = state.clients.get(id);
      if (!current) return null;
      const next = { ...current, ...input } as ApiClient;
      state.clients.set(id, next);
      return next;
    },
    insertAuditEvent: async () => undefined,
  } as unknown as Repositories;
}

function newState(): FakeState {
  return { challenges: new Map(), clients: new Map(), rotations: 0 };
}

describe('registro de device (C6)', () => {
  it('registra o cliente depois de uma prova de posse valida', async () => {
    const state = newState();
    const service = new DeviceClientService({
      repos: fakeRepos(state),
      config: testConfig(),
      logger: silentLogger,
    });

    const challenge = await service.issueChallenge({
      purpose: 'client_registration',
      address: ACCOUNT.address,
    });
    const signature = await ACCOUNT.signMessage({ message: challenge.message });
    const created = await service.register({
      address: ACCOUNT.address,
      chain: 'polygon',
      proof: { nonce: challenge.nonce, signature },
    });

    expect(created.client_id).toBeTruthy();
    expect(created.api_key.startsWith('mk_btc_live_')).toBe(true);
    expect(created.request_secret.length).toBeGreaterThan(20);
    expect(state.clients.size).toBe(1);
    expect(state.clients.get(created.client_id)?.settlementAddress).toBe(
      ACCOUNT.address,
    );
    expect(state.clients.get(created.client_id)?.clientType).toBe('usuario');
  });

  it('recusa assinatura invalida', async () => {
    const state = newState();
    const service = new DeviceClientService({
      repos: fakeRepos(state),
      config: testConfig(),
      logger: silentLogger,
    });
    const challenge = await service.issueChallenge({
      purpose: 'client_registration',
      address: ACCOUNT.address,
    });
    await expect(
      service.register({
        address: ACCOUNT.address,
        proof: {
          nonce: challenge.nonce,
          signature: `0x${'11'.repeat(65)}`,
        },
      }),
    ).rejects.toThrow(/prova de posse invalida/);
    expect(state.clients.size).toBe(0);
  });

  it('nao aceita o mesmo nonce duas vezes', async () => {
    const state = newState();
    const service = new DeviceClientService({
      repos: fakeRepos(state),
      config: testConfig(),
      logger: silentLogger,
    });
    const challenge = await service.issueChallenge({
      purpose: 'client_registration',
      address: ACCOUNT.address,
    });
    const signature = await ACCOUNT.signMessage({ message: challenge.message });
    await service.register({
      address: ACCOUNT.address,
      proof: { nonce: challenge.nonce, signature },
    });
    await expect(
      service.register({
        address: ACCOUNT.address,
        proof: { nonce: challenge.nonce, signature },
      }),
    ).rejects.toThrow(/desafio invalido/);
  });

  it('devolve o mesmo client_id quando o device se registra de novo', async () => {
    const state = newState();
    const service = new DeviceClientService({
      repos: fakeRepos(state),
      config: testConfig(),
      logger: silentLogger,
    });

    const first = await service.issueChallenge({
      purpose: 'client_registration',
      address: ACCOUNT.address,
    });
    const firstSignature = await ACCOUNT.signMessage({ message: first.message });
    const created = await service.register({
      address: ACCOUNT.address,
      proof: { nonce: first.nonce, signature: firstSignature },
    });

    const second = await service.issueChallenge({
      purpose: 'client_registration',
      address: ACCOUNT.address,
    });
    const secondSignature = await ACCOUNT.signMessage({ message: second.message });
    const again = await service.register({
      address: ACCOUNT.address,
      proof: { nonce: second.nonce, signature: secondSignature },
    });

    expect(again.client_id).toBe(created.client_id);
    expect(again.api_key).not.toBe(created.api_key);
    expect(state.rotations).toBe(1);
  });

  it('confere a prova de posse de um endereco de loja', async () => {
    const state = newState();
    const service = new DeviceClientService({
      repos: fakeRepos(state),
      config: testConfig(),
      logger: silentLogger,
    });
    const challenge = await service.issueChallenge({
      purpose: 'wallet_registration',
      address: ACCOUNT.address,
    });
    const signature = await ACCOUNT.signMessage({ message: challenge.message });
    expect(
      await service.verify({
        address: ACCOUNT.address,
        purpose: 'wallet_registration',
        proof: { nonce: challenge.nonce, signature },
      }),
    ).toBe(true);
    expect(
      await service.verify({
        address: ACCOUNT.address,
        purpose: 'wallet_registration',
        proof: { nonce: challenge.nonce, signature },
      }),
    ).toBe(false);
  });
});
