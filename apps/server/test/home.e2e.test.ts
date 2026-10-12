/**
 * Accueil par rôle (ECR-ADM-03, UX-01 ; ADR-030) de bout en bout : NestJS + Fastify,
 * `app.inject()` (même gabarit que inventory-read.e2e.test.ts), rôles réels du seed
 * (`MAGASINIER`, `VENDEUR_PDV`) affectés à des sites neufs, seuils posés par le vrai pipeline
 * de commande, soldes d'ouverture par `recordStockMove`, sur une base réelle.
 *
 * Démontre : authentification exigée ; un utilisateur sans rôle reçoit une page vide mais
 * valide ; **isolation par site** (le magasinier du site A ne voit ni la rupture ni le seuil
 * du site B, et inversement) ; union des sections d'un utilisateur à plusieurs rôles, dans
 * l'ordre du catalogue (UX-01) ; mesure de valeur masquée sans `inventory.valuation.read`
 * (BR-ANA-004) ; actions sans écran renvoyées sans route (« bientôt », ADR-030 §8) ; réponse
 * conforme au contrat partagé (`homeResponseSchema`).
 *
 * Les chiffres globaux de la base de test (partagée et persistante) ne sont jamais affirmés :
 * seuls les chiffres des sites neufs de ce fichier le sont.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { homeResponseSchema, type HomeResponse } from '@gic/contracts';
import type { Clock, IdGenerator } from '@gic/domain';
import { AppModule } from '../src/app.module.js';
import { CLOCK } from '../src/platform/clock.provider.js';
import { ID_GENERATOR } from '../src/platform/id-generator.provider.js';
import { registerCorrelationId } from '../src/platform/http/register-correlation-id.js';
import { fromBin, toBin } from '../src/platform/kysely/uuid-columns.js';
import { JWT_KEYS } from '../src/modules/identity/jwt-keys.provider.js';
import { signAccessToken } from '../src/modules/identity/application/public/jwt.js';
import { CommandPipelineService } from '../src/commands/command-pipeline.service.js';
import { recordStockMove } from '../src/modules/inventory/application/public/index.js';
import { recordConflict } from '../src/platform/sync/conflicts.js';
import { jsonValue } from '../src/platform/kysely/json-value.js';
import {
  assignTestRole,
  closeTestDb,
  db,
  freshUuid,
  grantTestPermission,
  insertTestDevice,
  insertTestLocation,
  insertTestRole,
  insertTestSite,
  insertTestTeam,
  insertTestTeamMembership,
  insertTestUser,
  insertTestZone,
} from './helpers.js';

const OPENING_AT = '2026-06-01T08:00:00.000Z';
const THRESHOLD_AT = '2026-06-12T08:00:00.000Z';

describe('Accueil par rôle (ADR-030)', () => {
  let app: NestFastifyApplication;
  let clock: Clock;
  let idGenerator: IdGenerator;
  let pipeline: CommandPipelineService;

  let admin: string;
  let adminDevice: string;
  let storekeeperA: string;
  let storekeeperB: string;
  let multiRole: string;
  let valuer: string;
  let noRole: string;
  const tokens: Record<string, string> = {};

  let siteA: string;
  let siteB: string;
  let storeA: string;
  let storeB: string;
  let productStocked: string;
  let productEmpty: string;

  async function home(user: string): Promise<HomeResponse> {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/home',
      headers: { authorization: `Bearer ${tokens[user]}` },
    });
    expect(response.statusCode, response.body).toBe(200);
    // Le contrat partagé avec la PWA fait foi (ADR-030 §1).
    return homeResponseSchema.parse(response.json());
  }

  async function seededRole(code: string): Promise<string> {
    const role = await db
      .selectFrom('identity_roles')
      .select('id')
      .where('code', '=', code)
      .executeTakeFirstOrThrow();
    return fromBin(role.id);
  }

  async function setThreshold(
    locationId: string,
    productId: string,
    minQtyBase: number,
  ): Promise<void> {
    const result = await pipeline.handle(
      {
        command_id: freshUuid(),
        device_seq: 1,
        command_version: 1,
        command_type: 'inventory.threshold.set',
        aggregate_type: 'STOCK_THRESHOLD',
        aggregate_id: freshUuid(),
        author_user_id: admin,
        base_version: null,
        depends_on: [],
        occurred_at: THRESHOLD_AT,
        client_created_at: THRESHOLD_AT,
        captured_offline: false,
        backdated_reason: null,
        attachment_ids: [],
        payload: { locationId, productId, minQtyBase, targetQtyBase: minQtyBase * 3 },
      },
      { authenticatedUserId: admin, authenticatedDeviceId: adminDevice, transport: 'ONLINE_API' },
    );
    expect(result.status, JSON.stringify(result)).toMatch(/^APPLIED/);
  }

  async function openingBalance(
    locationId: string,
    productId: string,
    quantityBase: number,
  ): Promise<void> {
    const opening = await db
      .selectFrom('organization_locations')
      .select('id')
      .where('location_type', '=', 'V_OPENING')
      .executeTakeFirstOrThrow();
    await db.transaction().execute((trx) =>
      recordStockMove(
        trx,
        { idGenerator },
        {
          productId,
          quantityBase,
          fromLocationId: fromBin(opening.id),
          toLocationId: locationId,
          moveType: 'OPENING_BALANCE',
          declaredUnitCostXaf: 500,
          occurredAt: new Date(OPENING_AT),
          sourceDocType: 'INVENTORY_COUNT',
          sourceDocId: freshUuid(),
          createdBy: admin,
          allowNegative: false,
        },
      ),
    );
  }

  beforeAll(async () => {
    process.env.SERVER_DATABASE_URL ??=
      'mysql://gic_app:gic_app_password@127.0.0.1:3306/gic_agropelc_test';

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    registerCorrelationId(app, app.get(ID_GENERATOR));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    clock = app.get(CLOCK);
    idGenerator = app.get(ID_GENERATOR);
    pipeline = app.get(CommandPipelineService);
    const jwtKeys = app.get(JWT_KEYS);

    const magasinier = await seededRole('MAGASINIER');
    const vendeurPdv = await seededRole('VENDEUR_PDV');

    await db.transaction().execute(async (trx) => {
      admin = await insertTestUser(trx);
      storekeeperA = await insertTestUser(trx);
      storekeeperB = await insertTestUser(trx);
      multiRole = await insertTestUser(trx);
      valuer = await insertTestUser(trx);
      noRole = await insertTestUser(trx);
      adminDevice = await insertTestDevice(trx, admin, { status: 'ACTIVE' });

      const zoneId = await insertTestZone(trx, admin);
      siteA = await insertTestSite(trx, admin, zoneId);
      siteB = await insertTestSite(trx, admin, zoneId);
      storeA = await insertTestLocation(trx, admin, siteA, { locationType: 'STORE' });
      storeB = await insertTestLocation(trx, admin, siteB, { locationType: 'STORE' });

      // Auteur des commandes de seuil : rôle de test, droit unique.
      const adminRole = await insertTestRole(trx, admin);
      await grantTestPermission(trx, adminRole, 'inventory.threshold.manage', admin);
      await assignTestRole(trx, admin, adminRole, admin);

      // Rôles réels du seed, affectés à des sites neufs (aucun effet sur les autres tests).
      await assignTestRole(trx, storekeeperA, magasinier, admin, {
        scopeType: 'SITE',
        scopeSiteId: siteA,
      });
      await assignTestRole(trx, storekeeperB, magasinier, admin, {
        scopeType: 'SITE',
        scopeSiteId: siteB,
      });
      await assignTestRole(trx, multiRole, magasinier, admin, {
        scopeType: 'SITE',
        scopeSiteId: siteA,
      });
      await assignTestRole(trx, multiRole, vendeurPdv, admin, {
        scopeType: 'SITE',
        scopeSiteId: siteA,
      });
      // Magasinier du site A qui détient en plus le droit de valorisation (rôle de test).
      await assignTestRole(trx, valuer, magasinier, admin, {
        scopeType: 'SITE',
        scopeSiteId: siteA,
      });
      const valuationRole = await insertTestRole(trx, admin);
      await grantTestPermission(trx, valuationRole, 'inventory.valuation.read', admin);
      await assignTestRole(trx, valuer, valuationRole, admin);

      const categoryId = freshUuid();
      await trx
        .insertInto('catalog_product_categories')
        .values({
          id: toBin(categoryId),
          code: `CAT-${categoryId.slice(-8)}`,
          name: 'Test accueil',
          created_by: toBin(admin),
        })
        .execute();
      const unit = await trx
        .selectFrom('catalog_units')
        .select('code')
        .where('code', '=', 'TETE')
        .executeTakeFirst();
      if (!unit) {
        await trx
          .insertInto('catalog_units')
          .values({ code: 'TETE', name: 'Tête', is_count: 1 })
          .execute();
      }
      const insertProduct = async (name: string): Promise<string> => {
        const id = freshUuid();
        await trx
          .insertInto('catalog_products')
          .values({
            id: toBin(id),
            code: `PRD-${id.slice(-8)}`,
            name,
            category_id: toBin(categoryId),
            stock_family: 'MARCHANDISE',
            base_unit_code: 'TETE',
            lot_tracking: 'NONE',
            created_by: toBin(admin),
          })
          .execute();
        return id;
      };
      productStocked = await insertProduct('Produit approvisionné (accueil)');
      productEmpty = await insertProduct('Produit épuisé (accueil)');
    });

    for (const userId of [admin, storekeeperA, storekeeperB, multiRole, valuer, noRole]) {
      tokens[userId] = await signAccessToken(
        jwtKeys.privateKey,
        { sub: userId, device_id: adminDevice, session_id: freshUuid() },
        clock.now(),
      );
    }

    // Site A : un seuil respecté (10 en stock pour un minimum de 5).
    await openingBalance(storeA, productStocked, 10);
    await setThreshold(storeA, productStocked, 5);
    // Site B : un seuil franchi (4 en stock pour un minimum de 10) et une rupture (aucun stock).
    await openingBalance(storeB, productStocked, 4);
    await setThreshold(storeB, productStocked, 10);
    await setThreshold(storeB, productEmpty, 3);
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await closeTestDb();
  });

  it('exige une authentification', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/home' });
    expect(response.statusCode).toBe(401);
  });

  it('un utilisateur sans rôle reçoit une page vide mais conforme au contrat', async () => {
    const body = await home(noRole);
    expect(body.sections).toEqual([]);
    expect(body.signals).toEqual([]);
    expect(body.user.roles).toEqual([]);
    expect(body.user.fullName.length).toBeGreaterThan(0);
    expect(body.businessDay).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(new Date(body.generatedAt).getTime()).not.toBeNaN();
  });

  it('magasinier du site A : ne voit que son site (seuil respecté, aucune rupture)', async () => {
    const body = await home(storekeeperA);
    expect(body.user.roles).toEqual(['MAGASINIER']);
    expect(body.sections).toHaveLength(1);
    const [section] = body.sections;
    expect(section!.role).toBe('MAGASINIER');
    expect(section!.scopeLabel).toBe('Votre site');

    const out = section!.kpis.find((kpi) => kpi.code === 'KPI-STK-06');
    expect(out?.value).toBe(0);
    expect(out?.detail).toBe('0 sous le seuil · 1 suivis');
    expect(body.signals.map((signal) => signal.code)).not.toContain('STOCK_OUT');
    expect(body.signals.map((signal) => signal.code)).not.toContain('STOCK_LOW');
    // Site sans PDV : aucun bloc de distribution (P5-20, AV-208).
    for (const code of ['KPI-DIS-07', 'KPI-DIS-QUOTAS', 'KPI-OPS-01']) {
      expect(section!.kpis.map((kpi) => kpi.code)).not.toContain(code);
    }
  });

  it('magasinier du site B : voit la rupture de son site, pas le seuil respecté du site A', async () => {
    const body = await home(storekeeperB);
    const [section] = body.sections;
    expect(section!.scopeLabel).toBe('Votre site');

    const out = section!.kpis.find((kpi) => kpi.code === 'KPI-STK-06');
    expect(out?.value).toBe(1);
    // Deux seuils suivis sur ce site ; celui du site A n'est pas compté.
    expect(out?.detail).toBe('1 sous le seuil · 2 suivis');
    const stockOut = body.signals.find((signal) => signal.code === 'STOCK_OUT');
    expect(stockOut?.severity).toBe('CRITICAL');
    expect(stockOut?.count).toBe(1);
  });

  it('la valeur du stock est masquée sans inventory.valuation.read (BR-ANA-004)', async () => {
    // Le rôle réel du seed n'accorde pas ce droit (01-rbac.md §5.3, colonne MAG).
    const body = await home(storekeeperA);
    expect(body.sections[0]!.kpis.map((kpi) => kpi.code)).not.toContain('KPI-STK-02');
  });

  it('avec inventory.valuation.read, la valeur n’est que celle du site (10 × 500 XAF)', async () => {
    const body = await home(valuer);
    const value = body.sections[0]!.kpis.find((kpi) => kpi.code === 'KPI-STK-02');
    expect(value?.unit).toBe('XAF');
    // Le site B (4 × 500 XAF) n'est pas compté.
    expect(value?.value).toBe(5000);
  });

  it('plusieurs rôles : union des sections dans l’ordre du catalogue (UX-01)', async () => {
    const body = await home(multiRole);
    expect(body.user.roles).toHaveLength(2);
    expect(body.user.roles).toEqual(expect.arrayContaining(['MAGASINIER', 'VENDEUR_PDV']));
    expect(body.sections.map((section) => section.role)).toEqual(body.user.roles);
    // VENDEUR_PDV précède MAGASINIER dans le catalogue des rôles.
    expect(body.user.roles).toEqual(['VENDEUR_PDV', 'MAGASINIER']);
    // Chaque section est lue dans le périmètre de son affectation.
    for (const section of body.sections) expect(section.scopeLabel).toBe('Votre site');
  });

  it('une action sans écran est renvoyée sans route, « bientôt » (ADR-030 §8)', async () => {
    const body = await home(storekeeperA);
    const actions = body.sections[0]!.actions;
    expect(actions.length).toBeGreaterThan(0);
    // Le magasinier n'a, à ce stade, aucun écran métier : toutes ses actions sont « bientôt ».
    expect(actions.every((action) => action.route === null)).toBe(true);
    expect(actions.filter((action) => action.primary)).toHaveLength(1);
  });

  describe('responsable commercial : anomalies et validations de son seul périmètre', () => {
    let manager: string;
    const requestIds: string[] = [];
    let memberSummary = '';

    beforeAll(async () => {
      const respCommercial = await seededRole('RESP_COMMERCIAL');
      const at = new Date(THRESHOLD_AT);
      await db.transaction().execute(async (trx) => {
        manager = await insertTestUser(trx);
        const member = await insertTestUser(trx);
        const outsider = await insertTestUser(trx);
        const team = await insertTestTeam(trx, manager, admin);
        await insertTestTeamMembership(trx, team, member, admin, {
          validFrom: new Date('2026-01-01T00:00:00.000Z'),
        });
        await assignTestRole(trx, manager, respCommercial, admin, {
          scopeType: 'TEAM',
          scopeTeamId: team,
        });

        for (const [person, label] of [
          [member, 'membre'],
          [outsider, 'hors équipe'],
        ] as const) {
          // Anomalie produite par une commande de la personne (auteur lu dans l'inbox).
          const deviceId = await insertTestDevice(trx, person, { status: 'ACTIVE' });
          const commandId = freshUuid();
          await trx
            .insertInto('sync_command_inbox')
            .values({
              command_id: toBin(commandId),
              device_id: toBin(deviceId),
              user_id: toBin(person),
              device_seq: 1,
              transport: 'SYNC_PUSH',
              command_type: 'sales.sale.record',
              payload: jsonValue({}),
              payload_hash: '0'.repeat(64),
              occurred_at: at,
            })
            .execute();
          await recordConflict(trx, {
            id: freshUuid(),
            commandId,
            conflictType: 'PRICE_MISMATCH',
            entityType: 'SALE',
            entityId: freshUuid(),
            siteId: null,
            ownerRole: 'RESP_COMMERCIAL',
            applied: true,
            details: { label },
          });
          // Anomalie système sur le stock mobile dont la personne est titulaire.
          const mobileId = freshUuid();
          await trx
            .insertInto('organization_locations')
            .values({
              id: toBin(mobileId),
              site_id: toBin(siteA),
              code: mobileId.replace(/-/g, '').slice(-8).toUpperCase(),
              name: `Stock mobile (${label})`,
              location_type: 'MOBILE',
              custody_mode: 'EXCLUSIVE_USER',
              custodian_user_id: toBin(person),
              created_by: toBin(admin),
            })
            .execute();
          await recordConflict(trx, {
            id: freshUuid(),
            commandId: null,
            conflictType: 'DUPLICATE_CUSTOMER',
            entityType: 'LOCATION',
            entityId: mobileId,
            siteId: null,
            ownerRole: 'RESP_COMMERCIAL',
            applied: true,
            details: { locationId: mobileId },
          });
          // Demande d'annulation en attente, décidée par `sales.sale_cancel.approve` (TEAM pour le
          // responsable) ; politique retirée dès sa création : elle ne s'applique à rien d'autre.
          const policyId = freshUuid();
          await trx
            .insertInto('approvals_control_policies')
            .values({
              id: toBin(policyId),
              code: `P5_HOME_${policyId.slice(-12)}`,
              version: 1,
              operation_type: 'SALE_CANCELLATION',
              condition: jsonValue({}),
              requires_photo: 0,
              requires_comment: 0,
              requires_approval: 1,
              approver_permission: 'sales.sale_cancel.approve',
              approver_scope: 'TEAM',
              valid_from: new Date('2026-01-01T00:00:00.000Z'),
              valid_to: new Date('2026-01-01T00:00:00.000Z'),
              status: 'RETIRED',
              created_by: toBin(admin),
            })
            .execute();
          const requestId = freshUuid();
          const summary = `Annulation demandée par le ${label} (${requestId.slice(-6)})`;
          if (person === member) memberSummary = summary;
          await trx
            .insertInto('approvals_approval_requests')
            .values({
              id: toBin(requestId),
              operation_type: 'SALE_CANCELLATION',
              subject_type: 'SALE',
              subject_id: toBin(freshUuid()),
              subject_summary: summary,
              requested_by: toBin(person),
              requested_at: at,
              policy_id: toBin(policyId),
              policy_version: 1,
              created_by: toBin(person),
            })
            .execute();
          requestIds.push(requestId);
        }
      });
      tokens[manager] = await signAccessToken(
        app.get(JWT_KEYS).privateKey,
        { sub: manager, device_id: adminDevice, session_id: freshUuid() },
        clock.now(),
      );
    });

    afterAll(async () => {
      // Hygiène de la base partagée : aucune demande de ce test ne reste en attente.
      if (requestIds.length === 0) return;
      await db
        .updateTable('approvals_approval_requests')
        .set({ status: 'CANCELLED' })
        .where(
          'id',
          'in',
          requestIds.map((id) => toBin(id)),
        )
        .execute();
    });

    it('anomalies : celles dont l’auteur ou le titulaire du stock mobile est de l’équipe (règle de GET /sync/conflicts)', async () => {
      const body = await home(manager);
      expect(body.user.roles).toEqual(['RESP_COMMERCIAL']);
      const conflicts = body.signals.find((signal) => signal.code === 'SYNC_CONFLICTS');
      expect(conflicts?.count).toBe(2);
      expect(conflicts?.detail).toContain('price mismatch ×1');
      expect(conflicts?.detail).toContain('duplicate customer ×1');
    });

    it('validations : seulement celles que le responsable peut décider (portée de la permission d’approbation)', async () => {
      const body = await home(manager);
      const approvals = body.signals.find((signal) => signal.code === 'APPROVALS_PENDING');
      expect(approvals?.count).toBe(1);
      expect(approvals?.detail).toBe(`La plus ancienne : ${memberSummary}`);
    });
  });
});
