import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { getDb } from '../../storage/db.js';
import { IDS, seedSalesFixtures } from '../sales/fixtures.js';
import { NewSaleScreen } from '../sales/NewSaleScreen.js';
import { NewProspectScreen } from './NewProspectScreen.js';
import {
  checkProspect,
  prospectPayload,
  prospectZoneOptions,
  type ProspectDraft,
} from './prospect.js';
import { loadSalesReferences } from '../sales/references.js';
import type { CustomerData, ZoneData } from '../sales/types.js';

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

  it('zones proposées : actives seulement, libellées par leur chemin', () => {
    const zone = (id: string, name: string, parent: string | null, active = true): ZoneData => ({
      id,
      name,
      parent_id: parent,
      depth: parent ? 2 : 1,
      is_active: active ? 1 : 0,
    });
    const zones = new Map(
      [
        zone('z1', 'Yaoundé', null),
        zone('z2', 'Mvog-Mbi', 'z1'),
        zone('z3', 'Ancien secteur', 'z1', false),
      ].map((value) => [value.id, value]),
    );
    expect(prospectZoneOptions(zones)).toEqual([
      { id: 'z1', label: 'Yaoundé' },
      { id: 'z2', label: 'Yaoundé › Mvog-Mbi' },
    ]);
  });

  it('zone préremplie devenue inactive : non envoyée, une zone active est à choisir', async () => {
    const db = getDb();
    const key = `zone:ZONE:${IDS.zone}`;
    const centre = await db.projections.get(key);
    if (!centre) throw new Error('zone de la fixture absente');
    await db.projections.bulkPut([
      { ...centre, data: { ...centre.data, is_active: 0 } },
      {
        ...centre,
        key: 'zone:ZONE:z-active',
        entity_id: 'z-active',
        data: { id: 'z-active', parent_id: null, name: 'Nord', depth: 1, is_active: 1 },
      },
    ]);
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <NewProspectScreen />
      </MemoryRouter>,
    );
    await user.type(
      await screen.findByLabelText('Nom du client ou de l’établissement'),
      'Épicerie Etoudi',
    );
    await user.type(screen.getByLabelText('Téléphone'), '677 00 11 22');
    expect(screen.getByLabelText('Zone')).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Enregistrer le prospect' })).toBeDisabled();
    await user.selectOptions(screen.getByLabelText('Zone'), 'z-active');
    expect(screen.getByRole('button', { name: 'Enregistrer le prospect' })).toBeEnabled();
  });

  it('tablette partagée : le prospect en attente d’un autre utilisateur n’est pas proposé', async () => {
    const db = getDb();
    await db.syncMeta.put({
      key: 'device',
      device_id: '01900000-0000-7000-8000-0000000000ff',
      clock_skew_ms: null,
      last_sync_at: null,
      data_user_id: IDS.user,
    });
    const base = {
      command_version: 1,
      aggregate_type: 'CUSTOMER',
      base_version: null,
      depends_on: [],
      occurred_at: '2026-10-10T08:00:00.000Z',
      client_created_at: '2026-10-10T08:00:00.000Z',
      captured_offline: true,
      backdated_reason: null,
      attachment_ids: [],
      status: 'LOCAL_ONLY' as const,
      attempts: 0,
      next_attempt_at: null,
      last_error: null,
      server_refs: null,
      command_type: 'crm.customer.create',
    };
    await db.outbox.bulkPut([
      {
        ...base,
        command_id: '01900000-0000-7000-8000-0000000000d1',
        device_seq: 1,
        author_user_id: '01900000-0000-7000-8000-0000000000ab',
        aggregate_id: '01900000-0000-7000-8000-0000000000c1',
        payload: { displayName: 'Prospect du collègue', zoneId: IDS.zone },
      },
      {
        ...base,
        command_id: '01900000-0000-7000-8000-0000000000d2',
        device_seq: 2,
        author_user_id: IDS.user,
        aggregate_id: '01900000-0000-7000-8000-0000000000c2',
        payload: { displayName: 'Mon prospect', zoneId: IDS.zone },
      },
    ]);
    const names = (await loadSalesReferences(db)).customers.map((c) => c.display_name);
    expect(names).toContain('Mon prospect');
    expect(names).not.toContain('Prospect du collègue');
    await db.syncMeta.delete('device');
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
    // « Vendre à ce client » ouvre la vente, client déjà choisi.
    expect(await screen.findByRole('link', { name: 'Vendre à ce client' })).toHaveAttribute(
      'href',
      `/ventes/nouvelle?client=${create?.aggregate_id}`,
    );
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
