import { randomUUID } from 'node:crypto';
import { signRequest } from '../src/crypto/hmac.js';

/**
 * Cria uma cobranca PIX real (producao) e acompanha a liquidacao.
 *
 *   npm run pix:live -- --api-key mk_... --request-secret ... \
 *     --admin-token ... --amount-brl 10.00 --payer-tax 00000000191
 *
 * Imprime o copia-e-cola do Pix para o pagador e fica de olho ate a
 * liquidacao. Nao paga nada: quem paga e o pagador, no app do banco.
 */

type Args = {
  baseUrl: string;
  apiKey: string;
  requestSecret: string;
  adminToken: string;
  amountBrl: string;
  payerTax: string;
  payerName?: string;
  address?: string;
};

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function required(name: string): string {
  const value = arg(name) ?? process.env[name.replace(/^--/, '').toUpperCase()];
  if (!value) {
    console.error(`falta ${name}`);
    process.exit(2);
  }
  return value;
}

async function signedRequest(args: Args, path: string, body: unknown) {
  const payload = JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = randomUUID();
  const signature = signRequest(args.requestSecret, {
    method: 'POST',
    path,
    timestamp,
    nonce,
    body: payload,
  });
  const response = await fetch(`${args.baseUrl}${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${args.apiKey}`,
      'content-type': 'application/json',
      'x-timestamp': timestamp,
      'x-nonce': nonce,
      'x-signature': signature,
    },
    body: payload,
  });
  const text = await response.text();
  let parsed: unknown = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { raw: text };
  }
  return { status: response.status, body: parsed as Record<string, unknown> };
}

async function main(): Promise<void> {
  const args: Args = {
    baseUrl: (arg('--base-url') ?? 'http://localhost:4580').replace(/\/+$/, ''),
    apiKey: required('--api-key'),
    requestSecret: required('--request-secret'),
    adminToken: required('--admin-token'),
    amountBrl: arg('--amount-brl') ?? '10.00',
    payerTax: (arg('--payer-tax') ?? '').replace(/\D/g, ''),
    ...(arg('--payer-name') ? { payerName: arg('--payer-name')! } : {}),
    ...(arg('--address') ? { address: arg('--address')! } : {}),
  };
  if (args.payerTax.length !== 11 && args.payerTax.length !== 14) {
    console.error('informe o CPF (11 digitos) ou CNPJ (14) de quem paga');
    process.exit(2);
  }

  if (args.address) {
    const wallet = await signedRequest(args, '/v1/wallets', {
      kind: 'usdc_settlement',
      address: args.address,
    });
    console.log('carteira de liquidacao:', JSON.stringify(wallet.body));
    if (wallet.status >= 300) process.exit(1);
  }

  const externalId = arg('--external-id') ?? `live_${Date.now()}`;
  const created = await signedRequest(args, '/v1/pix-charges', {
    external_id: externalId,
    amount: args.amountBrl,
    currency: 'BRL',
    payer_tax_number: args.payerTax,
    ...(args.payerName ? { payer_name: args.payerName } : {}),
  });
  if (created.status >= 300) {
    console.error('falha ao criar a cobranca:', JSON.stringify(created.body, null, 2));
    process.exit(1);
  }
  const charge = created.body as {
    id: string;
    provider_charge_id: string | null;
    status: string;
    pix?: { qr_copypaste?: string | null; qr_image_url?: string | null; expires_at?: string | null };
  };

  console.log('');
  console.log(`cobranca ${charge.id} (${charge.status})`);
  console.log(`copia e cola: ${charge.pix?.qr_copypaste}`);
  console.log(`qr: ${charge.pix?.qr_image_url}`);
  console.log(`expira: ${charge.pix?.expires_at}`);
  console.log('');
  console.log('aguardando o pagamento...');

  for (let tentativa = 1; tentativa <= 180; tentativa++) {
    await new Promise((resolve) => setTimeout(resolve, 10_000));
    const sync = await fetch(
      `${args.baseUrl}/admin/api/pix-charges/${charge.id}/sync`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${args.adminToken}` },
      },
    );
    const raw = (await sync.json()) as {
      status?: string;
      settlement_status?: string;
      error?: string | null;
      settlement_tx_hash?: string | null;
      data?: { status?: string; settlement_status?: string; error?: string | null; settlement_tx_hash?: string | null };
    };
    const body = raw.data ?? raw;
    console.log(
      `[${tentativa}] ${body.status}/${body.settlement_status}` +
        (body.error ? ` erro: ${body.error}` : '') +
        (body.settlement_tx_hash ? ` tx: ${body.settlement_tx_hash}` : ''),
    );
    if (body.status === 'liquidado') {
      console.log('liquidado.');
      return;
    }
    if (body.status === 'manual' || body.status === 'falhou') {
      console.error('a cobranca parou em:', body.status);
      process.exit(1);
    }
  }
  console.error('tempo esgotado sem liquidar');
  process.exit(1);
}

main().catch((err) => {
  console.error('[btc-payments] falha na simulacao:', err);
  process.exit(1);
});
