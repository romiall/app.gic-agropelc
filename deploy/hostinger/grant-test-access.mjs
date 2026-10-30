/**
 * Accorde a un compte, pour une duree limitee, les roles du systeme (les 11 livres avec l'application) de portee GLOBAL
 * qu'il n'a pas encore : le compte de test du porteur peut alors essayer toutes les fonctions de l'application (demande
 * du 30/10/2026). Les roles de terrain (site, zone, equipe) exigent un site, une zone ou une equipe qui existe : ils sont
 * listes, pas accordes.
 *
 * Usage, SUR LE SERVEUR, dans le dossier de l'application :
 *   node --env-file=.env grant-test-access.mjs <e-mail ou telephone du compte> [--days 30] [--dry-run]
 *   --dry-run : affiche le plan sans rien ecrire ; --days : duree de l'acces, de 1 a 90 jours (30 par defaut).
 *
 * Chaque affectation porte une date de fin (valid_to) : l'acces s'eteint seul, et se retire avant dans l'ecran des
 * comptes. Meme chemin que la commande identity.role_assignment.grant : controles de insertRoleAssignment, ligne
 * d'audit, evenement (le cache des droits est invalide en une seconde environ) et journal de synchronisation. Acteur :
 * l'utilisateur systeme, comme approve-device.mjs. Tout ou rien : une seule transaction.
 * Essai en local sans rien garder : --rehearse (ecrit puis annule ; laisse un trou dans la numerotation des evenements).
 */
import { DefaultQueryCompiler } from 'kysely';
import { SystemClock, Uuidv7Generator } from '@gic/domain';
import { installMariaDbCompat } from './mariadb-compat.mjs';
import { createDatabase } from './dist/platform/kysely/database.js';
import { withUnitOfWork } from './dist/platform/unit-of-work.js';
import { insertRoleAssignment } from './dist/modules/identity/application/role-assignment-writer.js';
import { recordAudit } from './dist/audit/record-audit.js';
import { recordChanges } from './dist/platform/sync/change-feed.js';
import { jsonValue } from './dist/platform/kysely/json-value.js';
import { fromBin, toBin } from './dist/platform/kysely/uuid-columns.js';

const args = process.argv.slice(2).filter((arg) => arg !== '--');
const dryRun = args.includes('--dry-run');
const rehearse = args.includes('--rehearse');
const daysAt = args.indexOf('--days');
const daysValueAt = daysAt >= 0 ? daysAt + 1 : -1;
const days = daysAt >= 0 ? Number(args[daysValueAt]) : 30;
const identifier = args.find((arg, i) => !arg.startsWith('--') && i !== daysValueAt);
if (!identifier || !Number.isInteger(days) || days < 1 || days > 90) {
  console.error(
    'Usage : node --env-file=.env grant-test-access.mjs <e-mail ou telephone> [--days 1 a 90] [--dry-run]',
  );
  process.exit(2);
}
const url = process.env.SERVER_DATABASE_URL;
if (!url) {
  console.error('SERVER_DATABASE_URL non defini (lancer avec --env-file=.env).');
  process.exit(2);
}

class Rehearsal extends Error {
  constructor(summary) {
    super('Essai a blanc termine : transaction annulee.');
    this.summary = summary;
  }
}

const asArray = (value) => (typeof value === 'string' ? JSON.parse(value) : value);

