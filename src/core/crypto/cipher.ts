import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';

/**
 * Envelope encryption AES-256-GCM para dados sensiveis em repouso (PII).
 *
 * Formato binario do blob:
 *   [0]      versao (1)
 *   [1..12]  IV / nonce (12 bytes, unico por registro)
 *   [13..28] auth tag (16 bytes, GCM)
 *   [29..]   ciphertext
 *
 * O AAD (additional authenticated data) e o id do registro: trocar o
 * ciphertext entre linhas quebra a autenticacao do GCM. Isso impede
 * que um ciphertext da tabela A seja copiado para a tabela B.
 */

const VERSION = 1;
const IV_LEN = 12;
const TAG_LEN = 16;
const HEADER_LEN = 1 + IV_LEN + TAG_LEN;

export class DecryptionError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'DecryptionError';
  }
}

export class DataCipher {
  constructor(private readonly key: Buffer) {
    if (key.length !== 32) {
      throw new Error(`DataCipher exige chave de 32 bytes (recebido ${key.length})`);
    }
  }

  /** Cifra `plaintext` vinculando o registro `aad` ao ciphertext. */
  encrypt(plaintext: string, aad: string): Buffer {
    const iv = randomBytes(IV_LEN);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(aad, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([Buffer.from([VERSION]), iv, tag, ciphertext]);
  }

  /** Decifra um blob produced by {@link encrypt}. */
  decrypt(blob: Buffer, aad: string): string {
    if (blob.length < HEADER_LEN) {
      throw new DecryptionError('blob cifrado truncado');
    }
    if (blob[0] !== VERSION) {
      throw new DecryptionError(`versao de cifragem nao suportada: ${blob[0]}`);
    }
    const iv = blob.subarray(1, 1 + IV_LEN);
    const tag = blob.subarray(1 + IV_LEN, HEADER_LEN);
    const ciphertext = blob.subarray(HEADER_LEN);
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
      decipher.setAAD(Buffer.from(aad, 'utf8'));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    } catch (cause) {
      throw new DecryptionError('falha ao decifrar (chave errada ou dado adulterado)', { cause });
    }
  }
}

/**
 * Blind index: HMAC deterministico de um valor, para busca exata
 * sem decifrar e sem que o indice vire um dicionario reversivel.
 */
export class BlindIndex {
  constructor(private readonly key: Buffer) {
    if (key.length !== 32) {
      throw new Error(`BlindIndex exige chave de 32 bytes (recebido ${key.length})`);
    }
  }

  compute(value: string): string {
    return createHmac('sha256', this.key).update(value, 'utf8').digest('hex');
  }
}
