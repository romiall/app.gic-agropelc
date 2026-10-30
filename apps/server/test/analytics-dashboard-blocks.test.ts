/**
 * P9-25 — bornes des blocs de tableau de bord (constats TB-1, TB-5, TB-6, TB-9 et TB-12 de la revue adverse) :
 * - TB-1 : `portfolioHealth` et le bloc COMMERCIAL lisent des sites seuls par le site de rattachement, une étendue
 *   vide donne zéro (jamais tout le portefeuille), des personnes donnent le titulaire seul (AV-465) ;
 * - TB-5 : le seuil d'inactivité est le réglage `crm.inactive_after_days` (AV-013), à l'accueil comme au tableau ;
 * - TB-6 : une étendue tronquée au-delà de `analytics.scope_max_candidates` rend les blocs concernés indisponibles
 *   (`SCOPE_TRUNCATED`), pas un chiffre plus étroit que le droit ;
 * - TB-9 : `periodRevenue` et `periodProductQuantity` rendent des zéros pour un périmètre vide (`IN ()` invalide) ;
 * - TB-12 : un bloc dont la forme viole le contrat devient `BLOCK_INVALID`, il ne fait plus échouer tout le tableau ;
 * - AV-462 (P9-27) : KPI-COM-16 (bloc EQUIPES) et KPI-PRD-04, 05 et 09 (bloc PRODUCTION) rendent la valeur de leur
 *   fonction de référence, aux bonnes bornes et avec les bons droits (KPI-OPS-02 : `p5-distribution-metrics.test.ts`).
 *   Le monde de production est validé (commandes réelles, ferme neuve, faits du 09/10/2026) : lu sans transaction annulée.
 *
 * Les blocs sont appelés avec un `DashboardContext` construit à la main, dans une transaction annulée sur la base
 * partagée : identifiants neufs, assertions relatives au monde créé, aucun décalage d'horloge (instant fixe passé).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  FixedClock,
  Uuidv7Generator,
  businessDayOf,
  resolveAnalyticsPeriod,
  type IdGenerator,
} from '@gic/domain';
import { dashboardBlockSchema, type DashboardBlock } from '@gic/contracts';
import { PERMISSIONS, ROLE_PERMISSIONS } from '../../../db/seeds/rbac-data.js';
import { fromBin, toBin } from '../src/platform/kysely/uuid-columns.js';
import type { ReadScope } from '../src/platform/read-scope.js';
import type { UnitOfWork } from '../src/platform/unit-of-work.js';
import { buildHome } from '../src/home-api/home-service.js';
import { CommandPipelineService } from '../src/commands/command-pipeline.service.js';
import { CommandHandlerRegistry } from '../src/platform/sync/command-handler-registry.js';
import { DocumentSequenceService } from '../src/platform/document-sequences/document-sequence.service.js';
import { registerConsumptionCommands } from '../src/modules/inventory/application/commands/consumption-commands.js';
import { registerLotCommands } from '../src/modules/production/application/commands/lot-commands.js';
import { registerDailyCommands } from '../src/modules/production/application/commands/daily-commands.js';
import { buildDashboard } from '../src/analytics-api/dashboards/dashboard-builder.js';
import {
  commercialBlock,
  financeBlock,
  fitLabel,
  guarded,
  productionBlock,
  teamsBlock,
  type DashboardContext,
} from '../src/analytics-api/dashboards/dashboard-blocks.js';
import {
  DEFAULT_INACTIVE_AFTER_DAYS,
  INACTIVE_AFTER_DAYS_KEY,
  inactiveAfterDays,
  portfolioHealth,
} from '../src/modules/crm/application/public/index.js';
import {
  periodProductQuantity,
  periodRevenue,
  targetAttainment,
} from '../src/modules/sales/application/public/index.js';
import {
  ensureSupplierLot,
  recordStockMove,
  virtualLocationId,
} from '../src/modules/inventory/application/public/index.js';
import {
  costPerHead,
  feedConsumption,
  latestWeighing,
  referenceLotType,
} from '../src/modules/production/application/public/index.js';
import {
  assignTestRole,
  closeTestDb,
  db,
  freshPhone,
  freshUuid,
  grantTestPermission,
  insertTestDevice,
  insertTestLocation,
  insertTestRole,
  insertTestSite,
  insertTestUser,
  insertTestZone,
  withTestUow,
} from './helpers.js';

/** Instant fixe passé : aucune horloge décalée sur la base partagée. */
const AT = new Date('2026-10-09T18:00:00.000Z');
const DAY_MS = 86_400_000;
const daysBefore = (days: number): Date => new Date(AT.getTime() - days * DAY_MS);
const TODAY = businessDayOf(AT);
const PERIOD = resolveAnalyticsPeriod({ code: 'MONTH', today: TODAY });

const contextOf = (
  executor: DashboardContext['executor'],
  scope: ReadScope | null,
  overrides: Partial<DashboardContext> = {},
): DashboardContext => ({
  executor,
  userId: freshUuid(),
  at: AT,
  today: TODAY,
  period: PERIOD,
  scope,
  canReadValuation: true,
  pendingApprovalsCap: 500,
  ...overrides,
});

const kpiOf = (block: DashboardBlock, code: string) => block.kpis.find((kpi) => kpi.code === code);

/** Une version datée d'un réglage global, valable à `validFrom` (table en ajout seul : jamais deux versions au même instant). */
const setSetting = (
  trx: UnitOfWork,
  admin: string,
  key: string,
  value: unknown,
  validFrom: Date,
): Promise<unknown> =>
  trx
    .insertInto('organization_system_settings')
    .values({
      id: toBin(freshUuid()),
      key,
      value: JSON.stringify(value),
      scope_type: 'GLOBAL',
      valid_from: validFrom,
      created_by: toBin(admin),
    })
    .execute();

/**
 * Monde neuf : zone, sites S1 et S2, titulaires U et V, quatre comptes CUSTOMER (D11 §7.2, KPI-COM-13 et 14) :
 * a1 (U, S1, dernière vente il y a 5 j), a2 (U, S2, 90 j), a3 (V, S1, jamais vendu), a4 (U, sans site, 45 j).
 */
