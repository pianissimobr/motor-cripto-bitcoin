import { existsSync } from 'node:fs';
import { HDKey } from '@scure/bip32';
import { generateMnemonic, mnemonicToSeedSync } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import * as btc from '@scure/btc-signer';
import { loadConfig } from '../src/config.js';
import {
  hdVersionsForNetwork,
  networkFor,
} from '../src/adapters/hd/derivation.js';
import {
  encryptKeystore,
  writeKeystoreFile,
} from '../src/adapters/signer/keystore.js';
import { loadEnv } from '../src/load-env.js';

loadEnv();

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

async function main(): Promise<void> {
  const config = loadConfig();
  if (!config.signer.passphrase) {
    throw new Error('defina SIGNER_PASSPHRASE antes de gerar a carteira');
  }
  if (existsSync(config.signer.keystorePath) && !hasFlag('--force')) {
    throw new Error(
      `keystore ja existe em ${config.signer.keystorePath}; use --force para sobrescrever`,
    );
  }

  const mnemonic = generateMnemonic(wordlist, 256);
  const seed = mnemonicToSeedSync(mnemonic);
  const versions = hdVersionsForNetwork(config.btc.network);
  const root = HDKey.fromMasterSeed(seed, versions);
  const account = root.derive("m/84'/0'/0'");
  const xprv = account.privateExtendedKey;
  if (!xprv) throw new Error('nao foi possivel derivar o xprv da conta');

  const child = account.derive(`m/${config.btc.derivationPrefix}/0`);
  if (!child.publicKey) throw new Error('nao foi possivel derivar a chave publica');
  const firstAddress = btc.p2wpkh(
    child.publicKey,
    networkFor(config.btc.network),
  ).address;
  if (!firstAddress) throw new Error('nao foi possivel derivar o primeiro endereco');

  const keystore = encryptKeystore(
    {
      xprv,
      accountIndex: 0,
      derivationPrefix: config.btc.derivationPrefix,
      network: config.btc.network,
    },
    config.signer.passphrase,
  );
  writeKeystoreFile(config.signer.keystorePath, keystore);

  console.log('Carteira BIP84 gerada.\n');
  console.log('MNEMONIC (backup offline; NUNCA deixe no servidor):');
  console.log(mnemonic);
  console.log('\nColoque no .env:');
  console.log(`BTC_NETWORK=${config.btc.network}`);
  console.log(`BTC_XPUB=${account.publicExtendedKey}`);
  console.log(`\nPrimeiro endereco de recebimento: ${firstAddress}`);
  console.log(`Keystore cifrado: ${config.signer.keystorePath}`);
  console.log(
    '\nBIP32 fingerprint:',
    account.fingerprint.toString(16).padStart(8, '0'),
  );
  console.log(
    '\nO xprv fica apenas no keystore. Guarde o mnemonic offline e teste a restauracao.',
  );
}

main().catch((err) => {
  console.error('[btc-payments] falha ao gerar carteira:', err);
  process.exit(1);
});
