/**
 * O limitador virou generico porque a SwapKit tambem precisa de um: a chave
 * da SwapKit aceita 10 requisicoes por minuto e o job de reconciliacao do
 * swap consome uma por ordem.
 *
 * O nome antigo segue exportado aqui para nao quebrar quem importa deste
 * caminho.
 */
export {
  RateLimiter,
  RateLimiterQueueFullError,
  type RateLimiterOptions,
  type RateLimitPriority,
} from '../../net/rate-limiter.js';

export { RateLimiter as LuniumRateLimiter } from '../../net/rate-limiter.js';
