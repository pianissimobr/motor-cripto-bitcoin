import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadEnvFile } from '../src/load-env.js';

loadEnvFile();

import { createDatabase } from '../src/adapters/db/client.js';
import { loadConfig, rpcUrlFor } from '../src/core/config.js';

/**
 * Smoke de pos-deploy: valida migracoes, colunas/indices criticos, dados
 * duplicados e, opcionalmente, a API. Nao imprime segredos nem PII.
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
  'cadastros.email_bidx_anterior',
  'movimentos_internos.kind',
  'movimentos_internos.raw_transaction',
  'movimentos_internos.unsigned_transaction',
];
const INDICES = [
  'cadastros_email_bidx_uq',
  'cadastros_email_bidx_anterior_idx',
  'cadastros_prefixos_cliente_prefix_pk',
  'cadastros_prefixos_prefix_idx',
  'hd_indices_indice_uq',
  'links_gerados_indice_hd_uq',
  'movimentos_internos_link_kind_nonce_uq',
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
      if (faltando.length > 0) {
        falha(`colunas ausentes: ${faltando.join(', ')}`);
      } else {
        ok(`colunas criticas: ${COLUNAS.length}`);
      }
    } catch (err) {
      falha(`nao foi possivel ler colunas: ${mensagem(err)}`);
    }

    try {
      const rows = await sql<{ indexname: string }[]>`
        select indexname from pg_indexes where schemaname = 'public'
      `;
      const encontrados = new Set(rows.map((r) => r.indexname));
      const faltando = INDICES.filter((i) => !encontrados.has(i));
      if (faltando.length > 0) {
        falha(`indices ausentes: ${faltando.join(', ')}`);
      } else {
        ok(`indices criticos: ${INDICES.length}`);
      }
    } catch (err) {
      falha(`nao foi possivel ler indices: ${mensagem(err)}`);
    }

    try {
      const [{ n } = { n: 0 }] = await sql<{ n: number }[]>`
        select count(*)::int as n
        from (
          select email_bidx from cadastros group by email_bidx having count(*) > 1
        ) d
      `;
      if (n > 0) {
        falha(`${n} e-mail(s) com indice ativo duplicado`);
      } else {
        ok('indice ativo de e-mail sem duplicados');
      }
    } catch (err) {
      falha(`nao foi possivel checar e-mails duplicados: ${mensagem(err)}`);
    }

    try {
      const [{ n } = { n: 0 }] = await sql<{ n: number }[]>`
        select count(*)::int as n
        from links_gerados
        where carteira_fria_endereco is null
      `;
      if (n > 0) {
        aviso(`${n} link(s) legado(s) sem destino persistido (fallback por chain no sweep)`);
      } else {
        ok('todos os links tem destino de sweep persistido');
      }
    } catch (err) {
      falha(`nao foi possivel checar destinos de sweep: ${mensagem(err)}`);
    }

    let chains: string[] = [];
    try {
      const rows = await sql<{ chain: string }[]>`
        select distinct chain from ramp_profiles where ativo = true
      `;
      chains = rows.map((r) => r.chain);
      if (chains.length === 0) {
        aviso('nenhum perfil Ramp ativo: rode npm run seed');
      } else {
        ok(`perfis Ramp ativos: ${chains.length} chain(s)`);
      }
    } catch (err) {
      falha(`nao foi possivel ler perfis Ramp: ${mensagem(err)}`);
    }

    try {
      const [{ n } = { n: 0 }] = await sql<{ n: number }[]>`
        select count(*)::int as n from carteiras_frias
      `;
      if (n === 0) aviso('nenhuma carteira fria cadastrada');
      else ok(`carteiras frias: ${n}`);
    } catch (err) {
      falha(`nao foi possivel ler carteiras frias: ${mensagem(err)}`);
    }

    if (config.gasSponsor.privateKey) {
      ok('gas sponsor configurado');
    } else {
      aviso('GAS_SPONSOR_PRIVATE_KEY ausente: links pagos ficam em pago_sem_gas');
    }

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
    const resp = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(5_000) });
    if (!resp.ok) falha(`GET /api/health respondeu ${resp.status}`);
    else ok('API /api/health');
  } catch (err) {
    falha(`API indisponivel em ${base}: ${mensagem(err)}`);
    return;
  }

  const token = process.env.ADMIN_TOKEN;
  if (!token) {
    aviso('ADMIN_TOKEN ausente: /api/auth/check nao verificado');
    return;
  }
  try {
    const resp = await fetch(`${base}/api/auth/check`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5_000),
    });
    if (!resp.ok) {
      falha(`GET /api/auth/check respondeu ${resp.status}`);
    } else {
      const body = (await resp.json()) as { escopo?: string };
      if (body.escopo === 'admin') ok('API /api/auth/check (admin)');
      else falha(`escopo inesperado em /api/auth/check: ${String(body.escopo)}`);
    }
  } catch (err) {
    falha(`GET /api/auth/check falhou: ${mensagem(err)}`);
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
  console.error('erro no smoke:', err);
  process.exit(1);
});
