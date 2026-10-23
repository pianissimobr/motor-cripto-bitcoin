import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadEnvFile } from '../src/load-env.js';

loadEnvFile();

import { createDatabase } from '../src/adapters/db/client.js';
import { loadConfig, rpcUrlFor } from '../src/core/config.js';

/**
 * Smoke de pos-deploy: valida migracoes, colunas/indices criticos e a API.
 * Nao imprime segredos nem dados pessoais.
 *
 * Uso:
 *   npm run smoke
 *   npm run smoke -- --url http://127.0.0.1:4578
 */

const arg = (nome: string): string | undefined => {
  const i = process.argv.indexOf(`--${nome}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

type Nivel = 'ok' | 'aviso' | 'falha';
const checks: Array<{ nivel: Nivel; texto: string }> = [];

function add(nivel: Nivel, texto: string): void {
  checks.push({ nivel, texto });
}
function ok(texto: string): void {
  add('ok', texto);
}
function aviso(texto: string): void {
  add('aviso', texto);
}
function falha(texto: string): void {
  add('falha', texto);
}

const COLUNAS = [
  'api_clientes.api_key_hash',
  'api_clientes.request_secret_enc',
  'api_clientes.webhook_secret_enc',
  'api_cliente_wallets.api_cliente_id',
  'links_gerados.api_cliente_id',
  'links_gerados.page_token_hash',
  'links_gerados.liquidacao_ate',
  'links_gerados.motivo_nao_realizado',
  'webhook_outbox.next_attempt_em',
];
const INDICES = [
  'api_clientes_api_key_hash_uq',
  'api_cliente_wallets_cliente_chain_address_uq',
  'api_nonces_expira_em_idx',
  'links_gerados_cliente_external_uq',
  'links_gerados_cliente_idem_uq',
  'links_gerados_page_token_uq',
  'webhook_outbox_link_event_uq',
  'webhook_outbox_due_idx',
  'hd_indices_indice_uq',
];

async function checkDatabase(): Promise<void> {
  const config = loadConfig(process.env);
  const handle = createDatabase(config.database.url, config.database.ssl);
  const sql = handle.sql;

  try {
    const journal = JSON.parse(
      readFileSync(resolve(process.cwd(), 'db/migrations/meta/_journal.json'), 'utf8'),
    ) as { entries?: unknown[] };
    const esperadas = journal.entries?.length ?? 0;
    try {
      const [{ n } = { n: 0 }] = await sql<{ n: number }[]>`
        select count(*)::int as n from drizzle.__drizzle_migrations
      `;
      if (n < esperadas) {
        falha(`migracoes aplicadas: ${n}/${esperadas} (rode npm run migrate)`);
      } else if (n > esperadas) {
        aviso(`migracoes aplicadas: ${n} (journal local tem ${esperadas})`);
      } else {
        ok(`migracoes aplicadas: ${n}`);
      }
    } catch {
      falha('tabela de migracoes ausente: rode npm run migrate');
    }

    try {
      const rows = await sql<{ table_name: string; column_name: string }[]>`
        select table_name, column_name
        from information_schema.columns
        where table_schema = 'public'
      `;
      const encontradas = new Set(rows.map((r) => `${r.table_name}.${r.column_name}`));
      const faltando = COLUNAS.filter((c) => !encontradas.has(c));
      if (faltando.length > 0) falha(`colunas ausentes: ${faltando.join(', ')}`);
      else ok(`colunas criticas: ${COLUNAS.length}`);
    } catch (err) {
      falha(`nao foi possivel ler colunas: ${mensagem(err)}`);
    }

    try {
      const rows = await sql<{ indexname: string }[]>`
        select indexname from pg_indexes where schemaname = 'public'
      `;
      const encontrados = new Set(rows.map((r) => r.indexname));
      const faltando = INDICES.filter((i) => !encontrados.has(i));
      if (faltando.length > 0) falha(`indices ausentes: ${faltando.join(', ')}`);
      else ok(`indices criticos: ${INDICES.length}`);
    } catch (err) {
      falha(`nao foi possivel ler indices: ${mensagem(err)}`);
    }

    try {
      const [{ n } = { n: 0 }] = await sql<{ n: number }[]>`
        select count(*)::int as n
        from links_gerados l
        left join api_cliente_wallets w
          on w.api_cliente_id = l.api_cliente_id
         and w.chain = l.chain
         and w.address = l.wallet_address
        where l.status in ('pago', 'pago_sem_gas', 'nao_realizado', 'movido')
          and w.id is null
      `;
      if (n > 0) falha(`${n} link(s) liquidado(s) sem carteira allowlisted de destino`);
      else ok('links liquidados apontam para carteira allowlisted');
    } catch (err) {
      falha(`nao foi possivel checar destinos de sweep: ${mensagem(err)}`);
    }

    try {
      const [{ n } = { n: 0 }] = await sql<{ n: number }[]>`
        select count(*)::int as n from links_gerados where wallet_address is null
      `;
      if (n > 0) aviso(`${n} link(s) legado(s) sem wallet_address`);
      else ok('todos os links tem wallet_address');
    } catch (err) {
      falha(`nao foi possivel checar wallet_address: ${mensagem(err)}`);
    }

    let chains: string[] = [];
    try {
      const rows = await sql<{ chain: string }[]>`
        select distinct chain from ramp_profiles where ativo = true
      `;
      chains = rows.map((r) => r.chain);
      if (chains.length === 0) aviso('nenhum perfil Ramp ativo: rode npm run seed');
      else ok(`perfis Ramp ativos: ${chains.length} chain(s)`);
    } catch (err) {
      falha(`nao foi possivel ler perfis Ramp: ${mensagem(err)}`);
    }

    if (config.gasSponsor.privateKey) ok('gas sponsor configurado');
    else aviso('GAS_SPONSOR_PRIVATE_KEY ausente: links pagos ficam em pago_sem_gas');

    for (const chain of chains) {
      try {
        rpcUrlFor(chain);
        ok(`RPC configurado para ${chain}`);
      } catch {
        falha(`RPC_URL_${chain.toUpperCase()} ausente`);
      }
    }
  } finally {
    await handle.close();
  }
}

async function checkHttp(baseUrl: string): Promise<void> {
  const base = baseUrl.replace(/\/+$/, '');
  try {
    const resp = await fetch(`${base}/health`, { signal: AbortSignal.timeout(5_000) });
    if (!resp.ok) falha(`GET /health respondeu ${resp.status}`);
    else ok('API /health');
  } catch (err) {
    falha(`API indisponivel em ${base}: ${mensagem(err)}`);
    return;
  }

  const token = process.env.ADMIN_TOKEN;
  if (!token) {
    aviso('ADMIN_TOKEN ausente: /admin/api/status nao verificado');
    return;
  }
  try {
    const resp = await fetch(`${base}/admin/api/status`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5_000),
    });
    if (!resp.ok) {
      falha(`GET /admin/api/status respondeu ${resp.status}`);
    } else {
      const body = (await resp.json()) as { data?: { clientes?: number } };
      if (typeof body.data?.clientes === 'number') ok('API /admin/api/status (admin)');
      else falha('resposta inesperada em /admin/api/status');
    }
  } catch (err) {
    falha(`GET /admin/api/status falhou: ${mensagem(err)}`);
  }
}

function mensagem(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function main(): Promise<void> {
  console.log('\n=== Smoke do motor-cripto ===\n');
  await checkDatabase();
  const url = arg('url');
  if (url) await checkHttp(url);

  for (const c of checks) {
    const marca = c.nivel === 'ok' ? '[ok]   ' : c.nivel === 'aviso' ? '[aviso]' : '[falha]';
    console.log(`${marca} ${c.texto}`);
  }

  const falhas = checks.filter((c) => c.nivel === 'falha').length;
  const avisos = checks.filter((c) => c.nivel === 'aviso').length;
  console.log(`\nFalhas: ${falhas} | Avisos: ${avisos}\n`);
  process.exit(falhas > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
