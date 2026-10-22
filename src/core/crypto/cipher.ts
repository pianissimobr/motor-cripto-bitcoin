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

/**
 * E1: envelope versionado com key id (kid).
 *
 * v1: [version:1][iv:12][tag:16][ciphertext]
 * v2: [version:2][kid-len:1][kid:N][iv:12][tag:16][ciphertext]
 *
 * O `kid` identifica qual chave do keyring cifrou o dado. Sem ele, rotacionar
 * a chave exigiria ler tudo com a chave antiga ANTES de poder escrever com a
 * nova - e qualquer leitura durante a janela de migracao falharia.
 *
 * A leitura aceita v1 e v2: durante a rotacao, parte dos registros ainda
 * estao em v1 e parte ja em v2, e os dois precisam abrir.
 */
const VERSION_V1 = 1;
const VERSION_V2 = 2;
const IV_LEN = 12;
const TAG_LEN = 16;
const V2_HEADER_MIN = 1 + 1 + IV_LEN + TAG_LEN;

export class DecryptionError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'DecryptionError';
  }
}

export class DataCipher {
  private readonly keyring: Keyring;

  /**
   * Aceita um `Keyring` (rotacao) ou uma `Buffer` unica (uso legado,
   * equivalente a um keyring com a chave "k1").
   */
  constructor(keyringOrKey: Keyring | Buffer) {
    this.keyring =
      Buffer.isBuffer(keyringOrKey)
        ? new Keyring({ k1: keyringOrKey }, 'k1')
        : keyringOrKey;
    this.keyring.assertValid();
  }

  /** Construtor explicito com chave e id. */
  static fromSingleKey(key: Buffer, kid = 'k1'): DataCipher {
    return new DataCipher(new Keyring({ [kid]: key }, kid));
  }

  /** Id da chave usada nas novas escritas. */
  get activeKid(): string {
    return this.keyring.activeKid;
  }

  /** Ids disponiveis no keyring. */
  get kids(): string[] {
    return this.keyring.kids;
  }

  /** Cifra `plaintext` vinculando o registro `aad` ao ciphertext (v2). */
  encrypt(plaintext: string, aad: string): Buffer {
    const kid = this.keyring.activeKid;
    const key = this.keyring.get(kid);
    const kidBytes = Buffer.from(kid, 'utf8');
    if (kidBytes.length > 255) throw new Error(`kid longo demais: ${kid}`);

    const iv = randomBytes(IV_LEN);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(aad, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();

    return Buffer.concat([
      Buffer.from([VERSION_V2, kidBytes.length]),
      kidBytes,
      iv,
      tag,
      ciphertext,
    ]);
  }

  /** Decifra um blob v1 ou v2. */
  decrypt(blob: Buffer, aad: string): string {
    if (blob.length < V2_HEADER_MIN) {
      throw new DecryptionError('blob cifrado truncado');
    }
    const version = blob[0];

    if (version === VERSION_V1) {
      // v1 nao tem kid: usa a chave legada (a primeira do keyring).
      const key = this.keyring.legacyKey();
      const iv = blob.subarray(1, 1 + IV_LEN);
      const tag = blob.subarray(1 + IV_LEN, 1 + IV_LEN + TAG_LEN);
      const ciphertext = blob.subarray(1 + IV_LEN + TAG_LEN);
      return this.decryptWith(key, iv, tag, ciphertext, aad);
    }

    if (version === VERSION_V2) {
      const kidLen = blob[1]!;
      const kid = blob.subarray(2, 2 + kidLen).toString('utf8');
      if (!kid) throw new DecryptionError('envelope v2 sem kid');
      const offset = 2 + kidLen;
      const iv = blob.subarray(offset, offset + IV_LEN);
      const tag = blob.subarray(offset + IV_LEN, offset + IV_LEN + TAG_LEN);
      const ciphertext = blob.subarray(offset + IV_LEN + TAG_LEN);
      if (!this.keyring.has(kid)) {
        throw new DecryptionError(
          `chave "${kid}" ausente do keyring (disponiveis: ${this.keyring.kids.join(', ')})`,
        );
      }
      return this.decryptWith(this.keyring.get(kid), iv, tag, ciphertext, aad);
    }

    throw new DecryptionError(`versao de cifragem nao suportada: ${version}`);
  }

  /** Qual kid cifrou este blob? Base para o relatorio de rotacao. */
  kidOf(blob: Buffer): string | null {
    if (blob[0] === VERSION_V2) {
      const kidLen = blob[1]!;
      return blob.subarray(2, 2 + kidLen).toString('utf8');
    }
    if (blob[0] === VERSION_V1) return 'v1-sem-kid';
    return null;
  }

  private decryptWith(
    key: Buffer,
    iv: Buffer,
    tag: Buffer,
    ciphertext: Buffer,
    aad: string,
  ): string {
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAAD(Buffer.from(aad, 'utf8'));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    } catch (cause) {
      throw new DecryptionError('falha ao decifrar (chave errada ou dado adulterado)', { cause });
    }
  }
}

