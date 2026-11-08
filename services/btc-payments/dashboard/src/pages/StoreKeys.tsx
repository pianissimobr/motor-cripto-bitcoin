import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, errorText } from '../api';
import { StepUpDialog, type StepUp } from '../components/StepUp';
import { Alert, Card, Empty, Secret } from '../components/ui';
import { dateTime } from '../format';

type StoreKey = { id: string; mode: 'live' | 'test'; label: string | null; key_prefix: string; created_at: string; last_used_at: string | null };
type Created = { key: StoreKey; api_key: string; ipn_secret: string };

const PLATFORMS = [
  {
    id: 'woocommerce',
    name: 'WooCommerce / WordPress',
    steps: [
      'Baixe o plugin abaixo e instale em Plugins → Adicionar novo → Enviar plugin.',
      'Em WooCommerce → Configurações → Pagamentos, ative "LibreFlow Pay".',
      'Cole a chave de loja e o segredo IPN e clique em "Testar conexão".',
      'Use a chave de teste para homologar; troque pela de produção para vender.',
    ],
    download: '/downloads/libreflow-woocommerce.zip',
  },
  {
    id: 'shopify',
    name: 'Shopify',
    steps: [
      'Integração em preparação: o cliente recebe o link de pagamento depois do pedido e a loja é avisada quando ele paga.',
      'Enquanto isso, use os links de pagamento ou a API.',
    ],
    download: null,
  },
  {
    id: 'api',
    name: 'Site ou sistema próprio',
    steps: [
      'Crie a fatura com POST /v1/invoices (header x-api-key).',
      'Mande o cliente para invoice_url.',
      'Receba o IPN em ipn_callback_url e confira a assinatura com o segredo IPN.',
    ],
    download: null,
  },
];

function invoiceSample(base: string): string {
  return `curl -X POST ${base}/v1/invoices \\
  -H "x-api-key: $STORE_KEY" -H "content-type: application/json" \\
  -d '{
    "price_amount": "99.90",
    "price_currency": "BRL",
    "order_id": "1234",
    "order_description": "Pedido #1234",
    "success_url": "https://sualoja.com/obrigado",
    "cancel_url": "https://sualoja.com/carrinho",
    "ipn_callback_url": "https://sualoja.com/ipn"
  }'
# -> { "id": "...", "invoice_url": "${base}/i/...", "status": "aguardando" }`;
}

export function StoreKeys({ merchantId, apiBase }: { merchantId: string; apiBase: string }) {
  const base = `/v1/dash/merchants/${merchantId}/store-keys`;
  const keys = useQuery({ queryKey: ['store-keys', merchantId], queryFn: () => api<{ keys: StoreKey[] }>(base) });
  const [created, setCreated] = useState<Created | null>(null);
  const [askLive, setAskLive] = useState(false);
  const [platform, setPlatform] = useState('woocommerce');
  const [error, setError] = useState<string | null>(null);

  async function create(mode: 'live' | 'test', stepUp?: StepUp) {
    setError(null);
    try {
      const result = await api<Created>(base, { method: 'POST', body: { mode, ...(stepUp ? { step_up: stepUp } : {}) } });
      setCreated(result);
      setAskLive(false);
      void keys.refetch();
    } catch (err) {
      if (stepUp) throw err;
      setError(errorText(err));
    }
  }

  async function revoke(id: string) {
    try {
      await api(`${base}/${id}/revoke`, { method: 'POST' });
      void keys.refetch();
    } catch (err) {
      setError(errorText(err));
    }
  }

  const chosen = PLATFORMS.find((p) => p.id === platform)!;

  return (
    <>
      <Card title="Conectar loja virtual (plug and play)">
        <p className="muted">
          Escolha a plataforma. A loja cria a fatura, o cliente paga na página hospedada e a loja recebe o aviso (IPN) quando o pagamento é confirmado.
        </p>
        <div className="tabs">
          {PLATFORMS.map((p) => (
            <button key={p.id} className={p.id === platform ? 'active' : ''} onClick={() => setPlatform(p.id)}>
              {p.name}
            </button>
          ))}
        </div>
        <ol className="steps">
          {chosen.steps.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
        {chosen.download && (
          <a className="btn btn-primary" href={chosen.download} download>
            Baixar plugin
          </a>
        )}
        {chosen.id === 'api' && <pre className="code">{invoiceSample(apiBase)}</pre>}
      </Card>

      <Card
        title="Chaves de loja"
        actions={
          <div className="row-actions">
            <button className="btn btn-ghost btn-sm" onClick={() => void create('test')}>
              Gerar chave de teste
            </button>
            <button className="btn btn-primary btn-sm" onClick={() => setAskLive(true)}>
              Gerar chave de produção
            </button>
          </div>
        }
      >
        {error && <Alert>{error}</Alert>}
        {created && (
          <div className="stack">
            <Alert kind="warn">
              Guarde agora: a chave e o segredo IPN <strong>não aparecem de novo</strong>.
            </Alert>
            <Secret label={`Chave de loja (${created.key.mode === 'test' ? 'teste' : 'produção'})`} value={created.api_key} />
            <Secret label="Segredo IPN (confere a assinatura do aviso)" value={created.ipn_secret} />
            <div>
              <button className="btn btn-ghost" onClick={() => setCreated(null)}>
                Já guardei
              </button>
            </div>
          </div>
        )}
        <p className="muted small">
          A chave de loja só cria e consulta faturas: mesmo vazada, não muda carteira nem desvia dinheiro. A de teste nunca cobra de verdade e mostra o botão
          “Simular pagamento”.
        </p>
        {(keys.data?.keys.length ?? 0) === 0 ? (
          <Empty>Nenhuma chave de loja ainda. Comece pela de teste.</Empty>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Modo</th>
                  <th>Chave</th>
                  <th>Criada</th>
                  <th>Último uso</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {keys.data!.keys.map((k) => (
                  <tr key={k.id}>
                    <td>
                      <span className={`badge ${k.mode === 'live' ? 'badge-ok' : 'badge-wait'}`}>{k.mode === 'live' ? 'Produção' : 'Teste'}</span>
                    </td>
                    <td className="mono">{k.key_prefix}…</td>
                    <td>{dateTime(k.created_at)}</td>
                    <td>{k.last_used_at ? dateTime(k.last_used_at) : 'nunca'}</td>
                    <td>
                      <button className="btn btn-danger btn-sm" onClick={() => void revoke(k.id)}>
                        Revogar
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {askLive && (
        <StepUpDialog
          title="Gerar chave de produção"
          description="Esta chave cria cobranças reais. Confirme com sua senha."
          confirmLabel="Gerar chave"
          onConfirm={(stepUp) => create('live', stepUp)}
          onClose={() => setAskLive(false)}
        />
      )}
    </>
  );
}
