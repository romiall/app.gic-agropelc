import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { getDb, type SyncMeta } from '../../storage/db.js';
import { meSettingRow } from '../sales/fixtures.js';
import type { SettingData } from '../sales/types.js';
import { submitCommand } from '../sales/submit.js';
import { autonomyOf, hoursFrom, OfflineReadOnlyError } from './autonomy.js';
import { AutonomyBanner } from './AutonomyBanner.js';

vi.mock('./sync-engine-instance.js', () => ({ getSyncEngine: () => undefined }));
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

  it('bandeau : avertissement, puis lecture seule ; rien après une synchronisation récente', async () => {
    await lastSync(ago(50));
    const { unmount } = render(<AutonomyBanner />);
    expect(
      await screen.findByText(
        /Aucune synchronisation depuis 50 h : connectez-vous dès que possible/,
      ),
    ).toHaveAttribute('role', 'status');
    unmount();

    await lastSync(ago(200));
    const second = render(<AutonomyBanner />);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /Lecture seule : aucune synchronisation depuis 200 h \(plus de 168 h\)/,
    );
    second.unmount();

    await lastSync(ago(2));
    const { container } = render(<AutonomyBanner />);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(container).toBeEmptyDOMElement();
  });
});
