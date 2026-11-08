import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { ValidationError } from '../domain/errors.js';

export type HostLookup = (hostname: string) => Promise<string[]>;

export async function defaultHostLookup(hostname: string): Promise<string[]> {
  const records = await lookup(hostname, { all: true, verbatim: true });
  return records.map((record) => record.address);
}

const BLOCKED_NAMES = new Set(['metadata.google.internal']);

/** IPv4 em 4 octetos, ou `null` se nao for IPv4 valido. */
function ipv4Octets(ip: string): [number, number, number, number] | null {
  if (isIP(ip) !== 4) return null;
  const parts = ip.split('.').map((part) => Number(part));
  return parts.length === 4 ? (parts as [number, number, number, number]) : null;
}

/**
 * Faixas IPv4 que nunca sao destino de webhook: privadas, loopback,
 * link-local (metadata de nuvem), CGNAT/Tailscale (`100.64/10` — a VPS tem
 * rota para a tailnet), benchmark, multicast e reservadas.
 */
function isBlockedIpv4(octets: [number, number, number, number], allowLoopback: boolean): boolean {
  const [a, b, c] = octets;
  if (a === 127) return !allowLoopback;
  if (a === 0) return true;
  if (a === 10) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 0 && c === 0) return true;
  if (a === 192 && b === 168) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a >= 224) return true;
  return false;
}

/** Expande um IPv6 (sem zona) em 8 grupos de 16 bits; `null` se invalido. */
function ipv6Groups(ip: string): number[] | null {
  if (isIP(ip) !== 6) return null;
  let text = ip;
  // IPv4 no fim (ex.: ::ffff:1.2.3.4, 64:ff9b::1.2.3.4) vira dois grupos.
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (v4) {
    const o = ipv4Octets(v4[1]!);
    if (!o) return null;
    text = `${text.slice(0, -v4[1]!.length)}${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
  }
  const [head, tail] = text.includes('::') ? text.split('::') : [text, null];
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const missing = 8 - left.length - right.length;
  if (tail === null ? missing !== 0 : missing < 0) return null;
  const groups = [...left, ...Array(tail === null ? 0 : missing).fill('0'), ...right].map((g) =>
    Number.parseInt(g || '0', 16),
  );
  return groups.length === 8 && groups.every((g) => g >= 0 && g <= 0xffff) ? groups : null;
}

const embeddedIpv4 = (hi: number, lo: number): [number, number, number, number] => [
  hi >> 8,
  hi & 0xff,
  lo >> 8,
  lo & 0xff,
];

export function isBlockedAddress(ip: string, allowLoopback = false): boolean {
  const normalized = ip.toLowerCase().replace(/^\[|\]$/g, '').replace(/%.*$/, '');

  const v4 = ipv4Octets(normalized);
  if (v4) return isBlockedIpv4(v4, allowLoopback);

  const g = ipv6Groups(normalized);
  if (!g) return true;
  const allZeroUntil = (n: number) => g.slice(0, n).every((x) => x === 0);

  // :: e ::1
  if (allZeroUntil(7) && g[7] === 0) return true;
  if (allZeroUntil(7) && g[7] === 1) return !allowLoopback;
  // IPv4 embutido: mapeado (::ffff:0:0/96), NAT64 (64:ff9b::/96) e 6to4
  // (2002::/16). Sem isto, `64:ff9b::a9fe:a9fe` alcancaria 169.254.169.254.
  if (allZeroUntil(5) && g[5] === 0xffff) return isBlockedIpv4(embeddedIpv4(g[6]!, g[7]!), allowLoopback);
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) {
    return isBlockedIpv4(embeddedIpv4(g[6]!, g[7]!), allowLoopback);
  }
  if (g[0] === 0x2002) return isBlockedIpv4(embeddedIpv4(g[1]!, g[2]!), allowLoopback);

  const first = g[0]!;
  if (first >= 0xfc00 && first <= 0xfdff) return true; // unique local (inclui a tailnet fd7a:115c:a1e0::/48)
  if (first >= 0xfe80 && first <= 0xfebf) return true; // link-local
  if (first >= 0xff00) return true; // multicast
  if (first === 0x2001 && g[1] === 0x0db8) return true; // documentacao
  if (first === 0x0100 && g.slice(1, 4).every((x) => x === 0)) return true; // descarte 100::/64
  return false;
}

export async function assertWebhookUrl(
  value: string,
  options: {
    requireHttps: boolean;
    lookupHost: HostLookup;
    allowLoopback?: boolean;
  },
): Promise<void> {
  const allowLoopback = options.allowLoopback ?? false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ValidationError('webhook_url invalida');
  }
  if (url.username || url.password) {
    throw new ValidationError('webhook_url nao pode carregar usuario ou senha');
  }
  const httpsOk = url.protocol === 'https:';
  const httpOk = !options.requireHttps && url.protocol === 'http:';
  if (!httpsOk && !httpOk) {
    throw new ValidationError(
      options.requireHttps
        ? 'webhook_url em producao precisa ser https'
        : 'webhook_url deve usar http(s)',
    );
  }

  const host = url.hostname.replace(/\.$/, '').toLowerCase();
  if (
    host === 'localhost' ||
    host === 'localhost.localdomain' ||
    host.endsWith('.localhost')
  ) {
    if (!allowLoopback) {
      throw new ValidationError('webhook_url aponta para host interno');
    }
  } else if (BLOCKED_NAMES.has(host) || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new ValidationError('webhook_url aponta para host interno');
  }
  if (isIP(host)) {
    if (isBlockedAddress(host, allowLoopback)) {
      throw new ValidationError('webhook_url aponta para endereco interno');
    }
    return;
  }

  let addresses: string[];
  try {
    addresses = await options.lookupHost(host);
  } catch {
    throw new ValidationError('webhook_url nao pode ser resolvida');
  }
  if (
    addresses.length === 0 ||
    addresses.some((address) => isBlockedAddress(address, allowLoopback))
  ) {
    throw new ValidationError('webhook_url aponta para endereco interno');
  }
}