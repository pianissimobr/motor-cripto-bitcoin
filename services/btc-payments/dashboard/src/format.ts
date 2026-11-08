/** Centavos (string) -> "R$ 1.234,56" sem passar por float. */
export function money(cents: string | number | bigint, currency = 'BRL'): string {
  const value = BigInt(cents);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const int = (abs / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const frac = (abs % 100n).toString().padStart(2, '0');
  const symbol = currency === 'USD' ? 'US$' : 'R$';
  return `${negative ? '-' : ''}${symbol} ${int},${frac}`;
}

/** Unidades minimas de USDC (6 casas) -> "1.234,56 USDC". */
export function usdc(minor: string): string {
  const value = BigInt(minor);
  const cents = value / 10_000n;
  return `${money(cents).replace('R$ ', '')} USDC`;
}

export function dateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
}

export function shortHash(value: string | null | undefined, size = 6): string {
  if (!value) return '—';
  return value.length <= size * 2 + 3 ? value : `${value.slice(0, size + 2)}…${value.slice(-size)}`;
}

/** Status do motor -> rotulo e tom para o selo. */
export function statusLabel(status: string): { label: string; tone: 'ok' | 'wait' | 'bad' | 'muted' } {
  const map: Record<string, { label: string; tone: 'ok' | 'wait' | 'bad' | 'muted' }> = {
    liquidado: { label: 'Liquidado', tone: 'ok' },
    pago: { label: 'Pago', tone: 'ok' },
    entregue: { label: 'Entregue', tone: 'ok' },
    pendente: { label: 'Aguardando', tone: 'wait' },
    criando: { label: 'Criando', tone: 'wait' },
    aguardando_deposito: { label: 'Aguardando depósito', tone: 'wait' },
    depositado: { label: 'Depositado', tone: 'wait' },
    trocado: { label: 'Convertendo', tone: 'wait' },
    incerto: { label: 'Em conferência', tone: 'wait' },
    expirado: { label: 'Expirado', tone: 'muted' },
    cancelado: { label: 'Cancelado', tone: 'muted' },
    reembolsado: { label: 'Reembolsado', tone: 'muted' },
    falhou: { label: 'Falhou', tone: 'bad' },
    falha: { label: 'Falhou', tone: 'bad' },
    manual: { label: 'Em análise', tone: 'bad' },
  };
  return map[status] ?? { label: status, tone: 'muted' };
}
