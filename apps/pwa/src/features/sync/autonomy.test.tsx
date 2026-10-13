import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { FixedClock } from '@gic/domain';
import { clock } from '../../platform/composition.js';
import { getDb, type SyncMeta } from '../../storage/db.js';
import { enqueueCommand } from '../../sync/outbox.js';
import { meSettingRow } from '../sales/fixtures.js';
import type { SettingData } from '../sales/types.js';
import { submitCommand } from '../sales/submit.js';
import { autonomyOf, hoursFrom, OfflineReadOnlyError } from './autonomy.js';
import { AutonomyBanner } from './AutonomyBanner.js';
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
vi.mock('../../platform/composition.js', async () => {
  const { FixedClock, Uuidv7Generator } = await import('@gic/domain');
  const clock = new FixedClock(new Date('2026-10-10T12:00:00.000Z'));
  return { clock, idGenerator: new Uuidv7Generator(clock) };
});

const NOW = new Date('2026-10-10T12:00:00.000Z');
const HOUR = 3_600_000;
const ago = (hours: number, extraMs = 0) =>
  new Date(NOW.getTime() - hours * HOUR - extraMs).toISOString();

function setting(key: string, value: unknown): SettingData {
  return {
    id: key,
    key,
    value,
    scope_type: 'GLOBAL',
    scope_id: null,
    valid_from: '2026-01-01T00:00:00.000Z',
  };
}

async function lastSync(at: string | null) {
  await getDb().syncMeta.put({
    key: 'device',
    device_id: '01900000-0000-7000-8000-0000000000d0',
    clock_skew_ms: null,
    last_sync_at: at,
  });
}

