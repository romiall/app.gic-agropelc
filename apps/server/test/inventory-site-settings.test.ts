/**
 * P9-25 (AL-1) : lecture des réglages d'`inventory` par site (`transferUnmatchedHours`,
 * `blindReceiptMatchMode`) — une valeur de site inexploitable cède au réglage global, jamais au repli du
 * domaine. Les lignes GLOBAL et SITE sont datées de 2020 et lues à une date de 2020 : aucune ligne semée
 * (datée du jour du semis) n'est alors en vigueur, quelle que soit la date du semis. Transactions annulées.
 */
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  blindReceiptMatchMode,
  transferUnmatchedHours,
} from '../src/modules/inventory/application/transfer-matching.js';
import { jsonValue } from '../src/platform/kysely/json-value.js';
import type { UnitOfWork } from '../src/platform/unit-of-work.js';
import { toBin } from '../src/platform/kysely/uuid-columns.js';
import { rolledBack } from './communication-test-kit.js';
import {
  closeTestDb,
  freshUuid,
  insertTestSite,
  insertTestUser,
  insertTestZone,
} from './helpers.js';

vi.setConfig({ testTimeout: 120_000 });

afterAll(closeTestDb);

const AT = new Date('2020-11-10T08:00:00.000Z');

async function putSetting(
  uow: UnitOfWork,
  admin: string,
  key: string,
  value: unknown,
  siteId: string | null,
) {
  await uow
    .insertInto('organization_system_settings')
    .values({
      id: toBin(freshUuid()),
      key,
      value: jsonValue(value),
      scope_type: siteId === null ? 'GLOBAL' : 'SITE',
      scope_id: siteId === null ? null : toBin(siteId),
      valid_from: new Date('2020-11-01T00:00:00.000Z'),
      is_client_visible: 0,
      reason: 'Réglage de test AL-1',
      created_by: toBin(admin),
    })
    .execute();
}

async function newSite(uow: UnitOfWork, admin: string): Promise<string> {
  const zone = await insertTestZone(uow, admin);
  return insertTestSite(uow, admin, zone);
}

describe('réglages de site d’inventory (P9-25, AL-1)', () => {
  it('transferUnmatchedHours : valeur de site inexploitable, le global ; valeur valide, le site', () =>
    rolledBack(async (uow) => {
      const admin = await insertTestUser(uow);
      const key = 'inventory.transfer_unmatched_hours';
      await putSetting(uow, admin, key, 24, null);
      for (const bogus of ['abc', null, 0, -5, true]) {
        const site = await newSite(uow, admin);
        await putSetting(uow, admin, key, bogus, site);
        expect(await transferUnmatchedHours(uow, site, AT)).toBe(24);
      }
      const valid = await newSite(uow, admin);
      await putSetting(uow, admin, key, 12, valid);
      expect(await transferUnmatchedHours(uow, valid, AT)).toBe(12);
    }));

  it('blindReceiptMatchMode : valeur de site inexploitable, le global EXACT ; SUBSET valide, le site', () =>
    rolledBack(async (uow) => {
      const admin = await insertTestUser(uow);
      const key = 'inventory.blind_receipt_match_mode';
      await putSetting(uow, admin, key, 'EXACT', null);
      const bogus = await newSite(uow, admin);
      await putSetting(uow, admin, key, 'bogus', bogus);
      expect(await blindReceiptMatchMode(uow, bogus, AT)).toBe('EXACT');
      const subset = await newSite(uow, admin);
      await putSetting(uow, admin, key, 'SUBSET', subset);
      expect(await blindReceiptMatchMode(uow, subset, AT)).toBe('SUBSET');
      expect(await blindReceiptMatchMode(uow, null, AT)).toBe('EXACT');
    }));
});
