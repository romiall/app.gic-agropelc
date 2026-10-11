import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { getDb, type OutboxCommand } from '../../storage/db.js';
import { IDS, seedSalesFixtures } from '../sales/fixtures.js';
import type { WorkSessionData, ZoneData } from '../sales/types.js';
import { ServiceScreen } from './ServiceScreen.js';
import {
  deviceWorkSessions,
  overrideAllowed,
  serviceZones,
  todayAttempts,
  zoneAt,
} from './service.js';

vi.mock('../sync/sync-engine-instance.js', () => ({ getSyncEngine: () => undefined }));
vi.mock('../../platform/composition.js', async () => {
  const { FixedClock, Uuidv7Generator } = await import('@gic/domain');
  const clock = new FixedClock(new Date('2026-10-10T09:00:00.000Z'));
  return { clock, idGenerator: new Uuidv7Generator(clock) };
});
vi.mock('../auth/AuthContext.js', () => ({
  useAuth: () => ({
    state: {
      status: 'unlocked',
      userId: '01900000-0000-7000-8000-000000000001',
      deviceStatus: 'ACTIVE',
    },
  }),
}));

const CENTER = { lat: 3.8667, lng: 11.5167 };
/** Environ 100 m au nord du centre de la zone. */
const INSIDE = { latitude: CENTER.lat + 0.0009, longitude: CENTER.lng, accuracy: 20 };
/** Environ 2 km au nord. */
const OUTSIDE = { latitude: CENTER.lat + 0.018, longitude: CENTER.lng, accuracy: 20 };

function locateAt(coords: { latitude: number; longitude: number; accuracy: number }) {
  Object.defineProperty(navigator, 'geolocation', {
    configurable: true,
    value: {
      getCurrentPosition: (ok: (position: { coords: typeof coords }) => void) => ok({ coords }),
    },
  });
}

function zone(overrides: Partial<ZoneData> = {}): ZoneData {
  return {
    id: IDS.zone,
    parent_id: null,
    name: 'Centre',
    depth: 1,
    is_active: 1,
    geofence_lat: String(CENTER.lat),
    geofence_lng: String(CENTER.lng),
    geofence_radius_m: '500',
    max_gps_accuracy_m: null,
    ...overrides,
  };
}

function checkin(
  occurredAt: string,
  payload: Record<string, unknown>,
  overrides: Partial<OutboxCommand> = {},
): OutboxCommand {
  const seq = Number(occurredAt.slice(14, 16));
  return {
    command_id: `01900000-0000-7000-8000-0000000001${String(seq).padStart(2, '0')}`,
    device_seq: seq,
    command_type: 'fieldwork.checkin.record',
    command_version: 1,
    author_user_id: IDS.user,
    aggregate_type: 'GEO_CHECKIN',
    aggregate_id: `01900000-0000-7000-8000-0000000002${String(seq).padStart(2, '0')}`,
    base_version: null,
    depends_on: [],
    occurred_at: occurredAt,
    client_created_at: occurredAt,
    captured_offline: true,
    backdated_reason: null,
    attachment_ids: [],
    payload,
    status: 'LOCAL_ONLY',
    attempts: 0,
    next_attempt_at: null,
    last_error: null,
    server_refs: null,
    ...overrides,
  };
}

