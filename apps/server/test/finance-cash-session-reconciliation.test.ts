/**
 * Balayage des sessions de caisse (P5-22 ; INV-FIN-05, 06, 11 ; BR-DIS-006) : `verifyCashSessions`, sans
 * verrou, sur des sessions réelles (application complète, vraies commandes) — ouverture, vente en espèces,
 * clôture avec un manque, vente hors ligne arrivée après la clôture (réévaluation par le delta, ADR-032
 * §6). Le résultat concorde avec la vérification d'une session (`verifyCashSessionVariance`, lectures
 * verrouillantes). Ruptures fabriquées dans une transaction toujours annulée (`withTestUow`) : le registre,
 * les sessions et les ajustements sont immuables, une rupture validée polluerait la base partagée.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifyCashSessions } from '../src/modules/finance/application/public/index.js';
import { verifyCashSessionVariance } from '../src/modules/finance/application/cash-session-validation.js';
import { toBin } from '../src/platform/kysely/uuid-columns.js';
import { closeTestDb, db, freshUuid, withTestUow } from './helpers.js';
import { PosWorld, PRICE, type Actor, type Sellable } from './pos-world.js';

const DAY = '2026-10-06';
const at = (hhmm: string) => `${DAY}T${hhmm}:00.000Z`;

describe('verifyCashSessions : balayage des sessions de caisse (P5-22)', () => {
  let world: PosWorld;
  let seller: Actor;
  let product: Sellable;
  const session = freshUuid();

  beforeAll(async () => {
    world = await PosWorld.create({ now: at('07:00'), sellers: 1 });
    seller = world.sellers[0]!;
    product = await world.product();
    await world.stockIn(product.id, 50, at('07:00'));
    const sale = (hhmm: string, quantity: number) => ({
      type: 'sales.sale.record',
      aggregateType: 'SALE',
      occurredAt: at(hhmm),
      payload: {
        fromLocationId: world.counter,
        lines: [world.line(product, quantity)],
        payments: [{ methodCode: 'ESPECES', amountXaf: quantity * PRICE }],
      },
    });
    world.setNow(at('08:00'));
    await world.ok(seller, {
      type: 'finance.cash_session.open',
      aggregateType: 'CASH_SESSION',
      aggregateId: session,
      occurredAt: at('08:00'),
      payload: { cashAccountId: world.posAcc, countedXaf: 0 },
    });
    // Saisie hors ligne à 11:00, envoyée après la clôture : réévaluation par le delta.
    const tablet = world.tablet(seller);
    tablet.enqueue(seller.userId, sale('11:00', 1));
    world.setNow(at('09:00'));
    await world.ok(seller, sale('09:00', 2));
    world.setNow(at('12:00'));
    // Attendu 1 000 (vente de 09:00), compté 900 : écart de clôture −100.
    await world.ok(seller, {
      type: 'finance.cash_session.close',
      aggregateType: 'CASH_SESSION',
      aggregateId: session,
      occurredAt: at('12:00'),
      payload: { countedXaf: 900 },
    });
    world.setNow(at('12:30'));
    await tablet.syncUntilSettled(seller.userId);
  }, 120_000);

  afterAll(async () => {
    try {
      await world?.close(at('13:00'));
    } finally {
      await closeTestDb();
    }
  });

  it('session réelle, réévaluée après la clôture : aucune rupture, et le même résultat que la vérification d’une session', async () => {
    const swept = await verifyCashSessions(db, { sessionIds: [session] });
    expect(swept).toEqual({ ok: true, sessionsChecked: 1, breaches: [] });
    const adjustments = await db
      .selectFrom('finance_cash_session_adjustments')
      .select('delta_xaf')
      .where('session_id', '=', toBin(session))
      .execute();
    expect(adjustments.map((a) => Number(a.delta_xaf))).toEqual([-PRICE]);
    const single = await db.transaction().execute((trx) => verifyCashSessionVariance(trx, session));
    expect(single).toEqual({
      ok: true,
      countedMinusExpectedXaf: 900 - 3 * PRICE,
      postedMovementsXaf: 900 - 3 * PRICE,
      recordedVarianceXaf: 900 - 3 * PRICE,
    });
    // Portée par compte : la même session, avec les autres sessions de la caisse (aucune ici).
    expect((await verifyCashSessions(db, { cashAccountIds: [world.posAcc] })).ok).toBe(true);
  });

  it('INV-FIN-05 et 11 : un écart posé sans trace et un encaissement de la fenêtre non réévalué sont vus', async () => {
    await withTestUow(async (trx) => {
      const movement = (overrides: Record<string, unknown>) =>
        trx
          .insertInto('finance_cash_movements')
          .values({
            id: toBin(freshUuid()),
            cash_account_id: toBin(world.posAcc),
            direction: 'OUT',
            amount_xaf: 50,
            movement_type: 'SESSION_VARIANCE',
            source_doc_type: 'CASH_SESSION',
            source_doc_id: toBin(session),
            occurred_at: new Date(at('12:00')),
            created_by: toBin(world.fin.userId),
            ...overrides,
          } as never)
          .execute();
      // Écart de 50 posé sur la session par une commande étrangère à son ouverture et à sa clôture.
      await movement({ command_id: null, occurred_at: new Date(at('12:05')) });
      // Encaissement de 10:30 dans la fenêtre, jamais réévalué.
      await movement({
        direction: 'IN',
        amount_xaf: 200,
        movement_type: 'CUSTOMER_PAYMENT',
        source_doc_type: 'CUSTOMER_PAYMENT',
        source_doc_id: toBin(freshUuid()),
        occurred_at: new Date(at('10:30')),
      });
      const swept = await verifyCashSessions(trx, { sessionIds: [session] });
      expect(swept.ok).toBe(false);
      const issues = swept.breaches.map((b) => `${b.invariant}:${b.issue}`).sort();
      // L'écart sans trace n'entre pas dans les écarts posés : la fenêtre élargie de 200 les met en défaut.
      expect(issues).toEqual([
        'INV-FIN-05:UNTRACKED_VARIANCE_MOVEMENT',
        'INV-FIN-11:POSTED_NOT_COUNTED_MINUS_EXPECTED',
        'INV-FIN-11:RECORDED_NOT_COUNTED_MINUS_EXPECTED',
      ]);
    });
  });

  it('BR-DIS-006 : une session posée sur un compte qui n’est pas une caisse de PDV est vue', async () => {
    await withTestUow(async (trx) => {
      const intruder = freshUuid();
      await trx
        .insertInto('finance_cash_sessions')
        .values({
          id: toBin(intruder),
          cash_account_id: toBin(world.central),
          site_id: toBin(world.siteP),
          opened_by: toBin(world.fin.userId),
          opened_at: new Date(at('08:00')),
          opening_counted_xaf: 0,
          opening_expected_xaf: 0,
          opening_variance_xaf: 0,
          created_by: toBin(world.fin.userId),
        } as never)
        .execute();
      const swept = await verifyCashSessions(trx, { sessionIds: [intruder] });
      expect(swept.breaches).toMatchObject([
        { sessionId: intruder, invariant: 'BR-DIS-006', issue: 'ACCOUNT_NOT_POS' },
      ]);
    });
  });

  it('portées vides : rien à vérifier', async () => {
    expect(await verifyCashSessions(db, { sessionIds: [] })).toEqual({
      ok: true,
      sessionsChecked: 0,
      breaches: [],
    });
  });
});
