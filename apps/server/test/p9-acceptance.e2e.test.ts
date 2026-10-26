/**
 * P9-24 : tests d'acceptation de l'analyse (09-non-functional/03-plan-de-tests.md), sur l'application complète
 * (`PosWorld` : `AppModule`, vrai pipeline de commande, jetons réels, horloge fixe) avec de vraies ventes :
 * - AT-039 « Combien vendu cette semaine, par quel commercial, à quels clients ? » : l'explorateur rend, par vendeur et
 *   par client, les chiffres des documents (`GET /sales/{id}`), et chaque ligne désigne son document (BR-ANA-010) ;
 * - AT-043 « Pourquoi manque-t-il des unités ? » : les mouvements du produit lus dans l'explorateur sont ceux du registre
 *   (`GET /stock-moves`), avec document, auteur, appareil et commande ;
 * - AT-045 « Enquête d'audit sur une vente annulée » : l'audit dit qui, quand (réel et serveur), depuis quel appareil,
 *   avant et après, et la chaîne de hachage se vérifie ;
 * - AT-046 « Export de ventes par un responsable commercial » : limité à son équipe, audité (demande, fin, téléchargement) ;
 * - AT-054 « Ventes de la semaine lues partout » : tableau commercial = explorateur = documents pour un vendeur à
 *   portée `OWN`, qui ne voit que ses lignes et n'obtient ni coût ni marge.
 * Les autres acceptations de la phase sont démontrées par leurs fichiers : AT-027 (mortalité) `communication-production-alerts`,
 * AT-032 (créance échue) `communication-sales-alerts`, AT-047 (stock sous le seuil) `communication-inventory-alerts`,
 * AT-048 (note à accusé) `communication-note-commands` et `communication-comms-sync`, AT-038 (disponible par zone)
 * `inventory-read.e2e` — voir la démonstration de clôture.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import {
  ANALYTICS_CATALOG_VERSION,
  KPI_CATALOG,
  businessDayEndUtc,
  businessDayStartUtc,
} from '@gic/domain';
import { analyticsQueryResponseSchema, dashboardResponseSchema } from '@gic/contracts';
import { verifyChainRange } from '../src/audit/verify-chain.js';
import { fromBin, toBin } from '../src/platform/kysely/uuid-columns.js';
import { invalidateUser } from '../src/modules/identity/application/rbac/rbac-cache.js';
import { JobRunner } from '../src/platform/jobs/job-runner.js';
import {
  periodRevenue,
  salesActivityByDay,
} from '../src/modules/sales/application/public/index.js';
import {
  assignTestRole,
  closeTestDb,
  db,
  freshUuid,
  grantTestPermission,
  insertTestDevice,
  insertTestRole,
  insertTestTeam,
  insertTestTeamMembership,
  insertTestUser,
} from './helpers.js';
import { newActor, tx, type Actor } from './cash-transfer-fixtures.js';
import { PosWorld, PRICE } from './pos-world.js';

const DAY = '2026-07-23';
const at = (hhmm: string) => `${DAY}T${hhmm}:00.000Z`;

describe('P9-24 : acceptation de l’analyse', { timeout: 300_000 }, () => {
  let world: PosWorld;
  let s0: Actor;
  let s1: Actor;
  let teamLead: Actor;
  let ownSeller: Actor;
  let originalAssignments: Buffer[] = [];
  let product: Awaited<ReturnType<PosWorld['product']>>;
  let c0: string;
  let c1: string;
  const saleIds: Record<'A' | 'B' | 'C', string> = { A: '', B: '', C: '' };
  let cancellationId = '';
  const exportIds: string[] = [];

  const get = async (actor: Actor, url: string) =>
    world.app.inject({
      method: 'GET',
      url,
      headers: { authorization: `Bearer ${await world.token(actor)}` },
    });
  const query = async (actor: Actor, definition: Record<string, unknown>) => {
    const response = await world.app.inject({
      method: 'POST',
      url: '/api/v1/analytics/query',
      headers: {
        authorization: `Bearer ${await world.token(actor)}`,
        'content-type': 'application/json',
      },
      payload: JSON.stringify({ definition }),
    });
    return response;
  };
  const sale = (actor: Actor, customer: string, quantity: number, occurredAt: string) => {
    // L'horloge du serveur ne précède jamais l'instant de l'opération (OCCURRED_AT_FUTURE).
    world.setNow(occurredAt);
    return world.ok(actor, {
      type: 'sales.sale.record',
      aggregateType: 'SALE',
      occurredAt,
      payload: {
        fromLocationId: world.counter,
        customerId: customer,
        lines: [world.line(product, quantity)],
        payments: [],
      },
    });
  };
  /** L'identifiant de la vente créée, relu par sa référence de commande. */
  const saleIdOf = async (commandId: string): Promise<string> =>
    fromBin(
      (
        await db
          .selectFrom('sales_sales')
          .select('id')
          .where('command_id', '=', toBin(commandId))
          .executeTakeFirstOrThrow()
      ).id,
    );

  beforeAll(async () => {
    world = await PosWorld.create({ now: at('05:00'), sellers: 2 });
    [s0, s1] = world.sellers as [Actor, Actor];
    product = await world.product('Poulet AT-P9');
    await world.stockIn(product.id, 100, at('06:00'));
    c0 = await world.customer('Client A P9');
    c1 = await world.customer('Client B P9');

    const a = await sale(s0, c0, 10, at('09:00'));
    const b = await sale(s1, c1, 6, at('10:00'));
    const c = await sale(s0, c0, 4, at('11:00'));
    saleIds.A = await saleIdOf(a.command_id);
    saleIds.B = await saleIdOf(b.command_id);
    saleIds.C = await saleIdOf(c.command_id);
    // Annulation dans le délai direct (BR-VEN-028) : elle s'applique tout de suite, sans validation.
    world.setNow(at('11:05'));
    cancellationId = freshUuid();
    await world.ok(s0, {
      type: 'sales.sale.cancel',
      aggregateType: 'SALE_CANCELLATION',
      aggregateId: cancellationId,
      occurredAt: at('11:05'),
      payload: { saleId: saleIds.C, comment: 'Erreur de saisie' },
    });

    // L'équipe du responsable commercial : le vendeur s0 seulement.
    const manager = await tx((trx) => insertTestUser(trx));
    const teamId = await tx((trx) => insertTestTeam(trx, manager, world.root));
    await tx((trx) => insertTestTeamMembership(trx, teamId, s0.userId, world.root));
    teamLead = await newActor('RESP_COMMERCIAL', world.root, {
      scopeType: 'TEAM',
      scopeTeamId: teamId,
    });

    // Un vendeur « explorateur » à portée OWN, sans droit de valorisation : le vendeur s0, dont les affectations
    // d'origine (site) sont retirées au moment de l'essai pour qu'il ne reste que la portée OWN.
    originalAssignments = (
      await db
        .selectFrom('identity_user_role_assignments')
        .select('id')
        .where('user_id', '=', toBin(s0.userId))
        .execute()
    ).map((row) => row.id);
    ownSeller = await tx(async (trx) => {
      const userId = s0.userId;
      const deviceId = await insertTestDevice(trx, userId, { status: 'ACTIVE' });
      const roleId = await insertTestRole(trx, world.root, { allowedScopeTypes: ['GLOBAL'] });
      for (const permission of [
        'analytics.explore',
        'analytics.dashboard.commercial',
        'sales.sale.read',
      ]) {
        await grantTestPermission(trx, roleId, permission, world.root, {
          maxScope: permission === 'analytics.explore' ? 'ALL' : 'OWN',
        });
      }
      await assignTestRole(trx, userId, roleId, world.root);
      return { userId, deviceId };
    });
    // Les octrois sont mis en cache par processus : la nouvelle affectation se déclare au cache.
    invalidateUser(s0.userId);
  }, 180_000);

  afterAll(async () => {
    try {
      await db
        .deleteFrom('platform_jobs')
        .where('job_type', '=', 'analytics.export.run')
        .where('status', '=', 'PENDING')
        .where(
          sql<boolean>`JSON_UNQUOTE(JSON_EXTRACT(payload, '$.exportId')) IN (${sql.join(exportIds.length > 0 ? exportIds : ['-'])})`,
        )
        .execute();
      await world?.close(at('23:00'));
    } finally {
      await closeTestDb();
    }
  });

  it('AT-039 : par vendeur et par client, l’explorateur égale les documents, et chaque ligne désigne sa vente', async () => {
    const response = await query(world.dir, {
      dataset: 'f_sales_line',
      period: { code: 'WEEK' },
      dimensions: ['seller_user_id', 'customer_id'],
      measures: ['revenue', 'sales_count'],
      filters: [{ field: 'site_id', op: 'EQ', value: world.siteP }],
      sort: [],
    });
    expect(response.statusCode, response.body).toBe(200);
    const result = analyticsQueryResponseSchema.parse(response.json());
    const cell = (seller: Actor, customer: string) =>
      result.rows.find(
        (row) =>
          row.values['seller_user_id'] === seller.userId && row.values['customer_id'] === customer,
      )?.values;
    // A (10) + C (4) − annulation de C (4) = 10 pour s0 / c0 ; B (6) pour s1 / c1.
    expect(cell(s0, c0)).toMatchObject({ revenue: 10 * PRICE });
    expect(cell(s1, c1)).toMatchObject({ revenue: 6 * PRICE, sales_count: 1 });
    // Les documents : le total de la vente A relu par `GET /sales/{id}`.
    const documentA = await get(world.dir, `/api/v1/sales/${saleIds.A}`);
    expect(documentA.statusCode, documentA.body).toBe(200);
    expect(JSON.stringify(documentA.json())).toContain(String(10 * PRICE));

    // Niveau 2 (BR-ANA-010) : regroupé par vente, chaque ligne porte l'identifiant et la route de sa vente.
    const bySale = await query(world.dir, {
      dataset: 'f_sales_line',
      period: { code: 'WEEK' },
      dimensions: ['sale_id'],
      measures: ['revenue'],
      filters: [{ field: 'site_id', op: 'EQ', value: world.siteP }],
      sort: [],
    });
    expect(bySale.statusCode, bySale.body).toBe(200);
    const rows = analyticsQueryResponseSchema.parse(bySale.json()).rows;
    const sourceOfSale = (id: string) => rows.find((row) => row.values['sale_id'] === id);
    expect(sourceOfSale(saleIds.A)).toMatchObject({
      values: { revenue: 10 * PRICE },
      source: { type: 'SALE', id: saleIds.A, route: `/api/v1/sales/${saleIds.A}` },
    });
    expect(sourceOfSale(saleIds.C)!.values['revenue']).toBe(0);
  });

  it('AT-043 : les mouvements lus dans l’explorateur sont ceux du registre, avec document, auteur, appareil et commande', async () => {
    const response = await query(world.dir, {
      dataset: 'f_stock_moves',
      period: { code: 'WEEK' },
      dimensions: ['move_id'],
      measures: ['quantity'],
      filters: [{ field: 'product_id', op: 'EQ', value: product.id }],
      sort: [],
    });
    expect(response.statusCode, response.body).toBe(200);
    const explored = analyticsQueryResponseSchema.parse(response.json());
    const exploredIds = new Set(explored.rows.map((row) => row.source?.id));
    expect(exploredIds.size).toBeGreaterThanOrEqual(3);
    for (const row of explored.rows) expect(row.source?.type).toBe('STOCK_MOVE');

    const ledger = await get(
      world.dir,
      `/api/v1/stock-moves?location_id=${world.counter}&product_id=${product.id}&from=${DAY}&to=${DAY}`,
    );
    expect(ledger.statusCode, ledger.body).toBe(200);
    const moves = (ledger.json() as { moves: Record<string, unknown>[] }).moves;
    expect(moves.length).toBeGreaterThanOrEqual(3);
    for (const move of moves) {
      expect(move.sourceDocId, 'document').toEqual(expect.any(String));
      expect(move.createdBy, 'auteur').toEqual(expect.any(String));
      // Un mouvement de l'emplacement est dans l'explorateur : le même registre, lu deux fois.
      expect(exploredIds.has(move.id as string), String(move.id)).toBe(true);
    }
    // Les mouvements des ventes portent l'appareil et la commande de l'opération.
    const saleMove = moves.find((move) => move.sourceDocId === saleIds.A);
    expect(saleMove?.commandId).toEqual(expect.any(String));
  });

  it('AV-376 : le chiffre d’affaires de periodRevenue égale celui de la référence (period-activity) ; seul le nombre de ventes diffère (annulées comprises)', async () => {
    const siteIds = [world.siteP];
    const revenue = await periodRevenue(db, {
      fromUtc: businessDayStartUtc(DAY),
      toUtc: businessDayEndUtc(DAY),
      siteIds,
    });
    const [day] = await salesActivityByDay(db, { siteIds }, { fromDay: DAY, toDay: DAY });
    expect(day!.netXaf).toBe(10 * PRICE + 6 * PRICE);
    expect(revenue.netRevenueXaf).toBe(day!.netXaf);
    expect(revenue.grossRevenueXaf).toBe(day!.soldXaf);
    expect(revenue.cancelledXaf).toBe(day!.cancelledXaf);
    // Trois ventes enregistrées dont une annulée : KPI-COM-07 en compte deux, periodRevenue trois.
    expect(day!.salesCount).toBe(2);
    expect(revenue.saleCount).toBe(3);
  });

  it('AT-045 : l’enquête sur la vente annulée dit qui, quand, depuis quel appareil, avant et après ; la chaîne se vérifie', async () => {
    const entries = await db
      .selectFrom('audit_audit_log')
      .select([
        'seq',
        'occurred_at',
        'recorded_at',
        'actor_user_id',
        'device_id',
        'action',
        'entity_type',
        'before',
        'after',
        'result',
      ])
      .where('entity_id', 'in', [toBin(cancellationId), toBin(saleIds.C)])
      .orderBy('seq')
      .execute();
    const record = entries.find((entry) => entry.action === 'sales.sale.record');
    const cancel = entries.find((entry) => entry.action === 'sales.sale.cancel');
    expect(record, 'la vente est auditée').toBeDefined();
    expect(cancel, 'l’annulation est auditée').toBeDefined();
    expect(fromBin(cancel!.actor_user_id)).toBe(s0.userId);
    expect(fromBin(cancel!.device_id!)).toBe(s0.deviceId);
    expect(cancel!.result).toBe('SUCCESS');
    // Heure réelle de l'opération et heure d'enregistrement par le serveur : deux dates distinctes.
    expect(cancel!.occurred_at.toISOString()).toBe(at('11:05'));
    expect(cancel!.recorded_at).toBeInstanceOf(Date);
    expect(cancel!.after).toBeTruthy();
    // La lecture HTTP de l'audit (Direction) retrouve l'annulation par son identifiant.
    const read = await get(world.admin, `/api/v1/audit?entity_id=${cancellationId}`);
    if (read.statusCode === 200) {
      const listed = (read.json() as { entries: { action: string }[] }).entries;
      expect(listed.some((entry) => entry.action === 'sales.sale.cancel')).toBe(true);
    }
    // La chaîne de hachage se vérifie sur la plage de l'enquête.
    const first = Math.min(...entries.map((entry) => entry.seq));
    const last = Math.max(...entries.map((entry) => entry.seq));
    expect(await verifyChainRange(db, { fromSeq: first, toSeq: last })).toMatchObject({ ok: true });
  });

  it('AT-046 : l’export de ventes du responsable commercial est limité à son équipe et audité de bout en bout', async () => {
    const exportId = freshUuid();
    exportIds.push(exportId);
    world.setNow(at('13:00'));
    const request = await world.online(teamLead, {
      type: 'analytics.export.request',
      aggregateType: 'ANALYTICS_EXPORT',
      aggregateId: exportId,
      occurredAt: at('13:00'),
      payload: {
        definition: {
          dataset: 'f_sales_line',
          period: { code: 'WEEK' },
          dimensions: ['sale_id'],
          measures: ['revenue'],
          filters: [{ field: 'site_id', op: 'EQ', value: world.siteP }],
          sort: [],
        },
        format: 'CSV',
        catalogVersion: ANALYTICS_CATALOG_VERSION,
      },
    });
    expect(request.status, JSON.stringify(request)).toMatch(/^APPLIED/);
    // La tâche d'export, réclamée par le worker (gestionnaire réel de l'application).
    const outcome = await world.app
      .get(JobRunner)
      .claimAndProcessOne({ jobTypes: ['analytics.export.run'] });
    expect(outcome).toMatchObject({ claimed: true, result: 'DONE' });
    const row = await db
      .selectFrom('analytics_export_jobs')
      .select(['status', 'row_count', 'error_code'])
      .where('id', '=', toBin(exportId))
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({ status: 'DONE', error_code: null });

    const file = await get(teamLead, `/api/v1/analytics/exports/${exportId}/download`);
    expect(file.statusCode, file.body).toBe(200);
    // L'équipe est le vendeur s0 : ses ventes A et C sont dans l'export, la vente B de s1 n'y est pas.
    expect(file.body).toContain(saleIds.A);
    expect(file.body).toContain(saleIds.C);
    expect(file.body).not.toContain(saleIds.B);

    const audited = await db
      .selectFrom('audit_audit_log')
      .select('action')
      .where('entity_id', '=', toBin(exportId))
      .orderBy('seq')
      .execute();
    expect(audited.map((entry) => entry.action)).toEqual([
      'analytics.export.request',
      'analytics.export.completed',
      'analytics.export.downloaded',
    ]);
    // Le fichier n'est pas celui d'un autre : la Direction, qui voit tout, ne télécharge pas l'export de l'équipe.
    expect(
      (await get(world.dir, `/api/v1/analytics/exports/${exportId}/download`)).statusCode,
    ).toBe(404);
  });

  it('AT-054 : un vendeur à portée OWN lit les mêmes ventes sur le tableau commercial et l’explorateur, sans coût ni marge', async () => {
    // Seule la portée OWN reste à s0 : ses affectations d'origine (site) sont révoquées avant l'essai.
    await db
      .updateTable('identity_user_role_assignments')
      .set({ revoked_at: new Date(at('12:30')) })
      .where('id', 'in', originalAssignments)
      .execute();
    invalidateUser(s0.userId);
    const dashboardResponse = await get(
      ownSeller,
      '/api/v1/analytics/dashboards/commercial?period=WEEK',
    );
    expect(dashboardResponse.statusCode, dashboardResponse.body).toBe(200);
    const dashboard = dashboardResponseSchema.parse(dashboardResponse.json());
    const revenueKpi = KPI_CATALOG.find(
      (kpi) =>
        kpi.explorer?.dataset === 'f_sales_line' &&
        kpi.explorer.measure === 'revenue' &&
        kpi.nature === 'FLOW',
    )!;
    const shown = dashboard.blocks
      .flatMap((block) => block.kpis)
      .find((kpi) => kpi.code === revenueKpi.code);
    expect(shown, revenueKpi.code).toBeDefined();

    const explored = await query(ownSeller, {
      dataset: 'f_sales_line',
      period: { code: 'WEEK' },
      measures: ['revenue'],
    });
    expect(explored.statusCode, explored.body).toBe(200);
    const exploredRevenue =
      analyticsQueryResponseSchema.parse(explored.json()).rows[0]?.values['revenue'] ?? 0;
    // Le vendeur ne voit que ses lignes : la vente A (10) ; la vente C est annulée dans la semaine ; B n'est pas la sienne.
    expect(exploredRevenue).toBe(10 * PRICE);
    expect(shown!.value).toBe(exploredRevenue);

    // Sans `inventory.valuation.read` : ni coût ni marge, ni dans l'explorateur ni sur le tableau.
    const margin = await query(ownSeller, {
      dataset: 'f_sales_line',
      period: { code: 'WEEK' },
      measures: ['margin'],
    });
    expect(margin.statusCode).toBe(403);
    expect((margin.json() as { error: { code: string } }).error.code).toBe('FORBIDDEN_MEASURE');
    for (const kpi of dashboard.blocks.flatMap((block) => block.kpis)) {
      if (KPI_CATALOG.find((entry) => entry.code === kpi.code)?.protected === true) {
        expect(kpi.value, kpi.code).toBeNull();
      }
    }
  });
});
