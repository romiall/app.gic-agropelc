/**
 * AT-004 (P5-21) : trois tablettes d'un PDV partagé, hors ligne, avec quotas — WF-18 de bout en bout
 * (BR-STK-010 à 014, BR-DIS-002 ; ADR-033 ; INV-STK-10, 11, 19, 20), sur l'application complète et le
 * vrai service de synchronisation, avec le harnais multi-appareils (`OfflineDevice`).
 *
 * Vecteur de WF-18 : stock 100 ; quotas accordés en ligne A 40, B 30, C 20 (10 non alloués) ; journée
 * hors ligne : A vend 38, B tente 31 et la tablette le bloque à 30 (`decideLocalConsumption`, la garde
 * de l'appareil), C vend 12 ; un vendeur sans quota ne vend rien hors ligne ; libération en fin de
 * journée (A 2, B 0, C 8). Attendu, **quel que soit l'ordre de synchronisation** (entrelacé lot par
 * lot, inverse, concurrent) : aucun solde négatif, quotas consommés par leur seul couple, aucune
 * anomalie, solde 20, quotas fermés `RELEASED`, état local de chaque tablette égal au serveur.
 *
 * Chaque ordre est vérifié contre le même état final écrit en clair (`expectNominalEnd`) : les tests
 * sont indépendants les uns des autres.
 *
 * Variantes : appareil modifié qui pousse 31 (WF-18 étape 5, AT-003) ; ventes en ligne pendant la
 * journée, quotas actifs (étape 6 : B au-delà de ses 30 dans la limite du non-alloué, vendeur sans quota
 * sur le non-alloué, puis hors ligne malgré le blocage) ; hausse du quota en ligne pendant la journée
 * hors ligne (écart de libération légitime, `ALLOCATION_RELEASE_MISMATCH`) ; réponse perdue en milieu
 * de file (aucune double consommation, AT-002).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decideLocalConsumption } from '@gic/domain';
import type { CommandResult, RawCommandEnvelope } from '@gic/contracts';
import { allocationPositions } from '../src/modules/inventory/application/public/index.js';
import { fromBin, toBin } from '../src/platform/kysely/uuid-columns.js';
import { NetworkDownError, type OfflineDevice } from './device-harness.js';
import { sql } from 'kysely';
import { closeTestDb, db } from './helpers.js';
import { PosWorld, codeOf, warningsOf, type Actor, type Sellable } from './pos-world.js';

const DAY = '2026-10-07';
const at = (hhmm: string) => `${DAY}T${hhmm}:00.000Z`;

interface Till {
  readonly name: string;
  readonly actor: Actor;
  readonly customerId: string;
  readonly tablet: OfflineDevice;
  /** Quota local par produit : reste tenu par la tablette (jeu `allocations` moins ses ventes). */
  readonly local: Map<string, { id: string; remaining: number; validUntil: Date | null }>;
}