/**
 * E2: conjunto de chaves de cifragem com uma chave ativa.
 *
 * Varias chaves coexistem durante a rotacao: as antigas ainda abrem os
 * registros antigos, a nova cifra os novos. Chave ausente = erro explicito,
 * nunca fallback silencioso (fallback seria escribir com a chave errada).
 */
export class Keyring {
  private readonly keys: Map<string, Buffer>;
  readonly activeKid: string;
  /** Kid da chave que cifrava os envelopes v1 (sem kid no cabecalho). */
  readonly legacyKid: string;

  constructor(keys: Record<string, Buffer>, activeKid: string, legacyKid?: string) {
    this.keys = new Map(Object.entries(keys).map(([k, v]) => [k, v]));
    this.activeKid = activeKid;
    const primeira = Object.keys(keys)[0];
    this.legacyKid = legacyKid ?? activeKid ?? primeira ?? '';
  }

  assertValid(): void {
    if (this.keys.size === 0) throw new Error('keyring vazio: nenhuma chave de cifragem');
    for (const [kid, key] of this.keys) {
      if (key.length !== 32) {
        throw new Error(`chave "${kid}" deve ter 32 bytes (recebido ${key.length})`);
      }
    }
    if (!this.keys.has(this.activeKid)) {
      throw new Error(`DATA_ACTIVE_KID="${this.activeKid}" nao existe no keyring`);
    }
    if (!this.keys.has(this.legacyKid)) {
      throw new Error(`chave legada "${this.legacyKid}" nao existe no keyring`);
    }
  }

  has(kid: string): boolean {
    return this.keys.has(kid);
  }

  get(kid: string): Buffer {
    const key = this.keys.get(kid);
    if (!key) throw new DecryptionError(`chave "${kid}" ausente do keyring`);
    return key;
  }

  /** Chave para abrir envelopes v1 (que nao guardam kid). */
  legacyKey(): Buffer {
    return this.get(this.legacyKid);
  }

  get kids(): string[] {
    return [...this.keys.keys()];
  }
}

/**
 * Blind index: HMAC deterministico de um valor, para busca exata
 * sem decifrar e sem que o indice vire um dicionao reversivel.
 *
 * E3: durante a rotacao existem duas chaves. As escritas novas usam a
 * chave ativa; a busca consulta as duas, senao os cadastros anteriores
 * a rotacao ficariam invisiveis para a busca por email.
 */
export class BlindIndex {
  private readonly keys: Map<string, Buffer>;
  readonly activeKid: string;

  constructor(key: Buffer, activeKid = 'k1') {
    if (key.length !== 32) {
      throw new Error(`BlindIndex exige chave de 32 bytes (recebido ${key.length})`);
    }
    this.keys = new Map([[activeKid, key]]);
    this.activeKid = activeKid;
  }

  /** Construtor de rotacao: chave ativa + chave antiga (consulta). */
  static rotating(activeKey: Buffer, activeKid: string, oldKey: Buffer, oldKid: string): BlindIndex {
    if (oldKey.length !== 32) {
      throw new Error(`BlindIndex exige chave de 32 bytes (recebido ${oldKey.length})`);
    }
    const index = new BlindIndex(activeKey, activeKid);
    index.keys.set(oldKid, oldKey);
    return index;
  }

  /** Calcula o indice com a chave ATIVA (usado em escritas novas). */
  compute(value: string): string {
    return this.hashWith(this.activeKid, value);
  }

  /** Todos os indices possiveis para o valor (consulta na transicao). */
  computeAll(value: string): Array<{ kid: string; bidx: string }> {
    return [...this.keys.keys()].map((kid) => ({
      kid,
      bidx: this.hashWith(kid, value),
    }));
  }

  get kids(): string[] {
    return [...this.keys.keys()];
  }

  hashWith(kid: string, value: string): string {
    const key = this.keys.get(kid);
    if (!key) throw new Error(`chave de blind index "${kid}" ausente`);
    return createHmac('sha256', key).update(value, 'utf8').digest('hex');
  }
}
