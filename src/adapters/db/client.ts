import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from './schema.js';

export type Database = ReturnType<typeof drizzle<typeof schema>>;

export type DatabaseHandle = {
  db: Database;
  sql: postgres.Sql;
  close: () => Promise<void>;
};

export function createDatabase(url: string, ssl: DatabaseTls | boolean): DatabaseHandle {
  const sql = postgres(url, {
    ssl: pgSsl(ssl),
    max: 10,
    idle_timeout: 30,
    connect_timeout: 15,
    onnotice: () => {},
  });
  const db = drizzle(sql, { schema });
  return {
    db,
    sql,
    close: async () => {
      await sql.end({ timeout: 5 });
    },
  };
}


/**
 * Conexao DEDICADA para advisory lock de sessao.
 *
 * O pool normal devolve a conexao ao pool apos a query; com
 * `idle_timeout` a sessao pode ser fechada e o Postgres libera o lock
 * silenciosamente. Para um lock de longa duracao precisamos de uma sessao
 * que fique viva enquanto o worker rodar.
 */
export function createLockClient(url: string, ssl: DatabaseTls | boolean): postgres.Sql {
  return postgres(url, {
    ssl: pgSsl(ssl),
    max: 1,
    idle_timeout: 0,
    connect_timeout: 15,
    onnotice: () => {},
  });
}

export type DatabaseTls = false | { ca?: string };

/**
 * `false` = sem TLS. `true` ou `{ ca? }` = verify-full (o servidor precisa
 * apresentar um certificado valido). `require` cifrava e nao autenticava.
 */
export function pgSsl(
  tls: DatabaseTls | boolean,
): false | 'verify-full' | { rejectUnauthorized: true; ca: string } {
  if (tls === false) return false;
  if (tls === true) return 'verify-full';
  if (tls.ca) return { rejectUnauthorized: true, ca: tls.ca };
  return 'verify-full';
}
