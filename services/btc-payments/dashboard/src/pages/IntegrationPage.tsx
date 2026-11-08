import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, errorText } from '../api';
import { StepUpDialog, type StepUp } from '../components/StepUp';
import { Alert, Card, CopyButton, Empty, Field, PageHeader, Secret, StatusBadge } from '../components/ui';
import { dateTime } from '../format';
import { useMerchantId } from '../session';
import type { Integration, WebhookEvent } from '../types';
import { StoreKeys } from './StoreKeys';

type Credentials = { api_key: string; request_secret: string; webhook_secret: string };

function curlSample(base: string): string {
  return `# Assinatura HMAC-SHA256 de cada requisicao:
# METODO \\n CAMINHO \\n TIMESTAMP \\n NONCE \\n sha256(corpo)
TS=$(date +%s); NONCE=$(openssl rand -hex 16); BODY=''
HASH=$(printf '%s' "$BODY" | sha256sum | cut -d' ' -f1)
SIG=$(printf 'GET\\n/v1/balances\\n%s\\n%s\\n%s' "$TS" "$NONCE" "$HASH" \\
  | openssl dgst -sha256 -hmac "$REQUEST_SECRET" | cut -d' ' -f2)
curl ${base}/v1/balances \\
  -H "authorization: Bearer $API_KEY" \\
  -H "x-timestamp: $TS" -H "x-nonce: $NONCE" -H "x-signature: $SIG"`;
}

const NODE_WEBHOOK = `// Conferir a notificacao (webhook) recebida:
import { createHmac, timingSafeEqual } from 'node:crypto';

function verify(rawBody, header, secret) {
  // header: "t=<unix>,v1=<hex>"
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=')));
  const expected = createHmac('sha256', secret).update(\`\${parts.t}.\${rawBody}\`).digest('hex');
  const ok = timingSafeEqual(Buffer.from(expected), Buffer.from(parts.v1 ?? ''));
  const fresh = Math.abs(Date.now() / 1000 - Number(parts.t)) < 300;
  return ok && fresh;
}`;

