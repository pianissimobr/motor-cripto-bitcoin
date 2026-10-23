import { describe, expect, it } from 'vitest';
import { ConflictError, NotFoundError, ValidationError } from '../src/core/domain/errors.js';
import { setupCore } from './core-fixtures.js';

describe('LinkService', () => {
  it('cria link com endereco derivado, pagina publica e idempotencia', async () => {
    const { links, created, profile, wallet, repos } = await setupCore();
    const input = {
      apiClienteId: created.client.id,
      externalId: 'pedido-1',
      idempotencyKey: 'idem-1',
      amountCents: 10_000,
      rampProfileId: profile.id,
      walletId: wallet.id,
    };

    const first = await links.create(input);
    expect(first.reused).toBe(false);
    expect(first.link.enderecoDeposito).toBe('0x0000000000000000000000000000000000000001');
    expect(first.link.expectedBaseUnits).toBe(18_000_000n);
    expect(first.link.status).toBe('aguardando');
    expect(first.link.liquidacaoAte.getTime() - first.link.expiraEm.getTime()).toBe(86_400_000);
    expect(first.pageUrl).toMatch(/^https:\/\/pay\.test\/p\//);
    expect(first.link.rampUrl).toContain('buy.ramp.network');

    const second = await links.create(input);
    expect(second.reused).toBe(true);
    expect(second.link.id).toBe(first.link.id);
    expect(repos.links.rows).toHaveLength(1);

    await expect(
      links.create({ ...input, amountCents: 20_000 }),
    ).rejects.toMatchObject({ codigo: 'idempotencia_conflitante' });

    const publicLink = await links.getPublicByToken(first.link.pageToken);
    expect(publicLink.id).toBe(first.link.id);
    await expect(links.getPublicByToken('x'.repeat(32))).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('rejeita carteira de outro cliente e chain incompativel', async () => {
    const { links, created, profile, repos } = await setupCore();
    const other = await repos.apiClientWallets.create({
      apiClienteId: created.client.id,
      label: 'Outra',
      chain: 'arbitrum',
      address: '0x0000000000000000000000000000000000000002',
    });

    await expect(
      links.create({
        apiClienteId: created.client.id,
        externalId: 'pedido-2',
        amountCents: 100,
        rampProfileId: profile.id,
        walletId: other.id,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('revoga link ainda nao pago e grava motivo', async () => {
    const { links, created, profile, wallet } = await setupCore();
    const { link } = await links.create({
      apiClienteId: created.client.id,
      externalId: 'pedido-3',
      amountCents: 500,
      rampProfileId: profile.id,
      walletId: wallet.id,
    });

    const revoked = await links.revoke(link.id);
    expect(revoked.status).toBe('nao_realizado');
    expect(revoked.motivoNaoRealizado).toBe('revogado');
  });

  it('nao permite revogar link ja pago', async () => {
    const { links, created, profile, wallet, repos } = await setupCore();
    const { link } = await links.create({
      apiClienteId: created.client.id,
      externalId: 'pedido-4',
      amountCents: 500,
      rampProfileId: profile.id,
      walletId: wallet.id,
    });
    await repos.links.updateStatus(link.id, 'pago');

    await expect(links.revoke(link.id)).rejects.toBeInstanceOf(ConflictError);
  });

  it('nao vaza link de outro cliente', async () => {
    const { links, created, profile, wallet, repos } = await setupCore();
    const other = await repos.apiClients.create({
      id: crypto.randomUUID(),
      nome: 'Outra',
      apiKeyHash: 'hash',
      apiKeyPrefix: 'mk_live_outra',
      webhookUrl: 'https://example.test/outro',
      webhookSecret: 'whsec_outro',
      requestSecret: 'req_outro',
    });
    const { link } = await links.create({
      apiClienteId: created.client.id,
      externalId: 'pedido-5',
      amountCents: 500,
      rampProfileId: profile.id,
      walletId: wallet.id,
    });

    await expect(links.getForClient(other.id, link.id)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});
