# Motor Cripto: guia de primeiro acesso

Este texto é para ser lido **antes** de abrir o código. Ele explica o que o sistema faz, por que existe, como um pagamento atravessa cada etapa e onde cada peça mora quando você for olhar os arquivos.

Não é um manual de linha por linha. É o mapa. Quando um nome de arquivo aparecer, ele está aqui para você reconhecer o lugar depois, não para você ir lá agora.

A linguagem evita jargão solto. Quando um termo técnico é necessário, ele é explicado na hora e de novo no glossário do capítulo 3.

---

## 1. O problema que este repositório resolve

Imagine uma loja que quer receber um pagamento em dólar digital (uma stablecoin, moeda estável atrelada ao dólar) de um cliente no Brasil. O cliente está acostumado a pagar com cartão ou Pix, em reais. A loja quer que o valor acabe numa carteira segura, que quase nunca fica ligada na internet.

Existe um serviço chamado **Ramp** que faz essa ponte: o cliente paga em reais e a Ramp entrega stablecoin num endereço de carteira que a loja indicou. O problema é o seguinte. A Ramp só avisa a loja automaticamente ("o pagamento caiu") se a loja tiver uma conta empresarial, com webhook. Webhook, aqui, é um aviso que um sistema manda para outro quando algo acontece. Sem conta empresarial, a Ramp não avisa ninguém. O dinheiro pode ter chegado e a loja não fica sabendo, a menos que alguém fique olhando a blockchain o tempo todo.

Este repositório é essa pessoa automática.

Ele se chama **Motor Cripto**. Não é uma loja, não é a Ramp e não é uma carteira de celular. É um programa que:

1. Cadastra o cliente (nome e e-mail).
2. Gera um link de pagamento da Ramp com um endereço exclusivo daquela cobrança.
3. Fica lendo a blockchain até ver a stablecoin cair naquele endereço.
4. Anota o crédito do cliente no banco de dados.
5. Move o valor, sozinho, para a carteira fria da loja.

**Carteira fria** é uma carteira cujo objetivo é guardar valor, não ficar o dia inteiro assinando pagamentos. O ideal é que a chave dela não esteja neste servidor.

O motor existe para o vendedor que **não** tem conta business na Ramp. A confirmação do pagamento não vem de um aviso da Ramp. Vem da própria blockchain, lida pelo programa.

---

## 2. Uma cobrança do começo ao fim

Vale acompanhar um exemplo concreto antes de qualquer diagrama.

A Maria quer pagar R$ 150,00. A loja usa USDC na rede Polygon. USDC é uma stablecoin: cada unidade pretende valer um dólar. Polygon é uma rede blockchain compatível com Ethereum, onde a taxa de transação costuma ser baixa. A moeda nativa dela, usada para pagar essa taxa, chama-se POL.

O operador (a pessoa da loja) abre a tela de cadastro, informa o nome e o e-mail da Maria e depois abre a tela de cobrança. Escolhe o valor, o perfil "Polygon USDC" e a carteira fria de destino. O sistema devolve um link e um QR code.

Por baixo, neste instante, aconteceu o seguinte:

- O motor reservou o próximo número de uma sequência, o **índice**. Cada índice vira um endereço diferente, sempre o mesmo para aquele número. O endereço da Maria nesta cobrança não é escolhido por ela e não é reutilizado numa cobrança seguinte.
- Esse endereço foi colocado dentro da URL da Ramp, junto com o valor em reais.
- O banco guardou a cobrança com o estado `aguardando`.

A Maria abre o link no celular, paga em reais na Ramp, e a Ramp envia USDC para o endereço exclusivo. O motor não participou desse pagamento. Ele só observa.

A cada poucos segundos, um processo separado (o **worker**, o trabalhador de fundo) pergunta à rede: "chegou transferência de USDC para algum dos meus endereços?". Quando vê a da Maria, grava um pagamento `detectado`. Ainda não libera o crédito. Espera um número de confirmações (por padrão, 10 blocos já finalizados). Confirmação, aqui, significa que novos blocos foram empilhados em cima daquele pagamento, o que torna muito difícil a rede "desfazer" o que aconteceu.

Quando as confirmações bastam, o worker confere o recibo da transação. Recibo é o comprovante da rede de que a transação entrou num bloco e deu certo. Só então o crédito da Maria fica `liberado`.

O USDC ainda está no endereço temporário, não na carteira fria. Esse endereço nasceu sem POL, e sem POL ele não consegue pagar a taxa para enviar o USDC adiante. Uma segunda carteira, pequena e operacional, o **patrocinador de gas**, manda um pouco de POL para lá. Gas é o nome da taxa da rede. Aí o worker assina a transferência do USDC para a carteira fria. O POL que sobra volta para a carteira de gas, para a reserva da taxa se recompor.

