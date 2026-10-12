/**
 * P5-23 — opération de caisse datée entre deux sessions, synchronisée après l'ouverture de la suivante
 * (revue adverse ; AV-224 ; ADR-032 §4). Routine de WF-15 §5 avec deux tablettes : la tablette A clôture la
 * session du soir ; la tablette B, hors ligne, envoie ensuite la remise du jour à la caisse centrale ; A
 * ouvre la session du lendemain avec un tiroir vide.
 *
 * Avant : l'écart d'ouverture du lendemain, figé sans la remise, imputait un manque à l'ouvreur, et la
 * remise synchronisée ensuite le comptait une seconde fois (registre négatif jusqu'à l'ouverture d'après,
 * puis surplus). Désormais l'écart d'ouverture est corrigé par un ajustement `LATE_BEFORE_OPENING` ; les
 * deux ordres de synchronisation laissent le même registre et le même écart d'ouverture effectif.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  verifyCashSessions,
  verifyCashLedger,
} from '../src/modules/finance/application/public/index.js';
import { fromBin, toBin } from '../src/platform/kysely/uuid-columns.js';
import { closeTestDb, db, freshUuid } from './helpers.js';
import { tx } from './cash-transfer-fixtures.js';
import { PosWorld, PRICE, warningsOf, type Actor } from './pos-world.js';

const at = (day: string, hhmm: string) => `${day}T${hhmm}:00.000Z`;

describe('P5-23 — opération entre deux sessions de caisse (AV-224)', { timeout: 300_000 }, () => {
  let world: PosWorld;
  let tabletA: Actor;
  let tabletB: Actor;

  beforeAll(async () => {
    world = await PosWorld.create({ now: at('2026-09-28', '06:00'), sellers: 2 });
    tabletA = world.sellers[0]!;
    tabletB = world.sellers[1]!;
  }, 120_000);

  afterAll(async () => {
    try {
      await world?.close(at('2026-10-03', '23:00'));
    } finally {
      await closeTestDb();
    }
  });

  const session = (id: string) =>
    db
      .selectFrom('finance_cash_sessions')
      .selectAll()
      .where('id', '=', toBin(id))
      .executeTakeFirstOrThrow();
  const openingAdjustments = (sessionId: string) =>
    db
      .selectFrom('finance_cash_session_adjustments')
      .selectAll()
      .where('session_id', '=', toBin(sessionId))
      .where('cause', '=', 'LATE_BEFORE_OPENING')
      .execute();
  const balance = async () =>
    Number(
      (
        await db
          .selectFrom('finance_cash_accounts')
          .select('balance_xaf')
          .where('id', '=', toBin(world.posAcc))
          .executeTakeFirstOrThrow()
      ).balance_xaf,
    );

  /**
   * Journée du PDV : session ouverte à 0, vente en espèces de 1 000, clôture comptée à 1 000 ; la remise de
   * 1 000 est saisie hors ligne par B à 18:10, après la clôture. `remitBeforeOpening` : B synchronise avant
   * l'ouverture du lendemain (sinon après).
   */
  async function day(
    first: string,
    next: string,
    remitBeforeOpening: boolean,
  ): Promise<{ readonly nextSession: string; readonly product: string }> {
    world.setNow(at(first, '08:00'));
    const product = await world.product(`Journée ${first}`);
    await world.stockIn(product.id, 10, at(first, '07:00'));
    const sessionId = freshUuid();
    await world.ok(tabletA, {
      type: 'finance.cash_session.open',
      aggregateType: 'CASH_SESSION',
      aggregateId: sessionId,
      occurredAt: at(first, '08:00'),
      payload: { cashAccountId: world.posAcc, countedXaf: 0 },
    });
    world.setNow(at(first, '09:00'));
    await world.ok(tabletA, {
      type: 'sales.sale.record',
      aggregateType: 'SALE',
      occurredAt: at(first, '09:00'),
      payload: {
        fromLocationId: world.counter,
        lines: [world.line(product, 2)],
        payments: [{ methodCode: 'ESPECES', amountXaf: 2 * PRICE }],
      },
    });
    world.setNow(at(first, '18:00'));
    await world.ok(tabletA, {
      type: 'finance.cash_session.close',
      aggregateType: 'CASH_SESSION',
      aggregateId: sessionId,
      occurredAt: at(first, '18:00'),
      payload: { countedXaf: 2 * PRICE },
    });
    expect((await session(sessionId)).status).toBe('VALIDATED');

    const tablet = world.tablet(tabletB);
    tablet.enqueue(tabletB.userId, {
      type: 'finance.cash_transfer.send',
      aggregateType: 'CASH_TRANSFER',
      occurredAt: at(first, '18:10'),
      payload: { fromAccountId: world.posAcc, toAccountId: world.central, amountXaf: 2 * PRICE },
    });
    world.setNow(at(first, '18:20'));
    if (remitBeforeOpening) {
      const [sent] = await tablet.sync(tabletB.userId);
      expect(sent?.status, JSON.stringify(sent)).toMatch(/^APPLIED/);
    }

    // Le lendemain, A ouvre avec un tiroir vide (la remise est partie la veille).
    world.setNow(at(next, '08:00'));
    const nextSession = freshUuid();
    await world.ok(tabletA, {
      type: 'finance.cash_session.open',
      aggregateType: 'CASH_SESSION',
      aggregateId: nextSession,
      occurredAt: at(next, '08:00'),
      payload: { cashAccountId: world.posAcc, countedXaf: 0 },
    });
    if (!remitBeforeOpening) {
      world.setNow(at(next, '09:00'));
      const [sent] = await tablet.sync(tabletB.userId);
      expect(sent?.status, JSON.stringify(sent)).toMatch(/^APPLIED/);
    }
    return { nextSession, product: product.id };
  }

  it('remise synchronisée après l’ouverture suivante : l’écart d’ouverture est corrigé, jamais compté deux fois', async () => {
    const { nextSession } = await day('2026-09-28', '2026-09-29', false);
    const opened = await session(nextSession);
    // Écart d'ouverture figé sans la remise : −1 000 ; corrigé par un ajustement de +1 000.
    expect(Number(opened.opening_variance_xaf)).toBe(-2 * PRICE);
    const [adjustment] = await openingAdjustments(nextSession);
    expect(adjustment).toMatchObject({
      treatment: 'INCLUDED_IN_VALIDATION',
      status: 'PENDING',
    });
    expect([
      Number(adjustment!.delta_xaf),
      Number(adjustment!.variance_before_xaf),
      Number(adjustment!.variance_after_xaf),
    ]).toEqual([2 * PRICE, -2 * PRICE, 0]);
    // Le registre égale le tiroir (vide), au lieu de −1 000.
    expect(await balance()).toBe(0);

    // Clôture sans écart : l'ajustement d'ouverture se valide avec la session (jamais d'office).
    world.setNow(at('2026-09-29', '18:00'));
    const closed = await world.ok(tabletA, {
      type: 'finance.cash_session.close',
      aggregateType: 'CASH_SESSION',
      aggregateId: nextSession,
      occurredAt: at('2026-09-29', '18:00'),
      payload: { countedXaf: 0 },
    });
    expect(warningsOf(closed)).toEqual([]);
    expect((await session(nextSession)).status).toBe('PENDING_VALIDATION');
    world.setNow(at('2026-09-29', '18:30'));
    await world.ok(world.fin, {
      type: 'finance.cash_session.validate',
      aggregateType: 'CASH_SESSION',
      aggregateId: nextSession,
      occurredAt: at('2026-09-29', '18:30'),
      payload: { reason: 'Remise envoyée après la clôture de la veille' },
    });
    expect((await session(nextSession)).status).toBe('VALIDATED');
    expect((await openingAdjustments(nextSession))[0]!.status).toBe('VALIDATED');
    const sessions = await verifyCashSessions(db, { cashAccountIds: [world.posAcc] });
    expect(sessions.breaches).toEqual([]);
    const ledger = await tx((trx) => verifyCashLedger(trx, { cashAccountIds: [world.posAcc] }));
    expect(ledger.ok).toBe(true);
  });

  it('remise synchronisée avant l’ouverture suivante : même registre, même écart d’ouverture effectif, aucun ajustement', async () => {
    const before = await balance();
    const { nextSession } = await day('2026-09-30', '2026-10-01', true);
    const opened = await session(nextSession);
    expect(Number(opened.opening_variance_xaf)).toBe(0);
    expect(await openingAdjustments(nextSession)).toEqual([]);
    expect((await balance()) - before).toBe(0);
    const sessions = await verifyCashSessions(db, { cashAccountIds: [world.posAcc] });
    expect(sessions.breaches).toEqual([]);
    expect(fromBin(opened.cash_account_id)).toBe(world.posAcc);
  });
});
