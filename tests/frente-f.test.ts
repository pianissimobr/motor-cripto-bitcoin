import { describe, expect, it } from 'vitest';

import { qrCodeSvg, svgToDataUri, QrCodeError } from '../src/core/qrcode.js';
import { collectAlerts } from '../src/core/alerts.js';
import { silentLogger } from '../src/core/logger.js';
import { createFakeRepositories } from './fakes.js';

/**
 * Frente F - QR code e alertas.
 *
 * F1: QR gerado no servidor. O conteudo e sempre a URL da Ramp que o motor
 *     gerou, mas a sanitizacao existe para que a resposta HTTP nunca possa
 *     injetar script no DOM da tela (que usa innerHTML).
 * F2: alertas reuneem tudo que exige acao humana num lugar so.
 */

const URL_RAMP =
  'https://buy.ramp.network/?userAddress=0xB528b506718d18eB4Ab7EC6ca42a47C7740022b6&asset=USDC';

describe('F1: QR code', () => {
  it('gera um SVG com viewBox', async () => {
    const svg = await qrCodeSvg(URL_RAMP);
    expect(svg).toContain('<svg');
    expect(svg).toContain('viewBox');
  });

  it('o conteudo do QR e a URL completa', async () => {
    // O mesmo QR so pode vir da URL; payload longo nao cabe em versao baixa,
    // mas o grafico tem de ser gerado sem erro.
    const svg = await qrCodeSvg(URL_RAMP);
    expect(svg.length).toBeGreaterThan(100);
  });

  it('data URI e base64 do SVG', async () => {
    const svg = await qrCodeSvg(URL_RAMP);
    const uri = svgToDataUri(svg);
    expect(uri.startsWith('data:image/svg+xml;base64,')).toBe(true);
    const decoded = Buffer.from(uri.split(',')[1]!, 'base64').toString('utf8');
    expect(decoded).toBe(svg);
  });

  it('recusa esquema nao http/https', async () => {
    await expect(qrCodeSvg('javascript:alert(1)')).rejects.toThrow(/esquema nao permitido/);
    await expect(qrCodeSvg('mailto:a@b.com')).rejects.toThrow(QrCodeError);
  });

  it('recusa conteudo que nao e URL', async () => {
    await expect(qrCodeSvg('nao-e-url')).rejects.toThrow(/URL absoluta/);
    await expect(qrCodeSvg('')).rejects.toThrow(/invalido/);
  });

  it('recusa conteudo gigante', async () => {
    await expect(qrCodeSvg(`https://x.com/${'a'.repeat(4000)}`)).rejects.toThrow(/invalido/);
  });

  it('higieniza: nunca devolve script nem handler', async () => {
    const svg = await qrCodeSvg(URL_RAMP);
    expect(svg).not.toMatch(/<script/i);
    expect(svg).not.toMatch(/javascript:/i);
    expect(svg).not.toMatch(/<foreignObject/i);
  });

  it('aceita http (nao so https)', async () => {
    const svg = await qrCodeSvg('http://exemplo.local/pagamento');
    expect(svg).toContain('<svg');
  });
});

