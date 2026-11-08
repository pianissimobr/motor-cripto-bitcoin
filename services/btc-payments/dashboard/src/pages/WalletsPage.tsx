import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, errorText } from '../api';
import { StepUpDialog, type StepUp } from '../components/StepUp';
import { Alert, Card, CopyButton, Empty, Field, PageHeader, Spinner } from '../components/ui';
import { dateTime, usdc } from '../format';
import { useMerchantId } from '../session';
import type { Wallet } from '../types';

type Pending =
  | { kind: 'add'; address: string; label: string }
  | { kind: 'default'; wallet: Wallet }
  | { kind: 'remove'; wallet: Wallet };

function Balance({ merchantId, walletId }: { merchantId: string; walletId: string }) {
  const query = useQuery({
    queryKey: ['balance', walletId],
    queryFn: () => api<{ balance_minor: string }>(`/v1/dash/merchants/${merchantId}/wallets/${walletId}/balance`),
    staleTime: 60_000,
    retry: false,
  });
  if (query.isLoading) return <span className="muted small">consultando…</span>;
  if (query.error) return <span className="muted small">indisponível</span>;
  return <strong>{usdc(query.data!.balance_minor)}</strong>;
}

export default function WalletsPage() {
  const merchantId = useMerchantId();
  const client = useQueryClient();
  const base = `/v1/dash/merchants/${merchantId}/wallets`;
  const query = useQuery({ queryKey: ['wallets', merchantId], queryFn: () => api<{ wallets: Wallet[] }>(base) });
  const [address, setAddress] = useState('');
  const [label, setLabel] = useState('');
  const [pending, setPending] = useState<Pending | null>(null);
  const [editing, setEditing] = useState<{ id: string; label: string } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = () => client.invalidateQueries({ queryKey: ['wallets', merchantId] });

  async function confirm(stepUp: StepUp) {
    if (!pending) return;
    if (pending.kind === 'add') {
      await api(base, { method: 'POST', body: { address: pending.address, label: pending.label || undefined, step_up: stepUp } });
      setAddress('');
      setLabel('');
      setMessage('Carteira cadastrada. Enviamos um aviso para o seu e-mail.');
    } else if (pending.kind === 'default') {
      await api(`${base}/${pending.wallet.id}/default`, { method: 'POST', body: { step_up: stepUp } });
      setMessage('Carteira padrão alterada. Os próximos pagamentos caem nela.');
    } else {
      await api(`${base}/${pending.wallet.id}/remove`, { method: 'POST', body: { step_up: stepUp } });
      setMessage('Carteira removida.');
    }
    setPending(null);
    await refresh();
  }

  async function rename(wallet: Wallet, next: string) {
    try {
      await api(`${base}/${wallet.id}`, { method: 'PATCH', body: { label: next.trim() || null } });
      setEditing(null);
      await refresh();
    } catch (err) {
      setError(errorText(err));
    }
  }

  function startAdd(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setMessage(null);
    if (!/^0x[0-9a-fA-F]{40}$/.test(address.trim())) {
      setError('Endereço inválido: deve começar com 0x e ter 42 caracteres.');
      return;
    }
    setPending({ kind: 'add', address: address.trim(), label: label.trim() });
  }

  const wallets = query.data?.wallets ?? [];

  return (
    <>
      <PageHeader
        title="Carteiras de recebimento"
        subtitle="Qualquer carteira de dólar digital (USDC na rede Polygon): MetaMask, Trust Wallet, exchange… O dinheiro cai direto nela."
      />
      {message && <Alert kind="ok">{message}</Alert>}
      {error && <Alert>{error}</Alert>}
      <Card title="Suas carteiras">
        {query.isLoading && <Spinner />}
        {!query.isLoading && wallets.length === 0 && <Empty>Nenhuma carteira cadastrada. Cadastre a primeira abaixo.</Empty>}
        <div className="wallets">
          {wallets.map((wallet) => (
            <div key={wallet.id} className={`wallet ${wallet.is_default ? 'wallet-default' : ''}`}>
              <div className="wallet-head">
                {editing?.id === wallet.id ? (
                  <form
                    className="inline-form"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void rename(wallet, editing.label);
                    }}
                  >
                    <input value={editing.label} maxLength={60} onChange={(e) => setEditing({ id: wallet.id, label: e.target.value })} autoFocus />
                    <button className="btn btn-primary btn-sm">Salvar</button>
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing(null)}>
                      Cancelar
                    </button>
                  </form>
                ) : (
                  <strong>{wallet.label ?? 'Carteira sem apelido'}</strong>
                )}
                {wallet.is_default && <span className="badge badge-ok">Padrão</span>}
                <span className="badge badge-muted">USDC · {wallet.chain}</span>
              </div>
              <div className="secret-row">
                <code>{wallet.address}</code>
                <CopyButton value={wallet.address} />
              </div>
              <div className="wallet-foot">
                <span>
                  Saldo: <Balance merchantId={merchantId} walletId={wallet.id} />
                </span>
                <span className="muted small">Cadastrada em {dateTime(wallet.created_at)}</span>
              </div>
              <div className="row-actions">
                {!wallet.is_default && (
                  <button className="btn btn-ghost btn-sm" onClick={() => setPending({ kind: 'default', wallet })}>
                    Tornar padrão
                  </button>
                )}
                <button className="btn btn-ghost btn-sm" onClick={() => setEditing({ id: wallet.id, label: wallet.label ?? '' })}>
                  Renomear
                </button>
                <button className="btn btn-danger btn-sm" onClick={() => setPending({ kind: 'remove', wallet })}>
                  Remover
                </button>
              </div>
            </div>
          ))}
        </div>
      </Card>
      <Card title="Cadastrar carteira">
        <form onSubmit={startAdd} className="grid-form">
          <Field label="Endereço (0x…)" hint="Confira o endereço com cuidado: pagamentos enviados para um endereço errado não voltam.">
            <input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="0x…" spellCheck={false} required />
          </Field>
          <Field label="Apelido (opcional)">
            <input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={60} placeholder="MetaMask da loja" />
          </Field>
          <div>
            <button className="btn btn-primary">Cadastrar</button>
          </div>
        </form>
        <p className="muted small">
          Use uma carteira que aceite USDC na rede Polygon. Se for endereço de exchange, confirme na exchange que ela aceita depósito de USDC pela Polygon.
          Outras redes e USDT: em breve.
        </p>
      </Card>
      {pending && (
        <StepUpDialog
          title={pending.kind === 'add' ? 'Confirmar nova carteira' : pending.kind === 'default' ? 'Trocar carteira padrão' : 'Remover carteira'}
          description={
            pending.kind === 'add'
              ? `Os pagamentos poderão cair em ${pending.address}. Confirme com sua senha.`
              : pending.kind === 'default'
                ? `Os próximos pagamentos vão cair em ${pending.wallet.address}.`
                : `A carteira ${pending.wallet.address} deixa de receber pagamentos.`
          }
          confirmLabel="Confirmar"
          onConfirm={confirm}
          onClose={() => setPending(null)}
        />
      )}
    </>
  );
}
