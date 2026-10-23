import postgres from 'postgres';
import { createDatabase, type DatabaseHandle } from '../../src/adapters/db/client.js';

export const DEFAULT_TEST_DATABASE_URL =
  'postgres://motor:motor_dev_password@localhost:5432/motor_cripto_test';

export function testDatabaseUrl(): string {
  return process.env.TEST_DATABASE_URL ?? DEFAULT_TEST_DATABASE_URL;
}

function parseDatabaseName(url: string): string {
  const parsed = new URL(url);
  const name = parsed.pathname.replace(/^\//, '');
  if (!/^[A-Za-z0-9_]+$/.test(name)) {
    throw new Error(`nome de banco de teste invalido: "${name}"`);
  }
  return name;
}

function maintenanceUrl(url: string): string {
  const parsed = new URL(url);
  parsed.pathname = '/postgres';
  return parsed.toString();
}

/** Cria o banco de teste se ainda nao existir. */
export async function ensureTestDatabase(url = testDatabaseUrl()): Promise<void> {
  const name = parseDatabaseName(url);
  const admin = postgres(maintenanceUrl(url), {
    max: 1,
    connect_timeout: 5,
    onnotice: () => {},
  });
  try {
    const rows = await admin`select 1 from pg_database where datname = ${name}`;
    if (rows.length === 0) {
      await admin.unsafe(`CREATE DATABASE "${name}"`);
    }
  } finally {
    await admin.end({ timeout: 5 });
  }
}

/** Recria o schema public do banco de teste. */
export async function resetSchema(url = testDatabaseUrl()): Promise<void> {
  const sql = postgres(url, { max: 1, connect_timeout: 5, onnotice: () => {} });
  try {
    await sql.unsafe('DROP SCHEMA IF EXISTS public CASCADE');
    await sql.unsafe('CREATE SCHEMA public');
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/** Aplica todas as migrations SQL na ordem do arquivo. */
export async function runMigrations(url = testDatabaseUrl()): Promise<void> {
  const { readdir, readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const dir = join(process.cwd(), 'db', 'migrations');
  const files = (await readdir(dir))
    .filter((f) => /^\d+_.*\.sql$/.test(f))
    .sort((a, b) => a.localeCompare(b, 'en'));

  const sql = postgres(url, { max: 1, connect_timeout: 5, onnotice: () => {} });
  try {
    for (const file of files) {
      const content = await readFile(join(dir, file), 'utf8');
      const statements = content
        .split('--> statement-breakpoint')
        .map((s) => s.trim())
        .filter(Boolean);
      for (const statement of statements) {
        await sql.unsafe(statement);
      }
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

export function createTestDb(): DatabaseHandle {
  return createDatabase(testDatabaseUrl(), false);
}

export async function truncateAll(handle: DatabaseHandle): Promise<void> {
  await handle.sql.unsafe(`
    TRUNCATE TABLE
      eventos_auditoria,
      webhook_outbox,
      movimentos_internos,
      links_pagos,
      api_nonces,
      hd_indices,
      links_gerados,
      api_cliente_wallets,
      api_clientes,
      chain_anchors,
      chain_cursors,
      ramp_profiles
    RESTART IDENTITY CASCADE
  `);
}
