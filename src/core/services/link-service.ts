import { randomUUID } from 'node:crypto';
import { checksumAddress } from '../domain/address.js';
import { HD_INDEX_SCOPE } from '../hd/index-scope.js';
import { divRound } from '../domain/money.js';
import type { PaymentLink, RampProfile } from '../domain/types.js';
import type { HdWallet } from '../hd/hd-wallet.js';
import type { Logger } from '../logger.js';
import type { MotorRepositories } from '../ports/index.js';
import { buildRampLink } from '../ramp/link-builder.js';

/**
 * Servico de geracao de cobrancas.
 *
 * Regra central: o ENDERECO DE DEPOSITO NUNCA vem do cliente. Ele e sempre
 * derivado no servidor a partir do indice HD alocado. O cliente escolhe
 * email, valor, perfil de integracao Ramp e a carteira fria de destino.
 */
export class LinkService {
  constructor(
    private readonly deps: {
      repos: MotorRepositories;
      hdWallet: HdWallet;
      logger: Logger;
      ttlHours: number;
      maxIndex: number;
    },
  ) {}

  async create(input: {
    clienteId: string;
    amountCents: number;
    rampProfileId: string;
    coldWalletId?: string | null;
    coldWalletAddress?: string | null;
    finalUrl?: string | null;
    actor?: string;
    ip?: string | null;
  }): Promise<PaymentLink> {
    const { repos } = this.deps;

    if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
      throw new Error('valor de cobranca deve ser um inteiro positivo (em centavos)');
    }
    if (input.amountCents > 100_000_000) {
      throw new Error('valor de cobranca acima do limite permitido');
    }

    const customer = await repos.customers.findById(input.clienteId);
    if (!customer) throw new Error('cliente nao encontrado');

    const profile = await repos.rampProfiles.findById(input.rampProfileId);
    if (!profile) throw new Error('perfil de integracao Ramp nao encontrado');

    const destino = await this.resolveColdWallet(input, profile);

    // Alocacao atomica GLOBAL: o endereco depende so do indice HD, nao do
    // perfil Ramp. Usar `profile.id` fazia dois perfis derivarem o mesmo
    // endereco (indice 0 em ambos).
    const index = await repos.indices.allocate(HD_INDEX_SCOPE, this.deps.maxIndex);
    const enderecoDeposito = checksumAddress(this.deps.hdWallet.deriveAddress(index));
    const caminhoDerivacao = this.deps.hdWallet.fullPath(index);

    const taxa = profile.taxaTokenPorFiatBaseUnits;
    const expectedBaseUnits =
      taxa && taxa > 0n
        ? divRound(taxa * BigInt(input.amountCents), 100n)
        : null;

    const rampUrl = buildRampLink({
      profile,
      depositAddress: enderecoDeposito,
      amountCents: input.amountCents,
      paymentId: randomUUID(),
      finalUrl: input.finalUrl ?? null,
    });

    const expiraEm = new Date(Date.now() + this.deps.ttlHours * 3600_000);

    const link = await repos.links.create({
      clienteId: customer.id,
      rampProfileId: profile.id,
      chain: profile.chain,
      asset: profile.asset,
      tokenContract: profile.tokenContract,
      decimals: profile.decimals,
      moedaFiat: profile.fiatCurrency,
      valorFiatCentavos: input.amountCents,
      valorFiatUnidades: Math.round(input.amountCents),
      taxaTokenPorFiatBaseUnits: taxa,
      expectedBaseUnits,
      indiceHd: index,
      caminhoDerivacao,
      enderecoDeposito,
      // A1: o destino do sweep fica gravado no link. A UI e o sweeper
      // passam a concordar, e a escolha do operador fica auditavel.
      carteiraFriaId: destino.id,
      carteiraFriaEndereco: destino.endereco,
      rampUrl,
      status: 'aguardando',
      expiraEm,
    });

    await repos.audit.record({
      ator: input.actor ?? 'sistema',
      acao: 'link.criado',
      entidade: 'link',
      entidadeId: link.id,
      detalhes: {
        clienteId: customer.id,
        rampProfileId: profile.id,
        chain: profile.chain,
        asset: profile.asset,
        valorFiatCentavos: input.amountCents,
        indiceHd: index,
        enderecoDeposito,
        carteiraFria: destino.endereco,
      },
      ip: input.ip ?? null,
    });

    this.deps.logger.info(
      { linkId: link.id, clienteId: customer.id, indiceHd: index },
      'link de cobranca criado',
    );
    return link;
  }

  /**
   * Resolve a carteira fria de destino e devolve `id` + `endereco` para que
   * ambos fiquem gravados no link (o sweeper usa o endereco persistido).
   */
  private async resolveColdWallet(
    input: { coldWalletId?: string | null; coldWalletAddress?: string | null },
    profile: RampProfile,
  ): Promise<{ id: string | null; endereco: string }> {
    if (input.coldWalletId) {
      const wallet = await this.deps.repos.coldWallets.findById(input.coldWalletId);
      if (!wallet) throw new Error('carteira fria nao encontrada');
      if (wallet.chain.toLowerCase() !== profile.chain.toLowerCase()) {
        throw new Error(
          `carteira fria da chain "${wallet.chain}" incompativel com o perfil "${profile.chain}"`,
        );
      }
      return { id: wallet.id, endereco: checksumAddress(wallet.address) };
    }
    if (input.coldWalletAddress) {
      if (!/^0x[a-fA-F0-9]{40}$/.test(input.coldWalletAddress)) {
        throw new Error('endereco de carteira fria invalido');
      }
      // Endereco livre: entra no log como destino, sem id de tabela.
      const existing = await this.deps.repos.coldWallets.findByAddress(
        input.coldWalletAddress,
      );
      return {
        id: existing?.id ?? null,
        endereco: checksumAddress(input.coldWalletAddress),
      };
    }
    // fallback: carteira fria cadastrada para a chain do perfil
    const wallets = await this.deps.repos.coldWallets.list();
    const candidate = wallets.find(
      (w) => w.chain.toLowerCase() === profile.chain.toLowerCase(),
    );
    if (!candidate) {
      throw new Error(
        `nenhuma carteira fria cadastrada para a chain "${profile.chain}": ` +
          'informe coldWalletId ou coldWalletAddress',
      );
    }
    return { id: candidate.id, endereco: checksumAddress(candidate.address) };
  }

  async get(id: string): Promise<PaymentLink | null> {
    return this.deps.repos.links.findById(id);
  }

  async listByCustomer(clienteId: string): Promise<PaymentLink[]> {
    return this.deps.repos.links.listByCustomer(clienteId);
  }

  async list(limit = 50): Promise<PaymentLink[]> {
    return this.deps.repos.links.listAll(Math.min(limit, 200));
  }

  /** Detalhamento do link para a UI: pagamentos, creditos e movimentos. */
  async detail(id: string) {
    const { repos } = this.deps;
    const link = await repos.links.findById(id);
    if (!link) return null;
    const [payments, transfers] = await Promise.all([
      repos.payments.listByLink(id),
      repos.transfers.findByLink(id),
    ]);
    const credits = (await repos.credits.listAll(1000)).filter((c) => c.linkId === id);
    return { link, payments, transfers, credits };
  }
}
