import { randomBytes } from 'node:crypto';
import { sha256Hex } from './hmac.js';

/** Token opaco para sessao/verificacao; o banco guarda apenas o hash. */
export function generateOpaqueToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashOpaqueToken(token: string): string {
  return sha256Hex(token);
}