/**
 * « PDV toute une journée hors ligne » (P5-21) : trois tablettes d'un PDV partagé jouent une journée
 * entière sans réseau — caisse (ouverture, clôture avec un manquant de 500, remise de fonds), ventes en
 * espèces, mobile money et à crédit (100 par tablette : la journée type de NFR-07), annulation directe,
 * réception de transfert, perte, quotas d'appareil et leur libération — puis synchronisent le soir
 * (WF-16 : lots de 50, dans l'ordre de `device_seq`). Application complète, vrai service de
 * synchronisation, rôles du seed.
 *
 * La même journée est jouée sur deux PDV neufs, synchronisés dans deux ordres opposés : la tablette
 * de la caisse d'abord (les ventes des autres arrivent après la clôture : réévaluation par le delta),
 * ou en dernier (leurs encaissements arrivent avant l'ouverture : `CASH_SESSION_MISSING`, résolu par
 * l'ouverture). Attendu (ADR-032, ADR-033, BR-SYN-007, INV-SYN-04) : aucun fait rejeté ; stock, quotas,
 * registre de trésorerie, écart **courant** de la session (−500, compté une seule fois) et tableau de
 * distribution identiques dans les deux ordres ; état local de chaque tablette égal au serveur.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { distributionDashboardResponseSchema, type RawCommandEnvelope } from '@gic/contracts';
import { toBin } from '../src/platform/kysely/uuid-columns.js';
import type { OfflineDevice } from './device-harness.js';
import { closeTestDb, db, freshUuid, recentBusinessDay } from './helpers.js';
import { PosWorld, PRICE, codeOf, type Actor, type Sellable } from './pos-world.js';

/** NFR-07 : journée type d'un vendeur, 100 ventes (réglable pour un essai de pointe). */
const SALES = Number(process.env.P5_DAY_SALES ?? 100);
/** Jour récent : le jeu `sales_recent` se calcule sur l'heure réelle (7 jours). */
const DAY = recentBusinessDay(2);
const at = (hhmm: string) => `${DAY}T${hhmm}:00.000Z`;
const minutes = (base: string, delta: number) =>
  new Date(new Date(at(base)).getTime() + delta * 60_000).toISOString();

type TabletName = 'A' | 'B' | 'C';
type Method = 'CASH' | 'MOBILE' | 'CREDIT';

interface PlannedSale {
  readonly tablet: TabletName;
  readonly index: number;
  readonly product: 'P1' | 'P2';
  readonly quantity: number;
  readonly method: Method;
  readonly occurredAt: string;
}

/** La journée, déterministe : 100 ventes par tablette, de 08:05 à 16:20 (décalées par tablette). */
function plan(): PlannedSale[] {
  const sales: PlannedSale[] = [];
  for (const [offset, tablet] of (['A', 'B', 'C'] as const).entries()) {
    for (let index = 0; index < SALES; index++) {
      sales.push({
        tablet,
        index,
        product: index % 3 === 2 ? 'P2' : 'P1',
        quantity: 1 + (index % 2),
        method: index % 10 < 7 ? 'CASH' : index % 10 < 9 ? 'MOBILE' : 'CREDIT',
        occurredAt: minutes('08:05', index * 5 + offset),
      });
    }
  }
  return sales;
}

const PLAN = plan();
const LOSS = 3;
const TRANSFER = 60;
const SHORTAGE = 500;
const demand = (tablet: TabletName, product: 'P1' | 'P2') =>
  PLAN.filter((s) => s.tablet === tablet && s.product === product).reduce(
    (sum, s) => sum + s.quantity,
    0,
  );
/** Vente annulée par A cinq minutes après (annulation directe, BR-VEN-028) : la première, en espèces. */
const CANCELLED = PLAN.find((s) => s.tablet === 'A' && s.index === 0)!;
const cashOf = (s: PlannedSale) => (s.method === 'CASH' ? s.quantity * PRICE : 0);
/** Espèces attendues dans la caisse : toutes les ventes en espèces, moins le remboursement. */
const EXPECTED_CASH = PLAN.reduce((sum, s) => sum + cashOf(s), 0) - cashOf(CANCELLED);
const COUNTED = EXPECTED_CASH - SHORTAGE;
const amountOf = (method: Method, tablet?: TabletName) =>
  PLAN.filter((s) => s.method === method && (tablet === undefined || s.tablet === tablet)).reduce(
    (sum, s) => sum + s.quantity * PRICE,
    0,
  );