describe('Pointage (ECR-TER-01, logique)', () => {
  it('zones proposées : actives avec géorepère ; zone contenant la position', () => {
    const zones = new Map(
      [
        zone(),
        zone({ id: 'z-sans', name: 'Sans géorepère', geofence_lat: null, geofence_lng: null }),
        zone({ id: 'z-inactive', name: 'Inactive', is_active: 0 }),
        zone({ id: 'z-loin', name: 'Loin', geofence_lat: '4.05', max_gps_accuracy_m: '80' }),
      ].map((value) => [value.id, value]),
    );
    const offered = serviceZones(zones, 150);
    expect(offered.map((candidate) => candidate.zone.id)).toEqual([IDS.zone, 'z-loin']);
    expect(offered.map((candidate) => candidate.maxAccuracyM)).toEqual([150, 80]);
    expect(zoneAt({ lat: INSIDE.latitude, lng: INSIDE.longitude }, offered)?.zone.id).toBe(
      IDS.zone,
    );
    expect(zoneAt({ lat: OUTSIDE.latitude, lng: OUTSIDE.longitude }, offered)).toBeUndefined();
  });

  it('dérogation : trois refus étalés sur deux minutes depuis la dernière prise acceptée', () => {
    const refused = (at: string) =>
      checkin(at, { checkinType: 'START_SERVICE', clientResult: 'REJECTED_OUT_OF_ZONE' });
    const quick = todayAttempts(
      [
        refused('2026-10-10T08:58:00.000Z'),
        refused('2026-10-10T08:58:30.000Z'),
        refused('2026-10-10T08:59:00.000Z'),
      ],
      IDS.user,
      '2026-10-10',
    );
    expect(overrideAllowed(quick, 3, 2)).toBe(false);
    const spread = todayAttempts(
      [
        refused('2026-10-10T08:50:00.000Z'),
        refused('2026-10-10T08:52:00.000Z'),
        refused('2026-10-10T08:54:00.000Z'),
      ],
      IDS.user,
      '2026-10-10',
    );
    expect(overrideAllowed(spread, 3, 2)).toBe(true);
    const afterAccepted = todayAttempts(
      [
        ...spread.map((attempt) => refused(attempt.occurredAt)),
        checkin('2026-10-10T08:55:00.000Z', {
          checkinType: 'START_SERVICE',
          clientResult: 'ACCEPTED',
        }),
      ],
      IDS.user,
      '2026-10-10',
    );
    expect(overrideAllowed(afterAccepted, 3, 2)).toBe(false);
  });

  it('sessions de l’appareil : prise acceptée, nouvelle prise qui clôt, fin de service, clôture à 23:59', () => {
    const yesterday: WorkSessionData = {
      id: 's-hier',
      user_id: IDS.user,
      declared_zone_id: IDS.zone,
      started_at: '2026-10-09T07:00:00.000Z',
      ended_at: null,
      status: 'OPEN',
      override_status: 'NOT_REQUIRED',
    };
    const start = checkin('2026-10-10T08:10:00.000Z', {
      checkinType: 'START_SERVICE',
      declaredZoneId: IDS.zone,
      clientResult: 'ACCEPTED',
      sessionId: 's-jour',
    });
    const open = deviceWorkSessions([yesterday], [start], undefined);
    // La session d'hier, jamais close sur l'appareil, se termine à 23:59 (Douala) le 09/10.
    // La session d'hier, jamais close, se termine à 23:59 (Douala) le 09/10, pas à la prise du jour.
    expect(open.find((s) => s.id === 's-hier')).toMatchObject({
      ended_at: '2026-10-09T22:59:00.000Z',
      status: 'CLOSED',
    });
    expect(open.find((s) => s.id === 's-jour')).toMatchObject({
      started_at: '2026-10-10T08:10:00.000Z',
      ended_at: '2026-10-10T22:59:00.000Z',
      auto_close: true,
      pending_command_id: start.command_id,
    });
    const end = checkin('2026-10-10T08:40:00.000Z', {
      checkinType: 'END_SERVICE',
      declaredZoneId: IDS.zone,
      clientResult: 'REJECTED_OUT_OF_ZONE',
      sessionId: 's-jour',
    });
    const closed = deviceWorkSessions([yesterday], [start, end], undefined);
    expect(closed.find((s) => s.id === 's-jour')).toMatchObject({
      ended_at: '2026-10-10T08:40:00.000Z',
      status: 'CLOSED',
    });
  });
});

