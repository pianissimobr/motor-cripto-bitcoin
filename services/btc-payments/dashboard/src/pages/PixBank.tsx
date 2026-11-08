import { useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, errorText } from '../api';
import { StepUpDialog, type StepUp } from '../components/StepUp';
import { Alert, Card, Field } from '../components/ui';
import { dateTime } from '../format';

type BankView =
  | { configured: false }
  | {
      configured: true;
      psp: 'efi' | 'inter' | 'outro';
      environment: 'producao' | 'homologacao';
      base_url: string | null;
      token_url: string | null;
      client_id: string;
      pix_key: string;
      enabled: boolean;
      last_check_at: string | null;
      last_check_error: string | null;
    };

const PSP_LABEL = { efi: 'Efí (Gerencianet)', inter: 'Banco Inter', outro: 'Outro banco (API Pix padrão)' } as const;

function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = () => reject(new Error('não foi possível ler o certificado'));
    reader.readAsDataURL(file);
  });
}

/**
 * Pix direto confirmado: a loja liga a API Pix do banco dela (conta PJ). O
 * Pix da fatura cai em reais na conta e a confirmacao e automatica.
 */
export function PixBank({ merchantId }: { merchantId: string }) {
  const url = `/v1/dash/merchants/${merchantId}/pix-bank`;
  const query = useQuery({ queryKey: ['pix-bank', merchantId], queryFn: () => api<BankView>(url) });
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ psp: 'efi', environment: 'producao', base_url: '', token_url: '', client_id: '', client_secret: '', passphrase: '', pix_key: '' });
  const [cert, setCert] = useState<File | null>(null);
  const [pending, setPending] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  const data = query.data;

  function startEdit() {
    if (data?.configured) {
      setForm({
        psp: data.psp,
        environment: data.environment,
        base_url: data.base_url ?? '',
        token_url: data.token_url ?? '',
        client_id: data.client_id,
        client_secret: '',
        passphrase: '',
        pix_key: data.pix_key,
      });
    }
    setEditing(true);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const body: Record<string, unknown> = {
        psp: form.psp,
        environment: form.environment,
        client_id: form.client_id,
        pix_key: form.pix_key,
        ...(form.psp === 'outro' ? { base_url: form.base_url, token_url: form.token_url } : {}),
        ...(form.client_secret ? { client_secret: form.client_secret } : {}),
        ...(form.passphrase ? { certificate_passphrase: form.passphrase } : {}),
        ...(cert ? { certificate_p12_base64: await readBase64(cert) } : {}),
      };
      setPending(body);
    } catch (err) {
      setError(errorText(err));
    }
  }

  async function confirm(stepUp: StepUp) {
    const saved = await api<BankView>(url, { method: 'PUT', body: { ...pending, step_up: stepUp } });
    setPending(null);
    setEditing(false);
    setCert(null);
    void query.refetch();
    setMsg(saved.configured && saved.enabled ? 'Banco conectado. As faturas passam a oferecer Pix na sua conta.' : null);
  }

  async function remove() {
    try {
      await api(url, { method: 'DELETE' });
      void query.refetch();
    } catch (err) {
      setError(errorText(err));
    }
  }

  return (
    <Card title="Receber Pix na conta da loja (em reais)">
      <p className="muted">
        Conecte a API Pix da conta PJ da loja. O cliente paga com Pix, o dinheiro cai em reais na sua conta e o pagamento é confirmado sozinho, sem
        conversão para dólar. Sem o banco conectado, o Pix das faturas é convertido em dólar digital.
      </p>
      {msg && <Alert kind="ok">{msg}</Alert>}
      {error && <Alert>{error}</Alert>}
      {data?.configured && !editing && (
        <div className="stack">
          <div className="kv">
            <span className="muted">Banco</span>
            <span>
              {PSP_LABEL[data.psp]} · {data.environment === 'producao' ? 'produção' : 'homologação'}
            </span>
          </div>
          <div className="kv">
            <span className="muted">Chave Pix</span>
            <span>{data.pix_key}</span>
          </div>
          <div className="kv">
            <span className="muted">Situação</span>
            <span>
              {data.enabled ? <span className="badge badge-ok">Conectado</span> : <span className="badge badge-bad">Com erro</span>}{' '}
              <span className="muted small">testado em {dateTime(data.last_check_at)}</span>
            </span>
          </div>
          {data.last_check_error && <Alert>{data.last_check_error}</Alert>}
          <div className="row-actions">
            <button className="btn btn-ghost" onClick={startEdit}>
              Alterar
            </button>
            <button className="btn btn-danger" onClick={() => void remove()}>
              Desconectar
            </button>
          </div>
        </div>
      )}
      {!data?.configured && !editing && (
        <button className="btn btn-primary" onClick={startEdit}>
          Conectar banco
        </button>
      )}
      {editing && (
        <form className="grid-form" onSubmit={submit}>
          <div className="grid-2">
            <Field label="Banco">
              <select value={form.psp} onChange={set('psp')}>
                {Object.entries(PSP_LABEL).map(([id, label]) => (
                  <option key={id} value={id}>
                    {label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Ambiente">
              <select value={form.environment} onChange={set('environment')}>
                <option value="producao">Produção</option>
                <option value="homologacao">Homologação (teste do banco)</option>
              </select>
            </Field>
          </div>
          {form.psp === 'outro' && (
            <>
              <Field label="Endereço da API Pix" hint="O endereço antes de /v2/cob, sempre https.">
                <input value={form.base_url} onChange={set('base_url')} placeholder="https://api.seubanco.com.br/pix" required />
              </Field>
              <Field label="Endereço do token (OAuth)">
                <input value={form.token_url} onChange={set('token_url')} placeholder="https://api.seubanco.com.br/oauth/token" required />
              </Field>
            </>
          )}
          <Field label="Client ID" hint="Criado no internet banking, na área de API / integrações.">
            <input value={form.client_id} onChange={set('client_id')} required />
          </Field>
          <Field label="Client Secret" hint={data?.configured ? 'Deixe em branco para manter o atual.' : undefined}>
            <input type="password" value={form.client_secret} onChange={set('client_secret')} required={!data?.configured} autoComplete="off" />
          </Field>
          <Field label="Certificado (.p12)" hint={data?.configured ? 'Envie só se for trocar.' : 'Emitido pelo banco junto com as credenciais.'}>
            <input type="file" accept=".p12,.pfx" onChange={(e) => setCert(e.target.files?.[0] ?? null)} required={!data?.configured} />
          </Field>
          <Field label="Senha do certificado (se houver)">
            <input type="password" value={form.passphrase} onChange={set('passphrase')} autoComplete="off" />
          </Field>
          <Field label="Chave Pix da conta" hint="A chave cadastrada nesta conta (CNPJ, e-mail, telefone ou aleatória).">
            <input value={form.pix_key} onChange={set('pix_key')} required />
          </Field>
          <div className="row-actions">
            <button className="btn btn-primary">Salvar e testar</button>
            <button type="button" className="btn btn-ghost" onClick={() => setEditing(false)}>
              Cancelar
            </button>
          </div>
        </form>
      )}
      {pending && (
        <StepUpDialog
          title="Conectar conta bancária"
          description="Credenciais do banco ficam cifradas. Confirme com sua senha."
          confirmLabel="Salvar"
          onConfirm={confirm}
          onClose={() => setPending(null)}
        />
      )}
    </Card>
  );
}
