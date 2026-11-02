import QRCode from 'qrcode';

/**
 * Geracao de QR code no SERVIDOR (frente F1).
 *
 * Por que no servidor e nao no browser:
 *  - a CSP da tela fica intacta (script-src 'self', sem CDN, sem bundle)
 *  - o mesmo QR pode ser embutido em e-mail, WhatsApp ou impresso
 *  - a lib fica numa dependencia de runtime do backend, longe do cliente
 *
 * O conteudo e sempre a URL da Ramp que O MOTOR gerou - nunca entrada do
 * usuario, entao nao ha superficie de injecao. Ainda assim o SVG passa por
 * uma limpeza defensiva: qualquer <script> removido.
 */

const MAX_URL = 2048;

export class QrCodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QrCodeError';
  }
}

export async function qrCodeSvg(content: string, opts?: { width?: number }): Promise<string> {
  if (!content || content.length > MAX_URL) {
    throw new QrCodeError(`conteudo invalido para QR (len ${content.length})`);
  }
  // So aceita http/https: evita que um link malicioso gere um QR de outro
  // esquema (mailto:, javascript:, etc).
  let parsed: URL;
  try {
    parsed = new URL(content);
  } catch {
    throw new QrCodeError('conteudo do QR precisa ser uma URL absoluta');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new QrCodeError(`esquema nao permitido no QR: ${parsed.protocol}`);
  }

  const svg = await QRCode.toString(content, {
    type: 'svg',
    errorCorrectionLevel: 'M',
    margin: 1,
    width: opts?.width ?? 240,
    color: { dark: '#0b0f16ff', light: '#ffffffff' },
  });

  return sanitizeSvg(svg);
}

/**
 * Higienizacao defensiva do SVG: o QR de uma URL nossa nunca traz script,
 * mas qualquer texto do SVG que entre na resposta HTTP e injetado no DOM
 * da tela via innerHTML. Melhor nao depender so da biblioteca.
 */
function sanitizeSvg(svg: string): string {
  const semScript = svg
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<script[^>]*\/?>/gi, '')
    .replace(/\son\w+\s*=\s*"[^"]*"/gi, '')
    .replace(/\son\w+\s*=\s*'[^']*'/gi, '')
    .replace(/javascript:/gi, '');
  if (/<foreignObject/i.test(semScript)) {
    throw new QrCodeError('SVG inesperado (foreignObject)');
  }
  return semScript;
}

/** Data URI, para usar direto em <img src> sem passar por fetch. */
export function svgToDataUri(svg: string): string {
  return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;
}