/**
 * Tipos de dominio do motor. Independentes de HTTP e de banco.
 *
 * Convencao de dinheiro:
 *  - fiat   -> centavos (inteiro). `valor_fiat_centavos = 12345` => R$ 123,45
 *  - token  -> base units (bigint).  `1 USDC (6 decimais)` => 1000000n
 * Nunca usar float para dinheiro.
 */

export const LINK_STATUS = [
  'aguardando',
  'pago',
  'parcial',
  'pago_sem_gas',
  'movido',
  'expirado',
  'nao_realizado',
] as const;
export type LinkStatus = (typeof LINK_STATUS)[number];

/** Estados finais para efeito de webhook/contrato com o cliente. */
export const LINK_FINAL_STATUS = ['pago', 'pago_sem_gas', 'movido', 'nao_realizado'] as const;
export type LinkFinalStatus = (typeof LINK_FINAL_STATUS)[number];

export const NAO_REALIZADO_MOTIVO = [
  'nao_pago',
  'valor_parcial',
  'pagamento_apos_prazo',
  'revogado',
  'reorg',
] as const;
export type NaoRealizadoMotivo = (typeof NAO_REALIZADO_MOTIVO)[number];

export const PAYMENT_STATUS = ['detectado', 'confirmado', 'revertido'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUS)[number];

export const TRANSFER_STATUS = [
  'pendente',
  'patrocinado',
  'enviado',
  'confirmado',
  'falhou',
] as const;
export type TransferStatus = (typeof TRANSFER_STATUS)[number];

export const API_CLIENT_STATUS = ['ativo', 'inativo'] as const;
export type ApiClientStatus = (typeof API_CLIENT_STATUS)[number];

export const PARAM_STYLE = ['legacy', 'unified'] as const;
export type ParamStyle = (typeof PARAM_STYLE)[number];

export const WEBHOOK_EVENT_TYPE = ['realizado', 'nao_realizado'] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPE)[number];

export const WEBHOOK_STATUS = ['pendente', 'entregue', 'falhou'] as const;
export type WebhookStatus = (typeof WEBHOOK_STATUS)[number];

export type ApiClient = {
  id: string;
  nome: string;
  /** Prefixo publico da chave, para exibir no admin sem revelar o segredo. */
  apiKeyPrefix: string;
  /** SHA-256 hex da API key. A chave em claro nunca e persistida. */
  apiKeyHash: string;
  webhookUrl: string;
  /** Segredo HMAC dos webhooks. Fica cifrado em repouso. */
  webhookSecret: string;
  /** Segredo HMAC das requisicoes da API. Fica cifrado em repouso. */
  requestSecret: string;
  status: ApiClientStatus;
  criadoEm: Date;
};

export type ApiClientWallet = {
  id: string;
  apiClienteId: string;
  label: string;
  chain: string;
  address: string;
  criadoEm: Date;
};

export type RampProfile = {
  id: string;
  label: string;
  chain: string;
  asset: string;
  tokenContract: string;
  decimals: number;
  fiatCurrency: string;
  baseUrl: string;
  paramStyle: ParamStyle;
  hostAppName: string;
  hostLogoUrl?: string | null;
  /**
   * Taxa de referencia: quantos base units do token valem 1,00 unidade fiat.
   * `null` = sem referencia (o motor nao consegue classificar valor parcial).
   */
  taxaTokenPorFiatBaseUnits: bigint | null;
  /** Chave de asset no formato unificado da Ramp (ex.: POLYGON_USDC). */
  rampAssetKey?: string | null;
  /** Presente apenas em operacoes internas; nunca devolvido pela API. */
  hostApiKey?: string | null;
  criadoEm: Date;
};

