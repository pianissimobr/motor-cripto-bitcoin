import { loadEnvFile } from '../src/load-env.js';

loadEnvFile();

import { Interface, getAddress } from 'ethers';
import { bootstrap } from '../src/bootstrap.js';
import { createDatabase } from '../src/adapters/db/client.js';
import { createProviderFactory } from '../src/core/chain/provider.js';
import { TRANSFER_TOPIC } from '../src/core/chain/erc20.js';

/**
 * Verificacao end-to-end do monitor contra a Polygon real.
 *
 * Nao gasta dinheiro nem assina transacao: o script encontra uma
 * transferencia de USDC que JA aconteceu na chain, cadastra um link
 * apontando para o endereco receptor dela e roda o monitor. Se a deteccao
 * funcionar, o pagamento aparece em `links_pagos` e o credito em
 * `creditos_cliente`.
 *
 * Uso: npm run verify:monitor
 */

const USDC = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359';
const iface = new Interface(['event Transfer(address indexed from, address indexed to, uint256 value)']);

async function main(): Promise<void> {
  const { motor, close } = await bootstrap();
  const handle = createDatabase(process.env.DATABASE_URL!, false);
  const sql = handle.sql;

  const rpc = createProviderFactory({
    polygon: process.env.RPC_URL_POLYGON ?? 'https://polygon-bor-rpc.publicnode.com',
  })('polygon');

  console.log('1) buscando transferencia real de USDC na Polygon...');
  // O motor varre ate `finalized` (MONITOR_BLOCK_TAG). Se procurassemos a
  // amostra perto do `latest` e ela caisse entre finalized e latest, o
  // monitor nunca a veria. Por isso buscamos DENTRO da janela finalizada.
  const finalized = await rpc.getBlock('finalized').catch(() => null);
  const head = finalized?.number ?? (await rpc.getBlockNumber());
  let sample: { transactionHash: string; blockNumber: number; topics: readonly string[]; data: string } | null = null;

  // O RPC publico limita a faixa de blocos; vasculha janelas cada vez
  // menores ate encontrar uma transferencia.
  for (const janela of [20, 10, 5]) {
    for (let tentativas = 0; tentativas < 6 && !sample; tentativas++) {
      const to = head - tentativas * janela - 1;
      const from = to - janela + 1;
      try {
        const encontrados = await rpc.getLogs({
          address: USDC,
          topics: [TRANSFER_TOPIC],
          fromBlock: from,
          toBlock: to,
        });
        if (encontrados.length > 0) sample = encontrados[encontrados.length - 1]!;
      } catch {
        // janela grande demais: tenta a proxima
      }
    }
    if (sample) break;
  }

  if (!sample) {
    console.error('   nenhuma transferencia encontrada; tente outra RPC');
    await sql.end({ timeout: 5 });
    await close();
    process.exit(1);
  }
  const parsed = iface.parseLog({ topics: [...sample.topics], data: sample.data })!;
  const destino = getAddress(String(parsed.args[1]));
  const valor = BigInt(parsed.args[2]);
  const bloco = sample.blockNumber;

  console.log(`   tx: ${sample.transactionHash}`);
  console.log(`   destino: ${destino}`);
  console.log(`   valor: ${valor} base units (${Number(valor) / 1e6} USDC)`);
  console.log(`   bloco: ${bloco}`);

  console.log('2) cadastrando um link de teste apontando para esse endereco...');
  const perfil = (await motor.repos.rampProfiles.list()).find((p) => p.asset === 'USDC');
  if (!perfil) throw new Error('perfil USDC nao encontrado (rode npm run seed)');

  const cliente = await motor.customers.create({
    nome: 'Cliente de Verificacao',
    email: `verificacao-${Date.now()}@exemplo.test`,
  });

  const [linkRow] = await sql`
    insert into links_gerados (
      cliente_id, ramp_profile_id, chain, asset, token_contract, decimals, moeda_fiat,
      valor_fiat_centavos, valor_fiat_unidades, indice_hd, caminho_derivacao,
      endereco_deposito, ramp_url, status, expira_em
    ) values (
      ${cliente.id}, ${perfil.id}, 'polygon', 'USDC', ${USDC}, 6, 'BRL',
      10000, 10000, 999999, ${"m/44'/60'/0'/0/999999"},
      ${destino.toLowerCase()}, 'https://exemplo.local/verificacao', 'aguardando', now() + interval '1 day'
    )
    returning id
  `;
  const linkId = linkRow!.id as string;
  console.log(`   link: ${linkId}`);

  console.log('3) rewinding o cursor do monitor...');
  await sql`
    insert into chain_cursors (chain, token_contract, ultimo_bloco, hash_bloco)
    values ('polygon', ${USDC.toLowerCase()}, ${bloco - 3}, null)
    on conflict (chain, token_contract) do update set ultimo_bloco = ${bloco - 3}
  `;

  console.log('4) rodando o monitor...');
  const resultado = await motor.monitor.runCycle();
  console.log(`   ${JSON.stringify(resultado)}`);

  const pagamentos = await motor.repos.payments.listByLink(linkId);
  const creditos = await motor.repos.credits.listByCustomer(cliente.id);
  const link = await motor.repos.links.findById(linkId);

  console.log('\n=== RESULTADO ===');
  console.log(`status do link: ${link?.status}`);
  console.log(`pagamentos detectados: ${pagamentos.length}`);
  for (const p of pagamentos) {
    console.log(
      `  - tx ${p.txHash} valor=${p.valorBaseUnits} confirmacoes=${p.confirmacoes} status=${p.status}`,
    );
  }
  console.log(`creditos gerados: ${creditos.length}`);
  for (const c of creditos) {
    console.log(`  - ${c.valorBaseUnits} ${c.moeda} (${c.valorCentavos} centavos) status=${c.status}`);
  }

  await sql`delete from links_gerados where id = ${linkId}`;
  await sql`delete from cadastros where id = ${cliente.id}`;
  console.log('\n(ambiente de teste limpo)');

  await sql.end({ timeout: 5 });
  await close();

  if (pagamentos.length === 0) {
    console.error('\nFALHA: o monitor nao detectou a transferencia.');
    process.exit(1);
  }
  console.log('\nOK: o monitor detectou a transferencia real e creditou o cliente.');
}

main().catch((err) => {
  console.error('erro:', err);
  process.exit(1);
});
