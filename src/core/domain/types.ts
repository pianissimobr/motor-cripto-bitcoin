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
  'revogado',
] as const;
export type LinkStatus = (typeof LINK_STATUS)[number];

export const PAYMENT_STATUS = ['detectado', 'confirmado', 'revertido'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUS)[number];

export const CREDIT_STATUS = ['pendente', 'liberado', 'revertido'] as const;
export type CreditStatus = (typeof CREDIT_STATUS)[number];

export const TRANSFER_STATUS = [
  'pendente',
  'patrocinado',
  'enviado',
  'confirmado',
  'falhou',
] as const;
export type TransferStatus = (typeof TRANSFER_STATUS)[number];

export const CUSTOMER_STATUS = ['ativo', 'inativo'] as const;
export type CustomerStatus = (typeof CUSTOMER_STATUS)[number];

export const PARAM_STYLE = ['legacy', 'unified'] as const;
export type ParamStyle = (typeof PARAM_STYLE)[number];

export type Customer = {
  id: string;
  nome: string;
  email: string;
  emailMasked: string;
  nomeMasked: string;
  status: CustomerStatus;
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
   * `null` = sem referencia (o motor credita apenas o valor efetivamente
   * recebido, sem poder marcar o link como parcial).
   */
  taxaTokenPorFiatBaseUnits: bigint | null;
  /** Chave de asset no formato unificado da Ramp (ex.: POLYGON_USDC). */
  rampAssetKey?: string | null;
  /** Presente apenas em operacoes internas; nunca devolvido pela API. */
  hostApiKey?: string | null;
  criadoEm: Date;
};

export type ColdWallet = {
  id: string;
  label: string;
  address: string;
  chain: string;
  criadoEm: Date;
};

export type PaymentLink = {
  id: string;
  clienteId: string;
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
   * valem 1,00 unidade de fiat. `null` = sem referencia (credita so o
   * valor efetivamente recebido).
   */
  taxaTokenPorFiatBaseUnits: bigint | null;
  /** Snapshot do valor esperado em base units, calculado com a taxa acima. */
  expectedBaseUnits: bigint | null;
  indiceHd: number;
  caminhoDerivacao: string;
  enderecoDeposito: string;
  /**
   * A1: carteira fria de destino, snapshot da criacao do link.
   * `null` para links legados (o sweeper cai no fallback por chain).
   */
  carteiraFriaId: string | null;
  carteiraFriaEndereco: string | null;
  rampUrl: string;
  status: LinkStatus;
  expiraEm: Date;
  criadoEm: Date;
  // joins
  rampProfile?: RampProfile;
  totalRecebidoBaseUnits?: bigint;
  creditoCentavos?: number;
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

export type CustomerCredit = {
  id: string;
  clienteId: string;
  linkId: string;
  pagamentoId: string;
  /** Valor creditado em base units do token (fonte da verdade). */
  valorBaseUnits: bigint;
  /** Equivalente em fiat (centavos), quando ha taxa de referencia. */
  valorCentavos: number | null;
  /** Simbolo do token creditado (ex.: USDC). */
  moeda: string;
  status: CreditStatus;
  criadoEm: Date;
};

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
