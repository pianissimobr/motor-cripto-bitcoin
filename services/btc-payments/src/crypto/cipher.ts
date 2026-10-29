import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

const VERSION = 'v1';
const IV_LEN = 12;
const TAG_LEN = 16;

export class CipherError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'CipherError';
  }
}

function assertKey(key: Buffer, name = 'data key'): void {
  if (!Buffer.isBuffer(key) || key.length !== 32) {
    throw new CipherError(`${name} precisa ter 32 bytes`);
  }
}

/**
 * Cifra um segredo com AES-256-GCM. O AAD amarra o ciphertext ao registro
 * (ex.: id do cliente), impedindo trocar envelopes entre linhas.
 */
export function encryptSecret(
  plaintext: string,
  key: Buffer,
  kid: string,
  aad: string,
): string {
  assertKey(key);
  if (!kid || kid.includes(':')) throw new CipherError('kid invalido');
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    VERSION,
    kid,
    iv.toString('base64'),
    tag.toString('base64'),
    ciphertext.toString('base64'),
  ].join(':');
}

export function decryptSecret(
  envelope: string,
  keyring: Record<string, Buffer>,
  aad: string,
): string {
  const parts = envelope.split(':');
  if (parts.length !== 5 || parts[0] !== VERSION) {
    throw new CipherError('envelope de cifragem invalido');
  }
  const [, kid, ivB64, tagB64, ciphertextB64] = parts;
  const key = keyring[kid!];
  if (!key) throw new CipherError(`kid "${kid}" nao existe no keyring`);
  assertKey(key, `chave ${kid}`);

  const iv = Buffer.from(ivB64!, 'base64');
  const tag = Buffer.from(tagB64!, 'base64');
  if (iv.length !== IV_LEN || tag.length !== TAG_LEN) {
    throw new CipherError('envelope de cifragem invalido');
  }

  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(ciphertextB64!, 'base64')),
      decipher.final(),
    ]);
    return plaintext.toString('utf8');
  } catch (err) {
    throw new CipherError('falha ao decifrar: ciphertext ou AAD nao conferem', {
      cause: err,
    });
  }
}

/** Compara buffers sem vazar tempo por early-return. */
export function constantTimeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