describe('Autonomie hors connexion (AV-009)', () => {
  // État de synchronisation de l'appareil rétabli après chaque test (base partagée du fichier).
  let saved: SyncMeta | undefined;

  beforeEach(async () => {
    saved = await getDb().syncMeta.get('device');
    await getDb().outbox.clear();
    await getDb().projections.clear();
  });

  afterEach(async () => {
    cleanup();
    await getDb().outbox.clear();
    await getDb().projections.clear();
    if (saved) await getDb().syncMeta.put(saved);
    else await getDb().syncMeta.delete('device');
  });

  it('seuils : avertissement au-delà de 48 h, lecture seule au-delà de 7 jours ; paramètres publiés', () => {
    const level = (lastSyncAt: string | null, settings: SettingData[] = []) =>
      autonomyOf({ lastSyncAt, now: NOW, settings });
    expect(level(null)).toEqual({ level: 'OK', hours: null, maxHours: 168 });
    expect(level(ago(48))).toMatchObject({ level: 'OK', hours: 48 });
    expect(level(ago(48, 1))).toMatchObject({ level: 'WARNING', hours: 48 });
    expect(level(ago(168))).toMatchObject({ level: 'WARNING', hours: 168 });
    expect(level(ago(168, 1))).toMatchObject({ level: 'READ_ONLY', hours: 168 });
    // Horloge en arrière : jamais d'heures négatives.
    expect(level(new Date(NOW.getTime() + HOUR).toISOString())).toMatchObject({
      level: 'OK',
      hours: 0,
    });
    // Paramètres publiés (jeu `me`) : 24 h et 72 h ; texte numérique admis.
    const custom = [
      setting('offline.warning_hours', '24'),
      setting('offline.max_autonomy_hours', 72),
    ];
    expect(level(ago(25), custom)).toMatchObject({ level: 'WARNING', maxHours: 72 });
    expect(level(ago(73), custom)).toMatchObject({ level: 'READ_ONLY' });
    expect(hoursFrom(0, 48)).toBe(48);
    expect(hoursFrom(-5, 48)).toBe(48);
    expect(hoursFrom('x', 48)).toBe(48);
    expect(hoursFrom(null, 48)).toBe(48);
    expect(hoursFrom(12.5, 48)).toBe(12.5);
  });

  it('lecture seule : aucune nouvelle opération enregistrée ; dans l’autonomie, enregistrée', async () => {
    const input = {
      authorUserId: '01900000-0000-7000-8000-000000000001',
      commandType: 'sales.payment.record',
      aggregateType: 'PAYMENT',
      aggregateId: '01900000-0000-7000-8000-0000000000aa',
      payload: { amountXaf: 1_000 },
    };
    await lastSync(ago(169));
    await expect(submitCommand(input)).rejects.toBeInstanceOf(OfflineReadOnlyError);
    expect(await getDb().outbox.count()).toBe(0);
    // Paramètre publié plus large : l'appareil reste dans son autonomie.
    await getDb().projections.put(meSettingRow('offline.max_autonomy_hours', 240));
    await expect(submitCommand(input)).resolves.toMatchObject({
      command_type: 'sales.payment.record',
    });
    expect(await getDb().outbox.count()).toBe(1);
  });

  it('lecture seule : la garde est au point d’enregistrement unique, diagnostic compris', async () => {
    await lastSync(ago(169));
    await expect(
      enqueueCommand(
        getDb(),
        { clock, idGenerator: { newId: () => '01900000-0000-7000-8000-0000000000ab' } },
        {
          authorUserId: '01900000-0000-7000-8000-000000000001',
          commandType: 'organization.setting.set',
          commandVersion: 1,
          aggregateType: 'SETTING',
          payload: {},
          capturedOffline: true,
        },
      ),
    ).rejects.toBeInstanceOf(OfflineReadOnlyError);
    expect(await getDb().outbox.count()).toBe(0);
  });

  it('diagnostic de l’écran de synchronisation : refusé en lecture seule, refus annoncé', async () => {
    await lastSync(ago(169));
    const user = userEvent.setup();
    render(<SyncScreen />);
    await user.click(await screen.findByRole('button', { name: 'Tester la synchronisation' }));
    expect(
      await screen.findByText(/Lecture seule : .*Rien n’a été enregistré/),
    ).toBeInTheDocument();
    expect(await getDb().outbox.count()).toBe(0);
  });

  it('écran de synchronisation : appareil en attente d’approbation annoncé (AV-228)', async () => {
    await lastSync(ago(1));
    await getDb().outbox.put({
      command_id: '01900000-0000-7000-8000-0000000000ac',
      device_seq: 1,
      command_type: 'sales.sale.record',
      command_version: 1,
      author_user_id: '01900000-0000-7000-8000-000000000001',
      aggregate_type: 'SALE',
      aggregate_id: '01900000-0000-7000-8000-0000000000ad',
      base_version: null,
      depends_on: [],
      occurred_at: NOW.toISOString(),
      client_created_at: NOW.toISOString(),
      captured_offline: false,
      backdated_reason: null,
      attachment_ids: [],
      payload: {},
      status: 'PENDING_SYNC',
      attempts: 1,
      next_attempt_at: null,
      last_error: { code: 'DEVICE_PENDING', message_fr: 'Appareil en attente d’approbation.' },
      server_refs: null,
    });
    render(<SyncScreen />);
    expect(
      await screen.findByText(/Ce téléphone attend l’approbation de l’administrateur/),
    ).toHaveAttribute('role', 'status');
  });

  it('bandeau : avertissement, lecture seule, puis disparu après une synchronisation (sans remontage)', async () => {
    await lastSync(ago(50));
    const { container } = render(<AutonomyBanner />);
    expect(
      await screen.findByText(
        /Aucune synchronisation depuis 50 h : connectez-vous dès que possible/,
      ),
    ).toHaveAttribute('role', 'status');
    await lastSync(ago(200));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /Lecture seule : aucune synchronisation depuis 200 h \(plus de 168 h\)/,
    );
    // Synchronisation réussie : le bandeau se retire (transition observée, pas une attente fixe).
    await lastSync(ago(2));
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it('bandeau resté monté : il suit le temps (retour au premier plan), sans nouvelle synchronisation', async () => {
    const fixed = clock as unknown as FixedClock;
    try {
      await lastSync(ago(47));
      render(<AutonomyBanner />);
      await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
      fixed.advance(2 * HOUR);
      act(() => {
        document.dispatchEvent(new Event('visibilitychange'));
      });
      expect(await screen.findByText(/Aucune synchronisation depuis 49 h/)).toBeInTheDocument();
      fixed.advance(121 * HOUR);
      act(() => {
        window.dispatchEvent(new Event('focus'));
      });
      expect(await screen.findByRole('alert')).toHaveTextContent(
        /Lecture seule : aucune synchronisation depuis 170 h/,
      );
    } finally {
      fixed.setTo(NOW);
    }
  });
});
