import type {
  ApiClient,
  ApiClientWallet,
  AuditEvent,
  InternalTransfer,
  Payment,
  PaymentLink,
  RampProfile,
  WebhookEvent,
} from '../../core/domain/types.js';

export function linkDto(link: PaymentLink, pageUrl?: string) {
  return {
    id: link.id,
    external_id: link.externalId,
    status: link.status,
    motivo_nao_realizado: link.motivoNaoRealizado,
    valor_fiat_centavos: link.valorFiatCentavos,
    moeda_fiat: link.moedaFiat,
    chain: link.chain,
    asset: link.asset,
    token_contract: link.tokenContract,
    decimals: link.decimals,
    expected_base_units: link.expectedBaseUnits?.toString() ?? null,
    valor_recebido_base_units: link.valorRecebidoBaseUnits.toString(),
    endereco_deposito: link.enderecoDeposito,
    wallet_address: link.walletAddress,
    expira_em: link.expiraEm.toISOString(),
    liquidacao_ate: link.liquidacaoAte.toISOString(),
    reembolsado: link.reembolsado,
    criado_em: link.criadoEm.toISOString(),
    ...(pageUrl ? { page_url: pageUrl } : {}),
  };
}

export function adminClientDto(client: ApiClient) {
  return {
    id: client.id,
    nome: client.nome,
    api_key_prefix: client.apiKeyPrefix,
    webhook_url: client.webhookUrl,
    status: client.status,
    criado_em: client.criadoEm.toISOString(),
  };
}

export function walletDto(wallet: ApiClientWallet) {
  return {
    id: wallet.id,
    api_cliente_id: wallet.apiClienteId,
    label: wallet.label,
    chain: wallet.chain,
    address: wallet.address,
    criado_em: wallet.criadoEm.toISOString(),
  };
}

export function rampProfileDto(profile: RampProfile) {
  return {
    id: profile.id,
    label: profile.label,
    chain: profile.chain,
    asset: profile.asset,
    token_contract: profile.tokenContract,
    decimals: profile.decimals,
    fiat_currency: profile.fiatCurrency,
    base_url: profile.baseUrl,
    param_style: profile.paramStyle,
    host_app_name: profile.hostAppName,
    host_logo_url: profile.hostLogoUrl ?? null,
    ramp_asset_key: profile.rampAssetKey ?? null,
    taxa_token_por_fiat_base_units:
      profile.taxaTokenPorFiatBaseUnits?.toString() ?? null,
    criado_em: profile.criadoEm.toISOString(),
  };
}

export function paymentDto(payment: Payment) {
  return {
    id: payment.id,
    link_id: payment.linkId,
    tx_hash: payment.txHash,
    log_index: payment.logIndex,
    de_address: payment.deAddress,
    para_address: payment.paraAddress,
    token: payment.token,
    valor_base_units: payment.valorBaseUnits.toString(),
    confirmacoes: payment.confirmacoes,
    bloco: payment.bloco,
    status: payment.status,
    detectado_em: payment.detectadoEm.toISOString(),
    confirmado_em: payment.confirmadoEm?.toISOString() ?? null,
  };
}

export function transferDto(transfer: InternalTransfer) {
  return {
    id: transfer.id,
    link_id: transfer.linkId,
    de_address: transfer.deAddress,
    para_address: transfer.paraAddress,
    valor_base_units: transfer.valorBaseUnits.toString(),
    tx_hash: transfer.txHash,
    status: transfer.status,
    erro: transfer.erro ?? null,
    chain: transfer.chain,
    bloco: transfer.bloco,
    nonce: transfer.nonce,
    kind: transfer.kind,
    criado_em: transfer.criadoEm.toISOString(),
  };
}

export function webhookDto(event: WebhookEvent) {
  return {
    id: event.id,
    api_cliente_id: event.apiClienteId,
    link_id: event.linkId,
    event_type: event.eventType,
    status: event.status,
    attempts: event.attempts,
    next_attempt_em: event.nextAttemptEm.toISOString(),
    last_error: event.lastError,
    delivered_em: event.deliveredEm?.toISOString() ?? null,
    criado_em: event.criadoEm.toISOString(),
  };
}

export function auditDto(event: AuditEvent) {
  return {
    id: event.id,
    ator: event.ator,
    acao: event.acao,
    entidade: event.entidade,
    entidade_id: event.entidadeId,
    detalhes: event.detalhes,
    ip: event.ip,
    criado_em: event.criadoEm.toISOString(),
  };
}
