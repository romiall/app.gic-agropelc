import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Mesures de charge de P9 (P9-22 ; ADR-078 §5), lancées à la demande (`pnpm --filter @gic/server test:perf`) sur une
 * base jetable chargée par `pnpm --filter @gic/db load:p9`. Hors de la suite par défaut : les fichiers `*.perf.ts`
 * ne sont pas des `*.test.ts`.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@gic/domain': fileURLToPath(new URL('../../packages/domain/src/index.ts', import.meta.url)),
      '@gic/contracts': fileURLToPath(
        new URL('../../packages/contracts/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    include: ['test/perf/**/*.perf.ts'],
    fileParallelism: false,
    testTimeout: 600_000,
    hookTimeout: 120_000,
  },
});