O estado da cobrança passa a `movido`. A Maria está creditada. O valor está na carteira fria.

Se a Maria pagar a mais, o extra também é creditado e varrido. Se pagar menos, fora de uma tolerância pequena, o estado fica `parcial`: o que chegou é creditado e também é movido, mas o sistema avisa que não bateu com o valor cobrado. A regra do projeto é não recusar dinheiro que já chegou.

---

## 3. Palavras que vão voltar o tempo todo

Leia esta lista uma vez. O resto do texto usa esses nomes de propósito, sempre com o mesmo sentido.

**Blockchain.** Um livro-caixa público e compartilhado. Qualquer um pode ler. Alterar um lançamento antigo exige reescrever a história aceita pela rede, o que fica mais difícil a cada bloco novo.

**Endereço.** O "número de conta" nessa rede. No padrão usado aqui (EVM, o mesmo tipo de conta do Ethereum) ele começa com `0x` e tem 40 caracteres hexadecimais depois. Quem tem a chave privada daquele endereço pode gastar o que estiver nele. Quem só tem o endereço pode mandar valor para lá e ver o saldo.

**Chave privada.** O segredo que autoriza um gasto. Quem copia a chave privada controla o dinheiro. Ela não deve aparecer em tela, em log, em repositório git nem no processo que só atende o site.

**Seed (semente).** Uma frase de palavras da qual saem todas as chaves de uma carteira hierárquica. Perder a seed é perder o acesso a todos os endereços derivados dela. O motor pede que essa frase seja anotada offline uma única vez, na criação da carteira, e não a guarda no servidor que atende o site.

**Carteira HD.** Hierarchical Deterministic. Uma carteira que, a partir de uma semente, deriva muitos endereços de forma previsível: o índice 0 é sempre o mesmo endereço, o índice 1 é outro, e assim por diante. "Derivar" significa calcular o próximo endereço com uma fórmula pública, sem inventar um número ao acaso.

**xpub.** A chave pública estendida da conta. Com ela dá para calcular todos os endereços futuros, mas **não** dá para gastar. Ainda assim é um segredo: quem a tem vê todos os endereços que o motor vai usar. O servidor da API só precisa dela.

**xprv.** A chave privada estendida da mesma conta. Com ela dá para gastar em qualquer endereço derivado. Só o worker, o processo que move o dinheiro, abre esse segredo.

**Stablecoin.** Token cujo preço tenta acompanhar uma moeda fiduciária, em geral o dólar. Os perfis de exemplo do motor são USDC e USDT na Polygon.

**Token.** Um ativo emitido por um contrato na rede, diferente da moeda nativa (POL na Polygon, ETH na Ethereum). O USDC é um token do tipo ERC-20.

**Contrato.** Um programa que vive na blockchain. O contrato do USDC sabe quem tem quanto e obedece a ordens como "transfira da conta A para a conta B".

**Transação.** Uma ordem assinada e enviada à rede: transferir token, enviar POL, etc. Depois de incluída num bloco, ganha um identificador, o hash, que começa com `0x` e é longo.

**Gas.** A taxa paga à rede para executar a transação. Paga-se na moeda nativa, não em USDC. Por isso um endereço que só recebeu USDC fica parado até alguém enviar POL para ele.

**RPC.** O "balcão" de uma rede. O motor pergunta saldos, listas de transferências e envia transações por uma URL de RPC. Quem opera esse balcão enxerga o que o motor pergunta. Por isso, em produção, a URL precisa ser `https://` e, se possível, de um provedor que a loja controle. Dá para configurar um segundo RPC só para conferir o crédito.

**Carteira fria.** O destino final do valor. Tem de estar cadastrada numa tabela do banco. O motor recusa varrer para um endereço desconhecido.

**Patrocinador de gas.** Uma carteira pequena, separada da seed principal, que só existe para mandar POL aos endereços temporários. Se ela esvaziar, os pagamentos ficam recebidos e parados. O alerta da tela avisa isso.

**Centavos e base units.** O motor não usa número com vírgula para dinheiro. Real é guardado em centavos: R$ 150,00 é o inteiro `15000`. Token é guardado na menor unidade do contrato: 1 USDC, que tem 6 casas, é `1000000`. Isso evita o erro clássico de computador em que 0,29 vezes 100 vira 28,999.

**Perfil Ramp.** A ficha de "como cobrar": qual rede, qual token, qual contrato, qual moeda fiduciária, qual taxa de referência. "Polygon USDC" é um perfil. Não é a conta da Maria.

**Link.** Uma cobrança. Um link, um endereço, um cliente, um valor, um destino frio.

**Worker.** O processo que observa a rede e move o dinheiro. Não é o site.

