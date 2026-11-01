/**
 * Reprise du classeur de reporting du responsable commercial (08 au 31/10/2026) dans la base de l'application.
 * Voir IMPORT-REPORTING-COMMERCIAL.md (mode d'emploi, correspondance colonne par colonne, decisions du porteur).
 *
 * Ecriture par les VRAIES commandes du pipeline (idempotentes, auditees, journal de synchronisation), jamais par
 * des INSERT dans les tables d'un module : zones et compte par un administrateur, puis clients, etapes, visites et
 * appels avec le responsable pour auteur, en faits accomplis dates d'octobre (captured_offline + motif de
 * retrodatation). Le pipeline n'applique aucune fenetre d'antidatage (AV-078 non code) ; les droits sont juges a la date
 * du fait (RC-01) : l'affectation RESP_COMMERCIAL du responsable est donc posee a la date de debut d'usage.
 * Identifiants deterministes (UUIDv7 derives de la cle RESCOM|N) : relancer l'outil ne cree aucun doublon.
 * Aucun mot de passe dans le code, l'environnement du depot ou les journaux : il est demande en saisie masquee
 * (ou lu dans la variable d'environnement du processus nommee par --manager-password-env) et n'est jamais affiche.
 *
 * Usage (en local : copie de l'essai sur base neuve ; en ligne : sur le serveur, dans le dossier de l'application) :
 *   node [--import tsx] [--env-file=.env] import-reporting-commercial.mjs --data <donnees_extraites.json> MODE [options]
 * MODE (un seul) :
 *   --dry-run      aucune ecriture : controle des donnees, du plan et (sauf --offline) de la base, puis rapport
 *   --apply        ecrit (confirmation OUI, ou --yes) puis verifie ligne a ligne et ecrit le rapport
 *   --verify-only  ne fait que la verification et le rapport (apres une reprise)
 * Options : voir USAGE ci-dessous (--help).
 * Essai local sans build : --app-dir <apps/server> --code-dir src avec `node --import tsx` ; en ligne : valeurs par
 * defaut (dossier courant, dist).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import * as map from './reporting-import-mapping.mjs';
import { installMariaDbCompat } from './mariadb-compat.mjs';

// Le pipeline journalise chaque commande (pino) : bruit inutile ici, les resultats sont comptes par l'outil.
if (!process.env.LOG_LEVEL) process.env.LOG_LEVEL = 'silent';

const DEVICE_LABEL = 'Reprise de donnees - reporting commercial (script)';
const DEVICE_SHORT_CODE = 'RPRT';
const ROLE_CODE = 'RESP_COMMERCIAL';
const OK_STATUSES = new Set(['APPLIED', 'APPLIED_WITH_WARNINGS']);
const MAX_FAILURES = 3;
const SYSTEM_EPOCH_MS = Date.parse('2026-11-01T00:00:00Z');

const USAGE = `Usage : node [--import tsx] import-reporting-commercial.mjs --data <fichier.json> (--dry-run | --apply | --verify-only) [options]
  --data <fichier>              donnees_extraites.json (clients, contacts, journal)
  --dry-run | --apply | --verify-only   mode (un seul)
  --offline                     (avec --dry-run) ne se connecte pas a la base
  --yes                         ne demande pas la confirmation OUI (--apply)
  --no-backup | --backup-dir <dossier>   --apply sauvegarde d'abord la base (mysqldump | gzip, defaut ~/backups_db) et
                                refuse d'ecrire si la sauvegarde echoue ; --no-backup reserve aux essais locaux
  --app-dir <dossier>           dossier de l'application (defaut : dossier courant)
  --code-dir <dossier>          code du serveur dans l'application (defaut : dist ; en local : src avec --import tsx)
  --admin <e-mail|telephone>    administrateur qui cree zones et compte (defaut : admin@gic-agropelc.com)
  --manager-email <e-mail>      compte du responsable commercial (identifiant de connexion)
  --manager-name <nom>          nom complet du responsable
  --manager-phone <+237...>     telephone E.164 du compte (exige par le schema ; requis si le compte est a creer)
  --manager-password-env <VAR>  variable d'environnement du mot de passe provisoire (defaut : RESCOM_INITIAL_PASSWORD) ;
                                sans elle, saisie masquee dans un terminal
  --manager-start <AAAA-MM-JJ>  debut d'usage = debut de l'affectation du role (defaut : 2026-10-08)
  --root-zone-name <nom> | --root-zone-code <CODE>   racine des zones (defaut : Douala / DOUALA)
  --classeur <nom> | --classeur-date <AAAA-MM-JJ>   fichier source et sa date (traces dans les motifs)
  --run-salt <sel>              sel des identifiants de commande (defaut : r1 ; a changer apres un rejet corrige)
  --expect-clients <n> | --expect-contacts <n> | --expect-journal <n>   controles de decompte
  --report-dir <dossier>        rapport .json et .md (defaut : ./rapport-import-reporting-<date>)`;

class Fatal extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

// --- Arguments ---------------------------------------------------------------------------------------------------

const VALUE_OPTIONS = new Set([
  'data',
  'app-dir',
  'code-dir',
  'admin',
  'manager-email',
  'manager-name',
  'manager-phone',
  'manager-password-env',
  'manager-start',
  'root-zone-name',
  'root-zone-code',
  'classeur',
  'classeur-date',
  'run-salt',
  'report-dir',
  'expect-clients',
  'expect-contacts',
  'expect-journal',
  'backup-dir',
]);
const FLAG_OPTIONS = new Set([
  'dry-run',
  'apply',
  'verify-only',
  'offline',
  'yes',
  'no-backup',
  'help',
]);

function parseArgs(argv) {
  const flags = new Set();
  const values = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') continue;
    if (!arg.startsWith('--')) throw new Fatal(`Argument inattendu : ${arg}\n${USAGE}`, 2);
    const name = arg.slice(2);
    if (VALUE_OPTIONS.has(name)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--'))
        throw new Fatal(`Valeur manquante pour --${name}\n${USAGE}`, 2);
      values.set(name, value);
      i += 1;
    } else if (FLAG_OPTIONS.has(name)) {
      flags.add(name);
    } else {
      throw new Fatal(`Option inconnue : ${arg}\n${USAGE}`, 2);
    }
  }
  return { flags, values };
}

// --- Terminal ----------------------------------------------------------------------------------------------------

const isTty = () => Boolean(process.stdin.isTTY && process.stdout.isTTY);

function readLine(prompt) {
  return new Promise((resolve) => {
    process.stdout.write(prompt);
    process.stdin.setEncoding('utf8');
    process.stdin.resume();
    process.stdin.once('data', (chunk) => {
      process.stdin.pause();
      resolve(String(chunk).replace(/[\r\n]+$/, ''));
    });
  });
}

/** Lecture masquee d'une ligne dans le terminal (rien ne s'affiche a la frappe). */
function readHidden(prompt) {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    process.stdout.write(prompt);
    stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    stdin.resume();
    let value = '';
    const finish = () => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write('\n');
    };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          finish();
          resolve(value);
          return;
        }
        if (ch === '\u0003') {
          finish();
          reject(new Fatal('Saisie interrompue.'));
          return;
        }
        if (ch === '\u007f' || ch === '\b') {
          value = value.slice(0, -1);
          continue;
        }
        value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

