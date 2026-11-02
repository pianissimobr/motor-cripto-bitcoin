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