**API.** O site e os endereços HTTP que as telas chamam. Ela cadastra, gera cobrança e mostra status. Ela não assina gasto.

---

## 4. As cinco peças e o que cada uma pode fazer

Pense no sistema como cinco peças que não devem trocar de papel.

### 4.1 As telas

Ficam na pasta `web/`. São duas páginas simples, sem framework e sem biblioteca baixada da internet no navegador.

- **Cadastro** (`/cadastro.html`): nome e e-mail do cliente.
- **Gerar cobrança** (`/cobranca.html`): busca o cliente, valor, perfil Ramp, carteira fria, e mostra o link, o QR e o andamento.

As duas pedem um token de acesso no topo. Esse token fica só na aba do navegador (sessionStorage), não num cookie enviado sozinho. Quem não tem o token vê a página, mas a página não consegue ler nem gravar nada.

### 4.2 A API

É o processo HTTP, iniciado por `src/server.ts`. Ela escuta pedidos, valida o token, grava cadastro e cobrança, e responde consultas.

Ela conhece o xpub, então sabe calcular o endereço de uma cobrança nova. Ela **não** abre o arquivo da chave privada, **não** guarda a chave do patrocinador de gas e **não** guarda o token de um assinador externo. Se alguém comprometer só esse processo, não leva embora a capacidade de gastar os endereços derivados. Gasta quem corre o worker.

Para o alerta de "o patrocinador está ficando sem POL", a API só precisa do endereço público dele, a variável `GAS_SPONSOR_ADDRESS`. Endereço público não autoriza gasto.

### 4.3 O worker

É o processo iniciado por `src/worker/index.ts`. Roda ao lado da API, não dentro dela. Num ciclo, a cada 15 segundos por padrão, ele:

1. Lê transferências novas nas redes configuradas.
2. Confirma as que já têm comprovante e confirmações suficientes.
3. Move para a carteira fria o que já foi pago e ainda está no endereço temporário.

Só pode haver um worker por banco. Ele pega um cadeado do Postgres (advisory lock). Se um segundo worker subir no mesmo banco, ele enxerga o cadeado ocupado e encerra. Isso evita duas varreduras mandando o mesmo dinheiro ao mesmo tempo.

### 4.4 O banco

Postgres. Guarda clientes, cobranças, pagamentos vistos, créditos, movimentos internos, perfis, carteiras frias, o ponto em que a leitura da rede parou, e um diário de auditoria.

Não guarda a seed. Não guarda o xprv. Nome e e-mail do cliente ficam cifrados. A busca por e-mail usa um índice cego, explicado no capítulo 8.

### 4.5 A blockchain

O motor não "é" a rede. Ele é cliente dela, via RPC. O valor de verdade está nos endereços. O banco é o caderno da loja: quem pagou, quanto, se já foi para a carteira fria. Se o caderno e a rede discordarem, a rede é a fonte do saldo; o caderno é a fonte do crédito contábil. O desenho tenta fazer os dois andarem juntos, e grita quando não consegue provar o pagamento.

```text
Operador no navegador
        |
        | token de acesso
        v
   API (site) ---- grava e lê ----> Postgres
        |
        | só calcula endereços (xpub)
        |
   Worker (fundo) -- lê e envia --> RPC da rede (Polygon, etc.)
        |
        | assina com o xprv, só aqui
        v
   Endereço temporário  --USDC-->  Carteira fria cadastrada
```

---

## 5. O que o cliente paga e o que a loja recebe

São duas camadas que muita gente mistura.

**A camada Ramp.** O cliente paga reais (ou outra moeda fiduciária) para a Ramp. A Ramp compra a stablecoin e envia para o endereço que estava no link. O motor não processa cartão, não guarda dados de pagamento da Ramp e não recebe um aviso dela. Ele só monta a URL.

**A camada on-chain.** "On-chain" quer dizer "registrado na blockchain". O motor só acredita no USDC (ou no token do perfil) que apareceu no endereço derivado, no contrato certo. Um e-mail da Ramp dizendo que pagou não entra neste sistema, porque o sistema não escuta a Ramp.

A taxa de referência do perfil serve para comparar o que foi cobrado com o que chegou. Exemplo do seed: `180000` base units de USDC por R$ 1,00, ou seja, 0,18 USDC por real. R$ 150,00 esperam 27 USDC. Essa taxa é uma referência da loja, não a cotação ao vivo da Ramp. Quando o câmbio muda, alguém atualiza a taxa. Cobranças já geradas guardam a taxa do momento em que nasceram, para a comparação não mudar no meio do caminho.

A tolerância padrão é 1%. Dentro dela, o estado pode ir a `pago`. Fora dela, `parcial`. Nos dois casos o crédito usa o valor que realmente chegou, não o valor "bonito" da cobrança.

---

