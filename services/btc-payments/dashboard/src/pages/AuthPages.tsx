import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, ApiError, errorText } from '../api';
import { solveAltcha } from '../altcha';
import { Alert, Field } from '../components/ui';
import { useSession } from '../session';

type AuthConfig = { signup_enabled: boolean; altcha: boolean; email_code: boolean };

function useAuthConfig() {
  return useQuery({ queryKey: ['auth-config'], queryFn: () => api<AuthConfig>('/auth/config'), staleTime: Infinity });
}

function AuthFrame({ title, subtitle, children, footer }: { title: string; subtitle?: string; children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="auth">
      <div className="auth-card">
        <div className="brand brand-lg">
          <span className="brand-mark">LF</span> LibreFlow Pay
        </div>
        <h1>{title}</h1>
        {subtitle && <p className="muted">{subtitle}</p>}
        {children}
        {footer && <div className="auth-footer">{footer}</div>}
      </div>
    </div>
  );
}

/** Roda a acao com o anti-robo resolvido antes (quando ligado). */
async function withAltcha<T>(run: (altcha: string | undefined) => Promise<T>): Promise<T> {
  const altcha = await solveAltcha();
  return run(altcha ?? undefined);
}

export function LoginPage() {
  const config = useAuthConfig();
  const { refresh } = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const notice = (location.state as { notice?: string } | null)?.notice;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await withAltcha((altcha) =>
        api('/auth/login', { method: 'POST', body: { email, password, ...(altcha ? { altcha } : {}) } }),
      );
      await refresh();
      navigate('/', { replace: true });
    } catch (err) {
      if (err instanceof ApiError && err.code === 'email_not_verified') {
        navigate('/confirmar', { state: { email, resend: true } });
        return;
      }
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthFrame
      title="Entrar no painel"
      subtitle="Gerencie seus recebimentos em Pix, Bitcoin e dólar digital."
      footer={
        <>
          <Link to="/esqueci">Esqueci a senha</Link>
          {config.data?.signup_enabled !== false && (
            <span>
              Novo por aqui? <Link to="/cadastro">Criar conta</Link>
            </span>
          )}
        </>
      }
    >
      {notice && <Alert kind="ok">{notice}</Alert>}
      {error && <Alert>{error}</Alert>}
      <form onSubmit={submit} className="stack">
        <Field label="E-mail">
          <input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
        </Field>
        <Field label="Senha">
          <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </Field>
        <button className="btn btn-primary btn-block" disabled={busy}>
          {busy ? 'Entrando…' : 'Entrar'}
        </button>
      </form>
    </AuthFrame>
  );
}

export function SignupPage() {
  const config = useAuthConfig();
  const navigate = useNavigate();
  const [form, setForm] = useState({ merchant_name: '', email: '', password: '', confirm: '' });
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (key: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [key]: e.target.value });

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (form.password !== form.confirm) {
      setError('As senhas não conferem.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await withAltcha((altcha) =>
        api<{ request_id: string; verification_token?: string }>('/auth/register', {
          method: 'POST',
          body: {
            email: form.email,
            password: form.password,
            ...(form.merchant_name.trim() ? { merchant_name: form.merchant_name.trim() } : {}),
            ...(altcha ? { altcha } : {}),
          },
        }),
      );
      navigate('/confirmar', {
        state: { email: form.email, requestId: result.request_id, devToken: result.verification_token },
      });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  if (config.data && !config.data.signup_enabled) {
    return (
      <AuthFrame title="Cadastro fechado" footer={<Link to="/entrar">Voltar para o login</Link>}>
        <p>O cadastro de novas contas está fechado no momento.</p>
      </AuthFrame>
    );
  }

  return (
    <AuthFrame
      title="Criar conta"
      subtitle="Receba pagamentos na sua própria carteira de dólar digital."
      footer={
        <span>
          Já tem conta? <Link to="/entrar">Entrar</Link>
        </span>
      }
    >
      {error && <Alert>{error}</Alert>}
      <form onSubmit={submit} className="stack">
        <Field label="Nome da loja">
          <input value={form.merchant_name} onChange={set('merchant_name')} maxLength={80} placeholder="Minha Loja" />
        </Field>
        <Field label="E-mail">
          <input type="email" autoComplete="email" value={form.email} onChange={set('email')} required />
        </Field>
        <Field label="Senha" hint="Mínimo de 8 caracteres.">
          <input type="password" autoComplete="new-password" minLength={8} maxLength={200} value={form.password} onChange={set('password')} required />
        </Field>
        <Field label="Repita a senha">
          <input type="password" autoComplete="new-password" value={form.confirm} onChange={set('confirm')} required />
        </Field>
        <label className="check">
          <input type="checkbox" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} required />
          <span>Entendo que os pagamentos caem direto na carteira que eu cadastrar, e que o painel não faz saques.</span>
        </label>
        <button className="btn btn-primary btn-block" disabled={busy || !accepted}>
          {busy ? 'Criando…' : 'Criar conta'}
        </button>
      </form>
    </AuthFrame>
  );
}

