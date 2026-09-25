import { defineConfig, devices } from '@playwright/test';

// NFR-02 : « fonctionne sans réseau » mesuré ici sur le shell applicatif construit
// (`vite build` puis `vite preview`) — jamais sur le serveur de développement, dont le HMR
// dépend du réseau par construction. `PLAYWRIGHT_BROWSERS_PATH`/l'exécutable Chromium
// préinstallé de l'environnement d'exécution sont utilisés tels quels (pas de
// `playwright install`).
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:4173',
  },
  webServer: {
    command: 'pnpm run preview',
    url: 'http://localhost:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
          ? { launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } }
          : {}),
      },
    },
  ],
});
