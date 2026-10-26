/**
 * `inventory.ledger.reconcile_daily` (P2-07, P5-16, P9-08 ; AV-402, AV-459) : un écart du registre n'est plus
 * un échec de tâche mais une alerte `LEDGER_MISMATCH` — un événement `LedgerMismatchDetected` par site et
 * par jour métier, publié dans la transaction de la tâche, qui se termine en succès. Les deux
 * vérifications sont simulées (aucune altération de la base d'essai partagée, que d'autres fichiers
 * réconcilient en même temps) ; les sites et les emplacements sont réels, dans une transaction annulée.
 */
import { afterAll, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';

vi.mock('../src/modules/inventory/application/public/ledger-reconciliation.js', () => ({
  verifyStockLedger: vi.fn(),
}));
vi.mock('../src/modules/inventory/application/public/transfer-transit.js', () => ({
  verifyTransferTransit: vi.fn(),
}));

import { FixedClock, Uuidv7Generator, businessDayOf } from '@gic/domain';
import { JobHandlerRegistry } from '../src/platform/jobs/job-handler-registry.js';
import {
  LEDGER_RECONCILIATION_JOB_TYPE,
  LedgerReconciliationJob,
} from '../src/modules/inventory/application/jobs/ledger-reconciliation-job.js';
import { verifyStockLedger } from '../src/modules/inventory/application/public/ledger-reconciliation.js';
import { verifyTransferTransit } from '../src/modules/inventory/application/public/transfer-transit.js';
import { compositeSubjectId } from '../src/platform/events/detection-events.js';
import { toDomainEvent } from '../src/platform/events/domain-event.js';
import { handleAlertEvent } from '../src/modules/communication/application/events/alerts-consumer.js';
import type { UnitOfWork } from '../src/platform/unit-of-work.js';
import { fromBin, toBin } from '../src/platform/kysely/uuid-columns.js';
import { recordStockMove } from '../src/modules/inventory/application/public/record-move.js';
import { rolledBack } from './communication-test-kit.js';
import {
  closeTestDb,
  db,
  freshUuid,
  insertTestDevice,
  insertTestLocation,
  insertTestProduct,
  insertTestSite,
  insertTestUser,
  insertTestZone,
} from './helpers.js';

const NOW = new Date('2026-11-05T01:30:00.000Z');
const TODAY = businessDayOf(NOW);
const clock = new FixedClock(NOW);
const idGenerator = new Uuidv7Generator(clock);

afterAll(closeTestDb);

const CLEAN_LEDGER = {
  ok: true,
  balancesChecked: 3,
  mismatches: [],
  conservationBreaches: [],
  toDeliverBreaches: [],
  settlementBreaches: [],
  allocationBreaches: [],
  overcommitBreaches: [],
  negativeBreaches: [],
};
const CLEAN_TRANSIT = { ok: true, transfersChecked: 4, breaches: [] };

function handler(at: FixedClock = clock) {
  const registry = new JobHandlerRegistry();
  new LedgerReconciliationJob(at, idGenerator, registry).onModuleInit();
  return registry.resolve(LEDGER_RECONCILIATION_JOB_TYPE)!;
}

const mismatch = (locationId: string) => ({
  locationId,
  productId: freshUuid(),
  lotId: null,
  projectedQty: 13,
  ledgerQty: 8,
});

async function twoSites(uow: UnitOfWork) {
  const admin = await insertTestUser(uow);
  const zone = await insertTestZone(uow, admin);
  const siteA = await insertTestSite(uow, admin, zone);
  const siteB = await insertTestSite(uow, admin, zone);
  const locationA = await insertTestLocation(uow, admin, siteA, { locationType: 'STORE' });
  const locationB = await insertTestLocation(uow, admin, siteB, { locationType: 'STORE' });
  return { siteA, siteB, locationA, locationB };
}

async function detectedEvents(uow: UnitOfWork, siteKey: string, businessDay: string = TODAY) {
  const subject = compositeSubjectId('LEDGER_MISMATCH', {
    site_key: siteKey,
    business_day: businessDay,
  });
  return (
    await uow
      .selectFrom('platform_domain_events')
      .selectAll()
      .where('event_type', '=', 'LedgerMismatchDetected')
      .where('aggregate_id', '=', toBin(subject))
      .orderBy('seq')
      .execute()
  ).map((row) => toDomainEvent(row));
}

describe('LedgerReconciliationJob — alerte LEDGER_MISMATCH au lieu d’un échec (P9-08, AV-459)', () => {
  it('un écart par site : un événement par site et par jour, la tâche réussit', () =>
    rolledBack(async (uow) => {
      const { siteA, siteB, locationA, locationB } = await twoSites(uow);
      vi.mocked(verifyStockLedger).mockResolvedValue({
        ...CLEAN_LEDGER,
        ok: false,
        mismatches: [mismatch(locationA), mismatch(locationA)],
        negativeBreaches: [
          { locationId: locationB, productId: freshUuid(), lotKey: freshUuid(), qtyOnHand: -3 },
        ],
      } as never);
      vi.mocked(verifyTransferTransit).mockResolvedValue(CLEAN_TRANSIT as never);

      await expect(handler()(uow, {})).resolves.toBeUndefined();

      const [a] = await detectedEvents(uow, siteA);
      expect(a!.payload).toMatchObject({
        site_key: siteA,
        site_id: siteA,
        business_day: TODAY,
        mismatches: 2,
        breakdown: { balances: 2, negative: 0, transit: 0, conservation: 0 },
        balances_checked: 3,
      });
      const [b] = await detectedEvents(uow, siteB);
      expect(b!.payload).toMatchObject({
        site_id: siteB,
        mismatches: 1,
        breakdown: { negative: 1, balances: 0 },
      });
      expect(a!.eventType).toBe('LedgerMismatchDetected');
      expect(a!.producerModule).toBe('inventory');
    }));

  it('anomalie sans site (conservation d’un produit) : clé GLOBAL, aucun site', () =>
    rolledBack(async (uow) => {
      vi.mocked(verifyStockLedger).mockResolvedValue({
        ...CLEAN_LEDGER,
        ok: false,
        conservationBreaches: [{ productId: freshUuid(), totalQty: 5 }],
      } as never);
      vi.mocked(verifyTransferTransit).mockResolvedValue(CLEAN_TRANSIT as never);
      await handler()(uow, {});
      const [event] = await detectedEvents(uow, 'GLOBAL');
      expect(event!.payload).toMatchObject({
        site_key: 'GLOBAL',
        site_id: null,
        mismatches: 1,
        breakdown: { conservation: 1 },
      });
    }));

  it('transit non soldé : rattaché au site du transfert ; le message reste dans le journal, les détails dans l’échantillon', () =>
    rolledBack(async (uow) => {
      const { siteA } = await twoSites(uow);
      const admin = await insertTestUser(uow);
      // Un transfert réel du site A : le site est lu sur le transfert (colonne `site_id`).
      const fromLocation = await insertTestLocation(uow, admin, siteA, { locationType: 'STORE' });
      const toLocation = await insertTestLocation(uow, admin, siteA, { locationType: 'STORE' });
      const transferId = freshUuid();
      await uow
        .insertInto('inventory_stock_transfers')
        .values({
          id: toBin(transferId),
          doc_number: `TRF-${transferId.slice(-8)}`,
          site_id: toBin(siteA),
          from_location_id: toBin(fromLocation),
          to_location_id: toBin(toLocation),
          status: 'RECEIVED',
          occurred_at: NOW,
          created_by: toBin(admin),
        })
        .execute();
      vi.mocked(verifyStockLedger).mockResolvedValue(CLEAN_LEDGER as never);
      vi.mocked(verifyTransferTransit).mockResolvedValue({
        ok: false,
        transfersChecked: 2,
        breaches: [
          {
            transferId,
            productId: 'P-1',
            reason: 'TRANSIT_NOT_SETTLED',
            expectedQty: 0,
            actualQty: 58,
          },
        ],
      } as never);
      await handler()(uow, {});
      const [event] = await detectedEvents(uow, siteA);
      expect(event!.payload).toMatchObject({ breakdown: { transit: 1 }, mismatches: 1 });
      expect((event!.payload as { sample: string[] }).sample).toEqual([
        `transfert ${transferId} produit P-1 : TRANSIT_NOT_SETTLED, attendu 0 ≠ constaté 58`,
      ]);
    }));

  it('au-delà de cinq écarts par catégorie, le reste est compté sans être détaillé', () =>
    rolledBack(async (uow) => {
      const { siteA, locationA } = await twoSites(uow);
      vi.mocked(verifyStockLedger).mockResolvedValue({
        ...CLEAN_LEDGER,
        ok: false,
        mismatches: Array.from({ length: 8 }, () => mismatch(locationA)),
      } as never);
      vi.mocked(verifyTransferTransit).mockResolvedValue(CLEAN_TRANSIT as never);
      await handler()(uow, {});
      const [event] = await detectedEvents(uow, siteA);
      const payload = event!.payload as { mismatches: number; sample: string[] };
      expect(payload.mismatches).toBe(8);
      expect(payload.sample).toHaveLength(5);
    }));

  it('rejeu du même créneau : rien n’est republié ; un autre jour republie (occurrences)', () =>
    rolledBack(async (uow) => {
      const { siteA, locationA } = await twoSites(uow);
      vi.mocked(verifyStockLedger).mockResolvedValue({
        ...CLEAN_LEDGER,
        ok: false,
        mismatches: [mismatch(locationA)],
      } as never);
      vi.mocked(verifyTransferTransit).mockResolvedValue(CLEAN_TRANSIT as never);
      const run = handler();
      await run(uow, { scheduledFor: '2026-11-05T01:00:00.000Z' });
      await run(uow, { scheduledFor: '2026-11-05T01:00:00.000Z' });
      expect(await detectedEvents(uow, siteA)).toHaveLength(1);
      await run(uow, { scheduledFor: '2026-11-05T01:00:01.000Z' });
      expect(await detectedEvents(uow, siteA)).toHaveLength(2);
    }));

  it('registre et transit sains : aucun événement, la tâche se termine', () =>
    rolledBack(async (uow) => {
      const { siteA } = await twoSites(uow);
      vi.mocked(verifyStockLedger).mockResolvedValue(CLEAN_LEDGER as never);
      vi.mocked(verifyTransferTransit).mockResolvedValue(CLEAN_TRANSIT as never);
      await expect(handler()(uow, {})).resolves.toBeUndefined();
      expect(await detectedEvents(uow, siteA)).toEqual([]);
    }));

  it('bout en bout : le consommateur lève une alerte critique par site, sans site pour le global', () =>
    rolledBack(async (uow) => {
      const { siteA, locationA } = await twoSites(uow);
      vi.mocked(verifyStockLedger).mockResolvedValue({
        ...CLEAN_LEDGER,
        ok: false,
        mismatches: [mismatch(locationA)],
        conservationBreaches: [{ productId: freshUuid(), totalQty: 5 }],
      } as never);
      vi.mocked(verifyTransferTransit).mockResolvedValue(CLEAN_TRANSIT as never);
      await handler()(uow, {});
      for (const siteKey of [siteA, 'GLOBAL']) {
        for (const event of await detectedEvents(uow, siteKey)) {
          await handleAlertEvent(uow, event, { idGenerator });
        }
      }
      const alerts = await uow
        .selectFrom('communication_alerts')
        .select(['severity', 'status', 'site_id', 'dedup_key', 'title'])
        .where('alert_type', '=', 'LEDGER_MISMATCH')
        .where('dedup_key', 'like', `%${TODAY}`)
        .execute();
      const bySite = alerts.find((alert) => alert.dedup_key.includes(siteA));
      const global = alerts.find((alert) => alert.dedup_key.includes(':global:'));
      expect(bySite).toMatchObject({ severity: 'CRITICAL', status: 'OPEN' });
      expect(fromBin(bySite!.site_id as Buffer)).toBe(siteA);
      expect(global).toMatchObject({ severity: 'CRITICAL', status: 'OPEN', site_id: null });
    }));
});

describe('LedgerReconciliationJob — rattachement de chaque catégorie à son site (P9-08, revue adverse)', () => {
  it('règlement, quota, dépassement, « à livrer » et transit : chaque catégorie sous le site de sa donnée', () =>
    rolledBack(async (uow) => {
      const { siteA, siteB, locationA, locationB } = await twoSites(uow);
      const admin = await insertTestUser(uow);
      const product = await insertTestProduct(uow, admin);
      const virtual = async (type: string) =>
        fromBin(
          (
            await db
              .selectFrom('organization_locations')
              .select('id')
              .where('location_type', '=', type)
              .executeTakeFirstOrThrow()
          ).id,
        );
      const base = {
        productId: product,
        occurredAt: NOW,
        createdBy: admin,
        allowNegative: false,
      };
      await recordStockMove(
        uow,
        { idGenerator },
        {
          ...base,
          quantityBase: 5,
          fromLocationId: await virtual('V_OPENING'),
          toLocationId: locationA,
          moveType: 'OPENING_BALANCE',
          declaredUnitCostXaf: 100,
          sourceDocType: 'INVENTORY_COUNT',
          sourceDocId: freshUuid(),
        },
      );
      // Vente réelle du site A vers un emplacement virtuel (sans site) : seul `from_location_id` donne A.
      const [sale] = await recordStockMove(
        uow,
        { idGenerator },
        {
          ...base,
          quantityBase: 2,
          fromLocationId: locationA,
          toLocationId: await virtual('V_CUSTOMER'),
          moveType: 'SALE',
          sourceDocType: 'SALE',
          sourceDocId: freshUuid(),
        },
      );
      // Quota réel du site B.
      const device = await insertTestDevice(uow, admin, { status: 'ACTIVE' });
      const allocationId = freshUuid();
      await uow
        .insertInto('inventory_stock_allocations')
        .values({
          id: toBin(allocationId),
          allocation_type: 'DEVICE_QUOTA',
          holder_device_id: toBin(device),
          holder_user_id: toBin(admin),
          location_id: toBin(locationB),
          product_id: toBin(product),
          quantity_granted: '5',
          quantity_remaining: '5',
          granted_by: toBin(admin),
          created_by: toBin(admin),
        })
        .execute();
      // Transfert dont le site (B) diffère de celui de ses deux emplacements (A).
      const transferId = freshUuid();
      const second = await insertTestLocation(uow, admin, siteA, { locationType: 'STORE' });
      await uow
        .insertInto('inventory_stock_transfers')
        .values({
          id: toBin(transferId),
          doc_number: `TRF-${transferId.slice(-8)}`,
          site_id: toBin(siteB),
          from_location_id: toBin(locationA),
          to_location_id: toBin(second),
          status: 'RECEIVED',
          occurred_at: NOW,
          created_by: toBin(admin),
        })
        .execute();

      vi.mocked(verifyStockLedger).mockResolvedValue({
        ...CLEAN_LEDGER,
        ok: false,
        settlementBreaches: [
          {
            originMoveId: sale!.moveId,
            reason: 'QUANTITY_EXCEEDED',
            originQuantity: 2,
            settledQuantity: 3,
            originValueXaf: 200,
            settledValueXaf: 300,
          },
        ],
        allocationBreaches: [
          {
            allocationId,
            reason: 'REMAINING_NEGATIVE',
            remaining: -1,
            ledgerRemaining: 0,
            ledgerNetConsumed: 0,
            movesNetConsumed: 0,
          },
        ],
        overcommitBreaches: [
          { locationId: locationA, productId: product, stockOnHand: 1, allocatedRemaining: 3 },
        ],
        toDeliverBreaches: [
          { locationId: locationB, productId: product, lotId: null, qty: -1, valueXaf: -100 },
        ],
      } as never);
      vi.mocked(verifyTransferTransit).mockResolvedValue({
        ok: false,
        transfersChecked: 1,
        breaches: [
          {
            transferId,
            productId: null,
            reason: 'RETURNED_QTY_MISMATCH',
            expectedQty: 20,
            actualQty: 0,
          },
        ],
      } as never);

      await handler()(uow, {});

      const [a] = await detectedEvents(uow, siteA);
      const [b] = await detectedEvents(uow, siteB);
      expect((await detectedEvents(uow, 'GLOBAL')).length).toBe(0);
      const breakdownOf = (event: typeof a) =>
        (event!.payload as { breakdown: Record<string, number> }).breakdown;
      const sampleOf = (event: typeof a) => (event!.payload as { sample: string[] }).sample;
      // Site A : la vente (emplacement d'origine du mouvement) et le dépassement de quotas.
      expect(breakdownOf(a)).toMatchObject({
        settlement: 1,
        overcommit: 1,
        allocation: 0,
        transit: 0,
      });
      expect((a!.payload as { mismatches: number }).mismatches).toBe(2);
      expect(sampleOf(a).some((line) => line.includes(sale!.moveId))).toBe(true);
      // Site B : le quota, le « à livrer » et le transfert (site du transfert, pas de ses emplacements).
      expect(breakdownOf(b)).toMatchObject({
        allocation: 1,
        to_deliver: 1,
        transit: 1,
        settlement: 0,
        overcommit: 0,
      });
      expect((b!.payload as { mismatches: number }).mismatches).toBe(3);
      expect(sampleOf(b)).toEqual(
        expect.arrayContaining([
          expect.stringContaining(allocationId),
          expect.stringContaining('« à livrer »'),
          // productId nul : « produit - », raison et quantités du transit.
          `transfert ${transferId} produit - : RETURNED_QTY_MISMATCH, attendu 20 ≠ constaté 0`,
        ]),
      );
    }));

  it('une anomalie qui persiste lève une nouvelle alerte chaque jour métier ; deux passes du même jour : occurrences', () =>
    rolledBack(async (uow) => {
      const { siteA, locationA } = await twoSites(uow);
      vi.mocked(verifyStockLedger).mockResolvedValue({
        ...CLEAN_LEDGER,
        ok: false,
        mismatches: [mismatch(locationA)],
      } as never);
      vi.mocked(verifyTransferTransit).mockResolvedValue(CLEAN_TRANSIT as never);
      const tomorrow = new FixedClock(new Date(NOW.getTime() + 24 * 3_600_000));
      const tomorrowDay = businessDayOf(tomorrow.now());

      await handler()(uow, { scheduledFor: '2026-11-05T01:30:00.000Z' });
      await handler()(uow, { scheduledFor: '2026-11-05T01:30:01.000Z' }); // autre créneau, même jour
      await handler(tomorrow)(uow, { scheduledFor: '2026-11-06T01:30:00.000Z' });
      const today = await detectedEvents(uow, siteA);
      const next = await detectedEvents(uow, siteA, tomorrowDay);
      expect(today).toHaveLength(2);
      expect(next).toHaveLength(1);
      for (const event of [...today, ...next]) await handleAlertEvent(uow, event, { idGenerator });
      const alerts = await uow
        .selectFrom('communication_alerts')
        .select(['dedup_key', 'occurrences', 'status'])
        .where('dedup_key', 'in', [
          `LEDGER_MISMATCH:LEDGER_RECONCILIATION:${siteA}:${TODAY}`,
          `LEDGER_MISMATCH:LEDGER_RECONCILIATION:${siteA}:${tomorrowDay}`,
        ])
        .orderBy('dedup_key')
        .execute();
      expect(alerts.map((alert) => [alert.occurrences, alert.status])).toEqual([
        [2, 'OPEN'],
        [1, 'OPEN'],
      ]);
    }));

  it('le journal d’exploitation reprend les compteurs et l’échantillon de chaque site', () =>
    rolledBack(async (uow) => {
      const { siteA, locationA } = await twoSites(uow);
      const entry = mismatch(locationA);
      vi.mocked(verifyStockLedger).mockResolvedValue({
        ...CLEAN_LEDGER,
        ok: false,
        mismatches: [entry],
      } as never);
      vi.mocked(verifyTransferTransit).mockResolvedValue(CLEAN_TRANSIT as never);
      const spy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      try {
        await handler()(uow, {});
        const lines = spy.mock.calls.map((call) => String(call[0]));
        expect(lines.some((line) => line.includes('1 solde(s) en écart'))).toBe(true);
        expect(
          lines.some(
            (line) =>
              line.startsWith(`LEDGER_MISMATCH site ${siteA} :`) &&
              line.includes(`emplacement ${locationA} produit ${entry.productId}`) &&
              line.includes('projection 13 ≠ registre 8'),
          ),
        ).toBe(true);
      } finally {
        spy.mockRestore();
      }
    }));
});