## 6. Como nasce o endereço de cada cobrança

Esta é a decisão de segurança mais importante do desenho, e dá para entendê-la sem criptografia avançada.

A loja não cria uma carteira nova no celular para cada cliente. Ela tem uma semente. Dessa semente sai uma conta (o nível `m/44'/60'/0'` do padrão BIP-44, um acordo de mercado sobre como numerar endereços de Ethereum). Dessa conta saem endereços filhos: 0, 1, 2, 3...

O servidor que mostra o site só recebe o xpub dessa conta. Com o xpub ele calcula o endereço do índice 7, por exemplo, e coloca esse endereço no link. Ele não consegue mover o que cair ali.

O worker, em outra máquina ou pelo menos em outro processo, tem o xprv cifrado num arquivo (`data/keystore.json`). Na hora de varrer, ele deriva só a chave daquele índice, assina a transferência e segue. As chaves dos índices já usados não ficam numa lista permanente na memória: cada assinatura deriva de novo.

Regras que o código se recusa a afrouxar:

- O xpub tem de ser de conta (profundidade 3), não a chave-mestra da semente. A chave-mestra não consegue calcular esse caminho, e aceitá-la seria um erro silencioso perigoso.
- O xpub não pode ser um xprv. A seed não deve encostar no servidor dos endereços.
- Cada índice é usado no máximo uma vez, no banco inteiro, não "uma vez por perfil". Dois perfis não podem cair no mesmo endereço. O banco segura um cadeado na hora de reservar o próximo número. Se a criação da cobrança falha no meio, o número volta a ficar disponível, desde que nenhuma cobrança tenha ficado gravada com ele.
- Há um teto (`HD_MAX_INDEX`, padrão 100 mil) para ninguém pedir derivações sem fim.

O endereço que o cliente vê no link **não veio do cliente**. Veio dessa conta. Isso impede que alguém peça uma cobrança cujo destino seja a carteira dele e faça a loja achar que recebeu.

---

## 7. A vida de uma cobrança: os estados

Cada link tem um estado. Mudar de estado não é livre. Há uma tabela do que pode virar o quê. Se alguém pedir um pulo ilegal, o sistema responde erro e não grava.

| Estado | Em linguagem comum |
| --- | --- |
| `aguardando` | Cobrança criada. Ainda não há pagamento confirmado. |
| `pago` | Chegou um valor dentro da tolerância do que foi cobrado. |
| `parcial` | Chegou valor, mas fora da tolerância. O que chegou vale; a diferença fica visível no alerta. |
| `pago_sem_gas` | O token chegou, mas não há POL para movê-lo, ou o patrocinador falhou. O dinheiro está no endereço temporário. |
| `movido` | O token foi para a carteira fria, com prova, ou já havia uma varredura confirmada. |
| `expirado` | Marcado como fora do prazo. Se mesmo assim chegar dinheiro, o estado pode voltar a `pago` ou `parcial`. O prazo sozinho não apaga pagamento. |
| `revogado` | A cobrança foi desfeita como pedido. Se o dinheiro aparecer, ele ainda é reconhecido. |

O campo `expiraEm` (padrão 72 horas) é gravado na criação. Ele informa a validade combinada do link. O motor não transforma sozinho `aguardando` em `expirado` quando o relógio passa: o prazo é dado para a operação, não uma guilhotina que recusa USDC atrasado.

`movido` pode voltar para `pago` ou `aguardando` se a rede desfizer o bloco (um reorg, explicado no capítulo 10) ou se o endereço temporário voltar a ter saldo. A ideia é não dar o assunto por encerrado se o dinheiro reapareceu.

---

## 8. O que fica no banco, e o que não fica em texto puro

### Clientes

Nome e e-mail são cifrados com AES-256-GCM antes de tocar o banco. Em termos simples: só abre quem tem a chave de 32 bytes (`DATA_ENCRYPTION_KEY`), e o cofre de cada registro está amarrado ao identificador daquele cliente. Copiar o cofre de uma linha para outra não abre, porque o lacre não bate.

A tela, por padrão, mostra máscara: `Maria Silva` vira algo como `M*** S***`, e o e-mail vira `m***@e***.com`. Ver o dado completo é um pedido explícito (`reveal`) e esse pedido entra na auditoria. O token só de leitura não pode revelar.

Buscar por e-mail sem guardar o e-mail em claro usa um **índice cego**. É um carimbo HMAC: a mesma chave e o mesmo e-mail produzem sempre o mesmo carimbo, e o carimbo não deixa ler o e-mail de volta. O banco guarda o carimbo. A busca calcula o carimbo do que foi digitado e compara.

