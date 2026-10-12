import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDb, type OutboxCommand } from '../../storage/db.js';
import {
  ALLOCATION_ID,
  allocationRow,
  CASH_SESSION_ID,
  CASH_TRANSFER_ID,
  cashSessionRow,
  cashTransferRow,
  IDS,
  meSettingRow,
  pointOfSaleRow,
  posCashAccountRow,
  seedSalesFixtures,
} from './fixtures.js';
import { loadSalesReferences } from './references.js';
import { settingValue } from './stock.js';

const NOW = new Date('2026-10-10T09:00:00.000Z');

function financeCommand(): OutboxCommand {
  return {
    command_id: '01900000-0000-7000-8000-0000000000c1',
    device_seq: 1,
    command_type: 'finance.cash_session.open',
    command_version: 1,
    author_user_id: IDS.user,
    aggregate_type: 'CASH_SESSION',
    aggregate_id: '01900000-0000-7000-8000-0000000000c2',
    base_version: null,
    depends_on: [],
    occurred_at: '2026-10-10T06:00:00.000Z',
    client_created_at: '2026-10-10T06:00:00.000Z',
    captured_offline: true,
    backdated_reason: null,
    attachment_ids: [],
    payload: { cashAccountId: IDS.cash, countedXaf: 20_000 },
    status: 'LOCAL_ONLY',
    attempts: 0,
    next_attempt_at: null,
    last_error: null,
    server_refs: null,
  };
}

describe('Référentiels de l’appareil : jeux de P5-18', () => {
  beforeEach(async () => {
    const db = getDb();
    await db.projections.clear();
    await db.outbox.clear();
    await db.syncCursors.clear();
    await seedSalesFixtures(db);
  });

  afterEach(async () => {
    const db = getDb();
    await db.projections.clear();
    await db.outbox.clear();
    await db.syncCursors.clear();
  });

  it('quotas, sessions de caisse, remises, destinations et PDV lus avec leurs curseurs', async () => {
    const db = getDb();
    await db.projections.bulkPut([
      allocationRow(),
      posCashAccountRow(),
      cashSessionRow(),
      cashTransferRow(),
      {
        key: `cash:CASH_TRANSFER_TARGET:${IDS.momo}`,
        dataset: 'cash',
        entity_type: 'CASH_TRANSFER_TARGET',
        entity_id: IDS.momo,
        scope_type: 'GLOBAL',
        scope_id: null,
        row_version: 1,
        seq: 1,
        data: {
          id: IDS.momo,
          code: 'MOMO-ORANGE',
          name: 'Orange Money entreprise',
          account_type: 'MOBILE_MONEY',
          site_id: null,
        },
      },
      pointOfSaleRow({ replenishment_source_location_id: IDS.mobile }),
    ]);
    await db.syncCursors.bulkPut([
      { dataset: 'allocations', cursor: 12, pulled_at: '2026-10-10T08:00:00.000Z' },
      { dataset: 'cash', cursor: 7, pulled_at: '2026-10-10T08:30:00.000Z' },
    ]);
    await db.outbox.add(financeCommand());

    const refs = await loadSalesReferences(db);
    expect(refs.allocations.map((allocation) => allocation.id)).toEqual([ALLOCATION_ID]);
    expect(refs.allocations[0]?.quantity_remaining).toBe('40.000');
    expect(refs.allocationsPulledAt).toBe('2026-10-10T08:00:00.000Z');
    expect(refs.cashSessions.map((session) => session.id)).toEqual([CASH_SESSION_ID]);
    expect(refs.cashTransfers.map((transfer) => transfer.id)).toEqual([CASH_TRANSFER_ID]);
    expect(refs.cashTransferTargets.map((target) => target.code)).toEqual(['MOMO-ORANGE']);
    expect(refs.cashPulledAt).toBe('2026-10-10T08:30:00.000Z');
    expect(refs.pointsOfSale.get(IDS.site)).toMatchObject({
      sales_location_id: IDS.pos,
      replenishment_source_location_id: IDS.mobile,
    });
    expect(
      refs.cashAccounts.find((account) => account.account_type === 'CAISSE_PDV'),
    ).toMatchObject({ balance_xaf: 20_000 });
    // Les commandes de caisse et de remise font partie de l'outbox lue par les écrans.
    expect(refs.outbox.map((command) => command.command_type)).toContain(
      'finance.cash_session.open',
    );
  });

  it('paramètres de `me` et motifs de `catalog` réunis aux anciens jeux, nouveaux d’abord', async () => {
    const db = getDb();
    await db.projections.bulkPut([
      // Valeur semée publiée dans `me` (P5-18), absente de l'ancien jeu `setting`.
      meSettingRow('offline.max_autonomy_hours', 168),
      meSettingRow('sales.offline_over_allocation_allowed', true, { type: 'SITE', id: IDS.site }),
      {
        key: 'catalog:REASON_CODE:r-catalog',
        dataset: 'catalog',
        entity_type: 'REASON_CODE',
        entity_id: 'r-catalog',
        scope_type: 'GLOBAL',
        scope_id: null,
        row_version: 1,
        seq: 1,
        data: {
          id: 'r-catalog',
          category: 'LOSS',
          code: 'CASSE',
          label: 'Casse',
          loss_category: 'CASSE',
          requires_comment: false,
          is_active: true,
        },
      },
    ]);
    const refs = await loadSalesReferences(db);
    expect(settingValue(refs.settings, 'offline.max_autonomy_hours', null, NOW)).toBe(168);
    expect(
      settingValue(refs.settings, 'sales.offline_over_allocation_allowed', IDS.site, NOW),
    ).toBe(true);
    // Motif semé (catalog) et motif de l'ancien jeu (fixture) tous deux proposés.
    expect(refs.reasonCodes.map((reason) => reason.id)).toEqual(
      expect.arrayContaining(['r-catalog', IDS.reason]),
    );
  });

  it('réglage du site nul : le réglage global s’applique, comme au serveur', () => {
    const settings = [
      {
        id: 'g',
        key: 'sales.offline_over_allocation_allowed',
        value: true,
        scope_type: 'GLOBAL',
        scope_id: null,
        valid_from: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 's',
        key: 'sales.offline_over_allocation_allowed',
        value: null,
        scope_type: 'SITE',
        scope_id: IDS.site,
        valid_from: '2026-02-01T00:00:00.000Z',
      },
    ];
    expect(settingValue(settings, 'sales.offline_over_allocation_allowed', IDS.site, NOW)).toBe(
      true,
    );
  });
});
