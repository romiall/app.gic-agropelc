import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // Résout `@gic/domain` depuis ses sources TypeScript : les tests n'ont pas besoin
      // de `dist/` (celui-ci reste requis uniquement pour la consommation par apps/server
      // et apps/pwa via `exports`, cf. packages/domain/package.json).
      '@gic/domain': fileURLToPath(new URL('../domain/src/index.ts', import.meta.url)),
    },
  },
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/index.ts', 'src/test-helpers.ts'],
      thresholds: {
        lines: 90,
        statements: 90,
        functions: 90,
        branches: 85,
      },
    },
  },
});
