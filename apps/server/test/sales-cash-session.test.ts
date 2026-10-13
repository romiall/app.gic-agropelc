/**
 * P5-14 — vente et caisse (BR-DIS-005, BR-VEN-028 ; ADR-032 §2, §6, §8 ; AV-155, AV-157, AV-184 à
 * AV-187 ; AT-031 complet), à travers le vrai pipeline et le protocole hors ligne :
 * - encaissement en espèces au PDV : refus en ligne sans session ouverte (`CASH_SESSION_REQUIRED`) ;
 *   hors ligne sans session, fait appliqué avec avertissement, conflit et drapeau `CASH_SESSION_MISSING`,
 *   résolu par une ouverture appliquée après coup qui couvre sa date ; index de session posé sur
 *   l'encaissement et la vente ;
 * - annulation directe (BR-VEN-028) : session de la vente ouverte → directe, remboursement en espèces
 *   dans la session ; session close → demande avec `CANCEL_SESSION_CLOSED` ;
 * - inverse d'une annulation d'encaissement daté de l'original (AV-157 (a)) : il retombe dans sa
 *   session close et la réévalue (`REVERSAL`) ;
 * - AT-031 : session validée avec −500, puis vente en espèces hors ligne d'un autre vendeur, datée dans
 *   la fenêtre et synchronisée après la validation → aucun `CASH_SESSION_MISSING`, ajustement du delta
 *   à demande propre, session figée, INV-FIN-11 ; sous-totaux par vendeur (couche de transport) ;
 * - revue adverse : mêmes règles pour l'encaissement hors vente (`sales.payment.record`) et l'acompte
 *   d'une commande (`sales.order.place`) ; BR-VEN-028 sur un encaissement sans session, une vente sans
 *   espèces au PDV, une session ouverte après l'heure de l'annulation, un encaissement en demande
 *   d'annulation, et la décision d'une demande après la clôture (AV-186) ; index recopié à
 *   l'approbation d'un doublon suspect (AV-184).
 *
 * Base partagée : chaque test crée son PDV ; journée fixe dans le passé (2026-10-03) ; politiques du seed.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FixedClock, Uuidv7Generator, type IdGenerator } from '@gic/domain';
import type { CommandResult } from '@gic/contracts';
import { CommandPipelineService } from '../src/commands/command-pipeline.service.js';
import { CommandHandlerRegistry } from '../src/platform/sync/command-handler-registry.js';
import { DocumentSequenceService } from '../src/platform/document-sequences/document-sequence.service.js';
import { SyncPushService } from '../src/sync/sync-push.service.js';
import { SyncPullService } from '../src/sync/sync-pull.service.js';
import { registerRequestCommands } from '../src/modules/approvals/application/commands/request-commands.js';
import { ApprovalDecisionHandlerRegistry } from '../src/modules/approvals/application/decision-handler-registry.js';
import { registerSaleCommands } from '../src/modules/sales/application/commands/sale-commands.js';
import { registerCancelCommands } from '../src/modules/sales/application/commands/cancel-commands.js';
import { registerPaymentCommands } from '../src/modules/sales/application/commands/payment-commands.js';
import { registerOrderCommands } from '../src/modules/sales/application/commands/order-commands.js';
import { registerCashSessionCommands } from '../src/modules/finance/application/commands/cash-session-commands.js';
import { verifyCashSessionVariance } from '../src/modules/finance/application/cash-session-validation.js';
import { verifyCashLedger } from '../src/modules/finance/application/public/index.js';
import {
  recordStockMove,
  virtualLocationId,
} from '../src/modules/inventory/application/public/index.js';
import { cashSessionSellerSubtotals } from '../src/finance-api/cash-session-subtotals.js';
import { fromBin, toBin } from '../src/platform/kysely/uuid-columns.js';
import {
  closeTestDb,
  db,
  freshUuid,
  insertTestDevice,
  insertTestLocation,
  insertTestUser,
  insertTestZone,
  freshPhone,
} from './helpers.js';
import { OfflineDevice } from './device-harness.js';
import {
  codeOf,
  newAccount,
  newActor,
  newPosSite,
  runCommand,
  tx,
  type Actor,
} from './cash-transfer-fixtures.js';

const DAY = '2026-10-03';
const at = (hhmm: string) => `${DAY}T${hhmm}:00.000Z`;
const PRICE = 500;

interface Pos {
  readonly siteId: string;
  readonly counterId: string;
  readonly accountId: string;
  /** Compte mobile money (moyen sans session de caisse). */
  readonly momoId: string;
  readonly seller: Actor;
  readonly seller2: Actor;
}

