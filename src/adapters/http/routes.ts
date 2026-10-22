import { z } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ConflictError, ValidationError, isUniqueViolation } from '../../core/domain/errors.js';
import { centsToFiat, fiatToCents } from '../../core/domain/money.js';
import { collectAlerts } from '../../core/alerts.js';
import { qrCodeSvg, svgToDataUri, QrCodeError } from '../../core/qrcode.js';
import type { ColdWallet, Customer, RampProfile } from '../../core/domain/types.js';
import type { Motor } from '../../core/index.js';
import type { Logger } from '../../core/logger.js';

/**
 * Rotas HTTP. Sao um adaptador fino: apenas validam entrada, chamam o
 * core e formatam a saida. Nenhuma regra de negocio mora aqui.
 */

const cadastroSchema = z.object({
  nome: z.string().min(2).max(200),
  email: z.string().email().max(320),
});

const chainSchema = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .regex(/^[a-z0-9][a-z0-9-]*$/i, 'chain invalida');

const httpUrlSchema = z
  .string()
  .url()
  .refine((value) => {
    const protocol = new URL(value).protocol;
    return protocol === 'https:' || protocol === 'http:';
  }, 'URL deve usar http(s)');

const linkSchema = z.object({
  clienteId: z.string().uuid().optional(),
  email: z.string().email().max(320).optional(),
  valor: z.union([z.string().trim().min(1).max(20), z.number()]),
  rampProfileId: z.string().uuid(),
  coldWalletId: z.string().uuid().nullish(),
  coldWalletAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/).nullish(),
  finalUrl: httpUrlSchema.nullish(),
});

const rampProfileSchema = z.object({
  label: z.string().trim().min(1).max(80),
  chain: chainSchema,
  asset: z
    .string()
    .trim()
    .min(1)
    .max(20)
    .regex(/^[A-Za-z0-9._-]+$/, 'asset invalido'),
  tokenContract: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  decimals: z.number().int().min(0).max(18).default(6),
  fiatCurrency: z
    .string()
    .regex(/^[A-Za-z]{3}$/, 'moeda fiat deve ter 3 letras')
    .transform((value) => value.toUpperCase())
    .default('BRL'),
  baseUrl: httpUrlSchema,
  paramStyle: z.enum(['legacy', 'unified']).default('legacy'),
  hostAppName: z.string().trim().min(1).max(80).default('Motor Cripto'),
  hostLogoUrl: httpUrlSchema.nullish(),
  hostApiKey: z.string().max(500).nullish(),
  rampAssetKey: z.string().trim().max(80).nullish(),
  // BigInt nao cabe em JSON; aceita string decimal ou numero inteiro seguro.
  taxaTokenPorFiatBaseUnits: z
    .union([
      z.string().regex(/^\d+$/, 'taxa deve ser inteiro >= 0'),
      z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      z.bigint().nonnegative(),
    ])
    .nullish(),
});

const coldWalletSchema = z.object({
  label: z.string().trim().min(1).max(80),
  address: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  chain: chainSchema,
});

export type RouteOptions = {
  motor: Motor;
  logger: Logger;
  /** Saldo minimo do patrocinador de gas (para o alerta). */
  gasSponsor?: { minBalanceWei: bigint; enabled: boolean };
};

