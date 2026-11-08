// Archive des photos jointes (AV-539, ADR-070) : les trois tables de trace, leurs contraintes et leurs déclencheurs
// d'immuabilité. Chaque essai tourne dans une transaction annulée (`withRollback`).
import { describe, expect, it } from 'vitest';
import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import { randomId, withRollback, freshPhone } from './helpers.js';

async function insertUser(conn: PoolConnection): Promise<Buffer> {
  const id = randomId();
  await conn.query(
    `INSERT INTO identity_users (id, full_name, phone, password_hash, status, created_by)
     VALUES (?, 'Admin', ?, 'x', 'ACTIVE', ?)`,
    [id, await freshPhone(conn), id],
  );
  return id;
}

async function insertAttachment(conn: PoolConnection, createdBy: Buffer): Promise<Buffer> {
  const id = randomId();
  await conn.query(
    `INSERT INTO attachments_attachments (id, owner_type, owner_id, kind, mime_type, size_bytes, sha256, storage_key,
       upload_status, uploaded_bytes, captured_at, occurred_at, received_at, created_by)
     VALUES (?, 'GOODS_RECEIPT', ?, 'DELIVERY_NOTE', 'image/jpeg', 1000, ?, ?, 'AVAILABLE', 1000,
       NOW(6), NOW(6), NOW(6), ?)`,
    [id, randomId(), 'a'.repeat(64), `attachments/${id.toString('hex')}`, createdBy],
  );
  return id;
}

interface World {
  readonly user: Buffer;
  readonly archive: Buffer;
  readonly volume: Buffer;
}

async function insertArchive(
  conn: PoolConnection,
  user: Buffer,
  over: { start?: string; granularity?: string; minAgeDays?: number; status?: string } = {},
): Promise<Buffer> {
  const id = randomId();
  await conn.query(
    `INSERT INTO attachments_archives (id, granularity, period_start, period_end, cutoff_at, min_age_days,
       volume_max_bytes, retention_years, file_count, files_bytes, status, created_by)
     VALUES (?, ?, ?, DATE_ADD(?, INTERVAL 3 MONTH), NOW(6), ?, 536870912, 5, 1, 1000, ?, ?)`,
    [
      id,
      over.granularity ?? 'QUARTER',
      over.start ?? '2031-07-01',
      over.start ?? '2031-07-01',
      over.minAgeDays ?? 30,
      over.status ?? 'READY',
      user,
    ],
  );
  return id;
}

async function insertVolume(conn: PoolConnection, archive: Buffer, seq = 1): Promise<Buffer> {
  const id = randomId();
  await conn.query(
    `INSERT INTO attachments_archive_volumes (id, archive_id, seq, category, month_start, part, file_name, file_count,
       files_bytes, zip_bytes)
     VALUES (?, ?, ?, 'RECEPTION', '2031-07-01', 1, ?, 1, 1000, 1500)`,
    [id, archive, seq, `GIC-photos_2031-07_RECEPTION_20310801_${seq}.zip`],
  );
  return id;
}

async function insertItem(
  conn: PoolConnection,
  world: World,
  attachment: Buffer,
  archive: Buffer = world.archive,
  volume: Buffer = world.volume,
): Promise<void> {
  await conn.query(
    `INSERT INTO attachments_archive_items (archive_id, attachment_id, volume_id, entry_path, category, owner_type,
       owner_id, reference, kind, mime_type, size_bytes, sha256, captured_at, submitted_at)
     VALUES (?, ?, ?, ?, 'RECEPTION', 'GOODS_RECEIPT', ?, 'RC-1', 'DELIVERY_NOTE', 'image/jpeg', 1000, ?, NOW(6), NOW(6))`,
    [
      archive,
      attachment,
      volume,
      `RECEPTION/2031-07/RC-1_${attachment.toString('hex').slice(-8)}.jpg`,
      randomId(),
      'a'.repeat(64),
    ],
  );
}

async function world(conn: PoolConnection): Promise<World> {
  const user = await insertUser(conn);
  const archive = await insertArchive(conn, user);
  const volume = await insertVolume(conn, archive);
  return { user, archive, volume };
}

