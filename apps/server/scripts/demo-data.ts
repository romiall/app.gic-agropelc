/**
 * Données de démonstration — DÉVELOPPEMENT LOCAL UNIQUEMENT (jamais en recette ni en production).
 *
 * Crée, sur la base désignée par `SERVER_DATABASE_URL` (en local : `gic_agropelc_dev`, `apps/server/.env`) :
 * - un **compte de démonstration** qui détient tous les rôles métier (Direction, Administration, commercial,
 *   vendeur PDV, magasinier, production, ferme, achats, Finance), pour parcourir tous les écrans de la PWA ;
 *   identifiant : le téléphone `DEMO_PHONE` ci-dessous ; **aucun mot de passe n'est écrit dans le code** : il
 *   est choisi par la personne qui lance le script (saisie masquée dans le terminal), ou lu dans la variable
 *   d'environnement `DEMO_PASSWORD` (fichier local non suivi, par exemple `apps/server/.env`) ;
 * - un jeu de données cohérent, écrit par les **vraies commandes** de l'application (pipeline, audit, flux de
 *   synchronisation) : zone, ferme, magasin central, point de vente, emplacements, caisses, unités, produits,
 *   prix, stock, clients, fournisseur, session de caisse et quelques ventes.
 *
 * Rejouable : chaque référentiel est retrouvé par son code avant d'être créé, et chaque étape d'activité
 * (stock, transfert, bon de commande, session de caisse, ventes, commande) n'est jouée que si sa trace
 * n'existe pas encore. Relancé, il propose de changer le mot de passe (Entrée le conserve ; sans terminal
 * interactif ni `DEMO_PASSWORD`, il le conserve) et **approuve les appareils du compte encore en attente** :
 * un appareil se connecte d'abord en `PENDING` — il lit, mais ce qu'il enregistre est mis en conflit tant
 * qu'il n'est pas approuvé (BR-ADM-005). Se connecter une première fois, relancer le script, puis recharger
 * la page.
 *
 * Écrans encore absents de la PWA (phase P5, en cours) : ouverture et clôture de caisse, quotas, validations,
 * appareils, utilisateurs, organisation, paramètres (« Bientôt ») — le script ouvre la session de caisse.
 *
 * Un compte qui cumule tous les rôles sert à **voir** l'application. La séparation des tâches reste appliquée :
 * certaines validations exigent une autre personne que l'auteur de l'opération (refus explicite à l'écran).
 *
 * Usage (racine du dépôt) : `pnpm run demo:data`.
 */
import './quiet-logs.js';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { sql } from 'kysely';
import type { CommandResult } from '@gic/contracts';
import type { IdGenerator } from '@gic/domain';
import { AppModule } from '../src/app.module.js';
import { CommandPipelineService } from '../src/commands/command-pipeline.service.js';
import { DATABASE, type Database } from '../src/platform/kysely/database.provider.js';
import { ID_GENERATOR } from '../src/platform/id-generator.provider.js';
import { fromBin, toBin } from '../src/platform/kysely/uuid-columns.js';
import { hashPassword } from '../src/modules/identity/application/auth/password.js';
import { invalidateUser } from '../src/modules/identity/application/rbac/rbac-cache.js';
import {
  recordStockMove,
  virtualLocationId,
} from '../src/modules/inventory/application/public/index.js';

/** Identifiant (téléphone) du compte de démonstration, local uniquement. Le mot de passe n'est jamais ici. */
export const DEMO_PHONE = '+237699000001';
const DEMO_NAME = 'Compte de démonstration';
/** Longueur minimale, comme au changement de mot de passe (`auth.controller.ts`, `new_password`). */
const PASSWORD_MIN_LENGTH = 8;

interface Actor {
  readonly userId: string;
  readonly deviceId: string;
}

/** Refus net hors d'une base locale de développement : le compte créé détient tous les rôles. */
function assertLocalDevelopment(): void {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Données de démonstration refusées : NODE_ENV=production.');
  }
  const url = process.env.SERVER_DATABASE_URL;
  const host = url ? new URL(url).hostname : '';
  if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(host)) {
    throw new Error(
      `Données de démonstration refusées : base hors de l'hôte local (${host || 'non définie'}).`,
    );
  }
}

