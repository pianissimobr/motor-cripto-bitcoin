import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api, errorText } from '../api';
import { Alert, Card, Field, PageHeader } from '../components/ui';
import { dateTime } from '../format';
import { useMerchantId, useSession } from '../session';
import type { MerchantView } from '../types';

type SessionRow = { id: string; current: boolean; user_agent: string | null; ip: string | null; created_at: string; last_seen_at: string | null };

function browserName(ua: string | null): string {
  if (!ua) return 'Navegador desconhecido';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Navegador';
  const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Windows/.test(ua) ? 'Windows' : /Mac OS/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${browser} · ${os}` : browser;
}

export default function SettingsPage() {
  const merchantId = useMerchantId();
  const { me, refresh, logout } = useSession();
  const navigate = useNavigate();
  const client = useQueryClient();
  const merchant = useQuery({ queryKey: ['merchant', merchantId], queryFn: () => api<MerchantView>(`/v1/dash/merchants/${merchantId}`) });
  const sessions = useQuery({ queryKey: ['sessions'], queryFn: () => api<{ sessions: SessionRow[] }>('/auth/sessions') });
  const [name, setName] = useState<string | null>(null);
  const [pw, setPw] = useState({ current: '', next: '', confirm: '' });
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const saveName = useMutation({
    mutationFn: (value: string) => api<MerchantView>(`/v1/dash/merchants/${merchantId}`, { method: 'PATCH', body: { name: value } }),
    onSuccess: async (data) => {
      client.setQueryData(['merchant', merchantId], data);
      setName(null);
      setMsg('Nome da loja salvo.');
      await refresh();
    },
  });
  const revokeOthers = useMutation({
    mutationFn: () => api('/auth/sessions/revoke-others', { method: 'POST' }),
    onSuccess: () => void sessions.refetch(),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api(`/auth/sessions/${id}`, { method: 'DELETE' }),
    onSuccess: () => void sessions.refetch(),
  });

  async function changePassword(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (pw.next !== pw.confirm) {
      setError('As senhas novas não conferem.');
      return;
    }
    try {
      await api('/auth/change-password', { method: 'POST', body: { current_password: pw.current, password: pw.next } });
      setPw({ current: '', next: '', confirm: '' });
      setMsg('Senha alterada. As outras sessões foram encerradas.');
      void sessions.refetch();
    } catch (err) {
      setError(errorText(err));
    }
  }

  return (
    <>
      <PageHeader title="Configurações" subtitle={me?.user.email} />
      {msg && <Alert kind="ok">{msg}</Alert>}
      {error && <Alert>{error}</Alert>}
      <Card title="Loja">
        {merchant.data && (
          <form
            className="grid-form"
            onSubmit={(e) => {
              e.preventDefault();
              saveName.mutate((name ?? merchant.data.name).trim());
            }}
          >
            <Field label="Nome da loja" hint="Aparece para o cliente na página de pagamento.">
              <input value={name ?? merchant.data.name} onChange={(e) => setName(e.target.value)} maxLength={80} required />
            </Field>
            <div>
              <button className="btn btn-primary" disabled={saveName.isPending}>
                Salvar
              </button>
            </div>
            <div className="kv">
              <span className="muted">Recebe em</span>
              <span>
                {merchant.data.settlement_asset} · {merchant.data.settlement_chain}
              </span>
            </div>
            <div className="kv">
              <span className="muted">Loja criada em</span>
              <span>{dateTime(merchant.data.created_at)}</span>
            </div>
          </form>
        )}
      </Card>
      <Card title="Trocar a senha">
        <form className="grid-form" onSubmit={changePassword}>
          <Field label="Senha atual">
            <input type="password" autoComplete="current-password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} required />
          </Field>
          <Field label="Nova senha" hint="Mínimo de 8 caracteres.">
            <input type="password" autoComplete="new-password" minLength={8} value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} required />
          </Field>
          <Field label="Repita a nova senha">
            <input type="password" autoComplete="new-password" value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} required />
          </Field>
          <div>
            <button className="btn btn-primary">Trocar senha</button>
          </div>
        </form>
      </Card>
      <Card
        title="Sessões abertas"
        actions={
          <button className="btn btn-ghost btn-sm" onClick={() => revokeOthers.mutate()}>
            Sair de todas as outras
          </button>
        }
      >
        <table className="table">
          <thead>
            <tr>
              <th>Dispositivo</th>
              <th>IP</th>
              <th>Entrou</th>
              <th>Último uso</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(sessions.data?.sessions ?? []).map((s) => (
              <tr key={s.id}>
                <td>
                  {browserName(s.user_agent)} {s.current && <span className="badge badge-ok">Esta sessão</span>}
                </td>
                <td className="mono">{s.ip ?? '—'}</td>
                <td>{dateTime(s.created_at)}</td>
                <td>{dateTime(s.last_seen_at)}</td>
                <td>
                  {s.current ? (
                    <button
                      className="btn btn-ghost btn-sm"
                      onClick={async () => {
                        await logout();
                        navigate('/entrar', { replace: true });
                      }}
                    >
                      Sair
                    </button>
                  ) : (
                    <button className="btn btn-ghost btn-sm" onClick={() => revoke.mutate(s.id)}>
                      Encerrar
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </>
  );
}
