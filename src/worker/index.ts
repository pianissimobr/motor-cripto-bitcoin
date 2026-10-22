import { bootstrap } from '../bootstrap.js';

/**
 * Worker: monitor on-chain + varredura para a carteira fria.
 *
 * Roda em processo separado da API. Um advisory lock do Postgres garante
 * que apenas uma instancia do worker exista por banco (evita sweep duplo).
 */

const LOCK_ID = 918_273_645;

async function main(): Promise<void> {
  const { config, logger, db, motor, close } = await bootstrap();

  const sql = db.sql;
  let lockHeld = false;

  const acquireLock = async (): Promise<boolean> => {
    const rows = await sql`select pg_try_advisory_lock(${LOCK_ID}) as acquired`;
    lockHeld = Boolean(rows[0]?.acquired);
    return lockHeld;
  };

  if (!(await acquireLock())) {
    logger.error('outro worker ja esta rodando neste banco (advisory lock ocupado)');
    await close();
    process.exit(1);
  }
  logger.info('advisory lock obtido: worker ativo');

  let running = true;
  const stop = (signal: string) => {
    logger.info({ signal }, 'sinal recebido, encerrando worker');
    running = false;
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

      const sweepResult = await motor.sweeper.runCycle();
      if (sweepResult.movidos > 0 || sweepResult.falhas > 0) {
        logger.info(
          {
            processados: sweepResult.processados,
            movidos: sweepResult.movidos,
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
      logger.error({ err }, 'falha no ciclo do worker');
    }
    logger.debug({ ms: Date.now() - started }, 'ciclo concluido');
  };

  await tick();
  const timer = setInterval(() => void tick(), config.chain.monitorIntervalMs);

  await new Promise<void>((resolve) => {
    const check = setInterval(() => {
      if (!running) {
        clearInterval(check);
        clearInterval(timer);
        resolve();
      }
    }, 500);
  });

  if (lockHeld) {
    await sql`select pg_advisory_unlock(${LOCK_ID})`;
  }
  await close();
  logger.info('worker encerrado');
}

main().catch((err) => {
  console.error('falha no worker:', err);
  process.exit(1);
});