async function resolvePassword(envName) {
  const fromEnv = process.env[envName];
  if (fromEnv !== undefined && fromEnv !== '') {
    delete process.env[envName];
    return fromEnv;
  }
  if (!isTty()) {
    throw new Fatal(
      `Mot de passe provisoire requis : definir ${envName} dans l'environnement du processus ou lancer l'outil dans un terminal (saisie masquee).`,
    );
  }
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const first = await readHidden(
      'Mot de passe provisoire du responsable (8 caracteres minimum, il devra le changer a sa premiere connexion) : ',
    );
    if (first.length < 8 || first.length > 128) {
      console.log('  8 a 128 caracteres, recommencez.');
      continue;
    }
    const again = await readHidden('Confirmez le mot de passe : ');
    if (again === first) return first;
    console.log('  Les deux saisies different, recommencez.');
  }
  throw new Fatal('Mot de passe non defini (trois essais).');
}

// --- Utilitaires -------------------------------------------------------------------------------------------------

const chunk = (list, size) => {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const asObject = (value) => (typeof value === 'string' ? JSON.parse(value) : value);
const pad = (n) => String(n).padStart(2, '0');
const utcStamp = (date) =>
  `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}-${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`;
const dayOfDate = (date) =>
  date === null || date === undefined
    ? null
    : `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;

function describeTarget(url) {
  const u = new URL(url);
  return { host: u.hostname, port: u.port || '3306', database: u.pathname.replace(/^\//, '') };
}

function findExecutable(names) {
  const dirs = String(process.env.PATH ?? '')
    .split(path.delimiter)
    .filter((dir) => dir !== '');
  const extensions = process.platform === 'win32' ? ['.exe', '.cmd', ''] : [''];
  for (const name of names) {
    for (const dir of dirs) {
      for (const extension of extensions) {
        const candidate = path.join(dir, name + extension);
        if (fs.existsSync(candidate)) return candidate;
      }
    }
  }
  return null;
}

/**
 * Sauvegarde complete de la base avant toute ecriture (comme remote-update.sh). Les identifiants passent par un
 * fichier temporaire en mode 600 (jamais sur la ligne de commande), supprime ensuite ; rien n'est affiche.
 */
async function backupDatabase(url, dir, stamp) {
  const dumper = findExecutable(['mysqldump', 'mariadb-dump']);
  if (dumper === null)
    throw new Fatal(
      'mysqldump introuvable : sauvegarder la base (hPanel, phpMyAdmin, Exporter) puis relancer avec --no-backup.',
    );
  const u = new URL(url);
  const database = decodeURIComponent(u.pathname.replace(/^\//, ''));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `gic-avant-reprise-reporting-${stamp}.sql.gz`);
  const cnf = path.join(os.tmpdir(), `rescom-${process.pid}-${Date.now()}.cnf`);
  const esc = (value) => decodeURIComponent(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  fs.writeFileSync(
    cnf,
    [
      '[client]',
      `user="${esc(u.username)}"`,
      `password="${esc(u.password)}"`,
      `host="${u.hostname}"`,
      `port=${u.port || 3306}`,
      '',
    ].join('\n'),
    { mode: 0o600 },
  );
  try {
    const child = spawn(
      dumper,
      [
        `--defaults-extra-file=${cnf}`,
        '--single-transaction',
        '--skip-lock-tables',
        '--routines',
        '--triggers',
        database,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stderr = '';
    child.stderr.on('data', (chunkText) => {
      stderr += chunkText;
    });
    const closed = new Promise((resolve) => child.on('close', resolve));
    await pipeline(child.stdout, zlib.createGzip(), fs.createWriteStream(file));
    const code = await closed;
    if (code !== 0)
      throw new Fatal(
        `Sauvegarde de la base refusee (code ${code}) : ${stderr.trim().slice(0, 300)}`,
      );
  } finally {
    fs.rmSync(cnf, { force: true });
  }
  const size = fs.statSync(file).size;
  if (size < 1000) throw new Fatal(`Sauvegarde vide ou trop petite (${size} octets) : ${file}`);
  return { file, size };
}

// --- Chargement de l'application ------------------------------------------------------------------------------------

async function loadApp(appDir, codeDir) {
  if (!fs.existsSync(path.join(appDir, 'package.json')))
    throw new Fatal(`Dossier de l'application introuvable (package.json absent) : ${appDir}`);
  if (!fs.existsSync(path.join(codeDir, 'commands')))
    throw new Fatal(
      `Code du serveur introuvable dans ${codeDir} (--code-dir ; en local : src avec "node --import tsx").`,
    );
  const appRequire = createRequire(path.join(appDir, 'package.json'));
  const importPkg = (name) => import(pathToFileURL(appRequire.resolve(name)).href);
  const importCode = (relative) => import(pathToFileURL(path.join(codeDir, relative)).href);
  await importPkg('reflect-metadata');
  const kysely = await importPkg('kysely');
  const domain = await importPkg('@gic/domain');
  const app = {
    kysely,
    domain,
    ...(await importCode('platform/kysely/database.js')),
    ...(await importCode('platform/unit-of-work.js')),
    ...(await importCode('platform/kysely/uuid-columns.js')),
    ...(await importCode('platform/kysely/json-value.js')),
    ...(await importCode('platform/sync/change-feed.js')),
    ...(await importCode('audit/record-audit.js')),
    ...(await importCode('modules/identity/application/role-assignment-writer.js')),
    ...(await importCode('modules/identity/application/rbac/rbac-cache.js')),
    ...(await importCode('modules/identity/application/public/rights-check.js')),
    ...(await importCode('modules/identity/application/commands/user-commands.js')),
    ...(await importCode('modules/organization/application/commands/zone-commands.js')),
    ...(await importCode('modules/crm/application/commands/customer-commands.js')),
    ...(await importCode('modules/crm/application/commands/activity-commands.js')),
  };
  app.CommandHandlerRegistry = (
    await importCode('platform/sync/command-handler-registry.js')
  ).CommandHandlerRegistry;
  app.CommandPipelineService = (
    await importCode('commands/command-pipeline.service.js')
  ).CommandPipelineService;
  return app;
}

// --- Lecture de la base (references, administrateur, existant) -------------------------------------------------------

