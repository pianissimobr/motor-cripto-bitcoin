import { getAddress } from 'ethers';
import { bootstrap } from '../src/bootstrap.js';

/**
 * Seed do banco: perfis de integracao Ramp e carteira fria padrao.
 * Idempotente: pode rodar varias vezes.
 *
 * Uso: npm run seed
 */

const USDC_POLYGON = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359';
const USDT0_POLYGON = '0xc2132D05D31c914a87C6611C10748AEb04B58e8F';

/**
 * Taxa de referencia: quantos base units do token valem 1,00 de fiat.
 * 180000 = 0,18 USDC por R$ 1,00 (USDC e 6 decimais).
 * ATUALIZE essa taxa quando o cambio USD/BRL mudar: e ela que permite
 * marcar o link como "parcial" quando o pagamento nao bate.
 */
function taxaFromEnv(name: string, fallback: string): bigint {
  const raw = process.env[name] ?? fallback;
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${name} deve ser um inteiro nao-negativo em base units (recebido "${raw}")`);
  }
  return BigInt(raw);
}

async function main(): Promise<void> {
  const atualizarTaxas = process.argv.includes('--update-rates');
  const USDC_POR_BRL = taxaFromEnv('SEED_USDC_POR_BRL', '180000');
  const USDT_POR_BRL = taxaFromEnv('SEED_USDT_POR_BRL', '180000');
  const { config, logger, motor, close } = await bootstrap();

  const perfis = [
    {
      label: 'Polygon USDC',
      chain: 'polygon',
      asset: 'USDC',
      tokenContract: USDC_POLYGON,
      decimals: 6,
      fiatCurrency: 'BRL',
      baseUrl: config.ramp.baseUrl,
      paramStyle: config.ramp.paramStyle,
      hostAppName: config.ramp.hostAppName,
      hostLogoUrl: config.ramp.hostLogoUrl ?? null,
      hostApiKey: null,
      rampAssetKey: 'POLYGON_USDC',
      taxaTokenPorFiatBaseUnits: USDC_POR_BRL,
    },
    {
      label: 'Polygon USDT0',
      chain: 'polygon',
      asset: 'USDT0',
      tokenContract: USDT0_POLYGON,
      decimals: 6,
      fiatCurrency: 'BRL',
      baseUrl: config.ramp.baseUrl,
      paramStyle: config.ramp.paramStyle,
      hostAppName: config.ramp.hostAppName,
      hostLogoUrl: config.ramp.hostLogoUrl ?? null,
      hostApiKey: null,
      rampAssetKey: 'POLYGON_USDT0',
      taxaTokenPorFiatBaseUnits: USDT_POR_BRL,
    },
  ];

  const existentes = await motor.repos.rampProfiles.list();
  for (const perfil of perfis) {
    const jaExiste = existentes.find((p) => p.label === perfil.label);
    if (jaExiste) {
      const taxaAnterior = jaExiste.taxaTokenPorFiatBaseUnits;
      if (atualizarTaxas && taxaAnterior !== perfil.taxaTokenPorFiatBaseUnits) {
        const atualizado = await motor.repos.rampProfiles.update(jaExiste.id, {
          taxaTokenPorFiatBaseUnits: perfil.taxaTokenPorFiatBaseUnits,
        });
        logger.info(
          {
            label: perfil.label,
            id: atualizado?.id ?? jaExiste.id,
            de: taxaAnterior?.toString() ?? null,
            para: perfil.taxaTokenPorFiatBaseUnits.toString(),
          },
          'taxa do perfil Ramp atualizada',
        );
      } else {
        logger.info(
          { label: perfil.label, id: jaExiste.id, taxa: taxaAnterior?.toString() ?? null },
          atualizarTaxas
            ? 'taxa do perfil Ramp ja esta sincronizada'
            : 'perfil Ramp ja existe (mantido; use --update-rates para sincronizar a taxa)',
        );
      }
      continue;
    }
    const criado = await motor.repos.rampProfiles.create(perfil);
    logger.info({ label: criado.label, id: criado.id }, 'perfil Ramp criado');
  }

  const endereco = config.coldWallet.address;
  if (endereco) {
    const normalizado = getAddress(endereco);
    const carteiras = await motor.repos.coldWallets.list();
    const jaExiste = carteiras.find((c) => c.address.toLowerCase() === normalizado.toLowerCase());
    if (jaExiste) {
      logger.info({ label: jaExiste.label }, 'carteira fria ja cadastrada');
    } else {
      const criada = await motor.repos.coldWallets.create({
        label: config.coldWallet.label,
        address: normalizado,
        chain: 'polygon',
      });
      logger.info({ id: criada.id, address: criada.address }, 'carteira fria criada');
    }
  } else {
    logger.warn(
      'COLD_WALLET_ADDRESS nao configurado: cadastre a carteira fria pela API ' +
        'ou defina a variavel e rode o seed de novo',
    );
  }

  await close();
}

main().catch((err) => {
  console.error('falha no seed:', err);
  process.exit(1);
});
