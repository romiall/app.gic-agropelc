import { describe, expect, it } from 'vitest';
import type { PoolConnection } from 'mysql2/promise';
import { randomId, withRollback } from './helpers.js';

async function insertAdmin(conn: PoolConnection): Promise<Buffer> {
  const id = randomId();
  await conn.query(
    `INSERT INTO identity_users (id, full_name, phone, password_hash, status, created_by)
     VALUES (?, 'Admin', ?, 'x', 'ACTIVE', ?)`,
    [id, `+2376${Math.floor(1_000_0000 + Math.random() * 8_999_9999)}`, id],
  );
  return id;
}

async function insertZoneAndSite(
  conn: PoolConnection,
  admin: Buffer,
): Promise<{ zoneId: Buffer; siteId: Buffer }> {
  const zoneId = randomId();
  await conn.query(
    `INSERT INTO organization_zones (id, level, code, name, depth, created_by) VALUES (?, 'VILLE', ?, 'Douala', 1, ?)`,
    [zoneId, `Z${Math.floor(Math.random() * 1_000_000)}`, admin],
  );
  const siteId = randomId();
  await conn.query(
    `INSERT INTO organization_sites (id, code, name, site_type, zone_id, created_by) VALUES (?, ?, 'Ferme', 'FERME', ?, ?)`,
    [siteId, `S${Math.floor(Math.random() * 1_000_000)}`, zoneId, admin],
  );
  return { zoneId, siteId };
}

describe('organization_zones', () => {
  it('exige lat/lng/rayon ensemble ou pas du tout', async () => {
    await withRollback(async (conn) => {
      const admin = await insertAdmin(conn);
      await expect(
        conn.query(
          `INSERT INTO organization_zones (id, level, code, name, depth, geofence_lat, created_by)
           VALUES (?, 'VILLE', 'DLA', 'Douala', 1, 4.05, ?)`,
          [randomId(), admin],
        ),
      ).rejects.toThrow(/ck_organization_zones_geofence/);
    });
  });

  it('rejette un rayon hors de [50, 5000]', async () => {
    await withRollback(async (conn) => {
      const admin = await insertAdmin(conn);
      await expect(
        conn.query(
          `INSERT INTO organization_zones (id, level, code, name, depth, geofence_lat, geofence_lng, geofence_radius_m, created_by)
           VALUES (?, 'VILLE', 'DLA', 'Douala', 1, 4.05, 9.7, 10, ?)`,
          [randomId(), admin],
        ),
      ).rejects.toThrow(/ck_organization_zones_radius/);
    });
  });

  it('refuse toute suppression physique', async () => {
    await withRollback(async (conn) => {
      const admin = await insertAdmin(conn);
      const { zoneId } = await insertZoneAndSite(conn, admin);
      await expect(
        conn.query('DELETE FROM organization_zones WHERE id = ?', [zoneId]),
      ).rejects.toThrow(/suppression physique interdite/);
    });
  });
});