async function loadPreflight(app, db, plan, args) {
  const { fromBin } = app;
  const errors = [];
  const notes = [];
  const bad = (message) => errors.push(message);

  const steps = await db
    .selectFrom('crm_pipeline_steps')
    .select(['id', 'code', 'is_active', 'sort_order'])
    .orderBy('sort_order', 'asc')
    .orderBy('code', 'asc')
    .execute();
  const firstActive = steps.find((s) => Number(s.is_active) === 1);
  if (!firstActive || firstActive.code !== map.FIRST_STEP)
    bad(
      `La premiere etape active du pipeline est ${firstActive ? firstActive.code : 'absente'} (attendu ${map.FIRST_STEP}) : les etapes seraient fausses.`,
    );
  const stepIds = new Map(
    steps.filter((s) => Number(s.is_active) === 1).map((s) => [s.code, fromBin(s.id)]),
  );
  for (const code of new Set(plan.customers.map((c) => c.stepCode)))
    if (!stepIds.has(code)) bad(`Etape de pipeline ${code} absente ou inactive.`);

  const sources = await db.selectFrom('crm_lead_sources').select(['code', 'is_active']).execute();
  const activeSources = new Set(
    sources.filter((s) => Number(s.is_active) === 1).map((s) => s.code),
  );
  for (const code of new Set(plan.customers.map((c) => c.sourceCode)))
    if (!activeSources.has(code)) bad(`Source de prospect ${code} absente ou inactive.`);

  const categories = await db
    .selectFrom('catalog_customer_categories')
    .select(['id', 'code', 'is_active'])
    .execute();
  const categoryIds = new Map(
    categories.filter((c) => Number(c.is_active) === 1).map((c) => [c.code, fromBin(c.id)]),
  );
  for (const code of new Set(plan.customers.map((c) => c.categoryCode).filter((c) => c !== null)))
    if (!categoryIds.has(code)) bad(`Categorie de client ${code} absente ou inactive.`);

  const outcomes = await db
    .selectFrom('catalog_reason_codes')
    .select(['id', 'code', 'is_active', 'requires_comment'])
    .where('category', '=', 'VISIT_OUTCOME')
    .execute();
  const outcomeIds = new Map(
    outcomes.filter((o) => Number(o.is_active) === 1).map((o) => [o.code, fromBin(o.id)]),
  );
  for (const code of new Set(plan.visits.map((v) => v.outcomeCode)))
    if (!outcomeIds.has(code)) bad(`Resultat de visite ${code} absent ou inactif.`);

  const role = await db
    .selectFrom('identity_roles')
    .select(['id', 'is_active', 'allowed_scope_types'])
    .where('code', '=', ROLE_CODE)
    .executeTakeFirst();
  if (!role || Number(role.is_active) !== 1) bad(`Role ${ROLE_CODE} absent ou inactif.`);
  else if (!asObject(role.allowed_scope_types).includes('ZONE'))
    bad(`Le role ${ROLE_CODE} n'autorise pas une affectation de zone.`);

  const adminId = args.values.get('admin') ?? 'admin@gic-agropelc.com';
  const adminRow = await db
    .selectFrom('identity_users')
    .select(['id', 'status'])
    .where(adminId.includes('@') ? 'email' : 'active_phone', '=', adminId)
    .executeTakeFirst();
  let admin = null;
  if (!adminRow) bad(`Administrateur introuvable : ${adminId}.`);
  else if (adminRow.status !== 'ACTIVE') bad(`Le compte administrateur est ${adminRow.status}.`);
  else {
    admin = { id: fromBin(adminRow.id), bin: adminRow.id };
    const now = new Date();
    for (const permission of ['org.structure.manage', 'identity.user.manage']) {
      if (!(await app.hasPermissionAt(db, adminRow.id, permission, now)))
        bad(`L'administrateur n'a pas la permission ${permission}.`);
    }
  }
  const systemRow = await db
    .selectFrom('identity_users')
    .select('id')
    .where('is_system', '=', 1)
    .orderBy('created_at')
    .limit(1)
    .executeTakeFirst();
  if (!systemRow) bad("Utilisateur systeme absent : lancer d'abord les semis.");

  const managerEmail = args.values.get('manager-email');
  const managerRow = managerEmail
    ? await db
        .selectFrom('identity_users')
        .select(['id', 'status', 'full_name'])
        .where('email', '=', managerEmail)
        .executeTakeFirst()
    : undefined;
  if (managerRow && managerRow.status !== 'ACTIVE')
    bad(`Le compte du responsable existe mais est ${managerRow.status}.`);
  const managerPhoneArg = args.values.get('manager-phone');
  if (!managerRow && managerPhoneArg) {
    const phoneTaken = await db
      .selectFrom('identity_users')
      .select('id')
      .where('phone', '=', managerPhoneArg)
      .where('status', '!=', 'DEACTIVATED')
      .executeTakeFirst();
    if (phoneTaken) bad(`Le telephone ${managerPhoneArg} est deja utilise par un compte actif.`);
  }

  const zoneRows = await db
    .selectFrom('organization_zones')
    .select(['id', 'code', 'level', 'parent_id', 'is_active'])
    .where(
      'code',
      'in',
      plan.zones.map((z) => z.code),
    )
    .execute();
  const zoneByCode = new Map(zoneRows.map((z) => [z.code, z]));
  const root = zoneByCode.get(plan.options.rootZone.code);
  for (const zone of plan.zones) {
    const existing = zoneByCode.get(zone.code);
    if (!existing) continue;
    if (Number(existing.is_active) !== 1) bad(`La zone ${zone.code} existe mais est inactive.`);
    if (
      zone.parentCode !== null &&
      (!root || !existing.parent_id || !existing.parent_id.equals(root.id))
    )
      bad(`La zone ${zone.code} existe mais n'est pas sous ${plan.options.rootZone.code}.`);
  }

  let existingCustomers = 0;
  for (const part of chunk(
    plan.customers.map((c) => c.id),
    200,
  )) {
    const row = await db
      .selectFrom('crm_customers')
      .select((eb) => eb.fn.countAll().as('n'))
      .where(
        'id',
        'in',
        part.map((id) => app.toBin(id)),
      )
      .executeTakeFirst();
    existingCustomers += Number(row.n);
  }
  const device = await db
    .selectFrom('identity_devices')
    .select(['id', 'status'])
    .where('label', '=', DEVICE_LABEL)
    .executeTakeFirst();

  if (managerRow)
    notes.push(
      'Compte du responsable : existe deja (aucune creation, aucun mot de passe demande).',
    );
  else notes.push('Compte du responsable : a creer.');
  notes.push(
    `Zones : ${plan.zones.filter((z) => zoneByCode.has(z.code)).length} existent deja sur ${plan.zones.length}.`,
  );
  notes.push(
    `Clients deja presents (par identifiant deterministe) : ${existingCustomers} sur ${plan.customers.length}.`,
  );
  notes.push(`Appareil de reprise : ${device ? `existe (${device.status})` : 'a creer'}.`);

  return {
    errors,
    notes,
    refs: {
      stepIds,
      categoryIds,
      outcomeIds,
      zoneIds: new Map(zoneRows.map((z) => [z.code, fromBin(z.id)])),
    },
    admin,
    systemUserId: systemRow ? fromBin(systemRow.id) : null,
    roleId: role ? fromBin(role.id) : null,
    manager: managerRow ? { id: fromBin(managerRow.id), existing: true } : null,
    zoneByCode,
    existingCustomers,
    deviceId: device ? fromBin(device.id) : null,
  };
}

// --- Liste des commandes historiques (clients, etapes, visites, appels) -------------------------------------------

/** Meme liste pour l'ecriture et la verification : identifiants et empreintes ne dependent que des donnees. */
function buildHistoricalCommands(plan, refs, managerId, salt) {
  const customerIds = new Map(plan.customers.map((c) => [c.key, c.id]));
  const commands = [];
  const base = (spec) => ({
    ...spec,
    commandId: map.commandIdOf(salt, spec.type, spec.key, Date.parse(spec.occurredAt)),
  });
  for (const c of plan.customers) {
    commands.push(
      base({
        phase: 'clients',
        type: 'crm.customer.create',
        aggregateType: 'CUSTOMER',
        aggregateId: c.id,
        occurredAt: c.occurredAt,
        reason: c.reason,
        payload: map.customerPayload(c, refs),
        key: c.key,
        ligne: c.ligne,
      }),
    );
  }
  for (const s of plan.stepChanges) {
    commands.push(
      base({
        phase: 'etapes',
        type: 'crm.customer.set_pipeline_step',
        aggregateType: 'CUSTOMER',
        aggregateId: customerIds.get(s.customerKey),
        occurredAt: s.occurredAt,
        reason: s.reason,
        payload: { stepId: refs.stepIds.get(s.stepCode), legacy: { etape: s.stepCode } },
        key: `${s.customerKey}|${s.stepCode}`,
        ligne: s.ligne,
      }),
    );
  }
  for (const v of plan.visits) {
    commands.push(
      base({
        phase: 'visites',
        type: 'crm.visit.record',
        aggregateType: 'VISIT',
        aggregateId: v.id,
        occurredAt: v.occurredAt,
        reason: v.reason,
        payload: map.visitPayload(v, customerIds.get(v.customerKey), refs),
        key: v.ref,
        ligne: v.ligne,
      }),
    );
  }
  for (const i of plan.interactions) {
    commands.push(
      base({
        phase: 'appels',
        type: 'crm.interaction.record',
        aggregateType: 'INTERACTION',
        aggregateId: i.id,
        occurredAt: i.occurredAt,
        reason: i.reason,
        payload: map.interactionPayload(i, customerIds.get(i.customerKey)),
        key: i.ref,
        ligne: i.ligne,
      }),
    );
  }
  return commands.map((command) => ({ ...command, author: managerId }));
}

