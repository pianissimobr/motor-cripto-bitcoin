import { defineConfig } from 'drizzle-kit';

/**
 * Config do drizzle-kit (geracao de migrations).
 * As migrations aplicadas ficam em db/migrations.
 */
export default defineConfig({
  schema: './src/adapters/db/schema.ts',
  out: './db/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://motor:motor_dev_password@localhost:5432/motor_cripto',
  },
  strict: true,
  verbose: true,
});
