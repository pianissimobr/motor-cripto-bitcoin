import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { isIP } from 'node:net';
import { Agent, fetch as undiciFetch } from 'undici';
import { isBlockedAddress } from './webhook-url.js';

/**
 * fetch para URLs que vem de lojistas (webhook da loja, LNbits do lojista).
 * O endereco e conferido no momento da conexao, depois da resolucao DNS: um
 * dominio que passou na validacao do cadastro e depois passa a apontar para
 * a rede interna (DNS rebinding) e recusado.
 */
export function createSafeFetch(opts: { allowLoopback: boolean }): typeof fetch {
  const agent = new Agent({
    connect: {
      lookup(hostname, options, callback) {
        dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
          if (err) {
            callback(err, '', 4);
            return;
          }
          const list = addresses as LookupAddress[];
          const blocked = list.find((entry) =>
            isBlockedAddress(entry.address, opts.allowLoopback),
          );
          if (blocked || list.length === 0) {
            callback(
              new Error(`destino bloqueado: ${hostname} resolve para endereco interno`),
              '',
              4,
            );
            return;
          }
          if ((options as { all?: boolean }).all) {
            (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, list);
            return;
          }
          callback(null, list[0]!.address, list[0]!.family);
        });
      },
    },
  });

  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    const host = url.hostname.replace(/^\[|\]$/g, '');
    // IP literal nao passa pelo lookup: confere aqui.
    if (isIP(host) && isBlockedAddress(host, opts.allowLoopback)) {
      throw new Error(`destino bloqueado: ${host} e endereco interno`);
    }
    return undiciFetch(url, {
      ...(init as Record<string, unknown>),
      dispatcher: agent,
    } as Parameters<typeof undiciFetch>[1]) as unknown as Response;
  }) as typeof fetch;
}
