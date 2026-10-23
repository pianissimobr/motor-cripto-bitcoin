import { describe, expect, it } from 'vitest';
import { HDNodeWallet, Mnemonic } from 'ethers';
import { HdWallet } from '../src/core/hd/hd-wallet.js';
import { createMotor } from '../src/core/index.js';
import { silentLogger } from '../src/core/logger.js';
import { NotFoundError, UnauthorizedError } from '../src/core/domain/errors.js';
import { AccountService } from '../src/core/services/account-service.js';
import { createFakeRepositories } from './fakes.js';

const MNEMONIC = 'test test test test test test test test test test test junk';
const XPUB = HDNodeWallet.fromMnemonic(Mnemonic.fromPhrase(MNEMONIC), "m/44'/60'/0'").neuter()
  .extendedKey;

function setup() {
  const repos = createFakeRepositories();
  const motor = createMotor({
    repos,
    hdWallet: HdWallet.fromAccountXpub(XPUB, '0', 0),
    signer: {
      mode: 'local',
      addressFor: (i: number) => HdWallet.fromAccountXpub(XPUB, '0', 0).deriveAddress(i),
      signTransfer: async () => ({ rawTransaction: '0x', hash: '0x' }),
      buildUnsigned: () => ({
        from: '', to: '', data: '0x', value: '0', chainId: 137, nonce: 0, gasLimit: '0',
      }),
      describe: () => 'fake',
    },
    providerFactory: () => {
      throw new Error('nao usado');
    },
    gasSponsor: {
      enabled: false,
      address: null,
      balance: async () => 0n,
      ensureGas: async () => false,
    } as never,
    logger: silentLogger,
    dataKey: Buffer.alloc(32, 7),
    indexKey: Buffer.alloc(32, 9),
    ttlHours: 72,
  });
  const accounts = new AccountService({
    repos,
    customers: motor.customers,
    links: motor.links,
  });
  return { accounts };
}

describe('conta do cliente', () => {
  it('entra por usuário ou e-mail e distingue senha errada de conta ausente', async () => {
    const { accounts } = setup();
    await accounts.registrar({
      nome: 'Maria Silva',
      email: 'maria@example.com',
      usuario: 'maria',
      senha: 'senha-forte',
    });

    const porUsuario = await accounts.entrar('Maria', 'senha-forte');
    expect(porUsuario.customer.email).toBe('maria@example.com');

    const porEmail = await accounts.entrar('MARIA@example.com', 'senha-forte');
    expect(porEmail.token).not.toBe(porUsuario.token);

    await expect(accounts.entrar('ninguem', 'senha-forte')).rejects.toBeInstanceOf(NotFoundError);
    await expect(accounts.entrar('maria', 'errada')).rejects.toBeInstanceOf(UnauthorizedError);
    await expect(accounts.entrar('maria', 'errada')).rejects.toThrow('Sua senha está errada');
  });
});
