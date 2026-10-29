import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { BtcNetworkName } from '../../config.js';

const SCRYPT_N = 1 << 15;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 32;
const IV_LEN = 12;
const TAG_LEN = 16;
const AAD = Buffer.from('btc-payments/keystore/v1', 'utf8');

export type KeystoreFile = {
  version: 1;
  kdf: 'scrypt';
  n: number;
  r: number;
  p: number;
  salt: string;
  iv: string;
  tag: string;
  ciphertext: string;
  createdAt: string;
  accountIndex: number;
  derivationPrefix: string;
  network: BtcNetworkName;
};

export type KeystorePayload = {
  xprv: string;
  accountIndex: number;
  derivationPrefix: string;
  network: BtcNetworkName;
};

export class KeystoreError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'KeystoreError';
  }
}

function deriveKey(
  passphrase: string,
  salt: Buffer,
  n: number,
  r: number,
  p: number,
): Buffer {
  return scryptSync(passphrase.normalize('NFKC'), salt, KEY_LEN, {
    N: n,
    r,
    p,
    maxmem: 512 * 1024 * 1024,
  });
}

export function encryptKeystore(
  payload: KeystorePayload,
  passphrase: string,
): KeystoreFile {
  if (!passphrase || passphrase.length < 8) {
    throw new KeystoreError('senha do keystore precisa ter ao menos 8 caracteres');
  }
  const salt = randomBytes(32);
  const iv = randomBytes(IV_LEN);
  const key = deriveKey(passphrase, salt, SCRYPT_N, SCRYPT_R, SCRYPT_P);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(AAD);
  const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    version: 1,
    kdf: 'scrypt',
    n: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    createdAt: new Date().toISOString(),
    accountIndex: payload.accountIndex,
    derivationPrefix: payload.derivationPrefix,
    network: payload.network,
  };
}

export function decryptKeystore(
  file: KeystoreFile,
  passphrase: string,
): KeystorePayload {
  if (file.version !== 1 || file.kdf !== 'scrypt') {
    throw new KeystoreError('formato de keystore nao suportado');
  }
  const salt = Buffer.from(file.salt, 'base64');
  const iv = Buffer.from(file.iv, 'base64');
  const tag = Buffer.from(file.tag, 'base64');
  if (iv.length !== IV_LEN || tag.length !== TAG_LEN) {
    throw new KeystoreError('keystore invalido (iv/tag)');
  }
  const key = deriveKey(passphrase, salt, file.n, file.r, file.p);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(AAD);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(file.ciphertext, 'base64')),
      decipher.final(),
    ]);
    const payload = JSON.parse(plaintext.toString('utf8')) as KeystorePayload;
    if (!payload.xprv || !payload.network) {
      throw new KeystoreError('keystore sem xprv/network');
    }
    return payload;
  } catch (err) {
    if (err instanceof KeystoreError) throw err;
    throw new KeystoreError('falha ao decifrar keystore (senha ou arquivo incorreto)', {
      cause: err,
    });
  }
}

export function readKeystoreFile(path: string): KeystoreFile {
  if (!existsSync(path)) {
    throw new KeystoreError(`keystore nao encontrado: ${path}`);
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as KeystoreFile;
  } catch (err) {
    throw new KeystoreError(`keystore invalido: ${path}`, { cause: err });
  }
}

export function writeKeystoreFile(path: string, file: KeystoreFile): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}
