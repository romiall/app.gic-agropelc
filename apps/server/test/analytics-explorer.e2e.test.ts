/**
 * P9-14 (3/4) — l'explorateur de bout en bout : `POST /api/v1/analytics/query` et `GET /api/v1/analytics/catalog`
 * (NestJS + Fastify, `app.inject()`), rôles réels du seed (Direction, Finance, Responsable commercial, Responsable
 * de production, Vendeur) et rôles d'essai à portée de site.
 *
 * Démontre (BR-ANA-004, 006, 007, 009, ADR-064, ADR-068 ; AT-046, lecture) : le droit d'ouvrir l'outil et celui
 * de lire le jeu sont distincts ; chaque ligne rendue est dans l'étendue exacte du lecteur (site, équipe) ; une
 * mesure au coût sans `inventory.valuation.read` est refusée et le refus est audité ; la définition est validée
 * par le catalogue (400) ; les limites sont des erreurs (422 lignes, 429 concurrence), jamais une troncature ;
 * une vue sauvegardée s'exécute avec les droits de l'exécutant et devient `OUTDATED` si un champ disparaît ;
 * chaque requête, refus compris, laisse une ligne du journal technique.
 *
 * La base d'essai est partagée : les chiffres sont rapprochés d'un calcul indépendant relu avant et après la
 * requête (ils ne sont comparés que s'ils n'ont pas bougé entre-temps).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Clock } from '@gic/domain';
import { ANALYTICS_DATASETS } from '@gic/domain';
import { analyticsCatalogResponseSchema, analyticsQueryResponseSchema } from '@gic/contracts';
import { AppModule } from '../src/app.module.js';
import { CLOCK } from '../src/platform/clock.provider.js';
import { ID_GENERATOR } from '../src/platform/id-generator.provider.js';
import { registerCorrelationId } from '../src/platform/http/register-correlation-id.js';
import { fromBin, toBin } from '../src/platform/kysely/uuid-columns.js';
import { JWT_KEYS } from '../src/modules/identity/jwt-keys.provider.js';
import {
  acquireQuerySlot,
  releaseQuerySlot,
} from '../src/modules/analytics/application/public/index.js';
import { newActor, tx, type Actor } from './cash-transfer-fixtures.js';
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
  signTestAccessToken,
} from './helpers.js';

const PERIOD = { code: 'CUSTOM', fromDay: '2024-01-01', toDay: '2026-12-31' } as const;
const WINDOW = sql`BETWEEN '2024-01-01' AND '2026-12-31'`;

describe('P9-14 (3/4) : l’explorateur', { timeout: 180_000 }, () => {
  let app: NestFastifyApplication;
  let clock: Clock;
  const tokens = new Map<string, string>();
  let root: string;
  let direction: Actor;
  let finance: Actor;
  let teamLead: Actor;
  let production: Actor;
  let seller: Actor;
  let siteScoped: Actor;
  let teamMembers: readonly string[] = [];
  let topSite: string;
  let secondSite: string;

  const call = (actor: Actor, method: 'GET' | 'POST', url: string, body?: unknown) =>
    app.inject({
      method,
      url,
      headers: {
        authorization: `Bearer ${tokens.get(actor.userId)!}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
    });
  const query = (actor: Actor, definition: unknown) =>
    call(actor, 'POST', '/api/v1/analytics/query', { definition });
  const parsed = (response: { statusCode: number; body: string; json: () => unknown }) => {
    expect(response.statusCode, response.body).toBe(200);
    return analyticsQueryResponseSchema.parse(response.json());
  };
  const errorOf = (response: { json: () => unknown }) =>
    (response.json() as { error: { code: string; details?: Record<string, unknown> } }).error;

  /** Acteur à rôle d'essai : permissions et portées au choix, affecté à un site. */
  async function customActor(
    grants: ReadonlyArray<readonly [string, 'ALL' | 'SITE' | 'OWN' | 'TEAM' | 'ZONE']>,
    scope:
      | { readonly scopeType: 'GLOBAL' }
      | { readonly scopeType: 'SITE'; readonly scopeSiteId: string },
  ): Promise<Actor> {
    return tx(async (trx) => {
      const userId = await insertTestUser(trx);
      const deviceId = await insertTestDevice(trx, userId, { status: 'ACTIVE' });
      const roleId = await insertTestRole(trx, root, {
        allowedScopeTypes: ['GLOBAL', 'SITE', 'ZONE', 'TEAM'],
      });
      for (const [permission, maxScope] of grants) {
        await grantTestPermission(trx, roleId, permission, root, { maxScope });
      }
      await assignTestRole(trx, userId, roleId, root, scope);
      return { userId, deviceId };
    });
  }

  const auditDenied = (actor: Actor) =>
    db
      .selectFrom('audit_audit_log')
      .select(['entity_type', 'error_code', 'reason'])
      .where('actor_user_id', '=', toBin(actor.userId))
      .where('action', '=', 'access.denied')
      .orderBy('seq')
      .execute();
  const logOf = (actor: Actor) =>
    db
      .selectFrom('analytics_query_log')
      .select(['dataset', 'outcome', 'error_code', 'row_count', 'duration_ms'])
      .where('user_id', '=', toBin(actor.userId))
      .orderBy('created_at')
      .execute();

  /** Un chiffre relu tant qu'il bouge : il n'est comparé qu'une fois stable autour de la requête. */
  async function steady<T>(
    independent: () => Promise<number>,
    request: () => Promise<T>,
  ): Promise<{ readonly expected: number; readonly result: T }> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const before = await independent();
      const result = await request();
      if ((await independent()) === before) return { expected: before, result };
    }
    throw new Error('Les ventes de la base partagée bougent trop pour être rapprochées.');
  }
  const revenueWhere = async (predicate: ReturnType<typeof sql>): Promise<number> =>
    Number(
      (
        await sql<{
          v: string | null;
        }>`SELECT COALESCE(SUM(amount_xaf), 0) AS v FROM analytics_f_sales_line
          WHERE business_day ${WINDOW} AND ${predicate}`.execute(db)
      ).rows[0]!.v,
    );

  beforeAll(async () => {
    process.env.SERVER_DATABASE_URL ??=
      'mysql://gic_app:gic_app_password@127.0.0.1:3306/gic_agropelc_test';
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    registerCorrelationId(app, app.get(ID_GENERATOR));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    clock = app.get(CLOCK);
    const jwtKeys = app.get(JWT_KEYS);

    root = await tx((trx) => insertTestUser(trx));
    const sites = (
      await sql<{ site: Buffer }>`SELECT site_id AS site FROM analytics_f_sales_line
        WHERE business_day ${WINDOW} GROUP BY site_id ORDER BY COUNT(*) DESC, site_id LIMIT 2`.execute(
        db,
      )
    ).rows.map((row) => fromBin(row.site));
    expect(sites.length, 'la base d’essai porte des ventes sur deux sites au moins').toBe(2);
    [topSite, secondSite] = sites as [string, string];

    direction = await newActor('DIRECTION', root);
    finance = await newActor('FINANCE', root);
    production = await newActor('RESP_PRODUCTION', root);
    seller = await newActor('VENDEUR_PDV', root, { scopeType: 'SITE', scopeSiteId: topSite });
    // Un acteur « explorateur de site » : lit les ventes de son site seulement, sans droit de valorisation.
    siteScoped = await customActor(
      [
        ['analytics.explore', 'ALL'],
        ['sales.sale.read', 'SITE'],
        ['inventory.valuation.read', 'SITE'],
      ],
      { scopeType: 'SITE', scopeSiteId: topSite },
    );
    // L'équipe du responsable commercial : une équipe existante dont des membres ont vendu ; à défaut (base neuve),
    // une équipe est créée avec un vendeur réel sans équipe — une seule fois, les exécutions suivantes la retrouvent.
    const active = sql`m.valid_from <= UTC_TIMESTAMP(6) AND (m.valid_to IS NULL OR m.valid_to > UTC_TIMESTAMP(6))`;
    const findTeam = async () =>
      (
        await sql<{ team: Buffer }>`
          SELECT m.team_id AS team FROM organization_team_memberships m
            JOIN analytics_f_sales_line v ON v.owner_user_id = m.user_id
           WHERE v.business_day ${WINDOW} AND ${active}
           GROUP BY m.team_id ORDER BY COUNT(*) DESC, m.team_id LIMIT 1`.execute(db)
      ).rows[0];
    let found = await findTeam();
    if (found === undefined) {
      const lonely = (
        await sql<{ owner: Buffer }>`
          SELECT v.owner_user_id AS owner FROM analytics_f_sales_line v
           WHERE v.business_day ${WINDOW} AND v.owner_user_id IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM organization_team_memberships m
                              WHERE m.user_id = v.owner_user_id AND m.valid_to IS NULL)
           GROUP BY v.owner_user_id ORDER BY COUNT(*) DESC, v.owner_user_id LIMIT 1`.execute(db)
      ).rows[0];
      expect(lonely, 'un vendeur réel de la base peut former une équipe').toBeDefined();
      const manager = await tx((trx) => insertTestUser(trx));
      const team = await tx((trx) => insertTestTeam(trx, manager, root));
      await tx((trx) => insertTestTeamMembership(trx, team, fromBin(lonely!.owner), root));
      found = await findTeam();
    }
    const teamId = fromBin(found!.team);
    teamMembers = (
      await sql<{ member: Buffer }>`
        SELECT m.user_id AS member FROM organization_team_memberships m
         WHERE m.team_id = ${toBin(teamId)} AND ${active}`.execute(db)
    ).rows.map((row) => fromBin(row.member));
    teamLead = await newActor('RESP_COMMERCIAL', root, { scopeType: 'TEAM', scopeTeamId: teamId });
    for (const actor of [direction, finance, production, seller, teamLead, siteScoped]) {
      tokens.set(
        actor.userId,
        await signTestAccessToken(
          jwtKeys.privateKey,
          { sub: actor.userId, device_id: actor.deviceId, session_id: freshUuid() },
          clock.now(),
        ),
      );
    }
  });

  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  // --- Droits ------------------------------------------------------------------------------------------------

  it('sans jeton : 401 ; sans le droit d’ouvrir l’outil : 403 audité', async () => {
    const anonymous = await app.inject({
      method: 'POST',
      url: '/api/v1/analytics/query',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ definition: { dataset: 'f_sales_line', measures: ['revenue'] } }),
    });
    expect(anonymous.statusCode).toBe(401);
    const refused = await query(seller, {
      dataset: 'f_sales_line',
      period: PERIOD,
      measures: ['revenue'],
    });
    expect(refused.statusCode, refused.body).toBe(403);
    expect(errorOf(refused).code).toBe('FORBIDDEN');
    expect(await auditDenied(seller)).toEqual([
      expect.objectContaining({ entity_type: 'ANALYTICS_QUERY', error_code: 'FORBIDDEN' }),
    ]);
    expect((await call(seller, 'GET', '/api/v1/analytics/catalog')).statusCode).toBe(403);
  });

  it('le droit de lire le jeu est distinct du droit d’explorer : refus 403, audité et journalisé', async () => {
    const refused = await query(production, {
      dataset: 'f_sales_line',
      period: PERIOD,
      measures: ['revenue'],
    });
    expect(refused.statusCode, refused.body).toBe(403);
    expect(errorOf(refused).code).toBe('FORBIDDEN');
    expect(await auditDenied(production)).toEqual([
      expect.objectContaining({ entity_type: 'ANALYTICS_DATASET', error_code: 'FORBIDDEN' }),
    ]);
    expect(await logOf(production)).toEqual([
      expect.objectContaining({
        dataset: 'f_sales_line',
        outcome: 'REFUSED',
        error_code: 'FORBIDDEN',
      }),
    ]);
    // Ses propres jeux restent lisibles.
    const own = parsed(
      await query(production, {
        dataset: 'f_production_daily',
        period: PERIOD,
        measures: ['mortality'],
      }),
    );
    expect(own.dataset).toBe('f_production_daily');
  });

  // --- Catalogue --------------------------------------------------------------------------------------------

  it('le catalogue ne liste que les jeux dont le lecteur détient toutes les permissions ; les mesures au coût sont signalées interdites', async () => {
    const all = analyticsCatalogResponseSchema.parse(
      (await call(direction, 'GET', '/api/v1/analytics/catalog')).json(),
    );
    expect(all.datasets.map((dataset) => dataset.code).sort()).toEqual(
      ANALYTICS_DATASETS.map((dataset) => dataset.code).sort(),
    );
    const directionMargin = all.datasets
      .find((dataset) => dataset.code === 'f_sales_line')!
      .measures.find((measure) => measure.name === 'margin')!;
    expect(directionMargin.forbidden).toBe(false);

    const limited = analyticsCatalogResponseSchema.parse(
      (await call(siteScoped, 'GET', '/api/v1/analytics/catalog')).json(),
    );
    // Droits : ventes et valorisation seulement — les jeux dont toutes les permissions sont de ces deux-là.
    const held = new Set(['sales.sale.read', 'inventory.valuation.read']);
    expect(limited.datasets.map((dataset) => dataset.code).sort()).toEqual(
      ANALYTICS_DATASETS.filter((dataset) => dataset.permissions.every((p) => held.has(p)))
        .map((dataset) => dataset.code)
        .sort(),
    );
    expect(limited.datasets.map((dataset) => dataset.code)).toContain('f_sales_line');
    const withoutValuation = analyticsCatalogResponseSchema.parse(
      (await call(teamLead, 'GET', '/api/v1/analytics/catalog')).json(),
    );
    const salesDataset = withoutValuation.datasets.find(
      (dataset) => dataset.code === 'f_sales_line',
    );
    expect(salesDataset).toBeDefined();
    expect(salesDataset!.measures.find((measure) => measure.name === 'margin')!.forbidden).toBe(
      true,
    );
    expect(salesDataset!.measures.find((measure) => measure.name === 'revenue')!.forbidden).toBe(
      false,
    );
    // Aucun jeu sans toutes ses permissions : le responsable de production n'a pas les ventes.
    const productionCatalog = analyticsCatalogResponseSchema.parse(
      (await call(production, 'GET', '/api/v1/analytics/catalog')).json(),
    );
    expect(productionCatalog.datasets.map((dataset) => dataset.code)).not.toContain('f_sales_line');
    expect(productionCatalog.datasets.map((dataset) => dataset.code)).toContain(
      'f_production_daily',
    );
  });

  // --- Données et étendue -------------------------------------------------------------------------------------

  it('la Direction lit tout : chiffre d’affaires par site, total, colonnes, période et fraîcheur', async () => {
    const { expected, result } = await steady(
      () => revenueWhere(sql`1 = 1`),
      async () =>
        parsed(
          await query(direction, {
            dataset: 'f_sales_line',
            period: PERIOD,
            dimensions: ['site_id'],
            measures: ['revenue', 'quantity'],
            sort: [{ field: 'revenue', direction: 'DESC' }],
          }),
        ),
    );
    expect(result.totals!.revenue).toBe(expected);
    expect(result.rows.reduce((sum, row) => sum + (row.values.revenue as number), 0)).toBe(
      expected,
    );
    expect(result.rowCount).toBe(result.rows.length);
    expect(result.rows.length).toBeGreaterThanOrEqual(2);
    expect(result.rows.map((row) => row.values.site_id)).toContain(topSite);
    expect(result.columns.map((column) => column.name)).toEqual(['site_id', 'revenue', 'quantity']);
    expect(result.period).toMatchObject({
      code: 'CUSTOM',
      fromDay: '2024-01-01',
      toDay: '2026-12-31',
    });
    expect(result.catalogVersion).toBe(1);
    expect(result.scopeTruncated).toBe(false);
    expect(Date.parse(result.freshness.computedAt)).not.toBeNaN();
    expect(result.freshness.staleAfterHours).toBeGreaterThan(0);
    expect(result.freshness.devicesInScope).toBeGreaterThanOrEqual(result.freshness.staleDevices);
  });

  it('un lecteur de site ne reçoit que les lignes de son site, et son total est celui du site', async () => {
    const { expected, result } = await steady(
      () => revenueWhere(sql`site_id = ${toBin(topSite)}`),
      async () =>
        parsed(
          await query(siteScoped, {
            dataset: 'f_sales_line',
            period: PERIOD,
            dimensions: ['site_id'],
            measures: ['revenue'],
          }),
        ),
    );
    expect(result.rows.map((row) => row.values.site_id)).toEqual([topSite]);
    expect(result.totals!.revenue).toBe(expected);
    // Sans dimension : toujours son site.
    const total = parsed(
      await query(siteScoped, { dataset: 'f_sales_line', period: PERIOD, measures: ['revenue'] }),
    );
    expect(total.rows).toHaveLength(1);
    // Un filtre sur un autre site ne lui rend rien (la clause de portée l'emporte), pas une erreur.
    const other = parsed(
      await query(siteScoped, {
        dataset: 'f_sales_line',
        period: PERIOD,
        measures: ['revenue'],
        filters: [{ field: 'site_id', op: 'EQ', value: secondSite }],
      }),
    );
    expect(other.rows[0]!.values.revenue).toBe(0);
  });

  it('le responsable commercial ne lit que les ventes de son équipe (AT-046, lecture)', async () => {
    expect(teamMembers.length).toBeGreaterThan(0);
    const members = sql.join(teamMembers.map((member) => toBin(member)));
    const { expected, result } = await steady(
      () => revenueWhere(sql`owner_user_id IN (${members})`),
      async () =>
        parsed(
          await query(teamLead, {
            dataset: 'f_sales_line',
            period: PERIOD,
            dimensions: ['commercial_user_id', 'seller_user_id'],
            measures: ['revenue'],
          }),
        ),
    );
    expect(expected).toBeGreaterThan(0);
    expect(result.totals!.revenue).toBe(expected);
    for (const row of result.rows) {
      const owner = (row.values.commercial_user_id ?? row.values.seller_user_id) as string;
      expect(teamMembers, `${owner} n’est pas de l’équipe`).toContain(owner);
    }
    const everyone = parsed(
      await query(direction, { dataset: 'f_sales_line', period: PERIOD, measures: ['revenue'] }),
    );
    expect(everyone.rows[0]!.values.revenue as number).toBeGreaterThan(expected);
  });

  // --- Mesures protégées -----------------------------------------------------------------------------------------

  it('une mesure au coût sans la valorisation est refusée : 403 FORBIDDEN_MEASURE, audité et journalisé', async () => {
    const refused = await query(teamLead, {
      dataset: 'f_sales_line',
      period: PERIOD,
      measures: ['revenue', 'margin'],
    });
    expect(refused.statusCode, refused.body).toBe(403);
    expect(errorOf(refused).code).toBe('FORBIDDEN_MEASURE');
    expect(await auditDenied(teamLead)).toContainEqual(
      expect.objectContaining({
        entity_type: 'ANALYTICS_DATASET',
        error_code: 'FORBIDDEN_MEASURE',
      }),
    );
    expect(await logOf(teamLead)).toContainEqual(
      expect.objectContaining({ outcome: 'REFUSED', error_code: 'FORBIDDEN_MEASURE' }),
    );
    // Le même lecteur lit le chiffre d'affaires seul.
    expect(
      parsed(
        await query(teamLead, { dataset: 'f_sales_line', period: PERIOD, measures: ['revenue'] }),
      ).rowCount,
    ).toBe(1);
  });

  it('la valorisation est jugée ligne à ligne comme les ventes : l’intersection des deux étendues', async () => {
    const { expected, result } = await steady(
      async () =>
        Number(
          (
            await sql<{
              v: string | null;
            }>`SELECT COALESCE(SUM(margin_xaf), 0) AS v FROM analytics_f_sales_line
              WHERE business_day ${WINDOW} AND site_id = ${toBin(topSite)}`.execute(db)
          ).rows[0]!.v,
        ),
      async () =>
        parsed(
          await query(siteScoped, {
            dataset: 'f_sales_line',
            period: PERIOD,
            measures: ['margin'],
          }),
        ),
    );
    expect(result.rows[0]!.values.margin).toBe(expected);
    // La Finance lit la marge de tous les sites : elle est plus large que celle du lecteur de site.
    const whole = parsed(
      await query(finance, { dataset: 'f_sales_line', period: PERIOD, measures: ['margin'] }),
    );
    expect(whole.rows[0]!.values.margin).not.toBe(expected);
  });

  // --- Validation et limites -------------------------------------------------------------------------------------

  it('une définition invalide est refusée par le catalogue : 400 avec le code et le champ', async () => {
    const cases: ReadonlyArray<readonly [unknown, number, string]> = [
      [
        { dataset: 'f_inconnu', period: PERIOD, measures: ['revenue'] },
        400,
        'ANALYTICS_FIELD_UNKNOWN',
      ],
      [
        { dataset: 'f_sales_line', period: PERIOD, measures: ['chiffre'] },
        400,
        'ANALYTICS_FIELD_UNKNOWN',
      ],
      [
        { dataset: 'f_sales_line', period: PERIOD, measures: ['revenue'], dimensions: ['couleur'] },
        400,
        'ANALYTICS_FIELD_UNKNOWN',
      ],
      [{ dataset: 'f_sales_line', measures: ['revenue'] }, 400, 'ANALYTICS_PERIOD_REQUIRED'],
      [
        { dataset: 'f_sales_line', period: PERIOD, measures: ['revenue', 'net_by_sale_date'] },
        400,
        'ANALYTICS_MIXED_PERIOD_BASIS',
      ],
      [
        {
          dataset: 'f_sales_line',
          period: { code: 'CUSTOM', fromDay: '2020-01-01', toDay: '2026-12-31' },
          measures: ['revenue'],
        },
        400,
        'PERIOD_TOO_LONG',
      ],
      [
        {
          dataset: 'f_stock_balance',
          period: { code: 'TODAY' },
          measures: ['balance'],
        },
        400,
        'ANALYTICS_DEFINITION_INVALID',
      ],
      // Un jour qui n'existe pas au calendrier n'atteint pas le SQL (P9-25, EP-3).
      [
        {
          dataset: 'f_sales_line',
          period: PERIOD,
          measures: ['revenue'],
          filters: [{ field: 'business_day', op: 'EQ', value: '2026-02-30' }],
        },
        400,
        'ANALYTICS_DEFINITION_INVALID',
      ],
    ];
    for (const [definition, status, code] of cases) {
      const response = await query(finance, definition);
      expect(response.statusCode, `${code} : ${response.body}`).toBe(status);
      expect(errorOf(response).code).toBe(code);
    }
    // Forme du corps : ni définition ni vue, ou les deux, ou un champ mal formé.
    for (const body of [
      {},
      { definition: {}, viewId: freshUuid() },
      { definition: { dataset: 1 } },
    ]) {
      const response = await call(finance, 'POST', '/api/v1/analytics/query', body);
      expect(response.statusCode, JSON.stringify(body)).toBe(400);
      expect(errorOf(response).code).toBe('VALIDATION_ERROR');
    }
  });

  it('un jeu d’état se lit sans période', async () => {
    const result = parsed(
      await query(finance, {
        dataset: 'f_stock_balance',
        measures: ['balance'],
        dimensions: ['location_type'],
      }),
    );
    expect(result.period).toBeNull();
    expect(result.rows.length).toBeGreaterThan(0);
  });

  it('une limite de lignes au-delà du plafond est une erreur 422, jamais une troncature', async () => {
    const response = await query(finance, {
      dataset: 'f_sales_line',
      period: PERIOD,
      measures: ['revenue'],
      dimensions: ['business_day'],
      limit: 100_000,
    });
    expect(response.statusCode, response.body).toBe(422);
    expect(errorOf(response)).toMatchObject({
      code: 'QUERY_LIMIT_EXCEEDED',
      details: { limit: 'rows' },
    });
    expect(await logOf(finance)).toContainEqual(
      expect.objectContaining({ outcome: 'LIMIT', error_code: 'QUERY_LIMIT_EXCEEDED' }),
    );
  });

  it('au plus deux requêtes simultanées par utilisateur : la troisième est refusée en 429', async () => {
    const holder = await newActor('FINANCE', root);
    tokens.set(
      holder.userId,
      await signTestAccessToken(
        app.get(JWT_KEYS).privateKey,
        { sub: holder.userId, device_id: holder.deviceId, session_id: freshUuid() },
        clock.now(),
      ),
    );
    const definition = { dataset: 'f_sales_line', period: PERIOD, measures: ['revenue'] };
    await db.connection().execute(async (one) => {
      await db.connection().execute(async (two) => {
        expect(await acquireQuerySlot(one, holder.userId, 2)).toBe(1);
        expect(await acquireQuerySlot(two, holder.userId, 2)).toBe(2);
        const refused = await query(holder, definition);
        expect(refused.statusCode, refused.body).toBe(429);
        expect(errorOf(refused)).toMatchObject({
          code: 'QUERY_LIMIT_EXCEEDED',
          details: { limit: 'concurrency' },
        });
        await releaseQuerySlot(one, holder.userId, 1);
        expect((await query(holder, definition)).statusCode).toBe(200);
        await releaseQuerySlot(two, holder.userId, 2);
      });
    });
    expect(await logOf(holder)).toEqual([
      expect.objectContaining({ outcome: 'LIMIT', error_code: 'QUERY_LIMIT_EXCEEDED' }),
      expect.objectContaining({ outcome: 'OK', error_code: null }),
    ]);
  });

  // --- Vues sauvegardées -----------------------------------------------------------------------------------------

  it('une vue sauvegardée s’exécute avec les droits de l’exécutant, visible du propriétaire et des rôles destinataires seulement', async () => {
    const viewId = freshUuid();
    await db
      .insertInto('analytics_saved_views')
      .values({
        id: toBin(viewId),
        owner_user_id: toBin(finance.userId),
        name: `Marge ${viewId}`,
        dataset: 'f_sales_line',
        definition: JSON.stringify({
          dataset: 'f_sales_line',
          period: PERIOD,
          dimensions: [],
          measures: ['revenue', 'margin'],
          filters: [],
          sort: [],
        }),
        catalog_version: 1,
        shared_with_roles: JSON.stringify(['RESP_COMMERCIAL']),
        created_by: toBin(finance.userId),
      })
      .execute();
    const run = (actor: Actor) => call(actor, 'POST', '/api/v1/analytics/query', { viewId });
    // Le propriétaire (Finance) lit la marge.
    expect(parsed(await run(finance)).rows[0]!.values.margin).toBeTypeOf('number');
    // Un rôle destinataire la voit, mais avec SES droits : la marge lui est refusée.
    const shared = await run(teamLead);
    expect(shared.statusCode, shared.body).toBe(403);
    expect(errorOf(shared).code).toBe('FORBIDDEN_MEASURE');
    // Un autre rôle ne voit pas la vue : 404 opaque, audité.
    const hidden = await run(direction);
    expect(hidden.statusCode, hidden.body).toBe(404);
    expect(await auditDenied(direction)).toContainEqual(
      expect.objectContaining({ entity_type: 'SAVED_VIEW' }),
    );
    // Une vue inconnue est indiscernable d'une vue invisible.
    const unknown = await call(direction, 'POST', '/api/v1/analytics/query', {
      viewId: freshUuid(),
    });
    expect(unknown.statusCode).toBe(404);
  });

  it('une vue dont un champ a disparu est OUTDATED : 409, jamais réécrite en silence', async () => {
    const viewId = freshUuid();
    await db
      .insertInto('analytics_saved_views')
      .values({
        id: toBin(viewId),
        owner_user_id: toBin(finance.userId),
        name: `Ancienne ${viewId}`,
        dataset: 'f_sales_line',
        definition: JSON.stringify({
          dataset: 'f_sales_line',
          period: PERIOD,
          dimensions: ['canal_disparu'],
          measures: ['revenue'],
          filters: [],
          sort: [],
        }),
        catalog_version: 1,
        shared_with_roles: JSON.stringify([]),
        created_by: toBin(finance.userId),
      })
      .execute();
    const response = await call(finance, 'POST', '/api/v1/analytics/query', { viewId });
    expect(response.statusCode, response.body).toBe(409);
    expect(errorOf(response)).toMatchObject({
      code: 'VIEW_OUTDATED',
      details: { view_id: viewId },
    });
    const stored = await db
      .selectFrom('analytics_saved_views')
      .select('definition')
      .where('id', '=', toBin(viewId))
      .executeTakeFirstOrThrow();
    expect(JSON.stringify(stored.definition)).toContain('canal_disparu');
  });

  // --- Journal -----------------------------------------------------------------------------------------------------

  it('chaque requête laisse une ligne du journal technique : jeu, résultat, lignes et durée', async () => {
    const actor = await newActor('FINANCE', root);
    tokens.set(
      actor.userId,
      await signTestAccessToken(
        app.get(JWT_KEYS).privateKey,
        { sub: actor.userId, device_id: actor.deviceId, session_id: freshUuid() },
        clock.now(),
      ),
    );
    const ok = parsed(
      await query(actor, {
        dataset: 'f_sales_line',
        period: PERIOD,
        dimensions: ['site_id'],
        measures: ['revenue'],
      }),
    );
    await query(actor, { dataset: 'f_inconnu', period: PERIOD, measures: ['revenue'] });
    const logged = await logOf(actor);
    expect(logged).toEqual([
      expect.objectContaining({
        dataset: 'f_sales_line',
        outcome: 'OK',
        row_count: ok.rowCount,
        error_code: null,
      }),
      expect.objectContaining({
        dataset: 'f_inconnu',
        outcome: 'REFUSED',
        error_code: 'ANALYTICS_FIELD_UNKNOWN',
      }),
    ]);
    expect(logged[0]!.duration_ms).toBeTypeOf('number');
    const definition = await db
      .selectFrom('analytics_query_log')
      .select('definition')
      .where('user_id', '=', toBin(actor.userId))
      .where('outcome', '=', 'OK')
      .executeTakeFirstOrThrow();
    expect(definition.definition).toMatchObject({
      catalogVersion: 1,
      period: { code: 'CUSTOM', fromDay: '2024-01-01', toDay: '2026-12-31' },
    });
  });
});
