/**
 * Atteinte d'objectif (P9-27 ; KPI-COM-16, AV-462 choix (b), AV-473 et AV-474 ; AT-054) : la fonction de
 * référence `sales.targetAttainment` égale (1) une définition indépendante écrite en SQL sur les lignes sources
 * (ventes, annulations, visites, comptes, conversions), (2) les trois fonctions que compose la route
 * `GET /performance/commercial` (`targetRealized` en est la définition unique, ADR-065 §2), et respecte
 * l'étendue (jamais élargie), la fenêtre cumulée, les groupes et le plafond de lecture.
 *
 * Monde validé et neuf (la base est partagée) : un site, deux commerciaux, des clients et des produits neufs,
 * des ventes passées par les commandes réelles (documents complets), des visites, comptes et objectifs insérés
 * directement ; instants fixes passés, aucun total de toute la base (assertions relatives au monde créé).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql, type RawBuilder } from 'kysely';
import {
  FixedClock,
  Uuidv7Generator,
  businessDayEndUtc,
  businessDayStartUtc,
  type IdGenerator,
} from '@gic/domain';
import { CommandPipelineService } from '../src/commands/command-pipeline.service.js';
import { CommandHandlerRegistry } from '../src/platform/sync/command-handler-registry.js';
import { DocumentSequenceService } from '../src/platform/document-sequences/document-sequence.service.js';
import { registerPolicyCommands } from '../src/modules/approvals/application/commands/policy-commands.js';
import { registerRequestCommands as registerApprovalRequestCommands } from '../src/modules/approvals/application/commands/request-commands.js';
import { ApprovalDecisionHandlerRegistry } from '../src/modules/approvals/application/decision-handler-registry.js';
import { registerOrderCommands } from '../src/modules/sales/application/commands/order-commands.js';
import { registerCancelCommands } from '../src/modules/sales/application/commands/cancel-commands.js';
import { registerDeliveryCommands } from '../src/modules/sales/application/commands/delivery-commands.js';
import { registerPaymentCommands } from '../src/modules/sales/application/commands/payment-commands.js';
import {
  recordStockMove,
  virtualLocationId,
} from '../src/modules/inventory/application/public/index.js';
import {
  periodProductQuantity,
  periodRevenue,
  targetAttainment,
  targetRealized,
} from '../src/modules/sales/application/public/index.js';
import { commercialEffort, listTargets } from '../src/modules/crm/application/public/index.js';
import { ratio } from '../src/platform/indicator-window.js';
import { ALL_SCOPE } from '../src/platform/read-scope.js';
import { fromBin, toBin } from '../src/platform/kysely/uuid-columns.js';
import {
  assignTestRole,
  closeTestDb,
  db,
  freshPhone,
  freshUuid,
  grantTestPermission,
  insertTestDevice,
  insertTestLocation,
  insertTestRole,
  insertTestSite,
  insertTestTeam,
  insertTestUser,
  insertTestZone,
} from './helpers.js';

const NOW = '2026-10-09T18:00:00.000Z';
const DAY = '2026-10-09';
const at = (hhmmss: string) => `${DAY}T${hhmmss}.000Z`;
const PERIOD_START = '2026-10-01';
const PERIOD_END = '2026-10-20';
let deviceSeq = 0;

interface Actor {
  readonly userId: string;
  readonly deviceId: string;
}

interface Sellable {
  readonly id: string;
  readonly ruleId: string;
  readonly price: number;
  readonly unit: string;
}

/** Réalisé d'une métrique d'objectif calculé sur les lignes sources, sans passer par les fonctions du module. */
async function documentRealized(
  userId: string,
  metric: string,
  productId: string | null,
  fromUtc: Date,
  toUtc: Date,
): Promise<number> {
  const scalar = async (query: RawBuilder<{ v: unknown }>): Promise<number> => {
    const { rows } = await query.execute(db);
    return Number(rows[0]?.v ?? 0);
  };
  const user = toBin(userId);
  if (metric === 'CA') {
    const gross = await scalar(sql<{ v: unknown }>`
      select coalesce(sum(total_xaf), 0) as v from sales_sales
       where commercial_user_id = ${user} and occurred_at >= ${fromUtc} and occurred_at < ${toUtc}`);
    const cancelled = await scalar(sql<{ v: unknown }>`
      select coalesce(sum(c.cancelled_total_xaf), 0) as v
        from sales_sale_cancellations c join sales_sales s on s.id = c.sale_id
       where s.commercial_user_id = ${user} and c.status = 'APPLIED'
         and c.applied_at >= ${fromUtc} and c.applied_at < ${toUtc}`);
    return gross - cancelled;
  }
  if (metric === 'QTE_PRODUIT') {
    const product = toBin(productId!);
    const sold = await scalar(sql<{ v: unknown }>`
      select coalesce(sum(l.quantity_base), 0) as v
        from sales_sale_lines l join sales_sales s on s.id = l.sale_id
       where l.product_id = ${product} and s.commercial_user_id = ${user}
         and s.occurred_at >= ${fromUtc} and s.occurred_at < ${toUtc}`);
    const cancelled = await scalar(sql<{ v: unknown }>`
      select coalesce(sum(cl.quantity_base), 0) as v
        from sales_sale_cancellation_lines cl
        join sales_sale_cancellations c on c.id = cl.cancellation_id
        join sales_sale_lines l on l.id = cl.sale_line_id
        join sales_sales s on s.id = c.sale_id
       where l.product_id = ${product} and s.commercial_user_id = ${user} and c.status = 'APPLIED'
         and c.applied_at >= ${fromUtc} and c.applied_at < ${toUtc}`);
    return Math.round((sold - cancelled) * 1000) / 1000;
  }
  if (metric === 'VISITES') {
    return scalar(sql<{ v: unknown }>`
      select count(*) as v from crm_visits
       where user_id = ${user} and status = 'RECORDED'
         and occurred_at >= ${fromUtc} and occurred_at < ${toUtc}`);
  }
  if (metric === 'PROSPECTS_CREES') {
    return scalar(sql<{ v: unknown }>`
      select count(*) as v from crm_customers
       where acquired_by_user_id = ${user} and stage <> 'MERGED'
         and acquired_at >= ${fromUtc} and acquired_at < ${toUtc}`);
  }
  if (metric === 'NOUVEAUX_CLIENTS') {
    return scalar(sql<{ v: unknown }>`
      select count(*) as v
        from crm_customers c join crm_customer_assignments a on a.customer_id = c.id
       where a.user_id = ${user} and c.converted_at >= ${fromUtc} and c.converted_at < ${toUtc}
         and a.valid_from <= c.converted_at
         and (a.valid_to is null or a.valid_to > c.converted_at)`);
  }
  throw new Error(`métrique inattendue : ${metric}`);
}

