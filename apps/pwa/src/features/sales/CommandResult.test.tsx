import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { getDb, type OutboxCommand } from '../../storage/db.js';
import { CommandResult } from './CommandResult.js';

vi.mock('../sync/sync-engine-instance.js', () => ({ getSyncEngine: () => undefined }));

function accepted(id: string, warnings?: readonly string[]): OutboxCommand {
  return {
    command_id: id,
    device_seq: 1,
    command_type: 'procurement.receipt.record',
    command_version: 1,
    author_user_id: 'u',
    aggregate_type: 'GOODS_RECEIPT',
    aggregate_id: `r-${id}`,
    base_version: null,
    depends_on: [],
    occurred_at: '2026-10-10T08:00:00.000Z',
    client_created_at: '2026-10-10T08:00:00.000Z',
    captured_offline: true,
    backdated_reason: null,
    attachment_ids: [],
    payload: {},
    status: 'SYNCED_WITH_WARNING',
    attempts: 1,
    next_attempt_at: null,
    last_error: null,
    server_refs: { docNumber: 'REC-1' },
    synced_at: '2026-10-10T08:30:00.000Z',
    ...(warnings ? { warnings } : {}),
  };
}

describe('Résultat d’une opération : avertissement du serveur', () => {
  afterEach(async () => {
    cleanup();
    await getDb().outbox.clear();
  });

  it('libellé propre à l’avertissement (quarantaine), sinon libellé générique', async () => {
    await getDb().outbox.bulkPut([
      accepted('quarantine', ['RECEIPT_QUARANTINED']),
      accepted('other', ['STOCK_NEGATIVE']),
    ]);
    render(<CommandResult commandId="quarantine" messages="purchase_receipt.result" />);
    expect(
      await screen.findByText('Réception REC-1 mise en quarantaine pour validation.'),
    ).toBeInTheDocument();
    cleanup();
    render(<CommandResult commandId="other" messages="purchase_receipt.result" />);
    expect(
      await screen.findByText('Réception REC-1 enregistrée, avec un signalement.'),
    ).toBeInTheDocument();
  });
});
