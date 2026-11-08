import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, errorText } from '../api';
import { Alert, Card, Field } from '../components/ui';
import { dateTime } from '../format';

type Status =
  | { available: boolean; connected: false }
  | {
      available: boolean;
      connected: true;
      connected_at: string;
      portador_id: string | null;
      categoria_id: string | null;
      last_error: string | null;
      pending_with_error: number;
    };
type Options = { portadores: { id: string; descricao: string }[]; categorias: { id: string; descricao: string }[] };

/** Contabilidade: cada venda paga vira conta a receber no Bling da loja. */
export function BlingCard({ merchantId }: { merchantId: string }) {
  const base = `/v1/dash/merchants/${merchantId}/bling`;
  const status = useQuery({ queryKey: ['bling', merchantId], queryFn: () => api<Status>(base) });
  const connected = status.data?.connected === true;
  const options = useQuery({ queryKey: ['bling-options', merchantId], queryFn: () => api<Options>(`${base}/options`), enabled: connected, retry: false });
  const [choice, setChoice] = useState<{ portador: string; categoria: string } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const result = new URLSearchParams(window.location.search).get('bling');

  if (status.data && !status.data.available) return null;
  const data = status.data;
  const current = choice ?? { portador: (data?.connected && data.portador_id) || '', categoria: (data?.connected && data.categoria_id) || '' };

  async function run(action: () => Promise<unknown>, ok?: string) {
    setError(null);
    setMsg(null);
    try {
      await action();
      if (ok) setMsg(ok);
      void status.refetch();
    } catch (err) {
      setError(errorText(err));
    }
  }

  return (
    <Card title="Contabilidade (Bling)">
      <p className="muted">
        Cada venda paga vira uma conta a receber no seu Bling (contato "Consumidor Final", com o número do pedido). Escolhendo a conta e a categoria,
        ela já entra como recebida. Vendas anteriores à conexão: use o "Exportar CSV" em Pagamentos.
      </p>
      {result === 'ok' && <Alert kind="ok">Bling conectado.</Alert>}
      {result === 'erro' && <Alert>Não foi possível conectar o Bling. Tente de novo.</Alert>}
      {msg && <Alert kind="ok">{msg}</Alert>}
      {error && <Alert>{error}</Alert>}
      {!connected && (
        <button
          className="btn btn-primary"
          onClick={() =>
            void run(async () => {
              const { authorize_url } = await api<{ authorize_url: string }>(`${base}/connect`, { method: 'POST' });
              window.location.assign(authorize_url);
            })
          }
        >
          Conectar Bling
        </button>
      )}
      {data?.connected && (
        <div className="stack">
          <div className="kv">
            <span className="muted">Conectado em</span>
            <span>{dateTime(data.connected_at)}</span>
          </div>
          {data.last_error && <Alert>Último erro no Bling: {data.last_error}</Alert>}
          {options.error && <Alert>{errorText(options.error)}</Alert>}
          <div className="grid-2">
            <Field label="Conta financeira (para dar baixa)">
              <select value={current.portador} onChange={(e) => setChoice({ ...current, portador: e.target.value })}>
                <option value="">Não dar baixa</option>
                {(options.data?.portadores ?? []).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.descricao}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Categoria de receita">
              <select value={current.categoria} onChange={(e) => setChoice({ ...current, categoria: e.target.value })}>
                <option value="">Sem categoria</option>
                {(options.data?.categorias ?? []).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.descricao}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <div className="row-actions">
            <button
              className="btn btn-primary"
              onClick={() =>
                void run(
                  () => api(`${base}/settings`, { method: 'PUT', body: { portador_id: current.portador || null, categoria_id: current.categoria || null } }),
                  'Preferências do Bling salvas.',
                )
              }
            >
              Salvar
            </button>
            <button className="btn btn-danger" onClick={() => void run(() => api(base, { method: 'DELETE' }), 'Bling desconectado.')}>
              Desconectar
            </button>
          </div>
        </div>
      )}
    </Card>
  );
}
