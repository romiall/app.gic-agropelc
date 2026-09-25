import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// Budget de bundle NFR-05 (≤ 300 Ko gzip JS initial) : découpage manuel pour garder l'écran
// de connexion (chargé en premier, avant toute session) hors du même chunk que les écrans
// accessibles seulement après authentification.
export default defineConfig({
  resolve: {
    alias: {
      '@gic/domain': fileURLToPath(new URL('../../packages/domain/src/index.ts', import.meta.url)),
      '@gic/contracts': fileURLToPath(
        new URL('../../packages/contracts/src/index.ts', import.meta.url),
      ),
    },
  },
  server: {
    port: 5173,
    proxy: {
      // Développement local uniquement (ADR-024 §5) : le serveur API tourne sur le port par
      // défaut de `apps/server` (main.ts), la PWA n'a pas besoin de connaître son URL exacte.
      '/api': { target: 'http://localhost:3000', changeOrigin: true },
    },
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
  plugins: [
    react(),
    VitePWA({
      // Activation manuelle après vidage de l'outbox (06-offline-sync/01-architecture-
      // offline.md §6 « mise à jour de l'application ») : le service worker ne prend pas la
      // main tout seul, `src/platform/service-worker.ts` pilote `updateSW()` explicitement.
      registerType: 'prompt',
      injectRegister: null,
      includeAssets: ['favicon.svg'],
      manifest: {
        id: '/',
        name: 'GIC AGROPELC',
        short_name: 'GIC AGROPELC',
        description: 'Application métier intégrée GIC AGROPELC, utilisable hors ligne.',
        lang: 'fr',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        background_color: '#0b3d1e',
        theme_color: '#0b3d1e',
        icons: [
          { src: 'pwa-192.svg', sizes: '192x192', type: 'image/svg+xml', purpose: 'any' },
          { src: 'pwa-512.svg', sizes: '512x512', type: 'image/svg+xml', purpose: 'any' },
          { src: 'pwa-512.svg', sizes: '512x512', type: 'image/svg+xml', purpose: 'maskable' },
        ],
      },
      workbox: {
        // Précache versionné des fichiers statiques (05-stack.md §2.2) : l'API (/api/**)
        // n'est jamais mise en cache par le service worker — un écran hors ligne lit la base
        // locale (Dexie), jamais le réseau (règle d'architecture, 01-architecture-offline.md).
        globPatterns: ['**/*.{js,css,html,svg,woff2}'],
        navigateFallbackDenylist: [/^\/api\//],
        cleanupOutdatedCaches: true,
      },
      devOptions: {
        enabled: false,
      },
    }),
  ],
});
