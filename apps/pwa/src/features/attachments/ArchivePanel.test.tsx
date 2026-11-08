import { createHash, randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import type { ArchiveCatalog, ArchiveView, ArchiveVolumeView, PurgeResult } from '@gic/contracts';
import { authorizedRequest } from '../../sync/api-client.js';
import { startDownload } from './archive-download.js';
import { ArchivePanel } from './ArchivePanel.js';

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
vi.mock('./archive-download.js', () => ({
  startDownload: vi.fn(),
  wait: vi.fn(async () => undefined),
}));

const ARCHIVE_ID = '01900000-0000-7000-8000-0000000000a1';
const VOLUME_1 = '01900000-0000-7000-8000-0000000000b1';
const VOLUME_2 = '01900000-0000-7000-8000-0000000000b2';
const BASE = '/api/v1/attachment-archives';
const NOW = '2026-11-08T10:00:00.000Z';

function volume(over: Partial<ArchiveVolumeView>): ArchiveVolumeView {
  return {
    id: VOLUME_1,
    seq: 1,
    fileName: 'GIC-photos_2026-07_RECEPTION_20261108.zip',
    category: 'RECEPTION',
    month: '2026-07',
    part: 1,
    files: 6,
    filesBytes: 6_000_000,
    zipBytes: 6_002_000,
    zipSha256: null,
    deliveries: 0,
    abortedDeliveries: 0,
    firstDeliveredAt: null,
    lastDeliveredAt: null,
    verifiedAt: null,
    resolvedAt: null,
    planned: 6,
    purged: 0,
    released: 0,
    ...over,
  };
}

/** Un faux serveur qui garde l'état : plan, livraisons, vérifications, vidage. */
class FakeServer {
  archives: ArchiveView[] = [];
  /** Le fichier que l'Admin a « rangé » : son contenu fixe l'empreinte du volume qu'il choisira. */
  readonly stored = randomBytes(2048);
  readonly storedHash = createHash('sha256').update(this.stored).digest('hex');
  purgeRemaining: number[] = [0];
  readonly calls: { method: string; path: string; body: unknown }[] = [];
  catalogGranularity: 'QUARTER' | 'MONTH' = 'QUARTER';

  catalog(granularity: 'QUARTER' | 'MONTH'): ArchiveCatalog {
    const live = this.archives.find((archive) => archive.status === 'READY');
    const quarter = granularity === 'QUARTER';
    return {
      granularity,
      settings: {
        minAgeDays: 30,
        volumeMaxMb: 512,
        defaultGranularity: 'QUARTER',
        retentionYears: 5,
      },
      server: { files: 240, bytes: 96_000_000 },
      periods: [
        {
          granularity,
          start: '2026-07-01',
          end: quarter ? '2026-10-01' : '2026-08-01',
          label: quarter ? '2026-T3' : '2026-07',
          onServer: { files: 140, bytes: 56_000_000 },
          olderThanMinAge: { files: 120, bytes: 48_000_000 },
          recent: { files: 20, bytes: 8_000_000 },
          archived: { files: 0, bytes: 0 },
          planId: live ? live.id : null,
        },
        {
          granularity,
          start: quarter ? '2026-10-01' : '2026-10-01',
          end: quarter ? '2027-01-01' : '2026-11-01',
          label: quarter ? '2026-T4' : '2026-10',
          onServer: { files: 100, bytes: 40_000_000 },
          olderThanMinAge: { files: 0, bytes: 0 },
          recent: { files: 100, bytes: 40_000_000 },
          archived: { files: 0, bytes: 0 },
          planId: null,
        },
      ],
    };
  }

  private refresh(archive: ArchiveView): ArchiveView {
    const open = archive.volumes.filter((v) => v.resolvedAt === null);
    return {
      ...archive,
      allDelivered:
        archive.status === 'READY' && open.length > 0 && open.every((v) => v.deliveries > 0),
    };
  }

  handle(
    method: string,
    path: string,
    body: unknown,
  ): { ok: boolean; status?: number; data?: unknown; body?: unknown } {
    this.calls.push({ method, path, body });
    const ok = (data: unknown) => ({ ok: true, data });
    const fail = (status: number, code: string, details?: Record<string, unknown>) => ({
      ok: false,
      status,
      body: { error: { code, message: code, ...(details ? { details } : {}) } },
    });
    const url = new URL(path, 'http://localhost');
    if (method === 'GET' && url.pathname === `${BASE}/catalog`) {
      const granularity =
        (url.searchParams.get('granularity') as 'QUARTER' | 'MONTH' | null) ?? 'QUARTER';
      return ok(this.catalog(granularity));
    }
    if (method === 'GET' && url.pathname === BASE) {
      return ok({ archives: this.archives.map((archive) => this.refresh(archive)) });
    }
    if (method === 'POST' && url.pathname === BASE) {
      const request = body as { granularity: 'QUARTER' | 'MONTH'; periodStart: string };
      if (request.periodStart === '2026-10-01')
        return fail(409, 'ARCHIVE_NOTHING_TO_ARCHIVE', { kept_open: 3, absent: 0 });
      const created: ArchiveView = {
        id: ARCHIVE_ID,
        granularity: request.granularity,
        period: {
          granularity: request.granularity,
          start: '2026-07-01',
          end: '2026-10-01',
          label: request.granularity === 'QUARTER' ? '2026-T3' : '2026-07',
        },
        status: 'READY',
        cutoffAt: '2026-10-09T10:00:00.000Z',
        minAgeDays: 30,
        createdAt: NOW,
        completedAt: null,
        cancelledAt: null,
        files: 12,
        filesBytes: 9_000_000,
        keptOpen: 3,
        absent: 0,
        allDelivered: false,
        volumes: [
          volume({ id: VOLUME_1 }),
          volume({
            id: VOLUME_2,
            seq: 2,
            category: 'DEPENSE',
            month: '2026-08',
            fileName: 'GIC-photos_2026-08_DEPENSE_20261108.zip',
            files: 6,
            planned: 6,
          }),
        ],
      };
      this.archives = [created];
      return { ok: true, data: { archive: this.refresh(created) } };
    }
    const archive = this.archives[0];
    const idMatch = url.pathname.match(/^\/api\/v1\/attachment-archives\/([^/]+)(?:\/(.*))?$/);
    if (!archive || !idMatch || idMatch[1] !== archive.id) return fail(404, 'NOT_FOUND');
    const rest = idMatch[2] ?? '';
    if (method === 'GET' && rest === '') return ok({ archive: this.refresh(archive) });
    const volumeRoute = rest.match(/^volumes\/([^/]+)\/(ticket|verify)$/);
    if (method === 'POST' && volumeRoute) {
      const target = archive.volumes.find((v) => v.id === volumeRoute[1]);
      if (!target) return fail(404, 'NOT_FOUND');
      if (volumeRoute[2] === 'ticket') {
        // Le navigateur télécharge, le serveur enregistre la livraison complète.
        target.deliveries += 1;
        target.zipSha256 = target.id === VOLUME_2 ? this.storedHash : 'f'.repeat(64);
        target.firstDeliveredAt = NOW;
        target.lastDeliveredAt = NOW;
        return ok({ url: `${BASE}/download?ticket=T-${target.seq}`, expiresAt: NOW });
      }
      const sha = (body as { sha256: string }).sha256;
      if (sha !== target.zipSha256) return fail(409, 'ARCHIVE_HASH_MISMATCH');
      target.verifiedAt = NOW;
      return ok({ volume: target });
    }
    if (method === 'POST' && rest === 'cancel') {
      archive.status = 'CANCELLED';
      archive.cancelledAt = NOW;
      return ok({ archive: this.refresh(archive) });
    }
    if (method === 'POST' && rest === 'purge') {
      const remaining = this.purgeRemaining.shift() ?? 0;
      const result: PurgeResult = {
        purged: remaining > 0 ? 5 : 7,
        bytesFreed: remaining > 0 ? 5_000_000 : 7_000_000,
        alreadyAbsent: 0,
        released: { OPEN_OPERATION: remaining > 0 ? 0 : 1, CHANGED: 0, TOO_RECENT: 0 },
        remaining,
        volumesResolved: remaining > 0 ? 0 : 2,
        volumesVerified: 0,
      };
      if (remaining === 0) {
        archive.status = 'COMPLETED';
        archive.completedAt = NOW;
        for (const v of archive.volumes) {
          v.resolvedAt = NOW;
          v.purged = v.files;
          v.planned = 0;
        }
      }
      return ok({ archive: this.refresh(archive), result });
    }
    return fail(404, 'NOT_FOUND');
  }
}

let server: FakeServer;

function install() {
  vi.mocked(authorizedRequest).mockImplementation((_db, path, init) => {
    const method = (init as RequestInit | undefined)?.method ?? 'GET';
    const rawBody = (init as RequestInit | undefined)?.body;
    const body = typeof rawBody === 'string' ? (JSON.parse(rawBody) as unknown) : undefined;
    const response = server.handle(method, String(path), body);
    // Comme sur le réseau : la réponse est une copie, jamais l'objet que le « serveur » modifie ensuite.
    return Promise.resolve(
      response.ok
        ? { ok: true, data: JSON.parse(JSON.stringify(response.data)) as unknown }
        : { ok: false, reason: 'HTTP_ERROR', status: response.status, body: response.body },
    ) as never;
  });
}

const callsTo = (method: string, suffix: string) =>
  server.calls.filter((call) => call.method === method && call.path.endsWith(suffix));

function renderPanel() {
  return render(
    <MemoryRouter>
      <ArchivePanel />
    </MemoryRouter>,
  );
}

describe('Archive des photos (onglet des paramètres, AV-539)', () => {
  beforeEach(() => {
    server = new FakeServer();
    install();
  });

  afterEach(() => {
    cleanup();
    vi.mocked(authorizedRequest).mockReset();
    vi.mocked(startDownload).mockReset();
  });

  it('affiche ce qui reste sur le serveur et les périodes, avec ce qui est archivable et ce qui est gardé', async () => {
    renderPanel();
    expect(await screen.findByText('Sur le serveur : 240 photo(s), 91,6 Mo.')).toBeInTheDocument();
    const third = screen.getByRole('listitem', { name: 'Période 3e trimestre 2026' });
    expect(within(third).getByText('À archiver : 120 photo(s), 45,8 Mo')).toBeInTheDocument();
    expect(within(third).getByText('Gardées (moins de 30 jours) : 20')).toBeInTheDocument();
    const fourth = screen.getByRole('listitem', { name: 'Période 4e trimestre 2026' });
    expect(within(fourth).getByText('Rien d’assez ancien à archiver.')).toBeInTheDocument();
    expect(within(fourth).queryByRole('button', { name: /Préparer/ })).toBeNull();
    expect(
      screen.getByText('Aucune archive en cours : choisissez une période ci-dessous.'),
    ).toBeInTheDocument();
  });

  it('change de période : mois ou trimestre', async () => {
    const user = userEvent.setup();
    renderPanel();
    await screen.findByRole('listitem', { name: 'Période 3e trimestre 2026' });
    await user.click(screen.getByRole('radio', { name: 'Mois' }));
    expect(
      await screen.findByRole('listitem', { name: 'Période juillet 2026' }),
    ).toBeInTheDocument();
    expect(callsTo('GET', 'catalog?granularity=MONTH')).toHaveLength(1);
  });

  it('prépare l’archive d’une période : un fichier par mois et par catégorie, vidage encore bloqué', async () => {
    const user = userEvent.setup();
    renderPanel();
    const third = await screen.findByRole('listitem', { name: 'Période 3e trimestre 2026' });
    await user.click(within(third).getByRole('button', { name: /Préparer l’archive/ }));
    expect(
      await screen.findByText('Archive préparée : 2 fichier(s) à télécharger.'),
    ).toBeInTheDocument();
    expect(callsTo('POST', BASE)[0]!.body).toEqual({
      granularity: 'QUARTER',
      periodStart: '2026-07-01',
    });

    const card = await screen.findByRole('listitem', { name: 'Archive 3e trimestre 2026' });
    expect(
      within(card).getByText('3 photo(s) gardées : opération encore ouverte.'),
    ).toBeInTheDocument();
    const first = within(card).getByRole('listitem', {
      name: 'GIC-photos_2026-07_RECEPTION_20261108.zip',
    });
    expect(within(first).getByText('Réceptions · juillet 2026')).toBeInTheDocument();
    expect(within(first).getByText('À télécharger')).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'Vider l’espace' })).toBeDisabled();
    expect(
      within(card).getByText('Disponible quand tous les fichiers sont téléchargés en entier.'),
    ).toBeInTheDocument();
  });

  it('une période sans rien d’archivable est expliquée', async () => {
    const user = userEvent.setup();
    server.catalog = ((original) => (granularity: 'QUARTER' | 'MONTH') => {
      const catalog = original.call(server, granularity);
      // La période du quatrième trimestre propose tout de même une préparation : le serveur la refuse.
      return {
        ...catalog,
        periods: catalog.periods.map((period) =>
          period.start === '2026-10-01'
            ? { ...period, olderThanMinAge: { files: 1, bytes: 1000 } }
            : period,
        ),
      };
    })(server.catalog);
    renderPanel();
    const fourth = await screen.findByRole('listitem', { name: 'Période 4e trimestre 2026' });
    await user.click(within(fourth).getByRole('button', { name: /Préparer l’archive/ }));
    expect(
      await screen.findByText(
        'Rien à archiver pour cette période : aucune photo assez ancienne dont l’opération soit fermée.',
      ),
    ).toBeInTheDocument();
  });

  async function prepared() {
    const user = userEvent.setup();
    renderPanel();
    const third = await screen.findByRole('listitem', { name: 'Période 3e trimestre 2026' });
    await user.click(within(third).getByRole('button', { name: /Préparer l’archive/ }));
    const card = await screen.findByRole('listitem', { name: 'Archive 3e trimestre 2026' });
    return { user, card };
  }

  it('« Tout télécharger » enchaîne les fichiers un à un puis débloque le vidage', async () => {
    const { user, card } = await prepared();
    await user.click(within(card).getByRole('button', { name: 'Tout télécharger' }));
    await waitFor(() => expect(startDownload).toHaveBeenCalledTimes(2));
    expect(vi.mocked(startDownload).mock.calls.map(([path]) => path)).toEqual([
      `${BASE}/download?ticket=T-1`,
      `${BASE}/download?ticket=T-2`,
    ]);
    expect(await screen.findByText('Tous les fichiers sont téléchargés.')).toBeInTheDocument();
    await waitFor(() =>
      expect(
        within(screen.getByRole('listitem', { name: 'Archive 3e trimestre 2026' })).getByRole(
          'button',
          { name: 'Vider l’espace' },
        ),
      ).toBeEnabled(),
    );
    const files = within(screen.getByRole('listitem', { name: 'Archive 3e trimestre 2026' }));
    expect(files.getAllByText('Téléchargé').length).toBeGreaterThanOrEqual(2);
    // L'empreinte du fichier est montrée avec la commande qui la recalcule.
    expect(files.getAllByText('Empreinte SHA-256').length).toBeGreaterThan(0);
  });

  it('un seul fichier : « Télécharger » ne lance que celui-là', async () => {
    const { user, card } = await prepared();
    await user.click(
      within(card).getByRole('button', {
        name: 'Télécharger GIC-photos_2026-08_DEPENSE_20261108.zip',
      }),
    );
    await waitFor(() => expect(startDownload).toHaveBeenCalledTimes(1));
    expect(vi.mocked(startDownload).mock.calls[0]![0]).toBe(`${BASE}/download?ticket=T-2`);
    expect(callsTo('POST', '/ticket')).toHaveLength(1);
    // Le vidage reste bloqué : le premier fichier n'est pas téléchargé.
    const refreshed = await screen.findByRole('listitem', { name: 'Archive 3e trimestre 2026' });
    expect(within(refreshed).getByRole('button', { name: 'Vider l’espace' })).toBeDisabled();
  });

  it('vérifie un fichier rangé par son empreinte : reconnu, ou inconnu de l’archive', async () => {
    const { user, card } = await prepared();
    await user.click(within(card).getByRole('button', { name: 'Tout télécharger' }));
    await screen.findByText('Tous les fichiers sont téléchargés.');

    const input = screen.getByTestId('archive-file-input');
    const good = new File([server.stored], 'rangé-depense.zip', { type: 'application/zip' });
    const bad = new File([randomBytes(512)], 'abîmé.zip', { type: 'application/zip' });
    await user.upload(input, [good, bad]);

    expect(
      await screen.findByText(
        'rangé-depense.zip : identique au fichier GIC-photos_2026-08_DEPENSE_20261108.zip de l’archive.',
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        'abîmé.zip : ne correspond à aucun fichier de cette archive (incomplet ou abîmé ?).',
      ),
    ).toBeInTheDocument();
    expect(callsTo('POST', '/verify')).toHaveLength(1);
    expect(callsTo('POST', '/verify')[0]!.body).toEqual({ sha256: server.storedHash });
    // Le fichier vérifié est marqué « Vérifié ».
    await waitFor(() => expect(screen.getAllByText('Vérifié').length).toBeGreaterThan(0));
  });

  it('vide l’espace après confirmation : coche obligatoire, plusieurs appels tant qu’il en reste, résultat annoncé', async () => {
    server.purgeRemaining = [4, 0];
    const { user, card } = await prepared();
    await user.click(within(card).getByRole('button', { name: 'Tout télécharger' }));
    await screen.findByText('Tous les fichiers sont téléchargés.');
    await waitFor(() =>
      expect(
        within(screen.getByRole('listitem', { name: 'Archive 3e trimestre 2026' })).getByRole(
          'button',
          { name: 'Vider l’espace' },
        ),
      ).toBeEnabled(),
    );
    await user.click(
      within(screen.getByRole('listitem', { name: 'Archive 3e trimestre 2026' })).getByRole(
        'button',
        { name: 'Vider l’espace' },
      ),
    );

    const confirm = await screen.findByRole('button', { name: 'Vider l’espace du serveur' });
    expect(screen.getByText(/Vous allez supprimer du serveur 12 photo\(s\)/)).toBeInTheDocument();
    expect(
      screen.getByText(/Resteront sur le serveur : les photos de moins de 30 jours/),
    ).toBeInTheDocument();
    expect(
      screen.getByText('2 fichier(s) ne sont pas vérifiés par leur empreinte (facultatif).'),
    ).toBeInTheDocument();
    expect(confirm).toBeDisabled();
    await user.click(screen.getByRole('checkbox', { name: /J’ai rangé ces 2 fichier\(s\)/ }));
    expect(confirm).toBeEnabled();
    await user.click(confirm);

    await waitFor(() => expect(callsTo('POST', '/purge')).toHaveLength(2));
    expect(callsTo('POST', '/purge')[0]!.body).toEqual({ confirm: true });
    expect(
      await screen.findByText(/12 photo\(s\) supprimées du serveur \(11,4 Mo libérés\)/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/1 photo\(s\) sont restées sur le serveur : 1 opération rouverte/),
    ).toBeInTheDocument();
    // L'archive est terminée : elle quitte la liste des archives en cours pour l'historique.
    expect(await screen.findByText('Archives terminées')).toBeInTheDocument();
  });

  it('annule une archive dont rien n’a été vidé, après confirmation', async () => {
    const { user, card } = await prepared();
    await user.click(within(card).getByRole('button', { name: 'Annuler cette archive' }));
    expect(
      screen.getByText('Annuler cette archive ? Les photos restent sur le serveur.'),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Oui, annuler' }));
    expect(
      await screen.findByText('Archive annulée : les photos restent sur le serveur.'),
    ).toBeInTheDocument();
    expect(callsTo('POST', '/cancel')).toHaveLength(1);
  });

  it('refus de lecture : un message, aucune période', async () => {
    vi.mocked(authorizedRequest).mockImplementation(
      () => Promise.resolve({ ok: false, reason: 'HTTP_ERROR', status: 403, body: {} }) as never,
    );
    renderPanel();
    expect(await screen.findByText('Lecture refusée : droit insuffisant.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Préparer/ })).toBeNull();
  });
});
