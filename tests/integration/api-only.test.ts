import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRepositories } from '../../src/adapters/db/repositories.js';
import { DataCipher } from '../../src/core/crypto/cipher.js';
import { ApiClientService } from '../../src/core/services/api-client-service.js';
import { silentLogger } from '../../src/core/logger.js';
import { createTestDb, truncateAll } from './helpers.js';

describe('schema API-only e repositorios Drizzle', () => {
  const handle = createTestDb();
  const cipher = DataCipher.fromSingleKey(randomBytes(32));
  const repos = createRepositories(handle.db, cipher);

  beforeAll(async () => {
    await truncateAll(handle);
  });

  afterAll(async () => {
    await handle.close();
  });

  it('removeu tabelas do portal e criou request_secret_enc', async () => {
    const antigas = await handle.sql<{ table_name: string }[]>`
      select table_name from information_schema.tables
      where table_schema = 'public'
        and table_name in ('cadastros','contas','sessoes','creditos_cliente','carteiras_frias')
    `;
    expect(antigas).toHaveLength(0);

    const [{ n } = { n: 0 }] = await handle.sql<{ n: number }[]>`
      select count(*)::int as n from information_schema.columns
      where table_schema = 'public'
        and table_name = 'api_clientes'
        and column_name = 'request_secret_enc'
    `;
    expect(n).toBe(1);
  });

  it('cifra segredos em repouso e devolve em claro pelo repositorio', async () => {
    const service = new ApiClientService({ repos, logger: silentLogger });
    const created = await service.create({
      nome: 'Cliente integracao',
      webhookUrl: 'https://example.test/hook',
    });

    const [row] = await handle.sql<{ webhook_secret_enc: string; request_secret_enc: string }[]>`
      select webhook_secret_enc, request_secret_enc
      from api_clientes where id = ${created.client.id}
    `;
    expect(row?.webhook_secret_enc).not.toContain(created.client.webhookSecret);
    expect(row?.request_secret_enc).not.toContain(created.requestSecret);

    const loaded = await repos.apiClients.findById(created.client.id);
    expect(loaded?.webhookSecret).toBe(created.client.webhookSecret);
    expect(loaded?.requestSecret).toBe(created.requestSecret);
    expect(await service.authenticate(created.apiKey)).not.toBeNull();
  });

  it('nonce e unico por cliente e webhook entra na outbox', async () => {
    const client = (await repos.apiClients.list())[0]!;
    const expires = new Date(Date.now() + 300_000);
    expect(await repos.nonces.use(client.id, 'nonce-integration', expires)).toBe(true);
    expect(await repos.nonces.use(client.id, 'nonce-integration', expires)).toBe(false);

    const profile = await repos.rampProfiles.create({
      label: 'Polygon USDC',
      chain: 'polygon',
      asset: 'USDC',
      tokenContract: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
      decimals: 6,
      fiatCurrency: 'BRL',
      baseUrl: 'https://buy.ramp.network/',
      paramStyle: 'legacy',
      hostAppName: 'Motor Cripto',
      taxaTokenPorFiatBaseUnits: 180_000n,
    });
    expect(profile.taxaTokenPorFiatBaseUnits).toBe(180_000n);
  });
});
