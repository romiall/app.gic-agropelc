/**
 * Point d'entrée compilé (dist/purge-alerts.js) pour la purge des alertes closes (P9-25, PF-1 ; ADR-068 §8, AV-470).
 * Exécutable directement sans tsx via :
 *   node dist/purge-alerts.js [--dry-run]
 * ou via le script npm :
 *   pnpm --filter @gic/server run start:purge-alerts [-- --dry-run]
 */
import { runAlertPurgeCli } from './modules/communication/application/maintenance/purge-alerts.js';

if (process.env.MAINTENANCE_DATABASE_URL === undefined) {
  try {
    process.loadEnvFile(new URL('../.env', import.meta.url));
  } catch {
    // Pas de fichier local : l'environnement doit fournir MAINTENANCE_DATABASE_URL.
  }
}

runAlertPurgeCli(process.argv.slice(2), process.env, {
  out: (line) => {
    process.stdout.write(`${line}\n`);
  },
  err: (line) => {
    process.stderr.write(`${line}\n`);
  },
})
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
