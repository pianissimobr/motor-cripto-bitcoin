import { useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { Card, Empty, PageHeader, Spinner, StatusBadge } from '../components/ui';
import { dateTime, money, shortHash } from '../format';
import { useMerchantId } from '../session';
import type { PaymentKind, PaymentPage } from '../types';

const TABS: { id: PaymentKind; label: string }[] = [
  { id: 'pix', label: 'Pix' },
  { id: 'bitcoin', label: 'Bitcoin' },
  { id: 'request', label: 'Pedidos' },
];

const STATUS: Record<PaymentKind, { id: string; label: string }[]> = {
  pix: [
    { id: 'pendente', label: 'Aguardando' },
    { id: 'pago,liquidado', label: 'Pagos' },
    { id: 'expirado', label: 'Expirados' },
    { id: 'falhou,manual,incerto', label: 'Com problema' },
  ],
  bitcoin: [
    { id: 'aguardando_deposito', label: 'Aguardando depósito' },
    { id: 'depositado,trocado', label: 'Em conversão' },
    { id: 'liquidado', label: 'Liquidados' },
    { id: 'expirado,reembolsado', label: 'Expirados' },
    { id: 'falhou,manual,incerto', label: 'Com problema' },
  ],
  request: [
    { id: 'pendente', label: 'Aguardando' },
    { id: 'pago', label: 'Pagos' },
    { id: 'expirado', label: 'Expirados' },
  ],
};

export default function PaymentsPage() {
  const merchantId = useMerchantId();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const kind = (params.get('tipo') as PaymentKind | null) ?? 'pix';
  const status = params.get('status') ?? '';
  const [search, setSearch] = useState(params.get('pedido') ?? '');
  const externalId = params.get('pedido') ?? '';

  const query = useInfiniteQuery({
    queryKey: ['payments', merchantId, kind, status, externalId],
    initialPageParam: '',
    queryFn: ({ pageParam }) => {
      const qs = new URLSearchParams({ kind, limit: '25' });
      if (status) qs.set('status', status);
      if (externalId) qs.set('external_id', externalId);
      if (pageParam) qs.set('cursor', pageParam);
      return api<PaymentPage>(`/v1/dash/merchants/${merchantId}/payments?${qs}`);
    },
    getNextPageParam: (last) => last.next_cursor ?? undefined,
  });

  const update = (next: Record<string, string>) => {
    const merged = new URLSearchParams(params);
    for (const [k, v] of Object.entries(next)) {
      if (v) merged.set(k, v);
      else merged.delete(k);
    }
    setParams(merged, { replace: true });
  };

  const items = query.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <>
      <PageHeader title="Pagamentos" subtitle="Tudo o que seus clientes pagaram ou ainda vão pagar." />
      <div className="tabs">
        {TABS.map((tab) => (
          <button key={tab.id} className={tab.id === kind ? 'active' : ''} onClick={() => update({ tipo: tab.id, status: '' })}>
            {tab.label}
          </button>
        ))}
      </div>
      <Card>
        <div className="filters">
          <select value={status} onChange={(e) => update({ status: e.target.value })} aria-label="Status">
            <option value="">Todos os status</option>
            {STATUS[kind].map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              update({ pedido: search.trim() });
            }}
          >
            <input placeholder="Buscar pelo código do pedido (external_id)" value={search} onChange={(e) => setSearch(e.target.value)} />
          </form>
        </div>
        {query.isLoading && <Spinner />}
        {!query.isLoading && items.length === 0 && <Empty>Nenhum pagamento por aqui ainda.</Empty>}
        {items.length > 0 && (
          <div className="table-wrap">
            <table className="table table-click">
              <thead>
                <tr>
                  <th>Criado</th>
                  <th>Pedido</th>
                  <th>Status</th>
                  <th className="num">Valor</th>
                  <th>Transação</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.id} onClick={() => navigate(`/pagamentos/${item.kind}/${item.id}`)}>
                    <td>{dateTime(item.created_at)}</td>
                    <td className="mono">{item.external_id}</td>
                    <td>
                      <StatusBadge status={item.status} />
                    </td>
                    <td className="num">{money(item.amount_cents, item.currency)}</td>
                    <td className="mono">{shortHash(item.tx_hash)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {query.hasNextPage && (
          <div className="center">
            <button className="btn btn-ghost" onClick={() => void query.fetchNextPage()} disabled={query.isFetchingNextPage}>
              {query.isFetchingNextPage ? 'Carregando…' : 'Carregar mais'}
            </button>
          </div>
        )}
      </Card>
    </>
  );
}