Como um carimbo não preserva "começa com mar...", o autocomplete guarda um carimbo para cada prefixo do e-mail, do 3º ao 32º caractere. É um compromisso conhecido: dá para buscar enquanto se digita, e o tamanho do e-mail fica visível para quem lê essa tabela. O texto do e-mail, não.

### Cobrança e dinheiro

O link guarda valor em centavos, token esperado, índice, endereço, caminho de derivação, URL da Ramp, carteira fria escolhida naquele momento, estado e validade.

O pagamento visto na rede guarda hash da transação, índice do log, de quem, para quem, valor, bloco e confirmações. O par hash + índice do log é único: ver o mesmo evento duas vezes não credita duas vezes.

O crédito guarda o valor em base units e, quando há taxa, o equivalente em centavos. Centavos aqui cabem em inteiro grande (`bigint`), para um pagamento alto não estourar a coluna e travar a fila inteira.

O movimento interno é a varredura: de qual endereço, para qual carteira, valor, hash, estado, nonce. Nonce é o número de ordem das transações daquele endereço: 0, depois 1, depois 2. Duas varreduras com o mesmo nonce seriam a mesma ordem lógica, e o banco não deixa duplicar.

### O que não está no banco

- A seed.
- O xprv (fica no keystore cifrado em disco, lido só pelo worker).
- A chave do patrocinador de gas (fica na variável de ambiente do worker).
- A chave de API da Ramp em texto puro, se alguém configurar uma. Ela é cifrada. A URL gravada da cobrança também não leva essa chave; a URL completa só é remontada para quem tem o token de administrador.

---

## 9. As telas, do ponto de vista de quem opera

Você cola o token e clica em conectar. O sistema responde se o token é de administração ou só de leitura.

No cadastro, nome e e-mail seguem para a API. A resposta não devolve o e-mail de novo em claro: quem digitou já sabe o que digitou. A lista mostra máscaras.

Na cobrança, a busca por e-mail começa a partir de 3 caracteres e também mostra máscara. Só o clique pede o e-mail completo, e isso fica auditado.

O valor é digitado como dinheiro de verdade (`150,00` ou `150.00`). A API converte para centavos sem usar conta de número decimal solto.

A carteira de destino é uma carteira **já cadastrada**. Dá para escolher na lista ou colar o `0x`, mas colar um endereço que não está no cadastro produz erro. Isso é de propósito. Um campo livre aceitaria qualquer destino, e um token vazado passaria a escolher para onde o dinheiro vai.

O resultado mostra o link da Ramp, o endereço derivado, o valor e o QR. O QR é gerado no servidor, não por um script de terceiros no navegador. A página só embute a imagem.

A mesma tela passa a consultar o status daquela cobrança de tempos em tempos, e mostra uma lista de alertas: pagamento parcial, falta de gas, patrocinador vazio, e outros avisos operacionais.

A porta do cliente é outra. A página inicial tem **Login** e **Inscreva-se**. A conta é usuário (ou e-mail) e senha, conferidos no banco, sem o token da loja. Depois de entrar, a pessoa altera os próprios dados, informa um valor em reais e envia: o motor gera a cobrança e abre o checkout da Ramp. Embaixo, em vermelho, **Deletar conta** pede confirmação. Se ainda houver cobrança em andamento, a exclusão é recusada. A área da loja continua em `/cadastro.html`, fora desse fluxo.

---

## 10. Como o worker decide que o pagamento é real

Este capítulo é o coração do "não temos webhook".

### O que ele procura

Para cada par rede + contrato de token usado por algum perfil, o worker pede os logs de `Transfer`. Log, aqui, é o registro que o contrato emite quando o saldo muda de dono: "fulano mandou tanto para ciclano". O filtro pede só os eventos cujo destino é um endereço de cobrança nosso.

Ele ignora evento marcado como removido (a rede desistiu daquele bloco) e ignora evento cujo contrato não é o do perfil. Ver "USDC" escrito num log de outro contrato não conta.

### Até onde ele lê

A leitura anda para a frente com um cursor: "já li até o bloco N". O próximo ciclo começa em N+1. O tamanho de cada passo é `MONITOR_BLOCK_RANGE` (padrão 2000 blocos). Se o RPC recusar uma faixa grande, o worker diminui a faixa e não avança o cursor além do que realmente leu. Pular bloco seria perder pagamento.

O teto padrão é o bloco `finalized`. Na Polygon, bloco finalizado é um bloco que a rede já considerou assentado. Ler só até ali atrasa um pouco e evita tratar como pago um bloco que ainda pode ser reescrito.

Se ainda não existe cursor e `MONITOR_START_BLOCK` é maior que zero, a primeira leitura começa nesse bloco, não "só na última hora". Se o start continua 0, a primeira leitura olha a janela recente. Pagamento mais antigo do que essa janela, num link que segue `aguardando` e mesmo assim tem saldo, entra numa segunda busca, para trás, até `MONITOR_BACKFILL_BLOCKS` (padrão 100 mil blocos), só daqueles endereços. Se há saldo e mesmo assim nenhum log, o sistema **não inventa crédito**. Ele grava um alerta: saldo sem log.

