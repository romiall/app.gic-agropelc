/**
 * Bandeau « le serveur refuse l'envoi » (ADR-052, AV-506) : absent tant que rien n'a été refusé en bloc ; donne le
 * code, rassure sur les opérations en attente et fournit le numéro à transmettre à l'administrateur.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../../storage/db.js';
import { PushRefusalBanner } from './PushRefusalBanner.js';

const DEVICE_ID = '01900000-0000-7000-8000-0000000000d0';

describe('PushRefusalBanner', () => {
  beforeEach(async () => {
    await getDb().syncMeta.clear();
    await getDb().syncMeta.put({
      key: 'device',
      device_id: DEVICE_ID,
      clock_skew_ms: null,
      last_sync_at: null,
    });
  });

  afterEach(async () => {
    cleanup();
    await getDb().syncMeta.clear();
  });

  it('ne montre rien tant qu’aucun lot n’a été refusé en bloc', async () => {
    render(<PushRefusalBanner />);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('donne le code, rassure sur les opérations et fournit le numéro à transmettre', async () => {
    await getDb().syncMeta.update('device', {
      push_refusal: {
        at: '2026-11-04T10:00:00.000Z',
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'Corps de requête invalide',
        correlation_id: '01900000-0000-7000-8000-000000000abc',
      },
    });
    render(<PushRefusalBanner />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(
      'Le serveur refuse l’envoi de vos opérations (VALIDATION_ERROR)',
    );
    expect(alert).toHaveTextContent('rien n’est perdu');
    expect(alert).toHaveTextContent('01900000-0000-7000-8000-000000000abc');
  });

  it('sans numéro ni code (réponse illisible) : le statut HTTP et la consigne de prévenir l’administrateur', async () => {
    await getDb().syncMeta.update('device', {
      push_refusal: {
        at: '2026-11-04T10:00:00.000Z',
        status: 400,
        code: null,
        message: null,
        correlation_id: null,
      },
    });
    render(<PushRefusalBanner />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('(HTTP 400)');
    expect(alert).toHaveTextContent('prévenez l’administrateur');
  });

  it('disparaît quand le témoin est effacé', async () => {
    await getDb().syncMeta.update('device', {
      push_refusal: {
        at: '2026-11-04T10:00:00.000Z',
        status: 400,
        code: 'VALIDATION_ERROR',
        message: null,
        correlation_id: null,
      },
    });
    render(<PushRefusalBanner />);
    await screen.findByRole('alert');
    await getDb().syncMeta.update('device', { push_refusal: null });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
