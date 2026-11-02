import { HDNodeWallet, type HDNodeVoidWallet } from 'ethers';

/**
 * Derivacao de enderecos a partir de uma HD Wallet.
 *
 * RESTRICAO CRITICA (BIP32):
 * um xpub so permite derivar nao-hardened. O caminho `m/44'/60'/0'/0/{i}`
 * tem tres passos hardened (`44'`, `60'`, `0'`), logo **nao pode** ser derivado
 * a partir de um xpub master. O xpub precisa ser o xpub DE CONTA
 * (`m/44'/60'/0'`, depth 3) e a derivacao usa o caminho RELATIVO `0/{i}`.
 *
 * O ethers lanca "cannot derive child of neutered node" se alguem tentar
 * o caminho errado; aqui isso vira uma mensagem explicita, porque a falha
 * errada silenciosa seria derivar enderecos de outra carteira.
 */

export class HdWalletError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HdWalletError';
  }
}

export type HdAccount = {
  /** Endereco publico da conta (m/44'/60'/account'). */
  accountAddress: string;
  /** Profundidade do xpub (3 = conta BIP44). */
  depth: number;
};

export type HdNode = HDNodeWallet | HDNodeVoidWallet;

export class HdWallet {
  /** Prefixo relativo de derivacao, ex.: '0' (=> m/44'/60'/0'/0/{index}). */
  readonly derivationPrefix: string;

  private constructor(
    private readonly node: HdNode,
    readonly accountIndex: number,
    derivationPrefix: string,
  ) {
    this.derivationPrefix = derivationPrefix;
  }

  /**
   * Cria a carteira a partir do xpub de CONTA.
   *
   * @param xpub        xpub de conta (`m/44'/60'/0'`), nunca master, nunca xprv
   * @param prefix      prefixo relativo de derivacao (padrao '0')
   * @param accountIndex indice da conta, apenas para rotulagem
   */
  static fromAccountXpub(xpub: string, prefix = '0', accountIndex = 0): HdWallet {
    const trimmed = xpub.trim();
    if (trimmed.length === 0) throw new HdWalletError('xpub vazio');
    if (!trimmed.startsWith('xpub')) {
      throw new HdWalletError(
        'HD_XPUB deve ser um xpub (chave publica). Nunca use xprv/seed aqui: ' +
          'a seed nao pode tocar o servidor que deriva enderecos.',
      );
    }
    assertNonHardenedPrefix(prefix);

    let node: HdNode;
    try {
      node = HDNodeWallet.fromExtendedKey(trimmed);
    } catch (err) {
      throw new HdWalletError(
        `xpub invalido: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const depth = node.depth;
    if (depth === 0) {
      throw new HdWalletError(
        'HD_XPUB parece ser o xpub MASTER (depth 0). Ele nao permite derivar ' +
          "m/44'/60'/0'/0/{i} porque os passos 44'/60'/0' sao hardened. " +
          'Use o xpub DE CONTA (m/44\'/60\'/0\', depth 3) e o prefixo relativo "0".',
      );
    }
    if (depth !== 3) {
      throw new HdWalletError(
        `HD_XPUB com depth ${depth}. Esperado depth 3 (conta BIP44 m/44'/60'/0'). ` +
          "Use o xpub de conta para derivar m/44'/60'/0'/0/{index}.",
      );
    }

    return new HdWallet(node, accountIndex, prefix);
  }

  /** Cria a carteira a partir de um xprv (apenas para o signer local). */
  static fromAccountXprv(xprv: string, prefix = '0', accountIndex = 0): HdWallet {
    const trimmed = xprv.trim();
    if (!trimmed.startsWith('xprv')) {
      throw new HdWalletError('xprv invalido (esperado prefixo xprv)');
    }
    assertNonHardenedPrefix(prefix);
    const node = HDNodeWallet.fromExtendedKey(trimmed);
    if (node.depth !== 3) {
      throw new HdWalletError(
        `xprv com depth ${node.depth}. Esperado depth 3 (conta BIP44 m/44'/60'/0'). ` +
          'Use o xprv da conta, nao o master nem uma folha.',
      );
    }
    return new HdWallet(node, accountIndex, prefix);
  }

  get account(): HdAccount {
    return { accountAddress: this.node.address, depth: this.node.depth };
  }

  /** Deriva o endereco publico do indice informado. Nao expoe chave privada. */
  deriveAddress(index: number): string {
    return this.deriveNode(index).address;
  }

  /**
   * Deriva a chave privada do indice informado.
   * So deve ser chamado pelo Signer, nunca pelo caminho de criacao de link.
   */
  derivePrivateKey(index: number): string {
    const child = this.deriveNode(index);
    const priv = (child as unknown as { privateKey: string | null }).privateKey;
    if (!priv) {
      throw new HdWalletError(
        'Este no dao possui chave privada. Use o xprv (keystore) no Signer.',
      );
    }
    return priv;
  }

  /** Deriva o no completo (endereco + caminho) para um indice. */
  deriveNode(index: number): HdNode {
    if (!Number.isInteger(index) || index < 0) {
      throw new HdWalletError(`indice de derivacao invalido: ${index}`);
    }
    const path = `${this.derivationPrefix}/${index}`;
    try {
      return this.node.derivePath(path);
    } catch (err) {
      throw new HdWalletError(
        `falha ao derivar "${path}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Caminho BIP32 completo correspondente ao indice, para auditoria. */
  fullPath(index: number): string {
    return `m/44'/60'/${this.accountIndex}'/${this.derivationPrefix}/${index}`;
  }
}

function assertNonHardenedPrefix(prefix: string): void {
  if (prefix.trim().length === 0) {
    throw new HdWalletError('prefixo de derivacao vazio');
  }
  if (prefix.includes("'")) {
    throw new HdWalletError(
      `prefixo de derivacao "${prefix}" contem passo hardened, que nao pode ser derivado de um xpub.`,
    );
  }
  if (!/^[0-9]+(\/[0-9]+)*$/.test(prefix)) {
    throw new HdWalletError(`prefixo de derivacao invalido: "${prefix}"`);
  }
}
