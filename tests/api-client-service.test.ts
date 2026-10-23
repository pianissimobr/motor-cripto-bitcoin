import { describe, expect, it } from 'vitest';
import { ValidationError } from '../src/core/domain/errors.js';
import { createFakeRepositories } from './fakes.js';
import { silentLogger } from '../src/core/logger.js';
import { ApiClientService } from '../src/core/services/api-client-service.js';

describe('ApiClientService', () => {
  it('cria chave e request secret, autentica e rotaciona', async () => {
    const repos = createFakeRepositories();
    const service = new ApiClientService({ repos, logger: silentLogger });
    const created = await service.create({
      nome: 'Loja',
      webhookUrl: 'https://example.test/hook',
    });

    expect(created.apiKey).toMatch(/^mk_live_/);
    expect(created.requestSecret).toMatch(/^req_/);
    expect(created.client.apiKeyHash).not.toContain(created.apiKey);
    expect(created.client.webhookSecret).toMatch(/^whsec_/);
    expect((await service.authenticate(created.apiKey))?.id).toBe(created.client.id);
    expect(await service.authenticate('mk_live_invalida')).toBeNull();

    const rotated = await service.rotateKey(created.client.id);
    expect(rotated.requestSecret).not.toBe(created.requestSecret);
    expect(await service.authenticate(created.apiKey)).toBeNull();
    expect((await service.authenticate(rotated.apiKey))?.id).toBe(created.client.id);

    const rotatedWebhook = await service.rotateWebhookSecret(created.client.id);
    expect(rotatedWebhook.webhookSecret).not.toBe(created.client.webhookSecret);
    expect((await service.get(created.client.id)).webhookSecret).toBe(
      rotatedWebhook.webhookSecret,
    );
  });

  it('inativa cliente e bloqueia autenticacao', async () => {
    const repos = createFakeRepositories();
    const service = new ApiClientService({ repos, logger: silentLogger });
    const created = await service.create({
      nome: 'Loja',
      webhookUrl: 'https://example.test/hook',
    });
    await service.update(created.client.id, { status: 'inativo' });
    expect(await service.authenticate(created.apiKey)).toBeNull();
  });

  it('valida e normaliza carteiras allowlisted', async () => {
    const repos = createFakeRepositories();
    const service = new ApiClientService({ repos, logger: silentLogger });
    const created = await service.create({
      nome: 'Loja',
      webhookUrl: 'https://example.test/hook',
    });

    await expect(
      service.addWallet(created.client.id, {
        label: 'x',
        chain: 'polygon',
        address: '0x123',
      }),
    ).rejects.toBeInstanceOf(ValidationError);

    const wallet = await service.addWallet(created.client.id, {
      label: 'Principal',
      chain: 'polygon',
      address: '0x52908400098527886e0f7030069857d2e4169ee7',
    });
    expect(wallet.address).toBe('0x52908400098527886e0f7030069857d2e4169ee7');

    await expect(
      service.addWallet(created.client.id, {
        label: 'Duplicada',
        chain: 'polygon',
        address: '0x52908400098527886e0f7030069857d2e4169ee7',
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