describe('atteinte d’objectif (P9-27, KPI-COM-16, AT-054)', () => {
  let idGenerator: IdGenerator;
  let pipeline: CommandPipelineService;
  let admin: Actor;
  let u: Actor;
  let v: Actor;
  let zoneId: string;
  let siteId: string;
  let storeId: string;
  let categoryId: string;
  let stepId: string;
  let sourceCode: string;
  let outcomeId: string;
  let teamId: string;
  let product: Sellable;
  let product2: Sellable;
  const ids = {
    ca: '',
    qte: '',
    qte2: '',
    visits: '',
    newCustomers: '',
    prospects: '',
    expired: '',
    cancelled: '',
    caV: '',
    site: '',
    team: '',
  };

  type Result = Awaited<ReturnType<CommandPipelineService['handle']>>;
  async function run(
    actor: Actor,
    commandType: string,
    aggregateType: string,
    aggregateId: string,
    occurredAt: string,
    payload: unknown,
  ): Promise<Result> {
    return pipeline.handle(
      {
        command_id: freshUuid(),
        device_seq: ++deviceSeq,
        command_version: 1,
        command_type: commandType,
        aggregate_type: aggregateType,
        aggregate_id: aggregateId,
        author_user_id: actor.userId,
        base_version: null,
        depends_on: [],
        occurred_at: occurredAt,
        client_created_at: occurredAt,
        captured_offline: false,
        backdated_reason: null,
        attachment_ids: [],
        payload,
      },
      {
        authenticatedUserId: actor.userId,
        authenticatedDeviceId: actor.deviceId,
        transport: 'ONLINE_API',
      },
    );
  }

  // --- Fixtures ----------------------------------------------------------------------------------

  async function roleId(roleCode: string): Promise<string> {
    const row = await db
      .selectFrom('identity_roles')
      .select('id')
      .where('code', '=', roleCode)
      .executeTakeFirstOrThrow();
    return fromBin(row.id);
  }

  async function sellable(price: number): Promise<Sellable> {
    const id = freshUuid();
    await db
      .insertInto('catalog_products')
      .values({
        id: toBin(id),
        code: `PRD-${id.slice(-10)}`,
        name: 'Poulet de chair',
        category_id: toBin(categoryId),
        stock_family: 'MARCHANDISE',
        base_unit_code: 'PIECE',
        pricing_mode: 'PER_UNIT',
        is_sellable: 1,
        created_by: toBin(admin.userId),
      })
      .execute();
    const ruleId = freshUuid();
    await db
      .insertInto('pricing_price_rules')
      .values({
        id: toBin(ruleId),
        code: `PR-${ruleId.slice(-12)}`,
        version: 1,
        product_id: toBin(id),
        unit_price_xaf: price,
        pricing_unit_code: 'PIECE',
        status: 'ACTIVE',
        valid_from: new Date('2026-01-01T00:00:00.000Z'),
        approved_by: toBin(admin.userId),
        approved_at: new Date('2026-01-01T00:00:00.000Z'),
        created_by: toBin(admin.userId),
      })
      .execute();
    return { id, ruleId, price, unit: 'PIECE' };
  }

  async function stock(productId: string, quantity: number, unitCost: number): Promise<void> {
    await db.transaction().execute(async (trx) => {
      await recordStockMove(
        trx,
        { idGenerator },
        {
          productId,
          quantityBase: quantity,
          fromLocationId: await virtualLocationId(trx, 'V_SUPPLIER'),
          toLocationId: storeId,
          moveType: 'PURCHASE_RECEIPT',
          declaredUnitCostXaf: unitCost,
          occurredAt: new Date('2026-10-09T06:00:00.000Z'),
          sourceDocType: 'GOODS_RECEIPT',
          sourceDocId: freshUuid(),
          createdBy: admin.userId,
          allowNegative: false,
        },
      );
    });
  }

  /** Compte neuf acquis par `acquiredBy` à `acquiredAt`, confié à son acquéreur dès l'acquisition. */
  async function newCustomer(
    acquiredBy: Actor,
    acquiredAt: string,
    options: { readonly credit?: boolean } = {},
  ): Promise<string> {
    const id = freshUuid();
    const when = new Date(acquiredAt);
    await db
      .insertInto('crm_customers')
      .values({
        id: toBin(id),
        stage: 'PROSPECT',
        pipeline_step_id: toBin(stepId),
        display_name: 'Restaurant du port',
        phone_primary: await freshPhone(),
        zone_id: toBin(zoneId),
        source_code: sourceCode,
        // Titulaire dénormalisé = titulaire de l'affectation ouverte ci-dessous (INV-CRM-02, balayé sur toute la base).
        owner_user_id: toBin(acquiredBy.userId),
        acquired_by_user_id: toBin(acquiredBy.userId),
        acquired_at: when,
        occurred_at: when,
        credit_allowed: options.credit ? 1 : 0,
        ...(options.credit ? { credit_limit_xaf: 1_000_000 } : {}),
        created_by: toBin(admin.userId),
      })
      .execute();
    await db
      .insertInto('crm_customer_assignments')
      .values({
        id: toBin(freshUuid()),
        customer_id: toBin(id),
        user_id: toBin(acquiredBy.userId),
        valid_from: when,
        assigned_by: toBin(admin.userId),
      })
      .execute();
    return id;
  }

  async function visit(
    actor: Actor,
    customerId: string,
    occurredAt: string,
    status: 'RECORDED' | 'CANCELLED' = 'RECORDED',
  ): Promise<void> {
    await db
      .insertInto('crm_visits')
      .values({
        id: toBin(freshUuid()),
        customer_id: toBin(customerId),
        user_id: toBin(actor.userId),
        customer_stage_at_visit: 'PROSPECT',
        outcome_reason_code_id: toBin(outcomeId),
        // Hors session : l'indicateur est posé (AV-023, BR-CRM-013, balayé sur toute la base).
        flags: JSON.stringify(['OUT_OF_SESSION']),
        occurred_at: new Date(occurredAt),
        created_by: toBin(actor.userId),
        ...(status === 'CANCELLED'
          ? {
              status,
              cancelled_at: new Date(occurredAt),
              cancelled_by: toBin(actor.userId),
            }
          : {}),
      })
      .execute();
  }

  async function target(input: {
    readonly type: 'USER' | 'TEAM' | 'SITE';
    readonly owner: string;
    readonly metric: string;
    readonly productId?: string;
    readonly start: string;
    readonly end: string;
    readonly value: number;
    readonly status?: 'ACTIVE' | 'CANCELLED';
  }): Promise<string> {
    const id = freshUuid();
    await db
      .insertInto('crm_sales_targets')
      .values({
        id: toBin(id),
        target_type: input.type,
        ...(input.type === 'USER' ? { user_id: toBin(input.owner) } : {}),
        ...(input.type === 'TEAM' ? { team_id: toBin(input.owner) } : {}),
        ...(input.type === 'SITE' ? { site_id: toBin(input.owner) } : {}),
        metric: input.metric,
        ...(input.productId !== undefined ? { product_id: toBin(input.productId) } : {}),
        period_start: new Date(`${input.start}T00:00:00.000Z`),
        period_end: new Date(`${input.end}T00:00:00.000Z`),
        target_value: input.value,
        status: input.status ?? 'ACTIVE',
        created_by: toBin(admin.userId),
      })
      .execute();
    return id;
  }

  /** Vente sur commande confirmée par `actor` ; renvoie l'identifiant de la vente. */
  async function orderSale(
    actor: Actor,
    customerId: string,
    item: Sellable,
    quantity: number,
    hhmmss: string,
  ): Promise<string> {
    const orderId = freshUuid();
    const result = await run(actor, 'sales.order.place', 'SALES_ORDER', orderId, at(hhmmss), {
      fulfilmentLocationId: storeId,
      customerId,
      lines: [
        {
          productId: item.id,
          quantity,
          unitCode: item.unit,
          quantityBase: quantity,
          listUnitPriceXaf: item.price,
          priceRuleId: item.ruleId,
          unitPriceXaf: item.price,
        },
      ],
    });
    expect(result.status, JSON.stringify(result)).toMatch(/^APPLIED/);
    const sale = await db
      .selectFrom('sales_sales')
      .select('id')
      .where('order_id', '=', toBin(orderId))
      .orderBy('occurred_at')
      .executeTakeFirstOrThrow();
    return fromBin(sale.id);
  }

  beforeAll(async () => {
    const clock = new FixedClock(new Date(NOW));
    idGenerator = new Uuidv7Generator(clock);
    const registry = new CommandHandlerRegistry();
    const decisions = new ApprovalDecisionHandlerRegistry();
    const sequences = new DocumentSequenceService();
    registerOrderCommands(registry, idGenerator, sequences);
    registerCancelCommands(registry, decisions, idGenerator, sequences);
    registerDeliveryCommands(registry, idGenerator, sequences);
    registerPaymentCommands(registry, decisions, idGenerator, sequences);
    registerPolicyCommands(registry);
    registerApprovalRequestCommands(registry, decisions);
    pipeline = new CommandPipelineService(db, registry, clock, idGenerator);

    for (const unit of ['PIECE', 'KG', 'FORFAIT']) {
      const exists = await db
        .selectFrom('catalog_units')
        .select('code')
        .where('code', '=', unit)
        .executeTakeFirst();
      if (!exists) {
        await db
          .insertInto('catalog_units')
          .values({ code: unit, name: unit, is_count: unit === 'KG' ? 0 : 1 })
          .execute();
      }
    }
    for (const channel of ['DIRECT', 'SEDENTAIRE', 'TERRAIN']) {
      const exists = await db
        .selectFrom('catalog_sales_channels')
        .select('code')
        .where('code', '=', channel)
        .executeTakeFirst();
      if (!exists) {
        await db
          .insertInto('catalog_sales_channels')
          .values({ code: channel, name: channel })
          .execute();
      }
    }

    const sedentary = await roleId('COMMERCIAL_SEDENTAIRE');
    await db.transaction().execute(async (trx) => {
      const adminId = await insertTestUser(trx);
      admin = { userId: adminId, deviceId: await insertTestDevice(trx, adminId) };
      const adminRole = await insertTestRole(trx, adminId);
      await grantTestPermission(trx, adminRole, 'approvals.policy.manage', adminId);
      await assignTestRole(trx, adminId, adminRole, adminId);
      zoneId = await insertTestZone(trx, adminId);
      siteId = await insertTestSite(trx, adminId, zoneId, { siteType: 'MAGASIN' });
      storeId = await insertTestLocation(trx, adminId, siteId, { locationType: 'STORE' });
      const actor = async (role: string) => {
        const userId = await insertTestUser(trx);
        const deviceId = await insertTestDevice(trx, userId, { status: 'ACTIVE' });
        await assignTestRole(trx, userId, role, adminId, { scopeType: 'GLOBAL' });
        return { userId, deviceId };
      };
      u = await actor(sedentary);
      v = await actor(sedentary);
      teamId = await insertTestTeam(trx, adminId, adminId);
      categoryId = freshUuid();
      await trx
        .insertInto('catalog_product_categories')
        .values({
          id: toBin(categoryId),
          code: `CAT-${categoryId.slice(-8)}`,
          name: 'Divers',
          created_by: toBin(adminId),
        })
        .execute();
      stepId = freshUuid();
      await trx
        .insertInto('crm_pipeline_steps')
        .values({
          id: toBin(stepId),
          code: `STEP_${stepId.slice(-8)}`,
          label: 'Nouveau',
          sort_order: 10,
          created_by: toBin(adminId),
        })
        .execute();
      sourceCode = `SRC_${freshUuid().slice(-8)}`;
      await trx
        .insertInto('crm_lead_sources')
        .values({
          id: toBin(freshUuid()),
          code: sourceCode,
          label: 'Kommo',
          created_by: toBin(adminId),
        })
        .execute();
      outcomeId = freshUuid();
      await trx
        .insertInto('catalog_reason_codes')
        .values({
          id: toBin(outcomeId),
          category: 'VISIT_OUTCOME',
          code: `TEST_${outcomeId.replace(/-/g, '').slice(-12).toUpperCase()}`,
          label: 'Intéressé',
          created_by: toBin(adminId),
        })
        .execute();
    });
    const policyId = freshUuid();
    const policy = await run(
      admin,
      'approvals.policy.set',
      'CONTROL_POLICY',
      policyId,
      at('00:00:00'),
      {
        code: `SALE_CANCELLATION_${policyId.slice(-8)}`,
        operationType: 'SALE_CANCELLATION',
        requiresApproval: true,
        approverPermission: 'sales.sale_cancel.approve',
        approverScope: 'ALL',
      },
    );
    expect(policy.status, JSON.stringify(policy)).toBe('APPLIED');

    product = await sellable(1000);
    product2 = await sellable(2000);
    await stock(product.id, 20, 600);

    // Comptes : c1 (acquis par U dans la fenêtre, converti par la première vente), c2 (avant l'objectif),
    // c3 (après le jour de lecture), c4 (client de V).
    const c1 = await newCustomer(u, '2026-10-05T08:00:00.000Z', { credit: true });
    await newCustomer(u, '2026-09-20T08:00:00.000Z');
    await newCustomer(u, '2026-10-12T08:00:00.000Z');
    const c4 = await newCustomer(v, '2026-10-03T08:00:00.000Z', { credit: true });

    // Ventes : U vend 5 puis 3 pièces (la seconde est annulée dans le quart d'heure), V en vend 2.
    await orderSale(u, c1, product, 5, '09:00:00');
    const second = await orderSale(u, c1, product, 3, '09:30:00');
    const cancelled = await run(
      u,
      'sales.sale.cancel',
      'SALE_CANCELLATION',
      freshUuid(),
      at('09:40:00'),
      {
        saleId: second,
        comment: 'Erreur de saisie',
      },
    );
    expect(cancelled.status, JSON.stringify(cancelled)).toBe('APPLIED');
    await orderSale(v, c4, product, 2, '09:45:00');

    // Visites de U : trois dans la fenêtre au 09/10, une après, une avant l'objectif, une annulée ; une de V.
    await visit(u, c1, '2026-10-02T09:00:00.000Z');
    await visit(u, c1, '2026-10-06T09:00:00.000Z');
    await visit(u, c1, '2026-10-09T12:00:00.000Z');
    await visit(u, c1, '2026-10-12T09:00:00.000Z');
    await visit(u, c1, '2026-09-25T09:00:00.000Z');
    await visit(u, c1, '2026-10-03T09:00:00.000Z', 'CANCELLED');
    await visit(v, c4, '2026-10-04T09:00:00.000Z');

    // Objectifs : six actifs de U, un de V, un de site et un d'équipe (ignorés), un annulé et un échu (ignorés).
    const month = { start: PERIOD_START, end: PERIOD_END };
    ids.ca = await target({
      type: 'USER',
      owner: u.userId,
      metric: 'CA',
      ...month,
      value: 1_000_000,
    });
    ids.qte = await target({
      type: 'USER',
      owner: u.userId,
      metric: 'QTE_PRODUIT',
      productId: product.id,
      ...month,
      value: 100,
    });
    ids.qte2 = await target({
      type: 'USER',
      owner: u.userId,
      metric: 'QTE_PRODUIT',
      productId: product2.id,
      ...month,
      value: 10,
    });
    ids.visits = await target({
      type: 'USER',
      owner: u.userId,
      metric: 'VISITES',
      ...month,
      value: 20,
    });
    ids.newCustomers = await target({
      type: 'USER',
      owner: u.userId,
      metric: 'NOUVEAUX_CLIENTS',
      ...month,
      value: 4,
    });
    ids.prospects = await target({
      type: 'USER',
      owner: u.userId,
      metric: 'PROSPECTS_CREES',
      ...month,
      value: 5,
    });
    ids.expired = await target({
      type: 'USER',
      owner: u.userId,
      metric: 'PROSPECTS_CREES',
      start: '2026-09-01',
      end: '2026-09-30',
      value: 10,
    });
    ids.cancelled = await target({
      type: 'USER',
      owner: u.userId,
      metric: 'CA',
      ...month,
      value: 777,
      status: 'CANCELLED',
    });
    ids.caV = await target({
      type: 'USER',
      owner: v.userId,
      metric: 'CA',
      ...month,
      value: 500_000,
    });
    ids.site = await target({
      type: 'SITE',
      owner: siteId,
      metric: 'CA',
      ...month,
      value: 2_000_000,
    });
    ids.team = await target({
      type: 'TEAM',
      owner: teamId,
      metric: 'CA',
      ...month,
      value: 3_000_000,
    });
  }, 120_000);

  afterAll(async () => {
    await closeTestDb();
  });

  const activeOfU = () => [ids.ca, ids.qte, ids.qte2, ids.visits, ids.newCustomers, ids.prospects];
  const idsOf = (lines: readonly { readonly targetId: string }[]) =>
    lines.map((line) => line.targetId).sort();

  // --- 1. Fonction = documents ---------------------------------------------------------------------

  it('fonction = documents : chaque ligne égale le calcul indépendant sur les lignes sources', async () => {
    const result = await targetAttainment(db, { userIds: [u.userId] }, { day: DAY });
    expect(result).toMatchObject({
      day: DAY,
      resolved: true,
      truncated: false,
      unresolvedTargets: 0,
    });
    expect(idsOf(result.lines)).toEqual(activeOfU().sort());
    for (const line of result.lines) {
      const documents = await documentRealized(
        line.userId,
        line.metric,
        line.productId,
        businessDayStartUtc(line.periodStart),
        businessDayEndUtc(line.periodEnd < DAY ? line.periodEnd : DAY),
      );
      expect(line.realized, `${line.metric} ${line.targetId}`).toBe(documents);
      expect(line.attainment).toBe(ratio(documents, line.targetValue));
    }
    // Valeurs attendues du monde fabriqué (U : 5 000 de CA net, 5 pièces, 3 visites, 1 conversion, 1 compte).
    const byTarget = new Map(result.lines.map((line) => [line.targetId, line]));
    expect(byTarget.get(ids.ca)).toMatchObject({
      userId: u.userId,
      targetValue: 1_000_000,
      realized: 5000,
      attainment: 0.005,
    });
    expect(byTarget.get(ids.qte)).toMatchObject({ realized: 5, attainment: 0.05 });
    expect(byTarget.get(ids.qte2)).toMatchObject({ realized: 0, attainment: 0 });
    expect(byTarget.get(ids.visits)).toMatchObject({ realized: 3, attainment: 0.15 });
    expect(byTarget.get(ids.newCustomers)).toMatchObject({ realized: 1, attainment: 0.25 });
    expect(byTarget.get(ids.prospects)).toMatchObject({ realized: 1, attainment: 0.2 });
  });

  // --- 2. Fonction = route existante ---------------------------------------------------------------

  it('targetRealized égale les trois fonctions que compose GET /performance/commercial', async () => {
    for (const [from, to] of [
      [PERIOD_START, DAY],
      [DAY, DAY],
      ['2026-10-10', '2026-10-12'],
      ['2026-09-01', '2026-09-30'],
    ] as const) {
      const window = { fromUtc: businessDayStartUtc(from), toUtc: businessDayEndUtc(to) };
      const base = { userId: u.userId, productId: null, ...window };
      const effort = await commercialEffort(db, { userId: u.userId, ...window });
      expect(await targetRealized(db, { ...base, metric: 'CA' })).toBe(
        (await periodRevenue(db, { ...window, commercialUserId: u.userId })).netRevenueXaf,
      );
      expect(
        await targetRealized(db, { ...base, metric: 'QTE_PRODUIT', productId: product.id }),
      ).toBe(
        await periodProductQuantity(db, {
          ...window,
          commercialUserId: u.userId,
          productId: product.id,
        }),
      );
      expect(await targetRealized(db, { ...base, metric: 'VISITES' })).toBe(effort.visits);
      expect(await targetRealized(db, { ...base, metric: 'PROSPECTS_CREES' })).toBe(
        effort.prospectsCreated,
      );
      expect(await targetRealized(db, { ...base, metric: 'NOUVEAUX_CLIENTS' })).toBe(
        effort.newCustomers,
      );
    }
    // Non calculable : métrique inconnue, quantité sans produit.
    const window = { fromUtc: businessDayStartUtc(DAY), toUtc: businessDayEndUtc(DAY) };
    expect(
      await targetRealized(db, {
        userId: u.userId,
        metric: 'INCONNUE',
        productId: null,
        ...window,
      }),
    ).toBeNull();
    expect(
      await targetRealized(db, {
        userId: u.userId,
        metric: 'QTE_PRODUIT',
        productId: null,
        ...window,
      }),
    ).toBeNull();
    // L'attribution suit le commercial (BR-VEN-020) : la vente de V n'est pas au réalisé de U, et inversement.
    expect(
      await targetRealized(db, { userId: v.userId, metric: 'CA', productId: null, ...window }),
    ).toBe(2000);
  });

  // --- 3. Étendue ----------------------------------------------------------------------------------

  it(
    'étendue : jamais élargie, objectifs de personnes seuls, sites seuls non résolus',
    { timeout: 60_000 },
    async () => {
      const all = await targetAttainment(db, ALL_SCOPE, { day: DAY });
      expect(all.resolved).toBe(true);
      // Les objectifs `SITE`, `TEAM`, annulés et échus ne sont jamais lus, quelle que soit la base.
      const seen = new Set(all.lines.map((line) => line.targetId));
      for (const ignored of [ids.site, ids.team, ids.cancelled, ids.expired]) {
        expect(seen.has(ignored)).toBe(false);
      }
      if (!all.truncated) {
        for (const wanted of [...activeOfU(), ids.caV]) expect(seen.has(wanted)).toBe(true);
      }

      const own = await targetAttainment(db, { userIds: [u.userId] }, { day: DAY });
      expect(idsOf(own.lines)).toEqual(activeOfU().sort());
      const withSite = await targetAttainment(
        db,
        { siteIds: [siteId], userIds: [u.userId] },
        { day: DAY },
      );
      expect(withSite).toEqual(own);
      const both = await targetAttainment(db, { userIds: [u.userId, v.userId] }, { day: DAY });
      expect(idsOf(both.lines)).toEqual([...activeOfU(), ids.caV].sort());

      const sitesOnly = await targetAttainment(db, { siteIds: [siteId] }, { day: DAY });
      expect(sitesOnly).toEqual({
        day: DAY,
        resolved: false,
        truncated: false,
        unresolvedTargets: 0,
        lines: [],
        groups: [],
      });
      for (const empty of [{ userIds: [] }, { siteIds: [] }]) {
        expect(await targetAttainment(db, empty, { day: DAY })).toEqual({
          day: DAY,
          resolved: true,
          truncated: false,
          unresolvedTargets: 0,
          lines: [],
          groups: [],
        });
      }
    },
  );

  // --- 4. Fenêtre ----------------------------------------------------------------------------------

  it('fenêtre : cumul du début de l’objectif au jour de lecture, jour de fin inclus', async () => {
    // Avant le début des objectifs du mois : seul l'objectif échu (septembre) est actif ce jour-là.
    const before = await targetAttainment(db, { userIds: [u.userId] }, { day: '2026-09-30' });
    expect(idsOf(before.lines)).toEqual([ids.expired]);
    expect(before.lines[0]).toMatchObject({ metric: 'PROSPECTS_CREES', realized: 1 });
    // La veille des ventes : l'objectif est lu, le réalisé est nul.
    const eve = await targetAttainment(db, { userIds: [u.userId] }, { day: '2026-10-08' });
    expect(eve.lines.find((line) => line.targetId === ids.ca)).toMatchObject({ realized: 0 });
    // Dernier jour de l'objectif inclus : toutes les visites jusqu'au 20/10 (celle du 12/10 comprise).
    const last = await targetAttainment(db, { userIds: [u.userId] }, { day: PERIOD_END });
    expect(idsOf(last.lines)).toEqual(activeOfU().sort());
    const visits = last.lines.find((line) => line.targetId === ids.visits)!;
    expect(visits.realized).toBe(
      await documentRealized(
        u.userId,
        'VISITES',
        null,
        businessDayStartUtc(PERIOD_START),
        businessDayEndUtc(PERIOD_END),
      ),
    );
    expect(visits.realized).toBe(4);
    // Le lendemain de la fin : plus aucun objectif de U.
    const after = await targetAttainment(db, { userIds: [u.userId] }, { day: '2026-10-21' });
    expect(after.lines).toEqual([]);
  });

  // --- 5. Groupes ----------------------------------------------------------------------------------

  it('groupes : Σ réalisé ÷ Σ cible par métrique, quantités par produit, ordre fixe', async () => {
    const result = await targetAttainment(db, { userIds: [u.userId, v.userId] }, { day: DAY });
    expect(result.unresolvedTargets).toBe(0);
    const productsInOrder = [
      { id: product.id, target: 100, realized: 5, attainment: 0.05 },
      { id: product2.id, target: 10, realized: 0, attainment: 0 },
    ].sort((a, b) => a.id.localeCompare(b.id));
    expect(result.groups).toEqual([
      {
        metric: 'CA',
        productId: null,
        targets: 2,
        targetValue: 1_500_000,
        realized: 7000,
        attainment: 0.0047,
      },
      ...productsInOrder.map((p) => ({
        metric: 'QTE_PRODUIT',
        productId: p.id,
        targets: 1,
        targetValue: p.target,
        realized: p.realized,
        attainment: p.attainment,
      })),
      {
        metric: 'NOUVEAUX_CLIENTS',
        productId: null,
        targets: 1,
        targetValue: 4,
        realized: 1,
        attainment: 0.25,
      },
      {
        metric: 'VISITES',
        productId: null,
        targets: 1,
        targetValue: 20,
        realized: 3,
        attainment: 0.15,
      },
      {
        metric: 'PROSPECTS_CREES',
        productId: null,
        targets: 1,
        targetValue: 5,
        realized: 1,
        attainment: 0.2,
      },
    ]);
  });

  // --- 6. Plafond de lecture -----------------------------------------------------------------------

  it('plafond : TARGET_LIST_LIMIT objectifs lus signalent une liste peut-être incomplète', async () => {
    const capped = await targetAttainment(db, { userIds: [u.userId] }, { day: DAY, limit: 2 });
    expect(capped.truncated).toBe(true);
    expect(capped.lines).toHaveLength(2);
    const roomy = await targetAttainment(db, { userIds: [u.userId] }, { day: DAY, limit: 10 });
    expect(roomy.truncated).toBe(false);
    expect(roomy.lines).toHaveLength(6);
  });

  // --- 7. Filtres de listTargets -------------------------------------------------------------------

  it('listTargets : filtres de type et de titulaires, liste vide = aucun résultat', async () => {
    const idsOfTargets = (rows: readonly { readonly id: string }[]) => rows.map((r) => r.id).sort();
    expect(
      idsOfTargets(await listTargets(db, { targetType: 'SITE', siteId, activeOn: DAY })),
    ).toEqual([ids.site]);
    expect(
      idsOfTargets(await listTargets(db, { targetType: 'TEAM', teamId, activeOn: DAY })),
    ).toEqual([ids.team]);
    expect(await listTargets(db, { userIds: [] })).toEqual([]);
    expect(
      idsOfTargets(
        await listTargets(db, { targetType: 'USER', userIds: [u.userId, v.userId], activeOn: DAY }),
      ),
    ).toEqual([...activeOfU(), ids.caV].sort());
    expect(
      idsOfTargets(
        await listTargets(db, { userIds: [u.userId], activeOn: DAY, includeCancelled: true }),
      ),
    ).toEqual([...activeOfU(), ids.cancelled].sort());
    expect(await listTargets(db, { userIds: [u.userId], limit: 1 })).toHaveLength(1);
  });
});