// --- Verification ligne a ligne --------------------------------------------------------------------------------------

async function verifyAll(app, db, plan, refs, managerId, commands, startedAt) {
  const { fromBin, toBin } = app;
  const checks = [];
  const problems = [];
  const check = (name, expected, found) =>
    checks.push({ name, expected, found, ok: expected === found });
  const problem = (message) => problems.push(message);

  // Zones
  const zoneRows = await db
    .selectFrom('organization_zones')
    .select(['id', 'code', 'level', 'parent_id', 'is_active'])
    .where(
      'code',
      'in',
      plan.zones.map((z) => z.code),
    )
    .execute();
  check('zones presentes', plan.zones.length, zoneRows.length);
  const zoneByCode = new Map(zoneRows.map((z) => [z.code, z]));
  const rootRow = zoneByCode.get(plan.options.rootZone.code);
  check(
    'zones actives',
    plan.zones.length,
    zoneRows.filter((z) => Number(z.is_active) === 1).length,
  );
  check(
    'zones sous la racine (niveau QUARTIER)',
    plan.zones.length - 1,
    rootRow
      ? zoneRows.filter(
          (z) => z.level === 'QUARTIER' && z.parent_id && z.parent_id.equals(rootRow.id),
        ).length
      : 0,
  );
  const zoneIdOf = (code) => (zoneByCode.has(code) ? fromBin(zoneByCode.get(code).id) : null);

  // Compte et affectation
  const user = await db
    .selectFrom('identity_users')
    .select(['id', 'status', 'email'])
    .where('id', '=', toBin(managerId))
    .executeTakeFirst();
  check('compte du responsable actif', 1, user && user.status === 'ACTIVE' ? 1 : 0);
  const assignment = rootRow
    ? await db
        .selectFrom('identity_user_role_assignments as ura')
        .innerJoin('identity_roles as r', 'r.id', 'ura.role_id')
        .select(['ura.valid_from', 'ura.valid_to'])
        .where('ura.user_id', '=', toBin(managerId))
        .where('r.code', '=', ROLE_CODE)
        .where('ura.scope_type', '=', 'ZONE')
        .where('ura.scope_zone_id', '=', rootRow.id)
        .where('ura.revoked_at', 'is', null)
        .executeTakeFirst()
    : undefined;
  check(
    `affectation ${ROLE_CODE} / ZONE ${plan.options.rootZone.code} valable des le ${plan.options.managerStart}`,
    1,
    assignment && assignment.valid_from.getTime() <= plan.startAt && assignment.valid_to === null
      ? 1
      : 0,
  );

  // Clients
  const expectedDuplicates = new Set();
  const order = new Map(plan.customers.map((c, index) => [c.number, index]));
  for (const group of plan.duplicates.phones) {
    [...group]
      .sort((a, b) => order.get(a) - order.get(b))
      .slice(1)
      .forEach((n) => expectedDuplicates.add(n));
  }
  const customerRows = new Map();
  for (const part of chunk(plan.customers, 100)) {
    const rows = await db
      .selectFrom('crm_customers')
      .selectAll()
      .where(
        'id',
        'in',
        part.map((c) => toBin(c.id)),
      )
      .execute();
    for (const row of rows) customerRows.set(fromBin(row.id), row);
  }
  check('clients presents', plan.customers.length, customerRows.size);
  let customerFieldErrors = 0;
  let duplicateFlagged = 0;
  for (const c of plan.customers) {
    const row = customerRows.get(c.id);
    if (!row) continue;
    const wrong = [];
    if (row.display_name !== c.displayName) wrong.push('nom');
    const expectedPhone =
      c.phonePrimary === null ? null : app.domain.normalizePhone(c.phonePrimary, '237');
    if (row.phone_primary !== expectedPhone) wrong.push('telephone');
    if (fromBin(row.zone_id) !== zoneIdOf(c.zoneCode)) wrong.push('zone');
    if (row.source_code !== c.sourceCode) wrong.push('source');
    const expectedCategory = c.categoryCode === null ? null : refs.categoryIds.get(c.categoryCode);
    if ((row.category_id === null ? null : fromBin(row.category_id)) !== expectedCategory)
      wrong.push('categorie');
    if (row.customer_type !== (c.customerType ?? 'PARTICULIER')) wrong.push('type de compte');
    if (row.business_activity !== c.businessActivity) wrong.push('activite');
    if (row.address_text !== c.addressText) wrong.push('adresse');
    if (row.stage !== 'PROSPECT') wrong.push('stade');
    if (!row.owner_user_id || fromBin(row.owner_user_id) !== managerId) wrong.push('titulaire');
    if (fromBin(row.acquired_by_user_id) !== managerId) wrong.push('acquereur');
    if (row.acquired_at.getTime() !== Date.parse(c.occurredAt)) wrong.push('date de creation');
    if (row.backdated_reason !== c.reason) wrong.push('motif de reprise');
    if (!row.pipeline_step_id || fromBin(row.pipeline_step_id) !== refs.stepIds.get(c.stepCode))
      wrong.push('etape');
    const isDuplicate = row.duplicate_of_id !== null;
    if (isDuplicate) duplicateFlagged += 1;
    if (isDuplicate !== expectedDuplicates.has(c.number))
      wrong.push(isDuplicate ? 'doublon inattendu' : 'doublon non signale');
    if (wrong.length > 0) {
      customerFieldErrors += 1;
      problem(`Client N${c.number} (L${c.ligne}) : ${wrong.join(', ')}`);
    }
  }
  check(
    'clients dont tous les champs concordent',
    plan.customers.length,
    plan.customers.length - customerFieldErrors,
  );
  check('doublons de telephone signales par le serveur', expectedDuplicates.size, duplicateFlagged);

  let history = 0;
  for (const part of chunk(plan.customers, 100)) {
    const row = await db
      .selectFrom('crm_customer_stage_history')
      .select((eb) => eb.fn.countAll().as('n'))
      .where(
        'customer_id',
        'in',
        part.map((c) => toBin(c.id)),
      )
      .executeTakeFirst();
    history += Number(row.n);
  }
  check(
    "lignes d'historique d'etape (creation + changements)",
    plan.customers.length + plan.stepChanges.length,
    history,
  );

  // Visites et appels
  const visitRows = new Map();
  for (const part of chunk(plan.visits, 100)) {
    const rows = await db
      .selectFrom('crm_visits')
      .selectAll()
      .where(
        'id',
        'in',
        part.map((v) => toBin(v.id)),
      )
      .execute();
    for (const row of rows) visitRows.set(fromBin(row.id), row);
  }
  check('visites presentes', plan.visits.length, visitRows.size);
  let visitErrors = 0;
  for (const v of plan.visits) {
    const row = visitRows.get(v.id);
    if (!row) continue;
    const wrong = [];
    const customerId = plan.customers.find((c) => c.key === v.customerKey).id;
    if (fromBin(row.customer_id) !== customerId) wrong.push('client');
    if (fromBin(row.user_id) !== managerId) wrong.push('visiteur');
    if (row.occurred_at.getTime() !== Date.parse(v.occurredAt)) wrong.push('date');
    if (fromBin(row.outcome_reason_code_id) !== refs.outcomeIds.get(v.outcomeCode))
      wrong.push('resultat');
    if (row.notes !== v.text) wrong.push('notes');
    if (dayOfDate(row.next_action_at) !== v.nextActionAt) wrong.push('prochaine action (date)');
    if ((row.next_action_note ?? null) !== v.nextActionNote) wrong.push('prochaine action (texte)');
    if (row.status !== 'RECORDED') wrong.push('statut');
    if (row.backdated_reason !== v.reason) wrong.push('motif de reprise');
    if (wrong.length > 0) {
      visitErrors += 1;
      problem(`Visite ${v.ref} (L${v.ligne}) : ${wrong.join(', ')}`);
    }
  }
  check(
    'visites dont tous les champs concordent',
    plan.visits.length,
    plan.visits.length - visitErrors,
  );

  const interactionRows = new Map();
  for (const part of chunk(plan.interactions, 100)) {
    const rows = await db
      .selectFrom('crm_interactions')
      .selectAll()
      .where(
        'id',
        'in',
        part.map((i) => toBin(i.id)),
      )
      .execute();
    for (const row of rows) interactionRows.set(fromBin(row.id), row);
  }
  check('appels presents', plan.interactions.length, interactionRows.size);
  let interactionErrors = 0;
  for (const i of plan.interactions) {
    const row = interactionRows.get(i.id);
    if (!row) continue;
    const wrong = [];
    const customerId = plan.customers.find((c) => c.key === i.customerKey).id;
    if (fromBin(row.customer_id) !== customerId) wrong.push('client');
    if (fromBin(row.user_id) !== managerId) wrong.push('auteur');
    if (row.occurred_at.getTime() !== Date.parse(i.occurredAt)) wrong.push('date');
    if (row.channel !== i.channel) wrong.push('canal');
    if ((row.summary ?? null) !== i.text) wrong.push('resume');
    if (dayOfDate(row.next_action_at) !== i.nextActionAt) wrong.push('prochaine action (date)');
    if ((row.next_action_note ?? null) !== i.nextActionNote) wrong.push('prochaine action (texte)');
    if (row.status !== 'RECORDED') wrong.push('statut');
    if (wrong.length > 0) {
      interactionErrors += 1;
      problem(`Appel ${i.ref} (L${i.ligne}) : ${wrong.join(', ')}`);
    }
  }
  check(
    'appels dont tous les champs concordent',
    plan.interactions.length,
    plan.interactions.length - interactionErrors,
  );

  // Journal des commandes et audit
  const ids = commands.map((command) => command.commandId);
  let inboxOk = 0;
  const inboxByStatus = {};
  for (const part of chunk(ids, 200)) {
    const rows = await db
      .selectFrom('sync_command_inbox')
      .select(['status'])
      .where(
        'command_id',
        'in',
        part.map((id) => toBin(id)),
      )
      .execute();
    for (const row of rows) {
      inboxByStatus[row.status] = (inboxByStatus[row.status] ?? 0) + 1;
      if (OK_STATUSES.has(row.status)) inboxOk += 1;
    }
  }
  check('commandes appliquees dans le journal des commandes', commands.length, inboxOk);
  let auditCount = 0;
  let legacyKept = 0;
  const customerCommandIds = new Set(
    commands
      .filter((command) => command.type === 'crm.customer.create')
      .map((command) => command.commandId),
  );
  for (const part of chunk(ids, 200)) {
    const rows = await db
      .selectFrom('audit_audit_log')
      .select(['command_id', 'action', 'after'])
      .where(
        'command_id',
        'in',
        part.map((id) => toBin(id)),
      )
      .execute();
    for (const row of rows) {
      auditCount += 1;
      if (row.action === 'crm.customer.create' && customerCommandIds.has(fromBin(row.command_id))) {
        const after = row.after === null ? null : asObject(row.after);
        if (
          after &&
          after.legacy &&
          after.legacy.valeurs &&
          Object.keys(after.legacy.valeurs).length > 0
        )
          legacyKept += 1;
      }
    }
  }
  check("lignes du journal d'audit (une par commande)", commands.length, auditCount);
  check(
    "lignes source de clients conservees dans le journal d'audit",
    plan.customers.length,
    legacyKept,
  );

  const ok = checks.every((item) => item.ok) && problems.length === 0;
  return { ok, checks, problems, inboxByStatus, startedAt };
}

