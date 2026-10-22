import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { centsToFiat, fiatToCents } from '../../core/domain/money.js';
import { collectAlerts } from '../../core/alerts.js';
import { qrCodeSvg, svgToDataUri, QrCodeError } from '../../core/qrcode.js';
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

const linkSchema = z.object({
  clienteId: z.string().uuid().optional(),
  email: z.string().email().optional(),
  valor: z.union([z.string(), z.number()]),
  rampProfileId: z.string().uuid(),
  coldWalletId: z.string().uuid().nullish(),
  coldWalletAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/).nullish(),
  finalUrl: z.string().url().nullish(),
});

const rampProfileSchema = z.object({
  label: z.string().min(1).max(80),
  chain: z.string().min(1).max(40),
  asset: z.string().min(1).max(20),
  tokenContract: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  decimals: z.number().int().min(0).max(18).default(6),
  fiatCurrency: z.string().length(3).default('BRL'),
  baseUrl: z.string().url(),
  paramStyle: z.enum(['legacy', 'unified']).default('legacy'),
  hostAppName: z.string().default('Motor Cripto'),
  hostLogoUrl: z.string().url().nullish(),
  hostApiKey: z.string().nullish(),
  rampAssetKey: z.string().nullish(),
  taxaTokenPorFiatBaseUnits: z.union([z.string(), z.number(), z.bigint()]).nullish(),
});

const coldWalletSchema = z.object({
  label: z.string().min(1).max(80),
  address: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  chain: z.string().min(1).max(40),
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

  /* ---------------------------------------------------------------- */
  /* Health + status                                                   */
  /* ---------------------------------------------------------------- */

  app.get('/api/health', async () => ({ ok: true, ts: new Date().toISOString() }));

  app.get('/api/motor/status', async () => {
    const [clientes, perfis, carteiras, cursors, auditoria] = await Promise.all([
      motor.repos.customers.count(),
      motor.repos.rampProfiles.list(),
      motor.repos.coldWallets.list(),
      motor.repos.audit.list(1),
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
      xpubConta: motor.hdWallet.account.accountAddress,
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
    return reply.code(201).send({
      id: customer.id,
      nome: customer.nome,
      emailMasked: customer.emailMasked,
      nomeMasked: customer.nomeMasked,
      criadoEm: customer.criadoEm,
    });
  });

  app.get('/api/cadastros', async (request) => {
    const query = z
      .object({
        email: z.string().optional(),
        q: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(100).default(20),
        offset: z.coerce.number().int().min(0).default(0),
      })
      .parse(request.query);

    if (query.email) {
      const found = await motor.customers.findByEmail(query.email);
      return { total: found ? 1 : 0, clientes: found ? [found] : [] };
    }
    if (query.q) {
      const found = await motor.customers.search(query.q, query.limit);
      return { total: found.length, clientes: found };
    }
    const clientes = await motor.customers.list(query.limit, query.offset);
    return { total: await motor.customers.count(), clientes };
  });

  app.get('/api/cadastros/:id', async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const customer = await motor.customers.get(id);
    if (!customer) return reply.code(404).send({ erro: 'cliente nao encontrado' });
    return {
      id: customer.id,
      nome: customer.nome,
      email: customer.email,
      emailMasked: customer.emailMasked,
      status: customer.status,
      criadoEm: customer.criadoEm,
    };
  });

  /* ---------------------------------------------------------------- */
  /* Links de cobranca                                                 */
  /* ---------------------------------------------------------------- */

  app.post('/api/links', async (request, reply) => {
    const body = linkSchema.parse(request.body);
    const amountCents = fiatToCents(body.valor);

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
        txHash: t.txHash,
        status: t.status,
        erro: t.erro,
        valor: t.valorBaseUnits.toString(),
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

  app.get('/api/creditos', async (request) => {
    const query = z
      .object({ clienteId: z.string().uuid().optional() })
      .parse(request.query);
    if (!query.clienteId) {
      return reply400('informe clienteId');
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
    const profile = await motor.repos.rampProfiles.create({
      ...body,
      hostLogoUrl: body.hostLogoUrl ?? null,
      hostApiKey: body.hostApiKey ?? null,
      rampAssetKey: body.rampAssetKey ?? null,
      taxaTokenPorFiatBaseUnits: taxa,
    });
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
    const wallet = await motor.repos.coldWallets.create(body);
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

function reply400(erro: string) {
  return { erro };
}
