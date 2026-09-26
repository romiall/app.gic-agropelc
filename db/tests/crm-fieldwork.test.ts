// Contraintes de base des espaces de noms `crm` et `fieldwork` (P3-02) : invariants portés par
// la base elle-même (INV-CRM-01 à 04, INV-TER-01 et 02, BR-CRM-002, 016, 018). Chaque test
// crée ses propres référentiels (étape, source, zone) dans une transaction annulée : aucune
// dépendance à l'ordre d'exécution du seed.
import { describe, expect, it } from 'vitest';
import type { PoolConnection } from 'mysql2/promise';
import { randomId, withRollback } from './helpers.js';

const T0 = '2026-10-01 08:00:00.000000';
const T1 = '2026-10-02 08:00:00.000000';
const T2 = '2026-10-03 08:00:00.000000';

function randomCode(prefix: string): string {
  return `${prefix}${Math.floor(Math.random() * 1_000_000_000)}`;
}

function randomPhone(): string {
  return `+2376${Math.floor(10_000_000 + Math.random() * 89_999_999)}`;
}

async function insertUser(conn: PoolConnection): Promise<Buffer> {
  const id = randomId();
  await conn.query(
    `INSERT INTO identity_users (id, full_name, phone, password_hash, status, created_by)
     VALUES (?, 'Test', ?, 'x', 'ACTIVE', ?)`,
    [id, randomPhone(), id],
  );
  return id;
}

interface Refs {
  readonly admin: Buffer;
  readonly zoneId: Buffer;
  readonly stepId: Buffer;
  readonly sourceCode: string;
}

async function setup(conn: PoolConnection): Promise<Refs> {
  const admin = await insertUser(conn);
  const zoneId = randomId();
  await conn.query(
    `INSERT INTO organization_zones (id, level, code, name, depth, created_by) VALUES (?, 'VILLE', ?, 'Douala', 1, ?)`,
    [zoneId, randomCode('Z'), admin],
  );
  const stepId = randomId();
  await conn.query(
    `INSERT INTO crm_pipeline_steps (id, code, label, sort_order, created_by) VALUES (?, ?, 'Nouveau', 10, ?)`,
    [stepId, randomCode('STEP_'), admin],
  );
  const sourceCode = randomCode('SRC_');
  await conn.query(
    `INSERT INTO crm_lead_sources (id, code, label, created_by) VALUES (?, ?, 'Terrain', ?)`,
    [randomId(), sourceCode, admin],
  );
  return { admin, zoneId, stepId, sourceCode };
}

