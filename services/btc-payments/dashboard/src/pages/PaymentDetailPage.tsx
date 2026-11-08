import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { api, errorText } from '../api';
import { Alert, Card, PageHeader, Spinner, StatusBadge } from '../components/ui';
import { dateTime, money } from '../format';
import { useMerchantId } from '../session';
import type { WebhookEvent } from '../types';

type Detail = { kind: string; payment: Record<string, unknown>; webhooks: WebhookEvent[] };

const EXPLORER = 'https://polygonscan.com/tx/';

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="kv">
      <span className="muted">{label}</span>
      <span>{children}</span>
    </div>
  );
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

export default function PaymentDetailPage() {
  const merchantId = useMerchantId();
  const { kind, id } = useParams();
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ['payment', merchantId, kind, id],
    queryFn: () => api<Detail>(`/v1/dash/merchants/${merchantId}/payments/${kind}/${id}`),
  });
  const replay = useMutation({
    mutationFn: (eventId: string) => api(`/v1/dash/merchants/${merchantId}/webhook/events/${eventId}/replay`, { method: 'POST' }),
    onSuccess: () => client.invalidateQueries({ queryKey: ['payment', merchantId, kind, id] }),
  });

  if (query.isLoading) return <Spinner />;
  if (query.error) return <Alert>{errorText(query.error)}</Alert>;
  const p = query.data!.payment;
  const amount = str(p.amount_brl_cents) ?? str(p.amount_cents) ?? str(p.amount_fiat_cents) ?? '0';
  const txHash = str(p.settlement_tx_hash) ?? str((p.delivery as Record<string, unknown> | undefined)?.tx_hash);

  return (
    <>
      <PageHeader title={`Pagamento ${str(p.external_id) ?? ''}`} subtitle={`Id ${id}`} actions={<Link to="/pagamentos">Voltar</Link>} />
      <Card title="Resumo">
        <Row label="Status">
          <StatusBadge status={String(p.status)} />
        </Row>
        <Row label="Valor">{money(amount, str(p.currency) ?? 'BRL')}</Row>
        <Row label="Criado">{dateTime(str(p.created_at))}</Row>
        <Row label="Atualizado">{dateTime(str(p.updated_at))}</Row>
        {str(p.destination_address) && <Row label="Carteira de destino"><span className="mono">{str(p.destination_address)}</span></Row>}
        {txHash && (
          <Row label="Transação">
            <a className="mono" href={`${EXPLORER}${txHash}`} target="_blank" rel="noreferrer noopener">
              {txHash}
            </a>
          </Row>
        )}
      </Card>
      {kind === 'pix' && (
        <Card title="Notificações enviadas (webhook)">
          {replay.error && <Alert>{errorText(replay.error)}</Alert>}
          {query.data!.webhooks.length === 0 ? (
            <p className="muted">Nenhuma notificação para esta cobrança.</p>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Evento</th>
                  <th>Status</th>
                  <th>Tentativas</th>
                  <th>Último erro</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {query.data!.webhooks.map((w) => (
                  <tr key={w.id}>
                    <td className="mono">{w.event}</td>
                    <td><StatusBadge status={w.status} /></td>
                    <td>{w.attempts}</td>
                    <td className="small">{w.last_error ?? '—'}</td>
                    <td>
                      <button className="btn btn-ghost btn-sm" onClick={() => replay.mutate(w.id)} disabled={replay.isPending}>
                        Reenviar
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      )}
      <Card title="Dados completos">
        <pre className="json">{JSON.stringify(p, null, 2)}</pre>
      </Card>
    </>
  );
}
