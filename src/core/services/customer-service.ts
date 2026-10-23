import { randomUUID } from 'node:crypto';
import { BlindIndex, DataCipher } from '../crypto/cipher.js';
import { maskEmail, maskName, normalizeEmail } from '../crypto/mask.js';
import type { Customer } from '../domain/types.js';
import type { Logger } from '../logger.js';
import type { MotorRepositories, StoredCustomer } from '../ports/index.js';
import { ConflictError, NotFoundError, ValidationError, isUniqueViolation } from '../domain/errors.js';

/** E-mail ja existente: a borda HTTP mapeia `statusCode` para 409. */
export class DuplicateCustomerEmailError extends ConflictError {
  constructor() {
    super('email ja cadastrado', 'email_duplicado');
  }
}

/**
 * Servico de cadastro de clientes.
 *
 * Nome e email sao cifrados em repouso (AES-256-GCM, AAD = id do registro).
 * A busca por email usa blind index (HMAC-SHA256), que nao e reversivel.
 *
 * Busca por prefixo: como HMAC nao preserva prefixo, geramos um token de
 * blind index para cada prefixo do email (3..32 chars) em uma tabela
 * separada. Isso permite autocomplete sem guardar o email em claro.
 * Trade-off conhecido (documentado): o tamanho do email e a frequencia de
 * prefixos ficam expostos no indice.
 */
export class CustomerService {
  constructor(
    private readonly deps: {
      repos: MotorRepositories;
      cipher: DataCipher;
      blindIndex: BlindIndex;
      logger: Logger;
    },
  ) {}

  async create(input: { nome: string; email: string }): Promise<Customer> {
    const nome = input.nome.trim();
    const email = normalizeEmail(input.email);

    if (nome.length < 2) throw new ValidationError('nome muito curto');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new ValidationError('email invalido');
    }
    if (nome.length > 200) throw new ValidationError('nome muito longo');
    if (email.length > 320) throw new ValidationError('email muito longo');

    const id = randomUUID();
    const nomeEnc = this.deps.cipher.encrypt(nome, id);
    const emailEnc = this.deps.cipher.encrypt(email, id);

    // E3: escreve com a chave ativa e, se houver chave anterior em
    // rotacao, tambem no indice antigo (para a busca continuar valendo).
    const indices = this.deps.blindIndex.computeAll(email);
    const ativo = this.deps.blindIndex.activeKid;
    const emailBidxAtivo = indices.find((i) => i.kid === ativo)?.bidx ?? indices[0]!.bidx;
    const emailBidxAntigo =
      indices.length > 1 ? (indices.find((i) => i.kid !== ativo)?.bidx ?? null) : null;
    const prefixos = prefixTokens(email, this.deps.blindIndex);

    // Bloco 4: o unique e garantido no banco pela coluna canonica, mas a
    // checagem aqui evita erro de driver no caminho comum. O catch abaixo
    // cobre a corrida entre dois cadastros simultaneos.
    const existente = await this.deps.repos.customers.findByEmailBidx(
      indices.map((i) => i.bidx),
    );
    if (existente) throw new DuplicateCustomerEmailError();

    let stored: StoredCustomer;
    try {
      stored = await this.deps.repos.customers.create({
        id,
        nomeEnc,
        emailEnc,
        // Bloco 4: o indice ATIVO e sempre o canonico (unique no banco).
        emailBidx: emailBidxAtivo,
        emailBidxAnterior: emailBidxAntigo,
        nomeMasked: maskName(nome),
        emailMasked: maskEmail(email),
        status: 'ativo',
        prefixBidxList: indices.length > 1 ? prefixos.antigos : prefixos.ativos,
        prefixBidxListV2: indices.length > 1 ? prefixos.ativos : [],
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw new DuplicateCustomerEmailError();
      throw err;
    }

    await this.deps.repos.audit.record({
      ator: 'sistema',
      acao: 'cadastro.criado',
      entidade: 'cadastro',
      entidadeId: stored.id,
      detalhes: { emailMasked: stored.emailMasked },
    });

    this.deps.logger.info({ customerId: stored.id }, 'cliente cadastrado');
    return this.toCustomer(stored, nome, email);
  }

  /** Atualiza nome e/ou e-mail cifrados da própria conta. */
  async updateContact(
    id: string,
    input: { nome?: string; email?: string },
  ): Promise<Customer> {
    const stored = await this.deps.repos.customers.findById(id);
    if (!stored) throw new NotFoundError('Usuário não encontrado');

    const nomeAtual = this.deps.cipher.decrypt(stored.nomeEnc, id);
    const emailAtual = this.deps.cipher.decrypt(stored.emailEnc, id);
    const nome = input.nome !== undefined ? input.nome.trim() : nomeAtual;
    const email = input.email !== undefined ? normalizeEmail(input.email) : emailAtual;

    if (nome.length < 2) throw new ValidationError('nome muito curto');
    if (nome.length > 200) throw new ValidationError('nome muito longo');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new ValidationError('email invalido');
    }
    if (email.length > 320) throw new ValidationError('email muito longo');

    const indices = this.deps.blindIndex.computeAll(email);
    const ativo = this.deps.blindIndex.activeKid;
    const emailBidxAtivo = indices.find((i) => i.kid === ativo)?.bidx ?? indices[0]!.bidx;
    const emailBidxAntigo =
      indices.length > 1 ? (indices.find((i) => i.kid !== ativo)?.bidx ?? null) : null;
    if (email !== emailAtual) {
      const outro = await this.deps.repos.customers.findByEmailBidx(indices.map((i) => i.bidx));
      if (outro && outro.id !== id) throw new DuplicateCustomerEmailError();
    }
    const prefixos = prefixTokens(email, this.deps.blindIndex);
    await this.deps.repos.customers.updateEncrypted(
      id,
      this.deps.cipher.encrypt(nome, id),
      this.deps.cipher.encrypt(email, id),
      emailBidxAtivo,
      emailBidxAntigo,
      indices.length > 1 ? prefixos.antigos : prefixos.ativos,
      indices.length > 1 ? prefixos.ativos : [],
    );
    await this.deps.repos.customers.updateMasks(id, maskName(nome), maskEmail(email));
    const atualizado = await this.deps.repos.customers.findById(id);
    if (!atualizado) throw new NotFoundError('Usuário não encontrado');
    return this.toCustomer(atualizado, nome, email);
  }