describe('Pointage (ECR-TER-01, écran)', () => {
  beforeEach(async () => {
    const db = getDb();
    await db.projections.clear();
    await db.outbox.clear();
    await seedSalesFixtures(db);
    await db.projections.put({
      key: `zone:ZONE:${IDS.zone}`,
      dataset: 'zone',
      entity_type: 'ZONE',
      entity_id: IDS.zone,
      scope_type: 'GLOBAL',
      scope_id: null,
      row_version: 1,
      seq: 1,
      data: { ...zone() },
    });
  });

  afterEach(async () => {
    cleanup();
    vi.restoreAllMocks();
    Reflect.deleteProperty(navigator, 'geolocation');
    await getDb().projections.clear();
    await getDb().outbox.clear();
  });

  it('hors ligne, dans la zone : service pris aussitôt, puis fin de service rattachée à la session', async () => {
    locateAt(INSIDE);
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <ServiceScreen />
      </MemoryRouter>,
    );
    expect(await screen.findByText(/Dans la zone : à 100 m du centre/)).toBeInTheDocument();
    expect(screen.getByLabelText('Zone de travail')).toHaveValue(IDS.zone);
    await user.click(screen.getByRole('button', { name: 'PRENDRE SERVICE' }));
    expect(await screen.findByText(/En service depuis 10:00 — zone Centre/)).toBeInTheDocument();

    const [start] = await getDb().outbox.toArray();
    expect(start).toMatchObject({
      command_type: 'fieldwork.checkin.record',
      aggregate_type: 'GEO_CHECKIN',
      captured_offline: true,
      payload: {
        checkinType: 'START_SERVICE',
        declaredZoneId: IDS.zone,
        position: { lat: INSIDE.latitude, lng: INSIDE.longitude },
        accuracyM: 20,
        clientResult: 'ACCEPTED',
      },
    });
    const sessionId = (start?.payload as { sessionId?: string }).sessionId;
    expect(sessionId).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'FIN DE SERVICE' }));
    expect(await screen.findByRole('button', { name: 'PRENDRE SERVICE' })).toBeInTheDocument();
    const end = (await getDb().outbox.orderBy('device_seq').toArray())[1];
    expect(end).toMatchObject({
      // Pas de dépendance vers la prise : l'ordre du lot suffit (ADR-051 §11).
      depends_on: [],
      payload: { checkinType: 'END_SERVICE', sessionId, clientResult: 'ACCEPTED' },
    });
  });

  it('en service : nouvelle position relevée, fin bloquée pendant le relevé, prise dans une autre zone qui clôt la session', async () => {
    const NORTH = '01900000-0000-7000-8000-0000000000f6';
    await getDb().projections.put({
      key: `zone:ZONE:${NORTH}`,
      dataset: 'zone',
      entity_type: 'ZONE',
      entity_id: NORTH,
      scope_type: 'GLOBAL',
      scope_id: null,
      row_version: 1,
      seq: 1,
      data: {
        ...zone({
          id: NORTH,
          name: 'Nord',
          geofence_lat: String(OUTSIDE.latitude),
          geofence_lng: String(OUTSIDE.longitude),
        }),
      },
    });
    // Premier relevé : dans la zone Centre ; le suivant reste en cours, puis aboutit au Nord.
    const pending: ((position: { coords: typeof INSIDE }) => void)[] = [];
    let calls = 0;
    Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      value: {
        getCurrentPosition: (ok: (position: { coords: typeof INSIDE }) => void) => {
          calls += 1;
          if (calls === 1) ok({ coords: INSIDE });
          else pending.push(ok);
        },
      },
    });
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <ServiceScreen />
      </MemoryRouter>,
    );
    await user.click(await screen.findByRole('button', { name: 'PRENDRE SERVICE' }));
    await screen.findByText(/En service depuis 10:00 — zone Centre/);
    // Une position fraîche est demandée après le pointage ; tant qu'elle manque, pas de fin.
    expect(calls).toBe(2);
    const session = within(screen.getByRole('region', { name: 'En service' }));
    expect(session.getByText('Localisation…', { selector: 'p' })).toBeInTheDocument();
    expect(session.getByRole('button', { name: 'FIN DE SERVICE' })).toBeDisabled();

    act(() => pending.shift()?.({ coords: OUTSIDE }));
    const change = within(await screen.findByRole('region', { name: 'Changer de zone' }));
    expect(change.getByLabelText('Zone de travail')).toHaveValue(NORTH);
    await user.click(change.getByRole('button', { name: 'Prendre service dans cette zone' }));
    expect(await screen.findByText(/En service depuis 10:00 — zone Nord/)).toBeInTheDocument();
    const starts = (await getDb().outbox.orderBy('device_seq').toArray()).map(
      (command) => command.payload as { declaredZoneId: string; sessionId?: string },
    );
    expect(starts.map((payload) => payload.declaredZoneId)).toEqual([IDS.zone, NORTH]);
    expect(starts[0]?.sessionId).not.toBe(starts[1]?.sessionId);
  });

  it('précision au dixième, jamais arrondie au mètre : 150,4 m pour 150 m admis est refusée', async () => {
    locateAt({ ...INSIDE, accuracy: 150.4 });
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <ServiceScreen />
      </MemoryRouter>,
    );
    expect(
      await screen.findByText(/Position trop imprécise \(± 150 m, au plus 150 m\)/),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'PRENDRE SERVICE' }));
    await screen.findByText(/Tentative refusée/);
    const [attempt] = await getDb().outbox.toArray();
    expect(attempt?.payload).toMatchObject({
      accuracyM: 150.4,
      clientResult: 'REJECTED_LOW_ACCURACY',
    });
  });

  it('hors zone : tentative refusée enregistrée ; après trois refus étalés, dérogation motivée', async () => {
    locateAt(OUTSIDE);
    const db = getDb();
    await db.outbox.bulkPut([
      checkin('2026-10-10T08:56:00.000Z', {
        checkinType: 'START_SERVICE',
        declaredZoneId: IDS.zone,
        clientResult: 'REJECTED_OUT_OF_ZONE',
      }),
      checkin('2026-10-10T08:58:00.000Z', {
        checkinType: 'START_SERVICE',
        declaredZoneId: IDS.zone,
        clientResult: 'REJECTED_OUT_OF_ZONE',
      }),
    ]);
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <ServiceScreen />
      </MemoryRouter>,
    );
    await user.selectOptions(await screen.findByLabelText('Zone de travail'), IDS.zone);
    expect(screen.getByText(/Hors de la zone : à 2002 m du centre/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Demander une dérogation')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'PRENDRE SERVICE' }));
    expect(await screen.findByText(/Tentative refusée/)).toBeInTheDocument();
    const attempt = (await db.outbox.orderBy('device_seq').toArray()).at(-1);
    expect(attempt?.payload).toMatchObject({ clientResult: 'REJECTED_OUT_OF_ZONE' });
    expect((attempt?.payload as { sessionId?: string }).sessionId).toBeUndefined();

    await user.type(
      await screen.findByLabelText('Demander une dérogation'),
      'Client en limite de zone',
    );
    await user.click(screen.getByRole('button', { name: 'Demander la dérogation' }));
    expect(
      await screen.findByText(/en attente de validation par votre responsable/),
    ).toBeInTheDocument();
    const override = (await db.outbox.orderBy('device_seq').toArray()).at(-1);
    expect(override).toMatchObject({
      command_type: 'fieldwork.checkin.request_override',
      aggregate_type: 'WORK_SESSION',
      payload: { declaredZoneId: IDS.zone, reason: 'Client en limite de zone' },
    });
  });
});
