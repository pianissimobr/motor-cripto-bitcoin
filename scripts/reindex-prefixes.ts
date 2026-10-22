import { loadEnvFile } from '../src/load-env.js';

loadEnvFile();

import { BlindIndex, DataCipher, Keyring } from '../src/core/crypto/cipher.js';
import { createDatabase } from '../src/adapters/db/client.js';
import { createRepositories } from '../src/adapters/db/repositories.js';
import { loadConfig } from '../src/core/config.js';
import { normalizeEmail } from '../src/core/crypto/mask.js';

/**
 * Bloco 4: reconstroi `cadastros_prefixos`.
 *
 * O PK antigo era apenas o token do prefixo. Dois clientes com o mesmo
 * prefixo (ex.: maria@ e marcos@) colidiam e o segundo era descartado por
 * `onConflictDoNothing`, ficando fora do autocomplete. Este script recalcula
 * os tokens a partir do e-mail decifrado e regrava as linhas perdidas.
 *
 * Uso:
 *   npm run reindex:prefixes -- --dry-run
 *   npm run reindex:prefixes
 *
 * Seguro para rodar mais de uma vez; cada cliente tem os prefixos
 * substituidos, nao acumulados.
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

  console.log(`\n=== Reindexacao de prefixos (${dryRun ? 'DRY-RUN' : 'REAL'}) ===`);
  console.log(`chaves de indice: ${blindIndex.kids.join(', ')} (ativa: ${blindIndex.activeKid})`);
  console.log(`lote: ${batchSize}\n`);

  const handle = createDatabase(config.database.url, config.database.ssl);
  const repos = createRepositories(handle.db);

  let cursor: string | null = null;
  let total = 0;
  let regravados = 0;
  const falhas: Array<{ id: string; erro: string }> = [];

  for (;;) {
    const lote = await repos.customers.listAllForRotation(cursor, batchSize);
    if (lote.length === 0) break;
    cursor = lote[lote.length - 1]!.id;
    total += lote.length;

    for (const row of lote) {
      try {
        const email = normalizeEmail(cipher.decrypt(row.emailEnc, row.id));
        const indices = blindIndex.computeAll(email);
        const prefixos = prefixTokens(email, blindIndex);
        const antigos = indices.length > 1 ? prefixos.antigos : prefixos.ativos;
        const ativos = indices.length > 1 ? prefixos.ativos : [];

        if (!dryRun) {
          await repos.customers.replacePrefixes(row.id, antigos, ativos);
        }
        regravados++;
      } catch (err) {
        falhas.push({
          id: row.id,
          erro: err instanceof Error ? err.message : String(err),
        });
      }
    }
    process.stdout.write(`  processados: ${total}\r`);
  }

  console.log(`\n\nCadastros processados: ${total}`);
  console.log(`prefixos regravados:   ${regravados}`);
  console.log(`falhas:                ${falhas.length}`);

  if (falhas.length > 0) {
    console.log('\nPrimeiras falhas:');
    for (const f of falhas.slice(0, 5)) console.log(`  ${f.id}: ${f.erro}`);
    console.log('\nNao remova chaves antigas antes de resolver as falhas.');
  }

  if (dryRun) {
    console.log('\nDry-run: nada foi gravado. Rode sem --dry-run para aplicar.');
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
  console.error('erro na reindexacao:', err);
  process.exit(1);
});
