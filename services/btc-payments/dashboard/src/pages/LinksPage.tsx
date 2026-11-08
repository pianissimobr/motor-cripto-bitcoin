import { useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, errorText } from '../api';
import { Alert, Card, CopyButton, Field, PageHeader, StatusBadge } from '../components/ui';
import { dateTime, money } from '../format';
import { useMerchantId } from '../session';
import type { PaymentPage, Wallet } from '../types';

type Created = {
  id: string;
  external_id: string;
  amount_cents: string;
  currency: string;
  pay_url: string | null;
  options: {
    pix: { qr_copypaste: string | null; qr_svg: string | null } | null;
    bitcoin: { address: string | null; bip21: string | null; qr_svg: string | null; amount_btc: string } | null;
    pix_direto: { br_code: string } | null;
  };
};

function svgSrc(svg: string): string {
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

export default function LinksPage() {
  const merchantId = useMerchantId();
  const wallets = useQuery({
    queryKey: ['wallets', merchantId],
    queryFn: () => api<{ wallets: Wallet[] }>(`/v1/dash/merchants/${merchantId}/wallets`),
  });
  const recent = useQuery({
    queryKey: ['payments', merchantId, 'request', 'recent'],
    queryFn: () => api<PaymentPage>(`/v1/dash/merchants/${merchantId}/payments?kind=request&limit=10`),
  });
  const [form, setForm] = useState({ amount: '', currency: 'BRL', description: '', external_id: '', wallet_id: '', payer_tax_number: '' });
  const [rails, setRails] = useState({ bitcoin: true, pix: false, pix_direto: false });
  const [created, setCreated] = useState<Created | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (key: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [key]: e.target.value });

  async function submit(event: FormEvent) {
    event.preventDefault();
    const chosen = (Object.keys(rails) as (keyof typeof rails)[]).filter((k) => rails[k]);
    if (chosen.length === 0) {
      setError('Escolha ao menos um meio de pagamento.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await api<Created>(`/v1/dash/merchants/${merchantId}/payment-links`, {
        method: 'POST',
        body: {
          amount: form.amount.trim(),
          currency: form.currency,
          rails: chosen,
          ...(form.description.trim() ? { description: form.description.trim() } : {}),
          ...(form.external_id.trim() ? { external_id: form.external_id.trim() } : {}),
          ...(form.wallet_id ? { wallet_id: form.wallet_id } : {}),
          ...(rails.pix && form.payer_tax_number.trim() ? { payer_tax_number: form.payer_tax_number.trim() } : {}),
        },
      });
      setCreated(result);
      void recent.refetch();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  const noWallet = wallets.data && wallets.data.wallets.length === 0;

  return (
    <>
      <PageHeader title="Links de pagamento" subtitle="Crie uma cobrança e mande o QR ou o link para o seu cliente." />
      {noWallet && (
        <Alert kind="warn">
          Cadastre uma carteira antes de cobrar. <Link to="/carteiras">Cadastrar carteira</Link>
        </Alert>
      )}
      <div className="two-col">
        <Card title="Nova cobrança">
          {error && <Alert>{error}</Alert>}
          <form onSubmit={submit} className="stack">
            <div className="grid-2">
              <Field label="Valor">
                <input inputMode="decimal" placeholder="99,90" value={form.amount} onChange={set('amount')} required />
              </Field>
              <Field label="Moeda">
                <select value={form.currency} onChange={set('currency')}>
                  <option value="BRL">Real (R$)</option>
                  <option value="USD">Dólar (US$)</option>
                </select>
              </Field>
            </div>
            <Field label="Descrição (opcional)">
              <input value={form.description} onChange={set('description')} maxLength={200} />
            </Field>
            <Field label="Código do pedido (opcional)" hint="Se repetir um código, o painel devolve a mesma cobrança.">
              <input value={form.external_id} onChange={set('external_id')} maxLength={64} />
            </Field>
            <fieldset className="rails">
              <legend className="field-label">Meios de pagamento</legend>
              <label className="check">
                <input type="checkbox" checked={rails.bitcoin} onChange={(e) => setRails({ ...rails, bitcoin: e.target.checked })} />
                <span>Bitcoin (convertido em dólar digital)</span>
              </label>
              <label className="check">
                <input type="checkbox" checked={rails.pix} onChange={(e) => setRails({ ...rails, pix: e.target.checked })} />
                <span>Pix (convertido em dólar digital)</span>
              </label>
              <label className="check">
                <input type="checkbox" checked={rails.pix_direto} onChange={(e) => setRails({ ...rails, pix_direto: e.target.checked })} />
                <span>Pix direto na sua chave (sem confirmação automática)</span>
              </label>
            </fieldset>
            {rails.pix && (
              <Field label="CPF/CNPJ de quem vai pagar" hint="Exigido pelo Pix convertido. Na página de pagamento hospedada isso será pedido ao cliente.">
                <input value={form.payer_tax_number} onChange={set('payer_tax_number')} required />
              </Field>
            )}
            {wallets.data && wallets.data.wallets.length > 1 && (
              <Field label="Carteira que recebe">
                <select value={form.wallet_id} onChange={set('wallet_id')}>
                  <option value="">Carteira padrão</option>
                  {wallets.data.wallets.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.label ?? w.address}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            <button className="btn btn-primary" disabled={busy || noWallet}>
              {busy ? 'Gerando…' : 'Gerar cobrança'}
            </button>
          </form>
        </Card>
        <Card title="Cobrança gerada">
          {!created && <p className="muted">A cobrança aparece aqui, pronta para enviar.</p>}
          {created && (
            <div className="stack">
              <div className="kv">
                <span className="muted">Valor</span>
                <strong>{money(created.amount_cents, created.currency)}</strong>
              </div>
              {created.pay_url && (
                <div className="secret-row">
                  <code>{created.pay_url}</code>
                  <CopyButton value={created.pay_url} />
                </div>
              )}
              {created.options.pix?.qr_copypaste && (
                <div>
                  <h3>Pix</h3>
                  {created.options.pix.qr_svg && <img className="qr" alt="QR Pix" src={svgSrc(created.options.pix.qr_svg)} />}
                  <div className="secret-row">
                    <code>{created.options.pix.qr_copypaste}</code>
                    <CopyButton value={created.options.pix.qr_copypaste} label="Copiar Pix" />
                  </div>
                </div>
              )}
              {created.options.bitcoin?.bip21 && (
                <div>
                  <h3>Bitcoin · {created.options.bitcoin.amount_btc} BTC</h3>
                  {created.options.bitcoin.qr_svg && <img className="qr" alt="QR Bitcoin" src={svgSrc(created.options.bitcoin.qr_svg)} />}
                  <div className="secret-row">
                    <code>{created.options.bitcoin.address}</code>
                    <CopyButton value={created.options.bitcoin.bip21} label="Copiar" />
                  </div>
                </div>
              )}
              {created.options.pix_direto && (
                <div>
                  <h3>Pix direto</h3>
                  <div className="secret-row">
                    <code>{created.options.pix_direto.br_code}</code>
                    <CopyButton value={created.options.pix_direto.br_code} label="Copiar Pix" />
                  </div>
                  <p className="muted small">O Pix direto não tem confirmação automática: confira no extrato do banco.</p>
                </div>
              )}
            </div>
          )}
        </Card>
      </div>
      <Card title="Últimas cobranças" actions={<Link to="/pagamentos?tipo=request">Ver todas</Link>}>
        <table className="table">
          <thead>
            <tr>
              <th>Criada</th>
              <th>Pedido</th>
              <th>Status</th>
              <th className="num">Valor</th>
            </tr>
          </thead>
          <tbody>
            {(recent.data?.items ?? []).map((item) => (
              <tr key={item.id}>
                <td>{dateTime(item.created_at)}</td>
                <td className="mono">
                  <Link to={`/pagamentos/request/${item.id}`}>{item.external_id}</Link>
                </td>
                <td><StatusBadge status={item.status} /></td>
                <td className="num">{money(item.amount_cents, item.currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </>
  );
}
