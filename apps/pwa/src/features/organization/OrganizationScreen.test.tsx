import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { getDb } from '../../storage/db.js';
import { authorizedRequest } from '../../sync/api-client.js';
import { seedSalesFixtures } from '../sales/fixtures.js';
import { OrganizationScreen } from './OrganizationScreen.js';
import type { LocationView, PosView, SiteView, TeamView, ZoneView } from './organization.js';

vi.mock('../sync/sync-engine-instance.js', () => ({ getSyncEngine: () => undefined }));
vi.mock('../../sync/api-client.js', () => ({ authorizedRequest: vi.fn() }));
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

const COUNTRY = '01900000-0000-7000-8000-0000000000a1';
const DOUALA = '01900000-0000-7000-8000-0000000000a2';
const CENTRAL = '01900000-0000-7000-8000-0000000000b1';
const AKWA = '01900000-0000-7000-8000-0000000000b2';
const TEAM = '01900000-0000-7000-8000-0000000000c1';
const AWA = '01900000-0000-7000-8000-0000000000e1';
const PAUL = '01900000-0000-7000-8000-0000000000e2';
const MEMBERSHIP = '01900000-0000-7000-8000-0000000000f1';
const POS_LOCATION = '01900000-0000-7000-8000-0000000000f2';
const STORE_LOCATION = '01900000-0000-7000-8000-0000000000f3';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const ZONES: readonly ZoneView[] = [
  {
    id: COUNTRY,
    parentId: null,
    code: 'CMR',
    name: 'Cameroun',
    level: 'PAYS',
    depth: 1,
    geofence: null,
    maxGpsAccuracyM: null,
    isActive: true,
  },
  {
    id: DOUALA,
    parentId: COUNTRY,
    code: 'DLA',
    name: 'Douala',
    level: 'VILLE',
    depth: 2,
    geofence: { lat: 4.051056, lng: 9.767869, radiusM: 500 },
    maxGpsAccuracyM: 150,
    isActive: true,
  },
];

const site = (overrides: Partial<SiteView>): SiteView => ({
  id: CENTRAL,
  code: 'MC',
  name: 'Magasin central',
  siteType: 'MAGASIN',
  zoneId: DOUALA,
  address: null,
  status: 'ACTIVE',
  openedOn: '2026-01-05',
  closedOn: null,
  ...overrides,
});

const SITES: readonly SiteView[] = [
  site({}),
  site({ id: AKWA, code: 'PDV1', name: 'Point de vente Akwa', siteType: 'POINT_DE_VENTE' }),
];

const TEAMS: readonly TeamView[] = [
  {
    id: TEAM,
    code: 'LIT',
    name: 'Littoral',
    managerUserId: AWA,
    managerName: 'Awa Nde',
    isActive: true,
    members: [
      {
        membershipId: MEMBERSHIP,
        userId: PAUL,
        since: '2026-10-01T08:00:00.000Z',
        fullName: 'Paul Essomba',
      },
    ],
  },
];

const USERS = [
  { id: AWA, fullName: 'Awa Nde' },
  { id: PAUL, fullName: 'Paul Essomba' },
];

const location = (overrides: Partial<LocationView>): LocationView => ({
  id: STORE_LOCATION,
  siteId: CENTRAL,
  parentLocationId: null,
  code: 'MAG',
  name: 'Réserve',
  locationType: 'STORE',
  isVirtual: false,
  custodyMode: 'SHARED',
  custodianUserId: null,
  capacity: null,
  status: 'ACTIVE',
  ...overrides,
});

const LOCATIONS: Readonly<Record<string, readonly LocationView[]>> = {
  [CENTRAL]: [location({})],
  [AKWA]: [
    location({
      id: POS_LOCATION,
      siteId: AKWA,
      code: 'BOUT',
      name: 'Boutique Akwa',
      locationType: 'POS',
    }),
  ],
};

interface Served {
  readonly pointsOfSale?: readonly PosView[];
  readonly denied?: boolean;
}

