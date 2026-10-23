import { silentLogger } from '../src/core/logger.js';
import { LinkService } from '../src/core/services/link-service.js';
import { LinkStateMachine } from '../src/core/services/link-state-machine.js';
import { ApiClientService } from '../src/core/services/api-client-service.js';
import { publicWebhookLookup } from './webhook-lookup.js';
import type { HdWallet } from '../src/core/hd/hd-wallet.js';
import {
  createFakeRepositories,
  FakeApiClientRepository,
  FakeApiClientWalletRepository,
  FakeLinkRepository,
  FakePaymentRepository,
  FakeRampProfileRepository,
  FakeWebhookOutboxRepository,
} from './fakes.js';

export const TEST_WALLET = '0x52908400098527886E0F7030069857D2E4169EE7';
export const TEST_TOKEN = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';

export async function setupCore(options: { ttlMinutes?: number } = {}) {
  const repos = createFakeRepositories() as ReturnType<typeof createFakeRepositories> & {
    apiClients: FakeApiClientRepository;
    apiClientWallets: FakeApiClientWalletRepository;
    rampProfiles: FakeRampProfileRepository;
    links: FakeLinkRepository;
    payments: FakePaymentRepository;
    webhooks: FakeWebhookOutboxRepository;
  };
  const apiClients = new ApiClientService({
    repos,
    logger: silentLogger,
    resolveWebhookHost: publicWebhookLookup,
  });
  const created = await apiClients.create({
    nome: 'Loja Teste',
    webhookUrl: 'https://example.test/webhook',
  });

  const profile = await repos.rampProfiles.create({
    label: 'Polygon USDC',
    chain: 'polygon',
    asset: 'USDC',
    tokenContract: TEST_TOKEN,
    decimals: 6,
    fiatCurrency: 'BRL',
    baseUrl: 'https://buy.ramp.network/',
    paramStyle: 'legacy',
    hostAppName: 'Motor Cripto',
    taxaTokenPorFiatBaseUnits: 180_000n,
  });

  const wallet = await repos.apiClientWallets.create({
    apiClienteId: created.client.id,
    label: 'Carteira principal',
    chain: 'polygon',
    address: TEST_WALLET,
  });

  const hdWallet = {
    deriveAddress: (index: number) =>
      `0x${(index + 1).toString(16).padStart(40, '0')}`,
    fullPath: (index: number) => `m/44'/60'/0'/0/${index}`,
  } as HdWallet;

  const linkState = new LinkStateMachine({ repos, logger: silentLogger });
  const links = new LinkService({
    repos,
    hdWallet,
    linkState,
    logger: silentLogger,
    ttlMinutes: options.ttlMinutes ?? 60,
    maxIndex: 1_000,
    publicBaseUrl: 'https://pay.test',
    settlement: { days: 1 },
  });

  return {
    repos,
    apiClients,
    created,
    profile,
    wallet,
    hdWallet,
    linkState,
    links,
  };
}
