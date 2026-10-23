import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { hashPassword, verifyPassword } from '../crypto/password.js';
import { fiatToCents } from '../domain/money.js';
import {
  ConflictError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
  isUniqueViolation,
} from '../domain/errors.js';
import type { Customer } from '../domain/types.js';
import type { CustomerService } from './customer-service.js';
import type { LinkService } from './link-service.js';
import type { MotorRepositories } from '../ports/index.js';

const SESSAO_HORAS = 12;
const BLOQUEIA_EXCLUSAO = new Set(['aguardando', 'pago', 'parcial', 'pago_sem_gas']);

function normalizarUsuario(valor: string): string {
  return valor.trim().toLowerCase();
}

function validarUsuario(usuario: string): void {
  if (!/^[a-z0-9._-]{3,32}$/.test(usuario)) {
    throw new ValidationError('usuário deve ter 3 a 32 caracteres: letras, números, ponto, _ ou -');
  }
}

function validarSenha(senha: string): void {
  if (senha.length < 8 || senha.length > 200) {
    throw new ValidationError('senha deve ter pelo menos 8 caracteres');
  }
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Conta do cliente final. Não usa o token de administração da loja.
 */
export class AccountService {
  constructor(
    private readonly deps: {
      repos: MotorRepositories;
      customers: CustomerService;
      links: LinkService;
    },
  ) {}

  async registrar(input: {
    nome: string;
    email: string;
    usuario: string;
    senha: string;
  }): Promise<Customer> {
    const usuario = normalizarUsuario(input.usuario);
    validarUsuario(usuario);
    validarSenha(input.senha);
    if (await this.deps.repos.accounts.findByUsuario(usuario)) {
      throw new ConflictError('Este usuário já está cadastrado', 'usuario_duplicado');
    }
    const customer = await this.deps.customers.create({ nome: input.nome, email: input.email });
    try {
      await this.deps.repos.accounts.create({
        clienteId: customer.id,
        usuario,
        senhaHash: hashPassword(input.senha),
      });
    } catch (err) {
      await this.deps.repos.accounts.deleteCustomer(customer.id).catch(() => undefined);
      if (isUniqueViolation(err)) {
        throw new ConflictError('Este usuário já está cadastrado', 'usuario_duplicado');
      }
      throw err;
    }
    return customer;
  }

  async entrar(identificador: string, senha: string): Promise<{ token: string; customer: Customer }> {
    const bruto = identificador.trim();
    if (!bruto || !senha) throw new ValidationError('informe usuário e senha');

    const customer = bruto.includes('@')
      ? await this.deps.customers.findByEmail(bruto)
      : await this.porUsuario(normalizarUsuario(bruto));
    if (!customer) throw new NotFoundError('Usuário não encontrado');

    const conta = await this.deps.repos.accounts.findByClienteId(customer.id);
    if (!conta) throw new NotFoundError('Usuário não encontrado');
    if (!verifyPassword(senha, conta.senhaHash)) {
      throw new UnauthorizedError('Sua senha está errada');
    }

    const token = randomBytes(32).toString('hex');
    await this.deps.repos.accounts.createSession({
      id: randomUUID(),
      tokenHash: tokenHash(token),
      clienteId: customer.id,
      expiraEm: new Date(Date.now() + SESSAO_HORAS * 3600_000),
    });
    return { token, customer };
  }

  async sair(token: string): Promise<void> {
    await this.deps.repos.accounts.deleteSession(tokenHash(token));
  }

  async quem(token: string): Promise<{ customer: Customer; usuario: string }> {
    const clienteId = await this.clienteDaSessao(token);
    const customer = await this.deps.customers.get(clienteId);
    const conta = await this.deps.repos.accounts.findByClienteId(clienteId);
    if (!customer || !conta) throw new UnauthorizedError('sessão inválida');
    return { customer, usuario: conta.usuario };
  }

  async atualizar(
    token: string,
    input: { nome?: string; email?: string; usuario?: string; senha?: string },
  ): Promise<{ customer: Customer; usuario: string }> {
    const clienteId = await this.clienteDaSessao(token);
    if (input.nome !== undefined || input.email !== undefined) {
      await this.deps.customers.updateContact(clienteId, {
        nome: input.nome,
        email: input.email,
      });
    }
    const patch: { usuario?: string; senhaHash?: string } = {};
    if (input.usuario !== undefined) {
      const usuario = normalizarUsuario(input.usuario);
      validarUsuario(usuario);
      const outro = await this.deps.repos.accounts.findByUsuario(usuario);
      if (outro && outro.clienteId !== clienteId) {
        throw new ConflictError('Este usuário já está cadastrado', 'usuario_duplicado');
      }
      patch.usuario = usuario;
    }
    if (input.senha !== undefined) {
      validarSenha(input.senha);
      patch.senhaHash = hashPassword(input.senha);
    }
    if (patch.usuario || patch.senhaHash) {
      await this.deps.repos.accounts.update(clienteId, patch);
    }
    return this.quem(token);
  }

  async cobrar(token: string, valor: string | number): Promise<{ rampUrl: string; id: string }> {
    const { customer } = await this.quem(token);
    const amountCents = fiatToCents(valor);
    const perfis = await this.deps.repos.rampProfiles.list();
    const perfil = perfis[0];
    if (!perfil) throw new ValidationError('a loja ainda não configurou um perfil de cobrança');
    const carteiras = await this.deps.repos.coldWallets.list();
    const fria = carteiras.find((c) => c.chain.toLowerCase() === perfil.chain.toLowerCase());
    if (!fria) throw new ValidationError('a loja ainda não configurou a carteira de destino');
    const link = await this.deps.links.create({
      clienteId: customer.id,
      amountCents,
      rampProfileId: perfil.id,
      coldWalletId: fria.id,
      actor: 'cliente',
    });
    return { rampUrl: link.rampUrl, id: link.id };
  }

  async excluir(token: string): Promise<void> {
    const clienteId = await this.clienteDaSessao(token);
    const links = await this.deps.repos.links.listByCustomer(clienteId);
    const aberta = links.find((link) => BLOQUEIA_EXCLUSAO.has(link.status));
    if (aberta) {
      throw new ConflictError(
        'Não dá para excluir a conta enquanto existe uma cobrança em andamento',
        'conta_com_cobranca',
      );
    }
    await this.deps.repos.accounts.deleteCustomer(clienteId);
  }

  private async porUsuario(usuario: string): Promise<Customer | null> {
    const conta = await this.deps.repos.accounts.findByUsuario(usuario);
    if (!conta) return null;
    return this.deps.customers.get(conta.clienteId);
  }

  private async clienteDaSessao(token: string): Promise<string> {
    if (!token) throw new UnauthorizedError('sessão ausente');
    const sessao = await this.deps.repos.accounts.findSession(tokenHash(token));
    if (!sessao || sessao.expiraEm.getTime() <= Date.now()) {
      throw new UnauthorizedError('sessão inválida');
    }
    return sessao.clienteId;
  }
}
