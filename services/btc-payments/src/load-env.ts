import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Carrega `services/btc-payments/.env` quando o processo e iniciado pelo
 * diretorio do pacote (npm run dev / npm run worker). Variaveis ja definidas
 * no ambiente vencem o arquivo: `process.loadEnvFile` nao sobrescreve.
 */
export function loadEnv(): void {
  const path = resolve(process.cwd(), '.env');
  if (existsSync(path)) process.loadEnvFile(path);
}
