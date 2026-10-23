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

/** Saldo nativo do patrocinador numa chain; `null` = RPC indisponivel. */
export type GasSponsorBalance = {
  chain: string;
  balanceWei: bigint | null;
};

export type AlertsDeps = {
  repos: MotorRepositories;
  logger: Logger;
  /** Saldo minimo do patrocinador de gas, em wei. */
  gasSponsorMinBalanceWei: bigint;
  gasSponsorConfigured: boolean;
  /**
   * Saldo real por chain. Ausente = nao consultado (a borda HTTP injeta).
   * Chain com `null` = consulta falhou e vira atencao, nunca "tudo ok".
   */
  gasSponsorBalances?: GasSponsorBalance[];
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
  /* Patrocinador de gas: configurado E com saldo real suficiente      */
  /* ---------------------------------------------------------------- */
  if (!deps.gasSponsorConfigured) {
    alertas.push({
      nivel: 'critico',
      codigo: 'gas_sponsor_ausente',
      titulo: 'Gas sponsor nao configurado',
      descricao:
        'Sem GAS_SPONSOR_PRIVATE_KEY nenhum valor recebido pode ser movido: ' +
        'o endereco derivado nao tem saldo nativo para pagar o gas.',
      detalhe: { variavel: 'GAS_SPONSOR_PRIVATE_KEY' },
    });
  } else if (!deps.gasSponsorBalances) {
    alertas.push({
      nivel: 'atencao',
      codigo: 'gas_sponsor_saldo_nao_verificado',
      titulo: 'Saldo do gas sponsor nao verificado',
      descricao:
        'O patrocinador esta configurado, mas o saldo nativo nao foi consultado. ' +
        'Sem essa checagem um sweep pode falhar por falta de gas.',
      detalhe: { minBalanceWei: deps.gasSponsorMinBalanceWei.toString() },
    });
  } else if (deps.gasSponsorBalances.length === 0) {
    alertas.push({
      nivel: 'info',
      codigo: 'gas_sponsor_sem_perfis',
      titulo: 'Gas sponsor ativo sem perfis Ramp',
      descricao: 'Nao ha perfil Ramp para definir em qual chain consultar o saldo.',
      detalhe: { minBalanceWei: deps.gasSponsorMinBalanceWei.toString() },
    });
  } else {
    const baixos = deps.gasSponsorBalances.filter(
      (b) => b.balanceWei !== null && b.balanceWei < deps.gasSponsorMinBalanceWei,
    );
    const indisponiveis = deps.gasSponsorBalances.filter((b) => b.balanceWei === null);

    if (baixos.length > 0) {
      alertas.push({
        nivel: 'critico',
        codigo: 'gas_sponsor_saldo_baixo',
        titulo: 'Gas sponsor com saldo abaixo do minimo',
        descricao:
          'Recarregue a carteira patrocinadora. Sem saldo suficiente os proximos ' +
          'sweeps ficam em pago_sem_gas.',
        detalhe: {
          minBalanceWei: deps.gasSponsorMinBalanceWei.toString(),
          saldos: baixos.map((b) => ({ chain: b.chain, balanceWei: b.balanceWei!.toString() })),
        },
      });
    }

    if (indisponiveis.length > 0) {
      alertas.push({
        nivel: 'atencao',
        codigo: 'gas_sponsor_saldo_indisponivel',
        titulo: 'Nao foi possivel ler o saldo do gas sponsor',
        descricao:
          'O RPC falhou para uma ou mais chains. O patrocinador pode estar sem ' +
          'saldo; confira manualmente antes de ignorar.',
        detalhe: {
          minBalanceWei: deps.gasSponsorMinBalanceWei.toString(),
          chains: indisponiveis.map((b) => b.chain),
        },
      });
    }

    if (baixos.length === 0 && indisponiveis.length === 0) {
      alertas.push({
        nivel: 'info',
        codigo: 'gas_sponsor_saldo_ok',
        titulo: 'Gas sponsor com saldo suficiente',
        descricao: 'Saldo nativo conferido em todas as chains dos perfis Ramp.',
        detalhe: {
          minBalanceWei: deps.gasSponsorMinBalanceWei.toString(),
          saldos: deps.gasSponsorBalances.map((b) => ({
            chain: b.chain,
            balanceWei: b.balanceWei!.toString(),
          })),
        },
      });
    }
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