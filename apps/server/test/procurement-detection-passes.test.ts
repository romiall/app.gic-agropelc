/**
 * P9-09 : passes planifiées de `procurement` — `procurement.orders.receipt_incomplete_check`
 * (`RECEIPT_INCOMPLETE`, BR-APP-015, AV-360, AV-414) et `procurement.receipts.attachment_missing_check`
 * (`ATTACHMENT_MISSING` des réceptions, BR-APP-014, AV-357, AV-399, AV-417). Les passes lisent la base
 * partagée : horloge dans le passé lointain, transactions annulées, bons et réceptions insérés
 * directement ; la liste des bons ouverts est restreinte aux bons du cas (lecture simulée).
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/modules/organization/application/public/index.js', async (importActual) => {
  const actual = (await importActual()) as {
    currentSettingValue: (...args: unknown[]) => Promise<unknown>;
  };
  return { ...actual, currentSettingValue: vi.fn(actual.currentSettingValue) };
});
vi.mock('../src/modules/procurement/application/receipt-alert-events.js', async (importActual) => {
  const actual = (await importActual()) as {
    listOpenOrderIds: (...args: unknown[]) => Promise<readonly string[]>;
  };
  return { ...actual, listOpenOrderIds: vi.fn(actual.listOpenOrderIds) };
});

import { FixedClock, Uuidv7Generator } from '@gic/domain';
import { JobHandlerRegistry } from '../src/platform/jobs/job-handler-registry.js';
import {
  RECEIPT_INCOMPLETE_JOB_TYPE,
  ReceiptIncompleteJob,
} from '../src/modules/procurement/application/jobs/receipt-incomplete-job.js';
import {
  RECEIPT_ATTACHMENT_MISSING_JOB_TYPE,
  ReceiptAttachmentMissingJob,
} from '../src/modules/procurement/application/jobs/receipt-attachment-missing-job.js';
import {
  PROCUREMENT_RECURRING_JOBS,
  ProcurementRecurringJobs,
} from '../src/modules/procurement/application/jobs/procurement-recurring-jobs.js';
import { RecurringJobRegistry } from '../src/platform/jobs/recurring-job-registry.js';
import { listOpenOrderIds } from '../src/modules/procurement/application/receipt-alert-events.js';
import type * as ReceiptAlertEvents from '../src/modules/procurement/application/receipt-alert-events.js';
import { currentSettingValue } from '../src/modules/organization/application/public/index.js';
import { publishPassCompleted } from '../src/platform/events/detection-events.js';
import { toDomainEvent } from '../src/platform/events/domain-event.js';
import { handleAlertEvent } from '../src/modules/communication/application/events/alerts-consumer.js';
import { toBin } from '../src/platform/kysely/uuid-columns.js';
import type { UnitOfWork } from '../src/platform/unit-of-work.js';
import { rolledBack } from './communication-test-kit.js';
import {
  closeTestDb,
  freshUuid,
  insertTestLocation,
  insertTestProduct,
  insertTestSite,
  insertTestUser,
  insertTestZone,
} from './helpers.js';

vi.setConfig({ testTimeout: 120_000 });

afterAll(closeTestDb);

/** 07:15 à Douala le mardi 12 mars 2019. */
const NOW = new Date('2019-03-12T06:15:00.000Z');
const SLOT = NOW.toISOString();
const TODAY = '2019-03-12';
const DAY_MS = 86_400_000;
const clock = new FixedClock(NOW);
const idGenerator = new Uuidv7Generator(clock);

const settingsOverride = new Map<string, unknown>();
beforeEach(() => {
  settingsOverride.clear();
  vi.mocked(currentSettingValue).mockImplementation(async (_executor, input) => {
    const { key, at } = input as { key: string; at: Date };
    const value = settingsOverride.get(key);
    // Une valeur fonction est un réglage historisé : elle reçoit l'instant de lecture.
    return typeof value === 'function' ? (value as (at: Date) => unknown)(at) : value;
  });
  vi.mocked(listOpenOrderIds).mockClear();
});

