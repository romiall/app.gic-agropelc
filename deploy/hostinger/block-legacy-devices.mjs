/**
 * Refuse (PENDING -> BLOCKED) les appareils en attente dont l'identifiant n'est pas un UUIDv7 (AV-499, ADR-052) : des
 * appareils de test enroles avant que la connexion n'exige un UUIDv7, qu'aucune commande ne peut viser et que l'ecran
 * Appareils ne peut donc ni approuver ni refuser. Meme logique et memes gardes que l'application : `blockDevice` du code
 * construit, acteur systeme, audit `identity.device.block`. Rien n'est supprime.
 *
 * Usage, SUR LE SERVEUR, dans le dossier de l'application (le fichier peut arriver par l'entree standard) :
 *   node --env-file=.env block-legacy-devices.mjs                 liste seulement (aucune ecriture)
 *   node --env-file=.env block-legacy-devices.mjs --apply         refuse tous les appareils listes
 *   node --env-file=.env block-legacy-devices.mjs --apply --only=9PYZ,VKOQ   refuse ceux-la seulement
 */
import { DefaultQueryCompiler } from 'kysely';
import { SystemClock, Uuidv7Generator } from '@gic/domain';
import { installMariaDbCompat } from './mariadb-compat.mjs';
import { createDatabase } from './dist/platform/kysely/database.js';
import { withUnitOfWork } from './dist/platform/unit-of-work.js';
import { blockLegacyPendingDevices } from './dist/modules/identity/application/bootstrap-legacy-device-cleanup.js';

const args = process.argv.slice(2).filter((arg) => arg !== '--');
const apply = args.includes('--apply');
const onlyArg = args.find((arg) => arg.startsWith('--only='));
const shortCodes = onlyArg
  ? onlyArg
      .slice('--only='.length)
      .split(',')
      .map((code) => code.trim())
      .filter(Boolean)
  : undefined;
const unknown = args.filter((arg) => arg !== '--apply' && !arg.startsWith('--only='));
if (unknown.length > 0) {
  console.error('Option inconnue : ' + unknown.join(' '));
  console.error(
    'Usage : node --env-file=.env block-legacy-devices.mjs [--apply] [--only=CODE1,CODE2]',
  );
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
    blockLegacyPendingDevices(
      uow,
      { clock, idGenerator: new Uuidv7Generator(clock) },
      { apply, ...(shortCodes ? { shortCodes } : {}) },
    ),
  );
  if (result.kind === 'REFUSED') {
    console.error(result.message);
    exitCode = 1;
  } else {
    const verb = result.kind === 'BLOCKED' ? 'refuse' : 'a refuser';
    console.log(
      result.devices.length +
        ' appareil(s) en attente dont l identifiant n est pas un UUIDv7 (' +
        verb +
        ') :',
    );
    for (const device of result.devices) {
      console.log(
        '  ' +
          device.shortCode +
          ' | ' +
          (device.platform ?? 'plateforme inconnue') +
          ' | enrole le ' +
          device.createdAt.toISOString(),
      );
    }
    if (result.kind === 'LISTED' && result.devices.length > 0) {
      console.log('Simulation : rien n a ete ecrit. Ajouter --apply pour les refuser.');
    }
  }
} catch (error) {
  console.error(error);
  exitCode = 1;
} finally {
  await pool.end();
}
process.exit(exitCode);