describe('P5-14 : vente et caisse (BR-DIS-005, BR-VEN-028, AT-031)', { timeout: 120_000 }, () => {
  let clock: FixedClock;
  let idGenerator: IdGenerator;
  let pipeline: CommandPipelineService;
  let services: { push: SyncPushService; pull: SyncPullService };
  let root: string;
  let zoneId: string;
  let fin1: Actor;
  let fin2: Actor;
  let productId: string;
  let ruleId: string;
  let stepId: string;
  let sourceCode: string;

  const run = (
    actor: Actor,
    type: string,
    aggregateType: string,
    aggregateId: string,
    occurredAt: string,
    payload: unknown,
    offline = false,
  ): Promise<CommandResult> =>
    runCommand(pipeline, actor, { type, aggregateType, aggregateId, occurredAt, payload, offline });

  const ok = async (...args: Parameters<typeof run>) => {
    const result = await run(...args);
    expect(result.status, JSON.stringify(result)).toMatch(/^APPLIED/);
    return result;
  };
  const warningsOf = (result: CommandResult) =>
    result.status === 'APPLIED_WITH_WARNINGS' ? result.warnings : [];

  const line = (quantity: number) => ({
    productId,
    quantity,
    unitCode: 'PIECE',
    quantityBase: quantity,
    listUnitPriceXaf: PRICE,
    priceRuleId: ruleId,
    unitPriceXaf: PRICE,
  });

  /** Référence de mobile money unique sur la base partagée. */
  const momoRef = () => `OM-${freshUuid().slice(-12)}`;

  /** Vente réglée par mobile money (aucune session de caisse : BR-DIS-005 ne vise que les espèces). */
  const momoSaleBody = (pos: Pos, quantity: number) => ({
    fromLocationId: pos.counterId,
    lines: [line(quantity)],
    payments: [
      {
        methodCode: 'MOBILE_MONEY_ORANGE',
        amountXaf: quantity * PRICE,
        reference: momoRef(),
        cashAccountId: pos.momoId,
      },
    ],
  });

  /** Vente anonyme sans encaissement (seulement hors ligne : `ANONYMOUS_UNPAID`, AV-137). */
  const unpaidSaleBody = (pos: Pos, quantity: number) => ({
    fromLocationId: pos.counterId,
    lines: [line(quantity)],
  });

  /** Vente en espèces sur la caisse du PDV (montant = quantité × 500). */
  const saleBody = (pos: Pos, quantity: number) => ({
    fromLocationId: pos.counterId,
    lines: [line(quantity)],
    payments: [
      { methodCode: 'ESPECES', amountXaf: quantity * PRICE, cashAccountId: pos.accountId },
    ],
  });

  async function newPos(): Promise<Pos> {
    const siteId = await newPosSite(root, zoneId);
    const seller = await newActor('VENDEUR_PDV', root, { scopeType: 'SITE', scopeSiteId: siteId });
    const seller2 = await newActor('VENDEUR_PDV', root, { scopeType: 'SITE', scopeSiteId: siteId });
    const accountId = await newAccount({ type: 'CAISSE_PDV', responsible: seller.userId, siteId });
    const momoId = await newAccount({ type: 'MOBILE_MONEY', responsible: seller.userId });
    const counterId = await tx(async (trx) => {
      const id = await insertTestLocation(trx, root, siteId, { locationType: 'POS' });
      await recordStockMove(
        trx,
        { idGenerator },
        {
          productId,
          quantityBase: 500,
          fromLocationId: await virtualLocationId(trx, 'V_SUPPLIER'),
          toLocationId: id,
          moveType: 'PURCHASE_RECEIPT',
          declaredUnitCostXaf: 300,
          occurredAt: new Date(at('05:00')),
          sourceDocType: 'GOODS_RECEIPT',
          sourceDocId: freshUuid(),
          createdBy: root,
          allowNegative: false,
        },
      );
      return id;
    });
    return { siteId, counterId, accountId, momoId, seller, seller2 };
  }

  const openSession = async (pos: Pos, occurredAt: string, countedXaf = 0, offline = false) => {
    const sessionId = freshUuid();
    await ok(
      pos.seller,
      'finance.cash_session.open',
      'CASH_SESSION',
      sessionId,
      occurredAt,
      { cashAccountId: pos.accountId, countedXaf },
      offline,
    );
    return sessionId;
  };

  /** Encaissement hors vente d'une vente anonyme désignée (BR-FIN-001), en espèces sur la caisse du PDV. */
  const payAnonymousSale = async (
    pos: Pos,
    saleId: string,
    amountXaf: number,
    occurredAt: string,
    offline = false,
    method: {
      readonly methodCode: string;
      readonly cashAccountId: string;
      readonly reference?: string;
    } = {
      methodCode: 'ESPECES',
      cashAccountId: pos.accountId,
    },
  ) => {
    const id = freshUuid();
    const result = await run(
      pos.seller,
      'sales.payment.record',
      'CUSTOMER_PAYMENT',
      id,
      occurredAt,
      { ...method, amountXaf, allocations: [{ saleId, amountXaf }] },
      offline,
    );
    return { id, result };
  };

  const paymentRow = (id: string) =>
    db
      .selectFrom('sales_customer_payments')
      .selectAll()
      .where('id', '=', toBin(id))
      .executeTakeFirst();

  async function newCustomer(): Promise<string> {
    const id = freshUuid();
    await db
      .insertInto('crm_customers')
      .values({
        id: toBin(id),
        stage: 'PROSPECT',
        pipeline_step_id: toBin(stepId),
        display_name: 'Restaurant de la gare',
        phone_primary: await freshPhone(),
        zone_id: toBin(zoneId),
        source_code: sourceCode,
        acquired_by_user_id: toBin(root),
        acquired_at: new Date('2026-01-01T00:00:00.000Z'),
        occurred_at: new Date('2026-01-01T00:00:00.000Z'),
        credit_allowed: 0,
        created_by: toBin(root),
      })
      .execute();
    return id;
  }

  const sale = (id: string) =>
    db.selectFrom('sales_sales').selectAll().where('id', '=', toBin(id)).executeTakeFirstOrThrow();
  const paymentsOf = (saleId: string) =>
    db
      .selectFrom('sales_customer_payments as p')
      .innerJoin('sales_payment_allocations as a', 'a.payment_id', 'p.id')
      .selectAll('p')
      .where('a.sale_id', '=', toBin(saleId))
      .execute();
  const json = (value: unknown) =>
    (typeof value === 'string' ? JSON.parse(value) : value) as unknown;
  const conflictsOf = async (entityId: string, type: string) =>
    (
      await db
        .selectFrom('sync_sync_conflicts')
        .select(['status', 'resolution', 'resolution_refs', 'owner_role', 'applied', 'details'])
        .where('entity_id', '=', toBin(entityId))
        .where('conflict_type', '=', type)
        .execute()
    ).map((row) => ({
      ...row,
      details: json(row.details),
      resolution_refs: json(row.resolution_refs),
    }));
  const flagsOf = (row: { readonly flags: unknown }) =>
    (typeof row.flags === 'string' ? JSON.parse(row.flags) : row.flags) as string[];
  const session = (id: string) =>
    db
      .selectFrom('finance_cash_sessions')
      .selectAll()
      .where('id', '=', toBin(id))
      .executeTakeFirstOrThrow();
  const adjustmentsOf = (sessionId: string) =>
    db
      .selectFrom('finance_cash_session_adjustments')
      .selectAll()
      .where('session_id', '=', toBin(sessionId))
      .execute();

  beforeAll(async () => {
    clock = new FixedClock(new Date(at('22:00')));
    idGenerator = new Uuidv7Generator(clock);
    const registry = new CommandHandlerRegistry();
    const decisions = new ApprovalDecisionHandlerRegistry();
    const sequences = new DocumentSequenceService();
    registerRequestCommands(registry, decisions);
    registerSaleCommands(registry, idGenerator, sequences);
    registerCancelCommands(registry, decisions, idGenerator, sequences);
    registerPaymentCommands(registry, decisions, idGenerator, sequences);
    registerCashSessionCommands(registry, idGenerator, decisions);
    registerOrderCommands(registry, idGenerator, sequences);
    pipeline = new CommandPipelineService(db, registry, clock, idGenerator);
    services = { push: new SyncPushService(pipeline, db, clock), pull: new SyncPullService(db) };

    await tx(async (trx) => {
      root = await insertTestUser(trx);
      await insertTestDevice(trx, root, { status: 'ACTIVE' });
      zoneId = await insertTestZone(trx, root);
      for (const [code, name, isCount] of [['PIECE', 'Pièce', 1]] as const) {
        if (
          !(await trx
            .selectFrom('catalog_units')
            .select('code')
            .where('code', '=', code)
            .executeTakeFirst())
        ) {
          await trx.insertInto('catalog_units').values({ code, name, is_count: isCount }).execute();
        }
      }
      if (
        !(await trx
          .selectFrom('catalog_sales_channels')
          .select('code')
          .where('code', '=', 'POINT_DE_VENTE')
          .executeTakeFirst())
      ) {
        await trx
          .insertInto('catalog_sales_channels')
          .values({ code: 'POINT_DE_VENTE', name: 'Point de vente' })
          .execute();
      }
      for (const channel of ['DIRECT', 'SEDENTAIRE', 'TERRAIN']) {
        if (
          !(await trx
            .selectFrom('catalog_sales_channels')
            .select('code')
            .where('code', '=', channel)
            .executeTakeFirst())
        ) {
          await trx
            .insertInto('catalog_sales_channels')
            .values({ code: channel, name: channel })
            .execute();
        }
      }
      stepId = freshUuid();
      await trx
        .insertInto('crm_pipeline_steps')
        .values({
          id: toBin(stepId),
          code: `STEP_${stepId.slice(-8)}`,
          label: 'Nouveau',
          sort_order: 10,
          created_by: toBin(root),
        })
        .execute();
      sourceCode = `SRC_${freshUuid().slice(-8)}`;
      await trx
        .insertInto('crm_lead_sources')
        .values({
          id: toBin(freshUuid()),
          code: sourceCode,
          label: 'Kommo',
          created_by: toBin(root),
        })
        .execute();
      const categoryId = freshUuid();
      await trx
        .insertInto('catalog_product_categories')
        .values({
          id: toBin(categoryId),
          code: `CAT-${categoryId.slice(-8)}`,
          name: 'Œufs',
          created_by: toBin(root),
        })
        .execute();
      productId = freshUuid();
      await trx
        .insertInto('catalog_products')
        .values({
          id: toBin(productId),
          code: `PRD-${productId.slice(-10)}`,
          name: 'Plateau d’œufs',
          category_id: toBin(categoryId),
          stock_family: 'MARCHANDISE',
          base_unit_code: 'PIECE',
          pricing_mode: 'PER_UNIT',
          is_sellable: 1,
          created_by: toBin(root),
        })
        .execute();
      ruleId = freshUuid();
      await trx
        .insertInto('pricing_price_rules')
        .values({
          id: toBin(ruleId),
          code: `PR-${ruleId.slice(-12)}`,
          version: 1,
          product_id: toBin(productId),
          unit_price_xaf: PRICE,
          pricing_unit_code: 'PIECE',
          status: 'ACTIVE',
          valid_from: new Date('2026-01-01T00:00:00.000Z'),
          approved_by: toBin(root),
          approved_at: new Date('2026-01-01T00:00:00.000Z'),
          created_by: toBin(root),
        })
        .execute();
    });
    fin1 = await newActor('FINANCE', root);
    fin2 = await newActor('FINANCE', root);
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it('BR-DIS-005 : en ligne sans session ouverte, refus sans effet ; hors ligne, CASH_SESSION_MISSING résolu par une ouverture appliquée après coup', async () => {
    const pos = await newPos();
    const refusedId = freshUuid();
    const refused = await run(
      pos.seller,
      'sales.sale.record',
      'SALE',
      refusedId,
      at('09:00'),
      saleBody(pos, 2),
    );
    expect(codeOf(refused)).toBe('CASH_SESSION_REQUIRED');
    expect(
      await db
        .selectFrom('sales_sales')
        .select('id')
        .where('id', '=', toBin(refusedId))
        .executeTakeFirst(),
    ).toBeUndefined();

    // Hors ligne (tablette) : la vente est un fait accompli, jamais rejetée (BR-SYN-007).
    const tablet = new OfflineDevice(services, pos.seller.deviceId, clock);
    const offlineId = freshUuid();
    tablet.enqueue(pos.seller.userId, {
      type: 'sales.sale.record',
      aggregateType: 'SALE',
      aggregateId: offlineId,
      occurredAt: at('09:30'),
      payload: saleBody(pos, 3),
    });
    const [synced] = await tablet.sync(pos.seller.userId);
    expect(synced?.status, JSON.stringify(synced)).toBe('APPLIED_WITH_WARNINGS');
    expect(warningsOf(synced!)).toContain('CASH_SESSION_MISSING');
    const row = await sale(offlineId);
    expect(flagsOf(row)).toContain('CASH_SESSION_MISSING');
    expect(row.cash_session_id).toBeNull();
    const [payment] = await paymentsOf(offlineId);
    expect(payment!.cash_session_id).toBeNull();
    const paymentId = fromBin(payment!.id);
    const [conflict] = await conflictsOf(paymentId, 'CASH_SESSION_MISSING');
    expect(conflict).toMatchObject({ status: 'OPEN', owner_role: 'FINANCE', applied: 1 });
    expect(conflict!.details).toMatchObject({
      cashAccountId: pos.accountId,
      amountXaf: 1_500,
      saleId: offlineId,
    });

    // L'ouverture saisie hors ligne à 08:00 sur une autre tablette arrive après : elle couvre la vente
    // par le temps (ADR-032 §2) ; le conflit est résolu, l'index de la vente n'est pas réécrit.
    const sessionId = await openSession(pos, at('08:00'), 0, true);
    const [resolved] = await conflictsOf(paymentId, 'CASH_SESSION_MISSING');
    expect(resolved).toMatchObject({ status: 'RESOLVED', resolution: 'MERGE' });
    expect(resolved!.resolution_refs).toEqual([sessionId]);
    expect((await sale(offlineId)).cash_session_id).toBeNull();

    // Désormais en ligne : session ouverte, index posé sur l'encaissement et la vente.
    const onlineId = freshUuid();
    const online = await ok(
      pos.seller,
      'sales.sale.record',
      'SALE',
      onlineId,
      at('10:00'),
      saleBody(pos, 1),
    );
    expect(online.status).toBe('APPLIED');
    expect(fromBin((await sale(onlineId)).cash_session_id!)).toBe(sessionId);
    expect(fromBin((await paymentsOf(onlineId))[0]!.cash_session_id!)).toBe(sessionId);
    expect((await tx((trx) => verifyCashLedger(trx, { cashAccountIds: [pos.accountId] }))).ok).toBe(
      true,
    );
  });

  it('BR-VEN-028 : session ouverte → annulation directe et remboursement dans la session ; session close → demande CANCEL_SESSION_CLOSED', async () => {
    const pos = await newPos();
    const sessionId = await openSession(pos, at('08:00'));
    const kept = freshUuid();
    await ok(pos.seller, 'sales.sale.record', 'SALE', kept, at('09:00'), saleBody(pos, 2));
    const direct = await ok(
      pos.seller,
      'sales.sale.cancel',
      'SALE_CANCELLATION',
      freshUuid(),
      at('09:05'),
      {
        saleId: kept,
        comment: 'Erreur de produit',
        paymentTreatment: 'REFUND',
      },
    );
    expect(direct.status).toBe('APPLIED');
    expect((await sale(kept)).status).toBe('CANCELLED');
    // Remboursement en espèces : fait nouveau, daté de l'annulation, dans la session (AV-157, AV-186).
    const refund = await db
      .selectFrom('finance_cash_movements')
      .select(['movement_type', 'direction', 'amount_xaf', 'occurred_at', 'cash_session_id'])
      .where('cash_account_id', '=', toBin(pos.accountId))
      .where('movement_type', '=', 'REFUND')
      .executeTakeFirstOrThrow();
    expect(refund).toMatchObject({ direction: 'OUT' });
    expect(Number(refund.amount_xaf)).toBe(1_000);
    expect(refund.occurred_at.toISOString()).toBe(at('09:05'));
    expect(fromBin(refund.cash_session_id!)).toBe(sessionId);

    // Vente à 10:00, session close à 10:05 (comptage exact), annulation à 10:08 dans le délai : demande.
    const late = freshUuid();
    await ok(pos.seller, 'sales.sale.record', 'SALE', late, at('10:00'), saleBody(pos, 4));
    await ok(pos.seller, 'finance.cash_session.close', 'CASH_SESSION', sessionId, at('10:05'), {
      countedXaf: 2_000,
    });
    expect((await session(sessionId)).status).toBe('VALIDATED');
    const requested = await ok(
      pos.seller,
      'sales.sale.cancel',
      'SALE_CANCELLATION',
      freshUuid(),
      at('10:08'),
      {
        saleId: late,
        comment: 'Client parti',
        paymentTreatment: 'REFUND',
      },
    );
    expect(warningsOf(requested)).toEqual(['CANCEL_SESSION_CLOSED']);
    expect((await sale(late)).status).toBe('CANCELLATION_REQUESTED');
  });

  it('AV-157 (a) : l’inverse d’un encaissement annulé porte la date de l’original et réévalue sa session close (REVERSAL)', async () => {
    const pos = await newPos();
    const sessionId = await openSession(pos, at('08:00'));
    const saleId = freshUuid();
    await ok(pos.seller, 'sales.sale.record', 'SALE', saleId, at('09:00'), {
      ...saleBody(pos, 6),
      customerId: await newCustomer(),
    });
    const [payment] = await paymentsOf(saleId);
    const paymentId = fromBin(payment!.id);
    await ok(pos.seller, 'finance.cash_session.close', 'CASH_SESSION', sessionId, at('12:00'), {
      countedXaf: 3_000,
    });
    expect((await session(sessionId)).status).toBe('VALIDATED');

    await ok(
      pos.seller,
      'sales.payment.request_cancellation',
      'CUSTOMER_PAYMENT',
      paymentId,
      at('13:00'),
      {
        comment: 'Encaissement saisi deux fois',
      },
    );
    const request = await db
      .selectFrom('approvals_approval_requests')
      .select('id')
      .where('subject_id', '=', toBin(paymentId))
      .where('operation_type', '=', 'PAYMENT_CANCELLATION')
      .executeTakeFirstOrThrow();
    await ok(
      fin1,
      'approvals.request.approve',
      'APPROVAL_REQUEST',
      fromBin(request.id),
      at('14:00'),
      {
        requestId: fromBin(request.id),
      },
    );
    const inverse = await db
      .selectFrom('finance_cash_movements')
      .select(['occurred_at', 'is_reversal', 'cash_session_id'])
      .where('source_doc_id', '=', toBin(paymentId))
      .where('is_reversal', '=', 1)
      .executeTakeFirstOrThrow();
    expect(inverse.occurred_at.toISOString()).toBe(at('09:00'));
    expect(fromBin(inverse.cash_session_id!)).toBe(sessionId);
    const [adjustment] = await adjustmentsOf(sessionId);
    expect(adjustment).toMatchObject({ cause: 'REVERSAL', treatment: 'OWN_APPROVAL' });
    expect(Number(adjustment!.delta_xaf)).toBe(3_000);
    const check = await tx((trx) => verifyCashSessionVariance(trx, sessionId));
    expect(check).toMatchObject({ ok: true, countedMinusExpectedXaf: 3_000 });
    // La vente a un client (AV-188 : l'encaissement d'une vente anonyme saisie en ligne ne s'annule pas) :
    // l'annulation rouvre sa créance.
    expect(Number((await sale(saleId)).balance_due_xaf)).toBe(3_000);
  });

  it('AV-188 (a) : l’encaissement d’une vente sans client saisie en ligne ne s’annule pas (INV-VEN-07)', async () => {
    const pos = await newPos();
    await openSession(pos, at('08:00'));
    const saleId = freshUuid();
    await ok(pos.seller, 'sales.sale.record', 'SALE', saleId, at('09:00'), saleBody(pos, 2));
    const [payment] = await paymentsOf(saleId);
    const refused = await run(
      pos.seller,
      'sales.payment.request_cancellation',
      'CUSTOMER_PAYMENT',
      fromBin(payment!.id),
      at('10:00'),
      { comment: 'Encaissement saisi deux fois' },
    );
    expect(refused.status).toBe('REJECTED');
    expect(refused.error?.code).toBe('PAYMENT_ANONYMOUS_SALE');
    expect((await paymentRow(fromBin(payment!.id)))?.status).toBe('RECORDED');
  });

  it('BR-DIS-005, encaissement hors vente (sales.payment.record) : refus en ligne, CASH_SESSION_MISSING hors ligne sans document, index avec session ; un encaissement antérieur à l’ouverture reste à traiter', async () => {
    const pos = await newPos();
    const s1 = freshUuid();
    const s2 = freshUuid();
    await ok(
      pos.seller,
      'sales.sale.record',
      'SALE',
      s1,
      at('09:00'),
      unpaidSaleBody(pos, 2),
      true,
    );
    await ok(
      pos.seller,
      'sales.sale.record',
      'SALE',
      s2,
      at('09:05'),
      unpaidSaleBody(pos, 2),
      true,
    );

    const refused = await payAnonymousSale(pos, s1, 1_000, at('09:10'));
    expect(codeOf(refused.result)).toBe('CASH_SESSION_REQUIRED');
    expect(await paymentRow(refused.id)).toBeUndefined();

    const offline = await payAnonymousSale(pos, s1, 1_000, at('09:20'), true);
    expect(offline.result.status, JSON.stringify(offline.result)).toBe('APPLIED_WITH_WARNINGS');
    expect(warningsOf(offline.result)).toContain('CASH_SESSION_MISSING');
    expect((await paymentRow(offline.id))!.cash_session_id).toBeNull();
    const [conflict] = await conflictsOf(offline.id, 'CASH_SESSION_MISSING');
    expect(conflict).toMatchObject({ status: 'OPEN', owner_role: 'FINANCE', applied: 1 });
    expect(conflict!.details).toMatchObject({ cashAccountId: pos.accountId, amountXaf: 1_000 });
    expect(conflict!.details).not.toHaveProperty('saleId');
    expect(conflict!.details).not.toHaveProperty('orderId');

    // Ouverture à 10:00 (fonds = registre : l'encaissement de 09:20 y est) : elle ne couvre pas 09:20.
    const sessionId = await openSession(pos, at('10:00'), 1_000);
    expect((await conflictsOf(offline.id, 'CASH_SESSION_MISSING'))[0]).toMatchObject({
      status: 'OPEN',
    });
    const covered = await payAnonymousSale(pos, s2, 1_000, at('10:30'));
    expect(covered.result.status, JSON.stringify(covered.result)).toBe('APPLIED');
    expect(fromBin((await paymentRow(covered.id))!.cash_session_id!)).toBe(sessionId);
    expect(await conflictsOf(covered.id, 'CASH_SESSION_MISSING')).toEqual([]);
  });

  it('BR-DIS-005, acompte d’une commande (sales.order.place) : refus en ligne, CASH_SESSION_MISSING hors ligne avec la commande, index avec session ; la vente issue de la commande n’a pas d’index', async () => {
    const pos = await newPos();
    const commercial = await newActor('COMMERCIAL_SEDENTAIRE', root);
    const customerId = await newCustomer();
    const place = async (occurredAt: string, offline = false) => {
      const id = freshUuid();
      const result = await run(
        commercial,
        'sales.order.place',
        'SALES_ORDER',
        id,
        occurredAt,
        {
          customerId,
          fulfilmentLocationId: pos.counterId,
          lines: [line(2)],
          advancePayments: [
            { methodCode: 'ESPECES', amountXaf: 1_000, cashAccountId: pos.accountId },
          ],
        },
        offline,
      );
      return { id, result };
    };
    const advanceOf = (orderId: string) =>
      db
        .selectFrom('sales_customer_payments as p')
        .innerJoin('sales_payment_allocations as a', 'a.payment_id', 'p.id')
        .leftJoin('sales_sales as s', 's.id', 'a.sale_id')
        .select(['p.id', 'p.cash_session_id'])
        .where((eb) =>
          eb.or([eb('a.order_id', '=', toBin(orderId)), eb('s.order_id', '=', toBin(orderId))]),
        )
        .executeTakeFirst();

    const refused = await place(at('09:00'));
    expect(codeOf(refused.result)).toBe('CASH_SESSION_REQUIRED');
    expect(
      await db
        .selectFrom('sales_sales_orders')
        .select('id')
        .where('id', '=', toBin(refused.id))
        .executeTakeFirst(),
    ).toBeUndefined();

    const offline = await place(at('09:10'), true);
    expect(offline.result.status, JSON.stringify(offline.result)).toBe('APPLIED_WITH_WARNINGS');
    expect(warningsOf(offline.result)).toContain('CASH_SESSION_MISSING');
    const offlineAdvance = await advanceOf(offline.id);
    expect(offlineAdvance!.cash_session_id).toBeNull();
    const [conflict] = await conflictsOf(fromBin(offlineAdvance!.id), 'CASH_SESSION_MISSING');
    expect(conflict).toMatchObject({ status: 'OPEN', owner_role: 'FINANCE' });
    expect(conflict!.details).toMatchObject({ orderId: offline.id, amountXaf: 1_000 });

    const sessionId = await openSession(pos, at('10:00'), 1_000);
    const online = await place(at('10:30'));
    expect(online.result.status, JSON.stringify(online.result)).toMatch(/^APPLIED/);
    expect(warningsOf(online.result)).not.toContain('CASH_SESSION_MISSING');
    expect(fromBin((await advanceOf(online.id))!.cash_session_id!)).toBe(sessionId);
    // L'index de la vente n'est posé que par la vente directe (la vente sur commande lit ses affectations).
    const [orderSale] = await db
      .selectFrom('sales_sales')
      .select(['cash_session_id'])
      .where('order_id', '=', toBin(online.id))
      .execute();
    expect(orderSale?.cash_session_id ?? null).toBeNull();
  });

  it('BR-VEN-028 : encaissement sans session, vente sans espèces au PDV, session ouverte après l’annulation, encaissement en demande d’annulation ; décision après la clôture (AV-186)', async () => {
    const pos = await newPos();
    // (a) Vente en espèces hors ligne sans session : l'annulation dans le délai devient une demande.
    const saleA = freshUuid();
    await ok(pos.seller, 'sales.sale.record', 'SALE', saleA, at('08:00'), saleBody(pos, 2), true);
    const cancelAId = freshUuid();
    const cancelA = await ok(
      pos.seller,
      'sales.sale.cancel',
      'SALE_CANCELLATION',
      cancelAId,
      at('08:05'),
      {
        saleId: saleA,
        comment: 'Erreur de saisie',
        paymentTreatment: 'REFUND',
      },
    );
    expect(warningsOf(cancelA)).toEqual(['CANCEL_SESSION_CLOSED']);
    expect((await sale(saleA)).status).toBe('CANCELLATION_REQUESTED');

    // (c) Vente réglée par mobile money, sans aucune session : condition remplie, annulation directe.
    const saleB = freshUuid();
    await ok(pos.seller, 'sales.sale.record', 'SALE', saleB, at('08:10'), momoSaleBody(pos, 1));
    const cancelB = await ok(
      pos.seller,
      'sales.sale.cancel',
      'SALE_CANCELLATION',
      freshUuid(),
      at('08:12'),
      {
        saleId: saleB,
        comment: 'Client parti',
        paymentTreatment: 'REFUND',
      },
    );
    expect(cancelB.status).toBe('APPLIED');
    expect((await sale(saleB)).status).toBe('CANCELLED');

    // Session ouverte à 09:11 (fonds = registre : 1 000 de la vente A).
    const sessionId = await openSession(pos, at('09:11'), 1_000);
    // Session ouverte après l'heure de l'annulation : vente anonyme hors ligne de 09:00, réglée à 09:12,
    // annulation saisie hors ligne à 09:10 (dans le délai) → demande (le remboursement de 09:10 tomberait
    // hors de la session qui a reçu l'argent).
    const saleC = freshUuid();
    await ok(
      pos.seller,
      'sales.sale.record',
      'SALE',
      saleC,
      at('09:00'),
      unpaidSaleBody(pos, 2),
      true,
    );
    const payC = await payAnonymousSale(pos, saleC, 1_000, at('09:12'));
    expect(payC.result.status, JSON.stringify(payC.result)).toBe('APPLIED');
    const cancelC = await ok(
      pos.seller,
      'sales.sale.cancel',
      'SALE_CANCELLATION',
      freshUuid(),
      at('09:10'),
      { saleId: saleC, comment: 'Doublon de saisie', paymentTreatment: 'REFUND' },
      true,
    );
    expect(warningsOf(cancelC)).toEqual(['CANCEL_SESSION_CLOSED']);
    expect((await sale(saleC)).status).toBe('CANCELLATION_REQUESTED');

    // Encaissement en demande d'annulation : son argent est encore au registre ; session close entre-temps.
    // Vente avec un client : l'encaissement d'une vente anonyme saisie en ligne ne s'annule pas (AV-188).
    const saleD = freshUuid();
    await ok(pos.seller, 'sales.sale.record', 'SALE', saleD, at('09:30'), {
      ...saleBody(pos, 2),
      customerId: await newCustomer(),
    });
    const [paymentD] = await paymentsOf(saleD);
    await ok(
      pos.seller,
      'sales.payment.request_cancellation',
      'CUSTOMER_PAYMENT',
      fromBin(paymentD!.id),
      at('09:31'),
      { comment: 'Montant à vérifier' },
    );
    // Attendu : 1 000 (fonds) + 1 000 (C) + 1 000 (D) = 3 000 ; comptage exact, validée d'office.
    await ok(pos.seller, 'finance.cash_session.close', 'CASH_SESSION', sessionId, at('09:35'), {
      countedXaf: 3_000,
    });
    expect((await session(sessionId)).status).toBe('VALIDATED');
    const cancelD = await ok(
      pos.seller,
      'sales.sale.cancel',
      'SALE_CANCELLATION',
      freshUuid(),
      at('09:40'),
      {
        saleId: saleD,
        comment: 'Client mécontent',
        paymentTreatment: 'REFUND',
      },
    );
    expect(warningsOf(cancelD)).toEqual(['CANCEL_SESSION_CLOSED']);
    expect((await sale(saleD)).status).toBe('CANCELLATION_REQUESTED');

    // AV-186 : la Finance approuve la demande de la vente A après la clôture, avec remboursement : jamais
    // refusé faute de session ; remboursement daté de la décision, hors de toute session.
    const requestA = await db
      .selectFrom('approvals_approval_requests')
      .select('id')
      .where('subject_id', '=', toBin(cancelAId))
      .where('operation_type', '=', 'SALE_CANCELLATION')
      .executeTakeFirstOrThrow();
    const approved = await ok(
      fin1,
      'approvals.request.approve',
      'APPROVAL_REQUEST',
      fromBin(requestA.id),
      at('10:00'),
      {
        requestId: fromBin(requestA.id),
        decisionOption: 'REFUND',
      },
    );
    expect(approved.status).toBe('APPLIED');
    expect((await sale(saleA)).status).toBe('CANCELLED');
    const refunds = await db
      .selectFrom('finance_cash_movements')
      .select(['occurred_at', 'cash_session_id', 'amount_xaf'])
      .where('cash_account_id', '=', toBin(pos.accountId))
      .where('movement_type', '=', 'REFUND')
      .execute();
    expect(refunds).toHaveLength(1);
    expect(refunds[0]!.occurred_at.toISOString()).toBe(at('10:00'));
    expect(refunds[0]!.cash_session_id).toBeNull();
    expect(
      (await tx((trx) => verifyCashLedger(trx, { cashAccountIds: [pos.accountId, pos.momoId] })))
        .ok,
    ).toBe(true);
  });

  it('décision PAYMENT_DUPLICATE d’un encaissement joint à une vente : la cible mémorisée est réglée (D09 §15, P5-23)', async () => {
    const pos = await newPos();
    const reference = `OM-DUP-${freshUuid().slice(-12)}`;
    const withReference = (quantity: number) => ({
      fromLocationId: pos.counterId,
      lines: [line(quantity)],
      payments: [
        {
          methodCode: 'MOBILE_MONEY_ORANGE',
          amountXaf: quantity * PRICE,
          reference,
          cashAccountId: pos.momoId,
        },
      ],
    });
    await ok(pos.seller, 'sales.sale.record', 'SALE', freshUuid(), at('09:00'), withReference(2));
    // Hors ligne, une seconde vente anonyme porte la même référence : son encaissement est mis de côté.
    const second = freshUuid();
    const recorded = await ok(
      pos.seller,
      'sales.sale.record',
      'SALE',
      second,
      at('09:05'),
      withReference(2),
      true,
    );
    expect(warningsOf(recorded)).toContain('PAYMENT_SUSPECT_DUPLICATE');
    // Mis de côté, sans affectation : retrouvé par sa cible mémorisée.
    const [suspect] = await db
      .selectFrom('sales_customer_payments')
      .selectAll()
      .where('intended_sale_id', '=', toBin(second))
      .execute();
    expect(suspect?.status).toBe('SUSPECT_DUPLICATE');
    expect(Number((await sale(second)).balance_due_xaf)).toBe(1_000);
    const request = await db
      .selectFrom('approvals_approval_requests')
      .select('id')
      .where('subject_id', '=', suspect!.id)
      .where('operation_type', '=', 'PAYMENT_DUPLICATE')
      .executeTakeFirstOrThrow();
    // Deux paiements distincts : la Finance corrige la référence du second. Avant : affectation
    // automatique aux ventes ouvertes d'un client absent, refus `ALLOCATION_EXCEEDS`.
    await ok(
      fin1,
      'approvals.request.approve',
      'APPROVAL_REQUEST',
      fromBin(request.id),
      at('09:20'),
      {
        requestId: fromBin(request.id),
        decisionData: { correctedReference: `${reference}-B` },
      },
    );
    expect((await paymentRow(fromBin(suspect!.id)))?.status).toBe('RECORDED');
    expect(Number((await sale(second)).balance_due_xaf)).toBe(0);
  });

  it('AV-184 : un doublon suspect d’espèces au PDV, approuvé par la Finance, reçoit l’index de session de son mouvement', async () => {
    const pos = await newPos();
    const sessionId = await openSession(pos, at('08:00'));
    // Deux ventes anonymes hors ligne impayées, réglées chacune par un encaissement hors vente portant
    // la même référence (saisie erronée) : le second est mis de côté (`SUSPECT_DUPLICATE`, sans
    // mouvement). Encaissement hors vente : la décision rejoue ses affectations explicites.
    const first = freshUuid();
    const second = freshUuid();
    await ok(
      pos.seller,
      'sales.sale.record',
      'SALE',
      first,
      at('09:00'),
      unpaidSaleBody(pos, 2),
      true,
    );
    await ok(
      pos.seller,
      'sales.sale.record',
      'SALE',
      second,
      at('09:01'),
      unpaidSaleBody(pos, 2),
      true,
    );
    const reference = `DUP-${freshUuid().slice(-12)}`;
    const cash = { methodCode: 'ESPECES', cashAccountId: pos.accountId, reference };
    const paid = await payAnonymousSale(pos, first, 1_000, at('09:10'), false, cash);
    expect(paid.result.status, JSON.stringify(paid.result)).toBe('APPLIED');
    const suspect = await payAnonymousSale(pos, second, 1_000, at('09:15'), false, cash);
    expect(warningsOf(suspect.result)).toContain('PAYMENT_SUSPECT_DUPLICATE');
    expect(await paymentRow(suspect.id)).toMatchObject({
      status: 'SUSPECT_DUPLICATE',
      cash_session_id: null,
      cash_movement_id: null,
    });
    const request = await db
      .selectFrom('approvals_approval_requests')
      .select('id')
      .where('subject_id', '=', toBin(suspect.id))
      .where('operation_type', '=', 'PAYMENT_DUPLICATE')
      .executeTakeFirstOrThrow();
    await ok(
      fin1,
      'approvals.request.approve',
      'APPROVAL_REQUEST',
      fromBin(request.id),
      at('09:20'),
      {
        requestId: fromBin(request.id),
        // Deux encaissements distincts mal référencés : la Finance corrige la référence du second.
        decisionData: { correctedReference: `${reference}-B` },
      },
    );
    const accepted = (await paymentRow(suspect.id))!;
    expect(accepted.status).toBe('RECORDED');
    expect(fromBin(accepted.cash_session_id!)).toBe(sessionId);
    const movement = await db
      .selectFrom('finance_cash_movements')
      .select('cash_session_id')
      .where('id', '=', accepted.cash_movement_id!)
      .executeTakeFirstOrThrow();
    expect(fromBin(movement.cash_session_id!)).toBe(sessionId);
    expect(Number((await sale(second)).balance_due_xaf)).toBe(0);
  });

  it('AT-031 : vente hors ligne tardive dans une session validée — pas de CASH_SESSION_MISSING, delta à demande propre, INV-FIN-05, INV-FIN-11 ; sous-totaux par vendeur', async () => {
    const pos = await newPos();
    const sessionId = await openSession(pos, at('08:00'));
    await ok(pos.seller, 'sales.sale.record', 'SALE', freshUuid(), at('09:00'), saleBody(pos, 2));
    const closed = await ok(
      pos.seller,
      'finance.cash_session.close',
      'CASH_SESSION',
      sessionId,
      at('18:00'),
      {
        countedXaf: 500,
      },
    );
    expect(closed.status === 'APPLIED' ? closed.server_refs : undefined).toMatchObject({
      varianceXaf: '-500',
      status: 'PENDING_VALIDATION',
    });
    await ok(fin1, 'finance.cash_session.validate', 'CASH_SESSION', sessionId, at('18:30'), {
      reason: 'Manque de 500',
    });
    const frozen = await session(sessionId);
    expect(frozen.status).toBe('VALIDATED');

    // Le second vendeur a vendu hors ligne à 12:00 ; sa tablette se synchronise à 20:00.
    const tablet = new OfflineDevice(services, pos.seller2.deviceId, clock);
    const lateId = freshUuid();
    tablet.enqueue(pos.seller2.userId, {
      type: 'sales.sale.record',
      aggregateType: 'SALE',
      aggregateId: lateId,
      occurredAt: at('12:00'),
      payload: saleBody(pos, 4),
    });
    const [synced] = await tablet.sync(pos.seller2.userId);
    expect(synced?.status, JSON.stringify(synced)).toMatch(/^APPLIED/);
    expect(warningsOf(synced!)).not.toContain('CASH_SESSION_MISSING');
    // La vente appartient, par le temps, à la session close : son index la désigne.
    expect(fromBin((await sale(lateId)).cash_session_id!)).toBe(sessionId);

    const [adjustment] = await adjustmentsOf(sessionId);
    expect(adjustment).toMatchObject({
      cause: 'LATE_OPERATION',
      treatment: 'OWN_APPROVAL',
      status: 'PENDING',
    });
    expect(Number(adjustment!.delta_xaf)).toBe(-2_000);
    expect(Number(adjustment!.variance_before_xaf)).toBe(-500);
    expect(Number(adjustment!.variance_after_xaf)).toBe(-2_500);
    const reevaluated = await db
      .selectFrom('sync_sync_conflicts')
      .select('status')
      .where('conflict_type', '=', 'CASH_SESSION_REEVALUATED')
      .where('entity_id', '=', toBin(sessionId))
      .execute();
    expect(reevaluated).toHaveLength(1);
    // INV-FIN-05 : la session validée n'a pas changé ; INV-FIN-11 sur le registre.
    expect(await session(sessionId)).toEqual(frozen);
    const check = await tx((trx) => verifyCashSessionVariance(trx, sessionId));
    expect(check).toMatchObject({ ok: true, countedMinusExpectedXaf: -2_500 });
    // L'ajustement se valide par la même façade, par une autre personne de la Finance.
    await ok(
      fin2,
      'finance.cash_session.validate',
      'CASH_SESSION',
      fromBin(adjustment!.id),
      at('21:00'),
      {
        reason: 'Vente hors ligne tardive du second vendeur',
      },
    );
    expect((await adjustmentsOf(sessionId))[0]).toMatchObject({ status: 'VALIDATED' });

    // Sous-totaux par vendeur (AV-155, AV-187), composés dans la couche de transport.
    const subtotals = await cashSessionSellerSubtotals(db, sessionId);
    expect(subtotals).toMatchObject({
      sessionId,
      status: 'VALIDATED',
      openingCountedXaf: 0,
      unattributedReceivedXaf: 0,
      netFlowsXaf: 3_000,
      expectedNowXaf: 3_000,
    });
    expect(subtotals!.sellers).toEqual([
      { userId: pos.seller2.userId, receivedXaf: 2_000, paymentsCount: 1 },
      { userId: pos.seller.userId, receivedXaf: 1_000, paymentsCount: 1 },
    ]);
    expect(subtotals!.otherMovements).toEqual([]);
  });

  it('P5-23 (revue adverse) : décision SALE_CANCELLATION avec remboursement sur une caisse vide — refus CASH_INSUFFICIENT sans effet, la demande reste à décider', async () => {
    const pos = await newPos();
    const sessionId = await openSession(pos, at('08:00'));
    const saleId = freshUuid();
    await ok(pos.seller, 'sales.sale.record', 'SALE', saleId, at('09:00'), saleBody(pos, 2));
    // Clôture comptée à 0 : l'écart (−1 000) est porté au registre, la caisse est vide.
    await ok(pos.seller, 'finance.cash_session.close', 'CASH_SESSION', sessionId, at('12:00'), {
      countedXaf: 0,
    });
    const cancellationId = freshUuid();
    const requested = await ok(
      pos.seller,
      'sales.sale.cancel',
      'SALE_CANCELLATION',
      cancellationId,
      at('12:30'),
      { saleId, comment: 'Client mécontent', paymentTreatment: 'REFUND' },
    );
    expect(warningsOf(requested)).toContain('CANCEL_WINDOW_EXCEEDED');
    const request = await db
      .selectFrom('approvals_approval_requests')
      .select('id')
      .where('subject_id', '=', toBin(cancellationId))
      .where('operation_type', '=', 'SALE_CANCELLATION')
      .executeTakeFirstOrThrow();
    const decided = await run(
      fin1,
      'approvals.request.approve',
      'APPROVAL_REQUEST',
      fromBin(request.id),
      at('13:00'),
      { requestId: fromBin(request.id), decisionOption: 'REFUND' },
    );
    // Avant : `CashMovementError` levée telle quelle, prise pour une erreur transitoire (`RETRY_LATER`).
    expect(decided.status).toBe('REJECTED');
    expect(decided.error?.code).toBe('CASH_INSUFFICIENT');
    const pending = await db
      .selectFrom('approvals_approval_requests')
      .select('status')
      .where('id', '=', request.id)
      .executeTakeFirstOrThrow();
    expect(pending.status).toBe('PENDING');
    expect((await sale(saleId)).status).toBe('CANCELLATION_REQUESTED');
  });

  it('P5-23 (revue adverse) : le valideur d’une session n’est pas l’auteur d’un ajustement inclus dans sa validation (D05 §15)', async () => {
    const pos = await newPos();
    const sessionId = await openSession(pos, at('08:00'));
    const saleId = freshUuid();
    await ok(pos.seller, 'sales.sale.record', 'SALE', saleId, at('09:00'), {
      ...saleBody(pos, 6),
      customerId: await newCustomer(),
    });
    const [payment] = await paymentsOf(saleId);
    const paymentId = fromBin(payment!.id);
    // Écart à la clôture : la session attend sa validation.
    await ok(pos.seller, 'finance.cash_session.close', 'CASH_SESSION', sessionId, at('12:00'), {
      countedXaf: 2_900,
    });
    expect((await session(sessionId)).status).toBe('PENDING_VALIDATION');
    // fin1 décide l'annulation de l'encaissement : l'inverse, daté de l'original, tombe dans la session
    // et y crée un ajustement inclus dans sa validation, dont fin1 est l'auteur.
    await ok(
      pos.seller,
      'sales.payment.request_cancellation',
      'CUSTOMER_PAYMENT',
      paymentId,
      at('13:00'),
      { comment: 'Encaissement saisi deux fois' },
    );
    const request = await db
      .selectFrom('approvals_approval_requests')
      .select('id')
      .where('subject_id', '=', toBin(paymentId))
      .where('operation_type', '=', 'PAYMENT_CANCELLATION')
      .executeTakeFirstOrThrow();
    await ok(
      fin1,
      'approvals.request.approve',
      'APPROVAL_REQUEST',
      fromBin(request.id),
      at('14:00'),
      {
        requestId: fromBin(request.id),
      },
    );
    const [adjustment] = await adjustmentsOf(sessionId);
    expect(adjustment).toMatchObject({ treatment: 'INCLUDED_IN_VALIDATION', status: 'PENDING' });
    expect(fromBin(adjustment!.created_by)).toBe(fin1.userId);

    const byAuthor = await run(
      fin1,
      'finance.cash_session.validate',
      'CASH_SESSION',
      sessionId,
      at('15:00'),
      {
        reason: 'Écart et annulation d’encaissement',
      },
    );
    expect(byAuthor.status).toBe('REJECTED');
    expect(byAuthor.error?.code).toBe('CASH_VALIDATOR_INVOLVED');
    await ok(fin2, 'finance.cash_session.validate', 'CASH_SESSION', sessionId, at('15:10'), {
      reason: 'Écart et annulation d’encaissement',
    });
    expect((await session(sessionId)).status).toBe('VALIDATED');
  });
});
