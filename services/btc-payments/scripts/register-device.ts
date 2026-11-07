import { randomBytes } from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';
import { signRequest } from '../src/crypto/hmac.js';
import { loadEnv } from '../src/load-env.js';

loadEnv();

/**
 * Registra um device no motor (C6/C12) e devolve a credencial.
 *
 *   npm run device:register -- --url https://cripto.libreflowdigital.com
 *
 * O app faz esse mesmo fluxo na tela de registro: prova que controla o
 * endereco assinando um desafio e recebe o `api_key` + `request_secret`. Este
 * script existe para provisionar um device por linha de comando (teste,
 * operacao) — e para confirmar que o motor aceita a prova de posse vinda de
 * fora do app.
 *
 * A chave privada fica em memoria e nao e guardada: o script registra um
 * endereco novo a cada execucao, e a credencial impressa e o que importa.
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const urlIndex = args.indexOf('--url');
  const baseUrl = (
    (urlIndex >= 0 ? args[urlIndex + 1] : undefined) ??
    process.env.PUBLIC_BASE_URL ??
    'http://localhost:4580'
  ).replace(/\/+$/, '');

  const account = privateKeyToAccount(`0x${randomBytes(32).toString('hex')}`);
  const address = account.address;
  console.log(`endereco do device: ${address}`);

  // 1. o desafio (rota publica: o device ainda nao tem credencial)
  const challengeResponse = await fetch(`${baseUrl}/v1/user/challenges`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ purpose: 'client_registration', address }),
  });
  const challengeText = await challengeResponse.text();
  if (!challengeResponse.ok) {
    console.error(`HTTP ${challengeResponse.status}: ${challengeText}`);
    process.exit(1);
  }
  const challenge = JSON.parse(challengeText) as {
    nonce: string;
    message: string;
  };

  // 2. a prova de posse: a chave e local, o motor so confere a assinatura
  const signature = await account.signMessage({ message: challenge.message });

  const registerResponse = await fetch(`${baseUrl}/v1/user/clients`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      address,
      chain: 'polygon',
      proof: { nonce: challenge.nonce, signature },
    }),
  });
  const registerText = await registerResponse.text();
  if (!registerResponse.ok) {
    console.error(`HTTP ${registerResponse.status}: ${registerText}`);
    process.exit(1);
  }
  const registered = JSON.parse(registerText) as {
    client_id: string;
    api_key: string;
    request_secret: string;
  };

  console.log(`client_id: ${registered.client_id}`);
  console.log(`api_key: ${registered.api_key}`);
  console.log(`request_secret: ${registered.request_secret}`);

  // 3. prova de que a credencial funciona: o extrato do endereco
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = randomBytes(16).toString('hex');
  const path = '/v1/user/operations';
  const signatureRequest = signRequest(registered.request_secret, {
    method: 'GET',
    path,
    timestamp,
    nonce,
    body: '',
  });
  const operationsResponse = await fetch(`${baseUrl}${path}`, {
    method: 'GET',
    headers: {
      authorization: `Bearer ${registered.api_key}`,
      'x-timestamp': timestamp,
      'x-nonce': nonce,
      'x-signature': signatureRequest,
    },
  });
  console.log(`extrato: HTTP ${operationsResponse.status}`);
  console.log(await operationsResponse.text());
}

main().catch((err) => {
  console.error('[btc-payments] falha ao registrar o device:', err);
  process.exit(1);
});