  async get(id: string): Promise<Customer | null> {
    const stored = await this.deps.repos.customers.findById(id);
    if (!stored) return null;
    return this.toCustomer(stored);
  }

  /** Busca exata por email (blind index do email completo). */
  async findByEmail(email: string): Promise<Customer | null> {
    const bidxes = this.deps.blindIndex
      .computeAll(normalizeEmail(email))
      .map((i) => i.bidx);
    const stored = await this.deps.repos.customers.findByEmailBidx(bidxes);
    if (!stored) return null;
    return this.toCustomer(stored);
  }

  /** Busca por prefixo de email para o autocomplete da tela de cobranca. */
  async search(emailPrefix: string, limit = 10): Promise<Customer[]> {
    const normalized = normalizeEmail(emailPrefix);
    if (normalized.length < 3) return [];
    const bidxes = this.deps.blindIndex.computeAll(normalized).map((i) => i.bidx);
    const stored = await this.deps.repos.customers.searchByEmailPrefixBidx(
      bidxes,
      Math.min(limit, 50),
    );
    return stored.map((s) => this.toCustomer(s));
  }

  async list(limit = 50, offset = 0): Promise<Customer[]> {
    const stored = await this.deps.repos.customers.list(
      Math.min(limit, 200),
      Math.max(offset, 0),
    );
    return stored.map((s) => this.toCustomer(s));
  }

  async count(): Promise<number> {
    return this.deps.repos.customers.count();
  }

  /** Decifra nome/email quando o registro ainda esta em memoria (pos-criacao). */
  private toCustomer(stored: StoredCustomer, nome?: string, email?: string): Customer {
    let finalNome = nome;
    let finalEmail = email;
    if (finalNome === undefined || finalEmail === undefined) {
      try {
        finalNome = this.deps.cipher.decrypt(stored.nomeEnc, stored.id);
        finalEmail = this.deps.cipher.decrypt(stored.emailEnc, stored.id);
      } catch {
        // dado ilegivel (chave trocada): devolve apenas as mascaras
        finalNome = finalNome ?? stored.nomeMasked;
        finalEmail = finalEmail ?? stored.emailMasked;
      }
    }
    return {
      id: stored.id,
      nome: finalNome,
      email: finalEmail,
      emailMasked: stored.emailMasked,
      nomeMasked: stored.nomeMasked,
      status: stored.status,
      criadoEm: stored.criadoEm,
    };
  }
}

/** Blind indexes dos prefixos do email (3..32 caracteres). */
function prefixTokens(
  email: string,
  blindIndex: { computeAll(value: string): Array<{ kid: string; bidx: string }>; activeKid: string },
): { ativos: string[]; antigos: string[] } {
  const max = Math.min(email.length, 32);
  const ativos: string[] = [];
  const antigos: string[] = [];
  for (let len = 3; len <= max; len++) {
    for (const { kid, bidx } of blindIndex.computeAll(email.slice(0, len))) {
      if (kid === blindIndex.activeKid) ativos.push(bidx);
      else antigos.push(bidx);
    }
  }
  return { ativos, antigos };
}

export { maskEmail, maskName, normalizeEmail };
