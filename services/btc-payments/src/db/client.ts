import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.js';

export type Db = PostgresJsDatabase<typeof schema>;

export type DbClient = {
  sql: postgres.Sql;
  db: Db;
  ping: () => Promise<void>;
  close: () => Promise<void>;
};

export function createDb(config: {
  url: string;
  ssl: false | { ca?: string };
}): DbClient {
  const sql = postgres(config.url, {
    max: 10,
    idle_timeout: 20,
    connect_timeout: 10,
    ssl: config.ssl,
  });
  const db = drizzle(sql, { schema });

  return {
    sql,
    db,
    ping: async () => {
      await sql`select 1`;
    },
    close: async () => {
      await sql.end({ timeout: 5 });
    },
  };
}
