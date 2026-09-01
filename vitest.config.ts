import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@nexora/domain': fileURLToPath(new URL('./packages/domain/src/index.ts', import.meta.url)),
      '@nexora/contracts': fileURLToPath(new URL('./packages/contracts/src/index.ts', import.meta.url)),
      '@nexora/config': fileURLToPath(new URL('./packages/config/src/index.ts', import.meta.url)),
      '@nexora/logging': fileURLToPath(new URL('./packages/logging/src/index.ts', import.meta.url)),
      '@nexora/events': fileURLToPath(new URL('./packages/events/src/index.ts', import.meta.url)),
      '@nexora/auth': fileURLToPath(new URL('./packages/auth/src/index.ts', import.meta.url)),
      '@nexora/router-sdk': fileURLToPath(new URL('./packages/router-sdk/src/index.ts', import.meta.url)),
      '@nexora/payment-sdk': fileURLToPath(new URL('./packages/payment-sdk/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['packages/domain/src/**', 'packages/auth/src/**', 'packages/config/src/**'],
    },
  },
});