installMariaDbCompat(DefaultQueryCompiler);
const { db, pool } = createDatabase(url);
let exitCode = 0;
try {
  const clock = new SystemClock();
  const deps = { clock, idGenerator: new Uuidv7Generator(clock) };

  const run = (uow) => grantTestAccess(uow, deps);
  let summary;
  try {
    summary = await withUnitOfWork(db, run);
  } catch (error) {
    if (!(error instanceof Rehearsal)) throw error;
    summary = error.summary;
  }

  console.log(`Compte : ${summary.fullName} (${summary.status}).`);
  console.log(`Roles deja actifs : ${summary.already.join(', ') || 'aucun'}.`);
  if (summary.grant.length === 0) {
    console.log('Rien a accorder : tous les roles de portee GLOBAL sont deja actifs.');
  } else {
    const verb = dryRun
      ? 'A accorder (essai a blanc, rien n est ecrit)'
      : rehearse
        ? 'Accordes puis annules (essai)'
        : 'Accordes';
    console.log(
      `${verb} jusqu'au ${summary.validTo.toISOString()} (${days} jours) : ${summary.grant.join(', ')}.`,
    );
  }
  console.log(
    `Roles de terrain non accordes (il faut un site, une zone ou une equipe) : ${
      summary.fieldRoles.map((r) => `${r.code} [${r.scopes.join('/')}]`).join(', ') || 'aucun'
    }. Existants : ${summary.org.sites} site(s), ${summary.org.zones} zone(s), ${summary.org.teams} equipe(s).`,
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  exitCode = 1;
} finally {
  await pool.end();
}
process.exit(exitCode);

async function grantTestAccess(uow, deps) {
  const now = deps.clock.now();
  const lookup = uow.selectFrom('identity_users').select(['id', 'full_name', 'status']);
  const user = await (
    identifier.includes('@')
      ? lookup.where('email', '=', identifier)
      : lookup.where('active_phone', '=', identifier)
  ).executeTakeFirst();
  if (!user) throw new Error(`Aucun compte actif pour ${identifier}.`);
  if (user.status !== 'ACTIVE')
    throw new Error(`Le compte est ${user.status} : rien n'est accorde.`);
  const system = await uow
    .selectFrom('identity_users')
    .select('id')
    .where('is_system', '=', 1)
    .orderBy('created_at')
    .limit(1)
    .executeTakeFirst();
  if (!system) throw new Error('Utilisateur systeme absent : lancer d abord les semis.');

  const roles = await uow
    .selectFrom('identity_roles')
    .select(['id', 'code', 'is_active', 'allowed_scope_types'])
    .where('is_system', '=', 1)
    .orderBy('code')
    .execute();
  const held = await uow
    .selectFrom('identity_user_role_assignments as ura')
    .innerJoin('identity_roles as r', 'r.id', 'ura.role_id')
    .select(['r.code as role_code', 'ura.valid_from', 'ura.valid_to', 'ura.revoked_at'])
    .where('ura.user_id', '=', user.id)
    .execute();
  const activeCodes = new Set(
    held
      .filter(
        (a) =>
          a.valid_from <= now && (a.valid_to === null || a.valid_to > now) && a.revoked_at === null,
      )
      .map((a) => a.role_code),
  );
  const toGrant = [];
  const already = [];
  const fieldRoles = [];
  for (const role of roles) {
    if (!role.is_active) continue;
    const scopes = asArray(role.allowed_scope_types);
    if (activeCodes.has(role.code)) already.push(role.code);
    else if (scopes.includes('GLOBAL')) toGrant.push(role);
    else fieldRoles.push({ code: role.code, scopes });
  }
  const count = async (table) =>
    Number(
      (
        await uow
          .selectFrom(table)
          .select((eb) => eb.fn.countAll().as('n'))
          .executeTakeFirstOrThrow()
      ).n,
    );
  const org = {
    sites: await count('organization_sites'),
    zones: await count('organization_zones'),
    teams: await count('organization_teams'),
  };

  const validTo = new Date(now.getTime() + days * 86400000);
  const summary = {
    fullName: user.full_name,
    status: user.status,
    already,
    grant: toGrant.map((r) => r.code),
    fieldRoles,
    org,
    validTo,
  };
  if (dryRun || toGrant.length === 0) return summary;

  const userId = fromBin(user.id);
  const systemUserId = fromBin(system.id);
  for (const role of toGrant) {
    const assignmentId = deps.idGenerator.newId();
    const roleId = fromBin(role.id);
    const refusal = await insertRoleAssignment(uow, {
      assignmentId,
      userId,
      roleId,
      scopeType: 'GLOBAL',
      validFrom: now,
      validTo,
      createdBy: systemUserId,
    });
    if (refusal) throw new Error(`${role.code} : ${refusal.message}`);
    await recordAudit(uow, deps, {
      occurredAt: now,
      actorUserId: systemUserId,
      actorRoles: [],
      action: 'identity.role_assignment.grant',
      entityType: 'ROLE_ASSIGNMENT',
      entityId: assignmentId,
      after: {
        user_id: userId,
        role_id: roleId,
        role_code: role.code,
        scope_type: 'GLOBAL',
        valid_to: validTo.toISOString(),
      },
      reason: 'Acces de test temporaire demande par le porteur (grant-test-access.mjs)',
      result: 'SUCCESS',
    });
    await recordChanges(uow, [
      {
        dataset: 'role_assignment',
        entityType: 'ROLE_ASSIGNMENT',
        entityId: assignmentId,
        scopeType: 'GLOBAL',
        scopeId: null,
      },
    ]);
    await uow
      .insertInto('platform_domain_events')
      .values({
        event_id: toBin(deps.idGenerator.newId()),
        event_type: 'identity.role_assignment.grant',
        producer_module: 'identity',
        aggregate_type: 'ROLE_ASSIGNMENT',
        aggregate_id: toBin(assignmentId),
        occurred_at: now,
        payload: jsonValue({
          userId,
          roleId,
          scopeType: 'GLOBAL',
          validTo: validTo.toISOString(),
        }),
        command_id: null,
        correlation_id: null,
      })
      .execute();
  }
  if (rehearse) throw new Rehearsal(summary);
  return summary;
}