/** Mobile money : tout encaissé sur le compte mobile (la vente annulée est en espèces). */
const EXPECTED_MOBILE = amountOf('MOBILE');

interface DayResult {
  readonly world: PosWorld;
  readonly products: Record<'P1' | 'P2', Sellable>;
  readonly session: string;
  readonly remise: string;
  readonly tablets: Record<TabletName, { actor: Actor; tablet: OfflineDevice }>;
  readonly envelopes: RawCommandEnvelope[];
  readonly quotas: Record<string, string>;
  readonly local: Record<string, number>;
  readonly customers: Record<TabletName, string>;
}

/** Monde neuf, matin en ligne, journée hors ligne en file, synchronisation du soir dans `order`. */
async function playDay(order: readonly TabletName[], worlds: PosWorld[]): Promise<DayResult> {
  const world = await PosWorld.create({ now: at('05:00'), sellers: 3 });
  worlds.push(world);
  const [A, B, C] = world.sellers as [Actor, Actor, Actor];
  const actors: Record<TabletName, Actor> = { A, B, C };
  const products = { P1: await world.product('Poulet de chair'), P2: await world.product('Œufs') };
  const customers: Record<TabletName, string> = {
    A: await world.customer('Client crédit A'),
    B: await world.customer('Client crédit B'),
    C: await world.customer('Client crédit C'),
  };

  // Matin, en ligne : stocks, quotas au plus juste (+5 de marge, +la perte pour A), transfert expédié.
  const grants: Record<string, number> = {};
  for (const tablet of ['A', 'B', 'C'] as const) {
    for (const product of ['P1', 'P2'] as const) {
      grants[`${tablet}:${product}`] =
        demand(tablet, product) + 5 + (tablet === 'A' && product === 'P1' ? LOSS : 0);
    }
  }
  const total = (product: 'P1' | 'P2') =>
    (['A', 'B', 'C'] as const).reduce((sum, t) => sum + grants[`${t}:${product}`]!, 0);
  await world.stockIn(products.P1.id, total('P1') + 20, at('05:00'));
  await world.stockIn(products.P2.id, total('P2') + 10, at('05:00'));
  await world.stockIn(products.P1.id, 100, at('05:00'), world.store);
  world.setNow(at('06:45'));
  const transferId = freshUuid();
  await world.ok(world.magS, {
    type: 'inventory.transfer.dispatch',
    aggregateType: 'STOCK_TRANSFER',
    aggregateId: transferId,
    occurredAt: at('06:45'),
    payload: {
      fromLocationId: world.store,
      toLocationId: world.counter,
      lines: [{ productId: products.P1.id, unitCode: 'PIECE', quantityBase: TRANSFER }],
    },
  });
  world.setNow(at('07:00'));
  const quotas: Record<string, string> = {};
  for (const tablet of ['A', 'B', 'C'] as const) {
    for (const product of ['P1', 'P2'] as const) {
      quotas[`${tablet}:${product}`] = await world.grant(
        actors[tablet],
        products[product].id,
        grants[`${tablet}:${product}`]!,
        at('07:00'),
      );
    }
  }

  // Avant de partir, chaque tablette télécharge ses jeux ; la tablette A reçoit le transfert.
  world.setNow(at('07:30'));
  const tablets = {} as DayResult['tablets'];
  for (const tablet of ['A', 'B', 'C'] as const) {
    const device = world.tablet(actors[tablet]);
    tablets[tablet] = { actor: actors[tablet], tablet: device };
    for (const dataset of ['allocations', 'stock', 'transfers', 'cash']) {
      await device.pullAll(dataset, actors[tablet].userId, world.clock.now());
    }
    for (const product of ['P1', 'P2'] as const) {
      const quota = device.localProjection.get(
        `allocations:STOCK_ALLOCATION:${quotas[`${tablet}:${product}`]}`,
      );
      expect(Number(quota?.['quantity_remaining'])).toBe(grants[`${tablet}:${product}`]);
    }
    device.goOffline();
  }
  expect(tablets.A.tablet.localProjection.has(`transfers:STOCK_TRANSFER:${transferId}`)).toBe(true);
  const [transferLine] = await db
    .selectFrom('inventory_stock_transfer_lines')
    .select('id')
    .where('transfer_id', '=', toBin(transferId))
    .execute();

  // Journée hors ligne : chaque tablette met ses commandes en file, dans l'ordre chronologique.
  const local: Record<string, number> = { ...grants };
  const envelopes: RawCommandEnvelope[] = [];
  const enqueue = (tablet: TabletName, spec: Parameters<OfflineDevice['enqueue']>[1]) => {
    const envelope = tablets[tablet].tablet.enqueue(actors[tablet].userId, spec);
    envelopes.push(envelope);
    return envelope;
  };
  const session = freshUuid();
  enqueue('A', {
    type: 'finance.cash_session.open',
    aggregateType: 'CASH_SESSION',
    aggregateId: session,
    occurredAt: at('07:55'),
    payload: { cashAccountId: world.posAcc, countedXaf: 0 },
  });
  const extras: {
    readonly at: string;
    readonly tablet: TabletName;
    readonly spec: () => Parameters<OfflineDevice['enqueue']>[1];
  }[] = [
    {
      at: at('10:30'),
      tablet: 'A',
      spec: () => ({
        type: 'inventory.transfer.receive',
        aggregateType: 'STOCK_TRANSFER',
        aggregateId: transferId,
        occurredAt: at('10:30'),
        payload: {
          transferId,
          lines: [{ transferLineId: PosWorld.id(transferLine!.id), receivedQtyBase: TRANSFER }],
        },
      }),
    },
    {
      at: at('12:00'),
      tablet: 'A',
      spec: () => {
        local['A:P1'] = local['A:P1']! - LOSS;
        return {
          type: 'inventory.loss.declare',
          aggregateType: 'STOCK_LOSS',
          occurredAt: at('12:00'),
          payload: {
            locationId: world.counter,
            productId: products.P1.id,
            quantityBase: LOSS,
            unitCode: 'PIECE',
            quantity: LOSS,
            category: 'CASSE',
            comment: 'Cartons tombés au déchargement',
          },
        };
      },
    },
  ];
  const timeline = [
    ...PLAN.map((sale) => ({ at: sale.occurredAt, sale })),
    ...extras.map((extra) => ({ at: extra.at, extra })),
  ].sort((a, b) => a.at.localeCompare(b.at));
  let cancelledSale: RawCommandEnvelope | undefined;
  for (const item of timeline) {
    if ('extra' in item && item.extra) {
      enqueue(item.extra.tablet, item.extra.spec());
      continue;
    }
    const sale = (item as { sale: PlannedSale }).sale;
    const product = products[sale.product];
    const amount = sale.quantity * PRICE;
    local[`${sale.tablet}:${sale.product}`] =
      local[`${sale.tablet}:${sale.product}`]! - sale.quantity;
    const envelope = enqueue(sale.tablet, {
      type: 'sales.sale.record',
      aggregateType: 'SALE',
      occurredAt: sale.occurredAt,
      payload: {
        fromLocationId: world.counter,
        ...(sale.method === 'CREDIT' ? { customerId: customers[sale.tablet] } : {}),
        lines: [world.line(product, sale.quantity)],
        ...(sale.method === 'CASH'
          ? { payments: [{ methodCode: 'ESPECES', amountXaf: amount }] }
          : sale.method === 'MOBILE'
            ? {
                payments: [
                  {
                    methodCode: 'MOBILE_MONEY_ORANGE',
                    amountXaf: amount,
                    reference: `OM${freshUuid().replace(/-/g, '').slice(-16)}`,
                    cashAccountId: world.mobileAcc,
                  },
                ],
              }
            : {}),
      },
    });
    if (sale === CANCELLED) {
      cancelledSale = envelope;
      local[`A:${sale.product}`] = local[`A:${sale.product}`]! + sale.quantity;
      enqueue('A', {
        type: 'sales.sale.cancel',
        aggregateType: 'SALE_CANCELLATION',
        occurredAt: minutes('08:05', 5),
        dependsOn: [envelope.command_id],
        payload: { saleId: envelope.aggregate_id, comment: 'Erreur de saisie' },
      });
    }
  }
  expect(cancelledSale).toBeDefined();
  for (const tablet of ['A', 'B', 'C'] as const) {
    for (const product of ['P1', 'P2'] as const) {
      enqueue(tablet, {
        type: 'inventory.allocation.release',
        aggregateType: 'STOCK_ALLOCATION',
        aggregateId: quotas[`${tablet}:${product}`],
        occurredAt: at(product === 'P1' ? '18:45' : '18:46'),
        payload: { remainingBase: local[`${tablet}:${product}`] },
      });
    }
  }
  enqueue('A', {
    type: 'finance.cash_session.close',
    aggregateType: 'CASH_SESSION',
    aggregateId: session,
    occurredAt: at('19:00'),
    payload: { countedXaf: COUNTED },
  });
  const remise = freshUuid();
  enqueue('A', {
    type: 'finance.cash_transfer.send',
    aggregateType: 'CASH_TRANSFER',
    aggregateId: remise,
    occurredAt: at('19:30'),
    payload: { fromAccountId: world.posAcc, toAccountId: world.central, amountXaf: COUNTED },
  });

  // Le soir : retour du réseau, synchronisation tablette par tablette dans `order` (lots de 50).
  world.setNow(at('20:30'));
  for (const tablet of order) {
    tablets[tablet].tablet.goOnline();
    await tablets[tablet].tablet.syncUntilSettled(actors[tablet].userId);
  }
  world.setNow(at('21:00'));
  return { world, products, session, remise, tablets, envelopes, quotas, local, customers };
}

