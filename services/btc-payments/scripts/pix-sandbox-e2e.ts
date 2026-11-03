import { randomUUID } from 'node:crypto';
import { signRequest } from '../src/crypto/hmac.js';

/**
 * Teste ponta a ponta do PIX contra o sandbox da LuniumPay.
 *
 * Cria a cobranca pelo motor (autenticado como a loja), paga no simulador da
 * Lunium e sincroniza ate o motor registrar a liquidacao.
 *
 *   npm run pix:e2e -- --api-key mk_... --request-secret ... --admin-token ...
 *
 * Precisa da API da Lunium no sandbox (chave `lun_test_`) e do motor no ar.
 */

type Args = {
  baseUrl: string;
  apiKey: string;
  requestSecret: string;
  adminToken: string;
  luniumApiKey: string;
  luniumApiUrl: string;
  amountCents: number;
  payerTax: string;
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
    luniumApiKey: required('--lunium-api-key'),
    luniumApiUrl: (arg('--lunium-api-url') ?? 'https://api.luniumpay.com').replace(
      /\/+$/,
      '',
    ),
    amountCents: Number(arg('--amount-cents') ?? 2500),
    payerTax: arg('--payer-tax') ?? '00000000191',
  };

  const externalId = `e2e_pix_${Date.now()}`;

  console.log(`1) criando cobranca de R$ ${(args.amountCents / 100).toFixed(2)} no motor...`);
  const created = await signedRequest(args, '/v1/pix-charges', {
    external_id: externalId,
    amount: args.amountCents,
    currency: 'BRL',
    payer_tax_number: args.payerTax,
    payer_name: 'Cliente E2E',
  });
  if (created.status !== 201 && created.status !== 200) {
    console.error('falha ao criar a cobranca:', JSON.stringify(created.body, null, 2));
    process.exit(1);
  }
  const charge = created.body as {
    id: string;
    provider_charge_id: string | null;
    status: string;
    pix?: { qr_copypaste?: string | null; expires_at?: string | null };
  };
  console.log(`   cobranca ${charge.id} (${charge.status}) cashin=${charge.provider_charge_id}`);

  const cashinId = charge.provider_charge_id;
  if (!cashinId) {
    console.error('a Lunium nao devolveu o cashin_id');
    process.exit(1);
  }

  console.log('2) pagando no simulador do sandbox...');
  const pay = await fetch(`${args.luniumApiUrl}/sandbox/cashin/${cashinId}/pay`, {
    method: 'POST',
    headers: {
      'x-api-key': args.luniumApiKey,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({ payer_tax_number: args.payerTax }),
  });
  const payBody = await pay.text();
  console.log(`   sandbox respondeu ${pay.status}: ${payBody.slice(0, 300)}`);
  if (!pay.ok) process.exit(1);

  console.log('3) sincronizando no motor...');
  let estado = charge.status;
  for (let tentativa = 1; tentativa <= 10; tentativa++) {
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
      data?: { status?: string; settlement_status?: string };
    };
    const body = raw.data ?? raw;
    estado = body.status ?? estado;
    console.log(`   tentativa ${tentativa}: status=${body.status} liquidacao=${body.settlement_status}`);
    if (estado === 'liquidado' || estado === 'manual' || estado === 'falhou') break;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  console.log(`\nresultado: ${estado}`);
  if (estado !== 'liquidado') {
    console.error('a cobranca nao liquidou');
    process.exit(1);
  }
  console.log('E2E do PIX no sandbox: OK');
}

main().catch((err) => {
  console.error('[btc-payments] falha no E2E do PIX:', err);
  process.exit(1);
});
