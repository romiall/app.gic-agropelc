/**
 * AT-036 croisé avec le PDV (P5-21) : horloges de tablettes décalées de deux heures sur une journée de
 * PDV partagé (ADR-016, BR-SYN-011, INV-GLO-02, REQ-063 ; ADR-032 §2 ; ADR-033), sur l'application
 * complète et le vrai service de synchronisation.
 *
 * A est à l'heure et tient la caisse ; B retarde de deux heures, C avance de deux heures. Attendu :
 * - l'écart est mesuré à chaque envoi (`clock_skew_ms`, `last_clock_skew_ms`) et chaque résultat porte
 *   `CLOCK_SUSPECT`, les documents `clock_suspect = 1` ; `occurred_at` est gardé tel que la tablette
 *   l'a daté (aucune correction silencieuse) ;
 * - la date future se juge après correction de l'écart : la vente de C, datée par sa tablette deux
 *   heures « dans le futur », est appliquée (elle était rejetée définitivement avant P5-21) ;
 * - tout ce qui se juge sur `occurred_at` suit la date de la tablette : l'espèce de B tombe avant
 *   l'ouverture de la caisse (`CASH_SESSION_MISSING`), le mouvement « futur » de C empêche la clôture de
 *   A d'être validée d'office (`CASH_SESSION_CLOSE_BEFORE_MOVEMENTS`), une vente de B faite après minuit
 *   reste au jour métier précédent et sur son quota pourtant échu, la garde de C bloque deux heures
 *   trop tôt ;
 * - la fraîcheur des appareils reste en heure serveur.
 * L'alerte `CLOCK_SKEW` relève de P9 (D13) : non testée ici.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { decideLocalConsumption } from '@gic/domain';
import type { CommandResult, RawCommandEnvelope } from '@gic/contracts';
import { deviceFreshness } from '../src/sync/device-freshness.js';
import { toBin } from '../src/platform/kysely/uuid-columns.js';
import type { OfflineDevice } from './device-harness.js';
import { closeTestDb, db, freshUuid } from './helpers.js';
import { PosWorld, PRICE, warningsOf, type Actor, type Sellable } from './pos-world.js';

const DAY = '2026-10-05';
const NEXT = '2026-10-06';
const at = (hhmm: string, day = DAY) => `${day}T${hhmm}:00.000Z`;
const TWO_HOURS = 2 * 3_600_000;

describe(
  'AT-036 × PDV : horloges de tablettes décalées de deux heures',
  { timeout: 300_000 },
  () => {
    let world: PosWorld;
    let A: Actor;
    let B: Actor;
    let C: Actor;
    let product: Sellable;
    let customer: string;
    const quotas = { A: '', B: '', C: '' };

    const sale = (
      tablet: OfflineDevice,
      author: Actor,
      quantity: number,
      options: { readonly cash?: boolean } = {},
    ): RawCommandEnvelope =>
      tablet.enqueue(author.userId, {
        type: 'sales.sale.record',
        aggregateType: 'SALE',
        // Datée par l'horloge de la tablette, comme sur un vrai appareil.
        occurredAt: tablet.deviceNow().toISOString(),
        payload: {
          fromLocationId: world.counter,
          ...(options.cash ? {} : { customerId: customer }),
          lines: [world.line(product, quantity)],
          ...(options.cash
            ? { payments: [{ methodCode: 'ESPECES', amountXaf: quantity * PRICE }] }
            : {}),
        },
      });

    const inboxOf = (commandId: string) =>
      db
        .selectFrom('sync_command_inbox')
        .select(['status', 'occurred_at', 'clock_skew_ms'])
        .where('command_id', '=', toBin(commandId))
        .executeTakeFirstOrThrow();

    const saleOf = (saleId: string) =>
      db
        .selectFrom('sales_sales')
        .select([
          'clock_suspect',
          'occurred_at',
          // Jour métier (colonne générée, fuseau Africa/Douala).
          sql<string>`DATE_FORMAT(business_date, '%Y-%m-%d')`.as('business_date'),
        ])
        .where('id', '=', toBin(saleId))
        .executeTakeFirstOrThrow();

    const lastSkew = async (deviceId: string) =>
      Number(
        (
          await db
            .selectFrom('sync_device_sync_state')
            .select('last_clock_skew_ms')
            .where('device_id', '=', toBin(deviceId))
            .where('dataset', '=', '_device')
            .executeTakeFirstOrThrow()
        ).last_clock_skew_ms,
      );

    const resultOf = (tablet: OfflineDevice, envelope: RawCommandEnvelope): CommandResult => {
      const result = tablet.resultOf(envelope.command_id);
      if (!result) throw new Error(`Aucune réponse pour ${envelope.command_type}`);
      return result;
    };

    beforeAll(async () => {
      world = await PosWorld.create({ now: at('04:00'), sellers: 3 });
      [A, B, C] = world.sellers as [Actor, Actor, Actor];
      product = await world.product();
      customer = await world.customer('Client des tablettes');
      await world.stockIn(product.id, 100, at('05:00'));
      world.setNow(at('07:00'));
      quotas.A = await world.grant(A, product.id, 20, at('07:00'));
      quotas.B = await world.grant(B, product.id, 20, at('07:00'));
      quotas.C = await world.grant(C, product.id, 20, at('07:00'));
      world.tablet(B).setClockOffset(-TWO_HOURS);
      world.tablet(C).setClockOffset(TWO_HOURS);
    }, 120_000);

    afterAll(async () => {
      try {
        await world?.close(at('01:00', NEXT));
      } finally {
        await closeTestDb();
      }
    });

    it('une journée de PDV avec des horloges fausses : marquée, jamais corrigée, jugée sur la date de la tablette', async () => {
      const tabletA = world.tablet(A);
      const tabletB = world.tablet(B);
      const tabletC = world.tablet(C);

      // 08:00 : A (à l'heure) ouvre la caisse hors ligne et synchronise.
      world.setNow(at('08:00'));
      const session = freshUuid();
      const open = tabletA.enqueue(A.userId, {
        type: 'finance.cash_session.open',
        aggregateType: 'CASH_SESSION',
        aggregateId: session,
        occurredAt: tabletA.deviceNow().toISOString(),
        payload: { cashAccountId: world.posAcc, countedXaf: 0 },
      });
      world.setNow(at('08:05'));
      await tabletA.syncUntilSettled(A.userId);
      expect(resultOf(tabletA, open).status).toBe('APPLIED');

      // 09:00 vraie : B (07:00 sur sa tablette) encaisse 2 en espèces ; C (11:00) vend 3 à crédit.
      world.setNow(at('09:00'));
      const bCash = sale(tabletB, B, 2, { cash: true });
      const cCredit = sale(tabletC, C, 3);
      expect(bCash.occurred_at).toBe(at('07:00'));
      expect(cCredit.occurred_at).toBe(at('11:00'));
      world.setNow(at('09:30'));
      await tabletB.syncUntilSettled(B.userId);
      // Retard : rien n'est refusé ; l'espèce tombe avant l'ouverture de la caisse.
      expect(resultOf(tabletB, bCash).status).toBe('APPLIED_WITH_WARNINGS');
      expect(warningsOf(resultOf(tabletB, bCash))).toEqual(
        expect.arrayContaining(['CASH_SESSION_MISSING', 'CLOCK_SUSPECT']),
      );

      // 10:00 : A vend 4 en espèces et synchronise (aucun écart, aucun drapeau).
      world.setNow(at('10:00'));
      const aCash = sale(tabletA, A, 4, { cash: true });
      world.setNow(at('10:05'));
      await tabletA.syncUntilSettled(A.userId);
      expect(resultOf(tabletA, aCash).status).toBe('APPLIED');
      expect(warningsOf(resultOf(tabletA, aCash))).toEqual([]);

      // 17:30 vraie : C (19:30 sur sa tablette) encaisse 1 en espèces ; il synchronise à 18:00.
      world.setNow(at('17:30'));
      const cCash = sale(tabletC, C, 1, { cash: true });
      expect(cCash.occurred_at).toBe(at('19:30'));
      world.setNow(at('18:00'));
      await tabletC.syncUntilSettled(C.userId);
      // Datée 1 h 30 « dans le futur » de l'heure serveur, mais 30 min avant l'envoi une fois l'écart
      // corrigé : appliquée (INV-GLO-02), avec le drapeau.
      for (const envelope of [cCredit, cCash]) {
        expect(resultOf(tabletC, envelope).status, envelope.occurred_at).toMatch(/^APPLIED/);
        expect(warningsOf(resultOf(tabletC, envelope))).toContain('CLOCK_SUSPECT');
      }

      // 19:00 : A clôt sa caisse hors ligne (compté = son espèce). Le mouvement de C daté 19:30 est
      // postérieur : la clôture est appliquée, jamais validée d'office (AV-171).
      world.setNow(at('19:00'));
      const close = tabletA.enqueue(A.userId, {
        type: 'finance.cash_session.close',
        aggregateType: 'CASH_SESSION',
        aggregateId: session,
        occurredAt: tabletA.deviceNow().toISOString(),
        payload: { countedXaf: 4 * PRICE },
      });
      world.setNow(at('19:05'));
      await tabletA.syncUntilSettled(A.userId);
      expect(warningsOf(resultOf(tabletA, close))).toContain('CASH_SESSION_CLOSE_BEFORE_MOVEMENTS');
      const closed = await db
        .selectFrom('finance_cash_sessions')
        .select(['status', 'closing_expected_xaf', 'clock_suspect'])
        .where('id', '=', toBin(session))
        .executeTakeFirstOrThrow();
      // Attendu sur la fenêtre [08:00, 19:00[ : l'espèce de A seule (B avant, C après, par leurs dates).
      expect(Number(closed.closing_expected_xaf)).toBe(4 * PRICE);
      expect(closed.status).toBe('PENDING_VALIDATION');

      // 21:30 vraie (23:30 sur C) : la garde de la tablette bloque déjà, son quota (23:00) n'est pas échu.
      world.setNow(at('21:30'));
      const quotaC = await world.quota(quotas.C);
      const guard = decideLocalConsumption({
        custodyMode: 'SHARED',
        requested: 1,
        localBalance: 0,
        holdsQuota: true,
        quotaRemaining: Number(quotaC.quantity_remaining),
        quotaValidUntil: quotaC.valid_until,
        now: tabletC.deviceNow(),
        overAllocationAllowed: false,
      });
      expect(quotaC.valid_until?.toISOString()).toBe(at('23:00'));
      expect(guard).toMatchObject({ allowed: false, code: 'ALLOCATION_EXPIRED' });

      // 00:30 du lendemain vraie (22:30 la veille sur B) : vente à crédit de B, synchronisée à 00:40.
      world.setNow(at('00:30', NEXT));
      const bLate = sale(tabletB, B, 5);
      expect(bLate.occurred_at).toBe(at('22:30'));
      world.setNow(at('00:40', NEXT));
      await tabletB.syncUntilSettled(B.userId);
      expect(resultOf(tabletB, bLate).status).toBe('APPLIED');
      expect(warningsOf(resultOf(tabletB, bLate))).toEqual(['CLOCK_SUSPECT']);
      const late = await saleOf(bLate.aggregate_id);
      // Jour métier et quota jugés sur la date de la tablette : la veille, sur le quota pourtant échu.
      expect(late.business_date).toBe(DAY);
      expect(await world.remainingOf(quotas.B)).toBe(13);

      // Écart mesuré, marqué, jamais corrigé.
      for (const [tablet, envelope, skew] of [
        [tabletB, bCash, TWO_HOURS],
        [tabletC, cCash, -TWO_HOURS],
        [tabletA, aCash, 0],
      ] as const) {
        const inbox = await inboxOf(envelope.command_id);
        expect(inbox.occurred_at.toISOString()).toBe(envelope.occurred_at);
        expect(Number(inbox.clock_skew_ms)).toBe(skew);
        const document = await saleOf(envelope.aggregate_id);
        expect(document.occurred_at.toISOString()).toBe(envelope.occurred_at);
        expect(document.clock_suspect).toBe(skew === 0 ? 0 : 1);
        void tablet;
      }
      expect(await lastSkew(B.deviceId)).toBe(TWO_HOURS);
      expect(await lastSkew(C.deviceId)).toBe(-TWO_HOURS);

      // Fraîcheur en heure serveur : dernier envoi de C = 18:00 serveur, jamais l'heure de sa tablette.
      const report = await deviceFreshness(db, {
        deviceIds: [B.deviceId, C.deviceId],
        now: world.clock.now(),
      });
      const freshC = report.devices.find((device) => device.deviceId === C.deviceId)!;
      expect(freshC.lastPushAt?.toISOString()).toBe(at('18:00'));
      const freshB = report.devices.find((device) => device.deviceId === B.deviceId)!;
      expect(freshB.lastPushAt?.toISOString()).toBe(at('00:40', NEXT));
      expect(freshB.stale).toBe(false);

      await world.expectStockLedgerOk([product.id]);
      await world.expectCashOk([session], []);
    });
  },
);
