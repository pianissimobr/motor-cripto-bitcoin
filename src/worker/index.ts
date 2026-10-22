import { bootstrap } from '../bootstrap.js';
import { createLockClient } from '../adapters/db/client.js';

/**
 * Worker: monitor on-chain + varredura para a carteira fria.
 *
 * Roda em processo separado da API. Um advisory lock de SESSAO garante que
 * apenas uma instancia do worker exista por banco (evita sweep duplo). O
 * lock usa uma conexao dedicada, sem idle_timeout: no pool normal a sessao
 * podia ser fechada e o lock liberado sem ninguem perceber.
 */

const LOCK_ID = 918_273_645;

async function main(): Promise<void> {
  const { config, logger, motor, close } = await bootstrap();

  const lockSql = createLockClient(config.database.url, config.database.ssl);
  let lockHeld = false;

  const acquireLock = async (): Promise<boolean> => {
    const rows = await lockSql`select pg_try_advisory_lock(${LOCK_ID}) as acquired`;
    lockHeld = Boolean(rows[0]?.acquired);
    return lockHeld;
  };

  if (!(await acquireLock())) {
    logger.error('outro worker ja esta rodando neste banco (advisory lock ocupado)');
    await lockSql.end({ timeout: 5 });
    await close();
    process.exit(1);
  }
  logger.info('advisory lock obtido: worker ativo');

  let running = true;
  let wake: (() => void) | undefined;
  const stopped = new Promise<void>((resolve) => {
    wake = resolve;
  });

  const stop = (signal: string) => {
    logger.info({ signal }, 'sinal recebido, encerrando worker');
    running = false;
    wake?.();
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));

  const tick = async () => {
    if (!running) return;
    const started = Date.now();

    try {
      const monitorResult = await motor.monitor.runCycle();
      if (monitorResult.logsVarridos > 0 || monitorResult.pagamentosConfirmados > 0) {
        logger.info(
          {
            logs: monitorResult.logsVarridos,
            detectados: monitorResult.pagamentosDetectados,
            confirmados: monitorResult.pagamentosConfirmados,
            creditos: monitorResult.creditosCriados,
          },
          'ciclo do monitor',
        );
      }
      for (const erro of monitorResult.erros) {
        logger.error({ erro }, 'erro no monitor');
      }
    } catch (err) {
      // Uma falha no monitor nao pode impedir o sweeper de rodar.
      logger.error({ err }, 'falha no ciclo do monitor');
    }

    try {
      const sweepResult = await motor.sweeper.runCycle();
      if (sweepResult.movidos > 0 || sweepResult.falhas > 0 || sweepResult.resgatados > 0) {
        logger.info(
          {
            processados: sweepResult.processados,
            movidos: sweepResult.movidos,
            resgatados: sweepResult.resgatados,
            falhas: sweepResult.falhas,
            aguardandoGas: sweepResult.aguardandoGas,
          },
          'ciclo do sweeper',
        );
      }
      for (const erro of sweepResult.erros) {
        logger.error({ erro }, 'erro no sweeper');
      }
    } catch (err) {
      logger.error({ err }, 'falha no ciclo do sweeper');
    }

    logger.debug({ ms: Date.now() - started }, 'ciclo concluido');
  };

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      void stopped.then(() => {
        clearTimeout(timer);
        resolve();
      });
    });

  // Loop sequencial: nunca ha dois ticks sobrepostos.
  while (running) {
    await tick();
    if (!running) break;
    await sleep(config.chain.monitorIntervalMs);
  }

  if (lockHeld) {
    await lockSql`select pg_advisory_unlock(${LOCK_ID})`;
  }
  await lockSql.end({ timeout: 5 });
  await close();
  logger.info('worker encerrado');
}

main().catch((err) => {
  console.error('falha no worker:', err);
  process.exit(1);
});