function serve({ pointsOfSale = [], denied = false }: Served = {}) {
  vi.mocked(authorizedRequest).mockImplementation((_db, path) => {
    const target = String(path);
    const ok = (data: unknown) => Promise.resolve({ ok: true, data }) as never;
    if (denied) {
      return Promise.resolve({ ok: false, reason: 'HTTP_ERROR', status: 403, body: {} }) as never;
    }
    if (target === '/api/v1/sites') return ok({ sites: SITES });
    if (target === '/api/v1/zones') return ok({ zones: ZONES });
    if (target === '/api/v1/teams') return ok({ teams: TEAMS });
    if (target === '/api/v1/points-of-sale') return ok({ points_of_sale: pointsOfSale });
    if (target.startsWith('/api/v1/users')) return ok({ users: USERS, next_cursor: null });
    if (target.startsWith('/api/v1/devices')) return ok({ devices: [], next_cursor: null });
    if (target.startsWith('/api/v1/locations?site_id=')) {
      const id = decodeURIComponent(target.split('=')[1]!);
      return ok({
        site: SITES.find((candidate) => candidate.id === id),
        locations: LOCATIONS[id] ?? [],
      });
    }
    return Promise.resolve({ ok: false, reason: 'HTTP_ERROR', status: 500, body: {} }) as never;
  });
}

function renderScreen() {
  return render(
    <MemoryRouter>
      <OrganizationScreen />
    </MemoryRouter>,
  );
}

const lastCommand = async () =>
  (await getDb().outbox.orderBy('device_seq').reverse().limit(1).toArray())[0];

