import { describe, expect, it } from 'vitest';
import {
  LuniumRateLimiter,
  RateLimiterQueueFullError,
} from '../src/adapters/lunium/rate-limiter.js';

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

describe('LuniumRateLimiter', () => {
  it('nao deixa passar mais que o teto dentro da janela', async () => {
    const limiter = new LuniumRateLimiter({
      maxRequests: 60,
      windowMs: 120,
    });

    const inicio = Date.now();
    // 5 rajadas saem de uma vez; a partir dai o balde segura a taxa.
    for (let i = 0; i < 5; i++) {
      await limiter.acquire('normal');
    }
    expect(Date.now() - inicio).toBeLessThan(50);

    for (let i = 0; i < 55; i++) {
      await limiter.acquire('normal');
    }
    const decorrido = Date.now() - inicio;

    // 60 requisicoes numa janela de 120 ms: a 61a precisa esperar a janela.
    expect(decorrido).toBeGreaterThanOrEqual(100);
    expect(limiter.currentLimit).toBe(60);
  });

  it('atende antes a chamada de prioridade alta', async () => {
    const limiter = new LuniumRateLimiter({
      maxRequests: 1,
      windowMs: 200,
    });

    await limiter.acquire('normal');
    const ordem: string[] = [];
    const baixa = limiter.acquire('normal').then(() => ordem.push('normal'));
    const alta = limiter.acquire('alta').then(() => ordem.push('alta'));

    await Promise.all([baixa, alta]);
    expect(ordem).toEqual(['alta', 'normal']);
  });

  it('pausa tudo e reduz a taxa quando o provedor recusa por limite', async () => {
    const limiter = new LuniumRateLimiter({
      maxRequests: 60,
      windowMs: 100,
    });

    limiter.recordThrottled(1_000);

    expect(limiter.currentLimit).toBe(30);
    expect(limiter.cooldownRemaining()).toBeGreaterThan(0);

    const inicio = Date.now();
    await limiter.acquire('normal');
    expect(Date.now() - inicio).toBeGreaterThanOrEqual(900);
  });

  it('sobe a taxa de volta depois de um periodo sem recusa', () => {
    const limiter = new LuniumRateLimiter({
      maxRequests: 60,
      windowMs: 100,
      restoreAfterSuccesses: 3,
    });

    limiter.recordThrottled(1_000);
    expect(limiter.currentLimit).toBe(30);

    for (let i = 0; i < 3; i++) limiter.recordSuccess();
    expect(limiter.currentLimit).toBe(31);
  });

  it('recusa a chamada em vez de acumular a fila', async () => {
    const limiter = new LuniumRateLimiter({
      maxRequests: 1,
      windowMs: 120,
      maxQueue: 2,
    });

    await limiter.acquire('normal');
    const a = limiter.acquire('normal');
    const b = limiter.acquire('normal');

    await expect(limiter.acquire('normal')).rejects.toBeInstanceOf(
      RateLimiterQueueFullError,
    );

    await Promise.all([a, b]);
  });
});
