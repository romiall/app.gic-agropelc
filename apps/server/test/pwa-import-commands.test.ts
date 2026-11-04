/**
 * Chargement de données par fichier (RP-2 ; AV-072, AV-508) : les commandes que produit le contrôle d'un fichier
 * (`planImport`, logique de la PWA importée telle quelle) sont acceptées par le serveur, écrivent ce que le fichier
 * dit, et **les recharger ne crée rien de plus** : les identifiants sont stables, le serveur reconnaît la création
 * déjà faite. Le trajet est celui d'un appareil réel (file, `/sync/push`, vrais gestionnaires, base jetable).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FixedClock, Uuidv7Generator, type Clock } from '@gic/domain';
import { rawCommandEnvelopeSchema } from '@gic/contracts';
import { CommandPipelineService } from '../src/commands/command-pipeline.service.js';
import { CommandHandlerRegistry } from '../src/platform/sync/command-handler-registry.js';
import { SyncPushService } from '../src/sync/sync-push.service.js';
import { SyncPullService } from '../src/sync/sync-pull.service.js';
import { registerReferenceCommands } from '../src/modules/catalog/application/commands/reference-commands.js';
import { registerProductCommands } from '../src/modules/catalog/application/commands/product-commands.js';
import { registerSupplierCommands } from '../src/modules/procurement/application/commands/supplier-commands.js';
import { registerCustomerCommands } from '../src/modules/crm/application/commands/customer-commands.js';
import { toBin } from '../src/platform/kysely/uuid-columns.js';
import {
  CATEGORIES_ENTITY,
  CUSTOMERS_ENTITY,
  PRODUCTS_ENTITY,
  SUPPLIERS_ENTITY,
} from '../../pwa/src/features/import/entities.js';
import { parseCsv } from '../../pwa/src/features/import/csv.js';
import { planImport, type ImportEntity } from '../../pwa/src/features/import/model.js';
import { EMPTY_IMPORT_REFS, type ImportRefs } from '../../pwa/src/features/import/refs.js';
import { OfflineDevice } from './device-harness.js';
import {
  assignTestRole,
  closeTestDb,
  db,
  freshUuid,
  grantTestPermission,
  insertTestDevice,
  insertTestRole,
  insertTestSite,
  insertTestUser,
  insertTestZone,
  recentBusinessDay,
} from './helpers.js';

const DAY = recentBusinessDay(3);
const at = (hhmm: string) => `${DAY}T${hhmm}:00.000Z`;

const PERMISSIONS = [
  'catalog.reference.manage',
  'catalog.product.manage',
  'procurement.supplier.manage',
  'crm.customer.create',
];

describe('chargement par fichier : le serveur accepte les commandes, une seule fois même rechargées', () => {
  const suffix = freshUuid().slice(-8).toUpperCase();
  const clock: Clock = new FixedClock(new Date(at('13:00')));
  const idGenerator = new Uuidv7Generator(clock);
  let device: OfflineDevice;
  let author: string;
  let zoneId: string;
  let siteId: string;
  let minute = 0;
  /** Ce que le contrôle sait de l'application : les unités du catalogue, la zone et le site créés pour l'essai. */
  let refs: ImportRefs;

  beforeAll(async () => {
    const registry = new CommandHandlerRegistry();
    registerReferenceCommands(registry);
    registerProductCommands(registry, idGenerator);
    registerSupplierCommands(registry);
    registerCustomerCommands(registry, idGenerator);
    const services = {
      push: new SyncPushService(
        new CommandPipelineService(db, registry, clock, idGenerator),
        db,
        clock,
      ),
      pull: new SyncPullService(db),
    };
    let deviceId = '';
    await db.transaction().execute(async (trx) => {
      author = await insertTestUser(trx);
      deviceId = await insertTestDevice(trx, author, { status: 'ACTIVE' });
      const role = await insertTestRole(trx, author);
      for (const code of PERMISSIONS) await grantTestPermission(trx, role, code, author);
      await assignTestRole(trx, author, role, author);
      zoneId = await insertTestZone(trx, author);
      siteId = await insertTestSite(trx, author, zoneId);
    });
    device = new OfflineDevice(services, deviceId, clock);
    const unit = await db
      .selectFrom('catalog_units')
      .select('code')
      .where('is_active', '=', 1)
      .executeTakeFirstOrThrow();
    const site = await db
      .selectFrom('organization_sites')
      .select(['code', 'name'])
      .where('id', '=', toBin(siteId))
      .executeTakeFirstOrThrow();
    siteCode = site.code;
    refs = {
      ...EMPTY_IMPORT_REFS,
      authorUserId: author,
      unitCodes: new Set([unit.code]),
      zones: [{ id: zoneId, label: `Essai ${suffix}` }],
      sites: [{ id: siteId, code: site.code, name: site.name }],
      // L'auteur de l'essai n'est pas commercial : un compte sans titulaire doit nommer un site (BR-CRM-003).
      homeSiteRequired: true,
    };
    unitCode = unit.code;
  });

  afterAll(closeTestDb);

  let unitCode = '';
  let siteCode = '';

  /** Contrôle un fichier puis envoie ses commandes comme l'écran : une par une, par la file de l'appareil. */
  async function load(entity: ImportEntity, csv: string, context: ImportRefs = refs) {
    const plan = await planImport(entity, parseCsv(csv), context);
    expect(plan.missingColumns).toEqual([]);
    const errors = plan.rows.filter((row) => row.status === 'ERROR');
    expect(errors, JSON.stringify(errors)).toEqual([]);
    const results: string[] = [];
    for (const row of plan.rows) {
      for (const command of row.commands) {
        minute += 1;
        const envelope = device.enqueue(author, {
          type: command.commandType,
          aggregateType: command.aggregateType,
          aggregateId: command.aggregateId,
          occurredAt: at(`09:${String(minute % 60).padStart(2, '0')}`),
          payload: command.payload,
          capturedOffline: false,
        });
        expect(rawCommandEnvelopeSchema.safeParse(envelope).success).toBe(true);
        await device.syncUntilSettled(author);
        const result = device.resultOf(envelope.command_id);
        expect(result?.status, `${command.commandType} : ${JSON.stringify(result)}`).toMatch(
          /^APPLIED/,
        );
        results.push(command.aggregateId);
      }
    }
    return { plan, ids: results };
  }

  const countOf = async (
    table: 'catalog_product_categories' | 'catalog_products' | 'procurement_suppliers',
    code: string,
  ) => (await db.selectFrom(table).select('id').where('code', '=', code).execute()).length;

  it('catégories : chargées une fois, rechargées sans doublon, la fille sous sa mère', async () => {
    const csv = `Code;Nom;Catégorie parente\nIMP${suffix};Chargement ${suffix};\nIMP${suffix}-F;Fille ${suffix};IMP${suffix}\n`;
    const first = await load(CATEGORIES_ENTITY, csv);
    expect(first.ids).toHaveLength(2);
    const mother = await db
      .selectFrom('catalog_product_categories')
      .selectAll()
      .where('code', '=', `IMP${suffix}`)
      .executeTakeFirstOrThrow();
    const daughter = await db
      .selectFrom('catalog_product_categories')
      .selectAll()
      .where('code', '=', `IMP${suffix}-F`)
      .executeTakeFirstOrThrow();
    expect(mother).toMatchObject({ name: `Chargement ${suffix}`, parent_id: null });
    expect(daughter.parent_id).toEqual(mother.id);

    // Rechargé : mêmes identifiants, rien de plus.
    const second = await load(CATEGORIES_ENTITY, csv);
    expect(second.ids).toEqual(first.ids);
    expect(await countOf('catalog_product_categories', `IMP${suffix}`)).toBe(1);
    expect(await countOf('catalog_product_categories', `IMP${suffix}-F`)).toBe(1);
  });

  it('produits : écrits comme saisis, rechargés sans doublon', async () => {
    const category = await db
      .selectFrom('catalog_product_categories')
      .select(['id', 'code', 'name'])
      .where('code', '=', `IMP${suffix}`)
      .executeTakeFirstOrThrow();
    const { fromBin } = await import('../src/platform/kysely/uuid-columns.js');
    const context: ImportRefs = {
      ...refs,
      categories: [{ id: fromBin(category.id), code: category.code, name: category.name }],
    };
    const csv =
      'Code;Nom;Catégorie;Unité de base;Famille de stock;Vendable;Achetable;Mode de prix\n' +
      `PRD-${suffix};Produit chargé ${suffix};IMP${suffix};${unitCode};MARCHANDISE;oui;oui;à l’unité\n`;
    const first = await load(PRODUCTS_ENTITY, csv, context);
    const row = await db
      .selectFrom('catalog_products')
      .selectAll()
      .where('code', '=', `PRD-${suffix}`)
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({
      name: `Produit chargé ${suffix}`,
      base_unit_code: unitCode,
      stock_family: 'MARCHANDISE',
      is_sellable: 1,
      is_purchasable: 1,
      pricing_mode: 'PER_UNIT',
    });
    expect(row.category_id).toEqual(category.id);
    const second = await load(PRODUCTS_ENTITY, csv, context);
    expect(second.ids).toEqual(first.ids);
    expect(await countOf('catalog_products', `PRD-${suffix}`)).toBe(1);
  });

  it('fournisseurs : écrits comme saisis, rechargés sans doublon', async () => {
    const csv =
      'Code;Nom;Contact;Téléphone;E-mail;Délai de paiement (jours)\n' +
      `F-${suffix};Fournisseur ${suffix};M. Essai;+237 677 12 34 56;contact@essai.cm;45\n`;
    const first = await load(SUPPLIERS_ENTITY, csv);
    const row = await db
      .selectFrom('procurement_suppliers')
      .selectAll()
      .where('code', '=', `F-${suffix}`)
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({
      name: `Fournisseur ${suffix}`,
      contact_name: 'M. Essai',
      email: 'contact@essai.cm',
      payment_terms_days: 45,
    });
    const second = await load(SUPPLIERS_ENTITY, csv);
    expect(second.ids).toEqual(first.ids);
    expect(await countOf('procurement_suppliers', `F-${suffix}`)).toBe(1);
  });

  it('clients : écrits comme saisis (téléphone normalisé), rechargés sans doublon', async () => {
    const phone = `6${Math.floor(10_000_000 + Math.random() * 89_999_999)}`;
    const csv =
      'Nom;Téléphone;Zone;Site de rattachement;Source;Type de client;Adresse\n' +
      `Client chargé ${suffix};${phone};Essai ${suffix};${siteCode};recommandation;entreprise;Marché essai\n`;
    const first = await load(CUSTOMERS_ENTITY, csv);
    const rows = await db
      .selectFrom('crm_customers')
      .selectAll()
      .where('display_name', '=', `Client chargé ${suffix}`)
      .execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      phone_primary: `+237${phone}`,
      customer_type: 'ENTREPRISE',
      address_text: 'Marché essai',
    });
    expect(rows[0]!.zone_id).toEqual(toBin(zoneId));
    expect(rows[0]!.home_site_id).toEqual(toBin(siteId));

    const second = await load(CUSTOMERS_ENTITY, csv);
    expect(second.ids).toEqual(first.ids);
    expect(
      await db
        .selectFrom('crm_customers')
        .select('id')
        .where('display_name', '=', `Client chargé ${suffix}`)
        .execute(),
    ).toHaveLength(1);
  });
});
