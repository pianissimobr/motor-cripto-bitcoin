import { NotFoundError } from '../domain/errors.js';
import { assertTransition, IllegalTransitionError } from '../domain/link-state.js';
import type { LinkStatus, PaymentLink } from '../domain/types.js';
import type { Logger } from '../logger.js';
import type { MotorRepositories } from '../ports/index.js';

/**
 * Unico caminho para mudar o status de um link.
 *
 * Valida a transicao contra a tabela do dominio, persiste, audita e avisa o
 * callback de webhook (quando configurado). O repositorio continua burro.
 */
export type TransitionInput = {
  linkId: string;
  to: LinkStatus;
  /** Motivo: vira o registro de auditoria. */
  reason: string;
  actor?: string;
  ip?: string | null;
  /** Permite reentrar na mesma situacao (idempotente). */
  allowSame?: boolean;
};

export type TransitionHook = (link: PaymentLink, to: LinkStatus) => Promise<void>;

export class LinkStateMachine {
  constructor(
    private readonly deps: {
      repos: MotorRepositories;
      logger: Logger;
      onTransition?: TransitionHook;
    },
  ) {}

  async transition(input: TransitionInput): Promise<LinkStatus> {
    const link = await this.deps.repos.links.findById(input.linkId);
    if (!link) throw new NotFoundError(`link nao encontrado: ${input.linkId}`);

    if (link.status === input.to) {
      if (input.allowSame !== false) return link.status;
    }

    assertTransition(link.status, input.to);

    await this.deps.repos.links.updateStatus(input.linkId, input.to);
    await this.deps.repos.audit.record({
      ator: input.actor ?? 'motor',
      acao: 'link.status_mudou',
      entidade: 'link',
      entidadeId: input.linkId,
      detalhes: { de: link.status, para: input.to, motivo: input.reason },
      ip: input.ip ?? null,
    });

    this.deps.logger.info(
      { linkId: input.linkId, de: link.status, para: input.to, motivo: input.reason },
      'status do link alterado',
    );

    if (this.deps.onTransition) {
      await this.deps.onTransition({ ...link, status: input.to }, input.to);
    }
    return input.to;
  }

  /** Checagem sem efeito colateral (usada em testes e no monitor). */
  async canMove(linkId: string, to: LinkStatus): Promise<boolean> {
    const link = await this.deps.repos.links.findById(linkId);
    if (!link) return false;
    if (link.status === to) return true;
    try {
      assertTransition(link.status, to);
      return true;
    } catch (err) {
      if (err instanceof IllegalTransitionError) return false;
      throw err;
    }
  }
}
