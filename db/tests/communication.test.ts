// Module `communication` après la migration 20261201090100 (P9-03 ; SM-ALERT, BR-NOT-002 à 008,
// INV-NOT-01 ; ADR-071 à ADR-073) : règles, alertes (déduplication par colonne générée sous index
// unique, immuabilité après résolution, gravité qui ne baisse pas), destinataires, notifications,
// abonnements push, notes de direction (publiée = immuable, audiences comprises) et accusés. Chaque
// test crée ses données dans une transaction annulée.
import { describe, expect, it } from 'vitest';
import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import { freshPhone, freshShortCode, randomId, withRollback } from './helpers.js';

const T = (day: string, hhmm = '10:00') => `${day} ${hhmm}:00.000000`;

async function user(conn: PoolConnection, name = 'Utilisateur'): Promise<Buffer> {
  const id = randomId();
  await conn.query(
    `INSERT INTO identity_users (id, full_name, phone, password_hash, status, created_by)
     VALUES (?, ?, ?, 'x', 'ACTIVE', ?)`,
    [id, name, await freshPhone(conn), id],
  );
  return id;
}

/** Règle du type : insérée si le seed ne l'a pas encore fait (la base de test peut n'être que migrée). */
async function ensureRule(conn: PoolConnection, alertType: string): Promise<void> {
  await conn.query(
    `INSERT INTO communication_alert_rules (alert_type, severity, recipient_roles, resolution_mode)
     VALUES (?, 'WARNING', JSON_ARRAY('FINANCE'), 'AUTO')
     ON DUPLICATE KEY UPDATE alert_type = alert_type`,
    [alertType],
  );
}

interface AlertInput {
  readonly type?: string;
  readonly dedup?: string;
  readonly severity?: 'INFO' | 'WARNING' | 'CRITICAL';
  readonly status?: string;
}

async function alert(conn: PoolConnection, input: AlertInput = {}): Promise<Buffer> {
  const type = input.type ?? 'OVERDUE_RECEIVABLE';
  await ensureRule(conn, type);
  const id = randomId();
  const severity = input.severity ?? 'WARNING';
  await conn.query(
    `INSERT INTO communication_alerts (id, alert_type, nature, severity, status, subject_type, subject_id, title, payload,
       dedup_key, first_detected_at, last_detected_at, critical_since)
     VALUES (?, ?, 'STATE', ?, ?, 'SALE', ?, 'Créance échue', JSON_OBJECT('doc_number', 'VTE-1'), ?, ?, ?, ?)`,
    [
      id,
      type,
      severity,
      input.status ?? 'OPEN',
      randomId(),
      input.dedup ?? `${type}:${id.toString('hex')}`,
      T('2026-12-02'),
      T('2026-12-02'),
      severity === 'CRITICAL' ? T('2026-12-02') : null,
    ],
  );
  return id;
}

const statusOf = async (conn: PoolConnection, id: Buffer): Promise<string> => {
  const [rows] = await conn.query<RowDataPacket[]>(
    'SELECT status FROM communication_alerts WHERE id = ?',
    [id],
  );
  return rows[0]!.status as string;
};

