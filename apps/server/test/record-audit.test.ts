import { describe, expect, it } from 'vitest';
import { FixedClock, SystemClock, Uuidv7Generator } from '@gic/domain';
import { recordAudit } from '../src/audit/record-audit.js';
import { toBin } from '../src/platform/kysely/uuid-columns.js';
import { db, insertTestUser, withTestUow } from './helpers.js';

// audit_audit_log est en ajout seul (aucun DELETE accordé à gic_app, cohérent avec
// INV-AUD-01) : la genèse (prev_hash = 64 zéros) n'est vérifiable qu'une seule fois, à
// froid, sur une base neuve — déjà couverte, sans dépendance à une base réelle, par
// audit/hash-chain.test.ts. Ici, on vérifie ce que record-audit.ts ajoute par rapport aux
// fonctions pures : la lecture sous verrou de la *vraie* dernière ligne et son emploi comme
// prev_hash de la suivante, quel que soit l'état déjà présent dans la table.

const OCCURRED_AT = new Date('2026-09-24T10:00:00.000Z');
const realIdGenerator = new Uuidv7Generator(new SystemClock());

function deps(now = new Date('2026-09-24T10:00:01.000Z')) {
  const clock = new FixedClock(now);
  return { idGenerator: new Uuidv7Generator(clock), clock };
}

/**
 * `identity_users` référencée par `audit_audit_log.actor_user_id` (FK) : pour le test de
 * concurrence, l'utilisateur doit être **réellement commité** (deux transactions distinctes
 * doivent le voir), pas seulement présent dans une transaction de test annulée.
 */
async function createRealTestUser(): Promise<string> {
  const id = realIdGenerator.newId();
  const phone = `+2376${Math.floor(1_000_0000 + Math.random() * 8_999_9999)}`;
  await db
    .insertInto('identity_users')
    .values({
      id: toBin(id),
      full_name: 'Test',
      phone,
      password_hash: 'x',
      status: 'ACTIVE',
      created_by: toBin(id),
    })
    .execute();
  return id;
}

describe('recordAudit (07-security-rbac/03-audit.md §5)', () => {
  it('deux entrées consécutives se chaînent : row_hash(1) devient prev_hash(2)', async () => {
    await withTestUow(async (trx) => {
      const admin = await insertTestUser(trx);
      const first = await recordAudit(trx, deps(), {
        occurredAt: OCCURRED_AT,
        actorUserId: admin,
        actorRoles: ['ADMIN'],
        action: 'test.record.create',
        entityType: 'TEST',
        result: 'SUCCESS',
      });
      const second = await recordAudit(trx, deps(), {
        occurredAt: OCCURRED_AT,
        actorUserId: admin,
        actorRoles: ['ADMIN'],
        action: 'test.record.update',
        entityType: 'TEST',
        result: 'SUCCESS',
      });
      expect(second.seq).toBe(first.seq + 1);

      const secondRow = await trx
        .selectFrom('audit_audit_log')
        .select(['prev_hash'])
        .where('id', '=', toBin(second.id))
        .executeTakeFirstOrThrow();
      expect(secondRow.prev_hash).toBe(first.rowHash);
    });
  });

  it('avant/après/motif sont hachés séparément dans la ligne réellement insérée', async () => {
    await withTestUow(async (trx) => {
      const admin = await insertTestUser(trx);
      const recorded = await recordAudit(trx, deps(), {
        occurredAt: OCCURRED_AT,
        actorUserId: admin,
        actorRoles: ['ADMIN'],
        action: 'test.record.update',
        entityType: 'TEST',
        before: { statut: 'A' },
        after: { statut: 'B' },
        reason: 'motif de test',
        result: 'SUCCESS',
      });
      const row = await trx
        .selectFrom('audit_audit_log')
        .select(['before', 'after', 'reason', 'result'])
        .where('id', '=', toBin(recorded.id))
        .executeTakeFirstOrThrow();
      expect(row.before).toEqual({ statut: 'A' });
      expect(row.after).toEqual({ statut: 'B' });
      expect(row.reason).toBe('motif de test');
      expect(row.result).toBe('SUCCESS');
    });
  });

  it('deux insertions concurrentes (verrou) produisent des seq consécutifs sans collision', async () => {
    const admin = await createRealTestUser();
    const [a, b] = await Promise.all([
      db.transaction().execute((trx) =>
        recordAudit(trx, deps(), {
          occurredAt: OCCURRED_AT,
          actorUserId: admin,
          actorRoles: [],
          action: 'test.concurrent.a',
          entityType: 'TEST',
          result: 'SUCCESS',
        }),
      ),
      db.transaction().execute((trx) =>
        recordAudit(trx, deps(), {
          occurredAt: OCCURRED_AT,
          actorUserId: admin,
          actorRoles: [],
          action: 'test.concurrent.b',
          entityType: 'TEST',
          result: 'SUCCESS',
        }),
      ),
    ]);
    expect(a.seq).not.toBe(b.seq);
    expect(Math.abs(a.seq - b.seq)).toBe(1);
  });
});
