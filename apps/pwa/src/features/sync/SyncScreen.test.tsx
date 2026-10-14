import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { getDb, type OutboxCommand } from '../../storage/db.js';
import { countAttention } from '../../sync/outbox.js';
import { SyncScreen } from './SyncScreen.js';

vi.mock('./sync-engine-instance.js', () => ({ getSyncEngine: () => undefined }));
vi.mock('../auth/AuthContext.js', () => ({
  useAuth: () => ({
    state: {
      status: 'unlocked',
      userId: '01900000-0000-7000-8000-000000000001',
      deviceStatus: 'ACTIVE',
    },
    deviceId: '01900000-0000-7000-8000-0000000000d0',
  }),
}));

const ME = '01900000-0000-7000-8000-000000000001';
const OTHER = '01900000-0000-7000-8000-000000000002';
const AT = '2026-10-14T08:00:00.000Z';

function command(
  seq: number,
  overrides: Partial<OutboxCommand> & Pick<OutboxCommand, 'command_type' | 'status'>,
): OutboxCommand {
  return {
    command_id: `01900000-0000-7000-8000-0000000001${String(seq).padStart(2, '0')}`,
    device_seq: seq,
    command_version: 1,
    author_user_id: ME,
    aggregate_type: 'TEST',
    aggregate_id: `01900000-0000-7000-8000-0000000002${String(seq).padStart(2, '0')}`,
    base_version: null,
    depends_on: [],
    occurred_at: AT,
    client_created_at: AT,
    captured_offline: true,
    backdated_reason: null,
    attachment_ids: [],
    payload: {},
    attempts: 1,
    next_attempt_at: null,
    last_error: null,
    server_refs: null,
    ...overrides,
  };
}

describe('Écran de synchronisation : libellés et classement (MP-09)', () => {
  beforeEach(async () => {
    await getDb().outbox.clear();
  });

  afterEach(async () => {
    cleanup();
    await getDb().outbox.clear();
  });

  it('types d’opération en français ; une opération refusée de l’utilisateur se classe, sans être effacée', async () => {
    await getDb().outbox.bulkPut([
      command(1, { command_type: 'crm.visit.record', status: 'PENDING_SYNC' }),
      command(2, {
        command_type: 'procurement.receipt.record',
        status: 'REJECTED',
        last_error: { code: 'ATTACHMENT_REQUIRED', message_fr: 'Photo du bon exigée.' },
      }),
      command(3, { command_type: 'sales.sale.record', status: 'CONFLICT', author_user_id: OTHER }),
      command(4, { command_type: 'futur.type.inconnu', status: 'PENDING_SYNC' }),
    ]);
    const user = userEvent.setup();
    render(<SyncScreen />);

    const attention = (await screen.findByRole('heading', { name: 'Opérations à examiner' }))
      .parentElement!;
    expect(
      within(attention).getByText(/Réception d’achat — .*Photo du bon exigée\./),
    ).toBeInTheDocument();
    expect(within(attention).getByText(/^Vente — /)).toBeInTheDocument();
    expect(within(attention).getByText(/la classer ne règle pas le conflit/)).toBeInTheDocument();
    expect(screen.getByText(/^Visite — /)).toBeInTheDocument();
    // Type inconnu de cette version : affiché tel quel.
    expect(screen.getByText(/^futur\.type\.inconnu — /)).toBeInTheDocument();
    expect(screen.queryByText(/procurement\.receipt\.record/)).toBeNull();

    // Seules ses propres opérations se classent (tablette partagée).
    const buttons = within(attention).getAllByRole('button', { name: /^Classer/ });
    expect(buttons).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Classer : Réception d’achat' }));
    expect(await screen.findByText(/^Vente — /)).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText(/Réception d’achat/)).toBeNull());
    expect(
      await getDb().outbox.get(command(2, { command_type: 'x', status: 'REJECTED' }).command_id),
    ).toMatchObject({
      status: 'REJECTED',
      local_flags: ['ACKNOWLEDGED'],
    });
    expect(await countAttention(getDb())).toBe(1);
  });
});