describe('communication_alert_rules', () => {
  it('une règle valide ; type hors catalogue, gravité, escalade et rôles non tableau refusés', () =>
    withRollback(async (conn) => {
      const insert = (
        type: string,
        severity = 'WARNING',
        hours: number | null = null,
        roles = `JSON_ARRAY('FINANCE')`,
      ) =>
        conn.query(
          `INSERT INTO communication_alert_rules (alert_type, severity, recipient_roles, resolution_mode, escalation_hours)
           VALUES (?, ?, ${roles}, 'AUTO', ?)
           ON DUPLICATE KEY UPDATE alert_type = alert_type`,
          [type, severity, hours],
        );
      await insert('STOCK_LOW');
      await expect(insert('NOT_A_TYPE')).rejects.toThrow(/ck_communication_alert_rules_type/);
      await expect(
        conn.query(
          `UPDATE communication_alert_rules SET severity = 'FATAL' WHERE alert_type = 'STOCK_LOW'`,
        ),
      ).rejects.toThrow(/ck_communication_alert_rules_severity/);
      await expect(
        conn.query(
          `UPDATE communication_alert_rules SET escalation_hours = 0 WHERE alert_type = 'STOCK_LOW'`,
        ),
      ).rejects.toThrow(/ck_communication_alert_rules_escalation/);
      await expect(
        conn.query(
          `UPDATE communication_alert_rules SET escalation_hours = 169 WHERE alert_type = 'STOCK_LOW'`,
        ),
      ).rejects.toThrow(/ck_communication_alert_rules_escalation/);
      await expect(
        conn.query(
          `UPDATE communication_alert_rules SET recipient_roles = JSON_OBJECT('a', 1) WHERE alert_type = 'STOCK_LOW'`,
        ),
      ).rejects.toThrow(/ck_communication_alert_rules_roles/);
      await conn.query(
        `UPDATE communication_alert_rules SET escalation_hours = 4, severity = 'CRITICAL' WHERE alert_type = 'STOCK_LOW'`,
      );
    }));

  it('le type est immuable et la règle ne se supprime pas (désactivation)', () =>
    withRollback(async (conn) => {
      await ensureRule(conn, 'STOCK_LOW');
      await expect(
        conn.query(
          `UPDATE communication_alert_rules SET alert_type = 'STOCK_OUT' WHERE alert_type = 'STOCK_LOW'`,
        ),
      ).rejects.toThrow(/immuable|référencée|foreign key/i);
      await expect(
        conn.query(`DELETE FROM communication_alert_rules WHERE alert_type = 'STOCK_LOW'`),
      ).rejects.toThrow(/suppression interdite/);
      await conn.query(
        `UPDATE communication_alert_rules SET enabled = FALSE WHERE alert_type = 'STOCK_LOW'`,
      );
    }));

  it('le seed pose les 36 règles du catalogue, dont une seule désactivée (P10)', async () => {
    const [rows] = await withRollback(async (conn) =>
      conn.query<RowDataPacket[]>(
        `SELECT COUNT(*) AS total, SUM(enabled = 0) AS disabled FROM communication_alert_rules`,
      ),
    );
    // La base de test peut n'être que migrée : le décompte n'est vérifié que si le seed a tourné.
    const total = Number(rows[0]!.total);
    if (total > 0) {
      expect(total).toBeGreaterThanOrEqual(36);
      expect(Number(rows[0]!.disabled)).toBeGreaterThanOrEqual(1);
    }
  });
});

describe('communication_alerts — INV-NOT-01 (une alerte ouverte par type et sujet)', () => {
  it('une seconde alerte ouverte de même clé est refusée, prise en compte comprise', () =>
    withRollback(async (conn) => {
      await alert(conn, { dedup: 'OVERDUE_RECEIVABLE:S1' });
      await expect(alert(conn, { dedup: 'OVERDUE_RECEIVABLE:S1' })).rejects.toThrow(
        /uq_communication_alerts_open_dedup/,
      );
      const second = await alert(conn, { dedup: 'OVERDUE_RECEIVABLE:S2' });
      await conn.query(
        `UPDATE communication_alerts SET status = 'ACKNOWLEDGED', acknowledged_by = ?, acknowledged_at = ? WHERE id = ?`,
        [await user(conn), T('2026-12-02', '11:00'), second],
      );
      await expect(alert(conn, { dedup: 'OVERDUE_RECEIVABLE:S2' })).rejects.toThrow(
        /uq_communication_alerts_open_dedup/,
      );
    }));

  it('une alerte résolue libère la clé : une nouvelle alerte de même clé est admise', () =>
    withRollback(async (conn) => {
      const first = await alert(conn, { dedup: 'OVERDUE_RECEIVABLE:S3' });
      await conn.query(
        `UPDATE communication_alerts SET status = 'RESOLVED', resolved_at = ?, resolution_kind = 'CONDITION_CLEARED'
         WHERE id = ?`,
        [T('2026-12-03'), first],
      );
      const [open] = await conn.query<RowDataPacket[]>(
        'SELECT open_dedup_key FROM communication_alerts WHERE id = ?',
        [first],
      );
      expect(open[0]!.open_dedup_key).toBeNull();
      await alert(conn, { dedup: 'OVERDUE_RECEIVABLE:S3' });
      // Une alerte écartée libère aussi la clé.
      const dismissed = await alert(conn, { dedup: 'HIGH_LOSS:S4', type: 'HIGH_LOSS' });
      await conn.query(
        `UPDATE communication_alerts SET status = 'DISMISSED', resolved_at = ?, resolution_kind = 'DISMISSED',
           resolved_by = ?, resolution_comment = 'Faux positif' WHERE id = ?`,
        [T('2026-12-03'), await user(conn), dismissed],
      );
      await alert(conn, { dedup: 'HIGH_LOSS:S4', type: 'HIGH_LOSS' });
    }));
});

