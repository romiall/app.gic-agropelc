/**
 * Approuve le premier appareil d'administration de l'installation (AV-254) : l'equivalent en ligne de
 * `pnpm run db:approve-device -- <code court>` (apps/server/scripts/approve-device.ts, qui demande tsx et n'existe pas
 * sur l'hebergement). Meme logique et memes gardes : `approveDeviceByShortCode` du code construit.
 *
 * Usage, SUR LE SERVEUR, dans le dossier de l'application :
 *   node --env-file=.env approve-device.mjs <code court>
 * Le code court (4 caracteres) s'affiche sur l'appareil apres la premiere connexion (bandeau "appareil en attente
 * d'approbation"). L'utilisateur qui a connecte l'appareil doit avoir un role ADMIN actif.
 */
import { DefaultQueryCompiler } from 'kysely';
import { SystemClock, Uuidv7Generator } from '@gic/domain';
import { installMariaDbCompat } from './mariadb-compat.mjs';
import { createDatabase } from './dist/platform/kysely/database.js';
import { withUnitOfWork } from './dist/platform/unit-of-work.js';
import { approveDeviceByShortCode } from './dist/modules/identity/application/bootstrap-device-approval.js';

const args = process.argv.slice(2).filter((arg) => arg !== '--');
if (args.length !== 1) {
  console.error('Usage : node --env-file=.env approve-device.mjs <code court de l appareil>');
  process.exit(2);
}
const url = process.env.SERVER_DATABASE_URL;
if (!url) {
  console.error('SERVER_DATABASE_URL non defini (lancer avec --env-file=.env).');
  process.exit(2);
}

installMariaDbCompat(DefaultQueryCompiler);
const { db, pool } = createDatabase(url);
let exitCode = 0;
try {
  const clock = new SystemClock();
  const result = await withUnitOfWork(db, (uow) =>
    approveDeviceByShortCode(
      uow,
      { clock, idGenerator: new Uuidv7Generator(clock) },
      { shortCode: args[0] },
    ),
  );
  if (result.kind === 'REFUSED') {
    console.error(result.message);
    exitCode = 1;
  } else {
    const { device } = result;
    console.log(
      `Appareil ${device.shortCode} (${device.platform ?? 'plateforme inconnue'}), connecte par ` +
        `${device.enrolledByName} le ${device.createdAt.toISOString()} : ` +
        (result.kind === 'APPROVED' ? 'approuve.' : 'deja approuve, rien a faire.'),
    );
  }
} catch (error) {
  console.error(error);
  exitCode = 1;
} finally {
  await pool.end();
}
process.exit(exitCode);
