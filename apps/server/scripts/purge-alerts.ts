/**
 * Script d'exploitation (P9-25, PF-1 ; ADR-068 §8, AV-470) : purge des alertes closes depuis plus de
 * `communication.alert_retention_days` jours (730 au minimum, plancher du déclencheur), sous le rôle de maintenance.
 *
 *   pnpm run db:purge-alerts [-- --dry-run]
 *
 * Connexion : `MAINTENANCE_DATABASE_URL` (rôle `gic_maintenance`, `db/README.md` §1), jamais `SERVER_DATABASE_URL` ;
 * en local, lue dans `apps/server/.env` si elle y figure. À planifier côté hébergement (une fois par semaine suffit,
 * hors heures de pointe : la suppression se fait sur un prédicat non indexé). Logique, messages et codes de sortie :
 * `runAlertPurgeCli` (`src/modules/communication/application/maintenance/purge-alerts.ts`, compilé et typé avec le
 * serveur).
 */
import { runAlertPurgeCli } from '../src/modules/communication/application/maintenance/purge-alerts.js';

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