### Quando vira crédito

Estar detectado não basta. O worker espera as confirmações (`CONFIRMATIONS_REQUIRED`, padrão 10), contadas na mesma cabeça de bloco da leitura. Depois pede o recibo da transação e exige que o mesmo log continue lá, com sucesso.

Se existir uma segunda URL, `RPC_URL_POLYGON_CONFIRM` (o nome muda com a rede), o recibo e o saldo precisam concordar nos dois balcões. Sem essa variável, vale um RPC só. Em produção esse RPC tem de ser `https://`.

Cada pagamento é confirmado no seu próprio trato. Um registro quebrado vai para a lista de erros do ciclo; os outros seguem. Antes, um único valor grande demais podia derrubar a fila inteira.

### Reorg

Reorg é a rede trocar a ponta da história: blocos que pareciam aceitos deixam de ser a versão vencedora. O worker guarda, de tempos em tempos, o hash de um bloco (a impressão digital daquele bloco). Se a rede passar a responder outro hash para o mesmo número, houve reorg. O cursor volta até um ancestral ainda válido, pagamentos e créditos da região perdida são revertidos, e uma varredura que estava naquela região deixa de contar como feita. Se o dinheiro reaparecer num bloco novo, ele é detectado de novo.

Falhar a checagem de reorg não é tratado como "está tudo bem". O ciclo registra o problema em vez de fingir que a história antiga continua válida sem olhar.

---

## 11. Como o valor sai do endereço temporário

Quando o link está `pago`, `parcial` ou `pago_sem_gas`, o worker tenta a varredura.

Passos, na ordem em que importam para quem opera:

1. Lê o saldo real do token no endereço. Saldo zero não é tratado como "já foi para a carteira fria" só porque o número de transações daquele endereço aumentou. Sem uma varredura confirmada no banco, o estado não vira `movido`. Vira alerta `sweep.sem_prova`. Melhor preso e visível do que dado como entregue sem destinatário.
2. Confere de novo se o destino gravado na cobrança ainda é uma carteira fria cadastrada naquela rede. Se alguém alterar a linha no banco para um endereço qualquer, a assinatura não sai. O movimento fica `falhou` e há registro de auditoria `sweep.destino_recusado`.
3. Se falta POL, o patrocinador envia a quantia configurada (padrão 0,5 POL) desde que o destino tenha menos que o piso (padrão 0,1 POL). O envio usa a carteira conectada ao RPC de verdade. O hash desse patrocínio fica anotado: enquanto o recibo não chega, não sai outro envio para o mesmo endereço. Outro envio só ocorre se o recibo mostrar falha, ou se depois do sucesso o saldo continuar abaixo do piso.
4. Monta a chamada `transfer` do ERC-20: "mande este saldo para a carteira fria". Assina. Grava a transação assinada **antes** de transmitir, para um desligamento no meio não fazer o sistema assinar outra ordem com o mesmo nonce.
5. Transmite, espera o recibo e marca `movido`.
6. Se sobrou POL, devolve esse troco para a carteira de gas. Falhar nesse troco não desfaz a varredura do token: o USDC já está na carteira fria. Sem `GAS_SPONSOR_ADDRESS`, o POL fica no endereço da cobrança.

Há três jeitos de assinar, escolhidos por `SIGNER_MODE`:

- **local.** O worker abre o keystore com `SIGNER_PASSPHRASE`. Serve para desenvolvimento e operação pequena. Em produção a senha precisa ter pelo menos 16 caracteres.
- **remote.** O worker manda a transação pronta para um serviço externo (cofre, HSM, custódia) e só transmite se a resposta assinada for exatamente a ordem pedida: mesmo destino, valor, nonce, rede e dados. A chave não passa por este processo. Em produção a URL tem de ser `https://` e o token desse serviço é obrigatório.
- **psbt.** O worker não assina. Ele deixa a ordem pendente para uma pessoa assinar numa hardware wallet (Ledger, Trezor ou equivalente) e devolver o bruto assinado em `POST /api/movimentos/:id/raw`. O sistema só transmite se o bruto bater com a ordem guardada.

O modo local confere, na subida, se o keystore e o `HD_XPUB` são a mesma conta. Se não forem, o worker recusa começar. Sem isso, a API criaria endereços que o assinador não consegue esvaziar, e o dinheiro ficaria preso para sempre.

---

## 12. Quem pode fazer o quê

