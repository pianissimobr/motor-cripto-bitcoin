import { ensureTestDatabase, resetSchema, runMigrations, testDatabaseUrl } from './helpers.js';

/**
 * Setup unico da suite de integracao: banco dedicado + migrations reais.
 * Nao toca no banco de desenvolvimento.
 */
export default async function setup(): Promise<void> {
  const url = testDatabaseUrl();
  try {
    await ensureTestDatabase(url);
    await resetSchema(url);
    await runMigrations(url);
  } catch (err) {
    throw new Error(
      `Nao foi possivel preparar o Postgres de teste em ${url}. ` +
        'Suba o docker-compose e/ou defina TEST_DATABASE_URL. ' +
        `Causa: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
