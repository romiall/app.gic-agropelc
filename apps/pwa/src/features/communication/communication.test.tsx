import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { getDb } from '../../storage/db.js';
import { authorizedRequest } from '../../sync/api-client.js';
import { AlertsNotificationsScreen } from './AlertsNotificationsScreen.js';
import { NotePublishScreen, NotesScreen } from './NotesScreen.js';
import {
  alertsListPath,
  buildAlertAckPayload,
  buildAlertDismissPayload,
  buildAlertResolvePayload,
  buildAlertRuleSetPayload,
  buildNotificationReadPayload,
  canManuallyCloseAlert,
  filterProjectedAlerts,
  fromProjectedNotifications,
  routeOfActionScreen,
  routeOfNotification,
  summarizeAlerts,
} from './alerts.js';
import {
  buildNoteAckPayload,
  buildNoteArchivePayload,
  buildNoteSaveOrPublishPayload,
  filterProjectedNotes,
  noteAckFollowUpPath,
  notesInboxPath,
  notesManagePath,
} from './notes.js';

vi.mock('../sync/sync-engine-instance.js', () => ({ getSyncEngine: () => undefined }));
vi.mock('../../sync/api-client.js', () => ({ authorizedRequest: vi.fn() }));
vi.mock('../auth/AuthContext.js', () => ({
  useAuth: () => ({
    state: {
      status: 'unlocked',
      userId: '01900000-0000-7000-8000-000000000001',
      deviceStatus: 'ACTIVE',
    },
  }),
}));

const USER_ID = '01900000-0000-7000-8000-000000000001';
const ALERT_1 = '01900000-0000-7000-8000-000000000701';
const NOTE_1 = '01900000-0000-7000-8000-000000000711';

