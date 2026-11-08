/**
 * Cria uma conta do painel pela linha de comando (com o cadastro fechado).
 * A conta nasce ativa e SEM senha conhecida: o dono define a dele pelo
 * "Esqueci a senha" (codigo por e-mail do authO). Ninguem alem dele conhece
 * a senha.
 *
 * Uso (na VPS):
 *   docker compose ... exec api node dist/cli/create-dashboard-user.js \
 *     --email dono@loja.com --loja "Minha Loja" [--merchant-id <uuid>]
 *
 * Com --merchant-id, liga a conta a uma loja que ja existe; sem ele, cria
 * uma loja nova.
 */
import { randomBytes } from 'node:crypto';
import { loadConfig } from '../config.js';
import { hashPassword } from '../crypto/password.js';
import { createDb } from '../db/client.js';
import { createRepositories } from '../db/repositories.js';
import { createLogger } from '../logger.js';
import { ClientService } from '../services/client-service.js';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const email = arg('email')?.trim().toLowerCase();
  const merchantName = arg('loja')?.trim();
  const merchantId = arg('merchant-id')?.trim();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('informe --email valido');
  if (!merchantId && !merchantName) throw new Error('informe --loja (ou --merchant-id)');

  const config = loadConfig();
  const logger = createLogger({ level: 'warn' });
  const db = createDb(config.database);
  try {
    const repos = createRepositories(db.db);
    if (await repos.findUserByEmail(email)) throw new Error('ja existe conta com esse e-mail');

    let merchant: { id: string; name: string };
    if (merchantId) {
      const found = await repos.findClientById(merchantId);
      if (!found || found.clientType !== 'loja') throw new Error('loja nao encontrada');
      merchant = { id: found.id, name: found.name };
    } else {
      const clients = new ClientService({ repos, config, logger });
      merchant = await clients.createMerchant({ name: merchantName! });
    }

    // Senha aleatoria descartada: o acesso so comeca pelo "Esqueci a senha".
    const user = await repos.createUser({
      email,
      passwordHash: hashPassword(randomBytes(32).toString('base64url')),
      status: 'ativo',
    });
    await repos.updateUser(user.id, { emailVerifiedAt: new Date() });
    await repos.createMerchantMember({ userId: user.id, merchantId: merchant.id, role: 'owner' });
    await repos.insertAuditEvent({
      actor: 'cli',
      action: 'user.created_by_admin',
      entity: 'user',
      entityId: user.id,
      metadata: { merchantId: merchant.id },
    });
    console.log(`conta criada: ${email} -> loja "${merchant.name}" (${merchant.id})`);
    console.log(`proximo passo: abrir ${config.service.publicBaseUrl.replace(/\/+$/, '')}/painel/esqueci e definir a senha`);
  } finally {
    await db.close();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