export default function IntegrationPage() {
  const merchantId = useMerchantId();
  const client = useQueryClient();
  const base = `/v1/dash/merchants/${merchantId}`;
  const integration = useQuery({ queryKey: ['integration', merchantId], queryFn: () => api<Integration>(`${base}/integration`) });
  const events = useQuery({
    queryKey: ['webhook-events', merchantId],
    queryFn: () => api<{ events: WebhookEvent[] }>(`${base}/webhook/events?limit=30`),
    refetchInterval: 15_000,
  });
  const [askStepUp, setAskStepUp] = useState(false);
  const [creds, setCreds] = useState<Credentials | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const saveUrl = useMutation({
    mutationFn: (value: string) => api<Integration>(`${base}/webhook`, { method: 'PUT', body: { url: value || null } }),
    onSuccess: (data) => {
      client.setQueryData(['integration', merchantId], data);
      setUrl(null);
      setMsg('URL do webhook salva.');
    },
  });
  const test = useMutation({
    mutationFn: () => api(`${base}/webhook/test`, { method: 'POST' }),
    onSuccess: () => {
      setMsg('Evento de teste enviado para a fila. Ele aparece abaixo em instantes.');
      void events.refetch();
    },
  });
  const replay = useMutation({
    mutationFn: (id: string) => api(`${base}/webhook/events/${id}/replay`, { method: 'POST' }),
    onSuccess: () => void events.refetch(),
  });

  async function rotate(stepUp: StepUp) {
    const result = await api<Credentials>(`${base}/credentials`, { method: 'POST', body: { step_up: stepUp } });
    setCreds(result);
    setAskStepUp(false);
    void integration.refetch();
  }

  const data = integration.data;
  const currentUrl = url ?? data?.webhook_url ?? '';

  return (
    <>
      <PageHeader title="Integração e API" subtitle="Conecte sua loja virtual, sistema ou site ao gateway." />
      {msg && <Alert kind="ok">{msg}</Alert>}

      <Card title="Chave de API">
        {data && (
          <div className="stack">
            <div className="kv">
              <span className="muted">Endereço da API</span>
              <span className="secret-row">
                <code>{data.api_base_url}</code>
                <CopyButton value={data.api_base_url} />
              </span>
            </div>
            <div className="kv">
              <span className="muted">Chave atual</span>
              <code>{data.api_key_prefix}…</code>
            </div>
          </div>
        )}
        {creds ? (
          <div className="stack">
            <Alert kind="warn">
              Guarde agora: estes valores <strong>não aparecem de novo</strong>. A chave anterior parou de funcionar.
            </Alert>
            <Secret label="Chave de API (API_KEY)" value={creds.api_key} />
            <Secret label="Segredo de assinatura (REQUEST_SECRET)" value={creds.request_secret} />
            <Secret label="Segredo do webhook (WEBHOOK_SECRET)" value={creds.webhook_secret} />
            <button className="btn btn-ghost" onClick={() => setCreds(null)}>
              Já guardei
            </button>
          </div>
        ) : (
          <div className="stack">
            <p className="muted">
              Gerar uma chave nova invalida a anterior na hora. Use a chave e o segredo no servidor da sua loja, nunca no navegador ou no app.
            </p>
            <div>
              <button className="btn btn-primary" onClick={() => setAskStepUp(true)}>
                Gerar nova chave
              </button>
            </div>
          </div>
        )}
      </Card>

      <Card title="Webhook (notificações de pagamento)">
        {saveUrl.error && <Alert>{errorText(saveUrl.error)}</Alert>}
        {test.error && <Alert>{errorText(test.error)}</Alert>}
        <form
          className="grid-form"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            saveUrl.mutate(currentUrl.trim());
          }}
        >
          <Field label="URL que recebe as notificações (HTTPS)" hint="O motor avisa cada mudança de status com POST assinado (header x-webhook-signature).">
            <input type="url" placeholder="https://sualoja.com/webhooks/pagamentos" value={currentUrl} onChange={(e) => setUrl(e.target.value)} />
          </Field>
          <div className="row-actions">
            <button className="btn btn-primary" disabled={saveUrl.isPending}>
              Salvar
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => test.mutate()} disabled={test.isPending || !data?.webhook_url}>
              Enviar evento de teste
            </button>
          </div>
        </form>
        <h3>Últimas entregas</h3>
        {(events.data?.events.length ?? 0) === 0 ? (
          <Empty>Nenhuma notificação enviada ainda.</Empty>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Quando</th>
                  <th>Evento</th>
                  <th>Status</th>
                  <th>Tentativas</th>
                  <th>Erro</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {events.data!.events.map((ev) => (
                  <tr key={ev.id}>
                    <td>{dateTime(ev.created_at)}</td>
                    <td className="mono">{ev.event}</td>
                    <td><StatusBadge status={ev.status} /></td>
                    <td>{ev.attempts}</td>
                    <td className="small">{ev.last_error ?? '—'}</td>
                    <td>
                      <button className="btn btn-ghost btn-sm" onClick={() => replay.mutate(ev.id)}>
                        Reenviar
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <StoreKeys merchantId={merchantId} apiBase={data?.api_base_url ?? ''} />

      <Card title="Exemplos">
        <h3>Chamada assinada (curl)</h3>
        <pre className="code">{curlSample(data?.api_base_url ?? '')}</pre>
        <h3>Conferir o webhook (Node.js)</h3>
        <pre className="code">{NODE_WEBHOOK}</pre>
      </Card>

      {askStepUp && (
        <StepUpDialog
          title="Gerar nova chave de API"
          description="A chave atual para de funcionar assim que a nova for gerada."
          confirmLabel="Gerar chave"
          onConfirm={rotate}
          onClose={() => setAskStepUp(false)}
        />
      )}
    </>
  );
}