describe('Organisation (ECR-ADM-06)', () => {
  beforeEach(async () => {
    const db = getDb();
    await db.projections.clear();
    await db.outbox.clear();
    await seedSalesFixtures(db);
  });

  afterEach(async () => {
    cleanup();
    vi.restoreAllMocks();
    vi.mocked(authorizedRequest).mockReset();
    await getDb().projections.clear();
    await getDb().outbox.clear();
  });

  it('lit la structure fraîche : sites avec leur zone et leur état, onglets', async () => {
    serve();
    renderScreen();
    const card = await screen.findByRole('listitem', { name: 'Site Magasin central' });
    expect(within(card).getByText('Magasin')).toBeInTheDocument();
    expect(within(card).getByText(/Zone : Douala/)).toBeInTheDocument();
    expect(within(card).getByText(/ouvert le 5 janvier 2026/)).toBeInTheDocument();
    const paths = vi.mocked(authorizedRequest).mock.calls.map((call) => call[1]);
    expect(paths).toEqual(
      expect.arrayContaining([
        '/api/v1/sites',
        '/api/v1/zones',
        '/api/v1/teams',
        '/api/v1/points-of-sale',
      ]),
    );
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
      'Sites',
      'Zones',
      'Équipes',
      'Points de vente',
    ]);
  });

  it('refus de lecture : un message, aucun onglet rempli', async () => {
    serve({ denied: true });
    renderScreen();
    expect(await screen.findByText('Lecture refusée : droit insuffisant.')).toBeInTheDocument();
    expect(screen.queryByRole('listitem')).toBeNull();
  });

  it('crée un site : commande organization.site.create sur un agrégat neuf, code en majuscules', async () => {
    serve();
    const user = userEvent.setup();
    renderScreen();
    await screen.findByRole('listitem', { name: 'Site Magasin central' });
    await user.click(screen.getByRole('button', { name: 'Nouveau site' }));
    const form = screen.getByRole('group', { name: 'Nouveau site' });
    const create = within(form).getByRole('button', { name: 'Créer le site' });
    expect(create).toBeDisabled();
    await user.type(within(form).getByLabelText('Code'), 'fer1');
    await user.type(within(form).getByLabelText('Nom'), 'Ferme de Bonabéri');
    await user.selectOptions(within(form).getByLabelText('Type de site'), 'FERME');
    await user.selectOptions(within(form).getByLabelText('Zone'), DOUALA);
    expect(create).toBeEnabled();
    await user.click(create);

    await waitFor(async () => expect(await getDb().outbox.count()).toBe(1));
    const command = await lastCommand();
    expect(command).toMatchObject({
      command_type: 'organization.site.create',
      aggregate_type: 'SITE',
      payload: { code: 'FER1', name: 'Ferme de Bonabéri', siteType: 'FERME', zoneId: DOUALA },
      captured_offline: false,
    });
    expect(command!.aggregate_id).toMatch(UUID);
    expect(await screen.findByText('Opération en cours d’envoi…')).toBeInTheDocument();
  });

  it('ferme un site : avertissement, puis commande organization.site.close sur le site', async () => {
    serve();
    const user = userEvent.setup();
    renderScreen();
    const card = await screen.findByRole('listitem', { name: 'Site Magasin central' });
    await user.click(within(card).getByRole('button', { name: 'Fermer le site' }));
    expect(within(card).getByText(/La fermeture est définitive/)).toBeInTheDocument();
    await user.click(
      within(card).getByRole('button', { name: 'Confirmer la fermeture de Magasin central' }),
    );
    await waitFor(async () => expect(await getDb().outbox.count()).toBe(1));
    expect(await lastCommand()).toMatchObject({
      command_type: 'organization.site.close',
      aggregate_type: 'SITE',
      aggregate_id: CENTRAL,
      payload: {},
    });
  });

  it('emplacements d’un site : lus à l’ouverture, création d’un emplacement mobile confié à une personne', async () => {
    serve();
    const user = userEvent.setup();
    renderScreen();
    const card = await screen.findByRole('listitem', { name: 'Site Magasin central' });
    await user.click(within(card).getByRole('button', { name: 'Emplacements' }));
    expect(await within(card).findByText('Réserve')).toBeInTheDocument();
    await user.click(within(card).getByRole('button', { name: 'Nouvel emplacement' }));
    const form = within(card).getByRole('group', { name: 'Nouvel emplacement' });
    await user.type(within(form).getByLabelText('Code'), 'veh1');
    await user.type(within(form).getByLabelText('Nom'), 'Véhicule de livraison');
    await user.selectOptions(within(form).getByLabelText('Type d’emplacement'), 'MOBILE');
    // Un emplacement mobile attend son titulaire.
    expect(within(form).getByRole('button', { name: 'Créer l’emplacement' })).toBeDisabled();
    await user.selectOptions(within(form).getByLabelText('Titulaire de l’emplacement'), PAUL);
    await user.click(within(form).getByRole('button', { name: 'Créer l’emplacement' }));
    await waitFor(async () => expect(await getDb().outbox.count()).toBe(1));
    expect(await lastCommand()).toMatchObject({
      command_type: 'organization.location.create',
      aggregate_type: 'LOCATION',
      payload: {
        siteId: CENTRAL,
        code: 'VEH1',
        name: 'Véhicule de livraison',
        locationType: 'MOBILE',
        custodyMode: 'EXCLUSIVE_USER',
        custodianUserId: PAUL,
      },
    });
  });

  it('zones : arbre, création avec géorepère (virgule décimale acceptée)', async () => {
    serve();
    const user = userEvent.setup();
    renderScreen();
    await user.click(await screen.findByRole('tab', { name: 'Zones' }));
    const douala = await screen.findByRole('listitem', { name: 'Zone Douala' });
    expect(within(douala).getByText(/géorepère 4\.051056, 9\.767869 · 500 m/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Nouvelle zone' }));
    const form = screen.getByRole('group', { name: 'Nouvelle zone' });
    await user.type(within(form).getByLabelText('Code'), 'lit');
    await user.type(within(form).getByLabelText('Nom'), 'Littoral');
    await user.selectOptions(within(form).getByLabelText('Niveau'), 'REGION');
    await user.type(within(form).getByLabelText('Latitude'), '4,05');
    const create = within(form).getByRole('button', { name: 'Créer la zone' });
    // Latitude sans longitude : le géorepère est incomplet.
    expect(create).toBeDisabled();
    await user.type(within(form).getByLabelText('Longitude'), '9.7');
    await user.type(within(form).getByLabelText(/^Rayon/), '300');
    await user.click(create);
    await waitFor(async () => expect(await getDb().outbox.count()).toBe(1));
    expect(await lastCommand()).toMatchObject({
      command_type: 'organization.zone.create',
      aggregate_type: 'ZONE',
      payload: {
        code: 'LIT',
        name: 'Littoral',
        level: 'REGION',
        lat: 4.05,
        lng: 9.7,
        radiusM: 300,
      },
    });
  });

  it('« Utiliser ma position » remplit latitude et longitude ; refus du GPS expliqué', async () => {
    serve();
    const getCurrentPosition = vi
      .fn()
      .mockImplementationOnce((onFound: (position: unknown) => void) =>
        onFound({ coords: { latitude: 4.05, longitude: 9.7, accuracy: 12 } }),
      )
      .mockImplementationOnce((_found: unknown, onError: (error: unknown) => void) =>
        onError({ code: 1, PERMISSION_DENIED: 1, TIMEOUT: 3 }),
      );
    Object.defineProperty(navigator, 'geolocation', {
      value: { getCurrentPosition },
      configurable: true,
    });
    const user = userEvent.setup();
    renderScreen();
    await user.click(await screen.findByRole('tab', { name: 'Zones' }));
    await user.click(await screen.findByRole('button', { name: 'Nouvelle zone' }));
    const form = screen.getByRole('group', { name: 'Nouvelle zone' });
    await user.click(within(form).getByRole('button', { name: 'Utiliser ma position' }));
    expect(within(form).getByLabelText('Latitude')).toHaveValue('4.050000');
    expect(within(form).getByLabelText('Longitude')).toHaveValue('9.700000');
    await user.click(within(form).getByRole('button', { name: 'Utiliser ma position' }));
    expect(await within(form).findByRole('alert')).toHaveTextContent(/Position refusée/);
  });

  it('modifie le géorepère d’une zone : seul le géorepère part ; sans changement, rien à enregistrer', async () => {
    serve();
    const user = userEvent.setup();
    renderScreen();
    await user.click(await screen.findByRole('tab', { name: 'Zones' }));
    const douala = await screen.findByRole('listitem', { name: 'Zone Douala' });
    await user.click(within(douala).getByRole('button', { name: 'Modifier' }));
    expect(within(douala).getByRole('button', { name: 'Enregistrer' })).toBeDisabled();
    expect(within(douala).getByText('Aucun changement à enregistrer.')).toBeInTheDocument();
    const radius = within(douala).getByLabelText(/^Rayon/);
    await user.clear(radius);
    await user.type(radius, '250');
    await user.click(within(douala).getByRole('button', { name: 'Enregistrer' }));
    await waitFor(async () => expect(await getDb().outbox.count()).toBe(1));
    expect(await lastCommand()).toMatchObject({
      command_type: 'organization.zone.update',
      aggregate_id: DOUALA,
      payload: { geofence: { lat: 4.051056, lng: 9.767869, radiusM: 250 } },
    });
  });

  it('équipes : ajoute un membre (appartenance neuve) et en retire un (organization.team.*)', async () => {
    serve();
    const user = userEvent.setup();
    renderScreen();
    await user.click(await screen.findByRole('tab', { name: 'Équipes' }));
    const team = await screen.findByRole('listitem', { name: 'Équipe Littoral' });
    expect(within(team).getByText(/responsable : Awa Nde · 1 membre/)).toBeInTheDocument();
    await user.click(within(team).getByRole('button', { name: 'Ajouter un membre' }));
    // Paul est déjà membre : seuls les autres sont proposés.
    const select = within(team).getByLabelText('Personne à ajouter');
    expect(within(select).queryByRole('option', { name: 'Paul Essomba' })).toBeNull();
    await user.selectOptions(select, AWA);
    await user.click(within(team).getByRole('button', { name: 'Ajouter à Littoral' }));
    await waitFor(async () => expect(await getDb().outbox.count()).toBe(1));
    const assign = await lastCommand();
    expect(assign).toMatchObject({
      command_type: 'organization.team.assign_member',
      aggregate_type: 'TEAM_MEMBERSHIP',
      payload: { teamId: TEAM, userId: AWA },
    });
    expect(assign!.aggregate_id).toMatch(UUID);
    expect(assign!.aggregate_id).not.toBe(TEAM);
  });

  it('équipes : retirer un membre envoie organization.team.remove_member', async () => {
    serve();
    const user = userEvent.setup();
    renderScreen();
    await user.click(await screen.findByRole('tab', { name: 'Équipes' }));
    const team = await screen.findByRole('listitem', { name: 'Équipe Littoral' });
    await user.click(
      within(team).getByRole('button', { name: 'Retirer Paul Essomba de Littoral' }),
    );
    await waitFor(async () => expect(await getDb().outbox.count()).toBe(1));
    expect(await lastCommand()).toMatchObject({
      command_type: 'organization.team.remove_member',
      aggregate_type: 'TEAM_MEMBERSHIP',
      payload: { userId: PAUL },
    });
  });

  it('crée une équipe : responsable obligatoire', async () => {
    serve();
    const user = userEvent.setup();
    renderScreen();
    await user.click(await screen.findByRole('tab', { name: 'Équipes' }));
    await user.click(await screen.findByRole('button', { name: 'Nouvelle équipe' }));
    const form = screen.getByRole('group', { name: 'Nouvelle équipe' });
    await user.type(within(form).getByLabelText('Code'), 'cen');
    await user.type(within(form).getByLabelText('Nom'), 'Équipe Centre');
    const create = within(form).getByRole('button', { name: 'Créer l’équipe' });
    expect(create).toBeDisabled();
    await user.selectOptions(within(form).getByLabelText('Responsable de l’équipe'), AWA);
    await user.click(create);
    await waitFor(async () => expect(await getDb().outbox.count()).toBe(1));
    expect(await lastCommand()).toMatchObject({
      command_type: 'organization.team.create',
      aggregate_type: 'TEAM',
      payload: { code: 'CEN', name: 'Équipe Centre', managerUserId: AWA },
    });
  });

  it('configure un point de vente partagé : emplacement de vente et magasin source lus, agrégat = le site', async () => {
    serve();
    const user = userEvent.setup();
    renderScreen();
    await user.click(await screen.findByRole('tab', { name: 'Points de vente' }));
    await user.click(await screen.findByRole('button', { name: 'Configurer un point de vente' }));
    const panel = screen.getByRole('group', { name: 'Configurer un point de vente' });
    await user.selectOptions(within(panel).getByLabelText('Site du point de vente'), AKWA);
    expect(await within(panel).findByRole('option', { name: 'Boutique Akwa' })).toBeInTheDocument();
    const save = within(panel).getByRole('button', { name: 'Enregistrer la configuration' });
    expect(save).toBeDisabled();
    await user.selectOptions(within(panel).getByLabelText('Emplacement de vente'), POS_LOCATION);
    expect(
      await within(panel).findByRole('option', { name: 'Magasin central · Réserve' }),
    ).toBeInTheDocument();
    await user.selectOptions(within(panel).getByLabelText(/^Magasin source/), STORE_LOCATION);
    await user.type(within(panel).getByLabelText(/^Horaires/), '8h à 18h');
    await user.click(save);
    await waitFor(async () => expect(await getDb().outbox.count()).toBe(1));
    expect(await lastCommand()).toMatchObject({
      command_type: 'organization.pos.configure',
      aggregate_type: 'SITE',
      aggregate_id: AKWA,
      payload: {
        salesLocationId: POS_LOCATION,
        custodyMode: 'SHARED',
        replenishmentSourceLocationId: STORE_LOCATION,
        openingHours: '8h à 18h',
      },
    });
  });

  it('point de vente en garde exclusive : un appareil désigné est exigé', async () => {
    serve({
      pointsOfSale: [
        {
          siteId: AKWA,
          siteCode: 'PDV1',
          siteName: 'Point de vente Akwa',
          siteStatus: 'ACTIVE',
          salesLocationId: POS_LOCATION,
          replenishmentSourceLocationId: null,
          custodyMode: 'SHARED',
          designatedDeviceId: null,
          openingHours: null,
        },
      ],
    });
    const user = userEvent.setup();
    renderScreen();
    await user.click(await screen.findByRole('tab', { name: 'Points de vente' }));
    const card = await screen.findByRole('listitem', {
      name: 'Point de vente Point de vente Akwa',
    });
    await user.click(within(card).getByRole('button', { name: 'Modifier' }));
    await user.click(within(card).getByRole('radio', { name: 'Appareil désigné' }));
    expect(
      await within(card).findByRole('button', { name: 'Enregistrer la configuration' }),
    ).toBeDisabled();
    expect(within(card).getByRole('combobox', { name: 'Appareil désigné' })).toBeInTheDocument();
  });
});
