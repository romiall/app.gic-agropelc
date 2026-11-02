import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { getDb } from '../../storage/db.js';
import type * as Connectivity from '../../platform/connectivity.js';
import { useOnlineCommands, type AdminCommand } from './admin-online.js';

const network = vi.hoisted(() => ({ online: true }));

vi.mock('../../platform/connectivity.js', async (importOriginal) => ({
  ...(await importOriginal<typeof Connectivity>()),
  isEffectivelyOnline: () => network.online,
}));
vi.mock('../sync/sync-engine-instance.js', () => ({ getSyncEngine: () => undefined }));
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

const command: AdminCommand = {
  commandType: 'organization.site.close',
  aggregateType: 'SITE',
  aggregateId: '01900000-0000-7000-8000-0000000000b1',
  payload: {},
};

describe('Commandes d’administration en ligne (RP-1, ADR-051)', () => {
  beforeEach(async () => {
    network.online = true;
    await getDb().outbox.clear();
  });

  afterEach(async () => {
    cleanup();
    await getDb().outbox.clear();
  });

  it('en ligne : la commande est mise en file, marquée saisie en ligne', async () => {
    const { result } = renderHook(() => useOnlineCommands('organization.'));
    let sent = false;
    await act(async () => {
      sent = await result.current.send(command);
    });
    expect(sent).toBe(true);
    const stored = await getDb().outbox.toArray();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      command_type: 'organization.site.close',
      captured_offline: false,
    });
    expect(result.current.saveError).toBeNull();
  });

  it('connexion perdue entre l’affichage et l’envoi : rien n’est mis en file, le refus est expliqué', async () => {
    const { result } = renderHook(() => useOnlineCommands('organization.'));
    network.online = false;
    let sent = true;
    await act(async () => {
      sent = await result.current.send(command);
    });
    expect(sent).toBe(false);
    expect(await getDb().outbox.count()).toBe(0);
    expect(result.current.saveError).toBe('admin_config.offline_refused');

    // Le réseau revient : le même geste passe, le message disparaît.
    network.online = true;
    await act(async () => {
      sent = await result.current.send(command);
    });
    expect(sent).toBe(true);
    expect(await getDb().outbox.count()).toBe(1);
    expect(result.current.saveError).toBeNull();
  });
});