describe('communication_alerts — cohérence et immuabilité', () => {
  it('gravité critique ⇔ critical_since ; escalade seulement si critique', () =>
    withRollback(async (conn) => {
      const warning = await alert(conn);
      await expect(
        conn.query(`UPDATE communication_alerts SET severity = 'CRITICAL' WHERE id = ?`, [warning]),
      ).rejects.toThrow(/ck_communication_alerts_critical/);
      await conn.query(
        `UPDATE communication_alerts SET severity = 'CRITICAL', critical_since = ? WHERE id = ?`,
        [T('2026-12-02', '12:00'), warning],
      );
      await expect(
        conn.query(`UPDATE communication_alerts SET escalated_at = ? WHERE id = ?`, [
          T('2026-12-02', '16:00'),
          warning,
        ]),
      ).resolves.toBeDefined();
      // Escalade posée : ni effacée, ni déplacée.
      await expect(
        conn.query(`UPDATE communication_alerts SET escalated_at = NULL WHERE id = ?`, [warning]),
      ).rejects.toThrow(/escalade déjà posée/);
      await expect(
        conn.query(`UPDATE communication_alerts SET critical_since = ? WHERE id = ?`, [
          T('2026-12-03'),
          warning,
        ]),
      ).rejects.toThrow(/critical_since déjà posé/);
    }));

  it('la gravité d’une alerte ouverte ne baisse pas ; le compteur ne recule pas (AV-401)', () =>
    withRollback(async (conn) => {
      const id = await alert(conn, { severity: 'CRITICAL' });
      await expect(
        conn.query(
          `UPDATE communication_alerts SET severity = 'WARNING', critical_since = NULL WHERE id = ?`,
          [id],
        ),
      ).rejects.toThrow(/ne baisse pas/);
      await conn.query(`UPDATE communication_alerts SET occurrences = 3 WHERE id = ?`, [id]);
      await expect(
        conn.query(`UPDATE communication_alerts SET occurrences = 2 WHERE id = ?`, [id]),
      ).rejects.toThrow(/ne recule pas/);
    }));

  it('identité immuable ; ACKNOWLEDGED ne redevient pas OPEN', () =>
    withRollback(async (conn) => {
      const id = await alert(conn);
      for (const column of ['alert_type', 'subject_type', 'dedup_key', 'nature']) {
        const value =
          column === 'nature' ? 'EVENT' : column === 'alert_type' ? 'STOCK_LOW' : 'autre';
        if (column === 'alert_type') await ensureRule(conn, 'STOCK_LOW');
        await expect(
          conn.query(`UPDATE communication_alerts SET ${column} = ? WHERE id = ?`, [value, id]),
        ).rejects.toThrow(/identité de l'alerte immuable/);
      }
      await conn.query(
        `UPDATE communication_alerts SET status = 'ACKNOWLEDGED', acknowledged_by = ?, acknowledged_at = ? WHERE id = ?`,
        [await user(conn), T('2026-12-02', '11:00'), id],
      );
      await expect(
        conn.query(`UPDATE communication_alerts SET status = 'OPEN' WHERE id = ?`, [id]),
      ).rejects.toThrow(/ne redevient pas ouverte/);
    }));

  it('une alerte résolue ou écartée est immuable (ADR-006)', () =>
    withRollback(async (conn) => {
      const id = await alert(conn);
      await conn.query(
        `UPDATE communication_alerts SET status = 'RESOLVED', resolved_at = ?, resolution_kind = 'PASS' WHERE id = ?`,
        [T('2026-12-03'), id],
      );
      expect(await statusOf(conn, id)).toBe('RESOLVED');
      await expect(
        conn.query(`UPDATE communication_alerts SET occurrences = occurrences + 1 WHERE id = ?`, [
          id,
        ]),
      ).rejects.toThrow(/immuable/);
      await expect(
        conn.query(`UPDATE communication_alerts SET status = 'OPEN' WHERE id = ?`, [id]),
      ).rejects.toThrow(/immuable/);
    }));

  it('clôture : date et nature ensemble ; résolution ou écart manuel : auteur et commentaire', () =>
    withRollback(async (conn) => {
      const resolve = (set: string, ...params: unknown[]) =>
        conn.query(`UPDATE communication_alerts SET ${set} WHERE id = ?`, params);
      const a = await alert(conn);
      await expect(resolve(`status = 'RESOLVED'`, a)).rejects.toThrow(
        /ck_communication_alerts_closed/,
      );
      await expect(
        resolve(
          `status = 'RESOLVED', resolved_at = ?, resolution_kind = 'MANUAL'`,
          T('2026-12-03'),
          a,
        ),
      ).rejects.toThrow(/ck_communication_alerts_manual/);
      await expect(
        resolve(
          `status = 'RESOLVED', resolved_at = ?, resolution_kind = 'DISMISSED', resolved_by = ?, resolution_comment = 'x'`,
          T('2026-12-03'),
          await user(conn),
          a,
        ),
      ).rejects.toThrow(/ck_communication_alerts_dismissed/);
      await expect(
        resolve(
          `status = 'DISMISSED', resolved_at = ?, resolution_kind = 'MANUAL', resolved_by = ?, resolution_comment = 'x'`,
          T('2026-12-03'),
          await user(conn),
          a,
        ),
      ).rejects.toThrow(/ck_communication_alerts_dismissed/);
      await resolve(
        `status = 'RESOLVED', resolved_at = ?, resolution_kind = 'MANUAL', resolved_by = ?, resolution_comment = 'Régularisé'`,
        T('2026-12-03'),
        await user(conn),
        a,
      );
    }));

  it('purge : seules les alertes closes depuis plus de 2 ans ; les destinataires suivent', () =>
    withRollback(async (conn) => {
      const open = await alert(conn);
      await expect(
        conn.query('DELETE FROM communication_alerts WHERE id = ?', [open]),
      ).rejects.toThrow(/seules les alertes closes depuis plus de 2 ans/);
      const recent = await alert(conn);
      await conn.query(
        `UPDATE communication_alerts SET status = 'RESOLVED', resolved_at = UTC_TIMESTAMP(6), resolution_kind = 'PASS' WHERE id = ?`,
        [recent],
      );
      await expect(
        conn.query('DELETE FROM communication_alerts WHERE id = ?', [recent]),
      ).rejects.toThrow(/seules les alertes closes depuis plus de 2 ans/);
      // Close depuis plus de 2 ans : purgeable, destinataires et liens de notification suivent.
      const old = await alert(conn);
      const recipient = await user(conn);
      await conn.query(
        `INSERT INTO communication_alert_recipients (alert_id, user_id, origin) VALUES (?, ?, 'RULE')`,
        [old, recipient],
      );
      const notification = randomId();
      await conn.query(
        `INSERT INTO communication_notifications (id, user_id, channel, kind, alert_id, alert_type, title)
         VALUES (?, ?, 'IN_APP', 'ALERT', ?, 'OVERDUE_RECEIVABLE', 'Créance échue')`,
        [notification, recipient, old],
      );
      await conn.query(
        `UPDATE communication_alerts SET status = 'RESOLVED', resolved_at = ?, resolution_kind = 'PASS' WHERE id = ?`,
        [T('2020-01-01'), old],
      );
      await conn.query('DELETE FROM communication_alerts WHERE id = ?', [old]);
      const [recipients] = await conn.query<RowDataPacket[]>(
        'SELECT COUNT(*) AS c FROM communication_alert_recipients WHERE alert_id = ?',
        [old],
      );
      expect(Number(recipients[0]!.c)).toBe(0);
      const [notes] = await conn.query<RowDataPacket[]>(
        'SELECT alert_id FROM communication_notifications WHERE id = ?',
        [notification],
      );
      expect(notes[0]!.alert_id).toBeNull();
    }));
});

describe('communication_alert_recipients', () => {
  it('une ligne par utilisateur et par alerte ; origine du catalogue ; ajout seul', () =>
    withRollback(async (conn) => {
      const id = await alert(conn);
      const recipient = await user(conn);
      const add = (origin: string, userId: Buffer = recipient) =>
        conn.query(
          `INSERT INTO communication_alert_recipients (alert_id, user_id, origin, role_code) VALUES (?, ?, ?, 'FINANCE')`,
          [id, userId, origin],
        );
      await add('RULE');
      await expect(add('OWNER')).rejects.toThrow(/Duplicate entry/);
      await expect(add('TEAM', await user(conn))).rejects.toThrow(
        /ck_communication_alert_recipients_origin/,
      );
      await add('TEAM_MANAGER', await user(conn));
      await add('APPROVER', await user(conn));
      await add('ESCALATION', await user(conn));
      await add('FALLBACK', await user(conn));
      await expect(
        conn.query(
          `UPDATE communication_alert_recipients SET origin = 'OWNER' WHERE alert_id = ? AND user_id = ?`,
          [id, recipient],
        ),
      ).rejects.toThrow(/ajout seul/);
      await expect(
        conn.query(
          `DELETE FROM communication_alert_recipients WHERE alert_id = ? AND user_id = ?`,
          [id, recipient],
        ),
      ).rejects.toThrow(/suppression directe interdite/);
    }));
});

describe('communication_notifications', () => {
  it('canal et nature du catalogue ; une notification d’alerte garde son type', () =>
    withRollback(async (conn) => {
      const u = await user(conn);
      const insert = (
        channel: string,
        kind: string,
        alertType: string | null,
        noteId: Buffer | null = null,
      ) =>
        conn.query(
          `INSERT INTO communication_notifications (id, user_id, channel, kind, alert_type, note_id, title)
           VALUES (?, ?, ?, ?, ?, ?, 'Titre')`,
          [randomId(), u, channel, kind, alertType, noteId],
        );
      await insert('IN_APP', 'ALERT', 'STOCK_OUT');
      await insert('WEB_PUSH', 'DIRECT', null);
      await insert('IN_APP', 'EXPORT', null);
      await expect(insert('SMS', 'ALERT', 'STOCK_OUT')).rejects.toThrow(
        /ck_communication_notifications_channel/,
      );
      await expect(insert('IN_APP', 'MAIL', null)).rejects.toThrow(
        /ck_communication_notifications_kind/,
      );
      await expect(insert('IN_APP', 'ALERT', null)).rejects.toThrow(
        /ck_communication_notifications_alert/,
      );
      await expect(insert('IN_APP', 'NOTE', null)).rejects.toThrow(
        /ck_communication_notifications_note/,
      );
    }));

  it('un consommateur rejoué ne double pas une notification (utilisateur, canal, événement)', () =>
    withRollback(async (conn) => {
      const u = await user(conn);
      const event = randomId();
      const insert = (channel: string) =>
        conn.query(
          `INSERT INTO communication_notifications (id, user_id, channel, kind, alert_type, source_event_id, title)
           VALUES (?, ?, ?, 'ALERT', 'STOCK_OUT', ?, 'Rupture')`,
          [randomId(), u, channel, event],
        );
      await insert('IN_APP');
      await insert('WEB_PUSH');
      await expect(insert('IN_APP')).rejects.toThrow(/uq_communication_notifications_event/);
    }));

  it('seules la livraison et la lecture évoluent, la lecture une fois', () =>
    withRollback(async (conn) => {
      const u = await user(conn);
      const id = randomId();
      await conn.query(
        `INSERT INTO communication_notifications (id, user_id, channel, kind, alert_type, title)
         VALUES (?, ?, 'IN_APP', 'ALERT', 'STOCK_OUT', 'Rupture')`,
        [id, u],
      );
      await expect(
        conn.query(`UPDATE communication_notifications SET title = 'Autre' WHERE id = ?`, [id]),
      ).rejects.toThrow(/seules la livraison et la lecture évoluent/);
      await conn.query(
        `UPDATE communication_notifications SET delivered_at = ?, read_at = ? WHERE id = ?`,
        [T('2026-12-02'), T('2026-12-02', '11:00'), id],
      );
      await expect(
        conn.query(`UPDATE communication_notifications SET read_at = ? WHERE id = ?`, [
          T('2026-12-03'),
          id,
        ]),
      ).rejects.toThrow(/date de lecture déjà posée/);
    }));
});

describe('communication_push_subscriptions', () => {
  it('un point de terminaison unique ; seule la révocation évolue, une fois', () =>
    withRollback(async (conn) => {
      const u = await user(conn);
      const device = randomId();
      await conn.query(
        `INSERT INTO identity_devices (id, short_code, enrolled_by_user_id, created_by) VALUES (?, ?, ?, ?)`,
        [device, await freshShortCode(conn), u, u],
      );
      const subscribe = (endpoint: string) =>
        conn.query(
          `INSERT INTO communication_push_subscriptions (id, user_id, device_id, endpoint, p256dh, auth)
           VALUES (?, ?, ?, ?, 'BPk', 'sec')`,
          [randomId(), u, device, endpoint],
        );
      await subscribe('https://push.example.org/send/a');
      await expect(subscribe('https://push.example.org/send/a')).rejects.toThrow(
        /uq_communication_push_subscriptions_endpoint/,
      );
      await expect(
        conn.query(`UPDATE communication_push_subscriptions SET auth = 'x' WHERE user_id = ?`, [u]),
      ).rejects.toThrow(/seule la révocation évolue/);
      await conn.query(
        `UPDATE communication_push_subscriptions SET revoked_at = ? WHERE user_id = ?`,
        [T('2026-12-02'), u],
      );
      await expect(
        conn.query(`UPDATE communication_push_subscriptions SET revoked_at = ? WHERE user_id = ?`, [
          T('2026-12-03'),
          u,
        ]),
      ).rejects.toThrow(/révocation déjà posée/);
    }));
});

async function note(conn: PoolConnection, author: Buffer, status = 'DRAFT'): Promise<Buffer> {
  const id = randomId();
  await conn.query(
    `INSERT INTO communication_internal_notes (id, title, body, category, requires_ack, status, published_at, created_by)
     VALUES (?, 'Nouveau prix', 'Le poulet passe à 3 500 XAF.', 'PRIX', TRUE, ?, ?, ?)`,
    [id, status, status === 'DRAFT' ? null : T('2026-12-02'), author],
  );
  return id;
}

describe('communication_internal_notes (BR-NOT-006, ADR-073)', () => {
  it('brouillon modifiable ; publiée : contenu et audience figés ; archivée : immuable', () =>
    withRollback(async (conn) => {
      const author = await user(conn);
      const id = await note(conn, author);
      await conn.query(
        `INSERT INTO communication_note_audiences (note_id, audience_type) VALUES (?, 'ALL')`,
        [id],
      );
      await conn.query(
        `UPDATE communication_internal_notes SET title = 'Titre revu' WHERE id = ?`,
        [id],
      );
      await conn.query(
        `UPDATE communication_internal_notes SET status = 'PUBLISHED', published_at = ? WHERE id = ?`,
        [T('2026-12-02'), id],
      );
      for (const set of [
        `title = 'Autre'`,
        `body = 'Autre corps'`,
        `category = 'INSTRUCTION'`,
        `requires_ack = FALSE`,
        `expires_at = '2027-01-01 00:00:00.000000'`,
      ]) {
        await expect(
          conn.query(`UPDATE communication_internal_notes SET ${set} WHERE id = ?`, [id]),
        ).rejects.toThrow(/note publiée, immuable/);
      }
      await expect(
        conn.query(`UPDATE communication_internal_notes SET status = 'DRAFT' WHERE id = ?`, [id]),
      ).rejects.toThrow(/ne revient pas au brouillon/);
      await conn.query(
        `UPDATE communication_internal_notes SET status = 'ARCHIVED', archived_at = ?, archive_reason = 'Remplacée' WHERE id = ?`,
        [T('2026-12-03'), id],
      );
      await expect(
        conn.query(`UPDATE communication_internal_notes SET archive_reason = 'x' WHERE id = ?`, [
          id,
        ]),
      ).rejects.toThrow(/note archivée, immuable/);
      await expect(
        conn.query('DELETE FROM communication_internal_notes WHERE id = ?', [id]),
      ).rejects.toThrow(/suppression interdite/);
    }));

  it('une note publiée a sa date ; l’expiration suit la publication ; la référence va par paire', () =>
    withRollback(async (conn) => {
      const author = await user(conn);
      const draft = await note(conn, author);
      await expect(
        conn.query(`UPDATE communication_internal_notes SET status = 'PUBLISHED' WHERE id = ?`, [
          draft,
        ]),
      ).rejects.toThrow(/ck_communication_internal_notes_published/);
      await expect(
        conn.query(
          `UPDATE communication_internal_notes SET status = 'PUBLISHED', published_at = ?, expires_at = ? WHERE id = ?`,
          [T('2026-12-02'), T('2026-12-01'), draft],
        ),
      ).rejects.toThrow(/ck_communication_internal_notes_expiry/);
      await expect(
        conn.query(
          `UPDATE communication_internal_notes SET related_entity_type = 'PRICE_RULE' WHERE id = ?`,
          [draft],
        ),
      ).rejects.toThrow(/ck_communication_internal_notes_related/);
      await expect(
        conn.query(`UPDATE communication_internal_notes SET status = 'ARCHIVED' WHERE id = ?`, [
          draft,
        ]),
      ).rejects.toThrow(/ck_communication_internal_notes_archived/);
      // Un brouillon abandonné est archivé, jamais supprimé.
      await conn.query(
        `UPDATE communication_internal_notes SET status = 'ARCHIVED', archived_at = ?, archive_reason = 'Abandon' WHERE id = ?`,
        [T('2026-12-02'), draft],
      );
    }));

  it('audience : « tous » avec la sentinelle, figée dès la publication, jamais modifiée', () =>
    withRollback(async (conn) => {
      const author = await user(conn);
      const draft = await note(conn, author);
      const add = (id: Buffer, type: string, ref?: string) =>
        ref === undefined
          ? conn.query(
              `INSERT INTO communication_note_audiences (note_id, audience_type) VALUES (?, ?)`,
              [id, type],
            )
          : conn.query(
              `INSERT INTO communication_note_audiences (note_id, audience_type, audience_ref) VALUES (?, ?, ?)`,
              [id, type, ref],
            );
      await add(draft, 'ROLE', 'VENDEUR_PDV');
      await add(draft, 'SITE', randomId().toString('hex'));
      await expect(add(draft, 'ALL', 'VENDEUR_PDV')).rejects.toThrow(
        /ck_communication_note_audiences_ref/,
      );
      await expect(add(draft, 'ROLE')).rejects.toThrow(/ck_communication_note_audiences_ref/);
      await expect(add(draft, 'GROUP', 'x')).rejects.toThrow(
        /ck_communication_note_audiences_type/,
      );
      await expect(
        conn.query(
          `UPDATE communication_note_audiences SET audience_ref = 'AUTRE' WHERE note_id = ?`,
          [draft],
        ),
      ).rejects.toThrow(/modification interdite/);
      // Brouillon : une ligne se retire (puis se rajoute).
      await conn.query(
        `DELETE FROM communication_note_audiences WHERE note_id = ? AND audience_type = 'ROLE'`,
        [draft],
      );
      await conn.query(
        `UPDATE communication_internal_notes SET status = 'PUBLISHED', published_at = ? WHERE id = ?`,
        [T('2026-12-02'), draft],
      );
      await expect(add(draft, 'ROLE', 'RESP_FERME')).rejects.toThrow(/audience figée/);
      await expect(
        conn.query(`DELETE FROM communication_note_audiences WHERE note_id = ?`, [draft]),
      ).rejects.toThrow(/audience figée/);
    }));
});

describe('communication_note_acknowledgements (UC-NOT-06)', () => {
  it('la lecture crée la ligne, l’accusé la complète une fois, rien ne se supprime', () =>
    withRollback(async (conn) => {
      const author = await user(conn);
      const reader = await user(conn);
      const id = await note(conn, author, 'PUBLISHED');
      await conn.query(
        `INSERT INTO communication_note_acknowledgements (note_id, user_id, read_at) VALUES (?, ?, ?)`,
        [id, reader, T('2026-12-02', '09:00')],
      );
      await expect(
        conn.query(
          `INSERT INTO communication_note_acknowledgements (note_id, user_id, read_at) VALUES (?, ?, ?)`,
          [id, reader, T('2026-12-02', '10:00')],
        ),
      ).rejects.toThrow(/Duplicate entry/);
      await expect(
        conn.query(
          `UPDATE communication_note_acknowledgements SET read_at = ? WHERE note_id = ? AND user_id = ?`,
          [T('2026-12-03'), id, reader],
        ),
      ).rejects.toThrow(/lecture immuable/);
      await conn.query(
        `UPDATE communication_note_acknowledgements SET acknowledged_at = ?, command_id = ? WHERE note_id = ? AND user_id = ?`,
        [T('2026-12-02', '09:05'), randomId(), id, reader],
      );
      await expect(
        conn.query(
          `UPDATE communication_note_acknowledgements SET acknowledged_at = ? WHERE note_id = ? AND user_id = ?`,
          [T('2026-12-03'), id, reader],
        ),
      ).rejects.toThrow(/accusé déjà enregistré/);
      await expect(
        conn.query(`DELETE FROM communication_note_acknowledgements WHERE note_id = ?`, [id]),
      ).rejects.toThrow(/suppression interdite/);
    }));
});