async function insertCustomer(
  conn: PoolConnection,
  refs: Refs,
  overrides: {
    readonly phone?: string | null;
    readonly stage?: string;
    readonly firstSaleId?: Buffer | null;
    readonly duplicateOfId?: Buffer | null;
  } = {},
): Promise<Buffer> {
  const id = randomId();
  await conn.query(
    `INSERT INTO crm_customers (id, stage, pipeline_step_id, display_name, phone_primary, zone_id, source_code,
       acquired_by_user_id, acquired_at, first_sale_id, duplicate_of_id, occurred_at, created_by)
     VALUES (?, ?, ?, 'Boutique test', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      overrides.stage ?? 'PROSPECT',
      refs.stepId,
      overrides.phone === undefined ? randomPhone() : overrides.phone,
      refs.zoneId,
      refs.sourceCode,
      refs.admin,
      T0,
      overrides.firstSaleId ?? null,
      overrides.duplicateOfId ?? null,
      T0,
      refs.admin,
    ],
  );
  return id;
}

describe('crm_customers', () => {
  it('BR-CRM-002 : refuse un compte sans téléphone ni position', async () => {
    await withRollback(async (conn) => {
      const refs = await setup(conn);
      await expect(insertCustomer(conn, refs, { phone: null })).rejects.toThrow(
        /ck_crm_customers_findable/,
      );
    });
  });

  it("INV-CRM-01 : acquéreur et date d'acquisition immuables", async () => {
    await withRollback(async (conn) => {
      const refs = await setup(conn);
      const customer = await insertCustomer(conn, refs);
      const other = await insertUser(conn);
      await expect(
        conn.query('UPDATE crm_customers SET acquired_by_user_id = ? WHERE id = ?', [
          other,
          customer,
        ]),
      ).rejects.toThrow(/INV-CRM-01/);
      await expect(
        conn.query('UPDATE crm_customers SET acquired_at = ? WHERE id = ?', [T1, customer]),
      ).rejects.toThrow(/INV-CRM-01/);
      // Les autres champs restent modifiables.
      await conn.query("UPDATE crm_customers SET display_name = 'Nouveau nom' WHERE id = ?", [
        customer,
      ]);
    });
  });

  it('INV-CRM-03 : téléphone unique hors comptes fusionnés ; un doublon hors ligne en attente est toléré', async () => {
    await withRollback(async (conn) => {
      const refs = await setup(conn);
      const phone = randomPhone();
      const kept = await insertCustomer(conn, refs, { phone });
      await expect(insertCustomer(conn, refs, { phone })).rejects.toThrow(/uq_crm_customers_phone/);
      // Fait accompli hors ligne (BR-SYN-007) : enregistré, rattaché au compte existant.
      const duplicate = await insertCustomer(conn, refs, { phone, duplicateOfId: kept });
      // Fusion : le compte absorbé sort de l'unicité par son stade.
      await conn.query(
        "UPDATE crm_customers SET stage = 'MERGED', merged_into_id = ?, duplicate_of_id = NULL WHERE id = ?",
        [kept, duplicate],
      );
    });
  });

  it('INV-CRM-04 : un compte CUSTOMER a une première vente', async () => {
    await withRollback(async (conn) => {
      const refs = await setup(conn);
      await expect(insertCustomer(conn, refs, { stage: 'CUSTOMER' })).rejects.toThrow(
        /ck_crm_customers_customer/,
      );
      await insertCustomer(conn, refs, { stage: 'CUSTOMER', firstSaleId: randomId() });
    });
  });

  it('un compte MERGED désigne son compte conservé ; suppression physique interdite', async () => {
    await withRollback(async (conn) => {
      const refs = await setup(conn);
      const customer = await insertCustomer(conn, refs);
      await expect(
        conn.query("UPDATE crm_customers SET stage = 'MERGED' WHERE id = ?", [customer]),
      ).rejects.toThrow(/ck_crm_customers_merged/);
      await expect(
        conn.query('DELETE FROM crm_customers WHERE id = ?', [customer]),
      ).rejects.toThrow(/suppression physique interdite/);
    });
  });
});

describe('crm_customer_assignments', () => {
  it('INV-CRM-02 : au plus une affectation active, périodes sans chevauchement', async () => {
    await withRollback(async (conn) => {
      const refs = await setup(conn);
      const customer = await insertCustomer(conn, refs);
      const first = await insertUser(conn);
      const second = await insertUser(conn);
      const insertAssignment = (
        user: Buffer,
        validFrom: string,
        validTo: string | null,
      ): Promise<unknown> =>
        conn.query(
          `INSERT INTO crm_customer_assignments (id, customer_id, user_id, valid_from, valid_to, assigned_by)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [randomId(), customer, user, validFrom, validTo, refs.admin],
        );

      await insertAssignment(first, T0, null);
      await expect(insertAssignment(second, T1, null)).rejects.toThrow(
        /INV-CRM-02|uq_crm_customer_assignments_active/,
      );

      // BR-CRM-020 : fermeture à T1 et ouverture au même instant.
      await conn.query(
        'UPDATE crm_customer_assignments SET valid_to = ? WHERE customer_id = ? AND user_id = ?',
        [T1, customer, first],
      );
      await insertAssignment(second, T1, null);

      // Période close qui chevauche la première affectation [T0, T1].
      await expect(insertAssignment(second, '2026-10-01 12:00:00', T2)).rejects.toThrow(
        /INV-CRM-02/,
      );
      await expect(
        conn.query(
          'UPDATE crm_customer_assignments SET user_id = ? WHERE customer_id = ? AND user_id = ?',
          [second, customer, first],
        ),
      ).rejects.toThrow(/seule la fermeture/);
    });
  });
});

describe('crm_customer_stage_history', () => {
  it('BR-CRM-008 : historique de stade immuable', async () => {
    await withRollback(async (conn) => {
      const refs = await setup(conn);
      const customer = await insertCustomer(conn, refs);
      const id = randomId();
      await conn.query(
        `INSERT INTO crm_customer_stage_history (id, customer_id, from_stage, to_stage, to_step_id, occurred_at, actor_user_id)
         VALUES (?, ?, NULL, 'PROSPECT', ?, ?, ?)`,
        [id, customer, refs.stepId, T0, refs.admin],
      );
      await expect(
        conn.query("UPDATE crm_customer_stage_history SET to_stage = 'LOST' WHERE id = ?", [id]),
      ).rejects.toThrow(/BR-CRM-008/);
      await expect(
        conn.query('DELETE FROM crm_customer_stage_history WHERE id = ?', [id]),
      ).rejects.toThrow(/BR-CRM-008/);
    });
  });
});