function incompleteRunner() {
  const registry = new JobHandlerRegistry();
  new ReceiptIncompleteJob(clock, idGenerator, registry).onModuleInit();
  return registry.resolve(RECEIPT_INCOMPLETE_JOB_TYPE)!;
}

function attachmentRunner() {
  const registry = new JobHandlerRegistry();
  new ReceiptAttachmentMissingJob(clock, idGenerator, registry).onModuleInit();
  return registry.resolve(RECEIPT_ATTACHMENT_MISSING_JOB_TYPE)!;
}

async function world(uow: UnitOfWork) {
  const admin = await insertTestUser(uow);
  const zone = await insertTestZone(uow, admin);
  const site = await insertTestSite(uow, admin, zone);
  const store = await insertTestLocation(uow, admin, site, { locationType: 'STORE' });
  const product = await insertTestProduct(uow, admin);
  const supplier = freshUuid();
  await uow
    .insertInto('procurement_suppliers')
    .values({
      id: toBin(supplier),
      code: `F-${supplier.slice(-10)}`,
      name: 'Couvoir du Wouri',
      supplied_categories: JSON.stringify([]),
      status: 'ACTIVE',
      created_by: toBin(admin),
    })
    .execute();
  const receiver = await insertTestUser(uow);
  // Une quantité rejetée exige un motif de rejet (`ck_procurement_goods_receipt_lines_rejection`).
  const rejectionReason = freshUuid();
  await uow
    .insertInto('catalog_reason_codes')
    .values({
      id: toBin(rejectionReason),
      code: `REJ-${rejectionReason.slice(-8)}`,
      category: 'REJECTION',
      label: 'Sacs déchirés',
      created_by: toBin(admin),
    })
    .execute();

  /** Bon de commande à une ligne ; `accepted` et `closed` en unités de base. */
  async function purchaseOrder(options: {
    readonly expected: string | null;
    readonly status?: string;
    readonly ordered?: number;
    readonly accepted?: number;
    readonly closed?: number;
  }): Promise<{ id: string; lineId: string; docNumber: string }> {
    const id = freshUuid();
    const lineId = freshUuid();
    const docNumber = `BC-T-${id.slice(-10)}`;
    await uow
      .insertInto('procurement_purchase_orders')
      .values({
        id: toBin(id),
        doc_number: docNumber,
        site_id: toBin(site),
        supplier_id: toBin(supplier),
        delivery_location_id: toBin(store),
        expected_delivery_date:
          options.expected === null ? null : new Date(`${options.expected}T00:00:00.000Z`),
        status: options.status ?? 'SENT',
        sent_at: new Date('2019-03-01T09:00:00.000Z'),
        total_xaf: 10_000,
        occurred_at: new Date('2019-03-01T08:00:00.000Z'),
        created_by: toBin(admin),
      })
      .execute();
    await uow
      .insertInto('procurement_purchase_order_lines')
      .values({
        id: toBin(lineId),
        order_id: toBin(id),
        line_no: 1,
        product_id: toBin(product),
        unit_code: 'TETE',
        ordered_qty_base: String(options.ordered ?? 100),
        accepted_qty_base: String(options.accepted ?? 0),
        closed_qty_base: String(options.closed ?? 0),
        unit_price_xaf: 100,
        line_total_xaf: 10_000,
      })
      .execute();
    return { id, lineId, docNumber };
  }

  /** Réception d'un BC (ou sans BC), reçue par le serveur `daysAgo` jours avant `NOW`. */
  async function receipt(options: {
    readonly orderId?: string | null;
    readonly lineId?: string;
    readonly status?: string;
    readonly rejected?: number;
    readonly valueXaf?: number;
    readonly receivedDaysAgo?: number;
    /** Réception hors ligne : le fait date de plus tôt que son arrivée au serveur. */
    readonly occurredDaysAgo?: number;
    /** `received_at_server` absent : le délai se compte depuis la création (`created_at`). */
    readonly serverReceiptUnknown?: boolean;
  }): Promise<{ id: string; docNumber: string }> {
    const id = freshUuid();
    const docNumber = `REC-T-${id.slice(-10)}`;
    const receivedAt = new Date(NOW.getTime() - (options.receivedDaysAgo ?? 0) * DAY_MS);
    const status = options.status ?? 'POSTED';
    await uow
      .insertInto('procurement_goods_receipts')
      .values({
        id: toBin(id),
        doc_number: docNumber,
        site_id: toBin(site),
        purchase_order_id:
          options.orderId === undefined || options.orderId === null ? null : toBin(options.orderId),
        supplier_id: toBin(supplier),
        location_id: toBin(store),
        received_by: toBin(receiver),
        status,
        total_accepted_value_xaf: options.valueXaf ?? 5_000,
        occurred_at:
          options.occurredDaysAgo === undefined
            ? new Date(receivedAt.getTime() - 3_600_000)
            : new Date(NOW.getTime() - options.occurredDaysAgo * DAY_MS),
        received_at_server: options.serverReceiptUnknown === true ? null : receivedAt,
        ...(options.serverReceiptUnknown === true ? { created_at: receivedAt } : {}),
        created_by: toBin(admin),
        ...(status === 'CANCELLED' ? { cancelled_at: receivedAt, cancelled_by: toBin(admin) } : {}),
      })
      .execute();
    if (options.lineId !== undefined && options.orderId !== undefined && options.orderId !== null) {
      await uow
        .insertInto('procurement_goods_receipt_lines')
        .values({
          id: toBin(freshUuid()),
          receipt_id: toBin(id),
          po_line_id: toBin(options.lineId),
          product_id: toBin(product),
          unit_code: 'TETE',
          qty_delivered_base: String(10 + (options.rejected ?? 0)),
          qty_rejected_base: String(options.rejected ?? 0),
          ...((options.rejected ?? 0) > 0
            ? { rejection_reason_code_id: toBin(rejectionReason) }
            : {}),
          unit_cost_xaf: 100,
        })
        .execute();
    }
    return { id, docNumber };
  }

  async function attachment(
    receiptId: string,
    options: { readonly kind?: string; readonly status?: string } = {},
  ): Promise<void> {
    await uow
      .insertInto('attachments_attachments')
      .values({
        id: toBin(freshUuid()),
        owner_type: 'GOODS_RECEIPT',
        owner_id: toBin(receiptId),
        kind: options.kind ?? 'DELIVERY_NOTE',
        mime_type: 'image/jpeg',
        sha256: 'a'.repeat(64),
        size_bytes: 1024,
        captured_at: NOW,
        occurred_at: NOW,
        upload_status: options.status ?? 'AVAILABLE',
        created_by: toBin(receiver),
      })
      .execute();
  }

  return { admin, site, store, product, supplier, receiver, purchaseOrder, receipt, attachment };
}

