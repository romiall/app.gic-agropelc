/**
 * ECR-IMP-01 « Charger des données » (RP-2, PP-C ; AV-072, AV-317, AV-508) : du fichier à l'outbox, avec les vrais
 * référentiels de l'appareil (projections posées dans la base locale, telles que le serveur les sert) et la vraie base
 * locale — aucun mock de l'écran, de ses référentiels ni de son envoi.
 */
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDb, type Projection } from '../../storage/db.js';
import { DEVICE_ID, IDS, seedSalesFixtures } from '../sales/fixtures.js';
import { importEntityId } from './ids.js';
import { ImportScreen } from './ImportScreen.js';

vi.mock('../sync/sync-engine-instance.js', () => ({ getSyncEngine: () => undefined }));
vi.mock('../auth/AuthContext.js', () => ({
  useAuth: () => ({
    state: { status: 'unlocked', userId: IDS.user, deviceStatus: 'ACTIVE' },
    deviceId: DEVICE_ID,
  }),
}));

const projection = (
  dataset: string,
  entityType: string,
  id: string,
  data: Record<string, unknown>,
): Projection => ({
  key: `${dataset}:${entityType}:${id}`,
  dataset,
  entity_type: entityType,
  entity_id: id,
  scope_type: 'GLOBAL',
  scope_id: null,
  data: { id, ...data },
  seq: 1,
  row_version: 1,
});

const asRoles = (roles: readonly string[]) =>
  getDb().navigation.put({
    user_id: IDS.user,
    roles,
    sections: [],
    saved_at: '2026-11-04T08:00:00.000Z',
  });

const csvFile = (text: string, name = 'chargement.csv') =>
  new File([text], name, { type: 'text/csv' });

const renderScreen = () =>
  render(
    <MemoryRouter>
      <ImportScreen />
    </MemoryRouter>,
  );

/** Le champ fichier n'existe qu'une fois les référentiels de l'appareil lus. */
const fileField = async () => screen.findByLabelText(/Fichier CSV/i);