export async function registerRoutes(app: FastifyInstance, options: RouteOptions): Promise<void> {
  const { motor, logger } = options;
  const configGas = options.gasSponsor ?? { minBalanceWei: 0n, enabled: false };
  const gasSponsorAtivo = configGas.enabled;

  const revealPedido = (request: FastifyRequest): boolean => {
    const raw = (request.query as { reveal?: unknown } | undefined)?.reveal;
    return raw === 'true' || raw === '1' || raw === true;
  };

  /** PII so sai em claro com pedido explicito; o pedido fica auditado. */
  const auditarReveal = async (
    request: FastifyRequest,
    entidadeId: string | null,
    quantidade: number,
  ): Promise<void> => {
    await motor.repos.audit.record({
      ator: 'api',
      acao: 'pii.revelado',
      entidade: 'cadastro',
      entidadeId,
      ip: request.ip,
      detalhes: { quantidade, rota: request.url.split('?')[0] },
    });
  };

  /* ---------------------------------------------------------------- */
  /* Health + status                                                   */
  /* ---------------------------------------------------------------- */

  app.get('/api/health', async () => ({ ok: true, ts: new Date().toISOString() }));

  app.get('/api/motor/status', async () => {
    const [clientes, perfis, carteiras, auditoria] = await Promise.all([
      motor.repos.customers.count(),
      motor.repos.rampProfiles.list(),
      motor.repos.coldWallets.list(),
      motor.repos.audit.list(5),
    ]);
    return {
      clientes,
      perfisRamp: perfis.map((p) => ({
        id: p.id,
        label: p.label,
        chain: p.chain,
        asset: p.asset,
        paramStyle: p.paramStyle,
      })),
      carteirasFrias: carteiras.map((c) => ({ id: c.id, label: c.label, chain: c.chain })),
      signer: motor.signer.describe(),
      // Nome do campo dizia "xpub", mas o valor sempre foi o endereco da conta.
      enderecoConta: motor.hdWallet.account.accountAddress,
      prefixoDerivacao: motor.hdWallet.derivationPrefix,
      ultimoEventoAuditoria: auditoria[0]?.criadoEm ?? null,
    };
  });

  /* ---------------------------------------------------------------- */
  /* Cadastros                                                         */
  /* ---------------------------------------------------------------- */

  app.post('/api/cadastros', async (request, reply) => {
    const body = cadastroSchema.parse(request.body);
    const customer = await motor.customers.create(body);
    await motor.repos.audit.record({
      ator: 'api',
      acao: 'cadastro.criado',
      entidade: 'cadastro',
      entidadeId: customer.id,
      ip: request.ip,
      detalhes: { emailMasked: customer.emailMasked },
    });
    // PII nao volta em claro na criacao: quem chamou ja conhece o que enviou.
    return reply.code(201).send(serializeCustomer(customer, false));
  });

  app.get('/api/cadastros', async (request) => {
    const query = z
      .object({
        email: z.string().email().max(320).optional(),
        q: z.string().trim().min(1).max(64).optional(),
        reveal: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(100).default(20),
        offset: z.coerce.number().int().min(0).default(0),
      })
      .parse(request.query);

    const reveal = revealPedido(request);

    if (query.email) {
      const found = await motor.customers.findByEmail(query.email);
      if (!found) return { total: 0, clientes: [] };
      if (reveal) await auditarReveal(request, found.id, 1);
      return { total: 1, clientes: [serializeCustomer(found, reveal)] };
    }
    // Autocomplete dispara a cada tecla: aqui nunca se revela PII em claro,
    // senao a cadeia de auditoria (com lock) viraria gargalo.
    if (query.q) {
      const found = await motor.customers.search(query.q, query.limit);
      return {
        total: found.length,
        clientes: found.map((c) => serializeCustomer(c, false)),
      };
    }
    const clientes = await motor.customers.list(query.limit, query.offset);
    if (reveal) await auditarReveal(request, null, clientes.length);
    return {
      total: await motor.customers.count(),
      clientes: clientes.map((c) => serializeCustomer(c, reveal)),
    };
  });

  app.get('/api/cadastros/:id', async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const reveal = revealPedido(request);
    const customer = await motor.customers.get(id);
    if (!customer) return reply.code(404).send({ erro: 'cliente nao encontrado' });
    if (reveal) await auditarReveal(request, customer.id, 1);
    return serializeCustomer(customer, reveal);
  });

  /* ---------------------------------------------------------------- */
  /* Links de cobranca                                                 */
  /* ---------------------------------------------------------------- */

  app.post('/api/links', async (request, reply) => {
    const body = linkSchema.parse(request.body);
    let amountCents: number;
    try {
      amountCents = fiatToCents(body.valor);
    } catch (err) {
      throw new ValidationError(err instanceof Error ? err.message : 'valor invalido');
    }

    let clienteId = body.clienteId;
    if (!clienteId) {
      if (!body.email) {
        return reply.code(400).send({ erro: 'informe clienteId ou email' });
      }
      const customer = await motor.customers.findByEmail(body.email);
      if (!customer) return reply.code(404).send({ erro: 'cliente nao encontrado' });
      clienteId = customer.id;
    }

    const link = await motor.links.create({
      clienteId,
      amountCents,
      rampProfileId: body.rampProfileId,
      coldWalletId: body.coldWalletId ?? null,
      coldWalletAddress: body.coldWalletAddress ?? null,
      finalUrl: body.finalUrl ?? null,
      actor: 'api',
      ip: request.ip,
    });

    // F1: QR gerado no servidor (a tela so embute o SVG).
    let qr: { svg: string; dataUri: string } | null = null;
    try {
      const svg = await qrCodeSvg(link.rampUrl);
      qr = { svg, dataUri: svgToDataUri(svg) };
    } catch (err) {
      logger.warn({ err, linkId: link.id }, 'falha ao gerar QR do link');
    }

    logger.info({ linkId: link.id }, 'link gerado via API');
    return reply.code(201).send({
      id: link.id,
      rampUrl: link.rampUrl,
      enderecoDeposito: link.enderecoDeposito,
      carteiraFria: link.carteiraFriaEndereco,
      valor: centsToFiat(link.valorFiatCentavos),
      moeda: link.moedaFiat,
      asset: link.asset,
      chain: link.chain,
      status: link.status,
      qrcodeDataUri: qr?.dataUri ?? null,
      expiraEm: link.expiraEm,
      criadoEm: link.criadoEm,
    });
  });

  app.get('/api/links/:id', async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const detail = await motor.links.detail(id);
    if (!detail) return reply.code(404).send({ erro: 'link nao encontrado' });
    const { link, payments, transfers, credits } = detail;
    return {
      id: link.id,
      clienteId: link.clienteId,
      status: link.status,
      valor: centsToFiat(link.valorFiatCentavos),
      moeda: link.moedaFiat,
      asset: link.asset,
      chain: link.chain,
      enderecoDeposito: link.enderecoDeposito,
      caminhoDerivacao: link.caminhoDerivacao,
      rampUrl: link.rampUrl,
      expiraEm: link.expiraEm,
      criadoEm: link.criadoEm,
      pagamentos: payments.map((p) => ({
        id: p.id,
        txHash: p.txHash,
        valor: p.valorBaseUnits.toString(),
        confirmacoes: p.confirmacoes,
        bloco: p.bloco,
        status: p.status,
        deAddress: p.deAddress,
        detectadoEm: p.detectadoEm,
        confirmadoEm: p.confirmadoEm,
      })),
      movimentos: transfers.map((t) => ({
        id: t.id,
        kind: t.kind,
        txHash: t.txHash,
        status: t.status,
        erro: t.erro,
        valor: t.valorBaseUnits.toString(),
        unsignedTransaction: parseUnsignedJson(t.unsignedTransaction),
        criadoEm: t.criadoEm,
      })),
      creditos: credits.map((c) => ({
        id: c.id,
        valor: c.valorBaseUnits.toString(),
        valorCentavos: c.valorCentavos,
        moeda: c.moeda,
        status: c.status,
        criadoEm: c.criadoEm,
      })),
    };
  });

  /**
   * PSBT: recebe o raw assinado no hardware wallet e transmite.
   * A unsigned fica em /api/links/:id; so o admin pode submeter.
   */
  app.post('/api/movimentos/:id/raw', async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z
      .object({
        rawTransaction: z
          .string()
          .min(10)
          .max(100_000)
          .regex(/^0x(?:[0-9a-fA-F]{2})+$/, 'rawTransaction deve ser hex 0x'),
      })
      .parse(request.body);
    const result = await motor.sweeper.submitSignedTransfer(id, body.rawTransaction);
    return reply.code(202).send(result);
  });

  /** F1: o QR como SVG puro, para <img> ou download. */
  app.get('/api/links/:id/qrcode.svg', async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const link = await motor.links.get(id);
    if (!link) return reply.code(404).send({ erro: 'link nao encontrado' });
    try {
      const svg = await qrCodeSvg(link.rampUrl);
      return reply
        .header('content-type', 'image/svg+xml; charset=utf-8')
        .header('cache-control', 'private, max-age=300')
        .header('content-disposition', 'inline; filename="link-pagamento.svg"')
        .send(svg);
    } catch (err) {
      if (err instanceof QrCodeError) return reply.code(422).send({ erro: err.message });
      throw err;
    }
  });

  app.get('/api/links', async (request) => {
    const query = z
      .object({
        clienteId: z.string().uuid().optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
      })
      .parse(request.query);
    const links = query.clienteId
      ? await motor.links.listByCustomer(query.clienteId)
      : await motor.links.list(query.limit);
    return {
      total: links.length,
      links: links.map((l) => ({
        id: l.id,
        clienteId: l.clienteId,
        status: l.status,
        valor: centsToFiat(l.valorFiatCentavos),
        moeda: l.moedaFiat,
        asset: l.asset,
        chain: l.chain,
        enderecoDeposito: l.enderecoDeposito,
        criadoEm: l.criadoEm,
        expiraEm: l.expiraEm,
      })),
    };
  });

  /* ---------------------------------------------------------------- */
  /* Creditos                                                          */
  /* ---------------------------------------------------------------- */

  app.get('/api/creditos', async (request, reply) => {
    const query = z
      .object({ clienteId: z.string().uuid().optional() })
      .parse(request.query);
    if (!query.clienteId) {
      return reply.code(400).send({ erro: 'informe clienteId' });
    }
    const credits = await motor.repos.credits.listByCustomer(query.clienteId);
    const totalCentavos = await motor.repos.credits.sumByCustomer(query.clienteId);
    return {
      totalCentavos,
      total: centsToFiat(totalCentavos),
      creditos: credits.map((c) => ({
        id: c.id,
        linkId: c.linkId,
        pagamentoId: c.pagamentoId,
        valor: c.valorBaseUnits.toString(),
        valorCentavos: c.valorCentavos,
        valorFiat: c.valorCentavos !== null ? centsToFiat(c.valorCentavos) : null,
        moeda: c.moeda,
        status: c.status,
        criadoEm: c.criadoEm,
      })),
    };
  });

  /* ---------------------------------------------------------------- */
  /* Perfis Ramp e carteiras frias                                     */
  /* ---------------------------------------------------------------- */

  app.get('/api/ramp-profiles', async () => {
    const perfis = await motor.repos.rampProfiles.list();
    return {
      total: perfis.length,
      perfis: perfis.map((p) => ({
        id: p.id,
        label: p.label,
        chain: p.chain,
        asset: p.asset,
        tokenContract: p.tokenContract,
        decimals: p.decimals,
        fiatCurrency: p.fiatCurrency,
        baseUrl: p.baseUrl,
        paramStyle: p.paramStyle,
        taxaTokenPorFiatBaseUnits: p.taxaTokenPorFiatBaseUnits?.toString() ?? null,
        criadoEm: p.criadoEm,
      })),
    };
  });

  app.post('/api/ramp-profiles', async (request, reply) => {
    const body = rampProfileSchema.parse(request.body);
    const taxa =
      body.taxaTokenPorFiatBaseUnits === null || body.taxaTokenPorFiatBaseUnits === undefined
        ? null
        : BigInt(body.taxaTokenPorFiatBaseUnits);
    let profile: RampProfile;
    try {
      profile = await motor.repos.rampProfiles.create({
        ...body,
        hostLogoUrl: body.hostLogoUrl ?? null,
        hostApiKey: body.hostApiKey ?? null,
        rampAssetKey: body.rampAssetKey ?? null,
        taxaTokenPorFiatBaseUnits: taxa,
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw new ConflictError('perfil Ramp ja cadastrado');
      throw err;
    }
    await motor.repos.audit.record({
      ator: 'api',
      acao: 'ramp_profile.criado',
      entidade: 'ramp_profile',
      entidadeId: profile.id,
      ip: request.ip,
    });
    return reply.code(201).send({ id: profile.id, label: profile.label });
  });

  app.get('/api/carteiras-frias', async () => {
    const carteiras = await motor.repos.coldWallets.list();
    return {
      total: carteiras.length,
      carteiras: carteiras.map((c) => ({
        id: c.id,
        label: c.label,
        address: c.address,
        chain: c.chain,
        criadoEm: c.criadoEm,
      })),
    };
  });

  app.post('/api/carteiras-frias', async (request, reply) => {
    const body = coldWalletSchema.parse(request.body);
    let wallet: ColdWallet;
    try {
      wallet = await motor.repos.coldWallets.create(body);
    } catch (err) {
      if (isUniqueViolation(err)) throw new ConflictError('carteira fria ja cadastrada');
      throw err;
    }
    await motor.repos.audit.record({
      ator: 'api',
      acao: 'carteira_fria.criada',
      entidade: 'carteira_fria',
      entidadeId: wallet.id,
      ip: request.ip,
      detalhes: { chain: wallet.chain },
    });
    return reply.code(201).send({ id: wallet.id, label: wallet.label });
  });

  /* ---------------------------------------------------------------- */
  /* Alertas (F2)                                                      */
  /* ---------------------------------------------------------------- */

  app.get('/api/alerts', async () => {
    const alertas = await collectAlerts({
      repos: motor.repos,
      logger,
      gasSponsorMinBalanceWei: configGas.minBalanceWei,
      gasSponsorConfigured: gasSponsorAtivo,
    });
    return {
      total: alertas.length,
      critico: alertas.filter((a) => a.nivel === 'critico').length,
      atencao: alertas.filter((a) => a.nivel === 'atencao').length,
      info: alertas.filter((a) => a.nivel === 'info').length,
      alertas,
    };
  });

  /* ---------------------------------------------------------------- */
  /* Auditoria                                                         */
  /* ---------------------------------------------------------------- */

  app.get('/api/auditoria', async (request) => {
    const query = z
      .object({ limit: z.coerce.number().int().min(1).max(200).default(50) })
      .parse(request.query);
    const eventos = await motor.repos.audit.list(query.limit);
    return {
      total: eventos.length,
      eventos: eventos.map((e) => ({
        id: e.id,
        ator: e.ator,
        acao: e.acao,
        entidade: e.entidade,
        entidadeId: e.entidadeId,
        detalhes: e.detalhes,
        ip: e.ip,
        criadoEm: e.criadoEm,
      })),
    };
  });
}

function parseUnsignedJson(value: string | null): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

/**
 * Saida de cliente mascarada por padrao. `email` acompanha a revelacao para
 * que o front consiga montar a busca exata; sem reveal fica `null`.
 */
function serializeCustomer(customer: Customer, reveal: boolean) {
  return {
    id: customer.id,
    nome: reveal ? customer.nome : customer.nomeMasked,
    email: reveal ? customer.email : null,
    nomeMasked: customer.nomeMasked,
    emailMasked: customer.emailMasked,
    status: customer.status,
    criadoEm: customer.criadoEm,
  };
}
