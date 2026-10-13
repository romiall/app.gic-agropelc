/**
 * Commande d'installation (AV-254, MP-06) : approuve le premier appareil d'administration d'une installation
 * neuve, que personne ne peut encore approuver depuis l'application.
 *
 *   pnpm run db:approve-device -- <code court>
 *
 * Le code court s'affiche sur le téléphone de l'administrateur après sa première connexion (bandeau
 * « appareil en attente d'approbation »). Base : `SERVER_DATABASE_URL` de l'environnement (en local, lu dans
 * `apps/server/.env` s'il existe). Logique et gardes : `approveDeviceByShortCode`
 * (`src/modules/identity/application/bootstrap-device-approval.ts`).
 */
import { SystemClock, Uuidv7Generator } from '@gic/domain';
import { createDatabase } from '../src/platform/kysely/database.js';
import { withUnitOfWork } from '../src/platform/unit-of-work.js';
import { approveDeviceByShortCode } from '../src/modules/identity/application/bootstrap-device-approval.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((arg) => arg !== '--');
  if (args.length !== 1) {
    console.error('Usage : pnpm run db:approve-device -- <code court de l’appareil>');
    process.exitCode = 2;
    return;
  }
  if (process.env.SERVER_DATABASE_URL === undefined) {
    try {
      process.loadEnvFile(new URL('../.env', import.meta.url));
    } catch {
      // Pas de fichier local : l'environnement doit fournir SERVER_DATABASE_URL.
    }
  }
  const url = process.env.SERVER_DATABASE_URL;
  if (!url) {
    console.error('SERVER_DATABASE_URL non défini.');
    process.exitCode = 2;
    return;
  }
  const { db, pool } = createDatabase(url);
  try {
    const clock = new SystemClock();
    const result = await withUnitOfWork(db, (uow) =>
      approveDeviceByShortCode(
        uow,
        { clock, idGenerator: new Uuidv7Generator(clock) },
        {
          shortCode: args[0]!,
        },
      ),
    );
    if (result.kind === 'REFUSED') {
      console.error(result.message);
      process.exitCode = 1;
      return;
    }
    const { device } = result;
    console.log(
      `Appareil ${device.shortCode} (${device.platform ?? 'plateforme inconnue'}), connecté par ` +
        `${device.enrolledByName} (${device.enrolledByPhone}) le ${device.createdAt.toISOString()} : ` +
        (result.kind === 'APPROVED' ? 'approuvé.' : 'déjà approuvé, rien à faire.'),
    );
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
