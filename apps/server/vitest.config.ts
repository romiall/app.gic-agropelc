import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // Résout les paquets partagés depuis leurs sources TypeScript : les tests n'ont pas
      // besoin de `dist/` (requis seulement pour l'exécution du serveur, cf. main.ts).
      '@gic/domain': fileURLToPath(new URL('../../packages/domain/src/index.ts', import.meta.url)),
      '@gic/contracts': fileURLToPath(
        new URL('../../packages/contracts/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    // Tests d'intégration contre une vraie base MySQL (DATABASE_URL) : une commande à la
    // fois par fichier réduit le risque de verrous consultatifs concurrents sur la même
    // ligne (chaînage d'audit, §5) pendant que la suite tourne en parallèle par fichier.
    fileParallelism: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/main.ts', 'src/platform/kysely/schema.generated.ts'],
    },
  },
});