// --- Rapport ---------------------------------------------------------------------------------------------------------

function renderMarkdown(report) {
  const out = [];
  const line = (text = '') => out.push(text);
  line(`# Rapport de reprise du reporting commercial (${report.mode})`);
  line();
  line(
    `- Date : ${report.startedAt} ; classeur : ${report.plan.options.classeur} (${report.plan.options.classeurDate}).`,
  );
  if (report.target)
    line(`- Base cible : ${report.target.host}:${report.target.port}/${report.target.database}.`);
  if (report.backup)
    line(
      `- Sauvegarde avant ecriture : ${report.backup.file} (${Math.round(report.backup.bytes / 1024)} Ko).`,
    );
  line(
    `- Sources : ${report.plan.stats.sources.clients} clients, ${report.plan.stats.sources.contacts} contacts, ${report.plan.stats.sources.journal} journees.`,
  );
  line();
  line('## Plan');
  line();
  line(`- Zones a creer ou retrouver : ${report.plan.stats.zones} (racine + quartiers).`);
  line(
    `- Comptes prospects : ${report.plan.stats.customers} (dont ${report.plan.stats.customersSeptembre} repris de la fiche de septembre) ; changements d'etape : ${report.plan.stats.stepChanges}.`,
  );
  line(
    `- Contacts : ${report.plan.stats.contacts} = ${report.plan.stats.visits} visites + ${report.plan.stats.interactions} appels.`,
  );
  line(
    `- Journal : ${report.plan.stats.journalArchive} journees archivees dans ce rapport, non ecrites dans les tables de pointage.`,
  );
  line(
    `- Doublons signales : telephones ${report.plan.stats.doublons.telephones}, noms ${report.plan.stats.doublons.noms}, codes ${report.plan.stats.doublons.codes}.`,
  );
  line();
  if (report.preflight) {
    line('## Base');
    line();
    for (const note of report.preflight.notes) line(`- ${note}`);
    for (const error of report.preflight.errors) line(`- ERREUR : ${error}`);
    line();
  }
  line('## Anomalies et remarques');
  line();
  line(
    'Regroupees par gravite, code et message ; les lignes sont celles du classeur (feuille indiquee). Detail complet : rapport.json.',
  );
  line();
  const rank = { ERREUR: 0, AVERTISSEMENT: 1, INFO: 2 };
  const groups = new Map();
  for (const a of report.plan.anomalies) {
    const key = `${a.severity}|${a.code}|${a.sheet}|${a.message}`;
    const group = groups.get(key) ?? { ...a, lignes: [] };
    if (a.ligne !== null && a.ligne !== undefined) group.lignes.push(a.ligne);
    groups.set(key, group);
  }
  line('| Gravite | Code | Feuille | Nb | Lignes | Message |');
  line('|---|---|---|---|---|---|');
  const ordered = [...groups.values()].sort(
    (a, b) => rank[a.severity] - rank[b.severity] || a.code.localeCompare(b.code),
  );
  for (const g of ordered) {
    const shown = g.lignes.slice(0, 40).join(', ') + (g.lignes.length > 40 ? ', ...' : '');
    line(
      `| ${g.severity} | ${g.code} | ${g.sheet} | ${g.lignes.length === 0 ? 1 : g.lignes.length} | ${shown} | ${String(g.message).replace(/\|/g, '\\|')} |`,
    );
  }
  line();
  if (report.apply) {
    line('## Ecriture');
    line();
    line('| Etape | Reussies | Dont avertissements | Refusees |');
    line('|---|---|---|---|');
    for (const [phase, r] of Object.entries(report.apply.phases))
      line(`| ${phase} | ${r.applied} | ${r.warnings} | ${r.failed} |`);
    line();
    for (const failure of report.apply.failures)
      line(
        `- REFUS ${failure.phase} L${failure.ligne ?? '?'} ${failure.key} : ${failure.code} - ${failure.message}`,
      );
    line();
  }
  if (report.verification) {
    line('## Verification ligne a ligne');
    line();
    line('| Controle | Attendu | Trouve | Resultat |');
    line('|---|---|---|---|');
    for (const c of report.verification.checks)
      line(`| ${c.name} | ${c.expected} | ${c.found} | ${c.ok ? 'OK' : 'ECART'} |`);
    line();
    for (const p of report.verification.problems) line(`- ECART : ${p}`);
    line();
    line(`Resultat global : **${report.verification.ok ? 'CONFORME' : 'ECARTS A EXAMINER'}**.`);
    line();
  }
  line('## Zones');
  line();
  line('| Code | Nom | Niveau | Prospects | Orthographes saisies |');
  line('|---|---|---|---|---|');
  for (const z of report.plan.zones)
    line(
      `| ${z.code} | ${z.name} | ${z.level} | ${z.count} | ${z.variants.map((v) => `${v.variant} x${v.count}`).join(', ')} |`,
    );
  line();
  line('## Journal archive (14 journees, non ecrit dans les tables de pointage)');
  line();
  for (const day of report.plan.journal)
    line(`- ${day.day} (ligne ${day.ligne}) : ${JSON.stringify(day.valeurs)}`);
  line();
  return out.join('\n');
}

