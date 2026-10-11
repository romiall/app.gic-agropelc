import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { getDb } from '../../storage/db.js';
import { IDS, seedSalesFixtures } from '../sales/fixtures.js';
import { NewSaleScreen } from '../sales/NewSaleScreen.js';
import { NewProspectScreen } from './NewProspectScreen.js';
import { checkProspect, prospectPayload, type ProspectDraft } from './prospect.js';
import type { CustomerData } from '../sales/types.js';

vi.mock('../sync/sync-engine-instance.js', () => ({ getSyncEngine: () => undefined }));
vi.mock('../auth/AuthContext.js', () => ({
  useAuth: () => ({
    state: {
      status: 'unlocked',
      userId: '01900000-0000-7000-8000-000000000001',
      deviceStatus: 'ACTIVE',
    },
  }),
}));

const DRAFT: ProspectDraft = {
  displayName: 'Épicerie Etoudi',
  phone: '699 11 22 33',
  position: null,
  zoneId: IDS.zone,
  sourceCode: 'PROSPECTION_TERRAIN',
  customerType: 'PARTICULIER',
  contactName: '',
  businessActivity: '',
  addressText: '',
  categoryId: '',
};

describe('+ Prospect (ECR-CRM-02)', () => {
  beforeEach(async () => {
    const db = getDb();
    await db.projections.clear();
    await db.outbox.clear();
    await seedSalesFixtures(db);
  });

  afterEach(async () => {
    cleanup();
    vi.restoreAllMocks();
    await getDb().projections.clear();
    await getDb().outbox.clear();
  });

  it('téléphone normalisé, doublon repéré, ni téléphone ni GPS refusé ; pas de chaîne vide envoyée', () => {
    const existing = {
      id: 'c1',
      display_name: 'Boutique Mvog-Mbi',
      phone_primary: '+237 699 11 22 33',
      merged_into_id: null,
    } as CustomerData;
    const check = checkProspect(DRAFT, [existing], '237');
    expect(check.normalizedPhone).toBe('+237699112233');
    expect(check.duplicateOf?.id).toBe('c1');
    expect(checkProspect({ ...DRAFT, phone: '' }, [], '237').issues).toEqual([
      'PHONE_OR_POSITION_REQUIRED',
    ]);
    expect(checkProspect({ ...DRAFT, phone: 'abc' }, [], '237').issues).toEqual(['PHONE_INVALID']);
    expect(prospectPayload({ ...DRAFT, contactName: '  ' }, {})).toEqual({
      displayName: 'Épicerie Etoudi',
      customerType: 'PARTICULIER',
      zoneId: IDS.zone,
      sourceCode: 'PROSPECTION_TERRAIN',
      phonePrimary: '699 11 22 33',
    });
  });

  it('en ligne, téléphone d’un compte existant : création bloquée sur l’appareil', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <NewProspectScreen />
      </MemoryRouter>,
    );
    await user.type(await screen.findByLabelText('Nom du client ou de l’établissement'), 'Doublon');
    await user.type(screen.getByLabelText('Téléphone'), '699112233');
    expect(screen.getByText(/déjà celui de « Boutique Mvog-Mbi »/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Enregistrer le prospect' })).toBeDisabled();
  });

  it('hors ligne : prospect créé, aussitôt proposé à la vente, qui dépend de sa création', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    const user = userEvent.setup();
    const { unmount } = render(
      <MemoryRouter>
        <NewProspectScreen />
      </MemoryRouter>,
    );
    await user.type(
      await screen.findByLabelText('Nom du client ou de l’établissement'),
      'Épicerie Etoudi',
    );
    await user.type(screen.getByLabelText('Téléphone'), '677 00 11 22');
    await user.selectOptions(screen.getByLabelText('Zone'), IDS.zone);
    await user.click(screen.getByRole('button', { name: 'Enregistrer le prospect' }));
    expect(await screen.findByText(/Prospect enregistré sur ce téléphone/)).toBeInTheDocument();
    const [create] = await getDb().outbox.toArray();
    expect(create).toMatchObject({
      command_type: 'crm.customer.create',
      aggregate_type: 'CUSTOMER',
      captured_offline: true,
      payload: {
        displayName: 'Épicerie Etoudi',
        phonePrimary: '677 00 11 22',
        zoneId: IDS.zone,
        // Vendeur d'un point de vente : origine préremplie « visite spontanée ».
        sourceCode: 'VISITE_SPONTANEE',
      },
    });
    unmount();

    // La vente propose le nouveau client et attend sa création.
    await getDb().projections.update(`location:LOCATION:${IDS.pos}`, {
      data: {
        id: IDS.pos,
        site_id: IDS.site,
        code: 'PDV-YDE-POS',
        name: 'Comptoir Yaoundé',
        location_type: 'POS',
        is_virtual: false,
        custody_mode: 'EXCLUSIVE_USER',
        custodian_user_id: IDS.user,
        designated_device_id: null,
        status: 'ACTIVE',
      },
    });
    render(
      <MemoryRouter>
        <NewSaleScreen />
      </MemoryRouter>,
    );
    await user.click(await screen.findByRole('button', { name: 'Changer' }));
    await user.type(screen.getByPlaceholderText(/Rechercher un client/), 'Etoudi');
    await user.click(screen.getByRole('button', { name: /Épicerie Etoudi/ }));
    await user.click(screen.getByRole('button', { name: '+ Ajouter un article' }));
    await user.click(screen.getByRole('button', { name: /Œufs de table/ }));
    await user.click(screen.getByRole('button', { name: 'Enregistrer la vente' }));
    await screen.findByText(/Vente enregistrée sur ce téléphone/);
    const sale = (await getDb().outbox.toArray()).find(
      (command) => command.command_type === 'sales.sale.record',
    );
    expect(sale?.depends_on).toEqual([create?.command_id]);
    expect(sale?.payload).toMatchObject({ customerId: create?.aggregate_id });
  });
});
