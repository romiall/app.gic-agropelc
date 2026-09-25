import { defineConfig } from 'vitest/config';

// Couverture ≥ 90 % pour packages/domain (NFR-31) ; chaque invariant INV-* touché par
// ce paquet est couvert par au moins un test (règle R7, CLAUDE.md).
export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/index.ts'],
      thresholds: {
        lines: 90,
        statements: 90,
        functions: 90,
        branches: 85,
      },
    },
  },
});
