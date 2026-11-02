import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { ValidationError } from '../domain/errors.js';

export type HostLookup = (hostname: string) => Promise<string[]>;

export async function defaultHostLookup(hostname: string): Promise<string[]> {
  const records = await lookup(hostname, { all: true, verbatim: true });
  return records.map((record) => record.address);
}

const BLOCKED_NAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'metadata.google.internal',
]);

export function isBlockedAddress(ip: string): boolean {
  const normalized = ip.toLowerCase().replace(/^\[|\]$/g, '');
  if (normalized.startsWith('::ffff:')) return isBlockedAddress(normalized.slice('::ffff:'.length));
  if (normalized === '::1' || normalized === '::') return true;

  const family = isIP(normalized);
  if (family === 6) {
    const head = normalized.split(':')[0] ?? '';
    const first = Number.parseInt(head || '0', 16);
    if (Number.isNaN(first)) return true;
    if (first >= 0xfc00 && first <= 0xfdff) return true;
    if (first >= 0xfe80 && first <= 0xfebf) return true;
    return false;
  }
  if (family !== 4) return true;

  const parts = normalized.split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part))) return true;
  const [a, b] = parts as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

export async function assertWebhookUrl(
  value: string,
  options: { requireHttps: boolean; lookupHost: HostLookup },
): Promise<void> {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ValidationError('webhookUrl invalida');
  }
  if (url.username || url.password) {
    throw new ValidationError('webhookUrl nao pode carregar usuario ou senha');
  }
  const httpsOk = url.protocol === 'https:';
  const httpOk = !options.requireHttps && url.protocol === 'http:';
  if (!httpsOk && !httpOk) {
    throw new ValidationError(
      options.requireHttps
        ? 'webhookUrl em producao precisa ser https'
        : 'webhookUrl deve usar http(s)',
    );
  }

  const host = url.hostname.replace(/\.$/, '').toLowerCase();
  if (
    BLOCKED_NAMES.has(host) ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal')
  ) {
    throw new ValidationError('webhookUrl aponta para host interno');
  }
  if (isIP(host)) {
    if (isBlockedAddress(host)) {
      throw new ValidationError('webhookUrl aponta para endereco interno');
    }
    return;
  }

  let addresses: string[];
  try {
    addresses = await options.lookupHost(host);
  } catch {
    throw new ValidationError('webhookUrl nao pode ser resolvida');
  }
  if (addresses.length === 0 || addresses.some((address) => isBlockedAddress(address))) {
    throw new ValidationError('webhookUrl aponta para endereco interno');
  }
}
