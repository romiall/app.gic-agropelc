/**
 * `sales.losses.sales_share_check` (P9-08 ; D13 §7.1 `HIGH_LOSS`, AV-356, AV-405) : la part « % du CA » de
 * l'alerte de pertes anormales. Les pertes sont de vraies déclarations (insertion directe, transaction
 * annulée) lues par `inventory.dayLossByLocation` ; le CA net du site est simulé (`soldByLocation` a ses
 * propres tests, P5-19) pour maîtriser le dénominateur sans fabriquer des ventes.
 */
import { afterAll, describe, expect, it, vi } from 'vitest';

vi.mock('../src/modules/sales/application/public/distribution-metrics.js', () => ({
  soldByLocation: vi.fn(),
}));

import { FixedClock, Uuidv7Generator } from '@gic/domain';
import { JobHandlerRegistry } from '../src/platform/jobs/job-handler-registry.js';
import {
  HIGH_LOSS_SALES_SHARE_JOB_TYPE,
  HighLossSalesShareJob,
} from '../src/modules/sales/application/jobs/high-loss-sales-share-job.js';
import { SALES_RECURRING_JOBS } from '../src/modules/sales/application/jobs/sales-recurring-jobs.js';
import { soldByLocation } from '../src/modules/sales/application/public/distribution-metrics.js';
import { toDomainEvent } from '../src/platform/events/domain-event.js';
import { handleAlertEvent } from '../src/modules/communication/application/events/alerts-consumer.js';
import { jsonValue } from '../src/platform/kysely/json-value.js';
import type { UnitOfWork } from '../src/platform/unit-of-work.js';
import { toBin } from '../src/platform/kysely/uuid-columns.js';
import { rolledBack } from './communication-test-kit.js';
import {
  closeTestDb,
  freshUuid,
  insertTestLocation,
  insertTestProduct,
  insertTestSite,
  insertTestUser,
  insertTestZone,
} from './helpers.js';

vi.setConfig({ testTimeout: 120_000 });

/** 06:45 à Douala le 12 novembre : la veille est le 11, l'avant-veille le 10. */
const NOW = new Date('2026-11-12T05:45:00.000Z');
const YESTERDAY = '2026-11-11';
const DAY_BEFORE = '2026-11-10';
const clock = new FixedClock(NOW);
const idGenerator = new Uuidv7Generator(clock);

afterAll(closeTestDb);

function runner(at: FixedClock = clock) {
  const registry = new JobHandlerRegistry();
  new HighLossSalesShareJob(at, idGenerator, registry).onModuleInit();
  return registry.resolve(HIGH_LOSS_SALES_SHARE_JOB_TYPE)!;
}

const salesLine = (siteId: string, netXaf: number) => ({
  siteId,
  locationId: freshUuid(),
  productId: freshUuid(),
  soldQty: 1,
  cancelledQty: 0,
  soldNetQty: 1,
  soldXaf: netXaf,
  cancelledXaf: 0,
  netXaf,
});

/**
 * CA simulé par (site, jour) : une ligne par montant. Le simulacre filtre sur les sites et le jour de la
 * période demandés, comme la lecture réelle : le jour et le site sont donc réellement exercés.
 */
function salesBySiteAndDay(map: Record<string, Record<string, readonly number[]>>) {
  vi.mocked(soldByLocation).mockImplementation(async (_executor, input) =>
    (input.siteIds ?? []).flatMap((siteId) =>
      (map[siteId]?.[input.period.fromDay] ?? []).map((net) => salesLine(siteId, net)),
    ),
  );
}

/** Même CA net chaque jour pour un site. */
function salesOfSite(site: string, netXaf: number) {
  salesBySiteAndDay({ [site]: { [YESTERDAY]: [netXaf], [DAY_BEFORE]: [netXaf] } });
}

