# Descrição Executiva – Sistema de Pagamentos com Ramp (Link Pessoal) + HD Wallet + Automação On-Chain

> Histórico. Este texto é o desenho do motor Polygon/Ramp, não do serviço Bitcoin.
> O serviço atual está em `services/btc-payments`. O livro dele é `../docs/index.html`.

## 1. Objetivo

Criar um pipeline que permita a **vendedores sem conta business no Ramp** receber pagamentos de terceiros em **stablecoins (USDC/USDT)** e, de forma **totalmente automatizada**, registrar esses pagamentos em um banco de dados e transferir os fundos para uma **carteira fria fixa**.

O sistema substitui a falta de webhooks do Ramp (recurso exclusivo de contas business) por **monitoramento direto da blockchain**, usando endereços únicos gerados via **HD Wallet**.

---

## 2. Componentes do Sistema

| Componente | Função |
|------------|--------|
| **Gerador de URLs Ramp** | Constrói links de pagamento personalizados com endereço único por pedido |
| **HD Wallet** | Deriva um endereço de depósito exclusivo para cada transação, sem expor a chave mestre |
| **Monitor de Blockchain** | Observa os endereços gerados e detecta transações de stablecoin em tempo real |
| **Serviço de Indexação/Banco de Dados** | Registra pedidos, associa endereços a pedidos e marca pagamentos como confirmados |
| **Automatizador de Transferência** | Move os fundos dos endereços temporários para a carteira fria principal |
| **Carteira Fria Fixa** | Endereço de destino final (sua carteira de acumulação) |

---

## 3. Fluxo de Ponta a Ponta

### 3.1 Geração do Link de Pagamento (Ramp)

1. O cliente inicia uma compra no seu sistema, gerando um `orderId` (ex.: `pedido-001`).
2. O backend consulta a **HD Wallet** para derivar um novo endereço de recebimento:
   - `endereco_deposito = hdWallet.derivePath("m/44'/60'/0'/0/" + pedido.id)`
3. O backend monta a URL do Ramp **sem `hostApiKey`** (conta pessoal, padrão público):

```
https://app.ramp.network/?userAddress=ENDEREÇO_DERIVADO&asset=USDC&network=polygon&fiatValue=VALOR&fiatCurrency=BRL
```

4. O link é enviado ao cliente (por e-mail, WhatsApp, ou página de checkout).

### 3.2 Pagamento do Cliente

1. O cliente abre o link, passa pelo **KYC leve** do Ramp e paga com cartão de crédito.
2. A Ramp converte a moeda fiduciária em USDC e **envia para o `userAddress`** – que é exatamente o endereço derivado da HD Wallet para aquele pedido.
3. **O Ramp não notifica o vendedor** (por falta de conta business). A informação do pagamento está apenas na blockchain.

### 3.3 Detecção Automática (Monitoração On-Chain)

1. O **monitor de blockchain** escuta todos os endereços derivados da HD Wallet (ou usa uma API de streaming como Alchemy Webhooks, ou realiza polling periódico via Polygonscan/Alchemy).
2. Para cada transação nova, ele verifica:
   - O endereço de **entrada** (from) e **saída** (to).
   - O contrato do token (ex.: USDC na Polygon).
   - O valor transferido.
3. Se o endereço `to` for um endereço derivado e o valor for compatível com o pedido, o monitor dispara um **evento interno**.

### 3.4 Registro do Pagamento no Banco de Dados

1. O evento dispara uma **função de callback** no backend.
2. Essa função:
   - Consulta o `pedido` associado àquele endereço (via `orderId` ou `endereco_deposito`).
   - Atualiza o status do pedido para `pagamento_recebido`.
   - Registra metadados: `hash_da_transacao`, `valor_recebido`, `data`, `confirmacoes`.
   - Se o pagamento for parcial ou com valor divergente, gera um alerta para revisão manual.

### 3.5 Transferência Automática para a Carteira Fria

1. Após um número seguro de confirmações (ex.: 10 na Polygon, 1 na Ethereum), um **serviço coletor** é acionado.
2. O coletor usa a **chave privada derivada** ou a **chave mestre da HD Wallet** para assinar uma transação que:
   - Transfere **todo o saldo** do endereço temporário para a **carteira fria fixa**.
   - Calcula o `gasPrice` de forma dinâmica.
3. A transação é enviada para a rede.
4. Opcional: o sistema monitora a confirmação da transferência e registra um segundo evento no banco (`fundo_movido`).

---

## 4. Detalhamento Técnico por Etapa

### 4.1 HD Wallet – Geração de Endereços

**Tecnologia:** bibliotecas JavaScript (`ethers.js` + `@scure/bip32`) ou Python (`hdwallet`).

**Fórmula de derivação:** caminho BIP44 para EVM compatível.

```
m/44'/60'/0'/0/{index}
```

- `{index}` é incrementado a cada novo pedido.
- O **xpub** (chave pública estendida) é usado no servidor para gerar endereços **sem expor a seed**.
- A **seed** fica offline (hardware wallet) ou em ambiente protegido.

**Registro importante:** o banco de dados armazena a relação:

```
orderId → endereco_derivado → índice → data_criação
```

Isso permite saber exatamente qual pedido corresponde a qual endereço.

### 4.2 Monitor de Blockchain

**Opções:**

- **WebSocket** com Alchemy ou Infura: escuta eventos de transferência do contrato USDC para os endereços.
- **Polling via API REST** (Polygonscan, Etherscan): requisita transações a cada N segundos/minutos para a lista de endereços.
- **Indexadores** como The Graph (subgraph customizado) ou Moralis Streams.

**Critérios de detecção:**

- Endereço de depósito igual ao `to` da transação.
- Token igual ao `asset` do pedido.
- Valor dentro de uma `tolerância` definida (ex.: valor_pedido ± 0.5%).

