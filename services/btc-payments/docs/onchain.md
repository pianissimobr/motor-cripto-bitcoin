# On-chain: derivacao, confirmacoes e sweep

## Carteira

- xpub de conta BIP84: `m/84'/0'/0'` (depth 3).
- Enderecos: `m/84'/0'/0'/0/{index}` (P2WPKH).
- O servidor de enderecos usa **somente** o xpub.
- O xprv fica no worker (keystore cifrado) ou em signer remoto.
- O indice e alocado atomicamente no Postgres e nunca reutilizado.
- O gap limit e respeitado porque a alocacao e sequencial.

Fingerprint: o banco guarda um fingerprint do xpub. Se o `BTC_XPUB` mudar, o
boot recusa para evitar derivar enderecos de outra carteira.

## Pagamento

- UTXOs sao lidos via Esplora (`/address/:addr/utxo`).
- O valor e somado; o status do pagamento usa confirmacoes:
  - `ONCHAIN_CONFIRMATIONS` (padrao 1);
  - `ONCHAIN_HIGH_VALUE_CONFIRMATIONS` (padrao 3) acima de
    `ONCHAIN_HIGH_VALUE_SATS`.
- Parcial: pagamento menor que o esperado; vira `parcial` na expiracao.
- Overpay: pagamento maior; `paid_amount_sats` e `overpaid_sats` registram o
  excesso.
- Reorg: se um UTXO confirmado desaparece, o pagamento e reavaliado e a intent
  pode ir para `reorg`.
- Pagamento tardio: depois dos 10 min, o endereco continua observado por
  `INTENT_GRACE_SECONDS` (padrao 24h). Se cair, vira `pago_tardio`.

## Sweep

- Agrupa UTXOs confirmados por endereco.
- Destino: `COLD_WALLET_ADDRESS` (global allowlisted).
- Taxa: `GET /fee-estimates` do Esplora, alvo `SWEEP_FEE_TARGET_BLOCKS`,
  multiplicador `SWEEP_FEE_MULTIPLIER`.
- Limites: `SWEEP_MIN_SATS`, poeira de 546 sats e `SWEEP_MAX_FEE_PCT`.
- Assinatura:
  - `local`: keystore cifrado no worker;
  - `remote`: POST `/sign` para um signer externo;
  - `psbt`: PSBT manual.
- O sweep usa `sequence` RBF e reenvia depois de `SWEEP_RBF_AFTER_SECONDS`,
  ate `SWEEP_MAX_ATTEMPTS`.
- Cada tentativa grava `onchain_sweeps` (inputs, PSBT, rawTx, txid, taxa).
- Depois do broadcast, os UTXOs viram `gasto`; o watcher nao os reabre
  enquanto o sweep estiver ativo.
- Se o sweep virar `manual`, use:
  `POST /admin/api/sweeps/:id/retry` para restaurar os UTXOs e tentar de novo.

## Esplora

Endpoints usados:

- `GET /blocks/tip/height`
- `GET /address/:address/utxo`
- `GET /address/:address`
- `GET /tx/:txid`
- `GET /fee-estimates`
- `POST /tx`

Em producao, use Esplora/Electrum self-hosted e privado. Nao use uma API
publica para enderecos de clientes.