describe('organization_locations', () => {
  it('refuse un second emplacement virtuel actif du même type (index unique partiel)', async () => {
    await withRollback(async (conn) => {
      const admin = await insertAdmin(conn);
      await conn.query(
        `INSERT INTO organization_locations (id, code, name, location_type, status, created_by) VALUES (?, 'P1', 'Pertes', 'V_LOSS', 'ACTIVE', ?)`,
        [randomId(), admin],
      );
      await expect(
        conn.query(
          `INSERT INTO organization_locations (id, code, name, location_type, status, created_by) VALUES (?, 'P2', 'Pertes bis', 'V_LOSS', 'ACTIVE', ?)`,
          [randomId(), admin],
        ),
      ).rejects.toThrow(/uq_organization_locations_active_virtual_type/);
    });
  });

  it('refuse un second emplacement MOBILE actif pour le même détenteur (INV-ADM-05)', async () => {
    await withRollback(async (conn) => {
      const admin = await insertAdmin(conn);
      const holder = await insertAdmin(conn);
      const { siteId } = await insertZoneAndSite(conn, admin);
      await conn.query(
        `INSERT INTO organization_locations (id, site_id, code, name, location_type, status, custody_mode, custodian_user_id, created_by)
         VALUES (?, ?, 'M1', 'Mobile 1', 'MOBILE', 'ACTIVE', 'EXCLUSIVE_USER', ?, ?)`,
        [randomId(), siteId, holder, admin],
      );
      await expect(
        conn.query(
          `INSERT INTO organization_locations (id, site_id, code, name, location_type, status, custody_mode, custodian_user_id, created_by)
           VALUES (?, ?, 'M2', 'Mobile 2', 'MOBILE', 'ACTIVE', 'EXCLUSIVE_USER', ?, ?)`,
          [randomId(), siteId, holder, admin],
        ),
      ).rejects.toThrow(/uq_organization_locations_active_mobile_custodian/);
    });
  });

  it('rejette un emplacement virtuel avec un site_id renseigné', async () => {
    await withRollback(async (conn) => {
      const admin = await insertAdmin(conn);
      const { siteId } = await insertZoneAndSite(conn, admin);
      await expect(
        conn.query(
          `INSERT INTO organization_locations (id, site_id, code, name, location_type, status, created_by)
           VALUES (?, ?, 'P1', 'Pertes', 'V_LOSS', 'ACTIVE', ?)`,
          [randomId(), siteId, admin],
        ),
      ).rejects.toThrow(/ck_organization_locations_virtual_site/);
    });
  });

  it("rejette une case (PEN) sans parent, ou avec un parent qui n'est pas un bâtiment", async () => {
    await withRollback(async (conn) => {
      const admin = await insertAdmin(conn);
      const { siteId } = await insertZoneAndSite(conn, admin);
      await expect(
        conn.query(
          `INSERT INTO organization_locations (id, site_id, code, name, location_type, status, created_by)
           VALUES (?, ?, 'C1', 'Case', 'PEN', 'ACTIVE', ?)`,
          [randomId(), siteId, admin],
        ),
      ).rejects.toThrow(/bâtiment parent/);

      const storeId = randomId();
      await conn.query(
        `INSERT INTO organization_locations (id, site_id, code, name, location_type, status, created_by)
         VALUES (?, ?, 'ST1', 'Magasin', 'STORE', 'ACTIVE', ?)`,
        [storeId, siteId, admin],
      );
      await expect(
        conn.query(
          `INSERT INTO organization_locations (id, site_id, parent_location_id, code, name, location_type, status, created_by)
           VALUES (?, ?, ?, 'C1', 'Case', 'PEN', 'ACTIVE', ?)`,
          [randomId(), siteId, storeId, admin],
        ),
      ).rejects.toThrow(/bâtiment/);
    });
  });

  it('accepte une case (PEN) dont le parent est un bâtiment (BUILDING)', async () => {
    await withRollback(async (conn) => {
      const admin = await insertAdmin(conn);
      const { siteId } = await insertZoneAndSite(conn, admin);
      const buildingId = randomId();
      await conn.query(
        `INSERT INTO organization_locations (id, site_id, code, name, location_type, status, created_by)
         VALUES (?, ?, 'B1', 'Bâtiment', 'BUILDING', 'ACTIVE', ?)`,
        [buildingId, siteId, admin],
      );
      await conn.query(
        `INSERT INTO organization_locations (id, site_id, parent_location_id, code, name, location_type, status, created_by)
         VALUES (?, ?, ?, 'C1', 'Case', 'PEN', 'ACTIVE', ?)`,
        [randomId(), siteId, buildingId, admin],
      );
    });
  });
});

