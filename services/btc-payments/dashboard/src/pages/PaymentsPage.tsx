import { useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { Card, Empty, PageHeader, Spinner, StatusBadge } from '../components/ui';
import { dateTime, money, shortHash } from '../format';
import { useMerchantId } from '../session';
import type { PaymentKind, PaymentPage } from '../types';

const TABS: { id: PaymentKind | 'invoice'; label: string }[] = [
  { id: 'invoice', label: 'Faturas' },
  { id: 'pix', label: 'Pix' },
  { id: 'bitcoin', label: 'Bitcoin' },
  { id: 'request', label: 'Pedidos' },
];

type InvoiceRow = {
  id: string;
  order_id: string;
  mode: string;
  status: string;
  price_amount: string;
  price_currency: string;
  invoice_url: string;
  paid_rail: string | null;
  created_at: string;
};

const INVOICE_STATUS: Record<string, string> = { aguardando: 'pendente', confirmando: 'depositado', pago: 'pago', expirado: 'expirado', cancelado: 'cancelado' };

function InvoicesTab({ merchantId }: { merchantId: string }) {
  const [mode, setMode] = useState<'live' | 'test'>('live');
  const query = useQuery({
    queryKey: ['invoices', merchantId, mode],
    queryFn: () => api<{ invoices: InvoiceRow[] }>(`/v1/dash/merchants/${merchantId}/invoices?mode=${mode}&limit=100`),
  });
  const rows = query.data?.invoices ?? [];
  return (
    <Card>
      <div className="filters">
        <div className="segmented">
          <button className={mode === 'live' ? 'active' : ''} onClick={() => setMode('live')}>Produção</button>
          <button className={mode === 'test' ? 'active' : ''} onClick={() => setMode('test')}>Teste</button>
        </div>
      </div>
      {query.isLoading && <Spinner />}
      {!query.isLoading && rows.length === 0 && <Empty>Nenhuma fatura criada pelas lojas virtuais ainda.</Empty>}
      {rows.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Criada</th>
                <th>Pedido</th>
                <th>Status</th>
                <th>Meio</th>
                <th className="num">Valor</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td>{dateTime(row.created_at)}</td>
                  <td className="mono">{row.order_id}</td>
                  <td><StatusBadge status={INVOICE_STATUS[row.status] ?? row.status} /></td>
                  <td>{row.paid_rail === 'pix' ? 'Pix' : row.paid_rail === 'bitcoin' ? 'Bitcoin' : '—'}</td>
                  <td className="num">{money(row.price_amount.replace('.', ''), row.price_currency)}</td>
                  <td>
                    <a href={row.invoice_url} target="_blank" rel="noreferrer noopener">Abrir</a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

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
  const tipo = params.get('tipo') ?? 'invoice';
  const kind = (tipo === 'invoice' ? 'pix' : tipo) as PaymentKind;
  const status = params.get('status') ?? '';
  const [search, setSearch] = useState(params.get('pedido') ?? '');
  const externalId = params.get('pedido') ?? '';

  const query = useInfiniteQuery({
    enabled: tipo !== 'invoice',
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
          <button key={tab.id} className={tab.id === tipo ? 'active' : ''} onClick={() => update({ tipo: tab.id, status: '' })}>
            {tab.label}
          </button>
        ))}
      </div>
      {tipo === 'invoice' ? (
        <InvoicesTab merchantId={merchantId} />
      ) : (
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
      )}
    </>
  );
}