describe('attachments_archives', () => {
  it('le plancher de 30 jours est aussi une contrainte de la base', async () => {
    await withRollback(async (conn) => {
      const user = await insertUser(conn);
      await expect(insertArchive(conn, user, { minAgeDays: 29 })).rejects.toThrow(
        /ck_attachments_archives_min_age/,
      );
      await expect(insertArchive(conn, user, { minAgeDays: 30 })).resolves.toBeDefined();
    });
  });

  it('refuse une période ou un statut hors liste', async () => {
    await withRollback(async (conn) => {
      const user = await insertUser(conn);
      await expect(insertArchive(conn, user, { granularity: 'WEEK' })).rejects.toThrow(
        /ck_attachments_archives_granularity/,
      );
      await expect(insertArchive(conn, user, { status: 'DONE' })).rejects.toThrow(
        /ck_attachments_archives_status/,
      );
    });
  });

  it('un seul plan vivant par période, mais un autre une fois le premier terminé ou annulé', async () => {
    await withRollback(async (conn) => {
      const user = await insertUser(conn);
      const first = await insertArchive(conn, user);
      await expect(insertArchive(conn, user)).rejects.toThrow(/uq_attachments_archives_live/);
      // une autre période, ou une autre échelle : autorisées
      await expect(insertArchive(conn, user, { start: '2031-10-01' })).resolves.toBeDefined();
      await expect(insertArchive(conn, user, { granularity: 'MONTH' })).resolves.toBeDefined();
      await conn.query(
        "UPDATE attachments_archives SET status = 'CANCELLED', cancelled_at = NOW(6), cancelled_by = ? WHERE id = ?",
        [user, first],
      );
      await expect(insertArchive(conn, user)).resolves.toBeDefined();
    });
  });

  it('seuls le statut et ses dates sont modifiables ; un plan terminé ne change plus', async () => {
    await withRollback(async (conn) => {
      const user = await insertUser(conn);
      const archive = await insertArchive(conn, user);
      await expect(
        conn.query('UPDATE attachments_archives SET file_count = 99 WHERE id = ?', [archive]),
      ).rejects.toThrow(/seuls le statut et ses dates/);
      await expect(
        conn.query('UPDATE attachments_archives SET min_age_days = 1 WHERE id = ?', [archive]),
      ).rejects.toThrow();
      await conn.query(
        "UPDATE attachments_archives SET status = 'COMPLETED', completed_at = NOW(6) WHERE id = ?",
        [archive],
      );
      await expect(
        conn.query(
          "UPDATE attachments_archives SET status = 'READY', completed_at = NULL WHERE id = ?",
          [archive],
        ),
      ).rejects.toThrow(/terminé ou annulé ne change plus/);
    });
  });

  it('aucune suppression physique', async () => {
    await withRollback(async (conn) => {
      const user = await insertUser(conn);
      const archive = await insertArchive(conn, user);
      await expect(
        conn.query('DELETE FROM attachments_archives WHERE id = ?', [archive]),
      ).rejects.toThrow(/suppression physique interdite/);
    });
  });
});

describe('attachments_archive_volumes', () => {
  it('un rang et un nom de fichier uniques dans le plan', async () => {
    await withRollback(async (conn) => {
      const w = await world(conn);
      await expect(insertVolume(conn, w.archive, 1)).rejects.toThrow(
        /uq_attachments_archive_volumes_seq/,
      );
      await expect(
        conn.query(
          `INSERT INTO attachments_archive_volumes (id, archive_id, seq, category, month_start, part, file_name, file_count, files_bytes, zip_bytes)
           VALUES (?, ?, 2, 'DEPENSE', '2031-08-01', 1, ?, 1, 10, 20)`,
          [randomId(), w.archive, 'GIC-photos_2031-07_RECEPTION_20310801_1.zip'],
        ),
      ).rejects.toThrow(/uq_attachments_archive_volumes_name/);
    });
  });

  it('une catégorie hors liste est refusée', async () => {
    await withRollback(async (conn) => {
      const w = await world(conn);
      await expect(
        conn.query(
          `INSERT INTO attachments_archive_volumes (id, archive_id, seq, category, month_start, part, file_name, file_count, files_bytes, zip_bytes)
           VALUES (?, ?, 2, 'AUTRE', '2031-08-01', 1, 'x.zip', 1, 10, 20)`,
          [randomId(), w.archive],
        ),
      ).rejects.toThrow(/ck_attachments_archive_volumes_category/);
    });
  });

  it('la livraison, la vérification et la résolution évoluent ; le reste est figé', async () => {
    await withRollback(async (conn) => {
      const w = await world(conn);
      await conn.query(
        `UPDATE attachments_archive_volumes SET deliveries = 1, zip_sha256 = ?, first_delivered_at = NOW(6),
           last_delivered_at = NOW(6), last_delivered_by = ?, verified_at = NOW(6), verified_by = ?,
           resolved_at = NOW(6), resolved_by = ? WHERE id = ?`,
        ['b'.repeat(64), w.user, w.user, w.user, w.volume],
      );
      // l'empreinte suit la dernière livraison complète
      await conn.query('UPDATE attachments_archive_volumes SET zip_sha256 = ? WHERE id = ?', [
        'c'.repeat(64),
        w.volume,
      ]);
      await expect(
        conn.query('UPDATE attachments_archive_volumes SET zip_bytes = 1 WHERE id = ?', [w.volume]),
      ).rejects.toThrow(/seule la livraison est modifiable/);
      await expect(
        conn.query("UPDATE attachments_archive_volumes SET file_name = 'autre.zip' WHERE id = ?", [
          w.volume,
        ]),
      ).rejects.toThrow();
      await expect(
        conn.query('DELETE FROM attachments_archive_volumes WHERE id = ?', [w.volume]),
      ).rejects.toThrow(/suppression physique interdite/);
    });
  });
});

