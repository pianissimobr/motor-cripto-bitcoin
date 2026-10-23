import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function readWeb(name: string): string {
  return readFileSync(new URL(`../web/${name}`, import.meta.url), 'utf8');
}

describe('P1: UI compativel com CSP e auth real', () => {
  it('index nao usa script inline e carrega o modulo externo', () => {
    const html = readWeb('index.html');
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/i);
    expect(html).toContain('src="/index.js"');
  });

  it('a barra de auth valida o token em endpoint autenticado', () => {
    const js = readWeb('app.js');
    expect(js).toContain("api('/api/auth/check')");
    expect(js).not.toContain("api('/api/health')");
  });
});
