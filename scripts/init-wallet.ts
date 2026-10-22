import { randomBytes } from 'node:crypto';
import { HDNodeWallet, Mnemonic } from 'ethers';
import { loadEnvFile } from '../src/load-env.js';
import {
  encryptKeystore,
  writeKeystoreFile,
  type KeystorePayload,
} from '../src/core/hd/keystore.js';

/**
 * Gera a HD Wallet do motor.
 *
 *   1. cria um mnemonic novo (256 bits)
 *   2. deriva o no de CONTA m/44'/60'/0'
 *   3. guarda o xprv da conta em um keystore CIFRADO (scrypt + AES-256-GCM)
 *   4. imprime o XPUB DE CONTA (e o que o servidor usa para derivar enderecos)
 *
 * O xpub de conta e o que vai no .env (HD_XPUB). A seed aparece UMA vez:
 * faca o backup offline AGORA. Perder a seed = perder o acesso aos fundos
 * que forem enviados para os enderecos derivados.
 *
 * Uso:
 *   npm run wallet:init -- --passphrase <senha> [--path ./data/keystore.json] \
 *     [--account-index 0] [--prefix 0] [--show-seed]
 */

function arg(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0 && index + 1 < process.argv.length) return process.argv[index + 1];
  if (fallback !== undefined) return fallback;
  const envName = `WALLET_INIT_${name.toUpperCase().replace(/-/g, '_')}`;
  return process.env[envName] ?? fallback;
}

const hasFlag = (name: string): boolean => process.argv.includes(`--${name}`);

loadEnvFile();

const passphrase = arg('passphrase') ?? process.env.SIGNER_PASSPHRASE;
if (!passphrase || passphrase.length < 8) {
  console.error(
    '\nInforme a senha do keystore:\n  npm run wallet:init -- --passphrase "sua-senha-forte"\n',
  );
  process.exit(1);
}

const keystorePath = arg('path', './data/keystore.json')!;
const accountIndex = Number(arg('account-index', '0') ?? 0);
const derivationPrefix = arg('prefix', '0')!;

if (!Number.isInteger(accountIndex) || accountIndex < 0) {
  console.error(`\n--account-index invalido: "${arg('account-index')}" (use inteiro >= 0)\n`);
  process.exit(1);
}

const mnemonic = Mnemonic.fromEntropy(randomBytes(32));
const accountPath = `m/44'/60'/${accountIndex}'`;
const accountNode = HDNodeWallet.fromMnemonic(mnemonic, accountPath);
const xpub = accountNode.neuter().extendedKey;
const xprv = accountNode.extendedKey;

const payload: KeystorePayload = { xprv, accountIndex, derivationPrefix };
const keystore = encryptKeystore(payload, passphrase);
writeKeystoreFile(keystorePath, keystore);

console.log('\n=== HD Wallet criada ===');
console.log(`Conta (m/44'/60'/${accountIndex}'): ${accountNode.address}`);
console.log(`\nHD_XPUB (cole no .env):\n${xpub}`);
console.log(`\nKeystore cifrado: ${keystorePath} (permissao 0600)`);
console.log(`Prefixo de derivacao: "${derivationPrefix}"  =>  m/44'/60'/${accountIndex}'/${derivationPrefix}/{index}`);
console.log(`\nComece a derivar em: HD_XPUB=<xpub acima>`);

if (hasFlag('show-seed')) {
  console.log('\n============================================');
  console.log('  SEED (MNEMONIC) - EXIBIDA UMA UNICA VEZ');
  console.log('  Anote e guarde OFFLINE. NUNCA commite.');
  console.log('============================================');
  console.log(mnemonic.phrase);
  console.log('============================================\n');
} else {
  console.log(
    '\nA seed NAO foi exibida. Se voce perder o keystore e a senha, os fundos\n' +
      'recebidos pelos enderecos derivados sao irrecuperaveis.\n' +
      'Para exibir a seed de uma carteira ja criada, nao ha como: guarde-a no\n' +
      'momento da criacao (use --show-seed em um ambiente seguro).\n',
  );
}
