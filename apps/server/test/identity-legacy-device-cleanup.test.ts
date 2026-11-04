/**
 * Refus des appareils en attente dont l'identifiant n'est pas un UUIDv7 (AV-499, ADR-052) : la liste ne retient que
 * ceux-là, la simulation n'écrit rien, le refus passe l'appareil à `BLOCKED` avec son motif, une ligne d'audit
 * `identity.device.block` de l'acteur système, et laisse intact un appareil au format attendu.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { FixedClock, isUuidv7, Uuidv7Generator } from '@gic/domain';
import { toBin } from '../src/platform/kysely/uuid-columns.js';
import {
  blockLegacyPendingDevices,
  LEGACY_DEVICE_REASON,
} from '../src/modules/identity/application/bootstrap-legacy-device-cleanup.js';
import { closeTestDb, db, insertTestDevice, insertTestUser } from './helpers.js';
import { tx } from './cash-transfer-fixtures.js';

const clock = new FixedClock(new Date());
const deps = { clock, idGenerator: new Uuidv7Generator(clock) };

function shortCodeNotUsed(taken: ReadonlySet<string>): string {
  for (;;) {
    const code = Math.floor(Math.random() * 36 ** 4)
      .toString(36)
      .toUpperCase()
      .padStart(4, '0');
    if (!taken.has(code)) return code;
  }
}

describe('AV-499 : refus des appareils en attente à identifiant non conforme', () => {
  afterAll(closeTestDb);

  it('liste sans écrire, puis refuse les seuls appareils nommés, avec audit', async () => {
    const legacyId = randomUUID(); // UUIDv4
    const otherLegacyId = randomUUID();
    const code = shortCodeNotUsed(new Set());
    const otherCode = shortCodeNotUsed(new Set([code]));
    const regularId = await tx(async (trx) => {
      const userId = await insertTestUser(trx);
      const regularId = await insertTestDevice(trx, userId, { status: 'PENDING' });
      for (const [id, shortCode] of [
        [legacyId, code],
        [otherLegacyId, otherCode],
      ] as const) {
        await trx
          .insertInto('identity_devices')
          .values({
            id: toBin(id),
            short_code: shortCode,
            enrolled_by_user_id: toBin(userId),
            status: 'PENDING',
            platform: 'TestScript',
            created_by: toBin(userId),
          })
          .execute();
      }
      return regularId;
    });
    const statusOf = async (id: string) =>
      (
        await db
          .selectFrom('identity_devices')
          .select(['status', 'status_reason'])
          .where('id', '=', toBin(id))
          .executeTakeFirstOrThrow()
      ).status;

    try {
      // Liste : les deux appareils non conformes, jamais l'appareil au format attendu ; rien n'est écrit.
      const listed = await tx((trx) =>
        blockLegacyPendingDevices(trx, deps, { apply: false, shortCodes: [code, otherCode] }),
      );
      expect(listed.kind).toBe('LISTED');
      if (listed.kind !== 'LISTED') return;
      expect(listed.devices.map((device) => device.id).sort()).toEqual(
        [legacyId, otherLegacyId].sort(),
      );
      expect(listed.devices.every((device) => device.platform === 'TestScript')).toBe(true);
      expect(await statusOf(legacyId)).toBe('PENDING');

      // Mode par défaut (aucun code court, simulation : celui de la ligne de commande) : tous les appareils non
      // conformes en attente, jamais celui qui porte un UUIDv7. D'autres essais peuvent avoir laissé des appareils de ce
      // genre sur la base : on cherche les nôtres sans exiger la liste exacte, et sans rien écrire.
      expect(isUuidv7(regularId)).toBe(true);
      const listedAll = await tx((trx) => blockLegacyPendingDevices(trx, deps, { apply: false }));
      expect(listedAll.kind).toBe('LISTED');
      if (listedAll.kind !== 'LISTED') return;
      const listedAllIds = listedAll.devices.map((device) => device.id);
      expect(listedAllIds).toEqual(expect.arrayContaining([legacyId, otherLegacyId]));
      expect(listedAllIds).not.toContain(regularId);
      expect(await statusOf(legacyId)).toBe('PENDING');

      // Refus d'un seul, désigné par son code court (minuscules acceptées).
      const blocked = await tx((trx) =>
        blockLegacyPendingDevices(trx, deps, { apply: true, shortCodes: [code.toLowerCase()] }),
      );
      expect(blocked.kind).toBe('BLOCKED');
      if (blocked.kind !== 'BLOCKED') return;
      expect(blocked.devices.map((device) => device.id)).toEqual([legacyId]);
      const row = await db
        .selectFrom('identity_devices')
        .select(['status', 'status_reason', 'version'])
        .where('id', '=', toBin(legacyId))
        .executeTakeFirstOrThrow();
      expect(row).toMatchObject({ status: 'BLOCKED', status_reason: LEGACY_DEVICE_REASON });
      expect(row.version).toBeGreaterThan(1);
      expect(await statusOf(otherLegacyId)).toBe('PENDING');
      expect(await statusOf(regularId)).toBe('PENDING');

      // Audit : acteur système, action et entité.
      const audit = await db
        .selectFrom('audit_audit_log as a')
        .innerJoin('identity_users as u', 'u.id', 'a.actor_user_id')
        .select(['a.action', 'a.result', 'u.is_system'])
        .where('a.entity_id', '=', toBin(legacyId))
        .where('a.action', '=', 'identity.device.block')
        .execute();
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ result: 'SUCCESS' });
      expect(Number(audit[0]?.is_system)).toBe(1);

      // Rejouer ne change rien (l'appareil n'est plus en attente) : liste vide.
      const again = await tx((trx) =>
        blockLegacyPendingDevices(trx, deps, { apply: true, shortCodes: [code] }),
      );
      expect(again).toMatchObject({ kind: 'LISTED', devices: [] });
    } finally {
      // Hors service : ils ne faussent ni les comptes d'appareils en attente ni les alertes des autres essais.
      for (const id of [otherLegacyId, regularId]) {
        await db
          .updateTable('identity_devices')
          .set({ status: 'RETIRED', status_reason: 'Essai AV-499.' })
          .where('id', '=', toBin(id))
          .where('status', '=', 'PENDING')
          .execute();
      }
      await db
        .updateTable('identity_devices')
        .set({ status: 'RETIRED', status_reason: 'Essai AV-499.' })
        .where('id', '=', toBin(legacyId))
        .execute();
    }
  });
});
