import { randomUUID } from 'node:crypto';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { AppConfig } from '../src/config.js';
import { signRequest } from '../src/crypto/hmac.js';
import { createDb, type DbClient } from '../src/db/client.js';
import { createRepositories, type Repositories } from '../src/db/repositories.js';
import { buildApp } from '../src/http/app.js';
import { silentLogger } from '../src/logger.js';
import { ClientService } from '../src/services/client-service.js';
import { DeviceClientService } from '../src/services/device-client-service.js';
import { GasStationService } from '../src/services/gas-station-service.js';
import { OperationsService } from '../src/services/operations-service.js';
import { testConfig, truncateAll } from './helpers.js';

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const maybeDescribe = TEST_DB_URL ? describe : describe.skip;

/**
 * Rotas do perfil pessoal com o cadastro de device aberto: qualquer pessoa
 * vira cliente, entao cada rota precisa conferir que o recurso e do cliente.
 */
maybeDescribe('rotas do usuario (integration)', () => {
  let db: DbClient;
  let repos: Repositories;
  let config: AppConfig;

  beforeEach(async () => {
    if (!db) {
      db = createDb({ url: TEST_DB_URL!, ssl: false });
      repos = createRepositories(db.db);
    }
    await truncateAll(db);
    config = testConfig({
      GAS_STATION_ENABLED: 'true',
      GAS_STATION_PRIVATE_KEY: `0x${'1'.repeat(64)}`,
    });
  });

  afterAll(async () => {
    if (db) await db.close();
  });

  function buildTestApp() {
    return buildApp({
      config,
      logger: silentLogger,
      readiness: { checks: [] },
      services: {
        config,
        logger: silentLogger,
        repos,
        clients: new ClientService({ repos, config, logger: silentLogger }),
        deviceClients: new DeviceClientService({ repos, config, logger: silentLogger }),
        operations: new OperationsService({ repos, logger: silentLogger }),
        gasStation: new GasStationService({ repos, config, logger: silentLogger }),
      } as never,
    });
  }

  type Creds = { apiKey: string; requestSecret: string };

  function signed(creds: Creds, method: string, path: string, body = '') {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const nonce = randomUUID();
    return {
      authorization: `Bearer ${creds.apiKey}`,
      'content-type': 'application/json',
      'x-timestamp': timestamp,
      'x-nonce': nonce,
      'x-signature': signRequest(creds.requestSecret, {
        method,
        path: path.split('?')[0]!,
        timestamp,
        nonce,
        body,
      }),
    };
  }

  /** O fluxo do app: desafio (com `chain`) -> personal_sign -> cadastro. */
  async function registerDevice(app: ReturnType<typeof buildTestApp>) {
    const account = privateKeyToAccount(generatePrivateKey());
    const challenge = await app.inject({
      method: 'POST',
      url: '/v1/user/challenges',
      payload: { purpose: 'client_registration', address: account.address, chain: 'polygon' },
    });
    expect(challenge.statusCode).toBe(201);
    const { nonce, message } = challenge.json() as { nonce: string; message: string };
    const signature = await account.signMessage({ message });
    const registered = await app.inject({
      method: 'POST',
      url: '/v1/user/clients',
      payload: { address: account.address, chain: 'polygon', proof: { nonce, signature } },
    });
    expect(registered.statusCode).toBe(201);
    const body = registered.json() as { api_key: string; request_secret: string };
    return {
      address: account.address,
      creds: { apiKey: body.api_key, requestSecret: body.request_secret },
    };
  }

  it('o desafio aceita `chain` (o app manda)', async () => {
    const app = buildTestApp();
    await registerDevice(app);
  });

  it('extrato so do proprio endereco', async () => {
    const app = buildTestApp();
    const me = await registerDevice(app);
    const other = await registerDevice(app);

    const own = `/v1/addresses/${me.address}/operations`;
    const ownRes = await app.inject({ method: 'GET', url: own, headers: signed(me.creds, 'GET', own) });
    expect(ownRes.statusCode).toBe(200);

    const theirs = `/v1/addresses/${other.address}/operations`;
    const theirsRes = await app.inject({
      method: 'GET',
      url: theirs,
      headers: signed(me.creds, 'GET', theirs),
    });
    expect(theirsRes.statusCode).toBe(403);
  });

  it('cliente sem endereco proprio nao revoga enderecos', async () => {
    const app = buildTestApp();
    const created = await app.inject({
      method: 'POST',
      url: '/admin/api/clients',
      headers: { authorization: `Bearer ${config.server.adminToken}` },
      payload: {
        name: 'loja',
        webhook_url: 'http://localhost:9999/webhook',
        scopes: ['operations:read'],
      },
    });
    expect(created.statusCode).toBe(201);
    const loja = created.json() as Creds;
    const path = '/v1/user/address-revocations';
    const body = JSON.stringify({ address: '0x2222222222222222222222222222222222222222' });
    const res = await app.inject({
      method: 'POST',
      url: path,
      payload: body,
      headers: signed(loja, 'POST', path, body),
    });
    expect(res.statusCode).toBe(403);
  });

  it('gas: recusa endereco livre no corpo e ordem de outro cliente', async () => {
    const app = buildTestApp();
    const me = await registerDevice(app);
    const path = '/v1/user/gas/topup';

    const oldBody = JSON.stringify({ address: me.address, chain: 'polygon' });
    const old = await app.inject({
      method: 'POST',
      url: path,
      payload: oldBody,
      headers: signed(me.creds, 'POST', path, oldBody),
    });
    expect(old.statusCode).toBe(400);

    const body = JSON.stringify({ cash_out_id: randomUUID() });
    const missing = await app.inject({
      method: 'POST',
      url: path,
      payload: body,
      headers: signed(me.creds, 'POST', path, body),
    });
    expect(missing.statusCode).toBe(404);
  });
});