### 4.3 Banco de Dados

Esquema mínimo:

```sql
TABELA pedidos (
  id TEXT PRIMARY KEY,
  endereco_deposito TEXT UNIQUE,
  valor_esperado DECIMAL,
  status TEXT, -- 'aguardando', 'confirmado', 'movido'
  valor_recebido DECIMAL,
  tx_hash TEXT,
  data_pagamento TIMESTAMP
)

TABELA transacoes_internas (
  id SERIAL PRIMARY KEY,
  from_endereco TEXT,
  to_carteira_fria TEXT,
  valor DECIMAL,
  tx_hash TEXT,
  data_movimentacao TIMESTAMP
)
```

**Fluxo no banco:**

- Quando o monitor detecta o pagamento → insere `tx_hash`, atualiza status para `confirmado`.
- Quando o coletor move os fundos → insere na tabela `transacoes_internas`, atualiza status para `movido`.

### 4.4 Automação de Transferência (Coletor)

**Estratégia segura sem expor a seed no servidor:**

1. O coletor gera a transação (payload) do endereço temporário para o endereço fixo.
2. A transação é salva como **PSBT** (parcialmente assinada) ou como `unsignedTx`.
3. Um operador assina com a **hardware wallet** (Ledger/Trezor) ou com um serviço de custódia (Fireblocks API).
   - Isso pode ser feito diariamente, em lote.
   - Alternativa automática: o coletor tem acesso à chave derivada da HD Wallet **somente em ambiente isolado** (VPC privada, sem internet, com HSM).

**Custo:** apenas taxas de gás (muito baixas na Polygon).

---

## 5. Rastreamento de Origem (Opcional)

Como o Ramp **não divulga dados do comprador**, o rastreamento de quem pagou é feito por correlação com o link enviado:

- Antes de enviar o link, você pode registrar: `cliente_id`, `email`, `telefone` no seu sistema.
- Quando o endereço derivado receber o pagamento, você sabe que aquele `cliente_id` foi quem pagou (porque só ele tinha aquele link).

Além disso, você pode incluir parâmetros **desconhecidos na URL do Ramp**, como `utm_source`, `utm_campaign` ou `hostPaymentId` (mesmo sem conta business, o Ramp pode ignorar, mas não quebra). Isso permite correlacionar a origem do tráfego, mas **não substitui o rastreamento via blockchain**.

---

## 6. Considerações de Segurança (Crítico)

| Ponto | Mitigação |
|-------|-----------|
| **Comprometimento da seed** | Nunca expor a seed em servidores conectados à internet. Usar xpub no servidor para gerar endereços e hardware wallet/HSM para assinar transações. |
| **Vazamento do xpub** | O xpub permite derivar endereços, mas não gastar fundos. Ainda assim, proteja-o como segredo (vazamentos expõem o histórico de todas as transações dos clientes). |
| **Chave derivada** | A chave privada derivada só deve existir no dispositivo de assinatura (hardware wallet), nunca no servidor. |
| **Redes** | Usar apenas redes com suporte a stablecoin e baixo custo (Polygon, Arbitrum). Evitar Ethereum mainnet (gas alto) para microtransações. |
| **Erros de valor** | Implementar tolerância (ex.: `valor_recebido <= valor_esperado * 0.99` aceita diferenças de câmbio). Caso a diferença seja maior, marcador para revisão manual. |
| **Gas price** | Usar APIs de gas price (ex.: Polygon Gas Station) para automatizar o preço do gás. |

---

## 7. Visão Geral Arquitetural (Diagrama Simplificado)

```
Cliente
   │ (link Ramp sem conta business)  
   ▼
Checkout Ramp (KYC leve + cartão)
   │
   ▼ (stablecoin enviada para endereço derivado)
HD Wallet (endereço único por pedido)
   │
   ▼ (transação confirmada na blockchain)
Monitor Blockchain (Alchemy/WebSocket)
   │
   ▼ (evento de pagamento)
Backend (webhook interno)
   │
   ├─► Banco de Dados (registra pagamento)
   │
   └─► Coletor (transfere fundos para carteira fria fixa)
   │
   ▼
Carteira Fria Fixa (acumulação de fundos)
```

---

## 8. Estimativa de Esforço e Custos

| Item | Esforço | Custo mensal |
|------|---------|---------------|
| HD Wallet (derivação + xpub) | 1–2 dias | R$ 0 (open source) |
| Integração Ramp (URLs dinâmicas) | 0,5 dia | Taxa da Ramp embutida no cliente |
| Monitor Blockchain | 2–3 dias | API gratuita (Alchemy free tier) ou R$ 50–200/mês |
| Banco de Dados | 1 dia | R$ 0–50 (MongoDB Atlas free ou Postgres) |
| Coletor de transferência | 2 dias | Gás (~R$ 0,02 por transação na Polygon) |
| **Total** | **~7 dias** | **< R$ 300/mês** |

---

## 9. Conclusão

Este projeto é **perfeitamente viável sem conta business no Ramp**. Ele substitui a falta de webhooks por **monitoramento on-chain**, usando endereços únicos derivados de uma HD Wallet para rastrear pagamentos com precisão cirúrgica.

**Pontos fortes:**
- Baixo custo inicial.
- Independência total de terceiros.
- Rastreamento inequívoco por pedido.

**Riscos principais:**
- Segurança da seed (exigência de boas práticas rigorosas).
- Necessidade de monitoramento constante (ou uso de services como Alchemy Notify para reduzir polling).

Se seguir as boas práticas de segurança (xpub no servidor, seed offline, hardware wallet na assinatura), o sistema é **pronto para produção** com um investimento de desenvolvimento de aproximadamente uma semana.