/** Résumé indépendant de l'ordre : ce que les deux synchronisations doivent laisser à l'identique. */
async function summary(day: DayResult) {
  const { world, products, session, quotas, local, customers } = day;
  const sessionRow = await db
    .selectFrom('finance_cash_sessions')
    .select(['status', 'variance_xaf'])
    .where('id', '=', toBin(session))
    .executeTakeFirstOrThrow();
  const adjustments = await db
    .selectFrom('finance_cash_session_adjustments')
    .select(sql<string>`COALESCE(SUM(delta_xaf), 0)`.as('delta'))
    .where('session_id', '=', toBin(session))
    .executeTakeFirstOrThrow();
  const balance = async (accountId: string) =>
    Number(
      (
        await db
          .selectFrom('finance_cash_accounts')
          .select('balance_xaf')
          .where('id', '=', toBin(accountId))
          .executeTakeFirstOrThrow()
      ).balance_xaf,
    );
  const quotaStates: Record<string, unknown> = {};
  for (const [key, id] of Object.entries(quotas)) {
    const row = await world.quota(id);
    quotaStates[key] = {
      status: row.status,
      cause: row.close_cause,
      declared: Number(row.release_declared_remaining),
      local: local[key],
    };
  }
  const payments = await db
    .selectFrom('sales_customer_payments')
    .select([
      'payment_method_code',
      'status',
      sql<string>`COUNT(*)`.as('count'),
      sql<string>`SUM(amount_xaf)`.as('amount'),
    ])
    .where('site_id', '=', toBin(world.siteP))
    .groupBy(['payment_method_code', 'status'])
    .orderBy('payment_method_code')
    .orderBy('status')
    .execute();
  const receivables: Record<string, number> = {};
  for (const tablet of ['A', 'B', 'C'] as const) {
    const due = await db
      .selectFrom('sales_sales')
      .select(sql<string>`COALESCE(SUM(balance_due_xaf), 0)`.as('due'))
      .where('customer_id', '=', toBin(customers[tablet]))
      .executeTakeFirstOrThrow();
    receivables[tablet] = Number(due.due);
  }
  return {
    sessionStatus: sessionRow.status,
    payments: payments.map((row) => ({
      method: row.payment_method_code,
      status: row.status,
      count: Number(row.count),
      amount: Number(row.amount),
    })),
    receivables,
    currentVariance: Number(sessionRow.variance_xaf) + Number(adjustments.delta),
    balances: {
      pos: await balance(world.posAcc),
      central: await balance(world.central),
      mobile: await balance(world.mobileAcc),
    },
    stock: { P1: await world.onHand(products.P1.id), P2: await world.onHand(products.P2.id) },
    quotas: quotaStates,
  };
}

