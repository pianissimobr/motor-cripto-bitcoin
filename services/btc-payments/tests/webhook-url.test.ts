import { describe, expect, it } from 'vitest';
import {
  assertWebhookUrl,
  isBlockedAddress,
} from '../src/net/webhook-url.js';

describe('webhook URL (SSRF guard)', () => {
  it('bloqueia enderecos privados/link-local/metadata', () => {
    expect(isBlockedAddress('127.0.0.1')).toBe(true);
    expect(isBlockedAddress('10.0.0.8')).toBe(true);
    expect(isBlockedAddress('172.16.0.1')).toBe(true);
    expect(isBlockedAddress('192.168.1.1')).toBe(true);
    expect(isBlockedAddress('169.254.169.254')).toBe(true);
    expect(isBlockedAddress('::1')).toBe(true);
    expect(isBlockedAddress('fe80::1')).toBe(true);
    expect(isBlockedAddress('8.8.8.8')).toBe(false);
  });

  it('bloqueia CGNAT/Tailscale (a VPS tem rota para a tailnet) e faixas reservadas', () => {
    expect(isBlockedAddress('100.127.87.81')).toBe(true);
    expect(isBlockedAddress('100.64.0.1')).toBe(true);
    expect(isBlockedAddress('100.63.255.255')).toBe(false);
    expect(isBlockedAddress('100.128.0.1')).toBe(false);
    expect(isBlockedAddress('198.18.0.1')).toBe(true);
    expect(isBlockedAddress('192.0.0.8')).toBe(true);
    expect(isBlockedAddress('224.0.0.1')).toBe(true);
    expect(isBlockedAddress('255.255.255.255')).toBe(true);
    expect(isBlockedAddress('1.1.1.1')).toBe(false);
  });

  it('bloqueia IPv4 interno embutido em IPv6 (mapeado, NAT64, 6to4)', () => {
    expect(isBlockedAddress('::ffff:169.254.169.254')).toBe(true);
    expect(isBlockedAddress('::ffff:a9fe:a9fe')).toBe(true);
    expect(isBlockedAddress('64:ff9b::169.254.169.254')).toBe(true);
    expect(isBlockedAddress('64:ff9b::a9fe:a9fe')).toBe(true);
    expect(isBlockedAddress('2002:a9fe:a9fe::1')).toBe(true);
    expect(isBlockedAddress('2002:0808:0808::1')).toBe(false);
    expect(isBlockedAddress('64:ff9b::8.8.8.8')).toBe(false);
    expect(isBlockedAddress('::ffff:8.8.8.8')).toBe(false);
  });

  it('bloqueia IPv6 local, multicast, a tailnet e formas abreviadas', () => {
    expect(isBlockedAddress('fd7a:115c:a1e0::8535:5752')).toBe(true);
    expect(isBlockedAddress('ff02::1')).toBe(true);
    expect(isBlockedAddress('0:0:0:0:0:0:0:1')).toBe(true);
    expect(isBlockedAddress('::')).toBe(true);
    expect(isBlockedAddress('fe80::1%eth0')).toBe(true);
    expect(isBlockedAddress('2001:db8::1')).toBe(true);
    expect(isBlockedAddress('2606:4700:4700::1111')).toBe(false);
    expect(isBlockedAddress('nao-e-ip')).toBe(true);
  });

  it('permite loopback apenas quando allowLoopback=true', () => {
    expect(isBlockedAddress('127.0.0.1', true)).toBe(false);
    expect(isBlockedAddress('::1', true)).toBe(false);
    expect(isBlockedAddress('10.0.0.8', true)).toBe(true);
  });

  it('rejeita host interno na resolucao', async () => {
    await expect(
      assertWebhookUrl('http://localhost:9999/x', {
        requireHttps: false,
        lookupHost: async () => ['127.0.0.1'],
      }),
    ).rejects.toThrow();
    await expect(
      assertWebhookUrl('http://metadata.google.internal/x', {
        requireHttps: false,
        lookupHost: async () => ['8.8.8.8'],
      }),
    ).rejects.toThrow();
  });

  it('aceita destino publico', async () => {
    await expect(
      assertWebhookUrl('https://loja.example.com/webhook', {
        requireHttps: true,
        lookupHost: async () => ['93.184.216.34'],
      }),
    ).resolves.toBeUndefined();
  });
});