async function portfolioWorld(trx: UnitOfWork) {
  const admin = await insertTestUser(trx);
  const owner = await insertTestUser(trx);
  const other = await insertTestUser(trx);
  const zone = await insertTestZone(trx, admin);
  const site1 = await insertTestSite(trx, admin, zone);
  const site2 = await insertTestSite(trx, admin, zone);
  const sourceCode = `SRC_${freshUuid().slice(-8)}`;
  await trx
    .insertInto('crm_lead_sources')
    .values({
      id: toBin(freshUuid()),
      code: sourceCode,
      label: 'Source de test',
      created_by: toBin(admin),
    })
    .execute();
  const account = async (input: {
    readonly ownerId: string;
    readonly siteId: string | null;
    readonly lastSaleAt: Date | null;
  }): Promise<void> => {
    await trx
      .insertInto('crm_customers')
      .values({
        id: toBin(freshUuid()),
        stage: 'CUSTOMER',
        display_name: 'Client de test',
        phone_primary: await freshPhone({ executor: trx }),
        zone_id: toBin(zone),
        source_code: sourceCode,
        acquired_by_user_id: toBin(admin),
        acquired_at: daysBefore(200),
        occurred_at: daysBefore(200),
        owner_user_id: toBin(input.ownerId),
        home_site_id: input.siteId === null ? null : toBin(input.siteId),
        // Première vente : colonne sans clé étrangère (INV-CRM-04 exige seulement qu'elle soit renseignée).
        first_sale_id: toBin(freshUuid()),
        last_sale_at: input.lastSaleAt,
        created_by: toBin(admin),
      })
      .execute();
  };
  await account({ ownerId: owner, siteId: site1, lastSaleAt: daysBefore(5) });
  await account({ ownerId: owner, siteId: site2, lastSaleAt: daysBefore(90) });
  await account({ ownerId: other, siteId: site1, lastSaleAt: null });
  await account({ ownerId: owner, siteId: null, lastSaleAt: daysBefore(45) });
  return { admin, owner, other, zone, site1, site2, account };
}

