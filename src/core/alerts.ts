import type { Logger } from './logger.js';
import type { MotorRepositories } from './ports/index.js';

/**
 * F2: alertas operacionais.
 *
 * Reune num so lugar tudo que exige acao humana. O worker e a API tratam
 * esses estados, mas sem uma visao unica o operador so descobre olhando
 * os logs - ou, pior, quando o cliente reclama.
 *
 * Cada alerta traz o link/cliente afetado para agir direto.
 */

export type AlertaNivel = 'critico' | 'atencao' | 'info';

export type Alerta = {
  nivel: AlertaNivel;
  codigo: string;
  titulo: string;
  descricao: string;
  linkId?: string;
  clienteId?: string;
  /** Contexto extra para o operador (nunca PII em claro). */
  detalhe?: Record<string, unknown>;
};

export type AlertsDeps = {
  repos: MotorRepositories;
  logger: Logger;
  /** Saldo minimo do patrocinador de gas, em wei. */
  gasSponsorMinBalanceWei: bigint;
  gasSponsorConfigured: boolean;
};

export async function collectAlerts(deps: AlertsDeps): Promise<Alerta[]> {
  const { repos, logger } = deps;
  const alertas: Alerta[] = [];

  /* ---------------------------------------------------------------- */
  /* Pagamento parcial: o valor nao bate com o esperado               */
  /* ---------------------------------------------------------------- */
  const parciais = await repos.links.listByStatus('parcial', 50);
  for (const link of parciais) {
    const total = await repos.payments.sumConfirmedByLink(link.id);
    alertas.push({
      nivel: 'atencao',
      codigo: 'pagamento_parcial',
      titulo: 'Pagamento divergente do valor cobrado',
      descricao:
        'O valor recebido esta fora da tolerancia. Revise se credita o valor ' +
        'recebido (padrao do motor) ou se exige o restante.',
      linkId: link.id,
      clienteId: link.clienteId,
      detalhe: {
        asset: link.asset,
        esperadoBaseUnits: link.expectedBaseUnits?.toString() ?? null,
        recebidoBaseUnits: total.toString(),
        enderecoDeposito: link.enderecoDeposito,
      },
    });
  }

  /* ---------------------------------------------------------------- */
  /* Sem gas: dinheiro recebido e preso por falta de gas              */
  /* ---------------------------------------------------------------- */
  const semGas = await repos.links.listByStatus('pago_sem_gas', 50);
  for (const link of semGas) {
    const temPatrocinador = deps.gasSponsorConfigured;
    alertas.push({
      nivel: 'critico',
      codigo: 'pagamento_sem_gas',
      titulo: 'Valor recebido preso: falta gas para mover',
      descricao: temPatrocinador
        ? 'O patrocinador de gas pode estar sem saldo. Recarregue-o.'
        : 'Configure GAS_SPONSOR_PRIVATE_KEY para o motor poder mover o valor.',
      linkId: link.id,
      clienteId: link.clienteId,
      detalhe: {
        asset: link.asset,
        enderecoDeposito: link.enderecoDeposito,
        patrocinadorConfigurado: temPatrocinador,
      },
    });
  }

  /* ---------------------------------------------------------------- */
  /* Link expirado sem pagamento: a taxa da Ramp pode ter sido cobrada */
  /* ---------------------------------------------------------------- */
  const expirados = await repos.links.listByStatus('expirado', 100);
  for (const link of expirados) {
    const total = await repos.payments.sumConfirmedByLink(link.id);
    if (total === 0n) {
      alertas.push({
        nivel: 'info',
        codigo: 'link_expirado_sem_pagamento',
        titulo: 'Link expirado sem nenhum pagamento',
        descricao: 'O cliente abriu mas nao concluiu. Confira a taxa da Ramp.',
        linkId: link.id,
        clienteId: link.clienteId,
        detalhe: { expiraEm: link.expiraEm.toISOString() },
      });
    }
  }

  /* ---------------------------------------------------------------- */
  /* Revogado, mas com dinheiro dentro                                 */
  /* ---------------------------------------------------------------- */
  const revogados = await repos.links.listByStatus('revogado', 50);
  for (const link of revogados) {
    const total = await repos.payments.sumConfirmedByLink(link.id);
    if (total > 0n) {
      alertas.push({
        nivel: 'atencao',
        codigo: 'link_revogado_com_valor',
        titulo: 'Link revogado recebeu pagamento',
        descricao:
          'O dinheiro chegou depois da revogacao. O motor nao recusa pagamento, ' +
          'entao o valor foi creditado e sera movido. Confira se era esperado.',
        linkId: link.id,
        clienteId: link.clienteId,
        detalhe: { recebidoBaseUnits: total.toString(), asset: link.asset },
      });
    }
  }

  /* ---------------------------------------------------------------- */
  /* Patrocinador de gas sem saldo                                     */
  /* ---------------------------------------------------------------- */
  if (deps.gasSponsorConfigured) {
    alertas.push({
      nivel: 'info',
      codigo: 'gas_sponsor_configurado',
      titulo: 'Gas sponsor ativo',
      descricao: `Monitorando o saldo do patrocinador (minimo ${deps.gasSponsorMinBalanceWei} wei).`,
      detalhe: { minBalanceWei: deps.gasSponsorMinBalanceWei.toString() },
    });
  } else {
    alertas.push({
      nivel: 'critico',
      codigo: 'gas_sponsor_ausente',
      titulo: 'Gas sponsor nao configurado',
      descricao:
        'Sem GAS_SPONSOR_PRIVATE_KEY nenhum valor recebido pode ser movido: ' +
        'o endereco derivado nao tem saldo nativo para pagar o gas.',
      detalhe: { variavel: 'GAS_SPONSOR_PRIVATE_KEY' },
    });
  }

  const contagem = contar(alertas);
  if (contagem.critico > 0) {
    logger.warn({ alertas: contagem }, 'alertas criticos ativos');
  }
  return alertas;
}

function contar(alertas: Alerta[]) {
  return {
    total: alertas.length,
    critico: alertas.filter((a) => a.nivel === 'critico').length,
    atencao: alertas.filter((a) => a.nivel === 'atencao').length,
    info: alertas.filter((a) => a.nivel === 'info').length,
  };
}