async function main(): Promise<void> {
  assertLocalDevelopment();
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  try {
    const db = app.get<Database>(DATABASE);
    const ids = app.get<IdGenerator>(ID_GENERATOR);
    const pipeline = app.get(CommandPipelineService);

    const existing = await db
      .selectFrom('identity_users')
      .select('id')
      .where('phone', '=', DEMO_PHONE)
      .executeTakeFirst();
    const password = await resolvePassword(existing !== undefined);
    const actor = await ensureDemoAccount(db, ids, password);
    await ensureGlobalRoles(db, ids, actor.userId);
    invalidateUser(actor.userId);

    await createDemoData({ db, ids, pipeline, actor });
    await activatePendingDevices(db, actor.userId);

    console.log('\nCompte de démonstration prêt.');
    console.log(`Identifiant (téléphone) : ${DEMO_PHONE}`);
    console.log(
      password === null
        ? 'Mot de passe : inchangé.'
        : 'Mot de passe : celui que vous venez de choisir.',
    );
  } finally {
    await app.close();
  }
}

// --- Mot de passe ---------------------------------------------------------------------------------------

/**
 * Mot de passe à poser sur le compte, jamais écrit dans le code ni affiché :
 * - `DEMO_PASSWORD` de l'environnement s'il est défini ;
 * - sinon, dans un terminal interactif, saisie masquée et confirmée ; pour un compte existant, Entrée
 *   conserve le mot de passe actuel ;
 * - sinon `null` : un compte existant garde son mot de passe, un compte à créer est refusé.
 */
async function resolvePassword(accountExists: boolean): Promise<string | null> {
  const fromEnv = process.env.DEMO_PASSWORD;
  if (fromEnv !== undefined && fromEnv !== '') {
    if (fromEnv.length < PASSWORD_MIN_LENGTH) {
      throw new Error(`DEMO_PASSWORD : ${PASSWORD_MIN_LENGTH} caractères minimum.`);
    }
    return fromEnv;
  }
  if (!process.stdin.isTTY) {
    if (accountExists) return null;
    throw new Error(
      'Compte à créer : lancez `pnpm run demo:data` dans un terminal pour choisir le mot de passe ' +
        '(ou définissez DEMO_PASSWORD dans un fichier local non suivi, par exemple apps/server/.env).',
    );
  }
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const first = await readHidden(
      accountExists
        ? `Nouveau mot de passe du compte ${DEMO_PHONE} (Entrée : conserver l'actuel) : `
        : `Mot de passe du compte ${DEMO_PHONE} (${PASSWORD_MIN_LENGTH} caractères minimum) : `,
    );
    if (first === '' && accountExists) return null;
    if (first.length < PASSWORD_MIN_LENGTH) {
      console.log(`  ${PASSWORD_MIN_LENGTH} caractères minimum, recommencez.`);
      continue;
    }
    const again = await readHidden('Confirmez le mot de passe : ');
    if (again === first) return first;
    console.log('  Les deux saisies diffèrent, recommencez.');
  }
  throw new Error('Mot de passe non défini (trois essais).');
}