export function VerifyPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const state = (location.state ?? {}) as { email?: string; requestId?: string; devToken?: string; resend?: boolean };
  const [email, setEmail] = useState(state.email ?? '');
  const [requestId, setRequestId] = useState(state.requestId ?? '');
  const [devToken, setDevToken] = useState(state.devToken);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(
    state.resend ? 'Seu e-mail ainda não foi confirmado. Peça um novo código abaixo.' : null,
  );

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/auth/verify-email', {
        method: 'POST',
        body: devToken ? { token: devToken } : { email, request_id: requestId, code },
      });
      navigate('/entrar', { replace: true, state: { notice: 'E-mail confirmado. Agora é só entrar.' } });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function resend() {
    setBusy(true);
    setError(null);
    try {
      const result = await withAltcha((altcha) =>
        api<{ request_id: string; verification_token?: string }>('/auth/resend-verification', {
          method: 'POST',
          body: { email, ...(altcha ? { altcha } : {}) },
        }),
      );
      setRequestId(result.request_id);
      setDevToken(result.verification_token);
      setInfo('Se houver uma conta pendente com esse e-mail, enviamos um novo código.');
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthFrame
      title="Confirme seu e-mail"
      subtitle="Enviamos um código de 6 dígitos para o seu e-mail."
      footer={<Link to="/entrar">Voltar para o login</Link>}
    >
      {info && <Alert kind="info">{info}</Alert>}
      {error && <Alert>{error}</Alert>}
      {devToken && <Alert kind="warn">Ambiente de desenvolvimento: confirmação sem e-mail.</Alert>}
      <form onSubmit={submit} className="stack">
        <Field label="E-mail">
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </Field>
        {!devToken && (
          <Field label="Código">
            <input
              inputMode="numeric"
              pattern="\d{6}"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              required={!devToken}
              autoFocus
            />
          </Field>
        )}
        <button className="btn btn-primary btn-block" disabled={busy || (!devToken && !requestId)}>
          Confirmar
        </button>
        <button type="button" className="btn btn-ghost btn-block" onClick={resend} disabled={busy || !email}>
          Enviar novo código
        </button>
      </form>
    </AuthFrame>
  );
}

export function ForgotPage() {
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [requestId, setRequestId] = useState<string | null>(null);
  const [devToken, setDevToken] = useState<string | undefined>();
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function request(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await withAltcha((altcha) =>
        api<{ request_id: string; reset_token?: string }>('/auth/forgot-password', {
          method: 'POST',
          body: { email, ...(altcha ? { altcha } : {}) },
        }),
      );
      setRequestId(result.request_id);
      setDevToken(result.reset_token);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function reset(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/auth/reset-password', {
        method: 'POST',
        body: devToken ? { token: devToken, password } : { email, request_id: requestId, code, password },
      });
      navigate('/entrar', { replace: true, state: { notice: 'Senha redefinida. Entre com a nova senha.' } });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthFrame title="Redefinir a senha" footer={<Link to="/entrar">Voltar para o login</Link>}>
      {error && <Alert>{error}</Alert>}
      {!requestId ? (
        <form onSubmit={request} className="stack">
          <p className="muted">Informe o e-mail da conta. Se ele estiver cadastrado, enviamos um código.</p>
          <Field label="E-mail">
            <input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
          </Field>
          <button className="btn btn-primary btn-block" disabled={busy}>
            {busy ? 'Enviando…' : 'Enviar código'}
          </button>
        </form>
      ) : (
        <form onSubmit={reset} className="stack">
          <Alert kind="info">Se houver uma conta com esse e-mail, o código chega em instantes.</Alert>
          {!devToken && (
            <Field label="Código">
              <input inputMode="numeric" pattern="\d{6}" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} required autoFocus />
            </Field>
          )}
          <Field label="Nova senha" hint="Mínimo de 8 caracteres. Todas as sessões abertas serão encerradas.">
            <input type="password" autoComplete="new-password" minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} required />
          </Field>
          <button className="btn btn-primary btn-block" disabled={busy}>
            Redefinir senha
          </button>
        </form>
      )}
    </AuthFrame>
  );
}