Não há usuário e senha de cada operador. Há um segredo compartilhado, o `ADMIN_TOKEN`, enviado em cada pedido como `Authorization: Bearer ...`. Quem tem esse token administra: cadastra, cobra, cadastra carteira fria, muda taxa e perfil.

Há um token opcional de leitura, `READONLY_TOKEN`. Ele pode consultar. Não pode gravar, não pode revelar nome e e-mail completos, e na consulta de uma cobrança não recebe o caminho de derivação nem a transação ainda não assinada.

Comparar o token não vaza o tamanho dele pelo tempo de resposta: os dois lados são passados por um HMAC e só então comparados. HMAC, aqui, é um carimbo que depende de uma chave fixa do processo; comprimentos diferentes viram carimbos do mesmo tamanho.

Dez falhas de autenticação no mesmo IP, dentro de um minuto, passam a receber "muitas tentativas", além do limite geral de 120 pedidos por minuto. O IP usado é o da conexão direta, a menos que `TRUST_PROXY` esteja ligado. Só ligue isso atrás de um proxy reverso que você controla. Ligado no vazio, qualquer cliente inventa o IP.

Em produção o sistema recusa subir se o token for o texto de exemplo do `.env.example` ou tiver menos de 32 caracteres.

O diário de auditoria é uma cadeia: cada evento inclui o carimbo do anterior. O carimbo não é uma simples colagem dos campos com uma barra no meio, porque isso permitiria dois conteúdos diferentes caírem no mesmo carimbo. Cada campo entra com o próprio tamanho. A cadeia mora no banco. Quem já pode reescrever o banco pode reescrever a cadeia. Ela pega alteração acidental e edição ingênua; não substitui uma cópia do carimbo fora do servidor.

---

## 13. Alertas: o que exige gente

O worker age sozinho no caminho feliz. Estes casos pedem uma pessoa:

- **Pagamento parcial.** Chegou diferente do cobrado. O crédito é o valor recebido. Alguém decide se cobra o resto por outro meio.
- **Pago sem gas.** O token está no endereço temporário e não há como movê-lo. Em geral o patrocinador está vazio ou não foi configurado. Recarregar a carteira do patrocinador destrava.
- **Destino recusado.** A carteira fria daquela cobrança não está mais no cadastro. O token fica parado até alguém cadastrar de novo aquele endereço, de propósito.
- **Saldo sem log.** Há token no endereço e o worker não achou a transferência na janela que releu. Não há crédito automático. Alguém olha o endereço num explorador de blocos (Polygonscan, por exemplo).
- **Saldo sem prova de varredura.** O token sumiu do endereço, o contador de transações andou, e não há varredura confirmada para a carteira fria. O sistema não finge que deu certo.
- **Patrocinador baixo.** O alerta de saldo usa o endereço público. Sem `GAS_SPONSOR_ADDRESS`, a API não consulta esse saldo, mesmo que o worker tenha a chave.

---

## 14. Subir o sistema pela primeira vez

Quem prefere um passo só, na raiz do repositório:

```bash
python3 start.py
```

O script gera os três segredos, sobe o banco, cria a carteira HD e a carteira de POL, pede o endereço da carteira fria e mostra o endereço para o POL. Aguarda até 15 minutos por esse saldo e, em seguida, sobe a API e o worker. Não há outro comando.

Isto é o caminho de desenvolvimento, na máquina de quem está aprendendo o projeto. Produção repete as mesmas peças com segredo forte, RPC próprio, TLS na frente do site e banco que não escuta a internet aberta.

Pré-requisitos: Node.js 22 ou mais novo, Docker, e um RPC. O de exemplo aponta para um serviço público, que funciona e é limitado.

1. Suba só o banco: `docker compose up -d db`. A porta fica em `127.0.0.1:5432`, isto é, só nesta máquina. A senha do compose é de desenvolvimento. Não é senha de produção.
2. `npm install` e copie `.env.example` para `.env`.
3. Gere três segredos e cole no `.env`:
   - `DATA_ENCRYPTION_KEY` e `DATA_INDEX_KEY`, cada um com `openssl rand -base64 32`
   - `ADMIN_TOKEN` com `openssl rand -hex 32`
4. Crie a carteira: `npm run wallet:init -- --passphrase "uma senha longa" --show-seed`. Anote a seed offline agora. O comando imprime o xpub. Esse xpub vai em `HD_XPUB`. O arquivo cifrado fica em `data/keystore.json`, com permissão de leitura só para o dono do arquivo. A mesma senha vai em `SIGNER_PASSPHRASE`, senão o worker não abre o cofre.
5. Se for usar varredura automática, crie uma carteira **separada** só para gas. A chave privada dela vai em `GAS_SPONSOR_PRIVATE_KEY` no ambiente do worker. O endereço público vai em `GAS_SPONSOR_ADDRESS` para a API mostrar o saldo. Se os dois existirem e não forem o mesmo par, o worker recusa subir.
6. Ponha o endereço da carteira fria em `COLD_WALLET_ADDRESS`.
7. `npm run migrate` cria as tabelas. `npm run seed` cria os perfis Polygon USDC e USDT e a carteira fria, se o endereço estiver no `.env`.
8. Dois terminais: `npm run dev` para a API (porta 4578) e `npm run worker` para a observação e a varredura.