describe('ImportScreen (RP-2, PP-C)', () => {
  beforeEach(async () => {
    const db = getDb();
    await db.projections.clear();
    await db.outbox.clear();
    await db.navigation.clear();
    await seedSalesFixtures(db);
    await db.projections.bulkPut([
      projection('catalog', 'UNIT', 'u1', {
        code: 'KG',
        name: 'Kilogramme',
        is_count: false,
        is_active: true,
      }),
    ]);
  });

  afterEach(async () => {
    cleanup();
    const db = getDb();
    await db.projections.clear();
    await db.outbox.clear();
    await db.navigation.clear();
  });

  it('propose les types ouverts au rôle, et nomme ceux qui relèvent d’autres rôles', async () => {
    await asRoles(['ADMIN']);
    renderScreen();
    const kinds = await screen.findByLabelText(/Type de données/i);
    const options = within(kinds)
      .getAllByRole('option')
      .map((option) => option.textContent);
    expect(options).toEqual(['Catégories de produit', 'Produits']);
    expect(
      screen.getByText(/Réservé à d’autres rôles : Fournisseurs, Clients\./),
    ).toBeInTheDocument();
  });

  it('un rôle sans aucun chargement ne voit que l’explication', async () => {
    await asRoles(['MAGASINIER']);
    renderScreen();
    expect(
      await screen.findByText('Aucun chargement de données n’est ouvert à votre rôle.'),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText(/Fichier CSV/i)).toBeNull();
  });

  it('contrôle le fichier, charge dans l’outbox, et ne recrée rien si le même fichier est rechargé', async () => {
    await asRoles(['ADMIN']);
    const user = userEvent.setup();
    renderScreen();
    await user.upload(
      await fileField(),
      csvFile('Code;Nom;Catégorie parente\nOEUFS;Œufs;\nCALIBRES;Calibres;OEUFS\n'),
    );

    expect(await screen.findByText('2 à charger')).toBeInTheDocument();
    expect(screen.getByText('Fichier contrôlé : chargement.csv')).toBeInTheDocument();
    // Rien n'est écrit tant que l'utilisateur ne charge pas.
    expect(await getDb().outbox.count()).toBe(0);

    await user.click(screen.getByRole('button', { name: 'Charger 2 ligne(s)' }));
    expect(await screen.findByText('Résultat du chargement')).toBeInTheDocument();
    const queued = await getDb().outbox.orderBy('device_seq').toArray();
    expect(queued.map((command) => command.command_type)).toEqual([
      'catalog.product_category.create',
      'catalog.product_category.create',
    ]);
    // Identifiants stables : ceux que le serveur reconnaîtra si le fichier est chargé deux fois.
    expect(queued.map((command) => command.aggregate_id)).toEqual([
      await importEntityId('category', 'OEUFS'),
      await importEntityId('category', 'CALIBRES'),
    ]);
    expect(queued[1]!.payload).toMatchObject({ parentId: queued[0]!.aggregate_id });
    expect(await screen.findByText('2 en attente d’envoi ou de réponse')).toBeInTheDocument();

    // Même fichier, de nouveau : tout est déjà là, rien à charger.
    await user.click(screen.getByRole('button', { name: 'Charger un autre fichier' }));
    await user.upload(
      await fileField(),
      csvFile('Code;Nom;Catégorie parente\nOEUFS;Œufs;\nCALIBRES;Calibres;OEUFS\n'),
    );
    expect(await screen.findByText('2 déjà présente(s)')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Charger 0 ligne(s)' })).toBeDisabled();
    expect(await getDb().outbox.count()).toBe(2);
  });

  it('signale les erreurs ligne par ligne, charge seulement les lignes prêtes', async () => {
    await asRoles(['ADMIN']);
    const user = userEvent.setup();
    renderScreen();
    await user.upload(
      await fileField(),
      csvFile(
        'Code;Nom;Colonne inutile\nOEUFS;Œufs;x\nmauvais code!;Volaille;x\nOEUFS;Doublon;x\n',
      ),
    );

    expect(await screen.findByText('1 à charger')).toBeInTheDocument();
    expect(screen.getByText('1 en erreur')).toBeInTheDocument();
    expect(screen.getByText('1 en double')).toBeInTheDocument();
    expect(
      screen.getByText(/Colonnes ignorées, non reconnues : Colonne inutile\./),
    ).toBeInTheDocument();
    expect(screen.getByText(/Code invalide/)).toBeInTheDocument();
    expect(screen.getByText(/Déjà présent à la ligne 2 du fichier\./)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Charger 1 ligne(s)' }));
    await waitFor(async () => expect(await getDb().outbox.count()).toBe(1));
  });

  it('une colonne obligatoire absente : rien n’est chargeable', async () => {
    await asRoles(['ADMIN']);
    const user = userEvent.setup();
    renderScreen();
    await user.upload(await fileField(), csvFile('Code\nOEUFS\n'));
    expect(await screen.findByText(/Colonnes obligatoires absentes : Nom\./)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Charger 0 ligne(s)' })).toBeDisabled();
  });

  it('un fichier enregistré par Excel en Windows-1252 garde ses accents', async () => {
    await asRoles(['ADMIN']);
    const user = userEvent.setup();
    renderScreen();
    // « Café » : l'octet 0xE9 seul n'est pas de l'UTF-8 valide.
    const ansi = new Uint8Array([
      ...new TextEncoder().encode('Code;Nom\nCAFE;Caf'),
      0xe9,
      ...new TextEncoder().encode('\n'),
    ]);
    await user.upload(await fileField(), new File([ansi], 'ansi.csv', { type: 'text/csv' }));
    expect(await screen.findByText('1 à charger')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Charger 1 ligne(s)' }));
    await waitFor(async () => {
      const [command] = await getDb().outbox.toArray();
      expect(command?.payload).toMatchObject({ code: 'CAFE', name: 'Café' });
    });
  });

  it('un fichier vide est refusé avec son motif', async () => {
    await asRoles(['ADMIN']);
    const user = userEvent.setup();
    renderScreen();
    await user.upload(await fileField(), csvFile('   \n\n'));
    expect(await screen.findByText('Ce fichier est vide.')).toBeInTheDocument();
    expect(await getDb().outbox.count()).toBe(0);
  });

  it('les lignes refusées par le serveur sont listées avec leur motif', async () => {
    await asRoles(['ADMIN']);
    const user = userEvent.setup();
    renderScreen();
    await user.upload(await fileField(), csvFile('Code;Nom\nOEUFS;Œufs\nVOLAILLE;Volaille\n'));
    await user.click(await screen.findByRole('button', { name: 'Charger 2 ligne(s)' }));
    await screen.findByText('Résultat du chargement');

    const [first, second] = await getDb().outbox.orderBy('device_seq').toArray();
    await getDb().outbox.update(first!.command_id, {
      status: 'SYNCED',
      synced_at: new Date().toISOString(),
    });
    await getDb().outbox.update(second!.command_id, {
      status: 'REJECTED',
      last_error: { code: 'CODE_EXISTS', message_fr: 'Une catégorie porte déjà ce code.' },
    });

    expect(await screen.findByText('1 enregistrée(s)')).toBeInTheDocument();
    expect(await screen.findByText('1 refusée(s)')).toBeInTheDocument();
    expect(screen.getByText('Une catégorie porte déjà ce code.')).toBeInTheDocument();
    expect(screen.getByText('VOLAILLE')).toBeInTheDocument();
  });

  it('les clients sans commercial titulaire se rattachent au site du point de vente de l’utilisateur', async () => {
    // L'administrateur qui détient en plus un rôle de saisie de clients (rôles de test) charge des clients.
    await asRoles(['ADMIN', 'VENDEUR_PDV']);
    const user = userEvent.setup();
    renderScreen();
    await user.selectOptions(await screen.findByLabelText(/Type de données/i), 'customers');
    await user.upload(
      await fileField(),
      csvFile('Nom;Téléphone;Zone\nBoutique du carrefour;677 12 34 56;Centre\n'),
    );
    expect(await screen.findByText('1 à charger')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Charger 1 ligne(s)' }));
    await waitFor(async () => {
      const [command] = await getDb().outbox.toArray();
      expect(command?.command_type).toBe('crm.customer.create');
      expect(command?.payload).toMatchObject({
        displayName: 'Boutique du carrefour',
        phonePrimary: '+237677123456',
        zoneId: IDS.zone,
        homeSiteId: IDS.site,
      });
    });
  });

  it('le fichier modèle se télécharge', async () => {
    await asRoles(['ADMIN']);
    const user = userEvent.setup();
    const create = vi.fn((_blob: Blob) => 'blob:modele');
    const revoke = vi.fn();
    const previous = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
    URL.createObjectURL = create;
    URL.revokeObjectURL = revoke;
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);
    try {
      renderScreen();
      await user.click(
        await screen.findByRole('button', { name: 'Télécharger le fichier modèle' }),
      );
      expect(create).toHaveBeenCalledTimes(1);
      expect(click).toHaveBeenCalledTimes(1);
      expect(revoke).toHaveBeenCalledWith('blob:modele');
      // L'en-tête et un exemple, dans l'ordre des colonnes du type choisi.
      const text = await create.mock.calls[0]![0].text();
      expect(text).toContain('Code;Nom;Catégorie parente');
      expect(text).toContain('VOLAILLE;Volaille;');
    } finally {
      URL.createObjectURL = previous.create;
      URL.revokeObjectURL = previous.revoke;
      click.mockRestore();
    }
  });
});
