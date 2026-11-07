import { loadConfig } from '../src/config.js';
import { loadEnv } from '../src/load-env.js';
import { AlertService } from '../src/services/alert-service.js';
import { createLogger } from '../src/logger.js';

/**
 * Drill de alerta (F7).
 *
 * Um canal de alerta que nunca foi exercitado nao e um canal: e uma
 * configuracao. Este script dispara um alerta de verdade pelos canais
 * configurados (webhook e e-mail) e diz o que foi entregue. Sai com codigo
 * 1 quando nenhum canal entrega — o que ja broken e o alarme nao tocou.
 *
 *   npm run alert:drill
 */

loadEnv();

const config = loadConfig(process.env);
const logger = createLogger({ level: 'info' });

const alerts = new AlertService({
  ...config.alerts,
  logger,
  ...(config.email.smtp ? { smtp: config.email.smtp } : {}),
  ...(config.email.from ? { emailFrom: config.email.from } : {}),
});

const configured = [
  config.alerts.webhookUrl ? 'webhook' : null,
  config.email.smtp && config.email.from && (config.alerts.emailTo?.length ?? 0) > 0
    ? 'email'
    : null,
].filter((value): value is string => value !== null);

if (configured.length === 0) {
  console.error(
    'nenhum canal de alerta configurado: defina ALERT_WEBHOOK_URL ou ' +
      'ALERT_EMAIL_TO (+ EMAIL_SENDER=smtp, SMTP_HOST, EMAIL_FROM)',
  );
  process.exit(1);
}

console.log(`canais configurados: ${configured.join(', ')}`);

const delivery = await alerts.send({
  level: 'warn',
  title: 'drill de alerta do motor',
  message:
    'Alerta de teste enviado pelo script alert-drill. Se voce esta lendo ' +
    'isto, o canal funciona.',
  metadata: {
    drill: true,
    service: 'btc-payments',
    when: new Date().toISOString(),
  },
});

console.log(`entregues: ${delivery.channels.join(', ') || 'nenhum'}`);
if (delivery.failures.length > 0) {
  console.error(`falharam: ${delivery.failures.join(', ')}`);
}

if (delivery.channels.length === 0) {
  console.error('FALHA: nenhum canal entregou o alerta');
  process.exit(1);
}
