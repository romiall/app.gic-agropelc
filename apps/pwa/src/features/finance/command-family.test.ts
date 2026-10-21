import { describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { getDb, type OutboxCommand } from '../../storage/db.js';
import { familyReloadKey, useCommandFamily, useCommandFamilyState } from './command-family.js';

// Le module importe la file d'envoi, qui charge le moteur de synchronisation.
vi.mock('../sync/sync-engine-instance.js', () => ({ getSyncEngine: () => undefined }));

const USER = '01900000-0000-7000-8000-000000000001';
const OTHER = '01900000-0000-7000-8000-000000000002';

const command = (overrides: Partial<OutboxCommand>): OutboxCommand =>
  ({
    command_id: 'c1',
    command_type: 'finance.supplier_payment.cancel',
    author_user_id: USER,
    status: 'PENDING',
    device_seq: 1,
    ...overrides,
  }) as OutboxCommand;

describe('clé de relecture d’une famille d’opérations (P8E-05, P8E-06)', () => {
  it('chaque opération de l’utilisateur et sa phase ; celles d’un autre auteur ne comptent pas', () => {
    const waiting = familyReloadKey([command({})], USER);
    expect(waiting).toBe('c1:WAITING');
    // Réponse reçue : la clé change, l'écran relit.
    expect(familyReloadKey([command({ status: 'SYNCED' })], USER)).not.toBe(waiting);
    // Opération d'un autre utilisateur de la tablette : sans effet.
    expect(
      familyReloadKey([command({}), command({ command_id: 'c2', author_user_id: OTHER })], USER),
    ).toBe(waiting);
    // Nouvelle opération : la clé change.
    expect(familyReloadKey([command({}), command({ command_id: 'c3', device_seq: 2 })], USER)).toBe(
      'c1:WAITING,c3:WAITING',
    );
    expect(familyReloadKey([command({})], undefined)).toBe('');
  });

  it('l’outbox pas encore lue se distingue d’une outbox vide ; seules les opérations de la famille', async () => {
    await getDb().outbox.clear();
    await getDb().outbox.bulkPut([
      command({ command_id: 'a', command_type: 'sales.payment.record', device_seq: 1 }),
      command({ command_id: 'b', command_type: 'sales.sale.create', device_seq: 2 }),
    ]);
    const state = renderHook(() => useCommandFamilyState('sales.payment.'));
    expect(state.result.current).toBeUndefined();
    await waitFor(() =>
      expect(state.result.current?.map((item) => item.command_id)).toEqual(['a']),
    );
    // Sans lecture, la version simple rend une liste vide, jamais `undefined`.
    const simple = renderHook(() => useCommandFamily('sales.payment.'));
    expect(simple.result.current).toEqual([]);
    await waitFor(() => expect(simple.result.current).toHaveLength(1));
    const none = renderHook(() => useCommandFamily('finance.nothing.'));
    await waitFor(() => expect(none.result.current).toEqual([]));
    await getDb().outbox.clear();
  });
});