describe('P9-25 : bornes des blocs de tableau de bord', { timeout: 120_000 }, () => {
  afterAll(closeTestDb);

  describe('TB-1 : portefeuille clients (portfolioHealth, bloc COMMERCIAL)', () => {
    it('portfolioHealth : titulaires, sites de rattachement, les deux en ET, listes vides = zéros', async () => {
      await withTestUow(async (trx) => {
        const w = await portfolioWorld(trx);
        const health = (filter: { ownerUserIds?: string[]; siteIds?: string[] }) =>
          portfolioHealth(trx, { ...filter, at: AT, inactiveDays: 30 });
        const owned = await health({ ownerUserIds: [w.owner] });
        expect([owned.customers, owned.inactiveCustomers]).toEqual([3, 2]);
        const atSite1 = await health({ siteIds: [w.site1] });
        expect([atSite1.customers, atSite1.inactiveCustomers]).toEqual([2, 1]);
        const both = await health({ ownerUserIds: [w.owner], siteIds: [w.site1] });
        expect([both.customers, both.inactiveCustomers]).toEqual([1, 0]);
        // Un tableau vide ne lit rien : zéros sans erreur, jamais tout le portefeuille de la base.
        for (const empty of [{ siteIds: [] }, { ownerUserIds: [w.owner], siteIds: [] }]) {
          expect(await health(empty)).toEqual({ customers: 0, inactiveCustomers: 0, prospects: 0 });
        }
        expect(await health({ ownerUserIds: [] })).toEqual({
          customers: 0,
          inactiveCustomers: 0,
          prospects: 0,
        });
      });
    });

    it('commercialBlock : sites seuls par le site de rattachement, vide = zéro, personnes = titulaire seul (AV-465)', async () => {
      await withTestUow(async (trx) => {
        const w = await portfolioWorld(trx);
        const counts = async (scope: ReadScope): Promise<[number | null, number | null]> => {
          const block = await commercialBlock(contextOf(trx, scope, { userId: w.owner }));
          expect(block.unavailable).toBeNull();
          return [kpiOf(block, 'KPI-COM-13')!.value, kpiOf(block, 'KPI-COM-14')!.value];
        };
        // [actifs, inactifs]
        expect(await counts({ siteIds: [w.site1] })).toEqual([1, 1]);
        // Avant le correctif : le portefeuille entier de la base (au moins 4 comptes).
        expect(await counts({ siteIds: [] })).toEqual([0, 0]);
        expect(await counts({ userIds: [w.owner] })).toEqual([1, 2]);
        // Défaut (a) d'AV-465 : avec des personnes, la borne de site n'est pas appliquée aux comptes d'un titulaire.
        expect(await counts({ siteIds: [w.site1], userIds: [w.owner] })).toEqual([1, 2]);
        // Zone sans site actif (commercial terrain) : { siteIds: [], userIds: [soi] } lit les comptes du titulaire.
        expect(await counts({ siteIds: [], userIds: [w.owner] })).toEqual([1, 2]);
      });
    });

    it('commercial terrain (OWN + affectation de zone) : la vraie traduction compte les comptes du titulaire', async () => {
      for (const withSites of [false, true]) {
        await withTestUow(async (trx) => {
          const admin = await insertTestUser(trx);
          const zone = await insertTestZone(trx, admin);
          if (withSites) {
            await insertTestSite(trx, admin, zone);
            await insertTestSite(trx, admin, zone);
          }
          const role = await trx
            .selectFrom('identity_roles')
            .select('id')
            .where('code', '=', 'COMMERCIAL_TERRAIN')
            .executeTakeFirstOrThrow();
          const seller = await insertTestUser(trx);
          await assignTestRole(trx, seller, fromBin(role.id), admin, {
            scopeType: 'ZONE',
            scopeZoneId: zone,
          });
          const sourceCode = `SRC_${freshUuid().slice(-8)}`;
          await trx
            .insertInto('crm_lead_sources')
            .values({
              id: toBin(freshUuid()),
              code: sourceCode,
              label: 'Source de test',
              created_by: toBin(admin),
            })
            .execute();
          for (const lastSaleAt of [daysBefore(3), daysBefore(80)]) {
            await trx
              .insertInto('crm_customers')
              .values({
                id: toBin(freshUuid()),
                stage: 'CUSTOMER',
                display_name: 'Client de test',
                phone_primary: await freshPhone({ executor: trx }),
                zone_id: toBin(zone),
                source_code: sourceCode,
                acquired_by_user_id: toBin(seller),
                acquired_at: daysBefore(200),
                occurred_at: daysBefore(200),
                owner_user_id: toBin(seller),
                first_sale_id: toBin(freshUuid()),
                last_sale_at: lastSaleAt,
                created_by: toBin(admin),
              })
              .execute();
          }
          const dashboard = await buildDashboard(trx, {
            userId: seller,
            at: AT,
            code: 'commercial',
            period: PERIOD,
          });
          const block = dashboard!.blocks.find((entry) => entry.code === 'COMMERCIAL')!;
          expect(block.unavailable).toBeNull();
          expect(kpiOf(block, 'KPI-COM-13')?.value).toBe(1);
          expect(kpiOf(block, 'KPI-COM-14')?.value).toBe(1);
        });
      }
    });
  });

  describe('TB-5 : seuil d’inactivité = réglage crm.inactive_after_days (AV-013)', () => {
    it('inactiveAfterDays : 30 sans version, la version en vigueur, 30 pour toute valeur invalide', async () => {
      await withTestUow(async (trx) => {
        const admin = await insertTestUser(trx);
        // Sans version insérée ici : la valeur semée ou le repli (30).
        expect(await inactiveAfterDays(trx, AT)).toBe(DEFAULT_INACTIVE_AFTER_DAYS);
        // Versions à valid_from strictement croissants : la plus récente ≤ at l'emporte, jamais d'ex æquo.
        const versions: [unknown, number][] = [
          [60, 60],
          ['abc', 30],
          [0, 30],
          [-5, 30],
          [7.5, 30],
          [null, 30],
          [45, 45],
        ];
        let seconds = 30;
        for (const [value, expected] of versions) {
          await setSetting(
            trx,
            admin,
            INACTIVE_AFTER_DAYS_KEY,
            value,
            new Date(AT.getTime() - seconds * 1000),
          );
          seconds -= 1;
          expect(await inactiveAfterDays(trx, AT), `valeur ${JSON.stringify(value)}`).toBe(
            expected,
          );
        }
      });
    });

    it('commercialBlock : le réglage à 60 jours change les clients inactifs (30 par défaut)', async () => {
      await withTestUow(async (trx) => {
        const w = await portfolioWorld(trx);
        const counts = async (): Promise<[number | null, number | null]> => {
          const block = await commercialBlock(contextOf(trx, { userIds: [w.owner] }));
          return [kpiOf(block, 'KPI-COM-13')!.value, kpiOf(block, 'KPI-COM-14')!.value];
        };
        expect(await counts()).toEqual([1, 2]);
        await setSetting(trx, w.admin, INACTIVE_AFTER_DAYS_KEY, 60, new Date(AT.getTime() - 1000));
        // a1 (5 j) et a4 (45 j) actifs, a2 (90 j) inactif.
        expect(await counts()).toEqual([2, 1]);
      });
    });

    it('accueil : les libellés du portefeuille portent le seuil lu (30 sans version, 60 avec)', async () => {
      await withTestUow(async (trx) => {
        const admin = await insertTestUser(trx);
        const role = await trx
          .selectFrom('identity_roles')
          .select('id')
          .where('code', '=', 'COMMERCIAL_SEDENTAIRE')
          .executeTakeFirstOrThrow();
        const seller = await insertTestUser(trx);
        await assignTestRole(trx, seller, fromBin(role.id), admin);
        const detail = async (): Promise<string | undefined> => {
          const home = await buildHome({
            executor: trx,
            userId: seller,
            clock: new FixedClock(AT),
          });
          return (
            home.sections
              .find((section) => section.role === 'COMMERCIAL_SEDENTAIRE')
              ?.kpis.find((entry) => entry.code === 'KPI-COM-14')?.detail ?? undefined
          );
        };
        expect(await detail()).toContain('inactif après 30 jours');
        await setSetting(trx, admin, INACTIVE_AFTER_DAYS_KEY, 60, new Date(AT.getTime() - 1000));
        expect(await detail()).toContain('inactif après 60 jours');
      });
    });
  });

  describe('TB-6 : étendue tronquée = bloc indisponible (SCOPE_TRUNCATED)', () => {
    it('buildDashboard : au-delà de analytics.scope_max_candidates, le bloc STOCK n’affiche plus un sous-ensemble', async () => {
      await withTestUow(async (trx) => {
        const admin = await insertTestUser(trx);
        const zone = await insertTestZone(trx, admin);
        const site1 = await insertTestSite(trx, admin, zone);
        const site2 = await insertTestSite(trx, admin, zone);
        const role = await insertTestRole(trx, admin, { allowedScopeTypes: ['SITE'] });
        await grantTestPermission(trx, role, 'analytics.dashboard.stock', admin, {
          maxScope: 'SITE',
        });
        const user = await insertTestUser(trx);
        for (const siteId of [site1, site2]) {
          await assignTestRole(trx, user, role, admin, { scopeType: 'SITE', scopeSiteId: siteId });
        }
        const build = async () => {
          const dashboard = await buildDashboard(trx, {
            userId: user,
            at: AT,
            code: 'stock',
            period: PERIOD,
          });
          expect(dashboard).not.toBeNull();
          return (code: string) => dashboard!.blocks.find((entry) => entry.code === code)!;
        };
        // Sans réglage : deux sites, sous le plafond, le bloc est rendu.
        const before = await build();
        expect(before('STOCK').unavailable).toBeNull();
        // Plafond à 1 : deux candidats, le second est écarté : l'étendue est tronquée.
        await setSetting(
          trx,
          admin,
          'analytics.scope_max_candidates',
          1,
          new Date(AT.getTime() - 1000),
        );
        const after = await build();
        expect(after('STOCK').kpis).toEqual([]);
        expect(after('STOCK').unavailable).toEqual({ reason: 'ERROR', code: 'SCOPE_TRUNCATED' });
        expect(after('ALERTES').unavailable).toBeNull();
        expect(after('DISTRIBUTION').unavailable).toEqual({
          reason: 'FORBIDDEN',
          code: 'DISTRIBUTION_FORBIDDEN',
        });
      });
    });

    it('niveau bloc : scope nul = SCOPE_UNSUPPORTED par défaut, SCOPE_TRUNCATED si la cause est portée', async () => {
      const unsupported = await guarded('COMMERCIAL', 'Portefeuille clients', () =>
        commercialBlock(contextOf(db, null)),
      );
      expect(unsupported.unavailable).toEqual({ reason: 'ERROR', code: 'SCOPE_UNSUPPORTED' });
      const truncated = await guarded('COMMERCIAL', 'Portefeuille clients', () =>
        commercialBlock(contextOf(db, null, { scopeIssue: 'SCOPE_TRUNCATED' })),
      );
      expect(truncated.unavailable).toEqual({ reason: 'ERROR', code: 'SCOPE_TRUNCATED' });
      expect(truncated.kpis).toEqual([]);
    });
  });

  describe('TB-9 : périmètre vide = zéros, jamais IN ()', () => {
    const ZEROS = {
      grossRevenueXaf: 0,
      cancelledXaf: 0,
      netRevenueXaf: 0,
      costOfSalesXaf: 0,
      grossMarginXaf: 0,
      saleCount: 0,
    };

    it('periodRevenue et periodProductQuantity : listes de sites ou de clients vides', async () => {
      await withTestUow(async (trx) => {
        const window = { fromUtc: PERIOD.startUtc, toUtc: PERIOD.endUtc };
        expect(await periodRevenue(trx, { ...window, siteIds: [] })).toEqual(ZEROS);
        expect(await periodRevenue(trx, { ...window, customerIds: [] })).toEqual(ZEROS);
        expect(
          await periodProductQuantity(trx, { ...window, siteIds: [], productId: freshUuid() }),
        ).toBe(0);
      });
    });

    it('financeBlock (appel direct, sans guarded) : une étendue sans site rend des zéros, sans erreur', async () => {
      await withTestUow(async (trx) => {
        const block = await financeBlock(contextOf(trx, { siteIds: [] }));
        expect(block.unavailable).toBeNull();
        expect(kpiOf(block, 'KPI-FIN-01')?.value).toBe(0);
        expect(kpiOf(block, 'KPI-FIN-02')?.value).toBe(0);
        expect(kpiOf(block, 'KPI-FIN-07')?.value).toBe(0);
        expect(kpiOf(block, 'KPI-FIN-07')?.variationPct ?? null).toBeNull();
        // Les dépenses ne se lisent que sur toute l'entreprise.
        expect(kpiOf(block, 'KPI-FIN-04')?.value).toBeNull();
      });
    });
  });

  describe('TB-12 : un bloc invalide ne casse pas le tableau', () => {
    const validKpi = {
      code: 'KPI-STK-02',
      label: 'Valeur du stock',
      unit: 'xaf' as const,
      value: 1,
    };
    const BLOCK_INVALID = { reason: 'ERROR', code: 'BLOCK_INVALID' };
    const blockWith = (patch: Partial<DashboardBlock>): DashboardBlock => ({
      code: 'STOCK',
      title: 'Stock',
      kpis: [],
      details: [],
      unavailable: null,
      ...patch,
    });

    it('guarded : un bloc valide est rendu tel quel (même objet)', async () => {
      const valid = blockWith({ kpis: [validKpi] });
      expect(await guarded('STOCK', 'Stock', async () => valid)).toBe(valid);
    });

    it('guarded : une valeur non finie ou un libellé trop long rend BLOCK_INVALID, vide', async () => {
      const nan = blockWith({ kpis: [{ ...validKpi, value: Number.NaN }] });
      const long = blockWith({
        details: [{ label: 'x'.repeat(201), value: 1, unit: 'ratio' as const }],
      });
      for (const built of [nan, long]) {
        expect(await guarded('STOCK', 'Stock', async () => built)).toEqual({
          code: 'STOCK',
          title: 'Stock',
          kpis: [],
          details: [],
          unavailable: BLOCK_INVALID,
        });
      }
    });

    it('guarded : une exception reste BLOCK_FAILED, une indisponibilité déclarée n’est pas touchée', async () => {
      const failed = await guarded('STOCK', 'Stock', async () => {
        throw new Error('échec technique');
      });
      expect(failed.unavailable).toEqual({ reason: 'ERROR', code: 'BLOCK_FAILED' });
      // BlockUnavailable n'est pas exportée : on la provoque par un scope nul.
      const declared = await guarded('COMMERCIAL', 'Portefeuille clients', () =>
        commercialBlock(contextOf(db, null)),
      );
      expect(declared.unavailable).toEqual({ reason: 'ERROR', code: 'SCOPE_UNSUPPORTED' });
    });

    it('fitLabel : inchangé jusqu’à la borne, coupé à 200 caractères avec « … » au-delà, et conforme au contrat', () => {
      const exact = 'y'.repeat(200);
      expect(fitLabel(exact, 200)).toBe(exact);
      const cut = fitLabel('z'.repeat(260), 200);
      expect(cut).toHaveLength(200);
      expect(cut.endsWith('…')).toBe(true);
      const label = fitLabel(`Couverture (jours) — ${'n'.repeat(200)}`, 200);
      const block = blockWith({ details: [{ label, value: 3, unit: 'ratio' as const }] });
      expect(dashboardBlockSchema.safeParse(block).success).toBe(true);
    });
  });

  describe('TB-11 : valeurs au coût = droit de valorisation détenu sans borne (portée ALL)', () => {
    const PROTECTED_STOCK_CODES = ['KPI-STK-02', 'KPI-FIN-08', 'KPI-STK-04'] as const;
    const stockKpis = async (trx: UnitOfWork, userId: string) => {
      const dashboard = await buildDashboard(trx, {
        userId,
        at: AT,
        code: 'stock',
        period: PERIOD,
      });
      expect(dashboard).not.toBeNull();
      const block = dashboard!.blocks.find((entry) => entry.code === 'STOCK')!;
      expect(block.unavailable).toBeNull();
      return block;
    };

    it('droit de valorisation en ALL : la valeur du stock est affichée', async () => {
      await withTestUow(async (trx) => {
        const admin = await insertTestUser(trx);
        const role = await insertTestRole(trx, admin);
        await grantTestPermission(trx, role, 'analytics.dashboard.stock', admin);
        await grantTestPermission(trx, role, 'inventory.valuation.read', admin);
        const user = await insertTestUser(trx);
        await assignTestRole(trx, user, role, admin);
        const block = await stockKpis(trx, user);
        expect(kpiOf(block, 'KPI-STK-02')?.value).not.toBeNull();
      });
    });

    it('droit de valorisation borné au site (octroi hors catalogue) : valeurs au coût masquées, sans lien ni période précédente', async () => {
      await withTestUow(async (trx) => {
        const admin = await insertTestUser(trx);
        const zone = await insertTestZone(trx, admin);
        const site = await insertTestSite(trx, admin, zone);
        const role = await insertTestRole(trx, admin, { allowedScopeTypes: ['GLOBAL', 'SITE'] });
        await grantTestPermission(trx, role, 'analytics.dashboard.stock', admin);
        // Octroi que le produit ne crée pas (le DDL ne contrôle pas max_scope ∈ supported_scopes) : il simule un
        // futur droit borné, que le tableau doit masquer au lieu de l'élargir à tous les sites.
        await grantTestPermission(trx, role, 'inventory.valuation.read', admin, {
          maxScope: 'SITE',
        });
        const user = await insertTestUser(trx);
        await assignTestRole(trx, user, role, admin, { scopeType: 'SITE', scopeSiteId: site });
        const block = await stockKpis(trx, user);
        let seen = 0;
        for (const code of PROTECTED_STOCK_CODES) {
          const found = kpiOf(block, code);
          if (found === undefined) continue;
          seen += 1;
          expect(found.value, code).toBeNull();
          expect(found.explore ?? null, code).toBeNull();
          expect(found.previousValue ?? null, code).toBeNull();
        }
        expect(seen).toBe(PROTECTED_STOCK_CODES.length);
      });
    });

    it('garde du catalogue : inventory.valuation.read n’est déclaré et accordé qu’en ALL (sinon revoir canReadValuationOnAll)', () => {
      const permission = PERMISSIONS.find((entry) => entry.code === 'inventory.valuation.read');
      expect(permission?.supportedScopes).toEqual(['ALL']);
      const grantsOfPermission = ROLE_PERMISSIONS.filter(
        (grant) => grant.permissionCode === 'inventory.valuation.read',
      );
      expect(grantsOfPermission.length).toBeGreaterThan(0);
      for (const grant of grantsOfPermission) expect(grant.maxScope, grant.roleCode).toBe('ALL');
    });
  });

  describe('AV-462 (P9-27) : cinq indicateurs dans les blocs', () => {
    /** Atteinte en pourcentage telle que le bloc l'arrondit (`round1(ratio × 100)`). */
    const pctOf = (ratio: number): number => Math.round(ratio * 100 * 10) / 10;

    describe('KPI-COM-16 : teamsBlock (atteinte d’objectif)', () => {
      /**
       * Monde neuf annulé : lecteur R (crm.target.read), commerciaux U et V, un site S. Objectifs `USER` actifs au
       * jour de lecture (09/10) : U chiffre d'affaires 1 000 000, prospects créés 4, visites 10 mais dès le 20/10
       * (pas encore actif) ; V prospects créés 10 et chiffre d'affaires 500 000. U a créé deux comptes les 06 et 07/10.
       */
      async function targetWorld(trx: UnitOfWork) {
        const admin = await insertTestUser(trx);
        const zone = await insertTestZone(trx, admin);
        const site = await insertTestSite(trx, admin, zone);
        const u = await insertTestUser(trx);
        const v = await insertTestUser(trx);
        const reader = await insertTestUser(trx);
        const outsider = await insertTestUser(trx);
        const role = await insertTestRole(trx, admin);
        await grantTestPermission(trx, role, 'crm.target.read', admin);
        await assignTestRole(trx, reader, role, admin);
        const target = async (
          userId: string,
          metric: string,
          value: number,
          start = '2026-10-01',
          end = '2026-10-31',
        ): Promise<void> => {
          await trx
            .insertInto('crm_sales_targets')
            .values({
              id: toBin(freshUuid()),
              target_type: 'USER',
              user_id: toBin(userId),
              metric,
              period_start: new Date(`${start}T00:00:00.000Z`),
              period_end: new Date(`${end}T00:00:00.000Z`),
              target_value: value,
              status: 'ACTIVE',
              created_by: toBin(admin),
            })
            .execute();
        };
        await target(u, 'CA', 1_000_000);
        await target(u, 'PROSPECTS_CREES', 4);
        await target(u, 'VISITES', 10, '2026-10-20', '2026-10-31');
        await target(v, 'PROSPECTS_CREES', 10);
        await target(v, 'CA', 500_000);
        const sourceCode = `SRC_${freshUuid().slice(-8)}`;
        await trx
          .insertInto('crm_lead_sources')
          .values({
            id: toBin(freshUuid()),
            code: sourceCode,
            label: 'Source de test',
            created_by: toBin(admin),
          })
          .execute();
        for (const days of [3, 2]) {
          await trx
            .insertInto('crm_customers')
            .values({
              id: toBin(freshUuid()),
              stage: 'CUSTOMER',
              display_name: 'Client de test',
              phone_primary: await freshPhone({ executor: trx }),
              zone_id: toBin(zone),
              source_code: sourceCode,
              acquired_by_user_id: toBin(u),
              acquired_at: daysBefore(days),
              occurred_at: daysBefore(days),
              owner_user_id: toBin(u),
              first_sale_id: toBin(freshUuid()),
              last_sale_at: null,
              created_by: toBin(admin),
            })
            .execute();
        }
        return { site, u, v, reader, outsider };
      }

      const attainmentLabel = 'Atteinte d’objectif';
      const attainmentDetails = (block: DashboardBlock) =>
        block.details.filter((detail) => detail.label.startsWith(attainmentLabel));

      it('la valeur du bloc égale celle de targetAttainment (groupe CA), sans période précédente ni carte par métrique', async () => {
        await withTestUow(async (trx) => {
          const w = await targetWorld(trx);
          const scope: ReadScope = { userIds: [w.u] };
          const block = await teamsBlock(contextOf(trx, scope, { userId: w.reader }));
          expect(block.unavailable).toBeNull();
          const attainment = await targetAttainment(trx, scope, { day: TODAY });
          const revenue = attainment.groups.find((group) => group.metric === 'CA')!;
          expect(revenue.attainment).not.toBeNull();
          const card = kpiOf(block, 'KPI-COM-16')!;
          expect(card.value).toBe(pctOf(revenue.attainment!));
          expect(card.unit).toBe('pct');
          // Un ratio n'a ni période précédente ni variation ni lien d'exploration.
          expect(card.previousValue).toBeUndefined();
          expect(card.variationPct).toBeUndefined();
          expect(card.explore ?? null).toBeNull();
          // Les autres métriques sont des lignes de détail en pourcentage, jamais des cartes.
          expect(block.kpis.filter((kpi) => kpi.label.startsWith(attainmentLabel))).toHaveLength(1);
          expect(attainmentDetails(block)).toEqual([
            { label: `${attainmentLabel} — prospects créés`, value: 50, unit: 'pct' },
          ]);
          expect(dashboardBlockSchema.safeParse(block).success).toBe(true);
        });
      });

      it('sans crm.target.read : l’indicateur et ses lignes sont absents (jamais 0)', async () => {
        await withTestUow(async (trx) => {
          const w = await targetWorld(trx);
          const block = await teamsBlock(
            contextOf(trx, { userIds: [w.u] }, { userId: w.outsider }),
          );
          expect(block.unavailable).toBeNull();
          expect(kpiOf(block, 'KPI-COM-16')).toBeUndefined();
          expect(attainmentDetails(block)).toEqual([]);
        });
      });

      it('étendue de sites seuls : non résolue, l’indicateur est absent', async () => {
        await withTestUow(async (trx) => {
          const w = await targetWorld(trx);
          const block = await teamsBlock(
            contextOf(trx, { siteIds: [w.site] }, { userId: w.reader }),
          );
          expect(kpiOf(block, 'KPI-COM-16')).toBeUndefined();
          expect(attainmentDetails(block)).toEqual([]);
        });
      });

      it('des personnes : seuls leurs objectifs sont lus (ceux de V changent le résultat dès qu’elle est dans l’étendue)', async () => {
        await withTestUow(async (trx) => {
          const w = await targetWorld(trx);
          const detailOf = async (userIds: string[]) =>
            attainmentDetails(
              await teamsBlock(contextOf(trx, { userIds }, { userId: w.reader })),
            )[0]?.value;
          // U seule : 2 comptes créés sur 4 visés ; U et V : 2 sur 14.
          expect(await detailOf([w.u])).toBe(50);
          expect(await detailOf([w.u, w.v])).toBe(pctOf(2 / 14));
          // V seule : aucun compte créé sur 10 visés.
          expect(await detailOf([w.v])).toBe(0);
        });
      });

      it('étendue vide : pas d’erreur, valeur nulle ; le jour de lecture est plafonné à aujourd’hui (objectif futur ignoré)', async () => {
        await withTestUow(async (trx) => {
          const w = await targetWorld(trx);
          const empty = await teamsBlock(contextOf(trx, { siteIds: [] }, { userId: w.reader }));
          expect(empty.unavailable).toBeNull();
          expect(kpiOf(empty, 'KPI-COM-16')?.value ?? null).toBeNull();
          expect(attainmentDetails(empty)).toEqual([]);
          // Période MONTH en cours : le jour de lecture est le 09/10, pas le 31/10 ; l'objectif de visites de U ne
          // commence que le 20/10 et n'apparaît donc pas.
          const block = await teamsBlock(contextOf(trx, { userIds: [w.u] }, { userId: w.reader }));
          expect(attainmentDetails(block).map((detail) => detail.label)).not.toContain(
            `${attainmentLabel} — visites`,
          );
          // Lu un autre jour, le même objectif apparaît (preuve que c'est bien la borne du jour qui l'écarte).
          const later = await targetAttainment(trx, { userIds: [w.u] }, { day: '2026-10-25' });
          expect(later.groups.map((group) => group.metric)).toContain('VISITES');
        });
      });
    });

    describe('KPI-PRD-04, 05 et 09 : productionBlock', () => {
      const FEED_DAY = '2026-10-09';
      const feedAt = (hhmmss: string) => `${FEED_DAY}T${hhmmss}.000Z`;
      const win = (period: { readonly startUtc: Date; readonly endUtc: Date }) => ({
        fromUtc: period.startUtc,
        toUtc: period.endUtc,
      });
      let seq = 0;
      let siteA: string;
      let pipeline: CommandPipelineService;
      let manager: { userId: string; deviceId: string };
      let farm: { userId: string; deviceId: string };
      const scopeA = (): ReadScope => ({ siteIds: [siteA] });

      type Result = Awaited<ReturnType<CommandPipelineService['handle']>>;
      async function run(
        actor: { userId: string; deviceId: string },
        commandType: string,
        aggregateType: string,
        aggregateId: string,
        occurredAt: string,
        payload: unknown,
      ): Promise<void> {
        const outcome: Result = await pipeline.handle(
          {
            command_id: freshUuid(),
            device_seq: ++seq,
            command_version: 1,
            command_type: commandType,
            aggregate_type: aggregateType,
            aggregate_id: aggregateId,
            author_user_id: actor.userId,
            base_version: null,
            depends_on: [],
            occurred_at: occurredAt,
            client_created_at: occurredAt,
            captured_offline: false,
            backdated_reason: null,
            attachment_ids: [],
            payload,
          },
          {
            authenticatedUserId: actor.userId,
            authenticatedDeviceId: actor.deviceId,
            transport: 'ONLINE_API',
          },
        );
        expect(outcome.status, JSON.stringify(outcome)).toBe('APPLIED');
      }

      beforeAll(async () => {
        const clock = new FixedClock(AT);
        const idGenerator: IdGenerator = new Uuidv7Generator(clock);
        const registry = new CommandHandlerRegistry();
        const sequences = new DocumentSequenceService();
        registerLotCommands(registry, idGenerator, sequences);
        registerDailyCommands(registry, idGenerator, sequences);
        registerConsumptionCommands(registry, idGenerator);
        pipeline = new CommandPipelineService(db, registry, clock, idGenerator);
        const roleId = async (code: string): Promise<string> => {
          const row = await db
            .selectFrom('identity_roles')
            .select('id')
            .where('code', '=', code)
            .executeTakeFirstOrThrow();
          return fromBin(row.id);
        };
        const roles = { rfe: await roleId('RESP_FERME'), rpr: await roleId('RESP_PRODUCTION') };

        // Monde validé et neuf : une ferme, des produits neufs, du stock d'ouverture (documents complets).
        let buildingId = '';
        let storeId = '';
        let chickId = '';
        let pigletId = '';
        let broilerId = '';
        let hogId = '';
        let feedId = '';
        let chickLotId = '';
        let pigletLotId = '';
        await db.transaction().execute(async (trx) => {
          const admin = await insertTestUser(trx);
          const zone = await insertTestZone(trx, admin);
          siteA = await insertTestSite(trx, admin, zone, { siteType: 'FERME' });
          buildingId = await insertTestLocation(trx, admin, siteA, { locationType: 'BUILDING' });
          storeId = await insertTestLocation(trx, admin, siteA);
          const actor = async (
            role: string,
            options: Parameters<typeof assignTestRole>[4] = {},
          ) => {
            const userId = await insertTestUser(trx);
            const deviceId = await insertTestDevice(trx, userId, { status: 'ACTIVE' });
            await assignTestRole(trx, userId, role, admin, options);
            return { userId, deviceId };
          };
          manager = await actor(roles.rpr);
          farm = await actor(roles.rfe, { scopeType: 'SITE', scopeSiteId: siteA });
          for (const [unit, name, isCount] of [
            ['TETE', 'Tête', 1],
            ['KG', 'Kilogramme', 0],
          ] as const) {
            if (
              !(await trx
                .selectFrom('catalog_units')
                .select('code')
                .where('code', '=', unit)
                .executeTakeFirst())
            ) {
              await trx
                .insertInto('catalog_units')
                .values({ code: unit, name, is_count: isCount })
                .execute();
            }
          }
          const categoryId = freshUuid();
          await trx
            .insertInto('catalog_product_categories')
            .values({
              id: toBin(categoryId),
              code: `CAT-${categoryId.slice(-8)}`,
              name: 'Élevage',
              created_by: toBin(admin),
            })
            .execute();
          chickId = freshUuid();
          pigletId = freshUuid();
          broilerId = freshUuid();
          hogId = freshUuid();
          feedId = freshUuid();
          const base = { category_id: toBin(categoryId), created_by: toBin(admin) };
          const animal = (id: string, name: string, species: 'POULET_CHAIR' | 'PORC') => ({
            ...base,
            id: toBin(id),
            code: `PRD-${id.slice(-8)}`,
            name,
            stock_family: 'BIOLOGIQUE',
            species,
            base_unit_code: 'TETE',
            lot_tracking: 'REQUIRED',
          });
          await trx
            .insertInto('catalog_products')
            .values([
              animal(chickId, 'Poussin d’un jour (chair)', 'POULET_CHAIR'),
              animal(broilerId, 'Poulet de chair vif', 'POULET_CHAIR'),
              animal(pigletId, 'Porcelet sevré', 'PORC'),
              animal(hogId, 'Porc charcutier vif', 'PORC'),
              {
                ...base,
                id: toBin(feedId),
                code: `PRD-${feedId.slice(-8)}`,
                name: 'Aliment croissance',
                stock_family: 'INTRANT',
                base_unit_code: 'KG',
                lot_tracking: 'NONE',
                is_consumable: 1,
              },
            ])
            .execute();
          const supplierId = freshUuid();
          await trx
            .insertInto('procurement_suppliers')
            .values({
              id: toBin(supplierId),
              code: `F-${supplierId.slice(-10)}`,
              name: 'Couvoir',
              supplied_categories: JSON.stringify([]),
              status: 'ACTIVE',
              created_by: toBin(admin),
            })
            .execute();
          const supplierLot = (productId: string, ref: string) =>
            ensureSupplierLot(
              trx,
              { idGenerator },
              {
                productId,
                supplierId,
                supplierLotRef: `${ref}-${supplierId.slice(-6)}`,
                fallbackCode: `F:${ref}-${supplierId.slice(-6)}`,
                expiryDate: null,
                originId: freshUuid(),
                fifoRankAt: new Date(feedAt('05:00:00')),
                createdBy: admin,
              },
            );
          chickLotId = await supplierLot(chickId, 'PC');
          pigletLotId = await supplierLot(pigletId, 'PP');
          const opening = await virtualLocationId(trx, 'V_OPENING');
          for (const [productId, lot, quantity, cost] of [
            [chickId, chickLotId, 1000, 500],
            [pigletId, pigletLotId, 100, 2000],
            [feedId, undefined, 1000, 300],
          ] as const) {
            await recordStockMove(
              trx,
              { idGenerator },
              {
                productId,
                ...(lot !== undefined ? { lotId: lot } : {}),
                quantityBase: quantity,
                fromLocationId: opening,
                toLocationId: storeId,
                moveType: 'OPENING_BALANCE',
                declaredUnitCostXaf: cost,
                occurredAt: new Date(feedAt('05:00:00')),
                sourceDocType: 'INVENTORY_COUNT',
                sourceDocId: freshUuid(),
                createdBy: admin,
                allowNegative: false,
              },
            );
          }
        });

        const place = async (
          lotType: string,
          productId: string,
          source: { productId: string; stockLotId: string },
          quantity: number,
        ): Promise<string> => {
          const id = freshUuid();
          await run(manager, 'production.lot.create', 'PRODUCTION_LOT', id, feedAt('06:00:00'), {
            lotType,
            productId,
            mainLocationId: buildingId,
          });
          await run(
            farm,
            'production.lot.record_entry',
            'LOT_ENTRY',
            freshUuid(),
            feedAt('06:00:00'),
            {
              productionLotId: id,
              sourceKind: 'INTERNAL_STOCK',
              sourceProductId: source.productId,
              sourceLocationId: storeId,
              sourceStockLotId: source.stockLotId,
              quantity,
            },
          );
          return id;
        };
        const chicks = { productId: chickId, stockLotId: chickLotId };
        const piglets = { productId: pigletId, stockLotId: pigletLotId };
        // Deux lots de poulets (100 et 40 têtes) et un lot de porcs (10 têtes) : le type de référence est le poulet.
        const l1 = await place('POULET_CHAIR', broilerId, chicks, 100);
        const l2 = await place('POULET_CHAIR', broilerId, chicks, 40);
        const l3 = await place('PORC_ENGRAISSEMENT', hogId, piglets, 10);
        const feedLot = (lotId: string, time: string, quantity: number) =>
          run(farm, 'production.input.record', 'CONSUMPTION', freshUuid(), time, {
            productionLotId: lotId,
            locationId: storeId,
            productId: feedId,
            quantityBase: quantity,
            unitCode: 'KG',
            quantity,
            costType: 'ALIMENT',
          });
        // Aliment du mois : 40 kg sur L1, 6 kg sur L3 (46 kg au total).
        await feedLot(l1, feedAt('07:00:00'), 40);
        await feedLot(l3, feedAt('08:30:00'), 6);
        const weigh = (lotId: string, time: string, avgWeightG: number) =>
          run(farm, 'production.weighing.record', 'LOT_WEIGHING', freshUuid(), time, {
            productionLotId: lotId,
            sampleSize: 10,
            avgWeightG,
          });
        // Poids : L1 600 g, L2 900 g (poulets : (600 × 100 + 900 × 40) ÷ 140 = 685,7 g), L3 30 kg.
        await weigh(l1, feedAt('10:00:00'), 600);
        await weigh(l2, feedAt('09:00:00'), 900);
        await weigh(l3, feedAt('11:00:00'), 30_000);
      }, 180_000);

      const block = (overrides: Partial<DashboardContext> = {}) =>
        productionBlock(contextOf(db, scopeA(), overrides));

      it('KPI-PRD-04 : l’aliment du bloc égale feedConsumption et les documents ; période précédente et lien d’exploration', async () => {
        const result = await block();
        expect(result.unavailable).toBeNull();
        const current = await feedConsumption(db, scopeA(), win(PERIOD));
        const previous = await feedConsumption(db, scopeA(), win(PERIOD.previous));
        const card = kpiOf(result, 'KPI-PRD-04')!;
        expect(card.value).toBe(current.quantity);
        expect(card.previousValue).toBe(previous.quantity);
        // Documents : 40 kg sur L1 et 6 kg sur L3 ce mois-ci, rien le mois précédent pour cette ferme neuve.
        expect(card.value).toBe(46);
        expect(card.previousValue).toBe(0);
        expect(card.unit).toBe('quantity');
        expect(card.explore?.definition).toMatchObject({
          dataset: 'f_production_daily',
          measures: ['feed_consumed'],
          period: { code: 'CUSTOM', fromDay: PERIOD.fromDay, toDay: PERIOD.toDay },
        });
      });

      it('KPI-PRD-05 : poids du type de référence en kg, libellé qui nomme le type, détail de l’autre type, sans période précédente', async () => {
        const result = await block();
        const weighing = await latestWeighing(db, scopeA(), { at: AT });
        const reference = referenceLotType(weighing.byLotType);
        expect(reference).toBe('POULET_CHAIR');
        const grams = weighing.byLotType.find((type) => type.lotType === reference)!.avgWeightG!;
        const card = kpiOf(result, 'KPI-PRD-05')!;
        expect(card.value).toBe(Math.round(grams) / 1000);
        expect(card.value).toBe(0.686);
        expect(card.label).toContain('Poulets de chair');
        expect(card.unit).toBe('quantity');
        expect(card.previousValue).toBeUndefined();
        expect(card.explore ?? null).toBeNull();
        expect(result.details).toContainEqual({
          label: 'Poids moyen (kg) — Porcs d’engraissement',
          value: 30,
          unit: 'quantity',
        });
      });

      it('KPI-PRD-09 : coût par tête du type de référence ; sans droit de valorisation, valeur nulle, sans lien ni ligne de coût', async () => {
        const weighing = await latestWeighing(db, scopeA(), { at: AT });
        const cost = await costPerHead(db, scopeA());
        const reference = referenceLotType(weighing.byLotType);
        const expected = cost.byLotType.find((type) => type.lotType === reference)!.costPerHeadXaf;
        expect(expected).not.toBeNull();
        const valued = await block();
        const card = kpiOf(valued, 'KPI-PRD-09')!;
        expect(card.value).toBe(expected);
        expect(card.unit).toBe('xaf');
        expect(card.label).toContain('Poulets de chair');
        expect(card.previousValue).toBeUndefined();
        // L'autre type apparaît en détail, au coût.
        const pigs = cost.byLotType.find((type) => type.lotType === 'PORC_ENGRAISSEMENT')!;
        expect(valued.details).toContainEqual({
          label: 'Coût par tête — Porcs d’engraissement',
          value: pigs.costPerHeadXaf,
          unit: 'xaf',
        });

        const masked = await block({ canReadValuation: false });
        expect(masked.unavailable).toBeNull();
        const maskedCard = kpiOf(masked, 'KPI-PRD-09')!;
        expect(maskedCard.value).toBeNull();
        expect(maskedCard.explore ?? null).toBeNull();
        // Aucun montant au coût nulle part dans le bloc : cartes en francs nulles, aucune ligne de détail en francs.
        for (const kpi of masked.kpis.filter((entry) => entry.unit === 'xaf')) {
          expect(kpi.value, kpi.code).toBeNull();
        }
        expect(masked.details.filter((detail) => detail.unit === 'xaf')).toEqual([]);
        // Les indicateurs qui ne sont pas au coût restent lisibles.
        expect(kpiOf(masked, 'KPI-PRD-04')!.value).toBe(46);
      });

      it('ordre des indicateurs, bloc valide au regard du contrat, au plus 50 lignes de détail', async () => {
        const result = await block();
        expect(result.kpis.map((kpi) => kpi.code)).toEqual([
          'KPI-PRD-01',
          'KPI-PRD-02',
          'KPI-PRD-03',
          'KPI-PRD-04',
          'KPI-PRD-05',
          'KPI-PRD-06',
          'KPI-PRD-07',
          'KPI-PRD-08',
          'KPI-PRD-09',
        ]);
        expect(result.details.length).toBeLessThanOrEqual(50);
        expect(dashboardBlockSchema.safeParse(result).success).toBe(true);
      });

      it('périmètre vide : aliment 0, poids et coût nuls, sans erreur (jamais « tout »)', async () => {
        const result = await productionBlock(contextOf(db, { siteIds: [] }));
        expect(result.unavailable).toBeNull();
        expect(kpiOf(result, 'KPI-PRD-04')!.value).toBe(0);
        expect(kpiOf(result, 'KPI-PRD-05')!.value).toBeNull();
        expect(kpiOf(result, 'KPI-PRD-09')!.value).toBeNull();
        expect(kpiOf(result, 'KPI-PRD-05')!.label).toBe('Poids moyen (kg)');
        expect(dashboardBlockSchema.safeParse(result).success).toBe(true);
      });
    });
  });
});