function writeReport(reportDir, report) {
  fs.mkdirSync(reportDir, { recursive: true });
  const jsonPath = path.join(reportDir, 'rapport.json');
  const mdPath = path.join(reportDir, 'rapport.md');
  const slim = {
    ...report,
    plan: {
      ...report.plan,
      customers: undefined,
      visits: undefined,
      interactions: undefined,
      stepChanges: undefined,
      startAt: undefined,
    },
  };
  fs.writeFileSync(jsonPath, JSON.stringify(slim, null, 2), 'utf8');
  fs.writeFileSync(mdPath, renderMarkdown(report), 'utf8');
  return { jsonPath, mdPath };
}

// --- Programme principal -----------------------------------------------------------------------------------------------

let pool = null;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.flags.has('help')) {
    console.log(USAGE);
    return 0;
  }
  const modes = ['dry-run', 'apply', 'verify-only'].filter((mode) => args.flags.has(mode));
  if (modes.length !== 1)
    throw new Fatal(`Choisir un seul mode : --dry-run, --apply ou --verify-only.\n${USAGE}`, 2);
  const mode = modes[0];
  const dataPath = args.values.get('data');
  if (!dataPath) throw new Fatal(`--data est obligatoire.\n${USAGE}`, 2);
  if (args.flags.has('offline') && mode !== 'dry-run')
    throw new Fatal("--offline n'a de sens qu'avec --dry-run.", 2);

  const startedAt = new Date();
  const source = JSON.parse(fs.readFileSync(path.resolve(dataPath), 'utf8'));
  const rootName = args.values.get('root-zone-name');
  const rootCode = args.values.get('root-zone-code');
  const plan = map.buildPlan(source, {
    ...(args.values.has('classeur') ? { classeur: args.values.get('classeur') } : {}),
    ...(args.values.has('classeur-date') ? { classeurDate: args.values.get('classeur-date') } : {}),
    ...(args.values.has('manager-start') ? { managerStart: args.values.get('manager-start') } : {}),
    rootZone: {
      ...map.ROOT_ZONE,
      ...(rootName ? { name: rootName } : {}),
      ...(rootCode ? { code: rootCode } : {}),
    },
  });
  for (const [option, found, label] of [
    ['expect-clients', plan.stats.sources.clients, 'clients'],
    ['expect-contacts', plan.stats.sources.contacts, 'contacts'],
    ['expect-journal', plan.stats.sources.journal, 'journees'],
  ]) {
    if (args.values.has(option) && Number(args.values.get(option)) !== found)
      throw new Fatal(
        `Decompte inattendu : ${found} ${label} lus, ${args.values.get(option)} attendus (--${option}).`,
      );
  }

  const report = {
    mode,
    startedAt: startedAt.toISOString(),
    plan,
    preflight: null,
    apply: null,
    verification: null,
    target: null,
  };
  const reportDir = path.resolve(
    args.values.get('report-dir') ?? `rapport-import-reporting-${utcStamp(startedAt)}`,
  );
  const errorsInPlan = plan.anomalies.filter((a) => a.severity === 'ERREUR');

  console.log(
    `Plan : ${plan.stats.zones} zones, ${plan.stats.customers} clients, ${plan.stats.stepChanges} changements d'etape, ${plan.stats.visits} visites, ${plan.stats.interactions} appels, ${plan.stats.journalArchive} journees archivees.`,
  );
  console.log(
    `Anomalies : ${errorsInPlan.length} erreur(s), ${plan.anomalies.filter((a) => a.severity === 'AVERTISSEMENT').length} avertissement(s), ${plan.anomalies.filter((a) => a.severity === 'INFO').length} information(s).`,
  );
  for (const a of errorsInPlan)
    console.log(`  ERREUR ${a.code} (${a.sheet} L${a.ligne ?? '-'}) : ${a.message}`);
  if (errorsInPlan.length > 0) {
    const paths = writeReport(reportDir, report);
    console.log(`Rapport : ${paths.mdPath}`);
    throw new Fatal('Des erreurs dans les donnees interdisent la suite.');
  }
  if (args.flags.has('offline')) {
    const paths = writeReport(reportDir, report);
    console.log(`Essai a blanc hors base termine. Rapport : ${paths.mdPath}`);
    return 0;
  }

  // Application et base
  const appDir = path.resolve(args.values.get('app-dir') ?? process.cwd());
  const codeDir = path.resolve(appDir, args.values.get('code-dir') ?? 'dist');
  const app = await loadApp(appDir, codeDir);
  const url = process.env.SERVER_DATABASE_URL;
  if (!url)
    throw new Fatal(
      "SERVER_DATABASE_URL non defini (lancer avec --env-file=.env ou le poser dans l'environnement).",
      2,
    );
  report.target = describeTarget(url);
  const created = app.createDatabase(url);
  const db = created.db;
  pool = created.pool;
  const versionResult = await app.kysely.sql`SELECT VERSION() AS v`.execute(db);
  const serverVersion = String(versionResult.rows[0].v);
  if (/mariadb/i.test(serverVersion)) installMariaDbCompat(app.kysely.DefaultQueryCompiler);
  console.log(
    `Base : ${report.target.host}:${report.target.port}/${report.target.database} (${/mariadb/i.test(serverVersion) ? 'MariaDB' : 'MySQL'} ${serverVersion}).`,
  );

  const preflight = await loadPreflight(app, db, plan, args);
  report.preflight = { notes: preflight.notes, errors: preflight.errors };
  for (const note of preflight.notes) console.log(`  ${note}`);
  for (const error of preflight.errors) console.log(`  ERREUR : ${error}`);
  if (preflight.errors.length > 0) {
    const paths = writeReport(reportDir, report);
    console.log(`Rapport : ${paths.mdPath}`);
    throw new Fatal('La base ne permet pas la reprise (voir les erreurs ci-dessus).');
  }

  const salt = args.values.get('run-salt') ?? 'r1';
  const managerEmail = args.values.get('manager-email');
  const managerName = args.values.get('manager-name');
  const managerPhone = args.values.get('manager-phone');
  if (!managerEmail) throw new Fatal('--manager-email est obligatoire.', 2);
  if (!preflight.manager && mode === 'apply') {
    if (!managerName) throw new Fatal('--manager-name est obligatoire pour creer le compte.', 2);
    if (!managerPhone || !/^\+[1-9][0-9]{7,14}$/.test(managerPhone))
      throw new Fatal(
        '--manager-phone (E.164, ex. +237...) est obligatoire pour creer le compte : le schema exige un telephone unique sur chaque compte.',
        2,
      );
  }
  if (!preflight.manager && mode === 'dry-run' && (!managerName || !managerPhone)) {
    console.log(
      '  Rappel : --manager-name et --manager-phone (E.164) seront obligatoires avec --apply pour creer le compte.',
    );
  }
  const managerId = preflight.manager
    ? preflight.manager.id
    : map.entityId('user', managerEmail.toLowerCase(), SYSTEM_EPOCH_MS);
  // Identifiants de zone : ceux qui existent, sinon ceux que la creation leur donnera (deterministes).
  const zoneIds = new Map(preflight.refs.zoneIds);
  for (const zone of plan.zones)
    if (!zoneIds.has(zone.code))
      zoneIds.set(zone.code, map.entityId('zone', zone.code, SYSTEM_EPOCH_MS));
  const refs = { ...preflight.refs, zoneIds };
  const commands = buildHistoricalCommands(plan, refs, managerId, salt);

  if (mode === 'dry-run') {
    const paths = writeReport(reportDir, report);
    console.log(
      `Essai a blanc termine : rien n'a ete ecrit. ${commands.length} commandes historiques preparees (${plan.customers.length} clients, ${plan.stepChanges.length} etapes, ${plan.visits.length} visites, ${plan.interactions.length} appels).`,
    );
    console.log(`Rapport : ${paths.mdPath}`);
    return 0;
  }

  if (mode === 'verify-only') {
    if (!preflight.manager) throw new Fatal('Compte du responsable introuvable : rien a verifier.');
    report.verification = await verifyAll(
      app,
      db,
      plan,
      refs,
      managerId,
      commands,
      startedAt.toISOString(),
    );
    const paths = writeReport(reportDir, report);
    printVerification(report.verification);
    console.log(`Rapport : ${paths.mdPath}`);
    return report.verification.ok ? 0 : 1;
  }

  // --apply -----------------------------------------------------------------------------------------------------------
  if (!args.flags.has('yes')) {
    if (!isTty()) throw new Fatal('Confirmation impossible hors terminal : relancer avec --yes.');
    const answer = await readLine(
      `Ecrire ${commands.length} commandes (+ zones, compte, affectation) dans ${report.target.database} sur ${report.target.host} ? Taper OUI : `,
    );
    if (answer.trim() !== 'OUI') throw new Fatal("Abandon : rien n'a ete ecrit.");
  }
  const password = preflight.manager
    ? null
    : await resolvePassword(args.values.get('manager-password-env') ?? 'RESCOM_INITIAL_PASSWORD');

  if (args.flags.has('no-backup')) {
    console.log("ATTENTION : --no-backup, la base n'est pas sauvegardee avant l'ecriture.");
  } else {
    const backup = await backupDatabase(
      url,
      path.resolve(args.values.get('backup-dir') ?? path.join(os.homedir(), 'backups_db')),
      utcStamp(startedAt),
    );
    report.backup = { file: path.basename(backup.file), bytes: backup.size };
    console.log(`Sauvegarde de la base : ${backup.file} (${Math.round(backup.size / 1024)} Ko).`);
  }

  const clock = new app.domain.SystemClock();
  const idGenerator = new app.domain.Uuidv7Generator(clock);
  const registry = new app.CommandHandlerRegistry();
  app.registerUserCommands(registry);
  app.registerZoneCommands(registry);
  app.registerCustomerCommands(registry, idGenerator);
  app.registerActivityCommands(registry);
  const pipeline = new app.CommandPipelineService(db, registry, clock, idGenerator);
  const deps = { clock, idGenerator };

  // Appareil de reprise (le pipeline exige un appareil actif, RC-02)
  let deviceId = preflight.deviceId;
  if (deviceId === null) {
    deviceId = await createScriptDevice(app, db, deps, preflight);
    console.log(
      "Appareil de reprise cree (a retirer dans l'ecran Appareils une fois la reprise verifiee).",
    );
  }

  const apply = { phases: {}, failures: [] };
  report.apply = apply;
  const bump = (phase, key) => {
    apply.phases[phase] = apply.phases[phase] ?? { applied: 0, warnings: 0, failed: 0 };
    apply.phases[phase][key] += 1;
  };
  let consecutiveFailures = 0;
  const send = async (spec) => {
    const occurredAt = spec.occurredAt;
    const envelope = {
      command_id:
        spec.commandId ?? map.commandIdOf(salt, spec.type, spec.key, Date.parse(occurredAt)),
      device_seq: 1,
      command_version: 1,
      command_type: spec.type,
      aggregate_type: spec.aggregateType,
      aggregate_id: spec.aggregateId,
      author_user_id: spec.author,
      base_version: null,
      depends_on: [],
      occurred_at: occurredAt,
      client_created_at: occurredAt, // deterministe : une reprise identique garde la meme empreinte
      captured_offline: spec.capturedOffline,
      backdated_reason: spec.reason ?? null,
      attachment_ids: [],
      payload: spec.payload,
    };
    let result;
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      try {
        result = await pipeline.handle(envelope, {
          authenticatedUserId: spec.author,
          authenticatedDeviceId: deviceId,
          transport: 'SYSTEM',
        });
      } catch (error) {
        result = {
          status: 'REJECTED',
          error: {
            code: 'ENVELOPE',
            message_fr: error instanceof Error ? error.message : String(error),
          },
        };
      }
      if (result.status !== 'RETRY_LATER') break;
      await sleep(1500 * attempt);
    }
    if (OK_STATUSES.has(result.status)) {
      bump(spec.phase, 'applied');
      if (result.status === 'APPLIED_WITH_WARNINGS') bump(spec.phase, 'warnings');
      consecutiveFailures = 0;
      return true;
    }
    bump(spec.phase, 'failed');
    apply.failures.push({
      phase: spec.phase,
      key: spec.key,
      ligne: spec.ligne ?? null,
      code: result.error?.code ?? result.status,
      message: result.error?.message_fr ?? '',
    });
    consecutiveFailures += 1;
    console.log(
      `  REFUS ${spec.phase} ${spec.key} : ${result.error?.code ?? result.status} ${result.error?.message_fr ?? ''}`,
    );
    if (consecutiveFailures >= MAX_FAILURES)
      throw new Fatal(
        `${MAX_FAILURES} refus de suite : arret. Corriger la cause puis relancer (avec --run-salt <autre sel> pour rejouer les commandes refusees).`,
      );
    return false;
  };

  try {
    // 1. Zones (administrateur, maintenant) : la racine d'abord
    const nowIso = () => new Date().toISOString();
    const rootZone = plan.zones[0];
    for (const zone of plan.zones) {
      if (preflight.zoneByCode.has(zone.code)) continue;
      const payload = {
        code: zone.code,
        name: zone.name,
        level: zone.level,
        ...(zone.parentCode === null ? {} : { parentId: zoneIds.get(zone.parentCode) }),
      };
      await send({
        phase: 'zones',
        type: 'organization.zone.create',
        aggregateType: 'ZONE',
        aggregateId: zoneIds.get(zone.code),
        author: preflight.admin.id,
        occurredAt: nowIso(),
        capturedOffline: false,
        reason: null,
        payload,
        key: zone.code,
      });
    }
    if (apply.failures.length > 0)
      throw new Fatal("Toutes les zones n'ont pas pu etre creees : arret.");
    console.log(`Zones pretes : ${plan.zones.length}.`);

    // 2. Compte du responsable (administrateur, maintenant) puis affectation datee du debut d'usage
    if (!preflight.manager) {
      const accountCreated = await send({
        phase: 'compte',
        type: 'identity.user.create',
        aggregateType: 'USER',
        aggregateId: managerId,
        author: preflight.admin.id,
        occurredAt: nowIso(),
        capturedOffline: false,
        reason: null,
        payload: {
          fullName: managerName,
          phone: managerPhone,
          email: managerEmail,
          initialPassword: password,
        },
        key: managerEmail.toLowerCase(),
      });
      if (!accountCreated)
        throw new Fatal("Le compte du responsable n'a pas pu etre cree : arret.");
      console.log(
        'Compte du responsable cree (changement de mot de passe impose a sa premiere connexion).',
      );
    }
    await ensureAssignment(app, db, deps, {
      managerId,
      roleId: preflight.roleId,
      rootZoneId: zoneIds.get(rootZone.code),
      systemUserId: preflight.systemUserId,
      startAt: plan.startAt,
      startDay: plan.options.managerStart,
    });
    app.invalidateUser(managerId);

    // 3. Historique, avec le responsable pour auteur
    let sent = 0;
    for (const command of commands) {
      await send({ ...command, capturedOffline: true });
      sent += 1;
      if (sent % 50 === 0) console.log(`  ${sent}/${commands.length} commandes traitees...`);
    }
    console.log(`Commandes historiques traitees : ${sent}.`);
  } catch (error) {
    const paths = writeReport(reportDir, report);
    console.log(`Rapport partiel : ${paths.mdPath}`);
    throw error;
  }

  // 4. Verification ligne a ligne
  report.verification = await verifyAll(
    app,
    db,
    plan,
    refs,
    managerId,
    commands,
    startedAt.toISOString(),
  );
  const paths = writeReport(reportDir, report);
  printVerification(report.verification);
  const failed = apply.failures.length;
  console.log(`Rapport : ${paths.mdPath}`);
  console.log(
    failed > 0 ? `${failed} commande(s) refusee(s) : voir le rapport.` : 'Aucune commande refusee.',
  );
  return report.verification.ok && failed === 0 ? 0 : 1;
}

