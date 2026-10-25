/**
 * P9-16 et P9-17 — tableaux de rôle et tour de contrôle (ADR-075, ADR-076 ; BR-ANA-001, 002, 005, 009 ; AT-038,
 * AT-054) : NestJS + Fastify (`app.inject()`), rôles réels du seed et rôles d'essai. Démontre la structure et l'ordre des
 * blocs (D11 §7.2), le droit par tableau (401, 403 audité), la période (nommée ou plage, 400 sinon), la période
 * précédente des seuls flux, le masquage des valeurs au coût sans `inventory.valuation.read`, l'égalité du tableau et
 * de l'instantané personnel (mêmes chiffres), **l'égalité du tableau et de l'explorateur** pour chaque indicateur de flux
 * qui a une mesure d'explorateur (BR-ANA-009) et les traductions exactes de l'étendue en portée de lecture.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { kpiDefinitionOf, kpiHasPreviousPeriod, type Clock } from '@gic/domain';
import {
  analyticsQueryResponseSchema,
  dashboardResponseSchema,
  type DashboardResponse,
} from '@gic/contracts';
import { AppModule } from '../src/app.module.js';
import { CLOCK } from '../src/platform/clock.provider.js';
import { ID_GENERATOR } from '../src/platform/id-generator.provider.js';
import { registerCorrelationId } from '../src/platform/http/register-correlation-id.js';
import { toBin } from '../src/platform/kysely/uuid-columns.js';
import { JWT_KEYS } from '../src/modules/identity/jwt-keys.provider.js';
import { listSnapshotsOf } from '../src/modules/analytics/application/public/index.js';
import { refreshSnapshotsOf } from '../src/analytics-api/jobs/kpi-snapshots-refresh-job.js';
import { readScopeOf } from '../src/analytics-api/dashboards/scope-adapter.js';
import { ALL_SCOPE } from '../src/platform/read-scope.js';
import { newActor, type Actor } from './cash-transfer-fixtures.js';
import { actorWith, type CommandActor } from './analytics-command-fixtures.js';
import { closeTestDb, db, freshUuid, insertTestUser, signTestAccessToken } from './helpers.js';

const BLOCK_ORDER = {
  direction: [
    'PRODUCTION',
    'STOCK',
    'DISTRIBUTION',
    'VENTES',
    'FINANCES',
    'EQUIPES',
    'ALERTES',
    'COORDINATION',
  ],
  commercial: ['COMMERCIAL', 'VENTES', 'EQUIPES', 'ALERTES'],
  stock: ['STOCK', 'DISTRIBUTION', 'ALERTES'],
  production: ['PRODUCTION', 'ALERTES'],
  finance: ['FINANCES', 'VENTES', 'ALERTES', 'COORDINATION'],
} as const;

describe('P9-16 et P9-17 : tableaux de rôle', { timeout: 180_000 }, () => {
  let app: NestFastifyApplication;
  let clock: Clock;
  let root: string;
  let direction: Actor;
  let finance: Actor;
  let stockHolder: CommandActor & { roleCode: string };
  let financeNoValuation: CommandActor & { roleCode: string };
  let nobody: CommandActor & { roleCode: string };
  const tokens = new Map<string, string>();

  const get = (actor: { id?: string; userId?: string }, url: string) =>
    app.inject({
      method: 'GET',
      url,
      headers: { authorization: `Bearer ${tokens.get((actor.id ?? actor.userId)!)!}` },
    });
  const dashboard = async (
    actor: { id?: string; userId?: string },
    code: string,
    query = 'period=MONTH',
  ): Promise<DashboardResponse> => {
    const response = await get(actor, `/api/v1/analytics/dashboards/${code}?${query}`);
    expect(response.statusCode, response.body).toBe(200);
    return dashboardResponseSchema.parse(response.json());
  };

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

    root = await db.transaction().execute((trx) => insertTestUser(trx));
    direction = await newActor('DIRECTION', root);
    finance = await newActor('FINANCE', root);
    stockHolder = await actorWith(root, ['analytics.dashboard.stock']);
    financeNoValuation = await actorWith(root, ['analytics.dashboard.finance']);
    nobody = await actorWith(root, ['sales.sale.read']);
    const everyone: { id: string; deviceId: string }[] = [
      { id: direction.userId, deviceId: direction.deviceId },
      { id: finance.userId, deviceId: finance.deviceId },
      stockHolder,
      financeNoValuation,
      nobody,
    ];
    for (const actor of everyone) {
      tokens.set(
        actor.id,
        await signTestAccessToken(
          jwtKeys.privateKey,
          { sub: actor.id, device_id: actor.deviceId, session_id: freshUuid() },
          clock.now(),
        ),
      );
    }
  });
  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  describe('droits et période', () => {
    it('401 sans jeton ; 403 audité sans la permission du tableau ; une permission d’un autre tableau ne suffit pas', async () => {
      expect(
        (await app.inject({ method: 'GET', url: '/api/v1/analytics/dashboards/direction' }))
          .statusCode,
      ).toBe(401);
      const refused = await get(nobody, '/api/v1/analytics/dashboards/direction');
      expect(refused.statusCode).toBe(403);
      const denied = await db
        .selectFrom('audit_audit_log')
        .select(['entity_type', 'error_code'])
        .where('actor_user_id', '=', toBin(nobody.id))
        .where('action', '=', 'access.denied')
        .execute();
      expect(denied).toEqual([
        { entity_type: 'ANALYTICS_DASHBOARD_DIRECTION', error_code: 'FORBIDDEN' },
      ]);
      // `analytics.dashboard.stock` ne donne pas le tableau de direction.
      expect((await get(stockHolder, '/api/v1/analytics/dashboards/direction')).statusCode).toBe(
        403,
      );
      expect((await get(stockHolder, '/api/v1/analytics/dashboards/stock')).statusCode).toBe(200);
    });

    it('période : défaut TODAY, nommée, plage inclusive ; nommée avec dates, plage incomplète, jour impossible ou trop longue : 400', async () => {
      const today = await dashboard(direction, 'direction', '');
      expect(today.period.code).toBe('TODAY');
      expect(today.period.days).toBe(1);
      expect(today.previousPeriod.days).toBe(1);
      const range = await dashboard(direction, 'direction', 'from=2026-10-01&to=2026-10-10');
      expect(range.period).toMatchObject({
        code: 'CUSTOM',
        fromDay: '2026-10-01',
        toDay: '2026-10-10',
        days: 10,
      });
      expect(range.previousPeriod).toMatchObject({
        fromDay: '2026-09-21',
        toDay: '2026-09-30',
        days: 10,
      });
      for (const query of [
        'period=MONTH&from=2026-10-01&to=2026-10-10',
        'from=2026-10-01',
        'from=2026-02-30&to=2026-03-01',
        'from=2020-01-01&to=2026-10-01',
        'period=SIECLE',
      ]) {
        expect(
          (await get(direction, `/api/v1/analytics/dashboards/direction?${query}`)).statusCode,
          query,
        ).toBe(400);
      }
    });
  });

  describe('structure', () => {
    for (const [code, blocks] of Object.entries(BLOCK_ORDER)) {
      it(`${code} : blocs dans l’ordre de D11 §7.2, chacun rendu ou indisponible, fraîcheur et date de calcul`, async () => {
        const actor = code === 'finance' ? finance : direction;
        const response = await dashboard(actor, code);
        expect(response.code).toBe(code);
        expect(response.blocks.map((block) => block.code)).toEqual(blocks);
        for (const block of response.blocks) {
          if (block.unavailable !== null) expect(block.kpis).toEqual([]);
          // Seul le bloc de distribution peut être vide : sans point de vente dans la portée, rien à lire (jamais « tout »).
          else if (block.code !== 'DISTRIBUTION') {
            expect(block.kpis.length + block.details.length, block.code).toBeGreaterThan(0);
          }
        }
        expect(response.freshness.staleAfterHours).toBeGreaterThan(0);
        expect(response.computedAt).toBe(response.freshness.computedAt);
      });
    }

    it('chaque indicateur porte un code du registre ; la période précédente n’existe que pour les flux', async () => {
      const response = await dashboard(direction, 'direction');
      for (const block of response.blocks) {
        for (const kpi of block.kpis) {
          // Les compteurs d'alertes et de validations (`KPI-OPS-*`) ne sont pas des indicateurs du registre de D11 §7.1.
          if (!kpi.code.startsWith('KPI-OPS-')) expect(kpiDefinitionOf(kpi.code), kpi.code).toBeDefined();
          const hasPrevious = kpi.previousValue !== undefined;
          expect(hasPrevious, `${kpi.code} période précédente`).toBe(
            kpiHasPreviousPeriod(kpi.code),
          );
        }
      }
    });
  });

  describe('valeurs au coût (RC-05)', () => {
    it('sans inventory.valuation.read, toute valeur au coût vaut null, sans lien d’exploration ni période précédente', async () => {
      const masked = await dashboard(financeNoValuation, 'finance');
      let protectedSeen = 0;
      for (const block of masked.blocks) {
        for (const kpi of block.kpis) {
          if (kpiDefinitionOf(kpi.code)?.protected !== true) continue;
          protectedSeen += 1;
          expect(kpi.value, kpi.code).toBeNull();
          expect(kpi.explore ?? null, kpi.code).toBeNull();
          expect(kpi.previousValue ?? null, kpi.code).toBeNull();
        }
      }
      expect(protectedSeen).toBeGreaterThan(0);
    });
  });

  describe('AT-054 : les mêmes chiffres partout', () => {
    it('l’instantané personnel d’une période égale le tableau de la même période', async () => {
      await db.transaction().execute((trx) => refreshSnapshotsOf(trx, stockHolder.id, clock.now()));
      const snapshots = await listSnapshotsOf(db, stockHolder.id);
      const month = snapshots.find(
        (snapshot) => snapshot.periodKey === 'MONTH' && snapshot.scopeKey === 'stock',
      );
      expect(month).toBeDefined();
      const live = await dashboard(stockHolder, 'stock', 'period=MONTH');
      const liveKpis = live.blocks.flatMap((block) =>
        block.kpis.map(({ explore: _explore, ...rest }) => rest),
      );
      expect(month!.kpis).toEqual(JSON.parse(JSON.stringify(liveKpis)));
    });

    it('chaque indicateur de flux qui a une mesure d’explorateur égale cette mesure, dans la même période et la même étendue', async () => {
      const live = await dashboard(direction, 'direction', 'period=MONTH');
      const compared: string[] = [];
      const gaps: string[] = [];
      for (const block of live.blocks) {
        for (const kpi of block.kpis) {
          const definition = kpiDefinitionOf(kpi.code);
          if (definition?.explorer === undefined || definition.nature !== 'FLOW') continue;
          if (kpi.value === null || kpi.unit === 'pct' || kpi.unit === 'ratio') continue;
          const response = await app.inject({
            method: 'POST',
            url: '/api/v1/analytics/query',
            headers: {
              authorization: `Bearer ${tokens.get(direction.userId)!}`,
              'content-type': 'application/json',
            },
            payload: JSON.stringify({
              definition: {
                dataset: definition.explorer.dataset,
                period: { code: 'MONTH' },
                measures: [definition.explorer.measure],
              },
            }),
          });
          if (response.statusCode !== 200) {
            gaps.push(`${kpi.code} : explorateur ${response.statusCode}`);
            continue;
          }
          const row = analyticsQueryResponseSchema.parse(response.json()).rows[0];
          const explored = row?.values[definition.explorer.measure] ?? 0;
          compared.push(kpi.code);
          if (Number(explored) !== kpi.value)
            gaps.push(`${kpi.code} : tableau ${kpi.value}, explorateur ${explored}`);
        }
      }
      expect(compared.length).toBeGreaterThan(0);
      expect(gaps).toEqual([]);
    });
  });

  describe('traduction exacte de l’étendue en portée de lecture (AV-495)', () => {
    const user = freshUuid();
    const other = freshUuid();
    const siteA = freshUuid();
    const siteB = freshUuid();

    it('étendue totale, vide, « tout site » : tout, rien, tout', async () => {
      expect(await readScopeOf(db, { kind: 'ALL' })).toBe(ALL_SCOPE);
      expect(await readScopeOf(db, { kind: 'CLAUSES', clauses: [], truncated: false })).toEqual({
        siteIds: [],
      });
      expect(
        await readScopeOf(db, {
          kind: 'CLAUSES',
          clauses: [{ type: 'ANY_SITE' }],
          truncated: false,
        }),
      ).toBe(ALL_SCOPE);
    });

    it('sites seuls, personnes seules, périmètre et soi : exprimés exactement', async () => {
      expect(
        await readScopeOf(db, {
          kind: 'CLAUSES',
          clauses: [{ type: 'SITES', ids: [siteA], viaZoneIds: [siteB] }],
          truncated: false,
        }),
      ).toEqual({ siteIds: [siteA, siteB] });
      expect(
        await readScopeOf(db, {
          kind: 'CLAUSES',
          clauses: [{ type: 'PERSONS', ids: [user, other] }],
          truncated: false,
        }),
      ).toEqual({ userIds: [user, other] });
      expect(
        await readScopeOf(db, {
          kind: 'CLAUSES',
          clauses: [{ type: 'SITES_AND_SELF', ids: [siteA], viaZoneIds: [], userId: user }],
          truncated: false,
        }),
      ).toEqual({ siteIds: [siteA], userIds: [user] });
    });

    it('sites OU personnes, ou couples de deux personnes : non représentables, jamais élargis (null)', async () => {
      expect(
        await readScopeOf(db, {
          kind: 'CLAUSES',
          clauses: [
            { type: 'SITES', ids: [siteA], viaZoneIds: [] },
            { type: 'PERSONS', ids: [user] },
          ],
          truncated: false,
        }),
      ).toBeNull();
      expect(
        await readScopeOf(db, {
          kind: 'CLAUSES',
          clauses: [
            { type: 'SITES_AND_SELF', ids: [siteA], viaZoneIds: [], userId: user },
            { type: 'SITES_AND_SELF', ids: [siteB], viaZoneIds: [], userId: other },
          ],
          truncated: false,
        }),
      ).toBeNull();
    });
  });
});
