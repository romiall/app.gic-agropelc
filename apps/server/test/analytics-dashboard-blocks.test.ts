/**
 * P9-25 — bornes des blocs de tableau de bord (constats TB-1, TB-5, TB-6, TB-9 et TB-12 de la revue adverse) :
 * - TB-1 : `portfolioHealth` et le bloc COMMERCIAL lisent des sites seuls par le site de rattachement, une étendue
 *   vide donne zéro (jamais tout le portefeuille), des personnes donnent le titulaire seul (AV-465) ;
 * - TB-5 : le seuil d'inactivité est le réglage `crm.inactive_after_days` (AV-013), à l'accueil comme au tableau ;
 * - TB-6 : une étendue tronquée au-delà de `analytics.scope_max_candidates` rend les blocs concernés indisponibles
 *   (`SCOPE_TRUNCATED`), pas un chiffre plus étroit que le droit ;
 * - TB-9 : `periodRevenue` et `periodProductQuantity` rendent des zéros pour un périmètre vide (`IN ()` invalide) ;
 * - TB-12 : un bloc dont la forme viole le contrat devient `BLOCK_INVALID`, il ne fait plus échouer tout le tableau.
 *
 * Les blocs sont appelés avec un `DashboardContext` construit à la main, dans une transaction annulée sur la base
 * partagée : identifiants neufs, assertions relatives au monde créé, aucun décalage d'horloge (instant fixe passé).
 */
import { afterAll, describe, expect, it } from 'vitest';
import { FixedClock, businessDayOf, resolveAnalyticsPeriod } from '@gic/domain';
import { dashboardBlockSchema, type DashboardBlock } from '@gic/contracts';
import { PERMISSIONS, ROLE_PERMISSIONS } from '../../../db/seeds/rbac-data.js';
import { fromBin, toBin } from '../src/platform/kysely/uuid-columns.js';
import type { ReadScope } from '../src/platform/read-scope.js';
import type { UnitOfWork } from '../src/platform/unit-of-work.js';
import { buildHome } from '../src/home-api/home-service.js';
import { buildDashboard } from '../src/analytics-api/dashboards/dashboard-builder.js';
import {
  commercialBlock,
  financeBlock,
  fitLabel,
  guarded,
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
} from '../src/modules/sales/application/public/index.js';
import {
  assignTestRole,
  closeTestDb,
  db,
  freshPhone,
  freshUuid,
  grantTestPermission,
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
});
