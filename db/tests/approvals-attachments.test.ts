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

describe('approvals_control_policies', () => {
  it('exige approver_permission dès que requires_approval est vrai', async () => {
    await withRollback(async (conn) => {
      const admin = await insertAdmin(conn);
      await expect(
        conn.query(
          `INSERT INTO approvals_control_policies (id, code, operation_type, \`condition\`, requires_approval, valid_from, created_by)
           VALUES (?, 'POL1', 'EXPENSE', JSON_OBJECT(), TRUE, NOW(6), ?)`,
          [randomId(), admin],
        ),
      ).rejects.toThrow(/ck_approvals_control_policies_requires_approval/);
    });
  });

  it('accepte le statut puis refuse une modification hors liste blanche (versionnement, BR-ADM-016)', async () => {
    await withRollback(async (conn) => {
      const admin = await insertAdmin(conn);
      await conn.query(
        `INSERT INTO identity_permissions (code, module, description, supported_scopes) VALUES ('inventory.loss.approve', 'inventory', 'desc', JSON_ARRAY('SITE'))`,
      );
      const policyId = randomId();
      await conn.query(
        `INSERT INTO approvals_control_policies (id, code, operation_type, \`condition\`, requires_approval, approver_permission, valid_from, created_by)
         VALUES (?, 'POL1', 'EXPENSE', JSON_OBJECT(), TRUE, 'inventory.loss.approve', NOW(6), ?)`,
        [policyId, admin],
      );
      await conn.query("UPDATE approvals_control_policies SET status = 'RETIRED' WHERE id = ?", [
        policyId,
      ]);
      await expect(
        conn.query('UPDATE approvals_control_policies SET requires_approval = FALSE WHERE id = ?', [
          policyId,
        ]),
      ).rejects.toThrow(/seuls status et valid_to/);
    });
  });
});

describe('approvals_approval_requests', () => {
  it("refuse une seconde demande PENDING pour le même sujet et type d'opération", async () => {
    await withRollback(async (conn) => {
      const admin = await insertAdmin(conn);
      const subjectId = randomId();
      await conn.query(
        `INSERT INTO approvals_approval_requests (id, operation_type, subject_type, subject_id, subject_summary, requested_by, requested_at, required_attachment_ids, created_by)
         VALUES (?, 'EXPENSE', 'finance.expense', ?, 'Dépense 10 000 XAF', ?, NOW(6), JSON_ARRAY(), ?)`,
        [randomId(), subjectId, admin, admin],
      );
      await expect(
        conn.query(
          `INSERT INTO approvals_approval_requests (id, operation_type, subject_type, subject_id, subject_summary, requested_by, requested_at, required_attachment_ids, created_by)
           VALUES (?, 'EXPENSE', 'finance.expense', ?, 'Doublon', ?, NOW(6), JSON_ARRAY(), ?)`,
          [randomId(), subjectId, admin, admin],
        ),
      ).rejects.toThrow(/uq_approvals_approval_requests_active_pending/);
    });
  });

  it('rejette un approbateur identique au demandeur sauf self_approved (INV-ADM-02)', async () => {
    await withRollback(async (conn) => {
      const admin = await insertAdmin(conn);
      await expect(
        conn.query(
          `INSERT INTO approvals_approval_requests
             (id, operation_type, subject_type, subject_id, subject_summary, requested_by, requested_at, required_attachment_ids, status, decided_by, decided_at, created_by)
           VALUES (?, 'EXPENSE', 'finance.expense', ?, 'Auto-validation', ?, NOW(6), JSON_ARRAY(), 'APPROVED', ?, NOW(6), ?)`,
          [randomId(), randomId(), admin, admin, admin],
        ),
      ).rejects.toThrow(/ck_approvals_approval_requests_self_approval/);
    });
  });

  it('devient immuable après décision (SM-APPROVAL)', async () => {
    await withRollback(async (conn) => {
      const admin = await insertAdmin(conn);
      const approver = await insertAdmin(conn);
      const requestId = randomId();
      await conn.query(
        `INSERT INTO approvals_approval_requests (id, operation_type, subject_type, subject_id, subject_summary, requested_by, requested_at, required_attachment_ids, created_by)
         VALUES (?, 'EXPENSE', 'finance.expense', ?, 'Dépense', ?, NOW(6), JSON_ARRAY(), ?)`,
        [requestId, randomId(), admin, admin],
      );
      await conn.query(
        "UPDATE approvals_approval_requests SET status = 'APPROVED', decided_by = ?, decided_at = NOW(6) WHERE id = ?",
        [approver, requestId],
      );
      await expect(
        conn.query(
          "UPDATE approvals_approval_requests SET decision_comment = 'trop tard' WHERE id = ?",
          [requestId],
        ),
      ).rejects.toThrow(/immuable après décision/);
      await expect(
        conn.query('DELETE FROM approvals_approval_requests WHERE id = ?', [requestId]),
      ).rejects.toThrow(/suppression physique interdite/);
    });
  });
});

describe('attachments_attachments', () => {
  it('rejette une pièce jointe de plus de 5 Mo', async () => {
    await withRollback(async (conn) => {
      const admin = await insertAdmin(conn);
      await expect(
        conn.query(
          `INSERT INTO attachments_attachments (id, owner_type, owner_id, kind, mime_type, size_bytes, sha256, captured_at, occurred_at, created_by)
           VALUES (?, 'inventory.loss_declaration', ?, 'PHOTO', 'image/jpeg', 6000000, REPEAT('a', 64), NOW(6), NOW(6), ?)`,
          [randomId(), randomId(), admin],
        ),
      ).rejects.toThrow(/ck_attachments_attachments_size/);
    });
  });

  it("autorise la mise à jour du cycle de vie de l'upload puis refuse le reste", async () => {
    await withRollback(async (conn) => {
      const admin = await insertAdmin(conn);
      const attachmentId = randomId();
      await conn.query(
        `INSERT INTO attachments_attachments (id, owner_type, owner_id, kind, mime_type, size_bytes, sha256, captured_at, occurred_at, created_by)
         VALUES (?, 'inventory.loss_declaration', ?, 'PHOTO', 'image/jpeg', 100000, REPEAT('a', 64), NOW(6), NOW(6), ?)`,
        [attachmentId, randomId(), admin],
      );
      await conn.query(
        "UPDATE attachments_attachments SET upload_status = 'AVAILABLE', uploaded_bytes = 100000, storage_key = 'k1' WHERE id = ?",
        [attachmentId],
      );
      await expect(
        conn.query('UPDATE attachments_attachments SET mime_type = ? WHERE id = ?', [
          'image/png',
          attachmentId,
        ]),
      ).rejects.toThrow(/cycle de vie de l'upload/);
      await expect(
        conn.query('DELETE FROM attachments_attachments WHERE id = ?', [attachmentId]),
      ).rejects.toThrow(/suppression physique interdite/);
    });
  });
});