describe('Communication & Alertes (ECR-NOT-01 à 03)', () => {
  beforeEach(async () => {
    const db = getDb();
    await db.projections.clear();
    await db.outbox.clear();
    await db.navigation.put({
      user_id: USER_ID,
      full_name: 'Directeur Général',
      roles: ['DIRECTION'],
      sections: [],
      saved_at: '2026-10-15T08:00:00.000Z',
    });
  });

  afterEach(async () => {
    cleanup();
    vi.restoreAllMocks();
    vi.mocked(authorizedRequest).mockReset();
    const db = getDb();
    await db.projections.clear();
    await db.outbox.clear();
    await db.navigation.clear();
  });

  it('fonctions pures d’alertes et de notifications : chemins, projections, routes et commandes', () => {
    expect(alertsListPath({ status: 'OPEN', severity: 'CRITICAL' })).toBe(
      '/api/v1/alerts?status=OPEN&severity=CRITICAL',
    );
    const alerts = filterProjectedAlerts(
      [
        {
          id: ALERT_1,
          alert_type: 'STOCK_NEGATIVE',
          nature: 'EVENT',
          severity: 'CRITICAL',
          status: 'OPEN',
          title: 'Stock négatif détecté',
          message: 'Écart de stock à régulariser',
          action_screen: 'ECR-SYN-03',
          last_detected_at: '2026-10-15T09:00:00.000Z',
        },
      ],
      { status: '', severity: '' },
    );
    expect(alerts).toHaveLength(1);
    expect(canManuallyCloseAlert(alerts[0]!)).toBe(true);
    expect(routeOfActionScreen('ECR-SYN-03')).toBe('/synchronisation/conflits');
    const summary = summarizeAlerts(alerts, '2026-10-15T09:05:00.000Z');
    expect(summary.open).toBe(1);
    expect(summary.bySeverity.CRITICAL).toBe(1);

    const notifs = fromProjectedNotifications(
      [
        {
          id: '01900000-0000-7000-8000-000000000721',
          kind: 'NOTE',
          title: 'Nouvelle note tarifaire',
          body: 'Veuillez en prendre connaissance',
          note_id: NOTE_1,
          created_at: '2026-10-15T09:10:00.000Z',
          read_at: null,
        },
      ],
      true,
    );
    expect(notifs.unreadCount).toBe(1);
    expect(routeOfNotification(notifs.items[0]!)).toBe(`/notes?note=${NOTE_1}`);

    expect(buildAlertAckPayload('Pris en charge').payload).toEqual({
      comment: 'Pris en charge',
    });
    expect(buildAlertResolvePayload('').ok).toBe(false);
    expect(buildAlertResolvePayload('Corrigé').ok).toBe(true);
    expect(buildAlertDismissPayload('Faux positif').ok).toBe(true);
    expect(buildNotificationReadPayload({ all: true }).payload).toEqual({ all: true });
    expect(
      buildAlertRuleSetPayload({
        alertType: 'STOCK_NEGATIVE',
        enabled: true,
        severity: 'CRITICAL',
        escalationHours: 24,
      }).ok,
    ).toBe(true);
  });

  it('fonctions pures de notes de direction : chemins, projections et commandes', () => {
    expect(notesInboxPath({ pendingAckOnly: true })).toBe(
      '/api/v1/notes?scope=inbox&limit=50&pending_ack=true',
    );
    expect(notesManagePath({ status: 'PUBLISHED' })).toBe(
      '/api/v1/notes?scope=manage&limit=50&status=PUBLISHED',
    );
    expect(noteAckFollowUpPath(NOTE_1)).toBe(`/api/v1/notes/${NOTE_1}/acknowledgements`);

    const projected = filterProjectedNotes(
      [
        {
          id: NOTE_1,
          title: 'Grille tarifaire novembre',
          body: 'Application immédiate sur tous les sites.',
          category: 'PRIX',
          requires_ack: true,
          published_at: '2026-10-15T08:00:00.000Z',
          read_at: null,
          acknowledged_at: null,
        },
      ],
      { pendingAckOnly: true },
    );
    expect(projected.items).toHaveLength(1);
    expect(projected.pendingAcknowledgements).toBe(1);

    expect(buildNoteAckPayload('ACKNOWLEDGE').ok).toBe(true);
    expect(buildNoteArchivePayload('Obsolète').ok).toBe(true);
    const pub = buildNoteSaveOrPublishPayload(
      {
        title: 'Consigne sécurité',
        body: 'Port des équipements obligatoire.',
        category: 'INSTRUCTION',
        requiresAck: true,
        expiresAtDate: '2026-12-31',
        audience: [{ type: 'ALL' }],
      },
      'PUBLISH',
    );
    expect(pub.ok).toBe(true);
  });

  it('affiche ECR-NOT-01 et permet d’acquitter une alerte ouverte', async () => {
    vi.mocked(authorizedRequest).mockImplementation((_db, path) => {
      const target = String(path);
      const ok = (data: unknown) => Promise.resolve({ ok: true, data }) as never;
      if (target === '/api/v1/alerts/summary') {
        return ok({
          open: 1,
          acknowledged: 0,
          bySeverity: { INFO: 0, WARNING: 0, CRITICAL: 1 },
          truncated: false,
          computedAt: '2026-10-15T10:00:00.000Z',
        });
      }
      if (target.startsWith('/api/v1/alerts')) {
        return ok({
          items: [
            {
              id: ALERT_1,
              alertType: 'STOCK_NEGATIVE',
              nature: 'EVENT',
              severity: 'CRITICAL',
              status: 'OPEN',
              title: 'Stock négatif Bonabéri',
              message: 'Solde poulet de chair négatif',
              subjectType: 'STOCK_BALANCE',
              subjectId: ALERT_1,
              siteId: null,
              zoneId: null,
              ownerUserId: null,
              actionScreen: 'ECR-SYN-03',
              occurrences: 1,
              firstDetectedAt: '2026-10-15T09:00:00.000Z',
              lastDetectedAt: '2026-10-15T09:00:00.000Z',
              criticalSince: '2026-10-15T09:00:00.000Z',
              escalatedAt: null,
              acknowledgedAt: null,
              acknowledgedBy: null,
              resolvedAt: null,
              resolvedBy: null,
              resolutionComment: null,
              visibility: ['RECIPIENT'],
              payload: {},
            },
          ],
          nextCursor: null,
        });
      }
      if (target.startsWith('/api/v1/notifications')) {
        return ok({ items: [], unreadCount: 0, nextCursor: null });
      }
      return ok({ items: [] });
    });

    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <AlertsNotificationsScreen />
      </MemoryRouter>,
    );

    expect(await screen.findByText('Stock négatif Bonabéri')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /Prendre en compte/i }));
    await user.click(screen.getByRole('button', { name: /Valider/i }));

    const outbox = await getDb().outbox.toArray();
    expect(outbox).toHaveLength(1);
    expect(outbox[0]?.command_type).toBe('communication.alert.acknowledge');
    expect(outbox[0]?.aggregate_id).toBe(ALERT_1);
  });

  it('affiche ECR-NOT-02 et ECR-NOT-03 et enregistre un accusé de réception de note', async () => {
    vi.mocked(authorizedRequest).mockImplementation((_db, path) => {
      const target = String(path);
      const ok = (data: unknown) => Promise.resolve({ ok: true, data }) as never;
      if (target.startsWith('/api/v1/notes')) {
        return ok({
          items: [
            {
              id: NOTE_1,
              title: 'Note officielle Direction',
              body: 'Respecter les horaires de livraison.',
              category: 'INSTRUCTION',
              relatedEntityType: null,
              relatedEntityId: null,
              requiresAck: true,
              status: 'PUBLISHED',
              publishedAt: '2026-10-15T08:00:00.000Z',
              expiresAt: null,
              authorUserId: USER_ID,
              readAt: null,
              acknowledgedAt: null,
            },
          ],
          pendingAcknowledgements: 1,
          truncated: false,
          nextCursor: null,
        });
      }
      return ok({});
    });

    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <NotesScreen />
      </MemoryRouter>,
    );

    expect(await screen.findByText('Note officielle Direction')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /Accuser réception/i }));

    const outbox = await getDb().outbox.toArray();
    expect(outbox).toHaveLength(1);
    expect(outbox[0]?.command_type).toBe('communication.note.acknowledge');
    expect(outbox[0]?.aggregate_id).toBe(NOTE_1);

    cleanup();
    render(
      <MemoryRouter>
        <NotePublishScreen />
      </MemoryRouter>,
    );
    expect(screen.getByText(/Publier une note de direction/i)).toBeTruthy();
  });
});
