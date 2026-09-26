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
    // Tests d'intégration contre une vraie base MySQL partagée et persistante (aucun rollback
    // entre fichiers) : plusieurs fichiers agissent sur un état global — politiques de contrôle
    // actives d'un type d'opération (retirées puis restaurées par certains tests), positions des
    // consommateurs d'événements, réconciliation globale du registre de stock. En parallèle, ces
    // fichiers s'observent mutuellement et échouent de façon intermittente sans défaut du code.
    // Exécution séquentielle par fichier : le mode dans lequel chaque phase est vérifiée (P0 à P2).
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/main.ts', 'src/platform/kysely/schema.generated.ts'],
    },
  },
});
