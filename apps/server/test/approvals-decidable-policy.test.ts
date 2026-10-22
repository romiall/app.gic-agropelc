/**
 * MP-12 (AV-318) — choix de la politique de contrôle qui s'applique à un fait. Une version révisée sans
 * approbateur (`requires_approval` faux) ne se décide pas : retenue, elle créerait une demande que
 * personne ne peut traiter. Hors ligne, une politique révisée entre la réalité et l'envoi ne rend pas un
 * fait accompli inacceptable : repli sur la politique en vigueur à la réception (BR-SYN-007). Type
 * `RECEIPT_VALUE` : aucun appelant ni politique semée, donc aucune politique laissée par un autre test.
 * Transactions annulées (la table est partagée et jamais purgée).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { UnitOfWork } from '../src/platform/unit-of-work.js';
import { toBin } from '../src/platform/kysely/uuid-columns.js';
import {
  decidablePolicyFor,
  isDecidablePolicy,
  type ActiveControlPolicy,
} from '../src/modules/approvals/application/public/index.js';
import { closeTestDb, db, freshUuid, insertTestUser, withTestUow } from './helpers.js';

const TYPE = 'RECEIPT_VALUE';
const APPROVER = 'procurement.receipt_exception.approve';
const at = (isoDay: string) => new Date(`${isoDay}T09:00:00.000Z`);

describe('MP-12 — politique qui se décide (AV-318)', () => {
  let userId: string;

  beforeAll(async () => {
    userId = await db.transaction().execute((trx) => insertTestUser(trx));
  });

  afterAll(async () => {
    await closeTestDb();
  });

  async function insertPolicy(
    uow: UnitOfWork,
    input: { readonly validFrom: Date; readonly requiresApproval: boolean },
  ): Promise<string> {
    const id = freshUuid();
    await uow
      .insertInto('approvals_control_policies')
      .values({
        id: toBin(id),
        code: `MP12_${id.slice(-12)}`,
        version: 1,
        operation_type: TYPE,
        condition: JSON.stringify({}),
        requires_approval: input.requiresApproval ? 1 : 0,
        approver_permission: input.requiresApproval ? APPROVER : null,
        approver_scope: 'ALL',
        valid_from: input.validFrom,
        status: 'ACTIVE',
        created_by: toBin(userId),
      })
      .execute();
    return id;
  }

  it('isDecidablePolicy : validation exigée et approbateur nommé', () => {
    const base: ActiveControlPolicy = {
      id: 'p',
      code: 'C',
      version: 1,
      operationType: TYPE,
      condition: {},
      requiresPhoto: false,
      requiresComment: false,
      requiresApproval: true,
      approverPermission: APPROVER,
      approverScope: 'ALL',
    };
    expect(isDecidablePolicy(base)).toBe(true);
    expect(isDecidablePolicy({ ...base, requiresApproval: false })).toBe(false);
    expect(isDecidablePolicy({ ...base, approverPermission: null })).toBe(false);
  });

  it('la plus récente qui se décide : une version sans approbateur plus récente est ignorée', () =>
    withTestUow(async (uow) => {
      const older = await insertPolicy(uow, {
        validFrom: at('2031-01-01'),
        requiresApproval: true,
      });
      await insertPolicy(uow, { validFrom: at('2031-03-01'), requiresApproval: false });
      const found = await decidablePolicyFor(uow, TYPE, at('2031-06-01'));
      expect(found?.id).toBe(older);
    }));

  it('une version plus récente qui se décide passe devant', () =>
    withTestUow(async (uow) => {
      await insertPolicy(uow, { validFrom: at('2031-01-01'), requiresApproval: true });
      const newer = await insertPolicy(uow, {
        validFrom: at('2031-03-01'),
        requiresApproval: true,
      });
      const found = await decidablePolicyFor(uow, TYPE, at('2031-06-01'));
      expect(found?.id).toBe(newer);
    }));

  it('aucune politique qui se décide : indéfini', () =>
    withTestUow(async (uow) => {
      await insertPolicy(uow, { validFrom: at('2031-01-01'), requiresApproval: false });
      expect(await decidablePolicyFor(uow, TYPE, at('2031-06-01'))).toBeUndefined();
    }));

  it('fait constaté avant l’entrée en vigueur : refusé en ligne, repli sur la réception hors ligne', () =>
    withTestUow(async (uow) => {
      const policy = await insertPolicy(uow, {
        validFrom: at('2031-03-01'),
        requiresApproval: true,
      });
      const fact = at('2031-02-01');
      const received = at('2031-04-01');
      expect(await decidablePolicyFor(uow, TYPE, fact)).toBeUndefined();
      expect((await decidablePolicyFor(uow, TYPE, fact, received))?.id).toBe(policy);
      // Le repli lui-même exige une politique qui se décide.
      expect(await decidablePolicyFor(uow, TYPE, fact, at('2031-02-15'))).toBeUndefined();
    }));

  it('le repli ne remplace pas une politique déjà en vigueur au moment du fait', () =>
    withTestUow(async (uow) => {
      const atFact = await insertPolicy(uow, {
        validFrom: at('2031-01-01'),
        requiresApproval: true,
      });
      await insertPolicy(uow, { validFrom: at('2031-03-01'), requiresApproval: true });
      const found = await decidablePolicyFor(uow, TYPE, at('2031-02-01'), at('2031-04-01'));
      expect(found?.id).toBe(atFact);
    }));
});
