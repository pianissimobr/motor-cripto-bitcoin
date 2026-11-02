import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

/**
 * Gera uma carteira EVM descartavel para testar a liquidacao: cadastre o
 * endereco como `usdc_settlement` de uma loja de teste e acompanhe o USDC
 * chegar na Base. O motor nao precisa de carteira quente nem de gas: a
 * THORChain e a Lunium entregam direto nesse endereco.
 */
function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

function main(): void {
  const merchantKey = generatePrivateKey();
  const merchant = privateKeyToAccount(merchantKey);

  if (hasFlag('--json')) {
    console.log(
      JSON.stringify({ merchant: { address: merchant.address, privateKey: merchantKey } }, null, 2),
    );
    return;
  }

  console.log('Carteira Base de teste gerada (lojista).\n');
  console.log(`MERCHANT_USDC_ADDRESS=${merchant.address}`);
  console.log(`MERCHANT_PRIVATE_KEY=${merchantKey}`);
  console.log(
    '\nCadastre MERCHANT_USDC_ADDRESS como carteira usdc_settlement da loja de teste.',
  );
  console.log('Guarde a chave fora do repositorio. Use apenas em teste.');
}

try {
  main();
} catch (err) {
  console.error('[btc-payments] falha ao gerar carteira Base:', err);
  process.exit(1);
}