describe('PDV toute une journée hors ligne (P5-21)', { timeout: 900_000 }, () => {
  const worlds: PosWorld[] = [];
  const summaries: Awaited<ReturnType<typeof summary>>[] = [];

  afterAll(async () => {
    try {
      for (const world of worlds) await world.close(at('21:30'));
    } finally {
      await closeTestDb();
    }
  });

  async function expectDay(day: DayResult) {
    const { world, envelopes, products } = day;
    // BR-SYN-007 : aucun fait de la journée n'est rejeté ni mis en quarantaine.
    const outcomes = envelopes.map((envelope) => {
      const tablet = Object.values(day.tablets).find(
        (t) => t.actor.userId === envelope.author_user_id,
      )!.tablet;
      return { envelope, result: tablet.resultOf(envelope.command_id) };
    });
    const refused = outcomes.filter(({ result }) => !/^APPLIED/.test(result?.status ?? ''));
    expect(
      refused.map(({ envelope, result }) => `${envelope.command_type}: ${codeOf(result)}`),
    ).toEqual([]);
    expect(outcomes).toHaveLength(3 * SALES + 1 + 2 + 1 + 6 + 2);
    for (const { tablet, actor } of Object.values(day.tablets)) {
      expect(tablet.pending(actor.userId)).toBe(0);
    }
    // Stock : ouverture + transfert − vendu net − perte, par produit ; aucune anomalie de stock ou de quota.
    const sold = (product: 'P1' | 'P2') =>
      PLAN.filter((s) => s.product === product).reduce((sum, s) => sum + s.quantity, 0) -
      (CANCELLED.product === product ? CANCELLED.quantity : 0);
    const opening = (product: 'P1' | 'P2') =>
      (['A', 'B', 'C'] as const).reduce(
        (sum, t) => sum + demand(t, product) + 5 + (t === 'A' && product === 'P1' ? LOSS : 0),
        0,
      ) + (product === 'P1' ? 20 : 10);
    expect(await world.onHand(products.P1.id)).toBe(opening('P1') + TRANSFER - sold('P1') - LOSS);
    expect(await world.onHand(products.P2.id)).toBe(opening('P2') - sold('P2'));
    const anomalies = (
      await world.conflictTypesOfProducts([products.P1.id, products.P2.id])
    ).filter((type) =>
      [
        'STOCK_NEGATIVE',
        'ALLOCATION_EXCEEDED',
        'ALLOCATION_OVERCOMMITTED',
        'ALLOCATION_RELEASE_MISMATCH',
      ].includes(type),
    );
    expect(anomalies).toEqual([]);
    // Quotas : tous libérés sur le reste tenu par la tablette, sans écart.
    for (const [key, id] of Object.entries(day.quotas)) {
      const row = await world.quota(id);
      expect(row, key).toMatchObject({ status: 'CLOSED', close_cause: 'RELEASED' });
      expect(Number(row.release_declared_remaining), key).toBe(day.local[key]);
    }
    await world.expectStockLedgerOk([products.P1.id, products.P2.id]);
    await world.expectCashOk([day.session], [day.remise]);
    // Trésorerie et créances contre des valeurs attendues (pas seulement d'un ordre à l'autre) : le
    // mobile money au compte mobile, la caisse remise à la centrale, le crédit dû par chaque client.
    const summarised = await summary(day);
    expect(summarised.balances).toEqual({ pos: 0, central: 0, mobile: EXPECTED_MOBILE });
    expect(summarised.receivables).toEqual({
      A: amountOf('CREDIT', 'A'),
      B: amountOf('CREDIT', 'B'),
      C: amountOf('CREDIT', 'C'),
    });
    expect(summarised.payments.filter((p) => p.method === 'MOBILE_MONEY_ORANGE')).toEqual([
      {
        method: 'MOBILE_MONEY_ORANGE',
        status: 'RECORDED',
        count: PLAN.filter((s) => s.method === 'MOBILE').length,
        amount: EXPECTED_MOBILE,
      },
    ]);

    // Tableau de distribution de la journée : les mêmes chiffres que le registre et les ventes.
    const response = await world.app.inject({
      method: 'GET',
      url: `/api/v1/analytics/dashboards/distribution?from=${DAY}&to=${DAY}&site_id=${world.siteP}`,
      headers: { authorization: `Bearer ${await world.token(world.dir)}` },
    });
    expect(response.statusCode, response.body).toBe(200);
    const board = distributionDashboardResponseSchema.parse(response.json());
    const [pos] = board.pointsOfSale;
    const row = (product: 'P1' | 'P2') =>
      pos!.products.find((p) => p.productId === products[product].id)!;
    expect(row('P1')).toMatchObject({
      sentQty: TRANSFER,
      receivedQty: TRANSFER,
      soldNetQty: sold('P1'),
      remainingQty: opening('P1') + TRANSFER - sold('P1') - LOSS,
      allocatedQty: 0,
      reconciliation: { residualQty: 0, reconciled: true, salesMatchLedger: true },
    });
    expect((row('P1').lostQty ?? 0) + (row('P1').lostPendingQty ?? 0)).toBe(LOSS);
    expect(row('P2')).toMatchObject({
      soldNetQty: sold('P2'),
      reconciliation: { reconciled: true },
    });
    expect(pos!.reconciled).toBe(true);
    expect(pos!.sales.netXaf).toBe((sold('P1') + sold('P2')) * PRICE);
    expect(pos!.cash.transfers).toMatchObject({ inTransitCount: 1, inTransitXaf: COUNTED });
    // État local égal au serveur après un pull : stock, et plus aucun quota de la journée.
    for (const { tablet, actor } of Object.values(day.tablets)) {
      await tablet.pullAll('stock', actor.userId, world.clock.now());
      await tablet.pullAll('allocations', actor.userId, world.clock.now());
      for (const product of ['P1', 'P2'] as const) {
        const local = tablet.localProjection.get(`stock:STOCK_BALANCE:${products[product].id}`);
        expect(Number(local?.['qty_on_hand'])).toBe(await world.onHand(products[product].id));
      }
      for (const id of Object.values(day.quotas)) {
        expect(tablet.localProjection.has(`allocations:STOCK_ALLOCATION:${id}`)).toBe(false);
      }
    }
  }

  it('la caisse synchronise d’abord : les ventes des autres arrivent après la clôture, la session est réévaluée par le delta', async () => {
    const day = await playDay(['A', 'B', 'C'], worlds);
    summaries[0] = await summary(day);
    await expectDay(day);
    const reevaluated = await day.world.conflicts('CASH_SESSION_REEVALUATED', day.session);
    expect(reevaluated.length).toBeGreaterThan(0);
    expect(reevaluated[0]).toMatchObject({ owner_role: 'FINANCE' });
  });

  it('la caisse synchronise en dernier : les encaissements arrivent avant l’ouverture, résolus par elle', async () => {
    const day = await playDay(['C', 'B', 'A'], worlds);
    summaries[1] = await summary(day);
    await expectDay(day);
    const missing = await db
      .selectFrom('sync_sync_conflicts')
      .select(['status'])
      .where('conflict_type', '=', 'CASH_SESSION_MISSING')
      .where('site_id', '=', toBin(day.world.siteP))
      .execute();
    expect(missing.length).toBeGreaterThan(0);
    expect(missing.every((row) => row.status === 'RESOLVED')).toBe(true);
  });

  it('les deux ordres laissent le même état : stock, quotas, trésorerie, écart courant compté une fois (−500)', () => {
    expect(
      summaries.filter(Boolean),
      'les deux journées des tests précédents doivent avoir été jouées (voir leur échec)',
    ).toHaveLength(2);
    expect(summaries[0]!.currentVariance).toBe(-SHORTAGE);
    expect(summaries[1]).toEqual(summaries[0]);
  });
});
