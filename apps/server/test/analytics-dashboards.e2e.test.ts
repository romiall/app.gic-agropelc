/**
 * P9-16 et P9-17 — tableaux de rôle et tour de contrôle (ADR-065, ADR-066 ; BR-ANA-001, 002, 005, 009 ; AT-038,
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
import {
  costPerHead,
  latestWeighing,
  referenceLotType,
} from '../src/modules/production/application/public/index.js';
import { refreshSnapshotsOf } from '../src/analytics-api/jobs/kpi-snapshots-refresh-job.js';
import { readScopeOf, scopeIssueOf } from '../src/analytics-api/dashboards/scope-adapter.js';
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

/** Compteurs des tableaux qui ne sont pas des indicateurs du registre (D11 §7.1). */
const NON_REGISTRY_COUNTERS: ReadonlySet<string> = new Set([
  'KPI-OPS-ALERTS-CRITICAL',
  'KPI-OPS-ALERTS-WARNING',
  'KPI-OPS-ALERTS-INFO',
  'KPI-OPS-APPROVALS',
]);

describe('P9-16 et P9-17 : tableaux de rôle', { timeout: 180_000 }, () => {
  let app: NestFastifyApplication;
  let clock: Clock;
  let root: string;
  let direction: Actor;
  let finance: Actor;
  let stockHolder: CommandActor & { roleCode: string };
  let financeNoValuation: CommandActor & { roleCode: string };
  let directionPlain: CommandActor & { roleCode: string };
  let directionValued: CommandActor & { roleCode: string };
  let productionPlain: CommandActor & { roleCode: string };
  let productionValued: CommandActor & { roleCode: string };
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
    directionPlain = await actorWith(root, ['analytics.dashboard.direction']);
    directionValued = await actorWith(root, [
      'analytics.dashboard.direction',
      'inventory.valuation.read',
    ]);
    productionPlain = await actorWith(root, ['analytics.dashboard.production']);
    productionValued = await actorWith(root, [
      'analytics.dashboard.production',
      'inventory.valuation.read',
    ]);
    nobody = await actorWith(root, ['sales.sale.read']);
    const everyone: { id: string; deviceId: string }[] = [
      { id: direction.userId, deviceId: direction.deviceId },
      { id: finance.userId, deviceId: finance.deviceId },
      stockHolder,
      financeNoValuation,
      directionPlain,
      directionValued,
      productionPlain,
      productionValued,
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
          // Les compteurs d'alertes et de validations ne sont pas des indicateurs du registre de D11 §7.1 ;
          // KPI-OPS-02 et KPI-OPS-02-CONFLICTS le sont (AV-462, P9-27). Un indicateur à créer n'entrerait pas dans un
          // tableau avant sa fonction de référence (ADR-065 §1) : tous sont `EXISTING`.
          if (!NON_REGISTRY_COUNTERS.has(kpi.code)) {
            expect(kpiDefinitionOf(kpi.code), kpi.code).toBeDefined();
            expect(kpiDefinitionOf(kpi.code)?.state, kpi.code).toBe('EXISTING');
          }
          const hasPrevious = kpi.previousValue !== undefined;
          expect(hasPrevious, `${kpi.code} période précédente`).toBe(
            kpiHasPreviousPeriod(kpi.code),
          );
        }
      }
    });
  });

  describe('AV-462 (P9-27) : cinq indicateurs dans les bons tableaux', () => {
    const kpiCodes = (response: DashboardResponse, blockCode: string): string[] =>
      response.blocks.find((block) => block.code === blockCode)?.kpis.map((kpi) => kpi.code) ?? [];

    it('production et direction portent KPI-PRD-04, 05 et 09 dans PRODUCTION ; commercial et direction KPI-COM-16 dans EQUIPES', async () => {
      const [directionBoard, productionBoard, commercialBoard] = await Promise.all([
        dashboard(direction, 'direction'),
        dashboard(direction, 'production'),
        dashboard(direction, 'commercial'),
      ]);
      for (const board of [directionBoard, productionBoard]) {
        expect(kpiCodes(board, 'PRODUCTION')).toEqual(
          expect.arrayContaining(['KPI-PRD-04', 'KPI-PRD-05', 'KPI-PRD-09']),
        );
      }
      for (const board of [directionBoard, commercialBoard]) {
        // DIRECTION détient `crm.target.read` (ALL) : l'indicateur est présent, de valeur nulle sans objectif.
        expect(kpiCodes(board, 'EQUIPES')).toContain('KPI-COM-16');
        const attainment = board.blocks
          .find((block) => block.code === 'EQUIPES')!
          .kpis.find((kpi) => kpi.code === 'KPI-COM-16')!;
        expect(attainment.unit).toBe('pct');
        // Un ratio n'a pas de période précédente.
        expect(attainment.previousValue).toBeUndefined();
      }
    });

    it('KPI-OPS-02 et son compteur de conflits (DIRECTION détient sync.conflict.resolve) sont dans DISTRIBUTION, sur direction et stock', async () => {
      for (const code of ['direction', 'stock'] as const) {
        const board = await dashboard(direction, code);
        const block = board.blocks.find((candidate) => candidate.code === 'DISTRIBUTION')!;
        expect(block.unavailable, code).toBeNull();
        // Une base sans point de vente rend un bloc vide (jamais « tout ») : l'assertion est alors la vacuité.
        if (block.kpis.length === 0) {
          expect(block.details, code).toEqual([]);
          continue;
        }
        const codes = block.kpis.map((kpi) => kpi.code);
        expect(codes, code).toEqual(expect.arrayContaining(['KPI-OPS-02', 'KPI-OPS-02-CONFLICTS']));
        for (const opsCode of ['KPI-OPS-02', 'KPI-OPS-02-CONFLICTS']) {
          const kpi = block.kpis.find((candidate) => candidate.code === opsCode)!;
          expect(kpi.unit).toBe('count');
          expect(kpi.value, opsCode).toBeGreaterThanOrEqual(0);
          expect(kpi.previousValue, opsCode).toBeUndefined();
        }
      }
    });

    it('un lecteur sans crm.target.read ne voit pas KPI-COM-16 (absent, jamais 0)', async () => {
      // `directionPlain` n'a que le tableau de direction : aucune permission d'objectifs.
      const board = await dashboard(directionPlain, 'direction');
      expect(kpiCodes(board, 'EQUIPES')).not.toContain('KPI-COM-16');
      expect(
        board.blocks
          .find((block) => block.code === 'EQUIPES')!
          .details.filter((detail) => detail.label.startsWith('Atteinte d’objectif')),
      ).toEqual([]);
    });
  });

  describe('valeurs au coût (RC-05)', () => {
    /** Coût par tête du type de lot de référence, comme le bloc PRODUCTION le choisit (AV-475, AV-478). */
    const referenceCostPerHead = async (): Promise<number | null> => {
      const [weighing, cost] = await Promise.all([
        latestWeighing(db, ALL_SCOPE, { at: clock.now() }),
        costPerHead(db, ALL_SCOPE),
      ]);
      const reference = referenceLotType(weighing.byLotType);
      return cost.byLotType.find((type) => type.lotType === reference)?.costPerHeadXaf ?? null;
    };
    const costPerHeadKpi = (response: DashboardResponse) =>
      response.blocks
        .find((block) => block.code === 'PRODUCTION')!
        .kpis.find((kpi) => kpi.code === 'KPI-PRD-09')!;

    it('KPI-PRD-09 : valeur et lien nuls sans inventory.valuation.read (direction et production) ; avec le droit, la valeur de costPerHead', async () => {
      for (const [actor, code] of [
        [directionPlain, 'direction'],
        [productionPlain, 'production'],
      ] as const) {
        const masked = costPerHeadKpi(await dashboard(actor, code));
        expect(masked.value, code).toBeNull();
        expect(masked.explore ?? null, code).toBeNull();
      }
      for (const [actor, code] of [
        [directionValued, 'direction'],
        [productionValued, 'production'],
      ] as const) {
        // La base est partagée : le coût est lu avant et après le tableau, la valeur égale l'une des deux lectures.
        const before = await referenceCostPerHead();
        const shown = costPerHeadKpi(await dashboard(actor, code));
        const after = await referenceCostPerHead();
        expect([before, after], code).toContain(shown.value);
      }
    });

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

    it('masque vers registre : tout indicateur que la perte de la valorisation fait passer de non nul à nul est protégé au registre (TB-7)', async () => {
      // Même étendue des deux côtés : seule la valorisation diffère. La lecture revérifiée d'un instantané masque les
      // seuls indicateurs protégés du registre : une valeur au coût absente du registre resterait lisible.
      const valued = await dashboard(directionValued, 'direction');
      const plain = await dashboard(directionPlain, 'direction');
      const plainByCode = new Map(
        plain.blocks.flatMap((block) => block.kpis).map((kpi) => [kpi.code, kpi]),
      );
      let maskedSeen = 0;
      for (const kpi of valued.blocks.flatMap((block) => block.kpis)) {
        const other = plainByCode.get(kpi.code);
        if (other === undefined || kpi.value === null || other.value !== null) continue;
        maskedSeen += 1;
        expect(kpiDefinitionOf(kpi.code)?.protected, kpi.code).toBe(true);
      }
      expect(maskedSeen).toBeGreaterThan(0);
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

    it('le bloc DISTRIBUTION de la tour de contrôle égale l’instantané distribution (TB-4, AV-467)', async () => {
      await db
        .transaction()
        .execute((trx) => refreshSnapshotsOf(trx, direction.userId, clock.now()));
      const month = (await listSnapshotsOf(db, direction.userId)).find(
        (snapshot) => snapshot.scopeKey === 'distribution' && snapshot.periodKey === 'MONTH',
      );
      expect(month).toBeDefined();
      const live = await dashboard(direction, 'direction', 'period=MONTH');
      const block = live.blocks.find((candidate) => candidate.code === 'DISTRIBUTION');
      expect(block).toBeDefined();
      // Sans lien d'exploration ; liste vide des deux côtés quand la base n'a aucun point de vente.
      const blockKpis = block!.kpis.map(({ explore: _explore, ...rest }) => rest);
      expect(month!.kpis).toEqual(JSON.parse(JSON.stringify(blockKpis)));
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
                filters: [...(definition.explorer.filters ?? [])],
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
      // P9-27 : l'aliment consommé (KPI-PRD-04) est un flux à mesure d'explorateur égale (AV-476).
      expect(compared).toContain('KPI-PRD-04');
      expect(gaps).toEqual([]);
    });

    it('l’instantané du tableau production égale le tableau, KPI-PRD-04, 05 et 09 compris (AV-462)', async () => {
      await db
        .transaction()
        .execute((trx) => refreshSnapshotsOf(trx, productionValued.id, clock.now()));
      const month = (await listSnapshotsOf(db, productionValued.id)).find(
        (snapshot) => snapshot.periodKey === 'MONTH' && snapshot.scopeKey === 'production',
      );
      expect(month).toBeDefined();
      const live = await dashboard(productionValued, 'production', 'period=MONTH');
      const liveKpis = live.blocks.flatMap((block) =>
        block.kpis.map(({ explore: _explore, ...rest }) => rest),
      );
      const codes = month!.kpis.map((kpi) => kpi.code);
      expect(codes).toEqual(expect.arrayContaining(['KPI-PRD-04', 'KPI-PRD-05', 'KPI-PRD-09']));
      expect(month!.kpis).toEqual(JSON.parse(JSON.stringify(liveKpis)));
    });
  });

  describe('traduction exacte de l’étendue en portée de lecture (AV-445)', () => {
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

    it('étendue tronquée (TB-6) : non exacte donc null, même vide ; « tout site » reste tout', async () => {
      expect(
        await readScopeOf(db, {
          kind: 'CLAUSES',
          clauses: [{ type: 'SITES', ids: [siteA], viaZoneIds: [] }],
          truncated: true,
        }),
      ).toBeNull();
      // Vide mais tronquée : pas { siteIds: [] } (un chiffre plus étroit que le droit sans signal).
      expect(await readScopeOf(db, { kind: 'CLAUSES', clauses: [], truncated: true })).toBeNull();
      expect(
        await readScopeOf(db, {
          kind: 'CLAUSES',
          clauses: [{ type: 'ANY_SITE' }],
          truncated: true,
        }),
      ).toBe(ALL_SCOPE);
    });

    it('scopeIssueOf : SCOPE_TRUNCATED pour une étendue tronquée, SCOPE_UNSUPPORTED sinon (TB-6)', () => {
      expect(
        scopeIssueOf({
          kind: 'CLAUSES',
          clauses: [{ type: 'SITES', ids: [siteA], viaZoneIds: [] }],
          truncated: true,
        }),
      ).toBe('SCOPE_TRUNCATED');
      expect(
        scopeIssueOf({
          kind: 'CLAUSES',
          clauses: [
            { type: 'SITES', ids: [siteA], viaZoneIds: [] },
            { type: 'PERSONS', ids: [user] },
          ],
          truncated: false,
        }),
      ).toBe('SCOPE_UNSUPPORTED');
      expect(scopeIssueOf({ kind: 'ALL' })).toBe('SCOPE_UNSUPPORTED');
    });
  });
});
