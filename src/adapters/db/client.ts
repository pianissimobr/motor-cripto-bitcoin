import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from './schema.js';

export type Database = ReturnType<typeof drizzle<typeof schema>>;

export type DatabaseHandle = {
  db: Database;
  sql: postgres.Sql;
  close: () => Promise<void>;
};

export function createDatabase(url: string, ssl: boolean): DatabaseHandle {
  const sql = postgres(url, {
    ssl: ssl ? 'require' : false,
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
