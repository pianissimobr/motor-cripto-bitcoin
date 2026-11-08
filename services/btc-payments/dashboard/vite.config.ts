/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// O painel e servido pelo proprio motor em /painel (mesma origem: o cookie
// de sessao vale sem CORS). Em desenvolvimento, o Vite repassa a API.
const motor = process.env.MOTOR_URL ?? 'http://127.0.0.1:4580';

export default defineConfig({
  base: '/painel/',
  plugins: [react()],
  build: {
    outDir: '../public/painel',
    emptyOutDir: true,
    sourcemap: false,
  },
  server: {
    port: 5180,
    proxy: {
      '/auth': motor,
      '/v1': motor,
      '/pay': motor,
    },
  },
  test: {
    environment: 'node',
  },
});