describe('crm_visits', () => {
  it("BR-CRM-016 : une visite n'est plus modifiable ; seules l'annulation et les indicateurs évoluent", async () => {
    await withRollback(async (conn) => {
      const refs = await setup(conn);
      const customer = await insertCustomer(conn, refs);
      const outcome = randomId();
      await conn.query(
        `INSERT INTO catalog_reason_codes (id, category, code, label, created_by) VALUES (?, 'VISIT_OUTCOME', ?, 'Intéressé', ?)`,
        [outcome, randomCode('VO_'), refs.admin],
      );
      const visit = randomId();
      await conn.query(
        `INSERT INTO crm_visits (id, customer_id, user_id, customer_stage_at_visit, outcome_reason_code_id, occurred_at, created_by)
         VALUES (?, ?, ?, 'PROSPECT', ?, ?, ?)`,
        [visit, customer, refs.admin, outcome, T0, refs.admin],
      );

      await expect(
        conn.query("UPDATE crm_visits SET notes = 'corrigé' WHERE id = ?", [visit]),
      ).rejects.toThrow(/BR-CRM-016/);
      await expect(
        conn.query("UPDATE crm_visits SET status = 'CANCELLED' WHERE id = ?", [visit]),
      ).rejects.toThrow(/ck_crm_visits_cancel/);
      await conn.query(
        `UPDATE crm_visits SET flags = JSON_ARRAY('SESSION_REJECTED') WHERE id = ?`,
        [visit],
      );
      await conn.query(
        "UPDATE crm_visits SET status = 'CANCELLED', cancelled_at = ?, cancelled_by = ?, cancel_comment = 'Doublon' WHERE id = ?",
        [T1, refs.admin, visit],
      );
    });
  });
});

describe('crm_sales_targets', () => {
  it('BR-CRM-018 : pas deux objectifs actifs chevauchants de même cible, métrique et produit', async () => {
    await withRollback(async (conn) => {
      const refs = await setup(conn);
      const seller = await insertUser(conn);
      const insertTarget = (
        id: Buffer,
        metric: string,
        start: string,
        end: string,
      ): Promise<unknown> =>
        conn.query(
          `INSERT INTO crm_sales_targets (id, target_type, user_id, metric, period_start, period_end, target_value, created_by)
           VALUES (?, 'USER', ?, ?, ?, ?, 20, ?)`,
          [id, seller, metric, start, end, refs.admin],
        );
      const october = randomId();
      const overlapping = randomId();
      await insertTarget(october, 'VISITES', '2026-10-01', '2026-10-31');
      await expect(
        insertTarget(overlapping, 'VISITES', '2026-10-15', '2026-11-15'),
      ).rejects.toThrow(/BR-CRM-018/);
      await insertTarget(randomId(), 'PROSPECTS_CREES', '2026-10-15', '2026-11-15'); // autre métrique

      await conn.query("UPDATE crm_sales_targets SET status = 'CANCELLED' WHERE id = ?", [october]);
      await insertTarget(overlapping, 'VISITES', '2026-10-15', '2026-11-15');
      await expect(
        conn.query("UPDATE crm_sales_targets SET status = 'ACTIVE' WHERE id = ?", [october]),
      ).rejects.toThrow(/BR-CRM-018/);
      await expect(
        conn.query('UPDATE crm_sales_targets SET target_value = 30 WHERE id = ?', [overlapping]),
      ).rejects.toThrow(/non modifiable/);
    });
  });

  it('exactement une cible selon le type ; produit requis pour QTE_PRODUIT', async () => {
    await withRollback(async (conn) => {
      const refs = await setup(conn);
      await expect(
        conn.query(
          `INSERT INTO crm_sales_targets (id, target_type, metric, period_start, period_end, target_value, created_by)
           VALUES (?, 'USER', 'VISITES', '2026-10-01', '2026-10-31', 10, ?)`,
          [randomId(), refs.admin],
        ),
      ).rejects.toThrow(/ck_crm_sales_targets_target/);
      await expect(
        conn.query(
          `INSERT INTO crm_sales_targets (id, target_type, user_id, metric, period_start, period_end, target_value, created_by)
           VALUES (?, 'USER', ?, 'QTE_PRODUIT', '2026-10-01', '2026-10-31', 10, ?)`,
          [randomId(), refs.admin, refs.admin],
        ),
      ).rejects.toThrow(/ck_crm_sales_targets_product/);
    });
  });
});

