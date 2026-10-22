import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Keystore cifrado do xprv de conta.
 *
 * O xprv NUNCA fica em texto puro no disco: e cifrado com AES-256-GCM usando
 * uma chave derivada por scrypt a partir da senha (que vem do secret manager).
 * O arquivo e criado com permissao 0600.
 */

const SCRYPT_N = 1 << 15;
const SCRYPT_r = 8;
const SCRYPT_p = 1;
const KEY_LEN = 32;
const IV_LEN = 12;
const TAG_LEN = 16;

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
};

export type KeystorePayload = {
  xprv: string;
  accountIndex: number;
  derivationPrefix: string;
};

export class KeystoreError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'KeystoreError';
  }
}

function deriveKey(passphrase: string, salt: Buffer, n: number, r: number, p: number): Buffer {
  return scryptSync(passphrase.normalize('NFKC'), salt, KEY_LEN, { N: n, r, p, maxmem: 512 * 1024 * 1024 });
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
  const key = deriveKey(passphrase, salt, SCRYPT_N, SCRYPT_r, SCRYPT_p);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from('motor-cripto/keystore/v1', 'utf8'));
  const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    version: 1,
    kdf: 'scrypt',
    n: SCRYPT_N,
    r: SCRYPT_r,
    p: SCRYPT_p,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    createdAt: new Date().toISOString(),
    accountIndex: payload.accountIndex,
    derivationPrefix: payload.derivationPrefix,
  };
}

export function decryptKeystore(file: KeystoreFile, passphrase: string): KeystorePayload {
  if (file.version !== 1) throw new KeystoreError(`versao de keystore nao suportada: ${file.version}`);
  const salt = Buffer.from(file.salt, 'base64');
  const iv = Buffer.from(file.iv, 'base64');
  const tag = Buffer.from(file.tag, 'base64');
  const ciphertext = Buffer.from(file.ciphertext, 'base64');
  const key = deriveKey(passphrase, salt, file.n, file.r, file.p);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(Buffer.from('motor-cripto/keystore/v1', 'utf8'));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return JSON.parse(plaintext.toString('utf8')) as KeystorePayload;
  } catch (cause) {
    throw new KeystoreError('senha incorreta ou keystore corrompido', { cause });
  }
}

export function writeKeystoreFile(path: string, file: KeystoreFile): void {
  if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

export function readKeystoreFile(path: string): KeystoreFile {
  if (!existsSync(path)) {
    throw new KeystoreError(`keystore nao encontrado em ${path}. Rode: npm run wallet:init`);
  }
  const raw = readFileSync(path, 'utf8');
  try {
    return JSON.parse(raw) as KeystoreFile;
  } catch (cause) {
    throw new KeystoreError(`keystore ilegivel em ${path}`, { cause });
  }
}

/** Comparacao em tempo constante de dois tokens (admin token, tokens de API). */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    // Ainda assim faz uma comparacao para nao vazar o tamanho por tempo.
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}
