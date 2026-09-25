import { defineConfig } from 'vitest/config';

// Tests d'intégration contre un vrai MySQL (DATABASE_URL, déjà migré — voir README.md) :
// pas de "couverture" applicative à mesurer ici (aucun src/ ; le SQL exécuté est le sujet
// du test lui-même), donc pas de seuil de couverture comme packages/domain ou
// packages/contracts (NFR-31 cible spécifiquement packages/domain).
export default defineConfig({
  test: {
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
});
