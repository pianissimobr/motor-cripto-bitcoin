# On-chain: endereços do lojista e confirmações

## Carteira

- O lojista cadastra o xpub de **conta** BIP84 (`m/84'/0'/0'`, depth 3) dele no
  portal ou em `POST /v1/wallets` (`kind: btc_deposit`). Nunca xprv/seed.
- Cada cobrança usa um endereço novo derivado desse xpub:
  `m/84'/0'/0'/{BTC_DERIVATION_PREFIX}/{index}` (P2WPKH).
- O índice é por carteira, alocado atomicamente no Postgres e nunca reusado.
- Os endereços são do lojista: o BTC já cai na carteira dele. A plataforma não
  tem a chave privada, então **não há sweep, carteira fria nem conversão**.
- Cadastrar outro xpub substitui o anterior para as próximas cobranças. As
  cobranças antigas continuam observadas nos endereços em que foram criadas.
- Cada cobrança tem endereço próprio e valor próprio. Cobranças que expiram
  sem pagamento também consomem endereço.

## Gap limit (1000)

Carteiras como Sparrow e Electrum só procuram pagamentos até N endereços
seguidos sem uso (o "gap limit", 20 por padrão). O motor usa
`BTC_GAP_LIMIT=1000`:

- **O lojista configura 1000 na carteira dele.** Sparrow: Settings → Advanced
  → Gap limit. Electrum: no console, `wallet.change_gap_limit(1000)`.
- O motor nunca passa disso: quando o xpub tem 1000 endereços seguidos sem
  depósito, a cobrança sai **sem on-chain** (só Lightning, se houver) e o
  operador recebe um alerta. Sem Lightning, a resposta é
  `409 gap_limit_reached`. Um pagamento em qualquer endereço desse trecho
  libera de novo.

## Pagamento

- UTXOs são lidos via Esplora (`/address/:addr/utxo`).
- O status usa confirmações:
  - `ONCHAIN_CONFIRMATIONS` (padrão 1);
  - `ONCHAIN_HIGH_VALUE_CONFIRMATIONS` (padrão 3) a partir de
    `ONCHAIN_HIGH_VALUE_SATS`.
- Parcial: valor confirmado abaixo do pedido vira `parcial` na expiração.
- Overpay: `paid_amount_sats` e `overpaid_sats` registram o excesso.
- Reorg: sumir da lista de UTXOs não basta; só o tx de depósito ausente, ou um
  UTXO confirmado que voltou à mempool, reabre a cobrança.
- Pagamento tardio: o endereço continua observado por `INTENT_GRACE_SECONDS`
  (padrão 24 h) depois de `expires_at`; se completar, vira `pago_tardio`.
- Se o lojista gastar o UTXO da carteira dele, a saída some da lista de UTXO.
  Isso não é reorg: o depósito continua existindo e a cobrança continua paga.

## Esplora

Endpoints usados:

- `GET /blocks/tip/height`
- `GET /address/:address/utxo`
- `GET /tx/:txid`

Em produção, use Esplora/Electrum self-hosted e privado. Não use uma API
pública para endereços de clientes.