describe(
  'AT-004 : trois tablettes d’un PDV partagé, hors ligne, avec quotas (WF-18)',
  { timeout: 600_000 },
  () => {
    let world: PosWorld;
    let A: Till;
    let B: Till;
    let C: Till;
    let D: Till;

    // --- Tablette ----------------------------------------------------------------------------------

    /** Le matin : la tablette tire `allocations` ; elle ne reçoit que les quotas de son couple. */
    async function morningPull(till: Till, productId: string): Promise<void> {
      await till.tablet.pullAll('allocations', till.actor.userId, world.clock.now());
      const quotas = [...till.tablet.localProjection.entries()]
        .filter(([key]) => key.startsWith('allocations:STOCK_ALLOCATION:'))
        .map(([, data]) => data as Record<string, unknown>);
      for (const quota of quotas) {
        expect(quota['holder_device_id']).toBe(till.actor.deviceId);
        expect(quota['holder_user_id']).toBe(till.actor.userId);
      }
      const mine = quotas.find((quota) => quota['product_id'] === productId);
      if (mine === undefined) return;
      till.local.set(productId, {
        id: mine['id'] as string,
        remaining: Number(mine['quantity_remaining']),
        validUntil: mine['valid_until'] === null ? null : new Date(mine['valid_until'] as string),
      });
    }

    /** Saisie d'une vente sur la tablette : la garde locale décide, la vente n'entre en file qu'acceptée. */
    function trySell(till: Till, product: Sellable, quantity: number, occurredAt: string) {
      const quota = till.local.get(product.id);
      const decision = decideLocalConsumption({
        custodyMode: 'SHARED',
        requested: quantity,
        localBalance: 0,
        holdsQuota: quota !== undefined,
        quotaRemaining: quota?.remaining ?? 0,
        quotaValidUntil: quota?.validUntil ?? null,
        now: new Date(occurredAt),
        overAllocationAllowed: false,
      });
      if (!decision.allowed) return { decision, envelope: undefined };
      const envelope = sell(till, product, quantity, occurredAt);
      quota!.remaining -= quantity;
      return { decision, envelope };
    }

    /** Vente mise en file sans garde (appareil modifié, ou après acceptation de la garde). */
    const sell = (till: Till, product: Sellable, quantity: number, occurredAt: string) =>
      till.tablet.enqueue(till.actor.userId, {
        type: 'sales.sale.record',
        aggregateType: 'SALE',
        occurredAt,
        payload: {
          fromLocationId: world.counter,
          customerId: till.customerId,
          lines: [world.line(product, quantity)],
        },
      });

    /** Libération de fin de journée : la tablette déclare son reste local. */
    function release(till: Till, product: Sellable, occurredAt: string): RawCommandEnvelope {
      const quota = till.local.get(product.id)!;
      return till.tablet.enqueue(till.actor.userId, {
        type: 'inventory.allocation.release',
        aggregateType: 'STOCK_ALLOCATION',
        aggregateId: quota.id,
        occurredAt,
        payload: { remainingBase: quota.remaining },
      });
    }

    // --- Lectures et invariants -----------------------------------------------------------------------

    const entries = (allocationId: string) =>
      db
        .selectFrom('inventory_stock_allocation_entries')
        .select(['entry_type', 'quantity'])
        .where('allocation_id', '=', toBin(allocationId))
        .execute();

    async function consumedBy(allocationId: string): Promise<number> {
      const rows = await entries(allocationId);
      return -rows
        .filter((row) => row.entry_type === 'CONSUME' || row.entry_type === 'RESTORE')
        .reduce((sum, row) => sum + Number(row.quantity), 0);
    }

    /** INV-STK-10, 19 (cas nominal) et 20 à un instant de la synchronisation. */
    async function expectStepInvariants(
      product: Sellable,
      quotaIds: readonly string[],
    ): Promise<void> {
      const onHand = await world.onHand(product.id);
      expect(onHand).toBeGreaterThanOrEqual(0);
      let total = 0;
      for (const id of quotaIds) {
        const quota = await world.quota(id);
        const remaining = Number(quota.quantity_remaining);
        expect(remaining).toBeGreaterThanOrEqual(0);
        if (quota.status === 'ACTIVE') total += remaining;
        const signed = (await entries(id)).reduce((sum, row) => sum + Number(row.quantity), 0);
        expect(Math.round(signed * 1000)).toBe(Math.round(remaining * 1000));
      }
      expect(total).toBeLessThanOrEqual(onHand);
      await world.expectStockLedgerOk([product.id]);
    }

    const ANOMALIES = [
      'STOCK_NEGATIVE',
      'ALLOCATION_EXCEEDED',
      'ALLOCATION_OVERCOMMITTED',
      'ALLOCATION_RELEASE_MISMATCH',
      'CUSTODY_DEVICE_MISMATCH',
    ];

    // --- Monde ----------------------------------------------------------------------------------------

    beforeAll(async () => {
      world = await PosWorld.create({ now: at('04:00'), sellers: 4 });
      const till = async (name: string, actor: Actor): Promise<Till> => ({
        name,
        actor,
        customerId: await world.customer(`Client de la tablette ${name}`),
        tablet: world.tablet(actor),
        local: new Map(),
      });
      [A, B, C, D] = await Promise.all(
        world.sellers.map((actor, index) => till(['A', 'B', 'C', 'D'][index]!, actor)),
      );
    }, 120_000);

    afterAll(async () => {
      try {
        await world?.close(at('17:59'));
      } finally {
        await closeTestDb();
      }
    });

    /**
     * Matin en ligne et journée hors ligne de WF-18 sur un produit neuf ; renvoie les quotas et les
     * ventes mises en file par tablette. `bOverride` : B pousse 31 (appareil modifié, garde contournée).
     */
    async function wf18Day(options: { readonly bOverride?: boolean } = {}) {
      world.setNow(at('07:00'));
      const product = await world.product();
      await world.stockIn(product.id, 100, at('05:00'));
      const quotas = {
        A: await world.grant(A.actor, product.id, 40, at('07:00')),
        B: await world.grant(B.actor, product.id, 30, at('07:00')),
        C: await world.grant(C.actor, product.id, 20, at('07:00')),
      };
      // Capacité restante 10 (INV-STK-19) : un quatrième octroi de 11 est refusé.
      const fourth = await world.online(world.magP, {
        type: 'inventory.allocation.grant',
        aggregateType: 'STOCK_ALLOCATION',
        occurredAt: at('07:05'),
        payload: {
          holderUserId: D.actor.userId,
          holderDeviceId: D.actor.deviceId,
          locationId: world.counter,
          productId: product.id,
          quantityBase: 11,
        },
      });
      expect(codeOf(fourth)).toBe('ALLOCATION_EXCEEDS_AVAILABLE');
      const [position] = await allocationPositions(db, {
        locationIds: [world.counter],
        productIds: [product.id],
        now: world.clock.now(),
      });
      expect(position).toMatchObject({ onHandQty: 100, allocatedQty: 90, unallocatedQty: 10 });

      for (const till of [A, B, C, D]) await morningPull(till, product.id);
      expect(D.local.has(product.id)).toBe(false);
      for (const till of [A, B, C]) {
        expect(till.local.get(product.id)?.validUntil?.toISOString()).toBe(`${DAY}T23:00:00.000Z`);
      }

      // Journée hors ligne.
      const sales: Record<'A' | 'B' | 'C', RawCommandEnvelope[]> = { A: [], B: [], C: [] };
      const accept = (name: 'A' | 'B' | 'C', attempt: ReturnType<typeof trySell>) => {
        expect(attempt.decision.allowed, JSON.stringify(attempt.decision)).toBe(true);
        sales[name].push(attempt.envelope!);
      };
      accept('A', trySell(A, product, 20, at('09:00')));
      accept('C', trySell(C, product, 5, at('09:15')));
      if (options.bOverride) {
        sales.B.push(sell(B, product, 31, at('09:30')));
        B.local.get(product.id)!.remaining = 0;
      } else {
        const blocked = trySell(B, product, 31, at('09:30'));
        expect(blocked.decision).toMatchObject({
          allowed: false,
          code: 'ALLOCATION_EXCEEDED',
          available: 30,
        });
        accept('B', trySell(B, product, 10, at('10:00')));
        accept('B', trySell(B, product, 10, at('12:00')));
        accept('B', trySell(B, product, 10, at('15:00')));
      }
      accept('A', trySell(A, product, 10, at('11:00')));
      accept('C', trySell(C, product, 4, at('13:00')));
      accept('A', trySell(A, product, 8, at('14:00')));
      accept('C', trySell(C, product, 3, at('16:00')));
      // Vendeur sans quota : la tablette refuse, rien n'entre en file.
      expect(trySell(D, product, 1, at('10:30')).decision).toMatchObject({
        allowed: false,
        code: 'ALLOCATION_MISSING',
      });
      expect(D.tablet.pending()).toBe(0);
      expect(A.local.get(product.id)!.remaining).toBe(2);
      expect(B.local.get(product.id)!.remaining).toBe(0);
      expect(C.local.get(product.id)!.remaining).toBe(8);

      const releases = {
        A: release(A, product, at('17:30')),
        B: release(B, product, at('17:31')),
        C: release(C, product, at('17:32')),
      };
      world.setNow(at('18:00'));
      return { product, quotas, sales, releases };
    }

    /** État final comparable d'un produit (indépendance à l'ordre de synchronisation). */
    async function finalState(product: Sellable, quotas: Record<'A' | 'B' | 'C', string>) {
      const state: Record<string, unknown> = { onHand: await world.onHand(product.id) };
      for (const [name, id] of Object.entries(quotas)) {
        const quota = await world.quota(id);
        state[name] = {
          status: quota.status,
          closeCause: quota.close_cause,
          remaining: Number(quota.quantity_remaining),
          declared:
            quota.release_declared_remaining === null
              ? null
              : Number(quota.release_declared_remaining),
          consumed: await consumedBy(id),
          entries: (await entries(id)).map((row) => row.entry_type).sort(),
        };
      }
      return state;
    }

    async function expectNominalEnd(day: Awaited<ReturnType<typeof wf18Day>>) {
      const { product, quotas, sales, releases } = day;
      // Chaque vente appliquée sans avertissement ; chaque libération sans écart.
      for (const [name, envelopes] of Object.entries(sales) as [
        'A' | 'B' | 'C',
        RawCommandEnvelope[],
      ][]) {
        const till = { A, B, C }[name];
        for (const envelope of envelopes) {
          const result = till.tablet.resultOf(envelope.command_id);
          expect(result?.status, JSON.stringify(result)).toBe('APPLIED');
          expect(warningsOf(result)).toEqual([]);
        }
        expect(till.tablet.resultOf(releases[name].command_id)?.status).toBe('APPLIED');
      }
      expect(await finalState(product, quotas)).toEqual({
        onHand: 20,
        A: {
          status: 'CLOSED',
          closeCause: 'RELEASED',
          remaining: 0,
          declared: 2,
          consumed: 38,
          entries: ['CONSUME', 'CONSUME', 'CONSUME', 'GRANT', 'RELEASE'],
        },
        B: {
          status: 'CLOSED',
          closeCause: 'RELEASED',
          remaining: 0,
          declared: 0,
          consumed: 30,
          entries: ['CONSUME', 'CONSUME', 'CONSUME', 'GRANT'],
        },
        C: {
          status: 'CLOSED',
          closeCause: 'RELEASED',
          remaining: 0,
          declared: 8,
          consumed: 12,
          entries: ['CONSUME', 'CONSUME', 'CONSUME', 'GRANT', 'RELEASE'],
        },
      });
      // INV-STK-11 : chaque sortie de vente porte le quota du couple de sa tablette.
      for (const [name, envelopes] of Object.entries(sales) as [
        'A' | 'B' | 'C',
        RawCommandEnvelope[],
      ][]) {
        for (const envelope of envelopes) {
          const moves = await db
            .selectFrom('inventory_stock_moves')
            .select(['allocation_id'])
            .where('source_doc_type', '=', 'SALE')
            .where('source_doc_id', '=', toBin(envelope.aggregate_id))
            .where('move_type', '=', 'SALE')
            .execute();
          expect(moves.length).toBeGreaterThan(0);
          for (const move of moves) {
            expect(move.allocation_id === null ? null : fromBin(move.allocation_id)).toBe(
              quotas[name],
            );
          }
        }
      }
      const [position] = await allocationPositions(db, {
        locationIds: [world.counter],
        productIds: [product.id],
        now: world.clock.now(),
      });
      expect(position).toMatchObject({
        onHandQty: 20,
        allocatedQty: 0,
        unallocatedQty: 20,
        overcommitted: false,
      });
      const anomalies = (await world.conflictTypesOfProducts([product.id])).filter((type) =>
        ANOMALIES.includes(type),
      );
      expect(anomalies).toEqual([]);
      await world.expectStockLedgerOk([product.id]);

      // Le soir : chaque tablette retire son quota fermé (`SCOPE_EXIT`) et voit le solde du serveur.
      for (const till of [A, B, C]) {
        await till.tablet.pullAll('allocations', till.actor.userId, world.clock.now());
        expect(
          till.tablet.localProjection.has(
            `allocations:STOCK_ALLOCATION:${quotas[till.name as 'A']}`,
          ),
        ).toBe(false);
        await till.tablet.pullAll('stock', till.actor.userId, world.clock.now());
        const balance = till.tablet.localProjection.get(`stock:STOCK_BALANCE:${product.id}`);
        expect(Number(balance?.['qty_on_hand'])).toBe(20);
      }
      return finalState(product, quotas);
    }

    // --- Scénarios ------------------------------------------------------------------------------------

    it('ordre entrelacé, une commande à la fois (A, B, C, A…) : invariants à chaque pas, état nominal', async () => {
      const day = await wf18Day();
      const quotaIds = Object.values(day.quotas);
      for (;;) {
        const busy = [A, B, C].filter((till) => till.tablet.pending(till.actor.userId) > 0);
        if (busy.length === 0) break;
        for (const till of busy) {
          await till.tablet.sync(till.actor.userId, { batchSize: 1, maxBatches: 1 });
          await expectStepInvariants(day.product, quotaIds);
        }
      }
      await expectNominalEnd(day);
    });

    it('ordre inverse, file par file (C, puis B, puis A) : même état final', async () => {
      const day = await wf18Day();
      for (const till of [C, B, A]) await till.tablet.syncUntilSettled(till.actor.userId);
      await expectStepInvariants(day.product, Object.values(day.quotas));
      await expectNominalEnd(day);
    });

    it('trois tablettes qui synchronisent en même temps : même état final, puis le stock libre en ligne', async () => {
      const day = await wf18Day();
      await Promise.all([A, B, C].map((till) => till.tablet.syncUntilSettled(till.actor.userId)));
      await expectNominalEnd(day);

      // Après les libérations, les 20 restants sont du stock libre : D vend en ligne jusqu'à 20.
      const online = (quantity: number) =>
        world.online(D.actor, {
          type: 'sales.sale.record',
          aggregateType: 'SALE',
          occurredAt: at('17:45'),
          payload: {
            fromLocationId: world.counter,
            customerId: D.customerId,
            lines: [world.line(day.product, quantity)],
          },
        });
      expect(codeOf(await online(21))).toBe('INSUFFICIENT_STOCK');
      expect((await online(20)).status).toBe('APPLIED');
      expect(await world.onHand(day.product.id)).toBe(0);
      await world.expectStockLedgerOk([day.product.id]);
    });

    it('variante WF-18 étape 5 : B pousse 31 (appareil modifié) — appliquée, quota à 0, l’unité de trop sur le stock libre', async () => {
      const day = await wf18Day({ bOverride: true });
      for (const till of [A, B, C]) await till.tablet.syncUntilSettled(till.actor.userId);
      const [over] = day.sales.B;
      const result = B.tablet.resultOf(over!.command_id);
      expect(result?.status).toBe('APPLIED_WITH_WARNINGS');
      expect(warningsOf(result)).toContain('ALLOCATION_EXCEEDED');
      expect(await world.onHand(day.product.id)).toBe(19);
      const quotaB = await world.quota(day.quotas.B);
      expect(quotaB).toMatchObject({ status: 'CLOSED', close_cause: 'RELEASED' });
      expect(await consumedBy(day.quotas.B)).toBe(30);
      const types = await world.conflictTypesOfProducts([day.product.id]);
      expect(types.filter((type) => type === 'ALLOCATION_EXCEEDED')).toHaveLength(1);
      expect(types).not.toContain('ALLOCATION_OVERCOMMITTED');
      expect(types).not.toContain('STOCK_NEGATIVE');
      await world.expectStockLedgerOk([day.product.id]);
    });

    it('variante WF-18 étape 6 : quotas actifs, B vend en ligne au-delà de ses 30 dans la limite du non-alloué, D sans quota vend le non-alloué puis hors ligne malgré le blocage', async () => {
      world.setNow(at('07:00'));
      const product = await world.product();
      await world.stockIn(product.id, 100, at('05:00'));
      const quotas = {
        A: await world.grant(A.actor, product.id, 40, at('07:00')),
        B: await world.grant(B.actor, product.id, 30, at('07:00')),
        C: await world.grant(C.actor, product.id, 20, at('07:00')),
      };
      const online = (till: Till, quantity: number, hhmm: string) =>
        world.online(till.actor, {
          type: 'sales.sale.record',
          aggregateType: 'SALE',
          occurredAt: at(hhmm),
          payload: {
            fromLocationId: world.counter,
            customerId: till.customerId,
            lines: [world.line(product, quantity)],
          },
        });
      const unallocated = async () =>
        (
          await allocationPositions(db, {
            locationIds: [world.counter],
            productIds: [product.id],
            now: world.clock.now(),
          })
        )[0]!;

      // Vendeur sans quota, en ligne : le non-alloué seulement (10), refus au-delà.
      world.setNow(at('09:00'));
      expect(codeOf(await online(D, 11, '09:00'))).toBe('INSUFFICIENT_STOCK');
      const dSale = await online(D, 4, '09:01');
      expect(dSale.status, JSON.stringify(dSale)).toBe('APPLIED');
      expect(warningsOf(dSale)).toEqual([]);
      expect(await unallocated()).toMatchObject({
        onHandQty: 96,
        allocatedQty: 90,
        unallocatedQty: 6,
      });

      // B en ligne : son quota (30) puis le non-alloué restant (6) ; une unité de plus est refusée.
      world.setNow(at('10:00'));
      expect(codeOf(await online(B, 37, '10:00'))).toBe('ALLOCATION_EXCEEDED');
      const bSale = await online(B, 36, '10:01');
      expect(bSale.status, JSON.stringify(bSale)).toBe('APPLIED');
      expect(warningsOf(bSale)).toEqual([]);
      expect(await world.remainingOf(quotas.B)).toBe(0);
      expect(await unallocated()).toMatchObject({
        onHandQty: 60,
        allocatedQty: 60,
        unallocatedQty: 0,
      });

      // D hors ligne malgré le blocage (appareil modifié) : appliquée sur le stock commun, signalée
      // `ALLOCATION_EXCEEDED` (motif `ALLOCATION_MISSING`) ; elle entame la part de A et C : `ALLOCATION_OVERCOMMITTED`.
      expect(trySell(D, product, 2, at('11:00')).decision).toMatchObject({
        allowed: false,
        code: 'ALLOCATION_MISSING',
      });
      const forced = sell(D, product, 2, at('11:00'));
      world.setNow(at('11:30'));
      await D.tablet.syncUntilSettled(D.actor.userId);
      const result = D.tablet.resultOf(forced.command_id);
      expect(result?.status, JSON.stringify(result)).toBe('APPLIED_WITH_WARNINGS');
      expect(warningsOf(result)).toContain('ALLOCATION_EXCEEDED');
      const signals = await db
        .selectFrom('sync_sync_conflicts')
        .select(['conflict_type', 'details'])
        .where('conflict_type', 'in', ['ALLOCATION_EXCEEDED', 'ALLOCATION_OVERCOMMITTED'])
        .where(sql<boolean>`JSON_UNQUOTE(JSON_EXTRACT(details, '$.productId')) = ${product.id}`)
        .execute();
      const exceeded = signals.filter((row) => row.conflict_type === 'ALLOCATION_EXCEEDED');
      expect(exceeded).toHaveLength(1);
      const details = exceeded[0]!.details;
      expect(typeof details === 'string' ? JSON.parse(details) : details).toMatchObject({
        reason: 'ALLOCATION_MISSING',
        allocationId: null,
      });
      expect(signals.some((row) => row.conflict_type === 'ALLOCATION_OVERCOMMITTED')).toBe(true);
      expect(await world.onHand(product.id)).toBe(58);
      expect(await world.remainingOf(quotas.A)).toBe(40);
      expect(await world.remainingOf(quotas.C)).toBe(20);
      await world.expectStockLedgerOk([product.id]);
    });

    it('variante : quota de C augmenté en ligne pendant sa journée hors ligne — écart de libération signalé, quota fermé sur le reste du serveur', async () => {
      world.setNow(at('07:00'));
      const product = await world.product();
      await world.stockIn(product.id, 100, at('05:00'));
      const quotaC = await world.grant(C.actor, product.id, 20, at('07:00'));
      await morningPull(C, product.id);
      trySell(C, product, 12, at('10:00'));
      // Midi : le magasinier augmente le quota de C de 5 ; la tablette, hors ligne, ne le sait pas.
      world.setNow(at('12:00'));
      const version = (await world.quota(quotaC)).version;
      await world.ok(world.magP, {
        type: 'inventory.allocation.increase',
        aggregateType: 'STOCK_ALLOCATION',
        aggregateId: quotaC,
        occurredAt: at('12:00'),
        baseVersion: version,
        payload: { quantityBase: 5 },
      });
      const freed = release(C, product, at('17:30'));
      world.setNow(at('18:00'));
      await C.tablet.syncUntilSettled(C.actor.userId);

      expect(C.tablet.resultOf(freed.command_id)?.status).toBe('APPLIED_WITH_WARNINGS');
      expect(warningsOf(C.tablet.resultOf(freed.command_id))).toContain(
        'ALLOCATION_RELEASE_MISMATCH',
      );
      const quota = await world.quota(quotaC);
      expect(quota).toMatchObject({ status: 'CLOSED', close_cause: 'RELEASED' });
      expect(Number(quota.release_declared_remaining)).toBe(8);
      const release_ = (await entries(quotaC)).find((row) => row.entry_type === 'RELEASE');
      expect(Number(release_?.quantity)).toBe(-13);
      const [mismatch] = await world.conflicts('ALLOCATION_RELEASE_MISMATCH', quotaC);
      expect(mismatch).toMatchObject({ owner_role: 'MAGASINIER', applied: 1, status: 'OPEN' });
      expect(await world.onHand(product.id)).toBe(88);
      await world.expectStockLedgerOk([product.id]);
    });

    it('variante : réponse perdue en milieu de file — le renvoi identique ne consomme rien deux fois', async () => {
      world.setNow(at('07:00'));
      const product = await world.product();
      await world.stockIn(product.id, 100, at('05:00'));
      const quotaA = await world.grant(A.actor, product.id, 40, at('07:00'));
      await morningPull(A, product.id);
      for (const [quantity, hhmm] of [
        [5, '09:00'],
        [6, '10:00'],
        [7, '11:00'],
      ] as const) {
        trySell(A, product, quantity, at(hhmm));
      }
      release(A, product, at('17:30'));
      world.setNow(at('18:00'));
      A.tablet.loseNextResponses(1);
      await expect(A.tablet.sync(A.actor.userId, { batchSize: 2 })).rejects.toBeInstanceOf(
        NetworkDownError,
      );
      const results: CommandResult[] = await A.tablet.syncUntilSettled(A.actor.userId);
      expect(results.every((result) => result.status === 'APPLIED')).toBe(true);
      expect(await consumedBy(quotaA)).toBe(18);
      expect((await entries(quotaA)).filter((row) => row.entry_type === 'CONSUME')).toHaveLength(3);
      expect(await world.onHand(product.id)).toBe(82);
      expect((await world.quota(quotaA)).status).toBe('CLOSED');
      await world.expectStockLedgerOk([product.id]);
    });
  },
);
