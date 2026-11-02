import { describe, expect, it } from 'vitest';
import { createSafeFetch } from '../src/net/safe-fetch.js';

describe('safe fetch (URLs de lojistas)', () => {
  const strict = createSafeFetch({ allowLoopback: false });

  it('bloqueia IP interno informado direto na URL', async () => {
    await expect(strict('http://127.0.0.1:1/api/v1/wallet')).rejects.toThrow(/destino bloqueado/);
    await expect(strict('http://169.254.169.254/latest/meta-data')).rejects.toThrow(
      /destino bloqueado/,
    );
    await expect(strict('http://10.0.0.5/')).rejects.toThrow(/destino bloqueado/);
  });

  it('bloqueia nome que resolve para a rede interna no momento da conexao', async () => {
    await expect(strict('http://localhost:65000/')).rejects.toThrow();
    const err = await strict('http://localhost:65000/').catch((e: Error) => e);
    expect(String((err as Error & { cause?: Error }).cause ?? err)).toMatch(/destino bloqueado/);
  });

  it('fora de producao permite loopback (LNbits local de desenvolvimento)', async () => {
    const dev = createSafeFetch({ allowLoopback: true });
    // Porta fechada: falha de conexao, mas nao por bloqueio.
    const err = await dev('http://127.0.0.1:65000/').catch((e: Error) => e);
    expect(String((err as Error & { cause?: Error }).cause ?? err)).not.toMatch(/destino bloqueado/);
  });
});
