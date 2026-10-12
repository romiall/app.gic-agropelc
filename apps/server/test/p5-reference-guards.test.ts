/**
 * P5-23 — gardes des référentiels (besoins serveur des écrans S-02, S-29, S-30, S-31, S-37). Avant ces
 * gardes, une violation de la base (code en double, borne d'une colonne, période) levait une exception :
 * la commande était rendue `RETRY_LATER` et renvoyée sans fin. Chaque cas est désormais refusé
 * proprement, d'un code stable et d'un message en français ; le coût standard n'est plus servi aux
 * appareils (RC-05).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FixedClock, Uuidv7Generator } from '@gic/domain';
import type { CommandResult } from '@gic/contracts';
import { CommandPipelineService } from '../src/commands/command-pipeline.service.js';
import { CommandHandlerRegistry } from '../src/platform/sync/command-handler-registry.js';
import { registerReferenceCommands } from '../src/modules/catalog/application/commands/reference-commands.js';
import { registerProductCommands } from '../src/modules/catalog/application/commands/product-commands.js';
import { registerPricingCommands } from '../src/modules/pricing/application/commands/pricing-commands.js';
import { registerSupplierCommands } from '../src/modules/procurement/application/commands/supplier-commands.js';
import { listPriceRules } from '../src/modules/pricing/application/public/index.js';
import { listSuppliers } from '../src/modules/procurement/application/public/index.js';
import { resolveEntityProjection } from '../src/sync/entity-projections.js';
import { toBin } from '../src/platform/kysely/uuid-columns.js';
import {
  assignTestRole,
  closeTestDb,
  db,
  freshUuid,
  grantTestPermission,
  insertTestDevice,
  insertTestProduct,
  insertTestRole,
  insertTestSite,
  insertTestUser,
  insertTestZone,
} from './helpers.js';

const NOW = '2026-10-12T10:00:00.000Z';
const LATER = '2026-10-12T12:00:00.000Z';
const TOMORROW = '2026-10-13T00:00:00.000Z';

describe('P5-23 — gardes des référentiels (S-02, S-29, S-30, S-31, S-37)', () => {
  let pipeline: CommandPipelineService;
  let admin: string;
  let adminDevice: string;
  let productId: string;
  let otherProductId: string;
  let zoneId: string;
  let siteInZone: string;
  let siteElsewhere: string;
  let seq = 0;

  beforeAll(async () => {
    const clock = new FixedClock(new Date(NOW));
    const registry = new CommandHandlerRegistry();
    registerReferenceCommands(registry);
    registerProductCommands(registry);
    registerPricingCommands(registry);
    registerSupplierCommands(registry);
    pipeline = new CommandPipelineService(db, registry, clock, new Uuidv7Generator(clock));

    admin = await db.transaction().execute((trx) => insertTestUser(trx));
    adminDevice = await db
      .transaction()
      .execute((trx) => insertTestDevice(trx, admin, { status: 'ACTIVE' }));
    await db.transaction().execute(async (trx) => {
      const role = await insertTestRole(trx, admin);
      for (const permission of [
        'catalog.reference.manage',
        'catalog.product.manage',
        'pricing.rule.draft',
        'pricing.rule.activate',
        'pricing.campaign.manage',
        'procurement.supplier.manage',
      ]) {
        await grantTestPermission(trx, role, permission, admin);
      }
      await assignTestRole(trx, admin, role, admin);
      productId = await insertTestProduct(trx, admin);
      otherProductId = await insertTestProduct(trx, admin);
      zoneId = await insertTestZone(trx, admin);
      const childZone = await insertTestZone(trx, admin, { parentId: zoneId });
      siteInZone = await insertTestSite(trx, admin, childZone);
      siteElsewhere = await insertTestSite(trx, admin, await insertTestZone(trx, admin));
    });
  });

  afterAll(async () => {
    await closeTestDb();
  });

  async function send(
    commandType: string,
    aggregateType: string,
    aggregateId: string,
    payload: unknown,
    occurredAt = NOW,
  ): Promise<CommandResult> {
    seq += 1;
    return pipeline.handle(
      {
        command_id: freshUuid(),
        device_seq: seq,
        command_version: 1,
        command_type: commandType,
        aggregate_type: aggregateType,
        aggregate_id: aggregateId,
        author_user_id: admin,
        base_version: null,
        depends_on: [],
        occurred_at: occurredAt,
        client_created_at: occurredAt,
        captured_offline: false,
        backdated_reason: null,
        attachment_ids: [],
        payload,
      },
      { authenticatedUserId: admin, authenticatedDeviceId: adminDevice, transport: 'ONLINE_API' },
    );
  }

  const codeOf = (result: CommandResult) =>
    result.status === 'REJECTED' ? result.error?.code : result.status;

  const rule = (overrides: Record<string, unknown> = {}) => ({
    productId,
    unitPriceXaf: 1500,
    pricingUnitCode: 'TETE',
    validFrom: LATER,
    ...overrides,
  });

  async function draft(code: string, overrides: Record<string, unknown> = {}): Promise<string> {
    const id = freshUuid();
    const result = await send('pricing.rule.draft', 'PRICE_RULE', id, { code, ...rule(overrides) });
    expect(result.status).toBe('APPLIED');
    return id;
  }

  const uniqueCode = (prefix: string) => `${prefix}-${freshUuid().slice(-10)}`;

  describe('règles tarifaires (S-29)', () => {
    it('code de lignée déjà pris : CODE_EXISTS, sans exception', async () => {
      const code = uniqueCode('RG');
      await draft(code);
      const again = await send('pricing.rule.draft', 'PRICE_RULE', freshUuid(), {
        code,
        ...rule(),
      });
      expect(codeOf(again)).toBe('CODE_EXISTS');
    });

    it('bornes des colonnes et période refusées proprement (VALIDATION_ERROR, PRICE_RULE_PERIOD_INVALID)', async () => {
      const tooHigh = await send('pricing.rule.draft', 'PRICE_RULE', freshUuid(), {
        code: uniqueCode('RG'),
        ...rule({ priority: 2_147_483_648 }),
      });
      expect(codeOf(tooHigh)).toMatch(/^VALIDATION_ERROR/);
      expect(tooHigh.error?.message_fr).toContain('« priority » : valeur trop grande');

      const hugeThreshold = await send('pricing.rule.draft', 'PRICE_RULE', freshUuid(), {
        code: uniqueCode('RG'),
        ...rule({ minQuantity: 1e12 }),
      });
      expect(codeOf(hugeThreshold)).toMatch(/^VALIDATION_ERROR/);

      const inverted = await send('pricing.rule.draft', 'PRICE_RULE', freshUuid(), {
        code: uniqueCode('RG'),
        ...rule({ validTo: NOW }),
      });
      expect(codeOf(inverted)).toBe('PRICE_RULE_PERIOD_INVALID');
    });

    it('site hors de la zone : PRICE_RULE_DIMENSIONS_INVALID ; site d’une sous-zone : accepté (D10 §8)', async () => {
      const outside = await send('pricing.rule.draft', 'PRICE_RULE', freshUuid(), {
        code: uniqueCode('RG'),
        ...rule({ zoneId, siteId: siteElsewhere }),
      });
      expect(codeOf(outside)).toBe('PRICE_RULE_DIMENSIONS_INVALID');
      await draft(uniqueCode('RG'), { zoneId, siteId: siteInZone });
    });

    it('nouvelle version : même produit, une seule version suivante vivante, numéro après une version abandonnée', async () => {
      const code = uniqueCode('RG');
      const v1 = await draft(code, { validFrom: NOW, priority: 11 });
      expect(codeOf(await send('pricing.rule.activate', 'PRICE_RULE', v1, {}))).toBe('APPLIED');

      const wrongProduct = await send('pricing.rule.supersede', 'PRICE_RULE', freshUuid(), {
        supersedesRuleId: v1,
        ...rule({ productId: otherProductId, priority: 11 }),
      });
      expect(codeOf(wrongProduct)).toBe('PRICE_RULE_DIMENSIONS_INVALID');

      const v2 = freshUuid();
      expect(
        codeOf(
          await send('pricing.rule.supersede', 'PRICE_RULE', v2, {
            supersedesRuleId: v1,
            ...rule({ priority: 11 }),
          }),
        ),
      ).toBe('APPLIED');
      const second = await send('pricing.rule.supersede', 'PRICE_RULE', freshUuid(), {
        supersedesRuleId: v1,
        ...rule({ priority: 11 }),
      });
      expect(codeOf(second)).toBe('PRICE_RULE_ALREADY_SUPERSEDED');

      // Le brouillon abandonné libère la lignée ; la version suivante prend le numéro 3.
      expect(codeOf(await send('pricing.rule.cancel', 'PRICE_RULE', v2, {}))).toBe('APPLIED');
      expect(codeOf(await send('pricing.rule.cancel', 'PRICE_RULE', v2, {}))).toBe('APPLIED');
      const v3 = freshUuid();
      expect(
        codeOf(
          await send('pricing.rule.supersede', 'PRICE_RULE', v3, {
            supersedesRuleId: v1,
            ...rule({ priority: 11 }),
          }),
        ),
      ).toBe('APPLIED');
      const lineage = (await listPriceRules(db, { productId })).filter((r) => r.code === code);
      expect(lineage.map((r) => [r.version, r.status, r.supersedesRuleId])).toEqual([
        [1, 'ACTIVE', null],
        [2, 'CANCELLED', v1],
        [3, 'DRAFT', v1],
      ]);
      expect(codeOf(await send('pricing.rule.cancel', 'PRICE_RULE', v1, {}))).toBe(
        'PRICE_RULE_NOT_DRAFT',
      );
    });

    it('activation d’une nouvelle version : date d’effet avant celle de la remplacée refusée ; après sa fin, la remplacée reste intacte', async () => {
      const code = uniqueCode('RG');
      const v1 = await draft(code, { validFrom: LATER, validTo: TOMORROW, priority: 12 });
      expect(codeOf(await send('pricing.rule.activate', 'PRICE_RULE', v1, {}))).toBe('APPLIED');

      const early = freshUuid();
      await send('pricing.rule.supersede', 'PRICE_RULE', early, {
        supersedesRuleId: v1,
        ...rule({ validFrom: NOW, priority: 12 }),
      });
      expect(codeOf(await send('pricing.rule.activate', 'PRICE_RULE', early, {}))).toBe(
        'PRICE_RULE_PERIOD_INVALID',
      );
      await send('pricing.rule.cancel', 'PRICE_RULE', early, {});

      const afterEnd = freshUuid();
      await send('pricing.rule.supersede', 'PRICE_RULE', afterEnd, {
        supersedesRuleId: v1,
        ...rule({ validFrom: '2026-10-14T00:00:00.000Z', priority: 12 }),
      });
      expect(codeOf(await send('pricing.rule.activate', 'PRICE_RULE', afterEnd, {}))).toBe(
        'APPLIED',
      );
      const previous = (await listPriceRules(db, { productId })).find((r) => r.id === v1)!;
      expect(previous.validTo?.toISOString()).toBe(TOMORROW);
    });

    it('fin : jamais dans le passé, toujours après la date d’effet (SM-PRICE-RULE)', async () => {
      const id = await draft(uniqueCode('RG'), { validFrom: LATER, priority: 13 });
      expect(codeOf(await send('pricing.rule.activate', 'PRICE_RULE', id, {}))).toBe('APPLIED');
      expect(
        codeOf(
          await send('pricing.rule.end', 'PRICE_RULE', id, { validTo: '2026-10-11T00:00:00.000Z' }),
        ),
      ).toBe('PRICE_RULE_PERIOD_INVALID');
      expect(
        codeOf(
          await send('pricing.rule.end', 'PRICE_RULE', id, { validTo: '2026-10-12T11:00:00.000Z' }),
        ),
      ).toBe('PRICE_RULE_PERIOD_INVALID');
      expect(codeOf(await send('pricing.rule.end', 'PRICE_RULE', id, { validTo: TOMORROW }))).toBe(
        'APPLIED',
      );
    });

    it('code de campagne déjà pris : CODE_EXISTS', async () => {
      const code = uniqueCode('CP');
      const payload = { code, name: 'Campagne', validFrom: NOW, validTo: TOMORROW };
      expect(codeOf(await send('pricing.campaign.create', 'CAMPAIGN', freshUuid(), payload))).toBe(
        'APPLIED',
      );
      expect(codeOf(await send('pricing.campaign.create', 'CAMPAIGN', freshUuid(), payload))).toBe(
        'CODE_EXISTS',
      );
    });
  });

  describe('fournisseurs (S-30, S-37)', () => {
    it('code pris, délai borné, message en français ; un champ reçu à null est effacé et la lecture sert adresse et note', async () => {
      const code = uniqueCode('FRN');
      const id = freshUuid();
      expect(
        codeOf(
          await send('procurement.supplier.create', 'SUPPLIER', id, {
            code,
            name: 'Provenderie',
            address: 'Marché central',
            notes: 'Livre le mardi',
            phone: '699000000',
            paymentTermsDays: 30,
          }),
        ),
      ).toBe('APPLIED');
      expect(
        codeOf(
          await send('procurement.supplier.create', 'SUPPLIER', freshUuid(), {
            code,
            name: 'Autre',
          }),
        ),
      ).toBe('CODE_EXISTS');

      const tooLong = await send('procurement.supplier.create', 'SUPPLIER', freshUuid(), {
        code: uniqueCode('FRN'),
        name: 'Délai démesuré',
        paymentTermsDays: 40_000,
        email: 'pas-un-courriel',
      });
      expect(codeOf(tooLong)).toMatch(/^VALIDATION_ERROR/);
      expect(tooLong.error?.message_fr).toContain(
        '« paymentTermsDays » : valeur trop grande (au plus 3650).',
      );
      expect(tooLong.error?.message_fr).toContain('« email » : adresse électronique invalide.');

      let supplier = (await listSuppliers(db)).find((s) => s.id === id)!;
      expect([supplier.address, supplier.notes]).toEqual(['Marché central', 'Livre le mardi']);
      expect(
        codeOf(
          await send('procurement.supplier.update', 'SUPPLIER', id, {
            notes: null,
            phone: null,
            paymentTermsDays: null,
          }),
        ),
      ).toBe('APPLIED');
      supplier = (await listSuppliers(db)).find((s) => s.id === id)!;
      expect([supplier.notes, supplier.phone, supplier.paymentTermsDays, supplier.address]).toEqual(
        [null, null, null, 'Marché central'],
      );
    });
  });

  describe('catalogue (S-31) et coût standard (S-02)', () => {
    async function categoryId(): Promise<string> {
      const id = freshUuid();
      const result = await send('catalog.product_category.create', 'PRODUCT_CATEGORY', id, {
        code: uniqueCode('CAT'),
        name: 'Catégorie',
      });
      expect(result.status).toBe('APPLIED');
      return id;
    }

    it('codes pris (produit, catégorie de produit, catégorie de client, motif) : CODE_EXISTS', async () => {
      const category = await categoryId();
      const productCode = uniqueCode('PRD');
      const product = {
        code: productCode,
        name: 'Aliment',
        categoryId: category,
        stockFamily: 'INTRANT',
        baseUnitCode: 'TETE',
      };
      expect(codeOf(await send('catalog.product.create', 'PRODUCT', freshUuid(), product))).toBe(
        'APPLIED',
      );
      expect(codeOf(await send('catalog.product.create', 'PRODUCT', freshUuid(), product))).toBe(
        'CODE_EXISTS',
      );

      const categoryCode = uniqueCode('CAT');
      const productCategory = { code: categoryCode, name: 'Volaille' };
      await send(
        'catalog.product_category.create',
        'PRODUCT_CATEGORY',
        freshUuid(),
        productCategory,
      );
      expect(
        codeOf(
          await send(
            'catalog.product_category.create',
            'PRODUCT_CATEGORY',
            freshUuid(),
            productCategory,
          ),
        ),
      ).toBe('CODE_EXISTS');

      const customerCategory = { code: uniqueCode('CC'), name: 'Grossiste' };
      await send(
        'catalog.customer_category.create',
        'CUSTOMER_CATEGORY',
        freshUuid(),
        customerCategory,
      );
      expect(
        codeOf(
          await send(
            'catalog.customer_category.create',
            'CUSTOMER_CATEGORY',
            freshUuid(),
            customerCategory,
          ),
        ),
      ).toBe('CODE_EXISTS');

      const reason = { category: 'LOSS', code: uniqueCode('MT'), label: 'Casse' };
      await send('catalog.reason_code.set', 'REASON_CODE', freshUuid(), reason);
      expect(
        codeOf(await send('catalog.reason_code.set', 'REASON_CODE', freshUuid(), reason)),
      ).toBe('CODE_EXISTS');
    });

    it('unité et canal recréés sous un code existant : identiques sans effet, différents refusés', async () => {
      const unitCode = uniqueCode('U').slice(0, 20);
      const unit = { code: unitCode, name: 'Plateau', isCount: true };
      expect(codeOf(await send('catalog.unit.create', 'UNIT', freshUuid(), unit))).toBe('APPLIED');
      expect(codeOf(await send('catalog.unit.create', 'UNIT', freshUuid(), unit))).toBe('APPLIED');
      expect(
        codeOf(await send('catalog.unit.create', 'UNIT', freshUuid(), { ...unit, isCount: false })),
      ).toBe('CODE_EXISTS');

      const channel = { code: uniqueCode('CN').slice(0, 20), name: 'Marché' };
      expect(
        codeOf(await send('catalog.sales_channel.create', 'SALES_CHANNEL', freshUuid(), channel)),
      ).toBe('APPLIED');
      expect(
        codeOf(
          await send('catalog.sales_channel.create', 'SALES_CHANNEL', freshUuid(), {
            ...channel,
            name: 'Foire',
          }),
        ),
      ).toBe('CODE_EXISTS');
    });

    it('produit biologique : suivi par lot exigé, REQUIRED par défaut (BR-PRD-001)', async () => {
      const category = await categoryId();
      const base = {
        name: 'Porcelet',
        categoryId: category,
        stockFamily: 'BIOLOGIQUE',
        baseUnitCode: 'TETE',
        species: 'PORC',
      };
      const none = await send('catalog.product.create', 'PRODUCT', freshUuid(), {
        ...base,
        code: uniqueCode('BIO'),
        lotTracking: 'NONE',
      });
      expect(codeOf(none)).toMatch(/^VALIDATION_ERROR/);
      expect(none.error?.message_fr).toContain(
        '« lotTracking » : Un produit BIOLOGIQUE se suit par lot',
      );

      const id = freshUuid();
      expect(
        codeOf(
          await send('catalog.product.create', 'PRODUCT', id, { ...base, code: uniqueCode('BIO') }),
        ),
      ).toBe('APPLIED');
      const row = await db
        .selectFrom('catalog_products')
        .select('lot_tracking')
        .where('id', '=', toBin(id))
        .executeTakeFirstOrThrow();
      expect(row.lot_tracking).toBe('REQUIRED');
    });

    it('conditionnement : facteur entier sur une base de comptage (BR-CAT-003), borné à la colonne', async () => {
      const unitCode = uniqueCode('CT').slice(0, 20);
      await send('catalog.unit.create', 'UNIT', freshUuid(), {
        code: unitCode,
        name: 'Carton',
        isCount: false,
      });
      const fractional = await send('catalog.product_unit.set', 'PRODUCT_UNIT', freshUuid(), {
        productId,
        unitCode,
        factorToBase: 2.5,
      });
      expect(codeOf(fractional)).toBe('PRODUCT_UNIT_FACTOR_INVALID');
      const huge = await send('catalog.product_unit.set', 'PRODUCT_UNIT', freshUuid(), {
        productId,
        unitCode,
        factorToBase: 1e9,
      });
      expect(codeOf(huge)).toMatch(/^VALIDATION_ERROR/);
      expect(
        codeOf(
          await send('catalog.product_unit.set', 'PRODUCT_UNIT', freshUuid(), {
            productId,
            unitCode,
            factorToBase: 30,
          }),
        ),
      ).toBe('APPLIED');
    });

    it('coût standard : deux versions au même instant refusées ; la projection n’est plus servie (RC-05)', async () => {
      const id = freshUuid();
      const payload = { productId, unitCostXaf: 700 };
      expect(
        codeOf(
          await send('catalog.product_standard_cost.set', 'PRODUCT_STANDARD_COST', id, payload),
        ),
      ).toBe('APPLIED');
      expect(
        codeOf(
          await send(
            'catalog.product_standard_cost.set',
            'PRODUCT_STANDARD_COST',
            freshUuid(),
            payload,
          ),
        ),
      ).toBe('STANDARD_COST_VERSION_EXISTS');
      expect(resolveEntityProjection('PRODUCT_STANDARD_COST')).toBeUndefined();
    });
  });
});