function printVerification(verification) {
  console.log('Verification :');
  for (const c of verification.checks)
    console.log(
      `  ${c.ok ? 'OK   ' : 'ECART'} ${c.name} : attendu ${c.expected}, trouve ${c.found}`,
    );
  for (const p of verification.problems.slice(0, 20)) console.log(`  ECART ${p}`);
  if (verification.problems.length > 20)
    console.log(`  ... ${verification.problems.length - 20} autre(s) ecart(s) dans le rapport.`);
  console.log(verification.ok ? 'Resultat : CONFORME.' : 'Resultat : ECARTS A EXAMINER.');
}

async function createScriptDevice(app, db, deps, preflight) {
  const { toBin } = app;
  const id = map.entityId('device', 'reprise-reporting-commercial', SYSTEM_EPOCH_MS);
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const taken = async (code) =>
    (await db
      .selectFrom('identity_devices')
      .select('id')
      .where('short_code', '=', code)
      .executeTakeFirst()) !== undefined;
  let shortCode = DEVICE_SHORT_CODE;
  while (await taken(shortCode)) {
    shortCode = '';
    for (let i = 0; i < 4; i += 1)
      shortCode += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  await app.withUnitOfWork(db, async (uow) => {
    const now = deps.clock.now();
    await uow
      .insertInto('identity_devices')
      .values({
        id: toBin(id),
        short_code: shortCode,
        label: DEVICE_LABEL,
        enrolled_by_user_id: toBin(preflight.admin.id),
        status: 'ACTIVE',
        status_changed_at: now,
        approved_by: toBin(preflight.admin.id),
        created_by: toBin(preflight.admin.id),
      })
      .execute();
    await app.recordAudit(uow, deps, {
      occurredAt: now,
      actorUserId: preflight.systemUserId,
      actorRoles: [],
      action: 'identity.device.approve',
      entityType: 'DEVICE',
      entityId: id,
      after: { label: DEVICE_LABEL, short_code: shortCode, status: 'ACTIVE' },
      reason:
        'Appareil de reprise de donnees (import-reporting-commercial.mjs), autorise par le porteur',
      result: 'SUCCESS',
    });
  });
  return id;
}

async function ensureAssignment(app, db, deps, input) {
  const { toBin } = app;
  const existing = await db
    .selectFrom('identity_user_role_assignments')
    .select(['id', 'valid_from', 'valid_to'])
    .where('user_id', '=', toBin(input.managerId))
    .where('role_id', '=', toBin(input.roleId))
    .where('scope_type', '=', 'ZONE')
    .where('scope_zone_id', '=', toBin(input.rootZoneId))
    .where('revoked_at', 'is', null)
    .executeTakeFirst();
  if (existing) {
    if (existing.valid_from.getTime() > input.startAt)
      throw new Fatal(
        `Une affectation ${ROLE_CODE} existe deja mais commence apres le ${input.startDay} : elle ne couvre pas les faits d'octobre. A corriger avant de relancer.`,
      );
    console.log('Affectation du role deja en place.');
    return;
  }
  await app.withUnitOfWork(db, async (uow) => {
    const assignmentId = deps.idGenerator.newId();
    const validFrom = new Date(input.startAt);
    const refusal = await app.insertRoleAssignment(uow, {
      assignmentId,
      userId: input.managerId,
      roleId: input.roleId,
      scopeType: 'ZONE',
      scopeZoneId: input.rootZoneId,
      validFrom,
      createdBy: input.systemUserId,
    });
    if (refusal) throw new Fatal(`Affectation refusee : ${refusal.message}`);
    await app.recordAudit(uow, deps, {
      occurredAt: deps.clock.now(),
      actorUserId: input.systemUserId,
      actorRoles: [],
      action: 'identity.role_assignment.grant',
      entityType: 'ROLE_ASSIGNMENT',
      entityId: assignmentId,
      after: {
        user_id: input.managerId,
        role_id: input.roleId,
        role_code: ROLE_CODE,
        scope_type: 'ZONE',
        scope_zone_id: input.rootZoneId,
        valid_from: validFrom.toISOString(),
      },
      reason: `Reprise du reporting commercial (import-reporting-commercial.mjs) : affectation datee du debut d'usage, ${input.startDay}`,
      result: 'SUCCESS',
    });
    await app.recordChanges(uow, [
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
        occurred_at: deps.clock.now(),
        payload: app.jsonValue({
          userId: input.managerId,
          roleId: input.roleId,
          scopeType: 'ZONE',
          scopeZoneId: input.rootZoneId,
          validFrom: validFrom.toISOString(),
        }),
        command_id: null,
        correlation_id: null,
      })
      .execute();
  });
  console.log(`Affectation ${ROLE_CODE} / ZONE posee a partir du ${input.startDay}.`);
}

let exitCode = 0;
try {
  exitCode = await main();
} catch (error) {
  if (error instanceof Fatal) {
    console.error(error.message);
    exitCode = error.exitCode;
  } else {
    console.error(error instanceof Error ? (error.stack ?? error.message) : error);
    exitCode = 1;
  }
} finally {
  if (pool) {
    // Pool mysql2 de style "callback" (createDatabase) : fermeture par rappel, jamais sur une promesse inexistante.
    await new Promise((resolve) => {
      try {
        const closing = pool.end(() => resolve());
        if (closing && typeof closing.then === 'function') closing.then(resolve, resolve);
      } catch {
        resolve();
      }
    });
  }
}
process.exit(exitCode);
