import { AbiCoder, type Provider } from 'ethers';
import { describe, expect, it } from 'vitest';
import { GasSponsor } from '../src/core/chain/gas-sponsor.js';
import { Sweeper } from '../src/core/chain/sweeper.js';
import { silentLogger } from '../src/core/logger.js';
import { LinkStateMachine } from '../src/core/services/link-state-machine.js';
import type { Signer } from '../src/core/signer/signer.js';
import { createFakeRepositories } from './fakes.js';

const ZERO = AbiCoder.defaultAbiCoder().encode(['uint256'], [0n]);

describe('sweep de parcial', () => {
  it('varre sem mudar o estado para movido', async () => {
    const repos = createFakeRepositories();
    const link = await repos.links.create({
      id: '00000000-0000-4000-8000-000000000010',
      apiClienteId: '00000000-0000-4000-8000-000000000011',
      externalId: 'pedido-parcial',
      idempotencyKey: 'pedido-parcial',
      requestHash: 'abc',
      rampProfileId: '00000000-0000-4000-8000-000000000012',
      chain: 'polygon',
      asset: 'USDC',
      tokenContract: `0x${'11'.repeat(20)}`,
      decimals: 6,
      moedaFiat: 'BRL',
      valorFiatCentavos: 10_000,
      valorFiatUnidades: 100,
      taxaTokenPorFiatBaseUnits: 180_000n,
      expectedBaseUnits: 18_000_000n,
      indiceHd: 1,
      caminhoDerivacao: "m/44'/60'/0'/0/1",
      enderecoDeposito: `0x${'22'.repeat(20)}`,
      walletAddress: `0x${'33'.repeat(20)}`,
      pageToken: 'pagina',
      pageTokenHash: 'hash',
      rampUrl: 'https://buy.ramp.network/',
      status: 'parcial',
      expiraEm: new Date('2026-10-23T18:00:00.000Z'),
      liquidacaoAte: new Date('2026-10-24T18:00:00.000Z'),
    });
    await repos.links.updateSettlement(link.id, { valorRecebidoBaseUnits: 1_000_000n });
    await repos.transfers.create({
      linkId: link.id,
      deAddress: link.enderecoDeposito,
      paraAddress: link.walletAddress,
      valorBaseUnits: 1_000_000n,
      status: 'confirmado',
      txHash: `0x${'ab'.repeat(32)}`,
      chain: 'polygon',
      bloco: 10,
      nonce: 0,
      kind: 'sweep',
    });

    const provider = {
      getNetwork: async () => ({ chainId: 137n, name: 'polygon' }),
      call: async () => ZERO,
      getBalance: async () => 0n,
      getTransactionCount: async () => 1,
      getFeeData: async () => ({
        maxFeePerGas: 1n,
        maxPriorityFeePerGas: 1n,
        gasPrice: 1n,
      }),
      getTransactionReceipt: async () => null,
    } as unknown as Provider;

    const sweeper = new Sweeper({
      repos,
      providerFactory: () => provider,
      signer: {} as Signer,
      gasSponsor: GasSponsor.watchOnly(undefined, 0n, 0n),
      linkState: new LinkStateMachine({ repos, logger: silentLogger }),
      logger: silentLogger,
      options: {
        gasSponsorAmountWei: 0n,
        gasSponsorMinBalanceWei: 0n,
        batchSize: 10,
        reconcileBatchSize: 10,
        tolerancePct: 1,
      },
    });

    const result = await sweeper.runCycle();
    expect(result.falhas).toBe(0);
    expect(result.erros).toEqual([]);
    expect((await repos.links.findById(link.id))?.status).toBe('parcial');
  });
});
