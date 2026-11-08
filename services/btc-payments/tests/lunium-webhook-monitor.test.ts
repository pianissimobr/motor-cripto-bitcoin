import { describe, expect, it } from 'vitest';
import { silentLogger } from '../src/logger.js';
import { LuniumWebhookMonitor } from '../src/services/lunium-webhook-monitor.js';

function setup(deliveries: { event_id: string; event: string; status: 'failed'; last_error?: string }[], delivered: Record<string, boolean>) {
  const retries: string[] = [];
  const alerts: unknown[] = [];
  let now = 1_000_000;
  const monitor = new LuniumWebhookMonitor({
    lunium: {
      listWebhookDeliveries: async () => ({ deliveries }),
      retryWebhookDelivery: async (id: string) => {
        retries.push(id);
        return { event_id: id, delivered: delivered[id] ?? false };
      },
    } as never,
    logger: silentLogger,
    alerts: { send: async (a: unknown) => (alerts.push(a), { channels: [], failures: [] }) } as never,
    now: () => now,
  });
  return { monitor, retries, alerts, advance: (ms: number) => (now += ms) };
}

describe('monitor de webhooks da Lunium', () => {
  it('reenvia cada entrega esgotada uma vez; recuperou tudo, sem alerta', async () => {
    const { monitor, retries, alerts } = setup(
      [
        { event_id: 'evt_1', event: 'cashin.paid', status: 'failed' },
        { event_id: 'evt_t', event: 'webhook.test', status: 'failed' },
      ],
      { evt_1: true },
    );
    expect(await monitor.runCycle()).toEqual({ failed: 1, retried: 1, recovered: 1 });
    expect(retries).toEqual(['evt_1']);
    expect(alerts).toHaveLength(0);
    await monitor.runCycle();
    expect(retries).toEqual(['evt_1']);
  });

  it('falha que continua: alerta, no maximo uma vez por hora', async () => {
    const { monitor, alerts, advance } = setup([{ event_id: 'evt_2', event: 'cashout.completed', status: 'failed', last_error: 'HTTP 502' }], {});
    await monitor.runCycle();
    await monitor.runCycle();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ level: 'warn', message: expect.stringContaining('HTTP 502') });
    advance(3_600_001);
    await monitor.runCycle();
    expect(alerts).toHaveLength(2);
  });
});
