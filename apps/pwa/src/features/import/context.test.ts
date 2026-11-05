/**
 * Référentiels du chargement par fichier (RP-2, PP-C ; AV-508) : lus dans la vraie base locale de l'appareil
 * (projections posées telles que le serveur les sert, commandes réellement mises en file), jamais dans des listes
 * fabriquées à la main.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDb, type OutboxCommand, type Projection } from '../../storage/db.js';
import { IDS, seedSalesFixtures } from '../sales/fixtures.js';
import { loadSalesReferences } from '../sales/references.js';
import { submitCommand } from '../sales/submit.js';
import { buildImportRefs } from './context.js';

vi.mock('../sync/sync-engine-instance.js', () => ({ getSyncEngine: () => undefined }));

const NOW = new Date('2026-11-04T10:00:00.000Z');

const projection = (
  dataset: string,
  entityType: string,
  id: string,
  data: Record<string, unknown>,
): Projection => ({
  key: `${dataset}:${entityType}:${id}`,
  dataset,
  entity_type: entityType,
  entity_id: id,
  scope_type: 'GLOBAL',
  scope_id: null,
  data: { id, ...data },
  seq: 1,
  row_version: 1,
});

async function build(roles: readonly string[]) {
  const references = await loadSalesReferences(getDb());
  return buildImportRefs({ references, userId: IDS.user, roles, now: NOW });
}

const enqueue = (commandType: string, aggregateType: string, payload: unknown) =>
  submitCommand({ authorUserId: IDS.user, commandType, aggregateType, payload });

describe('référentiels du chargement par fichier', () => {
  beforeEach(async () => {
    const db = getDb();
    await db.projections.clear();
    await db.outbox.clear();
    await seedSalesFixtures(db);
    await db.projections.bulkPut([
      projection('catalog', 'UNIT', 'u1', {
        code: 'KG',
        name: 'Kilogramme',
        is_count: false,
        is_active: true,
      }),
      projection('catalog', 'UNIT', 'u2', {
        code: 'ANCIEN',
        name: 'Ancienne',
        is_count: false,
        is_active: false,
      }),
      projection('product_category', 'PRODUCT_CATEGORY', 'c1', {
        code: 'VOLAILLE',
        name: 'Volaille',
        parent_id: null,
        is_active: true,
      }),
      projection('product_category', 'PRODUCT_CATEGORY', 'c2', {
        code: 'RETIREE',
        name: 'Retirée',
        parent_id: null,
        is_active: false,
      }),
      projection('customer_category', 'CUSTOMER_CATEGORY', 'k1', {
        code: 'RESTAURATION',
        name: 'Restauration',
        is_active: true,
      }),
      projection('procurement', 'SUPPLIER', 's1', { code: 'F-PROVENDE', name: 'Provenderie' }),
    ]);
  });

  afterEach(async () => {
    const db = getDb();
    await db.projections.clear();
    await db.outbox.clear();
  });

  it('lit ce que l’appareil connaît : unités actives, catégories actives, produits, fournisseurs, zones, sites', async () => {
    const refs = await build(['ADMIN']);
    expect([...refs.unitCodes]).toEqual(['KG']);
    expect(refs.categories).toEqual([{ id: 'c1', code: 'VOLAILLE', name: 'Volaille' }]);
    expect(refs.productCodes.has('OEUF')).toBe(true);
    expect(refs.productCodes.has('POULET')).toBe(true);
    expect(refs.supplierCodes.has('F-PROVENDE')).toBe(true);
    expect(refs.zones).toEqual([{ id: IDS.zone, label: 'Centre' }]);
    expect(refs.sites).toEqual([{ id: IDS.site, code: 'PDV-YDE', name: 'PDV Yaoundé' }]);
    expect(refs.customerCategories).toEqual([
      { id: 'k1', code: 'RESTAURATION', name: 'Restauration' },
    ]);
    expect(refs.phoneCountryCode).toBe('237');
  });

  it('une création en attente occupe déjà son code ; une création refusée ne l’occupe plus', async () => {
    const category = await enqueue('catalog.product_category.create', 'PRODUCT_CATEGORY', {
      code: 'oeufs',
      name: 'Œufs',
    });
    await enqueue('catalog.product.create', 'PRODUCT', { code: 'p-neuf', name: 'Produit neuf' });
    await enqueue('procurement.supplier.create', 'SUPPLIER', {
      code: 'F-NEUF',
      name: 'Fournisseur neuf',
    });
    const refused = await enqueue('catalog.product_category.create', 'PRODUCT_CATEGORY', {
      code: 'REFUSEE',
      name: 'Refusée',
    });
    const update: Partial<OutboxCommand> = {
      status: 'REJECTED',
      last_error: { code: 'CODE_EXISTS', message_fr: 'Code déjà pris.' },
    };
    await getDb().outbox.update(refused.command_id, update);

    const refs = await build(['ADMIN']);
    // Le code est normalisé comme à l'écran du catalogue, et l'identifiant est celui de CETTE commande.
    expect(refs.pendingCategoryIds.get('OEUFS')).toBe(category.aggregate_id);
    expect(refs.pendingCategoryIds.has('REFUSEE')).toBe(false);
    expect(refs.productCodes.has('P-NEUF')).toBe(true);
    expect(refs.supplierCodes.has('F-NEUF')).toBe(true);
  });

  it('une feuille de présence en attente occupe déjà son identifiant ; une feuille refusée ne l’occupe plus', async () => {
    const payload = (paperRef: string) => ({
      siteId: IDS.site,
      weekStart: '2026-11-02',
      paperRef,
      lines: [
        {
          personName: 'Paul',
          days: [{ date: '2026-11-02', arrival: '07:00', departure: '16:00', absenceCode: null }],
        },
      ],
    });
    const waiting = await enqueue('fieldwork.presence.record', 'PRESENCE_SHEET', payload('1'));
    const refused = await enqueue('fieldwork.presence.record', 'PRESENCE_SHEET', payload('2'));
    const update: Partial<OutboxCommand> = {
      status: 'REJECTED',
      last_error: { code: 'PRESENCE_WEEK_IN_FUTURE', message_fr: 'Semaine à venir.' },
    };
    await getDb().outbox.update(refused.command_id, update);
    const refs = await build(['ADMIN']);
    expect(refs.pendingPresenceSheets.has(waiting.aggregate_id)).toBe(true);
    expect(refs.pendingPresenceSheets.has(refused.aggregate_id)).toBe(false);
  });

  it('un client en attente occupe son téléphone, normalisé comme le serveur le fera', async () => {
    await enqueue('crm.customer.create', 'CUSTOMER', {
      displayName: 'Client en attente',
      customerType: 'ENTREPRISE',
      zoneId: IDS.zone,
      sourceCode: 'AUTRE',
      phonePrimary: '677 12 34 56',
    });
    const refs = await build(['ADMIN']);
    expect(refs.pendingCustomerPhones.has('+237677123456')).toBe(true);
  });

  it('sans rôle commercial, un compte se rattache à un site : celui du point de vente de l’utilisateur', async () => {
    const refs = await build(['ADMIN']);
    expect(refs.homeSiteRequired).toBe(true);
    expect(refs.defaultHomeSiteId).toBe(IDS.site);
  });

  it('un commercial est titulaire des comptes qu’il charge : aucun site à nommer', async () => {
    const refs = await build(['COMMERCIAL_TERRAIN']);
    expect(refs.homeSiteRequired).toBe(false);
    expect(refs.defaultHomeSiteId).toBeUndefined();
  });
});
