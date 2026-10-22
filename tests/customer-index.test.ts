import { describe, expect, it } from 'vitest';
import { BlindIndex, DataCipher } from '../src/core/crypto/cipher.js';
import {
  CustomerService,
  DuplicateCustomerEmailError,
} from '../src/core/services/customer-service.js';
import { silentLogger } from '../src/core/logger.js';
import { createFakeRepositories } from './fakes.js';

const KEY_OLD = Buffer.alloc(32, 1);
const KEY_NEW = Buffer.alloc(32, 2);
const DATA_KEY = Buffer.alloc(32, 7);

function service(repos: ReturnType<typeof createFakeRepositories>, index: BlindIndex) {
  return new CustomerService({
    repos,
    cipher: new DataCipher(DATA_KEY),
    blindIndex: index,
    logger: silentLogger,
  });
}

describe('Bloco 4: indices de e-mail', () => {
  it('mantem clientes diferentes com o mesmo prefixo no autocomplete', async () => {
    const repos = createFakeRepositories();
    const svc = service(repos, new BlindIndex(KEY_OLD, 'k1'));

    const maria = await svc.create({ nome: 'Maria', email: 'maria@example.com' });
    const marcos = await svc.create({ nome: 'Marcos', email: 'marcos@example.com' });

    const achados = await svc.search('mar');
    expect(achados.map((c) => c.id).sort()).toEqual([maria.id, marcos.id].sort());
  });

  it('rejeita e-mail duplicado no estado sem rotacao', async () => {
    const repos = createFakeRepositories();
    const svc = service(repos, new BlindIndex(KEY_OLD, 'k1'));
    await svc.create({ nome: 'Maria', email: 'maria@example.com' });

    const erro = await svc
      .create({ nome: 'Outra Maria', email: 'MARIA@example.com' })
      .catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(DuplicateCustomerEmailError);
    expect((erro as DuplicateCustomerEmailError).statusCode).toBe(409);
  });

  it('grava o indice ativo como canonico e o antigo como anterior', async () => {
    const repos = createFakeRepositories();
    const oldIndex = new BlindIndex(KEY_OLD, 'k1');
    const svc = service(repos, oldIndex);
    const criado = await svc.create({ nome: 'Maria', email: 'maria@example.com' });

    const stored = (await repos.customers.findById(criado.id))!;
    await repos.customers.updateEncrypted(
      criado.id,
      stored.nomeEnc,
      stored.emailEnc,
      new BlindIndex(KEY_NEW, 'k2').compute('maria@example.com'),
      oldIndex.compute('maria@example.com'),
      [],
      [],
    );

    const rotacionado = (await repos.customers.findById(criado.id))!;
    expect(rotacionado.emailBidx).toBe(
      new BlindIndex(KEY_NEW, 'k2').compute('maria@example.com'),
    );
    expect(rotacionado.emailBidxAnterior).toBe(oldIndex.compute('maria@example.com'));
  });

  it('rejeita duplicado durante e depois da rotacao', async () => {
    const repos = createFakeRepositories();
    const oldIndex = new BlindIndex(KEY_OLD, 'k1');
    const criado = await service(repos, oldIndex).create({
      nome: 'Maria',
      email: 'maria@example.com',
    });
    const stored = (await repos.customers.findById(criado.id))!;

    // Simula o rotate-keys: ativo vira canonico, antigo vai para anterior.
    await repos.customers.updateEncrypted(
      criado.id,
      stored.nomeEnc,
      stored.emailEnc,
      new BlindIndex(KEY_NEW, 'k2').compute('maria@example.com'),
      oldIndex.compute('maria@example.com'),
      [],
      [],
    );

    const durante = service(
      repos,
      BlindIndex.rotating(KEY_NEW, 'k2', KEY_OLD, 'k1'),
    );
    await expect(
      durante.create({ nome: 'Outra', email: 'maria@example.com' }),
    ).rejects.toBeInstanceOf(DuplicateCustomerEmailError);

    // Depois de remover a chave antiga, a busca ainda acha pelo canonico.
    const depois = service(repos, new BlindIndex(KEY_NEW, 'k2'));
    await expect(
      depois.create({ nome: 'Outra', email: 'maria@example.com' }),
    ).rejects.toBeInstanceOf(DuplicateCustomerEmailError);
    expect((await depois.findByEmail('maria@example.com'))?.id).toBe(criado.id);
  });
});