async function insertDevice(conn: PoolConnection, owner: Buffer): Promise<Buffer> {
  const id = randomId();
  await conn.query(
    `INSERT INTO identity_devices (id, short_code, enrolled_by_user_id, created_by) VALUES (?, ?, ?, ?)`,
    [id, randomCode('D').slice(0, 4).padEnd(4, 'X'), owner, owner],
  );
  return id;
}

describe('fieldwork_work_sessions', () => {
  it('INV-TER-01 : au plus une session ouverte par utilisateur ; cycle de vie cohérent', async () => {
    await withRollback(async (conn) => {
      const refs = await setup(conn);
      const device = await insertDevice(conn, refs.admin);
      const insertSession = (id: Buffer, startedAt: string): Promise<unknown> =>
        conn.query(
          `INSERT INTO fieldwork_work_sessions (id, user_id, device_id, declared_zone_id, started_at, start_checkin_id, occurred_at, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [id, refs.admin, device, refs.zoneId, startedAt, randomId(), startedAt, refs.admin],
        );
      const morning = randomId();
      const afternoon = randomId();
      await insertSession(morning, T0);
      await expect(insertSession(afternoon, T1)).rejects.toThrow(
        /uq_fieldwork_work_sessions_open_user/,
      );

      await expect(
        conn.query("UPDATE fieldwork_work_sessions SET status = 'CLOSED' WHERE id = ?", [morning]),
      ).rejects.toThrow(/ck_fieldwork_work_sessions_lifecycle/);
      await conn.query(
        "UPDATE fieldwork_work_sessions SET status = 'CLOSED', ended_at = ?, close_cause = 'SUPERSEDED' WHERE id = ?",
        [T1, morning],
      );
      await insertSession(afternoon, T1);

      await expect(
        conn.query('UPDATE fieldwork_work_sessions SET started_at = ? WHERE id = ?', [T2, morning]),
      ).rejects.toThrow(/seules la clôture et la dérogation/);
    });
  });
});

describe('fieldwork_geo_checkins', () => {
  it('INV-TER-02 : toute tentative est conservée, y compris refusée, et immuable', async () => {
    await withRollback(async (conn) => {
      const refs = await setup(conn);
      const id = randomId();
      await conn.query(
        `INSERT INTO fieldwork_geo_checkins (id, user_id, checkin_type, declared_zone_id, lat, lng, accuracy_m,
           client_result, server_result, occurred_at, created_by)
         VALUES (?, ?, 'START_SERVICE', ?, 4.067, 9.767, 12.0, 'REJECTED_OUT_OF_ZONE', 'REJECTED_OUT_OF_ZONE', ?, ?)`,
        [id, refs.admin, refs.zoneId, T0, refs.admin],
      );
      await expect(
        conn.query("UPDATE fieldwork_geo_checkins SET server_result = 'ACCEPTED' WHERE id = ?", [
          id,
        ]),
      ).rejects.toThrow(/INV-TER-02/);
      await expect(
        conn.query('DELETE FROM fieldwork_geo_checkins WHERE id = ?', [id]),
      ).rejects.toThrow(/INV-TER-02/);
    });
  });

  it('une tentative sans position ne porte pas de coordonnées', async () => {
    await withRollback(async (conn) => {
      const refs = await setup(conn);
      await expect(
        conn.query(
          `INSERT INTO fieldwork_geo_checkins (id, user_id, checkin_type, declared_zone_id, lat, lng,
             client_result, server_result, occurred_at, created_by)
           VALUES (?, ?, 'START_SERVICE', ?, 4.067, 9.767, 'NO_POSITION', 'NO_POSITION', ?, ?)`,
          [randomId(), refs.admin, refs.zoneId, T0, refs.admin],
        ),
      ).rejects.toThrow(/ck_fieldwork_geo_checkins_no_position/);
    });
  });
});
