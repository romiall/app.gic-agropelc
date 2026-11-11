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
import { DEVICE_ID, IDS, posCashAccountRow, seedSalesFixtures } from '../sales/fixtures.js';
import { CATEGORIES_ENTITY } from './entities.js';
import { authorImportId } from './ids.js';
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
    expect(options).toEqual([
      'Catégories de produit',
      'Produits',
      'Stock d’ouverture',
      'Lots en cours (reprise)',
      'Comptes de trésorerie',
      'Pièces papier (historique des carnets)',
      'Présence du personnel (fiche PT)',
    ]);
    expect(
      screen.getByText(
        /Réservé à d’autres rôles : Règles de prix \(brouillons\), Fournisseurs, Clients\./,
      ),
    ).toBeInTheDocument();
  });

  it('un rôle sans aucun chargement ne voit que l’explication', async () => {
    await asRoles(['VISITEUR']);
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
      await authorImportId(IDS.user, 'category', 'OEUFS'),
      await authorImportId(IDS.user, 'category', 'CALIBRES'),
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
      // L'adresse temporaire n'est révoquée qu'après le départ du téléchargement.
      expect(revoke).not.toHaveBeenCalled();
      await waitFor(() => expect(revoke).toHaveBeenCalledWith('blob:modele'), { timeout: 3_000 });
      // L'en-tête seul, dans l'ordre des colonnes du type choisi : une ligne d'exemple oubliée se chargerait.
      const text = await create.mock.calls[0]![0].text();
      expect(text).toContain('Code;Nom;Catégorie parente');
      expect(text).not.toContain('VOLAILLE');
      // Les exemples sont dans l'aide des colonnes.
      expect(screen.getByText('Exemple : VOLAILLE')).toBeInTheDocument();
    } finally {
      URL.createObjectURL = previous.create;
      URL.revokeObjectURL = previous.revoke;
      click.mockRestore();
    }
  });

  it('un guillemet jamais refermé : le fichier est dit incomplet, rien n’est chargeable', async () => {
    await asRoles(['ADMIN']);
    const user = userEvent.setup();
    renderScreen();
    await user.upload(await fileField(), csvFile('Code;Nom\nOEUFS;"Œufs\nVOLAILLE;Volaille\n'));
    expect(await screen.findByText(/Un guillemet s’ouvre à la ligne 2/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Charger 0 ligne(s)' })).toBeDisabled();
    expect(await getDb().outbox.count()).toBe(0);
  });

  it('un fichier « Texte Unicode » d’Excel (UTF-16, tabulations) est lu', async () => {
    await asRoles(['ADMIN']);
    const user = userEvent.setup();
    renderScreen();
    const text = 'Code\tNom\r\nOEUFS\tŒufs\r\n';
    const bytes: number[] = [0xff, 0xfe];
    for (const char of text) bytes.push(char.charCodeAt(0) & 0xff, char.charCodeAt(0) >> 8);
    await user.upload(
      await fileField(),
      new File([new Uint8Array(bytes)], 'unicode.txt', { type: 'text/plain' }),
    );
    expect(await screen.findByText('1 à charger')).toBeInTheDocument();
    expect(screen.queryByText(/Colonnes ignorées/)).not.toBeInTheDocument();
  });

  it('des colonnes vides en fin de ligne (tableur) ne sont pas signalées comme colonnes ignorées', async () => {
    await asRoles(['ADMIN']);
    const user = userEvent.setup();
    renderScreen();
    await user.upload(await fileField(), csvFile('Code;Nom;;;\nOEUFS;Œufs;;;\n'));
    expect(await screen.findByText('1 à charger')).toBeInTheDocument();
    expect(screen.queryByText(/Colonnes ignorées/)).not.toBeInTheDocument();
  });

  it('un contrôle qui échoue ne fige pas l’écran : message, puis un autre fichier se contrôle', async () => {
    await asRoles(['ADMIN']);
    const user = userEvent.setup();
    const broken = vi.spyOn(CATEGORIES_ENTITY, 'planRow').mockRejectedValue(new Error('panne'));
    renderScreen();
    await user.upload(await fileField(), csvFile('Code;Nom\nOEUFS;Œufs\n'));
    expect(await screen.findByText(/Le contrôle du fichier a échoué/)).toBeInTheDocument();
    // Ni « contrôle en cours » ni champ bloqué.
    expect(screen.queryByText('Contrôle du fichier…')).not.toBeInTheDocument();
    expect(await fileField()).toBeEnabled();

    broken.mockRestore();
    await user.upload(await fileField(), csvFile('Code;Nom\nOEUFS;Œufs\n'));
    expect(await screen.findByText('1 à charger')).toBeInTheDocument();
    expect(screen.queryByText(/Le contrôle du fichier a échoué/)).not.toBeInTheDocument();
  });

  it('à la fin de l’envoi, le focus passe au résultat (le bouton « Charger » a disparu)', async () => {
    await asRoles(['ADMIN']);
    const user = userEvent.setup();
    renderScreen();
    await user.upload(await fileField(), csvFile('Code;Nom\nOEUFS;Œufs\n'));
    await user.click(await screen.findByRole('button', { name: 'Charger 1 ligne(s)' }));
    const result = await screen.findByText('Résultat du chargement');
    await waitFor(() =>
      expect(document.activeElement).toBe(result.closest('.import-result') as HTMLElement),
    );
  });

  describe('pièces papier : motif d’antidatage commun', () => {
    const HEADER =
      'Type de pièce;Numéro de la pièce;Date de la pièce;Motif d’antidatage;Emplacement;Destination;Site;Client;Produit;Unité;Quantité;Prix unitaire;Moyen de paiement;Montant;Compte;Catégorie;Description';
    const two = (value: number) => String(value).padStart(2, '0');
    const old = new Date(Date.now() - 20 * 24 * 3_600_000);
    const written = `${two(old.getDate())}/${two(old.getMonth() + 1)}/${old.getFullYear()} 10:00`;
    const line = `BV;BV-000700;${written};;PDV-YDE-POS;;;;OEUF;;1;;ESPECES;;;;`;

    it('un motif saisi après le contrôle s’applique par « Appliquer le motif » ; « Charger » le recontrôle de même', async () => {
      await asRoles(['ADMIN', 'VENDEUR_PDV']);
      await getDb().projections.put(posCashAccountRow());
      const user = userEvent.setup();
      renderScreen();
      await user.selectOptions(await screen.findByLabelText(/Type de données/i), 'slips');
      await user.upload(await fileField(), csvFile(`${HEADER}\n${line}\n`));
      // Pièce de 20 jours sans motif : refusée.
      expect(await screen.findByText('0 à charger')).toBeInTheDocument();
      expect(screen.getByText('1 en erreur')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Appliquer le motif' })).not.toBeInTheDocument();

      await user.type(
        screen.getByLabelText(/Motif d’antidatage commun/),
        'Report du carnet de septembre',
      );
      // Le plan affiché ne tient pas encore compte du motif : dit, avec le bouton qui le règle.
      expect(screen.getByText(/Le motif commun a changé depuis le contrôle/)).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Appliquer le motif' }));
      expect(await screen.findByText('1 à charger')).toBeInTheDocument();
      expect(screen.queryByText(/Le motif commun a changé/)).not.toBeInTheDocument();

      // Changer le motif de nouveau, puis « Charger » : recontrôle d'abord, rien ne part sur un contrôle périmé.
      await user.type(screen.getByLabelText(/Motif d’antidatage commun/), ' (corrigé)');
      await user.click(screen.getByRole('button', { name: 'Charger 1 ligne(s)' }));
      const again = await screen.findByRole('button', { name: 'Charger 1 ligne(s)' });
      expect(screen.queryByText(/Le motif commun a changé/)).not.toBeInTheDocument();
      expect(await getDb().outbox.count()).toBe(0);
      await user.click(again);
      await waitFor(async () => {
        const [command] = await getDb().outbox.toArray();
        expect(command?.command_type).toBe('sales.sale.record');
        expect(command?.backdated_reason).toBe('Report du carnet de septembre (corrigé)');
      });
    });
  });
});