export type PaymentLink = {
  id: string;
  apiClienteId: string;
  /** Identificador do pedido no sistema do cliente (idempotente por cliente). */
  externalId: string;
  /** Chave de idempotencia usada na criacao (header ou external_id). */
  idempotencyKey: string;
  /** SHA-256 do payload canonico, para detectar reuso indevido da chave. */
  requestHash: string;
  rampProfileId: string;
  chain: string;
  asset: string;
  tokenContract: string;
  decimals: number;
  moedaFiat: string;
  valorFiatCentavos: number;
  valorFiatUnidades: number;
  /**
   * Taxa usada no instante da criacao do link: quantos base units do token
   * valem 1,00 unidade de fiat. `null` = sem referencia.
   */
  taxaTokenPorFiatBaseUnits: bigint | null;
  /** Snapshot do valor esperado em base units, calculado com a taxa acima. */
  expectedBaseUnits: bigint | null;
  indiceHd: number;
  caminhoDerivacao: string;
  enderecoDeposito: string;
  /** Carteira allowlisted do cliente que recebe o sweep. */
  walletAddress: string;
  /** Token opaco da pagina publica (segredo bearer). */
  pageToken: string;
  /** SHA-256 hex do page token; e o que fica indexado para lookup. */
  pageTokenHash: string;
  /** URL oficial da Ramp. Nunca sai em resposta de API; so na pagina publica. */
  rampUrl: string;
  status: LinkStatus;
  motivoNaoRealizado: NaoRealizadoMotivo | null;
  /** Soma confirmada on-chain no momento da liquidacao. */
  valorRecebidoBaseUnits: bigint;
  /** True quando os fundos recebidos foram/estao sendo varridos ao cliente. */
  reembolsado: boolean;
  /** Fim da pagina/widget (60 min por padrao). */
  expiraEm: Date;
  /** Fim da janela de verificacao on-chain (1 dia corrido por padrao). */
  liquidacaoAte: Date;
  criadoEm: Date;
  // joins
  rampProfile?: RampProfile;
  totalRecebidoBaseUnits?: bigint;
};

export type Payment = {
  id: string;
  linkId: string;
  txHash: string;
  logIndex: number;
  deAddress: string;
  paraAddress: string;
  token: string;
  valorBaseUnits: bigint;
  confirmacoes: number;
  bloco: number;
  status: PaymentStatus;
  detectadoEm: Date;
  confirmadoEm?: Date | null;
};

/**
 * Tipo do movimento interno. Separa o sweep principal do token, o retorno
 * de gas nativo (dust) e a recuperacao sintetica de um sweep que chegou a
 * ser transmitido mas nao foi registrado antes de um crash.
 */
export type TransferKind = 'sweep' | 'dust' | 'recovery';

export type InternalTransfer = {
  id: string;
  linkId: string;
  deAddress: string;
  paraAddress: string;
  valorBaseUnits: bigint;
  txHash: string | null;
  status: TransferStatus;
  erro?: string | null;
  /** C5: chain e bloco do sweep (null enquanto pendente de minacao). */
  chain: string;
  bloco: number | null;
  /** D4: nonce do endereco derivado neste sweep. */
  nonce: number | null;
  kind: TransferKind;
  /** Raw assinada, persistida antes do broadcast para recuperacao. */
  rawTransaction: string | null;
  /** JSON da transacao unsigned no modo PSBT, aguardando assinatura manual. */
  unsignedTransaction: string | null;
  criadoEm: Date;
};

export type ChainCursor = {
  chain: string;
  tokenContract: string;
  ultimoBloco: number;
  hashBloco: string | null;
};

/** C2: ancora esparsa de hash de bloco, usada para achar o ancestral comum. */
export type ChainAnchor = {
  chain: string;
  tokenContract: string;
  bloco: number;
  hashBloco: string;
};

export type WebhookEvent = {
  id: string;
  apiClienteId: string;
  linkId: string;
  eventType: WebhookEventType;
  /** JSON serializado exatamente como foi (ou sera) enviado. */
  payload: string;
  status: WebhookStatus;
  attempts: number;
  nextAttemptEm: Date;
  lastError: string | null;
  deliveredEm: Date | null;
  criadoEm: Date;
};

export type AuditEvent = {
  id: string;
  ator: string;
  acao: string;
  entidade: string;
  entidadeId: string | null;
  detalhes: Record<string, unknown> | null;
  ip: string | null;
  criadoEm: Date;
};
