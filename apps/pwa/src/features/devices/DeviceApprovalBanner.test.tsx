import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { getDb } from '../../storage/db.js';
import { DeviceApprovalBanner } from './DeviceApprovalBanner.js';

const DEVICE = '01900000-0000-7000-8000-0000000000d0';
const auth = vi.hoisted(() => ({ deviceStatus: 'PENDING' as 'PENDING' | 'ACTIVE' }));

vi.mock('../auth/AuthContext.js', () => ({
  useAuth: () => ({
    state: {
      status: 'unlocked',
      userId: '01900000-0000-7000-8000-000000000001',
      deviceStatus: auth.deviceStatus,
    },
    deviceId: '01900000-0000-7000-8000-0000000000d0',
  }),
}));

async function putSession(status: 'PENDING' | 'ACTIVE', code?: string) {
  await getDb().session.put({
    key: 'current',
    user_id: '01900000-0000-7000-8000-000000000001',
    device_status: status,
    ...(code ? { device_short_code: code } : {}),
    encrypted_refresh_token: 'x',
    iv: 'y',
  });
}

async function putDevice(status: string) {
  await getDb().projections.put({
    key: `device:DEVICE:${DEVICE}`,
    dataset: 'device',
    entity_type: 'DEVICE',
    entity_id: DEVICE,
    scope_type: 'DEVICE',
    scope_id: DEVICE,
    row_version: 2,
    data: { id: DEVICE, status, short_code: '7KQ2' },
    seq: 1,
  });
}

describe('Bandeau d’attente d’approbation (MP-06, BR-ADM-007)', () => {
  beforeEach(async () => {
    auth.deviceStatus = 'PENDING';
    await getDb().session.clear();
    await getDb().projections.clear();
  });

  afterEach(async () => {
    cleanup();
    await getDb().session.clear();
    await getDb().projections.clear();
  });

  it('appareil en attente : le code court reçu à la connexion est affiché', async () => {
    await putSession('PENDING', 'AB12');
    render(<DeviceApprovalBanner />);
    expect(await screen.findByRole('status')).toHaveTextContent(/communiquez-lui le code AB12/);
  });

  it('sans code connu : bandeau sans code', async () => {
    await putSession('PENDING');
    render(<DeviceApprovalBanner />);
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Cet appareil attend l’approbation de votre responsable ou de l’administrateur. Vos opérations partiront après l’approbation.',
    );
  });

  it('approuvé depuis la connexion : la fiche publiée l’emporte et le bandeau disparaît', async () => {
    await putSession('PENDING', 'AB12');
    render(<DeviceApprovalBanner />);
    expect(await screen.findByRole('status')).toBeInTheDocument();
    await putDevice('ACTIVE');
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
  });

  it('appareil actif : aucun bandeau', async () => {
    auth.deviceStatus = 'ACTIVE';
    await putSession('ACTIVE');
    render(<DeviceApprovalBanner />);
    // Laisse les lectures de la base se terminer.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByRole('status')).toBeNull();
  });
});