async function world(uow: UnitOfWork) {
  const admin = await insertTestUser(uow);
  const zone = await insertTestZone(uow, admin);
  const site = await insertTestSite(uow, admin, zone);
  const store = await insertTestLocation(uow, admin, site, { locationType: 'STORE' });
  const product = await insertTestProduct(uow, admin);
  let n = 0;
  const loss = async (
    valueXaf: number,
    options: { readonly day?: string; readonly category?: string; readonly status?: string } = {},
  ) => {
    n += 1;
    const id = freshUuid();
    await uow
      .insertInto('inventory_loss_declarations')
      .values({
        id: toBin(id),
        doc_number: `PRT-T-${id.slice(-8)}`,
        site_id: toBin(site),
        location_id: toBin(store),
        product_id: toBin(product),
        quantity_base: String(n),
        unit_code: 'TETE',
        quantity: String(n),
        category: options.category ?? 'CASSE',
        comment: 'x',
        declared_by: toBin(admin),
        status: options.status ?? 'RECORDED',
        unit_cost_xaf: 1,
        value_xaf: valueXaf,
        occurred_at: new Date(`${options.day ?? YESTERDAY}T10:00:00.000Z`),
        created_by: toBin(admin),
        ...(options.category === 'MORTALITE' ? { production_lot_id: toBin(freshUuid()) } : {}),
      })
      .execute();
  };
  return { admin, site, store, loss };
}

async function shareEvents(uow: UnitOfWork, store: string) {
  const rows = await uow
    .selectFrom('platform_domain_events')
    .selectAll()
    .where('event_type', '=', 'HighLossSalesShareDetected')
    .orderBy('seq', 'desc')
    .limit(2000)
    .execute();
  return rows
    .map((row) => toDomainEvent(row))
    .filter((event) => (event.payload as { location_id: string }).location_id === store)
    .reverse();
}

