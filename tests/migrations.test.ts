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

  it('o snapshot final reflete o schema endurecido', () => {
    const snap = readJson<Snapshot>('0011_snapshot.json');
    const cadastros = snap.tables['public.cadastros']!;
    expect(cadastros.columns.email_bidx_anterior).toBeDefined();
    expect(cadastros.indexes.cadastros_email_bidx_anterior_idx?.isUnique).toBe(false);

    const prefixos = snap.tables['public.cadastros_prefixos']!;
    expect(prefixos.compositePrimaryKeys.cadastros_prefixos_cliente_prefix_pk?.columns).toEqual([
      'cliente_id',
      'prefix_bidx',
    ]);
    expect(prefixos.indexes.cadastros_prefixos_prefix_idx).toBeDefined();

    const movimentos = snap.tables['public.movimentos_internos']!;
    expect(movimentos.columns.kind?.notNull).toBe(true);
    expect(movimentos.columns.raw_transaction?.notNull).toBe(false);
    expect(movimentos.columns.unsigned_transaction?.notNull).toBe(false);
    expect(movimentos.indexes.movimentos_internos_link_kind_nonce_uq?.isUnique).toBe(true);

    expect(snap.tables['public.hd_indices']!.indexes.hd_indices_indice_uq?.isUnique).toBe(true);
    expect(
      snap.tables['public.links_gerados']!.indexes.links_gerados_indice_hd_uq?.isUnique,
    ).toBe(true);
    expect(snap.tables['public.creditos_cliente']!.columns.valor_centavos?.type).toBe('bigint');
  });
});
