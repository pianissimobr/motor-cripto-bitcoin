import { withinTolerance } from '../domain/money.js';
import type { LinkStateMachine } from './link-state-machine.js';
import type { Logger } from '../logger.js';
import type { MotorRepositories } from '../ports/index.js';

export type SettlementCycleResult = {
  paginasExpiradas: number;
  liquidados: number;
  naoRealizados: number;
  erros: string[];
};

export type SettlementServiceDeps = {
  repos: MotorRepositories;
  linkState: LinkStateMachine;
  logger: Logger;
  tolerancePct: number;
  now?: () => Date;
};

/**
 * Fecha a janela de liquidacao.
 *
 * A pagina vence em `expiraEm` e vira `expirado`; a verificacao on-chain
 * continua ate `liquidacaoAte`. No fim da janela o link e classificado:
 * valor cheio -> `pago`; sem pagamento ou valor parcial -> `nao_realizado`.
 * Pagamento que chega depois de `liquidacaoAte` e tratado pelo monitor.
 */
export class SettlementService {
  private running = false;

  constructor(private readonly deps: SettlementServiceDeps) {}

  async runCycle(limit = 100): Promise<SettlementCycleResult> {
    const result: SettlementCycleResult = {
      paginasExpiradas: 0,
      liquidados: 0,
      naoRealizados: 0,
      erros: [],
    };
    if (this.running) return result;
    this.running = true;
    try {
      const now = this.now();
      const expirados = await this.deps.repos.links.listExpiredPages(now, limit);
      for (const link of expirados) {
        try {
          await this.deps.linkState.transition({
            linkId: link.id,
            to: 'expirado',
            reason: 'pagina expirada; janela de liquidacao on-chain continua',
            actor: 'settlement',
          });
          result.paginasExpiradas++;
        } catch (err) {
          result.erros.push(`${link.id}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      const vencidos = await this.deps.repos.links.listDueSettlement(now, limit);
      for (const link of vencidos) {
        try {
          const total = await this.deps.repos.payments.sumConfirmedByLink(link.id);
          await this.deps.repos.links.updateSettlement(link.id, {
            valorRecebidoBaseUnits: total,
          });

          const pago =
            total > 0n &&
            (link.expectedBaseUnits === null ||
              link.expectedBaseUnits <= 0n ||
              withinTolerance(link.expectedBaseUnits, total, this.deps.tolerancePct));

          if (pago) {
            await this.deps.linkState.transition({
              linkId: link.id,
              to: 'pago',
              reason: `liquidacao: ${total} ${link.asset} recebidos`,
              actor: 'settlement',
            });
            result.liquidados++;
          } else {
            await this.deps.repos.links.updateSettlement(link.id, {
              motivoNaoRealizado: total > 0n ? 'valor_parcial' : 'nao_pago',
            });
            await this.deps.linkState.transition({
              linkId: link.id,
              to: 'nao_realizado',
              reason:
                total > 0n
                  ? `liquidacao: valor parcial ${total} de ${link.expectedBaseUnits ?? 0n}`
                  : 'liquidacao: nenhum pagamento confirmado',
              actor: 'settlement',
            });
            result.naoRealizados++;
          }
        } catch (err) {
          result.erros.push(`${link.id}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      this.deps.logger.debug(result, 'ciclo de liquidacao concluido');
      return result;
    } finally {
      this.running = false;
    }
  }

  private now(): Date {
    return this.deps.now ? this.deps.now() : new Date();
  }
}
