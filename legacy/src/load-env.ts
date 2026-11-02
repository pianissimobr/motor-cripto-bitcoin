import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Carrega o arquivo .env usando o loader nativo do Node (process.loadEnvFile).
 * Valores ja presentes no ambiente tem prioridade: o .env nao sobrescreve
 * variaveis ja exportadas (padrao de `process.loadEnvFile`).
 */
export function loadEnvFile(path = resolve(process.cwd(), '.env')): void {
  if (!existsSync(path)) return;
  try {
    process.loadEnvFile(path);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`falha ao carregar ${path}: ${message}`);
  }
}
