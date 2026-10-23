import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

type Snapshot = {
  id: string;
  prevId: string;
  tables: Record<
    string,
    {
      columns: Record<string, { name: string; notNull: boolean; type?: string }>;
      indexes: Record<string, { name: string; isUnique: boolean }>;
      compositePrimaryKeys: Record<string, { name: string; columns: string[] }>;
    }
  >;
};

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(new URL(`../db/migrations/meta/${path}`, import.meta.url), 'utf8')) as T;
}

const journal = readJson<{ entries: Array<{ idx: number; tag: string }> }>('_journal.json');

describe('migracoes: journal e snapshots em sincronia', () => {
  it('cada entrada do journal tem snapshot encadeado', () => {
    let anterior = '00000000-0000-0000-0000-000000000000';
    for (const entry of journal.entries) {
      const arquivo = `${String(entry.idx).padStart(4, '0')}_snapshot.json`;
      const snap = readJson<Snapshot>(arquivo);
      expect(snap.prevId).toBe(anterior);
      anterior = snap.id;
    }
  });

  it('o snapshot final reflete o schema API-only', () => {
    const snap = readJson<Snapshot>('0013_snapshot.json');

    for (const removida of ['cadastros', 'contas', 'sessoes', 'creditos_cliente', 'carteiras_frias']) {
      expect(snap.tables[`public.${removida}`]).toBeUndefined();
    }

    const clientes = snap.tables['public.api_clientes']!;
    expect(clientes.columns.request_secret_enc?.notNull).toBe(true);
    expect(clientes.columns.webhook_secret_enc?.notNull).toBe(true);
    expect(clientes.indexes.api_clientes_api_key_hash_uq?.isUnique).toBe(true);

    const wallets = snap.tables['public.api_cliente_wallets']!;
    expect(
      wallets.indexes.api_cliente_wallets_cliente_chain_address_uq?.isUnique,
    ).toBe(true);

    const links = snap.tables['public.links_gerados']!;
    expect(links.columns.api_cliente_id?.notNull).toBe(true);
    expect(links.columns.wallet_address?.notNull).toBe(true);
    expect(links.columns.page_token_hash?.notNull).toBe(true);
    expect(links.columns.liquidacao_ate?.notNull).toBe(true);
    expect(links.columns.motivo_nao_realizado?.notNull).toBe(false);
    expect(links.indexes.links_gerados_cliente_external_uq?.isUnique).toBe(true);
    expect(links.indexes.links_gerados_cliente_idem_uq?.isUnique).toBe(true);
    expect(links.indexes.links_gerados_page_token_uq?.isUnique).toBe(true);

    const webhooks = snap.tables['public.webhook_outbox']!;
    expect(webhooks.indexes.webhook_outbox_link_event_uq?.isUnique).toBe(true);
    expect(webhooks.columns.next_attempt_em?.notNull).toBe(true);

    const movimentos = snap.tables['public.movimentos_internos']!;
    expect(movimentos.indexes.movimentos_internos_link_kind_nonce_uq?.isUnique).toBe(true);
    expect(snap.tables['public.hd_indices']!.indexes.hd_indices_indice_uq?.isUnique).toBe(true);
  });
});