/** Lecture masquée d'une ligne dans le terminal (rien ne s'affiche à la frappe). */
function readHidden(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    process.stdout.write(prompt);
    stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    stdin.resume();
    let value = '';
    const finish = (): void => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write('\n');
    };
    const onData = (chunk: string): void => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          finish();
          resolve(value);
          return;
        }
        if (ch === '\u0003') {
          finish();
          reject(new Error('Saisie interrompue.'));
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

// --- Compte, appareil, rôles ----------------------------------------------------------------------------

async function ensureDemoAccount(
  db: Database,
  ids: IdGenerator,
  password: string | null,
): Promise<Actor> {
  const existing = await db
    .selectFrom('identity_users')
    .select('id')
    .where('phone', '=', DEMO_PHONE)
    .executeTakeFirst();
  let userId: string;
  if (existing) {
    userId = fromBin(existing.id);
    await db
      .updateTable('identity_users')
      .set({
        status: 'ACTIVE',
        must_change_password: 0,
        ...(password === null ? {} : { password_hash: await hashPassword(password) }),
      })
      .where('id', '=', existing.id)
      .execute();
    if (password !== null) console.log('  ~ compte de démonstration : mot de passe changé');
  } else {
    if (password === null) throw new Error('Mot de passe requis pour créer le compte.');
    const passwordHash = await hashPassword(password);
    userId = ids.newId();
    await db
      .insertInto('identity_users')
      .values({
        id: toBin(userId),
        full_name: DEMO_NAME,
        phone: DEMO_PHONE,
        password_hash: passwordHash,
        status: 'ACTIVE',
        must_change_password: 0,
        locale: 'fr-CM',
        created_by: toBin(userId),
      })
      .execute();
    console.log('  + compte de démonstration créé');
  }
  // Appareil du script : les commandes de démonstration exigent un appareil actif (pipeline, étape 1).
  const device = await db
    .selectFrom('identity_devices')
    .select('id')
    .where('enrolled_by_user_id', '=', toBin(userId))
    .where('label', '=', 'Script de démonstration')
    .executeTakeFirst();
  let deviceId: string;
  if (device) {
    deviceId = fromBin(device.id);
  } else {
    deviceId = ids.newId();
    await db
      .insertInto('identity_devices')
      .values({
        id: toBin(deviceId),
        short_code: await freeShortCode(db),
        label: 'Script de démonstration',
        enrolled_by_user_id: toBin(userId),
        status: 'ACTIVE',
        status_changed_at: new Date(),
        approved_by: toBin(userId),
        created_by: toBin(userId),
      })
      .execute();
  }
  return { userId, deviceId };
}

/** Code court d'appareil libre (4 caractères, unique). */
async function freeShortCode(db: Database): Promise<string> {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (;;) {
    let code = '';
    for (let i = 0; i < 4; i++) code += alphabet[Math.floor(Math.random() * alphabet.length)];
    const taken = await db
      .selectFrom('identity_devices')
      .select('id')
      .where('short_code', '=', code)
      .executeTakeFirst();
    if (!taken) return code;
  }
}

/** Rôles de portée globale (les rôles de site et de zone suivent la création de la structure). */
const GLOBAL_ROLES = [
  'DIRECTION',
  'ADMIN',
  'COMMERCIAL_SEDENTAIRE',
  'RESP_PRODUCTION',
  'RESP_ACHATS',
  'FINANCE',
] as const;

async function ensureGlobalRoles(db: Database, ids: IdGenerator, userId: string): Promise<void> {
  for (const code of GLOBAL_ROLES) {
    await assignRole(db, ids, userId, code, { scopeType: 'GLOBAL' });
  }
}

async function assignRole(
  db: Database,
  ids: IdGenerator,
  userId: string,
  roleCode: string,
  scope:
    | { readonly scopeType: 'GLOBAL' }
    | { readonly scopeType: 'SITE'; readonly siteId: string }
    | { readonly scopeType: 'ZONE'; readonly zoneId: string },
): Promise<void> {
  const role = await db
    .selectFrom('identity_roles')
    .select('id')
    .where('code', '=', roleCode)
    .executeTakeFirstOrThrow();
  let existing = db
    .selectFrom('identity_user_role_assignments')
    .select('id')
    .where('user_id', '=', toBin(userId))
    .where('role_id', '=', role.id)
    .where('scope_type', '=', scope.scopeType)
    .where('revoked_at', 'is', null);
  if (scope.scopeType === 'SITE')
    existing = existing.where('scope_site_id', '=', toBin(scope.siteId));
  if (scope.scopeType === 'ZONE')
    existing = existing.where('scope_zone_id', '=', toBin(scope.zoneId));
  if (await existing.executeTakeFirst()) return;
  await db
    .insertInto('identity_user_role_assignments')
    .values({
      id: toBin(ids.newId()),
      user_id: toBin(userId),
      role_id: role.id,
      scope_type: scope.scopeType,
      scope_site_id: scope.scopeType === 'SITE' ? toBin(scope.siteId) : null,
      scope_zone_id: scope.scopeType === 'ZONE' ? toBin(scope.zoneId) : null,
      valid_from: new Date('2020-01-01T00:00:00.000Z'),
      created_by: toBin(userId),
    })
    .execute();
  console.log(`  + rôle ${roleCode} (${scope.scopeType})`);
}

/** Développement local : les appareils du compte de démonstration encore en attente sont approuvés. */
async function activatePendingDevices(db: Database, userId: string): Promise<void> {
  const result = await db
    .updateTable('identity_devices')
    .set({
      status: 'ACTIVE',
      status_changed_at: sql<Date>`CURRENT_TIMESTAMP(6)`,
      approved_by: toBin(userId),
    })
    .where('enrolled_by_user_id', '=', toBin(userId))
    .where('status', '=', 'PENDING')
    .executeTakeFirst();
  const count = Number(result.numUpdatedRows);
  if (count > 0) console.log(`  ~ ${count} appareil(s) du compte approuvé(s)`);
}

// --- Commandes ------------------------------------------------------------------------------------------

interface Context {
  readonly db: Database;
  readonly ids: IdGenerator;
  readonly pipeline: CommandPipelineService;
  readonly actor: Actor;
}

let deviceSeq = Date.now() % 1_000_000_000;

async function run(
  ctx: Context,
  command: {
    readonly type: string;
    readonly aggregateType: string;
    readonly aggregateId?: string;
    readonly payload: unknown;
  },
): Promise<{ readonly id: string; readonly result: CommandResult }> {
  const id = command.aggregateId ?? ctx.ids.newId();
  const now = new Date().toISOString();
  deviceSeq += 1;
  const result = await ctx.pipeline.handle(
    {
      command_id: ctx.ids.newId(),
      device_seq: deviceSeq,
      command_version: 1,
      command_type: command.type,
      aggregate_type: command.aggregateType,
      aggregate_id: id,
      author_user_id: ctx.actor.userId,
      base_version: null,
      depends_on: [],
      occurred_at: now,
      client_created_at: now,
      captured_offline: false,
      backdated_reason: null,
      attachment_ids: [],
      payload: command.payload,
    },
    {
      authenticatedUserId: ctx.actor.userId,
      authenticatedDeviceId: ctx.actor.deviceId,
      transport: 'ONLINE_API',
    },
  );
  if (!result.status.startsWith('APPLIED')) {
    throw new Error(`${command.type} : ${JSON.stringify(result)}`);
  }
  return { id, result };
}

// --- Données ----------------------------------------------------------------------------------------------

/** Identifiant d'une ligne retrouvée par une colonne (code, libellé), ou `undefined`. */
async function idWhere(
  ctx: Context,
  table:
    | 'organization_zones'
    | 'organization_sites'
    | 'catalog_product_categories'
    | 'catalog_products'
    | 'pricing_price_rules'
    | 'finance_cash_accounts'
    | 'procurement_suppliers',
  code: string,
): Promise<string | undefined> {
  const row = await ctx.db
    .selectFrom(table)
    .select('id')
    .where('code', '=', code)
    .executeTakeFirst();
  return row ? fromBin(row.id) : undefined;
}

async function ensure(
  ctx: Context,
  found: string | undefined,
  label: string,
  command: { readonly type: string; readonly aggregateType: string; readonly payload: unknown },
): Promise<string> {
  if (found !== undefined) return found;
  const { id } = await run(ctx, command);
  console.log(`  + ${label}`);
  return id;
}

async function ensureLocation(
  ctx: Context,
  siteId: string,
  code: string,
  payload: Record<string, unknown>,
): Promise<string> {
  const row = await ctx.db
    .selectFrom('organization_locations')
    .select('id')
    .where('site_id', '=', toBin(siteId))
    .where('code', '=', code)
    .executeTakeFirst();
  return ensure(ctx, row ? fromBin(row.id) : undefined, `emplacement ${code}`, {
    type: 'organization.location.create',
    aggregateType: 'LOCATION',
    payload: { siteId, code, ...payload },
  });
}

async function ensureUnit(
  ctx: Context,
  code: string,
  name: string,
  isCount: boolean,
): Promise<void> {
  const row = await ctx.db
    .selectFrom('catalog_units')
    .select('code')
    .where('code', '=', code)
    .executeTakeFirst();
  if (row) return;
  await run(ctx, {
    type: 'catalog.unit.create',
    aggregateType: 'UNIT',
    payload: { code, name, isCount },
  });
  console.log(`  + unité ${code}`);
}

async function ensureChannel(ctx: Context, code: string, name: string): Promise<void> {
  const row = await ctx.db
    .selectFrom('catalog_sales_channels')
    .select('code')
    .where('code', '=', code)
    .executeTakeFirst();
  if (row) return;
  await run(ctx, {
    type: 'catalog.sales_channel.create',
    aggregateType: 'SALES_CHANNEL',
    payload: { code, name },
  });
  console.log(`  + canal ${code}`);
}

async function ensureProduct(
  ctx: Context,
  code: string,
  payload: Record<string, unknown>,
): Promise<string> {
  return ensure(ctx, await idWhere(ctx, 'catalog_products', code), `produit ${code}`, {
    type: 'catalog.product.create',
    aggregateType: 'PRODUCT',
    payload: { code, ...payload },
  });
}

/** Règle de prix globale, préparée puis activée (Direction) ; son prix est rendu pour les lignes de vente. */
async function ensurePrice(
  ctx: Context,
  code: string,
  productId: string,
  unitPriceXaf: number,
  pricingUnitCode: string,
): Promise<void> {
  if (await idWhere(ctx, 'pricing_price_rules', code)) return;
  const { id } = await run(ctx, {
    type: 'pricing.rule.draft',
    aggregateType: 'PRICE_RULE',
    payload: {
      code,
      productId,
      unitPriceXaf,
      pricingUnitCode,
      validFrom: new Date(Date.now() - 60_000).toISOString(),
    },
  });
  await run(ctx, {
    type: 'pricing.rule.activate',
    aggregateType: 'PRICE_RULE',
    aggregateId: id,
    payload: {},
  });
  console.log(`  + prix ${code} : ${unitPriceXaf} XAF / ${pricingUnitCode}`);
}

async function ensureCustomer(
  ctx: Context,
  displayName: string,
  payload: Record<string, unknown>,
): Promise<string> {
  const row = await ctx.db
    .selectFrom('crm_customers')
    .select('id')
    .where('display_name', '=', displayName)
    .executeTakeFirst();
  return ensure(ctx, row ? fromBin(row.id) : undefined, `client ${displayName}`, {
    type: 'crm.customer.create',
    aggregateType: 'CUSTOMER',
    payload: { displayName, ...payload },
  });
}

/** Numéro mobile camerounais libre (6 + 8 chiffres), jamais déjà porté par un client. */
async function freePhone(ctx: Context): Promise<string> {
  for (;;) {
    const phone = `+2376${String(Math.floor(Math.random() * 100_000_000)).padStart(8, '0')}`;
    const taken = await ctx.db
      .selectFrom('crm_customers')
      .select('id')
      .where((eb) => eb.or([eb('phone_primary', '=', phone), eb('phone_secondary', '=', phone)]))
      .executeTakeFirst();
    if (!taken && phone !== DEMO_PHONE) return phone;
  }
}

const PRICE_POULET = 3500;
const PRICE_OEUFS = 2500;
const PRICE_VIF = 3000;

async function createDemoData(ctx: Context): Promise<void> {
  console.log('Structure');
  const region = await ensure(
    ctx,
    await idWhere(ctx, 'organization_zones', 'DEMO-LITTORAL'),
    'zone Littoral',
    {
      type: 'organization.zone.create',
      aggregateType: 'ZONE',
      payload: { code: 'DEMO-LITTORAL', name: 'Littoral', level: 'REGION' },
    },
  );
  const douala = await ensure(
    ctx,
    await idWhere(ctx, 'organization_zones', 'DEMO-DOUALA'),
    'zone Douala',
    {
      type: 'organization.zone.create',
      aggregateType: 'ZONE',
      payload: {
        code: 'DEMO-DOUALA',
        name: 'Douala',
        level: 'VILLE',
        parentId: region,
        lat: 4.0511,
        lng: 9.7679,
      },
    },
  );
  const site = async (code: string, name: string, siteType: string, address: string) =>
    ensure(ctx, await idWhere(ctx, 'organization_sites', code), `site ${name}`, {
      type: 'organization.site.create',
      aggregateType: 'SITE',
      payload: { code, name, siteType, zoneId: douala, address },
    });
  const farm = await site('DEMO-FERME', 'Ferme de Bonabéri', 'FERME', 'Bonabéri, Douala');
  const warehouse = await site(
    'DEMO-MAG',
    'Magasin central de Bassa',
    'MAGASIN',
    'Zone industrielle de Bassa',
  );
  const pdv = await site(
    'DEMO-PDV',
    'PDV Marché central',
    'POINT_DE_VENTE',
    'Marché central, Douala',
  );

  const building = await ensureLocation(ctx, farm, 'BAT-1', {
    name: 'Bâtiment 1',
    locationType: 'BUILDING',
  });
  await ensureLocation(ctx, farm, 'CASE-1', {
    name: 'Case 1',
    locationType: 'PEN',
    parentLocationId: building,
  });
  await ensureLocation(ctx, farm, 'MAG-FERME', {
    name: 'Magasin de la ferme',
    locationType: 'STORE',
  });
  const store = await ensureLocation(ctx, warehouse, 'MAG-1', {
    name: 'Magasin',
    locationType: 'STORE',
  });
  const counter = await ensureLocation(ctx, pdv, 'COMPTOIR', {
    name: 'Comptoir',
    locationType: 'POS',
  });
  await run(ctx, {
    type: 'organization.pos.configure',
    aggregateType: 'SITE',
    aggregateId: pdv,
    payload: {
      salesLocationId: counter,
      replenishmentSourceLocationId: store,
      custodyMode: 'SHARED',
      openingHours: 'Lundi à samedi, 7 h – 19 h',
    },
  });

  // Rôles de site et de zone, maintenant que la structure existe (portées admises par rôle, rbac-data.ts).
  console.log('Rôles de site et de zone');
  await assignRole(ctx.db, ctx.ids, ctx.actor.userId, 'VENDEUR_PDV', {
    scopeType: 'SITE',
    siteId: pdv,
  });
  await assignRole(ctx.db, ctx.ids, ctx.actor.userId, 'MAGASINIER', {
    scopeType: 'SITE',
    siteId: warehouse,
  });
  await assignRole(ctx.db, ctx.ids, ctx.actor.userId, 'MAGASINIER', {
    scopeType: 'SITE',
    siteId: pdv,
  });
  await assignRole(ctx.db, ctx.ids, ctx.actor.userId, 'RESP_FERME', {
    scopeType: 'SITE',
    siteId: farm,
  });
  await assignRole(ctx.db, ctx.ids, ctx.actor.userId, 'RESP_COMMERCIAL', {
    scopeType: 'ZONE',
    zoneId: region,
  });
  await assignRole(ctx.db, ctx.ids, ctx.actor.userId, 'COMMERCIAL_TERRAIN', {
    scopeType: 'ZONE',
    zoneId: douala,
  });
  invalidateUser(ctx.actor.userId);

  console.log('Catalogue');
  await ensureUnit(ctx, 'TETE', 'Tête', true);
  await ensureUnit(ctx, 'PIECE', 'Pièce', true);
  await ensureUnit(ctx, 'KG', 'Kilogramme', false);
  await ensureUnit(ctx, 'PLATEAU', 'Plateau de 30 œufs', true);
  await ensureUnit(ctx, 'SAC', 'Sac', true);
  await ensureChannel(ctx, 'POINT_DE_VENTE', 'Point de vente');
  await ensureChannel(ctx, 'DIRECT', 'Vente directe');
  await ensureChannel(ctx, 'SEDENTAIRE', 'Commercial sédentaire');
  await ensureChannel(ctx, 'TERRAIN', 'Commercial terrain');
  const category = async (code: string, name: string) =>
    ensure(ctx, await idWhere(ctx, 'catalog_product_categories', code), `catégorie ${name}`, {
      type: 'catalog.product_category.create',
      aggregateType: 'PRODUCT_CATEGORY',
      payload: { code, name },
    });
  const poultry = await category('VOLAILLE', 'Volaille');
  const eggs = await category('OEUFS', 'Œufs');
  const feed = await category('ALIMENTS', 'Aliments et intrants');
  const chicken = await ensureProduct(ctx, 'POULET-PAC', {
    name: 'Poulet prêt à cuire',
    categoryId: poultry,
    stockFamily: 'PRODUCTION_COMMERCIALISABLE',
    baseUnitCode: 'PIECE',
    isSellable: true,
    isProducible: true,
  });
  const trays = await ensureProduct(ctx, 'OEUF-PLT', {
    name: 'Œufs de table (plateau de 30)',
    categoryId: eggs,
    stockFamily: 'PRODUCTION_COMMERCIALISABLE',
    baseUnitCode: 'PLATEAU',
    isSellable: true,
    isProducible: true,
  });
  const live = await ensureProduct(ctx, 'POULET-VIF', {
    name: 'Poulet de chair vif',
    categoryId: poultry,
    stockFamily: 'BIOLOGIQUE',
    baseUnitCode: 'TETE',
    species: 'POULET_CHAIR',
    isSellable: true,
  });
  await ensureProduct(ctx, 'POUSSIN-J1', {
    name: 'Poussin d’un jour',
    categoryId: poultry,
    stockFamily: 'BIOLOGIQUE',
    baseUnitCode: 'TETE',
    species: 'POULET_CHAIR',
    isPurchasable: true,
  });
  const starter = await ensureProduct(ctx, 'ALIM-DEMARRAGE', {
    name: 'Aliment démarrage poulet',
    categoryId: feed,
    stockFamily: 'INTRANT',
    baseUnitCode: 'KG',
    isPurchasable: true,
    isConsumable: true,
  });
  const bagUnit = await ctx.db
    .selectFrom('catalog_product_units')
    .select('id')
    .where('product_id', '=', toBin(starter))
    .where('unit_code', '=', 'SAC')
    .executeTakeFirst();
  if (!bagUnit) {
    await run(ctx, {
      type: 'catalog.product_unit.set',
      aggregateType: 'PRODUCT_UNIT',
      payload: { productId: starter, unitCode: 'SAC', factorToBase: 50, isPurchaseUnit: true },
    });
  }
  await ensurePrice(ctx, 'PRIX-POULET-PAC', chicken, PRICE_POULET, 'PIECE');
  await ensurePrice(ctx, 'PRIX-OEUF-PLT', trays, PRICE_OEUFS, 'PLATEAU');
  await ensurePrice(ctx, 'PRIX-POULET-VIF', live, PRICE_VIF, 'TETE');

  console.log('Trésorerie');
  const account = async (code: string, payload: Record<string, unknown>) =>
    ensure(ctx, await idWhere(ctx, 'finance_cash_accounts', code), `compte ${code}`, {
      type: 'finance.cash_account.create',
      aggregateType: 'CASH_ACCOUNT',
      payload: { code, responsibleUserId: ctx.actor.userId, ...payload },
    });
  const posCash = await account('DEMO-CAISSE-PDV', {
    name: 'Caisse du PDV Marché central',
    accountType: 'CAISSE_PDV',
    siteId: pdv,
  });
  await account('DEMO-CAISSE-CENTRALE', {
    name: 'Caisse centrale',
    accountType: 'CAISSE_CENTRALE',
  });
  const momo = await account('DEMO-OM', { name: 'Orange Money GIC', accountType: 'MOBILE_MONEY' });

  console.log('Clients et fournisseur');
  const restaurant = await ensureCustomer(ctx, 'Restaurant Le Wouri', {
    customerType: 'ENTREPRISE',
    contactName: 'M. Ekwalla',
    businessActivity: 'Restauration',
    phonePrimary: await freePhone(ctx),
    addressText: 'Bonanjo, Douala',
    zoneId: douala,
    sourceCode: 'PROSPECTION_TERRAIN',
  });
  await ensureCustomer(ctx, 'Mama Ngono (revendeuse)', {
    customerType: 'PARTICULIER',
    phonePrimary: await freePhone(ctx),
    addressText: 'Marché central, Douala',
    zoneId: douala,
    sourceCode: 'VISITE_SPONTANEE',
  });
  await ensureCustomer(ctx, 'Hôtel de la Plage', {
    customerType: 'ENTREPRISE',
    contactName: 'Mme Tchoua',
    businessActivity: 'Hôtellerie',
    phonePrimary: await freePhone(ctx),
    addressText: 'Akwa, Douala',
    zoneId: douala,
    sourceCode: 'RECOMMANDATION',
  });
  const supplier = await ensure(
    ctx,
    await idWhere(ctx, 'procurement_suppliers', 'FRN-PROVENDE'),
    'fournisseur',
    {
      type: 'procurement.supplier.create',
      aggregateType: 'SUPPLIER',
      payload: {
        code: 'FRN-PROVENDE',
        name: 'Provenderie du Littoral',
        suppliedCategories: ['ALIMENTS'],
        contactName: 'M. Mbappe',
        phone: '+237233000000',
        paymentTermsDays: 30,
      },
    },
  );

  // --- Activité : chaque étape n'est jouée que si sa trace n'existe pas encore ------------------------------
  console.log('Stock');
  const received = await ctx.db
    .selectFrom('inventory_stock_moves')
    .select('id')
    .where('to_location_id', '=', toBin(store))
    .where('move_type', '=', 'PURCHASE_RECEIPT')
    .executeTakeFirst();
  const receive = async (
    productId: string,
    locationId: string,
    quantity: number,
    unitCost: number,
  ) =>
    ctx.db.transaction().execute(async (trx) =>
      recordStockMove(
        trx,
        { idGenerator: ctx.ids },
        {
          productId,
          quantityBase: quantity,
          fromLocationId: await virtualLocationId(trx, 'V_SUPPLIER'),
          toLocationId: locationId,
          moveType: 'PURCHASE_RECEIPT',
          declaredUnitCostXaf: unitCost,
          occurredAt: new Date(Date.now() - 30 * 60_000),
          sourceDocType: 'GOODS_RECEIPT',
          sourceDocId: ctx.ids.newId(),
          createdBy: ctx.actor.userId,
          allowNegative: false,
        },
      ),
    );
  if (!received) {
    await receive(chicken, store, 120, 2200);
    await receive(trays, store, 80, 1600);
    await receive(starter, store, 1000, 350);
    await receive(chicken, counter, 40, 2200);
    await receive(trays, counter, 30, 1600);
    console.log('  + stock initial du magasin central et du comptoir');
  }

  // Transfert du magasin vers le PDV, expédié : il attend sa réception à l'écran.
  const transferred = await ctx.db
    .selectFrom('inventory_stock_transfers')
    .select('id')
    .where('from_location_id', '=', toBin(store))
    .where('to_location_id', '=', toBin(counter))
    .executeTakeFirst();
  if (!transferred)
    await run(ctx, {
      type: 'inventory.transfer.dispatch',
      aggregateType: 'STOCK_TRANSFER',
      payload: {
        fromLocationId: store,
        toLocationId: counter,
        lines: [
          { productId: chicken, unitCode: 'PIECE', quantityBase: 30 },
          { productId: trays, unitCode: 'PLATEAU', quantityBase: 20 },
        ],
      },
    });
  if (!transferred) console.log('  + transfert magasin → PDV expédié (à réceptionner)');

  // Bon de commande d'aliment, envoyé au fournisseur : il attend sa réception à l'écran.
  const ordered = await ctx.db
    .selectFrom('procurement_purchase_orders')
    .select('id')
    .where('supplier_id', '=', toBin(supplier))
    .executeTakeFirst();
  if (!ordered) await purchaseOrder(ctx, supplier, store, starter);

  console.log('Caisse et ventes');
  const session = await ctx.db
    .selectFrom('finance_cash_sessions')
    .select('id')
    .where('cash_account_id', '=', toBin(posCash))
    .where('status', '=', 'OPEN')
    .executeTakeFirst();
  if (!session) {
    await run(ctx, {
      type: 'finance.cash_session.open',
      aggregateType: 'CASH_SESSION',
      payload: { cashAccountId: posCash, countedXaf: 0, comment: 'Ouverture de démonstration' },
    });
    console.log('  + session de caisse du PDV ouverte');
  }
  const sold = await ctx.db
    .selectFrom('sales_sales')
    .select('id')
    .where('from_location_id', '=', toBin(counter))
    .executeTakeFirst();
  if (sold) {
    console.log('  ventes de démonstration déjà enregistrées');
    return;
  }
  await recordSales(ctx, { counter, store, posCash, momo, restaurant, chicken, trays });
}

async function purchaseOrder(
  ctx: Context,
  supplier: string,
  store: string,
  starter: string,
): Promise<void> {
  const { id: orderId } = await run(ctx, {
    type: 'procurement.order.create',
    aggregateType: 'PURCHASE_ORDER',
    payload: {
      supplierId: supplier,
      deliveryLocationId: store,
      lines: [{ productId: starter, unitCode: 'KG', orderedQtyBase: 500, unitPriceXaf: 350 }],
    },
  });
  await run(ctx, {
    type: 'procurement.order.submit',
    aggregateType: 'PURCHASE_ORDER',
    aggregateId: orderId,
    payload: {},
  });
  await run(ctx, {
    type: 'procurement.order.mark_sent',
    aggregateType: 'PURCHASE_ORDER',
    aggregateId: orderId,
    payload: {},
  });
  console.log('  + bon de commande d’aliment envoyé (à réceptionner)');
}

async function recordSales(
  ctx: Context,
  refs: {
    readonly counter: string;
    readonly store: string;
    readonly posCash: string;
    readonly momo: string;
    readonly restaurant: string;
    readonly chicken: string;
    readonly trays: string;
  },
): Promise<void> {
  const { counter, store, posCash, momo, restaurant, chicken, trays } = refs;
  const line = (productId: string, unitCode: string, quantity: number, price: number) => ({
    productId,
    quantity,
    unitCode,
    quantityBase: quantity,
    listUnitPriceXaf: price,
    unitPriceXaf: price,
  });
  await run(ctx, {
    type: 'sales.sale.record',
    aggregateType: 'SALE',
    payload: {
      fromLocationId: counter,
      lines: [line(chicken, 'PIECE', 2, PRICE_POULET)],
      payments: [{ methodCode: 'ESPECES', amountXaf: 2 * PRICE_POULET, cashAccountId: posCash }],
    },
  });
  await run(ctx, {
    type: 'sales.sale.record',
    aggregateType: 'SALE',
    payload: {
      fromLocationId: counter,
      lines: [line(trays, 'PLATEAU', 3, PRICE_OEUFS)],
      payments: [
        {
          methodCode: 'MOBILE_MONEY_ORANGE',
          amountXaf: 3 * PRICE_OEUFS,
          reference: `OM-DEMO-${ctx.ids.newId().slice(-12)}`,
          cashAccountId: momo,
        },
      ],
    },
  });
  // Crédit du restaurant (Finance), puis vente à crédit avec acompte en espèces et commande à livrer.
  await run(ctx, {
    type: 'crm.customer.set_credit_terms',
    aggregateType: 'CUSTOMER',
    aggregateId: restaurant,
    payload: { creditAllowed: true, creditLimitXaf: 300_000, paymentTermsDays: 30 },
  });
  await run(ctx, {
    type: 'sales.sale.record',
    aggregateType: 'SALE',
    payload: {
      fromLocationId: counter,
      customerId: restaurant,
      lines: [line(chicken, 'PIECE', 5, PRICE_POULET)],
      payments: [{ methodCode: 'ESPECES', amountXaf: 10_000, cashAccountId: posCash }],
    },
  });
  const tomorrow = new Date(Date.now() + 24 * 3_600_000).toISOString().slice(0, 10);
  await run(ctx, {
    type: 'sales.order.place',
    aggregateType: 'SALES_ORDER',
    payload: {
      customerId: restaurant,
      fulfilmentLocationId: store,
      lines: [line(chicken, 'PIECE', 10, PRICE_POULET), line(trays, 'PLATEAU', 4, PRICE_OEUFS)],
      requestedDeliveryDate: tomorrow,
      deliveryAddress: 'Restaurant Le Wouri, Bonanjo',
    },
  });
  console.log(
    '  + trois ventes (espèces, Orange Money, crédit avec acompte) et une commande à livrer',
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
