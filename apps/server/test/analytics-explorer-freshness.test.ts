/**
 * Fraîcheur d'une lecture de l'explorateur (P9-14 (3/4) ; BR-ANA-005, ADR-065 §7) : les appareils **du périmètre**
 * de l'étendue — ceux des points de vente que l'étendue atteint — et ceux d'entre eux sans contact depuis plus de
 * `analytics.freshness_warning_hours`. La base d'essai est partagée : chaque essai compare la fraîcheur avant et
 * après l'ajout, dans la transaction annulée de l'essai, de deux appareils rattachés à un point de vente (l'un
 * sans contact depuis cinq heures, l'autre vu à l'instant).
 */
import { afterAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import type { ExactScope, ScopeClause } from '../src/modules/analytics/application/public/index.js';
import type { UnitOfWork } from '../src/platform/unit-of-work.js';
import { explorerFreshness } from '../src/analytics-api/explorer-freshness.js';
import { toBin } from '../src/platform/kysely/uuid-columns.js';
import {
  closeTestDb,
  freshUuid,
  insertTestDevice,
  insertTestLocation,
  insertTestSite,
  insertTestUser,
  insertTestZone,
  withTestUow,
} from './helpers.js';

afterAll(closeTestDb);

const NOW = new Date();
const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000);
const clauses = (...list: ScopeClause[]): ExactScope => ({
  kind: 'CLAUSES',
  clauses: list,
  truncated: false,
});

describe('fraîcheur des appareils du périmètre', () => {
  /** Un point de vente configuré, dans sa zone, créé dans la transaction de l'essai. */
  async function newPos(trx: UnitOfWork): Promise<{ siteId: string; zoneId: string }> {
    const admin = await insertTestUser(trx);
    const zoneId = await insertTestZone(trx, admin);
    const siteId = await insertTestSite(trx, admin, zoneId, { siteType: 'POINT_DE_VENTE' });
    const salesLocation = await insertTestLocation(trx, admin, siteId, { locationType: 'POS' });
    await trx
      .insertInto('organization_points_of_sale')
      .values({
        site_id: toBin(siteId),
        sales_location_id: toBin(salesLocation),
        custody_mode: 'SHARED',
        created_by: toBin(admin),
      })
      .execute();
    return { siteId, zoneId };
  }

  async function twoDevices(trx: UnitOfWork, siteId: string) {
    const owner = await insertTestUser(trx);
    for (const seen of [hoursAgo(5), NOW]) {
      const deviceId = await insertTestDevice(trx, owner, { status: 'ACTIVE' });
      await sql`UPDATE identity_devices SET designated_site_id = ${toBin(siteId)},
                last_seen_at = ${seen} WHERE id = ${toBin(deviceId)}`.execute(trx);
    }
  }

  it('un site, une zone, tout site ou l’étendue totale : les deux appareils ajoutés comptent, dont un en retard', async () => {
    await withTestUow(async (trx) => {
      const pos = await newPos(trx);
      const scopes: ReadonlyArray<readonly [string, ExactScope | undefined]> = [
        ['un site', clauses({ type: 'SITES', ids: [pos.siteId], viaZoneIds: [] })],
        ['un site lu par sa zone', clauses({ type: 'SITES', ids: [], viaZoneIds: [pos.siteId] })],
        [
          'un couple site et soi',
          clauses({ type: 'SITES_AND_SELF', ids: [pos.siteId], viaZoneIds: [], userId: 'x' }),
        ],
        ['une zone', clauses({ type: 'ZONES', ids: [pos.zoneId], withSiteIds: [] })],
        ['une zone avec site', clauses({ type: 'ZONES', ids: [], withSiteIds: [pos.zoneId] })],
        ['une zone et soi', clauses({ type: 'ZONES_AND_SELF', ids: [pos.zoneId], userId: 'x' })],
        ['tout site', clauses({ type: 'ANY_SITE' })],
        ['tout site et des membres', clauses({ type: 'ANY_SITE_AND_PERSONS', ids: ['x'] })],
        ['toute zone', clauses({ type: 'ANY_ZONE' })],
        ['toute zone et des membres', clauses({ type: 'ANY_ZONE_AND_PERSONS', ids: ['x'] })],
        ['l’étendue totale', { kind: 'ALL' }],
        ['aucune étendue', undefined],
      ];
      const before = new Map<string, Awaited<ReturnType<typeof explorerFreshness>>>();
      for (const [label, scope] of scopes) {
        before.set(label, await explorerFreshness(trx, { scope, now: NOW }));
      }
      await twoDevices(trx, pos.siteId);
      for (const [label, scope] of scopes) {
        const after = await explorerFreshness(trx, { scope, now: NOW });
        const base = before.get(label)!;
        expect(after.devicesInScope - base.devicesInScope, label).toBe(2);
        expect(after.staleDevices - base.staleDevices, label).toBe(1);
        expect(after.computedAt, label).toBe(NOW.toISOString());
        expect(after.staleAfterHours, label).toBeGreaterThan(0);
      }
    });
  });

  it('une étendue qui n’atteint aucun site (personnes seules, vide) n’a aucun appareil ; un autre site n’ajoute rien', async () => {
    await withTestUow(async (trx) => {
      const pos = await newPos(trx);
      await twoDevices(trx, pos.siteId);
      const none: ReadonlyArray<ExactScope> = [
        clauses({ type: 'PERSONS', ids: ['x'] }),
        { kind: 'CLAUSES', clauses: [], truncated: false },
      ];
      for (const scope of none) {
        const report = await explorerFreshness(trx, { scope, now: NOW });
        expect(report.devicesInScope).toBe(0);
        expect(report.staleDevices).toBe(0);
      }
      // Un site sans point de vente configuré n'a pas de parc.
      const otherSite = await explorerFreshness(trx, {
        scope: clauses({ type: 'SITES', ids: [freshUuid()], viaZoneIds: [] }),
        now: NOW,
      });
      expect(otherSite.devicesInScope).toBe(0);
    });
  });

  it('un appareil hors service est listé mais ne compte ni dans le parc ni en retard', async () => {
    await withTestUow(async (trx) => {
      const pos = await newPos(trx);
      const scope = clauses({ type: 'SITES', ids: [pos.siteId], viaZoneIds: [] });
      const before = await explorerFreshness(trx, { scope, now: NOW });
      const owner = await insertTestUser(trx);
      const blocked = await insertTestDevice(trx, owner, { status: 'BLOCKED' });
      await sql`UPDATE identity_devices SET designated_site_id = ${toBin(pos.siteId)},
                last_seen_at = ${hoursAgo(9)} WHERE id = ${toBin(blocked)}`.execute(trx);
      const after = await explorerFreshness(trx, { scope, now: NOW });
      expect(after.devicesInScope).toBe(before.devicesInScope);
      expect(after.staleDevices).toBe(before.staleDevices);
    });
  });
});