async function eventsOf(
  uow: UnitOfWork,
  eventType: string,
  keep: (payload: Record<string, unknown>) => boolean,
) {
  const rows = await uow
    .selectFrom('platform_domain_events')
    .selectAll()
    .where('event_type', '=', eventType)
    .orderBy('seq', 'desc')
    .limit(3000)
    .execute();
  return rows
    .map((row) => toDomainEvent(row))
    .filter((event) => keep(event.payload as Record<string, unknown>))
    .reverse();
}

describe('procurement.orders.receipt_incomplete_check (P9-09, AV-414)', () => {
  it('inscrite à l’ordonnanceur : photo de réception à 06:15, réception incomplète à 07:15', () => {
    const registry = new RecurringJobRegistry();
    new ProcurementRecurringJobs(registry).onModuleInit();
    expect(registry.list()).toEqual(PROCUREMENT_RECURRING_JOBS);
    expect(registry.get(RECEIPT_ATTACHMENT_MISSING_JOB_TYPE)?.schedule).toEqual({
      kind: 'DAILY',
      localTime: '06:15',
    });
    expect(registry.get(RECEIPT_INCOMPLETE_JOB_TYPE)?.schedule).toEqual({
      kind: 'DAILY',
      localTime: '07:15',
    });
  });

  it('bons ouverts : seuls les envoyés et partiellement reçus sont examinés par la passe', () =>
    rolledBack(async (uow) => {
      const w = await world(uow);
      const actual = await vi.importActual<typeof ReceiptAlertEvents>(
        '../src/modules/procurement/application/receipt-alert-events.js',
      );
      const sent = await w.purchaseOrder({ expected: null, status: 'SENT' });
      const partial = await w.purchaseOrder({ expected: null, status: 'PARTIALLY_RECEIVED' });
      const others = [
        await w.purchaseOrder({ expected: null, status: 'RECEIVED' }),
        await w.purchaseOrder({ expected: null, status: 'CLOSED' }),
        await w.purchaseOrder({ expected: null, status: 'APPROVED' }),
        await w.purchaseOrder({ expected: null, status: 'DRAFT' }),
      ];
      const ids = await actual.listOpenOrderIds(uow);
      const mine = [sent, partial, ...others].map((po) => po.id);
      expect(ids.filter((id) => mine.includes(id)).sort()).toEqual([sent.id, partial.id].sort());
    }));

  it('retard strict (> 2 jours) ou rejet, avec reliquat : un événement par bon ; marqueur en dernier ; rejeu', () =>
    rolledBack(async (uow) => {
      const w = await world(uow);
      const overdue = await w.purchaseOrder({ expected: '2019-03-09' }); // 3 jours de retard
      const boundary = await w.purchaseOrder({ expected: '2019-03-10' }); // 2 jours : pas encore
      const noDate = await w.purchaseOrder({ expected: null });
      const received = await w.purchaseOrder({ expected: '2019-03-01', accepted: 100 }); // reçu
      const closed = await w.purchaseOrder({
        expected: '2019-03-01',
        accepted: 60,
        closed: 40,
        status: 'PARTIALLY_RECEIVED',
      });
      const rejecting = await w.purchaseOrder({ expected: '2019-04-01', accepted: 20 });
      await w.receipt({
        orderId: rejecting.id,
        lineId: rejecting.lineId,
        rejected: 5,
        receivedDaysAgo: 1,
      });
      const ids = [overdue, boundary, noDate, received, closed, rejecting].map((po) => po.id);
      vi.mocked(listOpenOrderIds).mockResolvedValue(ids);

      await incompleteRunner()(uow, { scheduledFor: SLOT });

      const events = await eventsOf(uow, 'ReceiptIncompleteDetected', (payload) =>
        ids.includes(String(payload['po_id'])),
      );
      expect(events.map((event) => event.aggregateId).sort()).toEqual(
        [overdue.id, rejecting.id].sort(),
      );
      const overdueEvent = events.find((event) => event.aggregateId === overdue.id)!;
      expect(overdueEvent.producerModule).toBe('procurement');
      expect(overdueEvent.aggregateType).toBe('PURCHASE_ORDER');
      expect(overdueEvent.payload).toEqual({
        po_id: overdue.id,
        doc_number: overdue.docNumber,
        supplier_id: w.supplier,
        supplier_label: 'Couvoir du Wouri',
        site_id: w.site,
        expected_delivery_date: '2019-03-09',
        days_late: 3,
        threshold_days: 2,
        reason: 'OVERDUE',
        rejected: null,
        remaining_lines: 1,
        po_status: 'SENT',
        trigger: 'PASS',
        business_day: TODAY,
        pass_id: `RECEIPT_INCOMPLETE:${SLOT}`,
      });
      const rejectingEvent = events.find((event) => event.aggregateId === rejecting.id)!;
      expect(rejectingEvent.payload).toMatchObject({
        reason: 'REJECTED',
        rejected: 5,
        days_late: null,
      });

      const markers = await eventsOf(
        uow,
        'AlertDetectionPassCompleted',
        (payload) => payload['pass_id'] === `RECEIPT_INCOMPLETE:${SLOT}`,
      );
      expect(markers).toHaveLength(1);
      expect(markers[0]!.payload).toMatchObject({
        alert_type: 'RECEIPT_INCOMPLETE',
        business_day: TODAY,
      });
      expect(markers[0]!.seq).toBeGreaterThan(Math.max(...events.map((event) => event.seq)));

      // Rejeu du même créneau : ni sujet ni marqueur de plus.
      await incompleteRunner()(uow, { scheduledFor: SLOT });
      expect(
        await eventsOf(uow, 'ReceiptIncompleteDetected', (payload) =>
          ids.includes(String(payload['po_id'])),
        ),
      ).toHaveLength(2);
    }));

  it('le rejeté ne compte que pour les réceptions comptées (ni annulées, ni en quarantaine, ni rejetées)', () =>
    rolledBack(async (uow) => {
      const w = await world(uow);
      const po = await w.purchaseOrder({ expected: '2019-04-01', accepted: 20 });
      for (const status of ['CANCELLED', 'QUARANTINED', 'REJECTED']) {
        await w.receipt({ orderId: po.id, lineId: po.lineId, status, rejected: 5 });
      }
      vi.mocked(listOpenOrderIds).mockResolvedValue([po.id]);
      await incompleteRunner()(uow, { scheduledFor: SLOT });
      expect(await eventsOf(uow, 'ReceiptIncompleteDetected', (p) => p['po_id'] === po.id)).toEqual(
        [],
      );

      await w.receipt({
        orderId: po.id,
        lineId: po.lineId,
        status: 'POSTED_PENDING_REVIEW',
        rejected: 2,
      });
      await incompleteRunner()(uow, { scheduledFor: '2019-03-12T06:20:00.000Z' });
      const [event] = await eventsOf(uow, 'ReceiptIncompleteDetected', (p) => p['po_id'] === po.id);
      expect(event!.payload).toMatchObject({ reason: 'REJECTED', rejected: 2 });
    }));

  it('le délai est un paramètre (0 : dès le lendemain ; invalide : 2)', () =>
    rolledBack(async (uow) => {
      const w = await world(uow);
      const oneDay = await w.purchaseOrder({ expected: '2019-03-11' });
      vi.mocked(listOpenOrderIds).mockResolvedValue([oneDay.id]);
      await incompleteRunner()(uow, { scheduledFor: SLOT });
      expect(
        await eventsOf(uow, 'ReceiptIncompleteDetected', (p) => p['po_id'] === oneDay.id),
      ).toEqual([]);

      settingsOverride.set('procurement.receipt_incomplete_alert_days', 0);
      await incompleteRunner()(uow, { scheduledFor: '2019-03-12T06:21:00.000Z' });
      const [event] = await eventsOf(
        uow,
        'ReceiptIncompleteDetected',
        (p) => p['po_id'] === oneDay.id,
      );
      expect(event!.payload).toMatchObject({ threshold_days: 0, days_late: 1, reason: 'OVERDUE' });

      settingsOverride.set('procurement.receipt_incomplete_alert_days', -5);
      await incompleteRunner()(uow, { scheduledFor: '2019-03-12T06:22:00.000Z' });
      const last = (
        await eventsOf(uow, 'ReceiptIncompleteDetected', (p) => p['po_id'] === oneDay.id)
      ).length;
      expect(last).toBe(1); // 1 jour de retard ≤ 2 : rien de plus avec le défaut
    }));

  it('bout en bout : alerte levée par la passe, fermée par le marqueur quand le reliquat est reçu', () =>
    rolledBack(async (uow) => {
      const w = await world(uow);
      const po = await w.purchaseOrder({ expected: '2019-03-01' });
      vi.mocked(listOpenOrderIds).mockResolvedValue([po.id]);
      await incompleteRunner()(uow, { scheduledFor: SLOT });
      const [event] = await eventsOf(uow, 'ReceiptIncompleteDetected', (p) => p['po_id'] === po.id);
      await handleAlertEvent(uow, event!, { idGenerator });
      const alert = () =>
        uow
          .selectFrom('communication_alerts')
          .select(['status', 'severity', 'title', 'message'])
          .where('dedup_key', '=', `RECEIPT_INCOMPLETE:${po.id}`)
          .executeTakeFirstOrThrow();
      expect(await alert()).toMatchObject({
        status: 'OPEN',
        severity: 'WARNING',
        title: 'Réception incomplète',
      });
      expect((await alert()).message).toContain(po.docNumber);
      expect((await alert()).message).toContain('Couvoir du Wouri');

      // Le reliquat est reçu : la passe suivante ne republie pas le bon, son marqueur ferme l'alerte.
      await uow
        .updateTable('procurement_purchase_order_lines')
        .set({ accepted_qty_base: '100' })
        .where('id', '=', toBin(po.lineId))
        .execute();
      const next = '2019-03-12T06:30:00.000Z';
      await incompleteRunner()(uow, { scheduledFor: next });
      const markers = await eventsOf(
        uow,
        'AlertDetectionPassCompleted',
        (payload) => payload['pass_id'] === `RECEIPT_INCOMPLETE:${next}`,
      );
      await handleAlertEvent(uow, markers[0]!, { idGenerator });
      expect((await alert()).status).toBe('RESOLVED');
    }));
});

