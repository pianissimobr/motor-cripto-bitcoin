import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api } from '../api';
import { Card, PageHeader, Spinner, Alert } from '../components/ui';
import { money } from '../format';
import { useMerchantId } from '../session';
import type { Overview, Wallet } from '../types';

const PERIODS = [
  { id: '7d', label: '7 dias' },
  { id: '30d', label: '30 dias' },
  { id: '90d', label: '90 dias' },
] as const;

const RAIL_LABEL: Record<string, string> = { pix: 'Pix', bitcoin: 'Bitcoin' };

/** Junta a serie por dia (Pix e Bitcoin lado a lado) e preenche os dias vazios. */
function chartData(overview: Overview) {
  const byDay = new Map<string, { day: string; pix: number; bitcoin: number }>();
  const start = new Date(overview.since);
  for (let d = new Date(start); d <= new Date(); d.setDate(d.getDate() + 1)) {
    const key = d.toISOString().slice(0, 10);
    byDay.set(key, { day: key, pix: 0, bitcoin: 0 });
  }
  for (const row of overview.series) {
    const entry = byDay.get(row.day) ?? { day: row.day, pix: 0, bitcoin: 0 };
    entry[row.rail === 'bitcoin' ? 'bitcoin' : 'pix'] += Number(row.received_cents) / 100;
    byDay.set(row.day, entry);
  }
  return [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
}

export default function OverviewPage() {
  const merchantId = useMerchantId();
  const [period, setPeriod] = useState<(typeof PERIODS)[number]['id']>('30d');
  const overview = useQuery({
    queryKey: ['overview', merchantId, period],
    queryFn: () => api<Overview>(`/v1/dash/merchants/${merchantId}/overview?period=${period}`),
  });
  const wallets = useQuery({
    queryKey: ['wallets', merchantId],
    queryFn: () => api<{ wallets: Wallet[] }>(`/v1/dash/merchants/${merchantId}/wallets`),
  });

  return (
    <>
      <PageHeader
        title="Visão geral"
        subtitle="Quanto sua loja recebeu e por qual meio."
        actions={
          <div className="segmented">
            {PERIODS.map((p) => (
              <button key={p.id} className={p.id === period ? 'active' : ''} onClick={() => setPeriod(p.id)}>
                {p.label}
              </button>
            ))}
          </div>
        }
      />
      {wallets.data && wallets.data.wallets.length === 0 && (
        <Alert kind="warn">
          Cadastre a carteira que vai receber os pagamentos antes de cobrar. <Link to="/carteiras">Cadastrar carteira</Link>
        </Alert>
      )}
      {overview.isLoading && <Spinner />}
      {overview.data && (
        <>
          <div className="kpis">
            <div className="kpi">
              <span className="kpi-label">Recebido</span>
              <strong>{money(overview.data.received_cents)}</strong>
            </div>
            <div className="kpi">
              <span className="kpi-label">Pagamentos pagos</span>
              <strong>{overview.data.payments_paid}</strong>
              <span className="muted small">de {overview.data.payments_created} criados</span>
            </div>
            <div className="kpi">
              <span className="kpi-label">Conversão</span>
              <strong>{overview.data.conversion_rate === null ? '—' : `${overview.data.conversion_rate}%`}</strong>
            </div>
          </div>
          <Card title="Recebido por dia">
            <div className="chart">
              <ResponsiveContainer width="100%" height={260}>
                <AreaChart data={chartData(overview.data)} margin={{ left: 8, right: 8, top: 8 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" />
                  <XAxis dataKey="day" tickFormatter={(d: string) => d.slice(8, 10) + '/' + d.slice(5, 7)} stroke="var(--muted)" fontSize={12} />
                  <YAxis stroke="var(--muted)" fontSize={12} width={60} />
                  <Tooltip formatter={(v, name) => [money(Math.round(Number(v ?? 0) * 100)), RAIL_LABEL[String(name)] ?? String(name)]} />
                  <Area type="monotone" dataKey="pix" stackId="1" stroke="var(--c1)" fill="var(--c1)" fillOpacity={0.25} />
                  <Area type="monotone" dataKey="bitcoin" stackId="1" stroke="var(--c2)" fill="var(--c2)" fillOpacity={0.25} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </Card>
          <Card title="Por meio de pagamento">
            <table className="table">
              <thead>
                <tr>
                  <th>Meio</th>
                  <th>Criados</th>
                  <th>Pagos</th>
                  <th className="num">Recebido</th>
                </tr>
              </thead>
              <tbody>
                {overview.data.by_rail.map((row) => (
                  <tr key={row.rail}>
                    <td>{RAIL_LABEL[row.rail] ?? row.rail}</td>
                    <td>{row.created}</td>
                    <td>{row.paid}</td>
                    <td className="num">{money(row.received_cents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </>
      )}
    </>
  );
}
