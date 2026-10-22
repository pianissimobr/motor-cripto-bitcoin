import { randomUUID } from 'node:crypto';
import { DataCipher } from '../crypto/cipher.js';
import { maskEmail, maskName, normalizeEmail } from '../crypto/mask.js';
import type { Customer } from '../domain/types.js';
import type { Logger } from '../logger.js';
import type { MotorRepositories, StoredCustomer } from '../ports/index.js';

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
      blindIndex: { compute(value: string): string };
      logger: Logger;
    },
  ) {}

  async create(input: { nome: string; email: string }): Promise<Customer> {
    const nome = input.nome.trim();
    const email = normalizeEmail(input.email);

    if (nome.length < 2) throw new Error('nome muito curto');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('email invalido');
    if (nome.length > 200) throw new Error('nome muito longo');
    if (email.length > 320) throw new Error('email muito longo');

    const id = randomUUID();
    const nomeEnc = this.deps.cipher.encrypt(nome, id);
    const emailEnc = this.deps.cipher.encrypt(email, id);
    const emailBidx = this.deps.blindIndex.compute(email);
    const prefixBidxList = prefixTokens(email, this.deps.blindIndex);

    const stored = await this.deps.repos.customers.create({
      id,
      nomeEnc,
      emailEnc,
      emailBidx,
      nomeMasked: maskName(nome),
      emailMasked: maskEmail(email),
      status: 'ativo',
      prefixBidxList,
    });

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

  async get(id: string): Promise<Customer | null> {
    const stored = await this.deps.repos.customers.findById(id);
    if (!stored) return null;
    return this.toCustomer(stored);
  }

  /** Busca exata por email (blind index do email completo). */
  async findByEmail(email: string): Promise<Customer | null> {
    const bidx = this.deps.blindIndex.compute(normalizeEmail(email));
    const stored = await this.deps.repos.customers.findByEmailBidx(bidx);
    if (!stored) return null;
    return this.toCustomer(stored);
  }

  /** Busca por prefixo de email para o autocomplete da tela de cobranca. */
  async search(emailPrefix: string, limit = 10): Promise<Customer[]> {
    const normalized = normalizeEmail(emailPrefix);
    if (normalized.length < 3) return [];
    const bidx = this.deps.blindIndex.compute(normalized);
    const stored = await this.deps.repos.customers.searchByEmailPrefixBidx(
      bidx,
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
  blindIndex: { compute(value: string): string },
): string[] {
  const max = Math.min(email.length, 32);
  const tokens: string[] = [];
  for (let len = 3; len <= max; len++) {
    tokens.push(blindIndex.compute(email.slice(0, len)));
  }
  return tokens;
}

export { maskEmail, maskName, normalizeEmail };
