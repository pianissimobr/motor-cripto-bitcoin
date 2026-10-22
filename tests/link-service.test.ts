import { describe, expect, it, beforeEach } from 'vitest';
import { HDNodeWallet, Mnemonic } from 'ethers';
import { DataCipher, BlindIndex } from '../src/core/crypto/cipher.js';
import { HdWallet } from '../src/core/hd/hd-wallet.js';
import { createMotor } from '../src/core/index.js';
import { silentLogger } from '../src/core/logger.js';
import { createFakeRepositories, type FakeAuditRepository } from './fakes.js';

/**
 * Teste do nucleo do motor: criacao de cadastro e de cobranca.
 * Usa repositorios em memoria (implementam os mesmos ports do Postgres).
 */

const MNEMONIC = 'test test test test test test test test test test test junk';
const accountNode = HDNodeWallet.fromMnemonic(Mnemonic.fromPhrase(MNEMONIC), "m/44'/60'/0'");
const XPUB = accountNode.neuter().extendedKey;

const USDC = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359';
const COLD = '0x1111111111111111111111111111111111111111';

type Ctx = ReturnType<typeof setup> & { profileId: string };

function setup() {
  const repos = createFakeRepositories();
  const dataKey = Buffer.alloc(32, 7);
  const indexKey = Buffer.alloc(32, 9);
  const motor = createMotor({
    repos,
    hdWallet: HdWallet.fromAccountXpub(XPUB, '0', 0),
    signer: {
      mode: 'local',
      addressFor: (i) => HdWallet.fromAccountXpub(XPUB, '0', 0).deriveAddress(i),
      signTransfer: async () => ({ rawTransaction: '0x', hash: '0x' }),
      buildUnsigned: () => ({
        from: '',
        to: '',
        data: '0x',
        value: '0',
        chainId: 137,
        nonce: 0,
        gasLimit: '0',
      }),
      describe: () => 'fake',
    },
    providerFactory: () => {
      throw new Error('nao usado neste teste');
    },
    gasSponsor: {
      enabled: false,
      address: null,
      balance: async () => 0n,
      ensureGas: async () => false,
    } as never,
    logger: silentLogger,
    dataKey,
    indexKey,
    ttlHours: 72,
  });
  return { motor, repos, dataKey, indexKey, profileId: '' };
}

