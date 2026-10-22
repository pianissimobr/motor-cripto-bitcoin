import { loadEnvFile } from '../src/load-env.js';

loadEnvFile();

import { DataCipher, Keyring, BlindIndex } from '../src/core/crypto/cipher.js';
import { createDatabase } from '../src/adapters/db/client.js';
import { createRepositories } from '../src/adapters/db/repositories.js';
import { loadConfig } from '../src/core/config.js';
import { normalizeEmail } from '../src/core/crypto/mask.js';

/**
 * E4: rotaciona a chave de cifragem da PII.
 *
 * Segura nos dois lados ao mesmo tempo:
 *  - DATA_ENCRYPTION_KEY / KEYRING: chave(s) de cifragem dos blobs
 *  - DATA_INDEX_KEY / DATA_INDEX_KEY_V2: chave(s) do blind index
 *
 * Como funciona: para cada cadastro, decifra com a chave antiga, cifra de
 * novo com a ativa, e grava as duas versoes do blind index (a antiga
 * continua valendo para a busca durante a transicao).
 *
 * Uso:
 *   npm run rotate:keys -- --dry-run
 *   npm run rotate:keys
 *
 * Depois de rodar com sucesso:
 *   1. remova a chave antiga do KEYRING
 *   2. remova DATA_INDEX_KEY (a antiga) e troque DATA_INDEX_KEY_V2 por
 *      DATA_INDEX_KEY (ou ajuste DATA_ACTIVE_KID/INDEX_LOOKUP_BOTH)
 *
 * Requisitos: o processo precisa de TODAS as chaves: a antiga e a nova.
 */

const arg = (nome: string): string | undefined => {
  const i = process.argv.indexOf(`--${nome}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const has = (nome: string): boolean => process.argv.includes(`--${nome}`);

const dryRun = has('dry-run');
const batchSize = Number(arg('batch') ?? 500);

async function main(): Promise<void> {
  const config = loadConfig(process.env);

  if (Object.keys(config.crypto.keyring).length < 2 && !config.crypto.indexKeyV2) {
    console.error(
      '\nNada a rotacionar.\n' +
        'Defina KEYRING com 2+ chaves (ex.: {"k1":"<b64 antigo>","k2":"<b64 novo>"}),\n' +
        'e/ou DATA_INDEX_KEY_V2 com a chave nova do blind index.\n',
    );
    process.exit(1);
  }

  const keyring = new Keyring(
    config.crypto.keyring,
    config.crypto.activeKid,
    config.crypto.legacyKid,
  );
  const cipher = new DataCipher(keyring);

  const blindIndex = config.crypto.indexKeyV2
    ? BlindIndex.rotating(
        config.crypto.indexKeyV2,
        config.crypto.indexKidV2,
        config.crypto.indexKey,
        'k1',
      )
    : new BlindIndex(config.crypto.indexKey, 'k1');

  console.log(`\n=== Rotacao de chaves (${dryRun ? 'DRY-RUN' : 'REAL'}) ===`);
  console.log(`chaves de cifragem: ${keyring.kids.join(', ')} (ativa: ${keyring.activeKid})`);
  console.log(`chaves de indice:   ${blindIndex.kids.join(', ')} (ativa: ${blindIndex.activeKid})`);
  console.log(`lote: ${batchSize}\n`);

  const handle = createDatabase(config.database.url, config.database.ssl);
  const repos = createRepositories(handle.db);

  let cursor: string | null = null;
  let total = 0;
  let reCifrados = 0;
  let indiceRotacionado = 0;
  const falhas: Array<{ id: string; erro: string }> = [];

  for (;;) {
    const lote = await repos.customers.listAllForRotation(cursor, batchSize);
    if (lote.length === 0) break;
    cursor = lote[lote.length - 1]!.id;
    total += lote.length;

    for (const row of lote) {
      try {
        const nome = cipher.decrypt(row.nomeEnc, row.id);
        const email = cipher.decrypt(row.emailEnc, row.id);

        const novoNome = cipher.encrypt(nome, row.id);
        const novoEmail = cipher.encrypt(email, row.id);

        // Blind index: ativo vira a coluna nova; o antigo continua para busca.
        const indices = blindIndex.computeAll(normalizeEmail(email));
        const ativo = indices.find((i) => i.kid === blindIndex.activeKid)!;
        const antigo = indices.find((i) => i.kid !== blindIndex.activeKid);

        const prefixos = prefixTokens(normalizeEmail(email), blindIndex);

        if (dryRun) {
          reCifrados++;
          if (antigo) indiceRotacionado++;
        } else {
          await repos.customers.updateEncrypted(
            row.id,
            novoNome,
            novoEmail,
            antigo?.bidx ?? ativo.bidx,
            antigo ? ativo.bidx : null,
            prefixos.antigos,
            prefixos.ativos,
          );
          reCifrados++;
          if (antigo) indiceRotacionado++;
        }
      } catch (err) {
        const mensagem = err instanceof Error ? err.message : String(err);
        falhas.push({ id: row.id, erro: mensagem });
      }
    }

    process.stdout.write(`  processados: ${total}\r`);
  }

  console.log(`\n\nCadastros processados: ${total}`);
  console.log(`re-cifrados:           ${reCifrados}`);
  console.log(`indice rotacionado:    ${indiceRotacionado}`);
  console.log(`falhas:                ${falhas.length}`);

  if (falhas.length > 0) {
    console.log('\nPrimeiras falhas:');
    for (const f of falhas.slice(0, 5)) console.log(`  ${f.id}: ${f.erro}`);
    console.log(
      '\nATENCAO: falhas indicam chave faltando no keyring. ' +
        'Nao remova a chave antiga antes de resolver.',
    );
  }

  if (dryRun) {
    console.log('\nDry-run: nada foi gravado. Rode sem --dry-run para aplicar.');
  } else if (falhas.length === 0) {
    console.log('\nRotacao concluida. Proximos passos:');
    console.log('  1. atualize o KEYRING removendo a chave antiga');
    console.log('  2. troque DATA_INDEX_KEY_V2 por DATA_INDEX_KEY');
    console.log('  3. DATA_INDEX_LOOKUP_BOTH=false (depois de confirmar)');
  }

  await handle.close();
  process.exit(falhas.length > 0 ? 1 : 0);
}

function prefixTokens(
  email: string,
  idx: BlindIndex,
): { ativos: string[]; antigos: string[] } {
  const max = Math.min(email.length, 32);
  const ativos: string[] = [];
  const antigos: string[] = [];
  for (let len = 3; len <= max; len++) {
    for (const { kid, bidx } of idx.computeAll(email.slice(0, len))) {
      if (kid === idx.activeKid) ativos.push(bidx);
      else antigos.push(bidx);
    }
  }
  return { ativos, antigos };
}

main().catch((err) => {
  console.error('erro na rotacao:', err);
  process.exit(1);
});