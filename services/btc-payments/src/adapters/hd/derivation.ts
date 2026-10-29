import { createHash } from 'node:crypto';
import { base58check } from '@scure/base';
import { HDKey } from '@scure/bip32';
import { Address, NETWORK, p2wpkh, TEST_NETWORK } from '@scure/btc-signer';
import type { BtcNetworkName } from '../../config.js';

export type BtcNetwork = {
  bech32: string;
  pubKeyHash: number;
  scriptHash: number;
  wif: number;
};

export const REGTEST_NETWORK: BtcNetwork = {
  bech32: 'bcrt',
  pubKeyHash: 0x6f,
  scriptHash: 0xc4,
  wif: 0xef,
};

const VERSION = {
  xpub: 0x0488b21e,
  ypub: 0x049d7cb2,
  zpub: 0x04b24746,
  tpub: 0x043587cf,
  upub: 0x044a5262,
  vpub: 0x045f1cf6,
} as const;

const MAINNET_VERSIONS = new Set<number>([
  VERSION.xpub,
  VERSION.ypub,
  VERSION.zpub,
]);
const TESTNET_VERSIONS = new Set<number>([
  VERSION.tpub,
  VERSION.upub,
  VERSION.vpub,
]);

const HD_VERSIONS = {
  mainnet: { private: 0x0488ade4, public: VERSION.xpub },
  testnet: { private: 0x04358394, public: VERSION.tpub },
} as const;

export function hdVersionsForNetwork(network: BtcNetworkName): {
  private: number;
  public: number;
} {
  return network === 'bitcoin' ? HD_VERSIONS.mainnet : HD_VERSIONS.testnet;
}

const coder = base58check((data) =>
  createHash('sha256').update(data).digest(),
);

export class HdWalletError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HdWalletError';
  }
}

export function networkFor(name: BtcNetworkName): BtcNetwork {
  if (name === 'bitcoin') return NETWORK;
  if (name === 'testnet') return TEST_NETWORK;
  return REGTEST_NETWORK;
}

type DecodedExtendedKey = {
  raw: Buffer;
  version: number;
  mainnet: boolean;
};

function decodeExtendedKey(value: string): DecodedExtendedKey {
  let raw: Uint8Array;
  try {
    raw = coder.decode(value.trim());
  } catch {
    throw new HdWalletError('xpub invalido: base58check nao decodificou');
  }
  if (raw.length !== 78) {
    throw new HdWalletError(`xpub invalido: ${raw.length} bytes (esperado 78)`);
  }
  const buffer = Buffer.from(raw);
  const version = buffer.readUInt32BE(0);
  const mainnet = MAINNET_VERSIONS.has(version);
  const testnet = TESTNET_VERSIONS.has(version);
  if (!mainnet && !testnet) {
    throw new HdWalletError(
      'xpub invalido: versao nao reconhecida (use xpub/ypub/zpub ou tpub/upub/vpub)',
    );
  }
  return { raw: buffer, version, mainnet };
}

/**
 * Aceita xpub/ypub/zpub/tpub/upub/vpub e normaliza para o formato que o
 * @scure/bip32 entende. O xpub de conta BIP84 fica em `m/84'/0'/0'`.
 */
function normalizeExtendedKey(value: string): {
  normalized: string;
  mainnet: boolean;
} {
  const decoded = decodeExtendedKey(value);
  const targetVersion = decoded.mainnet ? VERSION.xpub : VERSION.tpub;
  if (decoded.version === targetVersion) {
    return { normalized: value.trim(), mainnet: decoded.mainnet };
  }
  const raw = Buffer.from(decoded.raw);
  raw.writeUInt32BE(targetVersion, 0);
  return { normalized: coder.encode(raw), mainnet: decoded.mainnet };
}

export type AccountXpub = {
  /** Chave normalizada (xpub ou tpub). */
  normalized: string;
  /** true = mainnet; false = testnet/regtest. */
  mainnet: boolean;
  /** Fingerprint estavel para detectar troca de xpub no banco. */
  fingerprint: string;
  key: HDKey;
};

export function parseAccountXpub(
  xpub: string,
  expectedNetwork: BtcNetworkName,
): AccountXpub {
  const trimmed = xpub.trim();
  if (trimmed.length === 0) throw new HdWalletError('BTC_XPUB vazio');
  if (/^(xprv|yprv|zprv|tprv|uprv|vprv)/.test(trimmed)) {
    throw new HdWalletError(
      'BTC_XPUB nao pode ser uma chave privada. Use apenas o xpub de conta.',
    );
  }

  const { normalized, mainnet } = normalizeExtendedKey(trimmed);
  const wantsMainnet = expectedNetwork === 'bitcoin';
  if (mainnet !== wantsMainnet) {
    throw new HdWalletError(
      `xpub de ${mainnet ? 'mainnet' : 'testnet/regtest'} nao corresponde a BTC_NETWORK=${expectedNetwork}`,
    );
  }

  let key: HDKey;
  try {
    key = HDKey.fromExtendedKey(
      normalized,
      mainnet ? HD_VERSIONS.mainnet : HD_VERSIONS.testnet,
    );
  } catch (err) {
    throw new HdWalletError(
      `xpub invalido: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (key.privateKey) {
    throw new HdWalletError(
      'BTC_XPUB contem chave privada. O servidor de enderecos so pode ter a chave publica.',
    );
  }
  if (key.depth !== 3) {
    throw new HdWalletError(
      `xpub com depth ${key.depth}. Esperado depth 3 (conta BIP84 m/84'/0'/0'). ` +
        'Nao use o xpub master.',
    );
  }

  return {
    normalized,
    mainnet,
    fingerprint: createHash('sha256').update(normalized).digest('hex').slice(0, 16),
    key,
  };
}

export type DerivedAddress = {
  index: number;
  path: string;
  address: string;
};

export function deriveAddress(
  account: AccountXpub,
  index: number,
  network: BtcNetworkName,
  prefix = '0',
): DerivedAddress {
  if (!Number.isInteger(index) || index < 0) {
    throw new HdWalletError('indice de derivacao deve ser inteiro >= 0');
  }
  if (!/^\d+(\/\d+)*$/.test(prefix)) {
    throw new HdWalletError('prefixo de derivacao deve ser relativo e nao-hardened');
  }
  const path = `m/${prefix}/${index}`;
  const child = account.key.derive(path);
  if (!child.publicKey) {
    throw new HdWalletError('derivacao nao produziu chave publica');
  }
  const payment = p2wpkh(child.publicKey, networkFor(network));
  if (!payment.address) {
    throw new HdWalletError('nao foi possivel gerar o endereco bech32');
  }
  return { index, path, address: payment.address };
}

export function validateAddress(
  address: string,
  network: BtcNetworkName,
): boolean {
  try {
    Address(networkFor(network)).decode(address);
    return true;
  } catch {
    return false;
  }
}

export function assertAddress(address: string, network: BtcNetworkName): void {
  if (!validateAddress(address, network)) {
    throw new HdWalletError(
      `endereco Bitcoin invalido para a rede ${network}: ${address}`,
    );
  }
}
