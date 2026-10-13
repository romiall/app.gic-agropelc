import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { getDb, type OutboxCommand } from '../../storage/db.js';
import { CommandResult } from './CommandResult.js';
import { isBlockingWait, waitingCommands } from './submit.js';

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

/** Commande en attente de `author`, au rang `seq`, renvoyée `busyRetries` fois sans succès. */
function waiting(
  id: string,
  seq: number,
  busyRetries: number,
  code = 'SERVER_BUSY',
  author = 'u',
): OutboxCommand {
  return {
    ...accepted(id),
    device_seq: seq,
    author_user_id: author,
    command_type: seq === 1 ? 'pricing.rule.create' : 'catalog.unit.create',
    status: 'PENDING_SYNC',
    server_refs: null,
    synced_at: null,
    busy_retries: busyRetries,
    last_error: busyRetries > 0 ? { code, message_fr: 'Erreur transitoire, à réessayer.' } : null,
  };
}

describe('Opération retenue derrière une opération plus ancienne en échec répété', () => {
  afterEach(async () => {
    cleanup();
    await getDb().outbox.clear();
  });

  it('ne bloque plus son écran et l’annonce ; une opération déclarée bloquée ne retient rien', async () => {
    const failing = waiting('regle', 1, 3);
    const held = waiting('unite', 2, 0);
    const outbox = [failing, held];
    // Le catalogue n'attend plus l'unité, que le serveur suspend derrière la règle en échec.
    expect(isBlockingWait(held)).toBe(true);
    expect(isBlockingWait(held, outbox)).toBe(false);
    expect(waitingCommands(outbox, 'catalog.', 'u')).toEqual([]);
    // Autre auteur, ou commande plus récente que l'échec : rien ne la retient.
    expect(isBlockingWait(waiting('autre', 3, 0, 'SERVER_BUSY', 'v'), outbox)).toBe(true);
    expect(isBlockingWait(held, [{ ...failing, device_seq: 5 }, held])).toBe(true);
    // Déclarée bloquée (`COMMAND_STALLED`) : elle ne retient plus la suite, qui part normalement.
    const stalled = waiting('regle', 1, 3, 'COMMAND_STALLED');
    expect(isBlockingWait(held, [stalled, held])).toBe(true);

    await getDb().outbox.bulkPut(outbox);
    render(<CommandResult commandId="unite" messages="sales.result" />);
    const result = await screen.findByText(
      /Cette opération attend une opération précédente que le serveur renvoie sans l’appliquer \(Erreur transitoire, à réessayer\.\)/,
    );
    expect(result.closest('.result')).toHaveClass('result-warn');
  });
});

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
