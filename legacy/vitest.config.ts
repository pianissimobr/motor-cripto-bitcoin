import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // A suite de integracao tem banco e ciclo proprios (test:integration).
    exclude: ['**/node_modules/**', '**/dist/**', 'tests/integration/**'],
  },
});