describe('organization_team_memberships', () => {
  it('rejette deux appartenances chevauchantes pour le même utilisateur (BR-ADM-014)', async () => {
    await withRollback(async (conn) => {
      const admin = await insertAdmin(conn);
      const user = await insertAdmin(conn);
      const team1 = randomId();
      const team2 = randomId();
      await conn.query(
        `INSERT INTO organization_teams (id, code, name, manager_user_id, created_by) VALUES (?, 'T1', 'Equipe 1', ?, ?)`,
        [team1, admin, admin],
      );
      await conn.query(
        `INSERT INTO organization_teams (id, code, name, manager_user_id, created_by) VALUES (?, 'T2', 'Equipe 2', ?, ?)`,
        [team2, admin, admin],
      );
      await conn.query(
        `INSERT INTO organization_team_memberships (id, team_id, user_id, valid_from, created_by) VALUES (?, ?, ?, '2026-01-01', ?)`,
        [randomId(), team1, user, admin],
      );
      await expect(
        conn.query(
          `INSERT INTO organization_team_memberships (id, team_id, user_id, valid_from, created_by) VALUES (?, ?, ?, '2026-02-01', ?)`,
          [randomId(), team2, user, admin],
        ),
      ).rejects.toThrow(/périodes chevauchantes/);
    });
  });

  it('autorise la fermeture (valid_to) puis une nouvelle appartenance non chevauchante', async () => {
    await withRollback(async (conn) => {
      const admin = await insertAdmin(conn);
      const user = await insertAdmin(conn);
      const team1 = randomId();
      const team2 = randomId();
      await conn.query(
        `INSERT INTO organization_teams (id, code, name, manager_user_id, created_by) VALUES (?, 'T1', 'Equipe 1', ?, ?)`,
        [team1, admin, admin],
      );
      await conn.query(
        `INSERT INTO organization_teams (id, code, name, manager_user_id, created_by) VALUES (?, 'T2', 'Equipe 2', ?, ?)`,
        [team2, admin, admin],
      );
      const membership1 = randomId();
      await conn.query(
        `INSERT INTO organization_team_memberships (id, team_id, user_id, valid_from, created_by) VALUES (?, ?, ?, '2026-01-01', ?)`,
        [membership1, team1, user, admin],
      );
      await conn.query('UPDATE organization_team_memberships SET valid_to = ? WHERE id = ?', [
        '2026-02-01',
        membership1,
      ]);
      await conn.query(
        `INSERT INTO organization_team_memberships (id, team_id, user_id, valid_from, created_by) VALUES (?, ?, ?, '2026-02-01', ?)`,
        [randomId(), team2, user, admin],
      );
    });
  });

  it('refuse une modification hors liste blanche (team_id)', async () => {
    await withRollback(async (conn) => {
      const admin = await insertAdmin(conn);
      const user = await insertAdmin(conn);
      const team1 = randomId();
      await conn.query(
        `INSERT INTO organization_teams (id, code, name, manager_user_id, created_by) VALUES (?, 'T1', 'Equipe 1', ?, ?)`,
        [team1, admin, admin],
      );
      const membership1 = randomId();
      await conn.query(
        `INSERT INTO organization_team_memberships (id, team_id, user_id, valid_from, created_by) VALUES (?, ?, ?, '2026-01-01', ?)`,
        [membership1, team1, user, admin],
      );
      await expect(
        conn.query('UPDATE organization_team_memberships SET team_id = ? WHERE id = ?', [
          randomId(),
          membership1,
        ]),
      ).rejects.toThrow(/seule la fermeture/);
    });
  });
});

describe('organization_system_settings', () => {
  it("accepte l'insertion puis refuse toute modification (versionnement pur, BR-ADM-015)", async () => {
    await withRollback(async (conn) => {
      const admin = await insertAdmin(conn);
      const settingId = randomId();
      await conn.query(
        `INSERT INTO organization_system_settings (id, \`key\`, value, created_by) VALUES (?, 'fieldwork.geofence_radius_m', CAST('500' AS JSON), ?)`,
        [settingId, admin],
      );
      await expect(
        conn.query(
          "UPDATE organization_system_settings SET value = CAST('600' AS JSON) WHERE id = ?",
          [settingId],
        ),
      ).rejects.toThrow(/aucune modification/);
    });
  });
});
