import type { FastifyInstance } from 'fastify';
import type { Readiness } from './readiness.js';

export type RoutesDeps = {
  service: {
    name: string;
    version: string;
  };
  readiness: Readiness;
};

export function registerRoutes(app: FastifyInstance, deps: RoutesDeps): void {
  app.get('/health', async () => ({
    ok: true,
    service: deps.service.name,
    version: deps.service.version,
    ts: new Date().toISOString(),
  }));

  app.get('/ready', async (_request, reply) => {
    const results = await Promise.all(
      deps.readiness.checks.map(async (check) => {
        try {
          return [check.name, await check.run()] as const;
        } catch (err) {
          return [
            check.name,
            {
              ok: false,
              detail: err instanceof Error ? err.message : String(err),
            },
          ] as const;
        }
      }),
    );

    const checks = Object.fromEntries(results);
    const ok = results.every(([, result]) => result.ok);
    return reply.status(ok ? 200 : 503).send({
      ok,
      service: deps.service.name,
      version: deps.service.version,
      checks,
      ts: new Date().toISOString(),
    });
  });
}