describe('core do motor', () => {
  let ctx: Ctx;
  let customerId: string;

  beforeEach(async () => {
    ctx = setup();
    const profile = await ctx.repos.rampProfiles.create({
      label: 'Polygon USDC',
      chain: 'polygon',
      asset: 'USDC',
      tokenContract: USDC,
      decimals: 6,
      fiatCurrency: 'BRL',
      baseUrl: 'https://buy.ramp.network/',
      paramStyle: 'legacy',
      hostAppName: 'Motor Cripto',
      hostApiKey: null,
      rampAssetKey: 'POLYGON_USDC',
      taxaTokenPorFiatBaseUnits: 180_000n,
    });
    await ctx.repos.coldWallets.create({ label: 'Fria', address: COLD, chain: 'polygon' });
    ctx.profileId = profile.id;
  });

  it('cadastra cliente cifrando nome e email', async () => {
    const customer = await ctx.motor.customers.create({
      nome: 'Maria Silva',
      email: 'Maria@Example.com',
    });
    customerId = customer.id;

    expect(customer.email).toBe('maria@example.com');
    expect(customer.emailMasked).toBe('m***@e***.com');

    const stored = await ctx.repos.customers.findById(customer.id);
    expect(stored).not.toBeNull();
    // o texto puro nao pode estar no blob cifrado
    expect(stored!.emailEnc.toString('base64')).not.toContain('maria');
    expect(stored!.nomeEnc.toString('base64')).not.toContain('Maria');
  });

  it('encontra o cliente pelo email normalizado', async () => {
    const customer = await ctx.motor.customers.create({
      nome: 'Maria Silva',
      email: 'Maria@Example.com',
    });
    const achado = await ctx.motor.customers.findByEmail('  MARIA@example.COM ');
    expect(achado?.id).toBe(customer.id);
  });

  it('rejeita email invalido', async () => {
    await expect(
      ctx.motor.customers.create({ nome: 'Maria Silva', email: 'nao-e-email' }),
    ).rejects.toThrow(/email invalido/);
  });

  it('cria cobranca com endereco derivado, taxa e URL da Ramp', async () => {
    const customer = await ctx.motor.customers.create({
      nome: 'Maria Silva',
      email: 'maria@example.com',
    });

    const link = await ctx.motor.links.create({
      clienteId: customer.id,
      amountCents: 15_000,
      rampProfileId: ctx.profileId,
      coldWalletAddress: COLD,
      actor: 'teste',
    });

    // endereco derivado do xpub, indice 0
    expect(link.enderecoDeposito).toBe(
      HdWallet.fromAccountXpub(XPUB, '0', 0).deriveAddress(0),
    );
    expect(link.caminhoDerivacao).toBe("m/44'/60'/0'/0/0");
    expect(link.indiceHd).toBe(0);
    expect(link.status).toBe('aguardando');

    // snapshot da taxa: R$ 150,00 * 0,18 USDC = 27 USDC
    expect(link.expectedBaseUnits).toBe(27_000_000n);
    expect(link.taxaTokenPorFiatBaseUnits).toBe(180_000n);

    // URL da Ramp com o endereco derivado e o valor correto
    expect(link.rampUrl).toContain(link.enderecoDeposito);
    expect(link.rampUrl).toContain('fiatValue=150.00');
    expect(link.rampUrl).toContain('fiatCurrency=BRL');
    expect(link.rampUrl).toContain('asset=USDC');
    expect(link.rampUrl).toContain('network=polygon');
    expect(link.rampUrl).not.toContain('hostApiKey');

    // auditoria registrada
    const audit = ctx.repos.audit as FakeAuditRepository;
    expect(audit.rows.some((e) => e.acao === 'link.criado')).toBe(true);
  });

  it('nunca reutiliza o indice HD', async () => {
    const customer = await ctx.motor.customers.create({
      nome: 'Maria Silva',
      email: 'maria@example.com',
    });
    const a = await ctx.motor.links.create({
      clienteId: customer.id,
      amountCents: 100,
      rampProfileId: ctx.profileId,
      coldWalletAddress: COLD,
    });
    const b = await ctx.motor.links.create({
      clienteId: customer.id,
      amountCents: 100,
      rampProfileId: ctx.profileId,
      coldWalletAddress: COLD,
    });
    expect(a.indiceHd).toBe(0);
    expect(b.indiceHd).toBe(1);
    expect(a.enderecoDeposito).not.toBe(b.enderecoDeposito);
  });

  it('rejeita valor nao positivo', async () => {
    const customer = await ctx.motor.customers.create({
      nome: 'Maria Silva',
      email: 'maria@example.com',
    });
    await expect(
      ctx.motor.links.create({
        clienteId: customer.id,
        amountCents: 0,
        rampProfileId: ctx.profileId,
        coldWalletAddress: COLD,
      }),
    ).rejects.toThrow(/valor de cobranca deve ser/);
  });

  it('rejeita cliente inexistente', async () => {
    await expect(
      ctx.motor.links.create({
        clienteId: '00000000-0000-4000-8000-000000000000',
        amountCents: 100,
        rampProfileId: ctx.profileId,
        coldWalletAddress: COLD,
      }),
    ).rejects.toThrow(/cliente nao encontrado/);
  });

  it('rejeita carteira fria de outra chain', async () => {
    await ctx.repos.coldWallets.create({
      label: 'Ethereum',
      address: '0x2222222222222222222222222222222222222222',
      chain: 'ethereum',
    });
    const customer = await ctx.motor.customers.create({
      nome: 'Maria Silva',
      email: 'maria@example.com',
    });
    const ethWallet = (await ctx.repos.coldWallets.list()).find((w) => w.chain === 'ethereum')!;
    await expect(
      ctx.motor.links.create({
        clienteId: customer.id,
        amountCents: 100,
        rampProfileId: ctx.profileId,
        coldWalletId: ethWallet.id,
      }),
    ).rejects.toThrow(/incompativel/);
  });

  it('usa a carteira fria da chain do perfil quando nao informada', async () => {
    const customer = await ctx.motor.customers.create({
      nome: 'Maria Silva',
      email: 'maria@example.com',
    });
    const link = await ctx.motor.links.create({
      clienteId: customer.id,
      amountCents: 100,
      rampProfileId: ctx.profileId,
    });
    expect(link.status).toBe('aguardando');
  });

  it('expira o link conforme o TTL', async () => {
    const customer = await ctx.motor.customers.create({
      nome: 'Maria Silva',
      email: 'maria@example.com',
    });
    const link = await ctx.motor.links.create({
      clienteId: customer.id,
      amountCents: 100,
      rampProfileId: ctx.profileId,
      coldWalletAddress: COLD,
    });
    const diffHoras = (link.expiraEm.getTime() - Date.now()) / 3_600_000;
    expect(diffHoras).toBeGreaterThan(71);
    expect(diffHoras).toBeLessThan(73);
  });
});
