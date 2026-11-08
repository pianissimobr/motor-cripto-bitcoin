=== LibreFlow Pay para WooCommerce ===
Requires at least: 6.0
Requires PHP: 7.4
Stable tag: 0.1.0
License: GPL-2.0-or-later

Receba em Pix e Bitcoin, liquidado em dólar digital (USDC) direto na sua carteira.

== Instalação ==
1. Plugins → Adicionar novo → Enviar plugin → escolha o .zip.
2. WooCommerce → Configurações → Pagamentos → LibreFlow Pay.
3. Cole a chave de loja e o segredo IPN (painel → Integração e API) e salve: o plugin testa a conexão.
4. Use a chave de teste para homologar (a página de pagamento tem "Simular pagamento").

== Como funciona ==
* No checkout, o plugin cria a fatura e leva o cliente para a página de pagamento.
* Quando o pagamento é confirmado, a LibreFlow avisa a loja (IPN assinado) e o pedido vira "Processando".
* O aviso é conferido pela assinatura e a fatura é consultada de novo na API antes de mudar o pedido.