describe('attachments_archive_items', () => {
  it('une photo prévue ou vidée n’est couverte que par un seul élément ; libérée, elle peut être reprise', async () => {
    await withRollback(async (conn) => {
      const w = await world(conn);
      const attachment = await insertAttachment(conn, w.user);
      await insertItem(conn, w, attachment);
      const otherArchive = await insertArchive(conn, w.user, { start: '2031-10-01' });
      const otherVolume = await insertVolume(conn, otherArchive);
      await expect(insertItem(conn, w, attachment, otherArchive, otherVolume)).rejects.toThrow(
        /uq_attachments_archive_items_held/,
      );
      await conn.query(
        "UPDATE attachments_archive_items SET state = 'RELEASED', resolved_at = NOW(6), release_reason = 'OPEN_OPERATION' WHERE archive_id = ? AND attachment_id = ?",
        [w.archive, attachment],
      );
      await expect(
        insertItem(conn, w, attachment, otherArchive, otherVolume),
      ).resolves.toBeUndefined();
    });
  });

  it('la résolution est cohérente : vidée avec sa date, libérée avec son motif', async () => {
    await withRollback(async (conn) => {
      const w = await world(conn);
      const attachment = await insertAttachment(conn, w.user);
      await insertItem(conn, w, attachment);
      const where = [w.archive, attachment];
      await expect(
        conn.query(
          "UPDATE attachments_archive_items SET state = 'PURGED' WHERE archive_id = ? AND attachment_id = ?",
          where,
        ),
      ).rejects.toThrow(/ck_attachments_archive_items_resolution/);
      await expect(
        conn.query(
          "UPDATE attachments_archive_items SET state = 'RELEASED', resolved_at = NOW(6) WHERE archive_id = ? AND attachment_id = ?",
          where,
        ),
      ).rejects.toThrow(/ck_attachments_archive_items_resolution/);
      await conn.query(
        "UPDATE attachments_archive_items SET state = 'PURGED', resolved_at = NOW(6) WHERE archive_id = ? AND attachment_id = ?",
        where,
      );
    });
  });

  it('une photo résolue ne change plus, et ses données de trace sont figées', async () => {
    await withRollback(async (conn) => {
      const w = await world(conn);
      const attachment = await insertAttachment(conn, w.user);
      await insertItem(conn, w, attachment);
      const where = [w.archive, attachment];
      await expect(
        conn.query(
          "UPDATE attachments_archive_items SET entry_path = 'autre.jpg' WHERE archive_id = ? AND attachment_id = ?",
          where,
        ),
      ).rejects.toThrow(/seule la résolution est modifiable/);
      await conn.query(
        "UPDATE attachments_archive_items SET state = 'PURGED', resolved_at = NOW(6) WHERE archive_id = ? AND attachment_id = ?",
        where,
      );
      await expect(
        conn.query(
          "UPDATE attachments_archive_items SET state = 'RELEASED', release_reason = 'CHANGED' WHERE archive_id = ? AND attachment_id = ?",
          where,
        ),
      ).rejects.toThrow(/photo résolue ne change plus/);
      await expect(
        conn.query(
          'DELETE FROM attachments_archive_items WHERE archive_id = ? AND attachment_id = ?',
          where,
        ),
      ).rejects.toThrow(/suppression physique interdite/);
    });
  });

  it('la ligne de la pièce n’est jamais touchée : elle reste AVAILABLE et ne se supprime pas', async () => {
    await withRollback(async (conn) => {
      const w = await world(conn);
      const attachment = await insertAttachment(conn, w.user);
      await insertItem(conn, w, attachment);
      await conn.query(
        "UPDATE attachments_archive_items SET state = 'PURGED', resolved_at = NOW(6) WHERE archive_id = ? AND attachment_id = ?",
        [w.archive, attachment],
      );
      const [rows] = await conn.query<RowDataPacket[]>(
        'SELECT upload_status FROM attachments_attachments WHERE id = ?',
        [attachment],
      );
      expect(rows[0]!.upload_status).toBe('AVAILABLE');
      await expect(
        conn.query('DELETE FROM attachments_attachments WHERE id = ?', [attachment]),
      ).rejects.toThrow(/suppression physique interdite/);
    });
  });
});