Abra `http://localhost:4578`, cole o token, cadastre um cliente de teste e gere uma cobrança. Sem worker, a cobrança existe e o pagamento real não será visto. Sem patrocinador, um pagamento real pode ficar em `pago_sem_gas`.

Atualizar a taxa de referência dos perfis já criados: mude `SEED_USDC_POR_BRL` ou `SEED_USDT_POR_BRL` e rode `npm run seed -- --update-rates`, ou use a rota de atualização do perfil.

---

## 15. O mapa do repositório, para quando você abrir o código

Agora sim. A ordem sugerida de leitura é a ordem em que o dinheiro anda, não a ordem alfabética.

| Quando você quiser entender... | Comece por |
| --- | --- |
| A história inteira num arquivo só | este guia |
| Como a API e o worker sobem diferentes | `src/bootstrap.ts`, `src/server.ts`, `src/worker/index.ts` |
| O que é configurável e o que a produção recusa | `src/core/config.ts` e `.env.example` |
| A regra de "não escolher o endereço do cliente" | `src/core/services/link-service.ts` e `src/core/hd/hd-wallet.ts` |
| A URL da Ramp | `src/core/ramp/link-builder.ts` |
| Estados permitidos | `src/core/domain/link-state.ts` |
| Conta de dinheiro sem vírgula flutuante | `src/core/domain/money.ts` |
| Ver o pagamento na rede | `src/core/chain/monitor.ts` |
| Mover para a carteira fria | `src/core/chain/sweeper.ts` e `src/core/chain/gas-sponsor.ts` |
| Assinar ou recusar assinar | `src/core/signer/` |
| Cifrar nome e e-mail | `src/core/crypto/cipher.ts` e `src/core/services/customer-service.ts` |
| Tabelas | `src/adapters/db/schema.ts` e `db/migrations/` |
| O que a tela pode pedir | `src/adapters/http/routes.ts` e `src/adapters/http/auth.ts` |
| As telas | `web/cadastro.html`, `web/cobranca.html` |

O núcleo em `src/core` não importa o framework HTTP nem o driver do banco. Ele recebe interfaces (portas). Os adaptadores em `src/adapters` são quem fala Postgres e HTTP. Isso permite testar a regra de negócio com repositórios falsos, sem subir banco, e é por isso que `npm test` cobre tanta regra sem Polygon de verdade.

Há um segundo nível de documentação já no repositório, mais curto e mais de operador: `README.md`. Há também `ENDURECIMENTO.md` e `PLANO.md`, que registram decisões de correção. Eles assumem que você já sabe o que o motor é. Este guia é o que vem antes deles.

---

## 16. O que o sistema não faz

Dizer a borda evita esperar mágica.

- Não é exchange, não custodia real do cliente final e não fala com banco.
- Não recebe webhook da Ramp e não confirma pagamento por e-mail ou print.
- Não escolhe sozinho a cotação do dia. A taxa do perfil é configurada por alguém.
- Não expira sozinho a cobrança quando o relógio passa. Dinheiro atrasado ainda é dinheiro.
- Não varre para um endereço que não esteja cadastrado como carteira fria.
- Não mantém a chave que gasta dentro do processo do site.
- Não transforma um único RPC mentiroso em verdade absoluta. Um segundo RPC é opcional e, se você não configurar, o primeiro continua sendo a fonte. Escolha esse primeiro com o mesmo cuidado com que escolheria o banco onde deixa o extrato.
- Não tem um login por pessoa. O token de administrador é compartilhado. Quem o tem faz tudo o que a API deixa fazer. Troca e guarda desse token são trabalho da operação, não um recurso automático do código.
- Não ancora o diário de auditoria fora do banco.

---

## 17. Um jeito curto de explicar para outra pessoa

Se você precisar contar o sistema em um minuto:

> A loja não tem conta empresarial na Ramp, então ninguém avisa quando o cliente paga. O Motor Cripto gera um endereço novo para cada cobrança, observa a blockchain até o stablecoin cair ali, anota o crédito e empurra o valor para uma carteira fria cadastrada. O site só sabe calcular endereços. Quem pode gastar é um processo separado. Nome e e-mail ficam cifrados. O sistema prefere deixar valor parado e visível a dar como recebido algo que não conseguiu provar.

Se essa frase ainda estiver de pé depois de você ler o código, o mapa estava certo.