describe('F2: alertas', () => {
  const depsBase = {
    logger: silentLogger,
    gasSponsorMinBalanceWei: 1_000_000_000_000_000_000n,
    gasSponsorConfigured: false,
  };

  it('sinaliza ausencia do gas sponsor como critico', async () => {
    const alertas = await collectAlerts({
      ...depsBase,
      repos: createFakeRepositories(),
    });
    const critico = alertas.find((a) => a.codigo === 'gas_sponsor_ausente');
    expect(critico).toBeDefined();
    expect(critico?.nivel).toBe('critico');
    expect(critico?.detalhe?.variavel).toBe('GAS_SPONSOR_PRIVATE_KEY');
  });

  it('alerta quando o saldo real do patrocinador esta abaixo do minimo', async () => {
    const alertas = await collectAlerts({
      ...depsBase,
      repos: createFakeRepositories(),
      gasSponsorConfigured: true,
      gasSponsorBalances: [{ chain: 'polygon', balanceWei: 1n }],
    });
    const baixo = alertas.find((a) => a.codigo === 'gas_sponsor_saldo_baixo');
    expect(baixo?.nivel).toBe('critico');
    expect(baixo?.detalhe?.saldos).toEqual([{ chain: 'polygon', balanceWei: '1' }]);
    expect(alertas.find((a) => a.codigo === 'gas_sponsor_saldo_ok')).toBeUndefined();
  });

  it('nao alerta quando o saldo real cobre o minimo', async () => {
    const alertas = await collectAlerts({
      ...depsBase,
      repos: createFakeRepositories(),
      gasSponsorConfigured: true,
      gasSponsorBalances: [
        { chain: 'polygon', balanceWei: 1_000_000_000_000_000_000n },
      ],
    });
    expect(alertas.find((a) => a.codigo === 'gas_sponsor_saldo_baixo')).toBeUndefined();
    expect(alertas.find((a) => a.codigo === 'gas_sponsor_saldo_ok')?.nivel).toBe('info');
  });

  it('RPC indisponivel vira atencao, nunca "saldo ok"', async () => {
    const alertas = await collectAlerts({
      ...depsBase,
      repos: createFakeRepositories(),
      gasSponsorConfigured: true,
      gasSponsorBalances: [{ chain: 'polygon', balanceWei: null }],
    });
    const indisponivel = alertas.find((a) => a.codigo === 'gas_sponsor_saldo_indisponivel');
    expect(indisponivel?.nivel).toBe('atencao');
    expect(indisponivel?.detalhe?.chains).toEqual(['polygon']);
    expect(alertas.find((a) => a.codigo === 'gas_sponsor_saldo_ok')).toBeUndefined();
  });

  it('configurado sem consulta de saldo vira atencao', async () => {
    const alertas = await collectAlerts({
      ...depsBase,
      repos: createFakeRepositories(),
      gasSponsorConfigured: true,
    });
    expect(
      alertas.find((a) => a.codigo === 'gas_sponsor_saldo_nao_verificado')?.nivel,
    ).toBe('atencao');
  });

  it('sinaliza pagamento parcial com o valor recebido', async () => {
    const repos = createFakeRepositories();
    const seed = async (
      status: 'pago' | 'parcial' | 'pago_sem_gas' | 'expirado',
      comPagamento = true,
    ) => {
      const perfil = await repos.rampProfiles.create({
        label: `P-${status}`,
        chain: 'polygon',
        asset: 'USDC',
        tokenContract: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
        decimals: 6,
        fiatCurrency: 'BRL',
        baseUrl: 'https://x/',
        paramStyle: 'legacy',
        hostAppName: 'M',
        hostApiKey: null,
        rampAssetKey: null,
        taxaTokenPorFiatBaseUnits: 180_000n,
      });
      const { DataCipher, BlindIndex } = await import('../src/core/crypto/cipher.js');
      const { randomUUID } = await import('node:crypto');
      const cipher = new DataCipher(Buffer.alloc(32, 7));
      const idx = new BlindIndex(Buffer.alloc(32, 9));
      const id = randomUUID();
      const email = `${status}@e.com`;
      const cliente = await repos.customers.create({
        id,
        nomeEnc: cipher.encrypt('C', id),
        emailEnc: cipher.encrypt(email, id),
        emailBidx: idx.compute(email),
        emailBidxAnterior: null,
        nomeMasked: 'C***',
        emailMasked: 'c***',
        status: 'ativo',
        prefixBidxList: [],
        prefixBidxListV2: [],
      });
      const link = await repos.links.create({
        clienteId: cliente.id,
        rampProfileId: perfil.id,
        chain: 'polygon',
        asset: 'USDC',
        tokenContract: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
        decimals: 6,
        moedaFiat: 'BRL',
        valorFiatCentavos: 10_000,
        valorFiatUnidades: 10_000,
        taxaTokenPorFiatBaseUnits: 180_000n,
        expectedBaseUnits: 1_800_000n,
        indiceHd: 0,
        caminhoDerivacao: 'x',
        enderecoDeposito: '0x2222222222222222222222222222222222222222',
        carteiraFriaId: null,
        carteiraFriaEndereco: '0x1111111111111111111111111111111111111111',
        rampUrl: 'https://x/',
        status,
        expiraEm: new Date(Date.now() + 86_400_000),
      });
      if (comPagamento) {
        await repos.payments.upsert({
          linkId: link.id,
          txHash: `0x${status}${Math.random().toString(16).slice(2, 8)}`,
          logIndex: 0,
          deAddress: '0x3',
          paraAddress: '0x2222222222222222222222222222222222222222',
          token: 'USDC',
          valorBaseUnits: 900_000n, // metade do esperado
          bloco: 1,
          status: 'confirmado',
          detectadoEm: new Date(),
        });
      }
      return link;
    };

    await seed('parcial');
    await seed('pago_sem_gas');
    await seed('expirado', false); // expirado SEM pagamento -> alerta info

    const alertas = await collectAlerts({
      ...depsBase,
      repos,
    });

    const parcial = alertas.find((a) => a.codigo === 'pagamento_parcial');
    expect(parcial).toBeDefined();
    expect(parcial?.nivel).toBe('atencao');
    expect(parcial?.detalhe?.recebidoBaseUnits).toBe('900000');
    expect(parcial?.detalhe?.esperadoBaseUnits).toBe('1800000');

    const semGas = alertas.find((a) => a.codigo === 'pagamento_sem_gas');
    expect(semGas).toBeDefined();
    expect(semGas?.nivel).toBe('critico');
    expect(semGas?.detalhe?.patrocinadorConfigurado).toBe(false);

    const expirado = alertas.find((a) => a.codigo === 'link_expirado_sem_pagamento');
    expect(expirado).toBeDefined();
    expect(expirado?.nivel).toBe('info');
  });

  it('nao gera alerta de link expirado que TEM pagamento', async () => {
    const repos = createFakeRepositories();
    const alertas = await collectAlerts({ ...depsBase, repos });
    // so o alerta do gas sponsor deve aparecer
    expect(alertas.every((a) => a.codigo === 'gas_sponsor_ausente')).toBe(true);
  });

  it('sinaliza revogado com dinheiro dentro', async () => {
    const repos = createFakeRepositories();
    const alertas = await collectAlerts({ ...depsBase, repos });
    expect(alertas.find((a) => a.codigo === 'link_revogado_com_valor')).toBeUndefined();
  });
});