describe('sales.losses.sales_share_check (P9-08)', () => {
  it('inscrite à l’ordonnanceur, chaque jour à 06:45', () => {
    expect(SALES_RECURRING_JOBS).toContainEqual({
      jobType: HIGH_LOSS_SALES_SHARE_JOB_TYPE,
      schedule: { kind: 'DAILY', localTime: '06:45' },
    });
  });

  it('perte ≥ 5 % du CA net du site de la veille : un événement au format du seuil absolu', () =>
    rolledBack(async (uow) => {
      const { site, store, loss } = await world(uow);
      await loss(3_000);
      await loss(2_000); // 5 000 sur 100 000 : 5 % exactement
      salesOfSite(site, 100_000);
      await runner()(uow, {});
      const [event] = await shareEvents(uow, store);
      expect(event!.producerModule).toBe('sales');
      expect(event!.aggregateType).toBe('LOSS_DAY');
      expect(event!.payload).toMatchObject({
        location_id: store,
        business_day: YESTERDAY,
        location_label: 'Emplacement de test',
        site_id: site,
        loss_value_xaf: 5_000,
        declarations: 2,
        cause: 'SALES_SHARE',
        share_pct: 5,
        threshold_pct: 5,
        sales_net_xaf: 100_000,
        pass_id: `HIGH_LOSS:SALES_SHARE:${YESTERDAY}`,
      });
      // Lecture des ventes : le site de la perte, le jour examiné.
      const yesterdayCall = vi
        .mocked(soldByLocation)
        .mock.calls.find(
          (call) => call[1].period.fromDay === YESTERDAY && call[1].siteIds?.includes(site),
        );
      expect(yesterdayCall).toBeDefined();
      expect(yesterdayCall![1].period).toEqual({ fromDay: YESTERDAY, toDay: YESTERDAY });
    }));

  it('sous le seuil, sans vente ce jour-là ou mortalité seule : aucun événement', () =>
    rolledBack(async (uow) => {
      const { site, store, loss } = await world(uow);
      await loss(4_999); // 4,999 % de 100 000
      await loss(900_000, { category: 'MORTALITE' }); // exclue
      await loss(900_000, { status: 'REJECTED_RETURNED' }); // rendue : pas une perte
      salesOfSite(site, 100_000);
      await runner()(uow, {});
      expect(await shareEvents(uow, store)).toEqual([]);

      // Sans aucune vente du site : la part n'est pas définie, le seuil absolu seul s'applique.
      vi.mocked(soldByLocation).mockResolvedValue([]);
      await loss(80_000);
      await runner()(uow, {});
      expect(await shareEvents(uow, store)).toEqual([]);
    }));

  it('au plus un événement par emplacement et par jour examiné, même relu le lendemain', () =>
    rolledBack(async (uow) => {
      const { site, store, loss } = await world(uow);
      await loss(10_000);
      salesOfSite(site, 100_000);
      await runner()(uow, {}); // le 12 : examine le 11 et le 10
      await runner()(uow, {}); // rejeu : rien de plus
      expect(await shareEvents(uow, store)).toHaveLength(1);

      // Le 13 : le 11 devient l'avant-veille, il est relu (autre créneau) et ne republie pas.
      await runner(new FixedClock(new Date('2026-11-13T05:45:00.000Z')))(uow, {});
      expect(await shareEvents(uow, store)).toHaveLength(1);
    }));

  it('l’avant-veille est examinée aussi (faits saisis après coup), pas le jour d’avant', () =>
    rolledBack(async (uow) => {
      const { site, store, loss } = await world(uow);
      await loss(10_000, { day: DAY_BEFORE });
      await loss(10_000, { day: '2026-11-09' });
      // Le CA du troisième jour existe aussi : la perte de ce jour n'est pas examinée pour autant.
      salesBySiteAndDay({
        [site]: { [YESTERDAY]: [100_000], [DAY_BEFORE]: [100_000], ['2026-11-09']: [100_000] },
      });
      await runner()(uow, {});
      const days = (await shareEvents(uow, store)).map(
        (event) => (event.payload as { business_day: string }).business_day,
      );
      expect(days).toEqual([DAY_BEFORE]);
    }));

  it('pourcentage du site : réglage propre au site, repli du domaine sinon', () =>
    rolledBack(async (uow) => {
      const { admin, site, store, loss } = await world(uow);
      await uow
        .insertInto('organization_system_settings')
        .values({
          id: toBin(freshUuid()),
          key: 'sales.high_loss_alert_sales_pct',
          value: jsonValue(2),
          scope_type: 'SITE',
          scope_id: toBin(site),
          valid_from: new Date('2026-11-01T00:00:00.000Z'),
          is_client_visible: 0,
          reason: 'Réglage de test P9-08',
          created_by: toBin(admin),
        })
        .execute();
      await loss(2_500); // 2,5 % : au-dessus de 2 %, sous le défaut de 5 %
      salesOfSite(site, 100_000);
      await runner()(uow, {});
      const [event] = await shareEvents(uow, store);
      expect(event!.payload).toMatchObject({ threshold_pct: 2, share_pct: 2.5 });
    }));

  it('CA du site = somme de ses lignes ; chaque site et chaque jour avec son propre CA', () =>
    rolledBack(async (uow) => {
      const first = await world(uow);
      const second = await world(uow);
      salesBySiteAndDay({
        // Deux emplacements du site : 60 000 + 40 000 = 100 000 la veille ; 50 000 l'avant-veille.
        [first.site]: { [YESTERDAY]: [60_000, 40_000], [DAY_BEFORE]: [50_000] },
        // Un site bien plus gros : la même perte n'y est pas une part notable.
        [second.site]: { [YESTERDAY]: [10_000_000], [DAY_BEFORE]: [10_000_000] },
      });
      await first.loss(5_000); // 5 % de 100 000 (somme), pas 12,5 % de 40 000
      await first.loss(2_600, { day: DAY_BEFORE }); // 5,2 % de 50 000
      await second.loss(5_000); // 0,05 % de 10 000 000
      await runner()(uow, {});

      const ofFirst = await shareEvents(uow, first.store);
      const byDay = new Map(
        ofFirst.map((event) => [
          (event.payload as { business_day: string }).business_day,
          event.payload as Record<string, unknown>,
        ]),
      );
      expect([...byDay.keys()].sort()).toEqual([DAY_BEFORE, YESTERDAY].sort());
      expect(byDay.get(YESTERDAY)).toMatchObject({ sales_net_xaf: 100_000, share_pct: 5 });
      expect(byDay.get(DAY_BEFORE)).toMatchObject({ sales_net_xaf: 50_000, share_pct: 5.2 });
      expect(await shareEvents(uow, second.store)).toEqual([]);
    }));

  it('une perte qui atteint le seuil absolu n’est pas republiée par la part du CA (l’alerte résolue ne renaît pas)', () =>
    rolledBack(async (uow) => {
      const { site, store, loss } = await world(uow);
      await loss(60_000); // ≥ 50 000 : `inventory` a déjà levé l'alerte à la déclaration
      salesOfSite(site, 500_000); // 12 % du CA
      await runner()(uow, {});
      expect(await shareEvents(uow, store)).toEqual([]);
    }));

  it('seuil absolu du site relevé : la même perte relève de la part du CA ; règles lues à la fin du jour examiné', () =>
    rolledBack(async (uow) => {
      const { admin, site, store, loss } = await world(uow);
      const setting = (key: string, value: number, validFrom: string) =>
        uow
          .insertInto('organization_system_settings')
          .values({
            id: toBin(freshUuid()),
            key,
            value: jsonValue(value),
            scope_type: 'SITE',
            scope_id: toBin(site),
            valid_from: new Date(validFrom),
            is_client_visible: 0,
            reason: 'Réglage de test P9-08',
            created_by: toBin(admin),
          })
          .execute();
      await setting('inventory.high_loss_alert_xaf', 100_000, '2026-11-01T00:00:00.000Z');
      // Pourcentage relevé à 10 % **après** la fin du jour examiné (le 11 à Douala finit à 22:59:59Z) :
      // le jour est jugé avec la règle en vigueur ce jour-là, 5 %.
      await setting('sales.high_loss_alert_sales_pct', 10, '2026-11-11T23:30:00.000Z');
      await loss(60_000);
      salesOfSite(site, 800_000); // 7,5 % du CA : au-dessus de 5 %, sous 10 %
      await runner()(uow, {});
      const [event] = await shareEvents(uow, store);
      expect(event!.payload).toMatchObject({
        threshold_pct: 5,
        share_pct: 7.5,
        loss_value_xaf: 60_000,
      });
    }));

  it('bout en bout : le consommateur lève une alerte critique, valeur au coût protégée du message', () =>
    rolledBack(async (uow) => {
      const { admin, site, store, loss } = await world(uow);
      await uow
        .insertInto('organization_system_settings')
        .values({
          id: toBin(freshUuid()),
          key: 'inventory.high_loss_alert_xaf',
          value: jsonValue(1_000_000),
          scope_type: 'SITE',
          scope_id: toBin(site),
          valid_from: new Date('2026-11-01T00:00:00.000Z'),
          is_client_visible: 0,
          reason: 'Réglage de test P9-08',
          created_by: toBin(admin),
        })
        .execute();
      await loss(60_000);
      salesOfSite(site, 500_000); // 12 % du CA
      await runner()(uow, {});
      for (const event of await shareEvents(uow, store)) {
        await handleAlertEvent(uow, event, { idGenerator });
      }
      const alert = await uow
        .selectFrom('communication_alerts')
        .select(['occurrences', 'severity', 'status', 'message', 'payload'])
        .where('dedup_key', '=', `HIGH_LOSS:LOSS_DAY:${store}:${YESTERDAY}`)
        .executeTakeFirstOrThrow();
      expect(alert).toMatchObject({ occurrences: 1, severity: 'CRITICAL', status: 'OPEN' });
      expect((alert.payload as { cause: string }).cause).toBe('SALES_SHARE');
      expect(alert.message).toContain('Emplacement de test');
      expect(alert.message).not.toContain('60 000');
      expect(alert.message).not.toContain('60000');
    }));
});
