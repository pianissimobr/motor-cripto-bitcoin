import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

function main(): void {
  const treasuryKey = generatePrivateKey();
  const merchantKey = generatePrivateKey();
  const treasury = privateKeyToAccount(treasuryKey);
  const merchant = privateKeyToAccount(merchantKey);

  if (hasFlag('--json')) {
    console.log(
      JSON.stringify(
        {
          treasury: {
            address: treasury.address,
            privateKey: treasuryKey,
          },
          merchant: {
            address: merchant.address,
            privateKey: merchantKey,
          },
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log('Carteiras Base de teste geradas.\n');
  console.log('Treasury quente (recebe USDC da Lunium e paga a loja):');
  console.log(`PAYOUT_HOT_ADDRESS=${treasury.address}`);
  console.log(`TREASURY_USDC_ADDRESS=${treasury.address}`);
  console.log(`BASE_PAYOUT_PRIVATE_KEY=${treasuryKey}`);
  console.log('\nLoja de teste (recebe o payout USDC):');
  console.log(`MERCHANT_USDC_ADDRESS=${merchant.address}`);
  console.log(`MERCHANT_PRIVATE_KEY=${merchantKey}`);
  console.log(
    '\nGuarde as chaves fora do repositorio. Use apenas em teste e nunca em producao.',
  );
  console.log(
    'A treasury precisa de ETH na Base para gas. A loja nao precisa de ETH para receber USDC.',
  );
  console.log(
    'Cadastre MERCHANT_USDC_ADDRESS como carteira usdc_settlement da loja antes do payout.',
  );
}

try {
  main();
} catch (err) {
  console.error('[btc-payments] falha ao gerar carteiras Base:', err);
  process.exit(1);
}