describe('procurement.receipts.attachment_missing_check (P9-09, AV-417)', () => {
  const scoped = (slot: string) => `ATTACHMENT_MISSING:GOODS_RECEIPT:${slot}`;
  const missing = (uow: UnitOfWork, ids: readonly string[]) =>
    eventsOf(uow, 'AttachmentMissingDetected', (p) => ids.includes(String(p['document_id'])));

  it('photo exigée et non reçue après 7 jours : un événement par réception, portée GOODS_RECEIPT', () =>
    rolledBack(async (uow) => {
      const w = await world(uow);
      const po = await w.purchaseOrder({ expected: '2019-03-20' });
      const withoutPo = await w.receipt({ orderId: null, receivedDaysAgo: 8 });
      const recent = await w.receipt({ orderId: null, receivedDaysAgo: 3 });
      const smallValue = await w.receipt({
        orderId: po.id,
        lineId: po.lineId,
        valueXaf: 99_999,
        receivedDaysAgo: 10,
      });
      const bigValue = await w.receipt({
        orderId: po.id,
        lineId: po.lineId,
        valueXaf: 100_000,
        receivedDaysAgo: 10,
      });
      const boundary = await w.receipt({ orderId: null, receivedDaysAgo: 7 });
      await attachmentRunner()(uow, { scheduledFor: SLOT });

      const all = [withoutPo, recent, smallValue, bigValue, boundary].map((r) => r.id);
      const events = await missing(uow, all);
      expect(events.map((event) => event.aggregateId).sort()).toEqual(
        [withoutPo.id, bigValue.id, boundary.id].sort(),
      );
      const event = events.find((e) => e.aggregateId === withoutPo.id)!;
      expect(event.producerModule).toBe('procurement');
      expect(event.aggregateType).toBe('GOODS_RECEIPT');
      expect(event.payload).toEqual({
        document_type: 'GOODS_RECEIPT',
        document_id: withoutPo.id,
        document_label: withoutPo.docNumber,
        days_missing: 8,
        author_user_id: w.receiver,
        site_id: w.site,
        status: 'POSTED',
        without_order: true,
        threshold_days: 7,
        business_day: TODAY,
        pass_id: scoped(SLOT),
      });
      const markers = await eventsOf(
        uow,
        'AlertDetectionPassCompleted',
        (payload) => payload['pass_id'] === scoped(SLOT),
      );
      expect(markers).toHaveLength(1);
      expect(markers[0]!.payload).toMatchObject({
        alert_type: 'ATTACHMENT_MISSING',
        scope: 'GOODS_RECEIPT',
      });
      expect(markers[0]!.seq).toBeGreaterThan(Math.max(...events.map((e) => e.seq)));
    }));

  it('une pièce disponible de la bonne nature ferme la condition ; autre nature ou envoi en attente : non', () =>
    rolledBack(async (uow) => {
      const w = await world(uow);
      const good = await w.receipt({ orderId: null, receivedDaysAgo: 9 });
      const otherKind = await w.receipt({ orderId: null, receivedDaysAgo: 9 });
      const pending = await w.receipt({ orderId: null, receivedDaysAgo: 9 });
      await w.attachment(good.id);
      await w.attachment(otherKind.id, { kind: 'PHOTO' });
      await w.attachment(pending.id, { status: 'PENDING_UPLOAD' });
      await attachmentRunner()(uow, { scheduledFor: SLOT });
      const events = await missing(uow, [good.id, otherKind.id, pending.id]);
      expect(events.map((event) => event.aggregateId).sort()).toEqual(
        [otherKind.id, pending.id].sort(),
      );
    }));

  it('réceptions non examinées : annulée, rejetée, refusée en revue ; au-delà de l’horizon', () =>
    rolledBack(async (uow) => {
      const w = await world(uow);
      const kept = [
        await w.receipt({ orderId: null, status: 'POSTED_PENDING_REVIEW', receivedDaysAgo: 9 }),
        await w.receipt({ orderId: null, status: 'QUARANTINED', receivedDaysAgo: 9 }),
        await w.receipt({ orderId: null, status: 'CANCELLATION_PENDING', receivedDaysAgo: 9 }),
      ];
      const ignored = [
        await w.receipt({ orderId: null, status: 'CANCELLED', receivedDaysAgo: 9 }),
        await w.receipt({ orderId: null, status: 'REJECTED', receivedDaysAgo: 9 }),
        await w.receipt({ orderId: null, status: 'REVIEW_REJECTED', receivedDaysAgo: 9 }),
        await w.receipt({ orderId: null, receivedDaysAgo: 91 }),
      ];
      await attachmentRunner()(uow, { scheduledFor: SLOT });
      const events = await missing(
        uow,
        [...kept, ...ignored].map((r) => r.id),
      );
      expect(events.map((event) => event.aggregateId).sort()).toEqual(kept.map((r) => r.id).sort());
    }));

  it('0 jour désactive l’alerte : aucun sujet, mais le marqueur de portée est publié', () =>
    rolledBack(async (uow) => {
      const w = await world(uow);
      const silent = await w.receipt({ orderId: null, receivedDaysAgo: 30 });
      settingsOverride.set('attachments.missing_alert_days', 0);
      await attachmentRunner()(uow, { scheduledFor: SLOT });
      expect(await missing(uow, [silent.id])).toEqual([]);
      const markers = await eventsOf(
        uow,
        'AlertDetectionPassCompleted',
        (payload) => payload['pass_id'] === scoped(SLOT),
      );
      expect(markers).toHaveLength(1);
    }));

  it('seuil historisé : lu à la date de chaque réception ; une chaîne numérique est acceptée', () =>
    rolledBack(async (uow) => {
      const w = await world(uow);
      const po = await w.purchaseOrder({ expected: '2019-03-20' });
      // Avant le 5 mars le seuil est de 50 000 XAF ; ensuite, 100 000 (écrit en chaîne).
      settingsOverride.set('procurement.receipt_photo_threshold_xaf', (at: Date) =>
        at < new Date('2019-03-05T00:00:00.000Z') ? 50_000 : '100000',
      );
      const old = await w.receipt({
        orderId: po.id,
        lineId: po.lineId,
        valueXaf: 60_000,
        receivedDaysAgo: 8,
        occurredDaysAgo: 10, // 2 mars : seuil de 50 000, photo exigée
      });
      const recent = await w.receipt({
        orderId: po.id,
        lineId: po.lineId,
        valueXaf: 60_000,
        receivedDaysAgo: 8,
        occurredDaysAgo: 2, // 10 mars : seuil de 100 000, photo facultative
      });
      const big = await w.receipt({
        orderId: po.id,
        lineId: po.lineId,
        valueXaf: 120_000,
        receivedDaysAgo: 8,
        occurredDaysAgo: 2,
      });
      await attachmentRunner()(uow, { scheduledFor: SLOT });
      const events = await missing(uow, [old.id, recent.id, big.id]);
      expect(events.map((event) => event.aggregateId).sort()).toEqual([old.id, big.id].sort());
    }));

  it('sans réception par le serveur, le délai se compte depuis la création, non depuis la date du fait', () =>
    rolledBack(async (uow) => {
      const w = await world(uow);
      const receipt = await w.receipt({
        orderId: null,
        receivedDaysAgo: 9,
        occurredDaysAgo: 30,
        serverReceiptUnknown: true,
      });
      await attachmentRunner()(uow, { scheduledFor: SLOT });
      const [event] = await missing(uow, [receipt.id]);
      expect(event!.payload).toMatchObject({ days_missing: 9 });
    }));

  it('le seuil de valeur est lu à la date de la réception (réglage historisé), repli 100 000 XAF', () =>
    rolledBack(async (uow) => {
      const w = await world(uow);
      const po = await w.purchaseOrder({ expected: '2019-03-20' });
      const midValue = await w.receipt({
        orderId: po.id,
        lineId: po.lineId,
        valueXaf: 50_000,
        receivedDaysAgo: 10,
      });
      await attachmentRunner()(uow, { scheduledFor: SLOT });
      expect(await missing(uow, [midValue.id])).toEqual([]);
      settingsOverride.set('procurement.receipt_photo_threshold_xaf', 50_000);
      await attachmentRunner()(uow, { scheduledFor: '2019-03-12T06:20:00.000Z' });
      expect(await missing(uow, [midValue.id])).toHaveLength(1);
    }));

  it('bout en bout : alerte levée, fermée par le marqueur de sa portée seulement', () =>
    rolledBack(async (uow) => {
      const w = await world(uow);
      const receipt = await w.receipt({ orderId: null, receivedDaysAgo: 9 });
      await attachmentRunner()(uow, { scheduledFor: SLOT });
      const [event] = await missing(uow, [receipt.id]);
      await handleAlertEvent(uow, event!, { idGenerator });
      const alert = () =>
        uow
          .selectFrom('communication_alerts')
          .select(['status', 'title', 'message', 'last_pass_id'])
          .where('dedup_key', '=', `ATTACHMENT_MISSING:${receipt.id}`)
          .executeTakeFirstOrThrow();
      expect(await alert()).toMatchObject({
        status: 'OPEN',
        title: 'Pièce justificative non reçue',
        last_pass_id: scoped(SLOT),
      });
      expect((await alert()).message).toContain(receipt.docNumber);

      // Le marqueur de la portée « dépenses » (autre producteur) ne ferme pas l'alerte d'une réception.
      const expensePass = 'ATTACHMENT_MISSING:EXPENSE:2019-03-12T06:15:00.000Z';
      await publishPassCompleted(uow, {
        producerModule: 'finance',
        alertType: 'ATTACHMENT_MISSING',
        passId: expensePass,
        scope: 'EXPENSE',
        businessDay: TODAY,
        occurredAt: NOW,
      });
      const [expenseMarker] = await eventsOf(
        uow,
        'AlertDetectionPassCompleted',
        (payload) => payload['pass_id'] === expensePass,
      );
      await handleAlertEvent(uow, expenseMarker!, { idGenerator });
      expect((await alert()).status).toBe('OPEN');

      // La photo arrive : la passe suivante de la portée des réceptions ferme l'alerte.
      await w.attachment(receipt.id);
      const next = '2019-03-12T06:40:00.000Z';
      await attachmentRunner()(uow, { scheduledFor: next });
      const [marker] = await eventsOf(
        uow,
        'AlertDetectionPassCompleted',
        (payload) => payload['pass_id'] === scoped(next),
      );
      await handleAlertEvent(uow, marker!, { idGenerator });
      expect((await alert()).status).toBe('RESOLVED');
    }));
});
