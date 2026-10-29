import { randomUUID } from 'node:crypto';
import { signRequest } from '../src/crypto/hmac.js';
import { loadEnv } from '../src/load-env.js';

loadEnv();

async function main(): Promise<void> {
  const apiKey = process.env.CLIENT_API_KEY;
  const requestSecret = process.env.CLIENT_REQUEST_SECRET;
  if (!apiKey || !requestSecret) {
    throw new Error(
      'defina CLIENT_API_KEY e CLIENT_REQUEST_SECRET (saida de client:create)',
    );
  }

  const externalId =
    process.env.EXTERNAL_ID ?? `dev-${Date.now().toString(36)}`;
  const amountSats = process.env.AMOUNT_SATS ?? '1000';
  const description = process.env.DESCRIPTION;
  const baseUrl = (
    process.env.PUBLIC_BASE_URL ?? 'http://localhost:4580'
  ).replace(/\/+$/, '');

  const body = JSON.stringify({
    external_id: externalId,
    amount_sats: amountSats,
    ...(description ? { description } : {}),
  });
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = randomUUID();
  const path = '/v1/payment-intents';
  const signature = signRequest(requestSecret, {
    method: 'POST',
    path,
    timestamp,
    nonce,
    body,
  });

  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
      'x-timestamp': timestamp,
      'x-nonce': nonce,
      'x-signature': signature,
    },
    body,
  });
  const text = await response.text();
  console.log(`HTTP ${response.status}`);
  try {
    console.log(JSON.stringify(JSON.parse(text), null, 2));
  } catch {
    console.log(text);
  }
  if (!response.ok) process.exitCode = 1;
}

main().catch((err) => {
  console.error('[btc-payments] falha ao criar intent:', err);
  process.exit(1);
});
