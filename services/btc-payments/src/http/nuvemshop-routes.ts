import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { UnauthorizedError, ValidationError } from '../domain/errors.js';
import type { NuvemshopService } from '../services/nuvemshop-service.js';

function header(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Rotas que a Nuvemshop chama (OAuth, process/cancel payment, webhooks).
 * A conexao de uma loja comeca no painel (/v1/dash/.../nuvemshop/connect).
 */
export function registerNuvemshopRoutes(
  app: FastifyInstance,
  deps: { nuvemshop: NuvemshopService; publicBaseUrl: string; publicDir: string },
): void {
  const { nuvemshop } = deps;
  const base = deps.publicBaseUrl.replace(/\/+$/, '');

  // O script do checkout roda no dominio da Nuvemshop.
  const script = readFileSync(join(deps.publicDir, 'nuvemshop-checkout.js'), 'utf8');
  app.get('/integrations/nuvemshop/checkout.js', async (_request, reply) =>
    reply
      .type('application/javascript; charset=utf-8')
      .header('cross-origin-resource-policy', 'cross-origin')
      .header('cache-control', 'public, max-age=300')
      .send(script),
  );

  app.get('/integrations/nuvemshop/callback', async (request, reply) => {
    const query = z.object({ code: z.string().min(1).max(200), state: z.string().min(10).max(1000) }).safeParse(request.query);
    if (!query.success) return reply.redirect(`${base}/painel/integracao?nuvemshop=erro`);
    try {
      await nuvemshop.completeInstall(query.data.code, query.data.state);
      return reply.redirect(`${base}/painel/integracao?nuvemshop=ok`);
    } catch (err) {
      request.log.warn({ err }, 'instalacao Nuvemshop falhou');
      return reply.redirect(`${base}/painel/integracao?nuvemshop=erro`);
    }
  });

  const signed = (request: { url: string; headers: Record<string, string | string[] | undefined>; rawBody?: string }) => {
    const ok = nuvemshop.verifyPlatformSignature({
      url: `${base}${request.url}`,
      timestamp: header(request.headers['x-timestamp']),
      signature: header(request.headers['x-signature']),
      rawBody: request.rawBody ?? '',
    });
    if (!ok) throw new UnauthorizedError('assinatura da Nuvemshop invalida');
  };

  // Resposta no formato que o checkout espera: 201 com o redirect_url; erro
  // 4xx como {status, message}.
  app.post('/integrations/nuvemshop/process', async (request, reply) => {
    signed(request);
    try {
      const input = nuvemshop.parseProcess(request.body);
      const result = await nuvemshop.processPayment(input);
      return reply.status(201).send(result);
    } catch (err) {
      if (err instanceof ValidationError) return reply.status(422).send({ status: 422, message: 'payment_processing_error' });
      throw err;
    }
  });

  app.post('/integrations/nuvemshop/cancel', async (request, reply) => {
    signed(request);
    const query = z.object({ payment_attempt_id: z.string().min(1).max(100) }).safeParse(request.query);
    if (query.success) await nuvemshop.cancelPayment(query.data.payment_attempt_id);
    return reply.status(200).send({ status: 200 });
  });

  app.post('/integrations/nuvemshop/webhook', async (request, reply) => {
    if (!nuvemshop.verifyWebhook(request.rawBody ?? '', header(request.headers['x-linkedstore-hmac-sha256']))) {
      return reply.status(401).send({ error: { code: 'unauthorized', message: 'assinatura invalida' } });
    }
    const body = request.body as { store_id?: string | number; event?: string; id?: string | number };
    const storeId = String(body?.store_id ?? '');
    // Responde rapido (a Nuvemshop espera 2xx em 3 s) e trata em seguida.
    void (async () => {
      try {
        if (body?.event === 'order/created' && body.id !== undefined) await nuvemshop.onOrderCreated(storeId, String(body.id));
        if (body?.event === 'app/uninstalled') await nuvemshop.onUninstalled(storeId);
      } catch (err) {
        request.log.warn({ err, event: body?.event }, 'webhook Nuvemshop falhou');
      }
    })();
    return reply.status(200).send({ ok: true });
  });
}
