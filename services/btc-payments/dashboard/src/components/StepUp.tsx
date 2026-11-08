import { useState, type FormEvent } from 'react';
import { api, errorText } from '../api';
import { solveAltcha } from '../altcha';
import { Alert, Field } from './ui';

export type StepUp = { password: string; request_id?: string; code?: string };

/**
 * Confirmacao de operacao sensivel: senha e, com o authO, o codigo de 6
 * digitos enviado por e-mail. Chama `onConfirm` com o `step_up` pronto.
 */
export function StepUpDialog({
  title,
  description,
  confirmLabel,
  onConfirm,
  onClose,
}: {
  title: string;
  description: string;
  confirmLabel: string;
  onConfirm: (stepUp: StepUp) => Promise<void>;
  onClose: () => void;
}) {
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [requestId, setRequestId] = useState<string | null>(null);
  const [needsCode, setNeedsCode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (!requestId) {
        const altcha = await solveAltcha();
        const started = await api<{ request_id: string; email_code: boolean }>('/v1/dash/step-up', {
          method: 'POST',
          body: { password, ...(altcha ? { altcha } : {}) },
        });
        setRequestId(started.request_id);
        if (started.email_code) {
          setNeedsCode(true);
          return;
        }
        await onConfirm({ password });
        return;
      }
      await onConfirm({ password, request_id: requestId, code });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label={title}>
      <form className="modal" onSubmit={submit}>
        <h2>{title}</h2>
        <p className="muted">{description}</p>
        {error && <Alert>{error}</Alert>}
        <Field label="Sua senha">
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={needsCode}
            required
            autoFocus
          />
        </Field>
        {needsCode && (
          <Field label="Código enviado para o seu e-mail" hint="Vale por alguns minutos.">
            <input
              inputMode="numeric"
              pattern="\d{6}"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              required
              autoFocus
            />
          </Field>
        )}
        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Cancelar
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? 'Aguarde…' : needsCode ? confirmLabel : 'Continuar'}
          </button>
        </div>
      </form>
    </div>
  );
}
